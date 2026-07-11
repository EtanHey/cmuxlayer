import type { AgentRecord } from "./agent-types.js";
import type {
  AgentHealthInput,
  AgentTopologyHealthInput,
  CollapsedMonitorHealthInput,
} from "./agent-health.js";
import type { WorkerHarvestability } from "./agent-engine.js";
import type { SurfaceWriteLivenessObservation } from "./surface-write-liveness.js";
import {
  channelDirDeletedAfterCreate,
  monitorAlive,
  pendingDispatches,
  type InboxOpts,
} from "./inbox.js";

export const AGENT_HEALTH_MONITOR_MAX_AGE_MS = 60_000;
export const AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS = 120_000;

export interface ParsedSurfaceHealthInput {
  status?: string | null;
  actions?: string[] | null;
}

export interface AgentHealthInputOverrides {
  monitor_alive?: boolean | null;
  stale_count?: number;
  screen_status?: string | null;
  screen_actions?: string[] | null;
  surface_workspace_id?: string | null;
  surface_title?: string | null;
  topology?: AgentTopologyHealthInput | null;
  closure_artifact_verified?: boolean | null;
  harvestability?: WorkerHarvestability | null;
  inbox_channel_dir_deleted?: boolean | null;
  surface_write_liveness?: SurfaceWriteLivenessObservation | null;
  collapsed_monitors?: CollapsedMonitorHealthInput[];
}

export interface AgentHealthInputDeps {
  inboxOpts?: InboxOpts;
  monitorMaxAgeMs?: number;
  dispatchAckTimeoutMs?: number;
  assessHarvestability?: (
    agent: AgentRecord,
  ) => WorkerHarvestability | null | undefined;
  resolveTopology?: (
    agent: AgentRecord,
  ) => Promise<AgentTopologyHealthInput | null>;
  readParsedSurface?: (
    agent: AgentRecord,
  ) => Promise<ParsedSurfaceHealthInput | null>;
  resolveSurfaceWorkspace?: (agent: AgentRecord) => Promise<string | null>;
  observeSurfaceWriteLiveness?: (
    agent: AgentRecord,
  ) => SurfaceWriteLivenessObservation | null;
  resolveCollapsedMonitors?: (
    ownerSeats: string[],
  ) => Promise<CollapsedMonitorHealthInput[]> | CollapsedMonitorHealthInput[];
}

export async function buildAgentHealthInput(
  agent: AgentRecord,
  deps: AgentHealthInputDeps = {},
  overrides: AgentHealthInputOverrides = {},
): Promise<AgentHealthInput> {
  const harvestability =
    overrides.harvestability !== undefined
      ? overrides.harvestability
      : deps.assessHarvestability?.(agent) ?? null;
  const closureArtifactVerified =
    overrides.closure_artifact_verified !== undefined
      ? overrides.closure_artifact_verified
      : harvestability?.closure_artifact_verified ?? null;
  const topology =
    overrides.topology !== undefined
      ? overrides.topology
      : (await deps.resolveTopology?.(agent)) ?? null;
  const alive =
    overrides.monitor_alive !== undefined
      ? overrides.monitor_alive
      : monitorAlive(
          agent.agent_id,
          deps.monitorMaxAgeMs ?? AGENT_HEALTH_MONITOR_MAX_AGE_MS,
          deps.inboxOpts,
        );
  const inboxChannelDirDeleted =
    overrides.inbox_channel_dir_deleted !== undefined
      ? overrides.inbox_channel_dir_deleted
      : !alive && channelDirDeletedAfterCreate(agent.agent_id, deps.inboxOpts);
  const staleCount =
    overrides.stale_count ??
    pendingDispatches(
      agent.agent_id,
      deps.dispatchAckTimeoutMs ?? AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
      deps.inboxOpts,
    ).length;
  const needsScreen =
    overrides.screen_status === undefined ||
    overrides.screen_actions === undefined;
  let parsedScreen: ParsedSurfaceHealthInput | null | undefined = null;
  if (needsScreen) {
    try {
      parsedScreen = await deps.readParsedSurface?.(agent);
    } catch {
      parsedScreen = null;
    }
  }
  const screenStatus =
    overrides.screen_status !== undefined
      ? overrides.screen_status
      : parsedScreen?.status;
  const screenActions =
    overrides.screen_actions !== undefined
      ? overrides.screen_actions
      : parsedScreen?.actions;
  const surfaceWorkspaceId =
    overrides.surface_workspace_id !== undefined
      ? overrides.surface_workspace_id
      : await deps.resolveSurfaceWorkspace?.(agent);
  const surfaceWriteLiveness =
    overrides.surface_write_liveness !== undefined
      ? overrides.surface_write_liveness
      : deps.observeSurfaceWriteLiveness?.(agent);
  const ownerSeats = [agent.agent_id, agent.seat_id]
    .filter((ownerSeat): ownerSeat is string => Boolean(ownerSeat?.trim()))
    .filter((ownerSeat, index, all) => all.indexOf(ownerSeat) === index);
  const collapsedMonitors =
    overrides.collapsed_monitors !== undefined
      ? overrides.collapsed_monitors
      : (await deps.resolveCollapsedMonitors?.(ownerSeats)) ?? [];

  return {
    monitor_alive: alive,
    inbox_channel_dir_deleted: inboxChannelDirDeleted,
    stale_count: staleCount,
    screen_status: screenStatus,
    screen_actions: screenActions,
    surface_workspace_id: surfaceWorkspaceId,
    surface_title: overrides.surface_title,
    topology,
    closure_artifact_verified: closureArtifactVerified,
    harvestability,
    surface_write_liveness: surfaceWriteLiveness,
    collapsed_monitors: collapsedMonitors,
  };
}
