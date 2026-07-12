# Delete Workspace Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a safe, deferred `delete_workspace` MCP tool and ensure live acceptance harnesses always delete scratch workspaces.

**Architecture:** Extend both cmux client transports with the native `workspace.close` / `workspace close` operation. Register a destructive workspace-level MCP handler beside `create_workspace`; snapshot its topology first, refuse caller/live-agent workspaces unless forced, and return the removed workspace/surface diff. Keep the tool in the deferred layout class by placement beside `create_workspace`, ready for the in-flight thin-core palette classification.

**Tech Stack:** TypeScript, Node.js, MCP SDK, zod, Vitest, cmux V2 socket/CLI.

---

### Task 1: Specify client and policy behavior

**Files:**

- Modify: `tests/cmux-client.test.ts`
- Modify: `tests/cmux-socket-client.test.ts`
- Modify: `tests/mode-policy.test.ts`
- Modify: `tests/server.test.ts`

1. Add tests requiring CLI `workspace close <ref>` and socket `workspace.close` calls.
2. Add a mode-policy assertion that `delete_workspace` is mutating.
3. Add server tests for empty-workspace deletion, live-agent refusal with surfaces/agents returned, forced deletion, and caller-workspace refusal.
4. Run the focused tests and confirm they fail because the tool/client methods do not exist.

### Task 2: Specify harness cleanup

**Files:**

- Modify: `tests/acceptance-registry-liveness.test.ts`
- Create: `tests/workspace-harness-cleanup.test.ts`

1. Add a source contract for `--create-workspace` support in the registry-liveness harness.
2. Assert both harness `finally` blocks call `delete_workspace` with `force:true` for their scratch workspace.
3. Run the focused tests and confirm the missing cleanup behavior fails.

### Task 3: Implement workspace deletion

**Files:**

- Modify: `src/cmux-client.ts`
- Modify: `src/cmux-socket-client.ts`
- Modify: `src/mode-policy.ts`
- Modify: `src/server.ts`

1. Add `deleteWorkspace(workspace)` to both transports, with socket method-not-found fallback to the CLI client.
2. Register `delete_workspace` beside the deferred `create_workspace` layout tool using destructive annotations.
3. Snapshot the target workspace, panes, surfaces, and matching agent records.
4. Refuse without `force` when the target is the caller workspace or any matching agent is not done/error; return the snapshot on refusal.
5. Call the client deletion method and return removed workspace/surface diff data.
6. Run focused tests until green.

### Task 4: Implement finally cleanup

**Files:**

- Modify: `scripts/acceptance-registry-liveness.mjs`
- Modify: `scripts/run-live-worker-placement-repro.ts`

1. Carry forward the acceptance harness's `--create-workspace <title>` path from its older tooling branch.
2. Track whether each harness created/reused a scratch workspace.
3. In `finally`, call `delete_workspace` with `{ workspace, force: true }` before closing the MCP client.
4. Run the harness cleanup tests until green.

### Task 5: Verify and publish

**Files:**

- Review all changed files.

1. Run all focused tests.
2. Run `bun run typecheck` and `bun test`.
3. Exercise the built MCP from a real client session, including listing/calling the new tool against a disposable workspace.
4. Run bounded CodeRabbit review; address actionable findings.
5. Commit as `feat(workspace): delete_workspace tool + harness scratch teardown`.
6. Push `feat/delete-workspace-and-harness-teardown` and open a ready-for-review PR. Do not merge.
