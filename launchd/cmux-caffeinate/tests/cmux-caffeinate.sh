#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="$ROOT_DIR/bin/cmux-caffeinate.sh"
PLIST_PATH="$ROOT_DIR/launchd/com.golems.cmux-caffeinate.plist"
DEPLOY_SCRIPT_PATH="/Users/etanheyman/Gits/cmuxlayer/launchd/cmux-caffeinate/bin/cmux-caffeinate.sh"

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

run_default_flags_case() {
  local root_dir log_dir
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$log_dir"

  cat >"$root_dir/bin/caffeinate" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >"$log_dir/argv.log"
EOF
  chmod +x "$root_dir/bin/caffeinate"

  PATH="$root_dir/bin:$PATH" CMUX_CAFFEINATE_LOG="$log_dir/cmux-caffeinate.log" "$SCRIPT_PATH"

  assert_eq "-dis" "$(cat "$log_dir/argv.log")"
  assert_file_contains "$log_dir/cmux-caffeinate.log" "starting pid="

  printf 'PASS: caffeinate guard uses -dis by default\n'
  rm -rf "$root_dir"
}

run_override_flags_case() {
  local root_dir log_dir
  root_dir="$(mktemp -d)"
  log_dir="$root_dir/logs"
  mkdir -p "$root_dir/bin" "$log_dir"

  cat >"$root_dir/bin/caffeinate" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >"$log_dir/argv.log"
EOF
  chmod +x "$root_dir/bin/caffeinate"

  PATH="$root_dir/bin:$PATH" \
    CMUX_CAFFEINATE_LOG="$log_dir/cmux-caffeinate.log" \
    CMUX_CAFFEINATE_FLAGS="-i" \
    "$SCRIPT_PATH"

  assert_eq "-i" "$(cat "$log_dir/argv.log")"

  printf 'PASS: caffeinate guard honors CMUX_CAFFEINATE_FLAGS\n'
  rm -rf "$root_dir"
}

run_plist_case() {
  [[ -x "$SCRIPT_PATH" ]] || fail "script is missing or not executable: $SCRIPT_PATH"

  assert_file_contains "$PLIST_PATH" "<string>com.golems.cmux-caffeinate</string>"
  assert_file_contains "$PLIST_PATH" "<key>RunAtLoad</key>"
  assert_file_contains "$PLIST_PATH" "<true/>"
  assert_file_contains "$PLIST_PATH" "<key>KeepAlive</key>"
  assert_file_contains "$PLIST_PATH" "$DEPLOY_SCRIPT_PATH"
  assert_file_contains "$PLIST_PATH" "<key>StandardOutPath</key>"
  assert_file_contains "$PLIST_PATH" "<key>StandardErrorPath</key>"

  printf 'PASS: launchd plist has durable guard settings\n'
}

run_syntax_case() {
  [[ -x "$SCRIPT_PATH" ]] || fail "script is missing or not executable: $SCRIPT_PATH"
  bash -n "$SCRIPT_PATH"
  printf 'PASS: caffeinate guard script is executable and syntax-valid\n'
}

run_default_flags_case
run_override_flags_case
run_plist_case
run_syntax_case
