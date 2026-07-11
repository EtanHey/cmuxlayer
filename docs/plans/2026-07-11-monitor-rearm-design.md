# Durable Monitor Auto-Re-arm Design

## Current truth

The canonical monitor registry is an atomically rewritten file and survives app and daemon restarts. Its records describe the owner, watched files, mechanism, dedupe metadata, heartbeat, and deadman timeout. The live watcher does not survive those restarts, however, and the registry currently stores neither the command needed to recreate it nor a recovery claim. The existing sweep therefore treats every stale `alive` record as a deadman event and permanently moves it through `firing` to `deadman-fired`.

The daemon is now a durable host with a shared server context, file-backed agent state, and a client that can verify whether an owner's recorded surface still exists. Agent health is computed when records are listed, so a monitor failure can be added without changing the persisted agent schema.

## Failure modes

- A daemon or app restart kills watchers while leaving apparently armed records behind.
- Two reconciliation passes, or a restart between deciding and enqueueing, can request duplicate watchers.
- The deadman sweep can race recovery and notify for a monitor that is already being restored.
- Recreating a watcher for a missing file silently creates a permanently blind monitor.
- Re-arming for a dead owner creates an orphan watcher.
- Legacy registry records do not contain an exact re-arm command; guessing one can run the wrong mechanism or unsafe shell text.

## Chosen design

Extend registry records with optional `rearm_command` and durable recovery metadata. Add `rearming` and `collapsed` monitor states. A collapsed record includes a reason (`owner-not-alive`, `watch-target-missing`, or `rearm-command-missing`); a rearming record includes the daemon claim timestamp. Existing registration remains backward-compatible, but only records carrying an explicit command can be automatically restored.

Put the reconciliation state machine in `monitor-registry.ts` and keep all environment checks injectable. For each stale `alive` record, the daemon-hosted coordinator performs these checks in order:

1. Every watched file still exists.
2. An agent record matches `owner_seat`, is not terminal, and its recorded surface can be read.
3. The record contains an exact re-arm command.

Under the existing registry write lock, reconciliation changes an eligible record to `rearming` before invoking the injected re-arm callback. Missing files, absent owners, or missing commands instead become `collapsed`. Because neither state is `alive`, the existing deadman sweep ignores them. `register_monitor` or a successful signal returns a `rearming` record to `alive`, clearing recovery metadata. Failed or process-abandoned claims remain `rearming` and become reclaimable only after a durable lease expires, so deadman cannot race the retry. Reclaims reuse an inbox id derived from the monitor id and stale heartbeat, keeping durable delivery idempotent across daemon processes.

The daemon runs reconciliation once during `start()` and then on an unref'd interval. It guards against overlapping passes and clears the timer during shutdown. The production callback appends a deterministic `monitor-rearm` inbox task containing the exact command; if the inbox heartbeat is also stale, it routes a pointer through the same guarded lifecycle relay used by `dispatch_to_agent`, including stale-surface and recycled-occupant checks. After the first MCP connection reconstitutes lifecycle state, relay readiness immediately retries failed boot-time claims instead of waiting for the normal lease; the retry is scoped to the exact failed monitor IDs, so successful records in the same pass cannot receive a duplicate surface nudge. Re-arm-capable registrations require absolute file targets or expand `~/` targets before persistence; relative targets are rejected because the detached daemon does not share the registering owner's working directory. Owner liveness is resolved from the daemon context's file-backed state and a real surface read. Tests inject owner/file/re-arm functions and clocks, so they do not touch the home directory, cmux, or the network.

`list_monitors` exposes `rearming` and `collapsed` records and their reasons. Agent health gains blocking issue `monitor_collapsed` when a current registry record owned by that agent or seat is collapsed. No deadman notification is emitted for rearming or collapsed records.

## Rejected alternatives

### AgentEngine-only reconciliation

The engine already sweeps the registry, but it starts only after lifecycle tooling initializes. Hosting recovery only there would not satisfy daemon-boot recovery and would couple watcher restoration to an MCP client connection.

### Derive a generic `tail -F` command

The registry supports both event and offset-poll mechanisms, and existing targets are metadata rather than executable commands. Derivation would be incorrect for some monitors and would turn untrusted path text into shell input. Explicit command metadata is auditable and exact.

### External launchd supervisor

This adds another lifecycle and violates the established socket ancestry constraint. The daemon already owns the required durable process lifetime.

## Test strategy

- Pure registry tests prove one stale/live-owner record claims and re-arms once across repeated reconciliation.
- Pure registry tests prove a gone owner and a missing watched file become visible collapsed records with no re-arm and no deadman notification.
- A failure/retry test proves lease-based claim recovery without making the record deadman-eligible or duplicating the stable inbox id.
- Daemon tests prove an immediate boot pass, periodic passes without overlap, timer cleanup, and restart idempotency against the same registry file.
- MCP and health tests prove registration round-trips `rearm_command`, `list_monitors` surfaces collapse metadata, and the owning agent receives `monitor_collapsed`.
