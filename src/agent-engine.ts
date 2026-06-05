/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StateManager } from "./state-manager.js";
import { isSafeShellToken, sanitizeTerminalInput } from "./sanitize.js";
import { AgentRegistry, type AgentFilter } from "./agent-registry.js";
import {
  resolveAgentRoute as resolvePublicAgentRoute,
  toPublicAgent,
} from "./agent-facade.js";
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
  collectRoleSurfaceIds,
  inferAgentRole,
  inferRecordRole,
  inferRecordRoleOrNull,
  isAgentRoleInferenceError,
  launcherNameForCli,
  type RoleSurfaceIds,
} from "./layout-policy.js";
import { matchReadyPattern } from "./pattern-registry.js";
import { resolveWorkspaceRefForRepo } from "./repo-workspace.js";
import { SpawnGuard } from "./spawn-guard.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";

export interface SpawnAgentParams {
  repo: string;
  model: string;
  cli: CliType;
  prompt: string;
  boot_prompt_pending?: boolean;
  workspace?: string;
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
}

export interface AgentEngineOptions {
  spawnPreflight?: (params: SpawnAgentParams) => Promise<void>;
  spawnGuard?: SpawnGuard;
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
const SWEEP_INTERVAL_MS = 1000;
const BOOT_SESSION_CAPTURE_WINDOW_MS = 30_000;
const BOOT_SESSION_CAPTURE_LINES = 80;
const BOOT_PROMPT_PENDING_STALE_MS = 5 * 60_000;
const TASK_DONE_AUTO_ARCHIVE_DEFAULT_MS = 30 * 60_000;
const TASK_DONE_CONFIRMATION_MS = 5_000;
const SESSION_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID_RE =
  new RegExp(`\\b${SESSION_ID_PATTERN}\\b`, "gi");
const CONTEXTUAL_SESSION_ID_PATTERNS = [
  new RegExp(`(?:codex\\s+resume|--resume(?:-id)?|resume-id)\\s+(${SESSION_ID_PATTERN})`, "i"),
  new RegExp(`session\\s+id:\\s*(${SESSION_ID_PATTERN})`, "i"),
  new RegExp(`chatid:\\s*(${SESSION_ID_PATTERN})`, "i"),
  new RegExp(`resumable\\s+session:\\s*(${SESSION_ID_PATTERN})`, "i"),
] as const;
const execFileAsync = promisify(execFile);

interface SidebarStatusSnapshot {
  statusValue: string;
  surfaceId: string | null;
  workspaceId: string | null;
}

function autoArchiveEnabledByEnv(): boolean {
  return !["0", "false", "off", "no"].includes(
    (process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE ?? "").toLowerCase(),
  );
}

function tailScreenLines(text: string, lines: number): string {
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

function taskDoneAutoArchiveMs(): number {
  const rawMs = process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MS;
  if (rawMs !== undefined) {
    const parsed = Number(rawMs);
    return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : TASK_DONE_AUTO_ARCHIVE_DEFAULT_MS;
  }

  const rawMinutes = process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MINUTES;
  if (rawMinutes === undefined) {
    return TASK_DONE_AUTO_ARCHIVE_DEFAULT_MS;
  }
  const parsed = Number(rawMinutes);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed * 60_000
    : TASK_DONE_AUTO_ARCHIVE_DEFAULT_MS;
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
  send(
    surface: string,
    text: string,
    opts?: CmuxSendOptions,
  ): Promise<void>;
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
 * For claude: uses repoGolem launchers (e.g. `voicelayerClaude -s`)
 * which handle cd, model, iTerm profile, MCP config, and contexts.
 * No `cd` prefix needed — the launcher does it.
 *
 * For gemini/kiro: uses `cd ~/Gits/<repo> && <cli>` since they
 * don't have launcher functions yet.
 */
// Env vars for headless/spawned agent sessions:
// - MCP_CONNECTION_NONBLOCKING: skip MCP connection wait (Claude Code 2.1.90+)
// - CLAUDE_CODE_NO_FLICKER: stable alt-screen rendering for terminal parsing
const AGENT_ENV = "MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1";

function sanitizeRepoName(repo: string): string {
  const safeRepo = repo.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeRepo || safeRepo !== repo || safeRepo === "." || safeRepo === "..") {
    throw new Error(
      `Invalid repo name: "${repo}". Only alphanumeric, dots, hyphens, and underscores allowed. "." and ".." are not permitted.`,
    );
  }
  return safeRepo;
}

const MODEL_FLAG_ALIASES: Record<CliType, Record<string, string>> = {
  claude: {
    opus: "opus",
    sonnet: "sonnet",
    haiku: "haiku",
  },
  codex: {
    "gpt-5": "gpt-5",
    "gpt-5-codex": "gpt-5-codex",
    "gpt-5.3": "gpt-5.3",
    "gpt-5.3-codex": "gpt-5.3-codex",
    "gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
    "gpt-5.4": "gpt-5.4",
    "gpt-5.4-mini": "gpt-5.4-mini",
    "gpt-5.5": "gpt-5.5",
    "gpt-5.5-mini": "gpt-5.5-mini",
  },
  cursor: {
    codex: "gpt-5",
    "gpt-5": "gpt-5",
    "gpt-5.2-codex-high": "gpt-5.2-codex-high",
    "gpt-5.2-codex-xhigh": "gpt-5.2-codex-xhigh",
    sonnet: "sonnet-4",
    "sonnet-4": "sonnet-4",
    "sonnet-4-thinking": "sonnet-4-thinking",
  },
  gemini: {
    "gemini-2.5-pro": "gemini-2.5-pro",
    "gemini-2.5-flash": "gemini-2.5-flash",
    "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
    "gemini-3.1-pro": "gemini-3.1-pro",
  },
  kiro: {
    opus: "opus",
    sonnet: "sonnet",
    haiku: "haiku",
  },
};

function resolveModelFlag(cli: CliType, model?: string): string | null {
  const normalized = model?.trim().toLowerCase();
  if (!normalized || !isSafeShellToken(normalized)) {
    return null;
  }

  const mapped = MODEL_FLAG_ALIASES[cli][normalized];
  if (!mapped || !isSafeShellToken(mapped)) {
    return null;
  }

  return mapped;
}

export function buildLaunchCommand(
  cli: CliType,
  repo: string,
  model?: string,
): string {
  const safeRepo = sanitizeRepoName(repo);
  const modelFlag = resolveModelFlag(cli, model);
  const launcherModelArgs = modelFlag ? ` -m ${modelFlag}` : "";
  const rawModelArgs = modelFlag ? ` --model ${modelFlag}` : "";
  switch (cli) {
    case "claude":
      // repoGolem launcher handles env vars via ralph-registry
      return `${safeRepo}Claude -s${launcherModelArgs}`;
    case "codex":
      return `${safeRepo}Codex -s${launcherModelArgs}`;
    case "gemini":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} gemini${rawModelArgs}`;
    case "kiro":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} kiro-cli${rawModelArgs}`;
    case "cursor":
      // repoGolem launcher - requires registration via golem-powers.
      return `${safeRepo}Cursor -s${launcherModelArgs}`;
  }
}

export function buildResumeCommand(
  cli: CliType,
  repo: string,
  sessionId: string,
): string {
  const safeRepo = sanitizeRepoName(repo);
  switch (cli) {
    case "claude":
      return `${safeRepo}Claude -s --resume ${sessionId}`;
    case "codex":
      return `${safeRepo}Codex --dangerously-bypass-approvals-and-sandbox resume ${sessionId}`;
    case "gemini":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} gemini --resume ${sessionId}`;
    case "kiro":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} kiro-cli chat --resume-id ${sessionId}`;
    case "cursor":
      return `${safeRepo}Cursor -s --resume ${sessionId}`;
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

export async function assertLauncherAvailable(
  repo: string,
  suffix: "Claude" | "Codex" | "Cursor",
): Promise<void> {
  const launcher = `${sanitizeRepoName(repo)}${suffix}`;
  const shell = process.env.SHELL || "/bin/zsh";
  const probe = `type ${launcher} >/dev/null 2>&1 || command -v ${launcher} >/dev/null 2>&1`;

  try {
    await execFileAsync(shell, ["-ilc", probe]);
  } catch {
    throw new Error(
      `Launcher "${launcher}" not found. ` +
        `For repo "${repo}" with hyphens the launcher strips hyphens ` +
        `(e.g. "skill-creator" -> "skillcreatorCursor"). ` +
        `Register the launcher in golem-powers or use cli="gemini"/"kiro" ` +
        `which use direct cd+exec paths.`,
    );
  }
}

export class AgentEngine {
  private stateMgr: StateManager;
  private registry: AgentRegistry;
  private client: AgentEngineClient;
  private spawnPreflight: (params: SpawnAgentParams) => Promise<void>;
  private spawnGuard: SpawnGuard;
  private roleSurfaceIdsProvider?: (
    liveSurfaceIds?: ReadonlySet<string>,
    workspace?: string,
  ) => RoleSurfaceIds;
  private launchCommandSender?: AgentEngineOptions["launchCommandSender"];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
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
    this.spawnGuard = opts?.spawnGuard ?? new SpawnGuard();
    this.spawnPreflight =
      opts?.spawnPreflight ??
      (async (params) => {
        if (params.cli === "claude") {
          await assertLauncherAvailable(params.repo, "Claude");
        } else if (params.cli === "codex") {
          await assertLauncherAvailable(params.repo, "Codex");
        } else if (params.cli === "cursor") {
          await assertLauncherAvailable(params.repo, "Cursor");
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
    if (agent.state !== targetState) return false;
    if (!this.requiresOutputDoneEvidence(targetState)) return true;
    return (
      this.hasRecordedOutputDoneEvidence(agent) ||
      (await this.hasCurrentOutputDoneEvidence(agent))
    );
  }

  private async refreshTargetStateEvidence(
    agent: AgentRecord,
    targetState: AgentState,
  ): Promise<AgentRecord> {
    if (!this.requiresOutputDoneEvidence(targetState)) return agent;
    if (TERMINAL_STATES.has(agent.state)) return agent;
    return (await this.maybeMarkTaskDone(agent)).agent;
  }

  private async createAgentSurface(
    workspace?: string,
    context?: {
      role?: AgentRole;
      parentAgent?: AgentRecord | null;
      repo?: string;
    },
  ): Promise<CmuxNewSplitResult | CmuxNewSurfaceResult> {
    workspace = await this.resolveWorkspaceForRepo(workspace, context?.repo);
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
      const parentRole = parentAgent ? inferRecordRoleOrNull(parentAgent) : null;
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

  private async maybeCaptureBootSessionId(agent: AgentRecord): Promise<AgentRecord> {
    if (agent.cli_session_id || !this.isBootCaptureWindowOpen(agent)) {
      return agent;
    }

    try {
      const screen = await this.client.readScreen(agent.surface_id, {
        lines: BOOT_SESSION_CAPTURE_LINES,
        scrollback: true,
      });
      const sessionId = extractSessionId(screen.text);
      if (!sessionId) {
        return agent;
      }

      const updated = this.stateMgr.updateRecord(agent.agent_id, {
        cli_session_id: sessionId,
      });
      this.registry.set(agent.agent_id, updated);
      return updated;
    } catch {
      return agent;
    }
  }

  private async maybeMarkBootReady(agent: AgentRecord): Promise<AgentRecord> {
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
      const screen = await this.client.readScreen(agent.surface_id, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
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

      const updated = this.stateMgr.transition(agent.agent_id, "ready");
      this.registry.set(agent.agent_id, updated);
      this.readyPatternMatches.delete(agent.agent_id);
      return updated;
    } catch {
      return agent;
    }
  }

  private async maybeMarkTaskDone(
    agent: AgentRecord,
    opts?: { allowBootPromptPending?: boolean },
  ): Promise<{ agent: AgentRecord; screenText?: string }> {
    if (TERMINAL_STATES.has(agent.state)) return { agent };
    if (agent.boot_prompt_pending && opts?.allowBootPromptPending !== true) {
      return { agent };
    }

    try {
      const screen = await this.client.readScreen(agent.surface_id, {
        lines: BOOT_SESSION_CAPTURE_LINES,
      });
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
    if (agent.state !== "done") return false;
    if (agent.cli !== "codex" || inferRecordRole(agent) !== "worker") {
      return false;
    }
    if (agent.auto_archive_on_done !== true || !autoArchiveEnabledByEnv()) {
      return false;
    }
    if (!agent.task_done_detected_at) return false;

    const detectedAt = Date.parse(agent.task_done_detected_at);
    if (Number.isNaN(detectedAt)) return false;
    if (Date.now() - detectedAt < taskDoneAutoArchiveMs()) return false;

    try {
      await this.client.closeSurface(agent.surface_id, {
        workspace: agent.workspace_id ?? undefined,
      });
      return true;
    } catch {
      // Best-effort archive; the next sweep will retry if the surface remains.
      return false;
    }
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
        persistError instanceof Error ? persistError.message : String(persistError);
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

        const surface = await this.createAgentSurface(agent.workspace_id ?? undefined, {
          role: inferRecordRole(agent),
          parentAgent: agent.parent_agent_id
            ? this.registry.get(agent.parent_agent_id)
            : null,
          repo: agent.repo,
        });
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
      const capturedAgent = await this.maybeCaptureBootSessionId(originalAgent);
      const readyAgent = await this.maybeMarkBootReady(capturedAgent);
      const taskDoneResult = await this.maybeMarkTaskDone(readyAgent);
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
      if (archived) {
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
              // Non-root: kill and log. No auto-respawn because:
              // 1. Respawn loses all work-in-progress context (new agent starts from scratch)
              // 2. The parent orchestrator should decide retry strategy, not the sweep
              // 3. Each respawn adds a dead child — repeated cycles hit MAX_CHILDREN with corpses
              await this.stopAgent(agentId, false, { userInitiated: false });
              await this.client.log(
                `context-limit: killing depth ${agent.spawn_depth} agent ${repo}`,
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
    const currentAgentIds = new Set(agents.map((a) => a.agent_id));
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

  /**
   * Start the reconciliation sweep on an interval.
   */
  startSweep(intervalMs: number = 5000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.runSweep().catch((e) => {
        console.error("[cmux-mcp] sweep failed (will retry):", e);
      });
    }, intervalMs);
  }

  /**
   * Stop the reconciliation sweep.
   */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Spawn an agent — async, returns immediately with agent handle.
   * Does NOT wait for ready state.
   */
  async spawnAgent(params: SpawnAgentParams): Promise<SpawnAgentResult> {
    const agentId = generateAgentId(params.model, params.repo);

    // Resolve parent hierarchy
    let spawnDepth = 0;
    let parentAgentId: string | null = null;
    let parentAgent: AgentRecord | null = null;
    const role = inferAgentRole({
      role: params.role,
      cli: params.cli,
      launcherName: launcherNameForCli(params.repo, params.cli),
    });

    if (params.parent_agent_id) {
      const parent = this.registry.get(params.parent_agent_id);
      if (!parent) {
        throw new Error(`Parent agent not found: ${params.parent_agent_id}`);
      }
      if (parent.spawn_depth >= MAX_SPAWN_DEPTH) {
        throw new Error(`Max spawn depth exceeded: ${MAX_SPAWN_DEPTH}`);
      }
      const children = this.registry.getChildren(params.parent_agent_id);
      if (children.length >= MAX_CHILDREN) {
        throw new Error(`Max children exceeded: ${MAX_CHILDREN}`);
      }
      spawnDepth = parent.spawn_depth + 1;
      parentAgentId = params.parent_agent_id;
      parentAgent = parent;
    }

    this.spawnGuard.check(params.workspace);

    await this.spawnPreflight(params);

    // 1. Create cmux surface using the deterministic worker layout policy.
    const surface = await this.createAgentSurface(params.workspace, {
      role,
      parentAgent,
      repo: params.repo,
    });

    // 2. Write initial state (creating → booting)
    const now = new Date().toISOString();
    const record: AgentRecord = {
      agent_id: agentId,
      surface_id: surface.surface,
      workspace_id: surface.workspace,
      state: "booting",
      repo: params.repo,
      model: params.model,
      cli: params.cli,
      cli_session_id: null,
      task_summary: params.prompt,
      pid: null,
      version: 1,
      created_at: now,
      updated_at: now,
      error: null,
      parent_agent_id: parentAgentId,
      spawn_depth: spawnDepth,
      role,
      auto_archive_on_done: params.auto_archive_on_done,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: params.max_cost_per_agent ?? null,
      crash_recover: params.crash_recover ?? false,
      respawn_attempts: 0,
      user_killed: false,
      boot_prompt_pending: params.boot_prompt_pending ?? false,
    };
    this.stateMgr.writeState(record);
    this.registry.set(agentId, record);

    // 3. Send launch command
    const launchCmd = buildLaunchCommand(params.cli, params.repo, params.model);
    try {
      await this.sendLaunchCommand(surface.surface, surface.workspace, launchCmd);
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

    return {
      agent_id: agentId,
      surface_id: surface.surface,
      workspace_id: surface.workspace,
      state: "booting",
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

    // Retroactive check — already in target state with required output evidence?
    if (await this.hasTargetStateEvidence(initial, targetState)) {
      return {
        matched: true,
        state: initial.state,
        elapsed: Date.now() - start,
        source: "immediate",
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

    // Polling sweep loop
    return new Promise<WaitResult>((resolve) => {
      const checkInterval = setInterval(async () => {
        const elapsed = Date.now() - start;
        if (elapsed >= timeoutMs) {
          clearInterval(checkInterval);
          const current = this.registry.get(agentId);
          resolve({
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
          resolve({
            matched: false,
            state: "error",
            elapsed,
            source: "sweep",
            agent: null,
            error: "Agent disappeared during wait",
          });
          return;
        }

        current = await this.refreshTargetStateEvidence(current, targetState);

        if (await this.hasTargetStateEvidence(current, targetState)) {
          clearInterval(checkInterval);
          resolve({
            matched: true,
            state: current.state,
            elapsed,
            source: "sweep",
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
          resolve({
            matched: false,
            state: current.state,
            elapsed,
            source: "sweep",
            agent: toPublicAgent(current),
            error:
              current.error ?? `Agent entered terminal state: ${current.state}`,
          });
        }
      }, SWEEP_INTERVAL_MS);
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
    return resolvePublicAgentRoute(this.listAgents(), agentId);
  }

  /**
   * Stop an agent gracefully (Ctrl+C) or forcefully (kill PID).
   */
  async stopAgent(
    agentId: string,
    force?: boolean,
    opts?: { userInitiated?: boolean },
  ): Promise<void> {
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const userInitiated = opts?.userInitiated ?? true;

    if (TERMINAL_STATES.has(agent.state)) {
      if (agent.state === "error" && userInitiated && agent.user_killed !== true) {
        const marked = this.stateMgr.updateRecord(agentId, {
          user_killed: true,
        });
        this.registry.set(agentId, marked);
      }
      return; // Already stopped
    }

    if (force && agent.pid) {
      try {
        process.kill(agent.pid, "SIGKILL");
      } catch {
        // Process may already be dead — that's fine
      }
    } else {
      // Graceful: send Ctrl+C
      await this.client.sendKey(agent.surface_id, "c-c", {
        workspace: agent.workspace_id ?? undefined,
      });
    }

    const current = this.registry.get(agentId) ?? agent;
    let marked = current;
    if ((current.user_killed ?? false) !== userInitiated) {
      marked = this.stateMgr.updateRecord(agentId, {
        user_killed: userInitiated,
      });
      this.registry.set(agentId, marked);
    }

    // Transition to done
    try {
      const updated = this.stateMgr.transition(agentId, "done");
      this.registry.set(agentId, updated);
    } catch {
      // If transition to done fails (e.g. from error state), try error
      try {
        const updated = this.stateMgr.transition(agentId, "error", {
          error: "Force stopped",
        });
        this.registry.set(agentId, updated);
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
  }
}
