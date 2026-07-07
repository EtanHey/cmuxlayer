/**
 * Close forensics — attribute cmux app-level `surface.closed` events.
 *
 * cmuxlayer's {@link CloseTelemetryEvent} only records closes that flow through
 * an MCP tool (close_surface / stop_agent / kill), so it CANNOT see cmux's own
 * app-level `tab_close` — the deaths that have been killing the driver + leads
 * with no actor recorded. cmux DOES emit those to its own event stream
 * (`~/.cmuxterm/events.jsonl`, `protocol:"cmux-events"`), but the record carries
 * no caller.
 *
 * This module reads that stream, and for each app-level close:
 *  1. tries to ATTRIBUTE it to a cmuxlayer MCP close for the same surface within
 *     Δt (`mcp:<tool> caller=…`); if none exists it is a genuine app-level death
 *     (`app-level:no-mcp-close`), and
 *  2. captures CLIENT/ATTACH CONTEXT — nearby `window.keyed`/`window.unkeyed`
 *     focus cycles and cmux `boot_id` changes — the rc/Screens5-reconnect signal.
 *
 * The ingest is a PURE function ({@link ingestCloseForensics}); ALL I/O (reading
 * the cmux file, the cursor, the MCP close log) is injected via
 * {@link CloseForensicsDeps} so tests never touch `~/.cmuxterm` or real state and
 * the sweep wiring stays a thin, best-effort adapter.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CloseForensicsEvent,
  CloseTelemetryEvent,
} from "./agent-types.js";
import type { StateManager } from "./state-manager.js";
import type { CmuxSurface } from "./types.js";

/** Minimal shape of a parsed line from `~/.cmuxterm/events.jsonl`. */
export interface CmuxEvent {
  name: string;
  seq: number;
  occurred_at: string;
  surface_id: string | null;
  pane_id: string | null;
  window_id: string | number | null;
  boot_id: string | null;
  workspace_id: string | null;
  payload: { origin?: string; [key: string]: unknown } | null;
}

export interface CloseForensicsInput {
  /** Parsed cmux events (any subset of the stream; unordered is fine). */
  cmuxEvents: CmuxEvent[];
  /** cmuxlayer's own MCP close-log records (event_type "close"). */
  mcpCloses: CloseTelemetryEvent[];
  /**
   * Map from a cmux internal surface UUID → cmuxlayer surface ref ("surface:N").
   * Used to join a cmux `surface.closed` UUID against an MCP close whose `target`
   * is a `surface:N` ref. May be empty (live wiring cannot always resolve it —
   * see {@link buildSurfaceRefMap}); attribution then falls to app-level.
   */
  surfaceRefByCmuxId: Map<string, string>;
  /** Correlation window in ms for MCP-close / window-key matching. */
  deltaMs: number;
  /** Cursor: only emit forensics for events with seq strictly greater than this. */
  lastSeq: number;
  /** Last close boot_id from a prior offset-tail sweep, for continuity. */
  previousCloseBootId?: string | null;
  /** Last window key/unkey event from a prior offset-tail sweep. */
  previousWindowKeyEvent?: CloseForensicsWindowKeyCursor | null;
  /** Injected clock producing the forensics record's `ts`. */
  now: () => string;
}

export interface CloseForensicsResult {
  events: CloseForensicsEvent[];
  /** Advanced cursor = max seq observed across ALL input events (>= lastSeq). */
  nextSeq: number;
  /** Last close boot_id observed across this input batch and prior cursor state. */
  lastCloseBootId: string | null;
  /** Last window key/unkey event observed across this batch and prior cursor. */
  lastWindowKeyEvent: CloseForensicsWindowKeyCursor | null;
}

export interface CloseForensicsWindowKeyCursor {
  name: "window.keyed" | "window.unkeyed";
  occurredAt: string;
}

export interface CloseForensicsCursorState {
  lastSeq: number;
  lastOffset: number;
  lastCloseBootId: string | null;
  lastWindowKeyEvent: CloseForensicsWindowKeyCursor | null;
}

const SURFACE_CLOSED = "surface.closed";
const WINDOW_KEYED = "window.keyed";
const WINDOW_UNKEYED = "window.unkeyed";

function toMillis(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Pure ingest: (cmux events, MCP closes, surface map, Δt, cursor, clock) →
 * attributed {@link CloseForensicsEvent}[]. Never throws on malformed input —
 * events with an unparseable timestamp still emit, degrading only the fields
 * that need time math.
 */
export function ingestCloseForensics(
  input: CloseForensicsInput,
): CloseForensicsResult {
  const {
    cmuxEvents,
    mcpCloses,
    surfaceRefByCmuxId,
    deltaMs,
    lastSeq,
    previousCloseBootId,
    previousWindowKeyEvent,
    now,
  } = input;

  let nextSeq = lastSeq;
  for (const ev of cmuxEvents) {
    if (typeof ev?.seq === "number" && ev.seq > nextSeq) nextSeq = ev.seq;
  }

  // Window key-focus events power the rc/screen-share attach/detach signal.
  const currentWindowKeyEvents = cmuxEvents.filter(
    (ev) => ev?.name === WINDOW_KEYED || ev?.name === WINDOW_UNKEYED,
  );
  const windowKeyEvents: Array<Pick<CmuxEvent, "name" | "occurred_at">> = [
    ...(previousWindowKeyEvent
      ? [
          {
            name: previousWindowKeyEvent.name,
            occurred_at: previousWindowKeyEvent.occurredAt,
          },
        ]
      : []),
    ...currentWindowKeyEvents,
  ];
  const lastWindowKeyEvent = latestWindowKeyCursor(
    currentWindowKeyEvents,
    previousWindowKeyEvent ?? null,
  );

  // Closes sorted by seq give a stable "previous close" for boot_id continuity.
  const closes = cmuxEvents
    .filter((ev) => ev?.name === SURFACE_CLOSED)
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const results: CloseForensicsEvent[] = [];
  let prevBootId: string | null = previousCloseBootId ?? null;
  let sawPrevClose = prevBootId !== null;

  for (const close of closes) {
    const bootIdChanged =
      sawPrevClose && prevBootId !== null && close.boot_id !== prevBootId;
    // Advance the boot-continuity cursor across EVERY close (even ones below the
    // seq cursor) so a re-run's first new close still compares to the right prev.
    prevBootId = close.boot_id ?? null;
    sawPrevClose = true;

    // Cursor: only NEW closes are emitted; older ones only seed prevBootId.
    if (typeof close.seq === "number" && close.seq <= lastSeq) continue;

    const origin =
      typeof close.payload?.origin === "string"
        ? close.payload.origin
        : "unknown";
    const cmuxSurfaceId =
      close.surface_id ??
      (typeof close.payload?.surface_id === "string"
        ? close.payload.surface_id
        : null);
    const closeMs = toMillis(close.occurred_at);

    results.push({
      ts: now(),
      event_type: "close_forensics",
      cmux_surface_id: cmuxSurfaceId,
      cmux_pane_id:
        close.pane_id ??
        (typeof close.payload?.pane_id === "string"
          ? close.payload.pane_id
          : null),
      window_id: close.window_id ?? null,
      boot_id: close.boot_id ?? null,
      workspace_id: close.workspace_id ?? null,
      origin,
      occurred_at: close.occurred_at,
      attribution: attributeClose({
        cmuxSurfaceId,
        closeMs,
        mcpCloses,
        surfaceRefByCmuxId,
        deltaMs,
      }),
      client_context: {
        ...deriveWindowKeyContext(windowKeyEvents, closeMs, deltaMs),
        boot_id_changed_since_prev: bootIdChanged,
      },
    });
  }

  return {
    events: results,
    nextSeq,
    lastCloseBootId: prevBootId,
    lastWindowKeyEvent,
  };
}

function latestWindowKeyCursor(
  currentWindowKeyEvents: CmuxEvent[],
  previousWindowKeyEvent: CloseForensicsWindowKeyCursor | null,
): CloseForensicsWindowKeyCursor | null {
  let latest: CmuxEvent | null = null;
  for (const ev of currentWindowKeyEvents) {
    if (!latest || (ev.seq ?? 0) > (latest.seq ?? 0)) latest = ev;
  }
  if (!latest) return previousWindowKeyEvent;
  return {
    name: latest.name === WINDOW_KEYED ? WINDOW_KEYED : WINDOW_UNKEYED,
    occurredAt: latest.occurred_at,
  };
}

function attributeClose(args: {
  cmuxSurfaceId: string | null;
  closeMs: number;
  mcpCloses: CloseTelemetryEvent[];
  surfaceRefByCmuxId: Map<string, string>;
  deltaMs: number;
}): string {
  const { cmuxSurfaceId, closeMs, mcpCloses, surfaceRefByCmuxId, deltaMs } =
    args;
  if (Number.isNaN(closeMs)) return "app-level:no-mcp-close";

  const ref = cmuxSurfaceId
    ? (surfaceRefByCmuxId.get(cmuxSurfaceId) ?? null)
    : null;

  let best: { rec: CloseTelemetryEvent; dist: number } | null = null;
  for (const rec of mcpCloses) {
    // A close matches this surface if its target is the mapped ref, or the raw
    // cmux UUID directly (some callers target a UUID rather than a surface:N ref).
    const targetsThisSurface =
      (ref !== null && rec.target === ref) ||
      (cmuxSurfaceId !== null && rec.target === cmuxSurfaceId);
    if (!targetsThisSurface) continue;
    const recMs = toMillis(rec.ts);
    if (Number.isNaN(recMs)) continue;
    const dist = Math.abs(recMs - closeMs);
    if (dist > deltaMs) continue;
    if (best === null || dist < best.dist) best = { rec, dist };
  }

  if (best) return `mcp:${best.rec.event} caller=${best.rec.caller}`;
  return "app-level:no-mcp-close";
}

function deriveWindowKeyContext(
  windowKeyEvents: Array<Pick<CmuxEvent, "name" | "occurred_at">>,
  closeMs: number,
  deltaMs: number,
): {
  window_key_cycle_near_close: boolean;
  last_window_key_event: "keyed" | "unkeyed" | null;
} {
  if (Number.isNaN(closeMs)) {
    return { window_key_cycle_near_close: false, last_window_key_event: null };
  }

  // Candidates within Δt of the close. Prefer the most recent one AT OR BEFORE
  // the close (the focus state the window was in when it died); otherwise the
  // nearest one after.
  let beforeBest: { ev: Pick<CmuxEvent, "name" | "occurred_at">; t: number } | null =
    null;
  let afterBest: {
    ev: Pick<CmuxEvent, "name" | "occurred_at">;
    dist: number;
  } | null = null;
  for (const ev of windowKeyEvents) {
    const t = toMillis(ev.occurred_at);
    if (Number.isNaN(t)) continue;
    if (Math.abs(t - closeMs) > deltaMs) continue;
    if (t <= closeMs) {
      if (beforeBest === null || t > beforeBest.t) beforeBest = { ev, t };
    } else {
      const dist = t - closeMs;
      if (afterBest === null || dist < afterBest.dist) afterBest = { ev, dist };
    }
  }

  const chosen = beforeBest?.ev ?? afterBest?.ev ?? null;
  if (!chosen) {
    return { window_key_cycle_near_close: false, last_window_key_event: null };
  }
  return {
    window_key_cycle_near_close: true,
    last_window_key_event: chosen.name === WINDOW_KEYED ? "keyed" : "unkeyed",
  };
}

/**
 * Tolerant line parser for `~/.cmuxterm/events.jsonl`: skips blank/malformed
 * lines and lines missing the required shape, never throws. Returns whatever it
 * could parse so a single corrupt line can't blind the whole ingest.
 */
export function parseCmuxEvents(text: string): CmuxEvent[] {
  const out: CmuxEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.name !== "string") continue;
    if (typeof rec.seq !== "number") continue;
    out.push({
      name: rec.name,
      seq: rec.seq,
      occurred_at: typeof rec.occurred_at === "string" ? rec.occurred_at : "",
      surface_id: typeof rec.surface_id === "string" ? rec.surface_id : null,
      pane_id: typeof rec.pane_id === "string" ? rec.pane_id : null,
      window_id:
        typeof rec.window_id === "string" || typeof rec.window_id === "number"
          ? (rec.window_id as string | number)
          : null,
      boot_id: typeof rec.boot_id === "string" ? rec.boot_id : null,
      workspace_id:
        typeof rec.workspace_id === "string" ? rec.workspace_id : null,
      payload:
        rec.payload && typeof rec.payload === "object"
          ? (rec.payload as { origin?: string; [k: string]: unknown })
          : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sweep-driven runner (thin, best-effort I/O adapter over the pure ingest).
// ---------------------------------------------------------------------------

export interface CloseForensicsCursorStore {
  /** Last ingested cmux seq (0 when none / unreadable). */
  read(): number;
  write(seq: number): void;
  readState?(): CloseForensicsCursorState;
  writeState?(state: CloseForensicsCursorState): void;
}

export interface CmuxEventsTextRead {
  text: string;
  nextOffset: number;
  truncated: boolean;
}

export interface CloseForensicsDeps {
  /** Reads the raw cmux events file; returns null when absent/unreadable. */
  readCmuxEventsText: (
    cursor?: CloseForensicsCursorState,
  ) => string | CmuxEventsTextRead | null;
  /** cmuxlayer's own MCP close-log records. */
  readMcpCloses: () => CloseTelemetryEvent[];
  /** cmux-UUID → surface-ref map (may be empty). */
  surfaceRefByCmuxId: () => Map<string, string>;
  /** Append one attributed forensics record to the event log. */
  appendForensics: (event: CloseForensicsEvent) => void;
  cursor: CloseForensicsCursorStore;
  now: () => string;
  deltaMs: number;
}

/**
 * Run one forensics ingest pass. Fully best-effort: ANY failure (missing file,
 * malformed lines, cursor I/O error, append error) is swallowed — this is
 * forensics, never a critical path, and it must never throw into the sweep.
 * Returns the count emitted for observability/tests.
 */
export function runCloseForensicsSweep(deps: CloseForensicsDeps): {
  emitted: number;
} {
  try {
    const cursorState =
      safe(() => deps.cursor.readState?.(), undefined) ?? undefined;
    const lastSeq =
      cursorState?.lastSeq ?? (safe(() => deps.cursor.read(), 0) ?? 0);
    const readResult = safe(() => deps.readCmuxEventsText(cursorState), null);
    const resetForTruncation =
      typeof readResult === "object" && readResult !== null
        ? readResult.truncated
        : false;
    const effectiveCursorState: CloseForensicsCursorState | undefined =
      resetForTruncation
        ? {
            lastSeq: 0,
            lastOffset: 0,
            lastCloseBootId: null,
            lastWindowKeyEvent: null,
          }
        : cursorState;
    const effectiveLastSeq = resetForTruncation ? 0 : lastSeq;
    const text =
      typeof readResult === "string" || readResult === null
        ? readResult
        : readResult.text;
    if (!text) {
      if (typeof readResult === "object" && readResult !== null) {
        const nextOffset = readResult.nextOffset;
        if (nextOffset !== (cursorState?.lastOffset ?? nextOffset)) {
          try {
            deps.cursor.writeState?.({
              lastSeq: effectiveLastSeq,
              lastOffset: nextOffset,
              lastCloseBootId: effectiveCursorState?.lastCloseBootId ?? null,
              lastWindowKeyEvent:
                effectiveCursorState?.lastWindowKeyEvent ?? null,
            });
          } catch {
            // Best-effort: an offset write failure only retries the same chunk.
          }
        }
      }
      return { emitted: 0 };
    }
    const cmuxEvents =
      safe(() => parseCmuxEvents(text), [] as CmuxEvent[]) ?? [];
    const mcpCloses =
      safe(() => deps.readMcpCloses(), [] as CloseTelemetryEvent[]) ?? [];
    const surfaceRefByCmuxId =
      safe(() => deps.surfaceRefByCmuxId(), new Map<string, string>()) ??
      new Map<string, string>();

    const { events, nextSeq, lastCloseBootId, lastWindowKeyEvent } =
      ingestCloseForensics({
      cmuxEvents,
      mcpCloses,
      surfaceRefByCmuxId,
      deltaMs: deps.deltaMs,
      lastSeq: effectiveLastSeq,
      previousCloseBootId: effectiveCursorState?.lastCloseBootId ?? null,
      previousWindowKeyEvent:
        effectiveCursorState?.lastWindowKeyEvent ?? null,
      now: deps.now,
    });

    for (const event of events) {
      try {
        deps.appendForensics(event);
      } catch {
        // Best-effort: one bad append must not lose the rest of the batch.
      }
    }
    const nextOffset =
      typeof readResult === "object" && readResult !== null
        ? readResult.nextOffset
        : (cursorState?.lastOffset ?? 0);
    const nextState: CloseForensicsCursorState = {
      lastSeq: nextSeq,
      lastOffset: nextOffset,
      lastCloseBootId,
      lastWindowKeyEvent,
    };
    const stateChanged =
      resetForTruncation ||
      nextSeq > effectiveLastSeq ||
      nextOffset !== (cursorState?.lastOffset ?? nextOffset) ||
      lastCloseBootId !== (effectiveCursorState?.lastCloseBootId ?? null) ||
      lastWindowKeyEvent?.name !==
        effectiveCursorState?.lastWindowKeyEvent?.name ||
      lastWindowKeyEvent?.occurredAt !==
        effectiveCursorState?.lastWindowKeyEvent?.occurredAt;
    if (stateChanged) {
      try {
        if (deps.cursor.writeState) deps.cursor.writeState(nextState);
        else deps.cursor.write(nextSeq);
      } catch {
        // A cursor-write failure re-processes next sweep; append de-dup is owned
        // by cursor advances, so we log at-most-once per successful advance.
      }
    }
    return { emitted: events.length };
  } catch {
    return { emitted: 0 };
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Default path to cmux's own event stream (override with CMUX_EVENTS_PATH). */
export function defaultCmuxEventsPath(): string {
  return (
    process.env.CMUX_EVENTS_PATH ?? join(homedir(), ".cmuxterm", "events.jsonl")
  );
}

const DEFAULT_DELTA_MS = 30_000;
const DEFAULT_MAX_CMUX_EVENTS_READ_BYTES = 256 * 1024;

export function readAppendedCmuxEventsText(args: {
  path: string;
  offset: number;
  maxBytes?: number;
}): CmuxEventsTextRead {
  const maxBytes = Math.max(
    1,
    args.maxBytes ?? DEFAULT_MAX_CMUX_EVENTS_READ_BYTES,
  );
  const size = statSync(args.path).size;
  const start = args.offset > size ? 0 : Math.max(0, args.offset);
  const truncated = args.offset > size;
  if (start >= size) {
    return { text: "", nextOffset: start, truncated };
  }

  const bytesToRead = Math.min(maxBytes, size - start);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const fd = openSync(args.path, "r");
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buffer, 0, bytesToRead, start);
  } finally {
    closeSync(fd);
  }

  if (bytesRead <= 0) {
    return { text: "", nextOffset: start, truncated };
  }

  const reachedEof = start + bytesRead >= size;
  const chunk = buffer.subarray(0, bytesRead).toString("utf8");
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline < 0) {
    return { text: "", nextOffset: start, truncated };
  }
  if (reachedEof && lastNewline === chunk.length - 1) {
    return { text: chunk, nextOffset: start + bytesRead, truncated };
  }

  const text = chunk.slice(0, lastNewline + 1);
  return {
    text,
    nextOffset: start + Buffer.byteLength(text),
    truncated,
  };
}

/**
 * Build the cmux-internal UUID → cmuxlayer ref bridge from a bounded live
 * surface listing. `surface.list` may expose `surface.id`; callers can also
 * enrich from `pane.list`'s parallel `surface_ids`/`surface_refs` arrays before
 * passing surfaces here. Missing IDs are skipped so attribution degrades
 * honestly to `app-level:no-mcp-close`.
 */
export type SurfaceRefMapSurface = Pick<CmuxSurface, "id" | "ref">;

export type SurfaceRefMapLister = () => Promise<SurfaceRefMapSurface[]>;

export function buildSurfaceRefMapFromSurfaces(
  surfaces: SurfaceRefMapSurface[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const surface of surfaces) {
    if (!surface.id || !surface.ref) continue;
    map.set(surface.id, surface.ref);
  }
  return map;
}

export async function buildSurfaceRefMap(
  _stateMgr: StateManager,
  listSurfaces?: SurfaceRefMapLister,
): Promise<Map<string, string>> {
  if (!listSurfaces) return new Map<string, string>();
  try {
    return buildSurfaceRefMapFromSurfaces(await listSurfaces());
  } catch {
    return new Map<string, string>();
  }
}

/**
 * Build the default sweep-driven runner bound to real fs + a StateManager. The
 * returned function is what the engine calls each sweep; it is a thin wrapper
 * over {@link runCloseForensicsSweep} with production I/O.
 */
export function createDefaultCloseForensicsRunner(config: {
  stateMgr: StateManager;
  eventsPath?: string;
  deltaMs?: number;
  now?: () => string;
  listSurfacesForRefMap?: SurfaceRefMapLister;
}): () => Promise<{ emitted: number }> {
  const eventsPath = config.eventsPath ?? defaultCmuxEventsPath();
  const deltaMs = config.deltaMs ?? DEFAULT_DELTA_MS;
  const now = config.now ?? (() => new Date().toISOString());
  const cursorPath = join(
    config.stateMgr.getBaseDir(),
    "close-forensics-cursor.json",
  );

  const cursor: CloseForensicsCursorStore = {
    readState: () => {
      if (!existsSync(cursorPath)) {
        return {
          lastSeq: 0,
          lastOffset: 0,
          lastCloseBootId: null,
          lastWindowKeyEvent: null,
        };
      }
      try {
        const parsed = JSON.parse(readFileSync(cursorPath, "utf-8")) as {
          last_seq?: number;
          last_offset?: number;
          last_close_boot_id?: string | null;
          last_window_key_event?: {
            name?: string;
            occurred_at?: string;
          } | null;
        };
        const parsedWindowKeyName = parsed.last_window_key_event?.name;
        const lastWindowKeyEvent: CloseForensicsWindowKeyCursor | null =
          (parsedWindowKeyName === WINDOW_KEYED ||
            parsedWindowKeyName === WINDOW_UNKEYED) &&
          typeof parsed.last_window_key_event?.occurred_at === "string"
            ? {
                name: parsedWindowKeyName,
                occurredAt: parsed.last_window_key_event.occurred_at,
              }
            : null;
        return {
          lastSeq: typeof parsed.last_seq === "number" ? parsed.last_seq : 0,
          lastOffset:
            typeof parsed.last_offset === "number" ? parsed.last_offset : 0,
          lastCloseBootId:
            typeof parsed.last_close_boot_id === "string"
              ? parsed.last_close_boot_id
              : null,
          lastWindowKeyEvent,
        };
      } catch {
        return {
          lastSeq: 0,
          lastOffset: 0,
          lastCloseBootId: null,
          lastWindowKeyEvent: null,
        };
      }
    },
    read: () => cursor.readState?.().lastSeq ?? 0,
    writeState: (state: CloseForensicsCursorState) => {
      const tmp = `${cursorPath}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          last_seq: state.lastSeq,
          last_offset: state.lastOffset,
          last_close_boot_id: state.lastCloseBootId,
          last_window_key_event: state.lastWindowKeyEvent
            ? {
                name: state.lastWindowKeyEvent.name,
                occurred_at: state.lastWindowKeyEvent.occurredAt,
              }
            : null,
        }),
        "utf-8",
      );
      renameSync(tmp, cursorPath);
    },
    write: (seq: number) => {
      const tmp = `${cursorPath}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          last_seq: seq,
          last_offset: 0,
          last_window_key_event: null,
        }),
        "utf-8",
      );
      renameSync(tmp, cursorPath);
    },
  };

  return async () => {
    const surfaceRefByCmuxId = await buildSurfaceRefMap(
      config.stateMgr,
      config.listSurfacesForRefMap,
    );
    return runCloseForensicsSweep({
      readCmuxEventsText: (cursorState) =>
        existsSync(eventsPath)
          ? readAppendedCmuxEventsText({
              path: eventsPath,
              offset: cursorState?.lastOffset ?? 0,
            })
          : null,
      readMcpCloses: () =>
        config.stateMgr
          .getEventLog()
          .readCloseEvents(),
      surfaceRefByCmuxId: () => surfaceRefByCmuxId,
      appendForensics: (event) =>
        config.stateMgr.getEventLog().appendCloseForensics(event),
      cursor,
      now,
      deltaMs,
    });
  };
}
