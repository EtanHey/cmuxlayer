#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/bin/cmux-memory-watchdog.sh"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  grep -F -- "$needle" "$file" >/dev/null || fail "expected '$needle' in $file"
}

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/logs"
cat >"$TMP_DIR/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TEST_TMP/curl.log"
EOF
chmod +x "$TMP_DIR/bin/curl"

cat >"$TMP_DIR/bin/socat" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cat >>"$TEST_TMP/socat.log"
EOF
chmod +x "$TMP_DIR/bin/socat"

cat >"$TMP_DIR/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "-x" && "${2:-}" == "cmux" ]]; then
  printf '4242\n'
  exit 0
fi
if [[ "${1:-}" == "-lf" && "${2:-}" == "cmux" ]]; then
  printf '4242 cmux\n'
  exit 0
fi
exit 1
EOF
chmod +x "$TMP_DIR/bin/pgrep"

cat >"$TMP_DIR/bin/ps" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '  PID  PPID   RSS      VSZ  %%CPU ELAPSED COMMAND\n'
printf ' 4242  1000 163840 40960000   0.0 12:34:56 cmux\n'
EOF
chmod +x "$TMP_DIR/bin/ps"

cat >"$TMP_DIR/bin/kill" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TEST_TMP/kill.log"
if [[ "${1:-}" == "-0" ]]; then
  exit 0
fi
EOF
chmod +x "$TMP_DIR/bin/kill"

cat >"$TMP_DIR/bin/sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TEST_TMP/sleep.log"
EOF
chmod +x "$TMP_DIR/bin/sleep"

cat >"$TMP_DIR/fixture.vmmap" <<'EOF'
Process:         cmux [4242]
Physical footprint:         12.0G
Physical footprint (peak):  12.1G
----
                                VIRTUAL RESIDENT    DIRTY  SWAPPED VOLATILE   NONVOL    EMPTY   REGION
===========                     ======= ========    =====  ======= ========   ======    =====  =======
IOSurface                        20.0G    11.5G      64K    512.0M       0K       0K       0K      120
IOAccelerator (graphics)          4.0G     1.1G      32K    128.0M       0K       0K       0K       32
===========                     ======= ========    =====  ======= ========   ======    =====  =======
TOTAL                            48.0G    12.6G      96K    640.0M       0K       0K       0K      512
EOF

export TEST_TMP="$TMP_DIR"
export PATH="$TMP_DIR/bin:$PATH"
export CMUX_MEM_WATCHDOG_SOURCE_ONLY=1
export CMUX_MEM_WATCHDOG_THRESHOLD_GB=10
export CMUX_MEM_WATCHDOG_LOG_DIR="$TMP_DIR/logs"
export CMUX_MEM_WATCHDOG_VMMAP_FIXTURE="$TMP_DIR/fixture.vmmap"
export CMUX_MEM_WATCHDOG_KILL_BIN="$TMP_DIR/bin/kill"

# shellcheck source=../bin/cmux-memory-watchdog.sh
source "$SCRIPT_PATH"

run_once

log_file="$(find "$TMP_DIR/logs" -type f | head -1)"
[[ -n "${log_file:-}" ]] || fail "expected a snapshot log file"
assert_file_contains "$log_file" "threshold_gb=10"
assert_file_contains "$TMP_DIR/socat.log" "cmux watchdog threshold breach"
assert_file_contains "$TMP_DIR/curl.log" "http://localhost:3847/notify"
assert_file_contains "$TMP_DIR/kill.log" "-TERM 4242"
assert_file_contains "$TMP_DIR/sleep.log" "10"
assert_file_contains "$TMP_DIR/kill.log" "-KILL 4242"

echo "PASS: threshold breach triggers snapshot, notify, and shutdown"
