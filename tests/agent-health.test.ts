import { describe, expect, it } from "vitest";
import {
  AGENT_HEALTH_INBOX_MONITOR_BOOT_GRACE_MS,
  evaluateAgentHealth,
} from "../src/agent-health.js";
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
  it("marks an owner unhealthy when its registered monitor collapsed", () => {
    const health = evaluateAgentHealth(makeRecord(), {
      monitor_alive: true,
      collapsed_monitors: [
        {
          monitor_id: "collab-watch",
          reason: "watch-target-missing",
        },
      ],
    });

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("monitor_collapsed");
    expect(health.issue_severities?.monitor_collapsed).toBe("blocking");
    expect(health.issues).toContain(
      "registered monitor collab-watch collapsed: watch-target-missing",
    );
    expect(health.recommended_actions).toContain(
      "repair_or_replace_collapsed_monitor",
    );
  });

  it("keeps a fresh agent healthy when it only has info-tier launch-time issues", () => {
    const createdAt = "2026-06-26T20:00:00.000Z";
    const health = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-cmuxlayerCodex-pending-1-abcd",
        state: "working",
        cli_session_id: null,
        cli_session_path: null,
        task_summary: "(auto-discovered)",
        created_at: createdAt,
      }),
      { monitor_alive: false, screen_status: "working" },
      { now: () => Date.parse(createdAt) + 1_000 },
    );

    expect(health.status).toBe("healthy");
    expect(health.issue_codes).toEqual([
      "auto_discovered_agent",
      "missing_cli_session_id",
      "non_resumable",
      "inbox_monitor_not_alive",
    ]);
    expect(health.issue_severities).toMatchObject({
      auto_discovered_agent: "info",
      missing_cli_session_id: "info",
      non_resumable: "info",
      inbox_monitor_not_alive: "info",
    });
  });

  it("escalates an absent inbox monitor after the boot grace window", () => {
    const createdAt = "2026-06-26T20:00:00.000Z";
    const withinGrace = evaluateAgentHealth(
      makeRecord({
        state: "working",
        cli_session_id: null,
        created_at: createdAt,
      }),
      { monitor_alive: false, screen_status: "working" },
      {
        now: () =>
          Date.parse(createdAt) + AGENT_HEALTH_INBOX_MONITOR_BOOT_GRACE_MS - 1,
      },
    );
    const pastGrace = evaluateAgentHealth(
      makeRecord({
        state: "working",
        cli_session_id: null,
        created_at: createdAt,
      }),
      { monitor_alive: false, screen_status: "working" },
      {
        now: () =>
          Date.parse(createdAt) + AGENT_HEALTH_INBOX_MONITOR_BOOT_GRACE_MS + 1,
      },
    );

    expect(withinGrace.issue_severities?.inbox_monitor_not_alive).toBe("info");
    expect(withinGrace.status).toBe("healthy");
    expect(pastGrace.issue_severities?.inbox_monitor_not_alive).toBe(
      "degraded",
    );
    expect(pastGrace.status).toBe("degraded");
  });

  it("marks auto-discovered agents as info if they look ready", () => {
    const createdAt = "2026-06-26T20:00:00.000Z";
    const health = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-codex-surface-306",
        task_summary: "(auto-discovered)",
        cli_session_id: null,
        created_at: createdAt,
      }),
      { monitor_alive: false },
      { now: () => Date.parse(createdAt) + 1_000 },
    );

    expect(health.status).toBe("healthy");
    expect(health.issue_codes).toContain("auto_discovered_agent");
    expect(health.issue_codes).toContain("missing_cli_session_id");
    expect(health.issue_severities).toMatchObject({
      auto_discovered_agent: "info",
      missing_cli_session_id: "info",
    });
  });

  it("distinguishes a deleted inbox channel dir from a never-armed monitor", () => {
    const deleted = evaluateAgentHealth(makeRecord(), {
      monitor_alive: false,
      inbox_channel_dir_deleted: true,
    });
    const neverArmed = evaluateAgentHealth(makeRecord(), {
      monitor_alive: false,
    });

    expect(deleted.issue_codes).toContain("inbox_channel_dir_deleted");
    expect(deleted.issue_codes).not.toContain("inbox_monitor_not_alive");
    expect(neverArmed.issue_codes).toContain("inbox_monitor_not_alive");
    expect(neverArmed.issue_codes).not.toContain("inbox_channel_dir_deleted");
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

    expect(health.status).toBe("degraded");
    expect(health.issue_codes).toContain("auto_discovered_agent");
    expect(health.issue_codes).toContain("missing_managed_lead_agent_id");
    expect(health.issue_severities?.missing_managed_lead_agent_id).toBe(
      "degraded",
    );
  });

  it("marks ambiguous auto-discovered repo labels as degraded label hygiene", () => {
    const health = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-codex-surface-999",
        task_summary: "(auto-discovered)",
        repo: "Gits",
        cli_session_id: null,
      }),
      { monitor_alive: false },
    );

    expect(health.status).toBe("degraded");
    expect(health.issue_codes).toContain("ambiguous_repo_cwd_label");
    expect(health.issue_severities?.ambiguous_repo_cwd_label).toBe("info");
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

  it("treats registry done while the screen is working as a screen-liveness signal", () => {
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

    expect(health.status).toBe("healthy");
    expect(health.reconciled_state).toBe("working");
    expect(health.issue_codes).toContain("registry_screen_disagreement");
    expect(health.issue_severities?.registry_screen_disagreement).toBe("info");
  });

  it("blocks a live-spinner pane after repeated recent broken-pipe writes", () => {
    const health = evaluateAgentHealth(
      makeRecord({ state: "done" }),
      {
        monitor_alive: true,
        screen_status: "thinking",
        surface_write_liveness: {
          pty_dead: true,
          consecutive_broken_pipe_failures: 2,
          last_attempt_at: 2_000,
        },
      },
    );

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("pane_pty_dead");
    expect(health.issue_severities?.pane_pty_dead).toBe("blocking");
    expect(health.issue_severities?.registry_screen_disagreement).toBe(
      "degraded",
    );
  });

  it("does not flag one transient broken-pipe write", () => {
    const health = evaluateAgentHealth(
      makeRecord({ state: "done" }),
      {
        monitor_alive: true,
        screen_status: "working",
        surface_write_liveness: {
          pty_dead: false,
          consecutive_broken_pipe_failures: 1,
          last_attempt_at: 1_000,
        },
      },
    );

    expect(health.issue_codes).not.toContain("pane_pty_dead");
    expect(health.issue_severities?.registry_screen_disagreement).toBe("info");
    expect(health.status).toBe("healthy");
  });

  it("leaves active-screen health unchanged after a healthy write", () => {
    const health = evaluateAgentHealth(
      makeRecord({ state: "working" }),
      {
        monitor_alive: true,
        screen_status: "thinking",
        surface_write_liveness: {
          pty_dead: false,
          consecutive_broken_pipe_failures: 0,
          last_attempt_at: 1_000,
        },
      },
    );

    expect(health.issue_codes).not.toContain("pane_pty_dead");
    expect(health.status).toBe("healthy");
  });

  it("marks registry working while the screen parses done as degraded registry lag", () => {
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

    expect(health.status).toBe("degraded");
    expect(health.issue_codes).toContain("registry_screen_disagreement");
    expect(health.issue_severities?.registry_screen_disagreement).toBe(
      "degraded",
    );
  });

  it("marks stale dispatches on a live monitor as wedged, not dead", () => {
    const health = evaluateAgentHealth(makeRecord({ state: "working" }), {
      monitor_alive: true,
      stale_count: 2,
      screen_status: "working",
    });

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("stale_inbox_dispatches");
    expect(health.issue_codes).toContain("agent_wedged");
    expect(health.issue_codes).not.toContain("inbox_monitor_not_alive");
  });

  it("does not mark stale dispatches as wedged when monitor liveness is unknown", () => {
    const health = evaluateAgentHealth(makeRecord({ state: "working" }), {
      stale_count: 2,
      screen_status: "working",
    });

    expect(health.status).toBe("unhealthy");
    expect(health.issue_codes).toContain("stale_inbox_dispatches");
    expect(health.issue_codes).not.toContain("agent_wedged");
    expect(health.issue_codes).not.toContain("inbox_monitor_not_alive");
  });

  it("marks an absent monitor as degraded evidence, not a wedged live pane", () => {
    const health = evaluateAgentHealth(makeRecord({ state: "working" }), {
      monitor_alive: false,
      stale_count: 0,
      screen_status: "working",
    });

    expect(health.status).toBe("degraded");
    expect(health.issue_codes).toContain("inbox_monitor_not_alive");
    expect(health.issue_codes).not.toContain("agent_wedged");
  });

  it("marks registry workspace mismatch against the live surface as unhealthy", () => {
    const health = evaluateAgentHealth(
      makeRecord({ workspace_id: "workspace:5" }),
      {
        monitor_alive: true,
        surface_workspace_id: "workspace:1",
      },
    );

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

  it("does not mark non-done agents unhealthy for degraded closure evidence", () => {
    const health = evaluateAgentHealth(makeRecord({ state: "working" }), {
      monitor_alive: true,
      harvestability: {
        closeable: false,
        closure_artifact_verified: null,
        report_path: null,
        done_marker: null,
        report_exists: null,
        report_fresh: null,
        report_final_line: null,
        pr_loop_required: false,
        pr_loop_satisfied: null,
        kept_open: null,
        evidence_channel: {
          done_source: "none",
          degraded: true,
          reason: "missing completion transcript",
        },
        issue_codes: ["degraded_evidence_channel"],
        issues: ["missing completion transcript"],
      },
    });

    expect(health.issue_codes).not.toContain("degraded_evidence_channel");
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

  it("downgrades resync-repaired column placement flags to info", () => {
    const repairedLead = evaluateAgentHealth(
      makeRecord({
        agent_id: "driverBuddy",
        cli: "claude",
        role: "orchestrator",
        repo: "driverBuddy",
        launcher_name: "driverBuddyClaude",
        seat_id: "driverBuddy",
        task_summary: "(resync-repaired)",
      }),
      {
        monitor_alive: true,
        surface_title: "driverBuddy",
        topology: { column: 1, column_count: 2 },
      },
    );
    const repairedWorker = evaluateAgentHealth(
      makeRecord({
        agent_id: "pr3-quadratic-fix",
        role: "worker",
        launcher_name: "cmuxlayerCodex",
        task_summary: "(resync-repaired)",
      }),
      {
        monitor_alive: true,
        surface_title: "pr3-quadratic-fix",
        topology: { column: 0, column_count: 2 },
      },
    );

    expect(repairedLead.status).toBe("healthy");
    expect(repairedLead.issue_codes).toContain("orchestrator_not_leftmost");
    expect(repairedLead.issue_severities).toMatchObject({
      orchestrator_not_leftmost: "info",
    });
    expect(repairedLead.issue_codes).not.toContain("auto_discovered_agent");

    expect(repairedWorker.status).toBe("healthy");
    expect(repairedWorker.issue_codes).toContain("worker_in_leftmost_column");
    expect(repairedWorker.issue_severities).toMatchObject({
      worker_in_leftmost_column: "info",
    });
    expect(repairedWorker.issue_codes).not.toContain("auto_discovered_agent");
  });

  it("keeps managed spawn_agent column placement flags blocking", () => {
    const managedLead = evaluateAgentHealth(
      makeRecord({
        agent_id: "cmuxlayerLead",
        cli: "claude",
        role: "orchestrator",
        repo: "cmuxlayer",
        launcher_name: "cmuxlayerClaude",
        seat_id: "cmuxlayerLead",
        task_summary: "Coordinate the column-flag follow-up",
      }),
      {
        monitor_alive: true,
        surface_title: "cmuxlayerClaude",
        topology: { column: 1, column_count: 2 },
      },
    );
    const managedWorker = evaluateAgentHealth(
      makeRecord({
        agent_id: "cmuxlayerCodex-pending-1-abcd",
        role: "worker",
        task_summary: "Implement the column-flag fix",
      }),
      {
        monitor_alive: true,
        surface_title: "cmuxlayerCodex",
        topology: { column: 0, column_count: 2 },
      },
    );

    expect(managedLead.status).toBe("unhealthy");
    expect(managedLead.issue_severities?.orchestrator_not_leftmost).toBe(
      "blocking",
    );
    expect(managedWorker.status).toBe("unhealthy");
    expect(managedWorker.issue_severities?.worker_in_leftmost_column).toBe(
      "blocking",
    );
  });

  it("downgrades auto-discovered column placement flags to info", () => {
    const autoLead = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-claude-surface-32",
        cli: "claude",
        role: "orchestrator",
        repo: "driverBuddy",
        task_summary: "(auto-discovered)",
      }),
      {
        monitor_alive: true,
        surface_title: "driverBuddy",
        topology: { column: 1, column_count: 2 },
      },
    );
    const autoWorker = evaluateAgentHealth(
      makeRecord({
        agent_id: "auto-codex-surface-112",
        role: "worker",
        task_summary: "(auto-discovered)",
      }),
      {
        monitor_alive: true,
        surface_title: "pr3-quadratic-fix",
        topology: { column: 0, column_count: 2 },
      },
    );

    expect(autoLead.status).toBe("healthy");
    expect(autoLead.issue_codes).toContain("orchestrator_not_leftmost");
    expect(autoLead.issue_severities).toMatchObject({
      auto_discovered_agent: "info",
      orchestrator_not_leftmost: "info",
    });
    expect(autoWorker.status).toBe("healthy");
    expect(autoWorker.issue_codes).toContain("worker_in_leftmost_column");
    expect(autoWorker.issue_severities).toMatchObject({
      auto_discovered_agent: "info",
      worker_in_leftmost_column: "info",
    });
  });
});
