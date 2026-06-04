// AIDEV-NOTE: metacommlayer WRITE channel — the sterile dispatch path that replaces send_input.
// orc/lead appends a dispatch to a per-agent inbox FILE; the agent watches it with a persistent
// native Monitor (`tail -n0 -F`) and acts WITHOUT any TUI typing. Pairs with the harness-JSONL
// READ channel (harness-session.ts). Spike findings + design:
// orchestrator/docs.local/handoffs/2026-06-04/metacommlayer-write-channel-SPIKE-findings.md
//
// This module is the deterministic plumbing. It bakes in the 5 spike failure-modes:
//   FM#1 monitor liveness   → heartbeat + monitorAlive()
//   FM#2 gap/replay         → replayUndelivered() works off the ACKED-id set (NOT post-arm tail),
//                             so messages written while the monitor was down are still delivered.
//   FM#3 wedged agent       → pendingDispatches() = orc-side ACK-timeout detector.
//   FM#4 flood auto-stop    → low-rate is a caller convention; recommendedMonitorCommand emits
//                             only inbox lines (no chatter).
//   FM#5 dispatch policy    → events are system-notifications; the agent must be told to treat
//                             inbox events as actionable dispatch (documented; not code).
//
// EPHEMERAL: the inbox/ack files are coordination plumbing, NOT memory. Do NOT auto-ingest them
// into BrainLayer. Only messages explicitly tagged persist:true are candidates for brain_store,
// and that is the caller's decision — this module never touches BrainLayer.
//
// send_input is KEPT as the fallback path — this channel is additive (belt-and-suspenders) until
// proven in production.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InboxMessage {
  id: string;
  ts_ms: number;
  from: string;
  /** Recipient agent id (own-tag) or "orc". Each agent monitors only its own inbox. */
  to: string;
  tag: string;
  task: string;
  /** Opt-in: only persist:true messages are candidates for BrainLayer ingestion (caller's call). */
  persist?: boolean;
}

export interface InboxAck {
  ts_ms: number;
  agent: string;
  /** id of the message being acked. */
  ack_of: string;
  status: string;
}

export interface InboxOpts {
  /** Base dir for agent channels. Default ~/.cmux/agents (override for tests). */
  baseDir?: string;
  /** Injectable clock for determinism (default Date.now). */
  now?: () => number;
}

export interface DispatchInput {
  from: string;
  to?: string;
  tag?: string;
  task: string;
  persist?: boolean;
  /** Optional explicit id/timestamp (else generated). */
  id?: string;
  ts_ms?: number;
}

function baseDirOf(opts: InboxOpts | undefined): string {
  return opts?.baseDir ?? join(homedir(), ".cmux", "agents");
}

function nowOf(opts: InboxOpts | undefined): number {
  return (opts?.now ?? Date.now)();
}

export function agentDir(agentId: string, opts?: InboxOpts): string {
  return join(baseDirOf(opts), agentId);
}
export function inboxPath(agentId: string, opts?: InboxOpts): string {
  return join(agentDir(agentId, opts), "inbox.jsonl");
}
export function ackPath(agentId: string, opts?: InboxOpts): string {
  return join(agentDir(agentId, opts), "inbox.ack.jsonl");
}
export function heartbeatPath(agentId: string, opts?: InboxOpts): string {
  return join(agentDir(agentId, opts), "monitor.heartbeat");
}

function ensureDir(agentId: string, opts?: InboxOpts): void {
  mkdirSync(agentDir(agentId, opts), { recursive: true });
}

function readJsonl<T>(path: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // tolerate partial/corrupt lines — never throw on a live channel
    }
  }
  return out;
}

let idCounter = 0;
function genId(ts: number): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${ts}-${idCounter.toString(36)}`;
}

/**
 * Append a dispatch to an agent's inbox (the deterministic write). Returns the stored message.
 * Atomic append (single writev) so a concurrent reader never sees a half line.
 */
export function dispatch(
  agentId: string,
  input: DispatchInput,
  opts?: InboxOpts,
): InboxMessage {
  ensureDir(agentId, opts);
  const ts = input.ts_ms ?? nowOf(opts);
  const msg: InboxMessage = {
    id: input.id ?? genId(ts),
    ts_ms: ts,
    from: input.from,
    to: input.to ?? agentId,
    tag: input.tag ?? "dispatch",
    task: input.task,
    ...(input.persist ? { persist: true } : {}),
  };
  appendFileSync(inboxPath(agentId, opts), JSON.stringify(msg) + "\n");
  return msg;
}

export function readInbox(agentId: string, opts?: InboxOpts): InboxMessage[] {
  return readJsonl<InboxMessage>(inboxPath(agentId, opts));
}

export function readAcks(agentId: string, opts?: InboxOpts): InboxAck[] {
  return readJsonl<InboxAck>(ackPath(agentId, opts));
}

/** Set of message ids that have been acked. */
export function ackedIds(agentId: string, opts?: InboxOpts): Set<string> {
  return new Set(readAcks(agentId, opts).map((a) => a.ack_of));
}

/**
 * FM#2 — messages not yet acked, in file (oldest-first) order. Works off the ACKED-id set, not a
 * post-arm tail offset, so dispatches written while the monitor was down are STILL replayed on
 * (re)arm. The agent calls this on startup/arm and after each Monitor event, then acts in order.
 */
export function replayUndelivered(
  agentId: string,
  opts?: InboxOpts,
): InboxMessage[] {
  const acked = ackedIds(agentId, opts);
  return readInbox(agentId, opts).filter((m) => !acked.has(m.id));
}

/** Append an ACK (deterministic delivery confirmation) and refresh the liveness heartbeat. */
export function ack(
  agentId: string,
  ackOf: string,
  status: string,
  opts?: InboxOpts,
): InboxAck {
  ensureDir(agentId, opts);
  const record: InboxAck = {
    ts_ms: nowOf(opts),
    agent: agentId,
    ack_of: ackOf,
    status,
  };
  appendFileSync(ackPath(agentId, opts), JSON.stringify(record) + "\n");
  writeHeartbeat(agentId, opts);
  return record;
}

/**
 * FM#3 — orc-side ACK-timeout: undelivered dispatches older than timeoutMs. A non-empty result
 * for a healthy-looking agent means it's wedged / its monitor is dead → fall back to send_input.
 */
export function pendingDispatches(
  agentId: string,
  timeoutMs: number,
  opts?: InboxOpts,
): InboxMessage[] {
  const cutoff = nowOf(opts) - timeoutMs;
  return replayUndelivered(agentId, opts).filter((m) => m.ts_ms <= cutoff);
}

/** FM#1 — heartbeat the agent's monitor writes (on arm + each act) to prove liveness. */
export function writeHeartbeat(agentId: string, opts?: InboxOpts): number {
  ensureDir(agentId, opts);
  const ts = nowOf(opts);
  appendFileSync(heartbeatPath(agentId, opts), `${ts}\n`);
  return ts;
}

/**
 * FM#1 — is the monitor heartbeat fresh within maxAgeMs? false → treat the channel as down.
 * Reads the last written heartbeat timestamp (not file mtime) so it's consistent with the
 * injectable clock and reflects when the agent actually heartbeated.
 */
export function monitorAlive(
  agentId: string,
  maxAgeMs: number,
  opts?: InboxOpts,
): boolean {
  let raw: string;
  try {
    raw = readFileSync(heartbeatPath(agentId, opts), "utf8");
  } catch {
    return false;
  }
  const last = raw.trim().split("\n").filter(Boolean).pop();
  const ts = last ? Number.parseInt(last, 10) : NaN;
  if (!Number.isFinite(ts)) return false;
  return nowOf(opts) - ts <= maxAgeMs;
}

/**
 * The shell command an agent arms via the native Monitor tool (persistent:true). Emits one stdout
 * line per new inbox message (each becomes a Monitor event). Only inbox lines are emitted — no
 * chatter — to avoid Monitor's flood auto-stop (FM#4). Heartbeat (FM#1) is written by the agent
 * via writeHeartbeat() on arm + each act, not by this command (keeps the event stream clean).
 */
export function recommendedMonitorCommand(
  agentId: string,
  opts?: InboxOpts,
): string {
  return `tail -n0 -F ${inboxPath(agentId, opts)}`;
}

/** Continuous-capture log for harnesses without a native Monitor (Codex/Cursor). */
export function surfacedLogPath(agentId: string, opts?: InboxOpts): string {
  return join(agentDir(agentId, opts), "inbox.surfaced.log");
}

/**
 * Codex/Cursor watch command (no native Monitor → no async wake-up). Background-tails the inbox
 * into a surfaced log the agent re-reads each turn. IMPORTANT (honest limitation): this gives
 * continuous CAPTURE, not async wake-up — Codex/Cursor only ACT when they take a turn. The durable
 * queue is the inbox file itself, so the surfaced log is OPTIONAL; the load-bearing requirement is
 * a POLL cadence: call replayUndelivered() at the start of each turn (e.g. each loop tick) and
 * ack() what you handle. A truly-idle, non-looping Codex still needs something to trigger a turn —
 * that residual is the one case where send_input (the kept fallback) is still required.
 */
export function recommendedCodexWatch(
  agentId: string,
  opts?: InboxOpts,
): string {
  return `tail -n0 -F ${inboxPath(agentId, opts)} >> ${surfacedLogPath(agentId, opts)}`;
}
