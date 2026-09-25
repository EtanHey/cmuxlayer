/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  resolveClosureState,
} from "./coordination-paths.js";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { StateManager } from "./state-manager.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import { withRaisedNofileSoftLimit } from "./nofile-limit.js";
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
  resolveBootPromptText,
  shouldRetainForExplicitResume,
  type AgentRoute,
  isValidTransition,
  type AgentRecord,
  type AgentState,
  type CliType,
  type PublicAgent,
  type WaitResult,
} from "./agent-types.js";
import type { CloseForensicsSweepResult } from "./close-forensics.js";
import {
  armWatch as armDeclaredWatch,
  readWatchRegistry,
  releaseWatchWaiter,
  sweepWatches,
  type WatchAgentObservation,
  type WatchNotify,
  type WatchRecord,
  type WatchSpec,
} from "./watch-spec.js";
import {
  ANTIGRAVITY_BANNER_RE,
  cleanScreenText,
  parseScreen,
} from "./screen-parser.js";

import {
  canonicalRoleColumn,
  chooseSurfaceClosePolicy,
  deriveRoleColumnIndex,
  inferRecordRoleOrNull,
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
import { SpawnGuard } from "./spawn-guard.js";
import { DeliveryQueue } from "./engine/delivery-queue.js";
import * as sweepImpl from "./engine/sweep.js";
import {
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "./engine/env.js";
import * as lifecycleImpl from "./engine/lifecycle.js";
import * as placementImpl from "./engine/placement.js";
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
  DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY,
  type AgentHealth,
  type AgentHealthInput,
} from "./agent-health.js";
import {
  defaultRepoCheckoutPath,
} from "./repo-root-fallback.js";
import {
  loadSeatRegistryFromConfig,
  type SeatRegistry,
} from "./seat-identity.js";
import {
  latestMonitorForOwnerSeats,
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
  dispatchOnce,
  removePendingChannelMarkerAfterRegistration,
  type InboxOpts,
} from "./inbox.js";
import {
  agentProcessLiveness,
  agentProcessMayBeAlive,
  processLiveness,
  type ProcessLiveness,
} from "./util/pid-alive.js";
import {
  AgentLaunchError,
  TERMINAL_STATES,
  WATCH_OBSERVATION_READ_ATTEMPTS,
  LIVE_EVIDENCE_TTL_MS,
  DEFAULT_POST_SPAWN_LIVENESS_MS,
  DEFAULT_STOP_POST_CONDITION_TIMEOUT_MS,
  MAX_SPAWN_SESSION_CAPTURE_MS,
  SPAWN_SESSION_CAPTURE_POLL_MS,
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
  DEFAULT_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS,
  DEFAULT_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS,
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
  SweepAgentContext,
  SweepMutationSkipAccounting,
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

export { managedPaneTitle } from "./engine/lifecycle.js";
export {
  isSubjectSideReportWatchPruneEligible,
  resolveSweepTiming,
} from "./engine/sweep.js";

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

  // placement: bodies live in ./engine/placement.ts (CX-3); delegates keep call sites and spies.
  private createAgentSurface(...args: Parameters<typeof placementImpl.createAgentSurface>): ReturnType<typeof placementImpl.createAgentSurface> {
    return placementImpl.createAgentSurface.call(this.placementHost(), ...args);
  }
  private withPlacementLock<T>(
    workspace: string,
    deadline: number,
    operation: (assertActive: () => void) => Promise<T>,
  ): Promise<T> {
    return placementImpl.withPlacementLock.call<
      placementImpl.PlacementHost,
      [string, number, (assertActive: () => void) => Promise<T>],
      Promise<T>
    >(this.placementHost(), workspace, deadline, operation);
  }
  private awaitPendingPlacementSplit(...args: Parameters<typeof placementImpl.awaitPendingPlacementSplit>): ReturnType<typeof placementImpl.awaitPendingPlacementSplit> {
    return placementImpl.awaitPendingPlacementSplit.call(this.placementHost(), ...args);
  }
  private observePlacementColumnState(...args: Parameters<typeof placementImpl.observePlacementColumnState>): ReturnType<typeof placementImpl.observePlacementColumnState> {
    return placementImpl.observePlacementColumnState.call(this.placementHost(), ...args);
  }
  private settleRightSplitExit(...args: Parameters<typeof placementImpl.settleRightSplitExit>): ReturnType<typeof placementImpl.settleRightSplitExit> {
    return placementImpl.settleRightSplitExit.call(this.placementHost(), ...args);
  }
  private settleLatePlacementSplit(...args: Parameters<typeof placementImpl.settleLatePlacementSplit>): ReturnType<typeof placementImpl.settleLatePlacementSplit> {
    return placementImpl.settleLatePlacementSplit.call(this.placementHost(), ...args);
  }
  private withWorkspacePlacementObservation(...args: Parameters<typeof placementImpl.withWorkspacePlacementObservation>): ReturnType<typeof placementImpl.withWorkspacePlacementObservation> {
    return placementImpl.withWorkspacePlacementObservation.call(this.placementHost(), ...args);
  }
  private resolveWorkspaceForRepo(...args: Parameters<typeof placementImpl.resolveWorkspaceForRepo>): ReturnType<typeof placementImpl.resolveWorkspaceForRepo> {
    return placementImpl.resolveWorkspaceForRepo.call(this.placementHost(), ...args);
  }

  private placementHostCache: placementImpl.PlacementHost | null = null;

  /** The members ./engine/placement.ts needs, as live getters and forwarders. */
  private placementHost(): placementImpl.PlacementHost {
    if (this.placementHostCache) return this.placementHostCache;
    const engine = this;
    this.placementHostCache = {
      get client() { return engine.client; },
      get pendingPlacementSplits() { return engine.pendingPlacementSplits; },
      get placementSplitInFlight() { return engine.placementSplitInFlight; },
      get placementTails() { return engine.placementTails; },
      get registry() { return engine.registry; },
      get roleSurfaceIdsProvider() { return engine.roleSurfaceIdsProvider; },
      get stateMgr() { return engine.stateMgr; },
      assertSurfaceObserverEpochCurrent: (...args) => engine.assertSurfaceObserverEpochCurrent(...args),
      awaitPendingPlacementSplit: (...args) => engine.awaitPendingPlacementSplit(...args),
      captureSurfaceObserverEpoch: (...args) => engine.captureSurfaceObserverEpoch(...args),
      cleanupUnboundCreatedSurface: (...args) => engine.cleanupUnboundCreatedSurface(...args),
      isSurfaceObserverEpochCurrent: (...args) => engine.isSurfaceObserverEpochCurrent(...args),
      listAllWorkspaces: (...args) => engine.listAllWorkspaces(...args),
      observePlacementColumnState: (...args) => engine.observePlacementColumnState(...args),
      resolveWorkspaceForRepo: (...args) => engine.resolveWorkspaceForRepo(...args),
      settleLatePlacementSplit: (...args) => engine.settleLatePlacementSplit(...args),
      settleRightSplitExit: (...args) => engine.settleRightSplitExit(...args),
      surfaceObserverEpochProvider: (...args) => engine.surfaceObserverEpochProvider(...args),
      surfaceObserverIdProvider: (...args) => engine.surfaceObserverIdProvider(...args),
      withPlacementLock: (...args) => engine.withPlacementLock(...args),
      withWorkspacePlacementObservation: (...args) => engine.withWorkspacePlacementObservation(...args),
    };
    return this.placementHostCache;
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
        // AIDEV-NOTE: anchors are banner lines ABOVE the composer. Claude's
        // CLAUDE_COUNTER status line and "bypass permissions on" footer sit
        // BELOW it; as anchors they emptied the region and hid a typed boot
        // prompt. Same set as the server's composer anchor (composer-screen).
        return /Claude Code|What can I help you with\?/i.test(trimmed);
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
  private maybeEscalateLiveHalt(...args: Parameters<typeof haltImpl.maybeEscalateLiveHalt>): ReturnType<typeof haltImpl.maybeEscalateLiveHalt> {
    return haltImpl.maybeEscalateLiveHalt.call(this.haltHost(), ...args);
  }

  private haltHostCache: haltImpl.HaltHost | null = null;

  /** The members ./engine/halt.ts needs, as live getters and forwarders. */
  private haltHost(): haltImpl.HaltHost {
    if (this.haltHostCache) return this.haltHostCache;
    const engine = this;
    this.haltHostCache = {
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
      get registry() { return engine.registry; },
      get stateMgr() { return engine.stateMgr; },
      get sweepBackgroundProcessSnapshot() { return engine.sweepBackgroundProcessSnapshot; },
      set sweepBackgroundProcessSnapshot(value) { engine.sweepBackgroundProcessSnapshot = value; },
      appendHaltEscalationEvent: (...args) => engine.appendHaltEscalationEvent(...args),
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

  // sweep: bodies live in ./engine/sweep.ts (CX-3); delegates keep call sites and spies.
  private pruneClosedChildReportWatches(...args: Parameters<typeof sweepImpl.pruneClosedChildReportWatches>): ReturnType<typeof sweepImpl.pruneClosedChildReportWatches> {
    return sweepImpl.pruneClosedChildReportWatches.call(this.sweepHost(), ...args);
  }
  scheduleClosedChildReportWatchPrune(...args: Parameters<typeof sweepImpl.scheduleClosedChildReportWatchPrune>): ReturnType<typeof sweepImpl.scheduleClosedChildReportWatchPrune> {
    return sweepImpl.scheduleClosedChildReportWatchPrune.call(this.sweepHost(), ...args);
  }
  private retryClosedChildReportWatchPrune(...args: Parameters<typeof sweepImpl.retryClosedChildReportWatchPrune>): ReturnType<typeof sweepImpl.retryClosedChildReportWatchPrune> {
    return sweepImpl.retryClosedChildReportWatchPrune.call(this.sweepHost(), ...args);
  }
  private purgeStartupTerminalAgents(...args: Parameters<typeof sweepImpl.purgeStartupTerminalAgents>): ReturnType<typeof sweepImpl.purgeStartupTerminalAgents> {
    return sweepImpl.purgeStartupTerminalAgents.call(this.sweepHost(), ...args);
  }
  private evictSurfacelessForSweep(...args: Parameters<typeof sweepImpl.evictSurfacelessForSweep>): ReturnType<typeof sweepImpl.evictSurfacelessForSweep> {
    return sweepImpl.evictSurfacelessForSweep.call(this.sweepHost(), ...args);
  }
  private purgeTerminalForSweep(...args: Parameters<typeof sweepImpl.purgeTerminalForSweep>): ReturnType<typeof sweepImpl.purgeTerminalForSweep> {
    return sweepImpl.purgeTerminalForSweep.call(this.sweepHost(), ...args);
  }
  private removeStateForSweep(...args: Parameters<typeof sweepImpl.removeStateForSweep>): ReturnType<typeof sweepImpl.removeStateForSweep> {
    return sweepImpl.removeStateForSweep.call(this.sweepHost(), ...args);
  }

  private sweepHostCache: sweepImpl.SweepHost | null = null;

  /** The members ./engine/sweep.ts needs, as live getters and forwarders. */
  private sweepHost(): sweepImpl.SweepHost {
    if (this.sweepHostCache) return this.sweepHostCache;
    const engine = this;
    this.sweepHostCache = {
      get childReportWatchPrunePending() { return engine.childReportWatchPrunePending; },
      set childReportWatchPrunePending(value) { engine.childReportWatchPrunePending = value; },
      get client() { return engine.client; },
      get closeForensicsRunner() { return engine.closeForensicsRunner; },
      get closeForensicsSweepInFlight() { return engine.closeForensicsSweepInFlight; },
      set closeForensicsSweepInFlight(value) { engine.closeForensicsSweepInFlight = value; },
      get currentSweepScreenSignatures() { return engine.currentSweepScreenSignatures; },
      set currentSweepScreenSignatures(value) { engine.currentSweepScreenSignatures = value; },
      get inboxOpts() { return engine.inboxOpts; },
      get lastChannelMarkerReapAt() { return engine.lastChannelMarkerReapAt; },
      set lastChannelMarkerReapAt(value) { engine.lastChannelMarkerReapAt = value; },
      get lastChannelMarkerReapFailureAt() { return engine.lastChannelMarkerReapFailureAt; },
      set lastChannelMarkerReapFailureAt(value) { engine.lastChannelMarkerReapFailureAt = value; },
      get lastSweepSignature() { return engine.lastSweepSignature; },
      set lastSweepSignature(value) { engine.lastSweepSignature = value; },
      get lifecycleLockHolder() { return engine.lifecycleLockHolder; },
      get monitorRegistryNotify() { return engine.monitorRegistryNotify; },
      get monitorRegistryNow() { return engine.monitorRegistryNow; },
      get monitorRegistryPath() { return engine.monitorRegistryPath; },
      get monitorRegistrySweepInFlight() { return engine.monitorRegistrySweepInFlight; },
      set monitorRegistrySweepInFlight(value) { engine.monitorRegistrySweepInFlight = value; },
      get outboxDrain() { return engine.outboxDrain; },
      get outboxDrainInFlight() { return engine.outboxDrainInFlight; },
      set outboxDrainInFlight(value) { engine.outboxDrainInFlight = value; },
      get registry() { return engine.registry; },
      get sidebarSnapshot() { return engine.sidebarSnapshot; },
      get startupPurgePending() { return engine.startupPurgePending; },
      set startupPurgePending(value) { engine.startupPurgePending = value; },
      get startupPurgeRetainedAgentIds() { return engine.startupPurgeRetainedAgentIds; },
      get stateMgr() { return engine.stateMgr; },
      get sweepBackgroundProcessSnapshot() { return engine.sweepBackgroundProcessSnapshot; },
      set sweepBackgroundProcessSnapshot(value) { engine.sweepBackgroundProcessSnapshot = value; },
      get sweepDebugLog() { return engine.sweepDebugLog; },
      get sweepSkippedMutations() { return engine.sweepSkippedMutations; },
      set sweepSkippedMutations(value) { engine.sweepSkippedMutations = value; },
      get sweepSkippedReason() { return engine.sweepSkippedReason; },
      set sweepSkippedReason(value) { engine.sweepSkippedReason = value; },
      get sweepTelemetrySeq() { return engine.sweepTelemetrySeq; },
      set sweepTelemetrySeq(value) { engine.sweepTelemetrySeq = value; },
      get sweepTimer() { return engine.sweepTimer; },
      set sweepTimer(value) { engine.sweepTimer = value; },
      get sweepTiming() { return engine.sweepTiming; },
      set sweepTiming(value) { engine.sweepTiming = value; },
      get sweepTopologyGeneration() { return engine.sweepTopologyGeneration; },
      set sweepTopologyGeneration(value) { engine.sweepTopologyGeneration = value; },
      get unchangedSweepCount() { return engine.unchangedSweepCount; },
      set unchangedSweepCount(value) { engine.unchangedSweepCount = value; },
      get watchAgentObservation() { return engine.watchAgentObservation; },
      get watchNotify() { return engine.watchNotify; },
      get watchRegistryNow() { return engine.watchRegistryNow; },
      get watchRegistryPath() { return engine.watchRegistryPath; },
      get watchSweepInFlight() { return engine.watchSweepInFlight; },
      set watchSweepInFlight(value) { engine.watchSweepInFlight = value; },
      assertSweepInputCurrent: (...args) => engine.assertSweepInputCurrent(...args),
      collectObservedSurfaceTopology: (...args) => engine.collectObservedSurfaceTopology(...args),
      completeBenchmarkSweepHold: (...args) => engine.completeBenchmarkSweepHold(...args),
      countSkippedSweepTick: (...args) => engine.countSkippedSweepTick(...args),
      drainDeliveryQueue: (...args) => engine.drainDeliveryQueue(...args),
      drainOutboxBestEffort: (...args) => engine.drainOutboxBestEffort(...args),
      evictSurfacelessForSweep: (...args) => engine.evictSurfacelessForSweep(...args),
      holdBenchmarkSweepIfArmed: (...args) => engine.holdBenchmarkSweepIfArmed(...args),
      markIntentionalSurfaceCloses: (...args) => engine.markIntentionalSurfaceCloses(...args),
      nextSweepIntervalMs: (...args) => engine.nextSweepIntervalMs(...args),
      pruneClosedChildReportWatches: (...args) => engine.pruneClosedChildReportWatches(...args),
      purgeStartupTerminalAgents: (...args) => engine.purgeStartupTerminalAgents(...args),
      purgeTerminalForSweep: (...args) => engine.purgeTerminalForSweep(...args),
      reapChannelMarkersBestEffort: (...args) => engine.reapChannelMarkersBestEffort(...args),
      reconcileAgents: (...args) => engine.reconcileAgents(...args),
      reconcileRolePlacements: (...args) => engine.reconcileRolePlacements(...args),
      recordSweepStability: (...args) => engine.recordSweepStability(...args),
      retryClosedChildReportWatchPrune: (...args) => engine.retryClosedChildReportWatchPrune(...args),
      retryDeferredTranscriptCaptures: (...args) => engine.retryDeferredTranscriptCaptures(...args),
      runCloseForensicsBestEffort: (...args) => engine.runCloseForensicsBestEffort(...args),
      runLifecycleMutation: (...args) => engine.runLifecycleMutation(...args),
      runSweep: (...args) => engine.runSweep(...args),
      runSweepOnce: (...args) => engine.runSweepOnce(...args),
      scheduleClosedChildReportWatchPrune: (...args) => engine.scheduleClosedChildReportWatchPrune(...args),
      shouldYieldSweep: (...args) => engine.shouldYieldSweep(...args),
      sweepMonitorRegistryBestEffort: (...args) => engine.sweepMonitorRegistryBestEffort(...args),
      sweepStateSignature: (...args) => engine.sweepStateSignature(...args),
      sweepWatchesBestEffort: (...args) => engine.sweepWatchesBestEffort(...args),
      verifyPendingDeliveries: (...args) => engine.verifyPendingDeliveries(...args),
    };
    return this.sweepHostCache;
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

  // sweep: bodies live in ./engine/sweep.ts (CX-3).
  runSweep(...args: Parameters<typeof sweepImpl.runSweep>): ReturnType<typeof sweepImpl.runSweep> {
    return sweepImpl.runSweep.call(this.sweepHost(), ...args);
  }
  private completeBenchmarkSweepHold(...args: Parameters<typeof sweepImpl.completeBenchmarkSweepHold>): ReturnType<typeof sweepImpl.completeBenchmarkSweepHold> {
    return sweepImpl.completeBenchmarkSweepHold.call(this.sweepHost(), ...args);
  }
  private holdBenchmarkSweepIfArmed(...args: Parameters<typeof sweepImpl.holdBenchmarkSweepIfArmed>): ReturnType<typeof sweepImpl.holdBenchmarkSweepIfArmed> {
    return sweepImpl.holdBenchmarkSweepIfArmed.call(this.sweepHost(), ...args);
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

  // sweep: bodies live in ./engine/sweep.ts (CX-3).
  private runSweepOnce(...args: Parameters<typeof sweepImpl.runSweepOnce>): ReturnType<typeof sweepImpl.runSweepOnce> {
    return sweepImpl.runSweepOnce.call(this.sweepHost(), ...args);
  }
  private reapChannelMarkersBestEffort(...args: Parameters<typeof sweepImpl.reapChannelMarkersBestEffort>): ReturnType<typeof sweepImpl.reapChannelMarkersBestEffort> {
    return sweepImpl.reapChannelMarkersBestEffort.call(this.sweepHost(), ...args);
  }
  private runCloseForensicsBestEffort(...args: Parameters<typeof sweepImpl.runCloseForensicsBestEffort>): ReturnType<typeof sweepImpl.runCloseForensicsBestEffort> {
    return sweepImpl.runCloseForensicsBestEffort.call(this.sweepHost(), ...args);
  }
  private markIntentionalSurfaceCloses(...args: Parameters<typeof sweepImpl.markIntentionalSurfaceCloses>): ReturnType<typeof sweepImpl.markIntentionalSurfaceCloses> {
    return sweepImpl.markIntentionalSurfaceCloses.call(this.sweepHost(), ...args);
  }
  private sweepMonitorRegistryBestEffort(...args: Parameters<typeof sweepImpl.sweepMonitorRegistryBestEffort>): ReturnType<typeof sweepImpl.sweepMonitorRegistryBestEffort> {
    return sweepImpl.sweepMonitorRegistryBestEffort.call(this.sweepHost(), ...args);
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

  // sweep: bodies live in ./engine/sweep.ts (CX-3).
  private sweepWatchesBestEffort(...args: Parameters<typeof sweepImpl.sweepWatchesBestEffort>): ReturnType<typeof sweepImpl.sweepWatchesBestEffort> {
    return sweepImpl.sweepWatchesBestEffort.call(this.sweepHost(), ...args);
  }
  private drainOutboxBestEffort(...args: Parameters<typeof sweepImpl.drainOutboxBestEffort>): ReturnType<typeof sweepImpl.drainOutboxBestEffort> {
    return sweepImpl.drainOutboxBestEffort.call(this.sweepHost(), ...args);
  }
  private sweepStateSignature(...args: Parameters<typeof sweepImpl.sweepStateSignature>): ReturnType<typeof sweepImpl.sweepStateSignature> {
    return sweepImpl.sweepStateSignature.call(this.sweepHost(), ...args);
  }
  private recordSweepStability(...args: Parameters<typeof sweepImpl.recordSweepStability>): ReturnType<typeof sweepImpl.recordSweepStability> {
    return sweepImpl.recordSweepStability.call(this.sweepHost(), ...args);
  }
  private nextSweepIntervalMs(...args: Parameters<typeof sweepImpl.nextSweepIntervalMs>): ReturnType<typeof sweepImpl.nextSweepIntervalMs> {
    return sweepImpl.nextSweepIntervalMs.call(this.sweepHost(), ...args);
  }
  startSweep(...args: Parameters<typeof sweepImpl.startSweep>): ReturnType<typeof sweepImpl.startSweep> {
    return sweepImpl.startSweep.call(this.sweepHost(), ...args);
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

  // lifecycle: bodies live in ./engine/lifecycle.ts (CX-3); delegates keep call sites and spies.
  spawnAgent(...args: Parameters<typeof lifecycleImpl.spawnAgent>): ReturnType<typeof lifecycleImpl.spawnAgent> {
    return lifecycleImpl.spawnAgent.call(this.lifecycleHost(), ...args);
  }
  resumeAgent(...args: Parameters<typeof lifecycleImpl.resumeAgent>): ReturnType<typeof lifecycleImpl.resumeAgent> {
    return lifecycleImpl.resumeAgent.call(this.lifecycleHost(), ...args);
  }
  resolveResumeAgent(...args: Parameters<typeof lifecycleImpl.resolveResumeAgent>): ReturnType<typeof lifecycleImpl.resolveResumeAgent> {
    return lifecycleImpl.resolveResumeAgent.call(this.lifecycleHost(), ...args);
  }
  cascadeKill(...args: Parameters<typeof lifecycleImpl.cascadeKill>): ReturnType<typeof lifecycleImpl.cascadeKill> {
    return lifecycleImpl.cascadeKill.call(this.lifecycleHost(), ...args);
  }
  private geminiHasSettledReply(...args: Parameters<typeof lifecycleImpl.geminiHasSettledReply>): ReturnType<typeof lifecycleImpl.geminiHasSettledReply> {
    return lifecycleImpl.geminiHasSettledReply.call(this.lifecycleHost(), ...args);
  }
  private interactiveMatchScreenIsActive(...args: Parameters<typeof lifecycleImpl.interactiveMatchScreenIsActive>): ReturnType<typeof lifecycleImpl.interactiveMatchScreenIsActive> {
    return lifecycleImpl.interactiveMatchScreenIsActive.call(this.lifecycleHost(), ...args);
  }
  waitFor(...args: Parameters<typeof lifecycleImpl.waitFor>): ReturnType<typeof lifecycleImpl.waitFor> {
    return lifecycleImpl.waitFor.call(this.lifecycleHost(), ...args);
  }

  private lifecycleHostCache: lifecycleImpl.LifecycleHost | null = null;

  /** The members ./engine/lifecycle.ts needs, as live getters and forwarders. */
  private lifecycleHost(): lifecycleImpl.LifecycleHost {
    if (this.lifecycleHostCache) return this.lifecycleHostCache;
    const engine = this;
    this.lifecycleHostCache = {
      get client() { return engine.client; },
      get freshLiveStateProbe() { return engine.freshLiveStateProbe; },
      get freshLiveStates() { return engine.freshLiveStates; },
      get registry() { return engine.registry; },
      get seatRegistry() { return engine.seatRegistry; },
      get selfRegistrationSessionLookup() { return engine.selfRegistrationSessionLookup; },
      get selfRegistrationSessionResolver() { return engine.selfRegistrationSessionResolver; },
      get spawnGuard() { return engine.spawnGuard; },
      get spawnPreflight() { return engine.spawnPreflight; },
      get stateMgr() { return engine.stateMgr; },
      get stopPostConditionTimeoutMs() { return engine.stopPostConditionTimeoutMs; },
      assertSurfaceObserverEpochCurrent: (...args) => engine.assertSurfaceObserverEpochCurrent(...args),
      captureBootSessionId: (...args) => engine.captureBootSessionId(...args),
      captureCodexSpawnSessionId: (...args) => engine.captureCodexSpawnSessionId(...args),
      cleanupUnboundCreatedSurface: (...args) => engine.cleanupUnboundCreatedSurface(...args),
      createAgentSurface: (...args) => engine.createAgentSurface(...args),
      formatStopPostConditionError: (...args) => engine.formatStopPostConditionError(...args),
      geminiHasSettledReply: (...args) => engine.geminiHasSettledReply(...args),
      getTargetStateEvidenceSource: (...args) => engine.getTargetStateEvidenceSource(...args),
      interactiveMatchScreenIsActive: (...args) => engine.interactiveMatchScreenIsActive(...args),
      isAgentSurfaceGone: (...args) => engine.isAgentSurfaceGone(...args),
      isExactDurableSurfaceBinding: (...args) => engine.isExactDurableSurfaceBinding(...args),
      isPaneGone: (...args) => engine.isPaneGone(...args),
      isProcessConfirmedGone: (...args) => engine.isProcessConfirmedGone(...args),
      isProcessGone: (...args) => engine.isProcessGone(...args),
      isProcessMissingError: (...args) => engine.isProcessMissingError(...args),
      liveStateOf: (...args) => engine.liveStateOf(...args),
      readAgentScreen: (...args) => engine.readAgentScreen(...args),
      readStopPostCondition: (...args) => engine.readStopPostCondition(...args),
      reconcileRolePlacements: (...args) => engine.reconcileRolePlacements(...args),
      refreshLiveState: (...args) => engine.refreshLiveState(...args),
      refreshTargetStateEvidence: (...args) => engine.refreshTargetStateEvidence(...args),
      resolveAgentIoRoute: (...args) => engine.resolveAgentIoRoute(...args),
      resolveAgentRoute: (...args) => engine.resolveAgentRoute(...args),
      resolveAgentStopIoRoute: (...args) => engine.resolveAgentStopIoRoute(...args),
      resolveResumeAgent: (...args) => engine.resolveResumeAgent(...args),
      resolveStopSurfaceClosePolicy: (...args) => engine.resolveStopSurfaceClosePolicy(...args),
      resolveUnchangedAgentStopIoRoute: (...args) => engine.resolveUnchangedAgentStopIoRoute(...args),
      sameSurfaceRoute: (...args) => engine.sameSurfaceRoute(...args),
      schedulePostSpawnLivenessAssertion: (...args) => engine.schedulePostSpawnLivenessAssertion(...args),
      sendLaunchCommand: (...args) => engine.sendLaunchCommand(...args),
      stableSurfaceWriteOptions: (...args) => engine.stableSurfaceWriteOptions(...args),
      stopAgent: (...args) => engine.stopAgent(...args),
      terminationStateOf: (...args) => engine.terminationStateOf(...args),
      waitForStopPostCondition: (...args) => engine.waitForStopPostCondition(...args),
    };
    return this.lifecycleHostCache;
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

  // lifecycle: bodies live in ./engine/lifecycle.ts (CX-3).
  private readStopPostCondition(...args: Parameters<typeof lifecycleImpl.readStopPostCondition>): ReturnType<typeof lifecycleImpl.readStopPostCondition> {
    return lifecycleImpl.readStopPostCondition.call(this.lifecycleHost(), ...args);
  }
  private waitForStopPostCondition(...args: Parameters<typeof lifecycleImpl.waitForStopPostCondition>): ReturnType<typeof lifecycleImpl.waitForStopPostCondition> {
    return lifecycleImpl.waitForStopPostCondition.call(this.lifecycleHost(), ...args);
  }
  private formatStopPostConditionError(...args: Parameters<typeof lifecycleImpl.formatStopPostConditionError>): ReturnType<typeof lifecycleImpl.formatStopPostConditionError> {
    return lifecycleImpl.formatStopPostConditionError.call(this.lifecycleHost(), ...args);
  }
  stopAgent(...args: Parameters<typeof lifecycleImpl.stopAgent>): ReturnType<typeof lifecycleImpl.stopAgent> {
    return lifecycleImpl.stopAgent.call(this.lifecycleHost(), ...args);
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
