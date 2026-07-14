export const DEFAULT_PTY_DEAD_FAILURE_THRESHOLD = 2;
export const DEFAULT_PTY_DEAD_FAILURE_WINDOW_MS = 30_000;
export const DEFAULT_SURFACE_WRITE_LIVENESS_MAX_BINDINGS = 2_048;

export interface SurfaceWriteLivenessObservation {
  pty_dead: boolean;
  consecutive_broken_pipe_failures: number;
  last_attempt_at: number;
}

export interface SurfaceWriteLivenessTrackerOptions {
  now?: () => number;
  failureThreshold?: number;
  failureWindowMs?: number;
  maxBindings?: number;
}

interface SurfaceWriteState {
  consecutiveBrokenPipeFailures: number;
  firstBrokenPipeFailureAt: number | null;
  lastAttemptAt: number;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isBrokenPipeError(error: unknown): boolean {
  const record =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; errno?: unknown })
      : null;
  if (record?.code === "EPIPE") return true;
  if (record?.errno === 32 || record?.errno === -32) return true;
  return /\b(?:EPIPE|broken[ -]pipe|errno\s*32)\b/i.test(errorText(error));
}

export class SurfaceWriteLivenessTracker {
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly maxBindings: number;
  private readonly stateByBinding = new Map<string, SurfaceWriteState>();

  constructor(options: SurfaceWriteLivenessTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_PTY_DEAD_FAILURE_THRESHOLD;
    this.failureWindowMs =
      options.failureWindowMs ?? DEFAULT_PTY_DEAD_FAILURE_WINDOW_MS;
    const maxBindings =
      options.maxBindings ?? DEFAULT_SURFACE_WRITE_LIVENESS_MAX_BINDINGS;
    this.maxBindings =
      Number.isFinite(maxBindings) && maxBindings > 0
        ? Math.max(1, Math.floor(maxBindings))
        : DEFAULT_SURFACE_WRITE_LIVENESS_MAX_BINDINGS;
  }

  private bindingKey(
    surface: string,
    stableSurfaceIdentity?: string | null,
    surfaceObserverIdentity?: string | null,
  ): string {
    const stableKey = stableSurfaceIdentity?.trim().toLowerCase();
    if (stableKey) return `identity:${stableKey}`;
    const observerKey = surfaceObserverIdentity?.trim().toLowerCase();
    return observerKey
      ? `observer:${observerKey}:ref:${surface}`
      : `ref:${surface}`;
  }

  recordSuccess(
    surface: string,
    stableSurfaceIdentity?: string | null,
    surfaceObserverIdentity?: string | null,
  ): void {
    this.stateByBinding.delete(
      this.bindingKey(surface, stableSurfaceIdentity, surfaceObserverIdentity),
    );
  }

  recordFailure(
    surface: string,
    error: unknown,
    stableSurfaceIdentity?: string | null,
    surfaceObserverIdentity?: string | null,
  ): void {
    const at = this.now();
    const key = this.bindingKey(
      surface,
      stableSurfaceIdentity,
      surfaceObserverIdentity,
    );
    this.pruneExpired(at);
    const previous = this.stateByBinding.get(key);
    if (!isBrokenPipeError(error)) {
      this.stateByBinding.delete(key);
      return;
    }
    const continuesChain =
      previous !== undefined &&
      previous.consecutiveBrokenPipeFailures > 0 &&
      previous.firstBrokenPipeFailureAt !== null &&
      at - previous.firstBrokenPipeFailureAt <= this.failureWindowMs;
    this.remember(key, {
      consecutiveBrokenPipeFailures: continuesChain
        ? previous.consecutiveBrokenPipeFailures + 1
        : 1,
      firstBrokenPipeFailureAt: continuesChain
        ? previous.firstBrokenPipeFailureAt
        : at,
      lastAttemptAt: at,
    });
  }

  observe(
    surface: string,
    stableSurfaceIdentity?: string | null,
    surfaceObserverIdentity?: string | null,
  ): SurfaceWriteLivenessObservation | null {
    const at = this.now();
    const key = this.bindingKey(
      surface,
      stableSurfaceIdentity,
      surfaceObserverIdentity,
    );
    this.pruneExpired(at);
    const state = this.stateByBinding.get(key);
    if (!state) return null;
    return {
      pty_dead:
        state.consecutiveBrokenPipeFailures >= this.failureThreshold,
      consecutive_broken_pipe_failures:
        state.consecutiveBrokenPipeFailures,
      last_attempt_at: state.lastAttemptAt,
    };
  }

  private pruneExpired(at: number): void {
    for (const [key, state] of this.stateByBinding) {
      if (
        state.firstBrokenPipeFailureAt === null ||
        at - state.firstBrokenPipeFailureAt > this.failureWindowMs
      ) {
        this.stateByBinding.delete(key);
      }
    }
  }

  private remember(key: string, state: SurfaceWriteState): void {
    // Refresh insertion order so the hard bound retains the most recently
    // active broken-pipe episodes rather than stale identities.
    this.stateByBinding.delete(key);
    this.stateByBinding.set(key, state);
    while (this.stateByBinding.size > this.maxBindings) {
      const oldestKey = this.stateByBinding.keys().next().value;
      if (oldestKey === undefined) break;
      this.stateByBinding.delete(oldestKey);
    }
  }
}
