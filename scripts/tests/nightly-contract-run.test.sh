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

make_fake_bun() {
  local path="$1"
  cat >"$path" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$CMUX_SOCKET_PATH" >"$NIGHTLY_TEST_CAPTURE/socket"
printf '%s\n' "$*" >"$NIGHTLY_TEST_CAPTURE/args"
case "$NIGHTLY_TEST_MODE" in
  skip)
    printf '%s\n' '[contract] SKIP: NIGHTLY socket is not reachable' >&2
    ;;
  skip_controls)
    printf '[contract] SKIP: control ESC=\033 BS=\b FF=\f\n' >&2
    ;;
  fail)
    printf '%s\n' '[contract] FAIL: injected contract failure' >&2
    exit 9
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
  local expected_summary
  expected_summary="$(printf '%s' "$expected_result" | tr '[:lower:]' '[:upper:]')"
  local root repo state capture fake_bun receipt output actual_exit
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
  [[ -n "$(json_field "$receipt" reason)" ]] || fail "receipt reason is empty"
  [[ "$output" == "$expected_summary"* ]] || fail "summary does not start with $expected_summary: $output"
  [[ -f "$state/nightly-contract-gemini.log" ]] || fail "missing report log"
  grep -F -- "$receipt" "$state/nightly-contract-gemini.log" >/dev/null || fail "report log omits receipt path"

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
run_case skip skip 0
run_case skip_controls skip 0
run_case fail fail 9
run_invalid_environment_cases
printf 'PASS: nightly contract runner receipts and exits\n'
