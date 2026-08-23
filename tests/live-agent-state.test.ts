import { describe, it, expect } from "vitest";
import type { AgentRecord } from "../src/agent-types.js";
import {
  INTERACTIVE_AGENT_STATES,
  TERMINAL_AGENT_STATES,
  isLiveDeliverable,
  isLiveInteractive,
  isLiveTerminal,
  resolveLiveAgentState,
  screenConfirmedAgentState,
} from "../src/live-agent-state.js";

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agent_id: "cmuxlayerClaude-f1",
    surface_id: "surface:f1",
    workspace_id: "workspace:1",
    state: "done",
    repo: "cmuxlayer",
    model: "claude-opus-5",
    cli: "claude",
    cli_session_id: null,
    task_summary: "F1",
    pid: null,
    version: 1,
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-18T00:00:00.000Z",
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
  } as AgentRecord;
}

describe("screenConfirmedAgentState — the one screen->state rule", () => {
  it("reads an active screen as working", () => {
    expect(
      screenConfirmedAgentState({
        status: "working",
        agent_type: "claude",
        control_state: "busy",
      }),
    ).toBe("working");
  });

  it("reads an agent at a live prompt as ready", () => {
    expect(
      screenConfirmedAgentState({
        status: "idle",
        agent_type: "claude",
        control_state: "ready",
      }),
    ).toBe("ready");
  });

  it("reads a bare shell as error, never as a healthy idle agent", () => {
    expect(
      screenConfirmedAgentState({
        status: "idle",
        agent_type: "unknown",
        control_state: "shell",
      }),
    ).toBe("error");
  });

  it("returns null when there is no screen evidence at all", () => {
    expect(screenConfirmedAgentState(null)).toBeNull();
    expect(
      screenConfirmedAgentState({
        status: null,
        agent_type: null,
        control_state: null,
      }),
    ).toBeNull();
  });
});

describe("resolveLiveAgentState — live truth, registry as fallback provenance", () => {
  it("prefers the live screen over a stale done registry record", () => {
    const resolved = resolveLiveAgentState(record({ state: "done" }), {
      status: "working",
      agent_type: "claude",
      control_state: "busy",
    });
    expect(resolved).toMatchObject({
      state: "working",
      source: "screen",
      registry_state: "done",
      stale_registry_state: true,
    });
  });

  it("keeps a registry-done agent done at a ready prompt, but calls it deliverable", () => {
    // A worker that genuinely finished also sits at a ready prompt, so `ready`
    // must not overturn `done` -- that would erase done-detection. Delivery is
    // a separate question, and the live prompt answers it: yes.
    const resolved = resolveLiveAgentState(record({ state: "done" }), {
      status: "idle",
      agent_type: "claude",
      control_state: "ready",
    });
    expect(resolved.state).toBe("done");
    expect(resolved.screen_state).toBe("ready");
    expect(resolved.stale_registry_state).toBe(false);
    expect(isLiveInteractive(resolved)).toBe(false);
    expect(isLiveDeliverable(resolved)).toBe(true);
  });

  it("does not deliver into a ready composer while boot-prompt delivery still owns the pane", () => {
    const resolved = resolveLiveAgentState(record({ state: "booting" }), {
      status: "idle",
      agent_type: "claude",
      control_state: "ready",
    });

    expect(resolved.registry_state).toBe("booting");
    expect(resolved.screen_state).toBe("ready");
    expect(isLiveDeliverable(resolved)).toBe(false);
  });

  it("lets a ready prompt clear a stale error record", () => {
    const resolved = resolveLiveAgentState(record({ state: "error" }), {
      status: "idle",
      agent_type: "claude",
      control_state: "ready",
    });
    expect(resolved.state).toBe("ready");
    expect(resolved.source).toBe("screen");
    expect(INTERACTIVE_AGENT_STATES.has(resolved.state)).toBe(true);
  });

  it("falls back to the registry record when no screen evidence exists", () => {
    const resolved = resolveLiveAgentState(record({ state: "done" }), null);
    expect(resolved).toMatchObject({
      state: "done",
      source: "registry",
      registry_state: "done",
      screen_state: null,
      stale_registry_state: false,
    });
    expect(isLiveTerminal(resolved)).toBe(true);
    expect(isLiveDeliverable(resolved)).toBe(false);
  });

  it("does not invent staleness when screen and registry agree", () => {
    const resolved = resolveLiveAgentState(record({ state: "working" }), {
      status: "working",
      agent_type: "claude",
      control_state: "busy",
    });
    expect(resolved.stale_registry_state).toBe(false);
    expect(resolved.source).toBe("screen");
  });

  it("keeps a screen-confirmed terminal state terminal", () => {
    const resolved = resolveLiveAgentState(record({ state: "working" }), {
      status: "idle",
      agent_type: "unknown",
      control_state: "shell",
    });
    expect(resolved.state).toBe("error");
    expect(TERMINAL_AGENT_STATES.has(resolved.state)).toBe(true);
    expect(isLiveTerminal(resolved)).toBe(true);
  });
});
