#!/usr/bin/env bash
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${NIGHTLY_CONTRACT_REPO:-$(cd "$script_dir/.." && pwd)}"
if [[ -n "${NIGHTLY_CONTRACT_STATE_DIR:-}" ]]; then
  state_dir="$NIGHTLY_CONTRACT_STATE_DIR"
elif [[ -n "${HOME:-}" ]]; then
  state_dir="$HOME/.local/state/cmux"
else
  state_dir="/var/tmp/cmux-nightly-contract-$(id -u)"
fi
bun_bin="${NIGHTLY_CONTRACT_BUN_BIN:-bun}"
run_date="${NIGHTLY_CONTRACT_DATE:-$(date -u '+%Y-%m-%d')}"
if [[ ! "$run_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  printf 'invalid NIGHTLY_CONTRACT_DATE: %s\n' "$run_date" >&2
  exit 64
fi
timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
socket_path="/tmp/cmux-nightly.sock"
receipt="$state_dir/contract-nightly-$run_date.json"
report_log="$state_dir/nightly-contract-gemini.log"

json_escape() {
  local value="$1"
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1, -1))' "$value"
}

mkdir -p "$state_dir"
output_tmp="$(mktemp "$state_dir/.nightly-contract-output.XXXXXX")"
receipt_tmp="$receipt.tmp.$$"
cleanup() {
  rm -f "${output_tmp:-}" "$receipt_tmp"
}
trap cleanup EXIT

set +e
(
  cd "$repo" || exit 70
  unset CMUX_CONTRACT_ALLOW_PROD CMUXLAYER_DAEMON_SOCKET
  export CMUX_SOCKET_PATH="$socket_path"
  "$bun_bin" run test:contract
) >"$output_tmp" 2>&1
command_exit=$?
set -e

terminal_count="$(awk '/^\[contract\] PASS real-cmux contract lane$/ || /^\[contract\] SKIP: / { count += 1 } END { print count + 0 }' "$output_tmp")"
last_nonempty_line="$(awk 'NF { line = $0 } END { print line }' "$output_tmp")"
result="fail"
reason=""
exit_code="$command_exit"

if [[ "$command_exit" -eq 0 && "$terminal_count" -eq 1 && "$last_nonempty_line" == "[contract] PASS real-cmux contract lane" ]]; then
  result="pass"
  reason="real-cmux contract lane passed"
elif [[ "$command_exit" -eq 0 && "$terminal_count" -eq 1 && "$last_nonempty_line" == "[contract] SKIP: "* ]]; then
  result="skip"
  reason="${last_nonempty_line#\[contract\] SKIP: }"
elif [[ "$command_exit" -eq 0 ]]; then
  exit_code=1
  reason="contract command exited zero without exactly one final PASS or SKIP marker"
else
  reason="${last_nonempty_line#\[contract\] FAIL: }"
  [[ -n "$reason" ]] || reason="contract command exited $command_exit"
fi

version="$(node -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (typeof pkg.version === "string") process.stdout.write(pkg.version);' "$repo/package.json" 2>/dev/null)"
[[ -n "$version" ]] || version="unknown"

cat >"$receipt_tmp" <<JSON
{
  "version": "$(json_escape "$version")",
  "result": "$result",
  "reason": "$(json_escape "$reason")",
  "timestamp": "$timestamp",
  "socket_path": "$socket_path",
  "command": "bun run test:contract"
}
JSON
mv "$receipt_tmp" "$receipt"

result_label="$(printf '%s' "$result" | tr '[:lower:]' '[:upper:]')"
summary="$result_label cmux nightly contract: $reason; receipt=$receipt"
printf '%s\n' "$summary" | tee -a "$report_log"

if [[ "$result" == "fail" ]]; then
  exit "$exit_code"
fi
