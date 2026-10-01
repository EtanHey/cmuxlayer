import { lstatSync, type Stats } from "node:fs";
import { dirname } from "node:path";

export type DaemonSocketStat = Pick<Stats, "uid" | "mode" | "isSocket" | "isDirectory">;
export type DaemonSocketLstat = (path: string) => DaemonSocketStat | undefined;

export class UnsafeDaemonSocketError extends Error {}

/** Missing endpoints may autostart; existing unsafe objects must never be used. */
export function assertSafeDaemonSocket(
  socketPath: string,
  readStat: DaemonSocketLstat = (path) => lstatSync(path, { throwIfNoEntry: false }),
): void {
  const uid = process.getuid?.();
  const socket = readStat(socketPath);
  if (uid === undefined || (socket && (!socket.isSocket() || socket.uid !== uid))) {
    throw new UnsafeDaemonSocketError(`daemon socket not owned by this user: ${socketPath}`);
  }
  const parentPath = dirname(socketPath);
  const parent = readStat(parentPath);
  if ((socket && !parent) || (parent && (!parent.isDirectory() || (parent.mode & 0o022) !== 0 ||
    (parent.uid !== uid && parent.uid !== 0)))) {
    throw new UnsafeDaemonSocketError(`daemon socket unsafe parent: ${parentPath}`);
  }
}
