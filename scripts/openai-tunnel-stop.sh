#!/usr/bin/env bash
set -euo pipefail

# openai-tunnel-stop.sh
#
# Description:
#   Stop the tunnel-client process for the given profile.
#   Uses pkill to match processes running tunnel-client with the specified profile.
#   Safe to run even if the tunnel is not currently running.
#
# Usage:
#   ./openai-tunnel-stop.sh
#
# Required environment variables:
#   (none)
#
# Optional environment variables:
#   OPENAI_TUNNEL_PROFILE  - Profile name (default: "chatgpt-mcp-cmux-local")
# ------------------------------------------------------------------------------

PROFILE="${OPENAI_TUNNEL_PROFILE:-chatgpt-mcp-cmux-local}"

echo "========================================"
echo "OpenAI Tunnel Stop"
echo "========================================"
echo "Profile: $PROFILE"
echo ""

# --- Find and kill tunnel-client processes matching the profile ---
PIDS=$(pgrep -f "tunnel-client.*$PROFILE" 2>/dev/null || true)

if [[ -z "$PIDS" ]]; then
    echo "No tunnel-client process found for profile '$PROFILE'."
    echo "Tunnel is not running."
    exit 0
fi

echo "Found tunnel-client process(es): $PIDS"

# Use pkill with || true to avoid failure if process exits between pgrep and pkill
pkill -f "tunnel-client.*$PROFILE" 2>/dev/null || true

# Brief wait then verify
sleep 0.5
REMAINING=$(pgrep -f "tunnel-client.*$PROFILE" 2>/dev/null || true)

if [[ -z "$REMAINING" ]]; then
    echo ""
    echo "========================================"
    echo "SUCCESS: Tunnel stopped for profile '$PROFILE'."
    echo "========================================"
else
    echo ""
    echo "WARNING: Some processes may still be running: $REMAINING"
    echo "You may need to kill them manually with: kill -9 $REMAINING"
fi
