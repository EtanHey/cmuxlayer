# Halt Escalation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Notify the nearest live ancestor exactly once when a managed child remains alive but is awaiting input, idle without completion evidence, or wedged without observable progress.

**Architecture:** Extend the persisted `AgentRecord` with one halt-escalation opt-out and durable episode metadata. During the existing bound-screen pass in `AgentEngine.syncSidebar`, classify the reconciled live screen, advance/reset one episode record, resolve the nearest screen-live ancestor, and deliver the actionable alert through the existing `dispatchOnce` inbox path. Reuse `parseScreen`, transcript/session mtime, fleet screen-progress tracking, raw resume-command construction, and the existing inbox message vocabulary; do not add a second delivery engine or auto-act on the child.

**Tech Stack:** TypeScript, Vitest, cmuxlayer `AgentEngine`, persisted JSON agent records, `dispatchOnce`, real cmux managed-agent probes.

---

### Task 1: Specify persisted halt episodes

**Files:**
- Modify: `src/agent-types.ts`
- Modify: `src/state-manager.ts`
- Test: `tests/agent-engine.test.ts`

**Step 1: Write failing tests**

Add focused engine tests that construct real `AgentRecord`s and live parsed screens for:

- `awaiting_input` after its dwell threshold;
- `idle_without_done` only after prior working evidence and without terminal evidence;
- `wedged` only after the configured number of unchanged working sweeps;
- one inbox entry per continuous episode and a new entry only after recovery/reset;
- `halt_escalation: false` silence;
- healthy progressing work silence;
- nearest live ancestor routing when the direct parent is halted or dead.

Configure zero/short dwell and a small wedge sweep count through injected `AgentEngineOptions`; assert the exact tag and that the task contains child ID, surface, duration, last action, and the raw resume/unblock command.

**Step 2: Run the focused tests and verify RED**

Run: `bun test tests/agent-engine.test.ts -t "halt escalation"`

Expected: FAIL because halt episode fields/options and dispatch behavior do not exist.

**Step 3: Add the minimal schema**

Add:

- `AgentHaltType = "awaiting_input" | "idle_without_done" | "wedged"`;
- `halt_escalation?: boolean` (absence means enabled, `false` opts out);
- nullable episode class/start/notification/ancestor fields;
- observed sweep count and last observable progress timestamp.

Keep auto-discovered/default records enabled by omission and normalize legacy records without migration failure.

**Step 4: Re-run focused tests**

Expected: schema-only compile succeeds but behavior assertions remain RED.

### Task 2: Detect and dispatch on the existing sweep

**Files:**
- Modify: `src/agent-engine.ts`
- Test: `tests/agent-engine.test.ts`

**Step 1: Implement live classification**

After the existing coherent bound screen read and before archival/reaping:

- `awaiting_input`: `permission_prompt` or `interactive_overlay`;
- `idle_without_done`: live agent prompt is idle/ready, no transcript/screen DONE evidence, and persisted prior active observation exists;
- `wedged`: transcript/screen still claims an active turn, while both de-chromed screen and transcript progress remain unchanged for the configured sweep count.

Screen truth wins even when the registry row is terminal. Any healthy progress, explicit completion, shell/dead surface, or class transition resets/supersedes the prior episode.

**Step 2: Persist dwell and exactly-once state**

Use injected/env-configurable thresholds with conservative production defaults. Persist every episode transition before attempting delivery. Keep a delivered timestamp/ancestor on the row so daemon restarts cannot duplicate the same episode. If dispatch fails, leave the episode undelivered so a later sweep retries the same deterministic `dispatchOnce` ID.

**Step 3: Route upward and dispatch**

Walk `parent_agent_id` links. Read each ancestor's bound screen and skip shell/dead/awaiting/idle/wedged ancestors until the nearest live actionable ancestor is found. Deliver one inbox message tagged `agent_halt_<class>` with agent ID, surface, dwell/sweeps, last observable action, and exact raw resume command (or an explicit no-session fallback). Do not send input to the halted agent.

**Step 4: Run the focused tests and verify GREEN**

Run: `bun test tests/agent-engine.test.ts -t "halt escalation"`

Expected: all halt-escalation tests pass with zero failures.

### Task 3: Regression and static verification

**Files:**
- Verify: `src/agent-types.ts`
- Verify: `src/agent-engine.ts`
- Verify: `src/state-manager.ts`
- Verify: `tests/agent-engine.test.ts`

**Step 1: State prediction before suites**

Record the expected test/build outcome and likely pre-existing caveats before executing each broad suite.

**Step 2: Run targeted neighboring suites**

Run the agent-engine, agent-health, hierarchy, registry, and screen-parser tests.

**Step 3: Run repository verification**

Run the package's full test/typecheck/lint/build commands from `package.json`.

**Step 4: Diff actual results against the prediction**

Report exact test counts, failures, warnings, and any divergence. Inspect `git diff --check`, the full diff, and `git status`.

### Task 4: Real managed-agent probes

**Files:**
- Runtime evidence only; no committed fixture files
- Append final PR handoff to `docs.local/plan/stability-v2/collab.md`

**Step 1: Build/run the changed cmuxlayer without replacing the current backend unsafely**

Use a test-scoped state/inbox root and the real cmux connector. Record the literal absolute probe paths up front.

**Step 2: Verify two-column invariant**

Re-enumerate workspaces, panes, surfaces, and managed agents before spawning. Parent/lead stays left and probe workers land as tabs in the right worker column.

**Step 3: Exercise four live cases**

Park real children at:

1. an approval/input prompt;
2. idle after observable work without DONE;
3. a foreground watch/tool call whose output stops advancing;
4. healthy advancing work.

For each halted case, inspect the parent inbox and prove one matching actionable message only. For healthy work, prove zero halt messages. Re-run a sweep beyond dwell to prove no duplicate.

**Step 4: Clean up literally**

Stop every probe agent/surface and remove only the predeclared absolute test paths. Re-enumerate topology to confirm no probe pane/artifact remains.

### Task 5: Publish worker endpoint

**Files:**
- Append: `docs.local/plan/stability-v2/collab.md`

**Step 1: Pre-commit gate**

Run a bounded local CodeRabbit review if available, address critical findings, rerun fresh verification, and inspect sanitization/status.

**Step 2: Commit and push**

Read the live Codex session metadata for the identity trailer, commit the scoped files, and push `wt/halt-escalation`.

**Step 3: Open a signed ready PR**

Create a non-draft PR with summary, exact automated test results, live probe receipts, and the required live-session signature. Do not spawn reviewers and do not merge.

**Step 4: Handoff**

Verify the PR URL/state/head SHA, append the URL and concise summary to `docs.local/plan/stability-v2/collab.md`, and stop at the worker endpoint.
