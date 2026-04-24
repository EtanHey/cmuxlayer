/**
 * Append-only event log for agent state transitions and delivery telemetry.
 * Format: JSONL (one JSON object per line).
 * Path: {baseDir}/events.jsonl
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  DeliveryTelemetryEvent,
  EventLogEntry,
  StateTransition,
} from "./agent-types.js";

export class EventLog {
  private filePath: string;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, "events.jsonl");
    mkdirSync(baseDir, { recursive: true });
  }

  append(transition: StateTransition): void {
    this.appendEntry(transition);
  }

  appendDelivery(event: DeliveryTelemetryEvent): void {
    this.appendEntry(event);
  }

  readAll(): StateTransition[] {
    return this.readEntries().filter(
      (entry): entry is StateTransition => "agent_id" in entry,
    );
  }

  readEntries(): EventLogEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .map((line) => JSON.parse(line) as EventLogEntry);
  }

  readForAgent(agentId: string): StateTransition[] {
    return this.readAll().filter((entry) => entry.agent_id === agentId);
  }

  private appendEntry(entry: EventLogEntry): void {
    const line = JSON.stringify(entry) + "\n";
    appendFileSync(this.filePath, line, "utf-8");
  }
}
