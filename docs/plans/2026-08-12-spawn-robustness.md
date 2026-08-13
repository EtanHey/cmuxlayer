# Spawn Robustness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every surface-creating spawn path recoverable and diagnosable when shell readiness, launcher submission, or post-creation work fails.

**Architecture:** Share shell-prompt recognition between the MCP and app-server paths, and introduce one creation-failure scope that records identities as soon as cmux creates them and attaches those identities to any later error without changing the error's runtime type. Centralize readiness diagnostics for direct and `AgentLaunchError`-wrapped failures. Treat a launcher that returns to a shell as an explicit launch failure, verify a pending launcher command actually leaves the prompt after Return, and roll back a newly created worktree only after a failed launcher surface is closed.

**Tech Stack:** TypeScript, Vitest, cmux client abstractions, MCP tool structured responses.

---

### Task 1: Shared shell-prompt contract

**Files:**
- Create: `src/shell-prompt.ts`
- Modify: `src/server.ts`
- Modify: `src/app-server-runtime.ts`
- Test: `tests/shell-prompt.test.ts`
- Test: `tests/app-server-runtime.test.ts`

1. Write failing table tests for ready prompts ending in `$`, `%`, `#`, `>`, `❯`, `›`, and `»`, plus negative cases where text remains after the prompt terminator.
2. Run the focused tests and confirm `>`/Unicode prompts fail under the current matchers.
3. Add one shared matcher and replace both private implementations.
4. Run the focused tests green.

### Task 2: Structural created-identity propagation

**Files:**
- Create: `src/created-identity.ts`
- Modify: `src/server.ts`
- Test: `tests/created-identity.test.ts`
- Test: `tests/server.test.ts`
- Test: `tests/server-agent-tools.test.ts`

1. Write failing unit tests proving an unclassified post-creation error receives the recorded identity, pre-creation errors receive none, prior batch identities accumulate, and error-supplied metadata cannot overwrite identity fields.
2. Write integration regressions that inject unknown post-creation failures in raw and managed creation paths.
3. Run focused tests and confirm identity is absent before implementation.
4. Add a creation scope that records identities and decorates any thrown error while preserving `instanceof` and `cause` behavior; make `err()` merge recorded identity last.
5. Record identities immediately after every current creation seam: `new_split`, `new_surface`, terminal `spawn`, managed `spawn`, `new_worktree_split`, and each `spawn_in_workspace` member.
6. Run focused tests green.

### Task 3: Readiness and launcher diagnostics

**Files:**
- Modify: `src/agent-engine.ts`
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`
- Test: `tests/server-agent-tools.test.ts`

1. Write failing regressions for an `AgentLaunchError` wrapping a readiness timeout and for a launcher returning to a shell with terminal error text.
2. Run focused tests and confirm `last_10_lines`/launcher text is lost or reduced to a generic timeout.
3. Set standard `Error.cause` on `AgentLaunchError`, recursively recover timeout diagnostics, and expose them through the shared error formatter.
4. Detect stable return-to-shell after launcher submission and return the captured terminal tail as diagnostics instead of waiting for a generic timeout.
5. Run focused tests green.

### Task 4: Return verification and post-launch rollback

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`
- Test: `tests/server-agent-tools.test.ts`

1. Write failing regressions where Return reports success but the launcher command remains at the shell prompt, and where a launcher failure after surface creation leaks a new worktree/branch/surface.
2. Run focused tests and confirm both failures.
3. After sending Return to a pending launcher command, require screen evidence that the pending command cleared or a supported CLI became ready.
4. On launch-phase `AgentLaunchError`, close the created surface, then roll back the newly created worktree and branch; preserve created identity and append cleanup diagnostics if either cleanup step fails.
5. Run focused tests green.

### Task 5: Verification and worker handoff

**Files:**
- Modify: `/Users/etanheyman/Gits/cmuxlayer/docs.local/plan/stability-v2/phase-7/findings.md`
- Modify: `/Users/etanheyman/Gits/cmuxlayer/docs.local/plan/stability-v2/collab.md`

1. Write a PREDICTION block before suite execution with expected focused/full outcomes and likely failure boundaries.
2. Run focused suites, typecheck, build, full tests, and `git diff --check`; compare actuals against the prediction.
3. Run the daemon/runtime gate with a real cmuxlayer client because this lane changes MCP spawn behavior.
4. Review the final diff and run the bounded local CodeRabbit pre-commit review.
5. Commit with the live agent-identity trailer, push the assigned branch, and open a signed ready-for-review PR.
6. Append the collab log line and inbox-ping `cmuxlayerClaude-9c55eb04` with the PR URL. If the inbox is unarmed, append the PR URL as the final line of `phase-7/findings.md`.

