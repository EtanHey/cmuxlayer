#!/usr/bin/env bash
set -euo pipefail

# openai-tunnel-doctor.sh
#
# Description:
#   Run tunnel-client doctor to diagnose connectivity issues with the
#   OpenAI Secure MCP Tunnel. Provides detailed explanations of any problems found.
#
# Usage:
#   ./openai-tunnel-doctor.sh
#
# Required environment variables:
#   (none)
#
# Optional environment variables:
#   OPENAI_TUNNEL_PROFILE  - Profile name (default: "chatgpt-mcp-cmux-local")
# ------------------------------------------------------------------------------

PROFILE="${OPENAI_TUNNEL_PROFILE:-chatgpt-mcp-cmux-local}"

echo "========================================"
echo "OpenAI Tunnel Doctor"
echo "========================================"
echo "Profile: $PROFILE"
echo ""

# --- Check that tunnel-client is available ---
if ! command -v tunnel-client &>/dev/null; then
    echo "ERROR: tunnel-client is not installed or not in PATH." >&2
    echo "" >&2
    echo "To install tunnel-client, run:" >&2
    echo "  npm install -g @openai/tunnel-client" >&2
    echo "" >&2
    echo "Or see the OpenAI documentation for the latest installation instructions." >&2
    exit 1
fi

# --- Run doctor with explain flag ---
set +e
TUNNEL_DOCTOR_OUTPUT=$(tunnel-client doctor --profile "$PROFILE" --explain 2>&1)
TUNNEL_DOCTOR_EXIT_CODE=$?
set -e

echo "$TUNNEL_DOCTOR_OUTPUT"
echo ""

if [[ $TUNNEL_DOCTOR_EXIT_CODE -ne 0 ]]; then
    echo "========================================" >&2
    echo "WARNING: tunnel-client doctor detected issues (exit code: $TUNNEL_DOCTOR_EXIT_CODE)." >&2
    echo "========================================" >&2
    echo "" >&2
    echo "Guidance:" >&2
    echo "  1. Verify CONTROL_PLANE_API_KEY is set and valid." >&2
    echo "  2. Verify CONTROL_PLANE_TUNNEL_ID is correct." >&2
    echo "  3. Check network connectivity to the OpenAI control plane." >&2
    echo "  4. Ensure the tunnel profile was initialized with: ./openai-tunnel-init-stdio.sh" >&2
    echo "  5. Try re-initializing the profile if configuration has changed." >&2
    echo "  6. Review the detailed output above for specific failure reasons." >&2
    echo "" >&2
    exit "$TUNNEL_DOCTOR_EXIT_CODE"
else
    echo "========================================"
    echo "SUCCESS: Tunnel doctor reports no issues."
    echo "========================================"
    echo ""
    echo "Your tunnel profile '$PROFILE' appears correctly configured."
    echo "You can now start the tunnel with: ./scripts/openai-tunnel-run.sh"
fi
