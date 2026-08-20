import type {
  AgentRecord,
  AgentRoute,
  AgentState,
  ObservationSource,
  Observed,
  ObservedPublicAgent,
  PublicAgent,
} from "./agent-types.js";
import { pauseHonestyFields, type PauseSource } from "./types.js";
import {
  buildResumeCommand,
  rawResumeNeedsCwd,
  rawResumeSupported,
} from "./agent-command.js";
import {
  resumeArtifactStatus,
  type ResumeArtifactStatus,
} from "./resume-verification.js";

export type AgentStatePayload = AgentRecord & {
  resumable: boolean;
  resume_command?: string;
};

/**
 * Directory a resumed harness must be started in. Only the raw-CLI resume form
 * consumes it — launchers cd themselves.
 */
export function resumeCwdForAgent(
  record: Pick<AgentRecord, "launch_cwd" | "worktree_path">,
): string | null {
  return (
    record.worktree_path?.trim() || record.launch_cwd?.trim() || null
  );
}

/**
 * The command that actually resumes this agent, or `undefined` when no honest
 * one exists. THE single authority: `resolveAgentRoute`, the public
 * projections, and the engine's own resume paths all go through it, so what
 * `list_agents` advertises and what `resume_agent` sends can never disagree.
 */
/**
 * Like `resumeCommandForAgent`, but explains itself. Callers that must fail
 * loudly (the engine's resume + crash-recovery paths) use this so the real
 * reason — an invalid session id, a missing cwd, a harness with no UUID resume
 * form — reaches the operator instead of being flattened to `undefined`.
 */
export function resumeInvocationForAgent(
  record: Pick<
    AgentRecord,
    | "cli"
    | "repo"
    | "cli_session_id"
    | "launcher_name"
    | "launch_cwd"
    | "worktree_path"
  >,
): { command: string; reason: null } | { command: null; reason: string } {
  if (!record.cli_session_id) {
    return { command: null, reason: "no CLI session has been captured" };
  }
  // #482: a formattable id is not a resumable agent. A seat that survived a
  // restart keeps the OLD id, so the command would open a fresh session
  // wearing the seat's name. Refuse on proof of absence only -- an
  // unverifiable store leaves the claim standing.
  if (resumeArtifactStatus(record.cli, record.cli_session_id) === "missing") {
    return {
      command: null,
      reason:
        `captured ${record.cli} session ${record.cli_session_id} is not in ` +
        `the harness session store; resuming it would start a NEW session ` +
        `under this agent's name, not restore it`,
    };
  }
  const cwd = resumeCwdForAgent(record);
  if (!record.launcher_name) {
    if (!cwd && rawResumeNeedsCwd(record.cli)) {
      return {
        command: null,
        reason:
          `a raw ${record.cli} resume needs a recorded working directory ` +
          `(${record.cli} keys its session store by cwd) and neither ` +
          `launch_cwd nor worktree_path is set`,
      };
    }
    if (!rawResumeSupported(record.cli)) {
      return {
        command: null,
        reason: `${record.cli} has no raw resume form that takes a session UUID`,
      };
    }
  }
  try {
    return {
      command: buildResumeCommand(
        record.cli,
        record.repo,
        record.cli_session_id,
        record.launcher_name,
        { cwd },
      ),
      reason: null,
    };
  } catch (error) {
    return {
      command: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resumeCommandForAgent(
  record: Pick<
    AgentRecord,
    | "cli"
    | "repo"
    | "cli_session_id"
    | "launcher_name"
    | "launch_cwd"
    | "worktree_path"
  >,
): string | undefined {
  return resumeInvocationForAgent(record).command ?? undefined;
}

function observed<T>(
  value: T,
  source: ObservationSource,
  observedAtMs: number,
): Observed<T> {
  return { value, source, observed_at_ms: observedAtMs };
}

export function toPublicAgent(record: AgentRecord): PublicAgent {
  const resumeCommand = resumeCommandForAgent(record);
  return {
    agent_id: record.agent_id,
    repo: record.repo,
    model: record.model,
    state: record.state,
    session_id: record.cli_session_id,
    resumable: !!resumeCommand,
    submit_verified: record.submit_verified ?? null,
    model_mismatch: record.model_mismatch ?? null,
    ...(resumeCommand ? { resume_command: resumeCommand } : {}),
  };
}

export function toObservedPublicAgent(
  record: AgentRecord,
  opts: {
    derivedAtMs?: number;
    state?: AgentState;
    stateSource?: ObservationSource;
    screenObservedAtMs?: number;
    screenModel?: string | null;
    paused?: boolean;
    pausedSource?: PauseSource;
  } = {},
): ObservedPublicAgent {
  const derivedAtMs = opts.derivedAtMs ?? Date.now();
  const registryObservedAtMs = derivedAtMs;
  const resumeCommand = resumeCommandForAgent(record);
  const resumable = !!resumeCommand;
  // #482 provenance: `disk` means a session artifact was looked for and
  // found (or proven absent). `registry` means the claim is unverified.
  const artifactStatus: ResumeArtifactStatus = record.cli_session_id
    ? resumeArtifactStatus(record.cli, record.cli_session_id)
    : "unverifiable";
  const resumableSource: ObservationSource =
    artifactStatus === "unverifiable" ? "registry" : "disk";
  const hasScreenModelObservation =
    opts.screenObservedAtMs !== undefined && opts.screenModel != null;
  const model = hasScreenModelObservation
    ? (opts.screenModel ?? null)
    : (record.model ?? null);
  const pausedSource = (opts.pausedSource ??
    record.paused_source ??
    "inferred") as PauseSource;
  return {
    agent_id: record.agent_id,
    repo: record.repo,
    surface_provenance: record.surface_provenance ?? "unknown",
    model: observed(
      model,
      hasScreenModelObservation ? "screen" : "registry",
      hasScreenModelObservation
        ? opts.screenObservedAtMs!
        : registryObservedAtMs,
    ),
    state: observed(
      opts.state ?? record.state,
      opts.stateSource ?? "registry",
      opts.stateSource === "screen"
        ? (opts.screenObservedAtMs ?? derivedAtMs)
        : registryObservedAtMs,
    ),
    session_id: observed(
      record.cli_session_id,
      "registry",
      registryObservedAtMs,
    ),
    resumable: observed(resumable, resumableSource, registryObservedAtMs),
    submit_verified: observed(
      record.submit_verified ?? null,
      "registry",
      registryObservedAtMs,
    ),
    model_mismatch: observed(
      record.model_mismatch ?? null,
      "registry",
      registryObservedAtMs,
    ),
    blocked_on_prompt: observed(
      record.blocked_on_prompt ?? false,
      "registry",
      registryObservedAtMs,
    ),
    paused: {
      value: opts.paused ?? record.paused === true,
      source: pausedSource,
      observed_at_ms:
        opts.paused !== undefined
          ? (opts.screenObservedAtMs ?? derivedAtMs)
          : registryObservedAtMs,
      ...pauseHonestyFields(pausedSource),
    },
    ...(resumeCommand ? { resume_command: resumeCommand } : {}),
  };
}

export function toAgentStatePayload(record: AgentRecord): AgentStatePayload {
  const resumeCommand = resumeCommandForAgent(record);
  return {
    ...record,
    resumable: !!resumeCommand,
    ...(resumeCommand ? { resume_command: resumeCommand } : {}),
  };
}

export function buildRouteTable(
  records: AgentRecord[],
): Map<string, AgentRoute> {
  const routes = new Map<string, AgentRoute>();

  for (const record of records) {
    const resumeCommand = resumeCommandForAgent(record);
    const nextRoute: AgentRoute = {
      agent_id: record.agent_id,
      surface_id: record.surface_id,
      surface_uuid: record.surface_uuid ?? null,
      workspace_id: record.workspace_id ?? null,
      state: record.state,
      session_id: record.cli_session_id,
      resumable: !!resumeCommand,
      ...(resumeCommand ? { resume_command: resumeCommand } : {}),
    };
    const existing = routes.get(record.agent_id);

    if (existing && existing.surface_id !== nextRoute.surface_id) {
      throw new Error(
        `Conflicting routes for agent "${record.agent_id}": ` +
          `${existing.surface_id} vs ${nextRoute.surface_id}`,
      );
    }

    routes.set(record.agent_id, nextRoute);
  }

  return routes;
}

export function resolveAgentRoute(
  records: AgentRecord[],
  agentId: string,
): AgentRoute {
  const route = buildRouteTable(records).get(agentId);
  if (!route) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return route;
}
