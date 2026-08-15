import type {
  AgentRecord,
  AgentRoute,
  AgentState,
  ObservationSource,
  Observed,
  ObservedPublicAgent,
  PublicAgent,
} from "./agent-types.js";
import { buildResumeCommand } from "./agent-command.js";

export type AgentStatePayload = AgentRecord & {
  resumable: boolean;
  resume_command?: string;
};

export function resumeCommandForAgent(
  record: Pick<AgentRecord, "cli" | "repo" | "cli_session_id" | "launcher_name">,
): string | undefined {
  if (!record.cli_session_id) return undefined;
  try {
    return buildResumeCommand(
      record.cli,
      record.repo,
      record.cli_session_id,
      record.launcher_name,
    );
  } catch {
    return undefined;
  }
}

function observed<T>(
  value: T,
  source: ObservationSource,
  observedAtMs: number,
): Observed<T> {
  return { value, source, observed_at_ms: observedAtMs };
}

export function toPublicAgent(
  record: AgentRecord,
): PublicAgent {
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
  } = {},
): ObservedPublicAgent {
  const derivedAtMs = opts.derivedAtMs ?? Date.now();
  const registryObservedAtMs = derivedAtMs;
  const resumeCommand = resumeCommandForAgent(record);
  const resumable = !!resumeCommand;
  const hasScreenModelObservation =
    opts.screenObservedAtMs !== undefined && opts.screenModel != null;
  const model = hasScreenModelObservation
    ? (opts.screenModel ?? null)
    : (record.model ?? null);
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
    resumable: observed(resumable, "registry", registryObservedAtMs),
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
