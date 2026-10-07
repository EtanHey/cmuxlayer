// Deterministic fake CLI behind the real SDK/MCP tool protocol. No model calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createServerContext, engineForTests } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { ExecFn } from "../src/cmux-client.js";
import { runWithCallerContext } from "../src/caller-context.js";
import { withFakeRightSplitTopology } from "./helpers/fake-right-split-topology.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";

const LEAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const brief = "Read and follow /tmp/synthetic-brief.md";
type Payload = Record<string, unknown>;
type Boot = Payload & { agent_id: string; surface_id: string; contract_path: string;
  boot_prompt_receipt: { delivery_id: string; submit_dispatched: boolean } };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup(hidden = false, wrapped = false, cli: "codex" | "claude" = "codex") {
  const root = mkdtempSync(join(tmpdir(), "spawn-contract-once-"));
  const pane = { draft: "", submitted: [] as string[], inputs: [] as string[],
    returns: 0, returnInvocations: 0, hidden, created: false, paste: "", initializing: 2, caller: LEAD, baselineRead: false, lostAck: false, onReturn: undefined as (() => void | Promise<void>) | undefined, onRead: undefined as (() => void | Promise<void>) | undefined, overlay: "", beforeReturn: undefined as (() => void) | undefined };
  const render = (text: string) => wrapped ? text.match(/.{1,96}/g)?.join("\n  ") ?? "" : text;
  const frame = () => [cli === "claude" ? "Claude Code" : "OpenAI Codex (v0.157.0)",
    ...pane.submitted.map(text => `${cli === "claude" ? "⏺" : "›"} ${render(text)}`),
    ...(pane.submitted.length ? [cli === "claude" ? "✻ Working… (esc to interrupt)" : "Working (1s • esc to interrupt)"] : []),
    `${cli === "claude" ? "❯" : "›"} ${pane.hidden ? "" : render(pane.draft)}`,
    "  GPT-6.1-Sol high · ~/Gits/cmuxlayer", "  ? for shortcuts · 82% left"].join("\n");
  const response = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "" });
  const typeInput = (text: string) => {
    pane.inputs.push(text);
    // A paragraph boundary consumes the task, leaving the footer drafted.
    const parts = text.split(/\n\n/);
    if (parts.length > 1) pane.submitted.push(parts.shift()!);
    pane.draft += parts.join("\n\n");
  };
  const fake: ExecFn = async (_cmd, args) => {
    if (args.includes("read-screen")) {
      if (args.includes("surface:lead") || args.includes(LEAD)) return response({ surface: "surface:lead", text: "OpenAI Codex\nWorking (1s • esc to interrupt)\n›\n  GPT-6.1-Sol high · ~/Gits/cmuxlayer", lines: 20, scrollback_used: false });
      await pane.onRead?.();
      if (pane.beforeReturn) pane.baselineRead = true;
      const text = pane.overlay || (pane.initializing-- > 0 ? "OpenAI Codex\nInitializing…\nWorking (1s • esc to interrupt)\n›\n  GPT-6.1-Sol high · ~/Gits/cmuxlayer" : frame());
      return response({ surface: "surface:new", text, lines: 20, scrollback_used: false });
    }
    if (args.includes("send-key") && args.includes("return")) {
      pane.returnInvocations++;
      await pane.onReturn?.();
      pane.returns++;
      if (!pane.hidden && pane.draft) { pane.submitted.push(pane.draft); pane.draft = ""; }
      if (pane.lostAck) { pane.lostAck = false; throw new Error("synthetic Return ACK lost"); }
      return response({});
    }
    if (args.includes("set-buffer")) { pane.paste = String(args.at(-1)); return response({}); }
    if (args.includes("paste-buffer")) { typeInput(pane.paste); pane.paste = ""; return response({}); }
    if (args.includes("send") && !args.includes("send-key")) {
      const text = String(args.at(-1));
      if (text.includes("cmuxlayer contract for") || !/(?:^|\s)brainlayer(?:Codex|Claude)(?:\s|$)/.test(text)) {
        typeInput(text);
      }
      return response({});
    }
    if (args.includes("list-windows")) return response({ windows: [{ ref: "window:1", workspace_count: 1 }] });
    if (args.includes("list-workspaces")) return response({ workspaces: [{ ref: "workspace:1", title: "Main", index: 0, selected: true }] });
    if (args.includes("list-panes")) {
      if (pane.baselineRead) pane.beforeReturn?.();
      return response({ workspace_ref: "workspace:1", window_ref: "window:1", panes: [{ ref: "pane:1", index: 0, focused: true, surface_count: pane.created ? 2 : 1, surface_refs: pane.created ? ["surface:lead", "surface:new"] : ["surface:lead"], surface_ids: pane.created ? [LEAD, CHILD] : [LEAD], selected_surface_ref: "surface:lead" }] });
    }
    if (args.includes("list-pane-surfaces")) return response({ workspace_ref: "workspace:1", pane_ref: "pane:1", surfaces: [
      { ref: "surface:lead", id: LEAD, title: "lead", type: "terminal", index: 0, selected: true },
      ...(pane.created ? [{ ref: "surface:new", id: CHILD, title: "agent-pane", type: "terminal", index: 1, selected: false }] : []),
    ] });
    if (args.includes("new-split") || args.includes("new-surface")) pane.created = true;
    return response({ workspace: "workspace:1", surface: "surface:new", surface_id: CHILD, pane: "pane:1", type: "terminal" });
  };
  const context = createServerContext(withTestSurfaceObserver({ exec: withFakeRightSplitTopology(fake), stateDir: root, inboxBaseDir: root,
    disableSpawnPreflight: true, safetyCallerContextProvider: () => ({ surfaceId: pane.caller, workspaceId: "workspace:1" }) }));
  const server = createServer({ context, inboxBaseDir: root });
  const engine = engineForTests(server);
  const lead = { agent_id: "lead-seat", surface_id: "surface:lead", surface_uuid: LEAD, workspace_id: "workspace:1",
    role: "orchestrator", cli: "codex", state: "working", repo: "brainlayer", model: "gpt-6.1-sol",
    version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() } as AgentRecord;
  engine.stateMgr.writeState(lead); engine.getRegistry().set(lead.agent_id, lead);
  const client = new Client({ name: "spawn-contract-ratchet", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  cleanups.push(async () => { await client.close(); await server.close(); context.dispose(); engine.dispose(); rmSync(root, { recursive: true, force: true }); });
  const call = async (name: string, args: Payload): Promise<Payload> => {
    const result = await runWithCallerContext({ surfaceId: pane.caller, workspaceId: "workspace:1" },
      () => client.callTool({ name, arguments: args }));
    return result.structuredContent as Payload;
  };
  const spawn = async (args: Payload = {}) => {
    const boot = await call("spawn_agent", { verbose: true, repo: "brainlayer", cli, ...(cli === "codex" ? { effort: "high" } : {}),
      model: cli === "claude" ? "sonnet" : "gpt-6.1-sol", workspace: "workspace:1", prompt: brief, boot_prompt_timeout_ms: 800, ...args }) as Boot;
    expect(boot.ok, JSON.stringify(boot)).toBe(true);
    return boot;
  };
  const key = (surface: string) => call("send_to", { mode: "key", surface, text: "return", verbose: true });
  return { pane, context, engine, call, spawn, key };
}

describe("P0 one owned spawn contract submission", () => {
  it("initialization cannot consume the task while leaving a footer draft", async () => {
    const t = await setup();
    const boot = await t.spawn();
    expect(boot.boot_prompt_receipt, JSON.stringify(boot)).toMatchObject({ submit_dispatched: true, submit_verified: true });
    const expected = `${brief} ; cmuxlayer contract for ${boot.agent_id}: Read and follow ${boot.contract_path}`;
    expect(t.pane.inputs).toEqual([expected]);
    expect(t.pane.submitted).toEqual([expected]);
    expect(t.pane.draft).toBe("");
    expect(t.pane.returns).toBe(2); // launcher + one boot Return
    expect(boot.coordination_footer_delivered).toBe(true);
    expect(readFileSync(boot.contract_path, "utf8")).toContain("## Report");
  });

  it.each([false, true])("a delayed exact folded draft is owned once and waitable (wrapped=%s)", async wrapped => {
    const t = await setup(true, wrapped);
    const boot = await t.spawn();
    expect(boot.spawn_state).toBe("boot_unsubmitted");
    expect(boot.boot_prompt_receipt).toMatchObject({ typed: true, submit_dispatched: false });
    const waited = await t.call("wait_for", { delivery_id: boot.boot_prompt_receipt.delivery_id, timeout_ms: 1 });
    expect(waited.ok, JSON.stringify(waited)).toBe(true);
    expect(waited).toMatchObject({ typed: true, submit_dispatched: false, submit_verified: null });
    const text = t.pane.draft;
    t.pane.hidden = false;
    const sent = await t.key(boot.surface_id);
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, submit_verified: true });
    expect(t.pane.submitted).toEqual([text]);
    expect(t.pane.inputs).toEqual([text]);
    expect(t.pane.returns).toBe(2);
    expect(t.engine.stateMgr.readState(boot.agent_id)).toMatchObject({ boot_prompt_pending: false, prompt_delivered: true });
    const settled = await t.call("wait_for", { delivery_id: boot.boot_prompt_receipt.delivery_id, timeout_ms: 1 });
    expect(settled).toMatchObject({ submit_dispatched: true, submit_verified: true, terminal: true });
    expect(t.pane.returns).toBe(2);
  });

  it.each(["changed", "expired", "session", "surface", "caller", "last-read-edit"])("refuses %s ownership without Return", async fault => {
    const t = await setup(true);
    const boot = await t.spawn();
    t.pane.hidden = false;
    const before = t.pane.returns;
    const owner = [...t.context.typedDraftOwners.values()][0]!;
    expect(owner, JSON.stringify(boot)).toBeDefined();
    if (fault === "changed") t.pane.draft += " user edit";
    if (fault === "expired") owner.at = Date.now() - 300_001;
    if (fault === "caller") t.pane.caller = CHILD;
    if (fault === "session" || fault === "surface") {
      const updated = t.engine.stateMgr.updateRecord(boot.agent_id, fault === "session"
        ? { cli_session_id: "11111111-2222-4333-8444-555555555555", boot_instance_id: "new-boot" }
        : { surface_uuid: LEAD });
      t.engine.getRegistry().set(updated.agent_id, updated);
    }
    if (fault === "last-read-edit") t.pane.beforeReturn = () => { t.pane.draft += " user edit"; t.pane.beforeReturn = undefined; };
    const sent = await t.key(boot.surface_id);
    expect(sent.ok, JSON.stringify(sent)).toBe(false);
    expect(t.pane.returns).toBe(before);
    expect(t.pane.submitted).toEqual([]);
    expect(await t.call("wait_for", { delivery_id: boot.boot_prompt_receipt.delivery_id, timeout_ms: 1 }))
      .toMatchObject({ terminal: true, submit_dispatched: false, delivery_state: "typed" });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: true, boot_submit_dispatched: false, prompt_delivered: false });
  });
});

// R1 reviewer fault: identical consume-then-throw transport and original-ID
// wait assertion. Explicit raw-key retry is outside this passive verifier test.
describe("R1 original boot receipt at recovery dispatch", () => {
  it("an explicit owned retry preserves the original recovery attribution", async () => {
    const t=await setup(true); const boot=await t.spawn(); const id=boot.boot_prompt_receipt.delivery_id;
    t.pane.hidden=false; t.pane.lostAck=true; t.pane.onReturn=()=>{ t.pane.hidden=true; t.pane.onReturn=undefined; };
    expect((await t.key(boot.surface_id)).ok).toBe(false); const original=t.engine.getDeliveryReceipt(id)!;
    t.context.deliveryPreTypeScreens.set(id,"later unrelated observation"); t.pane.hidden=false;
    expect((await t.key(boot.surface_id)).ok).toBe(true);
    expect(t.engine.getDeliveryReceipt(id)?.boot_recovery_context).toEqual(original.boot_recovery_context);
    expect(t.pane.inputs).toHaveLength(1); expect(t.pane.submitted).toHaveLength(1);
  });
  it("Claude lost ACK needs fresh attributable evidence on the original ID", async () => {
    const t=await setup(true,false,"claude"); const boot=await t.spawn(); t.pane.submitted.push("previous unrelated turn");
    const text=t.pane.draft; t.pane.hidden=false; t.pane.lostAck=true;
    t.pane.onReturn=()=>{ t.pane.overlay="Claude Code\n⏺ previous unrelated turn\n✻ Working… (esc to interrupt)\n❯ "; };
    expect((await t.key(boot.surface_id)).ok).toBe(false); const before=t.pane.returns; await t.engine.verifyPendingDeliveries();
    expect(await t.call("wait_for",{delivery_id:boot.boot_prompt_receipt.delivery_id,timeout_ms:1})).toMatchObject({ terminal:false, submit_verified:null });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending:true, prompt_delivered:false });
    t.pane.overlay=""; const pending=t.engine.getDeliveryReceipt(boot.boot_prompt_receipt.delivery_id)!; t.engine.resolveDelivery({...pending,verify_last_attempt_at:null}); await t.engine.verifyPendingDeliveries();
    expect(await t.call("wait_for",{delivery_id:pending.delivery_id,timeout_ms:1})).toMatchObject({ terminal:true,submit_verified:true });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending:false,prompt_delivered:true });
    expect(t.pane.inputs).toEqual([text]); expect(t.pane.submitted).toEqual(["previous unrelated turn",text]); expect(t.pane.returns).toBe(before);
  });
  it("an uncertain recovery cannot settle boot from Working without attributable evidence", async () => {
    const t=await setup(true); const boot=await t.spawn(); t.pane.hidden=false; t.pane.lostAck=true;
    t.pane.onReturn=()=>{ t.pane.overlay="OpenAI Codex (v0.157.0)\nWorking (1s • esc to interrupt)\n› \n  GPT-6.1-Sol high · ~/Gits/cmuxlayer"; };
    await t.key(boot.surface_id); const before=t.pane.returns; await t.engine.runSweep();
    expect(await t.call("wait_for",{delivery_id:boot.boot_prompt_receipt.delivery_id,timeout_ms:1})).toMatchObject({ terminal:false, submit_verified:null });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending:true, prompt_delivered:false });
    expect(t.pane.returns).toBe(before);
  });
  it("lost recovery Return ACK keeps the original receipt truthful and does not replay", async () => {
    const t=await setup(true); const boot=await t.spawn(); const text=t.pane.draft; t.pane.hidden=false; t.pane.lostAck=true;
    const sent=await t.key(boot.surface_id); expect(sent.ok).toBe(false);
    expect(t.pane.submitted).toEqual([text]); const before=t.pane.returns;
    const receipt=await t.call("wait_for",{delivery_id:boot.boot_prompt_receipt.delivery_id,timeout_ms:1});
    expect(receipt.submit_dispatched).not.toBe(false);
    expect(receipt).toMatchObject({ delivery_id: boot.boot_prompt_receipt.delivery_id, terminal: false, delivery_state: "pending_verify", submit_attempted: true, submit_verified: null });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: true, boot_submit_dispatched: true, prompt_delivered: false });
    // Persisted recovery context survives loss of the in-memory baseline.
    t.context.deliveryPreTypeScreens.delete(boot.boot_prompt_receipt.delivery_id);
    await t.engine.verifyPendingDeliveries();
    const settled=await t.call("wait_for",{delivery_id:boot.boot_prompt_receipt.delivery_id,timeout_ms:1});
    expect(settled).toMatchObject({ delivery_id: boot.boot_prompt_receipt.delivery_id, terminal: true, submit_dispatched: true, submit_verified: true, delivery_state: "submitted" });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ state: "working", boot_prompt_pending: false, prompt_delivered: true, submit_verified: true });
    expect(t.pane.returns).toBe(before); expect(t.pane.inputs).toEqual([text]);
  });

  it.each([false, true])("persists uncertainty before ACK; no evidence stays nonterminal without replay (lost=%s)", async lost => {
    const t = await setup(true); const boot = await t.spawn(); const id = boot.boot_prompt_receipt.delivery_id;
    const originalBaseline = t.context.deliveryPreTypeScreens.get(id);
    const bootBaseline = t.engine.getAgentState(boot.agent_id)!.boot_pre_type_screen;
    const text = t.pane.draft; t.pane.hidden = false; t.pane.lostAck = lost;
    t.pane.onReturn = () => {
      expect(t.engine.getDeliveryReceipt(id)).toMatchObject({ delivery_state: "pending_verify", terminal: false, press_enter: true, typed: true, submit_verified: null, text });
      expect(t.engine.getDeliveryReceipt(id)?.boot_recovery_context).toMatchObject({ caller_agent_id: "lead-seat", surface_uuid: CHILD, workspace_id: "workspace:1", cli_session_id: null, pre_type_screen: originalBaseline });
      expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: true, boot_submit_dispatched: true, prompt_delivered: false });
      t.pane.overlay = "OpenAI Codex (v0.157.0)\n› \n  GPT-6.1-Sol high · ~/Gits/cmuxlayer\n  ? for shortcuts · 82% left";
    };
    const sent = await t.key(boot.surface_id); expect(sent.ok).toBe(!lost);
    const before = t.pane.returns;
    const captured = t.engine.stateMgr.updateRecord(boot.agent_id, { cli_session_id: "11111111-2222-4333-8444-555555555555" });
    t.engine.getRegistry().set(captured.agent_id, captured);
    for (let i=0;i<2;i++) await t.engine.verifyPendingDeliveries();
    expect(t.engine.getDeliveryReceipt(id)?.boot_recovery_context?.cli_session_id).toBe(captured.cli_session_id);
    expect(await t.call("wait_for", { delivery_id: id, timeout_ms: 1 }))
      .toMatchObject({ delivery_id: id, terminal: false, delivery_state: "pending_verify", submit_verified: null, submit_attempted: true });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: true, boot_submit_dispatched: true, prompt_delivered: false });
    expect(t.context.deliveryPreTypeScreens.get(id)).toBe(originalBaseline);
    expect(t.engine.getAgentState(boot.agent_id)!.boot_pre_type_screen).toBe(bootBaseline);
    expect(t.pane.returns).toBe(before); expect(t.pane.inputs).toEqual([text]); expect(t.pane.submitted).toEqual([text]);
    t.pane.overlay = "";
    // Reset only the verifier read throttle, never the deadline or evidence.
    const pending = t.engine.getDeliveryReceipt(id)!;
    t.engine.resolveDelivery({ ...pending, verify_last_attempt_at: null });
    await t.engine.verifyPendingDeliveries();
    expect(await t.call("wait_for", { delivery_id: id, timeout_ms: 1 })).toMatchObject({ terminal: true, submit_verified: true });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: false, prompt_delivered: true });
    expect(t.pane.returns).toBe(before);
  });

  it.each(["session", "boot", "uuid"])("passive confirmation refuses replaced %s identity", async fault => {
    const t=await setup(true); const boot=await t.spawn(); t.pane.hidden=false; t.pane.lostAck=true;
    const pinned=t.engine.stateMgr.updateRecord(boot.agent_id, { cli_session_id: "99999999-8888-4777-8666-555555555555" });
    t.engine.getRegistry().set(pinned.agent_id, pinned);
    await t.key(boot.surface_id); const before=t.pane.returns;
    const record=t.engine.stateMgr.updateRecord(boot.agent_id, fault === "session" ? { cli_session_id: "11111111-2222-4333-8444-555555555555" }
      : fault === "boot" ? { boot_instance_id: "replacement" } : { surface_uuid: LEAD });
    t.engine.getRegistry().set(record.agent_id, record);
    await t.engine.verifyPendingDeliveries();
    expect(await t.call("wait_for", { delivery_id: boot.boot_prompt_receipt.delivery_id, timeout_ms: 1 })).toMatchObject({ terminal: false, submit_verified: null });
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: true, prompt_delivered: false });
    expect(t.pane.returns).toBe(before);
  });

  it.each([false, true])("refuses suffix-only contract without changing original receipt (wrapped=%s)", async wrapped => {
    const t=await setup(true, wrapped); const boot=await t.spawn();
    t.pane.draft=`cmuxlayer contract for ${boot.agent_id}: Read and follow ${boot.contract_path}`;
    t.pane.hidden=false; const before=t.pane.returns;
    expect((await t.key(boot.surface_id)).ok).toBe(false);
    expect(t.pane.returns).toBe(before); expect(t.pane.submitted).toEqual([]);
    expect(await t.call("wait_for",{delivery_id:boot.boot_prompt_receipt.delivery_id,timeout_ms:1})).toMatchObject({ terminal: true, submit_dispatched: false, delivery_state: "typed" });
  });
});

// Null capture is a conditional synthetic state, not a native incident.
describe("Post-dispatch recovery lifetime ratchet", () => {
  async function suspendedReturn() {
    const t = await setup(true);
    const boot = await t.spawn();
    const id = boot.boot_prompt_receipt.delivery_id;
    const text = t.pane.draft;
    const instance = t.engine.getAgentState(boot.agent_id)!.boot_instance_id;
    expect(instance).toBeTypeOf("string");
    t.pane.hidden = false;
    let resume!: () => void;
    let entered!: () => void;
    const suspended = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    t.pane.onReturn = async () => {
      t.pane.onReturn = undefined;
      expect(t.engine.getDeliveryReceipt(id)).toMatchObject({
        delivery_id: id, text, delivery_state: "pending_verify", terminal: false,
        submit_verified: null, boot_instance_id: instance,
      });
      entered();
      await released;
    };
    const result = t.key(boot.surface_id);
    await Promise.race([suspended, result.then(value => {
      throw new Error(`Return completed before the suspension barrier: ${JSON.stringify(value)}`);
    })]);
    return { ...t, boot, id, text, resume, result, returns: t.pane.returns };
  }

  it("stable engine and original receipt settle after the awaited Return", async () => {
    const t = await suspendedReturn();
    const original = t.engine.getDeliveryReceipt(t.id)!;
    t.resume();
    expect(await t.result).toMatchObject({ ok: true, submit_dispatched: true, submit_verified: true, submitted: true });
    expect(t.engine.getDeliveryReceipt(t.id)).toMatchObject({
      delivery_id: t.id, agent_id: original.agent_id, text: original.text,
      boot_recovery_context: original.boot_recovery_context,
      terminal: true, submit_verified: true, delivery_state: "submitted",
    });
    expect(t.engine.getAgentState(t.boot.agent_id)).toMatchObject({ boot_prompt_pending: false, prompt_delivered: true });
    expect(t.pane.returns).toBe(t.returns + 1);
    expect(t.pane.inputs).toEqual([t.text]);
  });

  const faults = ["disposed", "missing", "replacement", "receipt-replaced"] as const;
  it.each(faults.flatMap(fault => ([{ fault, during: "Return" }, { fault, during: "verification" }])))(
    "$fault during awaited $during preserves truthful completion and never replays", async ({ fault, during }) => {
      const t = await suspendedReturn();
      const original = t.engine.getDeliveryReceipt(t.id)!;
      if (during === "verification") {
        let entered!: () => void;
        const verifying = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        t.pane.onRead = async () => { t.pane.onRead = undefined; entered(); await released; };
        t.resume();
        await Promise.race([verifying, t.result.then(value => {
          throw new Error(`Return completed before verification suspension: ${JSON.stringify(value)}`);
        })]);
        t.resume = release;
      }
      let replacement: Awaited<ReturnType<typeof setup>> | undefined;
      let replacementReceipts: ReturnType<typeof t.engine.listDeliveryReceipts> | undefined;
      let writes: ReturnType<typeof vi.spyOn> | undefined;
      if (fault === "disposed") t.context.dispose();
      if (fault === "missing") {
        // Deliberately remove the real private queue entry, not a mocked lookup.
        const queue = (t.engine as unknown as { deliveryQueue: { deliveryReceipts: Map<string, unknown>; persistDeliveryReceipts(): void } }).deliveryQueue;
        expect(queue.deliveryReceipts.delete(t.id)).toBe(true);
        queue.persistDeliveryReceipts();
        expect(t.engine.getDeliveryReceipt(t.id)).toBeNull();
      }
      if (fault === "replacement") {
        replacement = await setup();
        replacement.engine.acceptPendingVerify({ ...original, agent_id: "replacement-owner", text: "replacement payload" });
        replacementReceipts = replacement.engine.listDeliveryReceipts();
        writes = vi.spyOn(replacement.engine, "acceptPendingVerify");
        t.context.lifecycleSweepEngine = replacement.engine;
      }
      if (fault === "receipt-replaced") {
        t.engine.resolveDelivery({ ...original, agent_id: "replacement-owner", text: "replacement payload" });
      }
      t.resume();
      const sent = await t.result;
      expect(sent, JSON.stringify(sent)).toMatchObject({
        ok: true, key_dispatched: true, submit_dispatched: true, submit_verified: null,
        submitted: false, delivered: false, terminal: false,
      });
      expect(sent.WARNING).toContain("NOT VERIFIED");
      expect(t.engine.getAgentState(t.boot.agent_id)).toMatchObject({
        boot_prompt_pending: true, boot_submit_dispatched: true, prompt_delivered: false,
      });
      if (fault === "disposed" || fault === "replacement") {
        expect(t.engine.getDeliveryReceipt(t.id)).toMatchObject({
          delivery_id: t.id, agent_id: original.agent_id, text: original.text,
          boot_recovery_context: original.boot_recovery_context, terminal: false,
          delivery_state: "pending_verify", submit_verified: null,
        });
      }
      if (fault === "missing") expect(t.engine.getDeliveryReceipt(t.id)).toBeNull();
      if (fault === "receipt-replaced") expect(t.engine.getDeliveryReceipt(t.id)).toMatchObject({ agent_id: "replacement-owner", text: "replacement payload", submit_verified: null });
      if (replacement) {
        expect(writes).not.toHaveBeenCalled();
        expect(replacement.engine.listDeliveryReceipts()).toEqual(replacementReceipts);
        expect(replacement.engine.getRegistry().get(t.boot.agent_id)).toBeNull();
      }
      expect(t.pane.returns).toBe(t.returns + 1);
      expect(t.pane.inputs).toEqual([t.text]);
      expect(t.pane.submitted).toEqual([t.text]);
    },
  );
});

describe("Immutable recovery baseline and legacy receipts", () => {
  it("immutable absent pre-type evidence cannot be replaced by a later memory baseline", async () => {
    const t=await setup(true);const boot=await t.spawn();const id=boot.boot_prompt_receipt.delivery_id;t.context.deliveryPreTypeScreens.delete(id);
    const r=t.engine.stateMgr.updateRecord(boot.agent_id,{boot_pre_type_screen:null});t.engine.getRegistry().set(r.agent_id,r);t.pane.hidden=false;t.pane.lostAck=true;await t.key(boot.surface_id);
    expect(t.engine.getDeliveryReceipt(id)!.boot_recovery_context!.pre_type_screen).toBe(null);
    t.context.deliveryPreTypeScreens.set(id,"OpenAI Codex (v0.157.0)\n› \n  GPT-6.1-Sol high · ~/Gits/cmuxlayer");const before=t.pane.returns;
    await t.engine.verifyPendingDeliveries();const receipt=t.engine.getDeliveryReceipt(id)!;
    expect(receipt,JSON.stringify(receipt)).toMatchObject({terminal:false,submit_verified:null});expect(t.pane.returns).toBe(before);
  });

  it("captured baseline wins over a later memory frame containing the payload", async () => {
    const t = await setup(true); const boot = await t.spawn(); const id = boot.boot_prompt_receipt.delivery_id;
    const text = t.pane.draft; t.pane.hidden = false; t.pane.lostAck = true;
    await t.key(boot.surface_id); const captured = t.engine.getDeliveryReceipt(id)!.boot_recovery_context!;
    expect(captured.pre_type_screen).toBeTypeOf("string");
    t.context.deliveryPreTypeScreens.set(id, `OpenAI Codex (v0.157.0)\n› ${text}\nWorking (1s • esc to interrupt)\n› \n  GPT-6.1-Sol high · ~/Gits/cmuxlayer`);
    const before = t.pane.returns; await t.engine.verifyPendingDeliveries();
    expect(await t.call("wait_for", { delivery_id: id, timeout_ms: 1 })).toMatchObject({ terminal: true, submit_verified: true });
    expect(t.engine.getDeliveryReceipt(id)!.boot_recovery_context).toEqual(captured);
    expect(t.pane.returns).toBe(before); expect(t.pane.inputs).toEqual([text]);
  });

  it.each([true, false])("legacy receipt without context uses only available memory evidence (present=%s)", async present => {
    const t = await setup(true); const boot = await t.spawn(); const id = boot.boot_prompt_receipt.delivery_id;
    const text = t.pane.draft; t.pane.hidden = false; t.pane.lostAck = true; await t.key(boot.surface_id);
    const pending = t.engine.getDeliveryReceipt(id)!;
    t.engine.resolveDelivery({ ...pending, boot_recovery_context: undefined });
    expect(t.engine.getDeliveryReceipt(id)!.boot_recovery_context).toBeUndefined();
    if (!present) t.context.deliveryPreTypeScreens.delete(id);
    const before = t.pane.returns; await t.engine.verifyPendingDeliveries();
    expect(await t.call("wait_for", { delivery_id: id, timeout_ms: 1 })).toMatchObject({ terminal: present, submit_verified: present ? true : null });
    expect(t.pane.returns).toBe(before); expect(t.pane.inputs).toEqual([text]);
  });
});

// Each injection runs through real SDK/MCP dispatch and real receipt storage.
describe("Predispatch persistence ratchet", () => {
  const faults = ["first-receipt", "later-receipt", "boot-record"] as const;
  it.each(faults.flatMap(fault => [false, true].map(afterWrite => ({ fault, afterWrite }))))(
    "$fault afterWrite=$afterWrite never passively verifies an unsent Return", async ({ fault, afterWrite }) => {
      const t = await setup(true); const boot = await t.spawn();
      const id = boot.boot_prompt_receipt.delivery_id; const text = t.pane.draft;
      const queue = (t.engine as unknown as { deliveryQueue: {
        deliveryReceipts: Map<string, import("../src/engine/types.js").AgentDeliveryReceipt>;
        persistDeliveryReceipts(): void;
      } }).deliveryQueue;
      if (fault === "later-receipt") {
        const original = t.engine.getDeliveryReceipt(id)!;
        const second = `${id}-second-owned`;
        t.engine.resolveDelivery({ ...original, delivery_id: second });
        const owner = [...t.context.typedDraftOwners.values()][0]!;
        owner.texts = [text, text]; owner.deliveryIds = [id, second];
      }
      const ids = t.engine.listDeliveryReceipts().map(r => r.delivery_id).sort();
      const originals = t.engine.listDeliveryReceipts();
      const beforeReturns = t.pane.returns;
      const beforeInvocations = t.pane.returnInvocations;
      const primary = `synthetic ${fault} ${afterWrite ? "after-atomic-write" : "before-write"} failure`;
      let failed = false, writes = 0;
      let injection: ReturnType<typeof vi.spyOn>;
      if (fault === "boot-record") {
        const update = t.engine.stateMgr.updateRecord.bind(t.engine.stateMgr);
        injection = vi.spyOn(t.engine.stateMgr, "updateRecord").mockImplementation((agent, fields) => {
          if (!failed && agent === boot.agent_id && fields.boot_submit_dispatched === true) {
            failed = true; if (afterWrite) update(agent, fields); throw new Error(primary);
          }
          return update(agent, fields);
        });
      } else {
        const persist = queue.persistDeliveryReceipts.bind(queue);
        injection = vi.spyOn(queue, "persistDeliveryReceipts").mockImplementation(() => {
          const pending = [...queue.deliveryReceipts.values()].some(r => r.boot_recovery && r.delivery_state === "pending_verify");
          if (!failed && pending && ++writes === (fault === "later-receipt" ? 2 : 1)) {
            failed = true; if (afterWrite) persist(); throw new Error(primary);
          }
          persist();
        });
      }
      t.pane.hidden = false;
      let sent: Payload;
      try { sent = await t.key(boot.surface_id); } finally { injection.mockRestore(); }
      const afterFailure = t.engine.listDeliveryReceipts();
      const persisted = JSON.parse(readFileSync(join(t.engine.stateMgr.getBaseDir(), "delivery-receipts.json"), "utf8")) as Array<{ delivery_id: string; submit_verified: boolean | null }>;
      // A later matching observation must not create evidence of our Return.
      t.pane.overlay = `OpenAI Codex (v0.157.0)\n› ${text}\nWorking (1s • esc to interrupt)\n› \n  GPT-6.1-Sol high · ~/Gits/cmuxlayer`;
      await t.engine.verifyPendingDeliveries(); await t.engine.verifyPendingDeliveries();
      const receipts = t.engine.listDeliveryReceipts();
      const record = t.engine.getAgentState(boot.agent_id)!;
      console.log("PREDISPATCH_WITNESS", JSON.stringify({ fault, afterWrite, failed, sent,
        returns: t.pane.returns - beforeReturns, transport_invocations: t.pane.returnInvocations - beforeInvocations,
        afterFailure, receipts, boot_pending: record.boot_prompt_pending,
        boot_submit_dispatched: record.boot_submit_dispatched, prompt_delivered: record.prompt_delivered }));
      expect(failed).toBe(true); expect(sent!).toMatchObject({ ok: false });
      expect(JSON.stringify(sent!)).toContain(primary);
      expect(t.pane.returns).toBe(beforeReturns); expect(t.pane.submitted).toEqual([]);
      expect(t.pane.returnInvocations).toBe(beforeInvocations);
      expect(t.pane.inputs).toEqual([text]);
      expect(receipts.map(r => r.delivery_id).sort()).toEqual(ids);
      expect(persisted.map(r => r.delivery_id).sort()).toEqual(ids);
      expect(persisted.every(r => r.submit_verified !== true)).toBe(true);
      expect(afterFailure).toEqual(originals); expect(persisted).toEqual(originals);
      for (const receipt of receipts) {
        expect(receipt.submit_verified, JSON.stringify(receipt)).not.toBe(true);
        expect(receipt.submit_dispatched).toBe(false);
        expect(await t.call("wait_for", { delivery_id: receipt.delivery_id, timeout_ms: 1 }))
          .toMatchObject({ delivery_id: receipt.delivery_id, submit_verified: null, submit_dispatched: false });
      }
      expect(record).toMatchObject({ boot_prompt_pending: true, boot_submit_dispatched: false, prompt_delivered: false });
    },
  );

  it.each(["receipt", "record"].flatMap(fault => [false, true].map(afterWrite => ({ fault, afterWrite }))))(
    "aborted retry $fault afterWrite=$afterWrite retains genuine earlier lost-ACK evidence", async ({ fault, afterWrite }) => {
      const t = await setup(true); const boot = await t.spawn(); const id = boot.boot_prompt_receipt.delivery_id;
      const text = t.pane.draft; t.pane.hidden = false; t.pane.lostAck = true;
      t.pane.onReturn = () => { t.pane.hidden = true; t.pane.onReturn = undefined; };
      expect((await t.key(boot.surface_id)).ok).toBe(false);
      const original = t.engine.getDeliveryReceipt(id)!;
      const returns = t.pane.returns; const primary = `synthetic retry ${fault} failure`;
      const invocations = t.pane.returnInvocations;
      const queue = (t.engine as unknown as { deliveryQueue: { persistDeliveryReceipts(): void } }).deliveryQueue;
      let failed = false;
      let injection: ReturnType<typeof vi.spyOn>;
      if (fault === "receipt") {
        const persist = queue.persistDeliveryReceipts.bind(queue);
        injection = vi.spyOn(queue, "persistDeliveryReceipts").mockImplementation(() => {
          if (!failed) { failed = true; if (afterWrite) persist(); throw new Error(primary); }
          persist();
        });
      } else {
        const update = t.engine.stateMgr.updateRecord.bind(t.engine.stateMgr);
        injection = vi.spyOn(t.engine.stateMgr, "updateRecord").mockImplementation((agent, fields) => {
          if (!failed && agent === boot.agent_id && fields.boot_submit_dispatched === true) {
            failed = true; if (afterWrite) update(agent, fields); throw new Error(primary);
          }
          return update(agent, fields);
        });
      }
      t.pane.hidden = false;
      let sent: Payload;
      try { sent = await t.key(boot.surface_id); } finally { injection.mockRestore(); }
      expect(failed).toBe(true); expect(sent!).toMatchObject({ ok: false });
      expect(JSON.stringify(sent!)).toContain(primary);
      expect(t.pane.returns).toBe(returns);
      expect(t.pane.returnInvocations).toBe(invocations);
      expect(t.engine.getDeliveryReceipt(id)).toEqual(original);
      const disk = JSON.parse(readFileSync(join(t.engine.stateMgr.getBaseDir(), "delivery-receipts.json"), "utf8"));
      expect(disk.find((r: { delivery_id: string }) => r.delivery_id === id)).toEqual(original);
      expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: true, boot_submit_dispatched: true, prompt_delivered: false });
      t.pane.overlay = `OpenAI Codex (v0.157.0)\n› ${text}\nWorking (1s • esc to interrupt)\n› \n  GPT-6.1-Sol high · ~/Gits/cmuxlayer`;
      await t.engine.verifyPendingDeliveries();
      expect(await t.call("wait_for", { delivery_id: id, timeout_ms: 1 }))
        .toMatchObject({ delivery_id: id, terminal: true, submit_dispatched: true, submit_verified: true });
      expect(t.pane.returns).toBe(returns); expect(t.pane.inputs).toEqual([text]);
    },
  );

  it("rollback persistence failure restores every live entry and preserves the primary failure", async () => {
    const t = await setup(true); const boot = await t.spawn(); const id = boot.boot_prompt_receipt.delivery_id;
    const text = t.pane.draft; const original = t.engine.getDeliveryReceipt(id)!;
    const second = `${id}-second-owned`;
    t.engine.resolveDelivery({ ...original, delivery_id: second });
    const owner = [...t.context.typedDraftOwners.values()][0]!;
    owner.texts = [text, text]; owner.deliveryIds = [id, second];
    const originals = t.engine.listDeliveryReceipts(); const returns = t.pane.returns;
    const invocations = t.pane.returnInvocations;
    const queue = (t.engine as unknown as { deliveryQueue: {
      deliveryReceipts: Map<string, unknown>; persistDeliveryReceipts(): void; loadDeliveryReceipts(): void;
    } }).deliveryQueue;
    const persist = queue.persistDeliveryReceipts.bind(queue);
    let writes = 0;
    const injection = vi.spyOn(queue, "persistDeliveryReceipts").mockImplementation(() => {
      if (++writes === 2) throw new Error("synthetic primary later receipt failure");
      if (writes > 2) throw new Error("synthetic secondary rollback storage failure");
      persist();
    });
    t.pane.hidden = false;
    let sent: Payload;
    try { sent = await t.key(boot.surface_id); } finally { injection.mockRestore(); }
    expect(sent!).toMatchObject({ ok: false });
    expect(JSON.stringify(sent!)).toContain("synthetic primary later receipt failure");
    expect(JSON.stringify(sent!)).not.toContain("secondary rollback");
    expect(t.engine.listDeliveryReceipts()).toEqual(originals);
    t.pane.overlay = `OpenAI Codex (v0.157.0)\n› ${text}\nWorking (1s • esc to interrupt)\n› \n  GPT-6.1-Sol high · ~/Gits/cmuxlayer`;
    await t.engine.verifyPendingDeliveries();
    expect(t.engine.listDeliveryReceipts()).toEqual(originals);
    expect(t.pane.returns).toBe(returns); expect(t.pane.inputs).toEqual([text]);
    // Reload the real atomic file, as a new queue does after restart. The
    // failed rollback write left its last successful preparation on disk.
    queue.deliveryReceipts.clear(); queue.loadDeliveryReceipts();
    await t.engine.verifyPendingDeliveries();
    expect(t.engine.listDeliveryReceipts().every(r => r.submit_verified !== true)).toBe(true);
    expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: true, prompt_delivered: false });
    expect(t.pane.returns).toBe(returns);
    expect(t.pane.returnInvocations).toBe(invocations);
  });

  it.each([false, true].flatMap(lost => [false, true].map(afterWrite => ({ lost, afterWrite }))))(
    "dispatch-marker storage failure afterWrite=$afterWrite retains actual Return (lost=$lost)", async ({ lost, afterWrite }) => {
      const t = await setup(true); const boot = await t.spawn(); const id = boot.boot_prompt_receipt.delivery_id;
      const text = t.pane.draft; const returns = t.pane.returns;
      const invocations = t.pane.returnInvocations;
      const queue = (t.engine as unknown as { deliveryQueue: { persistDeliveryReceipts(): void } }).deliveryQueue;
      const persist = queue.persistDeliveryReceipts.bind(queue); let failed = false;
      const injection = vi.spyOn(queue, "persistDeliveryReceipts").mockImplementation(() => {
        // Only fail the final marker after all preparatory bookkeeping. Its
        // failure must not abort transport after labeling the attempt sent.
        if (!failed && t.engine.stateMgr.readState(boot.agent_id)?.boot_submit_dispatched === true) {
          failed = true; if (afterWrite) persist(); throw new Error("synthetic dispatch marker storage failure");
        }
        persist();
      });
      t.pane.hidden = false; t.pane.lostAck = lost;
      t.pane.onReturn = () => {
        expect(failed).toBe(true);
        expect(t.engine.getDeliveryReceipt(id)).toMatchObject({ delivery_id: id, submit_dispatched: true, terminal: false, submit_verified: null, needs_attention: true });
      };
      let sent: Payload;
      try { sent = await t.key(boot.surface_id); } finally { injection.mockRestore(); }
      expect(failed).toBe(true); expect(sent!.ok).toBe(!lost);
      if (lost) expect(JSON.stringify(sent!)).toContain("synthetic Return ACK lost");
      expect(t.pane.returns).toBe(returns + 1);
      expect(t.pane.returnInvocations).toBe(invocations + 1);
      expect(t.pane.inputs).toEqual([text]); expect(t.pane.submitted).toEqual([text]);
      await t.engine.verifyPendingDeliveries();
      expect(await t.call("wait_for", { delivery_id: id, timeout_ms: 1 }))
        .toMatchObject({ delivery_id: id, terminal: true, submit_dispatched: true, submit_verified: true });
      expect(t.engine.getAgentState(boot.agent_id)).toMatchObject({ boot_prompt_pending: false, prompt_delivered: true });
      expect(t.pane.returns).toBe(returns + 1);
    },
  );
});
