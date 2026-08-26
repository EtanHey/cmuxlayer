#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

function finite(value, path) {
  if (!Number.isFinite(value))
    throw new Error(`baseline ${path} must be a number`);
}

export function validateBaseline(baseline) {
  if (baseline?.schema_version !== 1)
    throw new Error("baseline schema_version must be 1");
  if (!/^[0-9a-f]{40}$/.test(baseline.source?.git_sha ?? "")) {
    throw new Error("baseline source.git_sha must be a full 40-hex commit");
  }
  finite(
    baseline.runner_margins?.list_surfaces,
    "runner_margins.list_surfaces",
  );
  finite(baseline.runner_margins?.read_screen, "runner_margins.read_screen");
  finite(baseline.replay?.clients, "replay.clients");
  finite(baseline.replay?.rounds, "replay.rounds");
  if (!Array.isArray(baseline.replay?.operations)) {
    throw new Error("baseline replay.operations is required");
  }
  for (const operation of baseline.replay.operations) {
    finite(baseline.replay?.bytes?.[operation], `replay.bytes.${operation}`);
    finite(
      baseline.measurements?.[operation]?.p50_ms,
      `measurements.${operation}.p50_ms`,
    );
    finite(
      baseline.measurements?.[operation]?.p95_ms,
      `measurements.${operation}.p95_ms`,
    );
    finite(
      baseline.ceilings?.[operation]?.p50_ms,
      `ceilings.${operation}.p50_ms`,
    );
    finite(
      baseline.ceilings?.[operation]?.p95_ms,
      `ceilings.${operation}.p95_ms`,
    );
  }
  finite(
    baseline.measurements?.first_send_after_spawn?.lock_hold_ms,
    "measurements.first_send_after_spawn.lock_hold_ms",
  );
  finite(baseline.measurements?.cli_send_ms, "measurements.cli_send_ms");
  finite(
    baseline.ceilings?.first_send_after_spawn?.lock_hold_ms,
    "ceilings.first_send_after_spawn.lock_hold_ms",
  );
  finite(baseline.ceilings?.cli_send_ms, "ceilings.cli_send_ms");
  if (
    baseline.ceilings.first_send_after_spawn.p50_ms > 2_000 ||
    baseline.ceilings.first_send_after_spawn.p95_ms > 2_000
  ) {
    throw new Error("first-send ceilings must remain at or below 2,000ms");
  }
  if (baseline.ceilings.cli_send_ms > 4_000) {
    throw new Error("CLI send ceiling must remain at or below 4,000ms");
  }
  if (baseline.ceilings.read_screen.p50_ms > 250) {
    throw new Error("read_screen p50 ceiling must remain at or below 250ms");
  }
  return baseline;
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
  const rows = [];
  for (const operation of baseline.replay.operations) {
    for (const metric of ["p50_ms", "p95_ms"]) {
      rows.push(
        row(
          operation,
          metric,
          baseline.measurements[operation][metric],
          current[operation]?.[metric],
          baseline.ceilings[operation][metric],
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
      baseline.ceilings.first_send_after_spawn.lock_hold_ms,
    ),
    row(
      "first_send_after_spawn",
      "cli_send_ms",
      baseline.measurements.cli_send_ms,
      current.cli_send_ms,
      baseline.ceilings.cli_send_ms,
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
    `Replay: ${result.clients} clients x ${result.rounds} rounds. Runner margins: list_surfaces ${baseline.runner_margins.list_surfaces}x; read_screen ${baseline.runner_margins.read_screen}x. First-send <=2,000 ms socket and CLI send <=4,000 ms remain hard ceilings.`,
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

export async function runBenchmark({ artifactDir = defaultArtifactDir } = {}) {
  const resolvedArtifactDir = resolve(artifactDir);
  const resultPath = join(resolvedArtifactDir, "result.json");
  await mkdir(resolvedArtifactDir, { recursive: true });
  const code = await run(
    process.execPath,
    [join(repoRoot, "scripts", "bench-daemon.mjs")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
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
