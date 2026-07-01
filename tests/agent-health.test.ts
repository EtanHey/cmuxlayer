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
      makeRecord({
        cli: "claude",
        role: "orchestrator",
        cli_session_id: null,
        cli_session_path: null,
      }),
      { monitor_alive: false },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toEqual([
      "missing_cli_session_id",
      "non_resumable",
      "inbox_monitor_not_alive",
    ]);
    expect(health.recommended_actions).toEqual([
      "capture_cli_session_or_respawn_managed",
      "restart_inbox_monitor_or_nudge",
    ]);
  });

  it("reclassifies Codex worker inbox absence as a turn nudge requirement", () => {
    const health = evaluateAgentHealth(makeRecord(), {
      monitor_alive: false,
    });

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("inbox_turn_nudge_required");
    expect(health.issue_codes).not.toContain("inbox_monitor_not_alive");
    expect(health.recommended_actions).toContain(
      "dispatch_to_agent_with_nudge_auto",
    );
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

  it("allows explicit managed non-Claude orchestrators", () => {
    const health = evaluateAgentHealth(
      makeRecord({ cli: "codex", role: "orchestrator" }),
      { monitor_alive: true },
    );

    expect(health.status).toBe("healthy");
    expect(health.issue_codes).not.toContain("non_claude_orchestrator");
  });

  it("marks auto-discovered non-Claude orchestrators as role health failures", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-codex-surface-325",
        task_summary: "(auto-discovered)",
        cli: "codex",
        role: "orchestrator",
      }),
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
    expect(health.recommended_actions).toContain(
      "resync_agents_and_trust_screen",
    );
  });

  it("classifies registry done from file evidence with a working screen as parser drift", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        state: "done",
        task_done_detected_at: "2026-06-27T08:45:29.000Z",
        task_done_evidence_source: "file",
        task_done_evidence: "/tmp/agent-01.md:DONE_POSTFIX2_AGENT_01",
      }),
      {
        monitor_alive: true,
        screen_status: "working",
      },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain(
      "parser_drift_after_done_evidence",
    );
    expect(health.issue_codes).not.toContain("registry_screen_disagreement");
    expect(health.recommended_actions).toContain(
      "trust_done_evidence_and_refresh_parser",
    );
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

  it("marks a visually interrupted or dead pane as recoverable pane render death", () => {
    const health = evaluateAgentHealth(makeRecord({ state: "working" }), {
      monitor_alive: true,
      screen_status: "working",
      screen_text:
        "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (42m 10s • esc to interrupt)\nInterrupted",
    });

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("pane_render_dead_or_interrupted");
    expect(health.recommended_actions).toContain(
      "recover_or_respawn_pane_from_cli_session",
    );
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

  it("marks child TASK_DONE without a parent wake as completion_notification_missing", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        state: "done",
        parent_agent_id: "cmuxlayerLead-1234",
        task_done_detected_at: "2026-06-27T08:45:29.000Z",
      }),
      { monitor_alive: true },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("completion_notification_missing");
    expect(health.recommended_actions).toContain(
      "notify_parent_lead_and_restart_monitor",
    );
  });

  it("keeps a child TASK_DONE healthy after a recorded parent wake", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        state: "done",
        parent_agent_id: "cmuxlayerLead-1234",
        task_done_detected_at: "2026-06-27T08:45:29.000Z",
        completion_notification_sent_at: "2026-06-27T08:45:30.000Z",
        completion_notification_channel: "cmux_notify",
      }),
      { monitor_alive: true },
    );

    expect(health.issue_codes).not.toContain(
      "completion_notification_missing",
    );
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
