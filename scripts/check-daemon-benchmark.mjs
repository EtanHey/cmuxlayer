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
  "send_to_surface_warm",
  "send_to_agent_warm",
  "list_agents",
  "control_health",
  "spawn_close_during_sweep",
  "first_send_after_spawn",
  "send_to_surface_10_parallel",
  "read_screen_10_parallel",
];
export const BENCHMARK_HISTORY_LIMIT = 50;
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

function historyEntryContentSha256(entry) {
  const { content_sha256: _attestation, ...content } = entry;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

function validHistoryEntry(entry) {
  if (!/^[0-9a-f]{40}$/.test(entry?.source?.git_sha ?? "")) return false;
  if (
    !Number.isSafeInteger(entry?.source?.workflow_run_id) ||
    entry.source.workflow_run_id <= 0 ||
    entry?.content_sha256 !== historyEntryContentSha256(entry)
  ) {
    return false;
  }
  return [...CANONICAL_OPERATIONS, "cli_send_ms"].every((operation) => {
    const measurement = entry?.measurements?.[operation];
    if (!Number.isFinite(measurement?.p50_ms)) return false;
    if (operation === "cli_send_ms") return true;
    return (
      Number.isFinite(measurement.p95_ms) &&
      Number.isFinite(measurement.lock_hold_ms)
    );
  });
}

export function isAttestedLegacyBaseline(baseline) {
  return (
    baseline?.schema_version === 2 &&
    baseline?.refresh_attestation?.algorithm === "sha256" &&
    baseline.refresh_attestation.content_sha256 ===
      baselineContentSha256(baseline) &&
    JSON.stringify(baseline?.replay?.operations) ===
      JSON.stringify(CANONICAL_OPERATIONS.slice(0, 8)) &&
    baseline?.replay?.row_metadata === undefined
  );
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
    throw new Error(
      "baseline source.workflow_run_id must be a positive integer",
    );
  }
  if (
    baseline.source?.increase_reason !== undefined &&
    (typeof baseline.source.increase_reason !== "string" ||
      !baseline.source.increase_reason.trim())
  ) {
    throw new Error("baseline source.increase_reason must be non-empty");
  }
  if (baseline.regression_ratio !== REQUIRED_REGRESSION_RATIO) {
    throw new Error("baseline regression_ratio must remain 1.25");
  }
  finite(baseline.sanity_caps_ms?.all_rows, "sanity_caps_ms.all_rows");
  if (baseline.sanity_caps_ms.all_rows !== 1_000) {
    throw new Error("baseline sanity_caps_ms.all_rows must remain 1000");
  }
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
    const metadata = baseline.replay?.row_metadata?.[operation];
    if (!metadata || !["sampled", "single_shot"].includes(metadata.sampling)) {
      throw new Error(
        `baseline replay.row_metadata.${operation}.sampling must be sampled or single_shot`,
      );
    }
    if (
      !Number.isSafeInteger(metadata.samples_per_run) ||
      metadata.samples_per_run <= 0
    ) {
      throw new Error(
        `baseline replay.row_metadata.${operation}.samples_per_run must be a positive integer`,
      );
    }
    if (metadata.sampling === "sampled" && metadata.samples_per_run < 12) {
      throw new Error(
        `baseline sampled row ${operation} must have at least 12 samples per run`,
      );
    }
    if (
      metadata.stress !== undefined &&
      typeof metadata.stress !== "boolean"
    ) {
      throw new Error(`baseline replay.row_metadata.${operation}.stress must be boolean`);
    }
    finite(baseline.replay?.bytes?.[operation], `replay.bytes.${operation}`);
    if (!/^[0-9a-f]{64}$/.test(baseline.replay?.request_sha256?.[operation])) {
      throw new Error(
        `baseline replay.request_sha256.${operation} is required`,
      );
    }
    if (baseline.replay?.transport?.[operation] !== "socket") {
      throw new Error(
        `baseline replay.transport.${operation} must attest socket`,
      );
    }
    finite(
      baseline.measurements?.[operation]?.p50_ms,
      `measurements.${operation}.p50_ms`,
    );
    finite(
      baseline.measurements?.[operation]?.p95_ms,
      `measurements.${operation}.p95_ms`,
    );
    finite(
      baseline.measurements?.[operation]?.lock_hold_ms,
      `measurements.${operation}.lock_hold_ms`,
    );
  }
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

export function performanceCeiling(
  baselineValue,
  ratio,
  sanityCap = 1_000,
  marginMs = 300,
) {
  return Math.min(
    Math.round(
      Math.max(baselineValue * ratio, baselineValue + marginMs) * 100,
    ) /
      100,
    sanityCap,
  );
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function standardDeviation(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      values.length,
  );
}

function operationMargin(
  baseline,
  operation,
  history,
  historyDegraded = false,
) {
  const metadata = baseline.replay.row_metadata[operation];
  if (
    historyDegraded ||
    metadata.sampling === "single_shot" ||
    metadata.samples_per_run < 12
  ) {
    return 300;
  }
  const measurement = baseline.measurements[operation];
  const spread = Math.max(0, 2 * (measurement.p95_ms - measurement.p50_ms));
  const historicalP50 = history
    .map((entry) => entry?.measurements?.[operation]?.p50_ms)
    .filter(Number.isFinite);
  const varianceMargin =
    historicalP50.length >= 5 ? 3 * standardDeviation(historicalP50) : 0;
  return rounded(Math.max(spread, varianceMargin));
}

function operationMarginRule(
  baseline,
  operation,
  history,
  historyDegraded = false,
) {
  const metadata = baseline.replay.row_metadata[operation];
  if (
    historyDegraded ||
    metadata.sampling === "single_shot" ||
    metadata.samples_per_run < 12
  ) {
    return "constant +300ms (single-shot)";
  }
  const measuredRuns = history.filter((entry) =>
    Number.isFinite(entry?.measurements?.[operation]?.p50_ms),
  ).length;
  const runCount = Math.max(1, measuredRuns);
  return `measured (${runCount} ${runCount === 1 ? "run" : "runs"})`;
}

export function requireBaselineIncreaseReason(measurementPairs, reason) {
  const raisesCommittedBaseline = measurementPairs.some(
    ([proposed, committed]) => proposed > committed,
  );
  if (raisesCommittedBaseline && !reason?.trim()) {
    throw new Error(
      'refusing to raise a committed performance baseline without --reason "<text>"',
    );
  }
  return raisesCommittedBaseline;
}

function currentMetrics(result) {
  const first = result?.latency?.first_send_after_spawn?.first;
  const sampledFirst = result?.latency?.first_send_after_spawn?.sampled;
  return {
    list_surfaces: {
      ...result?.latency?.daemon_path?.list_surfaces,
      lock_hold_ms:
        result?.latency?.daemon_path?.list_surfaces?.lock_hold_ms ?? 0,
    },
    read_screen: {
      ...result?.latency?.daemon_path?.read_screen,
      lock_hold_ms:
        result?.latency?.daemon_path?.read_screen?.lock_hold_ms ?? 0,
    },
    send_to_surface_warm: result?.latency?.send_to_surface_warm,
    send_to_agent_warm: result?.latency?.send_to_agent_warm,
    list_agents: result?.latency?.daemon_path?.list_agents,
    control_health: result?.latency?.daemon_path?.control_health,
    spawn_close_during_sweep: result?.latency?.spawn_close_during_sweep,
    send_to_surface_10_parallel:
      result?.latency?.send_to_surface_10_parallel ??
      result?.latency?.daemon_path?.send_to_surface_10_parallel,
    read_screen_10_parallel:
      result?.latency?.read_screen_10_parallel ??
      result?.latency?.daemon_path?.read_screen_10_parallel,
    first_send_after_spawn: {
      p50_ms: sampledFirst?.p50_ms ?? first?.elapsed_ms,
      p95_ms: sampledFirst?.p95_ms ?? first?.elapsed_ms,
      lock_hold_ms:
        sampledFirst?.lock_hold_ms ??
        first?.lock_hold_ms ??
        first?.receipt?.timings_ms?.lock_hold,
      transport:
        sampledFirst?.transport ?? first?.transport ?? first?.receipt?.transport,
    },
    cli_send_transport: result?.latency?.send_to_surface_warm?.transport,
    cli_send_ms:
      result?.latency?.send_to_surface_warm?.p50_ms ??
      result?.latency?.first_send_after_spawn?.surface?.elapsed_ms,
  };
}

export function appendGreenMainHistory(history, result, context) {
  const existing = Array.isArray(history) ? history : [];
  if (
    result?.verdict !== "GREEN" ||
    context?.event_name !== "push" ||
    context?.ref !== "refs/heads/main"
  ) {
    return existing;
  }
  if (
    !/^[0-9a-f]{40}$/.test(context?.git_sha ?? "") ||
    !Number.isSafeInteger(context?.workflow_run_id) ||
    context.workflow_run_id <= 0
  ) {
    throw new Error("green main history requires an exact SHA and workflow run id");
  }
  if (
    existing.some(
      (entry) => entry?.source?.workflow_run_id === context.workflow_run_id,
    )
  ) {
    return existing;
  }
  const measurements = currentMetrics(result);
  const entry = {
    source: {
      git_sha: context.git_sha,
      workflow_run_id: context.workflow_run_id,
      measured_at: context.measured_at ?? new Date().toISOString(),
    },
    measurements: Object.fromEntries(
      [...CANONICAL_OPERATIONS, "cli_send_ms"].map((operation) => [
        operation,
        operation === "cli_send_ms"
          ? { p50_ms: measurements.cli_send_ms }
          : measurements[operation],
      ]),
    ),
  };
  const attestedEntry = {
    ...entry,
    content_sha256: historyEntryContentSha256(entry),
  };
  return [...existing, attestedEntry].slice(-BENCHMARK_HISTORY_LIMIT);
}

export async function readBenchmarkHistory(historyPath) {
  try {
    const parsed = JSON.parse(await readFile(historyPath, "utf8"));
    if (!Array.isArray(parsed?.runs)) {
      return {
        runs: [],
        degraded: true,
        reason: `${historyPath} does not contain a runs array`,
      };
    }
    if (!parsed.runs.every(validHistoryEntry)) {
      return {
        runs: [],
        degraded: true,
        reason: `${historyPath} contains a malformed entry`,
      };
    }
    return { runs: parsed.runs, degraded: false };
  } catch (error) {
    if (error?.code === "ENOENT") return { runs: [], degraded: false };
    return {
      runs: [],
      degraded: true,
      reason: `${historyPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
    ...Object.fromEntries(
      CANONICAL_OPERATIONS.map((operation) => [
        operation,
        {
          p50_ms: maximum((entry) => entry[operation]?.p50_ms),
          p95_ms: maximum((entry) => entry[operation]?.p95_ms),
          lock_hold_ms: maximum((entry) => entry[operation]?.lock_hold_ms),
        },
      ]),
    ),
    cli_send_ms: maximum((entry) => entry.cli_send_ms),
  };
}

function row(
  operation,
  metric,
  baseline,
  current,
  ceiling,
  unit = "ms",
  transport,
  metadata = {},
) {
  const passed = Number.isFinite(current) && current <= ceiling;
  return {
    operation,
    metric,
    baseline,
    current,
    ceiling,
    unit,
    transport,
    sampling: metadata.sampling,
    stress: metadata.stress === true,
    history_degraded: metadata.history_degraded === true,
    margin_ms: metadata.margin_ms,
    margin_rule: metadata.margin_rule,
    passed,
  };
}

function exactRow(operation, metric, committed, current, unit, metadata = {}) {
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
    sampling: metadata.sampling,
    stress: metadata.stress === true,
    history_degraded: metadata.history_degraded === true,
    margin_rule: metadata.margin_rule,
  };
}

export function compareBenchmark(
  baseline,
  result,
  {
    expectedRounds = baseline.replay.rounds,
    history = [],
    historyDegraded = false,
    historyDegradedReason,
  } = {},
) {
  validateBaseline(baseline);
  const current = currentMetrics(result);
  const ratio = baseline.regression_ratio;
  const rows = [];
  for (const operation of baseline.replay.operations) {
    const metadata = baseline.replay.row_metadata[operation];
    const marginMs = operationMargin(
      baseline,
      operation,
      history,
      historyDegraded,
    );
    const marginRule = operationMarginRule(
      baseline,
      operation,
      history,
      historyDegraded,
    );
    for (const metric of ["p50_ms", "p95_ms"]) {
      rows.push(
        row(
          operation,
          metric,
          baseline.measurements[operation][metric],
          current[operation]?.[metric],
          performanceCeiling(
            baseline.measurements[operation][metric],
            ratio,
            baseline.sanity_caps_ms.all_rows,
            marginMs,
          ),
          "ms",
          current[operation]?.transport,
          {
            ...metadata,
            margin_ms: marginMs,
            margin_rule: marginRule,
            history_degraded: historyDegraded,
          },
        ),
      );
    }
  }
  for (const operation of baseline.replay.operations) {
    const metadata = baseline.replay.row_metadata[operation];
    const marginMs = operationMargin(
      baseline,
      operation,
      history,
      historyDegraded,
    );
    const marginRule = operationMarginRule(
      baseline,
      operation,
      history,
      historyDegraded,
    );
    rows.push(
      row(
        operation,
        "lock_hold_ms",
        baseline.measurements[operation].lock_hold_ms,
        current[operation]?.lock_hold_ms,
        performanceCeiling(
          baseline.measurements[operation].lock_hold_ms,
          ratio,
          baseline.sanity_caps_ms.all_rows,
          marginMs,
        ),
        "ms",
        current[operation]?.transport,
        {
          ...metadata,
          margin_ms: marginMs,
          margin_rule: marginRule,
          history_degraded: historyDegraded,
        },
      ),
    );
  }
  rows.push(
    row(
      "send_to_surface_warm",
      "cli_send_ms",
      baseline.measurements.cli_send_ms,
      current.cli_send_ms,
      performanceCeiling(
        baseline.measurements.cli_send_ms,
        ratio,
        baseline.sanity_caps_ms.cli_send,
        operationMargin(
          baseline,
          "send_to_surface_warm",
          history,
          historyDegraded,
        ),
      ),
      "ms",
      current.cli_send_transport,
      {
        ...baseline.replay.row_metadata.send_to_surface_warm,
        margin_ms: operationMargin(
          baseline,
          "send_to_surface_warm",
          history,
          historyDegraded,
        ),
        margin_rule: operationMarginRule(
          baseline,
          "send_to_surface_warm",
          history,
          historyDegraded,
        ),
        history_degraded: historyDegraded,
      },
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
        {
          ...baseline.replay.row_metadata[operation],
          margin_rule: operationMarginRule(
            baseline,
            operation,
            history,
            historyDegraded,
          ),
          history_degraded: historyDegraded,
        },
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
  for (const operation of baseline.replay.operations) {
    const expected = baseline.replay.row_metadata[operation];
    const candidate = result?.replay?.row_metadata?.[operation];
    if (
      candidate?.sampling !== expected.sampling ||
      candidate?.samples_per_run !== expected.samples_per_run ||
      (candidate?.stress === true) !== (expected.stress === true)
    ) {
      failures.push(
        `candidate row_metadata.${operation} does not match the committed sampling workload`,
      );
    }
  }
  if (historyDegraded) {
    failures.push(
      `benchmark history degraded: ${historyDegradedReason ?? "untrusted cache"}; conservative +300ms margins active`,
    );
  }
  for (const operation of baseline.replay.operations) {
    if (current[operation]?.transport !== "socket") {
      failures.push(
        `${operation} transport: ${current[operation]?.transport ?? "missing"}; cli fallback active`,
      );
    }
  }
  if (current.cli_send_transport !== "socket") {
    failures.push(
      `cli_send_ms transport: ${current.cli_send_transport ?? "missing"}; cli fallback active`,
    );
  }
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
  const tableHeader = [
    "| Operation | Transport | Sampling | Margin rule | Metric | Baseline | Current | Ceiling | Status |",
    "|---|:---:|:---:|:---:|---:|---:|---:|---:|:---:|",
  ];
  const tableRow = (entry) =>
    `| ${entry.operation} | ${entry.transport ?? result?.replay?.transport?.[entry.operation] ?? "missing"} | ${entry.sampling ?? "single_shot"}${entry.stress ? " · stress" : ""}${entry.history_degraded ? " · history-degraded · wide-margin" : ""} | ${entry.margin_rule} | ${entry.metric} | ${formatted(entry.baseline, entry.unit)} | ${formatted(entry.current, entry.unit)} | ${formatted(entry.ceiling, entry.unit)} | ${entry.passed ? "PASS" : "FAIL"} |`;
  const changed = comparison.rows.filter(
    (entry) => !entry.passed || entry.current !== entry.baseline,
  );
  const unchangedCount = comparison.rows.length - changed.length;
  const lines = [
    "<!-- cmuxlayer-perf-budget -->",
    `## Daemon performance budget: ${comparison.passed ? "GREEN" : "RED"}`,
    "",
    `Replay: ${result.clients} clients x ${result.rounds} rounds. Runner regression ratio: ${baseline.regression_ratio}x. Sampled rows use max(2 x (p95 - p50), 3 sigma of p50 after five green main runs); single-shot or untrusted-history rows retain +300 ms. Every row keeps the baseline x ${baseline.regression_ratio} floor and its sanity cap.`,
    "",
    ...tableHeader,
    ...changed.map(tableRow),
    "",
    `${unchangedCount} rows unchanged.`,
    "",
    "<details>",
    "<summary>Full table</summary>",
    "",
    ...tableHeader,
    ...comparison.rows.map(tableRow),
    "",
    "</details>",
  ];
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
  const code = await run(process.execPath, [benchmarkScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...benchmarkEnv,
      CMUXLAYER_BENCH_INVOCATION_NONCE: invocationNonce,
      CMUXLAYER_BENCH_JSON_PATH: resultPath,
      CMUXLAYER_BENCH_SCRATCH: join(resolvedArtifactDir, "scratch"),
    },
  });
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
  const rawBaseline = JSON.parse(await readFile(baselinePath, "utf8"));
  let baseline;
  let legacyBaseline = false;
  try {
    baseline = validateBaseline(rawBaseline);
  } catch (error) {
    if (!isAttestedLegacyBaseline(rawBaseline)) throw error;
    baseline = rawBaseline;
    legacyBaseline = true;
  }
  const runResult = await runBenchmark({
    artifactDir: process.env.CMUXLAYER_PERF_ARTIFACT_DIR,
  });
  if (legacyBaseline) {
    const markdown = [
      "<!-- cmuxlayer-perf-budget -->",
      "## Daemon performance budget: RED",
      "",
      "The committed baseline is an attested legacy 8-row snapshot. This run produced canonical 10-row evidence, but enforcement remains fail-closed until the CI-runner artifact is imported into the committed baseline.",
      "",
      `Evidence invocation nonce: ${runResult.result?.invocation_nonce ?? "missing"}`,
      "",
    ].join("\n");
    const reportPath = join(runResult.artifactDir, "comment.md");
    await writeFile(reportPath, markdown);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
    }
    process.stdout.write(markdown);
    process.exitCode = 1;
    return;
  }
  const expectedRounds = Number(
    process.env.CMUXLAYER_BENCH_ROUNDS ?? baseline.replay.rounds,
  );
  const historyPath =
    process.env.CMUXLAYER_BENCH_HISTORY_PATH ??
    join(runResult.artifactDir, "history.json");
  const historyState = await readBenchmarkHistory(historyPath);
  const comparison = compareBenchmark(baseline, runResult.result, {
    expectedRounds,
    history: historyState.runs,
    historyDegraded: historyState.degraded,
    historyDegradedReason: historyState.reason,
  });
  const markdown = renderMarkdownComparison(
    baseline,
    runResult.result,
    comparison,
  );
  const reportPath = join(runResult.artifactDir, "comment.md");
  await writeFile(reportPath, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
  }
  if (runResult.code === 0 && comparison.passed) {
    const nextHistory = appendGreenMainHistory(
      historyState.runs,
      runResult.result,
      {
      event_name: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
      git_sha: process.env.GITHUB_SHA,
      workflow_run_id: Number(process.env.GITHUB_RUN_ID),
      },
    );
    if (nextHistory !== historyState.runs) {
      await mkdir(dirname(historyPath), { recursive: true });
      await writeFile(
        historyPath,
        `${JSON.stringify({ schema_version: 1, limit: BENCHMARK_HISTORY_LIMIT, runs: nextHistory }, null, 2)}\n`,
      );
    }
  }
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
