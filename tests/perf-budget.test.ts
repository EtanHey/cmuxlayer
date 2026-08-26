import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareBenchmark,
  renderMarkdownComparison,
  validateBaseline,
} from "../scripts/check-daemon-benchmark.mjs";

const repoRoot = join(__dirname, "..");

const baseline = {
  schema_version: 1,
  source: { git_sha: "f0ca937", measured_at: "2026-08-26T00:00:00Z" },
  runner_margin_ratio: 2.8,
  replay: {
    clients: 8,
    rounds: 12,
    operations: ["list_surfaces", "read_screen", "first_send_after_spawn"],
    bytes: {
      list_surfaces: 140,
      read_screen: 170,
      first_send_after_spawn: 240,
    },
  },
  measurements: {
    list_surfaces: { p50_ms: 100, p95_ms: 120 },
    read_screen: { p50_ms: 140, p95_ms: 160 },
    first_send_after_spawn: {
      p50_ms: 900,
      p95_ms: 900,
      lock_hold_ms: 20,
    },
  },
  ceilings: {
    list_surfaces: { p50_ms: 280, p95_ms: 336 },
    read_screen: { p50_ms: 250, p95_ms: 448 },
    first_send_after_spawn: {
      p50_ms: 2_000,
      p95_ms: 2_000,
      lock_hold_ms: 100,
    },
    cli_send_ms: 4_000,
  },
};

const result = {
  verdict: "GREEN",
  clients: 8,
  rounds: 12,
  replay: baseline.replay,
  latency: {
    daemon_path: {
      list_surfaces: { p50_ms: 110, p95_ms: 130, p99_ms: 140 },
      read_screen: { p50_ms: 150, p95_ms: 170, p99_ms: 180 },
    },
    first_send_after_spawn: {
      first: {
        elapsed_ms: 950,
        request_bytes: 240,
        receipt: { timings_ms: { lock: 21 } },
      },
    },
  },
};

describe("daemon performance budget", () => {
  it("requires the committed replay, byte, percentile, lock, and hard-ceiling fields", () => {
    expect(() => validateBaseline(baseline)).not.toThrow();
    expect(() =>
      validateBaseline({
        ...baseline,
        replay: { ...baseline.replay, bytes: undefined },
      }),
    ).toThrow(/bytes/);
    expect(() =>
      validateBaseline({
        ...baseline,
        measurements: {
          ...baseline.measurements,
          first_send_after_spawn: { p50_ms: 900, p95_ms: 900 },
        },
      }),
    ).toThrow(/lock_hold_ms/);
    expect(() =>
      validateBaseline({
        ...baseline,
        ceilings: {
          ...baseline.ceilings,
          first_send_after_spawn: {
            ...baseline.ceilings.first_send_after_spawn,
            p50_ms: 2_001,
          },
        },
      }),
    ).toThrow(/2,000/);
  });

  it("fails closed when a measured operation exceeds its ceiling", () => {
    const comparison = compareBenchmark(baseline, {
      ...result,
      latency: {
        ...result.latency,
        daemon_path: {
          ...result.latency.daemon_path,
          read_screen: {
            ...result.latency.daemon_path.read_screen,
            p50_ms: 251,
          },
        },
      },
    });

    expect(comparison.passed).toBe(false);
    expect(comparison.failures).toContain(
      "read_screen p50: 251ms exceeds 250ms",
    );
  });

  it("renders one before/after table with the stable bot marker", () => {
    const markdown = renderMarkdownComparison(
      baseline,
      result,
      compareBenchmark(baseline, result),
    );

    expect(markdown).toContain("<!-- cmuxlayer-perf-budget -->");
    expect(markdown).toContain(
      "| Operation | Metric | Baseline | Current | Ceiling | Status |",
    );
    expect(markdown).toContain("first_send_after_spawn");
    expect(markdown).toContain("Runner margin: 2.8x");
  });

  it("commits a post-run-5 baseline with the full replay contract", () => {
    const committed = JSON.parse(
      readFileSync(
        join(repoRoot, "benchmarks", "daemon-baseline.json"),
        "utf8",
      ),
    );

    expect(() => validateBaseline(committed)).not.toThrow();
    expect(committed.source.git_sha).toMatch(/^f0ca937/);
    expect(committed.replay).toMatchObject({ clients: 8, rounds: 12 });
    expect(committed.replay.operations).toEqual([
      "list_surfaces",
      "read_screen",
      "first_send_after_spawn",
    ]);
  });

  it("instruments the existing replay without changing its 8x12 defaults", () => {
    const source = readFileSync(
      join(repoRoot, "scripts", "bench-daemon.mjs"),
      "utf8",
    );

    expect(source).toContain("const DEFAULT_CLIENTS = 8");
    expect(source).toContain("const DEFAULT_ROUNDS = 12");
    expect(source).toContain("p95_ms");
    expect(source).toContain("request_bytes");
    expect(source).toContain("lock_hold_ms");
    expect(source).toContain("CMUXLAYER_BENCH_JSON_PATH");
  });

  it("wires a required PR/main job and edits a single comment even on RED", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("perf-budget:");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("bun run bench:daemon:check");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain(
      "if: always() && github.event_name == 'pull_request'",
    );
    expect(workflow).toContain("<!-- cmuxlayer-perf-budget -->");
    expect(workflow).toContain("updateComment");
    expect(workflow).toContain("createComment");
  });

  it("keeps scratch artifacts out of default Vitest collection", () => {
    const config = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    expect(config).toContain('"**/docs.local/scratch/**"');
  });
});
