# Live seat soak

Run against the installed release and live cmux. This real MCP workload is manual, not CI.

```bash
node scripts/soak-live.mjs --agent-id <worker-id> --lead-agent-id <lead-id>
```

Defaults: 40 cycles over at least 60 minutes on one MCP stdio process, concurrency 2, workspace:1
right column; alternating Claude default and Codex `gpt-6-sol` low. Each seat answers `SOAK_OK_<n>`
and `SOAK2_<n>`, then receives an agent-scoped close. Smoke: `--cycles 4 --duration-minutes 0`.

The runner clears inherited pane identity; soak seats have no parent. `--lead-agent-id` checks halt notices.
Timed JSONL calls and a p50/p95, pass/fail summary go in `~/.cmux/agents/<worker-id>/soak/`;
any violation exits 1 while remaining cycles continue. It checks receipts, replies, registry/screen state,
full versus `parsed_only` parity, placement, lead inbox, and exact-seat cleanup. A failed agent close is
retried once by agent ID; a leak is recorded for human cleanup without force-closing a saved surface ref.

`control_health` is sampled at start, every 60 seconds, and end. The summary checks one MCP stdio PID
for the full duration, healthy samples, and RSS growth at most 2x; the control daemon PID is separate. Inspect `summary.violations` and keep its JSONL before claiming green.
