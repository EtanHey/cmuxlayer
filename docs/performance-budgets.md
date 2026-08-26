# Daemon performance budgets

`bun run bench:daemon:check` builds cmuxlayer, runs the production-shaped 8-client x 12-round daemon replay, and compares it with `benchmarks/daemon-baseline.json`. CI runs this command on every pull request and every push to `main`. `bun run pre-pr` uses the same requests with three rounds and retains the local 250 ms `read_screen`, 2,000 ms first-send, and 4,000 ms CLI gates so regressions are visible before push.

The committed baseline was measured by GitHub Actions on `ubuntu-latest` in workflow run `32927758842`. The checker derives every runner ceiling at check time from its committed measurement x `1.25`; the JSON has no separately editable `ceilings` block. First-send and CLI also have 10,000 ms far sanity caps. Actual time inside the first-send surface lock is compared separately from lock-acquisition wait.

The replay records both request byte counts and SHA-256 identities of canonical `{name, arguments}` JSON. The checker rejects request drift even when the serialized length is unchanged. It also validates a refresh content hash over the baseline: editing measurements or replay data without a refresh makes the consistency assertion fail before the benchmark can pass.

## Refresh after a legitimate speedup

Dispatch the `CI` workflow on the commit whose performance should become the new floor:

```bash
gh workflow run CI --ref <branch-or-sha>
```

The workflow-dispatch job collects three canonical 8-client x 12-round samples on one GitHub runner and uses the per-metric maximum as the measured baseline. It refuses changed request identities or byte counts, non-finite measurements, an over-budget sample, and any proposed measurement that would raise the committed baseline. It writes the source commit, workflow-run ID, and refresh content hash, then uploads the candidate baseline plus all raw samples. Download and inspect that artifact, then commit its `benchmarks/daemon-baseline.json`. The refresh command requires the GitHub Actions workflow-dispatch environment and an exact checked-out `GITHUB_SHA`.

Do not hand-edit or refresh a baseline merely to make a regression green. A code-regression proof must turn `perf-budget` RED; a baseline-only measurement edit must fail the consistency assertion.
