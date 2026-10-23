#!/usr/bin/env bash
set -euo pipefail

CMUX_MEM_WATCHDOG_THRESHOLD_GB="${CMUX_MEM_WATCHDOG_THRESHOLD_GB:-10}"
CMUX_MEM_WATCHDOG_MIN_THRESHOLD_GB="${CMUX_MEM_WATCHDOG_MIN_THRESHOLD_GB:-1}"
CMUX_MEM_WATCHDOG_LOG_DIR="${CMUX_MEM_WATCHDOG_LOG_DIR:-$HOME/Library/Logs/cmux-watchdog}"
CMUX_MEM_WATCHDOG_NOTIFY_URL="${CMUX_MEM_WATCHDOG_NOTIFY_URL:-http://localhost:3847/notify}"
CMUX_MEM_WATCHDOG_BRAINBAR_SOCK="${CMUX_MEM_WATCHDOG_BRAINBAR_SOCK:-/tmp/brainbar.sock}"
CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS="${CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS:-10}"
CMUX_MEM_WATCHDOG_SIDE_EFFECT_TIMEOUT_SECONDS="${CMUX_MEM_WATCHDOG_SIDE_EFFECT_TIMEOUT_SECONDS:-5}"
CMUX_MEM_WATCHDOG_SOURCE="${CMUX_MEM_WATCHDOG_SOURCE:-alerts}"
CMUX_MEM_WATCHDOG_PRIORITY="${CMUX_MEM_WATCHDOG_PRIORITY:-high}"
CMUX_MEM_WATCHDOG_KILL_BIN="${CMUX_MEM_WATCHDOG_KILL_BIN:-kill}"
CMUX_MEM_WATCHDOG_DRY_RUN="${CMUX_MEM_WATCHDOG_DRY_RUN:-0}"

# SCOPE (finding #3 / M5): this watchdog targets the cmux GUI app process(es)
# and terminates one only when its OWN resident set crosses the threshold.
# RSS does not measure all IOSurface/compressed allocations. Orphaned
# cmuxlayer workers such as `node .../dist/index.js` (ppid=1) and
# `bun .../src/index.ts` are DELIBERATELY out of scope here — they belong to a
# separate cmuxlayer reaper. We never mass-kill on a coarse name match.

log() {
  printf '[cmux-watchdog] %s\n' "$*" >&2
}

# Run a best-effort side effect under a wall-clock bound so a wedged socket or
# endpoint can never hang the interval job (finding #5 / M7). macOS ships no
# `timeout`; fall back to gtimeout, then to running unbounded as a last resort.
run_bounded() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then
    # Stock macOS ships no timeout/gtimeout. perl's SIGALRM survives exec and
    # bounds the command with no coreutils dependency; stdin (a pipe here) is
    # inherited through exec.
    perl -e 'my $t = shift; alarm $t; exec @ARGV or exit 127' "$secs" "$@"
  else
    # Last resort only if even perl is absent. Current callers additionally
    # carry their own inner bound (curl --max-time, socat -T), so a wedged
    # endpoint still cannot hang the interval on this path.
    "$@"
  fi
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

# Fail CLOSED (finding #2 / M1): an invalid, empty, zero, or below-floor
# threshold must NEVER become "kill everything". Callers treat a non-zero
# return as "refuse to run".
validate_threshold() {
  local gb="$CMUX_MEM_WATCHDOG_THRESHOLD_GB"
  local min="$CMUX_MEM_WATCHDOG_MIN_THRESHOLD_GB"

  if [[ -z "$gb" || ! "$gb" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    log "invalid CMUX_MEM_WATCHDOG_THRESHOLD_GB='$gb' (need a positive number); refusing to run (fail-closed)"
    return 1
  fi
  if [[ ! "$min" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    log "invalid CMUX_MEM_WATCHDOG_MIN_THRESHOLD_GB='$min'; refusing to run (fail-closed)"
    return 1
  fi
  if awk -v gb="$gb" -v min="$min" 'BEGIN { exit !(gb + 0 > 0 && gb + 0 >= min + 0) }'; then
    return 0
  fi
  log "CMUX_MEM_WATCHDOG_THRESHOLD_GB='$gb' below minimum ${min} GB; refusing to run (fail-closed)"
  return 1
}

threshold_bytes() {
  awk -v gb="$CMUX_MEM_WATCHDOG_THRESHOLD_GB" 'BEGIN { printf "%.0f\n", gb * 1024 * 1024 * 1024 }'
}

# Enumerate ALL cmux GUI app PIDs (finding #3 / M5) — never just the first.
# Union of exact process-name, app-bundle command match, and an exact
# executable-path match; deduplicated and numerically sorted.
get_cmux_pids() {
  {
    pgrep -x cmux 2>/dev/null || true
    pgrep -f 'cmux\.app/Contents/MacOS/cmux' 2>/dev/null || true
    ps -axo pid=,command= 2>/dev/null | awk '{ pid=$1; $1=""; sub(/^ +/, ""); if ($0 == "/Applications/cmux.app/Contents/MacOS/cmux") { print pid } }'
  } | awk 'NF' | sort -n -u
}

# Stable-enough process identity to detect PID reuse across the TERM grace
# window (finding #4 / M4): executable name + absolute start time.
process_identity() {
  local pid="$1"
  ps -o comm=,lstart= -p "$pid" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ *//;s/ *$//'
}

# ps reports RSS in KiB, not physical footprint. Reject unknown, malformed or
# oversized measurements; never substitute zero or use a task-port fallback.
rss_bytes_for_pid() {
  local rss_kb
  rss_kb="$(ps -o rss= -p "$1" 2>/dev/null)" || return 1
  [[ "$rss_kb" =~ ^[[:space:]]*([0-9]+)[[:space:]]*$ ]] || return 1
  awk -v kb="${BASH_REMATCH[1]}" 'BEGIN {
    if (kb + 0 > 8796093022207) exit 1
    printf "%.0f\n", kb * 1024
  }'
}

snapshot_path() {
  local now
  now="$(date '+%Y-%m-%dT%H-%M-%S%z')"
  printf '%s/%s.log\n' "$CMUX_MEM_WATCHDOG_LOG_DIR" "$now"
}

capture_process_snapshot() {
  local pid="$1"
  local rss_bytes="$2"
  local path="$3"
  local rss_gb
  rss_gb="$(bytes_to_gb "$rss_bytes")"

  mkdir -p "$CMUX_MEM_WATCHDOG_LOG_DIR"
  {
    printf 'timestamp=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf 'pid=%s\n' "$pid"
    printf 'threshold_gb=%s\n' "$CMUX_MEM_WATCHDOG_THRESHOLD_GB"
    printf 'rss_gb=%s\n' "$rss_gb"
    printf '\n[ps]\n'
    ps -o pid,ppid,rss,vsz,%cpu,etime,command -p "$pid"
    printf '\n[pgrep]\n'
    pgrep -lf cmux || true
  } >"$path"
}

brain_store_breach() {
  local pid="$1"
  local rss_bytes="$2"
  local snapshot="$3"
  local processes="$4"
  local rss_gb
  local content
  local socat_bin
  rss_gb="$(bytes_to_gb "$rss_bytes")"
  content="$(cat <<EOF
cmux watchdog threshold breach. WHAT: cmux pid $pid crossed ${CMUX_MEM_WATCHDOG_THRESHOLD_GB} GB and was terminated by the local watchdog. WHY: the process resident set exceeded the configured threshold; RSS excludes some IOSurface/compressed allocations. Details: measured_gb=$rss_gb threshold_gb=$CMUX_MEM_WATCHDOG_THRESHOLD_GB snapshot=$snapshot processes=$processes
EOF
)"

  if [[ ! -S "$CMUX_MEM_WATCHDOG_BRAINBAR_SOCK" ]]; then
    log "brainbar socket missing at $CMUX_MEM_WATCHDOG_BRAINBAR_SOCK"
    return
  fi

  socat_bin="$(command -v socat || true)"
  if [[ -z "$socat_bin" ]]; then
    for candidate in /opt/homebrew/bin/socat /usr/local/bin/socat; do
      if [[ -x "$candidate" ]]; then
        socat_bin="$candidate"
        break
      fi
    done
  fi
  if [[ -z "$socat_bin" ]]; then
    log "socat missing; skipping brain_store"
    return
  fi

  # Bounded (M7): socat -T inactivity timeout + an outer wall-clock bound so a
  # wedged BrainBar socket can never stall the interval job.
  jq -cn \
    --arg content "$content" \
    '{"jsonrpc":"2.0","id":"cmux-watchdog","method":"tools/call","params":{"name":"brain_store","arguments":{"content":$content,"project":"systems","tags":["cmux","watchdog","memory-leak"],"importance":8}}}' \
    | run_bounded "$CMUX_MEM_WATCHDOG_SIDE_EFFECT_TIMEOUT_SECONDS" \
        "$socat_bin" -T "$CMUX_MEM_WATCHDOG_SIDE_EFFECT_TIMEOUT_SECONDS" - UNIX-CONNECT:"$CMUX_MEM_WATCHDOG_BRAINBAR_SOCK" >/dev/null \
    || log "brain_store failed"
}

notify_breach() {
  local pid="$1"
  local rss_bytes="$2"
  local snapshot="$3"
  local rss_gb
  rss_gb="$(bytes_to_gb "$rss_bytes")"

  # Bounded (M7): curl connect + total time caps so a wedged notify endpoint
  # cannot delay the termination decision.
  jq -cn \
    --arg title "cmux watchdog" \
    --arg body "cmux hit ${rss_gb} GB RSS > ${CMUX_MEM_WATCHDOG_THRESHOLD_GB} GB. Snapshot: $snapshot. Terminating." \
    --arg source "$CMUX_MEM_WATCHDOG_SOURCE" \
    --arg priority "$CMUX_MEM_WATCHDOG_PRIORITY" \
    '{title:$title,body:$body,source:$source,priority:$priority}' \
    | curl -sS -X POST "$CMUX_MEM_WATCHDOG_NOTIFY_URL" \
      --connect-timeout 2 \
      --max-time "$CMUX_MEM_WATCHDOG_SIDE_EFFECT_TIMEOUT_SECONDS" \
      -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null \
    || log "notify failed"
}

terminate_cmux() {
  local pid="$1"
  local identity_before="${2:-}"
  if [[ "$CMUX_MEM_WATCHDOG_DRY_RUN" == "1" ]]; then
    log "dry run enabled; would terminate cmux pid $pid"
    return
  fi

  "$CMUX_MEM_WATCHDOG_KILL_BIN" -TERM "$pid" || true
  sleep "$CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS"

  # Process already exited on TERM — nothing to escalate.
  if ! "$CMUX_MEM_WATCHDOG_KILL_BIN" -0 "$pid" 2>/dev/null; then
    return
  fi

  # PID-reuse guard (M4): if the PID no longer resolves to the same process we
  # decided to kill, do NOT SIGKILL a possibly-unrelated process. Warn only.
  local identity_after
  identity_after="$(process_identity "$pid")"
  # N1: an empty baseline means we could not prove identity at decision time —
  # treat "unprovable" the same as "changed" and refuse to escalate (warn-only
  # on any doubt).
  if [[ -z "$identity_before" ]]; then
    log "pid $pid identity baseline unavailable; refusing SIGKILL — cannot prove same process (warn-only)"
    return
  fi
  if [[ "$identity_after" != "$identity_before" ]]; then
    log "pid $pid identity changed after TERM (before='$identity_before' after='$identity_after'); refusing SIGKILL — possible PID reuse (warn-only)"
    return
  fi

  "$CMUX_MEM_WATCHDOG_KILL_BIN" -KILL "$pid" || true
}

handle_breach() {
  local pid="$1"
  local rss_bytes="$2"
  local snapshot
  local processes
  local identity

  identity="$(process_identity "$pid")"
  snapshot="$(snapshot_path)"
  capture_process_snapshot "$pid" "$rss_bytes" "$snapshot"
  processes="$(pgrep -lf cmux | tr '\n' ';' | sed 's/;$/\n/' || true)"
  brain_store_breach "$pid" "$rss_bytes" "$snapshot" "$processes"
  notify_breach "$pid" "$rss_bytes" "$snapshot"
  terminate_cmux "$pid" "$identity"
}

run_once() {
  local pids
  local pid
  local rss_bytes
  local limit_bytes

  # M1: refuse to do anything destructive on a bad threshold.
  if ! validate_threshold; then
    return 0
  fi

  pids="$(get_cmux_pids)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  limit_bytes="$(threshold_bytes)"

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if ! rss_bytes="$(rss_bytes_for_pid "$pid")"; then
      log "RSS unavailable or invalid for pid $pid; skipping (fail-safe, no kill)"
      continue
    fi

    if [[ "$rss_bytes" -ge "$limit_bytes" ]]; then
      handle_breach "$pid" "$rss_bytes"
    fi
  done <<< "$pids"
}

# M10: `return` (not `exit`) — this file is sourced by the test harness, so an
# `exit` in run_once would kill the harness on the no-cmux path.
if [[ "${CMUX_MEM_WATCHDOG_SOURCE_ONLY:-0}" != "1" ]]; then
  run_once
fi
