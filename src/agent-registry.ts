/**
 * In-memory agent registry.
 * Reconstituted from state files + cmux surface list.
 * Reconciliation sweep detects orphaned/disappeared agents.
 */

import { StateManager } from "./state-manager.js";
import type { AgentRecord, AgentState } from "./agent-types.js";
import type { CmuxSurface } from "./types.js";

export type SurfaceProvider = () => Promise<CmuxSurface[]>;

export interface AgentFilter {
  state?: AgentState;
  repo?: string;
  model?: string;
}

const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);

export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();
  private stateMgr: StateManager;
  private surfaceProvider: SurfaceProvider;

  constructor(stateMgr: StateManager, surfaceProvider: SurfaceProvider) {
    this.stateMgr = stateMgr;
    this.surfaceProvider = surfaceProvider;
  }

  /**
   * Load all agent state from disk and cross-check against live surfaces.
   * Call once on startup.
   */
  async reconstitute(): Promise<void> {
    this.agents.clear();

    const stateFiles = this.stateMgr.listStates();
    for (const record of stateFiles) {
      this.agents.set(record.agent_id, record);
    }

    await this.reconcileSurfaces();
  }

  /**
   * Periodic reconciliation: cross-check in-memory state against
   * actual cmux surfaces and state files on disk.
   */
  async reconcile(): Promise<void> {
    // Pick up new state files created by other processes
    const onDisk = this.stateMgr.listStates();
    for (const record of onDisk) {
      const existing = this.agents.get(record.agent_id);
      if (!existing || existing.version < record.version) {
        this.agents.set(record.agent_id, record);
      }
    }

    await this.reconcileSurfaces();
  }

  private async reconcileSurfaces(): Promise<void> {
    const surfaces = await this.surfaceProvider();
    const liveSurfaceRefs = new Set(surfaces.map((s) => s.ref));

    for (const [id, agent] of this.agents) {
      if (TERMINAL_STATES.has(agent.state)) continue;

      if (!liveSurfaceRefs.has(agent.surface_id)) {
        // Orphan-on-crash: when a parent surface disappears, only THAT agent
        // transitions to error. Children are not affected because each child
        // has its own separate surface. This is intentional — children continue
        // running independently after a parent crash.
        const updated = this.stateMgr.transition(id, "error", {
          error: `Surface ${agent.surface_id} disappeared`,
        });
        this.agents.set(id, updated);
      }
    }
  }

  get(agentId: string): AgentRecord | null {
    return this.agents.get(agentId) ?? null;
  }

  list(filter?: AgentFilter): AgentRecord[] {
    let results = [...this.agents.values()];
    if (filter?.state) {
      results = results.filter((a) => a.state === filter.state);
    }
    if (filter?.repo) {
      results = results.filter((a) => a.repo === filter.repo);
    }
    if (filter?.model) {
      results = results.filter((a) => a.model === filter.model);
    }
    return results;
  }

  /**
   * Update an agent in the in-memory map. Used by tools that
   * write state through the StateManager and need to sync the registry.
   */
  set(agentId: string, record: AgentRecord): void {
    this.agents.set(agentId, record);
  }

  remove(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Get direct children of parentId.
   */
  getChildren(parentId: string): AgentRecord[] {
    return [...this.agents.values()].filter(
      (a) => a.parent_agent_id === parentId,
    );
  }

  /**
   * Get all agents in the subtree rooted at rootId (including root).
   * DFS post-order: children before root.
   */
  getSubtree(rootId: string): AgentRecord[] {
    const result: AgentRecord[] = [];
    const collect = (id: string) => {
      const children = this.getChildren(id);
      for (const child of children) {
        collect(child.agent_id);
      }
      const agent = this.agents.get(id);
      if (agent) result.push(agent);
    };
    collect(rootId);
    return result;
  }
}
