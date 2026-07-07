export const DEFAULT_HEAP_GUARD_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024;
export const DEFAULT_HEAP_GUARD_INTERVAL_MS = 15_000;
export const DEFAULT_NODE_MAX_OLD_SPACE_MB = 1536;
export const HEAP_GUARD_EXIT_CODE = 70;

export interface HeapGuardOptions {
  thresholdBytes?: number;
  intervalMs?: number;
  memoryUsage?: () => Pick<NodeJS.MemoryUsage, "heapUsed" | "rss">;
  log?: (message: string) => void;
  exit?: (code: number) => void;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
}

export function installHeapGuard(options: HeapGuardOptions = {}): unknown {
  const thresholdBytes = positiveNumber(
    options.thresholdBytes,
    envNumber("CMUXLAYER_HEAP_GUARD_BYTES"),
    DEFAULT_HEAP_GUARD_THRESHOLD_BYTES,
  );
  const intervalMs = positiveNumber(
    options.intervalMs,
    envNumber("CMUXLAYER_HEAP_GUARD_INTERVAL_MS"),
    DEFAULT_HEAP_GUARD_INTERVAL_MS,
  );
  const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  const log = options.log ?? ((message: string) => console.error(message));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((value: unknown) => clearInterval(value as ReturnType<typeof setInterval>));

  let timer: unknown;
  const check = () => {
    const usage = memoryUsage();
    const used = Math.max(usage.heapUsed, usage.rss);
    if (used < thresholdBytes) return;

    log(
      [
        "[cmuxlayer] FATAL heap guard:",
        `rss=${usage.rss}`,
        `heapUsed=${usage.heapUsed}`,
        `threshold=${thresholdBytes}`,
        "exiting before the MCP child can balloon into a host OOM",
      ].join(" "),
    );
    if (timer) clearIntervalFn(timer);
    exit(HEAP_GUARD_EXIT_CODE);
  };

  timer = setIntervalFn(check, intervalMs);
  if (typeof (timer as { unref?: unknown })?.unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return timer;
}

export function ensureNodeMaxOldSpaceEnv(): void {
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  if (/(^|\s)--max-old-space-size(=|\s)/.test(nodeOptions)) return;
  const maxOldSpaceMb = positiveNumber(
    undefined,
    envNumber("CMUXLAYER_NODE_MAX_OLD_SPACE_MB"),
    DEFAULT_NODE_MAX_OLD_SPACE_MB,
  );
  process.env.NODE_OPTIONS = `${nodeOptions} --max-old-space-size=${Math.floor(
    maxOldSpaceMb,
  )}`.trim();
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(
  explicit: number | undefined,
  environment: number | undefined,
  fallback: number,
): number {
  for (const value of [explicit, environment]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return fallback;
}
