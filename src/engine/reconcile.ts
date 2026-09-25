/**
 * The sweep reconciler, moved verbatim from agent-engine.ts (CX-3 E5): one pass
 * over every registry row against the observed topology and screen.
 */

import { scheduler } from "node:timers/promises";
import type { AgentEngine } from "../agent-engine.js";
import { buildAgentHealthInput } from "../agent-health-input.js";
import { evaluateAgentHealth } from "../agent-health.js";
import type { AgentRecord } from "../agent-types.js";
import { inferRecordRoleOrNull } from "../layout-policy.js";
import { isLiveActive, resolveLiveAgentState } from "../live-agent-state.js";
import { parseScreen } from "../screen-parser.js";
import {
  EMPTY_SURFACE_TOPOLOGY,
  healthTopologyOverrides,
  resolveAgentSurfaceBinding,
  type SurfaceTopologySnapshot,
} from "../surface-topology.js";
import type { CmuxStatusUpdate } from "../types.js";
import {
  STATE_SIDEBAR,
  TERMINAL_STATES,
  type SidebarStatusSnapshot,
  type SweepAgentContext,
} from "./types.js";
/**
 * The engine surface the reconciler reads and drives. AgentEngine builds it
 * once (reconcileHost()); fields are live getters and methods forward to the
 * engine, so spies on the engine still intercept.
 */
export interface ReconcileHost {
  readonly registry: AgentEngine["registry"];
  readonly sidebarSnapshot: AgentEngine["sidebarSnapshot"];
  readonly client: AgentEngine["client"];
  readonly stateMgr: AgentEngine["stateMgr"];
  readonly cliExitShellMatches: AgentEngine["cliExitShellMatches"];
  readonly inboxOpts: AgentEngine["inboxOpts"];
  readonly lifecycleLockQueueDepth: AgentEngine["lifecycleLockQueueDepth"];
  assertSweepInputCurrent: AgentEngine["assertSweepInputCurrent"];
  assessHarvestability: AgentEngine["assessHarvestability"];
  buildSidebarStatusValue: AgentEngine["buildSidebarStatusValue"];
  clearAgentLifecycleMemory: AgentEngine["clearAgentLifecycleMemory"];
  clearHealthNotificationMemory: AgentEngine["clearHealthNotificationMemory"];
  collectObservedSurfaceTopology: AgentEngine["collectObservedSurfaceTopology"];
  healthSignature: AgentEngine["healthSignature"];
  isKnownClosedSurface: AgentEngine["isKnownClosedSurface"];
  logLifecycleEvent: AgentEngine["logLifecycleEvent"];
  maybeCaptureBootSessionId: AgentEngine["maybeCaptureBootSessionId"];
  maybeEscalateLiveHalt: AgentEngine["maybeEscalateLiveHalt"];
  maybeMarkBootReady: AgentEngine["maybeMarkBootReady"];
  maybeMarkCliExited: AgentEngine["maybeMarkCliExited"];
  maybeMarkTaskDone: AgentEngine["maybeMarkTaskDone"];
  maybeNotifyLeadMonitorDeath: AgentEngine["maybeNotifyLeadMonitorDeath"];
  notifyLifecycleEventForSweep: AgentEngine["notifyLifecycleEventForSweep"];
  publishSweepStatus: AgentEngine["publishSweepStatus"];
  readSweepScreen: AgentEngine["readSweepScreen"];
  resolveAgentIoRoute: AgentEngine["resolveAgentIoRoute"];
  resolveUnchangedAgentIoRoute: AgentEngine["resolveUnchangedAgentIoRoute"];
  shouldNotifyDone: AgentEngine["shouldNotifyDone"];
  shouldNotifyHealthChange: AgentEngine["shouldNotifyHealthChange"];
  stableSurfaceWriteOptions: AgentEngine["stableSurfaceWriteOptions"];
  sweepReadMatchesBinding: AgentEngine["sweepReadMatchesBinding"];
}

function tailScreenLines(text: string, lines: number): string {
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

/**
 * Reconcile every registry row against the observed topology and screen:
 * rebind surfaces, advance lifecycle (boot capture, ready, done, CLI exit),
 * evaluate health and halts, and push changed cmux status pills only.
 * Logs lifecycle events (spawned, done, error) once each.
 */
export async function reconcileAgents(
  this: ReconcileHost,
  opts: { firstConnect?: boolean } = {},
  surfaceTopologyOverride?: SurfaceTopologySnapshot | null,
  snapshotMutationAllowed?: () => boolean,
  sweepContext: SweepAgentContext = {},
): Promise<void> {
  const agents = this.registry.list();
  const total = agents.length;
  const done = agents.filter((a) => a.state === "done").length;
  const surfaceTopology =
    surfaceTopologyOverride === undefined
      ? await this.collectObservedSurfaceTopology()
      : surfaceTopologyOverride;
  const observedLiveSurfaceRefs =
    surfaceTopology?.complete === true
      ? [...surfaceTopology.workspaceBySurface.keys()].sort()
      : null;
  const observedUuidCoverage =
    observedLiveSurfaceRefs === null
      ? "unknown"
      : surfaceTopology!.surfaceRefById.size === 0
        ? "legacy"
        : surfaceTopology!.surfaceRefById.size ===
            observedLiveSurfaceRefs.length
          ? "complete"
          : "mixed";
  const topologyIsAuthoritative =
    surfaceTopology?.complete === true &&
    observedLiveSurfaceRefs !== null &&
    observedLiveSurfaceRefs.length > 0 &&
    observedUuidCoverage !== "mixed";
  const statusUpdates: CmuxStatusUpdate[] = [];
  const pendingStatusSnapshots: Array<{
    agentId: string;
    snapshot: SidebarStatusSnapshot;
  }> = [];
  const rowVersions = new Map<string, Pick<AgentRecord, "version" | "surface_id" | "surface_uuid">>();

  for (const registryAgent of agents) {
    if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
      continue;
    }
    // Direct lifecycle writers can replace this row after list() returns.
    if (
      sweepContext.sweep &&
      this.registry.get(registryAgent.agent_id)?.version !== registryAgent.version
    ) {
      continue;
    }
    if (opts.firstConnect && TERMINAL_STATES.has(registryAgent.state)) {
      this.cliExitShellMatches.delete(registryAgent.agent_id);
      continue;
    }
    if (!topologyIsAuthoritative) {
      // Empty, partial, mixed-identity, and contradictory observations are
      // preservation signals only. Never read a persisted ref or mutate
      // lifecycle/status state until one coherent topology can bind the row.
      this.cliExitShellMatches.delete(registryAgent.agent_id);
      continue;
    }
    const surfaceBinding = resolveAgentSurfaceBinding(
      registryAgent,
      surfaceTopology,
    );
    if (!surfaceBinding) {
      // A known UUID that is absent from this live topology must not borrow a
      // recycled ref's screen, title, or click route. Unknown/partial
      // publication preserves the last good source until topology recovers.
      const prev = this.sidebarSnapshot.get(registryAgent.agent_id);
      if (prev) {
        try {
          await this.client.clearStatus(registryAgent.agent_id, {
            workspace: prev.workspaceId ?? undefined,
          });
        } catch {
          // Best-effort cleanup for a no-longer-resolvable binding.
        }
      }
      if (!this.assertSweepInputCurrent(sweepContext)) return;
      this.sidebarSnapshot.delete(registryAgent.agent_id);
      // The registry row still exists. Keep once-only lifecycle delivery
      // memory so a recovered binding cannot re-emit "spawned" or terminal
      // notifications merely because one topology snapshot omitted its UUID.
      this.cliExitShellMatches.delete(registryAgent.agent_id);
      continue;
    }

    const observedSurfaceUuid =
      surfaceTopology?.surfaceIdByRef.get(surfaceBinding.surfaceRef) ?? null;
    if (
      !this.registry.canUseObservedBinding(registryAgent, observedSurfaceUuid)
    ) {
      // A live ref without compatible provenance cannot publish, read, or
      // mutate this row. Preserve it for its owning observer.
      this.cliExitShellMatches.delete(registryAgent.agent_id);
      continue;
    }

    let originalAgent = registryAgent;
    const realSurfaceUuid = observedSurfaceUuid;
    const bindingPatch: Partial<AgentRecord> = {};
    if (originalAgent.surface_id !== surfaceBinding.surfaceRef) {
      bindingPatch.surface_id = surfaceBinding.surfaceRef;
    }
    if (
      realSurfaceUuid &&
      originalAgent.surface_uuid !== realSurfaceUuid &&
      (surfaceBinding.provenance === "uuid" ||
        surfaceTopology?.complete === true)
    ) {
      bindingPatch.surface_uuid = realSurfaceUuid;
    }
    if (
      surfaceBinding.workspaceId &&
      (originalAgent.workspace_id ?? null) !== surfaceBinding.workspaceId
    ) {
      bindingPatch.workspace_id = surfaceBinding.workspaceId;
    }
    const observerId = this.registry.getObserverId();
    if (observerId && originalAgent.surface_observer_id !== observerId) {
      bindingPatch.surface_observer_id = observerId;
    }
    if (Object.keys(bindingPatch).length > 0) {
      if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
        continue;
      }
      originalAgent = this.stateMgr.updateRecord(
        originalAgent.agent_id,
        bindingPatch,
      );
      this.registry.set(originalAgent.agent_id, originalAgent);
    }
    const sweepCtx: SweepAgentContext = {
      ...sweepContext,
      surfaceTopology,
    };
    // MCP readiness must not depend on a synchronous scan of the host's
    // transcript tree. Normal sweeps retry transcript capture after startup.
    const capturedAgent = await this.maybeCaptureBootSessionId(
      originalAgent,
      sweepCtx,
      { resolveTranscript: opts.firstConnect !== true },
    );
    const readyAgent = await this.maybeMarkBootReady(capturedAgent, sweepCtx);
    const taskDoneResult = await this.maybeMarkTaskDone(readyAgent, sweepCtx);
    let agent = await this.maybeMarkCliExited(
      taskDoneResult.agent,
      sweepCtx,
      taskDoneResult.screenText,
    );
    if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
      continue;
    }
    const initialAgentId = agent.agent_id;
    if (this.isKnownClosedSurface(agent, surfaceTopology)) {
      const prev = this.sidebarSnapshot.get(initialAgentId);
      if (prev) {
        try {
          await this.client.clearStatus(initialAgentId, {
            workspace: prev.workspaceId ?? undefined,
          });
        } catch {
          // Best-effort cleanup; closed panes must not emit fresh health signals.
        }
      }
      if (!this.assertSweepInputCurrent(sweepCtx)) return;
      this.sidebarSnapshot.delete(initialAgentId);
      this.clearAgentLifecycleMemory(initialAgentId);
      continue;
    }
    // AIDEV-NOTE (T1b/#488): the sweep is the third emitter -- its
    // harvestability feeds the health input, the sidebar row's `report=` and
    // the done notification, beside a state derived from the screen it reads
    // below. When the done-detection pass already has this agent's screen
    // text in hand, closure resolves from THAT rather than from the discovery
    // cache, which may be cold on this path too. No new read: when there is
    // no screen text, the injected probe is used exactly as before.
    // The done-detection pass returns early for a record already at `done`
    // -- exactly #488's shape -- so its screen text is absent precisely when
    // closure needs it. `readSweepScreen` memoizes on `sweepCtx`, which the
    // health input below reuses for this same agent, so this shares that
    // read rather than adding one.
    let sweepScreenText = taskDoneResult.screenText;
    if (sweepScreenText === undefined) {
      try {
        sweepScreenText = (await this.readSweepScreen(agent, sweepCtx)).text;
      } catch {
        // No screen is no evidence; the injected probe answers as before.
      }
    }
    const harvestability = this.assessHarvestability(agent, {
      live:
        sweepScreenText === undefined
          ? null
          : resolveLiveAgentState(agent, parseScreen(sweepScreenText)),
    });
    const healthScreenContexts = new Map<string, SweepAgentContext>();
    let screenCurrentAction: string | null = null;
    const healthScreenContextFor = (
      targetAgent: AgentRecord,
    ): SweepAgentContext => {
      if (targetAgent.agent_id === agent.agent_id) return sweepCtx;
      const existing = healthScreenContexts.get(targetAgent.agent_id);
      if (existing) return existing;
      const next: SweepAgentContext = { ...sweepContext, surfaceTopology };
      healthScreenContexts.set(targetAgent.agent_id, next);
      return next;
    };
    const healthInput = await buildAgentHealthInput(
      agent,
      {
        inboxOpts: this.inboxOpts,
        resolveTopology: async (targetAgent) =>
          surfaceTopology?.topologyBySurface.get(targetAgent.surface_id) ??
          EMPTY_SURFACE_TOPOLOGY,
        readParsedSurface: async (targetAgent) => {
          try {
            const screenText =
              targetAgent.agent_id === agent.agent_id &&
              taskDoneResult.screenText !== undefined
                ? taskDoneResult.screenText
                : (
                    await this.readSweepScreen(
                      targetAgent,
                      healthScreenContextFor(targetAgent),
                    )
                  ).text;
            const parsed = parseScreen(screenText);
            if (targetAgent.agent_id === agent.agent_id) {
              screenCurrentAction = parsed.current_action;
            }
            return {
              status: parsed.status,
              actions: parsed.actions,
              errors: parsed.errors,
            };
          } catch {
            return null;
          }
        },
        resolveSurfaceWorkspace: async (targetAgent) =>
          surfaceTopology?.workspaceBySurface.get(targetAgent.surface_id) ??
          null,
      },
      {
        ...healthTopologyOverrides(agent, surfaceTopology),
        parent_role: agent.parent_agent_id
          ? (() => {
              const parent =
                this.registry.get(agent.parent_agent_id) ??
                this.stateMgr.readState(agent.parent_agent_id);
              return parent ? inferRecordRoleOrNull(parent) : null;
            })()
          : null,
        harvestability,
      },
    );
    if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
      continue;
    }
    const sweepReadMatchesBinding = await this.sweepReadMatchesBinding(
      sweepCtx,
      surfaceBinding.surfaceRef,
    );
    if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
      continue;
    }
    if (!sweepReadMatchesBinding) {
      // The fresh I/O resolver observed this stable UUID at a different ref
      // than the topology snapshot that began the sweep. The screen belongs
      // to the fresh route, while title/topology still belong to the outer
      // snapshot, so publishing either as one row would invert seat state.
      const prev = this.sidebarSnapshot.get(initialAgentId);
      if (prev) {
        try {
          await this.client.clearStatus(initialAgentId, {
            workspace: prev.workspaceId ?? undefined,
          });
        } catch {
          // Best-effort cleanup; the next coherent sweep republishes it.
        }
      }
      if (!this.assertSweepInputCurrent(sweepCtx)) return;
      this.sidebarSnapshot.delete(initialAgentId);
      this.clearAgentLifecycleMemory(initialAgentId);
      continue;
    }
    if (
      agent.state === "done" &&
      agent.user_killed !== true &&
      agent.reopen_pending_at &&
      sweepScreenText !== undefined &&
      isLiveActive(resolveLiveAgentState(agent, parseScreen(sweepScreenText)))
    ) {
      if (!this.assertSweepInputCurrent(sweepCtx)) return;
      agent = this.stateMgr.reopenAfterVerifiedDelivery(agent.agent_id);
      this.registry.set(agent.agent_id, agent);
    }
    let haltScreenText = taskDoneResult.screenText;
    if (haltScreenText === undefined) {
      try {
        haltScreenText = (await this.readSweepScreen(agent, sweepCtx)).text;
      } catch {
        // No live screen proof means no halt classification or escalation.
      }
    }
    if (haltScreenText !== undefined) {
      agent = await this.maybeEscalateLiveHalt(
        agent,
        haltScreenText,
        sweepCtx,
      );
    }
    if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
      continue;
    }
    if (
      sweepContext.sweep &&
      this.registry.get(agent.agent_id)?.version !== agent.version
    ) {
      continue;
    }
    const { agent_id: agentId, state } = agent;
    const boundSurfaceRef = surfaceBinding.surfaceRef;
    const boundWorkspaceId =
      surfaceBinding.workspaceId ?? agent.workspace_id ?? null;
    const health = evaluateAgentHealth(agent, healthInput);
    await this.maybeNotifyLeadMonitorDeath(agent, healthInput);
    if (!this.assertSweepInputCurrent(sweepCtx)) return;
    if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
      continue;
    }
    const healthSignature = this.healthSignature(health);
    const statusValue = this.buildSidebarStatusValue(
      agent,
      health,
      harvestability,
    );
    const statusSnapshot: SidebarStatusSnapshot = {
      statusValue,
      surfaceId: boundSurfaceRef,
      workspaceId: boundWorkspaceId,
      healthSignature,
    };
    const prev = this.sidebarSnapshot.get(agentId);

    // Lifecycle log: spawned (first encounter)
    if (!prev) {
      await this.logLifecycleEvent(agent, "spawned", sweepCtx);
    }

    // Lifecycle log: done
    if (state === "done") {
      await this.logLifecycleEvent(agent, "done", sweepCtx);
      if (this.shouldNotifyDone(harvestability)) {
        await this.notifyLifecycleEventForSweep(sweepCtx, agent, "done");
      }
    }

    // Lifecycle log: error
    if (state === "error") {
      await this.logLifecycleEvent(agent, "errored", sweepCtx);
      await this.notifyLifecycleEventForSweep(sweepCtx, agent, "errored");
    }

    const shouldNotifyHealth = this.shouldNotifyHealthChange(prev, health);
    let healthNotificationDelivered = true;
    if (shouldNotifyHealth) {
      healthNotificationDelivered = await this.notifyLifecycleEventForSweep(
        sweepCtx,
        agent,
        "health",
        healthSignature,
      );
    } else if (
      prev &&
      prev.healthSignature !== healthSignature &&
      health.status !== "unhealthy"
    ) {
      this.clearHealthNotificationMemory(agentId);
    }

    // Status diff — only push if changed
    const statusChanged =
      !prev ||
      prev.statusValue !== statusSnapshot.statusValue ||
      prev.surfaceId !== statusSnapshot.surfaceId ||
      prev.workspaceId !== statusSnapshot.workspaceId;
    if (statusChanged) {
      if (
        prev?.workspaceId &&
        prev.workspaceId !== statusSnapshot.workspaceId
      ) {
        try {
          await this.client.clearStatus(agentId, {
            workspace: prev.workspaceId,
          });
        } catch {
          // Best-effort cleanup of stale workspace-scoped status.
        }
      }
      if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
        continue;
      }
      const sidebar = STATE_SIDEBAR[state];
      statusUpdates.push({
        key: agentId,
        value: statusValue,
        icon: sidebar.icon,
        color: sidebar.color,
        surface: boundSurfaceRef,
        workspace: boundWorkspaceId ?? undefined,
      });
    }
    const nextSnapshot = {
      ...statusSnapshot,
      healthSignature:
        shouldNotifyHealth && !healthNotificationDelivered
          ? (prev?.healthSignature ?? "pending_health_notification")
          : statusSnapshot.healthSignature,
    };
    if (statusChanged) {
      pendingStatusSnapshots.push({ agentId, snapshot: nextSnapshot });
    } else {
      if (!this.assertSweepInputCurrent(sweepCtx)) return;
      this.sidebarSnapshot.set(agentId, nextSnapshot);
    }

    // Quality tracking: check context usage for non-terminal agents
    // AIDEV-NOTE: Uses parseScreen for model-aware context_pct (handles Claude, Codex, Gemini).
    // Replaces legacy parseContextPercent which only matched "X% context" text patterns.
    if (!TERMINAL_STATES.has(state)) {
      try {
        const screenText =
          taskDoneResult.screenText ??
          (await this.readSweepScreen(agent, sweepCtx)).text;
        const parsed = parseScreen(tailScreenLines(screenText, 5));
        const contextPct = parsed.context_pct;
        if (
          contextPct !== null &&
          contextPct >= 80 &&
          agent.quality !== "degraded"
        ) {
          if (!this.assertSweepInputCurrent(sweepCtx)) return;
          // Mark degraded
          const updated = this.stateMgr.updateRecord(agentId, {
            quality: "degraded",
          });
          this.registry.set(agentId, updated);

          try {
            await this.client.log(
              `context-limit: depth ${agent.spawn_depth} agent ${agent.repo} degraded at ${contextPct}%; leaving pane running for orchestrator decision`,
              { level: "warning", source: "cmuxlayer" },
            );
          } catch {
            // Logging is advisory; a root-agent nudge must still be attempted.
          }

          if (agent.spawn_depth === 0) {
            const nudgeRoute = await this.resolveAgentIoRoute(agentId);
            await this.client.send(
              nudgeRoute.surface_id,
              `[cmuxlayer] context at ${contextPct}% — checkpoint at-risk work and /compact when safe`,
              {
                workspace: nudgeRoute.workspace_id ?? undefined,
                ...this.stableSurfaceWriteOptions(nudgeRoute.surface_uuid),
                beforeMutation: async () => {
                  await this.resolveUnchangedAgentIoRoute(
                    agentId,
                    nudgeRoute,
                    "context-limit nudge",
                  );
                },
              },
            );
          }
        }
      } catch {
        // readScreen failures are non-fatal — next sweep will retry
      }
    }

    if (
      state !== "booting" &&
      !TERMINAL_STATES.has(state) &&
      (await this.registry.isSurfaceAlive(agent, {
        surfaces: surfaceTopology?.surfaces,
      }))
    ) {
      if (!this.assertSweepInputCurrent(sweepCtx)) return;
      const heartbeat = this.stateMgr.updateRecord(agentId, {});
      this.registry.set(agentId, heartbeat);
    }
    const completedRow = this.registry.get(agentId);
    if (completedRow) {
      rowVersions.set(agentId, {
        version: completedRow.version,
        surface_id: completedRow.surface_id,
        surface_uuid: completedRow.surface_uuid,
      });
    }
    if (sweepContext.sweep) {
      // Resolved I/O promises otherwise chain through microtasks for the
      // whole fleet, delaying inbound socket reads and timers until the sweep
      // ends. One event-loop turn between agents admits client requests.
      if (this.lifecycleLockQueueDepth > 0 && sweepContext.withUnlocked) {
        await sweepContext.withUnlocked(() => scheduler.yield());
      } else {
        await scheduler.yield();
      }
    }
  }

  if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
    return;
  }

  const rowIsCurrent = (agentId: string): boolean => {
    if (!sweepContext.sweep) return true;
    const snapshot = rowVersions.get(agentId);
    if (!snapshot) return false;
    const registryRow = this.registry.get(agentId);
    return Boolean(registryRow &&
      registryRow.version === snapshot.version &&
      registryRow.surface_id === snapshot.surface_id &&
      registryRow.surface_uuid === snapshot.surface_uuid);
  };
  const currentStatusUpdates = statusUpdates.filter((update) => rowIsCurrent(update.key));
  const appliedStatusKeys = await this.publishSweepStatus(
    sweepContext,
    currentStatusUpdates,
  );
  if (
    currentStatusUpdates.length > 0 &&
    !this.assertSweepInputCurrent(sweepContext)
  ) {
    return;
  }
  for (const pending of pendingStatusSnapshots) {
    if (appliedStatusKeys.has(pending.agentId) && rowIsCurrent(pending.agentId)) {
      this.sidebarSnapshot.set(pending.agentId, pending.snapshot);
    }
  }

  // Clean up sidebar entries for agents that were purged from the registry
  const currentAgentIds = new Set(
    this.registry.list().map((a) => a.agent_id),
  );
  for (const [agentId, snapshot] of this.sidebarSnapshot) {
    if (!currentAgentIds.has(agentId)) {
      if (snapshotMutationAllowed && !snapshotMutationAllowed()) {
        return;
      }
      try {
        await this.client.clearStatus(agentId, {
          workspace: snapshot.workspaceId ?? undefined,
        });
      } catch {
        // Best-effort sidebar cleanup
      }
      if (!this.assertSweepInputCurrent(sweepContext)) return;
      this.sidebarSnapshot.delete(agentId);
      this.clearAgentLifecycleMemory(agentId);
    }
  }

}
