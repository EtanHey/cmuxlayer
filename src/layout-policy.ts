import type { CmuxPane, CmuxPaneSurfaces } from "./types.js";
import type { AgentRecord, AgentRole, CliType } from "./agent-types.js";
import { extractPrefix } from "./naming.js";

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
  unknown?: Set<string>;
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
    unknown: new Set(),
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
      unknown: new Set(),
    };
  }
  return { ...input, unknown: input.unknown ?? new Set() };
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

/**
 * A pane workers own for docking. Stricter than "has a worker": it must hold no
 * orchestrators/ICs and workers must be the strict majority of its surfaces, so
 * a real workers pane that also carries a stray non-role tab (a setup shell, a
 * dashboard) still docks new workers as tabs instead of spawning a third pane.
 * A pure dedicated worker pane (nonRoleCount === 0) trivially satisfies this.
 * A lone worker tied with a non-role surface does NOT (1 is not > 1), so an
 * accidental worker in someone's shell pane still splits out to a clean pane.
 */
function isWorkerDockPane(layout: PaneLayout): boolean {
  return (
    layout.orchestratorCount === 0 &&
    layout.icCount === 0 &&
    layout.workerCount > 0 &&
    layout.workerCount > layout.nonRoleCount
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

export class AgentRoleInferenceError extends Error {
  constructor(input: {
    role?: AgentRole;
    launcherName?: string;
    title?: string;
    cli?: string;
  }) {
    const details = [
      input.role ? `role=${input.role}` : null,
      input.launcherName ? `launcherName=${input.launcherName}` : null,
      input.title ? `title=${input.title}` : null,
      input.cli ? `cli=${input.cli}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    super(
      `Unable to infer agent role${
        details ? ` from ${details}` : ""
      }; pass an explicit role or a repoGolem launcher ending in Claude, Codex, or Cursor`,
    );
    this.name = "AgentRoleInferenceError";
  }
}

export function isAgentRoleInferenceError(
  error: unknown,
): error is AgentRoleInferenceError {
  return error instanceof AgentRoleInferenceError;
}

function roleFromLauncherLabel(label: string | undefined): AgentRole | null {
  if (!label) return null;
  const launcher = extractPrefix(label);
  if (/Claude$/i.test(launcher)) return "orchestrator";
  if (/(Codex|Cursor)$/i.test(launcher)) return "worker";
  return null;
}

function roleFromCli(cli: string | undefined): AgentRole | null {
  switch (cli) {
    case "claude":
      return "orchestrator";
    case "codex":
    case "cursor":
    case "gemini":
    case "kiro":
      return "worker";
    default:
      return null;
  }
}

export function canInferAgentRole(input: {
  role?: AgentRole;
  launcherName?: string;
  title?: string;
  cli?: string;
}): boolean {
  return Boolean(
    input.role ||
      roleFromLauncherLabel(input.launcherName) ||
      roleFromLauncherLabel(input.title) ||
      roleFromCli(input.cli),
  );
}

export function inferAgentRole(input: {
  role?: AgentRole;
  launcherName?: string;
  title?: string;
  cli?: string;
}): AgentRole {
  if (input.role) return input.role;

  const launcherRole =
    roleFromLauncherLabel(input.launcherName) ??
    roleFromLauncherLabel(input.title);
  if (launcherRole) return launcherRole;

  const cliRole = roleFromCli(input.cli);
  if (cliRole) return cliRole;

  throw new AgentRoleInferenceError(input);
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
    unknown: new Set(),
  };
  for (const agent of agents) {
    try {
      ids[inferRecordRole(agent)].add(agent.surface_id);
    } catch (error) {
      if (isAgentRoleInferenceError(error)) {
        ids.unknown?.add(agent.surface_id);
        console.warn(
          `[cmux-mcp] Unable to classify agent role for ${agent.surface_id}; not counting it as a worker`,
          error.message,
        );
        continue;
      }
      throw error;
    }
  }
  return ids;
}

/**
 * Deterministic worker placement:
 * - first worker creates the right split
 * - subsequent workers become tabs in the rightmost worker-owned pane — a
 *   worker-majority pane, which tolerates a stray non-role tab (a setup shell
 *   or dashboard) so a populated workers pane never sprouts a redundant pane
 * - a lone worker sharing a pane with an interactive/non-role surface is still
 *   treated as invalid and repaired with a fresh right split, preserving the
 *   left-interactive/right-worker invariant
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

  if (context.parentRole === "orchestrator") {
    const childPane = paneContainingAnySurface(
      layouts,
      context.childWorkerSurfaceIds ?? new Set(),
    );
    if (childPane && isWorkerDockPane(childPane)) {
      return { kind: "surface", pane: childPane.pane.ref };
    }

    const parentPane = paneContainingSurface(layouts, context.parentSurfaceId);
    if (parentPane) {
      return {
        kind: "split",
        direction: "right",
        pane: parentPane.pane.ref,
      };
    }
  }

  // Dock into the rightmost pane workers already own — including one that
  // carries a stray non-role tab — so a populated workers pane never gets a
  // redundant third pane split off beside it.
  const rightmostWorkerPane = rightmost(layouts.filter(isWorkerDockPane));
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
