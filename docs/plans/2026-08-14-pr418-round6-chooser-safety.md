# PR #418 Round 6 Chooser Safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every live chooser fail closed unless its own active option set proves it is a safe model/update menu, and independently prevent approval-shaped screens from reaching the key or audit paths.

**Architecture:** Replace the separate approval/update/model ordering with one active-chooser analysis result. The analyzer normalizes bordered chooser lines, extracts only the current option set, identifies consent or unexplained human-decision structure, permits model/update resolution only from those active options, and classifies every residual chooser as escalation. `AgentEngine` performs a separate raw-screen safety preflight before sending Escape and repeats it before appending `resolved_prompt`, so classifier error cannot produce a key or a laundering audit entry.

**Tech Stack:** TypeScript, Bun, Vitest, `AgentEngine.runSweep()`/`syncSidebar`, JSONL event log.

---

### Task 1: Pin the full Round 6 attack set red

**Files:**
- Modify: `tests/screen-parser.test.ts`
- Modify: `tests/sidebar-sync.test.ts`

**Step 1: Add ATK1/ATK2/ATK3/ATK4/ATK8 and residual cases**

Copy the reviewer's five exact screens into the parser classifier regression and the existing production `runSweep()` matrix. Add the reworded Codex update chooser and bordered picker as residual escalation cases.

**Step 2: Assert the complete safety ledger**

For each decision/residual case assert escalation, `blocked_on_prompt=true`, no `resolved_prompt` event, and an empty per-surface key ledger. Preserve the safe R1/R2/R3 recovery/audit assertions and the moving/static activity pair.

**Step 3: Run focused tests and verify RED**

Run: `CMUXLAYER_FORCE_INPROCESS=1 bunx vitest run tests/screen-parser.test.ts tests/sidebar-sync.test.ts -t "classifies prompt handling from structure|resolves safe prompt menus"`

Expected: the five attacks receive Escape; R4/E8 remain unblocked and un-escalated.

### Task 2: Make active option structure the only resolve authority

**Files:**
- Modify: `src/screen-parser.ts`
- Test: `tests/screen-parser.test.ts`

**Step 1: Normalize and extract the live chooser**

Strip box borders for chooser analysis, find the current selector attached to its footer/tail option run, and expose the active option texts plus preceding header/provenance lines. Do not use arbitrary scrollback as option evidence.

**Step 2: Classify consent and human-decision structure first**

Treat an active option set containing at least two approval/consent actions as unsafe whatever `/model`, GPT rows, update banners, or CLI identity appear elsewhere. A Codex no-echo model picker is safe only when its active options are models and no unexplained decision header precedes them.

**Step 3: Permit only active model/update option sets**

Resolve `/model` only when at least two active chooser options are model names. Resolve the captured update menu only when its live selected/sibling options are the update actions; stale update chrome above a different active chooser cannot resolve.

**Step 4: Escalate every residual chooser**

Recognize bordered numbered pickers and Codex tail choice pairs as chooser structure. Once a live chooser exists, return either safe resolve or escalation—never `none`.

**Step 5: Run parser tests and verify GREEN**

Run: `bunx vitest run tests/screen-parser.test.ts`

Expected: R1/R2/R3 resolve; all attacks and residuals escalate; activity classification remains unchanged.

### Task 3: Add the independent key/audit write barrier

**Files:**
- Modify: `src/agent-engine.ts`
- Modify: `src/screen-parser.ts`
- Test: `tests/sidebar-sync.test.ts`

**Step 1: Export a raw-screen resolution-safety predicate**

The predicate reads active chooser structure directly and does not accept a `PromptDisposition`. It returns false for consent/human/residual/mismatched-option screens.

**Step 2: Refuse Escape before mutation**

Call the predicate at the start of `maybeResolvePrompt`. On refusal, record the unchanged-screen resolution failure guard and return unrecovered so the existing caller converts the case to escalation without sending a key.

**Step 3: Refuse unsafe audit writes independently**

Call the raw predicate again inside `appendResolvedPromptEvent`; do not append if the screen is unsafe. Add a direct regression that invokes the audit boundary with a deliberately forged resolve disposition over an approval chooser and proves no event is written.

**Step 4: Run the production matrix and reviewer probe**

Run: `CMUXLAYER_FORCE_INPROCESS=1 bunx vitest run tests/sidebar-sync.test.ts -t "resolves safe prompt menus"`

Run: `CMUXLAYER_FORCE_INPROCESS=1 bun /Users/etanheyman/Gits/cmuxlayer/docs.local/tasks/pr418-round5-probe/probe-r5.mjs`

Expected: R1/R2/R3 resolve and audit; R4 escalates rather than resolves; all 16 untouched cases escalate with zero keys; E8 escalates; H1/H2 remain clean and H3 remains blocked.

### Task 4: Verify and publish the existing PR branch

**Files:**
- Modify after push: `/Users/etanheyman/Gits/cmuxlayer/docs.local/plan/stability-v2/collab.md`

**Step 1: Run complete verification**

Run the focused seven-file suite, `bun run test`, `bun run pre-pr`, `bun run build`, `git diff --check`, and the preserved reviewer probe. Read every summary and report exact counts.

**Step 2: Commit and push**

Commit only the scoped parser, engine, tests, and plan with the live-model trailer. Push `wt/prompt-freeze`; do not spawn a reviewer, create another PR, or merge.

**Step 3: Verify and record the exact head**

Require local HEAD, `origin/wt/prompt-freeze`, and PR #418 `headRefOid` to match. Append the exact SHA, key-ledger counts, optional gaps, and verification counts to the collaboration log.
