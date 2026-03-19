/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import { StateManager } from "./state-manager.js";
import { AgentRegistry, type AgentFilter } from "./agent-registry.js";
import type { CmuxNewSplitResult, CmuxReadScreenResult } from "./types.js";
import {
  generateAgentId,
  parseContextPercent,
  MAX_SPAWN_DEPTH,
  MAX_CHILDREN,
  type AgentRecord,
  type AgentState,
  type CliType,
  type WaitResult,
} from "./agent-types.js";

export interface SpawnAgentParams {
  repo: string;
  model: string;
  cli: CliType;
  prompt: string;
  workspace?: string;
  parent_agent_id?: string;
  max_cost_per_agent?: number;
}

export interface SpawnAgentResult {
  agent_id: string;
  surface_id: string;
  state: AgentState;
}

const INTERACTIVE_STATES = new Set<AgentState>(["ready", "idle"]);
const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);
const SWEEP_INTERVAL_MS = 1000;

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
    opts?: { workspace?: string },
  ): Promise<void>;
  sendKey(
    surface: string,
    key: string,
    opts?: { workspace?: string },
  ): Promise<void>;
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

/**
 * Build the shell command that launches a CLI agent.
 * Repo name is sanitized to prevent command injection.
 */
function buildLaunchCommand(cli: CliType, repo: string): string {
  const safeRepo = repo.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeRepo || safeRepo !== repo) {
    throw new Error(
      `Invalid repo name: "${repo}". Only alphanumeric, dots, hyphens, and underscores allowed.`,
    );
  }
  const cdCmd = `cd ~/Gits/${safeRepo}`;
  switch (cli) {
    case "claude":
      return `${cdCmd} && claude --dangerously-skip-permissions`;
    case "codex":
      return `${cdCmd} && codex`;
    case "gemini":
      return `${cdCmd} && gemini`;
    case "kiro":
      return `${cdCmd} && kiro-cli`;
    case "cursor":
      return `${cdCmd} && cursor agent`;
    default:
      return `${cdCmd} && ${cli}`;
  }
}

export class AgentEngine {
  private stateMgr: StateManager;
  private registry: AgentRegistry;
  private client: AgentEngineClient;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** agentId → last-pushed status string */
  private sidebarSnapshot = new Map<string, string>();
  /** e.g. "a1:spawned", "a1:done", "a1:error" */
  private loggedEvents = new Set<string>();

  constructor(
    stateMgr: StateManager,
    registry: AgentRegistry,
    client: AgentEngineClient,
  ) {
    this.stateMgr = stateMgr;
    this.registry = registry;
    this.client = client;
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /**
   * Sync sidebar: diff agents against snapshot, push only changes.
   * Logs lifecycle events (spawned, done, error) once each.
   */
  private async syncSidebar(): Promise<void> {
    const agents = this.registry.list();
    const total = agents.length;
    const done = agents.filter((a) => a.state === "done").length;

    for (const agent of agents) {
      const { agent_id: agentId, repo, state, surface_id } = agent;
      const statusValue =
        state === "error" ? `${repo}: error` : `${repo}: ${state}`;

      // Lifecycle log: spawned (first encounter)
      if (!this.sidebarSnapshot.has(agentId)) {
        if (!this.loggedEvents.has(`${agentId}:spawned`)) {
          await this.client.log(`spawned: ${repo}`, {
            level: "info",
            source: "cmux-mcp",
          });
          this.loggedEvents.add(`${agentId}:spawned`);
        }
      }

      // Lifecycle log: done
      if (state === "done" && !this.loggedEvents.has(`${agentId}:done`)) {
        await this.client.log(`done: ${repo}`, {
          level: "success",
          source: "cmux-mcp",
        });
        this.loggedEvents.add(`${agentId}:done`);
      }

      // Lifecycle log: error
      if (state === "error" && !this.loggedEvents.has(`${agentId}:error`)) {
        await this.client.log(`errored: ${repo}`, {
          level: "error",
          source: "cmux-mcp",
        });
        this.loggedEvents.add(`${agentId}:error`);
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
      if (!TERMINAL_STATES.has(state)) {
        try {
          const screen = await this.client.readScreen(surface_id, { lines: 5 });
          const contextPct = parseContextPercent(screen.text);
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
              await this.stopAgent(agentId, false);
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

    // Progress bar
    if (total > 0) {
      await this.client.setProgress(done / total, {
        label: `agents ${done}/${total}`,
      });
    }
  }

  /**
   * Public sweep: reconcile registry then sync sidebar.
   */
  async runSweep(): Promise<void> {
    await this.registry.reconcile();
    await this.syncSidebar();
  }

  /**
   * Start the reconciliation sweep on an interval.
   */
  startSweep(intervalMs: number = 5000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.runSweep().catch(() => {
        // Sweep errors are non-fatal — next sweep will retry
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

    // 1. Create cmux surface
    const surface = await this.client.newSplit("right", {
      workspace: params.workspace,
      type: "terminal",
    });

    // 2. Write initial state (creating → booting)
    const now = new Date().toISOString();
    const record: AgentRecord = {
      agent_id: agentId,
      surface_id: surface.surface,
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
      };
    }

    // Already in terminal error state and target isn't error?
    if (initial.state === "error" && targetState !== "error") {
      return {
        matched: false,
        state: initial.state,
        elapsed: Date.now() - start,
        source: "immediate",
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

  /**
   * List agents with optional filters.
   */
  listAgents(filter?: AgentFilter): AgentRecord[] {
    return this.registry.list(filter);
  }

  /**
   * Stop an agent gracefully (Ctrl+C) or forcefully (kill PID).
   */
  async stopAgent(agentId: string, force?: boolean): Promise<void> {
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    if (TERMINAL_STATES.has(agent.state)) {
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
      await this.client.sendKey(agent.surface_id, "c-c", {});
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

    await this.client.send(agent.surface_id, text, {});
    if (pressEnter) {
      await this.client.sendKey(agent.surface_id, "return", {});
    }
  }
}
