# Persist Deferred Transcript Capture Design

## Status

Approved by Etan on 2026-07-17 as the top follow-up to v0.4.15.

## Problem

v0.4.15 keeps recursive transcript discovery out of first-connect startup and re-derives transcript eligibility during a normal sweep. It persists no retry intent. If first-connect terminalizes an eligible sessionless row, that row can be purged or become ineligible before capture; a daemon restart guarantees that no process-local context can help. The row can remain permanently non-resumable.

## Chosen design

Persist a `transcript_session_capture_deferred` marker on `AgentRecord`. First-connect sets the marker without changing the record's lifecycle age. Startup purge retains marked terminal rows. A normal sweep treats the marker as transcript-capture eligibility even after terminalization or restart.

Session identity persistence and marker clearing happen in the same atomic state-file replacement. If the identity write fails, the previous record remains sessionless and marked, so a later sweep retries. Once identity is persisted, the marker is false in that same record version.

## Alternatives considered

1. Add the memory-only deferred-ID set from the unmerged follow-up. This is minimal but loses intent across daemon restart and is the gap this batch closes.
2. Set the marker through ordinary `StateManager.updateRecord()`. This is durable but increments `version`, refreshes `updated_at`, and can prevent age-based ghost retirement by making bookkeeping look like lifecycle progress.
3. Persist through a dedicated age-neutral state mutation. This is selected because it provides restart durability without distorting retirement evidence.

## Boundaries

- First-connect must not call the transcript resolver or recursively inspect `~/.codex/sessions`.
- Screen-derived session capture remains available during the boot window.
- Normal sweeps and explicit capture retain transcript resolution.
- Only rows explicitly marked for deferred capture survive the startup terminal purge.
- The change stays behind the existing `maybeCaptureBootSessionId()` and `syncSidebar({ firstConnect: true })` seams.

## Failure handling

The initial marker write is best-effort so a state-filesystem failure cannot block daemon startup. A failed identity write leaves the durable marker unchanged. Canonical-row collisions and renames clear the marker wherever the captured identity is persisted.

## Test contract

Extend the existing first-connect lifecycle regression without adding a second overlapping setup:

1. Initialize an eligible sessionless Codex row and prove the transcript resolver is not called during startup.
2. Prove the durable marker is present after first-connect terminalization.
3. Dispose and recreate the engine before the first normal sweep.
4. Inject exactly one identity-state write failure.
5. Prove the first sweep leaves the row marked and sessionless.
6. Prove a later sweep captures identity and clears the marker atomically.

Run the focused sidebar and resync suites, then the exact full gate from the approved brief.
