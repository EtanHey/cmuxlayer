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
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

export const DEFAULT_CHANNEL_MARKER_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface ChannelMarkerReaperOpts extends InboxOpts {
  retentionMs?: number;
  dryRun?: boolean;
}

export interface ChannelMarkerReapResult {
  scanned: number;
  reapable: number;
  reaped: number;
  retained_known: number;
  retained_young: number;
  retained_non_pending: number;
  errors: number;
}

export type MonitorHeartbeatSource = "agent" | "server_boot";

export interface MonitorHeartbeat {
  ts_ms: number;
  source: MonitorHeartbeatSource;
}

export type InboxMonitorState = "never-armed" | "alive" | "stale";

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
export function inboxCursorPath(agentId: string, opts?: InboxOpts): string {
  return join(agentDir(agentId, opts), "inbox.cursor");
}
export function heartbeatPath(agentId: string, opts?: InboxOpts): string {
  return join(agentDir(agentId, opts), "monitor.heartbeat");
}

function channelMarkerDir(opts?: InboxOpts): string {
  return join(baseDirOf(opts), ".channel-dirs");
}

function channelMarkerPath(agentId: string, opts?: InboxOpts): string {
  return join(channelMarkerDir(opts), `${encodeURIComponent(agentId)}.created`);
}

const PENDING_AGENT_ID_RE = /^.+-pending-(\d+)-[a-z0-9]+$/i;

function pendingAgentCreatedAtMs(agentId: string): number | null {
  const match = agentId.match(PENDING_AGENT_ID_RE);
  if (!match?.[1]) return null;
  const seconds = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return seconds * 1_000;
}

function markerAgentId(fileName: string): string | null {
  if (!fileName.endsWith(".created")) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -".created".length));
  } catch {
    return null;
  }
}

/**
 * A completed pending-to-real registration makes the provisional marker
 * meaningless. Call only after state and registry rename have both succeeded.
 */
export function removePendingChannelMarkerAfterRegistration(
  previousAgentId: string,
  finalAgentId: string,
  opts?: InboxOpts,
): boolean {
  if (
    previousAgentId === finalAgentId ||
    pendingAgentCreatedAtMs(previousAgentId) === null ||
    pendingAgentCreatedAtMs(finalAgentId) !== null
  ) {
    return false;
  }
  try {
    unlinkSync(channelMarkerPath(previousAgentId, opts));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reap only retained markers for timestamped pending identities that are old
 * enough and absent from the caller's authoritative known-agent snapshot.
 * Non-pending and known-agent markers preserve the deleted-after-create health
 * signal. The pending id timestamp avoids one stat per marker in a saturated
 * directory.
 */
export function reapOrphanedPendingChannelMarkers(
  knownAgentIds: Iterable<string>,
  opts: ChannelMarkerReaperOpts = {},
): ChannelMarkerReapResult {
  const result: ChannelMarkerReapResult = {
    scanned: 0,
    reapable: 0,
    reaped: 0,
    retained_known: 0,
    retained_young: 0,
    retained_non_pending: 0,
    errors: 0,
  };
  let fileNames: string[];
  try {
    fileNames = readdirSync(channelMarkerDir(opts));
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    if (code !== "ENOENT") result.errors += 1;
    return result;
  }
  const known = new Set(knownAgentIds);
  const now = nowOf(opts);
  const requestedRetentionMs =
    opts.retentionMs ?? DEFAULT_CHANNEL_MARKER_RETENTION_MS;
  const retentionMs = Number.isFinite(requestedRetentionMs)
    ? Math.max(0, Math.trunc(requestedRetentionMs))
    : DEFAULT_CHANNEL_MARKER_RETENTION_MS;

  for (const fileName of fileNames) {
    result.scanned += 1;
    const agentId = markerAgentId(fileName);
    const createdAt = agentId ? pendingAgentCreatedAtMs(agentId) : null;
    if (!agentId || createdAt === null) {
      result.retained_non_pending += 1;
      continue;
    }
    if (known.has(agentId)) {
      result.retained_known += 1;
      continue;
    }
    if (now - createdAt < retentionMs) {
      result.retained_young += 1;
      continue;
    }

    result.reapable += 1;
    if (opts.dryRun) continue;
    try {
      unlinkSync(join(channelMarkerDir(opts), fileName));
      result.reaped += 1;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : null;
      if (code !== "ENOENT") result.errors += 1;
    }
  }

  return result;
}

function ensureChannelDirForWrite(agentId: string, opts?: InboxOpts): void {
  mkdirSync(agentDir(agentId, opts), { recursive: true });
  mkdirSync(channelMarkerDir(opts), { recursive: true });
  appendFileSync(channelMarkerPath(agentId, opts), "");
}

export function channelDirExists(agentId: string, opts?: InboxOpts): boolean {
  return existsSync(agentDir(agentId, opts));
}

export function channelDirDeletedAfterCreate(
  agentId: string,
  opts?: InboxOpts,
): boolean {
  return (
    existsSync(channelMarkerPath(agentId, opts)) &&
    !channelDirExists(agentId, opts)
  );
}

export function ensureInboxFile(agentId: string, opts?: InboxOpts): string {
  ensureChannelDirForWrite(agentId, opts);
  const path = inboxPath(agentId, opts);
  appendFileSync(path, "");
  return path;
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

function parseHeartbeatLine(line: string): MonitorHeartbeat | null {
  const [tsText, sourceText] = line.trim().split(/\s+/, 2);
  const ts = Number.parseInt(tsText ?? "", 10);
  if (!Number.isFinite(ts)) return null;
  return {
    ts_ms: ts,
    source: sourceText === "server_boot" ? "server_boot" : "agent",
  };
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
  ensureChannelDirForWrite(agentId, opts);
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

export function dispatchOnce(
  agentId: string,
  input: DispatchInput & { id: string },
  opts?: InboxOpts,
): InboxMessage {
  const existing = readInbox(agentId, opts).find(
    (message) => message.id === input.id,
  );
  return existing ?? dispatch(agentId, input, opts);
}

export function readInbox(agentId: string, opts?: InboxOpts): InboxMessage[] {
  return readJsonl<InboxMessage>(inboxPath(agentId, opts));
}

export function readAcks(agentId: string, opts?: InboxOpts): InboxAck[] {
  return readJsonl<InboxAck>(ackPath(agentId, opts));
}

/** Last message the agent confirms it fully handled. The engine only reads it. */
export function readInboxCursor(
  agentId: string,
  opts?: InboxOpts,
): string | null {
  try {
    const cursor = readFileSync(inboxCursorPath(agentId, opts), "utf8").trim();
    return cursor.length > 0 ? cursor : null;
  } catch {
    return null;
  }
}

/**
 * Agent-side consumption helper. Call only after the message has been handled.
 * The atomic rename prevents a resume from observing a partial watermark.
 */
export function writeInboxCursor(
  agentId: string,
  messageId: string,
  opts?: InboxOpts,
): string {
  ensureChannelDirForWrite(agentId, opts);
  const path = inboxCursorPath(agentId, opts);
  const lockPath = `${path}.lock`;
  let lockAcquired = false;
  let tempPath: string | null = null;
  try {
    try {
      mkdirSync(lockPath);
      lockAcquired = true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new Error(`Inbox cursor is locked for ${agentId}; retry`);
      }
      throw error;
    }

    // Read both the inbox and watermark only after acquiring the lock. This is
    // the compare-and-set boundary across independently resumed agent processes.
    const messages = readInbox(agentId, opts);
    const nextIndex = messages.findIndex((message) => message.id === messageId);
    if (nextIndex < 0) {
      throw new Error(`Cannot advance inbox cursor to unknown message ${messageId}`);
    }
    const current = readInboxCursor(agentId, opts);
    if (current) {
      const currentIndex = messages.findIndex((message) => message.id === current);
      if (currentIndex >= 0 && nextIndex < currentIndex) {
        throw new Error(
          `Cannot move inbox cursor backwards from ${current} to ${messageId}`,
        );
      }
    }
    tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, `${messageId}\n`, "utf8");
    renameSync(tempPath, path);
    tempPath = null;
    return messageId;
  } finally {
    if (tempPath) rmSync(tempPath, { force: true });
    if (lockAcquired) rmSync(lockPath, { recursive: true, force: true });
  }
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
  const messages = readInbox(agentId, opts);
  const cursor = readInboxCursor(agentId, opts);
  if (cursor) {
    const cursorIndex = messages.findIndex((message) => message.id === cursor);
    // An unknown/corrupt cursor cannot safely suppress anything: replay all.
    return cursorIndex >= 0 ? messages.slice(cursorIndex + 1) : messages;
  }
  const acked = ackedIds(agentId, opts);
  return messages.filter((m) => !acked.has(m.id));
}

/** Append an ACK (deterministic delivery confirmation) and refresh the liveness heartbeat. */
export function ack(
  agentId: string,
  ackOf: string,
  status: string,
  opts?: InboxOpts,
): InboxAck {
  ensureChannelDirForWrite(agentId, opts);
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

/**
 * FM#1 — heartbeat the agent's monitor writes (on arm + each act) to prove liveness.
 * Server boot markers share the file for auditability, but do not satisfy monitorAlive().
 */
export function writeHeartbeat(
  agentId: string,
  opts?: InboxOpts,
  source: MonitorHeartbeatSource = "agent",
): number {
  ensureChannelDirForWrite(agentId, opts);
  const ts = nowOf(opts);
  const sourceSuffix = source === "agent" ? "" : ` ${source}`;
  appendFileSync(heartbeatPath(agentId, opts), `${ts}${sourceSuffix}\n`);
  return ts;
}

export function readLastHeartbeat(
  agentId: string,
  opts?: InboxOpts,
): MonitorHeartbeat | null {
  let raw: string;
  try {
    raw = readFileSync(heartbeatPath(agentId, opts), "utf8");
  } catch {
    return null;
  }
  const last = raw.trim().split("\n").filter(Boolean).pop();
  return last ? parseHeartbeatLine(last) : null;
}

export function readLastAgentHeartbeat(
  agentId: string,
  opts?: InboxOpts,
): MonitorHeartbeat | null {
  let raw: string;
  try {
    raw = readFileSync(heartbeatPath(agentId, opts), "utf8");
  } catch {
    return null;
  }
  const lines = raw.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const heartbeat = parseHeartbeatLine(lines[i] ?? "");
    if (heartbeat?.source === "agent") return heartbeat;
  }
  return null;
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
  return inboxMonitorState(agentId, maxAgeMs, opts) === "alive";
}

/**
 * Distinguish a reader that has never proved it was armed from one that was
 * armed previously but is temporarily stale. Only agent-authored heartbeats
 * count; server boot markers are audit metadata, not reader liveness.
 */
export function inboxMonitorState(
  agentId: string,
  maxAgeMs: number,
  opts?: InboxOpts,
): InboxMonitorState {
  const heartbeat = readLastAgentHeartbeat(agentId, opts);
  if (!heartbeat) return "never-armed";
  const ageMs = nowOf(opts) - heartbeat.ts_ms;
  return ageMs >= 0 && ageMs <= maxAgeMs ? "alive" : "stale";
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
  ensureChannelDirForWrite(agentId, opts);
  return `tail -n0 -F ${inboxPath(agentId, opts)} >> ${surfacedLogPath(agentId, opts)}`;
}
