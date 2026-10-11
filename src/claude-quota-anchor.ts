import { createHash } from "node:crypto";
import { basename } from "node:path";
import { readHarnessSessionTextWindow } from "./harness-session.js";

export interface ClaudeQuotaTarget {
  key: string; uuid: string; sessionId: string; sessionPath?: string | null; notBeforeMs: number;
}
interface Refusal { text: string; episode: string }
interface Anchor { at: number; source: "session_record" | "first_observed"; witness?: string }
interface TargetState { uuid: string; highWater: number; episode?: Anchor & { signature: string; firstObserved: number } }

/** Exact current-session record only; bounded tail, never mtime or history search. */
export function readClaudeQuotaRecord(target: ClaudeQuotaTarget, refusal: string, now: number): Anchor | null {
  if (!target.sessionPath || !/^[a-z0-9-]+$/i.test(target.sessionId) || basename(target.sessionPath) !== `${target.sessionId}.jsonl`) return null;
  const tail = readHarnessSessionTextWindow(target.sessionPath, { maxBytes: 64 * 1024 });
  if (tail === null) return null;
  let latest: any;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "assistant" || row.type === "user") latest = row;
    } catch { return null; } // A partial new event cannot authorize an older one.
  }
  if (!latest || latest.type !== "assistant" || latest.sessionId !== target.sessionId ||
      latest.isApiErrorMessage !== true || latest.error !== "rate_limit") return null;
  const content = latest.message?.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || content[0].text !== refusal) return null;
  const stamp = typeof latest.timestamp === "string" ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(latest.timestamp) : null;
  if (!stamp) return null;
  const at = Date.parse(latest.timestamp);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== `${stamp[1]}.${(stamp[2] ?? "").padEnd(3, "0")}Z` ||
      !Number.isFinite(target.notBeforeMs) || at < target.notBeforeMs || at > now) return null;
  return { at, source: "session_record", witness: createHash("sha256").update(JSON.stringify(latest)).digest("hex") };
}

/** Shared across MCP peers. Fallback is potentially late, fixed on first observation. */
export class ClaudeQuotaAnchorTracker {
  private states = new Map<string, TargetState>();
  private sessionWatermarks = new Map<string, { key: string; at: number }>();
  observe(target: ClaudeQuotaTarget | null, refusal: Refusal | null, now: number): Anchor | null {
    if (!target || !Number.isFinite(now) || !Number.isFinite(target.notBeforeMs) || target.notBeforeMs > now) return null;
    let state = this.states.get(target.key);
    if (!state) {
      state = { uuid: target.uuid, highWater: -Infinity }; this.states.set(target.key, state);
      if (this.states.size > 128) this.states.delete(this.states.keys().next().value!);
    }
    if (!refusal) { state.episode = undefined; return null; }
    const signature = createHash("sha256").update(refusal.episode).digest("hex");
    let episode = state.episode;
    if (!episode || episode.signature !== signature || episode.firstObserved > now) {
      episode = { signature, firstObserved: now, at: now, source: "first_observed" }; state.episode = episode;
    }
    const record = readClaudeQuotaRecord(target, refusal.text, now);
    const session = this.sessionWatermarks.get(target.sessionId);
    if (record && (!session || session.key === target.key || record.at > session.at) &&
        (record.at > state.highWater || record.witness === episode.witness)) {
      state.highWater = Math.max(state.highWater, record.at);
      this.sessionWatermarks.set(target.sessionId, { key: target.key, at: record.at });
      if (this.sessionWatermarks.size > 128) this.sessionWatermarks.delete(this.sessionWatermarks.keys().next().value!);
      Object.assign(episode, record);
    } else if (episode.source === "session_record") {
      // A newer unmatched/partial event invalidates exact evidence. Retire its
      // watermark and use one new late fallback, rather than retaining clearance.
      episode = { signature, firstObserved: now, at: now, source: "first_observed" }; state.episode = episode;
    }
    return { at: episode.at, source: episode.source };
  }
  /** Consume before a submit attempt, including an uncertain transport outcome. */
  noteSubmit(uuid: string | null): void {
    for (const state of this.states.values()) if (uuid && state.uuid === uuid.toLowerCase()) state.episode = undefined;
  }
}
