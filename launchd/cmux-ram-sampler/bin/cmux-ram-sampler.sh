#!/usr/bin/env bash
set -euo pipefail

CMUX_RAM_SAMPLER_LOG_DIR="${CMUX_RAM_SAMPLER_LOG_DIR:-$HOME/Library/Logs/cmux-ram-sampler}"
CMUX_RAM_SAMPLER_SAMPLE_FILE="${CMUX_RAM_SAMPLER_SAMPLE_FILE:-$CMUX_RAM_SAMPLER_LOG_DIR/samples.jsonl}"
CMUX_RAM_SAMPLER_DANGER_FOOTPRINT_GB="${CMUX_RAM_SAMPLER_DANGER_FOOTPRINT_GB:-20}"
CMUX_RAM_SAMPLER_DANGER_SWAP_FREE_GB="${CMUX_RAM_SAMPLER_DANGER_SWAP_FREE_GB:-2}"
CMUX_RAM_SAMPLER_DANGER_FREE_RAM_PCT="${CMUX_RAM_SAMPLER_DANGER_FREE_RAM_PCT:-12}"
CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS="${CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS:-600}"
CMUX_RAM_SAMPLER_WARNING_LEAD_MINUTES="${CMUX_RAM_SAMPLER_WARNING_LEAD_MINUTES:-30}"
CMUX_RAM_SAMPLER_WINDOW_SAMPLES="${CMUX_RAM_SAMPLER_WINDOW_SAMPLES:-12}"
CMUX_RAM_SAMPLER_NOTIFY_URL="${CMUX_RAM_SAMPLER_NOTIFY_URL:-http://localhost:3847/notify}"
CMUX_RAM_SAMPLER_SOURCE="${CMUX_RAM_SAMPLER_SOURCE:-alerts}"
CMUX_RAM_SAMPLER_PRIORITY="${CMUX_RAM_SAMPLER_PRIORITY:-high}"

CMUX_RAM_SAMPLER_STABLE_PATH="${CMUX_RAM_SAMPLER_STABLE_PATH:-/Applications/cmux.app/Contents/MacOS/cmux}"
CMUX_RAM_SAMPLER_NIGHTLY_PATH="${CMUX_RAM_SAMPLER_NIGHTLY_PATH:-/Applications/cmux NIGHTLY.app/Contents/MacOS/cmux}"

log() {
  printf '[cmux-ram-sampler] %s\n' "$*" >&2
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

bytes_to_mb() {
  local bytes="$1"
  awk -v bytes="$bytes" 'BEGIN { printf "%.0f\n", bytes / (1024 * 1024) }'
}

gb_to_mb() {
  local gb="$1"
  awk -v gb="$gb" 'BEGIN { printf "%.0f\n", gb * 1024 }'
}

timestamp_to_epoch() {
  local ts="$1"
  if date -j -f '%Y-%m-%dT%H:%M:%S%z' "$ts" '+%s' 2>/dev/null; then
    return
  fi
  date -d "$ts" '+%s' 2>/dev/null || echo 0
}

pid_for_path() {
  local app_path="$1"
  local pid

  pid="$(pgrep -f "$app_path" 2>/dev/null | awk 'NF && found == "" { found = $1 } END { if (found != "") print found }' || true)"
  if [[ -n "$pid" ]]; then
    printf '%s\n' "$pid"
    return
  fi

  ps -ww -axo pid=,command= 2>/dev/null | awk -v app_path="$app_path" '
    {
      pid = $1
      command = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", command)
      if (found == "" && index(command, app_path) == 1) found = pid
    }
    END {
      if (found != "") print found
    }'
}

footprint_output_for_pid() {
  local pid="$1"
  if [[ -n "${CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE:-}" ]]; then
    awk -v pid="$pid" '$1 == pid { $1 = ""; sub(/^ /, ""); print }' "$CMUX_RAM_SAMPLER_FOOTPRINT_FIXTURE"
    return
  fi

  footprint -p "$pid" 2>/dev/null || true
}

parse_footprint_mb() {
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
  bytes_to_mb "$(bytes_from_human "$value")"
}

parse_footprint_peak_mb() {
  local output="$1"
  local value
  value="$(printf '%s\n' "$output" | awk '
    /phys_footprint:/ {
      for (i = 1; i <= NF; i++) {
        if ($i == "(peak") {
          unit = $(i + 2)
          gsub(/[)]/, "", unit)
          print $(i + 1) unit
          exit
        }
      }
    }')"
  bytes_to_mb "$(bytes_from_human "$value")"
}

swap_usage_output() {
  if [[ -n "${CMUX_RAM_SAMPLER_SWAP_FIXTURE:-}" ]]; then
    cat "$CMUX_RAM_SAMPLER_SWAP_FIXTURE"
    return
  fi
  sysctl vm.swapusage 2>/dev/null || true
}

swap_used_mb() {
  swap_usage_output | awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "used") {
          value = $(i + 2)
          gsub(/,/, "", value)
          print value
          exit
        }
      }
    }' | while read -r value; do bytes_to_mb "$(bytes_from_human "$value")"; done
}

swap_free_mb() {
  swap_usage_output | awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "free") {
          value = $(i + 2)
          gsub(/,/, "", value)
          print value
          exit
        }
      }
    }' | while read -r value; do bytes_to_mb "$(bytes_from_human "$value")"; done
}

vmstat_output() {
  if [[ -n "${CMUX_RAM_SAMPLER_VMSTAT_FIXTURE:-}" ]]; then
    cat "$CMUX_RAM_SAMPLER_VMSTAT_FIXTURE"
  else
    vm_stat 2>/dev/null || true
  fi
}

vmstat_page_size_bytes() {
  local output="$1"
  printf '%s\n' "$output" | awk '
    BEGIN { page_size = 16384 }
    /page size of [0-9][0-9]* bytes/ {
      line = $0
      sub(/^.*page size of /, "", line)
      sub(/ bytes.*$/, "", line)
      page_size = line
      exit
    }
    END { print page_size }'
}

vmstat_pages_for_label() {
  local output="$1"
  local label="$2"
  printf '%s\n' "$output" | awk -v label="$label" '
    index($0, label) == 1 {
      value = $NF
      gsub(/[.]/, "", value)
      gsub(/[^0-9]/, "", value)
      print value
      exit
    }'
}

memsize_bytes() {
  if [[ -n "${CMUX_RAM_SAMPLER_MEMSIZE_FIXTURE:-}" && -f "$CMUX_RAM_SAMPLER_MEMSIZE_FIXTURE" ]]; then
    cat "$CMUX_RAM_SAMPLER_MEMSIZE_FIXTURE"
  else
    sysctl hw.memsize 2>/dev/null || true
  fi | awk '
    {
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^[0-9]+$/) value = $i
    }
    }
    END { if (value != "") print value; else print 0 }'
}

vmstat_compressor_mb() {
  local output page_size pages
  output="$(vmstat_output)"
  page_size="$(vmstat_page_size_bytes "$output")"
  pages="$(vmstat_pages_for_label "$output" "Pages occupied by compressor:")"
  pages="${pages:-0}"
  bytes_to_mb "$((pages * page_size))"
}

free_ram_pct() {
  local output page_size free_pages inactive_pages total_bytes
  output="$(vmstat_output)"
  page_size="$(vmstat_page_size_bytes "$output")"
  free_pages="$(vmstat_pages_for_label "$output" "Pages free:")"
  inactive_pages="$(vmstat_pages_for_label "$output" "Pages inactive:")"
  if [[ -z "$free_pages" || -z "$inactive_pages" ]]; then
    log "free_ram_pct unknown: missing vm_stat free/inactive pages"
    echo unknown
    return
  fi
  total_bytes="$(memsize_bytes)"
  free_pages="${free_pages:-0}"
  inactive_pages="${inactive_pages:-0}"
  total_bytes="${total_bytes:-0}"
  if [[ ! "$total_bytes" =~ ^[0-9]+$ || "$total_bytes" -le 0 ]]; then
    log "free_ram_pct unknown: invalid hw.memsize"
    echo unknown
    return
  fi

  awk \
    -v pages="$((free_pages + inactive_pages))" \
    -v page_size="$page_size" \
    -v total_bytes="$total_bytes" \
    'BEGIN {
      printf "%.0f\n", int((pages * page_size / total_bytes) * 100)
    }'
}

json_number_field() {
  local line="$1"
  local key="$2"
  printf '%s\n' "$line" | awk -v key="$key" '
    {
      pattern = "\"" key "\":[0-9]+"
      if (match($0, pattern)) {
        value = substr($0, RSTART + length(key) + 3, RLENGTH - length(key) - 3)
        print value
      }
    }'
}

json_string_field() {
  local line="$1"
  local key="$2"
  printf '%s\n' "$line" | awk -v key="$key" '
    {
      pattern = "\"" key "\":\"[^\"]+\""
      if (match($0, pattern)) {
        value = substr($0, RSTART + length(key) + 4, RLENGTH - length(key) - 4)
        gsub(/"$/, "", value)
        print value
      }
    }'
}

predict_eta_minutes() {
  local sample_file="$1"
  local instance="$2"
  local danger_footprint_mb="$3"
  local window_samples="$4"
  local rows line ts footprint_mb first_epoch="" first_mb="" last_epoch="" last_mb="" count=0
  local slope eta

  [[ -f "$sample_file" ]] || return 1
  rows="$(grep -F "\"instance\":\"$instance\"" "$sample_file" | tail -n "$window_samples" || true)"
  [[ -n "$rows" ]] || return 1

  while IFS= read -r line; do
    ts="$(json_string_field "$line" ts)"
    footprint_mb="$(json_number_field "$line" phys_footprint_mb)"
    [[ -n "$ts" && -n "$footprint_mb" ]] || continue
    if [[ -z "$first_epoch" ]]; then
      first_epoch="$(timestamp_to_epoch "$ts")"
      first_mb="$footprint_mb"
    fi
    last_epoch="$(timestamp_to_epoch "$ts")"
    last_mb="$footprint_mb"
    count=$((count + 1))
  done <<<"$rows"

  if (( count < 2 || last_epoch <= first_epoch || last_mb >= danger_footprint_mb )); then
    return 1
  fi

  slope="$(awk -v first_mb="$first_mb" -v last_mb="$last_mb" -v minutes="$(((last_epoch - first_epoch) / 60))" \
    'BEGIN { if (minutes <= 0) print 0; else printf "%.6f\n", (last_mb - first_mb) / minutes }')"
  if ! awk -v slope="$slope" 'BEGIN { exit !(slope > 0) }'; then
    return 1
  fi

  eta="$(awk -v current="$last_mb" -v danger="$danger_footprint_mb" -v slope="$slope" \
    'BEGIN { printf "%.0f\n", (danger - current) / slope }')"
  printf '%s\n' "$eta"
}

append_sample() {
  local ts="$1"
  local instance="$2"
  local pid="$3"
  local footprint_mb="$4"
  local peak_mb="$5"
  local swap_used="$6"
  local swap_free="$7"
  local compressor="$8"
  local free_ram_pct_value="$9"
  local free_ram_pct_json

  if [[ "$free_ram_pct_value" =~ ^[0-9]+$ ]]; then
    free_ram_pct_json="$free_ram_pct_value"
  else
    free_ram_pct_json="null"
  fi

  mkdir -p "$CMUX_RAM_SAMPLER_LOG_DIR"
  jq -cn \
    --arg ts "$ts" \
    --arg instance "$instance" \
    --argjson pid "$pid" \
    --argjson footprint "$footprint_mb" \
    --argjson peak "$peak_mb" \
    --argjson swap_used "$swap_used" \
    --argjson swap_free "$swap_free" \
    --argjson compressor "$compressor" \
    --argjson free_ram_pct "$free_ram_pct_json" \
    '{ts:$ts,instance:$instance,pid:$pid,phys_footprint_mb:$footprint,phys_footprint_peak_mb:$peak,swap_used_mb:$swap_used,swap_free_mb:$swap_free,compressor_mb:$compressor,free_ram_pct:$free_ram_pct}' \
    >>"$CMUX_RAM_SAMPLER_SAMPLE_FILE"
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

post_notification() {
  local title="$1"
  local body="$2"
  local host port

  if ! read -r host port < <(notify_url_host_port "$CMUX_RAM_SAMPLER_NOTIFY_URL"); then
    log "notify URL malformed ($CMUX_RAM_SAMPLER_NOTIFY_URL); skipping notification"
    return 0
  fi

  if ! notify_listener_available "$CMUX_RAM_SAMPLER_NOTIFY_URL"; then
    log "notify listener unavailable at $host:$port; skipping notification"
    return 0
  fi

  jq -cn \
    --arg title "$title" \
    --arg body "$body" \
    --arg source "$CMUX_RAM_SAMPLER_SOURCE" \
    --arg priority "$CMUX_RAM_SAMPLER_PRIORITY" \
    '{title:$title,body:$body,source:$source,priority:$priority}' \
    | curl -sS --connect-timeout 1 --max-time 3 -X POST "$CMUX_RAM_SAMPLER_NOTIFY_URL" \
      -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null 2>&1 || {
        if ! notify_listener_available "$CMUX_RAM_SAMPLER_NOTIFY_URL"; then
          log "notify listener unavailable at $host:$port; skipping notification"
        else
          log "notify post failed at $CMUX_RAM_SAMPLER_NOTIFY_URL"
        fi
      }
}

notify_warning() {
  local instance="$1"
  local pid="$2"
  local footprint_mb="$3"
  local eta_minutes="$4"
  local swap_free="$5"
  local free_ram_pct_value="${6:-unknown}"

  post_notification \
    "cmux RAM sampler" \
    "$instance pid $pid phys_footprint=${footprint_mb} MB; projected danger ETA=${eta_minutes} min; swap_free=${swap_free} MB; free_ram_pct=${free_ram_pct_value}"
}

sample_file_mtime_epoch() {
  if [[ -n "${CMUX_RAM_SAMPLER_SAMPLE_MTIME_EPOCH:-}" ]]; then
    printf '%s\n' "$CMUX_RAM_SAMPLER_SAMPLE_MTIME_EPOCH"
    return
  fi
  stat -f '%m' "$CMUX_RAM_SAMPLER_SAMPLE_FILE" 2>/dev/null || stat -c '%Y' "$CMUX_RAM_SAMPLER_SAMPLE_FILE" 2>/dev/null || echo 0
}

now_epoch() {
  if [[ -n "${CMUX_RAM_SAMPLER_NOW_EPOCH:-}" ]]; then
    printf '%s\n' "$CMUX_RAM_SAMPLER_NOW_EPOCH"
  else
    date '+%s'
  fi
}

check_sample_freshness() {
  local mtime now age
  [[ -s "$CMUX_RAM_SAMPLER_SAMPLE_FILE" ]] || return 0

  mtime="$(sample_file_mtime_epoch)"
  now="$(now_epoch)"
  if [[ -z "$mtime" || "$mtime" == "0" || "$now" -le "$mtime" ]]; then
    return 0
  fi

  age=$((now - mtime))
  if (( age > CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS )); then
    log "samples.jsonl stale: age=${age}s threshold=${CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS}s path=$CMUX_RAM_SAMPLER_SAMPLE_FILE"
    post_notification \
      "cmux RAM sampler stale" \
      "samples.jsonl stale for ${age}s (threshold ${CMUX_RAM_SAMPLER_SAMPLE_STALE_SECONDS}s): $CMUX_RAM_SAMPLER_SAMPLE_FILE"
  fi
}

sample_instance() {
  local instance="$1"
  local app_path="$2"
  local ts="$3"
  local swap_used="$4"
  local swap_free="$5"
  local compressor="$6"
  local free_ram_pct_value="$7"
  local danger_footprint_mb="$8"
  local pid output footprint_mb peak_mb eta_minutes=""

  pid="$(pid_for_path "$app_path")"
  if [[ -z "$pid" ]]; then
    log "$instance not running at $app_path; skipping"
    return 0
  fi

  output="$(footprint_output_for_pid "$pid")"
  footprint_mb="$(parse_footprint_mb "$output")"
  peak_mb="$(parse_footprint_peak_mb "$output")"
  append_sample "$ts" "$instance" "$pid" "$footprint_mb" "$peak_mb" "$swap_used" "$swap_free" "$compressor" "$free_ram_pct_value"

  eta_minutes="$(predict_eta_minutes "$CMUX_RAM_SAMPLER_SAMPLE_FILE" "$instance" "$danger_footprint_mb" "$CMUX_RAM_SAMPLER_WINDOW_SAMPLES" || true)"
  if [[ -n "$eta_minutes" && "$eta_minutes" -lt "$CMUX_RAM_SAMPLER_WARNING_LEAD_MINUTES" ]]; then
    log "$instance pid $pid projected to reach $CMUX_RAM_SAMPLER_DANGER_FOOTPRINT_GB GB phys_footprint in ${eta_minutes}m"
    notify_warning "$instance" "$pid" "$footprint_mb" "$eta_minutes" "$swap_free" "$free_ram_pct_value"
  elif [[ "$free_ram_pct_value" =~ ^[0-9]+$ && "$free_ram_pct_value" -le "$CMUX_RAM_SAMPLER_DANGER_FREE_RAM_PCT" ]]; then
    log "$instance pid $pid sampled with low free_ram_pct=${free_ram_pct_value}%"
    notify_warning "$instance" "$pid" "$footprint_mb" "${eta_minutes:-unknown}" "$swap_free" "$free_ram_pct_value"
  elif [[ "$swap_free" -lt "$(gb_to_mb "$CMUX_RAM_SAMPLER_DANGER_SWAP_FREE_GB")" ]]; then
    log "$instance pid $pid sampled with low swap_free=${swap_free}MB"
    notify_warning "$instance" "$pid" "$footprint_mb" "${eta_minutes:-unknown}" "$swap_free" "$free_ram_pct_value"
  fi
}

run_once() {
  local ts swap_used swap_free compressor free_ram_pct_value danger_footprint_mb
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  check_sample_freshness
  swap_used="$(swap_used_mb)"
  swap_free="$(swap_free_mb)"
  compressor="$(vmstat_compressor_mb)"
  free_ram_pct_value="$(free_ram_pct)"
  if [[ ! "$free_ram_pct_value" =~ ^[0-9]+$ ]]; then
    log "free_ram_pct unavailable; skipping free-RAM trigger"
  fi
  danger_footprint_mb="$(gb_to_mb "$CMUX_RAM_SAMPLER_DANGER_FOOTPRINT_GB")"

  sample_instance stable "$CMUX_RAM_SAMPLER_STABLE_PATH" "$ts" "${swap_used:-0}" "${swap_free:-0}" "$compressor" "$free_ram_pct_value" "$danger_footprint_mb"
  sample_instance nightly "$CMUX_RAM_SAMPLER_NIGHTLY_PATH" "$ts" "${swap_used:-0}" "${swap_free:-0}" "$compressor" "$free_ram_pct_value" "$danger_footprint_mb"
}

if [[ "${CMUX_RAM_SAMPLER_SOURCE_ONLY:-0}" != "1" ]]; then
  run_once
fi
