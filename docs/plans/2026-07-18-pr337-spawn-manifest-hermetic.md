# PR #337 Spawn-Manifest Hermeticity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the two spawn-manifest tests independent of filesystem-backed registry and lifecycle initialization work so they remain below Vitest's real watchdog under concurrent load.

**Architecture:** Add optional server-construction dependencies for state persistence, registry, and lifecycle initialization, with unchanged production defaults. Exercise the real spawn handler and manifest publisher over in-memory lifecycle state in the two tests.

**Tech Stack:** TypeScript, Vitest 3, Bun/Node, cmuxlayer `StateManager`, `AgentRegistry`, and `AgentEngine`.

---

### Task 1: Prove the manifest tests still touch lifecycle storage

**Files:**
- Modify: `tests/server-agent-tools.test.ts`

**Step 1: Add an in-memory lifecycle fixture contract**

Create an in-memory `StateManager` double with real record semantics, a real
`AgentRegistry` backed by it, a no-op lifecycle initializer, and a unique
nonexistent state path. Pass those dependencies through the server options via
a temporary structural cast so the test compiles before production accepts the
new fields.

**Step 2: Add hermeticity assertions**

In both manifest tests, keep the existing manifest assertions and additionally
assert that the lifecycle initializer was called once and the nonexistent state
directory was never created.

**Step 3: Verify RED**

Run both named manifest tests. Expected: FAIL because the current server ignores
the injected lifecycle state and creates the state directory.

### Task 2: Add the minimal production dependency seams

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-agent-tools.test.ts`

**Step 1: Accept injected lifecycle dependencies**

Add optional `stateManager`, `lifecycleRegistry`, and `lifecycleInitializer`
fields to `CreateServerOptions` and the initializer field to
`CmuxServerContext`. Use injected state/registry values in
`createServerContext`; preserve all existing defaults.

**Step 2: Route startup through the initializer**

Resolve the initializer from options/context and call it instead of
`engine.initialize(discovery)` only when supplied. Keep error capture,
`lifecycleStarted`, and sweep startup unchanged.

**Step 3: Remove obsolete fake-time driving**

Await the real hermetic spawn handler directly in the first manifest test.
Delete the fake-time helper if it has no remaining callers.

**Step 4: Verify GREEN**

Run both manifest tests, typecheck, and the complete server-tools file. Expected:
all pass; the exact manifest and launcher-name assertions are unchanged.

### Task 3: Prove the corrected load contract and publish

**Files:**
- Modify: PR #337 body/comment only

**Step 1: Run the concurrent four-file proof**

Start a fresh Vitest process for every iteration and run
`fleet-sidebar`, `agent-engine`, `server-agent-tools`, and
`proxy-version-bump` together at least 20 times. Record 20/20 and zero failures.

**Step 2: Run the full gate five times**

Run typecheck plus the full suite in five fresh processes. Record file/test
counts and zero failures for every run.

**Step 3: Review and update PR #337**

Run diff checks and bounded local review, commit only the follow-up scope, push
the same branch, invoke PR reviewers, and resolve real findings. Do not merge.

**Step 4: Report corrected SETTLED**

Paste the concurrent-load and five-suite evidence on PR #337, re-enumerate cmux
surface:143, send the new head and evidence to cmuxLead-v2, verify delivery, and
store WHAT + WHY.
