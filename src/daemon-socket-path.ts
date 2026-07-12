import { homedir } from "node:os";
import { basename, join } from "node:path";

export const DAEMON_SOCKET_FILENAME = "cmuxlayer-stated.sock";
export const NIGHTLY_DAEMON_SOCKET_FILENAME =
  "cmuxlayer-stated-nightly.sock";

function isNightlyAxis(env: NodeJS.ProcessEnv): boolean {
  const upstreamSocket = env.CMUX_SOCKET_PATH?.trim();
  if (upstreamSocket) {
    const socketName = basename(upstreamSocket);
    if (/nightly/i.test(socketName)) {
      return true;
    }
    if (/^cmux-\d+\.sock$/i.test(socketName)) {
      return false;
    }
  }

  return /(?:^|\.)nightly$/i.test(env.CMUX_BUNDLE_ID?.trim() ?? "");
}

export function defaultDaemonSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CMUXLAYER_DAEMON_SOCKET?.trim();
  if (override) {
    return override;
  }
  return join(
    homedir(),
    ".local",
    "state",
    "cmux",
    isNightlyAxis(env)
      ? NIGHTLY_DAEMON_SOCKET_FILENAME
      : DAEMON_SOCKET_FILENAME,
  );
}
