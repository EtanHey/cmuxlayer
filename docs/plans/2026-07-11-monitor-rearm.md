# Durable Monitor Auto-Re-arm Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore stale registered monitor watchers exactly once after daemon or app restarts, while visibly collapsing unsafe records.

**Architecture:** Add a file-locked recovery state machine to the monitor registry, then host it from the durable daemon with injected owner-liveness and inbox-rearm adapters. Persist recovery claims before side effects so deadman delivery and daemon restarts cannot duplicate work, and thread collapsed state into existing monitor listings and agent health.

**Tech Stack:** TypeScript, Bun, Vitest, JSON file registry, cmux daemon context, file-backed agent state and inbox.

---

### Task 1: Specify registry recovery states and reconciliation

**Files:**
- Modify: `tests/monitor-registry.test.ts`
- Modify: `src/monitor-registry.ts`

1. Add a failing test with a stale `alive` record, existing watched file, live owner callback, and explicit `rearm_command`; assert one re-arm call, durable `rearming` state, and no second call on another reconciliation.
2. Run `bunx vitest run tests/monitor-registry.test.ts` and confirm failure is caused by the missing reconciliation API/state.
3. Add minimal `rearm_command`, `rearming`, `collapsed`, claim timestamp, collapse reason, result types, and injected `ownerAlive`, `watchTargetExists`, and `rearm` dependencies.
4. Claim under the existing registry lock before invoking `rearm`; roll a failed callback back to `alive` without changing its heartbeat.
5. Re-run the focused suite and confirm the new behavior passes.

### Task 2: Specify unsafe-collapse and deadman idempotency

**Files:**
- Modify: `tests/monitor-registry.test.ts`
- Modify: `src/monitor-registry.ts`

1. Add separate failing tests for an absent owner, a missing watched file, and missing legacy `rearm_command`; assert visible collapsed reasons, zero re-arm calls, and zero deadman notifications after a sweep.
2. Add a failing restart test that creates a second reconciler against the same registry path and asserts a `rearming` claim is not repeated.
3. Run the focused tests and observe the expected failures.
4. Implement only the collapse transitions, liveness mapping, and deadman exclusion needed for those cases.
5. Re-run `bunx vitest run tests/monitor-registry.test.ts`.

### Task 3: Round-trip exact re-arm metadata through MCP tools

**Files:**
- Modify: `tests/monitor-registry-mcp.test.ts`
- Modify: `src/server.ts`

1. Add failing MCP tests that register `rearm_command`, read it through `list_monitors`, and read collapse metadata through both list and gate query shapes.
2. Run `bunx vitest run tests/monitor-registry-mcp.test.ts` and confirm the schema/round-trip failures.
3. Extend the registration schema and validation with an optional non-empty `rearm_command`; preserve compatibility for legacy callers.
4. Re-run the focused MCP suite.

### Task 4: Host immediate and periodic reconciliation in the daemon

**Files:**
- Modify: `tests/daemon.test.ts`
- Modify: `src/daemon.ts`
- Modify: `src/inbox.ts`

1. Add failing daemon tests for one immediate boot reconciliation, non-overlapping periodic reconciliation, timer cleanup on shutdown, and two daemon instances sharing a registry without duplicate re-arm delivery.
2. Run `bunx vitest run tests/daemon.test.ts` and confirm the absent coordinator causes the failures.
3. Add injectable daemon reconciliation options and a default production adapter. Resolve owners from `StateManager.listStates()`, reject terminal records, verify the recorded surface with `readScreen`, and append a deterministic `monitor-rearm` inbox record containing the exact command.
4. Use a stable inbox message id derived from the monitor recovery claim; ensure a duplicate id is not appended twice.
5. Start reconciliation after context creation, schedule the unref'd interval, guard overlap, and clear it before shutdown.
6. Re-run the daemon and inbox focused suites.

### Task 5: Surface collapsed monitors in owner health

**Files:**
- Modify: `tests/agent-health.test.ts`
- Modify: `tests/agent-health-input.test.ts`
- Modify: `src/agent-health.ts`
- Modify: `src/agent-health-input.ts`
- Modify: `src/server.ts`

1. Add a failing pure health test for blocking issue `monitor_collapsed` and its message/recommended action.
2. Add a failing input-builder test that resolves a collapsed registry record by agent id or seat id.
3. Run both focused suites and confirm the new input/code is absent.
4. Add the smallest input dependency and issue classification, wiring the production registry path without changing persisted agent records.
5. Re-run the health, input, server-agent, and monitor MCP suites.

### Task 6: Verify invariants and publish

**Files:**
- Review every changed file.
- Do not modify `src/proxy.ts`, `src/version.ts`, or `src/is-main.ts`.

1. Run `bun run typecheck && bun run test && bun run build` and read the complete output.
2. Run focused regression tests once more for monitor registry and daemon restart behavior.
3. Run `git diff --check`, inspect `git diff`, confirm forbidden files are untouched, and inspect `git status`.
4. Commit the implementation intentionally and push `feat/r4-monitor-rearm`.
5. Open a non-draft PR titled `feat(monitors): durable auto-re-arm across daemon and app restarts`.
6. Read CI and review feedback, fix actionable findings with fresh verification, and complete the authorized PR loop unless repository policy or the task owner reserves merge authority.
7. Store the design decision, verification evidence, and PR milestone in BrainLayer.
