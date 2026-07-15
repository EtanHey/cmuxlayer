import type { AgentRecord } from "./agent-types.js";
import type { AgentTopologyHealthInput } from "./agent-health.js";
import type { AgentHealthInputOverrides } from "./agent-health-input.js";
import { deriveRoleColumnIndex } from "./layout-policy.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
import type {
  CmuxPane,
  CmuxPaneSurfaces,
  CmuxSurface,
  CmuxWorkspace,
} from "./types.js";

export type SurfaceTopology = AgentTopologyHealthInput;

export interface SurfaceTopologySnapshot {
  complete: boolean;
  workspaceBySurface: Map<string, string>;
  titleBySurface: Map<string, string>;
  topologyBySurface: Map<string, SurfaceTopology>;
  /** Stable cmux surface UUID keyed by the current process-local ref. */
  surfaceIdByRef: Map<string, string>;
  /** Current process-local ref keyed by stable cmux surface UUID. */
  surfaceRefById: Map<string, string>;
}

export interface ResolvedAgentSurfaceBinding {
  surfaceUuid: string;
  surfaceRef: string;
  workspaceId: string | null;
  title: string | null;
  provenance: "uuid" | "ref";
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

export type SurfaceObserverIdProvider = () =>
  | string
  | null
  | undefined;

/**
 * `undefined` means observer scoping is intentionally disabled for a legacy
 * library caller. `null` means scoping is enabled but no observer is known, so
 * an observation cannot authorize a later mutation.
 */
export type SurfaceObserverEpoch = string | null | undefined;

export function captureSurfaceObserverEpoch(
  observerIdProvider?: SurfaceObserverIdProvider,
): SurfaceObserverEpoch {
  if (!observerIdProvider) return undefined;
  try {
    return observerIdProvider()?.trim() || null;
  } catch {
    return null;
  }
}

export function isSurfaceObserverEpochCurrent(
  observerEpoch: SurfaceObserverEpoch,
  observerIdProvider?: SurfaceObserverIdProvider,
): boolean {
  if (observerEpoch === undefined) return true;
  if (!observerEpoch || !observerIdProvider) return false;
  return captureSurfaceObserverEpoch(observerIdProvider) === observerEpoch;
}

export const EMPTY_SURFACE_TOPOLOGY: SurfaceTopology = {
  column: null,
  column_count: null,
};

export interface SurfaceIdentityPair {
  surfaceRef: string;
  surfaceId?: string | null;
}

export interface SurfaceIdentityValidation {
  isBijective: boolean;
  surfaceIdByRef: Map<string, string>;
  surfaceRefById: Map<string, string>;
  conflictedSurfaceRefs: Set<string>;
  conflictedSurfaceIds: Set<string>;
}

/**
 * Validate stable UUID <-> mutable ref evidence as one observation.
 *
 * Repeated copies of the same pair are harmless. Any one-to-many mapping is
 * rejected as a whole because neither a positive match nor an absence derived
 * from that observation can identify a unique seat.
 */
export function validateSurfaceIdentityBijection(
  pairs: readonly SurfaceIdentityPair[],
): SurfaceIdentityValidation {
  const idKeysByRef = new Map<string, Set<string>>();
  const refsByIdKey = new Map<string, Set<string>>();
  const observedIdsByKey = new Map<string, Set<string>>();

  for (const pair of pairs) {
    const surfaceRef = pair.surfaceRef.trim();
    const surfaceId = pair.surfaceId?.trim();
    if (!surfaceRef || !surfaceId) continue;
    const idKey = surfaceId.toLowerCase();

    const idKeys = idKeysByRef.get(surfaceRef) ?? new Set<string>();
    idKeys.add(idKey);
    idKeysByRef.set(surfaceRef, idKeys);

    const refs = refsByIdKey.get(idKey) ?? new Set<string>();
    refs.add(surfaceRef);
    refsByIdKey.set(idKey, refs);

    const observedIds = observedIdsByKey.get(idKey) ?? new Set<string>();
    observedIds.add(surfaceId);
    observedIdsByKey.set(idKey, observedIds);
  }

  const conflictedSurfaceRefs = new Set<string>();
  const conflictedIdKeys = new Set<string>();
  for (const [surfaceRef, idKeys] of idKeysByRef) {
    if (idKeys.size > 1) conflictedSurfaceRefs.add(surfaceRef);
  }
  for (const [idKey, surfaceRefs] of refsByIdKey) {
    if (surfaceRefs.size > 1) conflictedIdKeys.add(idKey);
  }

  // Reject every identity in a contradictory connected component. Keeping a
  // leaf from that component would still allow an ambiguous edge to look live.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [surfaceRef, idKeys] of idKeysByRef) {
      if (
        !conflictedSurfaceRefs.has(surfaceRef) &&
        ![...idKeys].some((idKey) => conflictedIdKeys.has(idKey))
      ) {
        continue;
      }
      if (!conflictedSurfaceRefs.has(surfaceRef)) {
        conflictedSurfaceRefs.add(surfaceRef);
        expanded = true;
      }
      for (const idKey of idKeys) {
        if (!conflictedIdKeys.has(idKey)) {
          conflictedIdKeys.add(idKey);
          expanded = true;
        }
      }
    }
    for (const [idKey, surfaceRefs] of refsByIdKey) {
      if (
        !conflictedIdKeys.has(idKey) &&
        ![...surfaceRefs].some((surfaceRef) =>
          conflictedSurfaceRefs.has(surfaceRef),
        )
      ) {
        continue;
      }
      if (!conflictedIdKeys.has(idKey)) {
        conflictedIdKeys.add(idKey);
        expanded = true;
      }
      for (const surfaceRef of surfaceRefs) {
        if (!conflictedSurfaceRefs.has(surfaceRef)) {
          conflictedSurfaceRefs.add(surfaceRef);
          expanded = true;
        }
      }
    }
  }

  const surfaceIdByRef = new Map<string, string>();
  const surfaceRefById = new Map<string, string>();
  for (const [surfaceRef, idKeys] of idKeysByRef) {
    if (conflictedSurfaceRefs.has(surfaceRef) || idKeys.size !== 1) continue;
    const idKey = [...idKeys][0];
    if (!idKey || conflictedIdKeys.has(idKey)) continue;
    const observedIds = observedIdsByKey.get(idKey);
    const canonicalId = observedIds ? [...observedIds][0] : undefined;
    if (!canonicalId) continue;
    surfaceIdByRef.set(surfaceRef, canonicalId);
    surfaceRefById.set(canonicalId, surfaceRef);
  }

  const conflictedSurfaceIds = new Set<string>();
  for (const idKey of conflictedIdKeys) {
    for (const observedId of observedIdsByKey.get(idKey) ?? []) {
      conflictedSurfaceIds.add(observedId);
    }
  }

  return {
    isBijective:
      conflictedSurfaceRefs.size === 0 && conflictedSurfaceIds.size === 0,
    surfaceIdByRef,
    surfaceRefById,
    conflictedSurfaceRefs,
    conflictedSurfaceIds,
  };
}

export class SurfaceIdentityConflictError extends Error {
  readonly code = "SURFACE_IDENTITY_CONFLICT";
  readonly conflictedSurfaceRefs: string[];
  readonly conflictedSurfaceIds: string[];

  constructor(validation: SurfaceIdentityValidation) {
    const refs = [...validation.conflictedSurfaceRefs].sort();
    const ids = [...validation.conflictedSurfaceIds].sort();
    super(
      `Non-bijective surface identity observation (refs: ${refs.join(", ") || "none"}; UUIDs: ${ids.join(", ") || "none"})`,
    );
    this.name = "SurfaceIdentityConflictError";
    this.conflictedSurfaceRefs = refs;
    this.conflictedSurfaceIds = ids;
  }
}

export function enrichSurfaceIdsFromPanes(
  panesByWorkspace: Array<{
    ref: string;
    panes: { panes: CmuxPane[] };
  }>,
  surfaceGroups: CmuxPaneSurfaces[],
): CmuxSurface[] {
  const identity = validateSurfaceIdentityBijection([
    ...panesByWorkspace.flatMap(({ panes }) =>
      panes.panes.flatMap((pane) =>
        pane.surface_refs.map((surfaceRef, index) => ({
          surfaceRef,
          surfaceId: pane.surface_ids?.[index],
        })),
      ),
    ),
    ...surfaceGroups.flatMap((group) =>
      group.surfaces.map((surface) => ({
        surfaceRef: surface.ref,
        surfaceId: surface.id,
      })),
    ),
  ]);
  if (!identity.isBijective) {
    throw new SurfaceIdentityConflictError(identity);
  }

  const paneByRef = new Map(
    panesByWorkspace.flatMap(({ ref, panes }) =>
      panes.panes.map((pane) => [`${ref}:${pane.ref}`, pane] as const),
    ),
  );
  return surfaceGroups.flatMap((group) =>
    group.surfaces.map((surface) => {
      const pane = paneByRef.get(`${group.workspace_ref}:${group.pane_ref}`);
      const surfaceIndex = pane?.surface_refs?.indexOf(surface.ref) ?? -1;
      const inferredId =
        surfaceIndex >= 0 ? pane?.surface_ids?.[surfaceIndex] : undefined;
      return {
        ...surface,
        id: surface.id ?? inferredId,
        workspace_ref: group.workspace_ref,
        pane_ref: group.pane_ref,
      };
    }),
  );
}

export async function collectSurfaceTopology(
  client: SurfaceTopologyClient,
  workspace?: string,
  observerIdProvider?: SurfaceObserverIdProvider,
): Promise<SurfaceTopologySnapshot | null> {
  const observerEpoch = captureSurfaceObserverEpoch(observerIdProvider);
  if (observerEpoch === null) {
    return null;
  }

  let workspaceRefs: string[];
  try {
    workspaceRefs = workspace
      ? [workspace]
      : (await client.listWorkspaces()).workspaces.map((ws) => ws.ref);
  } catch {
    return null;
  }

  const snapshot: SurfaceTopologySnapshot = {
    complete: true,
    workspaceBySurface: new Map(),
    titleBySurface: new Map(),
    topologyBySurface: new Map(),
    surfaceIdByRef: new Map(),
    surfaceRefById: new Map(),
  };
  const identityPairs: SurfaceIdentityPair[] = [];

  for (const workspaceRef of workspaceRefs) {
    try {
      const panes = await client.listPanes({ workspace: workspaceRef });
      if (!panes.panes || panes.panes.length === 0) continue;

      const columnIndex = deriveRoleColumnIndex(panes.panes);
      const columnCount = new Set(columnIndex.values()).size;
      for (const pane of panes.panes) {
        for (const [index, surfaceRef] of pane.surface_refs.entries()) {
          identityPairs.push({
            surfaceRef,
            surfaceId: pane.surface_ids?.[index],
          });
        }
      }
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
          snapshot.complete = false;
        }
      }
      for (const group of rawGroups) {
        for (const surface of group.surfaces ?? []) {
          identityPairs.push({
            surfaceRef: surface.ref,
            surfaceId: surface.id,
          });
        }
      }
      const partitioned = partitionPaneSurfacesByMembership(panes.panes, rawGroups, {
        workspace_ref: panes.workspace_ref ?? workspaceRef,
        window_ref: panes.window_ref,
      });
      for (const pane of panes.panes) {
        const expectedSurfaceRefs = new Set(pane.surface_refs);
        const observedGroup = partitioned.find(
          (group) => group.pane_ref === pane.ref,
        );
        const observedSurfaceRefs =
          observedGroup?.surfaces.map((surface) => surface.ref) ?? [];
        const observedSurfaceRefSet = new Set(observedSurfaceRefs);
        if (
          pane.surface_count !== pane.surface_refs.length ||
          expectedSurfaceRefs.size !== pane.surface_refs.length ||
          observedSurfaceRefSet.size !== observedSurfaceRefs.length ||
          observedSurfaceRefSet.size !== expectedSurfaceRefs.size ||
          [...expectedSurfaceRefs].some(
            (surfaceRef) => !observedSurfaceRefSet.has(surfaceRef),
          )
        ) {
          // A command can succeed while racing a new/closed tab and return a
          // strict subset of the pane metadata. Such a snapshot can enrich
          // positive health, but it cannot prove another UUID-backed seat is
          // absent or authorize first-render/sidebar/lifecycle mutation.
          snapshot.complete = false;
        }
      }
      for (const group of partitioned) {
        const pane = panes.panes.find((candidate) => candidate.ref === group.pane_ref);
        for (const surface of group.surfaces) {
          const surfaceIndex = pane?.surface_refs?.indexOf(surface.ref) ?? -1;
          const surfaceId =
            surface.id ??
            (surfaceIndex >= 0 ? pane?.surface_ids?.[surfaceIndex] : undefined);
          identityPairs.push({ surfaceRef: surface.ref, surfaceId });
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
      snapshot.complete = false;
    }
  }

  const identity = validateSurfaceIdentityBijection(identityPairs);
  snapshot.surfaceIdByRef = new Map(
    [...identity.surfaceIdByRef].filter(([surfaceRef]) =>
      snapshot.workspaceBySurface.has(surfaceRef),
    ),
  );
  snapshot.surfaceRefById = new Map(
    [...identity.surfaceRefById].filter(([, surfaceRef]) =>
      snapshot.workspaceBySurface.has(surfaceRef),
    ),
  );
  if (!identity.isBijective) {
    snapshot.complete = false;
  }

  const observedSurfaceCount = snapshot.workspaceBySurface.size;
  const identifiedSurfaceCount = snapshot.surfaceIdByRef.size;
  if (
    identifiedSurfaceCount > 0 &&
    identifiedSurfaceCount < observedSurfaceCount
  ) {
    // A mixed snapshot cannot prove whether an identity-free surface is the
    // missing UUID-backed seat. Treat the whole observation as inconclusive.
    snapshot.complete = false;
  }

  if (!isSurfaceObserverEpochCurrent(observerEpoch, observerIdProvider)) {
    return null;
  }

  return snapshot;
}

/**
 * Resolve a registry record to one live surface observation.
 *
 * A persisted UUID is authoritative and may move to a new ref. If that UUID is
 * absent, fail closed: the record must not borrow a live recycled ref's title,
 * screen state, or focus route. Legacy records without a UUID can be upgraded
 * from the current complete topology and retain ref-only compatibility with
 * older cmux clients that do not expose UUIDs.
 */
export function resolveAgentSurfaceBinding(
  agent: Pick<AgentRecord, "surface_id" | "surface_uuid">,
  snapshot: SurfaceTopologySnapshot | null,
): ResolvedAgentSurfaceBinding | null {
  if (!snapshot || snapshot.complete !== true) return null;

  const expectedUuid = agent.surface_uuid?.trim() || null;
  const expectedUuidKey = expectedUuid?.toLowerCase() ?? null;
  const surfaceRef = expectedUuid
    ? [...snapshot.surfaceRefById].find(
        ([observedUuid]) =>
          observedUuid.trim().toLowerCase() === expectedUuidKey,
      )?.[1]
    : snapshot.workspaceBySurface.has(agent.surface_id)
      ? agent.surface_id
      : undefined;
  if (!surfaceRef) return null;

  const observedUuid = snapshot.surfaceIdByRef.get(surfaceRef);
  if (
    expectedUuidKey &&
    observedUuid &&
    observedUuid.trim().toLowerCase() !== expectedUuidKey
  ) {
    return null;
  }

  return {
    surfaceUuid: observedUuid ?? expectedUuid ?? surfaceRef,
    surfaceRef,
    workspaceId: snapshot.workspaceBySurface.get(surfaceRef) ?? null,
    title: snapshot.titleBySurface.get(surfaceRef) ?? null,
    provenance: expectedUuid ? "uuid" : "ref",
  };
}

export function healthTopologyOverrides(
  agent: AgentRecord,
  snapshot: SurfaceTopologySnapshot | null,
): AgentHealthInputOverrides {
  const binding = resolveAgentSurfaceBinding(agent, snapshot);
  if (!binding || !snapshot) {
    return {
      topology: null,
      surface_workspace_id: null,
      surface_title: null,
    };
  }

  return {
    topology:
      snapshot.topologyBySurface.get(binding.surfaceRef) ??
      EMPTY_SURFACE_TOPOLOGY,
    surface_workspace_id: binding.workspaceId,
    surface_title: binding.title,
  };
}
