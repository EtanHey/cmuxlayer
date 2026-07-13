# Fleet Sidebar v1 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Generate a rate-limited, registry-faithful `fleet.swift` custom sidebar that groups live agents by lane and focuses their panes on click.

**Architecture:** `AgentEngine` projects its existing reconciled registry, live topology, screen parse, and health evaluation into pure fleet candidates. `src/fleet-sidebar.ts` filters/deduplicates them, renders interpreted Swift source, and atomically publishes only changed content behind a 500 ms cross-process mtime gate.

**Tech Stack:** TypeScript, Node.js filesystem/timers, Vitest, cmux 0.64.17 interpreted SwiftUI custom-sidebar DSL.

---

### Task 1: Pin snapshot normalization and generated Swift output

**Files:**
- Create: `tests/fleet-sidebar.test.ts`
- Create: `src/fleet-sidebar.ts`

**Step 1: Write failing normalization tests**

Cover one candidate per binding rule:

- only refs in `liveSurfaceRefs` survive;
- two candidates for one surface produce one row, preferring managed/newer
  registry evidence;
- voicelayer and both skillCreator spellings normalize correctly;
- lead rows sort before workers;
- parsed `thinking|working`, `idle|done`, `frozen`, and `null` map to
  `working`, `idle`, `stalled` without consulting registry state;
- placeholder/missing task summaries become `STATUS NOT SET`;
- lane counts come from the final deduplicated rows.

Use a wished-for API:

```ts
const snapshot = buildFleetSidebarSnapshot(candidates, {
  liveSurfaceRefs: new Set(["surface:7"]),
});
expect(snapshot.lanes[0].seats[0].screenState).toBe("working");
```

**Step 2: Run the test and verify RED**

Run: `bunx vitest run tests/fleet-sidebar.test.ts`

Expected: FAIL because `src/fleet-sidebar.ts` and its exports do not exist.

**Step 3: Implement minimal snapshot model**

Add exported candidate/snapshot types plus:

```ts
export function toFleetScreenState(
  status: ParsedScreenStatus | null | undefined,
): FleetScreenState;

export function buildFleetSidebarSnapshot(
  candidates: FleetSidebarCandidate[],
  opts: { liveSurfaceRefs: ReadonlySet<string> },
): FleetSidebarSnapshot;
```

Do not perform filesystem I/O in these functions.

**Step 4: Verify GREEN**

Run: `bunx vitest run tests/fleet-sidebar.test.ts`

Expected: all normalization tests pass with zero failures.

**Step 5: Add failing snapshot-to-Swift tests**

Assert generated source contains:

- exact live/active counts;
- a `cmux("surface.focus", surface_id: "surface:7")` action;
- working/idle/stalled glyph semantics;
- no `.lineLimit`/`.truncationMode` on status or health;
- automatic idle-lane collapse branch;
- exact escaped quote, slash, newline, and Unicode values;
- no model label and no decorative progress/bar element.

Use:

```ts
const source = renderFleetSidebar(snapshot);
expect(source).toContain('cmux("surface.focus", surface_id: "surface:7")');
```

**Step 6: Run and verify RED**

Run: `bunx vitest run tests/fleet-sidebar.test.ts`

Expected: FAIL because `renderFleetSidebar` is missing.

**Step 7: Implement the interpreted-Swift renderer**

Generate helper functions followed by one root `VStack`. Bake immutable seat
dictionaries into the source. Use JSON-compatible quoted literals for all
strings. Calculate age in the view from `clock.epoch - seat.createdAtEpoch`.

**Step 8: Verify GREEN**

Run: `bunx vitest run tests/fleet-sidebar.test.ts`

Expected: all generator tests pass.

### Task 2: Enforce coalescing, content dedupe, and atomic writes

**Files:**
- Modify: `tests/fleet-sidebar.test.ts`
- Modify: `src/fleet-sidebar.ts`

**Step 1: Write failing publisher tests**

With a temporary output directory and fake timers, prove:

- first publication creates the directory/file;
- identical generated content does not change mtime;
- multiple changed snapshots inside 500 ms coalesce to the newest snapshot;
- the output mtime delays writes across publisher instances/process-like
  owners;
- writes never exceed two per second;
- `dispose()` cancels a pending write.

**Step 2: Run and verify RED**

Run: `bunx vitest run tests/fleet-sidebar.test.ts`

Expected: FAIL because `FleetSidebarPublisher` is missing.

**Step 3: Implement minimal publisher**

Provide:

```ts
export interface FleetSidebarPublisherLike {
  publish(snapshot: FleetSidebarSnapshot): void;
  dispose(): void;
}

export class FleetSidebarPublisher implements FleetSidebarPublisherLike { ... }
export function defaultFleetSidebarPath(home?: string): string;
```

Before writing, read the current file and compare exact content. Use its mtime
for the 500 ms gate, write to a same-directory temporary path, then rename.
Publishing is best-effort and never throws into the lifecycle sweep.

**Step 4: Verify GREEN**

Run: `bunx vitest run tests/fleet-sidebar.test.ts`

Expected: all publisher tests pass; no leaked fake timers.

### Task 3: Feed the publisher from the existing reconciled sweep

**Files:**
- Modify: `tests/sidebar-sync.test.ts`
- Modify: `src/agent-engine.ts`

**Step 1: Write failing engine integration tests**

Inject a recording `FleetSidebarPublisherLike` into `AgentEngine` and assert a
sweep publishes candidates containing:

- current live surface title/ref;
- `healthInput.screen_status`, not `agent.state`, for the rendered glyph;
- full `health.issues` text;
- task summary/current status;
- seat/repo/launcher/lane identity inputs;
- no record whose surface is absent from the topology;
- one row when duplicate records point at one live surface.

**Step 2: Run and verify RED**

Run: `bunx vitest run tests/sidebar-sync.test.ts`

Expected: FAIL because `AgentEngineOptions` has no fleet publisher and the
sweep publishes nothing.

**Step 3: Add the injection seam and candidate projection**

Add `fleetSidebarPublisher?: FleetSidebarPublisherLike` to
`AgentEngineOptions`, defaulting to a no-op. During `syncSidebar()` build the
snapshot from the already-collected `SurfaceTopologySnapshot`, parsed
`healthInput.screen_status`, registry record, and evaluated health. Publish once
after cleanup/status batching. Call `dispose()` from `AgentEngine.dispose()`.

**Step 4: Verify GREEN**

Run: `bunx vitest run tests/sidebar-sync.test.ts tests/fleet-sidebar.test.ts`

Expected: both files pass.

### Task 4: Wire only real runtime entrypoints

**Files:**
- Modify: `src/server.ts`
- Modify: `src/app-server-runtime.ts`
- Modify: relevant existing server/app-runtime tests if needed

**Step 1: Write or extend a failing construction test**

Assert bare/test construction remains filesystem-side-effect free while an
explicit/default production publisher is forwarded into the lifecycle engine.

**Step 2: Run and verify RED**

Run the smallest relevant server/app runtime test selected from test names
after inspection.

Expected: FAIL because production construction does not inject the publisher.

**Step 3: Inject the publisher**

Create one `FleetSidebarPublisher` per real lifecycle engine using
`defaultFleetSidebarPath()`. Preserve no-op behavior for directly constructed
test engines. Do not call `cmux sidebar select` and do not write settings.

**Step 4: Verify GREEN**

Run the targeted server/app-runtime tests plus the two sidebar files.

### Task 5: Commit the fallback asset and install step

**Files:**
- Create: `assets/sidebars/fleet.swift`
- Create: `scripts/install-fleet-sidebar.mjs`
- Modify: `tests/fleet-sidebar.test.ts`
- Modify: `package.json`
- Modify: `README.md`

**Step 1: Write a failing asset parity/install test**

Assert the committed asset equals `renderFleetSidebar({ lanes: [] })` and the
installer copies it into a temporary `$HOME/.config/cmux/sidebars/fleet.swift`
without changing cmux selection/settings.

**Step 2: Run and verify RED**

Run: `bunx vitest run tests/fleet-sidebar.test.ts`

Expected: FAIL because asset and installer do not exist.

**Step 3: Add asset and installer**

Add `bun run install:fleet-sidebar` invoking the Node installer. The installer
creates the directory and copies the fallback only; the live publisher later
replaces the installed copy atomically. Document that the picker remains on the
stock sidebar until the user chooses `fleet`.

**Step 4: Verify GREEN**

Run the targeted test and a temp-home installer smoke test.

### Task 6: Verify generated output against live cmux

**Files:**
- Update: `docs.local/design/2026-07-13-sidebar-format-notes.md` only if runtime discovery differs
- Generate locally: `~/.config/cmux/sidebars/fleet.swift`
- Capture locally: screenshot evidence under `docs.local/` or another PR-safe tracked path

**Step 1: Run static verification**

Run:

```bash
bun run typecheck
bun run build
bunx vitest run tests/fleet-sidebar.test.ts tests/sidebar-sync.test.ts
bun test
```

Read full output and record exact pass/fail/warning counts.

**Step 2: Install and publish**

Run `bun run install:fleet-sidebar`, then invoke one real lifecycle sweep using
the live-source runtime. Confirm the installed source contains only the current
live surface refs returned by `list_surfaces`.

**Step 3: Validate syntax**

Run: `cmux sidebar validate fleet --json`

Expected: one valid sidebar, zero errors.

**Step 4: Open and visually inspect**

Run: `cmux sidebar open fleet`. Use computer-use or equivalent pixel-capable
tool to inspect every visible lane, counts, wrapping, collapse behavior, and
glyphs. Save a screenshot.

**Step 5: Click-test focus**

Record focused surface, click a different row, then query focused surface
again. Expected: the focused ref/UUID matches the row's baked action target.

### Task 7: PR, review, and queue handoff

**Files:**
- All scoped implementation/docs/assets above

**Step 1: Re-run completion verification**

Freshly run typecheck, build, full tests, syntax validation, live click test,
and visual inspection. Re-read every changed file and inspect `git diff`.

**Step 2: Run bounded local review**

Run `coderabbit review --agent` with the skill-prescribed bounded timeout. Fix
critical/major findings with RED-first regressions.

**Step 3: Commit intentionally**

Stage only scoped tracked files. Do not commit `docs.local` fallback/format
cache unless separately required. Commit with an intentional feature message.

**Step 4: Push and create the ready PR**

Title:

```text
feat(sidebar): fleet.sidebar custom sidebar v1 (registry-fed, lane-grouped, click-to-focus)
```

The body must include format findings, exact tests, visual verification receipt,
one right-click activation instruction, and a prominent hold:

```text
MERGE QUEUE HOLD: merge after fix/spawn-reliability-3head lands.
```

**Step 5: Request and process reviews**

Invoke available reviewers, wait for actual comments/checks, read every review,
reply to all high/critical/major items, fix real findings, and request re-review.

**Step 6: Stop at the authorized endpoint**

Report the green reviewed PR URL and its explicit spawn-reliability dependency.
Do not merge until the P1 lands and Etan authorizes merge.
