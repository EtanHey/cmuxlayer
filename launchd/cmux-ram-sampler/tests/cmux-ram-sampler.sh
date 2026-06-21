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
  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"

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

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
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

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
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

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  compressor_mb="$(vmstat_compressor_mb)"
  assert_eq "4096" "$compressor_mb"

  printf 'PASS: sampler derives compressor MB from vm_stat page size\n'
  rm -rf "$root_dir"
}

run_free_ram_threshold_case() {
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
  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  run_once
  assert_file_contains "$log_dir/curl.log" "http://localhost:3847/notify"
  assert_file_contains "$log_dir/samples.jsonl" '"free_ram_pct":12'

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

  printf 'PASS: sampler warns at free_ram_pct <= 12 and not at 13\n'
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

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  notify_warning stable 4242 1024 unknown 4096 12 2>"$stderr_log"
  assert_file_contains "$stderr_log" "notify listener unavailable"
  assert_file_not_contains "$log_dir/curl.log" "http://localhost:3847/notify"

  printf 'PASS: sampler skips notification loudly when listener is down\n'
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

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
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
  assert_eq "300" "$interval"
  assert_eq "true" "$run_at_load"
  /usr/libexec/PlistBuddy -c 'Print :StandardOutPath' "$plist" | grep -F 'cmux-ram-sampler' >/dev/null \
    || fail "plist missing sampler stdout log path"
  /usr/libexec/PlistBuddy -c 'Print :StandardErrorPath' "$plist" | grep -F 'cmux-ram-sampler' >/dev/null \
    || fail "plist missing sampler stderr log path"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CMUX_RAM_SAMPLER_DANGER_FREE_RAM_PCT' "$plist" | grep -Fx '12' >/dev/null \
    || fail "plist missing free RAM threshold env"
  /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS' "$plist" | grep -Fx '600' >/dev/null \
    || fail "plist missing sample freshness env"

  printf 'PASS: sampler launchd plist is armable with expected structure\n'
}

run_vmstat_page_size_case
run_free_ram_threshold_case
run_notify_skip_case
run_sample_freshness_case
run_plist_case
run_prediction_case
run_sampling_case
run_ps_fallback_sampling_case
