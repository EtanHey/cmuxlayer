import { describe, expect, it, vi } from "vitest";
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
  planHarnessDaemon,
  commandRunsDaemon,
  harnessCallerSpawnDepth,
  harnessDepthRefusal,
  runHarnessPreflight,
  harnessCoordinationReportPath,
  harnessCoordinationRunId,
  harnessWorkersToClose,
  harnessDaemonPidsFromReceipt,
  finalizeHarnessDaemon,
  runHarnessWaitSlices,
  type HarnessDaemonPlan,
} from "../src/live-agent-harness.js";

// H1 (#800 + #808): the live harness must prove THIS build on a private
// daemon, say which daemon served it, use only public tools, and fail loudly.

const DIST = "/srv/cmuxlayer/.worktrees/h1/dist";
const HOME = "/home/ci";
const PRIVATE_PLAN: HarnessDaemonPlan = {
  socket_path: "/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock",
  installed_socket: false,
  started_by_run: true,
  build_check: "enforced",
};
const INSTALLED_PLAN: HarnessDaemonPlan = {
  socket_path: "/home/ci/.local/state/cmux/cmuxlayer-stated.sock",
  installed_socket: true,
  started_by_run: false,
  build_check: "enforced",
};
const FOREIGN_BINARY = "/opt/homebrew/Cellar/cmuxlayer/0.4.87/libexec/dist/daemon.js";

describe("live harness daemon block (#800)", () => {
  it("defaults to a private socket under the cmux state dir, per run", () => {
    expect(defaultHarnessDaemonSocket("/home/ci", 4242)).toBe(
      "/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock",
    );
  });

  it("records which daemon served the run and passes a daemon from this build", () => {
    const block = buildHarnessDaemonBlock({
      plan: PRIVATE_PLAN,
      serverVersion: "0.4.88-dev",
      controlHealth: {
        health: { current_process: { pid: 5150, script_path: `${DIST}/daemon.js` } },
      },
      distDir: DIST,
    });

    expect(block).toEqual({
      socket_path: "/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock",
      private: true,
      started_by_run: true,
      installed_socket: false,
      build_check: "enforced",
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
      plan: INSTALLED_PLAN,
      serverVersion: "0.4.87",
      controlHealth: {
        health: { current_process: { pid: 77, script_path: FOREIGN_BINARY } },
      },
      distDir: DIST,
    });

    expect(block.from_this_build).toBe(false);
    expect(harnessDaemonFailures(block)).toEqual(["daemon_not_from_this_build"]);
  });

  it("fails loudly when the daemon cannot be identified", () => {
    const block = buildHarnessDaemonBlock({
      plan: { ...PRIVATE_PLAN, socket_path: "/s.sock" },
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
    // tools/list lives in runHarnessPreflight (src/live-agent-harness.ts, #889).
    expect(script).toContain("harness.runHarnessPreflight(");
    expect(readFileSync(join(process.cwd(), "src", "live-agent-harness.ts"), "utf8")).toContain('"tools/list"');
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
          started_by_run: true,
          installed_socket: false,
          build_check: "enforced",
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
    expect(md).toContain("- Socket: `/home/ci/.local/state/cmux/cmuxlayer-harness-4242.sock` (private, started by this run)");
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

// ---------------------------------------------------------------------------
// H1 round 2 (#889). Each block fails on 8234ed43 and passes at head.
// ---------------------------------------------------------------------------

const script = () =>
  readFileSync(join(process.cwd(), "scripts", "run-live-agent-harness.mjs"), "utf8");

describe("#889 must-fix 1: the runner waits on the issued report_path under the coordination root", () => {
  it("issues each worker a report path under ~/.cmux, waits on the receipt's report_path, and copies it into results/", () => {
    expect(harnessCoordinationReportPath(HOME, "cursor-2026", "cursor-01")).toBe(
      "/home/ci/.cmux/live-harness/cursor-2026/cursor-01.report.md",
    );
    const source = script();
    expect(source).toMatch(/report_path: spec\.coordinationReport/);
    expect(source).toMatch(/worker\.spawn\.structured\?\.report_path/);
    expect(source).toMatch(/reportPath: worker\.issued_report_path/);
    expect(source).toMatch(/copyFile\(worker\.issued_report_path, spec\.report\)/);
  });
});

describe("#889 must-fix 2: --installed-daemon is a truthful opt-out", () => {
  it("a foreign binary with --installed-daemon proceeds, recorded private:false, from_this_build:false", () => {
    const plan = planHarnessDaemon({
      daemonSocketArg: "",
      envSocket: undefined,
      installedDaemon: true,
      home: HOME,
      pid: 4242,
      socketExists: () => true,
    });
    const block = buildHarnessDaemonBlock({
      plan,
      serverVersion: "0.4.87",
      controlHealth: { health: { current_process: { pid: 77, script_path: FOREIGN_BINARY } } },
      distDir: DIST,
    });

    expect(block.private).toBe(false);
    expect(block.from_this_build).toBe(false);
    expect(block.build_check).toBe("opted_out");
    expect(harnessDaemonFailures(block)).toEqual([]);
    const md = buildRunReportMarkdown(
      {
        started_at: "s",
        finished_at: "f",
        config: { cli: "cursor", repo: "r", workspace: "w", count: 1, root: "/r", mcpProfile: "sterile", cleanupTimeoutMs: 1, finalGreen: "GREEN_X", finalRed: "RED_X" } as any,
        workers: [{ name: "cursor-01", agent_id: "a-1", failures: [] } as any],
        events: [],
        daemon: block,
        daemon_failures: harnessDaemonFailures(block),
      } as any,
      {},
    );
    expect(md).toContain("build check opted out");
    expect(md.trimEnd().endsWith("GREEN_X")).toBe(true);
  });

  it("the flag reaches the daemon plan and the docs say it opts out of the build check", () => {
    expect(script()).toMatch(/installedDaemon: cliOptions\.installedDaemon/);
    const doc = readFileSync(join(process.cwd(), "docs", "testing", "live-agent-harness.md"), "utf8");
    expect(doc).toMatch(/`--installed-daemon` \*\*opts out of the build check\*\*/);
  });
});

describe("#889 must-fix 3: depth preflight", () => {
  const surface = "7C1D0E2A-SEAT";
  const fakeClient = (depth: number) => {
    const calls: string[] = [];
    return {
      calls,
      request: async (method: string) => {
        calls.push(method);
        return { tools: REQUIRED_HARNESS_TOOLS.map((name) => ({ name })) };
      },
      callTool: async (name: string) => {
        calls.push(name);
        return {
          ok: true,
          structured: {
            agents: [
              { agent_id: "lead-1", state: { value: "ready" }, surface_id: "surface:3", detail: { surface_uuid: "OTHER", spawn_depth: 1 } },
              { agent_id: "worker-1", state: { value: "working" }, surface_id: "surface:9", detail: { surface_uuid: surface, spawn_depth: depth } },
            ],
          },
        };
      },
    };
  };

  it("depth 2 fails in preflight naming the depth and both sanctioned ways, with zero spawns", async () => {
    const client = fakeClient(2);
    await expect(runHarnessPreflight(client, { callerSurface: surface })).rejects.toThrow(
      /spawn depth 2 .*plain terminal.*lead seat at depth <= 1/,
    );
    expect(client.calls).not.toContain("spawn_agent");
  });

  it("depth 1 (a lead seat) and a plain terminal pass", async () => {
    await expect(runHarnessPreflight(fakeClient(1), { callerSurface: surface })).resolves.toMatchObject({ caller_depth: 1 });
    const plain = fakeClient(5);
    await expect(runHarnessPreflight(plain, { callerSurface: undefined })).resolves.toMatchObject({ caller_depth: null });
    expect(plain.calls).toEqual(["tools/list"]);
    expect(harnessDepthRefusal(null)).toBeNull();
    expect(harnessCallerSpawnDepth({ agents: [] }, surface)).toBeNull();
  });

  it("the runner runs the preflight before its first spawn_agent call", () => {
    const source = script();
    const preflight = source.indexOf("harness.runHarnessPreflight(");
    const spawn = source.indexOf('"spawn_agent",');
    expect(preflight).toBeGreaterThan(0);
    expect(preflight).toBeLessThan(spawn);
    expect(source).toMatch(/callerSurface: process\.env\.CMUX_SURFACE_ID/);
  });
});

describe("#889 must-fix 4: only stop a daemon this run started", () => {
  const block = (plan: HarnessDaemonPlan) =>
    buildHarnessDaemonBlock({
      plan,
      serverVersion: "0.4.88-dev",
      controlHealth: { health: { current_process: { pid: 5150, script_path: `${DIST}/daemon.js` } } },
      distDir: DIST,
    });

  it("an inherited --daemon-socket is never signalled and says started_by_run:false", () => {
    const plan = planHarnessDaemon({
      daemonSocketArg: "/tmp/someone-elses.sock",
      envSocket: undefined,
      installedDaemon: false,
      home: HOME,
      pid: 4242,
      socketExists: (path) => path === "/tmp/someone-elses.sock",
    });
    const inherited = block(plan);
    const kill = vi.fn();

    expect(inherited.started_by_run).toBe(false);
    expect(inherited.private).toBe(false);
    finalizeHarnessDaemon({ plan, block: inherited, receiptText: "5150\n", distDir: DIST }, { kill, commandOf: () => `node ${DIST}/daemon.js` });
    expect(kill).not.toHaveBeenCalled();
  });

  it("recognises the nightly default socket as installed, never started by the run", () => {
    const plan = planHarnessDaemon({
      daemonSocketArg: "",
      envSocket: "/home/ci/.local/state/cmux/cmuxlayer-stated-nightly.sock",
      installedDaemon: false,
      home: HOME,
      pid: 4242,
      socketExists: () => false,
    });
    expect(plan.installed_socket).toBe(true);
    expect(plan.started_by_run).toBe(false);
    const kill = vi.fn();
    finalizeHarnessDaemon({ plan, block: block(plan), receiptText: "5150\n", distDir: DIST }, { kill, commandOf: () => `node ${DIST}/daemon.js` });
    expect(kill).not.toHaveBeenCalled();
  });

  it("a fresh per-run socket is started by the run and stopped by its receipt PID", () => {
    const plan = planHarnessDaemon({
      daemonSocketArg: "",
      envSocket: undefined,
      installedDaemon: false,
      home: HOME,
      pid: 4242,
      socketExists: () => false,
    });
    expect(plan.socket_path).toBe(defaultHarnessDaemonSocket(HOME, 4242));
    expect(plan.started_by_run).toBe(true);
    const kill = vi.fn();
    const commandOf = () => `node ${DIST}/daemon.js`;
    const daemon = finalizeHarnessDaemon({ plan, block: block(plan), receiptText: "5150\n", distDir: DIST }, { kill, commandOf });
    expect(daemon).toMatchObject({ stopped: true, stopped_pids: [5150] });
    expect(kill).toHaveBeenCalledWith(5150, "SIGTERM");
  });

  it("the runner stops the daemon only through finalizeHarnessDaemon, and closes leaked dummies in finally", () => {
    const source = script();
    expect(source).toContain("harness.finalizeHarnessDaemon(");
    expect(source).not.toMatch(/process\.kill\(results\.daemon/);
    expect(source).toMatch(/finally \{\s*\/\/ A red path after spawn_agent[\s\S]*?close_surface[\s\S]*?scope: "agent"/);
  });
});

// ---------------------------------------------------------------------------
// #898 (H1 follow-up). Each block fails on main (863d2211) and passes at head.
// ---------------------------------------------------------------------------

describe("#898 item 3: a terminal non-match ends the wait after one slice", () => {
  const reply = (structured: Record<string, unknown>) => ({ ok: true, structured });
  const input = { agentId: "w-1", reportPath: "/r.md", marker: "DONE_W", waitTimeoutMs: 60_000, sliceMs: 5_000 };

  it("an error agent (source immediate) is called once, not re-sliced until the deadline", async () => {
    const callTool = vi.fn(async () => reply({ matched: false, source: "immediate", state: "error" }));
    const out = await runHarnessWaitSlices(callTool, input);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(out.slices).toBe(1);
    expect(out.wait?.structured?.state).toBe("error");
  });

  it("only a timeout slice starts another, and a report_file match stops", async () => {
    const replies = [
      reply({ matched: false, source: "timeout", state: "working" }),
      reply({ matched: true, source: "report_file", state: "working" }),
    ];
    const callTool = vi.fn(async () => replies.shift() ?? reply({ source: "timeout" }));
    const out = await runHarnessWaitSlices(callTool, input);
    expect(out.slices).toBe(2);
    expect(callTool).toHaveBeenLastCalledWith(
      "wait_for",
      expect.objectContaining({ agent_id: "w-1", report_path: "/r.md", done_marker: "DONE_W" }),
      expect.any(Number),
    );
  });

  it("the runner waits through runHarnessWaitSlices", () => {
    expect(script()).toContain("harness.runHarnessWaitSlices(");
  });
});

describe("#898 item 4: re-check the PID's command before SIGTERM", () => {
  const plan: HarnessDaemonPlan = { ...PRIVATE_PLAN };
  const block = buildHarnessDaemonBlock({
    plan,
    serverVersion: "0.4.89-dev",
    controlHealth: { health: { current_process: { pid: 5150, script_path: `${DIST}/daemon.js` } } },
    distDir: DIST,
  });

  const finalize = (commandOf: (pid: number) => string | null) => {
    const kill = vi.fn();
    const daemon = finalizeHarnessDaemon({ plan, block, receiptText: "5150\n", distDir: DIST }, { kill, commandOf });
    return { kill, daemon };
  };

  it("a PID now running something else is not signalled and records pid_reused", () => {
    const { kill, daemon } = finalize(() => "/usr/bin/vim notes.txt");
    expect(daemon).toMatchObject({ stopped: false, stop_skipped: "pid_reused" });
    expect(kill).not.toHaveBeenCalled();
  });

  it("a PID that is gone is not signalled", () => {
    const { kill, daemon } = finalize(() => null);
    expect(daemon).toMatchObject({ stopped: false, stop_skipped: "not_running" });
    expect(kill).not.toHaveBeenCalled();
  });

  // #903 round 2 (P1): whole-path identity of the LAST argument, not a substring.
  it("matches only <node> <dist>/daemon.js, whole paths, spaces included", () => {
    const script = "/srv/a b/cmuxlayer/dist/daemon.js";
    expect(commandRunsDaemon(`node ${script}`, script)).toBe(true);
    expect(commandRunsDaemon(`${process.execPath} ${script}`, script)).toBe(true);
    expect(commandRunsDaemon(`/opt/node 22/bin/node ${script}`, script)).toBe(true);
    expect(commandRunsDaemon(`node ${script}.backup`, script)).toBe(false);
    expect(commandRunsDaemon(`vim ${script}`, script)).toBe(false);
    expect(commandRunsDaemon(`node ${script} --flag`, script)).toBe(false);
    expect(commandRunsDaemon(`node /other${script}`, script)).toBe(false);
  });
});

describe("#898 item 7: concurrent runs never share a coordination id", () => {
  it("roots with the same basename get different ids that still name the run", () => {
    const a = harnessCoordinationRunId("/tmp/a/run");
    const b = harnessCoordinationRunId("/tmp/b/run");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^run-[0-9a-f]{8,}$/);
    expect(harnessCoordinationRunId("/tmp/a/run/")).toBe(a);
  });

  it("the runner derives the report dir from the full root", () => {
    const source = script();
    expect(source).toContain("harness.harnessCoordinationRunId(config.root)");
    expect(source).not.toMatch(/basename\(config\.root\)/);
  });
});

describe("#898 item 8: a failed close_surface is retried in finally", () => {
  it("retries unless the close returned ok:true", () => {
    const workers = [
      { agent_id: "a", close: { ok: false, error: "refused" } },
      { agent_id: "b", close: { ok: true } },
      { agent_id: "c" },
      { name: "never-spawned" },
    ];
    expect(harnessWorkersToClose(workers).map((w) => w.agent_id)).toEqual(["a", "c"]);
  });

  it("the runner's finally uses it", () => {
    expect(script()).toMatch(/finally \{[\s\S]*?harness\.harnessWorkersToClose\(results\.workers\)/);
  });
});

describe("#898 items 9-10: the run stops the daemon it spawned, even on a red preflight", () => {
  const command = (pid: number) => (pid === 4321 || pid === 5150 ? `node ${DIST}/daemon.js` : "/usr/sbin/cron");

  it("reads every PID from the spawn receipt", () => {
    expect(harnessDaemonPidsFromReceipt("4321\n\n4400\nnope\n4321\n")).toEqual([4321, 4400]);
    expect(harnessDaemonPidsFromReceipt(null)).toEqual([]);
  });

  it("a preflight that failed before control_health still stops the spawned daemon by its receipt PID", () => {
    const kill = vi.fn();
    const daemon = finalizeHarnessDaemon(
      { plan: PRIVATE_PLAN, block: undefined, receiptText: "4321\n", distDir: DIST },
      { kill, commandOf: command },
    );
    expect(kill).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(daemon).toMatchObject({ spawned_pids: [4321], stopped: true, stopped_pids: [4321], from_this_build: false });
  });

  it("stops exactly what the run spawned: a reused receipt PID is skipped", () => {
    const kill = vi.fn();
    const daemon = finalizeHarnessDaemon(
      { plan: PRIVATE_PLAN, block: undefined, receiptText: "4321\n4400\n", distDir: DIST },
      { kill, commandOf: command },
    );
    expect(kill.mock.calls).toEqual([[4321, "SIGTERM"]]);
    expect(daemon).toMatchObject({ stopped: true, stopped_pids: [4321], stop_skipped: "pid_reused" });
  });

  // #903 round 2 (P1): no receipt is no proof of a spawn, so no signal --
  // control_health's PID may be a daemon another proxy started first.
  it("without a valid receipt nothing is signalled and started_by_run turns false", () => {
    const withHealthPid = buildHarnessDaemonBlock({
      plan: PRIVATE_PLAN,
      serverVersion: null,
      controlHealth: { health: { current_process: { pid: 5150, script_path: `${DIST}/daemon.js` } } },
      distDir: DIST,
    });
    for (const receiptText of [null, "", "garbage\n-3\n"]) {
      const kill = vi.fn();
      const daemon = finalizeHarnessDaemon(
        { plan: PRIVATE_PLAN, block: { ...withHealthPid }, receiptText, distDir: DIST },
        { kill, commandOf: command },
      );
      expect(kill).not.toHaveBeenCalled();
      expect(daemon).toMatchObject({ stopped: false, stop_skipped: "no_receipt", started_by_run: false, private: false, spawned_pids: [] });
    }
  });

  it("never signals a daemon the run did not start, receipt or not", () => {
    const kill = vi.fn();
    finalizeHarnessDaemon(
      { plan: INSTALLED_PLAN, block: undefined, receiptText: "4321\n", distDir: DIST },
      { kill, commandOf: command },
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("the runner has the spawner write a PID receipt when it owns the socket, and finalizes in finally", () => {
    const source = script();
    expect(source).toMatch(/if \(daemonPlan\.started_by_run\)[\s\S]{0,200}CMUXLAYER_DAEMON_PID_RECEIPT/);
    expect(source).toMatch(/finally \{[\s\S]*?harness\.finalizeHarnessDaemon\(/);
  });
});

describe("#898 item 11: from_this_build is a path containment, not a string prefix", () => {
  it("a binary that escapes dist through .. is not from this build", () => {
    const at = (binary: string) =>
      buildHarnessDaemonBlock({
        plan: PRIVATE_PLAN,
        serverVersion: null,
        controlHealth: { health: { current_process: { pid: 1, script_path: binary } } },
        distDir: DIST,
      }).from_this_build;
    expect(at(`${DIST}/../../other/dist/daemon.js`)).toBe(false);
    expect(at(`${DIST}/daemon.js`)).toBe(true);
  });
});

describe("#898 item 12: the depth preflight matches the caller's surface case-insensitively", () => {
  it("finds the seat when the server reports its uuid in another case", () => {
    const agents = {
      agents: [{ agent_id: "w", state: "working", detail: { surface_uuid: "7c1d0e2a-seat", spawn_depth: 2 } }],
    };
    expect(harnessCallerSpawnDepth(agents, "7C1D0E2A-SEAT")).toBe(2);
  });
});

describe("#898 minor: --installed-daemon beats an inherited CMUXLAYER_DAEMON_SOCKET", () => {
  it("uses the installed stable socket, not the inherited one", () => {
    const plan = planHarnessDaemon({
      daemonSocketArg: "",
      envSocket: "/tmp/inherited.sock",
      installedDaemon: true,
      home: HOME,
      pid: 4242,
      socketExists: () => true,
    });
    expect(plan.socket_path).toBe("/home/ci/.local/state/cmux/cmuxlayer-stated.sock");
    expect(plan.installed_socket).toBe(true);
  });
});
