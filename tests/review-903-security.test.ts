import { containReportPath, readReportTail, REPORT_READ_TAIL_BYTES } from "../src/coordination-paths.js";
import { buildHarnessDaemonBlock, finalizeHarnessDaemon, reportMarkerMatches } from "../src/live-agent-harness.js";
const race = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | (() => void),
  afterOpen: undefined as undefined | (() => void),
  afterLstat: undefined as undefined | ((path: unknown) => void),
  beforeOpenTarget: undefined as string | undefined,
  afterOpenTarget: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const stat = await actual.lstat(...args);
    race.afterLstat?.(args[0]);
    return stat;
  }, open: async (...args: Parameters<typeof actual.open>) => {
    // #907 r2: a hook may target one path (e.g. Linux's per-component walk);
    // an untargeted hook fires on the first open, as before.
    const hit = (target: string | undefined) => !target || String(args[0]).endsWith(target);
    const swap = hit(race.beforeOpenTarget) ? race.beforeOpen : undefined;
    if (swap) race.beforeOpen = undefined;
    swap?.();
    const handle = await actual.open(...args);
    const restore = hit(race.afterOpenTarget) ? race.afterOpen : undefined;
    if (restore) race.afterOpen = undefined;
    try {
      restore?.();
    } catch (error) {
      await handle.close();
      throw error;
    }
    return handle;
  }};
});
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, realpathSync, mkdtempSync, renameSync, statSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, engineForTests } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";

// #903 round 2: Codex Sol's reproduction of the round-1 security findings
// (docs.local/lanes/2026-09-27-review-903-security.test.ts), kept as the RED.
// The five "must" cases failed at 52427963. The mock above only schedules a
// path swap around the real open(); every fs operation is the original.

class IdleClient {
  async listWorkspaces() {
    return { workspaces: [{ ref: "workspace:1", title: "Main", index: 0, selected: true, pinned: false }] };
  }
  async listPanes() {
    return {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      panes: [{ ref: "pane:1", index: 0, focused: true, surface_count: 1, surface_refs: ["surface:9"], selected_surface_ref: "surface:9" }],
    };
  }
  async listPaneSurfaces() {
    return {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [{ ref: "surface:9", title: "skillcreatorCursor", type: "terminal", index: 0, selected: true }],
    };
  }
  async readScreen(surface: string) {
    return { surface, text: "Cursor Agent\ncursor> \nAuto", lines: 30, scrollback_used: false };
  }
  async send() {}
  async sendKey() {}
  async renameTab() {}
}

function parse(result: any): Record<string, any> {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

describe("#903 review: wait_for report containment and harness PID safety", () => {
  let dir = "";
  let agentDir = "";
  let outside = "";
  let server: any;
  const savedHome = process.env.HOME;
  const AGENT = "skill-creatorCursor-h1test";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmuxlayer-wait-report-"));
    outside = mkdtempSync(join(tmpdir(), "cmuxlayer-wait-outside-"));
    // #889: the coordination dir is what ~/.cmux resolves to; point HOME here.
    process.env.HOME = dir;
    agentDir = join(dir, ".cmux", "agents", AGENT);
    mkdirSync(agentDir, { recursive: true });
    server = createServer({
      client: new IdleClient() as any,
      stateDir: dir,
      inboxBaseDir: join(dir, ".cmux", "agents"),
      disableSpawnPreflight: true,
    });
    const engine = engineForTests(server)!;
    const now = new Date().toISOString();
    const record = {
      agent_id: AGENT,
      surface_id: "surface:9",
      workspace_id: "workspace:1",
      state: "working",
      repo: "skill-creator",
      model: "auto",
      cli: "cursor",
      cli_session_id: null,
      task_summary: "h1",
      pid: null,
      version: 1,
      created_at: now,
      updated_at: now,
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    } as AgentRecord;
    (engine as any)["stateMgr"].writeState(record);
    engine.getRegistry().set(AGENT, record);
  });

  afterEach(() => {
    // #907 r2 hygiene: a hook left armed by a refused open must not fire in a
    // later test (it used to, and leaked that test's handle).
    Object.assign(race, {
      beforeOpen: undefined,
      afterOpen: undefined,
      afterLstat: undefined,
      beforeOpenTarget: undefined,
      afterOpenTarget: undefined,
    });
    engineForTests(server)?.dispose?.();
    process.env.HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const waitFor = (args: Record<string, unknown>) =>
    server._registeredTools["wait_for"].handler(args, {});

  it("REVIEW containment matrix: dotdot, malformed IDs, symlink parents, case, slash, var aliases", async () => {
    const report = join(agentDir, "report.md");
    writeFileSync(report, "DONE_X\n");
    const target = join(outside, "report.md");
    writeFileSync(target, "DONE_X\n");
    for (const id of ["../worktrees", "a/b", "", ".", ".."]) {
      expect((await containReportPath(report, id)).ok, id).toBe(false);
    }
    const other = join(dir, ".cmux", "agents", "other");
    mkdirSync(other);
    writeFileSync(join(other, "report.md"), "DONE_X\n");
    expect((await containReportPath(agentDir + "/../other/report.md", AGENT)).ok).toBe(false);
    symlinkSync(outside, join(agentDir, "linked-parent"));
    expect((await containReportPath(join(agentDir, "linked-parent", "report.md"), AGENT)).ok).toBe(false);
    expect((await containReportPath(join(agentDir, "linked-parent", "missing.md"), AGENT)).ok).toBe(false);
    // Case aliases exist only on a case-insensitive filesystem (macOS default;
    // CI is Linux), and /var -> /private/var only on macOS.
    if (existsSync(report.replace("report.md", "REPORT.MD"))) {
      expect(statSync(report.replace("report.md", "REPORT.MD")).ino).toBe(statSync(report).ino);
      const caseRoot = report.replace(AGENT, AGENT.toUpperCase());
      expect(statSync(caseRoot).ino).toBe(statSync(report).ino);
      expect((await containReportPath(caseRoot, AGENT)).ok).toBe(true);
      expect((await containReportPath(report.replace("report.md", "REPORT.MD"), AGENT)).ok).toBe(true);
    }
    if (process.platform !== "darwin") {
      const slash = parse(await waitFor({ agent_id: AGENT, report_path: report + "/", done_marker: "DONE_X", timeout_ms: 1000 }));
      expect(slash.matched).toBe(true);
      return;
    }
    const varHome = mkdtempSync("/var/tmp/review903-alias-");
    try {
      process.env.HOME = varHome;
      const varAgent = join(varHome, ".cmux", "agents", AGENT);
      mkdirSync(varAgent, { recursive: true });
      const varReport = join(varAgent, "r.md");
      writeFileSync(varReport, "DONE_X\n");
      const a = await containReportPath(varReport, AGENT);
      const b = await containReportPath(varReport.replace("/var/", "/private/var/"), AGENT);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(a.resolved).toBe(b.resolved);
      expect((await containReportPath(target.replace("/tmp/", "/private/tmp/"), AGENT)).ok).toBe(false);
    } finally {
      process.env.HOME = dir;
      rmSync(varHome, { recursive: true, force: true });
    }
    const slash = parse(await waitFor({ agent_id: AGENT, report_path: report + "/", done_marker: "DONE_X", timeout_ms: 1000 }));
    expect(slash.matched).toBe(true);
    console.log("REVIEW matrix: invalid IDs refused; dotdot refused; static and missing symlink-parent refused; case alias allowed; private-var alias allowed; file trailing slash canonicalized");
  });

  it("REVIEW must refuse a parent swapped after containment before open", async () => {
    const parent = join(agentDir, "nested");
    mkdirSync(parent);
    const report = join(parent, "report.md");
    writeFileSync(report, "still working\n");
    writeFileSync(join(outside, "report.md"), "OUTSIDE_SENTINEL_903\n");
    race.beforeOpen = () => {
      renameSync(parent, parent + "-old");
      symlinkSync(outside, parent);
    };
    const result = parse(await waitFor({ agent_id: AGENT, report_path: report, done_marker: "OUTSIDE_SENTINEL_903", timeout_ms: 1000 }));
    console.log("REVIEW parent-race", JSON.stringify({ matched: result.matched, source: result.source }));
    expect(result.matched).toBe(false);
  });

  it("refuses a parent swapped before open and restored right after it", async () => {
    const parent = join(agentDir, "nested");
    mkdirSync(parent);
    const report = join(parent, "report.md");
    writeFileSync(report, "still working\n");
    writeFileSync(join(outside, "report.md"), "OUTSIDE_SENTINEL_903\n");
    race.beforeOpen = () => {
      renameSync(parent, parent + "-old");
      symlinkSync(outside, parent);
    };
    race.afterOpen = () => {
      rmSync(parent);
      renameSync(parent + "-old", parent);
    };
    const result = parse(await waitFor({ agent_id: AGENT, report_path: report, done_marker: "OUTSIDE_SENTINEL_903", timeout_ms: 1000 }));
    expect(result.matched).toBe(false);
    // macOS refuses the swapped lookup (ELOOP); Linux's anchored walk opens
    // "/" first, so the restored real dir is walked and the inside file read.
    if (result.error) expect(result.error).toMatch(/symlinked component/);
  });

  it("the tail keeps a whole last line and refuses one longer than the tail", async () => {
    // readReportTail takes containment's canonical path (macOS tmp is under /var -> /private/var).
    const report = join(realpathSync(agentDir), "report.md");
    // The tail starts mid-line: that fragment is dropped, the last line is whole.
    writeFileSync(report, "x".repeat(10) + "\n" + "y".repeat(REPORT_READ_TAIL_BYTES - 7) + "\nDONE_X\n");
    expect((await readReportTail(report)).ok).toBe(true);
    expect(reportMarkerMatches((await readReportTail(report) as { text?: string }).text, "DONE_X")).toBe(true);
    writeFileSync(report, "z".repeat(REPORT_READ_TAIL_BYTES + 10) + "DONE_X\n");
    expect(await readReportTail(report)).toMatchObject({ ok: false, reason: expect.stringMatching(/final line is not within/) });
  });

  // #907 r2 (CodeRabbit 4115181449): schedule the swap at the component that
  // matters on each platform. On Linux the walk opens ".../nested" through the
  // held parent fd; on macOS the single open is of the report itself.
  it("refuses a parent swapped right before its own component is opened, and never reads outside after acquiring it", async () => {
    const parent = join(agentDir, "nested");
    mkdirSync(parent);
    const report = join(parent, "report.md");
    writeFileSync(report, "still working\n");
    writeFileSync(join(outside, "report.md"), "OUTSIDE_SENTINEL_907\n");
    const swapIn = () => {
      renameSync(parent, parent + "-old");
      symlinkSync(outside, parent);
    };
    const target = process.platform === "linux" ? "/nested" : "/nested/report.md";

    race.beforeOpenTarget = target;
    race.beforeOpen = swapIn;
    const refused = parse(await waitFor({ agent_id: AGENT, report_path: report, done_marker: "OUTSIDE_SENTINEL_907", timeout_ms: 600 }));
    expect(refused.matched).toBe(false);
    expect(refused.error).toMatch(/symlinked component|could not be opened/);

    // Restore, then swap only AFTER the nested component is held (Linux): the
    // leaf is opened relative to the held real directory, never the symlink.
    rmSync(parent);
    renameSync(parent + "-old", parent);
    if (process.platform === "linux") {
      race.afterOpenTarget = "/nested";
      race.afterOpen = swapIn;
      const held = parse(await waitFor({ agent_id: AGENT, report_path: report, done_marker: "OUTSIDE_SENTINEL_907", timeout_ms: 600 }));
      expect(held.matched).toBe(false);
      expect(held.error ?? "").not.toMatch(/OUTSIDE/);
    }
  });

  it("REVIEW must preserve a complete marker exactly at tail boundary", async () => {
    const report = join(agentDir, "report.md");
    const text = "prefix\n" + "DONE_X\n" + " ".repeat(REPORT_READ_TAIL_BYTES - 7);
    writeFileSync(report, text);
    expect(reportMarkerMatches(text, "DONE_X")).toBe(true);
    const result = parse(await waitFor({ agent_id: AGENT, report_path: report, done_marker: "DONE_X", timeout_ms: 1000 }));
    console.log("REVIEW boundary-marker", JSON.stringify({ matched: result.matched, source: result.source }));
    expect(result.matched).toBe(true);
  });

  it("REVIEW must reject a partial final line that only trims to the marker", async () => {
    const report = join(agentDir, "report.md");
    const text = "prefix" + " ".repeat(REPORT_READ_TAIL_BYTES - 6) + "DONE_X";
    writeFileSync(report, text);
    expect(reportMarkerMatches(text, "DONE_X")).toBe(false);
    const result = parse(await waitFor({ agent_id: AGENT, report_path: report, done_marker: "DONE_X", timeout_ms: 1000 }));
    console.log("REVIEW partial-final-line", JSON.stringify({ matched: result.matched, source: result.source }));
    expect(result.matched).toBe(false);
  });

  it("REVIEW must not signal without a valid spawn receipt", () => {
    const plan = { socket_path: "/tmp/review903.sock", installed_socket: false, started_by_run: true, build_check: "enforced" as const };
    for (const receiptText of [null, "garbage\n"]) {
      const block = buildHarnessDaemonBlock({ plan, serverVersion: null, controlHealth: { health: { current_process: { pid: 5150, script_path: "/review903/dist/daemon.js" } } }, distDir: "/review903/dist" });
      const kill = vi.fn();
      const result = finalizeHarnessDaemon({ plan, block, receiptText, distDir: "/review903/dist" }, { kill, commandOf: () => "node /review903/dist/daemon.js" });
      console.log("REVIEW missing/garbage receipt", JSON.stringify({ receiptText, signals: kill.mock.calls, result }));
      expect.soft(kill).not.toHaveBeenCalled();
    }
  });

  it("REVIEW must not signal a reused PID whose script only shares the prefix", () => {
    const plan = { socket_path: "/tmp/review903.sock", installed_socket: false, started_by_run: true, build_check: "enforced" as const };
    const kill = vi.fn();
    const result = finalizeHarnessDaemon({ plan, block: undefined, receiptText: "5150\n", distDir: "/review903/dist" }, { kill, commandOf: () => "node /review903/dist/daemon.js.backup" });
    console.log("REVIEW PID-substring", JSON.stringify({ signals: kill.mock.calls, result }));
    expect(kill).not.toHaveBeenCalled();
  });


  // #906: Codex Sol round-2 reproductions (docs.local/lanes/2026-09-27-review-903-r2-extra.test.ts).
  it("R2 rejects a parent reswapped after that ancestor was lstatted", async () => {
    const parent = join(agentDir, "nested");
    mkdirSync(parent);
    const report = join(parent, "report.md");
    writeFileSync(report, "still working\n");
    writeFileSync(join(outside, "report.md"), "OUTSIDE_SENTINEL_R2\n");
    race.beforeOpen = () => {
      renameSync(parent, parent + "-old");
      symlinkSync(outside, parent);
    };
    race.afterOpen = () => {
      rmSync(parent);
      renameSync(parent + "-old", parent);
    };
    race.afterLstat = (path) => {
      if (String(path).endsWith("/nested")) {
        race.afterLstat = undefined;
        renameSync(parent, parent + "-old");
        symlinkSync(outside, parent);
      }
    };
    const result = parse(await waitFor({agent_id:AGENT,report_path:report,done_marker:"OUTSIDE_SENTINEL_R2",timeout_ms:1000}));
    console.log("R2 reswap handler", JSON.stringify({matched:result.matched,source:result.source}));
    expect(result.matched).toBe(false);
  });

  it("R2 rejects a non-Node process whose preceding argument is named node", () => {
    const plan = {socket_path:"/tmp/review903.sock",installed_socket:false,started_by_run:true,build_check:"enforced" as const};
    const kill = vi.fn();
    const result = finalizeHarnessDaemon({plan,block:undefined,receiptText:"5150\n",distDir:"/review903/dist"}, {kill,commandOf:()=>"vim /tmp/node /review903/dist/daemon.js"});
    console.log("R2 non-node process", JSON.stringify({signals:kill.mock.calls,result}));
    expect(kill).not.toHaveBeenCalled();
  });
});
