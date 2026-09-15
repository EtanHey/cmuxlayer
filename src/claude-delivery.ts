import { createHash } from "node:crypto";
import type { AgentDeliveryReceipt, DeliveryVerifyObservation } from "./agent-engine.js";

export interface ClaudeReturnBaseline {
  hash: string;
  observed_at: number;
  transcriptMatches: number;
  tokenCount: number | null;
  cost: number | null;
  active: boolean;
}
/** Persisted attribution and retry facts; screen bodies stay out of the registry. */
export interface ClaudeDeliveryEvidence {
  initial_frame_hash: string;
  initial_transcript_matches: number;
  pasted: boolean;
  initial_paste_id: number;
  observed_paste_id?: number;
  payload_observed: boolean;
  observed_frame_hash?: string;
  last_frame_hash?: string;
  return_at?: number;
  return_attempts?: number;
  pre_return?: ClaudeReturnBaseline;
  pending_reason?: "cleared_unattributed";
  surface_id?: string;
  surface_uuid?: string | null;
  workspace_id?: string | null;
  cli_session_id?: string | null;
  queued_behind_turn: boolean;
  sender_agent_id: string | null;
  transport_queued: boolean;
  submit_evidence?: "transcript_echo" | "token_delta" | "cleared_composer";
  corroboration?: "transcript_echo" | "consumption_increase" | "activity_transition";
}
export const deliveryFrameHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function claudePasteId(composer: string | null): number {
  const match = composer?.replace(/\s+/g, " ").trim().match(/^\[Pasted text #(\d+)(?: \+\d+ lines?)?\]$/);
  return match ? Number(match[1]) : 0;
}
export interface ClaudeDeliveryFrame extends ClaudeReturnBaseline {
  complete: boolean;
  pending: boolean;
  cleared: boolean;
  queued: boolean;
  inTranscript: boolean;
  pasteId?: number;
}

export function reserveClaudeReturn(receipt: AgentDeliveryReceipt, frame: ClaudeDeliveryFrame): void {
  const evidence = receipt.claude_submit!;
  const previousAttempts = evidence.return_attempts ?? (evidence.return_at !== undefined ? receipt.retry_count + 1 : 0);
  evidence.return_attempts = previousAttempts + 1;
  receipt.retry_count = previousAttempts;
  evidence.payload_observed = true;
  evidence.observed_frame_hash = frame.hash;
  evidence.observed_paste_id = frame.pasteId || evidence.observed_paste_id;
  evidence.pre_return = { hash: frame.hash, observed_at: frame.observed_at, transcriptMatches: frame.transcriptMatches,
    tokenCount: frame.tokenCount, cost: frame.cost, active: frame.active };
  evidence.return_at = Date.now();
}
const increased = (current: number | null, baseline: number | null): boolean =>
  typeof current === "number" && Number.isFinite(current) && typeof baseline === "number" && Number.isFinite(baseline) && current > baseline;

export async function verifyClaudeDelivery(
  receipt: AgentDeliveryReceipt,
  io: {
    read: () => Promise<ClaudeDeliveryFrame | null>;
    save: () => void;
    returnOnly: () => Promise<void>;
    isCurrent?: () => boolean;
  },
): Promise<DeliveryVerifyObservation> {
  const evidence = receipt.claude_submit!;
  const current = () => io.isCurrent?.() !== false;
  const inspect = (frame: ClaudeDeliveryFrame | null): DeliveryVerifyObservation | null => {
    if (!current()) return { outcome: "pending", reason: "verification_cancelled" };
    if (!frame) return { outcome: "pending", reason: "surface_read_unavailable" };
    evidence.last_frame_hash = frame.hash;
    const baseline = evidence.pre_return;
    const attributable = evidence.payload_observed && evidence.return_at !== undefined && baseline &&
      baseline.hash === evidence.observed_frame_hash && frame.observed_at > evidence.return_at &&
      frame.hash !== baseline.hash && !frame.pending && !frame.queued;
    if (attributable) {
      const kind = frame.inTranscript && frame.transcriptMatches > baseline.transcriptMatches ? "transcript_echo"
        : frame.cleared && (increased(frame.tokenCount, baseline.tokenCount) || increased(frame.cost, baseline.cost)) ? "consumption_increase"
        : frame.cleared && !baseline.active && frame.active ? "activity_transition" : null;
      if (kind) {
        evidence.corroboration = kind;
        evidence.submit_evidence = kind === "consumption_increase" ? "token_delta" : kind === "activity_transition" ? "cleared_composer" : "transcript_echo";
        io.save();
        return { outcome: "delivered", submit_verified: true, evidence: { submit_evidence: evidence.submit_evidence, corroboration: kind, frame_hash: frame.hash } };
      }
    }
    if (frame.cleared) { evidence.pending_reason = "cleared_unattributed"; io.save(); return { outcome: "pending", reason: "cleared_unattributed" }; }
    return null;
  };
  let frame = await io.read();
  const observed = inspect(frame);
  if (observed) return observed;
  // A former busy state is not permanent. Once idle, the same owned composer
  // can receive Return; an explicit queued-input frame never gets a re-press.
  if (!frame?.complete || frame.active || frame.queued) {
    io.save();
    return { outcome: "pending" };
  }
  if (evidence.return_at !== undefined && Date.now() - evidence.return_at < 2_000) return { outcome: "pending" };
  frame = await io.read();
  const late = inspect(frame);
  if (late) return late;
  if (!frame?.complete || frame.active || frame.queued || !current()) return { outcome: "pending" };
  const attempts = evidence.return_attempts ?? (evidence.return_at !== undefined ? receipt.retry_count + 1 : 0);
  if (attempts >= 4) return { outcome: "failed_confirmed", reason: "idle_composer_return_exhausted", evidence: { frame_hash: frame.hash } };
  reserveClaudeReturn(receipt, frame);
  io.save(); // Reserve before I/O, including ambiguous ACK failures. Never retype.
  await io.returnOnly();
  receipt.submit_dispatched = true;
  io.save();
  return { outcome: "pending" };
}
