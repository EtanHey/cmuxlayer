import type { AgentRecord, AgentRoute, PublicAgent } from "./agent-types.js";

export function toPublicAgent(record: AgentRecord): PublicAgent {
  return {
    agent_id: record.agent_id,
    repo: record.repo,
    model: record.model,
    state: record.state,
    session_id: record.cli_session_id,
  };
}

export function buildRouteTable(
  records: AgentRecord[],
): Map<string, AgentRoute> {
  const routes = new Map<string, AgentRoute>();

  for (const record of records) {
    const nextRoute: AgentRoute = {
      agent_id: record.agent_id,
      surface_id: record.surface_id,
      state: record.state,
      session_id: record.cli_session_id,
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
