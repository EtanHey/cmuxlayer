# MCP Child Self-Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace a stale Homebrew-managed cmuxlayer MCP stdio child with the freshly installed entrypoint without losing its stdio transport or silently dropping requests.

**Architecture:** The existing proxy version watcher will enter a one-shot drain state when `detectStaleBuild` reports a mismatch. It will reject new requests explicitly, wait up to a bounded deadline for existing requests, reject any remainder, serialize the MCP initialization handshake into an environment handoff, and call `process.execve` with the realpath-resolved installed `dist/index.js`. Canonical provenance and a cross-exec marker prevent source/dev execution and re-exec storms.

**Tech Stack:** TypeScript, Node.js 22.15+ `process.execve`, MCP JSON-RPC stdio, Vitest.

---

### Task 1: Resolve and gate the installed MCP entrypoint

**Files:**
- Modify: `src/version.ts`
- Test: `tests/version.test.ts`

1. Write failing tests for a realpath-resolved installed `dist/index.js` path.
2. Run `bunx vitest run tests/version.test.ts` and confirm the new test fails.
3. Add `resolveInstalledEntryScript`, sharing the daemon resolver's canonical-path behavior.
4. Re-run the focused test and confirm it passes.

### Task 2: Add one-shot drain and in-place re-exec

**Files:**
- Modify: `src/is-main.ts`
- Modify: `src/proxy.ts`
- Modify: `src/entry.ts`
- Test: `tests/proxy-version-bump.test.ts`

1. Write failing tests for exactly-once exec, dev/source gating, cross-exec storm prevention, and explicit rejection of work remaining at the drain deadline.
2. Run `bunx vitest run tests/proxy-version-bump.test.ts` and confirm failures are caused by the missing remediation API.
3. Export the existing canonical-path helper and inject the running/installed entrypoints, execve operation, environment, and drain timeout into the proxy.
4. On self-stale detection, enter drain mode, reject new requests, wait for pending requests, track every daemon-to-client frame, reject remaining requests at the deadline, and await every JSON-RPC rejection/response transport flush before proceeding.
5. Bound the serialized handshake state before placing it in the environment. If it exceeds the bound, keep the current session alive and log the blocked remediation instead of risking an `E2BIG` exec failure.
6. Persist an in-bounds handshake in the environment, then exec the installed entrypoint.
7. Hydrate the handshake in the replacement proxy so it can replay initialization to the daemon.
8. Re-run the focused suite and keep the existing daemon-reconnect behavior green when self-remediation is ineligible.

Transient transport-flush or exec failures re-enable the watcher behind a bounded in-process attempt guard. The cross-exec marker is scoped to one running→installed transition, so it blocks a loop without suppressing the next release upgrade.

### Task 3: Verify determinism and PR readiness

**Files:**
- Modify only files required by failures.

1. Run typecheck, build, and the full deterministic test suite.
2. Run the deterministic suite five times from cold process starts.
3. Exercise the built entrypoint with a real MCP client session as required by the MCP runtime gate.
4. Run bounded CodeRabbit review and address actionable findings.
5. Commit, push `feat/r8-mcp-child-remediation`, and open the requested ready-for-review PR with the design rationale and verification evidence.
