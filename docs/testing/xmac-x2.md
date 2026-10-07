# Cross-Mac scenarios 5–9

X2 modules in `scripts/xmac/scenarios/` consume the lead-pinned context v1.1.
Run local synthetic tests with:

```sh
bun run test tests/xmac-scenarios-resume.test.ts tests/xmac-scenarios-delivery.test.ts
```

These tests validate scenario judgments, not real harness behavior. Live bug/fix
replays remain required; candidate bug SHAs are not replay receipts. PR-c #1026
and PR-d #1028 have merged fix SHAs; other fix metadata remains pending.

| Row | Evidence required |
| --- | --- |
| `stray_newline` | Exact one-line prompt transcript, no leading blank prompt row, authored reply |
| `resume_stale_done` | Issued old DONE report confirmed before close, resumed ready screen, successful ready wait |
| `resume_focus` | Distinct focus anchor unchanged after focus=false resume, ready screen |
| `resume_keeps_worker_role` | Actual child connector overrides preserved, registry worker role, right column |
| `lead_spawn_role_worker` | Isolated Haiku lead invokes a role-omitted Claude spawn, worker child record and right-column reply |
| `busy_codex_steer_vs_queue` | Busy screen, distinct pending headings, unconsumed receipt, terminal receipt and authored reply |
| `codex_launch_under_cmux_wrapper` | NIGHTLY only, authored reply, actual process identity and duplicate flag counts |

The runner owns normal seats and sweeps lead-created children through
`spawnLeadSeat`; the scenario also closes discovered children. Busy seats close between
modes to keep one worker active. The old-DONE scenario writes only the report
path issued to its test seat, through that seat, then verifies the final marker.

Core preconditions: isolate every harness/MCP configuration; the Haiku lead's
cmuxlayer MCP must use the target test daemon. NIGHTLY launcher runs require
`target.codexWrapper`; the runner resolves Codex through that wrapper and records
the pane's resolved path. Child process arguments are inspected
but only connector policy and flag counts are saved, since full argv may contain
private configuration. Missing screen, topology, policy or focus evidence fails.
