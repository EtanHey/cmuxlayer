/**
 * Engine types and constants, moved verbatim from agent-engine.ts (CX-2 E1).
 * Depends on nothing in the engine, so modules that only need a type
 * (agent-health, control-health, self-registration) no longer import the engine.
 */

import type { ClosureState } from "../coordination-paths.js";
import type { LiveAgentState } from "../live-agent-state.js";
import type {
  CmuxMoveSurfaceResult,
  CmuxPane,
  CmuxPaneSurfaces,
  CmuxNewSplitResult,
  CmuxNewSurfaceResult,
  CmuxReadScreenResult,
  CmuxSendOptions,
  CmuxStatusUpdate,
  CmuxWindow,
  CmuxWorkspace,
} from "../types.js";
import type { DeliveryFailureTicket } from "../delivery-failure-tickets.js";
import type {
  AgentRoute,
  AgentRecord,
  AgentAuthority,
  AgentFunction,
  AgentPlacement,
  AgentRole,
  AgentState,
  CliType,
  DeliveryEventType,
} from "../agent-types.js";
import type { CloseForensicsSweepResult } from "../close-forensics.js";
import type { WatchNotify } from "../watch-spec.js";
import type { RoleSurfaceIds } from "../layout-policy.js";
import type { SpawnGuard } from "../spawn-guard.js";
import type { SurfaceBindingObservation } from "../surface-binding-observation.js";
import type { SpawnModelPolicy } from "../model-policy.js";
import type { SeatRegistry } from "../seat-identity.js";
import type { MonitorDeadmanNotify } from "../monitor-registry.js";
import type {
  AllWindowWorkspaceEnumeration,
  SurfaceObserverEpoch,
  SurfaceTopologySnapshot,
} from "../surface-topology.js";
import type { TransportHealthSignal } from "../cmux-transport-self-heal.js";
import type { InboxOpts } from "../inbox.js";

/** Live-derived state for a record, injected by the server (F1). */
export type LiveStateResolver = (agent: AgentRecord) => LiveAgentState | null;

/**
 * AIDEV-NOTE (F1b round 2): the FORCING counterpart to `LiveStateResolver`.
 *
 * The sync resolver reads whatever screen scan happens to be cached, and the
 * cache is deliberately evidence-free once it is 2000ms old -- so a lead whose
 * next action after a spawn is `wait_for` gets no live evidence at all, and
 * every live gate in this file silently degrades to the poisoned record. This
 * probe reads ONE agent's screen on demand, so a wait can obtain its own
 * evidence instead of hoping somebody else scanned recently. Returns null when
 * the read fails or the surface does not bind to the record: no evidence, which
 * leaves the record unchallenged rather than inventing a state.
 */
export type FreshLiveStateProbe = (
  agent: AgentRecord,
) => Promise<LiveAgentState | null>;

export type AgentDeliveryState =
  | "typed"
  | "submitted"
  | "queued"
  | "queued_followup"
  | "rescued"
  | "failed"
  | "pending_verify"
  | "failed_confirmed"
  | "stalled_queue";

export interface AgentDeliveryReceipt {
  delivery_id: string;
  agent_id: string;
  text: string;
  press_enter: boolean;
  source_event: DeliveryEventType;
  delivery_state: AgentDeliveryState;
  terminal: boolean;
  created_at: string;
  resolved_at: string | null;
  retry_count: number;
  submit_verified: boolean | null;
  error: string | null;
  /** Successful socket RPCs used by this delivery; absent on legacy receipts. */
  rpc_methods?: Array<"surface.send_text" | "surface.send_key">;
  /** Text reached the target through either socket or CLI transport. */
  typed?: boolean;
  /** A submit key reached the target through either socket or CLI transport. */
  submit_dispatched?: boolean;
  /** An uncertain recovered boot Return; passive confirmation completes boot. */
  boot_recovery?: boolean;
  /** The exact boot generation whose pointer the receipt verifies. */
  boot_instance_id?: string;
  /** Durable one-time completion after the matching boot state is repaired. */
  boot_recovery_finalized_at?: string;
  /** Persisted before terminal mutation; a nonterminal value is never replayed after restart. */
  submission_started_at?: string | null;
  /** Earliest wall-clock time at which a known pre-mutation rejection may retry. */
  next_attempt_at?: string | null;
  /** The receiving TUI visibly accepted this into its own queue; never replay it. */
  composer_accepted?: boolean;
  /** Hard deadline for background verify; ISO timestamp. */
  verify_deadline_at?: string | null;
  /**
   * Hard deadline for a retryable requeue; ISO timestamp. Set on the first
   * retryable refusal so a target that never becomes interactive resolves
   * instead of leaving the caller an open queue forever (#467).
   */
  queue_deadline_at?: string | null;
  ticket_filed?: boolean;
  /** Whether the local evidence ticket was escalated to the issue tracker. */
  ticket_escalated?: boolean;
  /** Why escalation was declined, when it was. */
  ticket_escalation_declined_reason?: string | null;
  /** Consecutive verifier observations that the target agent is missing. */
  verify_miss_count?: number;
  /** Consecutive reads with this queued payload still visible on an idle target. */
  queue_idle_observations?: number;
  /** First verified idle observation for this queued payload; survives verifier restarts. */
  queue_idle_since_at?: string | null;
  /** First visible compaction marker for this queued payload; bounds the idle grace. */
  queue_compaction_seen_at?: string | null;
  /** Last time background verify actually read the target surface. */
  verify_last_attempt_at?: string | null;
  /** A nonterminal retry stall that now requires a human to inspect the pane. */
  needs_attention?: boolean;
  /** Evidence-backed explanation for the attention state. */
  attention_reason?: string | null;
  /** Consecutive retryable refusals observed on the same byte-identical screen. */
  unchanged_screen_retry_count?: number;
  /** Internal digest for comparing retry snapshots without persisting screen text. */
  retry_screen_fingerprint?: string | null;
  /** Delivery is owned by an already-running direct surface write, not the retry drain. */
  externally_managed?: boolean;
}

export const DEFAULT_DELIVERY_VERIFY_DEADLINE_MS = 10 * 60 * 1000;

export const DEFAULT_DELIVERY_QUEUE_DEADLINE_MS = 10 * 60 * 1000;

export const DELIVERY_TARGET_GONE_CONFIRM_MISSES = 3;

// Two 5-second sweeps can coincide with a transient Codex compaction pause.
export const DELIVERY_QUEUED_IDLE_MIN_MS = 15_000;

export const DELIVERY_COMPACTION_GRACE_MS = 30_000;

export const DELIVERY_UNCHANGED_SCREEN_ATTENTION_ATTEMPTS = 3;

export const DELIVERY_WAIT_POLL_MS = 100;

export type DeliveryVerifySnapshot = {
  text: string;
  parsed?: unknown;
};

export type DeliveryVerifyObservation = {
  outcome: "pending" | "delivered" | "failed_confirmed";
  submit_verified?: boolean | null;
  reason?: string;
  evidence?: Record<string, unknown>;
};

export type DeliveryVerifier = (
  receipt: AgentDeliveryReceipt,
  snapshot?: DeliveryVerifySnapshot | null,
) => Promise<DeliveryVerifyObservation>;

export type DeliverySnapshotReader = (
  receipt: AgentDeliveryReceipt,
) => Promise<DeliveryVerifySnapshot | null>;

export type DeliveryIssueFiler = (ticket: DeliveryFailureTicket) => Promise<void>;

/** A known pre-mutation delivery rejection that is safe to retry. */
export class RetryableDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableDeliveryError";
  }
}

export type DeliverySubmitter = (receipt: AgentDeliveryReceipt) => Promise<{
  retry_count: number;
  submit_verified: boolean | null;
  rpc_methods?: Array<"surface.send_text" | "surface.send_key">;
  typed?: boolean;
  submit_dispatched?: boolean;
  delivery?:
    | "submitted"
    | "queued"
    | "queued_followup"
    | "rescued"
    | "pending_verify";
}>;

export interface SpawnAgentParams {
  repo: string;
  /** False initializes the new runtime by input demand without focusing it. */
  focus?: boolean;
  runtime_metadata_supported?: boolean;
  model?: string;
  effort?: string;
  cli: CliType;
  prompt: string;
  boot_prompt_path?: string | null;
  boot_prompt_timeout_ms?: number;
  boot_prompt_pending?: boolean;
  workspace?: string;
  cwd?: string;
  mcp_env?: string;
  mcp_profile_label?: string;
  worktree_branch?: string;
  parent_agent_id?: string;
  collab_path?: string;
  role?: AgentRole;
  authority?: AgentAuthority;
  function?: AgentFunction;
  placement?: AgentPlacement;
  auto_archive_on_done?: boolean;
  /** Human label for the pane, shown after the agent id in the tab title. */
  title?: string;
  max_cost_per_agent?: number;
  halt_escalation?: boolean;
  /** Internal lifecycle hook: runs immediately after cmux creates and focuses
   * the surface, before launcher I/O or readiness polling can give the user time to move.
   */
  on_surface_created?: (surface: {
    agent_id: string;
    surface: string;
    workspace?: string;
  }) => void | Promise<void>;
}

export interface SpawnAgentResult {
  runtime_initialization?: "unsupported" | "already_ready" | "input_demand";
  agent_id: string;
  collab_path?: string | null;
  parent_agent_id: string | null;
  surface_id: string;
  workspace_id?: string;
  state: AgentState;
  model?: string;
  requested_model?: string;
  warnings?: string[];
  model_policy?: SpawnModelPolicy;
  cwd?: string;
  mcp_env?: string;
  /** Which door answered: the repoGolem launcher, or the raw CLI (#392). */
  launch_mode?: AgentLaunchMode;
  /** Whether the reported `model` was actually pinned, and by what (#433). */
  model_pin?: ModelPinSource;
  /** P11/U10: engine-issued coordination contract, returned in the receipt. */
  report_path?: string;
  done_marker?: string;
  /** Constraint 1: the contract's own byte cost, declared not buried (#424/#425). */
  coordination_footer_bytes?: number;
  /** P11b: file the boot pointer points at, carrying mailbox + report contract. */
  contract_path?: string;
  /** Provenance: whether the contract actually reached the worker at boot. */
  coordination_footer_delivered?: boolean;
  coordination_footer_note?: string;
}

export class AgentLaunchError extends Error {
  constructor(
    message: string,
    readonly agent_id: string,
    readonly surface_id: string,
    readonly workspace_id?: string,
    readonly launch_cause?: unknown,
    readonly launch_phase: "focus" | "launch" = "launch",
  ) {
    super(
      message,
      launch_cause === undefined ? undefined : { cause: launch_cause },
    );
    this.name = "AgentLaunchError";
  }
}

export type HarvestabilityDoneSource = "transcript" | "screen" | "none";

export interface HarvestabilityEvidenceChannel {
  done_source: HarvestabilityDoneSource;
  degraded: boolean;
  reason: string | null;
}

export interface KeptOpenContract {
  present: boolean;
  reason: string | null;
  owner: string | null;
  next_check: string | null;
  complete: boolean;
}

export interface WorkerHarvestability {
  closeable: boolean;
  /**
   * P11 Constraint 3: the state a caller reads at DEFAULT detail. Never a bare
   * boolean -- "done but unverified" (act now) and "still working" (wait) were
   * both `false` under the boolean, and the first is the S3 deadlock.
   */
  closure: ClosureState;
  closure_artifact_verified: boolean | null;
  report_path: string | null;
  done_marker: string | null;
  report_exists: boolean | null;
  report_fresh: boolean | null;
  report_final_line: string | null;
  pr_loop_required: boolean;
  pr_loop_satisfied: boolean | null;
  kept_open: KeptOpenContract | null;
  evidence_channel: HarvestabilityEvidenceChannel;
  issue_codes: string[];
  issues: string[];
}

export type AgentSurfacePlacement = CmuxNewSplitResult | CmuxNewSurfaceResult;

export type CreatedAgentSurface = AgentSurfacePlacement & {
  actual_workspace?: string;
  observerEpoch: SurfaceObserverEpoch;
  observerId: string | null;
};

export interface CapturedSessionIdentity {
  session_id: string;
  path?: string | null;
  pid?: number | null;
  pid_registered_at?: string | null;
}

export type SessionIdentityResolver = (
  agent: AgentRecord,
) => CapturedSessionIdentity | string | null;

/**
 * Result of the spawn preflight. `launcherName` carries the launcher function
 * name resolved from the launcher registry so spawnAgent launches the form
 * that actually registered, even when the prefix differs from the repo name.
 */
export interface SpawnPreflightResult {
  launcherName?: string;
  repoRoot?: string;
  /**
   * How the harness should be started. "launcher" runs the repoGolem wrapper
   * named by `launcherName`; "raw" runs the CLI binary directly with an
   * explicit cd into `repoRoot`. Defaults to "launcher" so existing callers
   * (and every test that stubs preflight) keep their current behaviour.
   */
  launchMode?: AgentLaunchMode;
  /**
   * Why the launcher registry did not answer, when it did not. Surfaced as a
   * spawn warning so a fallback past a PRESENT registry is legible instead of
   * silent -- a registered machine spawning raw is usually a typo'd repo.
   */
  launchModeReason?: string;
}

export type CodexModelListRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr?: string }>;

export interface AgentEngineOptions {
  /** Debug-only sweep phase timings. Defaults to stderr-safe console.debug. */
  sweepDebugLog?: (message: string) => void;
  spawnPreflight?: (
    params: SpawnAgentParams,
  ) => Promise<SpawnPreflightResult | void>;
  codexModelListRunner?: CodexModelListRunner;
  spawnGuard?: SpawnGuard;
  postSpawnLivenessMs?: number;
  stopPostConditionTimeoutMs?: number;
  /** Codex-only self-registration wait; clamped to the 2s product bound. */
  spawnSessionCaptureTimeoutMs?: number;
  /**
   * Optional fallback override after self-registration misses. When supplied,
   * it replaces the filesystem transcript scan (primarily for hermetic tests).
   */
  sessionIdentityResolver?: SessionIdentityResolver;
  /**
   * PRIMARY session-identity resolver: the self-registration READ side. When
   * provided (production entrypoints inject
   * `makeSelfRegistrationSessionResolver()`), it is tried BEFORE the deprecated
   * transcript scan and only falls through to the scan when it returns null.
   * Default (bare/test construction): unset, so the engine touches no real
   * registry file — hermetic like `outboxDrain`/`closeForensicsRunner`.
   */
  selfRegistrationSessionResolver?: SessionIdentityResolver;
  /** Reverse lookup used by resume_agent_id when callers supply a harness id. */
  selfRegistrationSessionLookup?: (
    sessionId: string,
  ) => SelfRegistrationSessionEntry | null;
  roleSurfaceIdsProvider?: (
    liveSurfaceIds?: ReadonlySet<string>,
    workspace?: string,
    observation?: SurfaceBindingObservation,
  ) => RoleSurfaceIds;
  launchCommandSender?: (input: {
    surface: string;
    stableSurfaceIdentity?: string | null;
    workspace?: string;
    command: string;
    timeout_ms?: number;
    assertSurfaceBindingCurrent: () => Promise<void>;
  }) => Promise<void>;
  inboxOpts?: InboxOpts;
  seatRegistry?: SeatRegistry | null;
  seatRegistryPath?: string;
  /**
   * Best-effort drain of the shared operator outbox, invoked at the end of each
   * sweep so any live agent's cmuxlayer flushes the fleet outbox to the notify
   * path without an explicit trigger. Defaults to a NO-OP so bare
   * construction (tests, libraries) never touches the real outbox or network;
   * production entrypoints inject `defaultOutboxDrain()`.
   */
  outboxDrain?: () => Promise<unknown>;
  /**
   * Optional monitor-registry deadman sweep. Omitted by default so tests and
   * library construction never read/write the real home-directory registry.
   * Production entrypoints pass the canonical path and injected notify hook.
   */
  monitorRegistryPath?: string;
  monitorRegistryNow?: () => number;
  monitorRegistryNotify?: MonitorDeadmanNotify;
  /** Persistent declared-watch registry. Disabled when omitted. */
  watchRegistryPath?: string;
  watchRegistryNow?: () => number;
  watchNotify?: WatchNotify;
  /**
   * Best-effort close-forensics ingest, run before absence reconciliation so a
   * cmux UI `tab_close` records the operator's intent on the matching managed
   * agent before absence reconciliation. Defaults to DISABLED (`null`) so bare
   * construction never reads the real cmux file; production entrypoints inject
   * the runner. Pass an explicit runner in tests.
   */
  closeForensicsRunner?:
    | (() => CloseForensicsSweepResult | Promise<CloseForensicsSweepResult>)
    | null;
  /**
   * Bound how long a queued lifecycle mutation waits for the lock before it
   * fails fast with a structured error naming the holder (#529).
   * Env: CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS. 0 disables the bound.
   */
  lifecycleLockAcquireTimeoutMs?: number;
  /**
   * Bound how long one lifecycle mutation may HOLD the lock before its tail
   * slot is force-released, so a wedged operation degrades one call instead of
   * poisoning every later caller (#529).
   * Env: CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS. 0 disables the guard.
   */
  lifecycleLockHoldTimeoutMs?: number;
  /** Bound one queued terminal submission so lifecycle sweeps cannot hang forever. */
  deliverySubmitTimeoutMs?: number;
  /** Bound one background verify observation so a hung reader cannot wedge later sweeps. */
  deliveryVerifyTimeoutMs?: number;
  /** How long a pending_verify delivery may stay nonterminal before failed_confirmed. */
  deliveryVerifyDeadlineMs?: number;
  deliveryQueueDeadlineMs?: number;
  /**
   * Local evidence-ticket directory. Omitted/null disables tickets so bare
   * construction never writes ~/.cmuxlayer/tickets or calls gh. Production
   * entrypoints inject the directory and filer.
   */
  deliveryTicketDir?: string;
  /** Optional GitHub/local ticket sink invoked once per failure signature. */
  deliveryIssueFiler?: DeliveryIssueFiler;
  /** Screen/transcript observer for pending deliveries. */
  deliveryVerifier?: DeliveryVerifier;
  /** Optional per-sweep surface reader so many receipts share one snapshot. */
  deliverySnapshotReader?: DeliverySnapshotReader;
  /** Deterministic clock and per-class dwell controls for live-halt escalation. */
  haltNow?: () => number;
  haltAwaitingInputDwellMs?: number;
  haltIdleWithoutDoneDwellMs?: number;
  haltWedgedDwellMs?: number;
  haltWedgedSweeps?: number;
  /** Test seam for process snapshots; production samples process time with ps. */
  haltProcessSnapshot?: () => string | Promise<string>;
}

export interface SelfRegistrationSessionEntry {
  session_id: string;
  surface_uuid: string;
  cwd: string | null;
  pid: number | null;
  cli: string | null;
  launcher: string | null;
  session_path: string | null;
  ts: number | null;
}

export type RolePlacementReconcileTrigger = "spawn" | "idle" | "boot";

export interface RolePlacementReconcileSummary {
  moved: Array<{
    agent_id: string;
    surface_id: string;
    from_column: number;
    to_column: number;
    pane: string;
  }>;
  skipped: Array<{
    agent_id: string;
    surface_id: string;
    reason: string;
  }>;
}

export type AgentLifecycleEvent = "spawned" | "done" | "errored" | "health";

export const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);

export const WAIT_FOR_SWEEP_INTERVAL_MS = 1000;

/** One retry: a watch observation must not read a transient failure as absence. */
export const WATCH_OBSERVATION_READ_ATTEMPTS = 2;

/**
 * How long a forced live-state observation stays usable, matched to
 * `AgentDiscovery`'s own 2000ms TTL so nothing in the fleet trusts screen
 * evidence longer than the scan cache would.
 */
export const LIVE_EVIDENCE_TTL_MS = 2000;

/**
 * Sweep cadence for re-forcing live evidence during a wait. One extra screen
 * read per agent per interval, and never older than `LIVE_EVIDENCE_TTL_MS` --
 * the two are the same number on purpose: the memo covers exactly the gap
 * between refreshes, so no tick ever decides on expired evidence.
 */
export const WAIT_FOR_LIVE_EVIDENCE_INTERVAL_MS = LIVE_EVIDENCE_TTL_MS;

export const DEFAULT_SWEEP_ACTIVE_INTERVAL_MS = 5_000;

export const DEFAULT_SWEEP_IDLE_INTERVAL_MS = 15_000;

export const DEFAULT_SWEEP_IDLE_AFTER_SWEEPS = 3;

export const DEFAULT_POST_SPAWN_LIVENESS_MS = 5_000;

export const DEFAULT_STOP_POST_CONDITION_TIMEOUT_MS = 1_000;

export const MAX_SPAWN_SESSION_CAPTURE_MS = 2_000;

export const SPAWN_SESSION_CAPTURE_POLL_MS = 50;

export const CHANNEL_MARKER_REAP_INTERVAL_MS = 60 * 60 * 1_000;

export const CHANNEL_MARKER_REAP_RETRY_MS = 60 * 1_000;

export const STOP_POST_CONDITION_POLL_MS = 50;

export const BOOT_SESSION_CAPTURE_LINES = 80;

export const MAX_DEFERRED_TRANSCRIPT_CAPTURE_ATTEMPTS = 3;

export const BOOT_READY_TIMEOUT_MS = 45_000;

export const BOOT_PROMPT_PENDING_STALE_MS = 5 * 60_000;

export const TASK_DONE_CONFIRMATION_MS = 5_000;

export const CLI_EXIT_SHELL_CONFIRMATION_SWEEPS = 2;

export const DEFAULT_HALT_AWAITING_INPUT_DWELL_MS = 120_000;

export const DEFAULT_HALT_IDLE_WITHOUT_DONE_DWELL_MS = 15 * 60_000;

export const DEFAULT_HALT_WEDGED_DWELL_MS = 120_000;

export const DEFAULT_HALT_WEDGED_SWEEPS = 3;

export const PROMPT_MOTION_GRACE_MS = 30_000;

export const MAX_AUTO_REVIVE_BACKOFF_MS = 30_000;

export const DONE_QUIESCENCE_MS = 1_500;

export const SESSION_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const SESSION_ID_RE = new RegExp(`\\b${SESSION_ID_PATTERN}\\b`, "gi");

export const CONTEXTUAL_SESSION_ID_PATTERNS = [
  new RegExp(
    `(?:codex\\s+resume|--resume(?:-id)?|resume-id)\\s+(${SESSION_ID_PATTERN})`,
    "i",
  ),
  new RegExp(`session\\s+id:\\s*(${SESSION_ID_PATTERN})`, "i"),
  new RegExp(`chatid:\\s*(${SESSION_ID_PATTERN})`, "i"),
  new RegExp(`resumable\\s+session:\\s*(${SESSION_ID_PATTERN})`, "i"),
] as const;

export const JSONL_HARNESSES = new Set<CliType>(["claude", "codex", "cursor"]);

export const TRANSCRIPT_SESSION_CAPTURE_STATES = new Set<AgentState>([
  "booting",
  "ready",
  "working",
  "idle",
]);

export interface SidebarStatusSnapshot {
  statusValue: string;
  surfaceId: string | null;
  workspaceId: string | null;
  healthSignature: string;
}

export interface HaltSinkResolution {
  sink: AgentRecord | null;
  fallback: boolean;
}

export interface SweepTimingOptions {
  activeIntervalMs: number;
  idleIntervalMs: number;
  idleAfterSweeps: number;
}

export type SweepTimingInput = number | Partial<SweepTimingOptions>;

export interface SweepAgentContext {
  sweep?: boolean;
  withUnlocked?: <T>(operation: () => Promise<T>) => Promise<T>;
  invalidated?: boolean;
  screen?: Promise<CmuxReadScreenResult>;
  route?: Promise<AgentRoute>;
  surfaceTopology?: SurfaceTopologySnapshot | null;
  observedSurfaceRef?: string | null;
  topologyGeneration?: number;
  skipAccounting?: SweepMutationSkipAccounting;
}

export interface SweepMutationSkipAccounting {
  counted: boolean;
}

export class PlacementSurfaceBindingError extends Error {}

export class LifecycleLockReacquireError extends Error {
  constructor(cause: unknown) {
    super("sweep could not reacquire lifecycle lock after I/O", { cause });
  }
}

export class PlacementTimeoutError extends PlacementSurfaceBindingError {
  readonly code = "placement_timeout";
}

export class PlacementPendingError extends PlacementSurfaceBindingError {
  readonly code = "placement_pending";

  constructor(message: string, readonly remainingMs: number) {
    super(message);
  }
}

export interface StopPostConditionResult {
  processGone: boolean;
  surfaceGone: boolean;
  paneGone: boolean;
  paneRef: string | null;
}

export interface StopSurfaceClosePolicy {
  paneRef: string | null;
  collapsePane: boolean;
}

export type TargetStateEvidenceSource = "state" | "transcript" | "screen";

export type RefreshedTargetStateEvidenceSource = Exclude<
  TargetStateEvidenceSource,
  "state"
>;

/**
 * #529: the lifecycle mutex used to be an unbounded chained promise. One hung
 * holder queued every later caller forever, and an operation that never
 * settled never ran its `finally`, permanently poisoning the tail for
 * `list_agents`, `spawn_agent`, `send_to` and the periodic sweep. Both waits
 * are bounded now, and the tail slot is released no matter what.
 */
/**
 * #530 review P2-1: both bounds must land INSIDE the ~120s harness inactivity
 * window, so a wedged control plane returns a structured error the caller can
 * still read rather than being cut off mid-wait.
 */
export const DEFAULT_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS = 45_000;

export const DEFAULT_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS = 120_000;

export const DEFAULT_SPAWN_PLACEMENT_TIMEOUT_MS = 60_000;

export const SPAWN_PLACEMENT_OBSERVE_INTERVAL_MS = 50;

// Both the socket RPC and CLI fallback default to a 10s command timeout.
// An unknown newSplit outcome must retain its guard for at least this long.
export const UNKNOWN_SPLIT_RPC_TIMEOUT_MS = 10_000;

export interface LifecycleLockTimeoutRecord {
  holder: string | null;
  waiter: string;
  waited_ms: number;
  held_for_ms: number | null;
  queue_depth: number;
  at: string;
}

export interface LifecycleLockState {
  holder: string | null;
  held_for_ms: number | null;
  queue_depth: number;
  acquire_timeout_ms: number;
  hold_timeout_ms: number;
  forced_releases: number;
  /** Sweep ticks that preserved state because topology could not authorize deletion. */
  sweep_skipped_mutations: number;
  sweep_skipped_reason: string | null;
  /** Sweep ticks that stopped early to let a queued lifecycle mutation run. */
  sweep_yielded: number;
  timeouts: number;
  last_timeout: LifecycleLockTimeoutRecord | null;
}

/** A queued lifecycle mutation gave up instead of waiting forever. */
export class LifecycleLockTimeoutError extends Error {
  readonly code = "ELIFECYCLELOCKTIMEOUT";
  readonly holder: string | null;
  readonly waiter: string;
  readonly waitedMs: number;
  readonly heldForMs: number | null;
  readonly queueDepth: number;

  constructor(opts: {
    holder: string | null;
    waiter: string;
    waitedMs: number;
    heldForMs: number | null;
    queueDepth: number;
  }) {
    super(
      `lifecycle lock acquire timed out after ${opts.waitedMs}ms for "${opts.waiter}"; ` +
        `holder="${opts.holder ?? "unknown"}" held_for_ms=${
          opts.heldForMs ?? "unknown"
        } queue_depth=${opts.queueDepth}. ` +
        "Retry; if it persists, see control_health.daemon_lifecycle.lifecycle_lock.",
    );
    this.name = "LifecycleLockTimeoutError";
    this.holder = opts.holder;
    this.waiter = opts.waiter;
    this.waitedMs = opts.waitedMs;
    this.heldForMs = opts.heldForMs;
    this.queueDepth = opts.queueDepth;
  }
}

export interface AgentEngineClient {
  supportsSurfaceRuntimeMetadata?: boolean;
  listTerminalMetadata?: () => Promise<{ terminals: import("../types.js").CmuxTerminalMetadata[] }>;
  getTransportHealth?(): TransportHealthSignal | null;
  /** Native and CLI clients accept a stable UUID as the read-screen target. */
  supportsStableSurfaceReads?: boolean;
  listWindows?(): Promise<{ windows: CmuxWindow[] }>;
  listAllWorkspaces?(): Promise<AllWindowWorkspaceEnumeration>;
  listWorkspaces(opts?: {
    window?: string;
  }): Promise<{ workspaces: CmuxWorkspace[] }>;
  log(
    message: string,
    opts?: {
      level?: "info" | "progress" | "success" | "warning" | "error";
      source?: string;
      workspace?: string;
      surface?: string;
    },
  ): Promise<void>;
  setStatus(
    key: string,
    value: string,
    opts?: {
      icon?: string;
      color?: string;
      workspace?: string;
      surface?: string;
    },
  ): Promise<void>;
  setStatuses?(updates: CmuxStatusUpdate[]): Promise<boolean | void>;
  readScreen(
    surface: string,
    opts?: { workspace?: string; lines?: number; scrollback?: boolean },
  ): Promise<CmuxReadScreenResult>;
  send(
    surface: string,
    text: string,
    opts?: CmuxSendOptions & {
      beforeMutation?: () => Promise<void>;
      stableSurfaceIdentity?: string | null;
    },
  ): Promise<void>;
  sendKey(
    surface: string,
    key: string,
    opts?: {
      workspace?: string;
      beforeMutation?: () => Promise<void>;
      stableSurfaceIdentity?: string | null;
    },
  ): Promise<void>;
  clearStatus(key: string, opts?: { workspace?: string }): Promise<void>;
  setProgress(
    value: number,
    opts?: { label?: string; workspace?: string; surface?: string },
  ): Promise<void>;
  clearProgress(opts?: { workspace?: string }): Promise<void>;
  newSplit(
    direction: string,
    opts?: {
      workspace?: string;
      surface?: string;
      pane?: string;
      type?: string;
      url?: string;
      title?: string;
      focus?: boolean;
      beforeMutation?: () => Promise<void>;
      stableSurfaceIdentity?: string | null;
    },
  ): Promise<CmuxNewSplitResult>;
  newSurface(opts: {
    pane: string;
    focus?: boolean;
    type?: "terminal" | "browser";
    workspace?: string;
    title?: string;
    url?: string;
  }): Promise<CmuxNewSurfaceResult>;
  renameTab(
    surface: string,
    title: string,
    opts?: { workspace?: string },
  ): Promise<void>;
  focusSurface(
    surface: string,
    opts?: {
      workspace?: string;
      beforeMutation?: () => Promise<void>;
    },
  ): Promise<void>;
  selectWorkspace(workspace: string): Promise<void>;
  listPanes(opts?: { workspace?: string }): Promise<{
    workspace_ref?: string;
    window_ref?: string;
    panes: CmuxPane[];
  }>;
  listPaneSurfaces(opts?: {
    workspace?: string;
    pane?: string;
  }): Promise<CmuxPaneSurfaces>;
  closeSurface(
    surface: string,
    opts?: {
      workspace?: string;
      collapsePane?: boolean;
      beforeMutation?: () => Promise<void>;
      stableSurfaceIdentity?: string | null;
    },
  ): Promise<void>;
  moveSurface(opts: {
    surface: string;
    pane?: string;
    workspace?: string;
    before?: string;
    after?: string;
    index?: number;
    focus?: boolean;
    beforeMutation?: () => Promise<void>;
    stableSurfaceIdentity?: string | null;
  }): Promise<CmuxMoveSurfaceResult>;
  notify?(opts?: {
    title?: string;
    subtitle?: string;
    body?: string;
    workspace?: string;
    surface?: string;
  }): Promise<void>;
  notifyLifecycleEvent(
    event: AgentLifecycleEvent,
    agent: AgentRecord,
    healthSummary?: string,
  ): Promise<void>;
}

/** State → sidebar icon/color mapping */
export const STATE_SIDEBAR: Record<AgentState, { icon: string; color: string }> = {
  creating: { icon: "gear", color: "#888888" },
  booting: { icon: "arrow.clockwise", color: "#F59E0B" },
  ready: { icon: "checkmark.circle", color: "#10B981" },
  working: { icon: "bolt.fill", color: "#3B82F6" },
  idle: { icon: "pause.circle", color: "#F97316" },
  done: { icon: "checkmark.square.fill", color: "#6B7280" },
  error: { icon: "xmark.circle.fill", color: "#EF4444" },
};

export const LIFECYCLE_LOGS = {
  spawned: { message: "spawned", level: "info" },
  done: { message: "done", level: "success" },
  errored: { message: "errored", level: "error" },
  health: { message: "health", level: "warning" },
} as const;

export type AgentLaunchMode = "launcher" | "raw";

/**
 * How the model the receipt reports was actually applied to the launch.
 *   launcher    - the repoGolem launcher carries the pin (canon §5)
 *   cli_flag    - raw mode passed an explicit --model/-m the CLI understands
 *   cli_default - raw mode passed NO model flag; the CLI uses its own
 *                 configured default, which may be a prior session's model
 *
 * AIDEV-NOTE (#433 family): the receipt must never claim a pin the command did
 * not apply. `cli_default` is the honest name for "unpinned", and it carries a
 * spawn warning rather than being reported silently.
 */
export type ModelPinSource = "launcher" | "cli_flag" | "cli_default";
