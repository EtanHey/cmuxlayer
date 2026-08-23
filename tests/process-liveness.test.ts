import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/agent-types.js";
import { qualifyAgentProcessLiveness } from "../src/process-liveness.js";

function processRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agent_id: "cmuxlayerCodex-process",
    surface_id: "surface:1",
    state: "working",
    repo: "cmuxlayer",
    model: "gpt-5.6",
    cli: "codex",
    cli_session_id: "sid-process",
    task_summary: "process qualification",
    pid: 43210,
    pid_registered_at: "2026-08-23T11:00:05.000Z",
    version: 1,
    created_at: "2026-08-23T11:00:00.000Z",
    updated_at: "2026-08-23T11:00:05.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  } as AgentRecord;
}

describe("qualified agent process liveness", () => {
  it("accepts a process started inside the production creation-registration window", () => {
    expect(
      qualifyAgentProcessLiveness(
        processRecord(),
        "alive",
        Date.parse("2026-08-23T11:00:02.000Z"),
      ),
    ).toBe("alive");
  });

  it("treats a recycled pid started after self-registration as the old agent process gone", () => {
    expect(
      qualifyAgentProcessLiveness(
        processRecord(),
        "alive",
        Date.parse("2026-08-23T11:01:00.000Z"),
      ),
    ).toBe("gone");
  });

  it("fails closed when second-granular ps time cannot distinguish same-second pid reuse", () => {
    expect(
      qualifyAgentProcessLiveness(
        processRecord({
          pid_registered_at: "2026-08-23T11:00:05.900Z",
        }),
        "alive",
        Date.parse("2026-08-23T11:00:05.000Z"),
      ),
    ).toBe("unknown");
  });

  it("fails closed when a live pid lacks production registration provenance", () => {
    expect(
      qualifyAgentProcessLiveness(
        processRecord({ pid_registered_at: null }),
        "alive",
        Date.parse("2026-08-23T11:00:02.000Z"),
      ),
    ).toBe("unknown");
  });
});
