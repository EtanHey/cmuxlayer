export const DEFAULT_PTY_DEAD_FAILURE_THRESHOLD = 2;
export const DEFAULT_PTY_DEAD_FAILURE_WINDOW_MS = 30_000;

export interface SurfaceWriteLivenessObservation {
  pty_dead: boolean;
  consecutive_broken_pipe_failures: number;
  last_attempt_at: number;
}

export interface SurfaceWriteLivenessTrackerOptions {
  now?: () => number;
  failureThreshold?: number;
  failureWindowMs?: number;
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
  private readonly stateByBinding = new Map<string, SurfaceWriteState>();

  constructor(options: SurfaceWriteLivenessTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_PTY_DEAD_FAILURE_THRESHOLD;
    this.failureWindowMs =
      options.failureWindowMs ?? DEFAULT_PTY_DEAD_FAILURE_WINDOW_MS;
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
    this.stateByBinding.set(
      this.bindingKey(
        surface,
        stableSurfaceIdentity,
        surfaceObserverIdentity,
      ),
      {
        consecutiveBrokenPipeFailures: 0,
        firstBrokenPipeFailureAt: null,
        lastAttemptAt: this.now(),
      },
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
    const previous = this.stateByBinding.get(key);
    if (!isBrokenPipeError(error)) {
      this.stateByBinding.set(key, {
        consecutiveBrokenPipeFailures: 0,
        firstBrokenPipeFailureAt: null,
        lastAttemptAt: at,
      });
      return;
    }
    const continuesChain =
      previous !== undefined &&
      previous.consecutiveBrokenPipeFailures > 0 &&
      previous.firstBrokenPipeFailureAt !== null &&
      at - previous.firstBrokenPipeFailureAt <= this.failureWindowMs;
    this.stateByBinding.set(key, {
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
    const state = this.stateByBinding.get(
      this.bindingKey(
        surface,
        stableSurfaceIdentity,
        surfaceObserverIdentity,
      ),
    );
    if (!state) return null;
    const withinWindow =
      state.firstBrokenPipeFailureAt !== null &&
      this.now() - state.firstBrokenPipeFailureAt <= this.failureWindowMs;
    return {
      pty_dead:
        withinWindow &&
        state.consecutiveBrokenPipeFailures >= this.failureThreshold,
      consecutive_broken_pipe_failures:
        state.consecutiveBrokenPipeFailures,
      last_attempt_at: state.lastAttemptAt,
    };
  }
}
