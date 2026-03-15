/**
 * Append-only event log for agent state transitions.
 * Format: JSONL (one JSON object per line).
 * Path: {baseDir}/events.jsonl
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StateTransition } from "./agent-types.js";

export class EventLog {
  private filePath: string;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, "events.jsonl");
    mkdirSync(baseDir, { recursive: true });
  }

  append(transition: StateTransition): void {
    const line = JSON.stringify(transition) + "\n";
    appendFileSync(this.filePath, line, "utf-8");
  }

  readAll(): StateTransition[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .map((line) => JSON.parse(line) as StateTransition);
  }

  readForAgent(agentId: string): StateTransition[] {
    return this.readAll().filter((t) => t.agent_id === agentId);
  }
}
