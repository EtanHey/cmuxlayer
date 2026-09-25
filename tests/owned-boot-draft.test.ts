// #793: a boot draft spawn_agent typed but never submitted belongs to the
// spawning caller, so the key-Return that spawn's next_action advises must
// pass the #636 ownership guard. Specimens: five Claude reviewer spawns on
// 0.4.87 (2026-09-25) where the pointer was typed, Return never dispatched,
// and the advised send_to({mode:"key",text:"return"}) was refused
// blocked_by_foreign_draft while the composer held that exact pointer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecFn } from "../src/cmux-client.js";
import { withFakeRightSplitTopology } from "./helpers/fake-right-split-topology.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";
import { engineForTests } from "../src/server.js";

let testDir = "";

async function loadServerModule() {
  vi.resetModules();
  const serverModule = await import("../src/server.js");
  return {
    ...serverModule,
    createServerContext: (
      opts: Parameters<typeof serverModule.createServerContext>[0] = {},
    ) => serverModule.createServerContext(withTestSurfaceObserver(opts)),
  };
}

function parseToolResult(result: any) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

const LEAD_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * A fresh Claude pane whose composer repaints late: the typed boot draft is
 * invisible for the pre-Return observation window (so spawn never presses
 * Return), then renders exactly once `rendered` flips.
 */
function makeSlowComposerPane() {
  const state = { composer: "", rendered: false, submitted: [] as string[] };
  const screen = () => {
    const visible = state.rendered ? state.composer : "";
    return state.submitted.length > 0
      ? ["Claude Code", ...state.submitted.map((t) => `⏺ ${t}`), "✻ Working… (esc to interrupt)", `❯ ${visible}`].join("\n")
      : ["Claude Code", "What can I help you with?", `❯ ${visible}`].join("\n");
  };
  const exec: ExecFn = withFakeRightSplitTopology(vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    if (args.includes("send-key") && args.includes("return")) {
      if (state.rendered && state.composer) {
        state.submitted.push(state.composer);
        state.composer = "";
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send") && !args.includes("send-key")) {
      const text = String(args.at(-1));
      // The launcher command is echoed by the shell, not typed into Claude.
      if (!/ulimit -Sn/.test(text)) state.composer += text;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("read-screen")) {
      return { stdout: JSON.stringify({ surface: "surface:new", text: screen(), lines: 20, scrollback_used: false }), stderr: "" };
    }
    if (args.includes("list-windows")) {
      return { stdout: JSON.stringify({ windows: [{ ref: "window:1", workspace_count: 1 }] }), stderr: "" };
    }
    if (args.includes("list-workspaces")) {
      return { stdout: JSON.stringify({ workspaces: [{ ref: "workspace:1", title: "Main", index: 0, selected: true, pinned: false }] }), stderr: "" };
    }
    if (args.includes("list-panes")) {
      return { stdout: JSON.stringify({ workspace_ref: "workspace:1", window_ref: "window:1", panes: [{ ref: "pane:1", index: 0, focused: true, surface_count: 3, surface_refs: ["surface:lead", "surface:other", "surface:new"], surface_ids: [LEAD_UUID, OTHER_UUID, NEW_UUID], selected_surface_ref: "surface:lead" }] }), stderr: "" };
    }
    if (args.includes("list-pane-surfaces")) {
      return { stdout: JSON.stringify({ workspace_ref: "workspace:1", window_ref: "window:1", pane_ref: "pane:1", surfaces: [
        { ref: "surface:lead", id: LEAD_UUID, title: "lead", type: "terminal", index: 0, selected: true },
        { ref: "surface:other", id: OTHER_UUID, title: "other", type: "terminal", index: 1, selected: false },
        { ref: "surface:new", id: NEW_UUID, title: "agent-pane", type: "terminal", index: 2, selected: false },
      ] }), stderr: "" };
    }
    return { stdout: JSON.stringify({ workspace: "workspace:1", surface: "surface:new", surface_id: NEW_UUID, pane: "pane:1", title: "", type: "terminal" }), stderr: "" };
  }));
  return { state, exec: exec as any, screen };
}

const returnPresses = (exec: any): number =>
  exec.mock.calls.filter(([, args]: [string, string[]]) =>
    args.includes("send-key") && args.includes("return")).length;

describe("#793 spawn-written boot draft belongs to the spawning caller", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-owned-boot-draft-"));
  });
  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  async function setup() {
    const { createServer, createServerContext } = await loadServerModule();
    const { runWithCallerContext } = await import("../src/caller-context.js");
    const pane = makeSlowComposerPane();
    let sessionId: string | null = null;
    const context = createServerContext({
      exec: pane.exec, stateDir: testDir, inboxBaseDir: testDir,
      disableSpawnPreflight: true,
      // Spawn learns the session id right after typing the boot draft
      // (captureSpawnSessionBestEffort) -- the real ordering on 0.4.87.
      sessionIdentityResolver: () => sessionId ? { session_id: sessionId } as any : null,
    });
    const server = createServer({ context, inboxBaseDir: testDir }) as any;
    const engine = engineForTests(server);
    const lead = {
      agent_id: "lead-seat", surface_id: "surface:lead", surface_uuid: LEAD_UUID,
      role: "orchestrator", cli: "claude", state: "working", repo: "brainlayer",
      model: "opus", version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as any;
    engine.stateMgr.writeState(lead); engine.getRegistry().set(lead.agent_id, lead);
    const other = { ...lead, agent_id: "other-seat", surface_id: "surface:other", surface_uuid: OTHER_UUID };
    engine.stateMgr.writeState(other); engine.getRegistry().set(other.agent_id, other);
    const as = <T>(uuid: string | undefined, fn: () => Promise<T>) =>
      runWithCallerContext(uuid ? { surfaceId: uuid, workspaceId: "workspace:1" } : undefined, fn);
    const spawn = (uuid: string | undefined) => as(uuid, async () => parseToolResult(
      await server._registeredTools.spawn_agent.handler({
        repo: "brainlayer", model: "sonnet", cli: "claude", workspace: "workspace:1",
        prompt: "Read and follow /tmp/reviewer-brief.md", boot_prompt_timeout_ms: 2_000,
      }, {})));
    const keyReturn = (uuid: string | undefined, surface: string) => as(uuid, async () => parseToolResult(
      await server._registeredTools.send_to.handler({ mode: "key", surface, text: "return" }, {})));
    return { pane, context, engine, spawn, keyReturn, setSession: (id: string) => { sessionId = id; } };
  }

  it("accepts the advised key-Return from the spawning caller and settles the boot", async () => {
    const t = await setup();
    try {
      t.setSession("11111111-2222-4333-8444-555555555555");
      const spawned = await t.spawn(LEAD_UUID);
      expect(spawned.spawn_state, JSON.stringify(spawned)).toBe("boot_unsubmitted");
      expect(spawned.boot_prompt_receipt).toMatchObject({ typed: true, submit_dispatched: false });
      expect(t.pane.state.submitted).toHaveLength(0);
      expect(spawned.next_action).toContain('send_to({mode:"key"');
      const surface = spawned.next_action.match(/surface:"([^"]+)"/)?.[1];
      expect(surface).toBe(spawned.surface_id);

      // The draft finishes rendering: exactly the text spawn typed.
      t.pane.state.rendered = true;
      expect(t.pane.state.composer).toContain("Read and follow /tmp/reviewer-brief.md");

      const recovered = await t.keyReturn(LEAD_UUID, surface);
      expect(recovered.error_code, JSON.stringify(recovered)).toBeUndefined();
      expect(recovered).toMatchObject({ ok: true, submit_verified: true });
      expect(t.pane.state.submitted).toHaveLength(1);
      expect(t.pane.state.submitted[0]).toContain("Read and follow /tmp/reviewer-brief.md");
      // Settled, or the sweep later errors it as "pending-input timeout".
      expect(t.engine.stateMgr.readState(spawned.agent_id)).toMatchObject({
        boot_prompt_pending: false, prompt_delivered: true, submit_verified: true,
      });
    } finally { t.context.dispose(); }
  }, 30_000);

  it("still refuses the same boot draft to a different caller (#802/#636 protection)", async () => {
    const t = await setup();
    try {
      const spawned = await t.spawn(LEAD_UUID);
      expect(spawned.spawn_state).toBe("boot_unsubmitted");
      t.pane.state.rendered = true;
      const presses = returnPresses(t.pane.exec);
      const foreign = await t.keyReturn(OTHER_UUID, spawned.surface_id);
      expect(foreign.error_code).toBe("blocked_by_foreign_draft");
      expect(returnPresses(t.pane.exec)).toBe(presses);
      expect(t.pane.state.submitted).toHaveLength(0);
      expect(t.engine.stateMgr.readState(spawned.agent_id)).toMatchObject({ prompt_delivered: false });
    } finally { t.context.dispose(); }
  }, 30_000);

  // #879 r1 (w63): the null->X tolerance must pin X. A later X->Y session
  // change is a restarted harness, and #636 revokes ownership for it.
  it("refuses the key-Return after the session changes X->Y once spawn learned X", async () => {
    const t = await setup();
    try {
      t.setSession("11111111-2222-4333-8444-555555555555");
      const spawned = await t.spawn(LEAD_UUID);
      expect(spawned.next_action).toContain('send_to({mode:"key"');
      const changed = t.engine.stateMgr.updateRecord(spawned.agent_id, {
        cli_session_id: "99999999-8888-4777-8666-555555555555",
      } as any);
      t.engine.getRegistry().set(changed.agent_id, changed);
      t.pane.state.rendered = true;
      const refused = await t.keyReturn(LEAD_UUID, spawned.surface_id);
      expect(refused.error_code).toBe("blocked_by_foreign_draft");
      expect(t.pane.state.submitted).toHaveLength(0);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("refuses the key-Return when a newer boot instance replaced the one that typed the draft", async () => {
    const t = await setup();
    try {
      t.setSession("11111111-2222-4333-8444-555555555555");
      const spawned = await t.spawn(LEAD_UUID);
      expect(spawned.next_action).toContain('send_to({mode:"key"');
      const reboot = t.engine.stateMgr.updateRecord(spawned.agent_id, {
        boot_instance_id: "22222222-3333-4444-8555-666666666666",
      } as any);
      t.engine.getRegistry().set(reboot.agent_id, reboot);
      t.pane.state.rendered = true;
      const refused = await t.keyReturn(LEAD_UUID, spawned.surface_id);
      expect(refused.error_code).toBe("blocked_by_foreign_draft");
      expect(t.pane.state.submitted).toHaveLength(0);
      expect(t.engine.stateMgr.readState(spawned.agent_id)).toMatchObject({ prompt_delivered: false });
    } finally { t.context.dispose(); }
  }, 30_000);

  it("does not advise a key-Return the guard would refuse when the caller is unattributable", async () => {
    const t = await setup();
    try {
      const spawned = await t.spawn(undefined);
      expect(spawned.spawn_state).toBe("boot_unsubmitted");
      expect(spawned.next_action).not.toContain('mode:"key"');
      t.pane.state.rendered = true;
      const refused = await t.keyReturn(undefined, spawned.surface_id);
      expect(refused.ok).toBe(false);
      expect(t.pane.state.submitted).toHaveLength(0);
    } finally { t.context.dispose(); }
  }, 30_000);
});
