#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/bin/cmux-ram-sampler.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  [[ -f "$file" ]] || fail "missing file: $file"
  grep -F -- "$needle" "$file" >/dev/null || fail "expected '$needle' in $file"
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  [[ "$expected" == "$actual" ]] || fail "expected '$expected', got '$actual'"
}

assert_file_not_contains() {
  local file="$1"
  local needle="$2"
  if [[ -f "$file" ]] && grep -F -- "$needle" "$file" >/dev/null; then
    fail "did not expect '$needle' in $file"
  fi
}

curl_log_count() {
  local file="$1"
  if [[ -f "$file" ]]; then
    wc -l <"$file" | tr -d ' '
  else
    printf '0\n'
  fi
}

alert_file_count() {
  local file="$1"
  if [[ -f "$file" ]]; then
    wc -l <"$file" | tr -d ' '
  else
    printf '0\n'
  fi
}

assert_no_kill_invoked() {
  local file="$1"
  if [[ -f "$file" ]]; then
    fail "sampler invoked kill unexpectedly: $(cat "$file")"
  fi
}

source_sampler() {
  if [[ -n "${CMUX_RAM_SAMPLER_LOG_DIR:-}" ]]; then
    case "${CMUX_RAM_SAMPLER_NEARCRASH_STATE_DIR:-}" in
      "$CMUX_RAM_SAMPLER_LOG_DIR"/*) ;;
      *) export CMUX_RAM_SAMPLER_NEARCRASH_STATE_DIR="${CMUX_RAM_SAMPLER_BREACH_STATE_DIR:-$CMUX_RAM_SAMPLER_LOG_DIR/nearcrash-state}" ;;
    esac
    case "${CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE:-}" in
      "$CMUX_RAM_SAMPLER_LOG_DIR"/*) ;;
      *) export CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE="$CMUX_RAM_SAMPLER_LOG_DIR/routed-alerts.jsonl" ;;
    esac
  else
    unset CMUX_RAM_SAMPLER_NEARCRASH_STATE_DIR
    unset CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE
  fi
  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
}

seed_fake_commands() {
  local root_dir="$1"
  local log_dir="$2"

  cat >"$root_dir/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/curl.log"
EOF
  chmod +x "$root_dir/bin/curl"

  cat >"$root_dir/bin/nc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF
  chmod +x "$root_dir/bin/nc"

  cat >"$root_dir/bin/pgrep" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-f" && "\${2:-}" == "/Applications/cmux.app/Contents/MacOS/cmux" ]]; then
  printf '4242\n'
  exit 0
fi
if [[ "\${1:-}" == "-f" && "\${2:-}" == "/Applications/cmux NIGHTLY.app/Contents/MacOS/cmux" ]]; then
  printf '5151\n'
  exit 0
fi
exit 1
EOF
  chmod +x "$root_dir/bin/pgrep"
}

seed_ps_fallback_commands() {
  local root_dir="$1"
  local log_dir="$2"

  cat >"$root_dir/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/curl.log"
EOF
  chmod +x "$root_dir/bin/curl"

  cat >"$root_dir/bin/nc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF
  chmod +x "$root_dir/bin/nc"

  cat >"$root_dir/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 1
EOF
  chmod +x "$root_dir/bin/pgrep"

  cat >"$root_dir/bin/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '4242 /Applications/cmux.app/Contents/MacOS/cmux\n'
printf '5151 /Applications/cmux NIGHTLY.app/Contents/MacOS/cmux\n'
EOF
  chmod +x "$root_dir/bin/ps"
}

run_prediction_case() {
  local root_dir log_dir eta
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$log_dir"

  cat >"$log_dir/samples.jsonl" <<'EOF'
{"ts":"2026-06-09T10:00:00+0000","instance":"stable","pid":4242,"phys_footprint_mb":1000,"phys_footprint_peak_mb":1100,"swap_used_mb":100,"swap_free_mb":4096,"compressor_mb":64}
{"ts":"2026-06-09T10:05:00+0000","instance":"stable","pid":4242,"phys_footprint_mb":1250,"phys_footprint_peak_mb":1300,"swap_used_mb":100,"swap_free_mb":4096,"compressor_mb":64}
{"ts":"2026-06-09T10:10:00+0000","instance":"stable","pid":4242,"phys_footprint_mb":1500,"phys_footprint_peak_mb":1600,"swap_used_mb":100,"swap_free_mb":4096,"compressor_mb":64}
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  source_sampler

  eta="$(predict_eta_minutes "$log_dir/samples.jsonl" stable 2500 12)"
  assert_eq "20" "$eta"

  unset CMUX_RAM_SAMPLER_SAMPLE_FILE
  printf 'PASS: sampler predicts ETA from known 50 MB/min slope\n'
  rm -rf "$root_dir"
}

run_sampling_case() {
  local root_dir log_dir sample_file line_count
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 9.5 GB (peak 25 GB)
5151 phys_footprint: 2048 MB (peak 4096 MB)
EOF
  cat >"$root_dir/fixtures/swap.fixture" <<'EOF'
vm.swapusage: total = 8192.00M  used = 6144.00M  free = 2048.00M  (encrypted)
EOF
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages occupied by compressor: 262144.
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$log_dir/samples.jsonl"
  export CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_RAM_SAMPLER_SWAP_FIXTURE="$root_dir/fixtures/swap.fixture"
  export CMUX_RAM_SAMPLER_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  run_once

  sample_file="$log_dir/samples.jsonl"
  line_count="$(wc -l <"$sample_file" | tr -d ' ')"
  assert_eq "2" "$line_count"
  assert_file_contains "$sample_file" '"instance":"stable"'
  assert_file_contains "$sample_file" '"phys_footprint_mb":9728'
  assert_file_contains "$sample_file" '"phys_footprint_peak_mb":25600'
  assert_file_contains "$sample_file" '"instance":"nightly"'
  assert_file_contains "$sample_file" '"swap_free_mb":2048'
  assert_file_contains "$sample_file" '"compressor_mb":1024'

  printf 'PASS: sampler appends both cmux instance rows\n'
  rm -rf "$root_dir"
}

run_ps_fallback_sampling_case() {
  local root_dir log_dir sample_file line_count
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_ps_fallback_commands "$root_dir" "$log_dir"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 1024 MB (peak 2048 MB)
5151 phys_footprint: 2048 MB (peak 4096 MB)
EOF
  cat >"$root_dir/fixtures/swap.fixture" <<'EOF'
vm.swapusage: total = 8192.00M  used = 6144.00M  free = 1024.00M  (encrypted)
EOF
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages occupied by compressor: 262144.
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$log_dir/samples.jsonl"
  export CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_RAM_SAMPLER_SWAP_FIXTURE="$root_dir/fixtures/swap.fixture"
  export CMUX_RAM_SAMPLER_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  run_once

  sample_file="$log_dir/samples.jsonl"
  line_count="$(wc -l <"$sample_file" | tr -d ' ')"
  assert_eq "2" "$line_count"
  assert_file_contains "$sample_file" '"instance":"stable"'
  assert_file_contains "$sample_file" '"instance":"nightly"'
  assert_file_contains "$sample_file" '"swap_free_mb":1024'

  printf 'PASS: sampler falls back to ps command discovery when pgrep misses GUI apps\n'
  rm -rf "$root_dir"
}

run_vmstat_page_size_case() {
  local root_dir compressor_mb
  root_dir="$(mktemp -d)"
  mkdir -p "$root_dir/fixtures"

  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages occupied by compressor: 262144.
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"

  source_sampler
  compressor_mb="$(vmstat_compressor_mb)"
  assert_eq "4096" "$compressor_mb"

  printf 'PASS: sampler derives compressor MB from vm_stat page size\n'
  rm -rf "$root_dir"
}

run_routine_high_records_without_alert_case() {
  local root_dir log_dir
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 1024 MB (peak 2048 MB)
5151 phys_footprint: 2048 MB (peak 4096 MB)
EOF
  cat >"$root_dir/fixtures/swap.fixture" <<'EOF'
vm.swapusage: total = 8192.00M  used = 1024.00M  free = 4096.00M  (encrypted)
EOF
  cat >"$root_dir/fixtures/memsize.fixture" <<'EOF'
hw.memsize: 1638400
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$log_dir/samples.jsonl"
  export CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_RAM_SAMPLER_SWAP_FIXTURE="$root_dir/fixtures/swap.fixture"
  export CMUX_RAM_SAMPLER_MEMSIZE_FIXTURE="$root_dir/fixtures/memsize.fixture"
  export CMUX_RAM_SAMPLER_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 6.
Pages inactive: 6.
Pages occupied by compressor: 0.
EOF
  export CMUX_RAM_SAMPLER_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  source_sampler
  run_once
  assert_file_contains "$log_dir/samples.jsonl" '"free_ram_pct":12'
  assert_eq "0" "$(curl_log_count "$log_dir/curl.log")"
  assert_eq "0" "$(alert_file_count "$log_dir/routed-alerts.jsonl")"

  : >"$log_dir/curl.log"
  : >"$log_dir/samples.jsonl"
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 7.
Pages inactive: 6.
Pages occupied by compressor: 0.
EOF
  run_once
  assert_file_not_contains "$log_dir/curl.log" "http://localhost:3847/notify"
  assert_file_contains "$log_dir/samples.jsonl" '"free_ram_pct":13'

  : >"$log_dir/curl.log"
  : >"$log_dir/samples.jsonl"
  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "2026-06-09T10:10:00+0000" 1024 1024 0 13 20480
  assert_eq "0" "$(curl_log_count "$log_dir/curl.log")"
  assert_eq "0" "$(alert_file_count "$log_dir/routed-alerts.jsonl")"
  assert_file_contains "$log_dir/samples.jsonl" '"swap_free_mb":1024'

  printf 'PASS: sampler records routine-high free_ram_pct without alerting\n'
  rm -rf "$root_dir"
}

run_nearcrash_routed_alert_edge_case() {
  local root_dir log_dir sample_file alert_file
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  sample_file="$log_dir/samples.jsonl"
  alert_file="$log_dir/routed-alerts.jsonl"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  cat >"$root_dir/bin/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '9999 900000 /Applications/Browser.app/Contents/MacOS/browser --tabs\n'
printf '7777 450000 /Applications/Design.app/Contents/MacOS/design\n'
printf '4242 200000 /Applications/cmux.app/Contents/MacOS/cmux\n'
EOF
  chmod +x "$root_dir/bin/ps"

  cat >"$root_dir/bin/kill" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/kill.log"
EOF
  chmod +x "$root_dir/bin/kill"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 1024 MB (peak 2048 MB)
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$sample_file"
  export CMUX_RAM_SAMPLER_BREACH_STATE_DIR="$log_dir/test-breach-state"
  export CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE="$alert_file"
  export CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_RAM_SAMPLER_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "2026-06-09T10:00:00+0000" 1024 4096 0 4 20480
  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "2026-06-09T10:05:00+0000" 1024 4096 0 4 20480

  assert_eq "1" "$(alert_file_count "$alert_file")"
  assert_file_contains "$alert_file" '"type":"near_crash"'
  assert_file_contains "$alert_file" '"priority":"critical"'
  assert_file_contains "$alert_file" '"route":"orchestrator/cmux-LEAD"'
  assert_file_contains "$alert_file" '"offenders"'
  assert_file_contains "$alert_file" 'Browser.app'
  assert_file_contains "$alert_file" 'cmux.app'
  assert_no_kill_invoked "$log_dir/kill.log"
  assert_eq "2" "$(wc -l <"$sample_file" | tr -d ' ')"

  printf 'PASS: sampler routes one near-crash alert with offenders and never kills cmux\n'
  rm -rf "$root_dir"
}

run_nearcrash_recovery_reroute_case() {
  local root_dir log_dir alert_file
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  alert_file="$log_dir/routed-alerts.jsonl"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  cat >"$root_dir/bin/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '9999 900000 /Applications/Browser.app/Contents/MacOS/browser --tabs\n'
printf '4242 200000 /Applications/cmux.app/Contents/MacOS/cmux\n'
EOF
  chmod +x "$root_dir/bin/ps"

  cat >"$root_dir/bin/kill" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/kill.log"
EOF
  chmod +x "$root_dir/bin/kill"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 1024 MB (peak 2048 MB)
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$log_dir/samples.jsonl"
  export CMUX_RAM_SAMPLER_BREACH_STATE_DIR="$log_dir/test-breach-state"
  export CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE="$alert_file"
  export CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_RAM_SAMPLER_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "2026-06-09T10:00:00+0000" 1024 4096 0 4 20480
  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "2026-06-09T10:05:00+0000" 1024 4096 0 5 20480
  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "2026-06-09T10:10:00+0000" 1024 4096 0 4 20480

  assert_eq "2" "$(alert_file_count "$alert_file")"
  assert_no_kill_invoked "$log_dir/kill.log"

  printf 'PASS: sampler re-routes after near-crash recovery and later cross\n'
  rm -rf "$root_dir"
}

run_never_nearcrash_alert_case() {
  local root_dir log_dir
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 1024 MB (peak 2048 MB)
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$log_dir/samples.jsonl"
  export CMUX_RAM_SAMPLER_BREACH_STATE_DIR="$log_dir/test-breach-state"
  export CMUX_RAM_SAMPLER_ROUTED_ALERT_FILE="$log_dir/routed-alerts.jsonl"
  export CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_RAM_SAMPLER_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "2026-06-09T10:00:00+0000" 1024 4096 0 5 20480
  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "2026-06-09T10:05:00+0000" 1024 4096 0 5 20480

  assert_eq "0" "$(curl_log_count "$log_dir/curl.log")"
  assert_eq "0" "$(alert_file_count "$log_dir/routed-alerts.jsonl")"

  printf 'PASS: sampler never alerts when memory is never near-crash\n'
  rm -rf "$root_dir"
}

run_notify_skip_case() {
  local root_dir log_dir stderr_log
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  stderr_log="$root_dir/stderr.log"
  mkdir -p "$root_dir/bin" "$log_dir"

  cat >"$root_dir/bin/nc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 1
EOF
  chmod +x "$root_dir/bin/nc"

  cat >"$root_dir/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/curl.log"
EOF
  chmod +x "$root_dir/bin/curl"

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  notify_warning stable 4242 1024 unknown 4096 12 2>"$stderr_log"
  assert_file_contains "$stderr_log" "notify listener unavailable"
  assert_file_not_contains "$log_dir/curl.log" "http://localhost:3847/notify"

  printf 'PASS: sampler skips notification loudly when listener is down\n'
  rm -rf "$root_dir"
}

run_notify_skip_all_sampler_paths_case() {
  local root_dir log_dir warning_stderr stale_stderr
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  warning_stderr="$root_dir/warning.stderr.log"
  stale_stderr="$root_dir/stale.stderr.log"
  mkdir -p "$root_dir/bin" "$log_dir"

  cat >"$root_dir/bin/nc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 1
EOF
  chmod +x "$root_dir/bin/nc"

  cat >"$root_dir/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/curl.log"
EOF
  chmod +x "$root_dir/bin/curl"

  printf '{"ts":"2026-06-09T10:00:00+0000","instance":"stable"}\n' >"$log_dir/samples.jsonl"

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$log_dir/samples.jsonl"
  export CMUX_RAM_SAMPLER_SAMPLE_MTIME_EPOCH=1000
  export CMUX_RAM_SAMPLER_NOW_EPOCH=2200
  export CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS=600
  export CMUX_RAM_SAMPLER_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  notify_warning stable 4242 1024 unknown 4096 12 2>"$warning_stderr"
  check_sample_freshness 2>"$stale_stderr"

  assert_file_contains "$warning_stderr" "notify listener unavailable at localhost:3847; skipping notification"
  assert_file_contains "$stale_stderr" "notify listener unavailable at localhost:3847; skipping notification"
  assert_file_not_contains "$log_dir/curl.log" "http://localhost:3847/notify"

  printf 'PASS: sampler skips curl posts on every notify path when listener is down\n'
  rm -rf "$root_dir"
}

run_notify_reprobe_after_post_failure_case() {
  local root_dir log_dir stderr_log
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  stderr_log="$root_dir/stderr.log"
  mkdir -p "$root_dir/bin" "$log_dir"

  cat >"$root_dir/bin/nc" <<EOF
#!/usr/bin/env bash
set -euo pipefail
count_file="$log_dir/nc-count"
count=0
if [[ -f "\$count_file" ]]; then
  count="\$(cat "\$count_file")"
fi
count=\$((count + 1))
printf '%s\n' "\$count" >"\$count_file"
if [[ "\$count" == "1" ]]; then
  exit 0
fi
exit 1
EOF
  chmod +x "$root_dir/bin/nc"

  cat >"$root_dir/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/curl.log"
exit 7
EOF
  chmod +x "$root_dir/bin/curl"

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  notify_warning stable 4242 1024 unknown 4096 12 2>"$stderr_log"
  assert_file_contains "$log_dir/curl.log" "http://localhost:3847/notify"
  assert_file_contains "$stderr_log" "notify listener unavailable at localhost:3847; skipping notification"
  assert_file_not_contains "$stderr_log" "notify post failed at http://localhost:3847/notify"

  printf 'PASS: sampler re-probes and skip-logs when listener drops after notify probe\n'
  rm -rf "$root_dir"
}

run_free_ram_unknown_on_parse_failure_case() {
  local root_dir log_dir stderr_log pct
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  stderr_log="$root_dir/stderr.log"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 1024 MB (peak 2048 MB)
5151 phys_footprint: 2048 MB (peak 4096 MB)
EOF
  cat >"$root_dir/fixtures/swap.fixture" <<'EOF'
vm.swapusage: total = 8192.00M  used = 1024.00M  free = 4096.00M  (encrypted)
EOF
  cat >"$root_dir/fixtures/memsize.fixture" <<'EOF'
hw.memsize:
EOF
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages inactive: 100.
Pages occupied by compressor: 0.
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$log_dir/samples.jsonl"
  export CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_RAM_SAMPLER_SWAP_FIXTURE="$root_dir/fixtures/swap.fixture"
  export CMUX_RAM_SAMPLER_MEMSIZE_FIXTURE="$root_dir/fixtures/memsize.fixture"
  export CMUX_RAM_SAMPLER_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  pct="$(free_ram_pct 2>"$stderr_log")"
  assert_eq "unknown" "$pct"
  assert_file_contains "$stderr_log" "free_ram_pct unknown: invalid hw.memsize"
  run_once 2>>"$stderr_log"
  assert_file_contains "$log_dir/samples.jsonl" '"free_ram_pct":null'
  assert_file_contains "$stderr_log" "free_ram_pct unavailable; skipping free-RAM trigger"

  : >"$stderr_log"
  cat >"$root_dir/fixtures/memsize.fixture" <<'EOF'
hw.memsize: 1638400
EOF
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 16384 bytes)
garbage
Pages occupied by compressor: 0.
EOF

  pct="$(free_ram_pct 2>"$stderr_log")"
  assert_eq "unknown" "$pct"
  assert_file_contains "$stderr_log" "free_ram_pct unknown: missing vm_stat free/inactive pages"

  : >"$stderr_log"
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages occupied by compressor: 0.
EOF

  pct="$(free_ram_pct 2>"$stderr_log")"
  assert_eq "unknown" "$pct"
  assert_file_contains "$stderr_log" "free_ram_pct unknown: missing vm_stat free/inactive pages"

  printf 'PASS: sampler reports unknown instead of false-safe free_ram_pct on parse failures\n'
  rm -rf "$root_dir"
}

run_free_ram_midrange_case() {
  local root_dir pct
  root_dir="$(mktemp -d)"
  mkdir -p "$root_dir/fixtures"

  cat >"$root_dir/fixtures/memsize.fixture" <<'EOF'
hw.memsize: 3276800
EOF
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 40.
Pages inactive: 40.
Pages occupied by compressor: 0.
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_MEMSIZE_FIXTURE="$root_dir/fixtures/memsize.fixture"
  export CMUX_RAM_SAMPLER_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"

  source_sampler
  pct="$(free_ram_pct)"
  assert_eq "40" "$pct"

  printf 'PASS: sampler computes mid-range free_ram_pct from valid vm_stat and memsize\n'
  rm -rf "$root_dir"
}

run_sample_freshness_case() {
  local root_dir log_dir stderr_log
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  stderr_log="$root_dir/stderr.log"
  mkdir -p "$root_dir/bin" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  printf '{"ts":"2026-06-09T10:00:00+0000","instance":"stable"}\n' >"$log_dir/samples.jsonl"

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
  export CMUX_RAM_SAMPLER_SAMPLE_FILE="$log_dir/samples.jsonl"
  export CMUX_RAM_SAMPLER_SAMPLE_MTIME_EPOCH=1000
  export CMUX_RAM_SAMPLER_NOW_EPOCH=2200
  export CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS=600
  export CMUX_RAM_SAMPLER_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  source_sampler
  check_sample_freshness 2>"$stderr_log"
  assert_file_contains "$stderr_log" "samples.jsonl stale"
  assert_file_contains "$log_dir/curl.log" "http://localhost:3847/notify"

  printf 'PASS: sampler emits loud warning for stale samples.jsonl\n'
  rm -rf "$root_dir"
}

run_plist_case() {
  local plist program interval run_at_load
  plist="$ROOT_DIR/launchd/com.golems.cmux-ram-sampler.plist"
  program="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist")"
  interval="$(/usr/libexec/PlistBuddy -c 'Print :StartInterval' "$plist")"
  run_at_load="$(/usr/libexec/PlistBuddy -c 'Print :RunAtLoad' "$plist")"

  [[ -x "$program" ]] || fail "plist ProgramArguments path is not executable: $program"
  assert_eq "1800" "$interval"
  assert_eq "true" "$run_at_load"
  /usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$plist" | grep -F 'cmux-ram-sampler' >/dev/null \
    || fail "plist missing sampler stdout log path"
  /usr/libexec/PlistBuddy -c 'Print :StandardErrorPath' "$plist" | grep -F 'cmux-ram-sampler' >/dev/null \
    || fail "plist missing sampler stderr log path"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CMUX_RAM_SAMPLER_DANGER_FREE_RAM_PCT' "$plist" | grep -Fx '12' >/dev/null \
    || fail "plist missing free RAM threshold env"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CMUX_RAM_SAMPLER_NEARCRASH_FREE_RAM_PCT' "$plist" | grep -Fx '4' >/dev/null \
    || fail "plist missing near-crash free RAM threshold env"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CMUX_RAM_SAMPLER_NEARCRASH_COMPRESSOR_FRAC' "$plist" | grep -Fx '0.80' >/dev/null \
    || fail "plist missing near-crash compressor threshold env"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CMUX_RAM_SAMPLER_ALERT_ROUTE' "$plist" | grep -Fx 'orchestrator/cmux-LEAD' >/dev/null \
    || fail "plist missing alert route env"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS' "$plist" | grep -Fx '600' >/dev/null \
    || fail "plist missing sample freshness env"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CMUX_RAM_SAMPLER_NOTIFY_URL' "$plist" | grep -Fx 'http://127.0.0.1:3847/notify' >/dev/null \
    || fail "plist missing pinned notify URL env"

  printf 'PASS: sampler launchd plist is armable with expected structure\n'
}

run_vmstat_page_size_case
run_routine_high_records_without_alert_case
run_nearcrash_routed_alert_edge_case
run_nearcrash_recovery_reroute_case
run_never_nearcrash_alert_case
run_notify_skip_case
run_notify_skip_all_sampler_paths_case
run_notify_reprobe_after_post_failure_case
run_free_ram_unknown_on_parse_failure_case
run_free_ram_midrange_case
run_sample_freshness_case
run_plist_case
run_prediction_case
run_sampling_case
run_ps_fallback_sampling_case
