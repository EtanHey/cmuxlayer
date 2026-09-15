import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyClaudeDelivery, type ClaudeDeliveryFrame } from "../src/claude-delivery.js";
import type { AgentDeliveryReceipt } from "../src/agent-engine.js";

beforeEach(() => vi.useFakeTimers({ now: 10_000 }));
afterEach(() => vi.useRealTimers());
const receipt = (overrides: Record<string, unknown> = {}) => ({
  delivery_id: "owned", agent_id: "target", text: "unique payload", submit_dispatched: true, retry_count: 0,
  claude_submit: { initial_frame_hash: "initial", initial_transcript_matches: 0, payload_observed: true,
    observed_frame_hash: "owned-before-return", return_at: 7_000, return_attempts: 1, queued_behind_turn: false,
    pre_return: { hash: "owned-before-return", observed_at: 7_000, transcriptMatches: 0, tokenCount: 100, cost: 1, active: false }, ...overrides },
} as unknown as AgentDeliveryReceipt);
const frame = (overrides: Record<string, unknown> = {}) => ({
  hash: "later-empty", observed_at: 10_000, complete: false, pending: false, cleared: true, active: false,
  queued: false, inTranscript: false, transcriptMatches: 0, tokenCount: 100, cost: 1, ...overrides,
} as unknown as ClaudeDeliveryFrame);

it.each([
  ["bare empty redraw", {}, {}],
  ["known empty frame redrawn after restart", { hash: "restart-redraw" }, {}],
  ["token reset", { tokenCount: 1, cost: 0 }, {}],
  ["counter merely became visible", { tokenCount: 1234 }, { pre_return: { hash: "owned-before-return", observed_at: 7000, transcriptMatches: 0, tokenCount: null, cost: 1, active: false } }],
  ["old read resolves after Return", { observed_at: 6999, inTranscript: true, transcriptMatches: 1 }, {}],
  ["already working", { active: true }, { pre_return: { hash: "owned-before-return", observed_at: 7000, transcriptMatches: 0, tokenCount: 100, cost: 1, active: true } }],
  ["unproven baseline", { tokenCount: 200 }, { pre_return: undefined }],
])("#636 refuses unattributed clearance: %s", async (_name, delta, evidence) => {
  const key = vi.fn();
  const result = await verifyClaudeDelivery(receipt(evidence), { read: async () => frame(delta), save: vi.fn(), returnOnly: key });
  expect(result.outcome).toBe("pending");
  expect(result.reason).toBe("cleared_unattributed");
  expect(key).not.toHaveBeenCalled();
});

it.each([
  ["transcript_echo", { inTranscript: true, transcriptMatches: 1 }],
  ["consumption_increase", { tokenCount: 101 }],
  ["consumption_increase", { cost: 1.01 }],
  ["activity_transition", { active: true }],
])("#636 attributes clearance only with %s", async (kind, delta) => {
  const key = vi.fn();
  const result = await verifyClaudeDelivery(receipt(), { read: async () => frame(delta), save: vi.fn(), returnOnly: key });
  expect(result).toMatchObject({ outcome: "delivered", submit_verified: true, evidence: { corroboration: kind } });
  expect(key).not.toHaveBeenCalled();
});

it("#636 an ambiguous Return ACK consumes an attempt without retyping", async () => {
  const current = receipt({ return_at: undefined, return_attempts: 0, payload_observed: false });
  current.submit_dispatched = false;
  const key = vi.fn(async () => { throw new Error("ETIMEDOUT after dispatch"); });
  const io = { read: async () => frame({ complete: true, pending: true, cleared: false }), save: vi.fn(), returnOnly: key };
  for (let i = 0; i < 4; i++) {
    await verifyClaudeDelivery(current, io).catch(() => {});
    await vi.advanceTimersByTimeAsync(2001);
  }
  expect(key).toHaveBeenCalledTimes(4);
  expect(current.retry_count).toBe(3);
  expect((await verifyClaudeDelivery(current, io)).outcome).toBe("failed_confirmed");
  expect(key).toHaveBeenCalledTimes(4);
});

it("#636 stops a late read after verification was cancelled", async () => {
  const current = receipt(); const key = vi.fn(); let valid = true;
  const result = await verifyClaudeDelivery(current, {
    read: async () => { valid = false; return frame({ complete: true, pending: true, cleared: false }); },
    save: vi.fn(), returnOnly: key, isCurrent: () => valid,
  } as any);
  expect(result.outcome).toBe("pending");
  expect(key).not.toHaveBeenCalled();
});

it("#636 resumes an unsubmitted mid-turn payload when it becomes idle", async () => {
  const current = receipt({ queued_behind_turn: true, return_at: undefined, return_attempts: 0 });
  current.submit_dispatched = false;
  const key = vi.fn();
  await verifyClaudeDelivery(current, { read: async () => frame({ complete: true, pending: true, cleared: false }), save: vi.fn(), returnOnly: key });
  expect(key).toHaveBeenCalledTimes(1);
});

it.each(["cleared", "edited"])("#636 D1 ownership remains revoked after an observed %s composer is restored", async kind => {
  const current = receipt(); const key = vi.fn();
  await verifyClaudeDelivery(current, { read: async () => frame({ cleared: kind === "cleared", hash: "observed-generation-change" }), save: vi.fn(), returnOnly: key });
  await vi.advanceTimersByTimeAsync(2_001);
  await verifyClaudeDelivery(current, { read: async () => frame({ complete: true, pending: true, cleared: false, hash: "owned-before-return" }), save: vi.fn(), returnOnly: key });
  expect(key).not.toHaveBeenCalled();
});

it("#636 D1 ownership preserves later attribution after bare clearance without a replacement", async () => {
  const current = receipt(); const key = vi.fn();
  const io = { save: vi.fn(), returnOnly: key };
  expect((await verifyClaudeDelivery(current, { ...io, read: async () => frame() })).outcome).toBe("pending");
  await vi.advanceTimersByTimeAsync(2_001);
  expect((await verifyClaudeDelivery(current, { ...io, read: async () => frame({ inTranscript: true, transcriptMatches: 1 }) })).outcome).toBe("delivered");
  expect(key).not.toHaveBeenCalled();
});

it("#636 D1 ownership cannot attribute a replacement generation that later clears", async () => {
  const current = receipt(); const key = vi.fn();
  const io = { save: vi.fn(), returnOnly: key };
  await verifyClaudeDelivery(current, { ...io, read: async () => frame() });
  await verifyClaudeDelivery(current, { ...io, read: async () => frame({ complete: true, pending: true, cleared: false, hash: "restored-generation" }) });
  await vi.advanceTimersByTimeAsync(2_001);
  expect((await verifyClaudeDelivery(current, { ...io, read: async () => frame({ inTranscript: true, transcriptMatches: 1 }) })).outcome).toBe("pending");
  expect(key).not.toHaveBeenCalled();
});
