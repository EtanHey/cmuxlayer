import type { AgentDeliveryReceipt } from "../engine/types.js";
import type { diagnoseDeliveryOwnership, OwnershipPredicate } from "./ownership-diagnostic.js";

/** Observation/refusal only. Legacy false dispatch flags lack a common durable
 * pre-Return journal; no diagnostic result can authorize submission here.
 * Keep mutation/transport dependencies out of this interface.
 */
export function observeOriginalDeliveryRecovery(id: string, deps: {
  diagnose: () => ReturnType<typeof diagnoseDeliveryOwnership>;
  getReceipt: () => AgentDeliveryReceipt | null;
}) {
  const diagnostic = deps.diagnose();
  const refusal = (reason: string) => ({ ok: false, delivery_id: id,
    recovery_outcome: "unsupported" as const, reason, input_performed: false,
    recovery_eligible: false, never_dispatched_proof: "not_proven" as const });
  if (diagnostic.status === "caller_unresolved") return refusal("caller_unresolved");
  if (diagnostic.status === "uncertain") return refusal("evidence_uncertain");
  const receipt = deps.getReceipt();
  const after = deps.getReceipt();
  if (JSON.stringify(receipt) !== JSON.stringify(after) ||
      Boolean(receipt) !== Boolean(diagnostic.receipt) ||
      (receipt && (diagnostic.receipt?.agent_id !== receipt.agent_id ||
        diagnostic.receipt.delivery_state !== receipt.delivery_state ||
        diagnostic.receipt.terminal !== receipt.terminal))) return refusal("receipt_changed_during_read");
  if (!receipt) return refusal("receipt_unavailable");
  if (receipt.delivery_id !== id) return refusal("receipt_identity_mismatch");
  const predicates: Record<string, OwnershipPredicate> = diagnostic.predicates ?? {};
  const original = { agent_id: receipt.agent_id, delivery_state: receipt.delivery_state,
    terminal: receipt.terminal, typed: receipt.typed ?? null,
    submit_dispatched: receipt.submit_dispatched ?? null, submit_verified: receipt.submit_verified,
    composer_accepted: receipt.composer_accepted ?? null };
  const result = (outcome: "unsupported" | "observe_only" | "terminal", reason: string) => ({
    ...refusal(reason), recovery_outcome: outcome, receipt: original,
  });
  // Terminal or accepted receipts are never reopened. A previously dispatched
  // uncertain submit is observation-only, even with intact ownership.
  if (receipt.terminal) return result("terminal", "original_receipt_terminal");
  if (receipt.composer_accepted === true || ["queued", "steer_pending", "queued_followup"].includes(receipt.delivery_state)) {
    return result("observe_only", "accepted_or_queued");
  }
  if (receipt.submit_dispatched === true) return result("observe_only", "submit_already_dispatched");
  if (diagnostic.ownership_match !== true || predicates.owner_key_match !== true) {
    return result("unsupported", "ownership_not_proven");
  }
  if (diagnostic.evidence?.boot_first_capture_compatible ||
      (diagnostic.evidence?.boot_token && !diagnostic.evidence.boot_bound) ||
      predicates.target_session_match !== true ||
      (predicates.boot_instance_match !== true && predicates.boot_instance_match !== "not_applicable")) {
    return result("unsupported", "session_or_boot_not_proven");
  }
  if (diagnostic.evidence?.baseline_present !== true) return result("unsupported", "baseline_unavailable");
  // Even a complete exact owner and a false flag are not proof of no Return.
  // A separate prerequisite must journal every applicable Return path before
  // dispatch and supply verifiable provenance plus original-ID CAS semantics.
  return result("unsupported", "return_dispatch_journal_not_proven");
}
