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
  private readonly stateBySurface = new Map<string, SurfaceWriteState>();

  constructor(options: SurfaceWriteLivenessTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_PTY_DEAD_FAILURE_THRESHOLD;
    this.failureWindowMs =
      options.failureWindowMs ?? DEFAULT_PTY_DEAD_FAILURE_WINDOW_MS;
  }

  recordSuccess(surface: string): void {
    this.stateBySurface.set(surface, {
      consecutiveBrokenPipeFailures: 0,
      firstBrokenPipeFailureAt: null,
      lastAttemptAt: this.now(),
    });
  }

  recordFailure(surface: string, error: unknown): void {
    const at = this.now();
    const previous = this.stateBySurface.get(surface);
    if (!isBrokenPipeError(error)) {
      this.stateBySurface.set(surface, {
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
    this.stateBySurface.set(surface, {
      consecutiveBrokenPipeFailures: continuesChain
        ? previous.consecutiveBrokenPipeFailures + 1
        : 1,
      firstBrokenPipeFailureAt: continuesChain
        ? previous.firstBrokenPipeFailureAt
        : at,
      lastAttemptAt: at,
    });
  }

  observe(surface: string): SurfaceWriteLivenessObservation | null {
    const state = this.stateBySurface.get(surface);
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
