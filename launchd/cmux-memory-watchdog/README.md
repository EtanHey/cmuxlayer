# cmux memory watchdog

This launchd bundle samples cmux RSS and macOS compressor use
once per minute. Threshold breaches write a process snapshot and send warning
evidence; the watchdog is warn-only and does not kill cmux.

The package is retained because both the real watchdog script and its warning
behavior are covered by automated tests. The plist had no installation path,
so `install.sh` now renders checkout- and home-relative paths before loading it.

## Verify without installing

The installer defaults to a dry run and prints the rendered plist:

```bash
launchd/cmux-memory-watchdog/install.sh --dry-run
```

Run the package tests with:

```bash
bash launchd/cmux-memory-watchdog/tests/run-tests.sh
```

## Install

Installing or reloading a LaunchAgent is an operator action. After reviewing
the dry-run output, Etan can explicitly arm it with:

```bash
launchd/cmux-memory-watchdog/install.sh --install
```

That command writes
`~/Library/LaunchAgents/com.golems.cmux-memory-watchdog.plist`, validates it,
boots out an older copy if present, and bootstraps the rendered unit.

Default thresholds are 5 GB aggregate cmux RSS and 12 GB macOS
compressor use. Override them in the rendered plist or via the documented
`CMUX_MEM_WATCHDOG_*` variables in the watchdog script.

RSS comes from `ps -o rss=` in KiB and is converted to bytes using 1024.
It is not physical footprint and can miss IOSurface/compressed allocations. Numeric
thresholds and compressor checks are retained; no equivalence or full leak coverage
is implied. The legacy `CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB` setting keeps
its existing precedence as an RSS threshold alias. Unknown RSS skips the RSS signal
with a warning while the compressor check remains independent; there is no task-port fallback.
