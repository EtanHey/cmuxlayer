#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import {
  baselineContentSha256,
  baselinePath,
  compareBenchmark,
  runBenchmark,
  validateBaseline,
} from "./check-daemon-benchmark.mjs";

const existing = validateBaseline(
  JSON.parse(await readFile(baselinePath, "utf8")),
);
const runnerClass = process.env.CMUXLAYER_BENCH_RUNNER_CLASS;
const workflowRunId = Number(process.env.GITHUB_RUN_ID);
if (
  runnerClass !== "github-actions-ubuntu-latest" ||
  !Number.isFinite(workflowRunId)
) {
  throw new Error(
    "baseline refresh must run from the GitHub Actions workflow_dispatch job",
  );
}
const { code, result } = await runBenchmark({
  benchmarkEnv: {
    CMUXLAYER_BENCH_N: "8",
    CMUXLAYER_BENCH_ROUNDS: "12",
    CMUXLAYER_BENCH_LOCAL_GATE: "0",
  },
});
if (code !== 0 || result.verdict !== "GREEN") {
  throw new Error("refusing to refresh from a RED daemon benchmark");
}
if (
  result.replay?.clients !== 8 ||
  result.replay?.rounds !== 12 ||
  JSON.stringify(result.replay?.operations) !==
    JSON.stringify(existing.replay.operations)
) {
  throw new Error("refusing to refresh without the canonical 8x12 replay");
}
for (const operation of existing.replay.operations) {
  if (
    result.replay?.request_sha256?.[operation] !==
    existing.replay.request_sha256[operation]
  ) {
    throw new Error(
      `refusing to refresh changed canonical request ${operation}`,
    );
  }
}

const first = result.latency.first_send_after_spawn.first;
if (
  !Number.isFinite(first.lock_hold_ms) ||
  first.lock_hold_ms >
    existing.measurements.first_send_after_spawn.lock_hold_ms *
      existing.regression_ratio
) {
  throw new Error("refusing to refresh from an over-budget lock hold");
}
const comparison = compareBenchmark(existing, result);
if (!comparison.passed) {
  throw new Error(
    `refusing to refresh from an over-budget benchmark: ${comparison.failures.join("; ")}`,
  );
}
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
  cli_send_ms: result.latency.first_send_after_spawn.surface.elapsed_ms,
};
const refreshed = {
  ...existing,
  source: {
    git_sha: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    measured_at: new Date().toISOString(),
    runner_class: runnerClass,
    workflow_run_id: workflowRunId,
  },
  replay: result.replay,
  measurements,
};
refreshed.refresh_attestation = {
  algorithm: "sha256",
  content_sha256: baselineContentSha256(refreshed),
};

validateBaseline(refreshed);
await writeFile(baselinePath, `${JSON.stringify(refreshed, null, 2)}\n`);
console.log(`refreshed ${baselinePath}`);
