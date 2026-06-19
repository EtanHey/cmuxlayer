#!/usr/bin/env bash
# cmuxlayer MCP orphan reaper
#
# What it kills:
#   Only node MCP server processes selected by src/mcp-reaper.ts where all gates
#   pass: argv matches a tight MCP server pattern or allowlist, ppid == 1, and
#   elapsed age >= REAPER_MIN_AGE_SECONDS (default 600).
#
# Dry-run default:
#   This wrapper sends no signals unless you pass --execute or set
#   REAPER_DRY_RUN=0. Dry-run logs what WOULD be killed.
#
# Usage:
#   scripts/mcp-orphan-reaper.sh
#   scripts/mcp-orphan-reaper.sh --execute
#   REAPER_MIN_AGE_SECONDS=1800 REAPER_DRY_RUN=0 scripts/mcp-orphan-reaper.sh
#
# launchd install:
#   1. Run `bun run build` so dist/mcp-reaper.js exists.
#   2. Copy scripts/com.cmuxlayer.mcp-reaper.plist to ~/Library/LaunchAgents/.
#   3. Edit the ProgramArguments path if this checkout is not
#      /Users/etanheyman/Gits/cmuxlayer/scripts/mcp-orphan-reaper.sh.
#   4. Run:
#      launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cmuxlayer.mcp-reaper.plist
#
# This is a standalone process cleanup tool. It does not alter cmuxlayer agent
# lifecycle or orphan-survival behavior.

set -euo pipefail

launchd_safe_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [[ -n "${PATH:-}" ]]; then
  export PATH="${launchd_safe_path}:${PATH}"
else
  export PATH="${launchd_safe_path}"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
dist_cli="${repo_dir}/dist/mcp-reaper.js"
src_cli="${repo_dir}/src/mcp-reaper.ts"
local_tsx="${repo_dir}/node_modules/.bin/tsx"
node_bin="$(command -v node || true)"

if [[ -z "${node_bin}" ]]; then
  printf '%s\n' "node is required but was not found on PATH: ${PATH}" >&2
  exit 1
fi

if [[ -f "${dist_cli}" ]]; then
  exec "${node_bin}" "${dist_cli}" "$@"
fi

if [[ -x "${local_tsx}" ]]; then
  exec "${local_tsx}" "${src_cli}" "$@"
fi

printf '%s\n' "dist/mcp-reaper.js is missing and node_modules/.bin/tsx is unavailable." >&2
printf '%s\n' "Run bun install and bun run build before installing the launchd job." >&2
exit 1
