#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/bin/cmux-memory-watchdog.sh"

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

assert_file_not_contains() {
  local file="$1"
  local needle="$2"
  if [[ -f "$file" ]] && grep -F -- "$needle" "$file" >/dev/null; then
    fail "did not expect '$needle' in $file"
  fi
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

  cat >"$root_dir/bin/nc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF
  chmod +x "$root_dir/bin/nc"

  cat >"$root_dir/bin/socat" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/socat.log"
EOF
  chmod +x "$root_dir/bin/socat"

  cat >"$root_dir/bin/sleep" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/sleep.log"
EOF
  chmod +x "$root_dir/bin/sleep"

  cat >"$root_dir/bin/kill" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/kill.log"
EOF
  chmod +x "$root_dir/bin/kill"

  cat >"$root_dir/bin/ps" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '   PID  PPID   RSS      VSZ  %%CPU ELAPSED COMMAND\n'
printf ' 4242  1000  16384   12345   0.0  01:00:00 /Applications/cmux.app/Contents/MacOS/cmux\n'
EOF
  chmod +x "$root_dir/bin/ps"

  cat >"$root_dir/bin/footprint" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'phys_footprint: 256.00 MB (peak 512.00 MB)\\n'
EOF
  chmod +x "$root_dir/bin/footprint"

  cat >"$root_dir/bin/pgrep" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-x" && "\${2:-}" == "cmux" ]]; then
  if [[ -n "\${CMUX_MEM_WATCHDOG_PGREP_CMUX:-}" ]]; then
    printf '%s' "\$CMUX_MEM_WATCHDOG_PGREP_CMUX"
    exit 0
  fi
  exit 1
fi
if [[ "\${1:-}" == "-f" ]]; then
  if [[ -n "\${CMUX_MEM_WATCHDOG_PGREP_CMUXPIDS:-}" ]]; then
    printf '%s' "\$CMUX_MEM_WATCHDOG_PGREP_CMUXPIDS"
    exit 0
  fi
  exit 1
fi
if [[ "\${1:-}" == "-lf" && "\${2:-}" == "cmux" ]]; then
  printf '%s\n' "4242 cmux"
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

  cat >"$root_dir/bin/socat" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/socat.log"
EOF
  chmod +x "$root_dir/bin/socat"

  cat >"$root_dir/bin/sleep" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/sleep.log"
EOF
  chmod +x "$root_dir/bin/sleep"

  cat >"$root_dir/bin/kill" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >>"$log_dir/kill.log"
EOF
  chmod +x "$root_dir/bin/kill"

  cat >"$root_dir/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 1
EOF
  chmod +x "$root_dir/bin/pgrep"

  cat >"$root_dir/bin/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${*: -1}" == "pid=,command=" ]]; then
  printf '4242 /Applications/cmux NIGHTLY.app/Contents/MacOS/cmux\n'
  exit 0
fi
printf '   PID  PPID   RSS      VSZ  %%CPU ELAPSED COMMAND\n'
printf ' 4242  1000  16384   12345   0.0  01:00:00 /Applications/cmux NIGHTLY.app/Contents/MacOS/cmux\n'
EOF
  chmod +x "$root_dir/bin/ps"

  cat >"$root_dir/bin/footprint" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'phys_footprint: 6.00 GB (peak 8.00 GB)\\n'
EOF
  chmod +x "$root_dir/bin/footprint"
}

run_case() {
  local name="$1"
  local expect_breach="$2"
  local expected_signals="$3"
  local footprint_fixture="$4"
  local vmstat_fixture="$5"
  local pgrep_cmux="$6"
  local pgrep_pids="$7"

  local root_dir log_dir snapshot
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  printf '%s' "$footprint_fixture" >"$root_dir/fixtures/footprint.fixture"
  printf '%s' "$vmstat_fixture" >"$root_dir/fixtures/vmstat.fixture"

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB=5
  export CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB=12
  export CMUX_MEM_WATCHDOG_LOG_DIR="$log_dir"
  export CMUX_MEM_WATCHDOG_KILL_BIN="$root_dir/bin/kill"
  export CMUX_MEM_WATCHDOG_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  export CMUX_MEM_WATCHDOG_PGREP_CMUX="$pgrep_cmux"
  export CMUX_MEM_WATCHDOG_PGREP_CMUXPIDS="$pgrep_pids"
  export PATH="$root_dir/bin:$PATH"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  run_once

  if [[ "$expect_breach" == "1" ]]; then
    assert_file_contains "$log_dir/curl.log" "http://localhost:3847/notify"
    assert_file_contains "$log_dir/kill.log" "-TERM 4242"
    assert_file_contains "$log_dir/kill.log" "-KILL 4242"
    snapshot="$(find "$log_dir" -maxdepth 1 -type f -name '20*.log' | head -n 1)"
    if [[ -n "$expected_signals" ]]; then
      assert_file_contains "$snapshot" "breached_signals=$expected_signals"
    fi
  else
    assert_file_not_contains "$log_dir/kill.log" "-TERM"
    assert_file_not_contains "$log_dir/curl.log" "http://localhost:3847/notify"
  fi

  printf 'PASS: %s\n' "$name"
  rm -rf "$root_dir"
}

run_case "no breach when both below threshold" \
  0 "" \
  $'4242 phys_footprint: 1024 MB (peak 2 GB)\n5001 phys_footprint: 512 MB (peak 1 GB)\n' \
  $'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages occupied by compressor: 1048576.\n' \
  $'4242\n5001\n' \
  $'4242\n5001\n'

run_case "breach when footprint above threshold" \
  1 "footprint" \
  $'4242 phys_footprint: 9.5 GB (peak 25 GB)\n5001 phys_footprint: 512 MB (peak 1 GB)\n' \
  $'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages occupied by compressor: 1048576.\n' \
  $'4242\n5001\n' \
  $'4242\n5001\n'

run_case "breach when compressor above threshold" \
  1 "compressor" \
  $'4242 phys_footprint: 1024 MB (peak 2 GB)\n5001 phys_footprint: 512 MB (peak 1 GB)\n' \
  $'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages occupied by compressor: 3145729.\n' \
  $'4242\n5001\n' \
  $'4242\n5001\n'

run_case "breach when both above threshold" \
  1 "footprint,compressor" \
  $'4242 phys_footprint: 3 GB (peak 4 GB)\n5001 phys_footprint: 3 GB (peak 4 GB)\n' \
  $'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages occupied by compressor: 4194305.\n' \
  $'4242\n5001\n' \
  $'4242\n5001\n'

run_case "no cmux pid exits cleanly" \
  0 "" \
  $'4242 phys_footprint: 1024 MB (peak 2 GB)\n5001 phys_footprint: 1024 MB (peak 2 GB)\n' \
  $'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages occupied by compressor: 4194305.\n' \
  "" \
  ""

run_vmstat_page_size_case() {
  local root_dir compressor_bytes
  root_dir="$(mktemp -d)"
  mkdir -p "$root_dir/fixtures"

  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages occupied by compressor: 262144.
EOF

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  compressor_bytes="$(vmstat_compressor_bytes)"
  assert_eq "4294967296" "$compressor_bytes"

  printf 'PASS: watchdog derives compressor bytes from vm_stat page size\n'
  rm -rf "$root_dir"
}
run_vmstat_page_size_case

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

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  notify_breach 4242 footprint 1073741824 4294967296 "$log_dir/snapshot.log" 2>"$stderr_log"
  assert_file_contains "$stderr_log" "notify listener unavailable"
  assert_file_not_contains "$log_dir/curl.log" "http://localhost:3847/notify"

  printf 'PASS: watchdog skips notification loudly when listener is down\n'
  rm -rf "$root_dir"
}
run_notify_skip_case

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

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_NOTIFY_URL="http://localhost:3847/notify"
  export PATH="$root_dir/bin:$PATH"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  notify_breach 4242 footprint 1073741824 4294967296 "$log_dir/snapshot.log" 2>"$stderr_log"
  assert_file_contains "$log_dir/curl.log" "http://localhost:3847/notify"
  assert_file_contains "$stderr_log" "notify listener unavailable at localhost:3847; skipping notification"
  assert_file_not_contains "$stderr_log" "notify post failed at http://localhost:3847/notify"

  printf 'PASS: watchdog re-probes and skip-logs when listener drops after notify probe\n'
  rm -rf "$root_dir"
}
run_notify_reprobe_after_post_failure_case

# Matcher coverage regression guard (2026-06-09): the PID matcher must catch
# BOTH cmux bundles — stable "cmux.app" AND nightly "cmux NIGHTLY.app". The old
# `cmux\.app` pattern silently skipped nightly, so a nightly-only fleet (the
# common case while we run on nightly) went completely unwatched.
run_matcher_coverage() {
  local script
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/cmux-memory-watchdog.sh"
  local stable="/Applications/cmux.app/Contents/MacOS/cmux"
  local nightly="/Applications/cmux NIGHTLY.app/Contents/MacOS/cmux"
  local broadened='^/Applications/cmux[^/]*\.app/Contents/MacOS/cmux([[:space:]]|$)'

  printf '%s' "$stable" | grep -qE "$broadened" \
    || { printf 'FAIL: matcher misses STABLE bundle\n'; exit 1; }
  printf '%s' "$nightly" | grep -qE "$broadened" \
    || { printf 'FAIL: matcher misses NIGHTLY bundle\n'; exit 1; }

  # The production script must use the ps fallback matcher because broad
  # pgrep -f can match its own transient pgrep command on macOS.
  grep -q 'ps_cmux_pids()' "$script" \
    || { printf 'FAIL: missing ps_cmux_pids fallback\n'; exit 1; }
  grep -qE 'Contents.*MacOS.*cmux' "$script" \
    || { printf 'FAIL: missing cmux app-path matcher in script\n'; exit 1; }

  # Regression guard: broad pgrep -f app matching must stay gone.
  if grep -qE "pgrep -f 'cmux" "$script"; then
    printf 'FAIL: broad pgrep app matcher regressed (can match itself)\n'; exit 1
  fi

  printf 'PASS: matcher covers both cmux bundles (stable + nightly)\n'
}
run_matcher_coverage

run_ps_fallback_case() {
  local root_dir log_dir snapshot
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_ps_fallback_commands "$root_dir" "$log_dir"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 6 GB (peak 8 GB)
EOF
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages occupied by compressor: 1048576.
EOF

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB=5
  export CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB=12
  export CMUX_MEM_WATCHDOG_LOG_DIR="$log_dir"
  export CMUX_MEM_WATCHDOG_KILL_BIN="$root_dir/bin/kill"
  export CMUX_MEM_WATCHDOG_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  export PATH="$root_dir/bin:$PATH"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  run_once

  assert_file_contains "$log_dir/kill.log" "-TERM 4242"
  snapshot="$(find "$log_dir" -maxdepth 1 -type f -name '20*.log' | head -n 1)"
  assert_file_contains "$snapshot" "breached_signals=footprint"

  printf 'PASS: watchdog falls back to ps command discovery when pgrep misses GUI apps\n'
  rm -rf "$root_dir"
}

run_ps_fallback_case

run_top_rss_offenders_case() {
  local root_dir log_dir snapshot
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"

  cat >"$root_dir/fixtures/footprint.fixture" <<'EOF'
4242 phys_footprint: 6 GB (peak 8 GB)
EOF
  cat >"$root_dir/fixtures/vmstat.fixture" <<'EOF'
Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages occupied by compressor: 1048576.
EOF
  cat >"$root_dir/fixtures/top-ps.fixture" <<'EOF'
  PID   RSS COMM
 9001 2097152 python3.11
 9002 1048576 ugrep
 4242  262144 /Applications/cmux.app/Contents/MacOS/cmux
EOF

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB=5
  export CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB=12
  export CMUX_MEM_WATCHDOG_LOG_DIR="$log_dir"
  export CMUX_MEM_WATCHDOG_KILL_BIN="$root_dir/bin/kill"
  export CMUX_MEM_WATCHDOG_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  export CMUX_MEM_WATCHDOG_PS_TOP_FIXTURE="$root_dir/fixtures/top-ps.fixture"
  export CMUX_MEM_WATCHDOG_PGREP_CMUX=$'4242\n'
  export CMUX_MEM_WATCHDOG_PGREP_CMUXPIDS=$'4242\n'
  export PATH="$root_dir/bin:$PATH"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  run_once

  snapshot="$(find "$log_dir" -maxdepth 1 -type f -name '20*.log' | head -n 1)"
  assert_file_contains "$snapshot" "[top_rss_offenders]"
  assert_file_contains "$snapshot" "command=python3.11"
  assert_file_contains "$snapshot" "command=ugrep"

  printf 'PASS: watchdog breach snapshot includes process-agnostic top RSS offenders\n'
  rm -rf "$root_dir"
}
run_top_rss_offenders_case
