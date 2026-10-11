import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { diagnoseDeliveryOwnership, type OwnershipDiagnosticDeps } from "../src/delivery/ownership-diagnostic.js";
import type { TypedDraftOwner } from "../src/mcp/context.js";
import { createServer, createServerContext, engineForTests } from "../src/server.js";
import { runWithCallerContext } from "../src/caller-context.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { awaitLifecycleFirstOutcome } from "../src/mcp/context.js";

const ID = "fixture-delivery";
const UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CALLER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
  const caller = { agent_id: "sender", surface_id: "surface:1", surface_uuid: CALLER_UUID, cli: "claude", state: "working" } as any;
  const target = { agent_id: "target", cli: "claude", cli_session_id: "session", surface_id: "surface:2", surface_uuid: UUID, workspace_id: "workspace:1", boot_instance_id: "boot" } as any;
  const receipt = { delivery_id: ID, agent_id: "target", text: "PRIVATE DRAFT CONTENT", delivery_state: "pending_verify", terminal: false, press_enter: true } as any;
  const key = JSON.stringify(["workspace:1", UUID, "sender"]);
  const owner: TypedDraftOwner = { caller: "sender", text: receipt.text, deliveryIds: [ID],
    at: 1, ref: "surface:2", uuid: UUID, workspace: "workspace:1", fp: '["target","claude","session"]', seen: false };
  const deps: OwnershipDiagnosticDeps = { resolveCaller: () => caller, getReceipt: () => receipt,
    getTarget: () => target, getFingerprintTarget: () => target, getBootInstance: () => target.boot_instance_id,
    owners: new Map([[key, owner]]), baselines: new Map([[ID, "PRIVATE BASELINE"]]) };
  return { caller, target, receipt, key, owner, deps, read: () => diagnoseDeliveryOwnership(ID, deps) };
}

describe("ownership diagnostic local evidence", () => {
  it("reports the gate without private text or mutation", () => {
    const t = fixture();
    const before = JSON.stringify([t.owner, t.receipt, t.target, [...t.deps.owners], [...t.deps.baselines]]);
    const result = t.read();
    expect(result.ownership_match).toBe(true);
    expect(result.predicates).toMatchObject({ owner_present: true, owner_key_match: true,
      text_delivery_pair_match: true, boot_instance_match: "not_applicable" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|texts|deliveryIds|\"fp\"/);
    expect(JSON.stringify(result).length).toBeLessThan(1800);
    expect(JSON.stringify([t.owner, t.receipt, t.target, [...t.deps.owners], [...t.deps.baselines]])).toBe(before);
  });
  it.each([
    ["incomplete", (t: ReturnType<typeof fixture>) => { t.owner.incomplete = true; }, "draft_complete"],
    ["wrong target", (t: ReturnType<typeof fixture>) => { t.target.agent_id = "replacement"; }, "target_agent_match"],
    ["wrong CLI", (t: ReturnType<typeof fixture>) => { t.target.cli = "codex"; }, "target_cli_match"],
    ["wrong session", (t: ReturnType<typeof fixture>) => { t.target.cli_session_id = "new-session"; }, "target_session_match"],
    ["wrong workspace", (t: ReturnType<typeof fixture>) => { t.target.workspace_id = "workspace:9"; }, "owner_key_match"],
    ["wrong UUID", (t: ReturnType<typeof fixture>) => { t.target.surface_uuid = CALLER_UUID; }, "route_uuid_match"],
    ["wrong text", (t: ReturnType<typeof fixture>) => { t.receipt.text = "DIFFERENT PRIVATE"; }, "text_delivery_pair_match"],
    ["wrong ID", (t: ReturnType<typeof fixture>) => { t.owner.deliveryIds = ["other"]; }, "text_delivery_pair_match"],
    ["wrong boot", (t: ReturnType<typeof fixture>) => { t.owner.bootAgentId = "target"; t.owner.bootInstanceId = "old"; }, "boot_instance_match"],
  ] as const)("isolates %s", (_name, breakEvidence, predicate) => {
    const t = fixture(); breakEvidence(t);
    const result = t.read();
    expect(result.predicates?.[predicate]).toBe(false);
    expect(result.ownership_match).toBe(false);
  });
  it("treats lost evidence and target context as unavailable", () => {
    const t = fixture(); (t.deps.owners as Map<string, TypedDraftOwner>).clear();
    expect(t.read()).toMatchObject({ ownership_match: false, predicates: { owner_present: false, target_session_match: "unavailable" } });
    t.deps.getReceipt = () => null;
    expect(t.read()).toMatchObject({ status: "unavailable", predicates: { receipt_present: false } });
    const other = fixture(); other.deps.getTarget = () => null;
    expect(other.read()).toMatchObject({ ownership_match: "unavailable", predicates: { owner_key_match: "unavailable" } });
    other.deps.getFingerprintTarget = () => undefined;
    other.deps.getTarget = () => other.target;
    expect(other.read().predicates?.target_fingerprint_match).toBe("unavailable");
  });
  it("neither pins first boot capture nor invents missing boot state", () => {
    const t = fixture(); t.owner.bootAgentId = "target"; t.owner.fp = '["target","claude",null]';
    expect(t.read()).toMatchObject({ ownership_match: true, evidence: { boot_first_capture_compatible: true },
      predicates: { target_session_match: "not_applicable" } });
    expect(t.owner.fp).toBe('["target","claude",null]'); expect(t.owner.bootInstanceId).toBeUndefined();
    t.owner.bootInstanceId = "boot"; t.deps.getBootInstance = () => undefined;
    expect(t.read().predicates?.boot_instance_match).toBe("unavailable");
  });
  it("distinguishes malformed fingerprints and missing baseline from a false predicate", () => {
    const t = fixture(); t.owner.fp = "not-json";
    expect(t.read().predicates?.target_fingerprint_match).toBe("unavailable");
    expect(t.read().ownership_match).toBe("unavailable");
    (t.deps.baselines as Map<string, string>).clear();
    expect(t.read().evidence?.baseline_present).toBe(false);
  });
  it("does not reveal foreign caller entries, even when they hold the ID", () => {
    const t = fixture(); t.caller.agent_id = "other";
    expect(t.read()).toMatchObject({ ownership_match: false, predicates: { owner_present: false, caller_match: "unavailable" } });
    const absent = JSON.stringify(t.read()); (t.deps.owners as Map<string, TypedDraftOwner>).clear();
    expect(JSON.stringify(t.read())).toBe(absent);
    t.deps.resolveCaller = () => null; t.deps.getReceipt = vi.fn();
    expect(t.read().status).toBe("caller_unresolved"); expect(t.deps.getReceipt).not.toHaveBeenCalled();
  });
  it("reports changed snapshots and ambiguous entries as uncertain", () => {
    const t = fixture(); let reads = 0;
    t.deps.getTarget = () => ({ ...t.target, cli_session_id: String(reads++) });
    expect(t.read()).toMatchObject({ status: "uncertain", ownership_match: "unavailable" });
    const b = fixture(); b.target.workspace_id = "workspace:9";
    (b.deps.owners as Map<string, TypedDraftOwner>).set("duplicate-own-key", { ...b.owner });
    expect(b.read()).toMatchObject({ status: "uncertain", predicates: { owner_present: "unavailable" } });
  });
});

it("serves diagnostics through registered MCP with unchanged state and zero transport calls", async () => {
  const t = fixture();
  const dir = mkdtempSync(join(tmpdir(), "cmuxlayer-diagnostic-"));
  const transportCall = vi.fn(async () => { throw new Error("diagnostic touched transport"); });
  const topologyCall = vi.fn(async () => ({ workspaces: [] }));
  const context = createServerContext(withTestSurfaceObserver({ stateDir: dir, inboxBaseDir: dir,
    client: { getTransportHealth: () => ({}), readScreen: transportCall, send: transportCall, sendKey: transportCall,
      listWorkspaces: topologyCall, listPanes: transportCall, listPaneSurfaces: transportCall } as any }));
  const server = createServer({ context, inboxBaseDir: dir });
  const engine = engineForTests(server)!;
  const client = new Client({ name: "diagnostic-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const files = () => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => { const path = join(e.parentPath, e.name); return [relative(dir, path), readFileSync(path).toString("base64")]; }).sort();
  try {
    await awaitLifecycleFirstOutcome(context, 1000);
    for (const record of [t.caller, t.target]) {
      Object.assign(record, { version: 1, created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z" });
      engine.stateMgr.writeState(record); engine.getRegistry().set(record.agent_id, record);
    }
    engine.resolveDelivery({ ...t.receipt, source_event: "send_to", retry_count: 0, submit_verified: null, error: null });
    context.typedDraftOwners.set(t.key, t.owner); context.deliveryPreTypeScreens.set(ID, "PRIVATE BASELINE");
    await server.connect(serverTransport); await client.connect(clientTransport);
    const before = JSON.stringify([files(), [...context.typedDraftOwners], [...context.deliveryPreTypeScreens], engine.getRegistry().list()]);
    transportCall.mockClear();
    topologyCall.mockClear();
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === "wait_for")?.inputSchema.properties).toHaveProperty("diagnostic");
    const result = await runWithCallerContext({ surfaceId: CALLER_UUID }, () => client.callTool({ name: "wait_for", arguments: { delivery_id: ID, diagnostic: "ownership" } }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ diagnostic: "ownership", caller_agent_id: "sender", ownership_match: true });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify([files(), [...context.typedDraftOwners], [...context.deliveryPreTypeScreens], engine.getRegistry().list()])).toBe(before);
    expect(transportCall).not.toHaveBeenCalled();
    expect(topologyCall).not.toHaveBeenCalled();
    const foreign = await runWithCallerContext({ surfaceId: UUID }, () => client.callTool({ name: "wait_for",
      arguments: { delivery_id: ID, diagnostic: "ownership", caller_agent_id: "sender" } }));
    expect(foreign.structuredContent).toMatchObject({ caller_agent_id: "target", ownership_match: false,
      predicates: { owner_present: false }, evidence: { baseline_present: "unavailable" } });
    for (const selectors of [{ agent_id: "target" }, { delivery_id: ID, ids: ["target"] },
      { delivery_id: ID, watch: { kind: "agent_state", agent_id: "target", state: "done" } },
      { delivery_id: ID, target_state: "done" }, { delivery_id: ID, report_path: "/tmp/report", done_marker: "DONE" }]) {
      const refusal = await client.callTool({ name: "wait_for", arguments: { diagnostic: "ownership", ...selectors } });
      expect(refusal.isError).toBe(true);
    }
    console.info("OWNERSHIP_DIAGNOSTIC_FIXTURE", JSON.stringify(result.structuredContent));
    expect(JSON.stringify([files(), [...context.typedDraftOwners], [...context.deliveryPreTypeScreens], engine.getRegistry().list()])).toBe(before);
    expect(transportCall).not.toHaveBeenCalled(); expect(topologyCall).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); context.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
