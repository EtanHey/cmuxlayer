#!/usr/bin/env bash
set -euo pipefail

CMUX_MEM_WATCHDOG_THRESHOLD_GB="${CMUX_MEM_WATCHDOG_THRESHOLD_GB:-10}"
CMUX_MEM_WATCHDOG_LOG_DIR="${CMUX_MEM_WATCHDOG_LOG_DIR:-$HOME/Library/Logs/cmux-watchdog}"
CMUX_MEM_WATCHDOG_NOTIFY_URL="${CMUX_MEM_WATCHDOG_NOTIFY_URL:-http://localhost:3847/notify}"
CMUX_MEM_WATCHDOG_BRAINBAR_SOCK="${CMUX_MEM_WATCHDOG_BRAINBAR_SOCK:-/tmp/brainbar.sock}"
CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS="${CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS:-10}"
CMUX_MEM_WATCHDOG_SOURCE="${CMUX_MEM_WATCHDOG_SOURCE:-alerts}"
CMUX_MEM_WATCHDOG_PRIORITY="${CMUX_MEM_WATCHDOG_PRIORITY:-high}"
CMUX_MEM_WATCHDOG_KILL_BIN="${CMUX_MEM_WATCHDOG_KILL_BIN:-kill}"

log() {
  printf '[cmux-watchdog] %s\n' "$*" >&2
}

bytes_from_human() {
  local value="$1"
  local trimmed number unit exponent
  trimmed="$(printf '%s' "$value" | tr -d '[:space:],')"
  if [[ -z "$trimmed" || "$trimmed" == "-" || "$trimmed" == "0" ]]; then
    echo 0
    return
  fi

  if [[ "$trimmed" =~ ^([0-9]+([.][0-9]+)?)([KMGTP]?) ]]; then
    number="${BASH_REMATCH[1]}"
    unit="${BASH_REMATCH[3]}"
  else
    echo 0
    return
  fi

  exponent=0
  case "$unit" in
    K) exponent=1 ;;
    M) exponent=2 ;;
    G) exponent=3 ;;
    T) exponent=4 ;;
    P) exponent=5 ;;
  esac

  awk -v number="$number" -v exponent="$exponent" '
    function power(base, exponent_value,   out, i) {
      out = 1
      for (i = 0; i < exponent_value; i++) out *= base
      return out
    }
    BEGIN { printf "%.0f\n", number * power(1024, exponent) }'
}

bytes_to_gb() {
  local bytes="$1"
  awk -v bytes="$bytes" 'BEGIN { printf "%.2f", bytes / (1024 * 1024 * 1024) }'
}

threshold_bytes() {
  awk -v gb="$CMUX_MEM_WATCHDOG_THRESHOLD_GB" 'BEGIN { printf "%.0f\n", gb * 1024 * 1024 * 1024 }'
}

get_cmux_pid() {
  pgrep -x cmux | head -n 1
}

read_vmmap_summary() {
  local pid="$1"
  if [[ -n "${CMUX_MEM_WATCHDOG_VMMAP_FIXTURE:-}" ]]; then
    cat "$CMUX_MEM_WATCHDOG_VMMAP_FIXTURE"
    return
  fi
  vmmap -summary "$pid"
}

extract_physical_footprint_bytes() {
  local vmmap_output="$1"
  local line
  line="$(printf '%s\n' "$vmmap_output" | awk -F: '/Physical footprint:/ {print $2; exit}')"
  bytes_from_human "$line"
}

snapshot_path() {
  local now
  now="$(date '+%Y-%m-%dT%H-%M-%S%z')"
  printf '%s/%s.log\n' "$CMUX_MEM_WATCHDOG_LOG_DIR" "$now"
}

capture_process_snapshot() {
  local pid="$1"
  local vmmap_output="$2"
  local footprint_bytes="$3"
  local path="$4"
  local footprint_gb
  footprint_gb="$(bytes_to_gb "$footprint_bytes")"

  mkdir -p "$CMUX_MEM_WATCHDOG_LOG_DIR"
  {
    printf 'timestamp=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf 'pid=%s\n' "$pid"
    printf 'threshold_gb=%s\n' "$CMUX_MEM_WATCHDOG_THRESHOLD_GB"
    printf 'physical_footprint_gb=%s\n' "$footprint_gb"
    printf '\n[ps]\n'
    ps -o pid,ppid,rss,vsz,%cpu,etime,command -p "$pid"
    printf '\n[pgrep]\n'
    pgrep -lf cmux || true
    printf '\n[vmmap-summary]\n%s\n' "$vmmap_output"
  } >"$path"
}

brain_store_breach() {
  local pid="$1"
  local footprint_bytes="$2"
  local snapshot="$3"
  local processes="$4"
  local footprint_gb
  local content
  footprint_gb="$(bytes_to_gb "$footprint_bytes")"
  content="$(cat <<EOF
cmux watchdog threshold breach. WHAT: cmux pid $pid crossed ${CMUX_MEM_WATCHDOG_THRESHOLD_GB} GB and was terminated by the local watchdog. WHY: cmux can leak IOSurface-backed memory that is invisible to ps RSS, so the watchdog uses vmmap physical footprint as the kill threshold. Details: measured_gb=$footprint_gb threshold_gb=$CMUX_MEM_WATCHDOG_THRESHOLD_GB snapshot=$snapshot processes=$processes
EOF
)"

  if [[ ! -S "$CMUX_MEM_WATCHDOG_BRAINBAR_SOCK" ]]; then
    log "brainbar socket missing at $CMUX_MEM_WATCHDOG_BRAINBAR_SOCK"
    return
  fi

  jq -cn \
    --arg content "$content" \
    '{"jsonrpc":"2.0","id":"cmux-watchdog","method":"tools/call","params":{"name":"brain_store","arguments":{"content":$content,"project":"systems","tags":["cmux","watchdog","memory-leak"],"importance":8}}}' \
    | socat - UNIX-CONNECT:"$CMUX_MEM_WATCHDOG_BRAINBAR_SOCK" >/dev/null
}

notify_breach() {
  local pid="$1"
  local footprint_bytes="$2"
  local snapshot="$3"
  local footprint_gb
  footprint_gb="$(bytes_to_gb "$footprint_bytes")"

  jq -cn \
    --arg title "cmux watchdog" \
    --arg body "cmux hit ${footprint_gb} GB > ${CMUX_MEM_WATCHDOG_THRESHOLD_GB} GB. Snapshot: $snapshot. Terminating." \
    --arg source "$CMUX_MEM_WATCHDOG_SOURCE" \
    --arg priority "$CMUX_MEM_WATCHDOG_PRIORITY" \
    '{title:$title,body:$body,source:$source,priority:$priority}' \
    | curl -sS -X POST "$CMUX_MEM_WATCHDOG_NOTIFY_URL" \
      -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null
}

terminate_cmux() {
  local pid="$1"
  "$CMUX_MEM_WATCHDOG_KILL_BIN" -TERM "$pid" || true
  sleep "$CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS"
  if "$CMUX_MEM_WATCHDOG_KILL_BIN" -0 "$pid" 2>/dev/null; then
    "$CMUX_MEM_WATCHDOG_KILL_BIN" -KILL "$pid" || true
  fi
}

handle_breach() {
  local pid="$1"
  local vmmap_output="$2"
  local footprint_bytes="$3"
  local snapshot
  local processes

  snapshot="$(snapshot_path)"
  capture_process_snapshot "$pid" "$vmmap_output" "$footprint_bytes" "$snapshot"
  processes="$(pgrep -lf cmux | tr '\n' ';' | sed 's/;$/\n/' || true)"
  brain_store_breach "$pid" "$footprint_bytes" "$snapshot" "$processes"
  notify_breach "$pid" "$footprint_bytes" "$snapshot"
  terminate_cmux "$pid"
}

run_once() {
  local pid
  local vmmap_output
  local footprint_bytes
  local limit_bytes

  if ! pid="$(get_cmux_pid)"; then
    exit 0
  fi

  vmmap_output="$(read_vmmap_summary "$pid")"
  footprint_bytes="$(extract_physical_footprint_bytes "$vmmap_output")"
  limit_bytes="$(threshold_bytes)"

  if [[ "$footprint_bytes" -ge "$limit_bytes" ]]; then
    handle_breach "$pid" "$vmmap_output" "$footprint_bytes"
  fi
}

if [[ "${CMUX_MEM_WATCHDOG_SOURCE_ONLY:-0}" != "1" ]]; then
  run_once
fi
