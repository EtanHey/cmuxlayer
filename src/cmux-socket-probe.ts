/**
 * Shared socket probe helpers for createCmuxClient and transport self-healing.
 */

import * as net from "node:net";
import { CmuxPersistentSocket } from "./cmux-persistent-socket.js";
import { cmuxSocketPathCandidates } from "./cmux-socket-path.js";

export interface SocketProbeOptions {
  socketPath?: string;
  socketStateDir?: string;
  timeoutMs?: number;
  password?: string;
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

function instancePin(
  opts?: Pick<SocketProbeOptions, "socketPath">,
): string | undefined {
  if (opts?.socketPath) return opts.socketPath;
  const fromEnv = (process.env.CMUX_SOCKET_PATH ?? "").trim();
  return fromEnv.length > 0 ? fromEnv : undefined;
}

export function candidateSocketPathsForOpts(
  opts?: Pick<SocketProbeOptions, "socketPath" | "socketStateDir">,
): string[] {
  const pinned = instancePin(opts);
  if (pinned) return [pinned];
  return cmuxSocketPathCandidates({ stateDir: opts?.socketStateDir });
}

export async function probeUsableSocket(
  socketPath: string,
  opts?: Pick<SocketProbeOptions, "timeoutMs" | "password">,
): Promise<boolean> {
  if (!(await probeSocket(socketPath, opts?.timeoutMs))) {
    return false;
  }

  const transport = new CmuxPersistentSocket({
    socketPath,
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

export async function resolveSocketPath(
  opts?: SocketProbeOptions,
): Promise<string | null> {
  for (const candidate of candidateSocketPathsForOpts(opts)) {
    if (await probeUsableSocket(candidate, opts)) {
      return candidate;
    }
  }
  return null;
}
