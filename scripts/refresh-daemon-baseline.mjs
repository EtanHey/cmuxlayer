#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  baselineContentSha256,
  baselinePath,
  compareBenchmark,
  maximumBenchmarkMeasurements,
  runBenchmark,
  validateBaseline,
} from "./check-daemon-benchmark.mjs";

const existing = validateBaseline(
  JSON.parse(await readFile(baselinePath, "utf8")),
);
const runnerClass = process.env.CMUXLAYER_BENCH_RUNNER_CLASS;
const workflowRunId = Number(process.env.GITHUB_RUN_ID);
const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const refreshSampleCount = 3;
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  process.env.GITHUB_SHA !== headSha ||
  runnerClass !== "github-actions-ubuntu-latest" ||
  !Number.isSafeInteger(workflowRunId) ||
  workflowRunId <= 0
) {
  throw new Error(
    "baseline refresh must run from the GitHub Actions workflow_dispatch job",
  );
}
const samples = [];
let artifactDir;
for (let index = 0; index < refreshSampleCount; index += 1) {
  const run = await runBenchmark({
    benchmarkEnv: {
      CMUXLAYER_BENCH_N: "8",
      CMUXLAYER_BENCH_ROUNDS: "12",
      CMUXLAYER_BENCH_LOCAL_GATE: "0",
    },
  });
  artifactDir = run.artifactDir;
  if (run.code !== 0 || run.result.verdict !== "GREEN") {
    throw new Error("refusing to refresh from a RED daemon benchmark");
  }
  if (
    run.result.replay?.clients !== 8 ||
    run.result.replay?.rounds !== 12 ||
    JSON.stringify(run.result.replay?.operations) !==
      JSON.stringify(existing.replay.operations)
  ) {
    throw new Error("refusing to refresh without the canonical 8x12 replay");
  }
  for (const operation of existing.replay.operations) {
    if (
      run.result.replay?.bytes?.[operation] !==
        existing.replay.bytes[operation] ||
      run.result.replay?.request_sha256?.[operation] !==
      existing.replay.request_sha256[operation]
    ) {
      throw new Error(
        `refusing to refresh changed canonical request ${operation}`,
      );
    }
  }
  const comparison = compareBenchmark(existing, run.result);
  if (!comparison.passed) {
    throw new Error(
      `refusing to refresh from an over-budget benchmark: ${comparison.failures.join("; ")}`,
    );
  }
  samples.push(run.result);
}

const measurements = maximumBenchmarkMeasurements(samples);
if (
  !Number.isFinite(measurements.first_send_after_spawn.lock_hold_ms) ||
  measurements.first_send_after_spawn.lock_hold_ms >
    existing.measurements.first_send_after_spawn.lock_hold_ms *
      existing.regression_ratio
) {
  throw new Error("refusing to refresh from an over-budget lock hold");
}
const measurementPairs = [
  ...existing.replay.operations.flatMap((operation) =>
    ["p50_ms", "p95_ms"].map((metric) => [
      measurements[operation][metric],
      existing.measurements[operation][metric],
    ]),
  ),
  [
    measurements.first_send_after_spawn.lock_hold_ms,
    existing.measurements.first_send_after_spawn.lock_hold_ms,
  ],
  [measurements.cli_send_ms, existing.measurements.cli_send_ms],
];
if (measurementPairs.some(([proposed, committed]) => proposed > committed)) {
  throw new Error("refusing to raise a committed performance baseline");
}
const refreshed = {
  ...existing,
  source: {
    git_sha: headSha,
    measured_at: new Date().toISOString(),
    runner_class: runnerClass,
    workflow_run_id: workflowRunId,
  },
  replay: samples[0].replay,
  measurements,
};
refreshed.refresh_attestation = {
  algorithm: "sha256",
  content_sha256: baselineContentSha256(refreshed),
};

validateBaseline(refreshed);
await writeFile(baselinePath, `${JSON.stringify(refreshed, null, 2)}\n`);
await writeFile(
  join(artifactDir, "refresh-samples.json"),
  `${JSON.stringify(samples, null, 2)}\n`,
);
console.log(`refreshed ${baselinePath}`);
