# Sidebar First Paint Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Populate `fleet.swift` from live cmux surfaces during the first lifecycle startup and make reconnect publication monotonic so an empty or partial per-process registry cannot replace a populated last-good fleet.

**Architecture:** Add one idempotent lifecycle initializer to `AgentEngine` that publishes a `discovering` state, reconstitutes persisted state, performs one forced additive `AgentDiscovery` merge, and performs the first sidebar sync before callers arm the normal sweep timer. Publication carries an explicit `discovering | populated | empty | unknown` state plus observed live surface refs. A first-connect zero-seat result remains `unknown`; only a later complete zero-surface sweep is authoritative `empty`. `FleetSidebarPublisher` embeds state metadata in generated Swift and preserves an existing populated source whenever discovery/topology is non-authoritative or omitted seat surfaces are still live. Both `createServer` (shared by daemon and in-process entry paths) and `CmuxAppServerRuntime` use the initializer, while lifecycle registry mutations are serialized so scheduled sweeps cannot race explicit resyncs.

**Tech Stack:** TypeScript, Vitest, Swift custom-sidebar source generation, Node filesystem publisher.

---

### Task 1: Reproduce cold-start discovery failure

**Files:**
- Modify: `tests/sidebar-sync.test.ts`
- Modify: `tests/app-server-runtime.test.ts`

**Step 1: Write the failing engine startup test**

Construct an empty `StateManager`/`AgentRegistry`, a real `AgentDiscovery` over one mocked terminal surface, and a recording publisher. Call the wished-for `engine.initialize(discovery)` twice and assert:

```ts
expect(discovery.scan).toHaveBeenCalledTimes(1);
expect(publishedFleetSnapshots.at(-1)).toMatchObject({
  seatCount: 1,
  lanes: [{ seats: [{ surfaceRef: "surface:42" }] }],
});
```

**Step 2: Write the failing app-server startup test**

Give `CmuxAppServerRuntime` one workspace/pane/surface whose screen identifies a Codex agent, call `initialize()`, and assert the injected publisher's first populated snapshot contains that surface without manually touching `resync_agents`.

**Step 3: Run the focused tests and confirm RED**

Run:

```bash
bunx vitest run tests/sidebar-sync.test.ts tests/app-server-runtime.test.ts
```

Expected: FAIL because `AgentEngine.initialize` does not exist and app-server `initialize()` only reconstitutes persisted records.

### Task 2: Define and RED-test monotonic publication states

**Files:**
- Modify: `src/fleet-sidebar.ts`
- Modify: `tests/fleet-sidebar.test.ts`

**Step 1: Write failing transition tests**

Introduce the wished-for `FleetSidebarPublication` contract:

```ts
type FleetSidebarPublicationState =
  | "discovering"
  | "populated"
  | "empty"
  | "unknown";

interface FleetSidebarPublication {
  state: FleetSidebarPublicationState;
  snapshot: FleetSidebarSnapshot;
  observedLiveSurfaceRefs: string[] | null;
}
```

Test these transitions against a real temporary `fleet.swift`:

1. `populated(15)` → `unknown(1)` preserves the 15-seat bytes.
2. `populated([surface:1, surface:2])` → `populated([surface:1])` is rejected while `surface:2` remains observed live.
3. The same decrease is accepted once `surface:2` is absent from observed live refs.
4. `populated` → `empty` is rejected when any live surface remains and accepted only when the observed set is empty.
5. A legacy unmarked v0.4.5 populated source is recognized from its generated seat dictionaries/header.

**Step 2: Run the focused test and confirm RED**

Run:

```bash
bunx vitest run tests/fleet-sidebar.test.ts
```

Expected: FAIL because the publisher accepts only a raw snapshot and has no state/last-good gate.

**Step 3: Implement the minimal publisher gate**

- Render a metadata comment containing state and rendered count.
- Recover prior state/count/surface refs from the current source, including legacy generated source.
- Preserve populated bytes for `discovering` and `unknown`.
- Reject a candidate decrease while any omitted prior seat surface remains observed live.
- Allow authoritative empty only with an observed empty surface set.
- Retain the source baseline for delayed writes and revalidate at flush time so a stale timer cannot shrink a newer cross-process publication.
- Keep byte dedupe, atomic rename, and the 500 ms cross-process write floor unchanged.

**Step 4: Run the focused test and confirm GREEN**

Run:

```bash
bunx vitest run tests/fleet-sidebar.test.ts
```

Expected: PASS, including all existing publisher budget tests.

### Task 3: Implement one-shot startup discovery and serialized first sync

**Files:**
- Modify: `src/agent-engine.ts`
- Modify: `src/server.ts`
- Modify: `src/app-server-runtime.ts`

**Step 1: Add the minimal engine initializer**

Add an idempotent `initialize(discovery: AgentDiscovery): Promise<void>` backed by a cached promise. Publish `discovering`, perform exactly one physical discovery, feed the returned evidence into an additive `AgentRegistry.listMerged`, then run the first `syncSidebar({ firstConnect: true })` without advancing the existing deferred startup-purge semantics:

```ts
this.publishFleetState("discovering", [], null);
await this.registry.reconstitute();
this.enableStartupPurge();
const discovered = await discovery.scan(true);
await this.registry.listMerged(discovery, {
  discovered,
  nonDestructive: true,
});
await this.syncSidebar({ firstConnect: true });
```

Keep the existing `runSweep()` startup-purge path unchanged so this mission does not alter terminal-record cleanup timing. Serialize lifecycle mutations through the engine so an explicit `resync_agents` cannot interleave registry changes with a scheduled sweep.

**Step 2: Route every production construction path through it**

- In `createServer`, replace the reconstitute-only startup promise with `engine.initialize(discovery)`, then arm `startSweep(resolveSweepTiming())` after the initializer settles. Lifecycle discovery/resync handlers must await that shared promise so they cannot race the first scan. This covers the daemon's shared context and in-process `entry.ts` path.
- In `CmuxAppServerRuntime`, construct one `AgentDiscovery` from its surface provider and call `await engine.initialize(discovery)` before `startSweep()`.

**Step 3: Run the focused tests and confirm GREEN**

Run:

```bash
bunx vitest run tests/sidebar-sync.test.ts tests/app-server-runtime.test.ts
```

Expected: PASS; the forced discovery scan is observed once and the first published fleet contains the live seat.

### Task 4: Make the fallback visibly nonblank

**Files:**
- Modify: `src/fleet-sidebar.ts`
- Modify: `assets/sidebars/fleet.swift`
- Modify: `tests/fleet-sidebar.test.ts`

**Step 1: Write the failing placeholder assertion**

Assert that rendering an empty snapshot contains `Discovering fleet seats…` and explains that reconnect discovery populates the view. Keep the existing assertion that the committed fallback asset is byte-identical to the empty generator output.

**Step 2: Run the focused test and confirm RED**

Run:

```bash
bunx vitest run tests/fleet-sidebar.test.ts
```

Expected: FAIL because the current empty content says only `No live fleet seats`.

**Step 3: Implement the placeholder**

Change only the empty-content branch in `renderFleetSidebar`, then update `assets/sidebars/fleet.swift` to the exact generated empty output. Do not change publisher timing or atomic-write behavior.

**Step 4: Run the focused test and confirm GREEN**

Run:

```bash
bunx vitest run tests/fleet-sidebar.test.ts
```

Expected: PASS, including all publisher coalescing/budget tests.

### Task 5: Prove last-good and full-suite safety

**Files:**
- Verify: `tests/sidebar-sync.test.ts`
- Verify: `tests/fleet-sidebar.test.ts`

**Step 1: Run the explicit regression set**

Run:

```bash
bunx vitest run tests/sidebar-sync.test.ts tests/fleet-sidebar.test.ts tests/app-server-runtime.test.ts tests/resync-tool.test.ts tests/entry.test.ts tests/daemon.test.ts
```

Expected: PASS. In particular, the three `preserves the last generated fleet` tests remain green and the publisher's 500 ms coalescing tests remain green.

**Step 2: Run repository verification**

Run:

```bash
bun run typecheck
bun run test
bun run build
```

Expected: all commands exit 0 with zero failed tests.

### Task 6: Verify a real fresh reconnect and deliver the PR

**Files:**
- Create: `docs/assets/sidebar-first-paint.png` only if the screenshot is suitable and intentionally committed.

**Step 1: Install/restart the branch build and reconnect a fresh client**

Build the branch, run the repository's supported local install/restart path, reconnect a new MCP client without invoking `resync_agents`, and select the `fleet` custom sidebar.

**Step 2: Capture and inspect screenshot proof**

Use an actual screenshot-capable tool. Verify the rendered pixels show at least one live fleet seat on first paint; do not infer this from `fleet.swift` text alone.

**Step 3: Run pre-commit review and commit**

Run bounded CodeRabbit CLI review, address actionable findings, stage only mission files, and commit with:

```bash
git commit -m "fix(sidebar): populate fleet.swift on first connect"
```

**Step 4: Push and open the requested ready-for-review PR**

Push `fix/sidebar-first-paint` and open a PR titled:

```text
fix(sidebar): populate fleet.swift on first connect (no empty first paint after reconnect)
```

Include RED/GREEN commands, full verification counts, last-good evidence, and screenshot proof. Invoke available reviewers, read every response/check, and address all critical/major/high findings. Mission endpoint is a green PR URL; do not merge unless separately directed by the mission owner.

**Step 5: Post one-place delivery and persist the milestone**

Post the verified PR URL and screenshot receipt to the driver-buddy channel and current pane, then store WHAT changed and WHY in BrainLayer.
