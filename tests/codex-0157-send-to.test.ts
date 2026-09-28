// #905: send_to and boot receipts against a Codex 0.157 pane that behaves the
// way the scratch captures did (tests/fixtures/codex-0.157/README.md). Text
// typed and immediately followed by Return is buffered as a paste burst: the
// composer paints only its placeholder, and that Return becomes a newline. A
// Return pressed while a turn runs queues the text as a steer message.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecFn } from "../src/cmux-client.js";
import { withFakeRightSplitTopology } from "./helpers/fake-right-split-topology.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";
import { engineForTests } from "../src/server.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/codex-0.157/${name}.txt`, import.meta.url), "utf8");

const PONG = "Reply with the single word pong and nothing else.";
const LIST = "Please also list the files in this folder when you finish.";
const LONG =
  "Read and follow ~/Gits/cmuxlayer/docs.local/lanes/2026-09-27-905-opus-scratch-capture-only-do-not-act-on-this-pointer.md then reply with a one-line summary.";
const LEAD_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEW_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Frame = string | ((typed: string) => string);
type Frames = { empty: Frame; buffered: Frame; draft: Frame; after: Frame };

/** Codex renders a message as `› first` plus two-space rows; blank rows stay. */
const codexRows = (text: string): string =>
  text.split("\n").map((line, i) => (i === 0 ? `› ${line}` : line ? `  ${line}` : " ")).join("\n");
const BOOT_ROWS = "› You are a scratch capture pane for issue 905. Reply with the single word ok.\n \n  Read and follow ~/.cmux/agents/scratch-905-capture/contract.md";

/**
 * One Codex 0.157 pane. `swallow` Returns are lost even after the draft has
 * rendered (the intermittent boot variant): the next read repaints the
 * placeholder, then the draft comes back.
 */
function makeCodexPane(frames: Frames) {
  const pane = {
    frames, live: false, phase: "empty" as "empty" | "buffered" | "draft" | "after",
    bufferedReads: 0, repaint: false, swallow: 0, returns: 0, submitted: [] as string[], text: "",
  };
  const frame = (f: Frame): string => (typeof f === "string" ? f : f(pane.text));
  const read = (): string => {
    if (pane.phase === "buffered") {
      if (--pane.bufferedReads <= 0) pane.phase = "draft";
      return frame(pane.frames.buffered);
    }
    if (pane.repaint) { pane.repaint = false; return frame(pane.frames.buffered); }
    return frame(pane.frames[pane.phase]);
  };
  const listing = (args: string[]) => {
    if (args.includes("list-windows")) return { windows: [{ ref: "window:1", workspace_count: 1 }] };
    if (args.includes("list-workspaces")) return { workspaces: [{ ref: "workspace:1", title: "Main", index: 0, selected: true, pinned: false }] };
    if (args.includes("list-panes")) return { workspace_ref: "workspace:1", window_ref: "window:1", panes: [{ ref: "pane:1", index: 0, focused: true, surface_count: 3, surface_refs: ["surface:lead", "surface:other", "surface:new"], surface_ids: [LEAD_UUID, OTHER_UUID, NEW_UUID], selected_surface_ref: "surface:lead" }] };
    if (args.includes("list-pane-surfaces")) return { workspace_ref: "workspace:1", window_ref: "window:1", pane_ref: "pane:1", surfaces: [
      { ref: "surface:lead", id: LEAD_UUID, title: "lead", type: "terminal", index: 0, selected: true },
      { ref: "surface:other", id: OTHER_UUID, title: "other", type: "terminal", index: 1, selected: false },
      { ref: "surface:new", id: NEW_UUID, title: "agent-pane", type: "terminal", index: 2, selected: false },
    ] };
    return { workspace: "workspace:1", surface: "surface:new", surface_id: NEW_UUID, pane: "pane:1", title: "", type: "terminal" };
  };
  const exec: ExecFn = withFakeRightSplitTopology(vi.fn().mockImplementation(async (_cmd, args: string[]) => {
    if (args.includes("send-key") && args.includes("return") && pane.live) {
      pane.returns += 1;
      if (pane.phase === "draft" && pane.swallow > 0) { pane.swallow -= 1; pane.repaint = true; }
      else if (pane.phase === "draft") { pane.submitted.push(pane.text); pane.phase = "after"; }
      return { stdout: "{}", stderr: "" };
    }
    const typed = args.includes("send") ? String(args.at(-1)) : args.includes("set-buffer") ? String(args.at(-1)) : null;
    if (typed !== null) {
      if (pane.live && !/ulimit -Sn/.test(typed)) { pane.text = typed; pane.phase = "buffered"; pane.bufferedReads = 2; }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("read-screen")) {
      return { stdout: JSON.stringify({ surface: "surface:new", text: read(), lines: 30, scrollback_used: false }), stderr: "" };
    }
    return { stdout: JSON.stringify(listing(args)), stderr: "" };
  }));
  return { pane, exec: exec as any };
}

function parseToolResult(result: any) {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

describe("#905 send_to receipts on Codex 0.157", () => {
  let testDir = "";
  beforeEach(() => { testDir = mkdtempSync(join(tmpdir(), "cmuxlayer-905-")); });
  afterEach(() => { rmSync(testDir, { recursive: true, force: true }); vi.resetModules(); });

  async function setup(frames: Frames, bootPrompt?: string, swallow = 0) {
    vi.resetModules();
    const serverModule = await import("../src/server.js");
    const { runWithCallerContext } = await import("../src/caller-context.js");
    const { pane, exec } = makeCodexPane(bootPrompt ? frames : { ...frames, buffered: frames.empty, draft: frames.empty, after: frames.empty });
    pane.live = bootPrompt !== undefined;
    pane.swallow = swallow;
    const context = serverModule.createServerContext(withTestSurfaceObserver({
      exec, stateDir: testDir, inboxBaseDir: testDir, disableSpawnPreflight: true, sessionIdentityResolver: () => null,
    }));
    const server = serverModule.createServer({ context, inboxBaseDir: testDir }) as any;
    const engine = engineForTests(server);
    const lead = {
      agent_id: "lead-seat", surface_id: "surface:lead", surface_uuid: LEAD_UUID, role: "orchestrator", cli: "claude",
      state: "working", repo: "cmuxlayer", model: "opus", version: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as any;
    for (const seat of [lead, { ...lead, agent_id: "other-seat", surface_id: "surface:other", surface_uuid: OTHER_UUID }]) {
      engine.stateMgr.writeState(seat); engine.getRegistry().set(seat.agent_id, seat);
    }
    const spawned = parseToolResult(await runWithCallerContext({ surfaceId: LEAD_UUID, workspaceId: "workspace:1" }, async () =>
      server._registeredTools.spawn_agent.handler({
        repo: "cmuxlayer", model: "gpt-6-sol", cli: "codex", workspace: "workspace:1",
        boot_prompt_timeout_ms: bootPrompt ? 5_000 : 100, ...(bootPrompt ? { prompt: bootPrompt } : {}),
      }, {})));
    if (bootPrompt) return { pane, context, spawned };
    engine.getRegistry().set(spawned.agent_id, { ...engine.getRegistry().get(spawned.agent_id), state: "ready" });
    pane.frames = frames;
    pane.live = true;
    const as = <T>(uuid: string, fn: () => Promise<T>) =>
      runWithCallerContext({ surfaceId: uuid, workspaceId: "workspace:1" }, fn);
    const send = (text: string) => as(LEAD_UUID, async () => parseToolResult(
      await server._registeredTools.send_to.handler({ agent_id: spawned.agent_id, text, press_enter: true }, {})));
    const keyReturn = (uuid: string) => as(uuid, async () => parseToolResult(
      await server._registeredTools.send_to.handler({ mode: "key", surface: spawned.surface_id, text: "return" }, {})));
    const surfaceSend = (text: string, background: boolean) => as(LEAD_UUID, async () => parseToolResult(
      await server._registeredTools.send_to.handler(
        { mode: "surface", surface: spawned.surface_id, text, press_enter: true, background }, {})));
    return { pane, context, spawned, send, keyReturn, surfaceSend };
  }

  it("idle: reports submitted only once the message is in the transcript", async () => {
    const t = await setup({
      empty: fixture("idle-empty"), buffered: fixture("burst-return-placeholder-frame"),
      draft: fixture("idle-draft"), after: fixture("idle-submitted-working"),
    });
    try {
      t.pane.swallow = 1;
      const receipt = await t.send(PONG);
      expect(t.pane.submitted, JSON.stringify(receipt)).toEqual([PONG]);
      expect(receipt).toMatchObject({ ok: true, submitted: true, retry_count: 1 });
    } finally { t.context.dispose(); }
  }, 30_000);

  it("mid-turn: reports the steer queue honestly, never submitted", async () => {
    const t = await setup({
      empty: fixture("midturn-empty"), buffered: fixture("midturn-empty"),
      draft: fixture("midturn-draft-tab-to-queue"), after: fixture("midturn-steer-queued"),
    });
    try {
      const receipt = await t.send(LIST);
      expect(receipt, JSON.stringify(receipt)).toMatchObject({
        ok: true, submitted: false, delivery_state: "queued", queued_behind_turn: true,
      });
      expect(t.pane.submitted).toEqual([LIST]);
    } finally { t.context.dispose(); }
  }, 30_000);

  // A refused foreign Return also revokes the sender's token (#636), so each
  // caller gets its own pane.
  it.each([
    ["its sender", LEAD_UUID, [LONG]],
    ["no other caller", OTHER_UUID, []],
  ])("never reports a stuck wrapped draft as submitted; %s may Return it", async (_who, caller, submitted) => {
    const t = await setup({
      empty: fixture("idle-empty"), buffered: fixture("idle-empty"),
      draft: fixture("idle-wrapped-draft"), after: fixture("idle-submitted-working"),
    });
    try {
      t.pane.swallow = 99;
      const receipt = await t.send(LONG);
      expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true, submitted: false });
      expect(t.pane.submitted).toHaveLength(0);
      t.pane.swallow = 0;
      const returns = t.pane.returns;
      const keyed = await t.keyReturn(caller as string);
      if (caller === LEAD_UUID) {
        expect(keyed, JSON.stringify(keyed)).toMatchObject({ ok: true, submit_verified: true });
      } else {
        expect(keyed.error_code).toBe("blocked_by_foreign_draft");
        expect(t.pane.returns).toBe(returns);
      }
      expect(t.pane.submitted).toEqual(submitted);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("boot: a lost Return is retried, and only the transcript row verifies it", async () => {
    const brief = "You are a scratch capture pane for issue 905. Reply with the single word ok.";
    const t = await setup({
      empty: fixture("idle-empty"), buffered: fixture("burst-return-placeholder-frame"),
      draft: (typed) => fixture("boot-brief-padded").replace(BOOT_ROWS, codexRows(typed)),
      after: (typed) => fixture("idle-submitted-working").replace(`› ${PONG}`, codexRows(typed)),
    }, brief, 1);
    try {
      expect(fixture("boot-brief-padded")).toContain(BOOT_ROWS);
      expect(t.pane.submitted, JSON.stringify(t.spawned)).toHaveLength(1);
      expect(t.spawned.boot_prompt_receipt).toMatchObject({
        submitted: true, submit_evidence: "transcript_echo", retry_count: 1,
      });
      expect(t.pane.submitted[0]).toContain(brief);
      expect(t.spawned.spawn_state, JSON.stringify(t.spawned)).toBe("started");
    } finally { t.context.dispose(); }
  }, 30_000);
  // Round 2 (review findings 1 and 2): the reviewer's integration probes.
  it("r2: a lost Return plus a new assistant echo stays unsubmitted", async () => {
    const t = await setup({
      empty: fixture("idle-empty"), buffered: () => fixture("idle-empty").replace("› Ask", "• ok\n\n› Ask"),
      draft: () => fixture("idle-draft").replace(PONG, "ok"), after: fixture("idle-submitted-working"),
    });
    try {
      t.pane.swallow = 99;
      const receipt = await t.send("ok");
      expect(t.pane.submitted).toEqual([]);
      expect(receipt.submitted, JSON.stringify(receipt)).toBe(false);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("r2: an inline-space edit to the sender's draft revokes its Return", async () => {
    const own = "review foo bar";
    const t = await setup({
      empty: fixture("idle-empty"), buffered: fixture("idle-empty"),
      draft: () => fixture("idle-draft").replace(PONG, own), after: fixture("idle-submitted-working"),
    });
    try {
      t.pane.swallow = 99;
      await t.send(own);
      t.pane.frames.draft = fixture("idle-draft").replace(PONG, "review foobar");
      t.pane.text = "review foobar";
      t.pane.swallow = 0;
      const before = t.pane.returns;
      const receipt = await t.keyReturn(LEAD_UUID);
      expect(receipt.error_code, JSON.stringify(receipt)).toBe("blocked_by_foreign_draft");
      expect(t.pane.returns).toBe(before);
    } finally { t.context.dispose(); }
  }, 30_000);

  // #917 (review of #913): the reviewer's probes. Whitespace-only foreign
  // edits are foreign; one Return must not submit them under our token.
  it.each([
    ["review foo bar", "review  foo bar", "review  foo bar"],
    ["prefixsuffix", "prefix\n  suffix", "prefix suffix"],
  ])("#917: an edit from %j to %j revokes the sender's Return", async (own, visible, actual) => {
    const t = await setup({
      empty: fixture("idle-empty"), buffered: fixture("idle-empty"),
      draft: () => fixture("idle-draft").replace(PONG, own), after: fixture("idle-submitted-working"),
    });
    try {
      t.pane.swallow = 99;
      await t.send(own);
      t.pane.frames.draft = fixture("idle-draft").replace(PONG, visible);
      t.pane.text = actual;
      t.pane.swallow = 0;
      const before = t.pane.returns;
      const receipt = await t.keyReturn(LEAD_UUID);
      expect(receipt.error_code, JSON.stringify(receipt)).toBe("blocked_by_foreign_draft");
      expect(t.pane.returns).toBe(before);
      expect(t.pane.submitted).toEqual([]);
    } finally { t.context.dispose(); }
  }, 30_000);

  // #917: a repeated message is proven by its position below the pre-type
  // transcript, not by the count of matching rows rising.
  const withBody = (body: string) => fixture("idle-empty").replace("› Ask", `${body}\n\n› Ask`);
  const headerless = (body: string) => withBody(body).replace(/^[\s\S]*?Tip: [^\n]*\n/, "");
  it.each([
    // The reviewer's probe: the old exchange is gone and the new row stands above an empty composer.
    ["the old response is gone", withBody("› again\n\n• old response"), withBody("› again\n\n• new response")],
    // Scrolled: the header and the first `again` left the window; the rest moved up.
    [
      "the first row scrolled out",
      withBody("› again\n\n• old response\n\n  14:06\n\n› status?\n\n• all green"),
      headerless("  14:06\n\n› status?\n\n• all green\n\n› again\n\n• new response"),
    ],
  ])("#917: sending an identical message again verifies when %s", async (_why, before, after) => {
    const t = await setup({
      empty: before, buffered: before,
      draft: () => fixture("idle-draft").replace(PONG, "again"), after,
    });
    try {
      const receipt = await t.send("again");
      expect(t.pane.submitted).toEqual(["again"]);
      expect(receipt, JSON.stringify(receipt)).toMatchObject({ submitted: true });
      expect(t.pane.returns).toBe(1);
    } finally { t.context.dispose(); }
  }, 30_000);

  it("#917: an unchanged stale identical row never verifies", async () => {
    const stale = fixture("idle-empty").replace("› Ask", "› ok\n\n• old response\n\n› Ask");
    const t = await setup({
      empty: stale, buffered: stale,
      draft: () => fixture("idle-draft").replace(PONG, "ok"), after: fixture("idle-submitted-working"),
    });
    try {
      t.pane.swallow = 99;
      const receipt = await t.send("ok");
      expect(t.pane.submitted).toEqual([]);
      expect(receipt.submitted, JSON.stringify(receipt)).toBe(false);
    } finally { t.context.dispose(); }
  }, 30_000);

  // Round 2 (review finding 6): surface-mode and background sends observe the
  // payload before Return too, so one Return lands after the burst.
  it.each([false, true])("r2: a surface-mode send (background=%s) waits for the payload before Return", async (background) => {
    const t = await setup({
      empty: fixture("idle-empty"), buffered: fixture("burst-return-placeholder-frame"),
      draft: fixture("idle-draft"), after: fixture("idle-submitted-working"),
    });
    try {
      const receipt = await t.surfaceSend(PONG, background);
      expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
      await vi.waitFor(() => expect(t.pane.submitted).toEqual([PONG]), { timeout: 10_000 });
      expect(t.pane.returns).toBe(1);
    } finally { t.context.dispose(); }
  }, 30_000);
});
