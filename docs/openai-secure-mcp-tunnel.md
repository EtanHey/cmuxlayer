# OpenAI Secure MCP Tunnel — Primary Connection Method

## Overview

**OpenAI Secure MCP Tunnel** is the primary and recommended transport for connecting ChatGPT to your local ChatGPTMCPcmux server. It is a managed tunnel service provided by OpenAI that establishes a secure, authenticated connection between the ChatGPT client (running in OpenAI's cloud) and your local machine — without exposing any public HTTP endpoint.

The tunnel uses **stdio transport** locally: ChatGPTMCPcmux reads JSON-RPC messages from stdin and writes responses to stdout. The `tunnel-client` (installed on your machine) bridges this stdio stream to OpenAI's tunnel cloud, which forwards requests from the ChatGPT app.

**Why this is the primary transport:**
- **No public endpoint needed** — your machine does not need a public IP, open port, or reverse proxy
- **Authentication handled by OpenAI** — the tunnel-client manages auth with OpenAI's servers; no API keys are passed through tool calls
- **End-to-end encrypted** — traffic is encrypted in transit via the tunnel
- **Works behind NAT/firewall** — no Tailscale, ngrok, or Funnel configuration required
- **Official OpenAI product** — purpose-built for MCP, maintained by OpenAI

## Why No Public Endpoint

A common question is: *"Why not just expose an HTTP endpoint via Tailscale Funnel or ngrok?"*

The answer is that **the tunnel-client already handles everything**:

1. **Authentication**: The tunnel-client authenticates with OpenAI using your account credentials. ChatGPT on the other end trusts the tunnel because OpenAI controls both sides.
2. **No Funnel needed**: Tailscale Funnel exposes an HTTP endpoint to the public internet. This creates a permanently reachable attack surface. The OpenAI tunnel is ephemeral — it only exists while the tunnel-client is running.
3. **No HTTP server needed**: ChatGPTMCPcmux speaks stdio (stdin/stdout), not HTTP. The tunnel-client wraps stdio and transports it over the tunnel. No HTTP listener, no port binding, no reverse proxy.
4. **Security in layers**: Even if someone could reach your machine, ChatGPTMCPcmux's policy engine, audit logging, and redaction guards provide defense in depth.

## Prerequisites

Before you begin, ensure you have:

| Requirement | Details |
|---|---|
| **OpenAI account** | With MCP (Model Context Protocol) access enabled |
| **tunnel-client** | OpenAI's official tunnel client installed (`npm install -g @openai/tunnel-client` or equivalent) |
| **Node.js** | Version 20 or higher (`node --version`) |
| **`CONTROL_PLANE_API_KEY`** | Environment variable set with your OpenAI API key |
| **`CONTROL_PLANE_TUNNEL_ID`** | Environment variable set with your tunnel ID from OpenAI |
| **cmux** | Installed and running locally (the terminal multiplexer that manages agents) |

### Check your environment

```bash
# Check Node.js version
node --version  # Should be >= 20

# Check tunnel-client is installed
which tunnel-client
# or
 tunnel-client --version

# Verify environment variables
echo "$CONTROL_PLANE_API_KEY"   # Should print your key (masked)
echo "$CONTROL_PLANE_TUNNEL_ID"  # Should print your tunnel ID

# Check cmux is running
cmux --json list-sessions
# or
pgrep -f cmux
```

## Build Steps

Build the ChatGPTMCPcmux project from source:

```bash
# 1. Navigate to the project directory
cd /mnt/agents/ChatGPTMCPcmux

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npm run build

# 4. Verify the build output
ls -la dist/index.js dist/server-secure.js
```

The build produces compiled JavaScript in `dist/`. Key files:
- `dist/index.js` — Main entry point (handles `--config` flag)
- `dist/server-secure.js` — Secure server factory
- `dist/secure/` — Security modules (policy, audit, redaction, guards)
- `dist/tools/` — Secure tool handlers

## Local stdio Verification

Before connecting through the tunnel, verify the server runs correctly in stdio mode locally:

```bash
# Create a test policy directory and copy the example
mkdir -p ~/.config/chatgpt-mcp-cmux
cp config/policy.example.yaml ~/.config/chatgpt-mcp-cmux/policy.yaml

# Edit the policy to set your project root
# nano ~/.config/chatgpt-mcp-cmux/policy.yaml
# Change: project.root: ~/my-project

# Run the server in secure stdio mode directly
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | \
  node dist/index.js stdio --config ~/.config/chatgpt-mcp-cmux/policy.yaml
```

You should see a JSON-RPC response. If the server crashes, check:
- `cmux` is running (the server needs a cmux client)
- The policy YAML path is correct
- Node.js version is >= 20

For a quick smoke test:
```bash
# Run the smoke test script (if available)
scripts/smoke-stdio.sh
```

## Profile Creation

Use the init script to create a tunnel profile with the correct stdio command:

```bash
# Run the profile initialization script
./scripts/openai-tunnel-init-stdio.sh
```

This script:
1. Creates a tunnel profile named `chatgpt-mcp-cmux` (or similar)
2. Configures the stdio command to launch ChatGPTMCPcmux:
   ```
   node /mnt/agents/ChatGPTMCPcmux/dist/index.js stdio --config ~/.config/chatgpt-mcp-cmux/policy.yaml
   ```
3. Stores the profile in the tunnel-client configuration directory

After running the init script, verify the profile was created:

```bash
# List available tunnel profiles
 tunnel-client list-profiles

# You should see "chatgpt-mcp-cmux" (or the name used by the script)
```

### Manual profile creation (if the script fails)

```bash
# Create the profile manually
 tunnel-client create-profile \
  --name chatgpt-mcp-cmux \
  --command "node /mnt/agents/ChatGPTMCPcmux/dist/index.js stdio --config ~/.config/chatgpt-mcp-cmux/policy.yaml" \
  --env CONTROL_PLANE_API_KEY="$CONTROL_PLANE_API_KEY" \
  --env CONTROL_PLANE_TUNNEL_ID="$CONTROL_PLANE_TUNNEL_ID"
```

## Doctor

Run the diagnostic script to check the health of the entire stack:

```bash
./scripts/openai-tunnel-doctor.sh
```

This script checks:
1. **Environment variables** — `CONTROL_PLANE_API_KEY` and `CONTROL_PLANE_TUNNEL_ID` are set
2. **Node.js version** — >= 20
3. **Build output** — `dist/index.js` exists
4. **Policy file** — `~/.config/chatgpt-mcp-cmux/policy.yaml` exists and is valid
5. **cmux process** — cmux is running
6. **cmux socket** — Unix socket is accessible
7. **Tunnel-client** — Installed and reachable on PATH

Sample output:
```
=== ChatGPTMCPcmux Tunnel Doctor ===
[OK] CONTROL_PLANE_API_KEY is set
[OK] CONTROL_PLANE_TUNNEL_ID is set
[OK] Node.js v22.4.1
[OK] dist/index.js exists
[OK] Policy file exists at ~/.config/chatgpt-mcp-cmux/policy.yaml
[OK] cmux is running (PID 12345)
[OK] cmux socket reachable at /tmp/cmux.sock
[OK] tunnel-client is installed
=== All checks passed ===
```

Fix any `[FAIL]` items before proceeding.

## Run Tunnel

Start the tunnel to connect your local ChatGPTMCPcmux to OpenAI's cloud:

```bash
./scripts/openai-tunnel-run.sh
```

This script:
1. Verifies the environment variables are set
2. Checks that the build exists
3. Reads the tunnel profile created by `openai-tunnel-init-stdio.sh`
4. Launches `tunnel-client run` with the stdio command
5. Keeps the tunnel open, reconnecting automatically if disconnected

You should see output like:
```
=== Starting OpenAI Secure MCP Tunnel ===
[OK] Environment variables verified
[OK] Build exists at dist/index.js
[OK] Profile "chatgpt-mcp-cmux" found
[OK] Starting tunnel-client...
[Tunnel] Connected to OpenAI tunnel cloud
[Tunnel] Tunnel ID: tun_xxxxxxxxxxxxxxxx
[Tunnel] Waiting for ChatGPT connections...
```

### Manual tunnel start (if the script fails)

```bash
# Start the tunnel manually with the stdio command
 tunnel-client run \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --api-key "$CONTROL_PLANE_API_KEY" \
  --command "node /mnt/agents/ChatGPTMCPcmux/dist/index.js stdio --config ~/.config/chatgpt-mcp-cmux/policy.yaml"
```

## Stop Tunnel

To stop the tunnel gracefully:

```bash
./scripts/openai-tunnel-stop.sh
```

This script:
1. Finds the `tunnel-client` process associated with your profile
2. Sends a graceful shutdown signal (SIGTERM)
3. Waits up to 10 seconds for the tunnel to close
4. Reports success or failure

### Manual stop

```bash
# Find the tunnel-client process
pgrep -f "tunnel-client.*chatgpt-mcp-cmux"

# Kill it gracefully
kill <PID>

# Or force kill if it doesn't respond
kill -9 <PID>
```

## Emergency Stop

If the tunnel is misbehaving, leaking data, or you suspect a security issue, use the emergency stop:

```bash
./scripts/emergency-stop.sh
```

This script:
1. **Immediately kills** the tunnel-client process (`kill -9`)
2. **Kills** the ChatGPTMCPcmux Node.js process
3. **Stops** any connected cmux agents
4. Writes an emergency audit entry to the audit log
5. Prints a confirmation message with the timestamp

**When to use emergency stop:**
- You see unauthorized tool calls in the audit log
- ChatGPT is executing tools you didn't approve
- The tunnel is stuck and won't respond to graceful shutdown
- You suspect a prompt injection attack
- You need to immediately sever the connection

**After emergency stop:**
1. Review the audit log: `tail -50 ~/.local/share/chatgpt-mcp-cmux/audit.jsonl`
2. Check what ChatGPT was doing before the stop
3. Restart only after you understand what happened

## Troubleshooting

### Tunnel not connecting

**Symptom**: `tunnel-client` hangs at "Connecting..." or returns an auth error.

**Checklist**:
```bash
# 1. Verify API key is valid
curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $CONTROL_PLANE_API_KEY" | head -5

# 2. Verify tunnel ID is correct
echo "$CONTROL_PLANE_TUNNEL_ID"
# Must match the ID shown in your OpenAI dashboard

# 3. Check tunnel-client version (update if needed)
 tunnel-client --version

# 4. Test network connectivity
ping tunnel.openai.com
```

### Policy file not found

**Symptom**: Server exits with "Policy file not found" or similar.

**Fix**:
```bash
# Create the directory and copy the example
mkdir -p ~/.config/chatgpt-mcp-cmux
cp /mnt/agents/ChatGPTMCPcmux/config/policy.example.yaml ~/.config/chatgpt-mcp-cmux/policy.yaml

# Edit to set your project root
sed -i 's|root: ~/my-project|root: '$(echo ~)'/your-actual-project|' ~/.config/chatgpt-mcp-cmux/policy.yaml
```

### cmux not running

**Symptom**: `system.cmux_health` returns `{"socket_exists": false, "process_running": false}`.

**Fix**:
```bash
# Start cmux in a separate terminal
cmux

# Or if using a specific socket
cmux --socket /tmp/cmux.sock

# Verify it's running
cmux --json list-sessions
```

### Build errors

**Symptom**: `npm run build` fails with TypeScript errors.

**Fix**:
```bash
# Clean install
rm -rf node_modules dist package-lock.json
npm install
npm run build

# Check TypeScript version
npx tsc --version  # Should be >= 5.0
```

### "Tool denied" errors in ChatGPT

**Symptom**: ChatGPT reports that tools are denied.

**Fix**: Check your policy.yaml `tools.allow` list. The tool must be explicitly allowed:
```yaml
tools:
  allow:
    - "system.*"
    - "project.*"
    - "cmux.*"
    - "agent.*"
    - "audit.*"
```

Also verify the tool isn't in the `deny` list and that prefix filters aren't blocking the target.

### Audit log growing too large

The audit log is append-only and can grow over time. Rotate it periodically:
```bash
# Rotate the audit log
mv ~/.local/share/chatgpt-mcp-cmux/audit.jsonl \
   ~/.local/share/chatgpt-mcp-cmux/audit-$(date +%Y%m%d).jsonl

# Compress old logs
gzip ~/.local/share/chatgpt-mcp-cmux/audit-*.jsonl
```

### Connection drops after idle

Some networks drop idle connections. The tunnel-client should auto-reconnect. If it doesn't:
```bash
# Run the tunnel with a keep-alive wrapper
while true; do
  ./scripts/openai-tunnel-run.sh
  echo "[$(date)] Tunnel exited. Restarting in 5 seconds..."
  sleep 5
done
```
