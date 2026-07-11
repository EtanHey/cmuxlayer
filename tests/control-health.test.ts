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
import { SurfaceWriteLivenessTracker } from "../src/surface-write-liveness.js";

const TEST_ROOT = join(tmpdir(), "cmuxlayer-control-health-test");
const ACCESS_CONTROL_DENIED_TEXT =
  "Access denied — only processes started inside cmux can connect";

async function advanceTimers(ms: number): Promise<void> {
  const advanceAsync = (
    vi as unknown as {
      advanceTimersByTimeAsync?: (value: number) => Promise<void>;
    }
  ).advanceTimersByTimeAsync;
  if (advanceAsync) {
    await advanceAsync.call(vi, ms);
  } else {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  }
}

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

  it("reports pane_pty_dead surfaces and monitor recovery state", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    const home = join(TEST_ROOT, "home-observability");
    const tmp = join(TEST_ROOT, "tmp-observability");
    const monitorRegistryPath = join(TEST_ROOT, "monitor-registry.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    let nowMs = Date.parse("2026-07-11T12:00:00.000Z");
    const tracker = new SurfaceWriteLivenessTracker({ now: () => nowMs });
    tracker.recordFailure("surface:pty-dead", { code: "EPIPE" });
    nowMs += 1_000;
    tracker.recordFailure("surface:pty-dead", { code: "EPIPE" });
    tracker.recordSuccess("surface:healthy");
    writeFileSync(
      monitorRegistryPath,
      JSON.stringify({
        version: 1,
        monitors: [
          {
            monitor_id: "monitor-alive",
            owner_seat: "seat-a",
            watch_targets: ["/tmp/alive"],
            mechanism: "event",
            deadman_timeout_s: 60,
            armed_at: "2026-07-11T11:55:00.000Z",
            last_signal_at: "2026-07-11T11:59:00.000Z",
            state: "alive",
          },
          {
            monitor_id: "monitor-rearming",
            owner_seat: "seat-b",
            watch_targets: ["/tmp/rearming"],
            mechanism: "event",
            deadman_timeout_s: 60,
            armed_at: "2026-07-11T11:55:00.000Z",
            last_signal_at: "2026-07-11T11:58:00.000Z",
            state: "rearming",
            rearm_command: "resume monitor-rearming",
            rearm_claimed_at: "2026-07-11T11:59:30.000Z",
          },
          {
            monitor_id: "monitor-collapsed",
            owner_seat: "seat-c",
            watch_targets: ["/tmp/collapsed"],
            mechanism: "event",
            deadman_timeout_s: 60,
            armed_at: "2026-07-11T11:55:00.000Z",
            last_signal_at: "2026-07-11T11:57:00.000Z",
            state: "collapsed",
            collapsed_reason: "watch-target-missing",
          },
        ],
      }),
    );

    const health = await collectControlHealth({
      homeDir: home,
      tmpDir: tmp,
      env: { PATH: "" },
      execFile: async () => ({ stdout: "" }),
      now: () => new Date(nowMs),
      surfaceWriteLiveness: tracker,
      surfaceIds: ["surface:pty-dead", "surface:healthy"],
      panePtyDeadSince: new Map([
        ["surface:pty-dead", Date.parse("2026-07-11T12:00:01.000Z")],
      ]),
      monitorRegistryPath,
    });

    expect(health.self_heal.pane_pty_dead).toEqual({
      count: 1,
      surfaces: [
        {
          surface_id: "surface:pty-dead",
          since_at: "2026-07-11T12:00:01.000Z",
          last_attempt_at: "2026-07-11T12:00:01.000Z",
        },
      ],
      truncated: false,
    });
    expect(health.self_heal.monitor_registry).toEqual({
      available: true,
      total: 3,
      rearming: 1,
      collapsed: 1,
      collapsed_monitors: [
        {
          monitor_id: "monitor-collapsed",
          reason: "watch-target-missing",
        },
      ],
      truncated: false,
    });
    expect(formatControlHealth(health)).toMatch(
      /pane_pty_dead: 1.*surface:pty-dead.*2026-07-11T12:00:01.000Z/s,
    );
    expect(formatControlHealth(health)).toMatch(
      /monitor registry: total=3 rearming=1 collapsed=1.*monitor-collapsed: watch-target-missing/s,
    );
  });

  it("counts pane_pty_dead surfaces beyond the bounded detail limit", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    const home = join(TEST_ROOT, "home-bounded");
    const tmp = join(TEST_ROOT, "tmp-bounded");
    const monitorRegistryPath = join(TEST_ROOT, "monitor-registry-bounded.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(monitorRegistryPath, JSON.stringify({ version: 1, monitors: [] }));
    const tracker = new SurfaceWriteLivenessTracker({
      now: () => Date.parse("2026-07-11T12:00:00.000Z"),
    });
    tracker.recordFailure("surface:100", { code: "EPIPE" });
    tracker.recordFailure("surface:100", { code: "EPIPE" });

    const health = await collectControlHealth({
      homeDir: home,
      tmpDir: tmp,
      env: { PATH: "" },
      execFile: async () => ({ stdout: "" }),
      surfaceWriteLiveness: tracker,
      surfaceIds: Array.from({ length: 101 }, (_, index) => `surface:${index}`),
      monitorRegistryPath,
    });

    expect(health.self_heal.pane_pty_dead.count).toBe(1);
    expect(health.self_heal.pane_pty_dead.surfaces).toEqual([
      expect.objectContaining({ surface_id: "surface:100" }),
    ]);
    expect(formatControlHealth(health)).toContain(
      "surface:100 since 2026-07-11T12:00:00.000Z",
    );
    expect(formatControlHealth(health)).not.toContain("since undefined");
  });

  it("reports a malformed monitor registry as unavailable", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    const home = join(TEST_ROOT, "home-malformed-registry");
    const tmp = join(TEST_ROOT, "tmp-malformed-registry");
    const monitorRegistryPath = join(TEST_ROOT, "monitor-registry-malformed.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(monitorRegistryPath, "{not-json");

    const health = await collectControlHealth({
      homeDir: home,
      tmpDir: tmp,
      env: { PATH: "" },
      execFile: async () => ({ stdout: "" }),
      monitorRegistryPath,
    });

    expect(health.self_heal.monitor_registry).toMatchObject({
      available: false,
      total: 0,
      rearming: 0,
      collapsed: 0,
      error: expect.stringMatching(/malformed|json/i),
    });
    expect(formatControlHealth(health)).toMatch(/monitor registry: unavailable/i);
  });

  it("reports structurally invalid monitor records as unavailable", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    const home = join(TEST_ROOT, "home-invalid-monitor-record");
    const tmp = join(TEST_ROOT, "tmp-invalid-monitor-record");
    const monitorRegistryPath = join(TEST_ROOT, "monitor-registry-invalid-record.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      monitorRegistryPath,
      JSON.stringify({ version: 1, monitors: [{}] }),
    );

    const health = await collectControlHealth({
      homeDir: home,
      tmpDir: tmp,
      env: { PATH: "" },
      execFile: async () => ({ stdout: "" }),
      monitorRegistryPath,
    });

    expect(health.self_heal.monitor_registry).toMatchObject({
      available: false,
      total: 0,
      error: expect.stringMatching(/invalid/i),
    });
  });

  it("retains untracked PTY failures and the first detected-at time in control_health", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    const home = join(TEST_ROOT, "home-untracked-surface");
    const tmp = join(TEST_ROOT, "tmp-untracked-surface");
    const monitorRegistryPath = join(TEST_ROOT, "monitor-registry-untracked.json");
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(monitorRegistryPath, JSON.stringify({ version: 1, monitors: [] }));
    const rawHealth = await collectControlHealth({
      homeDir: home,
      tmpDir: tmp,
      env: { PATH: "" },
      execFile: async () => ({ stdout: "" }),
      monitorRegistryPath,
    });
    let nowMs = Date.parse("2026-07-11T12:00:00.000Z");
    const tracker = new SurfaceWriteLivenessTracker({ now: () => nowMs });
    const client = {
      sendKey: vi.fn(async () => {
        throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      }),
    };
    const server = createServer({
      client: client as any,
      stateDir: join(TEST_ROOT, "untracked-state"),
      skipAgentLifecycle: true,
      surfaceWriteLiveness: tracker,
      controlHealthCollector: async () => rawHealth,
      monitorRegistryPath,
    });
    const sendKey = (server as any)._registeredTools["send_key"];
    const controlHealth = (server as any)._registeredTools["control_health"];

    try {
      await sendKey.handler({ surface: "surface:untracked", key: "return" }, {} as any);
      nowMs += 1_000;
      await sendKey.handler({ surface: "surface:untracked", key: "return" }, {} as any);
      const first = await controlHealth.handler({}, {} as any);
      nowMs += 1_000;
      await sendKey.handler({ surface: "surface:untracked", key: "return" }, {} as any);
      const second = await controlHealth.handler({}, {} as any);
      const firstHealth = first.structuredContent.health.self_heal.pane_pty_dead;
      const secondHealth = second.structuredContent.health.self_heal.pane_pty_dead;

      expect(firstHealth).toMatchObject({
        count: 1,
        surfaces: [
          expect.objectContaining({
            surface_id: "surface:untracked",
            since_at: "2026-07-11T12:00:01.000Z",
          }),
        ],
      });
      expect(secondHealth.surfaces[0].since_at).toBe(
        firstHealth.surfaces[0].since_at,
      );

      nowMs += 31_000;
      await sendKey.handler({ surface: "surface:untracked", key: "return" }, {} as any);
      nowMs += 1_000;
      await sendKey.handler({ surface: "surface:untracked", key: "return" }, {} as any);
      const nextEpisode = await controlHealth.handler({}, {} as any);
      expect(
        nextEpisode.structuredContent.health.self_heal.pane_pty_dead.surfaces[0]
          .since_at,
      ).toBe("2026-07-11T12:00:34.000Z");
    } finally {
      await server.close();
    }
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

  it("surfaces cmux access-control transport denial in selected transport and warnings", async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    const home = join(TEST_ROOT, "home-denied");
    const tmp = join(TEST_ROOT, "tmp-denied");
    mkdirSync(home, { recursive: true });
    mkdirSync(tmp, { recursive: true });
    const socketPath = join(tmp, "cmux-denied.sock");
    const health = await collectControlHealth({
      homeDir: home,
      tmpDir: tmp,
      env: { PATH: "/bin", CMUX_SOCKET_PATH: socketPath },
      client: {
        constructor: { name: "CmuxSelfHealingClient" },
        getTransportHealth: () => ({
          mode: "cli",
          degraded: true,
          current_socket_path: socketPath,
          denied_reason: "access-control",
          last_error: ACCESS_CONTROL_DENIED_TEXT,
        }),
      },
      execFile: async () => ({ stdout: "" }),
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(health.selected_transport).toMatchObject({
      transport_mode: "cli",
      transport_degraded: true,
      current_socket_path: socketPath,
      transport_denied: "access-control",
      transport_error: ACCESS_CONTROL_DENIED_TEXT,
    });
    expect(health.warnings).toContain(
      `cmuxlayer control transport denied: access-control; ${ACCESS_CONTROL_DENIED_TEXT}`,
    );
    expect(formatControlHealth(health)).toContain(ACCESS_CONTROL_DENIED_TEXT);
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
    await advanceTimers(10_000);

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
