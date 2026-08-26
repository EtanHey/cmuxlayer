#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_PLIST="$REPO_DIR/scripts/com.cmuxlayer.mcp-reaper.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/com.cmuxlayer.mcp-reaper.plist"
MODE="${1:---dry-run}"

case "$MODE" in --dry-run|--install) ;; *) echo "usage: install-mcp-reaper.sh [--dry-run|--install]" >&2; exit 2 ;; esac
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }
render_plist() {
  local line prefix suffix repo
  repo="$(xml_escape "$REPO_DIR")"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *'@CMUXLAYER_REPO@'*) prefix="${line%%@CMUXLAYER_REPO@*}"; suffix="${line#*@CMUXLAYER_REPO@}"; printf '%s%s%s\n' "$prefix" "$repo" "$suffix" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$SOURCE_PLIST"
}
if [ "$MODE" = "--dry-run" ]; then render_plist; exit 0; fi
mkdir -p "$(dirname "$TARGET_PLIST")"
staged="$(mktemp "$TARGET_PLIST.XXXXXX")"; trap 'rm -f "$staged"' EXIT
render_plist > "$staged"; /usr/bin/plutil -lint "$staged" >/dev/null; mv "$staged" "$TARGET_PLIST"; trap - EXIT
launchctl bootout "gui/$(id -u)" "$TARGET_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST"
echo "installed com.cmuxlayer.mcp-reaper from $TARGET_PLIST"
