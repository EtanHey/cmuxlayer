import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import * as checkerModule from "../scripts/check-daemon-benchmark.mjs";
import {
  baselineContentSha256,
  compareBenchmark,
  maximumBenchmarkMeasurements,
  performanceCeiling,
  requireCanonicalRequestChangeReason,
  requireBaselineIncreaseReason,
  renderMarkdownComparison,
  resultWithComparison,
  runBenchmark,
  validateBaseline,
} from "../scripts/check-daemon-benchmark.mjs";

const repoRoot = join(__dirname, "..");
const p6Hosted = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/p6-hosted-first-send.json"), "utf8"));
const hostedBaseline = JSON.parse(readFileSync(join(repoRoot, "benchmarks/daemon-baseline.json"), "utf8"));

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
      "send_to_surface_10_parallel",
      "read_screen_10_parallel",
    ],
    row_metadata: {
      list_surfaces: { sampling: "sampled", samples_per_run: 96 },
      read_screen: { sampling: "sampled", samples_per_run: 96 },
      send_to_surface_warm: { sampling: "sampled", samples_per_run: 96 },
      send_to_agent_warm: { sampling: "sampled", samples_per_run: 192 },
      list_agents: { sampling: "sampled", samples_per_run: 192 },
      control_health: { sampling: "sampled", samples_per_run: 96 },
      spawn_close_during_sweep: { sampling: "sampled", samples_per_run: 96 },
      first_send_after_spawn: { sampling: "sampled", samples_per_run: 96 },
      send_to_surface_10_parallel: {
        sampling: "sampled",
        samples_per_run: 12,
        stress: true,
      },
      read_screen_10_parallel: {
        sampling: "sampled",
        samples_per_run: 12,
        stress: true,
      },
    },
    bytes: {
      list_surfaces: 140,
      read_screen: 170,
      send_to_surface_warm: 180,
      send_to_agent_warm: 181,
      list_agents: 182,
      control_health: 183,
      spawn_close_during_sweep: 184,
      first_send_after_spawn: 240,
      send_to_surface_10_parallel: 2_000,
      read_screen_10_parallel: 1_700,
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
      send_to_surface_10_parallel: "a".repeat(64),
      read_screen_10_parallel: "b".repeat(64),
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
      send_to_surface_10_parallel: "socket",
      read_screen_10_parallel: "socket",
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
    send_to_surface_10_parallel: {
      p50_ms: 260,
      p95_ms: 310,
      lock_hold_ms: 120,
    },
    read_screen_10_parallel: {
      p50_ms: 180,
      p95_ms: 240,
      lock_hold_ms: 0,
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
      send_to_surface_10_parallel: {
        p50_ms: 270,
        p95_ms: 320,
        lock_hold_ms: 125,
        transport: "socket",
      },
      read_screen_10_parallel: {
        p50_ms: 190,
        p95_ms: 250,
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

/**
 * The warm-agent tail row samples 192 per run (#791). A hosted 96-sample warm
 * artifact becomes one 192-sample run by replaying it as a second, later pass:
 * same elapsed values (so p50/p95 are unchanged), indices 96-191, and every
 * timestamp shifted past the first pass.
 */
type WarmPass = { paired_control: { samples: Array<Record<string, number | string>> } };

/** Append `second` after `first` as one run: later indices, timestamps shifted past `first`. */
function concatWarmPasses<T extends WarmPass>(first: T, second: WarmPass): T {
  const head = first.paired_control.samples;
  const tail = second.paired_control.samples;
  const span = Math.max(...head.map((sample) => Number(sample.send_completed_at_ms))) -
    Math.min(...tail.map((sample) => Number(sample.send_started_at_ms))) + 1_000;
  const shifted = tail.map((sample, index) => {
    const next: Record<string, number | string> = { ...sample, sample_index: head.length + index };
    for (const key of Object.keys(sample)) {
      if (key.endsWith("_at_ms")) next[key] = Number(sample[key]) + span;
    }
    return next;
  });
  return { ...first, paired_control: { ...first.paired_control, samples: [...head, ...shifted] } };
}

function asTwoPassWarmRun<T extends WarmPass>(warm: T): T {
  return concatWarmPasses(warm, warm);
}

function withRawPercentiles<T extends WarmPass>(warm: T): T & { p50_ms: number; p95_ms: number } {
  const elapsed = warm.paired_control.samples
    .map((sample) => Number(sample.send_elapsed_ms))
    .sort((a, b) => a - b);
  const at = (pct: number) => Math.round(elapsed[Math.ceil(elapsed.length * pct) - 1] * 100) / 100;
  return { ...warm, p50_ms: at(0.5), p95_ms: at(0.95) };
}

describe("daemon performance budget", () => {
  it("requires an explicit reason for any committed-row increase", () => {
    expect(() => requireBaselineIncreaseReason([[101, 100]], "")).toThrow(
      /without --reason/,
    );
    expect(requireBaselineIncreaseReason([[101, 100]], "runner migration")).toBe(
      true,
    );
    expect(requireBaselineIncreaseReason([[99, 100]], "")).toBe(false);
  });

  it("requires an explicit reason for an imported canonical-request change", () => {
    expect(() => requireCanonicalRequestChangeReason(true, "")).toThrow(
      /canonical request change without --reason/,
    );
    expect(
      requireCanonicalRequestChangeReason(true, "verify parallel read identity"),
    ).toBe(true);
    expect(requireCanonicalRequestChangeReason(false, "")).toBe(false);
  });

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
    expect(() =>
      validateBaseline(
        attest({
          ...baseline,
          replay: { ...baseline.replay, row_metadata: undefined },
        }),
      ),
    ).toThrow(/row_metadata/);
    expect(() =>
      validateBaseline(
        attest({
          ...baseline,
          measurements: {
            ...baseline.measurements,
            list_surfaces: {
              ...baseline.measurements.list_surfaces,
              p95_ms: 1_001,
            },
          },
        }),
      ),
    ).toThrow(/sanity cap/);
  });

  it("uses measured spread and five-run p50 variance only for earned sampled rows", () => {
    const history = [90, 95, 100, 105, 110].map((p50_ms, index) => ({
      source: { git_sha: String(index).padStart(40, "0"), workflow_run_id: index + 1 },
      measurements: {
        list_surfaces: { p50_ms, p95_ms: p50_ms + 20, lock_hold_ms: 0 },
      },
    }));
    const comparison = compareBenchmark(baseline, result, { history });
    const row = comparison.rows.find(
      (entry) => entry.operation === "list_surfaces" && entry.metric === "p50_ms",
    );
    expect(row).toMatchObject({
      sampling: "sampled",
      margin_ms: 40,
      margin_rule: "measured (5 runs)",
      ceiling: 140,
    });

    const highVarianceHistory = [50, 75, 100, 125, 150].map((p50_ms, index) => ({
      source: { git_sha: `f${String(index).padStart(39, "0")}`, workflow_run_id: 100 + index },
      measurements: {
        list_surfaces: { p50_ms, p95_ms: p50_ms + 20, lock_hold_ms: 0 },
      },
    }));
    const highVariance = compareBenchmark(baseline, result, {
      history: highVarianceHistory,
    }).rows.find(
      (entry) => entry.operation === "list_surfaces" && entry.metric === "p50_ms",
    );
    expect(highVariance?.margin_ms).toBeCloseTo(106.07, 2);
    expect(highVariance?.ceiling).toBeCloseTo(206.07, 2);
    expect(
      compareBenchmark(baseline, result, { history: history.slice(0, 3) }).rows.find(
        (entry) =>
          entry.operation === "list_surfaces" && entry.metric === "p50_ms",
      )?.margin_rule,
    ).toBe("measured (1 run)");
  });

  it("excuses only send latency matched by a simultaneous socket control stall", () => {
    // first_send_after_spawn samples 96 per run; the send_to_agent_warm tail row
    // samples 192 (#791), so its slow block is 12 samples to stay above p95.
    const pairedSamples = (
      fastSend: number,
      slowSend: number,
      slowControl: number,
      length = 96,
      fastCount = 90,
    ) =>
      Array.from({ length }, (_, sample_index) => {
        const send_elapsed_ms = sample_index < fastCount ? fastSend : slowSend;
        const control_timer_overrun_ms = sample_index < fastCount ? 1 : slowControl;
        const send_started_at_ms = sample_index * 2_000;
        const send_completed_at_ms = send_started_at_ms + send_elapsed_ms;
        const control_timer_started_at_ms = send_started_at_ms;
        const control_timer_due_at_ms = control_timer_started_at_ms + 1;
        const control_timer_fired_at_ms = control_timer_due_at_ms + control_timer_overrun_ms;
        return {
          sample_index,
          send_elapsed_ms,
          send_started_at_ms,
          send_completed_at_ms,
          control_elapsed_ms: Math.max(0,
            Math.min(control_timer_fired_at_ms, send_completed_at_ms) -
            Math.max(control_timer_due_at_ms, send_started_at_ms)),
          control_timer_started_at_ms,
          control_timer_due_at_ms,
          control_timer_fired_at_ms,
          control_timer_overrun_ms,
          control_hold_ms: 1,
          control_transport: "socket",
        };
      });
    const warmSamples = (fastSend: number, slowSend: number, slowControl: number) =>
      pairedSamples(fastSend, slowSend, slowControl, 192, 180);
    const candidate = {
      ...result,
      latency: {
        ...result.latency,
        first_send_after_spawn: {
          ...result.latency.first_send_after_spawn,
          sampled: {
            p50_ms: 900,
            p95_ms: 1_100,
            lock_hold_ms: 20,
            transport: "socket",
            paired_control: {
              kind: "fake_socket_timed_ping",
              samples: pairedSamples(900, 1_100, 201),
            },
          },
        },
        send_to_agent_warm: {
          ...result.latency.send_to_agent_warm,
          p50_ms: 240,
          p95_ms: 340,
          paired_control: {
            kind: "fake_socket_timed_ping",
            samples: warmSamples(240, 340, 101),
          },
        },
      },
    };
    const matched = compareBenchmark(baseline, candidate);
    const first = matched.rows.find((entry) =>
      entry.operation === "first_send_after_spawn" && entry.metric === "p95_ms",
    );
    const warm = matched.rows.find((entry) =>
      entry.operation === "send_to_agent_warm" && entry.metric === "p95_ms",
    );
    expect(first).toMatchObject({ current: 900, raw_current: 1_100, passed: true });
    expect(warm).toMatchObject({ current: 240, raw_current: 340, passed: true });

    const sendOnly = {
      ...candidate,
      latency: {
        ...candidate.latency,
        first_send_after_spawn: {
          ...candidate.latency.first_send_after_spawn,
          sampled: {
            ...candidate.latency.first_send_after_spawn.sampled,
            paired_control: {
              kind: "fake_socket_timed_ping",
              samples: pairedSamples(900, 1_100, 1),
            },
          },
        },
        send_to_agent_warm: {
          ...candidate.latency.send_to_agent_warm,
          paired_control: {
            kind: "fake_socket_timed_ping",
            samples: warmSamples(240, 340, 1),
          },
        },
      },
    };
    const unpaired = compareBenchmark(baseline, sendOnly);
    expect(unpaired.rows.find((entry) =>
      entry.operation === "first_send_after_spawn" && entry.metric === "p95_ms",
    )).toMatchObject({ current: 1_100, passed: false });
    expect(unpaired.rows.find((entry) =>
      entry.operation === "send_to_agent_warm" && entry.metric === "p95_ms",
    )).toMatchObject({ current: 340, passed: false });
    const malformed = {
      ...candidate,
      latency: {
        ...candidate.latency,
        send_to_agent_warm: {
          ...candidate.latency.send_to_agent_warm,
          paired_control: {
            kind: "fake_socket_timed_ping",
            samples: warmSamples(240, 340, 101).slice(1),
          },
        },
      },
    };
    const malformedComparison = compareBenchmark(baseline, malformed);
    expect(malformedComparison.rows.find((entry) =>
      entry.operation === "send_to_agent_warm" && entry.metric === "p95_ms",
    )).toMatchObject({ current: 340, passed: false });
    expect(malformedComparison.paired_control_evaluation.send_to_agent_warm).toMatchObject({
      verdict_basis: "raw", valid_pairs: 0, invalid_pairs: 192,
      invalid_reasons: { sample_count_mismatch: 192 },
    });

    // A timer delayed only after send completion is not simultaneous proof.
    const postSend = warmSamples(240, 340, 101).map((sample) =>
      sample.sample_index < 180 ? sample : {
        ...sample,
        control_timer_started_at_ms: sample.send_completed_at_ms + 1,
        control_timer_due_at_ms: sample.send_completed_at_ms + 2,
        control_timer_fired_at_ms: sample.send_completed_at_ms + 103,
        control_elapsed_ms: 0,
      });
    const postSendCandidate = {
      ...candidate,
      latency: {
        ...candidate.latency,
        send_to_agent_warm: {
          ...candidate.latency.send_to_agent_warm,
          paired_control: { kind: "fake_socket_timed_ping", samples: postSend },
        },
      },
    };
    expect(compareBenchmark(baseline, postSendCandidate).rows.find((entry) =>
      entry.operation === "send_to_agent_warm" && entry.metric === "p95_ms",
    )).toMatchObject({ current: 340, passed: false });

    // Receipt fields must prove the timer interval, not just claim an overlap.
    const forged = warmSamples(240, 340, 101).map((sample) =>
      sample.sample_index < 180 ? sample : {
        ...sample,
        control_timer_overrun_ms: 1,
      });
    const forgedCandidate = {
      ...candidate,
      latency: {
        ...candidate.latency,
        send_to_agent_warm: {
          ...candidate.latency.send_to_agent_warm,
          paired_control: { kind: "fake_socket_timed_ping", samples: forged },
        },
      },
    };
    expect(compareBenchmark(baseline, forgedCandidate).rows.find((entry) =>
      entry.operation === "send_to_agent_warm" && entry.metric === "p95_ms",
    )).toMatchObject({ current: 340, passed: false });

    const oneForged = warmSamples(240, 340, 101);
    oneForged[191] = { ...oneForged[191], control_timer_overrun_ms: 1 };
    const partlyInvalid = compareBenchmark(baseline, {
      ...candidate,
      latency: {
        ...candidate.latency,
        send_to_agent_warm: {
          ...candidate.latency.send_to_agent_warm,
          paired_control: { kind: "fake_socket_timed_ping", samples: oneForged },
        },
      },
    });
    expect(partlyInvalid.rows.find((entry) =>
      entry.operation === "send_to_agent_warm" && entry.metric === "p95_ms",
    )).toMatchObject({ current: 240, raw_current: 340, passed: true });
    expect(partlyInvalid.paired_control_evaluation.send_to_agent_warm).toMatchObject({
      verdict_basis: "adjusted", valid_pairs: 191, invalid_pairs: 1,
      invalid_reasons: { timer_overrun_inconsistent: 1 },
    });

    const broadRegression = {
      ...candidate,
      latency: {
        ...candidate.latency,
        send_to_agent_warm: {
          ...candidate.latency.send_to_agent_warm,
          p50_ms: 340,
          paired_control: {
            kind: "fake_socket_timed_ping",
            samples: warmSamples(340, 340, 101),
          },
        },
      },
    };
    expect(compareBenchmark(baseline, broadRegression).rows.find((entry) =>
      entry.operation === "send_to_agent_warm" && entry.metric === "p95_ms",
    )).toMatchObject({ current: 340, passed: false });
  });

  it("separates the cold round in three complete hosted artifacts and fails closed on the older fourth", () => {
    for (const [name, expectedSteady, expectedCold] of [
      ["fail_747", true, 142.84], ["pass_c7f", true, 115.07], ["pass_ab3", true, 71.33],
    ] as const) {
      const hosted = p6Hosted[name];
      expect(hosted.source_result_sha256).toMatch(/^[0-9a-f]{64}$/);
      const candidate = { ...result, latency: { ...result.latency,
        first_send_after_spawn: { ...result.latency.first_send_after_spawn, sampled: hosted.sampled } } };
      const comparison = compareBenchmark(hostedBaseline, candidate);
      const steady = comparison.rows.find((entry) =>
        entry.operation === "first_send_after_spawn" && entry.metric === "p95_ms");
      const cold = comparison.rows.find((entry) =>
        entry.operation === "first_send_after_spawn_cold" && entry.metric === "p95_ms");
      expect(steady).toMatchObject({ passed: expectedSteady, ceiling: 110.75,
        sample_count: 88 });
      expect(cold).toMatchObject({ current: expectedCold, sample_count: 8,
        informational: true, ceiling: 150 });
      const artifact = resultWithComparison(candidate, comparison);
      expect(artifact.perf_budget.first_send_rounds).toMatchObject({
        cold_samples: 8, steady_samples: 88, excluded_rounds: [0],
      });
      expect(artifact.perf_budget.rows).toContainEqual(expect.objectContaining({
        operation: "first_send_after_spawn_cold", metric: "p95_ms",
        informational: true,
      }));
      expect(renderMarkdownComparison(hostedBaseline, candidate, comparison))
        .toContain("first_send_after_spawn_cold");
    }
    const legacy = { ...result, latency: { ...result.latency,
      first_send_after_spawn: { ...result.latency.first_send_after_spawn,
        sampled: p6Hosted.fail_main.sampled } } };
    const comparison = compareBenchmark(hostedBaseline, legacy);
    expect(comparison.rows.find((entry) => entry.operation === "first_send_after_spawn" &&
      entry.metric === "p95_ms")).toMatchObject({ current: 122.97, passed: false });
    expect(comparison.rows.some((entry) => entry.operation === "first_send_after_spawn_cold"))
      .toBe(false);
  });

  it("keeps the full-row failure when every hosted paired timer receipt is missing", () => {
    const hosted = structuredClone(p6Hosted.fail_747.sampled);
    hosted.paired_control.samples = hosted.paired_control.samples.map((sample) => ({
      sample_index: sample.sample_index,
      send_elapsed_ms: sample.send_elapsed_ms,
    }));
    const candidate = { ...result, latency: { ...result.latency,
      first_send_after_spawn: { ...result.latency.first_send_after_spawn, sampled: hosted } } };
    const comparison = compareBenchmark(hostedBaseline, candidate);
    expect(comparison.first_send_rounds).toBeNull();
    expect(comparison.rows.find((entry) => entry.operation === "first_send_after_spawn" &&
      entry.metric === "p95_ms")).toMatchObject({ current: 122.32, passed: false });
  });

  it("keeps a steady round regression blocking even when round zero is excluded", () => {
    const hosted = structuredClone(p6Hosted.fail_747.sampled);
    const samples = hosted.paired_control.samples;
    for (const sample of samples.slice(40, 48)) {
      sample.send_elapsed_ms += 100;
      sample.send_completed_at_ms += 100;
    }
    const nearest = (values: number[], percentile: number) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * percentile / 100) - 1];
    const elapsed = samples.map((sample) => sample.send_elapsed_ms);
    hosted.p50_ms = Math.round(nearest(elapsed, 50) * 100) / 100;
    hosted.p95_ms = Math.round(nearest(elapsed, 95) * 100) / 100;
    const candidate = { ...result, latency: { ...result.latency,
      first_send_after_spawn: { ...result.latency.first_send_after_spawn, sampled: hosted } } };
    const comparison = compareBenchmark(hostedBaseline, candidate);
    expect(comparison.rows.find((entry) => entry.operation === "first_send_after_spawn" &&
      entry.metric === "p95_ms")).toMatchObject({ passed: false, sample_count: 88 });
  });

  it("fails a hosted warm-send run shifted +60ms on every sample", () => {
    const hosted = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/p5-hosted-paired-10747588018.json"), "utf8"));
    const warmRows = (warm: typeof hosted.warm) => compareBenchmark(hostedBaseline, {
      ...result,
      latency: { ...result.latency, send_to_agent_warm: { ...result.latency.send_to_agent_warm, ...warm } },
    }).rows.filter((entry) => entry.operation === "send_to_agent_warm" && entry.metric !== "request_bytes");
    const warm = asTwoPassWarmRun(hosted.warm);
    expect(warmRows(warm).every((entry) => entry.passed)).toBe(true);
    // RED for #791's rule: a +60 ms shift on EVERY one of the 192 samples must fail.
    const shifted = structuredClone(warm);
    for (const sample of shifted.paired_control.samples) {
      sample.send_elapsed_ms += 60;
      sample.send_completed_at_ms += 60;
    }
    const elapsed = shifted.paired_control.samples.map((sample: { send_elapsed_ms: number }) =>
      sample.send_elapsed_ms).sort((a: number, b: number) => a - b);
    shifted.p50_ms = Math.round(elapsed[Math.ceil(elapsed.length * 0.5) - 1] * 100) / 100;
    shifted.p95_ms = Math.round(elapsed[Math.ceil(elapsed.length * 0.95) - 1] * 100) / 100;
    expect(warmRows(shifted).find((entry) => entry.metric === "p50_ms"))
      .toMatchObject({ current: 159.23, ceiling: 151.92, passed: false });
  });

  it("tolerates the #803 isolated burst at 192 samples but still fails a +60 ms shift", () => {
    const fixture = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/p1-hosted-warm-burst.json"), "utf8"));
    const warmRow = (warm: object) => compareBenchmark(hostedBaseline, {
      ...result,
      latency: { ...result.latency, send_to_agent_warm: { ...result.latency.send_to_agent_warm, ...warm } },
    }).rows.find((entry) => entry.operation === "send_to_agent_warm" && entry.metric === "p95_ms");

    // At 96 samples p95 is the ~5th-largest: #803's burst of 11 slow samples put it at 273.89.
    expect(fixture.burst.p95_ms).toBe(273.89);
    // At 192 samples (the burst pass + a quiet pass) p95 is the ~10th-largest.
    const run = withRawPercentiles(concatWarmPasses(fixture.burst, fixture.quiet));
    expect(run.paired_control.samples).toHaveLength(192);
    expect(warmRow(run)).toMatchObject({ passed: true });

    const shifted = structuredClone(run);
    for (const sample of shifted.paired_control.samples) {
      sample.send_elapsed_ms = Number(sample.send_elapsed_ms) + 60;
      sample.send_completed_at_ms = Number(sample.send_completed_at_ms) + 60;
    }
    expect(warmRow(withRawPercentiles(shifted))).toMatchObject({ passed: false });
  });

  it("emits no list_agents lock_hold_ms row: since #791 it equals the p95 row with a looser ceiling", () => {
    const rows = compareBenchmark(baseline, result).rows;
    expect(rows.find((entry) =>
      entry.operation === "list_agents" && entry.metric === "lock_hold_ms",
    )).toBeUndefined();
    expect(rows.find((entry) =>
      entry.operation === "list_agents" && entry.metric === "p95_ms",
    )).toBeDefined();
    // Every other operation still gets its lock-hold row.
    expect(rows.filter((entry) => entry.metric === "lock_hold_ms").map((entry) => entry.operation))
      .toEqual(baseline.replay.operations.filter((operation: string) => operation !== "list_agents"));
  });

  it("reports a cold-start alert without turning it into a blocking verdict", () => {
    const hosted = structuredClone(p6Hosted.fail_747.sampled);
    const cold = hosted.paired_control.samples[0];
    cold.send_completed_at_ms += 175 - cold.send_elapsed_ms;
    hosted.paired_control.samples[0].send_elapsed_ms = 175;
    const elapsed = hosted.paired_control.samples.map((sample) => sample.send_elapsed_ms)
      .sort((a, b) => a - b);
    hosted.p50_ms = Math.round(elapsed[Math.ceil(elapsed.length * 0.5) - 1] * 100) / 100;
    hosted.p95_ms = Math.round(elapsed[Math.ceil(elapsed.length * 0.95) - 1] * 100) / 100;
    const candidate = { ...result, latency: { ...result.latency,
      first_send_after_spawn: { ...result.latency.first_send_after_spawn, sampled: hosted } } };
    const comparison = compareBenchmark(hostedBaseline, candidate);
    expect(comparison.rows.find((entry) => entry.operation === "first_send_after_spawn_cold" &&
      entry.metric === "max_ms")).toMatchObject({ current: 175, informational: true,
      alert: true, passed: true });
    expect(renderMarkdownComparison(hostedBaseline, candidate, comparison)).toContain("ALERT (info)");
  });

  it("accepts early zero-overrun timer receipts from hosted artifact 10747588018", () => {
    const hosted = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/p5-hosted-paired-10747588018.json"), "utf8"));
    expect(hosted.source_artifact_id).toBe(10747588018);
    expect(hosted.first.paired_control.samples.filter((sample) =>
      sample.control_timer_fired_at_ms < sample.control_timer_due_at_ms)).toHaveLength(14);
    expect(hosted.warm.paired_control.samples.filter((sample) =>
      sample.control_timer_fired_at_ms < sample.control_timer_due_at_ms)).toHaveLength(37);
    const candidate = {
      ...result,
      latency: {
        ...result.latency,
        first_send_after_spawn: {
          ...result.latency.first_send_after_spawn,
          sampled: { ...result.latency.first_send_after_spawn.sampled, ...hosted.first },
        },
        send_to_agent_warm: { ...result.latency.send_to_agent_warm, ...asTwoPassWarmRun(hosted.warm) },
      },
    };
    const comparison = compareBenchmark(baseline, candidate);
    expect(comparison.paired_control_evaluation.first_send_after_spawn).toMatchObject({
      verdict_basis: "adjusted", valid_pairs: 88, invalid_pairs: 0, invalid_reasons: {},
    });
    expect(comparison.paired_control_evaluation.send_to_agent_warm).toMatchObject({
      verdict_basis: "adjusted", valid_pairs: 192, invalid_pairs: 0, invalid_reasons: {},
    });
    const markdown = renderMarkdownComparison(baseline, candidate, comparison);
    expect(markdown).toContain("first_send_after_spawn: adjusted; 88 valid, 0 invalid");
    expect(markdown).toContain("send_to_agent_warm: adjusted; 192 valid, 0 invalid");
    expect(resultWithComparison(candidate, comparison).perf_budget.paired_control_evaluation)
      .toEqual(comparison.paired_control_evaluation);

    const tooEarly = structuredClone(candidate);
    const sample = tooEarly.latency.first_send_after_spawn.sampled.paired_control.samples[8];
    sample.control_timer_fired_at_ms = sample.control_timer_due_at_ms - 3;
    const rejected = compareBenchmark(baseline, tooEarly);
    expect(rejected.first_send_rounds).toBeNull();
    expect(rejected.paired_control_evaluation.first_send_after_spawn).toMatchObject({
      verdict_basis: "adjusted", valid_pairs: 95, invalid_pairs: 1,
      invalid_reasons: { timer_fired_too_early: 1 },
    });
    const forged = structuredClone(candidate);
    forged.latency.first_send_after_spawn.sampled.paired_control.samples[8].control_timer_overrun_ms = 5;
    expect(compareBenchmark(baseline, forged).paired_control_evaluation.first_send_after_spawn).toMatchObject({
      valid_pairs: 95, invalid_pairs: 1,
      invalid_reasons: { timer_overrun_inconsistent: 1 },
    });
    const tinyForged = structuredClone(candidate);
    tinyForged.latency.first_send_after_spawn.sampled.paired_control.samples[8].control_timer_overrun_ms = 0.01;
    expect(compareBenchmark(baseline, tinyForged).paired_control_evaluation.first_send_after_spawn)
      .toMatchObject({ valid_pairs: 95, invalid_reasons: { timer_overrun_inconsistent: 1 } });
    const beforeStart = structuredClone(candidate);
    beforeStart.latency.first_send_after_spawn.sampled.paired_control.samples[8].control_timer_fired_at_ms =
      beforeStart.latency.first_send_after_spawn.sampled.paired_control.samples[8].control_timer_started_at_ms - 0.1;
    expect(compareBenchmark(baseline, beforeStart).paired_control_evaluation.first_send_after_spawn)
      .toMatchObject({ valid_pairs: 95, invalid_reasons: { timer_timing_inconsistent: 1 } });
    const forgedOverlap = structuredClone(candidate);
    forgedOverlap.latency.first_send_after_spawn.sampled.paired_control.samples[8].control_elapsed_ms = 0.01;
    expect(compareBenchmark(baseline, forgedOverlap).paired_control_evaluation.first_send_after_spawn)
      .toMatchObject({ valid_pairs: 95, invalid_reasons: { control_overlap_inconsistent: 1 } });
  });

  it("shows raw send and phase-local control timings for the slowest samples", () => {
    const withDiagnostics = {
      ...result,
      latency: {
        ...result.latency,
        first_send_after_spawn: {
          ...result.latency.first_send_after_spawn,
          sample_diagnostics: {
            first_send_after_spawn: {
              slowest: [{
                sample_index: 7,
                elapsed_ms: 150,
                paired_control_ms: 2,
                timings_ms: { route: 1, lock: 3, enumerate: 80, type: 55, verify: 4 },
              }],
            },
          },
        },
      },
    };
    const markdown = renderMarkdownComparison(
      baseline,
      withDiagnostics,
      compareBenchmark(baseline, withDiagnostics),
    );
    expect(markdown).toContain("Worst first_send_after_spawn samples");
    expect(markdown).toContain("| Sample | Send | Control | Route | Lock | Enumerate | Type | Verify |");
    expect(markdown).toContain("| 7 | 150 | 2 | 1 | 3 | 80 | 55 | 4 |");
  });

  it("rejects single-shot metadata for every canonical row", () => {
    const singleShot = attest({
      ...baseline,
      replay: {
        ...baseline.replay,
        row_metadata: {
          ...baseline.replay.row_metadata,
          list_surfaces: { sampling: "single_shot", samples_per_run: 1 },
        },
      },
    });
    expect(() => validateBaseline(singleShot)).toThrow(
      /canonical sampled workload/,
    );
    const stressRow = compareBenchmark(baseline, result).rows.find(
      (entry) =>
        entry.operation === "send_to_surface_10_parallel" &&
        entry.metric === "p50_ms",
    );
    expect(stressRow).toMatchObject({
      stress: true,
      margin_ms: 100,
      margin_rule: "measured (1 run)",
      ceiling: 360,
    });
    const markdown = renderMarkdownComparison(
      baseline,
      result,
      compareBenchmark(baseline, result, {
        history: Array.from({ length: 5 }, (_, index) => ({
          measurements: {
            list_surfaces: { p50_ms: 100 + index },
          },
        })),
      }),
    );
    expect(markdown).toContain("| Margin rule |");
    expect(markdown).toContain("measured (5 runs)");
    expect(markdown).not.toContain("constant +300ms (single-shot)");
  });

  it("rejects weakened normal and stress sampling metadata", () => {
    const weakNormal = attest({
      ...baseline,
      replay: {
        ...baseline.replay,
        row_metadata: {
          ...baseline.replay.row_metadata,
          list_surfaces: { sampling: "sampled", samples_per_run: 12 },
        },
      },
    });
    expect(() => validateBaseline(weakNormal)).toThrow(
      /canonical sampled workload/,
    );

    const weakStress = attest({
      ...baseline,
      replay: {
        ...baseline.replay,
        row_metadata: {
          ...baseline.replay.row_metadata,
          send_to_surface_10_parallel: {
            sampling: "sampled",
            samples_per_run: 12,
            stress: false,
          },
        },
      },
    });
    expect(() => validateBaseline(weakStress)).toThrow(
      /canonical sampled workload/,
    );
  });

  it("records only green main runs and bounds append-only history to 50 runs", () => {
    expect(checkerModule).toHaveProperty("appendGreenMainHistory");
    const appendGreenMainHistory = (
      checkerModule as typeof checkerModule & {
        appendGreenMainHistory: (
          history: unknown[],
          result: unknown,
          context: Record<string, unknown>,
        ) => unknown[];
      }
    ).appendGreenMainHistory;
    const existing = Array.from({ length: 50 }, (_, index) => ({
      source: {
        git_sha: String(index).padStart(40, "0"),
        workflow_run_id: index + 1,
      },
      measurements: { list_surfaces: { p50_ms: index } },
    }));
    const unchanged = appendGreenMainHistory(existing, result, {
      event_name: "pull_request",
      ref: "refs/pull/1/merge",
      git_sha: "f".repeat(40),
      workflow_run_id: 999,
    });
    expect(unchanged).toEqual(existing);
    const appended = appendGreenMainHistory(existing, result, {
      event_name: "push",
      ref: "refs/heads/main",
      git_sha: "f".repeat(40),
      workflow_run_id: 999,
      baseline_content_sha256: baseline.refresh_attestation.content_sha256,
    });
    expect(appended).toHaveLength(50);
    expect(appended[0]).toEqual(existing[1]);
    expect(appended.at(-1)).toMatchObject({
      source: { git_sha: "f".repeat(40), workflow_run_id: 999 },
    });
  });

  it("renders corrupted history RED with visibly degraded wide-margin rows", async () => {
    expect(checkerModule).toHaveProperty("readBenchmarkHistory");
    const readBenchmarkHistory = (
      checkerModule as typeof checkerModule & {
        readBenchmarkHistory: (path: string, baselineSha?: string) => Promise<{
          runs: unknown[];
          degraded: boolean;
          reason?: string;
        }>;
      }
    ).readBenchmarkHistory;
    const artifactDir = mkdtempSync(join(tmpdir(), "cmuxlayer-bad-history-"));
    const historyPath = join(artifactDir, "history.json");
    writeFileSync(historyPath, "{not-json");
    try {
      const corrupted = await readBenchmarkHistory(historyPath);
      expect(corrupted).toMatchObject({
        runs: [],
        degraded: true,
        reason: expect.stringContaining("history.json"),
      });
      const comparison = compareBenchmark(baseline, result, {
        history: corrupted.runs,
        historyDegraded: corrupted.degraded,
        historyDegradedReason: corrupted.reason,
      });
      expect(comparison.passed).toBe(false);
      expect(comparison.failures).toContainEqual(
        expect.stringContaining("benchmark history degraded"),
      );
      expect(
        comparison.rows.find(
          (entry) =>
            entry.operation === "list_surfaces" && entry.metric === "p50_ms",
        ),
      ).toMatchObject({ history_degraded: true, margin_ms: 300 });
      expect(renderMarkdownComparison(baseline, result, comparison)).toContain(
        "history-degraded · wide-margin",
      );
      writeFileSync(historyPath, JSON.stringify({ runs: [{ source: { workflow_run_id: 1 } }] }));
      await expect(readBenchmarkHistory(historyPath)).resolves.toMatchObject({
        runs: [],
        degraded: true,
        reason: expect.stringContaining("malformed entry"),
      });
      const validRun = (
        checkerModule as typeof checkerModule & {
          appendGreenMainHistory: (
            history: unknown[],
            result: unknown,
            context: Record<string, unknown>,
          ) => unknown[];
        }
      ).appendGreenMainHistory([], result, {
        event_name: "push",
        ref: "refs/heads/main",
        git_sha: "a".repeat(40),
        workflow_run_id: 99,
        baseline_content_sha256: baseline.refresh_attestation.content_sha256,
      })[0];
      writeFileSync(historyPath, JSON.stringify({ runs: [validRun] }));
      await expect(
        readBenchmarkHistory(
          historyPath,
          baseline.refresh_attestation.content_sha256,
        ),
      ).resolves.toMatchObject({
        runs: [validRun],
        degraded: false,
      });
      await expect(
        readBenchmarkHistory(historyPath, "b".repeat(64)),
      ).resolves.toMatchObject({
        runs: [],
        degraded: true,
        reason: expect.stringContaining("different baseline"),
      });
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
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
      "read_screen p50: 441ms exceeds 180ms",
    );
  });

  it("fails the table when read_screen alone used the CLI fallback", () => {
    const fallback = compareBenchmark(baseline, {
      ...result,
      latency: {
        ...result.latency,
        daemon_path: {
          ...result.latency.daemon_path,
          read_screen: {
            ...result.latency.daemon_path.read_screen,
            transport: "cli",
          },
        },
      },
    });

    expect(fallback.passed).toBe(false);
    expect(fallback.failures).toContain(
      "read_screen transport: cli; cli fallback active",
    );
    expect(
      renderMarkdownComparison(
        baseline,
        {
          ...result,
          latency: {
            ...result.latency,
            daemon_path: {
              ...result.latency.daemon_path,
              read_screen: {
                ...result.latency.daemon_path.read_screen,
                transport: "cli",
              },
            },
          },
        },
        fallback,
      ),
    ).toContain("| read_screen | cli |");
  });

  it("fails the benchmark when the sampled CLI-send distribution used fallback", () => {
    const fallback = compareBenchmark(baseline, {
      ...result,
      latency: {
        ...result.latency,
        send_to_surface_warm: {
          ...result.latency.send_to_surface_warm,
          transport: "cli",
        },
      },
    });

    expect(fallback.passed).toBe(false);
    expect(fallback.failures).toContain(
      "cli_send_ms transport: cli; cli fallback active",
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
      send_to_surface_10_parallel: {
        p50_ms: 270,
        p95_ms: 320,
        lock_hold_ms: 125,
      },
      read_screen_10_parallel: {
        p50_ms: 190,
        p95_ms: 250,
        lock_hold_ms: 0,
      },
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
      cli_send_ms: 210,
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
          p95_ms: 2,
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
            p50_ms: 4,
          },
        },
      },
    });

    expect(
      comparison.rows.find(
        (entry) =>
          entry.operation === "list_surfaces" && entry.metric === "p50_ms",
      )?.ceiling,
    ).toBe(3);
    expect(comparison.failures).toContain(
      "list_surfaces p50: 4ms exceeds 3ms",
    );
  });

  it("fails closed on CLI send, replay-shape, and request-byte drift", () => {
    const cli = compareBenchmark(baseline, {
      ...result,
      latency: {
        ...result.latency,
        send_to_surface_warm: {
          ...result.latency.send_to_surface_warm,
          p50_ms: 1_001,
        },
      },
    });
    expect(cli.failures).toContain(
      "send_to_surface_warm cli_send: 1001ms exceeds 875ms",
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

  it("fails closed when candidate sampling metadata is missing or incompatible", () => {
    const missing = compareBenchmark(baseline, {
      ...result,
      replay: { ...result.replay, row_metadata: undefined },
    });
    expect(missing.passed).toBe(false);
    expect(missing.failures).toContainEqual(
      expect.stringContaining("candidate row_metadata.list_surfaces"),
    );

    const incompatible = compareBenchmark(baseline, {
      ...result,
      replay: {
        ...result.replay,
        row_metadata: {
          ...result.replay.row_metadata,
          list_surfaces: { sampling: "single_shot", samples_per_run: 1 },
        },
      },
    });
    expect(incompatible.passed).toBe(false);
    expect(incompatible.failures).toContainEqual(
      expect.stringContaining("candidate row_metadata.list_surfaces"),
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
    const fastRowMetadata = Object.fromEntries(
      Object.entries(result.replay.row_metadata).map(([operation, metadata]) => [
        operation,
        {
          ...metadata,
          samples_per_run: metadata.samples_per_run / 4,
        },
      ]),
    );
    const fast = {
      ...result,
      rounds: 3,
      replay: {
        ...result.replay,
        rounds: 3,
        row_metadata: fastRowMetadata,
      },
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
      "| Operation | Transport | Sampling | Margin rule | Metric |",
    );
    expect(markdown).toContain("first_send_after_spawn");
    expect(markdown).toContain("Runner regression ratio: 1.25x");
    expect(markdown).toContain("rows unchanged");
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("<summary>Full table</summary>");
    const defaultTable = markdown.split("<details>")[0];
    expect(defaultTable).not.toContain("| list_surfaces | socket | sampled | request_bytes |");
  });

  it("commits only the canonical CI-attested sampled baseline", () => {
    const committed = JSON.parse(
      readFileSync(
        join(repoRoot, "benchmarks", "daemon-baseline.json"),
        "utf8",
      ),
    );

    expect(() => validateBaseline(committed)).not.toThrow();
    expect(checkerModule).toHaveProperty("isAttestedLegacyBaseline");
    expect(
      (
        checkerModule as typeof checkerModule & {
          isAttestedLegacyBaseline: (candidate: unknown) => boolean;
        }
      ).isAttestedLegacyBaseline(committed),
    ).toBe(false);
    expect(committed.source.git_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.replay).toMatchObject({ clients: 8, rounds: 12 });
    expect(committed.replay.operations).toEqual(baseline.replay.operations);
    expect(committed.replay.row_metadata).toEqual(baseline.replay.row_metadata);
    for (const operation of [
      "send_to_surface_warm",
      "send_to_agent_warm",
      "spawn_close_during_sweep",
      "first_send_after_spawn",
    ]) {
      expect(committed.measurements[operation].p95_ms).toBeGreaterThan(
        committed.measurements[operation].p50_ms,
      );
    }
    expect(committed.source.runner_class).toBe("github-actions-ubuntu-latest");
    expect(committed.source.workflow_run_id).toBe(33380548570);
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
    expect(source).toContain("const PARALLEL_STRESS_COUNT = 10");
    expect(source).toContain('HOME: join(tempRoot, "home")');
    expect(source).toContain('CMUXLAYER_STATE_DIR: join(tempRoot, "state")');
    expect(source).toContain('CMUXLAYER_INBOX_BASE_DIR: join(tempRoot, "inbox")');
    expect(source).toContain('/^cmuxlayerCodex-[a-z0-9]{8}$/.test(spawnResult.agent_id)');
    expect(source).toContain('request_bytes: requestBytes("close_surface", closeArgs)');
    expect(source).toContain('sampling: "sampled"');
    expect(source).toContain("samples_per_run");
    expect(source).toContain("for (const [clientIndex, client] of clients.entries())");
    expect(source).toContain("surface_receipts_waitable: samples.every");
    expect(source).toContain('sample.surface.wait_for.delivery_state === "submitted"');
    expect(source).toContain("sample.surface.wait_for.submit_verified === true");
    expect(source).toContain(
      "surface_receipt_is_waitable:\n        firstSendAfterSpawn.surface_receipts_waitable",
    );
    expect(source).toContain("p95_ms");
    expect(source).toContain("request_bytes");
    expect(source).toContain("lock_hold_ms");
    expect(source).toContain("timings_ms?.lock_hold");
    expect(source).toContain("CMUXLAYER_BENCH_JSON_PATH");
    expect(source).toContain(
      "await waitForLifecycleWaiter(sweepHoldState, closeHoldToken)",
    );
    expect(source).toContain("transport: closeReceipt.transport");
    expect(source).toContain(
      'const listReceipt = toolData(list, "list_surfaces")',
    );
    expect(source).toContain(
      'const readReceipt = toolData(read, "read_screen")',
    );
    expect(source).not.toContain(
      'receipt.transport || name === "control_health"',
    );
    expect(source).not.toContain("const transportReceipts = await Promise.all");
    expect(source).toMatch(
      /await Promise\.all\(stressClients\.map\(\(client\) => client\.close\(\)\)\);\n {4}stressClients = \[\];\n {4}const daemonRssMb = await totalRssMb/,
    );
    expect(source).not.toContain("onFirstSample");
    expect(source).toContain("const surfaceStates = new Map()");
    expect(source).toContain("const surfaceMutationQueues = new Map()");
    expect(source).toContain("function fakeSurfaceStateKey(");
    expect(source).toContain("fakeSurfaceStateKey(params.surface_id, surfaces)");
    expect(source).toContain("await mutateFakeSurfaceState(");
    expect(source).toContain(
      "daemon_survived_replay:\n        daemon.exitCode === null &&\n        daemon.signalCode === null &&\n        daemonStats.rssKb > 0",
    );
    expect(source).toContain("get alive() {");
    expect(source).toContain(
      "benchmark_clients_survived_replay:\n        stressClientsSurvivedReplay &&\n        daemonClients.every((client) => client.alive)",
    );
    expect(source).toContain("function parallelStressSentinel(index, roundIndex)");
    expect(source).toContain("readSurfaceState(surface)");
    expect(source).toContain("writeSurfaceState(surface, surfaceState)");
    expect(source).toContain("await requireSubmittedDelivery(client, receipt, label)");
    expect(source).not.toContain("return requireSubmittedDelivery(client, receipt, label)");
    expect(source).not.toContain("receipt.typed !== true || receipt.submit_attempted !== true");
    expect(source).toContain("was not verified as submitted");
    expect(source).toContain("text: surfaceSampleSentinel(sampleIndex)");
    expect(source).toContain('"surface:bench-spawn"');
    expect(source).toContain("read_back_verified: true");
    expect(source).toContain("sample.surface.wait_for.read_back_verified === true");
    expect(source).toContain(
      "validateReceipt?.(receipt, requests[index], index, roundIndex)",
    );
    expect(source).toContain("parallel read returned the wrong surface");
    expect(source).toContain("parallel read omitted its unique sentinel");
    expect(source).toContain("function requireFiniteLockHold(");
    expect(source).toContain("close_surface did not close the spawned surface");
    expect(source).toContain("list_agents omitted the live spawned agent");
    expect(source).not.toContain("compact(receipt).includes(spawnResult.agent_id)");
    expect(source).toContain("Array.isArray(receipt.agents)");
    expect(source).toContain("receipt.agents.some(");
    expect(source).toContain("agent.agent_id === spawnResult.agent_id");
    expect(source).toContain("lockHoldFromElapsed: true,");
    // #791 tail rows: twice the rounds; list_agents lock hold is p95, not max.
    expect(source).toContain("roundMultiplier: TAIL_ROW_SAMPLE_MULTIPLIER.list_agents");
    expect(source).toContain('lockHold: "p95"');
    expect(source).toContain(
      "const lifecycleRounds = rounds * TAIL_ROW_SAMPLE_MULTIPLIER.send_to_agent_warm",
    );
    // Every other spawn-lifecycle row keeps exactly the canonical samples.
    expect(source).toContain("const canonical = samples.slice(0, rounds * clients.length)");
    expect(source).toContain(
      "lock_hold_ms: lockHoldFromElapsed ? elapsedMs : 0",
    );
    const sendBody = source.slice(
      source.indexOf("const measureSend = async"),
      source.indexOf("// The daemon sweep acknowledges"),
    );
    expect(sendBody.indexOf("await validateReceipt?.(receipt)")).toBeLessThan(
      sendBody.indexOf("const completedAt = nowMs()"),
    );
    expect(source).toMatch(
      /await Promise\.all\([\s\S]*?validateReceipt\?\.[\s\S]*?\);\n {4}const elapsedMs = nowMs\(\) - startedAt;/,
    );
    expect(source).not.toContain('"sampled surface send initial receipt"');
    expect(source).toContain(
      "const terminal = await requireSubmittedDelivery(\n          client,\n          receipt,\n          \"sampled surface send\"",
    );
    expect(source).toContain(
      'requireTerminalSubmission(receipt, "parallel send initial receipt")',
    );
    expect(source).toContain("beforeRound?.(roundIndex)");
    expect(source).toContain("parallelStressSentinel(index, roundIndex)");
    expect(source).toContain("args(index, roundIndex)");
    expect(source).toContain(
      '"parallel send",',
    );
    expect(source).toContain("firstSendAfterSpawn.sampled");
    expect(source).toContain("firstSendAfterSpawn.send_to_agent_warm");
    expect(source).toContain("firstSendAfterSpawn.send_to_surface_warm");
    expect(source).not.toContain("firstSendAfterSpawn.first,\n");
    expect(source).not.toContain("firstSendAfterSpawn.second,\n");
    expect(source).not.toContain("firstSendAfterSpawn.surface,\n");
  });

  it("keeps spawned-agent request byte accounting at the attested payload shape", () => {
    const bytes = (name: string, args: Record<string, unknown>) =>
      Buffer.byteLength(serializeMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }));
    const agent_id = "cmuxlayerCodex-00000000";
    expect(bytes("send_to", {
      mode: "agent", agent_id,
      text: "Read and follow docs.local/scratch/run5r3/bench-first-send.md",
      press_enter: true,
    })).toBe(231);
    expect(bytes("send_to", {
      mode: "agent", agent_id,
      text: "Read and follow docs.local/scratch/run5r3/bench-second-send.md",
      press_enter: true,
    })).toBe(232);
    expect(bytes("close_surface", {
      scope: "agent", agent_id, force: true,
    })).toBe(161);
  });

  it("keeps the executable benchmark parseable by Node", () => {
    const benchmarkPath = join(repoRoot, "scripts", "bench-daemon.mjs");
    const checked = spawnSync("node", ["--check", benchmarkPath], {
      encoding: "utf8",
    });

    expect(checked.status, checked.stderr).toBe(0);
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
    expect(workflow).toContain("actions/cache/restore");
    expect(workflow).toContain("actions/cache/save");
    expect(workflow).toContain("history.json");
    expect(workflow).toContain("hashFiles('benchmarks/daemon-baseline.json')");
    expect(
      readFileSync(
        join(repoRoot, "scripts", "check-daemon-benchmark.mjs"),
        "utf8",
      ),
    ).toContain("GITHUB_STEP_SUMMARY");
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
    expect(source).toContain("migratingLegacyBaseline\n            ? measured");
    expect(source).toContain("replay?.bytes?.[operation]");
    expect(source).toContain(
      "refusing to raise a committed performance baseline",
    );
    expect(source).toContain("CMUXLAYER_BENCH_IMPORT_RESULT_PATH");
    expect(source).toContain("runnerRebase");
    expect(source).toContain("runnerRebase ? Math.max : Math.min");
    expect(source).toContain('--reason');
    expect(source).toContain("increase_reason");
  });

  it("keeps local artifacts out of default Vitest collection", () => {
    const config = readFileSync(join(repoRoot, "vitest.config.ts"), "utf8");
    expect(config).toContain('"**/docs.local/**"');
  });

  it("contains fake-socket teardown resets inside the benchmark connection", () => {
    const source = readFileSync(
      join(repoRoot, "scripts", "bench-daemon.mjs"),
      "utf8",
    );
    expect(source).toContain('socket.on("error", () => {})');
  });
});
