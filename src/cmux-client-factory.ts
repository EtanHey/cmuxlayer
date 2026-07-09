/**
 * Factory: creates the best available cmux client.
 * Tries socket first (1,400x faster), falls back to CLI with live upgrade.
 */

import { CmuxClient, type ExecFn } from "./cmux-client.js";
import { CmuxSocketClient } from "./cmux-socket-client.js";
import {
  candidateSocketPathsForOpts,
  probeUsableSocket,
  resolveSocketPath,
  type SocketProbeOptions,
} from "./cmux-socket-probe.js";
import {
  DEFAULT_PING_RETRY_ATTEMPTS,
  DEFAULT_PING_RETRY_BACKOFF_MS,
  wrapCliWithSelfHeal,
} from "./cmux-transport-self-heal.js";

export interface CreateCmuxClientOptions extends SocketProbeOptions {
  /** CLI exec function (for testing) */
  exec?: ExecFn;
  /** CLI binary name */
  bin?: string;
  /** Boot transport logger; defaults to console */
  logger?: Pick<Console, "error">;
  /** Startup ping probe attempts per candidate (default 3) */
  pingRetryAttempts?: number;
  /** Backoff ms between startup ping retries */
  pingRetryBackoffMs?: readonly number[];
  /** Injectable sleep for tests */
  sleep?: (ms: number) => Promise<void>;
  /** CLI→socket live re-probe interval when degraded (default 5s) */
  reprobeIntervalMs?: number;
}

async function probeUsableSocketWithRetry(
  socketPath: string,
  opts?: CreateCmuxClientOptions,
): Promise<boolean> {
  const attempts = opts?.pingRetryAttempts ?? DEFAULT_PING_RETRY_ATTEMPTS;
  const backoff = opts?.pingRetryBackoffMs ?? DEFAULT_PING_RETRY_BACKOFF_MS;
  const sleep = opts?.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await probeUsableSocket(socketPath, opts)) {
      return true;
    }
    if (attempt < attempts - 1) {
      const delayMs = backoff[attempt] ?? backoff[backoff.length - 1] ?? 100;
      await sleep(delayMs);
    }
  }
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function instancePin(
  opts?: Pick<CreateCmuxClientOptions, "socketPath">,
): string | undefined {
  if (opts?.socketPath) return opts.socketPath;
  const fromEnv = (process.env.CMUX_SOCKET_PATH ?? "").trim();
  return fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Create the best available cmux client.
 * Tries socket first (0.2ms per op), falls back to CLI (287ms per op) with
 * periodic socket re-probe and live upgrade when the app recovers.
 */
export async function createCmuxClient(
  opts?: CreateCmuxClientOptions,
): Promise<CmuxClient | CmuxSocketClient> {
  const logger = opts?.logger ?? console;
  const cliFallback = new CmuxClient({ exec: opts?.exec, bin: opts?.bin });

  const candidates = candidateSocketPathsForOpts(opts);
  const pinned = instancePin(opts) !== undefined;

  const usable: string[] = [];
  for (const socketPath of candidates) {
    if (await probeUsableSocketWithRetry(socketPath, opts)) {
      usable.push(socketPath);
    }
  }

  for (const socketPath of usable) {
    const client = new CmuxSocketClient({
      socketPath,
      timeoutMs: opts?.timeoutMs,
      password: opts?.password,
      cliFallback,
      socketPathResolver: () => resolveSocketPath(opts),
    });
    try {
      await client.ping();
      logger.error("[cmuxlayer] transport selected: socket");
      if (!pinned && usable.length > 1) {
        logger.error(
          `[cmuxlayer] ${usable.length} live cmux sockets found and CMUX_SOCKET_PATH ` +
            `is not set; bound to ${socketPath} by probe order. If new panes open in the ` +
            `wrong cmux app/window, set CMUX_SOCKET_PATH to pin this MCP to the instance ` +
            `you are using.`,
        );
      }
      return client;
    } catch {
      // Socket reachable but not usable — try next candidate before CLI.
    }
  }

  logger.error("[cmuxlayer] transport selected: cli (degraded)");
  return wrapCliWithSelfHeal(cliFallback, {
    socketPath: candidates[0] ?? null,
    factoryOpts: opts,
    reprobeIntervalMs: opts?.reprobeIntervalMs,
    logger,
    sleep: opts?.sleep,
  }) as unknown as CmuxClient;
}

export {
  candidateSocketPathsForOpts,
  probeUsableSocket,
  resolveSocketPath,
} from "./cmux-socket-probe.js";
