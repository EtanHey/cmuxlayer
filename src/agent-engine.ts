/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  resolveClosureState,
  type ClosureState,
} from "./coordination-paths.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { StateManager } from "./state-manager.js";
import { isSafeShellToken, sanitizeTerminalInput } from "./sanitize.js";
import {
  AGENT_ENV,
  buildRawResumeCommand,
  defaultKiroCd,
  rawResumeEchoCandidates,
  rawSkipApprovalFlag,
  sanitizeRepoName,
  shellQuote,
} from "./agent-command.js";
import {
  bypassesApprovals,
  resolveSpawnPermissionMode,
  type SpawnPermissionMode,
} from "./permission-mode.js";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
  type AgentFilter,
} from "./agent-registry.js";
import type { AgentDiscovery } from "./agent-discovery.js";
import {
  isLiveActive,
  resolveLiveAgentState,
  type LiveAgentState,
} from "./live-agent-state.js";

/** Live-derived state for a record, injected by the server (F1). */
export type LiveStateResolver = (agent: AgentRecord) => LiveAgentState | null;

import {
  resumeCommandForAgent,
  resumeCwdForAgent,
  resumeInvocationForAgent,
  toPublicAgent,
} from "./agent-facade.js";
import type {
  CmuxMoveSurfaceResult,
  CmuxPane,
  CmuxPaneSurfaces,
  CmuxNewSplitResult,
  CmuxNewSurfaceResult,
  CmuxReadScreenResult,
  CmuxSendOptions,
  CmuxStatusUpdate,
  CmuxWorkspace,
  ParsedScreenResult,
  ParsedScreenStatus,
} from "./types.js";
import {
  deliveryFailureSignature,
  writeDeliveryFailureTicket,
  type DeliveryFailureTicket,
} from "./delivery-failure-tickets.js";
import {
  generateAgentId,
  isCrashRecoveryEligible,
  isCrashRecoveryExhausted,
  MAX_SPAWN_DEPTH,
  MAX_CHILDREN,
  MAX_RESPAWN_ATTEMPTS,
  resolveBootPromptText,
  summarizeTaskSummary,
  type AgentRoute,
  type AgentRecord,
  type AgentAuthority,
  type AgentFunction,
  type AgentHaltType,
  type AgentPlacement,
  type AgentRole,
  type AgentState,
  type CliType,
  type CloseForensicsEvent,
  type DeliveryEventType,
  type PublicAgent,
  type WaitResult,
} from "./agent-types.js";
import type { CloseForensicsSweepResult } from "./close-forensics.js";
import {
  armWatch as armDeclaredWatch,
  readWatchRegistry,
  sweepWatches,
  type WatchAgentObservation,
  type WatchNotify,
  type WatchRecord,
  type WatchSpec,
} from "./watch-spec.js";
import {
  classifyPromptDisposition,
  cleanScreenText,
  containsPromptApprovalChooser,
  hasVisibleAgentProgress,
  isBlockingPromptChooserScreen,
  isPromptResolutionAuditSafe,
  parseScreen,
  type PromptDisposition,
} from "./screen-parser.js";
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
  launcherNameForCli,
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
  CODEX_EFFORT_VALUES,
  MODEL_OVERRIDE_ENV,
  resolveLaunchModelFlag,
  resolveSpawnEffort,
  resolveSpawnModelPolicy,
  type CodexEffort,
  type SpawnModelPolicy,
} from "./model-policy.js";
import {
  DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY,
  evaluateAgentHealth,
  type AgentHealth,
  type AgentHealthInput,
} from "./agent-health.js";
import {
  launcherNameCandidates,
  loadLauncherRegistrySnapshot,
  resolveLauncherNameFromRegistry,
  resolveLauncherNameFromRegistryOrNull,
  resolveRepoRootFromLauncherRegistry,
  type LauncherRegistryOptions,
  type LauncherSuffix,
} from "./launcher-registry.js";
import { buildAgentHealthInput } from "./agent-health-input.js";
import {
  defaultRepoCheckoutPath,
  resolveRepoRootWithoutRegistry,
  type RepoRootFallbackOptions,
} from "./repo-root-fallback.js";
import {
  assertSeatIdentity,
  loadSeatRegistryFromConfig,
  type SeatRegistry,
} from "./seat-identity.js";
import {
  latestMonitorForOwnerSeats,
  readMonitorRegistry,
  sweepMonitorRegistry,
  transferMonitorRegistryOwner,
  type MonitorDeadmanNotify,
} from "./monitor-registry.js";
import {
  captureSurfaceObserverEpoch as captureObserverEpoch,
  collectSurfaceTopology,
  EMPTY_SURFACE_TOPOLOGY,
  healthTopologyOverrides,
  isSurfaceObserverEpochCurrent,
  resolveAgentSurfaceBinding,
  type SurfaceObserverEpoch,
  type SurfaceObserverIdProvider,
  type SurfaceTopologySnapshot,
} from "./surface-topology.js";
import {
  DEFAULT_CHANNEL_MARKER_RETENTION_MS,
  dispatchOnce,
  readInbox,
  reapOrphanedPendingChannelMarkers,
  removePendingChannelMarkerAfterRegistration,
  type InboxOpts,
} from "./inbox.js";
import {
  buildFleetSidebarSnapshot,
  DEFAULT_FLEET_WORKING_NO_PROGRESS_TIMEOUT_MS,
  type FleetSidebarCandidate,
  type FleetSidebarPublisherLike,
} from "./fleet-sidebar.js";

type ProcessLiveness = "alive" | "gone" | "unknown";

export type AgentDeliveryState =
  | "submitted"
  | "queued"
  | "queued_followup"
  | "failed"
  | "pending_verify"
  | "failed_confirmed";

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
  /** Last time background verify actually read the target surface. */
  verify_last_attempt_at?: string | null;
}

export const DEFAULT_DELIVERY_VERIFY_DEADLINE_MS = 10 * 60 * 1000;
export const DEFAULT_DELIVERY_QUEUE_DEADLINE_MS = 10 * 60 * 1000;
export const DELIVERY_TARGET_GONE_CONFIRM_MISSES = 3;
const DELIVERY_WAIT_POLL_MS = 100;

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

type DeliveryVerifier = (
  receipt: AgentDeliveryReceipt,
  snapshot?: DeliveryVerifySnapshot | null,
) => Promise<DeliveryVerifyObservation>;

type DeliverySnapshotReader = (
  receipt: AgentDeliveryReceipt,
) => Promise<DeliveryVerifySnapshot | null>;

type DeliveryIssueFiler = (ticket: DeliveryFailureTicket) => Promise<void>;

/** A known pre-mutation delivery rejection that is safe to retry. */
export class RetryableDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableDeliveryError";
  }
}

type DeliverySubmitter = (receipt: AgentDeliveryReceipt) => Promise<{
  retry_count: number;
  submit_verified: boolean | null;
  delivery?: "submitted" | "queued" | "queued_followup" | "pending_verify";
}>;

export interface SpawnAgentParams {
  repo: string;
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
  role?: AgentRole;
  authority?: AgentAuthority;
  function?: AgentFunction;
  placement?: AgentPlacement;
  auto_archive_on_done?: boolean;
  max_cost_per_agent?: number;
  crash_recover?: boolean;
  auto_revive?: boolean;
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
  agent_id: string;
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

type AgentSurfacePlacement = CmuxNewSplitResult | CmuxNewSurfaceResult;

type CreatedAgentSurface = AgentSurfacePlacement & {
  actual_workspace?: string;
  observerEpoch: SurfaceObserverEpoch;
  observerId: string | null;
};

export interface CapturedSessionIdentity {
  session_id: string;
  path?: string | null;
}

export type SessionIdentityResolver = (
  agent: AgentRecord,
) => CapturedSessionIdentity | string | null;

function defaultCrashRecoverForRole(role: AgentRole): boolean {
  const override = process.env.CMUXLAYER_CRASH_RECOVER_DEFAULT;
  if (override === "1" || override?.toLowerCase() === "true") return true;
  if (override === "0" || override?.toLowerCase() === "false") return false;
  return role === "orchestrator";
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

const execFileAsync = promisify(execFile);

async function defaultCodexModelListRunner(
  args: string[],
): Promise<{ stdout: string; stderr?: string }> {
  return execFileAsync("codex", args, {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function parseCodexModelSlugs(stdout: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Codex model discovery returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }. No agent was spawned.`,
    );
  }
  const models =
    payload && typeof payload === "object" && "models" in payload
      ? (payload as { models?: unknown }).models
      : null;
  const slugs = Array.isArray(models)
    ? models.flatMap((model) => {
        if (typeof model === "string") return [model];
        if (model && typeof model === "object" && "slug" in model) {
          const slug = (model as { slug?: unknown }).slug;
          return typeof slug === "string" ? [slug] : [];
        }
        return [];
      })
    : [];
  if (slugs.length === 0) {
    throw new Error(
      "Codex model discovery returned no models. No agent was spawned.",
    );
  }
  return slugs;
}

async function validateCodexModel(
  model: string | undefined,
  runner: CodexModelListRunner,
): Promise<void> {
  if (!model?.trim() || model.trim().toLowerCase() === "codex") return;

  let result: { stdout: string; stderr?: string };
  try {
    result = await runner(["debug", "models", "--bundled"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to discover Codex models: ${message}. No agent was spawned.`,
    );
  }
  const models = parseCodexModelSlugs(result.stdout);
  if (!models.includes(model.trim())) {
    throw new Error(
      `Unsupported Codex model "${model.trim()}". Codex models: ${models.join(", ")}. No agent was spawned.`,
    );
  }
}

export interface CrashRecoveryMutationInput {
  phase: "placement" | "resume";
  agent_id: string;
  surface?: string;
  workspace?: string;
}

export interface AgentEngineOptions {
  spawnPreflight?: (
    params: SpawnAgentParams,
  ) => Promise<SpawnPreflightResult | void>;
  codexModelListRunner?: CodexModelListRunner;
  spawnGuard?: SpawnGuard;
  postSpawnLivenessMs?: number;
  stopPostConditionTimeoutMs?: number;
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
  /**
   * Optional production policy gate for autonomous crash-recovery writes.
   * Placement is checked before a surface is created; resume is checked again
   * against the created surface immediately before state is rebound/launched.
   */
  beforeCrashRecoveryMutation?: (
    input: CrashRecoveryMutationInput,
  ) => Promise<void>;
  inboxOpts?: InboxOpts;
  seatRegistry?: SeatRegistry | null;
  seatRegistryPath?: string;
  /**
   * Best-effort drain of the shared operator outbox, invoked at the end of each
   * sweep so any live agent's cmuxlayer flushes `~/.golems-zikaron/outbox.md` to
   * the notify path without an explicit trigger. Defaults to a NO-OP so bare
   * construction (tests, libraries) never touches the real outbox or network;
   * production entrypoints inject `() => drainOutbox()`.
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
   * cmux UI `tab_close` can make the matching managed agent terminal before
   * crash recovery evaluates it. Defaults to DISABLED (`null`) so bare
   * construction never reads the real cmux file; production entrypoints inject
   * the runner. Pass an explicit runner in tests.
   */
  closeForensicsRunner?:
    | (() => CloseForensicsSweepResult | Promise<CloseForensicsSweepResult>)
    | null;
  /**
   * Receives the reconciled registry, topology, health, and screen evidence.
   * Defaults to a NO-OP so bare engines never write operator configuration.
   */
  fleetSidebarPublisher?: FleetSidebarPublisherLike;
  /** Render-only timeout for a working seat whose transcript/output stops advancing. */
  fleetWorkingNoProgressTimeoutMs?: number;
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
  /** Base delay for same-surface CLI auto-revive retries. */
  autoReviveBackoffBaseMs?: number;
  /** Deterministic clock and per-class dwell controls for live-halt escalation. */
  haltNow?: () => number;
  haltAwaitingInputDwellMs?: number;
  haltIdleWithoutDoneDwellMs?: number;
  haltWedgedDwellMs?: number;
  haltWedgedSweeps?: number;
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

const INTERACTIVE_STATES = new Set<AgentState>(["ready", "idle"]);
const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);
const WAIT_FOR_SWEEP_INTERVAL_MS = 1000;
const DEFAULT_SWEEP_ACTIVE_INTERVAL_MS = 5_000;
const DEFAULT_SWEEP_IDLE_INTERVAL_MS = 15_000;
const DEFAULT_SWEEP_IDLE_AFTER_SWEEPS = 3;
const FLEET_SIDEBAR_WAKE_REPUBLISH_DELAY_MS = 500;
const DEFAULT_POST_SPAWN_LIVENESS_MS = 5_000;
const DEFAULT_STOP_POST_CONDITION_TIMEOUT_MS = 1_000;
const CHANNEL_MARKER_REAP_INTERVAL_MS = 60 * 60 * 1_000;
const CHANNEL_MARKER_REAP_RETRY_MS = 60 * 1_000;
const STOP_POST_CONDITION_POLL_MS = 50;
const BOOT_SESSION_CAPTURE_LINES = 80;
const MAX_DEFERRED_TRANSCRIPT_CAPTURE_ATTEMPTS = 3;
const BOOT_READY_TIMEOUT_MS = 45_000;
const BOOT_PROMPT_PENDING_STALE_MS = 5 * 60_000;
const TASK_DONE_CONFIRMATION_MS = 5_000;
const CLI_EXIT_SHELL_CONFIRMATION_SWEEPS = 2;
const CLI_EXIT_ERROR = "Agent CLI exited to shell without done evidence";
const DEFAULT_AUTO_REVIVE_BACKOFF_BASE_MS = 1_000;
const DEFAULT_HALT_AWAITING_INPUT_DWELL_MS = 120_000;
const DEFAULT_HALT_IDLE_WITHOUT_DONE_DWELL_MS = 15 * 60_000;
const DEFAULT_HALT_WEDGED_DWELL_MS = 120_000;
const DEFAULT_HALT_WEDGED_SWEEPS = 3;
const PROMPT_MOTION_GRACE_MS = 30_000;
const MAX_AUTO_REVIVE_BACKOFF_MS = 30_000;
/**
 * Harness responses that mean "I refused this resume command" -- a wrong flag,
 * an unknown/expired session, or no such binary. Matched only against the screen
 * tail that follows our own echoed resume command.
 */
const RESUME_REJECTION_RE =
  /\b(?:unknown option|unknown argument|unknown flag|unrecognized (?:option|argument)|unexpected argument|command not found|no rollout found|failed to resume|session not found|no such session|invalid session)\b/i;
const DONE_QUIESCENCE_MS = 1_500;
const SESSION_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID_RE = new RegExp(`\\b${SESSION_ID_PATTERN}\\b`, "gi");
const CONTEXTUAL_SESSION_ID_PATTERNS = [
  new RegExp(
    `(?:codex\\s+resume|--resume(?:-id)?|resume-id)\\s+(${SESSION_ID_PATTERN})`,
    "i",
  ),
  new RegExp(`session\\s+id:\\s*(${SESSION_ID_PATTERN})`, "i"),
  new RegExp(`chatid:\\s*(${SESSION_ID_PATTERN})`, "i"),
  new RegExp(`resumable\\s+session:\\s*(${SESSION_ID_PATTERN})`, "i"),
] as const;
const JSONL_HARNESSES = new Set<CliType>(["claude", "codex", "cursor"]);
const TRANSCRIPT_SESSION_CAPTURE_STATES = new Set<AgentState>([
  "booting",
  "ready",
  "working",
  "idle",
]);

function toParsedScreenStatus(
  status: string | null | undefined,
): ParsedScreenStatus | null {
  switch (status) {
    case "frozen":
    case "thinking":
    case "working":
    case "idle":
    case "done":
      return status;
    default:
      return null;
  }
}

/**
 * Loosely compare the requested model with the model reported by the live CLI.
 * A missing side is unknown rather than a match.
 */
export function computeModelMismatch(
  requestedModel: string,
  parsedModel: string | null,
): boolean | null {
  const requested = requestedModel.toLowerCase().trim();
  const parsed = parsedModel?.toLowerCase().trim();
  if (!requested || !parsed) return null;
  return !parsed.includes(requested) && !requested.includes(parsed);
}

export function parseCodexEffort(
  parsedModel: string | null,
): CodexEffort | null {
  const candidate = parsedModel?.trim().split(/\s+/).at(-1)?.toLowerCase();
  return candidate &&
    (CODEX_EFFORT_VALUES as readonly string[]).includes(candidate)
    ? (candidate as CodexEffort)
    : null;
}

export function computeEffortMismatch(
  requestedEffort: string | null | undefined,
  parsedEffort: string | null,
): boolean | null {
  const requested = requestedEffort?.trim().toLowerCase();
  if (!requested || !parsedEffort) return null;
  return requested !== parsedEffort;
}

export { buildRawResumeCommand, buildResumeCommand } from "./agent-command.js";

interface SidebarStatusSnapshot {
  statusValue: string;
  surfaceId: string | null;
  workspaceId: string | null;
  healthSignature: string;
}

interface FleetScreenProgressSnapshot {
  signature: string;
  lastProgressAtMs: number;
}

interface HaltSinkResolution {
  sink: AgentRecord | null;
  fallback: boolean;
}

export interface SweepTimingOptions {
  activeIntervalMs: number;
  idleIntervalMs: number;
  idleAfterSweeps: number;
}

type SweepTimingInput = number | Partial<SweepTimingOptions>;

interface SweepAgentContext {
  screen?: Promise<CmuxReadScreenResult>;
  route?: Promise<AgentRoute>;
}

class PlacementSurfaceBindingError extends Error {}

interface StopPostConditionResult {
  processGone: boolean;
  surfaceGone: boolean;
  paneGone: boolean;
  paneRef: string | null;
}

interface StopSurfaceClosePolicy {
  paneRef: string | null;
  collapsePane: boolean;
}

type TargetStateEvidenceSource = "state" | "transcript" | "screen";
type RefreshedTargetStateEvidenceSource = Exclude<
  TargetStateEvidenceSource,
  "state"
>;

function tailScreenLines(text: string, lines: number): string {
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

function screenTextSignature(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

function resumeAwaitsFreshReadiness(
  agent: AgentRecord,
  screenText: string,
): boolean {
  if (
    agent.auto_revive === false ||
    agent.revive_last_outcome !== "pending" ||
    !agent.cli_session_id
  ) {
    return false;
  }
  // Recognition, not emission: scan every form a resume may have been typed
  // as, including ones this build no longer sends (see rawResumeEchoCandidates).
  const echo = latestRawResumeEcho(
    screenText,
    agent.cli,
    agent.repo,
    agent.cli_session_id,
  );
  if (!echo) return false;
  if (echo.index < 0) return true;
  const afterResume = screenText.slice(echo.index + echo.command.length);
  const parsed = parseScreen(afterResume);
  const hasFreshIdentity =
    screenHasReadyAgentIdentity(agent.cli, afterResume, parsed) ||
    (agent.cli === "codex" &&
      /\bgpt-\d[\w.-]*(?:\s+\w+)?\s*·[^\n]*/i.test(afterResume));
  return !(
    parsed.control_state !== "shell" &&
    hasFreshIdentity &&
    (matchReadyPattern(agent.cli, afterResume).matched ||
      screenHasActiveAgentMarker(agent.cli, afterResume, parsed))
  );
}

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

interface AgentEngineClient {
  listWorkspaces(): Promise<{ workspaces: CmuxWorkspace[] }>;
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
const STATE_SIDEBAR: Record<AgentState, { icon: string; color: string }> = {
  creating: { icon: "gear", color: "#888888" },
  booting: { icon: "arrow.clockwise", color: "#F59E0B" },
  ready: { icon: "checkmark.circle", color: "#10B981" },
  working: { icon: "bolt.fill", color: "#3B82F6" },
  idle: { icon: "pause.circle", color: "#F97316" },
  done: { icon: "checkmark.square.fill", color: "#6B7280" },
  error: { icon: "xmark.circle.fill", color: "#EF4444" },
};

const LIFECYCLE_LOGS = {
  spawned: { message: "spawned", level: "info" },
  done: { message: "done", level: "success" },
  errored: { message: "errored", level: "error" },
  health: { message: "health", level: "warning" },
} as const;

/**
 * Build the shell command that launches a CLI agent.
 * Repo name is sanitized to prevent command injection.
 *
 * For claude/codex/cursor/gemini: uses repoGolem launchers (e.g.
 * `voicelayerClaude -s`, `golemsGemini -s`) which handle cd, model,
 * iTerm profile, MCP config (brainlayer etc.), and contexts.
 * No `cd` prefix needed — the launcher does it.
 *
 * For kiro: uses `cd ~/Gits/<repo> && kiro-cli` since it doesn't have
 * a launcher function yet.
 */
function formatModelArg(modelFlag: string): string {
  return isSafeShellToken(modelFlag) ? modelFlag : shellQuote(modelFlag);
}

function modelMatchesDefaultForLaunch(cli: CliType, model?: string): boolean {
  return cli === "codex" && model?.trim().toLowerCase() === "codex";
}

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

/**
 * Model tokens in this repo are LAUNCHER vocabulary: `claude-opus-5[1m]`,
 * `pro`, `codex`, `auto`. Raw binaries do not share it. This returns the token
 * that is safe to hand a raw CLI, or null when the pin cannot be expressed.
 *
 * - claude/codex/cursor: the resolved flag is already a real CLI model name
 *   (`sonnet`, `gpt-5.4`, ...) because resolveLaunchModelFlag only emits one
 *   when the caller asked for a specific model.
 * - gemini: `pro`/`flash`/`pro-high` are repoGolem aliases that raw gemini
 *   does not define, so only canonical `gemini-*` names are passed through.
 */
export function rawModelFlagToken(
  cli: CliType,
  modelFlag: string | null,
): string | null {
  if (!modelFlag) return null;
  if (cli === "gemini" && !/^gemini-/i.test(modelFlag.trim())) return null;
  return modelFlag;
}

/**
 * The exact model flag buildLaunchCommand will resolve for these inputs.
 * Exported so spawn can report the pin it actually applied without
 * re-deriving (and drifting from) the command builder's own logic.
 */
export function resolveLaunchModelFlagForCommand(
  cli: CliType,
  model: string | undefined,
  opts?: { allowModelOverride?: boolean },
): string | null {
  return resolveLaunchModelFlag(cli, model, {
    allowModelOverride:
      opts?.allowModelOverride ??
      (cli === "codex" &&
        Boolean(model?.trim()) &&
        !modelMatchesDefaultForLaunch(cli, model)),
  });
}

/** Truthful model provenance for a launch, plus the warning it owes the caller. */
export function describeModelPin(
  cli: CliType,
  launchMode: AgentLaunchMode,
  modelFlag: string | null,
  effectiveModel: string | undefined,
): { pin: ModelPinSource; warning: string | null } {
  if (launchMode === "launcher") return { pin: "launcher", warning: null };
  if (cli === "kiro") return { pin: "launcher", warning: null };
  if (rawModelFlagToken(cli, modelFlag)) {
    return { pin: "cli_flag", warning: null };
  }
  const claimed = effectiveModel?.trim();
  return {
    pin: "cli_default",
    warning:
      `MODEL PIN NOT APPLIED: this is a raw ${cli} launch (no repoGolem ` +
      `launcher for this repo), and ${cli} accepts no flag for ` +
      `"${claimed ?? "the policy default"}". The agent starts on whichever ` +
      `model ${cli} has configured, which may be a prior session's. ` +
      `model_pin="cli_default" -- the reported model is the policy default, ` +
      `not an applied pin. Register a repoGolem launcher to pin it.`,
  };
}

export function buildLaunchCommand(
  cli: CliType,
  repo: string,
  model?: string,
  // Resolved launcher function name from launchers.zsh. When provided
  // for a launcher CLI it overrides the naive `${repo}${Suffix}` guess so
  // registry-prefix registrations launch correctly. Honored for the launcher
  // CLIs (claude/codex/cursor/gemini); ignored for kiro (raw cd+exec).
  launcherName?: string,
  opts?: {
    cwd?: string;
    envPrefix?: string;
    allowModelOverride?: boolean;
    effort?: CodexEffort;
    launchMode?: AgentLaunchMode;
    /** Approval handling for this launch; defaults to the machine's setting. */
    permissionMode?: SpawnPermissionMode;
  },
): string {
  const safeRepo = sanitizeRepoName(repo);
  const modelFlag = resolveLaunchModelFlagForCommand(cli, model, {
    allowModelOverride: opts?.allowModelOverride,
  });
  const formattedModelFlag = modelFlag ? formatModelArg(modelFlag) : null;
  const launcherModelArgs = formattedModelFlag
    ? ` -m ${formattedModelFlag}`
    : "";
  const claudeModelArgs = modelFlag === "sonnet" ? " -S" : launcherModelArgs;
  const rawModelArgs = formattedModelFlag
    ? ` --model ${formattedModelFlag}`
    : "";
  const bypassApprovals = bypassesApprovals(
    opts?.permissionMode ?? resolveSpawnPermissionMode(),
  );
  const launcherSkipArg = bypassApprovals ? " -s" : "";
  const launcherWorktreeArg = opts?.cwd ? ` -w ${shellQuote(opts.cwd)}` : "";
  const launcherEffortArg = opts?.effort ? ` -E ${opts.effort}` : "";
  const rawCdPrefix = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ` : "";
  const codexModelOverride =
    cli === "codex" && modelFlag !== null && modelFlag !== "codex";
  const envParts = [
    codexModelOverride ? `${MODEL_OVERRIDE_ENV}=1` : null,
    opts?.envPrefix ?? null,
  ].filter((part): part is string => Boolean(part));
  const envPrefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";

  // AIDEV-NOTE (issue #392): registry-optional launch. With no repoGolem
  // launcher registered, spawn drops to the raw CLI and does the cd itself
  // (the launcher normally owns that). Registered installs are untouched --
  // "raw" is only ever requested explicitly by preflight.
  if (opts?.launchMode === "raw" && cli !== "kiro") {
    // REPOGOLEM_ALLOW_MODEL is a launcher-only escape hatch; it means nothing
    // to a raw binary, so raw mode carries only the harness + caller env.
    const rawEnvParts = [
      cli === "claude" || cli === "gemini" ? AGENT_ENV : null,
      opts?.envPrefix ?? null,
    ].filter((part): part is string => Boolean(part));
    const rawEnvPrefix =
      rawEnvParts.length > 0 ? `${rawEnvParts.join(" ")} ` : "";
    const skipFlag = rawSkipApprovalFlag(cli, opts?.permissionMode);
    const rawEffortArg =
      cli === "codex" && opts?.effort
        ? ` -c model_reasoning_effort=${opts.effort}`
        : "";
    // Only pass a model the raw binary actually understands; launcher-only
    // vocabulary is dropped here and disclosed by describeModelPin instead.
    const rawToken = rawModelFlagToken(cli, modelFlag);
    const formattedRawToken = rawToken ? formatModelArg(rawToken) : null;
    // `codex` takes `-m`; claude/cursor/gemini all accept `--model`.
    const rawModelFlag = formattedRawToken
      ? cli === "codex"
        ? ` -m ${formattedRawToken}`
        : ` --model ${formattedRawToken}`
      : "";
    const binary = cli === "cursor" ? "cursor agent" : cli;
    return `${rawCdPrefix}${rawEnvPrefix}${binary}${
      skipFlag ? ` ${skipFlag}` : ""
    }${rawModelFlag}${rawEffortArg}`;
  }

  switch (cli) {
    case "claude":
      // repoGolem launcher handles env vars via ralph-registry
      return `${envPrefix}${launcherName ?? `${safeRepo}Claude`}${launcherSkipArg}${claudeModelArgs}${launcherWorktreeArg}`;
    case "codex":
      return `${envPrefix}${launcherName ?? `${safeRepo}Codex`}${launcherSkipArg}${launcherModelArgs}${launcherEffortArg}${launcherWorktreeArg}`;
    case "gemini":
      // repoGolem launcher (e.g. golemsGemini -s) wires antigravity + MCP.
      return `${envPrefix}${launcherName ?? `${safeRepo}Gemini`}${launcherSkipArg}${launcherModelArgs}${launcherWorktreeArg}`;
    case "kiro":
      return `${rawCdPrefix || defaultKiroCd(repo)}${envPrefix}${AGENT_ENV} kiro-cli${rawModelArgs}`;
    case "cursor":
      // repoGolem launcher - requires registration via golem-powers.
      return `${envPrefix}${launcherName ?? `${safeRepo}Cursor`}${launcherSkipArg}${launcherModelArgs}${launcherWorktreeArg}`;
  }
}

export function extractSessionId(text: string): string | null {
  for (const pattern of CONTEXTUAL_SESSION_ID_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const matches = [...text.matchAll(SESSION_ID_RE)].map((match) => match[0]);
  const uniqueMatches = [...new Set(matches)];
  return uniqueMatches.length === 1 ? uniqueMatches[0] : null;
}

/**
 * `buildRawResumeCommand` throws for harnesses with no UUID resume form
 * (gemini) and for malformed session ids. The same-surface auto-revive paths
 * treat that as "not revivable", never as a sweep-breaking error.
 */
function rawResumeCommandOrNull(
  cli: CliType,
  repo: string,
  sessionId: string,
  opts?: { cwd?: string | null },
): string | null {
  try {
    return buildRawResumeCommand(cli, repo, sessionId, opts);
  } catch {
    return null;
  }
}

/**
 * Last position in `screenText` at which any recognized raw-resume form for
 * this agent appears. `null` means the harness has no recognizable form at
 * all; `index === -1` means it has one but the screen does not show it.
 */
function latestRawResumeEcho(
  screenText: string,
  cli: CliType,
  repo: string,
  sessionId: string,
  opts?: { cwd?: string | null },
): { command: string; index: number } | null {
  const candidates = rawResumeEchoCandidates(cli, repo, sessionId, opts);
  if (candidates.length === 0) return null;
  let best: { command: string; index: number } = {
    command: candidates[0]!,
    index: -1,
  };
  for (const command of candidates) {
    const index = screenText.lastIndexOf(command);
    if (index > best.index) best = { command, index };
  }
  return best;
}

function cliForLauncherSuffix(suffix: LauncherSuffix): CliType {
  return suffix === "Claude"
    ? "claude"
    : suffix === "Codex"
      ? "codex"
      : suffix === "Cursor"
        ? "cursor"
        : "gemini";
}

/**
 * Validate that a launcher is registered and return its resolved name. Probes
 * the launcher registry instead of executing shell profile code.
 *
 * Strict by design: this is the "registry is mandatory" contract. The default
 * spawn preflight no longer calls it unless
 * CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY is set — see resolveSpawnLaunchPlan.
 */
export async function assertLauncherAvailable(
  repo: string,
  suffix: LauncherSuffix,
): Promise<string> {
  return resolveLauncherNameFromRegistry(repo, cliForLauncherSuffix(suffix));
}

export const REQUIRE_LAUNCHER_REGISTRY_ENV =
  "CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY";

export function launcherRegistryRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[REQUIRE_LAUNCHER_REGISTRY_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Decide how a spawn should start its harness.
 *
 * AIDEV-NOTE (issue #392): the repoGolem launcher registry is an OPTIONAL
 * enhancement. When it names this repo we keep the launcher path verbatim —
 * existing installs see no change. When there is no registry, or no entry for
 * the repo, we fall back to the raw CLI with a cwd resolved from the repo
 * param. Set CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1 to restore the old hard
 * failure (useful when a typo'd repo name should be an error, not a raw
 * launch in a lookalike directory).
 */
export function resolveSpawnLaunchPlan(
  repo: string,
  cli: CliType,
  opts?: {
    registryOptions?: LauncherRegistryOptions;
    repoRootFallback?: RepoRootFallbackOptions;
    env?: Record<string, string | undefined>;
  },
): SpawnPreflightResult {
  const registryOptions = opts?.registryOptions;
  const launcherName = resolveLauncherNameFromRegistryOrNull(
    repo,
    cli,
    registryOptions,
  );
  if (launcherName) {
    return {
      launcherName,
      repoRoot: resolveRepoRootFromLauncherRegistry(repo, registryOptions),
      launchMode: "launcher",
    };
  }

  const snapshot = loadLauncherRegistrySnapshot(registryOptions);
  if (launcherRegistryRequired(opts?.env)) {
    // Strict mode: reproduce the self-answering registry error.
    resolveLauncherNameFromRegistry(repo, cli, registryOptions);
  }

  const registryHint = snapshot.available
    ? `Launcher registry ${snapshot.sourcePath} has no entry for "${repo}".`
    : `No launcher registry at ${snapshot.sourcePath} (${snapshot.unavailable_reason}).`;

  return {
    launchMode: "raw",
    launchModeReason: registryHint,
    repoRoot: resolveRepoRootWithoutRegistry(repo, {
      ...opts?.repoRootFallback,
      registryHint,
    }),
  };
}

export class AgentEngine {
  private stateMgr: StateManager;
  private liveStateResolver: LiveStateResolver | null = null;
  private registry: AgentRegistry;
  private client: AgentEngineClient;
  private spawnPreflight: (
    params: SpawnAgentParams,
  ) => Promise<SpawnPreflightResult | void>;
  private codexModelListRunner: CodexModelListRunner;
  private spawnGuard: SpawnGuard;
  private postSpawnLivenessMs: number;
  private stopPostConditionTimeoutMs: number;
  private roleSurfaceIdsProvider?: (
    liveSurfaceIds?: ReadonlySet<string>,
    workspace?: string,
    observation?: SurfaceBindingObservation,
  ) => RoleSurfaceIds;
  private launchCommandSender?: AgentEngineOptions["launchCommandSender"];
  private beforeCrashRecoveryMutation?: AgentEngineOptions["beforeCrashRecoveryMutation"];
  private inboxOpts?: InboxOpts;
  private lastChannelMarkerReapAt: number | null = null;
  private lastChannelMarkerReapFailureAt: number | null = null;
  private sessionIdentityResolver: SessionIdentityResolver;
  private hasCustomSessionIdentityResolver: boolean;
  private selfRegistrationSessionResolver: SessionIdentityResolver | null;
  private seatRegistry: SeatRegistry | null;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private fleetSidebarWakeRepublishTimer: ReturnType<typeof setTimeout> | null =
    null;
  private postSpawnLivenessTimers = new Set<ReturnType<typeof setTimeout>>();
  private sweepTiming: SweepTimingOptions | null = null;
  private lastSweepSignature: string | null = null;
  private unchangedSweepCount = 0;
  private currentSweepScreenSignatures = new Map<string, string>();
  /** agentId → last material (de-chromed) screen output change. */
  private fleetScreenProgress = new Map<string, FleetScreenProgressSnapshot>();
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
  /** Best-effort close-forensics ingest; null when disabled. */
  private closeForensicsRunner:
    | (() => CloseForensicsSweepResult | Promise<CloseForensicsSweepResult>)
    | null;
  private closeForensicsSweepInFlight = false;
  private fleetSidebarPublisher: FleetSidebarPublisherLike;
  private fleetWorkingNoProgressTimeoutMs: number;
  private startupInitializePromise: Promise<void> | null = null;
  private lifecycleMutationTail: Promise<void> = Promise.resolve();
  private deliveryReceipts = new Map<string, AgentDeliveryReceipt>();
  private deliveryReceiptsPath: string;
  private deliverySubmitter: DeliverySubmitter | null = null;
  private deliveryVerifier: DeliveryVerifier | null = null;
  private deliverySnapshotReader: DeliverySnapshotReader | null = null;
  private deliveryDrainInFlight = false;
  private deliveryVerifyInFlight = false;
  private deliverySubmitTimeoutMs: number;
  private deliveryVerifyTimeoutMs: number;
  private deliveryVerifyDeadlineMs: number;
  private deliveryQueueDeadlineMs: number;
  private deliveryTicketDir: string | null;
  private deliveryIssueFiler: DeliveryIssueFiler | null = null;
  private autoReviveBackoffBaseMs: number;
  private haltNow: () => number;
  private haltAwaitingInputDwellMs: number;
  private haltIdleWithoutDoneDwellMs: number;
  private haltWedgedDwellMs: number;
  private haltWedgedSweeps: number;
  private autoResolvePrompts: boolean;
  constructor(
    stateMgr: StateManager,
    registry: AgentRegistry,
    client: AgentEngineClient,
    opts?: AgentEngineOptions,
  ) {
    this.stateMgr = stateMgr;
    this.deliveryReceiptsPath = join(
      stateMgr.getBaseDir(),
      "delivery-receipts.json",
    );
    this.deliverySubmitTimeoutMs = Math.max(
      1,
      opts?.deliverySubmitTimeoutMs ?? 30_000,
    );
    this.deliveryVerifyTimeoutMs = Math.max(
      1,
      opts?.deliveryVerifyTimeoutMs ?? this.deliverySubmitTimeoutMs,
    );
    this.deliveryVerifyDeadlineMs = Math.max(
      1,
      opts?.deliveryVerifyDeadlineMs ?? DEFAULT_DELIVERY_VERIFY_DEADLINE_MS,
    );
    this.deliveryQueueDeadlineMs = Math.max(
      1,
      opts?.deliveryQueueDeadlineMs ?? DEFAULT_DELIVERY_QUEUE_DEADLINE_MS,
    );
    this.deliveryTicketDir = opts?.deliveryTicketDir ?? null;
    this.deliveryIssueFiler = opts?.deliveryIssueFiler ?? null;
    this.deliveryVerifier = opts?.deliveryVerifier ?? null;
    this.deliverySnapshotReader = opts?.deliverySnapshotReader ?? null;
    this.autoReviveBackoffBaseMs = Math.max(
      0,
      opts?.autoReviveBackoffBaseMs ?? DEFAULT_AUTO_REVIVE_BACKOFF_BASE_MS,
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
    this.autoResolvePrompts =
      process.env.CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE === "1";
    this.loadDeliveryReceipts();
    this.registry = registry;
    this.client = client;
    this.roleSurfaceIdsProvider = opts?.roleSurfaceIdsProvider;
    this.launchCommandSender = opts?.launchCommandSender;
    this.beforeCrashRecoveryMutation = opts?.beforeCrashRecoveryMutation;
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
    // Default DISABLED: bare construction (tests, libraries) must never read the
    // real `~/.cmuxterm/events.jsonl`. Production entrypoints inject the real
    // runner (see app-server-runtime / server.ts createServer). `null` keeps it
    // off; an explicit runner (tests) drives it deterministically.
    this.closeForensicsRunner =
      opts?.closeForensicsRunner !== undefined
        ? opts.closeForensicsRunner
        : null;
    this.fleetSidebarPublisher = opts?.fleetSidebarPublisher ?? {
      publish: () => {},
      dispose: () => {},
    };
    this.fleetWorkingNoProgressTimeoutMs =
      opts?.fleetWorkingNoProgressTimeoutMs ??
      parseNonNegativeInteger(
        process.env.CMUXLAYER_FLEET_WORKING_NO_PROGRESS_TIMEOUT_MS,
        DEFAULT_FLEET_WORKING_NO_PROGRESS_TIMEOUT_MS,
      );
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

  /** Live state for one record, or the record's own state when unprobed. */
  liveStateOf(agent: AgentRecord): LiveAgentState {
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
      doneMarker: issued
        ? issuedDoneMarker
        : this.extractDoneMarker(goalText),
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

  private lastAgentProgressAtMs(agent: AgentRecord): number | null {
    let transcriptProgressAtMs = 0;
    if (agent.cli_session_path) {
      const mtimeMs = safeMtimeMs(agent.cli_session_path);
      if (mtimeMs > 0) transcriptProgressAtMs = mtimeMs;
    } else {
      transcriptProgressAtMs =
        this.loadGroundTruthSession(agent)?.mtime_ms ?? 0;
    }
    const screenProgressAtMs =
      this.fleetScreenProgress.get(agent.agent_id)?.lastProgressAtMs ?? 0;
    const lastProgressAtMs = Math.max(
      transcriptProgressAtMs,
      screenProgressAtMs,
    );
    return lastProgressAtMs > 0 ? lastProgressAtMs : null;
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

  private async getTargetStateEvidenceSource(
    agent: AgentRecord,
    targetState: AgentState,
  ): Promise<TargetStateEvidenceSource | null> {
    if (agent.state !== targetState) return null;
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
  ): Promise<{
    agent: AgentRecord;
    source?: RefreshedTargetStateEvidenceSource;
  }> {
    if (targetState === "ready" || targetState === "idle") {
      return this.refreshInteractiveTargetStateEvidence(
        agent,
        targetState,
        waitForReadyPatternMatches,
      );
    }
    if (!this.requiresOutputDoneEvidence(targetState)) return { agent };
    if (TERMINAL_STATES.has(agent.state)) return { agent };
    return { agent: (await this.maybeMarkTaskDone(agent, {})).agent };
  }

  private async refreshInteractiveTargetStateEvidence(
    agent: AgentRecord,
    targetState: "ready" | "idle",
    waitForReadyPatternMatches: Map<string, number>,
  ): Promise<{
    agent: AgentRecord;
    source?: RefreshedTargetStateEvidenceSource;
  }> {
    const canTransition =
      targetState === "ready"
        ? agent.state === "booting"
        : agent.state === "working";
    if (!canTransition || TERMINAL_STATES.has(agent.state)) {
      waitForReadyPatternMatches.delete(agent.agent_id);
      return { agent };
    }
    try {
      const screen = await this.readAgentScreen(agent, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
      const evidence = this.readReadyEvidence(agent, screen.text);
      const hasTargetEvidence =
        evidence.ready || (targetState === "ready" && evidence.activeCodex);
      const awaitingManagedBootPrompt =
        targetState === "ready" &&
        agent.boot_prompt_pending === true &&
        agent.prompt_delivered === false &&
        !evidence.activeCodex;
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
      if (count < Math.max(1, evidence.consecutive)) {
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
          ...(transitionAgent.boot_prompt_pending
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
    if (workspace) {
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
      try {
        await this.client.selectWorkspace(workspace);
      } catch {
        // Best-effort: the workspace may already be focused, or the client may
        // be an older test/fallback implementation.
      }
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    }

    try {
      const panes = await this.client.listPanes({ workspace });
      const rawPaneSurfaces = await Promise.all(
        panes.panes.map(async (pane) => {
          const ps = await this.client.listPaneSurfaces({
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
      this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
      const surface =
        placement.kind === "surface"
          ? await this.client.newSurface({
              pane: placement.pane,
              type: "terminal",
              workspace,
            })
          : await this.client.newSplit(placement.direction, {
              ...(placement.pane ? { pane: placement.pane } : {}),
              workspace,
              type: "terminal",
            });
      // Transfer the created handle to the caller before any post-mutation
      // epoch assertion can throw. The caller owns cleanup until it durably
      // binds this exact surface into agent state.
      const createdSurface: CreatedAgentSurface = {
        ...this.withWorkspacePlacementObservation(surface, workspace),
        observerEpoch,
        observerId,
      };
      if (
        createdSurface.actual_workspace &&
        normalizeWorkspaceRefAlias(createdSurface.actual_workspace) !==
          normalizeWorkspaceRefAlias(createdSurface.workspace)
      ) {
        await this.cleanupUnboundCreatedSurface(
          createdSurface,
          "agent-placement",
        );
        throw new PlacementSurfaceBindingError(
          `Spawn placement blocked: requested ${createdSurface.workspace} ` +
            `but cmux returned ${createdSurface.actual_workspace} for surface ` +
            `${createdSurface.surface}`,
        );
      }
      return createdSurface;
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

    return resolveWorkspaceRefForRepo(repo, () => this.client.listWorkspaces());
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
    return Boolean(
      agent.cli !== "codex" &&
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
        return /^Gemini CLI$/i.test(trimmed) || /^gemini>\s*$/i.test(trimmed);
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
    const canBeInteractive =
      parsed.control_state !== "shell" &&
      !resumeAwaitsFreshReadiness(agent, screenText);
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
   * Default session-identity resolution is harness-specific. Codex identity is
   * sourced only from its rollout JSONL because its screen does not reliably
   * expose the UUID and self-registration can race or carry unrelated identity.
   * Claude/Cursor retain self-registration first, then transcript fallback.
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
    return { session_id: identity.session_id, path: identity.path ?? null };
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
      this.fleetScreenProgress,
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
    let updated = this.stateMgr.updateRecord(agent.agent_id, {
      cli_session_id: identity.session_id,
      cli_session_path: identity.path,
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
      const canonicalFinal =
        existingFinal.cli_session_id === identity.session_id &&
        existingFinal.cli_session_path === sessionPath &&
        existingFinal.transcript_session_capture_deferred !== true &&
        (existingFinal.transcript_session_capture_attempts ?? 0) === 0
          ? existingFinal
          : this.stateMgr.updateRecord(finalAgentId, {
              cli_session_id: identity.session_id,
              cli_session_path: sessionPath,
              transcript_session_capture_deferred: false,
              transcript_session_capture_attempts: 0,
            });
      const index = this.stateMgr.getSurfaceSessionIndex();
      index.removeAgent(updated.agent_id);
      index.persistRecord(canonicalFinal);
      this.registry.rename(updated.agent_id, finalAgentId, canonicalFinal);
      this.transferAgentRenameMemory(updated.agent_id, finalAgentId);
      this.stateMgr.removeState(updated.agent_id);
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

  private async readAgentScreen(
    agent: Pick<AgentRecord, "agent_id">,
    opts: { lines?: number; scrollback?: boolean } = {},
  ): Promise<CmuxReadScreenResult> {
    const route = await this.resolveAgentIoRoute(agent.agent_id);
    return this.client.readScreen(route.surface_id, {
      ...opts,
      workspace: route.workspace_id ?? undefined,
    });
  }

  private readSweepScreen(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<CmuxReadScreenResult> {
    ctx.route ??= this.resolveAgentIoRoute(agent.agent_id);
    ctx.screen ??= ctx.route.then(async (route) => {
      const screen = await this.client.readScreen(route.surface_id, {
        lines: BOOT_SESSION_CAPTURE_LINES,
        workspace: route.workspace_id ?? undefined,
      });
      await this.resolveUnchangedAgentIoRoute(
        agent.agent_id,
        route,
        "sweep screen read",
      );
      this.currentSweepScreenSignatures.set(
        agent.agent_id,
        `${route.surface_id}:${screenTextSignature(screen.text)}`,
      );
      this.recordFleetScreenProgress(agent.agent_id, screen.text);
      return screen;
    });
    return ctx.screen;
  }

  private recordFleetScreenProgress(agentId: string, screenText: string): void {
    const parsed = parseScreen(screenText);
    const materialOutput = cleanScreenText(
      screenText,
      BOOT_SESSION_CAPTURE_LINES,
    );
    const signature = screenTextSignature(
      `${parsed.current_action ?? ""}\n${materialOutput}`,
    );
    const previous = this.fleetScreenProgress.get(agentId);
    if (previous?.signature === signature) return;
    this.fleetScreenProgress.set(agentId, {
      signature,
      lastProgressAtMs: Date.now(),
    });
  }

  private async sweepReadMatchesBinding(
    ctx: SweepAgentContext,
    surfaceRef: string,
  ): Promise<boolean> {
    if (!ctx.route) return true;
    try {
      const readRoute = await ctx.route;
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
    if (agent.cli_session_id) {
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
    if (agent.state !== "booting") {
      this.readyPatternMatches.delete(agent.agent_id);
      return agent;
    }
    if (agent.agent_id.startsWith("auto-")) {
      return agent;
    }

    try {
      const screen = await this.readSweepScreen(agent, ctx);
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
        !evidence.activeCodex &&
        this.screenShowsPendingBootPrompt(agent, screen.text);
      const awaitingManagedBootPrompt =
        agent.boot_prompt_pending === true &&
        agent.prompt_delivered === false &&
        !evidence.activeCodex;

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
        // A harness that rejected the resume command is a FAILED attempt, not a
        // slow boot. Record it now instead of burning the boot timeout in
        // silence and then retrying the identical broken command.
        const rejection = this.detectResumeRejection(agent, screen.text);
        if (rejection) {
          const settled = this.stateMgr.updateRecord(
            agent.agent_id,
            settlement,
          );
          this.registry.set(agent.agent_id, settled);
          return this.recordAutoReviveResumeFailure(settled, rejection);
        }
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
        ...(agent.boot_prompt_pending
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
      return this.finalizeAutoReviveSuccess(updated);
    } catch {
      return agent;
    }
  }

  private async maybeMarkTaskDone(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<{ agent: AgentRecord; screenText?: string }> {
    if (TERMINAL_STATES.has(agent.state)) return { agent };

    if (await this.hasGroundTruthDone(agent, ctx)) {
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

  private haltDwellMs(type: AgentHaltType): number {
    switch (type) {
      case "awaiting_input":
      case "paused":
        return this.haltAwaitingInputDwellMs;
      case "idle_without_done":
        return this.haltIdleWithoutDoneDwellMs;
      case "wedged":
        return this.haltWedgedDwellMs;
    }
  }

  private haltUnblockAction(agent: AgentRecord, type: AgentHaltType): string {
    switch (type) {
      case "awaiting_input":
        return (
          `read_screen(surface: "${agent.surface_id}", raw: true); after reviewing the prompt, ` +
          `send_key(surface: "${agent.surface_id}", key: "return")`
        );
      case "idle_without_done":
        return `interact(agent: "${agent.agent_id}", action: "send", text: "Continue and report status.")`;
      case "wedged":
        return `interact(agent: "${agent.agent_id}", action: "interrupt")`;
      case "paused":
        return (
          `read_screen(surface: "${agent.surface_id}", parsed_only: true); ` +
          `the child is paused and cannot act — unpause the pane before send_to, ` +
          `or send_key(surface: "${agent.surface_id}", key: "return") if the screen says to resume`
        );
    }
  }

  private hasParentVisibleArtifactSinceIdle(agent: AgentRecord): boolean {
    if (!agent.parent_agent_id || !agent.halt_last_active_at) return false;
    const idleBoundaryMs = Date.parse(agent.halt_last_active_at);
    if (!Number.isFinite(idleBoundaryMs)) return false;
    return readInbox(agent.parent_agent_id, this.inboxOpts).some(
      (message) =>
        message.reply_to === agent.agent_id && message.ts_ms >= idleBoundaryMs,
    );
  }

  private blockingBackgroundWaitElapsedMs(screenText: string): number | null {
    const visibleTail = screenText.split(/\r?\n/).slice(-24).join("\n");
    const match = visibleTail.match(
      /\bWait(?:ing|ed) for background terminal\s*\((?:(\d+)h\s*)?(?:(\d+)m\s*)?(\d+)s\s*•\s*esc to interrupt\)/i,
    );
    if (!match) return null;
    const hours = Number.parseInt(match[1] ?? "0", 10);
    const minutes = Number.parseInt(match[2] ?? "0", 10);
    const seconds = Number.parseInt(match[3] ?? "0", 10);
    return ((hours * 60 + minutes) * 60 + seconds) * 1_000;
  }

  private isIdleSupervisor(agent: AgentRecord, _screenText: string): boolean {
    return agent.role === "orchestrator";
  }

  private observableHaltProgressSignature(
    agent: AgentRecord,
    screenText: string,
  ): string {
    const materialScreen = cleanScreenText(
      screenText,
      BOOT_SESSION_CAPTURE_LINES,
    );
    const transcriptMtime = this.loadGroundTruthSession(agent)?.mtime_ms ?? 0;
    return `${screenTextSignature(materialScreen)}:${transcriptMtime}`;
  }

  private isMatureHaltEpisode(agent: AgentRecord, nowMs: number): boolean {
    if (!agent.halt_episode_type) return false;
    const startedAtMs = Date.parse(agent.halt_episode_started_at ?? "");
    return (
      Number.isFinite(startedAtMs) &&
      nowMs - startedAtMs >= this.haltDwellMs(agent.halt_episode_type) &&
      (agent.halt_episode_type !== "wedged" ||
        (agent.halt_episode_observations ?? 0) >= this.haltWedgedSweeps)
    );
  }

  private clearHaltEpisode(
    agent: AgentRecord,
    patch: Partial<AgentRecord> = {},
  ): AgentRecord {
    const hasEpisodeState = Boolean(
      agent.halt_episode_type ||
      agent.halt_episode_started_at ||
      agent.halt_notification_sent_at ||
      agent.halt_notified_ancestor_id,
    );
    if (!hasEpisodeState && Object.keys(patch).length === 0) return agent;
    const updated = this.stateMgr.updateRecord(agent.agent_id, {
      halt_episode_type: null,
      halt_episode_started_at: null,
      halt_episode_observations: 0,
      halt_notification_sent_at: null,
      halt_notified_ancestor_id: null,
      halt_last_observable_action: null,
      ...patch,
    });
    this.registry.set(agent.agent_id, updated);
    return updated;
  }

  private persistPromptBlockedState(
    agent: AgentRecord,
    blocked: boolean,
    nowIso: string,
  ): AgentRecord {
    if (blocked && agent.blocked_on_prompt === true) {
      return agent;
    }
    if (
      !blocked &&
      agent.blocked_on_prompt !== true &&
      agent.blocked_on_prompt_since == null
    ) {
      return agent;
    }
    const updated = this.stateMgr.updateRecord(agent.agent_id, {
      blocked_on_prompt: blocked,
      blocked_on_prompt_since: blocked
        ? (agent.blocked_on_prompt_since ?? nowIso)
        : null,
    });
    this.registry.set(agent.agent_id, updated);
    return updated;
  }

  private persistPausedState(
    agent: AgentRecord,
    paused: boolean,
    nowIso: string,
  ): AgentRecord {
    const source = paused ? "inferred" : null;
    if (
      paused &&
      agent.paused === true &&
      agent.paused_source === "inferred" &&
      agent.paused_since != null
    ) {
      return agent;
    }
    if (
      !paused &&
      agent.paused !== true &&
      agent.paused_source == null &&
      agent.paused_since == null
    ) {
      return agent;
    }
    const updated = this.stateMgr.updateRecord(agent.agent_id, {
      paused,
      paused_source: source,
      paused_since: paused ? (agent.paused_since ?? nowIso) : null,
    });
    this.registry.set(agent.agent_id, updated);
    return updated;
  }

  private async haltSinkQuality(
    candidate: AgentRecord,
    nowMs: number,
  ): Promise<"healthy" | "fallback" | "dead"> {
    try {
      const screen = await this.readAgentScreen(candidate, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
      const parsed = parseScreen(screen.text);
      if (
        parsed.control_state === "shell" ||
        parsed.control_state === "dead" ||
        parsed.control_state === "stale_surface"
      ) {
        return "dead";
      }
      if (
        parsed.agent_type === "unknown" ||
        parsed.control_state === "permission_prompt" ||
        parsed.control_state === "interactive_overlay" ||
        parsed.paused === true ||
        this.isMatureHaltEpisode(candidate, nowMs)
      ) {
        return "fallback";
      }
      return "healthy";
    } catch {
      // A known agent inbox remains a best-effort sink even when screen proof
      // is unavailable. Registry observability does not depend on this write.
      return "fallback";
    }
  }

  private async fleetHaltSink(
    agent: AgentRecord,
    nowMs: number,
    visited: ReadonlySet<string>,
  ): Promise<AgentRecord | null> {
    const candidates = this.registry
      .list()
      .filter(
        (candidate) =>
          candidate.agent_id !== agent.agent_id &&
          !visited.has(candidate.agent_id) &&
          !candidate.parent_agent_id,
      )
      .sort((left, right) => {
        const leftScore =
          (left.role === "orchestrator" ? 2 : 0) +
          (left.surface_provenance === "cmuxlayer_spawn" ? 1 : 0);
        const rightScore =
          (right.role === "orchestrator" ? 2 : 0) +
          (right.surface_provenance === "cmuxlayer_spawn" ? 1 : 0);
        return (
          rightScore - leftScore || left.agent_id.localeCompare(right.agent_id)
        );
      });
    const bestSink = async (
      scoped: AgentRecord[],
    ): Promise<AgentRecord | null> => {
      let fallback: AgentRecord | null = null;
      for (const candidate of scoped) {
        const quality = await this.haltSinkQuality(candidate, nowMs);
        if (quality === "healthy") return candidate;
        if (quality === "fallback" && !fallback) fallback = candidate;
      }
      return fallback;
    };
    const sameWorkspace = candidates.filter(
      (candidate) => candidate.workspace_id === agent.workspace_id,
    );
    const scopedSink = await bestSink(sameWorkspace);
    if (scopedSink) return scopedSink;
    return bestSink(
      candidates.filter(
        (candidate) => candidate.workspace_id !== agent.workspace_id,
      ),
    );
  }

  private async nearestLiveHaltAncestor(
    agent: AgentRecord,
    nowMs: number,
  ): Promise<HaltSinkResolution> {
    const visited = new Set<string>([agent.agent_id]);
    let fallback: AgentRecord | null = null;
    let ancestorId = agent.parent_agent_id;
    while (ancestorId && !visited.has(ancestorId)) {
      visited.add(ancestorId);
      const ancestor =
        this.registry.get(ancestorId) ?? this.stateMgr.readState(ancestorId);
      if (!ancestor) break;
      const quality = await this.haltSinkQuality(ancestor, nowMs);
      if (quality === "healthy") return { sink: ancestor, fallback: false };
      if (quality === "fallback") fallback = ancestor;
      ancestorId = ancestor.parent_agent_id;
    }
    if (fallback) return { sink: fallback, fallback: true };
    return {
      sink: await this.fleetHaltSink(agent, nowMs, visited),
      fallback: true,
    };
  }

  private appendHaltEscalationEvent(
    agent: AgentRecord,
    haltType: AgentHaltType,
    outcome:
      | "ancestor_dispatched"
      | "fallback_dispatched"
      | "undeliverable"
      | "dispatch_failed",
    sinkAgentId: string | null,
    error: string | null,
    nowIso: string,
  ): void {
    try {
      this.stateMgr.getEventLog().appendAgentHaltEscalation({
        ts: nowIso,
        event_type: "agent_halt_escalation",
        agent_id: agent.agent_id,
        surface_id: agent.surface_id,
        parent_agent_id: agent.parent_agent_id,
        halt_type: haltType,
        outcome,
        sink_agent_id: sinkAgentId,
        missing_ancestor_count: agent.halt_missing_ancestor_count ?? 0,
        delivery_failure_count: agent.halt_delivery_failure_count ?? 0,
        error,
      });
    } catch (eventError) {
      console.error(
        "[cmuxlayer] failed to log halt escalation outcome:",
        eventError,
      );
    }
  }

  private appendResolvedPromptEvent(input: {
    agent: AgentRecord;
    disposition: Extract<PromptDisposition, { kind: "resolve" }>;
    beforeControlState: ParsedScreenResult["control_state"];
    afterControlState: ParsedScreenResult["control_state"] | null;
    screenText: string;
    outcome: "recovered" | "failed";
    error: string | null;
    nowIso: string;
  }): boolean {
    const excerptSource = cleanScreenText(input.screenText, 8);
    if (
      !isPromptResolutionAuditSafe(input.screenText, input.agent.cli) ||
      containsPromptApprovalChooser(excerptSource)
    ) {
      return false;
    }
    const excerpt = excerptSource.replace(/\s+/g, " ").trim().slice(0, 240);
    this.stateMgr.getEventLog().appendResolvedPrompt({
      ts: input.nowIso,
      event_type: "resolved_prompt",
      agent_id: input.agent.agent_id,
      surface_id: input.agent.surface_id,
      workspace_id: input.agent.workspace_id ?? null,
      prompt_type: input.disposition.prompt_type,
      key_sent: input.disposition.key,
      outcome: input.outcome,
      before_control_state: input.beforeControlState,
      after_control_state: input.afterControlState,
      screen_signature: screenTextSignature(input.screenText),
      screen_excerpt: excerpt,
      error: input.error,
    });
    return true;
  }

  private async maybeResolvePrompt(
    agent: AgentRecord,
    screenText: string,
    disposition: Extract<PromptDisposition, { kind: "resolve" }>,
    nowIso: string,
  ): Promise<{ agent: AgentRecord; recovered: boolean }> {
    const signature = screenTextSignature(screenText);
    if (this.promptResolutionFailures.get(agent.agent_id) === signature) {
      return { agent, recovered: false };
    }
    if (
      !isPromptResolutionAuditSafe(screenText, agent.cli) ||
      containsPromptApprovalChooser(cleanScreenText(screenText, 8))
    ) {
      this.promptResolutionFailures.set(agent.agent_id, signature);
      return { agent, recovered: false };
    }

    const before = parseScreen(screenText);
    let afterControlState: ParsedScreenResult["control_state"] | null = null;
    let error: string | null = null;
    try {
      const route = await this.resolveAgentIoRoute(agent.agent_id);
      const assertSurfaceBindingCurrent = async (): Promise<void> => {
        await this.resolveUnchangedAgentIoRoute(
          agent.agent_id,
          route,
          "prompt resolution",
        );
      };
      await this.client.sendKey(route.surface_id, disposition.key, {
        workspace: route.workspace_id ?? undefined,
        ...this.stableSurfaceWriteOptions(route.surface_uuid),
        beforeMutation: assertSurfaceBindingCurrent,
      });
      await assertSurfaceBindingCurrent();
      const afterScreen = await this.client.readScreen(route.surface_id, {
        lines: BOOT_SESSION_CAPTURE_LINES,
        workspace: route.workspace_id ?? undefined,
      });
      await assertSurfaceBindingCurrent();
      const after = parseScreen(afterScreen.text);
      afterControlState = after.control_state;
      const recovered =
        after.control_state === "ready" || after.control_state === "busy";
      if (!recovered) {
        error = `prompt remained ${after.control_state} after Escape`;
        this.promptResolutionFailures.set(agent.agent_id, signature);
      } else {
        this.promptResolutionFailures.delete(agent.agent_id);
      }
      const auditWritten = this.appendResolvedPromptEvent({
        agent,
        disposition,
        beforeControlState: before.control_state,
        afterControlState,
        screenText,
        outcome: recovered ? "recovered" : "failed",
        error,
        nowIso,
      });
      if (!auditWritten) {
        this.promptResolutionFailures.set(agent.agent_id, signature);
        return { agent, recovered: false };
      }
      if (!recovered) return { agent, recovered: false };

      agent = this.persistPromptBlockedState(agent, false, nowIso);
      return { agent: this.clearHaltEpisode(agent), recovered: true };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      this.promptResolutionFailures.set(agent.agent_id, signature);
      this.appendResolvedPromptEvent({
        agent,
        disposition,
        beforeControlState: before.control_state,
        afterControlState,
        screenText,
        outcome: "failed",
        error,
        nowIso,
      });
      return { agent, recovered: false };
    }
  }

  private async maybeEscalateLiveHalt(
    agent: AgentRecord,
    screenText: string,
  ): Promise<AgentRecord> {
    const nowMs = this.haltNow();
    const nowIso = new Date(nowMs).toISOString();
    const parsed = parseScreen(screenText);
    let disposition = classifyPromptDisposition(screenText, agent.cli);
    if (disposition.kind === "resolve" && this.autoResolvePrompts) {
      const resolution = await this.maybeResolvePrompt(
        agent,
        screenText,
        disposition,
        nowIso,
      );
      agent = resolution.agent;
      if (resolution.recovered) return agent;
      disposition = {
        kind: "escalate",
        prompt_type: "human_or_unknown_chooser",
      };
    } else if (disposition.kind === "resolve") {
      disposition = {
        kind: "escalate",
        prompt_type: "human_or_unknown_chooser",
      };
    } else {
      this.promptResolutionFailures.delete(agent.agent_id);
    }
    const progressSignature = this.observableHaltProgressSignature(
      agent,
      screenText,
    );
    const hasVisibleProgress = hasVisibleAgentProgress(screenText, agent.cli);
    const canObservePromptMotion =
      disposition.kind === "escalate" &&
      disposition.prompt_type === "human_or_unknown_chooser" &&
      isBlockingPromptChooserScreen(screenText) &&
      hasVisibleProgress;
    const promptScreenSignature = screenTextSignature(screenText);
    const previousPromptScreenSignature = this.promptMotionScreenSignatures.get(
      agent.agent_id,
    );
    const promptScreenChanged =
      canObservePromptMotion &&
      previousPromptScreenSignature !== undefined &&
      previousPromptScreenSignature !== promptScreenSignature;
    if (canObservePromptMotion) {
      this.promptMotionScreenSignatures.set(
        agent.agent_id,
        promptScreenSignature,
      );
    } else {
      this.promptMotionScreenSignatures.delete(agent.agent_id);
    }
    if (promptScreenChanged) {
      this.promptMotionObservedAtMs.set(agent.agent_id, nowMs);
    } else if (!canObservePromptMotion) {
      this.promptMotionObservedAtMs.delete(agent.agent_id);
    }
    const motionObservedAt = this.promptMotionObservedAtMs.get(agent.agent_id);
    const hasObservedPromptMotion =
      disposition.kind === "escalate" &&
      disposition.prompt_type === "human_or_unknown_chooser" &&
      isBlockingPromptChooserScreen(screenText) &&
      hasVisibleProgress &&
      motionObservedAt !== undefined &&
      nowMs - motionObservedAt < PROMPT_MOTION_GRACE_MS;
    if (hasObservedPromptMotion) {
      agent = this.persistPromptBlockedState(agent, false, nowIso);
      return this.clearHaltEpisode(agent, {
        halt_last_active_at: nowIso,
        halt_last_progress_at_ms: nowMs,
        halt_last_progress_signature: progressSignature,
      });
    }
    agent = this.persistPromptBlockedState(
      agent,
      disposition.kind === "escalate",
      nowIso,
    );
    agent = this.persistPausedState(agent, parsed.paused === true, nowIso);
    if (agent.halt_escalation === false) return agent;
    if (
      parsed.paused !== true &&
      (parsed.control_state === "shell" ||
        parsed.control_state === "dead" ||
        parsed.control_state === "stale_surface" ||
        this.hasOutputDoneEvidence(agent.cli, screenText) ||
        this.hasCurrentRecordedOutputDoneEvidence(agent) ||
        (agent.cli === "codex" && this.transcriptHasSettledDone(agent)) ||
        (parsed.status === "idle" &&
          parsed.control_state === "ready" &&
          this.hasParentVisibleArtifactSinceIdle(agent)))
    ) {
      const hasProgressMemory = Boolean(
        agent.halt_last_active_at ||
        agent.halt_last_progress_at_ms ||
        agent.halt_last_progress_signature,
      );
      return this.clearHaltEpisode(
        agent,
        hasProgressMemory
          ? {
              halt_last_active_at: null,
              halt_last_progress_at_ms: null,
              halt_last_progress_signature: null,
            }
          : {},
      );
    }

    const screenActive =
      parsed.status === "working" || parsed.status === "thinking";
    const blockingBackgroundWaitMs =
      this.blockingBackgroundWaitElapsedMs(screenText);
    let haltType: AgentHaltType | null = null;
    let episodeStartedAtMs = nowMs;
    if (
      parsed.control_state === "permission_prompt" ||
      parsed.control_state === "interactive_overlay"
    ) {
      haltType = "awaiting_input";
    } else if (parsed.paused === true) {
      haltType = "paused";
    } else if (screenActive) {
      if (blockingBackgroundWaitMs !== null) {
        haltType = "wedged";
        episodeStartedAtMs = nowMs - blockingBackgroundWaitMs;
      } else if (agent.halt_last_progress_signature !== progressSignature) {
        return this.clearHaltEpisode(agent, {
          halt_last_active_at: nowIso,
          halt_last_progress_at_ms: nowMs,
          halt_last_progress_signature: progressSignature,
        });
      } else {
        haltType = "wedged";
        episodeStartedAtMs = agent.halt_last_progress_at_ms ?? nowMs;
      }
    } else if (
      parsed.status === "idle" &&
      parsed.control_state === "ready" &&
      parsed.agent_type !== "unknown" &&
      !this.isIdleSupervisor(agent, screenText) &&
      agent.halt_last_active_at
    ) {
      haltType = "idle_without_done";
    }
    if (!haltType) return this.clearHaltEpisode(agent);

    let episode = agent;
    if (!agent.halt_episode_type) {
      episode = this.stateMgr.updateRecord(agent.agent_id, {
        halt_episode_type: haltType,
        halt_episode_started_at: new Date(episodeStartedAtMs).toISOString(),
        halt_episode_observations:
          haltType === "wedged" && blockingBackgroundWaitMs !== null
            ? this.haltWedgedSweeps
            : 1,
        halt_notification_sent_at: null,
        halt_notified_ancestor_id: null,
        halt_fallback_sink_id: null,
        halt_last_delivery_error: null,
        halt_last_observable_action: parsed.current_action ?? haltType,
      });
      this.registry.set(agent.agent_id, episode);
      return episode;
    }
    if (agent.halt_episode_type !== haltType) {
      episode = this.stateMgr.updateRecord(agent.agent_id, {
        halt_episode_type: haltType,
        halt_episode_started_at: nowIso,
        halt_episode_observations: 1,
        halt_notification_sent_at: null,
        halt_notified_ancestor_id: null,
        halt_fallback_sink_id: null,
        halt_last_delivery_error: null,
        halt_last_observable_action: parsed.current_action ?? haltType,
      });
      this.registry.set(agent.agent_id, episode);
      return episode;
    }
    if (haltType === "wedged") {
      episode = this.stateMgr.updateRecord(agent.agent_id, {
        halt_episode_observations: (agent.halt_episode_observations ?? 0) + 1,
        halt_last_observable_action: parsed.current_action ?? haltType,
      });
      this.registry.set(agent.agent_id, episode);
    }
    if (episode.halt_notification_sent_at) return episode;

    const startedAtMs = Date.parse(episode.halt_episode_started_at ?? "");
    if (
      !Number.isFinite(startedAtMs) ||
      nowMs - startedAtMs < this.haltDwellMs(haltType) ||
      (haltType === "wedged" &&
        (episode.halt_episode_observations ?? 0) < this.haltWedgedSweeps)
    ) {
      return episode;
    }
    const resolution = await this.nearestLiveHaltAncestor(episode, nowMs);
    if (resolution.fallback) {
      episode = this.stateMgr.updateRecord(episode.agent_id, {
        halt_missing_ancestor_count:
          (episode.halt_missing_ancestor_count ?? 0) + 1,
        halt_fallback_sink_id: resolution.sink?.agent_id ?? null,
        halt_last_delivery_error: resolution.sink
          ? null
          : "no halt escalation sink available",
      });
      this.registry.set(episode.agent_id, episode);
    }
    const ancestor = resolution.sink;
    if (!ancestor) {
      this.appendHaltEscalationEvent(
        episode,
        haltType,
        "undeliverable",
        null,
        episode.halt_last_delivery_error ?? "no halt escalation sink available",
        nowIso,
      );
      return episode;
    }
    const resumeCommand = episode.cli_session_id
      ? (rawResumeCommandOrNull(
          episode.cli,
          episode.repo,
          episode.cli_session_id,
        ) ?? `no raw ${episode.cli} resume form; inspect the live surface`)
      : "no captured session; inspect the live surface";
    const durationSeconds = Math.max(
      0,
      Math.floor((nowMs - startedAtMs) / 1_000),
    );
    const unblockAction = this.haltUnblockAction(episode, haltType);
    try {
      dispatchOnce(
        ancestor.agent_id,
        {
          id: `agent-halt:${episode.agent_id}:${episode.halt_episode_started_at}`,
          from: "cmuxlayer:lifecycle",
          to: ancestor.agent_id,
          tag: `agent_halt_${haltType}`,
          task:
            `Agent ${episode.agent_id} in surface ${episode.surface_id} has remained ` +
            `${haltType} for ${durationSeconds}s. Last observable action: ` +
            `${episode.halt_last_observable_action ?? "unknown"}. ` +
            `Exact unblock action: ${unblockAction}. ` +
            `Session resume fallback: ${resumeCommand}`,
        },
        this.inboxOpts,
      );
      const notified = this.stateMgr.updateRecord(episode.agent_id, {
        halt_notification_sent_at: nowIso,
        halt_notified_ancestor_id: ancestor.agent_id,
        halt_last_delivery_error: null,
      });
      this.registry.set(episode.agent_id, notified);
      this.appendHaltEscalationEvent(
        notified,
        haltType,
        resolution.fallback ? "fallback_dispatched" : "ancestor_dispatched",
        ancestor.agent_id,
        null,
        nowIso,
      );
      return notified;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.stateMgr.updateRecord(episode.agent_id, {
        halt_delivery_failure_count:
          (episode.halt_delivery_failure_count ?? 0) + 1,
        halt_last_delivery_error: message,
      });
      this.registry.set(episode.agent_id, failed);
      this.appendHaltEscalationEvent(
        failed,
        haltType,
        "dispatch_failed",
        ancestor.agent_id,
        message,
        nowIso,
      );
      return failed;
    }
  }

  private shouldAutoReviveCliExit(agent: AgentRecord): boolean {
    const structurallyEligible =
      agent.surface_provenance === "cmuxlayer_spawn" &&
      agent.auto_revive !== false &&
      agent.user_killed !== true &&
      !!agent.cli_session_id &&
      this.registry.canControlSurface(agent);
    if (!structurallyEligible) return false;
    // A harness with no raw resume form (gemini) is structurally not
    // auto-revivable on its own surface.
    return (
      rawResumeCommandOrNull(agent.cli, agent.repo, agent.cli_session_id!) !==
      null
    );
  }

  private autoReviveBackoffMs(attempt: number): number {
    return Math.min(
      MAX_AUTO_REVIVE_BACKOFF_MS,
      this.autoReviveBackoffBaseMs * 2 ** Math.max(0, attempt - 1),
    );
  }

  private async dispatchCliExitOutcome(
    agent: AgentRecord,
    outcome: "revived" | "recovered" | "unrecoverable",
  ): Promise<{ record: AgentRecord; dispatched: boolean }> {
    if (!agent.parent_agent_id || agent.revive_notification_sent_at) {
      return { record: agent, dispatched: false };
    }
    const attempts = agent.revive_attempts ?? 0;
    // Human-facing hint for a surface that may be gone: carry the cwd so the
    // command works when pasted into a fresh terminal.
    const manualResumeCommand = agent.cli_session_id
      ? rawResumeCommandOrNull(agent.cli, agent.repo, agent.cli_session_id, {
          cwd: resumeCwdForAgent(agent),
        })
      : null;
    const tag =
      outcome === "unrecoverable"
        ? "agent_cli_exit_unrecoverable"
        : "agent_cli_exit_revived";
    const task =
      outcome === "revived"
        ? `Agent ${agent.agent_id} revived automatically on attempt ${attempts} ` +
          `in surface ${agent.surface_id}; verified model ${agent.parsed_model ?? "unknown"}.`
        : outcome === "recovered"
          ? `Agent ${agent.agent_id} recovered in surface ${agent.surface_id} without an ` +
            `engine resume after ${attempts} attempts; the pending auto-resume was ` +
            `cleared before injection so nothing was typed into the live agent.`
          : `Agent ${agent.agent_id} CLI exit is unrecoverable after ${attempts} attempts ` +
            `in surface ${agent.surface_id}. Manual fallback: ${manualResumeCommand ?? "no captured session"}`;
    try {
      dispatchOnce(
        agent.parent_agent_id,
        {
          id: `agent-cli-exit-${outcome}:${agent.agent_id}:${agent.revive_completed_at ?? agent.updated_at}`,
          from: "cmuxlayer:lifecycle",
          to: agent.parent_agent_id,
          tag,
          task,
        },
        this.inboxOpts,
      );
      const notified = this.stateMgr.updateRecord(agent.agent_id, {
        revive_notification_sent_at: new Date().toISOString(),
      });
      this.registry.set(agent.agent_id, notified);
      return { record: notified, dispatched: true };
    } catch {
      return { record: agent, dispatched: false };
    }
  }

  private appendAutoReviveCliExitEvent(
    agent: AgentRecord,
    outcome: "pending" | "revived" | "unrecoverable",
    inboxDispatched: boolean,
  ): void {
    this.stateMgr.getEventLog().appendAgentCliExit({
      ts: agent.updated_at,
      event_type: "agent_cli_exit",
      agent_id: agent.agent_id,
      surface_id: agent.surface_id,
      parent_agent_id: agent.parent_agent_id,
      previous_state: agent.revive_previous_state ?? "working",
      control_state: "shell",
      consecutive_observations:
        agent.revive_consecutive_observations ??
        CLI_EXIT_SHELL_CONFIRMATION_SWEEPS,
      inbox_dispatched: inboxDispatched,
      error: CLI_EXIT_ERROR,
      auto_revive: true,
      revive_attempts: agent.revive_attempts ?? 0,
      revive_outcome: outcome,
      verified_model:
        outcome === "revived" ? (agent.parsed_model ?? null) : null,
      manual_resume_command:
        outcome === "unrecoverable" && agent.cli_session_id
          ? rawResumeCommandOrNull(
              agent.cli,
              agent.repo,
              agent.cli_session_id,
              { cwd: resumeCwdForAgent(agent) },
            )
          : null,
    });
  }

  private async markAutoReviveUnrecoverable(
    agent: AgentRecord,
    reason: string,
  ): Promise<AgentRecord> {
    const completedAt = new Date().toISOString();
    let completed = this.stateMgr.updateRecord(agent.agent_id, {
      revive_last_outcome: "unrecoverable",
      revive_last_error: reason,
      revive_next_attempt_at: null,
      revive_completed_at: completedAt,
      revive_observation_source: "screen",
      revive_observed_at_ms: Date.now(),
      error: `Auto-revive unrecoverable: ${reason}`,
    });
    this.registry.set(agent.agent_id, completed);
    const notification = await this.dispatchCliExitOutcome(
      completed,
      "unrecoverable",
    );
    completed = notification.record;
    this.appendAutoReviveCliExitEvent(
      completed,
      "unrecoverable",
      notification.dispatched,
    );
    return completed;
  }

  /**
   * Classify what currently occupies a revive target's surface. Auto-resume may
   * only type into a bare shell: between the death signal and the injection the
   * pane can be revived by other means (a human running `--resume` by hand), and
   * typing then lands the resume command in a working agent's composer as if it
   * were a user message. Same guard class as the interactive-overlay delivery
   * refusal.
   */
  private async classifyReviveTarget(
    agent: AgentRecord,
    knownShellScreenText?: string,
  ): Promise<"shell" | "live_agent" | "unverified"> {
    let screenText: string;
    try {
      screenText =
        knownShellScreenText ?? (await this.readSweepScreen(agent, {})).text;
    } catch {
      return "unverified";
    }
    const parsed = parseScreen(screenText);
    if (parsed.control_state === "shell") return "shell";
    if (
      parsed.control_state === "ready" ||
      parsed.control_state === "busy" ||
      parsed.control_state === "permission_prompt" ||
      parsed.control_state === "interactive_overlay" ||
      screenHasReadyAgentIdentity(agent.cli, screenText, parsed)
    ) {
      return "live_agent";
    }
    return "unverified";
  }

  /**
   * The pane came back without us: clear the pending resume so nothing is typed,
   * and hand the record back to the ordinary boot-readiness path.
   */
  private async markAutoReviveRecovered(
    agent: AgentRecord,
  ): Promise<AgentRecord> {
    let recovered = this.stateMgr.updateRecord(agent.agent_id, {
      revive_last_outcome: "revived",
      revive_last_error: null,
      revive_next_attempt_at: null,
      revive_completed_at: new Date().toISOString(),
      revive_observation_source: "screen",
      revive_observed_at_ms: Date.now(),
      error: null,
    });
    this.registry.set(agent.agent_id, recovered);
    const notification = await this.dispatchCliExitOutcome(
      recovered,
      "recovered",
    );
    recovered = notification.record;
    this.appendAutoReviveCliExitEvent(
      recovered,
      "revived",
      notification.dispatched,
    );
    try {
      const creating = this.stateMgr.transition(
        recovered.agent_id,
        "creating",
        {
          error: null,
          pid: null,
        },
      );
      this.registry.set(creating.agent_id, creating);
      const booting = this.stateMgr.transition(creating.agent_id, "booting", {
        error: null,
        pid: null,
      });
      this.registry.set(booting.agent_id, booting);
      return booting;
    } catch {
      return recovered;
    }
  }

  /**
   * Hold the attempt without consuming one: we could not prove the surface is a
   * bare shell, and typing on an unproven surface is the failure mode this guard
   * exists to prevent.
   */
  private deferAutoReviveAttempt(
    agent: AgentRecord,
    attempt: number,
  ): AgentRecord {
    try {
      const deferred = this.stateMgr.updateRecord(agent.agent_id, {
        revive_next_attempt_at: new Date(
          Date.now() + this.autoReviveBackoffMs(attempt),
        ).toISOString(),
        revive_observation_source: "screen",
        revive_observed_at_ms: Date.now(),
      });
      this.registry.set(agent.agent_id, deferred);
      return deferred;
    } catch {
      return agent;
    }
  }

  /**
   * The harness rejected the resume command itself (bad flag, unknown session).
   * Record the failure and back off; at the cap, escalate as unrecoverable.
   */
  private async recordAutoReviveResumeFailure(
    agent: AgentRecord,
    reason: string,
  ): Promise<AgentRecord> {
    const attempts = agent.revive_attempts ?? 0;
    let failed: AgentRecord;
    try {
      failed =
        agent.state === "error"
          ? agent
          : this.stateMgr.transition(agent.agent_id, "error", {
              error: `Auto-revive attempt ${attempts} failed: ${reason}`,
            });
      failed = this.stateMgr.updateRecord(failed.agent_id, {
        revive_last_outcome: "failed",
        revive_last_error: reason,
        revive_next_attempt_at: new Date(
          Date.now() + this.autoReviveBackoffMs(Math.max(1, attempts)),
        ).toISOString(),
        revive_observation_source: "screen",
        revive_observed_at_ms: Date.now(),
      });
      this.registry.set(failed.agent_id, failed);
    } catch {
      return agent;
    }
    if (attempts >= MAX_RESPAWN_ATTEMPTS) {
      return this.markAutoReviveUnrecoverable(failed, reason);
    }
    return failed;
  }

  /**
   * Detect a resume command the harness refused, by reading only the screen tail
   * that followed our own echoed command. Returns the offending line, or null.
   */
  private detectResumeRejection(
    agent: AgentRecord,
    screenText: string,
  ): string | null {
    if (agent.revive_last_outcome !== "pending" || !agent.cli_session_id) {
      return null;
    }
    const echo = latestRawResumeEcho(
      screenText,
      agent.cli,
      agent.repo,
      agent.cli_session_id,
    );
    if (!echo || echo.index < 0) return null;
    const tail = screenText.slice(echo.index + echo.command.length);
    const parsed = parseScreen(tail);
    // An agent that actually came up is not a rejected resume, whatever else
    // its own output happens to say.
    if (screenHasReadyAgentIdentity(agent.cli, tail, parsed)) return null;
    return (
      tail
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .find((line) => RESUME_REJECTION_RE.test(line)) ?? null
    );
  }

  private async attemptSameSurfaceAutoRevive(
    agent: AgentRecord,
    knownShellScreenText?: string,
  ): Promise<AgentRecord> {
    const attempt = (agent.revive_attempts ?? 0) + 1;
    if (attempt > MAX_RESPAWN_ATTEMPTS) {
      return this.markAutoReviveUnrecoverable(
        agent,
        `maximum attempts exceeded (${MAX_RESPAWN_ATTEMPTS})`,
      );
    }
    const sessionId = agent.cli_session_id;
    if (!sessionId) {
      return this.markAutoReviveUnrecoverable(
        agent,
        "captured session id is missing",
      );
    }
    const target = await this.classifyReviveTarget(agent, knownShellScreenText);
    if (target === "live_agent") {
      return this.markAutoReviveRecovered(agent);
    }
    if (target === "unverified") {
      return this.deferAutoReviveAttempt(agent, attempt);
    }
    const attemptedAt = new Date().toISOString();
    let attempted = this.stateMgr.updateRecord(agent.agent_id, {
      revive_attempts: attempt,
      revive_last_attempt_at: attemptedAt,
      revive_next_attempt_at: null,
      revive_last_outcome: "pending",
      revive_last_error: null,
      revive_completed_at: null,
      revive_observation_source: "screen",
      revive_observed_at_ms: Date.now(),
    });
    this.registry.set(agent.agent_id, attempted);
    try {
      await this.beforeCrashRecoveryMutation?.({
        phase: "resume",
        agent_id: attempted.agent_id,
        surface: attempted.surface_id,
        workspace: attempted.workspace_id ?? undefined,
      });
      const observerEpoch = this.captureSurfaceObserverEpoch();
      const creating = this.stateMgr.transition(
        attempted.agent_id,
        "creating",
        {
          error: null,
          pid: null,
          cli_session_id: sessionId,
        },
      );
      this.registry.set(agent.agent_id, creating);
      const booting = this.stateMgr.transition(attempted.agent_id, "booting", {
        error: null,
        pid: null,
        cli_session_id: sessionId,
      });
      this.registry.set(agent.agent_id, booting);
      await this.sendLaunchCommand(
        booting.surface_id,
        booting.workspace_id ?? undefined,
        buildRawResumeCommand(booting.cli, booting.repo, sessionId),
        booting.agent_id,
        observerEpoch,
        undefined,
        true,
      );
      return this.registry.get(agent.agent_id) ?? booting;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const current = this.registry.get(agent.agent_id) ?? attempted;
      let failed = current;
      try {
        failed =
          current.state === "error"
            ? current
            : this.stateMgr.transition(current.agent_id, "error", {
                error: `Auto-revive attempt ${attempt} failed: ${message}`,
              });
        failed = this.stateMgr.updateRecord(failed.agent_id, {
          revive_last_outcome: "failed",
          revive_last_error: message,
          revive_next_attempt_at: new Date(
            Date.now() + this.autoReviveBackoffMs(attempt),
          ).toISOString(),
          revive_observation_source: "screen",
          revive_observed_at_ms: Date.now(),
        });
        this.registry.set(agent.agent_id, failed);
      } catch {
        return current;
      }
      if (attempt >= MAX_RESPAWN_ATTEMPTS) {
        return this.markAutoReviveUnrecoverable(failed, message);
      }
      return failed;
    }
  }

  private async finalizeAutoReviveSuccess(
    agent: AgentRecord,
  ): Promise<AgentRecord> {
    if (agent.revive_last_outcome !== "pending") return agent;
    const completedAt = new Date().toISOString();
    let completed = this.stateMgr.updateRecord(agent.agent_id, {
      revive_last_outcome: "revived",
      revive_last_error: null,
      revive_next_attempt_at: null,
      revive_completed_at: completedAt,
      revive_observation_source: "screen",
      revive_observed_at_ms: Date.now(),
      error: null,
    });
    this.registry.set(agent.agent_id, completed);
    const notification = await this.dispatchCliExitOutcome(
      completed,
      "revived",
    );
    completed = notification.record;
    this.appendAutoReviveCliExitEvent(
      completed,
      "revived",
      notification.dispatched,
    );
    return completed;
  }

  private async recoverPendingCliExits(): Promise<void> {
    for (const agent of this.registry.list()) {
      if (
        (agent.revive_last_outcome === "revived" ||
          agent.revive_last_outcome === "unrecoverable") &&
        agent.parent_agent_id &&
        !agent.revive_notification_sent_at
      ) {
        await this.dispatchCliExitOutcome(agent, agent.revive_last_outcome);
        continue;
      }
      if (
        agent.state !== "error" ||
        (agent.revive_last_outcome !== "failed" &&
          agent.revive_last_outcome !== "pending")
      ) {
        continue;
      }
      if (!this.shouldAutoReviveCliExit(agent)) continue;
      if ((agent.revive_attempts ?? 0) >= MAX_RESPAWN_ATTEMPTS) {
        await this.markAutoReviveUnrecoverable(
          agent,
          agent.revive_last_error ??
            agent.error ??
            "readiness verification failed",
        );
        continue;
      }
      const nextAttemptAt = Date.parse(agent.revive_next_attempt_at ?? "");
      const derivedNextAttemptAt =
        Date.parse(agent.revive_last_attempt_at ?? "") +
        this.autoReviveBackoffMs(agent.revive_attempts ?? 1);
      const dueAt = Number.isNaN(nextAttemptAt)
        ? derivedNextAttemptAt
        : nextAttemptAt;
      if (!Number.isNaN(dueAt) && Date.now() < dueAt) continue;
      await this.attemptSameSurfaceAutoRevive(agent);
    }
  }

  private async maybeMarkCliExited(
    agent: AgentRecord,
    ctx: SweepAgentContext,
    knownScreenText?: string,
  ): Promise<AgentRecord> {
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

    if (this.shouldAutoReviveCliExit(exited)) {
      const tracked = this.stateMgr.updateRecord(exited.agent_id, {
        revive_last_attempt_at: null,
        revive_next_attempt_at: null,
        revive_completed_at: null,
        revive_last_outcome: "pending",
        revive_last_error: null,
        revive_observation_source: "screen",
        revive_observed_at_ms: Date.now(),
        revive_previous_state: agent.state,
        revive_consecutive_observations: observations,
        revive_notification_sent_at: null,
      });
      this.registry.set(agent.agent_id, tracked);
      this.appendAutoReviveCliExitEvent(tracked, "pending", false);
      // This sweep just proved the surface is a bare shell; reuse that read
      // rather than paying for (and racing on) a second one.
      return this.attemptSameSurfaceAutoRevive(tracked, screenText);
    }

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

  private async maybeArchiveDoneAgent(agent: AgentRecord): Promise<boolean> {
    void agent;
    // Sweeps must never close user panes. TASK_DONE marks state only; explicit
    // close_surface/stop_agent remain available when an orchestrator chooses it.
    return false;
  }

  private async maybeReapIdleWorker(agent: AgentRecord): Promise<boolean> {
    void agent;
    // The old idle-worker reaper was too destructive for unattended workspaces.
    // Keep panes visible until an explicit close command is issued.
    return false;
  }

  private isRecoverableCrash(agent: AgentRecord): boolean {
    return isCrashRecoveryEligible(agent);
  }

  private async persistCrashRecoveryFailure(
    agentId: string,
    message: string,
  ): Promise<void> {
    const current = this.registry.get(agentId);
    if (!current) {
      return;
    }

    try {
      if (TERMINAL_STATES.has(current.state)) {
        const failed = this.stateMgr.updateRecord(agentId, {
          error: `Crash recovery failed: ${message}`,
        });
        this.registry.set(agentId, failed);
        return;
      }

      const failed = this.stateMgr.transition(agentId, "error", {
        error: `Crash recovery failed: ${message}`,
      });
      this.registry.set(agentId, failed);
    } catch (persistError) {
      const persistMessage =
        persistError instanceof Error
          ? persistError.message
          : String(persistError);
      if (persistMessage.includes("Agent not found")) {
        this.registry.remove(agentId);
        await this.client.log(
          `crash-recovery: dropped missing agent ${agentId} after failure`,
          { level: "warning", source: "cmuxlayer" },
        );
        return;
      }

      await this.client.log(
        `crash-recovery: failed to persist error for ${agentId}: ${persistMessage}`,
        { level: "error", source: "cmuxlayer" },
      );
    }
  }

  private async markCrashRecoveryExhausted(agent: AgentRecord): Promise<void> {
    const updated = this.stateMgr.updateRecord(agent.agent_id, {
      error: `Max crash recoveries exceeded: ${MAX_RESPAWN_ATTEMPTS}`,
    });
    this.registry.set(agent.agent_id, updated);
    await this.client.log(
      `crash-recovery: max crash recoveries exceeded for ${agent.agent_id}`,
      { level: "error", source: "cmuxlayer" },
    );
  }

  private async cleanupUnboundCreatedSurface(
    surface: CreatedAgentSurface,
    operation: "agent-placement" | "crash-recovery",
  ): Promise<void> {
    try {
      let surfaceRef = surface.surface;
      let workspace = surface.actual_workspace ?? surface.workspace;
      let cleanupEpoch = surface.observerEpoch;

      if (!this.isSurfaceObserverEpochCurrent(cleanupEpoch)) {
        const currentObserverId = this.registry.getObserverId();
        if (
          !surface.surface_id ||
          !surface.observerId ||
          currentObserverId !== surface.observerId
        ) {
          await this.logUnboundSurfaceCleanupWarning(
            `${operation}: refusing cleanup of unbound ${surface.surface} ` +
              `(${surface.surface_id ?? "UUID unknown"}); surface observer ` +
              `ownership changed`,
          );
          return;
        }

        const topology = await this.collectObservedSurfaceTopology();
        if (
          topology?.complete !== true ||
          topology.workspaceBySurface.size === 0
        ) {
          await this.logUnboundSurfaceCleanupWarning(
            `${operation}: could not prove unbound surface ${surface.surface_id} ` +
              `for cleanup after reconnect`,
          );
          return;
        }
        const binding = resolveAgentSurfaceBinding(
          {
            surface_id: surface.surface,
            surface_uuid: surface.surface_id,
          },
          topology,
        );
        if (!binding || binding.provenance !== "uuid") {
          await this.logUnboundSurfaceCleanupWarning(
            `${operation}: stable surface ${surface.surface_id} was not uniquely ` +
              `resolvable for cleanup`,
          );
          return;
        }
        surfaceRef = binding.surfaceRef;
        workspace = binding.workspaceId ?? workspace;
        cleanupEpoch = this.captureSurfaceObserverEpoch();
      }

      await this.client.closeSurface(surfaceRef, {
        workspace,
        collapsePane: false,
        beforeMutation: async () => {
          this.assertSurfaceObserverEpochCurrent(
            cleanupEpoch,
            `${operation} cleanup`,
          );
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logUnboundSurfaceCleanupWarning(
        `${operation}: failed to clean unbound surface ${surface.surface} ` +
          `(${surface.surface_id ?? "UUID unknown"}): ${message}`,
      );
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

  private async recoverCrashedAgents(): Promise<void> {
    const erroredAgents = this.registry.list({ state: "error" });
    for (const agent of erroredAgents) {
      if (!this.isRecoverableCrash(agent)) {
        continue;
      }
      if (!this.registry.canControlSurface(agent)) {
        // Only the observer that owned the crashed surface may respawn it.
        // Legacy unowned rows stay quarantined until exact UUID evidence binds
        // them or startup cleanup removes them.
        continue;
      }

      const nextRespawnAttempt = (agent.respawn_attempts ?? 0) + 1;
      if (nextRespawnAttempt > MAX_RESPAWN_ATTEMPTS) {
        await this.markCrashRecoveryExhausted(agent);
        continue;
      }

      let createdSurface: CreatedAgentSurface | null = null;
      let createdSurfaceBound = false;
      try {
        const sessionId = agent.cli_session_id;
        if (!sessionId) {
          throw new Error("Crash recovery requires a captured session id");
        }
        // Surface the REAL reason (bad session id, missing cwd, no UUID
        // resume form) instead of flattening it to "not resumable".
        const recovery = resumeInvocationForAgent({
          ...agent,
          cli_session_id: sessionId,
        });
        if (recovery.command === null) throw new Error(recovery.reason);
        const resumeCmd = recovery.command;
        await this.beforeCrashRecoveryMutation?.({
          phase: "placement",
          agent_id: agent.agent_id,
          workspace: agent.workspace_id ?? undefined,
        });
        const attempted = this.stateMgr.updateRecord(agent.agent_id, {
          respawn_attempts: nextRespawnAttempt,
        });
        this.registry.set(agent.agent_id, attempted);

        const surface = await this.createAgentSurface(
          agent.workspace_id ?? undefined,
          {
            role: inferRecordRole(agent),
            parentAgent: agent.parent_agent_id
              ? this.registry.get(agent.parent_agent_id)
              : null,
            repo: agent.repo,
          },
        );
        createdSurface = surface;
        this.assertSurfaceObserverEpochCurrent(
          surface.observerEpoch,
          "crash recovery",
        );
        const resumeWorkspace = surface.actual_workspace ?? surface.workspace;
        await this.beforeCrashRecoveryMutation?.({
          phase: "resume",
          agent_id: agent.agent_id,
          surface: surface.surface,
          workspace: resumeWorkspace,
        });
        this.assertSurfaceObserverEpochCurrent(
          surface.observerEpoch,
          "crash recovery",
        );
        const creating = this.stateMgr.transition(agent.agent_id, "creating", {
          error: null,
          pid: null,
          cli_session_id: agent.cli_session_id,
        });
        this.registry.set(agent.agent_id, creating);

        const patched = this.stateMgr.updateRecord(agent.agent_id, {
          surface_id: surface.surface,
          surface_uuid: surface.surface_id ?? null,
          surface_observer_id: surface.observerId,
          surface_provenance: "cmuxlayer_spawn",
          workspace_id: resumeWorkspace,
          crash_recover: true,
          respawn_attempts: nextRespawnAttempt,
          user_killed: false,
          deletion_intent: false,
          error: null,
          pid: null,
        });
        this.registry.set(agent.agent_id, patched);
        createdSurfaceBound = true;

        const booting = this.stateMgr.transition(agent.agent_id, "booting", {
          error: null,
          pid: null,
          cli_session_id: agent.cli_session_id,
        });
        this.registry.set(agent.agent_id, booting);

        await this.sendLaunchCommand(
          surface.surface,
          resumeWorkspace,
          resumeCmd,
          agent.agent_id,
          surface.observerEpoch,
        );
        await this.client.log(
          `crash-recovery: respawned ${agent.agent_id} on ${surface.surface}`,
          { level: "warning", source: "cmuxlayer" },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (createdSurface && !createdSurfaceBound) {
          await this.cleanupUnboundCreatedSurface(
            createdSurface,
            "crash-recovery",
          );
        }
        await this.persistCrashRecoveryFailure(agent.agent_id, message);
      }
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
    this.fleetScreenProgress.delete(agentId);
    this.cliExitShellMatches.delete(agentId);
    this.promptMotionObservedAtMs.delete(agentId);
    this.promptMotionScreenSignatures.delete(agentId);
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
  ): Promise<void> {
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

  private clearHealthNotificationMemory(agentId: string): void {
    const healthPrefix = `${agentId}:health:`;
    for (const key of this.notifiedEvents) {
      if (key.startsWith(healthPrefix)) {
        this.notifiedEvents.delete(key);
      }
    }
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

  private surfaceObserverIdProvider(): SurfaceObserverIdProvider | undefined {
    return this.registry.isObserverOwnershipEnforced()
      ? () => this.registry.getObserverEpoch()
      : undefined;
  }

  private captureSurfaceObserverEpoch(): SurfaceObserverEpoch {
    return captureObserverEpoch(this.surfaceObserverIdProvider());
  }

  private isSurfaceObserverEpochCurrent(
    observerEpoch: SurfaceObserverEpoch,
  ): boolean {
    return isSurfaceObserverEpochCurrent(
      observerEpoch,
      this.surfaceObserverIdProvider(),
    );
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

  private collectObservedSurfaceTopology(): Promise<SurfaceTopologySnapshot | null> {
    return collectSurfaceTopology(
      this.client,
      undefined,
      this.surfaceObserverIdProvider(),
    );
  }

  /**
   * Sync sidebar: diff agents against snapshot, push only changes.
   * Logs lifecycle events (spawned, done, error) once each.
   */
  private async syncSidebar(
    opts: { firstConnect?: boolean } = {},
  ): Promise<void> {
    const agents = this.registry.list();
    const total = agents.length;
    const done = agents.filter((a) => a.state === "done").length;
    const surfaceTopology = await this.collectObservedSurfaceTopology();
    const observedLiveSurfaceRefs =
      surfaceTopology?.complete === true
        ? [...surfaceTopology.workspaceBySurface.keys()].sort()
        : null;
    const observedUuidCoverage =
      observedLiveSurfaceRefs === null
        ? "unknown"
        : surfaceTopology!.surfaceRefById.size === 0
          ? "legacy"
          : surfaceTopology!.surfaceRefById.size ===
              observedLiveSurfaceRefs.length
            ? "complete"
            : "mixed";
    const topologyIsAuthoritative =
      surfaceTopology?.complete === true &&
      observedLiveSurfaceRefs !== null &&
      observedLiveSurfaceRefs.length > 0 &&
      observedUuidCoverage !== "mixed";
    const statusUpdates: CmuxStatusUpdate[] = [];
    const pendingStatusSnapshots: Array<{
      agentId: string;
      snapshot: SidebarStatusSnapshot;
    }> = [];
    const fleetCandidates: FleetSidebarCandidate[] = [];

    for (const registryAgent of agents) {
      if (opts.firstConnect && TERMINAL_STATES.has(registryAgent.state)) {
        this.cliExitShellMatches.delete(registryAgent.agent_id);
        continue;
      }
      if (!topologyIsAuthoritative) {
        // Empty, partial, mixed-identity, and contradictory observations are
        // preservation signals only. Never read a persisted ref or mutate
        // lifecycle/status state until one coherent topology can bind the row.
        this.cliExitShellMatches.delete(registryAgent.agent_id);
        continue;
      }
      const surfaceBinding = resolveAgentSurfaceBinding(
        registryAgent,
        surfaceTopology,
      );
      if (!surfaceBinding) {
        // A known UUID that is absent from this live topology must not borrow a
        // recycled ref's screen, title, or click route. Unknown/partial
        // publication preserves the last good source until topology recovers.
        const prev = this.sidebarSnapshot.get(registryAgent.agent_id);
        if (prev) {
          try {
            await this.client.clearStatus(registryAgent.agent_id, {
              workspace: prev.workspaceId ?? undefined,
            });
          } catch {
            // Best-effort cleanup for a no-longer-resolvable binding.
          }
        }
        this.sidebarSnapshot.delete(registryAgent.agent_id);
        // The registry row still exists. Keep once-only lifecycle delivery
        // memory so a recovered binding cannot re-emit "spawned" or terminal
        // notifications merely because one topology snapshot omitted its UUID.
        this.cliExitShellMatches.delete(registryAgent.agent_id);
        continue;
      }

      const observedSurfaceUuid =
        surfaceTopology?.surfaceIdByRef.get(surfaceBinding.surfaceRef) ?? null;
      if (
        !this.registry.canUseObservedBinding(registryAgent, observedSurfaceUuid)
      ) {
        // A live ref without compatible provenance cannot publish, read, or
        // mutate this row. Preserve it for its owning observer.
        this.cliExitShellMatches.delete(registryAgent.agent_id);
        continue;
      }

      let originalAgent = registryAgent;
      const realSurfaceUuid = observedSurfaceUuid;
      const bindingPatch: Partial<AgentRecord> = {};
      if (originalAgent.surface_id !== surfaceBinding.surfaceRef) {
        bindingPatch.surface_id = surfaceBinding.surfaceRef;
      }
      if (
        realSurfaceUuid &&
        originalAgent.surface_uuid !== realSurfaceUuid &&
        (surfaceBinding.provenance === "uuid" ||
          surfaceTopology?.complete === true)
      ) {
        bindingPatch.surface_uuid = realSurfaceUuid;
      }
      if (
        surfaceBinding.workspaceId &&
        (originalAgent.workspace_id ?? null) !== surfaceBinding.workspaceId
      ) {
        bindingPatch.workspace_id = surfaceBinding.workspaceId;
      }
      const observerId = this.registry.getObserverId();
      if (observerId && originalAgent.surface_observer_id !== observerId) {
        bindingPatch.surface_observer_id = observerId;
      }
      if (Object.keys(bindingPatch).length > 0) {
        originalAgent = this.stateMgr.updateRecord(
          originalAgent.agent_id,
          bindingPatch,
        );
        this.registry.set(originalAgent.agent_id, originalAgent);
      }
      const sweepCtx: SweepAgentContext = {};
      // MCP readiness must not depend on a synchronous scan of the host's
      // transcript tree. Normal sweeps retry transcript capture after startup.
      const capturedAgent = await this.maybeCaptureBootSessionId(
        originalAgent,
        sweepCtx,
        { resolveTranscript: opts.firstConnect !== true },
      );
      const readyAgent = await this.maybeMarkBootReady(capturedAgent, sweepCtx);
      const taskDoneResult = await this.maybeMarkTaskDone(readyAgent, sweepCtx);
      let agent = await this.maybeMarkCliExited(
        taskDoneResult.agent,
        sweepCtx,
        taskDoneResult.screenText,
      );
      const initialAgentId = agent.agent_id;
      if (this.isKnownClosedSurface(agent, surfaceTopology)) {
        const prev = this.sidebarSnapshot.get(initialAgentId);
        if (prev) {
          try {
            await this.client.clearStatus(initialAgentId, {
              workspace: prev.workspaceId ?? undefined,
            });
          } catch {
            // Best-effort cleanup; closed panes must not emit fresh health signals.
          }
        }
        this.sidebarSnapshot.delete(initialAgentId);
        this.clearAgentLifecycleMemory(initialAgentId);
        continue;
      }
      // AIDEV-NOTE (T1b/#488): the sweep is the third emitter -- its
      // harvestability feeds the health input, the sidebar row's `report=` and
      // the done notification, beside a state derived from the screen it reads
      // below. When the done-detection pass already has this agent's screen
      // text in hand, closure resolves from THAT rather than from the discovery
      // cache, which may be cold on this path too. No new read: when there is
      // no screen text, the injected probe is used exactly as before.
      // The done-detection pass returns early for a record already at `done`
      // -- exactly #488's shape -- so its screen text is absent precisely when
      // closure needs it. `readSweepScreen` memoizes on `sweepCtx`, which the
      // health input below reuses for this same agent, so this shares that
      // read rather than adding one.
      let sweepScreenText = taskDoneResult.screenText;
      if (sweepScreenText === undefined) {
        try {
          sweepScreenText = (await this.readSweepScreen(agent, sweepCtx)).text;
        } catch {
          // No screen is no evidence; the injected probe answers as before.
        }
      }
      const harvestability = this.assessHarvestability(agent, {
        live:
          sweepScreenText === undefined
            ? null
            : resolveLiveAgentState(agent, parseScreen(sweepScreenText)),
      });
      const healthScreenContexts = new Map<string, SweepAgentContext>();
      let screenCurrentAction: string | null = null;
      const healthScreenContextFor = (
        targetAgent: AgentRecord,
      ): SweepAgentContext => {
        if (targetAgent.agent_id === agent.agent_id) return sweepCtx;
        const existing = healthScreenContexts.get(targetAgent.agent_id);
        if (existing) return existing;
        const next: SweepAgentContext = {};
        healthScreenContexts.set(targetAgent.agent_id, next);
        return next;
      };
      const healthInput = await buildAgentHealthInput(
        agent,
        {
          inboxOpts: this.inboxOpts,
          resolveTopology: async (targetAgent) =>
            surfaceTopology?.topologyBySurface.get(targetAgent.surface_id) ??
            EMPTY_SURFACE_TOPOLOGY,
          readParsedSurface: async (targetAgent) => {
            try {
              const screenText =
                targetAgent.agent_id === agent.agent_id &&
                taskDoneResult.screenText !== undefined
                  ? taskDoneResult.screenText
                  : (
                      await this.readSweepScreen(
                        targetAgent,
                        healthScreenContextFor(targetAgent),
                      )
                    ).text;
              const parsed = parseScreen(screenText);
              if (targetAgent.agent_id === agent.agent_id) {
                screenCurrentAction = parsed.current_action;
              }
              return {
                status: parsed.status,
                actions: parsed.actions,
              };
            } catch {
              return null;
            }
          },
          resolveSurfaceWorkspace: async (targetAgent) =>
            surfaceTopology?.workspaceBySurface.get(targetAgent.surface_id) ??
            null,
          resolveCollapsedMonitors: (ownerSeats) => {
            if (!this.monitorRegistryPath) return [];
            const owners = new Set(ownerSeats);
            return readMonitorRegistry({
              registryPath: this.monitorRegistryPath,
            })
              .monitors.filter(
                (monitor) =>
                  monitor.state === "collapsed" &&
                  owners.has(monitor.owner_seat),
              )
              .map((monitor) => ({
                monitor_id: monitor.monitor_id,
                reason: monitor.collapsed_reason ?? "unknown",
              }));
          },
        },
        {
          ...healthTopologyOverrides(agent, surfaceTopology),
          parent_role: agent.parent_agent_id
            ? (() => {
                const parent =
                  this.registry.get(agent.parent_agent_id) ??
                  this.stateMgr.readState(agent.parent_agent_id);
                return parent ? inferRecordRoleOrNull(parent) : null;
              })()
            : null,
          harvestability,
        },
      );
      if (
        !(await this.sweepReadMatchesBinding(
          sweepCtx,
          surfaceBinding.surfaceRef,
        ))
      ) {
        // The fresh I/O resolver observed this stable UUID at a different ref
        // than the topology snapshot that began the sweep. The screen belongs
        // to the fresh route, while title/topology still belong to the outer
        // snapshot, so publishing either as one row would invert seat state.
        const prev = this.sidebarSnapshot.get(initialAgentId);
        if (prev) {
          try {
            await this.client.clearStatus(initialAgentId, {
              workspace: prev.workspaceId ?? undefined,
            });
          } catch {
            // Best-effort cleanup; the next coherent sweep republishes it.
          }
        }
        this.sidebarSnapshot.delete(initialAgentId);
        this.clearAgentLifecycleMemory(initialAgentId);
        continue;
      }
      let haltScreenText = taskDoneResult.screenText;
      if (haltScreenText === undefined) {
        try {
          haltScreenText = (await this.readSweepScreen(agent, sweepCtx)).text;
        } catch {
          // No live screen proof means no halt classification or escalation.
        }
      }
      if (haltScreenText !== undefined) {
        agent = await this.maybeEscalateLiveHalt(agent, haltScreenText);
      }
      const { agent_id: agentId, state } = agent;
      const boundSurfaceRef = surfaceBinding.surfaceRef;
      const boundWorkspaceId =
        surfaceBinding.workspaceId ?? agent.workspace_id ?? null;
      const health = evaluateAgentHealth(agent, healthInput);
      await this.maybeNotifyLeadMonitorDeath(agent, healthInput);
      const healthSignature = this.healthSignature(health);
      const statusValue = this.buildSidebarStatusValue(
        agent,
        health,
        harvestability,
      );
      const statusSnapshot: SidebarStatusSnapshot = {
        statusValue,
        surfaceId: boundSurfaceRef,
        workspaceId: boundWorkspaceId,
        healthSignature,
      };
      const prev = this.sidebarSnapshot.get(agentId);

      // Lifecycle log: spawned (first encounter)
      if (!prev) {
        await this.logLifecycleEvent(agent, "spawned");
      }

      // Lifecycle log: done
      if (state === "done") {
        await this.logLifecycleEvent(agent, "done");
        if (this.shouldNotifyDone(harvestability)) {
          await this.notifyLifecycleEvent(agent, "done");
        }
      }

      // Lifecycle log: error
      if (state === "error") {
        await this.logLifecycleEvent(agent, "errored");
        await this.notifyLifecycleEvent(agent, "errored");
      }

      const shouldNotifyHealth = this.shouldNotifyHealthChange(prev, health);
      let healthNotificationDelivered = true;
      if (shouldNotifyHealth) {
        healthNotificationDelivered = await this.notifyLifecycleEvent(
          agent,
          "health",
          healthSignature,
        );
      } else if (
        prev &&
        prev.healthSignature !== healthSignature &&
        health.status !== "unhealthy"
      ) {
        this.clearHealthNotificationMemory(agentId);
      }

      const archived = await this.maybeArchiveDoneAgent(agent);
      const reaped = archived ? false : await this.maybeReapIdleWorker(agent);
      if (archived || reaped) {
        try {
          await this.client.clearStatus(agentId, {
            workspace: agent.workspace_id ?? undefined,
          });
        } catch {
          // Best-effort sidebar cleanup; the surface has already been closed.
        }
        this.registry.remove(agentId);
        this.stateMgr.removeState(agentId);
        this.sidebarSnapshot.delete(agentId);
        this.clearAgentLifecycleMemory(agentId);
        continue;
      }

      if (!(opts.firstConnect && TERMINAL_STATES.has(state))) {
        fleetCandidates.push({
          agentId: agent.agent_id,
          agentType: agent.cli,
          agentState: state,
          lastProgressAtMs: this.lastAgentProgressAtMs(agent),
          surfaceUuid: observedSurfaceUuid ?? undefined,
          surfaceRef: boundSurfaceRef,
          surfaceTitle:
            surfaceBinding.title ??
            surfaceTopology?.titleBySurface.get(boundSurfaceRef) ??
            null,
          repo: agent.repo,
          seatLane: agent.seat_lane ?? null,
          seatId: agent.seat_id ?? null,
          launcherName: agent.launcher_name ?? null,
          role: inferRecordRoleOrNull(agent),
          discovered: agent.agent_id.startsWith("auto-"),
          registryVersion: agent.version,
          registryUpdatedAt: agent.updated_at,
          createdAt: agent.created_at,
          taskSummary: agent.task_summary ?? null,
          healthStatus: health.status,
          healthReasons: health.issues,
          healthIssueCodes: health.issue_codes,
          healthIssueSeverities: health.issue_severities ?? {},
          screenCurrentAction,
          // A shell prompt before the launcher becomes an agent is not an idle
          // agent. Keep the first-render seat visible as stalled/focusable
          // until lifecycle evidence advances beyond creating/booting.
          screenStatus:
            state === "creating" || state === "booting"
              ? null
              : toParsedScreenStatus(healthInput.screen_status),
        });
      }

      // Status diff — only push if changed
      const statusChanged =
        !prev ||
        prev.statusValue !== statusSnapshot.statusValue ||
        prev.surfaceId !== statusSnapshot.surfaceId ||
        prev.workspaceId !== statusSnapshot.workspaceId;
      if (statusChanged) {
        if (
          prev?.workspaceId &&
          prev.workspaceId !== statusSnapshot.workspaceId
        ) {
          try {
            await this.client.clearStatus(agentId, {
              workspace: prev.workspaceId,
            });
          } catch {
            // Best-effort cleanup of stale workspace-scoped status.
          }
        }
        const sidebar = STATE_SIDEBAR[state];
        statusUpdates.push({
          key: agentId,
          value: statusValue,
          icon: sidebar.icon,
          color: sidebar.color,
          surface: boundSurfaceRef,
          workspace: boundWorkspaceId ?? undefined,
        });
      }
      const nextSnapshot = {
        ...statusSnapshot,
        healthSignature:
          shouldNotifyHealth && !healthNotificationDelivered
            ? (prev?.healthSignature ?? "pending_health_notification")
            : statusSnapshot.healthSignature,
      };
      if (statusChanged) {
        pendingStatusSnapshots.push({ agentId, snapshot: nextSnapshot });
      } else {
        this.sidebarSnapshot.set(agentId, nextSnapshot);
      }

      // Quality tracking: check context usage for non-terminal agents
      // AIDEV-NOTE: Uses parseScreen for model-aware context_pct (handles Claude, Codex, Gemini).
      // Replaces legacy parseContextPercent which only matched "X% context" text patterns.
      if (!TERMINAL_STATES.has(state)) {
        try {
          const screenText =
            taskDoneResult.screenText ??
            (
              await this.readAgentScreen(agent, {
                lines: 5,
              })
            ).text;
          const parsed = parseScreen(tailScreenLines(screenText, 5));
          const contextPct = parsed.context_pct;
          if (
            contextPct !== null &&
            contextPct >= 80 &&
            agent.quality !== "degraded"
          ) {
            // Mark degraded
            const updated = this.stateMgr.updateRecord(agentId, {
              quality: "degraded",
            });
            this.registry.set(agentId, updated);

            try {
              await this.client.log(
                `context-limit: depth ${agent.spawn_depth} agent ${agent.repo} degraded at ${contextPct}%; leaving pane running for orchestrator decision`,
                { level: "warning", source: "cmuxlayer" },
              );
            } catch {
              // Logging is advisory; a root-agent nudge must still be attempted.
            }

            if (agent.spawn_depth === 0) {
              const nudgeRoute = await this.resolveAgentIoRoute(agentId);
              await this.client.send(
                nudgeRoute.surface_id,
                `[cmuxlayer] context at ${contextPct}% — checkpoint at-risk work and /compact when safe`,
                {
                  workspace: nudgeRoute.workspace_id ?? undefined,
                  ...this.stableSurfaceWriteOptions(nudgeRoute.surface_uuid),
                  beforeMutation: async () => {
                    await this.resolveUnchangedAgentIoRoute(
                      agentId,
                      nudgeRoute,
                      "context-limit nudge",
                    );
                  },
                },
              );
            }
          }
        } catch {
          // readScreen failures are non-fatal — next sweep will retry
        }
      }

      if (
        state !== "booting" &&
        !TERMINAL_STATES.has(state) &&
        (await this.registry.isSurfaceAlive(agent))
      ) {
        const heartbeat = this.stateMgr.updateRecord(agentId, {});
        this.registry.set(agentId, heartbeat);
      }
    }

    let statusBatchApplied = true;
    if (statusUpdates.length === 1) {
      const [update] = statusUpdates;
      await this.client.setStatus(update.key, update.value, update);
    } else if (statusUpdates.length > 1) {
      if (this.client.setStatuses) {
        statusBatchApplied =
          (await this.client.setStatuses(statusUpdates)) !== false;
      } else {
        for (const update of statusUpdates) {
          await this.client.setStatus(update.key, update.value, update);
        }
      }
    }
    if (statusBatchApplied) {
      for (const pending of pendingStatusSnapshots) {
        this.sidebarSnapshot.set(pending.agentId, pending.snapshot);
      }
    }

    // Clean up sidebar entries for agents that were purged from the registry
    const currentAgentIds = new Set(
      this.registry.list().map((a) => a.agent_id),
    );
    for (const agentId of this.fleetScreenProgress.keys()) {
      if (!currentAgentIds.has(agentId)) {
        this.fleetScreenProgress.delete(agentId);
      }
    }
    for (const [agentId, snapshot] of this.sidebarSnapshot) {
      if (!currentAgentIds.has(agentId)) {
        try {
          await this.client.clearStatus(agentId, {
            workspace: snapshot.workspaceId ?? undefined,
          });
        } catch {
          // Best-effort sidebar cleanup
        }
        this.sidebarSnapshot.delete(agentId);
        this.clearAgentLifecycleMemory(agentId);
      }
    }

    const observedLiveSurfaceUuids =
      observedUuidCoverage === "complete"
        ? [...surfaceTopology!.surfaceRefById.keys()].sort()
        : observedUuidCoverage === "legacy"
          ? undefined
          : null;
    const snapshot = buildFleetSidebarSnapshot(fleetCandidates, {
      liveSurfaceRefs: new Set(observedLiveSurfaceRefs ?? []),
      ...(observedLiveSurfaceUuids
        ? { liveSurfaceUuids: new Set(observedLiveSurfaceUuids) }
        : {}),
      workingNoProgressTimeoutMs: this.fleetWorkingNoProgressTimeoutMs,
    });
    const publicationState = !topologyIsAuthoritative
      ? "unknown"
      : snapshot.seatCount > 0
        ? "populated"
        : fleetCandidates.length > 0
          ? "unknown"
          : opts.firstConnect
            ? "unknown"
            : "empty";
    try {
      this.fleetSidebarPublisher.publish({
        state: publicationState,
        snapshot,
        observedLiveSurfaceRefs,
        observedLiveSurfaceUuids,
      });
    } catch {
      // Best-effort custom UI: publication must never break reconciliation.
    }
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
    opts: { agentIds?: ReadonlySet<string> } = {},
  ): Promise<RolePlacementReconcileSummary> {
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

      const observerEpoch = this.captureSurfaceObserverEpoch();
      try {
        const assertFreshAgentBinding = async (
          expectedSurfaceRef: string,
          operation: string,
        ): Promise<void> => {
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
          const topology = await this.collectObservedSurfaceTopology();
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
            const seedTopology = await this.collectObservedSurfaceTopology();
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
                  await this.collectObservedSurfaceTopology();
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
   * sidebar sync, so a fresh process cannot publish an empty first paint.
   */
  initialize(discovery: AgentDiscovery): Promise<void> {
    if (this.startupInitializePromise === null) {
      this.startupInitializePromise = this.initializeOnce(discovery);
    }
    return this.startupInitializePromise;
  }

  private async initializeOnce(discovery: AgentDiscovery): Promise<void> {
    try {
      this.fleetSidebarPublisher.publish({
        state: "discovering",
        snapshot: buildFleetSidebarSnapshot([], {
          liveSurfaceRefs: new Set(),
        }),
        observedLiveSurfaceRefs: null,
      });
    } catch {
      // Discovery and lifecycle startup must not depend on custom UI output.
    }
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
      await this.syncSidebar({ firstConnect: true });
    } catch {
      // Sidebar/status publication is auxiliary. Boot placement may go live
      // once registry ingestion and the provenance-gated sweep have completed.
    }
  }

  private async purgeStartupTerminalAgents(): Promise<void> {
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
    // Seed sidebar snapshot so syncSidebar clears their cmux entries.
    for (const purgedAgent of purgedIds) {
      this.sidebarSnapshot.set(purgedAgent.agent_id, {
        statusValue: "__purged__",
        surfaceId: purgedAgent.surface_id,
        workspaceId: purgedAgent.workspace_id ?? null,
        healthSignature: "__purged__",
      });
    }
  }

  /**
   * Public sweep: reconcile registry, purge dead entries, then sync sidebar.
   * If enableStartupPurge() was called, the first sweep also purges terminal
   * records carried over from the previous cmux session while retaining any
   * records that this startup's own topology scan just marked surfaceless.
   */
  async runLifecycleMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleMutationTail;
    let release!: () => void;
    this.lifecycleMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async runSweep(): Promise<void> {
    await this.runLifecycleMutation(() => this.runSweepOnce());
    await this.drainDeliveryQueue();
    await this.verifyPendingDeliveries();
  }

  setDeliverySubmitter(submitter: DeliverySubmitter | null): void {
    this.deliverySubmitter = submitter;
  }

  setDeliveryVerifier(verifier: DeliveryVerifier | null): void {
    this.deliveryVerifier = verifier;
  }

  setDeliverySnapshotReader(reader: DeliverySnapshotReader | null): void {
    this.deliverySnapshotReader = reader;
  }

  setDeliveryIssueFiler(filer: DeliveryIssueFiler | null): void {
    this.deliveryIssueFiler = filer;
  }

  private loadDeliveryReceipts(): void {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(this.deliveryReceiptsPath, "utf8"),
      );
      if (!Array.isArray(parsed)) return;
      let repairedReceipts = false;
      for (const candidate of parsed) {
        if (
          candidate &&
          typeof candidate === "object" &&
          typeof (candidate as AgentDeliveryReceipt).delivery_id === "string"
        ) {
          const receipt: AgentDeliveryReceipt = {
            submission_started_at: null,
            next_attempt_at: null,
            ...(candidate as AgentDeliveryReceipt),
          };
          if (
            receipt.delivery_state === "queued" &&
            receipt.submission_started_at &&
            receipt.composer_accepted !== true
          ) {
            receipt.delivery_state = "failed";
            receipt.terminal = true;
            receipt.resolved_at = new Date().toISOString();
            receipt.error =
              "Delivery outcome uncertain after process restart; refusing automatic replay";
            repairedReceipts = true;
          }
          const deadlineWatched =
            receipt.delivery_state === "pending_verify" ||
            (receipt.delivery_state === "queued" &&
              receipt.composer_accepted === true);
          if (
            deadlineWatched &&
            !receipt.terminal &&
            (receipt.verify_deadline_at == null ||
              receipt.verify_deadline_at === "")
          ) {
            receipt.verify_deadline_at = new Date(
              Date.now() + this.deliveryVerifyDeadlineMs,
            ).toISOString();
            repairedReceipts = true;
          }
          this.deliveryReceipts.set(receipt.delivery_id, receipt);
        }
      }
      if (repairedReceipts) {
        try {
          this.persistDeliveryReceipts();
        } catch {
          // In-memory terminal state still prevents replay in this process.
        }
      }
    } catch {
      // Missing or corrupt legacy state must not prevent lifecycle startup.
    }
  }

  private persistDeliveryReceipts(): void {
    mkdirSync(dirname(this.deliveryReceiptsPath), { recursive: true });
    const tempPath = `${this.deliveryReceiptsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        tempPath,
        `${JSON.stringify([...this.deliveryReceipts.values()], null, 2)}\n`,
        "utf8",
      );
      renameSync(tempPath, this.deliveryReceiptsPath);
    } finally {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    }
  }

  queueDelivery(input: {
    delivery_id?: string;
    agent_id: string;
    text: string;
    press_enter: boolean;
    source_event: DeliveryEventType;
  }): AgentDeliveryReceipt {
    const existing = input.delivery_id
      ? this.deliveryReceipts.get(input.delivery_id)
      : undefined;
    const receipt: AgentDeliveryReceipt = {
      delivery_id: input.delivery_id ?? existing?.delivery_id ?? randomUUID(),
      agent_id: input.agent_id,
      text: input.text,
      press_enter: input.press_enter,
      source_event: input.source_event,
      delivery_state: "queued",
      terminal: false,
      created_at: existing?.created_at ?? new Date().toISOString(),
      resolved_at: null,
      retry_count: existing?.retry_count ?? 0,
      submit_verified: null,
      error: null,
      submission_started_at: null,
      next_attempt_at: null,
      verify_deadline_at: null,
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    try {
      // Acceptance is not returned until the full replay payload is durable.
      this.persistDeliveryReceipts();
    } catch (error) {
      this.deliveryReceipts.delete(receipt.delivery_id);
      throw error;
    }
    this.appendDeliveryReceiptEventBestEffort(receipt);
    return { ...receipt };
  }

  acceptComposerQueue(input: {
    delivery_id: string;
    agent_id: string;
    text: string;
    press_enter: boolean;
    source_event: DeliveryEventType;
    retry_count: number;
    delivery_state?: "queued" | "queued_followup";
  }): AgentDeliveryReceipt {
    const acceptedAt = new Date().toISOString();
    const existing = this.deliveryReceipts.get(input.delivery_id);
    const queuedFollowup =
      (input.delivery_state ?? "queued") === "queued_followup";
    const receipt: AgentDeliveryReceipt = {
      ...input,
      delivery_state: input.delivery_state ?? "queued",
      terminal: false,
      created_at: existing?.created_at ?? acceptedAt,
      resolved_at: null,
      submit_verified: null,
      error: null,
      submission_started_at: existing?.submission_started_at ?? acceptedAt,
      next_attempt_at: null,
      composer_accepted: true,
      verify_deadline_at: queuedFollowup
        ? null
        : (existing?.verify_deadline_at ??
          new Date(Date.now() + this.deliveryVerifyDeadlineMs).toISOString()),
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    try {
      this.persistDeliveryReceipts();
    } catch (error) {
      this.deliveryReceipts.delete(receipt.delivery_id);
      throw error;
    }
    return { ...receipt };
  }

  resolveDelivery(
    input: Omit<AgentDeliveryReceipt, "created_at" | "resolved_at"> & {
      created_at?: string;
    },
    opts?: { appendFailureEvent?: boolean },
  ): AgentDeliveryReceipt {
    const receipt: AgentDeliveryReceipt = {
      ...input,
      created_at: input.created_at ?? new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    this.persistDeliveryReceipts();
    if (
      (receipt.delivery_state === "failed" ||
        receipt.delivery_state === "failed_confirmed") &&
      opts?.appendFailureEvent
    ) {
      this.appendDeliveryReceiptEventBestEffort(receipt);
    }
    return { ...receipt };
  }

  getDeliveryReceipt(deliveryId: string): AgentDeliveryReceipt | null {
    const receipt = this.deliveryReceipts.get(deliveryId);
    return receipt ? { ...receipt } : null;
  }

  listDeliveryReceipts(): AgentDeliveryReceipt[] {
    return [...this.deliveryReceipts.values()].map((receipt) => ({
      ...receipt,
    }));
  }

  findOpenDuplicate(input: {
    agent_id: string;
    text: string;
    press_enter: boolean;
  }): AgentDeliveryReceipt | null {
    for (const receipt of this.deliveryReceipts.values()) {
      if (
        (receipt.delivery_state === "pending_verify" ||
          receipt.delivery_state === "queued" ||
          receipt.delivery_state === "queued_followup") &&
        receipt.agent_id === input.agent_id &&
        receipt.text === input.text &&
        receipt.press_enter === input.press_enter
      ) {
        return { ...receipt };
      }
    }
    return null;
  }

  acceptPendingVerify(input: {
    delivery_id: string;
    agent_id: string;
    text: string;
    press_enter: boolean;
    source_event: DeliveryEventType;
    retry_count: number;
    created_at?: string;
  }): AgentDeliveryReceipt {
    const now = new Date().toISOString();
    const existing = this.deliveryReceipts.get(input.delivery_id);
    const receipt: AgentDeliveryReceipt = {
      ...input,
      delivery_state: "pending_verify",
      terminal: false,
      created_at: input.created_at ?? existing?.created_at ?? now,
      resolved_at: null,
      submit_verified: null,
      error: null,
      submission_started_at: existing?.submission_started_at ?? now,
      next_attempt_at: null,
      verify_deadline_at:
        existing?.verify_deadline_at ??
        new Date(Date.now() + this.deliveryVerifyDeadlineMs).toISOString(),
    };
    this.deliveryReceipts.set(receipt.delivery_id, receipt);
    this.persistDeliveryReceipts();
    return { ...receipt };
  }

  async waitForDelivery(
    deliveryId: string,
    timeoutMs: number,
  ): Promise<AgentDeliveryReceipt & { timed_out?: boolean }> {
    const start = Date.now();
    const existing = this.getDeliveryReceipt(deliveryId);
    if (!existing) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }
    if (existing.terminal) {
      return existing;
    }
    return new Promise<AgentDeliveryReceipt & { timed_out?: boolean }>(
      (resolve, reject) => {
        const finish = (
          receipt: AgentDeliveryReceipt & { timed_out?: boolean },
        ) => {
          clearInterval(timer);
          resolve(receipt);
        };
        const timer = setInterval(() => {
          const elapsed = Date.now() - start;
          const current = this.getDeliveryReceipt(deliveryId);
          if (!current) {
            clearInterval(timer);
            reject(new Error(`Delivery not found: ${deliveryId}`));
            return;
          }
          if (current.terminal) {
            finish(current);
            return;
          }
          if (elapsed >= timeoutMs) {
            finish({ ...current, timed_out: true });
          }
        }, DELIVERY_WAIT_POLL_MS);
      },
    );
  }

  async verifyPendingDeliveries(): Promise<void> {
    if (this.deliveryVerifyInFlight || !this.deliveryVerifier) return;
    this.deliveryVerifyInFlight = true;
    try {
      const snapshots = new Map<string, DeliveryVerifySnapshot | null>();
      for (const receipt of this.deliveryReceipts.values()) {
        const watching =
          receipt.delivery_state === "pending_verify" ||
          receipt.delivery_state === "queued_followup" ||
          (receipt.delivery_state === "queued" &&
            receipt.composer_accepted === true);
        if (!watching || receipt.terminal) continue;
        const deadlineApplies = receipt.delivery_state !== "queued_followup";
        const deadlineMs = receipt.verify_deadline_at
          ? Date.parse(receipt.verify_deadline_at)
          : Date.parse(receipt.created_at) + this.deliveryVerifyDeadlineMs;
        const now = Date.now();
        const timedOut = deadlineApplies && now >= deadlineMs;
        const skipRead = this.shouldSkipVerifyRead(receipt, now);
        let observation: DeliveryVerifyObservation = { outcome: "pending" };
        if (skipRead && !timedOut) continue;
        if (!skipRead && this.deliveryVerifier) {
          const agent = this.getAgentState(receipt.agent_id);
          const snapshotKey = agent?.surface_id ?? receipt.agent_id;
          let snapshot: DeliveryVerifySnapshot | null | undefined;
          if (this.deliverySnapshotReader) {
            if (!snapshots.has(snapshotKey)) {
              // AIDEV-NOTE (T2 #450): the snapshot read must be inside the
              // hang guard, not before it. SF8 hoisted the surface read out of
              // the verifier and awaited it OUTSIDE SF7's race; the CLI
              // fallback path has no subprocess timeout, so one wedged `cmux`
              // held deliveryVerifyInFlight forever and every later verify
              // pass short-circuited -- exactly the stall SF7 exists to
              // prevent. A timed-out read yields a null snapshot, which the
              // verifier already treats as "no evidence, stay pending".
              snapshots.set(
                snapshotKey,
                await this.withDeliveryVerifyTimeout(
                  this.deliverySnapshotReader(receipt),
                  "Delivery snapshot read",
                ).catch(() => null),
              );
            }
            snapshot = snapshots.get(snapshotKey) ?? null;
          }
          try {
            observation = await this.withDeliveryVerifyTimeout(
              this.deliveryVerifier(receipt, snapshot),
              "Delivery verify",
            );
          } catch (error) {
            observation = {
              outcome: "pending",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          receipt.verify_last_attempt_at = new Date().toISOString();
          this.persistDeliveryReceipts();
        }
        if (observation.outcome === "delivered") {
          receipt.delivery_state = "submitted";
          receipt.terminal = true;
          receipt.resolved_at = new Date().toISOString();
          receipt.submit_verified = observation.submit_verified ?? true;
          receipt.error = null;
          receipt.verify_miss_count = 0;
          this.persistDeliveryReceipts();
          this.appendDeliveryReceiptEventBestEffort(receipt);
          continue;
        }
        if (observation.reason === "target_gone") {
          receipt.verify_miss_count = (receipt.verify_miss_count ?? 0) + 1;
          this.persistDeliveryReceipts();
        } else if ((receipt.verify_miss_count ?? 0) > 0) {
          receipt.verify_miss_count = 0;
          this.persistDeliveryReceipts();
        }
        const confirmedGone =
          observation.reason === "target_gone" &&
          (receipt.verify_miss_count ?? 0) >=
            DELIVERY_TARGET_GONE_CONFIRM_MISSES;
        if (
          observation.outcome === "failed_confirmed" ||
          confirmedGone ||
          timedOut
        ) {
          const reason =
            observation.reason ??
            (timedOut ? "verify_deadline_elapsed" : "failed_confirmed");
          receipt.delivery_state = "failed_confirmed";
          receipt.terminal = true;
          receipt.resolved_at = new Date().toISOString();
          receipt.submit_verified = false;
          receipt.error = reason;
          this.persistDeliveryReceipts();
          this.appendDeliveryReceiptEventBestEffort(receipt);
          await this.fileConfirmedFailureTicket(receipt, reason, observation);
        }
      }
    } finally {
      this.deliveryVerifyInFlight = false;
    }
  }

  /** Bound one delivery-verify side quest to the verify timeout. */
  private withDeliveryVerifyTimeout<T>(
    work: Promise<T>,
    label: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `${label} timed out after ${this.deliveryVerifyTimeoutMs}ms`,
              ),
            ),
          this.deliveryVerifyTimeoutMs,
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private verifyReadIntervalMs(
    receipt: AgentDeliveryReceipt,
    now: number,
  ): number {
    if (
      receipt.delivery_state === "queued_followup" ||
      !receipt.verify_deadline_at
    ) {
      const ageMs = Math.max(0, now - Date.parse(receipt.created_at));
      const minutes = Math.floor(ageMs / 60_000);
      return Math.min(60_000, 5_000 * 2 ** Math.min(minutes, 3));
    }
    const remaining = Math.max(0, Date.parse(receipt.verify_deadline_at) - now);
    const created = Date.parse(receipt.created_at);
    const total = Math.max(1, Date.parse(receipt.verify_deadline_at) - created);
    const remainingRatio = remaining / total;
    if (remainingRatio > 0.5) return 5_000;
    if (remainingRatio > 0.2) return 15_000;
    return 30_000;
  }

  private shouldSkipVerifyRead(
    receipt: AgentDeliveryReceipt,
    now: number,
  ): boolean {
    if (!receipt.verify_last_attempt_at) return false;
    const since = now - Date.parse(receipt.verify_last_attempt_at);
    return since > 0 && since < this.verifyReadIntervalMs(receipt, now);
  }

  /**
   * A confirmed-failure verdict is worth an issue only when something was
   * actually observed to go wrong with the message.
   *
   * AIDEV-NOTE (T2 #471/#443): `verify_deadline_elapsed` means the ENGINE
   * stopped looking, and `target_gone` means there was nothing left to look
   * at. Neither is evidence the message was lost, and auto-filing them
   * produced issues #471 and #443 -- tracker noise describing cmuxlayer's own
   * timers, not a defect. The local evidence ticket is still written either
   * way, so the verdict keeps citing its evidence; only the escalation stops.
   */
  private deliveryFailureEscalationDecline(
    reason: string,
  ): string | null {
    if (reason === "verify_deadline_elapsed") {
      return (
        "background verify ran out of deadline before observing an outcome; " +
        "no evidence the message was lost"
      );
    }
    if (reason === "target_gone") {
      return (
        "the target agent disappeared before an outcome could be observed; " +
        "no evidence the message was lost"
      );
    }
    return null;
  }

  private async fileConfirmedFailureTicket(
    receipt: AgentDeliveryReceipt,
    reason: string,
    observation: DeliveryVerifyObservation,
  ): Promise<void> {
    if (receipt.ticket_filed) return;
    const ticketDir = this.deliveryTicketDir;
    if (!ticketDir) return;
    const agent = this.getAgentState(receipt.agent_id);
    const signature = deliveryFailureSignature({
      reason,
      cli: agent?.cli ?? null,
    });
    const ticket: DeliveryFailureTicket = {
      signature,
      delivery_id: receipt.delivery_id,
      agent_id: receipt.agent_id,
      reason,
      cli: agent?.cli ?? null,
      what_happened: `Delivery ${receipt.delivery_id} to ${receipt.agent_id} reached failed_confirmed (${reason}) after background verify.`,
      what_fixed_it:
        "Do not blind-retry. Identical send_to while pending_verify/queued/queued_followup returns duplicate_of. Query wait_for({delivery_id}) or list_agents detail=full.",
      evidence: {
        receipt,
        observation,
        target_state: agent?.state ?? null,
        surface_id: agent?.surface_id ?? null,
      },
      observed_at: new Date().toISOString(),
    };
    const written = writeDeliveryFailureTicket(ticket, {
      dir: ticketDir,
    });
    receipt.ticket_filed = true;

    // AIDEV-NOTE (T2 B2): both fields are written from the SAME resolved
    // outcome, at every exit, and never before the escalation is known.
    // Stamping `escalated: true` up front and then returning early -- deduped
    // signature, no filer configured, filer threw -- left receipts asserting
    // an escalation that never happened. That is this lane's own disease: a
    // receipt reporting something the engine did not observe.
    const settleEscalation = (declined: string | null): void => {
      receipt.ticket_escalated = declined === null;
      receipt.ticket_escalation_declined_reason = declined;
      this.persistDeliveryReceipts();
    };

    const declineReason = this.deliveryFailureEscalationDecline(reason);
    if (declineReason !== null) return settleEscalation(declineReason);
    if (!written.created) {
      return settleEscalation(
        "an issue for this failure signature was already filed; " +
          "this occurrence was appended to the existing ticket",
      );
    }
    if (!this.deliveryIssueFiler) {
      return settleEscalation("no issue filer is configured");
    }
    try {
      await this.deliveryIssueFiler(ticket);
      settleEscalation(null);
    } catch (error) {
      // Local ticket is authoritative; GitHub is best-effort -- but the
      // receipt must say the escalation did not land.
      settleEscalation(
        `issue filer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async drainDeliveryQueue(): Promise<void> {
    if (this.deliveryDrainInFlight || !this.deliverySubmitter) return;
    this.deliveryDrainInFlight = true;
    try {
      for (const receipt of this.deliveryReceipts.values()) {
        if (receipt.delivery_state !== "queued") continue;
        if (receipt.composer_accepted === true) continue;
        const agent = this.getAgentState(receipt.agent_id);
        if (!agent) {
          receipt.delivery_state = "failed";
          receipt.terminal = true;
          receipt.resolved_at = new Date().toISOString();
          receipt.error = `Delivery target ${receipt.agent_id} is gone or no longer exists`;
          this.persistDeliveryReceipts();
          this.appendDeliveryReceiptEventBestEffort(receipt);
          continue;
        }
        // AIDEV-NOTE (T2 N1): a paused target deliberately does NOT age out.
        // #467's bounded lifetime exists for a target that is failing to
        // become interactive on its own; pausing is a human's resumable act,
        // and expiring queued work under it would discard the message the
        // pause was protecting. The receipt stays nonterminal, and the
        // paused-target WARNING already tells the caller it is not delivered.
        if (agent.paused === true) {
          continue;
        }
        // AIDEV-NOTE (T2 #467): a retryable refusal is nonterminal, but it is
        // not unbounded. Without this, a target stuck `booting` retried behind
        // a 30s-capped backoff forever and the caller's receipt never resolved
        // -- a lead could wait on it indefinitely. The lifetime is stamped on
        // the first retryable requeue below; when it elapses the caller gets a
        // terminal answer that cites the gate reason that kept refusing.
        if (
          receipt.queue_deadline_at &&
          Date.now() >= Date.parse(receipt.queue_deadline_at)
        ) {
          const gateReason = receipt.error ?? "no gate reason recorded";
          receipt.delivery_state = "failed_confirmed";
          receipt.terminal = true;
          receipt.submit_verified = false;
          receipt.resolved_at = new Date().toISOString();
          receipt.next_attempt_at = null;
          receipt.error = `queue_deadline_elapsed after ${receipt.retry_count} retryable refusals; last gate reason: ${gateReason}`;
          this.persistDeliveryReceipts();
          this.appendDeliveryReceiptEventBestEffort(receipt);
          continue;
        }
        if (
          receipt.next_attempt_at &&
          Date.parse(receipt.next_attempt_at) > Date.now()
        ) {
          continue;
        }
        try {
          receipt.submission_started_at = new Date().toISOString();
          // This is the no-replay boundary. A crash after this write leaves an
          // uncertain terminal receipt instead of re-sending terminal input.
          this.persistDeliveryReceipts();
          let timeout: ReturnType<typeof setTimeout> | null = null;
          const result = await Promise.race([
            this.deliverySubmitter(receipt),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Delivery submission timed out after ${this.deliverySubmitTimeoutMs}ms; outcome uncertain and will not be retried`,
                    ),
                  ),
                this.deliverySubmitTimeoutMs,
              );
            }),
          ]).finally(() => {
            if (timeout) clearTimeout(timeout);
          });
          receipt.retry_count += result.retry_count;
          receipt.error = null;
          receipt.next_attempt_at = null;
          if (
            result.delivery === "queued" ||
            result.delivery === "queued_followup"
          ) {
            receipt.delivery_state = result.delivery;
            receipt.terminal = false;
            receipt.resolved_at = null;
            receipt.submit_verified = null;
            receipt.composer_accepted = true;
            if (result.delivery === "queued") {
              receipt.verify_deadline_at ??= new Date(
                Date.now() + this.deliveryVerifyDeadlineMs,
              ).toISOString();
            } else {
              receipt.verify_deadline_at = null;
            }
          } else if (result.delivery === "pending_verify") {
            receipt.delivery_state = "pending_verify";
            receipt.terminal = false;
            receipt.resolved_at = null;
            receipt.submit_verified = null;
            receipt.verify_deadline_at ??= new Date(
              Date.now() + this.deliveryVerifyDeadlineMs,
            ).toISOString();
          } else {
            receipt.delivery_state = "submitted";
            receipt.terminal = true;
            receipt.resolved_at = new Date().toISOString();
            receipt.submit_verified = result.submit_verified;
          }
        } catch (error) {
          if (error instanceof RetryableDeliveryError) {
            receipt.submission_started_at = null;
            receipt.retry_count += 1;
            receipt.queue_deadline_at ??= new Date(
              Date.now() + this.deliveryQueueDeadlineMs,
            ).toISOString();
            const backoffMs = Math.min(
              30_000,
              250 * 2 ** Math.min(receipt.retry_count - 1, 16),
            );
            receipt.next_attempt_at = new Date(
              Date.now() + backoffMs,
            ).toISOString();
            receipt.error = error.message;
          } else {
            receipt.delivery_state = "failed";
            receipt.terminal = true;
            receipt.resolved_at = new Date().toISOString();
            receipt.error =
              error instanceof Error ? error.message : String(error);
          }
        }
        this.persistDeliveryReceipts();
        // Successful delivery already emitted the correlated source event;
        // failures have no such event and need an explicit terminal transition.
        if (receipt.delivery_state === "failed") {
          this.appendDeliveryReceiptEventBestEffort(receipt);
        }
      }
    } finally {
      this.deliveryDrainInFlight = false;
    }
  }

  private appendDeliveryReceiptEvent(receipt: AgentDeliveryReceipt): void {
    const agent = this.getAgentState(receipt.agent_id);
    this.stateMgr.getEventLog().appendDelivery({
      ts: receipt.resolved_at ?? receipt.created_at,
      event_type: receipt.source_event,
      source_agent: null,
      target_surface: agent?.surface_id ?? "unknown",
      target_agent: receipt.agent_id,
      bytes: Buffer.byteLength(receipt.text),
      press_enter: receipt.press_enter,
      submit_verified: receipt.submit_verified,
      retry_count: receipt.retry_count,
      delivery_id: receipt.delivery_id,
      delivery_state: receipt.delivery_state,
    });
  }

  private appendDeliveryReceiptEventBestEffort(
    receipt: AgentDeliveryReceipt,
  ): void {
    try {
      this.appendDeliveryReceiptEvent(receipt);
    } catch {
      // Receipt persistence is authoritative; telemetry must not invalidate
      // acceptance or tempt a caller to duplicate terminal input.
    }
  }

  requestFleetSidebarRepublish(): void {
    if (this.fleetSidebarWakeRepublishTimer !== null) return;
    const timer = setTimeout(() => {
      void (this.startupInitializePromise ?? Promise.resolve())
        .then(() => {
          if (this.fleetSidebarWakeRepublishTimer !== timer) return;
          return this.runLifecycleMutation(() => this.syncSidebar());
        })
        .catch((error) => {
          console.error(
            "[cmuxlayer] wake sidebar republish failed (will retry on sweep):",
            error,
          );
        })
        .finally(() => {
          if (this.fleetSidebarWakeRepublishTimer === timer) {
            this.fleetSidebarWakeRepublishTimer = null;
          }
        });
    }, FLEET_SIDEBAR_WAKE_REPUBLISH_DELAY_MS);
    this.fleetSidebarWakeRepublishTimer = timer;
    timer.unref?.();
  }

  private async runSweepOnce(): Promise<void> {
    this.currentSweepScreenSignatures = new Map();
    await this.runCloseForensicsBestEffort();
    // Reuse the resync path's authoritative-safe ghost eviction on every sweep,
    // but require one confirmation window after the surface is first observed
    // absent. The same gate also applies to terminal worker cleanup below.
    // This absorbs cmux's short post-create topology lag without retaining old
    // ghosts indefinitely. Empty or failed enumeration remains inconclusive.
    const surfacelessConfirmation = {
      confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
      now: Date.now(),
    };
    await this.registry.reconcile(surfacelessConfirmation);
    await this.reapChannelMarkersBestEffort();
    await this.registry.evictSurfaceless(surfacelessConfirmation);
    await this.recoverPendingCliExits();
    await this.recoverCrashedAgents();

    await this.purgeStartupTerminalAgents();

    // Deferred transcript identity does not require a live surface binding.
    // Retry after the one-shot startup purge has retained marked rows, but
    // before normal terminal cleanup can act on a closed pane.
    await this.retryDeferredTranscriptCaptures();
    await this.sweepWatchesBestEffort();
    await this.registry.purgeTerminal(surfacelessConfirmation);
    await this.sweepMonitorRegistryBestEffort();
    await this.reconcileRolePlacements("idle");
    await this.syncSidebar();
    await this.drainOutboxBestEffort();
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
  private async runCloseForensicsBestEffort(): Promise<void> {
    if (!this.closeForensicsRunner) return;
    if (this.closeForensicsSweepInFlight) return;
    this.closeForensicsSweepInFlight = true;
    try {
      const result = await this.closeForensicsRunner();
      this.markIntentionalSurfaceCloses(result.events);
    } catch {
      // Never break the sweep on a forensics failure; it retries next sweep.
    } finally {
      this.closeForensicsSweepInFlight = false;
    }
  }

  private markIntentionalSurfaceCloses(events: CloseForensicsEvent[]): void {
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

  private watchAgentObservation = async (
    agentId: string,
  ): Promise<WatchAgentObservation> => {
    const agent = this.registry.get(agentId);
    const source = `screen:${agent?.surface_uuid ?? agent?.surface_id ?? agentId}`;
    if (!agent) return { exists: false, state: null, source };
    try {
      const screen = await this.client.readScreen(agent.surface_id, {
        ...(agent.workspace_id ? { workspace: agent.workspace_id } : {}),
        lines: 30,
      });
      const parsed = parseScreen(cleanScreenText(screen.text));
      return {
        exists:
          parsed.agent_type !== "unknown" &&
          parsed.control_state !== "dead" &&
          parsed.control_state !== "stale_surface",
        state: parsed.status === "frozen" ? "error" : parsed.status,
        source,
      };
    } catch {
      return { exists: false, state: null, source };
    }
  };

  private async sweepWatchesBestEffort(): Promise<void> {
    if (!this.watchRegistryPath || this.watchSweepInFlight) return;
    this.watchSweepInFlight = true;
    try {
      await sweepWatches({
        registryPath: this.watchRegistryPath,
        now: this.watchRegistryNow,
        agentObservation: this.watchAgentObservation,
        notify: this.watchNotify,
      });
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
    if (this.fleetSidebarWakeRepublishTimer) {
      clearTimeout(this.fleetSidebarWakeRepublishTimer);
      this.fleetSidebarWakeRepublishTimer = null;
    }
    for (const timer of this.postSpawnLivenessTimers) {
      clearTimeout(timer);
    }
    this.postSpawnLivenessTimers.clear();
    this.sweepTiming = null;
    this.lastSweepSignature = null;
    this.unchangedSweepCount = 0;
    this.fleetSidebarPublisher.dispose();
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
    const launchWarnings = [
      ...modelPolicy.warnings,
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
      parentAgent,
      repo: spawnParams.repo,
      worktree: isWorktreeLaunch(spawnParams),
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
      // A tab created in an unfocused pane does not initialize its terminal.
      // Focus the exact returned surface before any shell/readiness I/O.
      await this.client.focusSurface(surface.surface, {
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
      repo: spawnParams.repo,
      model: spawnParams.model ?? modelPolicy.effective_model,
      effort: spawnParams.cli === "codex" ? (effort ?? "high") : null,
      cli: spawnParams.cli,
      cli_session_id: null,
      cli_session_path: null,
      launcher_name: preflight?.launcherName ?? null,
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
      spawn_depth: spawnDepth,
      role,
      authority:
        spawnParams.authority ?? (role === "orchestrator" ? "lead" : "worker"),
      function: spawnParams.function ?? "implementor",
      placement:
        spawnParams.placement ?? (role === "orchestrator" ? "left" : "right"),
      auto_archive_on_done: spawnParams.auto_archive_on_done,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: spawnParams.max_cost_per_agent ?? null,
      crash_recover:
        spawnParams.crash_recover ?? defaultCrashRecoverForRole(role),
      respawn_attempts: 0,
      user_killed: false,
      auto_revive: spawnParams.auto_revive ?? true,
      revive_attempts: 0,
      revive_last_attempt_at: null,
      revive_next_attempt_at: null,
      revive_completed_at: null,
      revive_last_outcome: null,
      revive_last_error: null,
      revive_observation_source: null,
      revive_observed_at_ms: null,
      revive_previous_state: null,
      revive_consecutive_observations: 0,
      revive_notification_sent_at: null,
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
      },
    );
    try {
      // Tab title stays `<repo><Cli>` in BOTH modes: agent-discovery parses
      // the repo and cli back out of it (agent-discovery.ts:43-62), so the
      // title is a discovery contract, not a claim about which binary ran.
      const launcherName =
        preflight?.launcherName ??
        launcherNameForCli(spawnParams.repo, spawnParams.cli);
      await this.client.renameTab(
        surface.surface,
        `${launcherName} [${surface.surface}]`,
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
    this.schedulePostSpawnLivenessAssertion(agentId);
    return {
      agent_id: agentId,
      parent_agent_id: parentAgentId,
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

  /** Resume a captured CLI session on a fresh surface while preserving its
   * stable public agent ID. This is the explicit counterpart to crash recovery. */
  async resumeAgent(
    agentId: string,
    opts?: { workspace?: string },
  ): Promise<SpawnAgentResult> {
    const agent =
      this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (!TERMINAL_STATES.has(agent.state)) {
      throw new Error(
        `Agent "${agent.agent_id}" is ${agent.state}; explicit resume requires a terminal agent`,
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

    // Retroactive check — already in target state with required evidence?
    const initialEvidence = await this.getTargetStateEvidenceSource(
      initial,
      targetState,
    );
    if (initialEvidence) {
      return {
        matched: true,
        state: initial.state,
        elapsed: Date.now() - start,
        source: initialEvidence === "state" ? "immediate" : initialEvidence,
        agent: toPublicAgent(initial),
      };
    }

    // Already in terminal error state and target isn't error?
    if (initial.state === "error" && targetState !== "error") {
      return {
        matched: false,
        state: initial.state,
        elapsed: Date.now() - start,
        source: "immediate",
        agent: toPublicAgent(initial),
        error: initial.error ?? "Agent is in error state",
      };
    }

    // Already in terminal done state and target isn't done?
    if (initial.state === "done" && targetState !== "done") {
      return {
        matched: false,
        state: initial.state,
        elapsed: Date.now() - start,
        source: "immediate",
        agent: toPublicAgent(initial),
        error: "Agent has already completed",
      };
    }

    const waitForReadyPatternMatches = new Map<string, number>();

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
          const current = this.registry.get(agentId);
          finish({
            matched: false,
            state: current?.state ?? "error",
            elapsed,
            source: "timeout",
            agent: current ? toPublicAgent(current) : null,
            error: `Timed out after ${timeoutMs}ms waiting for state "${targetState}"`,
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

        const refreshed = await this.refreshTargetStateEvidence(
          current,
          targetState,
          waitForReadyPatternMatches,
        );
        current = refreshed.agent;

        const evidenceSource = await this.getTargetStateEvidenceSource(
          current,
          targetState,
        );
        if (evidenceSource) {
          clearInterval(checkInterval);
          finish({
            matched: true,
            state: current.state,
            elapsed,
            source:
              refreshed.source ??
              (evidenceSource === "state" ? "sweep" : evidenceSource),
            agent: toPublicAgent(current),
          });
          return;
        }

        // Fail-fast on terminal error
        if (
          TERMINAL_STATES.has(current.state) &&
          current.state !== targetState
        ) {
          clearInterval(checkInterval);
          finish({
            matched: false,
            state: current.state,
            elapsed,
            source: "sweep",
            agent: toPublicAgent(current),
            error:
              current.error ?? `Agent entered terminal state: ${current.state}`,
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
    const armed = await this.armWatch(spec);
    while (true) {
      await sweepWatches({
        registryPath: this.watchRegistryPath,
        now: this.watchRegistryNow,
        agentObservation: this.watchAgentObservation,
        notify: this.watchNotify,
      });
      const current = readWatchRegistry({
        registryPath: this.watchRegistryPath,
      }).watches.find((watch) => watch.watch_id === armed.watch_id);
      if (!current) {
        throw new Error(`Watch disappeared during wait: ${armed.watch_id}`);
      }
      const elapsed = Date.now() - startedAt;
      if (current.state === "fired") {
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

  markAgentWorking(agentId: string): AgentRecord | null {
    const current =
      this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
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
   * exactly once in a complete current topology before any read or mutation.
   * UUID-less legacy records retain compatibility only when an owned ref is
   * proven by a complete fresh topology with no UUID identity coverage.
   */
  async resolveAgentIoRoute(agentId: string): Promise<AgentRoute> {
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

      const topology = await this.collectObservedSurfaceTopology();
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

    const topology = await this.collectObservedSurfaceTopology();
    const binding = resolveAgentSurfaceBinding(agent, topology);
    if (!binding || binding.provenance !== "uuid") {
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

  private processLiveness(pid: number | null | undefined): ProcessLiveness {
    if (!pid) return "gone";
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ESRCH"
      ) {
        return "gone";
      }
      return "unknown";
    }
  }

  private isProcessMissingError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    );
  }

  private isProcessGone(pid: number | null | undefined): boolean {
    const liveness = this.processLiveness(pid);
    return liveness === "gone" || liveness === "unknown";
  }

  private isProcessConfirmedGone(pid: number | null | undefined): boolean {
    return this.processLiveness(pid) === "gone";
  }

  private isTerminalDeadRegistryGhost(agent: AgentRecord): boolean {
    if (!TERMINAL_STATES.has(agent.state)) {
      return false;
    }

    return (
      agent.user_killed === true ||
      (agent.respawn_attempts ?? 0) >= MAX_RESPAWN_ATTEMPTS ||
      isCrashRecoveryExhausted(agent.error)
    );
  }

  evictDeadProcessAgents(): string[] {
    const evicted: string[] = [];

    for (const agent of this.registry.list()) {
      const processGone =
        agent.pid !== null &&
        agent.pid !== undefined &&
        this.processLiveness(agent.pid) === "gone";
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
      if (!this.registry.canControlSurface(agent)) return false;
      const topology = await this.collectObservedSurfaceTopology();
      if (
        topology?.complete !== true ||
        topology.workspaceBySurface.size === 0 ||
        !this.registry.canControlSurface(agent)
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
      ? this.isProcessGone(agent.pid)
      : this.isProcessConfirmedGone(agent.pid);
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
    },
  ): Promise<void> {
    let agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const canonicalAgentId = agent.agent_id;

    const userInitiated = opts?.userInitiated ?? true;

    if (TERMINAL_STATES.has(agent.state)) {
      if (force) {
        this.registry.evictExplicit(canonicalAgentId);
        return;
      }
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

    let route = await this.resolveAgentIoRoute(canonicalAgentId);
    agent = this.registry.get(canonicalAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    let stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
      route.surface_id,
      route.workspace_id,
    );
    let finalRoute = await this.resolveAgentIoRoute(canonicalAgentId);
    if (!this.sameSurfaceRoute(route, finalRoute)) {
      stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
        finalRoute.surface_id,
        finalRoute.workspace_id,
      );
      const confirmedRoute = await this.resolveAgentIoRoute(canonicalAgentId);
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
    const mutationRoute = await this.resolveAgentIoRoute(canonicalAgentId);
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
      const closeRoute = await this.resolveAgentIoRoute(canonicalAgentId);
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
    if (force && agent.pid) {
      try {
        process.kill(agent.pid, "SIGKILL");
        forceSignalAccepted = true;
      } catch (error) {
        forceSignalAccepted = this.isProcessMissingError(error);
        if (!forceSignalAccepted) rollbackUnacceptedStopIntent();
        // Process may already be dead; other failures must preserve tracking.
      }
    } else {
      // Graceful: send Ctrl+C
      const assertSignalRouteCurrent = async (): Promise<void> => {
        await this.resolveUnchangedAgentIoRoute(
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
      closeRoute = await this.resolveAgentIoRoute(canonicalAgentId);
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
        await this.resolveAgentIoRoute(canonicalAgentId);
      if (!this.sameSurfaceRoute(closeRoute, confirmedCloseRoute)) {
        closeRoute = confirmedCloseRoute;
        stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
          closeRoute.surface_id,
          closeRoute.workspace_id,
        );
        confirmedCloseRoute = await this.resolveAgentIoRoute(canonicalAgentId);
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
        await this.resolveUnchangedAgentIoRoute(
          canonicalAgentId,
          route,
          "surface close",
        );
      };

      try {
        await this.client.closeSurface(route.surface_id, {
          workspace: route.workspace_id ?? undefined,
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
      this.registry.evict(canonicalAgentId);
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

    if (!INTERACTIVE_STATES.has(agent.state)) {
      throw new Error(
        `Agent "${agentId}" is not in an interactive state (current: ${agent.state}). ` +
          `Must be in: ${[...INTERACTIVE_STATES].join(", ")}`,
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
