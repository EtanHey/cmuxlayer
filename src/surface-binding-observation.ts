import type { AgentRecord } from "./agent-types.js";
import { validateSurfaceIdentityBijection } from "./surface-topology.js";
import type { CmuxPane, CmuxPaneSurfaces } from "./types.js";

export type SurfaceIdentityCoverage =
  | "empty"
  | "ref"
  | "uuid"
  | "mixed"
  | "conflict";

/**
 * Stable-identity view derived from one already-collected pane observation.
 * Placement must not re-enumerate between classifying roles and choosing the
 * pane it will mutate.
 */
export interface SurfaceBindingObservation {
  coverage: SurfaceIdentityCoverage;
  liveSurfaceRefs: ReadonlySet<string>;
  surfaceUuidByRef: ReadonlyMap<string, string>;
  surfaceRefByUuid: ReadonlyMap<string, string>;
}

function uuidKey(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

/**
 * A successful command is not necessarily a complete topology snapshot: pane
 * membership can race tab creation/closure and return a strict subset. Require
 * exact, duplicate-free agreement before the snapshot can authorize placement
 * or lifecycle absence mutations.
 */
export function isPaneSurfaceEnumerationComplete(
  panes: readonly CmuxPane[],
  paneSurfaces: readonly CmuxPaneSurfaces[],
): boolean {
  for (const pane of panes) {
    const expectedRefs = new Set(pane.surface_refs);
    const observed = paneSurfaces.find(
      (group) => group.pane_ref === pane.ref,
    );
    const observedRefs = observed?.surfaces.map((surface) => surface.ref) ?? [];
    const observedRefSet = new Set(observedRefs);
    if (
      pane.surface_count !== pane.surface_refs.length ||
      expectedRefs.size !== pane.surface_refs.length ||
      observedRefSet.size !== observedRefs.length ||
      observedRefSet.size !== expectedRefs.size ||
      [...expectedRefs].some((surfaceRef) => !observedRefSet.has(surfaceRef))
    ) {
      return false;
    }
  }
  return true;
}

export function buildSurfaceBindingObservation(
  panes: readonly CmuxPane[],
  paneSurfaces: readonly CmuxPaneSurfaces[],
): SurfaceBindingObservation {
  const paneByRef = new Map(panes.map((pane) => [pane.ref, pane] as const));
  const liveSurfaceRefs = new Set<string>();
  const identityPairs: Array<{
    surfaceRef: string;
    surfaceId?: string | null;
  }> = [];

  for (const pane of panes) {
    for (const [index, surfaceRef] of pane.surface_refs.entries()) {
      identityPairs.push({
        surfaceRef,
        surfaceId: pane.surface_ids?.[index],
      });
    }
  }

  for (const group of paneSurfaces) {
    const pane = group.pane_ref ? paneByRef.get(group.pane_ref) : undefined;
    for (const surface of group.surfaces ?? []) {
      const surfaceRef = surface.ref?.trim();
      if (!surfaceRef) continue;
      liveSurfaceRefs.add(surfaceRef);
      const surfaceIndex = pane?.surface_refs?.indexOf(surfaceRef) ?? -1;
      identityPairs.push({ surfaceRef, surfaceId: surface.id });
      if (surfaceIndex >= 0) {
        identityPairs.push({
          surfaceRef,
          surfaceId: pane?.surface_ids?.[surfaceIndex],
        });
      }
    }
  }

  const identity = validateSurfaceIdentityBijection(identityPairs);
  const surfaceUuidByRef = identity.isBijective
    ? new Map(
        [...identity.surfaceIdByRef].filter(([surfaceRef]) =>
          liveSurfaceRefs.has(surfaceRef),
        ),
      )
    : new Map<string, string>();
  const surfaceRefByUuid = identity.isBijective
    ? new Map(
        [...surfaceUuidByRef].flatMap(([surfaceRef, surfaceUuid]) => {
          const key = uuidKey(surfaceUuid);
          return key ? [[key, surfaceRef] as const] : [];
        }),
      )
    : new Map<string, string>();

  const coverage: SurfaceIdentityCoverage = !identity.isBijective
    ? "conflict"
    : liveSurfaceRefs.size === 0
      ? "empty"
      : surfaceUuidByRef.size === 0
        ? "ref"
        : surfaceUuidByRef.size === liveSurfaceRefs.size
          ? "uuid"
          : "mixed";
  return {
    coverage,
    liveSurfaceRefs,
    surfaceUuidByRef,
    surfaceRefByUuid,
  };
}

/** Resolve one persisted row only when this single observation proves it. */
export function resolveObservedAgentSurfaceRef(
  agent: Pick<AgentRecord, "surface_id" | "surface_uuid">,
  observation: SurfaceBindingObservation,
): string | null {
  const stableUuid = uuidKey(agent.surface_uuid);
  if (stableUuid) {
    return observation.coverage === "uuid"
      ? (observation.surfaceRefByUuid.get(stableUuid) ?? null)
      : null;
  }
  return observation.coverage === "ref" &&
    observation.liveSurfaceRefs.has(agent.surface_id)
    ? agent.surface_id
    : null;
}
