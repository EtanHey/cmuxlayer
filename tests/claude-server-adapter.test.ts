import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createServerContext } from "../src/server.js";
import { deliveryFrameHash, type ClaudeDeliveryEvidence } from "../src/claude-delivery.js";
import type { AgentEngine } from "../src/agent-engine.js";
import type { AgentRecord } from "../src/agent-types.js";

const launch = "2026-08-17T20:00:00.000Z";
const surface = "surface:adapter";
const uuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const workspace = "workspace:adapter";
const observerId = "cmux:/tmp/636-server-adapter.sock";
const payload = "636 owned adapter payload";
class Surface {
  composer = payload;
  transcript = "";
  override: string | null = null;
  keys: string[] = [];
  sends: string[] = [];
  holdNextRead: Promise<void> | null = null;
  entered: (() => void) | null = null;
  onRead: (() => void) | null = null;
  onKey: (() => void) | null = null;
  frame() { return this.override ?? `Claude Code\n${this.transcript}\n⏺ Bash(previous tool completed)\n❯ ${this.composer}\n`; }
  async readScreen() {
    const text = this.frame(); this.onRead?.();
    const gate = this.holdNextRead; this.holdNextRead = null;
    if (gate) { this.entered?.(); await gate; }
    return { surface, text, lines: 30, scrollback_used: false };
  }
  async send(_surface: string, text: string) { this.sends.push(text); }
  async sendKey(_surface: string, key: string) { this.onKey?.(); this.keys.push(key); }
  async log() {}
  async setStatus() {}
  async setStatuses() { return true; }
  async clearStatus() {}
  async listWorkspaces() { return { workspaces: [{ ref: workspace, title: "Adapter", index: 0, selected: true, pinned: false }] }; }
  async listPanes() { return { workspace_ref: workspace, window_ref: "window:1", panes: [{ ref: "pane:1", index: 0, focused: true, surface_count: 1, surface_refs: [surface], selected_surface_ref: surface }] }; }
  async listPaneSurfaces() { return { workspace_ref: workspace, window_ref: "window:1", pane_ref: "pane:1", surfaces: [{ id: uuid, ref: surface, title: "Claude", type: "terminal", index: 0, selected: true }] }; }
  async listSurfaces() { return { surfaces: [{ id: uuid, ref: surface, title: "Claude", type: "terminal", workspace_ref: workspace }] }; }
}
let dir: string;
let client: Surface;
let context: ReturnType<typeof createServerContext>;
let server: any;
let engine: AgentEngine;
const disk = () => JSON.parse(readFileSync(join(dir, "delivery-receipts.json"), "utf8")).find((r: any) => r.delivery_id === "adapter");
function seed(overrides: Partial<ClaudeDeliveryEvidence> = {}) {
  const hash = deliveryFrameHash(client.frame()); const before = Date.now() - 2_001;
  engine.acceptPendingVerify({ delivery_id: "adapter", agent_id: "adapter-owner", text: payload, press_enter: true,
    source_event: "send_to", retry_count: 0, typed: true, submit_dispatched: true });
  engine.updateClaudeDeliveryEvidence("adapter", { initial_frame_hash: "initial", initial_transcript_matches: 0,
    pasted: false, initial_paste_id: 0, payload_observed: true, return_attempts: 1, return_at: before,
    observed_frame_hash: hash, surface_id: surface, surface_uuid: uuid, workspace_id: workspace,
    cli_session_id: null, agent_created_at: launch, queued_behind_turn: false, transport_queued: false, sender_agent_id: null,
    pre_return: { hash, observed_at: before, transcriptMatches: 0, tokenCount: null, cost: null, active: false }, ...overrides });
}
beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(launch) }); dir = mkdtempSync(join(tmpdir(), "636-server-adapter-")); client = new Surface();
  const options = { client: client as any, stateDir: dir, inboxBaseDir: join(dir, "inboxes"), disableSpawnPreflight: true,
    sessionIdentityResolver: () => null, surfaceObserverOwnerIdProvider: () => observerId, surfaceObserverEpochProvider: () => `${observerId}@test` };
  context = createServerContext(options); server = createServer({ ...options, context });
  engine = server._registeredTools.interact._engine; engine.dispose();
  const record: AgentRecord = { agent_id: "adapter-owner", surface_id: surface, surface_uuid: uuid, surface_observer_id: observerId,
    workspace_id: workspace, state: "ready", repo: "cmuxlayer", model: "sonnet", cli: "claude", cli_session_id: null,
    task_summary: "registered adapter", pid: null, version: 1, created_at: launch, updated_at: launch, error: null,
    parent_agent_id: null, spawn_depth: 0, deletion_intent: false, quality: "unknown", max_cost_per_agent: null,
    crash_recover: false, respawn_attempts: 0, user_killed: false };
  engine.stateMgr.writeState(record); engine.getRegistry().set(record.agent_id, record);
  const read = await server._registeredTools.read_screen.handler({ surface }, {});
  expect(read.isError).not.toBe(true);
});
afterEach(async () => { await server.close(); context.dispose(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

it("reserves an existing receipt before a recovery Return and attributes a later real transcript frame", async () => {
  seed();
  client.onKey = () => expect(disk().claude_submit).toMatchObject({ return_attempts: 2, return_at: Date.now() });
  await engine.verifyPendingDeliveries();
  expect(client.keys).toEqual(["return"]); expect(client.sends).toEqual([]);
  client.composer = ""; client.transcript = `⏺ User: ${payload}`;
  vi.setSystemTime(Date.now() + 2_001); await engine.verifyPendingDeliveries();
  expect(engine.getDeliveryReceipt("adapter")).toMatchObject({ delivery_state: "submitted", submit_verified: true, submit_evidence: "transcript_echo" });
  expect(client.keys).toEqual(["return"]); expect(client.sends).toEqual([]);
});

it("does not observe a composer or authorize Return from a screen without an anchor", async () => {
  seed(); const before = engine.getDeliveryReceipt("adapter")!.claude_submit;
  client.override = "Claude Code\nplain tool output without a composer anchor\n";
  const read = await server._registeredTools.read_screen.handler({ surface }, {}); expect(read.isError).not.toBe(true);
  await engine.verifyPendingDeliveries();
  expect(engine.getDeliveryReceipt("adapter")!.claude_submit).toEqual(before);
  expect(disk().claude_submit).toEqual(before); expect(client.keys).toEqual([]);
});

it("preserves the original paste ID when a replacement placeholder appears", async () => {
  client.composer = "[Pasted text #7 +3 lines]"; seed({ pasted: true, observed_paste_id: 7 });
  client.composer = "[Pasted text #8 +3 lines]";
  await server._registeredTools.read_screen.handler({ surface }, {}); await engine.verifyPendingDeliveries();
  expect(disk().claude_submit).toMatchObject({ observed_paste_id: 7, retry_revoked: true, attribution_revoked: true });
  expect(client.keys).toEqual([]); expect(client.composer).toBe("[Pasted text #8 +3 lines]");
});

it("keeps a shared observer's clear/restore revocation through an awaited frame and stale evidence save", async () => {
  seed(); const stale = engine.getDeliveryReceipt("adapter")!.claude_submit!;
  let release!: () => void; let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }); client.entered = entered;
  client.holdNextRead = new Promise<void>(resolve => { release = resolve; });
  const verification = engine.verifyPendingDeliveries(); await reading;
  expect(client.keys).toEqual([]);
  const observer = createServer({ context }) as any;
  try {
    client.composer = ""; const read = await observer._registeredTools.read_screen.handler({ surface }, {});
    expect(read.isError).not.toBe(true); client.composer = payload; release(); await verification;
    engine.updateClaudeDeliveryEvidence("adapter", stale);
    expect(engine.getDeliveryReceipt("adapter")!.claude_submit).toMatchObject({ retry_revoked: true, composer_cleared: true });
    expect(disk().claude_submit).toMatchObject({ retry_revoked: true, composer_cleared: true });
    expect(client.keys).toEqual([]); expect(client.sends).toEqual([]);
  } finally { release(); await observer.close(); }
});

it.each(["session", "cli"])("refuses recovery after a %s replacement during the actual read", async binding => {
  seed(); client.onRead = () => {
    client.onRead = null;
    const old = engine.getAgentState("adapter-owner")!;
    const changed = { ...old, ...(binding === "session" ? { cli_session_id: "replacement" } : { cli: "codex" as const }) };
    engine.stateMgr.writeState(changed); engine.getRegistry().set(changed.agent_id, changed);
  };
  await engine.verifyPendingDeliveries();
  expect(disk().claude_submit).toMatchObject({ retry_revoked: true, attribution_revoked: true });
  expect(client.keys).toEqual([]);
});

it("refuses a seeded receipt whose workspace binding disagrees with its current route", async () => {
  seed({ workspace_id: "workspace:other" }); await engine.verifyPendingDeliveries();
  expect(disk().claude_submit).toMatchObject({ retry_revoked: true, attribution_revoked: true }); expect(client.keys).toEqual([]);
});

it("does not dispatch Return when disposal overtakes its real awaited read", async () => {
  seed(); let release!: () => void; let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }); client.entered = entered;
  client.holdNextRead = new Promise<void>(resolve => { release = resolve; });
  const verification = engine.verifyPendingDeliveries(); await reading; engine.dispose(); release(); await verification;
  expect(client.keys).toEqual([]); expect(engine.getDeliveryReceipt("adapter")!.terminal).toBe(false);
});
