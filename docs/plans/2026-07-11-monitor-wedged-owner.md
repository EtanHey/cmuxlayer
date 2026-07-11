# Monitor Wedged Owner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fail over a stale monitor whose pane remains readable but whose owner never acknowledges a re-arm dispatch.

**Architecture:** Extend the existing registry lease transition with an acknowledgement timeout, owner-progress probe, explicit owner-independence predicate, and one-shot fallback/escalation callbacks. The daemon derives owner progress from the exact inbox ACK and post-dispatch agent heartbeat, then sets the default acknowledgement timeout to twice its reconcile interval; existing list and health projections carry the new reason automatically.

**Tech Stack:** TypeScript, Vitest, JSON file registry, cmuxlayer daemon.

---

### Task 1: Specify unacknowledged owner-wedged transitions

**Files:** `tests/monitor-registry.test.ts`, `src/monitor-registry.ts`

1. Add a stale monitor test that first dispatches re-arm, advances past the acknowledgement timeout with a pane-alive/no-progress owner, and expects one `owner-wedged` collapse and escalation.
2. Run the focused test and confirm it fails because the expired claim is redispatched.
3. Add the new collapse reason, acknowledgement timeout, and owner-progress predicate.
4. Re-run the focused test and keep the existing lease claim as the atomic guard.

### Task 2: Specify acknowledgement, fallback, idempotency, and recovery

**Files:** `tests/monitor-registry.test.ts`, `src/monitor-registry.ts`

1. Add tests for signal acknowledgement in time, owner progress with normal retry, explicit owner-independent fallback, repeated-tick idempotency, and recovery from `owner-wedged` via a genuine signal.
2. Run each new test red before production changes.
3. Implement only the transitions required by the tests and re-run the focused suite green.

### Task 3: Wire daemon timeout/progress and observability

**Files:** `tests/daemon.test.ts`, `tests/monitor-registry-mcp.test.ts`, `tests/control-health.test.ts`, `src/daemon.ts`

1. Add daemon coverage proving an alive/readable owner without an inbox ACK or post-dispatch heartbeat becomes `owner-wedged` after two ticks and emits one loud notification.
2. Add projection coverage for `list_monitors` and `control_health.self_heal`.
3. Run the focused tests red, then pass the daemon interval-derived timeout and owner-progress callback into registry reconciliation.
4. Re-run focused tests green.

### Task 4: Quiet terminal records, reap abandoned monitors, and dedupe notifications

**Files:** `tests/monitor-registry.test.ts`, `tests/daemon.test.ts`, `src/monitor-registry.ts`, `src/daemon.ts`, `src/outbox-drainer.ts`

1. Add failing tests that reconcile a claimed `deadman-fired` record for ten ticks with zero callbacks and reap an ancient dead-owner record exactly once.
2. Add failing payload assertions for `monitor_id:transition` dedupe keys on deadman and owner-collapse notifications.
3. Implement an atomic, silent reap pre-pass with an injectable 24-hour default and preserve the existing terminal candidate exclusion.
4. Add transition dedupe keys to the notify payload type and adapters, then re-run the focused tests.
5. Make direct daemon construction default to no registry/network side effects, wire live delivery only in `runDaemon`, enforce test-mode no-ops, and tear down every interval daemon asynchronously.

### Task 5: Verify and publish

1. Run focused registry, daemon, MCP, and health tests.
2. Run typecheck and build.
3. Run the deterministic full suite five times in separate cold processes.
4. Run `git diff --check`, inspect the full diff, and run a bounded local review.
5. Commit scoped files, push `feat/r8-monitor-wedged-owner`, open the requested ready PR, invoke reviewers, and report the PR URL.
