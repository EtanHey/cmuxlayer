import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  let server: any;
  const AGENT = "skill-creatorCursor-h1test";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cmuxlayer-wait-report-"));
    server = createServer({ client: new IdleClient() as any, stateDir: dir, disableSpawnPreflight: true });
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
    rmSync(dir, { recursive: true, force: true });
  });

  const waitFor = (args: Record<string, unknown>) =>
    server._registeredTools["wait_for"].handler(args, {});

  it("matches when the report's final line is the done_marker, without the registry reaching done", async () => {
    const report = join(dir, "report.md");
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
    const report = join(dir, "report.md");
    writeFileSync(report, "DONE_CURSOR_DUMMY_01\nstill working\n");

    const parsed = parse(
      await waitFor({ agent_id: AGENT, report_path: report, done_marker: "DONE_CURSOR_DUMMY_01", timeout_ms: 1_500 }),
    );

    expect(parsed.matched).toBe(false);
    expect(parsed.source).toBe("timeout");
  });

  it("requires report_path and done_marker together, with an absolute path", async () => {
    const onlyPath = await waitFor({ agent_id: AGENT, report_path: join(dir, "r.md"), timeout_ms: 1_000 });
    expect(onlyPath.isError).toBe(true);
    expect(parse(onlyPath).error).toMatch(/report_path and done_marker/);

    const relative = await waitFor({ agent_id: AGENT, report_path: "r.md", done_marker: "X", timeout_ms: 1_000 });
    expect(relative.isError).toBe(true);
    expect(parse(relative).error).toMatch(/absolute/);
  });
});
