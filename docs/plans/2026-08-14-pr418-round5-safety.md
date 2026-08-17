# PR #418 Round 5 Safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make destructive and ambiguous confirmations impossible to auto-resolve while retaining safe menu recovery and requiring observed motion before chooser activity can veto escalation.

**Architecture:** `screen-parser.ts` will classify the active terminal control from the innermost live chooser block, with approval structure taking absolute precedence over safe-menu provenance. `agent-engine.ts` will treat a chooser as moving only when an explicit current progress indicator is present and the bound screen observation changes across sweeps; static tool glyphs and quoted activity strings provide no veto. Existing resolution, audit, restart-retention, and escalation paths remain unchanged around those gates.

**Tech Stack:** TypeScript, Bun, Vitest, `AgentEngine.runSweep()`/`syncSidebar`, JSONL event log.

---

### Task 1: Reproduce the destructive-confirm safety failures

**Files:**
- Modify: `tests/sidebar-sync.test.ts`
- Modify: `tests/screen-parser.test.ts`

**Step 1: Add E3/E4 and modern Claude confirm cases**

Extend the production redirect matrix with the reviewer's exact E3 and E4 screens: a destructive approval below stale model-picker scrollback and a force-push approval below document content listing two numbered GPT models. Add the modern Claude permission screen with a pending `Bash(...)` tool line and the quoted `esc to interrupt` variant.

For every escalate case, assert its surface has an empty key ledger, not only that an escalation event exists. Parser assertions must require E3/E4 and modern Claude confirms to classify as escalation, never resolution or activity.

**Step 2: Run the focused tests and verify RED**

Run: `CMUXLAYER_FORCE_INPROCESS=1 bunx vitest run tests/sidebar-sync.test.ts -t "resolves safe prompt menus"`

Run: `bunx vitest run tests/screen-parser.test.ts -t "classifies prompt handling"`

Expected: E3/E4 receive Escape and modern Claude permission screens are hidden by the activity branch.

### Task 2: Make approval precedence and live picker scope structural

**Files:**
- Modify: `src/screen-parser.ts`
- Test: `tests/screen-parser.test.ts`

**Step 1: Extract the active option run attached to a picker footer**

Find the nearest selected option above the active navigation footer and inspect only the option rows between that selector and footer. Do not search the full 32-line scrollback window for model rows.

**Step 2: Detect approval structure before all other dispositions**

Treat binary confirmation footers and a current chooser attached to a pending action/tool block as approval structure. Return `permission_prompt` escalation before update-menu, model-menu, generic chooser, or activity logic. A screen containing both approval and model shapes is ambiguous and therefore escalates untouched.

**Step 3: Remove static activity false signals**

Remove pending Claude tool lines and unanchored `esc to interrupt` text from active-work detection. Keep only explicit current progress/spinner patterns.

**Step 4: Run parser tests and verify GREEN**

Run: `bunx vitest run tests/screen-parser.test.ts`

Expected: E3/E4 and modern permission prompts escalate; actual model/update menus still resolve; quoted activity text is inert.

### Task 3: Require cross-sweep motion for the chooser veto

**Files:**
- Modify: `src/screen-parser.ts`
- Modify: `src/agent-engine.ts`
- Test: `tests/sidebar-sync.test.ts`

**Step 1: Expose explicit visible-progress evidence**

Add a parser helper that reports only current anchored spinner/working evidence. It must return false for pending tool glyphs and quoted activity strings.

**Step 2: Combine progress evidence with changed observations**

In `maybeEscalateLiveHalt`, permit an interactive chooser veto only when explicit visible-progress evidence exists and the raw bound-screen signature differs from the preceding sweep. Approval disposition is never eligible for this veto.

On the first observation, retain the existing progress signature; on an advancing second observation, clear `blocked_on_prompt` and the halt episode. An unchanged spinner remains a blocked/wedged candidate.

**Step 3: Run the production matrix and verify GREEN**

Run: `CMUXLAYER_FORCE_INPROCESS=1 bunx vitest run tests/sidebar-sync.test.ts -t "resolves safe prompt menus"`

Expected: safe menus alone receive Escape and truthful `resolved_prompt` events; every human/approval/ambiguous case has zero keys and escalates; only the advancing-spinner chooser is ignored after two observations.

### Task 4: Re-run the reviewer acceptance shapes and regressions

**Files:**
- Verify: `/Users/etanheyman/Gits/cmuxlayer/docs.local/tasks/pr418-round4-probe/probe-r4.mjs`

**Step 1: Build and run the preserved production probe**

Run: `bun run build`

Run: `CMUXLAYER_FORCE_INPROCESS=1 bun /Users/etanheyman/Gits/cmuxlayer/docs.local/tasks/pr418-round4-probe/probe-r4.mjs`

Expected mandatory rows: E1/E2/E3/E4/E5/E6/E7/E9 all have zero keys, are blocked, and escalate; R1/R2/R3 recover and audit truthfully. The preserved probe's H1/H2 inputs are static screenshots, so under Round 5 they remain blocked without sending keys; the production matrix supplies the required advancing-screen counterpart and proves its veto only after observed motion. R4/E8 remain disclosed optional gaps from the brief.

**Step 2: Run focused regressions**

Run: `bunx vitest run tests/agent-discovery.test.ts tests/inbox-nudge.test.ts tests/screen-parser.test.ts tests/event-log.test.ts tests/agent-registry.test.ts tests/sidebar-sync.test.ts tests/agent-engine.test.ts`

Expected: PASS, preserving restart retention, launcher-title recovery, escalation delivery, and resolution audit behavior.

### Task 5: Verify and publish

**Files:**
- Modify after push: `/Users/etanheyman/Gits/cmuxlayer/docs.local/plan/stability-v2/collab.md`

**Step 1: Run full verification**

Run: `bun run test`

Run: `bun run pre-pr`

Run: `bun run build`

Run: `git diff --check`

Expected: all commands exit 0.

**Step 2: Commit and push the existing PR branch**

Commit only the scoped parser, engine, tests, and plan with the required live-model trailer. Push `wt/prompt-freeze`; do not create, review, or merge a PR.

**Step 3: Record the exact remote head**

Verify local HEAD, `origin/wt/prompt-freeze`, and PR #418 `headRefOid` match, then append exact counts and SHA to the collaboration log.
