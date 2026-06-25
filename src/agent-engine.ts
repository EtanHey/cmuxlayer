/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StateManager } from "./state-manager.js";
import { isSafeShellToken, sanitizeTerminalInput } from "./sanitize.js";
import {
  AGENT_ENV,
  buildResumeCommand,
  sanitizeRepoName,
  shellQuote,
} from "./agent-command.js";
import { AgentRegistry, type AgentFilter } from "./agent-registry.js";
import { toPublicAgent } from "./agent-facade.js";
import type {
  CmuxPane,
  CmuxPaneSurfaces,
  CmuxNewSplitResult,
  CmuxNewSurfaceResult,
  CmuxReadScreenResult,
  CmuxSendOptions,
  CmuxWorkspace,
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
  type PublicAgent,
  type WaitResult,
} from "./agent-types.js";
import { parseScreen } from "./screen-parser.js";
import {
  chooseAgentSpawnPlacement,
  chooseSurfaceClosePolicy,
  collectRoleSurfaceIds,
  inferAgentRole,
  inferRecordRole,
  inferRecordRoleOrNull,
  isAgentRoleInferenceError,
  launcherNameForCli,
  type RoleSurfaceIds,
} from "./layout-policy.js";
import {
  matchReadyPattern,
  readyPatternRequiresAgentIdentity,
  screenHasReadyAgentIdentity,
} from "./pattern-registry.js";
import {
  reposEquivalent,
  resolveWorkspaceRefForRepo,
} from "./repo-workspace.js";
import { SpawnGuard } from "./spawn-guard.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
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
  state: AgentState;
  model?: string;
  requested_model?: string;
  warnings?: string[];
  model_policy?: SpawnModelPolicy;
  cwd?: string;
  mcp_env?: string;
}

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
 * name resolved by the candidate probe (see resolveLauncherName) so spawnAgent
 * launches the form that actually registered, even when hyphens were stripped.
 */
export interface SpawnPreflightResult {
  launcherName?: string;
}

export interface AgentEngineOptions {
  spawnPreflight?: (
    params: SpawnAgentParams,
  ) => Promise<SpawnPreflightResult | void>;
  spawnGuard?: SpawnGuard;
  postSpawnLivenessMs?: number;
  stopPostConditionTimeoutMs?: number;
  sessionIdentityResolver?: SessionIdentityResolver;
  roleSurfaceIdsProvider?: (
    liveSurfaceIds?: ReadonlySet<string>,
    workspace?: string,
  ) => RoleSurfaceIds;
  launchCommandSender?: (input: {
    surface: string;
    workspace?: string;
    command: string;
  }) => Promise<void>;
}

export type AgentLifecycleEvent = "spawned" | "done" | "errored";

const INTERACTIVE_STATES = new Set<AgentState>(["ready", "idle"]);
const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);
const WAIT_FOR_SWEEP_INTERVAL_MS = 1000;
const DEFAULT_SWEEP_ACTIVE_INTERVAL_MS = 5_000;
const DEFAULT_SWEEP_IDLE_INTERVAL_MS = 15_000;
const DEFAULT_SWEEP_IDLE_AFTER_SWEEPS = 3;
const BOOT_SESSION_CAPTURE_WINDOW_MS = 30_000;
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

export { buildResumeCommand } from "./agent-command.js";

interface SidebarStatusSnapshot {
  statusValue: string;
  surfaceId: string | null;
  workspaceId: string | null;
}

export interface SweepTimingOptions {
  activeIntervalMs: number;
  idleIntervalMs: number;
  idleAfterSweeps: number;
}

type SweepTimingInput = number | Partial<SweepTimingOptions>;

interface SweepAgentContext {
  screen?: Promise<CmuxReadScreenResult>;
}

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

// AIDEV-NOTE: Cursor has no distinct "done" lifecycle state — it settles to
// "idle" when a task completes. A wait_for(target="done") on a Cursor agent
// would otherwise hang the full timeout (R-038(cmuxlayer-code: cursor-idle short-circuit): "300s hang on a done Cursor").
// AIDEV-NOTE: This is distinct from weave-registry R-038 (wait_for(done) transcript ground-truth) and weave-registry R-039 (delta-wave coverage).
// Treat a Cursor that has reached idle as satisfying a done wait. Narrowly
// scoped to cli==="cursor" so Claude/Codex idle (awaiting input ≠ done) is
// unaffected.
function isCursorTerminalIdleTarget(
  agent: AgentRecord,
  targetState: AgentState,
): boolean {
  return (
    targetState === "done" && agent.cli === "cursor" && agent.state === "idle"
  );
}

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
  readScreen(
    surface: string,
    opts?: { workspace?: string; lines?: number; scrollback?: boolean },
  ): Promise<CmuxReadScreenResult>;
  send(surface: string, text: string, opts?: CmuxSendOptions): Promise<void>;
  sendKey(
    surface: string,
    key: string,
    opts?: { workspace?: string },
  ): Promise<void>;
  clearStatus(key: string, opts?: { workspace?: string }): Promise<void>;
  setProgress(
    value: number,
    opts?: { label?: string; workspace?: string; surface?: string },
  ): Promise<void>;
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
    },
  ): Promise<CmuxNewSplitResult>;
  newSurface(opts: {
    pane: string;
    type?: "terminal" | "browser";
    workspace?: string;
    title?: string;
    url?: string;
  }): Promise<CmuxNewSurfaceResult>;
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
    opts?: { workspace?: string; collapsePane?: boolean },
  ): Promise<void>;
  notifyLifecycleEvent(
    event: AgentLifecycleEvent,
    agent: AgentRecord,
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
  // Resolved launcher function name (from resolveLauncherName). When provided
  // for a launcher CLI it overrides the naive `${repo}${Suffix}` guess so
  // hyphen-stripped registrations launch correctly. Honored for the launcher
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

export type LauncherSuffix = "Claude" | "Codex" | "Cursor" | "Gemini";

const REPO_LAUNCHER_ALIASES: Record<string, string[]> = {
  // The orchestrator checkout lives at ~/Gits/orchestrator, but the
  // repoGolem registry key is `orc`, so the launchers are orcClaude/Codex/Cursor.
  orchestrator: ["orc"],
};

/**
 * Ordered, de-duplicated launcher-name candidates for a repo + suffix.
 *
 * The repoGolem registry emits launcher function names INCONSISTENTLY per repo
 * (see ~/.config/ralphtools/golem-dispatch.zsh `_golem_register_wrappers`):
 *   - the primary wrapper uses the lowercased, hyphen-stripped registry key
 *     (`${(L)name}` -> `agenthtmlhostCursor`), and
 *   - the P10 "hyphen-aware verbatim alias" is emitted ONLY for some repos
 *     (`agent-html-hostCursor` exists for `maakaf-home`/`skill-creator` but
 *     NOT for `agent-html-host`).
 *
 * AIDEV-NOTE: R-039(cmuxlayer-code: launcher-name resolution) is distinct from weave-registry R-038 (wait_for(done) transcript ground-truth) and weave-registry R-039 (delta-wave coverage).
 *
 * cmuxlayer cannot know which form a given repo registered, so we generate
 * both and probe in order. Candidate #1 preserves today's behavior (verbatim
 * dir name); candidate #2 matches the registry's primary wrapper.
 */
export function launcherNameCandidates(
  repo: string,
  suffix: LauncherSuffix,
): string[] {
  const safeRepo = sanitizeRepoName(repo);
  const prefixes = [
    safeRepo,
    safeRepo.replace(/-/g, "").toLowerCase(),
    ...(REPO_LAUNCHER_ALIASES[safeRepo] ?? []),
  ];
  return [...new Set(prefixes)].map((prefix) => `${prefix}${suffix}`);
}

/** Returns true when a launcher function/command resolves in the login shell. */
export type LauncherProbe = (launcher: string) => Promise<boolean>;

const shellLauncherProbe: LauncherProbe = async (launcher) => {
  const shell = process.env.SHELL || "/bin/zsh";
  const probe = `type ${launcher} >/dev/null 2>&1 || command -v ${launcher} >/dev/null 2>&1`;
  try {
    await runDetachedShellProbe(shell, probe);
    return true;
  } catch {
    return false;
  }
};

function runDetachedShellProbe(shell: string, probe: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-ilc", probe], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let postTermTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      postTermTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finishReject(
          new Error("launcher probe failed to terminate after SIGTERM"),
        );
      }, 1_000);
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timer);
      if (postTermTimer) clearTimeout(postTermTimer);
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    child.once("error", (error) => {
      finishReject(error);
    });
    child.once("exit", (code, signal) => {
      if (timedOut) {
        finishReject(new Error("launcher probe timed out"));
        return;
      }
      if (code === 0) {
        finishResolve();
        return;
      }
      finishReject(
        new Error(
          `launcher probe exited with ${code ?? `signal ${signal ?? "unknown"}`}`,
        ),
      );
    });
  });
}

/**
 * Resolve the actual launcher function name by probing candidate forms in
 * order. Returns the first candidate that resolves in the login shell; throws a
 * clear registration error (listing every form tried) when none resolve. The
 * probe is injectable for deterministic tests.
 */
export async function resolveLauncherName(
  repo: string,
  suffix: LauncherSuffix,
  probe: LauncherProbe = shellLauncherProbe,
): Promise<string> {
  const candidates = launcherNameCandidates(repo, suffix);
  for (const candidate of candidates) {
    if (await probe(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Launcher not found for repo "${repo}". Tried: ${candidates.join(", ")}. ` +
      `The repoGolem registry may strip hyphens (e.g. "agent-html-host" -> ` +
      `"agenthtmlhostCursor"). Register the launcher in golem-powers or use ` +
      `cli="kiro" which uses a direct cd+exec path.`,
  );
}

/**
 * Validate that a launcher is registered and return its resolved name. Probes
 * candidate forms so multi-hyphen repos that registered a stripped name resolve
 * instead of failing on the naive verbatim guess.
 */
export async function assertLauncherAvailable(
  repo: string,
  suffix: LauncherSuffix,
): Promise<string> {
  return resolveLauncherName(repo, suffix);
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
  ) => RoleSurfaceIds;
  private launchCommandSender?: AgentEngineOptions["launchCommandSender"];
  private sessionIdentityResolver: SessionIdentityResolver;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private postSpawnLivenessTimers = new Set<ReturnType<typeof setTimeout>>();
  private sweepTiming: SweepTimingOptions | null = null;
  private lastSweepSignature: string | null = null;
  private unchangedSweepCount = 0;
  private currentSweepScreenSignatures = new Map<string, string>();
  /** agentId → last-pushed status target/value */
  private sidebarSnapshot = new Map<string, SidebarStatusSnapshot>();
  private progressSnapshot: string | null = null;
  /** e.g. "a1:spawned", "a1:done", "a1:error" */
  private loggedEvents = new Set<string>();
  /** agentId → consecutive ready-prompt matches */
  private readyPatternMatches = new Map<string, number>();
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
    this.sessionIdentityResolver =
      opts?.sessionIdentityResolver ??
      ((agent) => this.findTranscriptSessionIdentity(agent));
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

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  private hasOutputDoneEvidence(text: string): boolean {
    const parsed = parseScreen(text);
    return parsed.status === "done" && parsed.done_signal !== null;
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

  private hasGroundTruthDone(agent: AgentRecord): boolean {
    const session = this.loadGroundTruthSession(agent);
    if (!session?.state.done) return false;
    return Date.now() - session.mtime_ms >= DONE_QUIESCENCE_MS;
  }

  private async hasCurrentOutputDoneEvidence(
    agent: AgentRecord,
  ): Promise<boolean> {
    try {
      const screen = await this.client.readScreen(agent.surface_id, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
      return this.hasOutputDoneEvidence(screen.text);
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
    if (isCursorTerminalIdleTarget(agent, targetState)) return "state";
    if (agent.state !== targetState) return null;
    if (!this.requiresOutputDoneEvidence(targetState)) return "state";
    if (this.hasGroundTruthDone(agent)) return "transcript";
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
    if (agent.boot_prompt_pending) {
      waitForReadyPatternMatches.delete(agent.agent_id);
      return { agent };
    }

    try {
      const screen = await this.client.readScreen(agent.surface_id, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
      const match = matchReadyPattern(agent.cli, screen.text);
      const hasReadyIdentity =
        !readyPatternRequiresAgentIdentity(agent.cli) ||
        screenHasReadyAgentIdentity(
          agent.cli,
          screen.text,
          parseScreen(screen.text),
        );
      const ready = match.matched && hasReadyIdentity;
      if (!ready) {
        waitForReadyPatternMatches.delete(agent.agent_id);
        return { agent };
      }

      const count =
        (waitForReadyPatternMatches.get(agent.agent_id) ?? 0) + 1;
      waitForReadyPatternMatches.set(agent.agent_id, count);
      if (count < Math.max(1, match.consecutive)) {
        return { agent };
      }

      const transitionAgent =
        targetState === "ready"
          ? await this.maybeCaptureBootSessionId(agent, {
              screen: Promise.resolve(screen),
            })
          : agent;
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
    },
  ): Promise<CmuxNewSplitResult | CmuxNewSurfaceResult> {
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
    if (workspace) {
      try {
        await this.client.selectWorkspace(workspace);
      } catch {
        // Best-effort: the workspace may already be focused, or the client may
        // be an older test/fallback implementation.
      }
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
      const parentAgent = context?.parentAgent ?? null;
      const liveSurfaceIds = new Set(
        paneSurfaces.flatMap((group) =>
          group.surfaces.map((surface) => surface.ref),
        ),
      );
      const roleSurfaceIds = collectRoleSurfaceIds(this.registry.list());
      const extraRoleSurfaceIds =
        this.roleSurfaceIdsProvider?.(liveSurfaceIds, workspace) ?? null;
      if (extraRoleSurfaceIds) {
        for (const role of ["orchestrator", "ic", "worker"] as const) {
          for (const surfaceId of extraRoleSurfaceIds[role]) {
            roleSurfaceIds[role].add(surfaceId);
          }
        }
      }
      const childWorkerSurfaceIds = new Set(
        parentAgent
          ? this.registry
              .getChildren(parentAgent.agent_id)
              .filter((agent) => inferRecordRoleOrNull(agent) === "worker")
              .map((agent) => agent.surface_id)
          : [],
      );
      const parentRole = parentAgent
        ? inferRecordRoleOrNull(parentAgent)
        : null;
      const placement = chooseAgentSpawnPlacement(
        panes.panes,
        paneSurfaces,
        roleSurfaceIds,
        {
          role: context?.role ?? "worker",
          parentRole,
          parentSurfaceId: parentAgent?.surface_id ?? null,
          childWorkerSurfaceIds,
        },
      );
      return placement.kind === "surface"
        ? this.client.newSurface({
            pane: placement.pane,
            type: "terminal",
            workspace,
          })
        : this.client.newSplit(placement.direction, {
            ...(placement.pane ? { pane: placement.pane } : {}),
            workspace,
            type: "terminal",
          });
    } catch (error) {
      if (isAgentRoleInferenceError(error)) {
        throw error;
      }
      return this.client.newSplit("right", {
        workspace,
        type: "terminal",
      });
    }
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
  ): Promise<void> {
    if (this.launchCommandSender) {
      await this.launchCommandSender({ surface, workspace, command });
      return;
    }

    await this.client.send(surface, command, { workspace });
    await this.client.sendKey(surface, "return", { workspace });
  }

  private isBootCaptureWindowOpen(agent: AgentRecord): boolean {
    if (agent.state !== "booting") return false;
    const since = Date.parse(agent.updated_at);
    if (Number.isNaN(since)) return false;
    return Date.now() - since <= BOOT_SESSION_CAPTURE_WINDOW_MS;
  }

  private harnessCwdForAgent(agent: AgentRecord): string {
    const launchCwd = agent.launch_cwd?.trim();
    if (launchCwd) return launchCwd;
    const worktreePath = agent.worktree_path?.trim();
    if (worktreePath) return worktreePath;
    return join(homedir(), "Gits", agent.repo);
  }

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
        ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
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
      this.stateMgr.removeState(updated.agent_id);
      return canonicalFinal;
    }

    const previousAgentId = updated.agent_id;
    updated = this.stateMgr.renameState(previousAgentId, finalAgentId);
    this.registry.rename(previousAgentId, finalAgentId, updated);
    return updated;
  }

  private readSweepScreen(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<CmuxReadScreenResult> {
    ctx.screen ??= this.client
      .readScreen(agent.surface_id, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      })
      .then((screen) => {
        this.currentSweepScreenSignatures.set(
          agent.agent_id,
          `${agent.surface_id}:${screenTextSignature(screen.text)}`,
        );
        return screen;
      });
    return ctx.screen;
  }

  private async maybeCaptureBootSessionId(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<AgentRecord> {
    if (agent.cli_session_id || !this.isBootCaptureWindowOpen(agent)) {
      return agent;
    }

    try {
      const transcriptSessionId = this.sessionIdentityResolver(agent);
      if (transcriptSessionId) {
        return this.finalizeCapturedSession(agent, transcriptSessionId);
      }
    } catch {
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

  private async maybeMarkBootReady(
    agent: AgentRecord,
    ctx: SweepAgentContext,
  ): Promise<AgentRecord> {
    if (agent.state !== "booting") {
      this.readyPatternMatches.delete(agent.agent_id);
      return agent;
    }
    if (agent.boot_prompt_pending) {
      this.readyPatternMatches.delete(agent.agent_id);
      const since = Date.parse(agent.updated_at);
      if (
        Number.isNaN(since) ||
        Date.now() - since < BOOT_PROMPT_PENDING_STALE_MS
      ) {
        return agent;
      }

      try {
        this.stateMgr.updateRecord(agent.agent_id, {
          boot_prompt_pending: false,
        });
        const failed = this.stateMgr.transition(agent.agent_id, "error", {
          error: "Boot prompt delivery interrupted before completion",
        });
        this.registry.set(agent.agent_id, failed);
        return failed;
      } catch {
        return agent;
      }
    }

    try {
      const screen = await this.readSweepScreen(agent, ctx);
      const match = matchReadyPattern(agent.cli, screen.text);
      if (!match.matched) {
        this.readyPatternMatches.delete(agent.agent_id);
        return agent;
      }

      const count = (this.readyPatternMatches.get(agent.agent_id) ?? 0) + 1;
      this.readyPatternMatches.set(agent.agent_id, count);
      if (count < Math.max(1, match.consecutive)) {
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

    if (this.hasGroundTruthDone(agent)) {
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
      if (!this.hasOutputDoneEvidence(screen.text)) {
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
          { level: "warning", source: "cmux-mcp" },
        );
        return;
      }

      await this.client.log(
        `crash-recovery: failed to persist error for ${agentId}: ${persistMessage}`,
        { level: "error", source: "cmux-mcp" },
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
      { level: "error", source: "cmux-mcp" },
    );
  }

  private async recoverCrashedAgents(): Promise<void> {
    const erroredAgents = this.registry.list({ state: "error" });
    for (const agent of erroredAgents) {
      if (!this.isRecoverableCrash(agent)) {
        continue;
      }

      const nextRespawnAttempt = (agent.respawn_attempts ?? 0) + 1;
      if (nextRespawnAttempt > MAX_RESPAWN_ATTEMPTS) {
        await this.markCrashRecoveryExhausted(agent);
        continue;
      }

      try {
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
        const creating = this.stateMgr.transition(agent.agent_id, "creating", {
          error: null,
          pid: null,
          cli_session_id: agent.cli_session_id,
        });
        this.registry.set(agent.agent_id, creating);

        const patched = this.stateMgr.updateRecord(agent.agent_id, {
          surface_id: surface.surface,
          workspace_id: surface.workspace,
          crash_recover: true,
          respawn_attempts: nextRespawnAttempt,
          user_killed: false,
          deletion_intent: false,
          error: null,
          pid: null,
        });
        this.registry.set(agent.agent_id, patched);

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
          surface.workspace,
          resumeCmd,
        );
        await this.client.log(
          `crash-recovery: respawned ${agent.agent_id} on ${surface.surface}`,
          { level: "warning", source: "cmux-mcp" },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.persistCrashRecoveryFailure(agent.agent_id, message);
      }
    }
  }

  private async emitLifecycleEvent(
    agent: AgentRecord,
    event: AgentLifecycleEvent,
  ): Promise<void> {
    const eventKey = `${agent.agent_id}:${event}`;
    if (this.loggedEvents.has(eventKey)) {
      return;
    }

    const spec = LIFECYCLE_LOGS[event];
    await this.client.log(`${spec.message}: ${agent.repo}`, {
      level: spec.level,
      source: "cmux-mcp",
    });

    try {
      // Channel delivery is best-effort and must not break the sweep loop.
      await this.client.notifyLifecycleEvent(event, agent);
    } catch {
      // Ignore Claude channel push failures; logs and sidebar state remain canonical.
    }

    this.loggedEvents.add(eventKey);
  }

  /**
   * Sync sidebar: diff agents against snapshot, push only changes.
   * Logs lifecycle events (spawned, done, error) once each.
   */
  private async syncSidebar(): Promise<void> {
    const agents = this.registry.list();
    const total = agents.length;
    const done = agents.filter((a) => a.state === "done").length;

    for (const originalAgent of agents) {
      const sweepCtx: SweepAgentContext = {};
      const capturedAgent = await this.maybeCaptureBootSessionId(
        originalAgent,
        sweepCtx,
      );
      const readyAgent = await this.maybeMarkBootReady(capturedAgent, sweepCtx);
      const taskDoneResult = await this.maybeMarkTaskDone(readyAgent, sweepCtx);
      const agent = taskDoneResult.agent;
      const { agent_id: agentId, repo, state, surface_id } = agent;
      const statusValue =
        state === "error" ? `${repo}: error` : `${repo}: ${state}`;
      const statusSnapshot: SidebarStatusSnapshot = {
        statusValue,
        surfaceId: surface_id,
        workspaceId: agent.workspace_id ?? null,
      };

      // Lifecycle log: spawned (first encounter)
      if (!this.sidebarSnapshot.has(agentId)) {
        await this.emitLifecycleEvent(agent, "spawned");
      }

      // Lifecycle log: done
      if (state === "done") {
        await this.emitLifecycleEvent(agent, "done");
      }

      // Lifecycle log: error
      if (state === "error") {
        await this.emitLifecycleEvent(agent, "errored");
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
        continue;
      }

      // Status diff — only push if changed
      const prev = this.sidebarSnapshot.get(agentId);
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
        await this.client.setStatus(agentId, statusValue, {
          icon: sidebar.icon,
          color: sidebar.color,
          surface: surface_id,
          workspace: agent.workspace_id ?? undefined,
        });
        this.sidebarSnapshot.set(agentId, statusSnapshot);
      }

      // Quality tracking: check context usage for non-terminal agents
      // AIDEV-NOTE: Uses parseScreen for model-aware context_pct (handles Claude, Codex, Gemini).
      // Replaces legacy parseContextPercent which only matched "X% context" text patterns.
      if (!TERMINAL_STATES.has(state)) {
        try {
          const screenText =
            taskDoneResult.screenText ??
            (await this.client.readScreen(surface_id, { lines: 5 })).text;
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
              await this.client.send(surface_id, "/compact", {});
              await this.client.sendKey(surface_id, "return", {});
            } else {
              await this.client.log(
                `context-limit: depth ${agent.spawn_depth} agent ${repo} degraded; leaving pane running for orchestrator decision`,
                { level: "warning", source: "cmux-mcp" },
              );
            }
          }
        } catch {
          // readScreen failures are non-fatal — next sweep will retry
        }
      }
    }

    // Clean up sidebar entries for agents that were purged from the registry
    const currentAgentIds = new Set(
      this.registry.list().map((a) => a.agent_id),
    );
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
      }
    }

    // Progress bar
    if (total > 0) {
      const progressSnapshot = `${done}/${total}`;
      if (this.progressSnapshot !== progressSnapshot) {
        await this.client.setProgress(done / total, {
          label: `agents ${done}/${total}`,
        });
        this.progressSnapshot = progressSnapshot;
      }
    }
  }

  /** Whether a startup purge is pending (opt-in via enableStartupPurge) */
  private startupPurgePending = false;

  /**
   * Enable startup purge on the next sweep. Call after reconstitute()
   * to clear stale terminal-state agents from previous cmux sessions.
   */
  enableStartupPurge(): void {
    this.startupPurgePending = true;
  }

  /**
   * Public sweep: reconcile registry, purge dead entries, then sync sidebar.
   * If enableStartupPurge() was called, the first sweep also purges all
   * terminal-state agents unconditionally — these are stale entries from
   * previous cmux sessions whose surface refs may have been recycled.
   */
  async runSweep(): Promise<void> {
    this.currentSweepScreenSignatures = new Map();
    await this.registry.reconcile();
    await this.recoverCrashedAgents();

    if (this.startupPurgePending) {
      this.startupPurgePending = false;
      const purgedIds = this.registry.purgeAllTerminal();
      // Seed sidebar snapshot so syncSidebar clears their cmux entries
      for (const id of purgedIds) {
        this.sidebarSnapshot.set(id, {
          statusValue: "__purged__",
          surfaceId: null,
          workspaceId: null,
        });
      }
    }

    await this.registry.purgeTerminal();
    await this.syncSidebar();
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
        console.error("[cmux-mcp] sweep failed (will retry):", e);
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
    const surfaceLive = await this.registry.hasLiveSurface(agent.surface_id);
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
      const parent = this.registry.get(spawnParams.parent_agent_id);
      if (!parent) {
        throw new Error(
          `Parent agent not found: ${spawnParams.parent_agent_id}`,
        );
      }
      if (parent.spawn_depth >= MAX_SPAWN_DEPTH) {
        throw new Error(`Max spawn depth exceeded: ${MAX_SPAWN_DEPTH}`);
      }
      const children = this.registry.getChildren(parent.agent_id);
      if (children.length >= MAX_CHILDREN) {
        throw new Error(`Max children exceeded: ${MAX_CHILDREN}`);
      }
      spawnDepth = parent.spawn_depth + 1;
      parentAgentId = parent.agent_id;
      parentAgent = parent;
    }

    this.spawnGuard.check(spawnParams.workspace);

    const preflight = await this.spawnPreflight(spawnParams);

    // 1. Create cmux surface using the deterministic worker layout policy.
    const surface = await this.createAgentSurface(spawnParams.workspace, {
      role,
      parentAgent,
      repo: spawnParams.repo,
    });

    // 2. Write initial state (creating → booting)
    const now = new Date().toISOString();
    const record: AgentRecord = {
      agent_id: agentId,
      surface_id: surface.surface,
      workspace_id: surface.workspace,
      state: "booting",
      repo: spawnParams.repo,
      model: spawnParams.model ?? modelPolicy.effective_model,
      cli: spawnParams.cli,
      cli_session_id: null,
      cli_session_path: null,
      launcher_name: preflight?.launcherName ?? null,
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
    this.stateMgr.writeState(record);
    this.registry.set(agentId, record);

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
      await this.sendLaunchCommand(
        surface.surface,
        surface.workspace,
        launchCmd,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        const failed = this.stateMgr.transition(agentId, "error", {
          error: `Launch failed: ${message}`,
        });
        this.registry.set(agentId, failed);
      } catch {
        // Preserve the original launch error for the caller.
      }
      throw error;
    }
    this.schedulePostSpawnLivenessAssertion(agentId);

    return {
      agent_id: agentId,
      surface_id: surface.surface,
      workspace_id: surface.workspace,
      state: "booting",
      model: modelPolicy.effective_model,
      requested_model: modelPolicy.requested_model,
      warnings: modelPolicy.warnings,
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
        await this.registry.reconcile();
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
      workspace_id: agent.workspace_id ?? null,
      state: agent.state,
      session_id: agent.cli_session_id,
      resumable: !!agent.cli_session_id,
      ...(resumeCommand ? { resume_command: resumeCommand } : {}),
    };
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
          if (paneSurfaces.surfaces.some((surface) => surface.ref === surfaceId)) {
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
      const workerSurfaceIds = new Set(
        this.registry.list().map((record) => record.surface_id),
      );
      const policy = chooseSurfaceClosePolicy(
        panes.panes,
        paneSurfaces,
        workerSurfaceIds,
        surfaceId,
      );
      return {
        paneRef: policy.pane,
        collapsePane: policy.collapsePane,
      };
    } catch {
      return {
        paneRef: await this.resolvePaneForSurface(surfaceId, workspaceId),
        collapsePane: false,
      };
    }
  }

  private isProcessGone(pid: number | null | undefined): boolean {
    if (!pid) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ESRCH"
      ) {
        return true;
      }
      return false;
    }
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
      if (
        !this.isTerminalDeadRegistryGhost(agent) &&
        (!agent.pid || !this.isProcessGone(agent.pid))
      ) {
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
  ): Promise<StopPostConditionResult> {
    const processGone = this.isProcessGone(agent.pid);
    const [surfaceGone, paneGone] = await Promise.all([
      this.isSurfaceGone(agent.surface_id),
      this.isPaneGone(paneRef, agent.workspace_id),
    ]);
    return { processGone, surfaceGone, paneGone, paneRef };
  }

  private async waitForStopPostCondition(
    agent: AgentRecord,
    paneRef: string | null,
    expectPaneGone: boolean,
  ): Promise<StopPostConditionResult> {
    const deadline = Date.now() + this.stopPostConditionTimeoutMs;
    let result = await this.readStopPostCondition(agent, paneRef);
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
      result = await this.readStopPostCondition(agent, paneRef);
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
    opts?: { userInitiated?: boolean },
  ): Promise<void> {
    const route = this.resolveAgentRoute(agentId);
    const canonicalAgentId = route.agent_id;
    const agent = this.registry.get(canonicalAgentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const userInitiated = opts?.userInitiated ?? true;

    if (TERMINAL_STATES.has(agent.state)) {
      if (force) {
        this.registry.evict(canonicalAgentId);
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

    const stopClosePolicy = await this.resolveStopSurfaceClosePolicy(
      route.surface_id,
      route.workspace_id,
    );

    if (force && agent.pid) {
      try {
        process.kill(agent.pid, "SIGKILL");
      } catch {
        // Process may already be dead — that's fine
      }
    } else {
      // Graceful: send Ctrl+C
      await this.client.sendKey(route.surface_id, "c-c", {
        workspace: route.workspace_id ?? undefined,
      });
    }

    let closeError: string | null = null;
    try {
      await this.client.closeSurface(route.surface_id, {
        workspace: route.workspace_id ?? undefined,
        collapsePane: stopClosePolicy.collapsePane,
      });
    } catch (error) {
      closeError = error instanceof Error ? error.message : String(error);
    }

    const stopResult = await this.waitForStopPostCondition(
      agent,
      stopClosePolicy.paneRef,
      stopClosePolicy.collapsePane,
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

    const route = this.resolveAgentRoute(agentId);
    const workspace = route.workspace_id ?? undefined;
    await this.client.send(route.surface_id, sanitizeTerminalInput(text), {
      workspace,
    });
    if (pressEnter) {
      await this.client.sendKey(route.surface_id, "return", { workspace });
    }
    const refreshed = this.stateMgr.updateRecord(agent.agent_id, {});
    this.registry.set(agent.agent_id, refreshed);
  }
}
