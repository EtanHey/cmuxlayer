#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import {
  baselinePath,
  runBenchmark,
  validateBaseline,
} from "./check-daemon-benchmark.mjs";

const existing = validateBaseline(
  JSON.parse(await readFile(baselinePath, "utf8")),
);
const { code, result } = await runBenchmark();
if (code !== 0 || result.verdict !== "GREEN") {
  throw new Error("refusing to refresh from a RED daemon benchmark");
}

const first = result.latency.first_send_after_spawn.first;
const measurements = {
  list_surfaces: {
    p50_ms: result.latency.daemon_path.list_surfaces.p50_ms,
    p95_ms: result.latency.daemon_path.list_surfaces.p95_ms,
  },
  read_screen: {
    p50_ms: result.latency.daemon_path.read_screen.p50_ms,
    p95_ms: result.latency.daemon_path.read_screen.p95_ms,
  },
  first_send_after_spawn: {
    p50_ms: first.elapsed_ms,
    p95_ms: first.elapsed_ms,
    lock_hold_ms: first.lock_hold_ms,
  },
};
const ratio = existing.runner_margin_ratio;
const refreshed = {
  ...existing,
  source: {
    git_sha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    measured_at: new Date().toISOString(),
  },
  replay: result.replay,
  measurements,
  ceilings: {
    ...existing.ceilings,
    list_surfaces: {
      p50_ms: Math.min(
        existing.ceilings.list_surfaces.p50_ms,
        measurements.list_surfaces.p50_ms * ratio,
      ),
      p95_ms: Math.min(
        existing.ceilings.list_surfaces.p95_ms,
        measurements.list_surfaces.p95_ms * ratio,
      ),
    },
    read_screen: {
      p50_ms: Math.min(250, existing.ceilings.read_screen.p50_ms),
      p95_ms: Math.min(
        existing.ceilings.read_screen.p95_ms,
        measurements.read_screen.p95_ms * ratio,
      ),
    },
    first_send_after_spawn: {
      p50_ms: 2_000,
      p95_ms: 2_000,
      lock_hold_ms: Math.min(
        existing.ceilings.first_send_after_spawn.lock_hold_ms,
        Math.max(100, measurements.first_send_after_spawn.lock_hold_ms * ratio),
      ),
    },
    cli_send_ms: 4_000,
  },
};

validateBaseline(refreshed);
await writeFile(baselinePath, `${JSON.stringify(refreshed, null, 2)}\n`);
console.log(`refreshed ${baselinePath}`);
