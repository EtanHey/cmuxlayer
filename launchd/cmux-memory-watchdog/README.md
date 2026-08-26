# cmux memory watchdog

This launchd bundle samples cmux physical footprint and macOS compressor use
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

Default thresholds are 5 GB aggregate cmux physical footprint and 12 GB macOS
compressor use. Override them in the rendered plist or via the documented
`CMUX_MEM_WATCHDOG_*` variables in the watchdog script.
