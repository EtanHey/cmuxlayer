# PR #418 Auto-Resolve Freeze Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship prompt detection while making autonomous prompt keypresses impossible by default.

**Architecture:** Add one experimental `AgentEngine` policy switch backed by `CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE=1`. The default-off path preserves prompt classification but converts every `resolve` disposition into the existing blocked/escalation path before any resolver code can run; the flag-on path retains the existing resolver unchanged.

**Tech Stack:** TypeScript, Vitest, Bun, `AgentEngine` production sweep probes.

---

### Task 1: Specify the default-off safety boundary

**Files:**
- Modify: `tests/sidebar-sync.test.ts`

1. Add a production-sweep regression covering both normally resolvable menus and the reviewer’s destructive `Apply`/`Abort` attack.
2. Assert the default-off key ledger and `resolved_prompt` audit ledger are empty.
3. Assert every detected chooser remains `blocked_on_prompt` and escalates.
4. Run the focused test and confirm it fails because the current engine sends Escape.

### Task 2: Gate the resolver

**Files:**
- Modify: `src/agent-engine.ts`

1. Read the one policy switch, `CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE`.
2. Enable it only when the value is exactly `1`.
3. Route `resolve` dispositions to the existing escalation path when the switch is false, before `maybeResolvePrompt` is invoked.
4. Run the focused test and confirm it passes.

### Task 3: Preserve the experimental lane

**Files:**
- Modify: `tests/sidebar-sync.test.ts`
- Modify: `README.md`

1. Enable `autoResolvePrompts` explicitly in the existing resolver integration matrix.
2. Document the environment flag as experimental, default off, and not for fleet use.
3. Run the resolver matrix with the flag on and confirm its existing behavior remains covered.

### Task 4: Verify and publish

**Files:**
- Modify: `/Users/etanheyman/Gits/cmuxlayer/docs.local/plan/stability-v2/collab.md`

1. Build the branch and run the reviewer’s complete round-6 production attack probe with the flag off; assert its aggregate key ledger is empty for all inputs.
2. Run restart retention and focused prompt tests.
3. Run the full suite, build, typecheck/pre-PR checks, and `git diff --check`.
4. Commit, push `wt/prompt-freeze`, verify the remote head, and post the exact head plus evidence to the collaboration log.
