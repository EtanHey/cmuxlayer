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
} from "node:fs";
import { join } from "node:path";
import { EventLog } from "./event-log.js";
import {
  assertValidTransition,
  type AgentRecord,
  type AgentState,
  type StateTransition,
} from "./agent-types.js";

export class StateManager {
  private baseDir: string;
  private eventLog: EventLog;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.eventLog = new EventLog(baseDir);
    mkdirSync(baseDir, { recursive: true });
  }

  getEventLog(): EventLog {
    return this.eventLog;
  }

  writeState(record: AgentRecord): void {
    const agentDir = join(this.baseDir, record.agent_id);
    mkdirSync(agentDir, { recursive: true });

    const stateFile = join(agentDir, "state.json");
    const tmpFile = join(agentDir, "state.json.tmp");

    writeFileSync(tmpFile, JSON.stringify(record, null, 2), "utf-8");
    renameSync(tmpFile, stateFile);

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
    const stateFile = join(this.baseDir, agentId, "state.json");
    if (!existsSync(stateFile)) return null;
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8")) as AgentRecord;
    } catch {
      return null;
    }
  }

  transition(
    agentId: string,
    toState: AgentState,
    extra?: Partial<Pick<AgentRecord, "error" | "pid" | "cli_session_id">>,
  ): AgentRecord {
    const current = this.readState(agentId);
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
    };

    const agentDir = join(this.baseDir, agentId);
    const stateFile = join(agentDir, "state.json");
    const tmpFile = join(agentDir, "state.json.tmp");
    writeFileSync(tmpFile, JSON.stringify(updated, null, 2), "utf-8");
    renameSync(tmpFile, stateFile);

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

  listStates(): AgentRecord[] {
    if (!existsSync(this.baseDir)) return [];
    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const records: AgentRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const record = this.readState(entry.name);
      if (record) records.push(record);
    }
    return records;
  }

  removeState(agentId: string): void {
    const agentDir = join(this.baseDir, agentId);
    if (!existsSync(agentDir)) return;

    this.eventLog.append({
      ts: new Date().toISOString(),
      agent_id: agentId,
      event: "removed",
      from_state: this.readState(agentId)?.state ?? null,
      to_state: "done" as AgentState,
      surface_id: null,
      source: "removeState",
      error: null,
    });

    rmSync(agentDir, { recursive: true, force: true });
  }
}
