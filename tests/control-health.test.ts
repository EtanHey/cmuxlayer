import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectControlHealth,
  formatControlHealth,
} from "../src/control-health.js";
import { createServer, createServerContext } from "../src/server.js";
import type { ControlHealth } from "../src/control-health.js";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";

const TEST_ROOT = join(tmpdir(), "cmuxlayer-control-health-test");

function createHealthNotificationEngine() {
  const stateDir = join(TEST_ROOT, `engine-${Date.now()}-${Math.random()}`);
  mkdirSync(stateDir, { recursive: true });
  const stateMgr = new StateManager(stateDir);
  const registry = new AgentRegistry(stateMgr, async () => []);
  const engine = new AgentEngine(stateMgr, registry, {} as any, {
    spawnPreflight: async () => {},
    sessionIdentityResolver: () => null,
  });
  return { engine, stateDir };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("control health", () => {
  it("only notifies on blocking health and records code severity in signatures", () => {
    const { engine, stateDir } = createHealthNotificationEngine();
    try {
      const healthSignature = (engine as any).healthSignature.bind(engine);
      const shouldNotifyHealthChange = (
        engine as any
      ).shouldNotifyHealthChange.bind(engine);
      const degradedHealth = {
        status: "degraded",
        issue_codes: ["missing_cli_session_id"],
        issues: ["managed long-running agent has no cli_session_id"],
        issue_severities: { missing_cli_session_id: "degraded" },
      };
      const blockingHealth = {
        status: "unhealthy",
        issue_codes: ["agent_wedged"],
        issues: ["agent monitor is alive but dispatches remain unacked"],
        issue_severities: { agent_wedged: "blocking" },
      };

      expect(healthSignature(degradedHealth)).toBe(
        "degraded(missing_cli_session_id:degraded)",
      );
      expect(
        shouldNotifyHealthChange(
          { healthSignature: "unhealthy(agent_wedged:blocking)" },
          degradedHealth,
        ),
      ).toBe(false);
      expect(
        shouldNotifyHealthChange(
          { healthSignature: "degraded(missing_cli_session_id:degraded)" },
          blockingHealth,
        ),
      ).toBe(true);
    } finally {
      engine.dispose();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports prod/nightly sockets and warns on Nightly env with prod-resolving cmux", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    const home = join(TEST_ROOT, "home");
    const tmp = join(TEST_ROOT, "tmp");
    const bin = join(TEST_ROOT, "bin");
    const stateDir = join(home, ".local", "state", "cmux");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    mkdirSync(bin, { recursive: true });

    const prodSocket = join(stateDir, "cmux-501.sock");
    const nightlySocket = join(tmp, "cmux-nightly.sock");
    writeFileSync(join(stateDir, "last-socket-path"), `${prodSocket}\n`);
    writeFileSync(join(stateDir, "nightly-last-socket-path"), `${nightlySocket}\n`);
    writeFileSync(join(tmp, "cmux-last-socket-path"), `${prodSocket}\n`);
    writeFileSync(join(tmp, "cmux-nightly-last-socket-path"), `${nightlySocket}\n`);
    writeFileSync(prodSocket, "");
    writeFileSync(nightlySocket, "");

    const cmuxShim = join(bin, "cmux");
    writeFileSync(
      cmuxShim,
      [
        "#!/usr/bin/env bash",
        'CLI_FILE="/tmp/cmux-last-cli-path"',
        'exec "/Applications/cmux.app/Contents/Resources/bin/cmux" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(cmuxShim, 0o755);

    const health = await collectControlHealth({
      homeDir: home,
      tmpDir: tmp,
      pid: 123,
      ppid: 1,
      cwd: TEST_ROOT,
      env: {
        PATH: bin,
        CMUX_SOCKET_PATH: nightlySocket,
        CMUX_BUNDLED_CLI_PATH:
          "/Applications/cmux NIGHTLY.app/Contents/Resources/bin/cmux",
        CMUX_BUNDLE_ID: "com.cmuxterm.app.nightly",
        CMUX_SOCKET_PASSWORD: "secret",
      },
      client: {
        constructor: { name: "CmuxSocketClient" },
        currentSocketPath: () => nightlySocket,
      },
      execFile: async (file, args) => {
        if (
          file === "ps" &&
          args.join(" ") === "ax -o pid= -o command="
        ) {
          expect(args).toEqual([
            "ax",
            "-o",
            "pid=",
            "-o",
            "command=",
          ]);
          return {
            stdout: [
              "100 /Applications/Other.app/Contents/MacOS/cmux-helper",
              "59547 /Applications/cmux.app/Contents/MacOS/cmux",
              "83734 /Applications/cmux NIGHTLY.app/Contents/MacOS/cmux",
            ].join("\n"),
          };
        }
        if (file === "ps") {
          return { stdout: "123 1 123 123 S+ ttys001 node server.js" };
        }
        throw new Error(`unexpected execFile: ${file}`);
      },
      now: () => new Date("2026-06-13T12:00:00.000Z"),
    });

    expect(health.cmux_instances.production.socket_path).toBe(prodSocket);
    expect(health.cmux_instances.nightly.socket_path).toBe(nightlySocket);
    expect(health.cmux_instances.production.processes).toHaveLength(1);
    expect(health.cmux_instances.nightly.processes).toHaveLength(1);
    expect(health.current_process.cmux_resolution[0]).toMatchObject({
      path: cmuxShim,
      mentions_prod_app: true,
      mentions_last_cli_path: true,
    });
    expect(health.current_process.env.CMUX_SOCKET_PASSWORD).toBe("<set>");
    expect(health.warnings).toContain(
      "CMUX_SOCKET_PATH points at Nightly, but the first cmux executable resolves through a prod app shim/binary.",
    );
    expect(health.warnings).toContain(
      "CMUX_BUNDLED_CLI_PATH is Nightly, but PATH resolves cmux somewhere else first.",
    );
    expect(formatControlHealth(health)).toContain("cmuxlayer control_health");

    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("control_health tool appends prod and Nightly snapshot data to events.jsonl", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
    const prodSocket = "/Users/etanheyman/.local/state/cmux/cmux-501.sock";
    const nightlySocket = "/tmp/cmux-nightly.sock";
    const health = {
      generated_at: "2026-06-13T13:00:00.000Z",
      current_process: {
        pid: 123,
        ppid: 1,
        cwd: TEST_ROOT,
        stdin_is_tty: false,
        env: { CMUX_SOCKET_PATH: nightlySocket, PATH: "/bin" },
        path_entries: ["/bin"],
        cmux_resolution: [{ path: "/Applications/cmux NIGHTLY.app/bin/cmux", exists: true }],
      },
      selected_transport: {
        client_class: "CmuxSocketClient",
        current_socket_path: nightlySocket,
      },
      cmux_instances: {
        production: {
          axis: "production",
          app_bundle_path: "/Applications/cmux.app",
          app_binary_path: "/Applications/cmux.app/Contents/MacOS/cmux",
          marker_files: [],
          socket_path: prodSocket,
          socket_status: null,
          processes: [],
        },
        nightly: {
          axis: "nightly",
          app_bundle_path: "/Applications/cmux NIGHTLY.app",
          app_binary_path: "/Applications/cmux NIGHTLY.app/Contents/MacOS/cmux",
          marker_files: [],
          socket_path: nightlySocket,
          socket_status: null,
          processes: [],
        },
      },
      warnings: ["sample warning"],
    } satisfies ControlHealth;
    const server = createServer({
      stateDir: TEST_ROOT,
      skipAgentLifecycle: true,
      controlHealthCollector: async () => health,
    });
    const tool = (server as any)._registeredTools["control_health"];

    const result = await tool.handler({}, {} as any);

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.health.selected_transport.current_socket_path).toBe(
      nightlySocket,
    );
    const lines = readFileSync(join(TEST_ROOT, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event_type: "control_health",
      selected_socket_path: nightlySocket,
      production_socket_path: prodSocket,
      nightly_socket_path: nightlySocket,
      cmux_binary: "/Applications/cmux NIGHTLY.app/bin/cmux",
      warnings: ["sample warning"],
    });
    expect(lines[0].snapshot.cmux_instances.production.socket_path).toBe(
      prodSocket,
    );
    expect(lines[0].snapshot.cmux_instances.nightly.socket_path).toBe(
      nightlySocket,
    );
  });

  it("control_health surfaces daemon fallback warnings", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
    const health = {
      generated_at: "2026-07-08T10:00:00.000Z",
      current_process: {
        pid: 123,
        ppid: 1,
        cwd: TEST_ROOT,
        stdin_is_tty: false,
        env: { PATH: "/bin" },
        path_entries: ["/bin"],
        cmux_resolution: [],
      },
      selected_transport: {
        client_class: "CmuxClient",
      },
      cmux_instances: {
        production: {
          axis: "production",
          app_bundle_path: "/Applications/cmux.app",
          app_binary_path: "/Applications/cmux.app/Contents/MacOS/cmux",
          marker_files: [],
          socket_path: "/tmp/prod.sock",
          socket_status: null,
          processes: [],
        },
        nightly: {
          axis: "nightly",
          app_bundle_path: "/Applications/cmux NIGHTLY.app",
          app_binary_path: "/Applications/cmux NIGHTLY.app/Contents/MacOS/cmux",
          marker_files: [],
          socket_path: "/tmp/nightly.sock",
          socket_status: null,
          processes: [],
        },
      },
      warnings: [],
    } satisfies ControlHealth;
    const server = createServer({
      stateDir: TEST_ROOT,
      skipAgentLifecycle: true,
      controlHealthCollector: async () => health,
      controlHealthWarnings: [
        "cmuxlayer daemon unavailable; using heavy in-process runtime",
      ],
    });
    const tool = (server as any)._registeredTools["control_health"];

    try {
      const result = await tool.handler({}, {} as any);
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);

      expect(parsed.health.warnings).toContain(
        "cmuxlayer daemon unavailable; using heavy in-process runtime",
      );
      expect(result.content[0].text).toContain("daemon unavailable");
    } finally {
      await server.close();
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it("periodically appends control health snapshots without tool invocation", async () => {
    vi.useFakeTimers();
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
    const prodSocket = "/Users/etanheyman/.local/state/cmux/cmux-501.sock";
    const nightlySocket = "/tmp/cmux-nightly.sock";
    let count = 0;
    const makeHealth = (): ControlHealth => {
      count += 1;
      return {
        generated_at: `2026-06-13T13:00:0${count}.000Z`,
        current_process: {
          pid: 123,
          ppid: 1,
          cwd: TEST_ROOT,
          stdin_is_tty: false,
          env: { PATH: "/bin" },
          path_entries: ["/bin"],
          cmux_resolution: [{ path: "/usr/local/bin/cmux", exists: true }],
        },
        selected_transport: {
          client_class: "CmuxSocketClient",
          current_socket_path: count % 2 === 0 ? prodSocket : nightlySocket,
        },
        cmux_instances: {
          production: {
            axis: "production",
            app_bundle_path: "/Applications/cmux.app",
            app_binary_path: "/Applications/cmux.app/Contents/MacOS/cmux",
            marker_files: [],
            socket_path: prodSocket,
            socket_status: null,
            processes: [],
          },
          nightly: {
            axis: "nightly",
            app_bundle_path: "/Applications/cmux NIGHTLY.app",
            app_binary_path:
              "/Applications/cmux NIGHTLY.app/Contents/MacOS/cmux",
            marker_files: [],
            socket_path: nightlySocket,
            socket_status: null,
            processes: [],
          },
        },
        warnings: [],
      };
    };
    const context = createServerContext({
      stateDir: TEST_ROOT,
      skipAgentLifecycle: true,
      controlHealthCollector: async () => makeHealth(),
      controlHealthIntervalMs: 5_000,
    });

    createServer({ context });
    await vi.advanceTimersByTimeAsync(10_000);

    context.dispose();
    const lines = readFileSync(join(TEST_ROOT, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.event_type)).toEqual([
      "control_health",
      "control_health",
    ]);
    expect(lines.map((line) => line.selected_socket_path)).toEqual([
      nightlySocket,
      prodSocket,
    ]);
  });
});
