# Fleet Sidebar v1 Design

## Goal

Render the reconciled cmuxlayer agent fleet as a native cmux custom sidebar,
grouped by lane, with truthful screen-derived state and click-to-focus rows.

## Architecture

`AgentEngine.syncSidebar()` already owns the convergence point where registry
records, live surface topology, current screen parsing, and evaluated health are
available together. It will project those values into immutable fleet-seat
candidates and pass them to a pure snapshot builder. The builder filters by the
live surface set, deduplicates by surface ref, normalizes lane/role/name, maps
screen evidence to `working|idle|stalled`, and computes counts.

A `FleetSidebarPublisher` renders that snapshot into cmux's interpreted
SwiftUI-style source and atomically writes
`~/.config/cmux/sidebars/fleet.swift`. It compares exact content before writing,
coalesces pending changes, and uses the output file's mtime as a cross-process
500 ms gate. Unchanged sweeps perform no write. The publisher never changes the
selected sidebar provider.

## Data flow

```text
StateManager + AgentRegistry
        + live SurfaceTopologySnapshot
        + parseScreen evidence / AgentHealth
                    |
                    v
       pure FleetSidebarSnapshot builder
       (live-only, surface-deduped, lane-grouped)
                    |
                    v
        pure snapshot -> fleet.swift renderer
                    |
                    v
   signature/content check + <=2 writes/sec atomic publisher
                    |
                    v
       cmux remote renderer kqueue hot reload
                    |
                    v
  row click -> cmux("surface.focus", surface_id: "surface:N")
```

## UI semantics

- Lane header: canonical lane name, exact live-seat count, exact active-seat
  count. These are computed after live filtering and deduplication.
- State glyph: `working` for parsed `thinking|working`, `idle` for parsed
  `idle|done`, `stalled` for parsed `frozen` or unavailable screen evidence.
  Registry state is never used as the glyph fallback.
- Seat name: live surface title, falling back through seat/launcher/agent
  identity only when the topology lacks a title.
- Status: the registry task/status summary. Missing and repair-placeholder
  values render as an explicit `STATUS NOT SET` warning.
- Health: full evaluated health issue sentences, rendered without a line limit
  and allowed to wrap vertically.
- Age: labeled `seat age`, derived from `created_at`; it therefore has one
  stable meaning and requires no extra timestamp store.
- Collapsed lane: when all live seats are idle, render the header and an exact
  collapsed-idle count but no seat rows. Working/stalled lanes expand
  automatically.
- Interaction: the whole row is a button. Remote mode needs clicks only.

## Lane normalization

Match, in order, across `seat_lane`, repo, seat id, launcher name, agent id, and
surface title:

1. `orc`
2. `golems`
3. `voicelayer`
4. `skillCreator` (`skillcreator` and `skill-creator` spellings)
5. `cmuxlayer`

Unmatched live seats remain visible in an `other` lane rather than being
silently hidden. Leads sort before workers, then seats sort by stable display
name and surface ref.

## Files

- New `src/fleet-sidebar.ts`: pure model, normalizers, renderer, atomic
  coalescing publisher, default path factory.
- Modify `src/agent-engine.ts`: inject publisher, form candidates from the
  existing reconciliation sweep, publish one deduplicated snapshot, dispose
  publisher timers.
- Modify `src/server.ts` and `src/app-server-runtime.ts`: inject the real default
  publisher only in production lifecycle construction; bare tests retain a
  no-op default.
- New `tests/fleet-sidebar.test.ts`: RED-first pure output and publisher budget
  tests.
- Modify `tests/sidebar-sync.test.ts`: prove the engine publishes live
  screen-derived rows and excludes dead surfaces.
- New `assets/sidebars/fleet.swift`: valid empty/fallback render produced by the
  same renderer contract.
- New `scripts/install-fleet-sidebar.mjs`: copy the committed fallback into the
  cmux sidebars directory without selecting it.
- Modify `package.json`/`README.md` only as needed to expose the install step.

## Error handling

- Rendering is pure and escapes every baked string as a Swift-compatible
  quoted literal.
- Output writes use `mkdir`, a same-directory temporary file, and atomic
  rename. A failure is best-effort and does not break lifecycle sweeps.
- A superseded pending snapshot replaces the older pending write.
- `dispose()` cancels any pending timer.
- Empty live topology produces a valid empty fleet sidebar, not stale rows.
- The generated view retains cmux's last-good-render protection if a write is
  interrupted outside the atomic publisher.

## Verification

1. RED/GREEN targeted Vitest runs for generator and engine integration.
2. Full test suite, typecheck, and build.
3. Install the committed fallback, run a real lifecycle sweep, and inspect the
   generated file.
4. `cmux sidebar validate fleet` must report the file valid.
5. `cmux sidebar open fleet`, visually inspect all lanes and wrapped reasons,
   click a row, and confirm focus moved to the baked surface ref.
6. Capture screenshot evidence and include a visual verification receipt.

## Delivery ordering

Open the ready PR titled
`feat(sidebar): fleet.sidebar custom sidebar v1 (registry-fed, lane-grouped, click-to-focus)`.
Flag the PR as queued behind `fix/spawn-reliability-3head`; do not merge it
before that P1 lands. This mission stops at a green reviewed PR unless Etan
separately authorizes merge.
