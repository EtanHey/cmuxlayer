# Monitor Owner Failover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make stale monitors fail loudly and idempotently when their owner surface is PTY-dead, without dispatching an impossible owner inbox re-arm.

**Architecture:** Extend the registry reconciler with a shared-liveness-derived PTY-dead classification and a one-shot collapse escalation callback. The daemon consumes its existing `SurfaceWriteLivenessTracker`, preserves the current healthy-owner re-arm path, and routes PTY-dead collapse through an injectable high-priority notifier.

**Tech Stack:** TypeScript, Vitest, Bun, JSON file registry, cmux daemon server context.

---

### Task 1: Specify registry PTY-dead collapse and one-shot escalation

**Files:**
- Modify: `tests/monitor-registry.test.ts`
- Modify: `src/monitor-registry.ts`

1. Add a test registering a stale re-arm-capable monitor with an existing absolute file target.
2. Reconcile with `ownerPtyDead` returning true, `ownerAlive` returning true, and spies for re-arm and escalation.
3. Assert the test fails because `owner-pty-dead` and the escalation seam do not exist yet.
4. Add `owner-pty-dead` to `MonitorCollapseReason` and add injectable `ownerPtyDead` and `escalate` dependencies.
5. Under the existing registry lock, persist `collapsed` plus `owner-pty-dead`; invoke escalation only for the winning claim.
6. Reconcile a second time and assert one escalation, zero re-arms, and durable collapse metadata.
7. Run `bunx vitest run tests/monitor-registry.test.ts`.

### Task 2: Preserve healthy-owner behavior

**Files:**
- Modify: `tests/monitor-registry.test.ts`
- Modify: `src/monitor-registry.ts`

1. Extend the healthy-owner regression test with `ownerPtyDead` returning false and an escalation spy.
2. Run the focused test and verify the existing deterministic inbox/re-arm claim behavior remains green.
3. Keep `ownerAlive`, watch-target validation, claim expiry, and deadman exclusion semantics unchanged.

### Task 3: Specify daemon consumption of shared write-liveness

**Files:**
- Modify: `tests/daemon.test.ts`
- Modify: `src/daemon.ts`

1. Create a daemon test context with a real `SurfaceWriteLivenessTracker` and a file-backed owner record.
2. Record the configured number of broken-pipe failures against the owner's existing surface.
3. Start the daemon with an injected collapse notifier and inbox directory.
4. Assert the test initially fails because default reconciliation does not consult the tracker or emit escalation.
5. In the default reconciler, resolve `context.surfaceWriteLiveness.observe(owner.surface_id)?.pty_dead` without reimplementing the threshold.
6. Pass an injected high-priority owner-PTY-dead notifier and ensure the re-arm callback is not invoked for that record.
7. Start a second reconciliation tick and assert one notification and no inbox `monitor-rearm` message.
8. Run the focused daemon test.

### Task 4: Verify and publish

**Files:**
- Review: `src/monitor-registry.ts`
- Review: `src/daemon.ts`
- Review: `tests/monitor-registry.test.ts`
- Review: `tests/daemon.test.ts`
- Review: both new plan documents

1. Run the focused registry and daemon suites.
2. Run `bun run typecheck` and `bun run build`.
3. Run `bun run test` five times as separate cold processes and read every result.
4. Run `git diff --check`, inspect the full diff, and verify no observability-seat or forbidden files changed.
5. Run a bounded local CodeRabbit review; address actionable findings and rerun verification.
6. Commit the scoped files, push the feature branch, and open a ready PR titled `feat(monitors): daemon-side failover for pty-dead / wedged monitor owners`.
7. Put the design rationale, state transition, safe-default decision, and verification evidence directly in the PR body.
8. Invoke reviewers, read every review and CI result, fix or reply to findings, request re-review, and merge only when the loop is clean.
9. Verify the remote merge contains the latest pushed content, clean up the branch/worktree from the main checkout as safe, and store the design and milestone in BrainLayer.
