/**
 * Append-only event log for agent state transitions and delivery telemetry.
 * Format: JSONL (one JSON object per line).
 * Path: {baseDir}/events.jsonl
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CloseForensicsEvent,
  CloseTelemetryEvent,
  ControlHealthTelemetryEvent,
  DeliveryTelemetryEvent,
  EventLogEntry,
  StateTransition,
} from "./agent-types.js";

export const DEFAULT_EVENT_LOG_MAX_READ_BYTES = 1024 * 1024;
export const DEFAULT_EVENT_LOG_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_ROTATED_SEGMENTS = 2;

export interface EventLogOptions {
  maxReadBytes?: number;
  maxFileBytes?: number;
  rotatedSegments?: number;
}

export class EventLog {
  private filePath: string;
  private maxReadBytes: number;
  private maxFileBytes: number;
  private rotatedSegments: number;

  constructor(baseDir: string, options: EventLogOptions = {}) {
    this.filePath = join(baseDir, "events.jsonl");
    this.maxReadBytes = positiveInt(
      options.maxReadBytes,
      envInt("CMUX_EVENT_LOG_MAX_READ_BYTES"),
      DEFAULT_EVENT_LOG_MAX_READ_BYTES,
    );
    this.maxFileBytes = positiveInt(
      options.maxFileBytes,
      envInt("CMUX_EVENT_LOG_MAX_FILE_BYTES"),
      DEFAULT_EVENT_LOG_MAX_FILE_BYTES,
    );
    this.rotatedSegments = positiveInt(
      options.rotatedSegments,
      envInt("CMUX_EVENT_LOG_ROTATED_SEGMENTS"),
      DEFAULT_EVENT_LOG_ROTATED_SEGMENTS,
    );
    mkdirSync(baseDir, { recursive: true });
  }

  append(transition: StateTransition): void {
    this.appendEntry(transition);
  }

  appendDelivery(event: DeliveryTelemetryEvent): void {
    this.appendEntry(event);
  }

  appendControlHealth(event: ControlHealthTelemetryEvent): void {
    this.appendEntry(event);
  }

  /**
   * Record a surface close / agent kill-or-stop with its caller. Lands in the
   * same events.jsonl as every other telemetry entry so forensics read one log.
   */
  appendClose(event: CloseTelemetryEvent): void {
    this.appendEntry(event);
  }

  /**
   * Record an ATTRIBUTED app-level close (cmux `tab_close`/`workspace_teardown`
   * that carries no actor) into the same events.jsonl. Mirrors {@link appendClose}
   * so a pane-death investigation still reads one log -- now including the deaths
   * that never went through an MCP tool. See {@link CloseForensicsEvent}.
   */
  appendCloseForensics(event: CloseForensicsEvent): void {
    this.appendEntry(event);
  }

  readAll(): StateTransition[] {
    return this.readEntries().filter(
      (entry): entry is StateTransition => "agent_id" in entry,
    );
  }

  readEntries(): EventLogEntry[] {
    return this.readBoundedEntries();
  }

  readForAgent(agentId: string): StateTransition[] {
    return this.readAll().filter((entry) => entry.agent_id === agentId);
  }

  readCloseEvents(): CloseTelemetryEvent[] {
    return this.readBoundedEntries().filter(
      (entry): entry is CloseTelemetryEvent =>
        (entry as { event_type?: string }).event_type === "close",
    );
  }

  private appendEntry(entry: EventLogEntry): void {
    const line = JSON.stringify(entry) + "\n";
    this.rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(this.filePath, line, "utf-8");
  }

  private readBoundedEntries(): EventLogEntry[] {
    const content = this.readBoundedTailText();
    if (!content.trim()) return [];
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as EventLogEntry);
  }

  private readBoundedTailText(): string {
    let remainingBytes = this.maxReadBytes;
    const chunks: string[] = [];
    for (const path of this.segmentPathsNewestFirst()) {
      if (remainingBytes <= 0) break;
      if (!existsSync(path)) continue;
      const chunk = readFileTail(path, remainingBytes);
      if (!chunk) continue;
      chunks.unshift(chunk.text);
      remainingBytes -= chunk.bytesRead;
    }
    return chunks.join("");
  }

  private segmentPathsNewestFirst(): string[] {
    const paths = [this.filePath];
    for (let segment = 1; segment <= this.rotatedSegments; segment++) {
      paths.push(`${this.filePath}.${segment}`);
    }
    return paths;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (!existsSync(this.filePath)) return;
    const currentSize = statSync(this.filePath).size;
    if (currentSize === 0 || currentSize + incomingBytes <= this.maxFileBytes) {
      return;
    }

    const oldest = `${this.filePath}.${this.rotatedSegments}`;
    rmSync(oldest, { force: true });
    for (let segment = this.rotatedSegments - 1; segment >= 1; segment--) {
      const from = `${this.filePath}.${segment}`;
      const to = `${this.filePath}.${segment + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(this.filePath, `${this.filePath}.1`);
  }
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInt(
  explicit: number | undefined,
  environment: number | undefined,
  fallback: number,
): number {
  for (const value of [explicit, environment]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return fallback;
}

function readFileTail(
  path: string,
  maxBytes: number,
): { text: string; bytesRead: number } | null {
  const size = statSync(path).size;
  if (size <= 0) return null;
  const bytesToRead = Math.min(maxBytes, size);
  const start = Math.max(0, size - bytesToRead);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const fd = openSync(path, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buffer, 0, bytesToRead, start);
  } finally {
    closeSync(fd);
  }
  if (bytesRead <= 0) return null;

  let text = buffer.subarray(0, bytesRead).toString("utf8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }
  return { text, bytesRead };
}
