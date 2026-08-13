# Read-Reality Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `list_agents` expose fresh, provenance-labelled live facts without requiring callers to run `resync_agents` or interpret provisional IDs.

**Architecture:** Keep `AgentRecord` as the flat audit-log schema. Project caller-visible live facts into `Observed<T>` envelopes at the server boundary, cache complete filtered projections only within a caller-declared budget of at most five seconds, and invalidate cached projections whenever live topology changes. Run discovery repair on uncached reads and backfill legacy pending IDs during lifecycle initialization.

**Tech Stack:** TypeScript, Zod, MCP SDK, Vitest.

---

### Task 1: Define the observed public contract

**Files:**
- Modify: `src/agent-types.ts`
- Modify: `src/agent-facade.ts`
- Modify: `src/format.ts`
- Test: `tests/server-agent-tools.test.ts`

1. Add failing assertions for `derived_at` and per-field `{value, source, observed_at_ms}` envelopes.
2. Run the focused `list_agents` tests and confirm the old bare values fail.
3. Add the generic `Observed<T>` type and project registry/screen/process-backed values with explicit timestamps.
4. Update concise text formatting to consume observed values while structured output retains provenance.
5. Re-run the focused tests.

### Task 2: Bound staleness and auto-resync

**Files:**
- Modify: `src/server.ts`
- Test: `tests/server-agent-tools.test.ts`

1. Add failing tests for `max_age_ms <= 5000`, same-topology cache reuse, and topology-change invalidation.
2. Confirm the tests fail because `list_agents` has no staleness input or cache.
3. Add a per-server snapshot cache keyed by filters and topology signature.
4. On every uncached read, force discovery, run repair/backfill, merge live observations, and build one timestamp-consistent response.
5. Re-run focused tests.

### Task 3: Backfill legacy provisional identities

**Files:**
- Modify: `src/agent-engine.ts`
- Test: `tests/agent-engine.test.ts`

1. Add a failing initialization test for a persisted `-pending-` row that already has a session identity.
2. Confirm initialization leaves the provisional ID behind.
3. Reuse the canonical session-finalization path during initialization to rename the row before first publication.
4. Re-run the focused test.

### Task 4: Verify and publish

**Files:**
- Modify only if verification reveals defects.

1. Record a PREDICTION for focused and full suites.
2. Run focused tests, typecheck, build, and the full test suite; compare results with the prediction.
3. Run a real branch binary/client probe because server/MCP behavior changed.
4. Run the bounded local CodeRabbit review, inspect the diff, and fix actionable findings.
5. Commit with the live identity trailer, push, open a signed ready PR, append the collab log, and ping the lead with the PR URL.
