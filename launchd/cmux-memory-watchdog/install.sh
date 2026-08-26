#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PLIST="$ROOT_DIR/launchd/com.golems.cmux-memory-watchdog.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/com.golems.cmux-memory-watchdog.plist"
SCRIPT_PATH="$ROOT_DIR/bin/cmux-memory-watchdog.sh"
LOG_DIR="$HOME/Library/Logs/cmux-watchdog"
MODE="${1:---dry-run}"

case "$MODE" in
  --dry-run|--install) ;;
  *) echo "usage: install.sh [--dry-run|--install]" >&2; exit 2 ;;
esac

sed_escape() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

render_plist() {
  local script_path log_dir
  script_path="$(sed_escape "$SCRIPT_PATH")"
  log_dir="$(sed_escape "$LOG_DIR")"
  sed \
    -e "s|/Users/etanheyman/Gits/cmuxlayer/launchd/cmux-memory-watchdog/bin/cmux-memory-watchdog.sh|$script_path|g" \
    -e "s|/Users/etanheyman/Library/Logs/cmux-watchdog|$log_dir|g" \
    "$SOURCE_PLIST"
}

if [ "$MODE" = "--dry-run" ]; then
  render_plist
  exit 0
fi

mkdir -p "$(dirname "$TARGET_PLIST")" "$LOG_DIR"
staged="$(mktemp "$TARGET_PLIST.XXXXXX")"
trap 'rm -f "$staged"' EXIT
render_plist > "$staged"
plutil -lint "$staged" >/dev/null
mv "$staged" "$TARGET_PLIST"
trap - EXIT

launchctl bootout "gui/$(id -u)" "$TARGET_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST"
echo "installed com.golems.cmux-memory-watchdog from $TARGET_PLIST"
