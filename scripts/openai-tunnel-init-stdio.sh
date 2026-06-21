#!/usr/bin/env bash
set -euo pipefail

# openai-tunnel-init-stdio.sh
#
# Description:
#   Initialize the tunnel-client profile for stdio MCP connection.
#   This creates a profile that connects ChatGPT through the OpenAI Secure MCP Tunnel
#   to the local ChatGPTMCPcmux MCP server running over stdio.
#
# Usage:
#   ./openai-tunnel-init-stdio.sh
#
# Required environment variables:
#   CONTROL_PLANE_API_KEY    - Your OpenAI Secure MCP Tunnel API key
#   CONTROL_PLANE_TUNNEL_ID  - Your assigned tunnel ID from the OpenAI control plane
#
# Optional environment variables:
#   OPENAI_TUNNEL_PROFILE         - Profile name (default: "chatgpt-mcp-cmux-local")
#   CHATGPT_MCP_CMUX_POLICY       - Path to policy.yaml (default: "$HOME/.config/chatgpt-mcp-cmux/policy.yaml")
#   CHATGPT_MCP_CMUX_REPO         - Path to ChatGPTMCPcmux repo (default: "$HOME/Documents/GitHub/ChatGPTMCPcmux")
# ------------------------------------------------------------------------------

# --- Validate required environment variables ---
: "${CONTROL_PLANE_API_KEY:?Error: CONTROL_PLANE_API_KEY environment variable is required}"
: "${CONTROL_PLANE_TUNNEL_ID:?Error: CONTROL_PLANE_TUNNEL_ID environment variable is required}"

# --- Optional environment variables with defaults ---
PROFILE="${OPENAI_TUNNEL_PROFILE:-chatgpt-mcp-cmux-local}"
POLICY_PATH="${CHATGPT_MCP_CMUX_POLICY:-$HOME/.config/chatgpt-mcp-cmux/policy.yaml}"
REPO_PATH="${CHATGPT_MCP_CMUX_REPO:-$HOME/Documents/GitHub/ChatGPTMCPcmux}"

# --- Build the MCP command ---
MCP_COMMAND="node $REPO_PATH/dist/index.js stdio --config $POLICY_PATH"

# --- Validate paths exist ---
if [[ ! -d "$REPO_PATH" ]]; then
    echo "WARNING: Repo path does not exist: $REPO_PATH" >&2
fi

if [[ ! -f "$POLICY_PATH" ]]; then
    echo "WARNING: Policy file does not exist: $POLICY_PATH" >&2
fi

# --- Run tunnel-client init ---
echo "========================================"
echo "OpenAI Tunnel Init (stdio MCP)"
echo "========================================"
echo ""
echo "Profile:     $PROFILE"
echo "Tunnel ID:   $CONTROL_PLANE_TUNNEL_ID"
echo "Policy:      $POLICY_PATH"
echo "Repo:        $REPO_PATH"
echo "MCP Command: $MCP_COMMAND"
echo ""

tunnel-client init \
    --sample sample_mcp_stdio_local \
    --profile "$PROFILE" \
    --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
    --mcp-command "$MCP_COMMAND"

echo ""
echo "========================================"
echo "SUCCESS: Tunnel profile initialized."
echo "========================================"
echo "Profile:     $PROFILE"
echo "MCP Command: $MCP_COMMAND"
echo ""
echo "Next steps:"
echo "  1. Review the generated profile if needed."
echo "  2. Run: ./scripts/openai-tunnel-doctor.sh to verify connectivity."
echo "  3. Run: ./scripts/openai-tunnel-run.sh to start the tunnel."
