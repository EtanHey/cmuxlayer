# PR #418 Prompt Resolution Redirect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make cmuxlayer immediately clear confidently resolvable terminal menus while preserving and auditing escalation for genuine or unknown human decisions.

**Architecture:** `screen-parser.ts` provides a structural prompt disposition with an activity-first veto. `agent-engine.ts` executes only proven-safe resolutions through the live cmux route, verifies recovery with a fresh screen read, appends a durable `resolved_prompt` event, and sends every unproven or failed case through the existing blocked/escalation path.

**Tech Stack:** TypeScript, Bun, Vitest, cmux client abstraction, JSONL event log.

---

### Task 1: Specify the production sweep behavior

**Files:**
- Modify: `tests/sidebar-sync.test.ts`

**Step 1: Replace the wording matrix with one behavioral production-path test**

Create agents in a single `runSweep()` containing:

- a structurally proven `/model` picker and the captured Codex update menu, whose mocked screens change to ready only after Escape;
- the captured Claude permission confirmation and both AskUserQuestion fixtures, whose screens never change;
- an unclassified chooser, which must escalate rather than receive input;
- healthy ready and active-spinner panes, including an overlay-looking block under the spinner.

Assert that resolvable menus receive Escape, end unblocked, and append `resolved_prompt` recovery events; human/unknown decisions receive no key, remain blocked, and enter the existing escalation path; healthy/active panes receive neither action nor escalation.

**Step 2: Run the focused test and verify RED**

Run: `CMUXLAYER_FORCE_INPROCESS=1 bunx vitest run tests/sidebar-sync.test.ts -t "resolves safe prompt menus"`

Expected: FAIL because no resolution action or audit event exists and activity does not yet veto overlays.

### Task 2: Make prompt disposition structural and activity-first

**Files:**
- Modify: `src/screen-parser.ts`
- Modify: `tests/screen-parser.test.ts`

**Step 1: Add focused parser tests**

Assert that picker structure is recognized without question punctuation or harness prose, `/model` provenance/update-menu structure is resolvable, generic structured choosers remain unresolved/escalatable, and a live spinner produces busy control even when chooser chrome is visible.

**Step 2: Run parser tests and verify RED**

Run: `bunx vitest run tests/screen-parser.test.ts`

Expected: FAIL on the new structural and activity-veto assertions.

**Step 3: Implement the minimal parser disposition**

- Delete the `?`-anchored chooser rule and prompt-specific wording lists used for blocking classification.
- Detect chooser structure from selector/options or navigation chrome.
- Prove safe resolution only from `/model` command provenance/model-picker structure or the captured Codex update-menu structure.
- Make active spinner/working evidence win before prompt errors and control states.

**Step 4: Re-run parser tests and verify GREEN**

Run: `bunx vitest run tests/screen-parser.test.ts`

Expected: PASS.

### Task 3: Execute, verify, and audit safe resolution

**Files:**
- Modify: `src/agent-types.ts`
- Modify: `src/event-log.ts`
- Modify: `src/agent-engine.ts`
- Test: `tests/sidebar-sync.test.ts`
- Test: `tests/event-log.test.ts`

**Step 1: Add the `resolved_prompt` event contract**

Record timestamp, agent/surface/workspace, structural classification, sent key, outcome (`recovered` or `failed`), before/after control states, a bounded observation summary/signature, and error.

**Step 2: Implement immediate resolution in the sweep**

Before blocked-state persistence and dwell handling, send Escape through the freshly resolved stable agent route only for a proven-safe disposition. Read the pane again without the sweep cache. If it is no longer an overlay, clear prompt/halt state and append `recovered`; otherwise append `failed` and continue into the existing escalation branch without sending anything else.

**Step 3: Run the single production-path matrix and verify GREEN**

Run: `CMUXLAYER_FORCE_INPROCESS=1 bunx vitest run tests/sidebar-sync.test.ts -t "resolves safe prompt menus"`

Expected: PASS with safe menus recovered/audited, genuine and unknown decisions untouched/escalated, and active/healthy panes ignored.

### Task 4: Preserve existing accepted behavior

**Files:**
- Verify: `tests/sidebar-sync.test.ts`
- Verify: `tests/agent-registry.test.ts`
- Verify: `tests/agent-engine.test.ts`

**Step 1: Run focused regression suites**

Run: `bunx vitest run tests/screen-parser.test.ts tests/event-log.test.ts tests/agent-registry.test.ts tests/sidebar-sync.test.ts tests/agent-engine.test.ts`

Expected: PASS, including restart retention, escalation delivery, fallback sink, and missing-ancestor counter coverage.

**Step 2: Run full verification**

Run: `bun run test`

Run: `bun run pre-pr`

Run: `bun run build`

Run: `git diff --check`

Expected: all commands exit 0.

### Task 5: Publish the redirect

**Files:**
- Modify: `/Users/etanheyman/Gits/cmuxlayer/docs.local/plan/stability-v2/collab.md`

**Step 1: Commit the scoped delta**

Commit only the prompt-resolution parser, engine, event, test, and plan changes with the required agent/model trailer.

**Step 2: Push the existing branch**

Push `wt/prompt-freeze`; do not open or merge a PR because PR #418 already exists.

**Step 3: Post the verified head**

Append the exact pushed SHA, behavioral probe results, and verification evidence to the collaboration log.
