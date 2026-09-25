// list_surfaces, update_surface and close_surface moved out of createServer's
// closure (CX-3 S6), with the list_surfaces helpers they alone used. The
// formerly internal move_surface / rename_tab / delete_workspace registrations
// are plain functions now, called directly by update_surface and close_surface.
// Captured closure state arrives as SurfaceToolDeps.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentRecord, AgentState, CloseTelemetryEvent } from "../../agent-types.js";
import type { DeliveryEngine } from "../../delivery/engine.js";
import { formatListSurfaces, formatOk } from "../../format.js";
import { chooseSurfaceClosePolicy, deriveColumnIndex } from "../../layout-policy.js";
import { TERMINAL_AGENT_STATES } from "../../live-agent-state.js";
import { replaceTaskSuffix } from "../../naming.js";
import { partitionPaneSurfacesByMembership } from "../../pane-surfaces.js";
import { screenHasActiveAgentMarker } from "../../pattern-registry.js";
import { parseScreen } from "../../screen-parser.js";
import type { StateManager } from "../../state-manager.js";
import { type AllWindowWorkspaceEnumeration, type SurfaceTopologySnapshot, type TopologyRpcObserver, enrichSurfaceIdsFromPanes } from "../../surface-topology.js";
import { withTransportRetryTracking } from "../../transport-retry-context.js";
import type { CmuxSurface, CmuxTerminalMetadata } from "../../types.js";
import { agentProcessMayBeAlive } from "../../util/pid-alive.js";
import type { WatchOwnerCandidate } from "../../watch-owner.js";
import type { CmuxLayerClient, CmuxServerContext } from "../context.js";
import type { ToolHandlerRegistry } from "../registration.js";
import { ANNOTATIONS } from "../schemas.js";
import { type ToolReturn, err, okFormatted, readErrorText } from "../tool-result.js";

// Only the internal scope=agent close delegate can request this teardown path.
// A remote JSON tool caller cannot supply a symbol property.
export const OWNED_AGENT_CLOSE_ON_UNKNOWN_PID = Symbol(
  "owned-agent-close-on-unknown-pid",
);

type ListSurfacesRemoteState =
  "local" | "connected" | "disconnected" | "unavailable";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function summarizeRemoteState(remoteValue: unknown): ListSurfacesRemoteState {
  const remote = asRecord(remoteValue);
  if (!remote) {
    return "local";
  }

  const state =
    typeof remote.state === "string"
      ? (remote.state as ListSurfacesRemoteState | string)
      : undefined;
  const connected = remote.connected === true || state === "connected";
  if (connected) {
    return "connected";
  }

  const hasRemoteHints =
    remote.enabled === true ||
    remote.has_ssh_options === true ||
    remote.has_identity_file === true ||
    (typeof remote.destination === "string" && remote.destination.length > 0) ||
    (remote.port !== null && remote.port !== undefined) ||
    (remote.local_proxy_port !== null && remote.local_proxy_port !== undefined);

  if (!hasRemoteHints && (state === undefined || state === "disconnected")) {
    return "local";
  }

  if (state === "unavailable") {
    return hasRemoteHints ? "unavailable" : "local";
  }

  return "disconnected";
}

function toMinimalWorkspace(
  workspace: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ref: typeof workspace.ref === "string" ? workspace.ref : "",
    title: typeof workspace.title === "string" ? workspace.title : "",
    current_directory:
      typeof workspace.current_directory === "string"
        ? workspace.current_directory
        : null,
    remote_state: summarizeRemoteState(workspace.remote),
  };
}

function toMinimalSurface(
  surface: Record<string, unknown>,
): Record<string, unknown> {
  const minimal: Record<string, unknown> = {
    ref: typeof surface.ref === "string" ? surface.ref : "",
    title: typeof surface.title === "string" ? surface.title : "",
    type: typeof surface.type === "string" ? surface.type : "terminal",
    workspace_ref:
      typeof surface.workspace_ref === "string" ? surface.workspace_ref : "",
  };

  if (typeof surface.id === "string") {
    minimal.id = surface.id;
  }
  if (typeof surface.pane_ref === "string") {
    minimal.pane_ref = surface.pane_ref;
  }
  if (typeof surface.column === "number") {
    minimal.column = surface.column;
  }
  if (typeof surface.screen_preview === "string") {
    minimal.screen_preview = surface.screen_preview;
  }
  if (typeof surface.screen_preview_error === "string") {
    minimal.screen_preview_error = surface.screen_preview_error;
  }
  if (typeof surface.current_directory === "string") {
    minimal.current_directory = surface.current_directory;
  } else if (surface.current_directory === null) {
    minimal.current_directory = null;
  }
  if (typeof surface.requested_working_directory === "string") {
    minimal.requested_working_directory = surface.requested_working_directory;
  } else if (surface.requested_working_directory === null) {
    minimal.requested_working_directory = null;
  }
  if (typeof surface.working_directory_source === "string") {
    minimal.working_directory_source = surface.working_directory_source;
  }
  if (typeof surface.working_directory_fallback === "boolean") {
    minimal.working_directory_fallback = surface.working_directory_fallback;
  }

  return minimal;
}

type SurfaceWorkingDirectorySource =
  | "terminal_metadata"
  | "surface"
  | "pane"
  | "workspace_fallback"
  | "unavailable";

interface SurfaceWorkingDirectory {
  cwd: string | null;
  source: SurfaceWorkingDirectorySource;
}

interface SurfaceWorkingDirectoryMaps {
  terminalBySurface: Map<string, CmuxTerminalMetadata>;
  paneByWorkspaceAndRef: Map<string, Record<string, unknown>>;
  workspaceCwdByRef: Map<string, string>;
}

interface TerminalMetadataLoadResult {
  terminalBySurface: Map<string, CmuxTerminalMetadata>;
  degraded?: {
    terminal_metadata: true;
    error_code: "terminal_metadata_unavailable";
    error: string;
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function workingDirectoryFromRecord(
  record: Record<string, unknown> | null | undefined,
): string | null {
  return (
    nonEmptyString(record?.current_directory) ??
    nonEmptyString(record?.cwd) ??
    nonEmptyString(record?.working_directory)
  );
}

function paneWorkingDirectoryKey(
  workspaceRef: string,
  paneRef: string,
): string {
  return `${workspaceRef}\0${paneRef}`;
}

async function loadTerminalMetadataBySurface(
  client: CmuxLayerClient,
): Promise<TerminalMetadataLoadResult> {
  const metadataClient = client as CmuxLayerClient & {
    listTerminalMetadata?: () => Promise<{ terminals: CmuxTerminalMetadata[] }>;
  };
  if (typeof metadataClient.listTerminalMetadata !== "function") {
    return { terminalBySurface: new Map() };
  }

  try {
    const { terminals } = await metadataClient.listTerminalMetadata();
    const bySurface = new Map<string, CmuxTerminalMetadata>();
    for (const terminal of terminals) {
      const surfaceRef =
        nonEmptyString(terminal.surface_ref) ??
        nonEmptyString(terminal.surface_id) ??
        nonEmptyString(terminal.ref);
      if (surfaceRef) {
        bySurface.set(surfaceRef, terminal);
      }
    }
    return { terminalBySurface: bySurface };
  } catch (error) {
    return {
      terminalBySurface: new Map(),
      degraded: {
        terminal_metadata: true,
        error_code: "terminal_metadata_unavailable",
        error: readErrorText(error),
      },
    };
  }
}

function resolveSurfaceWorkingDirectory(
  surface: Record<string, unknown>,
  workspaceRef: string,
  paneRef: string,
  maps: SurfaceWorkingDirectoryMaps,
): SurfaceWorkingDirectory {
  const surfaceRef = nonEmptyString(surface.ref);
  const terminal =
    surfaceRef === null ? undefined : maps.terminalBySurface.get(surfaceRef);
  const terminalCwd = workingDirectoryFromRecord(
    terminal ? (terminal as Record<string, unknown>) : null,
  );
  if (terminalCwd) {
    return { cwd: terminalCwd, source: "terminal_metadata" };
  }

  const surfaceCwd = workingDirectoryFromRecord(surface);
  if (surfaceCwd) {
    return { cwd: surfaceCwd, source: "surface" };
  }

  const pane = maps.paneByWorkspaceAndRef.get(
    paneWorkingDirectoryKey(workspaceRef, paneRef),
  );
  const paneCwd = workingDirectoryFromRecord(pane);
  if (paneCwd) {
    return { cwd: paneCwd, source: "pane" };
  }

  const workspaceCwd = maps.workspaceCwdByRef.get(workspaceRef);
  if (workspaceCwd) {
    return { cwd: workspaceCwd, source: "workspace_fallback" };
  }

  return { cwd: null, source: "unavailable" };
}

function applySurfaceWorkingDirectory(
  surface: Record<string, unknown>,
  workspaceRef: string,
  paneRef: string,
  maps: SurfaceWorkingDirectoryMaps,
): void {
  const resolved = resolveSurfaceWorkingDirectory(
    surface,
    workspaceRef,
    paneRef,
    maps,
  );
  surface.current_directory = resolved.cwd;
  surface.requested_working_directory = resolved.cwd;
  surface.working_directory_source = resolved.source;
  surface.working_directory_fallback =
    resolved.source === "workspace_fallback" ||
    resolved.source === "unavailable";
}

/**
 * createServer's closure state the surface tools use. `lifecycleSeatManifestPublisher`
 * and `lifecycleScheduleChildReportWatchPrune` arrive as forwarders because
 * createServer reassigns both after these tools are registered.
 */
export interface SurfaceToolDeps {
  agentScopedSurfaceClose: symbol;
  appendCloseEvent: (event: Omit<CloseTelemetryEvent, "ts" | "event_type">) => void;
  assertSurfaceMutationAllowed: (toolName: string, surface: string, workspace?: string) => Promise<void>;
  assertWorkspaceMutationAllowed: (toolName: string, workspace?: string) => Promise<void>;
  canonicalWorkspaceRef: (candidate?: string) => Promise<string | undefined>;
  captureSurfaceIdentities: (surfaceIdByRef: ReadonlyMap<string, string>, observedEpoch: string | null) => void;
  client: CmuxLayerClient;
  collectSurfaceTopology: (workspace?: string) => Promise<SurfaceTopologySnapshot | null>;
  context: CmuxServerContext;
  currentSafetyCallerWorkspace: () => Promise<string | undefined>;
  findSurfaceByRef: (surfaceRef: string, workspace?: string, opts?: { throwOnError?: boolean }) => Promise<CmuxSurface | null>;
  findSurfaceRefByUuid: (topology: SurfaceTopologySnapshot, surfaceUuid: string) => string | null;
  lifecycleScheduleChildReportWatchPrune: (() => void) | null;
  lifecycleSeatManifestPublisher: (input: { agentId?: string; surfaceId?: string; surfaceUuid?: string; tabName?: string; model?: string }) => Promise<void>;
  listAllWorkspaces: (onRpc?: TopologyRpcObserver) => Promise<AllWindowWorkspaceEnumeration>;
  pruneChildReportWatchesFor: (agentId: string) => void;
  removeOwnedWatchesFor: (agentId: string, candidates: readonly WatchOwnerCandidate[]) => Promise<number>;
  resolveCloseCaller: (toolName: string) => string;
  resolveRawSurfaceMutationRoute: (requestedSurface: string, requestedWorkspace: string | undefined, operation: string, trustedAgentScopedClose?: boolean) => Promise<{ surface: string; workspace?: string; title: string | null; stableSurfaceIdentity: string | null; remapped_from?: string; remapped_to?: string; assertCurrent: () => Promise<void> }>;
  snapshotWatchOwnerCandidates: () => AgentRecord[];
  stateMgr: StateManager;
  toolHandlersByName: ToolHandlerRegistry;
  withSurfaceWrite: DeliveryEngine["withSurfaceWrite"];
}

// delete_workspace: formerly an internally dispatched MCP registration. Only the
// public tools call it now, directly; like the old by-name dispatch, the
// arguments are not re-parsed, so the shape below is the args type only.
const deleteWorkspaceArgsShape = z.object({
    workspace: z.string().describe("Target workspace ref"),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Delete even when the workspace backs a live agent or is the caller's workspace.",
      ),
  });
export type DeleteWorkspaceArgs = z.input<typeof deleteWorkspaceArgsShape>;

export async function deleteWorkspace(
  deps: SurfaceToolDeps,
  args: DeleteWorkspaceArgs,
): Promise<ToolReturn> {
  const { assertWorkspaceMutationAllowed, canonicalWorkspaceRef, client, currentSafetyCallerWorkspace, listAllWorkspaces, stateMgr } = deps;
  try {
    const targetWorkspace =
      (await canonicalWorkspaceRef(args.workspace)) ?? args.workspace;
    await assertWorkspaceMutationAllowed(
      "delete_workspace",
      targetWorkspace,
    );

    const [{ workspaces }, panes] = await Promise.all([
      listAllWorkspaces(),
      client.listPanes({ workspace: targetWorkspace }),
    ]);
    const paneGroups = await Promise.all(
      panes.panes.map((pane) =>
        client.listPaneSurfaces({
          workspace: targetWorkspace,
          pane: pane.ref,
        }),
      ),
    );
    const surfaces = paneGroups
      .flatMap((group) => group.surfaces)
      .filter(
        (surface, index, all) =>
          all.findIndex((candidate) => candidate.ref === surface.ref) ===
          index,
      );
    const surfaceRefs = new Set(surfaces.map((surface) => surface.ref));
    const agents = stateMgr
      .listStates()
      .filter(
        (agent) =>
          surfaceRefs.has(agent.surface_id) ||
          agent.workspace_id === targetWorkspace,
      );
    const liveAgents = agents.filter(
      (agent) => !TERMINAL_AGENT_STATES.has(agent.state),
    );
    const callerWorkspace = await currentSafetyCallerWorkspace();
    const deletingCallerWorkspace = callerWorkspace === targetWorkspace;

    if (!args.force && (deletingCallerWorkspace || liveAgents.length > 0)) {
      const reasons = [
        ...(deletingCallerWorkspace ? ["it is the caller workspace"] : []),
        ...(liveAgents.length > 0
          ? [`it backs ${liveAgents.length} live agent(s)`]
          : []),
      ];
      return err(
        new Error(
          `Refused to delete ${targetWorkspace}: ${reasons.join(" and ")}. Pass force:true to delete anyway.`,
        ),
        {
          refused: true,
          workspace: targetWorkspace,
          caller_workspace: deletingCallerWorkspace,
          surfaces,
          agents,
          live_agents: liveAgents,
        },
      );
    }

    await client.deleteWorkspace(targetWorkspace);
    const removedWorkspace = workspaces.find(
      (workspace) => workspace.ref === targetWorkspace,
    ) ?? {
      ref: targetWorkspace,
    };
    const data = {
      workspace: targetWorkspace,
      force: args.force ?? false,
      removed: {
        workspaces: [removedWorkspace],
        surfaces,
      },
    };
    return okFormatted(formatOk("delete_workspace", data), data);
  } catch (e) {
    return err(e);
  }
}

// move_surface: formerly an internally dispatched MCP registration. Only the
// public tools call it now, directly; like the old by-name dispatch, the
// arguments are not re-parsed, so the shape below is the args type only.
const moveSurfaceArgsShape = z.object({
    surface: z.string().describe("Surface ref to move"),
    pane: z.string().optional().describe("Target pane ref"),
    workspace: z.string().optional().describe("Target workspace ref"),
    before: z.string().optional().describe("Insert before this surface ref"),
    after: z.string().optional().describe("Insert after this surface ref"),
    index: z.number().int().optional().describe("Insert at this tab index"),
    focus: z
      .boolean()
      .optional()
      .describe("Whether to focus the moved surface"),
  });
export type MoveSurfaceArgs = z.input<typeof moveSurfaceArgsShape>;

export async function moveSurface(
  deps: SurfaceToolDeps,
  args: MoveSurfaceArgs,
): Promise<ToolReturn> {
  const { client, resolveRawSurfaceMutationRoute, withSurfaceWrite } = deps;
  try {
    const route = await resolveRawSurfaceMutationRoute(
      args.surface,
      undefined,
      "move_surface",
    );
    const result = await withSurfaceWrite(
      route.surface,
      async () => {
        await route.assertCurrent();
        return client.moveSurface({
          surface: route.surface,
          pane: args.pane,
          workspace: args.workspace,
          before: args.before,
          after: args.after,
          index: args.index,
          focus: args.focus,
        });
      },
      {
        toolName: "move_surface",
        workspace: route.workspace,
        stableSurfaceIdentity: route.stableSurfaceIdentity,
      },
    );
    // F8: slim, phone-readable confirmation — drop the verbose passthrough.
    const data = {
      surface: result.surface,
      pane: result.pane,
      workspace: result.workspace,
    };
    const dest = result.pane ?? result.workspace ?? "destination";
    return okFormatted(
      `✔ move_surface ─ moved ${result.surface} → ${dest}`,
      data,
    );
  } catch (e) {
    return err(e);
  }
}

// rename_tab: formerly an internally dispatched MCP registration. Only the
// public tools call it now, directly; like the old by-name dispatch, the
// arguments are not re-parsed, so the shape below is the args type only.
const renameTabArgsShape = z.object({
    surface: z.string().describe("Target surface ref"),
    title: z.string().describe("New tab title"),
    workspace: z.string().optional().describe("Target workspace ref"),
    preserve_prefix: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only replace the task suffix, keeping launcher prefix"),
  });
export type RenameTabArgs = z.input<typeof renameTabArgsShape>;

export async function renameTab(
  deps: SurfaceToolDeps,
  args: RenameTabArgs,
): Promise<ToolReturn> {
  const { client, lifecycleSeatManifestPublisher, resolveRawSurfaceMutationRoute, withSurfaceWrite } = deps;
  try {
    const route = await resolveRawSurfaceMutationRoute(
      args.surface,
      args.workspace,
      "rename_tab",
    );
    let finalTitle = args.title;
    if (args.preserve_prefix) {
      const surfaces = await client.listPaneSurfaces({
        workspace: route.workspace,
      });
      const surface = surfaces.surfaces.find(
        (s) => s.ref === route.surface,
      );
      const currentTitle = surface?.title ?? "";
      finalTitle = replaceTaskSuffix(currentTitle, args.title);
    }
    await withSurfaceWrite(
      route.surface,
      async () => {
        await route.assertCurrent();
        await client.renameTab(route.surface, finalTitle, {
          workspace: route.workspace,
        });
      },
      {
        toolName: "rename_tab",
        workspace: route.workspace,
        stableSurfaceIdentity: route.stableSurfaceIdentity,
      },
    );
    await lifecycleSeatManifestPublisher({
      surfaceId: route.surface,
      ...(route.stableSurfaceIdentity
        ? { surfaceUuid: route.stableSurfaceIdentity }
        : {}),
      tabName: finalTitle,
    });
    const data = { surface: route.surface, title: finalTitle };
    return okFormatted(formatOk("rename_tab", data), data);
  } catch (e) {
    return err(e);
  }
}

export function registerListSurfacesTool(
  server: McpServer,
  deps: SurfaceToolDeps,
): void {
  const { captureSurfaceIdentities, client, context, listAllWorkspaces } = deps;
  // 1. list_surfaces
  server.tool(
    "list_surfaces",
    "List workspace, pane, and surface topology. Condensed by default; verbose=true adds raw cmux fields.",
    {
      workspace: z.string().optional().describe("Filter by workspace ref"),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Return all raw cmux fields instead of the condensed default. This materially increases token usage and is rarely needed; use it only when a specific raw field is required.",
        ),
      include_screen_preview: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include screen content preview"),
      preview_lines: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(8)
        .describe("Number of preview lines"),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        const listingObserverEpoch = context.surfaceObserverEpoch;
        const workspaces = await listAllWorkspaces();
        const targetWorkspaceRefs = args.workspace
          ? [args.workspace]
          : workspaces.workspaces.map((workspace) => workspace.ref);
        const panesByWorkspace = await Promise.all(
          targetWorkspaceRefs.map(async (workspaceRef) => ({
            workspaceRef,
            panes: await client.listPanes({ workspace: workspaceRef }),
          })),
        );
        const workspaceCwdByRef = new Map<string, string>();
        for (const workspace of workspaces.workspaces) {
          const cwd = nonEmptyString(workspace.current_directory);
          if (cwd) {
            workspaceCwdByRef.set(workspace.ref, cwd);
          }
        }
        const paneByWorkspaceAndRef = new Map<
          string,
          Record<string, unknown>
        >();
        for (const { workspaceRef, panes } of panesByWorkspace) {
          for (const pane of panes.panes) {
            paneByWorkspaceAndRef.set(
              paneWorkingDirectoryKey(workspaceRef, pane.ref),
              pane as unknown as Record<string, unknown>,
            );
          }
        }
        const columnIndexByWorkspace = new Map<string, Map<string, number>>();
        const columnCountByWorkspace = new Map<string, number>();
        for (const { workspaceRef, panes } of panesByWorkspace) {
          const columnIndex = deriveColumnIndex(panes.panes);
          columnIndexByWorkspace.set(workspaceRef, columnIndex);
          columnCountByWorkspace.set(
            workspaceRef,
            new Set(columnIndex.values()).size,
          );
        }
        const surfaceGroupsByWorkspace = await Promise.all(
          panesByWorkspace.map(async ({ workspaceRef, panes }) => {
            const rawGroups = await Promise.all(
              panes.panes.map(async (pane) => {
                const group = await client.listPaneSurfaces({
                  workspace: workspaceRef,
                  pane: pane.ref,
                });
                return {
                  ...group,
                  workspace_ref: group.workspace_ref ?? workspaceRef,
                  pane_ref: group.pane_ref ?? pane.ref,
                };
              }),
            );
            return partitionPaneSurfacesByMembership(panes.panes, rawGroups, {
              workspace_ref: panes.workspace_ref ?? workspaceRef,
              window_ref: panes.window_ref,
            });
          }),
        );
        const surfaceGroups = surfaceGroupsByWorkspace.flat();
        const surfacesWithStableIds = enrichSurfaceIdsFromPanes(
          panesByWorkspace.map(({ workspaceRef, panes }) => ({
            ref: workspaceRef,
            panes,
          })),
          surfaceGroups,
        );
        const stableIdByRef = new Map(
          surfacesWithStableIds.flatMap((surface) =>
            surface.id ? [[surface.ref, surface.id] as const] : [],
          ),
        );
        captureSurfaceIdentities(stableIdByRef, listingObserverEpoch);
        const uniqueSurfaceEntries: Array<{
          group: {
            workspace_ref: string;
            window_ref: string;
            pane_ref: string;
            surfaces: CmuxSurface[];
          };
          surface: CmuxSurface;
        }> = [];
        const seenSurfaceRefs = new Set<string>();
        let anonymousSurfaceIndex = 0;

        for (const group of surfaceGroups) {
          for (const surface of group.surfaces) {
            const dedupeKey =
              typeof surface.ref === "string" && surface.ref.length > 0
                ? surface.ref
                : `${group.workspace_ref}:${group.pane_ref}:anonymous:${anonymousSurfaceIndex++}`;

            if (seenSurfaceRefs.has(dedupeKey)) {
              continue;
            }

            seenSurfaceRefs.add(dedupeKey);
            uniqueSurfaceEntries.push({ group, surface });
          }
        }

        const verboseSurfaces = await Promise.all(
          uniqueSurfaceEntries.map(async ({ group, surface }) => {
            const enrichedSurface: Record<string, unknown> = {
              ...surface,
              ...(surface.id || !stableIdByRef.has(surface.ref)
                ? {}
                : { id: stableIdByRef.get(surface.ref) }),
              workspace_ref: group.workspace_ref,
              window_ref: group.window_ref,
              pane_ref: group.pane_ref,
            };
            const column = columnIndexByWorkspace
              .get(group.workspace_ref)
              ?.get(group.pane_ref);
            if (typeof column === "number") {
              enrichedSurface.column = column;
            }

            if (args.include_screen_preview && surface.type === "terminal") {
              try {
                const preview = await client.readScreen(surface.ref, {
                  workspace: group.workspace_ref,
                  lines: args.preview_lines,
                });
                enrichedSurface.screen_preview = preview.text;
              } catch (error) {
                enrichedSurface.screen_preview_error =
                  error instanceof Error ? error.message : String(error);
              }
            }

            return enrichedSurface;
          }),
        );
        const terminalMetadata = await loadTerminalMetadataBySurface(client);
        const workingDirectoryMaps: SurfaceWorkingDirectoryMaps = {
          terminalBySurface: terminalMetadata.terminalBySurface,
          paneByWorkspaceAndRef,
          workspaceCwdByRef,
        };
        for (const surface of verboseSurfaces) {
          const workspaceRef = nonEmptyString(surface.workspace_ref) ?? "";
          const paneRef = nonEmptyString(surface.pane_ref) ?? "";
          applySurfaceWorkingDirectory(
            surface,
            workspaceRef,
            paneRef,
            workingDirectoryMaps,
          );
        }

        const verboseWorkspaces = workspaces.workspaces as unknown as Array<
          Record<string, unknown>
        >;
        const responseWorkspaces = args.verbose
          ? verboseWorkspaces
          : verboseWorkspaces.map((workspace) => toMinimalWorkspace(workspace));
        const responseSurfaces = args.verbose
          ? verboseSurfaces
          : verboseSurfaces.map((surface) => toMinimalSurface(surface));

        const data: Record<string, unknown> = {
          workspaces: responseWorkspaces,
          surfaces: responseSurfaces,
          column_count: targetWorkspaceRefs.reduce(
            (max, workspaceRef) =>
              Math.max(max, columnCountByWorkspace.get(workspaceRef) ?? 0),
            0,
          ),
        };
        if (args.workspace) {
          data.workspace_ref = args.workspace;
        }
        if (terminalMetadata.degraded) {
          data.metadata_degraded = terminalMetadata.degraded;
        }
        const formatted = formatListSurfaces(
          responseSurfaces as Array<{
            ref?: string;
            title?: string;
            type?: string;
            workspace_ref?: string;
            pane_ref?: string;
            screen_preview?: string;
          }>,
          responseWorkspaces as Array<{ ref: string; title?: string }>,
        );
        return okFormatted(formatted, data);
      } catch (e) {
        return err(e);
      }
    },
  );
}

export function registerUpdateSurfaceTool(
  server: McpServer,
  deps: SurfaceToolDeps,
): void {
  server.tool(
    "update_surface",
    "Move or rename one terminal surface.",
    {
      action: z.enum(["move", "rename"]),
      surface: z.string(),
      workspace: z.string().optional(),
      pane: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      index: z.number().int().optional(),
      focus: z.boolean().optional(),
      title: z.string().optional(),
      preserve_prefix: z.boolean().optional().default(false),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        if (args.action === "rename" && !args.title) {
          throw new Error("update_surface action=rename requires title");
        }
        // Direct calls replace the by-name hop; each runs in its own
        // transport-retry scope, as the dispatched handler did.
        const title = args.title ?? "";
        const result = await withTransportRetryTracking(() =>
          args.action === "move"
            ? moveSurface(deps, {
                surface: args.surface,
                workspace: args.workspace,
                pane: args.pane,
                before: args.before,
                after: args.after,
                index: args.index,
                focus: args.focus,
              })
            : renameTab(deps, {
                surface: args.surface,
                workspace: args.workspace,
                title,
                preserve_prefix: args.preserve_prefix,
              }),
        );
        const structured = result.structuredContent ?? {};
        return {
          ...result,
          structuredContent: { ...structured, action: args.action },
        };
      } catch (error) {
        return err(error);
      }
    },
  );
}

export function registerCloseSurfaceTool(
  server: McpServer,
  deps: SurfaceToolDeps,
): void {
  const { agentScopedSurfaceClose, appendCloseEvent, assertSurfaceMutationAllowed, client, collectSurfaceTopology, context, findSurfaceByRef, findSurfaceRefByUuid, lifecycleScheduleChildReportWatchPrune, pruneChildReportWatchesFor, removeOwnedWatchesFor, resolveCloseCaller, resolveRawSurfaceMutationRoute, snapshotWatchOwnerCandidates, stateMgr, toolHandlersByName, withSurfaceWrite } = deps;
  // 10. close_surface
  server.tool(
    "close_surface",
    'Close one surface, managed agent, or workspace with live-agent guards. scope="agent" stops the agent AND closes its pane, and reports the two halves separately (agent_stopped, surface_closed) so a pane that survives is never reported as closed. The pane close obeys the same live-agent guard as scope="surface": without force:true a still-live agent keeps its pane, and the receipt says so.',
    {
      scope: z
        .enum(["surface", "agent", "workspace"])
        .optional()
        .default("surface"),
      surface: z.string().optional().describe("Target surface ref"),
      agent_id: z.string().optional().describe("Managed agent ID"),
      workspace: z.string().optional().describe("Target workspace ref"),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Close even when the backing agent is still live (not done/error). This never bypasses stable surface identity checks. Without force, a live agent's surface is protected and the response returns the current pane contents instead of closing.",
        ),
    },
    ANNOTATIONS.destructive,
    async (args) => {
      try {
        if (args.scope === "agent") {
          if (!args.agent_id) {
            throw new Error("close_surface scope=agent requires agent_id");
          }
          const handler = toolHandlersByName.get("stop_agent");
          if (!handler)
            throw new Error("Internal agent close adapter unavailable");
          // AIDEV-NOTE (#485): this used to stop the agent and hand back
          // stop_agent's receipt verbatim -- ok:true, state:"done" -- for a
          // tool named close_surface, while the pane stayed open. A lead
          // harvesting panes got success and kept every one of them. Resolve
          // the bound surface BEFORE stopping (the stop can evict the record),
          // stop, then close the pane for real and say which halves happened.
          const boundAgent =
            context.lifecycleRegistry?.get(args.agent_id) ?? null;
          // Capture alias evidence before stop_agent can evict the terminal
          // record. Cleanup receives a stable resolution universe.
          const watchOwnerCandidates = snapshotWatchOwnerCandidates();
          const boundSurface = boundAgent?.surface_id?.trim() || null;
          const boundWorkspace = boundAgent?.workspace_id ?? undefined;
          if (
            !args.force &&
            boundAgent &&
            !TERMINAL_AGENT_STATES.has(boundAgent.state) &&
            agentProcessMayBeAlive(boundAgent)
          ) {
            return err(
              new Error(
                `close_surface scope=agent refused — agent ${args.agent_id} still has live recorded pid ${boundAgent?.pid}`,
              ),
              {
                refused: true,
                scope: "agent",
                agent_id: args.agent_id,
                pid: boundAgent?.pid,
                agent_stopped: false,
                surface: boundSurface,
                surface_closed: false,
                surface_close_skipped: "live_process",
                WARNING: `Live process ${boundAgent?.pid} was not stopped and its surface was not closed; pass force:true for deliberate teardown.`,
              },
            );
          }
          const lifecycleEngine = context.lifecycleSweepEngine;
          if (!lifecycleEngine) {
            throw new Error("Agent lifecycle engine is unavailable");
          }
          const result = await lifecycleEngine.runLifecycleMutation(
            () =>
              handler(
                {
                  agent_id: args.agent_id,
                  force: args.force,
                  [OWNED_AGENT_CLOSE_ON_UNKNOWN_PID]: args.force === true,
                },
                {},
              ),
            { label: "close-agent" },
          );
          const agentStopped = result.isError !== true;
          const rawStopContent = (result.structuredContent ?? {}) as Record<
            string,
            unknown
          >;
          // Drop the stop receipt's own envelope fields; this response owns
          // ok/error, and letting stop_agent's ok:true through was exactly how
          // a half-done close reported success.
          const {
            ok: _stopOk,
            error: _stopError,
            ...stopContent
          } = rawStopContent;
          if (!agentStopped) {
            // The stop itself failed: keep its verbatim ok:false/error and add
            // the independently observed surface half. Stop may have closed
            // the exact UUID route before its process post-condition failed.
            const reason =
              typeof rawStopContent.error === "string"
                ? rawStopContent.error
                : "Agent stop could not establish a safe terminal I/O route";
            const boundUuid = boundAgent?.surface_uuid;
            const topology = boundUuid
              ? await collectSurfaceTopology().catch(() => null)
              : null;
            const surfaceClosed = Boolean(
              boundUuid &&
                topology?.complete === true &&
                !findSurfaceRefByUuid(topology, boundUuid),
            );
            const remedy = surfaceClosed
              ? "The exact surface is gone, but the recorded PID was not proven stopped. Verify that PID before clearing the agent."
              : "Refresh live topology with list_agents, verify the agent's current surface, then retry close_surface with force:true.";
            return err(
              new Error(`close_surface scope=agent refused: ${reason}`),
              {
                ...rawStopContent,
                scope: "agent",
                agent_stopped: false,
                surface: boundSurface,
                surface_closed: surfaceClosed,
                ...(!surfaceClosed
                  ? { surface_close_skipped: "agent_stop_failed" }
                  : {}),
                reason,
                remedy,
                WARNING: remedy,
              },
            );
          }
          let removedOwnedWatches: number;
          try {
            removedOwnedWatches = await removeOwnedWatchesFor(
              boundAgent?.agent_id ?? args.agent_id,
              watchOwnerCandidates,
            );
          } catch (cleanupError) {
            lifecycleScheduleChildReportWatchPrune?.();
            const cleanupReason =
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError);
            let surfaceClosed = false;
            if (boundSurface) {
              try {
                surfaceClosed =
                  (await findSurfaceByRef(boundSurface, boundWorkspace)) ===
                  null;
              } catch {
                surfaceClosed = false;
              }
            }
            return err(
              new Error(
                `close_surface scope=agent stopped ${args.agent_id}, but synchronous owned-watch cleanup failed: ${cleanupReason}`,
              ),
              {
                ...stopContent,
                scope: "agent",
                agent_stopped: true,
                surface: boundSurface,
                surface_closed: surfaceClosed,
                watch_cleanup: "failed",
                watch_cleanup_error: cleanupReason,
              },
            );
          }
          const watchCleanup = {
            watch_cleanup: "completed" as const,
            watches_removed: removedOwnedWatches,
          };
          if (!boundSurface) {
            const data = {
              ...stopContent,
              ...watchCleanup,
              scope: "agent",
              agent_stopped: true,
              surface_closed: false,
              surface_close_skipped: "no_surface_bound",
            };
            return okFormatted(
              `close_surface scope=agent — agent ${args.agent_id} stopped; no surface was bound, so no pane was closed`,
              data,
            );
          }
          // stop_agent owns teardown for a nonterminal agent and may already
          // have closed the exact bound surface. Do not run a second raw close
          // through a now-stale UUID/ref and turn an observed success into a
          // stale-route failure. Terminal agents take the path below because
          // stop_agent is then a no-op and their pane still needs closing.
          let boundSurfaceAfterStop: CmuxSurface | null;
          try {
            boundSurfaceAfterStop = await findSurfaceByRef(
              boundSurface,
              boundWorkspace,
              { throwOnError: true },
            );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            return err(
              new Error(
                `close_surface scope=agent: agent ${args.agent_id} was stopped ` +
                  `but surface ${boundSurface} closure could not be verified — ${reason}`,
              ),
              {
                ...stopContent,
                ...watchCleanup,
                scope: "agent",
                agent_stopped: true,
                surface: boundSurface,
                surface_closed: false,
                surface_close_error: reason,
              },
            );
          }
          if (boundSurfaceAfterStop === null) {
            const data = {
              ...stopContent,
              ...watchCleanup,
              scope: "agent",
              agent_stopped: true,
              surface: boundSurface,
              surface_closed: true,
            };
            return okFormatted(
              `close_surface scope=agent — agent ${args.agent_id} stopped and surface ${boundSurface} closed`,
              data,
            );
          }
          const closeHandler = toolHandlersByName.get("close_surface");
          if (!closeHandler) {
            throw new Error("Internal surface close adapter unavailable");
          }
          const closeResult = await closeHandler(
            {
              scope: "surface",
              surface: boundSurface,
              workspace: boundWorkspace,
              // Preserve the surface path's cross-record guard. The outer
              // process check protects this record; it does not authorize
              // tearing down a surface another nonterminal record owns.
              force: args.force ?? false,
              // A managed agent ID was resolved before stop_agent. This
              // internal-only symbol allows its ref-only close when no stable
              // identity exists; raw callers cannot supply it through MCP.
              [agentScopedSurfaceClose]: true,
            },
            {},
          );
          const closeContent = (closeResult.structuredContent ?? {}) as Record<
            string,
            unknown
          >;
          if (closeResult.isError === true) {
            const reason =
              typeof closeContent.error === "string"
                ? closeContent.error
                : "close failed";
            return err(
              new Error(
                `close_surface scope=agent: agent ${args.agent_id} was stopped but surface ${boundSurface} is still open — ${reason}`,
              ),
              {
                ...stopContent,
                ...watchCleanup,
                scope: "agent",
                agent_stopped: true,
                surface: boundSurface,
                surface_closed: false,
                surface_close_error: reason,
              },
            );
          }
          // Forward the surface path's OBSERVATION of whether the pane is
          // gone; never restate a returned call as a completed close.
          const surfaceClosed = closeContent.surface_closed === true;
          const data = {
            ...stopContent,
            ...watchCleanup,
            scope: "agent",
            agent_stopped: true,
            surface: boundSurface,
            surface_closed: surfaceClosed,
            ...(closeContent.WARNING ? { WARNING: closeContent.WARNING } : {}),
            ...(closeContent.collapse_pane !== undefined
              ? { collapse_pane: closeContent.collapse_pane }
              : {}),
          };
          return okFormatted(
            surfaceClosed
              ? `close_surface scope=agent — agent ${args.agent_id} stopped and surface ${boundSurface} closed`
              : `close_surface scope=agent — agent ${args.agent_id} stopped, but surface ${boundSurface} is STILL LISTED — not closed`,
            data,
          );
        }
        if (args.scope === "workspace") {
          if (!args.workspace) {
            throw new Error("close_surface scope=workspace requires workspace");
          }
          const workspace = args.workspace;
          const result = await withTransportRetryTracking(() =>
            deleteWorkspace(deps, { workspace, force: args.force }),
          );
          // Cross-check for the #485 class: unlike scope=agent, this delegate
          // really does perform the action the scope names -- delete_workspace
          // tears the tab and its panes down and surfaces its own failures.
          // State the outcome explicitly rather than leaving the caller to
          // infer it from a bolted-on scope field.
          return {
            ...result,
            structuredContent: {
              ...(result.structuredContent ?? {}),
              scope: "workspace",
              workspace_deleted: result.isError !== true,
            },
          };
        }
        if (!args.surface) {
          throw new Error("close_surface scope=surface requires surface");
        }
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "close_surface",
          (args as Record<PropertyKey, unknown>)[agentScopedSurfaceClose] === true,
        );
        await assertSurfaceMutationAllowed(
          "close_surface",
          route.surface,
          route.workspace,
        );
        await route.assertCurrent();
        let staleRegistryDoneConsolidated:
          | {
              agent_id: string;
              previous_state: AgentState;
              done_signal: string;
            }
          | undefined;
        // Liveness guard: never destroy a pane whose agent is still live unless
        // the caller explicitly forces it. This is the safety net for the
        // "stale list said it was gone but it was actually alive" failure — on
        // refusal we hand back a fresh pane read so the caller assesses the
        // real screen, not a possibly-stale state record.
        if (!args.force) {
          // Fail-safe across records: a surface can transiently back more than
          // one state record (crash-resume collisions before canonicalization).
          // Match the first record that is still LIVE rather than an arbitrary
          // first hit, so a stale terminal record can never let us tear down a
          // surface that another, live record still owns.
          const backingAgent = stateMgr
            .listStates()
            .find(
              (record) =>
                (route.stableSurfaceIdentity && record.surface_uuid
                  ? record.surface_uuid.toLowerCase() ===
                    route.stableSurfaceIdentity.toLowerCase()
                  : record.surface_id === route.surface) &&
                !TERMINAL_AGENT_STATES.has(record.state),
            );
          if (backingAgent) {
            let screenText = "(unable to read pane)";
            let screenParsed: ReturnType<typeof parseScreen> | null = null;
            try {
              const screen = await client.readScreen(route.surface, {
                workspace: route.workspace,
                lines: 40,
              });
              screenText = screen.text;
              screenParsed = parseScreen(screen.text);
            } catch {
              // Best-effort read; refuse regardless so a live agent is never
              // torn down without an explicit force.
            }
            if (
              screenParsed?.done_signal &&
              !screenHasActiveAgentMarker(
                backingAgent.cli,
                screenText,
                screenParsed,
              )
            ) {
              try {
                const marked = stateMgr.updateRecord(backingAgent.agent_id, {
                  task_done_candidate_at: null,
                  task_done_detected_at: new Date().toISOString(),
                  ...(backingAgent.boot_prompt_pending
                    ? { boot_prompt_pending: false }
                    : {}),
                });
                context.lifecycleRegistry?.set(backingAgent.agent_id, marked);
                const done = stateMgr.transition(backingAgent.agent_id, "done");
                context.lifecycleRegistry?.set(backingAgent.agent_id, done);
                staleRegistryDoneConsolidated = {
                  agent_id: backingAgent.agent_id,
                  previous_state: backingAgent.state,
                  done_signal: screenParsed.done_signal,
                };
              } catch {
                // If consolidation fails, keep the fail-safe refusal path.
                appendCloseEvent({
                  event: "close_surface",
                  target: `${route.surface} (agent ${backingAgent.agent_id})`,
                  caller: resolveCloseCaller("close_surface"),
                  force: args.force ?? false,
                  reason: `refused: agent still live (${backingAgent.state}), registry consolidation failed`,
                  refused: true,
                });
                return err(
                  new Error(
                    `Refused to close ${route.surface}: agent ${backingAgent.agent_id} is "${backingAgent.state}" (still live) and registry consolidation failed. Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                  ),
                  {
                    refused: true,
                    surface: route.surface,
                    agent_id: backingAgent.agent_id,
                    state: backingAgent.state,
                    screen: screenText,
                    parsed: screenParsed,
                  },
                );
              }
              const remainingLiveAgent = stateMgr
                .listStates()
                .find(
                  (record) =>
                    (route.stableSurfaceIdentity && record.surface_uuid
                      ? record.surface_uuid.toLowerCase() ===
                        route.stableSurfaceIdentity.toLowerCase()
                      : record.surface_id === route.surface) &&
                    !TERMINAL_AGENT_STATES.has(record.state),
                );
              if (remainingLiveAgent) {
                appendCloseEvent({
                  event: "close_surface",
                  target: `${route.surface} (agent ${remainingLiveAgent.agent_id})`,
                  caller: resolveCloseCaller("close_surface"),
                  force: args.force ?? false,
                  reason: `refused: agent still live (${remainingLiveAgent.state}) after stale registry consolidation`,
                  refused: true,
                });
                return err(
                  new Error(
                    `Refused to close ${route.surface}: agent ${remainingLiveAgent.agent_id} is "${remainingLiveAgent.state}" (still live) after stale registry consolidation. Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                  ),
                  {
                    refused: true,
                    surface: route.surface,
                    agent_id: remainingLiveAgent.agent_id,
                    state: remainingLiveAgent.state,
                    screen: screenText,
                    parsed: screenParsed,
                    stale_registry_done_consolidated:
                      staleRegistryDoneConsolidated,
                  },
                );
              }
            } else {
              appendCloseEvent({
                event: "close_surface",
                target: `${route.surface} (agent ${backingAgent.agent_id})`,
                caller: resolveCloseCaller("close_surface"),
                force: args.force ?? false,
                reason: `refused: agent still live (${backingAgent.state})`,
                refused: true,
              });
              return err(
                new Error(
                  `Refused to close ${route.surface}: agent ${backingAgent.agent_id} is "${backingAgent.state}" (still live). Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                ),
                {
                  refused: true,
                  surface: route.surface,
                  agent_id: backingAgent.agent_id,
                  state: backingAgent.state,
                  screen: screenText,
                  parsed: screenParsed,
                },
              );
            }
          }
        }

        let closePolicy:
          ReturnType<typeof chooseSurfaceClosePolicy> | undefined;

        try {
          const identified = route.workspace
            ? null
            : await client.identify(route.surface);
          const workspace =
            route.workspace ??
            identified?.caller?.workspace_ref ??
            identified?.focused?.workspace_ref;
          if (workspace) {
            const panes = await client.listPanes({ workspace });
            const rawPaneSurfaces = await Promise.all(
              panes.panes.map(async (pane) => {
                const ps = await client.listPaneSurfaces({
                  workspace,
                  pane: pane.ref,
                });
                return ps.pane_ref ? ps : { ...ps, pane_ref: pane.ref };
              }),
            );
            const paneSurfaces = partitionPaneSurfacesByMembership(
              panes.panes,
              rawPaneSurfaces,
              {
                workspace_ref: panes.workspace_ref ?? workspace,
                window_ref: panes.window_ref,
              },
            );
            const workerSurfaceIds = new Set(
              stateMgr.listStates().map((record) => record.surface_id),
            );
            closePolicy = chooseSurfaceClosePolicy(
              panes.panes,
              paneSurfaces,
              workerSurfaceIds,
              route.surface,
            );
          }
        } catch {
          // Layout hints are best-effort only; the close itself must still run.
        }

        const collapsePane = closePolicy?.collapsePane ?? false;
        const observedSurface = await findSurfaceByRef(
          route.surface,
          route.workspace,
        );
        const requestedSurfaceKey =
          route.stableSurfaceIdentity?.toLowerCase() ??
          route.surface.toLowerCase();
        const observedSurfaceUuid = observedSurface?.id?.toLowerCase();
        await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            await client.closeSurface(route.surface, {
              workspace: route.workspace,
              collapsePane,
            });
          },
          {
            toolName: "close_surface",
            workspace: route.workspace,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
        // AIDEV-NOTE (#485): confirm the pane is actually gone rather than
        // inferring it from the CLI returning. One observation, no waiting --
        // the "eventually consistent" theory was withdrawn once the mechanism
        // turned out to be the scope argument, so there is no window to sit
        // through. If cmux still lists the surface, the receipt says so.
        const surfaceStillPresent =
          (await findSurfaceByRef(route.surface, route.workspace)) !== null;
        for (const record of stateMgr.listStates()) {
          // Stable identity wins whenever cmux exposes it. On a ref-only or
          // unavailable observation, preserve the explicit close intent by
          // falling back to the mutable ref instead of treating it as a crash.
          const matchesClosedSurface = record.surface_uuid
            ? record.surface_uuid.toLowerCase() === requestedSurfaceKey ||
              record.surface_uuid.toLowerCase() === observedSurfaceUuid ||
              (observedSurfaceUuid === undefined &&
                record.surface_id === route.surface)
            : observedSurfaceUuid === undefined &&
              record.surface_id === route.surface;
          if (!matchesClosedSurface) {
            continue;
          }
          try {
            const terminal = stateMgr.updateRecord(record.agent_id, {
              user_killed: true,
            });
            context.lifecycleRegistry?.set(record.agent_id, terminal);
            // AIDEV-NOTE (#485 reframe): marking user_killed left the RECORD's
            // state untouched, so list_agents kept reporting a closed agent as
            // "working" after its close was acknowledged -- reported live by
            // golemsClaude, and independent of which scope was used.
            // An acknowledged close means this agent is not running any more;
            // say so in the same breath as accepting the close.
            if (!TERMINAL_AGENT_STATES.has(terminal.state)) {
              const stopped = stateMgr.transition(record.agent_id, "done");
              context.lifecycleRegistry?.set(record.agent_id, stopped);
            }
            pruneChildReportWatchesFor(record.agent_id);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === `Agent not found: ${record.agent_id}`
            ) {
              continue;
            }
            throw error;
          }
        }
        appendCloseEvent({
          event: "close_surface",
          target: route.surface,
          caller: resolveCloseCaller("close_surface"),
          force: args.force ?? false,
          reason: staleRegistryDoneConsolidated
            ? `closed after stale-registry done consolidation (agent ${staleRegistryDoneConsolidated.agent_id})`
            : null,
          refused: false,
        });
        const data = {
          surface: route.surface,
          pane: closePolicy?.pane ?? undefined,
          collapse_pane: collapsePane,
          surface_closed: !surfaceStillPresent,
          stale_registry_done_consolidated: staleRegistryDoneConsolidated,
          ...(surfaceStillPresent
            ? {
                WARNING: `cmux accepted the close but ${route.surface} is STILL listed. Do not relay this as closed.`,
              }
            : {}),
        };
        return okFormatted(
          surfaceStillPresent
            ? `close_surface accepted — ${route.surface} is still listed; NOT closed`
            : formatOk("close_surface", data),
          data,
        );
      } catch (e) {
        return err(e);
      }
    },
  );
}
