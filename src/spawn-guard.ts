const DEFAULT_MAX_PER_WINDOW = 50;
const DEFAULT_MAX_PER_WORKSPACE_PER_WINDOW = 25;
const DEFAULT_WINDOW_MS = 10000;
const DEFAULT_WORKSPACE_KEY = "__default__";

export class SpawnRateLimitedError extends Error {
  readonly code = "SPAWN_RATE_LIMITED";
  readonly retryAfterMs: number;
  readonly scope: string;

  constructor(
    scope: string,
    retryAfterMs: number,
    maxPerWindow: number,
    windowMs: number,
  ) {
    super(
      `Spawn rate limit exceeded for ${scope}: >${maxPerWindow} spawns per ${windowMs}ms; retry after ${retryAfterMs}ms`,
    );
    this.name = "SpawnRateLimitedError";
    this.retryAfterMs = retryAfterMs;
    this.scope = scope;
  }
}

export interface SpawnGuardConfig {
  maxPerWindow: number;
  maxPerWorkspacePerWindow: number;
  windowMs: number;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultSpawnGuardConfig(): SpawnGuardConfig {
  // Defaults sit above the legitimate per-parent fan-out floor
  // (root + MAX_CHILDREN=10 = 11) and realistic multi-lead revivals, while
  // a pathological 44-in-6s single-workspace burst still trips the
  // per-workspace cap. Stricter environments can tune these down via env.
  return {
    maxPerWindow: positiveIntFromEnv(
      "CMUXLAYER_MAX_SPAWNS_PER_WINDOW",
      DEFAULT_MAX_PER_WINDOW,
    ),
    maxPerWorkspacePerWindow: positiveIntFromEnv(
      "CMUXLAYER_MAX_SPAWNS_PER_WORKSPACE_PER_WINDOW",
      DEFAULT_MAX_PER_WORKSPACE_PER_WINDOW,
    ),
    windowMs: positiveIntFromEnv(
      "CMUXLAYER_SPAWN_WINDOW_MS",
      DEFAULT_WINDOW_MS,
    ),
  };
}

export class SpawnGuard {
  private readonly globalTimestamps: number[] = [];
  private readonly workspaceTimestamps = new Map<string, number[]>();

  constructor(
    private readonly config: SpawnGuardConfig = defaultSpawnGuardConfig(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(workspace?: string): void {
    const timestamp = this.now();
    const cutoff = timestamp - this.config.windowMs;
    const workspaceKey = workspace ?? DEFAULT_WORKSPACE_KEY;
    let workspaceArr = this.workspaceTimestamps.get(workspaceKey);
    if (!workspaceArr) {
      workspaceArr = [];
      this.workspaceTimestamps.set(workspaceKey, workspaceArr);
    }

    this.prune(this.globalTimestamps, cutoff);
    this.prune(workspaceArr, cutoff);

    if (this.globalTimestamps.length >= this.config.maxPerWindow) {
      throw new SpawnRateLimitedError(
        "global",
        this.retryAfter(this.globalTimestamps, timestamp),
        this.config.maxPerWindow,
        this.config.windowMs,
      );
    }

    if (
      workspaceArr.length >= this.config.maxPerWorkspacePerWindow
    ) {
      throw new SpawnRateLimitedError(
        `workspace ${workspaceKey}`,
        this.retryAfter(workspaceArr, timestamp),
        this.config.maxPerWorkspacePerWindow,
        this.config.windowMs,
      );
    }

    this.globalTimestamps.push(timestamp);
    workspaceArr.push(timestamp);
  }

  private prune(timestamps: number[], cutoff: number): void {
    let removeCount = 0;
    while (
      removeCount < timestamps.length &&
      timestamps[removeCount] <= cutoff
    ) {
      removeCount++;
    }

    if (removeCount > 0) {
      timestamps.splice(0, removeCount);
    }
  }

  private retryAfter(timestamps: number[], timestamp: number): number {
    const oldestInWindow = timestamps[0] ?? timestamp;
    return Math.max(0, oldestInWindow + this.config.windowMs - timestamp);
  }
}
