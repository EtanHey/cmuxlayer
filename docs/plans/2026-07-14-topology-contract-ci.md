# Topology Contract CI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a single CI-runnable topology contract suite covering all six invariants in the dispatched mission.

**Architecture:** Reuse production-facing test seams rather than introduce a test-only runtime abstraction. `FleetSidebarPublisher` locks publication monotonicity, `AgentEngine` locks first-connect and sweep lifecycle behavior, and the pure Fleet snapshot/renderer locks seat identity, content, and collapse.

**Tech Stack:** TypeScript, Vitest, Bun scripts, GitHub Actions' existing `test` job.

---

### Task 1: Build shared contract fixtures

**Files:**
- Create: `tests/topology-contract.test.ts`

**Steps:**

1. Add candidate, snapshot, publication, registry-record, cmux-client, topology,
   and temporary-output fixtures.
2. Keep every fixture local to the suite so production exports do not grow for
   test convenience.
3. Run `bunx vitest run tests/topology-contract.test.ts` and confirm the empty
   scaffold is discoverable before adding assertions.

### Task 2: Lock publisher monotonicity RED-first

**Files:**
- Modify temporarily, then restore: `src/fleet-sidebar.ts`
- Modify: `tests/topology-contract.test.ts`

**Steps:**

1. Temporarily remove the populated-over-unknown guard in
   `FleetSidebarPublisher.shouldPublish()`.
2. Seed two live seats, then publish unknown, populated-partial, and
   non-authoritative-empty observations; assert the bytes remain the populated
   last-good source.
3. Run `bunx vitest run tests/topology-contract.test.ts`, capture the expected
   failing assertion, restore the guard, and rerun to green.

### Task 3: Lock sweep, first-paint, and binding behavior

**Files:**
- Modify: `tests/topology-contract.test.ts`

**Steps:**

1. Drive a ghost through normal sweeps: first authoritative miss retains the
   record, a live observation resets confirmation, and two misses spanning
   5 seconds evict it.
2. Call `initialize()` on an empty registry with a discoverable surface; assert
   the first publication is `discovering` and the awaited initialization
   publishes the live seat without waiting for a sweep timer.
3. Reconstitute two managed seats and return distinct screen parses for each
   surface; assert each rendered seat keeps its own id, surface, and action.

### Task 4: Lock content and collapse contracts

**Files:**
- Modify: `tests/topology-contract.test.ts`

**Steps:**

1. Project all five binding-artifact issue codes plus one actionable health
   issue; assert artifacts never enter row health while actionable text remains.
2. Inspect generated Swift: normal status has `.lineLimit(1)` and tail
   truncation, while the actionable health block has neither cap.
3. Persist collapse for one lane, republish the same live surfaces, and assert
   only that lane folds while topology metadata retains every live surface.

### Task 5: Wire and document the contract

**Files:**
- Modify: `package.json`
- Create: `docs/topology-contract.md`

**Steps:**

1. Add `"test:topology": "vitest run tests/topology-contract.test.ts"`.
2. Document each fixture, authoritative vs inconclusive evidence, the 5-second
   confirmation window, the CI path, and the local RED-proof procedure.
3. Run `bun run test:topology` and `git diff --check`.

### Task 6: Verify and deliver the PR

**Files:**
- All scoped test, script, and documentation files.

**Steps:**

1. Run `bun run typecheck`, `bun run build`, `bun run test`, and
   `git diff --check`; read full output and record exact counts.
2. Run bounded local CodeRabbit review and disposition actionable findings.
3. Commit only scoped files, push `test/topology-contract-ci`, and create a
   ready PR titled `test(topology): sidebar/registry topology-contract CI suite`.
4. Invoke reviewers, read CI/review results, iterate to a green reviewed PR,
   then post the URL plus revert proof to driver-buddy and store WHAT/WHY in
   BrainLayer.
