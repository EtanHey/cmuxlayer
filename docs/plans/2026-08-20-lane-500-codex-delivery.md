# Lane 500 Codex Delivery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore lead-to-Codex delivery without weakening the human-draft guard, make key-submit receipts follow observed prompt transitions, and expose retry stalls without inventing a terminal failure.

**Architecture:** Keep composer safety in `src/server.ts`, but classify Codex's rotating ghost placeholders through a documented placeholder pattern before the foreign-draft guard runs. Give key-mode verification a pre-key snapshot and accept an observed permission-prompt dismissal as positive evidence without treating post-key composer text as failure evidence. In `src/agent-engine.ts`, fingerprint retry snapshots and mark a still-queued receipt as needing attention after repeated byte-identical refusals.

**Tech Stack:** TypeScript, Vitest, Bun, cmuxlayer MCP delivery engine.

---

### Task 1: Codex ghost placeholders versus human drafts

**Files:**
- Modify: `src/server.ts`
- Test: `tests/delivery-truth-t2.test.ts`

1. Add an integration regression where a ready Codex pane displays `Ask Codex to do anything` and `send_to` must mutate the pane and return a submitted receipt.
2. Run `bunx vitest run tests/delivery-truth-t2.test.ts` and capture the foreign-draft refusal.
3. Add the narrow Codex placeholder classifier, preserving literal submitted-placeholder text as pending input.
4. Re-run the focused test and confirm the existing half-typed-human-draft test remains green.

### Task 2: Key-mode permission-prompt state transition

**Files:**
- Modify: `src/server.ts`
- Test: `tests/t2b-silent-failures.test.ts`

1. Add a regression that starts on a Codex permission prompt, dispatches Return, then observes `control_state` become `busy` while a Codex placeholder remains visible.
2. Run `bunx vitest run tests/t2b-silent-failures.test.ts` and capture the `composer_still_populated` failure.
3. Capture a pre-key screen and verify submit by the permission prompt being dismissed; never emit `composer_still_populated` for key mode.
4. Re-run the focused test and keep non-submit dispatch receipts unchanged.

### Task 3: Byte-identical retry attention

**Files:**
- Modify: `src/agent-engine.ts`
- Modify: `src/server.ts`
- Test: `tests/agent-engine.test.ts`

1. Add a fake-timer regression that repeatedly rejects a queued delivery on the same snapshot and expects a nonterminal `needs_attention` receipt after the configured attempt threshold.
2. Run the focused AgentEngine test and capture the missing attention fields.
3. Persist a snapshot fingerprint and unchanged count on retryable refusals; set a visible attention reason at the threshold while keeping `delivery_state:"queued"` and `terminal:false`.
4. Expose the attention fields through `wait_for({delivery_id})` and detailed delivery listings.
5. Re-run the focused test, then verify changed behavior still respects bounded retry timing without claiming delivery failure.

### Task 4: Verification and reviewed PR handoff

**Files:**
- Modify: PR body and engine report only after evidence exists.

1. Run all three focused suites, `bun run typecheck`, and `bun run test`.
2. Inspect `git diff --check`, the full diff, and status.
3. Run bounded local CodeRabbit review if available and address real findings.
4. Use the sanctioned terminal surface to commit with the required identity trailer, push, create a ready PR, and request bot review.
5. Read CI and review output, address blocking findings, and leave the PR open.
6. Write the engine report and exact lead handoff line with the verified PR URL.
