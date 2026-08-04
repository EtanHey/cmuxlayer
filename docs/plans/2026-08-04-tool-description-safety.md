# Tool Description Safety Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every pane-writing MCP description warn that long inline payloads break receiving panes, and make the `list_surfaces` verbose cost explicit.

**Architecture:** Centralize the harm-first pane-input wording in `src/server.ts`, compose it into every applicable tool and payload field description, and pin the contract with description-level tests. Reuse one pre-mutation prompt validator across all spawn APIs so legacy prompt fields cannot bypass the existing runtime guards; keep response schemas unchanged.

**Tech Stack:** TypeScript, Zod MCP schemas, Vitest.

---

### Task 1: Pin pane-input description wording

**Files:**
- Modify: `tests/pointer-discipline.test.ts`
- Test: `tests/pointer-discipline.test.ts`

**Step 1: Write the failing test**

Replace the old threshold-led description assertion with checks that every
pane-writing tool description starts with the shared harm-first warning and
that each inline text, command, or prompt field repeats the warning. Include
the compatibility aliases and nested `spawn_in_workspace.agents[].prompt`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pointer-discipline.test.ts`

Expected: FAIL because current descriptions lead with thresholds and do not
say that long payloads break receiving panes.

**Step 3: Write minimal implementation**

Modify `src/server.ts` to replace `DENSE_INLINE_ROUTING_GUIDANCE` with the
harm-first wording and prepend it to every applicable tool and field
description. Do not change schemas or guards during this initial wording step.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pointer-discipline.test.ts`

Expected: PASS.

**Step 5: Close the review-discovered legacy guard gap**

Write RED cases proving `new_worktree_split.prompt` and
`spawn_in_workspace.agents[].prompt` bypass the over-cap, dense-line, and
multi-paragraph guards. Route all three spawn paths through one shared validator
before any pane/workspace mutation, then rerun the six cases to GREEN.

### Task 2: Pin `list_surfaces` verbose-cost guidance

**Files:**
- Modify: `tests/server.test.ts`
- Test: `tests/server.test.ts`

**Step 1: Write the failing test**

Assert that the `list_surfaces` tool description calls the default condensed
and that the `verbose` field description says it returns raw fields, costs more
tokens, and is rarely needed.

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts -t "list_surfaces describes verbose cost"`

Expected: FAIL because the current description only says “full schema.”

**Step 3: Write minimal implementation**

Modify only the `list_surfaces` tool and `verbose` field descriptions in
`src/server.ts`. Keep the condensed and verbose response objects unchanged.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server.test.ts -t "list_surfaces describes verbose cost"`

Expected: PASS.

### Task 3: Verify and publish the worker endpoint

**Files:**
- Verify: `src/server.ts`
- Verify: `tests/pointer-discipline.test.ts`
- Verify: `tests/server.test.ts`

**Step 1: Run focused and static verification**

Run:

```bash
npx vitest run tests/pointer-discipline.test.ts tests/server.test.ts
npm run typecheck
npm run build
npm run pre-pr:harness
```

Expected: all commands exit 0.

**Step 2: Run the full isolated suite**

Run: `env TMPDIR=<fresh-isolated-dir> npm test`

Expected: all Vitest files and tests pass.

**Step 3: Review, commit, push, and open a ready PR**

Run the bounded local CodeRabbit review, address valid findings, commit only the
planned files, push `fix/tool-description-safety`, and create a ready-for-review
PR. Do not merge; the worker brief assigns review routing to `@cmuxlayer`.

The first CodeRabbit pass found the legacy spawn guard gap fixed in Task 1. Its
suggestion to qualify the harm-first wording is waived because Etan supplied
the exact leading text. A second pass was attempted after the fix but the free
OSS service reported a 22-minute rate limit before analysis began.
