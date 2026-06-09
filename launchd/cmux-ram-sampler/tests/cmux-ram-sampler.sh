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

seed_fake_commands() {
  local root_dir="$1"
  local log_dir="$2"

  cat >"$root_dir/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/curl.log"
EOF
  chmod +x "$root_dir/bin/curl"

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
Pages occupied by compressor: 262144.
EOF

  export CMUX_RAM_SAMPLER_SOURCE_ONLY=1
  export CMUX_RAM_SAMPLER_LOG_DIR="$log_dir"
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

run_prediction_case
run_sampling_case
