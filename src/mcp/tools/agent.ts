// Agent-lifecycle MCP wiring moved out of createServer's closure (CX-3b S10a):
// the AgentEngine construction with its host callbacks, list_agents and
// report_to_parent. Bodies are verbatim; captured closure state arrives as the
// *Deps interfaces below.

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getTransportHealth } from "../../cmux-transport-self-heal.js";
import { createDefaultCloseForensicsRunner } from "../../close-forensics.js";
import { SURFACE_EVICTION_CONFIRMATION_MS } from "../../agent-registry.js";
import { AgentEngine } from "../../agent-engine.js";
import { type ClosureState } from "../../coordination-paths.js";
import { defaultDeliveryTicketDir, fileDeliveryFailureGithubIssue } from "../../delivery-failure-tickets.js";
import {
  canonicalAgentId,
  resolveWatchOwnerFromSources,
  watchNotificationOwner,
  watchOwnerIncludesCanonical,
} from "../../watch-owner.js";
import { SurfaceBindingChangedDuringDiscoveryError, type DiscoveredAgent } from "../../agent-discovery.js";
import {
  isLiveDeliverable,
  resolveLiveAgentState,
  type LiveAgentState,
} from "../../live-agent-state.js";
import { toAgentStatePayload, toObservedPublicAgent } from "../../agent-facade.js";
import { type AgentHealth } from "../../agent-health.js";
import type {
  AgentRecord,
  ObservedPublicAgent,
  AgentRole,
  CliType,
} from "../../agent-types.js";
import { isDeliberateCloseTombstone, isFailedSpawnTombstone } from "../../agent-types.js";
import { formatListAgents } from "../../format.js";
import { dispatch } from "../../inbox.js";
import { inferRecordRoleOrNull } from "../../layout-policy.js";
import {
  invalidateSurfaceTopologyCallScope,
  healthTopologyOverrides,
  type SurfaceTopologySnapshot,
} from "../../surface-topology.js";
import { ANNOTATIONS } from "../schemas.js";
import { okFormatted, err } from "../tool-result.js";
import { isSurfaceEnumerationError } from "../../surface-enumeration-error.js";
import type { AgentDiscovery } from "../../agent-discovery.js";
import type { AgentHealthInputOverrides } from "../../agent-health-input.js";
import type {
  AgentHealthIssueCode,
  AgentHealthIssueSeverity,
  AgentHealthStatus,
} from "../../agent-health.js";
import type { AgentRegistry } from "../../agent-registry.js";
import type { AgentState, CloseTelemetryEvent } from "../../agent-types.js";
import type { AllWindowWorkspaceEnumeration, TopologyRpcObserver } from "../../surface-topology.js";
import type {
  CmuxServerContext,
  CreateServerOptions,
  LifecycleAgentInputDeliverer,
} from "../context.js";
import type {
  CmuxSurface,
  ParsedControlPlaneState,
  ParsedScreenAgentType,
  ParsedScreenStatus,
} from "../../types.js";
import type { DeliveryEngine } from "../../delivery/engine.js";
import type { InboxOpts } from "../../inbox.js";
import type { RoleSurfaceIds } from "../../layout-policy.js";
import type { SeatRegistry } from "../../seat-identity.js";
import type { SpawnAgentParams } from "../../engine/types.js";
import type { StateManager } from "../../state-manager.js";
import type { SurfaceBindingObservation } from "../../surface-binding-observation.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const DUPLICATE_WATCH_OWNER_RANK = {
  INTERACTIVE: 0,
  ACTIVE: 1,
  OBSERVED_INTERACTIVE: 2,
  TERMINAL: 3,
  DEGRADED_DELIVERABLE: 4,
  STARTING_OR_INDIRECT: 5,
  ERROR: 6,
  UNKNOWN: 7,
} as const;

export const DUPLICATE_WATCH_OWNER_STATES = new Set([
  "creating",
  "booting",
  "ready",
  "working",
  "idle",
  "done",
  "error",
]);

/**
 * Total order for duplicate report-watch owners. Lower ranks win.
 *
 * 0 interactive and deliverable; 1 direct screen activity; 2 directly
 * observed interactive but not ordinarily deliverable; 3 terminal but still
 * attemptable; 4 degraded/error-screened but deliverable; 5 starting or only
 * indirectly live; 6 known error; 7 missing or unenumerated evidence.
 *
 * Screen evidence is mapped positively: error is degraded, working is active,
 * done is terminal, ready/idle is interactive, and creating/booting is
 * starting. No unenumerated state can enter a preferred rank; it receives the
 * explicit worst-attemptable rank instead.
 */
export function rankDuplicateWatchOwnerCandidate(
  live: LiveAgentState | null,
): number {
  if (live === null) return DUPLICATE_WATCH_OWNER_RANK.UNKNOWN;
  if (
    !DUPLICATE_WATCH_OWNER_STATES.has(live.state) ||
    (live.screen_state !== null &&
      !DUPLICATE_WATCH_OWNER_STATES.has(live.screen_state)) ||
    (live.source !== "screen" && live.source !== "registry")
  ) {
    return DUPLICATE_WATCH_OWNER_RANK.UNKNOWN;
  }

  const deliverable = isLiveDeliverable(live);
  switch (live.screen_state) {
    case "error":
      return deliverable
        ? DUPLICATE_WATCH_OWNER_RANK.DEGRADED_DELIVERABLE
        : DUPLICATE_WATCH_OWNER_RANK.ERROR;
    case "working":
      if (live.source === "screen") {
        return DUPLICATE_WATCH_OWNER_RANK.ACTIVE;
      }
      break;
    case "done":
      return DUPLICATE_WATCH_OWNER_RANK.TERMINAL;
    case "creating":
    case "booting":
      return DUPLICATE_WATCH_OWNER_RANK.STARTING_OR_INDIRECT;
    case "ready":
    case "idle":
    case null:
      break;
  }

  switch (live.state) {
    case "ready":
    case "idle":
      if (deliverable) return DUPLICATE_WATCH_OWNER_RANK.INTERACTIVE;
      if (
        live.source === "screen" &&
        (live.screen_state === "ready" || live.screen_state === "idle")
      ) {
        return DUPLICATE_WATCH_OWNER_RANK.OBSERVED_INTERACTIVE;
      }
      return DUPLICATE_WATCH_OWNER_RANK.STARTING_OR_INDIRECT;
    case "working":
      return deliverable
        ? DUPLICATE_WATCH_OWNER_RANK.DEGRADED_DELIVERABLE
        : DUPLICATE_WATCH_OWNER_RANK.STARTING_OR_INDIRECT;
    case "done":
      return deliverable
        ? DUPLICATE_WATCH_OWNER_RANK.OBSERVED_INTERACTIVE
        : DUPLICATE_WATCH_OWNER_RANK.UNKNOWN;
    case "creating":
    case "booting":
      return deliverable
        ? DUPLICATE_WATCH_OWNER_RANK.DEGRADED_DELIVERABLE
        : DUPLICATE_WATCH_OWNER_RANK.STARTING_OR_INDIRECT;
    case "error":
      return deliverable
        ? DUPLICATE_WATCH_OWNER_RANK.DEGRADED_DELIVERABLE
        : DUPLICATE_WATCH_OWNER_RANK.ERROR;
  }
}

export function selectDuplicateWatchOwnerCandidate<T>(
  probed: readonly { candidate: T; live: LiveAgentState | null }[],
): T | undefined {
  let best = probed[0];
  let bestRank = rankDuplicateWatchOwnerCandidate(best?.live ?? null);
  for (const entry of probed.slice(1)) {
    const rank = rankDuplicateWatchOwnerCandidate(entry.live);
    if (rank < bestRank) {
      best = entry;
      bestRank = rank;
    }
  }
  return best?.candidate;
}

export type ServerAgentHealthEvaluator = (agent: AgentRecord, overrides?: AgentHealthInputOverrides, topologyOverride?: SurfaceTopologySnapshot | null) => Promise<{ screen_observation?: { observed_at_ms: number; status: ParsedScreenStatus; agent_type: ParsedScreenAgentType; control_state: ParsedControlPlaneState; model: string | null; } | undefined; status: AgentHealthStatus; issue_codes: AgentHealthIssueCode[]; issues: string[]; issue_severities?: Partial<Record<AgentHealthIssueCode, AgentHealthIssueSeverity>>; reconciled_state?: AgentState; screen_confirmed_state?: AgentState; recommended_actions?: string[]; }>;

export interface LifecycleAgentEngineDeps {
  appendCloseEvent: (event: Omit<CloseTelemetryEvent, "ts" | "event_type">) => void;
  assertSurfaceMutationAllowed: (toolName: string, surface: string, workspace?: string) => Promise<void>;
  assertWorkspaceMutationAllowed: (toolName: string, workspace?: string) => Promise<void>;
  client: CmuxServerContext["client"];
  collectServerRoleSurfaceIds: (liveSurfaceIds?: ReadonlySet<string>, workspace?: string, observation?: SurfaceBindingObservation) => RoleSurfaceIds;
  context: CmuxServerContext;
  disableSpawnPreflight: boolean | undefined;
  freshLiveAgentStateProbe: (agent: AgentRecord) => Promise<LiveAgentState | null>;
  inboxOpts: InboxOpts;
  launchShellRecoveryBySurface: Map<string, { recovered: true; cleared: string[]; }>;
  /** Live: createServer assigns its deliverer after the engine exists. */
  readonly lifecycleAgentInputDeliverer: LifecycleAgentInputDeliverer | null;
  listAllWorkspaces: (onRpc?: TopologyRpcObserver) => Promise<AllWindowWorkspaceEnumeration>;
  opts: CreateServerOptions | undefined;
  originalLaunchCommandsBySurface: Map<string, string>;
  registry: AgentRegistry;
  seatRegistry: SeatRegistry | null;
  sendLauncherCommandToSurface: DeliveryEngine["sendLauncherCommandToSurface"];
  spawnPreflight: ((params: SpawnAgentParams) => Promise<void>) | undefined;
  stateMgr: StateManager;
  surfaceProvider: (onRpc?: TopologyRpcObserver) => Promise<CmuxSurface[]>;
  testProcess: boolean;
  watchRegistryPath: string;
  withSurfaceWrite: DeliveryEngine["withSurfaceWrite"];
}

export function createLifecycleAgentEngine(deps: LifecycleAgentEngineDeps): AgentEngine {
  const {
    appendCloseEvent,
    assertSurfaceMutationAllowed,
    assertWorkspaceMutationAllowed,
    client,
    collectServerRoleSurfaceIds,
    context,
    disableSpawnPreflight,
    freshLiveAgentStateProbe,
    inboxOpts,
    launchShellRecoveryBySurface,
    listAllWorkspaces,
    opts,
    originalLaunchCommandsBySurface,
    registry,
    seatRegistry,
    sendLauncherCommandToSurface,
    spawnPreflight,
    stateMgr,
    surfaceProvider,
    testProcess,
    watchRegistryPath,
    withSurfaceWrite,
  } = deps;
  const engine =
    context.lifecycleSweepEngine ??
    new AgentEngine(
      stateMgr,
      registry,
      {
        getTransportHealth: () => getTransportHealth(client),
        supportsStableSurfaceReads: true,
        log: (message, eventOpts) => client.log(message, eventOpts),
        ...(typeof client.listWindows === "function"
          ? { listWindows: () => client.listWindows() }
          : {}),
        listAllWorkspaces,
        supportsSurfaceRuntimeMetadata: typeof client.listSurfaceRuntimeMetadata === "function",
        listTerminalMetadata: client.listSurfaceRuntimeMetadata
          ? () => client.listSurfaceRuntimeMetadata!()
          : typeof client.listTerminalMetadata === "function"
            ? () => client.listTerminalMetadata()
            : undefined,
        listWorkspaces: (workspaceOpts) =>
          client.listWorkspaces(workspaceOpts),
        setStatus: (key, value, statusOpts) =>
          client.setStatus(key, value, statusOpts),
        setStatuses: async (updates) => {
          if (typeof client.setStatuses === "function") {
            return client.setStatuses(updates);
          }
          for (const update of updates) {
            await client.setStatus(update.key, update.value, update);
          }
          return true;
        },
        clearStatus: (key, clearOpts) => client.clearStatus(key, clearOpts),
        readScreen: (surface, readOpts) =>
          client.readScreen(surface, readOpts),
        send: (surface, text, sendOpts) => {
          const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
            sendOpts ?? {};
          return withSurfaceWrite(
            surface,
            async () => {
              await beforeMutation?.();
              return client.send(surface, text, clientOpts);
            },
            {
              toolName: "agent_engine",
              workspace: sendOpts?.workspace,
              observePtyWrite: true,
              stableSurfaceIdentity,
            },
          );
        },
        sendKey: (surface, key, keyOpts) => {
          const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
            keyOpts ?? {};
          return withSurfaceWrite(
            surface,
            async () => {
              await beforeMutation?.();
              return client.sendKey(surface, key, clientOpts);
            },
            {
              toolName: "send_key",
              workspace: keyOpts?.workspace,
              observePtyWrite: true,
              stableSurfaceIdentity,
            },
          );
        },
        setProgress: (value, progressOpts) =>
          client.setProgress(value, progressOpts),
        clearProgress: (progressOpts) => client.clearProgress(progressOpts),
        newSplit: async (direction, splitOpts) => {
          const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
            splitOpts ?? {};
          await assertWorkspaceMutationAllowed(
            "agent_engine",
            splitOpts?.workspace,
          );
          const mutate = async () => {
            await beforeMutation?.();
            return client.newSplit(direction, clientOpts);
          };
          return splitOpts?.surface
            ? withSurfaceWrite(splitOpts.surface, mutate, {
                toolName: "new_split",
                lockKey: stableSurfaceIdentity
                  ? `uuid:${stableSurfaceIdentity.toLowerCase()}`
                  : splitOpts.surface,
              })
            : mutate();
        },
        newSurface: async (surfaceOpts) => {
          await assertWorkspaceMutationAllowed(
            "agent_engine",
            surfaceOpts?.workspace,
          );
          return client.newSurface(surfaceOpts);
        },
        renameTab: async (surface, title, renameOpts) => {
          await assertSurfaceMutationAllowed(
            "agent_engine",
            surface,
            renameOpts?.workspace,
          );
          return typeof client.renameTab === "function"
            ? client.renameTab(surface, title, renameOpts)
            : undefined;
        },
        focusSurface: async (surface, focusOpts) => {
          const { beforeMutation, ...clientOpts } = focusOpts ?? {};
          await assertWorkspaceMutationAllowed(
            "agent_engine",
            focusOpts?.workspace,
          );
          await beforeMutation?.();
          return client.focusSurface(surface, clientOpts);
        },
        selectWorkspace: async (workspace) => {
          await assertWorkspaceMutationAllowed("agent_engine", workspace);
          return client.selectWorkspace(workspace);
        },
        listPanes: (paneOpts) => client.listPanes(paneOpts),
        listPaneSurfaces: (surfaceOpts) =>
          client.listPaneSurfaces(surfaceOpts),
        closeSurface: (surface, closeOpts) => {
          const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
            closeOpts ?? {};
          return withSurfaceWrite(
            surface,
            async () => {
              await beforeMutation?.();
              const result = await client.closeSurface(surface, clientOpts);
              appendCloseEvent({
                event: "internal",
                target: surface,
                caller: "internal:agent_engine",
                force: false,
                reason: "agent_engine teardown",
                refused: false,
              });
              return result;
            },
            {
              toolName: "close_surface",
              workspace: closeOpts?.workspace,
              stableSurfaceIdentity,
            },
          );
        },
        moveSurface: async (moveOpts) => {
          const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
            moveOpts;
          await assertWorkspaceMutationAllowed(
            "move_surface",
            moveOpts.workspace,
          );
          return withSurfaceWrite(
            moveOpts.surface,
            async () => {
              await beforeMutation?.();
              return client.moveSurface(clientOpts);
            },
            {
              toolName: "move_surface",
              lockKey: stableSurfaceIdentity
                ? `uuid:${stableSurfaceIdentity.toLowerCase()}`
                : moveOpts.surface,
            },
          );
        },
        notify: (notifyOpts) => client.notify(notifyOpts),
        // The Claude channel emitter was removed (N1a); lifecycle events
        // have no MCP-side consumer.
        notifyLifecycleEvent: async () => {},
      },
      {
        spawnPreflight:
          spawnPreflight ??
          (disableSpawnPreflight ? async () => {} : undefined),
        sessionIdentityResolver: context.sessionIdentityResolver,
        selfRegistrationSessionResolver:
          context.selfRegistrationSessionResolver,
        selfRegistrationSessionLookup: context.selfRegistrationSessionLookup,
        roleSurfaceIdsProvider: collectServerRoleSurfaceIds,
        inboxOpts,
        launchCommandSender: async ({
          surface,
          stableSurfaceIdentity,
          workspace,
          command,
          timeout_ms,
          assertSurfaceBindingCurrent,
        }) => {
          originalLaunchCommandsBySurface.set(surface, command);
          try {
            await sendLauncherCommandToSurface({
              surface,
              stableSurfaceIdentity,
              workspace,
              command,
              timeout_ms,
              assertSurfaceBindingCurrent,
            });
          } catch (error) {
            originalLaunchCommandsBySurface.delete(surface);
            launchShellRecoveryBySurface.delete(surface);
            throw error;
          }
        },
        outboxDrain: opts?.outboxDrain,
        watchRegistryPath,
        watchRegistryNow: opts?.watchRegistryNow,
        watchNotify: async (event) => {
          // Persisted public watches can predate the arm-time guard. A
          // shared collab revision is never a per-agent report event.
          if (
            event.target_kind === "file" &&
            event.reason === "target_changed" &&
            [...stateMgr.listStates(), ...registry.list()].some(
              (agent) => agent.collab_path &&
                resolve(agent.collab_path) === resolve(event.target),
            )
          ) {
            return {
              delivered: false,
              retryable: false,
              reason: "shared_collab_watch_target",
            };
          }
          if (event.provenance !== "public" && event.subject_agent_id) {
            const subject = stateMgr.readState(event.subject_agent_id) ??
              registry.get(event.subject_agent_id);
            if (subject?.report_path &&
                resolve(subject.report_path) !== resolve(event.target)) {
              return {
                delivered: false,
                retryable: false,
                reason: "report_target_mismatch",
              };
            }
          }
          const externalNotifyOptedIn =
            event.notify === true && Boolean(opts?.watchNotify);
          const deliverExternalNotification = async (): Promise<boolean> => {
            if (!externalNotifyOptedIn || !opts?.watchNotify) return false;
            try {
              return (await opts.watchNotify(event)) !== false;
            } catch {
              return false;
            }
          };
          const subjectStillBelongsToOwner = (
            resolvedOwnerId: string | null,
          ): boolean => {
            if (!event.subject_agent_id) return true;
            if (!resolvedOwnerId) return false;
            const subject =
              registry.get(event.subject_agent_id) ??
              stateMgr.readState(event.subject_agent_id);
            return Boolean(
              subject &&
              subject.parent_agent_id === resolvedOwnerId &&
              subject.user_killed !== true &&
              !subject.deletion_intent,
            );
          };
          const ownerResolution = resolveWatchOwnerFromSources(
            watchNotificationOwner(event),
            registry
              .list()
              .filter(
                (candidate) =>
                  candidate.user_killed !== true &&
                  !candidate.deletion_intent,
              ),
            stateMgr
              .listStates()
              .filter(
                (candidate) =>
                  candidate.user_killed !== true &&
                  !candidate.deletion_intent,
              ),
          );
          const subjectBoundOwner = (() => {
            if (!event.subject_agent_id) return null;
            const subject =
              registry.get(event.subject_agent_id) ??
              stateMgr.readState(event.subject_agent_id);
            if (
              !subject?.parent_agent_id ||
              subject.user_killed === true ||
              subject.deletion_intent
            ) {
              return undefined;
            }
            const parentId = canonicalAgentId(subject.parent_agent_id);
            if (!watchOwnerIncludesCanonical(ownerResolution, parentId)) {
              return undefined;
            }
            return ownerResolution.candidates.find(
              (candidate) => candidate.agent_id === subject.parent_agent_id,
            );
          })();
          const subjectBindingMismatch = Boolean(
            event.subject_agent_id &&
              ownerResolution.kind !== "unresolved" &&
              !subjectBoundOwner,
          );
          const owner = await (async () => {
            if (event.subject_agent_id) return subjectBoundOwner;
            if (ownerResolution.kind === "resolved") {
              return ownerResolution.candidates[0];
            }
            if (ownerResolution.kind === "ambiguous") {
              const probed = await Promise.all(
                ownerResolution.candidates.map(async (candidate) => ({
                  candidate,
                  live: await freshLiveAgentStateProbe(candidate),
                })),
              );
              return selectDuplicateWatchOwnerCandidate(probed);
            }
            return undefined;
          })();
          if (subjectBindingMismatch) {
            return {
              delivered: false,
              retryable: false,
              reason: "subject_not_owned",
            };
          }
          let externalDelivered = false;
          if (event.reason !== "predicate_matched") {
            externalDelivered = await deliverExternalNotification();
          }
          if (!owner) {
            if (event.reason === "predicate_matched") {
              externalDelivered = await deliverExternalNotification();
            }
            if (externalDelivered) {
              return true;
            }
            return {
              delivered: false,
              retryable: false,
              reason: "owner_not_live",
            };
          }
          if (!subjectStillBelongsToOwner(owner.agent_id)) {
            return externalDelivered
              ? true
              : {
                  delivered: false,
                  retryable: false,
                  reason: "subject_not_owned",
                };
          }
          if (owner && deps.lifecycleAgentInputDeliverer) {
            const externalFallbackAfterLocalFailure = async () => {
              if (!subjectStillBelongsToOwner(owner.agent_id)) {
                return externalDelivered;
              }
              if (event.reason !== "predicate_matched") {
                return externalDelivered;
              }
              return deliverExternalNotification();
            };
            const text = (() => {
              if (
                event.reason === "predicate_matched" ||
                event.reason === "target_changed"
              ) {
                return event.target_kind === "file"
                  ? event.provenance !== "public" && event.subject_agent_id
                    ? `[report] changed — read ${event.target}`
                    : `[watch] file changed — inspect ${event.target}`
                  : `[watch] agent predicate matched — inspect ${event.target}`;
              }
              if (event.reason === "target_missing") {
                return `[watch] target missing — expected file ${event.target}`;
              }
              if (event.reason === "deadline_elapsed") {
                return event.target_kind === "file"
                  ? `[watch] deadline elapsed before marker — inspect ${event.target}`
                  : `[watch] deadline elapsed before predicate — inspect agent ${event.target}`;
              }
              return `[watch] target agent ended before predicate — inspect ${event.target}`;
            })();
            try {
              const delivery = await deps.lifecycleAgentInputDeliverer({
                agent_id: owner.agent_id,
                text,
                press_enter: true,
                allow_busy: true,
                source_event: "report_to_parent",
                delivery_id: randomUUID(),
              });
              const ownerDelivered =
                delivery.delivery === "submitted" ||
                delivery.delivery === "queued";
              return ownerDelivered
                ? true
                : externalFallbackAfterLocalFailure();
            } catch {
              return externalFallbackAfterLocalFailure();
            }
          }
          if (event.reason !== "predicate_matched") {
            return externalDelivered;
          }
          return deliverExternalNotification();
        },
        closeForensicsRunner: opts?.enableCloseForensics
          ? createDefaultCloseForensicsRunner({
              stateMgr,
              listSurfacesForRefMap: surfaceProvider,
            })
          : null,
        seatRegistry,
        seatRegistryPath: opts?.seatRegistryPath,
        deliveryVerifyDeadlineMs: opts?.deliveryVerifyDeadlineMs,
        deliveryTicketDir:
          opts?.deliveryTicketDir ??
          (testProcess ? undefined : defaultDeliveryTicketDir()),
        deliveryIssueFiler:
          opts?.deliveryIssueFiler ??
          (testProcess
            ? undefined
            : async (ticket) => {
                await fileDeliveryFailureGithubIssue(ticket);
              }),
      },
    );
  return engine;
}

export interface ListAgentsToolDeps {
  awaitLifecycleStart: () => Promise<void>;
  client: CmuxServerContext["client"];
  collectSurfaceTopology: (workspace?: string) => Promise<SurfaceTopologySnapshot | null>;
  discovery: AgentDiscovery;
  engine: AgentEngine;
  evaluateServerAgentHealth: ServerAgentHealthEvaluator;
  registry: AgentRegistry;
  resolveCurrentCallerAgent: () => AgentRecord | null;
  seatRegistry: SeatRegistry | null;
}

export function registerListAgentsTool(
  server: McpServer,
  deps: ListAgentsToolDeps,
): void {
  const {
    awaitLifecycleStart,
    client,
    collectSurfaceTopology,
    discovery,
    engine,
    evaluateServerAgentHealth,
    registry,
    resolveCurrentCallerAgent,
    seatRegistry,
  } = deps;
  // 15. list_agents
  const listAgentsDeliveryLimit = 20;
  type ListAgentsObservedRow = ObservedPublicAgent & {
    cli: CliType;
    role: AgentRole | null;
    collab_path?: string;
    surface_id: string;
    send_via: "send_to";
    closure: ClosureState;
    /** #863: present only while the managed boot prompt is unsubmitted. */
    boot?: "unsubmitted";
    parsed_cli_mismatch?: true;
    health?: AgentHealth;
  };
  type ListAgentsCacheEntry = {
    topology_signature: string;
    derived_at: number;
    agents: ListAgentsObservedRow[];
    skipped_agents: Array<{ agent_id: string; error: string }>;
  };
  const listAgentsCache = new Map<string, ListAgentsCacheEntry>();
  const listAgentsTopologySignature = (
    topology: SurfaceTopologySnapshot | null,
  ): string =>
    JSON.stringify({
      complete: topology?.complete ?? false,
      surfaces: topology
        ? [...topology.workspaceBySurface]
            .map(([surface, workspace]) => ({
              surface,
              workspace,
              uuid: topology.surfaceIdByRef.get(surface) ?? null,
            }))
            .sort((a, b) => a.surface.localeCompare(b.surface))
        : [],
    });

  server.tool(
    "list_agents",
    "List live-derived agents, including registry-persisted prompt blockage and pause state; filter to blocked agents or children with mine/parent_agent_id. Default summary returns flat addressable scalars and hides close tombstones and failed spawns whose surfaces are absent; request a terminal state or detail=full to include them. Full detail also includes provenance, health diagnostics, the registry record, and up to 20 unresolved or attention delivery receipts.",
    {
      state: z
        .enum([
          "creating",
          "booting",
          "ready",
          "working",
          "idle",
          "done",
          "error",
        ])
        .optional()
        .describe("Filter by state"),
      repo: z.string().optional().describe("Filter by repository"),
      model: z.string().optional().describe("Filter by model"),
      blocked_on_prompt: z
        .boolean()
        .optional()
        .describe(
          "Return only agents whose registry records show a live prompt blocker",
        ),
      mine: z
        .boolean()
        .optional()
        .default(false)
        .describe("Return direct children of the calling agent"),
      parent_agent_id: z
        .string()
        .optional()
        .describe("Return direct children of this agent"),
      agent_ids: z
        .array(z.string())
        .optional()
        .describe("Return only these agent IDs"),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .default("summary")
        .describe(
          "summary (default): flat addressable scalar rows. full: provenance, health diagnostics, the full registry record, and up to 20 unresolved or attention delivery receipts.",
        ),
      max_age_ms: z
        .number()
        .int()
        .min(0)
        .max(5_000)
        .optional()
        .describe(
          "Maximum acceptable snapshot age in milliseconds (0-5000); topology changes always invalidate the snapshot",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      if (args.mine && args.parent_agent_id) {
        return err(
          new Error(
            "list_agents accepts either mine=true or parent_agent_id, not both",
          ),
        );
      }
      const parentAgentId = args.mine
        ? resolveCurrentCallerAgent()?.agent_id
        : args.parent_agent_id;
      if (args.mine && !parentAgentId) {
        return err(
          new Error(
            "list_agents mine=true requires a managed calling agent identity",
          ),
        );
      }
      const filter = {
        repo: args.repo,
        model: args.model,
        blocked_on_prompt: args.blocked_on_prompt,
      };
      const requestedState = args.state;
      const cacheKey = JSON.stringify({
        state: args.state ?? null,
        repo: args.repo ?? null,
        model: args.model ?? null,
        blocked_on_prompt: args.blocked_on_prompt ?? null,
        parent_agent_id: parentAgentId ?? null,
        agent_ids: args.agent_ids ?? null,
        detail: args.detail,
      });
      const renderListAgentsResponse = (entry: ListAgentsCacheEntry) => {
        const actionableDeliveries =
          args.detail === "full"
            ? engine
                .listDeliveryReceipts()
                .filter(
                  (receipt) =>
                    !receipt.terminal || receipt.needs_attention === true,
                )
                .sort((left, right) =>
                  left.created_at.localeCompare(right.created_at),
                )
            : [];
        const agents =
          args.detail === "full"
            ? entry.agents
            : entry.agents.map((agent) => ({
                agent_id: agent.agent_id,
                repo: agent.repo,
                cli: agent.cli,
                role: agent.role,
                ...(agent.collab_path ? { collab_path: agent.collab_path } : {}),
                state: agent.state.value,
                surface_id: agent.surface_id,
                model: agent.model.value,
                session_id: agent.session_id.value,
                resumable: agent.resumable.value,
                resume_command: agent.resume_command ?? null,
                paused: agent.paused.value,
                blocked_on_prompt: agent.blocked_on_prompt.value,
                send_via: agent.send_via,
                closure: agent.closure,
                ...(agent.boot ? { boot: agent.boot } : {}),
                ...(agent.parsed_cli_mismatch === true
                  ? { parsed_cli_mismatch: true }
                  : {}),
              }));
        const data = {
          derived_at: entry.derived_at,
          agents: agents as unknown as Record<string, unknown>[],
          count: agents.length,
          ...(entry.skipped_agents.length > 0
            ? { skipped_agents: entry.skipped_agents }
            : {}),
          ...(args.detail === "full"
            ? {
                deliveries: actionableDeliveries
                  .slice(-listAgentsDeliveryLimit)
                  .map((receipt) => ({
                    delivery_id: receipt.delivery_id,
                    agent_id: receipt.agent_id,
                    delivery_state: receipt.delivery_state,
                    terminal: receipt.terminal,
                    created_at: receipt.created_at,
                    resolved_at: receipt.resolved_at,
                    retry_count: receipt.retry_count,
                    ...(receipt.needs_attention === true
                      ? {
                          needs_attention: true,
                          attention_reason: receipt.attention_reason,
                        }
                      : {}),
                  })),
                deliveries_total: actionableDeliveries.length,
                deliveries_truncated:
                  actionableDeliveries.length > listAgentsDeliveryLimit,
              }
            : {}),
        };
        const formatted = formatListAgents(
          entry.agents,
          entry.agents.length,
          entry.skipped_agents,
        );
        return okFormatted(formatted, data);
      };
      const buildListAgentsResponse = async (
        // `listMerged` hands back MergedAgent rows; the merge-only fields are
        // optional so cached/registry-only callers still type-check.
        records: Array<AgentRecord & { parsed_cli_mismatch?: boolean }>,
        topology: SurfaceTopologySnapshot | null,
        topologySignature: string,
        liveDiscovery?: {
          rows: DiscoveredAgent[];
          observed_at_ms: number;
        },
      ) => {
        const registryObservedAt = Date.now();
        const uuidKey = (value: string | null | undefined) =>
          value?.trim().toLowerCase() || null;
        const observedSurfaceFor = (agent: AgentRecord) =>
          liveDiscovery?.rows.find((surface) => {
            const agentUuid = uuidKey(agent.surface_uuid);
            const surfaceUuid = uuidKey(surface.surface_uuid);
            return agentUuid && surfaceUuid
              ? agentUuid === surfaceUuid
              : Boolean(
                  !agentUuid &&
                  !surfaceUuid &&
                  agent.surface_observer_id &&
                  agent.surface_observer_id === registry.getObserverId() &&
                  surface.surface_id === agent.surface_id,
                );
          });
        const failedSpawnSurfaceStillListed = (agent: AgentRecord) =>
          liveDiscovery?.rows.some((surface) => {
            const agentUuid = uuidKey(agent.surface_uuid);
            const surfaceUuid = uuidKey(surface.surface_uuid);
            return agentUuid && surfaceUuid
              ? agentUuid === surfaceUuid
              : !agentUuid &&
                  !surfaceUuid &&
                  surface.surface_id === agent.surface_id;
          }) ?? true;
        const visibleRecords =
          args.detail === "full" ||
          requestedState !== undefined ||
          (args.agent_ids?.length ?? 0) > 0
            ? records
            : records.filter(
                (agent) =>
                  !isDeliberateCloseTombstone(agent) &&
                  (!isFailedSpawnTombstone(agent) ||
                    failedSpawnSurfaceStillListed(agent)),
              );
        const rows = await Promise.all(
          visibleRecords.map(async (agent) => {
            try {
              const observedSurface = observedSurfaceFor(agent);
              const trustedScreenObservation =
                observedSurface && !observedSurface.read_error
                  ? observedSurface
                  : null;
              // AIDEV-NOTE (T1b/#488): ONE observation per row. `closure`
              // used to re-resolve live state through the discovery cache
              // (`cachedScan()`, null past 2000ms) while `state` below used
              // THIS call's own scan -- so a cold cache made one row read
              // `working` and `artifact_missing` at the same time, and flap
              // as the cache aged. Same evidence, resolved once, passed to
              // the health block AND to closure. Costs zero extra screen
              // reads: the scan already happened at the top of this call.
              const rowLiveState = resolveLiveAgentState(
                agent,
                trustedScreenObservation
                  ? {
                      status: trustedScreenObservation.parsed_status,
                      agent_type:
                        trustedScreenObservation.cli === "kiro"
                          ? "unknown"
                          : trustedScreenObservation.cli,
                      control_state: trustedScreenObservation.control_state,
                      errors: trustedScreenObservation.errors ?? null,
                    }
                  : null,
              );
              const rowHarvestability = engine.assessHarvestability(agent, {
                live: rowLiveState,
              });
              const health = await evaluateServerAgentHealth(
                agent,
                {
                  ...healthTopologyOverrides(agent, topology),
                  ...(trustedScreenObservation
                    ? {
                        screen_status: trustedScreenObservation.parsed_status,
                        screen_agent_type:
                          trustedScreenObservation.cli === "kiro"
                            ? "unknown"
                            : trustedScreenObservation.cli,
                        screen_control_state:
                          trustedScreenObservation.control_state,
                        screen_actions:
                          trustedScreenObservation.actions ?? [],
                        screen_errors:
                          trustedScreenObservation.errors ?? [],
                      }
                    : {}),
                  // Without this the health block re-derived harvestability
                  // through the probe (buildAgentHealthInput's
                  // `deps.assessHarvestability`), putting a THIRD resolution
                  // in the same row: `closure_without_artifact` could fire
                  // beside `closure: "pending"`.
                  harvestability: rowHarvestability,
                },
                topology,
              );
              const reconciledState = health.reconciled_state ?? agent.state;
              // #863: the health block keeps an unsubmitted boot `booting`;
              // that state is the registry's, not the screen's.
              const bootUnsubmitted = health.issue_codes.includes(
                "boot_prompt_unsubmitted",
              );
              const screenObservation = trustedScreenObservation
                ? {
                    observed_at_ms: liveDiscovery!.observed_at_ms,
                    status: trustedScreenObservation.parsed_status,
                    agent_type:
                      trustedScreenObservation.cli === "kiro"
                        ? "unknown"
                        : trustedScreenObservation.cli,
                    control_state: trustedScreenObservation.control_state,
                    model: trustedScreenObservation.model,
                  }
                : health.screen_observation;
              return {
                agent: {
                  ...toObservedPublicAgent(agent, {
                    derivedAtMs: registryObservedAt,
                    state: reconciledState,
                    stateSource:
                      health.screen_confirmed_state && !bootUnsubmitted
                        ? "screen"
                        : "registry",
                    screenObservedAtMs: screenObservation?.observed_at_ms,
                    screenModel: screenObservation?.model,
                    ...(trustedScreenObservation?.paused !== undefined
                      ? {
                          paused: trustedScreenObservation.paused,
                          pausedSource:
                            trustedScreenObservation.paused_source ??
                            "inferred",
                        }
                      : agent.paused === true
                        ? {
                            paused: true,
                            pausedSource: agent.paused_source ?? "inferred",
                          }
                        : {}),
                  }),
                  cli: agent.cli,
                  role: inferRecordRoleOrNull(agent),
                  ...(agent.collab_path ? { collab_path: agent.collab_path } : {}),
                  surface_id: agent.surface_id,
                  send_via: "send_to" as const,
                  // #481: computed on every listMerged, read only by the
                  // removed resync tool's dead body -- so a pane whose
                  // observed CLI disagreed with its record was silently
                  // un-surfaced. Sparse on purpose: agreement is the normal
                  // case and must cost no payload.
                  ...(agent.parsed_cli_mismatch === true
                    ? { parsed_cli_mismatch: true }
                    : {}),
                  // P11 Constraint 3: at DEFAULT detail, so a lead can tell a
                  // deadlocked child (done, no artifact -> act) from a busy one
                  // (pending -> wait) WITHOUT a second full-detail call. A bare
                  // boolean made both of those `false`; that was the S3 bug.
                  closure: rowHarvestability.closure,
                  ...(bootUnsubmitted ? { boot: "unsubmitted" as const } : {}),
                  ...(args.detail === "full"
                    ? {
                        health: {
                          ...health,
                          ...(screenObservation
                            ? { screen_observation: screenObservation }
                            : {}),
                        },
                        detail: {
                          ...toAgentStatePayload(agent),
                          harvestability: rowHarvestability,
                        },
                      }
                    : {}),
                },
                skipped: null,
              };
            } catch (error) {
              return {
                agent: null,
                skipped: {
                  agent_id: agent.agent_id,
                  error:
                    error instanceof Error ? error.message : String(error),
                },
              };
            }
          }),
        );
        const enrichedAgents = rows.flatMap((row) =>
          row.agent ? [row.agent] : [],
        );
        const skippedAgents = rows.flatMap((row) =>
          row.skipped ? [row.skipped] : [],
        );
        const agents = requestedState
          ? enrichedAgents.filter(
              (agent) => agent.state.value === requestedState,
            )
          : enrichedAgents;
        const entry: ListAgentsCacheEntry = {
          topology_signature: topologySignature,
          derived_at: Date.now(),
          agents: agents as ListAgentsCacheEntry["agents"],
          skipped_agents: skippedAgents,
        };
        listAgentsCache.set(cacheKey, entry);
        return renderListAgentsResponse(entry);
      };

      try {
        await awaitLifecycleStart();
        const topology = await collectSurfaceTopology();
        const topologySignature = listAgentsTopologySignature(topology);
        const maxAgeMs = args.max_age_ms ?? 0;
        const cached = listAgentsCache.get(cacheKey);
        if (
          maxAgeMs > 0 &&
          cached &&
          cached.topology_signature === topologySignature &&
          Date.now() - cached.derived_at <= maxAgeMs
        ) {
          return renderListAgentsResponse(cached);
        }
        const live = await engine.runLifecycleMutation(
          async (withUnlocked) => {
            let discovered: DiscoveredAgent[] | null = null;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              discovery.invalidate();
              const revision = engine.lifecycleLockRevision();
              let observed: DiscoveredAgent[];
              try {
                observed = await withUnlocked(() => discovery.scan(true));
              } catch (error) {
                if (error instanceof SurfaceBindingChangedDuringDiscoveryError) {
                  // The lock was lent while discovery read the pane. Discard
                  // that scan and retry from the current surface binding.
                  continue;
                }
                throw error;
              }
              // Our own reacquire is observeOnly, so any advance is a holder
              // that may have changed what the unlocked scan observed.
              if (engine.lifecycleLockRevision() === revision) {
                discovered = observed;
                break;
              }
            }
            if (!discovered) {
              // Continuous unrelated lifecycle traffic must not turn a
              // status request into an error. One final scan under the lock
              // guarantees progress after the bounded unlocked attempts.
              discovery.invalidate();
              discovered = await discovery.scan(true);
            }
            const observedAtMs = Date.now();
            registry.repairFromDiscovery(discovered, {
              seatRegistry,
              orphansOnly: true,
            });
            // #481: `createLiveSeatDiscoveryProof` had exactly one call site --
            // inside the removed resync tool's unreachable body -- so
            // `hasLiveManagedSeatSibling` returned false unconditionally and
            // every crash-recovery-eligible ghost was retained forever. This is
            // the live path that already holds a same-cycle, observer-pinned
            // scan, so the proof belongs here.
            // #480: it is also the only reconciliation callers actually
            // trigger. Without an eviction here `list_agents` was the one
            // reader that never dropped a row: 17 agents against 13 surfaces.
            const liveSeatProof = registry.createLiveSeatDiscoveryProof(
              discovered,
              {
                seatRegistry,
                expectedObserverId: registry.getObserverId(),
                expectedObserverEpoch: registry.getObserverEpoch(),
              },
            );
            await registry.evictSurfaceless({
              confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
              now: observedAtMs,
              liveSeatProof,
            });
            const merged = await registry.listMerged(discovery, {
              filter,
              force: true,
              discovered,
            });
            const requestedIds = args.agent_ids
              ? new Set(args.agent_ids)
              : null;
            const scoped = merged.filter(
              (agent) =>
                (!parentAgentId || agent.parent_agent_id === parentAgentId) &&
                (!requestedIds || requestedIds.has(agent.agent_id)),
            );
            return { merged: scoped, discovered, observedAtMs };
          },
          // Discovery reads cmux, not the registry: another list_agents
          // holder cannot stale this scan, so it must not invalidate it (#892).
          { label: "list-agents", observeOnly: true },
        );
        invalidateSurfaceTopologyCallScope(client as object);
        const reconciledTopology = await collectSurfaceTopology();
        const reconciledTopologySignature =
          listAgentsTopologySignature(reconciledTopology);
        return await buildListAgentsResponse(
          live.merged,
          reconciledTopology,
          reconciledTopologySignature,
          {
            rows: live.discovered,
            observed_at_ms: live.observedAtMs,
          },
        );
      } catch (e) {
        if (isSurfaceEnumerationError(e)) {
          try {
            return await buildListAgentsResponse(
              registry.list(filter).filter((agent) => {
                const requestedIds = args.agent_ids
                  ? new Set(args.agent_ids)
                  : null;
                return (
                  (!parentAgentId ||
                    agent.parent_agent_id === parentAgentId) &&
                  (!requestedIds || requestedIds.has(agent.agent_id))
                );
              }),
              null,
              listAgentsTopologySignature(null),
            );
          } catch (fallbackError) {
            return err(fallbackError);
          }
        }
        return err(e);
      }
    },
  );
}

export interface ReportToParentToolDeps {
  assertWorkerUpwardChannel: (target: string) => void;
  awaitLifecycleStart: () => Promise<void>;
  deliverReportInboxPointer: (recipient: AgentRecord, message: ReturnType<typeof dispatch>) => Promise<{ delivery: "submitted" | "queued" | "queued_followup" | "rescued" | "pending_verify"; delivery_id?: string; }>;
  inboxOpts: InboxOpts;
  registry: AgentRegistry;
  resolveCurrentCallerAgent: () => AgentRecord | null;
  stateMgr: StateManager;
}

export function registerReportToParentTool(
  server: McpServer,
  deps: ReportToParentToolDeps,
): void {
  const {
    assertWorkerUpwardChannel,
    awaitLifecycleStart,
    deliverReportInboxPointer,
    inboxOpts,
    registry,
    resolveCurrentCallerAgent,
    stateMgr,
  } = deps;
  server.tool(
    "report_to_parent",
    "Raise a short blocker to this managed agent's registry parent. cmuxlayer chooses the parent; callers cannot address arbitrary agents. The blocker is durably appended to the parent's inbox and its pointer is actively delivered. If that wake fails, cmuxlayer alerts the nearest reachable ancestor and returns fallback provenance. A root agent has no parent and receives an error. Workers with collab_path must append there to reach their own parent lead; this tool refuses that upward route.",
    {
      blocker: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          "Short blocker pointer, capped at 500 characters; put detailed evidence in a report file",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        await awaitLifecycleStart();
        const child = resolveCurrentCallerAgent();
        if (!child) {
          return err("report_to_parent requires a managed calling agent", {
            error_code: "report_caller_unmanaged",
          });
        }
        if (!child.parent_agent_id) {
          return err(`Agent ${child.agent_id} has no parent`, {
            error_code: "report_parent_missing",
            child_agent_id: child.agent_id,
          });
        }

        const intendedParentId = child.parent_agent_id;
        assertWorkerUpwardChannel(intendedParentId);
        const directMessage = dispatch(
          intendedParentId,
          {
            from: child.agent_id,
            reply_to: child.agent_id,
            via: child.surface_id,
            observed_at: new Date().toISOString(),
            to: intendedParentId,
            tag: "parent_blocker",
            task: args.blocker,
          },
          inboxOpts,
        );
        const parent =
          registry.get(intendedParentId) ??
          stateMgr.readState(intendedParentId);
        let directError = "parent is absent from the lifecycle registry";
        if (parent) {
          try {
            const wake = await deliverReportInboxPointer(
              parent,
              directMessage,
            );
            return okFormatted(
              `report_to_parent ${parent.agent_id}: ${wake.delivery}`,
              {
                child_agent_id: child.agent_id,
                parent_agent_id: intendedParentId,
                notified_agent_id: parent.agent_id,
                route: "direct",
                durable: true,
                ...wake,
              },
            );
          } catch (error) {
            directError =
              error instanceof Error ? error.message : String(error);
          }
        }

        const visited = new Set<string>([child.agent_id, intendedParentId]);
        let ancestorId = parent?.parent_agent_id ?? null;
        while (ancestorId && !visited.has(ancestorId)) {
          visited.add(ancestorId);
          const ancestor =
            registry.get(ancestorId) ?? stateMgr.readState(ancestorId);
          if (!ancestor) break;
          const prefix =
            `Delivery to parent ${intendedParentId} failed (${directError}). ` +
            `Child ${child.agent_id} reports: `;
          const fallbackTask = `${prefix}${args.blocker}`.slice(0, 500);
          const fallbackMessage = dispatch(
            ancestor.agent_id,
            {
              from: child.agent_id,
              reply_to: child.agent_id,
              via: child.surface_id,
              observed_at: new Date().toISOString(),
              to: ancestor.agent_id,
              tag: "parent_delivery_failed",
              task: fallbackTask,
            },
            inboxOpts,
          );
          try {
            const wake = await deliverReportInboxPointer(
              ancestor,
              fallbackMessage,
            );
            return okFormatted(
              `report_to_parent ${intendedParentId}: fallback ${ancestor.agent_id} ${wake.delivery}`,
              {
                child_agent_id: child.agent_id,
                parent_agent_id: intendedParentId,
                notified_agent_id: ancestor.agent_id,
                route: "fallback",
                durable: true,
                ...wake,
              },
            );
          } catch (error) {
            directError =
              error instanceof Error ? error.message : String(error);
            ancestorId = ancestor.parent_agent_id;
          }
        }

        return err(
          `Blocker was written to ${intendedParentId}'s inbox, but no parent or ancestor could be woken: ${directError}`,
          {
            error_code: "report_parent_unreachable",
            child_agent_id: child.agent_id,
            parent_agent_id: intendedParentId,
            durable: true,
          },
        );
      } catch (error) {
        // #530 (CodeRabbit): the initial awaitLifecycleStart() used to run
        // OUTSIDE any error path, so a bounded lifecycle-start timeout escaped
        // the handler entirely and lost the structured error_code / waited_ms /
        // retryable payload that err() attaches. Wrapping the whole body also
        // closes the escaping inbox-write exceptions noted as D36.
        return err(error);
      }
    },
  );
}
