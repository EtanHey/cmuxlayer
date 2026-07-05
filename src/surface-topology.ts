import type { AgentRecord } from "./agent-types.js";
import type { AgentTopologyHealthInput } from "./agent-health.js";
import type { AgentHealthInputOverrides } from "./agent-health-input.js";
import { deriveColumnIndex } from "./layout-policy.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
import type { CmuxPane, CmuxPaneSurfaces, CmuxWorkspace } from "./types.js";

export type SurfaceTopology = AgentTopologyHealthInput;

export interface SurfaceTopologySnapshot {
  workspaceBySurface: Map<string, string>;
  titleBySurface: Map<string, string>;
  topologyBySurface: Map<string, SurfaceTopology>;
}

export interface SurfaceTopologyClient {
  listWorkspaces(): Promise<{ workspaces: CmuxWorkspace[] }>;
  listPanes(opts?: { workspace?: string }): Promise<{
    workspace_ref?: string;
    window_ref?: string;
    panes: CmuxPane[];
  }>;
  listPaneSurfaces(opts?: {
    workspace?: string;
    pane?: string;
  }): Promise<CmuxPaneSurfaces>;
}

export const EMPTY_SURFACE_TOPOLOGY: SurfaceTopology = {
  column: null,
  column_count: null,
};

export async function collectSurfaceTopology(
  client: SurfaceTopologyClient,
  workspace?: string,
): Promise<SurfaceTopologySnapshot | null> {
  let workspaceRefs: string[];
  try {
    workspaceRefs = workspace
      ? [workspace]
      : (await client.listWorkspaces()).workspaces.map((ws) => ws.ref);
  } catch {
    return null;
  }

  const snapshot: SurfaceTopologySnapshot = {
    workspaceBySurface: new Map(),
    titleBySurface: new Map(),
    topologyBySurface: new Map(),
  };

  for (const workspaceRef of workspaceRefs) {
    try {
      const panes = await client.listPanes({ workspace: workspaceRef });
      if (!panes.panes || panes.panes.length === 0) continue;

      const columnIndex = deriveColumnIndex(panes.panes);
      const columnCount = new Set(columnIndex.values()).size;
      const rawGroups: CmuxPaneSurfaces[] = [];
      for (const pane of panes.panes) {
        try {
          const group = await client.listPaneSurfaces({
            workspace: workspaceRef,
            pane: pane.ref,
          });
          rawGroups.push({
            ...group,
            workspace_ref: group.workspace_ref ?? workspaceRef,
            pane_ref: group.pane_ref ?? pane.ref,
          });
        } catch {
          // Panes can close between listPanes and listPaneSurfaces. Keep the
          // rest of the snapshot usable instead of dropping every agent's health input.
        }
      }
      const partitioned = partitionPaneSurfacesByMembership(panes.panes, rawGroups, {
        workspace_ref: panes.workspace_ref ?? workspaceRef,
        window_ref: panes.window_ref,
      });
      for (const group of partitioned) {
        for (const surface of group.surfaces) {
          snapshot.workspaceBySurface.set(
            surface.ref,
            group.workspace_ref ?? workspaceRef,
          );
          snapshot.titleBySurface.set(surface.ref, surface.title);
          snapshot.topologyBySurface.set(surface.ref, {
            column: columnIndex.get(group.pane_ref) ?? null,
            column_count: columnCount,
          });
        }
      }
    } catch {
      // A single bad workspace should not erase topology already collected for others.
    }
  }

  return snapshot;
}

export function healthTopologyOverrides(
  agent: AgentRecord,
  snapshot: SurfaceTopologySnapshot | null,
): AgentHealthInputOverrides {
  return snapshot
    ? {
        topology:
          snapshot.topologyBySurface.get(agent.surface_id) ??
          EMPTY_SURFACE_TOPOLOGY,
        surface_workspace_id:
          snapshot.workspaceBySurface.get(agent.surface_id) ?? null,
        surface_title: snapshot.titleBySurface.get(agent.surface_id) ?? null,
      }
    : {};
}
