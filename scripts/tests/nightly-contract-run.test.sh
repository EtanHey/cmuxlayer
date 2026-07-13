#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/scripts/nightly-contract-run.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  [[ "$actual" == "$expected" ]] || fail "expected '$expected', got '$actual'"
}

json_field() {
  node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (value != null) process.stdout.write(String(value));' "$1" "$2"
}

json_has_field() {
  node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(Object.hasOwn(value, process.argv[2]) ? "yes" : "no");' "$1" "$2"
}

make_fake_bun() {
  local path="$1"
  cat >"$path" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$CMUX_SOCKET_PATH" >"$NIGHTLY_TEST_CAPTURE/socket"
printf '%s\n' "$*" >"$NIGHTLY_TEST_CAPTURE/args"
case "$NIGHTLY_TEST_MODE" in
  pass)
    printf '%s\n' '[contract] PASS real-cmux contract lane'
    ;;
  skip)
    printf '%s\n' '[contract] SKIP: NIGHTLY socket is not reachable' >&2
    ;;
  skip_controls)
    printf '[contract] SKIP: control ESC=\033 BS=\b FF=\f\n' >&2
    ;;
  fail)
    printf '%s\n' '[contract] FAIL: detached-orphan ancestry denial: injected contract failure' >&2
    printf '%s\n' '    at runContract (scripts/run-real-cmux-contract.ts:900:13)' >&2
    exit 9
    ;;
  zero_fail)
    printf '%s\n' 'contract output without a terminal marker' >&2
    ;;
  *)
    exit 64
    ;;
esac
FAKE
  chmod +x "$path"
}

run_case() {
  local mode="$1"
  local expected_result="$2"
  local expected_exit="$3"
  local expected_reason="$4"
  local expected_summary
  expected_summary="$(printf '%s' "$expected_result" | tr '[:lower:]' '[:upper:]')"
  local root repo state capture fake_bun receipt output actual_exit timestamp escaped_reason expected_receipt expected_output
  root="$(mktemp -d)"
  repo="$root/repo"
  state="$root/state"
  capture="$root/capture"
  fake_bun="$root/bun"
  mkdir -p "$repo" "$state" "$capture"
  printf '{"version":"9.5.0-test"}\n' >"$repo/package.json"
  make_fake_bun "$fake_bun"

  set +e
  output="$({
    NIGHTLY_CONTRACT_REPO="$repo" \
      NIGHTLY_CONTRACT_STATE_DIR="$state" \
      NIGHTLY_CONTRACT_DATE="2026-07-11" \
      NIGHTLY_CONTRACT_BUN_BIN="$fake_bun" \
      NIGHTLY_TEST_CAPTURE="$capture" \
      NIGHTLY_TEST_MODE="$mode" \
      "$SCRIPT_PATH"
  } 2>&1)"
  actual_exit=$?
  set -e

  assert_eq "$expected_exit" "$actual_exit"
  assert_eq "/tmp/cmux-nightly.sock" "$(cat "$capture/socket")"
  assert_eq "run test:contract" "$(cat "$capture/args")"

  receipt="$state/contract-nightly-2026-07-11.json"
  [[ -f "$receipt" ]] || fail "missing receipt: $receipt"
  assert_eq "9.5.0-test" "$(json_field "$receipt" version)"
  assert_eq "$expected_result" "$(json_field "$receipt" result)"
  assert_eq "$expected_reason" "$(json_field "$receipt" reason)"
  if [[ "$expected_result" == "fail" ]]; then
    assert_eq "yes" "$(json_has_field "$receipt" output_log)"
    output_log="$(json_field "$receipt" output_log)"
    [[ -f "$output_log" ]] || fail "missing output log: $output_log"
    if [[ "$mode" == "fail" ]]; then
      grep -F '[contract] FAIL: detached-orphan ancestry denial: injected contract failure' "$output_log" >/dev/null || fail "output log omits failure marker"
      grep -F 'at runContract' "$output_log" >/dev/null || fail "output log omits stack"
    else
      grep -F 'contract output without a terminal marker' "$output_log" >/dev/null || fail "output log omits zero-exit failure output"
    fi
  else
    assert_eq "no" "$(json_has_field "$receipt" output_log)"
    timestamp="$(json_field "$receipt" timestamp)"
    escaped_reason="$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1, -1))' "$expected_reason")"
    printf -v expected_receipt '{\n  "version": "9.5.0-test",\n  "result": "%s",\n  "reason": "%s",\n  "timestamp": "%s",\n  "socket_path": "/tmp/cmux-nightly.sock",\n  "command": "bun run test:contract"\n}' \
      "$expected_result" "$escaped_reason" "$timestamp"
    assert_eq "$expected_receipt" "$(cat "$receipt")"
  fi
  expected_output="$expected_summary cmux nightly contract: $expected_reason; receipt=$receipt"
  assert_eq "$expected_output" "$output"
  [[ -f "$state/nightly-contract-gemini.log" ]] || fail "missing report log"
  assert_eq "$expected_output" "$(cat "$state/nightly-contract-gemini.log")"

  rm -rf "$root"
}

run_invalid_environment_cases() {
  local root state output actual_exit missing_json
  root="$(mktemp -d)"
  state="$root/state"
  mkdir -p "$state"

  missing_json="$root/missing.json"
  printf '{}\n' >"$missing_json"
  assert_eq "" "$(json_field "$missing_json" reason)"

  set +e
  output="$(NIGHTLY_CONTRACT_STATE_DIR="$state" NIGHTLY_CONTRACT_DATE='../escape' "$SCRIPT_PATH" 2>&1)"
  actual_exit=$?
  set -e
  assert_eq "64" "$actual_exit"
  [[ "$output" == *"invalid NIGHTLY_CONTRACT_DATE"* ]] || fail "invalid date was not rejected clearly: $output"
  [[ ! -e "$root/escape.json" ]] || fail "invalid date escaped the state directory"

  set +e
  output="$(env -u HOME NIGHTLY_CONTRACT_DATE='invalid' "$SCRIPT_PATH" 2>&1)"
  actual_exit=$?
  set -e
  assert_eq "64" "$actual_exit"
  [[ "$output" == *"invalid NIGHTLY_CONTRACT_DATE"* ]] || fail "unset HOME failed before date validation: $output"

  rm -rf "$root"
}

[[ -x "$SCRIPT_PATH" ]] || fail "runner is missing or not executable: $SCRIPT_PATH"
bash -n "$SCRIPT_PATH"
run_case pass pass 0 "real-cmux contract lane passed"
run_case skip skip 0 "NIGHTLY socket is not reachable"
run_case skip_controls skip 0 $'control ESC=\033 BS=\b FF=\f'
run_case fail fail 9 "detached-orphan ancestry denial: injected contract failure"
run_case zero_fail fail 1 "contract command exited zero without exactly one final PASS or SKIP marker"
run_invalid_environment_cases
printf 'PASS: nightly contract runner receipts and exits\n'
