import { homedir } from "node:os";
import { join } from "node:path";

export const DAEMON_SOCKET_FILENAME = "cmuxlayer-stated.sock";

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
    DAEMON_SOCKET_FILENAME,
  );
}
