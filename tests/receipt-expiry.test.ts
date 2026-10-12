import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryQueue } from "../src/engine/delivery-queue.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { DeliveryVerifyObservation } from "../src/engine/types.js";

describe("receipt expiry queue boundaries", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cmux-receipt-expiry-")); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  function setup(observation: DeliveryVerifyObservation = { outcome: "pending" }) {
    const stateMgr = new StateManager(dir);
    const registry = new AgentRegistry(stateMgr, async () => []);
    const deps = { stateMgr, registry, getAgentState: () => null, captureReportSubmission: () => null, markAgentWorking: () => null };
    const verifier = vi.fn(async () => observation);
    const queue = new DeliveryQueue(deps, { deliveryVerifyDeadlineMs: 1000, deliveryVerifier: verifier });
    const accept = (submit_dispatched?: boolean, typed = true) => queue.acceptPendingVerify({
      delivery_id: "original", agent_id: "target", text: "owned text", press_enter: true,
      source_event: "send_to", retry_count: 0, typed, submit_dispatched,
    });
    return { queue, deps, verifier, accept };
  }

  it("parks known undispatched text once, preserves errors/deadline and never drains or re-verifies it after reload", async () => {
    const { queue, deps, verifier, accept } = setup();
    const original = accept(false);
    queue.resolveDelivery({ ...original, error: "retained pre-submit refusal" });
    vi.advanceTimersByTime(1001);
    await queue.verifyPendingDeliveries();
    const parked = queue.getDeliveryReceipt("original")!;
    expect(parked).toMatchObject({ delivery_state: "typed", terminal: false, resolved_at: null,
      submit_dispatched: false, submit_verified: null, needs_attention: true,
      verify_deadline_at: original.verify_deadline_at, error: "retained pre-submit refusal" });
    expect(queue.findOpenDuplicate({ agent_id: "target", text: "owned text", press_enter: true })?.delivery_id).toBe("original");
    await queue.verifyPendingDeliveries();
    expect(verifier).toHaveBeenCalledTimes(1);
    const reloadedVerifier = vi.fn(async () => ({ outcome: "pending" as const }));
    const reloaded = new DeliveryQueue(deps, { deliveryVerifier: reloadedVerifier });
    const submitter = vi.fn(); reloaded.setDeliverySubmitter(submitter);
    await reloaded.drainDeliveryQueue(); await reloaded.verifyPendingDeliveries();
    expect(reloaded.getDeliveryReceipt("original")).toEqual(parked);
    expect(reloadedVerifier).not.toHaveBeenCalled(); expect(submitter).not.toHaveBeenCalled();
  });

  it.each([true, undefined])("retains the existing timeout for dispatched/unknown submit %s", async (dispatch) => {
    const { queue, accept } = setup(); accept(dispatch); vi.advanceTimersByTime(1001);
    await queue.verifyPendingDeliveries();
    expect(queue.getDeliveryReceipt("original")).toMatchObject({ delivery_state: "failed_confirmed",
      terminal: true, error: "verify_deadline_elapsed", submit_verified: false });
  });

  it("does not park text with no typing evidence", async () => {
    const { queue, accept } = setup(); accept(false, false); vi.advanceTimersByTime(1001);
    await queue.verifyPendingDeliveries();
    expect(queue.getDeliveryReceipt("original")?.delivery_state).toBe("failed_confirmed");
  });

  it("does not override an explicit confirmed failure", async () => {
    const { queue, accept } = setup({ outcome: "failed_confirmed", reason: "composer_rejected_input" });
    accept(false); vi.advanceTimersByTime(1001); await queue.verifyPendingDeliveries();
    expect(queue.getDeliveryReceipt("original")).toMatchObject({ delivery_state: "failed_confirmed",
      terminal: true, error: "composer_rejected_input" });
  });

  it("does not override consecutive target-gone confirmation", async () => {
    const { queue, accept } = setup({ outcome: "pending", reason: "target_gone" });
    accept(false); await queue.verifyPendingDeliveries(); await queue.verifyPendingDeliveries();
    vi.advanceTimersByTime(30_001); await queue.verifyPendingDeliveries();
    expect(queue.getDeliveryReceipt("original")).toMatchObject({ delivery_state: "failed_confirmed", terminal: true, error: "target_gone" });
  });

  it.each(["target_gone", "boot_instance_changed"])("ReceiptExpiryR1 fails a single %s observation at deadline", async reason => {
    const { queue, accept } = setup({ outcome: "pending", reason });
    accept(false); vi.advanceTimersByTime(1001); await queue.verifyPendingDeliveries();
    const final = queue.getDeliveryReceipt("original");
    vi.advanceTimersByTime(5 * 60 * 60 * 1000); await queue.verifyPendingDeliveries();
    const duplicate = queue.findOpenDuplicate({ agent_id: "target", text: "owned text", press_enter: true });
    console.log("R1_F2_QUEUE", JSON.stringify({ reason, final, duplicate }));
    expect(final).toMatchObject({ delivery_state: "failed_confirmed", terminal: true, error: reason });
    expect(queue.getDeliveryReceipt("original")).toEqual(final);
    expect(duplicate).toBeNull();
  });

  it.each([undefined, "target_gone", "boot_instance_changed"])("ReceiptExpiryR1 reads known undispatched text at deadline inside throttle (%s)", async reason => {
    const { queue, verifier, accept } = setup({ outcome: "pending", reason });
    accept(false); await queue.verifyPendingDeliveries();
    vi.advanceTimersByTime(1001); await queue.verifyPendingDeliveries();
    const final = queue.getDeliveryReceipt("original");
    console.log("R1_F2_THROTTLE", JSON.stringify({ reason, verifierCalls: verifier.mock.calls.length, final }));
    expect(verifier).toHaveBeenCalledTimes(2);
    expect(final).toMatchObject(reason === undefined
      ? { delivery_state: "typed", terminal: false, submit_verified: null }
      : { delivery_state: "failed_confirmed", terminal: true, error: reason });
  });

  it("LateAcceptance reload observes attempted typed evidence without draining or replay", async () => {
    const { queue, deps, accept } = setup();
    queue.resolveDelivery({ ...accept(true), delivery_state: "typed", terminal: false, needs_attention: true });
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    // Queue persistence contract: the injected verifier supplies acceptance.
    // A registered server reload without private proof is a separate control.
    const verifier = vi.fn(async () => ({ outcome: "delivered" as const, submit_verified: true }));
    const reloaded = new DeliveryQueue(deps, { deliveryVerifier: verifier });
    const submitter = vi.fn(); reloaded.setDeliverySubmitter(submitter);
    await reloaded.drainDeliveryQueue(); await reloaded.verifyPendingDeliveries();
    expect(submitter).not.toHaveBeenCalled(); expect(verifier).toHaveBeenCalledTimes(1);
    expect(reloaded.getDeliveryReceipt("original")).toMatchObject({ delivery_id: "original",
      delivery_state: "submitted", terminal: true, submit_verified: true, needs_attention: false });
    expect(reloaded.findOpenDuplicate({ agent_id: "target", text: "owned text", press_enter: true })).toBeNull();
  });

  it.each(["pending", "failed_confirmed"] as const)("LateAcceptance retains attempted typed receipt on %s evidence", async outcome => {
    const { queue, verifier, accept } = setup({ outcome, reason: "surface_read_unavailable" });
    queue.resolveDelivery({ ...accept(true), delivery_state: "typed", terminal: false, error: "retained evidence" });
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(5 * 60 * 60 * 1000); await queue.verifyPendingDeliveries();
      expect(queue.getDeliveryReceipt("original")).toMatchObject({ delivery_state: "typed", terminal: false,
        submit_dispatched: true, submit_verified: null, error: "retained evidence" });
    }
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it.each(["typed", "failed_confirmed"] as const)("LateAcceptance never revives terminal %s receipts", async delivery_state => {
    const { queue, verifier, accept } = setup({ outcome: "delivered", submit_verified: true });
    queue.resolveDelivery({ ...accept(true), delivery_state, terminal: true });
    const original = queue.getDeliveryReceipt("original");
    vi.advanceTimersByTime(5 * 60 * 60 * 1000); await queue.verifyPendingDeliveries();
    expect(verifier).not.toHaveBeenCalled(); expect(queue.getDeliveryReceipt("original")).toEqual(original);
  });

  it("LateAcceptance does not share another receipt's ownership snapshot", async () => {
    const { queue, accept } = setup();
    const first = accept(true);
    queue.resolveDelivery({ ...first, delivery_state: "typed", terminal: false });
    queue.acceptPendingVerify({ ...first, delivery_id: "other", text: "other text" });
    queue.resolveDelivery({ ...first, delivery_id: "other", text: "other text", delivery_state: "typed", terminal: false });
    const reader = vi.fn(async receipt => receipt.delivery_id === "original" ? { text: "accepted" } : null);
    queue.setDeliverySnapshotReader(reader);
    queue.setDeliveryVerifier(async (_receipt, snapshot) => ({ outcome: snapshot ? "delivered" : "pending" }));
    vi.advanceTimersByTime(31_000); await queue.verifyPendingDeliveries();
    expect(reader).toHaveBeenCalledTimes(2);
    expect(queue.getDeliveryReceipt("original")?.delivery_state).toBe("submitted");
    expect(queue.getDeliveryReceipt("other")).toMatchObject({ delivery_state: "typed", terminal: false, submit_verified: null });
  });

  it("accepts actual submission evidence even after the deadline", async () => {
    const { queue, accept } = setup({ outcome: "delivered", submit_verified: true });
    accept(false); vi.advanceTimersByTime(1001); await queue.verifyPendingDeliveries();
    expect(queue.getDeliveryReceipt("original")).toMatchObject({ delivery_state: "submitted", terminal: true, submit_verified: true });
  });
});
