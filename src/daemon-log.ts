/**
 * #938: a persistent, size-capped daemon log.
 *
 * The daemon's stderr is piped to the proxy that spawned it and is lost once
 * that proxy exits, so a lifecycle failure (or a connection refused or gated
 * because of one) used to leave no trace. Lines appended here survive it.
 *
 * Disabled until `enableDaemonLog()` is called; only the daemon process entry
 * (`runDaemon`) enables it, so in-process servers and tests never write here.
 * Lines carry an event name and a message only: never env values, and the
 * cmux capability token is redacted.
 */

import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DAEMON_LOG_FILENAME = "daemon.log";
/** One live file plus one rotated `.1` file, each at most this size. */
export const DEFAULT_DAEMON_LOG_MAX_BYTES = 1_000_000;
const MAX_DETAIL_CHARS = 2_000;

let activeLog: { path: string; maxBytes: number } | null = null;

export function defaultDaemonLogPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CMUXLAYER_DAEMON_LOG_PATH?.trim();
  if (override) return override;
  return join(homedir(), ".local", "state", "cmuxlayer", DAEMON_LOG_FILENAME);
}

/** Start appending to the daemon log; returns its path. */
export function enableDaemonLog(opts: {
  path?: string;
  maxBytes?: number;
} = {}): string {
  const path = opts.path ?? defaultDaemonLogPath();
  const maxBytes =
    typeof opts.maxBytes === "number" && opts.maxBytes > 0
      ? opts.maxBytes
      : DEFAULT_DAEMON_LOG_MAX_BYTES;
  activeLog = { path, maxBytes };
  return path;
}

export function disableDaemonLog(): void {
  activeLog = null;
}

/** The log path when the daemon log is enabled, else null. */
export function daemonLogPath(): string | null {
  return activeLog?.path ?? null;
}

function sanitizeDetail(detail: string): string {
  const capability = process.env.CMUX_SOCKET_CAPABILITY?.trim();
  const redacted = capability
    ? detail.replaceAll(capability, "[REDACTED]")
    : detail;
  const oneLine = redacted.replace(/\s*\r?\n\s*/g, " | ").trim();
  return oneLine.length > MAX_DETAIL_CHARS
    ? `${oneLine.slice(0, MAX_DETAIL_CHARS)}…`
    : oneLine;
}

/**
 * Append one line. Never throws: a full disk or unwritable directory must not
 * take the daemon down with it.
 */
export function appendDaemonLog(event: string, detail: string): void {
  const log = activeLog;
  if (!log) return;
  try {
    const line = `${new Date().toISOString()} pid=${process.pid} ${event} ${sanitizeDetail(detail)}\n`;
    mkdirSync(dirname(log.path), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = statSync(log.path).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > log.maxBytes) {
      renameSync(log.path, `${log.path}.1`);
    }
    appendFileSync(log.path, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best effort by design; stderr still carries the same message.
  }
}

/** A short message for an unknown thrown value. */
export function describeLogError(error: unknown): string {
  if (error instanceof Error) {
    const code =
      "code" in error && typeof (error as { code: unknown }).code === "string"
        ? ` [${(error as { code: string }).code}]`
        : "";
    return `${error.name}: ${error.message}${code}`;
  }
  return String(error);
}
