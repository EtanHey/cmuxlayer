# Suite Determinism Design

## Root cause

Vitest file parallelism exposes test-harness races rather than product defects:

- `enter-reliability.test.ts` models a slow composer by clearing after a fixed
  number of `readScreen` calls, while production verification stops against a
  real five-second deadline. Scheduler delay under parallel load changes whether
  the final read occurs before the deadline. Its routing-only server also starts
  an unrelated lifecycle sweep at the same five-second boundary.
- `server.test.ts` drives submit and boot-prompt polling with real timers,
  including a negative case that consumes the full production deadline. These
  tests compete for wall-clock budget with other workers.
- `inbox-nudge.test.ts` creates lifecycle servers without disposing their agent
  engines, leaving background sweep timers behind after each test.

The default-parallel three-file run reproduced one failure among 177 tests. The
same files passed 177/177 with file parallelism disabled, localizing the trigger
to scheduler contention.

## Fix

Keep production timing behavior unchanged. Make tests control time explicitly:

1. Use Vitest fake timers to advance submit-verification and boot-prompt polling
   without consuming wall-clock budget.
2. Stop lifecycle sweeps immediately in routing-only test servers; the engine's
   registry and routing behavior remain available.
3. Close or dispose every lifecycle server during teardown.
4. Keep default Vitest file parallelism and do not add retries or blanket timeout
   increases.

## Verification

- Confirm the previously failing parallel reproduction is green.
- Run the three formerly flaky files ten fresh-process times.
- Run the entire suite five fresh-process times.
- Run typecheck and build.

