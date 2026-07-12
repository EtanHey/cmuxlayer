# Per-seat Expected-state Manifest Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write and refresh an injectable per-seat expected-state manifest so orchestrator's A3 resume-integrity watcher can compare deliberate state with live state.

**Architecture:** A focused manifest module defines the schema and atomic filesystem adapter. `createServer` owns a shared injected/no-op writer and publishes from successful spawn, rename, and model-pin mutation paths using registered agent state plus live tab metadata.

**Tech Stack:** TypeScript, Bun/Vitest, Node filesystem promises, cmuxlayer MCP tool harness.

---

### Task 1: Manifest contract and isolated filesystem adapter

**Files:**
- Create: `src/seat-manifest.ts`
- Create: `tests/seat-manifest.test.ts`

1. Write tests for exact schema serialization, `surface:42` filename sanitization, env/default directory resolution, and atomic writes inside an injected temporary directory.
2. Run `bun run test tests/seat-manifest.test.ts` and confirm RED because the module does not exist.
3. Implement the minimal types, path resolver, and filesystem writer.
4. Re-run the focused test and confirm GREEN.

### Task 2: Spawn-path publication with injection

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-agent-tools.test.ts`

1. Add a failing spawn-path test that injects a recording writer and spawns `fable-5` through the mocked server.
2. Assert the exact manifest fields, including `permission_mode`, cwd/repo, tab/session, model pin, and that only the injected writer is called.
3. Run the focused test and confirm RED from zero writer calls.
4. Add the injectable server option, a best-effort publisher, and production filesystem injection.
5. Publish after `spawn_agent` and `new_worktree_split` registration/metadata refresh, then confirm the focused tests GREEN.

### Task 3: Deliberate pin and rename refresh

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-agent-tools.test.ts`

1. Add failing tests for `interact(action=model)` and `rename_tab` refreshing the manifest only after successful mutations.
2. Run the focused tests and confirm RED.
3. Persist the deliberate model pin in agent state, refresh the manifest, and refresh after tab rename.
4. Re-run focused tests and confirm GREEN.

### Task 4: Verification and PR handoff

**Files:**
- Modify: `docs.local/collab/driver-buddy-2026-07-12.md` in orchestrator only for the requested channel post (not part of this repository commit).

1. Run `bun run test` and `bun run typecheck` and read complete results.
2. Review the diff and run the repository's available pre-commit reviewer within its bounded timeout.
3. Commit the scoped files, push `feat/seat-manifest-at-spawn`, and open a ready-for-review PR titled `feat(seat): write per-seat expected-state manifest at spawn/pin (A3 resume-integrity)`.
4. Invoke reviewers, post the path/schema to the 07-12 channel for `a3-watcher-codex`, and report the PR without merging.
