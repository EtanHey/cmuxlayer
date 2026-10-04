import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseScreen, codexScreenHasActiveTurn } from "../src/screen-parser.js";
import { okFormatted, shapeSuccessfulSendToResult } from "../src/mcp/tool-result.js";

const args = { mode: "agent", agent_id: "target", text: "request", press_enter: true };
const shape = (data: Record<string, unknown>, extra = {}) => shapeSuccessfulSendToResult(okFormatted("old success", data), { ...args, ...extra });

describe("RESCOPE send_to verified success invariant", () => {
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
    expect(shape(full).structuredContent?.receipts).toHaveLength(1);
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
