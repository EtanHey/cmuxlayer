/**
 * Delivery receipts and delivery errors: receipt shapes and builders, evidence
 * extracted from failures, phase timings, and the error classes that carry a
 * receipt. One module because the errors build receipts and the receipt code
 * reads the errors. Moved verbatim from server.ts (CX-2 S3).
 */

import type { ParsedScreenResult } from "../types.js";
import type { ToolReturn } from "../mcp/tool-result.js";

export type DeliveryStatus = "delivering" | "delivered" | "failed" | "pending_verify";

export type SubmitEvidence =
  "token_delta" | "transcript_echo" | "cleared_composer" | "status_only";

export type PublicDeliveryState =
  | "typed"
  | "submitted"
  | "queued"
  | "queued_followup"
  | "rescued"
  | "failed"
  | "pending_verify"
  | "failed_confirmed"
  | "stalled_queue";

export interface PublicDeliveryReceipt {
  delivered: boolean;
  terminal: boolean;
  typed: boolean;
  submit_attempted: boolean;
  submit_dispatched?: boolean;
  submit_verified: boolean | null;
  submitted: boolean;
  submit_evidence?: SubmitEvidence | null;
  retry_count: number;
  rpc_methods: Array<"surface.send_text" | "surface.send_key">;
  delivery?: PublicDeliveryState;
  delivery_state?: PublicDeliveryState;
  delivery_id?: string;
  duplicate_of?: string;
  needs_attention?: boolean;
  attention_reason?: string;
  queued_behind_turn?: boolean;
  timings_ms?: DeliveryPhaseTimings;
  observation?: {
    status: ParsedScreenResult["status"];
    composer_empty: boolean;
    prompt_echoed: boolean;
    last_10_lines: string[];
  };
  WARNING?: string;
}

export type DeliveryRpcMethod = PublicDeliveryReceipt["rpc_methods"][number];

export type DeliveryErrorEvidence = {
  rpc_methods: DeliveryRpcMethod[];
  typed?: boolean;
  submit_dispatched?: boolean;
};

export const deliveryRpcMethodsFromError = (
  error: unknown,
): DeliveryRpcMethod[] =>
  error &&
  typeof error === "object" &&
  "rpc_methods" in error &&
  Array.isArray((error as { rpc_methods?: unknown }).rpc_methods)
    ? [...(error as DeliveryErrorEvidence).rpc_methods]
    : error instanceof SubmitVerificationError
      ? [...error.receipt.rpc_methods]
      : [];

export const deliveryTypedFromError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "typed" in error &&
      (error as { typed?: unknown }).typed === true,
  ) ||
  (error instanceof SubmitVerificationError && error.receipt.typed === true);

export const deliverySubmitDispatchedFromError = (error: unknown): boolean =>
  Boolean(
    error &&
      typeof error === "object" &&
      "submit_dispatched" in error &&
      (error as { submit_dispatched?: unknown }).submit_dispatched === true,
  ) ||
  (error instanceof SubmitVerificationError &&
    error.receipt.submit_attempted === true);

export function bootPromptFailureMutationEvidence(input: {
  delivered_chars: number;
  typed: boolean;
  submit_dispatched: boolean;
  rpc_methods: DeliveryRpcMethod[];
}) {
  const typed = input.typed || input.delivered_chars > 0 ||
    input.rpc_methods.includes("surface.send_text");
  return buildPublicDeliveryReceipt({
    delivery_state: "failed",
    typed,
    submit_attempted: input.submit_dispatched,
    submit_dispatched: input.submit_dispatched,
    submit_verified: false,
    retry_count: 0,
    rpc_methods: [...input.rpc_methods],
  });
}

export const preserveDeliveryEvidenceOnError = (
  error: unknown,
  rpcMethods: ReadonlySet<DeliveryRpcMethod>,
  typed: boolean,
  submitDispatched: boolean,
): unknown => {
  if (rpcMethods.size === 0 && !typed && !submitDispatched) return error;
  const target =
    error && typeof error === "object"
      ? error
      : new Error(String(error), { cause: error });
  try {
    Object.defineProperty(target, "rpc_methods", {
      configurable: true,
      enumerable: false,
      value: [...rpcMethods],
    });
    if (typed) {
      Object.defineProperty(target, "typed", {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }
    if (submitDispatched) {
      Object.defineProperty(target, "submit_dispatched", {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }
    return target;
  } catch {
    const wrapped = new Error(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
    Object.defineProperty(wrapped, "rpc_methods", {
      configurable: true,
      enumerable: false,
      value: [...rpcMethods],
    });
    if (typed) {
      Object.defineProperty(wrapped, "typed", {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }
    if (submitDispatched) {
      Object.defineProperty(wrapped, "submit_dispatched", {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }
    return wrapped;
  }
};

export type DeliveryPhase =
  "route" | "lock" | "lock_hold" | "enumerate" | "type" | "verify";

export type DeliveryPhaseTimings = Record<DeliveryPhase, number> & {
  // RPC durations are summed; concurrent topology calls can exceed wall time.
  // Target-list time wraps those topology calls and must not be added to them.
  enumerate_topology_rpc: number;
  enumerate_scan_target_list: number;
  enumerate_screen_read: number;
  enumerate_rpc_count: number;
  event_loop_delay_max: number;
  event_loop_delay_mean: number;
};

export function createDeliveryPhaseTimings(): DeliveryPhaseTimings {
  return {
    route: 0, lock: 0, lock_hold: 0, enumerate: 0, type: 0, verify: 0,
    enumerate_topology_rpc: 0, enumerate_scan_target_list: 0,
    enumerate_screen_read: 0, enumerate_rpc_count: 0,
    event_loop_delay_max: 0, event_loop_delay_mean: 0,
  };
}

export function withSurfaceDeliveryTimings(
  result: ToolReturn,
  timings: DeliveryPhaseTimings,
): ToolReturn {
  const payload = result.structuredContent;
  if (!payload) return result;
  const structuredContent = {
    ...payload,
    timings_ms: payload.timings_ms ?? timings,
  };
  return {
    ...result,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function addDeliveryPhaseTiming(
  timings: DeliveryPhaseTimings | undefined,
  phase: DeliveryPhase,
  startedAt: number,
): void {
  if (!timings) return;
  timings[phase] += Math.max(0, Date.now() - startedAt);
}

export async function timeDeliveryPhase<T>(
  timings: DeliveryPhaseTimings | undefined,
  phase: DeliveryPhase,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    addDeliveryPhaseTiming(timings, phase, startedAt);
  }
}

/**
 * The only public receipt builder for text/key delivery. A delivery
 * discriminator is intentionally absent until the engine has evidence for a
 * queued, failed, or verified-submitted outcome.
 */
export function buildPublicDeliveryReceipt(input: {
  delivery_state?: PublicDeliveryState;
  delivery_id?: string;
  typed: boolean;
  submit_attempted: boolean;
  submit_verified: boolean | null;
  submit_evidence?: SubmitEvidence | null;
  retry_count: number;
  rpc_methods?: Array<"surface.send_text" | "surface.send_key">;
  needs_attention?: boolean;
  attention_reason?: string | null;
  queued_behind_turn?: boolean;
  timings_ms?: DeliveryPhaseTimings;
  observation?: PublicDeliveryReceipt["observation"];
  submit_dispatched?: boolean;
  WARNING?: string;
}): PublicDeliveryReceipt {
  const evidencedState =
    input.delivery_state === "typed" ||
    input.delivery_state === "queued" ||
    input.delivery_state === "queued_followup" ||
    input.delivery_state === "rescued" ||
    input.delivery_state === "failed" ||
    input.delivery_state === "pending_verify" ||
    input.delivery_state === "failed_confirmed" ||
    input.delivery_state === "stalled_queue"
      ? input.delivery_state
      : input.delivery_state === "submitted" && input.submit_verified === true
        ? "submitted"
        : undefined;
  const terminal =
    evidencedState === "typed" ||
    evidencedState === "submitted" ||
    evidencedState === "rescued" ||
    evidencedState === "failed" ||
    evidencedState === "failed_confirmed" ||
    evidencedState === "stalled_queue";
  const warning =
    input.WARNING ??
    defaultNonDeliveryWarning(
      evidencedState,
      input.rpc_methods ?? [],
      input.typed,
      input.submit_dispatched === true,
    );
  return {
    delivered: evidencedState === "submitted" && input.submit_verified === true,
    terminal,
    typed: input.typed,
    submit_attempted: input.submit_attempted,
    ...(input.submit_dispatched !== undefined
      ? { submit_dispatched: input.submit_dispatched }
      : {}),
    submit_verified: input.submit_verified,
    submitted: input.submit_verified === true,
    ...(input.submit_verified !== null
      ? { submit_evidence: input.submit_evidence ?? null }
      : {}),
    retry_count: input.retry_count,
    rpc_methods: input.rpc_methods ?? [],
    ...(evidencedState
      ? { delivery: evidencedState, delivery_state: evidencedState }
      : {}),
    ...(input.delivery_id ? { delivery_id: input.delivery_id } : {}),
    ...(input.needs_attention === true
      ? {
          needs_attention: true,
          ...(input.attention_reason
            ? { attention_reason: input.attention_reason }
            : {}),
        }
      : {}),
    ...(input.queued_behind_turn === true ? { queued_behind_turn: true } : {}),
    ...(input.timings_ms ? { timings_ms: { ...input.timings_ms } } : {}),
    ...(input.observation ? { observation: input.observation } : {}),
    ...(warning ? { WARNING: warning } : {}),
  };
}

/**
 * One plain-language line a caller cannot honestly quote as "sent".
 *
 * AIDEV-NOTE (T2 #445): `ok:true` with `delivered:false` was routinely read as
 * success -- a lead's own words: "I treated the first as evidence of the
 * second." The booleans two levels down were correct and still misread, so the
 * receipt now says it in words at the top level. Explicit callers keep their
 * own WARNING (the paused-target line is more specific than this default).
 */
export function defaultNonDeliveryWarning(
  state: PublicDeliveryState | undefined,
  rpcMethods: readonly DeliveryRpcMethod[],
  typed: boolean,
  submitDispatched: boolean,
): string | undefined {
  switch (state) {
    case "pending_verify":
    case "queued":
    case "queued_followup":
      return (
        `NOT DELIVERED YET — state ${state}: the message has not been observed ` +
        "to land. It resolves in the background; do not relay as sent. " +
        "Query wait_for({delivery_id}) for the terminal outcome."
      );
    case "failed":
    case "failed_confirmed":
    case "stalled_queue":
      if (state === "stalled_queue") {
        return "STALLED QUEUE — the target is idle but still shows the queued message. Inspect its pane and use Escape to release it, then verify delivery before retrying.";
      }
      if (typed || rpcMethods.includes("surface.send_text")) {
        return submitDispatched || rpcMethods.includes("surface.send_key")
          ? `PARTIALLY DELIVERED — terminal cmuxlayer failure (${state}) after ` +
              "text reached the target and the submission key was sent. The task " +
              "may have been submitted despite the later failure; do not resend. " +
              "Inspect the target pane before any recovery."
          : `PARTIALLY DELIVERED — terminal cmuxlayer failure (${state}). The ` +
              "text reached the target composer, but no submission key succeeded; " +
              "it may remain there unsubmitted. Do not resend. Inspect the target " +
              "pane before any recovery.";
      }
      return (
        `NOT DELIVERED — terminal failure (${state}). The message did not ` +
        "land and will not be retried; do not relay as sent."
      );
    case "rescued":
      return (
        "NOT VERIFIED — state rescued: the prompt first appeared after an " +
        "interrupt, so external intervention delivered text but cmuxlayer did " +
        "not verify an intact task turn. Do not relay as delivered."
      );
    default:
      return undefined;
  }
}

export function pausedTargetWarning(source: string): string {
  return (
    `WARNING — target pane is paused (source: ${source}) and cannot act. ` +
    "Delivery is queued, not submitted. Do not relay as sent."
  );
}

export interface DeliveryRecord {
  delivery_id: string;
  surface: string;
  workspace?: string;
  status: DeliveryStatus;
  total_chunks: number;
  sent_chunks: number;
  chunk_size: number;
  chunk_delay_ms: number;
  chunks: string[];
  press_enter: boolean;
  verify_submit: boolean;
  submit_verified: boolean | null;
  submit_verification_reason?: SubmitVerificationFailureReason;
  retry_safe?: false;
  retry_count: number;
  rpc_methods: DeliveryRpcMethod[];
  typed: boolean;
  submit_dispatched: boolean;
  rename_to_task?: string;
  started_at: string;
  completed_at?: string;
  error?: string;
  failed_chunk?: number;
  /** Internal UUID guard; omitted from public delivery snapshots. */
  stableSurfaceIdentity?: string | null;
  /** Ref-only provenance captured before an asynchronous write starts. */
  surfaceObserverIdentity?: string | null;
  beforeMutation?: () => Promise<void>;
  lockKey?: string;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly failed_chunk?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "DeliveryError";
  }
}

/**
 * Why a submit could not be verified. This is the sentence a receipt shows the
 * fleet when a delivery did not land, so it is spelled out rather than nested:
 * the order is "what we saw" before "what we required", most specific first.
 */
export function resolveSubmitVerificationFailureReason(observed: {
  sawPendingInput: boolean;
  sawReadableScreen: boolean;
  sawBlankScreen: boolean;
  bootConsumptionRefuted: boolean;
  requireWorkingStatus: boolean;
}): SubmitVerificationFailureReason {
  if (observed.sawPendingInput) return "input_still_pending";
  if (!observed.sawReadableScreen) {
    return observed.sawBlankScreen
      ? "surface_screen_empty"
      : "surface_read_unavailable";
  }
  if (observed.bootConsumptionRefuted) return "consumption_not_observed";
  if (observed.requireWorkingStatus) return "working_status_not_observed";
  return "submit_evidence_absent";
}

export type SubmitVerificationFailureReason =
  | "surface_read_unavailable"
  | "surface_screen_empty"
  | "input_still_pending"
  | "working_status_not_observed"
  | "consumption_not_observed"
  | "submit_evidence_absent";

/**
 * Why a bare submit-key dispatch could not be confirmed. A key send carries no
 * text, so the text path's evidence (does the screen still show what we typed?)
 * does not apply; prompt-state transitions and an emptied composer are the
 * available positive evidence.
 */
export type SubmitKeyVerificationReason =
  "surface_read_unavailable" | "submit_evidence_absent";

export class SubmitVerificationError extends Error {
  readonly retry_safe = false;
  readonly receipt: PublicDeliveryReceipt;

  constructor(
    message: string,
    readonly retry_count: number,
    readonly reason: SubmitVerificationFailureReason,
    receipt?: PublicDeliveryReceipt,
  ) {
    super(message);
    this.name = "SubmitVerificationError";
    this.receipt =
      receipt ??
      buildPublicDeliveryReceipt({
        typed: true,
        submit_attempted: true,
        submit_verified: false,
        retry_count,
      });
  }
}

export class AmbiguousBootRecoveryReturnError extends Error {
  receipt?: PublicDeliveryReceipt;
  constructor(
    readonly pointer: string,
    readonly bootInstanceId: string,
    readonly agentId: string,
    cause: unknown,
  ) {
    super(
      `Recovered boot Return acknowledgement is uncertain: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "AmbiguousBootRecoveryReturnError";
  }
}

export const submitVerificationFailurePayload = (error: SubmitVerificationError) => ({
  ...error.receipt,
  submit_verification_reason: error.reason,
  retry_safe: error.retry_safe,
});

export class DeliverySafetyGateError extends Error {
  readonly receipt = buildPublicDeliveryReceipt({
    delivery_state: "failed",
    typed: false,
    submit_attempted: false,
    submit_verified: false,
    retry_count: 0,
  });
  readonly delivered = this.receipt.delivered;
  readonly submit_verified = this.receipt.submit_verified;

  constructor(
    readonly error_code:
      | "blocked_by_interactive_prompt"
      | "blocked_by_permission_prompt"
      | "blocked_by_foreign_draft"
      | "owned_boot_contract_pending"
      | "nothing_owned_to_submit"
      | "draft_ownership_unverified"
      | "boot_instance_changed",
    readonly screen: ParsedScreenResult,
    readonly draftText?: string,
  ) {
    super(
      error_code === "draft_ownership_unverified"
        ? "Cannot verify composer ownership from the current frame. Return was not sent; read the pane and retry when its composer is observable."
        : error_code === "boot_instance_changed"
        ? "Managed boot instance changed before recovered Return; no key was sent. Re-read the agent before retrying."
        : error_code === "nothing_owned_to_submit"
        ? "No owned text to submit: this composer could be showing an empty-input hint. Return was not sent."
        : error_code === "blocked_by_permission_prompt"
        ? "delivery blocked by active permission prompt"
        : error_code === "blocked_by_foreign_draft"
          ? `target composer already holds text this delivery did not write: ${JSON.stringify(draftText ?? "unknown")}; the composer holds a draft you didn't write; try again in ~20 s or after your next turn`
        : error_code === "owned_boot_contract_pending"
          ? "The engine-issued boot contract is still pending in this composer. Its Return could not be verified, so no followup text was typed."
        : "target surface has an open picker/menu; refused to type (would be consumed as menu keystrokes)",
    );
    this.name = "DeliverySafetyGateError";
  }
}

export class ManualModeMutationError extends Error {
  readonly error_code = "manual_mode";
  readonly control = "manual";

  constructor(
    readonly tool: string,
    readonly surface?: string,
    readonly workspace?: string,
  ) {
    super(
      `Tool "${tool}" is blocked${
        surface ? ` for surface ${surface}` : ""
      }${workspace ? ` in workspace ${workspace}` : ""}: surface is in manual mode`,
    );
    this.name = "ManualModeMutationError";
  }
}

export const PLACEMENT_WORKSPACE_UNRESOLVED =
  "PLACEMENT_WORKSPACE_UNRESOLVED" as const;

export class BootPromptTimeoutError extends Error {
  constructor(
    message: string,
    readonly last_10_lines: string[],
    readonly pending_input_observed = false,
  ) {
    super(message);
    this.name = "BootPromptTimeoutError";
  }
}

export class LauncherReadinessError extends Error {
  constructor(
    message: string,
    readonly last_10_lines: string[],
  ) {
    super(message);
    this.name = "LauncherReadinessError";
  }
}

export const BOOT_COMPOSER_RESIDUE_READS = 3;

export const BOOT_COMPOSER_RESIDUE_POLL_MS = 500;

export class BootPromptDeliveryError extends Error {
  readonly rpc_methods: DeliveryRpcMethod[];
  readonly typed: boolean;
  readonly submit_dispatched: boolean;

  constructor(
    message: string,
    readonly delivered_chars: number,
    readonly submit_verification_error?: SubmitVerificationError,
    readonly delivery_error?: unknown,
  ) {
    super(message, {
      cause: delivery_error ?? submit_verification_error,
    });
    this.name = "BootPromptDeliveryError";
    const deliveryMethods = deliveryRpcMethodsFromError(delivery_error);
    this.rpc_methods =
      deliveryMethods.length > 0
        ? deliveryMethods
        : deliveryRpcMethodsFromError(submit_verification_error);
    this.typed =
      deliveryTypedFromError(delivery_error) ||
      deliveryTypedFromError(submit_verification_error);
    this.submit_dispatched =
      deliverySubmitDispatchedFromError(delivery_error) ||
      deliverySubmitDispatchedFromError(submit_verification_error);
  }
}

/** #801: a submitted boot prompt left text behind in the composer. */
export class BootComposerResidueError extends BootPromptDeliveryError {
  readonly error_code = "boot_composer_residue";

  constructor(
    message: string,
    delivered_chars: number,
    readonly composer_residue: string,
    evidence: DeliveryErrorEvidence,
    /** The part before the residue was submitted and verified. */
    readonly submit_verified: boolean,
  ) {
    super(message, delivered_chars, undefined, evidence);
    this.name = "BootComposerResidueError";
  }
}

export class BootPromptUpdateMenuBlockedError extends Error {
  readonly error_code = "blocked_by_update_menu";
  readonly recovery: string;

  constructor(
    message: string,
    readonly last_10_lines: string[],
    surface: string,
  ) {
    super(message);
    this.name = "BootPromptUpdateMenuBlockedError";
    this.recovery =
      `First resolve the update menu on ${surface}; cmuxlayer deliberately did not press Return. ` +
      "Then deliver or resume the boot prompt on that same surface instead of rerunning the spawn.";
  }
}

export class SurfaceGoneError extends Error {
  readonly error_code = "pane_died";

  constructor(
    readonly surface: string,
    readonly originalError: unknown,
  ) {
    super(`surface ${surface} disappeared - respawn`);
    this.name = "SurfaceGoneError";
  }
}
