import { describe, expect, it } from "vitest";
import { evaluateAgentHealth } from "../src/agent-health.js";
import type { AgentRecord } from "../src/agent-types.js";

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "cmuxlayerCodex-pending-1-abcd",
    surface_id: "surface:1",
    workspace_id: "workspace:1",
    state: "ready",
    repo: "cmuxlayer",
    model: "gpt-5.5",
    cli: "codex",
    cli_session_id: "019f0001-1111-7222-8333-444455556666",
    cli_session_path: null,
    launcher_name: "cmuxlayerCodex",
    task_summary: "Fix lifecycle",
    pid: null,
    version: 1,
    created_at: "2026-06-26T20:00:00.000Z",
    updated_at: "2026-06-26T20:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: true,
    respawn_attempts: 0,
    user_killed: false,
    boot_prompt_pending: false,
    launch_cwd: null,
    mcp_profile: null,
    worktree_path: null,
    worktree_branch: null,
    ...overrides,
  };
}

describe("agent lifecycle health", () => {
  it("marks a ready managed agent without a CLI session or monitor as unhealthy", () => {
    const health = evaluateAgentHealth(
      makeRecord({ cli_session_id: null, cli_session_path: null }),
      { monitor_alive: false },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toEqual([
      "missing_cli_session_id",
      "non_resumable",
      "inbox_monitor_not_alive",
    ]);
  });

  it("marks auto-discovered agents as unhealthy even if they look ready", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-codex-surface-306",
        task_summary: "(auto-discovered)",
        cli_session_id: null,
      }),
      { monitor_alive: false },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("auto_discovered_agent");
    expect(health.issue_codes).toContain("missing_cli_session_id");
  });

  it("marks auto-discovered lead surfaces as missing managed lead ids", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-codex-surface-325",
        task_summary: "(auto-discovered)",
        repo: "M1 Lead",
        cli_session_id: null,
      }),
      { monitor_alive: false, surface_title: "M1 LEAD VoiceLayerCodex" },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("auto_discovered_agent");
    expect(health.issue_codes).toContain("missing_managed_lead_agent_id");
  });

  it("marks ambiguous auto-discovered repo labels as unhealthy", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-codex-surface-999",
        task_summary: "(auto-discovered)",
        repo: "Gits",
        cli_session_id: null,
      }),
      { monitor_alive: false },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("ambiguous_repo_cwd_label");
  });

  it("marks non-Claude orchestrators as role health failures", () => {
    const health = evaluateAgentHealth(
      makeRecord({ cli: "codex", role: "orchestrator" }),
      { monitor_alive: true },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("non_claude_orchestrator");
  });

  it("marks unexpected three-column topology as unhealthy", () => {
    const health = evaluateAgentHealth(makeRecord(), {
      monitor_alive: true,
      topology: { column: 2, column_count: 3 },
    });

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("topology_three_or_more_columns");
  });

  it("marks registry done while the screen is working as unhealthy", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        state: "done",
        cli_session_id: "019f0001-1111-7222-8333-444455556666",
      }),
      {
        monitor_alive: true,
        screen_status: "working",
      },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("registry_screen_disagreement");
  });

  it("marks registry working while the screen parses done as unhealthy", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        state: "working",
        cli_session_id: "019f0001-1111-7222-8333-444455556666",
      }),
      {
        monitor_alive: true,
        screen_status: "done",
      },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("registry_screen_disagreement");
  });

  it("marks registry workspace mismatch against the live surface as unhealthy", () => {
    const health = evaluateAgentHealth(makeRecord({ workspace_id: "workspace:5" }), {
      monitor_alive: true,
      surface_workspace_id: "workspace:1",
    });

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("registry_surface_workspace_mismatch");
  });

  it("marks worker closure without a verified artifact as unhealthy", () => {
    const health = evaluateAgentHealth(makeRecord({ state: "done" }), {
      monitor_alive: true,
      closure_artifact_verified: false,
    });

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("closure_without_artifact");
  });

  it("marks recoverable permission-parking blockers as action-required health failures", () => {
    const health = evaluateAgentHealth(makeRecord(), {
      monitor_alive: true,
      screen_actions: [
        "recoverable_blocker:pr_loop",
        "recoverable_blocker:restart",
        "recoverable_blocker:successor",
      ],
    } as any);

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("recoverable_blocker_requires_action");
    expect(health.recommended_actions).toEqual([
      "route_pr_loop",
      "restart_in_scope_mcp_or_daemon",
      "resume_or_spawn_managed_successor",
    ]);
  });

  it("keeps a sessionful worker with live monitor in a two-column layout healthy", () => {
    const health = evaluateAgentHealth(makeRecord(), {
      monitor_alive: true,
      topology: { column: 1, column_count: 2 },
    });

    expect(health).toEqual({
      status: "healthy",
      issue_codes: [],
      issues: [],
    });
  });
});
