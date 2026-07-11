# Monitor Wedged Owner Design

## Problem

The monitor reconciler can prove that an owner pane exists and accepts screen reads, dispatch a durable `monitor-rearm` inbox task, and then wait forever for an owner agent that is alive but no longer processing work. The existing re-arm claim is only a retry lease, so an unacknowledged dispatch is eventually sent again instead of becoming an observable failure.

## Options considered

### Redispatch every expired claim

This preserves the current behavior but cannot distinguish delivery failure from an owner agent that is wedged. It leaves the monitor in `rearming` limbo and can repeatedly nudge an owner that will never act.

### Infer daemon-safe commands from watch metadata

File targets and `event`/`offset-poll` mechanisms look owner-independent, but the stored command is opaque and may depend on owner-local state. The v0.3.38 safety decision therefore remains: current-schema monitors are owner-bound unless an injected caller can explicitly prove daemon-safe ownership independence.

### Time-bound acknowledgement and escalate or fall back

Use the existing `rearm_claimed_at` lease as the dispatch timestamp. On a later tick, an expired claim with no monitor signal is an unacknowledged dispatch. If an injected owner-progress probe shows activity after the claim, retry normally. If it does not, atomically transition to `owner-wedged`; an explicitly owner-independent monitor uses an injected daemon fallback instead. This is the chosen approach.

## State transitions

```text
stale alive --claim + owner dispatch--> rearming(rearm_claimed_at)
rearming --signal_monitor-------------> alive (acknowledged)
rearming --timeout + owner progress---> rearming (fresh retry claim)
rearming --timeout + no progress------> collapsed(owner-wedged)
rearming --timeout + independent------> alive (daemon fallback completed)
collapsed(owner-wedged) --signal------> alive (recovery clears collapse)
```

The registry write lock and current-state recheck remain the single transition boundary. Only the winning transition invokes escalation or fallback, so concurrent and later ticks cannot create storms. `owner-wedged` remains visible through existing `list_monitors`, gate-query, agent-health, and `control_health.self_heal.monitor_registry` paths.

## Acknowledgement and timeout

Monitor progress is authoritative: `signal_monitor` returns a `rearming` record to `alive` and clears the claim. The daemon also checks the exact deterministic inbox message ID in the owner's ACK file and accepts an agent monitor heartbeat strictly newer than `rearm_claimed_at`; either prevents a wedged classification and permits a normal retry. Generic agent lifecycle timestamps are deliberately not treated as acknowledgement. The default acknowledgement timeout is twice the daemon reconcile interval; direct registry callers retain a deterministic 60-second default.

## Owner-independent fallback

The registry exposes injected `ownerIndependent` and `fallbackRearm` seams. A successful fallback atomically finalizes the claimed record to `alive` with a fresh signal timestamp, preventing another fallback on the next expired tick. The production daemon does not infer independence for opaque current-schema commands, preserving the prior safe default. A future caller with a genuinely daemon-safe watcher contract can opt in without changing the lease or idempotency machinery.

## Terminal quieting and abandoned-monitor reaping

`dead`, `collapsed`, and `deadman-fired` are terminal for reconciliation and never re-enter collapse, re-arm, fallback, or notification transitions. Before considering live/rearming candidates, reconciliation performs an age-bounded reap pass: any non-dead record whose newest durable activity (`armed_at` or `last_signal_at`) is older than the injectable reap threshold (24 hours by default) and whose owner is not alive is atomically marked `dead`. Reaping is silent and idempotent; a later tick sees `dead` and performs no work.

Notifications are edge-triggered by the durable transition claim. Deadman delivery carries `monitor_id:deadman-fired`; collapse delivery carries `monitor_id:<collapse-reason>`. The key lets the HTTP notification layer deduplicate transport retries while the registry lock prevents duplicate transition producers.

Notification transport is dependency-injected and fail-closed for tests. Constructing `CmuxLayerDaemon` directly never selects the live registry or HTTP notifier; only the production `runDaemon` entrypoint wires those dependencies, and it substitutes no-ops whenever `VITEST=true` or `NODE_ENV=test`. Reconciler tests capture notification payloads in spies, and every daemon with a reconciliation interval is registered for async shutdown in test teardown.

## Tests

- A pane-alive owner with no progress past the acknowledgement timeout collapses once as `owner-wedged` and escalates once.
- A timely signal acknowledgement restores `alive` and does not escalate.
- Owner progress after dispatch permits the normal re-arm retry.
- An explicitly owner-independent monitor invokes daemon fallback once instead of collapsing.
- Repeated ticks are idempotent, and a later genuine monitor signal clears an `owner-wedged` collapse.
- Existing health surfaces include the new collapse reason without a parallel observability path.
- Already-terminal monitors remain quiet across ten reconciliation ticks.
- Ancient dead-owner monitors are reaped to `dead` exactly once without notification.
- Deadman and collapse payloads expose stable transition dedupe keys.
- Targeted daemon/reconciler tests cannot reach the live notification bridge and leave no interval workers behind.
