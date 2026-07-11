# Suite Determinism Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the cold-run and parallel Vitest flake without retries, suite serialization, or production timeout changes.

**Architecture:** Keep product code unchanged and repair the test harness. Timing-sensitive tests will advance a fake clock, routing-only lifecycle engines will have their sweeps stopped, and every created lifecycle server will be closed during teardown.

**Tech Stack:** TypeScript, Vitest 3, Bun, Node timers.

---

### Task 1: Make enter-reliability timing deterministic

**Files:**
- Modify: `tests/enter-reliability.test.ts`

**Step 1: Preserve the failing reproduction**

Run the three files under default file parallelism and retain the observed failure
in the generic slow-clearing composer case as the RED evidence.

**Step 2: Add a fake-timer driver**

Import `vi`, enable fake timers with a fixed system time in `beforeEach`, add an
async helper that advances timers while a tool-handler promise runs, and restore
real timers in `afterEach`.

**Step 3: Stop irrelevant lifecycle sweeps**

After `createServer`, access the test-exposed lifecycle engine and call
`dispose()`. Continue using its registry and routing methods in each test.

**Step 4: Verify GREEN**

Run:

```bash
bunx vitest run tests/enter-reliability.test.ts --reporter=verbose
```

Expected: all tests pass without real five-second waits or sweep errors.

### Task 2: Isolate inbox lifecycle resources

**Files:**
- Modify: `tests/inbox-nudge.test.ts`

**Step 1: Close every created server**

Make `afterEach` async and call `await server.close()` before deleting its state
and inbox directories. When a test replaces `server`, close the original first.

**Step 2: Verify isolation**

Run:

```bash
bunx vitest run tests/inbox-nudge.test.ts --reporter=verbose
```

Expected: all tests pass and no lifecycle server survives teardown.

### Task 3: Remove server-test wall-clock polling

**Files:**
- Modify: `tests/server.test.ts`

**Step 1: Convert measured offenders to fake time**

For `spawn_in_workspace`, boot-prompt send/cleared-composer cases, and the
full-deadline pending `new_split` case, start the handler promise, advance the
existing `advanceTimers` helper beyond the relevant deadline, then await the
result.

**Step 2: Verify the formerly flaky files together**

Run:

```bash
bunx vitest run tests/enter-reliability.test.ts tests/server.test.ts tests/inbox-nudge.test.ts --reporter=verbose
```

Expected: 177 tests pass under default file parallelism with no timing failure.

### Task 4: Prove determinism and publish

**Files:**
- Modify: PR body only

**Step 1: Run ten isolation processes**

Run the three formerly flaky files ten times, starting a new Vitest process for
each iteration, and capture every summary.

**Step 2: Run five cold full-suite processes**

Run `bun run test` five times, starting a fresh process for each iteration, and
capture every summary.

**Step 3: Run static verification**

Run `bun run typecheck` and `bun run build`.

**Step 4: Review and publish**

Review the diff, run the required pre-commit reviewer, commit, push, and open a
ready-for-review PR titled `test: make the suite deterministic (fix cold-run/parallel flake)`.
Include the root cause, design, all ten isolation summaries, all five full-suite
summaries, typecheck, and build results in the PR body. Complete the bot-review
loop before merging.
