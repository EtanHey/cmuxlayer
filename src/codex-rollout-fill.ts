import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseCodexTokenUsageEvent } from "./harness-session.js";

export const CODEX_CONTEXT_WINDOW = 400_000 as const;
export const CODEX_ROLLOUT_READ_CHUNK_BYTES = 64 * 1024;
export const CODEX_ROLLOUT_MAX_PENDING_LINE_BYTES = 64 * 1024;
export const CODEX_ROLLOUT_MAX_TAIL_BYTES = 512 * 1024;
export const CODEX_ROLLOUT_REFRESH_INTERVAL_MS = 1_000;
export const CODEX_ROLLOUT_CONTINUITY_BYTES = 64;
export const CODEX_ROLLOUT_MAX_CACHE_ENTRIES = 1_024;

export interface CodexRolloutFill {
  token_count: number;
  context_window: typeof CODEX_CONTEXT_WINDOW;
  context_pct: number;
  observed_model_context_window: number | null;
}

export interface CodexRolloutFileStat {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  isFile: boolean;
}

export interface CodexRolloutFillProviderOptions {
  now?: () => number;
  refreshIntervalMs?: number;
  maxConcurrentReads?: number;
  maxEntries?: number;
  /** Return null only for confirmed absence; reject transient stat failures. */
  statFile?: (path: string) => Promise<CodexRolloutFileStat | null>;
  readFileRange?: (
    path: string,
    start: number,
    length: number,
  ) => Promise<Uint8Array | null>;
}

export interface CodexRolloutFillProvider {
  get(path: string): Promise<CodexRolloutFill | null>;
}

interface FillCacheEntry {
  snapshot: CodexRolloutFill | null;
  identity: string | null;
  size: number;
  mtimeMs: number;
  cursor: number;
  continuity: Buffer;
  pending: Buffer;
  discardingLine: boolean;
  lastCheckedAt: number;
  lastAccessAt: number;
  inFlight: Promise<CodexRolloutFill | null> | null;
}

type ReadFileRange = NonNullable<
  CodexRolloutFillProviderOptions["readFileRange"]
>;

async function readRangeFully(
  readFileRange: ReadFileRange,
  path: string,
  start: number,
  length: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < length) {
    const requested = Math.min(
      CODEX_ROLLOUT_READ_CHUNK_BYTES,
      length - offset,
    );
    const bytes = await readFileRange(path, start + offset, requested);
    if (!bytes || bytes.byteLength === 0) return null;
    const chunk = Buffer.from(bytes);
    chunks.push(chunk);
    offset += chunk.length;
  }
  return Buffer.concat(chunks, offset);
}

async function defaultStatFile(
  path: string,
): Promise<CodexRolloutFileStat | null> {
  try {
    const value = await stat(path);
    return {
      size: value.size,
      mtimeMs: value.mtimeMs,
      dev: value.dev,
      ino: value.ino,
      isFile: value.isFile(),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

async function defaultReadFileRange(
  path: string,
  start: number,
  length: number,
): Promise<Uint8Array | null> {
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}

export function makeCodexRolloutFillProvider(
  options: CodexRolloutFillProviderOptions = {},
): CodexRolloutFillProvider {
  const statFile = options.statFile ?? defaultStatFile;
  const readFileRange = options.readFileRange ?? defaultReadFileRange;
  const now = options.now ?? Date.now;
  const refreshIntervalMs = Math.max(
    0,
    options.refreshIntervalMs ?? CODEX_ROLLOUT_REFRESH_INTERVAL_MS,
  );
  const maxConcurrentReads = Math.max(
    1,
    Math.floor(options.maxConcurrentReads ?? 4),
  );
  const maxEntries = Math.max(
    1,
    Math.floor(options.maxEntries ?? CODEX_ROLLOUT_MAX_CACHE_ENTRIES),
  );
  let activeReads = 0;
  const readWaiters: Array<() => void> = [];
  const cache = new Map<string, FillCacheEntry>();

  const evictOldestSettled = (): boolean => {
    let oldestPath: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [candidatePath, candidate] of cache) {
      if (candidate.inFlight || candidate.lastAccessAt >= oldestAccess) continue;
      oldestPath = candidatePath;
      oldestAccess = candidate.lastAccessAt;
    }
    return oldestPath === null ? false : cache.delete(oldestPath);
  };

  const trimCache = (): void => {
    while (cache.size > maxEntries && evictOldestSettled()) {
      // At most `maxEntries` settled paths survive. In-flight paths are retained
      // until their callers finish, then the next completion trims them.
    }
  };

  const withReadPermit = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (activeReads >= maxConcurrentReads) {
      await new Promise<void>((resolve) => readWaiters.push(resolve));
    } else {
      activeReads += 1;
    }
    try {
      return await operation();
    } finally {
      activeReads -= 1;
      const next = readWaiters.shift();
      if (next) {
        activeReads += 1;
        next();
      }
    }
  };

  const parseLine = (entry: FillCacheEntry, lineBytes: Buffer): void => {
    const line = lineBytes.toString("utf8").trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object") return;
      const latest = parseCodexTokenUsageEvent(
        parsed as Record<string, unknown>,
      );
      if (!latest) return;
      entry.snapshot = {
        token_count: latest.total_tokens,
        context_window: CODEX_CONTEXT_WINDOW,
        context_pct: Math.min(
          100,
          Math.max(
            0,
            Math.round((latest.total_tokens / CODEX_CONTEXT_WINDOW) * 100),
          ),
        ),
        observed_model_context_window: latest.model_context_window,
      };
    } catch {
      // Malformed live rows are ignored; a complete later row can recover.
    }
  };

  const ingest = (
    entry: FillCacheEntry,
    bytes: Buffer,
    discardLeadingPartial: boolean,
  ): void => {
    let combined =
      entry.pending.length > 0
        ? Buffer.concat([entry.pending, bytes])
        : bytes;
    entry.pending = Buffer.alloc(0);
    if (entry.discardingLine || discardLeadingPartial) {
      const newline = combined.indexOf(0x0a);
      if (newline < 0) {
        entry.discardingLine = true;
        return;
      }
      entry.discardingLine = false;
      combined = combined.subarray(newline + 1);
    }

    let lineStart = 0;
    while (lineStart < combined.length) {
      const newline = combined.indexOf(0x0a, lineStart);
      if (newline < 0) break;
      if (newline - lineStart <= CODEX_ROLLOUT_MAX_PENDING_LINE_BYTES) {
        parseLine(entry, combined.subarray(lineStart, newline));
      }
      lineStart = newline + 1;
    }
    if (lineStart < combined.length) {
      const pending = combined.subarray(lineStart);
      if (pending.length <= CODEX_ROLLOUT_MAX_PENDING_LINE_BYTES) {
        entry.pending = Buffer.from(pending);
      } else {
        entry.discardingLine = true;
      }
    }
  };

  const resetReader = (entry: FillCacheEntry): void => {
    entry.snapshot = null;
    entry.identity = null;
    entry.size = 0;
    entry.mtimeMs = 0;
    entry.cursor = 0;
    entry.continuity = Buffer.alloc(0);
    entry.pending = Buffer.alloc(0);
    entry.discardingLine = false;
  };

  const cloneReader = (entry: FillCacheEntry): FillCacheEntry => ({
    ...entry,
    continuity: Buffer.from(entry.continuity),
    pending: Buffer.from(entry.pending),
  });

  const commitReader = (
    target: FillCacheEntry,
    source: FillCacheEntry,
  ): void => {
    target.snapshot = source.snapshot;
    target.identity = source.identity;
    target.size = source.size;
    target.mtimeMs = source.mtimeMs;
    target.cursor = source.cursor;
    target.continuity = source.continuity;
    target.pending = source.pending;
    target.discardingLine = source.discardingLine;
  };

  const bootstrap = async (
    path: string,
    entry: FillCacheEntry,
    fileStat: CodexRolloutFileStat,
  ): Promise<CodexRolloutFill | null> => {
    const start = Math.max(
      0,
      fileStat.size - CODEX_ROLLOUT_MAX_TAIL_BYTES,
    );
    const bytes = await readRangeFully(
      readFileRange,
      path,
      start,
      fileStat.size - start,
    );
    if (!bytes) return entry.snapshot;

    const draft = cloneReader(entry);
    ingest(draft, bytes, start > 0);
    draft.identity = `${fileStat.dev}:${fileStat.ino}`;
    draft.size = fileStat.size;
    draft.mtimeMs = fileStat.mtimeMs;
    draft.cursor = fileStat.size;
    draft.continuity = Buffer.from(
      bytes.subarray(
        Math.max(0, bytes.length - CODEX_ROLLOUT_CONTINUITY_BYTES),
      ),
    );
    commitReader(entry, draft);
    return entry.snapshot;
  };

  const refreshEntry = async (
    path: string,
    entry: FillCacheEntry,
  ): Promise<CodexRolloutFill | null> => {
    const fileStat = await statFile(path);
    if (!fileStat) {
      resetReader(entry);
      return null;
    }
    if (!fileStat.isFile || fileStat.size <= 0) {
      resetReader(entry);
      return null;
    }
    const identity = `${fileStat.dev}:${fileStat.ino}`;
    const identityChanged =
      entry.identity !== null && entry.identity !== identity;
    const truncated = entry.identity === identity && fileStat.size < entry.cursor;
    const sameSizeRewrite =
      entry.identity === identity &&
      fileStat.size === entry.cursor &&
      fileStat.mtimeMs !== entry.mtimeMs;
    if (
      entry.identity === null ||
      identityChanged ||
      truncated ||
      sameSizeRewrite
    ) {
      resetReader(entry);
      return bootstrap(path, entry, fileStat);
    }

    if (fileStat.size === entry.cursor) return entry.snapshot;
    if (entry.continuity.length > 0) {
      const actual = await readRangeFully(
        readFileRange,
        path,
        entry.cursor - entry.continuity.length,
        entry.continuity.length,
      );
      if (!actual) return entry.snapshot;
      if (!actual.equals(entry.continuity)) {
        resetReader(entry);
        return bootstrap(path, entry, fileStat);
      }
    }

    const growth = fileStat.size - entry.cursor;
    if (growth > CODEX_ROLLOUT_MAX_TAIL_BYTES) {
      resetReader(entry);
      return bootstrap(path, entry, fileStat);
    }
    const appended = await readRangeFully(
      readFileRange,
      path,
      entry.cursor,
      growth,
    );
    if (!appended) return entry.snapshot;
    const draft = cloneReader(entry);
    ingest(draft, appended, false);
    draft.size = fileStat.size;
    draft.mtimeMs = fileStat.mtimeMs;
    draft.cursor = fileStat.size;
    draft.continuity = Buffer.concat([
      draft.continuity,
      appended,
    ]).subarray(-CODEX_ROLLOUT_CONTINUITY_BYTES);
    commitReader(entry, draft);
    return entry.snapshot;
  };

  return {
    async get(path: string): Promise<CodexRolloutFill | null> {
      if (!isAbsolute(path)) return null;
      const checkedAt = now();
      let entry = cache.get(path);
      if (!entry) {
        while (cache.size >= maxEntries && evictOldestSettled()) {
          // Make room for this newly accessed path when a settled entry exists.
        }
        if (cache.size >= maxEntries) return null;
        entry = {
          snapshot: null,
          identity: null,
          size: 0,
          mtimeMs: 0,
          cursor: 0,
          continuity: Buffer.alloc(0),
          pending: Buffer.alloc(0),
          discardingLine: false,
          lastCheckedAt: Number.NEGATIVE_INFINITY,
          lastAccessAt: checkedAt,
          inFlight: null,
        };
        cache.set(path, entry);
      }
      entry.lastAccessAt = checkedAt;
      if (checkedAt - entry.lastCheckedAt < refreshIntervalMs) {
        return entry.snapshot;
      }
      if (!entry.inFlight) {
        const refresh = withReadPermit(() => refreshEntry(path, entry!))
          .then((snapshot) => {
            entry!.snapshot = snapshot;
            entry!.lastCheckedAt = now();
            return snapshot;
          })
          .catch(() => {
            entry!.lastCheckedAt = now();
            return entry!.snapshot;
          })
          .finally(() => {
            if (entry!.inFlight === refresh) entry!.inFlight = null;
            trimCache();
          });
        entry.inFlight = refresh;
      }
      if (entry.snapshot) {
        void entry.inFlight;
        return entry.snapshot;
      }
      return entry.inFlight;
    },
  };
}
