# Persist Deferred Transcript Capture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve first-connect transcript capture intent across terminalization, daemon restart, startup purge, and a transient identity-write failure without scanning transcripts during startup.

**Architecture:** Store an optional deferred-capture marker on `AgentRecord`. Use a dedicated atomic `StateManager` mutation to set the marker without changing `version` or `updated_at`; capture writes identity and clears the marker together through the normal atomic record update. Startup purge retains marked rows, while normal sweeps resolve structurally eligible markers for at most three failed calls and clear structurally ineligible markers without invoking the resolver.

**Review amendment:** Persist a failed-resolver attempt count beside the marker. Clear after three failed calls across restarts, or immediately when JSONL/managed-launch transcript context is structurally ineligible, so normal confirmed-absence cleanup can reap the row. Identity-write failures do not consume the resolver cap.

**Tech Stack:** TypeScript, Bun, Vitest, JSON state files with atomic temp-file rename.

---

### Task 1: Specify restart and retry behavior

**Files:**
- Modify: `tests/agent-registry.test.ts`
- Modify: `tests/sidebar-sync.test.ts`

**Step 1: Add a focused first-connect regression**

Add `persists deferred transcript capture across restart and identity-write failure`. Create a managed sessionless record that terminalizes during first-connect. Use a resolver returning a complete captured identity:

```ts
const capturedSessionId = "12345678-1234-4234-8234-123456789abc";
const deferredTranscriptResolver = vi.fn(() => ({
  session_id: capturedSessionId,
  path: "/tmp/codex-session.jsonl",
}));
```

After `initialize()`, assert the resolver was not called and the terminal record is sessionless with `transcript_session_capture_deferred: true`. Dispose the engine, recreate it from the same `StateManager`, and initialize again before any normal sweep.

Spy on `stateMgr.updateRecord` and throw exactly once when the patch contains the captured session ID. Remove the original pane while leaving an unrelated live surface as authoritative absence evidence. Run one sweep and assert the resolver was called without a live binding but the record remains sessionless and marked. Restore the spy, run a later sweep, then assert the canonical record has the captured ID/path and `transcript_session_capture_deferred: false`.

Add a registry regression proving both normal surfaceless eviction and terminal purge retain a marked row.

**Step 2: Verify RED on release main**

Run:

```bash
env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bunx vitest run tests/sidebar-sync.test.ts -t "persists deferred transcript capture across restart and identity-write failure"
```

Expected: FAIL because v0.4.15 neither persists the marker nor retains/retries the terminal record after restart.

### Task 2: Implement the durable marker

**Files:**
- Modify: `src/agent-types.ts`
- Modify: `src/state-manager.ts`
- Modify: `src/agent-engine.ts`
- Modify: `src/agent-registry.ts`
- Modify: `tests/agent-registry.test.ts`

**Step 1: Add the optional record field**

Add to `AgentRecord`:

```ts
/** First-connect skipped transcript identity resolution; retry on sweeps. */
transcript_session_capture_deferred?: boolean;
```

**Step 2: Add an age-neutral state mutation**

Add `StateManager.setTranscriptSessionCaptureDeferred(agentId, deferred, attempts)`. It reads the current record, returns early if both values are unchanged, atomically replaces the marker and persisted attempt count through `state.json.tmp` plus rename, updates the surface-session index, and returns the record. The mutation supports increment, reset, and clear without incrementing `version`, changing `updated_at`, or appending a lifecycle event.

**Step 3: Route capture through the marker**

In `maybeCaptureBootSessionId()`:

- Clear a stale marker age-neutrally when a record already has `cli_session_id`.
- On first-connect (`resolveTranscript: false`), set the marker for transcript-eligible sessionless records.
- On normal sweeps, resolve when ordinary eligibility is true or the durable marker is true.
- Successful capture clears the marker and attempt count only inside `finalizeCapturedSession()`.
- Structural ineligibility and the terminal three-failure budget clear both fields through the age-neutral atomic mutation.
- Preserve the marker when resolver or identity persistence throws before either terminal condition; identity-write failures do not consume the resolver budget.

In `finalizeCapturedSession()`, include `transcript_session_capture_deferred: false` in the same `updateRecord()` patch as `cli_session_id` and `cli_session_path`, including the existing-canonical-row path.

In `purgeStartupTerminalAgents()`, add marked registry rows to `retainAgentIds` before purging.

After the pending one-shot startup purge has retained marked rows, but before normal absence cleanup, retry those rows independently of live surface binding. Both `evictSurfaceless()` and `purgeTerminal()` retain marked rows and reset their absence confirmation evidence; ordinary cleanup resumes after the atomic capture clears the marker. Add a regression proving an immediate successful first-sweep capture is not deleted by the pending startup purge.

**Step 4: Verify GREEN**

Run the focused command from Task 1. Expected: one passing test.

### Task 3: Prove lifecycle-age and resync compatibility

**Files:**
- Verify: `tests/sidebar-sync.test.ts`
- Verify: `tests/resync-tool.test.ts`

**Step 1: Run both affected suites**

```bash
env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bunx vitest run tests/sidebar-sync.test.ts tests/resync-tool.test.ts
```

Expected: all tests pass. The existing booting-ghost eviction regression proves that marker persistence did not refresh lifecycle age.

**Step 2: Inspect the implementation diff**

```bash
git diff --check
git status --short
git diff --stat
git diff
```

Confirm no startup resolver call was added, no timeout changed, and no unrelated file was modified.

**Step 3: Commit the implementation**

```bash
git add docs/plans/2026-07-17-persist-deferred-capture.md src/agent-types.ts src/state-manager.ts src/agent-engine.ts tests/sidebar-sync.test.ts
git commit -m "fix(lifecycle): persist deferred session capture"
```

### Task 4: Run the full gate and worker PR loop

**Files:**
- Review all branch changes against `origin/main`.

**Step 1: Run the exact full gate**

```bash
bun run typecheck && env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bun run test
```

Expected: typecheck and the full suite exit zero. Record the actual file and test counts reported by the gate output.

**Step 2: Run bounded local review**

Run `coderabbit review --agent` with a three-minute bound. Address substantive findings. If the OSS limit blocks review, record that limitation and rely on fresh test evidence plus PR-level reviewers.

**Step 3: Push and open a ready PR**

Push `feat/persist-deferred-capture`, create a non-draft PR against `main`, include the actual gate summary and the baseline `doctor.test.ts` flake/retry evidence, then invoke CodeRabbit, Codex, and Cursor/Bugbot.

**Step 4: Process reviews and CI**

Wait at least 120 seconds before the first review check. Read all PR comments and inline findings, fix real issues with focused tests, push, and request re-review. Do not merge.

**Step 5: Report**

Re-enumerate cmux surfaces, deliver the final PR URL and test count to cmuxLead-v2 on `surface:143`, store the WHAT+WHY milestone in BrainLayer, and stop with `TASK_DONE`.

### Task 5: Bound never-resolving markers (independent review RED)

**Files:**
- Modify: `src/agent-types.ts`
- Modify: `src/state-manager.ts`
- Modify: `src/agent-engine.ts`
- Modify: `tests/state-manager.test.ts`
- Modify: `tests/sidebar-sync.test.ts`

**Step 1: Verify RED**

Add a persisted terminal marked row whose resolver always returns `null`. Run sweeps across an engine restart and assert the resolver is called at most three times and the row is subsequently reaped. Add a structurally ineligible marked row and assert it clears without a resolver call. Add a state-manager assertion that the attempt count persists without changing lifecycle age or emitting an event.

**Step 2: Implement the bounded marker**

Persist `transcript_session_capture_attempts` in the age-neutral marker mutation. Count resolver `null`/throw outcomes, clear atomically at three, reset on successful capture, and leave the count unchanged when identity persistence fails. Split lifecycle eligibility from structural transcript context so a terminal JSONL row can use its bounded marker override while unsupported/malformed context clears immediately.

**Step 3: Verify GREEN and run the full gate**

Run the focused state-manager/sidebar regressions, then the exact full typecheck and test gate. Push to the existing PR branch, request re-review, process CI/review findings, and do not merge.
