#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$PACKAGE_DIR/../.." && pwd)"
SOURCE_PLIST="$PACKAGE_DIR/launchd/com.golems.cmux-ram-sampler.plist"
TARGET_PLIST="$HOME/Library/LaunchAgents/com.golems.cmux-ram-sampler.plist"
MODE="${1:---dry-run}"

case "$MODE" in --dry-run|--install) ;; *) echo "usage: install.sh [--dry-run|--install]" >&2; exit 2 ;; esac
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }
render_plist() {
  local line prefix suffix repo home
  repo="$(xml_escape "$REPO_DIR")"; home="$(xml_escape "$HOME")"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      *'@CMUXLAYER_REPO@'*) prefix="${line%%@CMUXLAYER_REPO@*}"; suffix="${line#*@CMUXLAYER_REPO@}"; printf '%s%s%s\n' "$prefix" "$repo" "$suffix" ;;
      *'@CMUXLAYER_HOME@'*) prefix="${line%%@CMUXLAYER_HOME@*}"; suffix="${line#*@CMUXLAYER_HOME@}"; printf '%s%s%s\n' "$prefix" "$home" "$suffix" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$SOURCE_PLIST"
}
if [ "$MODE" = "--dry-run" ]; then render_plist; exit 0; fi
mkdir -p "$(dirname "$TARGET_PLIST")" "$HOME/Library/Logs/cmux-ram-sampler"
staged="$(mktemp "$TARGET_PLIST.XXXXXX")"; trap 'rm -f "$staged"' EXIT
render_plist > "$staged"; /usr/bin/plutil -lint "$staged" >/dev/null; mv "$staged" "$TARGET_PLIST"; trap - EXIT
launchctl bootout "gui/$(id -u)" "$TARGET_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST"
echo "installed com.golems.cmux-ram-sampler from $TARGET_PLIST"
