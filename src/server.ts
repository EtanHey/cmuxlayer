/**
 * cmuxlayer MCP server — registers core tools + agent lifecycle tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import {appendFile, mkdir, } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CMUXLAYER_DEFAULT_PALETTE_ENV,
  createDefaultToolPalette,
} from "./palette.js";
import {
  createFileSystemSeatManifestWriter,
  type SeatManifestWriter,
} from "./seat-manifest.js";
import { assertMutationAllowed } from "./mode-policy.js";
import { extractPrefix } from "./naming.js";
import { createStaleBuildWarner, RUNNING_VERSION } from "./version.js";
import {
} from "./model-policy.js";
import { shellQuote } from "./agent-command.js";
import { withRaisedNofileSoftLimit } from "./nofile-limit.js";
import { agentProcessLiveness } from "./util/pid-alive.js";
import {
  withTransportRetryTracking,
} from "./transport-retry-context.js";
import {
  AgentRegistry,
} from "./agent-registry.js";
import {
  AgentEngine,
  RetryableDeliveryError,
  buildLaunchCommand,
  resolveSweepTiming,
  type AgentDeliveryReceipt,
} from "./agent-engine.js";
import {
  bootContractMode,
  bootContractPointer,
  issueCoordinationContract,
  writeBootContractFile,
  type CoordinationContract,
} from "./coordination-paths.js";
import {
  readWatchRegistry,
  removeWatches,
  reserveWatchReportPath,
  scopeWatchToSubject,
  updateWatchDeadline,
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
} from "./agent-facade.js";
import { evaluateAgentHealth, } from "./agent-health.js";
import {
  AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
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
} from "./agent-types.js";
import {
} from "./format.js";
import {
  parseScreen,
  screenShowsPaused,
} from "./screen-parser.js";
import {
} from "./created-identity.js";
import {
  dispatch,
  ensureInboxFile,
  formatInboxPing,
  inboxCursorPath,
  inboxTailPidPath,
  inboxPath,
  reapInboxTail,
  recommendedMonitorCommand,
  writeHeartbeat,
  type InboxOpts,
} from "./inbox.js";
import {
} from "./harness-session.js";
import {
  type CodexRolloutFill,
} from "./codex-rollout-fill.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import {
  collectRoleSurfaceIds,
  inferRecordRoleOrNull,
  launcherNameForCli,
} from "./layout-policy.js";
import type {
  CmuxPane,
  CmuxSurface,
  CmuxWorkspace,
  ControlMode,
  ParsedScreenResult,
} from "./types.js";
import {normalizeKeyName } from "./key-names.js";
import {
  currentCallerContext,
} from "./caller-context.js";
import {
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
  type ControlHealth,
  type LifecycleStartHealth,
} from "./control-health.js";
import {
  collectSurfaceTopology as collectCmuxSurfaceTopology,
  enumerateAllWindowWorkspacesWithRetry,
  invalidateSurfaceTopologyCallScope,
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
  normalizeTerminalText,
  inferComposerCli,
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
} from "./mcp/schemas.js";
import {
  timeDeliveryPhase,
  buildPublicDeliveryReceipt,
  pausedTargetWarning,
  AmbiguousBootRecoveryReturnError,
  ManualModeMutationError,
  PLACEMENT_WORKSPACE_UNRESOLVED,
} from "./delivery/receipts.js";
import type {
  SubmitEvidence,
  PublicDeliveryReceipt,
  DeliveryPhaseTimings,
  DeliveryRecord,
} from "./delivery/receipts.js";
import {
  controlModeFromStatusEntries,
  ok,
  LifecycleStartTimeoutError,
} from "./mcp/tool-result.js";
import type {
} from "./mcp/tool-result.js";
import {
  SEND_INPUT_CHUNK_THRESHOLD,
  SEND_INPUT_PASTE_BATCH_MAX_BYTES,
  SEND_INPUT_CHUNK_DELAY_MS,
  SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS,
  SEND_INPUT_MAX_INLINE_CHARS,
  SHORT_POINTER_MAX_CHARS,
  SHORT_POINTER_SUBMIT_VERIFY_TIMEOUT_MS,
  BUSY_AGENT_SUBMIT_VERIFY_TIMEOUT_MS,
  INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS,
  chunkTerminalInput,
  buildInputDeliveryBatches,
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


import { registerControlHealthTool } from "./mcp/tools/health.js";
import {
  type RawSendDeps,
  type SendCommandArgs,
  type SendInputArgs,
  type SendKeyArgs,
  sendCommand,
  sendInput,
  sendKey,
} from "./mcp/tools/raw-send.js";
import { registerReadScreenTool } from "./mcp/tools/screen.js";
import { type StopAgentCallArgs, stopAgent } from "./mcp/tools/stop.js";
import type { ToolReturn } from "./mcp/tool-result.js";
import type { RawSurfaceMutationRoute } from "./mcp/shared-types.js";
import {
  registerCloseSurfaceTool,
  registerListSurfacesTool,
  registerUpdateSurfaceTool,
  type SurfaceToolDeps,
} from "./mcp/tools/surface.js";
import {
  bindInternalToolsForTests,
  bindToolDeps,
  createSuccessfulDispatchRpcMethod,
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
import {
} from "./mcp/tool-input.js";
import type {
  FocusRestoreLease,
  FocusTarget,
  MonitorBootResult,
} from "./mcp/shared-types.js";
import { registerSpawnAgentTool } from "./mcp/tools/spawn.js";
import { registerSendToTool, registerWaitForTool } from "./mcp/tools/send.js";


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

export const __submitEvidenceTestHooks = {
  extractComposerInputRegion,
  screenShowsPendingInput,
  screenShowsCompletePendingInput,
  composerHoldsForeignDraft,
  requiredBootReadyObservations,
  composeBootDeliveryText,
};

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

  const server = new McpServer({
    name: "cmuxlayer",
    version: RUNNING_VERSION,
  });
  const successfulDispatchRpcMethod = createSuccessfulDispatchRpcMethod(client);
  const { toolHandlersByName, registerPaletteExpansion } =
    installToolRegistration(server, {
      client,
      palette: createDefaultToolPalette(
        opts?.defaultPalette ?? process.env[CMUXLAYER_DEFAULT_PALETTE_ENV],
      ),
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
    callerOwnsTypedDraft,
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

  // CX-3 S6: the surface tools live in src/mcp/tools/surface.ts.
  // Set once the agent lifecycle is wired; close_surface scope="agent" reads
  // it live, exactly as it used to look up the stop_agent handler by name.
  let stopAgentFn:
    | ((args: StopAgentCallArgs) => Promise<ToolReturn>)
    | null = null;
  const surfaceToolDeps: SurfaceToolDeps = {
    agentScopedSurfaceClose,
    appendCloseEvent,
    assertSurfaceMutationAllowed,
    assertWorkspaceMutationAllowed,
    canonicalWorkspaceRef,
    captureSurfaceIdentities,
    client,
    collectSurfaceTopology,
    context,
    currentSafetyCallerWorkspace,
    findSurfaceByRef,
    findSurfaceRefByUuid,
    lifecycleScheduleChildReportWatchPrune: () =>
      lifecycleScheduleChildReportWatchPrune?.(),
    lifecycleSeatManifestPublisher: (input) =>
      lifecycleSeatManifestPublisher(input),
    listAllWorkspaces,
    pruneChildReportWatchesFor,
    removeOwnedWatchesFor,
    resolveCloseCaller,
    resolveRawSurfaceMutationRoute,
    snapshotWatchOwnerCandidates,
    stateMgr,
    stopAgent: () => stopAgentFn,
    toolHandlersByName,
    withSurfaceWrite,
  };
  registerListSurfacesTool(server, surfaceToolDeps);

  registerControlHealthTool(server, {
    appendControlHealthSnapshot,
    context,
    opts,
    resolveCurrentCallerAgent,
    snapshotWatchOwnerCandidates,
    staleBuildWarning,
  });

  // CX-3 S7: send_input / send_command / send_key are plain functions in
  // src/mcp/tools/raw-send.ts; send_to calls them directly.
  const rawSendDeps: RawSendDeps = {
    assertSurfaceMutationAllowed,
    context,
    deliverBootPrompt,
    executeDeliveryEngine,
    isBootPromptDelivered,
    remapFields,
    resolveRawSurfaceMutationRoute,
    sendLauncherCommandToSurface,
    shouldVerifyRawSurfaceSubmit,
    startBackgroundDelivery,
    stateMgr,
    withSurfaceWrite,
  };
  // Test-only access, on the same seam as engineForTests (bindToolDeps): a
  // non-enumerable symbol property holding four closures. It adds no MCP
  // registration and nothing in production reads it; binding it here keeps
  // tests on the exact functions send_to and close_surface call.
  bindInternalToolsForTests(server, {
    send_input: (args) => sendInput(rawSendDeps, args as SendInputArgs),
    send_command: (args) => sendCommand(rawSendDeps, args as SendCommandArgs),
    send_key: (args) => sendKey(rawSendDeps, args as SendKeyArgs),
    stop_agent: (args) => {
      if (!stopAgentFn) {
        throw new Error("Internal agent close adapter unavailable");
      }
      return stopAgentFn(args as StopAgentCallArgs);
    },
  });

  registerReadScreenTool(server, {
    applyCodexRolloutFill,
    collectSurfaceTopology,
    getSurfaceDelivery,
    readCodexRolloutFill,
    readScreenSnapshot,
    remapFields,
    resolveCodexAgentForSurface,
    resolveRawSurfaceMutationRoute,
    sameCodexSessionBinding,
    stateMgr,
    validateCodexRolloutFill,
  });

  registerUpdateSurfaceTool(server, surfaceToolDeps);

  registerCloseSurfaceTool(server, surfaceToolDeps);

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
    // spawn_agent (src/mcp/tools/spawn.ts, CX-3b S10b)
    registerSpawnAgentTool(server, {
      appendStaleBuildWarning,
      armParentReportWatch,
      assertWorkspaceMutationAllowed,
      awaitLifecycleStart,
      buildBootContractInjection,
      callerOwnsTypedDraft,
      canonicalWorkspaceRef,
      capturePostCreationFocus,
      captureSpawnSessionBestEffort,
      client,
      collectSurfaceTopology,
      currentSafetyCallerWorkspace,
      deliverBootPrompt,
      engine,
      ensureMonitorBoot,
      evaluateServerAgentHealth,
      executeDeliveryEngine,
      focusTargetBeforeSplit,
      isBootPromptDelivered,
      issueSpawnCoordination,
      launchShellRecoveryBySurface,
      // Forward, don't capture: reassigned during createServer.
      lifecycleSeatManifestPublisher: (input) => lifecycleSeatManifestPublisher(input),
      opts,
      originalLaunchCommandsBySurface,
      parentReportPathReservations,
      prepareSpawnWorktree,
      refreshManagedMetadataBestEffort,
      registry,
      relaunchSpawnAgentAfterUpdate,
      reserveParentReportPath,
      resolveCurrentCallerAgent,
      resolveManagedDeliveryRoute,
      resolvePlacementWorkspace,
      resolveSpawnRecord,
      restoreFocusAfterRender,
      spawnDeliveryWorkspace,
      stateMgr,
      watchRegistryPath,
      withSurfaceWrite,
    });

    // wait_for (src/mcp/tools/send.ts, CX-3b S10b)
    registerWaitForTool(server, {
      collectSurfaceTopology,
      engine,
      evaluateServerAgentHealth,
      observeAgentOnce,
      refreshManagedMetadataBestEffort,
      registry,
      resolveCurrentCallerAgent,
      inboxOpts,
    });

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

    // 16. stop_agent
    const reapTailAfterConfirmedExit = async (
      target: AgentRecord | null,
    ) => {
      // A missing PID is not proof that the agent has stopped. Keep the
      // recorded tail until the process identity is known to be gone.
      if (!target?.pid || agentProcessLiveness(target) !== "gone") return {};
      return reapInboxTail(target.agent_id, inboxOpts);
    };
    stopAgentFn = (args) =>
      stopAgent(
        {
          appendCloseEvent,
          assertSurfaceMutationAllowed,
          engine,
          inboxOpts,
          pruneChildReportWatchesFor,
          reapTailAfterConfirmedExit,
          resolveCloseCaller,
        },
        args,
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
    // send_to (src/mcp/tools/send.ts, CX-3b S10b)
    registerSendToTool(server, {
      rawSend: {
        sendInput: (args) => sendInput(rawSendDeps, args),
        sendCommand: (args) => sendCommand(rawSendDeps, args),
        sendKey: (args) => sendKey(rawSendDeps, args),
      },
      assertWorkerUpwardChannel,
      awaitLifecycleStart,
      broadcastSkipReason,
      canonicalWorkspaceRef,
      collectDeliveryEvidence,
      collectTargetRecords,
      deliverAgentInput,
      engine,
      observePausedTarget,
      registry,
    });

  } // end skipAgentLifecycle guard

  registerPaletteExpansion();

  return server;
}
