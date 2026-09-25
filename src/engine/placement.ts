/**
 * Agent surface placement (lead-left / worker-right, workspace scoping),
 * moved verbatim from agent-engine.ts (CX-3 E7). Placement must stay
 * deterministic: this module changes nothing about where a pane lands.
 */

import type { AgentEngine } from "../agent-engine.js";
import type { AgentRecord, AgentRole } from "../agent-types.js";
import {
  canonicalRoleColumn,
  chooseAgentSpawnPlacement,
  collectRoleSurfaceIds,
  deriveRoleColumnIndex,
  inferRecordRoleOrNull,
  isAgentRoleInferenceError,
} from "../layout-policy.js";
import { partitionPaneSurfacesByMembership } from "../pane-surfaces.js";
import {
  normalizeWorkspaceRefAlias,
  reposEquivalent,
  resolveWorkspaceRefForRepo,
} from "../repo-workspace.js";
import {
  buildSurfaceBindingObservation,
  isPaneSurfaceEnumerationComplete,
  resolveObservedAgentSurfaceRef,
} from "../surface-binding-observation.js";
import {
  type SurfaceObserverEpoch,
  type SurfaceTopologySnapshot,
  collectSurfaceTopology,
} from "../surface-topology.js";
import {
  type AgentSurfacePlacement,
  type CreatedAgentSurface,
  DEFAULT_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS,
  DEFAULT_SPAWN_PLACEMENT_TIMEOUT_MS,
  PlacementPendingError,
  PlacementSurfaceBindingError,
  PlacementTimeoutError,
  SPAWN_PLACEMENT_OBSERVE_INTERVAL_MS,
  UNKNOWN_SPLIT_RPC_TIMEOUT_MS,
} from "./types.js";


/**
 * The engine surface these functions read and drive. AgentEngine builds it
 * once (placementHost()); fields are live getters and methods forward to the
 * engine, so spies on the engine still intercept.
 */
export interface PlacementHost {
  readonly client: AgentEngine["client"];
  readonly pendingPlacementSplits: AgentEngine["pendingPlacementSplits"];
  readonly placementSplitInFlight: AgentEngine["placementSplitInFlight"];
  readonly placementTails: AgentEngine["placementTails"];
  readonly registry: AgentEngine["registry"];
  readonly roleSurfaceIdsProvider: AgentEngine["roleSurfaceIdsProvider"];
  readonly stateMgr: AgentEngine["stateMgr"];
  assertSurfaceObserverEpochCurrent: AgentEngine["assertSurfaceObserverEpochCurrent"];
  awaitPendingPlacementSplit: AgentEngine["awaitPendingPlacementSplit"];
  captureSurfaceObserverEpoch: AgentEngine["captureSurfaceObserverEpoch"];
  cleanupUnboundCreatedSurface: AgentEngine["cleanupUnboundCreatedSurface"];
  isSurfaceObserverEpochCurrent: AgentEngine["isSurfaceObserverEpochCurrent"];
  listAllWorkspaces: AgentEngine["listAllWorkspaces"];
  observePlacementColumnState: AgentEngine["observePlacementColumnState"];
  resolveWorkspaceForRepo: AgentEngine["resolveWorkspaceForRepo"];
  settleLatePlacementSplit: AgentEngine["settleLatePlacementSplit"];
  settleRightSplitExit: AgentEngine["settleRightSplitExit"];
  surfaceObserverEpochProvider: AgentEngine["surfaceObserverEpochProvider"];
  surfaceObserverIdProvider: AgentEngine["surfaceObserverIdProvider"];
  withPlacementLock: AgentEngine["withPlacementLock"];
  withWorkspacePlacementObservation: AgentEngine["withWorkspacePlacementObservation"];
}

export async function createAgentSurface(
  this: PlacementHost,
  workspace?: string,
  context?: {
    role?: AgentRole;
    parentAgent?: AgentRecord | null;
    repo?: string;
    worktree?: boolean;
    focus?: boolean;
    placementTimeoutMs?: number;
  },
): Promise<CreatedAgentSurface> {
  const observerEpoch = this.captureSurfaceObserverEpoch();
  const observerId = this.registry.getObserverId();
  this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
  // Pin a child worker to the parent orchestrator's ACTUAL workspace before
  // falling back to repo-name resolution. Without this a worker re-resolves
  // its workspace purely from the repo directory name, which fails for
  // worktree workers (cwd basename is "<repo>.wt/<name>", not "<repo>"): the
  // match returns undefined, listPanes() then runs against cmux's focused
  // workspace where the parent's pane is absent, and the split lands in the
  // wrong/new workspace instead of to the right of the parent. An explicit
  // `workspace` arg still wins ("unless the user asks for a different one").
  // Inherit only for a SAME-repo child so a cross-repo spawn still resolves
  // to its own repo's workspace.
  const parentWorkspace =
    context?.parentAgent &&
    context.parentAgent.repo &&
    context?.repo &&
    reposEquivalent(context.parentAgent.repo, context.repo)
      ? (context.parentAgent.workspace_id ?? undefined)
      : undefined;
  workspace = await this.resolveWorkspaceForRepo(
    workspace ?? parentWorkspace,
    context?.repo,
  );
  this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
  if (workspace && context?.focus !== false) {
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    try {
      await this.client.selectWorkspace(workspace);
    } catch {
      // Best-effort: the workspace may already be focused, or the client may
      // be an older test/fallback implementation.
    }
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
  }

  const placementWorkspace = workspace
    ? normalizeWorkspaceRefAlias(workspace)
    : "<focused-workspace>";
  const placementBudgetMs = Math.min(
      context?.placementTimeoutMs ?? DEFAULT_SPAWN_PLACEMENT_TIMEOUT_MS,
      DEFAULT_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS,
    );
  const placementDeadline = Date.now() + placementBudgetMs;
  const unknownSplitSettleWindowMs = Math.max(
    UNKNOWN_SPLIT_RPC_TIMEOUT_MS, placementBudgetMs,
  );
  return this.withPlacementLock(placementWorkspace, placementDeadline, async (assertActive) => {
    const observedPriorSplit = await this.awaitPendingPlacementSplit(
      placementWorkspace,
      workspace,
      placementDeadline,
      observerEpoch,
      assertActive,
    );
    assertActive();
  try {
    const panes = await this.client.listPanes({ workspace });
    assertActive();
    const rawPaneSurfaces = await Promise.all(
      panes.panes.map(async (pane) => {
        const ps = await this.client.listPaneSurfaces({
          workspace,
          pane: pane.ref,
        });
        return ps.pane_ref ? ps : { ...ps, pane_ref: pane.ref };
      }),
    );
    assertActive();
    const paneSurfaces = partitionPaneSurfacesByMembership(
      panes.panes,
      rawPaneSurfaces,
      {
        workspace_ref: panes.workspace_ref ?? workspace,
        window_ref: panes.window_ref,
      },
    );
    if (!isPaneSurfaceEnumerationComplete(panes.panes, paneSurfaces)) {
      throw new PlacementSurfaceBindingError(
        "Incomplete pane surface enumeration during agent placement; refusing topology mutation.",
      );
    }
    const surfaceObservation = buildSurfaceBindingObservation(
      panes.panes,
      paneSurfaces,
    );
    if (surfaceObservation.coverage === "mixed") {
      throw new PlacementSurfaceBindingError(
        "Mixed surface identity evidence during agent placement; refusing topology mutation.",
      );
    }
    if (surfaceObservation.coverage === "conflict") {
      throw new PlacementSurfaceBindingError(
        "Contradictory surface identity evidence during agent placement; refusing topology mutation.",
      );
    }
    const parentAgent = context?.parentAgent ?? null;
    const liveSurfaceIds = surfaceObservation.liveSurfaceRefs;
    const knownAgentsById = new Map(
      this.stateMgr
        .listStates()
        .map((agent) => [agent.agent_id, agent] as const),
    );
    for (const agent of this.registry.list()) {
      knownAgentsById.set(agent.agent_id, agent);
    }
    const liveKnownAgents = [...knownAgentsById.values()].flatMap((agent) => {
      const surfaceRef = resolveObservedAgentSurfaceRef(
        agent,
        surfaceObservation,
      );
      const observedUuid = surfaceRef
        ? surfaceObservation.surfaceUuidByRef.get(surfaceRef)
        : null;
      return surfaceRef &&
        this.registry.canUseObservedBinding(agent, observedUuid)
        ? [{ ...agent, surface_id: surfaceRef }]
        : [];
    });
    const roleSurfaceIds = collectRoleSurfaceIds(liveKnownAgents);
    const extraRoleSurfaceIds =
      this.roleSurfaceIdsProvider?.(
        liveSurfaceIds,
        workspace,
        surfaceObservation,
      ) ?? null;
    if (extraRoleSurfaceIds) {
      for (const role of ["orchestrator", "worker"] as const) {
        for (const surfaceId of extraRoleSurfaceIds[role]) {
          if (liveSurfaceIds.has(surfaceId)) {
            roleSurfaceIds[role].add(surfaceId);
          }
        }
      }
    }
    const childWorkerSurfaceIds = new Set(
      parentAgent
        ? liveKnownAgents
            .filter((agent) => agent.parent_agent_id === parentAgent.agent_id)
            .filter((agent) => inferRecordRoleOrNull(agent) === "worker")
            .map((agent) => agent.surface_id)
        : [],
    );
    const parentRole = parentAgent
      ? inferRecordRoleOrNull(parentAgent)
      : null;
    const parentDefinitelyElsewhere = Boolean(
      parentAgent?.workspace_id &&
      workspace &&
      parentAgent.workspace_id !== workspace,
    );
    const parentSurfaceId =
      parentAgent && !parentDefinitelyElsewhere
        ? resolveObservedAgentSurfaceRef(parentAgent, surfaceObservation)
        : null;
    if (
      parentAgent?.surface_uuid &&
      !parentSurfaceId &&
      !parentDefinitelyElsewhere
    ) {
      throw new PlacementSurfaceBindingError(
        `Stable surface UUID ${parentAgent.surface_uuid} for parent ` +
          `"${parentAgent.agent_id}" is not uniquely bound in the current ` +
          `pane observation; refusing placement against cached ref ` +
          `${parentAgent.surface_id}.`,
      );
    }
    const placement = chooseAgentSpawnPlacement(
      panes.panes,
      paneSurfaces,
      roleSurfaceIds,
      {
        role: context?.role ?? "worker",
        parentRole,
        parentSurfaceId,
        childWorkerSurfaceIds,
        worktree: context?.worktree,
      },
    );
    if (observedPriorSplit && placement.kind === "split") {
      throw new PlacementSurfaceBindingError(
        `Worker column vanished while placing in ${placementWorkspace}; refusing another split.`,
      );
    }
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    assertActive();
    // AIDEV-NOTE (#510): target the pane by its STABLE id, not its positional
    // ref. `placement.pane` is a `pane:N` ref chosen from the observation above,
    // and positional refs renumber when panes close -- so by the time
    // `new-surface` ran, `pane:N` could name a different pane or none at all
    // (#510: pane:103 vs actual pane:104; 2026-09-13: pane:49 in a workspace
    // whose only pane was pane:2). `cmux new-surface --pane` accepts `<id|ref>`,
    // and every CmuxPane already carries its UUID via `--id-format both`, so a
    // UUID target cannot drift. `new-split` was hardened against raw pane refs
    // in June via a surface anchor; this closes the other placement command.
    // Falls back to the ref only when a pane carries no id.
    const newSurfacePaneTarget =
      placement.kind === "surface"
        ? (panes.panes.find((pane) => pane.ref === placement.pane)?.id ??
          placement.pane)
        : undefined;
    const createdRightSplit =
      placement.kind === "split" &&
      placement.direction === "right" &&
      new Set(deriveRoleColumnIndex(panes.panes).values()).size === 1;
    if (createdRightSplit) {
      // A timed-out newSplit may still finish in cmux. Until its result is
      // observed, later spawns must not choose another split.
      this.pendingPlacementSplits.set(placementWorkspace, {
        pane: "<split in flight>",
        surface: "",
      });
      this.placementSplitInFlight.add(placementWorkspace);
    }
    let splitCommandStarted = false;
    let splitCommandStartedAt = 0;
    let splitCommandReturned = false;
    let splitDefiniteNoMutation = false;
    let splitCompleted = false;
    let createdSurface: CreatedAgentSurface | null = null;
    let surface: AgentSurfacePlacement | undefined;
    try {
      assertActive();
      if (placement.kind === "surface") {
        surface = await this.client.newSurface({
          focus: context?.focus,
          pane: newSurfacePaneTarget ?? placement.pane,
          type: "terminal",
          workspace,
        });
      } else {
        splitCommandStarted = true;
        splitCommandStartedAt = Date.now();
        surface = await this.client.newSplit(placement.direction, {
          ...(placement.pane ? { pane: placement.pane } : {}),
          workspace,
          type: "terminal",
          focus: context?.focus,
        });
        splitCommandReturned = true;
      }
      if (!surface) {
        throw new PlacementSurfaceBindingError(
          "cmux returned no surface for agent placement; refusing an unbound spawn.",
        );
      }
      // Transfer the created handle to the caller before any post-mutation
      // epoch assertion can throw. The caller owns cleanup until it durably
      // binds this exact surface into agent state.
      createdSurface = {
        ...this.withWorkspacePlacementObservation(surface, workspace),
        observerEpoch,
        observerId,
      };
      if (createdRightSplit) {
        const prior = this.pendingPlacementSplits.get(placementWorkspace);
        this.pendingPlacementSplits.set(placementWorkspace, {
          pane: createdSurface.pane,
          surface: createdSurface.surface,
          surfaceId: createdSurface.surface_id,
          uncertain: prior?.uncertain,
        });
      }
      // The lock's deadline can win while cmux is still creating a surface.
      // Its late result belongs to this operation, but must never be returned
      // or left open after the caller has received placement_timeout.
      assertActive();
      if (
        createdSurface.actual_workspace &&
        normalizeWorkspaceRefAlias(createdSurface.actual_workspace) !==
          normalizeWorkspaceRefAlias(createdSurface.workspace)
      ) {
        throw new PlacementSurfaceBindingError(
          `Spawn placement blocked: requested ${createdSurface.workspace} ` +
            `but cmux returned ${createdSurface.actual_workspace} for surface ` +
            `${createdSurface.surface}`,
        );
      }
      if (createdRightSplit) {
        await this.awaitPendingPlacementSplit(
          placementWorkspace,
          workspace,
          placementDeadline,
          observerEpoch,
          assertActive,
        );
      }
      assertActive();
      splitCompleted = true;
      return createdSurface;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      // A typed, pre-mutation rejection proves no split was created. All
      // marker changes happen in the single right-split finally below.
      splitDefiniteNoMutation = Boolean(
        createdRightSplit &&
        (!splitCommandStarted ||
          (!splitCommandReturned && (code === "not_found" || code === "invalid_argument")))
      );
      if (!createdRightSplit && createdSurface) {
        await this.cleanupUnboundCreatedSurface(createdSurface, "agent-placement");
      }
      const paneGone =
        placement.kind === "surface" &&
        (code === "not_found" || /\bnot_found\b/.test(message)) &&
        /pane/i.test(message);
      if (paneGone) {
        // A UUID target cannot drift to another pane. Do not silently
        // re-place or substitute an untracked native worker (#510, #519).
        throw new PlacementSurfaceBindingError(
          `Target pane ${placement.pane}${
            newSurfacePaneTarget && newSurfacePaneTarget !== placement.pane
              ? ` (id ${newSurfacePaneTarget})`
              : ""
          } no longer exists; NO agent surface was created. ` +
            "The pane closed between observation and placement. Retry " +
            "spawn_agent (it re-observes from scratch); do not substitute an " +
            `untracked native worker. cmux said: ${message}`,
        );
      }
      throw error;
    } finally {
      if (createdRightSplit) {
        await this.settleRightSplitExit(placementWorkspace, {
          requestedWorkspace: workspace,
          observerEpoch,
          observerId,
          commandStarted: splitCommandStarted,
          commandStartedAt: splitCommandStartedAt,
          settleWindowMs: unknownSplitSettleWindowMs,
          definiteNoMutation: splitDefiniteNoMutation,
          completed: splitCompleted,
          createdSurface,
          rawSurface: surface,
        });
      }
    }
  } catch (error) {
    if (
      isAgentRoleInferenceError(error) ||
      error instanceof PlacementSurfaceBindingError ||
      Boolean(context?.parentAgent?.surface_uuid) ||
      canonicalRoleColumn(context?.role ?? "worker") !== null
    ) {
      throw error;
    }
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    assertActive();
    const surface = await this.client.newSplit("right", {
      workspace,
      type: "terminal",
    });
    return {
      ...this.withWorkspacePlacementObservation(surface, workspace),
      observerEpoch,
      observerId,
    };
  }
  });
}

export async function withPlacementLock<T>(
  this: PlacementHost,
  workspace: string,
  deadline: number,
  operation: (assertActive: () => void) => Promise<T>,
): Promise<T> {
  const previous = this.placementTails.get(workspace) ?? Promise.resolve();
  let release!: () => void;
  const own = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => own);
  this.placementTails.set(workspace, tail);
  const releaseAbandoned = () => {
    release();
    if (this.placementTails.get(workspace) === tail) {
      this.placementTails.delete(workspace);
    }
  };
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void previous.then(releaseAbandoned, releaseAbandoned);
    throw new PlacementTimeoutError(
      `Spawn placement timed out waiting for workspace ${workspace}; refusing topology mutation.`,
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PlacementTimeoutError(
          `Spawn placement timed out waiting for workspace ${workspace}; refusing topology mutation.`,
        )), remaining);
      }),
    ]);
  } catch (error) {
    void previous.then(releaseAbandoned, releaseAbandoned);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  let expired = false;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () => new PlacementTimeoutError(
    `Spawn placement timed out waiting for workspace ${workspace} split/topology; refusing topology mutation.`,
  );
  const assertActive = () => {
    if (expired || Date.now() >= deadline) throw timeoutError();
  };
  try {
    assertActive();
    return await Promise.race([
      operation(assertActive),
      new Promise<never>((_resolve, reject) => {
        operationTimer = setTimeout(() => {
          expired = true;
          if (this.placementSplitInFlight.has(workspace)) {
            const pending = this.pendingPlacementSplits.get(workspace);
            if (pending) this.pendingPlacementSplits.set(workspace, {
              ...pending,
              uncertain: true,
            });
          }
          reject(timeoutError());
        }, Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (operationTimer) clearTimeout(operationTimer);
    release();
    if (this.placementTails.get(workspace) === tail) {
      this.placementTails.delete(workspace);
    }
  }
}

export async function awaitPendingPlacementSplit(
  this: PlacementHost,
  key: string,
  workspace: string | undefined,
  deadline: number,
  observerEpoch: SurfaceObserverEpoch,
  assertActive: () => void,
): Promise<boolean> {
  const pending = this.pendingPlacementSplits.get(key);
  if (!pending) return false;
  if (pending.unknownStartedAt !== undefined && pending.settleWindowMs !== undefined) {
    // A rejected creation RPC has no returned handle to prove settlement.
    // Observe first: adopt a late landing, or hold the guard until the
    // command's upper-bound window expires before allowing another split.
    const rightColumnExists = await this.observePlacementColumnState(
      key, workspace, observerEpoch, assertActive,
    );
    if (rightColumnExists) {
      this.placementSplitInFlight.delete(key);
      this.pendingPlacementSplits.delete(key);
      return true;
    }
    const remainingMs = Math.max(0,
      pending.unknownStartedAt + pending.settleWindowMs - Date.now(),
    );
    if (remainingMs > 0) {
      throw new PlacementPendingError(
        `Spawn placement has an unknown split outcome in ${key}; retry in ${remainingMs}ms.`,
        remainingMs,
      );
    }
    this.placementSplitInFlight.delete(key);
    this.pendingPlacementSplits.delete(key);
    return false;
  }
  if (pending.uncertain) {
    if (this.placementSplitInFlight.has(key)) {
      throw new PlacementTimeoutError(
        `Spawn placement timed out with a split still in flight in ${key}; refusing topology mutation.`,
      );
    }
    // A settled but ambiguous outcome is recoverable. Read the entire pane
    // membership again under this workspace's placement lock; one failed
    // read blocks only this attempt, never every future spawn.
    const rightColumnExists = await this.observePlacementColumnState(
      key, workspace, observerEpoch, assertActive,
    );
    this.pendingPlacementSplits.delete(key);
    return rightColumnExists;
  }
  while (Date.now() < deadline) {
    assertActive();
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    const panes = await this.client.listPanes({ workspace });
    assertActive();
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement");
    const columns = deriveRoleColumnIndex(panes.panes);
    // The first surface may close before the next spawn, leaving an empty
    // right pane. The split is observed once the column itself exists.
    if ([...columns.values()].includes(1)) {
      this.pendingPlacementSplits.delete(key);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(
      SPAWN_PLACEMENT_OBSERVE_INTERVAL_MS,
      Math.max(1, deadline - Date.now()),
    )));
  }
  throw new PlacementTimeoutError(
    `Spawn placement timed out waiting for split ${pending.pane} in ${key} to appear; refusing another split.`,
  );
}

export async function observePlacementColumnState(
  this: PlacementHost,
  key: string,
  workspace: string | undefined,
  observerEpoch: SurfaceObserverEpoch,
  assertActive: () => void,
): Promise<boolean> {
  try {
    assertActive();
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement recovery");
    const panes = await this.client.listPanes({ workspace });
    assertActive();
    if (!Array.isArray(panes.panes) || panes.panes.length === 0) {
      throw new Error("no pane topology");
    }
    if (
      workspace && panes.workspace_ref &&
      normalizeWorkspaceRefAlias(panes.workspace_ref) !== normalizeWorkspaceRefAlias(workspace)
    ) {
      throw new Error("workspace topology changed");
    }
    const groups = await Promise.all(panes.panes.map(async (pane) => {
      const group = await this.client.listPaneSurfaces({ workspace, pane: pane.ref });
      return group.pane_ref ? group : { ...group, pane_ref: pane.ref };
    }));
    assertActive();
    this.assertSurfaceObserverEpochCurrent(observerEpoch, "agent placement recovery");
    const partitioned = partitionPaneSurfacesByMembership(panes.panes, groups, {
      workspace_ref: panes.workspace_ref ?? workspace,
      window_ref: panes.window_ref,
    });
    if (!isPaneSurfaceEnumerationComplete(panes.panes, partitioned)) {
      throw new Error("incomplete pane topology");
    }
    const observation = buildSurfaceBindingObservation(panes.panes, partitioned);
    if (observation.coverage === "mixed" || observation.coverage === "conflict") {
      throw new Error("ambiguous surface identity");
    }
    const columns = new Set(deriveRoleColumnIndex(panes.panes).values());
    if (columns.size > 2 || !columns.has(0)) {
      throw new Error("invalid role columns");
    }
    return columns.has(1);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PlacementTimeoutError(
      `Spawn placement could not confirm split topology in ${key}: ${reason}; retry after a fresh observation.`,
    );
  }
}

export async function settleRightSplitExit(
  this: PlacementHost,
  key: string,
  exit: {
    requestedWorkspace?: string;
    observerEpoch: SurfaceObserverEpoch;
    observerId: string | null;
    commandStarted: boolean;
    commandStartedAt: number;
    settleWindowMs: number;
    definiteNoMutation: boolean;
    completed: boolean;
    createdSurface: CreatedAgentSurface | null;
    rawSurface?: AgentSurfacePlacement;
  },
): Promise<void> {
  if (exit.completed) {
    this.placementSplitInFlight.delete(key);
    return;
  }
  if (exit.definiteNoMutation || !exit.commandStarted) {
    this.placementSplitInFlight.delete(key);
    if (this.pendingPlacementSplits.get(key)?.surface === "") {
      this.pendingPlacementSplits.delete(key);
    }
    return;
  }
  if (!exit.createdSurface && !exit.rawSurface) {
    // The command rejected without a handle. Keep its guard until the
    // bounded settle window ends, since cmux may still land the split.
    const pending = this.pendingPlacementSplits.get(key);
    if (pending?.surface === "") {
      this.pendingPlacementSplits.set(key, { ...pending, uncertain: true,
        unknownStartedAt: exit.commandStartedAt,
        settleWindowMs: exit.settleWindowMs });
    }
    return;
  }
  const raw = exit.rawSurface!;
  const unbound = exit.createdSurface ?? {
    ...raw,
    ...(exit.requestedWorkspace && raw.workspace !== exit.requestedWorkspace
      ? { workspace: exit.requestedWorkspace, actual_workspace: raw.workspace }
      : {}),
    observerEpoch: exit.observerEpoch,
    observerId: exit.observerId,
  };
  const pending = this.pendingPlacementSplits.get(key);
  if (pending?.surface === "") {
    this.pendingPlacementSplits.set(key, {
      pane: unbound.pane,
      surface: unbound.surface,
      surfaceId: unbound.surface_id,
      uncertain: pending.uncertain,
    });
  }
  let closed = false;
  try {
    closed = await this.cleanupUnboundCreatedSurface(unbound, "agent-placement");
  } finally {
    await this.settleLatePlacementSplit(key, unbound, closed);
  }
}

export async function settleLatePlacementSplit(
  this: PlacementHost,
  key: string,
  surface: CreatedAgentSurface,
  closeSucceeded: boolean,
): Promise<void> {
  const pending = this.pendingPlacementSplits.get(key);
  if (!pending) {
    this.placementSplitInFlight.delete(key);
    return;
  }
  if (
    pending.surface !== surface.surface ||
    (pending.surfaceId && pending.surfaceId !== surface.surface_id)
  ) return;
  // The newSplit command has resolved. Drop the actual in-flight guard even
  // when close or confirmation fails, so a later spawn can re-observe.
  this.placementSplitInFlight.delete(key);
  const uncertain = { ...pending, uncertain: true };
  this.pendingPlacementSplits.set(key, uncertain);
  if (!closeSucceeded || !surface.surface_id) return;
  const workspace = surface.actual_workspace ?? surface.workspace;
  let topology: SurfaceTopologySnapshot | null;
  try {
    topology = await collectSurfaceTopology(
      this.client,
      workspace,
      this.surfaceObserverEpochProvider(),
      this.surfaceObserverIdProvider(),
    );
  } catch {
    return;
  }
  if (
    topology?.complete !== true ||
    topology.surfaceIdByRef.size !== topology.workspaceBySurface.size ||
    !this.isSurfaceObserverEpochCurrent(surface.observerEpoch)
  ) return;
  const targetId = surface.surface_id.toLowerCase();
  if ([...topology.surfaceRefById.keys()].some((id) => id.toLowerCase() === targetId)) return;
  if (this.pendingPlacementSplits.get(key) === uncertain) {
    this.pendingPlacementSplits.delete(key);
  }
}

export function withWorkspacePlacementObservation(
  this: PlacementHost,
  surface: AgentSurfacePlacement,
  requestedWorkspace: string | undefined,
): AgentSurfacePlacement & {
  actual_workspace?: string;
} {
  if (!requestedWorkspace || !surface.workspace) {
    return surface;
  }
  if (surface.workspace === requestedWorkspace) {
    return surface;
  }
  return {
    ...surface,
    workspace: requestedWorkspace,
    actual_workspace: surface.workspace,
  };
}

export async function resolveWorkspaceForRepo(
  this: PlacementHost,
  workspace: string | undefined,
  repo: string | undefined,
): Promise<string | undefined> {
  if (workspace || !repo) return workspace;

  return resolveWorkspaceRefForRepo(repo, () => this.listAllWorkspaces());
}
