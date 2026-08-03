# Channel Marker Reaper Design

## Problem

Every inbox write creates a `.channel-dirs/<encoded-agent-id>.created` marker. Successful
pending-to-real registration removes the pending channel directory through `StateManager.renameState`,
but it does not remove the pending marker. Failed or mocked spawns can leave both the marker and its
channel directory behind. Vitest already isolates its registry state, but its inbox path still falls
back to the live `~/.cmux/agents` tree, so test runs are an active production-state leaker.

The marker is not disposable bookkeeping. It lets health checks distinguish a channel directory that
never existed from one that existed and was later deleted. Cleanup must therefore preserve markers for
every known agent identity.

## Safety Rule

Automatic backlog cleanup may remove only a marker whose decoded identity:

1. matches the canonical timestamped pending-id form;
2. is older than the retention window embedded in that pending id; and
3. is absent from both the in-memory registry and persisted agent state captured for the sweep.

The reaper never removes non-pending markers or markers for known agents. The decision and unlink run
synchronously against one known-id snapshot, so lifecycle mutation cannot interleave inside the
process. Missing files during multi-process cleanup are harmless; other filesystem errors are counted
and retained.

Successful pending-to-real registration is a stronger proof than retention: after the final state has
been persisted and the registry rename succeeds, the old pending marker is removed immediately. A
failed transition leaves the marker untouched.

## Components

- `src/inbox.ts` owns pending-marker parsing, transition cleanup, and the retention-based reaper.
- `src/agent-engine.ts` invokes transition cleanup only after registry/state rename and runs the
  backlog reaper on a time gate using the union of registry and persisted identities.
- `src/server.ts` routes implicit Vitest inbox writes to a process-scoped temporary directory unless
  a test explicitly supplies another inbox directory. This keeps injected state-manager paths
  untouched while preventing live-home writes.

The reaper enumerates `.channel-dirs` only on its explicit maintenance interval. Ordinary spawn writes,
health reads, `list_agents`, and `resync_agents` retain their existing single-path operations.

## Verification

- Unit tests cover known, young, malformed, non-pending, and safely reapable markers.
- An engine test proves pending-to-real transition cleanup happens only after successful registration.
- A server test proves Vitest's implicit inbox base is isolated from the live home path.
- A live saturated-directory probe proves spawn success at more than 50,000 entries.
- Before/after live counts and health/list latency measurements are reported separately; they do not
  claim adjacent sidebar, click, `pane_died`, or stale-reference defects are fixed.
