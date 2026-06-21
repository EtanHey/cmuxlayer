#!/usr/bin/env bash
set -euo pipefail

# emergency-stop.sh
#
# Description:
#   Emergency stop -- kill all tunnel-client, chatgpt-mcp-cmux, and ChatGPTMCPcmux
#   processes. This is a nuclear option for when things are stuck.
#   Always exits 0, even if nothing was running.
#
# Usage:
#   ./emergency-stop.sh
#
# Required environment variables:
#   (none)
#
# Optional environment variables:
#   OPENAI_TUNNEL_PROFILE  - Profile name (default: "chatgpt-mcp-cmux-local")
# ------------------------------------------------------------------------------

PROFILE="${OPENAI_TUNNEL_PROFILE:-chatgpt-mcp-cmux-local}"

KILLED_ANY=false

echo "========================================"
echo "EMERGENCY STOP"
echo "========================================"
echo "Profile: $PROFILE"
echo ""

# --- Kill tunnel-client processes for the profile ---
TUNNEL_PIDS=$(pgrep -f "tunnel-client.*$PROFILE" 2>/dev/null || true)
if [[ -n "$TUNNEL_PIDS" ]]; then
    echo "Killing tunnel-client processes: $TUNNEL_PIDS"
    pkill -f "tunnel-client.*$PROFILE" 2>/dev/null || true
    KILLED_ANY=true
else
    echo "No tunnel-client processes found."
fi

# --- Kill chatgpt-mcp-cmux processes ---
CMUX_PIDS=$(pgrep -f "chatgpt-mcp-cmux" 2>/dev/null || true)
if [[ -n "$CMUX_PIDS" ]]; then
    echo "Killing chatgpt-mcp-cmux processes: $CMUX_PIDS"
    pkill -f "chatgpt-mcp-cmux" 2>/dev/null || true
    KILLED_ANY=true
else
    echo "No chatgpt-mcp-cmux processes found."
fi

# --- Kill ChatGPTMCPcmux processes ---
REPO_PIDS=$(pgrep -f "ChatGPTMCPcmux" 2>/dev/null || true)
if [[ -n "$REPO_PIDS" ]]; then
    echo "Killing ChatGPTMCPcmux processes: $REPO_PIDS"
    pkill -f "ChatGPTMCPcmux" 2>/dev/null || true
    KILLED_ANY=true
else
    echo "No ChatGPTMCPcmux processes found."
fi

echo ""
echo "========================================"
if [[ "$KILLED_ANY" == true ]]; then
    echo "Emergency stop completed. Processes were terminated."
else
    echo "Emergency stop completed. No processes were running."
fi
echo "========================================"

# Always exit 0
exit 0
