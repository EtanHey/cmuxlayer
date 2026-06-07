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

function candidateSocketPaths(
  opts?: Pick<CreateCmuxClientOptions, "socketPath" | "socketStateDir">,
): string[] {
  return opts?.socketPath
    ? [opts.socketPath]
    : cmuxSocketPathCandidates({ stateDir: opts?.socketStateDir });
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
    timeoutMs: opts?.timeoutMs,
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

  for (const socketPath of candidateSocketPaths(opts)) {
    if (!(await probeUsableSocket(socketPath, opts))) {
      continue;
    }

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
      return client;
    } catch {
      // Socket reachable but not usable (auth required, protocol mismatch, etc.)
      // Try the next candidate before falling through to CLI.
    }
  }

  logger.error("[cmuxlayer] transport selected: cli");
  return cliFallback;
}
