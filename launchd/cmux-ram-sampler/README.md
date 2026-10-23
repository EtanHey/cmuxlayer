# cmux RAM Sampler

Samples the stable and nightly cmux app processes with `ps -o rss=` without
requesting a task port. RSS excludes compressed/swapped memory accounted by
physical footprint; the independent swap, compressor and free-RAM signals remain.

## What it records

Every run resolves PIDs by bundle path:

- `stable`: `/Applications/cmux.app/Contents/MacOS/cmux`
- `nightly`: `/Applications/cmux NIGHTLY.app/Contents/MacOS/cmux`

It appends JSONL rows to:

```bash
~/Library/Logs/cmux-ram-sampler/samples.jsonl
```

Each row includes:

- timestamp
- instance name
- pid
- `measurement_basis: "ps_rss"`, `memory_unit: "KiB"`
- `rss_kib`: validated integer KiB; `rss_mb`: KiB / 1024 (MiB)
- `rss_window_peak_mb`: maximum observed RSS in the trailing regression window
  for that instance/PID/basis, including the current reading; not a lifetime peak
- swap used/free from `sysctl vm.swapusage`
- compressor pages from `vm_stat`
- free RAM percent from `vm_stat` and `hw.memsize`

## Levels

The sampler records routine-high memory pressure but does not notify for it.
Defaults:

- danger RSS: `20` GiB (same numeric threshold as the former footprint setting)
- danger swap free: `2` GB
- danger free RAM: `12` percent
- near-crash free RAM: `4` percent
- near-crash compressor fraction: `0.80` of physical RAM
- stale sample warning: `600` seconds
- warning lead time: `30` minutes
- regression window: `12` samples

Near-crash is edge-triggered per instance. On the transition into near-crash,
the sampler appends a critical routed alert to:

```bash
~/Library/Logs/cmux-ram-sampler/routed-alerts.jsonl
```

The alert route defaults to `orchestrator/cmux-LEAD` and includes the top RSS
offender list. The sampler never kills processes.

## Prediction

The sampler reads only the trailing window from the JSONL log, estimates the
per-instance/PID RSS growth in MiB/min, and projects ETA to the danger threshold.
Only rows explicitly carrying the RSS basis/unit and valid integer KiB participate.
Historical footprint rows/peaks remain unchanged and never enter RSS predictions
or peaks. Failed, empty, malformed, multiline or oversized RSS is recorded as
`null` in RSS fields and skips prediction; independent near-crash signals still
route alerts. Prediction is logged only; it does not notify. New routed alerts
carry the same RSS basis/unit and nullable RSS values. No history migration runs.

## Environment knobs

- `CMUX_RAM_SAMPLER_LOG_DIR`
- `CMUX_RAM_SAMPLER_SAMPLE_FILE`
- `CMUX_RAM_SAMPLER_DANGER_RSS_GB` (takes precedence)
- `CMUX_RAM_SAMPLER_DANGER_FOOTPRINT_GB` (legacy numeric alias, now RSS)
- `CMUX_RAM_SAMPLER_DANGER_SWAP_FREE_GB`
- `CMUX_RAM_SAMPLER_DANGER_FREE_RAM_PCT`
- `CMUX_RAM_SAMPLER_NEARCRASH_FREE_RAM_PCT`
- `CMUX_RAM_SAMPLER_NEARCRASH_COMPRESSOR_FRAC`
- `CMUX_RAM_SAMPLER_NEARCRASH_STATE_DIR`
- `CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE`
- `CMUX_RAM_SAMPLER_ALERT_ROUTE`
- `CMUX_RAM_SAMPLER_TOP_RSS_LIMIT`
- `CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS`
- `CMUX_RAM_SAMPLER_WARNING_LEAD_MINUTES`
- `CMUX_RAM_SAMPLER_WINDOW_SAMPLES`
- `CMUX_RAM_SAMPLER_NOTIFY_URL`
- `CMUX_RAM_SAMPLER_STABLE_PATH`
- `CMUX_RAM_SAMPLER_NIGHTLY_PATH`

## Arm

Do not arm this from automation. Etan-gated arm command:

```bash
launchd/cmux-ram-sampler/install.sh --dry-run
launchd/cmux-ram-sampler/install.sh --install
```

The installer renders and XML-escapes checkout/home tokens, lints the staged
plist, and reloads the rendered copy under `~/Library/LaunchAgents`.

## Test

```bash
bash launchd/cmux-ram-sampler/tests/run-tests.sh
```
