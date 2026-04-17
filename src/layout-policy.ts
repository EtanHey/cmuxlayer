import type { CmuxPane, CmuxPaneSurfaces } from "./types.js";

export type AgentSpawnPlacement =
  | { kind: "split"; direction: "right" }
  | { kind: "surface"; pane: string };

export interface SurfaceClosePolicy {
  surface: string;
  pane: string | null;
  collapsePane: boolean;
}

interface PaneLayout {
  pane: CmuxPane;
  surfaces: CmuxPaneSurfaces["surfaces"];
  workerCount: number;
  nonWorkerCount: number;
}

function describePaneLayouts(
  panes: CmuxPane[],
  paneSurfaces: CmuxPaneSurfaces[],
  workerSurfaceIds: ReadonlySet<string>,
): PaneLayout[] {
  const groupsByPane = new Map(
    paneSurfaces.map((group) => [group.pane_ref, group.surfaces]),
  );

  return panes.map((pane) => {
    const surfaces = groupsByPane.get(pane.ref) ?? [];
    const workerCount = surfaces.filter((surface) =>
      workerSurfaceIds.has(surface.ref),
    ).length;
    return {
      pane,
      surfaces,
      workerCount,
      nonWorkerCount: surfaces.length - workerCount,
    };
  });
}

function isDedicatedWorkerPane(layout: PaneLayout): boolean {
  return layout.workerCount > 0 && layout.nonWorkerCount === 0;
}

/**
 * Deterministic worker placement:
 * - first worker creates the right split
 * - subsequent workers become tabs in the rightmost dedicated worker pane
 * - mixed interactive/worker panes are treated as invalid and repaired with
 *   a fresh right split to preserve the left-interactive/right-worker invariant
 */
export function chooseAgentSpawnPlacement(
  panes: CmuxPane[],
  paneSurfaces: CmuxPaneSurfaces[],
  workerSurfaceIds: ReadonlySet<string>,
): AgentSpawnPlacement {
  if (workerSurfaceIds.size === 0) {
    return { kind: "split", direction: "right" };
  }

  const workerPanes = describePaneLayouts(
    panes,
    paneSurfaces,
    workerSurfaceIds,
  ).filter(isDedicatedWorkerPane);

  if (workerPanes.length === 0) {
    return { kind: "split", direction: "right" };
  }

  const rightmostPane = [...workerPanes]
    .sort((a, b) => a.pane.index - b.pane.index)
    .at(-1);
  if (!rightmostPane) {
    return { kind: "split", direction: "right" };
  }

  return { kind: "surface", pane: rightmostPane.pane.ref };
}

/**
 * Closing the last tab in a dedicated worker pane should collapse the pane.
 * Mixed panes are not considered valid worker panes and therefore do not claim
 * collapse semantics.
 */
export function chooseSurfaceClosePolicy(
  panes: CmuxPane[],
  paneSurfaces: CmuxPaneSurfaces[],
  workerSurfaceIds: ReadonlySet<string>,
  surfaceId: string,
): SurfaceClosePolicy {
  const layout = describePaneLayouts(
    panes,
    paneSurfaces,
    workerSurfaceIds,
  ).find((candidate) =>
    candidate.surfaces.some((surface) => surface.ref === surfaceId),
  );

  if (!layout) {
    return {
      surface: surfaceId,
      pane: null,
      collapsePane: false,
    };
  }

  const remainingSurfaces = layout.surfaces.filter(
    (surface) => surface.ref !== surfaceId,
  );
  const collapsePane =
    workerSurfaceIds.has(surfaceId) &&
    isDedicatedWorkerPane(layout) &&
    remainingSurfaces.length === 0;

  return {
    surface: surfaceId,
    pane: layout.pane.ref,
    collapsePane,
  };
}
