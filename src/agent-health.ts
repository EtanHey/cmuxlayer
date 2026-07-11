import type { AgentRecord, AgentRole, AgentState } from "./agent-types.js";
import type { WorkerHarvestability } from "./agent-engine.js";
import type { SurfaceWriteLivenessObservation } from "./surface-write-liveness.js";
import {
  inferAgentRole,
  inferRecordRoleOrNull,
  isAgentRoleInferenceError,
} from "./layout-policy.js";

export type AgentHealthStatus = "healthy" | "degraded" | "unhealthy";
export type AgentHealthIssueSeverity = "blocking" | "degraded" | "info";

export type AgentHealthIssueCode =
  | "auto_discovered_agent"
  | "missing_cli_session_id"
  | "non_resumable"
  | "inbox_channel_dir_deleted"
  | "inbox_monitor_not_alive"
  | "monitor_collapsed"
  | "stale_inbox_dispatches"
  | "agent_wedged"
  | "pane_pty_dead"
  | "registry_screen_disagreement"
  | "registry_surface_workspace_mismatch"
  | "closure_without_artifact"
  | "pr_loop_incomplete"
  | "kept_open_contract_incomplete"
  | "degraded_evidence_channel"
  | "recoverable_blocker_requires_action"
  | "missing_managed_lead_agent_id"
  | "ambiguous_repo_cwd_label"
  | "seat_identity_mismatch"
  | "non_claude_orchestrator"
  | "topology_three_or_more_columns"
  | "orchestrator_not_leftmost"
  | "worker_in_leftmost_column";

export const AGENT_HEALTH_INBOX_MONITOR_BOOT_GRACE_MS = 30_000;

export const DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY: Record<
  AgentHealthIssueCode,
  AgentHealthIssueSeverity
> = {
  agent_wedged: "blocking",
  pane_pty_dead: "blocking",
  closure_without_artifact: "blocking",
  pr_loop_incomplete: "blocking",
  kept_open_contract_incomplete: "blocking",
  degraded_evidence_channel: "blocking",
  recoverable_blocker_requires_action: "blocking",
  registry_surface_workspace_mismatch: "blocking",
  seat_identity_mismatch: "blocking",
  topology_three_or_more_columns: "blocking",
  orchestrator_not_leftmost: "blocking",
  worker_in_leftmost_column: "blocking",
  non_claude_orchestrator: "blocking",
  inbox_channel_dir_deleted: "blocking",
  monitor_collapsed: "blocking",
  stale_inbox_dispatches: "blocking",
  missing_managed_lead_agent_id: "degraded",
  missing_cli_session_id: "info",
  non_resumable: "info",
  inbox_monitor_not_alive: "info",
  auto_discovered_agent: "info",
  ambiguous_repo_cwd_label: "info",
  registry_screen_disagreement: "degraded",
};

export interface AgentTopologyHealthInput {
  column: number | null;
  column_count: number | null;
}

export interface AgentHealthInput {
  monitor_alive?: boolean | null;
  inbox_channel_dir_deleted?: boolean | null;
  stale_count?: number;
  screen_status?: string | null;
  surface_workspace_id?: string | null;
  surface_title?: string | null;
  closure_artifact_verified?: boolean | null;
  harvestability?: WorkerHarvestability | null;
  screen_actions?: string[] | null;
  topology?: AgentTopologyHealthInput | null;
  surface_write_liveness?: SurfaceWriteLivenessObservation | null;
  collapsed_monitors?: CollapsedMonitorHealthInput[];
}

export interface CollapsedMonitorHealthInput {
  monitor_id: string;
  reason: string;
}

export interface AgentHealth {
  status: AgentHealthStatus;
  issue_codes: AgentHealthIssueCode[];
  issues: string[];
  issue_severities?: Partial<
    Record<AgentHealthIssueCode, AgentHealthIssueSeverity>
  >;
  reconciled_state?: AgentState;
  recommended_actions?: string[];
}

export interface AgentHealthDeps {
  now?: () => number;
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

function issueSeverity(
  code: AgentHealthIssueCode,
  context: {
    screenActive: boolean;
    inboxMonitorWithinBootGrace: boolean;
    autoDiscovered: boolean;
    lacksManagedPlacement: boolean;
    panePtyDead: boolean;
  },
): AgentHealthIssueSeverity {
  if (
    context.lacksManagedPlacement &&
    (code === "orchestrator_not_leftmost" ||
      code === "worker_in_leftmost_column")
  ) {
    return "info";
  }
  if (
    code === "registry_screen_disagreement" &&
    context.screenActive &&
    !context.panePtyDead
  ) {
    return "info";
  }
  if (
    code === "inbox_monitor_not_alive" &&
    !context.inboxMonitorWithinBootGrace
  ) {
    return "degraded";
  }
  return DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY[code];
}

function deriveIssueSeverities(
  codes: AgentHealthIssueCode[],
  context: {
    screenActive: boolean;
    inboxMonitorWithinBootGrace: boolean;
    autoDiscovered: boolean;
    lacksManagedPlacement: boolean;
    panePtyDead: boolean;
  },
): Partial<Record<AgentHealthIssueCode, AgentHealthIssueSeverity>> {
  const severities: Partial<
    Record<AgentHealthIssueCode, AgentHealthIssueSeverity>
  > = {};
  for (const code of codes) {
    severities[code] = issueSeverity(code, context);
  }
  return severities;
}

function deriveStatus(
  codes: AgentHealthIssueCode[],
  severities: Partial<Record<AgentHealthIssueCode, AgentHealthIssueSeverity>>,
): AgentHealthStatus {
  if (codes.some((code) => severities[code] === "blocking")) {
    return "unhealthy";
  }
  if (codes.some((code) => severities[code] === "degraded")) {
    return "degraded";
  }
  return "healthy";
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

/** Seats cmuxlayer did not place via managed spawn_agent (won't move panes per #170). */
function lacksManagedPlacement(agent: AgentRecord): boolean {
  return isAutoDiscovered(agent) || agent.task_summary === "(resync-repaired)";
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

function inferRoleOrNull(input: {
  role?: AgentRole;
  launcherName?: string;
  title?: string;
  cli?: string;
}): AgentRole | null {
  try {
    return inferAgentRole(input);
  } catch (error) {
    if (isAgentRoleInferenceError(error)) return null;
    throw error;
  }
}

function inferTopologyRole(
  agent: AgentRecord,
  input: AgentHealthInput,
): AgentRole | null {
  if (agent.role) return agent.role;

  return (
    inferRoleOrNull({ title: input.surface_title ?? undefined }) ??
    inferRoleOrNull({
      launcherName: agent.launcher_name ?? undefined,
      cli: agent.cli,
    }) ??
    inferRecordRoleOrNull(agent)
  );
}

function parseAgentTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isWithinInboxMonitorBootGrace(
  agent: AgentRecord,
  now: number,
): boolean {
  const firstSeenAt =
    parseAgentTimestamp(agent.created_at) ??
    parseAgentTimestamp(agent.updated_at);
  if (firstSeenAt === null) return false;
  return now - firstSeenAt <= AGENT_HEALTH_INBOX_MONITOR_BOOT_GRACE_MS;
}

export function evaluateAgentHealth(
  agent: AgentRecord,
  input: AgentHealthInput = {},
  deps: AgentHealthDeps = {},
): AgentHealth {
  const issueCodes: AgentHealthIssueCode[] = [];
  const issues: string[] = [];
  const recommendedActions: string[] = [];
  const role = inferRecordRoleOrNull(agent);
  const autoDiscovered = isAutoDiscovered(agent);

  const collapsedMonitors = input.collapsed_monitors ?? [];
  if (collapsedMonitors.length > 0) {
    addIssue(
      issueCodes,
      issues,
      "monitor_collapsed",
      collapsedMonitors
        .map(
          (monitor) =>
            `registered monitor ${monitor.monitor_id} collapsed: ${monitor.reason}`,
        )
        .join("; "),
    );
    addRecommendedAction(
      recommendedActions,
      "repair_or_replace_collapsed_monitor",
    );
  }

  if (agent.seat_identity_status === "mismatch") {
    addIssue(
      issueCodes,
      issues,
      "seat_identity_mismatch",
      agent.seat_identity_error ??
        "spawned agent seat identity does not match the registry",
    );
  }

  if (autoDiscovered) {
    addIssue(
      issueCodes,
      issues,
      "auto_discovered_agent",
      "agent was auto-discovered, not created through managed spawn_agent",
    );

    if (looksLeadLike(input.surface_title) || looksLeadLike(agent.repo)) {
      addIssue(
        issueCodes,
        issues,
        "missing_managed_lead_agent_id",
        "lead/coordinator surface has no managed agent_id; recover/register or replace with a managed lead",
      );
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
    addIssue(
      issueCodes,
      issues,
      "non_resumable",
      "agent cannot be resumed because no CLI session id was captured",
    );
  }

  if (
    input.monitor_alive === false &&
    input.inbox_channel_dir_deleted === true
  ) {
    addIssue(
      issueCodes,
      issues,
      "inbox_channel_dir_deleted",
      "agent inbox channel dir was deleted after creation; next inbox write will recreate it",
    );
  } else if (input.monitor_alive === false) {
    addIssue(
      issueCodes,
      issues,
      "inbox_monitor_not_alive",
      "agent inbox monitor heartbeat is absent or stale",
    );
  }

  const staleCount = input.stale_count ?? 0;
  if (staleCount > 0) {
    addIssue(
      issueCodes,
      issues,
      "stale_inbox_dispatches",
      "agent has unacked inbox dispatches past the ACK timeout",
    );
    if (input.monitor_alive === true) {
      addIssue(
        issueCodes,
        issues,
        "agent_wedged",
        "agent monitor is alive but dispatches remain unacked past the ACK timeout; treat as wedged rather than dead",
      );
    }
  }

  const screenActive =
    input.screen_status === "working" || input.screen_status === "thinking";
  const panePtyDead =
    screenActive && input.surface_write_liveness?.pty_dead === true;
  if (panePtyDead) {
    addIssue(
      issueCodes,
      issues,
      "pane_pty_dead",
      `screen parses as ${input.screen_status} but the last ${input.surface_write_liveness?.consecutive_broken_pipe_failures ?? "several"} surface writes failed with a broken pipe`,
    );
  }
  const screenDone = input.screen_status === "done";
  let reconciledState: AgentState | undefined;
  const registryActive =
    agent.state === "creating" ||
    agent.state === "booting" ||
    agent.state === "working";
  const registryInactive =
    agent.state === "ready" ||
    agent.state === "idle" ||
    agent.state === "done" ||
    agent.state === "error";
  if ((screenActive && registryInactive) || (screenDone && registryActive)) {
    if (screenActive && registryInactive) {
      reconciledState = "working";
    }
    addIssue(
      issueCodes,
      issues,
      "registry_screen_disagreement",
      `registry state is ${agent.state} while screen parses as ${input.screen_status}`,
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
  }

  if (input.closure_artifact_verified === false) {
    addIssue(
      issueCodes,
      issues,
      "closure_without_artifact",
      "worker closure is not backed by a verified DONE marker, BLOCKED/NOT_GREEN handoff, or successor transfer",
    );
  }
  if (
    input.harvestability?.pr_loop_required === true &&
    input.harvestability.pr_loop_satisfied === false
  ) {
    addIssue(
      issueCodes,
      issues,
      "pr_loop_incomplete",
      "PR-loop worker did not record merged/reviewed status or an explicit handoff",
    );
  }
  if (
    input.harvestability?.kept_open?.present === true &&
    input.harvestability.kept_open.complete === false
  ) {
    addIssue(
      issueCodes,
      issues,
      "kept_open_contract_incomplete",
      "KEPT_OPEN requires reason, owner, and next check",
    );
  }
  if (
    agent.state === "done" &&
    role !== "orchestrator" &&
    role !== "ic" &&
    input.harvestability?.evidence_channel.degraded === true
  ) {
    addIssue(
      issueCodes,
      issues,
      "degraded_evidence_channel",
      input.harvestability.evidence_channel.reason ??
        "done evidence channel is degraded",
    );
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

  if (agent.cli !== "claude" && role === "orchestrator") {
    addIssue(
      issueCodes,
      issues,
      "non_claude_orchestrator",
      "non-Claude agent was assigned orchestrator topology role; use worker unless this is the single explicit left-side coordinator",
    );
  }

  const topology = input.topology;
  const topologyRole = inferTopologyRole(agent, input) ?? role;
  if (topology && topology.column_count !== null) {
    if (topology.column_count >= 3) {
      addIssue(
        issueCodes,
        issues,
        "topology_three_or_more_columns",
        `workspace has ${topology.column_count} columns; expected at most two lead/worker columns`,
      );
    }
    if (
      topologyRole === "orchestrator" &&
      topology.column !== null &&
      topology.column > 0
    ) {
      addIssue(
        issueCodes,
        issues,
        "orchestrator_not_leftmost",
        `orchestrator is in column ${topology.column}; expected leftmost column 0`,
      );
    }
    if (
      topologyRole === "worker" &&
      topology.column === 0 &&
      topology.column_count >= 2
    ) {
      addIssue(
        issueCodes,
        issues,
        "worker_in_leftmost_column",
        "worker is in the leftmost lead column; expected worker column on the right",
      );
    }
  }

  const issueSeverities = deriveIssueSeverities(issueCodes, {
    screenActive,
    autoDiscovered,
    lacksManagedPlacement: lacksManagedPlacement(agent),
    panePtyDead,
    inboxMonitorWithinBootGrace: isWithinInboxMonitorBootGrace(
      agent,
      deps.now?.() ?? Date.now(),
    ),
  });
  const status = deriveStatus(issueCodes, issueSeverities);

  return {
    status,
    issue_codes: issueCodes,
    issues,
    ...(issueCodes.length > 0 ? { issue_severities: issueSeverities } : {}),
    ...(reconciledState ? { reconciled_state: reconciledState } : {}),
    ...(recommendedActions.length > 0
      ? { recommended_actions: recommendedActions }
      : {}),
  };
}
