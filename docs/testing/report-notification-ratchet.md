# Report notification regression ratchet

These synthetic rows prevent completion loss in the contracted report sweep.
They replay the reviewed bug commit `09e78e51548bfc452474e4525887bc670d7400bc`
against the same tests used for the fix. The exact fix SHA, source/test hashes,
per-row results and logs belong in the lane's `r2-ratchet-receipt.json` under
`docs.local/report-done-only/`. Missing rows or any candidate failure fail the
ratchet. This is local engine and captured transport evidence, not live proof.

| Durable row | Test selector | Required behavior |
| --- | --- | --- |
| report-reopen-fast-done | R2-A fast verified follow-up DONE_REPORT_EPISODE | Rewritten DONE between sweeps produces one further DONE. |
| report-reopen-fast-blocked | R2-A fast verified follow-up BLOCKED_REPORT_EPISODE_CHILD | Rewritten BLOCKED between sweeps starts a new episode and produces one BLOCKED. |
| report-reopen-early-artifact | R2-B report written before observed reopened work | Artifact written after delivery remains eligible after later work observation. |
| report-restart-busy-done | R2-C1 pending busy DONE_REPORT_EPISODE | DONE held for a busy screen survives restart and delivers once when resting. |
| report-restart-busy-blocked | R2-C1 pending busy BLOCKED_REPORT_EPISODE_CHILD | BLOCKED held for a busy screen survives restart and delivers once when resting. |
| report-restart-retry-done | R2-C2 failed DONE_REPORT_EPISODE | Failed DONE delivery retries after restart without duplicates. |
| report-restart-retry-blocked | R2-C2 failed BLOCKED_REPORT_EPISODE_CHILD | Failed BLOCKED delivery retries after restart without duplicates. |
| report-observer-no-ack-done | R2-N1 app-server cannot acknowledge an undelivered DONE_AGENT_1 | App-server leaves DONE unacknowledged; the delivery engine subsequently sends once. |
| report-observer-no-ack-blocked | R2-N1 app-server cannot acknowledge an undelivered BLOCKED_AGENT_1 | App-server leaves BLOCKED unacknowledged; the delivery engine subsequently sends once. |

The reopen/restart rows are in `tests/agent-reconcile.test.ts`; the observer
rows exercise the production app-server wiring in `tests/app-server-runtime.test.ts`.

Run through the shared heavy-suite queue with `GOLEMS_HEAVY_MAX_LOAD=40`:

```sh
bun run test tests/agent-reconcile.test.ts tests/app-server-runtime.test.ts -t 'R2-'
```

The surrounding suites also retain no-work reopen, unchanged/stale artifacts,
legacy startup silence, separate DONE/BLOCKED receipts, delivered restart dedupe,
prompt/pause/error/stop gates, and public watch delivery. The captured MCP spawn
fixture in `tests/p11-spawn-contract.test.ts` restarts with a pending DONE before
resting and verifies the guarded parent relay still delivers it once.

## F1 input-iteration rows

Replay these two rows against reviewed parent
`9cbbc341c6abb59a07d1146f20221560bf52e078` before applying the child repair.
The same tests and exact child SHA, hashes, per-row results and logs must be
sealed in `docs.local/report-done-only/f1/ratchet-receipt.json`.

| Durable row | Test selector | Required behavior |
| --- | --- | --- |
| report-second-input-boundary | F1-P2 second verified input | Keep the earliest pending arm/floor. Preserve A's completed report at B's input boundary, then notify B separately: initial+A+B is three DONEs. No new report, duplicate receipt ACKs, background edits and restarts add no DONE. |
| report-late-ack-submit-anchor | F1-Q3 delayed acknowledgement | Anchor to pre-submit report evidence and submission time, preserving both across receipt updates. A fast completed iteration survives late verification. A new receipt with identical text starts another iteration; stale receipt snapshots/ACKs, unchanged reports, same-iteration edits and old-boot receipts do not re-arm or duplicate. |

These rows encode Etan's ruling: one DONE per input-defined work iteration.
Separate inputs may produce separate pending completions inside one sweep
interval. Background edits within one iteration do not create new outcomes.
This remains local synthetic engine evidence, not real-client or live proof.
