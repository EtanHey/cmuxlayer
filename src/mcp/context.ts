/**
 * Server context: CreateServerOptions, CmuxServerContext and
 * createServerContext, lifecycle-start timeout handling, control-health
 * interval, auto-vitest temp cleanup, and lifecycle channel metadata. Moved
 * verbatim from server.ts (CX-2 S4); imports nothing from the server.
 */

import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { inboxBaseDir as inboxBaseDirOf } from "../inbox.js";
import { CmuxClient, type ExecFn } from "../cmux-client.js";
import type { CmuxSocketClient } from "../cmux-socket-client.js";
import { type SeatManifestWriter } from "../seat-manifest.js";
import { StateManager } from "../state-manager.js";
import { AgentRegistry } from "../agent-registry.js";
import { deriveCmuxObserverEpoch, deriveCmuxObserverOwnerId } from "../cmux-observer-identity.js";
import type { AgentEngine } from "../agent-engine.js";
import type {
  LifecycleLockState,
  SelfRegistrationSessionEntry,
  SessionIdentityResolver,
  SpawnAgentParams,
} from "../engine/types.js";
import { type DeliveryFailureTicket } from "../delivery-failure-tickets.js";
import { type WatchNotify } from "../watch-spec.js";
import type {
  AgentRole,
  DeliveryEventType,
} from "../agent-types.js";
import { makeCodexRolloutFillProvider, type CodexRolloutFillProvider } from "../codex-rollout-fill.js";
import type { CmuxReadScreenResult } from "../types.js";
import { type CallerContext } from "../caller-context.js";
import { type ControlHealth } from "../control-health.js";
import { type SurfaceTopologySnapshot } from "../surface-topology.js";
import { type WorktreeExec } from "../worktree.js";
import { type SeatRegistry } from "../seat-identity.js";
import { SurfaceWriteLivenessTracker } from "../surface-write-liveness.js";
import type { PublicDeliveryReceipt, DeliveryRecord } from "../delivery/receipts.js";
import { CmuxSocketError } from "../cmux-socket-error.js";
import {
  LifecycleNotReadyError,
  LifecycleStartTimeoutError,
} from "./tool-result.js";

export interface CreateServerOptions {
  exec?: ExecFn;
  bin?: string;
  /** Pre-built client (socket or CLI). If omitted, creates a CLI client. */
  client?: CmuxClient | CmuxSocketClient;
  /** Override stable socket-node ownership derivation (primarily for tests). */
  surfaceObserverOwnerIdProvider?: () => string | null | undefined;
  /** Override transient reconnect/route epoch derivation (primarily for tests). */
  surfaceObserverEpochProvider?: () => string | null | undefined;
  /** Shared server-side world-model reused across many MCP connections. */
  context?: CmuxServerContext;
  /** Base directory for agent state files. Defaults to ~/.local/state/cmux-agents */
  stateDir?: string;
  /** Override lifecycle persistence (primarily for hermetic tests). */
  stateManager?: StateManager;
  /** Override the lifecycle registry paired with stateManager (primarily for tests). */
  lifecycleRegistry?: AgentRegistry;
  /** Override persisted-state reconstitution at lifecycle startup (primarily for tests). */
  lifecycleInitializer?: () => Promise<void>;
  /** Skip agent lifecycle initialization (for testing low-level tools only) */
  skipAgentLifecycle?: boolean;
  /**
   * In-process-only caller identity used by safety gates, never placement.
   * Shared-daemon entrypoints intentionally leave this unset.
   */
  safetyCallerContextProvider?: () => CallerContext | undefined;
  /** Override the per-session resident-tool palette (primarily for entry wiring/tests). */
  defaultPalette?: string;
  /** Override spawn preflight checks (primarily for tests). */
  spawnPreflight?: (params: SpawnAgentParams) => Promise<void>;
  /** Explicitly disable spawn preflight checks (primarily for mocked tests). */
  disableSpawnPreflight?: boolean;
  /** Base directory for agent inbox channels. Defaults to ~/.cmux/agents (primarily for tests). */
  inboxBaseDir?: string;
  /** Override session identity lookup (primarily for mocked tests). */
  sessionIdentityResolver?: SessionIdentityResolver;
  /**
   * PRIMARY session-identity resolver — the self-registration READ side. Threaded
   * to the lifecycle engine as its primary resolver (self-registration first,
   * transcript scan only as fallback). Production entrypoints inject
   * `makeSelfRegistrationSessionResolver()`; unset in tests keeps HOME I/O out.
   */
  selfRegistrationSessionResolver?: SessionIdentityResolver;
  selfRegistrationSessionLookup?: (
    sessionId: string,
  ) => SelfRegistrationSessionEntry | null;
  /** Async, throttled Codex rollout reader (primarily injectable for tests). */
  codexRolloutFillProvider?: CodexRolloutFillProvider;
  /** Override git worktree execution/home for tests. */
  worktreeExec?: WorktreeExec;
  worktreeHomeDir?: string;
  /** Override control health collection (primarily for tests). */
  controlHealthCollector?: () => Promise<ControlHealth>;
  /** Extra warnings surfaced by control_health, e.g. daemon fallback mode. */
  controlHealthWarnings?: string[];
  /** Override seat registry repair/identity lookup (primarily for tests). */
  seatRegistry?: SeatRegistry | null;
  seatRegistryPath?: string;
  /**
   * Override the process-wide stale-build warner (primarily for tests). Returns
   * the loud warning string when this MCP build is stale vs the installed brew
   * build, or null. Defaults to a real, throttled, sticky-once-stale warner.
   */
  staleBuildWarner?: () => string | null;
  /** Periodic control health sample interval. Defaults to env or 60000ms; 0 disables. */
  controlHealthIntervalMs?: number;
  /**
   * Best-effort outbox drain invoked at the tail of each agent-engine sweep.
   * Omitted by default (no-op) so tests never touch the real outbox/network;
   * the real MCP entrypoints pass `defaultOutboxDrain()`, which flushes the
   * fleet outbox to its notify URL when the fleet config enables it.
   */
  outboxDrain?: () => Promise<unknown>;
  /** Canonical persistent WatchSpec registry scanned by the agent engine. */
  watchRegistryPath?: string;
  watchRegistryNow?: () => number;
  watchNotify?: WatchNotify;
  /** Silence deadline for engine-owned child report watches. Defaults to one hour. */
  reportWatchDeadlineMs?: number;
  /**
   * Enable close forensics: ingest cmux's OWN app-level `tab_close` events from
   * `~/.cmuxterm/events.jsonl` and attribute them each sweep. Omitted/false by
   * default so tests never read the real cmux events file; the real MCP
   * entrypoint (index.ts) passes `true`.
   */
  enableCloseForensics?: boolean;
  /** Override per-surface PTY write-liveness tracking (primarily for tests). */
  surfaceWriteLiveness?: SurfaceWriteLivenessTracker;
  /**
   * Publish deliberate per-seat expected state. Tests inject a recorder/no-op;
   * production defaults to the orchestrator-backed filesystem writer.
   */
  seatManifestWriter?: SeatManifestWriter;
  /** Override the manifest timestamp source for deterministic tests. */
  seatManifestNow?: () => string;
  /** Background send_to verify deadline; defaults to 10 minutes. */
  deliveryVerifyDeadlineMs?: number;
  /**
   * Local evidence tickets for failed_confirmed deliveries. Omitted in tests;
   * production createServer injects ~/.cmuxlayer/tickets when not VITEST/NODE_ENV=test.
   */
  deliveryTicketDir?: string;
  /** Optional GitHub/local ticket sink (tests inject a recorder; production injects gh). */
  deliveryIssueFiler?: (ticket: DeliveryFailureTicket) => Promise<void>;
}

export type CmuxLayerClient = CmuxClient | CmuxSocketClient;

export interface ReadScreenSnapshot {
  result: CmuxReadScreenResult;
  topology: SurfaceTopologySnapshot | null;
}

export type LifecycleAgentInputDeliverer = (args: {
  agent_id: string;
  text: string;
  press_enter: boolean;
  allow_busy?: boolean;
  source_event: DeliveryEventType;
  delivery_id?: string;
}) => Promise<PublicDeliveryReceipt & { bytes: number }>;

export const DEFAULT_LIFECYCLE_START_TIMEOUT_MS = 60_000;

export const DEFAULT_REPORT_WATCH_DEADLINE_MS = 60 * 60 * 1_000;

export function resolveLifecycleStartTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CMUXLAYER_LIFECYCLE_START_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_LIFECYCLE_START_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_LIFECYCLE_START_TIMEOUT_MS;
}

export async function awaitBoundedLifecycleStart(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) {
    await promise;
    return;
  }
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LifecycleStartTimeoutError(timeoutMs)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const DEFAULT_LIFECYCLE_RETRY_BASE_MS = 500;
export const DEFAULT_LIFECYCLE_RETRY_MAX_MS = 30_000;
/** How long a daemon connection waits for the first lifecycle outcome. */
export const DEFAULT_LIFECYCLE_CONNECTION_GATE_MS = 10_000;

function positiveIntegerEnv(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Jittered exponential backoff after `failures` failed lifecycle attempts. */
export function resolveLifecycleRetryDelayMs(
  failures: number,
  env: NodeJS.ProcessEnv = process.env,
  random: () => number = Math.random,
): number {
  const baseMs = positiveIntegerEnv(
    env.CMUXLAYER_LIFECYCLE_RETRY_BASE_MS,
    DEFAULT_LIFECYCLE_RETRY_BASE_MS,
  );
  const maxMs = Math.max(
    baseMs,
    positiveIntegerEnv(
      env.CMUXLAYER_LIFECYCLE_RETRY_MAX_MS,
      DEFAULT_LIFECYCLE_RETRY_MAX_MS,
    ),
  );
  const unjittered = Math.min(
    maxMs,
    baseMs * 2 ** Math.max(0, Math.min(30, failures - 1)),
  );
  return Math.max(1, Math.round(unjittered * (0.5 + random() * 0.5)));
}

export function resolveLifecycleConnectionGateMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return positiveIntegerEnv(
    env.CMUXLAYER_LIFECYCLE_CONNECTION_GATE_MS,
    DEFAULT_LIFECYCLE_CONNECTION_GATE_MS,
  );
}

export type LifecycleInitState = "idle" | "initializing" | "ready" | "retrying";

export function lifecycleInitState(
  context: CmuxServerContext,
): LifecycleInitState {
  if (!context.lifecycleStarted) return "idle";
  if (context.lifecycleReady) return "ready";
  if (context.lifecycleStartError) return "retrying";
  // Contexts whose lifecycle promise was installed by hand (tests) have no
  // retry loop; a settled promise without an error is ready.
  return context.lifecycleStartAttempts === 0 &&
    context.lifecycleStartSettledAtMs !== null
    ? "ready"
    : "initializing";
}

function describeLifecycleCause(error: Error): string {
  return error instanceof CmuxSocketError && error.code === "rate_limited"
    ? "rate_limited by cmux"
    : error.message;
}

/**
 * The named error a tool returns while the retry loop is still bringing the
 * lifecycle up, or null when it is ready or not driven by the retry loop.
 */
export function lifecycleNotReadyError(
  context: CmuxServerContext,
): LifecycleNotReadyError | null {
  if (
    !context.lifecycleStarted ||
    context.lifecycleReady ||
    context.lifecycleStartAttempts === 0
  ) {
    return null;
  }
  const attempt = context.lifecycleStartAttempts;
  const error = context.lifecycleStartError;
  return new LifecycleNotReadyError(
    error
      ? `lifecycle initializing: ${describeLifecycleCause(error)}, retrying (attempt ${attempt})`
      : `lifecycle initializing (attempt ${attempt})`,
    attempt,
  );
}

/**
 * #938: run lifecycle initialization until it succeeds. A failed attempt is
 * recorded (never latched) and retried after jittered exponential backoff.
 * `lifecycleStartPromise` resolves once, on the first success;
 * `lifecycleStartFirstOutcome` resolves on the first success or failure so a
 * waiter can stop waiting and name the cause.
 */
export function startLifecycleInitialization(
  context: CmuxServerContext,
  initialize: () => Promise<void>,
): void {
  const generation = context.lifecycleStartGeneration;
  let resolveReady!: () => void;
  let resolveFirstOutcome!: () => void;
  context.lifecycleStarted = true;
  context.lifecycleReady = false;
  context.lifecycleStartError = null;
  context.lifecycleStartAttempts = 0;
  context.lifecycleStartStartedAtMs = Date.now();
  context.lifecycleStartSettledAtMs = null;
  context.lifecycleStartPromise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  context.lifecycleStartFirstOutcome = new Promise<void>((resolve) => {
    resolveFirstOutcome = resolve;
  });
  const current = () => context.lifecycleStartGeneration === generation;
  const attempt = (): void => {
    if (!current()) return;
    context.lifecycleRetryTimer = null;
    context.lifecycleStartAttempts += 1;
    const attemptNumber = context.lifecycleStartAttempts;
    Promise.resolve()
      .then(initialize)
      .then(
        () => {
          if (!current()) return;
          context.lifecycleStartError = null;
          context.lifecycleReady = true;
          context.lifecycleStartSettledAtMs = Date.now();
          resolveFirstOutcome();
          resolveReady();
        },
        (error: unknown) => {
          if (!current()) return;
          context.lifecycleStartError =
            error instanceof Error ? error : new Error(String(error));
          const delayMs = resolveLifecycleRetryDelayMs(attemptNumber);
          console.error(
            `[cmuxlayer] lifecycle initialization attempt ${attemptNumber} failed; retrying in ${delayMs}ms:`,
            context.lifecycleStartError,
          );
          resolveFirstOutcome();
          const timer = setTimeout(attempt, delayMs);
          timer.unref?.();
          context.lifecycleRetryTimer = timer;
        },
      );
  };
  attempt();
}

/**
 * Wait until lifecycle is ready or its first attempt has an outcome, bounded
 * by `timeoutMs`. Never throws; callers read the state afterwards.
 */
export async function awaitLifecycleFirstOutcome(
  context: CmuxServerContext,
  timeoutMs: number,
): Promise<void> {
  const ready = context.lifecycleStartPromise;
  if (!ready) return;
  const first = context.lifecycleStartFirstOutcome;
  await awaitBoundedLifecycleStart(
    first ? Promise.race([ready, first]) : ready,
    timeoutMs,
  ).catch(() => {});
}

/**
 * #938: the central gate for tools that need the lifecycle engine. A no-op
 * unless the retry loop is driving lifecycle and it is not ready yet; then it
 * waits (bounded) for the first attempt's outcome and throws the named cause.
 */
export async function assertLifecycleReadyForTool(
  context: CmuxServerContext,
  timeoutMs: number,
): Promise<void> {
  if (lifecycleNotReadyError(context) === null) return;
  if (!context.lifecycleStartError) {
    await awaitLifecycleFirstOutcome(context, timeoutMs);
  }
  const notReady = lifecycleNotReadyError(context);
  if (notReady) throw notReady;
}

export interface TypedDraftOwner {
  caller: string; text: string; at: number; ref: string; uuid: string | null;
  workspace: string | null; fp: string; seen: boolean;
  /** #793: the managed agent whose unsubmitted boot draft this is. */
  bootAgentId?: string;
  /** #793: that agent's boot instance, bound once spawn has settled its record. */
  bootInstanceId?: string;
}

export interface CmuxServerContext {
  /** Shared by every MCP peer using this daemon context. */
  typedDraftOwners: Map<string, TypedDraftOwner>;
  client: CmuxLayerClient;
  /** Persisted stable socket-node owner identity. */
  surfaceObserverId: string | null;
  /** Non-persisted transport/route generation for in-flight guards. */
  surfaceObserverEpoch: string | null;
  stateDir: string;
  stateMgr: StateManager;
  roleSurfaceOverrides: Map<
    string,
    { role: AgentRole; workspace: string | null; surfaceUuid: string | null }
  >;
  eventLog: ReturnType<StateManager["getEventLog"]>;
  deliveries: Map<string, DeliveryRecord>;
  /**
   * The screen read before typing, by delivery_id: the baseline the pending
   * sweep needs for a Codex submit proof. In memory only (receipts never
   * persist screen text); bounded by the delivery engine (#935).
   */
  deliveryPreTypeScreens: Map<string, string>;
  latestDeliveryBySurface: Map<string, string>;
  activeDeliveryBySurface: Map<string, string>;
  activeSurfaceWrites: Map<string, string>;
  originalLaunchCommandsBySurface: Map<string, string>;
  launchShellRecoveryBySurface: Map<
    string,
    { recovered: true; cleared: string[] }
  >;
  surfaceWriteLivenessCandidates: Set<string>;
  surfacePtyDeadSince: Map<string, number>;
  readScreenInflight: Map<string, Promise<ReadScreenSnapshot>>;
  /** First-seen stable identities for caller-visible mutable surface refs. */
  capturedSurfaceUuidByRef: Map<string, string>;
  /** Refs observed with more than one UUID in one observer epoch are unsafe. */
  ambiguousCapturedSurfaceRefs: Set<string>;
  capturedSurfaceObserverEpoch: string | null;
  codexRolloutFillProvider: CodexRolloutFillProvider;
  surfaceWriteLiveness: SurfaceWriteLivenessTracker;
  skipAgentLifecycle: boolean;
  spawnPreflight?: (params: SpawnAgentParams) => Promise<void>;
  disableSpawnPreflight?: boolean;
  sessionIdentityResolver?: SessionIdentityResolver;
  selfRegistrationSessionResolver?: SessionIdentityResolver;
  selfRegistrationSessionLookup?: (
    sessionId: string,
  ) => SelfRegistrationSessionEntry | null;
  lifecycleRegistry: AgentRegistry | null;
  lifecycleInitializer: (() => Promise<void>) | null;
  lifecycleStarted: boolean;
  lifecycleStartPromise: Promise<void> | null;
  /**
   * #938: the last failed attempt's error while lifecycle is retrying;
   * cleared on success. Never a permanent latch.
   */
  lifecycleStartError: Error | null;
  /** #938: set once lifecycle initialization has succeeded. */
  lifecycleReady: boolean;
  /** #938: lifecycle initialization attempts started by the retry loop. */
  lifecycleStartAttempts: number;
  /** #938: resolves on the first success or first failed attempt. */
  lifecycleStartFirstOutcome: Promise<void> | null;
  /** #938: the pending backoff before the next attempt. */
  lifecycleRetryTimer: NodeJS.Timeout | null;
  /** #938: bumped on dispose so a stale retry loop stops. */
  lifecycleStartGeneration: number;
  /** #529 observability: when lifecycle init began and whether it settled. */
  lifecycleStartStartedAtMs: number | null;
  lifecycleStartSettledAtMs: number | null;
  /** Callers that gave up on the bounded lifecycle wait. */
  lifecycleStartTimeouts: number;
  lifecycleStartLastTimeoutAt: string | null;
  /** Lifecycle-lock truth for `control_health`, published by the live engine. */
  lifecycleLockStateProvider: (() => LifecycleLockState) | null;
  lifecycleSweepEngine: AgentEngine | null;
  parentReportPathReservations: Set<string>;
  lifecycleAgentInputDeliverer: LifecycleAgentInputDeliverer | null;
  setLifecycleAgentInputDeliverer(
    deliverer: LifecycleAgentInputDeliverer | null,
  ): void;
  controlHealthCollector?: () => Promise<ControlHealth>;
  controlHealthWarnings: string[];
  controlHealthIntervalMs: number;
  controlHealthTimer: ReturnType<typeof setInterval> | null;
  dispose(): void;
}

export const DEFAULT_CONTROL_HEALTH_INTERVAL_MS = 60_000;

export const MIN_CONTROL_HEALTH_INTERVAL_MS = 5_000;

export interface AutoVitestTempCleanupState {
  dirs: Set<string>;
  registered: boolean;
}

export type AutoVitestTempCleanupGlobal = typeof globalThis & {
  __cmuxlayerAutoVitestTempCleanupV1?: AutoVitestTempCleanupState;
};

export const autoVitestTempCleanupGlobal = globalThis as AutoVitestTempCleanupGlobal;

export const autoVitestTempCleanupState =
  autoVitestTempCleanupGlobal.__cmuxlayerAutoVitestTempCleanupV1 ??
  (autoVitestTempCleanupGlobal.__cmuxlayerAutoVitestTempCleanupV1 = {
    dirs: new Set<string>(),
    registered: false,
  });

export function resolveControlHealthIntervalMs(input?: number): number {
  const raw =
    input ??
    (process.env.CMUXLAYER_CONTROL_HEALTH_INTERVAL_MS
      ? Number(process.env.CMUXLAYER_CONTROL_HEALTH_INTERVAL_MS)
      : DEFAULT_CONTROL_HEALTH_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CONTROL_HEALTH_INTERVAL_MS;
  }
  if (raw === 0) {
    return 0;
  }
  return Math.max(MIN_CONTROL_HEALTH_INTERVAL_MS, Math.floor(raw));
}

export function registerAutoVitestTempDir(dir: string): void {
  autoVitestTempCleanupState.dirs.add(dir);
  if (autoVitestTempCleanupState.registered) {
    return;
  }
  autoVitestTempCleanupState.registered = true;
  process.once("exit", () => {
    for (const dir of autoVitestTempCleanupState.dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    autoVitestTempCleanupState.dirs.clear();
  });
}

export function removeAutoVitestTempDir(dir: string): void {
  autoVitestTempCleanupState.dirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

export function createServerContext(
  opts?: Omit<CreateServerOptions, "context">,
): CmuxServerContext {
  const client =
    opts?.client ??
    new CmuxClient({
      exec: opts?.exec,
      bin: opts?.bin ?? (opts?.exec ? "cmux" : undefined),
    });
  const autoVitestStateDir =
    !opts?.stateDir && !opts?.stateManager && process.env.VITEST === "true"
      ? mkdtempSync(join(tmpdir(), "cmuxlayer-vitest-state-"))
      : null;
  const stateDir =
    opts?.stateManager?.getBaseDir() ??
    opts?.stateDir ??
    autoVitestStateDir ??
    join(homedir(), ".local", "state", "cmux-agents");
  if (autoVitestStateDir) {
    registerAutoVitestTempDir(autoVitestStateDir);
  }
  const stateMgr = opts?.stateManager ?? new StateManager(stateDir);
  const readObserverProvider = (
    provider: () => string | null | undefined,
  ): string | null => {
    try {
      return provider()?.trim() || null;
    } catch {
      return null;
    }
  };
  const observerOwnerIdProvider =
    opts?.surfaceObserverOwnerIdProvider ??
    (() => deriveCmuxObserverOwnerId(client));
  const observerEpochProvider =
    opts?.surfaceObserverEpochProvider ??
    (() => deriveCmuxObserverEpoch(client));
  const context: CmuxServerContext = {
    client,
    get surfaceObserverId() {
      return readObserverProvider(observerOwnerIdProvider);
    },
    get surfaceObserverEpoch() {
      return readObserverProvider(observerEpochProvider);
    },
    stateDir,
    stateMgr,
    roleSurfaceOverrides: new Map(),
    eventLog: stateMgr.getEventLog(),
    typedDraftOwners: new Map(),
    deliveries: new Map(),
    deliveryPreTypeScreens: new Map(),
    latestDeliveryBySurface: new Map(),
    activeDeliveryBySurface: new Map(),
    activeSurfaceWrites: new Map(),
    originalLaunchCommandsBySurface: new Map(),
    launchShellRecoveryBySurface: new Map(),
    surfaceWriteLivenessCandidates: new Set(),
    surfacePtyDeadSince: new Map(),
    readScreenInflight: new Map(),
    capturedSurfaceUuidByRef: new Map(),
    ambiguousCapturedSurfaceRefs: new Set(),
    capturedSurfaceObserverEpoch: null,
    codexRolloutFillProvider:
      opts?.codexRolloutFillProvider ?? makeCodexRolloutFillProvider(),
    surfaceWriteLiveness:
      opts?.surfaceWriteLiveness ?? new SurfaceWriteLivenessTracker(),
    skipAgentLifecycle: opts?.skipAgentLifecycle ?? false,
    spawnPreflight: opts?.spawnPreflight,
    disableSpawnPreflight: opts?.disableSpawnPreflight,
    sessionIdentityResolver: opts?.sessionIdentityResolver,
    selfRegistrationSessionResolver: opts?.selfRegistrationSessionResolver,
    selfRegistrationSessionLookup: opts?.selfRegistrationSessionLookup,
    lifecycleRegistry: opts?.lifecycleRegistry ?? null,
    lifecycleInitializer: opts?.lifecycleInitializer ?? null,
    lifecycleStarted: false,
    lifecycleStartPromise: null,
    lifecycleStartError: null,
    lifecycleReady: false,
    lifecycleStartAttempts: 0,
    lifecycleStartFirstOutcome: null,
    lifecycleRetryTimer: null,
    lifecycleStartGeneration: 0,
    lifecycleStartStartedAtMs: null,
    lifecycleStartSettledAtMs: null,
    lifecycleStartTimeouts: 0,
    lifecycleStartLastTimeoutAt: null,
    lifecycleLockStateProvider: null,
    lifecycleSweepEngine: null,
    parentReportPathReservations: new Set(),
    lifecycleAgentInputDeliverer: null,
    setLifecycleAgentInputDeliverer(deliverer) {
      context.lifecycleAgentInputDeliverer = deliverer;
    },
    controlHealthCollector: opts?.controlHealthCollector,
    controlHealthWarnings: opts?.controlHealthWarnings ?? [],
    controlHealthIntervalMs: resolveControlHealthIntervalMs(
      opts?.controlHealthIntervalMs,
    ),
    controlHealthTimer: null,
    dispose() {
      context.lifecycleSweepEngine?.dispose();
      if (context.controlHealthTimer) {
        clearInterval(context.controlHealthTimer);
        context.controlHealthTimer = null;
      }
      context.lifecycleSweepEngine = null;
      context.parentReportPathReservations.clear();
      context.lifecycleAgentInputDeliverer = null;
      context.originalLaunchCommandsBySurface.clear();
      context.launchShellRecoveryBySurface.clear();
      context.capturedSurfaceUuidByRef.clear();
      context.ambiguousCapturedSurfaceRefs.clear();
      context.capturedSurfaceObserverEpoch = null;
      context.lifecycleStartGeneration += 1;
      if (context.lifecycleRetryTimer) {
        clearTimeout(context.lifecycleRetryTimer);
        context.lifecycleRetryTimer = null;
      }
      context.lifecycleStarted = false;
      context.lifecycleReady = false;
      context.lifecycleStartAttempts = 0;
      context.lifecycleStartFirstOutcome = null;
      context.lifecycleStartPromise = null;
      context.lifecycleStartError = null;
      context.lifecycleStartStartedAtMs = null;
      context.lifecycleStartSettledAtMs = null;
      context.typedDraftOwners.clear();
      context.lifecycleStartTimeouts = 0;
      context.lifecycleStartLastTimeoutAt = null;
      context.lifecycleLockStateProvider = null;
      if (autoVitestStateDir) {
        removeAutoVitestTempDir(autoVitestStateDir);
      }
    },
  };

  return context;
}

/**
 * #911: the registry may call a record-less tailer an orphan only when it is
 * the VERIFIED fleet registry for that inbox dir: the state dir IS the
 * production state dir and the inbox dir IS the production inbox dir, judged
 * by filesystem identity (realpath, then device+inode), never by spelling. A
 * scratch state dir, even one beside a symlink to the real inbox, is not.
 * Anything that cannot be resolved has no authority.
 */
export function hasInboxTailRecordAuthority(
  stateDir: string,
  inboxBaseDir: string | undefined,
  production: { stateDir: string; inboxBaseDir: string } = {
    stateDir: join(homedir(), ".local", "state", "cmux-agents"),
    inboxBaseDir: inboxBaseDirOf(),
  },
): boolean {
  const identity = (path: string): string | null => {
    try {
      const stat = statSync(realpathSync(path));
      return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
    } catch {
      return null;
    }
  };
  const same = (left: string, right: string): boolean => {
    const leftId = identity(left);
    return leftId !== null && leftId === identity(right);
  };
  return (
    same(stateDir, production.stateDir) &&
    same(inboxBaseDir ?? production.inboxBaseDir, production.inboxBaseDir)
  );
}

export function resolveServerInboxBaseDir(input: {
  explicitBaseDir?: string;
  isVitest: boolean;
}): string | undefined {
  if (input.explicitBaseDir) return input.explicitBaseDir;
  return input.isVitest
    ? join(tmpdir(), `cmuxlayer-vitest-inbox-${process.pid}`)
    : undefined;
}
