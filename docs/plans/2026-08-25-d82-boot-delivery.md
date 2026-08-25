# D82 Boot Delivery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver boot prompts only after the launcher front-matter turn is idle, with truthful queued/rescued receipts and retained live-agent state.

**Architecture:** Extend the existing boot-readiness and delivery-receipt pipeline rather than adding a parallel sender. Keep the server as the only authority that can mark a managed boot prompt delivered; lifecycle screen reconciliation may preserve or fail pending state but may not invent successful delivery.

**Tech Stack:** TypeScript, Vitest, cmux screen parsing and lifecycle registry.

---

### Task 1: Add failing receipt and readiness regressions

**Files:**

- Modify: `tests/delivery-truth-t2.test.ts`
- Modify: `tests/server-agent-tools.test.ts`

1. Add a test where Codex renders a working front-matter turn with an empty composer, later becomes idle, and the boot prompt is typed only after idle.
2. Add a test where that working frame persists through `boot_prompt_timeout_ms`; assert bounded return with `delivery_state: "queued"`, `typed: false`, and no Return.
3. Add a test where a new interrupt marker precedes transcript echo; assert `delivery_state: "rescued"` and `submit_verified: false`.
4. Add a managed-spawn test proving a queued timeout leaves `boot_prompt_pending: true` and the agent retrievable by id.
5. Run the focused tests and record the expected failures.

### Task 2: Implement idle-wait and receipt truth

**Files:**

- Modify: `src/server.ts`
- Modify: `src/agent-engine.ts`

1. Make boot readiness reject working/thinking frames as send-ready.
2. On deadline, recognize working agent identity plus empty composer plus absent prompt echo as the banner-independent queued observation.
3. Return a queued boot receipt without typing or pressing Return.
4. Add `rescued` to the public and engine delivery-state vocabulary and classify new-interrupt transcript evidence as rescued.
5. Preserve pending managed records for queued delivery and prevent lifecycle reconciliation from manufacturing successful boot delivery.
6. Run the focused tests until green.

### Task 3: Verify and publish through the run gates

**Files:**

- Modify only files required by review findings.

1. Run all affected suites, then the full suite.
2. Run typecheck both with the inherited environment and with the documented clean-environment form.
3. Run `git diff --check` and bounded local CodeRabbit review.
4. Commit with the required agent trailer, push, and open a signed ready-for-review PR.
5. Process no more than two review rounds; the lead owns the independent reviewer and live front-matter probe.
6. Before merge, separately assert checks green, zero unanswered P1 findings, and both `before`/`after` evidence links in the PR body.
7. Merge with a merge commit, verify origin/main contains the final head, and write the contract report ending with the required sentinel.
