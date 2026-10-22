import { execFileSync } from "node:child_process";

export interface ProcessInfo {
  ppid: number;
  /** Executable path from ps comm, never argv. */
  command: string;
}

export type ProcessLookup = (pid: number) => ProcessInfo | undefined;

/** Pure, bounded ancestry walk. Missing/racing processes deliberately fail open. */
export function findT3CodeAncestor(
  parentPid: number,
  lookup: ProcessLookup,
  maxDepth = 64,
): { pid: number; command: string } | null {
  const seen = new Set<number>();
  let pid = parentPid;
  for (let depth = 0; depth < maxDepth && Number.isSafeInteger(pid) && pid > 0; depth++) {
    if (seen.has(pid)) break;
    seen.add(pid);
    let info: ProcessInfo | undefined;
    try {
      info = lookup(pid);
    } catch {
      return null;
    }
    if (!info) return null;
    if (/\/T3 Code[^/]*\.app\//.test(info.command)) return { pid, command: info.command };
    if (pid === 1) break;
    pid = info.ppid;
  }
  return null;
}

function readProcessTable(): ProcessLookup {
  const output = execFileSync("ps", ["-ww", "-Ao", "pid=,ppid=,comm="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const processes = new Map<number, ProcessInfo>();
  for (const line of output.trim().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("invalid process table row");
    const pid = Number(match[1]), ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(ppid) || processes.has(pid)) {
      throw new Error("invalid process table pid");
    }
    processes.set(pid, { ppid, command: match[3] });
  }
  return (pid) => processes.get(pid);
}

/** Entrypoints exit cleanly when this returns true; imports remain side-effect free. */
export function refuseUnderT3Code({
  parentPid = process.ppid,
  lookup,
  writeStderr = (line: string) => process.stderr.write(line),
}: {
  parentPid?: number;
  lookup?: ProcessLookup;
  writeStderr?: (line: string) => unknown;
} = {}): boolean {
  let ancestor: ReturnType<typeof findT3CodeAncestor>;
  try {
    ancestor = findT3CodeAncestor(parentPid, lookup ?? readProcessTable());
  } catch {
    return false;
  }
  if (!ancestor) return false;
  const command = ancestor.command.replace(/[\r\n]/g, " ");
  writeStderr(`cmuxlayer: refusing to start under T3 Code (ancestor pid ${ancestor.pid}: ${command})\n`);
  return true;
}
