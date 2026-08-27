# Run 9 Reviewer Round 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close reviewer round 1 by fixing all six P1s and both P2s without weakening the D136 or D145 contracts.

**Architecture:** Preserve the existing parser, lifecycle, health, transport, and delivery boundaries. Add biting regressions first, then make the smallest correction at each source boundary and migrate every repository caller of changed public contracts.

**Tech Stack:** TypeScript, JavaScript, Bun, Vitest, MCP stdio/socket clients, cmux live daemon.

---

### Task 1: Harness API error truth

**Files:** `src/screen-parser.ts`, `src/agent-engine.ts`, `tests/screen-parser.test.ts`, `tests/agent-engine.test.ts`

1. Add separate failing tests proving typed composer text cannot clear an API error and a halt-type transition still wakes the parent immediately.
2. Run the focused tests and record the expected failures.
3. Require attributable submitted/output evidence for parser recovery and let harness-error transitions fall through to dispatch.
4. Re-run the focused tests green.

### Task 2: Public contract caller migration

**Files:** `src/doctor.ts`, `scripts/run-real-cmux-contract.ts`, `scripts/acceptance-registry-liveness.mjs`, `scripts/run-live-id-churn-probe.ts`, relevant tests

1. Add failing assertions for the unchanged caller payloads.
2. Inventory every repository `control_health` and `send_to` caller.
3. Migrate diagnostic callers to `detail:"full"`, agent sends to explicit `mode:"agent"`, and key sends to canonical `text`.
4. Run caller-focused tests green without restoring aliases or optional mode.

### Task 3: Server health error propagation

**Files:** `src/server.ts`, health/server tests

1. Add failing server-path tests for request-ID-bearing `harness_api_error` across general health overrides.
2. Carry `screen_errors` through the read predicate, safe overrides, and fallback reader dependency.
3. Run server health and lifecycle tests green.

### Task 4: Surface identity and skill observation safety

**Files:** `src/cmux-socket-client.ts`, `src/server.ts`, socket and skill-delivery tests

1. Add failing tests for `notify({surface:"45"})`, stable UUID/workspace post-skill reads, and post-read failure after successful mutation.
2. Validate V1 notify surface arguments at serialization, use stable route identity for observation, and make observation best-effort.
3. Run focused tests green and prove no duplicate mutation is encouraged.

### Task 5: Evidence and review closure

**Files:** agent report and GitHub review threads

1. Measure terse and full byte sizes from a real live daemon response.
2. Run both full-suite environments, root/site typechecks, D138, perf ratchet, diff check, and archive exact-head verification.
3. Push one reviewed round-2 commit.
4. Reply to and resolve all 37 threads, crediting substantive finders and declining DeepSource-only lint churn.
5. Update the agent report to `REVIEW_NEEDED` with exact head, caller inventory, evidence, absent bot coverage, and the final improvement gate.
