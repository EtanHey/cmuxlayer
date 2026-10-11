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
  const state = {
    composer: "", rendered: false, submitted: [] as string[],
    wrapped: false, damagedFooter: false, quota: false, acceptReturn: true,
    buffer: "",
    /** Test hook: observes every pane call before the fake answers it. */
    onExec: undefined as undefined | ((args: string[]) => void),
  };
  const screen = () => {
    let visible = state.rendered ? state.composer : "";
    if (state.wrapped && visible) {
      const rows = [""];
      for (const word of visible.split(" ")) {
        const last = rows.length - 1;
        if (rows[last] && rows[last].length + word.length + 1 > 105) rows.push(word);
        else rows[last] += (rows[last] ? " " : "") + word;
      }
      visible = rows.join("\n  ");
    }
    const quota = state.quota ? ["  ⎿  You've hit your weekly limit · resets Oct 11 at 5am (Asia/Jerusalem)",
      "     /usage-credits to finish what you’re working on."] : [];
    const footer = state.damagedFooter ? ["", "─".repeat(30) + "���" + "─".repeat(61), "  ⎇ main | 🔧 9"] : [];
    return state.submitted.length > 0
      ? ["Claude Code", ...state.submitted.map((t) => `⏺ ${t}`), "✻ Working… (esc to interrupt)", ...quota, `❯ ${visible}`, ...footer].join("\n")
      : ["Claude Code", "What can I help you with?", ...quota, `❯ ${visible}`, ...footer].join("\n");
  };
  const exec: ExecFn = withFakeRightSplitTopology(vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    state.onExec?.(args);
    if (args.includes("set-buffer")) { state.buffer = String(args.at(-1)); return { stdout: "{}", stderr: "" }; }
    if (args.includes("paste-buffer")) { state.composer += state.buffer; return { stdout: "{}", stderr: "" }; }
    if (args.includes("send-key") && args.includes("return")) {
      if (state.acceptReturn && state.rendered && state.composer) {
        state.submitted.push(state.composer);
        state.composer = "";
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send") && !args.includes("send-key")) {
      const text = String(args.at(-1));
      // The launcher command is echoed by the shell, not typed into Claude.
      if (!/^brainlayerClaude(?: |$)/.test(text)) state.composer += text;
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
    let now = Date.parse("2026-10-11T01:59:00Z");
    const context = createServerContext({
      exec: pane.exec, stateDir: testDir, inboxBaseDir: testDir,
      disableSpawnPreflight: true,
      deliveryNow: () => now,
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
    const spawn = (uuid: string | undefined, prompt = "Read and follow /tmp/reviewer-brief.md") => as(uuid, async () => parseToolResult(
      await server._registeredTools.spawn_agent.handler({ verbose: true,
        repo: "brainlayer", model: "sonnet", cli: "claude", workspace: "workspace:1",
        prompt, boot_prompt_timeout_ms: 2_000,
      }, {})));
    const key = (uuid: string | undefined, surface: string, text: string) => as(uuid, async () => parseToolResult(
      await server._registeredTools.send_to.handler({ mode: "key", surface, text }, {})));
    const keyReturn = (uuid: string | undefined, surface: string) => key(uuid, surface, "return");
    const send = (text: string, press_enter = false, allow_long_inline = false) => as(LEAD_UUID, async () => {
      if (!engine.getRegistry().get("target-seat")) {
        const target = { ...lead, agent_id: "target-seat", surface_id: "surface:new", surface_uuid: NEW_UUID, cli_session_id: "target-session" };
        engine.stateMgr.writeState(target); engine.getRegistry().set(target.agent_id, target);
      }
      return parseToolResult(await server._registeredTools.send_to.handler({ agent_id: "target-seat", text, press_enter, allow_long_inline, verbose: true }, {}));
    });
    const sendSurface = (text: string) => as(LEAD_UUID, async () => parseToolResult(
      await server._registeredTools.send_to.handler({ mode: "surface", surface: "surface:new", text, press_enter: true, allow_long_inline: true, verbose: true }, {})));
    return { pane, context, engine, spawn, key, keyReturn, send, sendSurface,
      setNow: (value: string) => { now = Date.parse(value); }, setSession: (id: string) => { sessionId = id; } };
  }

  it("R1 B1 recovers same-owned input after the displayed reset while the refusal stays visible", async () => {
    const t = await setup();
    try {
      t.pane.state.rendered = true;
      const typed = await t.send("Preserve these exact words");
      t.pane.state.quota = true;
      const blocked = await t.keyReturn(LEAD_UUID, "surface:new");
      expect(blocked.error_code).toBe("blocked_by_usage_limit");
      expect(returnPresses(t.pane.exec)).toBe(0);
      t.setNow("2026-10-11T02:51:22.802Z");
      const submitted = await t.keyReturn(LEAD_UUID, "surface:new");
      expect(submitted).toMatchObject({ ok: true, submit_verified: true, delivery_id: typed.delivery_id });
      expect(t.pane.state.quota).toBe(true);
      expect(t.pane.state.submitted).toEqual(["Preserve these exact words"]);
      await t.keyReturn(LEAD_UUID, "surface:new");
      expect(returnPresses(t.pane.exec)).toBe(1);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("R1 B1 submits fresh text after reset with the old refusal visible", async () => {
    const t = await setup();
    try {
      t.setNow("2026-10-11T02:51:22.802Z");
      t.pane.state.rendered = true; t.pane.state.quota = true;
      expect(await t.send("A fresh authorized task", true)).toMatchObject({ ok: true, submit_verified: true });
      expect(t.pane.state.submitted).toEqual(["A fresh authorized task"]);
    } finally { t.context.dispose(); }
  }, 30_000);

  it.each(["escape", "up", "tab"])("R1 B2 dispatches non-submit key %s once under current quota", async text => {
    const t = await setup();
    try {
      t.pane.state.rendered = true; t.pane.state.quota = true;
      const result = await t.key(LEAD_UUID, "surface:new", text);
      expect(result).toMatchObject({ ok: true, key_dispatched: true, submit_attempted: false });
      expect(t.pane.exec.mock.calls.filter(([, args]: [string, string[]]) => args.includes("send-key") && args.includes(text))).toHaveLength(1);
    } finally { t.context.dispose(); }
  }, 30_000);

  it.each(["/usage", "/usage-credits", "/rate-limit-options"])("R1 B1 permits exact %s navigation under quota without admitting a foreign draft", async command => {
    const t = await setup();
    try {
      t.pane.state.rendered = true; t.pane.state.quota = true;
      expect(await t.send(command, true)).toMatchObject({ ok: true, submit_verified: true });
      expect(t.pane.state.submitted).toEqual([command]);
      t.pane.state.composer = "human draft";
      const before = returnPresses(t.pane.exec);
      expect((await t.send(command, true)).ok).toBe(false);
      expect(t.pane.state.composer).toBe("human draft");
      expect(returnPresses(t.pane.exec)).toBe(before);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("R1 B1 quota navigation key recovery still requires the original caller and delivery", async () => {
    const t = await setup();
    try {
      t.pane.state.rendered = true; t.pane.state.quota = true;
      // /usage collides with the retained /usage-credits advice in the
      // existing conservative transcript-accepted guard. Keep that guard;
      // use navigation absent from the transcript to prove caller binding.
      const typed = await t.send("/rate-limit-options");
      expect(typed.typed, JSON.stringify(typed)).toBe(true);
      expect((await t.keyReturn(OTHER_UUID, "surface:new")).ok).toBe(false);
      expect(returnPresses(t.pane.exec)).toBe(0);
      const recovered = await t.keyReturn(LEAD_UUID, "surface:new");
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, submit_verified: true, delivery_id: typed.delivery_id });
      expect(t.pane.state.submitted).toEqual(["/rate-limit-options"]);
    } finally { t.context.dispose(); }
  }, 30_000);

  it.each(["surface", "agent"])("R1 N1 %s preserves a dispatched UTF-8 prefix without claiming full ownership or recovery", async mode => {
    const t = await setup();
    try {
      t.pane.state.rendered = true;
      // Register the managed target without putting any text in its composer.
      await t.send("");
      const text = "é ".repeat(6000); //18000bytes, two native paste batches.
      t.pane.state.onExec = args => { if (args.includes("paste-buffer")) t.pane.state.quota = true; };
      const deliver = () => mode === "surface" ? t.sendSurface(text) : t.send(text, true, true);
      const sent = await deliver();
      const actualBytes = Buffer.byteLength(t.pane.state.composer, "utf8");
      expect(actualBytes).toBeGreaterThan(0); expect(actualBytes).toBeLessThan(Buffer.byteLength(text, "utf8"));
      expect(sent).toMatchObject({ ok: false, bytes: actualBytes, draft_complete: false, owned_draft_recovery: false, delivery_state: "pending_verify" });
      expect(sent.WARNING).toContain("incomplete prefix");
      expect(returnPresses(t.pane.exec)).toBe(0);
      t.setNow("2026-10-11T02:51:22.802Z");
      const before = t.pane.state.composer;
      expect((await t.keyReturn(LEAD_UUID, "surface:new")).ok).toBe(false);
      expect((await deliver()).ok).toBe(false);
      expect(t.pane.state.composer).toBe(before);
      expect(returnPresses(t.pane.exec)).toBe(0);
      // Explicit operator disposition is observable as empty input; it does
      // not authorize automatic continuation or whole-message replay.
      t.pane.state.composer = "";
      expect(await t.send("A new task after manual disposition", true)).toMatchObject({ ok: true, submit_verified: true });
    } finally { t.context.dispose(); }
  }, 30_000);

  it("P0 recovers the spawn-written Claude whole-word path wrap under its original delivery ID", async () => {
    const t = await setup();
    try {
      const spawned = await t.spawn(LEAD_UUID, "Read and follow /Users/fixture/Gits/orchestrator/docs.local/handoffs/2026-10-11/reviewer-owned-draft-audit-packet.md");
      expect(spawned.spawn_state).toBe("boot_unsubmitted");
      const id = spawned.boot_prompt_receipt.delivery_id;
      expect(id).toEqual(expect.any(String));
      t.pane.state.rendered = true; t.pane.state.wrapped = true;
      const recovered = await t.keyReturn(LEAD_UUID, spawned.surface_id);
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, submit_verified: true, delivery_id: id });
      expect(t.pane.state.submitted).toHaveLength(1);
      const presses = returnPresses(t.pane.exec);
      const repeated = await t.keyReturn(LEAD_UUID, spawned.surface_id);
      expect(repeated.ok).toBe(false);
      expect(returnPresses(t.pane.exec)).toBe(presses);
    } finally { t.context.dispose(); }
  }, 30_000);

  const wrappedMessage = "Review the followup plan and preserve every original word. Read and follow /Users/fixture/Gits/coach/docs.local/collabs/2026-10-11-jrc-study-sync.md";
  it("P0 recovers an uncertain send with Claude path wraps and damaged footer without retyping", async () => {
    const t = await setup();
    try {
      t.pane.state.rendered = true; t.pane.state.acceptReturn = false;
      const sent = await t.send(wrappedMessage, true);
      expect(sent, JSON.stringify(sent)).toMatchObject({ typed: true, submit_verified: null });
      const id = sent.delivery_id;
      t.pane.state.wrapped = true; t.pane.state.damagedFooter = true; t.pane.state.acceptReturn = true;
      const recovered = await t.keyReturn(LEAD_UUID, "surface:new");
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, submit_verified: true, delivery_id: id });
      expect(t.pane.state.submitted).toEqual([wrappedMessage]);
      expect(t.engine.getDeliveryReceipt(id)).toMatchObject({ delivery_id: id, delivery_state: "submitted", submit_verified: true });
      expect(t.pane.exec.mock.calls.filter(([, args]: [string, string[]]) => args.includes("send") && !args.includes("send-key"))).toHaveLength(1);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("P0 refuses an observed Claude quota before typing", async () => {
    const t = await setup();
    try {
      t.pane.state.rendered = true; t.pane.state.quota = true;
      const sent = await t.send("Review the next task", true);
      expect(sent, JSON.stringify(sent)).toMatchObject({ ok: false, error_code: "blocked_by_usage_limit", typed: false });
      expect(t.pane.state.composer).toBe("");
      expect(returnPresses(t.pane.exec)).toBe(0);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("P0 retains a typed delivery when quota appears before Return and recovers only after it clears", async () => {
    const t = await setup();
    try {
      t.pane.state.rendered = true;
      t.pane.state.onExec = args => {
        if (args.includes("send") && !args.includes("send-key")) t.pane.state.quota = true;
      };
      const sent = await t.send(wrappedMessage, true);
      expect(sent, JSON.stringify(sent)).toMatchObject({ ok: false, typed: true, delivery_state: "pending_verify", submit_dispatched: false });
      expect(t.pane.state.composer).toBe(wrappedMessage);
      expect(returnPresses(t.pane.exec)).toBe(0);
      const refused = await t.keyReturn(LEAD_UUID, "surface:new");
      expect(refused.error_code).toBe("blocked_by_usage_limit");
      expect(returnPresses(t.pane.exec)).toBe(0);
      t.pane.state.quota = false; t.pane.state.wrapped = true;
      const recovered = await t.keyReturn(LEAD_UUID, "surface:new");
      expect(recovered).toMatchObject({ ok: true, submit_verified: true, delivery_id: sent.delivery_id });
      expect(t.pane.state.submitted).toEqual([wrappedMessage]);
      expect(t.engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({ delivery_state: "submitted", submit_verified: true });
    } finally { t.context.dispose(); }
  }, 30_000);

  it("P0 refuses quota appearing on the final owned-key observation", async () => {
    const t = await setup();
    try {
      t.pane.state.rendered = true;
      await t.send(wrappedMessage);
      let reads = 0;
      t.pane.state.onExec = args => {
        if (args.includes("read-screen") && ++reads === 2) t.pane.state.quota = true;
      };
      const refused = await t.keyReturn(LEAD_UUID, "surface:new");
      expect(refused.error_code).toBe("blocked_by_usage_limit");
      expect(returnPresses(t.pane.exec)).toBe(0);
      expect(t.pane.state.composer).toBe(wrappedMessage);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("P0 preserves boot ownership when quota appears after the boot text lands", async () => {
    const t = await setup();
    try {
      t.setSession("11111111-2222-4333-8444-555555555555");
      t.pane.state.rendered = true;
      t.pane.state.onExec = args => {
        if (args.includes("send") && String(args.at(-1)).startsWith("Read and follow")) t.pane.state.quota = true;
      };
      const spawned = await t.spawn(LEAD_UUID);
      expect(spawned.spawn_state).toBe("boot_unsubmitted");
      expect(spawned.boot_prompt_receipt).toMatchObject({ typed: true, submit_dispatched: false, delivery_state: "pending_verify" });
      const refused = await t.keyReturn(LEAD_UUID, spawned.surface_id);
      expect(refused.error_code).toBe("blocked_by_usage_limit");
      t.pane.state.quota = false;
      const recovered = await t.keyReturn(LEAD_UUID, spawned.surface_id);
      expect(recovered).toMatchObject({ ok: true, submit_verified: true, delivery_id: spawned.boot_prompt_receipt.delivery_id });
    } finally { t.context.dispose(); }
  }, 30_000);

  it.each(["other caller", "edited", "new session", "new surface"])("P0 refuses wrapped recovery after %s", async kind => {
    const t = await setup();
    try {
      t.pane.state.rendered = true;
      await t.send(wrappedMessage);
      t.pane.state.wrapped = true;
      if (kind === "edited") t.pane.state.composer += " changed";
      if (kind === "new session") {
        const changed = t.engine.stateMgr.updateRecord("target-seat", { cli_session_id: "replacement-session" });
        t.engine.getRegistry().set(changed.agent_id, changed);
      }
      if (kind === "new surface") {
        const changed = t.engine.stateMgr.updateRecord("target-seat", { surface_uuid: OTHER_UUID });
        t.engine.getRegistry().set(changed.agent_id, changed);
      }
      const presses = returnPresses(t.pane.exec);
      const refused = await t.keyReturn(kind === "other caller" ? OTHER_UUID : LEAD_UUID, "surface:new");
      expect(refused.ok).toBe(false);
      expect(returnPresses(t.pane.exec)).toBe(presses);
    } finally { t.context.dispose(); }
  }, 30_000);

  it.each([false, true])("accepts the advised key-Return and settles the boot after retyping=%s", async retype => {
    const t = await setup();
    try {
      t.setSession("11111111-2222-4333-8444-555555555555");
      const spawned = await t.spawn(LEAD_UUID);
      expect(spawned.spawn_state, JSON.stringify(spawned)).toBe("boot_unsubmitted");
      expect(spawned.boot_prompt_receipt).toMatchObject({ typed: true, submit_dispatched: false });
      expect(t.engine.listDeliveryReceipts().filter(receipt =>
        receipt.boot_recovery && receipt.agent_id === spawned.agent_id)).toHaveLength(0);
      expect(t.pane.state.submitted).toHaveLength(0);
      expect(spawned.next_action).toContain('send_to({mode:"key"');
      const surface = spawned.next_action.match(/surface:"([^"]+)"/)?.[1];
      expect(surface).toBe(spawned.surface_id);

      if (retype) {
        const { runWithCallerContext } = await import("../src/caller-context.js");
        const deliver = t.context.lifecycleAgentInputDeliverer;
        if (!deliver) throw new Error("lifecycle relay was not initialized");
        const previousText = t.pane.state.composer;
        await runWithCallerContext({ surfaceId: LEAD_UUID, workspaceId: "workspace:1" }, async () =>
          deliver({ agent_id: spawned.agent_id, text: t.pane.state.composer, press_enter: false, source_event: "send_input", allow_busy: true }));
        expect(t.pane.state.composer).toBe(previousText + previousText);
        expect([...t.context.typedDraftOwners.values()][0]).toMatchObject({ bootAgentId: spawned.agent_id, bootInstanceId: t.engine.stateMgr.readState(spawned.agent_id)?.boot_instance_id });
      }

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

  it.each([false, true])("a newer boot cannot inherit the draft settlement after retyping=%s", async retype => {
    const t = await setup();
    try {
      t.setSession("11111111-2222-4333-8444-555555555555");
      const spawned = await t.spawn(LEAD_UUID);
      expect(spawned.next_action).toContain('send_to({mode:"key"');
      const reboot = t.engine.stateMgr.updateRecord(spawned.agent_id, {
        boot_instance_id: "22222222-3333-4444-8555-666666666666",
      } as any);
      t.engine.getRegistry().set(reboot.agent_id, reboot);
      if (retype) {
        const { runWithCallerContext } = await import("../src/caller-context.js");
        const deliver = t.context.lifecycleAgentInputDeliverer;
        if (!deliver) throw new Error("lifecycle relay was not initialized");
        await runWithCallerContext({ surfaceId: LEAD_UUID, workspaceId: "workspace:1" }, () =>
          deliver({ agent_id: spawned.agent_id, text: t.pane.state.composer, press_enter: false, source_event: "send_input", allow_busy: true }));
        expect([...t.context.typedDraftOwners.values()][0]).toMatchObject({ bootAgentId: spawned.agent_id });
        expect([...t.context.typedDraftOwners.values()][0].bootInstanceId).not.toBe(reboot.boot_instance_id);
      }
      t.pane.state.rendered = true;
      const refused = await t.keyReturn(LEAD_UUID, spawned.surface_id);
      expect(refused.error_code).toBe("blocked_by_foreign_draft");
      expect(t.pane.state.submitted).toHaveLength(0);
      expect(t.engine.stateMgr.readState(spawned.agent_id)).toMatchObject({ prompt_delivered: false });
    } finally { t.context.dispose(); }
  }, 30_000);

  // #879 Macroscope (HIGH, on 2a8d73a): the instance was checked only at the
  // pre-Return read. A replacement boot installed after that check -- here,
  // while the route is re-validated just before Return -- must still refuse.
  it("refuses before mutation when a newer boot lands between the ownership check and the Return", async () => {
    const t = await setup();
    try {
      t.setSession("11111111-2222-4333-8444-555555555555");
      const spawned = await t.spawn(LEAD_UUID);
      expect(spawned.next_action).toContain('send_to({mode:"key"');
      t.pane.state.rendered = true;
      let baselineRead = false;
      let swapped = false;
      t.pane.state.onExec = (args) => {
        if (args.includes("read-screen")) baselineRead = true;
        else if (baselineRead && !swapped && args.includes("list-panes")) {
          swapped = true;
          const reboot = t.engine.stateMgr.updateRecord(spawned.agent_id, {
            boot_instance_id: "33333333-4444-4555-8666-777777777777",
          } as any);
          t.engine.getRegistry().set(reboot.agent_id, reboot);
        }
      };
      const pressesBefore = returnPresses(t.pane.exec);
      const refused = await t.keyReturn(LEAD_UUID, spawned.surface_id);
      expect(swapped).toBe(true);
      expect(refused.ok, JSON.stringify(refused)).toBe(false);
      expect(refused.error_code).toBe("boot_instance_changed");
      expect(returnPresses(t.pane.exec)).toBe(pressesBefore);
      expect(t.pane.state.submitted).toHaveLength(0);
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
