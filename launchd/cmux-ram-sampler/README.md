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

## Prediction

The sampler reads only the trailing window from the JSONL log, estimates the
per-instance leak rate in MB/min, and projects ETA to the danger threshold.
Defaults:

- danger footprint: `20` GB
- danger swap free: `2` GB
- warning lead time: `30` minutes
- regression window: `12` samples

Warnings are logged to stderr and sent best-effort to:

```bash
http://localhost:3847/notify
```

Notification failures are non-fatal.

## Environment knobs

- `CMUX_RAM_SAMPLER_LOG_DIR`
- `CMUX_RAM_SAMPLER_SAMPLE_FILE`
- `CMUX_RAM_SAMPLER_DANGER_FOOTPRINT_GB`
- `CMUX_RAM_SAMPLER_DANGER_SWAP_FREE_GB`
- `CMUX_RAM_SAMPLER_WARNING_LEAD_MINUTES`
- `CMUX_RAM_SAMPLER_WINDOW_SAMPLES`
- `CMUX_RAM_SAMPLER_NOTIFY_URL`
- `CMUX_RAM_SAMPLER_STABLE_PATH`
- `CMUX_RAM_SAMPLER_NIGHTLY_PATH`

## Arm

Do not arm this from automation. Etan-gated arm command:

```bash
launchctl load /Users/etanheyman/Gits/cmuxlayer/launchd/cmux-ram-sampler/launchd/com.golems.cmux-ram-sampler.plist
```

## Test

```bash
bash launchd/cmux-ram-sampler/tests/run-tests.sh
```
