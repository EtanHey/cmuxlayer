# Fix #333 Resync Convergence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove real-filesystem transcript scans from lifecycle startup, make production-server tests hermetic, and apply Etan's 400,000-token gpt-5.6 app-tier ruling.

**Architecture:** Treat transcript identity discovery as deferred sweep work. First-connect sidebar sync keeps topology and screen-based work but does not call the transcript resolver. Test server factories inject a no-op resolver by default. The explicit gpt-5.6 rule stays model-specific at 400,000 with its JSONL-floor behavior.

**Tech Stack:** TypeScript, Bun, Vitest, MCP server lifecycle tests.

---

### Task 1: Specify the startup boundary

**Files:**
- Modify: `tests/sidebar-sync.test.ts`
- Modify: `src/agent-engine.ts`

**Step 1: Write the failing regression**

Extend the idempotent-startup lifecycle test with an eligible discovered Codex record and a resolver spy. Assert `initialize()` does not call the spy, then call `runSweep()` and assert it does. Cover a record that reaches `done` during first-connect so terminalization cannot discard the deferred lookup, without increasing the approved 2,210-test suite count.

**Step 2: Run the focused test to verify RED**

Run: `env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET npx vitest run tests/sidebar-sync.test.ts -t "discovers live seats once and defers transcript capture beyond startup"`

Expected: FAIL because first-connect `syncSidebar()` currently invokes the resolver.

**Step 3: Implement the minimal boundary**

Add an optional transcript-resolution flag to `maybeCaptureBootSessionId()`. Pass it as disabled only from `syncSidebar({ firstConnect: true })`; retain eligible deferred rows across terminalization and the startup terminal purge, then clear the deferral after capture. Leave normal sweeps and explicit capture enabled.

**Step 4: Run the focused test to verify GREEN**

Run the same command and expect one passing test.

### Task 2: Make real-server tests structurally hermetic

**Files:**
- Modify: `tests/resync-tool.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/server-agent-tools.test.ts`

**Step 1: Add no-op defaults in test factories**

Set `sessionIdentityResolver` to the caller's explicit resolver or `() => null` in each production-server helper before either context or server construction.

**Step 2: Preserve explicit resolver coverage**

Use nullish-coalescing defaults so tests that intentionally inject a resolver continue exercising it.

**Step 3: Run the affected suites**

Run: `env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET npx vitest run tests/resync-tool.test.ts tests/server-agent-tools.test.ts tests/server.test.ts`

Expected: all tests pass without reading the host transcript tree.

### Task 3: Apply the 400,000-token gpt-5.6 ruling

**Files:**
- Modify: `tests/harness-session.test.ts`
- Modify: `tests/screen-parser.test.ts`
- Modify: `src/harness-session.ts`
- Modify: `src/screen-parser.ts`

**Step 1: Change expectations first**

Update gpt-5.6 expectations from 1,050,000 to 400,000, including percentage expectations for the stale-JSONL-floor case. Add wording that distinguishes the app-tier ruling from the superseded value.

**Step 2: Run focused window tests to verify RED**

Run: `env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET npx vitest run tests/harness-session.test.ts tests/screen-parser.test.ts`

Expected: gpt-5.6 assertions fail against the old production constants.

**Step 3: Update production rules and provenance**

Keep the explicit gpt-5.6 `jsonlFloor: true` rule, set it to 400,000, update the screen fallback, and retain/add both dated attribution sources in comments.

**Step 4: Re-run focused window tests to verify GREEN**

Run the same command and expect both files to pass.

### Task 4: Verify the full approved batch

**Files:**
- Review all changed files and `git diff`

**Step 1: Run targeted regression suites**

Run: `env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET npx vitest run tests/sidebar-sync.test.ts tests/resync-tool.test.ts tests/harness-session.test.ts tests/screen-parser.test.ts`

**Step 2: Run the exact full gate**

Run: `bun run typecheck && env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bun run test`

Expected: typecheck exits zero and the suite reports 2,210/2,210 tests passing.

**Step 3: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat && git diff`

Confirm no diagnostics or unrelated files remain.

### Task 5: Complete the worker PR loop

**Files:**
- Commit all approved source, test, and plan files.

**Step 1: Run bounded pre-commit review**

Run `coderabbit review --agent` with a bounded wait. Address substantive findings or record tool unavailability.

**Step 2: Commit and push**

Create intentional commits on `fix/333-resync-convergence`, then push the branch without merging.

**Step 3: Open a ready PR**

Include the exact #333 causality audit, production boundary rationale, hermeticity audit, gpt-5.6 dual attribution, and the real 2,210/2,210 gate summary.

**Step 4: Invoke and process reviewers**

Request available bot reviews, wait the required interval, inspect every response, and fix or explicitly reply to actionable high-severity findings.

**Step 5: Report to cmuxLead-v2 and BrainLayer**

Re-enumerate cmux agents before reporting the ready PR URL and test count to cmuxLead-v2. Store the implementation decision and milestone in BrainLayer; if storage remains unavailable, update the local fallback honestly.

**Step 6: Stop without merging**

Return the PR URL, verification evidence, review status, and a clear `TASK_DONE` signal. cmuxLead-v2 owns merge.
