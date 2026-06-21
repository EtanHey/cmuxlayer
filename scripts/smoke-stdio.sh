#!/usr/bin/env bash
set -euo pipefail

# smoke-stdio.sh
#
# Description:
#   Smoke test for the secure stdio MCP server.
#   Validates that the project is built, the policy file exists, and Node.js
#   is available. Optionally performs a minimal JSON-RPC MCP handshake if jq
#   is installed.
#
# Usage:
#   ./smoke-stdio.sh
#
# Required environment variables:
#   (none)
#
# Optional environment variables:
#   CHATGPT_MCP_CMUX_POLICY  - Path to policy.yaml (default: "$HOME/.config/chatgpt-mcp-cmux/policy.yaml")
#   CHATGPT_MCP_CMUX_REPO    - Path to ChatGPTMCPcmux repo (default: "$HOME/Documents/GitHub/ChatGPTMCPcmux")
# ------------------------------------------------------------------------------

POLICY_PATH="${CHATGPT_MCP_CMUX_POLICY:-$HOME/.config/chatgpt-mcp-cmux/policy.yaml}"
REPO_PATH="${CHATGPT_MCP_CMUX_REPO:-$HOME/Documents/GitHub/ChatGPTMCPcmux}"

PASS=0
FAIL=0

check_pass() {
    echo "  [PASS] $1"
    ((PASS++)) || true
}

check_fail() {
    echo "  [FAIL] $1" >&2
    ((FAIL++)) || true
}

echo "========================================"
echo "Smoke Test: ChatGPTMCPcmux (stdio MCP)"
echo "========================================"
echo ""

# --- 1. Check that dist/index.js exists (project is built) ---
echo "--- Build Check ---"
if [[ -f "$REPO_PATH/dist/index.js" ]]; then
    check_pass "dist/index.js exists at $REPO_PATH/dist/index.js"
else
    check_fail "dist/index.js NOT found at $REPO_PATH/dist/index.js"
    echo "  Hint: Run 'npm run build' in $REPO_PATH to build the project." >&2
fi

# --- 2. Check that policy file exists ---
echo ""
echo "--- Policy File Check ---"
if [[ -f "$POLICY_PATH" ]]; then
    check_pass "Policy file exists at $POLICY_PATH"
else
    check_fail "Policy file NOT found at $POLICY_PATH"
    echo "  Hint: Create the policy file or set CHATGPT_MCP_CMUX_POLICY to the correct path." >&2
fi

# --- 3. Verify node is available ---
echo ""
echo "--- Node.js Check ---"
if command -v node &>/dev/null; then
    NODE_VERSION=$(node --version)
    check_pass "Node.js is available: $NODE_VERSION"
else
    check_fail "Node.js is NOT available in PATH"
fi

# --- 4. Print the command that would be run ---
echo ""
echo "--- MCP Command ---"
MCP_COMMAND="node $REPO_PATH/dist/index.js stdio --config $POLICY_PATH"
echo "Command: $MCP_COMMAND"

# --- 5. Optional: jq availability ---
echo ""
echo "--- jq Check ---"
if command -v jq &>/dev/null; then
    JQ_VERSION=$(jq --version)
    check_pass "jq is available: $JQ_VERSION"
    HAVE_JQ=true
else
    check_fail "jq is NOT available (optional -- JSON-RPC test will be skipped)"
    HAVE_JQ=false
fi

# --- 6. Optional JSON-RPC smoke test ---
if [[ "$HAVE_JQ" == true ]]; then
    echo ""
    echo "--- JSON-RPC Smoke Test ---"
    echo "Attempting minimal MCP initialize + tools/list exchange..."
    echo "(This requires the MCP server to respond to stdio JSON-RPC)"

    REQUEST_ID_INIT="smoke-test-init-$$"
    REQUEST_ID_TOOLS="smoke-test-tools-$$"

    # Build the JSON-RPC requests
    INIT_REQUEST=$(jq -n \
        --arg id "$REQUEST_ID_INIT" \
        '{jsonrpc:"2.0",id:$id,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"smoke-stdio",version:"1.0.0"}}}')

    TOOLS_REQUEST=$(jq -n \
        --arg id "$REQUEST_ID_TOOLS" \
        '{jsonrpc:"2.0",id:$id,method:"tools/list"}')

    echo "  Init request:  $INIT_REQUEST"
    echo "  Tools request: $TOOLS_REQUEST"

    if [[ -f "$REPO_PATH/dist/index.js" && -f "$POLICY_PATH" ]]; then
        # Send initialize request and capture response
        set +e
        INIT_RESPONSE=$(echo "$INIT_REQUEST" | timeout 5 node "$REPO_PATH/dist/index.js" stdio --config "$POLICY_PATH" 2>/dev/null || true)
        set -e

        if [[ -n "$INIT_RESPONSE" ]]; then
            check_pass "MCP server responded to initialize request"
            echo "  Response: $INIT_RESPONSE"

            # Send tools/list request
            set +e
            TOOLS_RESPONSE=$(echo "$TOOLS_REQUEST" | timeout 5 node "$REPO_PATH/dist/index.js" stdio --config "$POLICY_PATH" 2>/dev/null || true)
            set -e

            if [[ -n "$TOOLS_RESPONSE" ]]; then
                check_pass "MCP server responded to tools/list request"
                echo "  Response: $TOOLS_RESPONSE"
            else
                check_fail "MCP server did not respond to tools/list request"
            fi
        else
            check_fail "MCP server did not respond to initialize request"
        fi
    else
        echo "  Skipping JSON-RPC test (missing dist/index.js or policy file)"
    fi
fi

# --- 7. Manual smoke checklist ---
echo ""
echo "========================================"
echo "Manual Smoke Checklist"
echo "========================================"
cat <<'CHECKLIST'
  1.  CONTROL_PLANE_API_KEY is exported and valid.
  2.  CONTROL_PLANE_TUNNEL_ID is exported and correct.
  3.  tunnel-client is installed (npm install -g @openai/tunnel-client).
  4.  Run: ./scripts/openai-tunnel-init-stdio.sh to initialize the profile.
  5.  Run: ./scripts/openai-tunnel-doctor.sh to verify connectivity.
  6.  Run: ./scripts/openai-tunnel-run.sh to start the tunnel.
  7.  Observe tunnel-client connects without errors.
  8.  In ChatGPT, verify the MCP connection is available.
  9.  Test a simple MCP tool call through ChatGPT.
  10. Verify the request reaches the local ChatGPTMCPcmux server.
  11. Check that the policy file is being respected.
  12. Verify audit logging is working.
  13. Test graceful shutdown with Ctrl+C.
  14. Verify tunnel-client reconnects after restart.
  15. Check that unauthorized tools are blocked.
  16. Verify environment variables are passed correctly.
  17. Test error handling with invalid requests.
  18. Confirm all processes clean up on emergency-stop.
CHECKLIST

# --- Summary ---
echo ""
echo "========================================"
echo "Summary: $PASS passed, $FAIL failed"
echo "========================================"

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi

exit 0
