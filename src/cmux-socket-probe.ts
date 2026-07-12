/**
 * Shared socket probe helpers for createCmuxClient and transport self-healing.
 */

import * as net from "node:net";
import { CmuxPersistentSocket } from "./cmux-persistent-socket.js";
import {
  cmuxSocketPathCandidates,
  nightlySocketPathCandidates,
} from "./cmux-socket-path.js";

export interface SocketProbeOptions {
  socketPath?: string;
  socketStateDir?: string;
  timeoutMs?: number;
  password?: string;
}

export interface SocketProbeResult {
  usable: boolean;
  socketPath: string;
  denied_reason?: "access-control";
  error?: string;
}

/**
 * Bound on the probe `system.ping`. A wedged cmux can ACCEPT the socket connect
 * but never answer (the Surface.deinit deadlock), and probing every candidate
 * would otherwise inherit the 10s request timeout and stall startup ~10s per
 * hung instance. The probe only needs a liveness yes/no, so cap it short.
 */
const PROBE_PING_TIMEOUT_MS = 2000;
const ACCESS_CONTROL_DENIED_RE =
  /Access denied\s*[—-]\s*only processes started inside cmux can connect/i;

export function isCmuxAccessControlDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ACCESS_CONTROL_DENIED_RE.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (/(?:^|\.)nightly$/i.test(process.env.CMUX_BUNDLE_ID?.trim() ?? "")) {
    return nightlySocketPathCandidates({ stateDir: opts?.socketStateDir });
  }
  return cmuxSocketPathCandidates({ stateDir: opts?.socketStateDir });
}

export async function probeUsableSocket(
  socketPath: string,
  opts?: Pick<SocketProbeOptions, "timeoutMs" | "password">,
): Promise<boolean> {
  return (await probeSocketHealth(socketPath, opts)).usable;
}

export async function probeSocketHealth(
  socketPath: string,
  opts?: Pick<SocketProbeOptions, "timeoutMs" | "password">,
): Promise<SocketProbeResult> {
  if (!(await probeSocket(socketPath, opts?.timeoutMs))) {
    return { usable: false, socketPath };
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
    return { usable: result.pong === true, socketPath };
  } catch (error) {
    const message = errorMessage(error);
    if (isCmuxAccessControlDenied(error)) {
      return {
        usable: false,
        socketPath,
        denied_reason: "access-control",
        error: message,
      };
    }
    return { usable: false, socketPath, error: message };
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
