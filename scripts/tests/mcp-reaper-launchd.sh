#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
root_dir="$(mktemp -d)"
trap 'rm -rf "$root_dir"' EXIT
rendered="$root_dir/rendered.plist"

HOME="$root_dir/home & operator" bash "$REPO_DIR/scripts/install-mcp-reaper.sh" >"$rendered"
/usr/bin/plutil -lint "$rendered" >/dev/null
grep -F "$REPO_DIR/scripts/mcp-orphan-reaper.sh" "$rendered" >/dev/null
if grep -F '@CMUXLAYER_' "$rendered" >/dev/null; then
  echo "FAIL: MCP reaper installer left template tokens" >&2
  exit 1
fi
if grep -F 'launchctl bootstrap' "$rendered" >/dev/null; then
  echo "FAIL: MCP reaper dry-run performed an install" >&2
  exit 1
fi
printf 'PASS: MCP reaper installer renders and lints its plist\n'
