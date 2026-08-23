# Report to Parent and Spawn Report Watch Design

## Status

Approved by Etan on 2026-08-23.

## Scope

Phase 3 contains exactly three coupled changes:

1. Add the tenth public tool, `report_to_parent`, for an agent-chosen blocker escalation.
2. At child spawn, automatically arm a persistent watch owned by the parent on the child’s engine-issued `report_path` and `done_marker`.
3. Keep long `wait_for` MCP calls alive by emitting progress more frequently than the harness’s 120-second no-progress cutoff.

No sender-side delivery receipts, degraded spawn-receipt events, or other backlog defects are in scope.

## Public tool contract

`report_to_parent` accepts one `blocker` string capped at 500 characters. The caller cannot pass a target or parent identifier. cmuxlayer resolves the managed caller from the current surface and reads `parent_agent_id` from the registry.

The tool appends a durable inbox envelope to the direct parent, then wakes that parent through the same guarded, evidence-backed terminal delivery path used by `send_to` and inbox nudges. Its lean result names the child, intended parent, actual notified agent, and whether delivery was direct or fallback.

This is a separate public tool because its authority and meaning differ from `send_to`: the hierarchy determines the address, and successful return means a blocker was escalated rather than arbitrary text was sent.

## Delivery failure

The direct parent remains the durable recipient. If its surface is dead, wedged, or unreachable, cmuxlayer walks the registry ancestry and attempts to wake the nearest reachable ancestor with the blocker plus the direct-parent delivery failure. If no ancestor accepts verified delivery, the tool returns an error. The child therefore never receives a success response merely because a mailbox append succeeded.

This reuses the delivery mechanics of `agent_halt_escalation` without duplicating its detection policy. `agent_halt_escalation` is engine-selected recovery for an observed halt; `report_to_parent` is agent-selected escalation of a known blocker.

## Spawn-side report watch

After issuing and persisting the child coordination contract, spawn ensures the report file exists and arms a WatchSpec with:

- `owner`: the registry-derived parent agent ID
- `target`: the child’s engine-issued absolute report path
- `marker`: the child’s engine-issued done marker
- `watermark`: the marker count at arm time
- a far-future deadline, because completion—not a short timer—owns the lifecycle

The WatchSpec registry is file-backed, so parent session restarts do not lose the watch. A fired watch is delivered to the owner’s current registered surface through the guarded relay. Failed delivery remains `notification_pending` and is retried by later sweeps. Counting only markers beyond the arm-time watermark prevents stale append-per-run markers from firing.

## Long wait progress

`wait_for` uses the MCP request’s progress token, when supplied, to emit progress notifications at intervals below 60 seconds until the wait resolves. The existing timeout remains meaningful; the harness sees observable progress rather than aborting a valid long wait at roughly 120 seconds.

## Verification

Tests cover the public palette, registry-derived authority, no-parent refusal, direct delivery, unreachable/dead parent fallback, simultaneous child reports, automatic spawn watch arming, stale-marker watermarking, persisted-watch delivery after parent restart, and progress notification cadence. Final gates are typecheck, the full suite with socket variables present, the full suite with both socket variables unset, and a fresh-pane real-client check because spawn/registry behavior changes.
