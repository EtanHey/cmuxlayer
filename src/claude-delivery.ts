import { createHash } from "node:crypto";
import type { AgentDeliveryReceipt, DeliveryVerifyObservation } from "./agent-engine.js";

/** Persisted attribution and retry facts; screen bodies stay out of the registry. */
export interface ClaudeDeliveryEvidence {
  initial_frame_hash: string;
  payload_observed: boolean;
  observed_frame_hash?: string;
  last_frame_hash?: string;
  return_at?: number;
  queued_behind_turn: boolean;
  sender_agent_id: string | null;
  transport_queued: boolean;
  submit_evidence?: "transcript_echo" | "cleared_composer";
}
export const deliveryFrameHash = (text: string) => createHash("sha256").update(text).digest("hex");
export interface ClaudeDeliveryFrame {
  hash: string;
  complete: boolean;
  pending: boolean;
  cleared: boolean;
  active: boolean;
  queued: boolean;
  inTranscript: boolean;
}

export async function verifyClaudeDelivery(
  receipt: AgentDeliveryReceipt,
  io: {
    read: () => Promise<ClaudeDeliveryFrame | null>;
    save: () => void;
    returnOnly: () => Promise<void>;
  },
): Promise<DeliveryVerifyObservation> {
  const evidence = receipt.claude_submit!;
  const inspect = (frame: ClaudeDeliveryFrame | null): DeliveryVerifyObservation | null => {
    if (!frame) return { outcome: "pending", reason: "surface_read_unavailable" };
    evidence.last_frame_hash = frame.hash;
    const attributable = evidence.payload_observed && receipt.submit_dispatched &&
      frame.hash !== evidence.initial_frame_hash && !frame.pending && !frame.queued;
    if (attributable && (frame.inTranscript || (frame.cleared && !evidence.queued_behind_turn))) {
      evidence.submit_evidence = frame.inTranscript ? "transcript_echo" : "cleared_composer";
      io.save();
      return { outcome: "delivered", submit_verified: true, evidence: { submit_evidence: evidence.submit_evidence, frame_hash: frame.hash } };
    }
    return null;
  };
  let frame = await io.read();
  const observed = inspect(frame);
  if (observed) return observed;
  if (!frame?.complete || frame.active || frame.queued || evidence.queued_behind_turn) {
    io.save();
    return { outcome: "pending" };
  }
  if (evidence.return_at !== undefined && Date.now() - evidence.return_at < 2_000) return { outcome: "pending" };
  // Re-read under the surface write lock immediately before a possible retry.
  // A late landing that cleared the composer or started a turn cancels it.
  frame = await io.read();
  const late = inspect(frame);
  if (late) return late;
  if (!frame?.complete || frame.active || frame.queued) return { outcome: "pending" };
  if (receipt.submit_dispatched && receipt.retry_count >= 3) {
    return { outcome: "failed_confirmed", reason: "idle_composer_return_exhausted", evidence: { frame_hash: frame.hash } };
  }
  evidence.payload_observed = true;
  evidence.observed_frame_hash = frame.hash;
  evidence.return_at = Date.now();
  if (receipt.submit_dispatched) receipt.retry_count++;
  receipt.submit_dispatched = true;
  io.save(); // Reserve this Return before I/O; a timeout must never replay text.
  await io.returnOnly();
  return inspect(await io.read()) ?? { outcome: "pending" };
}
