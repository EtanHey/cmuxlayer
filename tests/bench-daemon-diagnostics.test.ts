import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { measureLatency, startFakeCmuxSocket, summarizeReadDiagnostics, summarizeSendSampleDiagnostics } from "../scripts/bench-daemon.mjs";

describe("P2 benchmark read diagnostics", () => {
  it("keeps bounded per-read and per-round timing with stage provenance", () => {
    const samples = [
      { round_index: 0, client_index: 0, started_offset_ms: 0, elapsed_ms: 12, stages_ms: { request_serialize: 1, response_parse: 1, mcp_wait: 10, receipt_decode: 0 } },
      { round_index: 0, client_index: 1, started_offset_ms: 1, elapsed_ms: 80, stages_ms: { request_serialize: 1, response_parse: 1, mcp_wait: 77, receipt_decode: 1 } },
      { round_index: 1, client_index: 0, started_offset_ms: 90, elapsed_ms: 15, stages_ms: { request_serialize: 1, response_parse: 1, mcp_wait: 12, receipt_decode: 1 } },
    ];

    const diagnostics = summarizeReadDiagnostics(samples, 2);
    expect(diagnostics.sample_count).toBe(3);
    expect(diagnostics.samples).toEqual(samples);
    expect(diagnostics.rounds).toEqual([
      { round_index: 0, sample_count: 2, max_elapsed_ms: 80, p50_ms: 12, p95_ms: 80 },
      { round_index: 1, sample_count: 1, max_elapsed_ms: 15, p50_ms: 15, p95_ms: 15 },
    ]);
    expect(diagnostics.slowest).toEqual([samples[1], samples[2]]);
    expect(diagnostics.samples.every((sample) =>
      Object.values(sample.stages_ms).every((value) => Number.isFinite(value) && value >= 0)
    )).toBe(true);
  });

  it("retains the send type stage and payload shape for slow samples", () => {
    const sample = {
      second: {
        elapsed_ms: 418.45,
        tool_elapsed_ms: 418.45,
        proof_elapsed_ms: 0,
        lock_hold_ms: 393,
        payload_bytes: 62,
        press_enter: true,
        receipt: {
          retry_count: 0,
          submit_verified: true,
          submit_evidence: "cleared_composer",
          delivery_state: "submitted",
          rpc_methods: ["surface.send_text", "surface.send_key"],
          timings_ms: { route: 0, lock: 0, lock_hold: 393, type: 388, verify: 2 },
        },
      },
    };
    const diagnostic = summarizeSendSampleDiagnostics([sample], "second").slowest[0];
    expect(diagnostic).toMatchObject({
      payload_bytes: 62,
      press_enter: true,
      rpc_methods: ["surface.send_text", "surface.send_key"],
      timings_ms: { type: 388, lock_hold: 393 },
    });
  });

  it("records fake socket service and state read time for a screen read", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-p2-trace-"));
    const timings: Array<{ elapsed_ms: number; state_read_ms: number }> = [];
    const server = await startFakeCmuxSocket(
      join(root, "cmux.sock"),
      join(root, "state.json"),
      10,
      (timing: { elapsed_ms: number; state_read_ms: number }) => timings.push(timing),
    );
    const client = new CmuxSocketClient({ socketPath: join(root, "cmux.sock") });
    try {
      await client.readScreen("surface:bench-0", { workspace: "workspace:bench", lines: 5 });
      expect(timings).toHaveLength(1);
      expect(timings[0].elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(timings[0].state_read_ms).toBeGreaterThanOrEqual(0);
      expect(timings[0].elapsed_ms).toBeGreaterThanOrEqual(timings[0].state_read_ms);
    } finally {
      client.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits read samples in result.json without changing the request", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const client = {
      callTool: async (name: string, args: unknown, _timeout?: number, onTiming?: (timing: unknown) => void) => {
        calls.push({ name, args });
        onTiming?.({ request_serialize: 0.01, response_parse: 0.02, mcp_wait: 0.03 });
        return { structuredContent: { transport: "socket", transport_fallbacks: [] } };
      },
    };
    const result = await measureLatency([client], "daemon", { active: null, events: [] });
    const reads = calls.filter((call) => call.name === "read_screen");
    expect(reads).toHaveLength(12);
    expect(reads[0].args).toEqual({
      surface: "surface:bench-0",
      workspace: "workspace:bench",
      lines: 5,
    });
    expect(result.read_screen).not.toHaveProperty("sample_diagnostics");
    expect(result.read_screen_diagnostics.sample_count).toBe(12);
    expect(result.read_screen_diagnostics.rounds).toHaveLength(12);
    expect(result.read_screen_diagnostics.samples[0]).toMatchObject({
      round_index: 0,
      client_index: 0,
      stages_ms: { request_serialize: 0.01, response_parse: 0.02, mcp_wait: 0.03, caller_resume: expect.any(Number) },
    });
  });
});
