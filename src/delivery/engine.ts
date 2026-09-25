// The delivery engine: pane-input delivery (chunked send, submit verification,
// draft ownership, surface-write locks), boot-prompt delivery and background
// delivery. Moved verbatim out of createServer's closure (CX-3b S9); the
// closure's captured state now arrives as DeliveryEngineDeps.

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getTransportHealth } from "../cmux-transport-self-heal.js";
import { replaceTaskSuffix } from "../naming.js";
import { currentCliFallbackCount, withTransportRetryTracking } from "../transport-retry-context.js";
import { AgentEngine } from "../agent-engine.js";
import { bootContractPointer, coordinationContractPath } from "../coordination-paths.js";
import {
  INTERACTIVE_AGENT_STATES,
  isLiveDeliverable,
  resolveLiveAgentState,
  screenConfirmedAgentState,
} from "../live-agent-state.js";
import type {
  AgentRecord,
  CliType,
  DeliveryEventType,
  DeliveryTelemetryEvent,
} from "../agent-types.js";
import {
  isAntigravityScreen,
  isCodexUpdateMenuScreen,
  isPickerOrMenuScreen,
  parseScreen,
} from "../screen-parser.js";
import {
  launcherFailureFromShell,
  matchesShellPrompt,
  pendingShellPromptInput,
} from "../shell-prompt.js";
import { type InboxOpts } from "../inbox.js";
import { applyHarnessState } from "../harness-session.js";
import { sanitizeTerminalInput } from "../sanitize.js";
import type { ParsedScreenResult } from "../types.js";
import { isSubmitKey, normalizeKeyName } from "../key-names.js";
import {
  bootReadinessDriftNote,
  matchReadyPattern,
  screenHasReadyAgentIdentity,
} from "../pattern-registry.js";
import { invalidateSurfaceTopologyCallScope } from "../surface-topology.js";
import { isBrokenPipeError } from "../surface-write-liveness.js";
import {
  hasInlinePrompt,
  isSubmitVerifiedStatus,
  hasParsedAgentIdentity,
  screenHasAnyAgentIdentity,
  normalizeTerminalText,
  inferComposerCli,
  extractComposerInputRegion,
  screenShowsPendingInput,
  screenShowsCompletePendingInput,
  screenContainsCompleteSubmittedText,
  composerPromptLineInput,
  composerHoldsForeignDraft,
  cursorSubmittedResponseEvidenceSignatures,
  screenShowsFreshCursorResponseAfterSubmittedInput,
  screenShowsQueuedAgentInput,
  countVisibleExactQueuedRows,
  screenShowsCursorFollowupNeedsEnter,
  screenShowsQueuedCursorFollowup,
  screenShowsPendingShellInput,
  classifyPendingLauncherLine,
  parseSubmitEvidenceMetrics,
  composeBootDeliveryText,
  hasRawSubmitEvidenceIncrease,
} from "./composer-screen.js";
import type { RawSubmitEvidenceMetrics } from "./composer-screen.js";
import { BOOT_PROMPT_TIMEOUT_MS } from "../mcp/schemas.js";
import { sleep as delay } from "../util/sleep.js";
import {
  deliveryRpcMethodsFromError,
  deliveryTypedFromError,
  deliverySubmitDispatchedFromError,
  preserveDeliveryEvidenceOnError,
  addDeliveryPhaseTiming,
  timeDeliveryPhase,
  buildPublicDeliveryReceipt,
  defaultNonDeliveryWarning,
  DeliveryError,
  resolveSubmitVerificationFailureReason,
  SubmitVerificationError,
  AmbiguousBootRecoveryReturnError,
  DeliverySafetyGateError,
  BootPromptTimeoutError,
  LauncherReadinessError,
  BOOT_COMPOSER_RESIDUE_READS,
  BOOT_COMPOSER_RESIDUE_POLL_MS,
  BootPromptDeliveryError,
  BootComposerResidueError,
  BootPromptUpdateMenuBlockedError,
  SurfaceGoneError,
} from "./receipts.js";
import type {
  DeliveryStatus,
  SubmitEvidence,
  PublicDeliveryReceipt,
  DeliveryRpcMethod,
  DeliveryPhaseTimings,
  DeliveryRecord,
  SubmitVerificationFailureReason,
  SubmitKeyVerificationReason,
} from "./receipts.js";
import { isSurfaceGoneReadFailure } from "../mcp/tool-result.js";
import {
  SEND_INPUT_CHUNK_THRESHOLD,
  BOOT_PROMPT_PATH_WARNING_CHARS,
  SEND_INPUT_CHUNK_DELAY_MS,
  SEND_INPUT_RETRY_ATTEMPTS,
  SEND_INPUT_RETRY_DELAY_MS,
  SEND_INPUT_ENTER_DELAY_MS,
  SEND_INPUT_RECOVERY_ENTER_DELAY_MS,
  BOOT_PAYLOAD_OBSERVE_TIMEOUT_MS,
  BOOT_PAYLOAD_OBSERVE_AGY_TIMEOUT_MS,
  BOOT_PAYLOAD_OBSERVE_AGY_POLL_MS,
  SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS,
  inlineByteLength,
  SEND_INPUT_MAX_INLINE_CHARS,
  SEND_INPUT_SUBMIT_VERIFY_POLL_MS,
  SEND_KEY_SUBMIT_VERIFY_TIMEOUT_MS,
  CODEX_PENDING_COMPOSER_RETRY_OBSERVE_MS,
  CLAUDE_PENDING_COMPOSER_RETRY_OBSERVE_MS,
  CURSOR_FOLLOWUP_RETRY_OBSERVE_MS,
  SEND_INPUT_SAFE_RETRY_OBSERVE_MS,
  SEND_INPUT_POST_RETRY_VERIFY_GRACE_MS,
  BOOT_PROMPT_READY_POLL_MS,
  BOOT_PROMPT_UPDATE_RELAUNCH_MAX,
  BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS,
  BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS,
  bootPromptUpdateMaxMs,
  LAUNCH_SHELL_READY_TIMEOUT_MS,
  LAUNCH_SHELL_READY_POLL_MS,
  LAUNCH_SHELL_JUNK_CLEAR_INTERVAL_MS,
  LAUNCH_SHELL_JUNK_CLEAR_MAX,
  LAUNCH_SUBMIT_READY_TIMEOUT_MS,
  LAUNCHER_LINE_CORRUPTION_RECOVERY_ATTEMPTS,
  LAUNCHER_LINE_CORRUPTION_ERROR,
  READY_PATTERN_CLIS,
  chunkTerminalInput,
  buildInputDeliveryBatches,
  shouldPasteInputDelivery,
  isMethodNotFoundError,
  pasteRequiredError,
  getBootPromptPath,
  assertBootPromptMode,
} from "./input-policy.js";
import {
  pickLatestSurfaceModel,
  resolveHarnessStateForSurface,
  resolveLatestSurfaceAgentRecord,
  enrichParsedScreen,
} from "./surface-state.js";
import type { CmuxServerContext } from "../mcp/context.js";

export function tailLines(text: string, count: number): string[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-count);
}

export function shouldHandleCodexUpdateMenu(
  cli: CliType | undefined,
  text: string,
): boolean {
  return (
    (cli === undefined || cli === "codex") &&
    (isCodexUpdateMenuScreen(text) ||
      (/^\s*✨?\s*Update available!/m.test(text) &&
        /^\s*Release notes: https:\/\/github\.com\/openai\/codex\/releases\/latest\s*$/m.test(text) &&
        /^[›> ]*1\. Update now\b/m.test(text) &&
        /^\s*Press enter to continue\s*$/m.test(text) &&
        !/\n(?:codex>|» )/.test(text.slice(text.lastIndexOf("Press enter to continue")))))
  );
}

/** The reconstructed menu must be the final complete block of the current pane. */
export function codexUpdateSkipPlan(text: string): { downCount: number; textHash: string } | null {
  const allLines = text.split(/\r?\n/);
  while (allLines.length > 0 && allLines.at(-1)?.trim() === "") allLines.pop();
  const lines = allLines.slice(-9);
  const preamble = allLines.slice(0, -9);
  // Shell launch output is expected above the menu. A second chooser or
  // approval there makes the screen ambiguous even if its final block matches.
  if (preamble.some((line) =>
    /^\s*(?:[›❯>]\s*)?\d+[.)]\s+\S/.test(line) ||
    /(?:update available!|skip until next version|press enter to continue|\b(?:approval|permission|approve|allow|deny|confirm|choose|select|picker|menu)\b)/i.test(line)
  )) return null;
  if (
    lines.length !== 9 ||
    !/^  ✨ Update available! \d+\.\d+\.\d+ -> \d+\.\d+\.\d+$/.test(lines[0] ?? "") ||
    lines[1]?.trim() !== "" ||
    lines[2] !== "  Release notes: https://github.com/openai/codex/releases/latest" ||
    lines[3]?.trim() !== "" ||
    lines[7]?.trim() !== "" ||
    lines[8] !== "  Press enter to continue"
  ) return null;
  const options = [
    "1. Update now (runs `npm install -g @openai/codex@latest`)",
    "2. Skip",
    "3. Skip until next version",
  ];
  let selected = -1;
  for (let index = 0; index < options.length; index += 1) {
    const line = lines[index + 4];
    if (line === `› ${options[index]}`) {
      if (selected !== -1) return null;
      selected = index;
    } else if (line !== `  ${options[index]}`) {
      return null;
    }
  }
  return selected === -1 ? null : {
    downCount: 2 - selected,
    textHash: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
}

export function readyPatternCandidates(cli?: CliType): CliType[] {
  return cli ? [cli] : READY_PATTERN_CLIS;
}

export function requiredBootReadyObservations(
  cli: CliType,
  screenText: string,
): number {
  const registryRequirement = matchReadyPattern(cli, screenText).consecutive;
  if (cli !== "codex" || /(?:^|\n)\s*codex>(?:\s|$)/im.test(screenText)) {
    return registryRequirement;
  }
  return Math.max(2, registryRequirement);
}

export function isRetryableDeliveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /socket|connection_|connection closed|timeout|buffer not found/i.test(
    message,
  );
}

export function computeEnterDelayMs(bytes: number, chunkCount: number): number {
  const extraChunks = Math.max(0, chunkCount - 1);
  const longPayloadPenalty = bytes >= SEND_INPUT_CHUNK_THRESHOLD ? 100 : 0;
  return Math.min(
    250,
    SEND_INPUT_ENTER_DELAY_MS + extraChunks * 50 + longPayloadPenalty,
  );
}

export interface DeliveryEngineDeps {
  context: CmuxServerContext;
  /** createServer's client: context.client with topology-mutation invalidation. */
  client: CmuxServerContext["client"];
  inboxOpts: InboxOpts;
  resolveCurrentCallerAgent: () => AgentRecord | null;
  assertSurfaceMutationAllowed: (
    toolName: string,
    surface: string,
    workspace?: string,
  ) => Promise<void>;
  successfulDispatchRpcMethod: (
    method: DeliveryRpcMethod,
    cliFallbackCountBeforeDispatch: number,
  ) => DeliveryRpcMethod | null;
  /**
   * Must forward, not capture: createServer reassigns its publisher once the
   * agent lifecycle is wired.
   */
  lifecycleSeatManifestPublisher: (input: {
    agentId?: string;
    surfaceId?: string;
    surfaceUuid?: string;
    tabName?: string;
    model?: string;
  }) => Promise<void>;
}

export function createDeliveryEngine(deps: DeliveryEngineDeps) {
  const {
    context,
    client,
    inboxOpts,
    resolveCurrentCallerAgent,
    assertSurfaceMutationAllowed,
    successfulDispatchRpcMethod,
    lifecycleSeatManifestPublisher,
  } = deps;
  const stateMgr = context.stateMgr;
  const eventLog = context.eventLog;
  const deliveries = context.deliveries;
  const latestDeliveryBySurface = context.latestDeliveryBySurface;
  const activeDeliveryBySurface = context.activeDeliveryBySurface;
  const activeSurfaceWrites = context.activeSurfaceWrites;
  const launchShellRecoveryBySurface = context.launchShellRecoveryBySurface;
  const surfaceWriteLiveness = context.surfaceWriteLiveness;
  const surfaceWriteLivenessCandidates = context.surfaceWriteLivenessCandidates;
  const surfacePtyDeadSince = context.surfacePtyDeadSince;


  const snapshotDelivery = (record: DeliveryRecord) => {
    const warning = defaultNonDeliveryWarning(
      record.status === "failed" || record.status === "pending_verify"
        ? record.status : undefined,
      record.rpc_methods,
      record.typed,
      record.submit_dispatched,
    );
    return {
      delivery_id: record.delivery_id,
      surface: record.surface,
      status: record.status,
      sent_chunks: record.sent_chunks,
      total_chunks: record.total_chunks,
      chunk_size: record.chunk_size,
      started_at: record.started_at,
      completed_at: record.completed_at ?? null,
      failed_chunk: record.failed_chunk ?? null,
      error: record.error ?? null,
      submit_verified: record.submit_verified,
      submit_verification_reason: record.submit_verification_reason ?? null,
      retry_safe: record.retry_safe ?? null,
      retry_count: record.retry_count,
      rpc_methods: [...record.rpc_methods],
      typed: record.typed,
      submit_dispatched: record.submit_dispatched,
      ...(warning ? { WARNING: warning } : {}),
    };
  };

  const getSurfaceDelivery = (surface: string) => {
    const deliveryId = latestDeliveryBySurface.get(surface);
    if (!deliveryId) {
      return null;
    }

    const record = deliveries.get(deliveryId);
    return record ? snapshotDelivery(record) : null;
  };

  const getSurfaceWriteConflict = (surface: string) => {
    const activeDeliveryId = activeDeliveryBySurface.get(surface);
    if (activeDeliveryId) {
      const record = deliveries.get(activeDeliveryId);
      if (record?.status === "delivering") {
        return new Error(
          `delivery ${activeDeliveryId} is still in progress for ${surface}`,
        );
      }

      activeDeliveryBySurface.delete(surface);
    }

    if (activeSurfaceWrites.has(surface)) {
      return new Error(`surface ${surface} is busy`);
    }

    return null;
  };

  const acquireSurfaceWrite = (surface: string, owner: string) => {
    const conflict = getSurfaceWriteConflict(surface);
    if (conflict) {
      throw conflict;
    }

    activeSurfaceWrites.set(surface, owner);
  };

  const releaseSurfaceWrite = (surface: string, owner: string) => {
    if (activeSurfaceWrites.get(surface) === owner) {
      activeSurfaceWrites.delete(surface);
    }
  };

  const recordSurfaceWriteSuccess = (
    surface: string,
    stableSurfaceIdentity?: string | null,
    surfaceObserverIdentity?: string | null,
  ): void => {
    surfaceWriteLiveness.recordSuccess(
      surface,
      stableSurfaceIdentity,
      surfaceObserverIdentity,
    );
    if (stableSurfaceIdentity || surfaceObserverIdentity) {
      // Preserve ref-only telemetry for control-health consumers. Mutating
      // decisions use the identity-scoped observation and never fall back.
      surfaceWriteLiveness.recordSuccess(surface);
    }
    surfaceWriteLivenessCandidates.delete(surface);
    surfacePtyDeadSince.delete(surface);
  };

  const recordSurfaceWriteFailure = (
    surface: string,
    error: unknown,
    stableSurfaceIdentity?: string | null,
    surfaceObserverIdentity?: string | null,
  ): void => {
    if (!isBrokenPipeError(error)) return;
    surfaceWriteLiveness.recordFailure(
      surface,
      error,
      stableSurfaceIdentity,
      surfaceObserverIdentity,
    );
    if (stableSurfaceIdentity || surfaceObserverIdentity) {
      surfaceWriteLiveness.recordFailure(surface, error);
    }
    const observation = surfaceWriteLiveness.observe(
      surface,
      stableSurfaceIdentity,
      surfaceObserverIdentity,
    );
    if (!observation || observation.consecutive_broken_pipe_failures === 0) {
      surfaceWriteLivenessCandidates.delete(surface);
      surfacePtyDeadSince.delete(surface);
      return;
    }
    if (!observation.pty_dead) {
      surfaceWriteLivenessCandidates.delete(surface);
      surfacePtyDeadSince.delete(surface);
      return;
    }
    surfaceWriteLivenessCandidates.add(surface);
    if (!surfacePtyDeadSince.has(surface)) {
      surfacePtyDeadSince.set(surface, observation.last_attempt_at);
    }
  };

  const withSurfaceWrite = async <T>(
    surface: string,
    fn: () => Promise<T>,
    opts: {
      toolName?: string;
      workspace?: string;
      owner?: string;
      observePtyWrite?: boolean;
      stableSurfaceIdentity?: string | null;
      lockKey?: string;
      timings?: DeliveryPhaseTimings;
    } = {},
  ): Promise<T> => {
    if (opts.toolName) {
      await assertSurfaceMutationAllowed(
        opts.toolName,
        surface,
        opts.workspace,
      );
    }
    const owner = opts.owner ?? `surface-write:${randomUUID()}`;
    // Capture the ref-only provenance before the async write. A reconnect or
    // socket replacement after the attempt must not relabel its liveness.
    const surfaceObserverIdentity = context.surfaceObserverId;
    const lockKey =
      opts.lockKey ??
      (opts.stableSurfaceIdentity
        ? `uuid:${opts.stableSurfaceIdentity.toLowerCase()}`
        : surface);
    const lockStartedAt = Date.now();
    acquireSurfaceWrite(lockKey, owner);
    addDeliveryPhaseTiming(opts.timings, "lock", lockStartedAt);
    const lockHoldStartedAt = Date.now();
    let result: T | undefined;
    try {
      result = await fn();
      if (opts.observePtyWrite) {
        recordSurfaceWriteSuccess(
          surface,
          opts.stableSurfaceIdentity,
          surfaceObserverIdentity,
        );
      }
      return result;
    } catch (error) {
      if (opts.observePtyWrite) {
        recordSurfaceWriteFailure(
          surface,
          error,
          opts.stableSurfaceIdentity,
          surfaceObserverIdentity,
        );
      }
      throw error;
    } finally {
      addDeliveryPhaseTiming(opts.timings, "lock_hold", lockHoldStartedAt);
      const timedResult = result as
        { timings_ms?: DeliveryPhaseTimings } | undefined;
      if (timedResult?.timings_ms && opts.timings) {
        timedResult.timings_ms.lock_hold = opts.timings.lock_hold;
      }
      releaseSurfaceWrite(lockKey, owner);
    }
  };

  const pruneCompletedDeliveryHistory = (surface: string) => {
    const latestDeliveryId = latestDeliveryBySurface.get(surface);
    for (const [deliveryId, record] of deliveries.entries()) {
      if (record.surface !== surface) continue;
      if (deliveryId === latestDeliveryId) continue;
      if (record.status === "delivering") continue;
      deliveries.delete(deliveryId);
    }
  };

  const finishDelivery = (
    record: DeliveryRecord,
    status: DeliveryStatus,
    error?: string,
    failedChunk?: number,
  ) => {
    if (status === "delivered") {
      recordSurfaceWriteSuccess(
        record.surface,
        record.stableSurfaceIdentity,
        record.surfaceObserverIdentity,
      );
    } else if (status === "failed") {
      recordSurfaceWriteFailure(
        record.surface,
        error,
        record.stableSurfaceIdentity,
        record.surfaceObserverIdentity,
      );
    }
    record.status = status;
    record.completed_at = new Date().toISOString();
    record.error = error;
    record.failed_chunk = failedChunk;
    record.chunks = [];
    latestDeliveryBySurface.set(record.surface, record.delivery_id);
    if (activeDeliveryBySurface.get(record.surface) === record.delivery_id) {
      activeDeliveryBySurface.delete(record.surface);
    }
    releaseSurfaceWrite(record.lockKey ?? record.surface, record.delivery_id);
    pruneCompletedDeliveryHistory(record.surface);
  };

  const sendChunkWithRetry = async (
    surface: string,
    chunk: string,
    opts: { workspace?: string },
    chunkNumber: number,
    totalChunks: number,
    shouldPaste: boolean,
    avoidDuplicateOnAmbiguousRetry: boolean,
    beforeMutation?: () => Promise<void>,
  ): Promise<DeliveryRpcMethod | null> => {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < SEND_INPUT_RETRY_ATTEMPTS) {
      let attemptedRpcMethod: DeliveryRpcMethod | null = null;
      let cliFallbackCountBeforeDispatch = currentCliFallbackCount();
      try {
        await beforeMutation?.();
        cliFallbackCountBeforeDispatch = currentCliFallbackCount();
        attemptedRpcMethod =
          getTransportHealth(client)?.mode === "socket"
            ? "surface.send_text"
            : null;
        if (shouldPaste) {
          if (typeof client.pasteText !== "function") {
            throw pasteRequiredError("client does not support pasteText");
          }
          try {
            await client.pasteText(surface, chunk, opts);
          } catch (error) {
            if (isMethodNotFoundError(error)) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw pasteRequiredError(`pasteText is unavailable (${message})`);
            }
            throw error;
          }
        } else {
          await client.send(surface, chunk, opts);
        }
        invalidateSurfaceTopologyCallScope(client as object);
        return successfulDispatchRpcMethod(
          "surface.send_text",
          cliFallbackCountBeforeDispatch,
        );
      } catch (error) {
        if (currentCliFallbackCount() !== cliFallbackCountBeforeDispatch) {
          attemptedRpcMethod = null;
        }
        lastError = error;
        attempt += 1;
        if (
          !isRetryableDeliveryError(error) ||
          attempt >= SEND_INPUT_RETRY_ATTEMPTS
        ) {
          const rawMessage =
            error instanceof Error ? error.message : String(error);
          const message = shouldPaste
            ? pasteRequiredError(rawMessage).message
            : rawMessage;
          throw new DeliveryError(
            `chunk ${chunkNumber}/${totalChunks} failed: ${message}`,
            chunkNumber,
            error,
          );
        }
        if (avoidDuplicateOnAmbiguousRetry) {
          const observationStartedAt = Date.now();
          while (
            Date.now() - observationStartedAt <
            SEND_INPUT_SAFE_RETRY_OBSERVE_MS
          ) {
            try {
              const snapshot = await readParsedSurface(
                surface,
                opts.workspace,
                { throwOnSurfaceGone: true },
              );
              if (
                snapshot &&
                (screenShowsPendingInput(snapshot.text, chunk) ||
                  screenShowsPendingShellInput(snapshot.text, chunk))
              ) {
                return attemptedRpcMethod;
              }
            } catch (observeError) {
              if (observeError instanceof SurfaceGoneError) {
                throw observeError;
              }
              // Keep observing until the bounded deadline. Retrying the text
              // mutation after an unreadable pane can concatenate launchers.
            }

            const remainingMs =
              SEND_INPUT_SAFE_RETRY_OBSERVE_MS -
              (Date.now() - observationStartedAt);
            if (remainingMs <= 0) break;
            await delay(
              Math.min(SEND_INPUT_SUBMIT_VERIFY_POLL_MS, remainingMs),
            );
          }

          const message =
            error instanceof Error ? error.message : String(error);
          throw new DeliveryError(
            `chunk ${chunkNumber}/${totalChunks} acknowledgement was ambiguous and launcher text was not retried: ${message}`,
            chunkNumber,
            error,
          );
        }
        await delay(SEND_INPUT_RETRY_DELAY_MS);
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new DeliveryError(
      `chunk ${chunkNumber}/${totalChunks} failed: ${message}`,
      chunkNumber,
      lastError,
    );
  };

  const sendKeyWithRetry = async (
    surface: string,
    key: string,
    workspace?: string,
    beforeMutation?: () => Promise<void>,
    maxAttempts = SEND_INPUT_RETRY_ATTEMPTS,
  ): Promise<DeliveryRpcMethod | null> => {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
        await beforeMutation?.();
        const cliFallbackCountBeforeDispatch = currentCliFallbackCount();
        await client.sendKey(surface, key, { workspace });
        invalidateSurfaceTopologyCallScope(client as object);
        return successfulDispatchRpcMethod(
          "surface.send_key",
          cliFallbackCountBeforeDispatch,
        );
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (
          !isRetryableDeliveryError(error) ||
          attempt >= maxAttempts
        ) {
          throw error;
        }
        await delay(SEND_INPUT_RETRY_DELAY_MS);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to send key ${key} to ${surface}`);
  };

  const appendDeliveryEvent = (event: Omit<DeliveryTelemetryEvent, "ts">) => {
    eventLog.appendDelivery({
      ts: new Date().toISOString(),
      ...event,
    });
  };

  // Tokens authorize a single manual Return after an observed-empty text-only
  // send. Identical clear/retype entirely between snapshots is unobservable.
  const typedDraftOwners = context.typedDraftOwners;
  const draftOwnerKey = (surface: string, workspace?: string, uuid?: string | null) =>
    JSON.stringify([workspace ?? null, uuid ?? surface]);
  const draftTargetFingerprint = (surface: string, uuid?: string | null) => {
    const record = resolveLatestSurfaceAgentRecord(stateMgr, surface, uuid);
    return JSON.stringify([record?.agent_id ?? null, record?.cli ?? null, record?.cli_session_id ?? null]);
  };
  const observedSurfaceUuid = (surface: string): string | null =>
    context.capturedSurfaceUuidByRef.get(surface) ?? (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(surface) ? surface : null);
  const observeDraftOwnership = (surface: string, workspace: string | undefined, text: string, uuid: string | null): void => {
    for (const [key, token] of typedDraftOwners) {
      const matches = token.uuid ? uuid?.toLowerCase() === token.uuid.toLowerCase()
        : token.ref === surface && token.workspace === (workspace ?? null);
      if (!matches) continue;
      const record = resolveLatestSurfaceAgentRecord(stateMgr, surface, uuid);
      const region = extractComposerInputRegion(text, token.text, record?.cli, true);
      // A truncated read without a composer anchor observes no draft state.
      if (region === null) continue;
      const unchanged = region === normalizeTerminalText(token.text).trimEnd();
      const renderingPrefix = !token.seen && region !== null && normalizeTerminalText(token.text).startsWith(region);
      if (draftTargetFingerprint(surface, uuid) !== token.fp || (!unchanged && !renderingPrefix)) typedDraftOwners.delete(key);
      else if (unchanged) token.seen = true;
    }
  };

  const readParsedSurface = async (
    surface: string,
    workspace?: string,
    opts?: { throwOnSurfaceGone?: boolean; agent?: AgentRecord },
  ): Promise<{ text: string; parsed: ParsedScreenResult } | null> => {
    try {
      const screen = await client.readScreen(surface, {
        ...(workspace ? { workspace } : {}),
        lines: 30,
      });
      const text = typeof screen === "string" ? screen : (screen.text ?? "");
      observeDraftOwnership(surface, workspace, text, observedSurfaceUuid(surface));
      const parsed = applyHarnessState(
        enrichParsedScreen(
          parseScreen(text),
          text,
          pickLatestSurfaceModel(stateMgr, surface),
        ),
        resolveHarnessStateForSurface(stateMgr, surface, opts?.agent),
      );
      return { text, parsed };
    } catch (error) {
      if (
        opts?.throwOnSurfaceGone &&
        isSurfaceGoneReadFailure(error, surface)
      ) {
        throw new SurfaceGoneError(surface, error);
      }
      return null;
    }
  };

  const shouldVerifyRawSurfaceSubmit = async (
    record: AgentRecord | undefined,
    surface: string,
    workspace?: string,
  ): Promise<boolean> => {
    if (!record) return false;
    if (INTERACTIVE_AGENT_STATES.has(record.state)) return true;
    // The registry may still say working after the screen has returned to a
    // ready prompt. Check that target directly before deciding whether a
    // surface-mode receipt can verify its Return.
    const snapshot = await readParsedSurface(surface, workspace, { agent: record });
    return isLiveDeliverable(
      resolveLiveAgentState(
        record,
        snapshot
          ? {
              status: snapshot.parsed.status,
              agent_type: snapshot.parsed.agent_type,
              control_state: snapshot.parsed.control_state,
              errors: snapshot.parsed.errors,
            }
          : null,
      ),
    );
  };

  const liveTrackedSurfaceIsDeliverable = (
    record: AgentRecord | undefined,
    snapshot: { parsed: ParsedScreenResult } | null,
  ): boolean => {
    if (!record) return false;
    if (INTERACTIVE_AGENT_STATES.has(record.state)) return true;
    // This decides whether to verify the Return already requested for a raw
    // tracked surface. A live ready composer warrants that read even when the
    // lifecycle registry has not advanced past booting yet.
    return !!snapshot && screenConfirmedAgentState(snapshot.parsed) === "ready";
  };

  const assertDeliveryTargetIsSafe = async (opts: {
    surface: string;
    workspace?: string;
    cli?: CliType;
    /** When set, also refuse a composer already holding someone else's text. */
    draftGuardText?: string;
  }): Promise<{ text: string; parsed: ParsedScreenResult } | null> => {
    const { surface, workspace, cli } = opts;
    const snapshot = await readParsedSurface(surface, workspace, {
      throwOnSurfaceGone: true,
    });
    if (!snapshot) {
      return null;
    }

    if (snapshot.parsed.control_state === "permission_prompt") {
      throw new DeliverySafetyGateError(
        "blocked_by_permission_prompt",
        snapshot.parsed,
      );
    }

    if (isPickerOrMenuScreen(snapshot.text, cli)) {
      throw new DeliverySafetyGateError(
        "blocked_by_interactive_prompt",
        snapshot.parsed,
      );
    }

    // AIDEV-NOTE (T2 #442): a composer that already holds text nobody in this
    // delivery wrote is a human (or another agent) mid-draft. Typing into it
    // concatenates, and the Return that follows SUBMITS their words. The
    // picker/permission gates above never covered this: the screen is a
    // perfectly ordinary ready composer, it just is not empty. Refuse before
    // the first keystroke -- a refused send is recoverable, a submitted draft
    // is not.
    //
    // Refusal is terminal for this caller: the pre-type snapshot proves the
    // requested bytes cannot be appended safely. Queuing that refusal reports
    // `accepted:true` even though the guard deliberately performed no pane
    // mutation, and can later submit text the caller never authorized.
    if (
      opts.draftGuardText !== undefined &&
      composerHoldsForeignDraft(snapshot.text, opts.draftGuardText, { cli })
    ) {
      throw new DeliverySafetyGateError(
        "blocked_by_foreign_draft",
        snapshot.parsed,
        extractComposerInputRegion(snapshot.text)?.trim() || undefined,
      );
    }

    return snapshot;
  };

  const maybeRenameTask = async (opts: {
    surface: string;
    workspace?: string;
    rename_to_task?: string;
    stableSurfaceIdentity?: string | null;
    beforeMutation?: () => Promise<void>;
  }) => {
    if (!opts.rename_to_task) {
      return;
    }

    const surfaces = await client.listPaneSurfaces({
      workspace: opts.workspace,
    });
    const surface = surfaces.surfaces.find((s) => s.ref === opts.surface);
    const currentTitle = surface?.title ?? "";
    const newTitle = replaceTaskSuffix(currentTitle, opts.rename_to_task);
    await opts.beforeMutation?.();
    await client.renameTab(opts.surface, newTitle, {
      workspace: opts.workspace,
    });
    await lifecycleSeatManifestPublisher({
      surfaceId: opts.surface,
      ...(opts.stableSurfaceIdentity
        ? { surfaceUuid: opts.stableSurfaceIdentity }
        : {}),
      tabName: newTitle,
    });
  };

  const waitForCompletePayloadInComposer = async (opts: {
    surface: string;
    workspace?: string;
    text: string;
    timeout_ms: number;
    beforeRead?: () => Promise<void>;
  }): Promise<{
    screenText: string;
    metrics: RawSubmitEvidenceMetrics;
  } | null> => {
    // One slow CLI read can consume the old 250ms deadline while returning a
    // pre-paste frame. Three bounded reads allow a stale frame and a repaint;
    // short caller deadlines still get only one read.
    const readLimit = opts.timeout_ms >= BOOT_PAYLOAD_OBSERVE_TIMEOUT_MS
      ? 3 : 1;
    const startedAt = Date.now();
    for (let read = 0; ; read += 1) {
      await opts.beforeRead?.();
      const snapshot = await readParsedSurface(opts.surface, opts.workspace, {
        throwOnSurfaceGone: true,
      });
      if (
        snapshot &&
        screenShowsCompletePendingInput(snapshot.text, opts.text)
      ) {
        return {
          screenText: snapshot.text,
          metrics: parseSubmitEvidenceMetrics(snapshot.text, snapshot.parsed),
        };
      }
      // #801 gate 1: agy's Bubble Tea textarea repainted a 150-char paste only
      // after the 3-read window (surface:947), so Return was never pressed.
      // Antigravity panes alone keep polling; other CLIs keep the #511 budget.
      const antigravity =
        snapshot !== null && isAntigravityScreen(normalizeTerminalText(snapshot.text));
      if (antigravity) {
        if (Date.now() - startedAt >= BOOT_PAYLOAD_OBSERVE_AGY_TIMEOUT_MS) break;
        await delay(BOOT_PAYLOAD_OBSERVE_AGY_POLL_MS);
        continue;
      }
      if (read + 1 >= readLimit) break;
      await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
    }
    return null;
  };

  const verifySubmitAfterEnter = async (opts: {
    surface: string;
    workspace?: string;
    text: string;
    bytes: number;
    source_event: DeliveryEventType;
    source_agent?: string | null;
    verify_submit: boolean;
    require_working_status?: boolean;
    require_attributable_submit_evidence?: boolean;
    allow_recovery_enter_retry?: boolean;
    timeout_ms?: number;
    cursor_response_baseline: readonly string[] | null;
    pre_type_screen?: string | null;
    pre_return_screen?: string | null;
    pre_return_metrics?: RawSubmitEvidenceMetrics | null;
    beforeMutation?: () => Promise<void>;
    rpcMethods: Set<DeliveryRpcMethod>;
  }): Promise<{
    submit_verified: boolean | null;
    submit_evidence: SubmitEvidence | null;
    submit_verification_reason: SubmitVerificationFailureReason | null;
    retry_count: number;
    delivery:
      "submitted" | "queued" | "queued_followup" | "rescued" | "pending_verify";
  }> => {
    if (!opts.verify_submit) {
      // null means submit verification was not attempted, usually because the
      // command was at or below SEND_INPUT_CHUNK_THRESHOLD; it is not a failure.
      return {
        submit_verified: null,
        submit_evidence: null,
        submit_verification_reason: null,
        retry_count: 0,
        delivery: "submitted",
      };
    }

    let timeoutMs = opts.timeout_ms ?? SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS;
    // Once verification is requested, missing or inconclusive evidence is a
    // failed verification. The spawn launcher probe remains advisory because
    // agent-readiness detection is authoritative for that one internal path.
    const noSubmitEvidenceResult =
      opts.source_event === "spawn_agent" ? null : false;
    const startedAt = Date.now();
    let retried = false;
    let retryCount = 0;
    let sawClearedComposerEvidence = false;
    let sawAllowedClearedComposerEvidence = false;
    let lastHasPendingSubmitEvidence = false;
    let lastRetryEligiblePendingInput = false;
    let retryEligiblePendingSince: number | null = null;
    let retriedAt: number | null = null;
    let sawReadableScreen = false;
    let sawBlankScreen = false;
    let lastBootConsumptionRefuted = false;
    const interruptMarkerCount = (screenText: string | null | undefined) =>
      screenText?.match(/Conversation interrupted/gi)?.length ?? 0;
    // The pre-Return frame is the current marker epoch. A stale marker may be
    // visible before typing and then scroll away while the composer fills; a
    // later marker is a new interrupt even when its ordinal matches the stale
    // pre-type occurrence.
    const preReturnInterruptMarkers = interruptMarkerCount(
      opts.pre_return_screen,
    );
    let sawNewInterrupt = false;
    const screenIncludesSubmittedText = (screenText: string): boolean =>
      screenContainsCompleteSubmittedText(screenText, opts.text);

    while (Date.now() - startedAt < timeoutMs) {
      await opts.beforeMutation?.();
      const snapshot = await readParsedSurface(opts.surface, opts.workspace, {
        throwOnSurfaceGone: true,
      });
      if (!snapshot) {
        await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
        continue;
      }

      if (!snapshot.text.trim()) {
        sawBlankScreen = true;
        await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
        continue;
      }
      sawReadableScreen = true;
      sawNewInterrupt ||=
        interruptMarkerCount(snapshot.text) > preReturnInterruptMarkers;

      const hasPendingInput =
        opts.require_attributable_submit_evidence === true
          ? screenShowsCompletePendingInput(snapshot.text, opts.text)
          : screenShowsPendingInput(snapshot.text, opts.text);
      const hasQueuedAgentInput = screenShowsQueuedAgentInput(
        snapshot.text,
        opts.text,
      );
      if (hasQueuedAgentInput) {
        if (
          opts.source_event !== "send_to" &&
          opts.source_event !== "dispatch_nudge" &&
          opts.source_event !== "report_to_parent"
        ) {
          return {
            submit_verified: false,
            submit_evidence: null,
            submit_verification_reason: "input_still_pending",
            retry_count: retryCount,
            delivery: "submitted",
          };
        }
        return {
          submit_verified: null,
          submit_evidence: null,
          submit_verification_reason: null,
          retry_count: retryCount,
          delivery: "queued",
        };
      }
      if (
        (opts.source_event === "send_to" ||
          opts.source_event === "dispatch_nudge" ||
          opts.source_event === "report_to_parent") &&
        screenShowsQueuedCursorFollowup(snapshot.text, opts.text)
      ) {
        return {
          submit_verified: null,
          submit_evidence: null,
          submit_verification_reason: null,
          retry_count: retryCount,
          delivery: "queued_followup",
        };
      }
      // AIDEV-NOTE (T2 #427): `0 tokens` is a definitive negative. An agent
      // handed a prompt that has consumed nothing did not receive it, whatever
      // the composer looks like -- a slow boot can render a working-looking
      // banner while the CLI is still initialising, and that race produced
      // `submit_verified: true` receipts for prompts that never left the
      // composer. A NULL token count stays inconclusive on purpose: several
      // CLIs never report one, and treating unknown as zero would turn this
      // guard into a fleet-wide false negative.
      const bootConsumptionRefuted =
        opts.require_working_status === true &&
        snapshot.parsed.token_count === 0;
      lastBootConsumptionRefuted = bootConsumptionRefuted;
      const screenCli = inferComposerCli(snapshot.text, snapshot.parsed);
      const cursorShowsSubmittedResponse =
        screenCli === "cursor" &&
        screenShowsFreshCursorResponseAfterSubmittedInput(
          snapshot.text,
          opts.text,
          opts.cursor_response_baseline,
        );
      const hasPendingSubmitEvidence =
        hasPendingInput && !cursorShowsSubmittedResponse;
      lastHasPendingSubmitEvidence = hasPendingSubmitEvidence;
      const composerInput = extractComposerInputRegion(snapshot.text);
      const preReturnComposerInput =
        opts.pre_return_screen === null || opts.pre_return_screen === undefined
          ? null
          : extractComposerInputRegion(opts.pre_return_screen);
      const bootFrameAdvanced =
        opts.require_attributable_submit_evidence === true &&
        opts.pre_return_screen !== null &&
        opts.pre_return_screen !== undefined &&
        normalizeTerminalText(snapshot.text) !==
          normalizeTerminalText(opts.pre_return_screen);
      const bootComposerAdvanced =
        opts.require_attributable_submit_evidence === true &&
        preReturnComposerInput !== null &&
        composerInput !== null &&
        normalizeTerminalText(composerInput) !==
          normalizeTerminalText(preReturnComposerInput);
      const bootFrameIsMonotonic =
        bootComposerAdvanced &&
        (opts.pre_type_screen === null ||
          opts.pre_type_screen === undefined ||
          normalizeTerminalText(snapshot.text) !==
            normalizeTerminalText(opts.pre_type_screen));
      const bootHasTokenOrCostDelta =
        opts.require_attributable_submit_evidence === true &&
        hasRawSubmitEvidenceIncrease(
          parseSubmitEvidenceMetrics(snapshot.text, snapshot.parsed),
          opts.pre_return_metrics,
        );
      const bootHasTranscriptEcho =
        opts.require_attributable_submit_evidence === true &&
        bootFrameAdvanced &&
        !hasPendingSubmitEvidence &&
        screenIncludesSubmittedText(snapshot.text);
      const interruptedHasTranscriptEcho =
        bootHasTranscriptEcho ||
        (opts.require_attributable_submit_evidence !== true &&
          !hasPendingSubmitEvidence &&
          screenIncludesSubmittedText(snapshot.text));
      if (
        sawNewInterrupt &&
        !hasPendingSubmitEvidence &&
        (interruptedHasTranscriptEcho || bootHasTokenOrCostDelta)
      ) {
        return {
          submit_verified: false,
          submit_evidence: interruptedHasTranscriptEcho
            ? "transcript_echo"
            : "token_delta",
          submit_verification_reason: null,
          retry_count: retryCount,
          delivery: "rescued",
        };
      }
      if (
        !sawNewInterrupt &&
        !hasPendingSubmitEvidence &&
        !bootConsumptionRefuted &&
        ((opts.require_attributable_submit_evidence !== true &&
          isSubmitVerifiedStatus(snapshot.parsed.status)) ||
          bootHasTokenOrCostDelta ||
          bootHasTranscriptEcho ||
          cursorShowsSubmittedResponse)
      ) {
        const submitEvidence: SubmitEvidence = bootHasTokenOrCostDelta
          ? "token_delta"
          : bootHasTranscriptEcho || cursorShowsSubmittedResponse
            ? "transcript_echo"
            : "status_only";
        return {
          submit_verified: true,
          submit_evidence: submitEvidence,
          submit_verification_reason: null,
          retry_count: retryCount,
          delivery: "submitted",
        };
      }
      const hasClearedAgentComposer =
        composerInput !== null &&
        composerInput.trim() === "" &&
        !hasPendingSubmitEvidence &&
        !bootConsumptionRefuted &&
        (opts.require_attributable_submit_evidence !== true ||
          bootFrameIsMonotonic) &&
        screenHasAnyAgentIdentity(snapshot.text, snapshot.parsed);
      if (hasClearedAgentComposer) {
        sawClearedComposerEvidence = true;
        const allowClearedComposerSubmitEvidence =
          opts.source_event !== "spawn_agent" ||
          !screenIncludesSubmittedText(snapshot.text);
        if (allowClearedComposerSubmitEvidence && !sawNewInterrupt) {
          sawAllowedClearedComposerEvidence = true;
          return {
            submit_verified: true,
            submit_evidence: "cleared_composer",
            submit_verification_reason: null,
            retry_count: retryCount,
            delivery: "submitted",
          };
        }
      }

      const shouldRetryEnter =
        hasPendingInput ||
        (opts.source_event === "spawn_agent" &&
          screenIncludesSubmittedText(snapshot.text));
      const spawnRetryEligiblePendingInput =
        opts.allow_recovery_enter_retry !== false &&
        shouldRetryEnter &&
        !screenHasAnyAgentIdentity(snapshot.text, snapshot.parsed) &&
        opts.source_event === "spawn_agent" &&
        !hasParsedAgentIdentity(snapshot.parsed);
      const agentRetryEligiblePendingInput =
        opts.allow_recovery_enter_retry !== false &&
        (opts.source_event === "send_to" ||
          opts.source_event === "dispatch_nudge" ||
          opts.source_event === "report_to_parent" ||
          opts.source_event === "boot_prompt") &&
        hasPendingSubmitEvidence &&
        (screenCli === "codex" ||
          (screenCli === "claude" &&
            !isSubmitVerifiedStatus(snapshot.parsed.status)));
      if (
        agentRetryEligiblePendingInput &&
        screenCli === "claude" &&
        opts.source_event !== "boot_prompt"
      ) {
        // Short-pointer verification normally exits quickly, but once the exact
        // Claude draft is still pending, allow the full retry observation window.
        timeoutMs = Math.max(
          timeoutMs,
          CLAUDE_PENDING_COMPOSER_RETRY_OBSERVE_MS +
            SEND_INPUT_RECOVERY_ENTER_DELAY_MS +
            SEND_INPUT_POST_RETRY_VERIFY_GRACE_MS,
        );
      }
      const cursorFollowupRetryEligiblePendingInput =
        opts.allow_recovery_enter_retry !== false &&
        (opts.source_event === "send_to" ||
          opts.source_event === "dispatch_nudge" ||
          opts.source_event === "report_to_parent") &&
        hasPendingSubmitEvidence &&
        screenCli === "cursor" &&
        screenShowsCursorFollowupNeedsEnter(snapshot.text);
      const retryEligiblePendingInput =
        spawnRetryEligiblePendingInput ||
        agentRetryEligiblePendingInput ||
        cursorFollowupRetryEligiblePendingInput;
      lastRetryEligiblePendingInput = retryEligiblePendingInput;
      if (retryEligiblePendingInput) {
        retryEligiblePendingSince ??= Date.now();
      } else {
        retryEligiblePendingSince = null;
      }
      const retryObserveMs = cursorFollowupRetryEligiblePendingInput
        ? Math.min(timeoutMs, CURSOR_FOLLOWUP_RETRY_OBSERVE_MS)
        : agentRetryEligiblePendingInput
          ? Math.min(
              timeoutMs,
              screenCli === "claude" && opts.source_event !== "boot_prompt"
                ? CLAUDE_PENDING_COMPOSER_RETRY_OBSERVE_MS
                : CODEX_PENDING_COMPOSER_RETRY_OBSERVE_MS,
            )
          : opts.source_event === "spawn_agent" &&
              !hasParsedAgentIdentity(snapshot.parsed)
            ? 0
            : Math.min(timeoutMs, SEND_INPUT_SAFE_RETRY_OBSERVE_MS);

      // Pending input is ambiguous: the first Return may have been missed, or
      // it may have landed while a slow agent has not repainted the composer
      // yet. Observe before retrying, and only retry an idle agent composer that
      // still definitively holds the original text.
      if (
        !retried &&
        retryEligiblePendingInput &&
        retryEligiblePendingSince !== null &&
        Date.now() - retryEligiblePendingSince >= retryObserveMs
      ) {
        await delay(SEND_INPUT_RECOVERY_ENTER_DELAY_MS);
        const recoveryRpcMethod = await sendKeyWithRetry(
          opts.surface,
          "return",
          opts.workspace,
          opts.beforeMutation,
        );
        if (recoveryRpcMethod) opts.rpcMethods.add(recoveryRpcMethod);
        retryCount += 1;
        appendDeliveryEvent({
          event_type: "press_enter",
          source_agent: opts.source_agent ?? null,
          target_surface: opts.surface,
          bytes: opts.bytes,
          press_enter: true,
          submit_verified: null,
          retry_count: retryCount,
        });
        retried = true;
        retriedAt = Date.now();
        continue;
      }

      if (
        retriedAt !== null &&
        retryEligiblePendingInput &&
        Date.now() - retriedAt >= SEND_INPUT_POST_RETRY_VERIFY_GRACE_MS
      ) {
        if (sawNewInterrupt) {
          return {
            submit_verified: false,
            submit_evidence: null,
            submit_verification_reason: null,
            retry_count: retryCount,
            delivery: "rescued",
          };
        }
        return {
          submit_verified: false,
          submit_evidence: null,
          submit_verification_reason: "input_still_pending",
          retry_count: retryCount,
          delivery:
            opts.source_event === "boot_prompt"
              ? "submitted"
              : opts.source_event === "send_to" ||
            opts.source_event === "dispatch_nudge" ||
            opts.source_event === "report_to_parent" ||
            opts.require_attributable_submit_evidence === true
              ? "pending_verify"
              : "submitted",
        };
      }

      await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
    }
    // A latched interrupt is terminal evidence that this verifier cannot
    // attribute the task turn. Never hand it to the marker-unaware background
    // verifier as pending_verify, where an empty composer could false-green it.
    if (sawNewInterrupt) {
      return {
        submit_verified: false,
        submit_evidence: null,
        submit_verification_reason: null,
        retry_count: retryCount,
        delivery: "rescued",
      };
    }
    if (sawClearedComposerEvidence && sawAllowedClearedComposerEvidence) {
      return {
        submit_verified: true,
        submit_evidence: "cleared_composer",
        submit_verification_reason: null,
        retry_count: retryCount,
        delivery: "submitted",
      };
    }

    const submitVerified =
      opts.require_working_status ||
      lastHasPendingSubmitEvidence ||
      lastRetryEligiblePendingInput ||
      !sawReadableScreen
        ? false
        : noSubmitEvidenceResult;
    const failureReason: SubmitVerificationFailureReason | null =
      submitVerified === false
        ? resolveSubmitVerificationFailureReason({
            sawPendingInput:
              lastHasPendingSubmitEvidence || lastRetryEligiblePendingInput,
            sawReadableScreen,
            sawBlankScreen,
            bootConsumptionRefuted: lastBootConsumptionRefuted,
            requireWorkingStatus: opts.require_working_status === true,
          })
        : null;
    const allowPendingVerify =
      opts.source_event === "send_to" ||
      opts.source_event === "dispatch_nudge" ||
      opts.source_event === "report_to_parent" ||
      opts.require_attributable_submit_evidence === true;
    if (allowPendingVerify && submitVerified === false) {
      return {
        submit_verified: null,
        submit_evidence: null,
        // Keep the internal reason long enough for the delivery engine to
        // preserve same-caller ownership of an exact draft that visibly
        // remains in the composer. The public pending receipt is still
        // intentionally reasonless/nonterminal below.
        submit_verification_reason: failureReason,
        retry_count: retryCount,
        delivery: "pending_verify",
      };
    }
    return {
      submit_verified: submitVerified,
      submit_evidence: null,
      submit_verification_reason: failureReason,
      retry_count: retryCount,
      delivery: "submitted",
    };
  };

  /**
   * AIDEV-NOTE (#484/#500): key mode writes no payload, so post-key composer
   * contents cannot prove whether this key landed. Positive evidence comes
   * from an observed state transition (especially permission_prompt being
   * dismissed) or a composer observed populated before the key and empty
   * afterward; otherwise the result stays unknown rather than inventing
   * `composer_still_populated`.
   */
  const verifySubmitKeyOutcome = async (opts: {
    surface: string;
    workspace?: string;
    baseline: { text: string; parsed: ParsedScreenResult } | null;
  }): Promise<{
    submit_verified: boolean | null;
    submit_verification_reason: SubmitKeyVerificationReason | null;
  }> => {
    const baselineComposerInput =
      opts.baseline === null
        ? null
        : extractComposerInputRegion(opts.baseline.text);
    if (
      opts.baseline?.parsed.control_state !== "permission_prompt" &&
      baselineComposerInput !== null &&
      baselineComposerInput.trim() === ""
    ) {
      return {
        submit_verified: null,
        submit_verification_reason: "submit_evidence_absent",
      };
    }

    const startedAt = Date.now();
    let sawReadableScreen = false;

    while (Date.now() - startedAt < SEND_KEY_SUBMIT_VERIFY_TIMEOUT_MS) {
      const snapshot = await readParsedSurface(opts.surface, opts.workspace);
      if (!snapshot || !snapshot.text.trim()) {
        await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
        continue;
      }
      sawReadableScreen = true;
      if (
        opts.baseline?.parsed.control_state === "permission_prompt" &&
        snapshot.parsed.control_state !== "permission_prompt"
      ) {
        return { submit_verified: true, submit_verification_reason: null };
      }
      const composerInput = extractComposerInputRegion(snapshot.text);
      const transitionedFromIdleDraftToWorking =
        opts.baseline !== null &&
        baselineComposerInput !== null &&
        baselineComposerInput.trim() !== "" &&
        !isSubmitVerifiedStatus(opts.baseline.parsed.status) &&
        isSubmitVerifiedStatus(snapshot.parsed.status) &&
        (composerInput === null || composerInput.trim() === "");
      if (
        baselineComposerInput !== null &&
        baselineComposerInput.trim() !== "" &&
        ((composerInput !== null && composerInput.trim() === "") ||
          transitionedFromIdleDraftToWorking)
      ) {
        // The composer was populated before Return and is now empty, or a
        // previously idle draft transitioned to working while its composer
        // disappeared. A pre-existing working status alone still does not
        // count: it cannot distinguish this submit from the previous turn.
        return { submit_verified: true, submit_verification_reason: null };
      }
      await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
    }

    if (!sawReadableScreen) {
      return {
        submit_verified: null,
        submit_verification_reason: "surface_read_unavailable",
      };
    }
    return {
      submit_verified: null,
      submit_verification_reason: "submit_evidence_absent",
    };
  };

  const executeDeliveryEngine = async (opts: {
    surface: string;
    workspace?: string;
    chunks: string[];
    key?: string;
    /** Engine-only proof; never mapped from tool arguments or exposed by schema. */
    engineSubmitProof?: "launcher_pending_command";
    chunk_size: number;
    chunk_delay_ms: number;
    press_enter: boolean;
    rename_to_task?: string;
    onChunkDelivered?: (sentChunks: number) => void;
    source_event?: DeliveryEventType;
    source_agent?: string | null;
    delivery_id?: string;
    verify_submit?: boolean;
    verify_submit_for_tracked_surface?: AgentRecord;
    allow_recovery_enter_retry?: boolean;
    require_observed_payload_before_enter?: boolean;
    submit_verify_timeout_ms?: number;
    stableSurfaceIdentity?: string | null;
    beforeMutation?: () => Promise<void>;
    timings?: DeliveryPhaseTimings;
  }): Promise<
    PublicDeliveryReceipt & {
      bytes: number;
      /** Present only on the key path: the key really reached the pane. */
      key_dispatched?: boolean;
      submit_verification_reason?: SubmitKeyVerificationReason | null;
    }
  > => {
    const rpcMethods = new Set<DeliveryRpcMethod>();
    let textDispatched = false;
    let submitDispatched = false;
    try {
      await opts.beforeMutation?.();
      if (opts.key !== undefined) {
      if (opts.chunks.length > 0 || opts.press_enter) {
        throw new Error(
          "Delivery engine key input is mutually exclusive with text submission",
        );
      }
      const key = normalizeKeyName(opts.key);
      const targetAgent = resolveLatestSurfaceAgentRecord(stateMgr, opts.surface, opts.stableSurfaceIdentity);
      const targetCli = targetAgent?.cli;
      const submitAttempted = isSubmitKey(key);
      const ownerKey = draftOwnerKey(opts.surface, opts.workspace, opts.stableSurfaceIdentity);
      const submitBaseline = submitAttempted && !opts.engineSubmitProof
        ? await readParsedSurface(opts.surface, opts.workspace) : null;
      const callerSubmit = submitAttempted && !opts.engineSubmitProof;
      const eligibleQueuedReceipts = callerSubmit && targetAgent && submitBaseline &&
        targetCli === "codex"
        ? context.lifecycleSweepEngine?.listDeliveryReceipts().filter((receipt) =>
            receipt.agent_id === targetAgent.agent_id &&
            receipt.delivery_state === "queued" &&
            receipt.composer_accepted === true &&
            receipt.press_enter
          ) ?? []
        : [];
      const ownedQueuedReceipt = submitBaseline
        ? eligibleQueuedReceipts.find((receipt) => {
            const visibleCount = countVisibleExactQueuedRows(
              submitBaseline.text,
              receipt.text,
            );
            const ownedCount = eligibleQueuedReceipts.filter(
              (candidate) => candidate.text === receipt.text,
            ).length;
            return visibleCount === 1 && visibleCount <= ownedCount &&
              screenShowsQueuedAgentInput(submitBaseline.text, receipt.text, { exact: true });
          })
        : undefined;
      if (callerSubmit && (!submitBaseline || !submitBaseline.text.trim() ||
          (targetCli && ["claude", "codex", "cursor"].includes(targetCli) &&
            submitBaseline.parsed.control_state !== "permission_prompt" && !isPickerOrMenuScreen(submitBaseline.text) &&
            extractComposerInputRegion(submitBaseline.text, undefined, targetCli, true) === null &&
            !ownedQueuedReceipt))) {
        typedDraftOwners.delete(ownerKey);
        throw new DeliverySafetyGateError("draft_ownership_unverified", submitBaseline?.parsed ?? parseScreen(""));
      }
      if (callerSubmit && submitBaseline &&
          submitBaseline.parsed.control_state !== "permission_prompt" &&
          !isPickerOrMenuScreen(submitBaseline.text)) {
        const owner = typedDraftOwners.get(ownerKey);
        const caller = resolveCurrentCallerAgent()?.agent_id;
        const ownedText = caller && owner?.caller === caller && owner.fp === draftTargetFingerprint(opts.surface, opts.stableSurfaceIdentity) && Date.now() - owner.at < 300_000 ? owner.text : (ownedQueuedReceipt?.text ?? "");
        const rawInput = extractComposerInputRegion(submitBaseline.text, undefined, targetCli, true);
        const normalizedInput = extractComposerInputRegion(submitBaseline.text, undefined, targetCli);
        if ((!ownedQueuedReceipt || normalizedInput !== "") && composerHoldsForeignDraft(submitBaseline.text, ownedText, { cli: targetCli, exact: true })) {
          typedDraftOwners.delete(ownerKey);
          throw new DeliverySafetyGateError("blocked_by_foreign_draft", submitBaseline.parsed, extractComposerInputRegion(submitBaseline.text, undefined, targetCli)?.trim());
        }
        if (!ownedQueuedReceipt && rawInput?.trim() && extractComposerInputRegion(submitBaseline.text, ownedText, targetCli) === "") {
          throw new DeliverySafetyGateError("nothing_owned_to_submit", submitBaseline.parsed);
        }
        if (!composerHoldsForeignDraft(submitBaseline.text, "", { cli: targetCli })) typedDraftOwners.delete(ownerKey);
      }
      // Spend before dispatch, including ambiguous ACKs and verification.
      if (submitAttempted) typedDraftOwners.delete(ownerKey);
      // sendKeyWithRetry throws when nothing reached the pane, so reaching the
      // next line is the dispatch evidence the receipt was missing (#484).
      const keyRpcMethod = await timeDeliveryPhase(opts.timings, "type", () =>
        sendKeyWithRetry(
          opts.surface,
          key,
          opts.workspace,
          opts.beforeMutation,
          submitAttempted ? 1 : SEND_INPUT_RETRY_ATTEMPTS,
        ),
      );
      submitDispatched = submitAttempted;
      if (keyRpcMethod) rpcMethods.add(keyRpcMethod);
      const verification =
        submitAttempted && opts.verify_submit
          ? await timeDeliveryPhase(opts.timings, "verify", () =>
              verifySubmitKeyOutcome({
                surface: opts.surface,
                workspace: opts.workspace,
                baseline: submitBaseline,
              }),
            )
          : { submit_verified: null, submit_verification_reason: null };
      if (verification.submit_verified === true) {
        typedDraftOwners.delete(draftOwnerKey(opts.surface, opts.workspace, opts.stableSurfaceIdentity));
      }
      const receipt = buildPublicDeliveryReceipt({
        typed: false,
        submit_attempted: submitAttempted,
        submit_dispatched: submitDispatched,
        submit_verified: verification.submit_verified,
        retry_count: 0,
        rpc_methods: [...rpcMethods],
        timings_ms: opts.timings,
        ...(submitAttempted && verification.submit_verified === null
          ? {
              WARNING:
                "SUBMIT NOT VERIFIED — the key was dispatched, but no " +
                "observable prompt/composer transition confirmed submission. " +
                "Do not treat ok:true as submission confirmation.",
            }
          : {}),
      });
      if (opts.source_event) {
        appendDeliveryEvent({
          event_type: opts.source_event,
          source_agent: opts.source_agent ?? null,
          target_surface: opts.surface,
          bytes: 0,
          press_enter: submitAttempted,
          submit_verified: verification.submit_verified,
          retry_count: 0,
        });
      }
      return {
        ...receipt,
        key_dispatched: true,
        submit_verification_reason: verification.submit_verification_reason,
        bytes: 0,
      };
    }
    // AIDEV-NOTE (T2 #442): the draft guard covers the caller-initiated relay
    // paths, where refusing is cheap and a foreign draft is a live risk. Boot
    // and cwd delivery run against a pane cmuxlayer just launched, where the
    // only text on screen is the launcher's own echo -- refusing there would
    // break spawn, not protect a human.
    const draftGuardedEvent =
      opts.source_event === "send_to" ||
      opts.source_event === "send_to_agent" ||
      opts.source_event === "send_input" ||
      opts.source_event === "dispatch_nudge" ||
      opts.source_event === "report_to_parent" ||
      opts.source_event === "interact";
    const draftGuardText = opts.chunks.join("");
    const pendingBootAgent = resolveLatestSurfaceAgentRecord(
      stateMgr, opts.surface, opts.stableSurfaceIdentity,
    );
    const targetCli = pendingBootAgent?.cli;
    if (
      draftGuardedEvent &&
      pendingBootAgent?.cli === "claude" &&
      pendingBootAgent.boot_prompt_pending === true &&
      pendingBootAgent.prompt_delivered !== true
    ) {
      // A previous split boot can leave only our own contract pointer in the
      // composer after the brief was submitted. Match the exact derived line
      // for this bound agent before sending a guarded recovery Return. Any
      // changed draft stays under the ordinary foreign-draft refusal below.
      const pointer = bootContractPointer(
        pendingBootAgent.agent_id,
        coordinationContractPath(pendingBootAgent.agent_id, inboxOpts),
      );
      const persistedBoot = stateMgr.readState(pendingBootAgent.agent_id);
      if (!persistedBoot || persistedBoot.boot_prompt_pending !== true ||
        persistedBoot.prompt_delivered === true) {
        throw new Error("Managed boot changed before pointer recovery; no Return was sent");
      }
      // Older in-flight boot records may predate the instance marker. Stamp
      // one before the first await, so a later boot cannot inherit this Return.
      const boundBoot = persistedBoot.boot_instance_id
        ? persistedBoot
        : stateMgr.updateRecord(persistedBoot.agent_id, {
            boot_prompt_pending: true,
          });
      const recoveryBootInstanceId = boundBoot.boot_instance_id;
      if (!recoveryBootInstanceId) {
        throw new Error("Cannot bind recovered Return to a managed boot instance");
      }
      if (boundBoot !== persistedBoot) {
        context.lifecycleSweepEngine?.getRegistry().set(boundBoot.agent_id, boundBoot);
      }
      const pending = await readParsedSurface(opts.surface, opts.workspace, {
        throwOnSurfaceGone: true,
      });
      // The parser correctly calls a non-empty Claude composer dirty. This
      // boot's exact pointer is the one exception: durable boot ownership and
      // an exact composer match let us submit it before the caller's followup.
      const pendingHoldsOwnedPointer = pending &&
        screenShowsCompletePendingInput(pending.text, pointer) &&
        !composerHoldsForeignDraft(pending.text, pointer, {
          cli: "claude",
          exact: true,
        });
      if (
        pendingHoldsOwnedPointer &&
        (pending.parsed.control_state === "ready" ||
          pending.parsed.control_state === "composer_dirty")
      ) {
        const assertOwnedPointerBeforeReturn = async () => {
          await opts.beforeMutation?.();
          const current = await readParsedSurface(opts.surface, opts.workspace, {
            throwOnSurfaceGone: true,
          });
          if (!current || (current.parsed.control_state !== "ready" &&
            current.parsed.control_state !== "composer_dirty")) {
            throw new DeliverySafetyGateError(
              "draft_ownership_unverified", current?.parsed ?? pending.parsed,
            );
          }
          const recordAtReturn = stateMgr.readState(pendingBootAgent.agent_id);
          if (!recordAtReturn ||
            recordAtReturn.boot_instance_id !== recoveryBootInstanceId ||
            recordAtReturn.boot_prompt_pending !== true ||
            recordAtReturn.prompt_delivered === true) {
            throw new DeliverySafetyGateError(
              "boot_instance_changed", current.parsed,
            );
          }
          if (
            !screenShowsCompletePendingInput(current.text, pointer) ||
            composerHoldsForeignDraft(current.text, pointer, {
              cli: "claude",
              exact: true,
            })
          ) {
            throw new DeliverySafetyGateError(
              "blocked_by_foreign_draft",
              current.parsed,
              extractComposerInputRegion(current.text, undefined, "claude")?.trim() || undefined,
            );
          }
        };
        let returnDispatchStarted = false;
        let method: DeliveryRpcMethod | null;
        try {
          method = await sendKeyWithRetry(
            opts.surface, "return", opts.workspace, async () => {
              await assertOwnedPointerBeforeReturn();
              returnDispatchStarted = true;
            }, 1,
          );
        } catch (error) {
          // The ownership guard failed before mutation, or the one Return may
          // have landed while its acknowledgement was lost. Only the latter
          // is uncertain; never issue another Return or type the followup.
          if (!returnDispatchStarted) throw error;
          throw new AmbiguousBootRecoveryReturnError(pointer, recoveryBootInstanceId, pendingBootAgent.agent_id, error);
        }
        // The recovery Return was acknowledged, even though this call has not
        // typed the caller's followup and submission verification can fail.
        submitDispatched = true;
        if (method) rpcMethods.add(method);
        const verification = await verifySubmitAfterEnter({
          surface: opts.surface,
          workspace: opts.workspace,
          text: pointer,
          bytes: Buffer.byteLength(pointer, "utf8"),
          source_event: "boot_prompt",
          verify_submit: true,
          require_attributable_submit_evidence: true,
          require_working_status: true,
          allow_recovery_enter_retry: false,
          timeout_ms: SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS,
          cursor_response_baseline: null,
          pre_type_screen: pending.text,
          pre_return_screen: pending.text,
          pre_return_metrics: parseSubmitEvidenceMetrics(pending.text, pending.parsed),
          beforeMutation: opts.beforeMutation,
          rpcMethods,
        });
        if (verification.submit_verified !== true) {
          throw new DeliverySafetyGateError("owned_boot_contract_pending", pending.parsed, pointer);
        }
        const recordAfterReturn = stateMgr.readState(pendingBootAgent.agent_id);
        if (!recordAfterReturn ||
          recordAfterReturn.boot_instance_id !== recoveryBootInstanceId ||
          recordAfterReturn.boot_prompt_pending !== true ||
          recordAfterReturn.prompt_delivered === true) {
          throw new AmbiguousBootRecoveryReturnError(
            pointer, recoveryBootInstanceId, pendingBootAgent.agent_id,
            new Error("Managed boot changed after recovered Return"),
          );
        }
        let updated = stateMgr.updateRecord(pendingBootAgent.agent_id, {
          boot_prompt_pending: false,
          prompt_delivered: true,
          submit_verified: true,
        });
        // Recovery has verified the managed boot submission. Complete its
        // lifecycle through valid transitions so the followup can be tracked
        // as working instead of leaving the record stuck in booting.
        if (updated.state === "booting") {
          updated = stateMgr.transition(updated.agent_id, "ready");
        }
        if (updated.state === "ready") {
          updated = stateMgr.transition(updated.agent_id, "working");
        }
        context.lifecycleSweepEngine?.getRegistry().set(updated.agent_id, updated);
      }
    }
    const deliverySafetySnapshot = await assertDeliveryTargetIsSafe({
      surface: opts.surface,
      workspace: opts.workspace,
      cli: targetCli,
      ...(draftGuardedEvent && draftGuardText.trim().length > 0
        ? { draftGuardText }
        : {}),
    });
    // This screen read is already required by the safety gate and occurs under
    // the surface write lock. Reuse it for raw tracked-surface verification.
    const verifySubmit =
      opts.verify_submit === true ||
      liveTrackedSurfaceIsDeliverable(
        opts.verify_submit_for_tracked_surface,
        deliverySafetySnapshot,
      );
    // Boot delivery is always attributable. Established relay paths retain
    // their lighter verification unless an existing interrupt marker makes a
    // later marker ambiguous; in that collision case, observe the payload
    // before Return so `rescued` is both reachable and correctly attributed.
    const requireObservedPayloadBeforeEnter =
      opts.require_observed_payload_before_enter === true &&
      (opts.source_event === "boot_prompt" ||
        /Conversation interrupted/i.test(deliverySafetySnapshot?.text ?? ""));
    const deliveryBatches = buildInputDeliveryBatches(opts.chunks);
    const shouldPaste = shouldPasteInputDelivery(
      opts.chunks,
      deliveryBatches.length,
    );
    await timeDeliveryPhase(opts.timings, "type", async () => {
      for (const [index, batch] of deliveryBatches.entries()) {
        const chunkRpcMethod = await sendChunkWithRetry(
          opts.surface,
          batch.text,
          {
            workspace: opts.workspace,
          },
          batch.firstChunkNumber,
          opts.chunks.length,
          shouldPaste,
          opts.source_event === "spawn_agent",
          opts.beforeMutation,
        );
        if (batch.text.length > 0) textDispatched = true;
        if (chunkRpcMethod) rpcMethods.add(chunkRpcMethod);
        for (const sentChunks of batch.deliveredChunkCounts) {
          opts.onChunkDelivered?.(sentChunks);
        }
        if (index < deliveryBatches.length - 1) {
          await delay(opts.chunk_delay_ms);
        }
      }
    });

    const bytes = opts.chunks.reduce(
      (sum, chunk) => sum + Buffer.byteLength(chunk, "utf-8"),
      0,
    );
    const submittedText = opts.chunks.join("");
    const ownerKey = draftOwnerKey(opts.surface, opts.workspace, opts.stableSurfaceIdentity);
    const caller = resolveCurrentCallerAgent()?.agent_id;
    const beforeDraft = deliverySafetySnapshot ? composerPromptLineInput(deliverySafetySnapshot.text, targetCli)?.trim() : null;
    if (textDispatched && !opts.press_enter && caller && beforeDraft === "") {
      typedDraftOwners.delete(ownerKey);
      if (typedDraftOwners.size >= 128) typedDraftOwners.delete(typedDraftOwners.keys().next().value!);
      typedDraftOwners.set(ownerKey, { caller, text: submittedText, at: Date.now(),
        ref: opts.surface, uuid: opts.stableSurfaceIdentity ?? null, workspace: opts.workspace ?? null,
        fp: draftTargetFingerprint(opts.surface, opts.stableSurfaceIdentity), seen: false });
    } else if (textDispatched) typedDraftOwners.delete(ownerKey);
    let submit_verified: boolean | null = null;
    let submit_evidence: SubmitEvidence | null = null;
    let submit_verification_reason: SubmitVerificationFailureReason | null =
      null;
    let ownedDraftPending = false;
    let retry_count = 0;
    let deliveryOutcome:
      | "submitted"
      | "queued"
      | "queued_followup"
      | "rescued"
      | "pending_verify" = "submitted";

    if (opts.press_enter) {
      let cursorResponseBaseline: readonly string[] | null = null;
      const preReturnBootEvidence =
        requireObservedPayloadBeforeEnter && verifySubmit
          ? await waitForCompletePayloadInComposer({
              surface: opts.surface,
              workspace: opts.workspace,
              text: submittedText,
              timeout_ms: Math.min(
                opts.submit_verify_timeout_ms ??
                  SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS,
                BOOT_PAYLOAD_OBSERVE_TIMEOUT_MS,
              ),
              beforeRead: opts.beforeMutation,
            })
          : null;
      if (
        requireObservedPayloadBeforeEnter &&
        verifySubmit &&
        preReturnBootEvidence === null
      ) {
        submit_verified = null;
        submit_verification_reason = null;
        deliveryOutcome = "pending_verify";
      } else {
        if (
          verifySubmit &&
          deliverySafetySnapshot &&
          inferComposerCli(
            deliverySafetySnapshot.text,
            deliverySafetySnapshot.parsed,
          ) === "cursor"
        ) {
          await opts.beforeMutation?.();
          const preReturnSnapshot = await readParsedSurface(
            opts.surface,
            opts.workspace,
            { throwOnSurfaceGone: true },
          );
          cursorResponseBaseline = preReturnSnapshot
            ? cursorSubmittedResponseEvidenceSignatures(
                preReturnSnapshot.text,
                submittedText,
              )
            : null;
        }
        await timeDeliveryPhase(opts.timings, "type", async () => {
          await delay(computeEnterDelayMs(bytes, opts.chunks.length));
          const submitRpcMethod = await sendKeyWithRetry(
            opts.surface,
            "return",
            opts.workspace,
            opts.beforeMutation,
          );
          submitDispatched = true;
          if (submitRpcMethod) rpcMethods.add(submitRpcMethod);
        });
        appendDeliveryEvent({
          event_type: "press_enter",
          source_agent: opts.source_agent ?? null,
          target_surface: opts.surface,
          bytes,
          press_enter: true,
          submit_verified: null,
          retry_count,
        });

        const verification = await timeDeliveryPhase(
          opts.timings,
          "verify",
          () =>
            verifySubmitAfterEnter({
              surface: opts.surface,
              workspace: opts.workspace,
              text: submittedText,
              bytes,
              source_event: opts.source_event ?? "send_command",
              source_agent: opts.source_agent,
              verify_submit: verifySubmit,
              allow_recovery_enter_retry: opts.allow_recovery_enter_retry,
              timeout_ms: opts.submit_verify_timeout_ms,
              cursor_response_baseline: cursorResponseBaseline,
              pre_type_screen: deliverySafetySnapshot?.text,
              pre_return_screen: preReturnBootEvidence?.screenText,
              pre_return_metrics: preReturnBootEvidence?.metrics,
              require_attributable_submit_evidence:
                requireObservedPayloadBeforeEnter,
              require_working_status: opts.source_event === "boot_prompt",
              beforeMutation: opts.beforeMutation,
              rpcMethods,
            }),
        );
        submit_verified = verification.submit_verified;
        submit_evidence = verification.submit_evidence;
        submit_verification_reason = verification.submit_verification_reason;
        ownedDraftPending =
          verification.submit_verification_reason === "input_still_pending";
        retry_count = verification.retry_count;
        deliveryOutcome = verification.delivery;
        if (
          deliveryOutcome === "pending_verify" ||
          deliveryOutcome === "queued_followup"
        ) {
          submit_verified = null;
          submit_evidence = null;
          submit_verification_reason = null;
        }
      }
    }

    await maybeRenameTask({
      surface: opts.surface,
      workspace: opts.workspace,
      rename_to_task: opts.rename_to_task,
      stableSurfaceIdentity: opts.stableSurfaceIdentity,
      beforeMutation: opts.beforeMutation,
    });

    if (opts.source_event) {
      appendDeliveryEvent({
        event_type: opts.source_event,
        source_agent: opts.source_agent ?? null,
        target_surface: opts.surface,
        bytes,
        press_enter: opts.press_enter,
        submit_verified,
        retry_count,
        ...(opts.delivery_id
          ? {
              delivery_id: opts.delivery_id,
              delivery_state: !opts.press_enter
                ? ("typed" as const)
                : deliveryOutcome === "queued"
                  ? ("queued" as const)
                  : deliveryOutcome === "queued_followup"
                    ? ("queued_followup" as const)
                    : deliveryOutcome === "pending_verify"
                      ? ("pending_verify" as const)
                      : deliveryOutcome === "rescued"
                        ? ("rescued" as const)
                        : submit_verified === false
                          ? ("failed" as const)
                          : ("submitted" as const),
            }
          : {}),
      });
    }

    if (submit_verified === true) typedDraftOwners.delete(ownerKey);
    else if (
      textDispatched &&
      opts.press_enter &&
      ownedDraftPending &&
      targetCli === "claude" &&
      caller
    ) {
      if (typedDraftOwners.size >= 128) typedDraftOwners.delete(typedDraftOwners.keys().next().value!);
      typedDraftOwners.set(ownerKey, {
        caller,
        text: submittedText,
        at: Date.now(),
        ref: opts.surface,
        uuid: opts.stableSurfaceIdentity ?? null,
        workspace: opts.workspace ?? null,
        fp: draftTargetFingerprint(opts.surface, opts.stableSurfaceIdentity),
        seen: true,
      });
    }
    const receipt = buildPublicDeliveryReceipt({
      delivery_state: !opts.press_enter
        ? "typed"
        : deliveryOutcome === "queued"
          ? "queued"
          : deliveryOutcome === "queued_followup"
            ? "queued_followup"
            : deliveryOutcome === "pending_verify"
              ? "pending_verify"
              : deliveryOutcome === "rescued"
                ? "rescued"
                : submit_verified === true
                  ? "submitted"
                  : !verifySubmit
                    ? "typed"
                    : undefined,
      delivery_id: opts.delivery_id,
      typed: bytes > 0,
      submit_attempted: Boolean(opts.press_enter),
      submit_dispatched: submitDispatched,
      submit_verified,
      submit_evidence,
      retry_count,
      rpc_methods: [...rpcMethods],
      timings_ms: opts.timings,
      WARNING:
        opts.press_enter &&
        submit_verified === null &&
        !verifySubmit
          ? "NOT VERIFIED — Return was dispatched, but submission was not verified; this receipt confirms only that text was typed."
          : undefined,
    });

    if (
      submit_verified === false &&
      deliveryOutcome !== "queued" &&
      deliveryOutcome !== "queued_followup" &&
      deliveryOutcome !== "rescued" &&
      deliveryOutcome !== "pending_verify"
    ) {
      const timeoutMs =
        opts.submit_verify_timeout_ms ?? SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS;
      throw new SubmitVerificationError(
        `Enter submit could not be verified for ${opts.surface} within ${timeoutMs}ms`,
        retry_count,
        submit_verification_reason ?? "submit_evidence_absent",
        receipt,
      );
    }

      return { ...receipt, bytes };
    } catch (error) {
      if (error instanceof AmbiguousBootRecoveryReturnError) {
        // Every managed caller of this dispatch boundary needs the same
        // pointer receipt. The caller's followup was never typed and must not
        // replace this pending boot recovery with a terminal failed receipt.
        const receipt = context.lifecycleSweepEngine?.acceptPendingVerify({
          delivery_id: opts.delivery_id ?? randomUUID(),
          agent_id: error.agentId,
          text: error.pointer,
          press_enter: true,
          source_event: "boot_prompt",
          retry_count: 0,
          typed: true,
          boot_recovery: true,
          boot_instance_id: error.bootInstanceId,
        });
        if (receipt) {
          error.receipt = buildPublicDeliveryReceipt({
            delivery_state: "pending_verify",
            delivery_id: receipt.delivery_id,
            typed: true,
            submit_attempted: true,
            submit_verified: null,
            retry_count: 0,
            timings_ms: opts.timings,
            WARNING:
              "Recovered boot Return may have landed, but its acknowledgement was lost. " +
              "The followup was not typed. No Return will be retried automatically; " +
              "inspect the pane or wait_for({delivery_id}) before sending again.",
          });
        }
      }
      throw preserveDeliveryEvidenceOnError(
        error,
        rpcMethods,
        textDispatched,
        submitDispatched,
      );
    }
  };

  const waitForBootPromptReady = async (opts: {
    surface: string;
    workspace?: string;
    stableSurfaceIdentity?: string | null;
    initialUpdateMenuTextHash?: string;
    cli?: CliType;
    text: string;
    timeout_ms: number;
    onUpdateShellRelaunch?: () => Promise<void>;
    resolveRoute?: () => Promise<{ surface: string; workspace?: string }>;
    assertStableSurfaceIdentity?: () => Promise<void>;
  }): Promise<{
    delivery_state: "ready" | "queued";
    metrics: RawSubmitEvidenceMetrics | null;
    route: { surface: string; workspace?: string };
    cli: CliType;
    updateMenuTextHash?: string;
    observation?: NonNullable<PublicDeliveryReceipt["observation"]>;
  }> => {
    let deadline = Date.now() + opts.timeout_ms;
    let lastText = "";
    let lastSurface = opts.surface;
    const consecutiveMatches = new Map<CliType, number>();
    const candidates = readyPatternCandidates(opts.cli);
    let updateStartedAt: number | null = null;
    let updateElapsedMs = 0;
    let updateWasSeen = false;
    let updateShellRelaunches = 0;
    let updateMenuTextHash = opts.initialUpdateMenuTextHash;
    type QueuedBootObservation = {
      metrics: RawSubmitEvidenceMetrics;
      route: { surface: string; workspace?: string };
      cli: CliType;
      observation: NonNullable<PublicDeliveryReceipt["observation"]>;
    };
    let queuedObservation: QueuedBootObservation | null = null;
    const updateMaxMs = bootPromptUpdateMaxMs();
    const postUpdateReadyBudgetMs = () =>
      Math.max(opts.timeout_ms, BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS);

    while (Date.now() < deadline || updateStartedAt !== null) {
      let target: { surface: string; workspace?: string } = {
        surface: opts.surface,
        workspace: opts.workspace,
      };
      let selectingUpdateMenu = false;
      try {
        target = opts.resolveRoute ? await opts.resolveRoute() : target;
        lastSurface = target.surface;
        const screen = await client.readScreen(target.surface, {
          workspace: target.workspace,
          lines: 80,
          scrollback: false,
        });
        lastText = screen.text;
        const parsed = parseScreen(screen.text);
        const now = Date.now();
        const updateState = parsed.cli_update_state;
        const runningTurn =
          parsed.status === "working" || parsed.status === "thinking";

        const launcherFailure = launcherFailureFromShell(screen.text);
        if (launcherFailure) {
          throw new LauncherReadinessError(
            `Launcher exited before reaching readiness on ${target.surface}: ${launcherFailure}`,
            tailLines(lastText, 10),
          );
        }

        if (shouldHandleCodexUpdateMenu(opts.cli, screen.text)) {
          const blocked = () => new BootPromptUpdateMenuBlockedError(
            `Boot prompt delivery blocked by Codex update menu on ${target.surface}; cmuxlayer will not press Return on an unverified menu`,
            tailLines(lastText, 10),
            target.surface,
          );
          const plan = codexUpdateSkipPlan(screen.text);
          if (
            !plan || updateMenuTextHash !== undefined ||
            !opts.stableSurfaceIdentity || !opts.resolveRoute ||
            !opts.assertStableSurfaceIdentity
          ) throw blocked();
          selectingUpdateMenu = true;
          await withSurfaceWrite(target.surface, async () => {
            const assertRoute = async () => {
              await opts.assertStableSurfaceIdentity!();
              const current = await opts.resolveRoute!();
              if (current.surface !== target.surface ||
                  (current.workspace ?? null) !== (target.workspace ?? null)) {
                throw blocked();
              }
            };
            await assertRoute();
            const confirmed = await client.readScreen(target.surface, {
              workspace: target.workspace, lines: 80, scrollback: false,
            });
            if (confirmed.text !== screen.text) throw blocked();
            for (let index = 0; index < plan.downCount; index += 1) {
              await assertRoute();
              await client.sendKey(target.surface, "down", { workspace: target.workspace });
            }
            await assertRoute();
            const selected = await client.readScreen(target.surface, {
              workspace: target.workspace, lines: 80, scrollback: false,
            });
            if (codexUpdateSkipPlan(selected.text)?.downCount !== 0) throw blocked();
            await assertRoute();
            await client.sendKey(target.surface, "return", { workspace: target.workspace });
          }, {
            toolName: "boot_prompt",
            workspace: target.workspace,
            stableSurfaceIdentity: opts.stableSurfaceIdentity,
            observePtyWrite: true,
          });
          selectingUpdateMenu = false;
          updateMenuTextHash = plan.textHash;
          deadline = Math.max(deadline, Date.now() + BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS);
          consecutiveMatches.clear();
          continue;
        }

        if (updateState === "updating") {
          updateWasSeen = true;
          updateStartedAt ??= now;
          updateElapsedMs = Math.max(
            updateElapsedMs + BOOT_PROMPT_READY_POLL_MS,
            updateStartedAt === null ? 0 : now - updateStartedAt,
          );
          if (updateElapsedMs >= updateMaxMs) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for boot prompt readiness on ${target.surface}: CLI update marker persisted for ${updateMaxMs}ms`,
              tailLines(lastText, 10),
            );
          }
          await delay(BOOT_PROMPT_READY_POLL_MS);
          continue;
        }

        if (updateStartedAt !== null) {
          const updateDuration = Math.max(
            now - updateStartedAt,
            updateElapsedMs,
          );
          deadline = Math.max(
            deadline + updateDuration,
            now + postUpdateReadyBudgetMs(),
          );
          updateStartedAt = null;
          updateElapsedMs = 0;
        }

        if (updateState === "update_complete") {
          updateWasSeen = true;
          consecutiveMatches.clear();
        }

        if (
          updateWasSeen &&
          opts.onUpdateShellRelaunch &&
          matchesShellPrompt(screen.text) &&
          !candidates.some(
            (candidate) => matchReadyPattern(candidate, screen.text).matched,
          )
        ) {
          if (updateShellRelaunches >= BOOT_PROMPT_UPDATE_RELAUNCH_MAX) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for boot prompt readiness on ${target.surface}: CLI returned to shell after ${updateShellRelaunches} post-update relaunch attempts`,
              tailLines(lastText, 10),
            );
          }
          updateShellRelaunches += 1;
          consecutiveMatches.clear();
          const relaunchStartedAt = Date.now();
          await opts.onUpdateShellRelaunch();
          const relaunchEndedAt = Date.now();
          deadline = Math.max(
            deadline + (relaunchEndedAt - relaunchStartedAt),
            relaunchEndedAt + postUpdateReadyBudgetMs(),
          );
          continue;
        }

        let frameQueuedObservation: QueuedBootObservation | null = null;
        for (const candidate of candidates) {
          const match = matchReadyPattern(candidate, screen.text);
          const identified =
            match.matched &&
            screenHasReadyAgentIdentity(candidate, screen.text, parsed);
          const bannerIndependentIdentity =
            screenHasAnyAgentIdentity(screen.text, parsed) &&
            inferComposerCli(screen.text, parsed) === candidate;
          const composer = extractComposerInputRegion(screen.text, opts.text);
          const promptEchoed = screenContainsCompleteSubmittedText(
            screen.text,
            opts.text,
          );
          const codexTurnStillRunning = candidate === "codex" && runningTurn;
          if (
            bannerIndependentIdentity &&
            codexTurnStillRunning &&
            composer !== null &&
            composer.trim() === "" &&
            !promptEchoed
          ) {
            frameQueuedObservation = {
              metrics: parseSubmitEvidenceMetrics(screen.text, parsed),
              route: target,
              cli: candidate,
              observation: {
                status: parsed.status,
                composer_empty: true,
                prompt_echoed: false,
                last_10_lines: tailLines(screen.text, 10),
              },
            };
          }
          const ready = identified && !codexTurnStillRunning &&
            (!updateMenuTextHash || (
              candidate === "codex" &&
              parsed.agent_type === "codex" &&
              parsed.status === "idle" &&
              parsed.control_state === "ready" &&
              composer !== null && composer.trim() === ""
            ));
          const count = ready
            ? (consecutiveMatches.get(candidate) ?? 0) + 1
            : 0;
          consecutiveMatches.set(candidate, count);
          if (count >= requiredBootReadyObservations(candidate, screen.text)) {
            return {
              delivery_state: "ready",
              metrics: parseSubmitEvidenceMetrics(screen.text, parsed),
              route: target,
              cli: candidate,
              ...(updateMenuTextHash ? { updateMenuTextHash } : {}),
            };
          }
        }
        queuedObservation = frameQueuedObservation;
      } catch (error) {
        if (selectingUpdateMenu) {
          if (isSurfaceGoneReadFailure(error, target.surface)) {
            throw new SurfaceGoneError(target.surface, error);
          }
          throw error;
        }
        if (
          error instanceof BootPromptTimeoutError ||
          error instanceof LauncherReadinessError ||
          error instanceof BootPromptUpdateMenuBlockedError
        ) {
          throw error;
        }
        if (isSurfaceGoneReadFailure(error, target.surface)) {
          throw new SurfaceGoneError(target.surface, error);
        }
        queuedObservation = null;
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(BOOT_PROMPT_READY_POLL_MS, remaining));
    }

    if (queuedObservation) {
      if (updateMenuTextHash) {
        throw new BootPromptUpdateMenuBlockedError(
          `Codex update menu skip did not lead to a ready composer on ${lastSurface}`,
          tailLines(lastText, 10), lastSurface,
        );
      }
      return {
        delivery_state: "queued",
        ...queuedObservation,
      };
    }

    if (updateMenuTextHash) {
      throw new BootPromptUpdateMenuBlockedError(
        `Codex update menu skip did not lead to a ready composer on ${lastSurface}`,
        tailLines(lastText, 10), lastSurface,
      );
    }
    throw new BootPromptTimeoutError(
      `Timed out after ${opts.timeout_ms}ms waiting for boot prompt readiness on ${lastSurface}${bootReadinessDriftNote(opts.cli, lastText)}`,
      tailLines(lastText, 10),
    );
  };

  const waitForBootPromptSubmitEvidence = async (opts: {
    surface: string;
    workspace?: string;
    text: string;
    timeout_ms: number;
    baseline_metrics?: RawSubmitEvidenceMetrics | null;
    beforeRead?: () => Promise<void>;
  }): Promise<SubmitEvidence> => {
    const start = Date.now();
    let lastText = "";
    let lastClearedComposerInput: string | null = null;
    let stableClearedComposerPolls = 0;

    while (Date.now() - start < opts.timeout_ms) {
      await opts.beforeRead?.();
      const snapshot = await readParsedSurface(opts.surface, opts.workspace, {
        throwOnSurfaceGone: true,
      });
      if (snapshot) {
        lastText = snapshot.text;
        const metrics = parseSubmitEvidenceMetrics(
          snapshot.text,
          snapshot.parsed,
        );
        // AIDEV-NOTE (T2 #427): `0 tokens` is a definitive negative -- an agent
        // handed a prompt that has consumed nothing did not receive it. A slow
        // boot (MCP servers still connecting, banner mid-render) can present a
        // working-looking status while the prompt is still sitting in the
        // composer, and accepting that status produced fully-verified receipts
        // for workers that sat at `0 tokens` with their entire brief unsent.
        // A NULL count stays inconclusive on purpose: several CLIs never
        // report one, and reading unknown as zero would break every boot.
        const consumptionRefuted = metrics.tokenCount === 0;
        const composerInput = extractComposerInputRegion(snapshot.text);
        const hasPendingInput = screenShowsPendingInput(
          snapshot.text,
          opts.text,
        );
        if (
          !hasPendingInput &&
          !consumptionRefuted &&
          isSubmitVerifiedStatus(snapshot.parsed.status)
        ) {
          return "status_only";
        }

        if (
          composerInput !== null &&
          !hasPendingInput &&
          hasRawSubmitEvidenceIncrease(metrics, opts.baseline_metrics)
        ) {
          return "token_delta";
        }

        const composerCleared =
          composerInput !== null &&
          composerInput.trim() === "" &&
          !hasPendingInput;
        if (
          composerCleared &&
          !consumptionRefuted &&
          screenHasAnyAgentIdentity(snapshot.text, snapshot.parsed)
        ) {
          if (composerInput === lastClearedComposerInput) {
            stableClearedComposerPolls += 1;
          } else {
            lastClearedComposerInput = composerInput;
            stableClearedComposerPolls = 1;
          }

          if (stableClearedComposerPolls >= 2) {
            return "cleared_composer";
          }
        } else {
          lastClearedComposerInput = null;
          stableClearedComposerPolls = 0;
        }
      }

      const remaining = opts.timeout_ms - (Date.now() - start);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(BOOT_PROMPT_READY_POLL_MS, remaining));
    }

    throw new BootPromptTimeoutError(
      `Timed out after ${opts.timeout_ms}ms waiting for boot prompt submit evidence on ${opts.surface}`,
      tailLines(lastText, 10),
    );
  };

  const waitForLaunchShellReady = async (opts: {
    surface: string;
    workspace?: string;
    timeout_ms?: number;
    require_fresh_shell_prompt?: boolean;
    stableSurfaceIdentity?: string | null;
    assertSurfaceBindingCurrent?: () => Promise<void>;
  }): Promise<{ recovered: boolean; cleared: string[] }> => {
    const timeoutMs = opts.timeout_ms ?? LAUNCH_SHELL_READY_TIMEOUT_MS;
    const start = Date.now();
    let lastText = "";
    const cleared: string[] = [];
    let clears = 0;
    let lastClearAt = 0;
    let lastClearKey: "ctrl-u" | "ctrl-c" | null = null;
    let pendingInputObserved = false;

    const screenShowsAgentReady = (text: string): boolean =>
      READY_PATTERN_CLIS.some((cli) => matchReadyPattern(cli, text).matched);

    const sendClearKey = async (key: "ctrl-u" | "ctrl-c"): Promise<void> => {
      await executeDeliveryEngine({
        surface: opts.surface,
        workspace: opts.workspace,
        chunks: [],
        key,
        chunk_size: 0,
        chunk_delay_ms: 0,
        press_enter: false,
        source_event: "send_key",
        stableSurfaceIdentity: opts.stableSurfaceIdentity,
        beforeMutation: opts.assertSurfaceBindingCurrent,
      });
    };

    while (Date.now() - start < timeoutMs) {
      try {
        const screen = await client.readScreen(opts.surface, {
          workspace: opts.workspace,
          lines: 30,
          scrollback: false,
        });
        lastText = screen.text;
        const agentReady = screenShowsAgentReady(screen.text);
        if (!opts.require_fresh_shell_prompt && agentReady) {
          return { recovered: cleared.length > 0, cleared };
        }
        if (matchesShellPrompt(screen.text)) {
          return { recovered: cleared.length > 0, cleared };
        }
        const pending = agentReady
          ? null
          : pendingShellPromptInput(screen.text);
        if (pending) {
          pendingInputObserved = true;
          if (lastClearKey === "ctrl-u") {
            await sendClearKey("ctrl-c");
            lastClearKey = "ctrl-c";
          } else if (
            clears < LAUNCH_SHELL_JUNK_CLEAR_MAX &&
            (clears === 0 ||
              Date.now() - lastClearAt >= LAUNCH_SHELL_JUNK_CLEAR_INTERVAL_MS)
          ) {
            await sendClearKey("ctrl-u");
            if (!cleared.includes(pending)) {
              cleared.push(pending);
            }
            clears += 1;
            lastClearAt = Date.now();
            lastClearKey = "ctrl-u";
          }
        }
      } catch (error) {
        if (isSurfaceGoneReadFailure(error, opts.surface)) {
          throw new SurfaceGoneError(opts.surface, error);
        }
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(LAUNCH_SHELL_READY_POLL_MS, remaining));
    }

    throw new BootPromptTimeoutError(
      `Timed out after ${timeoutMs}ms waiting for shell readiness on ${opts.surface}`,
      tailLines(lastText, 10),
      pendingInputObserved,
    );
  };

  const waitForAgentLaunchReady = async (opts: {
    surface: string;
    workspace?: string;
    timeout_ms?: number;
    onUpdateShellRelaunch?: () => Promise<void>;
  }): Promise<void> => {
    const timeoutMs = opts.timeout_ms ?? LAUNCH_SUBMIT_READY_TIMEOUT_MS;
    let deadline = Date.now() + timeoutMs;
    let lastText = "";
    let updateStartedAt: number | null = null;
    let updateElapsedMs = 0;
    let updateWasSeen = false;
    let updateShellRelaunches = 0;
    const updateMaxMs = bootPromptUpdateMaxMs();

    while (Date.now() < deadline || updateStartedAt !== null) {
      try {
        const screen = await client.readScreen(opts.surface, {
          workspace: opts.workspace,
          lines: 80,
          scrollback: false,
        });
        lastText = screen.text;
        const parsed = parseScreen(screen.text);
        const now = Date.now();

        const launcherFailure = launcherFailureFromShell(screen.text);
        if (launcherFailure) {
          throw new LauncherReadinessError(
            `Launcher exited before reaching readiness on ${opts.surface}: ${launcherFailure}`,
            tailLines(lastText, 10),
          );
        }

        if (parsed.cli_update_state === "updating") {
          updateWasSeen = true;
          updateStartedAt ??= now;
          updateElapsedMs = Math.max(
            updateElapsedMs + LAUNCH_SHELL_READY_POLL_MS,
            now - updateStartedAt,
          );
          if (updateElapsedMs >= updateMaxMs) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for agent launch readiness on ${opts.surface}: CLI update marker persisted for ${updateMaxMs}ms`,
              tailLines(lastText, 10),
            );
          }
          await delay(LAUNCH_SHELL_READY_POLL_MS);
          continue;
        }

        if (updateStartedAt !== null) {
          const updateDuration = Math.max(
            now - updateStartedAt,
            updateElapsedMs,
          );
          deadline = Math.max(
            deadline + updateDuration,
            now + Math.max(timeoutMs, BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS),
          );
          updateStartedAt = null;
          updateElapsedMs = 0;
        }

        if (parsed.cli_update_state === "update_complete") {
          updateWasSeen = true;
        }

        if (
          updateWasSeen &&
          opts.onUpdateShellRelaunch &&
          matchesShellPrompt(screen.text) &&
          !READY_PATTERN_CLIS.some(
            (cli) => matchReadyPattern(cli, screen.text).matched,
          )
        ) {
          if (updateShellRelaunches >= BOOT_PROMPT_UPDATE_RELAUNCH_MAX) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for agent launch readiness on ${opts.surface}: CLI returned to shell after ${updateShellRelaunches} post-update relaunch attempts`,
              tailLines(lastText, 10),
            );
          }
          updateShellRelaunches += 1;
          const relaunchStartedAt = Date.now();
          await opts.onUpdateShellRelaunch();
          const relaunchEndedAt = Date.now();
          deadline = Math.max(
            deadline + (relaunchEndedAt - relaunchStartedAt),
            relaunchEndedAt +
              Math.max(timeoutMs, BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS),
          );
          continue;
        }

        if (
          READY_PATTERN_CLIS.some(
            (cli) => matchReadyPattern(cli, screen.text).matched,
          )
        ) {
          return;
        }
      } catch (error) {
        if (
          error instanceof BootPromptTimeoutError ||
          error instanceof LauncherReadinessError
        ) {
          throw error;
        }
        if (isSurfaceGoneReadFailure(error, opts.surface)) {
          throw new SurfaceGoneError(opts.surface, error);
        }
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(LAUNCH_SHELL_READY_POLL_MS, remaining));
    }

    throw new BootPromptTimeoutError(
      `Timed out after ${timeoutMs}ms waiting for agent launch readiness on ${opts.surface}`,
      tailLines(lastText, 10),
    );
  };

  const probeAgentLaunchReadyOnce = async (opts: {
    surface: string;
    workspace?: string;
  }): Promise<void> => {
    try {
      await client.readScreen(opts.surface, {
        workspace: opts.workspace,
        lines: 80,
        scrollback: false,
      });
    } catch (error) {
      if (isSurfaceGoneReadFailure(error, opts.surface)) {
        throw new SurfaceGoneError(opts.surface, error);
      }
    }
  };

  const sendLauncherCommandToSurface = async (opts: {
    surface: string;
    stableSurfaceIdentity?: string | null;
    workspace?: string;
    command: string;
    timeout_ms?: number;
    relaunch?: boolean;
    assertSurfaceBindingCurrent?: () => Promise<void>;
  }): Promise<void> => {
    const sanitizedCommand = sanitizeTerminalInput(opts.command);
    const chunks =
      sanitizedCommand.length > SEND_INPUT_CHUNK_THRESHOLD
        ? chunkTerminalInput(sanitizedCommand, SEND_INPUT_CHUNK_THRESHOLD)
        : [sanitizedCommand];

    if (!opts.relaunch) {
      const shellRecovery = await waitForLaunchShellReady({
        surface: opts.surface,
        workspace: opts.workspace,
        timeout_ms: opts.timeout_ms,
        stableSurfaceIdentity: opts.stableSurfaceIdentity,
        assertSurfaceBindingCurrent: opts.assertSurfaceBindingCurrent,
      });
      if (shellRecovery.recovered) {
        launchShellRecoveryBySurface.set(opts.surface, {
          recovered: true,
          cleared: shellRecovery.cleared,
        });
      }
    }
    await opts.assertSurfaceBindingCurrent?.();
    await withSurfaceWrite(
      opts.surface,
      async () => {
        const readLauncherScreen = () =>
          client.readScreen(opts.surface, {
            workspace: opts.workspace,
            lines: 80,
            scrollback: false,
          });
        const submitPendingLauncherCommand = async (): Promise<boolean> => {
          let screen;
          try {
            screen = await readLauncherScreen();
          } catch (error) {
            if (isSurfaceGoneReadFailure(error, opts.surface)) {
              throw new SurfaceGoneError(opts.surface, error);
            }
            return false;
          }
          if (!screenShowsPendingShellInput(screen.text, sanitizedCommand)) {
            return false;
          }

          try {
            // Return is a mutation: retrying after a lost acknowledgement can
            // submit into the newly started CLI. Probe before any fallback.
            await opts.assertSurfaceBindingCurrent?.();
            await executeDeliveryEngine({
              surface: opts.surface,
              workspace: opts.workspace,
              chunks: [],
              key: "return",
              engineSubmitProof: "launcher_pending_command",
              chunk_size: 0,
              chunk_delay_ms: 0,
              press_enter: false,
              source_event: "send_key",
              beforeMutation: opts.assertSurfaceBindingCurrent,
            });
            return true;
          } catch (error) {
            if (isSurfaceGoneReadFailure(error, opts.surface)) {
              throw new SurfaceGoneError(opts.surface, error);
            }
            try {
              const confirmation = await readLauncherScreen();
              return !screenShowsPendingShellInput(
                confirmation.text,
                sanitizedCommand,
              );
            } catch (confirmationError) {
              if (isSurfaceGoneReadFailure(confirmationError, opts.surface)) {
                throw new SurfaceGoneError(opts.surface, confirmationError);
              }
              throw error;
            }
          }
        };
        const clearAndVerifyFreshShellPrompt = async (
          key: "ctrl-c" | "ctrl-u" = "ctrl-c",
        ): Promise<void> => {
          await opts.assertSurfaceBindingCurrent?.();
          await executeDeliveryEngine({
            surface: opts.surface,
            workspace: opts.workspace,
            chunks: [],
            key,
            chunk_size: 0,
            chunk_delay_ms: 0,
            press_enter: false,
            source_event: "send_key",
            beforeMutation: opts.assertSurfaceBindingCurrent,
          });
          await waitForLaunchShellReady({
            surface: opts.surface,
            workspace: opts.workspace,
            timeout_ms: opts.timeout_ms,
            require_fresh_shell_prompt: true,
            stableSurfaceIdentity: opts.stableSurfaceIdentity,
            assertSurfaceBindingCurrent: opts.assertSurfaceBindingCurrent,
          });
        };
        const typeLauncherCommand = async (verifySubmit: boolean) =>
          executeDeliveryEngine({
            surface: opts.surface,
            workspace: opts.workspace,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: true,
            source_event: "spawn_agent",
            verify_submit: verifySubmit,
            submit_verify_timeout_ms: verifySubmit
              ? SEND_INPUT_RECOVERY_ENTER_DELAY_MS
              : undefined,
            beforeMutation: opts.assertSurfaceBindingCurrent,
          });
        const recoverCorruptedLauncherLine = async (): Promise<void> => {
          for (
            let attempt = 0;
            attempt < LAUNCHER_LINE_CORRUPTION_RECOVERY_ATTEMPTS;
            attempt += 1
          ) {
            await clearAndVerifyFreshShellPrompt("ctrl-u");
            try {
              const recovered = await typeLauncherCommand(true);
              if (recovered.submit_verified === true) {
                return;
              }
            } catch (recoveryError) {
              const recoveryMessage =
                recoveryError instanceof Error
                  ? recoveryError.message
                  : String(recoveryError);
              if (!/Enter submit could not be verified/.test(recoveryMessage)) {
                throw recoveryError;
              }
            }
            let recoveredScreen;
            try {
              recoveredScreen = await readLauncherScreen();
            } catch (readError) {
              if (isSurfaceGoneReadFailure(readError, opts.surface)) {
                throw new SurfaceGoneError(opts.surface, readError);
              }
              throw readError;
            }
            const recoveredKind = classifyPendingLauncherLine(
              recoveredScreen.text,
              sanitizedCommand,
            );
            if (recoveredKind !== "corrupted") {
              return;
            }
          }
          let failedScreen;
          try {
            failedScreen = await readLauncherScreen();
          } catch (readError) {
            if (isSurfaceGoneReadFailure(readError, opts.surface)) {
              throw new SurfaceGoneError(opts.surface, readError);
            }
            throw new LauncherReadinessError(
              LAUNCHER_LINE_CORRUPTION_ERROR,
              [],
            );
          }
          throw new LauncherReadinessError(
            LAUNCHER_LINE_CORRUPTION_ERROR,
            tailLines(failedScreen.text, 10),
          );
        };
        if (opts.relaunch) {
          if (await submitPendingLauncherCommand()) {
            return;
          }
          await clearAndVerifyFreshShellPrompt();
        }
        const relaunchOriginalCommand = async (): Promise<void> => {
          await clearAndVerifyFreshShellPrompt();
          await typeLauncherCommand(false);
        };
        const confirmReadyThenRecoverIfCorrupted = async (): Promise<void> => {
          // Readiness is the authoritative launch check. Only recover a
          // corrupted pending line after that check fails — otherwise ctrl-u
          // can land in a healthy booting pane.
          try {
            await waitForAgentLaunchReady({
              surface: opts.surface,
              workspace: opts.workspace,
              timeout_ms: opts.timeout_ms,
              onUpdateShellRelaunch: relaunchOriginalCommand,
            });
          } catch (readinessError) {
            let pendingScreen;
            try {
              pendingScreen = await readLauncherScreen();
            } catch (readError) {
              if (isSurfaceGoneReadFailure(readError, opts.surface)) {
                throw new SurfaceGoneError(opts.surface, readError);
              }
              throw readinessError;
            }
            if (
              classifyPendingLauncherLine(
                pendingScreen.text,
                sanitizedCommand,
              ) === "corrupted"
            ) {
              await recoverCorruptedLauncherLine();
              await waitForAgentLaunchReady({
                surface: opts.surface,
                workspace: opts.workspace,
                timeout_ms: opts.timeout_ms,
                onUpdateShellRelaunch: relaunchOriginalCommand,
              });
              return;
            }
            if (
              screenShowsPendingShellInput(pendingScreen.text, sanitizedCommand)
            ) {
              throw new LauncherReadinessError(
                `launcher command remained pending after Return on ${opts.surface}`,
                tailLines(pendingScreen.text, 10),
              );
            }
            throw readinessError;
          }
        };
        try {
          const delivery = await typeLauncherCommand(true);
          if (delivery.submit_verified === true) {
            return;
          }
          // The command can clear from the shell without proving the launcher
          // accepted it. Probe once to consume transient ready evidence, then
          // let boot-prompt readiness own update/relaunch monitoring.
          await probeAgentLaunchReadyOnce({
            surface: opts.surface,
            workspace: opts.workspace,
          });
          // Interleaved corruption never throws: the exact command is gone, so
          // verify is advisory. Recover only that single-line case here; other
          // screens (Codex update menus, boot output) belong to boot-prompt wait.
          let pendingScreen;
          try {
            pendingScreen = await readLauncherScreen();
          } catch (readError) {
            if (isSurfaceGoneReadFailure(readError, opts.surface)) {
              throw new SurfaceGoneError(opts.surface, readError);
            }
            return;
          }
          if (
            classifyPendingLauncherLine(
              pendingScreen.text,
              sanitizedCommand,
            ) === "corrupted"
          ) {
            await confirmReadyThenRecoverIfCorrupted();
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!/Enter submit could not be verified/.test(message)) {
            throw error;
          }
          await confirmReadyThenRecoverIfCorrupted();
        }
      },
      {
        toolName: "send_command",
        workspace: opts.workspace,
        observePtyWrite: true,
        stableSurfaceIdentity: opts.stableSurfaceIdentity,
      },
    );
  };

  const fingerprintPromptReceipt = <T extends object>(receipt: T, prompt: string) =>
    Object.defineProperty(Object.assign(receipt, {
      prompt_bytes: Buffer.byteLength(prompt, "utf8"),
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    }), "prompt_text", { value: hasInlinePrompt(prompt) ? prompt : null }) as unknown as T & {
      prompt_text: string | null;
    };

  const deliverBootPrompt = async (opts: {
    surface: string;
    stableSurfaceIdentity?: string | null;
    workspace?: string;
    cli?: CliType;
    prompt?: string;
    boot_prompt_path?: string | null;
    injected_prompt?: string;
    timeout_ms?: number;
    onUpdateShellRelaunch?: () => Promise<void>;
    resolveRoute?: () => Promise<{ surface: string; workspace?: string }>;
    assertStableSurfaceIdentity?: () => Promise<void>;
  }): Promise<
    PublicDeliveryReceipt & {
      bytes: number;
      prompt_text: string | null;
      prompt_warning: string | null;
      update_menu_skipped?: boolean;
      update_menu_text_hash?: string;
    }
  > => {
    const bootPromptPath = getBootPromptPath(opts.boot_prompt_path);
    assertBootPromptMode(opts.prompt, bootPromptPath);
    if (
      !hasInlinePrompt(opts.prompt) &&
      !bootPromptPath &&
      !hasInlinePrompt(opts.injected_prompt)
    ) {
      return fingerprintPromptReceipt({
        ...buildPublicDeliveryReceipt({
          typed: false,
          submit_attempted: false,
          submit_verified: null,
          retry_count: 0,
        }),
        bytes: 0,
        prompt_warning: null,
      }, "");
    }

    const rawPrompt = bootPromptPath
      ? await readFile(bootPromptPath, "utf8")
      : (opts.prompt ?? "");
    const useFilePointer =
      Boolean(bootPromptPath) &&
      (/[\r\n]/.test(rawPrompt) ||
        inlineByteLength(rawPrompt) > SEND_INPUT_MAX_INLINE_CHARS);
    const promptWarning =
      bootPromptPath &&
      rawPrompt.length > BOOT_PROMPT_PATH_WARNING_CHARS &&
      !useFilePointer
        ? `boot_prompt_path is ${rawPrompt.length} characters; prefer a one-line file pointer for boot prompts over ${BOOT_PROMPT_PATH_WARNING_CHARS} characters`
        : null;
    const callerDeliveryText = useFilePointer
      ? `Read and follow ${bootPromptPath}`
      : rawPrompt;
    const deliveryText = composeBootDeliveryText(
      callerDeliveryText,
      opts.injected_prompt,
      opts.cli,
    );
    const sanitizedText = sanitizeTerminalInput(deliveryText);
    const chunks =
      sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
        ? chunkTerminalInput(sanitizedText, SEND_INPUT_CHUNK_THRESHOLD)
        : [sanitizedText];

    let readiness = await waitForBootPromptReady({
      surface: opts.surface,
      workspace: opts.workspace,
      stableSurfaceIdentity: opts.stableSurfaceIdentity,
      cli: opts.cli,
      text: sanitizedText,
      timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
      onUpdateShellRelaunch: opts.onUpdateShellRelaunch,
      resolveRoute: opts.resolveRoute,
      assertStableSurfaceIdentity: opts.assertStableSurfaceIdentity,
    });

    let deliveryRoute = opts.resolveRoute
      ? await opts.resolveRoute()
      : readiness.route;
    const sameRoute = (
      left: { surface: string; workspace?: string },
      right: { surface: string; workspace?: string },
    ): boolean =>
      left.surface === right.surface &&
      (left.workspace ?? null) === (right.workspace ?? null);
    if (!sameRoute(readiness.route, deliveryRoute)) {
      readiness = await waitForBootPromptReady({
        surface: deliveryRoute.surface,
        workspace: deliveryRoute.workspace,
        stableSurfaceIdentity: opts.stableSurfaceIdentity,
        initialUpdateMenuTextHash: readiness.updateMenuTextHash,
        cli: opts.cli,
        text: sanitizedText,
        timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
        onUpdateShellRelaunch: opts.onUpdateShellRelaunch,
        resolveRoute: opts.resolveRoute,
        assertStableSurfaceIdentity: opts.assertStableSurfaceIdentity,
      });
      deliveryRoute = opts.resolveRoute
        ? await opts.resolveRoute()
        : readiness.route;
      if (!sameRoute(readiness.route, deliveryRoute)) {
        throw new Error(
          "Boot prompt route changed after readiness; refusing stale delivery",
        );
      }
    }
    const assertDeliveryRouteCurrent = async (): Promise<void> => {
      if (opts.resolveRoute) {
          const current = await opts.resolveRoute!();
          if (!sameRoute(deliveryRoute, current)) {
            throw new Error(
              "Boot prompt route changed during delivery; refusing to split prompt across terminals",
            );
          }
      }
      await assertSurfaceMutationAllowed(
        "boot_prompt", deliveryRoute.surface, deliveryRoute.workspace,
      );
    };
    if (readiness.delivery_state === "queued") {
      return fingerprintPromptReceipt({
        ...buildPublicDeliveryReceipt({
          delivery_state: "queued",
          typed: false,
          submit_attempted: false,
          submit_verified: null,
          retry_count: 0,
          observation: readiness.observation,
          WARNING:
            "BOOT PROMPT QUEUED — the agent turn remained active through the " +
            `${opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS}ms deadline with an ` +
            "empty composer and no prompt echo. No text or Return was sent; " +
            "the live pane remains available for inspection or retry.",
        }),
        bytes: 0,
        prompt_warning: promptWarning,
      }, rawPrompt);
    }
    let sentChunks = 0;

    try {
      const delivery = await withSurfaceWrite(
        deliveryRoute.surface,
        async () =>
          executeDeliveryEngine({
            surface: deliveryRoute.surface,
            workspace: deliveryRoute.workspace,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: true,
            source_event: "boot_prompt",
            onChunkDelivered: (count) => {
              sentChunks = count;
            },
            verify_submit: true,
            // Submission evidence is a boot-delivery invariant. CLI-specific
            // readiness patterns decide when typing may begin; no CLI may turn
            // status alone into proof that cmuxlayer's payload was submitted.
            require_observed_payload_before_enter: true,
            submit_verify_timeout_ms: opts.timeout_ms
              ? Math.min(SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS, opts.timeout_ms)
              : undefined,
            beforeMutation: assertDeliveryRouteCurrent,
          }),
        {
          toolName: "boot_prompt",
          workspace: deliveryRoute.workspace,
          observePtyWrite: true,
          stableSurfaceIdentity: opts.stableSurfaceIdentity,
        },
      );
      // Review F2 on #809: only a dispatched Return can leave residue; an
      // unsubmitted payload stays a pending_verify receipt.
      if (delivery.submit_dispatched === true) {
        await rejectBootComposerResidue(
          readiness.cli,
          deliveryRoute,
          chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          delivery,
        );
      }
      return fingerprintPromptReceipt({
        ...delivery,
        prompt_warning: promptWarning,
        ...(readiness.updateMenuTextHash ? {
          update_menu_skipped: true,
          update_menu_text_hash: readiness.updateMenuTextHash,
        } : {}),
      }, rawPrompt);
    } catch (error) {
      if (error instanceof SurfaceGoneError || error instanceof BootComposerResidueError) {
        throw error;
      }
      if (error instanceof SubmitVerificationError) {
        await assertDeliveryRouteCurrent?.();
        const snapshot = await readParsedSurface(
          deliveryRoute.surface,
          deliveryRoute.workspace,
        );
        if (
          !snapshot ||
          !screenShowsPendingInput(snapshot.text, sanitizedText)
        ) {
          let submitEvidence: SubmitEvidence;
          try {
            submitEvidence = await waitForBootPromptSubmitEvidence({
              surface: deliveryRoute.surface,
              workspace: deliveryRoute.workspace,
              text: sanitizedText,
              timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
              baseline_metrics: readiness.metrics,
              beforeRead: assertDeliveryRouteCurrent,
            });
          } catch (fallbackError) {
            if (fallbackError instanceof SurfaceGoneError) {
              throw fallbackError;
            }
            const deliveredChars = chunks
              .slice(0, sentChunks)
              .reduce((sum, chunk) => sum + chunk.length, 0);
            const fallbackMessage =
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError);
            throw new BootPromptDeliveryError(
              `Boot prompt delivery failed after ${deliveredChars} chars: ${fallbackMessage}`,
              deliveredChars,
              error,
              fallbackError,
            );
          }
          return fingerprintPromptReceipt({
            ...buildPublicDeliveryReceipt({
              delivery_state: "submitted",
              typed: true,
              submit_attempted: true,
              submit_verified: true,
              submit_evidence: submitEvidence,
              retry_count: error.retry_count,
              rpc_methods: error.receipt.rpc_methods,
            }),
            bytes: Buffer.byteLength(sanitizedText, "utf8"),
            prompt_warning: promptWarning,
            ...(readiness.updateMenuTextHash ? {
              update_menu_skipped: true,
              update_menu_text_hash: readiness.updateMenuTextHash,
            } : {}),
          }, rawPrompt);
        }
      }

      const deliveredChars = chunks
        .slice(0, sentChunks)
        .reduce((sum, chunk) => sum + chunk.length, 0);
      const message = error instanceof Error ? error.message : String(error);
      throw new BootPromptDeliveryError(
        `Boot prompt delivery failed after ${deliveredChars} chars: ${message}`,
        deliveredChars,
        error instanceof SubmitVerificationError ? error : undefined,
        error,
      );
    }
  };

  // #801: after a submitted boot prompt, agy's composer must be empty. A draft
  // that stays put across reads (the contract pointer on surface:918 sat there
  // for the whole run) is residue: fail loudly instead of leaving it unsent.
  const rejectBootComposerResidue = async (
    cli: CliType,
    route: { surface: string; workspace?: string },
    deliveredChars: number,
    delivery: {
      rpc_methods: DeliveryRpcMethod[];
      submit_verified?: boolean | null;
    },
  ): Promise<void> => {
    if (cli !== "gemini") return;
    let previous: string | null = null;
    for (let attempt = 0; attempt < BOOT_COMPOSER_RESIDUE_READS; attempt += 1) {
      if (attempt > 0) await delay(BOOT_COMPOSER_RESIDUE_POLL_MS);
      const snapshot = await readParsedSurface(route.surface, route.workspace);
      if (!snapshot) return;
      const draft =
        extractComposerInputRegion(snapshot.text, undefined, cli)?.trim() ?? "";
      if (!draft) return;
      if (draft === previous) {
        throw new BootComposerResidueError(
          `Boot prompt was submitted but left residue in the composer: "${draft}". ` +
            "It was NOT sent; the agent never saw it (#801).",
          deliveredChars,
          draft,
          {
            rpc_methods: [...delivery.rpc_methods],
            typed: true,
            submit_dispatched: true,
          },
          delivery.submit_verified === true,
        );
      }
      previous = draft;
    }
  };

  const isBootPromptDelivered = (
    delivery: Awaited<ReturnType<typeof deliverBootPrompt>> | undefined,
  ): boolean => delivery?.submit_verified === true;

  type BackgroundDeliveryLifecycle = {
    engine: AgentEngine;
    agent_id: string;
    text: string;
    source_event: DeliveryEventType;
  };

  const startBackgroundDelivery = (
    record: DeliveryRecord,
    lifecycle?: BackgroundDeliveryLifecycle,
  ) => {
    // Preserve the backend owner that accepted the asynchronous write. Reading
    // the observer after completion could attribute old-backend evidence to a
    // new backend that reused the same mutable ref.
    record.surfaceObserverIdentity = context.surfaceObserverId;
    record.lockKey = record.stableSurfaceIdentity
      ? `uuid:${record.stableSurfaceIdentity.toLowerCase()}`
      : record.surface;
    acquireSurfaceWrite(record.lockKey, record.delivery_id);
    deliveries.set(record.delivery_id, record);
    latestDeliveryBySurface.set(record.surface, record.delivery_id);
    activeDeliveryBySurface.set(record.surface, record.delivery_id);
    pruneCompletedDeliveryHistory(record.surface);

    const run = async () => {
      try {
        const delivery = await executeDeliveryEngine({
          surface: record.surface,
          workspace: record.workspace,
          chunks: record.chunks,
          chunk_size: record.chunk_size,
          chunk_delay_ms: record.chunk_delay_ms,
          press_enter: record.press_enter,
          rename_to_task: record.rename_to_task,
          stableSurfaceIdentity: record.stableSurfaceIdentity,
          source_event: lifecycle?.source_event ?? "send_input",
          delivery_id: lifecycle ? record.delivery_id : undefined,
          verify_submit: record.verify_submit,
          beforeMutation: record.beforeMutation,
          onChunkDelivered: (sentChunks) => {
            record.sent_chunks = sentChunks;
          },
        });
        record.submit_verified = delivery.submit_verified;
        record.retry_count = delivery.retry_count;
        record.rpc_methods = [...delivery.rpc_methods];
        record.typed = delivery.typed;
        record.submit_dispatched = delivery.submit_dispatched === true;
        finishDelivery(record, "delivered");
        if (lifecycle) {
          if (
            delivery.delivery === "queued" ||
            delivery.delivery === "queued_followup"
          ) {
            lifecycle.engine.acceptComposerQueue({
              delivery_id: record.delivery_id,
              agent_id: lifecycle.agent_id,
              text: lifecycle.text,
              press_enter: record.press_enter,
              source_event: lifecycle.source_event,
              retry_count: delivery.retry_count,
              rpc_methods: delivery.rpc_methods,
              typed: delivery.typed,
              submit_dispatched: delivery.submit_dispatched,
              delivery_state: delivery.delivery,
            });
          } else if (delivery.delivery === "pending_verify") {
            lifecycle.engine.acceptPendingVerify({
              delivery_id: record.delivery_id,
              agent_id: lifecycle.agent_id,
              text: lifecycle.text,
              press_enter: record.press_enter,
              source_event: lifecycle.source_event,
              retry_count: delivery.retry_count,
              rpc_methods: delivery.rpc_methods,
              typed: delivery.typed,
              submit_dispatched: delivery.submit_dispatched,
            });
          } else {
            lifecycle.engine.resolveDelivery({
              delivery_id: record.delivery_id,
              agent_id: lifecycle.agent_id,
              text: lifecycle.text,
              press_enter: record.press_enter,
              source_event: lifecycle.source_event,
              delivery_state:
                delivery.delivery === "rescued"
                  ? "rescued"
                  : delivery.delivery === "typed"
                    ? "typed"
                    : "submitted",
              terminal: true,
              retry_count: delivery.retry_count,
              rpc_methods: delivery.rpc_methods,
              typed: delivery.typed,
              submit_dispatched: delivery.submit_dispatched,
              submit_verified: delivery.submit_verified,
              error:
                delivery.delivery === "rescued"
                  ? "Prompt appeared only after an external interrupt"
                  : null,
            });
          }
        }
      } catch (error) {
        const errorRpcMethods = deliveryRpcMethodsFromError(error);
        const errorTyped = deliveryTypedFromError(error);
        const errorSubmitDispatched =
          deliverySubmitDispatchedFromError(error);
        if (errorRpcMethods.length > 0) {
          record.rpc_methods = errorRpcMethods;
        }
        record.typed = errorTyped;
        record.submit_dispatched = errorSubmitDispatched;
        if (error instanceof AmbiguousBootRecoveryReturnError) {
          // The shared dispatch boundary already stored the boot pointer's
          // passive-verification receipt. Do not terminalize the background
          // lifecycle receipt for a Return that may have landed.
          record.submit_verified = null;
          finishDelivery(record, "pending_verify", error.message);
          return;
        }
        if (error instanceof SubmitVerificationError) {
          record.submit_verified = false;
          record.submit_verification_reason = error.reason;
          record.retry_safe = error.retry_safe;
          record.retry_count = error.retry_count;
          record.rpc_methods = [...error.receipt.rpc_methods];
        } else if (error instanceof DeliverySafetyGateError) {
          record.submit_verified = error.submit_verified;
        }
        const message = error instanceof Error ? error.message : String(error);
        const failedChunk =
          error instanceof DeliveryError ? error.failed_chunk : undefined;
        finishDelivery(record, "failed", message, failedChunk);
        if (lifecycle) {
          lifecycle.engine.resolveDelivery({
            delivery_id: record.delivery_id,
            agent_id: lifecycle.agent_id,
            text: lifecycle.text,
            press_enter: record.press_enter,
            source_event: lifecycle.source_event,
            delivery_state: "failed",
            terminal: true,
            retry_count: record.retry_count,
            rpc_methods: record.rpc_methods,
            typed: record.typed,
            submit_dispatched: record.submit_dispatched,
            submit_verified: record.submit_verified,
            error: message,
          });
        }
      }
    };

    setTimeout(() => {
      withTransportRetryTracking(run);
    }, 0);
  };

  return {
    getSurfaceDelivery,
    withSurfaceWrite,
    observedSurfaceUuid,
    observeDraftOwnership,
    readParsedSurface,
    shouldVerifyRawSurfaceSubmit,
    executeDeliveryEngine,
    waitForLaunchShellReady,
    sendLauncherCommandToSurface,
    deliverBootPrompt,
    isBootPromptDelivered,
    startBackgroundDelivery,
  };
}

export type DeliveryEngine = ReturnType<typeof createDeliveryEngine>;
