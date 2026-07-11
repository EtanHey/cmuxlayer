#!/usr/bin/env bash
set -euo pipefail

repo="${CMUX_CONTRACT_NIGHTLY_REPO:-/Users/etanheyman/Gits/cmuxlayer}"
state_dir="${CMUX_CONTRACT_NIGHTLY_STATE_DIR:-$HOME/.local/state/cmux}"
bun_bin="${BUN_BIN:-/opt/homebrew/bin/bun}"
jq_bin="${JQ_BIN:-/usr/bin/jq}"
run_date="${CMUX_CONTRACT_NIGHTLY_DATE:-$(date '+%Y-%m-%d')}"
timestamp="${CMUX_CONTRACT_NIGHTLY_TIMESTAMP:-$(date '+%Y-%m-%dT%H:%M:%S%z')}"
socket_path="/tmp/cmux-nightly.sock"
receipt="$state_dir/contract-nightly-$run_date.json"
raw_log="$state_dir/contract-nightly-$run_date.log"
receipt_tmp="$receipt.tmp.$$"

mkdir -p "$state_dir"
output_tmp="$(mktemp "$state_dir/.contract-nightly-output.XXXXXX")"
cleanup() {
  [[ -z "${output_tmp:-}" ]] || rm -f "$output_tmp"
  rm -f "$receipt_tmp"
}
trap cleanup EXIT

set +e
(
  cd "$repo"
  CMUX_SOCKET_PATH="$socket_path" "$bun_bin" run test:contract
) >"$output_tmp" 2>&1
command_exit=$?
set -e

outcome="fail"
exit_code="$command_exit"
terminal_count="$(awk '/^\[contract\] PASS real-cmux contract lane$/ || /^\[contract\] SKIP: / { count += 1 } END { print count + 0 }' "$output_tmp")"
last_nonempty_line="$(awk 'NF { line = $0 } END { print line }' "$output_tmp")"
if [[ "$command_exit" -eq 0 && "$terminal_count" -eq 1 && "$last_nonempty_line" == "[contract] PASS real-cmux contract lane" ]]; then
  outcome="pass"
elif [[ "$command_exit" -eq 0 && "$terminal_count" -eq 1 && "$last_nonempty_line" == "[contract] SKIP: "* ]]; then
  outcome="skip"
elif [[ "$command_exit" -eq 0 ]]; then
  exit_code=1
  printf '%s\n' "[contract-nightly] FAIL: command exited zero without exactly one final PASS or SKIP marker" >>"$output_tmp"
fi

mv "$output_tmp" "$raw_log"
output_tmp=""

"$jq_bin" -n \
  --arg date "$run_date" \
  --arg timestamp "$timestamp" \
  --arg outcome "$outcome" \
  --argjson exit_code "$exit_code" \
  --arg socket_path "$socket_path" \
  --arg command "bun run test:contract" \
  --arg repository "$repo" \
  --arg log_path "$raw_log" \
  --arg ancestry_context "plain-launchd-best-effort" \
  '{
    date: $date,
    timestamp: $timestamp,
    outcome: $outcome,
    exit_code: $exit_code,
    socket_path: $socket_path,
    command: $command,
    repository: $repository,
    log_path: $log_path,
    ancestry_context: $ancestry_context
  }' >"$receipt_tmp"
mv "$receipt_tmp" "$receipt"

if [[ "$outcome" == "fail" ]]; then
  exit "$exit_code"
fi
