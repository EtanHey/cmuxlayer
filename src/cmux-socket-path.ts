import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function legacySocketPath(): string {
  return join(homedir(), "Library", "Application Support", "cmux", "cmux.sock");
}

export function defaultStateDir(): string {
  return join(homedir(), ".local", "state", "cmux");
}

export function stateSocketPath(stateDir = defaultStateDir()): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  return uid === null
    ? join(stateDir, "cmux.sock")
    : join(stateDir, `cmux-${uid}.sock`);
}

export function lastSocketPathFile(stateDir = defaultStateDir()): string {
  return join(stateDir, "last-socket-path");
}

export interface CmuxSocketPathCandidateOptions {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}

export function readLastSocketPath(stateDir = defaultStateDir()): string | null {
  try {
    const value = fs.readFileSync(lastSocketPathFile(stateDir), "utf-8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function cmuxSocketPathCandidates(
  opts: CmuxSocketPathCandidateOptions = {},
): string[] {
  const env = opts.env ?? process.env;
  const stateDir = opts.stateDir ?? defaultStateDir();
  const candidates = [
    env.CMUX_SOCKET_PATH,
    readLastSocketPath(stateDir),
    stateSocketPath(stateDir),
    join(stateDir, "cmux.sock"),
    legacySocketPath(),
  ].filter((path): path is string => Boolean(path));

  return [...new Set(candidates)];
}

export const DEFAULT_SOCKET_PATH = legacySocketPath();
