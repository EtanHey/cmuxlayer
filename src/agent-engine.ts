/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StateManager } from "./state-manager.js";
import { isSafeShellToken, sanitizeTerminalInput } from "./sanitize.js";
import {
  AGENT_ENV,
  buildResumeCommand,
  sanitizeRepoName,
  shellQuote,
} from "./agent-command.js";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
  type AgentFilter,
} from "./agent-registry.js";
import type { AgentDiscovery } from "./agent-discovery.js";
import { toPublicAgent } from "./agent-facade.js";
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
  ParsedScreenStatus,
} from "./types.js";
import {
  generateAgentId,
  isCrashRecoveryEligible,
  isCrashRecoveryExhausted,
  MAX_SPAWN_DEPTH,
  MAX_CHILDREN,
  MAX_RESPAWN_ATTEMPTS,
  type AgentRoute,
  type AgentRecord,
  type AgentRole,
  type AgentState,
  type CliType,
  type CloseForensicsEvent,
  type PublicAgent,
  type WaitResult,
} from "./agent-types.js";
import type { CloseForensicsSweepResult } from "./close-forensics.js";
import { cleanScreenText, parseScreen } from "./screen-parser.js";
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
  resolveLaunchModelFlag,
  resolveSpawnModelPolicy,
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
  resolveLauncherNameFromRegistry,
  type LauncherSuffix,
} from "./launcher-registry.js";
import { buildAgentHealthInput } from "./agent-health-input.js";
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
import type { InboxOpts } from "./inbox.js";
import {
  buildFleetSidebarSnapshot,
  DEFAULT_FLEET_WORKING_NO_PROGRESS_TIMEOUT_MS,
  type FleetSidebarCandidate,
  type FleetSidebarPublisherLike,
} from "./fleet-sidebar.js";

type ProcessLiveness = "alive" | "gone" | "unknown";

export interface SpawnAgentParams {
  repo: string;
  model?: string;
  cli: CliType;
  prompt: string;
  boot_prompt_pending?: boolean;
  workspace?: string;
  cwd?: string;
  mcp_env?: string;
  mcp_profile_label?: string;
  worktree_branch?: string;
  parent_agent_id?: string;
  role?: AgentRole;
  auto_archive_on_done?: boolean;
  max_cost_per_agent?: number;
  crash_recover?: boolean;
}

export interface SpawnAgentResult {
  agent_id: string;
  surface_id: string;
  workspace_id?: string;
  actual_workspace_id?: string;
  state: AgentState;
  model?: string;
  requested_model?: string;
  warnings?: string[];
  model_policy?: SpawnModelPolicy;
  cwd?: string;
  mcp_env?: string;
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
  warnings?: string[];
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
const STOP_POST_CONDITION_POLL_MS = 50;
const BOOT_SESSION_CAPTURE_LINES = 80;
const BOOT_PROMPT_PENDING_STALE_MS = 5 * 60_000;
const TASK_DONE_CONFIRMATION_MS = 5_000;
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

export { buildResumeCommand } from "./agent-command.js";

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

export function buildLaunchCommand(
  cli: CliType,
  repo: string,
  model?: string,
  // Resolved launcher function name from launchers.zsh. When provided
  // for a launcher CLI it overrides the naive `${repo}${Suffix}` guess so
  // registry-prefix registrations launch correctly. Honored for the launcher
  // CLIs (claude/codex/cursor/gemini); ignored for kiro (raw cd+exec).
  launcherName?: string,
  opts?: { cwd?: string; envPrefix?: string; allowModelOverride?: boolean },
): string {
  const safeRepo = sanitizeRepoName(repo);
  const modelFlag = resolveLaunchModelFlag(cli, model, {
    allowModelOverride: opts?.allowModelOverride,
  });
  const formattedModelFlag = modelFlag ? formatModelArg(modelFlag) : null;
  const launcherModelArgs = formattedModelFlag
    ? ` -m ${formattedModelFlag}`
    : "";
  const rawModelArgs = formattedModelFlag
    ? ` --model ${formattedModelFlag}`
    : "";
  const launcherWorktreeArg = opts?.cwd ? ` -w ${shellQuote(opts.cwd)}` : "";
  const rawCdPrefix = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ` : "";
  const envPrefix = opts?.envPrefix ? `${opts.envPrefix} ` : "";
  switch (cli) {
    case "claude":
      // repoGolem launcher handles env vars via ralph-registry
      return `${envPrefix}${launcherName ?? `${safeRepo}Claude`} -s${launcherModelArgs}${launcherWorktreeArg}`;
    case "codex":
      return `${envPrefix}${launcherName ?? `${safeRepo}Codex`} -s${launcherModelArgs}${launcherWorktreeArg}`;
    case "gemini":
      // repoGolem launcher (e.g. golemsGemini -s) wires antigravity + MCP.
      return `${envPrefix}${launcherName ?? `${safeRepo}Gemini`} -s${launcherModelArgs}${launcherWorktreeArg}`;
    case "kiro":
      return `${rawCdPrefix || `cd ~/Gits/${safeRepo} && `}${envPrefix}${AGENT_ENV} kiro-cli${rawModelArgs}`;
    case "cursor":
      // repoGolem launcher - requires registration via golem-powers.
      return `${envPrefix}${launcherName ?? `${safeRepo}Cursor`} -s${launcherModelArgs}${launcherWorktreeArg}`;
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
 * Validate that a launcher is registered and return its resolved name. Probes
 * the launcher registry instead of executing shell profile code.
 */
export async function assertLauncherAvailable(
  repo: string,
  suffix: LauncherSuffix,
): Promise<string> {
  const cli =
    suffix === "Claude"
      ? "claude"
      : suffix === "Codex"
        ? "codex"
        : suffix === "Cursor"
          ? "cursor"
          : "gemini";
  return resolveLauncherNameFromRegistry(repo, cli);
}

export class AgentEngine {
  private stateMgr: StateManager;
  private registry: AgentRegistry;
  private client: AgentEngineClient;
  private spawnPreflight: (
    params: SpawnAgentParams,
  ) => Promise<SpawnPreflightResult | void>;
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
  /** Best-effort outbox drainer invoked each sweep (injectable for tests). */
  private outboxDrain: () => Promise<unknown>;
  /** Guards against overlapping outbox drains if a sweep runs long. */
  private outboxDrainInFlight = false;
  private monitorRegistryPath?: string;
  private monitorRegistryNow?: () => number;
  private monitorRegistryNotify: MonitorDeadmanNotify;
  private monitorRegistrySweepInFlight = false;
  /** Best-effort close-forensics ingest; null when disabled. */
  private closeForensicsRunner:
    | (() => CloseForensicsSweepResult | Promise<CloseForensicsSweepResult>)
    | null;
  private closeForensicsSweepInFlight = false;
  private fleetSidebarPublisher: FleetSidebarPublisherLike;
  private fleetWorkingNoProgressTimeoutMs: number;
  private startupInitializePromise: Promise<void> | null = null;
  private lifecycleMutationTail: Promise<void> = Promise.resolve();
  constructor(
    stateMgr: StateManager,
    registry: AgentRegistry,
    client: AgentEngineClient,
    opts?: AgentEngineOptions,
  ) {
    this.stateMgr = stateMgr;
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
    this.spawnPreflight =
      opts?.spawnPreflight ??
      (async (params): Promise<SpawnPreflightResult | void> => {
        if (params.cli === "claude") {
          return {
            launcherName: await assertLauncherAvailable(params.repo, "Claude"),
          };
        }
        if (params.cli === "codex") {
          return {
            launcherName: await assertLauncherAvailable(params.repo, "Codex"),
          };
        }
        if (params.cli === "cursor") {
          return {
            launcherName: await assertLauncherAvailable(params.repo, "Cursor"),
          };
        }
        if (params.cli === "gemini") {
          return {
            launcherName: await assertLauncherAvailable(params.repo, "Gemini"),
          };
        }
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

  assessHarvestability(agent: AgentRecord): WorkerHarvestability {
    const issueCodes: string[] = [];
    const issues: string[] = [];
    const addIssue = (code: string, message: string): void => {
      if (!issueCodes.includes(code)) issueCodes.push(code);
      if (!issues.includes(message)) issues.push(message);
    };

    const role = agent.role ?? inferRecordRoleOrNull(agent);
    const neutralEvidenceChannel: HarvestabilityEvidenceChannel = {
      done_source: agent.task_done_detected_at ? "screen" : "none",
      degraded: false,
      reason: null,
    };
    if (agent.state !== "done" || role === "orchestrator" || role === "ic") {
      return {
        closeable: false,
        closure_artifact_verified: null,
        report_path: null,
        done_marker: null,
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
    const goal = this.readClosureGoalContract(agent.goal_file ?? null);
    const reportText = goal.reportPath
      ? this.readTextFile(goal.reportPath)
      : null;
    const reportExists = goal.reportPath ? reportText !== null : null;
    const reportFresh =
      goal.reportPath && reportText !== null
        ? this.reportIsFreshForGoalContract(
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

  private readClosureGoalContract(goalFile: string | null): {
    goalText: string | null;
    reportPath: string | null;
    doneMarker: string | null;
    goalReadFailed: boolean;
  } {
    if (!goalFile) {
      return {
        goalText: null,
        reportPath: null,
        doneMarker: null,
        goalReadFailed: false,
      };
    }
    const goalText = this.readTextFile(goalFile);
    if (goalText === null) {
      return {
        goalText: null,
        reportPath: null,
        doneMarker: null,
        goalReadFailed: true,
      };
    }
    return {
      goalText,
      reportPath: this.extractReportPath(goalText, goalFile),
      doneMarker: this.extractDoneMarker(goalText),
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
    return [agent.task_summary, goalText, reportText]
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
      if (
        !hasTargetEvidence ||
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
      if (targetState === "ready" && transitionAgent.boot_prompt_pending) {
        transitionAgent = this.stateMgr.updateRecord(transitionAgent.agent_id, {
          boot_prompt_pending: false,
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
        for (const role of ["orchestrator", "ic", "worker"] as const) {
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
      return {
        ...this.withWorkspacePlacementWarning(surface, workspace),
        observerEpoch,
        observerId,
      };
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
        ...this.withWorkspacePlacementWarning(surface, workspace),
        observerEpoch,
        observerId,
      };
    }
  }

  private withWorkspacePlacementWarning(
    surface: AgentSurfacePlacement,
    requestedWorkspace: string | undefined,
  ): AgentSurfacePlacement & {
    actual_workspace?: string;
    warnings?: string[];
  } {
    if (
      !requestedWorkspace ||
      !surface.workspace ||
      surface.workspace === requestedWorkspace
    ) {
      return surface;
    }
    const warning = `Spawn placement mismatch: requested ${requestedWorkspace} but cmux returned ${surface.workspace} for surface ${surface.surface}`;
    return {
      ...surface,
      workspace: requestedWorkspace,
      actual_workspace: surface.workspace,
      warnings: [warning],
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
    if (this.launchCommandSender) {
      await this.launchCommandSender({
        surface,
        ...this.stableSurfaceWriteOptions(expectedRoute.surface_uuid),
        workspace,
        command,
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
      this.selfRegistrationSessionResolver &&
      TRANSCRIPT_SESSION_CAPTURE_STATES.has(agent.state) &&
      JSONL_HARNESSES.has(agent.cli) &&
      agent.surface_uuid?.trim(),
    );
  }

  private canUseTranscriptSessionResolver(agent: AgentRecord): boolean {
    if (!TRANSCRIPT_SESSION_CAPTURE_STATES.has(agent.state)) return false;
    if (!JSONL_HARNESSES.has(agent.cli)) return false;
    const hasManagedLaunchContext = Boolean(
      agent.launcher_name ||
      agent.launch_cwd?.trim() ||
      agent.worktree_path?.trim(),
    );
    if (agent.task_summary.trim().length === 0 && !hasManagedLaunchContext) {
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
    const prompt = agent.task_summary.trim();
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
    const activeCodex =
      agent.cli === "codex" &&
      hasIdentity &&
      screenHasActiveAgentMarker(agent.cli, screenText, parsed);
    return {
      ready: hasIdentity && match.matched,
      activeCodex,
      consecutive: match.consecutive,
    };
  }

  private harnessCwdForAgent(agent: AgentRecord): string {
    const launchCwd = agent.launch_cwd?.trim();
    if (launchCwd) return launchCwd;
    const worktreePath = agent.worktree_path?.trim();
    if (worktreePath) return worktreePath;
    return join(homedir(), "Gits", agent.repo);
  }

  /**
   * Default session-identity resolution: self-registration READ (PRIMARY) then
   * the deprecated transcript scan (last-resort fallback). Self-registration is
   * the P0 root fix — agents append their real session id to the registry at
   * boot, so we read it instead of scanning `~/.claude`/`~/.codex` and inferring
   * by cwd+recency (which breaks with raw spawns + worktrees + many agents per
   * repo). The scan is only reached when self-registration returns null (unset in
   * bare construction, or a hook-less agent with no registry entry) and no
   * injected fallback override is present; #336's bounded deferred-capture marker
   * still guards that fallback.
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
    if (!this.canUseTranscriptSessionResolver(agent)) return null;
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
        expectedText: agent.task_summary,
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
    });
    this.registry.set(agent.agent_id, updated);

    const finalAgentId = generateAgentId(
      agent.cli,
      agent.repo,
      identity.session_id,
    );
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
        return updated;
      }
      const sessionPath =
        identity.path ?? existingFinal.cli_session_path ?? null;
      const canonicalFinal =
        existingFinal.cli_session_id === identity.session_id &&
        existingFinal.cli_session_path === sessionPath
          ? existingFinal
          : this.stateMgr.updateRecord(finalAgentId, {
              cli_session_id: identity.session_id,
              cli_session_path: sessionPath,
            });
      const index = this.stateMgr.getSurfaceSessionIndex();
      index.removeAgent(updated.agent_id);
      index.persistRecord(canonicalFinal);
      this.registry.rename(updated.agent_id, finalAgentId, canonicalFinal);
      this.transferAgentRenameMemory(updated.agent_id, finalAgentId);
      this.stateMgr.removeState(updated.agent_id);
      return canonicalFinal;
    }

    const previousAgentId = updated.agent_id;
    updated = this.stateMgr.renameState(previousAgentId, finalAgentId);
    this.registry.rename(previousAgentId, finalAgentId, updated);
    this.transferAgentRenameMemory(previousAgentId, finalAgentId);
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
      return agent;
    }

    const canUseSelfRegistration =
      this.canUseSelfRegistrationSessionResolver(agent);
    const canUseTranscript =
      opts.resolveTranscript !== false &&
      this.canUseTranscriptSessionResolver(agent);
    if (canUseSelfRegistration || canUseTranscript) {
      try {
        const resolvedSession =
          opts.resolveTranscript === false
            ? this.selfRegistrationSessionResolver?.(agent)
            : this.sessionIdentityResolver(agent);
        if (resolvedSession) {
          return this.finalizeCapturedSession(
            agent,
            this.normalizeCapturedSessionIdentity(resolvedSession),
          );
        }
      } catch {
        return agent;
      }
    }

    if (!this.isBootCaptureWindowOpen(agent)) {
      return agent;
    }

    try {
      const screen = await this.readSweepScreen(agent, ctx);
      const sessionId = extractSessionId(screen.text);
      if (!sessionId) {
        return agent;
      }

      return this.finalizeCapturedSession(agent, {
        session_id: sessionId,
        path: null,
      });
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

  private async maybeMarkBootReady(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<AgentRecord> {
    if (agent.state !== "booting") {
      this.readyPatternMatches.delete(agent.agent_id);
      return agent;
    }
    if (agent.boot_prompt_pending) {
      try {
        const screen = await this.readSweepScreen(agent, ctx);
        const evidence = this.readReadyEvidence(agent, screen.text);
        if (
          (evidence.ready || evidence.activeCodex) &&
          (evidence.activeCodex ||
            !this.screenShowsPendingBootPrompt(agent, screen.text))
        ) {
          const count = (this.readyPatternMatches.get(agent.agent_id) ?? 0) + 1;
          this.readyPatternMatches.set(agent.agent_id, count);
          if (count < Math.max(1, evidence.consecutive)) {
            return agent;
          }

          this.stateMgr.updateRecord(agent.agent_id, {
            boot_prompt_pending: false,
          });
          let ready = this.stateMgr.transition(agent.agent_id, "ready", {
            error: null,
          });
          if (
            ready.quality === "degraded" &&
            agent.error?.startsWith("Post-spawn liveness failed:")
          ) {
            ready = this.stateMgr.updateRecord(agent.agent_id, {
              quality: "unknown",
            });
          }
          this.registry.set(agent.agent_id, ready);
          this.readyPatternMatches.delete(agent.agent_id);
          return ready;
        }
        this.readyPatternMatches.delete(agent.agent_id);
      } catch {
        // Fall through to the explicit interrupted-delivery error below.
      }

      const since = Date.parse(agent.updated_at);
      if (
        !Number.isNaN(since) &&
        Date.now() - since < BOOT_PROMPT_PENDING_STALE_MS
      ) {
        return agent;
      }

      try {
        this.stateMgr.updateRecord(agent.agent_id, {
          boot_prompt_pending: false,
        });
        const surfaceAlive = await this.registry.isSurfaceAlive(agent);
        const reconciled = surfaceAlive
          ? this.stateMgr.transition(agent.agent_id, "ready", { error: null })
          : this.stateMgr.transition(agent.agent_id, "error", {
              error: "Boot prompt delivery interrupted before completion",
            });
        this.registry.set(agent.agent_id, reconciled);
        return reconciled;
      } catch {
        return agent;
      }
    }

    try {
      const screen = await this.readSweepScreen(agent, ctx);
      const evidence = this.readReadyEvidence(agent, screen.text);
      if (!evidence.ready && !evidence.activeCodex) {
        this.readyPatternMatches.delete(agent.agent_id);
        return agent;
      }

      const count = (this.readyPatternMatches.get(agent.agent_id) ?? 0) + 1;
      this.readyPatternMatches.set(agent.agent_id, count);
      if (count < Math.max(1, evidence.consecutive)) {
        return agent;
      }

      let updated = this.stateMgr.transition(agent.agent_id, "ready", {
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

        const resumeCmd = buildResumeCommand(
          agent.cli,
          agent.repo,
          agent.cli_session_id!,
          agent.launcher_name,
        );
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
    const text = [agent.error, agent.task_summary]
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
        continue;
      }
      if (!topologyIsAuthoritative) {
        // Empty, partial, mixed-identity, and contradictory observations are
        // preservation signals only. Never read a persisted ref or mutate
        // lifecycle/status state until one coherent topology can bind the row.
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
        continue;
      }

      const observedSurfaceUuid =
        surfaceTopology?.surfaceIdByRef.get(surfaceBinding.surfaceRef) ?? null;
      if (
        !this.registry.canUseObservedBinding(registryAgent, observedSurfaceUuid)
      ) {
        // A live ref without compatible provenance cannot publish, read, or
        // mutate this row. Preserve it for its owning observer.
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
      const agent = taskDoneResult.agent;
      const { agent_id: agentId, state } = agent;
      if (this.isKnownClosedSurface(agent, surfaceTopology)) {
        const prev = this.sidebarSnapshot.get(agentId);
        if (prev) {
          try {
            await this.client.clearStatus(agentId, {
              workspace: prev.workspaceId ?? undefined,
            });
          } catch {
            // Best-effort cleanup; closed panes must not emit fresh health signals.
          }
        }
        this.sidebarSnapshot.delete(agentId);
        this.clearAgentLifecycleMemory(agentId);
        continue;
      }
      const harvestability = this.assessHarvestability(agent);
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
        const prev = this.sidebarSnapshot.get(agentId);
        if (prev) {
          try {
            await this.client.clearStatus(agentId, {
              workspace: prev.workspaceId ?? undefined,
            });
          } catch {
            // Best-effort cleanup; the next coherent sweep republishes it.
          }
        }
        this.sidebarSnapshot.delete(agentId);
        this.clearAgentLifecycleMemory(agentId);
        continue;
      }
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

            if (agent.spawn_depth === 0) {
              // Root agent: send /compact
              const compactRoute = await this.resolveAgentIoRoute(agentId);
              await this.client.send(compactRoute.surface_id, "/compact", {
                workspace: compactRoute.workspace_id ?? undefined,
                ...this.stableSurfaceWriteOptions(compactRoute.surface_uuid),
              });
              const returnRoute = await this.resolveAgentIoRoute(agentId);
              await this.client.sendKey(returnRoute.surface_id, "return", {
                workspace: returnRoute.workspace_id ?? undefined,
                ...this.stableSurfaceWriteOptions(returnRoute.surface_uuid),
              });
            } else {
              await this.client.log(
                `context-limit: depth ${agent.spawn_depth} agent ${agent.repo} degraded; leaving pane running for orchestrator decision`,
                { level: "warning", source: "cmuxlayer" },
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
      if (canonicalRoleColumn(inferRecordRoleOrNull(agent) ?? "ic") === null) {
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
    this.enableStartupPurge({ retainAgentIds: newlySurfacelessAgentIds });
    const discovered = await discovery.scan(true);
    await this.registry.listMerged(discovery, {
      force: true,
      discovered,
      nonDestructive: true,
    });
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
    const purgedIds = this.registry.purgeAllTerminal({
      retainAgentIds: this.startupPurgeRetainedAgentIds,
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
    await this.registry.evictSurfaceless(surfacelessConfirmation);
    await this.recoverCrashedAgents();

    await this.purgeStartupTerminalAgents();

    await this.registry.purgeTerminal(surfacelessConfirmation);
    await this.sweepMonitorRegistryBestEffort();
    await this.reconcileRolePlacements("idle");
    await this.syncSidebar();
    await this.drainOutboxBestEffort();
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
    const spawnParams: SpawnAgentParams = {
      ...params,
      model: modelPolicy.effective_model,
    };
    const agentId = generateAgentId(spawnParams.cli, spawnParams.repo);

    // Resolve parent hierarchy
    let spawnDepth = 0;
    let parentAgentId: string | null = null;
    let parentAgent: AgentRecord | null = null;
    const role = inferAgentRole({
      role: spawnParams.role,
      cli: spawnParams.cli,
      launcherName: launcherNameForCli(spawnParams.repo, spawnParams.cli),
    });

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

    this.spawnGuard.check(spawnParams.workspace);

    const preflight = await this.spawnPreflight(spawnParams);
    const seatIdentity = assertSeatIdentity({
      repo: spawnParams.repo,
      cli: spawnParams.cli,
      launcherName: preflight?.launcherName ?? null,
      registry: this.seatRegistry,
    });

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
      cli: spawnParams.cli,
      cli_session_id: null,
      cli_session_path: null,
      launcher_name: preflight?.launcherName ?? null,
      seat_id: seatIdentity.seat_id,
      seat_lane: seatIdentity.seat_lane,
      seat_role: seatIdentity.seat_role,
      seat_identity_status: seatIdentity.seat_identity_status,
      seat_identity_error: seatIdentity.seat_identity_error,
      task_summary: spawnParams.prompt,
      pid: null,
      version: 1,
      created_at: now,
      updated_at: now,
      error: null,
      parent_agent_id: parentAgentId,
      spawn_depth: spawnDepth,
      role,
      auto_archive_on_done: spawnParams.auto_archive_on_done,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: spawnParams.max_cost_per_agent ?? null,
      crash_recover:
        spawnParams.crash_recover ?? defaultCrashRecoverForRole(role),
      respawn_attempts: 0,
      user_killed: false,
      boot_prompt_pending: spawnParams.boot_prompt_pending ?? false,
      launch_cwd: spawnParams.cwd ?? null,
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
        cwd: spawnParams.cwd,
        envPrefix: spawnParams.mcp_env,
        allowModelOverride: modelPolicy.override_allowed,
      },
    );
    try {
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
      throw error;
    }
    this.schedulePostSpawnLivenessAssertion(agentId);
    const seatWarnings =
      seatIdentity.seat_identity_status === "mismatch" &&
      seatIdentity.seat_identity_error
        ? [`Seat identity mismatch: ${seatIdentity.seat_identity_error}`]
        : [];

    return {
      agent_id: agentId,
      surface_id: surface.surface,
      workspace_id: surface.workspace,
      actual_workspace_id: surface.actual_workspace,
      state: "booting",
      model: modelPolicy.effective_model,
      requested_model: modelPolicy.requested_model,
      warnings: [
        ...modelPolicy.warnings,
        ...(surface.warnings ?? []),
        ...seatWarnings,
      ],
      model_policy: modelPolicy,
      cwd: spawnParams.cwd,
      mcp_env: spawnParams.mcp_env,
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

  /** Reserve an idle agent from placement before releasing its surface lock. */
  markAgentWorking(agentId: string): AgentRecord | null {
    const current =
      this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
    if (!current || current.state !== "idle") {
      return current;
    }
    const working = this.stateMgr.transition(agentId, "working");
    this.registry.set(agentId, working);
    return working;
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
    return this.listAgents(filter).map(toPublicAgent);
  }

  resolveAgentRoute(agentId: string): AgentRoute {
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const resumeCommand = agent.cli_session_id
      ? buildResumeCommand(
          agent.cli,
          agent.repo,
          agent.cli_session_id,
          agent.launcher_name,
        )
      : undefined;
    return {
      agent_id: agent.agent_id,
      surface_id: agent.surface_id,
      surface_uuid: agent.surface_uuid ?? null,
      workspace_id: agent.workspace_id ?? null,
      state: agent.state,
      session_id: agent.cli_session_id,
      resumable: !!agent.cli_session_id,
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

    let forceSignalAccepted = force === true && !agent.pid;
    if (force && agent.pid) {
      try {
        process.kill(agent.pid, "SIGKILL");
        forceSignalAccepted = true;
      } catch (error) {
        forceSignalAccepted = this.isProcessMissingError(error);
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
      await this.client.sendKey(route.surface_id, "c-c", {
        workspace: route.workspace_id ?? undefined,
        ...this.stableSurfaceWriteOptions(route.surface_uuid),
        beforeMutation: assertSignalRouteCurrent,
      });
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
