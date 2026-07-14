# Sidebar Render Polish Design

## Scope

Polish the generated fleet sidebar without changing the seat-binding contract.
The work covers three independent presentation/propagation concerns while
preserving collapse state, first-paint protection, stale-seat eviction,
severity-gated health, click-to-focus, and the 500 ms publisher gate.

## Caret affordance

Lane headers currently show disclosure carets even though the clicks-only
renderer cannot attach a collapse action to them. A lane also has no single
surface that would make focus wiring truthful. Replace the carets with muted,
non-interactive `collapsed`/`expanded` state text and retain the existing help
text that explains the CLI collapse command. The command is also rendered as a
visible, one-line `cmuxlayer fleet-sidebar expand/collapse <lane>` row instead
of relying on hover discovery. Seat rows remain focus buttons; lane chrome is
plain `Text`, never a fake button. Automatic quiet-lane collapse remains
`activeCount === 0`.

A collapsed lane always retains its lead identity and one-line lead status,
lane live/active counts, and hidden-seat total. This is a source-generation
invariant, not a best-effort summary.

## Wake republish

Treat a successful agent delivery or inbox dispatch as a wake signal. Debounce
those signals for 500 ms inside `AgentEngine`, then run only the existing
sidebar synchronization path under the lifecycle mutation lock. Do not run the
full reconciliation sweep. The delayed sync re-reads every registered seat's
screen state/current action and passes the full populated snapshot through
`FleetSidebarPublisher`, whose
existing cross-process rate limit and never-empty-overwrite state machine remain
the sole write authority. Multiple signals inside the window collapse to one
sync, including a dispatch that also sends a fallback nudge.

Claude Code's timed spinner phrases are part of that transition contract. A
line such as `✳ Boondoggling… (4m 12s · ↓ 571 tokens · thinking…)` must parse as
working and surface `Boondoggling` as the current action; otherwise no visible
idle-to-working transition exists for the shared wake publisher to publish.

## Output-path isolation

Production continues to publish to `fleet.swift`, but development runtime and
visual QA publish only to the separate `fleet-dev.swift` picker entry. Tests
must inject a temporary `outputPath`; a bare publisher construction under
Vitest is rejected. Staging uses an adjacent collapse-state fixture so neither
preview output nor preview collapse choices can mutate the live board.

## Status density

Main already caps both seat and collapsed-lead status text with
`.lineLimit(1).truncationMode(.tail)`. Preserve that implementation. Strengthen
the regression fixture so status comes from a genuinely long
`screenCurrentAction` fallback, and verify the exact status block is capped
while actionable health remains multiline. The same cap is asserted on the
collapsed lead summary.

## Verification

Each new behavior is covered at its owning boundary: generated Swift source for
the caret and density rules, and the real dispatch-to-engine-to-publisher path
for wake propagation. Final verification includes the focused suites, full
tests, typecheck, build, a rendered screenshot, and PR review/CI.
