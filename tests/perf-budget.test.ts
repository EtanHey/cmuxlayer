import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineContentSha256,
  compareBenchmark,
  maximumBenchmarkMeasurements,
  performanceCeiling,
  renderMarkdownComparison,
  runBenchmark,
  validateBaseline,
} from "../scripts/check-daemon-benchmark.mjs";

const repoRoot = join(__dirname, "..");

function attest<T extends Record<string, unknown>>(content: T) {
  const baseline = {
    ...content,
    refresh_attestation: { algorithm: "sha256", content_sha256: "" },
  };
  baseline.refresh_attestation.content_sha256 = baselineContentSha256(baseline);
  return baseline;
}

const baseline = attest({
  schema_version: 2,
  source: {
    git_sha: "f0ca937ccf16d81b0383a88de79d70b3a10d672e",
    measured_at: "2026-08-26T00:00:00Z",
    runner_class: "github-actions-ubuntu-latest",
    workflow_run_id: 123456,
  },
  regression_ratio: 1.25,
  sanity_caps_ms: {
    all_rows: 1_000,
    cli_send: 1_000,
  },
  replay: {
    clients: 8,
    rounds: 12,
    operations: [
      "list_surfaces",
      "read_screen",
      "send_to_surface_warm",
      "send_to_agent_warm",
      "list_agents",
      "control_health",
      "spawn_close_during_sweep",
      "first_send_after_spawn",
    ],
    bytes: {
      list_surfaces: 140,
      read_screen: 170,
      send_to_surface_warm: 180,
      send_to_agent_warm: 181,
      list_agents: 182,
      control_health: 183,
      spawn_close_during_sweep: 184,
      first_send_after_spawn: 240,
    },
    request_sha256: {
      list_surfaces: "1".repeat(64),
      read_screen: "2".repeat(64),
      send_to_surface_warm: "4".repeat(64),
      send_to_agent_warm: "5".repeat(64),
      list_agents: "6".repeat(64),
      control_health: "7".repeat(64),
      spawn_close_during_sweep: "8".repeat(64),
      first_send_after_spawn: "3".repeat(64),
    },
    transport: {
      list_surfaces: "socket",
      read_screen: "socket",
      send_to_surface_warm: "socket",
      send_to_agent_warm: "socket",
      list_agents: "socket",
      control_health: "socket",
      spawn_close_during_sweep: "socket",
      first_send_after_spawn: "socket",
    },
  },
  measurements: {
    list_surfaces: { p50_ms: 100, p95_ms: 120, lock_hold_ms: 0 },
    read_screen: { p50_ms: 140, p95_ms: 160, lock_hold_ms: 0 },
    send_to_surface_warm: { p50_ms: 200, p95_ms: 220, lock_hold_ms: 20 },
    send_to_agent_warm: { p50_ms: 210, p95_ms: 230, lock_hold_ms: 21 },
    list_agents: { p50_ms: 110, p95_ms: 130, lock_hold_ms: 0 },
    control_health: { p50_ms: 90, p95_ms: 100, lock_hold_ms: 0 },
    spawn_close_during_sweep: { p50_ms: 300, p95_ms: 320, lock_hold_ms: 30 },
    first_send_after_spawn: {
      p50_ms: 900,
      p95_ms: 900,
      lock_hold_ms: 20,
    },
    cli_send_ms: 700,
  },
});

const result = {
  verdict: "GREEN",
  clients: 8,
  rounds: 12,
  replay: baseline.replay,
  latency: {
    daemon_path: {
      list_surfaces: {
        p50_ms: 110,
        p95_ms: 130,
        p99_ms: 140,
        transport: "socket",
      },
      read_screen: {
        p50_ms: 150,
        p95_ms: 170,
        p99_ms: 180,
        transport: "socket",
      },
      list_agents: {
        p50_ms: 120,
        p95_ms: 140,
        lock_hold_ms: 0,
        transport: "socket",
      },
      control_health: {
        p50_ms: 95,
        p95_ms: 105,
        lock_hold_ms: 0,
        transport: "socket",
      },
    },
    first_send_after_spawn: {
      first: {
        elapsed_ms: 950,
        request_bytes: 240,
        lock_hold_ms: 21,
        transport: "socket",
        receipt: {
          timings_ms: { lock: 4, lock_hold: 21 },
          transport: "socket",
        },
      },
      surface: { elapsed_ms: 710, transport: "socket" },
    },
    send_to_surface_warm: {
      p50_ms: 210,
      p95_ms: 230,
      lock_hold_ms: 21,
      transport: "socket",
    },
    send_to_agent_warm: {
      p50_ms: 220,
      p95_ms: 240,
      lock_hold_ms: 22,
      transport: "socket",
    },
    spawn_close_during_sweep: {
      p50_ms: 310,
      p95_ms: 330,
      lock_hold_ms: 31,
      transport: "socket",
    },
  },
};

describe("daemon performance budget", () => {
  it("requires a CI-runner source, canonical requests, and the 1.25 ratio", () => {
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
      validateBaseline({ ...baseline, regression_ratio: 1.24 }),
    ).toThrow(/1.25/);
    expect(() =>
      validateBaseline({
        ...baseline,
        source: { ...baseline.source, runner_class: "local-macos" },
      }),
    ).toThrow(/runner_class/);
    expect(() =>
      validateBaseline({
        ...baseline,
        replay: { ...baseline.replay, request_sha256: undefined },
      }),
    ).toThrow(/request_sha256/);
    expect(() =>
      validateBaseline({
        ...baseline,
        replay: { ...baseline.replay, rounds: 3 },
      }),
    ).toThrow(/canonical 8x12 replay/);
  });

  it("fails the consistency assertion after a baseline-only hand edit", () => {
    expect(() =>
      validateBaseline({
        ...baseline,
        measurements: {
          ...baseline.measurements,
          list_surfaces: {
            ...baseline.measurements.list_surfaces,
            p50_ms: 1,
          },
        },
      }),
    ).toThrow(/consistency assertion failed/);
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
            p50_ms: 441,
          },
        },
      },
    });

    expect(comparison.passed).toBe(false);
    expect(comparison.failures).toContain(
      "read_screen p50: 441ms exceeds 440ms",
    );
  });

  it("fails the benchmark when any measured operation used the CLI fallback", () => {
    const fallback = compareBenchmark(baseline, {
      ...result,
      latency: {
        ...result.latency,
        send_to_agent_warm: {
          ...result.latency.send_to_agent_warm,
          transport: "cli",
        },
      },
    });

    expect(fallback.passed).toBe(false);
    expect(fallback.failures).toContain(
      "send_to_agent_warm transport: cli; cli fallback active",
    );
    expect(renderMarkdownComparison(baseline, result, fallback)).toContain(
      "| Operation | Transport | Metric |",
    );
  });

  it("builds a CI refresh baseline from the per-metric maximum of its samples", () => {
    const slower = {
      ...result,
      latency: {
        ...result.latency,
        daemon_path: {
          ...result.latency.daemon_path,
          list_surfaces: { p50_ms: 90, p95_ms: 200 },
          read_screen: { p50_ms: 190, p95_ms: 140 },
        },
        first_send_after_spawn: {
          first: { elapsed_ms: 1_100, lock_hold_ms: 18 },
          surface: { elapsed_ms: 900 },
        },
      },
    };

    expect(maximumBenchmarkMeasurements([result, slower])).toEqual({
      list_surfaces: { p50_ms: 110, p95_ms: 200, lock_hold_ms: 0 },
      read_screen: { p50_ms: 190, p95_ms: 170, lock_hold_ms: 0 },
      send_to_surface_warm: {
        p50_ms: 210,
        p95_ms: 230,
        lock_hold_ms: 21,
      },
      send_to_agent_warm: {
        p50_ms: 220,
        p95_ms: 240,
        lock_hold_ms: 22,
      },
      list_agents: { p50_ms: 120, p95_ms: 140, lock_hold_ms: 0 },
      control_health: { p50_ms: 95, p95_ms: 105, lock_hold_ms: 0 },
      spawn_close_during_sweep: {
        p50_ms: 310,
        p95_ms: 330,
        lock_hold_ms: 31,
      },
      first_send_after_spawn: {
        p50_ms: 1_100,
        p95_ms: 1_100,
        lock_hold_ms: 21,
      },
      cli_send_ms: 900,
    });
    expect(() =>
      maximumBenchmarkMeasurements([
        {
          ...result,
          latency: {
            ...result.latency,
            first_send_after_spawn: {
              ...result.latency.first_send_after_spawn,
              first: {
                ...result.latency.first_send_after_spawn.first,
                lock_hold_ms: null,
                receipt: { timings_ms: { lock_hold: null } },
              },
            },
          },
        },
      ]),
    ).toThrow(/measurements must be finite/);
  });

  it("derives every runner ceiling from the committed CI measurement at 1.25x", () => {
    const comparison = compareBenchmark(baseline, {
      ...result,
      latency: {
        ...result.latency,
        first_send_after_spawn: {
          ...result.latency.first_send_after_spawn,
          first: {
            ...result.latency.first_send_after_spawn.first,
            elapsed_ms: 1_126,
          },
        },
      },
    });
    expect(comparison.failures).toContain(
      "first_send_after_spawn p50: 1126ms exceeds 1000ms",
    );
    expect(
      comparison.rows.find(
        (entry) =>
          entry.operation === "first_send_after_spawn" &&
          entry.metric === "p50_ms",
      )?.ceiling,
    ).toBe(1_000);
  });

  it("tightens the enforced ceiling when a committed measurement is lowered", () => {
    const loweredBaseline = attest({
      ...baseline,
      measurements: {
        ...baseline.measurements,
        list_surfaces: {
          ...baseline.measurements.list_surfaces,
          p50_ms: 1,
        },
      },
    });
    const comparison = compareBenchmark(loweredBaseline, {
      ...result,
      latency: {
        ...result.latency,
        daemon_path: {
          ...result.latency.daemon_path,
          list_surfaces: {
            ...result.latency.daemon_path.list_surfaces,
            p50_ms: 302,
          },
        },
      },
    });

    expect(
      comparison.rows.find(
        (entry) =>
          entry.operation === "list_surfaces" && entry.metric === "p50_ms",
      )?.ceiling,
    ).toBe(301);
    expect(comparison.failures).toContain(
      "list_surfaces p50: 302ms exceeds 301ms",
    );
  });

  it("fails closed on CLI send, replay-shape, and request-byte drift", () => {
    const cli = compareBenchmark(baseline, {
      ...result,
      latency: {
        ...result.latency,
        first_send_after_spawn: {
          ...result.latency.first_send_after_spawn,
          surface: { elapsed_ms: 1_001 },
        },
      },
    });
    expect(cli.failures).toContain(
      "first_send_after_spawn cli_send: 1001ms exceeds 1000ms",
    );

    const replay = compareBenchmark(baseline, {
      ...result,
      clients: 7,
      replay: {
        ...result.replay,
        clients: 7,
        operations: ["list_surfaces", "first_send_after_spawn"],
        bytes: { ...result.replay.bytes, read_screen: 999 },
      },
    });
    expect(replay.failures).toEqual(
      expect.arrayContaining([
        "replay clients: 7 does not match committed 8",
        "replay operations do not match the committed workload",
        "read_screen request_bytes: 999 bytes does not match committed 170 bytes",
      ]),
    );
  });

  it("fails when canonical request identity drifts at the same byte length", () => {
    const comparison = compareBenchmark(baseline, {
      ...result,
      replay: {
        ...result.replay,
        request_sha256: {
          ...result.replay.request_sha256,
          read_screen: "9".repeat(64),
        },
      },
    });
    expect(comparison.failures).toContain(
      "read_screen request_sha256 does not match the committed workload",
    );
  });

  it("cannot reuse a stale result when the benchmark process fails", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "cmuxlayer-stale-bench-"));
    writeFileSync(join(artifactDir, "result.json"), JSON.stringify(result));
    try {
      await expect(
        runBenchmark({
          artifactDir,
          benchmarkScript: join(repoRoot, "missing-benchmark-script.mjs"),
        }),
      ).rejects.toThrow(/did not write valid JSON/);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("rejects output that was not attested by this benchmark invocation", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "cmuxlayer-wrong-run-"));
    const benchmarkScript = join(artifactDir, "wrong-run.mjs");
    writeFileSync(
      benchmarkScript,
      `import { writeFile } from "node:fs/promises";\nawait writeFile(process.env.CMUXLAYER_BENCH_JSON_PATH, JSON.stringify({ verdict: "GREEN", invocation_nonce: "old-run" }));\n`,
    );
    try {
      await expect(
        runBenchmark({ artifactDir, benchmarkScript }),
      ).rejects.toThrow(/this-invocation attestation/);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("allows the explicit fast-round override but no implicit round drift", () => {
    const fast = {
      ...result,
      rounds: 3,
      replay: { ...result.replay, rounds: 3 },
    };
    expect(compareBenchmark(baseline, fast).failures).toContain(
      "replay rounds: 3 does not match expected 12",
    );
    expect(compareBenchmark(baseline, fast, { expectedRounds: 3 }).passed).toBe(
      true,
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
      "| Operation | Transport | Metric | Baseline | Current | Ceiling | Status |",
    );
    expect(markdown).toContain("first_send_after_spawn");
    expect(markdown).toContain("Runner regression ratio: 1.25x");
  });

  it("commits a post-run-5 baseline with the full replay contract", () => {
    const committed = JSON.parse(
      readFileSync(
        join(repoRoot, "benchmarks", "daemon-baseline.json"),
        "utf8",
      ),
    );

    expect(() => validateBaseline(committed)).not.toThrow();
    expect(committed.source.git_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.replay).toMatchObject({ clients: 8, rounds: 12 });
    expect(committed.replay.operations).toEqual([
      "list_surfaces",
      "read_screen",
      "send_to_surface_warm",
      "send_to_agent_warm",
      "list_agents",
      "control_health",
      "spawn_close_during_sweep",
      "first_send_after_spawn",
    ]);
    expect(committed.source.runner_class).toBe("github-actions-ubuntu-latest");
    expect(committed.source.workflow_run_id).toBe(32928658291);
    expect(committed).not.toHaveProperty("ceilings");
    expect(committed.refresh_attestation.content_sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
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
    expect(source).toContain("timings_ms?.lock_hold");
    expect(source).toContain("CMUXLAYER_BENCH_JSON_PATH");
  });

  it("wires a required PR/main job and edits a single comment even on RED", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("perf-budget:");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("perf-baseline-refresh:");
    expect(workflow).toContain("baseline_source_run_id:");
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$source_sha" HEAD',
    );
    expect(workflow).toContain("unexpected_changes=");
    expect(workflow).toContain(
      "check-daemon-benchmark|refresh-daemon-baseline",
    );
    expect(workflow).toContain("gh run download");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("bun run bench:daemon:check");
    expect(workflow).toContain(
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain("comment.user?.login === 'github-actions[bot]'");
    expect(workflow).toContain("context.payload.pull_request.head.sha");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("<!-- cmuxlayer-perf-budget -->");
    expect(workflow).toContain("updateComment");
    expect(workflow).toContain("createComment");
  });

  it("refuses to refresh a baseline from an over-budget lock hold", () => {
    const source = readFileSync(
      join(repoRoot, "scripts", "refresh-daemon-baseline.mjs"),
      "utf8",
    );
    expect(source).toContain(
      "refusing to refresh from an over-budget lock hold",
    );
    expect(source).toContain('CMUXLAYER_BENCH_ROUNDS: "12"');
    expect(source).toContain("canonical 8x12 replay");
    expect(source).toContain("GITHUB_RUN_ID");
    expect(source).toContain('GITHUB_ACTIONS !== "true"');
    expect(source).toContain("compareBenchmark(existing, sample)");
    expect(source).toContain("replay?.bytes?.[operation]");
    expect(source).toContain(
      "refusing to raise a committed performance baseline",
    );
    expect(source).toContain("CMUXLAYER_BENCH_IMPORT_RESULT_PATH");
    expect(source).toContain("runnerRebase");
    expect(source).toContain("runnerRebase ? Math.max : Math.min");
  });

  it("keeps scratch artifacts out of default Vitest collection", () => {
    const config = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    expect(config).toContain('"**/docs.local/scratch/**"');
  });
});
