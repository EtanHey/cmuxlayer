import { execFileSync } from "node:child_process";

export interface ProcessInfo {
  ppid: number;
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
    if (info.command.includes("T3 Code")) return { pid, command: info.command };
    if (pid === 1) break;
    pid = info.ppid;
  }
  return null;
}

function lookupProcess(pid: number): ProcessInfo | undefined {
  const output = execFileSync("ps", ["-ww", "-o", "ppid=,command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(output);
  if (!match) return undefined;
  return { ppid: Number(match[1]), command: match[2] };
}

/** Entrypoints exit cleanly when this returns true; imports remain side-effect free. */
export function refuseUnderT3Code({
  parentPid = process.ppid,
  lookup = lookupProcess,
  writeStderr = (line: string) => process.stderr.write(line),
}: {
  parentPid?: number;
  lookup?: ProcessLookup;
  writeStderr?: (line: string) => unknown;
} = {}): boolean {
  const ancestor = findT3CodeAncestor(parentPid, lookup);
  if (!ancestor) return false;
  const command = ancestor.command.replace(/[\r\n]/g, " ");
  writeStderr(`cmuxlayer: refusing to start under T3 Code (ancestor pid ${ancestor.pid}: ${command})\n`);
  return true;
}
