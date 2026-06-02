import { afterEach, describe, expect, it } from "vitest";
import {
  defaultSpawnGuardConfig,
  SpawnGuard,
  SpawnRateLimitedError,
} from "../src/spawn-guard.js";

const ENV_KEYS = [
  "CMUXLAYER_MAX_SPAWNS_PER_WINDOW",
  "CMUXLAYER_MAX_SPAWNS_PER_WORKSPACE_PER_WINDOW",
  "CMUXLAYER_SPAWN_WINDOW_MS",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function clearSpawnEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreSpawnEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("SpawnGuard", () => {
  afterEach(() => {
    restoreSpawnEnv();
  });

  it("limits a 44-spawn storm to the configured sliding-window cap", () => {
    let nowMs = 0;
    const guard = new SpawnGuard(
      {
        maxPerWindow: 8,
        maxPerWorkspacePerWindow: 8,
        windowMs: 6000,
      },
      () => nowMs,
    );

    let succeeded = 0;
    let rejected = 0;
    let lastError: SpawnRateLimitedError | null = null;

    for (let i = 0; i < 44; i++) {
      try {
        guard.check("workspace:1");
        succeeded++;
      } catch (error) {
        expect(error).toBeInstanceOf(SpawnRateLimitedError);
        lastError = error as SpawnRateLimitedError;
        rejected++;
      }
      nowMs += i < 5 ? 1 : 0;
    }

    expect(succeeded).toBe(8);
    expect(rejected).toBe(36);
    expect(lastError?.code).toBe("SPAWN_RATE_LIMITED");
    expect(lastError?.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows a human-paced burst of six default-config spawns in one workspace", () => {
    clearSpawnEnv();
    let nowMs = 0;
    const guard = new SpawnGuard(defaultSpawnGuardConfig(), () => nowMs);

    for (let i = 0; i < 6; i++) {
      expect(() => guard.check("workspace:leads")).not.toThrow();
      nowMs += 400;
    }
  });

  it("refills capacity after the sliding window passes", () => {
    let nowMs = 0;
    const guard = new SpawnGuard(
      {
        maxPerWindow: 10,
        maxPerWorkspacePerWindow: 3,
        windowMs: 1000,
      },
      () => nowMs,
    );

    guard.check("workspace:1");
    guard.check("workspace:1");
    guard.check("workspace:1");
    expect(() => guard.check("workspace:1")).toThrow(SpawnRateLimitedError);

    nowMs = 1001;

    expect(() => guard.check("workspace:1")).not.toThrow();
  });

  it("isolates per-workspace caps while global capacity remains", () => {
    let nowMs = 0;
    const guard = new SpawnGuard(
      {
        maxPerWindow: 10,
        maxPerWorkspacePerWindow: 2,
        windowMs: 1000,
      },
      () => nowMs,
    );

    guard.check("workspace:A");
    guard.check("workspace:A");
    expect(() => guard.check("workspace:A")).toThrow(SpawnRateLimitedError);
    expect(() => guard.check("workspace:B")).not.toThrow();
  });

  it("reads positive environment overrides and falls back for invalid values", () => {
    clearSpawnEnv();
    process.env.CMUXLAYER_MAX_SPAWNS_PER_WORKSPACE_PER_WINDOW = "2";
    expect(defaultSpawnGuardConfig().maxPerWorkspacePerWindow).toBe(2);

    process.env.CMUXLAYER_MAX_SPAWNS_PER_WORKSPACE_PER_WINDOW = "0";
    process.env.CMUXLAYER_MAX_SPAWNS_PER_WINDOW = "garbage";
    process.env.CMUXLAYER_SPAWN_WINDOW_MS = "-5";

    expect(defaultSpawnGuardConfig()).toEqual({
      maxPerWindow: 50,
      maxPerWorkspacePerWindow: 25,
      windowMs: 10000,
    });
  });
});
