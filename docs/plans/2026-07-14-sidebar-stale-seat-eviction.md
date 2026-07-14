# Sidebar Stale-Seat Eviction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the normal lifecycle sweep evict registry seats whose surfaces are authoritatively gone, while keeping transient empty/partial scans non-destructive and removing registry-binding diagnostics from visible fleet row text.

**Architecture:** Reuse `AgentRegistry.evictSurfaceless()`, the same non-empty-topology-safe primitive used by `resync_agents`, in the normal sweep after reconciliation and before crash recovery. The registry records when each specific agent/surface pair is first observed absent and requires another authoritative miss after one confirmation window before permanent deletion; any authoritative live observation resets that evidence. The same gate applies to periodic terminal-worker cleanup and ordinary `listMerged()` reads, so neither can bypass confirmation. Startup purge still removes genuinely carried-over terminal records whose refs may have been recycled, but retains records that the current startup scan itself just marked surfaceless. The first authoritative omission still removes the row from the published snapshot, while a just-created surface omitted during cmux render lag is not destroyed. Keep the #316 publisher state machine intact. Extend the pure sidebar content projection with an explicit set of non-actionable binding diagnostics, leaving genuinely actionable health reasons visible.

**Tech Stack:** TypeScript, Vitest, generated SwiftUI custom-sidebar source, cmux live screenshot verification.

---

### Task 1: Pin authoritative sweep eviction with RED tests

**Files:**
- Modify: `tests/sidebar-sync.test.ts`

**Step 1: Write the failing authoritative-gone test**

Seed a stale non-Claude registry record assigned the orchestrator role on `surface:ghost`, then expose an authoritative non-empty topology containing only `surface:notes`. Run the normal `AgentEngine.runSweep()` path without `resync_agents`. Assert the first publish omits the ghost while the just-transitioned record remains available for confirmation; advance the clock one confirmation window, sweep again, and assert:

```ts
expect(engine.getAgentState("ghost-voicelayer-codex")).toBeNull();
expect(publishedFleetPublications.at(-1)?.snapshot.lanes)
  .not.toContainEqual(expect.objectContaining({
    seats: expect.arrayContaining([
      expect.objectContaining({ surfaceRef: "surface:ghost" }),
    ]),
  }));
```

**Step 2: Write the transient-empty preservation test**

Seed the same live registry record, return an empty surface-provider result and an empty/unknown topology, run one normal sweep, and assert the registry record remains plus the fleet publication state is `unknown`.

**Step 3: Run RED**

Run:

```bash
bunx vitest run tests/sidebar-sync.test.ts
```

Expected: the authoritative-gone assertion fails because only `resync_agents` calls `evictSurfaceless()`; the transient-empty case remains preserved.

### Task 2: Pin binding-diagnostic content filtering with RED tests

**Files:**
- Modify: `tests/fleet-sidebar.test.ts`

**Step 1: Add the failing pure projection test**

Build a live candidate whose only health issues are registry/topology binding artifacts:

```ts
healthIssueCodes: [
  "seat_identity_mismatch",
  "non_claude_orchestrator",
  "orchestrator_not_leftmost",
  "worker_in_leftmost_column",
  "registry_surface_workspace_mismatch",
]
```

Give each code a blocking severity and its real reason text. Assert the projected seat has `healthVisible: false`, `health: ""`, and rendered source contains none of those reasons. Add one `agent_wedged` reason in a second candidate and assert that genuinely actionable health still renders.

**Step 2: Run RED**

Run:

```bash
bunx vitest run tests/fleet-sidebar.test.ts
```

Expected: FAIL because the existing sidebar diet suppresses four informational codes but still renders blocking binding diagnostics.

### Task 3: Implement minimal normal-sweep eviction

**Files:**
- Modify: `src/agent-engine.ts`

**Step 1: Reuse the authoritative-safe registry primitive**

In `runSweepOnce()`, call `await this.registry.evictSurfaceless({ confirmationMs, now })` immediately after `reconcile()` and before `recoverCrashedAgents()`. Track first-observed absence by agent id plus surface ref inside the registry; do not infer confirmation from generic record age. Pass the same confirmation observation to `purgeTerminal()` so terminal worker cleanup cannot delete on the first miss. This order lets the first sweep filter a missing row from the snapshot, preserves crash-recovery-eligible records, and avoids permanently evicting a just-created surface during cmux render lag.

Add optional confirmation timing to `AgentRegistry.evictSurfaceless()` and `purgeTerminal()`. Keep explicit `resync_agents` eviction immediate, but make `purgeTerminal()` confirmation-safe by default so ordinary `list_agents`/`my_agents` reads cannot bypass the sweep gate; focused maintenance callers may opt into zero-delay cleanup explicitly. The primitive continues to treat thrown or empty enumeration as inconclusive and only evicts when a non-empty live set specifically omits a candidate seat surface across the confirmation window.

**Step 2: Run focused GREEN**

Run:

```bash
bunx vitest run tests/sidebar-sync.test.ts tests/agent-engine.test.ts tests/agent-registry.test.ts tests/resync-tool.test.ts
```

Expected: PASS, including crash-recovery and never-empty preservation coverage.

### Task 4: Implement the sidebar binding-diagnostic gate

**Files:**
- Modify: `src/fleet-sidebar.ts`

**Step 1: Extend the explicit non-actionable set**

Add the five binding-only codes from Task 2 to `NON_ACTIONABLE_SIDEBAR_HEALTH_CODES`. Keep severity gating for every other code, so `degraded` or `blocking` operational failures such as `agent_wedged`, dead PTY, collapsed monitor, incomplete PR loop, or missing closure artifact still render.

**Step 2: Run focused GREEN**

Run:

```bash
bunx vitest run tests/fleet-sidebar.test.ts tests/sidebar-sync.test.ts
```

Expected: PASS with no binding reason strings in row dictionaries and actionable health unchanged.

### Task 5: Verify behavior and capture the screenshot fixture

**Files:**
- Create: `docs/assets/sidebar-stale-seat-eviction.png`

**Step 1: Run static verification**

Run:

```bash
bun run typecheck
bun run build
bun run test
git diff --check
```

Expected: all commands exit 0 with zero failed tests.

**Step 2: Exercise the real next-sweep scenario**

Build/install the branch-supported local runtime, open a disposable live managed surface, let the fleet sidebar publish it, close that surface, and wait for the next lifecycle sweep without invoking `resync_agents`.

**Step 3: Capture and inspect visual evidence**

Open the real `fleet` custom sidebar and capture `docs/assets/sidebar-stale-seat-eviction.png`. Inspect the pixels and verify the closed seat is absent, remaining live rows are present, and no row contains any binding-diagnostic reason text. Record the `/never-fabricate` visual verification receipt in the PR.

### Task 6: Deliver the requested PR and review loop

**Files:**
- All scoped source, test, plan, and screenshot files above

**Step 1: Run bounded local review**

Run `coderabbit review --agent --type uncommitted` with a bounded timeout. Read and disposition every critical/high finding; if unavailable or rate-limited, record that limitation and rely on fresh verification plus PR-level reviewers.

**Step 2: Commit and push**

Stage only the mission files and commit with:

```text
fix(sidebar): auto-evict ghost seats on sweep
```

Push `fix/sidebar-stale-seat-eviction`.

**Step 3: Open the ready-for-review PR**

Use the exact requested title:

```text
fix(sidebar): auto-evict ghost seats on sweep + stop registry binding codes leaking as row status
```

Include RED/GREEN evidence, full-suite counts, the screenshot, and its visual receipt. Invoke available reviewers, wait for and read their responses, fix or explicitly reply to every critical/major/high finding, and re-run affected verification after changes.

**Step 4: One-place delivery and persistence**

Post the verified PR URL and screenshot receipt to the driver-buddy channel. Store WHAT changed and WHY in BrainLayer. The mission endpoint is the green reviewed PR plus screenshot; do not merge unless the mission owner separately expands the endpoint.
