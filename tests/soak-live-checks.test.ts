import { describe, expect, it } from "vitest";
import { checkClose, checkControlHealthSample, checkParsedReadAgreement, checkPlacement, checkReceipt, checkStateAgreement,
  checkSoakSession, checkToolFailure, hasReplyMarker, healthSampleEntry, nextSoakDelayMs, shouldContinueSoak } from "../scripts/soak-live-checks.mjs";

describe("live soak invariant checkers", () => {
  it("rejects a pending boot or send receipt even when the response landed", () => {
    expect(checkReceipt({ submit_verified: null, delivery_state: "pending_verify" }, true)).toContain("landed_with_unverified_receipt");
    expect(checkReceipt({ submit_verified: true, delivery_state: "submitted" }, true)).toEqual([]);
    expect(checkReceipt({ submit_verified: true })).toEqual([]); // Valid boot receipt omits delivery_state.
  });

  it("catches idle or done registry state over a working or dirty composer", () => {
    expect(checkStateAgreement({ state: "done" }, { status: "working", control_state: "busy" })).toContain("stale_registry_state");
    expect(checkStateAgreement({ state: "idle" }, { status: "idle", control_state: "composer_dirty" })).toContain("stale_registry_state");
    expect(checkStateAgreement({ state: "working" }, { status: "working", control_state: "busy" })).toEqual([]);
  });

  it("flags an error registry row over a busy screen as stale", () => {
    expect(checkStateAgreement({ state: "error" }, { status: "working", control_state: "busy" }))
      .toContain("stale_registry_state");
    expect(checkStateAgreement({ state: "ready" }, { status: "working", control_state: "busy" }))
      .toContain("stale_registry_state");
    expect(checkStateAgreement({ state: "working" }, { status: "idle", control_state: "ready" }))
      .toContain("stale_registry_state");
  });

  it("catches false topology and in-flight refusals", () => {
    expect(checkToolFailure({ ok: false, error: "too many in-flight requests" })).toContain("too_many_in_flight");
    expect(checkToolFailure({ ok: false, error: "topology_incomplete" })).toContain("topology_incomplete_refusal");
    expect(checkToolFailure({ ok: false, error: "surface route changed" })).toContain("route_changed");
    expect(checkToolFailure({ ok: false, error: "unrelated MCP error" })).toContain("tool_error");
  });

  it("requires right-column placement and no registry or index ghost after close", () => {
    expect(checkPlacement({ column: 0, column_count: 2 })).toContain("wrong_column");
    expect(checkPlacement({ column: 1, column_count: 2 })).toEqual([]);
    expect(checkClose({ agent_stopped: true, surface_closed: true }, false, { state: "done" },
      { cli_session_id: "old", surface_id: "surface:1" }, "surface:1", [])).toEqual([]);
    expect(checkClose({ agent_stopped: true, surface_closed: true }, true, { state: "ready" },
      { cli_session_id: "live", surface_id: "surface:1" }, "surface:1", [{ ref: "surface:1" }]))
      .toEqual(["agent_ghost", "nonterminal_tombstone", "surface_still_live", "live_index_ghost"]);
  });

  it("rejects a third column and a missing close topology", () => {
    expect(checkPlacement({ column: 2, column_count: 3 })).toContain("wrong_column");
    expect(checkClose({ agent_stopped: true, surface_closed: true }, false,
      { state: "done" }, null, "surface:1", undefined)).toContain("close_observation_unavailable");
    expect(checkClose({ agent_stopped: true, surface_closed: true }, false,
      { state: "done" }, null, "surface:1", new Array(1))).toContain("close_observation_unavailable");
  });

  it("does not count an echoed user prompt as the agent reply", () => {
    expect(hasReplyMarker({ screen_preview: "> Reply exactly SOAK_OK_1 then stop." }, "SOAK_OK_1")).toBe(false);
    expect(hasReplyMarker({ parsed: { response: "SOAK_OK_1" } }, "SOAK_OK_1")).toBe(true);
    expect(hasReplyMarker({ screen_preview: "⏺ SOAK_OK_1" }, "SOAK_OK_1")).toBe(true);
    expect(hasReplyMarker({ screen_preview: "• SOAK_OK_1" }, "SOAK_OK_1")).toBe(true);
  });

  it("fails closed on malformed receipt, state, tool, and reply inputs", () => {
    expect(checkReceipt({ submit_verified: true, delivery_state: "mystery" })).toContain("nonterminal_or_failed_receipt");
    expect(checkReceipt({ submit_verified: true }, "false" as unknown as boolean)).toContain("malformed_receipt");
    expect(checkStateAgreement({}, {})).toContain("state_unavailable");
    expect(checkStateAgreement({ state: "mystery" }, { status: "idle", control_state: "ready" })).toContain("state_unavailable");
    expect(checkToolFailure({ ok: 1, isError: 0 })).toContain("tool_error");
    expect(checkToolFailure({ ok: true, isError: false })).toEqual([]);
    expect(checkToolFailure({ ok: true, isError: false, error: "unexpected" })).toContain("tool_error");
    expect(hasReplyMarker({ parsed: { response: "" } }, "")).toBe(false);
  });

  it("continues until both the cycle count and duration floor are met", () => {
    expect(shouldContinueSoak(40, 40, 59 * 60_000, 60 * 60_000)).toBe(true);
    expect(shouldContinueSoak(39, 40, 60 * 60_000, 60 * 60_000)).toBe(true);
    expect(shouldContinueSoak(40, 40, 60 * 60_000, 60 * 60_000)).toBe(false);
  });

  it("paces a fixed cycle budget across the duration without spawning extra seats", () => {
    const hour = 60 * 60_000;
    expect(nextSoakDelayMs(0, 40, 0, hour)).toBe(0);
    expect(nextSoakDelayMs(2, 40, 60_000, hour)).toBe(30_000);
    expect(nextSoakDelayMs(40, 40, 59 * 60_000, hour)).toBe(30_000);
    expect(nextSoakDelayMs(40, 40, hour, hour)).toBe(0);
    expect(nextSoakDelayMs(2, 40, 60_000, 0)).toBe(0);
  });

  it("rejects invalid progress before it can terminate or spin the soak", () => {
    expect(() => shouldContinueSoak(Number.NaN, 40, 60_000, 60_000)).toThrow();
    expect(() => nextSoakDelayMs(1, 0, 0, 60_000)).toThrow();
  });

  it.each([
    { cycles: 40, elapsedMs: 60 * 60_000, rssEndKb: 100_000 },
    { cycles: 41, elapsedMs: 60 * 60_000 + 1, rssEndKb: 190_000 },
    { cycles: 45, elapsedMs: 61 * 60_000 + 30_000, rssEndKb: 100_000 },
    { cycles: 80, elapsedMs: 75 * 60_000, rssEndKb: 190_000 },
  ])("accepts a healthy full soak with $cycles cycles after $elapsedMs ms", ({ cycles, elapsedMs, rssEndKb }) => {
    const minDurationMs = 60 * 60_000;
    const session = { startPid: 123, endPid: 123, elapsedMs, minDurationMs,
      minCycles: 40, cyclesCompleted: cycles,
      healthSamples: Array.from({ length: Math.ceil(elapsedMs / 60_000) + 1 }, () => true),
      rssStartKb: 100_000, rssEndKb };
    expect(checkSoakSession(session)).toEqual([]);
    expect(shouldContinueSoak(cycles, 40, elapsedMs, minDurationMs)).toBe(false);
    expect(nextSoakDelayMs(cycles, 40, elapsedMs, minDurationMs)).toBe(0);
    const read = (token_count: number | null) => ({ ok: true, isError: false,
      parsed: { status: "working", control_state: "busy", token_count } });
    expect(checkParsedReadAgreement(read(null), read(null), 100)).toEqual([]);
    expect(checkParsedReadAgreement(read(100), read(100), 100)).toEqual([]);
    expect(checkPlacement({ column: 1, column_count: 2 })).toEqual([]);
  });

  it("checks one continuous healthy MCP process and bounded RSS growth", () => {
    const healthy = { startPid: 123, endPid: 123, elapsedMs: 60 * 60_000,
      minDurationMs: 60 * 60_000, minCycles: 40, cyclesCompleted: 40,
      healthSamples: Array.from({ length: 61 }, () => true), rssStartKb: 100_000, rssEndKb: 150_000 };
    expect(checkSoakSession(healthy)).toEqual([]);
    expect(checkSoakSession({ ...healthy, endPid: 124 })).toContain("server_pid_changed");
    expect(checkSoakSession({ ...healthy, healthSamples: [...healthy.healthSamples.slice(0, 60), false] }))
      .toContain("unhealthy_control_sample");
    expect(checkSoakSession({ ...healthy, healthSamples: healthy.healthSamples.slice(0, 60) }))
      .toContain("missing_control_samples");
    expect(checkSoakSession({ ...healthy, rssEndKb: 210_000 })).toContain("server_rss_over_2x");
    expect(checkSoakSession({ ...healthy, elapsedMs: 59 * 60_000 })).toContain("duration_short");
  });

  it("rejects missing or non-finite soak counters and missing health samples", () => {
    const valid = { startPid: 123, endPid: 123, elapsedMs: 60_000,
      minDurationMs: 60_000, minCycles: 1, cyclesCompleted: 1,
      healthSamples: [true, true], rssStartKb: 100, rssEndKb: 100 };
    for (const key of ["cyclesCompleted", "minCycles", "elapsedMs", "minDurationMs"] as const) {
      expect(checkSoakSession({ ...valid, [key]: undefined })).toContain("malformed_session");
      expect(checkSoakSession({ ...valid, [key]: Number.NaN })).toContain("malformed_session");
    }
    expect(checkSoakSession({ ...valid, healthSamples: undefined })).toContain("malformed_session");
  });

  it("requires an endpoint health sample after a partial final minute", () => {
    const session = { startPid: 123, endPid: 123, elapsedMs: 60_001,
      minDurationMs: 60_000, minCycles: 1, cyclesCompleted: 1,
      healthSamples: [true, true], rssStartKb: 100, rssEndKb: 100 };
    expect(checkSoakSession(session)).toContain("missing_control_samples");
    expect(checkSoakSession({ ...session, healthSamples: [true, true, true] })).toEqual([]);
  });

  it("rejects missing health results inside a sparse sample array", () => {
    const session = { startPid: 123, endPid: 123, elapsedMs: 60 * 60_000,
      minDurationMs: 60 * 60_000, minCycles: 40, cyclesCompleted: 40,
      healthSamples: new Array(61), rssStartKb: 100, rssEndKb: 100 };
    expect(checkSoakSession(session)).toContain("unhealthy_control_sample");
  });

  it("tracks the MCP stdio PID separately from the control daemon PID", () => {
    const health = { ok: true, isError: false, health: { current_process: { pid: 999 }, warnings: [],
      selected_transport: { transport_mode: "socket", transport_degraded: false } } };
    expect(checkControlHealthSample(health, 123, 123)).toEqual([]);
    expect(checkControlHealthSample(health, 124, 123)).toContain("mcp_pid_changed");
    expect(checkControlHealthSample({ ...health, health: { ...health.health,
      selected_transport: { transport_mode: "cli", transport_degraded: true } } }, 123, 123))
      .toContain("control_transport_unhealthy");
  });

  it("keeps the complete control health result in a serialized JSONL sample", () => {
    const result = { ok: true, isError: false, health: {
      current_process: { pid: 999, rss_kb: 12_345 }, warnings: [],
      selected_transport: { transport_mode: "socket", transport_degraded: false },
      diagnostic: { reconnects: 0, last_probe_ms: 17 },
    }, request_id: "health-minute-1" };
    const entry = JSON.parse(JSON.stringify(healthSampleEntry("minute:1", result, 123, [])));
    expect(entry.kind).toBe("health");
    expect(entry.healthy).toBe(true);
    expect(entry.control_health).toEqual(result);
  });

  it("rejects incomplete or non-boolean control transport status", () => {
    const health = { ok: true, isError: false, health: { warnings: [],
      selected_transport: { transport_mode: "socket", transport_degraded: "false" } } };
    expect(checkControlHealthSample(health, 123, 123)).toContain("control_transport_unhealthy");
  });

  it("catches a stale parsed_only read against the immediate full read", () => {
    const full = { ok: true, isError: false, parsed: { status: "working", control_state: "busy", token_count: 190_479 } };
    const stale = { ok: true, isError: false, parsed: { status: "idle", control_state: "ready", token_count: 79_126 } };
    expect(checkParsedReadAgreement(full, stale, 200)).toEqual([
      "parsed_status_mismatch", "parsed_control_state_mismatch", "parsed_token_count_drift",
    ]);
    expect(checkParsedReadAgreement(full, { ...full, parsed: { ...full.parsed, token_count: 191_000 } }, 200)).toEqual([]);
    expect(checkParsedReadAgreement(full, full, 2_001)).toContain("parsed_sweep_window_exceeded");
  });

  it("rejects malformed parsed reads and non-finite sweep duration", () => {
    const read = { ok: true, parsed: {} };
    expect(checkParsedReadAgreement(read, read, Number.NaN)).toContain("parsed_read_unavailable");
    const unknown = { ok: true, isError: false, parsed: { status: "mystery", control_state: "ready", token_count: 1 } };
    expect(checkParsedReadAgreement(unknown, unknown, 100)).toContain("parsed_read_unavailable");
  });
});

it("matches valid null token counts before usage metadata appears", () => {
  const read = { ok: true, isError: false, parsed: {
    status: "working", control_state: "busy", token_count: null,
  } };
  expect(checkParsedReadAgreement(read, read, 100)).toEqual([]);
  const withCount = { ...read, parsed: { ...read.parsed, token_count: 42 } };
  expect(checkParsedReadAgreement(read, withCount, 100)).toContain("parsed_token_count_drift");
  expect(checkParsedReadAgreement(withCount, read, 100)).toContain("parsed_token_count_drift");
  for (const token_count of [undefined, Number.NaN, -1]) {
    const malformed = { ...read, parsed: { ...read.parsed, token_count } };
    expect(checkParsedReadAgreement(malformed, malformed, 100)).toContain("parsed_read_unavailable");
  }
});
