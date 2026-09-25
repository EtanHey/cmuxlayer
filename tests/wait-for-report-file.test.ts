import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, engineForTests } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";

// #808: `wait_for(done)` could never match a sterile worker (it is never told
// the engine report path) and zod silently stripped the harness's
// report_path/done_marker. wait_for now takes both as a file-backed done:
// the report's final non-empty line must equal done_marker.

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

describe("wait_for file-backed done (#808)", () => {
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
    engineForTests(server)?.dispose?.();
    process.env.HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const waitFor = (args: Record<string, unknown>) =>
    server._registeredTools["wait_for"].handler(args, {});

  it("matches when the report's final line is the done_marker, without the registry reaching done", async () => {
    const report = join(agentDir, "report.md");
    writeFileSync(report, "pwd: /x\nStatus: COMPLETE\nDONE_CURSOR_DUMMY_01\n");
    const started = Date.now();

    const parsed = parse(
      await waitFor({ agent_id: AGENT, target_state: "done", report_path: report, done_marker: "DONE_CURSOR_DUMMY_01", timeout_ms: 4_000 }),
    );

    expect(parsed.matched).toBe(true);
    expect(parsed.source).toBe("report_file");
    expect(parsed.report_path).toBe(report);
    expect(parsed.done_marker).toBe("DONE_CURSOR_DUMMY_01");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("does not match a marker that is present but not the final line", async () => {
    const report = join(dir, ".cmux", "live-harness", "run-1", "cursor-01.md");
    mkdirSync(join(dir, ".cmux", "live-harness", "run-1"), { recursive: true });
    writeFileSync(report, "DONE_CURSOR_DUMMY_01\nstill working\n");

    const parsed = parse(
      await waitFor({ agent_id: AGENT, report_path: report, done_marker: "DONE_CURSOR_DUMMY_01", timeout_ms: 1_500 }),
    );

    expect(parsed.matched).toBe(false);
    expect(parsed.source).toBe("timeout");
  });

  it("requires report_path and done_marker together, with an absolute path", async () => {
    const onlyPath = await waitFor({ agent_id: AGENT, report_path: join(agentDir, "r.md"), timeout_ms: 1_000 });
    expect(onlyPath.isError).toBe(true);
    expect(parse(onlyPath).error).toMatch(/report_path and done_marker/);

    const relative = await waitFor({ agent_id: AGENT, report_path: "r.md", done_marker: "X", timeout_ms: 1_000 });
    expect(relative.isError).toBe(true);
    expect(parse(relative).error).toMatch(/absolute/);
  });

  // #889 must-fix 1: containment. Absolute alone let wait_for read any file.
  it("refuses a report_path outside both the coordination dir and the agent dir", async () => {
    const report = join(outside, "report.md");
    writeFileSync(report, "DONE_X\n");

    const refused = await waitFor({ agent_id: AGENT, report_path: report, done_marker: "DONE_X", timeout_ms: 1_000 });

    expect(refused.isError).toBe(true);
    const error = parse(refused).error as string;
    expect(error).toMatch(/coordination dir .*\.cmux/);
    expect(error).toContain(`agents/${AGENT}`);
  });

  it("refuses a symlink from an allowed root that points outside", async () => {
    const target = join(outside, "secret.md");
    writeFileSync(target, "DONE_X\n");
    const link = join(agentDir, "report.md");
    symlinkSync(target, link);

    const refused = await waitFor({ agent_id: AGENT, report_path: link, done_marker: "DONE_X", timeout_ms: 1_000 });

    expect(refused.isError).toBe(true);
    expect(parse(refused).error).toMatch(/must resolve under the coordination dir/);
  });

  it("refuses a report symlinked out of the root after the wait started", async () => {
    const target = join(outside, "secret.md");
    writeFileSync(target, "DONE_X\n");
    const link = join(agentDir, "late.md");
    setTimeout(() => symlinkSync(target, link), 200);

    const parsed = parse(
      await waitFor({ agent_id: AGENT, report_path: link, done_marker: "DONE_X", timeout_ms: 3_000 }),
    );

    expect(parsed.matched).toBe(false);
    expect(parsed.error).toMatch(/must resolve under the coordination dir/);
  });
});
