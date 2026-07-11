# Monitor Owner Failover Design

## Problem

The durable monitor reconciler restores a stale watcher by writing a `monitor-rearm` task to the owning agent. A readable screen is not sufficient proof that the owner can process that task: repeated broken-pipe writes can classify the surface as `pane_pty_dead` while the last rendered frame remains readable. Dispatching to that owner leaves the monitor in `rearming` even though no process can act on the message.

## Options considered

### Execute every stored re-arm command in the daemon

This would restore some file watchers without an owner, but `rearm_command` is opaque shell text. It may depend on the owner's working directory, environment, credentials, process state, or cursor. Executing it in the daemon would cross a trust boundary and could recreate the wrong watcher.

### Infer owner independence from mechanism and absolute targets

An `event` or `offset-poll` mechanism with absolute file targets looks like a pure watch, but those fields describe intent rather than the executable contract. They do not prove that the command is side-effect-free, daemon-safe, or independent of owner-local state.

### Collapse and escalate loudly

Treat all current-schema monitors as owner-bound unless future registration metadata explicitly proves a daemon-safe watcher contract. When the shared write-liveness tracker reports the owner's surface as PTY-dead, atomically collapse the stale monitor with `owner-pty-dead`, do not dispatch to the owner's inbox, and emit a high-priority daemon notification. This is the chosen safe default.

## State and data flow

The registry reconciliation API accepts an injected owner-PTY-dead predicate in addition to the existing owner-alive probe. For each stale `alive` monitor (or expired `rearming` lease), reconciliation validates the re-arm command and watch targets, then evaluates owner viability. A PTY-dead result takes precedence over the screen-read liveness result and claims the monitor under the existing registry write lock as:

```text
state: collapsed
collapsed_reason: owner-pty-dead
```

Only the process that wins that transition emits the escalation callback. Later reconcile ticks ignore the collapsed record, so they neither notify again nor enqueue an inbox re-arm. Healthy owners continue through the existing `rearming` claim and deterministic inbox message path unchanged.

The daemon resolves the owner from the file-backed agent registry and reads `context.surfaceWriteLiveness.observe(owner.surface_id).pty_dead`. It does not duplicate broken-pipe thresholds or parsing. The production escalation adapter sends a high-priority notification that names the monitor, owner, and watched targets. Notification delivery remains best-effort, matching the existing monitor deadman notifier, while the durable collapsed state makes the failure visible through `list_monitors` and agent health even if the HTTP notification sink is unavailable.

## Idempotency and races

The existing lock and candidate-state checks remain the single claim boundary. A stale monitor can transition from `alive` or an expired `rearming` lease only once. The escalation callback runs only after that successful claim. Concurrent or later reconciliation passes see `collapsed` and do nothing, preventing both inbox double-delivery and notification storms.

## Tests

- A stale monitor with a PTY-dead owner collapses as `owner-pty-dead` and never invokes owner re-arm.
- The loud escalation callback receives the collapsed monitor exactly once across repeated reconciliation ticks.
- A healthy owner retains the v0.3.37 re-arm behavior.
- Daemon tests inject the shared `SurfaceWriteLivenessTracker`, record the threshold broken-pipe failures, and prove the default reconciler emits one injected high-priority escalation without inbox dispatch.
- Focused tests, typecheck, build, and five cold full-suite runs must pass before the PR opens.
