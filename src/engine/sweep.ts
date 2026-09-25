/**
 * The reconciliation sweep: scheduling, phases, startup purge and the best-effort side sweeps. Moved verbatim from agent-engine.ts (CX-3 E9).
 */

import type { AgentEngine } from "../agent-engine.js";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { scheduler } from "node:timers/promises";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
} from "../agent-registry.js";
import type { AgentRecord, CloseForensicsEvent } from "../agent-types.js";
import { getTransportHealth } from "../cmux-transport-self-heal.js";
import {
  DEFAULT_CHANNEL_MARKER_RETENTION_MS,
  agentDir,
  reapOrphanedPendingChannelMarkers,
} from "../inbox.js";
import {
  type WatchOwnerResolution,
  canonicalAgentId,
  canonicalAgentIdValue,
  resolveWatchOwnerFromSources,
  watchOwnerIncludesCanonical,
  watchRecordOwner,
} from "../watch-owner.js";
import {
  type WatchRecord,
  isInterruptedEngineDeadlineClaim,
  readWatchRegistry,
  removeWatches,
  sweepWatches,
} from "../watch-spec.js";
import {
  CHANNEL_MARKER_REAP_INTERVAL_MS,
  CHANNEL_MARKER_REAP_RETRY_MS,
  DEFAULT_SWEEP_ACTIVE_INTERVAL_MS,
  DEFAULT_SWEEP_IDLE_AFTER_SWEEPS,
  DEFAULT_SWEEP_IDLE_INTERVAL_MS,
  type SweepAgentContext,
  type SweepMutationSkipAccounting,
  type SweepTimingInput,
  type SweepTimingOptions,
  TERMINAL_STATES,
} from "./types.js";
import { parseNonNegativeInteger, parsePositiveInteger } from "./env.js";
import { LoopStallMonitor } from "./loop-stall.js";


export function isSubjectSideReportWatchPruneEligible(
  watch: Pick<WatchRecord, "target_kind" | "change" | "provenance">,
): boolean {
  return (
    watch.provenance !== "public" &&
    watch.target_kind === "file" &&
    watch.change === "content"
  );
}

export function resolveSweepTiming(
  env: NodeJS.ProcessEnv = process.env,
  input?: SweepTimingInput,
): SweepTimingOptions {
  if (typeof input === "number") {
    return {
      activeIntervalMs: input,
      idleIntervalMs: parsePositiveInteger(
        env.CMUXLAYER_SWEEP_IDLE_INTERVAL_MS,
        DEFAULT_SWEEP_IDLE_INTERVAL_MS,
      ),
      idleAfterSweeps: parseNonNegativeInteger(
        env.CMUXLAYER_SWEEP_IDLE_AFTER_SWEEPS,
        DEFAULT_SWEEP_IDLE_AFTER_SWEEPS,
      ),
    };
  }

  const activeIntervalMs =
    input?.activeIntervalMs ??
    parsePositiveInteger(
      env.CMUXLAYER_SWEEP_INTERVAL_MS,
      DEFAULT_SWEEP_ACTIVE_INTERVAL_MS,
    );
  const idleIntervalMs =
    input?.idleIntervalMs ??
    parsePositiveInteger(
      env.CMUXLAYER_SWEEP_IDLE_INTERVAL_MS,
      DEFAULT_SWEEP_IDLE_INTERVAL_MS,
    );
  const idleAfterSweeps =
    input?.idleAfterSweeps ??
    parseNonNegativeInteger(
      env.CMUXLAYER_SWEEP_IDLE_AFTER_SWEEPS,
      DEFAULT_SWEEP_IDLE_AFTER_SWEEPS,
    );

  return {
    activeIntervalMs,
    idleIntervalMs,
    idleAfterSweeps,
  };
}

/**
 * The engine surface these functions read and drive. AgentEngine builds it
 * once (sweepHost()); fields are live getters and methods forward to the
 * engine, so spies on the engine still intercept.
 */
export interface SweepHost {
  childReportWatchPrunePending: AgentEngine["childReportWatchPrunePending"];
  readonly client: AgentEngine["client"];
  readonly closeForensicsRunner: AgentEngine["closeForensicsRunner"];
  closeForensicsSweepInFlight: AgentEngine["closeForensicsSweepInFlight"];
  currentSweepScreenSignatures: AgentEngine["currentSweepScreenSignatures"];
  readonly inboxOpts: AgentEngine["inboxOpts"];
  lastChannelMarkerReapAt: AgentEngine["lastChannelMarkerReapAt"];
  lastChannelMarkerReapFailureAt: AgentEngine["lastChannelMarkerReapFailureAt"];
  lastSweepSignature: AgentEngine["lastSweepSignature"];
  readonly lifecycleLockHolder: AgentEngine["lifecycleLockHolder"];
  readonly outboxDrain: AgentEngine["outboxDrain"];
  outboxDrainInFlight: AgentEngine["outboxDrainInFlight"];
  readonly registry: AgentEngine["registry"];
  readonly sidebarSnapshot: AgentEngine["sidebarSnapshot"];
  startupPurgePending: AgentEngine["startupPurgePending"];
  readonly startupPurgeRetainedAgentIds: AgentEngine["startupPurgeRetainedAgentIds"];
  readonly stateMgr: AgentEngine["stateMgr"];
  sweepBackgroundProcessSnapshot: AgentEngine["sweepBackgroundProcessSnapshot"];
  readonly sweepDebugLog: AgentEngine["sweepDebugLog"];
  sweepSkippedMutations: AgentEngine["sweepSkippedMutations"];
  sweepSkippedReason: AgentEngine["sweepSkippedReason"];
  sweepTelemetrySeq: AgentEngine["sweepTelemetrySeq"];
  sweepTimer: AgentEngine["sweepTimer"];
  sweepTiming: AgentEngine["sweepTiming"];
  sweepTopologyGeneration: AgentEngine["sweepTopologyGeneration"];
  unchangedSweepCount: AgentEngine["unchangedSweepCount"];
  readonly watchAgentObservation: AgentEngine["watchAgentObservation"];
  readonly watchNotify: AgentEngine["watchNotify"];
  readonly watchRegistryNow: AgentEngine["watchRegistryNow"];
  readonly watchRegistryPath: AgentEngine["watchRegistryPath"];
  watchSweepInFlight: AgentEngine["watchSweepInFlight"];
  assertSweepInputCurrent: AgentEngine["assertSweepInputCurrent"];
  collectObservedSurfaceTopology: AgentEngine["collectObservedSurfaceTopology"];
  completeBenchmarkSweepHold: AgentEngine["completeBenchmarkSweepHold"];
  countSkippedSweepTick: AgentEngine["countSkippedSweepTick"];
  drainDeliveryQueue: AgentEngine["drainDeliveryQueue"];
  drainOutboxBestEffort: AgentEngine["drainOutboxBestEffort"];
  evictSurfacelessForSweep: AgentEngine["evictSurfacelessForSweep"];
  holdBenchmarkSweepIfArmed: AgentEngine["holdBenchmarkSweepIfArmed"];
  markIntentionalSurfaceCloses: AgentEngine["markIntentionalSurfaceCloses"];
  nextSweepIntervalMs: AgentEngine["nextSweepIntervalMs"];
  pruneClosedChildReportWatches: AgentEngine["pruneClosedChildReportWatches"];
  purgeStartupTerminalAgents: AgentEngine["purgeStartupTerminalAgents"];
  purgeTerminalForSweep: AgentEngine["purgeTerminalForSweep"];
  reapChannelMarkersBestEffort: AgentEngine["reapChannelMarkersBestEffort"];
  reconcileAgents: AgentEngine["reconcileAgents"];
  reconcileRolePlacements: AgentEngine["reconcileRolePlacements"];
  recordSweepStability: AgentEngine["recordSweepStability"];
  retryClosedChildReportWatchPrune: AgentEngine["retryClosedChildReportWatchPrune"];
  retryDeferredTranscriptCaptures: AgentEngine["retryDeferredTranscriptCaptures"];
  runCloseForensicsBestEffort: AgentEngine["runCloseForensicsBestEffort"];
  runLifecycleMutation: AgentEngine["runLifecycleMutation"];
  runSweep: AgentEngine["runSweep"];
  runSweepOnce: AgentEngine["runSweepOnce"];
  scheduleClosedChildReportWatchPrune: AgentEngine["scheduleClosedChildReportWatchPrune"];
  shouldYieldSweep: AgentEngine["shouldYieldSweep"];
  sweepStateSignature: AgentEngine["sweepStateSignature"];
  sweepWatchesBestEffort: AgentEngine["sweepWatchesBestEffort"];
  verifyPendingDeliveries: AgentEngine["verifyPendingDeliveries"];
}

/**
 * A daemon restart must not re-arm watches whose owner is confirmed dead, or
 * report watches whose child is already closed or no longer belongs to the
 * recorded parent. Owner aliases use delivery-style exact/seat/prefix
 * resolution and retain on zero or multiple matches. New report rows carry
 * subject_agent_id; legacy rows are pruned only when their target exactly
 * matches a persisted child's engine-issued report_path.
 */
export async function pruneClosedChildReportWatches(this: SweepHost): Promise<boolean> {
  if (!this.watchRegistryPath) return false;
  const agents = this.registry.list();
  const pruneObservedAt = this.watchRegistryNow?.() ?? Date.now();
  const persistedAgents = this.stateMgr.listStates();
  const byReportPath = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    if (!agent.report_path) continue;
    const path = resolve(agent.report_path);
    byReportPath.set(path, [...(byReportPath.get(path) ?? []), agent]);
  }
  const persistedWatches = readWatchRegistry({
    registryPath: this.watchRegistryPath,
  }).watches;
  const persistedWatchSnapshots = new Map(
    persistedWatches.map((watch) => [watch.watch_id, JSON.stringify(watch)]),
  );
  const subjectIdsByWatch = new Map<string, string[]>();
  const missingLegacyStateWatchIds = new Set<string>();
  const channelBaseDir = resolve(
    dirname(agentDir("__cmuxlayer_channel_probe__", this.inboxOpts)),
  );
  for (const watch of persistedWatches) {
    if (watch.target_kind !== "file" || watch.change !== "content") continue;
    let subjects = watch.subject_agent_id
      ? [
          this.registry.get(watch.subject_agent_id) ??
            this.stateMgr.readState(watch.subject_agent_id),
        ].filter((subject): subject is AgentRecord => Boolean(subject))
      : (byReportPath.get(resolve(watch.target)) ?? []);
    if (subjects.length === 0 && !watch.subject_agent_id) {
      const targetDir = resolve(dirname(watch.target));
      // Provenance-absent rows are legacy engine watches only inside the
      // exact <channelBaseDir>/<agentId>/report.md shape. Arbitrary public
      // file watches from before provenance existed must never enter it.
      const targetLooksEngineIssued =
        basename(watch.target) === "report.md" &&
        resolve(dirname(targetDir)) === channelBaseDir;
      if (targetLooksEngineIssued) {
        const inferredAgentId = basename(targetDir);
        const inferred =
          this.registry.get(inferredAgentId) ??
          this.stateMgr.readState(inferredAgentId);
        if (inferred) subjects = [inferred];
        else if (!this.stateMgr.hasStateFile(inferredAgentId)) {
          missingLegacyStateWatchIds.add(watch.watch_id);
        }
      }
    }
    subjectIdsByWatch.set(watch.watch_id, [
      ...new Set(subjects.map((subject) => subject.agent_id)),
    ]);
  }
  const ownerResolutionByWatch = new Map<
    string,
    WatchOwnerResolution<AgentRecord>
  >();
  for (const watch of persistedWatches) {
    ownerResolutionByWatch.set(
      watch.watch_id,
      resolveWatchOwnerFromSources(
        watchRecordOwner(watch),
        agents,
        persistedAgents,
      ),
    );
  }
  const liveAgentIds = new Set<string>();
  const candidateAgentIds = new Set([
    ...[...subjectIdsByWatch.values()].flat(),
    ...[...ownerResolutionByWatch.values()].flatMap((resolution) =>
      resolution.canonical_id
        ? [canonicalAgentIdValue(resolution.canonical_id)]
        : [],
    ),
  ]);
  await Promise.all(
    [...candidateAgentIds].map(async (agentId) => {
      const subject =
        this.registry.get(agentId) ?? this.stateMgr.readState(agentId);
      if (
        subject &&
        subject.user_killed !== true &&
        !subject.deletion_intent &&
        (await this.registry.isSurfaceAlive(subject))
      ) {
        liveAgentIds.add(agentId);
      }
    }),
  );
  let retainedNeedsRecheck = false;
  await removeWatches(
    (watch) => {
      if (watch.notification_pending) {
        retainedNeedsRecheck = true;
        return false;
      }
      if (isInterruptedEngineDeadlineClaim(watch)) {
        retainedNeedsRecheck = true;
        return false;
      }
      // The predicate runs under the watch-registry write lock. If a sweep
      // changed this row after our snapshot, retain it for the next prune.
      if (
        persistedWatchSnapshots.get(watch.watch_id) !== JSON.stringify(watch)
      ) {
        retainedNeedsRecheck = true;
        return false;
      }
      if (watch.state === "failed" && !watch.notification_pending) {
        return (watch.waiter_expires_at_ms ?? 0) <= pruneObservedAt;
      }
      const ownerResolution = ownerResolutionByWatch.get(watch.watch_id);
      // Raw owner keys are not identities. Zero and multiple matches retain
      // fail-safe; a subject can still prove that an ambiguous alias includes
      // its canonical parent, but ambiguity cannot authorize deletion.
      if (!ownerResolution) return false;
      const subjects = (subjectIdsByWatch.get(watch.watch_id) ?? [])
        .map(
          (subjectAgentId) =>
            this.registry.get(subjectAgentId) ??
            this.stateMgr.readState(subjectAgentId),
        )
        .filter((subject): subject is AgentRecord => Boolean(subject));
      const hasActiveSubjectOwnership = subjects.some(
        (subject) =>
          subject.user_killed !== true &&
          !subject.deletion_intent &&
          (!TERMINAL_STATES.has(subject.state) ||
            liveAgentIds.has(subject.agent_id)) &&
          Boolean(
            subject.parent_agent_id &&
              watchOwnerIncludesCanonical(
                ownerResolution,
                canonicalAgentId(subject.parent_agent_id),
              ),
          ),
      );
      const ownerAgentId = ownerResolution.canonical_id
        ? canonicalAgentIdValue(ownerResolution.canonical_id)
        : null;
      const ownerRecord = ownerAgentId
        ? (this.registry.get(ownerAgentId) ??
          this.stateMgr.readState(ownerAgentId))
        : null;
      // A live child still owns its report path even if its parent pane is
      // gone. Preserve that reservation; dead-owner pruning is destructive
      // only when no active subject ownership remains.
      if (
        ownerRecord &&
        ownerAgentId &&
        !liveAgentIds.has(ownerAgentId) &&
        (ownerRecord.user_killed === true ||
          Boolean(ownerRecord.deletion_intent) ||
          TERMINAL_STATES.has(ownerRecord.state)) &&
        !hasActiveSubjectOwnership
      ) {
        return true;
      }
      // Owner death and subject death answer different questions. A
      // confirmed-dead owner makes every watch kind undeliverable, including
      // marker and agent watches. Subject-side lifecycle pruning is narrower
      // and may only inspect report-content rows.
      if (!isSubjectSideReportWatchPruneEligible(watch)) return false;
      if (
        subjects.length === 0 &&
        missingLegacyStateWatchIds.has(watch.watch_id)
      ) {
        return true;
      }
      if (subjects.length === 0) return Boolean(watch.subject_agent_id);
      if (ownerResolution.kind !== "resolved") return false;
      return !hasActiveSubjectOwnership;
    },
    { registryPath: this.watchRegistryPath },
  );
  return retainedNeedsRecheck;
}

export function scheduleClosedChildReportWatchPrune(this: SweepHost): void {
  if (this.watchRegistryPath) this.childReportWatchPrunePending = true;
}

export async function retryClosedChildReportWatchPrune(this: SweepHost): Promise<void> {
  if (!this.childReportWatchPrunePending) return;
  this.childReportWatchPrunePending = false;
  try {
    if (await this.pruneClosedChildReportWatches()) {
      this.childReportWatchPrunePending = true;
    }
  } catch (error) {
    this.childReportWatchPrunePending = true;
    this.sweepDebugLog(
      `[cmuxlayer] child report watch prune deferred: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function purgeStartupTerminalAgents(
  this: SweepHost,
  ctx: SweepAgentContext = {},
): Promise<void> {
  if (!this.assertSweepInputCurrent(ctx)) return;
  if (!this.startupPurgePending) return;
  this.startupPurgePending = false;
  const retainedAgentIds = new Set(this.startupPurgeRetainedAgentIds);
  for (const agent of this.registry.list()) {
    if (agent.transcript_session_capture_deferred === true) {
      retainedAgentIds.add(agent.agent_id);
    }
  }
  const purgedIds = this.registry.purgeAllTerminal({
    retainAgentIds: retainedAgentIds,
  });
  this.startupPurgeRetainedAgentIds.clear();
  try {
    await this.client.clearProgress();
  } catch {
    // Best-effort cleanup of the removed workspace-less progress row.
  }
  // Seed sidebar snapshot so reconcileAgents clears their cmux entries.
  for (const purgedAgent of purgedIds) {
    this.sidebarSnapshot.set(purgedAgent.agent_id, {
      statusValue: "__purged__",
      surfaceId: purgedAgent.surface_id,
      workspaceId: purgedAgent.workspace_id ?? null,
      healthSignature: "__purged__",
    });
  }
}

export async function evictSurfacelessForSweep(
  this: SweepHost,
  ctx: SweepAgentContext,
  observed: Parameters<AgentRegistry["evictSurfaceless"]>[0],
): Promise<void> {
  if (!this.assertSweepInputCurrent(ctx)) return;
  await this.registry.evictSurfaceless(observed);
}

export async function purgeTerminalForSweep(
  this: SweepHost,
  ctx: SweepAgentContext,
  observed: Parameters<AgentRegistry["purgeTerminal"]>[0],
): Promise<void> {
  if (!this.assertSweepInputCurrent(ctx)) return;
  await this.registry.purgeTerminal(observed);
}

export function removeStateForSweep(
  this: SweepHost,
  ctx: SweepAgentContext,
  agentId: string,
): boolean {
  if (!this.assertSweepInputCurrent(ctx)) return false;
  this.stateMgr.removeState(agentId);
  return true;
}
export async function runSweep(this: SweepHost): Promise<void> {
  await this.runLifecycleMutation(async (withUnlocked) => {
    const benchmarkHoldToken = await this.holdBenchmarkSweepIfArmed();
    try {
      await this.runSweepOnce(withUnlocked);
    } finally {
      // AIDEV-NOTE: #791 — the benchmark's warm send waits for "complete".
      // Reporting it before the released sweep body ran put every warm
      // sample inside a live sweep. Still inside the lock, so the
      // close-during-sweep waiter's timing is unchanged.
      if (benchmarkHoldToken) this.completeBenchmarkSweepHold(benchmarkHoldToken);
    }
  }, {
    label: "sweep",
  });
  await this.drainDeliveryQueue();
  await this.verifyPendingDeliveries();
}

export function completeBenchmarkSweepHold(this: SweepHost, token: string): void {
  const statePath =
    process.env.CMUXLAYER_BENCH_SWEEP_HOLD_STATE?.trim() ?? "";
  if (!statePath) return;
  writeFileSync(statePath, JSON.stringify({ token, state: "complete" }));
}

export async function holdBenchmarkSweepIfArmed(this: SweepHost): Promise<string | null> {
  const statePath =
    process.env.CMUXLAYER_BENCH_SWEEP_HOLD_STATE?.trim() ?? "";
  if (!statePath) return null;

  let armed: { token?: unknown; state?: unknown };
  try {
    armed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
  if (armed.state !== "armed" || typeof armed.token !== "string") return null;

  const token = armed.token;
  writeFileSync(statePath, JSON.stringify({ token, state: "held" }));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const current = JSON.parse(readFileSync(statePath, "utf8"));
      if (current.token === token && current.state === "release") {
        return token;
      }
    } catch {
      // The benchmark owns this opt-in state file and may be between writes.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`benchmark lifecycle sweep hold timed out: ${token}`);
}
export async function runSweepOnce(
  this: SweepHost,
  withUnlocked: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<void> {
  this.sweepBackgroundProcessSnapshot = null;
  const timings: Record<string, number> = {};
  const sweepStartedAt = Date.now();
  // #810 reopen signal: the longest event-loop stall during this sweep.
  const loopStall = new LoopStallMonitor();
  loopStall.start();
  const sweepId = ++this.sweepTelemetrySeq;
  let sweepCompleted = false;
  let failedPhase: string | null = null;
  const slowPhaseThresholdMs = 250;
  const time = async <T>(
    name: string,
    operation: () => Promise<T>,
    lockHeldOverride?: boolean,
  ) => {
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    const agentCount = this.registry.list().length;
    const lockHeld =
      lockHeldOverride ?? (name !== "reconcile_ms" && this.lifecycleLockHolder === "sweep");
    const appendPhase = (
      stage: "started" | "completed" | "failed",
      durationMs: number | null,
    ) => {
      try {
        this.stateMgr.getEventLog().appendSweepPhase({
          ts: new Date().toISOString(),
          event_type: "sweep_phase",
          process_id: process.pid,
          sweep_id: sweepId,
          phase: name,
          stage,
          started_at: startedAtIso,
          duration_ms: durationMs,
          agent_count: agentCount,
          lock_held: lockHeld,
        });
      } catch {
        // Telemetry must not block reconciliation when the log is unavailable.
      }
    };
    // Delay the durable in-progress breadcrumb until the phase is actually
    // slow. Fast phases need only the one sweep summary row.
    const slowStartTimer = setTimeout(
      () => appendPhase("started", null),
      slowPhaseThresholdMs,
    );
    slowStartTimer.unref?.();
    try {
      const result = await operation();
      const durationMs = Date.now() - startedAt;
      if (durationMs >= slowPhaseThresholdMs) {
        appendPhase("completed", durationMs);
      }
      return result;
    } catch (error) {
      failedPhase = name;
      appendPhase("failed", Date.now() - startedAt);
      throw error;
    } finally {
      clearTimeout(slowStartTimer);
      timings[name] = Date.now() - startedAt;
    }
  };
  try {
    const skipAccounting: SweepMutationSkipAccounting = { counted: false };
    this.currentSweepScreenSignatures = new Map();
    const surfaceTopology = await time(
      "topology_ms",
      () => withUnlocked(() => this.collectObservedSurfaceTopology()),
      false,
    );
    this.sweepTopologyGeneration += 1;
    if (surfaceTopology) {
      surfaceTopology.generation = this.sweepTopologyGeneration;
    }
    const sweepCtx: SweepAgentContext = {
      sweep: true,
      withUnlocked,
      surfaceTopology,
      topologyGeneration: surfaceTopology?.generation,
      skipAccounting,
    };
    const yieldToWaiters = async (): Promise<void> => {
      if (this.shouldYieldSweep()) {
        await withUnlocked(() => scheduler.yield());
      }
    };
    const transportHealth = getTransportHealth(this.client);
    const topologyIsAuthoritative =
      surfaceTopology?.complete === true &&
      surfaceTopology.surfaces.length > 0;
    const mutationsAreSafe =
      topologyIsAuthoritative &&
      transportHealth?.mode === "socket" &&
      transportHealth.degraded === false;
    if (mutationsAreSafe) {
      this.sweepSkippedMutations = 0;
      this.sweepSkippedReason = null;
    }
    const observedSurfaces = topologyIsAuthoritative
      ? surfaceTopology.surfaces
      : undefined;
    // Reuse the resync path's authoritative-safe ghost eviction on every sweep,
    // but require one confirmation window after the surface is first observed
    // absent. The same gate also applies to terminal worker cleanup below.
    // This absorbs cmux's short post-create topology lag without retaining old
    // ghosts indefinitely. Empty or failed enumeration remains inconclusive.
    const surfacelessConfirmation = {
      confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
      now: Date.now(),
    };
    await time("close_forensics_ms", () =>
      this.runCloseForensicsBestEffort(sweepCtx),
    );
    await yieldToWaiters();
    await time("channel_markers_ms", () =>
      this.reapChannelMarkersBestEffort(),
    );
    await yieldToWaiters();
    if (mutationsAreSafe) {
      const observed = {
        ...surfacelessConfirmation,
        ...(observedSurfaces ? { surfaces: observedSurfaces } : {}),
      };
      if (this.assertSweepInputCurrent(sweepCtx)) {
        await time("registry_reconcile_ms", () =>
          this.registry.reconcile(observed),
        );
      }
      await yieldToWaiters();
      if (this.assertSweepInputCurrent(sweepCtx)) {
        await time("evict_ms", () =>
          this.evictSurfacelessForSweep(sweepCtx, observed),
        );
      }
      await yieldToWaiters();
      if (this.assertSweepInputCurrent(sweepCtx)) {
        await time("startup_purge_ms", () =>
          this.purgeStartupTerminalAgents(sweepCtx),
        );
      }
    } else {
      this.countSkippedSweepTick(skipAccounting, "transport_degraded");
    }

    // Deferred transcript identity does not require a live surface binding.
    // Retry after the one-shot startup purge has retained marked rows, but
    // before normal terminal cleanup can act on a closed pane.
    await time("transcript_ms", () => this.retryDeferredTranscriptCaptures());
    await yieldToWaiters();
    await time("watches_ms", async () => {
      await this.retryClosedChildReportWatchPrune();
      await this.sweepWatchesBestEffort(withUnlocked, sweepCtx);
    });
    await yieldToWaiters();
    if (mutationsAreSafe && this.assertSweepInputCurrent(sweepCtx)) {
      await time("terminal_purge_ms", () =>
        this.purgeTerminalForSweep(sweepCtx, {
          ...surfacelessConfirmation,
          ...(observedSurfaces ? { surfaces: observedSurfaces } : {}),
        }),
      );
    }
    await yieldToWaiters();
    if (mutationsAreSafe && this.assertSweepInputCurrent(sweepCtx)) {
      await time("placements_ms", () =>
        this.reconcileRolePlacements("idle", {
          surfaceTopology,
          sweepContext: sweepCtx,
        }),
      );
    }
    await yieldToWaiters();
    if (!mutationsAreSafe) {
      await time("reconcile_ms", () =>
        this.reconcileAgents({}, null, undefined, sweepCtx),
      );
    } else if (this.assertSweepInputCurrent(sweepCtx)) {
      await time("reconcile_ms", () =>
        this.reconcileAgents(
          {},
          surfaceTopology,
          () => this.assertSweepInputCurrent(sweepCtx),
          sweepCtx,
        ),
      );
    }
    await yieldToWaiters();
    await time("outbox_ms", () => this.drainOutboxBestEffort());
    sweepCompleted = true;
  } finally {
    this.sweepBackgroundProcessSnapshot = null;
    timings.total_ms = Date.now() - sweepStartedAt;
    const loopStallMaxMs = loopStall.stop();
    try {
      this.stateMgr.getEventLog().appendSweepPhase({
        ts: new Date().toISOString(),
        event_type: "sweep_phase",
        process_id: process.pid,
        sweep_id: sweepId,
        phase: "summary",
        stage: sweepCompleted ? "completed" : "failed",
        ...(!sweepCompleted ? { failed_phase: failedPhase ?? "unknown" } : {}),
        started_at: new Date(sweepStartedAt).toISOString(),
        duration_ms: timings.total_ms,
        agent_count: this.registry.list().length,
        lock_held: false,
        durations_ms: timings,
        loop_stall_max_ms: loopStallMaxMs,
      });
    } catch {
      // Telemetry is best-effort and cannot fail the sweep.
    }
    this.sweepDebugLog(
      `[cmuxlayer] sweep timing ${Object.entries(timings)
        .map(([name, value]) => `${name}=${value}`)
        .join(" ")}`,
    );
  }
}

export async function reapChannelMarkersBestEffort(this: SweepHost): Promise<void> {
  if (!this.inboxOpts) return;
  const now = Date.now();
  if (
    this.lastChannelMarkerReapAt !== null &&
    now - this.lastChannelMarkerReapAt < CHANNEL_MARKER_REAP_INTERVAL_MS
  ) {
    return;
  }
  if (
    this.lastChannelMarkerReapFailureAt !== null &&
    now - this.lastChannelMarkerReapFailureAt < CHANNEL_MARKER_REAP_RETRY_MS
  ) {
    return;
  }
  try {
    const knownAgentIds = new Set([
      ...this.registry.list().map((agent) => agent.agent_id),
      ...this.stateMgr.listStates().map((agent) => agent.agent_id),
    ]);
    const result = reapOrphanedPendingChannelMarkers(knownAgentIds, {
      ...this.inboxOpts,
      now: () => now,
      retentionMs: DEFAULT_CHANNEL_MARKER_RETENTION_MS,
    });
    if (result.errors > 0) {
      this.lastChannelMarkerReapFailureAt = now;
    } else {
      this.lastChannelMarkerReapAt = now;
      this.lastChannelMarkerReapFailureAt = null;
    }
    if (result.reaped > 0 || result.errors > 0) {
      await this.client.log(
        `channel-marker reaper: reaped=${result.reaped} retained_known=${result.retained_known} retained_young=${result.retained_young} errors=${result.errors}`,
        {
          level: result.errors > 0 ? "warning" : "info",
          source: "agent-engine",
        },
      );
    }
  } catch {
    this.lastChannelMarkerReapFailureAt = now;
    // Marker cleanup is maintenance; lifecycle reconciliation must continue.
  }
}

/**
 * Ingest cmux's own app-level close events before lifecycle reconciliation.
 * A `tab_close` or `workspace_teardown` carries the operator intent that a
 * matching managed surface is terminal; persist that intent before absence
 * can become a recoverable crash. Forensics remains best-effort and never
 * breaks the sweep.
 */
export async function runCloseForensicsBestEffort(
  this: SweepHost,
  ctx: SweepAgentContext,
): Promise<void> {
  if (!this.closeForensicsRunner) return;
  if (this.closeForensicsSweepInFlight) return;
  this.closeForensicsSweepInFlight = true;
  try {
    const result = await this.closeForensicsRunner();
    this.markIntentionalSurfaceCloses(result.events, ctx);
  } catch {
    // Never break the sweep on a forensics failure; it retries next sweep.
  } finally {
    this.closeForensicsSweepInFlight = false;
  }
}

export function markIntentionalSurfaceCloses(
  this: SweepHost,
  events: CloseForensicsEvent[],
  ctx: SweepAgentContext,
): void {
  if (!this.assertSweepInputCurrent(ctx)) return;
  const closedSurfaceUuids = new Set(
    events
      .filter(
        (event) =>
          (event.origin === "tab_close" ||
            event.origin === "workspace_teardown") &&
          typeof event.cmux_surface_id === "string",
      )
      .map((event) => event.cmux_surface_id!.toLowerCase()),
  );
  if (closedSurfaceUuids.size === 0) return;

  for (const agent of this.registry.list()) {
    const surfaceUuid = agent.surface_uuid?.toLowerCase();
    if (
      !surfaceUuid ||
      !closedSurfaceUuids.has(surfaceUuid) ||
      agent.user_killed === true
    ) {
      continue;
    }
    try {
      const terminal = this.stateMgr.updateRecord(agent.agent_id, {
        user_killed: true,
      });
      this.registry.set(agent.agent_id, terminal);
      this.scheduleClosedChildReportWatchPrune();
    } catch {
      // A concurrently removed record cannot be recovered, so no suppression
      // is needed. Preserve best-effort lifecycle reconciliation.
    }
  }
}

export async function sweepWatchesBestEffort(
  this: SweepHost,
  withUnlocked?: <T>(operation: () => Promise<T>) => Promise<T>,
  sweepContext?: SweepAgentContext,
): Promise<void> {
  if (!this.watchRegistryPath || this.watchSweepInFlight) return;
  this.watchSweepInFlight = true;
  try {
    await sweepWatches({
      registryPath: this.watchRegistryPath,
      now: this.watchRegistryNow,
      agentObservation: (agentId) =>
        this.watchAgentObservation(agentId, withUnlocked),
      notify: this.watchNotify,
      onNotificationExhausted: ({ notification, attempts, reason }) => {
        this.sweepDebugLog(
          `[cmuxlayer] watch notification exhausted: watch=${notification.watch_id} owner=${notification.owner} attempts=${attempts} reason=${reason}`,
        );
      },
    });
    if (
      readWatchRegistry({ registryPath: this.watchRegistryPath }).watches.some(
        (watch) => watch.state === "failed" && !watch.notification_pending,
      )
    ) {
      this.scheduleClosedChildReportWatchPrune();
    }
  } catch {
    // Declared watches are retried on the next lifecycle sweep.
  } finally {
    this.watchSweepInFlight = false;
  }
}

/**
 * Drain the shared operator outbox to the notify path at the tail of a sweep.
 * Best-effort: any failure is swallowed so a drain never breaks a sweep, and an
 * in-flight guard prevents overlapping drains if a sweep runs long. Exactly-once
 * (no double-send) is owned by drainOutbox's `.outbox-drained.json` sidecar.
 *
 * AIDEV-NOTE: with multiple live agents each running this sweep, the sidecar
 * gives single-process exactly-once + best-effort cross-process dedup (a rare
 * read-before-write race between two agents could double-send one entry). Full
 * cross-process locking is intentionally out of scope for this best-effort path.
 */
export async function drainOutboxBestEffort(this: SweepHost): Promise<void> {
  if (this.outboxDrainInFlight) return;
  this.outboxDrainInFlight = true;
  try {
    await this.outboxDrain();
  } catch {
    // Never break the sweep on a drain failure; it retries next sweep.
  } finally {
    this.outboxDrainInFlight = false;
  }
}

export function sweepStateSignature(this: SweepHost): string {
  const agentSignature = this.registry
    .list()
    .map((agent) =>
      [
        agent.agent_id,
        agent.surface_id,
        agent.workspace_id ?? "",
        agent.state,
        agent.updated_at,
        agent.cli_session_id ?? "",
        agent.task_done_candidate_at ?? "",
        agent.quality ?? "",
      ].join(":"),
    )
    .sort()
    .join("|");
  const screenSignature = [...this.currentSweepScreenSignatures.entries()]
    .map(([agentId, signature]) => `${agentId}:${signature}`)
    .sort()
    .join("|");
  return `${agentSignature}::screens:${screenSignature}`;
}

export function recordSweepStability(this: SweepHost): void {
  const signature = this.sweepStateSignature();
  if (
    this.lastSweepSignature !== null &&
    signature === this.lastSweepSignature
  ) {
    this.unchangedSweepCount += 1;
  } else {
    this.unchangedSweepCount = 0;
  }
  this.lastSweepSignature = signature;
}

export function nextSweepIntervalMs(this: SweepHost): number {
  const timing = this.sweepTiming ?? resolveSweepTiming();
  return this.unchangedSweepCount >= timing.idleAfterSweeps
    ? timing.idleIntervalMs
    : timing.activeIntervalMs;
}

/**
 * Start the reconciliation sweep on an interval.
 */
export function startSweep(this: SweepHost, timingInput?: SweepTimingInput): void {
  if (this.sweepTiming) return;
  this.sweepTiming = resolveSweepTiming(process.env, timingInput);
  this.unchangedSweepCount = 0;
  this.lastSweepSignature = null;

  const runAndSchedule = async () => {
    this.sweepTimer = null;
    try {
      await this.runSweep();
    } catch (e) {
      console.error("[cmuxlayer] sweep failed (will retry):", e);
    } finally {
      this.recordSweepStability();
      if (this.sweepTiming) {
        this.sweepTimer = setTimeout(
          runAndSchedule,
          this.nextSweepIntervalMs(),
        );
      }
    }
  };

  this.sweepTimer = setTimeout(
    runAndSchedule,
    this.sweepTiming.activeIntervalMs,
  );
}
