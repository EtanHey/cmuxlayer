/**
 * Session-ID self-registration — cmuxlayer READ side (P0 root fix).
 *
 * Agents SELF-REGISTER their real session id at boot: a Claude SessionStart hook
 * (or a Codex launcher wrapper) appends one JSON object per line to an
 * append-only registry file. cmuxlayer READS that file instead of scanning
 * `~/.claude`/`~/.codex` transcript dirs and inferring identity by cwd+recency —
 * the fragile mechanism that breaks with raw spawns, worktrees, and
 * many-agents-per-repo (25/25 agents `session_id:null`).
 *
 * The resolver here is the PRIMARY `SessionIdentityResolver`; the old transcript
 * scan (`findLatestHarnessSessionIdentity`) is kept only as a deprecated
 * last-resort fallback for hook-less agents, reached when this returns null.
 *
 * Registry contract (written by the boot hook / launcher wrapper):
 *   {"session_id":"<id>","surface_uuid":"<CMUX_SURFACE_ID>",
 *    "cwd":"<abs worktree cwd>","pid":<agent pid,int>,
 *    "cli":"claude|codex","launcher":"<e.g. cmuxlayerCodex>",
 *    "session_path":"<optional rollout path>","ts":<epoch MILLISECONDS,int>}
 * Path: ${CMUXLAYER_SESSION_REGISTRY:-$HOME/.cmuxlayer/session-registry.jsonl}.
 * Tolerant reader: skip malformed lines, ignore unknown extra fields, require
 * session_id + surface_uuid to bind, never fabricate an id.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "./agent-types.js";
import type {
  CapturedSessionIdentity,
  SessionIdentityResolver,
} from "./agent-engine.js";

const SESSION_REGISTRATION_TIMESTAMP_SKEW_MS = 5_000;
const SESSION_REGISTRATION_CONTINUITY_BYTES = 64;
export const SESSION_REGISTRATION_READ_CHUNK_BYTES = 64 * 1024;
export const SESSION_REGISTRATION_MAX_PENDING_LINE_BYTES = 64 * 1024;
export const SESSION_REGISTRATION_MAX_CANDIDATES_PER_SURFACE = 64;
export const SESSION_REGISTRATION_MAX_INDEXED_SURFACES = 1_024;

/** A single self-registration record, after tolerant parsing. */
export interface SelfRegistrationEntry {
  session_id: string;
  /** Stable cmux UUID from the pane's injected CMUX_SURFACE_ID. */
  surface_uuid: string;
  /** Optional validator for duplicate records from the same surface. */
  cwd: string | null;
  /** Agent CLI process pid (getppid past the shell wrapper). May be absent. */
  pid: number | null;
  cli: string | null;
  launcher: string | null;
  /** Optional rollout/transcript path; returned as the resolved `path`. */
  session_path: string | null;
  /** Epoch MILLISECONDS. Required for current-launch freshness checks. */
  ts: number | null;
}

export interface SelfRegistrationResolverOptions {
  /**
   * Registry file path. Defaults to
   * `${CMUXLAYER_SESSION_REGISTRY:-$HOME/.cmuxlayer/session-registry.jsonl}`.
   */
  registryPath?: string;
  /**
   * Injectable reader (default `fs.readFileSync` utf8). Returns the file body,
   * `null` for a missing/unreadable file, or throws (also treated as null).
   * Injected in tests so no real HOME I/O is touched.
   */
  readFile?: (path: string) => string | null;
  /** Injectable file metadata reader for the production incremental index. */
  statFile?: (path: string) => SelfRegistrationFileStat | null;
  /** Injectable byte-range reader for the production incremental index. */
  readFileRange?: (
    path: string,
    offset: number,
    length: number,
  ) => Buffer | null;
  /** Injectable wall clock for future-timestamp rejection (default Date.now). */
  now?: () => number;
}

export interface SelfRegistrationFileStat {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/** Resolve the registry path from env, defaulting under `$HOME/.cmuxlayer`. */
export function resolveSessionRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CMUXLAYER_SESSION_REGISTRY?.trim();
  if (override) return override;
  return join(homedir(), ".cmuxlayer", "session-registry.jsonl");
}

function toIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function surfaceUuidKey(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

function cliKey(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

/** Copy a bounded tail without retaining the source Buffer's backing store. */
export function copyBufferTail(
  source: Buffer,
  maxBytes: number,
): Buffer<ArrayBuffer> {
  const boundedMaxBytes =
    Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  const length = Math.min(source.byteLength, boundedMaxBytes);
  const copy = Buffer.allocUnsafeSlow(length);
  source.copy(copy, 0, source.byteLength - length);
  return copy;
}

/** Retain a partial JSONL row only while it remains within the record cap. */
export function boundPendingRegistrationLine(
  source: Buffer,
): Buffer<ArrayBuffer> {
  if (source.byteLength > SESSION_REGISTRATION_MAX_PENDING_LINE_BYTES) {
    return Buffer.alloc(0);
  }
  return copyBufferTail(source, source.byteLength);
}

/** Keep only the recent per-surface history needed for bounded selection. */
export function appendBoundedSurfaceCandidate(
  candidates: SelfRegistrationEntry[],
  entry: SelfRegistrationEntry,
): void {
  candidates.push(entry);
  const excess =
    candidates.length - SESSION_REGISTRATION_MAX_CANDIDATES_PER_SURFACE;
  if (excess > 0) candidates.splice(0, excess);
}

/**
 * Parse JSONL registry text into entries. Malformed lines and records missing
 * the required `session_id`/`surface_uuid` are skipped; unknown fields are
 * ignored. `cwd` is optional because raw-seat records do not reliably carry it.
 */
export function parseSelfRegistrationLines(
  text: string,
): SelfRegistrationEntry[] {
  const entries: SelfRegistrationEntry[] = [];
  for (const rawLine of text.split("\n")) {
    if (
      Buffer.byteLength(rawLine, "utf8") >
      SESSION_REGISTRATION_MAX_PENDING_LINE_BYTES
    ) {
      continue;
    }
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed line — skip
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    const session_id =
      typeof rec.session_id === "string" ? rec.session_id.trim() : "";
    const surface_uuid =
      typeof rec.surface_uuid === "string" ? rec.surface_uuid.trim() : "";
    const cwd =
      typeof rec.cwd === "string" && rec.cwd.length > 0 ? rec.cwd : null;
    if (!session_id || !surface_uuid) continue;
    entries.push({
      session_id,
      surface_uuid,
      cwd,
      pid: toIntegerOrNull(rec.pid),
      cli: toStringOrNull(rec.cli),
      launcher: toStringOrNull(rec.launcher),
      session_path: toStringOrNull(rec.session_path),
      ts: toIntegerOrNull(rec.ts),
    });
  }
  return entries;
}

/**
 * Parse complete JSONL rows without decoding a row that exceeds the byte cap.
 * The production incremental reader calls this only with newline-complete
 * bytes; handling a final unterminated slice keeps the helper safe in isolation.
 */
function parseSelfRegistrationBufferLines(
  source: Buffer,
): SelfRegistrationEntry[] {
  const entries: SelfRegistrationEntry[] = [];
  let lineStart = 0;
  while (lineStart < source.byteLength) {
    const newline = source.indexOf(0x0a, lineStart);
    const lineEnd = newline >= 0 ? newline : source.byteLength;
    if (
      lineEnd - lineStart <=
      SESSION_REGISTRATION_MAX_PENDING_LINE_BYTES
    ) {
      entries.push(
        ...parseSelfRegistrationLines(
          source.subarray(lineStart, lineEnd).toString("utf8"),
        ),
      );
    }
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  return entries;
}

/**
 * Choose the winning entry among records for one stable surface UUID.
 *
 * AgentRecord.pid is not a CLI process pid: production record creation,
 * recovery, repair, and auto-discovery paths all leave it null. It therefore
 * cannot soundly participate in identity selection. When launch_cwd is known
 * and at least one candidate matches it exactly, that subset is preferred as
 * an optional validator. The winner is then the newest `ts` (epoch ms); on an
 * exact tie the later (last-appended) record wins.
 */
function chooseCandidate(
  candidates: SelfRegistrationEntry[],
  launchCwd: string | null,
): SelfRegistrationEntry | null {
  if (candidates.length === 0) return null;
  const cwdMatches = launchCwd
    ? candidates.filter((entry) => entry.cwd === launchCwd)
    : [];
  const pool = cwdMatches.length > 0 ? cwdMatches : candidates;
  return pool.reduce((best, entry) => {
    const bestTs = best.ts ?? Number.NEGATIVE_INFINITY;
    const entryTs = entry.ts ?? Number.NEGATIVE_INFINITY;
    return entryTs >= bestTs ? entry : best;
  });
}

type SurfaceEntryIndex = Map<string, SelfRegistrationEntry[]>;

/** Exclude rows that can never resolve before they consume bounded index state. */
function isIndexableRegistrationEntry(entry: SelfRegistrationEntry): boolean {
  return entry.ts !== null;
}

/**
 * Index one registration while bounding both history dimensions. Map insertion
 * order tracks the most recently appended row for each surface, so exceeding
 * the key cap evicts the least-recent historical surface rather than a surface
 * that has just re-registered.
 */
function indexSurfaceCandidate(
  entriesBySurface: SurfaceEntryIndex,
  key: string,
  entry: SelfRegistrationEntry,
): void {
  const existing = entriesBySurface.get(key);
  if (existing) {
    appendBoundedSurfaceCandidate(existing, entry);
    entriesBySurface.delete(key);
    entriesBySurface.set(key, existing);
  } else {
    entriesBySurface.set(key, [entry]);
  }

  while (
    entriesBySurface.size > SESSION_REGISTRATION_MAX_INDEXED_SURFACES
  ) {
    const leastRecentKey = entriesBySurface.keys().next().value;
    if (leastRecentKey === undefined) break;
    entriesBySurface.delete(leastRecentKey);
  }
}

/**
 * Build an append-aware registry index for production lookups.
 *
 * Each call stats the file, but unchanged files perform no read or parse. New
 * bytes are read exactly once and indexed by surface UUID, so a sweep across N
 * uncaptured agents is O(bounded continuity check + file delta + N), not
 * O(N * registry size). A partial final JSONL row is retained until its newline
 * arrives. Compaction, truncation, rotation, or a failed append-continuity check
 * resets the index before the replacement file is consumed.
 */
function makeIncrementalEntryIndexReader(
  registryPath: string,
  statFile: (path: string) => SelfRegistrationFileStat | null,
  readFileRange: (
    path: string,
    offset: number,
    length: number,
  ) => Buffer | null,
): () => SurfaceEntryIndex | null {
  let fileIdentity: string | null = null;
  let consumedBytes = 0;
  let observedMtimeMs = Number.NEGATIVE_INFINITY;
  let pendingLine = Buffer.alloc(0);
  let discardingOversizedLine = false;
  let continuityTail = Buffer.alloc(0);
  let entriesBySurface: SurfaceEntryIndex = new Map();

  const reset = () => {
    consumedBytes = 0;
    observedMtimeMs = Number.NEGATIVE_INFINITY;
    pendingLine = Buffer.alloc(0);
    discardingOversizedLine = false;
    continuityTail = Buffer.alloc(0);
    entriesBySurface = new Map();
  };

  const readExactRange = (offset: number, length: number): Buffer | null => {
    let readBuffer: Buffer | null;
    try {
      readBuffer = readFileRange(registryPath, offset, length);
    } catch {
      readBuffer = null;
    }
    return readBuffer?.byteLength === length ? readBuffer : null;
  };

  const consumeAppendedBytes = (appended: Buffer): void => {
    const continuitySource = Buffer.concat([continuityTail, appended]);
    continuityTail = copyBufferTail(
      continuitySource,
      SESSION_REGISTRATION_CONTINUITY_BYTES,
    );
    let parseableAppended = appended;
    if (discardingOversizedLine) {
      const discardedLineEnd = parseableAppended.indexOf(0x0a);
      if (discardedLineEnd < 0) {
        parseableAppended = Buffer.alloc(0);
      } else {
        discardingOversizedLine = false;
        parseableAppended = parseableAppended.subarray(discardedLineEnd + 1);
      }
    }
    const combined = Buffer.concat([pendingLine, parseableAppended]);
    const finalNewline = combined.lastIndexOf(0x0a);
    if (finalNewline >= 0) {
      const completeLines = combined.subarray(0, finalNewline + 1);
      const trailingLine = combined.subarray(finalNewline + 1);
      discardingOversizedLine =
        trailingLine.byteLength >
        SESSION_REGISTRATION_MAX_PENDING_LINE_BYTES;
      pendingLine = boundPendingRegistrationLine(trailingLine);
      for (const entry of parseSelfRegistrationBufferLines(completeLines)) {
        if (!isIndexableRegistrationEntry(entry)) continue;
        const key = surfaceUuidKey(entry.surface_uuid);
        if (!key) continue;
        indexSurfaceCandidate(entriesBySurface, key, entry);
      }
    } else {
      discardingOversizedLine =
        discardingOversizedLine ||
        combined.byteLength > SESSION_REGISTRATION_MAX_PENDING_LINE_BYTES;
      pendingLine = boundPendingRegistrationLine(combined);
    }
  };

  return () => {
    let fileStat: SelfRegistrationFileStat | null;
    try {
      fileStat = statFile(registryPath);
    } catch {
      fileStat = null;
    }
    if (
      !fileStat ||
      !Number.isSafeInteger(fileStat.size) ||
      fileStat.size < 0 ||
      !Number.isFinite(fileStat.mtimeMs)
    ) {
      fileIdentity = null;
      reset();
      return null;
    }

    const nextIdentity = `${fileStat.dev}:${fileStat.ino}`;
    const replaced =
      fileIdentity !== null && nextIdentity !== fileIdentity;
    const rewrittenAtSameSize =
      fileIdentity !== null &&
      fileStat.size === consumedBytes &&
      fileStat.mtimeMs !== observedMtimeMs;
    const resetsIndex =
      fileIdentity === null ||
      replaced ||
      fileStat.size < consumedBytes ||
      rewrittenAtSameSize;
    const sameFileGrowth =
      !resetsIndex &&
      fileStat.size > consumedBytes &&
      consumedBytes > 0 &&
      continuityTail.byteLength > 0;
    if (resetsIndex) reset();
    fileIdentity = nextIdentity;

    if (sameFileGrowth) {
      const continuityLength = Math.min(
        continuityTail.byteLength,
        consumedBytes,
      );
      const observedBoundary = readExactRange(
        consumedBytes - continuityLength,
        continuityLength,
      );
      if (!observedBoundary) return null;
      const expectedBoundary = continuityTail.subarray(
        continuityTail.byteLength - continuityLength,
      );
      if (!observedBoundary.equals(expectedBoundary)) reset();
    }

    while (consumedBytes < fileStat.size) {
      const readLength = Math.min(
        SESSION_REGISTRATION_READ_CHUNK_BYTES,
        fileStat.size - consumedBytes,
      );
      const readBuffer = readExactRange(consumedBytes, readLength);
      if (!readBuffer) return null;
      consumeAppendedBytes(readBuffer);
      consumedBytes += readLength;
    }
    observedMtimeMs = fileStat.mtimeMs;
    return entriesBySurface;
  };
}

/**
 * Build the self-registration `SessionIdentityResolver`.
 *
 * Match is stable-surface UUID PRIMARY
 * (`entry.surface_uuid === agent.surface_uuid`). Exact launch_cwd is only an
 * optional secondary validator, then newest `ts` decides. For cmuxlayer-owned
 * launches, candidates must be newer than the agent-creation window; raw and
 * repaired records deliberately skip that lower bound because their
 * `created_at` is discovery time, not launch time. All candidates are bounded
 * against the reader clock so a row from before a backward clock correction
 * cannot dominate. A row with explicit `cli` metadata must match the agent;
 * missing CLI remains compatible with older writers. AgentRecord pid is
 * deliberately ignored because production does not populate it with the CLI
 * process pid. Returns
 * `{ session_id, path }` or `null`. NO filesystem scan of session dirs; a
 * missing/unreadable/empty registry, an agent without a stable surface UUID, or
 * no UUID match all return `null` (the caller then falls back to the scan).
 */
export function makeSelfRegistrationSessionResolver(
  options: SelfRegistrationResolverOptions = {},
): SessionIdentityResolver {
  const registryPath = options.registryPath ?? resolveSessionRegistryPath();
  const now = options.now ?? Date.now;
  const readCandidates = options.readFile
    ? (surfaceKey: string): SelfRegistrationEntry[] | null => {
        let text: string | null;
        try {
          text = options.readFile?.(registryPath) ?? null;
        } catch {
          return null;
        }
        if (!text) return null;
        return parseSelfRegistrationLines(text).filter(
          (entry) => surfaceUuidKey(entry.surface_uuid) === surfaceKey,
        );
      }
    : (() => {
        const readIndex = makeIncrementalEntryIndexReader(
          registryPath,
          options.statFile ?? defaultStatFile,
          options.readFileRange ?? defaultReadFileRange,
        );
        return (surfaceKey: string): SelfRegistrationEntry[] | null =>
          readIndex()?.get(surfaceKey) ?? null;
      })();

  return (agent: AgentRecord): CapturedSessionIdentity | null => {
    const agentSurfaceUuid = surfaceUuidKey(agent.surface_uuid);
    if (!agentSurfaceUuid) return null;
    const agentCli = cliKey(agent.cli);
    const launchCwd = agent.launch_cwd?.trim() || null;
    const createdAt = Date.parse(agent.created_at);
    if (Number.isNaN(createdAt)) return null;
    const earliestCurrentLaunchTs =
      agent.surface_provenance === "cmuxlayer_spawn"
        ? createdAt - SESSION_REGISTRATION_TIMESTAMP_SKEW_MS
        : Number.NEGATIVE_INFINITY;
    const resolvedAt = now();
    if (!Number.isSafeInteger(resolvedAt)) return null;
    const latestPlausibleTs =
      resolvedAt + SESSION_REGISTRATION_TIMESTAMP_SKEW_MS;

    const candidates = (readCandidates(agentSurfaceUuid) ?? []).filter(
      (entry) =>
        (entry.cli === null || cliKey(entry.cli) === agentCli) &&
        entry.ts !== null &&
        entry.ts >= earliestCurrentLaunchTs &&
        entry.ts <= latestPlausibleTs,
    );
    const chosen = chooseCandidate(candidates, launchCwd);
    if (!chosen) return null;
    return {
      session_id: chosen.session_id,
      path: chosen.session_path ?? null,
    };
  };
}

function defaultStatFile(path: string): SelfRegistrationFileStat | null {
  try {
    const stat = statSync(path);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch {
    return null;
  }
}

function defaultReadFileRange(
  path: string,
  offset: number,
  length: number,
): Buffer | null {
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const bytesRead = readSync(
        fileDescriptor,
        buffer,
        totalRead,
        length - totalRead,
        offset + totalRead,
      );
      if (bytesRead === 0) return null;
      totalRead += bytesRead;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
  }
}
