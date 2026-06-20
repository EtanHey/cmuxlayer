/**
 * Factory: creates the best available cmux client.
 * Tries socket first (1,400x faster), falls back to CLI.
 */

import * as net from "node:net";
import { CmuxClient, type ExecFn } from "./cmux-client.js";
import { CmuxPersistentSocket } from "./cmux-persistent-socket.js";
import { CmuxSocketClient } from "./cmux-socket-client.js";
import { cmuxSocketPathCandidates } from "./cmux-socket-path.js";

export interface CreateCmuxClientOptions {
  socketPath?: string;
  /** Override cmux state dir for tests or nonstandard installs */
  socketStateDir?: string;
  /** CLI exec function (for testing) */
  exec?: ExecFn;
  /** CLI binary name */
  bin?: string;
  /** Socket timeout in ms */
  timeoutMs?: number;
  /** Password for socket access mode "password" */
  password?: string;
  /** Boot transport logger; defaults to console */
  logger?: Pick<Console, "error">;
}

/**
 * Bound on the probe `system.ping`. A wedged cmux can ACCEPT the socket connect
 * but never answer (the Surface.deinit deadlock), and probing every candidate
 * would otherwise inherit the 10s request timeout and stall startup ~10s per
 * hung instance. The probe only needs a liveness yes/no, so cap it short.
 */
const PROBE_PING_TIMEOUT_MS = 2000;

/**
 * Probe whether a Unix socket is listening.
 * Connects, immediately disconnects. Returns true if connect succeeds.
 */
function probeSocket(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path }, () => {
      sock.destroy();
      resolve(true);
    });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    sock.on("connect", () => clearTimeout(timer));
  });
}

async function resolveSocketPath(
  opts?: Pick<
    CreateCmuxClientOptions,
    "socketPath" | "socketStateDir" | "timeoutMs" | "password"
  >,
): Promise<string | null> {
  for (const candidate of candidateSocketPaths(opts)) {
    if (await probeUsableSocket(candidate, opts)) {
      return candidate;
    }
  }

  return null;
}

function instancePin(
  opts?: Pick<CreateCmuxClientOptions, "socketPath">,
): string | undefined {
  if (opts?.socketPath) return opts.socketPath;
  const fromEnv = (process.env.CMUX_SOCKET_PATH ?? "").trim();
  return fromEnv.length > 0 ? fromEnv : undefined;
}

function candidateSocketPaths(
  opts?: Pick<CreateCmuxClientOptions, "socketPath" | "socketStateDir">,
): string[] {
  // An explicit socketPath or CMUX_SOCKET_PATH is AUTHORITATIVE: cmux sets
  // CMUX_SOCKET_PATH in each agent's env to point at the instance that spawned
  // it, so when it is present we bind to that one instance only and never fall
  // through to another cmux's socket (which is how panes ended up in a
  // different / nightly app). Only when nothing is pinned do we probe the
  // ordered candidate list.
  const pinned = instancePin(opts);
  if (pinned) return [pinned];
  return cmuxSocketPathCandidates({ stateDir: opts?.socketStateDir });
}

async function probeUsableSocket(
  socketPath: string,
  opts?: Pick<CreateCmuxClientOptions, "timeoutMs" | "password">,
): Promise<boolean> {
  if (!(await probeSocket(socketPath, opts?.timeoutMs))) {
    return false;
  }

  const transport = new CmuxPersistentSocket({
    socketPath,
    // Cap the probe ping so a hung-but-accepting candidate can't stall the
    // probe-all loop by the full request timeout. A caller-supplied timeout
    // (tests) still wins when smaller.
    timeoutMs: Math.min(
      opts?.timeoutMs ?? PROBE_PING_TIMEOUT_MS,
      PROBE_PING_TIMEOUT_MS,
    ),
  });

  try {
    if (opts?.password) {
      await transport.call("auth.login", { password: opts.password });
    }
    const result = await transport.call<{ pong: boolean }>("system.ping");
    return result.pong === true;
  } catch {
    return false;
  } finally {
    transport.disconnect();
  }
}

/**
 * Create the best available cmux client.
 * Tries socket first (0.2ms per op), falls back to CLI (287ms per op).
 */
export async function createCmuxClient(
  opts?: CreateCmuxClientOptions,
): Promise<CmuxClient | CmuxSocketClient> {
  const logger = opts?.logger ?? console;
  const cliFallback = new CmuxClient({ exec: opts?.exec, bin: opts?.bin });

  const candidates = candidateSocketPaths(opts);
  const pinned = instancePin(opts) !== undefined;

  // Probe every candidate up front. Dead candidates fail instantly (the socket
  // path does not exist → ENOENT), so this stays cheap, and it lets us detect
  // when more than one cmux instance is actually LIVE — the real "which app?"
  // ambiguity — rather than warning on every multi-path candidate list.
  const usable: string[] = [];
  for (const socketPath of candidates) {
    if (await probeUsableSocket(socketPath, opts)) {
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
    // Verify socket actually works (catches auth failures)
    try {
      await client.ping();
      logger.error("[cmuxlayer] transport selected: socket");
      if (!pinned && usable.length > 1) {
        // Multiple cmux instances are live and nothing pins us to one: surface
        // which we bound to so a wrong-app/window placement is diagnosable and
        // the operator can pin it explicitly.
        logger.error(
          `[cmuxlayer] ${usable.length} live cmux sockets found and CMUX_SOCKET_PATH ` +
            `is not set; bound to ${socketPath} by probe order. If new panes open in the ` +
            `wrong cmux app/window, set CMUX_SOCKET_PATH to pin this MCP to the instance ` +
            `you are using.`,
        );
      }
      return client;
    } catch {
      // Socket reachable but not usable (auth required, protocol mismatch, etc.)
      // Try the next usable candidate before falling through to CLI.
    }
  }

  logger.error("[cmuxlayer] transport selected: cli");
  return cliFallback;
}
