/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import { randomUUID } from "node:crypto";
import { scheduler } from "node:timers/promises";
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  resolveClosureState,
} from "./coordination-paths.js";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { StateManager } from "./state-manager.js";
import { initializeNewSurfaceRuntime } from "./surface-runtime.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import { withRaisedNofileSoftLimit } from "./nofile-limit.js";
import { buildTitle } from "./naming.js";
import {
  buildRawResumeCommand,
} from "./agent-command.js";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
  type AgentFilter,
} from "./agent-registry.js";
import type { AgentDiscovery } from "./agent-discovery.js";
import {
  INTERACTIVE_AGENT_STATES,
  isLiveActive,
  resolveLiveAgentState,
  type LiveAgentState,
} from "./live-agent-state.js";

import {
  resumeCommandForAgent,
  resumeInvocationForAgent,
  toPublicAgent,
} from "./agent-facade.js";
import type {
  CmuxNewSplitResult,
  CmuxReadScreenResult,
  CmuxStatusUpdate,
} from "./types.js";
import {
  generateAgentId,
  CLI_EXIT_ERROR,
  MAX_SPAWN_DEPTH,
  MAX_CHILDREN,
  resolveBootPromptText,
  shouldRetainForExplicitResume,
  summarizeTaskSummary,
  type AgentRoute,
  isValidTransition,
  type AgentRecord,
  type AgentRole,
  type AgentState,
  type CliType,
  type CloseForensicsEvent,
  type PublicAgent,
  type WaitResult,
} from "./agent-types.js";
import type { CloseForensicsSweepResult } from "./close-forensics.js";
import {
  armWatch as armDeclaredWatch,
  isInterruptedEngineDeadlineClaim,
  readWatchRegistry,
  releaseWatchWaiter,
  removeWatches,
  sweepWatches,
  type WatchAgentObservation,
  type WatchNotify,
  type WatchRecord,
  type WatchSpec,
} from "./watch-spec.js";
import {
  canonicalAgentId,
  canonicalAgentIdValue,
  resolveWatchOwnerFromSources,
  watchOwnerIncludesCanonical,
  watchRecordOwner,
  type WatchOwnerResolution,
} from "./watch-owner.js";
import {
  ANTIGRAVITY_BANNER_RE,
  antigravityScreenIsActive,
  cleanScreenText,
  isAntigravityScreen,
  parseScreen,
} from "./screen-parser.js";

export function isSubjectSideReportWatchPruneEligible(
  watch: Pick<WatchRecord, "target_kind" | "change" | "provenance">,
): boolean {
  return (
    watch.provenance !== "public" &&
    watch.target_kind === "file" &&
    watch.change === "content"
  );
}
import {
  canonicalRoleColumn,
  chooseAgentSpawnPlacement,
  chooseSurfaceClosePolicy,
  collectRoleSurfaceIds,
  deriveRoleColumnIndex,
  inferAgentRole,
  inferRecordRole,
  inferRecordRoleOrNull,
  isAgentRoleInferenceError,
  topPaneInRoleColumn,
  type RoleSurfaceIds,
} from "./layout-policy.js";
import {
  CLI_INPUT_PROMPT_PREFIXES,
  lineStartsWithCliInputPrompt,
  matchReadyPattern,
  screenHasActiveAgentMarker,
  screenHasReadyAgentIdentity,
} from "./pattern-registry.js";
import {
  normalizeWorkspaceRefAlias,
  reposEquivalent,
  resolveWorkspaceRefForRepo,
} from "./repo-workspace.js";
import { SpawnGuard } from "./spawn-guard.js";
import { DeliveryQueue } from "./engine/delivery-queue.js";
import * as haltImpl from "./engine/halt.js";
import { screenTextSignature } from "./engine/halt.js";
import {
  reconcileAgents as reconcileAgentsWith,
  type ReconcileHost,
} from "./engine/reconcile.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
import {
  buildSurfaceBindingObservation,
  isPaneSurfaceEnumerationComplete,
  resolveObservedAgentSurfaceRef,
  type SurfaceBindingObservation,
} from "./surface-binding-observation.js";
import {
  findLatestHarnessSessionIdentity,
  harnessJsonlEnabled,
  loadHarnessSessionWithMeta,
  readHarnessSessionFromFile,
  type Harness,
  type HarnessSessionWithMeta,
} from "./harness-session.js";
import {
  resolveSpawnEffort,
  resolveSpawnModelPolicy,
} from "./model-policy.js";
import {
  DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY,
  type AgentHealth,
  type AgentHealthInput,
} from "./agent-health.js";
import {
  defaultRepoCheckoutPath,
} from "./repo-root-fallback.js";
import {
  assertSeatIdentity,
  loadSeatRegistryFromConfig,
  type SeatRegistry,
} from "./seat-identity.js";
import {
  latestMonitorForOwnerSeats,
  sweepMonitorRegistry,
  transferMonitorRegistryOwner,
  type MonitorDeadmanNotify,
} from "./monitor-registry.js";
import {
  captureSurfaceObserverEpoch as captureObserverEpoch,
  collectSurfaceTopology,
  enumerateAllWindowWorkspacesWithRetry,
  isSurfaceObserverEpochCurrent,
  resolveAgentSurfaceBinding,
  type AllWindowWorkspaceEnumeration,
  type SurfaceObserverEpoch,
  type SurfaceObserverIdProvider,
  type TopologyRpcObserver,
  type SurfaceTopologySnapshot,
} from "./surface-topology.js";
import {
  getTransportHealth,
} from "./cmux-transport-self-heal.js";
import {
  DEFAULT_CHANNEL_MARKER_RETENTION_MS,
  agentDir,
  dispatchOnce,
  reapOrphanedPendingChannelMarkers,
  removePendingChannelMarkerAfterRegistration,
  type InboxOpts,
} from "./inbox.js";
import {
  agentProcessLiveness,
  agentProcessMayBeAlive,
  processLiveness,
  type ProcessLiveness,
} from "./process-liveness.js";
import {
  AgentLaunchError,
  TERMINAL_STATES,
  WAIT_FOR_SWEEP_INTERVAL_MS,
  WATCH_OBSERVATION_READ_ATTEMPTS,
  LIVE_EVIDENCE_TTL_MS,
  WAIT_FOR_LIVE_EVIDENCE_INTERVAL_MS,
  DEFAULT_SWEEP_ACTIVE_INTERVAL_MS,
  DEFAULT_SWEEP_IDLE_INTERVAL_MS,
  DEFAULT_SWEEP_IDLE_AFTER_SWEEPS,
  DEFAULT_POST_SPAWN_LIVENESS_MS,
  DEFAULT_STOP_POST_CONDITION_TIMEOUT_MS,
  MAX_SPAWN_SESSION_CAPTURE_MS,
  SPAWN_SESSION_CAPTURE_POLL_MS,
  CHANNEL_MARKER_REAP_INTERVAL_MS,
  CHANNEL_MARKER_REAP_RETRY_MS,
  STOP_POST_CONDITION_POLL_MS,
  BOOT_SESSION_CAPTURE_LINES,
  MAX_DEFERRED_TRANSCRIPT_CAPTURE_ATTEMPTS,
  BOOT_READY_TIMEOUT_MS,
  BOOT_PROMPT_PENDING_STALE_MS,
  TASK_DONE_CONFIRMATION_MS,
  CLI_EXIT_SHELL_CONFIRMATION_SWEEPS,
  DEFAULT_HALT_AWAITING_INPUT_DWELL_MS,
  DEFAULT_HALT_IDLE_WITHOUT_DONE_DWELL_MS,
  DEFAULT_HALT_WEDGED_DWELL_MS,
  DEFAULT_HALT_WEDGED_SWEEPS,
  DONE_QUIESCENCE_MS,
  JSONL_HARNESSES,
  TRANSCRIPT_SESSION_CAPTURE_STATES,
  PlacementSurfaceBindingError,
  LifecycleLockReacquireError,
  PlacementTimeoutError,
  PlacementPendingError,
  DEFAULT_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS,
  DEFAULT_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS,
  DEFAULT_SPAWN_PLACEMENT_TIMEOUT_MS,
  SPAWN_PLACEMENT_OBSERVE_INTERVAL_MS,
  UNKNOWN_SPLIT_RPC_TIMEOUT_MS,
  LifecycleLockTimeoutError,
  LIFECYCLE_LOGS,
} from "./engine/types.js";
import type {
  LiveStateResolver,
  FreshLiveStateProbe,
  AgentDeliveryReceipt,
  DeliveryVerifier,
  DeliverySnapshotReader,
  DeliveryIssueFiler,
  DeliverySubmitter,
  SpawnAgentParams,
  SpawnAgentResult,
  HarvestabilityDoneSource,
  HarvestabilityEvidenceChannel,
  KeptOpenContract,
  WorkerHarvestability,
  AgentSurfacePlacement,
  CreatedAgentSurface,
  CapturedSessionIdentity,
  SessionIdentityResolver,
  SpawnPreflightResult,
  CodexModelListRunner,
  AgentEngineOptions,
  SelfRegistrationSessionEntry,
  RolePlacementReconcileTrigger,
  RolePlacementReconcileSummary,
  AgentLifecycleEvent,
  SidebarStatusSnapshot,
  SweepTimingOptions,
  SweepTimingInput,
  SweepAgentContext,
  SweepMutationSkipAccounting,
  StopPostConditionResult,
  StopSurfaceClosePolicy,
  TargetStateEvidenceSource,
  RefreshedTargetStateEvidenceSource,
  LifecycleLockTimeoutRecord,
  LifecycleLockState,
  AgentEngineClient,
  AgentLaunchMode,
  ModelPinSource,
} from "./engine/types.js";
import {
  defaultCodexModelListRunner,
  validateCodexModel,
  computeModelMismatch,
  parseCodexEffort,
  computeEffortMismatch,
  resolveLaunchModelFlagForCommand,
  describeModelPin,
  buildLaunchCommand,
  extractSessionId,
  resolveSpawnLaunchPlan,
} from "./engine/launch-command.js";

// Public surface kept stable: these moved to ./engine/launch-command.ts (CX-2 E2).
export {
  computeModelMismatch,
  parseCodexEffort,
  computeEffortMismatch,
  rawModelFlagToken,
  resolveLaunchModelFlagForCommand,
  describeModelPin,
  buildLaunchCommand,
  extractSessionId,
  assertLauncherAvailable,
  REQUIRE_LAUNCHER_REGISTRY_ENV,
  launcherRegistryRequired,
  resolveSpawnLaunchPlan,
} from "./engine/launch-command.js";


// Public surface kept stable: these moved to ./engine/types.ts (CX-2 E1).
export {
  DEFAULT_DELIVERY_VERIFY_DEADLINE_MS,
  DEFAULT_DELIVERY_QUEUE_DEADLINE_MS,
  DELIVERY_TARGET_GONE_CONFIRM_MISSES,
  DELIVERY_UNCHANGED_SCREEN_ATTENTION_ATTEMPTS,
  RetryableDeliveryError,
  AgentLaunchError,
  DEFAULT_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS,
  DEFAULT_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS,
  LifecycleLockTimeoutError,
} from "./engine/types.js";
export type {
  LiveStateResolver,
  FreshLiveStateProbe,
  AgentDeliveryState,
  AgentDeliveryReceipt,
  DeliveryVerifySnapshot,
  DeliveryVerifyObservation,
  SpawnAgentParams,
  SpawnAgentResult,
  HarvestabilityDoneSource,
  HarvestabilityEvidenceChannel,
  KeptOpenContract,
  WorkerHarvestability,
  CapturedSessionIdentity,
  SessionIdentityResolver,
  SpawnPreflightResult,
  CodexModelListRunner,
  AgentEngineOptions,
  SelfRegistrationSessionEntry,
  RolePlacementReconcileTrigger,
  RolePlacementReconcileSummary,
  AgentLifecycleEvent,
  SweepTimingOptions,
  LifecycleLockTimeoutRecord,
  LifecycleLockState,
  AgentLaunchMode,
  ModelPinSource,
} from "./engine/types.js";



function isWorktreeLaunch(
  params: Pick<SpawnAgentParams, "cwd" | "worktree_branch">,
): boolean {
  if (params.worktree_branch) return true;
  const cwd = params.cwd;
  if (!cwd) return false;
  return (
    /(?:^|[/\\])[^/\\]+\.wt(?:[/\\]|$)/.test(cwd) ||
    /(?:^|[/\\])\.worktrees(?:[/\\]|$)/.test(cwd)
  );
}

/**
 * The title of a managed pane (#492 / #479). A caller-supplied title is already
 * the complete human-facing label, including its role/task convention, so the
 * engine must not compose launcher, surface, or agent-id text around it. Legacy
 * callers that omit or blank a title retain the existing agent-id/surface
 * fallback. Managed repo/CLI/role identity stays in AgentRecord and discovery
 * reads that registry state; the display title is never the identity source.
 */
export function managedPaneTitle(
  agentId: string,
  surface: string,
  title?: string | null,
): string {
  return title?.trim() ? title : buildTitle(`${agentId} [${surface}]`);
}

function sessionCollisionSuffix(sessionId: string): string {
  const normalized = sessionId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-");
  return (
    normalized.slice(9, 17).replace(/^-+|-+$/g, "") ||
    normalized.slice(0, 8).replace(/^-+|-+$/g, "") ||
    "collision"
  );
}

export { buildRawResumeCommand, buildResumeCommand } from "./agent-command.js";

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function parseNonNegativeInteger(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSweepTiming(
  env: NodeJS.ProcessEnv = process.env,
  input?: SweepTimingInput,
): SweepTimingOptions {
  if (typeof input === "number") {
    return {
      activeIntervalMs: input,
      idleIntervalMs: parsePositiveInteger(
        env.CMUXLAYER_SWEEP_IDLE_INTERVAL_MS,
        DEFAULT_SWEEP_IDLE_INTERVAL_MS,
      ),
      idleAfterSweeps: parseNonNegativeInteger(
        env.CMUXLAYER_SWEEP_IDLE_AFTER_SWEEPS,
        DEFAULT_SWEEP_IDLE_AFTER_SWEEPS,
      ),
    };
  }

  const activeIntervalMs =
    input?.activeIntervalMs ??
    parsePositiveInteger(
      env.CMUXLAYER_SWEEP_INTERVAL_MS,
      DEFAULT_SWEEP_ACTIVE_INTERVAL_MS,
    );
  const idleIntervalMs =
    input?.idleIntervalMs ??
    parsePositiveInteger(
      env.CMUXLAYER_SWEEP_IDLE_INTERVAL_MS,
      DEFAULT_SWEEP_IDLE_INTERVAL_MS,
    );
  const idleAfterSweeps =
    input?.idleAfterSweeps ??
    parseNonNegativeInteger(
      env.CMUXLAYER_SWEEP_IDLE_AFTER_SWEEPS,
      DEFAULT_SWEEP_IDLE_AFTER_SWEEPS,
    );

  return {
    activeIntervalMs,
    idleIntervalMs,
    idleAfterSweeps,
  };
}

export class AgentEngine {
  private stateMgr: StateManager;
  private liveStateResolver: LiveStateResolver | null = null;
  private freshLiveStateProbe: FreshLiveStateProbe | null = null;
  /** Forced observations, TTL-bounded, keyed by agent id. */
  private freshLiveStates = new Map<
    string,
    { live: LiveAgentState; at: number }
  >();
  private registry: AgentRegistry;
  private client: AgentEngineClient;
  private spawnPreflight: (
    params: SpawnAgentParams,
  ) => Promise<SpawnPreflightResult | void>;
  private codexModelListRunner: CodexModelListRunner;
  private spawnGuard: SpawnGuard;
  private postSpawnLivenessMs: number;
  private stopPostConditionTimeoutMs: number;
  private spawnSessionCaptureTimeoutMs: number;
  private roleSurfaceIdsProvider?: (
    liveSurfaceIds?: ReadonlySet<string>,
    workspace?: string,
    observation?: SurfaceBindingObservation,
  ) => RoleSurfaceIds;
  private launchCommandSender?: AgentEngineOptions["launchCommandSender"];
  private inboxOpts?: InboxOpts;
  private lastChannelMarkerReapAt: number | null = null;
  private lastChannelMarkerReapFailureAt: number | null = null;
  private sessionIdentityResolver: SessionIdentityResolver;
  private hasCustomSessionIdentityResolver: boolean;
  private selfRegistrationSessionResolver: SessionIdentityResolver | null;
  private selfRegistrationSessionLookup:
    | ((sessionId: string) => SelfRegistrationSessionEntry | null)
    | null;
  private seatRegistry: SeatRegistry | null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private postSpawnLivenessTimers = new Set<ReturnType<typeof setTimeout>>();
  private sweepTiming: SweepTimingOptions | null = null;
  private lastSweepSignature: string | null = null;
  private unchangedSweepCount = 0;
  private currentSweepScreenSignatures = new Map<string, string>();
  private sweepDebugLog: (message: string) => void;
  /** agentId → last-pushed status target/value */
  private sidebarSnapshot = new Map<string, SidebarStatusSnapshot>();
  /** e.g. "a1:spawned", "a1:done", "a1:error" */
  private loggedEvents = new Set<string>();
  /** e.g. "a1:done", "a1:health:unhealthy(...)" */
  private notifiedEvents = new Set<string>();
  /** agentId values whose current lead monitor-death alert was delivered. */
  private deliveredLeadMonitorDeathAlerts = new Set<string>();
  /** agentId → consecutive ready-prompt matches */
  private readyPatternMatches = new Map<string, number>();
  /** agentId → consecutive bound-screen observations at a bare shell. */
  private cliExitShellMatches = new Map<string, number>();
  /** One failed safe-resolution attempt per unchanged prompt screen. */
  private promptResolutionFailures = new Map<string, string>();
  /** Last time changing output proved that chooser chrome belonged to live work. */
  private promptMotionObservedAtMs = new Map<string, number>();
  /** Last raw chooser screen used only to prove visible cross-sweep motion. */
  private promptMotionScreenSignatures = new Map<string, string>();
  /** Best-effort outbox drainer invoked each sweep (injectable for tests). */
  private outboxDrain: () => Promise<unknown>;
  /** Guards against overlapping outbox drains if a sweep runs long. */
  private outboxDrainInFlight = false;
  private monitorRegistryPath?: string;
  private monitorRegistryNow?: () => number;
  private monitorRegistryNotify: MonitorDeadmanNotify;
  private monitorRegistrySweepInFlight = false;
  private watchRegistryPath?: string;
  private watchRegistryNow?: () => number;
  private watchNotify: WatchNotify;
  private watchSweepInFlight = false;
  private childReportWatchPrunePending = false;
  /** Best-effort close-forensics ingest; null when disabled. */
  private closeForensicsRunner:
    | (() => CloseForensicsSweepResult | Promise<CloseForensicsSweepResult>)
    | null;
  private closeForensicsSweepInFlight = false;
  private startupInitializePromise: Promise<void> | null = null;
  private lifecycleMutationTail: Promise<void> = Promise.resolve();
  /** Serialize placement decisions and topology mutations within one workspace. */
  private placementTails = new Map<string, Promise<void>>();
  /** A split returned by cmux must be visible before the next placement reads topology. */
  private pendingPlacementSplits = new Map<
    string,
    { pane: string; surface: string; surfaceId?: string; uncertain?: boolean;
      unknownStartedAt?: number; settleWindowMs?: number }
  >();
  private placementSplitInFlight = new Set<string>();
  private readonly lifecycleLockAcquireTimeoutMs: number;
  private readonly lifecycleLockHoldTimeoutMs: number;
  private lifecycleLockHolder: string | null = null;
  /**
   * #530 review (Macroscope/CodeRabbit): labels are shared strings like
   * "sweep", so an orphaned operation's `finally` could clear a NEWER holder's
   * state and blank the diagnostics this PR exists to add. Ownership is tracked
   * by a per-acquisition token instead.
   */
  private lifecycleLockAcquisitionSeq = 0;
  private lifecycleLockAcquisitionId: number | null = null;
  private lifecycleLockAcquiredAtMs: number | null = null;
  private lifecycleLockQueueDepth = 0;
  private lifecycleLockForcedReleases = 0;
  private sweepSkippedMutations = 0;
  private sweepSkippedReason: string | null = null;
  private sweepYielded = 0;
  private sweepTelemetrySeq = 0;
  private sweepTopologyGeneration = 0;
  private lifecycleLockTimeouts = 0;
  private lifecycleLockLastTimeout: LifecycleLockTimeoutRecord | null = null;
  private readonly deliveryQueue: DeliveryQueue;
  private haltNow: () => number;
  private haltAwaitingInputDwellMs: number;
  private haltIdleWithoutDoneDwellMs: number;
  private haltWedgedDwellMs: number;
  private haltWedgedSweeps: number;
  private haltProcessSnapshot?: () => string | Promise<string>;
  private sweepBackgroundProcessSnapshot: Promise<string | null> | null = null;
  private backgroundChildCpuTimes = new Map<string, Map<number, string>>();
  private autoResolvePrompts: boolean;
  constructor(
    stateMgr: StateManager,
    registry: AgentRegistry,
    client: AgentEngineClient,
    opts?: AgentEngineOptions,
  ) {
    this.stateMgr = stateMgr;
    this.lifecycleLockAcquireTimeoutMs = Math.max(
      0,
      opts?.lifecycleLockAcquireTimeoutMs ??
        parseNonNegativeInteger(
          process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS,
          DEFAULT_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS,
        ),
    );
    this.lifecycleLockHoldTimeoutMs = Math.max(
      0,
      opts?.lifecycleLockHoldTimeoutMs ??
        parseNonNegativeInteger(
          process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS,
          DEFAULT_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS,
        ),
    );
    this.haltNow = opts?.haltNow ?? Date.now;
    this.haltAwaitingInputDwellMs = Math.max(
      0,
      opts?.haltAwaitingInputDwellMs ??
        parseNonNegativeInteger(
          process.env.CMUXLAYER_HALT_AWAITING_INPUT_DWELL_MS,
          DEFAULT_HALT_AWAITING_INPUT_DWELL_MS,
        ),
    );
    this.haltIdleWithoutDoneDwellMs = Math.max(
      0,
      opts?.haltIdleWithoutDoneDwellMs ??
        parseNonNegativeInteger(
          process.env.CMUXLAYER_HALT_IDLE_WITHOUT_DONE_DWELL_MS,
          DEFAULT_HALT_IDLE_WITHOUT_DONE_DWELL_MS,
        ),
    );
    this.haltWedgedDwellMs = Math.max(
      0,
      opts?.haltWedgedDwellMs ??
        parseNonNegativeInteger(
          process.env.CMUXLAYER_HALT_WEDGED_DWELL_MS,
          DEFAULT_HALT_WEDGED_DWELL_MS,
        ),
    );
    this.haltWedgedSweeps = Math.max(
      1,
      opts?.haltWedgedSweeps ??
        parsePositiveInteger(
          process.env.CMUXLAYER_HALT_WEDGED_SWEEPS,
          DEFAULT_HALT_WEDGED_SWEEPS,
        ),
    );
    this.haltProcessSnapshot = opts?.haltProcessSnapshot;
    this.autoResolvePrompts =
      process.env.CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE === "1";
    this.deliveryQueue = new DeliveryQueue(
      {
        stateMgr,
        registry,
        getAgentState: (agentId) => this.getAgentState(agentId),
        markAgentWorking: (agentId, markOpts) =>
          this.markAgentWorking(agentId, markOpts),
      },
      opts,
    );
    this.registry = registry;
    this.client = client;
    this.sweepDebugLog =
      opts?.sweepDebugLog ??
      ((message) => process.stderr.write(`${message}\n`));
    this.roleSurfaceIdsProvider = opts?.roleSurfaceIdsProvider;
    this.launchCommandSender = opts?.launchCommandSender;
    this.inboxOpts = opts?.inboxOpts;
    this.seatRegistry =
      opts?.seatRegistry !== undefined
        ? opts.seatRegistry
        : this.loadSeatRegistry(opts?.seatRegistryPath);
    this.hasCustomSessionIdentityResolver =
      opts?.sessionIdentityResolver !== undefined;
    // Default DISABLED (null): bare construction (tests, libraries) must never
    // read the real `~/.cmuxlayer/session-registry.jsonl`. Production entrypoints
    // inject `makeSelfRegistrationSessionResolver()` (see entry.ts / daemon.ts /
    // app-server-runtime).
    this.selfRegistrationSessionResolver =
      opts?.selfRegistrationSessionResolver ?? null;
    this.selfRegistrationSessionLookup =
      opts?.selfRegistrationSessionLookup ?? null;
    const fallbackSessionIdentityResolver = opts?.sessionIdentityResolver;
    this.sessionIdentityResolver = (agent) =>
      this.resolveSessionIdentityWithSelfRegistration(
        agent,
        fallbackSessionIdentityResolver,
      );
    // Default no-op: constructing an engine (tests, libraries) must never touch
    // the real outbox or network. Production entrypoints inject the real
    // drainOutbox (see server.ts createServer / app-server-runtime).
    this.outboxDrain = opts?.outboxDrain ?? (async () => {});
    this.monitorRegistryPath = opts?.monitorRegistryPath;
    this.monitorRegistryNow = opts?.monitorRegistryNow;
    this.monitorRegistryNotify =
      opts?.monitorRegistryNotify ?? (async () => {});
    this.watchRegistryPath = opts?.watchRegistryPath;
    this.watchRegistryNow = opts?.watchRegistryNow;
    this.watchNotify = opts?.watchNotify ?? (async () => {});
    this.childReportWatchPrunePending = Boolean(this.watchRegistryPath);
    // Default DISABLED: bare construction (tests, libraries) must never read the
    // real `~/.cmuxterm/events.jsonl`. Production entrypoints inject the real
    // runner (see app-server-runtime / server.ts createServer). `null` keeps it
    // off; an explicit runner (tests) drives it deterministically.
    this.closeForensicsRunner =
      opts?.closeForensicsRunner !== undefined
        ? opts.closeForensicsRunner
        : null;
    this.spawnGuard = opts?.spawnGuard ?? new SpawnGuard();
    this.postSpawnLivenessMs =
      opts?.postSpawnLivenessMs ??
      parseNonNegativeInteger(
        process.env.CMUXLAYER_POST_SPAWN_LIVENESS_MS,
        DEFAULT_POST_SPAWN_LIVENESS_MS,
      );
    this.stopPostConditionTimeoutMs =
      opts?.stopPostConditionTimeoutMs ??
      parseNonNegativeInteger(
        process.env.CMUXLAYER_STOP_POST_CONDITION_TIMEOUT_MS,
        DEFAULT_STOP_POST_CONDITION_TIMEOUT_MS,
      );
    this.spawnSessionCaptureTimeoutMs = Math.max(
      0,
      Math.min(
        MAX_SPAWN_SESSION_CAPTURE_MS,
        opts?.spawnSessionCaptureTimeoutMs ?? MAX_SPAWN_SESSION_CAPTURE_MS,
      ),
    );
    this.codexModelListRunner =
      opts?.codexModelListRunner ?? defaultCodexModelListRunner;
    this.spawnPreflight =
      opts?.spawnPreflight ??
      (async (params): Promise<SpawnPreflightResult | void> => {
        if (params.cli === "kiro") return;
        if (params.cli === "codex") {
          await validateCodexModel(params.model, this.codexModelListRunner);
        }
        return resolveSpawnLaunchPlan(params.repo, params.cli);
      });
  }

  private loadSeatRegistry(
    configPath: string | undefined,
  ): SeatRegistry | null {
    try {
      return loadSeatRegistryFromConfig(configPath);
    } catch {
      return null;
    }
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /**
   * AIDEV-NOTE (F1): P11 closure is a statement about what an agent IS doing,
   * so it must read the live-derived state. Reading `agent.state` made a
   * working agent report `closure:"artifact_missing"` -- which P11's own table
   * means "route a reviewer NOW" -- purely because #408 had flipped its
   * registry record to `done`. The server injects the live probe; without one
   * this degrades to the record, and says so through the resolution's `source`.
   */
  setLiveStateResolver(resolver: LiveStateResolver | null): void {
    this.liveStateResolver = resolver;
  }

  /**
   * AIDEV-NOTE (F1b round 2): the probe that lets a path FORCE evidence instead
   * of depending on an incidentally-warm scan cache. The server wires it to a
   * single-surface discovery scan; without it `refreshLiveState` degrades to
   * the sync resolver, and this engine behaves exactly as it did before.
   */
  setFreshLiveStateProbe(probe: FreshLiveStateProbe | null): void {
    this.freshLiveStateProbe = probe;
    this.freshLiveStates.clear();
  }

  /**
   * Read one agent's screen NOW and memoize the resolution for
   * `LIVE_EVIDENCE_TTL_MS`. The memo is what makes the forced read pay for the
   * whole tick: `liveStateOf` -- and so every live gate reached from the same
   * turn, closure included -- sees the evidence this call bought.
   */
  async refreshLiveState(agent: AgentRecord): Promise<LiveAgentState> {
    const probe = this.freshLiveStateProbe;
    if (!probe) return this.liveStateOf(agent);
    let live: LiveAgentState | null = null;
    try {
      live = await probe(agent);
    } catch {
      // A failed read is not evidence; fall back to whatever else is known.
      live = null;
    }
    if (!live) return this.liveStateOf(agent);
    const at = Date.now();
    for (const [agentId, entry] of this.freshLiveStates) {
      if (at - entry.at >= LIVE_EVIDENCE_TTL_MS) {
        this.freshLiveStates.delete(agentId);
      }
    }
    this.freshLiveStates.set(agent.agent_id, { live, at });
    return live;
  }

  /**
   * The live state a WAIT may terminate on.
   *
   * AIDEV-NOTE (F1b round 2): F1's rule, applied to termination. Only positive
   * evidence of ACTIVITY -- the screen showing the agent still working -- is
   * strong enough to overturn a terminal record. A ready prompt is where a
   * finished worker sits, and a pane reclaimed by a bare shell says nothing
   * about whether the task completed; treating either as truth would fail an
   * agent that genuinely finished (`wait_for(done)` reporting `error` because
   * the pane was later reclaimed). The record keeps terminal states it earned;
   * it only loses the ones the screen contradicts with work in progress.
   */
  private terminationStateOf(
    agent: AgentRecord,
    live: LiveAgentState,
  ): AgentState {
    if (TERMINAL_STATES.has(agent.state) && !isLiveActive(live)) {
      return agent.state;
    }
    return live.state;
  }

  /** Live state for one record, or the record's own state when unprobed. */
  liveStateOf(agent: AgentRecord): LiveAgentState {
    const memo = this.freshLiveStates.get(agent.agent_id);
    // The memo is a reconciliation OF a specific record. If the record moved,
    // the reconciliation is about a state that no longer exists -- drop it, or
    // a wait would keep answering with evidence about the agent's past.
    if (
      memo &&
      Date.now() - memo.at < LIVE_EVIDENCE_TTL_MS &&
      memo.live.registry_state === agent.state
    ) {
      return memo.live;
    }
    return (
      this.liveStateResolver?.(agent) ?? resolveLiveAgentState(agent, null)
    );
  }

  /**
   * AIDEV-NOTE (T1b/#488): `live` is how a caller that ALREADY has a screen
   * observation hands it in, so one response cannot resolve `closure` from one
   * evidence source and `state` from another. `list_agents` takes a fresh scan
   * on every call and then rendered closure off `cachedScan()`, which returns
   * null once that scan is 2000ms old -- so the same row said `working` and
   * `artifact_missing`, and flapped as the cache aged. Callers without an
   * observation keep the injected probe; there is no new screen read here.
   */
  assessHarvestability(
    agent: AgentRecord,
    opts?: { live?: LiveAgentState | null },
  ): WorkerHarvestability {
    const issueCodes: string[] = [];
    const issues: string[] = [];
    const addIssue = (code: string, message: string): void => {
      if (!issueCodes.includes(code)) issueCodes.push(code);
      if (!issues.includes(message)) issues.push(message);
    };

    const role = agent.role ?? inferRecordRoleOrNull(agent);
    // AIDEV-NOTE (F1): closure is derived from the LIVE state, but only ONE
    // live observation is strong enough to overturn a recorded `done`: the
    // screen showing the agent still WORKING. That is what #408 produced live
    // (`state {value:"working", source:"screen"}` beside `detail.state:"done"`)
    // and it made P11 report `artifact_missing` -- "route a reviewer NOW" --
    // on an agent mid-turn. A `ready` prompt cannot overturn done (a finished
    // worker sits at one too), and a dead/shell pane must not either: there
    // the record's `done` plus the missing artifact IS the story.
    const live = opts?.live ?? this.liveStateOf(agent);
    const effectiveState = isLiveActive(live) ? live.state : agent.state;
    const neutralEvidenceChannel: HarvestabilityEvidenceChannel = {
      done_source: agent.task_done_detected_at ? "screen" : "none",
      degraded: false,
      reason: null,
    };
    if (effectiveState !== "done" || role === "orchestrator") {
      // AIDEV-NOTE (F1): the contract PAIR is state-independent -- report_path
      // and done_marker are what the lead must check whenever it looks. The
      // record-only read here was invisible while `done` always took the branch
      // below; now that a live-working agent can land here, a prose-contract
      // agent would have reported a null pair mid-turn.
      const preClosureGoal = this.readClosureGoalContract(
        agent.goal_file ?? null,
        agent,
      );
      return {
        closeable: false,
        closure: resolveClosureState({
          state: effectiveState,
          role,
          // A contract exists if EITHER source supplies one; sourcing this from
          // the record alone made a legacy prose agent read not_applicable while
          // working and verified once done (reviewer nit).
          contractIssued:
            Boolean(agent.report_path && agent.done_marker) ||
            Boolean(agent.goal_file),
          closureArtifactVerified: null,
          // Unreachable as a deadlock claim: this branch is not `done`.
          doneEvidence: false,
        }),
        closure_artifact_verified: null,
        report_path: preClosureGoal.reportPath,
        done_marker: preClosureGoal.doneMarker,
        report_exists: null,
        report_fresh: null,
        report_final_line: null,
        pr_loop_required: false,
        pr_loop_satisfied: null,
        kept_open: null,
        evidence_channel: neutralEvidenceChannel,
        issue_codes: issueCodes,
        issues,
      };
    }

    const evidenceChannel = this.readHarvestabilityEvidenceChannel(agent);
    const goal = this.readClosureGoalContract(agent.goal_file ?? null, agent);
    const engineIssued = Boolean(agent.report_path && agent.done_marker);
    const reportText = goal.reportPath
      ? this.readTextFile(goal.reportPath)
      : null;
    const reportExists = goal.reportPath ? reportText !== null : null;
    // AIDEV-NOTE (P11): freshness needs a baseline, and an engine-issued
    // contract has no goal file to compare against. The correct analogue is the
    // spawn that ISSUED the contract -- otherwise reportFresh is null forever
    // and closure_artifact_verified can never become true for a spawned worker.
    const reportFresh =
      goal.reportPath && reportText !== null
        ? engineIssued
          ? this.reportIsFreshForIssuedContract(goal.reportPath, agent)
          : this.reportIsFreshForGoalContract(
              goal.reportPath,
              agent.goal_file ?? null,
            )
        : null;
    const reportFinalLine = reportText
      ? this.extractFinalNonEmptyLine(reportText)
      : null;
    const closureArtifactVerified =
      Boolean(goal.reportPath) &&
      Boolean(goal.doneMarker) &&
      reportText !== null &&
      reportFresh === true &&
      reportFinalLine === goal.doneMarker;
    // AIDEV-NOTE (T1b/#488): the POSITIVE done evidence `artifact_missing`
    // now requires. `evidence_channel.done_source` is already the engine's
    // answer to "what saw this agent finish" -- `screen` from
    // task_done_detected_at, `transcript` from the harness JSONL -- and a
    // screen that itself reads `done` counts. `none` means the only thing
    // claiming done is the record, which #408 writes without observing
    // anything.
    const doneEvidence =
      evidenceChannel.done_source !== "none" || live.screen_state === "done";
    const keptOpen = reportText
      ? this.extractKeptOpenContract(reportText)
      : null;
    const prLoopRequired = this.isPrLoopRequired(
      agent,
      goal.goalText,
      reportText,
    );
    const prLoopSatisfied = prLoopRequired
      ? this.isPrLoopSatisfied(reportText ?? "")
      : null;

    if (!agent.goal_file || goal.goalReadFailed) {
      addIssue(
        "terminal_contract_missing",
        "worker has no readable file-backed terminal contract",
      );
    }
    if (!goal.reportPath || !goal.doneMarker) {
      addIssue(
        "terminal_contract_missing",
        "worker terminal contract does not name a report path and DONE marker",
      );
    } else if (!reportExists) {
      addIssue(
        "report_missing",
        `worker report file is missing: ${goal.reportPath}`,
      );
    } else if (reportFresh === false) {
      addIssue(
        "report_stale",
        "worker report was last modified before the goal contract file",
      );
    } else if (!closureArtifactVerified) {
      addIssue(
        "done_marker_mismatch",
        `worker report final line is ${reportFinalLine ?? "empty"}, expected ${goal.doneMarker}`,
      );
    }
    if (keptOpen?.present) {
      addIssue(
        "kept_open",
        `worker requested KEPT_OPEN${keptOpen.reason ? `: ${keptOpen.reason}` : ""}`,
      );
      if (!keptOpen.complete) {
        addIssue(
          "kept_open_contract_incomplete",
          "KEPT_OPEN requires reason, owner, and next check",
        );
      }
    }
    if (prLoopRequired && prLoopSatisfied === false) {
      addIssue(
        "pr_loop_incomplete",
        "PR-loop worker did not record merged/reviewed status or an explicit handoff",
      );
    }
    if (evidenceChannel.degraded) {
      addIssue(
        "degraded_evidence_channel",
        evidenceChannel.reason ?? "done evidence channel is degraded",
      );
    }

    return {
      closeable:
        closureArtifactVerified &&
        !keptOpen?.present &&
        (!prLoopRequired || prLoopSatisfied === true),
      closure: resolveClosureState({
        state: effectiveState,
        role,
        contractIssued: Boolean(goal.reportPath && goal.doneMarker),
        closureArtifactVerified,
        doneEvidence,
      }),
      closure_artifact_verified: closureArtifactVerified,
      report_path: goal.reportPath,
      done_marker: goal.doneMarker,
      report_exists: reportExists,
      report_fresh: reportFresh,
      report_final_line: reportFinalLine,
      pr_loop_required: prLoopRequired,
      pr_loop_satisfied: prLoopSatisfied,
      kept_open: keptOpen,
      evidence_channel: evidenceChannel,
      issue_codes: issueCodes,
      issues,
    };
  }

  private readHarvestabilityEvidenceChannel(
    agent: AgentRecord,
  ): HarvestabilityEvidenceChannel {
    const session = this.loadGroundTruthSession(agent);
    if (session?.state.done) {
      return { done_source: "transcript", degraded: false, reason: null };
    }
    const expectsHarness =
      harnessJsonlEnabled() &&
      JSONL_HARNESSES.has(agent.cli) &&
      Boolean(agent.cli_session_path || agent.cli_session_id);
    const doneSource: HarvestabilityDoneSource = agent.task_done_detected_at
      ? "screen"
      : "none";
    if (expectsHarness && !session) {
      return {
        done_source: doneSource,
        degraded: true,
        reason:
          "harness JSONL session is missing or unreadable; done evidence fell back to screen parsing",
      };
    }
    return { done_source: doneSource, degraded: false, reason: null };
  }

  /**
   * AIDEV-NOTE (P11/U10): PRECEDENCE, not replacement. An engine-issued contract
   * on the record always wins over anything parsed out of the brief -- that is
   * the S3 fix, because the prose heuristic below can resolve a DIFFERENT path
   * than the one the worker was actually told. The heuristic survives only as
   * the fallback for legacy and supersede_agent_goal records.
   */
  private readClosureGoalContract(
    goalFile: string | null,
    agent?: AgentRecord,
  ): {
    goalText: string | null;
    reportPath: string | null;
    doneMarker: string | null;
    goalReadFailed: boolean;
  } {
    const issuedReportPath = agent?.report_path ?? null;
    const issuedDoneMarker = agent?.done_marker ?? null;
    const issued = Boolean(issuedReportPath && issuedDoneMarker);
    if (!goalFile) {
      return {
        goalText: null,
        reportPath: issuedReportPath,
        doneMarker: issuedDoneMarker,
        goalReadFailed: false,
      };
    }
    const goalText = this.readTextFile(goalFile);
    if (goalText === null) {
      return {
        goalText: null,
        reportPath: issuedReportPath,
        doneMarker: issuedDoneMarker,
        goalReadFailed: !issued,
      };
    }
    return {
      goalText,
      reportPath: issued
        ? issuedReportPath
        : this.extractReportPath(goalText, goalFile),
      doneMarker: issued ? issuedDoneMarker : this.extractDoneMarker(goalText),
      goalReadFailed: false,
    };
  }

  private readTextFile(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  private extractCodeSpans(text: string): string[] {
    return [...text.matchAll(/`([^`\r\n]+)`/g)]
      .map((match) => match[1]?.trim() ?? "")
      .filter((candidate) => candidate.length > 0);
  }

  private extractReportPath(goalText: string, goalFile: string): string | null {
    const lines = goalText.split(/\r?\n/);
    const candidates: Array<{ rawPath: string; score: number; index: number }> =
      [];
    let index = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? "";
      for (const rawPath of this.extractCodeSpans(line)) {
        if (!this.isMarkdownContractPath(rawPath)) continue;
        const context = lines
          .slice(Math.max(0, lineIndex - 3), lineIndex + 1)
          .join("\n");
        const reportsSegment = /(?:^|[/\\])reports[/\\].+\.md$/i.test(rawPath);
        const reportContext =
          /\breport(?:[_ -]?path)?\b/i.test(context) ||
          /\bwrite\s+(?:the\s+)?report\b/i.test(context);
        const basenameIncludesReport =
          /(?:^|[/\\])[^/\\]*report[^/\\]*\.md$/i.test(rawPath);
        candidates.push({
          rawPath,
          score:
            (reportContext ? 100 : 0) +
            (reportsSegment ? 20 : 0) +
            (basenameIncludesReport ? 10 : 0),
          index,
        });
        index += 1;
      }
    }
    const rawPath = candidates
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .at(0)?.rawPath;
    if (!rawPath) return null;
    return this.resolveContractPath(rawPath, goalFile);
  }

  private isMarkdownContractPath(rawPath: string): boolean {
    return (
      /\.md$/i.test(rawPath) || /(?:^|[/\\])reports[/\\].+\.md$/i.test(rawPath)
    );
  }

  private resolveContractPath(rawPath: string, goalFile: string): string {
    const stripped = rawPath.trim().replace(/^file:\/\//, "");
    if (isAbsolute(stripped)) return stripped;

    const candidates: string[] = [];
    let currentDir = dirname(goalFile);
    for (let i = 0; i < 6; i += 1) {
      candidates.push(resolve(currentDir, stripped));
      const parent = dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
    candidates.push(resolve(process.cwd(), stripped));

    return (
      candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
    );
  }

  private extractDoneMarker(goalText: string): string | null {
    return (
      this.extractCodeSpans(goalText)
        .reverse()
        .find(
          (candidate) =>
            /^[A-Z0-9_:-]+$/.test(candidate) &&
            /^DONE(?:[_:-]|$)/.test(candidate),
        ) ?? null
    );
  }

  private extractFinalNonEmptyLine(text: string): string {
    return (
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1) ?? ""
    );
  }

  /**
   * Freshness for an engine-issued contract: the report must be at least as new
   * as the spawn that issued it, so a stale file left at that path by an earlier
   * occupant cannot be read as this agent's closure evidence.
   */
  private reportIsFreshForIssuedContract(
    reportPath: string,
    agent: AgentRecord,
  ): boolean | null {
    const reportMtimeMs = safeMtimeMs(reportPath);
    if (reportMtimeMs <= 0) return null;
    const issuedAtMs = Date.parse(agent.created_at ?? "");
    if (!Number.isFinite(issuedAtMs)) return null;
    return reportMtimeMs >= issuedAtMs;
  }

  private reportIsFreshForGoalContract(
    reportPath: string,
    goalFile: string | null,
  ): boolean | null {
    if (!goalFile) return null;
    const reportMtimeMs = safeMtimeMs(reportPath);
    const goalMtimeMs = safeMtimeMs(goalFile);
    if (reportMtimeMs <= 0) return null;
    if (goalMtimeMs <= 0) return null;
    return reportMtimeMs >= goalMtimeMs;
  }

  private extractLineValue(lines: string[], label: string): string | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^\\s*${escaped}\\s*:\\s*(.+)$`, "i");
    for (const line of lines) {
      const match = line.match(re);
      if (match) return match[1]?.trim() ?? null;
    }
    return null;
  }

  private extractKeptOpenContract(text: string): KeptOpenContract | null {
    const lines = text.split(/\r?\n/);
    const keptOpenIndex = lines.findIndex((line) =>
      /^\s*KEPT_OPEN:[^\r\n]+$/i.test(line),
    );
    if (keptOpenIndex < 0) return null;
    const keptOpenLine = lines[keptOpenIndex] ?? "";
    const reason =
      keptOpenLine.match(/^\s*KEPT_OPEN:([^\r\n]+)$/i)?.[1]?.trim() || null;
    const blockLines: string[] = [];
    for (const line of lines.slice(keptOpenIndex + 1)) {
      const trimmed = line.trim();
      if (!trimmed) break;
      if (
        /^[A-Z0-9_:-]+$/.test(trimmed) &&
        /(?:DONE|NOT_GREEN|BLOCKED)/.test(trimmed)
      ) {
        break;
      }
      blockLines.push(line);
    }
    const owner = this.extractLineValue(blockLines, "owner");
    const nextCheck =
      this.extractLineValue(blockLines, "next check") ??
      this.extractLineValue(blockLines, "next_check");
    return {
      present: true,
      reason,
      owner,
      next_check: nextCheck,
      complete: Boolean(reason && owner && nextCheck),
    };
  }

  private isPrLoopRequired(
    agent: AgentRecord,
    goalText: string | null,
    reportText: string | null,
  ): boolean {
    return [
      resolveBootPromptText(agent),
      agent.task_summary,
      goalText,
      reportText,
    ]
      .filter(Boolean)
      .join("\n")
      .split(/\r?\n/)
      .some((line) => this.isPrDeliverableEvidenceLine(line));
  }

  private isPrDeliverableEvidenceLine(line: string): boolean {
    const normalized = line.trim().toLowerCase();
    if (!normalized || this.isPrDeliverableExcludedLine(normalized)) {
      return false;
    }
    return [
      /\bpr_deliverable\s*:\s*(?:true|yes|required|1)\b/i,
      /\bpr deliverable\s*:\s*(?:true|yes|required)\b/i,
      /\brun\s+`?\/pr-loop`?\b/i,
      /\b(?:open|create)\s+(?:a\s+)?pr\b/i,
      /\bpush,?\s+(?:and\s+)?open\s+(?:a\s+)?pr\b/i,
      /\byour\s+pr\b/i,
    ].some((pattern) => pattern.test(line));
  }

  private isPrDeliverableExcludedLine(normalizedLine: string): boolean {
    return (
      /\breviewer\s+pairs?\s+before\s+pr[-_ ]?loop\b/.test(normalizedLine) ||
      /\bbefore\s+pr[-_ ]?loop\b/.test(normalizedLine) ||
      /\b(?:no|not|never|without|do\s+not|don't|does\s+not|doesn't)\b.{0,80}\b(?:pr[-_ ]?loop|\/pr-loop|pr\b)\b/.test(
        normalizedLine,
      ) ||
      /\b(?:pr[-_ ]?loop|\/pr-loop|pr\b)\b.{0,80}\b(?:not\s+required|not\s+needed|unnecessary|not\s+a\s+deliverable|phrase)\b/.test(
        normalizedLine,
      )
    );
  }

  private isPrLoopSatisfied(reportText: string): boolean {
    if (!reportText.trim()) return false;
    if (this.hasCompletedPrLoopHandoff(reportText)) return true;

    const hasPrReference =
      /github\.com\/\S+\/pull\/\d+/i.test(reportText) ||
      /\bPR\s*#?\d+\b/i.test(reportText) ||
      /\bPR\s+(?:url|status|state)\s*:/i.test(reportText);
    const reviewOrMergeComplete =
      /\b(?:merged|review(?:ed)?\s+(?:complete|passed|done)|review\/merge loop complete)\b/i.test(
        reportText,
      ) ||
      /\bPR\s+(?:status|state)\s*:\s*(?:merged|closed)\b/i.test(reportText);
    return hasPrReference && reviewOrMergeComplete;
  }

  private hasCompletedPrLoopHandoff(reportText: string): boolean {
    return reportText
      .split(/\r?\n/)
      .some((line) => this.isCompletedPrLoopHandoffLine(line));
  }

  private isCompletedPrLoopHandoffLine(line: string): boolean {
    const normalized = line.trim().toLowerCase();
    if (
      !/\b(?:handoff|handed off|successor transfer)\b/.test(normalized) ||
      /\b(?:no|not|never|without|none|pending|todo|missing|incomplete|not yet)\b/.test(
        normalized,
      )
    ) {
      return false;
    }
    return [
      /\b(?:explicitly\s+)?handed off\b/,
      /\bsuccessor transfer\s*:\s*(?:complete|completed|done|recorded|sent|posted|delivered)\b/,
      /\bhandoff\s*:\s*(?:complete|completed|done|recorded|sent|posted|delivered)\b/,
      /\bhandoff\b.*\b(?:complete|completed|done|recorded|sent|posted|delivered)\b/,
      /\bhandoff\b.*\bto\s+[-\w ]+\b/,
    ].some((pattern) => pattern.test(normalized));
  }

  private hasOutputDoneEvidence(cli: CliType, text: string): boolean {
    const parsed = parseScreen(text);
    return (
      parsed.status === "done" &&
      parsed.done_signal !== null &&
      !screenHasActiveAgentMarker(cli, text, parsed)
    );
  }

  private requiresOutputDoneEvidence(targetState: AgentState): boolean {
    return targetState === "done";
  }

  private hasRecordedOutputDoneEvidence(agent: AgentRecord): boolean {
    return !!agent.task_done_detected_at;
  }

  private hasCurrentRecordedOutputDoneEvidence(agent: AgentRecord): boolean {
    if (!agent.task_done_detected_at) return false;
    if (!agent.halt_last_active_at) return true;
    const doneAtMs = Date.parse(agent.task_done_detected_at);
    const lastActiveAtMs = Date.parse(agent.halt_last_active_at);
    return (
      Number.isFinite(doneAtMs) &&
      Number.isFinite(lastActiveAtMs) &&
      doneAtMs >= lastActiveAtMs
    );
  }

  private loadGroundTruthSession(
    agent: AgentRecord,
  ): HarnessSessionWithMeta | null {
    if (!harnessJsonlEnabled() || !JSONL_HARNESSES.has(agent.cli)) {
      return null;
    }
    const harness = agent.cli as Harness;
    if (agent.cli_session_path) {
      const state = readHarnessSessionFromFile(harness, agent.cli_session_path);
      const mtime_ms = safeMtimeMs(agent.cli_session_path);
      return state && mtime_ms > 0
        ? { state, path: agent.cli_session_path, mtime_ms }
        : null;
    }
    if (agent.state === "booting") return null;
    return agent.cli_session_id
      ? loadHarnessSessionWithMeta(harness, agent.cli_session_id)
      : null;
  }

  private transcriptHasSettledDone(agent: AgentRecord): boolean {
    const session = this.loadGroundTruthSession(agent);
    if (!session?.state.done) return false;
    return Date.now() - session.mtime_ms >= DONE_QUIESCENCE_MS;
  }

  private screenContradictsTranscriptDone(cli: CliType, text: string): boolean {
    const parsed = parseScreen(text);
    return screenHasActiveAgentMarker(cli, text, parsed);
  }

  private async hasGroundTruthDone(
    agent: AgentRecord,
    ctx?: SweepAgentContext,
  ): Promise<boolean> {
    if (!this.transcriptHasSettledDone(agent)) return false;
    try {
      const screen = ctx
        ? await this.readSweepScreen(agent, ctx)
        : await this.readAgentScreen(agent, {
            lines: BOOT_SESSION_CAPTURE_LINES,
          });
      return !this.screenContradictsTranscriptDone(agent.cli, screen.text);
    } catch {
      return false;
    }
  }

  private async hasCurrentOutputDoneEvidence(
    agent: AgentRecord,
  ): Promise<boolean> {
    try {
      const screen = await this.readAgentScreen(agent, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
      return this.hasOutputDoneEvidence(agent.cli, screen.text);
    } catch {
      return false;
    }
  }

  private async hasTargetStateEvidence(
    agent: AgentRecord,
    targetState: AgentState,
  ): Promise<boolean> {
    return (
      (await this.getTargetStateEvidenceSource(agent, targetState)) !== null
    );
  }

  /**
   * AIDEV-NOTE (F1b): `effectiveState` is the LIVE-resolved state when the
   * caller has one. `wait_for` passes it so a record the screen contradicts
   * can never be read as evidence the target state was reached; every other
   * caller keeps the record's own value and behaves exactly as before.
   */
  private async getTargetStateEvidenceSource(
    agent: AgentRecord,
    targetState: AgentState,
    effectiveState: AgentState = agent.state,
  ): Promise<TargetStateEvidenceSource | null> {
    const restingStateMatch =
      INTERACTIVE_AGENT_STATES.has(targetState) &&
      INTERACTIVE_AGENT_STATES.has(effectiveState);
    if (effectiveState !== targetState && !restingStateMatch) return null;
    if (!this.requiresOutputDoneEvidence(targetState)) return "state";
    if (await this.hasGroundTruthDone(agent)) return "transcript";
    return this.hasRecordedOutputDoneEvidence(agent) ||
      (await this.hasCurrentOutputDoneEvidence(agent))
      ? "screen"
      : null;
  }

  private async refreshTargetStateEvidence(
    agent: AgentRecord,
    targetState: AgentState,
    waitForReadyPatternMatches: Map<string, number>,
    effectiveState: AgentState = agent.state,
  ): Promise<{
    agent: AgentRecord;
    source?: RefreshedTargetStateEvidenceSource;
    observedActive?: boolean;
  }> {
    if (targetState === "ready" || targetState === "idle") {
      return this.refreshInteractiveTargetStateEvidence(
        agent,
        targetState,
        waitForReadyPatternMatches,
        effectiveState,
      );
    }
    if (!this.requiresOutputDoneEvidence(targetState)) return { agent };
    if (TERMINAL_STATES.has(agent.state)) return { agent };
    return { agent: (await this.maybeMarkTaskDone(agent, {})).agent };
  }

  /**
   * AIDEV-NOTE (F1b round 2, reviewer finding B): this gate decides whether to
   * READ the screen for ready-evidence, and it used to decide purely from the
   * raw record -- so on a `done`-poisoned agent it bailed, and once the wait
   * correctly stopped short-circuiting it could never MATCH either.
   *
   * It now opens when EITHER the record or the live state says the agent is in
   * the pre-target state, so a poisoned record alone no longer closes it. But
   * it also requires the record to be able to REACH the target, because the
   * transition below writes from the record: `VALID_TRANSITIONS.done` is empty,
   * so a `done` record cannot become `idle` no matter what the screen shows.
   * That guard is what keeps the widened gate from buying a screen read per
   * tick for a transition that would throw anyway.
   *
   * Consequence, stated plainly: for a `done`-poisoned agent the wait still
   * runs to timeout. It fails safe -- a timeout is not a false completion --
   * and the remaining half is #408 itself (stop poisoning the record) or a
   * deliberate repair path, both outside this lane.
   */
  private async refreshInteractiveTargetStateEvidence(
    agent: AgentRecord,
    targetState: "ready" | "idle",
    waitForReadyPatternMatches: Map<string, number>,
    effectiveState: AgentState = agent.state,
  ): Promise<{
    agent: AgentRecord;
    source?: RefreshedTargetStateEvidenceSource;
    observedActive?: boolean;
  }> {
    const inPreTargetState = (state: AgentState): boolean =>
      targetState === "ready" ? state === "booting" : state === "working";
    const canTransition =
      (inPreTargetState(agent.state) || inPreTargetState(effectiveState)) &&
      isValidTransition(agent.state, targetState);
    if (!canTransition || TERMINAL_STATES.has(effectiveState)) {
      waitForReadyPatternMatches.delete(agent.agent_id);
      return { agent };
    }
    try {
      const screen = await this.readAgentScreen(agent, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
      const evidence = this.readReadyEvidence(agent, screen.text);
      const parsed = parseScreen(screen.text);
      const activeForWait =
        (targetState === "idle" || agent.cli === "claude") &&
        !(agent.cli === "gemini" && this.geminiHasSettledReply(screen.text)) &&
        (parsed.status === "working" ||
          parsed.status === "thinking" ||
          parsed.status === "draft_pending" ||
          parsed.control_state === "busy");
      if (activeForWait) {
        // The direct read is newer than the forced probe's resting memo.
        this.freshLiveStates.delete(agent.agent_id);
        waitForReadyPatternMatches.delete(agent.agent_id);
        return { agent, observedActive: true };
      }
      const hasTargetEvidence =
        (evidence.ready && !activeForWait) ||
        (targetState === "ready" && evidence.activeCodex);
      const awaitingManagedBootPrompt =
        targetState === "ready" &&
        agent.boot_prompt_pending === true &&
        agent.prompt_delivered === false;
      if (
        !hasTargetEvidence ||
        awaitingManagedBootPrompt ||
        (targetState === "ready" &&
          !evidence.activeCodex &&
          this.screenShowsPendingBootPrompt(agent, screen.text))
      ) {
        waitForReadyPatternMatches.delete(agent.agent_id);
        return { agent };
      }

      const count = (waitForReadyPatternMatches.get(agent.agent_id) ?? 0) + 1;
      waitForReadyPatternMatches.set(agent.agent_id, count);
      // A resting-looking frame can appear briefly between active frames.
      // Keep the registry in its pre-target state until two polls agree.
      if (count < Math.max(2, evidence.consecutive)) {
        return { agent };
      }

      let transitionAgent =
        targetState === "ready"
          ? await this.maybeCaptureBootSessionId(agent, {
              screen: Promise.resolve(screen),
            })
          : agent;
      if (targetState === "ready") {
        const parsedModel = parseScreen(screen.text).model;
        transitionAgent = this.stateMgr.updateRecord(transitionAgent.agent_id, {
          parsed_model: parsedModel,
          model_mismatch: computeModelMismatch(
            transitionAgent.model,
            parsedModel,
          ),
          ...(transitionAgent.boot_prompt_pending &&
          transitionAgent.prompt_delivered !== false
            ? {
                boot_prompt_pending: false,
                prompt_delivered: true,
                submit_verified: true,
              }
            : {}),
        });
        this.registry.set(transitionAgent.agent_id, transitionAgent);
      }
      let updated = this.stateMgr.transition(
        transitionAgent.agent_id,
        targetState,
        {
          error:
            targetState === "ready" &&
            transitionAgent.error?.startsWith("Post-spawn liveness failed:")
              ? null
              : transitionAgent.error,
        },
      );
      if (
        targetState === "ready" &&
        updated.quality === "degraded" &&
        transitionAgent.error?.startsWith("Post-spawn liveness failed:")
      ) {
        updated = this.stateMgr.updateRecord(transitionAgent.agent_id, {
          quality: "unknown",
        });
      }
      this.registry.set(transitionAgent.agent_id, updated);
      if (targetState === "idle") {
        await this.reconcileRolePlacements("idle", {
          agentIds: new Set([updated.agent_id]),
        });
      }
      waitForReadyPatternMatches.delete(agent.agent_id);
      waitForReadyPatternMatches.delete(transitionAgent.agent_id);
      return { agent: updated, source: "screen" };
    } catch {
      return { agent };
    }
  }

  private async createAgentSurface(
    workspace?: string,
    context?: {
      role?: AgentRole;
      parentAgent?: AgentRecord | null;
      repo?: string;
      worktree?: boolean;
      focus?: boolean;
      placementTimeoutMs?: number;
    },
  ): Promise<CreatedAgentSurface> {
    const observerEpoch = this.captureSurfaceObserverEpoch();
    const observerId = this.registry.getObserverId();
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    // Pin a child worker to the parent orchestrator's ACTUAL workspace before
    // falling back to repo-name resolution. Without this a worker re-resolves
    // its workspace purely from the repo directory name, which fails for
    // worktree workers (cwd basename is "<repo>.wt/<name>", not "<repo>"): the
    // match returns undefined, listPanes() then runs against cmux's focused
    // workspace where the parent's pane is absent, and the split lands in the
    // wrong/new workspace instead of to the right of the parent. An explicit
    // `workspace` arg still wins ("unless the user asks for a different one").
    // Inherit only for a SAME-repo child so a cross-repo spawn still resolves
    // to its own repo's workspace.
    const parentWorkspace =
      context?.parentAgent &&
      context.parentAgent.repo &&
      context?.repo &&
      reposEquivalent(context.parentAgent.repo, context.repo)
        ? (context.parentAgent.workspace_id ?? undefined)
        : undefined;
    workspace = await this.resolveWorkspaceForRepo(
      workspace ?? parentWorkspace,
      context?.repo,
    );
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    if (workspace && context?.focus !== false) {
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
      try {
        await this.client.selectWorkspace(workspace);
      } catch {
        // Best-effort: the workspace may already be focused, or the client may
        // be an older test/fallback implementation.
      }
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    }

    const placementWorkspace = workspace
      ? normalizeWorkspaceRefAlias(workspace)
      : "<focused-workspace>";
    const placementBudgetMs = Math.min(
        context?.placementTimeoutMs ?? DEFAULT_SPAWN_PLACEMENT_TIMEOUT_MS,
        DEFAULT_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS,
      );
    const placementDeadline = Date.now() + placementBudgetMs;
    const unknownSplitSettleWindowMs = Math.max(
      UNKNOWN_SPLIT_RPC_TIMEOUT_MS, placementBudgetMs,
    );
    return this.withPlacementLock(placementWorkspace, placementDeadline, async (assertActive) => {
      const observedPriorSplit = await this.awaitPendingPlacementSplit(
        placementWorkspace,
        workspace,
        placementDeadline,
        observerEpoch,
        assertActive,
      );
      assertActive();
    try {
      const panes = await this.client.listPanes({ workspace });
      assertActive();
      const rawPaneSurfaces = await Promise.all(
        panes.panes.map(async (pane) => {
          const ps = await this.client.listPaneSurfaces({
            workspace,
            pane: pane.ref,
          });
          return ps.pane_ref ? ps : { ...ps, pane_ref: pane.ref };
        }),
      );
      assertActive();
      const paneSurfaces = partitionPaneSurfacesByMembership(
        panes.panes,
        rawPaneSurfaces,
        {
          workspace_ref: panes.workspace_ref ?? workspace,
          window_ref: panes.window_ref,
        },
      );
      if (!isPaneSurfaceEnumerationComplete(panes.panes, paneSurfaces)) {
        throw new PlacementSurfaceBindingError(
          "Incomplete pane surface enumeration during agent placement; refusing topology mutation.",
        );
      }
      const surfaceObservation = buildSurfaceBindingObservation(
        panes.panes,
        paneSurfaces,
      );
      if (surfaceObservation.coverage === "mixed") {
        throw new PlacementSurfaceBindingError(
          "Mixed surface identity evidence during agent placement; refusing topology mutation.",
        );
      }
      if (surfaceObservation.coverage === "conflict") {
        throw new PlacementSurfaceBindingError(
          "Contradictory surface identity evidence during agent placement; refusing topology mutation.",
        );
      }
      const parentAgent = context?.parentAgent ?? null;
      const liveSurfaceIds = surfaceObservation.liveSurfaceRefs;
      const knownAgentsById = new Map(
        this.stateMgr
          .listStates()
          .map((agent) => [agent.agent_id, agent] as const),
      );
      for (const agent of this.registry.list()) {
        knownAgentsById.set(agent.agent_id, agent);
      }
      const liveKnownAgents = [...knownAgentsById.values()].flatMap((agent) => {
        const surfaceRef = resolveObservedAgentSurfaceRef(
          agent,
          surfaceObservation,
        );
        const observedUuid = surfaceRef
          ? surfaceObservation.surfaceUuidByRef.get(surfaceRef)
          : null;
        return surfaceRef &&
          this.registry.canUseObservedBinding(agent, observedUuid)
          ? [{ ...agent, surface_id: surfaceRef }]
          : [];
      });
      const roleSurfaceIds = collectRoleSurfaceIds(liveKnownAgents);
      const extraRoleSurfaceIds =
        this.roleSurfaceIdsProvider?.(
          liveSurfaceIds,
          workspace,
          surfaceObservation,
        ) ?? null;
      if (extraRoleSurfaceIds) {
        for (const role of ["orchestrator", "worker"] as const) {
          for (const surfaceId of extraRoleSurfaceIds[role]) {
            if (liveSurfaceIds.has(surfaceId)) {
              roleSurfaceIds[role].add(surfaceId);
            }
          }
        }
      }
      const childWorkerSurfaceIds = new Set(
        parentAgent
          ? liveKnownAgents
              .filter((agent) => agent.parent_agent_id === parentAgent.agent_id)
              .filter((agent) => inferRecordRoleOrNull(agent) === "worker")
              .map((agent) => agent.surface_id)
          : [],
      );
      const parentRole = parentAgent
        ? inferRecordRoleOrNull(parentAgent)
        : null;
      const parentDefinitelyElsewhere = Boolean(
        parentAgent?.workspace_id &&
        workspace &&
        parentAgent.workspace_id !== workspace,
      );
      const parentSurfaceId =
        parentAgent && !parentDefinitelyElsewhere
          ? resolveObservedAgentSurfaceRef(parentAgent, surfaceObservation)
          : null;
      if (
        parentAgent?.surface_uuid &&
        !parentSurfaceId &&
        !parentDefinitelyElsewhere
      ) {
        throw new PlacementSurfaceBindingError(
          `Stable surface UUID ${parentAgent.surface_uuid} for parent ` +
            `"${parentAgent.agent_id}" is not uniquely bound in the current ` +
            `pane observation; refusing placement against cached ref ` +
            `${parentAgent.surface_id}.`,
        );
      }
      const placement = chooseAgentSpawnPlacement(
        panes.panes,
        paneSurfaces,
        roleSurfaceIds,
        {
          role: context?.role ?? "worker",
          parentRole,
          parentSurfaceId,
          childWorkerSurfaceIds,
          worktree: context?.worktree,
        },
      );
      if (observedPriorSplit && placement.kind === "split") {
        throw new PlacementSurfaceBindingError(
          `Worker column vanished while placing in ${placementWorkspace}; refusing another split.`,
        );
      }
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
      assertActive();
      // AIDEV-NOTE (#510): target the pane by its STABLE id, not its positional
      // ref. `placement.pane` is a `pane:N` ref chosen from the observation above,
      // and positional refs renumber when panes close -- so by the time
      // `new-surface` ran, `pane:N` could name a different pane or none at all
      // (#510: pane:103 vs actual pane:104; 2026-09-13: pane:49 in a workspace
      // whose only pane was pane:2). `cmux new-surface --pane` accepts `<id|ref>`,
      // and every CmuxPane already carries its UUID via `--id-format both`, so a
      // UUID target cannot drift. `new-split` was hardened against raw pane refs
      // in June via a surface anchor; this closes the other placement command.
      // Falls back to the ref only when a pane carries no id.
      const newSurfacePaneTarget =
        placement.kind === "surface"
          ? (panes.panes.find((pane) => pane.ref === placement.pane)?.id ??
            placement.pane)
          : undefined;
      const createdRightSplit =
        placement.kind === "split" &&
        placement.direction === "right" &&
        new Set(deriveRoleColumnIndex(panes.panes).values()).size === 1;
      if (createdRightSplit) {
        // A timed-out newSplit may still finish in cmux. Until its result is
        // observed, later spawns must not choose another split.
        this.pendingPlacementSplits.set(placementWorkspace, {
          pane: "<split in flight>",
          surface: "",
        });
        this.placementSplitInFlight.add(placementWorkspace);
      }
      let splitCommandStarted = false;
      let splitCommandStartedAt = 0;
      let splitCommandReturned = false;
      let splitDefiniteNoMutation = false;
      let splitCompleted = false;
      let createdSurface: CreatedAgentSurface | null = null;
      let surface: AgentSurfacePlacement | undefined;
      try {
        assertActive();
        if (placement.kind === "surface") {
          surface = await this.client.newSurface({
            focus: context?.focus,
            pane: newSurfacePaneTarget ?? placement.pane,
            type: "terminal",
            workspace,
          });
        } else {
          splitCommandStarted = true;
          splitCommandStartedAt = Date.now();
          surface = await this.client.newSplit(placement.direction, {
            ...(placement.pane ? { pane: placement.pane } : {}),
            workspace,
            type: "terminal",
            focus: context?.focus,
          });
          splitCommandReturned = true;
        }
        if (!surface) {
          throw new PlacementSurfaceBindingError(
            "cmux returned no surface for agent placement; refusing an unbound spawn.",
          );
        }
        // Transfer the created handle to the caller before any post-mutation
        // epoch assertion can throw. The caller owns cleanup until it durably
        // binds this exact surface into agent state.
        createdSurface = {
          ...this.withWorkspacePlacementObservation(surface, workspace),
          observerEpoch,
          observerId,
        };
        if (createdRightSplit) {
          const prior = this.pendingPlacementSplits.get(placementWorkspace);
          this.pendingPlacementSplits.set(placementWorkspace, {
            pane: createdSurface.pane,
            surface: createdSurface.surface,
            surfaceId: createdSurface.surface_id,
            uncertain: prior?.uncertain,
          });
        }
        // The lock's deadline can win while cmux is still creating a surface.
        // Its late result belongs to this operation, but must never be returned
        // or left open after the caller has received placement_timeout.
        assertActive();
        if (
          createdSurface.actual_workspace &&
          normalizeWorkspaceRefAlias(createdSurface.actual_workspace) !==
            normalizeWorkspaceRefAlias(createdSurface.workspace)
        ) {
          throw new PlacementSurfaceBindingError(
            `Spawn placement blocked: requested ${createdSurface.workspace} ` +
              `but cmux returned ${createdSurface.actual_workspace} for surface ` +
              `${createdSurface.surface}`,
          );
        }
        if (createdRightSplit) {
          await this.awaitPendingPlacementSplit(
            placementWorkspace,
            workspace,
            placementDeadline,
            observerEpoch,
            assertActive,
          );
        }
        assertActive();
        splitCompleted = true;
        return createdSurface;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
        // A typed, pre-mutation rejection proves no split was created. All
        // marker changes happen in the single right-split finally below.
        splitDefiniteNoMutation = Boolean(
          createdRightSplit &&
          (!splitCommandStarted ||
            (!splitCommandReturned && (code === "not_found" || code === "invalid_argument")))
        );
        if (!createdRightSplit && createdSurface) {
          await this.cleanupUnboundCreatedSurface(createdSurface, "agent-placement");
        }
        const paneGone =
          placement.kind === "surface" &&
          (code === "not_found" || /\bnot_found\b/.test(message)) &&
          /pane/i.test(message);
        if (paneGone) {
          // A UUID target cannot drift to another pane. Do not silently
          // re-place or substitute an untracked native worker (#510, #519).
          throw new PlacementSurfaceBindingError(
            `Target pane ${placement.pane}${
              newSurfacePaneTarget && newSurfacePaneTarget !== placement.pane
                ? ` (id ${newSurfacePaneTarget})`
                : ""
            } no longer exists; NO agent surface was created. ` +
              "The pane closed between observation and placement. Retry " +
              "spawn_agent (it re-observes from scratch); do not substitute an " +
              `untracked native worker. cmux said: ${message}`,
          );
        }
        throw error;
      } finally {
        if (createdRightSplit) {
          await this.settleRightSplitExit(placementWorkspace, {
            requestedWorkspace: workspace,
            observerEpoch,
            observerId,
            commandStarted: splitCommandStarted,
            commandStartedAt: splitCommandStartedAt,
            settleWindowMs: unknownSplitSettleWindowMs,
            definiteNoMutation: splitDefiniteNoMutation,
            completed: splitCompleted,
            createdSurface,
            rawSurface: surface,
          });
        }
      }
    } catch (error) {
      if (
        isAgentRoleInferenceError(error) ||
        error instanceof PlacementSurfaceBindingError ||
        Boolean(context?.parentAgent?.surface_uuid) ||
        canonicalRoleColumn(context?.role ?? "worker") !== null
      ) {
        throw error;
      }
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
      assertActive();
      const surface = await this.client.newSplit("right", {
        workspace,
        type: "terminal",
      });
      return {
        ...this.withWorkspacePlacementObservation(surface, workspace),
        observerEpoch,
        observerId,
      };
    }
    });
  }

  private async withPlacementLock<T>(
    workspace: string,
    deadline: number,
    operation: (assertActive: () => void) => Promise<T>,
  ): Promise<T> {
    const previous = this.placementTails.get(workspace) ?? Promise.resolve();
    let release!: () => void;
    const own = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => own);
    this.placementTails.set(workspace, tail);
    const releaseAbandoned = () => {
      release();
      if (this.placementTails.get(workspace) === tail) {
        this.placementTails.delete(workspace);
      }
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      void previous.then(releaseAbandoned, releaseAbandoned);
      throw new PlacementTimeoutError(
        `Spawn placement timed out waiting for workspace ${workspace}; refusing topology mutation.`,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        previous,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new PlacementTimeoutError(
            `Spawn placement timed out waiting for workspace ${workspace}; refusing topology mutation.`,
          )), remaining);
        }),
      ]);
    } catch (error) {
      void previous.then(releaseAbandoned, releaseAbandoned);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    let expired = false;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () => new PlacementTimeoutError(
      `Spawn placement timed out waiting for workspace ${workspace} split/topology; refusing topology mutation.`,
    );
    const assertActive = () => {
      if (expired || Date.now() >= deadline) throw timeoutError();
    };
    try {
      assertActive();
      return await Promise.race([
        operation(assertActive),
        new Promise<never>((_resolve, reject) => {
          operationTimer = setTimeout(() => {
            expired = true;
            if (this.placementSplitInFlight.has(workspace)) {
              const pending = this.pendingPlacementSplits.get(workspace);
              if (pending) this.pendingPlacementSplits.set(workspace, {
                ...pending,
                uncertain: true,
              });
            }
            reject(timeoutError());
          }, Math.max(1, deadline - Date.now()));
        }),
      ]);
    } finally {
      if (operationTimer) clearTimeout(operationTimer);
      release();
      if (this.placementTails.get(workspace) === tail) {
        this.placementTails.delete(workspace);
      }
    }
  }

  private async awaitPendingPlacementSplit(
    key: string,
    workspace: string | undefined,
    deadline: number,
    observerEpoch: SurfaceObserverEpoch,
    assertActive: () => void,
  ): Promise<boolean> {
    const pending = this.pendingPlacementSplits.get(key);
    if (!pending) return false;
    if (pending.unknownStartedAt !== undefined && pending.settleWindowMs !== undefined) {
      // A rejected creation RPC has no returned handle to prove settlement.
      // Observe first: adopt a late landing, or hold the guard until the
      // command's upper-bound window expires before allowing another split.
      const rightColumnExists = await this.observePlacementColumnState(
        key, workspace, observerEpoch, assertActive,
      );
      if (rightColumnExists) {
        this.placementSplitInFlight.delete(key);
        this.pendingPlacementSplits.delete(key);
        return true;
      }
      const remainingMs = Math.max(0,
        pending.unknownStartedAt + pending.settleWindowMs - Date.now(),
      );
      if (remainingMs > 0) {
        throw new PlacementPendingError(
          `Spawn placement has an unknown split outcome in ${key}; retry in ${remainingMs}ms.`,
          remainingMs,
        );
      }
      this.placementSplitInFlight.delete(key);
      this.pendingPlacementSplits.delete(key);
      return false;
    }
    if (pending.uncertain) {
      if (this.placementSplitInFlight.has(key)) {
        throw new PlacementTimeoutError(
          `Spawn placement timed out with a split still in flight in ${key}; refusing topology mutation.`,
        );
      }
      // A settled but ambiguous outcome is recoverable. Read the entire pane
      // membership again under this workspace's placement lock; one failed
      // read blocks only this attempt, never every future spawn.
      const rightColumnExists = await this.observePlacementColumnState(
        key, workspace, observerEpoch, assertActive,
      );
      this.pendingPlacementSplits.delete(key);
      return rightColumnExists;
    }
    while (Date.now() < deadline) {
      assertActive();
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
      const panes = await this.client.listPanes({ workspace });
      assertActive();
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
      const columns = deriveRoleColumnIndex(panes.panes);
      // The first surface may close before the next spawn, leaving an empty
      // right pane. The split is observed once the column itself exists.
      if ([...columns.values()].includes(1)) {
        this.pendingPlacementSplits.delete(key);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(
        SPAWN_PLACEMENT_OBSERVE_INTERVAL_MS,
        Math.max(1, deadline - Date.now()),
      )));
    }
    throw new PlacementTimeoutError(
      `Spawn placement timed out waiting for split ${pending.pane} in ${key} to appear; refusing another split.`,
    );
  }

  private async observePlacementColumnState(
    key: string,
    workspace: string | undefined,
    observerEpoch: SurfaceObserverEpoch,
    assertActive: () => void,
  ): Promise<boolean> {
    try {
      assertActive();
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement recovery");
      const panes = await this.client.listPanes({ workspace });
      assertActive();
      if (!Array.isArray(panes.panes) || panes.panes.length === 0) {
        throw new Error("no pane topology");
      }
      if (
        workspace && panes.workspace_ref &&
        normalizeWorkspaceRefAlias(panes.workspace_ref) !== normalizeWorkspaceRefAlias(workspace)
      ) {
        throw new Error("workspace topology changed");
      }
      const groups = await Promise.all(panes.panes.map(async (pane) => {
        const group = await this.client.listPaneSurfaces({ workspace, pane: pane.ref });
        return group.pane_ref ? group : { ...group, pane_ref: pane.ref };
      }));
      assertActive();
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement recovery");
      const partitioned = partitionPaneSurfacesByMembership(panes.panes, groups, {
        workspace_ref: panes.workspace_ref ?? workspace,
        window_ref: panes.window_ref,
      });
      if (!isPaneSurfaceEnumerationComplete(panes.panes, partitioned)) {
        throw new Error("incomplete pane topology");
      }
      const observation = buildSurfaceBindingObservation(panes.panes, partitioned);
      if (observation.coverage === "mixed" || observation.coverage === "conflict") {
        throw new Error("ambiguous surface identity");
      }
      const columns = new Set(deriveRoleColumnIndex(panes.panes).values());
      if (columns.size > 2 || !columns.has(0)) {
        throw new Error("invalid role columns");
      }
      return columns.has(1);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new PlacementTimeoutError(
        `Spawn placement could not confirm split topology in ${key}: ${reason}; retry after a fresh observation.`,
      );
    }
  }

  private async settleRightSplitExit(
    key: string,
    exit: {
      requestedWorkspace?: string;
      observerEpoch: SurfaceObserverEpoch;
      observerId: string | null;
      commandStarted: boolean;
      commandStartedAt: number;
      settleWindowMs: number;
      definiteNoMutation: boolean;
      completed: boolean;
      createdSurface: CreatedAgentSurface | null;
      rawSurface?: AgentSurfacePlacement;
    },
  ): Promise<void> {
    if (exit.completed) {
      this.placementSplitInFlight.delete(key);
      return;
    }
    if (exit.definiteNoMutation || !exit.commandStarted) {
      this.placementSplitInFlight.delete(key);
      if (this.pendingPlacementSplits.get(key)?.surface === "") {
        this.pendingPlacementSplits.delete(key);
      }
      return;
    }
    if (!exit.createdSurface && !exit.rawSurface) {
      // The command rejected without a handle. Keep its guard until the
      // bounded settle window ends, since cmux may still land the split.
      const pending = this.pendingPlacementSplits.get(key);
      if (pending?.surface === "") {
        this.pendingPlacementSplits.set(key, { ...pending, uncertain: true,
          unknownStartedAt: exit.commandStartedAt,
          settleWindowMs: exit.settleWindowMs });
      }
      return;
    }
    const raw = exit.rawSurface!;
    const unbound = exit.createdSurface ?? {
      ...raw,
      ...(exit.requestedWorkspace && raw.workspace !== exit.requestedWorkspace
        ? { workspace: exit.requestedWorkspace, actual_workspace: raw.workspace }
        : {}),
      observerEpoch: exit.observerEpoch,
      observerId: exit.observerId,
    };
    const pending = this.pendingPlacementSplits.get(key);
    if (pending?.surface === "") {
      this.pendingPlacementSplits.set(key, {
        pane: unbound.pane,
        surface: unbound.surface,
        surfaceId: unbound.surface_id,
        uncertain: pending.uncertain,
      });
    }
    let closed = false;
    try {
      closed = await this.cleanupUnboundCreatedSurface(unbound, "agent-placement");
    } finally {
      await this.settleLatePlacementSplit(key, unbound, closed);
    }
  }

  private async settleLatePlacementSplit(
    key: string,
    surface: CreatedAgentSurface,
    closeSucceeded: boolean,
  ): Promise<void> {
    const pending = this.pendingPlacementSplits.get(key);
    if (!pending) {
      this.placementSplitInFlight.delete(key);
      return;
    }
    if (
      pending.surface !== surface.surface ||
      (pending.surfaceId && pending.surfaceId !== surface.surface_id)
    ) return;
    // The newSplit command has resolved. Drop the actual in-flight guard even
    // when close or confirmation fails, so a later spawn can re-observe.
    this.placementSplitInFlight.delete(key);
    const uncertain = { ...pending, uncertain: true };
    this.pendingPlacementSplits.set(key, uncertain);
    if (!closeSucceeded || !surface.surface_id) return;
    const workspace = surface.actual_workspace ?? surface.workspace;
    let topology: SurfaceTopologySnapshot | null;
    try {
      topology = await collectSurfaceTopology(
        this.client,
        workspace,
        this.surfaceObserverEpochProvider(),
        this.surfaceObserverIdProvider(),
      );
    } catch {
      return;
    }
    if (
      topology?.complete !== true ||
      topology.surfaceIdByRef.size !== topology.workspaceBySurface.size ||
      !this.isSurfaceObserverEpochCurrent(surface.observerEpoch)
    ) return;
    const targetId = surface.surface_id.toLowerCase();
    if ([...topology.surfaceRefById.keys()].some((id) => id.toLowerCase() === targetId)) return;
    if (this.pendingPlacementSplits.get(key) === uncertain) {
      this.pendingPlacementSplits.delete(key);
    }
  }

  private withWorkspacePlacementObservation(
    surface: AgentSurfacePlacement,
    requestedWorkspace: string | undefined,
  ): AgentSurfacePlacement & {
    actual_workspace?: string;
  } {
    if (!requestedWorkspace || !surface.workspace) {
      return surface;
    }
    if (surface.workspace === requestedWorkspace) {
      return surface;
    }
    return {
      ...surface,
      workspace: requestedWorkspace,
      actual_workspace: surface.workspace,
    };
  }

  private async resolveWorkspaceForRepo(
    workspace: string | undefined,
    repo: string | undefined,
  ): Promise<string | undefined> {
    if (workspace || !repo) return workspace;

    return resolveWorkspaceRefForRepo(repo, () => this.listAllWorkspaces());
  }

  private async sendLaunchCommand(
    surface: string,
    workspace: string | undefined,
    command: string,
    agentId: string,
    observerEpoch: SurfaceObserverEpoch,
    timeoutMs?: number,
    bypassLaunchSender = false,
  ): Promise<void> {
    command = withRaisedNofileSoftLimit(command);
    const expectedRoute = this.resolveAgentRoute(agentId);
    if (surface !== expectedRoute.surface_id) {
      throw new Error(
        `Agent launch target ${surface} does not match registry surface ` +
          `${expectedRoute.surface_id} for "${agentId}"; refusing terminal mutation.`,
      );
    }
    const assertSurfaceBindingCurrent = async (): Promise<void> => {
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent launch");
      const current = this.registry.get(agentId);
      if (!current) {
        throw new Error(
          `Agent "${agentId}" disappeared during agent launch; refusing terminal mutation.`,
        );
      }
      const currentRoute =
        current.surface_uuid && this.registry.isObserverOwnershipEnforced()
          ? await this.resolveAgentIoRoute(agentId)
          : this.resolveAgentRoute(agentId);
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent launch");
      if (!this.sameSurfaceRoute(expectedRoute, currentRoute)) {
        throw new Error(
          `Surface route changed during agent launch for "${agentId}" ` +
            `(${expectedRoute.surface_id} -> ${currentRoute.surface_id}); ` +
            `refusing terminal mutation.`,
        );
      }
    };
    if (this.launchCommandSender && !bypassLaunchSender) {
      await this.launchCommandSender({
        surface,
        ...this.stableSurfaceWriteOptions(expectedRoute.surface_uuid),
        workspace,
        command,
        timeout_ms: timeoutMs,
        assertSurfaceBindingCurrent,
      });
      return;
    }

    await assertSurfaceBindingCurrent();
    await this.client.send(surface, command, {
      workspace,
      ...this.stableSurfaceWriteOptions(expectedRoute.surface_uuid),
    });
    await assertSurfaceBindingCurrent();
    await this.client.sendKey(surface, "return", {
      workspace,
      ...this.stableSurfaceWriteOptions(expectedRoute.surface_uuid),
    });
  }

  private isBootCaptureWindowOpen(agent: AgentRecord): boolean {
    return agent.state === "booting";
  }

  private canUseSelfRegistrationSessionResolver(agent: AgentRecord): boolean {
    return this.canUseSelfRegistrationProcessEvidence(agent);
  }

  /**
   * A Codex rollout remains authoritative for session identity. Once that
   * identity is durable, an exact-session self-registration match may supply
   * only the process evidence used by lifecycle guards.
   */
  private canUseSelfRegistrationProcessEvidence(agent: AgentRecord): boolean {
    return Boolean(
      this.selfRegistrationSessionResolver &&
      TRANSCRIPT_SESSION_CAPTURE_STATES.has(agent.state) &&
      JSONL_HARNESSES.has(agent.cli) &&
      agent.surface_uuid?.trim(),
    );
  }

  private canUseTranscriptSessionResolver(agent: AgentRecord): boolean {
    if (!TRANSCRIPT_SESSION_CAPTURE_STATES.has(agent.state)) return false;
    return this.hasTranscriptSessionResolverContext(agent);
  }

  private hasTranscriptSessionResolverContext(agent: AgentRecord): boolean {
    if (!JSONL_HARNESSES.has(agent.cli)) return false;
    const hasManagedLaunchContext = Boolean(
      agent.launcher_name ||
      agent.launch_cwd?.trim() ||
      agent.worktree_path?.trim(),
    );
    if (resolveBootPromptText(agent).length === 0 && !hasManagedLaunchContext) {
      return false;
    }
    return this.hasCustomSessionIdentityResolver || hasManagedLaunchContext;
  }

  private screenShowsPendingBootPrompt(
    agent: AgentRecord,
    screenText: string,
  ): boolean {
    if (!agent.boot_prompt_pending) {
      return false;
    }
    const prompt = resolveBootPromptText(agent);
    if (!prompt) {
      return !this.isBootPromptPendingStale(agent);
    }
    const promptLines = prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const promptTailSource = promptLines.at(-1) ?? prompt;
    const tail = promptTailSource.slice(-Math.min(80, promptTailSource.length));
    return this.screenInputRegionContainsPromptTail(
      agent.cli,
      screenText,
      tail,
    );
  }

  private screenInputRegionContainsPromptTail(
    cli: CliType,
    screenText: string,
    tail: string,
  ): boolean {
    if (!tail) return false;

    const lines = screenText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return false;

    const start = this.currentScreenRegionStart(cli, lines);

    const region = lines.slice(start);
    const compactTail = tail.replace(/\s+/g, "");

    return region.some((line, index) => {
      if (!this.lineCanSeedInputPromptScan(cli, line)) return false;
      const candidate = region.slice(index).join("\n");
      return (
        candidate.includes(tail) ||
        (compactTail.length > 0 &&
          candidate.replace(/\s+/g, "").includes(compactTail))
      );
    });
  }

  private currentScreenRegionStart(cli: CliType, lines: string[]): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (this.lineIsCurrentScreenRegionAnchor(cli, lines[index] ?? "")) {
        return index + 1;
      }
    }
    return 0;
  }

  private lineIsCurrentScreenRegionAnchor(cli: CliType, line: string): boolean {
    const trimmed = line.trim();
    switch (cli) {
      case "claude":
        return /Claude Code|CLAUDE_COUNTER|bypass permissions on|What can I help you with\?/i.test(
          trimmed,
        );
      case "codex":
        return (
          /\bOpenAI\s+Codex\b/i.test(trimmed) ||
          /\bModel:\s*gpt-/i.test(trimmed)
        );
      case "cursor":
        return /^Cursor Agent$/i.test(trimmed) || /^cursor>\s*$/i.test(trimmed);
      case "gemini":
        return (
          /^Gemini CLI$/i.test(trimmed) ||
          /^gemini>\s*$/i.test(trimmed) ||
          ANTIGRAVITY_BANNER_RE.test(trimmed)
        );
      case "kiro":
        return /^Kiro\b/i.test(trimmed) || /^kiro>\s*$/i.test(trimmed);
    }
  }

  private lineCanSeedInputPromptScan(cli: CliType, line: string): boolean {
    if (lineStartsWithCliInputPrompt(cli, line)) return true;
    const trimmed = line.trim();
    return (CLI_INPUT_PROMPT_PREFIXES[cli] ?? []).some(
      (prefix) => trimmed === prefix,
    );
  }

  private isBootPromptPendingStale(agent: AgentRecord): boolean {
    const since = Date.parse(agent.updated_at);
    if (Number.isNaN(since)) return false;
    return Date.now() - since >= BOOT_PROMPT_PENDING_STALE_MS;
  }

  private readReadyEvidence(
    agent: AgentRecord,
    screenText: string,
  ): {
    ready: boolean;
    activeCodex: boolean;
    consecutive: number;
  } {
    const parsed = parseScreen(screenText);
    const match = matchReadyPattern(agent.cli, screenText);
    const hasIdentity = screenHasReadyAgentIdentity(
      agent.cli,
      screenText,
      parsed,
    );
    const canBeInteractive = parsed.control_state !== "shell";
    const activeCodex =
      agent.cli === "codex" &&
      canBeInteractive &&
      hasIdentity &&
      screenHasActiveAgentMarker(agent.cli, screenText, parsed);
    return {
      ready: canBeInteractive && hasIdentity && match.matched,
      activeCodex,
      consecutive: match.consecutive,
    };
  }

  private harnessCwdForAgent(agent: AgentRecord): string {
    const launchCwd = agent.launch_cwd?.trim();
    if (launchCwd) return launchCwd;
    const worktreePath = agent.worktree_path?.trim();
    if (worktreePath) return worktreePath;
    // AIDEV-NOTE (E0 sweep): a guess for transcript probing only -- it never
    // aims a resume command (see resumeInvocationForAgent). It follows
    // CMUXLAYER_REPO_HOME before the historical ~/Gits default so a fresh
    // install probes the right tree.
    return defaultRepoCheckoutPath(agent.repo);
  }

  /**
   * Default session-identity resolution is harness-specific. The registration
   * row is keyed by the exact stable surface UUID and launch timestamp, so it is
   * authoritative for Codex as well as Claude/Cursor; transcript scanning is a
   * fallback only when that direct registration is absent.
   */
  private resolveSessionIdentityWithSelfRegistration(
    agent: AgentRecord,
    fallbackResolver?: SessionIdentityResolver,
  ): CapturedSessionIdentity | string | null {
    if (this.canUseSelfRegistrationSessionResolver(agent)) {
      const selfRegistered = this.selfRegistrationSessionResolver?.(agent);
      if (selfRegistered) {
        return this.normalizeCapturedSessionIdentity(selfRegistered);
      }
    }
    if (fallbackResolver) return fallbackResolver(agent);
    if (
      !this.canUseTranscriptSessionResolver(agent) &&
      agent.transcript_session_capture_deferred !== true
    ) {
      return null;
    }
    return this.findTranscriptSessionIdentity(agent);
  }

  /**
   * @deprecated Last-resort fallback only. Scans `~/.claude`/`~/.codex`
   * transcript dirs and infers identity by cwd+recency — fragile with raw
   * spawns, worktrees, and many-agents-per-repo. Prefer the self-registration
   * READ side (`makeSelfRegistrationSessionResolver`), which
   * `resolveSessionIdentityWithSelfRegistration` tries first.
   */
  private findTranscriptSessionIdentity(
    agent: AgentRecord,
  ): CapturedSessionIdentity | null {
    if (!JSONL_HARNESSES.has(agent.cli)) {
      return null;
    }

    const createdAt = Date.parse(agent.created_at);
    const sinceMs = Number.isNaN(createdAt) ? undefined : createdAt - 5_000;
    const identity = findLatestHarnessSessionIdentity(
      agent.cli as Harness,
      this.harnessCwdForAgent(agent),
      {
        sinceMs,
        expectedText: resolveBootPromptText(agent),
        ...(process.env.CMUXLAYER_HARNESS_HOME
          ? { home: process.env.CMUXLAYER_HARNESS_HOME }
          : {}),
        ...(process.env.CODEX_HOME
          ? { codexHome: process.env.CODEX_HOME }
          : {}),
      },
    );
    return identity
      ? { session_id: identity.session_id, path: identity.path }
      : null;
  }

  private normalizeCapturedSessionIdentity(
    identity: CapturedSessionIdentity | string,
  ): CapturedSessionIdentity {
    if (typeof identity === "string") {
      return { session_id: identity, path: null };
    }
    return {
      session_id: identity.session_id,
      path: identity.path ?? null,
      ...(identity.pid && identity.pid > 0 && identity.pid_registered_at
        ? {
            pid: identity.pid,
            pid_registered_at: identity.pid_registered_at,
          }
        : {}),
    };
  }

  private rekeyAgentMapEntry<T>(
    map: Map<string, T>,
    previousAgentId: string,
    nextAgentId: string,
  ): void {
    if (!map.has(previousAgentId)) return;
    const value = map.get(previousAgentId);
    map.delete(previousAgentId);
    if (value !== undefined && !map.has(nextAgentId)) {
      map.set(nextAgentId, value);
    }
  }

  private rekeyAgentEventSet(
    events: Set<string>,
    previousAgentId: string,
    nextAgentId: string,
  ): void {
    const previousPrefix = `${previousAgentId}:`;
    const renamedKeys = [...events].filter((key) =>
      key.startsWith(previousPrefix),
    );
    for (const key of renamedKeys) {
      events.delete(key);
      events.add(`${nextAgentId}:${key.slice(previousPrefix.length)}`);
    }
  }

  private transferAgentRenameMemory(
    previousAgentId: string,
    nextAgentId: string,
  ): void {
    if (previousAgentId === nextAgentId) return;

    const previousSidebarSnapshot = this.sidebarSnapshot.get(previousAgentId);
    if (previousSidebarSnapshot && !this.sidebarSnapshot.has(nextAgentId)) {
      this.sidebarSnapshot.set(nextAgentId, {
        ...previousSidebarSnapshot,
        statusValue: "__renamed__",
      });
    }
    this.rekeyAgentMapEntry(
      this.currentSweepScreenSignatures,
      previousAgentId,
      nextAgentId,
    );
    this.rekeyAgentMapEntry(
      this.readyPatternMatches,
      previousAgentId,
      nextAgentId,
    );
    this.rekeyAgentMapEntry(
      this.cliExitShellMatches,
      previousAgentId,
      nextAgentId,
    );
    this.rekeyAgentMapEntry(
      this.promptResolutionFailures,
      previousAgentId,
      nextAgentId,
    );
    this.rekeyAgentMapEntry(
      this.promptMotionObservedAtMs,
      previousAgentId,
      nextAgentId,
    );
    this.rekeyAgentMapEntry(
      this.promptMotionScreenSignatures,
      previousAgentId,
      nextAgentId,
    );
    this.rekeyAgentEventSet(this.loggedEvents, previousAgentId, nextAgentId);
    this.rekeyAgentEventSet(this.notifiedEvents, previousAgentId, nextAgentId);
    if (this.deliveredLeadMonitorDeathAlerts.delete(previousAgentId)) {
      this.deliveredLeadMonitorDeathAlerts.add(nextAgentId);
    }
    if (this.monitorRegistryPath) {
      void transferMonitorRegistryOwner(previousAgentId, nextAgentId, {
        registryPath: this.monitorRegistryPath,
        now: this.monitorRegistryNow,
      }).catch(() => {});
    }
  }

  private finalizeCapturedSession(
    agent: AgentRecord,
    capturedIdentity: CapturedSessionIdentity | string,
  ): AgentRecord {
    const identity = this.normalizeCapturedSessionIdentity(capturedIdentity);
    const hasCapturedProcessEvidence = Boolean(
      agent.surface_provenance === "cmuxlayer_spawn" &&
      identity.pid &&
      identity.pid_registered_at,
    );
    const capturedProcessEvidence = hasCapturedProcessEvidence
      ? {
          pid: identity.pid!,
          pid_registered_at: identity.pid_registered_at!,
        }
      : {};
    let updated = this.stateMgr.updateRecord(agent.agent_id, {
      cli_session_id: identity.session_id,
      cli_session_path: identity.path ?? agent.cli_session_path ?? null,
      ...capturedProcessEvidence,
      transcript_session_capture_deferred: false,
      transcript_session_capture_attempts: 0,
    });
    this.registry.set(agent.agent_id, updated);

    const finalAgentId = generateAgentId(
      agent.cli,
      agent.repo,
      identity.session_id,
    );
    if (!updated.agent_id.includes("-pending-")) {
      return updated;
    }
    if (updated.agent_id === finalAgentId) {
      return updated;
    }
    const existingFinal = this.stateMgr.readState(finalAgentId);
    if (existingFinal) {
      if (
        existingFinal.cli_session_id &&
        existingFinal.cli_session_id !== identity.session_id
      ) {
        const previousAgentId = updated.agent_id;
        const collisionBaseAgentId = `${finalAgentId}-${sessionCollisionSuffix(
          identity.session_id,
        )}`;
        let collisionAgentId = collisionBaseAgentId;
        let collisionAttempt = 2;
        while (this.stateMgr.readState(collisionAgentId)) {
          collisionAgentId = `${collisionBaseAgentId}-${collisionAttempt}`;
          collisionAttempt += 1;
        }
        updated = this.stateMgr.renameState(previousAgentId, collisionAgentId);
        this.registry.rename(previousAgentId, collisionAgentId, updated);
        this.transferAgentRenameMemory(previousAgentId, collisionAgentId);
        removePendingChannelMarkerAfterRegistration(
          previousAgentId,
          collisionAgentId,
          this.inboxOpts,
        );
        return updated;
      }
      const sessionPath =
        identity.path ?? existingFinal.cli_session_path ?? null;
      const processEvidenceMatches =
        !hasCapturedProcessEvidence ||
        (existingFinal.pid === identity.pid &&
          existingFinal.pid_registered_at === identity.pid_registered_at);
      const routeMatches =
        existingFinal.surface_id === updated.surface_id &&
        (existingFinal.surface_uuid ?? null) === (updated.surface_uuid ?? null) &&
        (existingFinal.surface_observer_id ?? null) ===
          (updated.surface_observer_id ?? null) &&
        (existingFinal.workspace_id ?? null) === (updated.workspace_id ?? null);
      const canonicalFinal =
        existingFinal.cli_session_id === identity.session_id &&
        existingFinal.cli_session_path === sessionPath &&
        processEvidenceMatches &&
        routeMatches &&
        existingFinal.transcript_session_capture_deferred !== true &&
        (existingFinal.transcript_session_capture_attempts ?? 0) === 0
          ? existingFinal
          : this.stateMgr.updateRecord(finalAgentId, {
              cli_session_id: identity.session_id,
              cli_session_path: sessionPath,
              ...capturedProcessEvidence,
              surface_id: updated.surface_id,
              surface_uuid: updated.surface_uuid ?? null,
              surface_observer_id: updated.surface_observer_id,
              surface_provenance: updated.surface_provenance,
              workspace_id: updated.workspace_id,
              transcript_session_capture_deferred: false,
              transcript_session_capture_attempts: 0,
            });
      const index = this.stateMgr.getSurfaceSessionIndex();
      index.removeAgent(updated.agent_id);
      index.persistRecord(canonicalFinal);
      this.registry.rename(updated.agent_id, finalAgentId, canonicalFinal);
      this.transferAgentRenameMemory(updated.agent_id, finalAgentId);
      this.removeStateForSweep({}, updated.agent_id);
      removePendingChannelMarkerAfterRegistration(
        updated.agent_id,
        finalAgentId,
        this.inboxOpts,
      );
      return canonicalFinal;
    }

    const previousAgentId = updated.agent_id;
    updated = this.stateMgr.renameState(previousAgentId, finalAgentId);
    this.registry.rename(previousAgentId, finalAgentId, updated);
    this.transferAgentRenameMemory(previousAgentId, finalAgentId);
    removePendingChannelMarkerAfterRegistration(
      previousAgentId,
      finalAgentId,
      this.inboxOpts,
    );
    return updated;
  }

  async readAgentScreen(
    agent: Pick<AgentRecord, "agent_id">,
    opts: { lines?: number; scrollback?: boolean } = {},
  ): Promise<CmuxReadScreenResult> {
    const route = await this.resolveAgentIoRoute(agent.agent_id);
    const readTarget =
      this.client.supportsStableSurfaceReads && route.surface_uuid
        ? route.surface_uuid
        : route.surface_id;
    return this.client.readScreen(readTarget, {
      ...opts,
      workspace: route.workspace_id ?? undefined,
    });
  }

  private readSweepScreen(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<CmuxReadScreenResult> {
    ctx.route ??= this.resolveAgentIoRoute(
      agent.agent_id,
      this.client.supportsStableSurfaceReads ? ctx.surfaceTopology : undefined,
    );
    ctx.screen ??= ctx.route.then(async (route) => {
      const readTarget =
        this.client.supportsStableSurfaceReads && route.surface_uuid
          ? route.surface_uuid
          : route.surface_id;
      const versionBeforeRead = this.stateMgr.readState(agent.agent_id)?.version;
      const read = () =>
        this.client.readScreen(readTarget, {
          lines: BOOT_SESSION_CAPTURE_LINES,
          workspace: route.workspace_id ?? undefined,
        });
      let screen: CmuxReadScreenResult;
      try {
        screen = ctx.withUnlocked ? await ctx.withUnlocked(read) : await read();
      } catch (error) {
        if (
          error instanceof LifecycleLockReacquireError ||
          (ctx.sweep &&
            this.stateMgr.readState(agent.agent_id)?.version !==
              versionBeforeRead)
        ) {
          ctx.invalidated = true;
        }
        throw error;
      }
      if (
        ctx.sweep &&
        (this.stateMgr.readState(agent.agent_id)?.version !==
            versionBeforeRead ||
          !this.assertSweepInputCurrent(ctx))
      ) {
        ctx.invalidated = true;
        throw new Error(
          `Agent ${agent.agent_id} changed during sweep screen read`,
        );
      }
      const observedSurface = screen.surface?.trim();
      ctx.observedSurfaceRef = observedSurface || null;
      if (!this.client.supportsStableSurfaceReads) {
        await this.resolveUnchangedAgentIoRoute(
          agent.agent_id,
          route,
          "sweep screen read",
        );
      }
      this.currentSweepScreenSignatures.set(
        agent.agent_id,
        `${route.surface_id}:${screenTextSignature(screen.text)}`,
      );
      return screen;
    });
    return ctx.screen;
  }

  private async sweepReadMatchesBinding(
    ctx: SweepAgentContext,
    surfaceRef: string,
  ): Promise<boolean> {
    if (!ctx.route) return true;
    try {
      const readRoute = await ctx.route;
      if (this.client.supportsStableSurfaceReads) {
        const observedSurface = ctx.observedSurfaceRef;
        return (
          readRoute.surface_id === surfaceRef &&
          (!observedSurface ||
            observedSurface === readRoute.surface_id ||
            observedSurface.toLowerCase() ===
              readRoute.surface_uuid?.toLowerCase())
        );
      }
      const currentRoute = await this.resolveAgentIoRoute(readRoute.agent_id);
      return (
        this.sameSurfaceRoute(readRoute, currentRoute) &&
        currentRoute.surface_id === surfaceRef
      );
    } catch {
      return false;
    }
  }

  private async maybeCaptureBootSessionId(
    agent: AgentRecord,
    ctx: SweepAgentContext,
    opts: { resolveTranscript?: boolean } = {},
  ): Promise<AgentRecord> {
    if (!this.assertSweepInputCurrent(ctx)) return agent;
    if (agent.cli_session_id) {
      const canResolveSelfRegistration =
        this.canUseSelfRegistrationProcessEvidence(agent);
      const recordedProcessGone =
        canResolveSelfRegistration &&
        Boolean(agent.pid) &&
        agentProcessLiveness(agent) === "gone";
      if (canResolveSelfRegistration && (!agent.pid || recordedProcessGone)) {
        try {
          const registered = this.selfRegistrationSessionResolver?.(agent);
          if (registered) {
            const identity = this.normalizeCapturedSessionIdentity(registered);
            const previousRegisteredAtMs = Date.parse(
              agent.pid_registered_at ?? "",
            );
            const replacementRegisteredAtMs = Date.parse(
              identity.pid_registered_at ?? "",
            );
            const replacementHasFiniteTimestamp = Number.isFinite(
              replacementRegisteredAtMs,
            );
            const replacementIsNewer =
              replacementHasFiniteTimestamp &&
              (!agent.pid ||
                !Number.isFinite(previousRegisteredAtMs) ||
                replacementRegisteredAtMs > previousRegisteredAtMs);
            if (
              identity.session_id === agent.cli_session_id &&
              identity.pid &&
              identity.pid_registered_at &&
              replacementIsNewer
            ) {
              agent = this.finalizeCapturedSession(agent, identity);
            }
          }
        } catch {
          // Session identity is already durable; retry process evidence later.
        }
      }
      if (
        agent.transcript_session_capture_deferred === true ||
        (agent.transcript_session_capture_attempts ?? 0) > 0
      ) {
        try {
          const updated = this.stateMgr.setTranscriptSessionCaptureDeferred(
            agent.agent_id,
            false,
            0,
          );
          this.registry.set(agent.agent_id, updated);
          return updated;
        } catch {
          return agent;
        }
      }
      return agent;
    }

    let captureAgent = agent;
    const hasTranscriptContext =
      this.hasTranscriptSessionResolverContext(agent);
    const transcriptEligible = this.canUseTranscriptSessionResolver(agent);
    if (
      agent.transcript_session_capture_deferred === true &&
      !hasTranscriptContext
    ) {
      try {
        captureAgent = this.stateMgr.setTranscriptSessionCaptureDeferred(
          agent.agent_id,
          false,
          0,
        );
        this.registry.set(agent.agent_id, captureAgent);
      } catch {
        return agent;
      }
    }
    if (
      opts.resolveTranscript === false &&
      transcriptEligible &&
      captureAgent.transcript_session_capture_deferred !== true
    ) {
      try {
        captureAgent = this.stateMgr.setTranscriptSessionCaptureDeferred(
          agent.agent_id,
          true,
          0,
        );
        this.registry.set(agent.agent_id, captureAgent);
      } catch {
        // Startup remains available even if the best-effort retry marker fails.
      }
    }
    const canUseSelfRegistration =
      this.canUseSelfRegistrationSessionResolver(captureAgent);
    const resolvingFirstConnect = opts.resolveTranscript === false;
    const shouldResolveIdentity =
      canUseSelfRegistration ||
      (!resolvingFirstConnect &&
        (transcriptEligible ||
          captureAgent.transcript_session_capture_deferred === true));
    if (shouldResolveIdentity) {
      let resolvedSession: CapturedSessionIdentity | string | null;
      try {
        resolvedSession = resolvingFirstConnect
          ? (this.selfRegistrationSessionResolver?.(captureAgent) ?? null)
          : this.sessionIdentityResolver(captureAgent);
      } catch {
        return !resolvingFirstConnect &&
          captureAgent.transcript_session_capture_deferred === true
          ? this.recordDeferredTranscriptCaptureFailure(captureAgent)
          : captureAgent;
      }
      if (resolvedSession) {
        try {
          return this.finalizeCapturedSession(captureAgent, resolvedSession);
        } catch {
          return captureAgent;
        }
      }
      if (
        !resolvingFirstConnect &&
        captureAgent.transcript_session_capture_deferred === true
      ) {
        captureAgent =
          this.recordDeferredTranscriptCaptureFailure(captureAgent);
      }
    }

    if (
      captureAgent.cli === "codex" ||
      !this.isBootCaptureWindowOpen(captureAgent)
    ) {
      return captureAgent;
    }

    try {
      const screen = await this.readSweepScreen(captureAgent, ctx);
      if (!this.assertSweepInputCurrent(ctx)) return captureAgent;
      const sessionId = extractSessionId(screen.text);
      if (!sessionId) {
        return captureAgent;
      }

      return this.finalizeCapturedSession(captureAgent, {
        session_id: sessionId,
        path: null,
      });
    } catch {
      return captureAgent;
    }
  }

  private recordDeferredTranscriptCaptureFailure(
    agent: AgentRecord,
  ): AgentRecord {
    const previousAttempts = Number.isFinite(
      agent.transcript_session_capture_attempts,
    )
      ? Math.max(0, Math.trunc(agent.transcript_session_capture_attempts ?? 0))
      : 0;
    const attempts = Math.min(
      MAX_DEFERRED_TRANSCRIPT_CAPTURE_ATTEMPTS,
      previousAttempts + 1,
    );
    try {
      const updated = this.stateMgr.setTranscriptSessionCaptureDeferred(
        agent.agent_id,
        attempts < MAX_DEFERRED_TRANSCRIPT_CAPTURE_ATTEMPTS,
        attempts,
      );
      this.registry.set(agent.agent_id, updated);
      return updated;
    } catch {
      return agent;
    }
  }

  async captureBootSessionId(agentId: string): Promise<AgentRecord | null> {
    const agent =
      this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
    if (!agent) {
      return null;
    }
    return this.maybeCaptureBootSessionId(agent, {});
  }

  private async captureCodexSpawnSessionId(agentId: string): Promise<void> {
    const deadline = Date.now() + this.spawnSessionCaptureTimeoutMs;
    while (true) {
      const current =
        this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
      if (!current) return;
      const captured = await this.maybeCaptureBootSessionId(current, {}, {
        resolveTranscript: false,
      });
      if (captured.cli_session_id) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolveSleep) =>
        setTimeout(
          resolveSleep,
          Math.min(SPAWN_SESSION_CAPTURE_POLL_MS, remaining),
        ),
      );
    }
  }

  private async retryDeferredTranscriptCaptures(): Promise<void> {
    for (const agent of this.registry.list()) {
      if (agent.transcript_session_capture_deferred !== true) continue;
      await this.maybeCaptureBootSessionId(agent, {});
    }
  }

  private async maybeMarkBootReady(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<AgentRecord> {
    if (!this.assertSweepInputCurrent(ctx)) return agent;
    if (agent.state !== "booting") {
      this.readyPatternMatches.delete(agent.agent_id);
      return agent;
    }
    if (agent.agent_id.startsWith("auto-")) {
      return agent;
    }

    try {
      const screen = await this.readSweepScreen(agent, ctx);
      if (!this.assertSweepInputCurrent(ctx)) return agent;
      const parsed = parseScreen(screen.text);
      const parsedEffort =
        agent.cli === "codex" ? parseCodexEffort(parsed.model) : null;
      const settlement = {
        parsed_model: parsed.model,
        model_mismatch: computeModelMismatch(agent.model, parsed.model),
        parsed_effort: parsedEffort,
        effort_mismatch: computeEffortMismatch(agent.effort, parsedEffort),
      };
      const evidence = this.readReadyEvidence(agent, screen.text);
      const promptStillPending =
        agent.boot_prompt_pending === true &&
        this.screenShowsPendingBootPrompt(agent, screen.text);
      const awaitingManagedBootPrompt =
        agent.boot_prompt_pending === true &&
        agent.prompt_delivered === false;

      if (promptStillPending || awaitingManagedBootPrompt) {
        this.readyPatternMatches.delete(agent.agent_id);
        if (this.isBootPromptPendingStale(agent)) {
          const failedSettlement = this.stateMgr.updateRecord(agent.agent_id, {
            ...settlement,
            boot_prompt_pending: false,
            prompt_delivered: false,
            submit_verified: false,
          });
          const failed = this.stateMgr.transition(
            failedSettlement.agent_id,
            "error",
            {
              error:
                "Boot prompt delivery was not verified before the pending-input timeout",
            },
          );
          this.registry.set(agent.agent_id, failed);
          return failed;
        }
        if (
          agent.submit_verified !== false ||
          agent.prompt_delivered !== false ||
          agent.parsed_model !== settlement.parsed_model ||
          agent.model_mismatch !== settlement.model_mismatch
        ) {
          const pending = this.stateMgr.updateRecord(agent.agent_id, {
            ...settlement,
            prompt_delivered: false,
            submit_verified: false,
          });
          this.registry.set(agent.agent_id, pending);
          return pending;
        }
        return agent;
      }

      if (!evidence.ready && !evidence.activeCodex) {
        this.readyPatternMatches.delete(agent.agent_id);
        const since = Date.parse(agent.updated_at);
        if (
          !Number.isNaN(since) &&
          Date.now() - since >= BOOT_READY_TIMEOUT_MS
        ) {
          const failedSettlement = this.stateMgr.updateRecord(agent.agent_id, {
            ...settlement,
            ...(agent.boot_prompt_pending
              ? {
                  boot_prompt_pending: false,
                  prompt_delivered: false,
                  submit_verified: false,
                }
              : {}),
          });
          const failed = this.stateMgr.transition(
            failedSettlement.agent_id,
            "error",
            {
              error:
                "Stuck booting — CLI never became interactive within the boot timeout",
            },
          );
          this.registry.set(agent.agent_id, failed);
          return failed;
        }
        return agent;
      }

      const count = (this.readyPatternMatches.get(agent.agent_id) ?? 0) + 1;
      this.readyPatternMatches.set(agent.agent_id, count);
      if (count < Math.max(1, evidence.consecutive)) {
        return agent;
      }

      const settled = this.stateMgr.updateRecord(agent.agent_id, {
        ...settlement,
        ...(agent.boot_prompt_pending && agent.prompt_delivered !== false
          ? {
              boot_prompt_pending: false,
              prompt_delivered: true,
              submit_verified: true,
            }
          : {}),
      });
      let updated = this.stateMgr.transition(settled.agent_id, "ready", {
        error: agent.error?.startsWith("Post-spawn liveness failed:")
          ? null
          : agent.error,
      });
      if (
        updated.quality === "degraded" &&
        agent.error?.startsWith("Post-spawn liveness failed:")
      ) {
        updated = this.stateMgr.updateRecord(agent.agent_id, {
          quality: "unknown",
        });
      }
      this.registry.set(agent.agent_id, updated);
      this.readyPatternMatches.delete(agent.agent_id);
      return updated;
    } catch {
      return agent;
    }
  }

  private async maybeMarkTaskDone(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<{ agent: AgentRecord; screenText?: string }> {
    if (!this.assertSweepInputCurrent(ctx)) return { agent };
    if (TERMINAL_STATES.has(agent.state)) return { agent };

    if (await this.hasGroundTruthDone(agent, ctx)) {
      if (!this.assertSweepInputCurrent(ctx)) return { agent };
      try {
        const marked = this.stateMgr.updateRecord(agent.agent_id, {
          task_done_candidate_at: null,
          task_done_detected_at: new Date().toISOString(),
          ...(agent.boot_prompt_pending ? { boot_prompt_pending: false } : {}),
        });
        this.registry.set(agent.agent_id, marked);
        const updated = this.stateMgr.transition(agent.agent_id, "done");
        this.registry.set(agent.agent_id, updated);
        return { agent: updated };
      } catch {
        return { agent };
      }
    }

    try {
      const screen = await this.readSweepScreen(agent, ctx);
      if (!this.assertSweepInputCurrent(ctx)) return { agent };
      if (!this.hasOutputDoneEvidence(agent.cli, screen.text)) {
        if (agent.task_done_candidate_at) {
          const updated = this.stateMgr.updateRecord(agent.agent_id, {
            task_done_candidate_at: null,
          });
          this.registry.set(agent.agent_id, updated);
          return { agent: updated, screenText: screen.text };
        }
        return { agent, screenText: screen.text };
      }

      const candidateAt = Date.parse(agent.task_done_candidate_at ?? "");
      if (!agent.task_done_candidate_at || Number.isNaN(candidateAt)) {
        const updated = this.stateMgr.updateRecord(agent.agent_id, {
          task_done_candidate_at: new Date().toISOString(),
        });
        this.registry.set(agent.agent_id, updated);
        return { agent: updated, screenText: screen.text };
      }
      if (Date.now() - candidateAt < TASK_DONE_CONFIRMATION_MS) {
        return { agent, screenText: screen.text };
      }

      const marked = this.stateMgr.updateRecord(agent.agent_id, {
        task_done_candidate_at: null,
        task_done_detected_at: new Date().toISOString(),
        ...(agent.boot_prompt_pending ? { boot_prompt_pending: false } : {}),
      });
      this.registry.set(agent.agent_id, marked);
      const updated = this.stateMgr.transition(agent.agent_id, "done");
      this.registry.set(agent.agent_id, updated);
      return { agent: updated, screenText: screen.text };
    } catch {
      return { agent };
    }
  }

  // halt: bodies live in ./engine/halt.ts (CX-3); delegates keep call sites and spies.
  private haltDwellMs(...args: Parameters<typeof haltImpl.haltDwellMs>): ReturnType<typeof haltImpl.haltDwellMs> {
    return haltImpl.haltDwellMs.call(this.haltHost(), ...args);
  }
  private haltUnblockAction(...args: Parameters<typeof haltImpl.haltUnblockAction>): ReturnType<typeof haltImpl.haltUnblockAction> {
    return haltImpl.haltUnblockAction.call(this.haltHost(), ...args);
  }
  private hasParentVisibleArtifactSinceIdle(...args: Parameters<typeof haltImpl.hasParentVisibleArtifactSinceIdle>): ReturnType<typeof haltImpl.hasParentVisibleArtifactSinceIdle> {
    return haltImpl.hasParentVisibleArtifactSinceIdle.call(this.haltHost(), ...args);
  }
  private isIdleSupervisor(...args: Parameters<typeof haltImpl.isIdleSupervisor>): ReturnType<typeof haltImpl.isIdleSupervisor> {
    return haltImpl.isIdleSupervisor.call(this.haltHost(), ...args);
  }
  private observableHaltProgressSignature(...args: Parameters<typeof haltImpl.observableHaltProgressSignature>): ReturnType<typeof haltImpl.observableHaltProgressSignature> {
    return haltImpl.observableHaltProgressSignature.call(this.haltHost(), ...args);
  }
  private readBackgroundProcessSnapshot(...args: Parameters<typeof haltImpl.readBackgroundProcessSnapshot>): ReturnType<typeof haltImpl.readBackgroundProcessSnapshot> {
    return haltImpl.readBackgroundProcessSnapshot.call(this.haltHost(), ...args);
  }
  private backgroundChildUsedCpu(...args: Parameters<typeof haltImpl.backgroundChildUsedCpu>): ReturnType<typeof haltImpl.backgroundChildUsedCpu> {
    return haltImpl.backgroundChildUsedCpu.call(this.haltHost(), ...args);
  }
  private isMatureHaltEpisode(...args: Parameters<typeof haltImpl.isMatureHaltEpisode>): ReturnType<typeof haltImpl.isMatureHaltEpisode> {
    return haltImpl.isMatureHaltEpisode.call(this.haltHost(), ...args);
  }
  private clearHaltEpisode(...args: Parameters<typeof haltImpl.clearHaltEpisode>): ReturnType<typeof haltImpl.clearHaltEpisode> {
    return haltImpl.clearHaltEpisode.call(this.haltHost(), ...args);
  }
  private persistPromptBlockedState(...args: Parameters<typeof haltImpl.persistPromptBlockedState>): ReturnType<typeof haltImpl.persistPromptBlockedState> {
    return haltImpl.persistPromptBlockedState.call(this.haltHost(), ...args);
  }
  private persistPausedState(...args: Parameters<typeof haltImpl.persistPausedState>): ReturnType<typeof haltImpl.persistPausedState> {
    return haltImpl.persistPausedState.call(this.haltHost(), ...args);
  }
  private haltSinkQuality(...args: Parameters<typeof haltImpl.haltSinkQuality>): ReturnType<typeof haltImpl.haltSinkQuality> {
    return haltImpl.haltSinkQuality.call(this.haltHost(), ...args);
  }
  private fleetHaltSink(...args: Parameters<typeof haltImpl.fleetHaltSink>): ReturnType<typeof haltImpl.fleetHaltSink> {
    return haltImpl.fleetHaltSink.call(this.haltHost(), ...args);
  }
  private nearestLiveHaltAncestor(...args: Parameters<typeof haltImpl.nearestLiveHaltAncestor>): ReturnType<typeof haltImpl.nearestLiveHaltAncestor> {
    return haltImpl.nearestLiveHaltAncestor.call(this.haltHost(), ...args);
  }
  private appendHaltEscalationEvent(...args: Parameters<typeof haltImpl.appendHaltEscalationEvent>): ReturnType<typeof haltImpl.appendHaltEscalationEvent> {
    return haltImpl.appendHaltEscalationEvent.call(this.haltHost(), ...args);
  }
  private appendResolvedPromptEvent(...args: Parameters<typeof haltImpl.appendResolvedPromptEvent>): ReturnType<typeof haltImpl.appendResolvedPromptEvent> {
    return haltImpl.appendResolvedPromptEvent.call(this.haltHost(), ...args);
  }
  private maybeResolvePrompt(...args: Parameters<typeof haltImpl.maybeResolvePrompt>): ReturnType<typeof haltImpl.maybeResolvePrompt> {
    return haltImpl.maybeResolvePrompt.call(this.haltHost(), ...args);
  }
  private maybeEscalateLiveHalt(...args: Parameters<typeof haltImpl.maybeEscalateLiveHalt>): ReturnType<typeof haltImpl.maybeEscalateLiveHalt> {
    return haltImpl.maybeEscalateLiveHalt.call(this.haltHost(), ...args);
  }

  private haltHostCache: haltImpl.HaltHost | null = null;

  /** The members ./engine/halt.ts needs, as live getters and forwarders. */
  private haltHost(): haltImpl.HaltHost {
    if (this.haltHostCache) return this.haltHostCache;
    const engine = this;
    this.haltHostCache = {
      get autoResolvePrompts() { return engine.autoResolvePrompts; },
      get backgroundChildCpuTimes() { return engine.backgroundChildCpuTimes; },
      get client() { return engine.client; },
      get haltAwaitingInputDwellMs() { return engine.haltAwaitingInputDwellMs; },
      get haltIdleWithoutDoneDwellMs() { return engine.haltIdleWithoutDoneDwellMs; },
      get haltNow() { return engine.haltNow; },
      get haltProcessSnapshot() { return engine.haltProcessSnapshot; },
      get haltWedgedDwellMs() { return engine.haltWedgedDwellMs; },
      get haltWedgedSweeps() { return engine.haltWedgedSweeps; },
      get inboxOpts() { return engine.inboxOpts; },
      get promptMotionObservedAtMs() { return engine.promptMotionObservedAtMs; },
      get promptMotionScreenSignatures() { return engine.promptMotionScreenSignatures; },
      get promptResolutionFailures() { return engine.promptResolutionFailures; },
      get registry() { return engine.registry; },
      get stateMgr() { return engine.stateMgr; },
      get sweepBackgroundProcessSnapshot() { return engine.sweepBackgroundProcessSnapshot; },
      set sweepBackgroundProcessSnapshot(value) { engine.sweepBackgroundProcessSnapshot = value; },
      appendHaltEscalationEvent: (...args) => engine.appendHaltEscalationEvent(...args),
      appendResolvedPromptEvent: (...args) => engine.appendResolvedPromptEvent(...args),
      assertSweepInputCurrent: (...args) => engine.assertSweepInputCurrent(...args),
      backgroundChildUsedCpu: (...args) => engine.backgroundChildUsedCpu(...args),
      clearHaltEpisode: (...args) => engine.clearHaltEpisode(...args),
      fleetHaltSink: (...args) => engine.fleetHaltSink(...args),
      haltDwellMs: (...args) => engine.haltDwellMs(...args),
      haltSinkQuality: (...args) => engine.haltSinkQuality(...args),
      haltUnblockAction: (...args) => engine.haltUnblockAction(...args),
      hasCurrentRecordedOutputDoneEvidence: (...args) => engine.hasCurrentRecordedOutputDoneEvidence(...args),
      hasOutputDoneEvidence: (...args) => engine.hasOutputDoneEvidence(...args),
      hasParentVisibleArtifactSinceIdle: (...args) => engine.hasParentVisibleArtifactSinceIdle(...args),
      isIdleSupervisor: (...args) => engine.isIdleSupervisor(...args),
      isMatureHaltEpisode: (...args) => engine.isMatureHaltEpisode(...args),
      loadGroundTruthSession: (...args) => engine.loadGroundTruthSession(...args),
      maybeResolvePrompt: (...args) => engine.maybeResolvePrompt(...args),
      nearestLiveHaltAncestor: (...args) => engine.nearestLiveHaltAncestor(...args),
      observableHaltProgressSignature: (...args) => engine.observableHaltProgressSignature(...args),
      persistPausedState: (...args) => engine.persistPausedState(...args),
      persistPromptBlockedState: (...args) => engine.persistPromptBlockedState(...args),
      readAgentScreen: (...args) => engine.readAgentScreen(...args),
      readBackgroundProcessSnapshot: (...args) => engine.readBackgroundProcessSnapshot(...args),
      resolveAgentIoRoute: (...args) => engine.resolveAgentIoRoute(...args),
      resolveUnchangedAgentIoRoute: (...args) => engine.resolveUnchangedAgentIoRoute(...args),
      stableSurfaceWriteOptions: (...args) => engine.stableSurfaceWriteOptions(...args),
      transcriptHasSettledDone: (...args) => engine.transcriptHasSettledDone(...args),
    };
    return this.haltHostCache;
  }

  private async maybeMarkCliExited(
    agent: AgentRecord,
    ctx: SweepAgentContext,
    knownScreenText?: string,
  ): Promise<AgentRecord> {
    if (!this.assertSweepInputCurrent(ctx)) return agent;
    if (
      TERMINAL_STATES.has(agent.state) ||
      !(["ready", "working", "idle"] as AgentState[]).includes(agent.state)
    ) {
      this.cliExitShellMatches.delete(agent.agent_id);
      return agent;
    }

    let screenText: string;
    try {
      screenText =
        knownScreenText ?? (await this.readSweepScreen(agent, ctx)).text;
    } catch {
      this.cliExitShellMatches.delete(agent.agent_id);
      return agent;
    }

    if (!this.assertSweepInputCurrent(ctx)) return agent;

    if (parseScreen(screenText).control_state !== "shell") {
      this.cliExitShellMatches.delete(agent.agent_id);
      return agent;
    }

    const observations =
      (this.cliExitShellMatches.get(agent.agent_id) ?? 0) + 1;
    this.cliExitShellMatches.set(agent.agent_id, observations);
    if (observations < CLI_EXIT_SHELL_CONFIRMATION_SWEEPS) {
      return agent;
    }

    let exited: AgentRecord;
    try {
      exited = this.stateMgr.transition(agent.agent_id, "error", {
        error: CLI_EXIT_ERROR,
      });
    } catch {
      return agent;
    }
    this.registry.set(agent.agent_id, exited);
    this.cliExitShellMatches.delete(agent.agent_id);

    let inboxDispatched = false;
    if (agent.parent_agent_id) {
      try {
        dispatchOnce(
          agent.parent_agent_id,
          {
            id: `agent-cli-exit:${agent.agent_id}:${exited.updated_at}`,
            from: "cmuxlayer:lifecycle",
            to: agent.parent_agent_id,
            tag: "agent_cli_exit",
            task:
              `Agent ${agent.agent_id} CLI exited to a bare shell without done evidence. ` +
              `Registry state is error; surface ${agent.surface_id}.`,
          },
          this.inboxOpts,
        );
        inboxDispatched = true;
      } catch {
        // The durable event below records the failed dispatch for lead recovery.
      }
    }

    this.stateMgr.getEventLog().appendAgentCliExit({
      ts: exited.updated_at,
      event_type: "agent_cli_exit",
      agent_id: agent.agent_id,
      surface_id: agent.surface_id,
      parent_agent_id: agent.parent_agent_id,
      previous_state: agent.state,
      control_state: "shell",
      consecutive_observations: observations,
      inbox_dispatched: inboxDispatched,
      error: CLI_EXIT_ERROR,
    });
    return exited;
  }

  private async cleanupUnboundCreatedSurface(
    surface: CreatedAgentSurface,
    operation: "agent-placement" | "crash-recovery",
  ): Promise<boolean> {
    try {
      const sameObserverEpoch = this.isSurfaceObserverEpochCurrent(
        surface.observerEpoch,
      );
      if (!sameObserverEpoch) {
        const currentObserverId = this.registry.getObserverId();
        if (
          !surface.surface_id ||
          !surface.observerId ||
          currentObserverId !== surface.observerId
        ) {
          await this.logUnboundSurfaceCleanupWarning(
            `${operation}: refusing cleanup of unbound ${surface.surface} ` +
              `(${surface.surface_id ?? "UUID unknown"}); surface observer ` +
              `ownership changed (orphan-risk)`,
          );
          return false;
        }
      }

      const cleanupEpoch = sameObserverEpoch
        ? surface.observerEpoch
        : this.captureSurfaceObserverEpoch();

      const resolveCleanupBinding = async () => {
        const topology = await this.collectObservedSurfaceTopology();
        if (
          topology?.complete !== true ||
          topology.workspaceBySurface.size === 0
        ) {
          return null;
        }
        const binding = resolveAgentSurfaceBinding(
          {
            surface_id: surface.surface,
            surface_uuid: surface.surface_id,
          },
          topology,
        );
        return binding?.provenance === "uuid" ? binding : null;
      };
      const binding = await resolveCleanupBinding();
      if (!binding) {
        await this.logUnboundSurfaceCleanupWarning(
          `${operation}: orphan-risk: unbound surface ${surface.surface_id ?? "UUID unknown"} ` +
            `was not uniquely resolvable for cleanup`,
        );
        return false;
      }

      this.assertSurfaceObserverEpochCurrent(
        cleanupEpoch,
        `${operation} cleanup`,
      );
      await this.client.closeSurface(binding.surfaceUuid, {
        workspace:
          binding.workspaceId ?? surface.actual_workspace ?? surface.workspace,
        collapsePane: false,
        ...this.stableSurfaceWriteOptions(surface.surface_id),
        beforeMutation: async () => {
          this.assertSurfaceObserverEpochCurrent(
            cleanupEpoch,
            `${operation} cleanup`,
          );
          const currentBinding = await resolveCleanupBinding();
          if (
            !currentBinding ||
            currentBinding.surfaceRef !== binding.surfaceRef ||
            currentBinding.workspaceId !== binding.workspaceId
          ) {
            throw new Error(
              `orphan-risk: unbound surface ${surface.surface_id} changed binding before cleanup`,
            );
          }
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logUnboundSurfaceCleanupWarning(
        `${operation}: failed to clean unbound surface ${surface.surface} ` +
          `(${surface.surface_id ?? "UUID unknown"}): ${message}`,
      );
      return false;
    }
  }

  private isExactDurableSurfaceBinding(
    actual: AgentRecord,
    expected: AgentRecord,
  ): boolean {
    return (
      actual.agent_id === expected.agent_id &&
      actual.surface_id === expected.surface_id &&
      (actual.surface_uuid ?? null) === (expected.surface_uuid ?? null) &&
      (actual.surface_observer_id ?? null) ===
        (expected.surface_observer_id ?? null) &&
      (actual.workspace_id ?? null) === (expected.workspace_id ?? null)
    );
  }

  private async logUnboundSurfaceCleanupWarning(
    message: string,
  ): Promise<void> {
    try {
      await this.client.log(message, {
        level: "warning",
        source: "cmuxlayer",
      });
    } catch {
      // Cleanup diagnostics must never mask the original placement failure.
    }
  }

  private compactSidebarValue(value: string | null | undefined): string {
    const normalized = (value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return "-";
    return normalized.length > 160
      ? `${normalized.slice(0, 157).trimEnd()}...`
      : normalized;
  }

  private formatHealthSummary(health: AgentHealth): string {
    if (health.issue_codes.length === 0) return health.status;
    const issueSummary = health.issue_codes
      .map((code) => {
        const severity =
          health.issue_severities?.[code] ??
          DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY[code];
        return `${code}:${severity}`;
      })
      .join(",");
    return `${health.status}(${issueSummary})`;
  }

  private formatReportSummary(harvestability: WorkerHarvestability): string {
    if (!harvestability.report_path) return "n/a";
    if (harvestability.closure_artifact_verified === true) return "verified";
    if (harvestability.report_exists === false) return "missing";
    if (harvestability.report_fresh === false) return "stale";
    return "unverified";
  }

  private formatPrSummary(harvestability: WorkerHarvestability): string {
    if (!harvestability.pr_loop_required) return "n/a";
    return harvestability.pr_loop_satisfied === true
      ? "satisfied"
      : "incomplete";
  }

  private extractNamedBlocker(agent: AgentRecord): string | null {
    const text = [agent.error, resolveBootPromptText(agent), agent.task_summary]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" ");
    const match = text.match(
      /\b(?:blocked by|blocked on|waiting on|waits on)\s+([A-Za-z0-9_.:@/-]+)/i,
    );
    return match?.[1]?.replace(/[),.;:]+$/g, "") ?? null;
  }

  private formatBlockedSummary(
    agent: AgentRecord,
    health: AgentHealth,
  ): string {
    const namedBlocker = this.extractNamedBlocker(agent);
    if (namedBlocker) return namedBlocker;
    if (health.issue_codes.includes("agent_wedged")) {
      return "self:agent_wedged";
    }
    if (health.issue_codes.includes("recoverable_blocker_requires_action")) {
      return "recoverable_action";
    }
    return "-";
  }

  private buildSidebarStatusValue(
    agent: AgentRecord,
    health: AgentHealth,
    harvestability: WorkerHarvestability,
  ): string {
    const role = inferRecordRoleOrNull(agent) ?? "unknown";
    const worktree = agent.worktree_path ?? agent.launch_cwd ?? null;
    return [
      agent.repo,
      `role=${role}`,
      agent.seat_id ? `seat=${agent.seat_id}` : null,
      agent.seat_lane ? `lane=${agent.seat_lane}` : null,
      `state=${agent.state}`,
      `health=${this.formatHealthSummary(health)}`,
      `blocked=${this.formatBlockedSummary(agent, health)}`,
      `last_prompt=${this.compactSidebarValue(agent.task_summary)}`,
      `worktree=${this.compactSidebarValue(worktree)}`,
      `branch=${this.compactSidebarValue(agent.worktree_branch)}`,
      `report=${this.formatReportSummary(harvestability)}`,
      `pr=${this.formatPrSummary(harvestability)}`,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ");
  }

  private healthSignature(health: AgentHealth): string {
    return this.formatHealthSummary(health);
  }

  private clearAgentLifecycleMemory(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const key of this.loggedEvents) {
      if (key.startsWith(prefix)) {
        this.loggedEvents.delete(key);
      }
    }
    for (const key of this.notifiedEvents) {
      if (key.startsWith(prefix)) {
        this.notifiedEvents.delete(key);
      }
    }
    this.deliveredLeadMonitorDeathAlerts.delete(agentId);
    this.cliExitShellMatches.delete(agentId);
    this.promptMotionObservedAtMs.delete(agentId);
    this.promptMotionScreenSignatures.delete(agentId);
    this.backgroundChildCpuTimes.delete(agentId);
  }

  private isLeadWatchBlind(
    agent: AgentRecord,
    _healthInput: AgentHealthInput,
  ): boolean {
    if (inferRecordRoleOrNull(agent) !== "orchestrator") {
      return false;
    }

    if (this.latestLeadMonitor(agent)?.state === "deadman-fired") return true;

    if (
      agent.pid !== null &&
      agent.pid !== undefined &&
      this.processLiveness(agent.pid) === "gone"
    ) {
      return true;
    }

    return (
      agent.state === "error" &&
      /\b(?:pty|session|process|pane|surface|disappeared)\b/i.test(
        agent.error ?? "",
      )
    );
  }

  private leadOwnerSeats(agent: AgentRecord): string[] {
    return [agent.seat_id, agent.agent_id].filter(
      (ownerSeat): ownerSeat is string =>
        typeof ownerSeat === "string" && ownerSeat.trim().length > 0,
    );
  }

  private latestLeadMonitor(agent: AgentRecord) {
    if (!this.monitorRegistryPath) return null;
    return latestMonitorForOwnerSeats(this.leadOwnerSeats(agent), {
      registryPath: this.monitorRegistryPath,
      now: this.monitorRegistryNow,
    });
  }

  private async maybeNotifyLeadMonitorDeath(
    agent: AgentRecord,
    healthInput: AgentHealthInput,
  ): Promise<void> {
    if (inferRecordRoleOrNull(agent) !== "orchestrator") {
      this.deliveredLeadMonitorDeathAlerts.delete(agent.agent_id);
      return;
    }

    if (!this.isLeadWatchBlind(agent, healthInput)) {
      this.deliveredLeadMonitorDeathAlerts.delete(agent.agent_id);
      return;
    }

    if (this.deliveredLeadMonitorDeathAlerts.has(agent.agent_id)) {
      return;
    }

    if (!this.client.notify) {
      return;
    }

    const workspace = agent.workspace_id ?? "unknown";
    try {
      await this.client.notify({
        title: "Lead monitor/session ended",
        subtitle: `${agent.repo} lead ${agent.agent_id}`,
        body: `Lead seat ${agent.agent_id} in workspace ${workspace} is watch-blind: monitor/session ended - lead is watch-blind. Last-known state: ${agent.state}.`,
        workspace: agent.workspace_id ?? undefined,
        surface: agent.surface_id,
      });
      this.deliveredLeadMonitorDeathAlerts.add(agent.agent_id);
    } catch {
      // Notification delivery is best-effort; do not break sweeps. Retry next sweep.
    }
  }

  private async logLifecycleEvent(
    agent: AgentRecord,
    event: AgentLifecycleEvent,
    ctx: SweepAgentContext = {},
  ): Promise<void> {
    if (!this.assertSweepInputCurrent(ctx)) return;
    const eventKey = `${agent.agent_id}:${event}`;
    if (this.loggedEvents.has(eventKey)) {
      return;
    }

    const spec = LIFECYCLE_LOGS[event];
    try {
      await this.client.log(`${spec.message}: ${agent.repo}`, {
        level: spec.level,
        source: "cmuxlayer",
      });
      this.loggedEvents.add(eventKey);
    } catch {
      // Lifecycle logging is auxiliary publication, not boot topology truth.
      // Retry on the next sweep without failing the daemon's ingestion gate.
    }
  }

  private async notifyLifecycleEvent(
    agent: AgentRecord,
    event: AgentLifecycleEvent,
    signature?: string,
  ): Promise<boolean> {
    const eventSuffix = signature === undefined ? "" : `:${signature}`;
    const eventKey = `${agent.agent_id}:${event}${eventSuffix}`;
    if (this.notifiedEvents.has(eventKey)) {
      return true;
    }

    try {
      // Channel delivery is best-effort and must not break the sweep loop.
      if (signature === undefined) {
        await this.client.notifyLifecycleEvent(event, agent);
      } else {
        await this.client.notifyLifecycleEvent(event, agent, signature);
      }
      if (event === "health") {
        this.clearHealthNotificationMemory(agent.agent_id);
      }
      this.notifiedEvents.add(eventKey);
      return true;
    } catch {
      // Ignore Claude channel push failures; logs and sidebar state remain canonical.
      return false;
    }
  }

  private async notifyLifecycleEventForSweep(
    ctx: SweepAgentContext,
    agent: AgentRecord,
    event: AgentLifecycleEvent,
    signature?: string,
  ): Promise<boolean> {
    if (!this.assertSweepInputCurrent(ctx)) return false;
    return this.notifyLifecycleEvent(agent, event, signature);
  }

  private clearHealthNotificationMemory(agentId: string): void {
    const healthPrefix = `${agentId}:health:`;
    for (const key of this.notifiedEvents) {
      if (key.startsWith(healthPrefix)) {
        this.notifiedEvents.delete(key);
      }
    }
  }

  private async publishSweepStatus(
    ctx: SweepAgentContext,
    statusUpdates: CmuxStatusUpdate[],
  ): Promise<ReadonlySet<string>> {
    if (!this.assertSweepInputCurrent(ctx)) return new Set();
    if (statusUpdates.length > 1) {
      if (this.client.setStatuses) {
        try {
          const batchApplied = await this.client.setStatuses(statusUpdates);
          if (batchApplied !== false) {
            return new Set(statusUpdates.map(({ key }) => key));
          }
          return new Set();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.sweepDebugLog(
            `[cmuxlayer] sidebar status batch failed; retrying entries independently: ${message}`,
          );
        }
      }
    }

    const applied = new Set<string>();
    for (const update of statusUpdates) {
      if (!this.assertSweepInputCurrent(ctx)) return new Set();
      try {
        await this.client.setStatus(update.key, update.value, update);
        applied.add(update.key);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sweepDebugLog(
          `[cmuxlayer] sidebar status skipped for ${update.key}: ${message}`,
        );
      }
    }
    return applied;
  }

  private shouldNotifyDone(harvestability: WorkerHarvestability): boolean {
    return harvestability.closeable;
  }

  private shouldNotifyHealthChange(
    prev: SidebarStatusSnapshot | undefined,
    health: AgentHealth,
  ): boolean {
    if (!prev) return health.status === "unhealthy";
    const nextSignature = this.healthSignature(health);
    if (prev.healthSignature === nextSignature) return false;
    return health.status === "unhealthy";
  }

  private isKnownClosedSurface(
    agent: AgentRecord,
    surfaceTopology: SurfaceTopologySnapshot | null,
  ): boolean {
    if (
      !surfaceTopology ||
      surfaceTopology.complete !== true ||
      surfaceTopology.workspaceBySurface.size === 0
    ) {
      return false;
    }
    return !surfaceTopology.workspaceBySurface.has(agent.surface_id);
  }

  private surfaceObserverEpochProvider():
    SurfaceObserverIdProvider | undefined {
    return this.registry.isObserverOwnershipEnforced()
      ? () => this.registry.getObserverEpoch()
      : undefined;
  }

  private surfaceObserverIdProvider(): SurfaceObserverIdProvider | undefined {
    return this.registry.isObserverOwnershipEnforced()
      ? () => this.registry.getObserverId()
      : undefined;
  }

  private captureSurfaceObserverEpoch(): SurfaceObserverEpoch {
    return captureObserverEpoch(this.surfaceObserverEpochProvider());
  }

  private async listAllWorkspaces(): Promise<AllWindowWorkspaceEnumeration> {
    const listed = this.client.listAllWorkspaces
      ? await this.client.listAllWorkspaces()
      : await enumerateAllWindowWorkspacesWithRetry(
          this.client,
          this.surfaceObserverEpochProvider(),
        );
    if (!listed.complete) {
      throw new Error("Incomplete cmux all-window workspace enumeration");
    }
    return listed;
  }

  private isSurfaceObserverEpochCurrent(
    observerEpoch: SurfaceObserverEpoch,
  ): boolean {
    return isSurfaceObserverEpochCurrent(
      observerEpoch,
      this.surfaceObserverEpochProvider(),
    );
  }

  private isSweepTopologyObserverCurrent(
    surfaceTopology: SurfaceTopologySnapshot | null,
  ): boolean {
    if (!this.registry.isObserverOwnershipEnforced()) return true;
    return Boolean(
      surfaceTopology?.observerId &&
      surfaceTopology.observerEpoch &&
      this.registry.getObserverId() === surfaceTopology.observerId &&
      this.registry.getObserverEpoch() === surfaceTopology.observerEpoch,
    );
  }

  private canRunSnapshotBackedSweepMutation(
    surfaceTopology: SurfaceTopologySnapshot | null,
    skipAccounting: SweepMutationSkipAccounting,
  ): boolean {
    if (this.isSweepTopologyObserverCurrent(surfaceTopology)) return true;
    // The topology belongs to a replaced route. Count this preserved sweep tick
    // once as reason=epoch_changed and never re-collect partway through it.
    this.countSkippedSweepTick(skipAccounting);
    return false;
  }

  /**
   * The single bounded authorization check for a sweep side effect. Non-sweep
   * callers do not carry `sweep`, so normal interactive lifecycle operations
   * retain their existing behavior.
   */
  private assertSweepInputCurrent(ctx: SweepAgentContext): boolean {
    if (ctx.sweep !== true) return true;
    const topology = ctx.surfaceTopology ?? null;
    const transport = getTransportHealth(this.client);
    const reason =
      ctx.invalidated
        ? "agent_changed_during_read"
        : topology?.complete !== true || topology.surfaces.length === 0
        ? "topology_incomplete"
        : !this.isSweepTopologyObserverCurrent(topology)
          ? "epoch_changed"
          : transport?.mode !== "socket" || transport.degraded !== false
            ? "transport_degraded"
            : ctx.topologyGeneration !== this.sweepTopologyGeneration ||
                topology.generation !== ctx.topologyGeneration
              ? "topology_generation_changed"
              : null;
    const current = reason === null;
    if (!current && ctx.skipAccounting) {
      this.countSkippedSweepTick(ctx.skipAccounting, reason);
    }
    return current;
  }

  private shouldYieldSweep(): boolean {
    if (this.lifecycleLockQueueDepth === 0) return false;
    this.sweepYielded += 1;
    return true;
  }

  private invalidateSweepTopologyGeneration(): void {
    this.sweepTopologyGeneration += 1;
  }

  private countSkippedSweepTick(
    skipAccounting: SweepMutationSkipAccounting,
    reason = "epoch_changed",
  ): void {
    if (skipAccounting.counted) return;
    skipAccounting.counted = true;
    this.sweepSkippedMutations += 1;
    this.sweepSkippedReason = reason;
  }

  private assertSurfaceObserverEpochCurrent(
    observerEpoch: SurfaceObserverEpoch,
    operation: string,
  ): void {
    if (this.isSurfaceObserverEpochCurrent(observerEpoch)) return;
    const currentObserverEpoch = this.captureSurfaceObserverEpoch();
    throw new PlacementSurfaceBindingError(
      `Surface observer changed or became unavailable during ${operation} ` +
        `(${observerEpoch ?? "unknown"} -> ${currentObserverEpoch ?? "unknown"}); ` +
        `refusing to mutate a different cmux instance.`,
    );
  }

  private collectObservedSurfaceTopology(
    onRpc?: TopologyRpcObserver,
  ): Promise<SurfaceTopologySnapshot | null> {
    return collectSurfaceTopology(
      this.client,
      undefined,
      this.surfaceObserverEpochProvider(),
      this.surfaceObserverIdProvider(),
      onRpc,
    );
  }

  private collectFreshObservedSurfaceTopology(): Promise<SurfaceTopologySnapshot | null> {
    return collectSurfaceTopology(
      this.client,
      undefined,
      this.surfaceObserverEpochProvider(),
      this.surfaceObserverIdProvider(),
    );
  }

  /**
   * Reconcile every registry row against the observed topology and screen:
   * rebind surfaces, advance lifecycle (boot capture, ready, done, CLI exit),
   * evaluate health and halts, and push changed cmux status pills only.
   * Logs lifecycle events (spawned, done, error) once each.
   */
  private reconcileAgents(
    ...args: Parameters<typeof reconcileAgentsWith>
  ): Promise<void> {
    return reconcileAgentsWith.call(this.reconcileHost(), ...args);
  }

  private reconcileHostCache: ReconcileHost | null = null;

  /** The members ./engine/reconcile.ts needs, as live getters and forwarders. */
  private reconcileHost(): ReconcileHost {
    if (this.reconcileHostCache) return this.reconcileHostCache;
    const engine = this;
    this.reconcileHostCache = {
      get registry() { return engine.registry; },
      get sidebarSnapshot() { return engine.sidebarSnapshot; },
      get client() { return engine.client; },
      get stateMgr() { return engine.stateMgr; },
      get cliExitShellMatches() { return engine.cliExitShellMatches; },
      get monitorRegistryPath() { return engine.monitorRegistryPath; },
      get inboxOpts() { return engine.inboxOpts; },
      get lifecycleLockQueueDepth() { return engine.lifecycleLockQueueDepth; },
      assertSweepInputCurrent: (...args) => engine.assertSweepInputCurrent(...args),
      assessHarvestability: (...args) => engine.assessHarvestability(...args),
      buildSidebarStatusValue: (...args) => engine.buildSidebarStatusValue(...args),
      clearAgentLifecycleMemory: (...args) => engine.clearAgentLifecycleMemory(...args),
      clearHealthNotificationMemory: (...args) => engine.clearHealthNotificationMemory(...args),
      collectObservedSurfaceTopology: (...args) => engine.collectObservedSurfaceTopology(...args),
      healthSignature: (...args) => engine.healthSignature(...args),
      isKnownClosedSurface: (...args) => engine.isKnownClosedSurface(...args),
      logLifecycleEvent: (...args) => engine.logLifecycleEvent(...args),
      maybeCaptureBootSessionId: (...args) => engine.maybeCaptureBootSessionId(...args),
      maybeEscalateLiveHalt: (...args) => engine.maybeEscalateLiveHalt(...args),
      maybeMarkBootReady: (...args) => engine.maybeMarkBootReady(...args),
      maybeMarkCliExited: (...args) => engine.maybeMarkCliExited(...args),
      maybeMarkTaskDone: (...args) => engine.maybeMarkTaskDone(...args),
      maybeNotifyLeadMonitorDeath: (...args) => engine.maybeNotifyLeadMonitorDeath(...args),
      notifyLifecycleEventForSweep: (...args) => engine.notifyLifecycleEventForSweep(...args),
      publishSweepStatus: (...args) => engine.publishSweepStatus(...args),
      readSweepScreen: (...args) => engine.readSweepScreen(...args),
      resolveAgentIoRoute: (...args) => engine.resolveAgentIoRoute(...args),
      resolveUnchangedAgentIoRoute: (...args) => engine.resolveUnchangedAgentIoRoute(...args),
      shouldNotifyDone: (...args) => engine.shouldNotifyDone(...args),
      shouldNotifyHealthChange: (...args) => engine.shouldNotifyHealthChange(...args),
      stableSurfaceWriteOptions: (...args) => engine.stableSurfaceWriteOptions(...args),
      sweepReadMatchesBinding: (...args) => engine.sweepReadMatchesBinding(...args),
    };
    return this.reconcileHostCache;
  }

  /** Whether a startup purge is pending (opt-in via enableStartupPurge) */
  private startupPurgePending = false;
  private startupPurgeRetainedAgentIds = new Set<string>();

  /**
   * Enable startup purge on the next sweep. Call after reconstitute()
   * to clear stale terminal-state agents from previous cmux sessions.
   */
  enableStartupPurge(
    opts: { retainAgentIds?: ReadonlySet<string> } = {},
  ): void {
    this.startupPurgePending = true;
    this.startupPurgeRetainedAgentIds = new Set(opts.retainAgentIds ?? []);
  }

  /**
   * Restore the two-column role contract without ever taking authority over an
   * operator-created surface. Provenance authorizes the source mutation;
   * stable UUID + observer evidence authorizes the current binding.
   */
  async reconcileRolePlacements(
    trigger: RolePlacementReconcileTrigger,
    opts: {
      agentIds?: ReadonlySet<string>;
      surfaceTopology?: SurfaceTopologySnapshot | null;
      sweepContext?: SweepAgentContext;
    } = {},
  ): Promise<RolePlacementReconcileSummary> {
    if (!this.assertSweepInputCurrent(opts.sweepContext ?? {})) {
      return { moved: [], skipped: [] };
    }
    const summary: RolePlacementReconcileSummary = { moved: [], skipped: [] };
    const eligibleForTrigger = (agent: AgentRecord): boolean => {
      if (agent.surface_provenance !== "cmuxlayer_spawn") return false;
      if (trigger === "spawn") {
        // Spawn reconciliation runs synchronously after registry persistence
        // and before the launch command is sent, so membership is sufficient:
        // this new agent cannot have entered a working state yet.
        return opts.agentIds?.has(agent.agent_id) ?? false;
      }
      if (trigger === "idle") return agent.state === "idle";
      return agent.state === "idle" || TERMINAL_STATES.has(agent.state);
    };
    const candidates = this.registry.list().filter((agent) => {
      if (opts.agentIds && !opts.agentIds.has(agent.agent_id)) return false;
      if (!eligibleForTrigger(agent)) return false;
      if (inferRecordRoleOrNull(agent) === null) {
        return false;
      }
      return true;
    });

    for (const agent of candidates) {
      const role = inferRecordRoleOrNull(agent);
      if (!role) continue;
      const targetColumn = canonicalRoleColumn(role);
      if (targetColumn === null) continue;
      if (!agent.surface_uuid || !agent.workspace_id) {
        summary.skipped.push({
          agent_id: agent.agent_id,
          surface_id: agent.surface_id,
          reason: "stable surface UUID and workspace are required",
        });
        continue;
      }

      // The sweep already owns one complete topology observation. If it proves
      // this seat is in the canonical column, avoid enumerating the workspace
      // again. A misplaced or inconclusive seat still takes the existing fresh
      // mutation-guard path below.
      const sweepBinding = resolveAgentSurfaceBinding(
        agent,
        opts.surfaceTopology ?? null,
      );
      if (
        sweepBinding?.provenance === "uuid" &&
        opts.surfaceTopology?.topologyBySurface.get(sweepBinding.surfaceRef)
          ?.column === targetColumn
      ) {
        continue;
      }

      const observerEpoch = this.captureSurfaceObserverEpoch();
      try {
        const assertFreshAgentBinding = async (
          expectedSurfaceRef: string,
          operation: string,
        ): Promise<void> => {
          if (!this.assertSweepInputCurrent(opts.sweepContext ?? {})) {
            throw new Error("sweep input changed before role placement");
          }
          this.assertSurfaceObserverEpochCurrent(observerEpoch, operation);
          const current =
            this.registry.get(agent.agent_id) ??
            this.stateMgr.readState(agent.agent_id);
          if (
            !current ||
            !eligibleForTrigger(current) ||
            current.surface_uuid?.trim().toLowerCase() !==
              agent.surface_uuid?.trim().toLowerCase() ||
            (current.workspace_id ?? null) !== (agent.workspace_id ?? null)
          ) {
            throw new Error(
              "agent provenance, state, or stable binding changed before mutation",
            );
          }
          const topology = await this.collectFreshObservedSurfaceTopology();
          this.assertSurfaceObserverEpochCurrent(observerEpoch, operation);
          if (!topology?.complete) {
            throw new Error("fresh stable UUID topology is incomplete");
          }
          const binding = resolveAgentSurfaceBinding(current, topology);
          const workspace = binding
            ? (topology.workspaceBySurface.get(binding.surfaceRef) ??
              binding.workspaceId)
            : null;
          const observedUuid = binding
            ? (topology.surfaceIdByRef.get(binding.surfaceRef) ?? null)
            : null;
          if (
            !binding ||
            binding.provenance !== "uuid" ||
            binding.surfaceRef !== expectedSurfaceRef ||
            workspace !== agent.workspace_id ||
            !this.registry.canUseObservedBinding(current, observedUuid)
          ) {
            throw new Error(
              "spawned surface UUID is no longer uniquely bound before mutation",
            );
          }
          const latest =
            this.registry.get(agent.agent_id) ??
            this.stateMgr.readState(agent.agent_id);
          if (!latest || !eligibleForTrigger(latest)) {
            throw new Error("agent became busy before role placement mutation");
          }
          if (!this.assertSweepInputCurrent(opts.sweepContext ?? {})) {
            throw new Error("sweep input changed before role placement");
          }
        };

        this.assertSurfaceObserverEpochCurrent(observerEpoch, "role placement");
        const panes = await this.client.listPanes({
          workspace: agent.workspace_id,
        });
        const rawPaneSurfaces = await Promise.all(
          panes.panes.map(async (pane) => {
            const observed = await this.client.listPaneSurfaces({
              workspace: agent.workspace_id ?? undefined,
              pane: pane.ref,
            });
            return observed.pane_ref
              ? observed
              : { ...observed, pane_ref: pane.ref };
          }),
        );
        this.assertSurfaceObserverEpochCurrent(observerEpoch, "role placement");
        const paneSurfaces = partitionPaneSurfacesByMembership(
          panes.panes,
          rawPaneSurfaces,
          {
            workspace_ref: panes.workspace_ref ?? agent.workspace_id,
            window_ref: panes.window_ref,
          },
        );
        if (!isPaneSurfaceEnumerationComplete(panes.panes, paneSurfaces)) {
          throw new Error("pane surface enumeration is incomplete");
        }
        const observation = buildSurfaceBindingObservation(
          panes.panes,
          paneSurfaces,
        );
        if (observation.coverage !== "uuid") {
          throw new Error(
            "stable UUID topology is incomplete or contradictory",
          );
        }
        const sourceRef = resolveObservedAgentSurfaceRef(agent, observation);
        const observedUuid = sourceRef
          ? observation.surfaceUuidByRef.get(sourceRef)
          : null;
        if (
          !sourceRef ||
          !this.registry.canUseObservedBinding(agent, observedUuid)
        ) {
          throw new Error("spawned surface is not uniquely bound");
        }
        const sourcePane = paneSurfaces.find((pane) =>
          pane.surfaces.some((surface) => surface.ref === sourceRef),
        )?.pane_ref;
        const columnByPane = deriveRoleColumnIndex(panes.panes);
        const fromColumn = sourcePane
          ? columnByPane.get(sourcePane)
          : undefined;
        if (fromColumn === undefined) {
          throw new Error("spawned surface pane is not observable");
        }
        if (fromColumn === targetColumn) continue;

        let targetPane = topPaneInRoleColumn(panes.panes, role)?.ref ?? null;
        let seed: CmuxNewSplitResult | null = null;
        if (!targetPane && role === "worker") {
          const leadPane = topPaneInRoleColumn(panes.panes, "orchestrator");
          if (!leadPane) {
            throw new Error("column 0 anchor is unavailable");
          }
          const createdSeed = await this.client.newSplit("right", {
            pane: leadPane.ref,
            surface: sourceRef,
            workspace: agent.workspace_id,
            type: "terminal",
            stableSurfaceIdentity: agent.surface_uuid,
            beforeMutation: () =>
              assertFreshAgentBinding(sourceRef, "worker-column seed"),
          });
          this.invalidateSweepTopologyGeneration();
          this.assertSurfaceObserverEpochCurrent(
            observerEpoch,
            "role placement",
          );
          if (
            createdSeed.surface === sourceRef ||
            (createdSeed.surface_id ?? null) === agent.surface_uuid
          ) {
            throw new Error(
              "worker-column seed collided with the spawned surface binding",
            );
          }
          seed = createdSeed;
          targetPane = seed.pane;
        }
        if (!targetPane) {
          throw new Error(`canonical column ${targetColumn} is unavailable`);
        }

        try {
          this.assertSurfaceObserverEpochCurrent(
            observerEpoch,
            "role placement",
          );
          await this.client.moveSurface({
            surface: sourceRef,
            pane: targetPane,
            workspace: agent.workspace_id,
            focus: false,
            stableSurfaceIdentity: agent.surface_uuid,
            beforeMutation: () =>
              assertFreshAgentBinding(sourceRef, "role placement move"),
          });
          this.invalidateSweepTopologyGeneration();
          summary.moved.push({
            agent_id: agent.agent_id,
            surface_id: sourceRef,
            from_column: fromColumn,
            to_column: targetColumn,
            pane: targetPane,
          });
          this.assertSurfaceObserverEpochCurrent(
            observerEpoch,
            "role placement",
          );
        } finally {
          if (seed) {
            if (!seed.surface_id) {
              throw new Error(
                "worker-column seed has no stable UUID; refusing cleanup by mutable ref",
              );
            }
            const seedTopology =
              await this.collectFreshObservedSurfaceTopology();
            const seedBinding = seedTopology?.complete
              ? resolveAgentSurfaceBinding(
                  {
                    surface_id: seed.surface,
                    surface_uuid: seed.surface_id,
                  },
                  seedTopology,
                )
              : null;
            if (!seedBinding || seedBinding.provenance !== "uuid") {
              throw new Error(
                `worker-column seed UUID ${seed.surface_id} is no longer uniquely bound; refusing cleanup`,
              );
            }
            await this.client.closeSurface(seedBinding.surfaceRef, {
              workspace: seedBinding.workspaceId ?? seed.workspace,
              stableSurfaceIdentity: seed.surface_id,
              beforeMutation: async () => {
                this.assertSurfaceObserverEpochCurrent(
                  observerEpoch,
                  "role placement seed cleanup",
                );
                const freshSeedTopology =
                  await this.collectFreshObservedSurfaceTopology();
                this.assertSurfaceObserverEpochCurrent(
                  observerEpoch,
                  "role placement seed cleanup",
                );
                const freshSeedBinding = freshSeedTopology?.complete
                  ? resolveAgentSurfaceBinding(
                      {
                        surface_id: seed.surface,
                        surface_uuid: seed.surface_id,
                      },
                      freshSeedTopology,
                    )
                  : null;
                if (
                  !freshSeedBinding ||
                  freshSeedBinding.provenance !== "uuid" ||
                  freshSeedBinding.surfaceRef !== seedBinding.surfaceRef
                ) {
                  throw new Error(
                    "worker-column seed binding changed before cleanup",
                  );
                }
              },
            });
          }
        }
      } catch (error) {
        if (summary.moved.some((moved) => moved.agent_id === agent.agent_id)) {
          // Seed cleanup is best-effort and must not overwrite a completed move
          // by counting the same agent as skipped as well.
          continue;
        }
        summary.skipped.push({
          agent_id: agent.agent_id,
          surface_id: agent.surface_id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return summary;
  }

  /**
   * Initialize lifecycle state exactly once for a fresh runtime connection.
   * Reconstitution and one additive discovery complete before the immediate
   * reconcile, so a fresh process cannot publish an empty first paint.
   */
  initialize(discovery: AgentDiscovery): Promise<void> {
    if (this.startupInitializePromise === null) {
      this.startupInitializePromise = this.initializeOnce(discovery);
    }
    return this.startupInitializePromise;
  }

  private async initializeOnce(discovery: AgentDiscovery): Promise<void> {
    const newlySurfacelessAgentIds = await this.registry.reconstitute({
      confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
      now: Date.now(),
    });
    for (const record of [...this.registry.list()]) {
      if (!record.agent_id.includes("-pending-") || !record.cli_session_id) {
        continue;
      }
      const finalized = this.finalizeCapturedSession(record, {
        session_id: record.cli_session_id,
        path: record.cli_session_path ?? null,
      });
      if (newlySurfacelessAgentIds.delete(record.agent_id)) {
        newlySurfacelessAgentIds.add(finalized.agent_id);
      }
    }
    await this.retryClosedChildReportWatchPrune();
    const discovered = await discovery.scan(true);
    await this.registry.listMerged(discovery, {
      force: true,
      discovered,
      nonDestructive: true,
    });
    for (const record of this.registry.list()) {
      if (record.agent_id.startsWith("auto-")) continue;
      const persistedUuid = record.surface_uuid?.trim().toLowerCase() ?? null;
      const liveManagedSurface = discovered.some((entry) => {
        if (!entry.has_agent || entry.read_error) return false;
        const observedUuid = entry.surface_uuid?.trim().toLowerCase() ?? null;
        const sameSurface = Boolean(
          persistedUuid && observedUuid === persistedUuid,
        );
        return (
          sameSurface &&
          this.registry.canUseObservedBinding(record, entry.surface_uuid)
        );
      });
      if (liveManagedSurface) {
        newlySurfacelessAgentIds.add(record.agent_id);
      }
    }
    this.enableStartupPurge({ retainAgentIds: newlySurfacelessAgentIds });
    // Missing legacy provenance is intentionally equivalent to "unknown".
    // Do not rewrite those records at boot: changing updated_at would distort
    // lifecycle age and ghost-eviction evidence.
    await this.reconcileRolePlacements("boot");
    try {
      await this.reconcileAgents({ firstConnect: true });
    } catch {
      // The first-connect reconcile is auxiliary. Boot placement may go live
      // once registry ingestion and the provenance-gated sweep have completed.
    }
  }

  /**
   * A daemon restart must not re-arm watches whose owner is confirmed dead, or
   * report watches whose child is already closed or no longer belongs to the
   * recorded parent. Owner aliases use delivery-style exact/seat/prefix
   * resolution and retain on zero or multiple matches. New report rows carry
   * subject_agent_id; legacy rows are pruned only when their target exactly
   * matches a persisted child's engine-issued report_path.
   */
  private async pruneClosedChildReportWatches(): Promise<boolean> {
    if (!this.watchRegistryPath) return false;
    const agents = this.registry.list();
    const pruneObservedAt = this.watchRegistryNow?.() ?? Date.now();
    const persistedAgents = this.stateMgr.listStates();
    const byReportPath = new Map<string, AgentRecord[]>();
    for (const agent of agents) {
      if (!agent.report_path) continue;
      const path = resolve(agent.report_path);
      byReportPath.set(path, [...(byReportPath.get(path) ?? []), agent]);
    }
    const persistedWatches = readWatchRegistry({
      registryPath: this.watchRegistryPath,
    }).watches;
    const persistedWatchSnapshots = new Map(
      persistedWatches.map((watch) => [watch.watch_id, JSON.stringify(watch)]),
    );
    const subjectIdsByWatch = new Map<string, string[]>();
    const missingLegacyStateWatchIds = new Set<string>();
    const channelBaseDir = resolve(
      dirname(agentDir("__cmuxlayer_channel_probe__", this.inboxOpts)),
    );
    for (const watch of persistedWatches) {
      if (watch.target_kind !== "file" || watch.change !== "content") continue;
      let subjects = watch.subject_agent_id
        ? [
            this.registry.get(watch.subject_agent_id) ??
              this.stateMgr.readState(watch.subject_agent_id),
          ].filter((subject): subject is AgentRecord => Boolean(subject))
        : (byReportPath.get(resolve(watch.target)) ?? []);
      if (subjects.length === 0 && !watch.subject_agent_id) {
        const targetDir = resolve(dirname(watch.target));
        // Provenance-absent rows are legacy engine watches only inside the
        // exact <channelBaseDir>/<agentId>/report.md shape. Arbitrary public
        // file watches from before provenance existed must never enter it.
        const targetLooksEngineIssued =
          basename(watch.target) === "report.md" &&
          resolve(dirname(targetDir)) === channelBaseDir;
        if (targetLooksEngineIssued) {
          const inferredAgentId = basename(targetDir);
          const inferred =
            this.registry.get(inferredAgentId) ??
            this.stateMgr.readState(inferredAgentId);
          if (inferred) subjects = [inferred];
          else if (!this.stateMgr.hasStateFile(inferredAgentId)) {
            missingLegacyStateWatchIds.add(watch.watch_id);
          }
        }
      }
      subjectIdsByWatch.set(watch.watch_id, [
        ...new Set(subjects.map((subject) => subject.agent_id)),
      ]);
    }
    const ownerResolutionByWatch = new Map<
      string,
      WatchOwnerResolution<AgentRecord>
    >();
    for (const watch of persistedWatches) {
      ownerResolutionByWatch.set(
        watch.watch_id,
        resolveWatchOwnerFromSources(
          watchRecordOwner(watch),
          agents,
          persistedAgents,
        ),
      );
    }
    const liveAgentIds = new Set<string>();
    const candidateAgentIds = new Set([
      ...[...subjectIdsByWatch.values()].flat(),
      ...[...ownerResolutionByWatch.values()].flatMap((resolution) =>
        resolution.canonical_id
          ? [canonicalAgentIdValue(resolution.canonical_id)]
          : [],
      ),
    ]);
    await Promise.all(
      [...candidateAgentIds].map(async (agentId) => {
        const subject =
          this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
        if (
          subject &&
          subject.user_killed !== true &&
          !subject.deletion_intent &&
          (await this.registry.isSurfaceAlive(subject))
        ) {
          liveAgentIds.add(agentId);
        }
      }),
    );
    let retainedNeedsRecheck = false;
    await removeWatches(
      (watch) => {
        if (watch.notification_pending) {
          retainedNeedsRecheck = true;
          return false;
        }
        if (isInterruptedEngineDeadlineClaim(watch)) {
          retainedNeedsRecheck = true;
          return false;
        }
        // The predicate runs under the watch-registry write lock. If a sweep
        // changed this row after our snapshot, retain it for the next prune.
        if (
          persistedWatchSnapshots.get(watch.watch_id) !== JSON.stringify(watch)
        ) {
          retainedNeedsRecheck = true;
          return false;
        }
        if (watch.state === "failed" && !watch.notification_pending) {
          return (watch.waiter_expires_at_ms ?? 0) <= pruneObservedAt;
        }
        const ownerResolution = ownerResolutionByWatch.get(watch.watch_id);
        // Raw owner keys are not identities. Zero and multiple matches retain
        // fail-safe; a subject can still prove that an ambiguous alias includes
        // its canonical parent, but ambiguity cannot authorize deletion.
        if (!ownerResolution) return false;
        const subjects = (subjectIdsByWatch.get(watch.watch_id) ?? [])
          .map(
            (subjectAgentId) =>
              this.registry.get(subjectAgentId) ??
              this.stateMgr.readState(subjectAgentId),
          )
          .filter((subject): subject is AgentRecord => Boolean(subject));
        const hasActiveSubjectOwnership = subjects.some(
          (subject) =>
            subject.user_killed !== true &&
            !subject.deletion_intent &&
            (!TERMINAL_STATES.has(subject.state) ||
              liveAgentIds.has(subject.agent_id)) &&
            Boolean(
              subject.parent_agent_id &&
                watchOwnerIncludesCanonical(
                  ownerResolution,
                  canonicalAgentId(subject.parent_agent_id),
                ),
            ),
        );
        const ownerAgentId = ownerResolution.canonical_id
          ? canonicalAgentIdValue(ownerResolution.canonical_id)
          : null;
        const ownerRecord = ownerAgentId
          ? (this.registry.get(ownerAgentId) ??
            this.stateMgr.readState(ownerAgentId))
          : null;
        // A live child still owns its report path even if its parent pane is
        // gone. Preserve that reservation; dead-owner pruning is destructive
        // only when no active subject ownership remains.
        if (
          ownerRecord &&
          ownerAgentId &&
          !liveAgentIds.has(ownerAgentId) &&
          (ownerRecord.user_killed === true ||
            Boolean(ownerRecord.deletion_intent) ||
            TERMINAL_STATES.has(ownerRecord.state)) &&
          !hasActiveSubjectOwnership
        ) {
          return true;
        }
        // Owner death and subject death answer different questions. A
        // confirmed-dead owner makes every watch kind undeliverable, including
        // marker and agent watches. Subject-side lifecycle pruning is narrower
        // and may only inspect report-content rows.
        if (!isSubjectSideReportWatchPruneEligible(watch)) return false;
        if (
          subjects.length === 0 &&
          missingLegacyStateWatchIds.has(watch.watch_id)
        ) {
          return true;
        }
        if (subjects.length === 0) return Boolean(watch.subject_agent_id);
        if (ownerResolution.kind !== "resolved") return false;
        return !hasActiveSubjectOwnership;
      },
      { registryPath: this.watchRegistryPath },
    );
    return retainedNeedsRecheck;
  }

  scheduleClosedChildReportWatchPrune(): void {
    if (this.watchRegistryPath) this.childReportWatchPrunePending = true;
  }

  private async retryClosedChildReportWatchPrune(): Promise<void> {
    if (!this.childReportWatchPrunePending) return;
    this.childReportWatchPrunePending = false;
    try {
      if (await this.pruneClosedChildReportWatches()) {
        this.childReportWatchPrunePending = true;
      }
    } catch (error) {
      this.childReportWatchPrunePending = true;
      this.sweepDebugLog(
        `[cmuxlayer] child report watch prune deferred: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async purgeStartupTerminalAgents(
    ctx: SweepAgentContext = {},
  ): Promise<void> {
    if (!this.assertSweepInputCurrent(ctx)) return;
    if (!this.startupPurgePending) return;
    this.startupPurgePending = false;
    const retainedAgentIds = new Set(this.startupPurgeRetainedAgentIds);
    for (const agent of this.registry.list()) {
      if (agent.transcript_session_capture_deferred === true) {
        retainedAgentIds.add(agent.agent_id);
      }
    }
    const purgedIds = this.registry.purgeAllTerminal({
      retainAgentIds: retainedAgentIds,
    });
    this.startupPurgeRetainedAgentIds.clear();
    try {
      await this.client.clearProgress();
    } catch {
      // Best-effort cleanup of the removed workspace-less progress row.
    }
    // Seed sidebar snapshot so reconcileAgents clears their cmux entries.
    for (const purgedAgent of purgedIds) {
      this.sidebarSnapshot.set(purgedAgent.agent_id, {
        statusValue: "__purged__",
        surfaceId: purgedAgent.surface_id,
        workspaceId: purgedAgent.workspace_id ?? null,
        healthSignature: "__purged__",
      });
    }
  }

  private async evictSurfacelessForSweep(
    ctx: SweepAgentContext,
    observed: Parameters<AgentRegistry["evictSurfaceless"]>[0],
  ): Promise<void> {
    if (!this.assertSweepInputCurrent(ctx)) return;
    await this.registry.evictSurfaceless(observed);
  }

  private async purgeTerminalForSweep(
    ctx: SweepAgentContext,
    observed: Parameters<AgentRegistry["purgeTerminal"]>[0],
  ): Promise<void> {
    if (!this.assertSweepInputCurrent(ctx)) return;
    await this.registry.purgeTerminal(observed);
  }

  private removeStateForSweep(
    ctx: SweepAgentContext,
    agentId: string,
  ): boolean {
    if (!this.assertSweepInputCurrent(ctx)) return false;
    this.stateMgr.removeState(agentId);
    return true;
  }

  /**
   * Public sweep: reconcile registry, purge dead entries, then reconcile agents.
   * If enableStartupPurge() was called, the first sweep also purges terminal
   * records carried over from the previous cmux session while retaining any
   * records that this startup's own topology scan just marked surfaceless.
   */
  /**
   * Serialize a lifecycle mutation behind a BOUNDED mutex.
   *
   * #529: both waits used to be unbounded. `await previous` queued every later
   * caller behind a hung holder forever, and an `operation()` that never
   * settled never reached its `finally`, so `release()` never fired and the
   * tail stayed poisoned for the life of the process — `list_agents` and
   * `spawn_agent` deadlocked from cold. Now the acquire is bounded and fails
   * fast with a structured error naming the holder, and this call's tail slot
   * is released unconditionally: on acquire timeout, on operation settle, and
   * by a hold guard if the operation never settles at all.
   */
  async runLifecycleMutation<T>(
    operation: (
      withUnlocked: <U>(work: () => Promise<U>) => Promise<U>,
    ) => Promise<T>,
    opts?: { label?: string },
  ): Promise<T> {
    const label = opts?.label ?? "lifecycle-mutation";
    let releaseHeld: (() => void) | null = null;
    const acquire = async (): Promise<void> => {
      const previous = this.lifecycleMutationTail;
      let released = false;
      let resolveTail!: () => void;
      const tail = new Promise<void>((resolve) => {
        resolveTail = resolve;
      });
      const release = () => {
        if (released) return;
        released = true;
        resolveTail();
      };
      this.lifecycleMutationTail = tail;
      const waitStartedAt = Date.now();
      this.lifecycleLockQueueDepth += 1;
      const benchmarkSweepStatePath =
        process.env.CMUXLAYER_BENCH_SWEEP_HOLD_STATE?.trim() ?? "";
      if (benchmarkSweepStatePath && label === "close-agent") {
        try {
          const benchmarkState = JSON.parse(
            readFileSync(benchmarkSweepStatePath, "utf8"),
          ) as Record<string, unknown>;
          if (benchmarkState.state === "held") {
            writeFileSync(
              benchmarkSweepStatePath,
              JSON.stringify({ ...benchmarkState, waiter: label }),
            );
          }
        } catch {
          // Benchmark-only evidence may race its own atomic state transitions.
        }
      }
      try {
        await this.awaitLifecycleLock(previous, label, waitStartedAt);
      } catch (error) {
        // A timed-out slot must remain chained behind its live predecessor.
        void previous.then(release, release);
        throw error;
      } finally {
        this.lifecycleLockQueueDepth = Math.max(
          0,
          this.lifecycleLockQueueDepth - 1,
        );
      }

      const acquisitionId = ++this.lifecycleLockAcquisitionSeq;
      this.lifecycleLockHolder = label;
      this.lifecycleLockAcquisitionId = acquisitionId;
      this.lifecycleLockAcquiredAtMs = Date.now();
      const holdGuard =
        this.lifecycleLockHoldTimeoutMs > 0
          ? setTimeout(() => {
              if (released) return;
              this.lifecycleLockForcedReleases += 1;
              console.error(
                `[cmuxlayer] lifecycle lock force-released after ${this.lifecycleLockHoldTimeoutMs}ms; holder="${label}" never settled`,
              );
              release();
            }, this.lifecycleLockHoldTimeoutMs)
          : null;
      holdGuard?.unref?.();
      releaseHeld = () => {
        if (holdGuard) clearTimeout(holdGuard);
        if (this.lifecycleLockAcquisitionId === acquisitionId) {
          this.lifecycleLockHolder = null;
          this.lifecycleLockAcquisitionId = null;
          this.lifecycleLockAcquiredAtMs = null;
        }
        release();
        releaseHeld = null;
      };
    };

    await acquire();
    const withUnlocked = async <U>(work: () => Promise<U>): Promise<U> => {
      if (!releaseHeld) throw new Error("lifecycle lock is not held");
      releaseHeld();
      try {
        return await work();
      } finally {
        // Enqueue only after the I/O finishes: callers arriving during it must
        // be able to acquire the genuinely free lock without waiting on this read.
        try {
          await acquire();
        } catch (error) {
          throw new LifecycleLockReacquireError(error);
        }
      }
    };
    try {
      return await operation(withUnlocked);
    } finally {
      const release = releaseHeld as (() => void) | null;
      release?.();
    }
  }

  private async awaitLifecycleLock(
    previous: Promise<void>,
    waiter: string,
    waitStartedAt: number,
  ): Promise<void> {
    if (this.lifecycleLockAcquireTimeoutMs <= 0) {
      await previous;
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        previous,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const record: LifecycleLockTimeoutRecord = {
              holder: this.lifecycleLockHolder,
              waiter,
              waited_ms: Date.now() - waitStartedAt,
              held_for_ms:
                this.lifecycleLockAcquiredAtMs === null
                  ? null
                  : Date.now() - this.lifecycleLockAcquiredAtMs,
              queue_depth: this.lifecycleLockQueueDepth,
              at: new Date().toISOString(),
            };
            this.lifecycleLockTimeouts += 1;
            this.lifecycleLockLastTimeout = record;
            reject(
              new LifecycleLockTimeoutError({
                holder: record.holder,
                waiter,
                waitedMs: record.waited_ms,
                heldForMs: record.held_for_ms,
                queueDepth: record.queue_depth,
              }),
            );
          }, this.lifecycleLockAcquireTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Lifecycle-lock truth for `control_health` — holder, age, queue depth. */
  lifecycleLockState(): LifecycleLockState {
    return {
      holder: this.lifecycleLockHolder,
      held_for_ms:
        this.lifecycleLockAcquiredAtMs === null
          ? null
          : Date.now() - this.lifecycleLockAcquiredAtMs,
      queue_depth: this.lifecycleLockQueueDepth,
      acquire_timeout_ms: this.lifecycleLockAcquireTimeoutMs,
      hold_timeout_ms: this.lifecycleLockHoldTimeoutMs,
      forced_releases: this.lifecycleLockForcedReleases,
      sweep_skipped_mutations: this.sweepSkippedMutations,
      sweep_skipped_reason: this.sweepSkippedReason,
      sweep_yielded: this.sweepYielded,
      timeouts: this.lifecycleLockTimeouts,
      last_timeout: this.lifecycleLockLastTimeout,
    };
  }

  /** Internal revision for rejecting I/O snapshots after the lock was lent. */
  lifecycleLockRevision(): number {
    return this.lifecycleLockAcquisitionSeq;
  }

  async runSweep(): Promise<void> {
    await this.runLifecycleMutation(async (withUnlocked) => {
      const benchmarkHoldToken = await this.holdBenchmarkSweepIfArmed();
      try {
        await this.runSweepOnce(withUnlocked);
      } finally {
        // AIDEV-NOTE: #791 — the benchmark's warm send waits for "complete".
        // Reporting it before the released sweep body ran put every warm
        // sample inside a live sweep. Still inside the lock, so the
        // close-during-sweep waiter's timing is unchanged.
        if (benchmarkHoldToken) this.completeBenchmarkSweepHold(benchmarkHoldToken);
      }
    }, {
      label: "sweep",
    });
    await this.drainDeliveryQueue();
    await this.verifyPendingDeliveries();
  }

  private completeBenchmarkSweepHold(token: string): void {
    const statePath =
      process.env.CMUXLAYER_BENCH_SWEEP_HOLD_STATE?.trim() ?? "";
    if (!statePath) return;
    writeFileSync(statePath, JSON.stringify({ token, state: "complete" }));
  }

  private async holdBenchmarkSweepIfArmed(): Promise<string | null> {
    const statePath =
      process.env.CMUXLAYER_BENCH_SWEEP_HOLD_STATE?.trim() ?? "";
    if (!statePath) return null;

    let armed: { token?: unknown; state?: unknown };
    try {
      armed = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return null;
    }
    if (armed.state !== "armed" || typeof armed.token !== "string") return null;

    const token = armed.token;
    writeFileSync(statePath, JSON.stringify({ token, state: "held" }));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const current = JSON.parse(readFileSync(statePath, "utf8"));
        if (current.token === token && current.state === "release") {
          return token;
        }
      } catch {
        // The benchmark owns this opt-in state file and may be between writes.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error(`benchmark lifecycle sweep hold timed out: ${token}`);
  }

  // Delivery queue: thin delegates to ./engine/delivery-queue.ts (CX-3 E4).

  setDeliverySubmitter(submitter: DeliverySubmitter | null): void {
    this.deliveryQueue.setDeliverySubmitter(submitter);
  }

  setDeliveryVerifier(verifier: DeliveryVerifier | null): void {
    this.deliveryQueue.setDeliveryVerifier(verifier);
  }

  setDeliverySnapshotReader(reader: DeliverySnapshotReader | null): void {
    this.deliveryQueue.setDeliverySnapshotReader(reader);
  }

  setDeliveryIssueFiler(filer: DeliveryIssueFiler | null): void {
    this.deliveryQueue.setDeliveryIssueFiler(filer);
  }

  queueDelivery(
    ...args: Parameters<DeliveryQueue["queueDelivery"]>
  ): AgentDeliveryReceipt {
    return this.deliveryQueue.queueDelivery(...args);
  }

  registerExternalDelivery(
    ...args: Parameters<DeliveryQueue["registerExternalDelivery"]>
  ): AgentDeliveryReceipt {
    return this.deliveryQueue.registerExternalDelivery(...args);
  }

  acceptComposerQueue(
    ...args: Parameters<DeliveryQueue["acceptComposerQueue"]>
  ): AgentDeliveryReceipt {
    return this.deliveryQueue.acceptComposerQueue(...args);
  }

  resolveDelivery(
    ...args: Parameters<DeliveryQueue["resolveDelivery"]>
  ): AgentDeliveryReceipt {
    return this.deliveryQueue.resolveDelivery(...args);
  }

  getDeliveryReceipt(
    ...args: Parameters<DeliveryQueue["getDeliveryReceipt"]>
  ): AgentDeliveryReceipt | null {
    return this.deliveryQueue.getDeliveryReceipt(...args);
  }

  listDeliveryReceipts(
    ...args: Parameters<DeliveryQueue["listDeliveryReceipts"]>
  ): AgentDeliveryReceipt[] {
    return this.deliveryQueue.listDeliveryReceipts(...args);
  }

  findOpenDuplicate(
    ...args: Parameters<DeliveryQueue["findOpenDuplicate"]>
  ): AgentDeliveryReceipt | null {
    return this.deliveryQueue.findOpenDuplicate(...args);
  }

  acceptPendingVerify(
    ...args: Parameters<DeliveryQueue["acceptPendingVerify"]>
  ): AgentDeliveryReceipt {
    return this.deliveryQueue.acceptPendingVerify(...args);
  }

  waitForDelivery(
    ...args: Parameters<DeliveryQueue["waitForDelivery"]>
  ): Promise<AgentDeliveryReceipt & { timed_out?: boolean }> {
    return this.deliveryQueue.waitForDelivery(...args);
  }

  verifyPendingDeliveries(
    ...args: Parameters<DeliveryQueue["verifyPendingDeliveries"]>
  ): Promise<void> {
    return this.deliveryQueue.verifyPendingDeliveries(...args);
  }

  drainDeliveryQueue(
    ...args: Parameters<DeliveryQueue["drainDeliveryQueue"]>
  ): Promise<void> {
    return this.deliveryQueue.drainDeliveryQueue(...args);
  }

  private async runSweepOnce(
    withUnlocked: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    this.sweepBackgroundProcessSnapshot = null;
    const timings: Record<string, number> = {};
    const sweepStartedAt = Date.now();
    const sweepId = ++this.sweepTelemetrySeq;
    let sweepCompleted = false;
    let failedPhase: string | null = null;
    const slowPhaseThresholdMs = 250;
    const time = async <T>(
      name: string,
      operation: () => Promise<T>,
      lockHeldOverride?: boolean,
    ) => {
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();
      const agentCount = this.registry.list().length;
      const lockHeld =
        lockHeldOverride ?? (name !== "reconcile_ms" && this.lifecycleLockHolder === "sweep");
      const appendPhase = (
        stage: "started" | "completed" | "failed",
        durationMs: number | null,
      ) => {
        try {
          this.stateMgr.getEventLog().appendSweepPhase({
            ts: new Date().toISOString(),
            event_type: "sweep_phase",
            process_id: process.pid,
            sweep_id: sweepId,
            phase: name,
            stage,
            started_at: startedAtIso,
            duration_ms: durationMs,
            agent_count: agentCount,
            lock_held: lockHeld,
          });
        } catch {
          // Telemetry must not block reconciliation when the log is unavailable.
        }
      };
      // Delay the durable in-progress breadcrumb until the phase is actually
      // slow. Fast phases need only the one sweep summary row.
      const slowStartTimer = setTimeout(
        () => appendPhase("started", null),
        slowPhaseThresholdMs,
      );
      slowStartTimer.unref?.();
      try {
        const result = await operation();
        const durationMs = Date.now() - startedAt;
        if (durationMs >= slowPhaseThresholdMs) {
          appendPhase("completed", durationMs);
        }
        return result;
      } catch (error) {
        failedPhase = name;
        appendPhase("failed", Date.now() - startedAt);
        throw error;
      } finally {
        clearTimeout(slowStartTimer);
        timings[name] = Date.now() - startedAt;
      }
    };
    try {
      const skipAccounting: SweepMutationSkipAccounting = { counted: false };
      this.currentSweepScreenSignatures = new Map();
      const surfaceTopology = await time(
        "topology_ms",
        () => withUnlocked(() => this.collectObservedSurfaceTopology()),
        false,
      );
      this.sweepTopologyGeneration += 1;
      if (surfaceTopology) {
        surfaceTopology.generation = this.sweepTopologyGeneration;
      }
      const sweepCtx: SweepAgentContext = {
        sweep: true,
        withUnlocked,
        surfaceTopology,
        topologyGeneration: surfaceTopology?.generation,
        skipAccounting,
      };
      const yieldToWaiters = async (): Promise<void> => {
        if (this.shouldYieldSweep()) {
          await withUnlocked(() => scheduler.yield());
        }
      };
      const transportHealth = getTransportHealth(this.client);
      const topologyIsAuthoritative =
        surfaceTopology?.complete === true &&
        surfaceTopology.surfaces.length > 0;
      const mutationsAreSafe =
        topologyIsAuthoritative &&
        transportHealth?.mode === "socket" &&
        transportHealth.degraded === false;
      if (mutationsAreSafe) {
        this.sweepSkippedMutations = 0;
        this.sweepSkippedReason = null;
      }
      const observedSurfaces = topologyIsAuthoritative
        ? surfaceTopology.surfaces
        : undefined;
      // Reuse the resync path's authoritative-safe ghost eviction on every sweep,
      // but require one confirmation window after the surface is first observed
      // absent. The same gate also applies to terminal worker cleanup below.
      // This absorbs cmux's short post-create topology lag without retaining old
      // ghosts indefinitely. Empty or failed enumeration remains inconclusive.
      const surfacelessConfirmation = {
        confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
        now: Date.now(),
      };
      await time("close_forensics_ms", () =>
        this.runCloseForensicsBestEffort(sweepCtx),
      );
      await yieldToWaiters();
      await time("channel_markers_ms", () =>
        this.reapChannelMarkersBestEffort(),
      );
      await yieldToWaiters();
      if (mutationsAreSafe) {
        const observed = {
          ...surfacelessConfirmation,
          ...(observedSurfaces ? { surfaces: observedSurfaces } : {}),
        };
        if (this.assertSweepInputCurrent(sweepCtx)) {
          await time("registry_reconcile_ms", () =>
            this.registry.reconcile(observed),
          );
        }
        await yieldToWaiters();
        if (this.assertSweepInputCurrent(sweepCtx)) {
          await time("evict_ms", () =>
            this.evictSurfacelessForSweep(sweepCtx, observed),
          );
        }
        await yieldToWaiters();
        if (this.assertSweepInputCurrent(sweepCtx)) {
          await time("startup_purge_ms", () =>
            this.purgeStartupTerminalAgents(sweepCtx),
          );
        }
      } else {
        this.countSkippedSweepTick(skipAccounting, "transport_degraded");
      }

      // Deferred transcript identity does not require a live surface binding.
      // Retry after the one-shot startup purge has retained marked rows, but
      // before normal terminal cleanup can act on a closed pane.
      await time("transcript_ms", () => this.retryDeferredTranscriptCaptures());
      await yieldToWaiters();
      await time("watches_ms", async () => {
        await this.retryClosedChildReportWatchPrune();
        await this.sweepWatchesBestEffort(withUnlocked, sweepCtx);
      });
      await yieldToWaiters();
      if (mutationsAreSafe && this.assertSweepInputCurrent(sweepCtx)) {
        await time("terminal_purge_ms", () =>
          this.purgeTerminalForSweep(sweepCtx, {
            ...surfacelessConfirmation,
            ...(observedSurfaces ? { surfaces: observedSurfaces } : {}),
          }),
        );
      }
      await yieldToWaiters();
      await time("monitors_ms", () => this.sweepMonitorRegistryBestEffort());
      await yieldToWaiters();
      if (mutationsAreSafe && this.assertSweepInputCurrent(sweepCtx)) {
        await time("placements_ms", () =>
          this.reconcileRolePlacements("idle", {
            surfaceTopology,
            sweepContext: sweepCtx,
          }),
        );
      }
      await yieldToWaiters();
      if (!mutationsAreSafe) {
        await time("reconcile_ms", () =>
          this.reconcileAgents({}, null, undefined, sweepCtx),
        );
      } else if (this.assertSweepInputCurrent(sweepCtx)) {
        await time("reconcile_ms", () =>
          this.reconcileAgents(
            {},
            surfaceTopology,
            () => this.assertSweepInputCurrent(sweepCtx),
            sweepCtx,
          ),
        );
      }
      await yieldToWaiters();
      await time("outbox_ms", () => this.drainOutboxBestEffort());
      sweepCompleted = true;
    } finally {
      this.sweepBackgroundProcessSnapshot = null;
      timings.total_ms = Date.now() - sweepStartedAt;
      try {
        this.stateMgr.getEventLog().appendSweepPhase({
          ts: new Date().toISOString(),
          event_type: "sweep_phase",
          process_id: process.pid,
          sweep_id: sweepId,
          phase: "summary",
          stage: sweepCompleted ? "completed" : "failed",
          ...(!sweepCompleted ? { failed_phase: failedPhase ?? "unknown" } : {}),
          started_at: new Date(sweepStartedAt).toISOString(),
          duration_ms: timings.total_ms,
          agent_count: this.registry.list().length,
          lock_held: false,
          durations_ms: timings,
        });
      } catch {
        // Telemetry is best-effort and cannot fail the sweep.
      }
      this.sweepDebugLog(
        `[cmuxlayer] sweep timing ${Object.entries(timings)
          .map(([name, value]) => `${name}=${value}`)
          .join(" ")}`,
      );
    }
  }

  private async reapChannelMarkersBestEffort(): Promise<void> {
    if (!this.inboxOpts) return;
    const now = Date.now();
    if (
      this.lastChannelMarkerReapAt !== null &&
      now - this.lastChannelMarkerReapAt < CHANNEL_MARKER_REAP_INTERVAL_MS
    ) {
      return;
    }
    if (
      this.lastChannelMarkerReapFailureAt !== null &&
      now - this.lastChannelMarkerReapFailureAt < CHANNEL_MARKER_REAP_RETRY_MS
    ) {
      return;
    }
    try {
      const knownAgentIds = new Set([
        ...this.registry.list().map((agent) => agent.agent_id),
        ...this.stateMgr.listStates().map((agent) => agent.agent_id),
      ]);
      const result = reapOrphanedPendingChannelMarkers(knownAgentIds, {
        ...this.inboxOpts,
        now: () => now,
        retentionMs: DEFAULT_CHANNEL_MARKER_RETENTION_MS,
      });
      if (result.errors > 0) {
        this.lastChannelMarkerReapFailureAt = now;
      } else {
        this.lastChannelMarkerReapAt = now;
        this.lastChannelMarkerReapFailureAt = null;
      }
      if (result.reaped > 0 || result.errors > 0) {
        await this.client.log(
          `channel-marker reaper: reaped=${result.reaped} retained_known=${result.retained_known} retained_young=${result.retained_young} errors=${result.errors}`,
          {
            level: result.errors > 0 ? "warning" : "info",
            source: "agent-engine",
          },
        );
      }
    } catch {
      this.lastChannelMarkerReapFailureAt = now;
      // Marker cleanup is maintenance; lifecycle reconciliation must continue.
    }
  }

  /**
   * Ingest cmux's own app-level close events before lifecycle reconciliation.
   * A `tab_close` or `workspace_teardown` carries the operator intent that a
   * matching managed surface is terminal; persist that intent before absence
   * can become a recoverable crash. Forensics remains best-effort and never
   * breaks the sweep.
   */
  private async runCloseForensicsBestEffort(
    ctx: SweepAgentContext,
  ): Promise<void> {
    if (!this.closeForensicsRunner) return;
    if (this.closeForensicsSweepInFlight) return;
    this.closeForensicsSweepInFlight = true;
    try {
      const result = await this.closeForensicsRunner();
      this.markIntentionalSurfaceCloses(result.events, ctx);
    } catch {
      // Never break the sweep on a forensics failure; it retries next sweep.
    } finally {
      this.closeForensicsSweepInFlight = false;
    }
  }

  private markIntentionalSurfaceCloses(
    events: CloseForensicsEvent[],
    ctx: SweepAgentContext,
  ): void {
    if (!this.assertSweepInputCurrent(ctx)) return;
    const closedSurfaceUuids = new Set(
      events
        .filter(
          (event) =>
            (event.origin === "tab_close" ||
              event.origin === "workspace_teardown") &&
            typeof event.cmux_surface_id === "string",
        )
        .map((event) => event.cmux_surface_id!.toLowerCase()),
    );
    if (closedSurfaceUuids.size === 0) return;

    for (const agent of this.registry.list()) {
      const surfaceUuid = agent.surface_uuid?.toLowerCase();
      if (
        !surfaceUuid ||
        !closedSurfaceUuids.has(surfaceUuid) ||
        agent.user_killed === true
      ) {
        continue;
      }
      try {
        const terminal = this.stateMgr.updateRecord(agent.agent_id, {
          user_killed: true,
        });
        this.registry.set(agent.agent_id, terminal);
        this.scheduleClosedChildReportWatchPrune();
      } catch {
        // A concurrently removed record cannot be recovered, so no suppression
        // is needed. Preserve best-effort lifecycle reconciliation.
      }
    }
  }

  private async sweepMonitorRegistryBestEffort(): Promise<void> {
    if (!this.monitorRegistryPath) return;
    if (this.monitorRegistrySweepInFlight) return;
    this.monitorRegistrySweepInFlight = true;
    try {
      await sweepMonitorRegistry({
        registryPath: this.monitorRegistryPath,
        now: this.monitorRegistryNow,
        notify: this.monitorRegistryNotify,
      });
    } catch {
      // The registry deadman is best-effort inside the sweep; never break
      // lifecycle reconciliation because the shared file is temporarily busy.
    } finally {
      this.monitorRegistrySweepInFlight = false;
    }
  }

  /** The on-disk record for an agent the in-memory registry has not bound. */
  private readPersistedAgentRecord(agentId: string): AgentRecord | null {
    try {
      return this.stateMgr.readState(agentId);
    } catch {
      return null;
    }
  }

  /**
   * AIDEV-NOTE (F1b, #472): watch-target existence, and NOTHING more.
   *
   * This resolver used to answer "does this agent exist?" with "did one
   * registry lookup hit AND did one screen read parse into a known CLI?", so a
   * transient read failure, an unreconstituted record, or a pane still booting
   * all collapsed into `exists:false` -> a hard `WatchArmError` saying the
   * agent does not exist. Live, that denied a watch on `voicelayerClaude-2ac0d960`
   * in the same second `send_to` delivered to it and verified submission.
   *
   * So: the record decides existence (registry first, then the state dir that
   * `send_to` also resolves from), and the screen only refines what the agent
   * is DOING. A read failure is reported as a read failure and retried once --
   * it is not evidence of absence. A booting or unparseable frame is a legal
   * watch target: it arms, and the predicate resolves on a later sweep. Only
   * positive evidence that the surface is gone -- dead, evicted, or fallen back
   * to a bare shell -- returns `exists:false`, and it says which one.
   */
  private watchAgentObservation = async (
    agentId: string,
    withUnlocked?: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<WatchAgentObservation> => {
    const agent =
      this.registry.get(agentId) ?? this.readPersistedAgentRecord(agentId);
    const source = `screen:${agent?.surface_uuid ?? agent?.surface_id ?? agentId}`;
    if (!agent) {
      return {
        exists: false,
        state: null,
        source,
        detail: `no registry or state record for ${agentId}`,
      };
    }

    let screenText: string | null = null;
    let readError: unknown = null;
    for (
      let attempt = 0;
      attempt < WATCH_OBSERVATION_READ_ATTEMPTS;
      attempt++
    ) {
      const versionBeforeRead = this.stateMgr.readState(agent.agent_id)?.version;
      const observationStale = () =>
        withUnlocked &&
        this.stateMgr.readState(agent.agent_id)?.version !== versionBeforeRead;
      try {
        const read = () => this.client.readScreen(agent.surface_id, {
          ...(agent.workspace_id ? { workspace: agent.workspace_id } : {}),
          lines: 30,
        });
        const screen = withUnlocked ? await withUnlocked(read) : await read();
        if (observationStale()) {
          throw new Error("watch agent changed during unlocked screen read");
        }
        screenText = screen.text;
        readError = null;
        break;
      } catch (error) {
        if (error instanceof LifecycleLockReacquireError || observationStale()) {
          throw error;
        }
        readError = error;
      }
    }

    if (screenText === null) {
      // A record we can read, on a surface we momentarily cannot. That is a
      // read failure, not a missing agent -- report the record's own state.
      //
      // AIDEV-NOTE (F1b, reviewer nit): this state IS the raw record, and a
      // `done`-predicate watch on an unreadable pane will therefore fire on a
      // #408-poisoned `done`. That is deliberate, not an oversight: the rule
      // this lane enforces is that absence of evidence leaves the record
      // unchallenged, and inventing a state for a pane nobody could read would
      // break it in the other direction. The deadline is the backstop.
      return {
        exists: true,
        state: resolveLiveAgentState(agent, null).state,
        source,
        detail: `registry hit, screen unreadable after ${WATCH_OBSERVATION_READ_ATTEMPTS} attempts: ${
          readError instanceof Error ? readError.message : String(readError)
        }`,
      };
    }

    const parsed = parseScreen(cleanScreenText(screenText));
    if (
      parsed.control_state === "dead" ||
      parsed.control_state === "stale_surface"
    ) {
      return {
        exists: false,
        state: null,
        source,
        detail: `registry hit, screen shows ${parsed.control_state}`,
      };
    }
    if (parsed.control_state === "shell" && parsed.agent_type === "unknown") {
      return {
        exists: false,
        state: null,
        source,
        detail: "registry hit, surface fell back to a bare shell",
      };
    }
    if (parsed.agent_type === "unknown") {
      const live = resolveLiveAgentState(agent, {
        status: parsed.status,
        agent_type: parsed.agent_type,
        control_state: parsed.control_state,
        errors: parsed.errors,
      });
      // Mid-boot or an unparseable frame: the screen has no authority over the
      // status here, and reading its default as an idle prompt would fire an
      // `idle` predicate on an agent that has not started yet.
      return {
        exists: true,
        state: live.state,
        source,
        detail: "registry hit, screen unparseable",
      };
    }
    return {
      exists: true,
      state:
        parsed.status === "frozen"
          ? "error"
          : parsed.status === "draft_pending"
            ? "working"
            : parsed.status,
      source,
    };
  };

  private async sweepWatchesBestEffort(
    withUnlocked?: <T>(operation: () => Promise<T>) => Promise<T>,
    sweepContext?: SweepAgentContext,
  ): Promise<void> {
    if (!this.watchRegistryPath || this.watchSweepInFlight) return;
    this.watchSweepInFlight = true;
    try {
      await sweepWatches({
        registryPath: this.watchRegistryPath,
        now: this.watchRegistryNow,
        agentObservation: (agentId) =>
          this.watchAgentObservation(agentId, withUnlocked),
        notify: this.watchNotify,
        onNotificationExhausted: ({ notification, attempts, reason }) => {
          this.sweepDebugLog(
            `[cmuxlayer] watch notification exhausted: watch=${notification.watch_id} owner=${notification.owner} attempts=${attempts} reason=${reason}`,
          );
        },
      });
      if (
        readWatchRegistry({ registryPath: this.watchRegistryPath }).watches.some(
          (watch) => watch.state === "failed" && !watch.notification_pending,
        )
      ) {
        this.scheduleClosedChildReportWatchPrune();
      }
    } catch {
      // Declared watches are retried on the next lifecycle sweep.
    } finally {
      this.watchSweepInFlight = false;
    }
  }

  /**
   * Drain the shared operator outbox to the notify path at the tail of a sweep.
   * Best-effort: any failure is swallowed so a drain never breaks a sweep, and an
   * in-flight guard prevents overlapping drains if a sweep runs long. Exactly-once
   * (no double-send) is owned by drainOutbox's `.outbox-drained.json` sidecar.
   *
   * AIDEV-NOTE: with multiple live agents each running this sweep, the sidecar
   * gives single-process exactly-once + best-effort cross-process dedup (a rare
   * read-before-write race between two agents could double-send one entry). Full
   * cross-process locking is intentionally out of scope for this best-effort path.
   */
  private async drainOutboxBestEffort(): Promise<void> {
    if (this.outboxDrainInFlight) return;
    this.outboxDrainInFlight = true;
    try {
      await this.outboxDrain();
    } catch {
      // Never break the sweep on a drain failure; it retries next sweep.
    } finally {
      this.outboxDrainInFlight = false;
    }
  }

  private sweepStateSignature(): string {
    const agentSignature = this.registry
      .list()
      .map((agent) =>
        [
          agent.agent_id,
          agent.surface_id,
          agent.workspace_id ?? "",
          agent.state,
          agent.updated_at,
          agent.cli_session_id ?? "",
          agent.task_done_candidate_at ?? "",
          agent.quality ?? "",
        ].join(":"),
      )
      .sort()
      .join("|");
    const screenSignature = [...this.currentSweepScreenSignatures.entries()]
      .map(([agentId, signature]) => `${agentId}:${signature}`)
      .sort()
      .join("|");
    return `${agentSignature}::screens:${screenSignature}`;
  }

  private recordSweepStability(): void {
    const signature = this.sweepStateSignature();
    if (
      this.lastSweepSignature !== null &&
      signature === this.lastSweepSignature
    ) {
      this.unchangedSweepCount += 1;
    } else {
      this.unchangedSweepCount = 0;
    }
    this.lastSweepSignature = signature;
  }

  private nextSweepIntervalMs(): number {
    const timing = this.sweepTiming ?? resolveSweepTiming();
    return this.unchangedSweepCount >= timing.idleAfterSweeps
      ? timing.idleIntervalMs
      : timing.activeIntervalMs;
  }

  /**
   * Start the reconciliation sweep on an interval.
   */
  startSweep(timingInput?: SweepTimingInput): void {
    if (this.sweepTiming) return;
    this.sweepTiming = resolveSweepTiming(process.env, timingInput);
    this.unchangedSweepCount = 0;
    this.lastSweepSignature = null;

    const runAndSchedule = async () => {
      this.sweepTimer = null;
      try {
        await this.runSweep();
      } catch (e) {
        console.error("[cmuxlayer] sweep failed (will retry):", e);
      } finally {
        this.recordSweepStability();
        if (this.sweepTiming) {
          this.sweepTimer = setTimeout(
            runAndSchedule,
            this.nextSweepIntervalMs(),
          );
        }
      }
    };

    this.sweepTimer = setTimeout(
      runAndSchedule,
      this.sweepTiming.activeIntervalMs,
    );
  }

  /**
   * Stop the reconciliation sweep.
   */
  dispose(): void {
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const timer of this.postSpawnLivenessTimers) {
      clearTimeout(timer);
    }
    this.postSpawnLivenessTimers.clear();
    this.sweepTiming = null;
    this.lastSweepSignature = null;
    this.unchangedSweepCount = 0;
  }

  private schedulePostSpawnLivenessAssertion(agentId: string): void {
    const timer = setTimeout(() => {
      this.postSpawnLivenessTimers.delete(timer);
      void this.assertPostSpawnLiveness(agentId);
    }, this.postSpawnLivenessMs);
    this.postSpawnLivenessTimers.add(timer);
  }

  private async assertPostSpawnLiveness(agentId: string): Promise<void> {
    const agent =
      this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
    if (!agent || TERMINAL_STATES.has(agent.state)) {
      return;
    }

    const registered = this.registry.get(agentId) !== null;
    let surfaceLive = true;
    try {
      surfaceLive = await this.registry.isSurfaceAlive(agent);
    } catch {
      // A failed topology read is inconclusive, not proof the spawn is dead.
      return;
    }
    if (registered && surfaceLive) {
      return;
    }

    const reason = registered
      ? `surface ${agent.surface_id} is not live`
      : `agent ${agentId} is not registered`;
    const error = `Post-spawn liveness failed: ${reason}`;

    try {
      const current =
        this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
      if (current && !TERMINAL_STATES.has(current.state)) {
        const degraded = this.stateMgr.updateRecord(agentId, {
          error,
          quality: "degraded",
        });
        this.registry.set(agentId, degraded);
      }
    } catch {
      // Best-effort liveness assertion.
    }

    // Do not auto-close the surface here. Liveness failures are evidence for
    // spawn/layout bugs, and closing the pane can destroy the user's context.
    // Keep the agent non-terminal so later sweeps can recover from discovery
    // races when the surface is actually alive.
  }

  /**
   * Spawn an agent — async, returns immediately with agent handle.
   * Does NOT wait for ready state.
   */
  async spawnAgent(params: SpawnAgentParams): Promise<SpawnAgentResult> {
    const modelPolicy = resolveSpawnModelPolicy(params.cli, params.model);
    const effort = resolveSpawnEffort(params.cli, params.effort);
    const spawnParams: SpawnAgentParams = {
      ...params,
      model: modelPolicy.effective_model,
    };
    const agentId = generateAgentId(spawnParams.cli, spawnParams.repo);

    // Resolve parent hierarchy
    let spawnDepth = 0;
    let parentAgentId: string | null = null;
    let parentAgent: AgentRecord | null = null;

    if (spawnParams.parent_agent_id) {
      let parent =
        this.registry.get(spawnParams.parent_agent_id) ??
        this.stateMgr.readState(spawnParams.parent_agent_id);
      if (!parent) {
        throw new Error(
          `Parent agent not found: ${spawnParams.parent_agent_id}`,
        );
      }
      if (!this.registry.get(parent.agent_id)) {
        this.registry.set(parent.agent_id, parent);
      }
      if (parent.surface_uuid) {
        await this.resolveAgentIoRoute(parent.agent_id);
        parent = this.registry.get(parent.agent_id);
        if (!parent) {
          throw new Error(
            `Parent agent disappeared while resolving its stable surface: ${spawnParams.parent_agent_id}`,
          );
        }
      }
      if (parent.spawn_depth >= MAX_SPAWN_DEPTH) {
        throw new Error(`Max spawn depth exceeded: ${MAX_SPAWN_DEPTH}`);
      }
      const childrenById = new Map<string, AgentRecord>();
      for (const child of this.stateMgr.listStates()) {
        if (
          child.parent_agent_id === parent.agent_id &&
          !TERMINAL_STATES.has(child.state)
        ) {
          childrenById.set(child.agent_id, child);
        }
      }
      for (const child of this.registry.getChildren(parent.agent_id)) {
        if (TERMINAL_STATES.has(child.state)) continue;
        childrenById.set(child.agent_id, child);
      }
      if (childrenById.size >= MAX_CHILDREN) {
        throw new Error(`Max children exceeded: ${MAX_CHILDREN}`);
      }
      spawnDepth = parent.spawn_depth + 1;
      parentAgentId = parent.agent_id;
      parentAgent = parent;
    }

    // Job role is authoritative. The versioned tool rejects missing agent
    // axes; direct legacy engine callers default to worker without consulting
    // the selected harness.
    const role =
      spawnParams.role !== undefined
        ? inferAgentRole({ role: spawnParams.role })
        : "worker";
    const authority =
      spawnParams.authority ?? (role === "orchestrator" ? "lead" : "worker");

    this.spawnGuard.check(spawnParams.workspace);

    const preflight = await this.spawnPreflight(spawnParams);
    const launchCwd = spawnParams.cwd ?? preflight?.repoRoot ?? null;
    const launchMode: AgentLaunchMode = preflight?.launchMode ?? "launcher";
    // Truthful provenance for BOTH the door we used and the pin we applied.
    // Neither may be inferable only from a null field on the record.
    const modelPin = describeModelPin(
      spawnParams.cli,
      launchMode,
      resolveLaunchModelFlagForCommand(
        spawnParams.cli,
        modelPolicy.launcher_model ?? undefined,
        { allowModelOverride: modelPolicy.override_allowed },
      ),
      modelPolicy.effective_model,
    );
    const collabPath =
      spawnParams.collab_path ??
      (role === "worker" ? parentAgent?.collab_path : null) ??
      null;
    const launchWarnings = [
      ...modelPolicy.warnings,
      ...(role === "worker" && parentAgentId && !collabPath
        ? ["collab_path missing: declare the parent lead channel before coordinating workers"]
        : []),
      ...(launchMode === "raw" && preflight?.launchModeReason
        ? [
            `RAW LAUNCH: ${preflight.launchModeReason} Started \`${spawnParams.cli}\` ` +
              `directly in "${launchCwd ?? "the surface cwd"}" -- without the ` +
              `launcher's MCP wiring or contexts.`,
          ]
        : []),
      ...(modelPin.warning ? [modelPin.warning] : []),
    ];
    const seatIdentity = assertSeatIdentity({
      repo: spawnParams.repo,
      cli: spawnParams.cli,
      launcherName: preflight?.launcherName ?? null,
      registry: this.seatRegistry,
    });
    if (seatIdentity.seat_identity_status === "mismatch") {
      throw new Error(
        `Spawn blocked by seat identity mismatch: ${
          seatIdentity.seat_identity_error ?? "registry identity mismatch"
        }`,
      );
    }

    // 1. Create cmux surface using the deterministic worker layout policy.
    const surface = await this.createAgentSurface(spawnParams.workspace, {
      role,
      focus: spawnParams.focus,
      parentAgent,
      repo: spawnParams.repo,
      worktree: isWorktreeLaunch(spawnParams),
      placementTimeoutMs: spawnParams.boot_prompt_timeout_ms,
    });
    try {
      this.assertSurfaceObserverEpochCurrent(
        surface.observerEpoch,
        "agent placement",
      );
    } catch (error) {
      await this.cleanupUnboundCreatedSurface(surface, "agent-placement");
      throw error;
    }
    const createdWorkspace = surface.actual_workspace ?? surface.workspace;
    let surfaceFocusError: unknown = null;
    try {
      // Metadata-capable backends initialize cold runtimes by input demand
      // below (cmux #9769). Focus here is for legacy backends or focus:true.
      if (spawnParams.focus !== false) await this.client.focusSurface(surface.surface, {
        workspace: createdWorkspace,
        beforeMutation: async () => {
          this.assertSurfaceObserverEpochCurrent(
            surface.observerEpoch,
            "agent focus",
          );
        },
      });
    } catch (error) {
      surfaceFocusError = error;
    }
    try {
      await spawnParams.on_surface_created?.({
        agent_id: agentId,
        surface: surface.surface,
        workspace: createdWorkspace,
      });
    } catch {
      // Focus observation is advisory and must never discard a created handle.
    }
    if (surfaceFocusError) {
      // Keep the unbound surface recoverable: AgentLaunchError returns its
      // identity so the caller can inspect, retry, or close the failed tab.
      const message =
        surfaceFocusError instanceof Error
          ? surfaceFocusError.message
          : String(surfaceFocusError);
      throw new AgentLaunchError(
        `Failed to focus created surface ${surface.surface}: ${message}`,
        agentId,
        surface.surface,
        createdWorkspace,
        surfaceFocusError,
        "focus",
      );
    }

    // 2. Write initial state (creating → booting)
    const now = new Date().toISOString();
    const record: AgentRecord = {
      agent_id: agentId,
      surface_id: surface.surface,
      surface_uuid: surface.surface_id ?? null,
      surface_observer_id: surface.observerId,
      surface_provenance: "cmuxlayer_spawn",
      workspace_id: surface.workspace,
      state: "booting",
      boot_instance_id: randomUUID(),
      repo: spawnParams.repo,
      model: spawnParams.model ?? modelPolicy.effective_model,
      effort: spawnParams.cli === "codex" ? (effort ?? "high") : null,
      cli: spawnParams.cli,
      cli_session_id: null,
      cli_session_path: null,
      launcher_name: preflight?.launcherName ?? null,
      tab_name: spawnParams.title?.trim() ? spawnParams.title : null,
      launch_mode: launchMode,
      model_pin: modelPin.pin,
      seat_id: seatIdentity.seat_id,
      seat_lane: seatIdentity.seat_lane,
      seat_role: seatIdentity.seat_role,
      seat_identity_status: seatIdentity.seat_identity_status,
      seat_identity_error: seatIdentity.seat_identity_error,
      task_summary: summarizeTaskSummary(
        spawnParams.prompt,
        spawnParams.boot_prompt_path,
      ),
      boot_prompt_text: spawnParams.prompt.trim() ? spawnParams.prompt : null,
      pid: null,
      version: 1,
      created_at: now,
      updated_at: now,
      error: null,
      parent_agent_id: parentAgentId,
      collab_path: collabPath,
      spawn_depth: spawnDepth,
      role,
      authority,
      function: spawnParams.function ?? "implementor",
      placement:
        spawnParams.placement ?? (role === "orchestrator" ? "left" : "right"),
      auto_archive_on_done: spawnParams.auto_archive_on_done,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: spawnParams.max_cost_per_agent ?? null,
      user_killed: false,
      halt_escalation: spawnParams.halt_escalation ?? true,
      halt_episode_type: null,
      halt_episode_started_at: null,
      halt_episode_observations: 0,
      halt_notification_sent_at: null,
      halt_notified_ancestor_id: null,
      halt_last_observable_action: null,
      halt_last_active_at: null,
      halt_last_progress_at_ms: null,
      halt_last_progress_signature: null,
      boot_prompt_pending: spawnParams.boot_prompt_pending ?? false,
      submit_verified: null,
      prompt_delivered: false,
      parsed_model: null,
      model_mismatch: null,
      parsed_effort: null,
      effort_mismatch: null,
      launch_cwd: launchCwd,
      mcp_profile: spawnParams.mcp_profile_label ?? null,
      worktree_path: spawnParams.cwd ?? null,
      worktree_branch: spawnParams.worktree_branch ?? null,
    };
    try {
      this.stateMgr.writeState(record);
    } catch (error) {
      let durableRecord: AgentRecord | null = null;
      try {
        durableRecord = this.stateMgr.readState(agentId);
      } catch {
        // Without a readable exact binding, the created surface is still
        // unbound from cmuxlayer's point of view and must be cleaned safely.
      }
      if (
        durableRecord &&
        this.isExactDurableSurfaceBinding(durableRecord, record)
      ) {
        // rename(state.json.tmp, state.json) may have committed before a
        // secondary index/event append failed. No launch command has been sent,
        // so close this exact created surface and make the durable record
        // terminal rather than leaving an unlaunched booting child forever.
        await this.cleanupUnboundCreatedSurface(surface, "agent-placement");
        const persistenceMessage =
          error instanceof Error ? error.message : String(error);
        try {
          const failed = this.stateMgr.transition(agentId, "error", {
            error: `Initial agent state persistence failed: ${persistenceMessage}`,
            pid: null,
            cli_session_id: null,
          });
          this.registry.set(agentId, failed);
        } catch {
          // transition() also renames the state file before updating secondary
          // indexes. Re-read so a post-commit transition failure still
          // rehydrates the durable error record.
          let failedRecord: AgentRecord | null = null;
          try {
            failedRecord = this.stateMgr.readState(agentId);
          } catch {
            // The original persistence failure remains authoritative.
          }
          if (
            failedRecord?.state === "error" &&
            this.isExactDurableSurfaceBinding(failedRecord, record)
          ) {
            this.registry.set(agentId, failedRecord);
          } else {
            this.registry.remove(agentId);
          }
        }
      } else {
        await this.cleanupUnboundCreatedSurface(surface, "agent-placement");
      }
      throw error;
    }
    this.registry.set(agentId, record);
    await this.reconcileRolePlacements("spawn", {
      agentIds: new Set([record.agent_id]),
    });

    // 3. Send launch command
    const launchCmd = buildLaunchCommand(
      spawnParams.cli,
      spawnParams.repo,
      modelPolicy.launcher_model ?? undefined,
      preflight?.launcherName,
      {
        // Raw launches must cd themselves; the launcher path keeps its
        // existing `-w <cwd>` semantics (cwd only when explicitly requested).
        cwd: launchMode === "raw" ? (launchCwd ?? undefined) : spawnParams.cwd,
        envPrefix: spawnParams.mcp_env,
        allowModelOverride: modelPolicy.override_allowed,
        effort: effort ?? undefined,
        launchMode,
        authority,
      },
    );
    let runtimeInitialization: "unsupported" | "already_ready" | "input_demand" = "unsupported";
    try {
      if ((spawnParams.runtime_metadata_supported ?? this.client.supportsSurfaceRuntimeMetadata) === true) runtimeInitialization = await initializeNewSurfaceRuntime(
        this.client,
        surface.surface,
        createdWorkspace,
        spawnParams.boot_prompt_timeout_ms,
        async () => this.assertSurfaceObserverEpochCurrent(surface.observerEpoch, "runtime initialization"),
        surface.surface_id,
      );
      await this.client.renameTab(
        surface.surface,
        managedPaneTitle(agentId, surface.surface, spawnParams.title),
        { workspace: surface.actual_workspace ?? surface.workspace },
      );
      this.assertSurfaceObserverEpochCurrent(
        surface.observerEpoch,
        "agent launch",
      );
      const launchRoute =
        record.surface_uuid && this.registry.isObserverOwnershipEnforced()
          ? await this.resolveAgentIoRoute(agentId)
          : this.resolveAgentRoute(agentId);
      this.assertSurfaceObserverEpochCurrent(
        surface.observerEpoch,
        "agent launch",
      );
      await this.sendLaunchCommand(
        launchRoute.surface_id,
        launchRoute.workspace_id ?? undefined,
        launchCmd,
        agentId,
        surface.observerEpoch,
        spawnParams.boot_prompt_timeout_ms,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let failedAgentId = agentId;
      try {
        failedAgentId =
          (await this.captureBootSessionId(agentId))?.agent_id ?? agentId;
      } catch {
        // Preserve the original launch error for the caller.
      }
      try {
        const failed = this.stateMgr.transition(failedAgentId, "error", {
          error: `Launch failed: ${message}`,
        });
        this.registry.set(failedAgentId, failed);
      } catch {
        // Preserve the original launch error for the caller.
      }
      throw new AgentLaunchError(
        message,
        failedAgentId,
        surface.surface,
        surface.actual_workspace ?? surface.workspace,
        error,
      );
    }
    if (
      spawnParams.cli === "codex" &&
      this.selfRegistrationSessionResolver
    ) {
      try {
        await this.captureCodexSpawnSessionId(agentId);
      } catch {
        // Registration is written by the launched harness. A later sweep keeps
        // retrying if the append has not landed by the time spawn returns.
      }
    }
    this.schedulePostSpawnLivenessAssertion(agentId);
    return {
      runtime_initialization: runtimeInitialization,
      agent_id: agentId,
      parent_agent_id: parentAgentId,
      collab_path: collabPath,
      surface_id: surface.surface,
      workspace_id: surface.workspace,
      state: "booting",
      model: modelPolicy.effective_model,
      requested_model: modelPolicy.requested_model,
      warnings: [...launchWarnings],
      model_policy: modelPolicy,
      cwd: launchCwd ?? undefined,
      mcp_env: spawnParams.mcp_env,
      launch_mode: launchMode,
      model_pin: modelPin.pin,
    };
  }

  /**
   * Resume a captured CLI session on a fresh surface while preserving its
   * stable public agent ID. Since #492 this is the ONLY revive there is:
   * cmuxlayer never respawns a pane on its own, so a revive is always somebody
   * asking for one by agent id.
   */
  async resumeAgent(
    agentId: string,
    opts?: { workspace?: string; force?: boolean },
  ): Promise<SpawnAgentResult> {
    let agent = this.resolveResumeAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (!TERMINAL_STATES.has(agent.state)) {
      throw new Error(
        `Agent "${agent.agent_id}" is ${agent.state}; explicit resume requires a terminal agent`,
      );
    }
    const recordedProcessLiveness = agentProcessLiveness(agent);
    if (
      recordedProcessLiveness === "alive" ||
      (recordedProcessLiveness === "unknown" && !opts?.force)
    ) {
      throw new Error(
        `Agent "${agent.agent_id}" cannot resume while recorded pid ` +
          `${agent.pid} is still alive or cannot be proven gone`,
      );
    }
    if (!agent.cli_session_id) {
      throw new Error(
        `Agent "${agent.agent_id}" has no captured CLI session to resume`,
      );
    }
    // Same authority list_agents uses. Previously this passed
    // harnessCwdForAgent, whose ~/Gits guess never returns null -- so an agent
    // reported NOT resumable could still be sent `cd ~/Gits/<repo> && claude
    // --resume <id>`, silently starting a new session in a lookalike tree.
    const resumeInvocation = resumeInvocationForAgent(agent);
    if (resumeInvocation.command === null) {
      throw new Error(
        `Agent "${agent.agent_id}" has no runnable resume command: ` +
          `${resumeInvocation.reason}`,
      );
    }
    const resumeCommand = resumeInvocation.command;
    const requestedWorkspace =
      opts?.workspace ?? agent.workspace_id ?? undefined;
    this.spawnGuard.check(requestedWorkspace);
    const persistedAgent = this.stateMgr.readState(agent.agent_id);
    if (!persistedAgent) {
      throw new Error(`Agent not found: ${agent.agent_id}`);
    }
    if (!persistedAgent.cli_session_id) {
      agent = this.stateMgr.updateRecord(agent.agent_id, {
        cli_session_id: agent.cli_session_id,
        cli_session_path: agent.cli_session_path ?? null,
      });
      this.registry.set(agent.agent_id, agent);
    } else if (persistedAgent.cli_session_id !== agent.cli_session_id) {
      throw new Error(
        `Agent "${agent.agent_id}" session identity changed during resume resolution`,
      );
    }

    let surface: CreatedAgentSurface | null = null;
    let surfaceBound = false;
    let recordReopened = false;
    try {
      surface = await this.createAgentSurface(requestedWorkspace, {
        role: inferRecordRole(agent),
        parentAgent: agent.parent_agent_id
          ? this.registry.get(agent.parent_agent_id)
          : null,
        repo: agent.repo,
        worktree: Boolean(agent.worktree_path),
      });
      this.assertSurfaceObserverEpochCurrent(
        surface.observerEpoch,
        "explicit agent resume",
      );
      const workspace = surface.actual_workspace ?? surface.workspace;
      await this.client.focusSurface(surface.surface, {
        workspace,
        beforeMutation: async () => {
          this.assertSurfaceObserverEpochCurrent(
            surface!.observerEpoch,
            "explicit agent resume focus",
          );
        },
      });

      const creating = this.stateMgr.reopenForResume(agent.agent_id);
      recordReopened = true;
      this.registry.set(agent.agent_id, creating);
      const rebound = this.stateMgr.updateRecord(agent.agent_id, {
        surface_id: surface.surface,
        surface_uuid: surface.surface_id ?? null,
        surface_observer_id: surface.observerId,
        surface_provenance: "cmuxlayer_spawn",
        workspace_id: workspace,
        user_killed: false,
        deletion_intent: false,
        error: null,
        pid: null,
      });
      this.registry.set(agent.agent_id, rebound);
      surfaceBound = true;
      this.assertSurfaceObserverEpochCurrent(
        surface.observerEpoch,
        "explicit agent resume rename",
      );
      // A resumed pane is the same agent; it must say so, like the spawn path.
      await this.client.renameTab(
        surface.surface,
        managedPaneTitle(agent.agent_id, surface.surface, agent.tab_name),
        { workspace },
      );
      const booting = this.stateMgr.transition(agent.agent_id, "booting", {
        error: null,
        pid: null,
        cli_session_id: agent.cli_session_id,
      });
      this.registry.set(agent.agent_id, booting);
      await this.sendLaunchCommand(
        surface.surface,
        workspace,
        resumeCommand,
        agent.agent_id,
        surface.observerEpoch,
      );
      await this.reconcileRolePlacements("spawn", {
        agentIds: new Set([agent.agent_id]),
      });
      return {
        agent_id: agent.agent_id,
        parent_agent_id: agent.parent_agent_id,
        surface_id: surface.surface,
        workspace_id: workspace,
        state: "booting",
        model: agent.model,
        cwd: agent.launch_cwd ?? undefined,
      };
    } catch (error) {
      if (surface && !surfaceBound) {
        await this.cleanupUnboundCreatedSurface(surface, "agent-placement");
      }
      if (recordReopened) {
        try {
          const failed = this.stateMgr.transition(agent.agent_id, "error", {
            error: `Explicit resume failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          this.registry.set(agent.agent_id, failed);
        } catch {
          // Preserve the original failure.
        }
      }
      throw error;
    }
  }

  /** Resolve either cmuxlayer's public label or the harness's full session id. */
  resolveResumeAgent(agentOrSessionId: string): AgentRecord | null {
    const direct =
      this.registry.get(agentOrSessionId) ??
      this.stateMgr.readState(agentOrSessionId);
    if (direct) return direct;
    const requestedSessionId = agentOrSessionId.trim().toLowerCase();
    const capturedMatches = this.stateMgr.listStates().filter(
      (record) =>
        record.cli_session_id?.trim().toLowerCase() === requestedSessionId,
    );
    const captured =
      capturedMatches.length === 1 ? capturedMatches[0]! : null;
    if (capturedMatches.length > 1) return null;
    if (captured) return captured;

    const registration = this.selfRegistrationSessionLookup?.(agentOrSessionId);
    if (!registration) return null;
    const surfaceUuid = registration.surface_uuid.trim().toLowerCase();
    const registrationCli = registration.cli?.trim().toLowerCase() || null;
    const records = this.stateMgr.listStates();
    const uniqueMatch = (
      predicate: (record: AgentRecord) => boolean,
    ): AgentRecord | null => {
      const matches = records.filter(predicate);
      return matches.length === 1 ? matches[0]! : null;
    };
    const surfaceMatches = records.filter(
      (record) => record.surface_uuid?.trim().toLowerCase() === surfaceUuid,
    );
    if (surfaceMatches.length > 1) return null;
    const registrationCwd = registration.cwd
      ? resolve(registration.cwd)
      : null;
    const registrationTimestamp =
      typeof registration.ts === "number" ? registration.ts : Number.NaN;
    const candidate =
      surfaceMatches[0] ??
      (registration.pid
        ? uniqueMatch((record) => {
            const recordTimestamp = Date.parse(record.created_at);
            const recordCwd = record.launch_cwd ?? record.worktree_path;
            return (
              record.pid === registration.pid &&
              Number.isFinite(registrationTimestamp) &&
              Number.isFinite(recordTimestamp) &&
              registrationTimestamp >= recordTimestamp &&
              registrationCwd !== null &&
              recordCwd !== null &&
              recordCwd !== undefined &&
              resolve(recordCwd) === registrationCwd
            );
          })
        : null);
    if (
      !candidate ||
      !TERMINAL_STATES.has(candidate.state) ||
      (registrationCli && candidate.cli !== registrationCli) ||
      (candidate.cli_session_id &&
        candidate.cli_session_id.trim().toLowerCase() !== requestedSessionId)
    ) {
      return null;
    }
    return {
      ...candidate,
      cli_session_id: registration.session_id,
      cli_session_path:
        registration.session_path ?? candidate.cli_session_path ?? null,
    };
  }

  /**
   * Cascade-kill all agents in the subtree rooted at rootId.
   * Uses DFS post-order (children before root). Continues on failures (best-effort).
   */
  async cascadeKill(rootId: string, force?: boolean): Promise<void> {
    const subtree = this.registry.getSubtree(rootId);
    for (const agent of subtree) {
      try {
        await this.stopAgent(agent.agent_id, force);
      } catch {
        // Best-effort — continue to next agent
      }
    }
  }

  /**
   * Wait for an agent to reach a target state.
   * Retroactive check first, then polling sweep until match or timeout.
   */
  private geminiHasSettledReply(text: string): boolean {
    // Antigravity keeps past-tense `▸ Thought for` rows in its transcript and
    // draws its model footer below the composer; its live block decides.
    if (isAntigravityScreen(text)) return !antigravityScreenIsActive(text);
    const lines = text.trimEnd().split("\n").map((line) => line.trim());
    if (lines.at(-1) !== ">") return false;
    const activity = /^✦\s*(?:Thinking|Working|Running|Reading|Writing|Calling)\b/i;
    let lastActivity = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (activity.test(lines[index] ?? "")) {
        lastActivity = index;
        break;
      }
    }
    return lastActivity >= 0 && lines.slice(lastActivity + 1, -1).some(
      (line) => /^✦\s+\S/.test(line) && !activity.test(line),
    );
  }

  private async interactiveMatchScreenIsActive(
    agent: AgentRecord,
    targetState: AgentState,
  ): Promise<boolean> {
    try {
      const screen = await this.readAgentScreen(agent, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
      const parsed = parseScreen(screen.text);
      // Ready can mean the CLI has booted and is processing its boot prompt.
      // Only an idle match promises that active work has stopped.
      if (targetState === "ready") return false;
      // Gemini leaves a Thinking line in scrollback after a completed reply.
      // Its final input prompt remains the idle evidence used by PROBE-L.
      if (agent.cli === "gemini" && this.geminiHasSettledReply(screen.text)) {
        return false;
      }
      return parsed.status === "working" ||
        parsed.status === "thinking" ||
        parsed.status === "draft_pending" ||
        parsed.control_state === "busy";
    } catch {
      // A failed direct read has no new evidence to contradict the existing gate.
      return false;
    }
  }

  async waitFor(
    agentId: string,
    targetState: AgentState,
    timeoutMs: number,
  ): Promise<WaitResult> {
    const start = Date.now();

    // Check if agent exists
    const initial = this.registry.get(agentId);
    if (!initial) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // AIDEV-NOTE (F1b, #473): a wait must never terminate on a record state the
    // screen contradicts. #408 flips live agents to `done` within minutes, and
    // these short-circuits read that record raw -- so `wait_for(target:"idle")`
    // returned `{state:"done", error:"Agent has already completed", elapsed:0}`
    // for an agent mid-`brew install`, and the lead that trusted it reported a
    // false completion. Every termination decision below reads the LIVE state
    // instead, and the top-level `state` reports the reconciled value rather
    // than the poisoned record. With no live probe wired the resolution IS the
    // record, so an unprobed engine behaves exactly as it did before.
    //
    // Round 2 (reviewer finding A): reading the live state is not enough if
    // nothing GUARANTEES there is any. `screenObservationForRecord` reads
    // `discovery.cachedScan()`, which returns null once the scan is 2000ms old
    // -- and nothing on this path refreshes it, so for a lead whose next action
    // is `wait_for` the cache is ordinarily cold and the resolution degrades to
    // the poisoned record, reproducing the original bug byte-for-byte. So the
    // wait BUYS its own evidence at entry, and again on a deliberate cadence
    // below. Cost: one screen read per agent at entry, one more per
    // WAIT_FOR_LIVE_EVIDENCE_INTERVAL_MS thereafter.
    const initialMemo = this.freshLiveStates.get(agentId);
    const initialLive = await this.refreshLiveState(initial);
    const initialProbeWasFresh = this.freshLiveStates.get(agentId) !== initialMemo;
    const initialState = this.terminationStateOf(initial, initialLive);
    // A pool seat can retain `done` throughout a newly delivered turn. A
    // single resting frame (or an unreadable pane) cannot confirm that record.
    const recordDoneNeedsConfirmation = (
      agent: AgentRecord,
      state: AgentState,
      live: LiveAgentState | null,
    ): boolean =>
      INTERACTIVE_AGENT_STATES.has(targetState) &&
      agent.state === "done" && state === "done" &&
      live?.screen_state !== "done" && live?.screen_state !== "error";

    // Retroactive check — already in target state with required evidence?
    const initialEvidence = await this.getTargetStateEvidenceSource(
      initial,
      targetState,
      initialState,
    );
    // A screen can momentarily look resting while the registry still records
    // active work. Let the poll path confirm that observation on a later tick.
    const initialRestingConflict =
      this.freshLiveStateProbe !== null &&
      INTERACTIVE_AGENT_STATES.has(targetState) &&
      (initial.state === "working" || initial.state === "booting") &&
      INTERACTIVE_AGENT_STATES.has(initialState);
    if (
      initialEvidence &&
      !initialRestingConflict &&
      !(this.freshLiveStateProbe && INTERACTIVE_AGENT_STATES.has(targetState) &&
        initialLive.source === "screen") &&
      (!INTERACTIVE_AGENT_STATES.has(targetState) ||
        !(await this.interactiveMatchScreenIsActive(initial, targetState)))
    ) {
      const stateEstablishedByScreen =
        initialLive?.source === "screen" && initialState !== initial.state;
      return {
        matched: true,
        state: initialState,
        elapsed: Date.now() - start,
        source:
          initialEvidence === "state"
            ? stateEstablishedByScreen
              ? "screen"
              : "immediate"
            : initialEvidence,
        agent: toPublicAgent({ ...initial, state: initialState }),
      };
    }

    // Already in terminal error state and target isn't error?
    if (initialState === "error" && targetState !== "error") {
      return {
        matched: false,
        state: initialState,
        elapsed: Date.now() - start,
        source: "immediate",
        agent: toPublicAgent({ ...initial, state: initialState }),
        error: initial.error ?? "Agent is in error state",
      };
    }

    // Already in terminal done state and target isn't done?
    if (initialState === "done" && targetState !== "done" &&
        !recordDoneNeedsConfirmation(initial, initialState, initialLive)) {
      return {
        matched: false,
        state: initialState,
        elapsed: Date.now() - start,
        source: "immediate",
        agent: toPublicAgent({ ...initial, state: initialState }),
        error: "Agent has already completed",
      };
    }

    const waitForReadyPatternMatches = new Map<string, number>();
    const confirmsRestingScreen = (live: LiveAgentState): boolean =>
      live.screen_state !== null &&
      INTERACTIVE_AGENT_STATES.has(live.screen_state);
    let restingObservations = confirmsRestingScreen(initialLive) ? 1 : 0;
    let needsSecondRestingRead = restingObservations === 1;
    let staleDoneRestingObservations = 0;
    let lastStaleDoneObservationAt = -1;
    let lastStaleDoneObservationConfirmed = false;
    let lastStaleDoneObservationActive = false;
    const observeStaleDoneScreen = async (
      agent: AgentRecord,
      live: LiveAgentState,
      probeWasFresh: boolean,
    ): Promise<void> => {
      if (!recordDoneNeedsConfirmation(agent, this.terminationStateOf(agent, live), live)) {
        staleDoneRestingObservations = 0;
        lastStaleDoneObservationConfirmed = false;
        lastStaleDoneObservationActive = false;
        return;
      }
      const memo = this.freshLiveStates.get(agentId);
      const freshProbe = probeWasFresh && memo?.live === live &&
        live.screen_state !== null;
      const observedAt = freshProbe ? memo.at : Date.now();
      if (observedAt <= lastStaleDoneObservationAt) return;
      lastStaleDoneObservationAt = observedAt;
      if (freshProbe) {
        lastStaleDoneObservationConfirmed = confirmsRestingScreen(live);
        lastStaleDoneObservationActive = isLiveActive(live);
      } else {
        // A null probe can mean a closed pane. Buy one direct read before
        // trusting the terminal record; a missing pane does not contradict it.
        try {
          const screen = await this.readAgentScreen(agent, {
            lines: BOOT_SESSION_CAPTURE_LINES,
          });
          const parsed = parseScreen(screen.text);
          const active = parsed.status === "working" ||
            parsed.status === "thinking" ||
            parsed.status === "draft_pending" ||
            parsed.control_state === "busy";
          const directState = resolveLiveAgentState(agent, parsed).screen_state;
          lastStaleDoneObservationActive = active;
          lastStaleDoneObservationConfirmed = !active &&
            (directState === "ready" || directState === "idle" ||
              directState === "error");
        } catch {
          lastStaleDoneObservationActive = false;
          lastStaleDoneObservationConfirmed = true;
        }
      }
      staleDoneRestingObservations = lastStaleDoneObservationConfirmed
        ? staleDoneRestingObservations + 1 : 0;
      if (staleDoneRestingObservations === 1) needsSecondRestingRead = true;
    };
    await observeStaleDoneScreen(initial, initialLive, initialProbeWasFresh);
    const confirmedStaleDone = async (
      agent: AgentRecord,
      state: AgentState,
      live: LiveAgentState | null,
    ): Promise<boolean> => {
      if (!recordDoneNeedsConfirmation(agent, state, live)) {
        return true;
      }
      if (staleDoneRestingObservations < 2 ||
          !lastStaleDoneObservationConfirmed) return false;
      // The direct veto is meaningful for idle. `ready` retains WF2's
      // established ready-target behavior.
      if (await this.interactiveMatchScreenIsActive(agent, targetState)) {
        restingObservations = 0;
        staleDoneRestingObservations = 0;
        lastStaleDoneObservationConfirmed = false;
        lastStaleDoneObservationActive = true;
        needsSecondRestingRead = false;
        return false;
      }
      return true;
    };
    if (restingObservations === 1) {
      waitForReadyPatternMatches.set(agentId, 1);
    } else if (INTERACTIVE_AGENT_STATES.has(targetState)) {
      // Count the entry screen as the first candidate. Short waits can then
      // confirm rest on the first poll tick, even without a forcing probe.
      await this.refreshTargetStateEvidence(
        initial,
        targetState,
        waitForReadyPatternMatches,
        initialState,
      );
      if (waitForReadyPatternMatches.has(agentId)) {
        restingObservations = 1;
        needsSecondRestingRead = true;
      }
    }
    // Entry already bought evidence, so the first sweep refresh is due one
    // full interval in.
    let lastForcedEvidenceElapsed = 0;

    // Polling sweep loop
    return new Promise<WaitResult>((resolve) => {
      const finish = (result: WaitResult) => {
        waitForReadyPatternMatches.clear();
        resolve(result);
      };

      const checkInterval = setInterval(async () => {
        const elapsed = Date.now() - start;
        if (elapsed >= timeoutMs) {
          clearInterval(checkInterval);
          try {
            await this.registry.reconcile({
              confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
            });
          } catch (error) {
            const current = this.registry.get(agentId);
            const failureState = current
              ? this.terminationStateOf(current, this.liveStateOf(current))
              : "error";
            const detail =
              error instanceof Error ? error.message : String(error);
            finish({
              matched: false,
              state: failureState,
              elapsed,
              source: "timeout",
              agent: current
                ? toPublicAgent({ ...current, state: failureState })
                : null,
              error:
                `Timed out after ${timeoutMs}ms waiting for state "${targetState}"; ` +
                `final reconciliation failed: ${detail}`,
            });
            return;
          }
          let current = this.registry.get(agentId);
          // The timeout answer is the one a lead acts on, and it lands after
          // the memo from the last cadence refresh has expired -- so buy one
          // final observation rather than reporting the record by default.
          // It also leaves fresh evidence behind for whatever renders the
          // reply (P11 closure reads it in the same turn).
          const timeoutMemo = this.freshLiveStates.get(agentId);
          const timeoutLive = current
            ? await this.refreshLiveState(current)
            : null;
          if (current && timeoutLive) {
            await observeStaleDoneScreen(
              current,
              timeoutLive,
              this.freshLiveStates.get(agentId) !== timeoutMemo,
            );
          }
          if (
            current && timeoutLive && timeoutLive.screen_state !== null &&
            INTERACTIVE_AGENT_STATES.has(targetState)
          ) {
            restingObservations = confirmsRestingScreen(timeoutLive)
              ? restingObservations + 1 : 0;
            if (restingObservations === 0) {
              waitForReadyPatternMatches.delete(agentId);
            }
          }
          let timeoutState =
            current && timeoutLive
              ? this.terminationStateOf(current, timeoutLive)
              : "error";
          let refreshedSource: RefreshedTargetStateEvidenceSource | undefined;
          let refreshedActive = false;
          const finalReadyNeedsAnotherConsecutiveObservation =
            current !== null &&
            targetState === "ready" &&
            matchReadyPattern(current.cli, "").consecutive > 1;
          if (
            current &&
            INTERACTIVE_AGENT_STATES.has(targetState) &&
            !finalReadyNeedsAnotherConsecutiveObservation
          ) {
            const refreshed = await this.refreshTargetStateEvidence(
              current,
              targetState,
              waitForReadyPatternMatches,
              timeoutState,
            );
            current = refreshed.agent;
            refreshedSource = refreshed.source;
            refreshedActive = refreshed.observedActive === true;
            if (refreshed.observedActive) {
              restingObservations = 0;
              needsSecondRestingRead = false;
            }
            timeoutState =
              refreshed.observedActive || refreshed.source === "screen"
                ? current.state
                : this.terminationStateOf(current, this.liveStateOf(current));
          }
          const timeoutStateEstablishedByScreen =
            current !== null &&
            timeoutLive?.source === "screen" &&
            timeoutState !== current.state;
          const singleObservationReadyIsSafe =
            current !== null &&
            targetState === "ready" &&
            timeoutStateEstablishedByScreen &&
            matchReadyPattern(current.cli, "").consecutive === 1;
          const timeoutInteractiveEvidenceIsGated =
            targetState === "idle" ||
            refreshedSource !== undefined ||
            (current !== null && INTERACTIVE_AGENT_STATES.has(current.state)) ||
            singleObservationReadyIsSafe;
          const timeoutEvidence =
            current &&
            INTERACTIVE_AGENT_STATES.has(targetState) &&
            timeoutInteractiveEvidenceIsGated
              ? await this.getTargetStateEvidenceSource(
                  current,
                  targetState,
                  timeoutState,
                )
              : null;
          if (
            current &&
            timeoutEvidence &&
            !refreshedActive &&
            (!INTERACTIVE_AGENT_STATES.has(targetState) ||
              (restingObservations >= 2 &&
                timeoutLive?.source === "screen" &&
                !isLiveActive(timeoutLive) &&
                current.state !== "working") ||
              (refreshedSource === "screen" &&
                INTERACTIVE_AGENT_STATES.has(current.state))) &&
            (!INTERACTIVE_AGENT_STATES.has(targetState) ||
              !(await this.interactiveMatchScreenIsActive(current, targetState)))
          ) {
            finish({
              matched: true,
              state: timeoutState,
              elapsed,
              source:
                refreshedSource ??
                (timeoutEvidence === "state"
                  ? timeoutStateEstablishedByScreen
                    ? "screen"
                    : "sweep"
                  : timeoutEvidence),
              agent: toPublicAgent({ ...current, state: timeoutState }),
            });
            return;
          }
          let unconfirmedDone = false;
          if (current && timeoutState === "done" &&
              INTERACTIVE_AGENT_STATES.has(targetState)) {
            if (await confirmedStaleDone(current, timeoutState, timeoutLive)) {
              finish({
                matched: false,
                state: "done",
                elapsed,
                source: "sweep",
                agent: toPublicAgent({ ...current, state: "done" }),
                error: current.error ?? "Agent entered terminal state: done",
              });
              return;
            }
            timeoutState = lastStaleDoneObservationActive
              ? "working" : timeoutLive?.screen_state ?? current.state;
            unconfirmedDone = true;
          }
          finish({
            matched: false,
            state: timeoutState,
            elapsed,
            source: "timeout",
            agent: current
              ? toPublicAgent({ ...current, state: timeoutState })
              : null,
            error: `Timed out after ${timeoutMs}ms waiting for state "${targetState}"` +
              (unconfirmedDone ? "; done record unconfirmed" : ""),
          });
          return;
        }

        // Re-read from disk (another process may have updated)
        await this.registry.reconcile({
          confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
        });
        let current = this.registry.get(agentId);
        if (!current) {
          clearInterval(checkInterval);
          finish({
            matched: false,
            state: "error",
            elapsed,
            source: "sweep",
            agent: null,
            error: "Agent disappeared during wait",
          });
          return;
        }

        // Re-force evidence on a deliberate cadence. Between refreshes the
        // memo from the last one answers, and it expires exactly when the next
        // is due, so no tick ever decides on evidence older than the TTL.
        let forcedLive: LiveAgentState | null = null;
        if (
          (needsSecondRestingRead && INTERACTIVE_AGENT_STATES.has(targetState)) ||
          elapsed - lastForcedEvidenceElapsed >=
            WAIT_FOR_LIVE_EVIDENCE_INTERVAL_MS
        ) {
          lastForcedEvidenceElapsed = elapsed;
          needsSecondRestingRead = false;
          const forcedMemo = this.freshLiveStates.get(agentId);
          forcedLive = await this.refreshLiveState(current);
          await observeStaleDoneScreen(
            current,
            forcedLive,
            this.freshLiveStates.get(agentId) !== forcedMemo,
          );
          if (INTERACTIVE_AGENT_STATES.has(targetState) && forcedLive.screen_state !== null) {
            restingObservations = confirmsRestingScreen(forcedLive)
              ? restingObservations + 1 : 0;
            if (restingObservations === 1) needsSecondRestingRead = true;
          }
        }

        const activeScreen = forcedLive?.source === "screen" && isLiveActive(forcedLive);
        if (activeScreen && targetState === "idle") {
          waitForReadyPatternMatches.delete(agentId);
        }
        const refreshed = activeScreen && targetState === "idle"
          ? { agent: current }
          : await this.refreshTargetStateEvidence(
              current,
              targetState,
              waitForReadyPatternMatches,
              this.terminationStateOf(current, this.liveStateOf(current)),
            );
        current = refreshed.agent;
        if (refreshed.observedActive) {
          restingObservations = 0;
          needsSecondRestingRead = false;
        }
        if (waitForReadyPatternMatches.has(agentId)) {
          restingObservations = Math.max(restingObservations, 1);
          needsSecondRestingRead = true;
        }

        // The sweep runs the same live gate as the retroactive check: gating
        // only the entry short-circuit would just move the false completion
        // one poll interval later. Resolved AFTER the refresh, because a
        // refresh that transitions the record is itself fresh screen evidence
        // -- and `liveStateOf` drops a memo whose record has moved.
        const live = this.liveStateOf(current);
        const liveState = this.terminationStateOf(current, live);

        const evidenceSource = await this.getTargetStateEvidenceSource(
          current,
          targetState,
          liveState,
        );
        if (
          evidenceSource &&
          !refreshed.observedActive &&
          (!INTERACTIVE_AGENT_STATES.has(targetState) ||
            forcedLive?.source !== "screen" ||
            (restingObservations >= 2 && !isLiveActive(forcedLive))) &&
          (!INTERACTIVE_AGENT_STATES.has(targetState) ||
            !(await this.interactiveMatchScreenIsActive(current, targetState)))
        ) {
          const stateEstablishedByScreen =
            live?.source === "screen" && liveState !== current.state;
          clearInterval(checkInterval);
          finish({
            matched: true,
            state: liveState,
            elapsed,
            source:
              refreshed.source ??
              (evidenceSource === "state"
                ? stateEstablishedByScreen
                  ? "screen"
                  : "sweep"
                : evidenceSource),
            agent: toPublicAgent({ ...current, state: liveState }),
          });
          return;
        }

        // Fail-fast on terminal error
        if (
          TERMINAL_STATES.has(liveState) && liveState !== targetState &&
          await confirmedStaleDone(current, liveState, forcedLive)
        ) {
          clearInterval(checkInterval);
          finish({
            matched: false,
            state: liveState,
            elapsed,
            source: "sweep",
            agent: toPublicAgent({ ...current, state: liveState }),
            error:
              current.error ?? `Agent entered terminal state: ${liveState}`,
          });
        }
      }, WAIT_FOR_SWEEP_INTERVAL_MS);
    });
  }

  async armWatch(spec: WatchSpec): Promise<WatchRecord> {
    if (!this.watchRegistryPath) {
      throw new Error("WatchSpec registry is not configured");
    }
    return armDeclaredWatch(spec, {
      registryPath: this.watchRegistryPath,
      now: this.watchRegistryNow,
      agentObservation: this.watchAgentObservation,
    });
  }

  async waitForWatch(
    spec: WatchSpec,
    timeoutMs: number,
  ): Promise<{ matched: boolean; elapsed: number; watch: WatchRecord }> {
    if (!this.watchRegistryPath) {
      throw new Error("WatchSpec registry is not configured");
    }
    const startedAt = Date.now();
    const armed = await armDeclaredWatch(
      spec,
      {
        registryPath: this.watchRegistryPath,
        now: this.watchRegistryNow,
        agentObservation: this.watchAgentObservation,
        waiterExpiresAtMs:
          (this.watchRegistryNow?.() ?? Date.now()) +
          Math.max(0, timeoutMs) +
          60_000,
      },
    );
    const releaseWaiterBestEffort = async (): Promise<void> => {
      try {
        const released = await releaseWatchWaiter(armed.watch_id, {
          registryPath: this.watchRegistryPath,
        });
        if (released) this.scheduleClosedChildReportWatchPrune();
      } catch (error) {
        this.sweepDebugLog(
          `[cmuxlayer] watch waiter release deferred: watch=${armed.watch_id} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    try {
      while (true) {
        const swept = await sweepWatches({
          registryPath: this.watchRegistryPath,
          now: this.watchRegistryNow,
          agentObservation: this.watchAgentObservation,
          notify: this.watchNotify,
          onNotificationExhausted: ({ notification, attempts, reason }) => {
            this.sweepDebugLog(
              `[cmuxlayer] watch notification exhausted: watch=${notification.watch_id} owner=${notification.owner} attempts=${attempts} reason=${reason}`,
            );
          },
        });
        const current = readWatchRegistry({
          registryPath: this.watchRegistryPath,
        }).watches.find((watch) => watch.watch_id === armed.watch_id);
        if (!current) {
          throw new Error(`Watch disappeared during wait: ${armed.watch_id}`);
        }
        const elapsed = Date.now() - startedAt;
        if (current.state === "fired" || swept.fired.includes(armed.watch_id)) {
          return { matched: true, elapsed, watch: current };
        }
        if (current.state === "failed") {
          return { matched: false, elapsed, watch: current };
        }
        if (elapsed >= timeoutMs) {
          return { matched: false, elapsed, watch: current };
        }
        await new Promise<void>((resolveSleep) => {
          setTimeout(resolveSleep, Math.min(50, timeoutMs - elapsed));
        });
      }
    } finally {
      await releaseWaiterBestEffort();
    }
  }

  /**
   * Wait for all agents to reach target state.
   * Fail-fast: returns partial results when any agent errors.
   */
  async waitForAll(
    agentIds: string[],
    targetState: AgentState,
    timeoutMs: number,
  ): Promise<WaitResult[]> {
    const results = await Promise.all(
      agentIds.map((id) => this.waitFor(id, targetState, timeoutMs)),
    );
    return results;
  }

  /**
   * Get agent state from registry.
   */
  getAgentState(agentId: string): AgentRecord | null {
    return this.registry.get(agentId);
  }

  /** Reserve a re-tasked interactive agent before releasing its surface lock. */
  markObservedPause(agentId: string, paused: boolean): AgentRecord | null {
    const agent = this.getAgentState(agentId);
    if (!agent) return null;
    return this.persistPausedState(agent, paused, new Date().toISOString());
  }

  markAgentWorking(
    agentId: string,
    opts: { verifiedDelivery?: boolean } = {},
  ): AgentRecord | null {
    const current =
      this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
    if (
      current?.state === "done" &&
      current.user_killed !== true &&
      opts.verifiedDelivery === true
    ) {
      const armed = this.stateMgr.updateRecord(agentId, {
        reopen_pending_at: new Date().toISOString(),
      });
      this.registry.set(agentId, armed);
      return armed;
    }
    if (!current || current.state !== "idle") {
      return current;
    }
    this.stateMgr.transition(agentId, "working");
    const reTasked = this.stateMgr.updateRecord(agentId, {
      halt_last_active_at: new Date(this.haltNow()).toISOString(),
    });
    this.registry.set(agentId, reTasked);
    return reTasked;
  }

  getPublicAgent(agentId: string): PublicAgent | null {
    const agent = this.registry.get(agentId);
    return agent ? toPublicAgent(agent) : null;
  }

  /**
   * List agents with optional filters.
   */
  listAgents(filter?: AgentFilter): AgentRecord[] {
    return this.registry.list(filter);
  }

  listPublicAgents(filter?: AgentFilter): PublicAgent[] {
    return this.listAgents(filter).map((agent) => toPublicAgent(agent));
  }

  resolveAgentRoute(agentId: string): AgentRoute {
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    // Terminal I/O depends on the stable surface binding, not optional resume
    // metadata: resumeCommandForAgent swallows a damaged legacy repo field and
    // withholds a cwd-keyed raw resume it cannot aim, rather than advertising
    // a command that would silently start a NEW session.
    const resumeCommand = resumeCommandForAgent(agent);
    return {
      agent_id: agent.agent_id,
      surface_id: agent.surface_id,
      surface_uuid: agent.surface_uuid ?? null,
      workspace_id: agent.workspace_id ?? null,
      state: agent.state,
      session_id: agent.cli_session_id,
      resumable: !!resumeCommand,
      ...(resumeCommand ? { resume_command: resumeCommand } : {}),
    };
  }

  /**
   * Resolve the terminal-I/O route from a fresh topology observation.
   *
   * The persisted ref is metadata only for UUID-backed records: refs can be
   * recycled after a surface closes. A known UUID therefore must be observed
   * exactly once in a current topology before any read or mutation. An
   * incomplete observation may prove presence, but never absence.
   * UUID-less legacy records retain compatibility only when an owned ref is
   * proven by a complete fresh topology with no UUID identity coverage.
   */
  async resolveAgentIoRoute(
    agentId: string,
    topologyOverride?: SurfaceTopologySnapshot | null,
    onTopologyRpc?: TopologyRpcObserver,
  ): Promise<AgentRoute> {
    let agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const observerId = this.registry.getObserverId();
    if (!agent.surface_uuid) {
      if (!this.registry.canControlSurface(agent)) {
        throw new Error(
          `Agent "${agent.agent_id}" surface binding is not owned by the ` +
            `current cmux observer; refusing terminal I/O to mutable ref ` +
            `${agent.surface_id}.`,
        );
      }

      const topology =
        topologyOverride === undefined
          ? await this.collectObservedSurfaceTopology(onTopologyRpc)
          : topologyOverride;
      if (topologyOverride !== undefined) {
        this.assertSurfaceObserverEpochCurrent(
          topology?.observerEpoch,
          "sweep route resolution",
        );
      }
      const binding = resolveAgentSurfaceBinding(agent, topology);
      if (
        topology?.complete !== true ||
        topology.surfaceIdByRef.size !== 0 ||
        topology.surfaceRefById.size !== 0 ||
        !binding ||
        binding.provenance !== "ref" ||
        binding.surfaceRef !== agent.surface_id
      ) {
        throw new Error(
          `Fresh complete ref-only topology did not prove UUID-less agent ` +
            `"${agent.agent_id}" owns live mutable ref ${agent.surface_id}; ` +
            `refusing terminal I/O.`,
        );
      }

      if (
        binding.workspaceId &&
        (agent.workspace_id ?? null) !== binding.workspaceId
      ) {
        agent = this.stateMgr.updateRecord(agent.agent_id, {
          workspace_id: binding.workspaceId,
        });
        this.registry.set(agent.agent_id, agent);
      }

      return this.resolveAgentRoute(agent.agent_id);
    }

    const topology =
      topologyOverride === undefined
        ? await this.collectObservedSurfaceTopology(onTopologyRpc)
        : topologyOverride;
    if (topologyOverride !== undefined) {
      this.assertSurfaceObserverEpochCurrent(
        topology?.observerEpoch,
        "sweep route resolution",
      );
    }
    const binding = resolveAgentSurfaceBinding(agent, topology);
    if (!binding || binding.provenance !== "uuid") {
      if (agentProcessMayBeAlive(agent)) {
        throw new Error(
          `Agent "${agent.agent_id}" still has live recorded pid ${agent.pid}; ` +
            `the current topology did not prove its surface route, so its ` +
            `engine-issued identity is retained and terminal I/O is deferred.`,
        );
      }
      throw new Error(
        `Stable surface UUID ${agent.surface_uuid} for agent ` +
          `"${agent.agent_id}" is not live or uniquely resolvable in a ` +
          `complete fresh topology; refusing ` +
          `terminal I/O to mutable ref ${agent.surface_id}.`,
      );
    }

    const observedUuid = topology?.surfaceIdByRef.get(binding.surfaceRef);
    if (
      observedUuid?.trim().toLowerCase() !==
      agent.surface_uuid.trim().toLowerCase()
    ) {
      throw new Error(
        `Fresh topology did not prove stable surface UUID ` +
          `${agent.surface_uuid} for agent "${agent.agent_id}"; refusing ` +
          `terminal I/O.`,
      );
    }

    const workspaceId = binding.workspaceId ?? agent.workspace_id ?? null;
    const patch: Partial<AgentRecord> = {};
    if (agent.surface_id !== binding.surfaceRef) {
      patch.surface_id = binding.surfaceRef;
    }
    if ((agent.workspace_id ?? null) !== workspaceId) {
      patch.workspace_id = workspaceId;
    }
    if (observerId && agent.surface_observer_id !== observerId) {
      // Exact UUID evidence is sufficient to adopt a pre-upgrade or moved
      // binding into this observer; a ref-only observation never reaches here.
      patch.surface_observer_id = observerId;
    }
    if (Object.keys(patch).length > 0) {
      agent = this.stateMgr.updateRecord(agent.agent_id, patch);
      this.registry.set(agent.agent_id, agent);
    }

    return this.resolveAgentRoute(agent.agent_id);
  }

  /**
   * Stop/close must remain usable in socketless CLI mode. When observer
   * identity is unavailable, require a fresh exact UUID match instead of
   * trusting its mutable surface ref.
   * This fallback is deliberately scoped to teardown; other terminal I/O
   * keeps the observer-ownership gate.
   */
  private async resolveAgentStopIoRoute(agentId: string): Promise<AgentRoute> {
    if (
      !this.registry.isObserverOwnershipEnforced() ||
      this.registry.getObserverEpoch()
    ) {
      return this.resolveAgentIoRoute(agentId);
    }

    let agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (!agent.surface_uuid) {
      return this.resolveAgentIoRoute(agentId);
    }
    if (agent.surface_observer_id) {
      throw new Error(
        `Observer identity is unavailable and agent "${agent.agent_id}" is ` +
          `owned by ${agent.surface_observer_id}; refusing socketless teardown ` +
          `without matching observer ownership.`,
      );
    }
    const normalizedSurfaceUuid = agent.surface_uuid.trim().toLowerCase();
    const routedAgentId = agent.agent_id;
    const competingRecord = this.registry
      .list()
      .find(
        (candidate) =>
          candidate.agent_id !== routedAgentId &&
          candidate.surface_uuid?.trim().toLowerCase() ===
            normalizedSurfaceUuid,
      );
    if (competingRecord) {
      throw new Error(
        `Agent "${agent.agent_id}" cannot use socketless teardown because ` +
          `stable surface UUID ${agent.surface_uuid} is also claimed by ` +
          `agent "${competingRecord.agent_id}".`,
      );
    }

    const topology = await collectSurfaceTopology(this.client);
    const binding = resolveAgentSurfaceBinding(agent, topology);
    if (
      topology?.complete !== true ||
      !binding ||
      binding.provenance !== "uuid" ||
      topology?.surfaceIdByRef.get(binding.surfaceRef)?.trim().toLowerCase() !==
        agent.surface_uuid.trim().toLowerCase()
    ) {
      throw new Error(
        `Observer identity is unavailable and fresh topology did not ` +
          `prove stable surface UUID ${agent.surface_uuid} for agent ` +
          `"${agent.agent_id}"; refusing teardown through mutable ref ` +
          `${agent.surface_id}.`,
      );
    }

    const workspaceId = binding.workspaceId ?? agent.workspace_id ?? null;
    const patch: Partial<AgentRecord> = {};
    if (agent.surface_id !== binding.surfaceRef) {
      patch.surface_id = binding.surfaceRef;
    }
    if ((agent.workspace_id ?? null) !== workspaceId) {
      patch.workspace_id = workspaceId;
    }
    if (Object.keys(patch).length > 0) {
      agent = this.stateMgr.updateRecord(agent.agent_id, patch);
      this.registry.set(agent.agent_id, agent);
    }
    return this.resolveAgentRoute(agent.agent_id);
  }

  private async resolvePaneForSurface(
    surfaceId: string,
    workspaceId?: string | null,
  ): Promise<string | null> {
    try {
      const opts = workspaceId ? { workspace: workspaceId } : undefined;
      const panes = await this.client.listPanes(opts);
      for (const pane of panes.panes) {
        if (
          pane.surface_refs.includes(surfaceId) ||
          pane.selected_surface_ref === surfaceId
        ) {
          return pane.ref;
        }
      }

      for (const pane of panes.panes) {
        try {
          const paneSurfaces = await this.client.listPaneSurfaces({
            ...(workspaceId ? { workspace: workspaceId } : {}),
            pane: pane.ref,
          });
          if (
            paneSurfaces.surfaces.some((surface) => surface.ref === surfaceId)
          ) {
            return paneSurfaces.pane_ref || pane.ref;
          }
        } catch {
          // Keep scanning panes; a stale pane ref should not hide a later match.
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private async resolveStopSurfaceClosePolicy(
    surfaceId: string,
    workspaceId?: string | null,
  ): Promise<StopSurfaceClosePolicy> {
    const observerEpoch = this.captureSurfaceObserverEpoch();
    const failClosedPolicy: StopSurfaceClosePolicy = {
      paneRef: null,
      collapsePane: false,
    };
    if (!this.isSurfaceObserverEpochCurrent(observerEpoch)) {
      return failClosedPolicy;
    }
    try {
      const opts = workspaceId ? { workspace: workspaceId } : undefined;
      const panes = await this.client.listPanes(opts);
      const rawPaneSurfaces = await Promise.all(
        panes.panes.map(async (pane) => {
          const paneSurfaces = await this.client.listPaneSurfaces({
            ...(opts ?? {}),
            pane: pane.ref,
          });
          return paneSurfaces.pane_ref
            ? paneSurfaces
            : { ...paneSurfaces, pane_ref: pane.ref };
        }),
      );
      const paneSurfaces = partitionPaneSurfacesByMembership(
        panes.panes,
        rawPaneSurfaces,
        {
          workspace_ref: panes.workspace_ref ?? workspaceId ?? undefined,
          window_ref: panes.window_ref,
        },
      );
      const surfaceObservation = buildSurfaceBindingObservation(
        panes.panes,
        paneSurfaces,
      );
      if (!this.isSurfaceObserverEpochCurrent(observerEpoch)) {
        return failClosedPolicy;
      }
      const paneSurfaceRefs = panes.panes.flatMap((pane) => pane.surface_refs);
      const paneSurfaceRefSet = new Set(paneSurfaceRefs);
      const observationIsComplete =
        (surfaceObservation.coverage === "ref" ||
          surfaceObservation.coverage === "uuid") &&
        paneSurfaceRefs.length === paneSurfaceRefSet.size &&
        panes.panes.every(
          (pane) =>
            pane.surface_count === pane.surface_refs.length &&
            (!pane.selected_surface_ref ||
              pane.surface_refs.includes(pane.selected_surface_ref)),
        ) &&
        paneSurfaceRefSet.size === surfaceObservation.liveSurfaceRefs.size &&
        [...paneSurfaceRefSet].every((surfaceRef) =>
          surfaceObservation.liveSurfaceRefs.has(surfaceRef),
        );
      if (!observationIsComplete) {
        const paneRef =
          panes.panes.find(
            (pane) =>
              pane.surface_refs.includes(surfaceId) ||
              pane.selected_surface_ref === surfaceId,
          )?.ref ?? null;
        return { paneRef, collapsePane: false };
      }
      const workerSurfaceIds = new Set(
        this.registry.list().flatMap((record) => {
          const surfaceRef = resolveObservedAgentSurfaceRef(
            record,
            surfaceObservation,
          );
          const observedUuid = surfaceRef
            ? surfaceObservation.surfaceUuidByRef.get(surfaceRef)
            : null;
          return surfaceRef &&
            this.registry.canUseObservedBinding(record, observedUuid)
            ? [surfaceRef]
            : [];
        }),
      );
      const policy = chooseSurfaceClosePolicy(
        panes.panes,
        paneSurfaces,
        workerSurfaceIds,
        surfaceId,
      );
      if (!this.isSurfaceObserverEpochCurrent(observerEpoch)) {
        return failClosedPolicy;
      }
      return {
        paneRef: policy.pane,
        collapsePane: policy.collapsePane,
      };
    } catch {
      if (!this.isSurfaceObserverEpochCurrent(observerEpoch)) {
        return failClosedPolicy;
      }
      return {
        paneRef: await this.resolvePaneForSurface(surfaceId, workspaceId),
        collapsePane: false,
      };
    }
  }

  private sameSurfaceRoute(left: AgentRoute, right: AgentRoute): boolean {
    return (
      left.surface_id === right.surface_id &&
      (left.surface_uuid ?? null) === (right.surface_uuid ?? null) &&
      (left.workspace_id ?? null) === (right.workspace_id ?? null)
    );
  }

  private stableSurfaceWriteOptions(surfaceUuid: string | null | undefined): {
    stableSurfaceIdentity?: string;
  } {
    return this.registry.isObserverOwnershipEnforced() && surfaceUuid
      ? { stableSurfaceIdentity: surfaceUuid }
      : {};
  }

  private async resolveUnchangedAgentIoRoute(
    agentId: string,
    expectedRoute: AgentRoute,
    operation: string,
  ): Promise<AgentRoute> {
    const route = await this.resolveAgentIoRoute(agentId);
    if (!this.sameSurfaceRoute(expectedRoute, route)) {
      throw new Error(
        `Agent "${agentId}" surface route changed during ${operation}; ` +
          `refusing stale terminal evidence or mutation.`,
      );
    }
    return route;
  }

  private async resolveUnchangedAgentStopIoRoute(
    agentId: string,
    expectedRoute: AgentRoute,
    operation: string,
  ): Promise<AgentRoute> {
    const route = await this.resolveAgentStopIoRoute(agentId);
    if (!this.sameSurfaceRoute(expectedRoute, route)) {
      throw new Error(
        `Agent "${agentId}" surface route changed during ${operation}; ` +
          `refusing stale terminal evidence or mutation.`,
      );
    }
    return route;
  }

  private processLiveness(pid: number | null | undefined): ProcessLiveness {
    return processLiveness(pid);
  }

  private isProcessMissingError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    );
  }

  private isProcessGone(agent: AgentRecord): boolean {
    const liveness = agentProcessLiveness(agent);
    return liveness === "gone" || liveness === "unknown";
  }

  private isProcessConfirmedGone(agent: AgentRecord): boolean {
    return agentProcessLiveness(agent) === "gone";
  }

  /**
   * A terminal row is a ghost only when someone MEANT to end it. A row that
   * died on its own keeps its state file, because that file is the only thing
   * an explicit `spawn_agent({resume_agent_id})` has to resume from (#492).
   */
  private isTerminalDeadRegistryGhost(agent: AgentRecord): boolean {
    return TERMINAL_STATES.has(agent.state) && agent.user_killed === true;
  }

  evictDeadProcessAgents(): string[] {
    const evicted: string[] = [];

    for (const agent of this.registry.list()) {
      const processGone =
        agent.pid !== null &&
        agent.pid !== undefined &&
        this.processLiveness(agent.pid) === "gone";
      if (shouldRetainForExplicitResume(agent)) {
        continue;
      }
      if (!this.isTerminalDeadRegistryGhost(agent) && !processGone) {
        continue;
      }

      const removedAgentId = this.registry.evict(agent.agent_id);
      if (removedAgentId) {
        evicted.push(removedAgentId);
      }
    }

    return evicted;
  }

  private async isSurfaceGone(surfaceId: string): Promise<boolean> {
    try {
      return !(await this.registry.hasLiveSurface(surfaceId));
    } catch {
      return false;
    }
  }

  private async isAgentSurfaceGone(
    agent: Pick<
      AgentRecord,
      "surface_id" | "surface_uuid" | "surface_observer_id"
    >,
  ): Promise<boolean> {
    if (!agent.surface_uuid) {
      return this.isSurfaceGone(agent.surface_id);
    }

    try {
      const observerOwnsRecord = this.registry.canControlSurface(agent);
      if (!observerOwnsRecord && this.registry.getObserverEpoch()) {
        // A known but different observer cannot prove this record absent.
        return false;
      }
      if (!observerOwnsRecord && agent.surface_observer_id) {
        return false;
      }
      const topology = observerOwnsRecord
        ? await this.collectObservedSurfaceTopology()
        : await collectSurfaceTopology(this.client);
      if (
        topology?.complete !== true ||
        topology.workspaceBySurface.size === 0 ||
        (observerOwnsRecord && !this.registry.canControlSurface(agent))
      ) {
        return false;
      }
      return resolveAgentSurfaceBinding(agent, topology) === null;
    } catch {
      return false;
    }
  }

  private async isPaneGone(
    paneRef: string | null,
    workspaceId?: string | null,
  ): Promise<boolean> {
    if (!paneRef) return true;
    try {
      const panes = await this.client.listPanes(
        workspaceId ? { workspace: workspaceId } : undefined,
      );
      return !panes.panes.some((pane) => pane.ref === paneRef);
    } catch {
      return false;
    }
  }

  private async readStopPostCondition(
    agent: AgentRecord,
    paneRef: string | null,
    treatUnknownProcessAsGone: boolean,
  ): Promise<StopPostConditionResult> {
    const processGone = treatUnknownProcessAsGone
      ? this.isProcessGone(agent)
      : this.isProcessConfirmedGone(agent);
    const [surfaceGone, paneGone] = await Promise.all([
      this.isAgentSurfaceGone(agent),
      this.isPaneGone(paneRef, agent.workspace_id),
    ]);
    return { processGone, surfaceGone, paneGone, paneRef };
  }

  private async waitForStopPostCondition(
    agent: AgentRecord,
    paneRef: string | null,
    expectPaneGone: boolean,
    treatUnknownProcessAsGone: boolean,
  ): Promise<StopPostConditionResult> {
    const deadline = Date.now() + this.stopPostConditionTimeoutMs;
    let result = await this.readStopPostCondition(
      agent,
      paneRef,
      treatUnknownProcessAsGone,
    );
    while (
      !(
        result.processGone &&
        result.surfaceGone &&
        (!expectPaneGone || result.paneGone)
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, STOP_POST_CONDITION_POLL_MS),
      );
      result = await this.readStopPostCondition(
        agent,
        paneRef,
        treatUnknownProcessAsGone,
      );
    }
    return result;
  }

  private formatStopPostConditionError(
    agent: AgentRecord,
    result: StopPostConditionResult,
    expectPaneGone: boolean,
    closeError: string | null,
  ): string {
    const failed = [
      result.processGone ? null : "process still alive",
      result.surfaceGone ? null : "surface still live",
      expectPaneGone && !result.paneGone ? "pane still open" : null,
      closeError ? `close failed: ${closeError}` : null,
    ].filter((part): part is string => part !== null);
    return [
      `Stop post-condition failed for ${agent.agent_id}: ${failed.join(", ")}`,
      `(pid=${agent.pid ?? "unknown"} surface=${agent.surface_id}`,
      `pane=${result.paneRef ?? "unknown"})`,
    ].join(" ");
  }

  /**
   * Stop an agent gracefully (Ctrl+C) or forcefully (kill PID).
   */
  async stopAgent(
    agentId: string,
    force?: boolean,
    opts?: {
      userInitiated?: boolean;
      beforeSurfaceMutation?: (route: AgentRoute) => Promise<void>;
      allowUnknownPidOwnedSurfaceClose?: boolean;
    },
  ): Promise<void> {
    let agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const canonicalAgentId = agent.agent_id;
    const ownedBeforeRouteResolution =
      this.registry.isObserverOwnershipEnforced() &&
      this.registry.canControlSurface(agent);

    const userInitiated = opts?.userInitiated ?? true;

    if (TERMINAL_STATES.has(agent.state)) {
      if (force) {
        if (!agent.cli_session_id) {
          this.registry.evictExplicit(canonicalAgentId);
          return;
        }
        const surfaceGone = await this.isAgentSurfaceGone(agent);
        if (
          surfaceGone &&
          (this.isProcessConfirmedGone(agent) || agent.pid == null)
        ) {
          const tombstone = this.stateMgr.updateRecord(canonicalAgentId, {
            user_killed: true,
            pid: null,
          });
          this.registry.set(canonicalAgentId, tombstone);
          return;
        }
      } else {
        if (
          agent.state === "error" &&
          userInitiated &&
          agent.user_killed !== true
        ) {
          const marked = this.stateMgr.updateRecord(canonicalAgentId, {
            user_killed: true,
          });
          this.registry.set(canonicalAgentId, marked);
        }
        return; // Already stopped
      }
    }

    let route = await this.resolveAgentStopIoRoute(canonicalAgentId);
    agent = this.registry.get(canonicalAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    let stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
      route.surface_id,
      route.workspace_id,
    );
    let finalRoute = await this.resolveAgentStopIoRoute(canonicalAgentId);
    if (!this.sameSurfaceRoute(route, finalRoute)) {
      stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
        finalRoute.surface_id,
        finalRoute.workspace_id,
      );
      const confirmedRoute =
        await this.resolveAgentStopIoRoute(canonicalAgentId);
      if (!this.sameSurfaceRoute(finalRoute, confirmedRoute)) {
        throw new Error(
          `Agent "${canonicalAgentId}" surface route changed repeatedly while ` +
            `preparing stop; refusing terminal mutation.`,
        );
      }
      finalRoute = confirmedRoute;
    }
    route = finalRoute;
    agent = this.registry.get(canonicalAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    await opts?.beforeSurfaceMutation?.(route);
    const mutationRoute = await this.resolveAgentStopIoRoute(canonicalAgentId);
    if (!this.sameSurfaceRoute(route, mutationRoute)) {
      throw new Error(
        `Agent "${canonicalAgentId}" surface route changed during the ` +
          `mutation gate; refusing terminal mutation.`,
      );
    }
    route = mutationRoute;
    if (opts?.beforeSurfaceMutation) {
      stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
        route.surface_id,
        route.workspace_id,
      );
      const closeRoute = await this.resolveAgentStopIoRoute(canonicalAgentId);
      if (!this.sameSurfaceRoute(route, closeRoute)) {
        throw new Error(
          `Agent "${canonicalAgentId}" surface route changed while refreshing ` +
            `close policy after the mutation gate; refusing terminal mutation.`,
        );
      }
      route = closeRoute;
    }
    agent = this.registry.get(canonicalAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const previousUserKilled = agent.user_killed ?? false;
    let stopIntentMarked = false;
    if (userInitiated && !previousUserKilled) {
      agent = this.stateMgr.updateRecord(canonicalAgentId, {
        user_killed: true,
      });
      this.registry.set(canonicalAgentId, agent);
      stopIntentMarked = true;
    }
    const rollbackUnacceptedStopIntent = (): void => {
      if (!stopIntentMarked) return;
      const current = this.registry.get(canonicalAgentId);
      if (!current) return;
      const restored = this.stateMgr.updateRecord(canonicalAgentId, {
        user_killed: previousUserKilled,
      });
      this.registry.set(canonicalAgentId, restored);
      stopIntentMarked = false;
    };

    let forceSignalAccepted = force === true && !agent.pid;
    let unknownPidOwnedClose = false;
    if (force && agent.pid) {
      const processIdentity = agentProcessLiveness(agent);
      if (processIdentity === "gone") {
        forceSignalAccepted = true;
      } else if (processIdentity === "unknown") {
        unknownPidOwnedClose =
          opts?.allowUnknownPidOwnedSurfaceClose === true &&
          ownedBeforeRouteResolution &&
          this.registry.canControlSurface(agent) &&
          Boolean(route.surface_uuid) &&
          route.surface_uuid?.trim().toLowerCase() ===
            agent.surface_uuid?.trim().toLowerCase();
        if (!unknownPidOwnedClose) {
          rollbackUnacceptedStopIntent();
          throw new Error(
            `Force stop refused for ${agent.agent_id}: recorded pid ${agent.pid} ` +
              `identity is unknown; refusing SIGKILL.`,
          );
        }
        // The owned UUID route may be closed without signalling an unproven
        // PID. Require both its disappearance and confirmed process absence
        // before reporting the agent stopped.
      } else {
        try {
          process.kill(agent.pid, "SIGKILL");
          forceSignalAccepted = true;
        } catch (error) {
          forceSignalAccepted = this.isProcessMissingError(error);
          if (!forceSignalAccepted) rollbackUnacceptedStopIntent();
          // Process may already be dead; other failures must preserve tracking.
        }
      }
    } else {
      // Graceful: send Ctrl+C
      const assertSignalRouteCurrent = async (): Promise<void> => {
        await this.resolveUnchangedAgentStopIoRoute(
          canonicalAgentId,
          route,
          "Ctrl+C",
        );
      };
      try {
        await this.client.sendKey(route.surface_id, "c-c", {
          workspace: route.workspace_id ?? undefined,
          ...this.stableSurfaceWriteOptions(route.surface_uuid),
          beforeMutation: assertSignalRouteCurrent,
        });
      } catch (error) {
        rollbackUnacceptedStopIntent();
        throw error;
      }
    }

    // Ctrl+C and process teardown can move the stable UUID to a replacement
    // ref before close runs. Re-resolve both the route and pane-collapse policy
    // after the signal so a recycled ref is never closed by mistake.
    let closeRoute: AgentRoute | null = null;
    try {
      closeRoute = await this.resolveAgentStopIoRoute(canonicalAgentId);
    } catch (error) {
      if (!(await this.isAgentSurfaceGone(agent))) {
        throw error;
      }
    }

    let closeError: string | null = null;
    if (closeRoute) {
      stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
        closeRoute.surface_id,
        closeRoute.workspace_id,
      );
      let confirmedCloseRoute =
        await this.resolveAgentStopIoRoute(canonicalAgentId);
      if (!this.sameSurfaceRoute(closeRoute, confirmedCloseRoute)) {
        closeRoute = confirmedCloseRoute;
        stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
          closeRoute.surface_id,
          closeRoute.workspace_id,
        );
        confirmedCloseRoute =
          await this.resolveAgentStopIoRoute(canonicalAgentId);
        if (!this.sameSurfaceRoute(closeRoute, confirmedCloseRoute)) {
          throw new Error(
            `Agent "${canonicalAgentId}" surface route changed repeatedly while ` +
              `preparing close; refusing terminal mutation.`,
          );
        }
      }
      route = confirmedCloseRoute;
      agent = this.registry.get(canonicalAgentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const assertCloseRouteCurrent = async (): Promise<void> => {
        await this.resolveUnchangedAgentStopIoRoute(
          canonicalAgentId,
          route,
          "surface close",
        );
      };

      try {
        await this.client.closeSurface(route.surface_id, {
          workspace: route.workspace_id ?? undefined,
          ...this.stableSurfaceWriteOptions(route.surface_uuid),
          collapsePane: stopClosePolicy.collapsePane,
          beforeMutation: assertCloseRouteCurrent,
        });
      } catch (error) {
        closeError = error instanceof Error ? error.message : String(error);
      }
    }

    const stopResult = await this.waitForStopPostCondition(
      agent,
      stopClosePolicy.paneRef,
      stopClosePolicy.collapsePane,
      force === true && forceSignalAccepted,
    );
    if (
      !stopResult.processGone ||
      !stopResult.surfaceGone ||
      (stopClosePolicy.collapsePane && !stopResult.paneGone)
    ) {
      const error = this.formatStopPostConditionError(
        agent,
        stopResult,
        stopClosePolicy.collapsePane,
        closeError,
      );
      try {
        const updated = this.stateMgr.updateRecord(canonicalAgentId, {
          error,
          quality: "degraded",
        });
        this.registry.set(canonicalAgentId, updated);
      } catch {
        // Preserve the post-condition error for the caller.
      }
      throw new Error(error);
    }

    if (unknownPidOwnedClose) {
      forceSignalAccepted = true;
    }

    if (force && !forceSignalAccepted) {
      const error =
        `Stop post-condition failed for ${agent.agent_id}: process still alive ` +
        `(pid=${agent.pid ?? "unknown"} surface=${agent.surface_id} pane=${stopResult.paneRef ?? "unknown"})`;
      try {
        const updated = this.stateMgr.updateRecord(canonicalAgentId, {
          error,
          quality: "degraded",
        });
        this.registry.set(canonicalAgentId, updated);
      } catch {
        // Preserve explicit force-stop failure for the caller.
      }
      throw new Error(error);
    }

    if (force) {
      const current = this.registry.get(canonicalAgentId) ?? agent;
      if (!current.cli_session_id) {
        this.registry.evictExplicit(canonicalAgentId);
        return;
      }
      const tombstone = this.stateMgr.updateRecord(canonicalAgentId, {
        user_killed: true,
        pid: null,
      });
      this.registry.set(canonicalAgentId, tombstone);
      if (!TERMINAL_STATES.has(current.state)) {
        try {
          const done = this.stateMgr.transition(canonicalAgentId, "done");
          this.registry.set(canonicalAgentId, done);
        } catch {
          try {
            const failed = this.stateMgr.transition(canonicalAgentId, "error", {
              error: "Force stopped",
            });
            this.registry.set(canonicalAgentId, failed);
          } catch {
            const committed = this.stateMgr.readState(canonicalAgentId);
            if (committed) this.registry.set(canonicalAgentId, committed);
          }
        }
      }
      return;
    }

    const current = this.registry.get(canonicalAgentId) ?? agent;
    let marked = current;
    if ((current.user_killed ?? false) !== userInitiated) {
      marked = this.stateMgr.updateRecord(canonicalAgentId, {
        user_killed: userInitiated,
      });
      this.registry.set(canonicalAgentId, marked);
    }

    // Transition to done
    try {
      const updated = this.stateMgr.transition(canonicalAgentId, "done");
      this.registry.set(canonicalAgentId, updated);
    } catch {
      // If transition to done fails (e.g. from error state), try error
      try {
        const updated = this.stateMgr.transition(canonicalAgentId, "error", {
          error: "Force stopped",
        });
        this.registry.set(canonicalAgentId, updated);
      } catch {
        // State is already terminal — that's fine
      }
    }
  }

  /**
   * Send text to an agent. Agent must be in interactive state (ready or idle).
   */
  async sendToAgent(
    agentId: string,
    text: string,
    pressEnter?: boolean,
  ): Promise<void> {
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (!INTERACTIVE_AGENT_STATES.has(agent.state)) {
      throw new Error(
        `Agent "${agentId}" is not in an interactive state (current: ${agent.state}). ` +
          `Must be in: ${[...INTERACTIVE_AGENT_STATES].join(", ")}`,
      );
    }

    const route = await this.resolveAgentIoRoute(agentId);
    const workspace = route.workspace_id ?? undefined;
    const assertSurfaceBindingCurrent = async (): Promise<void> => {
      await this.resolveUnchangedAgentIoRoute(agentId, route, "agent send");
    };
    await this.client.send(route.surface_id, sanitizeTerminalInput(text), {
      workspace,
      ...this.stableSurfaceWriteOptions(route.surface_uuid),
      beforeMutation: assertSurfaceBindingCurrent,
    });
    if (pressEnter) {
      try {
        await this.resolveUnchangedAgentIoRoute(agentId, route, "Return");
      } catch (error) {
        throw new Error(
          `Agent "${agentId}" surface route changed before Return; refusing ` +
            `to submit text on a different terminal.`,
          { cause: error },
        );
      }
      await this.client.sendKey(route.surface_id, "return", {
        workspace,
        ...this.stableSurfaceWriteOptions(route.surface_uuid),
        beforeMutation: assertSurfaceBindingCurrent,
      });
    }
    if (pressEnter) {
      this.markAgentWorking(agent.agent_id);
    }
  }
}
