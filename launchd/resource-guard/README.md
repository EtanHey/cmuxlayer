# cmux Resource Guard

One native executable, `cmux-resource-guard`, dispatches the watchdog and heavy-ML
guardian each enabled tick, the MCP reaper every fifth tick, and RAM sampler every
30th tick. launchd ticks every 60 seconds. The executable holds a kernel lock while
its Node child runs; a crash releases the lock without stranding a directory lock.
The guardian starts first. Due duties run concurrently, each in its own process
group with a 45-second wall-clock budget, followed by TERM and a two-second grace
before KILL. A hung duty therefore cannot starve the next tick. Timeouts appear in
the duty error log; skipped overlapping ticks appear in capped `guard.lock.log`.
The dispatcher closes its output pipes when the duty leader exits, so an escaped
descendant cannot hold the tick open. Delayed escalation still kills surviving
process-group members after leader exit; only an absent group is skipped.
Invalid tick state resets to zero with a warning.

Fresh installs enable only the sampler and dry-run reaper (`REAPER_DRY_RUN=1`).
The systems watchdog and controllayer heavy-ML guardian are host-specific, disabled
unless `watchdog` / `guardian` are true in
`~/.config/cmuxlayer/resource-guard.json`. Enabling them preserves their destructive
defaults: watchdog terminates cmux above its RSS threshold; guardian
reclaims idle backfills and kills unprotected runaways under memory danger. Set
`CMUX_MEM_WATCHDOG_DRY_RUN=1` / `HEAVY_ML_GUARD_ENABLE_KILL=0` for observation only.

```json
{"env":{}}
```

During installation, omitted duty keys inherit the loaded legacy duties. Only
explicit `false` opts a duty out; disabling a loaded legacy duty prints a warning.
The sample above inherits migration settings and keeps fresh installs safe.

All existing duty environment knobs remain supported under `env`; process env also
works. `CMUX_RESOURCE_GUARD_CONFIG` selects another config file. Diagnostics and
sampler data default to `~/Library/Logs/cmux-resource-guard/` on fresh installs.
Migration pins the legacy sampler default `~/Library/Logs/cmux-ram-sampler/`
unless a configured path overrides it, preserving history and guardian samples. Output streams rotate
at 5 MiB with one archive. Sampler JSONL and watchdog snapshots are capped after
each invocation; when the watchdog is enabled, only its latest two timestamped
snapshots remain. Explicit duty
log/data paths are preserved and capped there. Guardian state and RAM seat paths
retain their existing defaults. Configure `HEAVY_ML_CLX_CLI` only if that optional
host event sink exists; no clx, BrainBar, notify server, or agent skills are required.
The sampler's legacy stale threshold is preserved; tune it above 1800 seconds if
stale notifications are unwanted with the 30-tick cadence.

Both watchdog entrypoints measure process RSS with `ps -o rss=` (KiB), converted
to bytes with 1024. RSS is not physical footprint: IOSurface/compressed allocations
may be missing. Numeric thresholds and the resource-guard minimum floor are
unchanged; resource-guard compares each GUI PID, while the standalone watchdog
sums deduplicated stable/nightly PIDs and retains its compressor check. Unknown
RSS warns and skips action rather than substituting zero or probing task ports.
Snapshots and notifications identify the measurement as RSS. Resource-guard
retains its terminate-on-breach behavior; standalone remains warn-only.

The separately dispatched RAM sampler uses validated `ps` RSS in integer KiB,
with explicit `measurement_basis:"ps_rss"` and `memory_unit:"KiB"` fields. It records
nullable `rss_kib`, derived `rss_mb` (MiB), and `rss_window_peak_mb`. Trends and
window peaks use only matching instance/PID/basis/unit rows. Legacy footprint
rows and peaks stay unchanged. Unavailable RSS skips its trend while independent
pressure alerts remain active. Source checks do not establish installed behavior
or no-prompt acceptance. Verify installed bytes, naturally scheduled watchdog and
sampler ticks, and a separately observed UI interval.
jq is a Homebrew runtime dependency; socat is optional for the BrainBar sink.

Homebrew compiles the native launcher with absolute installed Node/entry paths,
and installs the launchd duty files under libexec. Release tooling applies the versioned
formula fragment before publishing the tap update. GitHub tag tarballs include
these tracked files. Installing the formula never starts or changes launchd jobs.
Use the installed [cutover command](../../docs/guides/resource-guard-cutover.md)
to install one job and archive the four legacy plists. Installation is opt-in.
