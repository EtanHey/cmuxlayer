import type { AgentRecord } from "./agent-types.js";
import { inferRecordRoleOrNull } from "./layout-policy.js";

export type AgentHealthStatus = "healthy" | "unhealthy";

export type AgentHealthIssueCode =
  | "auto_discovered_agent"
  | "missing_cli_session_id"
  | "non_resumable"
  | "inbox_monitor_not_alive"
  | "stale_inbox_dispatches"
  | "inbox_turn_nudge_required"
  | "registry_screen_disagreement"
  | "parser_drift_after_done_evidence"
  | "pane_render_dead_or_interrupted"
  | "registry_surface_workspace_mismatch"
  | "closure_without_artifact"
  | "completion_notification_missing"
  | "recoverable_blocker_requires_action"
  | "missing_managed_lead_agent_id"
  | "ambiguous_repo_cwd_label"
  | "non_claude_orchestrator"
  | "topology_three_or_more_columns"
  | "orchestrator_not_leftmost"
  | "worker_in_leftmost_column";

export interface AgentTopologyHealthInput {
  column: number | null;
  column_count: number | null;
}

export interface AgentHealthInput {
  monitor_alive?: boolean | null;
  stale_count?: number;
  screen_status?: string | null;
  screen_text?: string | null;
  surface_workspace_id?: string | null;
  surface_title?: string | null;
  closure_artifact_verified?: boolean | null;
  screen_actions?: string[] | null;
  topology?: AgentTopologyHealthInput | null;
}

export interface AgentHealth {
  status: AgentHealthStatus;
  issue_codes: AgentHealthIssueCode[];
  issues: string[];
  recommended_actions?: string[];
}

function addIssue(
  codes: AgentHealthIssueCode[],
  issues: string[],
  code: AgentHealthIssueCode,
  message: string,
): void {
  codes.push(code);
  issues.push(message);
}

const RECOVERABLE_ACTION_RECOMMENDATIONS: Record<string, string> = {
  "recoverable_blocker:pr_loop": "route_pr_loop",
  "recoverable_blocker:restart": "restart_in_scope_mcp_or_daemon",
  "recoverable_blocker:successor": "resume_or_spawn_managed_successor",
};

function addRecommendedAction(actions: string[], action: string): void {
  if (!actions.includes(action)) actions.push(action);
}

function isLongRunning(agent: AgentRecord): boolean {
  return (
    agent.state !== "creating" &&
    agent.state !== "booting" &&
    agent.state !== "done" &&
    agent.state !== "error"
  );
}

function isAutoDiscovered(agent: AgentRecord): boolean {
  return (
    agent.agent_id.startsWith("auto-") ||
    agent.task_summary === "(auto-discovered)"
  );
}

function looksLeadLike(text: string | null | undefined): boolean {
  return /\b(?:lead|orchestrator|coordinator|coord)\b/i.test(text ?? "");
}

function hasAmbiguousRepoOrCwdLabel(agent: AgentRecord): boolean {
  const repo = agent.repo.trim().toLowerCase();
  const cwd = (agent.launch_cwd ?? "").trim().toLowerCase();
  const ambiguousNames = new Set([
    "",
    "git",
    "gits",
    "repo",
    "repos",
    "workspace",
    "workspaces",
    "projects",
  ]);
  return (
    ambiguousNames.has(repo) ||
    /\/(?:gits|repos|projects|workspaces)\/?$/.test(cwd)
  );
}

function hasPaneRenderDeathEvidence(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\b(?:interrupted|terminal disconnected|pane died|process died|pty died|session terminated)\b/i.test(
    text,
  );
}

export function evaluateAgentHealth(
  agent: AgentRecord,
  input: AgentHealthInput = {},
): AgentHealth {
  const issueCodes: AgentHealthIssueCode[] = [];
  const issues: string[] = [];
  const recommendedActions: string[] = [];
  const role = inferRecordRoleOrNull(agent);

  if (isAutoDiscovered(agent)) {
    addIssue(
      issueCodes,
      issues,
      "auto_discovered_agent",
      "agent was auto-discovered, not created through managed spawn_agent",
    );
    addRecommendedAction(recommendedActions, "replace_with_managed_spawn");

    if (looksLeadLike(input.surface_title) || looksLeadLike(agent.repo)) {
      addIssue(
        issueCodes,
        issues,
        "missing_managed_lead_agent_id",
        "lead/coordinator surface has no managed agent_id; recover/register or replace with a managed lead",
      );
      addRecommendedAction(recommendedActions, "recover_or_replace_managed_lead");
    }

    if (hasAmbiguousRepoOrCwdLabel(agent)) {
      addIssue(
        issueCodes,
        issues,
        "ambiguous_repo_cwd_label",
        "auto-discovered agent has an ambiguous repo/cwd label; tab title is not lane ownership",
      );
    }
  }

  if (isLongRunning(agent) && !agent.cli_session_id) {
    addIssue(
      issueCodes,
      issues,
      "missing_cli_session_id",
      "managed long-running agent has no cli_session_id",
    );
    addRecommendedAction(recommendedActions, "capture_cli_session_or_respawn_managed");
    addIssue(
      issueCodes,
      issues,
      "non_resumable",
      "agent cannot be resumed because no CLI session id was captured",
    );
  }

  if (input.monitor_alive === false) {
    if (
      (agent.cli === "codex" || agent.cli === "cursor") &&
      role === "worker"
    ) {
      addIssue(
        issueCodes,
        issues,
        "inbox_turn_nudge_required",
        "Codex/Cursor worker has no live async inbox monitor; dispatch with nudge:auto or send a guarded turn nudge so it reads its inbox",
      );
      addRecommendedAction(
        recommendedActions,
        "dispatch_to_agent_with_nudge_auto",
      );
    } else {
    addIssue(
      issueCodes,
      issues,
      "inbox_monitor_not_alive",
      "agent inbox monitor heartbeat is absent or stale",
    );
    addRecommendedAction(recommendedActions, "restart_inbox_monitor_or_nudge");
    }
  }

  if ((input.stale_count ?? 0) > 0) {
    addIssue(
      issueCodes,
      issues,
      "stale_inbox_dispatches",
      "agent has unacked inbox dispatches past the ACK timeout",
    );
    addRecommendedAction(recommendedActions, "restart_inbox_monitor_or_nudge");
  }

  const screenActive =
    input.screen_status === "working" || input.screen_status === "thinking";
  const screenDone = input.screen_status === "done";
  const registryActive =
    agent.state === "creating" ||
    agent.state === "booting" ||
    agent.state === "working";
  const registryInactive =
    agent.state === "ready" ||
    agent.state === "idle" ||
    agent.state === "done" ||
    agent.state === "error";
  if (screenActive && registryInactive && agent.task_done_evidence_source) {
    addIssue(
      issueCodes,
      issues,
      "parser_drift_after_done_evidence",
      `registry state is ${agent.state} from ${agent.task_done_evidence_source} DONE evidence while screen still parses as ${input.screen_status}`,
    );
    addRecommendedAction(
      recommendedActions,
      "trust_done_evidence_and_refresh_parser",
    );
  } else if ((screenActive && registryInactive) || (screenDone && registryActive)) {
    addIssue(
      issueCodes,
      issues,
      "registry_screen_disagreement",
      `registry state is ${agent.state} while screen parses as ${input.screen_status}`,
    );
    addRecommendedAction(recommendedActions, "resync_agents_and_trust_screen");
  }

  if (isLongRunning(agent) && hasPaneRenderDeathEvidence(input.screen_text)) {
    addIssue(
      issueCodes,
      issues,
      "pane_render_dead_or_interrupted",
      "pane screen shows interrupted/dead render state while the managed agent is still long-running",
    );
    addRecommendedAction(
      recommendedActions,
      "recover_or_respawn_pane_from_cli_session",
    );
  }

  if (
    input.surface_workspace_id !== undefined &&
    input.surface_workspace_id !== null &&
    (agent.workspace_id ?? null) !== input.surface_workspace_id
  ) {
    addIssue(
      issueCodes,
      issues,
      "registry_surface_workspace_mismatch",
      `registry workspace is ${agent.workspace_id ?? "null"} while surface is in ${input.surface_workspace_id}`,
    );
    addRecommendedAction(recommendedActions, "resync_agents_and_correct_workspace");
  }

  if (input.closure_artifact_verified === false) {
    addIssue(
      issueCodes,
      issues,
      "closure_without_artifact",
      "worker closure is not backed by a verified DONE marker, BLOCKED/NOT_GREEN handoff, or successor transfer",
    );
    addRecommendedAction(recommendedActions, "verify_done_artifact_or_blocked_handoff");
  }

  if (
    agent.parent_agent_id &&
    agent.state === "done" &&
    agent.task_done_detected_at &&
    !agent.completion_notification_sent_at
  ) {
    addIssue(
      issueCodes,
      issues,
      "completion_notification_missing",
      agent.completion_notification_error
        ? `worker completed but parent lead notification failed: ${agent.completion_notification_error}`
        : "worker completed but no parent lead completion notification was recorded",
    );
    addRecommendedAction(recommendedActions, "notify_parent_lead_and_restart_monitor");
  }

  const recoverableBlockerActions = Array.from(
    new Set(
      (input.screen_actions ?? []).filter((action) =>
        action.startsWith("recoverable_blocker:"),
      ),
    ),
  );
  if (recoverableBlockerActions.length > 0) {
    addIssue(
      issueCodes,
      issues,
      "recoverable_blocker_requires_action",
      `screen reports recoverable blocker(s): ${recoverableBlockerActions.join(", ")}; route recovery instead of waiting for user`,
    );
    for (const action of recoverableBlockerActions) {
      const recommendation = RECOVERABLE_ACTION_RECOMMENDATIONS[action];
      if (recommendation) {
        addRecommendedAction(recommendedActions, recommendation);
      }
    }
  }

  if (agent.cli !== "claude" && role === "orchestrator" && isAutoDiscovered(agent)) {
    addIssue(
      issueCodes,
      issues,
      "non_claude_orchestrator",
      "auto-discovered non-Claude orchestrator is not a valid lead; replace with a managed lead or worker",
    );
    addRecommendedAction(recommendedActions, "recover_or_replace_managed_lead");
  }

  const topology = input.topology;
  if (topology && topology.column_count !== null) {
    if (topology.column_count >= 3) {
      addIssue(
        issueCodes,
        issues,
        "topology_three_or_more_columns",
        `workspace has ${topology.column_count} columns; expected at most two lead/worker columns`,
      );
      addRecommendedAction(recommendedActions, "repair_workspace_topology");
    }
    if (role === "orchestrator" && topology.column !== null && topology.column > 0) {
      addIssue(
        issueCodes,
        issues,
        "orchestrator_not_leftmost",
        `orchestrator is in column ${topology.column}; expected leftmost column 0`,
      );
      addRecommendedAction(recommendedActions, "repair_workspace_topology");
    }
    if (role === "worker" && topology.column === 0 && topology.column_count >= 2) {
      addIssue(
        issueCodes,
        issues,
        "worker_in_leftmost_column",
        "worker is in the leftmost lead column; expected worker column on the right",
      );
      addRecommendedAction(recommendedActions, "repair_workspace_topology");
    }
  }

  return {
    status: issueCodes.length === 0 ? "healthy" : "unhealthy",
    issue_codes: issueCodes,
    issues,
    ...(recommendedActions.length > 0
      ? { recommended_actions: recommendedActions }
      : {}),
  };
}
