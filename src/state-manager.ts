/**
 * State file manager — reads/writes per-agent state files.
 * Atomic writes via rename pattern. All transitions logged to EventLog.
 * Path: {baseDir}/{agentId}/state.json
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  existsSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";
import { EventLog } from "./event-log.js";
import {
  assertValidTransition,
  type AgentRecord,
  type AgentRole,
  type AgentState,
  type StateTransition,
} from "./agent-types.js";
import {
  discoveredStatusToAgentState,
  inferRepoFromTitle,
  type DiscoveredAgent,
} from "./agent-discovery.js";

type AgentRecordPatch = Partial<
  Omit<AgentRecord, "agent_id" | "created_at" | "updated_at" | "version" | "state">
>;

export interface SurfaceSessionIndexEntry {
  agent_id: string;
  workspace_id: string | null;
  surface_id: string;
  cli_session_id: string;
  updated_at: string;
}

export interface SurfaceSessionLookupKey {
  workspace_id?: string | null;
  surface_id: string;
}

export type SurfaceSessionRouteState = "ready" | "stale_surface";

export function classifySurfaceSessionRoute(input: {
  agent: AgentRecord;
  index_entry: SurfaceSessionIndexEntry | null;
  live_surface_refs: string[];
}): SurfaceSessionRouteState {
  if (!input.live_surface_refs.includes(input.agent.surface_id)) {
    return "stale_surface";
  }

  const entry = input.index_entry;
  if (!entry) {
    return input.agent.cli_session_id ? "stale_surface" : "ready";
  }

  const agentWorkspaceId = input.agent.workspace_id ?? null;
  if (
    entry.agent_id !== input.agent.agent_id ||
    entry.workspace_id !== agentWorkspaceId ||
    entry.surface_id !== input.agent.surface_id ||
    entry.cli_session_id !== input.agent.cli_session_id
  ) {
    return "stale_surface";
  }

  return "ready";
}

interface SurfaceSessionIndexFile {
  version: 1;
  by_agent_id: Record<string, SurfaceSessionIndexEntry>;
}

export class SurfaceSessionIndex {
  private indexPath: string;

  constructor(private baseDir: string) {
    this.indexPath = join(baseDir, "surface-session-index.json");
  }

  private readIndex(): SurfaceSessionIndexFile {
    if (!existsSync(this.indexPath)) {
      return { version: 1, by_agent_id: {} };
    }
    try {
      const parsed = JSON.parse(
        readFileSync(this.indexPath, "utf-8"),
      ) as SurfaceSessionIndexFile;
      return {
        version: 1,
        by_agent_id: parsed.by_agent_id ?? {},
      };
    } catch {
      return { version: 1, by_agent_id: {} };
    }
  }

  private writeIndex(index: SurfaceSessionIndexFile): void {
    mkdirSync(this.baseDir, { recursive: true });
    const tmpFile = join(this.baseDir, "surface-session-index.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(index, null, 2), "utf-8");
    renameSync(tmpFile, this.indexPath);
  }

  persist(input: {
    workspace_id?: string | null;
    surface_id: string;
    cli_session_id: string;
    agent_id: string;
  }): SurfaceSessionIndexEntry {
    const index = this.readIndex();
    const entry: SurfaceSessionIndexEntry = {
      agent_id: input.agent_id,
      workspace_id: input.workspace_id ?? null,
      surface_id: input.surface_id,
      cli_session_id: input.cli_session_id,
      updated_at: new Date().toISOString(),
    };
    index.by_agent_id[input.agent_id] = entry;
    this.writeIndex(index);
    return entry;
  }

  persistRecord(record: AgentRecord): SurfaceSessionIndexEntry | null {
    if (!record.cli_session_id) return null;
    return this.persist({
      workspace_id: record.workspace_id ?? null,
      surface_id: record.surface_id,
      cli_session_id: record.cli_session_id,
      agent_id: record.agent_id,
    });
  }

  removeAgent(agentId: string): void {
    const index = this.readIndex();
    if (!index.by_agent_id[agentId]) return;
    delete index.by_agent_id[agentId];
    this.writeIndex(index);
  }

  lookup(key: SurfaceSessionLookupKey): SurfaceSessionIndexEntry | null {
    const workspaceId = key.workspace_id ?? null;
    const matches = Object.values(this.readIndex().by_agent_id).filter(
      (entry) =>
        entry.workspace_id === workspaceId && entry.surface_id === key.surface_id,
    );
    matches.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    if (matches.length > 1) {
      const newestTime = new Date(matches[0].updated_at).getTime();
      const tiedNewest = matches.filter(
        (entry) => new Date(entry.updated_at).getTime() === newestTime,
      );
      const distinctNewest = new Set(
        tiedNewest.map(
          (entry) => `${entry.agent_id}\u0000${entry.cli_session_id}`,
        ),
      );
      if (distinctNewest.size > 1) {
        return null;
      }
    }
    return matches[0] ?? null;
  }
}

export class StateManager {
  private baseDir: string;
  private eventLog: EventLog;
  private surfaceSessionIndex: SurfaceSessionIndex;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.eventLog = new EventLog(baseDir);
    this.surfaceSessionIndex = new SurfaceSessionIndex(baseDir);
    mkdirSync(baseDir, { recursive: true });
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getEventLog(): EventLog {
    return this.eventLog;
  }

  getSurfaceSessionIndex(): SurfaceSessionIndex {
    return this.surfaceSessionIndex;
  }

  private stateFilePath(dirName: string): string {
    return join(this.baseDir, dirName, "state.json");
  }

  private readStateFromDir(dirName: string): AgentRecord | null {
    const stateFile = this.stateFilePath(dirName);
    if (!existsSync(stateFile)) return null;
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8")) as AgentRecord;
    } catch {
      return null;
    }
  }

  private resolveStateDir(agentId: string): string | null {
    if (existsSync(this.stateFilePath(agentId))) {
      return agentId;
    }
    if (!existsSync(this.baseDir)) {
      return null;
    }

    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === agentId) continue;
      const record = this.readStateFromDir(entry.name);
      if (record?.agent_id === agentId) {
        return entry.name;
      }
    }

    return null;
  }

  writeState(record: AgentRecord): void {
    const agentDir = join(this.baseDir, record.agent_id);
    mkdirSync(agentDir, { recursive: true });

    const stateFile = this.stateFilePath(record.agent_id);
    const tmpFile = join(agentDir, "state.json.tmp");

    writeFileSync(tmpFile, JSON.stringify(record, null, 2), "utf-8");
    renameSync(tmpFile, stateFile);
    this.surfaceSessionIndex.persistRecord(record);

    this.eventLog.append({
      ts: new Date().toISOString(),
      agent_id: record.agent_id,
      event: "created",
      from_state: null,
      to_state: record.state,
      surface_id: record.surface_id,
      source: "writeState",
      error: null,
    });
  }

  readState(agentId: string): AgentRecord | null {
    const dirName = this.resolveStateDir(agentId);
    return dirName ? this.readStateFromDir(dirName) : null;
  }

  hasStateFile(agentId: string): boolean {
    const readStrict = (dirName: string): string | null => {
      try {
        return readFileSync(this.stateFilePath(dirName), "utf-8");
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : null;
        if (code === "ENOENT" || code === "ENOTDIR") {
          return null;
        }
        throw error;
      }
    };

    if (readStrict(agentId) !== null) {
      return true;
    }

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(this.baseDir, { withFileTypes: true });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : null;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return false;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === agentId) continue;
      const raw = readStrict(entry.name);
      if (raw === null) continue;
      const record = JSON.parse(raw) as AgentRecord;
      if (record.agent_id === agentId) {
        return true;
      }
    }
    return false;
  }

  transition(
    agentId: string,
    toState: AgentState,
    extra?: Partial<
      Pick<AgentRecord, "error" | "pid" | "cli_session_id" | "cli_session_path">
    >,
  ): AgentRecord {
    const dirName = this.resolveStateDir(agentId);
    const current = dirName ? this.readStateFromDir(dirName) : null;
    if (!current) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    assertValidTransition(current.state, toState);

    const updated: AgentRecord = {
      ...current,
      state: toState,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
      ...(extra?.error !== undefined ? { error: extra.error } : {}),
      ...(extra?.pid !== undefined ? { pid: extra.pid } : {}),
      ...(extra?.cli_session_id !== undefined
        ? { cli_session_id: extra.cli_session_id }
        : {}),
      ...(extra?.cli_session_path !== undefined
        ? { cli_session_path: extra.cli_session_path }
        : {}),
    };

    const agentDir = join(this.baseDir, dirName!);
    const stateFile = this.stateFilePath(dirName!);
    const tmpFile = join(agentDir, "state.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(updated, null, 2), "utf-8");
    renameSync(tmpFile, stateFile);
    this.surfaceSessionIndex.persistRecord(updated);

    const transition: StateTransition = {
      ts: updated.updated_at,
      agent_id: agentId,
      event: toState === "error" ? "error" : "transition",
      from_state: current.state,
      to_state: toState,
      surface_id: current.surface_id,
      source: "transition",
      error: extra?.error ?? null,
    };
    this.eventLog.append(transition);

    return updated;
  }

  /**
   * Update arbitrary non-state fields on an agent record without transition validation.
   */
  updateRecord(agentId: string, fields: AgentRecordPatch): AgentRecord {
    const dirName = this.resolveStateDir(agentId);
    const current = dirName ? this.readStateFromDir(dirName) : null;
    if (!current) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const updated: AgentRecord = {
      ...current,
      ...fields,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
    };

    const agentDir = join(this.baseDir, dirName!);
    const stateFile = this.stateFilePath(dirName!);
    const tmpFile = join(agentDir, "state.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(updated, null, 2), "utf-8");
    renameSync(tmpFile, stateFile);
    this.surfaceSessionIndex.persistRecord(updated);

    this.eventLog.append({
      ts: updated.updated_at,
      agent_id: agentId,
      event: "transition",
      from_state: current.state,
      to_state: current.state,
      surface_id: updated.surface_id,
      source: "updateRecord",
      error: null,
    });

    return updated;
  }

  /**
   * Persist the startup transcript-capture retry marker without refreshing
   * lifecycle age. The marker is bookkeeping, not agent progress.
   */
  setTranscriptSessionCaptureDeferred(
    agentId: string,
    deferred: boolean,
  ): AgentRecord {
    const dirName = this.resolveStateDir(agentId);
    const current = dirName ? this.readStateFromDir(dirName) : null;
    if (!current) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (current.transcript_session_capture_deferred === deferred) {
      return current;
    }

    const updated: AgentRecord = {
      ...current,
      transcript_session_capture_deferred: deferred,
    };
    const agentDir = join(this.baseDir, dirName!);
    const stateFile = this.stateFilePath(dirName!);
    const tmpFile = join(agentDir, "state.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(updated, null, 2), "utf-8");
    renameSync(tmpFile, stateFile);
    this.surfaceSessionIndex.persistRecord(updated);
    return updated;
  }

  /**
   * Explicitly reset an agent's lifecycle state after an operation that has
   * already established new ground truth outside the normal state machine.
   * This bypass is intentionally separate from transition().
   */
  resetState(
    agentId: string,
    toState: AgentState,
    fields: AgentRecordPatch,
    source: string,
  ): AgentRecord {
    const dirName = this.resolveStateDir(agentId);
    const current = dirName ? this.readStateFromDir(dirName) : null;
    if (!current) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const updated: AgentRecord = {
      ...current,
      ...fields,
      state: toState,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
    };

    const agentDir = join(this.baseDir, dirName!);
    const stateFile = this.stateFilePath(dirName!);
    const tmpFile = join(agentDir, "state.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(updated, null, 2), "utf-8");
    renameSync(tmpFile, stateFile);
    this.surfaceSessionIndex.persistRecord(updated);

    this.eventLog.append({
      ts: updated.updated_at,
      agent_id: agentId,
      event: toState === "error" ? "error" : "transition",
      from_state: current.state,
      to_state: toState,
      surface_id: updated.surface_id,
      source,
      error: fields.error ?? null,
    });

    return updated;
  }

  renameState(agentId: string, newAgentId: string): AgentRecord {
    if (agentId === newAgentId) {
      const current = this.readState(agentId);
      if (!current) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return current;
    }

    const dirName = this.resolveStateDir(agentId);
    const current = dirName ? this.readStateFromDir(dirName) : null;
    if (!current) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (this.readState(newAgentId)) {
      throw new Error(`Agent already exists: ${newAgentId}`);
    }

    const updated: AgentRecord = {
      ...current,
      agent_id: newAgentId,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
    };

    const newAgentDir = join(this.baseDir, newAgentId);
    mkdirSync(newAgentDir, { recursive: true });
    const stateFile = this.stateFilePath(newAgentId);
    const tmpFile = join(newAgentDir, "state.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(updated, null, 2), "utf-8");
    renameSync(tmpFile, stateFile);
    this.surfaceSessionIndex.persistRecord(updated);
    this.surfaceSessionIndex.removeAgent(agentId);

    rmSync(join(this.baseDir, dirName!), { recursive: true, force: true });

    this.eventLog.append({
      ts: updated.updated_at,
      agent_id: newAgentId,
      event: "transition",
      from_state: current.state,
      to_state: current.state,
      surface_id: updated.surface_id,
      source: `renameState:${agentId}`,
      error: null,
    });

    for (const child of this.listStates()) {
      if (child.parent_agent_id === agentId) {
        this.updateRecord(child.agent_id, { parent_agent_id: newAgentId });
      }
    }

    return updated;
  }

  listStates(): AgentRecord[] {
    if (!existsSync(this.baseDir)) return [];
    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const records: AgentRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = this.readStateFromDir(entry.name);
      if (record) records.push(record);
    }
    return records;
  }

  removeState(agentId: string): void {
    const dirName = this.resolveStateDir(agentId);
    if (!dirName) return;

    const agentDir = join(this.baseDir, dirName);
    const current = this.readStateFromDir(dirName);

    this.eventLog.append({
      ts: new Date().toISOString(),
      agent_id: agentId,
      event: "removed",
      from_state: current?.state ?? null,
      to_state: "done" as AgentState,
      surface_id: null,
      source: "removeState",
      error: null,
    });

    rmSync(agentDir, { recursive: true, force: true });
  }

  ensureAutoRecord(
    agentId: string,
    discovered: DiscoveredAgent,
    surfaceObserverId?: string | null,
    explicitRole?: AgentRole | null,
  ): AgentRecord {
    const existing = this.readState(agentId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const record: AgentRecord = {
      agent_id: agentId,
      surface_id: discovered.surface_id,
      surface_uuid: discovered.surface_uuid ?? null,
      surface_observer_id: surfaceObserverId?.trim() || null,
      surface_provenance: "unknown",
      workspace_id: discovered.workspace_id ?? null,
      state: discoveredStatusToAgentState(discovered.parsed_status),
      repo: inferRepoFromTitle(discovered.surface_title),
      model: discovered.model ?? "unknown",
      cli: discovered.cli === "unknown" ? "claude" : discovered.cli,
      cli_session_id: null,
      cli_session_path: null,
      task_summary: "(auto-discovered)",
      pid: null,
      version: 1,
      created_at: now,
      updated_at: now,
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      role:
        explicitRole ??
        (discovered.cli === "claude"
          ? "orchestrator"
          : discovered.cli === "unknown"
            ? "orchestrator"
            : "worker"),
      auto_archive_on_done: false,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    };
    this.writeState(record);
    return record;
  }
}
