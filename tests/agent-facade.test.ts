import { describe, expect, it } from "vitest";
import {
  buildRouteTable,
  resolveAgentRoute,
  toAgentStatePayload,
  toObservedPublicAgent,
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
    cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
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
  it("timestamps a registry model fallback as a registry observation", () => {
    const projected = toObservedPublicAgent(makeRecord(), {
      derivedAtMs: 2_000,
      screenObservedAtMs: 1_000,
      screenModel: null,
    });

    expect(projected.model).toEqual({
      value: "sonnet",
      source: "registry",
      observed_at_ms: 2_000,
    });
  });

  it("projects durable prompt blockage in the summary row", () => {
    const projected = toObservedPublicAgent(
      makeRecord({ blocked_on_prompt: true }),
      { derivedAtMs: 2_000 },
    );

    expect(projected.blocked_on_prompt).toEqual({
      value: true,
      source: "registry",
      observed_at_ms: 2_000,
    });
  });

  it("projects paused visibility with the pause source, not registry provenance", () => {
    const projected = toObservedPublicAgent(
      makeRecord({ paused: true, paused_source: "inferred" }),
      { derivedAtMs: 2_000 },
    );

    expect(projected.paused).toEqual({
      value: true,
      source: "inferred",
      observed_at_ms: 2_000,
    });
  });

  it("exposes whether a listed agent was spawned or adopted", () => {
    const projected = toObservedPublicAgent(
      makeRecord({ surface_provenance: "cmuxlayer_spawn" }),
      { derivedAtMs: 2_000 },
    );

    expect(projected.surface_provenance).toBe("cmuxlayer_spawn");
  });

  it("projects a PublicAgent without leaking surface topology", () => {
    const projected = toPublicAgent(makeRecord());

    expect(projected).toEqual({
      agent_id: "agent-1",
      repo: "brainlayer",
      model: "sonnet",
      state: "ready",
      session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      resumable: true,
      submit_verified: null,
      model_mismatch: null,
      resume_command:
        "brainlayerClaude -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
    expect((projected as any).surface_id).toBeUndefined();
  });

  it("omits resume_command when no session id has been captured", () => {
    const projected = toPublicAgent(makeRecord({ cli_session_id: null }));

    expect(projected).toEqual({
      agent_id: "agent-1",
      repo: "brainlayer",
      model: "sonnet",
      state: "ready",
      session_id: null,
      resumable: false,
      submit_verified: null,
      model_mismatch: null,
    });
  });

  it("preserves boot submit verification and model mismatch in the public projection", () => {
    const projected = toPublicAgent(
      makeRecord({
        submit_verified: false,
        model_mismatch: true,
      }),
    );

    expect(projected).toMatchObject({
      submit_verified: false,
      model_mismatch: true,
    });
  });

  it("keeps auto-revive progress in the full agent-state payload", () => {
    const projected = toAgentStatePayload(
      makeRecord({
        revive_attempts: 3,
        revive_last_outcome: "failed",
        revive_next_attempt_at: "2026-08-13T08:00:08.000Z",
      }),
    );

    expect(projected).toMatchObject({
      revive_attempts: 3,
      revive_last_outcome: "failed",
      revive_next_attempt_at: "2026-08-13T08:00:08.000Z",
    });
  });
});

describe("agent route table", () => {
  it("builds routes keyed by agent_id", () => {
    const table = buildRouteTable([
      makeRecord({
        agent_id: "agent-1",
        surface_id: "surface:1",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
      }),
      makeRecord({ agent_id: "agent-2", surface_id: "surface:2" }),
    ]);

    expect(table.get("agent-1")).toEqual({
      agent_id: "agent-1",
      surface_id: "surface:1",
      surface_uuid: "11111111-2222-4333-8444-555555555555",
      workspace_id: "ws:1",
      state: "ready",
      session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      resumable: true,
      resume_command:
        "brainlayerClaude -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
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
