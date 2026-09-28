// #911: inbox tailers are owned, and reaped when their agent is gone.
//
// A seat arms its mailbox by starting a detached supervisor
// (`cmuxlayer-inbox-tail ...`) whose child is `tail -n0 -F <agent>/inbox.jsonl`.
// Only stop_agent used to reap it, so every other close path, and every agent
// whose record went away while no daemon was watching, leaked one tailer
// (93 on 2026-09-27, 11 of them live). Ownership is derived from what is on
// disk and in `ps`, never from daemon memory, so a restarted daemon sees
// exactly what the old one would have.
//
// AIDEV-NOTE: a PID is signalled only after a fresh `ps` of that PID still
// shows the same start time and the same tailer command line. A recycled PID
// is reported as `pid_reused` and left alone. Never a pattern killer.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { agentDir, inboxPath, inboxTailPidPath, type InboxOpts } from "./inbox.js";
import { sleep } from "./util/sleep.js";

const execFileAsync = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  started_at: string;
  command: string;
}

export interface InboxTailer {
  agent_id: string;
  inbox_path: string;
  /** The detached supervisor, when there is one (a bare legacy tail has none). */
  wrapper_pid: number | null;
  wrapper_started_at: string | null;
  wrapper_token: string | null;
  tail_pid: number | null;
  tail_started_at: string | null;
  /** The agent's own inbox-tail.pid names this supervisor (or bare tail). */
  recorded: boolean;
}

export type TailOwnerState = "live" | "gone" | "unknown";

export type TailReapOutcome = "reaped" | "pid_reused" | "signal_failed" | "owner_changed";

// `ps -o lstart` in the C locale: "Sun Sep 28 10:24:20 2026".
const ROW_RE =
  /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/;
// Current title: `cmuxlayer-inbox-tail <agent_id> <token>`. Legacy title:
// `cmuxlayer-inbox-tail:<token>`, possibly followed by leaked environment.
const WRAPPER_RE =
  /^cmuxlayer-inbox-tail(?::([A-Za-z0-9-]{8,128})|\s+(\S+)\s+([A-Za-z0-9-]{8,128}))(?:\s|$)/;
const TOKEN_RECORD_RE = /^([1-9][0-9]*)(?: ([A-Za-z0-9-]{8,128}))?\n?$/;

export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = ROW_RE.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      started_at: match[3]!.replace(/\s+/g, " "),
      command: match[4]!.trimEnd(),
    });
  }
  return rows;
}

function tailAgentId(command: string, baseDir: string): string | null {
  const prefix = `tail -n0 -F ${baseDir}/`;
  if (!command.startsWith(prefix) || !command.endsWith("/inbox.jsonl")) return null;
  const agentId = command.slice(prefix.length, -"/inbox.jsonl".length);
  return agentId && !agentId.includes("/") ? agentId : null;
}

function readRecord(agentId: string, opts?: InboxOpts): { pid: number; token: string | null } | null {
  try {
    const match = TOKEN_RECORD_RE.exec(readFileSync(inboxTailPidPath(agentId, opts), "utf8"));
    return match ? { pid: Number(match[1]), token: match[2] ?? null } : null;
  } catch {
    return null;
  }
}

/** Group one `ps` snapshot into supervisor+tail pairs keyed by the inbox they tail. */
export function observeInboxTailers(rows: ProcessRow[], opts?: InboxOpts): InboxTailer[] {
  // Spelled the way `inboxPath` spells it (through `join`), so a configured
  // base dir with a trailing or doubled slash still matches the tail command.
  const baseDir = dirname(agentDir("x", opts));
  const tails = rows.filter((row) => tailAgentId(row.command, baseDir) !== null);
  const tailers: InboxTailer[] = [];
  const claimedTails = new Set<number>();
  for (const row of rows) {
    const match = WRAPPER_RE.exec(row.command);
    if (!match) continue;
    const child = tails.find((tail) => tail.ppid === row.pid) ?? null;
    const childAgent = child ? tailAgentId(child.command, baseDir) : null;
    const titledAgent = match[2] ?? null;
    // A legacy supervisor is attributed through its child; a titled one must
    // agree with its child, or it is not ours to judge.
    const agentId = titledAgent ?? childAgent;
    if (!agentId || (titledAgent && childAgent && titledAgent !== childAgent)) continue;
    // A title alone says nothing about which inbox root owns the supervisor.
    // With no scoped child, require this root's pidfile and token to identify
    // it. Otherwise every scratch sweep invents a path under its own root for
    // every live fleet supervisor with a title.
    if (!child) {
      const record = readRecord(agentId, opts);
      if (record?.pid !== row.pid || record.token !== (match[1] ?? match[3] ?? null)) continue;
    }
    if (child) claimedTails.add(child.pid);
    tailers.push({
      agent_id: agentId,
      inbox_path: inboxPath(agentId, opts),
      wrapper_pid: row.pid,
      wrapper_started_at: row.started_at,
      wrapper_token: match[1] ?? match[3] ?? null,
      tail_pid: child?.pid ?? null,
      tail_started_at: child?.started_at ?? null,
      recorded: false,
    });
  }
  for (const tail of tails) {
    if (claimedTails.has(tail.pid)) continue;
    const agentId = tailAgentId(tail.command, baseDir)!;
    tailers.push({
      agent_id: agentId,
      inbox_path: inboxPath(agentId, opts),
      wrapper_pid: null,
      wrapper_started_at: null,
      wrapper_token: null,
      tail_pid: tail.pid,
      tail_started_at: tail.started_at,
      recorded: false,
    });
  }
  for (const tailer of tailers) {
    const record = readRecord(tailer.agent_id, opts);
    tailer.recorded =
      record !== null &&
      (tailer.wrapper_pid !== null
        ? record.pid === tailer.wrapper_pid && record.token === tailer.wrapper_token
        : record.pid === tailer.tail_pid && record.token === null);
  }
  return tailers;
}

export async function snapshotProcessRows(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync(
    "ps",
    ["-axww", "-o", "pid=,ppid=,lstart=,command="],
    { encoding: "utf8", timeout: 2_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
  );
  return parseProcessRows(stdout);
}

/** One fresh `ps` of one PID; null only when ps reports it absent. */
export async function probeProcess(pid: number): Promise<ProcessRow | null> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-ww", "-o", "pid=,ppid=,lstart=,command=", "-p", String(pid)],
      { encoding: "utf8", timeout: 1_000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    return parseProcessRows(stdout)[0] ?? null;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return null;
    throw error;
  }
}

export interface TailReapDeps {
  probe?: (pid: number) => Promise<ProcessRow | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Synchronous, immediately before each signal: false keeps the tailer. */
  beforeSignal?: () => boolean;
}

/**
 * Stop one observed tailer. The tail goes first so its supervisor exits on its
 * own and clears its pidfile; the supervisor is signalled only if it lingers.
 * Every signal is preceded by a fresh identity probe of that exact PID.
 */
export async function reapObservedTailer(
  tailer: InboxTailer,
  deps: TailReapDeps = {},
): Promise<TailReapOutcome> {
  const probe = deps.probe ?? probeProcess;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sameProcess = async (
    pid: number,
    startedAt: string | null,
    owns: (command: string) => boolean,
  ): Promise<"same" | "gone" | "reused"> => {
    const row = await probe(pid);
    if (!row) return "gone";
    return row.started_at === startedAt && owns(row.command) ? "same" : "reused";
  };
  const isTail = (command: string) => command === `tail -n0 -F ${tailer.inbox_path}`;
  const isWrapper = (command: string) => {
    const match = WRAPPER_RE.exec(command);
    return match !== null && (match[1] ?? match[3]) === tailer.wrapper_token;
  };
  let reused = false;
  if (tailer.tail_pid !== null) {
    const identity = await sameProcess(tailer.tail_pid, tailer.tail_started_at, isTail);
    if (identity === "reused") reused = true;
    if (identity === "same") {
      if (deps.beforeSignal?.() === false) return "owner_changed";
      try {
        kill(tailer.tail_pid, "SIGTERM");
      } catch {
        return "signal_failed";
      }
    }
  }
  if (tailer.wrapper_pid !== null) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const identity = await sameProcess(tailer.wrapper_pid, tailer.wrapper_started_at, isWrapper);
      if (identity === "gone") break;
      if (identity === "reused") {
        reused = true;
        break;
      }
      if (attempt === 19 || tailer.tail_pid === null) {
        if (deps.beforeSignal?.() === false) return "owner_changed";
        try {
          kill(tailer.wrapper_pid, "SIGTERM");
        } catch {
          return "signal_failed";
        }
        break;
      }
      await sleep(25);
    }
  }
  return reused ? "pid_reused" : "reaped";
}

export interface TailerSweepResult {
  live: InboxTailer[];
  orphaned: InboxTailer[];
  reaped: Array<{ agent_id: string; outcome: TailReapOutcome }>;
}

/** Classify every observed tailer by its owner; reap only those whose owner is proven gone. */
export async function sweepInboxTailers(input: {
  rows: ProcessRow[];
  inboxOpts?: InboxOpts;
  ownerState: (agentId: string) => TailOwnerState | Promise<TailOwnerState>;
  /**
   * Re-judges a `gone` owner right before each signal. The identity probes
   * await, and an owner can resume meanwhile; false keeps the tailer.
   */
  ownerStillGone?: (agentId: string) => boolean;
  reap?: boolean;
  deps?: TailReapDeps;
}): Promise<TailerSweepResult> {
  const result: TailerSweepResult = { live: [], orphaned: [], reaped: [] };
  const states = new Map<string, TailOwnerState>();
  const { ownerStillGone } = input;
  for (const tailer of observeInboxTailers(input.rows, input.inboxOpts)) {
    let state = states.get(tailer.agent_id);
    if (state === undefined) {
      state = await input.ownerState(tailer.agent_id);
      states.set(tailer.agent_id, state);
    }
    if (state !== "gone") {
      result.live.push(tailer);
      continue;
    }
    result.orphaned.push(tailer);
    if (input.reap) {
      result.reaped.push({
        agent_id: tailer.agent_id,
        outcome: await reapObservedTailer(tailer, {
          ...input.deps,
          beforeSignal: ownerStillGone
            ? () => ownerStillGone(tailer.agent_id)
            : input.deps?.beforeSignal,
        }),
      });
    }
  }
  return result;
}
