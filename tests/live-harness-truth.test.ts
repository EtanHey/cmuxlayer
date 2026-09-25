import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REQUIRED_HARNESS_TOOLS,
  buildHarnessDaemonBlock,
  buildRunReportMarkdown,
  summarizeHarnessRun,
  waitIsDone,
  defaultHarnessDaemonSocket,
  harnessDaemonFailures,
  isStaleManagedRecord,
  missingHarnessTools,
} from "../src/live-agent-harness.js";

// H1 (#800 + #808): the live harness must prove THIS build on a private
// daemon, say which daemon served it, use only public tools, and fail loudly.

const DIST = "/srv/cmuxlayer/.worktrees/h1/dist";

describe("live harness daemon block (#800)", () => {
  it("defaults to a private socket under the cmux state dir, per run", () => {
    expect(defaultHarnessDaemonSocket("/home/ci", 4242)).toBe(
      "/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock",
    );
  });

  it("records which daemon served the run and passes a daemon from this build", () => {
    const block = buildHarnessDaemonBlock({
      socketPath: "/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock",
      privateSocket: true,
      serverVersion: "0.4.88-dev",
      controlHealth: {
        health: { current_process: { pid: 5150, script_path: `${DIST}/daemon.js` } },
      },
      distDir: DIST,
    });

    expect(block).toEqual({
      socket_path: "/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock",
      private: true,
      version: "0.4.88-dev",
      binary: `${DIST}/daemon.js`,
      pid: 5150,
      expected_dist: DIST,
      from_this_build: true,
    });
    expect(harnessDaemonFailures(block)).toEqual([]);
  });

  it("fails the run when the installed daemon served it", () => {
    const block = buildHarnessDaemonBlock({
      socketPath: "/home/ci/.local/state/cmux/cmuxlayer-stated.sock",
      privateSocket: false,
      serverVersion: "0.4.87",
      controlHealth: {
        health: {
          current_process: {
            pid: 77,
            script_path: "/opt/homebrew/Cellar/cmuxlayer/0.4.87/libexec/dist/daemon.js",
          },
        },
      },
      distDir: DIST,
    });

    expect(block.from_this_build).toBe(false);
    expect(harnessDaemonFailures(block)).toEqual(["daemon_not_from_this_build"]);
  });

  it("fails loudly when the daemon cannot be identified", () => {
    const block = buildHarnessDaemonBlock({
      socketPath: "/s.sock",
      privateSocket: true,
      serverVersion: null,
      controlHealth: undefined,
      distDir: DIST,
    });
    expect(harnessDaemonFailures(block)).toEqual(["daemon_not_from_this_build"]);
  });
});

describe("live harness tool preflight and public tools (#808)", () => {
  it("names every required tool that tools/list lacks", () => {
    expect(REQUIRED_HARNESS_TOOLS).toEqual([
      "spawn_agent",
      "list_agents",
      "list_surfaces",
      "wait_for",
      "close_surface",
      "control_health",
    ]);
    expect(missingHarnessTools(["spawn_agent", "list_agents", "wait_for"])).toEqual([
      "list_surfaces",
      "close_surface",
      "control_health",
    ]);
    expect(missingHarnessTools([...REQUIRED_HARNESS_TOOLS])).toEqual([]);
  });

  it("reads a closed agent as gone from a list_agents({agent_ids}) reply", () => {
    const empty = { ok: true, structured: { agents: [] } };
    const still = { ok: true, structured: { agents: [{ agent_id: "a-1", state: "ready" }] } };
    expect(isStaleManagedRecord(empty, undefined, "a-1")).toBe(false);
    expect(isStaleManagedRecord(still, undefined, "a-1")).toBe(true);
  });

  it("keeps a stopped agent's persisted done record as not stale (agents persist; live run 6)", () => {
    // close_surface(scope:"agent") stops the agent and closes its pane; the
    // record stays as done + resumable by design, so it is not a stale record.
    const persisted = {
      ok: true,
      structured: { agents: [{ agent_id: "a-1", state: "done", resumable: true }] },
    };
    const repoList = {
      ok: true,
      structured: { agents: [{ agent_id: "a-1", state: "done" }, { agent_id: "other", state: "ready" }] },
    };
    expect(isStaleManagedRecord(persisted, repoList, "a-1")).toBe(false);
    expect(
      isStaleManagedRecord(persisted, { ok: true, structured: { agents: [{ agent_id: "a-1", state: "idle" }] } }, "a-1"),
    ).toBe(true);
  });

  it("the runner pins a private socket, preflights tools/list, and calls no hidden tool", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts", "run-live-agent-harness.mjs"),
      "utf8",
    );
    expect(script).toContain("CMUXLAYER_DAEMON_SOCKET");
    expect(script).toContain('"tools/list"');
    const called = [...script.matchAll(/callTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(0);
    for (const name of called) {
      expect(REQUIRED_HARNESS_TOOLS).toContain(name);
    }
  });
});

describe("gate-2 artifact shape (#808)", () => {
  it("counts a file-backed wait_for match as done, whatever the registry state", () => {
    expect(
      waitIsDone({ ok: true, structured: { matched: true, source: "report_file", state: "ready" } }),
    ).toBe(true);
    expect(waitIsDone({ ok: true, structured: { matched: true, state: "done" } })).toBe(true);
    expect(
      waitIsDone({ ok: true, structured: { matched: false, source: "timeout", state: "ready" } }),
    ).toBe(false);
  });

  it("renders the serving daemon and any run error in the run report", () => {
    const md = buildRunReportMarkdown(
      {
        started_at: "2026-09-28T12:00:00.000Z",
        finished_at: "2026-09-28T12:05:00.000Z",
        config: {
          cli: "cursor",
          repo: "skill-creator",
          workspace: "workspace:1",
          count: 1,
          root: "/runs/h1",
          markerPrefix: "DONE_CURSOR_DUMMY",
          workerNamePrefix: "cursor",
          finalGreen: "G",
          finalRed: "R",
          mcpProfile: "sterile",
          waitTimeoutMs: 1,
          cleanupTimeoutMs: 1,
          cleanupPollMs: 1,
        } as any,
        workers: [],
        events: [],
        daemon: {
          socket_path: "/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock",
          private: true,
          version: "0.4.88-dev",
          binary: `${DIST}/daemon.js`,
          pid: 5150,
          expected_dist: DIST,
          from_this_build: true,
        },
        error: "live harness: required tools missing from tools/list: wait_for",
      } as any,
      {},
    );
    expect(md).toContain("## Daemon");
    expect(md).toContain("- Version: `0.4.88-dev`");
    expect(md).toContain(`- Binary: \`${DIST}/daemon.js\` (pid 5150, this build: yes)`);
    expect(md).toContain("- Socket: `/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock` (private)");
    expect(md).toContain("## Run error");
    expect(md).toContain("required tools missing from tools/list: wait_for");
  });
});

describe("never green by omission (H1 live finding)", () => {
  // Live run 3: wait_for died at the proxy's 300 s request cap, the worker was
  // never classified, and the run printed GREEN with exit 0.
  it("fails a worker that was never classified", () => {
    const summary = summarizeHarnessRun([{ name: "cursor-01" } as any]);
    expect(summary.green).toBe(false);
    expect(summary.workerFailures["cursor-01"]).toEqual(["worker_not_classified"]);
  });

  it("reports red with the run error when a worker was cut off mid-run", () => {
    const md = buildRunReportMarkdown(
      {
        started_at: "s",
        finished_at: "f",
        config: { cli: "cursor", repo: "r", workspace: "w", count: 1, root: "/r", mcpProfile: "sterile", cleanupTimeoutMs: 1, finalGreen: "GREEN_X", finalRed: "RED_X" } as any,
        workers: [{ name: "cursor-01", agent_id: "a-1" } as any],
        events: [],
        error: "cmuxlayer daemon temporarily offline or request timed out while retrying",
      } as any,
      {},
    );
    expect(md).not.toContain("All workers passed");
    expect(md).toContain("worker_not_classified");
    expect(md.trimEnd().endsWith("RED_X")).toBe(true);
  });

  it("the runner exits and marks from the run-level verdict, and slices wait_for under the proxy cap", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "run-live-agent-harness.mjs"), "utf8");
    expect(script).toContain("process.exit(results.green ? 0 : 1)");
    expect(script).toMatch(/results\.final_marker = results\.green/);
    const slice = Number(script.match(/const WAIT_SLICE_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ""));
    // The daemon-first proxy fails any request at 300 s (DEFAULT_REQUEST_TIMEOUT_MS).
    expect(slice).toBeGreaterThan(0);
    expect(slice + 30_000).toBeLessThan(300_000);
  });
});

describe("harness cleanup owns its dummy (#808 point 2)", () => {
  it("closes each worker by agent scope with force, so a harvested live agent is stopped, not refused", () => {
    // Live run 5: the report matched, then close_surface({surface}) was
    // correctly refused for a "ready" (live) agent, leaving the pane and record.
    const script = readFileSync(join(process.cwd(), "scripts", "run-live-agent-harness.mjs"), "utf8");
    const close = script.match(/callTool\("close_surface", \{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(close).toMatch(/agent_id: worker\.agent_id/);
    expect(close).toMatch(/scope: "agent"/);
    expect(close).toMatch(/force: true/);
  });
});
