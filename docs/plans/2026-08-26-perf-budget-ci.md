# Perf-Budget CI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the existing daemon benchmark a required, regression-capable PR/main CI budget with a committed baseline, one edited PR comment, scripted refresh, and a fast local subset.

**Architecture:** Preserve `bench-daemon.mjs` replay behavior and add machine-readable measurements. A separate comparison script owns baseline validation, ceiling checks, and Markdown generation; workflow YAML owns CI execution and the idempotent comment update.

**Tech Stack:** Node.js ESM, Bun scripts, Vitest, GitHub Actions, `actions/github-script`.

---

### Task 1: Specify benchmark result and baseline contracts

**Files:**
- Create: `tests/perf-budget.test.ts`
- Create: `scripts/check-daemon-benchmark.mjs`
- Create: `benchmarks/daemon-baseline.json`

1. Write failing tests for required replay, bytes, p50/p95, `lock_hold_ms`, first-send, hard ceilings, table output, and fail-closed comparisons.
2. Run `bunx vitest run tests/perf-budget.test.ts` and confirm failure because the checker/baseline do not exist.
3. Implement exported pure validation/comparison/report helpers in the checker.
4. Add the baseline schema populated from a fresh v0.4.63 measurement.
5. Re-run the focused test and confirm green.

### Task 2: Instrument the existing benchmark without changing its replay

**Files:**
- Modify: `scripts/bench-daemon.mjs`
- Test: `tests/perf-budget.test.ts`

1. Extend the failing tests to require p95, per-operation serialized request bytes, first-send lock timing, and optional JSON output.
2. Confirm the tests fail on the current benchmark.
3. Add p95 calculation, byte accounting, `lock_hold_ms`, and `CMUXLAYER_BENCH_JSON_PATH` output while retaining 8 clients, 12 rounds, existing operations, and current gates.
4. Run the focused tests, build, and one full benchmark; inspect the JSON output.

### Task 3: Add the executable gate and refresh path

**Files:**
- Modify: `scripts/check-daemon-benchmark.mjs`
- Create: `scripts/refresh-daemon-baseline.mjs`
- Modify: `package.json`
- Create: `docs/performance-budgets.md`
- Test: `tests/perf-budget.test.ts`
- Test: `tests/pre-pr-scripts.test.ts`

1. Write failing tests for `bench:daemon:check`, `bench:daemon:refresh`, and the fast local `pre-pr` inclusion.
2. Confirm RED.
3. Implement full/fast checker modes, report paths, and refresh script; document the command and frozen hard ceilings.
4. Update package scripts so `pre-pr` includes the fast mode.
5. Re-run both focused test files and confirm green.

### Task 4: Wire the required CI job and edited comment

**Files:**
- Modify: `.github/workflows/ci.yml`
- Test: `tests/perf-budget.test.ts`

1. Write failing source-contract tests requiring the PR/main job, write permission, full checker command, artifacts, `always()` comment step, stable marker, and update-or-create behavior.
2. Confirm RED.
3. Add the `perf-budget` job and idempotent `actions/github-script` comment logic.
4. Add `docs.local/scratch/**` to `vitest.config.ts` and assert the exclusion.
5. Re-run focused tests and YAML parse validation.

### Task 5: Verify locally and open the PR

**Files:**
- All changed files

1. Run `bun run build`, focused tests, `bun run pre-pr`, `bun run test`, `git diff --check`, and the full benchmark checker.
2. Read every summary and record exact pass/fail counts and benchmark table.
3. Run the local CodeRabbit review gate, address actionable findings, then commit with the required agent trailer.
4. Push and create a ready-for-review PR with signed body and `STATUS: REVIEW_NEEDED`.

### Task 6: Prove RED remotely and restore green

**Files:**
- Scratch branch only: `benchmarks/daemon-baseline.json`

1. Branch from the feature head, deliberately lower a measured ceiling, commit, push, and open a scratch PR to `main`.
2. Capture the exact failing `perf-budget` Actions run URL and job evidence.
3. Revert the deliberate regression, push, and verify the exact new SHA returns green.
4. Add the RED run URL and before/after table to the feature PR body.
5. Stop at the worker endpoint; do not merge, spawn, message, or wait for the lead-owned reviewer.

