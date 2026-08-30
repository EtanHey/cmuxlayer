# Run 10 Harness Review Follow-up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair all eight unanswered PR #575 findings while preserving the Run 10 benchmark contract and measurements.

**Architecture:** Keep the existing PID/start-identity hard-link lease and make reclaim markers recoverable with the same owner validation. Separate workspace cleanup from output publication so the output lock protects the authoritative write, and harden the remaining row, environment, provenance, and abort semantics in their existing helpers.

**Tech Stack:** Bun, JavaScript ESM, Vitest, Node filesystem/process APIs, GitHub GraphQL review threads.

---

## Task 1: Recover abandoned reclaim markers

**Files:**
- Modify: `tests/bench-e2e.test.ts`
- Modify: `scripts/bench-e2e.mjs`

**Steps:**

1. Add a test that creates `<output>.lock.reclaim` with a dead PID and verifies `createOutputReservation(output)` succeeds and cleans up.
2. Run only that test and observe `could not reclaim atomic lock`.
3. Add a helper that reads `reclaimPath`, parses the existing PID/start identity, preserves a live matching owner, and unlinks a dead or PID-reused marker before retrying.
4. Run the focused test and the existing simultaneous-stale-contender test.

## Task 2: Close row and abort correctness findings

**Files:**
- Modify: `tests/bench-e2e.test.ts`
- Modify: `scripts/bench-e2e.mjs`

**Steps:**

1. Add a failing assertion that `buildAbsentComparisonRow({ concurrency: 5 })` emits `concurrency_profile: "c5"`.
2. Add a failing abort test with two workers where one rejects first and verify the row does not reject until the second worker settles.
3. Add `concurrency_profile` with value `c${row.concurrency}` to absent rows.
4. Replace early-rejecting `Promise.all` with `Promise.allSettled`, flatten fulfilled samples, then propagate the first worker rejection after every worker settles.

## Task 3: Seal runtime and source provenance

**Files:**
- Modify: `tests/bench-e2e.test.ts`
- Modify: `scripts/bench-e2e.mjs`

**Steps:**

1. Add failing tests showing inherited `CMUXLAYER_HEAP_GUARD_BYTES`, `NODE_OPTIONS`, and `BUN_OPTIONS` survive isolation. In the provenance spy, require both status calls to use exactly `git status --porcelain`; the current `--untracked-files=no` argument makes this assertion fail and the corrected calls prove untracked fixtures are no longer excluded.
2. Remove all inherited `CMUXLAYER_*` keys plus Node/Bun behavior overrides before setting the harness-owned environment.
3. Change both provenance status reads to `git status --porcelain` and update dirty-worktree messages to cover tracked and untracked files.
4. Run the focused provenance tests.

## Task 4: Hold the output lease through publication

**Files:**
- Modify: `tests/bench-e2e.test.ts`
- Modify: `scripts/bench-e2e.mjs`

**Steps:**

1. Add a failing ordering test for a `publishBenchmarkReceipt` helper: receipt write must complete before output release starts.
2. Implement the helper with `await writeFile(...)` followed by `await outputReservation.release()`.
3. Pass a workspace-only release callback into `executeBenchmark`; publish through the helper while the output lease is still held. Keep the outer idempotent release of both reservations for failure cleanup.
4. Run the focused ordering and reservation-release tests.

## Task 5: Verify, commit, and open the corrective PR

**Steps:**

1. Run `bun test tests/bench-e2e.test.ts`.
2. Run the repository typecheck in both required environment modes, D138 grep gate, and full suite commands from `package.json`/the original ruling.
3. Review the exact diff against `origin/main`, run the local review gate, commit with the verified Codex identity trailer, and push.
4. Open a ready-for-review PR with a signed body. Reply to all eight original PR #575 threads with `ACCEPTED-AND-FIXED` and the commit SHA, then resolve them.
5. Request bot review on the follow-up, wait for CI, and re-query unresolved threads as a standalone paginated command. Do not merge without Etan's explicit go.

After the repository work is handed off, update the contract-required external worker report in place; it is an operational handoff and not part of the PR diff.
