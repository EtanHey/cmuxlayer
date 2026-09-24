# Live seat soak

Run this ops tool from a source checkout at the release tag (or the reviewed
candidate commit). Install checkout dependencies with `bun install --frozen-lockfile`. The installed
`cmuxlayer` executable on `PATH` is the MCP server under test; the checkout
supplies only the runner and its helpers. Confirm cmux is reachable. This is a
manual, usage-consuming real MCP and cmux check; it is not part of CI. The
runner is not distributed in the npm package.

```bash
cd /path/to/cmuxlayer-source-checkout
bun install --frozen-lockfile
command -v cmuxlayer
node scripts/soak-live.mjs --agent-id WORKER_ID --lead-agent-id LEAD_ID --entry "$(command -v cmuxlayer)"
```

For the approved low-drain run, use a small reused pool with cheap seats. The
lead substitutes its scratch ID and runs this in a detached background shell:

```bash
node scripts/soak-live.mjs --agent-id LEAD_SCRATCH_ID --lead-agent-id cmuxlayerClaude-a1b93f83 --entry "$(command -v cmuxlayer)" --claude-model haiku --codex-model gpt-6-luna --codex-effort low --pool 4 --fresh-every 5 --concurrency 2
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
`--claude-model` omits the launcher model override by default; `--codex-model`
and `--codex-effort` default to `gpt-6-sol` and `low`. `--pool 0` retains the
fresh-seat behavior. With a pool, seats alternate Claude/Codex and are reused
round-robin. Every fifth cycle uses the original two-prompt fresh spawn and
close path unless `--fresh-every` sets another interval. The pool size must be
at least the concurrency. The summary records pool/fresh cycle counts, actual
spawn and replacement counts, plus requested models and effort. Pool seat loss
fails the run and the runner replaces that slot for later cycles.

The runner clears inherited pane identity before starting MCP stdio. The proxy
can still recover a managed worker identity from process ancestry, so launch
the runner as a genuinely external process when using a worker pane. Avoid
`launchctl submit`: it restarts a nonzero soak and can create extra seats. Use a
plain detached process, or a launchd job with `KeepAlive` false and `RunAtLoad`
true, when the run must survive the worker pane. The runner writes
timed JSONL calls and a pass/fail, p50/p95 summary under
`~/.cmux/agents/<worker-id>/soak/`. Any violation exits 1 while remaining cycles
continue. It checks boot/send receipts, replies, registry and screen agreement,
full versus immediate `parsed_only` read agreement on equal screen-content
hashes, right-column placement,
lead inbox, and exact-seat cleanup. The lead ID is used
only to inspect halt notices; soak seats have no parent, so their report notices
do not route to the lead. Preserve failing
receipts for the owning lane; inspect `summary.violations` before claiming green.
The JSONL records each reply check's bounded matching-line context and origin;
an echoed prompt or tool output alone never proves an authored reply. A `done`
terminal result after an instructed stop satisfies the wait check. Different
screen hashes between sequential reads are logged as snapshot changes; parsed
fields are compared only when the hashes match. Flagged parity mismatches keep
bounded raw-screen context in the JSONL.

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
