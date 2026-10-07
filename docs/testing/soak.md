# Live seat soak

Run from a reviewed source checkout with `bun install --frozen-lockfile`.
The installed `/opt/homebrew/opt/cmuxlayer/bin/cmuxlayer` executable is the
server under test; the checkout supplies the runner only. This manual soak
consumes model usage and never runs in CI.

The release gate is **pinned cmux 0.64.22 on the dedicated M1** with installed
cmuxlayer 0.4.101. NIGHTLY on the MBP is early-warning only; its PASS does not
satisfy the release gate. Never launch a second stable cmux on the MBP.

```bash
node scripts/soak-live.mjs --agent-id WORKER_ID --app "/Applications/cmux NIGHTLY.app" --target nightly --dry-run true
```

The dry-run launches the app, verifies its socket owner, creates a shell probe,
and calls the installed private daemon's `control_health`. It makes no model
calls. Both dry-run and real runs use the ratchet's exclusive shared lock,
launch token, private daemon socket/state/inbox, private HOME and shell startup
files, and identity/start-time verification before TERM or KILL. The runner
records production PID 11224 and all stable cmux processes before and after.
Busy apps, live sockets and locks fail; stale locks require operator cleanup.
The app may reclaim its own stale socket; the runner never unlinks it or
kills an unowned app.

On MBP/NIGHTLY, prepare a separate mode-0700 `--private-home` with Codex and
Claude logged in before a real soak. On the dedicated M1, `m1-gate` always uses
the target operator's real HOME for authenticated CLIs; `--private-home` is not
required and does not replace the M1 HOME. Daemon socket, state, inbox and
workspace remain private per run on both hosts. Do this on the dedicated host through the lead; the
runner does not copy credentials, configure accounts, or use personal shell
startup files. The optional auth HOME persists harness sessions, but daemon
state, inboxes, workspace cwd, and sockets remain per-run scratch resources.
The isolated runner uses native Codex/Claude CLIs through the installed
cmuxlayer's registry-optional raw launch path, with an empty private launcher
registry. Existing repoGolem state remains an operator prerequisite to
inventory; personal launcher hooks are not sourced into private shells.

After the lead coordinates the M1 and confirms 0.4.101 installed:

```bash
node scripts/soak-live.mjs --agent-id M1_SOAK_ID --target m1-gate --gate-host M1_HOSTNAME --app "/Applications/cmux.app" --dmg /path/to/pinned-cmux-0.64.22.dmg --cases a,b,c,d,e,f,g,h
```

`M1_HOSTNAME` must be the lead-designated dedicated host's exact `hostname`.
Stable launch requires no existing `com.cmuxterm.app` process, checks both
bundle and resolved executable identity, and requires version 0.64.22. The
DMG must have SHA-256
`fd148dba3519fe7d308844089ce4d062b17739ba645623f058f67a64798cea25`.
Install from that verified artifact through the lead; never upgrade it.

Defaults retain the **40-cycle and 60-minute floor**, concurrency 2, with a
small pool of 2 seats. Every fifth cycle exercises a fresh seat. All seats
use Claude `haiku` or Codex `gpt-6-luna` with `low` effort; other model settings
and pools larger than 2 are refused. `--pool 0` selects all-fresh cycles.
Use `--cycles 4 --duration-minutes 0` only for a smoke, never gate proof.
No cases are selected by default: the full gate command explicitly selects
a–h. `--queue-deadline-ms` defaults to 90000 and `--long-turn-minutes` to 2.
The runner creates its own workspace and caller seats; `--agent-id` names
receipt output, not a production registry route. Production lead inbox reads
are refused. Receipts are under `docs.local/soak/<agent-id>/` in the checkout.

Every send receives independent composer, queue and transcript evidence.
False successful receipts and false `submit_unverified` receipts fail with
separate codes. Eventual queue submission, authored replies, state agreement,
parsed-read parity, placement, exact-seat cleanup, server PID continuity,
health sample gaps and RSS growth are checked. A failed prerequisite fails
that case and marks later cases unrun. Case c always attempts to submit its
harmless foreign echo through the drafting caller's owned route, verifies
submission, then waits for idle. Failed cleanup closes the exact scratch
seat; no draft is carried to another case.

Cases: busy queue (a), interrupted owned queue/foreign retry (b), foreign draft
and attention (c), Enter casing matrix (d), long queue and attention (e), idle
owned draft/Return (f), idle stalled queue (g), wrapped/truncated long relay (h).
The long relay needs three queue rows or a matching truncated prefix of at
least 40 characters. Missing evidence fails rather than skips. Escape may
dismiss a security banner; never select account setup.

Launch as an external detached process when running from a managed pane, so
proxy ancestry does not replace explicit per-call callers. Clear inherited
pane identities from the runner launch environment. Do not use a restarting
job: each failed run must remain a failure, with its original receipts. Any
violation produces SOAK_FAIL; preserve the summary and full violations list.
A dry-run or NIGHTLY PASS remains separate from the M1 gate result.
