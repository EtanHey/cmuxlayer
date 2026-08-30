#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  baselineContentSha256,
  baselinePath,
  CANONICAL_OPERATIONS,
  compareBenchmark,
  maximumBenchmarkMeasurements,
  performanceCeiling,
  requireBaselineIncreaseReason,
  runBenchmark,
  validateBaseline,
} from "./check-daemon-benchmark.mjs";

const rawExisting = JSON.parse(await readFile(baselinePath, "utf8"));
let existing;
let migratingLegacyBaseline = false;
try {
  existing = validateBaseline(rawExisting);
} catch (error) {
  const legacyAttestationIsValid =
    rawExisting?.schema_version === 2 &&
    rawExisting?.refresh_attestation?.algorithm === "sha256" &&
    rawExisting.refresh_attestation.content_sha256 ===
      baselineContentSha256(rawExisting);
  if (!legacyAttestationIsValid) throw error;
  existing = rawExisting;
  migratingLegacyBaseline = true;
}
const runnerClass = process.env.CMUXLAYER_BENCH_RUNNER_CLASS;
const workflowRunId = Number(process.env.GITHUB_RUN_ID);
const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const refreshSampleCount = 3;
const importedResultPath = process.env.CMUXLAYER_BENCH_IMPORT_RESULT_PATH;
const importedSourceRunId = Number(process.env.CMUXLAYER_BENCH_SOURCE_RUN_ID);
const importedSourceSha = process.env.CMUXLAYER_BENCH_SOURCE_SHA;
const runnerRebase = Boolean(importedResultPath);
const reasonIndex = process.argv.indexOf("--reason");
const increaseReason =
  reasonIndex >= 0 ? process.argv[reasonIndex + 1]?.trim() ?? "" : "";
if (reasonIndex >= 0 && !increaseReason) {
  throw new Error('--reason requires a non-empty explanation');
}
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
if (
  runnerRebase &&
  (!Number.isSafeInteger(importedSourceRunId) ||
    importedSourceRunId <= 0 ||
    !/^[0-9a-f]{40}$/.test(importedSourceSha ?? ""))
) {
  throw new Error("runner rebase requires verified CI source evidence");
}
const samples = runnerRebase
  ? [JSON.parse(await readFile(importedResultPath, "utf8"))]
  : [];
let artifactDir;
for (let index = 0; !runnerRebase && index < refreshSampleCount; index += 1) {
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
      JSON.stringify(CANONICAL_OPERATIONS)
  ) {
    throw new Error("refusing to refresh without the canonical 8x12 replay");
  }
  for (const operation of CANONICAL_OPERATIONS) {
    if (
      !Number.isFinite(run.result.replay?.bytes?.[operation]) ||
      !/^[0-9a-f]{64}$/.test(
        run.result.replay?.request_sha256?.[operation] ?? "",
      ) ||
      (!migratingLegacyBaseline &&
        (run.result.replay.bytes[operation] !==
          existing.replay.bytes[operation] ||
          run.result.replay.request_sha256[operation] !==
            existing.replay.request_sha256[operation]))
    ) {
      throw new Error(
        `refusing to refresh changed canonical request ${operation}`,
      );
    }
  }
  samples.push(run.result);
}

for (const sample of samples) {
  if (sample.verdict !== "GREEN") {
    throw new Error("refusing to refresh from a RED daemon benchmark");
  }
  if (
    sample.replay?.clients !== 8 ||
    sample.replay?.rounds !== 12 ||
    JSON.stringify(sample.replay?.operations) !==
      JSON.stringify(CANONICAL_OPERATIONS)
  ) {
    throw new Error("refusing to refresh without the canonical 8x12 replay");
  }
  for (const operation of CANONICAL_OPERATIONS) {
    if (
      !Number.isFinite(sample.replay?.bytes?.[operation]) ||
      !/^[0-9a-f]{64}$/.test(
        sample.replay?.request_sha256?.[operation] ?? "",
      ) ||
      (!migratingLegacyBaseline &&
        (sample.replay.bytes[operation] !== existing.replay.bytes[operation] ||
          sample.replay.request_sha256[operation] !==
            existing.replay.request_sha256[operation]))
    ) {
      throw new Error(
        `refusing to refresh changed canonical request ${operation}`,
      );
    }
  }
  if (!runnerRebase && !migratingLegacyBaseline) {
    const comparison = compareBenchmark(existing, sample);
    if (!comparison.passed) {
      throw new Error(
        `refusing to refresh from an over-budget benchmark: ${comparison.failures.join("; ")}`,
      );
    }
  }
}

const measured = maximumBenchmarkMeasurements(samples);
const chooseMetric = runnerRebase ? Math.max : Math.min;
const measurements = {
  ...Object.fromEntries(
    CANONICAL_OPERATIONS.map((operation) => [
      operation,
      Object.fromEntries(
        ["p50_ms", "p95_ms", "lock_hold_ms"].map((metric) => [
          metric,
          migratingLegacyBaseline
            ? measured[operation][metric]
            : Number.isFinite(existing.measurements?.[operation]?.[metric])
            ? chooseMetric(
                existing.measurements[operation][metric],
                measured[operation][metric],
              )
            : measured[operation][metric],
        ]),
      ),
    ]),
  ),
  cli_send_ms: migratingLegacyBaseline
    ? measured.cli_send_ms
    : chooseMetric(existing.measurements.cli_send_ms, measured.cli_send_ms),
};
if (
  !Number.isFinite(measurements.first_send_after_spawn.lock_hold_ms) ||
  measurements.first_send_after_spawn.lock_hold_ms >
    performanceCeiling(
      existing.measurements.first_send_after_spawn.lock_hold_ms,
      existing.regression_ratio,
      1_000,
    )
) {
  throw new Error("refusing to refresh from an over-budget lock hold");
}
const measurementPairs = [
  ...CANONICAL_OPERATIONS.flatMap((operation) =>
    ["p50_ms", "p95_ms", "lock_hold_ms"].map((metric) => [
      measurements[operation][metric],
      existing.measurements?.[operation]?.[metric] ?? Infinity,
    ]),
  ),
  [measurements.cli_send_ms, existing.measurements.cli_send_ms],
];
const raisesCommittedBaseline = requireBaselineIncreaseReason(
  measurementPairs,
  increaseReason,
);
if (
  !runnerRebase &&
  raisesCommittedBaseline
) {
  throw new Error("refusing to raise a committed performance baseline");
}
const refreshed = {
  ...existing,
  source: {
    git_sha: runnerRebase ? importedSourceSha : headSha,
    measured_at: new Date().toISOString(),
    runner_class: runnerClass,
    workflow_run_id: runnerRebase ? importedSourceRunId : workflowRunId,
    ...(raisesCommittedBaseline ? { increase_reason: increaseReason } : {}),
  },
  sanity_caps_ms: { all_rows: 1_000, cli_send: 1_000 },
  replay: samples[0].replay,
  measurements,
};
refreshed.refresh_attestation = {
  algorithm: "sha256",
  content_sha256: baselineContentSha256(refreshed),
};

validateBaseline(refreshed);
await writeFile(baselinePath, `${JSON.stringify(refreshed, null, 2)}\n`);
const refreshEvidenceDir =
  artifactDir ??
  join(dirname(baselinePath), "..", "docs.local", "scratch", "perf-budget");
await mkdir(refreshEvidenceDir, { recursive: true });
if (runnerRebase) {
  await writeFile(
    join(refreshEvidenceDir, "result.json"),
    `${JSON.stringify(samples[0], null, 2)}\n`,
  );
}
await writeFile(
  join(refreshEvidenceDir, "refresh-samples.json"),
  `${JSON.stringify(samples, null, 2)}\n`,
);
console.log(`refreshed ${baselinePath}`);
