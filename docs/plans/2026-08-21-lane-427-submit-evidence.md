# Lane 427 Submit Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every verified delivery receipt identify the evidence branch that certified submission, then use live evidence to repair only the branch responsible for issue #427's remaining false green.

**Architecture:** Extend the existing delivery receipt and verifier result with one nullable `submit_evidence` discriminator. Preserve the verifier's current evidence ordering, expose the discriminator through boot/spawn responses, run the instrumented implementation against real Codex lifecycle probes, and add a branch-specific regression before changing verifier behavior.

**Tech Stack:** TypeScript, Zod, Bun, Vitest, cmuxlayer MCP/CLI live probes.

---

### Task 1: Add the diagnostic discriminator

**Files:**
- Modify: `src/server.ts`
- Test: `tests/delivery-truth-t2.test.ts`
- Test: `tests/enter-reliability.test.ts`
- Test: `tests/spawn-response.test.ts`

1. Add failing receipt assertions for `token_delta`, `transcript_echo`, `cleared_composer`, `status_only`, and `null` where submission is not verified.
2. Run only the touched tests with `bun run vitest run ...` and confirm the assertions fail because `submit_evidence` is absent.
3. Add a `SubmitEvidence` union and propagate it from `verifySubmitAfterEnter` through `buildPublicDeliveryReceipt` and the public output schema.
4. Keep evidence precedence explicit: token/cost delta, transcript echo/fresh Cursor response, cleared composer, then legacy status-only evidence.
5. Re-run focused tests and compile touched tests directly.
6. Commit the diagnostic separately.

### Task 2: Identify the live false-green branch

**Files:**
- Record: `/Users/etanheyman/.cmux/agents/cmuxlayerCodex-7d26448d/report.md`

1. Build and launch the instrumented branch through the repository's supported local/live path.
2. Spawn Codex with `boot_prompt_path` at least three times.
3. Immediately record receipt fields plus raw screen `status`, `control_state`, payload-in-composer, and agent-output presence.
4. Classify accepted-prompt echo only when the screen is `working`/`busy`; classify false green only when all four brief conditions hold.
5. If a false green appears, name its exact `submit_evidence`; if none appears, report the complete N>=3 table and do not invent a branch.

### Task 3: Fix only the proven branch

**Files:**
- Modify: `src/server.ts` only if Task 2 identifies a verifier branch defect
- Test: the narrow existing verifier test file that models the observed frame sequence

1. Encode the exact live frame sequence as a failing regression and run it red.
2. State one root-cause hypothesis tied to the recorded `submit_evidence` value.
3. Make the smallest verifier change that invalidates that evidence on the false-green sequence.
4. Run the regression green, then all focused delivery/boot tests.
5. If the Return genuinely landed and Codex dropped it, do not patch the verifier; document that result instead.

### Task 4: Verify and hand off

**Files:**
- Write: `/Users/etanheyman/.cmux/agents/cmuxlayerCodex-7d26448d/report.md`
- Append: `/Users/etanheyman/Gits/orchestrator/collab/LEADS.md`

1. Run `bun run test` and `bun run typecheck`.
2. Compile each touched test file directly because repository typecheck excludes tests.
3. Run final live Codex N>=3 and preserve raw per-probe values verbatim.
4. Run review, commit the branch-specific fix if one was warranted, push, and open a ready-for-review PR without merging.
5. Write the engine report with red/green commands and outputs, PR/SHA evidence, and the exact done marker.
6. Append one concise handoff line to `LEADS.md`, then acknowledge any handled mailbox messages with their canonical IDs.
