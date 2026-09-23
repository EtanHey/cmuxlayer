# Live seat soak

Run after installing the release and confirming cmux is reachable. This is a
manual, usage-consuming real MCP and cmux check; it is not part of CI.

```bash
node scripts/soak-live.mjs --agent-id <worker-id> --lead-agent-id <lead-id>
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
The JSONL includes full `control_health` samples at start, every 60 seconds, and
end. The summary records elapsed duration, unchanged server PID, healthy/total
samples, and server RSS at start/end; any unhealthy sample or RSS growth above
2x fails the run. The server process must not reconnect or respawn during the
full run. The MCP stdio PID is tracked separately from the control daemon PID
returned by `control_health`.
