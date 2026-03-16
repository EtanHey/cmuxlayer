/**
 * Factory: creates the best available cmux client.
 * Tries socket first (1,400x faster), falls back to CLI.
 */

import * as net from "node:net";
import { CmuxClient, type ExecFn } from "./cmux-client.js";
import {
  CmuxSocketClient,
  type CmuxSocketClientOptions,
} from "./cmux-socket-client.js";

const DEFAULT_SOCKET_PATH = "/tmp/cmux.sock";

export interface CreateCmuxClientOptions {
  socketPath?: string;
  /** CLI exec function (for testing) */
  exec?: ExecFn;
  /** CLI binary name */
  bin?: string;
  /** Socket timeout in ms */
  timeoutMs?: number;
  /** Password for socket access mode "password" */
  password?: string;
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

/**
 * Create the best available cmux client.
 * Tries socket first (0.2ms per op), falls back to CLI (287ms per op).
 */
export async function createCmuxClient(
  opts?: CreateCmuxClientOptions,
): Promise<CmuxClient | CmuxSocketClient> {
  const socketPath =
    opts?.socketPath ?? process.env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;

  const socketAvailable = await probeSocket(socketPath, opts?.timeoutMs);

  if (socketAvailable) {
    const client = new CmuxSocketClient({
      socketPath,
      timeoutMs: opts?.timeoutMs,
      password: opts?.password,
    });
    // Verify socket actually works (catches auth failures)
    try {
      await client.ping();
      return client;
    } catch {
      // Socket reachable but not usable (auth required, protocol mismatch, etc.)
      // Fall through to CLI
    }
  }

  return new CmuxClient({ exec: opts?.exec, bin: opts?.bin });
}
