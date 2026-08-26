#!/usr/bin/env bash
# Mandatory report after every cmuxlayer brew upgrade. A brew upgrade deletes
# the old versioned Cellar keg; MCP children executing from that keg may die.
# Looking only for old-version children misses the common case where the child
# vanished entirely, so this reports agent CLIs with no cmuxlayer child too.
set -uo pipefail

INSTALLED="$(/opt/homebrew/opt/cmuxlayer/bin/cmuxlayer --version 2>/dev/null | awk '{print $2}')"
echo "installed cmuxlayer: ${INSTALLED:-UNKNOWN}"
echo

PARENTS="$(mktemp)"
trap 'rm -f "$PARENTS"' EXIT

ps -eo pid,ppid,command | grep "Cellar/cmuxlayer" | grep -v grep | while read -r _cpid ppid rest; do
  ver="$(printf '%s' "$rest" | grep -oE 'Cellar/cmuxlayer/[0-9.]+' | cut -d/ -f3)"
  printf '%s\t%s\n' "$ppid" "$ver"
done | sort -u > "$PARENTS"

echo "=== agents WITH a live cmuxlayer child ==="
if [ ! -s "$PARENTS" ]; then
  echo "  (none — the whole fleet is disconnected)"
else
  while IFS=$'\t' read -r ppid ver; do
    cwd="$(lsof -a -p "$ppid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)"
    if [ -n "$INSTALLED" ] && [ "$ver" != "$INSTALLED" ]; then
      echo "  STALE v$ver pid=$ppid $cwd — running a deleted keg; needs reconnect"
    else
      echo "  current v$ver pid=$ppid $cwd"
    fi
  done < "$PARENTS"
fi

echo
echo "=== agents with NO cmuxlayer child (THE ones the naive check misses) ==="
found=0
while read -r pid; do
  [ -n "$pid" ] || continue
  cut -f1 "$PARENTS" | grep -qx "$pid" && continue
  cli="$(ps -p "$pid" -o command= 2>/dev/null | grep -oE 'bin/(claude|codex)' | cut -d/ -f2)"
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-)"
  cfg="?"
  if [ -n "$cwd" ] && [ -f "$cwd/.mcp.json" ]; then
    grep -q cmuxlayer "$cwd/.mcp.json" 2>/dev/null && cfg="configured" || cfg="not-configured"
  fi
  [ "$cfg" = "not-configured" ] && continue
  found=1
  if [ "$cfg" = "?" ]; then
    mark="UNKNOWN (no .mcp.json at cwd — verify before acting)"
  else
    mark="CONFIRMED casualty"
  fi
  if [ "$cli" = "codex" ]; then
    echo "  $mark pid=$pid CODEX $cwd — no /mcp; needs a process restart"
  else
    echo "  $mark pid=$pid claude $cwd — run: /mcp reconnect cmuxlayer"
  fi
done < <(ps -eo pid,command | grep -E "\.local/bin/(claude|codex)( |$)" | grep -v grep | awk '{print $1}')
[ "$found" -eq 0 ] && echo "  (none — every configured seat has a live child)"

cat <<'NOTE'

=== HOW TO VERIFY ===
Process checks are necessary but not sufficient. Re-enumerate current surfaces,
read each Claude pane, and confirm its cmuxlayer tool count is present. Deliver
Claude reconnects with /mcp reconnect cmuxlayer. Codex seats need a process
restart. Resolve surface identities fresh; numeric refs can renumber.
NOTE
