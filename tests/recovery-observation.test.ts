import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { observeOriginalDeliveryRecovery } from "../src/delivery/recovery-observation.js";
import { createServer, createServerContext, engineForTests } from "../src/server.js";
import { runWithCallerContext } from "../src/caller-context.js";
import { awaitLifecycleFirstOutcome } from "../src/mcp/context.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const ID = "original-fixture-id";
const UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CALLER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
  const receipt = { delivery_id: ID, agent_id: "target", text: "PRIVATE COMPOSER", typed: true,
    delivery_state: "pending_verify", terminal: false, submit_dispatched: false, submit_verified: null } as any;
  const diagnostic = { status: "available", caller_agent_id: "sender", ownership_match: true,
    receipt: { agent_id: "target", delivery_state: "pending_verify", terminal: false },
    predicates: { owner_key_match: true, target_session_match: true, boot_instance_match: "not_applicable" },
    evidence: { baseline_present: true, boot_token: false, boot_bound: false } } as any;
  const deps = { diagnose: () => diagnostic, getReceipt: () => ({ ...receipt }) };
  return { receipt, diagnostic, deps, read: () => observeOriginalDeliveryRecovery(ID, deps) };
}

describe("original-ID observation/refusal", () => {
  it.each([undefined, false, true])("never trusts legacy submit_dispatched=%s", flag => {
    const t = fixture(); t.receipt.submit_dispatched = flag;
    const before = JSON.stringify(t);
    expect(t.read()).toMatchObject({ delivery_id: ID, recovery_eligible: false, input_performed: false,
      recovery_outcome: flag ? "observe_only" : "unsupported", reason: flag ? "submit_already_dispatched" : "return_dispatch_journal_not_proven" });
    expect(JSON.stringify(t)).toBe(before); expect(JSON.stringify(t.read())).not.toContain("PRIVATE");
  });
  it.each(["caller", "missing-owner", "displaced-key", "ambiguous", "session", "boot", "baseline", "snapshot"])("refuses %s without evidence reconstruction", control => {
    const t = fixture();
    if (control === "caller") { t.diagnostic.status = "caller_unresolved"; t.deps.getReceipt = vi.fn(); }
    if (control === "missing-owner") t.diagnostic.ownership_match = false;
    if (control === "displaced-key") t.diagnostic.predicates.owner_key_match = false;
    if (control === "ambiguous" || control === "snapshot") t.diagnostic.status = "uncertain";
    if (control === "session") t.diagnostic.predicates.target_session_match = "unavailable";
    if (control === "boot") { t.diagnostic.evidence.boot_token = true; t.diagnostic.evidence.boot_bound = false; }
    if (control === "baseline") t.diagnostic.evidence.baseline_present = false;
    expect(t.read()).toMatchObject({ recovery_outcome: "unsupported", recovery_eligible: false, input_performed: false });
    if (control === "caller") expect(t.deps.getReceipt).not.toHaveBeenCalled();
  });
  it.each(["queued", "steer_pending", "queued_followup"])("never replays %s", state => {
    const t = fixture(); t.receipt.delivery_state = state; t.diagnostic.receipt.delivery_state = state;
    expect(t.read()).toMatchObject({ recovery_outcome: "observe_only", reason: "accepted_or_queued" });
  });
  it.each(["submitted", "failed_confirmed"])("retains terminal %s outcome", state => {
    const t = fixture(); Object.assign(t.receipt, { delivery_state: state, terminal: true, submit_verified: state === "submitted" });
    Object.assign(t.diagnostic.receipt, { delivery_state: state, terminal: true });
    expect(t.read()).toMatchObject({ recovery_outcome: "terminal", receipt: { delivery_state: state, terminal: true } });
  });
  it("never accepts spoofed journal provenance or invokes journal/CAS on a lost ACK", () => {
    const t = fixture(); Object.assign(t.receipt, { submission_started_at: "2026-10-11T00:00:00Z", return_dispatch_journal_version: 1 });
    const journal = vi.fn(() => { throw new Error("journal failure"); });
    const cas = vi.fn(() => { throw new Error("CAS failure"); });
    expect(observeOriginalDeliveryRecovery(ID, { ...t.deps, journal, cas } as any).reason).toBe("return_dispatch_journal_not_proven");
    expect(journal).not.toHaveBeenCalled(); expect(cas).not.toHaveBeenCalled();
  });
  it("reports unavailable receipt and late acceptance during a read without mutation", () => {
    const t = fixture(); t.deps.getReceipt = () => null as any; t.diagnostic.receipt = null;
    expect(t.read().reason).toBe("receipt_unavailable");
    t.diagnostic.receipt = { agent_id: "target", delivery_state: "pending_verify", terminal: false };
    expect(t.read().reason).toBe("receipt_changed_during_read");
    let reads = 0; t.deps.getReceipt = () => ({ ...t.receipt, terminal: reads++ > 0 });
    expect(t.read().reason).toBe("receipt_changed_during_read");
  });
});

it("registered MCP recovery has no input, writes or verifier calls, including concurrent sends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmuxlayer-recovery-observation-"));
  const transportCall = vi.fn(async () => { throw new Error("unexpected pane operation"); });
  const topologyCall = vi.fn(async () => ({ workspaces: [] }));
  const context = createServerContext(withTestSurfaceObserver({ stateDir: dir, inboxBaseDir: dir,
    client: { getTransportHealth: () => ({}), readScreen: transportCall, send: transportCall, sendKey: transportCall,
      listWorkspaces: topologyCall, listPanes: transportCall, listPaneSurfaces: transportCall } as any }));
  const server = createServer({ context, inboxBaseDir: dir });
  const engine = engineForTests(server)!;
  const client = new Client({ name: "recovery-observation-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const files = () => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => { const p = join(e.parentPath, e.name); return [relative(dir, p), readFileSync(p).toString("base64")]; }).sort();
  try {
    await awaitLifecycleFirstOutcome(context, 1000);
    const sender = { agent_id: "sender", surface_id: "surface:1", surface_uuid: CALLER_UUID, cli: "claude", state: "working" } as any;
    const target = { ...sender, agent_id: "target", surface_id: "surface:2", surface_uuid: UUID,
      workspace_id: "workspace:1", cli_session_id: "session", boot_instance_id: "boot" };
    for (const record of [sender, target]) {
      Object.assign(record, { version: 1, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z" });
      engine.stateMgr.writeState(record); engine.getRegistry().set(record.agent_id, record);
    }
    const t = fixture();
    engine.resolveDelivery({ ...t.receipt, source_event: "send_to", press_enter: true, retry_count: 0, error: null });
    const key = JSON.stringify([target.workspace_id, UUID, "sender"]);
    const owner = { caller: "sender", text: t.receipt.text, deliveryIds: [ID], at: 1,
      ref: target.surface_id, uuid: UUID, workspace: target.workspace_id, fp: '["target","claude","session"]', seen: false };
    context.typedDraftOwners.set(key, owner); context.deliveryPreTypeScreens.set(ID, "PRIVATE BASELINE");
    await server.connect(serverTransport); await client.connect(clientTransport);
    const verify = vi.spyOn(engine, "waitForDelivery");
    const journal = vi.spyOn(engine, "resolveDelivery");
    const deliver = vi.spyOn(engine, "acceptPendingVerify");
    const snapshot = () => JSON.stringify([files(), [...context.typedDraftOwners], [...context.deliveryPreTypeScreens], engine.getRegistry().list()]);
    const before = snapshot(); transportCall.mockClear(); topologyCall.mockClear();
    const call = (extra: Record<string, unknown> = {}) => runWithCallerContext({ surfaceId: CALLER_UUID },
      () => client.callTool({ name: "send_to", arguments: { mode: "recover_delivery", delivery_id: ID, ...extra } }));
    const expectRecoveryRefusal = (result: Awaited<ReturnType<typeof client.callTool>>) => {
      expect(result.isError).toBe(true);
      const content = result.content as { type: string; text: string }[];
      expect(content).toHaveLength(1); expect(content[0].type).toBe("text");
      expect(content[0].text).not.toContain("✔");
      const textPayload = JSON.parse(content[0].text);
      expect(textPayload).toEqual(result.structuredContent);
      expect(textPayload).toMatchObject({ ok: false, delivery_id: ID,
        error: "send_to recover_delivery refused: observation only; no input performed",
        input_performed: false, recovery_eligible: false, never_dispatched_proof: "not_proven" });
      expect(content[0].text).not.toContain("PRIVATE");
    };
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === "send_to")?.inputSchema.properties).toHaveProperty("delivery_id");
    const [first, second, normal] = await Promise.all([call(), call(), runWithCallerContext({ surfaceId: UUID },
      () => client.callTool({ name: "send_to", arguments: { mode: "agent", agent_id: "target", text: t.receipt.text } }))]);
    for (const result of [first, second]) {
      expectRecoveryRefusal(result);
      expect(result.structuredContent).toMatchObject({ ok: false, delivery_id: ID,
        reason: "return_dispatch_journal_not_proven", recovery_eligible: false, input_performed: false,
        receipt: { agent_id: "target", delivery_state: "pending_verify", terminal: false,
          typed: true, submit_dispatched: false, submit_verified: null } });
    }
    // A normal send from another caller follows the existing pending duplicate
    // gate. Recovery observations cannot lend it the original caller's owner.
    expect(normal.structuredContent?.ok).toBe(false);
    expect(normal.structuredContent?.duplicate_of).toBe(ID);
    expect(JSON.stringify(first)).not.toContain("PRIVATE");
    expect(snapshot()).toBe(before); expect(verify).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
    for (const replacement of [{ text: "replacement" }, { agent_id: "other" }, { surface: "surface:2" },
      { target: "target" }, { workspace: "workspace:1" }]) expect((await call(replacement)).isError).toBe(true);
    const foreign = await runWithCallerContext({ surfaceId: UUID }, () => client.callTool({ name: "send_to",
      arguments: { mode: "recover_delivery", delivery_id: ID, caller_agent_id: "sender" } }));
    expect(foreign.structuredContent).toMatchObject({ caller_agent_id: "target", reason: "ownership_not_proven", input_performed: false });
    expectRecoveryRefusal(foreign);
    expect(snapshot()).toBe(before);
    const controls = ["missing-owner", "incomplete", "workspace", "uuid", "session", "boot", "unbound-boot", "wrong-id"];
    for (const control of controls) {
      const changed = { ...target };
      const changedOwner: any = { ...owner, deliveryIds: [ID] };
      if (control === "workspace") changed.workspace_id = "workspace:9";
      if (control === "uuid") changed.surface_uuid = CALLER_UUID;
      if (control === "session") changed.cli_session_id = "changed-session";
      if (control === "incomplete") changedOwner.incomplete = true;
      if (control === "boot" || control === "unbound-boot") changedOwner.bootAgentId = "target";
      if (control === "boot") changedOwner.bootInstanceId = "old-boot";
      if (control === "wrong-id") changedOwner.deliveryIds = ["other-id"];
      engine.stateMgr.writeState(changed); engine.getRegistry().set(changed.agent_id, changed);
      context.typedDraftOwners.clear();
      if (control !== "missing-owner") context.typedDraftOwners.set(key, changedOwner);
      const changedBefore = snapshot();
      const refused = await call(); expectRecoveryRefusal(refused);
      expect(refused.structuredContent).toMatchObject({ recovery_outcome: "unsupported", recovery_eligible: false, input_performed: false });
      expect(snapshot()).toBe(changedBefore);
    }
    engine.stateMgr.writeState(target); engine.getRegistry().set(target.agent_id, target);
    context.typedDraftOwners.clear(); context.typedDraftOwners.set(key, owner);
    const original = engine.getDeliveryReceipt(ID)!;
    for (const control of [
      { submit_dispatched: undefined },
      { submit_dispatched: true },
      { submit_dispatched: false, submission_started_at: "2026-10-11T00:00:00Z" },
      { delivery_state: "queued", composer_accepted: true },
      { delivery_state: "steer_pending", composer_accepted: true },
      { delivery_state: "queued_followup", composer_accepted: true },
    ] as const) {
      engine.resolveDelivery({ ...original, ...control }); journal.mockClear();
      const originalBefore = snapshot();
      const outcome = await call();
      expectRecoveryRefusal(outcome);
      expect(outcome.structuredContent).toMatchObject({ ok: false, delivery_id: ID, input_performed: false, recovery_eligible: false });
      expect(outcome.structuredContent?.recovery_outcome).toBe(control.submit_dispatched === true || "delivery_state" in control ? "observe_only" : "unsupported");
      expect(snapshot()).toBe(originalBefore); expect(journal).not.toHaveBeenCalled();
    }
    engine.resolveDelivery(original); journal.mockClear();
    const upward = { ...sender, role: "worker", collab_path: "/tmp/fixture-collab.md", parent_agent_id: "target" };
    engine.stateMgr.writeState({ ...target, role: "orchestrator" });
    engine.getRegistry().set(target.agent_id, { ...target, role: "orchestrator" });
    engine.stateMgr.writeState(upward); engine.getRegistry().set(upward.agent_id, upward);
    const upwardBefore = snapshot();
    expect((await call()).isError).toBe(true); expect(snapshot()).toBe(upwardBefore);
    engine.stateMgr.writeState(sender); engine.getRegistry().set(sender.agent_id, sender);
    engine.stateMgr.writeState(target); engine.getRegistry().set(target.agent_id, target);
    const absentBefore = snapshot();
    const unresolved = await client.callTool({ name: "send_to", arguments: { mode: "recover_delivery", delivery_id: ID } });
    expect(unresolved.structuredContent).toMatchObject({ reason: "caller_unresolved", input_performed: false });
    expectRecoveryRefusal(unresolved);
    expect(unresolved.structuredContent).not.toHaveProperty("receipt"); expect(snapshot()).toBe(absentBefore);
    // A synthetic accepted receipt models independently settled verification;
    // the read must retain that result and never re-open it.
    for (const state of ["submitted", "failed_confirmed"] as const) {
      engine.resolveDelivery({ ...original, delivery_state: state, terminal: true,
        submit_verified: state === "submitted", submit_dispatched: true });
      const terminalBefore = snapshot(); journal.mockClear();
      const terminal = await call(); expectRecoveryRefusal(terminal);
      expect(terminal.structuredContent).toMatchObject({ recovery_outcome: "terminal",
        receipt: { delivery_state: state, terminal: true, typed: true,
          submit_dispatched: true, submit_verified: state === "submitted" } });
      expect(snapshot()).toBe(terminalBefore); expect(journal).not.toHaveBeenCalled();
    }
    expect(transportCall).not.toHaveBeenCalled(); expect(topologyCall).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); context.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
