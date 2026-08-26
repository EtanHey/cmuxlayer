# Perf-Budget CI Design

## Context

`scripts/bench-daemon.mjs` already exercises the production daemon with eight clients and twelve rounds, but no CI workflow invokes it. D117 requires a required PR/main gate, a committed post-run-5 baseline, an update-in-place PR comment, a scripted refresh path, and a fast local pre-PR subset. Benchmark methodology is out of scope.

## Considered approaches

1. Put comparison and GitHub-comment logic directly in the workflow YAML. This minimizes files, but makes local testing, refreshes, JSON validation, and RED proofs awkward.
2. Add machine-readable output to the existing benchmark and keep comparison/report generation in a separate script. This preserves the workload while making the same gate runnable in CI and locally. This is the selected approach.
3. Replace the benchmark with Vitest cases. This would make local execution familiar, but would rebuild working methodology and blur the boundary between unit tests and a production-daemon replay.

## Design

The existing benchmark gains instrumentation only: p95 samples, request byte counts, first-send lock timing, and an optional JSON output path. Its current human output and intrinsic gates remain intact.

A committed JSON baseline records the replay shape, measured post-run-5 values, and frozen ceilings. The comparison script validates the baseline schema, runs the benchmark, compares every budget, writes a Markdown before/after table, and exits non-zero on regression. Exact-head CI calibration uses per-operation runner margins: 8x for `list_surfaces` and 3.2x for `read_screen` p95, leaving about 22-24% over the two observed runner maxima. First-send remains an absolute 2,000 ms ceiling and read-screen p50 remains an absolute 250 ms ceiling.

The CI job builds, runs the comparison, uploads its JSON/Markdown artifacts, and uses a stable HTML marker to find and edit one bot comment on pull requests. It runs on every `pull_request` and `main` push because it is a normal job in the existing CI workflow.

The baseline refresh command is an executable script. It runs the full replay, refuses RED benchmark output, and rewrites the baseline from measured values while preserving hard ceilings. Documentation explains that refreshes are only for legitimate improvements and must include RED-proof review.

The local `pre-pr` chain invokes the same comparison in a reduced-round mode. Client count stays at eight because the existing benchmark enforces that minimum; only rounds are reduced, preserving the concurrency shape while cutting runtime.

## Failure handling and proof

Malformed or missing baseline/result fields fail closed. The report is written before comparison failure so CI can still update the PR comment. A deliberate low-ceiling regression commit on a scratch branch must produce a real failing Actions run; reverting that commit must restore green. `docs.local/scratch/**` is excluded from Vitest collection in the same change.
