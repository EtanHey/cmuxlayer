import type { CmuxPane, CmuxPaneSurfaces } from "./types.js";
import type { AgentRecord, AgentRole, CliType } from "./agent-types.js";
import { extractPrefix } from "./naming.js";

export type AgentSpawnPlacement =
  | {
      kind: "split";
      direction: "left" | "right" | "up" | "down";
      pane?: string;
    }
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
  unknownCount: number;
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
  worktree?: boolean;
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
    const roles = surfaces.map((surface) =>
      roleForSurface(surface, roleSurfaceIds),
    );
    const orchestratorCount = roles.filter(
      (role) => role === "orchestrator",
    ).length;
    const icCount = roles.filter((role) => role === "ic").length;
    const workerCount = roles.filter((role) => role === "worker").length;
    const unknownCount = roles.filter((role) => role === "unknown").length;
    const roleCount = orchestratorCount + icCount + workerCount;
    return {
      pane,
      surfaces,
      orchestratorCount,
      icCount,
      workerCount,
      unknownCount,
      roleCount,
      nonRoleCount: surfaces.length - roleCount,
    };
  });
}

function roleForSurface(
  surface: CmuxPaneSurfaces["surfaces"][number],
  roleSurfaceIds: RoleSurfaceIds,
): AgentRole | "unknown" | null {
  if (roleSurfaceIds.orchestrator.has(surface.ref)) return "orchestrator";
  if (roleSurfaceIds.ic.has(surface.ref)) return "ic";
  if (roleSurfaceIds.worker.has(surface.ref)) return "worker";
  if (roleSurfaceIds.unknown?.has(surface.ref)) return "unknown";
  if (surface.type === "terminal") return roleFromLauncherLabel(surface.title);
  return null;
}

export function deriveColumnIndex(panes: CmuxPane[]): Map<string, number> {
  // cmux can report zero-area frames for background or partially rendered
  // panes. Those frames still carry an x position, but must not be grouped with
  // real same-x panes or every {x:0,width:0} pane collapses into one column.
  // When every pane has a frame, use x ordering and keep zero-width frames as
  // unique columns; if any frame is missing entirely, fall back to pane.index.
  const useGeometry = panes.every((pane) => pane.pixel_frame);
  const columnKey = (pane: CmuxPane): string => {
    if (!useGeometry) return `index:${pane.index}`;
    const frame = pane.pixel_frame!;
    return frame.width > 0
      ? `x:${frame.x}`
      : `zero:${frame.x}:index:${pane.index}`;
  };
  const sortedGroups = [
    ...new Map(
      [...panes]
        .sort((a, b) => {
          const aPosition = useGeometry ? a.pixel_frame!.x : a.index;
          const bPosition = useGeometry ? b.pixel_frame!.x : b.index;
          return aPosition - bPosition || a.index - b.index;
        })
        .map((pane) => [columnKey(pane), pane]),
    ).keys(),
  ];
  const columnByGroup = new Map(
    sortedGroups.map((group, index) => [group, index]),
  );

  return new Map(
    panes.map((pane) => {
      const group = columnKey(pane);
      return [pane.ref, columnByGroup.get(group) ?? 0];
    }),
  );
}

/**
 * Role columns ignore zero-area phantom panes when cmux also reports rendered
 * panes. If every pane is backgrounded (all frames are zero-area), preserve
 * deterministic pane-index ordering so the two logical columns do not collapse.
 */
export function deriveRoleColumnIndex(
  panes: CmuxPane[],
): Map<string, number> {
  const hasCompleteGeometry = panes.every((pane) => pane.pixel_frame);
  const renderedPanes = hasCompleteGeometry
    ? panes.filter(
        (pane) =>
          pane.pixel_frame!.width > 0 && pane.pixel_frame!.height > 0,
      )
    : panes;
  return deriveColumnIndex(renderedPanes.length > 0 ? renderedPanes : panes);
}

export function canonicalRoleColumn(role: AgentRole): number | null {
  if (role === "orchestrator") return 0;
  if (role === "worker") return 1;
  return null;
}

/**
 * Return the current top pane in a role's canonical column. Geometry is the
 * authority when cmux provides it; pane index is the deterministic fallback.
 * Pane contents deliberately do not participate in this choice.
 */
export function topPaneInRoleColumn(
  panes: CmuxPane[],
  role: AgentRole,
): CmuxPane | null {
  const targetColumn = canonicalRoleColumn(role);
  if (targetColumn === null) return null;
  const columnByPane = deriveRoleColumnIndex(panes);
  return (
    [...panes]
      .filter((pane) => columnByPane.get(pane.ref) === targetColumn)
      .sort((a, b) => {
        const aY = a.pixel_frame?.y ?? a.index;
        const bY = b.pixel_frame?.y ?? b.index;
        return aY - bY || a.index - b.index;
      })
      .at(0) ?? null
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
  const matches = [
    ...launcher.matchAll(/(Claude|Codex|Cursor)(?=$|[^a-z0-9])/gi),
  ];
  const marker = matches.at(-1)?.[1]?.toLowerCase();
  if (marker === "claude") return "orchestrator";
  if (marker === "codex" || marker === "cursor") return "worker";
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

export function inferRecordRoleOrNull(
  agent: Pick<AgentRecord, "role" | "cli" | "repo">,
): AgentRole | null {
  try {
    return inferRecordRole(agent);
  } catch (error) {
    if (isAgentRoleInferenceError(error)) {
      return null;
    }
    throw error;
  }
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
          `[cmuxlayer] Unable to classify agent role for ${agent.surface_id}; not counting it as a worker`,
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
 * Role-deterministic placement:
 * - orchestrators dock at the current top of column 0
 * - workers dock at the current top of column 1, independent of pane fill
 * - a missing worker column is seeded to the right of the top lead pane
 * - IC placement retains its existing hierarchy-aware policy
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
  const columnByPane = deriveColumnIndex(panes);
  const byColumnThenIndex = (a: PaneLayout, b: PaneLayout): number => {
    const aColumn = columnByPane.get(a.pane.ref) ?? a.pane.index;
    const bColumn = columnByPane.get(b.pane.ref) ?? b.pane.index;
    return aColumn - bColumn || a.pane.index - b.pane.index;
  };
  const rightmostByColumn = (candidates: PaneLayout[]) =>
    [...candidates].sort(byColumnThenIndex).at(-1);

  if (layouts.length === 0) {
    return { kind: "split", direction: "right" };
  }

  if (role === "orchestrator") {
    const orchestratorPane = topPaneInRoleColumn(panes, role);
    return orchestratorPane
      ? { kind: "surface", pane: orchestratorPane.ref }
      : { kind: "split", direction: "left" };
  }

  if (role === "worker") {
    const workerPane = topPaneInRoleColumn(panes, role);
    if (workerPane) {
      return { kind: "surface", pane: workerPane.ref };
    }
    const leadPane = topPaneInRoleColumn(panes, "orchestrator");
    return {
      kind: "split",
      direction: "right",
      ...(leadPane ? { pane: leadPane.ref } : {}),
    };
  }

  const workerPanes = layouts.filter(isDedicatedWorkerPane);
  const icPanes = layouts.filter(isDedicatedIcPane);

  if (role === "ic") {
    const icPane = rightmostByColumn(icPanes);
    if (icPane) {
      return { kind: "surface", pane: icPane.pane.ref };
    }
    const workerPane = rightmostByColumn(workerPanes);
    if (workerPane) {
      return {
        kind: "split",
        direction: "up",
        pane: workerPane.pane.ref,
      };
    }
    return { kind: "split", direction: "right" };
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
  const layout = describePaneLayouts(panes, paneSurfaces, {
    ...emptyRoleSurfaceIds(),
    worker: new Set(workerSurfaceIds),
  }).find((candidate) =>
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
