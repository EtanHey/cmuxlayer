#!/usr/bin/env bash
# heavy-ml-guardian — whole-system heavy-ML memory guard (clx control layer)
#
# WHY THIS EXISTS: on 2026-06-14 the Mac took two watchdog-timeout KERNEL PANICS
# (00:59:59 + 01:49:25) from memory-exhaustion livelock — 3x python3.11 @ ~14GB +
# llama-server @ 5.5GB on a 36GB box drove the compressor to 100% of segments / 47
# swapfiles, starving watchdogd. The existing cmux-memory-watchdog is cmux-PID-centric:
# it watches system compressor but only knows how to KILL CMUX (which was 1.4GB and not
# the culprit). This guardian closes that blind spot — it watches NON-CMUX heavy-ML procs
# and the sampler's own liveness, then alerts (alert-first) and — by default — autokills
# TRUE runaways only (guarded autokill ON: HEAVY_ML_GUARD_ENABLE_KILL=1, Etan ruling 2026-06-14).
#
# Standalone by design: it does NOT edit the cmuxlayer watchdog/sampler (which have
# live uncommitted WIP from the cmuxlayer lead). Once the canonical-copy decision lands,
# this logic can be folded into the canonical watchdog.
#
# Signals it trips on:
#   heavy_ml_mutex      — more than HEAVY_ML_MUTEX_MAX_SLOTS heavy-ML procs resident
#   heavy_ml_aggregate  — total heavy-ML footprint > HEAVY_ML_AGG_DANGER_GB
#   compressor          — VM compressor > HEAVY_ML_COMPRESSOR_DANGER_GB (real page size)
#   wired_high          — wired memory > HEAVY_ML_WIRED_DANGER_GB (alert-only)
#   sampler_stale       — cmux-ram-sampler samples.jsonl older than HEAVY_ML_SAMPLER_STALE_SECONDS
#
# Side effects on trip: JSON status to stdout (always), clx event emit when
# HEAVY_ML_CLX_CLI is configured, and guarded kill of TRUE runaways only
# (HEAVY_ML_GUARD_ENABLE_KILL — default 1=ON per Etan 2026-06-14; set 0 for alert-only).
set -euo pipefail

HEAVY_ML_MIN_GB="${HEAVY_ML_MIN_GB:-3}"                       # a proc counts as a heavy-ML slot at/above this RSS
HEAVY_ML_MUTEX_MAX_SLOTS="${HEAVY_ML_MUTEX_MAX_SLOTS:-1}"     # single-heavy-ML-slot mutex
HEAVY_ML_AGG_DANGER_GB="${HEAVY_ML_AGG_DANGER_GB:-24}"        # aggregate ML footprint danger (of 36GB)
HEAVY_ML_COMPRESSOR_DANGER_GB="${HEAVY_ML_COMPRESSOR_DANGER_GB:-12}"
HEAVY_ML_WIRED_DANGER_GB="${HEAVY_ML_WIRED_DANGER_GB:-22}"    # wired/GPU/Metal/kernel memory danger (alert-only)
HEAVY_ML_SAMPLE_FILE="${HEAVY_ML_SAMPLE_FILE:-$HOME/Library/Logs/cmux-ram-sampler/samples.jsonl}"
HEAVY_ML_SAMPLER_STALE_SECONDS="${HEAVY_ML_SAMPLER_STALE_SECONDS:-5400}"  # 3 x 1800s: cmuxlayer/launchd/cmux-ram-sampler/launchd/com.golems.cmux-ram-sampler.plist
HEAVY_ML_CLX_CLI="${HEAVY_ML_CLX_CLI:-}"                      # e.g. "bun /path/src/clx/cli.ts" — emit local.ram.guard events
HEAVY_ML_GUARD_ENABLE_KILL="${HEAVY_ML_GUARD_ENABLE_KILL:-1}" # 1 = autokill TRUE runaways only (Etan ruling 2026-06-14). 0 = alert-only.
HEAVY_ML_RUNAWAY_GB="${HEAVY_ML_RUNAWAY_GB:-12}"             # a non-seat, non-protected proc at/above this RSS, under danger, is a runaway
HEAVY_ML_KILL_BIN="${HEAVY_ML_KILL_BIN:-/bin/kill}"   # pinned for the minimal launchd PATH
HEAVY_ML_TERM_GRACE_SECONDS="${HEAVY_ML_TERM_GRACE_SECONDS:-8}"
HEAVY_ML_DANGER_STATE_DIR="${HEAVY_ML_DANGER_STATE_DIR:-$HOME/.local/state/clx-guard/heavy-ml-guardian}"
HEAVY_ML_SUSTAINED_BREACH_TICKS="${HEAVY_ML_SUSTAINED_BREACH_TICKS:-3}"

# Free-RAM / swap danger (the gen-16 RAM-alert profile: free RAM cratered + swap climbed while
# the compressor stayed low — the compressor-only check missed it). System in danger if free
# system memory drops below FREE_RAM_DANGER_PCT or swap used climbs above SWAP_DANGER_PCT.
HEAVY_ML_FREE_RAM_DANGER_PCT="${HEAVY_ML_FREE_RAM_DANGER_PCT:-8}"
HEAVY_ML_SWAP_DANGER_PCT="${HEAVY_ML_SWAP_DANGER_PCT:-80}"
HEAVY_ML_TOTAL_RAM_GB="${HEAVY_ML_TOTAL_RAM_GB:-}"

# Stale-embedder reclaim: a transient BACKFILL JOB (NOT a daemon, NOT the voice stack) that is
# IDLE (double-sampled CPU) and holding RAM under danger is a stale orphan — safe to reclaim
# (Etan/weaver 2026-06-14: "if a stale/idle embedder backfill is holding RAM, reclaim it; else
# throttle"). NOTE: job-only names — `bge-large` is intentionally NOT here (a bge-large *daemon*
# stays booted via the protected list; only the backfill *job* is reclaimable).
HEAVY_ML_EMBEDDER_PATTERN="${HEAVY_ML_EMBEDDER_PATTERN:-reembed|embed_backfill|embed-backfill|embed_pending|embed_backlog}"
HEAVY_ML_EMBEDDER_RECLAIM_GB="${HEAVY_ML_EMBEDDER_RECLAIM_GB:-2}"
HEAVY_ML_IDLE_CPU_PCT="${HEAVY_ML_IDLE_CPU_PCT:-5}"            # <= this %CPU on BOTH samples = idle
HEAVY_ML_IDLE_SAMPLE_SLEEP="${HEAVY_ML_IDLE_SAMPLE_SLEEP:-2}" # gap between the two CPU samples

# NEVER autokill these — day-to-day DAEMONS that must "stay booted" (Etan: nothing quits
# unexpectedly): Wispr STT, the voice LLM (mlx_lm.server), ollama, and a bge-large embedder
# daemon. Anchored to real daemon names (a bare `embed` substring was dropped — it both
# over-protected runaways whose path merely contained "embed" AND collided with the backfill
# reclaim pattern). A transient backfill JOB is handled by the seat + stale-reclaim path.
HEAVY_ML_PROTECTED_PATTERN="${HEAVY_ML_PROTECTED_PATTERN:-whisper-server|mlx_lm\.server|ollama|bge-large}"
# The RAM-seat holder is the ONE legit heavy job and is never killed. Pinned to a FIXED absolute
# path (NOT TMPDIR, which can differ between launchd's gui domain and an interactive shell — a
# mismatch would make the guardian blind to the seat and risk killing the seated legit job).
# ram-seat.sh defaults to the same path; the plist also pins it.
RAM_SEAT_HOLD="${RAM_SEAT_HOLD:-$HOME/.local/state/clx-guard/ram-seat/holder}"

# Process command must match one of these to count as heavy-ML. python is gated by RSS.
HEAVY_ML_PATTERN="${HEAVY_ML_PATTERN:-llama-server|ollama|whisper-server|[Mm]lx|[Pp]ython}"
HEAVY_ML_DANGER_STATE_WRITABLE=1

log() { printf '[heavy-ml-guardian] %s\n' "$*" >&2; }

validate_danger_state_dir() {
  local probe="$HEAVY_ML_DANGER_STATE_DIR/.write-test"
  if ! mkdir -p "$HEAVY_ML_DANGER_STATE_DIR" 2>/dev/null ||
     ! ( : > "$probe" ) 2>/dev/null; then
    HEAVY_ML_DANGER_STATE_WRITABLE=0
    log "WARNING: sustained breach state directory is not writable: $HEAVY_ML_DANGER_STATE_DIR; wired_high/swap_high counters cannot be persisted"
    return 0
  fi
  rm -f "$probe" 2>/dev/null || true
}

validate_danger_state_dir

ps_source() {
  if [[ -n "${HEAVY_ML_PS_FIXTURE:-}" ]]; then
    cat "$HEAVY_ML_PS_FIXTURE"
  else
    # pid rss(KB) command...
    ps -axo pid=,rss=,command=
  fi
}

now_epoch() { echo "${HEAVY_ML_NOW_EPOCH:-$(date +%s)}"; }

# Returns matched heavy-ML procs as TSV lines: pid<TAB>rss_kb<TAB>shortname
heavy_procs() {
  local min_kb
  min_kb="$(awk -v g="$HEAVY_ML_MIN_GB" 'BEGIN { printf "%.0f", g * 1024 * 1024 }')"
  ps_source | awk -v min_kb="$min_kb" -v pat="$HEAVY_ML_PATTERN" '
    {
      pid = $1; rss = $2;
      cmd = $0;
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", cmd);
      if (rss + 0 >= min_kb && cmd ~ pat) {
        name = cmd; sub(/[[:space:]].*/, "", name);
        printf "%s\t%s\t%s\n", pid, rss, name;
      }
    }'
}

vmstat_output() {
  if [[ -n "${HEAVY_ML_VMSTAT_FIXTURE:-}" ]]; then
    cat "$HEAVY_ML_VMSTAT_FIXTURE" 2>/dev/null || true
  else
    vm_stat 2>/dev/null || true
  fi
}

vmstat_pagesize() {
  local out="$1" pagesize
  pagesize="$(printf '%s\n' "$out" | awk '/page size of/ { for (i=1;i<=NF;i++) if ($i=="of") { print $(i+1); exit } }')"
  pagesize="$(printf '%s' "$pagesize" | tr -cd '0-9')"
  if [[ -z "$pagesize" ]]; then
    pagesize="$(sysctl -n vm.pagesize 2>/dev/null || true)"
  fi
  pagesize="${pagesize:-16384}"
  printf '%s\n' "$pagesize"
}

# Real page size from vm_stat header (Apple Silicon is 16384, NOT 4096 — the cmux
# sampler/watchdog hardcode 4096 and under-report compressor 4x).
vmstat_compressor_gb() {
  local out pages pagesize
  out="$(vmstat_output)"
  pagesize="$(vmstat_pagesize "$out")"
  pages="$(printf '%s\n' "$out" | awk '/Pages occupied by compressor/ { gsub(/\./,"",$NF); print $NF }')"
  pages="${pages:-0}"
  awk -v p="$pages" -v ps="$pagesize" 'BEGIN { printf "%.2f", p * ps / (1024 * 1024 * 1024) }'
}

vmstat_wired_gb() {
  local out pages pagesize
  out="$(vmstat_output)"
  pagesize="$(vmstat_pagesize "$out")"
  pages="$(printf '%s\n' "$out" | awk '/Pages wired down/ { gsub(/\./,"",$NF); print $NF }')"
  pages="${pages:-0}"
  awk -v p="$pages" -v ps="$pagesize" 'BEGIN { printf "%.2f", p * ps / (1024 * 1024 * 1024) }'
}

# free system memory %, from `memory_pressure` (or a fixture). Echoes an integer.
free_ram_pct() {
  local out
  if [[ -n "${HEAVY_ML_MEMPRESSURE_FIXTURE:-}" ]]; then
    out="$(cat "$HEAVY_ML_MEMPRESSURE_FIXTURE" 2>/dev/null || true)"
  else
    out="$(memory_pressure 2>/dev/null || true)"
  fi
  printf '%s\n' "$out" | awk '
    /free percentage/ {
      for (i=1;i<=NF;i++) if ($i ~ /%/) { gsub(/%/,"",$i); print int($i); found=1; exit }
    }
    END { if (!found) print 0 }
  '
}

# swap used %, from `sysctl vm.swapusage` (or a fixture). Echoes an integer (0 if no swap).
swap_used_pct() {
  local out
  if [[ -n "${HEAVY_ML_SWAP_FIXTURE:-}" ]]; then
    out="$(cat "$HEAVY_ML_SWAP_FIXTURE")"
  else
    out="$(sysctl vm.swapusage 2>/dev/null || true)"
  fi
  printf '%s\n' "$out" | awk '
    { total=0; used=0;
      for (i=1;i<=NF;i++) {
        if ($i=="total") { v=$(i+2); gsub(/M/,"",v); total=v }
        if ($i=="used")  { v=$(i+2); gsub(/M/,"",v); used=v }
      }
      if (total+0 > 0) printf "%d\n", (used/total)*100; else print 0
    }'
}

total_ram_gb() {
  if [[ -n "$HEAVY_ML_TOTAL_RAM_GB" ]]; then
    printf '%.2f\n' "$HEAVY_ML_TOTAL_RAM_GB"
    return 0
  fi
  local bytes
  bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
  bytes="${bytes:-0}"
  awk -v b="$bytes" 'BEGIN { printf "%.2f", b / (1024 * 1024 * 1024) }'
}

free_ram_gb() {
  local pct="$1" total
  total="$(total_ram_gb)"
  awk -v p="$pct" -v t="$total" 'BEGIN { printf "%.2f", t * p / 100 }'
}

used_ram_gb() {
  local pct="$1" total
  total="$(total_ram_gb)"
  awk -v p="$pct" -v t="$total" 'BEGIN { printf "%.2f", t - (t * p / 100) }'
}

threshold_summary() {
  printf 'free<%s%% swap>%s%% wired>%sGB compressor>%sGB aggregate>%sGB runaway>=%sGB' \
    "$HEAVY_ML_FREE_RAM_DANGER_PCT" "$HEAVY_ML_SWAP_DANGER_PCT" \
    "$HEAVY_ML_WIRED_DANGER_GB" "$HEAVY_ML_COMPRESSOR_DANGER_GB" \
    "$HEAVY_ML_AGG_DANGER_GB" "$HEAVY_ML_RUNAWAY_GB"
}

sustained_breach() {
  local name="$1" breached="$2" file count
  mkdir -p "$HEAVY_ML_DANGER_STATE_DIR" 2>/dev/null || true
  file="$HEAVY_ML_DANGER_STATE_DIR/${name}.count"
  if [[ "$HEAVY_ML_DANGER_STATE_WRITABLE" != "1" && ! -e "$file" ]]; then
    return 1
  fi
  count="$(cat "$file" 2>/dev/null || echo 0)"
  count="${count:-0}"
  if [[ "$breached" == "1" ]]; then
    count=$(( count + 1 ))
  else
    count=0
  fi
  ( printf '%s\n' "$count" > "$file" ) 2>/dev/null || return 1
  (( count >= HEAVY_ML_SUSTAINED_BREACH_TICKS ))
}

# pid %cpu rss(KB) command — used by stale_embedder_reclaim (needs %CPU). Fixture-able.
ps_cpu_source() {
  if [[ -n "${HEAVY_ML_PS_CPU_FIXTURE:-}" ]]; then
    cat "$HEAVY_ML_PS_CPU_FIXTURE"
  else
    ps -axo pid=,%cpu=,rss=,command=
  fi
}

# Reclaim STALE (idle) embedder/backfill procs under danger. Double-samples %CPU so an
# embedder that is merely between batches (briefly 0%) is NOT killed — only one idle on BOTH
# samples. Never touches the voice daemons (they don't match the embedder pattern) or the
# RAM-seat holder. Every reclaim announced. This is the "reclaim stale embedder, else throttle"
# rule, done safely.
stale_embedder_reclaim() {
  local reclaim_kb seat_pid cand pid cpu rss name cpu2 gb
  reclaim_kb="$(awk -v g="$HEAVY_ML_EMBEDDER_RECLAIM_GB" 'BEGIN { printf "%.0f", g * 1024 * 1024 }')"
  seat_pid="$(seat_holder_pid)"
  # first sample: embedder-pattern, >= reclaim floor, idle, not seat-held, not a voice daemon
  cand="$(ps_cpu_source | awk -v min="$reclaim_kb" -v epat="$HEAVY_ML_EMBEDDER_PATTERN" \
            -v idle="$HEAVY_ML_IDLE_CPU_PCT" -v seat="${seat_pid:-0}" -v vpat="whisper-server|mlx_lm\\.server" '
    {
      pid=$1; cpu=$2; rss=$3; cmd=$0;
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9.]+[[:space:]]+[0-9]+[[:space:]]+/, "", cmd);
      if (rss+0 >= min && cmd ~ epat && cmd !~ vpat && cpu+0 <= idle && pid != seat) {
        name=cmd; sub(/[[:space:]].*/,"",name); printf "%s\t%s\t%s\n", pid, rss, name;
      }
    }')"
  [[ -n "$cand" ]] || return 0
  sleep "$HEAVY_ML_IDLE_SAMPLE_SLEEP"   # second sample window — confirm still idle
  while IFS=$'\t' read -r pid rss name; do
    [[ -n "$pid" ]] || continue
    # M4: re-read the seat IMMEDIATELY before any kill — a job may have acquired the seat after
    # the first snapshot. Never kill the (now) seated legit job.
    if is_seat_protected "$pid"; then
      log "embedder pid=$pid is the seat holder / in its group — SPARED (legit, never break work)"
      continue
    fi
    # M2: distinguish "PID gone" (empty row) from a real idle 0.0 — a vanished PID must NOT be
    # TERMed (PIDs recycle; we could hit an unrelated process).
    cpu2="$(ps_cpu_source | awk -v p="$pid" '$1==p { print $2; exit }')"
    if [[ -z "$cpu2" ]]; then
      log "embedder pid=$pid vanished between samples — nothing to reclaim (skip)"
      continue
    fi
    if awk -v c="$cpu2" -v idle="$HEAVY_ML_IDLE_CPU_PCT" 'BEGIN { exit !(c+0 <= idle) }'; then
      gb="$(awk -v k="$rss" 'BEGIN { printf "%.1f", k / 1048576 }')"
      log "RECLAIM stale embedder pid=$pid name=$name rss=${gb}GB (idle x2, non-seat, under RAM danger) — TERM"
      emit_clx "reclaim_stale_embedder:pid$pid:$name:${gb}GB" "1" "$gb" "$(vmstat_compressor_gb)" "killed"
      "$HEAVY_ML_KILL_BIN" -TERM "$pid" 2>/dev/null || true
    else
      log "embedder pid=$pid resumed work (cpu=$cpu2%) between samples — SPARED (legit, never break work)"
    fi
  done <<<"$cand"
  return 0
}

# echo 1 if the sampler file has a fresh trailing ts, else 0
sampler_fresh() {
  [[ -f "$HEAVY_ML_SAMPLE_FILE" ]] || { echo 0; return; }
  local last_ts last_epoch now age
  last_ts="$(tail -1 "$HEAVY_ML_SAMPLE_FILE" 2>/dev/null | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')"
  [[ -n "$last_ts" ]] || { echo 0; return; }
  last_epoch="$(date -j -f '%Y-%m-%dT%H:%M:%S%z' "$last_ts" '+%s' 2>/dev/null || echo 0)"
  now="$(now_epoch)"
  age=$(( now - last_epoch ))
  if (( last_epoch > 0 && age <= HEAVY_ML_SAMPLER_STALE_SECONDS )); then echo 1; else echo 0; fi
}

emit_clx() {
  local tripped="$1" count="$2" total_gb="$3" comp_gb="$4" action="${5:-alert-only}"
  [[ -n "$HEAVY_ML_CLX_CLI" ]] || return 0
  local payload free_pct swap_pct wired_gb free_gb used_gb thresholds message
  free_pct="$(free_ram_pct)"; free_pct="${free_pct:-0}"
  swap_pct="$(swap_used_pct)"; swap_pct="${swap_pct:-0}"
  wired_gb="$(vmstat_wired_gb)"
  free_gb="$(free_ram_gb "$free_pct")"
  used_gb="$(used_ram_gb "$free_pct")"
  thresholds="$(threshold_summary)"
  message="free ${free_gb} GB / used ${used_gb} GB (threshold ${thresholds}, action: ${action})"
  payload="$(jq -cn \
    --arg t "$tripped" \
    --argjson c "${count:-0}" \
    --arg g "$total_gb" \
    --arg comp "$comp_gb" \
    --arg wired "$wired_gb" \
    --argjson free_pct "${free_pct:-0}" \
    --argjson swap_pct "${swap_pct:-0}" \
    --arg free_gb "$free_gb" \
    --arg used_gb "$used_gb" \
    --arg thresholds "$thresholds" \
    --arg action "$action" \
    --arg message "$message" \
    '{tripped:$t,heavy_ml_count:$c,heavy_ml_total_gb:($g|tonumber),compressor_gb:($comp|tonumber),wired_gb:($wired|tonumber),free_ram_pct:$free_pct,swap_pct:$swap_pct,free_ram_gb:($free_gb|tonumber),used_ram_gb:($used_gb|tonumber),threshold:$thresholds,action:$action,message:$message}' 2>/dev/null)" || return 0
  # shellcheck disable=SC2086
  $HEAVY_ML_CLX_CLI emit local.ram.guard "$payload" >/dev/null 2>&1 || log "clx emit failed (degrading loud): $HEAVY_ML_CLX_CLI"
}

seat_holder_pid() { cat "$RAM_SEAT_HOLD/pid" 2>/dev/null || true; }
seat_holder_pgid() { cat "$RAM_SEAT_HOLD/pgid" 2>/dev/null || true; }
proc_pgid() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }

# True if pid is the seated workload OR a member of its process group. ram-seat.sh records the
# WORKLOAD child's pid+pgid (not the wrapper), so the heavy proc that shows up in `ps` and its
# worker subtree are both recognized and spared. Returns 1 (not protected) when no seat is held.
is_seat_protected() {
  local pid="$1" spid spgid ppgid
  spid="$(seat_holder_pid)"
  [[ -n "$spid" && "$pid" == "$spid" ]] && return 0
  spgid="$(seat_holder_pgid)"
  if [[ -n "$spgid" ]]; then
    ppgid="$(proc_pgid "$pid")"
    [[ -n "$ppgid" && "$ppgid" == "$spgid" ]] && return 0
  fi
  return 1
}

# Autokill TRUE RUNAWAYS ONLY (Etan: autokill yes, but never legit work, never an
# unexpected quit). A runaway = a heavy-ML proc that is ALL of:
#   - at/above HEAVY_ML_RUNAWAY_GB (pathologically large), AND
#   - NOT on the protected list (Wispr/voice/ollama/embedder stay booted), AND
#   - NOT the RAM-seat holder (the one legit heavy job), AND
#   - the system is in REAL danger (compressor or aggregate over threshold — passed in).
# Legit work that uses the seat, and day-to-day holders, are NEVER touched. Every kill is
# announced through clx — never silent.
autokill_runaways() {
  local runaway_kb seat_pid cand pid rss name gb survivors=""
  runaway_kb="$(awk -v g="$HEAVY_ML_RUNAWAY_GB" 'BEGIN { printf "%.0f", g * 1024 * 1024 }')"
  seat_pid="$(seat_holder_pid)"
  cand="$(ps_source | awk -v min="$runaway_kb" -v pat="$HEAVY_ML_PATTERN" -v prot="$HEAVY_ML_PROTECTED_PATTERN" -v seat="${seat_pid:-0}" '
    {
      pid = $1; rss = $2; cmd = $0;
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "", cmd);
      if (rss + 0 >= min && cmd ~ pat && cmd !~ prot && pid != seat) {
        name = cmd; sub(/[[:space:]].*/, "", name);
        printf "%s\t%s\t%s\n", pid, rss, name;
      }
    }')"
  if [[ -z "$cand" ]]; then
    log "danger but NO true runaway — every heavy proc is protected or the seat holder. Alert-only, nothing killed (never an unexpected quit)."
    return 0
  fi
  while IFS=$'\t' read -r pid rss name; do
    [[ -n "$pid" ]] || continue
    # M4: re-read the seat right before the kill — never TERM a job that just acquired it.
    if is_seat_protected "$pid"; then
      log "runaway pid=$pid is the seat holder / in its group — SPARED (legit)"
      continue
    fi
    gb="$(awk -v k="$rss" 'BEGIN { printf "%.1f", k / 1048576 }')"
    log "AUTOKILL runaway pid=$pid name=$name rss=${gb}GB (>=${HEAVY_ML_RUNAWAY_GB}GB, non-protected, non-seat, system in danger) — TERM"
    emit_clx "autokill_runaway:pid$pid:$name:${gb}GB" "1" "$gb" "$(vmstat_compressor_gb)" "killed"
    "$HEAVY_ML_KILL_BIN" -TERM "$pid" 2>/dev/null || true
    survivors="${survivors}${pid} "
  done <<<"$cand"
  # grace, then KILL any that ignored TERM (re-checking the seat once more, fail-safe)
  sleep "$HEAVY_ML_TERM_GRACE_SECONDS"
  for pid in $survivors; do
    is_seat_protected "$pid" && continue
    if "$HEAVY_ML_KILL_BIN" -0 "$pid" 2>/dev/null; then
      log "AUTOKILL pid=$pid survived TERM — KILL"
      "$HEAVY_ML_KILL_BIN" -KILL "$pid" 2>/dev/null || true
    fi
  done
}

run_once() {
  local ts procs count total_kb total_gb fresh comp_gb wired_gb wired_high=0 free_pct swap_pct tripped="" danger=0 wired_breached=0 swap_breached=0
  ts="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  procs="$(heavy_procs || true)"
  count="$(printf '%s' "$procs" | awk 'NF' | wc -l | tr -d ' ')"
  total_kb="$(printf '%s\n' "$procs" | awk -F'\t' '{ s += $2 } END { printf "%.0f", s + 0 }')"
  total_gb="$(awk -v k="${total_kb:-0}" 'BEGIN { printf "%.2f", k / (1024 * 1024) }')"
  fresh="$(sampler_fresh)"
  comp_gb="$(vmstat_compressor_gb)"
  wired_gb="$(vmstat_wired_gb)"
  free_pct="$(free_ram_pct)"; free_pct="${free_pct:-0}"
  swap_pct="$(swap_used_pct)"; swap_pct="${swap_pct:-0}"

  (( count > HEAVY_ML_MUTEX_MAX_SLOTS )) && tripped="${tripped}${tripped:+,}heavy_ml_mutex"
  if awk -v a="$total_gb" -v d="$HEAVY_ML_AGG_DANGER_GB" 'BEGIN { exit !(a > d) }'; then tripped="${tripped}${tripped:+,}heavy_ml_aggregate"; danger=1; fi
  if awk -v c="$comp_gb" -v d="$HEAVY_ML_COMPRESSOR_DANGER_GB" 'BEGIN { exit !(c > d) }'; then tripped="${tripped}${tripped:+,}compressor"; danger=1; fi
  if awk -v w="$wired_gb" -v d="$HEAVY_ML_WIRED_DANGER_GB" 'BEGIN { exit !(w > d) }'; then wired_breached=1; fi
  if sustained_breach "wired_high" "$wired_breached"; then tripped="${tripped}${tripped:+,}wired_high"; wired_high=1; fi
  if (( free_pct < HEAVY_ML_FREE_RAM_DANGER_PCT )); then tripped="${tripped}${tripped:+,}low_free_ram"; danger=1; fi
  if (( swap_pct > HEAVY_ML_SWAP_DANGER_PCT )); then swap_breached=1; fi
  if sustained_breach "swap_high" "$swap_breached"; then tripped="${tripped}${tripped:+,}swap_high"; danger=1; fi
  [[ "$fresh" == "1" ]] || tripped="${tripped}${tripped:+,}sampler_stale"

  printf '{"ts":"%s","heavy_ml_count":%s,"heavy_ml_total_gb":%s,"sampler_fresh":%s,"compressor_gb":%s,"wired_gb":%s,"wired_high":%s,"free_ram_pct":%s,"swap_pct":%s,"tripped":"%s"}\n' \
    "$ts" "${count:-0}" "${total_gb:-0}" "${fresh:-0}" "${comp_gb:-0}" "${wired_gb:-0}" "$wired_high" "${free_pct}" "${swap_pct}" "$tripped"

  if [[ -n "$tripped" ]]; then
    log "TRIPPED: $tripped (free $(free_ram_gb "$free_pct") GB / used $(used_ram_gb "$free_pct") GB, threshold $(threshold_summary), action: alert-only; heavy_ml_count=$count total=${total_gb}GB compressor=${comp_gb}GB wired=${wired_gb}GB free_ram=${free_pct}% swap=${swap_pct}% sampler_fresh=$fresh)"
    [[ -n "$procs" ]] && { log "heavy-ML procs (pid/rss_kb/name):"; printf '%s\n' "$procs" >&2; }
    emit_clx "$tripped" "$count" "$total_gb" "$comp_gb" "alert-only"
    # Under REAL memory danger (compressor/aggregate/low-free-RAM/swap-high — NOT a bare
    # mutex/stale signal): first reclaim STALE idle embedders (safe, double-sampled), then
    # autokill TRUE runaways. Both protect legit work, the seat holder, and voice daemons.
    if [[ "$HEAVY_ML_GUARD_ENABLE_KILL" == "1" && "$danger" == "1" ]]; then
      stale_embedder_reclaim
      autokill_runaways
    fi
  fi
}

if [[ "${HEAVY_ML_GUARDIAN_SOURCE_ONLY:-0}" != "1" ]]; then
  run_once
fi
