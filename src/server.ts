/**
 * cmuxlayer MCP server — registers core tools + agent lifecycle tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { initializeNewSurfaceRuntime, readRuntimeMetadata, SurfaceRuntimeNotStartedError } from "./surface-runtime.js";
import {
  CMUXLAYER_DEFAULT_PALETTE_ENV,
  createDefaultToolPalette,
} from "./palette.js";
import { getTransportHealth } from "./cmux-transport-self-heal.js";
import {
  createFileSystemSeatManifestWriter,
  type SeatManifestWriter,
} from "./seat-manifest.js";
import { assertMutationAllowed } from "./mode-policy.js";
import { extractPrefix, replaceTaskSuffix } from "./naming.js";
import { createStaleBuildWarner, RUNNING_VERSION } from "./version.js";
import { buildSpawnToolReturn, shapeSpawnResponse } from "./spawn-response.js";
import {
  CODEX_EFFORT_VALUES,
  resolveSpawnEffort,
  resolveSpawnModelPolicy,
} from "./model-policy.js";
import { StateManager } from "./state-manager.js";
import { shellQuote } from "./agent-command.js";
import { withRaisedNofileSoftLimit } from "./nofile-limit.js";
import { agentProcessLiveness, agentProcessMayBeAlive } from "./util/pid-alive.js";
import {
  currentCliFallbackCount,
  currentTransportRetryCount,
  withTransportRetryTracking,
} from "./transport-retry-context.js";
import {
  AgentRegistry,
} from "./agent-registry.js";
import {
  AgentEngine,
  AgentLaunchError,
  RetryableDeliveryError,
  buildLaunchCommand,
  resolveSweepTiming,
  type AgentDeliveryReceipt,
} from "./agent-engine.js";
import {
  COORDINATION_CONTRACT_DELIVERED_NOTE,
  COORDINATION_CONTRACT_POINTER_NOT_VERIFIED,
  COORDINATION_CONTRACT_POINTER_SKIPPED_STERILE,
  COORDINATION_CONTRACT_SKIPPED_STERILE_NO_FILE,
  COORDINATION_CONTRACT_REFRESHED_NOT_REDELIVERED,
  COORDINATION_FOOTER_NOT_DELIVERED,
  bootContractMode,
  bootContractPointer,
  issueCoordinationContract,
  coordinationFooterBytes,
  writeBootContractFile,
  type CoordinationContract,
} from "./coordination-paths.js";
import {
  readMonitorRegistry,
  type MonitorRegistryOptions,
} from "./monitor-registry.js";
import {
  readWatchRegistry,
  releaseWatchReportPathReservation,
  removeWatches,
  reserveWatchReportPath,
  scopeWatchToSubject,
  updateWatchDeadline,
  WatchArmError,
  type WatchSpec,
} from "./watch-spec.js";
import {
  canonicalAgentId,
  resolveWatchOwner,
  watchOwnerIncludesCanonical,
  watchRecordOwner,
  type WatchOwnerCandidate,
} from "./watch-owner.js";
import {
  AgentDiscovery,
  SurfaceBindingChangedDuringDiscoveryError,
  type DiscoveredAgent,
} from "./agent-discovery.js";
import {
  INTERACTIVE_AGENT_STATES,
  isLiveDeliverable,
  isLiveTerminal,
  resolveLiveAgentState,
  screenConfirmedAgentState,
  TERMINAL_AGENT_STATES,
  type LiveAgentState,
} from "./live-agent-state.js";
import {
  resumeCommandForAgent,
  toAgentStatePayload,
} from "./agent-facade.js";
import { evaluateAgentHealth, } from "./agent-health.js";
import {
  AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
  AGENT_HEALTH_MONITOR_MAX_AGE_MS,
  buildAgentHealthInput,
  type AgentHealthInputOverrides,
} from "./agent-health-input.js";
import type {
  AgentRecord,
  AgentRole,
  AgentState,
  CliType,
  CloseTelemetryEvent,
  DeliveryEventType,
} from "./agent-types.js";
import {
  bootPromptRegistryFields,
  summarizeTaskSummary,
} from "./agent-types.js";
import {
  formatListSurfaces,
  formatReadScreen,
  formatAgentState,
  formatOk,
  formatDelivery,
} from "./format.js";
import {
  cleanScreenText,
  parseScreen,
  screenShowsPaused,
} from "./screen-parser.js";
import {
  CreatedIdentityScope,
} from "./created-identity.js";
import {
  dispatch,
  ensureInboxFile,
  formatInboxPing,
  inboxCursorPath,
  inboxTailPidPath,
  inboxMonitorState,
  inboxPath,
  monitorAlive,
  pendingDispatches,
  reapInboxTail,
  recommendedMonitorCommand,
  replayUndelivered,
  writeHeartbeat,
  type InboxOpts,
} from "./inbox.js";
import {
  applyHarnessState,
} from "./harness-session.js";
import {
  type CodexRolloutFill,
} from "./codex-rollout-fill.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import {
  collectRoleSurfaceIds,
  chooseAgentSpawnPlacement,
  chooseSurfaceClosePolicy,
  deriveColumnIndex,
  inferAgentRole,
  inferRecordRoleOrNull,
  launcherNameForCli,
} from "./layout-policy.js";
import type {
  CmuxPane,
  CmuxSurface,
  CmuxTerminalMetadata,
  CmuxWorkspace,
  ControlMode,
  ParsedScreenResult,
} from "./types.js";
import {normalizeKeyName } from "./key-names.js";
import { assertCanonicalSurfaceRef } from "./surface-ref.js";
import {
  currentCallerContext,
} from "./caller-context.js";
import {
  screenHasActiveAgentMarker,
} from "./pattern-registry.js";
import {
  normalizeWorkspaceRefAlias,
  reposEquivalent,
  resolveWorkspaceRefForRepo,
  workspaceDirectoryRepoMatchScore,
} from "./repo-workspace.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
import {
  isPaneSurfaceEnumerationComplete,
  resolveObservedAgentSurfaceRef,
  type SurfaceBindingObservation,
} from "./surface-binding-observation.js";
import {
  collectSelfHealHealth,
  collectControlHealth,
  formatControlHealth,
  type ControlHealth,
  type LifecycleStartHealth,
} from "./control-health.js";
import {
  collectSurfaceTopology as collectCmuxSurfaceTopology,
  enumerateAllWindowWorkspacesWithRetry,
  invalidateSurfaceTopologyCallScope,
  EMPTY_SURFACE_TOPOLOGY,
  enrichSurfaceIdsFromPanes,
  healthTopologyOverrides,
  resolveAgentSurfaceBinding,
  withSurfaceTopologyMutationInvalidation,
  type SurfaceObserverIdProvider,
  type SurfaceTopologySnapshot,
  type TopologyRpcObserver,
} from "./surface-topology.js";
import {
  formatMcpProfileEnv,
  prepareWorktree,
  rollbackPreparedWorktree,
  type McpProfile,
} from "./worktree.js";
import { resolveRepoRootFromLauncherRegistryOrNull } from "./launcher-registry.js";
import {
  defaultRepoCheckoutPath,
  resolveRepoRootWithoutRegistry,
} from "./repo-root-fallback.js";
import { resolveSpawnPermissionMode } from "./permission-mode.js";
import {
  loadSeatRegistryFromConfig,
} from "./seat-identity.js";
import {
  hasInlinePrompt,
  normalizeTerminalText,
  inferComposerCli,
  isComposerFooterOrChromeLine,
  extractComposerInputRegion,
  screenShowsPendingInput,
  screenShowsCompletePendingInput,
  composerHoldsForeignDraft,
  screenShowsQueuedAgentInput,
  screenShowsQueuedCursorFollowup,
  screenShowsPendingShellInput,
  classifyPendingLauncherLine,
  composeBootDeliveryText,
} from "./delivery/composer-screen.js";
import {
  ANNOTATIONS,
  WatchSpecArgsSchema,
  WatchSpecSchema,
  BOOT_PROMPT_TIMEOUT_MS,
  SEND_TO_WORKING_EXAMPLE,
  SendToArgsSchema,
  legacyCompatibleAgentRoleSchema,
  spawnFunctionSchema,
  spawnPlacementSchema,
  normalizeToolAgentRole,
  normalizeSpawnAxes,
  BroadcastArgsSchema,
} from "./mcp/schemas.js";
import {
  deliveryRpcMethodsFromError,
  deliveryTypedFromError,
  deliverySubmitDispatchedFromError,
  bootPromptFailureMutationEvidence,
  createDeliveryPhaseTimings,
  withSurfaceDeliveryTimings,
  timeDeliveryPhase,
  buildPublicDeliveryReceipt,
  pausedTargetWarning,
  DeliveryError,
  SubmitVerificationError,
  AmbiguousBootRecoveryReturnError,
  submitVerificationFailurePayload,
  DeliverySafetyGateError,
  ManualModeMutationError,
  PLACEMENT_WORKSPACE_UNRESOLVED,
  BootPromptTimeoutError,
  LauncherReadinessError,
  BootPromptDeliveryError,
  BootComposerResidueError,
  BootPromptUpdateMenuBlockedError,
  SurfaceGoneError,
} from "./delivery/receipts.js";
import type {
  BroadcastReceipt,
  SubmitEvidence,
  PublicDeliveryReceipt,
  DeliveryRpcMethod,
  DeliveryPhaseTimings,
  DeliveryRecord,
} from "./delivery/receipts.js";
import {
  readErrorText,
  controlModeFromStatusEntries,
  screenUnavailableMessage,
  surfaceGonePayload,
  ok,
  okFormatted,
  err,
  findErrorInChain,
  requireValue,
  LifecycleStartTimeoutError,
} from "./mcp/tool-result.js";
import type {
} from "./mcp/tool-result.js";
import {
  SEND_INPUT_CHUNK_THRESHOLD,
  PANE_INPUT_BREAKAGE_GUIDANCE,
  ZSH_BANG_INLINE_WARNING,
  SEND_INPUT_PASTE_BATCH_MAX_BYTES,
  SEND_INPUT_CHUNK_DELAY_MS,
  SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS,
  SEND_INPUT_MAX_INLINE_CHARS,
  SHORT_POINTER_MAX_CHARS,
  SHORT_POINTER_SUBMIT_VERIFY_TIMEOUT_MS,
  BUSY_AGENT_SUBMIT_VERIFY_TIMEOUT_MS,
  INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS,
  chunkTerminalInput,
  limitInputChunksByUtf8ByteSize,
  buildInputDeliveryBatches,
  assertInteractiveMultilineInputAllowed,
  getBootPromptPath,
  assertInlineInputAllowed,
  assertDenseInlineInputAllowed,
  assertSpawnPromptInputAllowed,
  assertBroadcastInlineInputAllowed,
  broadcastRoleMatches,
  inferBroadcastRecordRole,
  assertBootPromptMode,
} from "./delivery/input-policy.js";
import {
  DEFAULT_REPORT_WATCH_DEADLINE_MS,
  resolveLifecycleStartTimeoutMs,
  awaitBoundedLifecycleStart,
  registerAutoVitestTempDir,
  createServerContext,
  resolveServerInboxBaseDir,
} from "./mcp/context.js";
import type {
  CreateServerOptions,
  CmuxLayerClient,
  ReadScreenSnapshot,
  LifecycleAgentInputDeliverer,
} from "./mcp/context.js";
import {
  pickLatestSurfaceModel,
  resolveHarnessStateForSurface,
  resolveLatestSurfaceAgentRecord,
  enrichParsedScreen,
} from "./delivery/surface-state.js";
import {
  createDeliveryEngine,
  requiredBootReadyObservations,
} from "./delivery/engine.js";

// Public surface kept stable: these moved to ./mcp/context.ts (CX-2 S4).
export {
  DEFAULT_LIFECYCLE_START_TIMEOUT_MS,
  DEFAULT_REPORT_WATCH_DEADLINE_MS,
  resolveLifecycleStartTimeoutMs,
  awaitBoundedLifecycleStart,
  createServerContext,
  resolveServerInboxBaseDir,
} from "./mcp/context.js";
export type {
  CreateServerOptions,
  LifecycleAgentInputDeliverer,
  CmuxServerContext,
} from "./mcp/context.js";


// Public surface kept stable: these moved to ./delivery/input-policy.ts (CX-2 S4).
export {
  SEND_INPUT_CHUNK_THRESHOLD,
  DENSE_INLINE_POLICY_MAX_UNBROKEN_CHARS,
  DEFAULT_SEND_INPUT_MAX_INLINE_CHARS,
  SEND_INPUT_PASTE_BATCH_MAX_BYTES,
  parseMaxInlineChars,
  SEND_INPUT_MAX_INLINE_CHARS,
  splitTextByUtf8ByteLimit,
  buildInputDeliveryBatches,
} from "./delivery/input-policy.js";
export type {
  InputDeliveryBatch,
} from "./delivery/input-policy.js";


import {
  bindToolDeps,
  installToolRegistration,
  type ToolDeps,
} from "./mcp/registration.js";
import {
  SurfaceEnumerationError,
  requireSurfaceEnumerationArray,
  isSurfaceEnumerationError,
} from "./surface-enumeration-error.js";
import {
  createLifecycleAgentEngine,
  registerListAgentsTool,
  registerReportToParentTool,
} from "./mcp/tools/agent.js";

// Public surface kept stable: these moved to ./mcp/tools/agent.ts (CX-3b S10a).
export {
  rankDuplicateWatchOwnerCandidate,
  selectDuplicateWatchOwnerCandidate,
} from "./mcp/tools/agent.js";

export { engineForTests } from "./mcp/registration.js";
// Public surface kept stable: these moved to ./mcp/tool-result.ts (CX-2 S3).
export {
  __leanReceiptTestHooks,
  LifecycleStartTimeoutError,
} from "./mcp/tool-result.js";


// Public surface kept stable: these moved to ./delivery/receipts.ts (CX-2 S3).
export {
  buildPublicDeliveryReceipt,
  pausedTargetWarning,
} from "./delivery/receipts.js";
export type {
  SubmitEvidence,
  PublicDeliveryReceipt,
  DeliveryRecord,
} from "./delivery/receipts.js";


// Public surface kept stable: these moved to ./mcp/schemas.ts (CX-2 S2).
export {
  PUBLIC_TOOL_NAMES,
} from "./mcp/schemas.js";


// Public surface kept stable: these moved to ./delivery/composer-screen.ts (CX-2 S1).
export {
  screenShowsPendingShellInput,
  classifyPendingLauncherLine,
} from "./delivery/composer-screen.js";
export type {
  PendingLauncherLineKind,
} from "./delivery/composer-screen.js";

// Only the internal scope=agent close delegate can request this teardown path.
// A remote JSON tool caller cannot supply a symbol property.
const OWNED_AGENT_CLOSE_ON_UNKNOWN_PID = Symbol(
  "owned-agent-close-on-unknown-pid",
);

// Re-export for test access
export { sanitizeTerminalInput } from "./sanitize.js";

/**
 * Process-wide stale-build warner. After a brew release, an already-running
 * per-agent MCP stdio child keeps serving spawns from its OLD dist until the
 * agent `/mcp reconnect`s — silently mis-placing workers with pre-release logic
 * (the #247 recurrence root cause). The warner (see version.ts) caches the
 * warning FOREVER once stale, but RE-CHECKS (throttled) while not-yet-stale, so
 * a fresh child that later goes stale via `brew upgrade` is still flagged
 * rather than silenced by a permanently-cached non-stale verdict.
 */
const defaultStaleBuildWarner = createStaleBuildWarner();

type ListSurfacesRemoteState =
  "local" | "connected" | "disconnected" | "unavailable";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function summarizeRemoteState(remoteValue: unknown): ListSurfacesRemoteState {
  const remote = asRecord(remoteValue);
  if (!remote) {
    return "local";
  }

  const state =
    typeof remote.state === "string"
      ? (remote.state as ListSurfacesRemoteState | string)
      : undefined;
  const connected = remote.connected === true || state === "connected";
  if (connected) {
    return "connected";
  }

  const hasRemoteHints =
    remote.enabled === true ||
    remote.has_ssh_options === true ||
    remote.has_identity_file === true ||
    (typeof remote.destination === "string" && remote.destination.length > 0) ||
    (remote.port !== null && remote.port !== undefined) ||
    (remote.local_proxy_port !== null && remote.local_proxy_port !== undefined);

  if (!hasRemoteHints && (state === undefined || state === "disconnected")) {
    return "local";
  }

  if (state === "unavailable") {
    return hasRemoteHints ? "unavailable" : "local";
  }

  return "disconnected";
}

function toMinimalWorkspace(
  workspace: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ref: typeof workspace.ref === "string" ? workspace.ref : "",
    title: typeof workspace.title === "string" ? workspace.title : "",
    current_directory:
      typeof workspace.current_directory === "string"
        ? workspace.current_directory
        : null,
    remote_state: summarizeRemoteState(workspace.remote),
  };
}

function toMinimalSurface(
  surface: Record<string, unknown>,
): Record<string, unknown> {
  const minimal: Record<string, unknown> = {
    ref: typeof surface.ref === "string" ? surface.ref : "",
    title: typeof surface.title === "string" ? surface.title : "",
    type: typeof surface.type === "string" ? surface.type : "terminal",
    workspace_ref:
      typeof surface.workspace_ref === "string" ? surface.workspace_ref : "",
  };

  if (typeof surface.id === "string") {
    minimal.id = surface.id;
  }
  if (typeof surface.pane_ref === "string") {
    minimal.pane_ref = surface.pane_ref;
  }
  if (typeof surface.column === "number") {
    minimal.column = surface.column;
  }
  if (typeof surface.screen_preview === "string") {
    minimal.screen_preview = surface.screen_preview;
  }
  if (typeof surface.screen_preview_error === "string") {
    minimal.screen_preview_error = surface.screen_preview_error;
  }
  if (typeof surface.current_directory === "string") {
    minimal.current_directory = surface.current_directory;
  } else if (surface.current_directory === null) {
    minimal.current_directory = null;
  }
  if (typeof surface.requested_working_directory === "string") {
    minimal.requested_working_directory = surface.requested_working_directory;
  } else if (surface.requested_working_directory === null) {
    minimal.requested_working_directory = null;
  }
  if (typeof surface.working_directory_source === "string") {
    minimal.working_directory_source = surface.working_directory_source;
  }
  if (typeof surface.working_directory_fallback === "boolean") {
    minimal.working_directory_fallback = surface.working_directory_fallback;
  }

  return minimal;
}

type SurfaceWorkingDirectorySource =
  | "terminal_metadata"
  | "surface"
  | "pane"
  | "workspace_fallback"
  | "unavailable";

interface SurfaceWorkingDirectory {
  cwd: string | null;
  source: SurfaceWorkingDirectorySource;
}

interface SurfaceWorkingDirectoryMaps {
  terminalBySurface: Map<string, CmuxTerminalMetadata>;
  paneByWorkspaceAndRef: Map<string, Record<string, unknown>>;
  workspaceCwdByRef: Map<string, string>;
}

interface TerminalMetadataLoadResult {
  terminalBySurface: Map<string, CmuxTerminalMetadata>;
  degraded?: {
    terminal_metadata: true;
    error_code: "terminal_metadata_unavailable";
    error: string;
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function workingDirectoryFromRecord(
  record: Record<string, unknown> | null | undefined,
): string | null {
  return (
    nonEmptyString(record?.current_directory) ??
    nonEmptyString(record?.cwd) ??
    nonEmptyString(record?.working_directory)
  );
}

function paneWorkingDirectoryKey(
  workspaceRef: string,
  paneRef: string,
): string {
  return `${workspaceRef}\0${paneRef}`;
}

async function loadTerminalMetadataBySurface(
  client: CmuxLayerClient,
): Promise<TerminalMetadataLoadResult> {
  const metadataClient = client as CmuxLayerClient & {
    listTerminalMetadata?: () => Promise<{ terminals: CmuxTerminalMetadata[] }>;
  };
  if (typeof metadataClient.listTerminalMetadata !== "function") {
    return { terminalBySurface: new Map() };
  }

  try {
    const { terminals } = await metadataClient.listTerminalMetadata();
    const bySurface = new Map<string, CmuxTerminalMetadata>();
    for (const terminal of terminals) {
      const surfaceRef =
        nonEmptyString(terminal.surface_ref) ??
        nonEmptyString(terminal.surface_id) ??
        nonEmptyString(terminal.ref);
      if (surfaceRef) {
        bySurface.set(surfaceRef, terminal);
      }
    }
    return { terminalBySurface: bySurface };
  } catch (error) {
    return {
      terminalBySurface: new Map(),
      degraded: {
        terminal_metadata: true,
        error_code: "terminal_metadata_unavailable",
        error: readErrorText(error),
      },
    };
  }
}

function resolveSurfaceWorkingDirectory(
  surface: Record<string, unknown>,
  workspaceRef: string,
  paneRef: string,
  maps: SurfaceWorkingDirectoryMaps,
): SurfaceWorkingDirectory {
  const surfaceRef = nonEmptyString(surface.ref);
  const terminal =
    surfaceRef === null ? undefined : maps.terminalBySurface.get(surfaceRef);
  const terminalCwd = workingDirectoryFromRecord(
    terminal ? (terminal as Record<string, unknown>) : null,
  );
  if (terminalCwd) {
    return { cwd: terminalCwd, source: "terminal_metadata" };
  }

  const surfaceCwd = workingDirectoryFromRecord(surface);
  if (surfaceCwd) {
    return { cwd: surfaceCwd, source: "surface" };
  }

  const pane = maps.paneByWorkspaceAndRef.get(
    paneWorkingDirectoryKey(workspaceRef, paneRef),
  );
  const paneCwd = workingDirectoryFromRecord(pane);
  if (paneCwd) {
    return { cwd: paneCwd, source: "pane" };
  }

  const workspaceCwd = maps.workspaceCwdByRef.get(workspaceRef);
  if (workspaceCwd) {
    return { cwd: workspaceCwd, source: "workspace_fallback" };
  }

  return { cwd: null, source: "unavailable" };
}

function applySurfaceWorkingDirectory(
  surface: Record<string, unknown>,
  workspaceRef: string,
  paneRef: string,
  maps: SurfaceWorkingDirectoryMaps,
): void {
  const resolved = resolveSurfaceWorkingDirectory(
    surface,
    workspaceRef,
    paneRef,
    maps,
  );
  surface.current_directory = resolved.cwd;
  surface.requested_working_directory = resolved.cwd;
  surface.working_directory_source = resolved.source;
  surface.working_directory_fallback =
    resolved.source === "workspace_fallback" ||
    resolved.source === "unavailable";
}

async function preflightBootPromptFile(path: string): Promise<void> {
  try {
    await access(path, fsConstants.R_OK);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "ERROR";
    if (code === "ENOENT") {
      throw new Error(`boot_prompt_path ENOENT: ${path}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`boot_prompt_path permission denied: ${path}`);
    }
    throw error;
  }
}

function inferLauncherCli(command: string): CliType | null {
  if (!/(^|\s)-s(?:\s|$)/.test(command)) {
    return null;
  }

  const match = command.match(
    /(?:^|\s)[A-Za-z0-9_.-]+(Claude|Codex|Cursor|Gemini|Kiro)\b/,
  );
  if (!match) {
    return null;
  }

  return match[1].toLowerCase() as CliType;
}

function inferLauncherFromTitle(
  title?: string,
): { repo: string; cli: CliType; launcherName: string } | null {
  if (!title) return null;
  const launcherTitle = extractPrefix(title);
  const match = launcherTitle.match(
    /^(.+?)(Claude|Codex|Cursor|Gemini|Kiro)$/i,
  );
  if (!match) {
    return null;
  }
  const repo = match[1].trim();
  if (!repo || repo === "." || repo === "..") {
    return null;
  }
  return {
    repo,
    cli: match[2].toLowerCase() as CliType,
    launcherName: launcherTitle,
  };
}

function inferRepoFromLauncherTitle(title?: string): string | null {
  return inferLauncherFromTitle(title)?.repo ?? null;
}

function formatToolValidationError(
  toolName: string,
  error: z.ZodError,
): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  const example = toolName === "send_to" ? ` ${SEND_TO_WORKING_EXAMPLE}` : "";
  return `${toolName} invalid arguments: ${details}.${example}`;
}

export const __submitEvidenceTestHooks = {
  extractComposerInputRegion,
  screenShowsPendingInput,
  screenShowsCompletePendingInput,
  composerHoldsForeignDraft,
  requiredBootReadyObservations,
  composeBootDeliveryText,
};

type MonitorBootResult = {
  status: "bootstrapped" | "monitor-not-ready";
  heartbeat_written: boolean;
  heartbeat_source: "server_boot";
  monitor_command: string;
  /** Agent-owned consumption watermark; the engine never writes this file. */
  cursor_path: string;
  /** Run after handling with the message id supplied as CMUX_INBOX_MSG_ID. */
  cursor_update_command: string;
  cursor_update_env: "CMUX_INBOX_MSG_ID";
  error?: string;
};

export interface TargetIdentity {
  surface: string;
  title?: string;
  model?: string;
  agent_type?: string;
}

// Best-effort target-agent identity for delivery responses (send_input /
// send_command). `title` is the live cmux tab/surface title when known — never
// the boot prompt / task_summary. Model/cli come from the in-memory registry.
function resolveTargetIdentity(
  stateMgr: StateManager,
  surfaceRef: string,
  surfaceTitle?: string | null,
  stableSurfaceIdentity?: string | null,
): TargetIdentity {
  const identity: TargetIdentity = { surface: surfaceRef };
  const title = surfaceTitle?.trim();
  if (title) identity.title = title;
  const record = resolveLatestSurfaceAgentRecord(
    stateMgr,
    surfaceRef,
    stableSurfaceIdentity,
  );
  if (record?.model) identity.model = record.model;
  if (record?.cli) identity.agent_type = record.cli;
  return identity;
}

// Map a live screen status onto a healthy AgentState. Only running/idle states are "healthy"
// enough to override a stale registry error — "done"/"frozen" are left to the registry.
const LIVE_HEALTHY_STATE: Partial<
  Record<ParsedScreenResult["status"], AgentState>
> = {
  working: "working",
  thinking: "working",
  idle: "idle",
};

/**
 * Reconcile a registry AgentState with the live read_screen parse for my_agents.
 * An active agent screen is ground truth for liveness, so working/thinking screens win
 * over stale inactive registry states. A healthy idle screen only clears a stale error.
 */
export function reconcileAgentLiveState(
  registryState: AgentState,
  screen: ParsedScreenResult | null,
): AgentState {
  if (screenConfirmedAgentState(screen) === "error") return "error";
  // Only a REAL agent screen can clear an error. parseScreen reports status:"idle" for a
  // plain shell prompt (agent_type:"unknown"), so a crashed agent fallen back to a shell must
  // keep its registry error instead of being masked as healthy idle.
  if (screen && screen.agent_type !== "unknown") {
    const live = LIVE_HEALTHY_STATE[screen.status];
    if (live === "working") return live;
    if (registryState === "error" && live) return live;
  }
  return registryState;
}

export function createServer(opts?: CreateServerOptions): McpServer {
  const ownsContext = !opts?.context;
  const context = opts?.context ?? createServerContext(opts);
  const client = withSurfaceTopologyMutationInvalidation(context.client);
  const listAllWorkspaces = async (onRpc?: TopologyRpcObserver) => {
    const listed = await enumerateAllWindowWorkspacesWithRetry(
      client,
      () => context.surfaceObserverEpoch,
      onRpc,
    );
    if (!listed.complete) {
      throw new SurfaceEnumerationError(
        "Malformed cmux surface enumeration: incomplete all-window workspace enumeration",
      );
    }
    return listed;
  };
  const stateMgr = context.stateMgr;
  const roleSurfaceOverrides = context.roleSurfaceOverrides;
  const explicitRoleForDiscoveredSurface = (
    discovered: Pick<
      DiscoveredAgent,
      "surface_id" | "surface_uuid" | "workspace_id"
    >,
  ): AgentRole | null => {
    const uuid = discovered.surface_uuid?.trim().toLowerCase() || null;
    const workspace = discovered.workspace_id ?? null;
    const matchesBinding = (override: {
      role: AgentRole;
      workspace: string | null;
      surfaceUuid: string | null;
    }): boolean => {
      if (workspace && override.workspace && workspace !== override.workspace) {
        return false;
      }
      const overrideUuid = override.surfaceUuid?.trim().toLowerCase() || null;
      return uuid === null ? true : overrideUuid === uuid;
    };
    const direct = roleSurfaceOverrides.get(discovered.surface_id);
    if (direct && matchesBinding(direct)) {
      return direct.role;
    }
    if (!uuid) return null;
    const stableMatches = [...roleSurfaceOverrides.values()].filter(
      (override) =>
        override.surfaceUuid?.trim().toLowerCase() === uuid &&
        matchesBinding(override),
    );
    return stableMatches.length === 1 ? stableMatches[0]!.role : null;
  };
  const eventLog = context.eventLog;
  const deliveries = context.deliveries;
  const latestDeliveryBySurface = context.latestDeliveryBySurface;
  const activeDeliveryBySurface = context.activeDeliveryBySurface;
  const activeSurfaceWrites = context.activeSurfaceWrites;
  const originalLaunchCommandsBySurface =
    context.originalLaunchCommandsBySurface;
  const launchShellRecoveryBySurface = context.launchShellRecoveryBySurface;
  const surfaceWriteLiveness = context.surfaceWriteLiveness;
  const surfaceWriteLivenessCandidates = context.surfaceWriteLivenessCandidates;
  const surfacePtyDeadSince = context.surfacePtyDeadSince;
  const seatManifestWriter: SeatManifestWriter =
    opts?.seatManifestWriter ??
    (process.env.VITEST === "true"
      ? async () => {}
      : createFileSystemSeatManifestWriter());
  const seatManifestNow =
    opts?.seatManifestNow ?? (() => new Date().toISOString());
  const skipAgentLifecycle =
    opts?.skipAgentLifecycle ?? context.skipAgentLifecycle;
  const lifecycleInitializer =
    opts?.lifecycleInitializer ?? context.lifecycleInitializer;
  const spawnPreflight = opts?.spawnPreflight ?? context.spawnPreflight;
  const disableSpawnPreflight =
    opts?.disableSpawnPreflight ?? context.disableSpawnPreflight;
  const controlHealthCollector =
    opts?.controlHealthCollector ?? context.controlHealthCollector;
  const controlHealthWarnings =
    opts?.controlHealthWarnings ?? context.controlHealthWarnings;
  const seatRegistry =
    opts?.seatRegistry !== undefined
      ? opts.seatRegistry
      : loadSeatRegistryFromConfig(opts?.seatRegistryPath);
  const staleBuildWarning = opts?.staleBuildWarner ?? defaultStaleBuildWarner;
  const appendStaleBuildWarning = (result: { warnings?: string[] }): void => {
    const warning = staleBuildWarning();
    if (warning) {
      result.warnings = [...(result.warnings ?? []), warning];
    }
  };
  const inboxBaseDir = resolveServerInboxBaseDir({
    explicitBaseDir: opts?.inboxBaseDir,
    isVitest: process.env.VITEST === "true",
  });
  if (inboxBaseDir && process.env.VITEST === "true" && !opts?.inboxBaseDir) {
    registerAutoVitestTempDir(inboxBaseDir);
  }
  const inboxOpts: InboxOpts = inboxBaseDir ? { baseDir: inboxBaseDir } : {};
  const ensureMonitorBoot = (agentId: string): MonitorBootResult => {
    let monitorCommand = "";
    const cursorPath = inboxCursorPath(agentId, inboxOpts);
    const cursorUpdateCommand = `${
      inboxBaseDir
        ? `CMUXLAYER_INBOX_BASE_DIR=${shellQuote(inboxBaseDir)} `
        : ""
    }cmuxlayer inbox-cursor ${shellQuote(agentId)}`;
    try {
      monitorCommand = recommendedMonitorCommand(agentId, inboxOpts);
      ensureInboxFile(agentId, inboxOpts);
      writeHeartbeat(agentId, inboxOpts, "server_boot");
      return {
        status: "bootstrapped",
        heartbeat_written: true,
        heartbeat_source: "server_boot",
        monitor_command: monitorCommand,
        cursor_path: cursorPath,
        cursor_update_command: cursorUpdateCommand,
        cursor_update_env: "CMUX_INBOX_MSG_ID",
      };
    } catch (e) {
      return {
        status: "monitor-not-ready",
        heartbeat_written: false,
        heartbeat_source: "server_boot",
        monitor_command: monitorCommand,
        cursor_path: cursorPath,
        cursor_update_command: cursorUpdateCommand,
        cursor_update_env: "CMUX_INBOX_MSG_ID",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };
  const mailboxBootContract = (
    agentId: string,
    monitorBoot: MonitorBootResult,
  ): string =>
    `cmuxlayer mailbox contract for ${agentId}: monitor with ${monitorBoot.monitor_command}; ` +
    `after each handled message run CMUX_INBOX_MSG_ID=<handled-message-id> ${monitorBoot.cursor_update_command}`;

  // AIDEV-NOTE (P11b): the boot prompt carries a POINTER, not the contract.
  // Inline, the mailbox contract alone is ~479 chars against a 500-char chunk
  // threshold, so #454's report contract could not be added without moving
  // EVERY spawn's boot delivery onto the chunked paste path (#434/#438). The
  // contract now lives in a file the engine writes at spawn; the wire carries
  // one short line. See coordination-paths.ts for the honest cost.
  const buildBootContractInjection = (
    agentId: string,
    monitorBoot: MonitorBootResult,
    coordination: CoordinationContract | null,
  ): { text: string; contract_path: string | null } => {
    if (bootContractMode() === "inline") {
      return {
        text: mailboxBootContract(agentId, monitorBoot),
        contract_path: null,
      };
    }
    try {
      const agent = stateMgr.readState(agentId);
      const written = writeBootContractFile(
        {
          agentId,
          role: agent?.role,
          leadAgentId: agent?.parent_agent_id,
          collabPath: agent?.collab_path,
          mailbox: {
            monitor_command: monitorBoot.monitor_command,
            // Contract-file only, deliberately NOT on the monitor_boot receipt: the
            // pidfile is the seat's own teardown handle, not engine-observed state.
            tail_pid_path: inboxTailPidPath(agentId, inboxOpts),
            cursor_update_command: monitorBoot.cursor_update_command,
            cursor_update_env: monitorBoot.cursor_update_env,
          },
          coordination,
        },
        inboxOpts,
      );
      return {
        text: bootContractPointer(agentId, written.path),
        contract_path: written.path,
      };
    } catch {
      // A contract-file write failure must not fail an otherwise-successful
      // spawn. Fall back to the pre-P11b inline mailbox contract: the worker
      // loses the report half (exactly as before P11b), not its mailbox.
      return {
        text: mailboxBootContract(agentId, monitorBoot),
        contract_path: null,
      };
    }
  };

  // AIDEV-NOTE (P11/U10): the engine issues the coordination contract at spawn,
  // returns it in the receipt, persists it on the record, AND tells the worker
  // the same two strings. That is the whole S3 fix -- producer and consumer read
  // one engine-authored value instead of each re-deriving one from prose.
  // Derived from agent_id alone and applied above launchMode, so a
  // registry-optional / raw-CLI spawn (#453) gets an identical contract.
  const issueSpawnCoordination = (
    agentId: string,
    reportPathOverride?: string | null,
  ): CoordinationContract =>
    issueCoordinationContract(agentId, {
      ...inboxOpts,
      reportPath: reportPathOverride ?? null,
    });
  // Wired up by the agent-lifecycle block below (when enabled). Lets the
  // dispatch_to_agent nudge reuse the guarded relay path — stale-surface
  // resync + recycled-occupant identity checks — instead of raw keystrokes.
  let lifecycleAgentInputDeliverer: LifecycleAgentInputDeliverer | null = null;
  let lifecycleSeatManifestPublisher: (input: {
    agentId?: string;
    surfaceId?: string;
    surfaceUuid?: string;
    tabName?: string;
    model?: string;
  }) => Promise<void> = async () => {};
  let lifecycleEnsureRegistered: (() => Promise<void>) | null = null;
  let lifecycleScheduleChildReportWatchPrune: (() => void) | null = null;
  const snapshotWatchOwnerCandidates = (): AgentRecord[] =>
    [
      ...(context.lifecycleRegistry?.list() ?? []),
      ...stateMgr.listStates(),
    ].filter(
      (candidate, index, rows) =>
        rows.findIndex((row) => row.agent_id === candidate.agent_id) === index,
    );
  const removeOwnedWatchesFor = async (
    agentId: string,
    candidates: readonly WatchOwnerCandidate[],
  ): Promise<number> => {
    const target = canonicalAgentId(agentId);
    return removeWatches(
      (watch) => {
        const resolution = resolveWatchOwner(
          watchRecordOwner(watch),
          candidates,
        );
        return (
          resolution.kind === "resolved" &&
          watchOwnerIncludesCanonical(resolution, target)
        );
      },
      {
        registryPath:
          opts?.watchRegistryPath ?? join(context.stateDir, "watch-specs.json"),
      },
    );
  };
  const pruneChildReportWatchesFor = (agentId: string): void => {
    lifecycleScheduleChildReportWatchPrune?.();
    removeWatches(
      (watch) => {
        if (
          watch.subject_agent_id !== agentId ||
          watch.target_kind !== "file" ||
          watch.change !== "content"
        ) {
          return false;
        }
        const current = stateMgr.readState(agentId);
        return (
          !current ||
          current.user_killed === true ||
          current.deletion_intent ||
          TERMINAL_AGENT_STATES.has(current.state)
        );
      },
      {
        registryPath:
          opts?.watchRegistryPath ?? join(context.stateDir, "watch-specs.json"),
      },
    ).catch((error) => {
      console.error(
        `[cmuxlayer] deferred child watch cleanup for ${agentId}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  };
  let lifecycleRefreshManagedMetadata:
    ((agentId?: string) => Promise<void>) | null = null;
  let lifecycleHealthEngine: AgentEngine | null = null;
  const refreshManagedMetadataBestEffort = async (
    agentId?: string,
  ): Promise<void> => {
    try {
      await lifecycleRefreshManagedMetadata?.(agentId);
    } catch {
      // Health/read paths should not fail just because a refresh scan failed.
    }
  };
  /**
   * AIDEV-NOTE (F1): live-derived state for one record, resolved from the last
   * screen scan. Wired to the discovery cache inside the lifecycle block; until
   * then (and whenever no fresh scan exists) it degrades to the registry record
   * as explicit `source: "registry"` provenance, never as silent truth.
   */
  const liveAgentStateProbe: {
    current: ((agent: AgentRecord) => LiveAgentState | null) | null;
  } = { current: null };
  const liveStateFor = (agent: AgentRecord): LiveAgentState =>
    liveAgentStateProbe.current?.(agent) ?? resolveLiveAgentState(agent, null);

  const resolveCurrentCallerAgent = (): AgentRecord | null => {
    const callerSurface = currentCallerContext()?.surfaceId?.trim();
    if (!callerSurface) return null;
    const normalizedSurface = callerSurface.toLowerCase();
    const records = [
      ...(context.lifecycleRegistry?.list() ?? []),
      ...stateMgr.listStates(),
    ];
    const matchesUuid = (agent: AgentRecord): boolean =>
      agent.surface_uuid?.trim().toLowerCase() === normalizedSurface;
    const matchesSurfaceId = (agent: AgentRecord): boolean =>
      agent.surface_id === callerSurface;
    // AIDEV-NOTE (F1): a terminal state is an ORDERING signal here, never an
    // exclusion, and it is read LIVE. #408 flips live agents to `done` within
    // minutes; excluding those records made the caller invisible, so the child
    // it spawned recorded parent_agent_id:null (U6) and the #378 worker guard
    // silently no-opped. A record bound to the surface the call is arriving on
    // is the best available caller identity even when the record is stale --
    // the call itself is the liveness evidence. The live-first ordering still
    // lets a genuinely live record win a recycled surface (#378 MEDIUM-A).
    // AIDEV-NOTE (#468): the LAST tier matches a TERMINAL record by
    // `surface_id`, and `surface_id` is a RECYCLABLE ref -- a dead worker's
    // record whose ref got reused could claim to be the caller, and #378 then
    // forced the new pane's children to worker/right off a corpse. The obvious
    // guard -- compare the live pane's CLI to the record's, as
    // deliverAgentInput does -- does NOT work here: `registry.listMerged`
    // rewrites `record.cli` from the live pane, so by the time caller
    // resolution runs, a recycled record already claims the new occupant's CLI.
    //
    // `surface_observer_id` IS a signal the merge does not overwrite: it is
    // stamped when this observer binds the surface and only ever replaced by
    // another binding. A ref stamped by a dead socket generation (or never
    // stamped at all) proves nothing about who occupies that ref now, so those
    // records are refused at the ref-only tier. Tiers 1 and 3 (UUID) are
    // unaffected -- a UUID is not recyclable -- and a record this observer owns
    // still resolves, which is what keeps U6 working for #408-poisoned rows.
    //
    // Cost, stated plainly: a caller whose record predates observer identity
    // gets no attribution and sees an explicit refusal instead of a wrong
    // parent. That is the trade this repo already makes everywhere else
    // absence is ambiguous.
    const observerOwnerId = context.surfaceObserverId?.trim() || null;
    const ownsRefBinding = (agent: AgentRecord): boolean =>
      Boolean(observerOwnerId && agent.surface_observer_id === observerOwnerId);
    const live = (agent: AgentRecord): boolean =>
      !isLiveTerminal(liveStateFor(agent));
    return (
      records.find((agent) => matchesUuid(agent) && live(agent)) ??
      records.find((agent) => matchesSurfaceId(agent) && live(agent)) ??
      records.find(matchesUuid) ??
      records.find(
        (agent) => matchesSurfaceId(agent) && ownsRefBinding(agent),
      ) ??
      null
    );
  };

  // Channel discipline applies only to worker-invoked tools. Internal watch
  // pushes call deliverAgentInput directly; halt escalation dispatches to inbox.
  const assertWorkerUpwardChannel = (target: string): void => {
    const caller = resolveCurrentCallerAgent();
    if (!caller?.collab_path || inferRecordRoleOrNull(caller) !== "worker") {
      return;
    }
    const visited = new Set<string>([caller.agent_id]);
    let ancestorId = caller.parent_agent_id;
    while (ancestorId && !visited.has(ancestorId)) {
      visited.add(ancestorId);
      const ancestor =
        context.lifecycleRegistry?.get(ancestorId) ??
        stateMgr.readState(ancestorId);
      if (!ancestor) break;
      if (
        inferRecordRoleOrNull(ancestor) === "orchestrator" &&
        [ancestor.agent_id, ancestor.surface_id, ancestor.surface_uuid].some(
          identity => identity?.toLowerCase() === target.toLowerCase(),
        )
      ) {
        throw new Error(`Worker ${caller.agent_id} must append to collab_path ${caller.collab_path} to reach lead ${ancestor.agent_id}; upward pane delivery is refused.`);
      }
      ancestorId = ancestor.parent_agent_id;
    }
  };

  const resolveModeWorkspace = async (
    surface: string,
    workspace?: string,
  ): Promise<string | undefined> => {
    if (workspace) {
      return workspace;
    }
    try {
      const identified = await client.identify(surface);
      return (
        identified.caller?.workspace_ref ?? identified.focused?.workspace_ref
      );
    } catch {
      return undefined;
    }
  };
  const readSurfaceControlMode = async (
    surface: string,
    workspace?: string,
  ): Promise<{ control: ControlMode; workspace?: string }> => {
    const statusClient = client as CmuxLayerClient & {
      listStatus?: (opts?: { workspace?: string }) => Promise<unknown>;
    };
    if (typeof statusClient.listStatus !== "function") {
      return { control: "autonomous", workspace };
    }
    const modeWorkspace = await resolveModeWorkspace(surface, workspace);
    if (!modeWorkspace) {
      return { control: "autonomous" };
    }
    try {
      const entries = await statusClient.listStatus({
        workspace: modeWorkspace,
      });
      return {
        control: controlModeFromStatusEntries(entries),
        workspace: modeWorkspace,
      };
    } catch {
      return { control: "autonomous", workspace: modeWorkspace };
    }
  };
  const readWorkspaceControlMode = async (
    workspace?: string,
  ): Promise<{ control: ControlMode; workspace?: string }> => {
    const statusClient = client as CmuxLayerClient & {
      listStatus?: (opts?: { workspace?: string }) => Promise<unknown>;
    };
    if (!workspace || typeof statusClient.listStatus !== "function") {
      return { control: "autonomous", workspace };
    }
    try {
      const entries = await statusClient.listStatus({ workspace });
      return {
        control: controlModeFromStatusEntries(entries),
        workspace,
      };
    } catch {
      return { control: "autonomous", workspace };
    }
  };
  const assertSurfaceMutationAllowed = async (
    toolName: string,
    surface: string,
    workspace?: string,
  ): Promise<void> => {
    const mode = await readSurfaceControlMode(surface, workspace);
    try {
      assertMutationAllowed(toolName, mode.control);
    } catch (error) {
      if (mode.control === "manual") {
        throw new ManualModeMutationError(toolName, surface, mode.workspace);
      }
      throw error;
    }
  };
  const assertWorkspaceMutationAllowed = async (
    toolName: string,
    workspace?: string,
  ): Promise<void> => {
    const mode = await readWorkspaceControlMode(workspace);
    try {
      assertMutationAllowed(toolName, mode.control);
    } catch (error) {
      if (mode.control === "manual") {
        throw new ManualModeMutationError(toolName, undefined, mode.workspace);
      }
      throw error;
    }
  };

  const monitorRegistryOptions = (): MonitorRegistryOptions => ({
    ...(opts?.monitorRegistryPath
      ? { registryPath: opts.monitorRegistryPath }
      : {}),
    ...(opts?.monitorRegistryNow ? { now: opts.monitorRegistryNow } : {}),
  });

  const server = new McpServer({
    name: "cmuxlayer",
    version: RUNNING_VERSION,
  });
  const successfulDispatchRpcMethod = (
    method: DeliveryRpcMethod,
    cliFallbackCountBeforeDispatch: number,
  ): DeliveryRpcMethod | null =>
    currentCliFallbackCount() === cliFallbackCountBeforeDispatch &&
    getTransportHealth(client)?.mode === "socket"
      ? method
      : null;
  const { toolHandlersByName, registerPaletteExpansion } =
    installToolRegistration(server, {
      client,
      palette: createDefaultToolPalette(
        opts?.defaultPalette ?? process.env[CMUXLAYER_DEFAULT_PALETTE_ENV],
      ),
      exposeInternalToolsForTests:
        opts?.exposeInternalToolsForTests ?? process.env.VITEST === "true",
      resolveCallerAgentId: () => resolveCurrentCallerAgent()?.agent_id ?? null,
    });
  // AIDEV-NOTE: handlers leaving this closure take their dependencies from
  // here (CX-3 S6+); the lifecycle block below fills engine and registry.
  const toolDeps: ToolDeps = {
    client,
    stateMgr,
    context,
    toolHandlersByName,
    engine: null,
    registry: null,
  };
  bindToolDeps(server, toolDeps);
  if (ownsContext) {
    const close = server.close.bind(server);
    server.close = async (): Promise<void> => {
      try {
        await close();
      } finally {
        context.dispose();
      }
    };
  }

  // CX-3b S9: the delivery engine (chunked send, submit verification, draft
  // ownership, surface-write locks, boot-prompt and background delivery) lives
  // in src/delivery/engine.ts; these are its bindings, names unchanged.
  const {
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
  } = createDeliveryEngine({
    context,
    client,
    inboxOpts,
    resolveCurrentCallerAgent,
    assertSurfaceMutationAllowed,
    successfulDispatchRpcMethod,
    // Forward, don't capture: the agent lifecycle reassigns this `let` later.
    lifecycleSeatManifestPublisher: (input) =>
      lifecycleSeatManifestPublisher(input),
  });

  const collectServerRoleSurfaceIds = (
    liveSurfaceIds?: ReadonlySet<string>,
    workspace?: string,
    observation?: SurfaceBindingObservation,
  ) => {
    const roleRecords = context.lifecycleRegistry?.list() ?? [];
    const observedRoleRecords = observation
      ? roleRecords.flatMap((record) => {
          const surfaceRef = resolveObservedAgentSurfaceRef(
            record,
            observation,
          );
          const observedUuid = surfaceRef
            ? observation.surfaceUuidByRef.get(surfaceRef)
            : null;
          return surfaceRef &&
            context.lifecycleRegistry?.canUseObservedBinding(
              record,
              observedUuid,
            )
            ? [{ ...record, surface_id: surfaceRef }]
            : [];
        })
      : roleRecords;
    const ids = collectRoleSurfaceIds(observedRoleRecords);
    if (liveSurfaceIds) {
      for (const role of ["orchestrator", "worker"] as const) {
        for (const surfaceId of ids[role]) {
          if (!liveSurfaceIds.has(surfaceId)) {
            ids[role].delete(surfaceId);
          }
        }
      }
    }
    const movedOverrides: Array<{
      oldRef: string;
      newRef: string;
      override: {
        role: AgentRole;
        workspace: string | null;
        surfaceUuid: string | null;
      };
    }> = [];
    for (const [surfaceId, override] of roleSurfaceOverrides) {
      if (observation) {
        const observedRef = resolveObservedAgentSurfaceRef(
          {
            surface_id: surfaceId,
            surface_uuid: override.surfaceUuid,
          },
          observation,
        );
        if (!observedRef) {
          if (
            workspace &&
            override.workspace === workspace &&
            (observation.coverage === "uuid" || observation.coverage === "ref")
          ) {
            roleSurfaceOverrides.delete(surfaceId);
          }
          continue;
        }
        ids[override.role].add(observedRef);
        if (observedRef !== surfaceId) {
          movedOverrides.push({
            oldRef: surfaceId,
            newRef: observedRef,
            override,
          });
        }
        continue;
      }
      if (liveSurfaceIds && !liveSurfaceIds.has(surfaceId)) {
        if (workspace && override.workspace === workspace) {
          roleSurfaceOverrides.delete(surfaceId);
        }
        continue;
      }
      ids[override.role].add(surfaceId);
    }
    for (const { oldRef, newRef, override } of movedOverrides) {
      roleSurfaceOverrides.delete(oldRef);
      roleSurfaceOverrides.set(newRef, override);
    }
    return ids;
  };

  const resolveWorkspaceForRepo = async (
    repo: string | null | undefined,
  ): Promise<string | undefined> => {
    return resolveWorkspaceRefForRepo(repo, listAllWorkspaces);
  };

  const worktreeArgSchema = z.union([
    z.boolean(),
    z.string(),
    z.object({
      create: z.boolean().optional(),
      reuse: z.boolean().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      branch: z.string().optional(),
      base: z.string().optional(),
    }),
  ]);

  const mcpProfileSchema = z.union([
    z.enum(["inherit", "sterile", "skill_eval"]),
    z.object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    }),
  ]);

  // Env vars the calling agent's harness sets in this MCP child's environment.
  // First non-empty one is the best available caller identity for a close/kill.
  const CLOSE_CALLER_ENV_KEYS = [
    "CMUX_TAB_ID",
    "CMUX_WORKSPACE_ID",
    "CMUX_SOCKET_PATH",
  ] as const;

  /**
   * Best available identity of whoever drove a close/kill. Prefers a real
   * env-derived id (`CMUX_TAB_ID=...`); falls back to `mcp:<toolName>` for a
   * tool call with no resolvable id. Never fabricates an id.
   */
  const resolveCloseCaller = (toolName: string): string => {
    for (const key of CLOSE_CALLER_ENV_KEYS) {
      const value = process.env[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return `${key}=${value.trim()}`;
      }
    }
    return `mcp:${toolName}`;
  };

  const appendCloseEvent = (
    event: Omit<CloseTelemetryEvent, "ts" | "event_type">,
  ) => {
    eventLog.appendClose({
      ts: new Date().toISOString(),
      event_type: "close",
      ...event,
    });
  };

  const describeLifecycleStart = (): LifecycleStartHealth => {
    const settled =
      context.lifecycleStartPromise === null ||
      context.lifecycleStartSettledAtMs !== null;
    return {
      started: context.lifecycleStarted,
      settled,
      waiting_for_ms:
        settled || context.lifecycleStartStartedAtMs === null
          ? null
          : Date.now() - context.lifecycleStartStartedAtMs,
      timeout_ms: resolveLifecycleStartTimeoutMs(),
      error: context.lifecycleStartError?.message ?? null,
      timeouts: context.lifecycleStartTimeouts,
      last_timeout_at: context.lifecycleStartLastTimeoutAt,
    };
  };

  const appendControlHealthSnapshot = async (): Promise<ControlHealth> => {
    const rawHealth = controlHealthCollector
      ? await controlHealthCollector()
      : await collectControlHealth({
          client,
          lifecycleLock: context.lifecycleLockStateProvider?.() ?? null,
          lifecycleStart: describeLifecycleStart(),
        });
    const knownSurfaceIds = [
      ...stateMgr.listStates().map((record) => record.surface_id),
      ...roleSurfaceOverrides.keys(),
      ...latestDeliveryBySurface.keys(),
      ...activeSurfaceWrites.keys(),
      ...surfaceWriteLivenessCandidates,
    ];
    // #529: a dead daemon and a wedged lifecycle lock used to look identical
    // to a healthy control plane. Publish both, always.
    const healthWithSelfHeal: ControlHealth = {
      ...rawHealth,
      daemon_lifecycle: {
        ...rawHealth.daemon_lifecycle,
        lifecycle_lock: context.lifecycleLockStateProvider?.() ?? null,
        lifecycle_start: describeLifecycleStart(),
      },
      self_heal: collectSelfHealHealth({
        surfaceWriteLiveness,
        surfaceIds: knownSurfaceIds,
        panePtyDeadSince: surfacePtyDeadSince,
        monitorRegistry: opts?.monitorRegistryPath
          ? monitorRegistryOptions()
          : undefined,
      }),
    };
    const health =
      controlHealthWarnings.length > 0
        ? {
            ...healthWithSelfHeal,
            warnings: [
              ...healthWithSelfHeal.warnings,
              ...controlHealthWarnings,
            ],
          }
        : healthWithSelfHeal;
    eventLog.appendControlHealth({
      ts: health.generated_at,
      event_type: "control_health",
      selected_socket_path:
        health.selected_transport.current_socket_path ?? null,
      production_socket_path: health.cmux_instances.production.socket_path,
      nightly_socket_path: health.cmux_instances.nightly.socket_path,
      cmux_binary: health.current_process.cmux_resolution[0]?.path ?? null,
      warnings: health.warnings,
      snapshot: health,
    });
    return health;
  };

  if (
    context.controlHealthIntervalMs > 0 &&
    context.controlHealthTimer === null
  ) {
    context.controlHealthTimer = setInterval(() => {
      appendControlHealthSnapshot().catch((error) => {
        console.error(
          "[cmuxlayer] control_health periodic sample failed:",
          error,
        );
      });
    }, context.controlHealthIntervalMs);
    context.controlHealthTimer.unref?.();
  }

  // ── Auto-focus discipline for split/pane creation ──────────────────
  // cmux attaches a new split to the *currently focused* workspace. When a
  // spawn targets a different workspace, we must focus it BEFORE creating the
  // pane (otherwise the split lands in the wrong workspace — happy-camper's
  // split failed for exactly this reason), then restore the prior focus AFTER
  // the new terminal is fully rendered — but ONLY when a jump was needed.

  const envWorkspaceMatches = (
    workspace: CmuxWorkspace,
    candidate: string,
  ): boolean => {
    const normalized = candidate.trim();
    if (!normalized) return false;
    const aliasNormalized = normalizeWorkspaceRefAlias(normalized);
    return (
      workspace.ref === normalized ||
      workspace.id === normalized ||
      workspace.ref === aliasNormalized ||
      workspace.id === aliasNormalized ||
      workspace.ref === `workspace:${normalized}` ||
      workspace.id === `workspace:${normalized}`
    );
  };

  const canonicalWorkspaceRef = async (
    candidate?: string,
  ): Promise<string | undefined> => {
    if (!candidate) return undefined;
    try {
      const { workspaces } = await listAllWorkspaces();
      const normalized = candidate.trim();
      return (
        workspaces.find(
          (workspace) =>
            envWorkspaceMatches(workspace, candidate) ||
            workspace.title === normalized,
        )?.ref ?? candidate
      );
    } catch {
      return candidate;
    }
  };

  const callerWorkspaceStrict = async (): Promise<string | undefined> => {
    const callerContext = currentCallerContext();
    const workspaceCandidate = callerContext?.workspaceId?.trim();
    const candidates = [workspaceCandidate, callerContext?.tabId].filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    try {
      const { workspaces } = await listAllWorkspaces();
      for (const candidate of candidates) {
        const match = workspaces.find((workspace) =>
          envWorkspaceMatches(workspace, candidate),
        );
        if (match) return match.ref;
      }
    } catch {
      // A request-scoped workspace ID remains authoritative when enumeration
      // is temporarily unavailable; only daemon env and UI focus are banned.
    }
    return workspaceCandidate
      ? normalizeWorkspaceRefAlias(workspaceCandidate)
      : undefined;
  };

  /**
   * Caller workspace for mutation safety only. In-process runtimes have no
   * transport metadata, so their process-local env can supplement the strict
   * request context without ever influencing spawn placement.
   */
  const currentSafetyCallerWorkspace = async (): Promise<
    string | undefined
  > => {
    const requestWorkspace = await callerWorkspaceStrict();
    if (requestWorkspace) return requestWorkspace;
    const fallbackWorkspace =
      opts?.safetyCallerContextProvider?.()?.workspaceId;
    return fallbackWorkspace
      ? await canonicalWorkspaceRef(fallbackWorkspace)
      : undefined;
  };

  /** Currently-focused workspace ref, or undefined if it can't be read. */
  const currentFocusedWorkspace = async (): Promise<string | undefined> => {
    try {
      const { workspaces } = await listAllWorkspaces();
      const callerContext = currentCallerContext();
      const callerCandidates = [
        callerContext?.workspaceId,
        callerContext?.tabId,
      ].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
      const callerWorkspace = callerCandidates
        .map((candidate) =>
          workspaces.find((workspace) =>
            envWorkspaceMatches(workspace, candidate),
          ),
        )
        .find((workspace) => workspace !== undefined);
      if (callerWorkspace?.window_ref) {
        return workspaces.find(
          (workspace) =>
            workspace.selected &&
            workspace.window_ref === callerWorkspace.window_ref,
        )?.ref;
      }
      const connectorWorkspaces = await client.listWorkspaces();
      return connectorWorkspaces.workspaces.find(
        (workspace) => workspace.selected,
      )?.ref;
    } catch {
      return undefined;
    }
  };

  type FocusTarget = {
    workspace: string;
    surface?: string;
  };

  type FocusRestoreLease = {
    prior: FocusTarget;
    expected: FocusTarget;
  };

  /** Currently-focused workspace and surface, with workspace-only fallback. */
  const currentFocusTarget = async (): Promise<FocusTarget | null> => {
    try {
      const focused = (await client.identify()).focused;
      if (focused?.workspace_ref) {
        return {
          workspace: focused.workspace_ref,
          ...(focused.surface_ref ? { surface: focused.surface_ref } : {}),
        };
      }
    } catch {
      // Older/degraded transports may not expose global focus via identify.
    }
    const workspace = await currentFocusedWorkspace();
    return workspace ? { workspace } : null;
  };

  class PlacementWorkspaceError extends Error {
    readonly code = PLACEMENT_WORKSPACE_UNRESOLVED;

    constructor(message: string) {
      super(message);
      this.name = "PlacementWorkspaceError";
    }
  }

  const assertWorkspaceBelongsToRepo = async (
    workspaceRef: string,
    repo: string | null | undefined,
  ): Promise<void> => {
    if (!repo) return;
    let workspace: CmuxWorkspace | undefined;
    try {
      const listed = await listAllWorkspaces();
      workspace = listed.workspaces.find((candidate) =>
        envWorkspaceMatches(candidate, workspaceRef),
      );
    } catch (error) {
      throw new PlacementWorkspaceError(
        `Cannot verify whether workspace ${workspaceRef} belongs to repo ${repo}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const cwd = workspace?.current_directory?.trim();
    if (!cwd || workspaceDirectoryRepoMatchScore(repo, cwd) > 0) return;
    const title = workspace?.title?.trim();
    const titleCandidates = [inferRepoFromLauncherTitle(title), title].filter(
      (candidate, index, all): candidate is string =>
        Boolean(candidate) && all.indexOf(candidate) === index,
    );
    const identifiedRepo = titleCandidates.find(
      (candidate) => workspaceDirectoryRepoMatchScore(candidate, cwd) > 0,
    );
    if (!identifiedRepo || reposEquivalent(identifiedRepo, repo)) return;
    throw new PlacementWorkspaceError(
      `Refused placement in ${workspace?.ref ?? workspaceRef}: workspace directory ${cwd} does not belong to repo ${repo}`,
    );
  };

  const resolvePlacementWorkspace = async (opts: {
    explicitWorkspace?: string;
    callerWorkspace?: string;
    repo?: string | null;
  }): Promise<{ workspace?: string; warnings: string[] }> => {
    const explicitWorkspace = opts.explicitWorkspace
      ? await canonicalWorkspaceRef(opts.explicitWorkspace)
      : undefined;
    if (explicitWorkspace) {
      await assertWorkspaceBelongsToRepo(explicitWorkspace, opts.repo);
      return { workspace: explicitWorkspace, warnings: [] };
    }

    const callerWorkspace =
      opts.callerWorkspace ?? (await callerWorkspaceStrict());
    if (callerWorkspace) {
      await assertWorkspaceBelongsToRepo(callerWorkspace, opts.repo);
      return { workspace: callerWorkspace, warnings: [] };
    }

    const repoWorkspace = await resolveWorkspaceForRepo(opts.repo);
    if (repoWorkspace) return { workspace: repoWorkspace, warnings: [] };

    throw new PlacementWorkspaceError(
      "Spawn placement requires an explicit workspace, per-request caller workspace, or matching repo workspace; focused workspace and shared-daemon environment fallbacks are forbidden",
    );
  };

  /** Capture origin focus, select the placement workspace, and record the
   * exact focus state caused by that selection. The expected state is refreshed
   * immediately after pane creation so restoration never depends on whether a
   * cmux transport focuses newly-created surfaces by default.
   */
  const focusTargetBeforeSplit = async (
    targetWorkspace: string | undefined,
    restore = true,
    capturedPrior?: FocusTarget | null,
  ): Promise<FocusRestoreLease | null> => {
    if (!targetWorkspace) return null;
    const prior =
      capturedPrior === undefined ? await currentFocusTarget() : capturedPrior;
    const placementFocus =
      capturedPrior === undefined ? prior : await currentFocusTarget();
    if (!placementFocus || placementFocus.workspace !== targetWorkspace) {
      await client.selectWorkspace(targetWorkspace);
    }
    if (!prior || !restore) return null;
    const expected = await currentFocusTarget();
    // Without an exact expected surface, a later same-workspace user move
    // cannot be distinguished from cmuxlayer's own placement focus.
    if (!expected?.surface) return null;
    return { prior, expected };
  };

  /** Refresh the lease immediately after the surface mutation. */
  const capturePostCreationFocus = async (
    lease: FocusRestoreLease | null,
    created?: { surface: string; workspace?: string },
  ): Promise<FocusRestoreLease | null> => {
    if (!lease) return null;
    if (created?.surface) {
      return {
        ...lease,
        expected: {
          workspace: created.workspace ?? lease.expected.workspace,
          surface: created.surface,
        },
      };
    }
    const expected = await currentFocusTarget();
    return expected?.surface ? { ...lease, expected } : lease;
  };

  const sameExactFocus = (left: FocusTarget, right: FocusTarget): boolean =>
    Boolean(
      left.surface &&
      right.surface &&
      left.workspace === right.workspace &&
      left.surface === right.surface,
    );

  /**
   * Restore the prior surface AFTER the new terminal is fully rendered. Waits
   * for shell readiness so focus is not restored mid-render. Restores focus
   * even if readiness times out (never strand focus on the spawned pane).
   */
  const restoreFocusAfterRender = async (
    lease: FocusRestoreLease | null,
    surface: string | undefined,
    workspace: string | undefined,
    opts?: { waitForReady?: boolean },
  ): Promise<string | null> => {
    if (!lease) return null;
    if (surface && opts?.waitForReady !== false) {
      try {
        await waitForLaunchShellReady({ surface, workspace });
      } catch {
        // Readiness timed out — restore focus anyway rather than strand it.
      }
    }
    const current = await currentFocusTarget();
    // The user may deliberately move while a pane boots. Restore only while
    // focus still exactly matches the post-creation state cmuxlayer caused.
    if (!current || !sameExactFocus(current, lease.expected)) return null;
    try {
      if (lease.prior.surface) {
        await client.focusSurface(lease.prior.surface, {
          workspace: lease.prior.workspace,
        });
        return null;
      }
      await client.selectWorkspace(lease.prior.workspace);
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return `Focus restore failed: ${message}`;
    }
  };

  const findSurfaceByRef = async (
    surfaceRef: string,
    workspace?: string,
    opts?: { throwOnError?: boolean },
  ): Promise<CmuxSurface | null> => {
    try {
      const workspaceRefs = workspace
        ? [workspace]
        : (await listAllWorkspaces()).workspaces.map((ws) => ws.ref);

      for (const workspaceRef of workspaceRefs) {
        const panes = await client.listPanes({ workspace: workspaceRef });
        for (const pane of panes.panes) {
          const group = await client.listPaneSurfaces({
            workspace: workspaceRef,
            pane: pane.ref,
          });
          const surface = group.surfaces.find(
            (entry) => entry.ref === surfaceRef,
          );
          if (surface) {
            return surface;
          }
        }
      }
    } catch (error) {
      if (opts?.throwOnError) throw error;
      return null;
    }

    return null;
  };

  const surfaceObserverEpochProvider =
    (): SurfaceObserverIdProvider | undefined => () =>
      context.surfaceObserverEpoch;

  const collectSurfaceTopology = async (workspace?: string) =>
    collectCmuxSurfaceTopology(
      client,
      workspace,
      surfaceObserverEpochProvider(),
    );

  const resetCapturedSurfaceIdentitiesForObserver = (): string | null => {
    const observerEpoch = context.surfaceObserverEpoch;
    if (context.capturedSurfaceObserverEpoch !== observerEpoch) {
      context.capturedSurfaceUuidByRef.clear();
      context.ambiguousCapturedSurfaceRefs.clear();
      context.capturedSurfaceObserverEpoch = observerEpoch;
    }
    return observerEpoch;
  };

  const captureSurfaceIdentities = (
    surfaceIdByRef: ReadonlyMap<string, string>,
    observedEpoch: string | null,
  ): void => {
    const currentEpoch = context.surfaceObserverEpoch;
    if (!observedEpoch || currentEpoch !== observedEpoch) return;
    if (context.capturedSurfaceObserverEpoch !== observedEpoch) {
      context.capturedSurfaceUuidByRef.clear();
      context.ambiguousCapturedSurfaceRefs.clear();
      context.capturedSurfaceObserverEpoch = observedEpoch;
    }
    for (const [surfaceRef, surfaceUuid] of surfaceIdByRef) {
      const capturedUuid = context.capturedSurfaceUuidByRef.get(surfaceRef);
      if (!capturedUuid) {
        // A ref is a caller-visible handle for the first UUID observed there.
        // Never overwrite it with a later occupant after refs renumber/recycle.
        context.capturedSurfaceUuidByRef.set(surfaceRef, surfaceUuid);
      } else if (capturedUuid.toLowerCase() !== surfaceUuid.toLowerCase()) {
        context.ambiguousCapturedSurfaceRefs.add(surfaceRef);
      }
    }
  };

  const findSurfaceRefByUuid = (
    topology: SurfaceTopologySnapshot,
    surfaceUuid: string,
  ): string | null => {
    const uuidKey = surfaceUuid.trim().toLowerCase();
    return (
      [...topology.surfaceRefById].find(
        ([observedUuid]) => observedUuid.trim().toLowerCase() === uuidKey,
      )?.[1] ?? null
    );
  };

  type RawSurfaceMutationRoute = {
    surface: string;
    workspace?: string;
    /** Live cmux tab title for this surface when topology knows it. */
    title: string | null;
    stableSurfaceIdentity: string | null;
    remapped_from?: string;
    remapped_to?: string;
    assertCurrent: () => Promise<void>;
  };

  const remapFields = (
    route: RawSurfaceMutationRoute,
  ): Pick<RawSurfaceMutationRoute, "remapped_from" | "remapped_to"> =>
    route.remapped_from && route.remapped_to
      ? {
          remapped_from: route.remapped_from,
          remapped_to: route.remapped_to,
        }
      : {};

  /**
   * Bind a caller-visible mutable ref to a stable UUID before terminal I/O.
   * Old/ref-only cmux clients retain compatibility, but once UUID evidence has
   * been captured the route always fails closed if that UUID is absent.
   */
  const agentScopedSurfaceClose = Symbol("agent-scoped-surface-close");
  const resolveRawSurfaceMutationRoute = async (
    requestedSurface: string,
    requestedWorkspace: string | undefined,
    operation: string,
    trustedAgentScopedClose = false,
  ): Promise<RawSurfaceMutationRoute> => {
    const explicitWorkspace = requestedWorkspace
      ? normalizeWorkspaceRefAlias(requestedWorkspace)
      : undefined;
    const assertExplicitWorkspace = (
      observedWorkspace: string | undefined,
    ): void => {
      if (
        explicitWorkspace &&
        normalizeWorkspaceRefAlias(observedWorkspace ?? "") !==
          explicitWorkspace
      ) {
        throw new Error(
          `Stable surface binding for ${requestedSurface} belongs to ` +
            `${observedWorkspace ?? "an unknown workspace"}, not the caller's ` +
            `explicit workspace ${explicitWorkspace}; refusing ${operation}.`,
        );
      }
    };
    resetCapturedSurfaceIdentitiesForObserver();
    const capturedUuid = context.capturedSurfaceUuidByRef.get(requestedSurface);
    const registryUuids = new Set(
      stateMgr
        .listStates()
        .filter((record) => record.surface_id === requestedSurface)
        .map((record) => record.surface_uuid?.trim())
        .filter((uuid): uuid is string => Boolean(uuid)),
    );
    const registryUuid =
      registryUuids.size === 1 ? [...registryUuids][0] : null;
    const expectedUuid = capturedUuid ?? registryUuid;
    // A failed topology read from a UUID-capable connector is not evidence
    // that an anonymous raw ref is safe to close.
    const refOnlyConnector =
      (client as typeof client & { surfaceIdentityMode?: string })
        .surfaceIdentityMode === "ref_only";
    const topologyObserverEpoch = context.surfaceObserverEpoch;
    // Only the internal agent-scoped delegate has an explicit managed ID.
    // A raw caller cannot borrow a registry record's mutable ref as proof.
    const allowRefOnlyClose = refOnlyConnector ||
      (!topologyObserverEpoch && trustedAgentScopedClose);
    const topology = await collectSurfaceTopology();
    const withSurfaceRemap = (
      route: Omit<RawSurfaceMutationRoute, "remapped_from" | "remapped_to">,
    ): RawSurfaceMutationRoute =>
      route.surface !== requestedSurface
        ? {
            ...route,
            remapped_from: requestedSurface,
            remapped_to: route.surface,
          }
        : route;
    const throwStaleSurfaceRef = (diagnostic?: string): never => {
      const expectedUuidKey = expectedUuid?.trim().toLowerCase() ?? null;
      const owners: AgentRecord[] = [];
      const seen = new Set<string>();
      for (const record of stateMgr.listStates()) {
        const recordUuidKey = record.surface_uuid?.trim().toLowerCase() ?? null;
        const ownsRequestedRef = record.surface_id === requestedSurface;
        const ownsExpectedUuid = Boolean(
          expectedUuidKey && recordUuidKey === expectedUuidKey,
        );
        if (
          (!ownsRequestedRef && !ownsExpectedUuid) ||
          seen.has(record.agent_id)
        ) {
          continue;
        }
        seen.add(record.agent_id);
        owners.push(record);
      }
      const occupancy =
        owners.length === 1
          ? `${requestedSurface} is stale; agent ${owners[0].agent_id} owns this ref but no live route was proven — use agent_id`
          : owners.length > 1
            ? `${requestedSurface} is stale; managed agents recorded on this ref: ${owners
                .map((agent) => agent.agent_id)
                .join(", ")} — use agent_id`
            : `${requestedSurface} is stale; no live managed agent maps this ref`;
      throw new Error(diagnostic ? `${occupancy} (${diagnostic})` : occupancy);
    };
    const refuseUnverifiedClose = (): never => {
      throw new Error(
        `Cannot verify current surface topology for ${requestedSurface}; ` +
          `refusing close_surface. Retry after window/workspace enumeration recovers ` +
          `or address the surface by its stable UUID.`,
      );
    };

    if (topology) {
      const uuidTargetRef = findSurfaceRefByUuid(topology, requestedSurface);
      captureSurfaceIdentities(topology.surfaceIdByRef, topologyObserverEpoch);
      const currentUuidAtRequestedRef =
        topology.surfaceIdByRef.get(requestedSurface) ?? null;
      if (
        (expectedUuid &&
          currentUuidAtRequestedRef &&
          expectedUuid.toLowerCase() !==
            currentUuidAtRequestedRef.toLowerCase()) ||
        context.ambiguousCapturedSurfaceRefs.has(requestedSurface)
      ) {
        throw new Error(
          `Mutable surface ref ${requestedSurface} was observed for multiple stable UUIDs; ` +
            `refusing ${operation}. Re-address by agent_id or stable surface UUID.`,
        );
      }
      const stableUuid =
        expectedUuid ??
        (uuidTargetRef ? requestedSurface : null) ??
        topology.surfaceIdByRef.get(requestedSurface) ??
        null;

      if (stableUuid) {
        const currentRef = findSurfaceRefByUuid(topology, stableUuid);
        if (!currentRef) {
          return throwStaleSurfaceRef(
            `Stable surface UUID ${stableUuid} captured for ${requestedSurface} ` +
              `is no longer live; refusing ${operation} rather than using a recycled ref.`,
          );
        }
        const observedWorkspace = topology.workspaceBySurface.get(currentRef);
        assertExplicitWorkspace(observedWorkspace);
        const workspace = observedWorkspace ?? explicitWorkspace;
        const assertCurrent = async (): Promise<void> => {
          const current = await collectSurfaceTopology();
          const currentRefForUuid = current
            ? findSurfaceRefByUuid(current, stableUuid)
            : null;
          const currentWorkspace = currentRefForUuid
            ? current?.workspaceBySurface.get(currentRefForUuid)
            : null;
          if (!current) {
            // #805: a null re-read (observer unavailable, enumeration failed)
            // is not evidence the UUID moved; say which one happened.
            throw new Error(
              `Could not re-read surface topology before ${operation} on ` +
                `${currentRef} (surface observer unavailable or workspace ` +
                `enumeration failed); refusing terminal mutation. Stable ` +
                `surface UUID ${stableUuid} was not observed to change.`,
            );
          }
          if (
            currentRefForUuid !== currentRef ||
            (currentWorkspace ?? null) !== (workspace ?? null)
          ) {
            throw new Error(
              `Stable surface UUID ${stableUuid} changed or disappeared during ` +
                `${operation}; refusing terminal mutation.`,
            );
          }
        };
        return withSurfaceRemap({
          surface: currentRef,
          workspace,
          title: topology.titleBySurface.get(currentRef) ?? null,
          stableSurfaceIdentity: stableUuid,
          assertCurrent,
        });
      }

      if (topology.complete !== true) {
        if (topology.surfaceIdByRef.size > 0 || topology.surfaceRefById.size > 0) {
          throwStaleSurfaceRef("Fresh topology was incomplete and did not prove a stable UUID");
        }
        if (operation === "close_surface" && !allowRefOnlyClose) {
          refuseUnverifiedClose();
        }
        // Legacy/mock connectors expose no stable identity. Retain their
        // ref-only I/O fallback; a partial UUID-backed observation never gets it.
        return {
          surface: requestedSurface,
          workspace: explicitWorkspace,
          title: null,
          stableSurfaceIdentity: null,
          assertCurrent: async () => {},
        };
      }

      if (
        topology.surfaceIdByRef.size > 0 ||
        topology.surfaceRefById.size > 0
      ) {
        throwStaleSurfaceRef();
      }

      if (!topology.workspaceBySurface.has(requestedSurface)) {
        throwStaleSurfaceRef();
      }

      const workspace =
        topology.workspaceBySurface.get(requestedSurface) ?? explicitWorkspace;
      assertExplicitWorkspace(workspace);
      return {
        surface: requestedSurface,
        workspace,
        title: topology.titleBySurface.get(requestedSurface) ?? null,
        stableSurfaceIdentity: null,
        assertCurrent: async () => {
          const current = await collectSurfaceTopology();
          if (
            current?.complete !== true ||
            current.surfaceIdByRef.size !== 0 ||
            !current.workspaceBySurface.has(requestedSurface)
          ) {
            throw new Error(
              `Ref-only surface ${requestedSurface} is no longer uniquely live; ` +
                `refusing ${operation}.`,
            );
          }
        },
      };
    }

    if (expectedUuid) {
      throw new Error(
        `Stable surface UUID ${expectedUuid} captured for ${requestedSurface} ` +
          `could not be resolved in fresh topology; refusing ${operation}.`,
      );
    }

    if (operation === "close_surface" && !allowRefOnlyClose) {
      refuseUnverifiedClose();
    }

    // Compatibility for pre-UUID/mock connectors that cannot produce a
    // complete topology. No stable claim has been made, so preserve ref I/O.
    return {
      surface: requestedSurface,
      workspace: explicitWorkspace,
      title: null,
      stableSurfaceIdentity: null,
      assertCurrent: async () => {},
    };
  };

  const readScreenSnapshotKey = (opts: {
    surface: string;
    workspace?: string;
    lines?: number;
    scrollback?: boolean;
  }): string =>
    JSON.stringify([
      opts.surface,
      opts.workspace ?? null,
      opts.lines ?? null,
      opts.scrollback === true,
    ]);

  const readScreenSnapshot = async (opts: {
    surface: string;
    workspace?: string;
    lines?: number;
    scrollback?: boolean;
  }): Promise<ReadScreenSnapshot> => {
    const key = readScreenSnapshotKey(opts);
    const existing = context.readScreenInflight.get(key);
    if (existing) {
      return existing;
    }

    const snapshot = (async () => {
      const result = await client.readScreen(opts.surface, {
        workspace: opts.workspace,
        lines: opts.lines,
        scrollback: opts.scrollback,
      });
      const topology = await collectSurfaceTopology(opts.workspace);
      observeDraftOwnership(opts.surface, opts.workspace ?? topology?.workspaceBySurface.get(opts.surface), typeof result === "string" ? result : result.text ?? "",
        topology?.surfaceIdByRef.get(opts.surface) ?? observedSurfaceUuid(opts.surface));
      return { result, topology };
    })();
    context.readScreenInflight.set(key, snapshot);
    try {
      return await snapshot;
    } finally {
      if (context.readScreenInflight.get(key) === snapshot) {
        context.readScreenInflight.delete(key);
      }
    }
  };

  const resolveAuthorizedAgentSurfaceBinding = (
    agent: AgentRecord,
    topology: SurfaceTopologySnapshot | null,
  ) => {
    const binding = resolveAgentSurfaceBinding(agent, topology);
    if (!binding) return null;

    const observedUuid =
      topology?.surfaceIdByRef.get(binding.surfaceRef) ?? null;
    return context.lifecycleRegistry?.canUseObservedBinding(
      agent,
      observedUuid,
    ) === true
      ? binding
      : null;
  };

  const resolveCodexAgentForSurface = (
    surfaceRef: string,
    topology: SurfaceTopologySnapshot | null,
  ): AgentRecord | null => {
    const candidates = stateMgr
      .listStates()
      .filter(
        (agent) =>
          agent.cli === "codex" &&
          Boolean(agent.surface_uuid?.trim()) &&
          Boolean(agent.cli_session_path),
      )
      .sort((a, b) => {
        if (b.version !== a.version) return b.version - a.version;
        return (
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      });

    for (const candidate of candidates) {
      const binding = resolveAuthorizedAgentSurfaceBinding(candidate, topology);
      if (binding?.surfaceRef === surfaceRef) return candidate;
    }
    return null;
  };

  const readCodexRolloutFill = async (
    agent: AgentRecord | null,
  ): Promise<CodexRolloutFill | null> => {
    const path =
      agent?.cli === "codex" && Boolean(agent.surface_uuid?.trim())
        ? agent.cli_session_path
        : null;
    if (!path) return null;
    try {
      return await context.codexRolloutFillProvider.get(path);
    } catch {
      return null;
    }
  };

  const sameCodexSessionBinding = (
    before: AgentRecord | null,
    after: AgentRecord | null,
  ): AgentRecord | null => {
    if (!before || !after) return null;
    if (before.cli !== "codex" || after.cli !== "codex") return null;
    if (before.agent_id !== after.agent_id) return null;
    if (
      before.surface_uuid?.trim().toLowerCase() !==
      after.surface_uuid?.trim().toLowerCase()
    ) {
      return null;
    }
    return before.cli_session_path === after.cli_session_path ? after : null;
  };

  const validateCodexRolloutFill = async (
    agent: AgentRecord | null,
    expectedSurfaceRef: string | null,
    fill: CodexRolloutFill | null,
  ): Promise<CodexRolloutFill | null> => {
    if (!agent || !expectedSurfaceRef || !fill) return null;
    const current = stateMgr.readState(agent.agent_id);
    if (!sameCodexSessionBinding(agent, current)) return null;
    const topology = await collectSurfaceTopology().catch(() => null);
    const binding = current
      ? resolveAuthorizedAgentSurfaceBinding(current, topology)
      : null;
    return binding?.surfaceRef === expectedSurfaceRef ? fill : null;
  };

  const applyCodexRolloutFill = (
    parsed: ParsedScreenResult,
    fill: CodexRolloutFill | null,
  ): ParsedScreenResult =>
    fill
      ? {
          ...parsed,
          token_count: fill.token_count,
          context_window: fill.context_window,
          context_pct: fill.context_pct,
        }
      : parsed;

  /**
   * AIDEV-NOTE (T1b/#488): ONE screen observation for a response that emits
   * `closure` and `state`/health together. `list_agents` threads its own scan;
   * `get_agent_state` and `wait_for` have no scan, so they read the surface ONCE
   * here and hand the same observation to both consumers -- the health block via
   * the screen_* overrides it already accepts (which stop it re-reading), and
   * closure via `assessHarvestability(agent, { live })`. Without this, closure
   * fell back to `cachedScan()`, null past 2000ms, and the same response could
   * say `working` and `artifact_missing` at once. Read count is unchanged: the
   * read moves out of the health call, it is not added to it.
   */
  const observeAgentOnce = async (
    agent: AgentRecord,
    topology: SurfaceTopologySnapshot | null,
  ): Promise<{
    screenOverrides: AgentHealthInputOverrides;
    live: LiveAgentState;
  }> => {
    const binding = resolveAuthorizedAgentSurfaceBinding(agent, topology);
    if (!binding) {
      // No authorized surface is no evidence -- the same answer the health path
      // reaches on its own, and `resolveLiveAgentState` records it as
      // `source: "registry"` rather than passing the record off as observed.
      return { screenOverrides: {}, live: resolveLiveAgentState(agent, null) };
    }
    const parsed = await readParsedSurface(
      binding.surfaceRef,
      binding.workspaceId ?? undefined,
      { agent },
    );
    return {
      screenOverrides: {
        screen_status: parsed?.parsed.status ?? null,
        screen_agent_type: parsed?.parsed.agent_type ?? null,
        screen_control_state: parsed?.parsed.control_state ?? null,
        screen_actions: parsed?.parsed.actions ?? null,
        screen_errors: parsed?.parsed.errors ?? null,
      },
      live: resolveLiveAgentState(
        agent,
        parsed
          ? {
              status: parsed.parsed.status,
              agent_type: parsed.parsed.agent_type,
              control_state: parsed.parsed.control_state,
              errors: parsed.parsed.errors,
            }
          : null,
      ),
    };
  };

  const evaluateServerAgentHealth = async (
    agent: AgentRecord,
    overrides?: AgentHealthInputOverrides,
    topologyOverride?: SurfaceTopologySnapshot | null,
  ) => {
    const parent = agent.parent_agent_id
      ? (context.lifecycleRegistry?.get(agent.parent_agent_id) ??
        stateMgr.readState(agent.parent_agent_id))
      : null;
    const parentRole = parent ? inferRecordRoleOrNull(parent) : null;
    const topology =
      topologyOverride === undefined
        ? await collectSurfaceTopology()
        : topologyOverride;
    const binding = resolveAuthorizedAgentSurfaceBinding(agent, topology);
    let parsedSurface: Awaited<ReturnType<typeof readParsedSurface>> = null;
    if (
      binding &&
      (overrides?.screen_status === undefined ||
        overrides?.screen_agent_type === undefined ||
        overrides?.screen_control_state === undefined ||
        overrides?.screen_actions === undefined ||
        overrides?.screen_errors === undefined)
    ) {
      parsedSurface = await readParsedSurface(
        binding.surfaceRef,
        binding.workspaceId ?? undefined,
        { agent },
      );
    }
    const surfaceOverrides = healthTopologyOverrides(
      agent,
      binding ? topology : null,
    );
    const safeSurfaceOverrides: AgentHealthInputOverrides = {
      ...surfaceOverrides,
      screen_status:
        overrides?.screen_status !== undefined
          ? overrides.screen_status
          : binding
            ? (parsedSurface?.parsed.status ?? null)
            : null,
      screen_agent_type:
        overrides?.screen_agent_type !== undefined
          ? overrides.screen_agent_type
          : binding
            ? (parsedSurface?.parsed.agent_type ?? null)
            : null,
      screen_control_state:
        overrides?.screen_control_state !== undefined
          ? overrides.screen_control_state
          : binding
            ? (parsedSurface?.parsed.control_state ?? null)
            : null,
      screen_actions:
        overrides?.screen_actions !== undefined
          ? overrides.screen_actions
          : binding
            ? (parsedSurface?.parsed.actions ?? null)
            : null,
      screen_errors:
        overrides?.screen_errors !== undefined
          ? overrides.screen_errors
          : binding
            ? (parsedSurface?.parsed.errors ?? null)
            : null,
      surface_write_liveness: binding
        ? surfaceWriteLiveness.observe(
            binding.surfaceRef,
            agent.surface_uuid,
            agent.surface_observer_id,
          )
        : null,
    };
    const input = await buildAgentHealthInput(
      agent,
      {
        inboxOpts,
        monitorMaxAgeMs: INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS,
        dispatchAckTimeoutMs: AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
        assessHarvestability: (target) =>
          lifecycleHealthEngine?.assessHarvestability(target),
        readParsedSurface: async (target) => {
          const targetBinding = resolveAuthorizedAgentSurfaceBinding(
            target,
            topology,
          );
          if (!targetBinding) return null;
          const observation =
            target.agent_id === agent.agent_id && parsedSurface
              ? parsedSurface
              : await readParsedSurface(
                  targetBinding.surfaceRef,
                  targetBinding.workspaceId ?? undefined,
                  { agent: target },
                );
          return observation?.parsed ?? null;
        },
        resolveCollapsedMonitors: (ownerSeats) => {
          if (!opts?.monitorRegistryPath) return [];
          const owners = new Set(ownerSeats);
          return readMonitorRegistry(monitorRegistryOptions())
            .monitors.filter(
              (monitor) =>
                monitor.state === "collapsed" && owners.has(monitor.owner_seat),
            )
            .map((monitor) => ({
              monitor_id: monitor.monitor_id,
              reason: monitor.collapsed_reason ?? "unknown",
            }));
        },
      },
      {
        ...overrides,
        parent_role: overrides?.parent_role ?? parentRole,
        ...safeSurfaceOverrides,
      },
    );
    const health = evaluateAgentHealth(agent, input);
    return {
      ...health,
      ...(parsedSurface
        ? {
            screen_observation: {
              observed_at_ms: Date.now(),
              status: parsedSurface.parsed.status,
              agent_type: parsedSurface.parsed.agent_type,
              control_state: parsedSurface.parsed.control_state,
              model: parsedSurface.parsed.model,
            },
          }
        : {}),
    };
  };

  const spawnDeliveryWorkspace = (
    result: { workspace_id?: string },
    fallback?: string,
  ): string | undefined => result.workspace_id || fallback;

  const collectDeliveryEvidence = async (agentId: string) => {
    const agent = context.lifecycleSweepEngine?.getAgentState(agentId) ?? null;
    if (!agent) {
      return {
        registry_state: null,
        screen: null,
        state_conflict: false,
        health: undefined,
      };
    }
    const topology = await collectSurfaceTopology();
    const binding = resolveAuthorizedAgentSurfaceBinding(agent, topology);
    const screen = binding
      ? await readParsedSurface(
          binding.surfaceRef,
          binding.workspaceId ?? undefined,
          { agent },
        )
      : null;
    const health = await evaluateServerAgentHealth(
      agent,
      {
        screen_status: screen?.parsed.status ?? null,
        screen_actions: screen?.parsed.actions ?? null,
      },
      topology,
    );
    return {
      registry_state: agent.state,
      screen: screen
        ? {
            status: screen.parsed.status,
            agent_type: screen.parsed.agent_type,
            model: screen.parsed.model,
            done_signal: screen.parsed.done_signal,
            actions: screen.parsed.actions ?? [],
          }
        : null,
      state_conflict: health.issue_codes.includes(
        "registry_screen_disagreement",
      ),
      health,
    };
  };

  // 1. list_surfaces
  server.tool(
    "list_surfaces",
    "List workspace, pane, and surface topology. Condensed by default; verbose=true adds raw cmux fields.",
    {
      workspace: z.string().optional().describe("Filter by workspace ref"),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Return all raw cmux fields instead of the condensed default. This materially increases token usage and is rarely needed; use it only when a specific raw field is required.",
        ),
      include_screen_preview: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include screen content preview"),
      preview_lines: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(8)
        .describe("Number of preview lines"),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        const listingObserverEpoch = context.surfaceObserverEpoch;
        const workspaces = await listAllWorkspaces();
        const targetWorkspaceRefs = args.workspace
          ? [args.workspace]
          : workspaces.workspaces.map((workspace) => workspace.ref);
        const panesByWorkspace = await Promise.all(
          targetWorkspaceRefs.map(async (workspaceRef) => ({
            workspaceRef,
            panes: await client.listPanes({ workspace: workspaceRef }),
          })),
        );
        const workspaceCwdByRef = new Map<string, string>();
        for (const workspace of workspaces.workspaces) {
          const cwd = nonEmptyString(workspace.current_directory);
          if (cwd) {
            workspaceCwdByRef.set(workspace.ref, cwd);
          }
        }
        const paneByWorkspaceAndRef = new Map<
          string,
          Record<string, unknown>
        >();
        for (const { workspaceRef, panes } of panesByWorkspace) {
          for (const pane of panes.panes) {
            paneByWorkspaceAndRef.set(
              paneWorkingDirectoryKey(workspaceRef, pane.ref),
              pane as unknown as Record<string, unknown>,
            );
          }
        }
        const columnIndexByWorkspace = new Map<string, Map<string, number>>();
        const columnCountByWorkspace = new Map<string, number>();
        for (const { workspaceRef, panes } of panesByWorkspace) {
          const columnIndex = deriveColumnIndex(panes.panes);
          columnIndexByWorkspace.set(workspaceRef, columnIndex);
          columnCountByWorkspace.set(
            workspaceRef,
            new Set(columnIndex.values()).size,
          );
        }
        const surfaceGroupsByWorkspace = await Promise.all(
          panesByWorkspace.map(async ({ workspaceRef, panes }) => {
            const rawGroups = await Promise.all(
              panes.panes.map(async (pane) => {
                const group = await client.listPaneSurfaces({
                  workspace: workspaceRef,
                  pane: pane.ref,
                });
                return {
                  ...group,
                  workspace_ref: group.workspace_ref ?? workspaceRef,
                  pane_ref: group.pane_ref ?? pane.ref,
                };
              }),
            );
            return partitionPaneSurfacesByMembership(panes.panes, rawGroups, {
              workspace_ref: panes.workspace_ref ?? workspaceRef,
              window_ref: panes.window_ref,
            });
          }),
        );
        const surfaceGroups = surfaceGroupsByWorkspace.flat();
        const surfacesWithStableIds = enrichSurfaceIdsFromPanes(
          panesByWorkspace.map(({ workspaceRef, panes }) => ({
            ref: workspaceRef,
            panes,
          })),
          surfaceGroups,
        );
        const stableIdByRef = new Map(
          surfacesWithStableIds.flatMap((surface) =>
            surface.id ? [[surface.ref, surface.id] as const] : [],
          ),
        );
        captureSurfaceIdentities(stableIdByRef, listingObserverEpoch);
        const uniqueSurfaceEntries: Array<{
          group: {
            workspace_ref: string;
            window_ref: string;
            pane_ref: string;
            surfaces: CmuxSurface[];
          };
          surface: CmuxSurface;
        }> = [];
        const seenSurfaceRefs = new Set<string>();
        let anonymousSurfaceIndex = 0;

        for (const group of surfaceGroups) {
          for (const surface of group.surfaces) {
            const dedupeKey =
              typeof surface.ref === "string" && surface.ref.length > 0
                ? surface.ref
                : `${group.workspace_ref}:${group.pane_ref}:anonymous:${anonymousSurfaceIndex++}`;

            if (seenSurfaceRefs.has(dedupeKey)) {
              continue;
            }

            seenSurfaceRefs.add(dedupeKey);
            uniqueSurfaceEntries.push({ group, surface });
          }
        }

        const verboseSurfaces = await Promise.all(
          uniqueSurfaceEntries.map(async ({ group, surface }) => {
            const enrichedSurface: Record<string, unknown> = {
              ...surface,
              ...(surface.id || !stableIdByRef.has(surface.ref)
                ? {}
                : { id: stableIdByRef.get(surface.ref) }),
              workspace_ref: group.workspace_ref,
              window_ref: group.window_ref,
              pane_ref: group.pane_ref,
            };
            const column = columnIndexByWorkspace
              .get(group.workspace_ref)
              ?.get(group.pane_ref);
            if (typeof column === "number") {
              enrichedSurface.column = column;
            }

            if (args.include_screen_preview && surface.type === "terminal") {
              try {
                const preview = await client.readScreen(surface.ref, {
                  workspace: group.workspace_ref,
                  lines: args.preview_lines,
                });
                enrichedSurface.screen_preview = preview.text;
              } catch (error) {
                enrichedSurface.screen_preview_error =
                  error instanceof Error ? error.message : String(error);
              }
            }

            return enrichedSurface;
          }),
        );
        const terminalMetadata = await loadTerminalMetadataBySurface(client);
        const workingDirectoryMaps: SurfaceWorkingDirectoryMaps = {
          terminalBySurface: terminalMetadata.terminalBySurface,
          paneByWorkspaceAndRef,
          workspaceCwdByRef,
        };
        for (const surface of verboseSurfaces) {
          const workspaceRef = nonEmptyString(surface.workspace_ref) ?? "";
          const paneRef = nonEmptyString(surface.pane_ref) ?? "";
          applySurfaceWorkingDirectory(
            surface,
            workspaceRef,
            paneRef,
            workingDirectoryMaps,
          );
        }

        const verboseWorkspaces = workspaces.workspaces as unknown as Array<
          Record<string, unknown>
        >;
        const responseWorkspaces = args.verbose
          ? verboseWorkspaces
          : verboseWorkspaces.map((workspace) => toMinimalWorkspace(workspace));
        const responseSurfaces = args.verbose
          ? verboseSurfaces
          : verboseSurfaces.map((surface) => toMinimalSurface(surface));

        const data: Record<string, unknown> = {
          workspaces: responseWorkspaces,
          surfaces: responseSurfaces,
          column_count: targetWorkspaceRefs.reduce(
            (max, workspaceRef) =>
              Math.max(max, columnCountByWorkspace.get(workspaceRef) ?? 0),
            0,
          ),
        };
        if (args.workspace) {
          data.workspace_ref = args.workspace;
        }
        if (terminalMetadata.degraded) {
          data.metadata_degraded = terminalMetadata.degraded;
        }
        const formatted = formatListSurfaces(
          responseSurfaces as Array<{
            ref?: string;
            title?: string;
            type?: string;
            workspace_ref?: string;
            pane_ref?: string;
            screen_preview?: string;
          }>,
          responseWorkspaces as Array<{ ref: string; title?: string }>,
        );
        return okFormatted(formatted, data);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "control_health",
    "Report terse control-path health by default; pass detail=full for diagnostics.",
    {
      detail: z.enum(["terse", "full"]).optional().default("terse"),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        const health = await appendControlHealthSnapshot();
        const staleWarning = staleBuildWarning();
        const healthWithStale = staleWarning
          ? { ...health, warnings: [...health.warnings, staleWarning] }
          : health;
        if (args.detail === "full") {
          return okFormatted(formatControlHealth(healthWithStale), {
            health: healthWithStale,
          });
        }
        const caller = resolveCurrentCallerAgent();
        const callerCanonicalId = caller
          ? canonicalAgentId(caller.agent_id)
          : null;
        const callerWatchOwnerCandidates = caller
          ? snapshotWatchOwnerCandidates()
          : [];
        const watches = caller
          ? readWatchRegistry({
              registryPath:
                opts?.watchRegistryPath ??
                join(context.stateDir, "watch-specs.json"),
            }).watches
              .filter(
                (watch) => {
                  const ownerResolution = resolveWatchOwner(
                    watchRecordOwner(watch),
                    callerWatchOwnerCandidates,
                  );
                  return (
                    callerCanonicalId !== null &&
                    ownerResolution.kind === "resolved" &&
                    watchOwnerIncludesCanonical(
                      ownerResolution,
                      callerCanonicalId,
                    ) &&
                    (watch.state === "armed" || watch.state === "firing")
                  );
                },
              )
              .map(({ watch_id, target, state }) => ({
                watch_id,
                target,
                state,
              }))
          : [];
        const terse = {
          transport: healthWithStale.selected_transport,
          warnings: healthWithStale.warnings,
          daemon_lifecycle: healthWithStale.daemon_lifecycle,
          self_heal: {
            pane_pty_dead:
              healthWithStale.self_heal.pane_pty_dead.count,
            collapsed_monitors:
              healthWithStale.self_heal.monitor_registry.collapsed,
          },
          caller_live_watches: {
            count: watches.length,
            watches,
          },
        };
        return okFormatted(JSON.stringify(terse), { health: terse });
      } catch (e) {
        return err(e);
      }
    },
  );

  // Deferred layout/UI tool: keep beside create_workspace so the thin-core
  // palette classifies both workspace-management tools together off-default.
  const deleteWorkspaceTool = server.tool(
    "delete_workspace",
    "Delete a whole workspace tab and all of its panes/surfaces. SAFETY: refuses a workspace that backs a live agent, or the caller's own workspace, unless force:true. Refusals include the current surfaces and agents for verification.",
    {
      workspace: z.string().describe("Target workspace ref"),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Delete even when the workspace backs a live agent or is the caller's workspace.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const targetWorkspace =
          (await canonicalWorkspaceRef(args.workspace)) ?? args.workspace;
        await assertWorkspaceMutationAllowed(
          "delete_workspace",
          targetWorkspace,
        );

        const [{ workspaces }, panes] = await Promise.all([
          listAllWorkspaces(),
          client.listPanes({ workspace: targetWorkspace }),
        ]);
        const paneGroups = await Promise.all(
          panes.panes.map((pane) =>
            client.listPaneSurfaces({
              workspace: targetWorkspace,
              pane: pane.ref,
            }),
          ),
        );
        const surfaces = paneGroups
          .flatMap((group) => group.surfaces)
          .filter(
            (surface, index, all) =>
              all.findIndex((candidate) => candidate.ref === surface.ref) ===
              index,
          );
        const surfaceRefs = new Set(surfaces.map((surface) => surface.ref));
        const agents = stateMgr
          .listStates()
          .filter(
            (agent) =>
              surfaceRefs.has(agent.surface_id) ||
              agent.workspace_id === targetWorkspace,
          );
        const liveAgents = agents.filter(
          (agent) => !TERMINAL_AGENT_STATES.has(agent.state),
        );
        const callerWorkspace = await currentSafetyCallerWorkspace();
        const deletingCallerWorkspace = callerWorkspace === targetWorkspace;

        if (!args.force && (deletingCallerWorkspace || liveAgents.length > 0)) {
          const reasons = [
            ...(deletingCallerWorkspace ? ["it is the caller workspace"] : []),
            ...(liveAgents.length > 0
              ? [`it backs ${liveAgents.length} live agent(s)`]
              : []),
          ];
          return err(
            new Error(
              `Refused to delete ${targetWorkspace}: ${reasons.join(" and ")}. Pass force:true to delete anyway.`,
            ),
            {
              refused: true,
              workspace: targetWorkspace,
              caller_workspace: deletingCallerWorkspace,
              surfaces,
              agents,
              live_agents: liveAgents,
            },
          );
        }

        await client.deleteWorkspace(targetWorkspace);
        const removedWorkspace = workspaces.find(
          (workspace) => workspace.ref === targetWorkspace,
        ) ?? {
          ref: targetWorkspace,
        };
        const data = {
          workspace: targetWorkspace,
          force: args.force ?? false,
          removed: {
            workspaces: [removedWorkspace],
            surfaces,
          },
        };
        return okFormatted(formatOk("delete_workspace", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );
  deleteWorkspaceTool.update({
    _meta: {
      defer_loading: true,
      "cmuxlayer/interim": true,
    },
  });

  // 4. move_surface
  server.tool(
    "move_surface",
    "Move a surface (tab) between panes or workspaces",
    {
      surface: z.string().describe("Surface ref to move"),
      pane: z.string().optional().describe("Target pane ref"),
      workspace: z.string().optional().describe("Target workspace ref"),
      before: z.string().optional().describe("Insert before this surface ref"),
      after: z.string().optional().describe("Insert after this surface ref"),
      index: z.number().int().optional().describe("Insert at this tab index"),
      focus: z
        .boolean()
        .optional()
        .describe("Whether to focus the moved surface"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          undefined,
          "move_surface",
        );
        const result = await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            return client.moveSurface({
              surface: route.surface,
              pane: args.pane,
              workspace: args.workspace,
              before: args.before,
              after: args.after,
              index: args.index,
              focus: args.focus,
            });
          },
          {
            toolName: "move_surface",
            workspace: route.workspace,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
        // F8: slim, phone-readable confirmation — drop the verbose passthrough.
        const data = {
          surface: result.surface,
          pane: result.pane,
          workspace: result.workspace,
        };
        const dest = result.pane ?? result.workspace ?? "destination";
        return okFormatted(
          `✔ move_surface ─ moved ${result.surface} → ${dest}`,
          data,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  // 5. send_input
  server.tool(
    "send_input",
    `${PANE_INPUT_BREAKAGE_GUIDANCE} Low-level surface tool: send text input to a terminal surface. For tracked agents, prefer send_to(agent_id) so cmuxlayer resolves the current backing surface. WARNING — DO NOT include a bare \`@word\` (e.g. \`@narration-lead\`) in text destined for an interactive agent composer (Claude Code / Codex / Cursor TUIs): the receiving composer treats \`@\` as its file-reference trigger and pops a file-picker overlay, swallowing the rest of your message — silent delivery corruption that the ok:true result will NOT report. Use the bare name (\`narration-lead:\`) for pane-to-pane addressing; reserve \`@<name>\` for collab-file posts where monitors match it. If a literal \`@\` is unavoidable, deliver via a file the agent cat-reads, not live keystrokes. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} UTF-8 bytes by default (CMUXLAYER_MAX_INLINE_CHARS, a byte count >= ${SEND_INPUT_CHUNK_THRESHOLD}); tracked Codex/Claude/Cursor/Gemini agents also refuse multi-paragraph inline text by default. Pass allow_long_inline:true only for deliberate raw sends. Text over ${SEND_INPUT_CHUNK_THRESHOLD} characters that is allowed is split into line-aligned logical chunks and coalesced into bounded paste batches; each physical paste waits for cmux acknowledgment before the next is sent. Chunked or multiline text is pasted into the composer so embedded newlines do not submit partial messages; press_enter=true presses return once after the final chunk. Paste failure returns an error without pressing Return. Set background=true to return immediately with a delivery_id while chunking continues in the background. For full commands, prefer send_command so text and return land on the same surface atomically. ${ZSH_BANG_INLINE_WARNING}`,
    {
      surface: z.string().describe("Target surface ref"),
      text: z
        .string()
        .describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default.`,
        ),
      workspace: z.string().optional().describe("Target workspace ref"),
      chunk_size: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(200)
        .describe("Chunk size for automatic long-text delivery"),
      background: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Return immediately with a delivery_id and continue chunked delivery in the background",
        ),
      press_enter: z
        .boolean()
        .optional()
        .default(false)
        .describe("Press return once after all chunks have landed."),
      rename_to_task: z
        .string()
        .optional()
        .describe("Rename tab suffix to this task name"),
      allow_long_inline: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const internalArgs = args as typeof args & {
          _cmuxlayer_source_event?: DeliveryEventType;
          _cmuxlayer_delivery_id?: string;
          _cmuxlayer_timings?: DeliveryPhaseTimings;
        };
        const sourceEvent =
          internalArgs._cmuxlayer_source_event ?? "send_input";
        const requestedDeliveryId = internalArgs._cmuxlayer_delivery_id;
        const timings = internalArgs._cmuxlayer_timings;
        assertInlineInputAllowed({
          tool: "send_input",
          arg: "text",
          value: args.text,
          allowLongInline: args.allow_long_inline,
        });
        assertDenseInlineInputAllowed({
          tool: "send_input",
          arg: "text",
          value: args.text,
          allowLongInline: args.allow_long_inline,
        });
        const sanitizedText = sanitizeTerminalInput(args.text);
        const effectiveChunkSize = Math.min(
          args.chunk_size,
          SEND_INPUT_PASTE_BATCH_MAX_BYTES,
        );
        const chunks =
          sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
            ? limitInputChunksByUtf8ByteSize(
                chunkTerminalInput(sanitizedText, effectiveChunkSize),
              )
            : [sanitizedText];
        const route = await timeDeliveryPhase(timings, "enumerate", () =>
          resolveRawSurfaceMutationRoute(
            args.surface,
            args.workspace,
            "send_input",
          ),
        );
        const targetRecord = resolveLatestSurfaceAgentRecord(
          stateMgr,
          route.surface,
          route.stableSurfaceIdentity,
        );
        // A public delivery_id is a promise that wait_for can resolve. Raw,
        // unmanaged surfaces have no lifecycle identity for the verifier, so
        // keep their truthful queued receipt ID-free instead of exposing an
        // orphaned handle.
        const deliveryId = targetRecord ? requestedDeliveryId : undefined;
        assertInteractiveMultilineInputAllowed({
          tool: "send_input",
          value: args.text,
          cli: targetRecord?.cli,
          allowLongInline: args.allow_long_inline,
        });
        if (args.background) {
          const shouldVerifySubmit =
            args.press_enter &&
            (await shouldVerifyRawSurfaceSubmit(
              targetRecord,
              route.surface,
              route.workspace,
            ));
          await assertSurfaceMutationAllowed(
            "send_input",
            route.surface,
            route.workspace,
          );
          await route.assertCurrent();
          const record: DeliveryRecord = {
            delivery_id: deliveryId ?? randomUUID(),
            surface: route.surface,
            workspace: route.workspace,
            status: "delivering",
            total_chunks: chunks.length,
            sent_chunks: 0,
            chunk_size: effectiveChunkSize,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            chunks,
            press_enter: args.press_enter,
            verify_submit: shouldVerifySubmit,
            submit_verified: null,
            retry_count: 0,
            rpc_methods: [],
            typed: false,
            submit_dispatched: false,
            rename_to_task: args.rename_to_task,
            started_at: new Date().toISOString(),
            stableSurfaceIdentity: route.stableSurfaceIdentity,
            beforeMutation: route.assertCurrent,
          };
          const receiptEngine = context.lifecycleSweepEngine;
          const backgroundLifecycle =
            targetRecord && receiptEngine
              ? {
                  engine: receiptEngine,
                  agent_id: targetRecord.agent_id,
                  text: sanitizedText,
                  source_event: sourceEvent,
                }
              : undefined;
          if (backgroundLifecycle) {
            backgroundLifecycle.engine.registerExternalDelivery({
              delivery_id: record.delivery_id,
              agent_id: backgroundLifecycle.agent_id,
              text: sanitizedText,
              press_enter: args.press_enter,
              source_event: sourceEvent,
              rpc_methods: [],
            });
          }
          startBackgroundDelivery(record, backgroundLifecycle);
          const publicBackgroundDeliveryId =
            backgroundLifecycle || sourceEvent !== "send_to"
              ? record.delivery_id
              : undefined;

          const identity = resolveTargetIdentity(
            stateMgr,
            route.surface,
            route.title,
            route.stableSurfaceIdentity,
          );
          const data = {
            ...identity,
            ...buildPublicDeliveryReceipt({
              delivery_state: "queued",
              delivery_id: publicBackgroundDeliveryId,
              typed: false,
              submit_attempted: args.press_enter,
              submit_verified: record.submit_verified,
              retry_count: record.retry_count,
            }),
            status: record.status,
            ...remapFields(route),
          };
          return okFormatted(
            formatDelivery("send_input", {
              ...identity,
              delivered: false,
              pending: true,
            }) +
              (publicBackgroundDeliveryId
                ? ` (background ${record.delivery_id})`
                : " (background started; no wait_for receipt for unmanaged surface)"),
            data,
          );
        }

        const delivery = await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            return executeDeliveryEngine({
              surface: route.surface,
              workspace: route.workspace,
              chunks,
              chunk_size: effectiveChunkSize,
              chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
              press_enter: args.press_enter,
              rename_to_task: args.rename_to_task,
              stableSurfaceIdentity: route.stableSurfaceIdentity,
              source_event: sourceEvent,
              delivery_id: deliveryId,
              verify_submit:
                args.press_enter &&
                !!targetRecord &&
                INTERACTIVE_AGENT_STATES.has(targetRecord.state),
              verify_submit_for_tracked_surface:
                args.press_enter ? targetRecord : undefined,
              beforeMutation: route.assertCurrent,
              timings,
            });
          },
          {
            toolName: "send_input",
            workspace: route.workspace,
            observePtyWrite: true,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
            timings,
          },
        );

        const receiptEngine = context.lifecycleSweepEngine;
        if (
          sourceEvent === "send_to" &&
          deliveryId &&
          targetRecord &&
          receiptEngine
        ) {
          if (
            delivery.delivery === "queued" ||
            delivery.delivery === "queued_followup"
          ) {
            receiptEngine.acceptComposerQueue({
              delivery_id: deliveryId,
              agent_id: targetRecord.agent_id,
              text: sanitizedText,
              press_enter: args.press_enter,
              source_event: "send_to",
              retry_count: delivery.retry_count,
              rpc_methods: delivery.rpc_methods,
              typed: delivery.typed,
              submit_dispatched: delivery.submit_dispatched,
              delivery_state: delivery.delivery,
            });
          } else if (delivery.delivery === "pending_verify") {
            receiptEngine.acceptPendingVerify({
              delivery_id: deliveryId,
              agent_id: targetRecord.agent_id,
              text: sanitizedText,
              press_enter: args.press_enter,
              source_event: "send_to",
              retry_count: delivery.retry_count,
              rpc_methods: delivery.rpc_methods,
              typed: delivery.typed,
              submit_dispatched: delivery.submit_dispatched,
            });
          } else {
            receiptEngine.resolveDelivery({
              delivery_id: deliveryId,
              agent_id: targetRecord.agent_id,
              text: sanitizedText,
              press_enter: args.press_enter,
              source_event: "send_to",
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

        const identity = resolveTargetIdentity(
          stateMgr,
          route.surface,
          route.title,
          route.stableSurfaceIdentity,
        );
        const data = {
          ...identity,
          ...delivery,
          ...remapFields(route),
        };
        return okFormatted(
          formatDelivery("send_input", {
            ...identity,
            delivered: delivery.delivered,
            pending: delivery.delivery === "queued",
            typed: delivery.typed,
            submit_attempted: delivery.submit_attempted,
            submit_verified: delivery.submit_verified,
          }),
          data,
        );
      } catch (e) {
        if (e instanceof SurfaceGoneError) {
          return err(e, surfaceGonePayload(e));
        }
        if (e instanceof DeliverySafetyGateError) {
          return err(e, {
            error_code: e.error_code,
            submit_verified: e.submit_verified,
            screen: e.screen,
          });
        }
        if (e instanceof SubmitVerificationError) {
          return err(e, {
            ...(e.receipt ?? {}),
            submit_verified: false,
            retry_count: e.retry_count,
          });
        }
        if (e instanceof DeliveryError) {
          return err(e, { failed_chunk: e.failed_chunk ?? null });
        }
        return err(e);
      }
    },
  );

  // 7. send_command
  server.tool(
    "send_command",
    `${PANE_INPUT_BREAKAGE_GUIDANCE} Atomically send a command and press return on the same raw surface. Prefer this over separate send_input + send_key calls when launching or resuming agents. If the user provided an exact command, send exactly that command only when it fits the ${SEND_INPUT_MAX_INLINE_CHARS}-byte inline cap. WARNING — never include a bare \`@word\` in text destined for an interactive agent composer: it fires the receiver's file-reference picker and corrupts delivery (use the bare name; \`@<name>\` belongs in collab files, not pane keystrokes). For known agent launchers with -s (for example brainlayerCodex -s), boot_prompt_path is checked before launch and safely submits multiline or over-cap files as one \`Read and follow <path>\` pointer after readiness; use it instead of embedding a multi-paragraph boot prompt in pane keystrokes. Passing boot_prompt_path for plain shell commands is rejected. Pass allow_long_inline:true only for deliberate raw long commands. ${ZSH_BANG_INLINE_WARNING}`,
    {
      surface: z.string().describe("Target surface ref"),
      command: z
        .string()
        .describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Command text to send before pressing return. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default; for agent boot prompts, pass boot_prompt_path.`,
        ),
      workspace: z.string().optional().describe("Target workspace ref"),
      boot_prompt_path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional readable prompt-file path for launcher commands matching <repo>Codex|Claude|Cursor|Gemini|Kiro with -s. Checked before launch; multiline or over-cap files are submitted as one `Read and follow <path>` pointer after readiness.",
        ),
      boot_prompt_timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .default(BOOT_PROMPT_TIMEOUT_MS)
        .describe("Timeout in milliseconds waiting for the agent ready prompt"),
      allow_long_inline: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Bypass the inline command length cap for a deliberate raw send.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        assertInlineInputAllowed({
          tool: "send_command",
          arg: "command",
          value: args.command,
          allowLongInline: args.allow_long_inline,
        });
        assertDenseInlineInputAllowed({
          tool: "send_command",
          arg: "command",
          value: args.command,
          allowLongInline: args.allow_long_inline,
        });
        const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
        const launcherCli = bootPromptPath
          ? inferLauncherCli(args.command)
          : null;
        if (bootPromptPath && !launcherCli) {
          throw new Error(
            "boot_prompt_path is only supported for agent launcher commands with -s",
          );
        }
        if (bootPromptPath) {
          await preflightBootPromptFile(bootPromptPath);
        }

        const sanitizedCommand = sanitizeTerminalInput(args.command);
        const chunks =
          sanitizedCommand.length > SEND_INPUT_CHUNK_THRESHOLD
            ? chunkTerminalInput(sanitizedCommand, SEND_INPUT_CHUNK_THRESHOLD)
            : [sanitizedCommand];
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "send_command",
        );
        const targetRecord = resolveLatestSurfaceAgentRecord(
          stateMgr,
          route.surface,
        );
        // #805: a seat sending to its OWN surface (e.g. `/mcp reconnect x`) is
        // blocked inside this very tool call, so its composer only queues the
        // input until the turn ends: submit evidence cannot appear, and
        // verifying would poll topology to a timeout. Deliver, skip that
        // verification, and say so on the receipt.
        // Match on the stable UUID whenever the route has one; the mutable ref
        // is only the fallback for ref-only connectors (a ref-shaped caller id
        // must not match a UUID-bound route by ref).
        const callerSurface = currentCallerContext()?.surfaceId?.trim().toLowerCase();
        const routeUuid = route.stableSurfaceIdentity?.trim().toLowerCase();
        const selfTarget = Boolean(callerSurface) &&
          (routeUuid
            ? routeUuid === callerSurface
            : route.surface.toLowerCase() === callerSurface);
        const delivery = await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            return executeDeliveryEngine({
              surface: route.surface,
              workspace: route.workspace,
              chunks,
              chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
              chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
              press_enter: true,
              stableSurfaceIdentity: route.stableSurfaceIdentity,
              source_event: "send_command",
              verify_submit:
                !bootPromptPath &&
                !selfTarget &&
                !!targetRecord &&
                INTERACTIVE_AGENT_STATES.has(targetRecord.state),
              verify_submit_for_tracked_surface:
                bootPromptPath || selfTarget ? undefined : targetRecord,
              beforeMutation: route.assertCurrent,
            });
          },
          {
            toolName: "send_command",
            workspace: route.workspace,
            observePtyWrite: true,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );

        let bootPromptDelivery:
          Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
        if (bootPromptPath && launcherCli) {
          bootPromptDelivery = await deliverBootPrompt({
            surface: route.surface,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
            workspace: route.workspace,
            cli: launcherCli,
            boot_prompt_path: bootPromptPath,
            timeout_ms: args.boot_prompt_timeout_ms,
            resolveRoute: async () => {
              await route.assertCurrent();
              return { surface: route.surface, workspace: route.workspace };
            },
            onUpdateShellRelaunch: () =>
              sendLauncherCommandToSurface({
                surface: route.surface,
                stableSurfaceIdentity: route.stableSurfaceIdentity,
                workspace: route.workspace,
                command: sanitizedCommand,
                relaunch: true,
                assertSurfaceBindingCurrent: route.assertCurrent,
              }),
          });
        }

        const identity = resolveTargetIdentity(
          stateMgr,
          route.surface,
          route.title,
          route.stableSurfaceIdentity,
        );
        const data = {
          ...identity,
          command: sanitizedCommand,
          ...delivery,
          ...(selfTarget
            ? {
                self_target: true,
                self_target_note:
                  "Typed into the caller's own surface: the caller's turn is blocked in this call, so the command is expected to run when that turn ends; submit is not verifiable from inside it.",
              }
            : {}),
          ...remapFields(route),
          boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
          boot_prompt_receipt: bootPromptDelivery,
          boot_prompt_bytes: bootPromptDelivery?.bytes,
          boot_prompt_submit_verified:
            bootPromptDelivery?.submit_verified ?? null,
          boot_prompt_warning: bootPromptDelivery?.prompt_warning ?? null,
        };
        return okFormatted(
          formatDelivery("send_command", {
            ...identity,
            delivered: delivery.delivered,
            pending: delivery.delivery === "queued",
            typed: delivery.typed,
            submit_attempted: delivery.submit_attempted,
            submit_verified: delivery.submit_verified,
          }),
          data,
        );
      } catch (e) {
        if (e instanceof SurfaceGoneError) {
          return err(e, surfaceGonePayload(e));
        }
        if (e instanceof DeliverySafetyGateError) {
          return err(e, {
            error_code: e.error_code,
            submit_verified: e.submit_verified,
            screen: e.screen,
          });
        }
        if (e instanceof SubmitVerificationError) {
          return err(e, {
            ...(e.receipt ?? {}),
            submit_verified: false,
            retry_count: e.retry_count,
          });
        }
        if (e instanceof BootPromptTimeoutError) {
          return err(e, { last_10_lines: e.last_10_lines });
        }
        if (e instanceof BootPromptUpdateMenuBlockedError) {
          return err(e, {
            error_code: e.error_code,
            last_10_lines: e.last_10_lines,
            recovery: e.recovery,
          });
        }
        if (e instanceof BootComposerResidueError) {
          return err(e, {
            delivered_chars: e.delivered_chars,
            error_code: e.error_code,
            composer_residue: e.composer_residue,
            typed: e.typed,
            submit_dispatched: e.submit_dispatched,
            rpc_methods: e.rpc_methods,
          });
        }
        if (e instanceof BootPromptDeliveryError) {
          return err(e, { delivered_chars: e.delivered_chars });
        }
        if (e instanceof DeliveryError) {
          return err(e, { failed_chunk: e.failed_chunk ?? null });
        }
        return err(e);
      }
    },
  );

  // 8. send_key
  server.tool(
    "send_key",
    "Send a key press to a terminal surface. Accepted Ctrl+C aliases are normalized automatically: ctrl-c, C-c, ^c, Ctrl+C, Ctrl-C.",
    {
      surface: z.string().describe("Target surface ref"),
      key: z
        .string()
        .describe("Key name (e.g. 'return', 'escape', 'tab', 'ctrl-c')"),
      workspace: z.string().optional().describe("Target workspace ref"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const key = normalizeKeyName(args.key);
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "send_key",
        );
        const delivery = await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            return executeDeliveryEngine({
              surface: route.surface,
              workspace: route.workspace,
              chunks: [],
              key,
              chunk_size: 0,
              chunk_delay_ms: 0,
              press_enter: false,
              // A submit key is the documented recovery for a typed-but-unsent
              // message. It has to prove it landed rather than assert it.
              verify_submit: true,
              stableSurfaceIdentity: route.stableSurfaceIdentity,
              source_event: "send_key",
              beforeMutation: route.assertCurrent,
            });
          },
          {
            toolName: "send_key",
            workspace: route.workspace,
            observePtyWrite: true,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
        const data = {
          surface: route.surface,
          key,
          ...delivery,
          ...remapFields(route),
        };
        if (delivery.submit_verified === false) {
          return err(
            new Error(
              `send_key ${key} reached ${route.surface} but the submit did not land (${delivery.submit_verification_reason}). The composer still holds its unsent contents — nothing was delivered. Read the surface and resolve the pending input before relaying this as sent.`,
            ),
            data,
          );
        }
        return okFormatted(formatOk("send_key", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 9. read_screen
  server.tool(
    "read_screen",
    "Read a terminal screen and parsed harness status. Use raw=true for full text or parsed_only=true for monitoring.",
    {
      surface: z.string().optional().describe("Target surface ref"),
      // AIDEV-NOTE (#611): `surface_id` is accepted because WE taught it. Our
      // own spawn_agent output schema and every list_agents row EMIT
      // `surface_id`, so the natural workflow -- list_agents, then read the
      // surface it named -- hands that key straight back and got a validation
      // error. The value was always right; only the name was, and the tool that
      // taught the wrong name was ours. This is an alias for that reason, not
      // for backwards compatibility.
      surface_id: z
        .string()
        .optional()
        .describe("Alias for `surface`, as emitted by list_agents/spawn_agent."),
      workspace: z.string().optional().describe("Target workspace ref"),
      lines: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(20)
        .describe("Number of lines to read"),
      scrollback: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include scrollback buffer"),
      parsed_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, return only parsed fields (omit screen content). Best for agent monitoring.",
        ),
      raw: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include the full untrimmed terminal content (separators, status-bar art, all lines). Default false returns a compact de-chromed screen_preview instead.",
        ),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        // #611: accept either spelling, then use one resolved value below.
        const surfaceRef = args.surface ?? args.surface_id;
        if (!surfaceRef) {
          throw new Error(
            'read_screen requires a surface. Example: read_screen({ surface: "surface:122" }) -- the surface_id from list_agents is accepted too.',
          );
        }
        let codexAgentBeforeRead: AgentRecord | null = null;
        const hasCodexRolloutCandidate = stateMgr
          .listStates()
          .some(
            (agent) =>
              agent.cli === "codex" &&
              Boolean(agent.surface_uuid?.trim()) &&
              Boolean(agent.cli_session_path),
          );
        if (hasCodexRolloutCandidate) {
          const topologyBeforeRead = await collectSurfaceTopology(
            args.workspace,
          ).catch(() => null);
          codexAgentBeforeRead = resolveCodexAgentForSurface(
            surfaceRef,
            topologyBeforeRead,
          );
        }
        let result: ReadScreenSnapshot["result"];
        let topology: ReadScreenSnapshot["topology"];
        let screenRemap: Pick<
          RawSurfaceMutationRoute,
          "remapped_from" | "remapped_to"
        > = {};
        const snapshotOpts = {
          surface: surfaceRef,
          workspace: args.workspace,
          lines: Math.max(args.lines ?? 20, 80),
          scrollback: args.scrollback,
        };
        try {
          ({ result, topology } = await readScreenSnapshot(snapshotOpts));
        } catch (readError) {
          const route = await resolveRawSurfaceMutationRoute(
            surfaceRef,
            args.workspace,
            "read_screen",
          );
          if (
            route.surface === surfaceRef &&
            (route.workspace ?? null) === (args.workspace ?? null)
          ) {
            throw readError;
          }
          screenRemap = remapFields(route);
          ({ result, topology } = await readScreenSnapshot({
            ...snapshotOpts,
            surface: route.surface,
            workspace: route.workspace ?? args.workspace,
          }));
          if (hasCodexRolloutCandidate) {
            codexAgentBeforeRead = resolveCodexAgentForSurface(
              route.surface,
              topology,
            );
          }
        }
        const requestedIsLive =
          topology?.workspaceBySurface.has(surfaceRef) === true ||
          topology?.surfaceIdByRef.has(surfaceRef) === true;
        if (
          topology?.complete === true &&
          !requestedIsLive &&
          !screenRemap.remapped_from
        ) {
          const route = await resolveRawSurfaceMutationRoute(
            surfaceRef,
            args.workspace,
            "read_screen",
          );
          screenRemap = remapFields(route);
          if (route.surface !== surfaceRef) {
            const remapped = await readScreenSnapshot({
              ...snapshotOpts,
              surface: route.surface,
              workspace: route.workspace ?? args.workspace,
            });
            result = remapped.result;
            topology = remapped.topology;
            if (hasCodexRolloutCandidate) {
              codexAgentBeforeRead = resolveCodexAgentForSurface(
                route.surface,
                topology,
              );
            }
          }
        }
        const title = topology?.titleBySurface.get(result.surface) ?? null;
        const { column, column_count } =
          topology?.topologyBySurface.get(result.surface) ??
          EMPTY_SURFACE_TOPOLOGY;
        const codexAgent = sameCodexSessionBinding(
          codexAgentBeforeRead,
          resolveCodexAgentForSurface(result.surface, topology),
        );
        const codexFill = await validateCodexRolloutFill(
          codexAgent,
          result.surface,
          await readCodexRolloutFill(codexAgent),
        );
        const parsed = applyCodexRolloutFill(
          applyHarnessState(
            enrichParsedScreen(
              parseScreen(result.text),
              result.text,
              pickLatestSurfaceModel(stateMgr, result.surface),
            ),
            resolveHarnessStateForSurface(stateMgr, result.surface, codexAgent),
          ),
          codexFill,
        );
        // The lean and parsed-only variants are separate reads. A caller may
        // compare parsed fields only when these hashes identify the same frame.
        const snapshot_hash = createHash("sha256").update(result.text).digest("hex");

        if (args.parsed_only) {
          const data = {
            surface: result.surface,
            snapshot_hash,
            title,
            column,
            column_count,
            parsed,
            delivery: getSurfaceDelivery(result.surface),
            ...screenRemap,
          };
          const formatted = formatReadScreen(
            result.surface,
            title,
            null,
            parsed,
            false,
            0,
            column,
            column_count,
          );
          return okFormatted(formatted, data);
        }

        if (args.raw) {
          // Full untrimmed terminal content on explicit request.
          const rawText = result.text
            .split("\n")
            .slice(-(args.lines ?? 20))
            .join("\n");
          const data = {
            surface: result.surface,
            snapshot_hash,
            title,
            column,
            column_count,
            lines: rawText.split("\n").length,
            content: rawText,
            scrollback_used: result.scrollback_used,
            parsed,
            delivery: getSurfaceDelivery(result.surface),
            ...screenRemap,
          };
          const formatted = formatReadScreen(
            result.surface,
            title,
            rawText,
            parsed,
            result.scrollback_used,
            rawText.split("\n").length,
            column,
            column_count,
          );
          return okFormatted(formatted, data);
        }

        // LEAN DEFAULT: response returned once (parsed.response); no raw dump. Show a
        // compact de-chromed preview ONLY when there's no response, so non-agent panes
        // (shell prompts, menus) still surface something without duplicating the response.
        const screenPreview = parsed.response
          ? null
          : cleanScreenText(result.text, 12) || null;
        const data = {
          surface: result.surface,
          snapshot_hash,
          title,
          column,
          column_count,
          parsed,
          ...(screenPreview ? { screen_preview: screenPreview } : {}),
          delivery: getSurfaceDelivery(result.surface),
          ...screenRemap,
        };
        const formatted = formatReadScreen(
          result.surface,
          title,
          screenPreview,
          parsed,
          false,
          screenPreview ? screenPreview.split("\n").length : 0,
          column,
          column_count,
        );
        return okFormatted(formatted, data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 6. rename_tab
  server.tool(
    "rename_tab",
    "Rename a surface tab",
    {
      surface: z.string().describe("Target surface ref"),
      title: z.string().describe("New tab title"),
      workspace: z.string().optional().describe("Target workspace ref"),
      preserve_prefix: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only replace the task suffix, keeping launcher prefix"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "rename_tab",
        );
        let finalTitle = args.title;
        if (args.preserve_prefix) {
          const surfaces = await client.listPaneSurfaces({
            workspace: route.workspace,
          });
          const surface = surfaces.surfaces.find(
            (s) => s.ref === route.surface,
          );
          const currentTitle = surface?.title ?? "";
          finalTitle = replaceTaskSuffix(currentTitle, args.title);
        }
        await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            await client.renameTab(route.surface, finalTitle, {
              workspace: route.workspace,
            });
          },
          {
            toolName: "rename_tab",
            workspace: route.workspace,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
        await lifecycleSeatManifestPublisher({
          surfaceId: route.surface,
          ...(route.stableSurfaceIdentity
            ? { surfaceUuid: route.stableSurfaceIdentity }
            : {}),
          tabName: finalTitle,
        });
        const data = { surface: route.surface, title: finalTitle };
        return okFormatted(formatOk("rename_tab", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_surface",
    "Move or rename one terminal surface.",
    {
      action: z.enum(["move", "rename"]),
      surface: z.string(),
      workspace: z.string().optional(),
      pane: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      index: z.number().int().optional(),
      focus: z.boolean().optional(),
      title: z.string().optional(),
      preserve_prefix: z.boolean().optional().default(false),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const handlerName =
          args.action === "move" ? "move_surface" : "rename_tab";
        const handler = toolHandlersByName.get(handlerName);
        if (!handler) {
          throw new Error(
            `Internal surface adapter unavailable: ${handlerName}`,
          );
        }
        if (args.action === "rename" && !args.title) {
          throw new Error("update_surface action=rename requires title");
        }
        const result = await handler(
          args.action === "move"
            ? {
                surface: args.surface,
                workspace: args.workspace,
                pane: args.pane,
                before: args.before,
                after: args.after,
                index: args.index,
                focus: args.focus,
              }
            : {
                surface: args.surface,
                workspace: args.workspace,
                title: args.title,
                preserve_prefix: args.preserve_prefix,
              },
          {},
        );
        const structured = result.structuredContent ?? {};
        return {
          ...result,
          structuredContent: { ...structured, action: args.action },
        };
      } catch (error) {
        return err(error);
      }
    },
  );

  // 10. close_surface
  server.tool(
    "close_surface",
    'Close one surface, managed agent, or workspace with live-agent guards. scope="agent" stops the agent AND closes its pane, and reports the two halves separately (agent_stopped, surface_closed) so a pane that survives is never reported as closed. The pane close obeys the same live-agent guard as scope="surface": without force:true a still-live agent keeps its pane, and the receipt says so.',
    {
      scope: z
        .enum(["surface", "agent", "workspace"])
        .optional()
        .default("surface"),
      surface: z.string().optional().describe("Target surface ref"),
      agent_id: z.string().optional().describe("Managed agent ID"),
      workspace: z.string().optional().describe("Target workspace ref"),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Close even when the backing agent is still live (not done/error). This never bypasses stable surface identity checks. Without force, a live agent's surface is protected and the response returns the current pane contents instead of closing.",
        ),
    },
    ANNOTATIONS.destructive,
    async (args) => {
      try {
        if (args.scope === "agent") {
          if (!args.agent_id) {
            throw new Error("close_surface scope=agent requires agent_id");
          }
          const handler = toolHandlersByName.get("stop_agent");
          if (!handler)
            throw new Error("Internal agent close adapter unavailable");
          // AIDEV-NOTE (#485): this used to stop the agent and hand back
          // stop_agent's receipt verbatim -- ok:true, state:"done" -- for a
          // tool named close_surface, while the pane stayed open. A lead
          // harvesting panes got success and kept every one of them. Resolve
          // the bound surface BEFORE stopping (the stop can evict the record),
          // stop, then close the pane for real and say which halves happened.
          const boundAgent =
            context.lifecycleRegistry?.get(args.agent_id) ?? null;
          // Capture alias evidence before stop_agent can evict the terminal
          // record. Cleanup receives a stable resolution universe.
          const watchOwnerCandidates = snapshotWatchOwnerCandidates();
          const boundSurface = boundAgent?.surface_id?.trim() || null;
          const boundWorkspace = boundAgent?.workspace_id ?? undefined;
          if (
            !args.force &&
            boundAgent &&
            !TERMINAL_AGENT_STATES.has(boundAgent.state) &&
            agentProcessMayBeAlive(boundAgent)
          ) {
            return err(
              new Error(
                `close_surface scope=agent refused — agent ${args.agent_id} still has live recorded pid ${boundAgent?.pid}`,
              ),
              {
                refused: true,
                scope: "agent",
                agent_id: args.agent_id,
                pid: boundAgent?.pid,
                agent_stopped: false,
                surface: boundSurface,
                surface_closed: false,
                surface_close_skipped: "live_process",
                WARNING: `Live process ${boundAgent?.pid} was not stopped and its surface was not closed; pass force:true for deliberate teardown.`,
              },
            );
          }
          const lifecycleEngine = context.lifecycleSweepEngine;
          if (!lifecycleEngine) {
            throw new Error("Agent lifecycle engine is unavailable");
          }
          const result = await lifecycleEngine.runLifecycleMutation(
            () =>
              handler(
                {
                  agent_id: args.agent_id,
                  force: args.force,
                  [OWNED_AGENT_CLOSE_ON_UNKNOWN_PID]: args.force === true,
                },
                {},
              ),
            { label: "close-agent" },
          );
          const agentStopped = result.isError !== true;
          const rawStopContent = (result.structuredContent ?? {}) as Record<
            string,
            unknown
          >;
          // Drop the stop receipt's own envelope fields; this response owns
          // ok/error, and letting stop_agent's ok:true through was exactly how
          // a half-done close reported success.
          const {
            ok: _stopOk,
            error: _stopError,
            ...stopContent
          } = rawStopContent;
          if (!agentStopped) {
            // The stop itself failed: keep its verbatim ok:false/error and add
            // the independently observed surface half. Stop may have closed
            // the exact UUID route before its process post-condition failed.
            const reason =
              typeof rawStopContent.error === "string"
                ? rawStopContent.error
                : "Agent stop could not establish a safe terminal I/O route";
            const boundUuid = boundAgent?.surface_uuid;
            const topology = boundUuid
              ? await collectSurfaceTopology().catch(() => null)
              : null;
            const surfaceClosed = Boolean(
              boundUuid &&
                topology?.complete === true &&
                !findSurfaceRefByUuid(topology, boundUuid),
            );
            const remedy = surfaceClosed
              ? "The exact surface is gone, but the recorded PID was not proven stopped. Verify that PID before clearing the agent."
              : "Refresh live topology with list_agents, verify the agent's current surface, then retry close_surface with force:true.";
            return err(
              new Error(`close_surface scope=agent refused: ${reason}`),
              {
                ...rawStopContent,
                scope: "agent",
                agent_stopped: false,
                surface: boundSurface,
                surface_closed: surfaceClosed,
                ...(!surfaceClosed
                  ? { surface_close_skipped: "agent_stop_failed" }
                  : {}),
                reason,
                remedy,
                WARNING: remedy,
              },
            );
          }
          let removedOwnedWatches: number;
          try {
            removedOwnedWatches = await removeOwnedWatchesFor(
              boundAgent?.agent_id ?? args.agent_id,
              watchOwnerCandidates,
            );
          } catch (cleanupError) {
            lifecycleScheduleChildReportWatchPrune?.();
            const cleanupReason =
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError);
            let surfaceClosed = false;
            if (boundSurface) {
              try {
                surfaceClosed =
                  (await findSurfaceByRef(boundSurface, boundWorkspace)) ===
                  null;
              } catch {
                surfaceClosed = false;
              }
            }
            return err(
              new Error(
                `close_surface scope=agent stopped ${args.agent_id}, but synchronous owned-watch cleanup failed: ${cleanupReason}`,
              ),
              {
                ...stopContent,
                scope: "agent",
                agent_stopped: true,
                surface: boundSurface,
                surface_closed: surfaceClosed,
                watch_cleanup: "failed",
                watch_cleanup_error: cleanupReason,
              },
            );
          }
          const watchCleanup = {
            watch_cleanup: "completed" as const,
            watches_removed: removedOwnedWatches,
          };
          if (!boundSurface) {
            const data = {
              ...stopContent,
              ...watchCleanup,
              scope: "agent",
              agent_stopped: true,
              surface_closed: false,
              surface_close_skipped: "no_surface_bound",
            };
            return okFormatted(
              `close_surface scope=agent — agent ${args.agent_id} stopped; no surface was bound, so no pane was closed`,
              data,
            );
          }
          // stop_agent owns teardown for a nonterminal agent and may already
          // have closed the exact bound surface. Do not run a second raw close
          // through a now-stale UUID/ref and turn an observed success into a
          // stale-route failure. Terminal agents take the path below because
          // stop_agent is then a no-op and their pane still needs closing.
          let boundSurfaceAfterStop: CmuxSurface | null;
          try {
            boundSurfaceAfterStop = await findSurfaceByRef(
              boundSurface,
              boundWorkspace,
              { throwOnError: true },
            );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            return err(
              new Error(
                `close_surface scope=agent: agent ${args.agent_id} was stopped ` +
                  `but surface ${boundSurface} closure could not be verified — ${reason}`,
              ),
              {
                ...stopContent,
                ...watchCleanup,
                scope: "agent",
                agent_stopped: true,
                surface: boundSurface,
                surface_closed: false,
                surface_close_error: reason,
              },
            );
          }
          if (boundSurfaceAfterStop === null) {
            const data = {
              ...stopContent,
              ...watchCleanup,
              scope: "agent",
              agent_stopped: true,
              surface: boundSurface,
              surface_closed: true,
            };
            return okFormatted(
              `close_surface scope=agent — agent ${args.agent_id} stopped and surface ${boundSurface} closed`,
              data,
            );
          }
          const closeHandler = toolHandlersByName.get("close_surface");
          if (!closeHandler) {
            throw new Error("Internal surface close adapter unavailable");
          }
          const closeResult = await closeHandler(
            {
              scope: "surface",
              surface: boundSurface,
              workspace: boundWorkspace,
              // Preserve the surface path's cross-record guard. The outer
              // process check protects this record; it does not authorize
              // tearing down a surface another nonterminal record owns.
              force: args.force ?? false,
              // A managed agent ID was resolved before stop_agent. This
              // internal-only symbol allows its ref-only close when no stable
              // identity exists; raw callers cannot supply it through MCP.
              [agentScopedSurfaceClose]: true,
            },
            {},
          );
          const closeContent = (closeResult.structuredContent ?? {}) as Record<
            string,
            unknown
          >;
          if (closeResult.isError === true) {
            const reason =
              typeof closeContent.error === "string"
                ? closeContent.error
                : "close failed";
            return err(
              new Error(
                `close_surface scope=agent: agent ${args.agent_id} was stopped but surface ${boundSurface} is still open — ${reason}`,
              ),
              {
                ...stopContent,
                ...watchCleanup,
                scope: "agent",
                agent_stopped: true,
                surface: boundSurface,
                surface_closed: false,
                surface_close_error: reason,
              },
            );
          }
          // Forward the surface path's OBSERVATION of whether the pane is
          // gone; never restate a returned call as a completed close.
          const surfaceClosed = closeContent.surface_closed === true;
          const data = {
            ...stopContent,
            ...watchCleanup,
            scope: "agent",
            agent_stopped: true,
            surface: boundSurface,
            surface_closed: surfaceClosed,
            ...(closeContent.WARNING ? { WARNING: closeContent.WARNING } : {}),
            ...(closeContent.collapse_pane !== undefined
              ? { collapse_pane: closeContent.collapse_pane }
              : {}),
          };
          return okFormatted(
            surfaceClosed
              ? `close_surface scope=agent — agent ${args.agent_id} stopped and surface ${boundSurface} closed`
              : `close_surface scope=agent — agent ${args.agent_id} stopped, but surface ${boundSurface} is STILL LISTED — not closed`,
            data,
          );
        }
        if (args.scope === "workspace") {
          if (!args.workspace) {
            throw new Error("close_surface scope=workspace requires workspace");
          }
          const handler = toolHandlersByName.get("delete_workspace");
          if (!handler) {
            throw new Error("Internal workspace close adapter unavailable");
          }
          const result = await handler(
            { workspace: args.workspace, force: args.force },
            {},
          );
          // Cross-check for the #485 class: unlike scope=agent, this delegate
          // really does perform the action the scope names -- delete_workspace
          // tears the tab and its panes down and surfaces its own failures.
          // State the outcome explicitly rather than leaving the caller to
          // infer it from a bolted-on scope field.
          return {
            ...result,
            structuredContent: {
              ...(result.structuredContent ?? {}),
              scope: "workspace",
              workspace_deleted: result.isError !== true,
            },
          };
        }
        if (!args.surface) {
          throw new Error("close_surface scope=surface requires surface");
        }
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "close_surface",
          (args as Record<PropertyKey, unknown>)[agentScopedSurfaceClose] === true,
        );
        await assertSurfaceMutationAllowed(
          "close_surface",
          route.surface,
          route.workspace,
        );
        await route.assertCurrent();
        let staleRegistryDoneConsolidated:
          | {
              agent_id: string;
              previous_state: AgentState;
              done_signal: string;
            }
          | undefined;
        // Liveness guard: never destroy a pane whose agent is still live unless
        // the caller explicitly forces it. This is the safety net for the
        // "stale list said it was gone but it was actually alive" failure — on
        // refusal we hand back a fresh pane read so the caller assesses the
        // real screen, not a possibly-stale state record.
        if (!args.force) {
          // Fail-safe across records: a surface can transiently back more than
          // one state record (crash-resume collisions before canonicalization).
          // Match the first record that is still LIVE rather than an arbitrary
          // first hit, so a stale terminal record can never let us tear down a
          // surface that another, live record still owns.
          const backingAgent = stateMgr
            .listStates()
            .find(
              (record) =>
                (route.stableSurfaceIdentity && record.surface_uuid
                  ? record.surface_uuid.toLowerCase() ===
                    route.stableSurfaceIdentity.toLowerCase()
                  : record.surface_id === route.surface) &&
                !TERMINAL_AGENT_STATES.has(record.state),
            );
          if (backingAgent) {
            let screenText = "(unable to read pane)";
            let screenParsed: ReturnType<typeof parseScreen> | null = null;
            try {
              const screen = await client.readScreen(route.surface, {
                workspace: route.workspace,
                lines: 40,
              });
              screenText = screen.text;
              screenParsed = parseScreen(screen.text);
            } catch {
              // Best-effort read; refuse regardless so a live agent is never
              // torn down without an explicit force.
            }
            if (
              screenParsed?.done_signal &&
              !screenHasActiveAgentMarker(
                backingAgent.cli,
                screenText,
                screenParsed,
              )
            ) {
              try {
                const marked = stateMgr.updateRecord(backingAgent.agent_id, {
                  task_done_candidate_at: null,
                  task_done_detected_at: new Date().toISOString(),
                  ...(backingAgent.boot_prompt_pending
                    ? { boot_prompt_pending: false }
                    : {}),
                });
                context.lifecycleRegistry?.set(backingAgent.agent_id, marked);
                const done = stateMgr.transition(backingAgent.agent_id, "done");
                context.lifecycleRegistry?.set(backingAgent.agent_id, done);
                staleRegistryDoneConsolidated = {
                  agent_id: backingAgent.agent_id,
                  previous_state: backingAgent.state,
                  done_signal: screenParsed.done_signal,
                };
              } catch {
                // If consolidation fails, keep the fail-safe refusal path.
                appendCloseEvent({
                  event: "close_surface",
                  target: `${route.surface} (agent ${backingAgent.agent_id})`,
                  caller: resolveCloseCaller("close_surface"),
                  force: args.force ?? false,
                  reason: `refused: agent still live (${backingAgent.state}), registry consolidation failed`,
                  refused: true,
                });
                return err(
                  new Error(
                    `Refused to close ${route.surface}: agent ${backingAgent.agent_id} is "${backingAgent.state}" (still live) and registry consolidation failed. Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                  ),
                  {
                    refused: true,
                    surface: route.surface,
                    agent_id: backingAgent.agent_id,
                    state: backingAgent.state,
                    screen: screenText,
                    parsed: screenParsed,
                  },
                );
              }
              const remainingLiveAgent = stateMgr
                .listStates()
                .find(
                  (record) =>
                    (route.stableSurfaceIdentity && record.surface_uuid
                      ? record.surface_uuid.toLowerCase() ===
                        route.stableSurfaceIdentity.toLowerCase()
                      : record.surface_id === route.surface) &&
                    !TERMINAL_AGENT_STATES.has(record.state),
                );
              if (remainingLiveAgent) {
                appendCloseEvent({
                  event: "close_surface",
                  target: `${route.surface} (agent ${remainingLiveAgent.agent_id})`,
                  caller: resolveCloseCaller("close_surface"),
                  force: args.force ?? false,
                  reason: `refused: agent still live (${remainingLiveAgent.state}) after stale registry consolidation`,
                  refused: true,
                });
                return err(
                  new Error(
                    `Refused to close ${route.surface}: agent ${remainingLiveAgent.agent_id} is "${remainingLiveAgent.state}" (still live) after stale registry consolidation. Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                  ),
                  {
                    refused: true,
                    surface: route.surface,
                    agent_id: remainingLiveAgent.agent_id,
                    state: remainingLiveAgent.state,
                    screen: screenText,
                    parsed: screenParsed,
                    stale_registry_done_consolidated:
                      staleRegistryDoneConsolidated,
                  },
                );
              }
            } else {
              appendCloseEvent({
                event: "close_surface",
                target: `${route.surface} (agent ${backingAgent.agent_id})`,
                caller: resolveCloseCaller("close_surface"),
                force: args.force ?? false,
                reason: `refused: agent still live (${backingAgent.state})`,
                refused: true,
              });
              return err(
                new Error(
                  `Refused to close ${route.surface}: agent ${backingAgent.agent_id} is "${backingAgent.state}" (still live). Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                ),
                {
                  refused: true,
                  surface: route.surface,
                  agent_id: backingAgent.agent_id,
                  state: backingAgent.state,
                  screen: screenText,
                  parsed: screenParsed,
                },
              );
            }
          }
        }

        let closePolicy:
          ReturnType<typeof chooseSurfaceClosePolicy> | undefined;

        try {
          const identified = route.workspace
            ? null
            : await client.identify(route.surface);
          const workspace =
            route.workspace ??
            identified?.caller?.workspace_ref ??
            identified?.focused?.workspace_ref;
          if (workspace) {
            const panes = await client.listPanes({ workspace });
            const rawPaneSurfaces = await Promise.all(
              panes.panes.map(async (pane) => {
                const ps = await client.listPaneSurfaces({
                  workspace,
                  pane: pane.ref,
                });
                return ps.pane_ref ? ps : { ...ps, pane_ref: pane.ref };
              }),
            );
            const paneSurfaces = partitionPaneSurfacesByMembership(
              panes.panes,
              rawPaneSurfaces,
              {
                workspace_ref: panes.workspace_ref ?? workspace,
                window_ref: panes.window_ref,
              },
            );
            const workerSurfaceIds = new Set(
              stateMgr.listStates().map((record) => record.surface_id),
            );
            closePolicy = chooseSurfaceClosePolicy(
              panes.panes,
              paneSurfaces,
              workerSurfaceIds,
              route.surface,
            );
          }
        } catch {
          // Layout hints are best-effort only; the close itself must still run.
        }

        const collapsePane = closePolicy?.collapsePane ?? false;
        const observedSurface = await findSurfaceByRef(
          route.surface,
          route.workspace,
        );
        const requestedSurfaceKey =
          route.stableSurfaceIdentity?.toLowerCase() ??
          route.surface.toLowerCase();
        const observedSurfaceUuid = observedSurface?.id?.toLowerCase();
        await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            await client.closeSurface(route.surface, {
              workspace: route.workspace,
              collapsePane,
            });
          },
          {
            toolName: "close_surface",
            workspace: route.workspace,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
        // AIDEV-NOTE (#485): confirm the pane is actually gone rather than
        // inferring it from the CLI returning. One observation, no waiting --
        // the "eventually consistent" theory was withdrawn once the mechanism
        // turned out to be the scope argument, so there is no window to sit
        // through. If cmux still lists the surface, the receipt says so.
        const surfaceStillPresent =
          (await findSurfaceByRef(route.surface, route.workspace)) !== null;
        for (const record of stateMgr.listStates()) {
          // Stable identity wins whenever cmux exposes it. On a ref-only or
          // unavailable observation, preserve the explicit close intent by
          // falling back to the mutable ref instead of treating it as a crash.
          const matchesClosedSurface = record.surface_uuid
            ? record.surface_uuid.toLowerCase() === requestedSurfaceKey ||
              record.surface_uuid.toLowerCase() === observedSurfaceUuid ||
              (observedSurfaceUuid === undefined &&
                record.surface_id === route.surface)
            : observedSurfaceUuid === undefined &&
              record.surface_id === route.surface;
          if (!matchesClosedSurface) {
            continue;
          }
          try {
            const terminal = stateMgr.updateRecord(record.agent_id, {
              user_killed: true,
            });
            context.lifecycleRegistry?.set(record.agent_id, terminal);
            // AIDEV-NOTE (#485 reframe): marking user_killed left the RECORD's
            // state untouched, so list_agents kept reporting a closed agent as
            // "working" after its close was acknowledged -- reported live by
            // golemsClaude, and independent of which scope was used.
            // An acknowledged close means this agent is not running any more;
            // say so in the same breath as accepting the close.
            if (!TERMINAL_AGENT_STATES.has(terminal.state)) {
              const stopped = stateMgr.transition(record.agent_id, "done");
              context.lifecycleRegistry?.set(record.agent_id, stopped);
            }
            pruneChildReportWatchesFor(record.agent_id);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === `Agent not found: ${record.agent_id}`
            ) {
              continue;
            }
            throw error;
          }
        }
        appendCloseEvent({
          event: "close_surface",
          target: route.surface,
          caller: resolveCloseCaller("close_surface"),
          force: args.force ?? false,
          reason: staleRegistryDoneConsolidated
            ? `closed after stale-registry done consolidation (agent ${staleRegistryDoneConsolidated.agent_id})`
            : null,
          refused: false,
        });
        const data = {
          surface: route.surface,
          pane: closePolicy?.pane ?? undefined,
          collapse_pane: collapsePane,
          surface_closed: !surfaceStillPresent,
          stale_registry_done_consolidated: staleRegistryDoneConsolidated,
          ...(surfaceStillPresent
            ? {
                WARNING: `cmux accepted the close but ${route.surface} is STILL listed. Do not relay this as closed.`,
              }
            : {}),
        };
        return okFormatted(
          surfaceStillPresent
            ? `close_surface accepted — ${route.surface} is still listed; NOT closed`
            : formatOk("close_surface", data),
          data,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  // 12. dispatch_to_agent — metacommlayer WRITE channel (sterile dispatch; send_input fallback)
  // AIDEV-NOTE: B5 (2026-06-05 incident) — the wake must NOT depend on agent
  // lifecycle state. A poisoned (error) registry record used to silently kill
  // the send_input fallback (INTERACTIVE_STATES gate in sendToAgent) and GO
  // messages sat unread. The nudge below types a one-line inbox pointer
  // directly into the agent's surface, regardless of registry state.
  server.tool(
    "dispatch_to_agent",
    "Append a task to an agent's inbox FILE (the deterministic write channel). The agent acts on it via a persistent native Monitor on its inbox. The durable envelope automatically carries reply_to=<resolved sender agent_id> plus optional via:<observed surface_ref> and observed_at metadata; reply_to is the only routing address, via is a stale-able hint, and tab names never enter the contract. The only connector-authored composer wake is `[inbox] <msg_id> — reply_to: <sender_agent_id>[ via:<surface_ref> observed_at:<stamp>] — read <path>`. With nudge='auto' (default), an idle live agent is woken once on enqueue; a stale/absent monitor also gets the same best-effort pointer independent of lifecycle state. A never-armed reader is successful when the verified nudge path submits or queues the pointer; otherwise the durable append returns a non-retryable error. A previously armed but stale reader returns explicit degraded success. Address to:'orc' to flag the orchestrator (own-tag triage). Channel is EPHEMERAL plumbing — set persist:true only for decisions that should be brain_store'd.",
    {
      agent_id: z
        .string()
        .describe(
          "Recipient agent id (its inbox is ~/.cmux/agents/<id>/inbox.jsonl)",
        ),
      task: z.string().describe("The dispatch payload / instruction"),
      from: z.string().optional().default("orc").describe("Sender id"),
      tag: z
        .string()
        .optional()
        .default("dispatch")
        .describe("Routing/semantics tag"),
      persist: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Opt-in: mark this message as a candidate for BrainLayer ingestion",
        ),
      nudge: z
        .enum(["auto", "never"])
        .optional()
        .default("auto")
        .describe(
          "auto: wake an idle live agent once on enqueue; when the inbox-monitor heartbeat is stale/absent, best-effort type the same exact inbox pointer into its surface (bypasses agent-state gates — works even when registry state is poisoned). never: file append only.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const callerAgent = resolveCurrentCallerAgent();
        const replyTo = callerAgent?.agent_id ?? args.from.trim();
        if (!replyTo || /[\r\n]/.test(replyTo)) {
          throw new Error(
            "dispatch_to_agent requires a one-line sender agent_id for reply_to",
          );
        }
        const msg = dispatch(
          args.agent_id,
          {
            from: args.from,
            reply_to: replyTo,
            ...(callerAgent ? { via: callerAgent.surface_id } : {}),
            to: args.agent_id,
            tag: args.tag,
            task: args.task,
            persist: args.persist,
          },
          inboxOpts,
        );
        const monitor_state = inboxMonitorState(
          args.agent_id,
          INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS,
          inboxOpts,
        );
        const monitor_alive = monitor_state === "alive";
        const pending = pendingDispatches(
          args.agent_id,
          AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
          inboxOpts,
        );
        const nudge: {
          attempted: boolean;
          sent: boolean;
          reason: string;
          error_code?: string;
          delivery?: "submitted" | "queued" | "pending_verify";
          delivery_id?: string;
        } = { attempted: false, sent: false, reason: "" };
        const acceptedRecord =
          context.lifecycleRegistry?.get(args.agent_id) ?? null;
        const wakeIdleAgent = monitor_alive && acceptedRecord?.state === "idle";
        if (args.nudge === "never") {
          nudge.reason = "nudge disabled by caller";
        } else if (monitor_alive && !wakeIdleAgent) {
          nudge.reason = "monitor heartbeat fresh — Monitor will deliver";
        } else {
          // State-independent surface lookup: ANY registry record (including
          // error/done) still carries the surface ref. allow_busy bypasses the
          // INTERACTIVE_STATES gate, but the guarded relay path keeps the
          // stale-surface resync + recycled-occupant identity checks so the
          // pointer can never land in a foreign agent's pane.
          await refreshManagedMetadataBestEffort(args.agent_id);
          let record = context.lifecycleRegistry?.get(args.agent_id) ?? null;
          if (!record) {
            try {
              await lifecycleEnsureRegistered?.();
              record = context.lifecycleRegistry?.get(args.agent_id) ?? null;
            } catch {
              // Best-effort only: dispatch has already appended the durable inbox message.
            }
          }
          if (!record || !lifecycleAgentInputDeliverer) {
            nudge.reason = record
              ? "agent lifecycle relay unavailable — message waits in the inbox file"
              : "agent not in lifecycle registry; no surface to nudge — message waits in the inbox file";
          } else {
            nudge.attempted = true;
            try {
              const pointer = formatInboxPing(
                msg,
                inboxPath(args.agent_id, inboxOpts),
              );
              if (record.state === "working" && context.lifecycleSweepEngine) {
                const queued = context.lifecycleSweepEngine.queueDelivery({
                  agent_id: args.agent_id,
                  text: pointer,
                  press_enter: true,
                  source_event: "dispatch_nudge",
                });
                nudge.delivery = "queued";
                nudge.delivery_id = queued.delivery_id;
              } else {
                const deliveryId = context.lifecycleSweepEngine
                  ? randomUUID()
                  : undefined;
                const delivered = await lifecycleAgentInputDeliverer({
                  agent_id: args.agent_id,
                  text: pointer,
                  press_enter: true,
                  allow_busy: true,
                  source_event: "dispatch_nudge",
                  delivery_id: deliveryId,
                });
                if (
                  delivered.delivery !== "submitted" &&
                  delivered.delivery !== "queued"
                ) {
                  throw new Error(
                    "inbox nudge produced no evidence-backed delivery state",
                  );
                }
                nudge.delivery = delivered.delivery;
                if (context.lifecycleSweepEngine && deliveryId) {
                  const receipt =
                    delivered.delivery === "queued"
                      ? context.lifecycleSweepEngine.acceptComposerQueue({
                          delivery_id: deliveryId,
                          agent_id: args.agent_id,
                          text: pointer,
                          press_enter: true,
                          source_event: "dispatch_nudge",
                          retry_count: delivered.retry_count,
                          rpc_methods: delivered.rpc_methods,
                          typed: delivered.typed,
                          submit_dispatched: delivered.submit_dispatched,
                        })
                      : context.lifecycleSweepEngine.resolveDelivery({
                          delivery_id: deliveryId,
                          agent_id: args.agent_id,
                          text: pointer,
                          press_enter: true,
                          source_event: "dispatch_nudge",
                          delivery_state: "submitted",
                          terminal: true,
                          retry_count: delivered.retry_count,
                          rpc_methods: delivered.rpc_methods,
                          typed: delivered.typed,
                          submit_dispatched: delivered.submit_dispatched,
                          submit_verified: delivered.submit_verified,
                          error: null,
                        });
                  nudge.delivery_id = receipt.delivery_id;
                }
              }
              nudge.sent = true;
              nudge.reason = wakeIdleAgent
                ? `idle live agent — typed inbox pointer into ${record.surface_id}`
                : record.state === "working"
                  ? `busy agent — queued inbox pointer for verified lifecycle delivery to ${record.surface_id}`
                  : `heartbeat stale/absent — typed inbox pointer into ${record.surface_id} (state: ${record.state})`;
            } catch (e) {
              if (e instanceof AmbiguousBootRecoveryReturnError && e.receipt?.delivery_id) {
                nudge.delivery = "pending_verify";
                nudge.delivery_id = e.receipt.delivery_id;
                nudge.reason = e.receipt.WARNING ?? e.message;
              } else {
                if (e instanceof DeliverySafetyGateError) {
                  nudge.error_code = e.error_code;
                }
                nudge.reason = `nudge failed (dispatch still durable in inbox file): ${
                  e instanceof Error ? e.message : String(e)
                }`;
              }
            }
          }
        }
        await refreshManagedMetadataBestEffort(args.agent_id);
        const record = context.lifecycleRegistry?.get(args.agent_id) ?? null;
        const health = record
          ? await evaluateServerAgentHealth(record, {
              monitor_alive,
              stale_count: pending.length,
            })
          : undefined;
        const delivery_status =
          monitor_state === "alive"
            ? "monitor_live"
            : monitor_state === "stale"
              ? "queued_monitor_stale"
              : "queued_monitor_never_armed";
        const receipt = {
          dispatched: msg,
          inbox: inboxPath(args.agent_id, inboxOpts),
          durable: true,
          delivery_status,
          monitor_alive,
          monitor_state,
          health,
          nudge,
        };
        const nudgeAccepted =
          nudge.sent &&
          (nudge.delivery === "submitted" || nudge.delivery === "queued");
        if (monitor_state === "never-armed" && !nudgeAccepted) {
          return err(
            "inbox message was queued, but the recipient has never proved that its inbox monitor is armed",
            {
              error_code: "inbox_monitor_never_armed",
              retryable: false,
              ...receipt,
            },
          );
        }
        return ok(receipt);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 13. inbox_check — orc-side liveness/delivery view of an agent's write channel
  server.tool(
    "inbox_check",
    "Inspect an agent's inbox channel: undelivered (un-acked) messages, monitor liveness (heartbeat freshness), and stale dispatches past the ACK-timeout. A non-empty 'pending' for a live-looking agent means its monitor is wedged → fall back to send_input. Read-only.",
    {
      agent_id: z.string().describe("Agent id to inspect"),
      ack_timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .default(AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS)
        .describe("Treat un-acked dispatches older than this as stale/wedged"),
      heartbeat_max_age_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .default(AGENT_HEALTH_MONITOR_MAX_AGE_MS)
        .describe(
          "Monitor is considered alive if it heartbeated within this window",
        ),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        const undelivered = replayUndelivered(args.agent_id, inboxOpts);
        const pending = pendingDispatches(
          args.agent_id,
          args.ack_timeout_ms,
          inboxOpts,
        );
        const alive = monitorAlive(
          args.agent_id,
          args.heartbeat_max_age_ms,
          inboxOpts,
        );
        await refreshManagedMetadataBestEffort(args.agent_id);
        const record = context.lifecycleRegistry?.get(args.agent_id) ?? null;
        const health = record
          ? await evaluateServerAgentHealth(record, {
              monitor_alive: alive,
              stale_count: pending.length,
            })
          : undefined;
        return ok({
          agent_id: args.agent_id,
          monitor_alive: alive,
          health,
          undelivered_count: undelivered.length,
          undelivered,
          stale_count: pending.length,
          stale: pending,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // --- Agent Lifecycle Tools (Phase 5) ---

  if (!skipAgentLifecycle) {
    let registry: AgentRegistry | null = null;
    let lastLifecycleSurfaces: CmuxSurface[] | null = null;
    let lastLifecycleSurfaceObserverEpoch: string | null = null;
    const readLifecycleSurfaces = async (onRpc?: TopologyRpcObserver) => {
      const timedRpc = async <T>(method: string, call: () => Promise<T>): Promise<T> => {
        if (!onRpc) return call();
        const startedAt = performance.now();
        try { return await call(); }
        finally { onRpc?.(method, Math.max(0, performance.now() - startedAt)); }
      };
      const workspaces = await listAllWorkspaces(onRpc);
      const workspaceList = requireSurfaceEnumerationArray<CmuxWorkspace>(
        workspaces.workspaces,
        "workspaces.workspaces",
      );
      const panesByWorkspace = await Promise.all(
        workspaceList.map(async (ws) => ({
          ref: ws.ref,
          panes: await timedRpc("listPanes", () => client.listPanes({ workspace: ws.ref })),
        })),
      );
      const surfaceGroupsByWorkspace = await Promise.all(
        panesByWorkspace.map(async ({ ref, panes }) => {
          const paneList = requireSurfaceEnumerationArray<CmuxPane>(
            panes.panes,
            `panes.panes for ${ref}`,
          );
          const rawGroups = await Promise.all(
            paneList.map((p) =>
              timedRpc("listPaneSurfaces", () =>
                client.listPaneSurfaces({ workspace: ref, pane: p.ref })),
            ),
          );
          const groups = partitionPaneSurfacesByMembership(
            paneList,
            rawGroups,
            {
              workspace_ref: panes.workspace_ref ?? ref,
              window_ref: panes.window_ref,
            },
          );
          if (!isPaneSurfaceEnumerationComplete(paneList, groups)) {
            throw new SurfaceEnumerationError(
              `Incomplete cmux surface enumeration for ${ref}`,
            );
          }
          return groups;
        }),
      );
      const surfaceGroups = surfaceGroupsByWorkspace.flat();
      return enrichSurfaceIdsFromPanes(panesByWorkspace, surfaceGroups);
    };
    const surfaceProvider = async (onRpc?: TopologyRpcObserver) => {
      const observerEpoch = context.surfaceObserverEpoch;
      if (
        lastLifecycleSurfaces &&
        (!observerEpoch || lastLifecycleSurfaceObserverEpoch !== observerEpoch)
      ) {
        lastLifecycleSurfaces = null;
        lastLifecycleSurfaceObserverEpoch = null;
      }
      try {
        const surfaces = await readLifecycleSurfaces(onRpc);
        const completedObserverEpoch = context.surfaceObserverEpoch;
        if (completedObserverEpoch !== observerEpoch) {
          lastLifecycleSurfaces = null;
          lastLifecycleSurfaceObserverEpoch = null;
          throw new SurfaceEnumerationError(
            `cmux surface observer changed during enumeration (${observerEpoch ?? "unknown"} -> ${completedObserverEpoch ?? "unknown"})`,
          );
        }
        if (observerEpoch) {
          lastLifecycleSurfaces = surfaces;
          lastLifecycleSurfaceObserverEpoch = observerEpoch;
        } else {
          lastLifecycleSurfaces = null;
          lastLifecycleSurfaceObserverEpoch = null;
        }
        return surfaces;
      } catch (error) {
        if (!isSurfaceEnumerationError(error)) {
          throw error;
        }
        const completedObserverEpoch = context.surfaceObserverEpoch;
        if (completedObserverEpoch !== observerEpoch) {
          lastLifecycleSurfaces = null;
          lastLifecycleSurfaceObserverEpoch = null;
          throw error;
        }
        if (
          observerEpoch &&
          lastLifecycleSurfaces &&
          lastLifecycleSurfaceObserverEpoch === observerEpoch
        ) {
          return lastLifecycleSurfaces;
        }
        if (!registry || registry.list().length === 0) {
          return [];
        }
        throw error;
      }
    };
    registry =
      context.lifecycleRegistry ??
      new AgentRegistry(stateMgr, surfaceProvider, {
        observerIdProvider: () => context.surfaceObserverId,
        observerEpochProvider: () => context.surfaceObserverEpoch,
        explicitRoleProvider: explicitRoleForDiscoveredSurface,
      });
    context.lifecycleRegistry = registry;
    const discovery = new AgentDiscovery({
      observerIdProvider: () => context.surfaceObserverEpoch,
      listSurfaces: surfaceProvider,
      managedIdentityProvider: (surface) =>
        registry?.managedIdentityForSurface(surface) ?? null,
      readScreen: (surface, opts) => client.readScreen(surface, opts),
    });
    // AIDEV-NOTE (F1): from here on, every consumer that used to read
    // `agent.state` as truth resolves the LIVE state through this probe. It
    // reads the last screen scan only -- no I/O on the caller's path -- and
    // returns null when there is no fresh evidence, which degrades to the
    // registry record with honest `registry` provenance.
    type ScreenObservationRow = {
      surface_id: string;
      surface_uuid?: string | null;
      parsed_status?: string | null;
      control_state?: string | null;
      cli?: string | null;
      errors?: string[] | null;
      read_error?: unknown;
    };
    // Same binding rule list_agents uses: a UUID pair, or a surface_id match
    // ONLY when neither side has a UUID and this observer owns the seat.
    // A looser match would let an unrelated pane's screen decide an agent's
    // state, which is a worse lie than the stale record it replaces.
    const rowBindsToRecord = (
      agent: AgentRecord,
      row: ScreenObservationRow,
    ): boolean => {
      const uuidKey = (value: string | null | undefined): string | null =>
        value?.trim().toLowerCase() || null;
      const agentUuid = uuidKey(agent.surface_uuid);
      const surfaceUuid = uuidKey(row.surface_uuid);
      return agentUuid && surfaceUuid
        ? agentUuid === surfaceUuid
        : Boolean(
            !agentUuid &&
            !surfaceUuid &&
            agent.surface_observer_id &&
            agent.surface_observer_id === registry.getObserverId() &&
            row.surface_id === agent.surface_id,
          );
    };
    const observationFromRow = (
      row: ScreenObservationRow | null | undefined,
    ): {
      status: string | null;
      agent_type: string | null;
      control_state: string | null;
      errors: string[] | null;
    } | null => {
      if (!row || row.read_error) return null;
      return {
        status: row.parsed_status ?? null,
        agent_type: row.cli === "kiro" ? "unknown" : (row.cli ?? null),
        control_state: row.control_state ?? null,
        errors: row.errors ?? null,
      };
    };
    const screenObservationForRecord = (
      agent: AgentRecord,
    ): {
      status: string | null;
      agent_type: string | null;
      control_state: string | null;
      errors: string[] | null;
    } | null => {
      const cached = discovery.cachedScan();
      if (!cached) return null;
      return observationFromRow(
        cached.rows.find((row) => rowBindsToRecord(agent, row)),
      );
    };
    liveAgentStateProbe.current = (agent) =>
      resolveLiveAgentState(agent, screenObservationForRecord(agent));
    /**
     * AIDEV-NOTE (F1b round 2): the FORCING probe. `cachedScan()` is
     * deliberately evidence-free once it is 2000ms old, and nothing on the
     * `wait_for` path refreshes it -- so a wait that only read the cache
     * degraded straight back to the poisoned record. This reads ONE surface on
     * demand (`scanTarget`, not a fleet `scan`), applies the same binding rule,
     * and returns null on a failed read or an unbound surface: no evidence,
     * which leaves the record unchallenged rather than inventing a state.
     */
    const freshLiveAgentStateProbe = async (
      agent: AgentRecord,
    ): Promise<LiveAgentState | null> => {
      try {
        const row = await discovery.scanTarget({
          surface_id: agent.surface_id,
          surface_uuid: agent.surface_uuid ?? null,
        });
        if (!row || !rowBindsToRecord(agent, row)) return null;
        const observation = observationFromRow(row);
        return observation ? resolveLiveAgentState(agent, observation) : null;
      } catch {
        // A failed or racing scan is not evidence of anything.
        return null;
      }
    };
    const lifecycleStartTimeoutMs = resolveLifecycleStartTimeoutMs();
    /**
     * #529: this used to `await context.lifecycleStartPromise` with no bound.
     * When the daemon died before ready that promise never settled, so every
     * tool gated on it deadlocked in silence. The wait is bounded now, and a
     * timeout is COUNTED so the new bound is not itself invisible. It must NOT
     * set lifecycleStartError: init may still be in flight and succeed.
     */
    const awaitLifecycleStart = async (): Promise<void> => {
      if (context.lifecycleStartPromise) {
        try {
          await awaitBoundedLifecycleStart(
            context.lifecycleStartPromise,
            lifecycleStartTimeoutMs,
          );
        } catch (error) {
          if (error instanceof LifecycleStartTimeoutError) {
            context.lifecycleStartTimeouts += 1;
            context.lifecycleStartLastTimeoutAt = new Date().toISOString();
          }
          throw error;
        }
      }
      if (context.lifecycleStartError) {
        throw context.lifecycleStartError;
      }
    };
    const watchRegistryPath =
      opts?.watchRegistryPath ?? join(context.stateDir, "watch-specs.json");
    const testProcess =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test";
    // CX-3b S10a: AgentEngine wiring lives in src/mcp/tools/agent.ts.
    const engine = createLifecycleAgentEngine({
      appendCloseEvent,
      assertSurfaceMutationAllowed,
      assertWorkspaceMutationAllowed,
      client,
      collectServerRoleSurfaceIds,
      context,
      disableSpawnPreflight,
      freshLiveAgentStateProbe,
      inboxOpts,
      launchShellRecoveryBySurface,
      listAllWorkspaces,
      opts,
      originalLaunchCommandsBySurface,
      registry,
      seatRegistry,
      sendLauncherCommandToSurface,
      spawnPreflight,
      stateMgr,
      surfaceProvider,
      testProcess,
      watchRegistryPath,
      withSurfaceWrite,
      // Live getter: lifecycleAgentInputDeliverer is assigned after this call.
      get lifecycleAgentInputDeliverer() {
        return lifecycleAgentInputDeliverer;
      },
    });
    lifecycleSeatManifestPublisher = async (input) => {
      try {
        const existing = input.agentId
          ? engine.getAgentState(input.agentId)
          : (registry
              .list()
              .find((record) =>
                input.surfaceUuid
                  ? record.surface_uuid?.toLowerCase() ===
                    input.surfaceUuid.toLowerCase()
                  : record.surface_id === input.surfaceId,
              ) ?? null);
        if (!existing) return;

        const updated =
          input.tabName !== undefined || input.model !== undefined
            ? stateMgr.updateRecord(existing.agent_id, {
                ...(input.tabName !== undefined
                  ? { tab_name: input.tabName }
                  : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
              })
            : existing;
        if (updated !== existing) {
          registry.set(updated.agent_id, updated);
        }

        const tabName =
          updated.tab_name ??
          `${updated.launcher_name ?? launcherNameForCli(updated.repo, updated.cli)} [${updated.surface_id}]`;
        await seatManifestWriter({
          surface_id: updated.surface_id,
          ...(updated.surface_uuid
            ? { surface_uuid: updated.surface_uuid }
            : {}),
          agent_id: updated.agent_id,
          tab_name: tabName,
          session_name: updated.cli_session_id,
          model: updated.model,
          permission_mode:
            updated.cli === "kiro" ? "default" : resolveSpawnPermissionMode(),
          cwd: updated.launch_cwd ?? defaultRepoCheckoutPath(updated.repo),
          repo: updated.repo,
          cli: updated.cli,
          updated_at: seatManifestNow(),
        });
      } catch (error) {
        console.error(
          "[cmuxlayer] seat manifest publish failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    context.lifecycleSweepEngine = engine;
    toolDeps.engine = engine;
    toolDeps.registry = registry;
    lifecycleHealthEngine = engine;
    lifecycleScheduleChildReportWatchPrune = () =>
      engine.scheduleClosedChildReportWatchPrune();
    // F1: closure, harvestability and the health report all resolve state
    // through the same live probe the caller/delivery paths use.
    engine.setLiveStateResolver(liveAgentStateProbe.current);
    engine.setFreshLiveStateProbe(freshLiveAgentStateProbe);

    server.tool(
      "arm_watch",
      "Arm a declared WatchSpec without blocking. Targets are validated immediately; returns the read-only liveness source used by the engine.",
      WatchSpecArgsSchema,
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          await awaitLifecycleStart();
          const publicSpec = { ...(args as WatchSpec) };
          delete (publicSpec as WatchSpec & { provenance?: unknown })
            .provenance;
          if (
            publicSpec.change === "content" &&
            [...stateMgr.listStates(), ...registry.list()].some(
              (agent) => agent.collab_path &&
                resolve(agent.collab_path) === resolve(publicSpec.target),
            )
          ) {
            throw new WatchArmError(
              "shared_collab_watch_target",
              publicSpec.target,
              "A shared collab_path cannot be a content-change pane watch; use a marker watch for a specific handoff",
            );
          }
          const watch = await engine.armWatch({
            ...publicSpec,
            provenance: "public",
          });
          return ok({ watch });
        } catch (error) {
          if (error instanceof WatchArmError) {
            return err(error, {
              error_code: error.code,
              target: error.target,
            });
          }
          return err(error);
        }
      },
    );

    lifecycleEnsureRegistered = async () => {
      await awaitLifecycleStart();
      await engine.runLifecycleMutation(
        () =>
          registry.listMerged(discovery, { force: true }).then(() => undefined),
        { label: "lifecycle-ensure-registered" },
      );
    };
    lifecycleRefreshManagedMetadata = async (agentId?: string) => {
      await awaitLifecycleStart();
      await engine.runLifecycleMutation(
        () =>
          registry
            .refreshManagedSurfaceMetadata(discovery, {
              agentId,
              force: true,
            })
            .then(() => undefined),
        { label: "lifecycle-refresh-managed-metadata" },
      );
    };

    const resolveSpawnRecord = (
      agentId: string,
      surfaceId: string,
    ): AgentRecord | null => {
      const diskDirect = stateMgr.readState(agentId);
      if (diskDirect) {
        registry.set(agentId, diskDirect);
        return diskDirect;
      }

      const bySurface =
        stateMgr.listStates().find((agent) => agent.surface_id === surfaceId) ??
        registry.list().find((agent) => agent.surface_id === surfaceId) ??
        null;
      if (bySurface) {
        registry.set(agentId, bySurface);
        return bySurface;
      }

      const registryDirect = registry.get(agentId);
      if (registryDirect) {
        registry.set(agentId, registryDirect);
      }
      return registryDirect;
    };

    const resolveManagedDeliveryRoute = async (
      agentId: string,
    ): Promise<{ surface: string; workspace?: string }> => {
      const route = await engine.resolveAgentIoRoute(agentId);
      return {
        surface: route.surface_id,
        workspace: route.workspace_id ?? undefined,
      };
    };

    const relaunchSpawnAgentAfterUpdate = async (opts: {
      agentId: string;
      surface: string;
      workspace?: string;
      model?: string | null;
      mcpEnv?: string;
      originalCommand?: string;
      timeout_ms?: number;
    }): Promise<void> => {
      const record = resolveSpawnRecord(opts.agentId, opts.surface);
      if (!record) {
        throw new Error(
          `Cannot relaunch ${opts.agentId} after CLI update: agent record not found`,
        );
      }

      const launchCwd = record.launch_cwd?.trim() || undefined;
      const launcherName = record.launcher_name?.trim() || undefined;
      const command =
        opts.originalCommand ??
        buildLaunchCommand(
          record.cli,
          record.repo,
          record.model ?? opts.model ?? undefined,
          launcherName,
          {
            cwd: launchCwd,
            envPrefix: opts.mcpEnv,
            allowModelOverride:
              record.cli === "codex"
                ? Boolean(
                    record.model?.trim() &&
                    record.model.trim().toLowerCase() !== "codex",
                  )
                : process.env.REPOGOLEM_ALLOW_MODEL === "1",
          },
        );
      const route = await resolveManagedDeliveryRoute(record.agent_id);
      const assertSurfaceBindingCurrent = async (): Promise<void> => {
        const current = await resolveManagedDeliveryRoute(record.agent_id);
        if (
          current.surface !== route.surface ||
          (current.workspace ?? null) !== (route.workspace ?? null)
        ) {
          throw new Error(
            `Agent "${record.agent_id}" surface route changed during ` +
              `post-update relaunch; refusing terminal mutation.`,
          );
        }
      };
      await sendLauncherCommandToSurface({
        surface: route.surface,
        workspace: route.workspace,
        command: withRaisedNofileSoftLimit(command),
        timeout_ms: opts.timeout_ms,
        relaunch: true,
        assertSurfaceBindingCurrent,
      });
    };

    const canonicalizeSpawnResult = <
      T extends {
        agent_id: string;
        surface_id: string;
      },
    >(
      result: T,
    ): AgentRecord | null => {
      const record = resolveSpawnRecord(result.agent_id, result.surface_id);
      if (record) {
        result.agent_id = record.agent_id;
      }
      return record;
    };

    const captureSpawnSessionBestEffort = async <
      T extends {
        agent_id: string;
        surface_id: string;
      },
    >(
      result: T,
    ): Promise<AgentRecord | null> => {
      try {
        await engine.captureBootSessionId(result.agent_id);
      } catch {
        // Keep spawn/boot error handling focused on the original outcome.
      }
      return canonicalizeSpawnResult(result);
    };

    const prepareSpawnWorktree = async (
      repo: string,
      worktree: boolean | string | object | undefined,
      mcpProfile: McpProfile | undefined,
    ) => {
      if (!worktree) {
        return {
          prepared: undefined,
          mcpProfileLabel: undefined,
          mcpEnv: undefined,
        };
      }

      const profile = mcpProfile ?? "inherit";
      // Registry-optional (issue #392): a registered repo keeps its registry
      // path; otherwise fall back to the same search spawn uses.
      const repoRoot = disableSpawnPreflight
        ? resolve(opts?.worktreeHomeDir ?? join(homedir(), "Gits"), repo)
        : (resolveRepoRootFromLauncherRegistryOrNull(repo) ??
          resolveRepoRootWithoutRegistry(repo));
      const prepared = await prepareWorktree({
        repo,
        repoRoot,
        worktree: worktree as Parameters<typeof prepareWorktree>[0]["worktree"],
        exec: opts?.worktreeExec,
        homeGitsDir: opts?.worktreeHomeDir,
      });
      return {
        prepared,
        repoRoot,
        mcpProfileLabel: typeof profile === "string" ? profile : "custom",
        mcpEnv: formatMcpProfileEnv(profile),
      };
    };

    const deliverAgentInput = async (args: {
      agent_id: string;
      text: string;
      press_enter: boolean;
      allow_busy?: boolean;
      source_event: DeliveryEventType;
      delivery_id?: string;
      timings?: DeliveryPhaseTimings;
    }) => {
      const routeStartedAt = Date.now();
      const enumerateStartedAt = args.timings?.enumerate ?? 0;
      const onTopologyRpc: TopologyRpcObserver = (_method, elapsedMs) => {
        if (!args.timings) return;
        args.timings.enumerate_topology_rpc += elapsedMs;
        args.timings.enumerate_rpc_count += 1;
      };
      const onTargetRpc: TopologyRpcObserver = (method, elapsedMs) => {
        if (!args.timings) return;
        if (method === "readScreen") {
          args.timings.enumerate_screen_read += elapsedMs;
          args.timings.enumerate_rpc_count += 1;
        } else if (method === "listSurfaces") {
          // Aggregate target-list time includes the topology RPCs below it.
          args.timings.enumerate_scan_target_list += elapsedMs;
        } else {
          onTopologyRpc(method, elapsedMs);
        }
      };
      // Delivery already proves the UUID route from fresh topology and scans the
      // one target TUI before mutation. A fleet-wide managed-metadata refresh
      // here only queued the first send behind the startup sweep's lifecycle
      // lock, adding 11-15 seconds without strengthening the route proof.
      let route = await timeDeliveryPhase(args.timings, "enumerate", () =>
        engine.resolveAgentIoRoute(args.agent_id, undefined, onTopologyRpc),
      );
      const requiresMutableRefGuards = !route.surface_uuid;
      // Guard against stale surface refs before sending. Registry refs drift
      // after a crash/respawn (a pane closes or is recycled), so a cached
      // surface_id can point at a dead surface. Check the resolved ref against
      // the live surface list and, if it is positively gone, resync once and
      // re-resolve; if it still cannot be confirmed live, refuse the relay
      // rather than misdelivering keystrokes. Fail OPEN when the surface list
      // is unavailable (empty) so a transient listing failure never blocks a
      // healthy relay.
      const liveSurfaceRefs = async (): Promise<Set<string> | null> => {
        try {
          // A UUID-less route is safe only if this check is newer than the
          // resolver that supplied its mutable ref.
          invalidateSurfaceTopologyCallScope(client as object);
          const surfaces = await timeDeliveryPhase(
            args.timings,
            "enumerate",
            () => surfaceProvider(onTopologyRpc),
          );
          return surfaces.length > 0
            ? new Set(surfaces.map((surface) => surface.ref))
            : null;
        } catch {
          return null;
        }
      };
      const isPositivelyStale = (
        refs: Set<string> | null,
        surfaceId: string,
      ): boolean => refs !== null && !refs.has(surfaceId);
      if (
        requiresMutableRefGuards &&
        isPositivelyStale(await liveSurfaceRefs(), route.surface_id)
      ) {
        discovery.invalidate();
        await timeDeliveryPhase(args.timings, "enumerate", () =>
          registry.listMerged(discovery, { force: true }),
        );
        invalidateSurfaceTopologyCallScope(client as object);
        // Re-resolve after the resync. The agent may have been evicted (its
        // surface vanished) or still point at a dead surface — either way,
        // refuse with a clear stale-ref error instead of misdelivering.
        let reresolved: typeof route | null;
        try {
          reresolved = await timeDeliveryPhase(args.timings, "enumerate", () =>
            engine.resolveAgentIoRoute(args.agent_id, undefined, onTopologyRpc),
          );
        } catch {
          reresolved = null;
        }
        if (
          !reresolved ||
          isPositivelyStale(await liveSurfaceRefs(), reresolved.surface_id)
        ) {
          throw new Error(
            `Agent "${args.agent_id}" no longer maps to a live surface ` +
              `(stale surface ref); its pane likely closed or was recycled. ` +
              `Call list_agents for a refreshed live view and retry.`,
          );
        }
        route = reresolved;
      }
      // Agent-path delivery requires a live agent TUI. A crashed CLI leaves its
      // terminal surface alive at a bare shell; typing a routed message there
      // executes fleet text as shell input. Target-scoped discovery validates
      // only this route's stable UUID/ref binding around read-screen, so
      // unrelated pane churn cannot block a healthy relay. Raw
      // surface/command/key modes bypass this helper and remain available for
      // deliberate recovery.
      const assertAgentRouteHasTui = async (candidateRoute: typeof route) => {
        const freshOccupant = await timeDeliveryPhase(
          args.timings,
          "enumerate",
          () => discovery.scanTarget(candidateRoute, onTargetRpc),
        );
        if (
          freshOccupant &&
          !freshOccupant.read_error &&
          freshOccupant.control_state === "shell"
        ) {
          throw new Error(
            `Agent "${args.agent_id}" exited / no agent currently initiated on ` +
              `surface ${candidateRoute.surface_id} (control_state=${freshOccupant.control_state}, ` +
              `agent_type=${freshOccupant.cli}); refusing routed agent delivery. ` +
              `Use send_to mode=surface, command, or key for deliberate raw terminal input.`,
          );
        }
        return freshOccupant;
      };
      const freshOccupant = await assertAgentRouteHasTui(route);

      // Identity guard: a live surface ref may have been RECYCLED — a crashed
      // agent's pane reused by a different agent. If the live surface now hosts
      // a known CLI that differs from this agent's recorded CLI, refuse rather
      // than delivering to the new occupant. Fresh shell evidence was already
      // refused above; other unknown/unreadable evidence remains inconclusive.
      const expectedCli = engine.getAgentState(args.agent_id)?.cli;
      if (requiresMutableRefGuards && expectedCli) {
        const cachedOccupant = freshOccupant;
        const isForeign = (occ: typeof cachedOccupant): boolean =>
          Boolean(
            occ &&
            occ.has_agent &&
            !occ.read_error &&
            occ.cli !== "unknown" &&
            occ.cli !== expectedCli,
          );
        if (isForeign(cachedOccupant)) {
          // Confirm against another target-scoped fresh read before refusing;
          // one parse alone can be transient, while a fleet-wide scan would
          // couple this route to unrelated pane churn.
          const freshOccupant = await timeDeliveryPhase(
            args.timings,
            "enumerate",
            () => discovery.scanTarget(route, onTargetRpc),
          );
          if (isForeign(freshOccupant)) {
            throw new Error(
              `Agent "${args.agent_id}" (${expectedCli}) no longer occupies ` +
                `surface ${route.surface_id} — it now hosts a ${freshOccupant?.cli} ` +
                `agent (surface recycled). Call list_agents for a refreshed ` +
                `live view and retry.`,
            );
          }
        }
      }
      const routeSurfaceAlive =
        route.state === "error" &&
        (await registry.isSurfaceAlive(route, {
          ptyDead:
            surfaceWriteLiveness.observe(
              route.surface_id,
              route.surface_uuid,
              context.surfaceObserverId,
            )?.pty_dead === true,
        }));
      // AIDEV-NOTE (F1): gate on the LIVE state, not the route's registry copy.
      // `freshOccupant` is a target-scoped scan taken moments ago -- the same
      // evidence P4 uses. Reading the record here is what returned a terminal
      // `failed` receipt to an agent sitting at a live prompt (ledger row 4):
      // #408 had flipped its record to `done` while its screen read ready.
      const liveRouteState = resolveLiveAgentState(
        { state: route.state },
        freshOccupant && !freshOccupant.read_error
          ? {
              status: freshOccupant.parsed_status,
              agent_type:
                freshOccupant.cli === "kiro" ? "unknown" : freshOccupant.cli,
              control_state: freshOccupant.control_state,
              errors: freshOccupant.errors ?? null,
            }
          : null,
      );
      const queuedBehindTurn =
        args.source_event === "send_to" && liveRouteState.state === "working";
      const bypassLifecycleGate =
        args.allow_busy === true || args.source_event === "send_to";
      if (
        !bypassLifecycleGate &&
        !isLiveDeliverable(liveRouteState) &&
        !routeSurfaceAlive
      ) {
        throw new RetryableDeliveryError(
          `Agent "${args.agent_id}" is not in an interactive state ` +
            `(current: ${liveRouteState.state}, source: ${liveRouteState.source}` +
            `${liveRouteState.stale_registry_state ? `, registry record says ${liveRouteState.registry_state}` : ""}). ` +
            `Must be in: ${[...INTERACTIVE_AGENT_STATES].join(", ")}. ` +
            `Pass allow_busy: true to bypass this gate and deliver raw keystrokes regardless of state.`,
        );
      }

      const sanitizedText = sanitizeTerminalInput(args.text);
      const chunks =
        sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
          ? chunkTerminalInput(sanitizedText, SEND_INPUT_CHUNK_THRESHOLD)
          : [sanitizedText];
      const shortPointerVerifyTimeoutMs =
        args.source_event === "send_to" &&
        sanitizedText.length <= SHORT_POINTER_MAX_CHARS
          ? Math.min(
              SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS,
              SHORT_POINTER_SUBMIT_VERIFY_TIMEOUT_MS,
            )
          : undefined;

      // All validation above can await. Establish the delivery binding only
      // after those gates, then prove the exact UUID/ref/workspace pair again
      // immediately before every chunk attempt and Return. Once any text has
      // landed, following a moved UUID would split one logical message across
      // terminals, so route changes fail closed instead.
      route = await timeDeliveryPhase(args.timings, "enumerate", () =>
        engine.resolveAgentIoRoute(args.agent_id, undefined, onTopologyRpc),
      );
      await assertAgentRouteHasTui(route);
      const deliveryRoute = route;
      const routeElapsed = Math.max(0, Date.now() - routeStartedAt);
      const enumerateElapsed = Math.max(
        0,
        (args.timings?.enumerate ?? 0) - enumerateStartedAt,
      );
      if (args.timings) {
        args.timings.route += Math.max(0, routeElapsed - enumerateElapsed);
      }
      const assertDeliveryRouteCurrent = async (): Promise<void> => {
        let current: typeof deliveryRoute;
        try {
          current = await timeDeliveryPhase(args.timings, "enumerate", () =>
            engine.resolveAgentIoRoute(args.agent_id, undefined, onTopologyRpc),
          );
        } catch (error) {
          throw new Error(
            `Agent "${args.agent_id}" route re-resolution failed before terminal ` +
              `delivery: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        if (
          current.surface_id !== deliveryRoute.surface_id ||
          (current.surface_uuid ?? null) !==
            (deliveryRoute.surface_uuid ?? null) ||
          (current.workspace_id ?? null) !==
            (deliveryRoute.workspace_id ?? null)
        ) {
          throw new Error(
            `Agent "${args.agent_id}" surface route changed during terminal ` +
              `delivery; refusing to continue on another surface.`,
          );
        }
      };

      return withSurfaceWrite(
        deliveryRoute.surface_id,
        async () => {
          await assertDeliveryRouteCurrent();
          const delivery = await executeDeliveryEngine({
            surface: deliveryRoute.surface_id,
            workspace: deliveryRoute.workspace_id ?? undefined,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: args.press_enter,
            stableSurfaceIdentity: deliveryRoute.surface_uuid,
            source_event: args.source_event,
            source_agent: resolveCurrentCallerAgent()?.agent_id ?? null,
            delivery_id: args.delivery_id,
            // Verify every submitted agent relay — not just long ones. A short
            // relay (the common agent-to-agent case) to a frozen terminal must
            // be caught, never reported as ok. Verified agent messages may
            // retry Return once only while the exact text remains in a Codex
            // composer; accepted TUI queues are nonterminal receipts instead.
            // AIDEV-NOTE (F1): gate verification on the SAME live-resolved
            // state the delivery gate above used. Reading the registry record
            // here meant the class this lane newly admits -- registry-terminal
            // + screen `ready` + allow_busy:false -- skipped verification
            // entirely and returned an unproven success: the same receipt lie
            // with the sign flipped (false `failed` -> false `ok`). It also
            // suppressed markAgentWorking below, so the poisoned record was
            // never corrected and every later send repeated the unverified path.
            verify_submit:
              args.press_enter &&
              (bypassLifecycleGate || isLiveDeliverable(liveRouteState)),
            // A single recovery Return is part of verified sends and inbox
            // wakeups. Other lifecycle mutations (notably goal supersession)
            // retain their stricter no-retry evidence semantics.
            allow_recovery_enter_retry:
              args.source_event === "send_to" ||
              args.source_event === "dispatch_nudge" ||
              args.source_event === "report_to_parent",
            require_observed_payload_before_enter:
              args.source_event === "send_to" ||
              args.source_event === "dispatch_nudge" ||
              args.source_event === "report_to_parent",
            submit_verify_timeout_ms:
              args.allow_busy || queuedBehindTurn
                ? BUSY_AGENT_SUBMIT_VERIFY_TIMEOUT_MS
                : shortPointerVerifyTimeoutMs,
            beforeMutation: assertDeliveryRouteCurrent,
            timings: args.timings,
          });
          if (args.press_enter && delivery.submit_verified === true) {
            engine.markAgentWorking(args.agent_id, {
              verifiedDelivery: args.source_event === "send_to",
            });
          }
          return { ...delivery, queued_behind_turn: queuedBehindTurn };
        },
        {
          toolName: args.source_event,
          workspace: deliveryRoute.workspace_id ?? undefined,
          observePtyWrite: true,
          stableSurfaceIdentity: deliveryRoute.surface_uuid,
          timings: args.timings,
        },
      );
    };
    // Expose the guarded relay to dispatch_to_agent's nudge (registered above,
    // outside this lifecycle block).
    lifecycleAgentInputDeliverer = deliverAgentInput;
    engine.setDeliverySubmitter((receipt) =>
      withTransportRetryTracking(async () => {
        let delivery: Awaited<ReturnType<typeof deliverAgentInput>>;
        try {
          delivery = await deliverAgentInput({
            agent_id: receipt.agent_id,
            text: receipt.text,
            press_enter: receipt.press_enter,
            allow_busy: false,
            source_event: receipt.source_event,
            delivery_id: receipt.delivery_id,
          });
        } catch (error) {
          if (error instanceof AmbiguousBootRecoveryReturnError && error.receipt) {
            // acceptPendingVerify replaced this queued followup with the boot
            // pointer receipt. The drain must not append a failed transition
            // for the old followup after the uncertain Return.
            return { retry_count: 0, submit_verified: null,
              typed: true, submit_dispatched: false,
              delivery: "pending_verify" as const };
          }
          throw error;
        }
        return {
          retry_count: delivery.retry_count,
          submit_verified: delivery.submit_verified,
          rpc_methods: delivery.rpc_methods,
          typed: delivery.typed,
          submit_dispatched: delivery.submit_dispatched,
          ...(delivery.delivery === "submitted" ||
          delivery.delivery === "queued" ||
          delivery.delivery === "queued_followup" ||
          delivery.delivery === "rescued" ||
          delivery.delivery === "pending_verify"
            ? { delivery: delivery.delivery }
            : {}),
        };
      }),
    );

    const deliverReportInboxPointer = async (
      recipient: AgentRecord,
      message: ReturnType<typeof dispatch>,
    ): Promise<{
      delivery:
        | "submitted"
        | "queued"
        | "queued_followup"
        | "rescued"
        | "pending_verify";
      delivery_id?: string;
    }> => {
      const pointer = formatInboxPing(
        message,
        inboxPath(recipient.agent_id, inboxOpts),
      );
      if (recipient.state === "working") {
        const queued = engine.queueDelivery({
          agent_id: recipient.agent_id,
          text: pointer,
          press_enter: true,
          source_event: "report_to_parent",
        });
        return { delivery: "queued", delivery_id: queued.delivery_id };
      }
      const deliveryId = randomUUID();
      let delivered: Awaited<ReturnType<typeof deliverAgentInput>>;
      try {
        delivered = await deliverAgentInput({
          agent_id: recipient.agent_id,
          text: pointer,
          press_enter: true,
          allow_busy: false,
          source_event: "report_to_parent",
          delivery_id: deliveryId,
        });
      } catch (error) {
        if (error instanceof AmbiguousBootRecoveryReturnError && error.receipt?.delivery_id) {
          return { delivery: "pending_verify", delivery_id: error.receipt.delivery_id };
        }
        if (
          error instanceof RetryableDeliveryError ||
          (error instanceof Error && /\bis busy\b/.test(error.message))
        ) {
          const queued = engine.queueDelivery({
            agent_id: recipient.agent_id,
            text: pointer,
            press_enter: true,
            source_event: "report_to_parent",
          });
          return { delivery: "queued", delivery_id: queued.delivery_id };
        }
        throw error;
      }
      if (
        delivered.delivery !== "submitted" &&
        delivered.delivery !== "queued" &&
        delivered.delivery !== "queued_followup" &&
        delivered.delivery !== "rescued" &&
        delivered.delivery !== "pending_verify"
      ) {
        throw new Error(
          "parent blocker wake produced no evidence-backed delivery state",
        );
      }
      if (
        delivered.delivery === "queued" ||
        delivered.delivery === "queued_followup"
      ) {
        engine.acceptComposerQueue({
          delivery_id: deliveryId,
          agent_id: recipient.agent_id,
          text: pointer,
          press_enter: true,
          source_event: "report_to_parent",
          retry_count: delivered.retry_count,
          rpc_methods: delivered.rpc_methods,
          typed: delivered.typed,
          submit_dispatched: delivered.submit_dispatched,
          delivery_state: delivered.delivery,
        });
      } else if (delivered.delivery === "pending_verify") {
        engine.acceptPendingVerify({
          delivery_id: deliveryId,
          agent_id: recipient.agent_id,
          text: pointer,
          press_enter: true,
          source_event: "report_to_parent",
          retry_count: delivered.retry_count,
          rpc_methods: delivered.rpc_methods,
          typed: delivered.typed,
          submit_dispatched: delivered.submit_dispatched,
        });
      } else if (delivered.delivery === "rescued") {
        engine.resolveDelivery({
          delivery_id: deliveryId,
          agent_id: recipient.agent_id,
          text: pointer,
          press_enter: true,
          source_event: "report_to_parent",
          delivery_state: "rescued",
          terminal: true,
          retry_count: delivered.retry_count,
          rpc_methods: delivered.rpc_methods,
          typed: delivered.typed,
          submit_dispatched: delivered.submit_dispatched,
          submit_verified: false,
          error: "Prompt appeared only after an external interrupt",
        });
        throw new Error(
          "parent blocker wake was rescued by an external interrupt, not verified",
        );
      } else {
        engine.resolveDelivery({
          delivery_id: deliveryId,
          agent_id: recipient.agent_id,
          text: pointer,
          press_enter: true,
          source_event: "report_to_parent",
          delivery_state: "submitted",
          terminal: true,
          retry_count: delivered.retry_count,
          rpc_methods: delivered.rpc_methods,
          typed: delivered.typed,
          submit_dispatched: delivered.submit_dispatched,
          submit_verified: delivered.submit_verified,
          error: null,
        });
      }
      return { delivery: delivered.delivery, delivery_id: deliveryId };
    };

    const armParentReportWatch = async (
      parentAgentId: string,
      childAgentId: string,
      coordination: { report_path: string; done_marker: string },
    ): Promise<string | null> => {
      try {
        const child =
          registry.get(childAgentId) ?? stateMgr.readState(childAgentId);
        if (!child || child.parent_agent_id !== parentAgentId) {
          return `Report watch was not armed: ${childAgentId} is not a direct child of ${parentAgentId}`;
        }
        const reportPath = resolve(coordination.report_path);
        if ([...stateMgr.listStates(), ...registry.list()].some(
          (agent) => agent.collab_path &&
            resolve(agent.collab_path) === reportPath,
        )) {
          return `Report watch was not armed: shared_collab_report_path (${reportPath})`;
        }
        const legacyEngineReportPath = resolve(
          issueSpawnCoordination(childAgentId).report_path,
        );
        const persistedChildReportPath = child.report_path
          ? resolve(child.report_path)
          : null;
        const canonicalParent = canonicalAgentId(parentAgentId);
        const ownerCandidates = snapshotWatchOwnerCandidates();
        const reportWatchArmedAt = opts?.watchRegistryNow?.() ?? Date.now();
        const reportWatchDeadline = reportWatchArmedAt +
          (opts?.reportWatchDeadlineMs ?? DEFAULT_REPORT_WATCH_DEADLINE_MS);
        const existing = readWatchRegistry({
          registryPath: watchRegistryPath,
        }).watches.find(
          (watch) => {
            // Lifecycle may only adopt rows it owns. Provenance-absent rows are
            // legacy engine rows only at the engine-derived child report path;
            // an arbitrary/public row must remain independent even when its
            // owner alias, target, and change happen to match this contract.
            const lifecycleOwned =
              watch.provenance === "engine" ||
              (watch.provenance === undefined &&
                (resolve(watch.target) === legacyEngineReportPath ||
                  resolve(watch.target) === persistedChildReportPath));
            const ownerResolution = resolveWatchOwner(
              watchRecordOwner(watch),
              ownerCandidates,
            );
            return (
              lifecycleOwned &&
              watchOwnerIncludesCanonical(ownerResolution, canonicalParent) &&
              (!watch.subject_agent_id ||
                watch.subject_agent_id === childAgentId) &&
              resolve(watch.target) === reportPath &&
              watch.change === "content" &&
              watch.state !== "failed"
            );
          },
        );
        if (existing) {
          if (!existing.subject_agent_id) {
            await scopeWatchToSubject(existing.watch_id, childAgentId, {
              registryPath: watchRegistryPath,
            });
          }
          await updateWatchDeadline(existing.watch_id, reportWatchDeadline, {
            registryPath: watchRegistryPath,
            now: () => reportWatchArmedAt,
          });
          return null;
        }
        await mkdir(dirname(reportPath), { recursive: true });
        await appendFile(reportPath, "", "utf8");
        await engine.armWatch({
          owner: parentAgentId,
          subject_agent_id: childAgentId,
          target: reportPath,
          provenance: "engine",
          change: "content",
          deadline: reportWatchDeadline,
        });
        return null;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return `Report watch was not armed for ${coordination.report_path}: ${detail}`;
      }
    };
    const parentReportPathReservations = context.parentReportPathReservations;
    const reserveParentReportPath = async (
      parentAgentId: string,
      reportPath: string,
      childAgentId?: string,
    ): Promise<
      | { ok: true; key: string; reservation_id: string }
      | { ok: false; message: string }
    > => {
      const key = JSON.stringify([parentAgentId, reportPath]);
      if (parentReportPathReservations.has(key)) {
        return {
          ok: false,
          message: `report_path ${reportPath} is already reserved by another child spawn; each child requires a distinct report path`,
        };
      }
      const existingLiveChild = stateMgr
        .listStates()
        .find(
          (candidate) =>
            candidate.agent_id !== childAgentId &&
            candidate.parent_agent_id === parentAgentId &&
            candidate.report_path !== null &&
            candidate.report_path !== undefined &&
            resolve(candidate.report_path) === reportPath &&
            candidate.user_killed !== true &&
            !candidate.deletion_intent &&
            !TERMINAL_AGENT_STATES.has(candidate.state),
        );
      if (existingLiveChild) {
        return {
          ok: false,
          message: `report_path ${reportPath} is already assigned to live child ${existingLiveChild.agent_id}; each child requires a distinct report path`,
        };
      }
      const registryReservation = await reserveWatchReportPath(
        {
          owner: parentAgentId,
          target: reportPath,
          ...(childAgentId ? { subject_agent_id: childAgentId } : {}),
        },
        { registryPath: watchRegistryPath },
      );
      if (!registryReservation.ok) {
        return {
          ok: false,
          message: `report_path ${reportPath} is already assigned to child ${registryReservation.conflict_subject_agent_id ?? `through an existing ${registryReservation.conflict_kind}`}; each child requires a distinct report path`,
        };
      }
      parentReportPathReservations.add(key);
      return {
        ok: true,
        key,
        reservation_id: registryReservation.reservation.reservation_id,
      };
    };
    // report_to_parent (src/mcp/tools/agent.ts, CX-3b S10a)
    registerReportToParentTool(server, {
      assertWorkerUpwardChannel,
      awaitLifecycleStart,
      deliverReportInboxPointer,
      inboxOpts,
      registry,
      resolveCurrentCallerAgent,
      stateMgr,
    });
    engine.setDeliverySnapshotReader(async (receipt: AgentDeliveryReceipt) => {
      const agent = engine.getAgentState(receipt.agent_id);
      if (!agent) return null;
      return readParsedSurface(
        agent.surface_id,
        agent.workspace_id ?? undefined,
      );
    });
    engine.setDeliveryVerifier(
      async (receipt: AgentDeliveryReceipt, snapshot) => {
        if (receipt.boot_recovery &&
          stateMgr.readState(receipt.agent_id)?.boot_instance_id !== receipt.boot_instance_id) {
          return { outcome: "pending" as const, reason: "boot_instance_changed" };
        }
        const agent = engine.getAgentState(receipt.agent_id);
        if (!agent) {
          return { outcome: "pending" as const, reason: "target_gone" };
        }
        const resolvedSnapshot =
          snapshot === undefined
            ? await readParsedSurface(
                agent.surface_id,
                agent.workspace_id ?? undefined,
              )
            : snapshot;
        if (!resolvedSnapshot?.text.trim()) {
          return {
            outcome: "pending" as const,
            reason: "surface_read_unavailable",
          };
        }
        const pending = screenShowsPendingInput(
          resolvedSnapshot.text,
          receipt.text,
        );
        const queued = screenShowsQueuedAgentInput(
          resolvedSnapshot.text,
          receipt.text,
        );
        const cursorQueuedFollowup = screenShowsQueuedCursorFollowup(
          resolvedSnapshot.text,
          receipt.text,
        );
        const composer = extractComposerInputRegion(
          resolvedSnapshot.text,
          receipt.text,
        );
        const cli = inferComposerCli(
          resolvedSnapshot.text,
          resolvedSnapshot.parsed as Parameters<typeof inferComposerCli>[1],
        );
        // Compaction can temporarily render Codex's ready footer while the
        // queued message still belongs to the active turn's next tool call.
        const compactingCodexQueue =
          cli === "codex" &&
          /(?:^|\n)\s*[•·]\s*Context compacted\s*[·•]\s*\d+s\b/i.test(
            resolvedSnapshot.text.slice(-4096),
          );
        const parsed = resolvedSnapshot.parsed as ParsedScreenResult | undefined;
        const queuedReady = parsed?.control_state === "ready" && parsed.status === "idle";
        if (queued || cursorQueuedFollowup || (cli === "cursor" && pending)) {
          return {
            outcome: "pending" as const,
            ...(queued
              ? {
                  reason: compactingCodexQueue
                    ? queuedReady
                      ? "queued_compaction_idle"
                      : "queued_compaction_busy"
                    : queuedReady
                      ? "queued_idle"
                      : undefined,
                }
              : {}),
          };
        }
        const composerCleared = composer !== null && composer.trim() === "";
        const correlationTail = receipt.text
          .trim()
          .slice(-Math.min(80, receipt.text.trim().length));
        const inTranscript =
          correlationTail.length > 0 &&
          normalizeTerminalText(resolvedSnapshot.text).includes(
            correlationTail,
          ) &&
          !pending;
        if (composerCleared || inTranscript) {
          return { outcome: "delivered" as const, submit_verified: true };
        }
        return { outcome: "pending" as const };
      },
    );

    // Reconstitute and discover live surfaces before the first sidebar paint.
    // The engine initializer is idempotent because daemon connections share a
    // context and may construct more than one MCP server over its lifetime.
    if (!context.lifecycleStarted) {
      context.lifecycleStarted = true;
      context.lifecycleStartError = null;
      context.lifecycleStartStartedAtMs = Date.now();
      context.lifecycleStartSettledAtMs = null;
      const lifecycleInitialization = lifecycleInitializer
        ? Promise.resolve().then(() => lifecycleInitializer())
        : engine.initialize(discovery);
      context.lifecycleStartPromise = lifecycleInitialization
        .catch((error) => {
          context.lifecycleStartError =
            error instanceof Error ? error : new Error(String(error));
          console.error(
            "[cmuxlayer] lifecycle initialization failed:",
            context.lifecycleStartError,
          );
        })
        .then(() => {
          context.lifecycleStartSettledAtMs = Date.now();
          if (
            !context.lifecycleStartError &&
            context.lifecycleStarted &&
            context.lifecycleSweepEngine === engine
          ) {
            engine.startSweep(resolveSweepTiming());
          }
        });
    }
    context.lifecycleLockStateProvider = () => engine.lifecycleLockState();
    // The daemon may immediately use this relay for monitor recovery. Publish
    // it only after persisted lifecycle state has been reconstituted so route
    // resolution is ready, then wake any boot-time recovery claim.
    void (context.lifecycleStartPromise ?? Promise.resolve()).then(() => {
      if (
        !context.lifecycleStartError &&
        context.lifecycleStarted &&
        context.lifecycleSweepEngine === engine
      ) {
        context.setLifecycleAgentInputDeliverer(deliverAgentInput);
      }
    });

    // 11. spawn_agent
    server.tool(
      "spawn_agent",
      "Spawn a managed agent or terminal, or resume a captured agent on a fresh surface while preserving its ID. Placement is deterministic; boot_prompt_timeout_ms also bounds pane placement. Boot prompts return evidence-backed receipts. Successful receipts are lean by default; verbose=true restores full transport and diagnostic detail. Failures always keep full detail.",
      {
        version: z
          .literal(1)
          .optional()
          .default(1)
          .describe("SpawnSpec schema version"),
        type: z
          .enum(["agent", "terminal"])
          .optional()
          .default("agent")
          .describe("Spawn an AI agent or a plain terminal"),
        resume_agent_id: z
          .string()
          .optional()
          .describe(
            "THE way to revive an agent: resume this captured session on a fresh surface, keeping its public agent ID and re-issuing its coordination contract. cmuxlayer never revives a pane by itself (#492) -- a pane you close stays closed -- so a lead that wants an agent back asks here, by id. Refused with a reason when the session transcript is not on disk, rather than opening an empty pane. Mutually exclusive with new-spawn fields.",
          ),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "With resume_agent_id only: override inconclusive recorded-process liveness after the caller deliberately verifies the old agent is gone. Does not bypass session or terminal-state requirements.",
          ),
        repo: z
          .string()
          .optional()
          .describe("Repository name (e.g. 'brainlayer', 'golems')"),
        model: z
          .string()
          .optional()
          .describe(
            "OPTIONAL — leave UNSET so the launcher pins the top-tier model. For cli:'codex', an explicit model is checked against Codex's runtime model list before any worktree or surface is created, then passed through to the launcher. Never pass 'opus' for claude — the top Claude model is already the default.",
          ),
        effort: z
          .enum(CODEX_EFFORT_VALUES)
          .optional()
          .describe(
            "Codex reasoning effort, passed to the repoGolem launcher. CHOOSE THIS DELIBERATELY PER MISSION — it is a cost decision, not a default to inherit. The installed launcher currently accepts: low, medium, high, xhigh, max, ultra. spawn_agent rejects other values before creating a worktree or surface. The live launcher defaults to HIGH when omitted (~/.config/ralphtools/golem-dispatch.zsh). Per /agent-routing, MEDIUM is the settled floor for well-specified implementation lanes — use it unless the task genuinely needs more; xhigh and above burn budget fast and are rarely warranted for a lane with a clear brief.",
          ),
        cli: z
          .enum(["claude", "codex", "gemini", "kiro", "cursor"])
          .optional()
          .describe("CLI tool to launch"),
        cwd: z
          .string()
          .optional()
          .describe("Initial working directory for type=terminal"),
        title: z
          .string()
          .optional()
          .describe(
            "The caller-supplied agent pane title is applied verbatim (for example `cmuxlayer-WORKER · run1 name-the-tabs`); when omitted or blank, the existing agent-id/surface fallback is retained. Managed identity comes from the agent registry, not this display title (#479/#492).",
          ),
        prompt: z
          .string()
          .optional()
          .describe(
            `${PANE_INPUT_BREAKAGE_GUIDANCE} Inline task prompt to send after the agent is ready. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default; use boot_prompt_path for larger prompts. Mutually exclusive with boot_prompt_path.`,
          ),
        boot_prompt_path: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Optional readable prompt-file path. Checked before spawning; multiline or over-cap files are submitted as one `Read and follow <path>` pointer and one final return after readiness. Mutually exclusive with prompt.",
          ),
        boot_prompt_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional timeout override in milliseconds for pane placement, initial shell readiness, agent launch readiness, and the boot prompt. When omitted, each phase keeps its established default (45s placement, 10s shell, 15s launch, 60s boot prompt).",
          ),
        workspace: z
          .string()
          .optional()
          .describe(
            "Target workspace ref. Omit to use the caller/current workspace; pass only when intentionally spawning in a different workspace.",
          ),
        worktree: worktreeArgSchema
          .optional()
          .describe(
            'When set, create or reuse a git worktree before launch. Pass a string such as "tool-usage" as the worktree name, true for a generated name, or an object with name, path, branch, base, create, and reuse. When repoGolem registers the repo with an absolute path, that path is the repo root; otherwise the root is resolved from CMUXLAYER_REPO_HOME, the running checkout, or ~/Gits. true uses <registered-root>/.worktrees/<generated-name> (legacy ~/Gits/<repo>.wt read-fallback until ~2026-09). If a later spawn step fails before a recoverable surface exists, a newly created worktree and branch are rolled back.',
          ),
        mcp_profile: mcpProfileSchema
          .optional()
          .describe(
            "MCP profile hint for worktree launches. Defaults to inherit. Use sterile/skill_eval or include/exclude lists for narrower evals.",
          ),
        collab_path: z
          .string()
          .trim()
          .min(1)
          .refine(isAbsolute, "collab_path must be absolute")
          .optional()
          .describe("Lead coordination file; workers inherit their parent lead collab_path unless explicitly supplied."),
        parent_agent_id: z
          .string()
          .optional()
          .describe(
            "ID of the parent agent for hierarchical spawning. Normally inferred from the managed caller surface; pass explicitly only when no managed caller supplies the hierarchy. Parent must exist.",
          ),
        role: spawnFunctionSchema()
          .optional()
          .describe(
            "Agent job function: implementor, reviewer, or gatherer. Legacy orchestrator/worker aliases remain accepted for compatibility. Claude requires this field explicitly.",
          ),
        placement: spawnPlacementSchema()
          .optional()
          .describe(
            "Physical placement axis: left or right. It must agree with authority (lead=left, worker=right). Legacy orchestrator/worker aliases remain accepted.",
          ),
        authority: z
          .enum(["lead", "worker"])
          .optional()
          .describe(
            "Authority axis, independent from job function and placement",
          ),
        auto_archive_on_done: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Deprecated compatibility flag. TASK_DONE updates agent state only; cmuxlayer does not auto-close panes.",
          ),
        max_cost_per_agent: z
          .number()
          .optional()
          .describe("Maximum cost cap in USD for this agent"),
        halt_escalation: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Notify the nearest live ancestor when this agent remains awaiting input, idle without done evidence, or wedged past its dwell threshold. Set false for deliberate debugging lanes.",
          ),
        report_path: z
          .string()
          .refine((value) => isAbsolute(value.trim()), {
            message:
              "report_path must be absolute so the producer and consumer resolve the same file",
          })
          .optional()
          .describe(
            'Optional ABSOLUTE override for the engine-issued report path. Omit in almost all cases: the engine issues ~/.cmux/agents/<agent_id>/report.md, returns it here, and verifies closure against it. Pass a distinct FILE path per child (never a directory) to place a report somewhere you already watch. Check coordination_footer_delivered. For resume_agent_id calls, false means the pointer was deliberately not re-delivered: follow coordination_footer_note and relay only if the restored session lost its original context. For new spawns, if false and contract_path is present, folded pointer submission was queued or unverified, so YOU must relay contract_path, report_path, and done_marker. If false and contract_path is absent, inline mode is active or the contract file could not be written, so YOU must relay report_path and done_marker.',
          ),
        force_new: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, suppress same repo/workspace/role duplicate-lane warnings. Default false so collab leads see reusable existing agents before spawning another lane.",
          ),
        focus: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Leave focus on the created agent tab instead of restoring the exact origin after initialization.",
          ),
        allow_long_inline: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Bypass the inline prompt length cap for a deliberate raw boot-prompt send. Prefer boot_prompt_path for large prompts.",
          ),
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Return the full legacy spawn response instead of the lean default.",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        const creation = new CreatedIdentityScope();
        let reportPathReservationKey: string | null = null;
        let reportPathReservationId: string | null = null;
        try {
          // P11 finding 2: reject a relative override BEFORE anything launches.
          // The zod .refine() covers real MCP calls; this covers direct handler
          // invocation, so no call path can leave an orphaned pane behind an
          // input-validation error.
          if (
            typeof args.report_path === "string" &&
            !isAbsolute(args.report_path.trim())
          ) {
            return err(
              new Error(
                `report_path must be absolute so the producer and consumer resolve the same file: ${args.report_path}`,
              ),
            );
          }
          if (args.collab_path && !isAbsolute(args.collab_path.trim())) {
            throw new Error("collab_path must be absolute");
          }
          if (
            args.report_path &&
            [args.collab_path, ...stateMgr.listStates().map((agent) => agent.collab_path)]
              .some((path) => path && resolve(path) === resolve(args.report_path!.trim()))
          ) {
            return err(
              new Error("report_path cannot target a shared collab_path"),
              { error_code: "shared_collab_report_path" },
            );
          }
          if (args.resume_agent_id) {
            const incompatible = [
              "repo",
              "model",
              "effort",
              "cli",
              "cwd",
              "prompt",
              "boot_prompt_path",
              "worktree",
              "mcp_profile",
              "collab_path",
              "parent_agent_id",
              "role",
              "placement",
              "authority",
              "max_cost_per_agent",
            ].filter((field) =>
              Object.prototype.hasOwnProperty.call(args, field),
            );
            if ((args.type ?? "agent") !== "agent" || incompatible.length > 0) {
              return err(
                new Error(
                  `resume_agent_id is mutually exclusive with new-spawn fields${
                    incompatible.length > 0
                      ? `: ${incompatible.join(", ")}`
                      : ""
                  }`,
                ),
                { error_code: "INVALID_RESUME_SPEC" },
              );
            }
            await awaitLifecycleStart();
            const existing = engine.resolveResumeAgent(args.resume_agent_id);
            if (!existing) {
              return err(new Error(`Agent not found: ${args.resume_agent_id}`));
            }
            const resumeCoordination = issueSpawnCoordination(
              existing.agent_id,
              args.report_path,
            );
            if (existing.parent_agent_id) {
              const reservation = await reserveParentReportPath(
                existing.parent_agent_id,
                resolve(resumeCoordination.report_path),
                existing.agent_id,
              );
              if (!reservation.ok) {
                return err(new Error(reservation.message), {
                  error_code: "REPORT_PATH_IN_USE",
                });
              }
              reportPathReservationKey = reservation.key;
              reportPathReservationId = reservation.reservation_id;
            }
            const workspace = await canonicalWorkspaceRef(
              args.workspace ?? existing.workspace_id ?? undefined,
            );
            await assertWorkspaceMutationAllowed("spawn_agent", workspace);
            let focusRestoreLease = await focusTargetBeforeSplit(
              workspace,
              args.focus !== true,
            );
            const result = await engine.resumeAgent(args.resume_agent_id, {
              workspace,
              force: args.force,
            });
            creation.record({
              agent_id: result.agent_id,
              surface_id: result.surface_id,
              workspace_id: result.workspace_id ?? workspace ?? null,
            });
            focusRestoreLease = await capturePostCreationFocus(
              focusRestoreLease,
              {
                surface: result.surface_id,
                workspace: result.workspace_id ?? workspace,
              },
            );
            const focusRestoreWarning = await restoreFocusAfterRender(
              focusRestoreLease,
              result.surface_id,
              result.workspace_id ?? workspace,
            );
            // AIDEV-NOTE (P11b / #462 item 2): resume used to return NO
            // contract at all -- no report_path, no done_marker, no contract
            // file -- so the crash-recovery case this repo exists for was the
            // one case where a lead could not even SEE where its worker should
            // report. The contract is derived from agent_id alone, so what is
            // issued here is byte-identical to what the original spawn issued;
            // refreshing the file is idempotent and restores it if the channel
            // dir was reaped between the crash and the resume.
            //
            // What is deliberately NOT done: re-injecting the pointer as
            // keystrokes into a resuming pane. `claude --resume` restores the
            // prior session, so the original pointer message is already in the
            // agent's context, and typing into a pane mid-resume is a change to
            // the most incident-prone path in this repo -- the exact thing this
            // PR exists to move work OFF. That sliver stays open on #462.
            const resumeMonitorBoot = ensureMonitorBoot(result.agent_id);
            const resumeContract = buildBootContractInjection(
              result.agent_id,
              resumeMonitorBoot,
              resumeCoordination,
            );
            result.report_path = resumeCoordination.report_path;
            result.done_marker = resumeCoordination.done_marker;
            result.contract_path = resumeContract.contract_path ?? undefined;
            result.coordination_footer_bytes =
              coordinationFooterBytes(resumeCoordination);
            // Provenance, same rule as the spawn path: the file is refreshed,
            // but nothing was re-delivered to the pane on this call. Saying
            // `true` here would be the claim this PR's own thesis forbids.
            result.coordination_footer_delivered = false;
            result.coordination_footer_note = resumeContract.contract_path
              ? COORDINATION_CONTRACT_REFRESHED_NOT_REDELIVERED
              : COORDINATION_FOOTER_NOT_DELIVERED;
            try {
              const patched = stateMgr.updateRecord(result.agent_id, {
                report_path: resumeCoordination.report_path,
                done_marker: resumeCoordination.done_marker,
              });
              registry.set(result.agent_id, patched);
            } catch {
              // Receipt already carries the contract; a registry write failure
              // must not fail an otherwise-successful resume.
            }
            const reportWatchWarning = result.parent_agent_id
              ? await armParentReportWatch(
                  result.parent_agent_id,
                  result.agent_id,
                  resumeCoordination,
                )
              : null;
            const resumeWarnings = [
              ...(result.warnings ?? []),
              ...(reportWatchWarning ? [reportWatchWarning] : []),
              ...(focusRestoreWarning ? [focusRestoreWarning] : []),
            ];
            const resumed = {
              spawn_state: "started" as const,
              version: 1,
              type: "agent",
              resumed: true,
              ...result,
              role: inferRecordRoleOrNull(existing) ?? "worker",
              ...(resumeWarnings.length > 0
                ? {
                    warning: resumeWarnings.join(" | "),
                    warnings: resumeWarnings,
                  }
                : {}),
            };
            return buildSpawnToolReturn(
              { retry_count: currentTransportRetryCount(), ...resumed },
              args.verbose,
              formatOk("spawn_agent", resumed),
            );
          }
          if (args.type === "terminal") {
            if (
              args.role !== undefined ||
              args.authority !== undefined ||
              args.placement !== undefined ||
              args.worktree !== undefined
            ) {
              return err(
                new Error(
                  "Terminal spawns do not accept role, authority, placement, or worktree",
                ),
                { error_code: "INVALID_TERMINAL_SPAWN_SPEC" },
              );
            }
            const requestedWorkspace = args.workspace;
            const callerWorkspace = await currentSafetyCallerWorkspace();
            const createsWorkspace = requestedWorkspace?.startsWith("new:");
            await assertWorkspaceMutationAllowed(
              "spawn_agent",
              createsWorkspace
                ? callerWorkspace
                : (requestedWorkspace ?? callerWorkspace),
            );
            const workspace = createsWorkspace
              ? (await client.createWorkspace(requestedWorkspace!.slice(4)))
                  .workspace
              : (requestedWorkspace ?? callerWorkspace);
            const panes = await client.listPanes({ workspace });
            const placement = chooseAgentSpawnPlacement(
              panes.panes,
              [],
              new Set<string>(),
              { role: "worker" },
            );
            const created =
              placement.kind === "surface"
                ? await client.newSurface({
                    focus: args.focus ?? !client.listSurfaceRuntimeMetadata,
                    pane: placement.pane,
                    ...(workspace ? { workspace } : {}),
                    type: "terminal",
                  })
                : await client.newSplit(placement.direction, {
                    ...(workspace ? { workspace } : {}),
                    ...(placement.pane ? { pane: placement.pane } : {}),
                    focus: args.focus ?? !client.listSurfaceRuntimeMetadata,
                  });
            creation.record({
              surface_id: created.surface,
              workspace_id: created.workspace ?? workspace ?? null,
            });
            let runtimeInitialization: string;
            try {
              runtimeInitialization = await initializeNewSurfaceRuntime(
                {
                  listTerminalMetadata: client.listSurfaceRuntimeMetadata
                    ? () => client.listSurfaceRuntimeMetadata!()
                    : undefined,
                  sendKey: (surface, key, options) => client.sendKey(surface, key, options),
                },
                created.surface,
                created.workspace ?? workspace,
                args.boot_prompt_timeout_ms,
                undefined,
                created.surface_id,
              );
            } catch (error) {
              try {
                await client.closeSurface(created.surface, { workspace: created.workspace ?? workspace });
              } catch (cleanupError) {
                const primary = error instanceof Error ? error : new Error(String(error));
                primary.message += `. Failed to close launcher surface ${created.surface}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
                throw primary;
              }
              throw error;
            }
            if (args.title) {
              await client.renameTab(created.surface, args.title, {
                workspace: created.workspace ?? workspace,
              });
            }
            const cwdReceipt = args.cwd
              ? await withSurfaceWrite(
                  created.surface,
                  () =>
                    executeDeliveryEngine({
                      surface: created.surface,
                      workspace: created.workspace ?? workspace,
                      chunks: [`cd -- ${shellQuote(args.cwd!)}`],
                      chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
                      chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
                      press_enter: true,
                      source_event: "send_command",
                      verify_submit: false,
                    }),
                  {
                    toolName: "spawn_agent",
                    workspace: created.workspace ?? workspace,
                    observePtyWrite: true,
                  },
                )
              : undefined;
            return ok({
              version: 1,
              type: "terminal",
              runtime_initialization: runtimeInitialization,
              surface_id: created.surface,
              workspace_id: created.workspace ?? workspace ?? null,
              cwd: args.cwd ?? null,
              title: args.title ?? null,
              ...(cwdReceipt ? { cwd_receipt: cwdReceipt } : {}),
            });
          }
          const spawnProblems: string[] = [];
          if (!args.repo) {
            spawnProblems.push("repo is required for type=agent");
          }
          if (!args.cli) {
            spawnProblems.push("cli is required for type=agent");
          }
          const rolelessClaude =
            args.version === 1 &&
            (args.cli === "claude" || args.cli === undefined) &&
            args.role === undefined;
          if (rolelessClaude) {
            spawnProblems.push(
              'Claude spawns require an explicit job role; use either authority:"lead", role:"implementor" or authority:"worker", role:"reviewer"',
            );
          }
          if (args.cli) {
            try {
              resolveSpawnModelPolicy(args.cli, args.model);
            } catch (error) {
              spawnProblems.push(
                error instanceof Error ? error.message : String(error),
              );
            }
            try {
              resolveSpawnEffort(args.cli, args.effort);
            } catch (error) {
              spawnProblems.push(
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          if (spawnProblems.length > 0) {
            const error_code =
              spawnProblems.length === 1 &&
              rolelessClaude &&
              args.cli === "claude"
                ? "ROLE_REQUIRED"
                : spawnProblems.length > 1
                  ? "INVALID_SPAWN_SPEC"
                  : undefined;
            return err(
              new Error(spawnProblems.join("; ")),
              error_code ? { error_code } : {},
            );
          }
          requireValue(args.repo, "repo is required for type=agent");
          requireValue(args.cli, "cli is required for type=agent");
          const normalizedRole = normalizeSpawnAxes({
            role: args.role,
            placement: args.placement,
            authority: args.authority,
          });
          resolveSpawnModelPolicy(args.cli, args.model);
          resolveSpawnEffort(args.cli, args.effort);
          const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
          assertBootPromptMode(args.prompt, bootPromptPath);
          assertSpawnPromptInputAllowed({
            tool: "spawn_agent",
            value: args.prompt,
            cli: args.cli,
            allowLongInline: args.allow_long_inline,
          });
          if (bootPromptPath) {
            await preflightBootPromptFile(bootPromptPath);
          }
          const bootPromptText = bootPromptPath
            ? await readFile(bootPromptPath, "utf8")
            : null;

          if (args.parent_agent_id && args.report_path) {
            const earlyReservation = await reserveParentReportPath(
              args.parent_agent_id,
              resolve(args.report_path.trim()),
            );
            if (!earlyReservation.ok) {
              return err(new Error(earlyReservation.message), {
                error_code: "REPORT_PATH_IN_USE",
              });
            }
            reportPathReservationKey = earlyReservation.key;
            reportPathReservationId = earlyReservation.reservation_id;
          }
          await refreshManagedMetadataBestEffort(args.parent_agent_id);
          await refreshManagedMetadataBestEffort();
          const callerAgent = resolveCurrentCallerAgent();
          const callerRole = callerAgent
            ? inferRecordRoleOrNull(callerAgent)
            : null;
          const callerIsWorker = callerRole === "worker";
          const effectiveParentAgentId = callerIsWorker
            ? callerAgent!.agent_id
            : (args.parent_agent_id ?? callerAgent?.agent_id);
          if (effectiveParentAgentId && args.report_path) {
            const requestedReportPath = resolve(args.report_path.trim());
            const effectiveReservationKey = JSON.stringify([
              effectiveParentAgentId,
              requestedReportPath,
            ]);
            if (
              reportPathReservationKey &&
              reportPathReservationKey !== effectiveReservationKey
            ) {
              parentReportPathReservations.delete(reportPathReservationKey);
              if (reportPathReservationId) {
                await releaseWatchReportPathReservation(
                  reportPathReservationId,
                  { registryPath: watchRegistryPath },
                );
              }
              reportPathReservationKey = null;
              reportPathReservationId = null;
            }
            if (!reportPathReservationKey) {
              const reservation = await reserveParentReportPath(
                effectiveParentAgentId,
                requestedReportPath,
              );
              if (!reservation.ok) {
                return err(new Error(reservation.message), {
                  error_code: "REPORT_PATH_IN_USE",
                });
              }
              reportPathReservationKey = reservation.key;
              reportPathReservationId = reservation.reservation_id;
            }
          }
          const effectiveRole = callerIsWorker ? "worker" : normalizedRole.role;
          const workerCallerWarning = callerIsWorker
            ? `Worker caller ${callerAgent!.agent_id} forced child role to worker and recorded itself as parent; worker-spawned agents cannot claim orchestrator placement.`
            : undefined;
          // TODO(#378): a future policy decision may refuse worker-initiated
          // spawn_agent calls entirely. Current binding is force+warn.
          if (
            effectiveParentAgentId &&
            effectiveParentAgentId !== args.parent_agent_id
          ) {
            await refreshManagedMetadataBestEffort(effectiveParentAgentId);
          }
          const parentWorkspace = effectiveParentAgentId
            ? (engine.getAgentState(effectiveParentAgentId)?.workspace_id ??
              undefined)
            : undefined;
          const targetResolution = await resolvePlacementWorkspace({
            explicitWorkspace: args.workspace,
            callerWorkspace: parentWorkspace,
            repo: args.repo,
          });
          const spawnWorkspace = targetResolution.workspace;
          const comparisonWorkspace = spawnWorkspace ?? parentWorkspace;
          await assertWorkspaceMutationAllowed(
            "spawn_agent",
            comparisonWorkspace,
          );
          const requestedRole = inferAgentRole({
            role: effectiveRole,
            cli: args.cli,
            launcherName: launcherNameForCli(args.repo, args.cli),
          });
          const existingSameLaneAgents = args.force_new
            ? []
            : registry
                .list()
                .filter(
                  (agent) =>
                    (agent.state === "ready" || agent.state === "idle") &&
                    reposEquivalent(agent.repo, args.repo!) &&
                    (agent.workspace_id ?? null) ===
                      (comparisonWorkspace ?? null) &&
                    inferRecordRoleOrNull(agent) === requestedRole,
                )
                .map((agent) => ({
                  agent_id: agent.agent_id,
                  surface_id: agent.surface_id,
                  workspace_id: agent.workspace_id ?? null,
                  state: agent.state,
                  role: inferRecordRoleOrNull(agent),
                  task_summary: summarizeTaskSummary(agent.task_summary),
                }));
          const duplicateSpawnWarning =
            existingSameLaneAgents.length > 0
              ? `Existing same-lane agent(s) are idle/ready in ${comparisonWorkspace ?? "unknown workspace"}; reuse or supersede unless a new lane is intentional. Pass force_new:true to suppress this warning.`
              : undefined;
          const spawnPrompt = hasInlinePrompt(args.prompt)
            ? args.prompt
            : (bootPromptText ?? "");
          // Prepare only after every non-spawn gate has passed. From this point
          // onward the catch below owns rollback for any newly created worktree.
          const worktree = await prepareSpawnWorktree(
            args.repo,
            args.worktree,
            args.mcp_profile as McpProfile | undefined,
          );
          const cleanupFailedLauncherArtifacts = async (
            error: Error,
            agentId: string,
            surface: string,
            workspace?: string,
          ): Promise<boolean> => {
            const record = engine.getAgentState(agentId);
            const cleanupSurface = record?.surface_uuid?.trim() || surface;
            try {
              await client.closeSurface(cleanupSurface, { workspace });
            } catch (cleanupError) {
              error.message = `${error.message}. Failed to close launcher surface ${cleanupSurface}: ${
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError)
              }`;
              return false;
            }
            const current = engine.getAgentState(agentId);
            if (current && !TERMINAL_AGENT_STATES.has(current.state)) {
              try {
                const failed = stateMgr.transition(agentId, "error", {
                  error: `Launcher surface closed after failed readiness: ${error.message}`,
                });
                registry.set(agentId, failed);
              } catch (stateError) {
                error.message = `${error.message}. Failed to mark closed launcher agent ${agentId} terminal: ${
                  stateError instanceof Error
                    ? stateError.message
                    : String(stateError)
                }`;
              }
            }
            if (worktree.prepared?.created && worktree.repoRoot) {
              try {
                await rollbackPreparedWorktree(
                  worktree.repoRoot,
                  worktree.prepared,
                  opts?.worktreeExec,
                );
              } catch (rollbackError) {
                error.message = `${error.message}. Worktree rollback also failed: ${
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError)
                }`;
              }
            }
            return true;
          };
          const runtimeMetadataSupported = typeof client.listSurfaceRuntimeMetadata === "function" ||
            (typeof client.listTerminalMetadata === "function" &&
            await readRuntimeMetadata(() => client.listTerminalMetadata())
              .then(({ terminals }) => terminals.some((item) => typeof item.runtime_surface_ready === "boolean"))
              .catch(() => false));
          const focusForLaunch = args.focus === true || !runtimeMetadataSupported;
          let focusRestoreLease = focusForLaunch
            ? await focusTargetBeforeSplit(spawnWorkspace, args.focus !== true)
            : null;
          let surfaceCreated = false;
          let result: Awaited<ReturnType<typeof engine.spawnAgent>>;
          try {
            result = await engine.spawnAgent({
              repo: args.repo,
              focus: focusForLaunch,
              runtime_metadata_supported: runtimeMetadataSupported,
              model: args.model,
              effort: args.effort,
              cli: args.cli,
              prompt: spawnPrompt,
              boot_prompt_path: bootPromptPath,
              boot_prompt_pending: true,
              workspace: spawnWorkspace,
              cwd: worktree.prepared?.path,
              mcp_env: worktree.mcpEnv,
              mcp_profile_label: worktree.mcpProfileLabel,
              worktree_branch: worktree.prepared?.branch,
              parent_agent_id: effectiveParentAgentId,
              collab_path: args.collab_path,
              role: effectiveRole,
              authority: callerIsWorker ? "worker" : normalizedRole.authority,
              function: normalizedRole.function,
              placement: callerIsWorker ? "right" : normalizedRole.placement,
              auto_archive_on_done: args.auto_archive_on_done ?? false,
              title: args.title,
              max_cost_per_agent: args.max_cost_per_agent,
              halt_escalation: args.halt_escalation,
              boot_prompt_timeout_ms: args.boot_prompt_timeout_ms,
              on_surface_created: async (created) => {
                surfaceCreated = true;
                creation.record({
                  agent_id: created.agent_id,
                  surface_id: created.surface,
                  workspace_id: created.workspace ?? spawnWorkspace ?? null,
                });
                focusRestoreLease = await capturePostCreationFocus(
                  focusRestoreLease,
                  created,
                );
              },
            });
          } catch (e) {
            if (
              e instanceof AgentLaunchError &&
              e.launch_phase === "launch" &&
              (e.launch_cause instanceof SurfaceRuntimeNotStartedError ||
                e.launch_cause instanceof LauncherReadinessError ||
                (e.launch_cause instanceof BootPromptTimeoutError &&
                  e.launch_cause.pending_input_observed))
            ) {
              await cleanupFailedLauncherArtifacts(
                e,
                e.agent_id,
                e.surface_id,
                e.workspace_id,
              );
            }
            let rollbackError: unknown = null;
            if (
              !surfaceCreated &&
              worktree.prepared?.created &&
              worktree.repoRoot
            ) {
              try {
                await rollbackPreparedWorktree(
                  worktree.repoRoot,
                  worktree.prepared,
                  opts?.worktreeExec,
                );
              } catch (error) {
                rollbackError = error;
              }
            }
            try {
              await restoreFocusAfterRender(
                focusRestoreLease,
                undefined,
                spawnWorkspace,
              );
            } catch {
              // Preserve the original spawn error response.
            }
            if (rollbackError) {
              const rollback =
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError);
              if (e instanceof Error) {
                e.message = `${e.message}. Worktree rollback also failed: ${rollback}`;
                throw e;
              }
              throw new Error(
                `${String(e)}. Worktree rollback also failed: ${rollback}`,
                { cause: e },
              );
            }
            throw e;
          }
          const originalLaunchCommand = originalLaunchCommandsBySurface.get(
            result.surface_id,
          );
          originalLaunchCommandsBySurface.delete(result.surface_id);
          const launchShellRecovery = launchShellRecoveryBySurface.get(
            result.surface_id,
          );
          launchShellRecoveryBySurface.delete(result.surface_id);
          const monitorBoot = ensureMonitorBoot(result.agent_id);
          const coordination = issueSpawnCoordination(
            result.agent_id,
            args.report_path,
          );
          // AIDEV-NOTE (P11b): P11 could not deliver this contract -- inline,
          // the mailbox contract alone was ~479 chars against a 500-char chunk
          // threshold, so appending the report contract (measured 618 chars)
          // moved every spawn onto the chunked paste path (#434/#438). The
          // contract now goes to a file and the wire carries one short line, so
          // the worker is finally TOLD the same two strings the receipt reports.
          const bootContract = buildBootContractInjection(
            result.agent_id,
            monitorBoot,
            coordination,
          );
          // #782/#801: a sterile seat gets only the caller's brief typed.
          const skipContractPointer = args.mcp_profile === "sterile";
          const injectedBootPrompt = skipContractPointer
            ? undefined
            : bootContract.text;
          result.report_path = coordination.report_path;
          result.done_marker = coordination.done_marker;
          // Finding 3: never report the contract's size without reporting how
          // (or whether) it reached the worker -- the v0.4.42 `paused`
          // provenance fix, applied to both outcomes of the fallback above.
          result.coordination_footer_bytes =
            coordinationFooterBytes(coordination);
          result.contract_path = bootContract.contract_path ?? undefined;
          result.coordination_footer_delivered = false;
          result.coordination_footer_note = skipContractPointer
            ? bootContract.contract_path
              ? COORDINATION_CONTRACT_POINTER_SKIPPED_STERILE
              : COORDINATION_CONTRACT_SKIPPED_STERILE_NO_FILE
            : bootContract.contract_path
              ? COORDINATION_CONTRACT_POINTER_NOT_VERIFIED
              : COORDINATION_FOOTER_NOT_DELIVERED;
          try {
            const patched = stateMgr.updateRecord(result.agent_id, {
              report_path: coordination.report_path,
              done_marker: coordination.done_marker,
            });
            registry.set(result.agent_id, patched);
          } catch {
            // Receipt already carries the contract; a registry write failure
            // must not fail an otherwise-successful spawn.
          }
          if (result.parent_agent_id) {
            const reportWatchWarning = await armParentReportWatch(
              result.parent_agent_id,
              result.agent_id,
              coordination,
            );
            if (reportWatchWarning) {
              result.warnings = [
                ...(result.warnings ?? []),
                reportWatchWarning,
              ];
            }
          }
          const spawnedBinding = engine.getAgentState(result.agent_id);
          appendStaleBuildWarning(result);
          const placementWarnings = [
            ...targetResolution.warnings,
            ...(normalizedRole.warning ? [normalizedRole.warning] : []),
            ...(workerCallerWarning ? [workerCallerWarning] : []),
          ];
          if (placementWarnings.length > 0) {
            result.warnings = [
              ...(result.warnings ?? []),
              ...placementWarnings,
            ];
          }

          let bootPromptDelivery:
            Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
          let launcherSurfaceClosed = false;
          try {
            {
              const deliveryWorkspace = spawnDeliveryWorkspace(
                result,
                spawnWorkspace,
              );
              bootPromptDelivery = await deliverBootPrompt({
                surface: result.surface_id,
                workspace: deliveryWorkspace,
                stableSurfaceIdentity: spawnedBinding?.surface_uuid,
                resolveRoute: spawnedBinding?.surface_uuid
                  ? () => resolveManagedDeliveryRoute(result.agent_id)
                  : undefined,
                assertStableSurfaceIdentity: spawnedBinding?.surface_uuid
                  ? async () => {
                    const current = engine.getAgentState(result.agent_id);
                    if (current?.surface_uuid?.toLowerCase() !==
                        spawnedBinding.surface_uuid?.toLowerCase()) {
                      throw new Error("Spawn surface UUID changed during Codex update menu selection");
                    }
                  }
                  : undefined,
                cli: args.cli,
                prompt: args.prompt,
                boot_prompt_path: bootPromptPath,
                injected_prompt: injectedBootPrompt,
                timeout_ms: args.boot_prompt_timeout_ms,
                onUpdateShellRelaunch: () =>
                  relaunchSpawnAgentAfterUpdate({
                    agentId: result.agent_id,
                    surface: result.surface_id,
                    workspace: deliveryWorkspace,
                    model: result.model ?? args.model,
                    mcpEnv: result.mcp_env,
                    originalCommand: originalLaunchCommand,
                    timeout_ms: args.boot_prompt_timeout_ms,
                  }),
              });
              if (bootContract.contract_path !== null && !skipContractPointer) {
                result.coordination_footer_delivered =
                  isBootPromptDelivered(bootPromptDelivery);
                result.coordination_footer_note =
                  result.coordination_footer_delivered
                    ? COORDINATION_CONTRACT_DELIVERED_NOTE
                    : COORDINATION_CONTRACT_POINTER_NOT_VERIFIED;
              }

              await captureSpawnSessionBestEffort(result);
              if (bootPromptDelivery.prompt_text !== null) {
                const updated = stateMgr.updateRecord(result.agent_id, {
                  ...bootPromptRegistryFields(
                    bootPromptDelivery.prompt_text,
                    bootPromptPath,
                  ),
                  boot_prompt_pending:
                    bootPromptDelivery.submit_verified !== true,
                  prompt_delivered: bootPromptDelivery.submit_verified === true,
                  submit_verified: bootPromptDelivery.submit_verified,
                });
                registry.set(result.agent_id, updated);
              } else {
                const updated = stateMgr.updateRecord(result.agent_id, {
                  boot_prompt_pending:
                    bootPromptDelivery.delivery_state === "queued",
                  prompt_delivered: false,
                  submit_verified: null,
                });
                registry.set(result.agent_id, updated);
              }

              const current = engine.getAgentState(result.agent_id);
              if (
                current?.state === "booting" &&
                (hasInlinePrompt(args.prompt) || Boolean(bootPromptPath)) &&
                bootPromptDelivery.submit_verified === true
              ) {
                const ready = stateMgr.transition(result.agent_id, "ready");
                registry.set(result.agent_id, ready);
                result.state = "ready";
              } else if (current?.state === "ready") {
                result.state = "ready";
              }
            }
          } catch (e) {
            creation.attach(e);
            if (e instanceof LauncherReadinessError) {
              launcherSurfaceClosed = await cleanupFailedLauncherArtifacts(
                e,
                result.agent_id,
                result.surface_id,
                spawnDeliveryWorkspace(result, spawnWorkspace),
              );
            }
            const message = e instanceof Error ? e.message : String(e);
            const clearBootPromptPending = () => {
              const record = resolveSpawnRecord(
                result.agent_id,
                result.surface_id,
              );
              const agentId = record?.agent_id ?? result.agent_id;
              const updated = stateMgr.updateRecord(
                agentId,
                e instanceof BootComposerResidueError
                  ? {
                    // The brief itself was submitted and is running; only the
                    // residue was left behind (#801 review F1).
                    boot_prompt_pending: false,
                    prompt_delivered: true,
                    submit_verified: e.submit_verified,
                  }
                  : {
                    // A readiness timeout happens before delivery. Preserve the
                    // pending marker so a later idle CLI cannot be mistaken for a
                    // successfully tasked agent by the lifecycle sweep.
                    boot_prompt_pending:
                      e instanceof BootPromptTimeoutError ||
                      e instanceof BootPromptDeliveryError,
                    prompt_delivered: false,
                    submit_verified:
                      e instanceof BootPromptDeliveryError ? false : null,
                  },
              );
              registry.set(agentId, updated);
              result.agent_id = updated.agent_id;
              return updated;
            };
            try {
              await captureSpawnSessionBestEffort(result);
              let updated = clearBootPromptPending();
              if (
                !(e instanceof BootPromptTimeoutError) &&
                !(e instanceof BootPromptDeliveryError) &&
                updated.state !== "done" &&
                updated.state !== "error"
              ) {
                updated = stateMgr.transition(result.agent_id, "error", {
                  error: `Boot prompt failed: ${message}`,
                });
                registry.set(result.agent_id, updated);
              }
            } catch {
              // Preserve the original boot prompt error response.
            }
            try {
              // Boot delivery already performed its own readiness wait. On a
              // timeout, restore immediately instead of starting a second wait.
              await restoreFocusAfterRender(
                focusRestoreLease,
                launcherSurfaceClosed ? undefined : result.surface_id,
                spawnDeliveryWorkspace(result, spawnWorkspace),
                { waitForReady: false },
              );
            } catch {
              // Preserve the original boot prompt error response.
            }
            const extra = {
              agent_id: result.agent_id,
              surface_id: result.surface_id,
            };
            if (e instanceof SurfaceGoneError) {
              return err(e, surfaceGonePayload(e, extra));
            }
            if (e instanceof BootPromptTimeoutError) {
              try {
                clearBootPromptPending();
              } catch {
                // Preserve the original timeout response.
              }
              return err(e, { ...extra, last_10_lines: e.last_10_lines });
            }
            if (e instanceof BootPromptUpdateMenuBlockedError) {
              return err(e, {
                ...extra,
                error_code: e.error_code,
                last_10_lines: e.last_10_lines,
                recovery: e.recovery,
              });
            }
            if (e instanceof BootComposerResidueError) {
              await refreshManagedMetadataBestEffort(result.agent_id);
              await lifecycleSeatManifestPublisher({ agentId: result.agent_id });
              return err(e, {
                ...extra,
                error_code: e.error_code,
                composer_residue: e.composer_residue,
                delivered_chars: e.delivered_chars,
                typed: e.typed,
                submit_dispatched: e.submit_dispatched,
                rpc_methods: e.rpc_methods,
                boot_prompt_submit_verified: e.submit_verified,
                report_path: result.report_path,
                done_marker: result.done_marker,
                contract_path: result.contract_path,
                next_action:
                  "Return WAS dispatched: the brief was submitted and the agent is working on it, " +
                  "but the text in composer_residue stayed unsent in its composer. Do not re-spawn. " +
                  "If the residue is the contract pointer, relay contract_path, report_path and done_marker " +
                  "to the agent yourself; otherwise send the residue with send_to once the draft is cleared.",
              });
            }
            if (e instanceof BootPromptDeliveryError) {
              const safetyError = findErrorInChain(
                e,
                (candidate): candidate is ManualModeMutationError | DeliverySafetyGateError =>
                  candidate instanceof ManualModeMutationError ||
                  candidate instanceof DeliverySafetyGateError,
              );
              if (safetyError) {
                return err(safetyError, {
                  ...extra,
                  delivered_chars: e.delivered_chars,
                  ...bootPromptFailureMutationEvidence({
                    delivered_chars: e.delivered_chars,
                    typed: e.typed,
                    submit_dispatched: e.submit_dispatched,
                    rpc_methods: e.rpc_methods,
                  }),
                });
              }
              const bootPromptReceipt = e.submit_verification_error
                ? { ...submitVerificationFailurePayload(e.submit_verification_error),
                    terminal: true,
                    bytes: e.delivered_chars }
                : {
                    ...buildPublicDeliveryReceipt({
                      delivery_state: "pending_verify",
                      typed: e.typed || e.delivered_chars > 0,
                      submit_attempted: e.submit_dispatched,
                      submit_dispatched: e.submit_dispatched,
                      submit_verified: false,
                      retry_count: currentTransportRetryCount(),
                      rpc_methods: e.rpc_methods,
                    }),
                    bytes: e.delivered_chars,
                  };
              await refreshManagedMetadataBestEffort(result.agent_id);
              await lifecycleSeatManifestPublisher({ agentId: result.agent_id });
              return buildSpawnToolReturn(
                {
                  retry_count: currentTransportRetryCount(),
                  ...result,
                  spawn_state: "boot_unsubmitted",
                  workspace_id: result.workspace_id,
                  delivered_chars: e.delivered_chars,
                  boot_prompt_delivered: false,
                  boot_prompt_receipt: bootPromptReceipt,
                  boot_prompt_submit_verified: false,
                },
                args.verbose,
              );
            }
            return err(e, extra);
          }

          const focusRestoreWarning = await restoreFocusAfterRender(
            focusRestoreLease,
            result.surface_id,
            spawnDeliveryWorkspace(result, spawnWorkspace),
            {
              waitForReady: !bootPromptDelivery,
            },
          );
          if (focusRestoreWarning) {
            result.warnings = [...(result.warnings ?? []), focusRestoreWarning];
          }

          await refreshManagedMetadataBestEffort(result.agent_id);
          await lifecycleSeatManifestPublisher({
            agentId: result.agent_id,
          });
          const currentAgent = engine.getAgentState(result.agent_id);
          const topologyRole =
            currentAgent?.role ??
            inferAgentRole({
              role: effectiveRole,
              cli: args.cli,
              launcherName: launcherNameForCli(args.repo, args.cli),
            });
          const topology = currentAgent ? await collectSurfaceTopology() : null;
          const health = currentAgent
            ? await evaluateServerAgentHealth(
                currentAgent,
                {
                  ...healthTopologyOverrides(currentAgent, topology),
                },
                topology,
              )
            : undefined;

          if (callerAgent && !callerIsWorker && effectiveRole === "worker" &&
              result.parent_agent_id === callerAgent.agent_id && args.collab_path) {
            const adopted = stateMgr.updateRecord(callerAgent.agent_id, { collab_path: args.collab_path.trim() });
            registry.set(callerAgent.agent_id, adopted);
          }

          const formattedData = {
            agent_id: result.agent_id,
            parent_agent_id: result.parent_agent_id,
            repo: args.repo,
            model: result.model ?? args.model,
            requested_model: result.requested_model,
            warning:
              result.warnings && result.warnings.length > 0
                ? result.warnings.join(" | ")
                : undefined,
            surface: result.surface_id,
            role: args.version === 1 ? normalizedRole.function : topologyRole,
            authority: callerIsWorker ? "worker" : normalizedRole.authority,
            placement: callerIsWorker ? "right" : normalizedRole.placement,
            version: 1,
            type: "agent",
            health,
            duplicate_spawn_warning: duplicateSpawnWarning,
            monitor_boot: monitorBoot,
            boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
          };
          const responseData = {
            ...result,
            spawn_state:
              bootPromptDelivery && bootPromptDelivery.submit_verified !== true
                ? "boot_unsubmitted"
                : "started",
            worktree: worktree.prepared,
            mcp_profile: worktree.mcpProfileLabel,
            role: args.version === 1 ? normalizedRole.function : topologyRole,
            authority: callerIsWorker ? "worker" : normalizedRole.authority,
            placement: callerIsWorker ? "right" : normalizedRole.placement,
            version: 1,
            type: "agent",
            health,
            duplicate_spawn_warning: duplicateSpawnWarning,
            existing_same_lane_agents: existingSameLaneAgents,
            monitor_boot: monitorBoot,
            boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
            boot_prompt_receipt: bootPromptDelivery,
            boot_prompt_bytes: bootPromptDelivery?.bytes,
            boot_prompt_submit_verified:
              bootPromptDelivery?.submit_verified ?? null,
            ...(bootPromptDelivery?.update_menu_skipped ? {
              update_menu_skipped: true,
              update_menu_text_hash: bootPromptDelivery.update_menu_text_hash,
            } : {}),
            ...(launchShellRecovery?.recovered
              ? {
                  readiness_recovered: true,
                  readiness_cleared: launchShellRecovery.cleared,
                }
              : {}),
          };
          return buildSpawnToolReturn(
            {
              retry_count: currentTransportRetryCount(),
              ...responseData,
            },
            args.verbose,
            formatOk("spawn_agent", formattedData),
          );
        } catch (e) {
          const caught = creation.attach(e);
          if (caught instanceof AgentLaunchError) {
            if (caught.launch_cause instanceof DeliverySafetyGateError) {
              creation.attach(caught.launch_cause);
              return err(caught.launch_cause, {
                agent_id: caught.agent_id,
                surface_id: caught.surface_id,
                workspace_id: caught.workspace_id,
                error_code: caught.launch_cause.error_code,
                submit_verified: caught.launch_cause.submit_verified,
                screen: caught.launch_cause.screen,
              });
            }
            if (caught.launch_cause instanceof SurfaceGoneError) {
              creation.attach(caught.launch_cause);
              return err(
                caught.launch_cause,
                surfaceGonePayload(caught.launch_cause, {
                  agent_id: caught.agent_id,
                  surface_id: caught.surface_id,
                  workspace_id: caught.workspace_id,
                }),
              );
            }
            return err(caught, {
              agent_id: caught.agent_id,
              surface_id: caught.surface_id,
              workspace_id: caught.workspace_id,
            });
          }
          if (caught instanceof DeliverySafetyGateError) {
            return err(caught, {
              error_code: caught.error_code,
              submit_verified: caught.submit_verified,
              screen: caught.screen,
            });
          }
          if (caught instanceof SurfaceGoneError) {
            return err(caught, surfaceGonePayload(caught));
          }
          return err(caught);
        } finally {
          if (reportPathReservationKey) {
            parentReportPathReservations.delete(reportPathReservationKey);
          }
          if (reportPathReservationId) {
            try {
              await releaseWatchReportPathReservation(reportPathReservationId, {
                registryPath: watchRegistryPath,
              });
            } catch (error) {
              console.error(
                `[cmuxlayer] failed to release report-path reservation ${reportPathReservationId}:`,
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }
      },
    );

    server.tool(
      "new_worktree_split",
      `${PANE_INPUT_BREAKAGE_GUIDANCE} Create or reuse a git worktree and spawn one worker agent into a right-side cmux split. Returns a lean response by default; pass verbose:true for the full legacy health and worktree bookkeeping. Defaults to inherited MCPs and preserves the existing worker layout policy.`,
      {
        repo: z.string().describe("Repository name"),
        model: z.string().describe("Model name"),
        cli: z
          .enum(["claude", "codex", "gemini", "kiro", "cursor"])
          .describe("CLI tool to launch"),
        prompt: z
          .string()
          .optional()
          .describe(
            `${PANE_INPUT_BREAKAGE_GUIDANCE} Optional inline boot prompt.`,
          ),
        boot_prompt_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional timeout override in milliseconds for initial shell readiness, agent launch readiness, and the boot prompt. When omitted, each phase keeps its established default (10s shell, 15s launch, 60s boot prompt).",
          ),
        workspace: z.string().optional().describe("Target workspace ref"),
        worktree: worktreeArgSchema
          .optional()
          .describe(
            'Worktree options. Pass a string such as "tool-usage" as the worktree name, true for a generated name, or an options object. A repoGolem registration with an absolute path names the repo root; without one it is resolved from CMUXLAYER_REPO_HOME, the running checkout, or ~/Gits. Defaults to true, creating/reusing <registered-root>/.worktrees/<generated-name>; a newly created worktree and branch are rolled back if spawn fails before a recoverable surface exists (legacy ~/Gits/<repo>.wt read-fallback until ~2026-09).',
          ),
        mcp_profile: mcpProfileSchema
          .optional()
          .describe("MCP profile hint. Defaults to inherit."),
        parent_agent_id: z.string().optional(),
        auto_archive_on_done: z.boolean().optional().default(false),
        halt_escalation: z.boolean().optional().default(true),
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Return the full legacy spawn response instead of the lean default.",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        const creation = new CreatedIdentityScope();
        let focusRestoreLease: FocusRestoreLease | null = null;
        let result: Awaited<ReturnType<typeof engine.spawnAgent>> | undefined;
        let mutationWorkspace: string | undefined;
        let surfaceCreated = false;
        let worktree:
          Awaited<ReturnType<typeof prepareSpawnWorktree>> | undefined;
        try {
          resolveSpawnModelPolicy(args.cli, args.model);
          assertBootPromptMode(args.prompt, null);
          assertSpawnPromptInputAllowed({
            tool: "new_worktree_split",
            value: args.prompt,
            cli: args.cli,
            allowLongInlineSupported: false,
          });
          await refreshManagedMetadataBestEffort(args.parent_agent_id);
          const parentWorkspace = args.parent_agent_id
            ? (engine.getAgentState(args.parent_agent_id)?.workspace_id ??
              undefined)
            : undefined;
          const targetResolution = await resolvePlacementWorkspace({
            explicitWorkspace: args.workspace,
            callerWorkspace: parentWorkspace,
            repo: args.repo,
          });
          mutationWorkspace = targetResolution.workspace;
          await assertWorkspaceMutationAllowed(
            "new_worktree_split",
            mutationWorkspace,
          );
          focusRestoreLease = await focusTargetBeforeSplit(mutationWorkspace);
          worktree = await prepareSpawnWorktree(
            args.repo,
            args.worktree ?? true,
            args.mcp_profile as McpProfile | undefined,
          );
          const hasPrompt = hasInlinePrompt(args.prompt);
          result = await engine.spawnAgent({
            repo: args.repo,
            model: args.model,
            cli: args.cli,
            prompt: args.prompt ?? "",
            boot_prompt_pending: hasPrompt,
            workspace: mutationWorkspace,
            cwd: worktree.prepared?.path,
            mcp_env: worktree.mcpEnv,
            mcp_profile_label: worktree.mcpProfileLabel,
            worktree_branch: worktree.prepared?.branch,
            parent_agent_id: args.parent_agent_id,
            role: "worker",
            auto_archive_on_done: args.auto_archive_on_done ?? false,
            halt_escalation: args.halt_escalation,
            on_surface_created: async (created) => {
              surfaceCreated = true;
              creation.record({
                agent_id: created.agent_id,
                surface_id: created.surface,
                workspace_id: created.workspace ?? mutationWorkspace ?? null,
              });
              focusRestoreLease = await capturePostCreationFocus(
                focusRestoreLease,
                created,
              );
            },
            boot_prompt_timeout_ms: args.boot_prompt_timeout_ms,
          });
          const originalLaunchCommand = originalLaunchCommandsBySurface.get(
            result.surface_id,
          );
          originalLaunchCommandsBySurface.delete(result.surface_id);
          const launchShellRecovery = launchShellRecoveryBySurface.get(
            result.surface_id,
          );
          launchShellRecoveryBySurface.delete(result.surface_id);
          appendStaleBuildWarning(result);
          if (targetResolution.warnings.length > 0) {
            result.warnings = [
              ...(result.warnings ?? []),
              ...targetResolution.warnings,
            ];
          }

          let bootPromptDelivery:
            Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
          if (hasPrompt) {
            const deliveryWorkspace = spawnDeliveryWorkspace(
              result,
              mutationWorkspace,
            );
            bootPromptDelivery = await deliverBootPrompt({
              surface: result.surface_id,
              workspace: deliveryWorkspace,
              resolveRoute: () => resolveManagedDeliveryRoute(result!.agent_id),
              cli: args.cli,
              prompt: args.prompt,
              timeout_ms: args.boot_prompt_timeout_ms,
              onUpdateShellRelaunch: () =>
                relaunchSpawnAgentAfterUpdate({
                  agentId: result!.agent_id,
                  surface: result!.surface_id,
                  workspace: deliveryWorkspace,
                  model: result!.model ?? args.model,
                  mcpEnv: result!.mcp_env,
                  originalCommand: originalLaunchCommand,
                  timeout_ms: args.boot_prompt_timeout_ms,
                }),
            });
            canonicalizeSpawnResult(result);
            const updated = stateMgr.updateRecord(result.agent_id, {
              ...bootPromptRegistryFields(
                bootPromptDelivery.prompt_text ?? args.prompt ?? "",
              ),
              boot_prompt_pending:
                bootPromptDelivery.delivery_state === "queued",
              prompt_delivered: bootPromptDelivery.submit_verified === true,
              submit_verified: bootPromptDelivery.submit_verified,
            });
            registry.set(result.agent_id, updated);
          }

          const focusRestoreWarning = await restoreFocusAfterRender(
            focusRestoreLease,
            result.surface_id,
            spawnDeliveryWorkspace(result, mutationWorkspace),
            { waitForReady: !hasPrompt },
          );
          if (focusRestoreWarning) {
            result.warnings = [...(result.warnings ?? []), focusRestoreWarning];
          }
          await refreshManagedMetadataBestEffort(result.agent_id);
          await lifecycleSeatManifestPublisher({
            agentId: result.agent_id,
          });
          const currentAgent = engine.getAgentState(result.agent_id);
          const topology = currentAgent ? await collectSurfaceTopology() : null;
          const health = currentAgent
            ? await evaluateServerAgentHealth(
                currentAgent,
                {
                  ...healthTopologyOverrides(currentAgent, topology),
                },
                topology,
              )
            : undefined;

          const formattedData = {
            agent_id: result.agent_id,
            surface: result.surface_id,
            worktree: worktree.prepared?.path ?? "",
            mcp_profile: worktree.mcpProfileLabel ?? "inherit",
            health,
          };
          const responseData = {
            ...result,
            role: "worker",
            health,
            worktree: worktree.prepared,
            mcp_profile: worktree.mcpProfileLabel ?? "inherit",
            boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
            boot_prompt_receipt: bootPromptDelivery,
            boot_prompt_bytes: bootPromptDelivery?.bytes,
            boot_prompt_submit_verified:
              bootPromptDelivery?.submit_verified ?? null,
            ...(launchShellRecovery?.recovered
              ? {
                  readiness_recovered: true,
                  readiness_cleared: launchShellRecovery.cleared,
                }
              : {}),
          };
          return buildSpawnToolReturn(
            {
              retry_count: currentTransportRetryCount(),
              ...responseData,
            },
            args.verbose,
            formatOk("new_worktree_split", formattedData),
          );
        } catch (e) {
          let caught: unknown = creation.attach(e);
          if (
            !result &&
            !surfaceCreated &&
            worktree?.prepared?.created &&
            worktree.repoRoot
          ) {
            try {
              await rollbackPreparedWorktree(
                worktree.repoRoot,
                worktree.prepared,
                opts?.worktreeExec,
              );
            } catch (rollbackError) {
              const rollback =
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError);
              if (e instanceof Error) {
                e.message = `${e.message}. Worktree rollback also failed: ${rollback}`;
                caught = e;
              } else {
                caught = new Error(
                  `${String(e)}. Worktree rollback also failed: ${rollback}`,
                  { cause: e },
                );
              }
            }
          }
          caught = creation.attach(caught);
          await restoreFocusAfterRender(
            focusRestoreLease,
            result?.surface_id,
            result
              ? spawnDeliveryWorkspace(result, mutationWorkspace)
              : mutationWorkspace,
            { waitForReady: false },
          );
          const createdIdentity = result
            ? {
                agent_id: result.agent_id,
                surface_id: result.surface_id,
                workspace_id: result.workspace_id ?? mutationWorkspace,
              }
            : {};
          if (caught instanceof AgentLaunchError) {
            if (caught.launch_cause instanceof DeliverySafetyGateError) {
              return err(caught.launch_cause, {
                agent_id: caught.agent_id,
                surface_id: caught.surface_id,
                workspace_id: caught.workspace_id,
                error_code: caught.launch_cause.error_code,
                submit_verified: caught.launch_cause.submit_verified,
                screen: caught.launch_cause.screen,
              });
            }
            if (caught.launch_cause instanceof SurfaceGoneError) {
              return err(
                caught.launch_cause,
                surfaceGonePayload(caught.launch_cause, {
                  agent_id: caught.agent_id,
                  surface_id: caught.surface_id,
                  workspace_id: caught.workspace_id,
                }),
              );
            }
            return err(caught, {
              agent_id: caught.agent_id,
              surface_id: caught.surface_id,
              workspace_id: caught.workspace_id,
            });
          }
          if (caught instanceof DeliverySafetyGateError) {
            return err(caught, {
              ...createdIdentity,
              error_code: caught.error_code,
              submit_verified: caught.submit_verified,
              screen: caught.screen,
            });
          }
          if (caught instanceof SubmitVerificationError) {
            return err(caught, {
              ...createdIdentity,
              submit_verified: false,
              retry_count: caught.retry_count,
            });
          }
          if (caught instanceof SurfaceGoneError) {
            return err(caught, surfaceGonePayload(caught, createdIdentity));
          }
          if (caught instanceof BootPromptTimeoutError) {
            return err(caught, {
              ...createdIdentity,
              last_10_lines: caught.last_10_lines,
            });
          }
          if (caught instanceof BootPromptUpdateMenuBlockedError) {
            return err(caught, {
              ...createdIdentity,
              error_code: caught.error_code,
              last_10_lines: caught.last_10_lines,
              recovery: caught.recovery,
            });
          }
          if (caught instanceof BootPromptDeliveryError) {
            return err(caught, {
              ...createdIdentity,
              delivered_chars: caught.delivered_chars,
            });
          }
          return err(caught, createdIdentity);
        }
      },
    );

    server.tool(
      "spawn_in_workspace",
      `${PANE_INPUT_BREAKAGE_GUIDANCE} Create a workspace and spawn a set of agents into it as a clean 2-pane grid (commanders LEFT, workers RIGHT). Returns lean per-agent responses by default; pass verbose:true for the full legacy response. Handles workspace creation, selection, and role-based pane placement atomically. Use this instead of repeated spawn_agent calls when standing up a multi-agent team.`,
      {
        workspace_title: z
          .string()
          .describe("Title for the new workspace (e.g. 'red-team')"),
        agents: z
          .array(
            z.object({
              repo: z.string(),
              model: z.string(),
              cli: z.enum(["claude", "codex", "cursor", "gemini", "kiro"]),
              role: legacyCompatibleAgentRoleSchema().optional(),
              prompt: z
                .string()
                .optional()
                .describe(
                  `${PANE_INPUT_BREAKAGE_GUIDANCE} Optional inline boot prompt.`,
                ),
            }),
          )
          .min(1)
          .describe("Agents to spawn, in order"),
        reuse_workspace: z
          .string()
          .optional()
          .describe(
            "Ref of an existing workspace to use instead of creating a new one",
          ),
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Return the full legacy spawn response instead of the lean default.",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        const creation = new CreatedIdentityScope();
        const originFocus = await currentFocusTarget();
        let focusRestoreLease: FocusRestoreLease | null = null;
        let workspace: string | undefined;
        let lastSurface: string | undefined;
        let activeSpawnIdentity:
          | {
              agent_id: string;
              surface_id: string;
              workspace_id: string | null;
            }
          | undefined;
        const createdAgentIdentities: Array<{
          agent_id: string;
          surface_id: string;
          workspace_id: string | null;
        }> = [];
        const spawnedAgents: Array<{
          agent_id: string;
          surface_id: string;
          repo: string;
          cli: CliType;
          role: AgentRole;
          health?: ReturnType<typeof evaluateAgentHealth>;
          monitor_boot?: MonitorBootResult;
          boot_prompt_delivered?: boolean;
          boot_prompt_receipt?: PublicDeliveryReceipt & {
            bytes: number;
            prompt_text: string | null;
            prompt_warning: string | null;
          };
          boot_prompt_submit_verified?: boolean | null;
        }> = [];
        const leanSpawnedAgents: Record<string, unknown>[] = [];
        try {
          const normalizedAgents = args.agents.map((agent) => {
            assertSpawnPromptInputAllowed({
              tool: "spawn_in_workspace",
              value: agent.prompt,
              cli: agent.cli,
              allowLongInlineSupported: false,
            });
            const normalizedRole = normalizeToolAgentRole(agent.role, "role");
            return {
              ...agent,
              role: normalizedRole.role,
              compatibilityWarning: normalizedRole.warning,
            };
          });
          for (const agent of normalizedAgents) {
            resolveSpawnModelPolicy(agent.cli, agent.model);
          }
          const compatibilityWarnings = normalizedAgents.flatMap((agent) =>
            agent.compatibilityWarning ? [agent.compatibilityWarning] : [],
          );
          if (args.reuse_workspace) {
            for (const agent of normalizedAgents) {
              await assertWorkspaceBelongsToRepo(
                args.reuse_workspace,
                agent.repo,
              );
            }
          }
          await assertWorkspaceMutationAllowed(
            "spawn_in_workspace",
            args.reuse_workspace ?? (await currentSafetyCallerWorkspace()),
          );
          // A newly created workspace may auto-focus immediately, so capture
          // the user's origin before createWorkspace can move it.
          const workspaceResult = args.reuse_workspace
            ? { workspace: args.reuse_workspace, title: args.workspace_title }
            : await client.createWorkspace(args.workspace_title);
          workspace = workspaceResult.workspace;
          if (!workspace) {
            throw new Error("create_workspace returned an empty workspace ref");
          }
          creation.record({ workspace, workspace_id: workspace });

          focusRestoreLease = await focusTargetBeforeSplit(
            workspace,
            true,
            originFocus,
          );
          // focusTargetBeforeSplit ensures the target is selected when cmux's
          // current focus cannot prove it already is. The lease drives
          // focus-back only while the user has not moved since cmuxlayer's
          // latest placement mutation.
          focusRestoreLease = await capturePostCreationFocus(focusRestoreLease);

          for (const agent of normalizedAgents) {
            const hasPrompt = hasInlinePrompt(agent.prompt);
            activeSpawnIdentity = undefined;
            const result = await engine.spawnAgent({
              repo: agent.repo,
              model: agent.model,
              cli: agent.cli,
              prompt: agent.prompt ?? "",
              boot_prompt_pending: true,
              workspace,
              role: agent.role,
              auto_archive_on_done: false,
              on_surface_created: async (created) => {
                const identity = {
                  agent_id: created.agent_id,
                  surface_id: created.surface,
                  workspace_id: created.workspace ?? workspace ?? null,
                };
                creation.record(identity);
                creation.append(
                  "agents",
                  identity,
                  (left, right) => left.surface_id === right.surface_id,
                );
                focusRestoreLease = await capturePostCreationFocus(
                  focusRestoreLease,
                  created,
                );
              },
            });
            activeSpawnIdentity = {
              agent_id: result.agent_id,
              surface_id: result.surface_id,
              workspace_id: result.workspace_id ?? workspace ?? null,
            };
            creation.record(activeSpawnIdentity);
            creation.append(
              "agents",
              activeSpawnIdentity,
              (left, right) => left.surface_id === right.surface_id,
            );
            createdAgentIdentities.push(activeSpawnIdentity);
            lastSurface = result.surface_id;
            const originalLaunchCommand = originalLaunchCommandsBySurface.get(
              result.surface_id,
            );
            originalLaunchCommandsBySurface.delete(result.surface_id);
            const launchShellRecovery = launchShellRecoveryBySurface.get(
              result.surface_id,
            );
            launchShellRecoveryBySurface.delete(result.surface_id);
            const monitorBoot = ensureMonitorBoot(result.agent_id);
            // P11b: pointer form here too, so no spawn path keeps the ~479-char
            // inline contract on the wire. `null` because this batch path never
            // issued a coordination contract (P11 wired spawn_agent only), so
            // the file carries the mailbox half alone -- exactly what this path
            // delivered before, now via the pointer.
            const injectedBootPrompt = buildBootContractInjection(
              result.agent_id,
              monitorBoot,
              null,
            ).text;
            const spawnedBinding = engine.getAgentState(result.agent_id);
            appendStaleBuildWarning(result);
            let bootPromptDelivery:
              Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;

            {
              const deliveryWorkspace = spawnDeliveryWorkspace(
                result,
                workspace,
              );
              bootPromptDelivery = await deliverBootPrompt({
                surface: result.surface_id,
                workspace: deliveryWorkspace,
                stableSurfaceIdentity: spawnedBinding?.surface_uuid,
                resolveRoute: spawnedBinding?.surface_uuid
                  ? () => resolveManagedDeliveryRoute(result.agent_id)
                  : undefined,
                cli: agent.cli,
                prompt: agent.prompt,
                injected_prompt: injectedBootPrompt,
                timeout_ms: BOOT_PROMPT_TIMEOUT_MS,
                onUpdateShellRelaunch: () =>
                  relaunchSpawnAgentAfterUpdate({
                    agentId: result.agent_id,
                    surface: result.surface_id,
                    workspace: deliveryWorkspace,
                    model: result.model ?? agent.model,
                    mcpEnv: result.mcp_env,
                    originalCommand: originalLaunchCommand,
                  }),
              });

              canonicalizeSpawnResult(result);
              activeSpawnIdentity.agent_id = result.agent_id;
              activeSpawnIdentity.workspace_id =
                result.workspace_id ?? workspace ?? null;
              const updated = stateMgr.updateRecord(result.agent_id, {
                ...bootPromptRegistryFields(
                  bootPromptDelivery.prompt_text ?? agent.prompt ?? "",
                ),
                boot_prompt_pending:
                  bootPromptDelivery.delivery_state === "queued",
                prompt_delivered:
                  hasPrompt && bootPromptDelivery.submit_verified === true,
                submit_verified: hasPrompt
                  ? bootPromptDelivery.submit_verified
                  : null,
              });
              registry.set(result.agent_id, updated);

              const current = engine.getAgentState(result.agent_id);
              if (
                current?.state === "booting" &&
                hasPrompt &&
                bootPromptDelivery.submit_verified === true
              ) {
                const ready = stateMgr.transition(result.agent_id, "ready");
                registry.set(result.agent_id, ready);
                result.state = "ready";
              } else if (current?.state === "ready") {
                result.state = "ready";
              }
            }

            await refreshManagedMetadataBestEffort(result.agent_id);
            const currentAgent = engine.getAgentState(result.agent_id);
            const role =
              currentAgent?.role ??
              inferAgentRole({
                role: agent.role,
                cli: agent.cli,
                launcherName: launcherNameForCli(agent.repo, agent.cli),
              });
            const topology = currentAgent
              ? await collectSurfaceTopology()
              : null;
            const health = currentAgent
              ? await evaluateServerAgentHealth(
                  currentAgent,
                  {
                    ...healthTopologyOverrides(currentAgent, topology),
                  },
                  topology,
                )
              : undefined;

            spawnedAgents.push({
              agent_id: result.agent_id,
              surface_id: result.surface_id,
              repo: agent.repo,
              cli: agent.cli,
              role,
              health,
              monitor_boot: monitorBoot,
              boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
              boot_prompt_receipt: bootPromptDelivery,
              boot_prompt_submit_verified:
                bootPromptDelivery?.submit_verified ?? null,
              ...(launchShellRecovery?.recovered
                ? {
                    readiness_recovered: true,
                    readiness_cleared: launchShellRecovery.cleared,
                  }
                : {}),
            });
            leanSpawnedAgents.push(
              shapeSpawnResponse({
                ...result,
                role,
                health,
                boot_prompt_delivered:
                  isBootPromptDelivered(bootPromptDelivery),
                boot_prompt_receipt: bootPromptDelivery,
                boot_prompt_submit_verified:
                  bootPromptDelivery?.submit_verified ?? null,
                ...(launchShellRecovery?.recovered
                  ? {
                      readiness_recovered: true,
                      readiness_cleared: launchShellRecovery.cleared,
                    }
                  : {}),
              }),
            );
          }

          const focusRestoreWarning = await restoreFocusAfterRender(
            focusRestoreLease,
            lastSurface,
            workspace,
            { waitForReady: false },
          );

          // spawn_in_workspace builds its response from the per-agent objects,
          // which drop each result.warnings — so surface the stale-build warning
          // at the aggregate level (otherwise a stale MCP serving a multi-agent
          // workspace spawn would return NO warning).
          const staleWarning = staleBuildWarning();
          const workspaceWarnings = [
            ...(staleWarning ? [staleWarning] : []),
            ...(focusRestoreWarning ? [focusRestoreWarning] : []),
            ...compatibilityWarnings,
          ];

          const formattedData = {
            workspace,
            agents: spawnedAgents.length,
            ...(workspaceWarnings.length > 0
              ? { warning: workspaceWarnings.join(" | ") }
              : {}),
          };
          const responseData = {
            workspace,
            title: workspaceResult.title,
            agents: spawnedAgents,
            ...(workspaceWarnings.length > 0
              ? { warnings: workspaceWarnings }
              : {}),
          };
          return buildSpawnToolReturn(
            {
              retry_count: currentTransportRetryCount(),
              ...responseData,
            },
            args.verbose,
            formatOk("spawn_in_workspace", formattedData),
            {
              workspace,
              title: workspaceResult.title,
              agents: leanSpawnedAgents,
              ...(workspaceWarnings.length > 0
                ? { warnings: workspaceWarnings }
                : {}),
            },
          );
        } catch (e) {
          const caught = creation.attach(e);
          await restoreFocusAfterRender(
            focusRestoreLease,
            lastSurface,
            workspace,
            { waitForReady: false },
          );
          const failedIdentity =
            caught instanceof AgentLaunchError
              ? {
                  agent_id: caught.agent_id,
                  surface_id: caught.surface_id,
                  workspace_id: caught.workspace_id ?? null,
                }
              : activeSpawnIdentity;
          const failureAgents = [...createdAgentIdentities];
          if (
            failedIdentity &&
            !failureAgents.some(
              (candidate) =>
                candidate.agent_id === failedIdentity.agent_id &&
                candidate.surface_id === failedIdentity.surface_id,
            )
          ) {
            failureAgents.push(failedIdentity);
          }
          const failureIdentityPayload = {
            ...(workspace ? { workspace, workspace_id: workspace } : {}),
            ...(failedIdentity ?? {}),
            ...(failureAgents.length > 0 ? { agents: failureAgents } : {}),
          };
          if (caught instanceof AgentLaunchError) {
            if (caught.launch_cause instanceof DeliverySafetyGateError) {
              creation.attach(caught.launch_cause);
              return err(caught.launch_cause, {
                ...failureIdentityPayload,
                error_code: caught.launch_cause.error_code,
                submit_verified: caught.launch_cause.submit_verified,
                screen: caught.launch_cause.screen,
              });
            }
            if (caught.launch_cause instanceof SurfaceGoneError) {
              creation.attach(caught.launch_cause);
              return err(
                caught.launch_cause,
                surfaceGonePayload(caught.launch_cause, failureIdentityPayload),
              );
            }
            return err(caught, failureIdentityPayload);
          }
          if (caught instanceof DeliverySafetyGateError) {
            return err(caught, {
              ...failureIdentityPayload,
              error_code: caught.error_code,
              submit_verified: caught.submit_verified,
              screen: caught.screen,
            });
          }
          if (caught instanceof SubmitVerificationError) {
            return err(caught, {
              ...failureIdentityPayload,
              submit_verified: false,
              retry_count: caught.retry_count,
            });
          }
          if (caught instanceof SurfaceGoneError) {
            return err(
              caught,
              surfaceGonePayload(caught, failureIdentityPayload),
            );
          }
          if (caught instanceof BootPromptTimeoutError) {
            return err(caught, {
              ...failureIdentityPayload,
              last_10_lines: caught.last_10_lines,
            });
          }
          if (caught instanceof BootPromptUpdateMenuBlockedError) {
            return err(caught, {
              ...failureIdentityPayload,
              error_code: caught.error_code,
              last_10_lines: caught.last_10_lines,
              recovery: caught.recovery,
            });
          }
          if (caught instanceof BootPromptDeliveryError) {
            return err(caught, {
              ...failureIdentityPayload,
              delivered_chars: caught.delivered_chars,
            });
          }
          return err(caught, failureIdentityPayload);
        }
      },
    );

    // 12. wait_for
    server.tool(
      "wait_for",
      "Block until one agent_id or every agent in ids reaches a target registry state and return health. Defaults to waiting for completion (`done`).",
      {
        watch: WatchSpecSchema.optional().describe(
          "Declared WatchSpec alternative to agent_id/ids",
        ),
        agent_id: z
          .string()
          .optional()
          .describe("Single agent ID from spawn_agent"),
        delivery_id: z
          .string()
          .optional()
          .describe(
            "Wait for a send_to delivery_id to reach a terminal outcome",
          ),
        ids: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Agent IDs to wait for together"),
        mine: z
          .boolean()
          .optional()
          .default(false)
          .describe("Wait for every direct child of the calling agent"),
        target_state: z
          .enum(["ready", "working", "idle", "done", "error"])
          .optional()
          .describe("State to wait for"),
        condition: z
          .enum(["ready", "working", "idle", "done", "error"])
          .optional()
          .describe("Alias for target_state"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .default(300000)
          .describe("Timeout in milliseconds (default: 5 minutes)"),
      },
      ANNOTATIONS.mutating,
      async (args, extra) => {
        const progressToken = extra._meta?.progressToken;
        let progress = 0;
        const progressTimer =
          progressToken !== undefined
            ? setInterval(() => {
                progress += 1;
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress,
                      message: "wait_for still waiting",
                    },
                  })
                  .catch(() => {});
              }, 45_000)
            : null;
        progressTimer?.unref?.();
        try {
          if (args.watch) {
            if (args.agent_id || args.ids || args.mine || args.delivery_id) {
              throw new Error(
                "wait_for watch is mutually exclusive with agent_id, ids, mine, and delivery_id",
              );
            }
            const publicSpec = { ...(args.watch as WatchSpec) };
            delete (publicSpec as WatchSpec & { provenance?: unknown })
              .provenance;
            const result = await engine.waitForWatch(
              { ...publicSpec, provenance: "public" },
              args.timeout_ms,
            );
            return okFormatted(
              formatOk("wait_for", {
                watch_id: result.watch.watch_id,
                state: result.watch.state,
              }),
              result,
            );
          }
          if (args.delivery_id) {
            if (args.agent_id || args.ids || args.mine) {
              throw new Error(
                "wait_for delivery_id is mutually exclusive with agent_id, ids, and mine",
              );
            }
            const receipt = await engine.waitForDelivery(
              args.delivery_id,
              args.timeout_ms,
            );
            const data = {
              ...buildPublicDeliveryReceipt({
                delivery_id: receipt.delivery_id,
                delivery_state: receipt.delivery_state,
                typed: receipt.typed === true,
                submit_attempted: receipt.press_enter,
                submit_dispatched: receipt.submit_dispatched === true,
                submit_verified: receipt.submit_verified,
                retry_count: receipt.retry_count,
                rpc_methods: receipt.rpc_methods ?? [],
                needs_attention: receipt.needs_attention,
                attention_reason: receipt.attention_reason,
              }),
              agent_id: receipt.agent_id,
              ...(receipt.needs_attention === true
                ? {
                    needs_attention: true,
                    attention_reason: receipt.attention_reason,
                  }
                : {}),
              ...(receipt.timed_out ? { timed_out: true } : {}),
            };
            return okFormatted(formatOk("wait_for", data), data);
          }
          if (
            args.condition &&
            args.target_state &&
            args.condition !== args.target_state
          ) {
            throw new Error(
              "wait_for condition and target_state disagree; provide one state",
            );
          }
          const targetState = args.target_state ?? args.condition ?? "done";
          if (args.mine && (args.agent_id || args.ids)) {
            throw new Error(
              "wait_for mine=true is mutually exclusive with agent_id and ids",
            );
          }
          let waitIds = args.ids;
          if (args.mine) {
            const caller = resolveCurrentCallerAgent();
            if (!caller) {
              throw new Error(
                "wait_for mine=true requires a managed calling agent identity",
              );
            }
            waitIds = registry
              .getChildren(caller.agent_id)
              .map((agent) => agent.agent_id);
          }
          if (waitIds) {
            if (waitIds.length === 0) {
              return okFormatted(
                formatOk("wait_for", { count: 0, target: targetState }),
                { results: [], mine: args.mine },
              );
            }
            const results = await engine.waitForAll(
              waitIds,
              targetState,
              args.timeout_ms,
            );
            await Promise.all(
              results
                .map((result) => result.agent?.agent_id)
                .filter((agentId): agentId is string => Boolean(agentId))
                .map((agentId) => refreshManagedMetadataBestEffort(agentId)),
            );
            const topology = await collectSurfaceTopology();
            const enrichedResults = await Promise.all(
              results.map(async (result) => {
                const resultAgent = result.agent
                  ? engine.getAgentState(result.agent.agent_id)
                  : null;
                // T1b (#488): one observation feeds this reply's health block
                // AND its closure, so the two cannot contradict each other.
                const observed = resultAgent
                  ? await observeAgentOnce(resultAgent, topology)
                  : null;
                // P11 Contract B: a lead that BLOCKS on its children gets the
                // closure state in the reply it was already waiting for -- the
                // completion signal surfaces where the parent actually looks,
                // with no new carrier (#414: a carrier without a reader is not
                // a carrier).
                const harvest = resultAgent
                  ? engine.assessHarvestability(resultAgent, {
                      live: observed?.live ?? null,
                    })
                  : null;
                const health = resultAgent
                  ? await evaluateServerAgentHealth(
                      resultAgent,
                      {
                        ...healthTopologyOverrides(resultAgent, topology),
                        ...(observed?.screenOverrides ?? {}),
                        ...(harvest ? { harvestability: harvest } : {}),
                      },
                      topology,
                    )
                  : undefined;
                return {
                  ...result,
                  registry_state: resultAgent?.state ?? null,
                  screen_confirmed_state: health?.screen_confirmed_state ?? null,
                  health,
                  ...(harvest
                    ? {
                        closure: harvest.closure,
                        closure_artifact_verified:
                          harvest.closure_artifact_verified,
                        report_path: harvest.report_path,
                        done_marker: harvest.done_marker,
                      }
                    : {}),
                  agent:
                    result.agent && health
                      ? { ...result.agent, health }
                      : result.agent,
                };
              }),
            );
            return okFormatted(
              formatOk("wait_for", {
                count: results.length,
                target: targetState,
              }),
              { results: enrichedResults },
            );
          }
          if (!args.agent_id) {
            throw new Error("wait_for requires agent_id, ids, or delivery_id");
          }
          const result = await engine.waitFor(
            args.agent_id,
            targetState,
            args.timeout_ms,
          );
          await refreshManagedMetadataBestEffort(result.agent?.agent_id);
          const resultAgent = result.agent
            ? engine.getAgentState(result.agent.agent_id)
            : null;
          const topology = resultAgent ? await collectSurfaceTopology() : null;
          const health = resultAgent
            ? await evaluateServerAgentHealth(
                resultAgent,
                {
                  ...healthTopologyOverrides(resultAgent, topology),
                },
                topology,
              )
            : undefined;
          return okFormatted(
            formatOk("wait_for", {
              agent_id: args.agent_id,
              state: result.state,
              health,
            }),
            {
              agent_id: args.agent_id,
              ...result,
              registry_state: resultAgent?.state ?? null,
              screen_confirmed_state: health?.screen_confirmed_state ?? null,
              health,
              agent:
                result.agent && health
                  ? { ...result.agent, health }
                  : result.agent,
            },
          );
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              submit_verified: false,
              retry_count: e.retry_count,
            });
          }
          return err(e);
        } finally {
          if (progressTimer) clearInterval(progressTimer);
        }
      },
    );

    // 13. wait_for_all
    server.tool(
      "wait_for_all",
      "Block until ALL agents reach a target registry state OR any agent errors, returning per-agent health with partial results. When agents have file-backed goal contracts, returned health includes artifact-backed harvestability by reading referenced reports and DONE markers.",
      {
        agent_ids: z.array(z.string()).describe("Array of agent IDs"),
        target_state: z
          .enum(["ready", "working", "idle", "done", "error"])
          .describe("State to wait for"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .default(300000)
          .describe("Timeout in milliseconds (default: 5 minutes)"),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          const results = await engine.waitForAll(
            args.agent_ids,
            args.target_state,
            args.timeout_ms,
          );
          await Promise.all(
            results
              .map((result) => result.agent?.agent_id)
              .filter((agentId): agentId is string => Boolean(agentId))
              .map((agentId) => refreshManagedMetadataBestEffort(agentId)),
          );
          const topology = await collectSurfaceTopology();
          const enrichedResults = await Promise.all(
            results.map(async (result) => {
              const resultAgent = result.agent
                ? engine.getAgentState(result.agent.agent_id)
                : null;
              const health = resultAgent
                ? await evaluateServerAgentHealth(
                    resultAgent,
                    {
                      ...healthTopologyOverrides(resultAgent, topology),
                    },
                    topology,
                  )
                : undefined;
              return {
                ...result,
                health,
                agent:
                  result.agent && health
                    ? { ...result.agent, health }
                    : result.agent,
              };
            }),
          );
          return okFormatted(
            formatOk("wait_for_all", {
              count: results.length,
              target: args.target_state,
            }),
            { results: enrichedResults },
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    // 14. get_agent_state
    server.tool(
      "get_agent_state",
      "Get the full registry state of an agent, including cli_session_id/resume data, health, and artifact-backed harvestability. Health may flag missing sessions, dead inbox monitors, topology drift, registry/screen disagreement, or unverified worker closure artifacts.",
      {
        agent_id: z.string().describe("Agent ID"),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          await refreshManagedMetadataBestEffort(args.agent_id);
          const state = engine.getAgentState(args.agent_id);
          if (!state)
            return err(new Error(`Agent not found: ${args.agent_id}`));
          const topology = await collectSurfaceTopology();
          // T1b (#488): the screen this response reports on is the screen its
          // closure is resolved from. Read once, used by both.
          const observed = await observeAgentOnce(state, topology);
          const harvestability = engine.assessHarvestability(state, {
            live: observed.live,
          });
          const authorizedBinding = resolveAuthorizedAgentSurfaceBinding(
            state,
            topology,
          );
          const [health, pendingCodexFill] = await Promise.all([
            evaluateServerAgentHealth(
              state,
              {
                ...healthTopologyOverrides(state, topology),
                ...observed.screenOverrides,
                harvestability,
              },
              topology,
            ),
            readCodexRolloutFill(authorizedBinding ? state : null),
          ]);
          const codexFill = await validateCodexRolloutFill(
            authorizedBinding ? state : null,
            authorizedBinding?.surfaceRef ?? null,
            pendingCodexFill,
          );
          const formatted =
            formatAgentState(state) +
            `\nharvestability: ${
              harvestability.closeable ? "closeable" : "not closeable"
            }` +
            `\nhealth: ${health.status}${
              health.issues.length > 0 ? ` (${health.issues.join("; ")})` : ""
            }` +
            `\ntoken_count: ${codexFill?.token_count ?? "unknown"}` +
            `\ncontext_window: ${codexFill?.context_window ?? "unknown"}` +
            `\ncontext_pct: ${codexFill?.context_pct ?? "unknown"}`;
          const payload = {
            ...toAgentStatePayload(state),
            harvestability,
            health,
            token_count: codexFill?.token_count ?? null,
            context_window: codexFill?.context_window ?? null,
            context_pct: codexFill?.context_pct ?? null,
          };
          return okFormatted(
            formatted,
            payload as unknown as Record<string, unknown>,
          );
        } catch (e) {
          return err(e);
        }
      },
    );
    // 15. list_agents (src/mcp/tools/agent.ts, CX-3b S10a)
    registerListAgentsTool(server, {
      awaitLifecycleStart,
      client,
      collectSurfaceTopology,
      discovery,
      engine,
      evaluateServerAgentHealth,
      registry,
      resolveCurrentCallerAgent,
      seatRegistry,
    });

    const resolveBroadcastCallerRefs = async (): Promise<Set<string>> => {
      const refs = new Set<string>();
      const add = (value: string | undefined): void => {
        const trimmed = value?.trim();
        if (trimmed) refs.add(trimmed);
      };
      add(process.env.CMUX_AGENT_ID);
      add(process.env.CMUX_TAB_ID);
      add(process.env.CMUX_SURFACE_ID);

      for (const surface of [
        process.env.CMUX_SURFACE_ID,
        process.env.CMUX_TAB_ID,
      ]) {
        if (!surface?.trim()) continue;
        try {
          const identified = await client.identify(surface.trim());
          add(identified.caller?.surface_ref);
          add(identified.focused?.surface_ref);
        } catch {
          // Caller identity is best-effort. Explicit env refs above still apply.
        }
      }
      return refs;
    };

    const broadcastSkipReason = async (
      agent: AgentRecord,
    ): Promise<string | null> => {
      if (agent.state === "error") {
        let livenessTarget: Pick<AgentRecord, "surface_id" | "surface_uuid"> =
          agent;
        try {
          livenessTarget = await engine.resolveAgentIoRoute(agent.agent_id);
        } catch {
          // Preserve the existing registry/PTY liveness semantics when no
          // fresh I/O route can be established.
        }
        if (
          await registry.isSurfaceAlive(livenessTarget, {
            ptyDead:
              surfaceWriteLiveness.observe(
                livenessTarget.surface_id,
                livenessTarget.surface_uuid,
                context.surfaceObserverId,
              )?.pty_dead === true,
          })
        ) {
          return null;
        }
      }
      if (TERMINAL_AGENT_STATES.has(agent.state)) {
        return `dead:${agent.state}`;
      }
      if (!INTERACTIVE_AGENT_STATES.has(agent.state)) {
        return `not_interactive:${agent.state}`;
      }
      return null;
    };

    const agentSeatLabel = (agent: AgentRecord): string =>
      agent.seat_id?.trim() || agent.surface_id || agent.agent_id;

    const collectTargetRecords = async (): Promise<AgentRecord[]> => {
      try {
        return await engine.runLifecycleMutation(
          async () => {
            try {
              discovery.invalidate();
              const discovered = await discovery.scan(true);
              return await registry.listMerged(discovery, {
                force: true,
                discovered,
              });
            } catch (error) {
              if (
                !(error instanceof SurfaceBindingChangedDuringDiscoveryError)
              ) {
                throw error;
              }
              discovery.invalidate();
              return registry.listMerged(discovery, { force: true });
            }
          },
          { label: "collect-target-records" },
        );
      } catch (e) {
        if (isSurfaceEnumerationError(e)) {
          throw new Error(
            `Refusing target resolution because live surface enumeration failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        throw e;
      }
    };

    server.tool(
      "broadcast",
      `${PANE_INPUT_BREAKAGE_GUIDANCE} Fan out a short pointer-style message to registered agents by role using the same guarded delivery path as send_to. Defaults to role=leads (orchestrator). Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} UTF-8 bytes. Returns per-agent receipts so one failed target never hides the rest. ${ZSH_BANG_INLINE_WARNING}`,
      {
        text: BroadcastArgsSchema.shape.text.describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Message to broadcast. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes.`,
        ),
        role: BroadcastArgsSchema.shape.role.describe(
          "Target role set: leads means orchestrator; workers means worker; all means every registered agent.",
        ),
        exclude: BroadcastArgsSchema.shape.exclude.describe(
          "Agent IDs to skip in addition to the caller's own agent.",
        ),
        workspace: BroadcastArgsSchema.shape.workspace.describe(
          "Optional workspace ref/id to scope targets. Omit to broadcast across all workspaces.",
        ),
        press_enter: BroadcastArgsSchema.shape.press_enter.describe(
          "Press enter after sending the text to each target.",
        ),
      },
      ANNOTATIONS.mutating,
      async (rawArgs) => {
        try {
          await awaitLifecycleStart();
          const parsedArgs = BroadcastArgsSchema.safeParse(rawArgs);
          if (!parsedArgs.success) {
            return err(
              new Error(
                formatToolValidationError("broadcast", parsedArgs.error),
              ),
            );
          }
          const args = parsedArgs.data;
          assertBroadcastInlineInputAllowed(args.text);

          const scopedWorkspace = await canonicalWorkspaceRef(args.workspace);
          const excludedAgentIds = new Set(args.exclude);
          const callerRefs = await resolveBroadcastCallerRefs();
          const workspaceMatches = (agent: AgentRecord): boolean =>
            !scopedWorkspace ||
            agent.workspace_id === scopedWorkspace ||
            agent.workspace_id === args.workspace;
          const isCaller = (agent: AgentRecord): boolean =>
            callerRefs.has(agent.agent_id) || callerRefs.has(agent.surface_id);

          const targets = (await collectTargetRecords()).filter(
            (agent) =>
              broadcastRoleMatches(
                args.role,
                inferBroadcastRecordRole(agent),
              ) &&
              workspaceMatches(agent) &&
              !excludedAgentIds.has(agent.agent_id) &&
              !isCaller(agent),
          );

          const receipts: BroadcastReceipt[] = [];
          for (const agent of targets) {
            const skipped = await broadcastSkipReason(agent);
            if (skipped) {
              receipts.push({
                agent_id: agent.agent_id,
                seat: agentSeatLabel(agent),
                delivered: false,
                submit_verified: null,
                skipped,
              });
              continue;
            }

            try {
              const delivery = await deliverAgentInput({
                agent_id: agent.agent_id,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
              });
              const nonterminalDelivery =
                delivery.delivery_state === "queued" ||
                delivery.delivery_state === "queued_followup" ||
                delivery.delivery_state === "pending_verify" ||
                delivery.delivery_state === "rescued";
              receipts.push({
                agent_id: agent.agent_id,
                seat: agentSeatLabel(agent),
                delivered: !nonterminalDelivery,
                delivery_state: delivery.delivery_state,
                submit_verified: delivery.submit_verified,
                ...(delivery.delivery_state === "rescued"
                  ? {
                      error: "Prompt appeared only after an external interrupt",
                    }
                  : {}),
              });
            } catch (e) {
              receipts.push({
                agent_id: agent.agent_id,
                seat: agentSeatLabel(agent),
                delivered: false,
                submit_verified:
                  e instanceof SubmitVerificationError
                    ? false
                    : e instanceof DeliverySafetyGateError
                      ? e.submit_verified
                      : null,
                ...(e instanceof SubmitVerificationError
                  ? {
                      submit_verification_reason: e.reason,
                      retry_safe: e.retry_safe,
                    }
                  : {}),
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          const deliveredCount = receipts.filter(
            (receipt) => receipt.delivered,
          ).length;
          const skippedCount = receipts.filter(
            (receipt) => receipt.skipped,
          ).length;
          const failedCount = receipts.length - deliveredCount - skippedCount;
          const data = {
            role: args.role,
            target_count: receipts.length,
            delivered_count: deliveredCount,
            failed_count: failedCount,
            skipped_count: skippedCount,
            receipts: receipts as unknown as Record<string, unknown>[],
          };
          return okFormatted(
            `broadcast ${args.role}: ${deliveredCount} delivered, ${failedCount} failed, ${skippedCount} skipped`,
            data,
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    server.tool(
      "resync_agents",
      "Removed. Reconciliation runs automatically on list_agents: fresh discovery, orphan repair, and ghost eviction carrying a same-cycle live-seat proof. Role reflow runs on the periodic sweep. Call list_agents.",
      {},
      ANNOTATIONS.readOnly,
      // AIDEV-NOTE (#481): the original body was kept here behind an early
      // return as an unreachable rollback reference, which made three
      // capabilities look covered while their only producer/consumer sat in
      // dead code. It is deleted; `liveSeatProof` and `parsed_cli_mismatch`
      // now run on the live list_agents path, and orphan surfaces are already
      // visible there as auto-discovered rows.
      async () =>
        err(
          new Error(
            "resync_agents was removed; call list_agents for an automatically refreshed live view",
          ),
        ),
    );

    // 16. stop_agent
    const reapTailAfterConfirmedExit = async (
      target: AgentRecord | null,
    ) => {
      // A missing PID is not proof that the agent has stopped. Keep the
      // recorded tail until the process identity is known to be gone.
      if (!target?.pid || agentProcessLiveness(target) !== "gone") return {};
      return reapInboxTail(target.agent_id, inboxOpts);
    };
    server.tool(
      "stop_agent",
      "Stop an agent gracefully (Ctrl+C) or forcefully (kill process).",
      {
        agent_id: z.string().describe("Agent ID to stop"),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe("Force kill instead of graceful Ctrl+C"),
      },
      ANNOTATIONS.destructive,
      async (args) => {
        const target = engine.getAgentState(args.agent_id);
        try {
          await engine.stopAgent(args.agent_id, args.force, {
            allowUnknownPidOwnedSurfaceClose:
              (args as typeof args & {
                [OWNED_AGENT_CLOSE_ON_UNKNOWN_PID]?: boolean;
              })[OWNED_AGENT_CLOSE_ON_UNKNOWN_PID] === true,
            beforeSurfaceMutation: (route) =>
              assertSurfaceMutationAllowed(
                "stop_agent",
                route.surface_id,
                route.workspace_id ?? undefined,
              ),
          });
          const tailOutcome = await reapInboxTail(target?.agent_id ?? args.agent_id, inboxOpts);
          pruneChildReportWatchesFor(args.agent_id);
          const state = engine.getAgentState(args.agent_id);
          appendCloseEvent({
            event: "stop_agent",
            target: args.agent_id,
            caller: resolveCloseCaller("stop_agent"),
            force: args.force ?? false,
            reason: `state after stop: ${state?.state ?? "done"}`,
            refused: false,
          });
          const data = {
            agent_id: args.agent_id,
            state: state?.state ?? "done",
            ...tailOutcome,
          };
          return okFormatted(formatOk("stop_agent", data), data);
        } catch (e) {
          const tailOutcome = await reapTailAfterConfirmedExit(target).catch(() => ({}));
          return err(e, tailOutcome);
        }
      },
    );

    const observePausedTarget = async (
      agent: AgentRecord | null | undefined,
    ): Promise<{ paused: boolean; source: string }> => {
      if (agent?.paused === true) {
        return {
          paused: true,
          source: agent.paused_source ?? "inferred",
        };
      }
      if (!agent?.surface_id) {
        return { paused: false, source: "inferred" };
      }
      const snapshot = await readParsedSurface(
        agent.surface_id,
        agent.workspace_id ?? undefined,
      ).catch(() => null);
      if (snapshot?.parsed.paused === true) {
        engine.markObservedPause(agent.agent_id, true);
        return {
          paused: true,
          source: snapshot.parsed.paused_source,
        };
      }
      if (snapshot?.text && screenShowsPaused(snapshot.text)) {
        engine.markObservedPause(agent.agent_id, true);
        return { paused: true, source: "inferred" };
      }
      return { paused: false, source: "inferred" };
    };

    // 17. send_to
    server.tool(
      "send_to",
      "Send text or a key through the shared delivery engine. Never send a Return yourself for a message; send_to submits messages. Key-Return is for pickers, menus, and permission prompts. Every receipt includes caller_agent_id (null when unknown). Workers with collab_path cannot address their own parent or ancestor leads in any mode; append to that collab file instead. Unknown callers remain allowed. Lead-originated and engine-internal pushes remain allowed. Targets may be one agent, structured agent targeting, or a raw surface in surface/command/key mode. A clean verified success returns up to six mode-specific core fields by default: text/command mode returns ok, retry_count, target identity, delivery_state, submitted, and delivery_id when available; key mode returns ok, retry_count, surface, key, submit_verified, and submit_verification_reason. A degraded transport, queued-behind-turn landing, or deduplicated send adds its warning or status field. Pass verbose=true for the full legacy receipt; non-success keeps full diagnostics automatically.",
      {
        ...SendToArgsSchema.shape,
        text: SendToArgsSchema.shape.text.describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default.`,
        ),
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "Deprecated no-op. Safety gates still refuse text at a picker/menu or permission prompt; use mode=key to drive those deliberately.",
        ),
        allow_long_inline: SendToArgsSchema.shape.allow_long_inline.describe(
          "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
        ),
      },
      ANNOTATIONS.mutating,
      async (rawArgs) => {
        let failedReceiptPayload: Record<string, unknown> = {};
        try {
          // #611: an omitted mode is no longer an error -- the schema now
          // defaults it to "agent". Only an explicitly invalid value fails, and
          // that goes through the enum errorMap, which already carries a
          // copy-pasteable example.
          if ("message" in rawArgs || "command" in rawArgs || "key" in rawArgs) {
            throw new Error(
              "send_to accepts one payload parameter: text. " +
                SEND_TO_WORKING_EXAMPLE,
            );
          }
          for (const field of ["surface", "target"] as const) {
            if (typeof rawArgs[field] === "number") {
              throw new Error(
                `bare surface index ${JSON.stringify(rawArgs[field])} is not allowed; use surface:<index> ref or a surface UUID`,
              );
            }
          }
          const parsedArgs = SendToArgsSchema.safeParse(rawArgs);
          if (!parsedArgs.success) {
            return err(
              new Error(formatToolValidationError("send_to", parsedArgs.error)),
            );
          }

          const args = parsedArgs.data;
          const mode = args.mode;
          if (!mode) {
            // Defensive only: the schema default makes this unreachable. If it
            // ever fires, say what to do rather than what went wrong (#611).
            throw new Error(
              `mode required (agent|surface|command|key). ${SEND_TO_WORKING_EXAMPLE}`,
            );
          }
          if (args.targeting && mode !== "agent") {
            throw new Error(
              "send_to.targeting is supported only in mode=agent",
            );
          }
          if (mode !== "agent") {
            const surface = args.surface ?? args.target;
            if (!surface) {
              throw new Error(
                `send_to mode=${mode} requires target or surface`,
              );
            }
            assertCanonicalSurfaceRef(surface);
            assertWorkerUpwardChannel(surface);
            const legacyHandler = (name: string) => {
              const handler = toolHandlersByName.get(name);
              if (!handler) {
                throw new Error(`Internal tool handler unavailable: ${name}`);
              }
              return handler;
            };
            if (mode === "surface") {
              if (args.text === undefined) {
                throw new Error("send_to mode=surface requires text");
              }
              const deliveryId = randomUUID();
              const timings = createDeliveryPhaseTimings();
              return withSurfaceDeliveryTimings(
                await legacyHandler("send_input")(
                  {
                    surface,
                    workspace: args.workspace,
                    text: args.text,
                    chunk_size: args.chunk_size,
                    background: args.background,
                    press_enter: args.press_enter,
                    rename_to_task: args.rename_to_task,
                    allow_long_inline: args.allow_long_inline,
                    _cmuxlayer_source_event: "send_to",
                    _cmuxlayer_delivery_id: deliveryId,
                    _cmuxlayer_timings: timings,
                  },
                  {},
                ),
                timings,
              );
            }
            if (mode === "command") {
              const command = args.text;
              if (command === undefined) {
                throw new Error("send_to mode=command requires text");
              }
              return legacyHandler("send_command")(
                {
                  surface,
                  workspace: args.workspace,
                  command,
                  boot_prompt_path: args.boot_prompt_path,
                  boot_prompt_timeout_ms: args.boot_prompt_timeout_ms,
                  allow_long_inline: args.allow_long_inline,
                },
                {},
              );
            }
            if (!args.text) {
              throw new Error("send_to mode=key requires text");
            }
            return legacyHandler("send_key")(
              { surface, workspace: args.workspace, key: args.text },
              {},
            );
          }

          if (args.targeting && (args.agent_id || args.target)) {
            throw new Error(
              "send_to accepts either targeting or agent_id/target, not both",
            );
          }
          if (!args.targeting && !args.agent_id && !args.target) {
            throw new Error(
              "send_to mode=agent requires agent_id/target or targeting",
            );
          }
          if (args.text === undefined) {
            throw new Error("send_to mode=agent requires text");
          }
          args.text = sanitizeTerminalInput(args.text);
          assertInlineInputAllowed({
            tool: "send_to",
            arg: "text",
            value: args.text,
            allowLongInline: args.allow_long_inline,
          });
          assertDenseInlineInputAllowed({
            tool: "send_to",
            arg: "text",
            value: args.text,
            allowLongInline: args.allow_long_inline,
          });
          if (args.targeting) {
            await awaitLifecycleStart();
            const allTargets = await collectTargetRecords();
            const excludedIds = new Set(args.targeting.exclude);
            const scopedWorkspace = await canonicalWorkspaceRef(
              args.targeting.workspace,
            );
            type TargetPlan = {
              requested_agent_id?: string;
              agent?: Readonly<AgentRecord>;
              resolution: "resolved" | "filtered_out" | "unknown";
              predicate?: "exclude" | "role" | "workspace";
            };
            const filterPredicate = (
              agent: AgentRecord,
            ): TargetPlan["predicate"] | null => {
              if (excludedIds.has(agent.agent_id)) return "exclude";
              if (
                args.targeting?.role &&
                agent.function !== args.targeting.role
              ) {
                return "role";
              }
              if (
                scopedWorkspace &&
                agent.workspace_id !== scopedWorkspace &&
                agent.workspace_id !== args.targeting?.workspace
              ) {
                return "workspace";
              }
              return null;
            };
            const targetPlan: TargetPlan[] = [];
            if (args.targeting.agent_ids) {
              for (const requestedId of args.targeting.agent_ids) {
                const exact = allTargets.find(
                  (agent) => agent.agent_id === requestedId,
                );
                const candidates = exact
                  ? [exact]
                  : allTargets.filter((agent) =>
                      agent.agent_id.startsWith(requestedId),
                    );
                if (candidates.length > 1) {
                  throw new Error(
                    `Ambiguous agent_id prefix "${requestedId}"; candidates: ${candidates
                      .map((agent) => agent.agent_id)
                      .sort()
                      .join(", ")}. Refusing to guess.`,
                  );
                }
                const agent = candidates[0];
                if (!agent) {
                  targetPlan.push({
                    requested_agent_id: requestedId,
                    resolution: "unknown",
                  });
                  continue;
                }
                const predicate = filterPredicate(agent);
                targetPlan.push({
                  requested_agent_id: requestedId,
                  agent: Object.freeze({ ...agent }),
                  resolution: predicate ? "filtered_out" : "resolved",
                  ...(predicate ? { predicate } : {}),
                });
              }
            } else {
              for (const agent of allTargets) {
                if (filterPredicate(agent)) continue;
                targetPlan.push({
                  agent: Object.freeze({ ...agent }),
                  resolution: "resolved",
                });
              }
            }
            const resolvedTargets = Object.freeze(
              targetPlan
                .filter(
                  (
                    entry,
                  ): entry is TargetPlan & { agent: Readonly<AgentRecord> } =>
                    entry.resolution === "resolved" &&
                    entry.agent !== undefined,
                )
                .map((entry) => entry.agent),
            );
            for (const agent of resolvedTargets) {
              assertWorkerUpwardChannel(agent.agent_id);
              assertInteractiveMultilineInputAllowed({
                tool: "send_to",
                value: args.text,
                cli: agent.cli,
                allowLongInline: args.allow_long_inline,
              });
            }
            const mutableReceipts: Array<Record<string, unknown>> = [];
            for (const plan of targetPlan) {
              if (plan.resolution !== "resolved" || !plan.agent) {
                mutableReceipts.push({
                  ...(plan.requested_agent_id
                    ? { requested_agent_id: plan.requested_agent_id }
                    : {}),
                  ...(plan.agent ? { agent_id: plan.agent.agent_id } : {}),
                  resolution: plan.resolution,
                  ...(plan.predicate ? { predicate: plan.predicate } : {}),
                  ...buildPublicDeliveryReceipt({
                    typed: false,
                    submit_attempted: false,
                    submit_verified: null,
                    retry_count: 0,
                  }),
                  accepted: false,
                  skipped:
                    plan.resolution === "unknown"
                      ? "unknown_agent_id"
                      : `filtered_out:${plan.predicate}`,
                });
                continue;
              }
              const agent = plan.agent;
              const resolutionMetadata = plan.requested_agent_id
                ? {
                    requested_agent_id: plan.requested_agent_id,
                    resolution: "resolved",
                  }
                : {};
              const skipped =
                agent.state === "working"
                  ? null
                  : await broadcastSkipReason(agent);
              if (skipped) {
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    typed: false,
                    submit_attempted: false,
                    submit_verified: null,
                    retry_count: 0,
                  }),
                  accepted: false,
                  skipped,
                });
                continue;
              }
              const duplicate = engine.findOpenDuplicate({
                agent_id: agent.agent_id,
                text: args.text,
                press_enter: args.press_enter,
              });
              if (duplicate) {
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  duplicate_of: duplicate.delivery_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: duplicate.delivery_state,
                    delivery_id: duplicate.delivery_id,
                    typed: duplicate.typed === true,
                    submit_attempted: duplicate.press_enter,
                    submit_dispatched: duplicate.submit_dispatched,
                    submit_verified: duplicate.submit_verified,
                    retry_count: duplicate.retry_count,
                    rpc_methods: duplicate.rpc_methods ?? [],
                    needs_attention: duplicate.needs_attention,
                    attention_reason: duplicate.attention_reason,
                  }),
                  accepted: true,
                });
                continue;
              }
              const deliveryId = randomUUID();
              engine.acceptPendingVerify({
                delivery_id: deliveryId,
                agent_id: agent.agent_id,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
                retry_count: 0,
              });
              const livePaused = await observePausedTarget(agent);
              if (livePaused.paused) {
                const queued = engine.queueDelivery({
                  delivery_id: deliveryId,
                  agent_id: agent.agent_id,
                  text: args.text,
                  press_enter: args.press_enter,
                  source_event: "send_to",
                });
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: "queued",
                    delivery_id: queued.delivery_id,
                    typed: false,
                    submit_attempted: false,
                    submit_verified: queued.submit_verified,
                    retry_count: queued.retry_count,
                    WARNING: pausedTargetWarning(livePaused.source),
                  }),
                  accepted: true,
                });
                continue;
              }
              try {
                const delivery = await deliverAgentInput({
                  agent_id: agent.agent_id,
                  text: args.text,
                  press_enter: args.press_enter,
                  allow_busy: args.allow_busy,
                  source_event: "send_to",
                  delivery_id: deliveryId,
                });
                const accepted =
                  delivery.delivery === "queued" ||
                  delivery.delivery === "queued_followup"
                    ? engine.acceptComposerQueue({
                        delivery_id: deliveryId,
                        agent_id: agent.agent_id,
                        text: args.text,
                        press_enter: args.press_enter,
                        source_event: "send_to",
                        retry_count: delivery.retry_count,
                        rpc_methods: delivery.rpc_methods,
                        typed: delivery.typed,
                        submit_dispatched: delivery.submit_dispatched,
                        delivery_state: delivery.delivery,
                      })
                    : delivery.delivery === "pending_verify"
                      ? engine.acceptPendingVerify({
                          delivery_id: deliveryId,
                          agent_id: agent.agent_id,
                          text: args.text,
                          press_enter: args.press_enter,
                          source_event: "send_to",
                          retry_count: delivery.retry_count,
                          rpc_methods: delivery.rpc_methods,
                          typed: delivery.typed,
                          submit_dispatched: delivery.submit_dispatched,
                        })
                      : delivery.delivery === "rescued"
                        ? engine.resolveDelivery({
                            delivery_id: deliveryId,
                            agent_id: agent.agent_id,
                            text: args.text,
                            press_enter: args.press_enter,
                            source_event: "send_to",
                            delivery_state: "rescued",
                            terminal: true,
                            retry_count: delivery.retry_count,
                            rpc_methods: delivery.rpc_methods,
                            typed: delivery.typed,
                            submit_dispatched: delivery.submit_dispatched,
                            submit_verified: false,
                            error:
                              "Prompt appeared only after an external interrupt",
                          })
                        : delivery.delivery === "submitted"
                          ? engine.resolveDelivery({
                              delivery_id: deliveryId,
                              agent_id: agent.agent_id,
                              text: args.text,
                              press_enter: args.press_enter,
                              source_event: "send_to",
                              delivery_state: "submitted",
                              terminal: true,
                              retry_count: delivery.retry_count,
                              rpc_methods: delivery.rpc_methods,
                              typed: delivery.typed,
                              submit_dispatched: delivery.submit_dispatched,
                              submit_verified: delivery.submit_verified,
                              error: null,
                            })
                          : null;
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: accepted?.delivery_state,
                    delivery_id: accepted?.delivery_id ?? deliveryId,
                    typed: delivery.typed,
                    submit_attempted: delivery.submit_attempted,
                    submit_verified: delivery.submit_verified,
                    submit_evidence: delivery.submit_evidence,
                    retry_count: delivery.retry_count,
                    rpc_methods: delivery.rpc_methods,
                    submit_dispatched: delivery.submit_dispatched,
                    queued_behind_turn: delivery.queued_behind_turn,
                  }),
                  accepted: true,
                });
              } catch (error) {
                if (error instanceof AmbiguousBootRecoveryReturnError && error.receipt) {
                  mutableReceipts.push({
                    ...resolutionMetadata,
                    agent_id: agent.agent_id,
                    ...error.receipt,
                    accepted: false,
                    error: error.message,
                  });
                  continue;
                }
                const errorRpcMethods = deliveryRpcMethodsFromError(error);
                const errorTyped = deliveryTypedFromError(error);
                const errorSubmitDispatched =
                  deliverySubmitDispatchedFromError(error);
                if (
                  error instanceof RetryableDeliveryError &&
                  errorRpcMethods.length === 0 &&
                  !errorTyped &&
                  !errorSubmitDispatched
                ) {
                  const queued = engine.queueDelivery({
                    delivery_id: deliveryId,
                    agent_id: agent.agent_id,
                    text: args.text,
                    press_enter: args.press_enter,
                    source_event: "send_to",
                  });
                  mutableReceipts.push({
                    ...resolutionMetadata,
                    agent_id: agent.agent_id,
                    ...buildPublicDeliveryReceipt({
                      delivery_state: "queued",
                      delivery_id: queued.delivery_id,
                      typed: false,
                      submit_attempted: false,
                      submit_verified: queued.submit_verified,
                      retry_count: queued.retry_count,
                      WARNING: `Delivery is queued for retry, not delivered yet: ${error.message}`,
                    }),
                    accepted: true,
                  });
                  continue;
                }
                const failed = engine.resolveDelivery(
                  {
                    delivery_id: deliveryId,
                    agent_id: agent.agent_id,
                    text: args.text,
                    press_enter: args.press_enter,
                    source_event: "send_to",
                    delivery_state: "failed",
                    terminal: true,
                    retry_count:
                      error instanceof SubmitVerificationError
                        ? error.retry_count
                        : 0,
                    rpc_methods: errorRpcMethods,
                    typed: errorTyped,
                    submit_dispatched: errorSubmitDispatched,
                    submit_verified:
                      error instanceof SubmitVerificationError ? false : null,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                  {
                    appendFailureEvent: !(
                      error instanceof SubmitVerificationError
                    ),
                  },
                );
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: "failed",
                    delivery_id: failed.delivery_id,
                    typed:
                      error instanceof SubmitVerificationError
                        ? (error.receipt?.typed ?? true)
                        : errorTyped,
                    submit_attempted:
                      error instanceof SubmitVerificationError
                        ? (error.receipt?.submit_attempted ?? args.press_enter)
                        : args.press_enter,
                    submit_dispatched: errorSubmitDispatched,
                    submit_verified: failed.submit_verified,
                    retry_count: failed.retry_count,
                    rpc_methods: errorRpcMethods,
                  }),
                  accepted: false,
                  error: failed.error,
                });
              }
            }
            const receipts = Object.freeze(
              mutableReceipts.map((receipt) => Object.freeze({ ...receipt })),
            );
            const submittedCount = receipts.filter(
              (receipt) => receipt.delivery_state === "submitted",
            ).length;
            const queuedCount = receipts.filter(
              (receipt) => receipt.delivery_state === "queued",
            ).length;
            const pendingVerifyCount = receipts.filter(
              (receipt) => receipt.delivery_state === "pending_verify",
            ).length;
            const failedCount = receipts.filter(
              (receipt) =>
                receipt.delivery_state === "failed" ||
                receipt.delivery_state === "rescued",
            ).length;
            const skippedCount = receipts.filter(
              (receipt) => receipt.skipped !== undefined,
            ).length;
            const data = {
              targeting: Object.freeze({ ...args.targeting }),
              target_count: receipts.length,
              resolved_target_count: resolvedTargets.length,
              submitted_count: submittedCount,
              queued_count: queuedCount,
              pending_verify_count: pendingVerifyCount,
              delivered_count: submittedCount,
              failed_count: failedCount,
              skipped_count: skippedCount,
              receipts,
            };
            if (resolvedTargets.length === 0) {
              return err(
                new Error(
                  "send_to targeting resolved zero targets; refusing silent no-op",
                ),
                data,
              );
            }
            return okFormatted(
              `send_to targeting: ${submittedCount} submitted, ${queuedCount} queued${pendingVerifyCount ? `, ${pendingVerifyCount} pending verify` : ""}, ${failedCount} failed, ${skippedCount} skipped`,
              data,
            );
          }

          const agentId = args.agent_id ?? args.target;
          if (!agentId) {
            throw new Error("send_to mode=agent requires agent_id or target");
          }
          assertWorkerUpwardChannel(agentId);
          const timings = createDeliveryPhaseTimings();
          const targetAgent =
            engine.getAgentState(agentId) ?? registry.get(agentId);
          assertInteractiveMultilineInputAllowed({
            tool: "send_to",
            value: args.text,
            cli: targetAgent?.cli,
            allowLongInline: args.allow_long_inline,
          });
          const duplicate = engine.findOpenDuplicate({
            agent_id: agentId,
            text: args.text,
            press_enter: args.press_enter,
          });
          if (duplicate) {
            const data = {
              accepted: true,
              agent_id: agentId,
              duplicate_of: duplicate.delivery_id,
              ...buildPublicDeliveryReceipt({
                delivery_state: duplicate.delivery_state,
                delivery_id: duplicate.delivery_id,
                typed: duplicate.typed === true,
                submit_attempted: duplicate.press_enter,
                submit_dispatched: duplicate.submit_dispatched,
                submit_verified: duplicate.submit_verified,
                retry_count: duplicate.retry_count,
                rpc_methods: duplicate.rpc_methods ?? [],
                needs_attention: duplicate.needs_attention,
                attention_reason: duplicate.attention_reason,
                timings_ms: timings,
              }),
            };
            return okFormatted(
              `send_to duplicate_of ${duplicate.delivery_id}`,
              data,
            );
          }
          const deliveryId = randomUUID();
          engine.acceptPendingVerify({
            delivery_id: deliveryId,
            agent_id: agentId,
            text: args.text,
            press_enter: args.press_enter,
            source_event: "send_to",
            retry_count: 0,
          });
          const livePaused = await observePausedTarget(targetAgent);
          if (livePaused.paused) {
            const receipt = engine.queueDelivery({
              delivery_id: deliveryId,
              agent_id: agentId,
              text: args.text,
              press_enter: args.press_enter,
              source_event: "send_to",
            });
            const data = {
              accepted: true,
              agent_id: agentId,
              ...buildPublicDeliveryReceipt({
                delivery_state: "queued",
                delivery_id: receipt.delivery_id,
                typed: false,
                submit_attempted: false,
                submit_verified: receipt.submit_verified,
                retry_count: receipt.retry_count,
                timings_ms: timings,
                WARNING: pausedTargetWarning(livePaused.source),
              }),
            };
            return okFormatted(
              `WARNING — send_to queued; paused target ${agentId} cannot act`,
              data,
            );
          }
          let delivery: Awaited<ReturnType<typeof deliverAgentInput>>;
          // Observe the daemon scheduler during this send, not the benchmark
          // runner's event loop. The histogram reports nanoseconds.
          const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
          eventLoopDelay.enable();
          let eventLoopDelayStopped = false;
          const finishEventLoopDelay = () => {
            if (eventLoopDelayStopped) return;
            eventLoopDelayStopped = true;
            eventLoopDelay.disable();
            timings.event_loop_delay_max = Number.isFinite(eventLoopDelay.max)
              ? eventLoopDelay.max / 1_000_000 : 0;
            timings.event_loop_delay_mean = Number.isFinite(eventLoopDelay.mean)
              ? eventLoopDelay.mean / 1_000_000 : 0;
          };
          try {
            delivery = await deliverAgentInput({
              agent_id: agentId,
              text: args.text,
              press_enter: args.press_enter,
              allow_busy: args.allow_busy,
              source_event: "send_to",
              delivery_id: deliveryId,
              timings,
            });
          } catch (error) {
            // Failure receipts copy timings in this branch, before `finally`.
            finishEventLoopDelay();
            if (error instanceof AmbiguousBootRecoveryReturnError) {
              return err(error, { agent_id: agentId });
            }
            // AIDEV-NOTE (F1): a RetryableDeliveryError is, by name and by the
            // drain loop's own handling, NOT a terminal outcome -- the engine
            // backs it off and tries again. Flattening it into a terminal
            // `failed` receipt here would contradict the delivery engine's
            // retryable queue semantics and tell a lead its live worker was
            // dead. Hand back the queued receipt the drain loop will honour.
            const errorRpcMethods = deliveryRpcMethodsFromError(error);
            const errorTyped = deliveryTypedFromError(error);
            const errorSubmitDispatched =
              deliverySubmitDispatchedFromError(error);
            if (
              error instanceof RetryableDeliveryError &&
              errorRpcMethods.length === 0 &&
              !errorTyped &&
              !errorSubmitDispatched
            ) {
              const receipt = engine.queueDelivery({
                delivery_id: deliveryId,
                agent_id: agentId,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
              });
              const data = {
                accepted: true,
                agent_id: agentId,
                ...buildPublicDeliveryReceipt({
                  delivery_state: "queued",
                  delivery_id: receipt.delivery_id,
                  typed: false,
                  submit_attempted: false,
                  submit_verified: receipt.submit_verified,
                  retry_count: receipt.retry_count,
                  timings_ms: timings,
                  WARNING: `Delivery is queued for retry, not delivered yet: ${error.message}`,
                }),
              };
              return okFormatted(
                `send_to accepted — delivery ${receipt.delivery_id} queued for retry`,
                data,
              );
            }
            const failedReceipt = engine.resolveDelivery(
              {
                delivery_id: deliveryId,
                agent_id: agentId,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
                delivery_state: "failed",
                terminal: true,
                retry_count:
                  error instanceof SubmitVerificationError
                    ? error.retry_count
                    : 0,
                rpc_methods: errorRpcMethods,
                typed: errorTyped,
                submit_dispatched: errorSubmitDispatched,
                submit_verified:
                  error instanceof SubmitVerificationError ? false : null,
                error: error instanceof Error ? error.message : String(error),
              },
              {
                // Submission-verification failures already emitted the source
                // event immediately before throwing. Earlier failures did not.
                appendFailureEvent: !(error instanceof SubmitVerificationError),
              },
            );
            failedReceiptPayload = {
              ...buildPublicDeliveryReceipt({
                delivery_state: "failed",
                delivery_id: failedReceipt.delivery_id,
                typed:
                  error instanceof SubmitVerificationError
                    ? (error.receipt?.typed ?? true)
                    : errorTyped,
                submit_attempted:
                  error instanceof SubmitVerificationError
                    ? (error.receipt?.submit_attempted ?? args.press_enter)
                    : args.press_enter || errorSubmitDispatched,
                submit_dispatched: errorSubmitDispatched,
                submit_verified: failedReceipt.submit_verified,
                retry_count: failedReceipt.retry_count,
                rpc_methods: errorRpcMethods,
                timings_ms: timings,
              }),
              retry_safe:
                errorRpcMethods.length === 0 &&
                !errorTyped &&
                !errorSubmitDispatched,
            };
            throw error;
          } finally {
            finishEventLoopDelay();
          }
          const receipt =
            delivery.delivery === "queued" ||
            delivery.delivery === "queued_followup"
              ? engine.acceptComposerQueue({
                  delivery_id: deliveryId,
                  agent_id: agentId,
                  text: args.text,
                  press_enter: args.press_enter,
                  source_event: "send_to",
                  retry_count: delivery.retry_count,
                  rpc_methods: delivery.rpc_methods,
                  typed: delivery.typed,
                  submit_dispatched: delivery.submit_dispatched,
                  delivery_state: delivery.delivery,
                })
              : delivery.delivery === "pending_verify"
                ? engine.acceptPendingVerify({
                    delivery_id: deliveryId,
                    agent_id: agentId,
                    text: args.text,
                    press_enter: args.press_enter,
                    source_event: "send_to",
                    retry_count: delivery.retry_count,
                    rpc_methods: delivery.rpc_methods,
                    typed: delivery.typed,
                    submit_dispatched: delivery.submit_dispatched,
                  })
                : delivery.delivery === "rescued"
                  ? engine.resolveDelivery({
                      delivery_id: deliveryId,
                      agent_id: agentId,
                      text: args.text,
                      press_enter: args.press_enter,
                      source_event: "send_to",
                      delivery_state: "rescued",
                      terminal: true,
                      retry_count: delivery.retry_count,
                      rpc_methods: delivery.rpc_methods,
                      typed: delivery.typed,
                      submit_dispatched: delivery.submit_dispatched,
                      submit_verified: false,
                      error: "Prompt appeared only after an external interrupt",
                    })
                  : delivery.delivery === "typed"
                    ? engine.resolveDelivery({
                        delivery_id: deliveryId,
                        agent_id: agentId,
                        text: args.text,
                        press_enter: args.press_enter,
                        source_event: "send_to",
                        delivery_state: "typed",
                        terminal: true,
                        retry_count: delivery.retry_count,
                        rpc_methods: delivery.rpc_methods,
                        typed: delivery.typed,
                        submit_dispatched: delivery.submit_dispatched,
                        submit_verified: null,
                        error: null,
                      })
                    : delivery.delivery === "submitted"
                      ? engine.resolveDelivery({
                          delivery_id: deliveryId,
                          agent_id: agentId,
                          text: args.text,
                          press_enter: args.press_enter,
                          source_event: "send_to",
                          delivery_state: "submitted",
                          terminal: true,
                          retry_count: delivery.retry_count,
                          rpc_methods: delivery.rpc_methods,
                          typed: delivery.typed,
                          submit_dispatched: delivery.submit_dispatched,
                          submit_verified: delivery.submit_verified,
                          error: null,
                        })
                      : null;
          // Preserve the already-terminal receipt if optional evidence
          // collection fails after the pane mutation has succeeded.
          const publicReceipt = buildPublicDeliveryReceipt({
            delivery_state: receipt?.delivery_state,
            delivery_id: receipt?.delivery_id ?? deliveryId,
            typed: delivery.typed,
            submit_attempted: delivery.submit_attempted,
            submit_verified: delivery.submit_verified,
            submit_evidence: delivery.submit_evidence,
            retry_count: delivery.retry_count,
            rpc_methods: delivery.rpc_methods,
            submit_dispatched: delivery.submit_dispatched,
            queued_behind_turn: delivery.queued_behind_turn,
            timings_ms: timings,
          });
          failedReceiptPayload = { ...publicReceipt };
          const evidence = await collectDeliveryEvidence(agentId);
          const data = {
            agent_id: agentId,
            ...publicReceipt,
            ...evidence,
          };
          return okFormatted(formatOk("send_to", data), data);
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              ...e.receipt,
              ...failedReceiptPayload,
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              ...failedReceiptPayload,
              ...submitVerificationFailurePayload(e),
            });
          }
          return err(e, failedReceiptPayload);
        }
      },
    );

    // 18. send_to_agent
    server.tool(
      "send_to_agent",
      `${PANE_INPUT_BREAKAGE_GUIDANCE} Deprecated for client integrations: use send_to instead. Internal/advanced path for sending text input to an agent in ready or idle state. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} UTF-8 bytes by default (CMUXLAYER_MAX_INLINE_CHARS, a byte count >= ${SEND_INPUT_CHUNK_THRESHOLD}). For launcher boot prompts, put the full prompt in a file and pass boot_prompt_path through spawn_agent/send_command instead of routing raw long text through the agent composer. Pass allow_long_inline:true only for deliberate raw sends. Returns the same post-delivery registry/screen health evidence as send_to. ${ZSH_BANG_INLINE_WARNING}`,
      {
        ...SendToArgsSchema.shape,
        text: SendToArgsSchema.shape.text.describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline UTF-8 bytes by default.`,
        ),
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "Deprecated no-op. Safety gates still refuse text at a picker/menu or permission prompt; use mode=key to drive those deliberately.",
        ),
        allow_long_inline: SendToArgsSchema.shape.allow_long_inline.describe(
          "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
        ),
      },
      ANNOTATIONS.mutating,
      async (rawArgs) => {
        try {
          const parsedArgs = SendToArgsSchema.safeParse({
            ...rawArgs,
            mode: "agent",
          });
          if (!parsedArgs.success) {
            return err(
              new Error(
                formatToolValidationError("send_to_agent", parsedArgs.error),
              ),
            );
          }

          const args = parsedArgs.data;
          const agentId = args.agent_id ?? args.target;
          if (!agentId || args.text === undefined) {
            throw new Error("send_to_agent requires agent_id and text");
          }
          const sendToHandler = toolHandlersByName.get("send_to");
          if (!sendToHandler) {
            throw new Error("Internal tool handler unavailable: send_to");
          }
          const result = await sendToHandler(
            {
              ...args,
              mode: "agent",
              agent_id: agentId,
              target: undefined,
              targeting: undefined,
              verbose: true,
            },
            {},
          );
          if (!result.isError) return result;

          const preserveLegacyToolLabel = (value: string): string =>
            value.replaceAll("send_to.", "send_to_agent.");
          return {
            ...result,
            content: result.content.map((item) => ({
              ...item,
              text: preserveLegacyToolLabel(item.text),
            })),
            structuredContent: result.structuredContent
              ? {
                  ...result.structuredContent,
                  ...(typeof result.structuredContent.error === "string"
                    ? {
                        error: preserveLegacyToolLabel(
                          result.structuredContent.error,
                        ),
                      }
                    : {}),
                }
              : undefined,
          };
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              submit_verified: false,
              retry_count: e.retry_count,
            });
          }
          return err(e);
        }
      },
    );

    server.tool(
      "supersede_agent_goal",
      "Replace an existing managed agent's active mission with a file-backed /goal contract. Sends `/goal Read and execute this goal file until complete: <path>` through the guarded agent relay, then applies the supersede registry patch only after verified submission. An unverified submission does not apply that patch but may have mutated the target pane, so it is not safe to retry blindly. Use this to reuse an existing pane instead of spawning a duplicate lane.",
      {
        agent_id: z.string().describe("Managed agent_id to supersede"),
        goal_file: z
          .string()
          .describe("Absolute path to the goal file the agent must execute"),
        summary: z
          .string()
          .optional()
          .describe(
            "Optional task_summary to store in the registry. Defaults to the goal_file path.",
          ),
        allow_busy: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "If true, supersede even while the agent is working. Defaults true because supersession intentionally replaces the active mission. Queued-but-unsubmitted input returns an error and may require manual pane reconciliation before retrying.",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          await refreshManagedMetadataBestEffort(args.agent_id);
          const current = engine.getAgentState(args.agent_id);
          if (!current) {
            return err(new Error(`Agent not found: ${args.agent_id}`));
          }
          await preflightBootPromptFile(args.goal_file);
          const taskSummary = args.summary?.trim() || args.goal_file;
          let delivery: Awaited<ReturnType<typeof deliverAgentInput>>;
          try {
            delivery = await deliverAgentInput({
              agent_id: args.agent_id,
              text: `/goal Read and execute this goal file until complete: ${args.goal_file}`,
              press_enter: true,
              allow_busy: args.allow_busy ?? true,
              source_event: "supersede_agent_goal",
            });
          } catch (e) {
            if (e instanceof SubmitVerificationError) {
              return err(e, {
                error_code: "supersede_submit_unverified",
                submit_verified: false,
                retry_count: e.retry_count,
                registry_updated: false,
                goal_delivery_state: "unverified_pane_side_effect",
                retry_safe: false,
                recovery:
                  "Do not retry automatically; inspect the target composer/queue and reconcile the pane before attempting another supersede.",
              });
            }
            throw e;
          }
          if (delivery.submit_verified !== true) {
            const error = new SubmitVerificationError(
              `Supersede submission could not be verified for ${args.agent_id}`,
              delivery.retry_count,
              delivery.delivery === "queued"
                ? "input_still_pending"
                : "submit_evidence_absent",
            );
            return err(error, {
              error_code: "supersede_submit_unverified",
              ...submitVerificationFailurePayload(error),
              registry_updated: false,
              goal_delivery_state: "unverified_pane_side_effect",
              recovery:
                "Do not retry automatically; inspect the target composer/queue and reconcile the pane before attempting another supersede.",
            });
          }
          const canonicalAgentId = current.agent_id;
          const supersedePatch = {
            task_summary: taskSummary,
            goal_file: args.goal_file,
            // AIDEV-NOTE (P11 finding 1): clear the engine-issued pair so the
            // prose fallback resumes for the NEW brief. supersede is the one
            // contract channel that actually reaches the worker -- it delivers
            // `/goal Read and execute this goal file` to the pane -- so the
            // worker will honor the superseding brief's path. If the consumer
            // kept checking the originally issued path it would render
            // artifact_missing forever: the exact S3 disagreement, re-created
            // through the door that used to work. Whatever reached the worker
            // is what the consumer must verify against.
            report_path: null,
            done_marker: null,
            task_done_candidate_at: null,
            task_done_detected_at: null,
            boot_prompt_pending: false,
            error: null,
          };
          let updated =
            current.state === "working"
              ? stateMgr.updateRecord(canonicalAgentId, supersedePatch)
              : stateMgr.resetState(
                  canonicalAgentId,
                  "working",
                  supersedePatch,
                  "supersede_agent_goal",
                );
          registry.set(canonicalAgentId, updated);
          const evidence = await collectDeliveryEvidence(canonicalAgentId);
          const data = {
            agent_id: canonicalAgentId,
            goal_file: args.goal_file,
            task_summary: taskSummary,
            retry_count: delivery.retry_count,
            submit_verified: delivery.submit_verified,
            ...evidence,
          };
          return okFormatted(formatOk("supersede_agent_goal", data), data);
        } catch (e) {
          return err(e);
        }
      },
    );
    // 19. read_agent_output
    server.tool(
      "read_agent_output",
      "Extract structured output from an agent's terminal between delimiter markers (e.g., REVIEW_OUTPUT_START / REVIEW_OUTPUT_END). Returns the content between the markers, or null if not found.",
      {
        surface: z.string().describe("Target surface ref (e.g., 'surface:78')"),
        tag: z
          .string()
          .optional()
          .default("OUTPUT")
          .describe(
            "Delimiter tag name. Looks for {TAG}_START and {TAG}_END markers. Default: OUTPUT (matches OUTPUT_START/OUTPUT_END). Examples: REVIEW_OUTPUT, SYNTHESIS_OUTPUT, PUSHBACK_OUTPUT",
          ),
        lines: z
          .number()
          .optional()
          .default(200)
          .describe("Number of screen lines to scan (default: 200)"),
        scrollback: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Scan full scrollback instead of only the current terminal tail. Default: false.",
          ),
        workspace: z.string().optional().describe("Target workspace ref"),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          const opts: Record<string, unknown> = {
            lines: args.lines,
          };
          if (args.scrollback) opts.scrollback = true;
          if (args.workspace) opts.workspace = args.workspace;

          const raw = await client.readScreen(args.surface, opts);
          const text = typeof raw === "string" ? raw : (raw.text ?? "");

          const startMarker = `${args.tag}_START`;
          const endMarker = `${args.tag}_END`;

          const startIdx = text.indexOf(startMarker);
          const endIdx = text.indexOf(endMarker);

          if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
            return ok({
              found: false,
              tag: args.tag,
              surface: args.surface,
              content: null,
            });
          }

          const content = text
            .slice(startIdx + startMarker.length, endIdx)
            .trim();

          return ok({
            found: true,
            tag: args.tag,
            surface: args.surface,
            content,
          });
        } catch (e) {
          return err(e);
        }
      },
    );
    // --- V2 Public API: interact + kill ---

    // 19. interact
    server.tool(
      "interact",
      "Send a message to an agent, or perform an agent action (interrupt, model switch, resume, skill, usage). If the agent is alive, sends directly. If not found, returns an error — use spawn_agent first.",
      {
        agent: z
          .string()
          .describe("Agent ID (from spawn_agent or list_agents)"),
        action: z
          .enum([
            "send",
            "interrupt",
            "model",
            "resume",
            "skill",
            "usage",
            "mcp",
          ])
          .describe("Action to perform"),
        text: z
          .string()
          .optional()
          .describe("Text to send (required for action=send)"),
        model: z
          .string()
          .optional()
          .describe("Model to switch to (required for action=model)"),
        session_id: z
          .string()
          .optional()
          .describe("Session ID to resume (optional for action=resume)"),
        command: z
          .string()
          .optional()
          .describe("Slash command to run (required for action=skill)"),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          // Runtime validation per action (Decision 2)
          switch (args.action) {
            case "send":
              if (!args.text) {
                return err(
                  new Error(
                    "text is required for action=send. Provide the message to send to the agent.",
                  ),
                );
              }
              break;
            case "model":
              if (!args.model) {
                return err(
                  new Error(
                    "model is required for action=model. Provide the model name to switch to (e.g. 'sonnet', 'opus').",
                  ),
                );
              }
              break;
            case "skill":
              if (!args.command) {
                return err(
                  new Error(
                    "command is required for action=skill. Provide the slash command (e.g. '/commit', '/review').",
                  ),
                );
              }
              break;
            // interrupt, resume, usage, mcp — no extra fields required
          }

          // Resolve agent
          await refreshManagedMetadataBestEffort(args.agent);
          const agent = engine.getAgentState(args.agent);
          if (!agent) {
            return err(
              new Error(
                `Agent not found: "${args.agent}". Use list_agents to see available agents, or spawn_agent to create one.`,
              ),
            );
          }

          // Dispatch action
          switch (args.action) {
            case "send": {
              const delivery = await deliverAgentInput({
                agent_id: args.agent,
                text: args.text!,
                press_enter: true,
                source_event: "interact",
              });
              const d = {
                agent_id: args.agent,
                action: "send",
                retry_count: delivery.retry_count,
                submit_verified: delivery.submit_verified,
              };
              return okFormatted(formatOk("interact:send", d), d);
            }
            case "interrupt": {
              const route = await engine.resolveAgentIoRoute(args.agent);
              await withSurfaceWrite(
                route.surface_id,
                () =>
                  client.sendKey(route.surface_id, "c-c", {
                    workspace: route.workspace_id ?? undefined,
                  }),
                {
                  toolName: "interact",
                  workspace: route.workspace_id ?? undefined,
                  observePtyWrite: true,
                },
              );
              const d = { agent_id: args.agent, action: "interrupt" };
              return okFormatted(formatOk("interact:interrupt", d), d);
            }
            case "model": {
              const modelCmd = `/model ${args.model}`;
              const delivery = await deliverAgentInput({
                agent_id: args.agent,
                text: modelCmd,
                press_enter: true,
                source_event: "interact",
              });
              await lifecycleSeatManifestPublisher({
                agentId: args.agent,
                model: args.model,
              });
              const d = {
                agent_id: args.agent,
                action: "model",
                model: args.model,
                retry_count: delivery.retry_count,
                submit_verified: delivery.submit_verified,
              };
              return okFormatted(formatOk("interact:model", d), d);
            }
            case "resume": {
              const resumeCmd = args.session_id
                ? `/resume ${args.session_id}`
                : "/resume";
              const delivery = await deliverAgentInput({
                agent_id: args.agent,
                text: resumeCmd,
                press_enter: true,
                source_event: "interact",
              });
              const d = {
                agent_id: args.agent,
                action: "resume",
                session_id: args.session_id,
                retry_count: delivery.retry_count,
                submit_verified: delivery.submit_verified,
              };
              return okFormatted(formatOk("interact:resume", d), d);
            }
            case "skill": {
              const submittedCommand = args.command!.trim();
              const isSubmittedCommandEcho = (line: string): boolean =>
                line.trim().replace(/^[>❯›]\s*/, "") === submittedCommand;
              const isActiveSkillProgressLine = (line: string): boolean =>
                /^(?:[•✻✢✳✶✦]\s*(?:Thinking|Working)|[⏺⬡]\s*Running)(?:\b|…)/iu.test(
                  line,
                );
              const isComposerInputLine = (line: string): boolean =>
                /^[>❯›]\s*\S/u.test(line);
              let commandEchoCountBefore: number | null = null;
              try {
                const beforeScreen = await engine.readAgentScreen(
                  { agent_id: args.agent },
                  { lines: 20 },
                );
                commandEchoCountBefore = beforeScreen.text
                  .split("\n")
                  .filter(isSubmittedCommandEcho).length;
              } catch {
                // Without a baseline, later output cannot be attributed to
                // this invocation rather than an identical historical echo.
              }
              const delivery = await deliverAgentInput({
                agent_id: args.agent,
                text: args.command!,
                press_enter: true,
                source_event: "interact",
              });
              let screenResultLine: string | null = null;
              let screenResultAvailable = false;
              try {
                const screen = await engine.readAgentScreen(
                  { agent_id: args.agent },
                  { lines: 20 },
                );
                const screenLines = screen.text
                  .split("\n")
                  .map((line) => line.trim());
                const commandEchoCountAfter = screenLines.filter(
                  isSubmittedCommandEcho,
                ).length;
                let commandLineIndex = -1;
                for (let index = screenLines.length - 1; index >= 0; index -= 1) {
                  if (
                    screenLines[index]?.replace(/^[>❯›]\s*/, "") ===
                    submittedCommand
                  ) {
                    commandLineIndex = index;
                    break;
                  }
                }
                screenResultLine =
                  screenLines
                    .slice(commandLineIndex + 1)
                    .filter(
                      (line) =>
                        commandEchoCountBefore !== null &&
                        commandEchoCountAfter > commandEchoCountBefore &&
                        commandLineIndex >= 0 &&
                        !isActiveSkillProgressLine(line) &&
                        !isComposerInputLine(line) &&
                        (!isComposerFooterOrChromeLine(line) ||
                          /^CLAUDE_COUNTER:/i.test(line)) &&
                        !/^Claude Code(?:\s+v?\d|$)/i.test(line) &&
                        !/^[>❯›]\s*$/.test(line),
                    )
                    .at(-1) ?? null;
                screenResultAvailable = screenResultLine !== null;
              } catch {
                // Submission already succeeded. Observation loss must not invite
                // a retry that could execute the skill twice.
              }
              const d = {
                agent_id: args.agent,
                action: "skill",
                command: args.command,
                retry_count: delivery.retry_count,
                submit_verified: delivery.submit_verified,
                screen_result_available: screenResultAvailable,
                screen_result_line: screenResultLine,
              };
              return okFormatted(formatOk("interact:skill", d), d);
            }
            case "usage": {
              // Read screen to extract usage info
              const route = await engine.resolveAgentIoRoute(args.agent);
              const screen = await client.readScreen(route.surface_id, {
                workspace: route.workspace_id ?? undefined,
                lines: 5,
              });
              return ok({
                agent_id: args.agent,
                action: "usage",
                surface_id: route.surface_id,
                screen_tail: screen.text,
              });
            }
            case "mcp": {
              // Read screen for MCP server status
              const route = await engine.resolveAgentIoRoute(args.agent);
              const mcpScreen = await client.readScreen(route.surface_id, {
                workspace: route.workspace_id ?? undefined,
                lines: 10,
              });
              return ok({
                agent_id: args.agent,
                action: "mcp",
                surface_id: route.surface_id,
                screen_tail: mcpScreen.text,
              });
            }
          }
        } catch (e) {
          return err(e);
        }
      },
    );

    // 20. kill
    server.tool(
      "kill",
      "Stop one or more agents. Target can be a single agent ID, an array of IDs, or 'all'.",
      {
        target: z
          .union([z.string(), z.array(z.string())])
          .describe(
            "Agent ID, array of agent IDs, or 'all' to stop all agents",
          ),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe("Force kill (SIGKILL) instead of graceful (Ctrl+C)"),
      },
      ANNOTATIONS.destructive,
      async (args) => {
        try {
          const killed: string[] = [];
          const errors: string[] = [];

          // Resolve target list
          let targetIds: string[];
          if (args.target === "all") {
            const agents = engine.listAgents();
            targetIds = agents
              .filter((a) => a.state !== "done" && a.state !== "error")
              .map((a) => a.agent_id);
          } else if (Array.isArray(args.target)) {
            targetIds = args.target;
          } else {
            targetIds = [args.target];
          }

          if (targetIds.length === 0) {
            return okFormatted(
              formatOk("kill", { message: "No agents to kill" }),
              { killed: [] },
            );
          }

          // Kill each agent, collecting results
          for (const agentId of targetIds) {
            const current = engine.getAgentState(agentId);
            try {
              await engine.stopAgent(agentId, args.force, {
                beforeSurfaceMutation: (route) =>
                  assertSurfaceMutationAllowed(
                    "kill",
                    route.surface_id,
                    route.workspace_id ?? undefined,
                  ),
              });
              await reapInboxTail(current?.agent_id ?? agentId, inboxOpts);
              pruneChildReportWatchesFor(agentId);
              killed.push(agentId);
              appendCloseEvent({
                event: "kill",
                target: agentId,
                caller: resolveCloseCaller("kill"),
                force: args.force ?? false,
                reason: current ? `state before kill: ${current.state}` : null,
                refused: false,
              });
            } catch (e) {
              await reapTailAfterConfirmedExit(current).catch(() => ({}));
              errors.push(
                `${agentId}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }

          if (killed.length === 0 && errors.length > 0) {
            return err(
              new Error(`Failed to kill any agents: ${errors.join("; ")}`),
            );
          }

          const data = {
            killed,
            errors: errors.length > 0 ? errors : undefined,
            force: args.force,
          };
          return okFormatted(formatOk("kill", { count: killed.length }), data);
        } catch (e) {
          return err(e);
        }
      },
    );
    // 21. my_agents
    server.tool(
      "my_agents",
      "Get all children of a parent agent with live status from read_screen. Combines registry state + parsed screen output in one call.",
      {
        parent_agent_id: z
          .string()
          .optional()
          .describe(
            "Parent agent ID. If omitted, returns all root agents (no parent).",
          ),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          await awaitLifecycleStart();
          const merged = await engine.runLifecycleMutation(
            () => registry.listMerged(discovery),
            { label: "list-agent-hierarchy" },
          );
          invalidateSurfaceTopologyCallScope(client as object);
          const agents = args.parent_agent_id
            ? (() => {
                const childIds = new Set(
                  registry
                    .getChildren(args.parent_agent_id)
                    .map((agent) => agent.agent_id),
                );
                return merged.filter((agent) => childIds.has(agent.agent_id));
              })()
            : merged.filter((agent) => agent.parent_agent_id === null);
          const topology = await collectSurfaceTopology().catch(() => null);

          const SCREEN_TIMEOUT = 3000;
          const enriched = await Promise.all(
            agents.map(async (agent) => {
              const screenDeadline = Date.now() + SCREEN_TIMEOUT;
              let screenData: ParsedScreenResult | null = null;
              let liveSurfaceId: string | null = null;
              let screenFailure: {
                screen_unavailable: true;
                error_code: "screen_unavailable";
                screen_error: string;
              } | null = null;
              try {
                const resolved = await Promise.race([
                  (async () => {
                    const binding = resolveAuthorizedAgentSurfaceBinding(
                      agent,
                      topology,
                    );
                    if (!binding) {
                      throw new Error(
                        `No authorized live surface binding for ${agent.agent_id}`,
                      );
                    }
                    const route = {
                      surface_id: binding.surfaceRef,
                      workspace_id: binding.workspaceId,
                    };
                    const codexFillPromise = readCodexRolloutFill(agent);
                    const screen = await client.readScreen(route.surface_id, {
                      lines: 20,
                      workspace: route.workspace_id ?? undefined,
                    });
                    return { route, screen, codexFillPromise };
                  })(),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error("timeout")),
                      SCREEN_TIMEOUT,
                    ),
                  ),
                ]);
                liveSurfaceId = resolved.route.surface_id;
                const screen = resolved.screen;
                const fillWaitMs = Math.max(0, screenDeadline - Date.now());
                const pendingCodexFill =
                  fillWaitMs === 0
                    ? null
                    : await new Promise<CodexRolloutFill | null>((resolve) => {
                        const timeout = setTimeout(
                          () => resolve(null),
                          fillWaitMs,
                        );
                        resolved.codexFillPromise.then(
                          (fill) => {
                            clearTimeout(timeout);
                            resolve(fill);
                          },
                          () => {
                            clearTimeout(timeout);
                            resolve(null);
                          },
                        );
                      });
                const codexFill = await validateCodexRolloutFill(
                  agent,
                  resolved.route.surface_id,
                  pendingCodexFill,
                );
                screenData = applyCodexRolloutFill(
                  applyHarnessState(
                    enrichParsedScreen(
                      parseScreen(screen.text),
                      screen.text,
                      pickLatestSurfaceModel(stateMgr, liveSurfaceId),
                    ),
                    resolveHarnessStateForSurface(
                      stateMgr,
                      liveSurfaceId,
                      agent,
                    ),
                  ),
                  codexFill,
                );
              } catch (error) {
                // Surface may be closed, unavailable, or timed out
                screenFailure = {
                  screen_unavailable: true,
                  error_code: "screen_unavailable",
                  screen_error: screenUnavailableMessage(error),
                };
              }

              const resumeCommand = resumeCommandForAgent(agent);
              return {
                agent_id: agent.agent_id,
                repo: agent.repo,
                // Reconcile a stale registry "error" against the live screen: a healthy idle
                // agent must not be reported as errored just because the registry lagged.
                state: reconcileAgentLiveState(agent.state, screenData),
                model: agent.model,
                cli: agent.cli,
                session_id: agent.cli_session_id,
                resumable: !!agent.cli_session_id,
                ...(resumeCommand ? { resume_command: resumeCommand } : {}),
                surface_id: liveSurfaceId,
                token_count: screenData?.token_count ?? null,
                context_window: screenData?.context_window ?? null,
                context_pct: screenData?.context_pct ?? null,
                cost: screenData?.cost ?? null,
                task_summary: summarizeTaskSummary(agent.task_summary),
                spawn_depth: agent.spawn_depth,
                created_at: agent.created_at,
                quality: agent.quality,
                ...(screenFailure ?? {}),
              };
            }),
          );

          const lines = enriched.map((a) => {
            const ctx = a.context_pct !== null ? `${a.context_pct}%` : "—";
            const cost = a.cost !== null ? `$${a.cost.toFixed(2)}` : "—";
            const tokens =
              a.token_count !== null
                ? `${Math.round(a.token_count / 1000)}K`
                : "—";
            return `${a.agent_id}  ${a.state}  ${tokens}  ${ctx}  ${cost}`;
          });

          const formatted =
            `┌─ my_agents ─ ${enriched.length} agent${enriched.length !== 1 ? "s" : ""}\n` +
            lines.map((l) => `│ ${l}`).join("\n") +
            "\n└─";

          return okFormatted(formatted, {
            agents: enriched,
            count: enriched.length,
            parent_agent_id: args.parent_agent_id ?? null,
          });
        } catch (e) {
          return err(e);
        }
      },
    );
  } // end skipAgentLifecycle guard

  registerPaletteExpansion();

  return server;
}
