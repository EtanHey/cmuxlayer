# Run 10 Phase 1 Publish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the accepted Run 10 Phase 1 BEFORE matrix without remeasurement and make every MCP-side CLI fallback fail the benchmark process, with its classifier exercised by CI.

**Architecture:** Keep the accepted local receipt immutable and derive the signed PR comment from its 36 rows. Add a pure fallback classifier to `scripts/bench-e2e.mjs`, use it in the process exit gate, and exercise direct-CLI-arm versus MCP-fallback semantics in the Vitest suite that CI runs. GitHub CI cannot execute the live matrix without isolated cmux; it proves the classifier, while an invoked benchmark proves the process exit. The PR comment is the publication artifact: its default section shows non-PASS rows plus an unchanged count, its collapsed section carries all rows, every row has a measurement tag, and the D201 evidence sits beside the data.

**Tech Stack:** Node.js ESM, Vitest, GitHub PR comments, JSON benchmark receipts.

---

### Task 1: Specify the CLI fallback process gate and CI regression

**Files:**
- Modify: `tests/bench-e2e.test.ts`
- Modify: `scripts/bench-e2e.mjs`

1. Add a failing test for a pure `benchmarkGateFailures(rows, fatalError)` helper.
2. Assert that an MCP row with reported `transport_counts.cli`, reported fallback counts, or D180 `inferred_transport: "cli"` produces a `cli fallback active` failure.
3. Assert that a direct CLI comparison row does not produce a fallback failure.
4. Run `bunx vitest run tests/bench-e2e.test.ts -t "fails the benchmark gate on every MCP CLI fallback"` and observe the missing export failure.
5. Implement the minimal helper and replace the current inline exit predicate with it.
6. Re-run the focused test and the complete harness test file.

### Task 2: Publish the accepted BEFORE matrix

**Files:**
- Read: `docs.local/scratch/run10-phase1/isolation-test-20260831.json`
- Create locally, not in Git: `docs.local/scratch/run10-phase1/phase1-before-comment.md`

1. Read the accepted receipt; do not execute `bench-e2e.mjs` again.
2. Render the 36 rows into the Run 10 PR-comment shape.
3. Tag the 24 measured rows `sampled` and the 12 absent CLI-send rows `single_shot`; leave every numeric cell blank for `single_shot` rows.
4. Show only FAIL/NOT_COMPARABLE rows in the default section and state the exact unchanged PASS-row count.
5. Put all 36 rows in a collapsed `<details>` block.
6. Mark all surface-mode transport `UNTRUSTED` under D180.
7. Add D201 evidence with exact measured values: 250/450 are 0% at c1/c5/c10; c1 is 0% at 520/900; c10 failure rates are lower than c5 while latency rises substantially. State that this is evidence against simple capacity exhaustion and for a bounded race window, not a verdict about the racing party.

### Task 3: Verify and open the worker PR

**Files:**
- Modify in place after handoff: `/Users/etanheyman/.cmux/agents/cmuxlayerCodex-2c968dd2/report.md`

1. Run focused tests and inspect the full output.
2. Run typecheck with socket variables present and with both socket variables unset.
3. Run the D138 forbidden-path grep gate and verify no changes to `src/server.ts` or `src/agent-engine.ts`.
4. Run the full suite in both required environment modes; treat `tests/server.test.ts:4536` only as the known D153 flake if it is the exact failure.
5. Run bots first on the exact diff; report any real bot defect to the lead before fixing it.
6. Commit with the verified Codex identity trailer, push, and open a ready-for-review PR.
7. Post the signed BEFORE publication comment and request bot reviews.
8. Wait for CI, inspect every bot comment, disposition blocking findings, and run the standalone unresolved-thread query immediately before handoff.
9. Update the existing report in place with the PR URL, publication table/link, fallback gate proof, tag list, and suite tails. Do not unlink the report.
