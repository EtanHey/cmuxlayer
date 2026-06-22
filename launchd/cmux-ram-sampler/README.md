# cmux RAM Sampler

Samples the stable and nightly cmux app processes with `phys_footprint`, the same
per-process memory metric Activity Monitor reports. This catches compressed and
swapped resident memory that `ps -o rss=` does not include.

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
- `phys_footprint_mb`
- `phys_footprint_peak_mb`
- swap used/free from `sysctl vm.swapusage`
- compressor pages from `vm_stat`
- free RAM percent from `vm_stat` and `hw.memsize`

## Levels

The sampler records routine-high memory pressure but does not notify for it.
Defaults:

- danger footprint: `20` GB
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
per-instance leak rate in MB/min, and projects ETA to the danger threshold.
Prediction is logged only; it does not notify.

## Environment knobs

- `CMUX_RAM_SAMPLER_LOG_DIR`
- `CMUX_RAM_SAMPLER_SAMPLE_FILE`
- `CMUX_RAM_SAMPLER_DANGER_FOOTPRINT_GB`
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
launchctl bootout gui/$(id -u) /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-ram-sampler/launchd/com.golems.cmux-ram-sampler.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-ram-sampler/launchd/com.golems.cmux-ram-sampler.plist
```

## Test

```bash
bash launchd/cmux-ram-sampler/tests/run-tests.sh
```
