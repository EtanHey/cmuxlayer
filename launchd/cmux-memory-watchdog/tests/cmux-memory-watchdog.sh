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

assert_file_missing_or_empty() {
  local file="$1"
  if [[ -f "$file" && -s "$file" ]]; then
    fail "expected $file to be missing or empty"
  fi
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  [[ "$expected" == "$actual" ]] || fail "expected '$expected', got '$actual'"
}

stop_brainbar_socket() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
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

  local root_dir log_dir snapshot brainbar_sock brainbar_pid run_status
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_fake_commands "$root_dir" "$log_dir"
  brainbar_sock="$root_dir/brainbar.sock"
  /usr/bin/nc -Ul "$brainbar_sock" >/dev/null &
  brainbar_pid="$!"
  for _ in 1 2 3 4 5; do
    [[ -S "$brainbar_sock" ]] && break
    /bin/sleep 0.1
  done

  printf '%s' "$footprint_fixture" >"$root_dir/fixtures/footprint.fixture"
  printf '%s' "$vmstat_fixture" >"$root_dir/fixtures/vmstat.fixture"

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB=5
  export CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB=12
  export CMUX_MEM_WATCHDOG_LOG_DIR="$log_dir"
  export CMUX_MEM_WATCHDOG_BRAINBAR_SOCK="$brainbar_sock"
  export CMUX_MEM_WATCHDOG_KILL_BIN="$root_dir/bin/kill"
  export CMUX_MEM_WATCHDOG_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  export CMUX_MEM_WATCHDOG_PGREP_CMUX="$pgrep_cmux"
  export CMUX_MEM_WATCHDOG_PGREP_CMUXPIDS="$pgrep_pids"
  export PATH="$root_dir/bin:$PATH"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  set +e
  run_once 2>"$log_dir/stderr.log"
  run_status="$?"
  set -e
  if [[ "$run_status" -ne 0 ]]; then
    cat "$log_dir/stderr.log" >&2
    stop_brainbar_socket "$brainbar_pid"
    rm -rf "$root_dir"
    exit "$run_status"
  fi

  if [[ "$expect_breach" == "1" ]]; then
    assert_file_contains "$log_dir/curl.log" "http://localhost:3847/notify"
    assert_file_contains "$log_dir/socat.log" "UNIX-CONNECT:$brainbar_sock"
    assert_file_contains "$log_dir/stderr.log" "breached memory thresholds"
    assert_file_missing_or_empty "$log_dir/kill.log"
    snapshot="$(find "$log_dir" -type f -name '20*.log' -print -quit)"
    if [[ -n "$expected_signals" ]]; then
      assert_file_contains "$snapshot" "breached_signals=$expected_signals"
    fi
  else
    assert_file_not_contains "$log_dir/kill.log" "-TERM"
    assert_file_not_contains "$log_dir/curl.log" "http://localhost:3847/notify"
  fi

  printf 'PASS: %s\n' "$name"
  stop_brainbar_socket "$brainbar_pid"
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

# Environment changes are intentionally isolated from the remaining cases.
# shellcheck disable=SC2030,SC2031
run_early_close_notifiers_case() (
  local repo_root scratch_root root_dir log_dir stderr_log
  local brainbar_sock brainbar_ready brainbar_pid brainbar_status
  local notify_port_file notify_pid notify_port notify_status large_value
  repo_root="$(cd "$ROOT_DIR/../.." && pwd)"
  scratch_root="$repo_root/docs.local/scratch/hotfix-launchd"
  mkdir -p "$scratch_root"
  root_dir="$(mktemp -d "$scratch_root/early-close.XXXXXX")"
  log_dir="$root_dir/logs"
  stderr_log="$log_dir/stderr.log"
  mkdir -p "$root_dir/bin" "$log_dir"

  cd "$repo_root"
  brainbar_sock="${root_dir#"$repo_root/"}/brainbar.sock"
  brainbar_ready="$root_dir/brainbar.ready"
  python3 - "$brainbar_sock" "$brainbar_ready" <<'PY' &
import os
import socket
import sys

socket_path, ready_path = sys.argv[1:]
try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(socket_path)
server.listen(1)
open(ready_path, "w").close()
connection, _ = server.accept()
connection.close()
server.close()
PY
  brainbar_pid="$!"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -f "$brainbar_ready" && -S "$brainbar_sock" ]] && break
    /bin/sleep 0.1
  done
  [[ -f "$brainbar_ready" && -S "$brainbar_sock" ]] \
    || fail "early-close BrainBar listener did not become ready"

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_BRAINBAR_SOCK="$brainbar_sock"
  # Exceed the pipe buffer so jq is still producing when the peer closes.
  large_value="$(awk 'BEGIN { for (i = 0; i < 98304; i++) printf "x" }')"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  if brain_store_breach 4242 1073741824 4294967296 \
    "$root_dir/snapshot.log" "$large_value" footprint 2>>"$stderr_log"; then
    brainbar_status=0
  else
    brainbar_status="$?"
  fi
  wait "$brainbar_pid"

  notify_port_file="$root_dir/notify.port"
  python3 - "$notify_port_file" <<'PY' &
import socket
import sys

port_path = sys.argv[1]
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(1)
with open(port_path, "w") as port_file:
    port_file.write(str(server.getsockname()[1]))
connection, _ = server.accept()
connection.close()
server.close()
PY
  notify_pid="$!"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "$notify_port_file" ]] && break
    /bin/sleep 0.1
  done
  [[ -s "$notify_port_file" ]] || fail "early-close HTTP listener did not become ready"
  notify_port="$(<"$notify_port_file")"

  cat >"$root_dir/bin/nc" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF
  chmod +x "$root_dir/bin/nc"
  export CMUX_MEM_WATCHDOG_NOTIFY_URL="http://127.0.0.1:$notify_port/notify"
  export PATH="$root_dir/bin:$PATH"
  if notify_breach 4242 footprint 1073741824 4294967296 "$large_value" \
    2>>"$stderr_log"; then
    notify_status=0
  else
    notify_status="$?"
  fi
  wait "$notify_pid"

  assert_eq "0" "$brainbar_status"
  assert_eq "0" "$notify_status"
  assert_file_contains "$stderr_log" "brainbar notification failed"
  assert_file_contains "$stderr_log" "notify post failed"
  assert_file_not_contains "$stderr_log" "jq: error"

  printf 'PASS: notifier transports are warning-only when peers close before reading\n'
  rm -rf "$root_dir"
)
run_early_close_notifiers_case

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

# The preceding notifier case is a subshell, so its exports cannot affect this case.
# shellcheck disable=SC2031
run_ps_fallback_case() {
  local root_dir log_dir snapshot brainbar_sock brainbar_pid
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$root_dir/fixtures" "$log_dir"
  seed_ps_fallback_commands "$root_dir" "$log_dir"
  brainbar_sock="$root_dir/brainbar.sock"
  /usr/bin/nc -Ul "$brainbar_sock" >/dev/null &
  brainbar_pid="$!"
  for _ in 1 2 3 4 5; do
    [[ -S "$brainbar_sock" ]] && break
    /bin/sleep 0.1
  done

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
  export CMUX_MEM_WATCHDOG_BRAINBAR_SOCK="$brainbar_sock"
  export CMUX_MEM_WATCHDOG_KILL_BIN="$root_dir/bin/kill"
  export CMUX_MEM_WATCHDOG_FOOTPRINT_FIXTURE="$root_dir/fixtures/footprint.fixture"
  export CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE="$root_dir/fixtures/vmstat.fixture"
  export PATH="$root_dir/bin:$PATH"

  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  run_once

  assert_file_missing_or_empty "$log_dir/kill.log"
  assert_file_contains "$log_dir/socat.log" "UNIX-CONNECT:$brainbar_sock"
  snapshot="$(find "$log_dir" -type f -name '20*.log' -print -quit)"
  assert_file_contains "$snapshot" "breached_signals=footprint"

  printf 'PASS: watchdog falls back to ps command discovery when pgrep misses GUI apps\n'
  stop_brainbar_socket "$brainbar_pid"
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

  assert_file_missing_or_empty "$log_dir/kill.log"
  snapshot="$(find "$log_dir" -type f -name '20*.log' -print -quit)"
  assert_file_contains "$snapshot" "[top_rss_offenders]"
  assert_file_contains "$snapshot" "command=python3.11"
  assert_file_contains "$snapshot" "command=ugrep"

  printf 'PASS: watchdog breach snapshot includes process-agnostic top RSS offenders\n'
  rm -rf "$root_dir"
}
run_top_rss_offenders_case

run_top_rss_limit_validation_case() (
  local root_dir output status stderr_log
  root_dir="$(mktemp -d)"
  stderr_log="$root_dir/stderr.log"
  cat >"$root_dir/top-ps.fixture" <<'EOF'
  PID   RSS COMM
 9001 2097152 python3.11
EOF

  export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
  export CMUX_MEM_WATCHDOG_PS_TOP_FIXTURE="$root_dir/top-ps.fixture"
  export CMUX_MEM_WATCHDOG_TOP_RSS_LIMIT=0
  # shellcheck disable=SC1090
  source "$SCRIPT_PATH"
  if output="$(top_rss_offenders 2>"$stderr_log")"; then
    status=0
  else
    status="$?"
  fi
  assert_eq "0" "$status"
  assert_eq "" "$output"

  CMUX_MEM_WATCHDOG_TOP_RSS_LIMIT=invalid
  if top_rss_offenders 2>"$stderr_log"; then
    fail "invalid watchdog top-RSS limit unexpectedly succeeded"
  fi
  assert_file_contains "$stderr_log" "invalid top RSS limit"

  printf 'PASS: watchdog top RSS limit accepts zero and rejects invalid values\n'
  rm -rf "$root_dir"
)
run_top_rss_limit_validation_case

run_installer_plist_lint_case() {
  local root_dir rendered
  root_dir="$(mktemp -d)"
  rendered="$root_dir/rendered.plist"
  HOME="$root_dir/home & operator" bash "$ROOT_DIR/install.sh" --dry-run >"$rendered"
  /usr/bin/plutil -lint "$rendered" >/dev/null
  assert_file_contains "$rendered" "<key>PATH</key>"
  assert_file_contains "$rendered" "home &amp; operator"
  printf 'PASS: installer emits XML-safe plist with an explicit launchd PATH\n'
  rm -rf "$root_dir"
}
run_installer_plist_lint_case
