/**
 * Factory: creates the best available cmux client.
 * Tries socket first (1,400x faster), falls back to CLI with live upgrade.
 */

import { CmuxClient, type ExecFn } from "./cmux-client.js";
import { CmuxSocketClient } from "./cmux-socket-client.js";
import {
  candidateSocketPathsForOpts,
  probeUsableSocket,
  probeSocketHealth,
  resolveSocketPath,
  type SocketProbeResult,
  type SocketProbeOptions,
} from "./cmux-socket-probe.js";
import {
  DEFAULT_PING_RETRY_ATTEMPTS,
  DEFAULT_PING_RETRY_BACKOFF_MS,
  wrapCliWithSelfHeal,
  wrapSocketWithSelfHeal,
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
  /** Max delay for decorrelated-jitter transport re-probe scheduling */
  reprobeCapMs?: number;
  /** Injectable random source for deterministic jitter tests */
  random?: () => number;
  /** Called after the upstream cmux socket remains unreachable past the threshold. */
  onIrrecoverableTransport?: () => void;
  /** Consecutive upstream socket failures required before signaling. */
  irrecoverableMinFailures?: number;
  /** Minimum duration of sustained upstream unreachability before signaling. */
  irrecoverableMinDurationMs?: number;
}

async function probeUsableSocketWithRetry(
  socketPath: string,
  opts?: CreateCmuxClientOptions,
): Promise<SocketProbeResult> {
  const attempts = opts?.pingRetryAttempts ?? DEFAULT_PING_RETRY_ATTEMPTS;
  const backoff = opts?.pingRetryBackoffMs ?? DEFAULT_PING_RETRY_BACKOFF_MS;
  const sleep = opts?.sleep ?? defaultSleep;
  let lastResult: SocketProbeResult = { usable: false, socketPath };

  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await probeSocketHealth(socketPath, opts);
    if (result.usable || result.denied_reason === "access-control") {
      return result;
    }
    lastResult = result;
    if (attempt < attempts - 1) {
      const delayMs = backoff[attempt] ?? backoff[backoff.length - 1] ?? 100;
      await sleep(delayMs);
    }
  }
  return lastResult;
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
  const denied: SocketProbeResult[] = [];
  for (const socketPath of candidates) {
    const probeResult = await probeUsableSocketWithRetry(socketPath, opts);
    if (probeResult.usable) {
      usable.push(socketPath);
    } else if (probeResult.denied_reason === "access-control") {
      denied.push(probeResult);
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
      return wrapSocketWithSelfHeal(client, cliFallback, {
        socketPath,
        factoryOpts: opts,
        reprobeIntervalMs: opts?.reprobeIntervalMs,
        reprobeCapMs: opts?.reprobeCapMs,
        random: opts?.random,
        logger,
        sleep: opts?.sleep,
        onIrrecoverableTransport: opts?.onIrrecoverableTransport,
        irrecoverableMinFailures: opts?.irrecoverableMinFailures,
        irrecoverableMinDurationMs: opts?.irrecoverableMinDurationMs,
      }) as unknown as CmuxSocketClient;
    } catch {
      // Socket reachable but not usable — try next candidate before CLI.
    }
  }

  const accessDenied = denied[0] ?? null;
  if (accessDenied) {
    const error = accessDenied.error ?? "Access denied";
    logger.error(
      `[cmuxlayer] transport denied: access-control (${accessDenied.socketPath}): ${error}`,
    );
  }
  logger.error("[cmuxlayer] transport selected: cli (degraded)");
  return wrapCliWithSelfHeal(cliFallback, {
    socketPath: candidates[0] ?? null,
    factoryOpts: opts,
    reprobeIntervalMs: opts?.reprobeIntervalMs,
    reprobeCapMs: opts?.reprobeCapMs,
    random: opts?.random,
    initialDenial: accessDenied
      ? {
          denied_reason: "access-control",
          socketPath: accessDenied.socketPath,
          error: accessDenied.error ?? "Access denied",
        }
      : undefined,
    logger,
    sleep: opts?.sleep,
    onIrrecoverableTransport: opts?.onIrrecoverableTransport,
    irrecoverableMinFailures: opts?.irrecoverableMinFailures,
    irrecoverableMinDurationMs: opts?.irrecoverableMinDurationMs,
  }) as unknown as CmuxClient;
}

export {
  candidateSocketPathsForOpts,
  probeUsableSocket,
  resolveSocketPath,
} from "./cmux-socket-probe.js";
