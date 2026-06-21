#!/usr/bin/env bash
set -euo pipefail

# openai-tunnel-run.sh
#
# Description:
#   Run the tunnel-client to establish the OpenAI Secure MCP Tunnel.
#   This connects your local ChatGPTMCPcmux MCP server to ChatGPT via stdio.
#
# Usage:
#   ./openai-tunnel-run.sh
#
# Required environment variables:
#   CONTROL_PLANE_API_KEY    - Your OpenAI Secure MCP Tunnel API key
#   CONTROL_PLANE_TUNNEL_ID  - Your assigned tunnel ID from the OpenAI control plane
#
# Optional environment variables:
#   OPENAI_TUNNEL_PROFILE  - Profile name (default: "chatgpt-mcp-cmux-local")
# ------------------------------------------------------------------------------

PROFILE="${OPENAI_TUNNEL_PROFILE:-chatgpt-mcp-cmux-local}"

# --- Validate that tunnel-client is installed ---
if ! command -v tunnel-client &>/dev/null; then
    echo "ERROR: tunnel-client is not installed or not in PATH." >&2
    echo "" >&2
    echo "Install with:" >&2
    echo "  npm install -g @openai/tunnel-client" >&2
    exit 1
fi

# --- Validate required credentials ---
: "${CONTROL_PLANE_API_KEY:?Error: CONTROL_PLANE_API_KEY environment variable is required}"
: "${CONTROL_PLANE_TUNNEL_ID:?Error: CONTROL_PLANE_TUNNEL_ID environment variable is required}"

# --- Set up signal traps for clean shutdown ---
cleanup() {
    echo ""
    echo "========================================"
    echo "Tunnel shutdown requested. Cleaning up..."
    echo "========================================"
    # Give the tunnel-client a moment to handle its own cleanup
    sleep 0.5
    echo "Done. Tunnel client stopped."
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "========================================"
echo "OpenAI Tunnel Run (stdio MCP)"
echo "========================================"
echo "Profile:     $PROFILE"
echo "Tunnel ID:   $CONTROL_PLANE_TUNNEL_ID"
echo ""
echo "Starting tunnel-client..."
echo "Press Ctrl+C to stop."
echo "========================================"
echo ""

# --- Run tunnel-client ---
exec tunnel-client run --profile "$PROFILE"
