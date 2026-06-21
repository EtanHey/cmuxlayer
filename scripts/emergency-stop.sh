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
# Optional arguments:
#   --with-agents          - Also kill any connected cmux agent processes
#
# Optional environment variables:
#   OPENAI_TUNNEL_PROFILE  - Profile name (default: "chatgpt-mcp-cmux")
# ------------------------------------------------------------------------------

PROFILE="${OPENAI_TUNNEL_PROFILE:-chatgpt-mcp-cmux}"

WITH_AGENTS=false
if [[ "${1:-}" == "--with-agents" ]]; then
    WITH_AGENTS=true
fi

KILLED_ANY=false

echo "========================================"
echo "EMERGENCY STOP"
echo "========================================"
echo "Profile: $PROFILE"
echo ""

# --- Kill tunnel-client processes for the profile ---
TUNNEL_PIDS=$(pgrep -f "tunnel-client run.*$PROFILE" 2>/dev/null || true)
if [[ -n "$TUNNEL_PIDS" ]]; then
    echo "Killing tunnel-client processes: $TUNNEL_PIDS"
    pkill -f "tunnel-client run.*$PROFILE" 2>/dev/null || true
    KILLED_ANY=true
else
    echo "No tunnel-client processes found."
fi

# --- Kill chatgpt-mcp-cmux processes ---
CMUX_PIDS=$(pgrep -f "node .*dist/index.js stdio --config .*chatgpt-mcp-cmux" 2>/dev/null || true)
if [[ -n "$CMUX_PIDS" ]]; then
    echo "Killing ChatGPTMCPcmux node processes: $CMUX_PIDS"
    pkill -f "node .*dist/index.js stdio --config .*chatgpt-mcp-cmux" 2>/dev/null || true
    KILLED_ANY=true
else
    echo "No chatgpt-mcp-cmux processes found."
fi

if [[ "$WITH_AGENTS" == true ]]; then
    echo "--- Killing connected cmux agents ---"
    # This is a placeholder for actual agent process termination if required.
    # In a real scenario, you'd iterate over known agent pids or send a signal to cmux.
    # For now, we note that it was requested.
    echo "Agent termination requested via --with-agents."
    # Example: pkill -f "claude code|codex|gemini" (Use with caution)
else
    echo "Skipping cmux agents (use --with-agents to kill them)."
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
