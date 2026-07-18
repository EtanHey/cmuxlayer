# Persist Deferred Transcript Capture Design

## Status

Approved by Etan on 2026-07-17 as the top follow-up to v0.4.15.

## Problem

v0.4.15 keeps recursive transcript discovery out of first-connect startup and re-derives transcript eligibility during a normal sweep. It persists no retry intent. If first-connect terminalizes an eligible sessionless row, that row can be purged or become ineligible before capture; a daemon restart guarantees that no process-local context can help. The row can remain permanently non-resumable.

## Chosen design

Persist a `transcript_session_capture_deferred` marker on `AgentRecord`. First-connect sets the marker without changing the record's lifecycle age. Startup and normal absence cleanup retain marked terminal rows. After the one-shot startup purge retains those marked rows, but before normal absence cleanup, a sweep retries structurally eligible markers without requiring a live surface binding; ineligible markers clear without a resolver call, and unsuccessful eligible retries stop after three calls. This ordering prevents either a pane closing during restart or a successful first retry from discarding the captured identity. Within that bounded window, a normal sweep treats the marker as transcript-capture eligibility even after terminalization or restart.

Session identity persistence and marker clearing happen in the same atomic state-file replacement. If the identity write fails, the previous record remains sessionless and marked, so a later sweep retries. Once identity is persisted, the marker is false in that same record version.

### Bounded retry amendment (PR #336 review)

Persist `transcript_session_capture_attempts` beside the marker and clear the marker after three failed resolver calls. Three normal sweeps preserve the useful post-boot window (roughly 15–45 seconds at the default active/idle sweep cadence), while placing a deterministic cap on recursive transcript scans that survives daemon restart. Resolver `null` results and throws consume the cap; a successful resolution whose identity write fails does not, preserving the transient-write P1 behavior.

The marker also clears without invoking the resolver when the row no longer has structurally valid transcript context: a JSONL-backed CLI plus managed-launch/task context. Terminal lifecycle state alone is not treated as structurally ineligible, because retrying a just-terminalized Codex row is the purpose of the marker. Once either the cap or structural-ineligibility rule clears the marker, normal confirmed-absence cleanup can reap the row.

## Alternatives considered

1. Add the memory-only deferred-ID set from the unmerged follow-up. This is minimal but loses intent across daemon restart and is the gap this batch closes.
2. Set the marker through ordinary `StateManager.updateRecord()`. This is durable but increments `version`, refreshes `updated_at`, and can prevent age-based ghost retirement by making bookkeeping look like lifecycle progress.
3. Persist through a dedicated age-neutral state mutation. This is selected because it provides restart durability without distorting retirement evidence.
4. Expire by `created_at`. Rejected because an old restored row can receive a new marker; record creation time does not identify when deferred capture began. A persisted attempt cap bounds work without adding another clock field.

## Boundaries

- First-connect must not call the transcript resolver or recursively inspect `~/.codex/sessions`.
- Screen-derived session capture remains available during the boot window.
- Normal sweeps and explicit capture retain transcript resolution.
- Only rows explicitly marked for deferred capture survive terminal cleanup; normal cleanup resumes after capture clears the marker.
- Deferred resolver work is capped at three failed calls across restarts, and structurally ineligible markers clear without a resolver call.
- The change stays behind the existing `maybeCaptureBootSessionId()` and `syncSidebar({ firstConnect: true })` seams.

## Failure handling

The initial marker write is best-effort so a state-filesystem failure cannot block daemon startup. A failed identity write leaves the durable marker unchanged and normal cleanup cannot evict it. Canonical-row collisions and renames clear the marker wherever the captured identity is persisted.

## Test contract

Extend the existing first-connect lifecycle regression without adding a second overlapping setup:

1. Initialize an eligible sessionless Codex row and prove the transcript resolver is not called during startup.
2. Prove the durable marker is present after first-connect terminalization.
3. Dispose and recreate the engine before the first normal sweep.
4. Inject exactly one identity-state write failure.
5. Remove the original pane and prove the first sweep still reaches the resolver, then leaves the row marked and sessionless.
6. Prove a later sweep captures identity and clears the marker atomically.
7. Prove normal surfaceless and terminal cleanup retain a marked row.
8. Prove an immediate successful first-sweep capture survives the pending startup purge.
9. Prove a never-resolving terminal row stops at three resolver calls across restart and is reaped by normal confirmed-absence cleanup.
10. Prove a structurally ineligible marked row clears without invoking the resolver.

Run the focused sidebar and resync suites, then the exact full gate from the approved brief.
