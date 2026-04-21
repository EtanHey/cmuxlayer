/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StateManager } from "./state-manager.js";
import { sanitizeTerminalInput } from "./sanitize.js";
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
} from "./types.js";
import {
  generateAgentId,
  isCrashRecoveryEligible,
  MAX_SPAWN_DEPTH,
  MAX_CHILDREN,
  MAX_RESPAWN_ATTEMPTS,
  type AgentRoute,
  type AgentRecord,
  type AgentState,
  type CliType,
  type PublicAgent,
  type WaitResult,
} from "./agent-types.js";
import { parseScreen } from "./screen-parser.js";
import { chooseAgentSpawnPlacement } from "./layout-policy.js";

export interface SpawnAgentParams {
  repo: string;
  model: string;
  cli: CliType;
  prompt: string;
  workspace?: string;
  parent_agent_id?: string;
  max_cost_per_agent?: number;
  crash_recover?: boolean;
}

export interface SpawnAgentResult {
  agent_id: string;
  surface_id: string;
  state: AgentState;
}

export interface AgentEngineOptions {
  spawnPreflight?: (params: SpawnAgentParams) => Promise<void>;
}

export type AgentLifecycleEvent = "spawned" | "done" | "errored";

const INTERACTIVE_STATES = new Set<AgentState>(["ready", "idle"]);
const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);
const SWEEP_INTERVAL_MS = 1000;
const BOOT_SESSION_CAPTURE_WINDOW_MS = 30_000;
const BOOT_SESSION_CAPTURE_LINES = 80;
const STOP_AGENT_RETRY_ATTEMPTS = 3;
const STOP_AGENT_RETRY_DELAY_MS = 75;
const SHELL_PROMPT_RE = /(^|\n)\s*(?:❯|>>>|\$|%|>)\s*$/m;
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

interface AgentEngineClient {
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
  listPanes(opts?: { workspace?: string }): Promise<{
    workspace_ref?: string;
    panes: CmuxPane[];
  }>;
  listPaneSurfaces(opts?: {
    workspace?: string;
    pane?: string;
  }): Promise<CmuxPaneSurfaces>;
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
 * For other CLIs: uses `cd ~/Gits/<repo> && <cli>` since they
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

function stopKeysForCli(cli: CliType): string[] {
  switch (cli) {
    case "claude":
      return ["c-c", "c-c", "c-c", "c-c", "c-c"];
    case "codex":
      return ["escape", "c-c"];
    default:
      return ["c-c"];
  }
}

function screenShowsShellPrompt(text: string): boolean {
  return SHELL_PROMPT_RE.test(text);
}

export function buildLaunchCommand(cli: CliType, repo: string): string {
  const safeRepo = sanitizeRepoName(repo);
  switch (cli) {
    case "claude":
      // repoGolem launcher handles env vars via ralph-registry
      return `${safeRepo}Claude -s`;
    case "codex":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} codex`;
    case "gemini":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} gemini`;
    case "kiro":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} kiro-cli`;
    case "cursor":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} cursor agent`;
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
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} claude --dangerously-skip-permissions --resume ${sessionId}`;
    case "codex":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} codex resume ${sessionId}`;
    case "gemini":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} gemini --resume ${sessionId}`;
    case "kiro":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} kiro-cli chat --resume-id ${sessionId}`;
    case "cursor":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} cursor agent --resume ${sessionId}`;
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

async function assertClaudeLauncherAvailable(repo: string): Promise<void> {
  const launcher = `${sanitizeRepoName(repo)}Claude`;
  const shell = process.env.SHELL || "/bin/sh";
  const probe = `type ${launcher} >/dev/null 2>&1 || command -v ${launcher} >/dev/null 2>&1`;

  try {
    await execFileAsync(shell, ["-lc", probe]);
  } catch {
    throw new Error(
      `Launcher "${launcher}" not found. For repo "${repo}" with hyphens, ` +
        `the launcher name strips the hyphen (e.g. "skill-creator" → "skillcreatorClaude"). ` +
        `Use the direct shell spawn path, or fix the repoGolem config.`,
    );
  }
}

export class AgentEngine {
  private stateMgr: StateManager;
  private registry: AgentRegistry;
  private client: AgentEngineClient;
  private spawnPreflight: (params: SpawnAgentParams) => Promise<void>;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** agentId → last-pushed status string */
  private sidebarSnapshot = new Map<string, string>();
  /** e.g. "a1:spawned", "a1:done", "a1:error" */
  private loggedEvents = new Set<string>();

  constructor(
    stateMgr: StateManager,
    registry: AgentRegistry,
    client: AgentEngineClient,
    opts?: AgentEngineOptions,
  ) {
    this.stateMgr = stateMgr;
    this.registry = registry;
    this.client = client;
    this.spawnPreflight =
      opts?.spawnPreflight ??
      (async (params) => {
        if (params.cli === "claude") {
          await assertClaudeLauncherAvailable(params.repo);
        }
      });
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  private async createAgentSurface(
    workspace?: string,
  ): Promise<CmuxNewSplitResult | CmuxNewSurfaceResult> {
    try {
      const panes = await this.client.listPanes({ workspace });
      const paneSurfaces = await Promise.all(
        panes.panes.map((pane) =>
          this.client.listPaneSurfaces({
            workspace,
            pane: pane.ref,
          }),
        ),
      );
      const workerSurfaceIds = new Set(
        this.registry.list().map((agent) => agent.surface_id),
      );
      const placement = chooseAgentSpawnPlacement(
        panes.panes,
        paneSurfaces,
        workerSurfaceIds,
      );
      return placement.kind === "surface"
        ? this.client.newSurface({
            pane: placement.pane,
            type: "terminal",
            workspace,
          })
        : this.client.newSplit(placement.direction, {
            workspace,
            type: "terminal",
          });
    } catch {
      return this.client.newSplit("right", {
        workspace,
        type: "terminal",
      });
    }
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

        const surface = await this.createAgentSurface(agent.workspace_id ?? undefined);
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
        await this.client.send(surface.surface, resumeCmd, {
          workspace: surface.workspace,
        });
        await this.client.sendKey(surface.surface, "return", {
          workspace: surface.workspace,
        });
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
      const agent = await this.maybeCaptureBootSessionId(originalAgent);
      const { agent_id: agentId, repo, state, surface_id } = agent;
      const statusValue =
        state === "error" ? `${repo}: error` : `${repo}: ${state}`;

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

      // Status diff — only push if changed
      const prev = this.sidebarSnapshot.get(agentId);
      if (prev !== statusValue) {
        const sidebar = STATE_SIDEBAR[state];
        await this.client.setStatus(agentId, statusValue, {
          icon: sidebar.icon,
          color: sidebar.color,
          surface: surface_id,
        });
        this.sidebarSnapshot.set(agentId, statusValue);
      }

      // Quality tracking: check context usage for non-terminal agents
      // AIDEV-NOTE: Uses parseScreen for model-aware context_pct (handles Claude, Codex, Gemini).
      // Replaces legacy parseContextPercent which only matched "X% context" text patterns.
      if (!TERMINAL_STATES.has(state)) {
        try {
          const screen = await this.client.readScreen(surface_id, { lines: 5 });
          const parsed = parseScreen(screen.text);
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
    for (const [agentId] of this.sidebarSnapshot) {
      if (!currentAgentIds.has(agentId)) {
        try {
          await this.client.clearStatus(agentId);
        } catch {
          // Best-effort sidebar cleanup
        }
        this.sidebarSnapshot.delete(agentId);
      }
    }

    // Progress bar
    if (total > 0) {
      await this.client.setProgress(done / total, {
        label: `agents ${done}/${total}`,
      });
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
        this.sidebarSnapshot.set(id, "__purged__");
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
    }

    await this.spawnPreflight(params);

    // 1. Create cmux surface using the deterministic worker layout policy.
    const surface = await this.createAgentSurface(params.workspace);

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
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: params.max_cost_per_agent ?? null,
      crash_recover: params.crash_recover ?? false,
      respawn_attempts: 0,
      user_killed: false,
    };
    this.stateMgr.writeState(record);
    this.registry.set(agentId, record);

    // 3. Send launch command
    const launchCmd = buildLaunchCommand(params.cli, params.repo);
    await this.client.send(surface.surface, launchCmd, {
      workspace: surface.workspace,
    });
    await this.client.sendKey(surface.surface, "return", {
      workspace: surface.workspace,
    });

    return {
      agent_id: agentId,
      surface_id: surface.surface,
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

    // Retroactive check — already in target state?
    if (initial.state === targetState) {
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
        const current = this.registry.get(agentId);
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

        if (current.state === targetState) {
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
      let stopped = false;

      for (let attempt = 0; attempt < STOP_AGENT_RETRY_ATTEMPTS; attempt++) {
        for (const key of stopKeysForCli(agent.cli)) {
          await this.client.sendKey(agent.surface_id, key, {});
        }

        const screen = await this.client.readScreen(agent.surface_id, {
          lines: 40,
          scrollback: true,
        });
        if (screenShowsShellPrompt(screen.text)) {
          stopped = true;
          break;
        }

        if (attempt < STOP_AGENT_RETRY_ATTEMPTS - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, STOP_AGENT_RETRY_DELAY_MS),
          );
        }
      }

      if (!stopped) {
        throw new Error(
          `Agent "${agentId}" is still running after graceful stop attempts`,
        );
      }
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
    await this.client.send(route.surface_id, sanitizeTerminalInput(text), {});
    if (pressEnter) {
      await this.client.sendKey(route.surface_id, "return", {});
    }
  }
}
