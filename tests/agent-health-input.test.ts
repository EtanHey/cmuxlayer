import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAgentHealthInput } from "../src/agent-health-input.js";
import type { AgentRecord } from "../src/agent-types.js";

function makeAgent(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "agent-health-input-test",
    surface_id: "surface:1",
    state: "working",
    repo: "brainlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: "session-1",
    task_summary: "Test helper",
    pid: null,
    version: 1,
    created_at: "2026-07-05T12:00:00Z",
    updated_at: "2026-07-05T12:00:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  };
}

describe("buildAgentHealthInput", () => {
  it("preserves explicit null monitor overrides", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "cmux-agent-health-input-"));
    try {
      const input = await buildAgentHealthInput(
        makeAgent(),
        { inboxOpts: { baseDir: tmp } },
        {
          monitor_alive: null,
          inbox_channel_dir_deleted: null,
        },
      );

      expect(input.monitor_alive).toBeNull();
      expect(input.inbox_channel_dir_deleted).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats parsed surface read failures as absent screen input", async () => {
    const input = await buildAgentHealthInput(makeAgent(), {
      readParsedSurface: async () => {
        throw new Error("cmux read failed");
      },
    });

    expect(input.screen_status).toBeUndefined();
    expect(input.screen_actions).toBeUndefined();
  });

  it("threads the latest surface write-liveness observation into health input", async () => {
    const observation = {
      pty_dead: true,
      consecutive_broken_pipe_failures: 2,
      last_attempt_at: 2_000,
    };

    const input = await buildAgentHealthInput(makeAgent(), {
      observeSurfaceWriteLiveness: (agent) =>
        agent.surface_id === "surface:1" ? observation : null,
    });

    expect(input.surface_write_liveness).toEqual(observation);
  });
});
