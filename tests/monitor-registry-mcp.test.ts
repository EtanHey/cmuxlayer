import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import {
  reconcileMonitorRegistry,
  registerMonitor,
} from "../src/monitor-registry.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-monitor-registry-mcp-test");

function registryPath(): string {
  return join(TEST_DIR, "monitor-registry.json");
}

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function callTool(
  server: any,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return parseResult(await tool.handler(args, {} as any));
}

function makeNoopExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Main",
              index: 0,
              selected: true,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-panes")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [],
        }),
        stderr: "",
      };
    }
    return { stdout: "{}", stderr: "" };
  });
}

describe("monitor registry MCP tools", () => {
  let now = 1_000;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    now = 1_000;
    notify = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function createMonitorServer() {
    return createServer({
      exec: makeNoopExec(),
      skipAgentLifecycle: true,
      monitorRegistryPath: registryPath(),
      monitorRegistryNow: () => now,
      monitorRegistryNotify: notify,
    });
  }

  it("registers the monitor registry tool surface", () => {
    const tools = Object.keys((createMonitorServer() as any)._registeredTools);

    expect(tools).toContain("register_monitor");
    expect(tools).toContain("signal_monitor");
    expect(tools).toContain("deregister_monitor");
    expect(tools).toContain("list_monitors");
    expect(tools).toContain("query_monitor_registry");
  });

  it("round-trips register_monitor through list_monitors and query_monitor_registry", async () => {
    const server = createMonitorServer();

    const registered = await callTool(server, "register_monitor", {
      monitor_id: "seat-a-collab-watch",
      owner_seat: "seat-a",
      watch_targets: [
        resolve(process.cwd(), "orchestrator/collab/example.md"),
      ],
      mechanism: "event",
      pattern: "@seat-a|BLOCKED",
      deadman_timeout_s: 60,
      rearm_command: `tail -n0 -F ${resolve(process.cwd(), "orchestrator/collab/example.md")}`,
    });
    const listed = await callTool(server, "list_monitors", {});
    const queried = await callTool(server, "query_monitor_registry", {
      gate: "gate-9",
      owner_seat: "seat-a",
      monitor_id: "seat-a-collab-watch",
    });

    expect(registered).toMatchObject({
      ok: true,
      record: {
        monitor_id: "seat-a-collab-watch",
        owner_seat: "seat-a",
        watch_targets: [
          resolve(process.cwd(), "orchestrator/collab/example.md"),
        ],
        mechanism: "event",
        addressee: "seat-a",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${resolve(process.cwd(), "orchestrator/collab/example.md")}`,
        state: "alive",
      },
    });
    expect(listed).toMatchObject({
      ok: true,
      monitors: [
        expect.objectContaining({
          monitor_id: "seat-a-collab-watch",
          rearm_command: `tail -n0 -F ${resolve(process.cwd(), "orchestrator/collab/example.md")}`,
        }),
      ],
    });
    expect(queried).toMatchObject({
      ok: true,
      gate: "gate-9",
      monitors: [
        expect.objectContaining({
          monitor_id: "seat-a-collab-watch",
          liveness: "alive",
        }),
      ],
      violations: [],
    });
  });

  it("surfaces owner-pty-dead recovery metadata through list and gate queries", async () => {
    const watchedFile = join(TEST_DIR, "collapsed.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    const server = createMonitorServer();
    await callTool(server, "register_monitor", {
      monitor_id: "seat-a-collapsed",
      owner_seat: "seat-a",
      watch_targets: [watchedFile],
      mechanism: "event",
      deadman_timeout_s: 60,
      rearm_command: `tail -n0 -F ${watchedFile}`,
    });
    now = 62_000;
    await reconcileMonitorRegistry({
      registryPath: registryPath(),
      now: () => now,
      ownerPtyDead: async () => true,
      ownerAlive: async () => true,
      rearm: vi.fn(),
    });

    const listed = await callTool(server, "list_monitors", {
      monitor_id: "seat-a-collapsed",
    });
    const queried = await callTool(server, "query_monitor_registry", {
      gate: "gate-9",
      monitor_id: "seat-a-collapsed",
    });

    expect(listed.monitors[0]).toMatchObject({
      monitor_id: "seat-a-collapsed",
      state: "collapsed",
      collapsed_reason: "owner-pty-dead",
    });
    expect(queried.monitors[0]).toMatchObject({
      monitor_id: "seat-a-collapsed",
      state: "collapsed",
      liveness: "collapsed",
      collapsed_reason: "owner-pty-dead",
    });
  });

  it("signal_monitor updates last_signal_at without moving an alive monitor out of alive", async () => {
    const server = createMonitorServer();
    await callTool(server, "register_monitor", {
      monitor_id: "seat-a-flowing",
      owner_seat: "seat-a",
      watch_targets: ["orchestrator/collab/example.md"],
      mechanism: "event",
      deadman_timeout_s: 60,
    });

    now = 31_000;
    const signaled = await callTool(server, "signal_monitor", {
      monitor_id: "seat-a-flowing",
    });
    const queried = await callTool(server, "query_monitor_registry", {
      gate: "gate-9",
      monitor_id: "seat-a-flowing",
    });

    expect(signaled).toMatchObject({
      ok: true,
      record: {
        monitor_id: "seat-a-flowing",
        last_signal_at: new Date(31_000).toISOString(),
        state: "alive",
      },
    });
    expect(queried.violations).toEqual([]);
    expect(queried.monitors[0]).toMatchObject({
      monitor_id: "seat-a-flowing",
      liveness: "alive",
    });
  });

  it("deregister_monitor marks an intentional stop dead and removes it from live listings by default", async () => {
    const server = createMonitorServer();
    await callTool(server, "register_monitor", {
      monitor_id: "seat-a-stop",
      owner_seat: "seat-a",
      watch_targets: ["orchestrator/collab/example.md"],
      mechanism: "event",
      deadman_timeout_s: 60,
    });

    const stopped = await callTool(server, "deregister_monitor", {
      monitor_id: "seat-a-stop",
    });
    const listed = await callTool(server, "list_monitors", {});
    const all = await callTool(server, "list_monitors", {
      include_dead: true,
    });

    expect(stopped).toMatchObject({
      ok: true,
      record: {
        monitor_id: "seat-a-stop",
        state: "dead",
      },
    });
    expect(listed.monitors).toEqual([]);
    expect(all.monitors).toEqual([
      expect.objectContaining({
        monitor_id: "seat-a-stop",
        state: "dead",
      }),
    ]);
  });

  it("reports gate-9 monitor-id-absent for a claimed monitor missing from the registry", async () => {
    const server = createMonitorServer();

    const queried = await callTool(server, "query_monitor_registry", {
      gate: "gate-9",
      monitor_id: "absent-monitor",
    });

    expect(queried).toMatchObject({
      ok: true,
      gate: "gate-9",
      violations: [
        {
          gate: "gate-9",
          monitor_id: "absent-monitor",
          reason: "monitor-id-absent",
        },
      ],
    });
  });

  it("rejects gate-10 invalid registrations up front with contract reasons", async () => {
    const server = createMonitorServer();

    const noWatermark = await callTool(server, "register_monitor", {
      monitor_id: "offset-no-watermark",
      owner_seat: "seat-a",
      watch_targets: ["orchestrator/collab/example.md"],
      mechanism: "offset-poll",
      deadman_timeout_s: 60,
    });
    const noDeadman = await callTool(server, "register_monitor", {
      monitor_id: "tail-no-deadman",
      owner_seat: "seat-a",
      watch_targets: ["tail -n0 -F orchestrator/collab/example.md"],
      mechanism: "event",
    });
    const relativeRearmTarget = await callTool(server, "register_monitor", {
      monitor_id: "relative-rearm-target",
      owner_seat: "seat-a",
      watch_targets: ["orchestrator/collab/example.md"],
      mechanism: "event",
      deadman_timeout_s: 60,
      rearm_command: "watch-collab",
    });

    expect(noWatermark).toMatchObject({
      ok: false,
      monitor_id: "offset-no-watermark",
      reason: "offset-poll-missing-watermark-key",
    });
    expect(noDeadman).toMatchObject({
      ok: false,
      monitor_id: "tail-no-deadman",
      reason: "invalid-deadman-timeout",
    });
    expect(relativeRearmTarget).toMatchObject({
      ok: false,
      monitor_id: "relative-rearm-target",
      reason: "rearm-watch-target-not-absolute",
    });
  });

  it("rejects re-arming a fired monitor_id through register_monitor", async () => {
    const server = createMonitorServer();
    await callTool(server, "register_monitor", {
      monitor_id: "seat-a-fired",
      owner_seat: "seat-a",
      watch_targets: ["orchestrator/collab/example.md"],
      mechanism: "event",
      deadman_timeout_s: 60,
    });
    now = 62_000;
    await registerMonitor(
      {
        monitor_id: "other-live",
        owner_seat: "seat-b",
        watch_targets: ["orchestrator/collab/other.md"],
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      { registryPath: registryPath(), now: () => now },
    );
    await (await import("../src/monitor-registry.js")).sweepMonitorRegistry({
      registryPath: registryPath(),
      now: () => now,
      notify,
    });

    const rearm = await callTool(server, "register_monitor", {
      monitor_id: "seat-a-fired",
      owner_seat: "seat-a",
      watch_targets: ["orchestrator/collab/example.md"],
      mechanism: "event",
      deadman_timeout_s: 60,
    });

    expect(rearm).toMatchObject({
      ok: false,
      monitor_id: "seat-a-fired",
      reason: "cannot-rearm-fired-monitor-id",
    });
  });

  it("agent-engine sweep invokes the wired monitor deadman notify callback end to end", async () => {
    const server = createServer({
      exec: makeNoopExec(),
      stateDir: join(TEST_DIR, "state"),
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      monitorRegistryPath: registryPath(),
      monitorRegistryNow: () => now,
      monitorRegistryNotify: notify,
    });
    const engine = (server as any)._registeredTools["interact"]._engine;
    await callTool(server, "register_monitor", {
      monitor_id: "engine-sweep-deadman",
      owner_seat: "seat-a",
      watch_targets: ["orchestrator/collab/example.md"],
      mechanism: "event",
      deadman_timeout_s: 60,
    });

    now = 62_000;
    await engine.runSweep();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        monitor_id: "engine-sweep-deadman",
        owner_seat: "seat-a",
        fired_by_agent_id: "agent-engine",
      }),
    );
    const queried = await callTool(server, "query_monitor_registry", {
      gate: "gate-9",
      monitor_id: "engine-sweep-deadman",
    });
    expect(queried.monitors[0]).toMatchObject({
      monitor_id: "engine-sweep-deadman",
      state: "deadman-fired",
      liveness: "deadman-fired",
    });
  });
});
