import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeQuotaAnchorTracker, readClaudeQuotaRecord } from "../src/claude-quota-anchor.js";
import { claudeUsageResetAt } from "../src/claude-usage-reset.js";
import { claudeUsageRefusal, hasCurrentClaudeUsageLimit } from "../src/screen-parser.js";

const at = Date.parse;
const now = at("2026-10-11T02:51:22.802Z"), anchor = at("2026-10-10T22:45:31.158Z");
const text = "You've hit your weekly limit · resets 5am (Asia/Jerusalem)";
const refusal = { text, episode: text };
const record = () => ({ type: "assistant", sessionId: "session-1", uuid: "error-1", isApiErrorMessage: true,
  error: "rate_limit", timestamp: "2026-10-10T22:45:31.158Z", message: { content: [{ type: "text", text }] } });
let dir: string;
const target = () => ({ key: "surface-1/session-1/boot-1", uuid: "surface-1", sessionId: "session-1",
  sessionPath: join(dir, "session-1.jsonl"), notBeforeMs: at("2026-10-10T22:00:00Z") });
const write = (value: unknown, extra = "") => writeFileSync(target().sessionPath, JSON.stringify(value) + "\n" + extra);
describe("TimeOnly session record and episode anchors", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cmux-quota-anchor-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it.each(["stale", "future", "invalid", "wrong-text", "wrong-session", "quoted", "new-user", "partial"])("refuses %s record evidence", kind => {
    const row = record();
    if (kind === "stale") row.timestamp = "2026-10-10T21:59:00Z";
    if (kind === "future") row.timestamp = "2026-10-11T03:00:00Z";
    if (kind === "invalid") row.timestamp = "2026-02-30T01:00:00Z";
    if (kind === "wrong-text") row.message.content[0].text += " edited";
    if (kind === "wrong-session") row.sessionId = "session-2";
    if (kind === "quoted") row.isApiErrorMessage = false;
    write(row, kind === "new-user" ? JSON.stringify({ type: "user", sessionId: "session-1" }) + "\n" : kind === "partial" ? '{"type":' : "");
    expect(readClaudeQuotaRecord(target(), text, now)).toBeNull();
    expect(new ClaudeQuotaAnchorTracker().observe(target(), refusal, now)).toMatchObject({ at: now, source: "first_observed" });
  });
  it("does not advance a fallback anchor while polling, and identifies late fallback explicitly", () => {
    const tracker = new ClaudeQuotaAnchorTracker();
    expect(tracker.observe(target(), refusal, anchor)).toEqual({ at: anchor, source: "first_observed" });
    expect(tracker.observe(target(), refusal, now)).toEqual({ at: anchor, source: "first_observed" });
    expect(claudeUsageResetAt("5am (Asia/Jerusalem)", now, undefined, anchor)).toBe(at("2026-10-11T02:00:00Z"));
    const late = new ClaudeQuotaAnchorTracker().observe(target(), refusal, now)!;
    expect(claudeUsageResetAt("5am (Asia/Jerusalem)", now, undefined, late.at)).toBe(at("2026-10-12T02:00:00Z"));
  });
  it.each(["session", "uuid", "boot", "observer"])("does not inherit an earlier incarnation's anchor after %s changes", kind => {
    write(record()); const tracker = new ClaudeQuotaAnchorTracker();
    expect(tracker.observe(target(), refusal, now)).toMatchObject({ at: anchor, source: "session_record" });
    const changed = { ...target(), key: target().key + "/" + kind,
      ...(kind === "session" ? { sessionId: "session-2" } : kind === "uuid" ? { uuid: "surface-2" } : {}) };
    expect(tracker.observe(changed, refusal, now)).toEqual({ at: now, source: "first_observed" });
  });
  it("ScrollWitness keeps exact evidence across the reviewer's scroll-shifted frames and an uncertain submit", () => {
    write(record()); const tracker = new ClaudeQuotaAnchorTracker();
    const rows = ["  earlier output row 1", "  earlier output row 2", "  earlier output row 3", "(exit code 0)",
      `  ⎿  ${text}`, "     /usage-credits to finish what you’re working on.", ""];
    const frame = (composer: string[]) => [...rows, ...composer, "", "  ⎇ master | 🔧 9"].slice(-10).join("\n");
    const empty = frame(["❯ "]), typed = frame(["❯ Preserve the original words and read the task", "  from the supplied", "  /tmp/p0fixture/task.md"]);
    expect(empty.split("\n")[0]).not.toBe(typed.split("\n")[0]);
    for (const screen of [empty, typed]) {
      const exact = tracker.observe(target(), claudeUsageRefusal(screen), now)!;
      expect(exact).toEqual({ at: anchor, source: "session_record" });
      expect(hasCurrentClaudeUsageLimit(screen, now, undefined, exact.at)).toBe(false);
    }
    tracker.noteSubmit("surface-1");
    expect(tracker.observe(target(), claudeUsageRefusal(typed), now + 1)).toEqual({ at: anchor, source: "session_record" });
  });
  it("ScrollWitness retains the latest exact record after a dispatched but unaccepted submit", () => {
    write(record()); const tracker = new ClaudeQuotaAnchorTracker();
    expect(tracker.observe(target(), refusal, now)).toEqual({ at: anchor, source: "session_record" });
    tracker.noteSubmit("surface-1");
    expect(tracker.observe(target(), refusal, now + 1)).toEqual({ at: anchor, source: "session_record" });
  });
  it("ScrollWitness invalidates exact evidence on a newer user event and replaces it on a newer refusal", () => {
    write(record()); const tracker = new ClaudeQuotaAnchorTracker();
    expect(tracker.observe(target(), refusal, now)).toMatchObject({ at: anchor, source: "session_record" });
    write(record(), JSON.stringify({ type: "user", sessionId: "session-1" }) + "\n");
    expect(tracker.observe(target(), refusal, now)).toEqual({ at: now, source: "first_observed" });
    write(record()); // Restoring a retired old event cannot undo the newer-user observation.
    expect(tracker.observe(target(), refusal, now)).toEqual({ at: now, source: "first_observed" });
    const newer = { ...record(), uuid: "error-2", timestamp: "2026-10-11T02:50:00Z" }; write(newer);
    expect(tracker.observe(target(), refusal, now)).toEqual({ at: at(newer.timestamp), source: "session_record" });
    expect(claudeUsageResetAt("5am (Asia/Jerusalem)", now, undefined, at(newer.timestamp))).toBe(at("2026-10-12T02:00:00Z"));
    tracker.observe(target(), null, now);
    expect(tracker.observe(target(), refusal, now)).toEqual({ at: at(newer.timestamp), source: "session_record" });
    expect(tracker.observe(target(), { ...refusal, episode: "new turn\n" + text }, now + 1)).toEqual({ at: at(newer.timestamp), source: "session_record" });
  });
  it("ScrollWitness keeps fallback resets separate from valid exact evidence", () => {
    const tracker = new ClaudeQuotaAnchorTracker();
    expect(tracker.observe(target(), refusal, anchor)).toEqual({ at: anchor, source: "first_observed" });
    tracker.noteSubmit("surface-1");
    expect(tracker.observe(target(), refusal, now)).toEqual({ at: now, source: "first_observed" });
    expect(tracker.observe(target(), { ...refusal, episode: "changed viewport\n" + text }, now + 1)).toEqual({ at: now + 1, source: "first_observed" });
  });
  it.each([
    ["5am (Asia/Jerusalem)", "2026-10-11T02:00:00Z", "2026-10-12T02:00:00Z"],
    ["12:30am (Pacific/Kiritimati)", "2026-12-31T10:00:00Z", "2026-12-31T10:30:00Z"],
    ["2:30am (America/New_York)", "2026-03-08T06:00:00Z", null],
    ["1:30am (America/New_York)", "2026-11-01T04:00:00Z", null],
  ])("resolves the first unique occurrence strictly after the anchor: %s", (label, start, expected) => {
    expect(claudeUsageResetAt(label, at(start) + 86_400_000, undefined, at(start))).toBe(expected ? at(expected) : null);
  });
  it.each([NaN, Infinity, -1, now + 1])("keeps invalid/future anchor %s unknown", bad => {
    expect(claudeUsageResetAt("5am (Asia/Jerusalem)", now, undefined, bad)).toBeNull();
  });
});
