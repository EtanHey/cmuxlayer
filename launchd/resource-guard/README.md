# cmux Resource Guard

One native executable, `cmux-resource-guard`, dispatches the watchdog and heavy-ML
guardian each enabled tick, the MCP reaper every fifth tick, and RAM sampler every
30th tick. launchd ticks every 60 seconds. The executable holds a kernel lock while
its Node child runs; a crash releases the lock without stranding a directory lock.
The guardian starts first. Due duties run concurrently, each in its own process
group with a 45-second wall-clock budget, followed by TERM and a two-second grace
before KILL. A hung duty therefore cannot starve the next tick. Timeouts appear in
the duty error log; skipped overlapping ticks appear in capped `guard.lock.log`.
Invalid tick state resets to zero with a warning.

Fresh installs enable only the sampler and dry-run reaper (`REAPER_DRY_RUN=1`).
The systems watchdog and controllayer heavy-ML guardian are host-specific, disabled
unless `watchdog` / `guardian` are true in
`~/.config/cmuxlayer/resource-guard.json`. Enabling them preserves their destructive
defaults: watchdog terminates cmux above its physical-footprint threshold; guardian
reclaims idle backfills and kills unprotected runaways under memory danger. Set
`CMUX_MEM_WATCHDOG_DRY_RUN=1` / `HEAVY_ML_GUARD_ENABLE_KILL=0` for observation only.

```json
{"watchdog":false,"guardian":false,"env":{"REAPER_DRY_RUN":"1"}}
```

All existing duty environment knobs remain supported under `env`; process env also
works. `CMUX_RESOURCE_GUARD_CONFIG` selects another config file. Diagnostics and
sampler data default to `~/Library/Logs/cmux-resource-guard/`. Output streams rotate
at 5 MiB with one archive. Sampler JSONL and watchdog snapshots are capped after
each invocation; when the watchdog is enabled, only its latest two timestamped
snapshots remain. Explicit duty
log/data paths are preserved and capped there. Guardian state and RAM seat paths
retain their existing defaults. Configure `HEAVY_ML_CLX_CLI` only if that optional
host event sink exists; no clx, BrainBar, notify server, or agent skills are required.
The sampler's legacy stale threshold is preserved; tune it above 1800 seconds if
stale notifications are unwanted with the 30-tick cadence.

The two shell duty ports preserve their original behavior except vmmap stderr:
the watchdog replaces its noisy raw diagnostics with one concise failure warning
and skips that PID. jq is a Homebrew runtime dependency. socat is optional for the
watchdog's BrainBar sink. Node and jq run from the installed Homebrew dependencies.

Homebrew compiles the native launcher with absolute installed Node/entry paths,
and installs the launchd duty files under libexec. Release tooling applies the versioned
formula fragment before publishing the tap update. GitHub tag tarballs include
these tracked files. Installing the formula never starts or changes launchd jobs.
The installer and legacy cutover are supplied by the stacked migration PR.
