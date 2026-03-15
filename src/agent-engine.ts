/**
 * AgentEngine — composable internals for agent lifecycle management.
 * These 7 functions are the engine that MCP tools (and later the 2-tool facade) drive.
 */

import { StateManager } from "./state-manager.js";
import { AgentRegistry, type AgentFilter } from "./agent-registry.js";
import type { CmuxClient } from "./cmux-client.js";
import {
  generateAgentId,
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
}

export interface SpawnAgentResult {
  agent_id: string;
  surface_id: string;
  state: AgentState;
}

const INTERACTIVE_STATES = new Set<AgentState>(["ready", "idle"]);
const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);
const SWEEP_INTERVAL_MS = 1000;

/**
 * Build the shell command that launches a CLI agent.
 */
function buildLaunchCommand(cli: CliType, repo: string): string {
  const cdCmd = `cd ~/Gits/${repo}`;
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
  private client: CmuxClient;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    stateMgr: StateManager,
    registry: AgentRegistry,
    client: CmuxClient,
  ) {
    this.stateMgr = stateMgr;
    this.registry = registry;
    this.client = client;
  }

  getRegistry(): AgentRegistry {
    return this.registry;
  }

  /**
   * Start the reconciliation sweep on an interval.
   */
  startSweep(intervalMs: number = 5000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.registry.reconcile().catch(() => {
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
