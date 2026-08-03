# Channel Marker Reaper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop pending channel-marker leakage at identity finalization, safely reap retained orphans,
and prevent Vitest from writing mocked spawn channels into live user state.

**Architecture:** Keep marker lifecycle logic in `src/inbox.ts`; let `AgentEngine` provide the
authoritative known-agent snapshot and the successful pending-to-real transition hook. Give implicit
Vitest inbox writes a process-scoped temporary root in `src/server.ts`.

**Tech Stack:** TypeScript, Node filesystem APIs, Vitest, cmuxlayer `AgentEngine` lifecycle.

---

### Task 1: Marker safety primitives

**Files:**
- Modify: `tests/inbox.test.ts`
- Modify: `src/inbox.ts`

1. Add failing tests for transition cleanup, retention, known-agent protection, non-pending
   protection, and bounded repeated cleanup.
2. Run `npx vitest run tests/inbox.test.ts` and confirm the new API is missing.
3. Implement strict pending-id parsing, safe unlink, and a concise reaper result.
4. Re-run the focused test and confirm it passes.

### Task 2: Pending-to-real cleanup and periodic backlog reaping

**Files:**
- Modify: `tests/agent-engine.test.ts`
- Modify: `src/agent-engine.ts`

1. Add a failing lifecycle test that creates a pending marker, finalizes a real session id, and
   expects only the pending marker to disappear.
2. Run the focused test and confirm the pending marker remains before implementation.
3. Call marker cleanup after each successful pending identity rename and add a time-gated backlog
   pass using known registry plus persisted ids.
4. Run the focused engine tests and the inbox tests.

### Task 3: Stop the active Vitest leaker

**Files:**
- Modify: `tests/server.test.ts`
- Modify: `src/server.ts`

1. Add a failing test proving an implicit Vitest inbox path uses an isolated process-temporary
   directory.
2. Run the test and verify it exposes the live-home fallback.
3. Route implicit Vitest inbox state to a process-scoped temporary directory; preserve explicit
   `inboxBaseDir`, injected state-manager paths, and the production default.
4. Run server, inbox, and engine focused tests. Confirm a full suite creates zero new live markers.

### Task 4: Verification and live cleanup

**Files:**
- Verify all modified files and tests.

1. Run typecheck, build, focused tests, and the full suite with isolated `TMPDIR`.
2. Run the reaper in dry-run mode against live state and verify every candidate satisfies the safety
   rule; then execute the authorized backlog cleanup.
3. Recount `.channel-dirs`, measure 24 marker lookups and `list_agents`, and verify a successful managed
   spawn exists whose timestamp predates the saturated-directory measurement.
4. Re-read the diff and requirement checklist before committing.

### Task 5: PR loop

**Files:**
- Commit only the plan, source, and tests owned by this lane.

1. Run bounded local CodeRabbit review, commit, and push without bypassing hooks.
2. Open a ready-for-review PR with before/after counts, latency evidence, safety rule, active-leaker
   root cause, and baseline RED disclosure.
3. Request the routed Codex review, read all feedback, address blocking findings, and request re-review.
4. Merge with a merge commit only after the review loop and checks are clean; verify the remote merge.
5. Update FLEET-STANDING for `@orc` and `@cmuxlayer` with the PR URL and verified measurements.
