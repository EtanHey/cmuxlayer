# Daemon performance budgets

`bun run bench:daemon:check` builds cmuxlayer, runs the production-shaped 8-client x 12-round daemon replay, and compares it with `benchmarks/daemon-baseline.json`. CI runs this command on every pull request and every push to `main`. `bun run pre-pr` runs the same gate with three rounds so regressions are visible before push.

The baseline was measured from v0.4.63 after PR #550. Runner-sensitive percentile ceilings include 2.8x margin for the slower GitHub runner. The first send after spawn remains an absolute 2,000 ms socket ceiling, the CLI ceiling remains 4,000 ms, and daemon `read_screen` p50 remains at most 250 ms.

## Refresh after a legitimate speedup

Run this script from the commit whose performance should become the new floor:

```bash
bun run bench:daemon:refresh
```

The script refuses a benchmark whose intrinsic gates are RED. It updates measurements and can only lower runner-sensitive ceilings; it never raises the 2,000 ms first-send, 4,000 ms CLI, or 250 ms read-screen p50 hard ceilings. Commit the changed JSON with the performance change and repeat the deliberate RED proof in CI. Do not refresh merely to make a regression green.
