import type { CmuxPane, CmuxPaneSurfaces } from "./types.js";
import type { AgentRecord, AgentRole, CliType } from "./agent-types.js";

export type AgentSpawnPlacement =
  | { kind: "split"; direction: "left" | "right" | "up" | "down"; pane?: string }
  | { kind: "surface"; pane: string };

export interface SurfaceClosePolicy {
  surface: string;
  pane: string | null;
  collapsePane: boolean;
}

interface PaneLayout {
  pane: CmuxPane;
  surfaces: CmuxPaneSurfaces["surfaces"];
  orchestratorCount: number;
  icCount: number;
  workerCount: number;
  roleCount: number;
  nonRoleCount: number;
}

export interface RoleSurfaceIds {
  orchestrator: Set<string>;
  ic: Set<string>;
  worker: Set<string>;
}

export interface AgentPlacementContext {
  role?: AgentRole;
  parentRole?: AgentRole | null;
  parentSurfaceId?: string | null;
  childWorkerSurfaceIds?: ReadonlySet<string>;
}

function emptyRoleSurfaceIds(): RoleSurfaceIds {
  return {
    orchestrator: new Set(),
    ic: new Set(),
    worker: new Set(),
  };
}

function normalizeRoleSurfaceIds(
  input: ReadonlySet<string> | RoleSurfaceIds,
): RoleSurfaceIds {
  if (!("worker" in input)) {
    return {
      orchestrator: new Set(),
      ic: new Set(),
      worker: new Set(input),
    };
  }
  return input;
}

function describePaneLayouts(
  panes: CmuxPane[],
  paneSurfaces: CmuxPaneSurfaces[],
  roleSurfaceIds: RoleSurfaceIds,
): PaneLayout[] {
  const groupsByPane = new Map(
    paneSurfaces.map((group) => [group.pane_ref, group.surfaces]),
  );

  return panes.map((pane) => {
    const surfaces = groupsByPane.get(pane.ref) ?? [];
    const orchestratorCount = surfaces.filter((surface) =>
      roleSurfaceIds.orchestrator.has(surface.ref),
    ).length;
    const icCount = surfaces.filter((surface) =>
      roleSurfaceIds.ic.has(surface.ref),
    ).length;
    const workerCount = surfaces.filter((surface) =>
      roleSurfaceIds.worker.has(surface.ref),
    ).length;
    const roleCount = orchestratorCount + icCount + workerCount;
    return {
      pane,
      surfaces,
      orchestratorCount,
      icCount,
      workerCount,
      roleCount,
      nonRoleCount: surfaces.length - roleCount,
    };
  });
}

function byPaneIndex(a: PaneLayout, b: PaneLayout): number {
  return a.pane.index - b.pane.index;
}

function leftmost(layouts: PaneLayout[]): PaneLayout | undefined {
  return [...layouts].sort(byPaneIndex).at(0);
}

function rightmost(layouts: PaneLayout[]): PaneLayout | undefined {
  return [...layouts].sort(byPaneIndex).at(-1);
}

function isDedicatedOrchestratorPane(layout: PaneLayout): boolean {
  return (
    layout.orchestratorCount > 0 &&
    layout.icCount === 0 &&
    layout.workerCount === 0 &&
    layout.nonRoleCount === 0
  );
}

function isDedicatedIcPane(layout: PaneLayout): boolean {
  return (
    layout.icCount > 0 &&
    layout.orchestratorCount === 0 &&
    layout.workerCount === 0 &&
    layout.nonRoleCount === 0
  );
}

function isDedicatedWorkerPane(layout: PaneLayout): boolean {
  return (
    layout.workerCount > 0 &&
    layout.orchestratorCount === 0 &&
    layout.icCount === 0 &&
    layout.nonRoleCount === 0
  );
}

function paneContainingSurface(
  layouts: PaneLayout[],
  surfaceId?: string | null,
): PaneLayout | undefined {
  if (!surfaceId) return undefined;
  return layouts.find((layout) =>
    layout.surfaces.some((surface) => surface.ref === surfaceId),
  );
}

function paneContainingAnySurface(
  layouts: PaneLayout[],
  surfaceIds: ReadonlySet<string>,
): PaneLayout | undefined {
  if (surfaceIds.size === 0) return undefined;
  return layouts.find((layout) =>
    layout.surfaces.some((surface) => surfaceIds.has(surface.ref)),
  );
}

export function inferAgentRole(input: {
  role?: AgentRole;
  launcherName?: string;
  title?: string;
  cli?: string;
}): AgentRole {
  if (input.role) return input.role;

  const launcherName = input.launcherName ?? input.title ?? "";
  if (/Claude$/i.test(launcherName)) return "orchestrator";
  if (/(Codex|Cursor)$/i.test(launcherName)) return "worker";

  switch (input.cli) {
    case "claude":
      return "orchestrator";
    case "codex":
    case "cursor":
    case "gemini":
    case "kiro":
      return "worker";
    default:
      return "worker";
  }
}

export function launcherNameForCli(repo: string, cli: CliType): string {
  switch (cli) {
    case "claude":
      return `${repo}Claude`;
    case "codex":
      return `${repo}Codex`;
    case "cursor":
      return `${repo}Cursor`;
    case "gemini":
      return `${repo}Gemini`;
    case "kiro":
      return `${repo}Kiro`;
    default:
      return repo;
  }
}

export function inferRecordRole(
  agent: Pick<AgentRecord, "role" | "cli" | "repo">,
): AgentRole {
  return (
    agent.role ??
    inferAgentRole({
      cli: agent.cli,
      launcherName: launcherNameForCli(agent.repo, agent.cli),
    })
  );
}

export function collectRoleSurfaceIds(
  agents: Iterable<Pick<AgentRecord, "role" | "cli" | "repo" | "surface_id">>,
): RoleSurfaceIds {
  const ids: RoleSurfaceIds = {
    orchestrator: new Set(),
    ic: new Set(),
    worker: new Set(),
  };
  for (const agent of agents) {
    ids[inferRecordRole(agent)].add(agent.surface_id);
  }
  return ids;
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
  roleSurfaceIdsInput: ReadonlySet<string> | RoleSurfaceIds,
  context: AgentPlacementContext = {},
): AgentSpawnPlacement {
  const roleSurfaceIds = normalizeRoleSurfaceIds(roleSurfaceIdsInput);
  const role = context.role ?? "worker";
  const layouts = describePaneLayouts(panes, paneSurfaces, roleSurfaceIds);
  const leftPane = leftmost(layouts);

  if (layouts.length === 0) {
    return { kind: "split", direction: "right" };
  }

  if (role === "orchestrator") {
    const orchestratorPane =
      leftmost(layouts.filter(isDedicatedOrchestratorPane)) ??
      (leftPane && leftPane.icCount === 0 && leftPane.workerCount === 0
        ? leftPane
        : undefined);
    return orchestratorPane
      ? { kind: "surface", pane: orchestratorPane.pane.ref }
      : { kind: "split", direction: "left" };
  }

  const workerPanes = layouts.filter(isDedicatedWorkerPane);
  const icPanes = layouts.filter(isDedicatedIcPane);

  if (role === "ic") {
    const icPane = rightmost(icPanes);
    if (icPane) {
      return { kind: "surface", pane: icPane.pane.ref };
    }
    const workerPane = rightmost(workerPanes);
    if (workerPane) {
      return {
        kind: "split",
        direction: "up",
        pane: workerPane.pane.ref,
      };
    }
    return { kind: "split", direction: "right" };
  }

  if (context.parentRole === "ic") {
    const childPane = paneContainingAnySurface(
      layouts,
      context.childWorkerSurfaceIds ?? new Set(),
    );
    if (childPane && isDedicatedWorkerPane(childPane)) {
      return { kind: "surface", pane: childPane.pane.ref };
    }

    const parentPane = paneContainingSurface(layouts, context.parentSurfaceId);
    if (parentPane) {
      return {
        kind: "split",
        direction: "down",
        pane: parentPane.pane.ref,
      };
    }
  }

  const rightmostWorkerPane = rightmost(workerPanes);
  if (rightmostWorkerPane) {
    return { kind: "surface", pane: rightmostWorkerPane.pane.ref };
  }

  const rightmostIcPane = rightmost(icPanes);
  if (rightmostIcPane) {
    return {
      kind: "split",
      direction: "down",
      pane: rightmostIcPane.pane.ref,
    };
  }

  return { kind: "split", direction: "right" };
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
    { ...emptyRoleSurfaceIds(), worker: new Set(workerSurfaceIds) },
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
