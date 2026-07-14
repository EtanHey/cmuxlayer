import { describe, expect, it } from "vitest";
import {
  buildRouteTable,
  resolveAgentRoute,
  toPublicAgent,
} from "../src/agent-facade.js";
import type { AgentRecord } from "../src/agent-types.js";

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "agent-1",
    surface_id: "surface:1",
    workspace_id: "ws:1",
    state: "ready",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: "session-1",
    task_summary: "Fix the bug",
    pid: null,
    version: 1,
    created_at: "2026-04-18T10:00:00Z",
    updated_at: "2026-04-18T10:00:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    respawn_attempts: 0,
    user_killed: false,
    ...overrides,
  };
}

describe("agent facade projections", () => {
  it("projects a PublicAgent without leaking surface topology", () => {
    const projected = toPublicAgent(makeRecord());

    expect(projected).toEqual({
      agent_id: "agent-1",
      repo: "brainlayer",
      model: "sonnet",
      state: "ready",
      session_id: "session-1",
      submit_verified: null,
      model_mismatch: null,
    });
    expect((projected as any).surface_id).toBeUndefined();
  });
});

describe("agent route table", () => {
  it("builds routes keyed by agent_id", () => {
    const table = buildRouteTable([
      makeRecord({ agent_id: "agent-1", surface_id: "surface:1" }),
      makeRecord({ agent_id: "agent-2", surface_id: "surface:2" }),
    ]);

    expect(table.get("agent-1")).toEqual({
      agent_id: "agent-1",
      surface_id: "surface:1",
      state: "ready",
      session_id: "session-1",
    });
    expect(table.get("agent-2")?.surface_id).toBe("surface:2");
  });

  it("resolves the route for a known agent", () => {
    const route = resolveAgentRoute(
      [makeRecord({ agent_id: "agent-1", surface_id: "surface:99" })],
      "agent-1",
    );

    expect(route.surface_id).toBe("surface:99");
  });

  it("allows duplicate records when they agree on the same surface", () => {
    const table = buildRouteTable([
      makeRecord({ agent_id: "agent-1", surface_id: "surface:1" }),
      makeRecord({ agent_id: "agent-1", surface_id: "surface:1" }),
    ]);

    expect(table.size).toBe(1);
    expect(table.get("agent-1")?.surface_id).toBe("surface:1");
  });

  it("rejects conflicting routes for the same agent_id", () => {
    expect(() =>
      buildRouteTable([
        makeRecord({ agent_id: "agent-1", surface_id: "surface:1" }),
        makeRecord({ agent_id: "agent-1", surface_id: "surface:2" }),
      ]),
    ).toThrow(/Conflicting routes/);
  });
});
