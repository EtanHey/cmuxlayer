import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine, type AgentEngineOptions, type DeliveryVerifyObservation } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { ClaudeDeliveryEvidence } from "../src/claude-delivery.js";
import { readInbox } from "../src/inbox.js";

const launch = "2026-08-17T20:00:00.000Z";
const uuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let dir: string;
let engine: AgentEngine;
function open(options: AgentEngineOptions = {}) {
  const state = new StateManager(dir);
  return new AgentEngine(state, new AgentRegistry(state, async () => []), {} as any,
    { sessionIdentityResolver: () => null, deliveryVerifyDeadlineMs: 5_000, deliveryTicketDir: join(dir, "tickets"), inboxOpts: { baseDir: join(dir, "inboxes") }, ...options });
}
function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  const record: AgentRecord = { agent_id: "engine-owner", surface_id: "surface:owner", surface_uuid: uuid,
    workspace_id: "workspace:1", surface_provenance: "cmuxlayer_spawn", state: "booting", repo: "cmuxlayer",
    cli: "claude", model: "sonnet", cli_session_id: null, task_summary: "engine evidence", pid: null,
    version: 1, created_at: launch, updated_at: launch, error: null, parent_agent_id: null, spawn_depth: 0,
    deletion_intent: false, quality: "unknown", max_cost_per_agent: null, crash_recover: false,
    respawn_attempts: 0, user_killed: false, ...overrides };
  engine.stateMgr.writeState(record); engine.getRegistry().set(record.agent_id, record);
  return record;
}
function seed(id = "owned", overrides: Partial<ClaudeDeliveryEvidence> = {}) {
  engine.acceptPendingVerify({ delivery_id: id, agent_id: "engine-owner", text: "owned text", press_enter: true,
    source_event: "boot_prompt", retry_count: 0, typed: true, submit_dispatched: true });
  engine.updateClaudeDeliveryEvidence(id, { initial_frame_hash: "initial", initial_transcript_matches: 0,
    pasted: true, initial_paste_id: 0, observed_paste_id: 9, payload_observed: true, return_attempts: 1,
    return_at: Date.now(), observed_frame_hash: "before", surface_id: "surface:owner", surface_uuid: uuid,
    workspace_id: "workspace:1", cli_session_id: null, agent_created_at: launch,
    pre_return: { hash: "before", observed_at: Date.now(), transcriptMatches: 0, tokenCount: null, cost: null, active: false },
    queued_behind_turn: false, transport_queued: false, sender_agent_id: null, ...overrides });
}
const disk = (id = "owned") => JSON.parse(readFileSync(join(dir, "delivery-receipts.json"), "utf8")).find((r: any) => r.delivery_id === id);
beforeEach(() => { vi.useFakeTimers({ now: new Date(launch) }); dir = mkdtempSync(join(tmpdir(), "636-engine-evidence-")); engine = open(); agent(); });
afterEach(() => { engine.dispose(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

it("keeps snapshots detached and revocation, paste identity and newer Return facts through stale save and restart", () => {
  seed();
  const stale = engine.getDeliveryReceipt("owned")!.claude_submit!;
  stale.pre_return!.hash = "external mutation";
  expect(engine.getDeliveryReceipt("owned")!.claude_submit!.pre_return!.hash).toBe("before");
  engine.observeClaudeDeliveryEvidence(receipt => { Object.assign(receipt.claude_submit!, {
    retry_revoked: true, composer_cleared: true, attribution_revoked: true, weak_corroboration_revoked: true,
    return_at: Date.now() + 10, return_attempts: 3, observed_frame_hash: "newer", last_composer_observed_at: Date.now() + 20,
    pre_return: { ...receipt.claude_submit!.pre_return!, hash: "newer" } }); return true; });
  engine.updateClaudeDeliveryEvidence("owned", { ...stale, observed_paste_id: 99 });
  const expected = { retry_revoked: true, composer_cleared: true, attribution_revoked: true, weak_corroboration_revoked: true,
    observed_paste_id: 9, return_attempts: 3, return_at: Date.now() + 10, observed_frame_hash: "newer", pre_return: { hash: "newer" } };
  expect(engine.getDeliveryReceipt("owned")!.claude_submit).toMatchObject(expected);
  expect(disk().claude_submit).toMatchObject(expected);
  engine.dispose(); engine = open();
  expect(engine.getDeliveryReceipt("owned")!.claude_submit).toMatchObject(expected);
  expect(disk().claude_submit).toMatchObject(expected);
});

it.each(["launch", "prelaunch", "future", "untimed", "revoked", "surface", "workspace", "launch-binding", "pinned"])(
  "adopts only the authoritative first capture for the bound launch (%s)", async kind => {
    const identity = kind === "untimed" ? session : { session_id: session, pid: process.pid,
      pid_registered_at: new Date(Date.parse(launch) + (kind === "prelaunch" ? -1 : kind === "future" ? 1 : 0)).toISOString() };
    engine.dispose(); engine = open({ selfRegistrationSessionResolver: () => identity }); agent();
    seed("owned", { ...(kind === "revoked" ? { retry_revoked: true } : {}),
      ...(kind === "surface" ? { surface_uuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } : {}),
      ...(kind === "workspace" ? { workspace_id: "workspace:other" } : {}),
      ...(kind === "launch-binding" ? { agent_created_at: "2026-08-17T19:59:59.999Z" } : {}),
      ...(kind === "pinned" ? { cli_session_id: "already-owned-session" } : {}) });
    const stale = engine.getDeliveryReceipt("owned")!.claude_submit!;
    await engine.captureBootSessionId("engine-owner");
    expect(engine.getAgentState("engine-owner")!.cli_session_id).toBe(session);
    const expected = kind === "launch" ? session : kind === "pinned" ? "already-owned-session" : null;
    expect(engine.getDeliveryReceipt("owned")!.claude_submit!.cli_session_id).toBe(expected);
    engine.updateClaudeDeliveryEvidence("owned", stale);
    expect(disk().claude_submit.cli_session_id).toBe(expected);
  });

it("marks only the other in-flight receipt when another caller submits on the same surface", () => {
  seed("owned"); seed("other"); seed("elsewhere", { workspace_id: "workspace:other" });
  engine.noteClaudeSurfaceSubmit("surface:owner", "workspace:1", uuid, "owned");
  expect(disk("owned").claude_submit.weak_corroboration_revoked).toBeUndefined();
  expect(disk("other").claude_submit.weak_corroboration_revoked).toBe(true);
  expect(disk("elsewhere").claude_submit.weak_corroboration_revoked).toBeUndefined();
});

it("discards an awaited verification result after disposal changes its generation", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  engine.setDeliveryVerifier(async () => { started(); await held; return { outcome: "delivered", submit_verified: true }; });
  seed(); const verification = engine.verifyPendingDeliveries(); await entered;
  const generation = engine.getDeliveryVerificationGeneration(); engine.dispose(); release(); await verification;
  expect(engine.getDeliveryVerificationGeneration()).toBe(generation + 1);
  expect(engine.getDeliveryReceipt("owned")).toMatchObject({ terminal: false, submit_verified: null });
  expect(disk()).toMatchObject({ terminal: false, submit_verified: null });
});

it("finalizes an unattributed failure and notifies its sender once", async () => {
  const verifier = vi.fn(async () => ({ outcome: "failed_confirmed" as const, reason: "cleared_unattributed" }));
  const issue = vi.fn(async () => {}); const collab = join(dir, "sender.md"); writeFileSync(collab, "# Sender\n");
  engine.dispose(); engine = open({ deliveryVerifier: verifier, deliveryIssueFiler: issue });
  agent(); agent({ agent_id: "sender", surface_id: "surface:sender", collab_path: collab });
  seed("owned", { pending_reason: "cleared_unattributed", retry_revoked: true, composer_cleared: true, sender_agent_id: "sender" });
  await engine.verifyPendingDeliveries(); await engine.verifyPendingDeliveries();
  expect(disk()).toMatchObject({ delivery_state: "failed_confirmed", submit_verified: false, error: "cleared_unattributed" });
  expect(verifier).toHaveBeenCalledTimes(1); expect(issue).not.toHaveBeenCalled();
  expect(readInbox("sender", { baseDir: join(dir, "inboxes") }).filter(m => m.task.includes("owned"))).toHaveLength(1);
  expect(readFileSync(collab, "utf8").match(/Delivery owned /g)).toHaveLength(1);
});

it.each(["codex", "cursor"] as const)("preserves %s final deadline verification and the observer's failure reason", async cli => {
  let outcome: DeliveryVerifyObservation = { outcome: "pending", reason: "transient_read_failure" };
  const verifier = vi.fn(async () => outcome);
  engine.dispose(); engine = open({ deliveryVerifier: verifier }); agent({ cli, state: "working" });
  engine.acceptPendingVerify({ delivery_id: "deadline", agent_id: "engine-owner", text: "other harness text",
    press_enter: true, source_event: "send_to", retry_count: 0 });
  await engine.verifyPendingDeliveries(); expect(verifier).toHaveBeenCalledTimes(1);
  outcome = { outcome: "delivered", submit_verified: true };
  vi.setSystemTime(Date.parse(launch) + 5_000); await engine.verifyPendingDeliveries();
  expect(verifier).toHaveBeenCalledTimes(2);
  expect(disk("deadline")).toMatchObject({ terminal: true, submit_verified: true, delivery_state: "submitted" });
  engine.acceptPendingVerify({ delivery_id: "reason", agent_id: "engine-owner", text: "retain reason",
    press_enter: true, source_event: "send_to", retry_count: 0 });
  outcome = { outcome: "failed_confirmed", reason: "observer_refusal" };
  vi.setSystemTime(Date.now() + 5_000); await engine.verifyPendingDeliveries();
  expect(disk("reason")).toMatchObject({ delivery_state: "failed_confirmed", error: "observer_refusal" });
});

it.each((["claude", "codex", "cursor"] as const).flatMap(cli => ["delivered", "failed_confirmed"].map(outcome => ({ cli, outcome }))))(
  "scopes deadline suppression to Claude evidence ($cli, late $outcome)", async ({ cli, outcome }) => {
    const observation: DeliveryVerifyObservation = outcome === "delivered"
      ? { outcome: "delivered", submit_verified: true } : { outcome: "failed_confirmed", reason: "observer_refusal" };
    const verifier = vi.fn(async () => observation);
    engine.dispose(); engine = open({ deliveryVerifier: verifier }); agent({ cli, state: "working" });
    if (cli === "claude") seed("boundary", { pending_reason: "cleared_unattributed" });
    else engine.acceptPendingVerify({ delivery_id: "boundary", agent_id: "engine-owner", text: "deadline boundary",
      press_enter: true, source_event: "send_to", retry_count: 0 });
    vi.setSystemTime(Date.now() + 5_000); await engine.verifyPendingDeliveries();
    expect(verifier).toHaveBeenCalledTimes(cli === "claude" ? 0 : 1);
    expect(disk("boundary")).toMatchObject(cli === "claude"
      ? { delivery_state: "failed_confirmed", submit_verified: false, error: "cleared_unattributed" }
      : outcome === "delivered" ? { delivery_state: "submitted", submit_verified: true }
        : { delivery_state: "failed_confirmed", error: "observer_refusal" });
  });
