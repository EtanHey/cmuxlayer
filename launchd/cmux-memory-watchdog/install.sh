#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PLIST="$ROOT_DIR/launchd/com.golems.cmux-memory-watchdog.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/com.golems.cmux-memory-watchdog.plist"
SCRIPT_PATH="$ROOT_DIR/bin/cmux-memory-watchdog.sh"
LOG_DIR="$HOME/Library/Logs/cmux-watchdog"
MODE="${1:---dry-run}"
WATCHDOG_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

case "$MODE" in
  --dry-run|--install) ;;
  *) echo "usage: install.sh [--dry-run|--install]" >&2; exit 2 ;;
esac

sed_escape() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

render_plist() {
  local script_path watchdog_home
  script_path="$(sed_escape "$(xml_escape "$SCRIPT_PATH")")"
  watchdog_home="$(sed_escape "$(xml_escape "$HOME")")"
  sed \
    -e "s|@CMUX_WATCHDOG_SCRIPT@|$script_path|g" \
    -e "s|@CMUX_WATCHDOG_HOME@|$watchdog_home|g" \
    "$SOURCE_PLIST"
}

if [ "$MODE" = "--dry-run" ]; then
  render_plist
  exit 0
fi

for dependency in jq socat; do
  PATH="$WATCHDOG_PATH" command -v "$dependency" >/dev/null 2>&1 || {
    echo "install.sh: required dependency not found on launchd PATH: $dependency" >&2
    exit 1
  }
done

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
