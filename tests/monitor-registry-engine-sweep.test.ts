/**
 * The engine sweep fires the wired monitor deadman notify callback. Ported
 * from monitor-registry-mcp.test.ts when the monitor MCP tools were retired
 * (CX-3 S8a-1): the monitor is now registered through the library call, not
 * the register_monitor tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, engineForTests } from "../src/server.js";
import {
  queryMonitorRegistryForGates,
  registerMonitor,
} from "../src/monitor-registry.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-monitor-registry-engine-sweep-test");

function registryPath(): string {
  return join(TEST_DIR, "monitor-registry.json");
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

describe("monitor registry engine sweep", () => {
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
    const engine = engineForTests(server)!;
    await registerMonitor(
      {
        monitor_id: "engine-sweep-deadman",
        owner_seat: "seat-a",
        watch_targets: ["orchestrator/collab/example.md"],
        mechanism: "event",
        deadman_timeout_s: 60,
      },
      { registryPath: registryPath(), now: () => now },
    );

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
    const queried = queryMonitorRegistryForGates({
      registryPath: registryPath(),
      now: () => now,
    });
    expect(queried.monitors).toHaveLength(1);
    expect(queried.monitors[0]).toMatchObject({
      monitor_id: "engine-sweep-deadman",
      state: "deadman-fired",
      liveness: "deadman-fired",
    });
  });
});
