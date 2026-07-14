# Sidebar Render Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove misleading lane carets, republish Claude and Codex screen-derived sidebar state promptly and without shrink on wake signals, isolate development output, and lock the collapse/status density contract.

**Architecture:** Keep `FleetSidebarPublisher` as the only generated-file writer. Render explicit non-interactive lane state plus a visible CLI command, add a debounced `AgentEngine` entry point that reuses `syncSidebar()` after agent delivery/inbox wake events without invoking the full sweep, and force development/QA through `fleet-dev.swift` or an injected temporary path.

**Tech Stack:** TypeScript, generated Swift source, Vitest, cmux lifecycle MCP server.

---

### Task 1: Replace misleading lane carets

**Files:**
- Modify: `src/fleet-sidebar.ts`
- Test: `tests/fleet-sidebar.test.ts`
- Create: `docs/plans/2026-07-14-sidebar-render-polish-design.md`
- Create: `docs/plans/2026-07-14-sidebar-render-polish.md`

**Step 1: Write the failing test**

Assert rendered lane headers contain muted `collapsed`/`expanded` state text,
contain neither disclosure caret nor a lane-header `Button`, and visibly render
the appropriate CLI expand/collapse command in addition to CLI help. Assert a
collapsed lane with a lead always retains lead name, one-line status, counts,
and hidden-seat total.

**Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/fleet-sidebar.test.ts -t 'renders lane collapse state without a clickable-looking caret'`

Expected: FAIL because the header still emits `▸`/`▾`.

**Step 3: Write minimal implementation**

Replace the caret `Text` with `Text(collapsed ? "collapsed" : "expanded")`,
using the existing compact monospaced font and tertiary color. Add a compact,
one-line CLI command below the header. Keep automatic quiet-lane collapse.

**Step 4: Run tests and commit**

Run: `bunx vitest run tests/fleet-sidebar.test.ts`

Commit: `fix(sidebar): remove misleading lane carets`

### Task 2: Republish screen state after wake signals

**Files:**
- Modify: `src/agent-engine.ts`
- Modify: `src/server.ts`
- Test: `tests/inbox-nudge.test.ts`

**Step 1: Write the failing test**

Create an idle Claude seat plus four retained lanes, publish the initial full
snapshot, then change the Claude screen to a timed arbitrary spinner phrase and
dispatch through the fresh-monitor wake path. Exercise the real publisher with
an injected temporary output, advance past both the 500 ms sync debounce and
publisher rate gate, then assert within a bounded timeout that no manual sweep
is called and exactly one full five-seat publication containing the working
action replaces the stale source. Assert every wake publication preserves all
five lanes.

**Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/inbox-nudge.test.ts -t 'republishes a Claude idle-to-working transition without shrinking any lane'`

Expected: FAIL because the Claude spinner phrase currently parses idle and the
sidebar publication remains stale.

**Step 3: Write minimal implementation**

Add `AgentEngine.requestFleetSidebarRepublish()` with one 500 ms timer. Its
callback runs `syncSidebar()` through `runLifecycleMutation()`. Trigger it after
inbox dispatch and successful direct delivery; clear it during disposal. Teach
the screen parser to recognize Claude timed spinner phrases as working and use
their phrase as `current_action`.

**Step 4: Run tests and commit**

Run: `bunx vitest run tests/inbox-nudge.test.ts tests/server-agent-tools.test.ts tests/sidebar-sync.test.ts tests/fleet-sidebar.test.ts`

Commit: `fix(sidebar): republish promptly after wake events`

### Task 3: Isolate development and test publication paths

**Files:**
- Modify: `src/fleet-sidebar.ts`
- Modify: `package.json`
- Modify: `README.md`
- Create: `scripts/install-fleet-sidebar-dev.mjs`
- Test: `tests/fleet-sidebar.test.ts`

Add `defaultFleetSidebarDevPath()`, a `fleet-dev.swift` installer, and pin
`bun run dev` to `CMUXLAYER_FLEET_SIDEBAR_OUTPUT_PATH=.../fleet-dev.swift`.
Reject a publisher without explicit `outputPath` under Vitest. Prove the dev
installer creates only the staging picker entry and does not mutate cmux
settings or `fleet.swift`.

### Task 4: Lock long parsed-action density

**Files:**
- Test: `tests/fleet-sidebar.test.ts`

**Step 1: Strengthen the existing fixture**

Use an overflowing `screenCurrentAction` with `taskSummary: null`, verify it is
the emitted status, and scope the one-line/tail assertions to the seat status
block while keeping actionable health free of line limits. Assert the collapsed
lead status block has the same cap.

**Step 2: Run focused and full verification**

Run: `bunx vitest run tests/fleet-sidebar.test.ts -t 'caps a long parsed action at one line while leaving actionable health multiline'`

Run: `bun run test && bun run typecheck && bun run build`

Expected: all commands exit 0.

**Step 3: Commit**

Commit: `test(sidebar): lock parsed-action density`

### Task 5: Review, visual evidence, and delivery

**Files:**
- Create: `docs/assets/sidebar-render-polish.png`

Install the generated sidebar from this branch as `fleet-dev`, never `fleet`,
and hash the production file before and after QA to prove it is unchanged.
Exercise expanded/collapsed
headers plus a long status and wake, capture and inspect the rendered sidebar,
then run the full PR review loop. Push exactly three commits, open the requested
ready-for-review PR, attach the screenshot, post its URL to driver-buddy, and
iterate until required checks/reviews are green. Do not merge; the lead owns the
ordering behind the seat-binding mission.
