/**
 * #938: a persistent, size-capped daemon log.
 *
 * The daemon's stderr is piped to the proxy that spawned it and is lost once
 * that proxy exits, so a lifecycle failure (or a connection refused or gated
 * because of one) used to leave no trace. Lines appended here survive it.
 *
 * Disabled until `enableDaemonLog()` is called. A daemon enables it only when
 * given `daemonLog`, and `runDaemon` passes that only outside a test process,
 * so in-process servers and tests never write here unless a test asks.
 * Lines carry STRUCTURED FIELDS ONLY (event, cause/error codes, error names,
 * attempts, counts, pids, durations, basenames): never an error message or
 * other free-form text, so secrets cannot reach the file by construction.
 * `redactLogText` still runs over every field value as a backstop.
 *
 * Appending never touches the disk on the caller's path: lines go into a
 * bounded in-memory queue drained by one async writer, so a reconnect storm
 * cannot put synchronous I/O on the daemon's connection path.
 */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DAEMON_LOG_FILENAME = "daemon.log";
/** One live file plus one rotated `.1` file, each at most this size. */
export const DEFAULT_DAEMON_LOG_MAX_BYTES = 1_000_000;
/** Each structured value is short by design; longer ones are cut. */
const MAX_FIELD_CHARS = 128;
/** The smallest usable cap: one bounded entry (timestamp, pid, event) fits. */
export const MIN_DAEMON_LOG_MAX_BYTES = 256;
/** Lines held while the writer is busy; beyond this they are counted, not kept. */
const MAX_QUEUED_LINES = 1_000;

interface ActiveLog {
  path: string;
  maxBytes: number;
}

let activeLog: ActiveLog | null = null;
let queued: string[] = [];
let droppedLines = 0;
/**
 * The writer draining the active log. Each log gets its own, so a write that
 * is still in flight (or wedged) for an old log never holds up a new one.
 */
interface LogWriter {
  log: ActiveLog;
  done: Promise<void>;
  /** Lines taken off the queue whose write has not finished yet. */
  inFlight: number;
}

let writer: LogWriter | null = null;
/**
 * The last writer per path. A new writer on the same file waits (bounded)
 * for it, so two writers never stat/rename/append one file concurrently
 * and double-rotate it; a wedged old write delays the new log at most this.
 */
const lastWriterByPath = new Map<string, Promise<void>>();
const SAME_PATH_WAIT_MS = 1_000;

function waitForPreviousWriter(path: string): Promise<void> {
  const previous = lastWriterByPath.get(path);
  if (!previous) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SAME_PATH_WAIT_MS);
    timer.unref?.();
    void previous.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function defaultDaemonLogPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CMUXLAYER_DAEMON_LOG_PATH?.trim();
  if (override) return override;
  // A configured state dir (per-run temp dir under Vitest, #948) wins over HOME.
  const stateDir = env.CMUXLAYER_STATE_DIR?.trim();
  if (stateDir) return join(stateDir, DAEMON_LOG_FILENAME);
  return join(homedir(), ".local", "state", "cmuxlayer", DAEMON_LOG_FILENAME);
}

/** Start appending to the daemon log; returns its path. */
export function enableDaemonLog(opts: {
  path?: string;
  maxBytes?: number;
} = {}): string {
  const path = opts.path ?? defaultDaemonLogPath();
  const maxBytes =
    typeof opts.maxBytes === "number" && Number.isFinite(opts.maxBytes)
      ? Math.max(MIN_DAEMON_LOG_MAX_BYTES, Math.floor(opts.maxBytes))
      : DEFAULT_DAEMON_LOG_MAX_BYTES;
  activeLog = { path, maxBytes };
  return path;
}

export function disableDaemonLog(): number {
  // Lines still being written count too: a close that times out mid-write
  // must report them rather than claim nothing was lost.
  const unwritten = queued.length + droppedLines + (writer?.inFlight ?? 0);
  activeLog = null;
  writer = null;
  queued = [];
  droppedLines = 0;
  for (const entry of coalesced.values()) clearTimeout(entry.timer);
  coalesced.clear();
  return unwritten;
}

/** The log path when the daemon log is enabled, else null. */
export function daemonLogPath(): string | null {
  return activeLog?.path ?? null;
}

const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CAPABILITY|AUTH)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// Long token-shaped runs, letters-only included. Without `/` any 32+ run is
// masked (path segments are split by `/` and `.`, so paths stay readable);
// with `/` (standard base64) a 32+ run is masked when it holds a digit.
// `=` only as trailing padding, so structured `key=value` fields survive.
const TOKEN_SHAPED_RUN = /[A-Za-z0-9+_-]{32,}={0,2}/g;
const SLASHED_TOKEN_RUN = /(?=[A-Za-z+/_-]*\d)[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * Mask anything secret-shaped in free text (error messages, causes): the
 * exact cmux capability, secret-looking KEY=VALUE pairs, bearer credentials,
 * and long token-shaped runs.
 */
export function redactLogText(text: string): string {
  const capability = process.env.CMUX_SOCKET_CAPABILITY?.trim();
  let redacted = capability ? text.replaceAll(capability, "[REDACTED]") : text;
  // Bearer first: the assignment rule would otherwise consume the word
  // "Bearer" after `Authorization:` and leave the credential behind.
  redacted = redacted.replace(BEARER, "$1 [REDACTED]");
  redacted = redacted.replace(SECRET_ASSIGNMENT, "$1$2[REDACTED]");
  // Slashed runs first: the no-slash rule would otherwise mask only a long
  // prefix and leave the credential's `/…` tail visible.
  redacted = redacted.replace(SLASHED_TOKEN_RUN, "[REDACTED]");
  return redacted.replace(TOKEN_SHAPED_RUN, "[REDACTED]");
}

/**
 * One field, one line: every line break a viewer might honour (CR, LF, NEL,
 * LS, PS) becomes " | ", and other control characters are dropped, so no
 * field can forge a log entry.
 */
function singleLine(text: string): string {
  return text
    .replace(/\s*[\r\n\u0085\u2028\u2029]+\s*/g, " | ")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
}

export type LogFieldValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogFieldValue>>;

const SAFE_FIELD_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** A code-like value: one line, redacted, restricted charset, short. */
function fieldValue(value: LogFieldValue): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "nan";
  if (typeof value === "boolean") return String(value);
  const safe = redactLogText(singleLine(String(value)))
    .replace(/[^A-Za-z0-9._:/+[\]-]/g, "_");
  return safe.length > MAX_FIELD_CHARS
    ? `${safe.slice(0, MAX_FIELD_CHARS)}…`
    : safe;
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .filter(([key]) => SAFE_FIELD_KEY.test(key))
    .map(([key, value]) => `${key}=${fieldValue(value)}`)
    .join(" ");
}

/** Shorten `text` (with an ellipsis) until it fits `maxBytes` of UTF-8. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const ellipsisBytes = Buffer.byteLength("…");
  if (maxBytes <= ellipsisBytes) return "";
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) + ellipsisBytes > maxBytes) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

/**
 * A complete entry that always fits `maxBytes`: the detail is shortened,
 * never the line split, so rotation can hold every entry whole.
 */
function logLine(event: string, fields: LogFields, maxBytes: number): string {
  const safeEvent = singleLine(event).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
  const prefix = `${new Date().toISOString()} pid=${process.pid} ${safeEvent} `;
  const room = maxBytes - Buffer.byteLength(prefix) - 1;
  return `${prefix}${truncateToBytes(formatFields(fields), Math.max(0, room))}\n`;
}

async function writeBatch(log: ActiveLog, lines: string[]): Promise<void> {
  await mkdir(dirname(log.path), { recursive: true, mode: 0o700 });
  let size = 0;
  try {
    size = (await stat(log.path)).size;
  } catch {
    size = 0;
  }
  let chunk = "";
  let chunkBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line);
    if (size + chunkBytes > 0 && size + chunkBytes + lineBytes > log.maxBytes) {
      if (chunk) {
        await appendFile(log.path, chunk, { encoding: "utf8", mode: 0o600 });
      }
      await rename(log.path, `${log.path}.1`);
      size = 0;
      chunk = "";
      chunkBytes = 0;
    }
    chunk += line;
    chunkBytes += lineBytes;
  }
  if (chunk) {
    await appendFile(log.path, chunk, { encoding: "utf8", mode: 0o600 });
  }
}

async function drainQueue(self: LogWriter): Promise<void> {
  const log = self.log;
  while ((queued.length > 0 || droppedLines > 0) && activeLog === log) {
    const lines = queued;
    queued = [];
    if (droppedLines > 0) {
      lines.push(
        logLine("daemon_log_dropped", { lines: droppedLines }, log.maxBytes),
      );
      droppedLines = 0;
    }
    self.inFlight = lines.length;
    try {
      await writeBatch(log, lines);
    } catch {
      // Best effort by design; stderr still carries the same messages.
    } finally {
      self.inFlight = 0;
    }
  }
}

/**
 * Queue one line. Never throws and never blocks on disk: a full disk,
 * unwritable directory or burst of events must not take the daemon down or
 * stall its connection path.
 */
export function appendDaemonLog(event: string, fields: LogFields = {}): void {
  const log = activeLog;
  if (!log) return;
  let line: string;
  try {
    line = logLine(event, fields, log.maxBytes);
  } catch {
    return;
  }
  if (queued.length >= MAX_QUEUED_LINES) {
    droppedLines += 1;
  } else {
    queued.push(line);
  }
  ensureDraining();
}

function ensureDraining(): void {
  const log = activeLog;
  if (!log || writer?.log === log) return;
  if (queued.length === 0 && droppedLines === 0) return;
  const current: LogWriter = { log, done: Promise.resolve(), inFlight: 0 };
  current.done = waitForPreviousWriter(log.path)
    .then(() => drainQueue(current))
    .finally(() => {
      if (lastWriterByPath.get(log.path) === current.done) {
        lastWriterByPath.delete(log.path);
      }
      if (writer === current) writer = null;
      // Lines queued while this writer was finishing must not be stranded.
      ensureDraining();
    });
  lastWriterByPath.set(log.path, current.done);
  writer = current;
}

/** Repeats of one event+cause inside this window become a single count line. */
export const DEFAULT_COALESCE_WINDOW_MS = 5_000;

interface CoalescedEntry {
  event: string;
  cause: string;
  suppressed: number;
  windowMs: number;
  timer: ReturnType<typeof setTimeout>;
}

const coalesced = new Map<string, CoalescedEntry>();

function emitCoalescedSummary(key: string): void {
  const entry = coalesced.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  coalesced.delete(key);
  if (entry.suppressed > 0) {
    appendDaemonLog(entry.event, {
      cause: entry.cause,
      repeated: entry.suppressed,
      window_ms: entry.windowMs,
    });
  }
}

/**
 * Log the first `event` for a `cause`, then only a count of its repeats per
 * window, so a reconnect storm is one line plus a tally rather than a flood.
 */
export function appendCoalescedDaemonLog(
  event: string,
  cause: string,
  fields: LogFields,
  windowMs = DEFAULT_COALESCE_WINDOW_MS,
): void {
  if (!activeLog) return;
  const key = `${event}\u0000${cause}`;
  const existing = coalesced.get(key);
  if (existing) {
    existing.suppressed += 1;
    return;
  }
  appendDaemonLog(event, fields);
  const timer = setTimeout(() => emitCoalescedSummary(key), windowMs);
  timer.unref?.();
  coalesced.set(key, { event, cause, suppressed: 0, windowMs, timer });
}

/** Wait until every queued line has been written (or dropped). */
export async function flushDaemonLog(): Promise<void> {
  while (writer) {
    await writer.done;
  }
}

/**
 * Emit pending repeat counts, write everything queued, and stop logging.
 * Bounded so a wedged disk cannot hold up a daemon shutdown.
 */
export async function closeDaemonLog(timeoutMs = 500): Promise<void> {
  for (const key of [...coalesced.keys()]) emitCoalescedSummary(key);
  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    flushDaemonLog(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  const unwritten = disableDaemonLog();
  if (unwritten > 0) {
    // Never drop the tail silently: a wedged disk is itself worth knowing.
    console.error(
      `[cmuxlayer-daemon] daemon log close timed out after ${timeoutMs}ms; ${unwritten} line(s) queued or in flight may not be written`,
    );
  }
}

/** A stable code for a thrown value (e.g. `rate_limited`). Never throws. */
export function logErrorCode(error: unknown): string {
  try {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code: unknown }).code;
      if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) {
        return code;
      }
    }
    if (error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name)) {
      return error.name;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

/** The thrown value's class name (e.g. `CmuxSocketError`). Never throws. */
export function logErrorName(error: unknown): string {
  try {
    if (error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name)) {
      return error.name;
    }
    if (error === null) return "null";
    return typeof error === "object" ? "non_error_object" : typeof error;
  } catch {
    return "unknown";
  }
}
