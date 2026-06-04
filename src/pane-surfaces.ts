import type { CmuxPane, CmuxPaneSurfaces, CmuxSurface } from "./types.js";

interface SurfaceEntry {
  surface: CmuxSurface;
  groupPaneRefs: Set<string>;
}

function surfaceKey(
  surface: CmuxSurface,
  group: CmuxPaneSurfaces,
  anonymousIndex: number,
): string {
  return (
    surface.id ??
    surface.ref ??
    `${group.workspace_ref}:${group.pane_ref}:anonymous:${anonymousIndex}`
  );
}

function surfaceBelongsToPane(
  surface: CmuxSurface,
  pane: CmuxPane,
  groupPaneRefs: ReadonlySet<string>,
): boolean {
  if (surface.pane_id && pane.id) {
    return surface.pane_id === pane.id;
  }
  if (surface.id && pane.surface_ids?.includes(surface.id)) {
    return true;
  }
  if (surface.ref && pane.surface_refs?.includes(surface.ref)) {
    return true;
  }
  if (surface.pane_ref) {
    return surface.pane_ref === pane.ref;
  }
  return groupPaneRefs.size === 1 && groupPaneRefs.has(pane.ref);
}

export function partitionPaneSurfacesByMembership(
  panes: CmuxPane[],
  rawGroups: CmuxPaneSurfaces[],
  fallback?: {
    workspace_ref?: string;
    window_ref?: string;
  },
): CmuxPaneSurfaces[] {
  const entries = new Map<string, SurfaceEntry>();
  let anonymousIndex = 0;

  for (const group of rawGroups) {
    for (const surface of group.surfaces ?? []) {
      const key = surfaceKey(surface, group, anonymousIndex++);
      const entry = entries.get(key);
      if (entry) {
        if (group.pane_ref) {
          entry.groupPaneRefs.add(group.pane_ref);
        }
        continue;
      }

      entries.set(key, {
        surface,
        groupPaneRefs: new Set(group.pane_ref ? [group.pane_ref] : []),
      });
    }
  }

  const firstGroup = rawGroups[0];
  return panes.map((pane) => ({
    workspace_ref:
      firstGroup?.workspace_ref ?? fallback?.workspace_ref ?? "",
    window_ref: firstGroup?.window_ref ?? fallback?.window_ref ?? "",
    pane_ref: pane.ref,
    surfaces: [...entries.values()]
      .filter((entry) =>
        surfaceBelongsToPane(entry.surface, pane, entry.groupPaneRefs),
      )
      .map((entry) => entry.surface),
  }));
}
