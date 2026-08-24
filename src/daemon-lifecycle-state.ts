/**
 * Daemon lifecycle truth: the structured failures every daemon-dependent
 * waiter must see, plus the in-process record that makes a dead daemon look
 * different from a healthy one.
 *
 * #529: a leftover file at the daemon socket path made socket reaping throw,
 * the daemon exited code 1 right after being spawned, and nothing propagated
 * that exit to the readiness waiters — so `list_agents` and `spawn_agent`
 * deadlocked forever while lock-free tools kept answering in milliseconds.
 * Every failure below is deliberately typed and recorded so the same shape can
 * never be silent again.
 */

/** How a connect(2) probe classified the daemon socket path. */
export type DaemonSocketProbe = "live" | "missing" | "stale" | "unknown";

export const DAEMON_SOCKET_IN_USE_CODE = "EDAEMONSOCKETINUSE";
export const DAEMON_STARTUP_FAILED_CODE = "EDAEMONSTARTUPFAILED";
export const DAEMON_READINESS_TIMEOUT_CODE = "EDAEMONREADINESSTIMEOUT";

const STDERR_EXCERPT_LIMIT = 4_000;

export function daemonStderrExcerpt(text: string | undefined | null): string {
  if (!text) return "";
  const trimmed = text.trimEnd();
  return trimmed.length > STDERR_EXCERPT_LIMIT
    ? trimmed.slice(-STDERR_EXCERPT_LIMIT)
    : trimmed;
}

/**
 * The socket path is owned by a daemon that is actually accepting connections
 * (or by a process whose owner receipt proves it is still alive). The caller
 * must CONNECT to it, never reap it.
 */
export class DaemonSocketInUseError extends Error {
  readonly code = DAEMON_SOCKET_IN_USE_CODE;
  readonly socketPath: string;
  readonly ownerPid: number | null;
  readonly probe: DaemonSocketProbe;

  constructor(opts: {
    socketPath: string;
    ownerPid?: number | null;
    probe: DaemonSocketProbe;
  }) {
    const owner =
      opts.ownerPid !== null && opts.ownerPid !== undefined
        ? ` (owner pid ${opts.ownerPid})`
        : "";
    super(
      `cmuxlayer daemon socket is already in use: ${opts.socketPath}${owner} [probe=${opts.probe}]`,
    );
    this.name = "DaemonSocketInUseError";
    this.socketPath = opts.socketPath;
    this.ownerPid = opts.ownerPid ?? null;
    this.probe = opts.probe;
  }
}

/** The spawned daemon child died (or failed to spawn) before it was ready. */
export class DaemonStartupFailedError extends Error {
  readonly code = DAEMON_STARTUP_FAILED_CODE;
  readonly socketPath: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrExcerpt: string;

  constructor(opts: {
    socketPath: string;
    exitCode?: number | null;
    signal?: string | null;
    stderrExcerpt?: string;
    reason?: string;
    cause?: unknown;
  }) {
    const stderr = daemonStderrExcerpt(opts.stderrExcerpt);
    const detail =
      opts.reason ??
      `exited (code=${opts.exitCode ?? "none"}, signal=${opts.signal ?? "none"})`;
    super(
      `cmuxlayer daemon failed to start at ${opts.socketPath}: ${detail}${
        stderr ? `\ndaemon stderr:\n${stderr}` : ""
      }`,
    );
    this.name = "DaemonStartupFailedError";
    this.socketPath = opts.socketPath;
    this.exitCode = opts.exitCode ?? null;
    this.signal = opts.signal ?? null;
    this.stderrExcerpt = stderr;
    if (opts.cause !== undefined) {
      this.cause = opts.cause;
    }
  }
}

/** The daemon never became ready and never died — bounded, never unsettled. */
export class DaemonReadinessTimeoutError extends Error {
  readonly code = DAEMON_READINESS_TIMEOUT_CODE;
  readonly socketPath: string;
  readonly waitedMs: number;
  readonly stderrExcerpt: string;

  constructor(opts: {
    socketPath: string;
    waitedMs: number;
    stderrExcerpt?: string;
  }) {
    const stderr = daemonStderrExcerpt(opts.stderrExcerpt);
    super(
      `cmuxlayer daemon did not become ready at ${opts.socketPath} within ${opts.waitedMs}ms${
        stderr ? `\ndaemon stderr:\n${stderr}` : ""
      }`,
    );
    this.name = "DaemonReadinessTimeoutError";
    this.socketPath = opts.socketPath;
    this.waitedMs = opts.waitedMs;
    this.stderrExcerpt = stderr;
  }
}

export interface DaemonExitRecord {
  code: number | null;
  signal: string | null;
  at: string;
  pid: number | null;
  stderr_excerpt: string;
}

export interface DaemonSocketReapRecord {
  path: string;
  reason: string;
  at: string;
}

export interface DaemonLifecycleSnapshot {
  socket_path: string | null;
  spawn_attempts: number;
  last_spawn_at: string | null;
  last_spawn_pid: number | null;
  last_exit: DaemonExitRecord | null;
  last_socket_reap: DaemonSocketReapRecord | null;
  last_socket_in_use: {
    path: string;
    owner_pid: number | null;
    at: string;
  } | null;
  last_error: string | null;
}

function emptySnapshot(): DaemonLifecycleSnapshot {
  return {
    socket_path: null,
    spawn_attempts: 0,
    last_spawn_at: null,
    last_spawn_pid: null,
    last_exit: null,
    last_socket_reap: null,
    last_socket_in_use: null,
    last_error: null,
  };
}

let state: DaemonLifecycleSnapshot = emptySnapshot();

function nowIso(): string {
  return new Date().toISOString();
}

export function recordDaemonSpawnAttempt(opts: {
  socketPath: string;
  pid?: number | null;
}): void {
  state = {
    ...state,
    socket_path: opts.socketPath,
    spawn_attempts: state.spawn_attempts + 1,
    last_spawn_at: nowIso(),
    last_spawn_pid: opts.pid ?? null,
  };
}

export function recordDaemonExit(opts: {
  code?: number | null;
  signal?: string | null;
  pid?: number | null;
  stderrExcerpt?: string;
}): void {
  state = {
    ...state,
    last_exit: {
      code: opts.code ?? null,
      signal: opts.signal ?? null,
      pid: opts.pid ?? null,
      at: nowIso(),
      stderr_excerpt: daemonStderrExcerpt(opts.stderrExcerpt),
    },
  };
}

export function recordDaemonSocketReap(opts: {
  path: string;
  reason: string;
}): void {
  state = {
    ...state,
    last_socket_reap: { path: opts.path, reason: opts.reason, at: nowIso() },
  };
}

export function recordDaemonSocketInUse(opts: {
  path: string;
  ownerPid: number | null;
}): void {
  state = {
    ...state,
    last_socket_in_use: {
      path: opts.path,
      owner_pid: opts.ownerPid,
      at: nowIso(),
    },
  };
}

export function recordDaemonLifecycleError(message: string): void {
  state = { ...state, last_error: message };
}

export function daemonLifecycleSnapshot(): DaemonLifecycleSnapshot {
  return { ...state };
}

/** Test-only reset so lifecycle observability is deterministic per test. */
export function resetDaemonLifecycleState(): void {
  state = emptySnapshot();
}
