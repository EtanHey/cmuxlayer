# PTY Write-Liveness Health Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Classify stale-active panes as unhealthy after repeated recent real writes fail with broken-pipe errors.

**Architecture:** Add a small per-surface write-liveness tracker with injectable policy and clock, record outcomes at the shared `withSurfaceWrite` boundary, and pass its observation through the existing health-input builder. Health classification adds one blocking issue without changing the established tier model.

**Tech Stack:** TypeScript, Vitest, Bun, MCP server context.

---

### Task 1: Specify the write-liveness tracker

**Files:**
- Create: `tests/surface-write-liveness.test.ts`
- Create: `src/surface-write-liveness.ts`

1. Write failing tests for repeated EPIPE, one EPIPE, success reset, other-error interruption, and expiry using an injected clock.
2. Run `bunx vitest run tests/surface-write-liveness.test.ts` and confirm the missing module/behavior fails.
3. Implement the minimal bounded per-surface tracker and broken-pipe classifier.
4. Re-run the focused test and confirm it passes.

### Task 2: Specify health classification

**Files:**
- Modify: `tests/agent-health.test.ts`
- Modify: `src/agent-health.ts`

1. Add failing tests for active screen plus dead-PTY evidence, single transient evidence, healthy observation, severity, and disagreement downgrade behavior.
2. Run `bunx vitest run tests/agent-health.test.ts` and confirm failures are caused by the absent issue/input.
3. Add `pane_pty_dead` as blocking and evaluate it only for active screens with qualifying evidence.
4. Re-run the focused test and confirm it passes.

### Task 3: Thread observations into health input

**Files:**
- Modify: `tests/agent-health-input.test.ts`
- Modify: `src/agent-health-input.ts`

1. Add a failing test showing the liveness observation dependency reaches `AgentHealthInput`.
2. Run `bunx vitest run tests/agent-health-input.test.ts` and confirm the expected failure.
3. Add the dependency/override and return field.
4. Re-run the focused test and confirm it passes.

### Task 4: Record real server writes and expose them through health

**Files:**
- Modify: `tests/server-agent-tools.test.ts`
- Modify: `src/server.ts`

1. Add a hermetic server test that performs two failed broken-pipe top-level writes against an active managed agent and observes `pane_pty_dead` in `list_agents`.
2. Run the focused server test and confirm it fails for the absent tracking.
3. Put the tracker in shared server context, record `withSurfaceWrite` outcomes, and supply observations to health evaluation.
4. Re-run focused server and health suites.

### Task 5: Verify and publish

**Files:**
- Review all changed files; do not touch `src/proxy.ts` or `src/doctor.ts`.

1. Run `bun run typecheck && bun run test && bun run build`.
2. Review `git diff --check`, `git diff`, and `git status`.
3. Commit intentionally, push `feat/r2-pty-liveness`, and open the requested titled PR.
4. Store the implementation decision and verification milestone in BrainLayer.
