# PR-3 installed delivery receipts, 2026-10-04

Status: partial selected-case proof; overall SOAK_FAIL.
Installed cmuxlayer 0.4.97 (daemon PID 90870), production cmux 0.64.22 (102).
No app restart, quit, upgrade, browser, or Computer Use actions.
All six runs requested gpt-6-sol low before the lead's model correction;
no subsequent live runs were started. The default is owned by a separate PR.
Each run requested one ordinary cycle, concurrency 1, duration floor 0;
this is not a 40-cycle or 60-minute soak.

## Per-case outcomes

| Case | Outcome | Independent evidence | Run ID |
| --- | --- | --- | --- |
| a | PASS | Busy receipt queued_behind_turn=true; queued screen then submitted within 90 s | MAIN |
| b | PASS | Two queued sends; interrupted composer; foreign Return refused; owner return submitted | MAIN |
| c | FAIL | Foreign draft refused with typed=false and composer_draft_pending attention; cleanup left draft visible | C |
| d | PASS | Enter, enter, Return, RETURN each submit an owned draft | MAIN |
| e | FAIL | Queue still busy after 2 minutes; long_queue_unsurfaced, needsAttention=false | E |
| f | PASS | Idle owned draft + Return submits | MAIN |
| h | PASS | Four-row truncated queue item, followed by verified submission within 90 s | MAIN |
| g | NOT-RUN | Attempted setup; required idle queue state never observed (idle_queue_case_not_exercised) | MAIN |

Counts: 5 pass, 2 fail, 1 not-run. Case g's prerequisite failure also fails the harness.

MAIN: `2026-10-04T14-52-24-187Z`
C: `2026-10-04T14-50-16-498Z`
E: `2026-10-04T14-57-29-400Z`

## Selected receipts

- 2026-10-04T14:52:37.431Z case:d: receipt `{"ok":true,"submit_verified":true}`; screen `{"inComposer":false,"queued":false,"submitted":true,"queueRows":0,"queueTruncated":false,"newAccepted":true}`.
- 2026-10-04T14:52:44.535Z case:d: receipt `{"ok":true,"submit_verified":true}`; screen `{"inComposer":false,"queued":false,"submitted":true,"queueRows":0,"queueTruncated":false,"newAccepted":true}`.
- 2026-10-04T14:52:50.642Z case:d: receipt `{"ok":true,"submit_verified":true}`; screen `{"inComposer":false,"queued":false,"submitted":true,"queueRows":0,"queueTruncated":false,"newAccepted":true}`.
- 2026-10-04T14:52:55.886Z case:d: receipt `{"ok":true,"submit_verified":true}`; screen `{"inComposer":false,"queued":false,"submitted":true,"queueRows":0,"queueTruncated":false,"newAccepted":true}`.
- 2026-10-04T14:53:03.160Z case:f: receipt `{"ok":true,"submit_verified":true}`; screen `{"inComposer":false,"queued":false,"submitted":true,"queueRows":0,"queueTruncated":false,"newAccepted":true}`.
- 2026-10-04T14:54:35.413Z case:b: receipt `{"ok":true,"submit_verified":true}`; screen `{"inComposer":false,"queued":false,"submitted":true,"queueRows":0,"queueTruncated":false,"newAccepted":true}`.
- 2026-10-04T14:53:48.189Z case:h: receipt `{"ok":true,"delivery_id":"fca39172-9fa2-4354-b5d6-88a7f0e5bcfd","submit_verified":null,"queued_behind_turn":true,"queue_verified":true,"delivery_state":"queued"}`; screen `{"inComposer":false,"queued":true,"submitted":false,"queueRows":4,"queueTruncated":true,"newAccepted":true}`.
- Case a queued receipt: ok=true, queued_behind_turn=true, queue_verified=true; independent queued=true, followed by submitted=true at elapsed_ms=35488.
- Case b foreign Return receipt: ok=false, error_code=blocked_by_foreign_draft; independent inComposer=true.
- Case h eventual screen: submitted=true, elapsed_ms=35476; its initial queue had four visible rows and truncation.

## Separate product findings and unresolved observations

- Two distinct ordinary Claude sends returned ok=false, error_code=submit_unverified while their new prompt was independently submitted (before submitted=false, after submitted=true and newAccepted=true). Delivery IDs: `6ecd080e-96e4-4514-8d77-c5d1acd8d08b` and `78a8f8f7-e666-4ebd-9679-9160209a2705`. The first had the registered worker caller; the second external ordinary send had no caller identity. Both were checked again before cleanup.
- Case e's pending queue had no needs-attention signal after the configured 2-minute threshold. Product triage belongs to the lead; this PR changes no product code.
- Case c's Ctrl-U cleanup did not clear the synthetic draft. Cause unconfirmed; both ctrl+u and ctrl-u are supported by the backend source.
- Existing FD-pressure warnings and authored replies missing from parsed/preview output keep every run SOAK_FAIL. They are preserved, not waived.
- #999 is not disproved: g never reached its required idle stalled queue state. Successful b/f cover their observed states only.

## Run ledger and cleanup

- `2026-10-04T14-44-43-518Z`: SOAK_FAIL; completed cycles 1/1; cleanup 2 pass / 0 fail.
- `2026-10-04T14-47-21-148Z`: SOAK_FAIL; completed cycles 1/1; cleanup 2 pass / 0 fail.
- `2026-10-04T14-48-44-679Z`: SOAK_FAIL; completed cycles 1/1; cleanup 2 pass / 0 fail.
- `2026-10-04T14-50-16-498Z`: SOAK_FAIL; completed cycles 1/1; cleanup 2 pass / 0 fail.
- `2026-10-04T14-52-24-187Z`: SOAK_FAIL; completed cycles 1/1; cleanup 2 pass / 0 fail.
- `2026-10-04T14-57-29-400Z`: SOAK_FAIL; completed cycles 1/1; cleanup 2 pass / 0 fail.

All 12 created scratch agents/panes have verified stop/close and absence checks.
Raw JSONL and summaries remain in the worker soak directory; this committed ledger
quotes the synthetic receipts needed for review without publishing environment dumps.
