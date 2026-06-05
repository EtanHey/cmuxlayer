/**
 * In-memory agent registry.
 * Reconstituted from state files + cmux surface list.
 * Reconciliation sweep detects orphaned/disappeared agents.
 */

import { StateManager } from "./state-manager.js";
import {
  AgentDiscovery,
  discoveredStatusToAgentState,
  inferRepoFromTitle,
  makeAutoAgentId,
  type DiscoveredAgent,
} from "./agent-discovery.js";
import {
  type MergedAgent,
  isCrashRecoveryEligible,
  shouldRetainCrashRecoveryError,
  type AgentRecord,
  type AgentState,
} from "./agent-types.js";
import type { CmuxSurface } from "./types.js";

export type SurfaceProvider = () => Promise<CmuxSurface[]>;

export interface AgentFilter {
  state?: AgentState;
  repo?: string;
  model?: string;
}

const TERMINAL_STATES = new Set<AgentState>(["done", "error"]);
const BOOTING_GHOST_TIMEOUT_MS = 30_000;

class AgentNotFoundError extends Error {
  readonly code = "AGENT_NOT_FOUND";
  readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
    this.agentId = agentId;
  }
}

export class AgentRegistry {
  private agents = new Map<string, AgentRecord>();
  private aliases = new Map<string, string>();
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
    this.aliases.clear();

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

    // Phase 1: Mark agents with disappeared surfaces as error
    const crashedIds = new Set<string>();
    for (const [id, agent] of this.agents) {
      if (TERMINAL_STATES.has(agent.state)) continue;

      if (!liveSurfaceRefs.has(agent.surface_id)) {
        try {
          const updated = this.stateMgr.transition(id, "error", {
            error: `Surface ${agent.surface_id} disappeared`,
          });
          this.agents.set(id, updated);
          crashedIds.add(id);
        } catch (error) {
          if (this.evictMissingStateAgent(id)) {
            crashedIds.add(id);
            continue;
          }
          throw error;
        }
      }
    }

    // Phase 2: Reparent orphans — children of crashed agents get parent_agent_id=null.
    // Children keep running independently (orphan survival), but are detached from
    // the dead parent so getSubtree on the dead parent no longer includes them.
    if (crashedIds.size > 0) {
      for (const [id, agent] of this.agents) {
        if (agent.parent_agent_id && crashedIds.has(agent.parent_agent_id)) {
          try {
            const reparented = this.stateMgr.updateRecord(id, {
              parent_agent_id: null,
            });
            this.agents.set(id, reparented);
          } catch (error) {
            if (this.evictMissingStateAgent(id)) {
              continue;
            }
            throw error;
          }
        }
      }
    }
  }

  private resolveAlias(agentId: string): string {
    let current = agentId;
    const seen = new Set<string>();
    while (this.aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.aliases.get(current)!;
    }
    return current;
  }

  private aliasesResolvingTo(agentId: string): string[] {
    const aliases: string[] = [];
    for (const [alias, target] of this.aliases) {
      if (
        alias === agentId ||
        target === agentId ||
        this.resolveAlias(alias) === agentId
      ) {
        aliases.push(alias);
      }
    }
    return aliases;
  }

  private deleteAgentAndAliases(agentId: string): string {
    const resolved = this.resolveAlias(agentId);
    const aliases = this.aliasesResolvingTo(resolved);
    this.agents.delete(resolved);
    this.aliases.delete(agentId);
    this.aliases.delete(resolved);
    for (const alias of aliases) {
      this.aliases.delete(alias);
    }
    return resolved;
  }

  get(agentId: string): AgentRecord | null {
    return this.agents.get(this.resolveAlias(agentId)) ?? null;
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

  async listMerged(
    discovery: AgentDiscovery,
    opts?: { filter?: AgentFilter; force?: boolean },
  ): Promise<MergedAgent[]> {
    await this.reconcile();
    await this.purgeTerminal();

    const discovered = await discovery.scan(opts?.force ?? false);
    await this.evictBootingGhosts(discovered);

    const bySurface = new Map(discovered.map((entry) => [entry.surface_id, entry]));
    const merged: MergedAgent[] = [];
    const seenSurfaces = new Set<string>();

    for (const record of this.list()) {
      const discoveredEntry = bySurface.get(record.surface_id);
      const isAutoRecord = record.agent_id.startsWith("auto-");

      if (
        isAutoRecord &&
        discoveredEntry &&
        !discoveredEntry.read_error &&
        !discoveredEntry.has_agent
      ) {
        const removedAgentId = this.deleteAgentAndAliases(record.agent_id);
        this.stateMgr.removeState(removedAgentId);
        continue;
      }

      let liveRecord: AgentRecord | null = record;
      if (
        isAutoRecord &&
        discoveredEntry &&
        discoveredEntry.has_agent &&
        !discoveredEntry.read_error
      ) {
        liveRecord = this.syncAutoRecord(record, discoveredEntry);
        if (!liveRecord) {
          continue;
        }
      }

      seenSurfaces.add(record.surface_id);
      merged.push({
        ...liveRecord,
        discovered: isAutoRecord,
        parsed_cli_mismatch:
          !isAutoRecord &&
          discoveredEntry !== undefined &&
          discoveredEntry.cli !== "unknown" &&
          discoveredEntry.cli !== record.cli,
      });
    }

    for (const discoveredEntry of discovered) {
      if (
        !discoveredEntry.has_agent ||
        discoveredEntry.cli === "unknown" ||
        discoveredEntry.read_error
      ) {
        continue;
      }
      if (seenSurfaces.has(discoveredEntry.surface_id)) {
        continue;
      }

      const agentId = makeAutoAgentId(
        discoveredEntry.cli,
        discoveredEntry.surface_id,
      );
      const record = this.stateMgr.ensureAutoRecord(agentId, discoveredEntry);
      this.agents.set(agentId, record);
      const liveRecord = this.syncAutoRecord(record, discoveredEntry);
      if (!liveRecord) {
        continue;
      }

      merged.push({
        ...liveRecord,
        discovered: true,
        parsed_cli_mismatch: false,
      });
    }

    const filtered = opts?.filter
      ? merged.filter((agent) => {
          if (opts.filter?.state && agent.state !== opts.filter.state) {
            return false;
          }
          if (opts.filter?.repo && agent.repo !== opts.filter.repo) {
            return false;
          }
          if (opts.filter?.model && agent.model !== opts.filter.model) {
            return false;
          }
          return true;
        })
      : merged;

    return filtered;
  }

  /**
   * Sync an auto-discovered record with the latest parsed surface state.
   *
   * Metadata patches go through updateRecord and are treated as hard errors:
   * if they fail for anything other than a missing state file, callers should
   * see the failure rather than silently continuing. Synthetic transitions are
   * best-effort only because parser snapshots can temporarily lag behind the
   * persisted state machine.
   */
  private syncAutoRecord(
    record: AgentRecord,
    discoveredEntry: DiscoveredAgent,
  ): AgentRecord | null {
    const agentId = record.agent_id;
    const repo = inferRepoFromTitle(discoveredEntry.surface_title) || record.repo;
    const model = discoveredEntry.model ?? record.model;
    const workspaceId = discoveredEntry.workspace_id ?? null;
    const desiredState = discoveredStatusToAgentState(
      discoveredEntry.parsed_status,
    );

    const patch: Partial<AgentRecord> = {};
    if (repo !== record.repo) patch.repo = repo;
    if (model !== record.model) patch.model = model;
    if ((record.workspace_id ?? null) !== workspaceId) {
      patch.workspace_id = workspaceId;
    }
    if (record.error !== null && desiredState !== "error") patch.error = null;
    if (record.error === null && desiredState === "error") {
      patch.error = "Auto-discovered agent reported a frozen state";
    }

    if (Object.keys(patch).length > 0) {
      try {
        record = this.stateMgr.updateRecord(agentId, patch);
        this.agents.set(agentId, record);
      } catch (error) {
        if (this.evictMissingStateAgent(agentId)) {
          return null;
        }
        throw error;
      }
    }

    if (record.state !== desiredState) {
      try {
        record = this.stateMgr.transition(agentId, desiredState, {
          error:
            desiredState === "error"
              ? "Auto-discovered agent reported a frozen state"
              : null,
        });
        this.agents.set(agentId, record);
      } catch (error) {
        if (this.evictMissingStateAgent(agentId)) {
          return null;
        }
        // Best-effort only — invalid synthetic transitions can keep the prior state.
      }
    }

    return record;
  }

  /**
   * Update an agent in the in-memory map. Used by tools that
   * write state through the StateManager and need to sync the registry.
   */
  set(agentId: string, record: AgentRecord): void {
    const resolved = this.resolveAlias(agentId);
    if (resolved !== agentId && record.agent_id === resolved) {
      this.agents.set(resolved, record);
      return;
    }
    if (agentId !== record.agent_id) {
      this.aliases.set(agentId, record.agent_id);
    }
    this.agents.set(record.agent_id, record);
  }

  rename(oldAgentId: string, newAgentId: string, record: AgentRecord): void {
    this.agents.delete(oldAgentId);
    for (const [alias, target] of this.aliases) {
      if (target === oldAgentId) {
        this.aliases.set(alias, newAgentId);
      }
    }
    for (const [id, agent] of this.agents) {
      if (agent.parent_agent_id === oldAgentId) {
        this.agents.set(id, { ...agent, parent_agent_id: newAgentId });
      }
    }
    this.aliases.set(oldAgentId, newAgentId);
    this.agents.set(newAgentId, record);
  }

  remove(agentId: string): void {
    this.deleteAgentAndAliases(agentId);
  }

  private evictMissingStateAgent(agentId: string): boolean {
    if (this.getMissingStateSentinel(agentId) === null) {
      return false;
    }

    const removedAgentId = this.deleteAgentAndAliases(agentId);
    this.stateMgr.removeState(removedAgentId);
    return true;
  }

  private getMissingStateSentinel(agentId: string): AgentNotFoundError | null {
    if (this.stateMgr.readState(agentId) !== null) {
      return null;
    }

    return new AgentNotFoundError(agentId);
  }

  private async evictBootingGhosts(
    discovered: DiscoveredAgent[],
  ): Promise<void> {
    const now = Date.now();
    const bySurface = new Map(discovered.map((entry) => [entry.surface_id, entry]));

    for (const [id, agent] of [...this.agents.entries()]) {
      if (agent.state !== "booting") {
        continue;
      }

      const lastUpdated = Date.parse(agent.updated_at);
      if (Number.isNaN(lastUpdated)) {
        continue;
      }
      if (now - lastUpdated < BOOTING_GHOST_TIMEOUT_MS) {
        continue;
      }

      const discoveredEntry = bySurface.get(agent.surface_id);
      if (
        !discoveredEntry ||
        discoveredEntry.read_error ||
        discoveredEntry.has_agent
      ) {
        continue;
      }

      try {
        this.stateMgr.transition(id, "error", {
          error: "Launch failed — no agent detected in surface after boot timeout",
        });
      } catch {
        // Best-effort transition before eviction.
      }

      const removedAgentId = this.deleteAgentAndAliases(id);
      this.stateMgr.removeState(removedAgentId);
    }
  }

  /**
   * Startup purge: remove ALL terminal-state agents (done/error) unconditionally.
   * Called after reconstitute() to clear stale entries from previous cmux sessions.
   *
   * More aggressive than purgeTerminal() because it doesn't check surface existence:
   * after cmux restart, surface refs get recycled (surface:3 in a new session
   * ≠ surface:3 from before), so a live surface ref doesn't mean the agent is alive.
   *
   * Non-terminal agents with dead surfaces are already handled by reconcileSurfaces()
   * (marked as error during reconstitute), then caught here as terminal.
   *
   * Returns the IDs of purged agents for sidebar cleanup.
   */
  purgeAllTerminal(): string[] {
    const purgedIds: string[] = [];

    for (const [id, agent] of this.agents) {
      if (shouldRetainCrashRecoveryError(agent)) {
        continue;
      }
      if (TERMINAL_STATES.has(agent.state)) {
        const removedAgentId = this.deleteAgentAndAliases(id);
        this.stateMgr.removeState(removedAgentId);
        purgedIds.push(removedAgentId);
      }
    }

    return purgedIds;
  }

  /**
   * Purge terminal-state agents (done/error) whose surface no longer exists.
   * Used by the periodic sweep — less aggressive than purgeStale().
   * Agents whose surface is still alive are kept (user may want to inspect output).
   */
  async purgeTerminal(): Promise<number> {
    const surfaces = await this.surfaceProvider();
    const liveSurfaceRefs = new Set(surfaces.map((s) => s.ref));
    let purged = 0;

    for (const [id, agent] of this.agents) {
      if (shouldRetainCrashRecoveryError(agent)) {
        continue;
      }
      if (
        TERMINAL_STATES.has(agent.state) &&
        !liveSurfaceRefs.has(agent.surface_id)
      ) {
        const removedAgentId = this.deleteAgentAndAliases(id);
        this.stateMgr.removeState(removedAgentId);
        purged++;
      }
    }

    return purged;
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
    const visited = new Set<string>();
    const root = this.get(rootId);
    if (!root) {
      return result;
    }
    const collect = (id: string) => {
      if (visited.has(id)) return; // Prevent cycles from corrupted state
      visited.add(id);
      const children = this.getChildren(id);
      for (const child of children) {
        collect(child.agent_id);
      }
      const agent = this.agents.get(id);
      if (agent) result.push(agent);
    };
    collect(root.agent_id);
    return result;
  }
}
