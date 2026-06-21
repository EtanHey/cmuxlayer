#!/usr/bin/env bash
set -euo pipefail

log_path="${CMUX_CAFFEINATE_LOG:-$HOME/.local/state/cmux/cmux-caffeinate.log}"
flags="${CMUX_CAFFEINATE_FLAGS:--dis}"

mkdir -p "$(dirname "$log_path")"
printf '%s starting pid=%s flags=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$" "$flags" >>"$log_path"

exec caffeinate $flags
