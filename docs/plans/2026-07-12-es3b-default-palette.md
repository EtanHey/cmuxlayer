# ES-3b Default Palette Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a per-session `CMUXLAYER_DEFAULT_PALETTE` environment seam that boots only named tools plus `expand_palette`, while preserving the current unset full-tool surface exactly.

**Architecture:** Parse the environment once per `createServer()` call in a small `src/palette.ts` controller. The existing `server.tool` registration wrapper remains the single seam: selected tools register immediately, non-selected tools retain their original registration arguments for runtime expansion, and lifecycle-gated registrations are never seen when `skipAgentLifecycle` wins. Palette-bearing MCP children use the existing in-process entry path so their environment cannot leak through a shared daemon; expansion suppresses the SDK's per-tool notifications and emits one explicit `notifications/tools/list_changed` after the batch.

**Tech Stack:** TypeScript, Zod, `@modelcontextprotocol/sdk` 1.x, Vitest, in-memory MCP transports.

---

### Task 1: Lock the MCP behavior with failing tests

**Files:**
- Create: `tests/default-palette.test.ts`

1. Add an environment restore helper and an in-memory server/client fixture.
2. Test a three-name palette lists exactly those tools plus `expand_palette`.
3. Test expansion restores the full lifecycle-gated set, emits `notifications/tools/list_changed`, and is idempotent.
4. Test unset and whitespace-only values preserve the current full-tool surface without `expand_palette`.
5. Test unknown names warn to stderr while valid names remain resident.
6. Test a deferred tool call fails with the standard MCP unknown-tool error before expansion.
7. Run `bunx vitest run tests/default-palette.test.ts` and verify failures are caused by the missing palette feature.

### Task 2: Implement registration-layer deferral

**Files:**
- Create: `src/palette.ts`
- Modify: `src/entry.ts`
- Modify: `src/server.ts`

1. Add a palette controller that treats missing/blank input as disabled, normalizes comma-separated bare names, records known/selected/deferred tools, warns once for unknown names after registration, and expands deferred registrations once.
2. Route palette-bearing children through the existing in-process entry path so selection remains per-session even when normal children share a daemon.
3. Route calls through the existing `server.tool` wrapper after transport retry decoration. Register `expand_palette` only when palette mode is enabled.
4. Return structured success from `expand_palette`, including whether expansion happened and the names registered; batch the registrations behind one list-changed notification, and make later calls a no-op success.
5. Run `bunx vitest run tests/default-palette.test.ts tests/entry.test.ts` until all focused tests pass.

### Task 3: Document and verify

**Files:**
- Modify: `README.md`

1. Add one short configuration block explaining comma-separated bare names, unset/blank compatibility, runtime expansion, and fail-soft unknown names.
2. Run focused tests, `bun run test`, `bun run typecheck`, and `bun run build`.
3. Start the built server with a palette through a real stdio MCP client, list the resident tools, call `expand_palette`, and list the expanded tools.

### Task 4: Publish through the PR loop

**Files:**
- Review all changed files and the final diff.

1. Run bounded local CodeRabbit review and resolve substantive findings.
2. Commit only the scoped files, push `feat/es3b-default-palette-env`, and create a ready PR titled `feat: CMUXLAYER_DEFAULT_PALETTE per-session resident-tool palette (E5 eval seam)`.
3. Cite the ES-3b brief and E5 unblock in the PR body, invoke available reviewers, address findings, and merge only after the required review and CI gates.
4. Verify the remote PR state and merge content, update relevant tracking, and store the milestone plus rationale in BrainLayer.
