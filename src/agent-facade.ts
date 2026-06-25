import type { AgentRecord, AgentRoute, PublicAgent } from "./agent-types.js";
import { buildResumeCommand } from "./agent-command.js";

export type AgentStatePayload = AgentRecord & {
  resumable: boolean;
  resume_command?: string;
};

export function resumeCommandForAgent(
  record: Pick<AgentRecord, "cli" | "repo" | "cli_session_id" | "launcher_name">,
): string | undefined {
  return record.cli_session_id
    ? buildResumeCommand(
        record.cli,
        record.repo,
        record.cli_session_id,
        record.launcher_name,
      )
    : undefined;
}

export function toPublicAgent(record: AgentRecord): PublicAgent {
  const resumeCommand = resumeCommandForAgent(record);
  const resumable = !!record.cli_session_id;
  return {
    agent_id: record.agent_id,
    repo: record.repo,
    model: record.model,
    state: record.state,
    session_id: record.cli_session_id,
    resumable,
    ...(resumeCommand ? { resume_command: resumeCommand } : {}),
  };
}

export function toAgentStatePayload(record: AgentRecord): AgentStatePayload {
  const resumeCommand = resumeCommandForAgent(record);
  return {
    ...record,
    resumable: !!record.cli_session_id,
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
      workspace_id: record.workspace_id ?? null,
      state: record.state,
      session_id: record.cli_session_id,
      resumable: !!record.cli_session_id,
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
