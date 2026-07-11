# R7 Continuous CI Design

## Scope

SEAT A has two related deliverables: remove the remaining CI-sensitive timing
race in `tests/server.test.ts`, and package the real-cmux contract lane as an
Etan-gated nightly LaunchAgent for the M4 NIGHTLY instance. SEAT B placement
work and SEAT C daemon/fixture hygiene are explicitly out of scope.

## A1: fake-time progress must follow async progress

The existing `runWithFakeTimers` helper spends its fixed fake-time allowance on
every loop iteration, even when the tool handler is still crossing non-timer
async boundaries and has not scheduled its next poll. On a loaded runner the
helper can exhaust 1,000 ms of fake time first, then await a handler whose timer
was scheduled after the fake clock stopped. Vitest eventually kills the test at
its real ten-second ceiling.

The harness will yield real event-loop turns while no fake timer is pending and
will snapshot pre-existing timers before the handler starts. Fake time advances
only while the handler has added a timer above that baseline, so unrelated
lifecycle intervals cannot consume its budget. It retains a bounded fake
deadline and bounded turn count so a broken handler fails immediately rather
than hanging against Vitest's wall clock.

The loaded run exposed two sibling harness races as well. Update-menu/relaunch
tests still used real wall time and are moved onto the same fake-clock driver.
The persisted-registry assertion raced the server's documented async startup
reconstitution and now awaits that promise explicitly. Finally, every static
`/tmp/cmuxlayer-*` fixture root in this file is scoped by process and Vitest
worker ID; concurrent test processes can no longer delete or overwrite one
another's prompt, state, or event-log files. Production polling and timeout
values remain unchanged.

## A2: nightly LaunchAgent and ancestry finding

The bundle mirrors `launchd/cmux-caffeinate`: a small Bash entrypoint, a plist,
shell tests, and an operator README. The script pins
`CMUX_SOCKET_PATH=/tmp/cmux-nightly.sock`, runs `bun run test:contract` from the
canonical checkout, classifies the existing terminal marker as `pass`, `fail`,
or `skip`, and writes `~/.local/state/cmux/contract-nightly-YYYY-MM-DD.json`.
Raw stdout/stderr remains in a sibling durable log referenced by the receipt.
Pass and skip require exactly one terminal marker as the final non-empty line;
duplicates or trailing output are failures.

A plain LaunchAgent is descended from launchd, not from a cmux terminal. The
contract lane deliberately verifies that detached/orphan callers are denied by
cmux's ancestry access control, so launchd cannot manufacture the required pane
ancestry. The job is therefore best-effort: a `skip` is recorded distinctly and
means the runner was not admitted, never that the contract passed. Installation
stays Etan-gated; this change will not call `launchctl bootstrap`.

## Verification

- Add a regression case whose handler crosses many real event-loop turns before
  scheduling its fake timeout while an unrelated interval exists, and observe
  it fail with the old helper.
- Add shell tests for pass/fail/skip JSON receipts, the nightly socket pin,
  plist scheduling, syntax, and executable bits.
- Run the affected server tests ten fresh processes under fork pooling while a
  CPU load is active.
- Run the full server file in concurrent fresh processes to prove fixture roots
  do not collide.
- Run the shell tests, full suite, typecheck, and build.
