import { describe, expect, it } from "vitest";
import { checkClose, checkControlHealthSample, checkPlacement, checkReceipt, checkStateAgreement,
  checkSoakSession, checkToolFailure, hasReplyMarker, nextSoakDelayMs, shouldContinueSoak } from "../scripts/soak-live-checks.mjs";

describe("live soak invariant checkers", () => {
  it("rejects a pending boot or send receipt even when the response landed", () => {
    expect(checkReceipt({ submit_verified: null, delivery_state: "pending_verify" }, true)).toContain("landed_with_unverified_receipt");
    expect(checkReceipt({ submit_verified: true, delivery_state: "submitted" }, true)).toEqual([]);
  });

  it("catches idle or done registry state over a working or dirty composer", () => {
    expect(checkStateAgreement({ state: "done" }, { status: "working", control_state: "busy" })).toContain("stale_registry_state");
    expect(checkStateAgreement({ state: "idle" }, { status: "idle", control_state: "composer_dirty" })).toContain("stale_registry_state");
    expect(checkStateAgreement({ state: "working" }, { status: "working", control_state: "busy" })).toEqual([]);
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

  it("does not count an echoed user prompt as the agent reply", () => {
    expect(hasReplyMarker({ screen_preview: "> Reply exactly SOAK_OK_1 then stop." }, "SOAK_OK_1")).toBe(false);
    expect(hasReplyMarker({ parsed: { response: "SOAK_OK_1" } }, "SOAK_OK_1")).toBe(true);
    expect(hasReplyMarker({ screen_preview: "⏺ SOAK_OK_1" }, "SOAK_OK_1")).toBe(true);
    expect(hasReplyMarker({ screen_preview: "• SOAK_OK_1" }, "SOAK_OK_1")).toBe(true);
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

  it("tracks the MCP stdio PID separately from the control daemon PID", () => {
    const health = { ok: true, health: { current_process: { pid: 999 }, warnings: [],
      selected_transport: { transport_mode: "socket", transport_degraded: false } } };
    expect(checkControlHealthSample(health, 123, 123)).toEqual([]);
    expect(checkControlHealthSample(health, 124, 123)).toContain("mcp_pid_changed");
    expect(checkControlHealthSample({ ...health, health: { ...health.health,
      selected_transport: { transport_mode: "cli", transport_degraded: true } } }, 123, 123))
      .toContain("control_transport_unhealthy");
  });
});
