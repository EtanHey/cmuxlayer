# Report to Parent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add hierarchy-bound blocker escalation, automatic persistent parent watches for child reports, and progress-bearing long waits.

**Architecture:** Reuse inbox durability and the guarded lifecycle relay for blocker delivery. Reuse the persistent WatchSpec registry for report completion, but route agent-owned watch notifications into the owner’s current surface and arm the watch automatically from the spawn contract. Emit MCP progress notifications from the `wait_for` handler while its engine promise remains pending.

**Tech Stack:** TypeScript, Bun, Vitest, MCP SDK, cmux lifecycle registry and delivery engine.

---

### Task 1: Restore the held-back public contract

**Files:**
- Modify: `tests/thin-core-tools.test.ts`

1. Apply `docs.local/golden-path/d7-test-holdback.patch` from the repository root.
2. Run the focused P0 D7 test and verify it fails because `report_to_parent` is absent.
3. Add no production code before that failure is observed.

### Task 2: Specify blocker escalation behavior

**Files:**
- Modify: `tests/server-agent-tools.test.ts`
- Modify: `src/server.ts`
- Modify: `src/palette.ts`

1. Add failing tests for registry-derived parent routing, root-agent refusal, parent delivery failure with ancestor fallback, dead parent handling, and concurrent children.
2. Run each focused test and verify the expected behavioral failure.
3. Register `report_to_parent` as the tenth public/default-palette tool with a 500-character `blocker` argument and lean output schema.
4. Implement durable direct-parent dispatch followed by guarded active delivery.
5. Walk only the persisted ancestor chain after direct-parent wake failure; return an error if no wake is evidence-backed.
6. Run the focused tests to green.

### Task 3: Auto-arm parent report watches at spawn

**Files:**
- Modify: `tests/server-agent-tools.test.ts`
- Modify: `tests/watch-spec-production.test.ts`
- Modify: `src/server.ts`
- Modify: `src/watch-spec.ts` only if a narrow reusable helper is required

1. Add failing tests proving spawn arms a parent-owned file watch without parent action, captures the current marker count, and survives a recreated server/parent session through the persistent registry.
2. Add a failing test proving a fired agent-owned watch wakes the owner through the guarded relay and stays pending when delivery fails.
3. Ensure the engine-issued report file exists without truncating prior content, then arm the watch after the spawn contract is persisted.
4. Route agent-owned WatchSpec notifications to the owner’s current surface; retain the configured external notifier for non-agent owners.
5. Run the focused tests to green.

### Task 4: Emit long-wait MCP progress

**Files:**
- Modify: `tests/watch-spec-mcp.test.ts`
- Modify: `tests/server-agent-tools.test.ts`
- Modify: `src/server.ts`

1. Add a fake-timer failing test that provides an MCP progress token and holds `wait_for` open beyond one progress interval.
2. Verify a progress notification is emitted before 60 seconds and the timer is cleared after completion.
3. Implement a scoped progress heartbeat around every blocking `wait_for` mode using the request handler’s progress notification channel.
4. Run the focused tests to green.

### Task 5: Verify and report

**Files:**
- Modify: `/Users/etanheyman/.cmux/agents/cmuxlayerCodex-3d89bb53/report.md`

1. Run `bun run typecheck`.
2. Run `bunx vitest run` and record exact totals.
3. Run `env -u CMUX_SOCKET_PATH -u CMUX_DAEMON_SOCKET bunx vitest run` and confirm the totals agree exactly.
4. Run the fresh-pane real-client spawn/report watch check and record whether it was actually run and what it observed.
5. Inspect the final diff and report only verified claims.
6. Write the contract report; its final line must be exactly `DONE_CMUXLAYERCODEX_3D89BB53`.
