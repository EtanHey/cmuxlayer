import net from "node:net";
import { stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreateServerOptions } from "./server.js";
import {
  CmuxLayerProxy,
  runProxy as runProxyRuntime,
  type CmuxLayerProxyOptions,
} from "./proxy.js";
import { defaultDaemonSocketPath as resolveDefaultDaemonSocketPath } from "./daemon-socket-path.js";
import {
  capturedDaemonStderr,
  spawnDaemonProcess,
  type SpawnDaemonOptions,
} from "./daemon-spawn.js";
import {
  DaemonReadinessTimeoutError,
  DaemonStartupFailedError,
  recordDaemonExit,
  recordDaemonLifecycleError,
} from "./daemon-lifecycle-state.js";
import { callerContextFromEnv } from "./caller-context.js";

const DEFAULT_AUTOSTART_TIMEOUT_MS = 5_000;
const DEFAULT_AUTOSTART_POLL_MS = 50;
const DEFAULT_DAEMON_HANDOFF_TIMEOUT_MS = 8_000;

export { resolveDefaultDaemonSocketPath as defaultDaemonSocketPath };

export { spawnDaemonProcess, type SpawnDaemonOptions } from "./daemon-spawn.js";

export interface StartInProcessOptions {
  fallbackWarnings?: string[];
  env?: NodeJS.ProcessEnv;
}

export type ExitFn = (code: number) => void;

export type EntryRuntime =
  | { mode: "daemon-proxy"; proxy: CmuxLayerProxy }
  | { mode: "in-process"; server: McpServer; fallbackWarnings: string[] };

export interface DaemonFirstEntryOptions {
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  output?: Writable;
  logger?: Pick<Console, "error">;
  probeDaemon?: (socketPath: string) => Promise<boolean>;
  spawnDaemon?: (opts: SpawnDaemonOptions) => Promise<unknown> | unknown;
  runProxy?: (opts: CmuxLayerProxyOptions) => Promise<CmuxLayerProxy>;
  startInProcess?: (opts: StartInProcessOptions) => Promise<McpServer>;
  sleep?: (ms: number) => Promise<void>;
  daemonScriptPath?: string;
  autostartTimeoutMs?: number;
  autostartPollMs?: number;
  /** Bound the wait for a draining daemon owner to hand off (#530). */
  daemonHandoffTimeoutMs?: number;
  exit?: ExitFn;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminateSpawnedDaemon(
  spawnedDaemon: unknown,
  logger: Pick<Console, "error">,
): void {
  const kill =
    spawnedDaemon &&
    typeof spawnedDaemon === "object" &&
    "kill" in spawnedDaemon &&
    typeof spawnedDaemon.kill === "function"
      ? spawnedDaemon.kill
      : null;
  if (!kill) {
    return;
  }
  try {
    kill.call(spawnedDaemon, "SIGTERM");
  } catch (error) {
    logger.error(
      "[cmuxlayer] failed to terminate timed-out daemon autostart",
      error,
    );
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function probeDaemonSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const settle = (connected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolveProbe(connected);
    };
    socket.setTimeout(250, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/** The subset of a spawned daemon child that readiness needs to observe. */
export interface DaemonChildLike {
  once?(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  /**
   * Settled exit state. A child that died before readiness attached its
   * listeners will never emit `exit` again, so these fields are the only
   * evidence of why it is gone (#530 review).
   */
  exitCode?: number | null;
  signalCode?: string | null;
  /** Generation marker for lifecycle exit recording (#530 F9). */
  pid?: number | null;
}

export interface DaemonReadinessOptions {
  socketPath: string;
  probeDaemon: (socketPath: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
  /** The spawned daemon, when this process is the one that spawned it. */
  child?: DaemonChildLike | null;
  /** Bounded excerpt of what the child printed on stderr. */
  readStderr?: () => string;
  now?: () => number;
}

/**
 * Wait for the daemon to answer on its socket, ALWAYS settling.
 *
 * #529: the old poll loop watched only the socket. When the spawned daemon
 * fataled on a leftover socket file and exited code 1, nothing rejected — the
 * readiness promise simply never settled and every daemon-dependent tool
 * deadlocked. The child's `exit`/`error` events are now wired straight into
 * the rejection path, and the deadline is a hard bound.
 */
export async function awaitDaemonReadiness(
  opts: DaemonReadinessOptions,
): Promise<void> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const readStderr = () => {
    try {
      return opts.readStderr?.() ?? "";
    } catch {
      return "";
    }
  };

  let onExit: ((code: number | null, signal: string | null) => void) | null =
    null;
  let onError: ((error: Error) => void) | null = null;
  const child = opts.child;
  // #530 review P2-7: once childFailure wins the race, the polling loop must
  // stop. Without this it kept probing and sleeping to the deadline behind an
  // already-settled promise.
  let aborted = false;

  const childFailure = new Promise<never>((_, reject) => {
    if (!child) {
      return;
    }
    // #530 review (Macroscope, src/entry.ts:189): a daemon that dies BEFORE we
    // attach listeners is already gone — node never replays the missed `exit`,
    // so the old wiring reported a readiness TIMEOUT after the full deadline
    // instead of the exit code that actually explains it. Read the settled
    // fields first.
    if (child.exitCode !== null && child.exitCode !== undefined) {
      recordDaemonExit({
        code: child.exitCode,
        signal: child.signalCode ?? null,
        pid: child.pid ?? null,
        stderrExcerpt: readStderr(),
      });
      reject(
        new DaemonStartupFailedError({
          socketPath: opts.socketPath,
          exitCode: child.exitCode,
          signal: child.signalCode ?? null,
          stderrExcerpt: readStderr(),
        }),
      );
      return;
    }
    if (child.signalCode !== null && child.signalCode !== undefined) {
      recordDaemonExit({
        code: null,
        signal: child.signalCode,
        pid: child.pid ?? null,
        stderrExcerpt: readStderr(),
      });
      reject(
        new DaemonStartupFailedError({
          socketPath: opts.socketPath,
          exitCode: null,
          signal: child.signalCode,
          stderrExcerpt: readStderr(),
        }),
      );
      return;
    }
    if (typeof child.once !== "function") {
      return;
    }
    onExit = (code, signal) => {
      // Record here as well as in the spawner: readiness is the authority on
      // "the daemon died before it could serve", whoever spawned it.
      recordDaemonExit({
        code,
        signal,
        pid: child.pid ?? null,
        stderrExcerpt: readStderr(),
      });
      reject(
        new DaemonStartupFailedError({
          socketPath: opts.socketPath,
          exitCode: code,
          signal,
          stderrExcerpt: readStderr(),
        }),
      );
    };
    onError = (error) => {
      recordDaemonLifecycleError(error.message);
      reject(
        new DaemonStartupFailedError({
          socketPath: opts.socketPath,
          reason: `spawn failed: ${error.message}`,
          stderrExcerpt: readStderr(),
          cause: error,
        }),
      );
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
  // Nothing else may observe this promise until the race below.
  childFailure.catch(() => {});

  const polling = (async (): Promise<void> => {
    const deadline = startedAt + opts.timeoutMs;
    for (;;) {
      if (aborted) return;
      if (await opts.probeDaemon(opts.socketPath)) {
        return;
      }
      if (aborted) return;
      if (opts.timeoutMs === 0 || now() >= deadline) {
        throw new DaemonReadinessTimeoutError({
          socketPath: opts.socketPath,
          waitedMs: Math.max(0, now() - startedAt),
          stderrExcerpt: readStderr(),
        });
      }
      await opts.sleep(opts.pollMs);
    }
  })();

  try {
    await Promise.race([polling, childFailure]);
  } finally {
    aborted = true;
    polling.catch(() => {});
    const detach =
      child &&
      (typeof child.off === "function"
        ? child.off.bind(child)
        : typeof child.removeListener === "function"
          ? child.removeListener.bind(child)
          : null);
    if (detach) {
      if (onExit) detach("exit", onExit);
      if (onError) detach("error", onError);
    }
  }
}

export async function startInProcessRuntime(
  opts: StartInProcessOptions = {},
): Promise<McpServer> {
  const [
    { StdioServerTransport },
    { bindStdioLifecycle },
    { createCmuxClient },
    { createServer },
    { drainOutbox, httpDeliver },
    { defaultMonitorRegistryPath, httpNotifyMonitorDeadman },
    { defaultWatchRegistryPath, httpNotifyWatch },
    { ensureNodeMaxOldSpaceEnv, installHeapGuard },
    { FleetSidebarPublisher },
    { makeSelfRegistrationSessionResolver },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./stdio-lifecycle.js"),
    import("./cmux-client-factory.js"),
    import("./server.js"),
    import("./outbox-drainer.js"),
    import("./monitor-registry.js"),
    import("./watch-spec.js"),
    import("./heap-guard.js"),
    import("./fleet-sidebar.js"),
    import("./self-registration.js"),
  ]);

  ensureNodeMaxOldSpaceEnv();
  installHeapGuard();
  const client = await createCmuxClient();
  const runtimeEnv = opts.env ?? process.env;
  const explicitStateDir = runtimeEnv.CMUXLAYER_STATE_DIR?.trim();
  const serverOpts: CreateServerOptions = {
    client,
    safetyCallerContextProvider: () => callerContextFromEnv(runtimeEnv),
    outboxDrain: () => drainOutbox({ deliver: httpDeliver }),
    monitorRegistryPath: defaultMonitorRegistryPath(),
    monitorRegistryNotify: httpNotifyMonitorDeadman,
    watchRegistryPath: defaultWatchRegistryPath(),
    watchNotify: httpNotifyWatch,
    enableCloseForensics: true,
    selfRegistrationSessionResolver: makeSelfRegistrationSessionResolver(),
    fleetSidebarPublisher: new FleetSidebarPublisher(),
    defaultPalette: opts.env?.CMUXLAYER_DEFAULT_PALETTE,
    ...(explicitStateDir ? { stateDir: explicitStateDir } : {}),
    ...(opts.fallbackWarnings
      ? { controlHealthWarnings: opts.fallbackWarnings }
      : {}),
  };
  const server = createServer(serverOpts);
  const transport = new StdioServerTransport();
  let shutdownStarted = false;
  bindStdioLifecycle({
    stdin: process.stdin,
    transport: transport as any,
    shutdown: (reason) => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      const forceExit = setTimeout(() => {
        console.error(`[cmuxlayer] forced stdio shutdown after ${reason}`);
        process.exit(0);
      }, 1_000);
      forceExit.unref();
      void server
        .close()
        .catch((error) => {
          console.error("[cmuxlayer] stdio shutdown failed", error);
        })
        .finally(() => {
          clearTimeout(forceExit);
          process.exit(0);
        });
    },
  });
  await server.connect(transport);
  return server;
}

export function bindProxyStdioLifecycle(opts: {
  input: Readable;
  proxy: Pick<CmuxLayerProxy, "stop">;
  logger: Pick<Console, "error">;
  exit: ExitFn;
}): void {
  let shutdownStarted = false;
  const shutdown = (reason: string) => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    const forceExit = setTimeout(() => {
      opts.logger.error(
        `[cmuxlayer-proxy] forced stdio shutdown after ${reason}`,
      );
      opts.exit(0);
    }, 1_000);
    forceExit.unref?.();
    void opts.proxy.stop().then(
      () => {
        clearTimeout(forceExit);
        opts.exit(0);
      },
      (error) => {
        clearTimeout(forceExit);
        opts.logger.error("[cmuxlayer-proxy] stdio shutdown failed", error);
        opts.exit(1);
      },
    );
  };

  opts.input.once("end", () => shutdown("stdin end"));
  opts.input.once("close", () => shutdown("stdin close"));
}

/**
 * Did the daemon refuse because ANOTHER owner holds the socket? The daemon
 * prints `fatal code=EDAEMONSOCKETINUSE` before exiting, so this is a
 * structured check rather than prose matching (#530).
 */
export function isOwnerBusyFailure(error: unknown): boolean {
  return (
    error instanceof DaemonStartupFailedError &&
    /EDAEMONSOCKETINUSE|DaemonSocketInUseError|socket is already in use/.test(
      error.stderrExcerpt,
    )
  );
}

export interface DaemonHandoffOptions {
  socketPath: string;
  probeDaemon: (socketPath: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
  spawnDaemon: () => Promise<unknown>;
  awaitReady: (child: unknown) => Promise<void>;
  logger: Pick<Console, "error">;
  now?: () => number;
  /**
   * Has the draining owner actually removed its placeholder? Defaults to "the
   * socket path no longer exists". Respawning before this is true wastes the
   * attempt on a daemon that will refuse for the same reason (#530).
   */
  isPathClear?: () => Promise<boolean>;
}

/**
 * Wait out a draining owner rather than starting a competing backend.
 *
 * Poll for a daemon answering on the socket. Once the drainer clears its
 * placeholder, retry the spawn ONCE so the control plane comes back on the
 * daemon path instead of degrading to an in-process runtime that would outlive
 * the successor. Returns true when a daemon is answering.
 */
export async function awaitDaemonHandoff(
  opts: DaemonHandoffOptions,
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  // #530 (Macroscope): only ENOENT means "the placeholder is gone" — the same
  // rule as F2. Treating EACCES/EIO as cleared would respawn into a path we
  // cannot even inspect, spending the single attempt on a daemon that will
  // refuse, and leaving nothing to start once the path really does clear.
  const isPathClear =
    opts.isPathClear ??
    (() =>
      stat(opts.socketPath).then(
        () => false,
        (error: NodeJS.ErrnoException) => error?.code === "ENOENT",
      ));
  let respawned = false;

  for (;;) {
    if (await opts.probeDaemon(opts.socketPath)) {
      return true;
    }
    if (now() >= deadline) {
      return opts.probeDaemon(opts.socketPath);
    }
    await opts.sleep(opts.pollMs);

    // #530 (Macroscope): the respawn must WAIT for the placeholder to go. Firing
    // it on the first probe failure spent the only attempt on a daemon that
    // refused for the very reason we are waiting out, so nothing ever started
    // once the path did clear.
    if (!respawned && (await isPathClear())) {
      respawned = true;
      try {
        const child = await opts.spawnDaemon();
        await opts.awaitReady(child);
        return true;
      } catch (error) {
        opts.logger.error(
          `[cmuxlayer] daemon handoff respawn failed: ${errorText(error)}`,
        );
      }
    }
  }
}

export async function runDaemonFirstEntry(
  opts: DaemonFirstEntryOptions = {},
): Promise<EntryRuntime> {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? console;
  const socketPath = resolveDefaultDaemonSocketPath(env);
  const probeDaemon = opts.probeDaemon ?? probeDaemonSocket;
  const runProxy = opts.runProxy ?? runProxyRuntime;
  const spawnDaemon = opts.spawnDaemon ?? spawnDaemonProcess;
  const startInProcess = opts.startInProcess ?? startInProcessRuntime;
  const sleep = opts.sleep ?? defaultSleep;
  const exit = opts.exit ?? ((code) => process.exit(code));
  const autostartTimeoutMs =
    opts.autostartTimeoutMs ?? DEFAULT_AUTOSTART_TIMEOUT_MS;
  const autostartPollMs = opts.autostartPollMs ?? DEFAULT_AUTOSTART_POLL_MS;
  // Long enough to outlast the daemon's own drain bound (5s) plus its handoff.
  const handoffTimeoutMs =
    opts.daemonHandoffTimeoutMs ?? DEFAULT_DAEMON_HANDOFF_TIMEOUT_MS;

  const startProxy = async (): Promise<EntryRuntime> => {
    const input = opts.input ?? process.stdin;
    const proxy = await runProxy({
      socketPath,
      input,
      output: opts.output,
      logger,
      env,
      spawnDaemonForVersionBump: spawnDaemon,
    });
    bindProxyStdioLifecycle({ input, proxy, logger, exit });
    return {
      mode: "daemon-proxy",
      proxy,
    };
  };

  const fallback = async (warning: string): Promise<EntryRuntime> => {
    logger.error(`[cmuxlayer] WARNING: ${warning}`);
    return {
      mode: "in-process",
      server: await startInProcess({ fallbackWarnings: [warning] }),
      fallbackWarnings: [warning],
    };
  };

  if (env.CMUXLAYER_DEFAULT_PALETTE?.trim()) {
    // A shared daemon cannot observe a child MCP process's environment. Keep
    // palette selection in this process so it remains session-local.
    return {
      mode: "in-process",
      server: await startInProcess({ env }),
      fallbackWarnings: [],
    };
  }

  if (isEnabled(env.CMUXLAYER_FORCE_INPROCESS)) {
    return fallback(
      "CMUXLAYER_FORCE_INPROCESS=1; using heavy in-process runtime instead of daemon proxy",
    );
  }

  if (await probeDaemon(socketPath)) {
    return startProxy();
  }

  let spawnedDaemon: unknown;
  try {
    spawnedDaemon = await spawnDaemon({
      socketPath,
      env,
      daemonScriptPath: opts.daemonScriptPath,
      logger,
    });
  } catch (error) {
    return fallback(
      `daemon unavailable; using heavy in-process runtime after daemon autostart failed at ${socketPath}: ${errorText(
        error,
      )}`,
    );
  }

  let readinessError: unknown = null;
  try {
    await awaitDaemonReadiness({
      socketPath,
      probeDaemon,
      sleep,
      timeoutMs: autostartTimeoutMs,
      pollMs: autostartPollMs,
      child: spawnedDaemon as DaemonChildLike | null,
      readStderr: () => capturedDaemonStderr(spawnedDaemon),
    });
    return startProxy();
  } catch (error) {
    readinessError = error;
  }

  // A daemon that came up on the very last tick still wins the race.
  if (await probeDaemon(socketPath)) {
    return startProxy();
  }

  // #530 (Codex P1): when autostart overlaps a CLEAN SHUTDOWN, the socket path
  // is deliberately a regular-file placeholder whose receipt names the still
  // draining owner, so our spawned daemon refuses and exits at once. Falling
  // back in-process here would start a SECOND backend against the same registry
  // while the old daemon is still handling in-flight mutations — the exact
  // two-sources-of-truth harm the refusal exists to prevent. Wait for the
  // handoff instead: the drainer removes its placeholder when it finishes, and
  // either it or a successor answers on the socket.
  if (isOwnerBusyFailure(readinessError)) {
    terminateSpawnedDaemon(spawnedDaemon, logger);
    const handoff = await awaitDaemonHandoff({
      socketPath,
      probeDaemon,
      sleep,
      timeoutMs: handoffTimeoutMs,
      pollMs: autostartPollMs,
      spawnDaemon: async () => {
        spawnedDaemon = await spawnDaemon({
          socketPath,
          env,
          daemonScriptPath: opts.daemonScriptPath,
          logger,
        });
        return spawnedDaemon;
      },
      awaitReady: (child) =>
        awaitDaemonReadiness({
          socketPath,
          probeDaemon,
          sleep,
          timeoutMs: autostartTimeoutMs,
          pollMs: autostartPollMs,
          child: child as DaemonChildLike | null,
          readStderr: () => capturedDaemonStderr(child),
        }),
      logger,
    });
    if (handoff) {
      return startProxy();
    }
  }

  terminateSpawnedDaemon(spawnedDaemon, logger);
  const detail =
    readinessError instanceof DaemonStartupFailedError
      ? `daemon exited before ready (code=${readinessError.exitCode ?? "none"}, signal=${
          readinessError.signal ?? "none"
        })${
          readinessError.stderrExcerpt
            ? `; daemon stderr: ${readinessError.stderrExcerpt}`
            : ""
        }`
      : `daemon autostart timeout${
          readinessError instanceof DaemonReadinessTimeoutError
            ? ` after ${readinessError.waitedMs}ms`
            : ""
        }`;
  recordDaemonLifecycleError(detail);
  return fallback(
    `daemon unavailable; using heavy in-process runtime after ${detail} at ${socketPath}`,
  );
}
