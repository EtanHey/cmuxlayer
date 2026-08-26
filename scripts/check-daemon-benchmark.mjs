#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const baselinePath = join(
  repoRoot,
  "benchmarks",
  "daemon-baseline.json",
);
const defaultArtifactDir = join(
  repoRoot,
  "docs.local",
  "scratch",
  "perf-budget",
);
export const CANONICAL_CLIENTS = 8;
export const CANONICAL_ROUNDS = 12;
export const CANONICAL_OPERATIONS = [
  "list_surfaces",
  "read_screen",
  "first_send_after_spawn",
];
const REQUIRED_REGRESSION_RATIO = 1.25;

function finite(value, path) {
  if (!Number.isFinite(value))
    throw new Error(`baseline ${path} must be a number`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function baselineContentSha256(baseline) {
  const { refresh_attestation: _attestation, ...content } = baseline;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function validateBaseline(baseline) {
  if (baseline?.schema_version !== 2)
    throw new Error("baseline schema_version must be 2");
  if (!/^[0-9a-f]{40}$/.test(baseline.source?.git_sha ?? "")) {
    throw new Error("baseline source.git_sha must be a full 40-hex commit");
  }
  if (baseline.source?.runner_class !== "github-actions-ubuntu-latest") {
    throw new Error(
      "baseline source.runner_class must be github-actions-ubuntu-latest",
    );
  }
  if (
    !Number.isSafeInteger(baseline.source?.workflow_run_id) ||
    baseline.source.workflow_run_id <= 0
  ) {
    throw new Error("baseline source.workflow_run_id must be a positive integer");
  }
  if (baseline.regression_ratio !== REQUIRED_REGRESSION_RATIO) {
    throw new Error("baseline regression_ratio must remain 1.25");
  }
  finite(
    baseline.sanity_caps_ms?.first_send_after_spawn,
    "sanity_caps_ms.first_send_after_spawn",
  );
  finite(baseline.sanity_caps_ms?.cli_send, "sanity_caps_ms.cli_send");
  finite(baseline.replay?.clients, "replay.clients");
  finite(baseline.replay?.rounds, "replay.rounds");
  if (!Array.isArray(baseline.replay?.operations)) {
    throw new Error("baseline replay.operations is required");
  }
  if (
    baseline.replay.clients !== CANONICAL_CLIENTS ||
    baseline.replay.rounds !== CANONICAL_ROUNDS ||
    JSON.stringify(baseline.replay.operations) !==
      JSON.stringify(CANONICAL_OPERATIONS)
  ) {
    throw new Error("baseline must use the canonical 8x12 replay");
  }
  for (const operation of baseline.replay.operations) {
    finite(baseline.replay?.bytes?.[operation], `replay.bytes.${operation}`);
    if (!/^[0-9a-f]{64}$/.test(baseline.replay?.request_sha256?.[operation])) {
      throw new Error(`baseline replay.request_sha256.${operation} is required`);
    }
    finite(
      baseline.measurements?.[operation]?.p50_ms,
      `measurements.${operation}.p50_ms`,
    );
    finite(
      baseline.measurements?.[operation]?.p95_ms,
      `measurements.${operation}.p95_ms`,
    );
  }
  finite(
    baseline.measurements?.first_send_after_spawn?.lock_hold_ms,
    "measurements.first_send_after_spawn.lock_hold_ms",
  );
  finite(baseline.measurements?.cli_send_ms, "measurements.cli_send_ms");
  if (baseline.refresh_attestation?.algorithm !== "sha256") {
    throw new Error("baseline refresh_attestation.algorithm must be sha256");
  }
  const expectedAttestation = baselineContentSha256(baseline);
  if (baseline.refresh_attestation?.content_sha256 !== expectedAttestation) {
    throw new Error(
      "baseline consistency assertion failed: run the documented CI refresh command",
    );
  }
  return baseline;
}

function ceiling(baselineValue, ratio, sanityCap = Infinity) {
  return Math.min(
    Math.round(baselineValue * ratio * 100) / 100,
    sanityCap,
  );
}

function currentMetrics(result) {
  const first = result?.latency?.first_send_after_spawn?.first;
  return {
    list_surfaces: result?.latency?.daemon_path?.list_surfaces,
    read_screen: result?.latency?.daemon_path?.read_screen,
    first_send_after_spawn: {
      p50_ms: first?.elapsed_ms,
      p95_ms: first?.elapsed_ms,
      lock_hold_ms:
        first?.lock_hold_ms ?? first?.receipt?.timings_ms?.lock_hold,
    },
    cli_send_ms: result?.latency?.first_send_after_spawn?.surface?.elapsed_ms,
  };
}

export function maximumBenchmarkMeasurements(results) {
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("at least one benchmark result is required");
  }
  const measurements = results.map(currentMetrics);
  const maximum = (read) => {
    const values = measurements.map(read);
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("benchmark measurements must be finite");
    }
    return Math.max(...values);
  };
  return {
    list_surfaces: {
      p50_ms: maximum((entry) => entry.list_surfaces?.p50_ms),
      p95_ms: maximum((entry) => entry.list_surfaces?.p95_ms),
    },
    read_screen: {
      p50_ms: maximum((entry) => entry.read_screen?.p50_ms),
      p95_ms: maximum((entry) => entry.read_screen?.p95_ms),
    },
    first_send_after_spawn: {
      p50_ms: maximum((entry) => entry.first_send_after_spawn.p50_ms),
      p95_ms: maximum((entry) => entry.first_send_after_spawn.p95_ms),
      lock_hold_ms: maximum(
        (entry) => entry.first_send_after_spawn.lock_hold_ms,
      ),
    },
    cli_send_ms: maximum((entry) => entry.cli_send_ms),
  };
}

function row(operation, metric, baseline, current, ceiling, unit = "ms") {
  const passed = Number.isFinite(current) && current <= ceiling;
  return { operation, metric, baseline, current, ceiling, unit, passed };
}

function exactRow(operation, metric, committed, current, unit) {
  const passed = Number.isFinite(current) && current === committed;
  return {
    operation,
    metric,
    baseline: committed,
    current,
    ceiling: committed,
    unit,
    passed,
    exact: true,
  };
}

export function compareBenchmark(
  baseline,
  result,
  { expectedRounds = baseline.replay.rounds } = {},
) {
  validateBaseline(baseline);
  const current = currentMetrics(result);
  const ratio = baseline.regression_ratio;
  const rows = [];
  for (const operation of baseline.replay.operations) {
    for (const metric of ["p50_ms", "p95_ms"]) {
      rows.push(
        row(
          operation,
          metric,
          baseline.measurements[operation][metric],
          current[operation]?.[metric],
          ceiling(
            baseline.measurements[operation][metric],
            ratio,
            operation === "first_send_after_spawn"
              ? baseline.sanity_caps_ms.first_send_after_spawn
              : Infinity,
          ),
        ),
      );
    }
  }
  rows.push(
    row(
      "first_send_after_spawn",
      "lock_hold_ms",
      baseline.measurements.first_send_after_spawn.lock_hold_ms,
      current.first_send_after_spawn.lock_hold_ms,
      ceiling(
        baseline.measurements.first_send_after_spawn.lock_hold_ms,
        ratio,
      ),
    ),
    row(
      "first_send_after_spawn",
      "cli_send_ms",
      baseline.measurements.cli_send_ms,
      current.cli_send_ms,
      ceiling(
        baseline.measurements.cli_send_ms,
        ratio,
        baseline.sanity_caps_ms.cli_send,
      ),
    ),
  );
  for (const operation of baseline.replay.operations) {
    rows.push(
      exactRow(
        operation,
        "request_bytes",
        baseline.replay.bytes[operation],
        result?.replay?.bytes?.[operation],
        "bytes",
      ),
    );
  }
  const failures = rows
    .filter((entry) => !entry.passed)
    .map((entry) => {
      const metric = entry.metric.replace("_ms", "");
      return entry.exact
        ? `${entry.operation} ${metric}: ${entry.current} ${entry.unit} does not match committed ${entry.baseline} ${entry.unit}`
        : `${entry.operation} ${metric}: ${entry.current}${entry.unit} exceeds ${entry.ceiling}${entry.unit}`;
    });
  if (result?.replay?.clients !== baseline.replay.clients) {
    failures.push(
      `replay clients: ${result?.replay?.clients} does not match committed ${baseline.replay.clients}`,
    );
  }
  if (result?.replay?.rounds !== expectedRounds) {
    failures.push(
      `replay rounds: ${result?.replay?.rounds} does not match expected ${expectedRounds}`,
    );
  }
  if (
    JSON.stringify(result?.replay?.operations) !==
    JSON.stringify(baseline.replay.operations)
  ) {
    failures.push("replay operations do not match the committed workload");
  }
  for (const operation of baseline.replay.operations) {
    if (
      result?.replay?.request_sha256?.[operation] !==
      baseline.replay.request_sha256[operation]
    ) {
      failures.push(
        `${operation} request_sha256 does not match the committed workload`,
      );
    }
  }
  if (result?.verdict !== "GREEN")
    failures.push("benchmark intrinsic gates returned RED");
  return { passed: failures.length === 0, rows, failures };
}

function formatted(value, unit) {
  return Number.isFinite(value) ? `${value} ${unit}` : "missing";
}

export function renderMarkdownComparison(baseline, result, comparison) {
  const lines = [
    "<!-- cmuxlayer-perf-budget -->",
    `## Daemon performance budget: ${comparison.passed ? "GREEN" : "RED"}`,
    "",
    `Replay: ${result.clients} clients x ${result.rounds} rounds. Runner regression ratio: ${baseline.regression_ratio}x. CI ceilings derive from the committed ${baseline.source.runner_class} measurements; first-send and CLI retain 10,000 ms sanity caps.`,
    "",
    "| Operation | Metric | Baseline | Current | Ceiling | Status |",
    "|---|---:|---:|---:|---:|:---:|",
  ];
  for (const entry of comparison.rows) {
    lines.push(
      `| ${entry.operation} | ${entry.metric} | ${formatted(entry.baseline, entry.unit)} | ${formatted(entry.current, entry.unit)} | ${formatted(entry.ceiling, entry.unit)} | ${entry.passed ? "PASS" : "FAIL"} |`,
    );
  }
  if (comparison.failures.length) {
    lines.push(
      "",
      "Failures:",
      ...comparison.failures.map((failure) => `- ${failure}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command} exited on ${signal}`));
      resolvePromise(code ?? 1);
    });
  });
}

export async function runBenchmark({
  artifactDir = defaultArtifactDir,
  benchmarkScript = join(repoRoot, "scripts", "bench-daemon.mjs"),
  benchmarkEnv = {},
} = {}) {
  const resolvedArtifactDir = resolve(artifactDir);
  const resultPath = join(resolvedArtifactDir, "result.json");
  const invocationNonce = randomUUID();
  await mkdir(resolvedArtifactDir, { recursive: true });
  await rm(resultPath, { force: true });
  const code = await run(
    process.execPath,
    [benchmarkScript],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...benchmarkEnv,
        CMUXLAYER_BENCH_INVOCATION_NONCE: invocationNonce,
        CMUXLAYER_BENCH_JSON_PATH: resultPath,
        CMUXLAYER_BENCH_SCRATCH: join(resolvedArtifactDir, "scratch"),
      },
    },
  );
  let result;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    throw new Error(`benchmark did not write valid JSON (${error.message})`);
  }
  if (result.invocation_nonce !== invocationNonce) {
    throw new Error("benchmark result failed this-invocation attestation");
  }
  return { code, result, resultPath, artifactDir: resolvedArtifactDir };
}

async function main() {
  const baseline = validateBaseline(
    JSON.parse(await readFile(baselinePath, "utf8")),
  );
  const runResult = await runBenchmark({
    artifactDir: process.env.CMUXLAYER_PERF_ARTIFACT_DIR,
  });
  const expectedRounds = Number(
    process.env.CMUXLAYER_BENCH_ROUNDS ?? baseline.replay.rounds,
  );
  const comparison = compareBenchmark(baseline, runResult.result, {
    expectedRounds,
  });
  const markdown = renderMarkdownComparison(
    baseline,
    runResult.result,
    comparison,
  );
  const reportPath = join(runResult.artifactDir, "comment.md");
  await writeFile(reportPath, markdown);
  process.stdout.write(markdown);
  if (runResult.code !== 0 || !comparison.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
