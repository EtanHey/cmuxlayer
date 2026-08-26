# Run 8 Wakes Truth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make engine parent wakes content-addressed and child-scoped, reconcile registry state to live screen truth, remove implicit idle waits, expand and ratchet daemon performance coverage, and reject committed machine-home literals.

**Architecture:** Keep watch persistence in `src/watch-spec.ts`, but make file revisions hash-only, debounce transient absence, and expose a narrow removal primitive used by lifecycle close. Keep delivery and state reconciliation in `src/server.ts`/`src/agent-health.ts`, where fresh target-screen evidence already exists. Extend the existing benchmark request/replay schema and refresh gate rather than creating a second performance framework.

**Tech Stack:** TypeScript, Vitest, Bun, MCP lifecycle server, JSON benchmark baselines, shell/launchd packaging.

---

### Task 1: Content-addressed, scoped report watches

**Files:** `src/watch-spec.ts`, `src/server.ts`, `src/agent-engine.ts`, `tests/watch-spec.test.ts`, `tests/p11-spawn-contract.test.ts`, `tests/server-agent-tools.test.ts`

1. Add failing tests for metadata-only rewrites, delete/rewrite debounce, foreign ownership, closed-agent removal, and one real-content wake.
2. Run the focused tests and record the expected failures.
3. Persist content hashes without timestamp/inode identity, debounce missing files for at most two seconds, bind each parent watch to its child, and remove it on close.
4. Re-run focused tests to green.

### Task 2: Reconciled screen truth and lean parsed reads

**Files:** `src/agent-health.ts`, `src/server.ts`, `tests/agent-health.test.ts`, `tests/server-agent-tools.test.ts`, `tests/server.test.ts`

1. Add failing tests for screen-confirmed working/idle health, unread-inbox monitor severity, reconciled `wait_for`, and `parsed_only.parsed.status` parity.
2. Make active screen evidence authoritative without degrading health; degrade a missing monitor only when unread inbox work exists; make wait predicates consume the same live state.
3. Re-run focused tests to green.

### Task 3: Busy delivery without implicit idle waits

**Files:** `src/server.ts`, `src/agent-engine.ts`, `tests/server-agent-tools.test.ts`

1. Add failing tests proving a busy target is submitted and labeled `queued_behind_turn`, foreign composer text is refused, and send/spawn/boot paths invoke no idle-wait helper.
2. Remove the send-side interactive-state gate while retaining route/TUI/composer identity guards.
3. Re-run focused tests to green.

### Task 4: Performance replay and monotone ratchet

**Files:** `scripts/bench-daemon.mjs`, `scripts/check-daemon-benchmark.mjs`, `scripts/refresh-daemon-baseline.mjs`, `benchmarks/daemon-baseline.json`, benchmark tests

1. Add failing fixtures for the #560 variance sample, per-row monotonic updates, a real 2x regression, and the five new warm/sweep operations.
2. Extend canonical replay measurements with p50/p95, request bytes, and lock hold; apply the binding per-row margin and 1,000 ms sanity cap.
3. Refresh the baseline only through the attested workflow mechanism and report rows above 500 ms.

### Task 5: Machine-home literal gate

**Files:** launchd packages, scripts, tests, fixtures, `package.json`

1. Add a failing repository scan test that ignores only `docs/` and `docs.local/`.
2. Replace committed `/Users/<name>/` literals with installer tokens, environment-derived defaults, or synthetic `/Users/example/` fixtures.
3. Re-run the gate and relevant launchd package tests.

### Task 6: Verification and worker PR handoff

1. Run focused suites, the full suite, typecheck in both required environment modes, performance budget, and a real-client daemon smoke without launchd.
2. Run bounded local CodeRabbit review, commit with the required trailer, push, and open a signed ready-for-review PR containing RED/GREEN proofs and refresh reasoning.
3. Write the engine contract report ending with `DONE_CMUXLAYERCODEX_FF3FF3DF` and stop at `STATUS: REVIEW_NEEDED` without merging.
