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
): AgentSpawnPlacement {
  if (panes.length <= 1) {
    return { kind: "split", direction: "right" };
  }

  const groupsByPane = new Map(
    paneSurfaces.map((group) => [group.pane_ref, group]),
  );
  const terminalPanes = panes.filter((pane) =>
    groupsByPane
      .get(pane.ref)
      ?.surfaces.some((surface) => surface.type === "terminal"),
  );

  if (terminalPanes.length === 0) {
    return { kind: "split", direction: "right" };
  }

  const rightmostPane = [...terminalPanes].sort((a, b) => a.index - b.index).at(-1);
  if (!rightmostPane) {
    return { kind: "split", direction: "right" };
  }

  return { kind: "surface", pane: rightmostPane.ref };
}
