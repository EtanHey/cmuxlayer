#!/usr/bin/env bash
set -euo pipefail

CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB="${CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB:-${CMUX_MEM_WATCHDOG_RSS_THRESHOLD_GB:-${CMUX_MEM_WATCHDOG_THRESHOLD_GB:-5}}}"
CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB="${CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB:-12}"
CMUX_MEM_WATCHDOG_LOG_DIR="${CMUX_MEM_WATCHDOG_LOG_DIR:-$HOME/Library/Logs/cmux-watchdog}"
CMUX_MEM_WATCHDOG_NOTIFY_URL="${CMUX_MEM_WATCHDOG_NOTIFY_URL:-http://localhost:3847/notify}"
CMUX_MEM_WATCHDOG_BRAINBAR_SOCK="${CMUX_MEM_WATCHDOG_BRAINBAR_SOCK:-/tmp/brainbar.sock}"
CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS="${CMUX_MEM_WATCHDOG_TERM_GRACE_SECONDS:-10}"
CMUX_MEM_WATCHDOG_SOURCE="${CMUX_MEM_WATCHDOG_SOURCE:-alerts}"
CMUX_MEM_WATCHDOG_PRIORITY="${CMUX_MEM_WATCHDOG_PRIORITY:-high}"
CMUX_MEM_WATCHDOG_KILL_BIN="${CMUX_MEM_WATCHDOG_KILL_BIN:-kill}"
CMUX_MEM_WATCHDOG_TOP_RSS_LIMIT="${CMUX_MEM_WATCHDOG_TOP_RSS_LIMIT:-5}"

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
  local gb="$1"
  awk -v gb="$gb" 'BEGIN { printf "%.0f", gb * 1024 * 1024 * 1024 }'
}

get_cmux_pid() {
  local pid
  pid="$(ps_cmux_pids | awk 'NF && found == "" { found = $1 } END { if (found != "") print found }')"
  if [[ -n "$pid" ]]; then
    printf '%s\n' "$pid"
    return 0
  fi

  pid="$(pgrep -x cmux 2>/dev/null | awk 'NF && found == "" { found = $1 } END { if (found != "") print found }' || true)"
  if [[ -n "$pid" ]]; then
    printf '%s\n' "$pid"
    return 0
  fi

  return 1
}

ps_cmux_pids() {
  ps -ww -axo pid=,command= 2>/dev/null | awk '
    {
      pid = $1
      command = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", command)
      if (command ~ /^\/Applications\/cmux[^\/]*\.app\/Contents\/MacOS\/cmux([[:space:]]|$)/) print pid
      else if (command ~ /^\/Applications\/cmux[^\/]*\.app\/Contents\/Resources\/bin\/bun([[:space:]]|$)/) print pid
    }'
}

parse_phys_footprint_bytes() {
  local output="$1"
  local value

  value="$(printf '%s\n' "$output" | awk '
    /phys_footprint:/ {
      for (i = 1; i <= NF; i++) {
        if ($i == "phys_footprint:") {
          print $(i + 1) $(i + 2)
          exit
        }
      }
    }')"

  bytes_from_human "$value"
}

cmux_footprint_bytes_for_pid() {
  local pid="$1"
  local output

  if [[ -n "${CMUX_MEM_WATCHDOG_FOOTPRINT_FIXTURE:-}" ]]; then
    output="$(awk -v pid="$pid" '$1 == pid { $1 = ""; sub(/^ /, ""); print }' "$CMUX_MEM_WATCHDOG_FOOTPRINT_FIXTURE")"
  elif [[ -n "${CMUX_MEM_WATCHDOG_PS_FIXTURE:-}" ]]; then
    output="$(awk -v pid="$pid" '$1 == pid { print "phys_footprint: " $2 "K" }' "$CMUX_MEM_WATCHDOG_PS_FIXTURE")"
  else
    output="$(footprint -p "$pid" 2>/dev/null || true)"
  fi

  parse_phys_footprint_bytes "$output"
}

aggregate_cmux_footprint_bytes() {
  local total_bytes=0
  local pid
  local footprint_bytes
  local pids

  # Match BOTH cmux bundles (stable cmux.app + nightly "cmux NIGHTLY.app") so
  # the watchdog covers whichever instance(s) are running — including when only
  # nightly is up. Use ps as the primary source: broad pgrep -f can match the
  # transient pgrep command itself on macOS.
  pids="$({ ps_cmux_pids || true; pgrep -x cmux 2>/dev/null || true; } | awk 'NF && !seen[$1]++ { print $1 }')"
  for pid in $pids; do
    footprint_bytes="$(cmux_footprint_bytes_for_pid "$pid")"
    if [[ -n "$footprint_bytes" ]]; then
      total_bytes=$((total_bytes + footprint_bytes))
    fi
  done

  echo "$total_bytes"
}

vmstat_compressor_bytes() {
  local pages page_size
  local vmstat_output

  if [[ -n "${CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE:-}" ]]; then
    vmstat_output="$(cat "$CMUX_MEM_WATCHDOG_VMSTAT_FIXTURE")"
  else
    vmstat_output="$(vm_stat)"
  fi

  page_size="$(printf '%s\n' "$vmstat_output" | awk '
    BEGIN { page_size = 16384 }
    /page size of [0-9][0-9]* bytes/ {
      line = $0
      sub(/^.*page size of /, "", line)
      sub(/ bytes.*$/, "", line)
      page_size = line
      exit
    }
    END { print page_size }')"
  pages="$(printf '%s\n' "$vmstat_output" | awk '/Pages occupied by compressor/ {gsub(/\./,"",$NF); print $NF}')"
  pages="${pages:-0}"
  echo $((pages * page_size))
}

top_rss_offenders() {
  local limit="$CMUX_MEM_WATCHDOG_TOP_RSS_LIMIT"
  local ps_output

  if [[ -n "${CMUX_MEM_WATCHDOG_PS_TOP_FIXTURE:-}" ]]; then
    ps_output="$(cat "$CMUX_MEM_WATCHDOG_PS_TOP_FIXTURE")"
  else
    ps_output="$(ps -axo pid,rss,comm 2>/dev/null || true)"
  fi

  printf '%s\n' "$ps_output" | awk '
    NR == 1 && $1 == "PID" { next }
    NF >= 3 {
      pid = $1
      rss = $2
      $1 = ""
      $2 = ""
      sub(/^[[:space:]]+/, "")
      print rss "\t" pid "\t" $0
    }' \
    | sort -rn \
    | head -n "$limit" \
    | awk -F '\t' '{ printf "pid=%s rss_mb=%.0f command=%s\n", $2, $1 / 1024, $3 }'
}

snapshot_path() {
  local now
  now="$(date '+%Y-%m-%dT%H-%M-%S%z')"
  printf '%s/%s.log\n' "$CMUX_MEM_WATCHDOG_LOG_DIR" "$now"
}

capture_process_snapshot() {
  local pid="$1"
  local cmux_footprint_bytes="$2"
  local vmstat_compressor_bytes_value="$3"
  local tripped="$4"
  local path="$5"
  local cmux_footprint_gb
  local compressor_gb

  cmux_footprint_gb="$(bytes_to_gb "$cmux_footprint_bytes")"
  compressor_gb="$(bytes_to_gb "$vmstat_compressor_bytes_value")"

  mkdir -p "$CMUX_MEM_WATCHDOG_LOG_DIR"
  {
    printf 'timestamp=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
    printf 'pid=%s\n' "$pid"
    printf 'footprint_threshold_gb=%s\n' "$CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB"
    printf 'compressor_threshold_gb=%s\n' "$CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB"
    printf 'cmux_footprint_bytes=%s\n' "$cmux_footprint_bytes"
    printf 'cmux_footprint_gb=%s\n' "$cmux_footprint_gb"
    printf 'vmstat_compressor_bytes=%s\n' "$vmstat_compressor_bytes_value"
    printf 'vmstat_compressor_gb=%s\n' "$compressor_gb"
    printf 'breached_signals=%s\n' "$tripped"
    printf '\n[ps]\n'
    ps -o pid,ppid,rss,vsz,%cpu,etime,command -p "$pid" || true
    printf '\n[pgrep]\n'
    pgrep -lf cmux || true
    printf '\n[top_rss_offenders]\n'
    top_rss_offenders || true
  } >"$path"
}

brain_store_breach() {
  local pid="$1"
  local cmux_footprint_bytes="$2"
  local vmstat_compressor_bytes_value="$3"
  local snapshot="$4"
  local processes="$5"
  local tripped="$6"
  local cmux_footprint_gb
  local compressor_gb
  local content

  cmux_footprint_gb="$(bytes_to_gb "$cmux_footprint_bytes")"
  compressor_gb="$(bytes_to_gb "$vmstat_compressor_bytes_value")"
  content="cmux watchdog threshold breach. WHAT: cmux pid $pid crossed signal(s): $tripped. WHY: dual-memory checks found $cmux_footprint_gb GB phys_footprint and $compressor_gb GB compressed memory. Details: cmux_footprint_gb=$cmux_footprint_gb footprint_threshold_gb=$CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB vm_compressor_gb=$compressor_gb compressor_threshold_gb=$CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB snapshot=$snapshot processes=$processes"

  if [[ ! -S "$CMUX_MEM_WATCHDOG_BRAINBAR_SOCK" ]]; then
    log "brainbar socket missing at $CMUX_MEM_WATCHDOG_BRAINBAR_SOCK"
    return
  fi

  jq -cn \
    --arg content "$content" \
    '{"jsonrpc":"2.0","id":"cmux-watchdog","method":"tools/call","params":{"name":"brain_store","arguments":{"content":$content,"project":"systems","tags":["cmux","watchdog","memory-leak"],"importance":8}}}' \
    | socat - UNIX-CONNECT:"$CMUX_MEM_WATCHDOG_BRAINBAR_SOCK" >/dev/null
}

notify_url_host_port() {
  local url="$1"
  local scheme host port
  if [[ "$url" =~ ^(https?)://([^/:]+)(:([0-9]+))?(/.*)?$ ]]; then
    scheme="${BASH_REMATCH[1]}"
    host="${BASH_REMATCH[2]}"
    port="${BASH_REMATCH[4]}"
    if [[ -z "$port" ]]; then
      if [[ "$scheme" == "https" ]]; then
        port="443"
      else
        port="80"
      fi
    fi
    printf '%s %s\n' "$host" "$port"
    return 0
  fi
  return 1
}

notify_listener_available() {
  local url="$1"
  local host port
  read -r host port < <(notify_url_host_port "$url") || return 1
  if command -v nc >/dev/null 2>&1; then
    nc -z -G 1 "$host" "$port" >/dev/null 2>&1 || nc -z -w 1 "$host" "$port" >/dev/null 2>&1
    return
  fi
  (: >"/dev/tcp/$host/$port") >/dev/null 2>&1
}

notify_breach() {
  local pid="$1"
  local tripped="$2"
  local cmux_footprint_bytes="$3"
  local vmstat_compressor_bytes_value="$4"
  local snapshot="$5"
  local cmux_footprint_gb
  local compressor_gb

  cmux_footprint_gb="$(bytes_to_gb "$cmux_footprint_bytes")"
  compressor_gb="$(bytes_to_gb "$vmstat_compressor_bytes_value")"

  local host port
  if ! read -r host port < <(notify_url_host_port "$CMUX_MEM_WATCHDOG_NOTIFY_URL"); then
    log "notify URL malformed ($CMUX_MEM_WATCHDOG_NOTIFY_URL); skipping notification"
    return 0
  fi

  if ! notify_listener_available "$CMUX_MEM_WATCHDOG_NOTIFY_URL"; then
    log "notify listener unavailable at $host:$port; skipping notification"
    return 0
  fi

  jq -cn \
    --arg title "cmux watchdog" \
    --arg body "cmux hit $cmux_footprint_gb GB phys_footprint / $compressor_gb GB compressed memory, tripped $tripped. Snapshot: $snapshot. Terminating." \
    --arg source "$CMUX_MEM_WATCHDOG_SOURCE" \
    --arg priority "$CMUX_MEM_WATCHDOG_PRIORITY" \
    '{title:$title,body:$body,source:$source,priority:$priority}' \
    | curl -sS --connect-timeout 1 --max-time 3 -X POST "$CMUX_MEM_WATCHDOG_NOTIFY_URL" \
      -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null 2>&1 || log "notify post failed at $CMUX_MEM_WATCHDOG_NOTIFY_URL"
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
  local cmux_footprint_bytes="$2"
  local vmstat_compressor_bytes_value="$3"
  local tripped="$4"
  local snapshot
  local processes

  log "cmux process $pid breached memory thresholds: $tripped (footprint_bytes=$cmux_footprint_bytes, vmstat_compressor_bytes=$vmstat_compressor_bytes_value)"

  snapshot="$(snapshot_path)"
  capture_process_snapshot "$pid" "$cmux_footprint_bytes" "$vmstat_compressor_bytes_value" "$tripped" "$snapshot"
  processes="$(top_rss_offenders | tr '\n' ';' | sed 's/;$/\n/' || true)"
  brain_store_breach "$pid" "$cmux_footprint_bytes" "$vmstat_compressor_bytes_value" "$snapshot" "$processes" "$tripped"
  notify_breach "$pid" "$tripped" "$cmux_footprint_bytes" "$vmstat_compressor_bytes_value" "$snapshot"
  terminate_cmux "$pid"
}

run_once() {
  local cmux_pid
  local cmux_footprint_bytes
  local vmstat_compressor_bytes_value
  local footprint_threshold_bytes
  local compressor_threshold_bytes
  local tripped

  if ! cmux_pid="$(get_cmux_pid)"; then
    log "no cmux process found; skipping check"
    return 0
  fi

  cmux_footprint_bytes="$(aggregate_cmux_footprint_bytes)"
  vmstat_compressor_bytes_value="$(vmstat_compressor_bytes)"
  footprint_threshold_bytes="$(threshold_bytes "$CMUX_MEM_WATCHDOG_FOOTPRINT_THRESHOLD_GB")"
  compressor_threshold_bytes="$(threshold_bytes "$CMUX_MEM_WATCHDOG_COMPRESSOR_THRESHOLD_GB")"

  tripped=""
  if (( cmux_footprint_bytes > footprint_threshold_bytes )); then
    tripped="footprint"
  fi

  if (( vmstat_compressor_bytes_value > compressor_threshold_bytes )); then
    if [[ -n "$tripped" ]]; then
      tripped="${tripped},compressor"
    else
      tripped="compressor"
    fi
  fi

  if [[ -n "$tripped" ]]; then
    handle_breach "$cmux_pid" "$cmux_footprint_bytes" "$vmstat_compressor_bytes_value" "$tripped"
  fi
}

if [[ "${CMUX_MEM_WATCHDOG_SOURCE_ONLY:-0}" != "1" ]]; then
  run_once
fi
