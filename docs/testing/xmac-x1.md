# Cross-Mac scenarios 1–4

These modules implement the X0 runner's lead-pinned `ctx` contract. They do not
launch cmux, install builds, change authentication, or manage the transport.
The runner provides verbose receipts, independent raw socket screen snapshots,
per-run artifacts, and a final sweep of every spawned seat. Scenarios also call
`ctx.close(agentId)` in `finally`; an unverified close fails the row.

| Module ID | Assertion | Replay references (not live proof) |
| --- | --- | --- |
| `spawn_boot_false_unsubmitted` | A unique authored reply reaches idle; the spawn receipt confirms boot submission. | bug `14aa55b5`; #1019 fix pending |
| `send_idle_claude_deadlock` | An idle Claude accepts a send, then submits its exact owned wrapped draft with one key Return. | bug `ba72bd23`; #1024 merge `ffb9ae9c` |
| `send_under_codex_overlays` | An opportunistically observed overlay permits delivery without scenario-selected setup/trust options. | R1 `send_under_codex_banner`: bug `7f26603f`, fix `64260ba3` |
| `submit_unverified_on_landed` | The same harmless prompt is sent twice; each produces a new authored reply and a verified receipt. | v0.4.97 bug candidate `ff6a560e`; #1000 fix pending |

Scenarios use Claude `haiku` and Codex `gpt-6-luna` with low effort. Each owns
at most one seat. Follow-up prompts are short single lines; the draft case adds
padding to expose wrapping. If the actual pane is too wide to wrap it, the row
fails with `wrapped_draft_not_observed` rather than claiming coverage.

`PASS` requires both receipt and raw-screen proof. Attribution reuses the #998
soak checker: quoted prompts and tool output do not count as authored replies.
The repeat case counts new occurrences, so an old identical response cannot
prove the second submission. Boot's empty baseline is explicitly marked
`observed:false`; a unique token on a newly spawned seat supplies freshness.
An observation timeout retains its last raw screen and closes the seat.

The overlay row is opportunistic. No observed overlay returns
`PRECONDITION_ABSENT`, meaning **not covered**, never green. Its evidence links
to R1's authoritative captured-frame replay. Natural hooks review is tested
without deliberately untrusting hooks; the replay fixture is
`tests/fixtures/composer-overlays/codex-hooks-review.txt`. The scenario never
sends a menu number or a recovery Return. The engine's safe dismissal behavior
is what the send tests. A pass identifies only the observed variant.

Local development verification:

```sh
bun run test tests/xmac-scenarios-x1.test.ts tests/soak-live-checks.test.ts
```

Those are synthetic-context unit tests, not M1 or NIGHTLY runtime evidence.
Bug-to-fix replay still must run through X0's reviewed guard, private daemon
state and recorded-process teardown before any row counts as live proof.
The owned-draft case detects erroneous foreign-draft refusal for its own text;
cross-caller foreign-draft protection remains covered by the engine tests.
