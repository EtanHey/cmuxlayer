# Daemon performance budgets

`bun run bench:daemon:check` builds cmuxlayer, runs the production-shaped 8-client x 12-round daemon replay, and compares it with `benchmarks/daemon-baseline.json`. CI runs this command on every pull request and every push to `main`. `bun run pre-pr` uses the same requests with three rounds and retains the local 250 ms `read_screen`, 2,000 ms first-send, and 4,000 ms CLI gates so regressions are visible before push.

The committed baseline was measured by GitHub Actions on `ubuntu-latest` in workflow run `32928658291` and imported by attested refresh run `32929454011`. The checker derives every runner ceiling at check time from its committed measurement x `1.25`; the JSON has no separately editable `ceilings` block. First-send and CLI also have 10,000 ms far sanity caps. Actual time inside the first-send surface lock is compared separately from lock-acquisition wait.

The replay records both request byte counts and SHA-256 identities of canonical `{name, arguments}` JSON. The checker rejects request drift even when the serialized length is unchanged. It also validates a refresh content hash over the baseline: editing measurements or replay data without a refresh makes the consistency assertion fail before the benchmark can pass.

For `first_send_after_spawn` and `send_to_agent_warm`, each sampled send starts a read-only `system.ping` against the benchmark's fake cmux socket. The fake server arms a 1 ms timer before any fake-state read and returns its actual start, due, and fire times. The checker counts only timer overrun that overlaps the measured send interval; connection and fake-server work, or a timer that fires late after the send, cannot excuse latency. A timer firing at most 2 ms before its nominal due time is valid zero-overrun proof because `setTimeout(1)` and the clock can differ at sub-millisecond resolution; earlier fires are invalid. Controls are collected after the canonical lifecycle sequence, without awaiting one between sends. Only overlap above the median of valid controls may be subtracted from a valid paired send, capped at the send's excess over its own run median, before comparing p50/p95 with the existing committed ceilings. A fast control leaves a slow send over budget. An invalid pair uses that send's raw latency; if all pairs are invalid, the row uses the raw p50/p95. The checker adds each row's valid/invalid pair counts, reason counts, and `verdict_basis` (`adjusted` or `raw`) to `result.json` under `perf_budget.paired_control_evaluation` and to `comment.md`. The artifact retains both raw and paired samples, and the CI comment shows the slowest sends with route, lock, enumerate, type, and verify timings. The ping runs outside the daemon, so daemon-only latency is still charged to the product.

Each lifecycle measures `first_send_after_spawn` while a daemon sweep is held on the lifecycle lock. Then it releases the hold and waits for the sweep to report `complete` before measuring `send_to_agent_warm`. The daemon writes `complete` only after the released sweep body (`runSweepOnce`) has finished, not when the hold is released. The warm send therefore no longer runs inside that sweep's body. The sweep's post-lock delivery drain and verification can still run briefly alongside it, and so can a later periodic sweep. Before #791, `complete` was written the moment the hold was released. As a result, every warm send in 35 hosted runs (3,360 samples) started 3-5 ms into a live sweep. When that sweep's sidebar pass stalled the daemon event loop for 150 ms or more, 29 of 31 overlapping sends were slow. Across 78 hosted runs, that alone turned `send_to_agent_warm` p95 RED in 7 of them while p50 stayed flat. Sweep contention is budgeted by `spawn_close_during_sweep` and the held first send. The warm row keeps its committed ceiling and margin rule.

## Refresh after a legitimate speedup

Dispatch the `CI` workflow on the commit whose performance should become the new floor:

```bash
gh workflow run CI --ref <branch-or-sha>
```

The workflow-dispatch job collects three canonical 8-client x 12-round samples on one GitHub runner and uses the per-metric maximum as the measured baseline. It refuses changed request identities or byte counts, non-finite measurements, an over-budget sample, and any proposed measurement that would raise the committed baseline. It writes the source commit, workflow-run ID, and refresh content hash, then uploads the candidate baseline plus all raw samples. Download and inspect that artifact, then commit its `benchmarks/daemon-baseline.json`. The refresh command requires the GitHub Actions workflow-dispatch environment and an exact checked-out `GITHUB_SHA`.

If a later `ubuntu-latest` runner is demonstrably slower than the runner that produced the committed baseline, first run the normal pull-request CI at the calibration commit. Then dispatch the same commit and import that exact perf artifact:

```bash
gh workflow run CI --ref <calibration-commit> -f baseline_source_run_id=<ci-run-id>
```

This explicit runner rebase accepts only a `CI` pull-request run from the dispatched commit or an ancestor separated solely by the baseline workflow, checker, refresh script, baseline JSON, documentation, or tests. Runtime-source changes are refused. It verifies the canonical replay identity and retains the larger of each committed and imported measurement, so unrelated metrics cannot silently tighten. The source run and SHA remain in the attested baseline. This is only for reviewed runner-class drift; the ordinary no-input refresh remains improvement-only and refuses every baseline increase.

Do not hand-edit or refresh a baseline merely to make a regression green. A code-regression proof must turn `perf-budget` RED; a baseline-only measurement edit must fail the consistency assertion.
