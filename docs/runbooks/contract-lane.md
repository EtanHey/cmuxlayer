# Real-cmux contract lane

Run `bun run test:contract` before a release whenever a disposable or NIGHTLY cmux instance is available. The release script runs the same gate automatically: an unavailable live socket prints a warning and skips with exit 0; a reachable socket with any failed contract exits non-zero and stops the release.

## Preferred NIGHTLY setup

Use cmux NIGHTLY so the production fleet is never part of lifecycle QA. Start the command from a terminal pane inside NIGHTLY, because cmux authorizes socket clients by process ancestry:

```bash
CMUX_SOCKET_PATH=/tmp/cmux-nightly.sock bun run test:contract
```

The NIGHTLY app must be running and `/tmp/cmux-nightly.sock` must be its socket. Do not substitute the production socket merely to make the lane run. The more detailed isolation background is in `docs.local/tasks/2026-07-11-nightly-restart-qa.md`.

Do not set `CMUXLAYER_DAEMON_SOCKET` for this command. The runner always overrides it with a unique socket inside a fresh temporary directory. It also gives the contract stack a temporary `HOME`, starts the daemon from the repository's freshly built `dist`, records every spawned PID, and signals only those recorded PIDs.

## What it proves

The lane is read-only against the pinned cmux instance. It checks:

- `system.ping` returns the expected `{ pong: true }` response to a pane-descended process;
- a detached, reparented orphan is denied with the EPIPE/errno-32 ancestry contract;
- `list_surfaces` and `read_screen` round-trip through a real cmuxlayer daemon launched from `dist`;
- `doctor --json` reports healthy against the live cmux plus isolated daemon stack;
- SIGTERM gracefully retires only the recorded isolated daemon, and the still-running dist proxy autostarts a different healthy daemon PID on the same isolated socket.

It never creates, closes, renames, selects, types into, or otherwise mutates a cmux surface. It never kills, replaces, or unlinks a fleet daemon or fleet daemon socket.

## Reading the result

- `PASS real-cmux contract lane`: all live assertions completed, including the isolated retire/autostart cycle.
- `SKIP`: `CMUX_SOCKET_PATH` was unset or could not answer the bounded ping from this process. This is CI-safe and exit 0, but it is not live coverage. For a pre-release run, launch the command from inside the target NIGHTLY pane and retry.
- `FAIL`: treat this as an environment-fidelity regression. Do not release. Capture the full output, the pinned socket path, cmux/NIGHTLY version, cmuxlayer commit, spawned PID receipts, and whether the failure was ping shape, EPIPE denial, list/read, doctor, or retire/autostart.

An EPIPE assertion failure usually means cmux's ancestry policy changed or the helper did not become a true orphan (`ppid` must be 1). A list/read or doctor failure means unit tests are no longer representative of the real daemon/socket stack. A retire/autostart failure means the release could strand persistent MCP clients after a daemon restart.
