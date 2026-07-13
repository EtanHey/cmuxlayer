# Echo Reinjection P0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure `spawn_agent` emits a repoGolem launcher command exactly once when the transport loses or delays the acknowledgement for the initial pane write.

**Architecture:** Keep pane creation and launcher submission separate. Treat a retryable launcher-text write failure as ambiguous: observe the pane for the already-applied command, but never replay that non-idempotent text mutation. If the command cannot be observed, fail explicitly so a caller can retry on a fresh pane instead of concatenating two launchers.

**Tech Stack:** TypeScript, cmux CLI/socket clients, Vitest fixtures and integration tests.

---

### Task 1: Preserve the real surface 530 recurrence

**Files:**
- Create: `tests/fixtures/spawn/surface-530-stale-probe-double-emit.json`
- Modify: `tests/server.test.ts`

**Step 1: Add the captured shell command and clean same-pane comparison**

Record the verbatim corrupt command `skillcreatorCodex -sskillcreatorCodex -s`, the intended launcher, and the later clean manual command from the mission capture.

**Step 2: Write a failing replay test**

Model a launcher write that reaches the pane but loses its response. Return one stale shell screen before exposing the pending launcher on the next read.

**Step 3: Run the focused test and verify RED**

Run: `bunx vitest run tests/server.test.ts -t "surface-530"`

Expected: FAIL because v0.4.5 sends the launcher twice and submits the concatenated command.

### Task 2: Make launcher text delivery at-most-once

**Files:**
- Modify: `src/server.ts` (`sendChunkWithRetry` launcher ambiguity branch)
- Test: `tests/server.test.ts`

**Step 1: Observe rather than replay**

On a retryable `spawn_agent` text-write error, perform bounded screen observations for the pending launcher. Return success if it becomes visible. If it does not, throw an explicit ambiguous-write error without issuing a second text write.

**Step 2: Run the focused test and verify GREEN**

Run: `bunx vitest run tests/server.test.ts -t "surface-530"`

Expected: PASS with one launcher send and one submitted launcher command.

**Step 3: Re-run the adjacent historical regressions**

Run: `bunx vitest run tests/server.test.ts -t "surface-489|sandbox launcher-name injection|Codex update|relaunch"`

Expected: PASS for the #306/#308/#310 launcher update, submit, and relaunch cases.

### Task 3: Verify and deliver

**Files:**
- Verify: `src/server.ts`
- Verify: `tests/server.test.ts`
- Verify: `tests/fixtures/spawn/surface-530-stale-probe-double-emit.json`

**Step 1: Run repository verification**

Run: `bun run typecheck`

Run: `bun run test`

Expected: all checks pass.

**Step 2: Run the live client gate**

Build/install the branch for a fresh 0.4.x client session, spawn `skillcreatorCodex`, and immediately capture `read_screen(raw=true)`. The shell history must contain one `skillcreatorCodex -s` emission and no concatenated copy.

**Step 3: Complete the PR loop**

Commit the focused source, fixture, test, and plan changes; push `fix/echo-reinjection-p0`; open the required ready-for-review PR; invoke reviewers; address findings; verify CI; and post the PR URL plus the exact injection point to the driver-buddy channel and in-pane.
