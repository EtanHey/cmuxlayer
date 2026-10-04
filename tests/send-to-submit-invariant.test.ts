import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codexScreenHasActiveTurn } from "../src/screen-parser.js";
import { countVisibleQueuedSubmitMatches, extractComposerInputRegion, screenTranscriptContainsText } from "../src/delivery/composer-screen.js";
import { okFormatted, shapeSuccessfulSendToResult } from "../src/mcp/tool-result.js";

const args = { mode: "agent", agent_id: "target", text: "request", press_enter: true };
const shape = (data: Record<string, unknown>, extra = {}) => shapeSuccessfulSendToResult(okFormatted("old success", data), { ...args, ...extra });

describe("RESCOPE send_to verified success invariant", () => {
  it.each(["Gemini CLI", "Kiro"])("round 1 correlates a %s echo above its recognised >>> composer", banner => {
    const before = `${banner}\n>>>`, after = `${banner}\nnewly echoed instruction\n>>>`;
    expect(extractComposerInputRegion(after)).toBe("");
    expect(screenTranscriptContainsText(before, "newly echoed instruction")).toBe(false);
    expect(screenTranscriptContainsText(after, "newly echoed instruction")).toBe(true);
  });
  it("round 1 a short first-line truncated queue is not proof", () => {
    const screen = "OpenAI Codex\nWorking (5s • esc to interrupt)\nQueued follow-up inputs\n  ↳ ok…\n›\n  GPT-6.1-Sol high · ~/repo";
    expect(countVisibleQueuedSubmitMatches(screen, "ok\nRead and follow the complete authored instruction")).toBe(0);
  });
  it("RESCOPE a follow-up queue heading does not end the active Codex turn", () => {
    const screen = readFileSync(new URL("./fixtures/codex-0.157/midturn-followup-queued.txt", import.meta.url), "utf8");
    expect(codexScreenHasActiveTurn(screen)).toBe(true);
  });
  it.each(["agent", "surface"])("refuses unverified %s success without terminalizing background verification", mode => {
    const result = shape({ delivery_state: "pending_verify", terminal: false, typed: true, submitted: false, submit_verification_reason: "input_still_pending" }, { mode });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error_code: "submit_unverified", delivery_state: "pending_verify", terminal: false });
    expect(result.structuredContent?.error).toContain("your text is still in the composer; nothing else was typed");
  });
  it.each(["queued", "queued_followup", "typed", "rescued"])("does not accept %s without submission or visible queue proof", state => {
    expect(shape({ delivery_state: state, submitted: false }).structuredContent).toMatchObject({ ok: false, error_code: "submit_unverified" });
  });
  it("allows a deliberately typed-only delivery", () => {
    expect(shape({ delivery_state: "typed", submitted: false }, { press_enter: false }).structuredContent?.ok).toBe(true);
  });
  it("accepts a visibly verified queue", () => {
    expect(shape({ delivery_state: "queued", submitted: false, queue_verified: true }).structuredContent?.ok).toBe(true);
  });
  it("keeps verbose receipts subject to the same invariant", () => {
    expect(shape({ delivery_state: "pending_verify", submitted: false }, { verbose: true }).structuredContent?.ok).toBe(false);
  });
  it("fails a targeting batch if any submitted text lacks proof", () => {
    expect(shape({ receipts: [{ delivery_state: "submitted", submitted: true }, { delivery_state: "queued", submitted: false }] }).structuredContent?.ok).toBe(false);
  });
  it("slims each verified targeting receipt", () => {
    const receipt = { agent_id: "target", delivery_id: "delivery", delivery_state: "submitted", submitted: true, screen: { status: "working" }, health: { ok: true } };
    expect(shape({ receipts: [receipt], caller_agent_id: "caller" }).structuredContent).toEqual({ ok: true, caller_agent_id: "caller", receipts: [{ ok: true, agent_id: "target", delivery_id: "delivery", delivery_state: "submitted", submitted: true, caller_agent_id: "caller" }] });
  });
  it("excludes explicitly filtered targets from submission proof", () => {
    const full = { receipts: [{ agent_id: "target", delivery_state: "submitted", submitted: true }, { resolution: "filtered_out", skipped: "exclude" }] };
    expect(shape(full).structuredContent?.ok).toBe(true);
    expect(shape(full).structuredContent?.receipts).toEqual([expect.objectContaining({ agent_id: "target", submitted: true }), full.receipts[1]]);
  });
  it("round 1 preserves an all-skipped batch without inventing a submit failure", () => {
    const result = okFormatted("all targets skipped", { receipts: [{ agent_id: "paused", skipped: "paused" }], skipped_count: 1 });
    expect(shapeSuccessfulSendToResult(result, args)).toBe(result);
  });
  it("round 1 a mixed skipped batch still rejects an unverified attempt", () => {
    const skipped = { agent_id: "paused", skipped: "paused" };
    expect(shape({ receipts: [skipped, { agent_id: "target", delivery_state: "pending_verify", submitted: false }] }).structuredContent).toMatchObject({ ok: false, error_code: "submit_unverified", receipts: [skipped, { ok: false, error_code: "submit_unverified" }] });
  });
  it("keeps agent identity when the default mode is inferred", () => {
    expect(shape({ agent_id: "target", delivery_state: "submitted", submitted: true }, { mode: undefined }).structuredContent).toMatchObject({ agent_id: "target" });
  });
  it("slims verified text success to the Lane M core fields", () => {
    const data = { agent_id: "target", delivery_id: "delivery", delivery_state: "submitted", submitted: true, caller_agent_id: "caller", screen: { model: "Daybreak" }, health: { ok: true }, timings_ms: { type: 2 }, warnings: ["fallback"], duplicate_of: "prior", retry_count: 1 };
    expect(shape(data).structuredContent).toEqual({ ok: true, agent_id: "target", delivery_id: "delivery", delivery_state: "submitted", submitted: true, caller_agent_id: "caller" });
    expect(shape(data, { verbose: true }).structuredContent).toMatchObject(data);
  });

});
