/**
 * MCP tool results: the ok/err result shapes, send_to success shaping, error
 * classification (err), and surface-gone payloads. Moved verbatim from
 * server.ts (CX-2 S3); imports nothing from the server.
 */

import { CmuxSocketError } from "../cmux-socket-error.js";
import { currentTransportRetryCount } from "../transport-retry-context.js";
import { AgentLaunchError, LifecycleLockTimeoutError } from "../engine/types.js";
import { createdIdentityFromError } from "../created-identity.js";
import type { CmuxStatusEntry, ControlMode } from "../types.js";
import {
  deliveryRpcMethodsFromError,
  deliveryTypedFromError,
  deliverySubmitDispatchedFromError,
  defaultNonDeliveryWarning,
  SubmitVerificationError,
  AmbiguousBootRecoveryReturnError,
  submitVerificationFailurePayload,
  DeliverySafetyGateError,
  ManualModeMutationError,
  PLACEMENT_WORKSPACE_UNRESOLVED,
  BootPromptTimeoutError,
  LauncherReadinessError,
  BootPromptDeliveryError,
  SurfaceGoneError,
} from "../delivery/receipts.js";

export type TextContent = { type: "text"; text: string };

export type ToolReturn = {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function readErrorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & {
      code?: unknown;
      stderr?: unknown;
      stdout?: unknown;
      cause?: unknown;
    };
    return [
      error.name,
      error.message,
      typeof extra.code === "string" ? extra.code : "",
      typeof extra.stderr === "string" ? extra.stderr : "",
      typeof extra.stdout === "string" ? extra.stdout : "",
      extra.cause instanceof Error ? extra.cause.message : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return String(error);
}

export function controlModeFromStatusEntries(entries: unknown): ControlMode {
  if (!Array.isArray(entries)) {
    return "autonomous";
  }
  const entry = entries.find((candidate): candidate is CmuxStatusEntry => {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    const maybeEntry = candidate as Partial<CmuxStatusEntry>;
    return maybeEntry.key === "mode.control";
  });
  return entry?.value === "manual" || entry?.value === "autonomous"
    ? entry.value
    : "autonomous";
}

export function screenUnavailableMessage(error: unknown): string {
  return readErrorText(error).replace(
    /^Error\ncmux read-screen failed:\s*/i,
    "",
  );
}

export function isSurfaceGoneReadFailure(error: unknown, surface: string): boolean {
  const text = readErrorText(error).toLowerCase();
  const surfaceLower = surface.toLowerCase();
  if (
    text.includes(`unable to resolve workspace for surface ${surfaceLower}`)
  ) {
    return true;
  }
  if (/\bsurface[-_\s]?not[-_\s]?found\b/.test(text)) {
    return true;
  }
  return /\bnot_found\b/.test(text) && text.includes("surface");
}

export function surfaceGonePayload(
  error: SurfaceGoneError,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    error_code: error.error_code,
    pane_died: true,
    surface: error.surface,
    action: "respawn",
    ...extra,
  };
}

export function ok(data: Record<string, unknown>): ToolReturn {
  const payload = {
    ok: true,
    retry_count: currentTransportRetryCount(),
    ...data,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** ok() variant with formatted human-readable text content */
export function okFormatted(
  formattedText: string,
  data: Record<string, unknown>,
): ToolReturn {
  const payload = {
    ok: true,
    retry_count: currentTransportRetryCount(),
    ...data,
  };
  return {
    content: [{ type: "text", text: formattedText }],
    structuredContent: payload,
  };
}

/** Reduce verified send_to successes without discarding routing or safety state. */
export function shapeSuccessfulSendToResult(
  result: ToolReturn,
  args: Record<string, unknown>,
): ToolReturn {
  const full = result.structuredContent;
  const verifiedSubmit =
    (full?.delivery_state === "submitted" && full.submitted === true) ||
    (args.mode === "key" &&
      full?.submit_attempted === true &&
      full.submit_dispatched === true &&
      full.submit_verified === true);
  if (
    result.isError === true ||
    !full ||
    full.ok !== true ||
    !verifiedSubmit
  ) {
    return result;
  }

  const surfaceMode = args.mode !== "agent";
  const identityKey = surfaceMode ? "surface" : "agent_id";
  const identity =
    full[identityKey] ??
    args[identityKey] ??
    (surfaceMode ? args.target : undefined);
  const receiptFloor = {
    ok: true,
    retry_count:
      typeof full.retry_count === "number"
        ? full.retry_count
        : currentTransportRetryCount(),
    ...(typeof identity === "string" ? { [identityKey]: identity } : {}),
  };
  const lean: Record<string, unknown> = {
    ...receiptFloor,
    ...("caller_agent_id" in full ? { caller_agent_id: full.caller_agent_id } : {}),
    ...(args.mode === "key"
      ? {
          key: full.key ?? args.text,
          submit_verified: full.submit_verified,
          submit_verification_reason:
            full.submit_verification_reason ?? null,
        }
      : {
          delivery_state: "submitted",
          submitted: true,
        }),
    ...(typeof full.delivery_id === "string"
      ? { delivery_id: full.delivery_id }
      : {}),
    ...(full.queued_behind_turn === true ? { queued_behind_turn: true } : {}),
    ...(typeof full.duplicate_of === "string"
      ? { duplicate_of: full.duplicate_of }
      : {}),
    ...(Array.isArray(full.warnings) && full.warnings.length > 0
      ? { warnings: full.warnings }
      : {}),
  };
  return {
    ...result,
    content: [{ type: "text", text: JSON.stringify(lean) }],
    structuredContent: lean,
  };
}

export const __leanReceiptTestHooks = { shapeSuccessfulSendToResult };

export function err(error: unknown, extra: Record<string, unknown> = {}): ToolReturn {
  const message = error instanceof Error ? error.message : String(error);
  const modeExtra =
    error instanceof ManualModeMutationError
      ? {
          error_code: error.error_code,
          tool: error.tool,
          ...(error.surface ? { surface: error.surface } : {}),
          ...(error.workspace ? { workspace: error.workspace } : {}),
          control: error.control,
        }
      : {};
  const deliverySafetyExtra =
    error instanceof DeliverySafetyGateError
      ? {
          ...error.receipt,
          error_code: error.error_code,
          screen: error.screen,
          ...(["nothing_owned_to_submit", "draft_ownership_unverified", "boot_instance_changed"].includes(error.error_code)
            ? { key_dispatched: false, submit_dispatched: false }
            : {}),
        }
      : {};
  const submitVerificationExtra =
    error instanceof SubmitVerificationError
      ? submitVerificationFailurePayload(error)
      : error instanceof BootPromptDeliveryError &&
          error.submit_verification_error
        ? submitVerificationFailurePayload(error.submit_verification_error)
        : {};
  const placementWorkspaceExtra =
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === PLACEMENT_WORKSPACE_UNRESOLVED
      ? { error_code: PLACEMENT_WORKSPACE_UNRESOLVED }
      : {};
  const placementTimeoutExtra =
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "placement_timeout"
      ? { error_code: "placement_timeout", retryable: true }
      : {};
  const placementPendingExtra =
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "placement_pending"
      ? {
          error_code: "placement_pending",
          retryable: true,
          ...("remainingMs" in error &&
          typeof error.remainingMs === "number" &&
          Number.isFinite(error.remainingMs)
            ? { remaining_ms: error.remainingMs }
            : {}),
        }
      : {};
  // #529: the bounded lifecycle timeouts carry a `code` that must reach the
  // tool payload, or automated callers see only free text and cannot tell a
  // bounded control-plane wait from any other failure. Both are retryable.
  const lifecycleTimeoutExtra =
    error instanceof LifecycleStartTimeoutError
      ? { error_code: error.code, waited_ms: error.waitedMs, retryable: true }
      : error instanceof LifecycleLockTimeoutError
        ? {
            error_code: error.code,
            waited_ms: error.waitedMs,
            lock_holder: error.holder,
            held_for_ms: error.heldForMs,
            queue_depth: error.queueDepth,
            retryable: true,
          }
        : {};
  const cmuxUnavailableExtra =
    error instanceof CmuxSocketError && error.code === "cmux_unavailable"
      ? { error_code: "cmux_unavailable", retryable: true }
      : {};
  const readinessTimeout = findErrorInChain(
    error,
    (candidate): candidate is BootPromptTimeoutError | LauncherReadinessError =>
      candidate instanceof BootPromptTimeoutError ||
      candidate instanceof LauncherReadinessError,
  );
  const readinessExtra = readinessTimeout
    ? { last_10_lines: readinessTimeout.last_10_lines }
    : {};
  const rpcMethods = deliveryRpcMethodsFromError(error);
  const deliveryRpcExtra =
    rpcMethods.length > 0 ? { rpc_methods: rpcMethods } : {};
  const deliveryTyped = deliveryTypedFromError(error);
  const deliverySubmitDispatched = deliverySubmitDispatchedFromError(error);
  const deliveryMutationExtra =
    deliveryTyped || deliverySubmitDispatched
      ? {
          typed: deliveryTyped,
          submit_attempted: deliverySubmitDispatched,
          submit_dispatched: deliverySubmitDispatched,
          rpc_methods: rpcMethods,
          WARNING: defaultNonDeliveryWarning(
            "failed",
            rpcMethods,
            deliveryTyped,
            deliverySubmitDispatched,
          ),
        }
      : {};
  const ambiguousBootRecoveryExtra =
    error instanceof AmbiguousBootRecoveryReturnError
      ? { agent_id: error.agentId, ...error.receipt }
      : {};
  const retryMeta =
    error && typeof error === "object"
      ? {
          retry_count:
            "retry_count" in error &&
            typeof (error as { retry_count?: unknown }).retry_count === "number"
              ? (error as { retry_count: number }).retry_count
              : currentTransportRetryCount(),
          ...(error &&
          "transport_state" in error &&
          typeof (error as { transport_state?: unknown }).transport_state ===
            "string"
            ? {
                transport_state: (error as { transport_state: string })
                  .transport_state,
              }
            : {}),
        }
      : { retry_count: currentTransportRetryCount() };
  const payload = {
    ok: false,
    error: message,
    ...retryMeta,
    ...modeExtra,
    ...deliverySafetyExtra,
    ...submitVerificationExtra,
    ...placementWorkspaceExtra,
    ...placementTimeoutExtra,
    ...placementPendingExtra,
    ...lifecycleTimeoutExtra,
    ...cmuxUnavailableExtra,
    ...readinessExtra,
    ...deliveryRpcExtra,
    ...deliveryMutationExtra,
    ...ambiguousBootRecoveryExtra,
    ...extra,
    ...createdIdentityFromError(error),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

export function findErrorInChain<T extends Error>(
  error: unknown,
  predicate: (error: Error) => error is T,
): T | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (predicate(current)) return current;
    seen.add(current);
    current =
      current instanceof AgentLaunchError && current.launch_cause !== undefined
        ? current.launch_cause
        : current.cause;
  }
  return null;
}

export function requireValue(
  value: string | number | undefined,
  message: string,
): asserts value is string | number {
  if (value === undefined || value === "") {
    throw new Error(message);
  }
}

/** Lifecycle initialization never settled inside its bound (#529). */
export class LifecycleStartTimeoutError extends Error {
  readonly code = "ELIFECYCLESTARTTIMEOUT";
  readonly waitedMs: number;

  constructor(waitedMs: number) {
    super(
      `cmuxlayer lifecycle initialization did not complete within ${waitedMs}ms; ` +
        "the daemon or its startup sweep is wedged. " +
        "Retry; if it persists, see control_health.daemon_lifecycle.lifecycle_start.",
    );
    this.name = "LifecycleStartTimeoutError";
    this.waitedMs = waitedMs;
  }
}
