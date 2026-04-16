import type { CmuxPane, CmuxPaneSurfaces } from "./types.js";

export type AgentSpawnPlacement =
  | { kind: "split"; direction: "right" }
  | { kind: "surface"; pane: string };

/**
 * Deterministic worker placement:
 * - first worker creates the right split
 * - subsequent workers become tabs in the rightmost terminal pane
 */
export function chooseAgentSpawnPlacement(
  panes: CmuxPane[],
  paneSurfaces: CmuxPaneSurfaces[],
  workerSurfaceIds: ReadonlySet<string>,
): AgentSpawnPlacement {
  if (workerSurfaceIds.size === 0) {
    return { kind: "split", direction: "right" };
  }

  const groupsByPane = new Map(
    paneSurfaces.map((group) => [group.pane_ref, group]),
  );
  const workerPanes = panes.filter((pane) =>
    groupsByPane
      .get(pane.ref)
      ?.surfaces.some((surface) => workerSurfaceIds.has(surface.ref)),
  );

  if (workerPanes.length === 0) {
    return { kind: "split", direction: "right" };
  }

  const rightmostPane = [...workerPanes].sort((a, b) => a.index - b.index).at(-1);
  if (!rightmostPane) {
    return { kind: "split", direction: "right" };
  }

  return { kind: "surface", pane: rightmostPane.ref };
}
