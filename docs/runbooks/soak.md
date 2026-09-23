# Live seat soak

Run this ops tool from a source checkout at the release tag (or the reviewed
candidate commit). Install checkout dependencies with `npm ci`. The installed
`cmuxlayer` executable on `PATH` is the MCP server under test; the checkout
supplies only the runner and its helpers. Confirm cmux is reachable. This is a
manual, usage-consuming real MCP and cmux check; it is not part of CI. The
runner is not distributed in the npm package.

```bash
cd /path/to/cmuxlayer-source-checkout
npm ci
command -v cmuxlayer
node scripts/soak-live.mjs --agent-id WORKER_ID --lead-agent-id LEAD_ID --entry "$(command -v cmuxlayer)"
```

Defaults: at least 40 cycles and 60 minutes on one MCP stdio server process,
concurrency 2, workspace:1 right column, alternating
Claude launcher default and Codex `gpt-6-sol` low. Each spawned seat answers
two bounded prompts, then is closed. The fixed cycle budget is paced across
the duration floor; once it finishes, the runner waits with health sampling.
Use `--cycles 4 --duration-minutes 0` for an installed smoke;
`--timeout-ms` (default 90000, max 300000) and `--entry` override the wait and
installed executable. Source builds are useful for diagnosis but are not
installed-release proof.

The runner clears inherited pane identity before starting MCP stdio. It writes
timed JSONL calls and a pass/fail, p50/p95 summary under
`~/.cmux/agents/<worker-id>/soak/`. Any violation exits 1 while remaining cycles
continue. It checks boot/send receipts, replies, registry and screen agreement,
full versus immediate `parsed_only` read agreement, right-column placement,
lead inbox, and exact-seat cleanup. The lead ID is used
only to inspect halt notices; soak seats have no parent, so their report notices
do not route to the lead. Preserve failing
receipts for the owning lane; inspect `summary.violations` before claiming green.
If an agent-scoped close fails, the runner retries once by agent ID without
force. It records `cleanup_leak` with the saved identities for human cleanup;
it never force-closes a saved surface ref that another seat may now own.
The JSONL includes full `control_health` samples at start, at intervals no
longer than 70 seconds, and at the endpoint. Each request has a 20-second
deadline; a timeout is an unhealthy sample and fails the run. The runner
checks timestamp gaps rather than a minute-based sample count and does not
catch up missed ticks during cleanup. The summary records elapsed duration,
unchanged server PID, healthy/total samples, and server RSS at start/end; any
unhealthy sample or RSS growth above 2x fails the run. The server process must
not reconnect or respawn during the full run. The MCP stdio PID is tracked
separately from the control daemon PID returned by `control_health`.
