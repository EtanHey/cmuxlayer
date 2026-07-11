#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/bin/cmux-contract-nightly.sh"
PLIST_PATH="$ROOT_DIR/launchd/com.golems.cmux-contract-nightly.plist"
DEPLOY_SCRIPT_PATH="/Users/etanheyman/Gits/cmuxlayer/launchd/cmux-contract-nightly/bin/cmux-contract-nightly.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  [[ "$expected" == "$actual" ]] || fail "expected '$expected', got '$actual'"
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  [[ -f "$file" ]] || fail "missing file: $file"
  grep -F -- "$needle" "$file" >/dev/null || fail "expected '$needle' in $file"
}

json_field() {
  local file="$1"
  local field="$2"
  python3 - "$file" "$field" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
print(value[sys.argv[2]])
PY
}

make_fake_bun() {
  local path="$1"
  cat >"$path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$CMUX_SOCKET_PATH" >"$FAKE_CAPTURE_DIR/socket"
printf '%s\n' "$PWD" >"$FAKE_CAPTURE_DIR/cwd"
printf '%s\n' "$*" >"$FAKE_CAPTURE_DIR/args"
case "$FAKE_CONTRACT_MODE" in
  pass)
    printf '%s\n' '[contract] PASS real-cmux contract lane'
    ;;
  skip)
    printf '%s\n' '[contract] SKIP: write EPIPE from plain launchd ancestry' >&2
    ;;
  fail)
    printf '%s\n' '[contract] FAIL: live read contract broke' >&2
    exit 7
    ;;
  pass_then_noise)
    printf '%s\n' '[contract] PASS real-cmux contract lane'
    printf '%s\n' 'cleanup warning after pass' >&2
    ;;
  double_terminal)
    printf '%s\n' '[contract] SKIP: first terminal marker'
    printf '%s\n' '[contract] PASS real-cmux contract lane'
    ;;
  *)
    printf 'unknown fake mode: %s\n' "$FAKE_CONTRACT_MODE" >&2
    exit 64
    ;;
esac
EOF
  chmod +x "$path"
}

run_outcome_case() {
  local mode="$1"
  local expected_outcome="$2"
  local expected_exit="$3"
  local root repo state fake_bun receipt raw_log actual_exit
  root="$(mktemp -d)"
  repo="$root/repo"
  state="$root/state"
  fake_bun="$root/bun"
  mkdir -p "$repo" "$state" "$root/capture"
  make_fake_bun "$fake_bun"

  set +e
  FAKE_CONTRACT_MODE="$mode" \
    FAKE_CAPTURE_DIR="$root/capture" \
    BUN_BIN="$fake_bun" \
    CMUX_CONTRACT_NIGHTLY_REPO="$repo" \
    CMUX_CONTRACT_NIGHTLY_STATE_DIR="$state" \
    CMUX_CONTRACT_NIGHTLY_DATE="2026-07-11" \
    CMUX_CONTRACT_NIGHTLY_TIMESTAMP="2026-07-11T03:30:00+0300" \
    "$SCRIPT_PATH"
  actual_exit=$?
  set -e

  assert_eq "$expected_exit" "$actual_exit"
  assert_eq "/tmp/cmux-nightly.sock" "$(cat "$root/capture/socket")"
  assert_eq "$repo" "$(cat "$root/capture/cwd")"
  assert_eq "run test:contract" "$(cat "$root/capture/args")"

  receipt="$state/contract-nightly-2026-07-11.json"
  raw_log="$state/contract-nightly-2026-07-11.log"
  [[ -f "$receipt" ]] || fail "missing receipt: $receipt"
  [[ -f "$raw_log" ]] || fail "missing raw log: $raw_log"
  assert_eq "$expected_outcome" "$(json_field "$receipt" outcome)"
  assert_eq "$expected_exit" "$(json_field "$receipt" exit_code)"
  assert_eq "/tmp/cmux-nightly.sock" "$(json_field "$receipt" socket_path)"
  assert_eq "$raw_log" "$(json_field "$receipt" log_path)"
  assert_eq "bun run test:contract" "$(json_field "$receipt" command)"
  [[ ! -e "$receipt.tmp" ]] || fail "temporary receipt survived atomic publish"

  case "$mode" in
    pass) assert_file_contains "$raw_log" "PASS real-cmux contract lane" ;;
    skip) assert_file_contains "$raw_log" "SKIP: write EPIPE" ;;
    fail) assert_file_contains "$raw_log" "FAIL: live read contract broke" ;;
  esac

  printf 'PASS: nightly contract records %s\n' "$expected_outcome"
  rm -rf "$root"
}

run_plist_case() {
  assert_file_contains "$PLIST_PATH" "<string>com.golems.cmux-contract-nightly</string>"
  assert_file_contains "$PLIST_PATH" "$DEPLOY_SCRIPT_PATH"
  assert_file_contains "$PLIST_PATH" "<key>StartCalendarInterval</key>"
  assert_file_contains "$PLIST_PATH" "<key>Hour</key>"
  assert_file_contains "$PLIST_PATH" "<integer>3</integer>"
  assert_file_contains "$PLIST_PATH" "<key>Minute</key>"
  assert_file_contains "$PLIST_PATH" "<integer>30</integer>"
  assert_file_contains "$PLIST_PATH" "<key>StandardOutPath</key>"
  assert_file_contains "$PLIST_PATH" "<key>StandardErrorPath</key>"
  if grep -F -- "<key>RunAtLoad</key>" "$PLIST_PATH" >/dev/null; then
    fail "nightly job must not run at install time"
  fi
  if grep -F -- "<key>KeepAlive</key>" "$PLIST_PATH" >/dev/null; then
    fail "nightly job must not be kept alive"
  fi
  plutil -lint "$PLIST_PATH" >/dev/null
  printf 'PASS: launchd plist schedules one nightly run\n'
}

run_syntax_case() {
  [[ -x "$SCRIPT_PATH" ]] || fail "script is missing or not executable: $SCRIPT_PATH"
  bash -n "$SCRIPT_PATH"
  printf 'PASS: nightly contract script is executable and syntax-valid\n'
}

run_outcome_case pass pass 0
run_outcome_case skip skip 0
run_outcome_case fail fail 7
run_outcome_case pass_then_noise fail 1
run_outcome_case double_terminal fail 1
run_plist_case
run_syntax_case
