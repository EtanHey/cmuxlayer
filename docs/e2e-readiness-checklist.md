# E2E Readiness Checklist — ChatGPTMCPcmux Secure MCP Gateway

> **Date**: 2026-06-21
> **For**: Danil (manual execution)
> **Prerequisite**: Complete all steps below in order. Each section depends on the previous one.
> **Time estimate**: 15-20 minutes (excluding ChatGPT MCP beta waitlist if applicable)

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Build](#2-build)
3. [Configure](#3-configure)
4. [Start cmux](#4-start-cmux)
5. [Tunnel init](#5-tunnel-init)
6. [Tunnel doctor](#6-tunnel-doctor)
7. [Tunnel run](#7-tunnel-run)
8. [ChatGPT connection](#8-chatgpt-connection)
9. [Verification checks](#9-verification-checks)
10. [Expected responses](#10-expected-responses)
11. [Negative tests](#11-negative-tests)
12. [Emergency stop](#12-emergency-stop)
13. [Cleanup](#13-cleanup)

---

## 1. Prerequisites

Verify all of the following before proceeding. If any check fails, do not continue — fix it first.

| # | Check | Command | Expected |
|---|-------|---------|----------|
| 1.1 | Node.js >= 20 | `node --version` | `v20.x.x` or higher |
| 1.2 | npm installed | `npm --version` | Any version (10.x recommended) |
| 1.3 | cmux installed | `which cmux` | Path to cmux binary |
| 1.4 | cmux works | `cmux --version` or `cmux -V` | Version output |
| 1.5 | tunnel-client installed | `which tunnel-client` | Path to tunnel-client binary |
| 1.6 | tunnel-client works | `tunnel-client --version` | Version output |
| 1.7 | CONTROL_PLANE_API_KEY set | `echo $CONTROL_PLANE_API_KEY` | Non-empty value starting with `sk-...` |
| 1.8 | CONTROL_PLANE_TUNNEL_ID set | `echo $CONTROL_PLANE_TUNNEL_ID` | Non-empty value starting with `tun_...` |
| 1.9 | ChatGPT MCP beta access | N/A (manual) | You have received MCP access from OpenAI and can see "MCP Servers" in ChatGPT Settings |
| 1.10 | Project cloned locally | `ls /mnt/agents/ChatGPTMCPcmux` (or your path) | Directory exists with `src/`, `package.json`, `config/`, `scripts/` |

**Set environment variables** (add to `~/.zshrc` or `~/.bash_profile` for persistence):

```bash
export CONTROL_PLANE_API_KEY="sk-proj-..."        # Your actual OpenAI API key
export CONTROL_PLANE_TUNNEL_ID="tun_..."           # Your actual tunnel ID
```

Then reload:
```bash
source ~/.zshrc   # or ~/.bash_profile
```

---

## 2. Build

Run these commands in order. Each must succeed before the next.

### Step 2.1: Navigate to project
```bash
cd /mnt/agents/ChatGPTMCPcmux   # or your clone path
```

### Step 2.2: Install dependencies
```bash
npm install
```
**Expected**: Completes without errors. May show audit warnings (normal).

### Step 2.3: Build
```bash
npm run build
```
**Expected**: Compiles with 0 errors. `dist/index.js` is created.

### Step 2.4: Verify build output
```bash
ls -la dist/index.js
```
**Expected**: File exists.

### Step 2.5: Type check
```bash
npm run typecheck
```
**Expected**: No output (silence = success). Any errors here must be fixed before continuing.

### Step 2.6: Run tests
```bash
npm test
```
**Expected**:
```
Test Files  61 passed (61)
     Tests  1079 passed (1079)
```
Note: 8 inbox-hook tests may be skipped if Python scripts are missing — this is expected and OK.

If any test fails, do not proceed. Fix the failure first.

---

## 3. Configure

### Step 3.1: Create config directory
```bash
mkdir -p ~/.config/chatgpt-mcp-cmux
```

### Step 3.2: Copy example policy
```bash
cp /mnt/agents/ChatGPTMCPcmux/config/policy.example.yaml ~/.config/chatgpt-mcp-cmux/policy.yaml
```

### Step 3.3: Edit policy with real paths
```bash
# Use your preferred editor
nano ~/.config/chatgpt-mcp-cmux/policy.yaml
# or
vim ~/.config/chatgpt-mcp-cmux/policy.yaml
```

**Edit these fields**:

```yaml
project:
  root: /Users/YOUR_USERNAME/path/to/your/project   # <-- EDIT THIS
  max_file_read_bytes: 200000
  max_search_results: 100
  deny:
    - "*.pem"
    - "*.key"
    - ".env*"
    - "id_rsa*"
    - "id_ed25519*"
    - "known_hosts"
    - ".ssh/"
    - "node_modules/"
    - ".git/"

workspaces:
  allowed_prefixes:
    - "ws-"
    - "project-"
    - "dev-"

agents:
  allowed_prefixes:
    - "agent-"
    - "claude-"
    - "gpt-"
    - "dev-"
    - "task-"

surfaces:
  allowed_name_prefixes:
    - "main"
    - "dev"
    - "chat"
    - "preview-"
    - "task-"

tools:
  allow:
    - "system.*"
    - "project.*"
    - "cmux.*"
    - "agent.*"
    - "audit.*"
  require_confirmation:
    - "agent.send_task"
    - "agent.continue"
    - "project.git_diff"
  deny:
    - "system.memory_usage"

commands:
  deny_patterns:
    - 'rm\s+-rf'
    - '>\s*/dev/null'
    - 'curl.*\|.*sh'
    - 'wget.*\|.*sh'
    - '\bsudo\b'
    - '\bmkfs\b'
    - 'dd\s+if='
    - ':\(\)\{\s*:\s*\|.*;\s*\}'
    - '\beval\b'
    - 'base64\s+--decode'
    - '~/.ssh'
    - '/etc/shadow'
    - '/etc/passwd'
  require_confirmation_patterns:
    - 'git\s+push'
    - 'git\s+.*force'
    - 'npm\s+publish'
    - '\bdocker\b'
    - '\bkubectl\b'

audit:
  path: ~/.local/share/chatgpt-mcp-cmux/audit.jsonl
  redact_secrets: true
  log_full_inputs: false
  log_input_preview_chars: 300

limits:
  max_output_lines: 500
  max_screen_chars: 50000
  max_request_body_bytes: 100000
  tool_timeout_ms: 30000
  max_concurrent_requests: 5
```

**Key edits**:
- `project.root` — Set to the absolute path of the project you want ChatGPT to access
- `agents.allowed_prefixes` — Ensure these match the names of cmux sessions you'll create
- `surfaces.allowed_name_prefixes` — Ensure these match your cmux window/pane naming

### Step 3.4: Validate policy file syntax
```bash
cat ~/.config/chatgpt-mcp-cmux/policy.yaml | head -5
```
**Expected**: YAML content prints correctly (no corruption).

---

## 4. Start cmux

Before the tunnel can work, cmux must be running with at least one agent session whose name matches an allowed prefix in your policy.

### Step 4.1: Check existing sessions
```bash
cmux list-sessions
```
**Expected**: Lists running sessions (may be empty).

### Step 4.2: Create a session with allowed prefix

Create a session whose name starts with one of the prefixes in `agents.allowed_prefixes` (e.g., `claude-`):

```bash
cmux new-session -s claude-main -d "claude code"
```
**Expected**: Session created. You can verify with:
```bash
cmux list-sessions
# Expected output includes: claude-main
```

### Step 4.3: Create a second session (optional, for prefix filtering test)
```bash
cmux new-session -s other-session -d "bash"
```
This session does **not** match the allowed prefixes, so it should NOT appear in `agent.list` output.

### Step 4.4: Verify agent is running
```bash
cmux list-sessions
```
**Expected**: At least `claude-main` appears.

---

## 5. Tunnel Init

Create the tunnel-client profile that connects ChatGPT to your local MCP server.

### Step 5.1: Run init script
```bash
cd /mnt/agents/ChatGPTMCPcmux
./scripts/openai-tunnel-init-stdio.sh
```

**Expected output**:
```
========================================
OpenAI Tunnel Init (stdio MCP)
========================================

Profile:     chatgpt-mcp-cmux-local
Tunnel ID:   tun_...
Policy:      /Users/.../.config/chatgpt-mcp-cmux/policy.yaml
Repo:        /mnt/agents/ChatGPTMCPcmux
MCP Command: node /mnt/agents/ChatGPTMCPcmux/dist/index.js stdio --config /Users/.../.config/chatgpt-mcp-cmux/policy.yaml

[Profile creation output from tunnel-client]

========================================
SUCCESS: Tunnel profile initialized.
========================================
Profile:     chatgpt-mcp-cmux-local
MCP Command: node /mnt/agents/ChatGPTMCPcmux/dist/index.js stdio --config /Users/.../.config/chatgpt-mcp-cmux/policy.yaml

Next steps:
  1. Review the generated profile if needed.
  2. Run: ./scripts/openai-tunnel-doctor.sh to verify connectivity.
  3. Run: ./scripts/openai-tunnel-run.sh to start the tunnel.
```

**If you see warnings about missing paths**, verify the REPO_PATH and POLICY_PATH are correct.

---

## 6. Tunnel Doctor

Verify tunnel-client can connect to the OpenAI control plane.

### Step 6.1: Run doctor
```bash
./scripts/openai-tunnel-doctor.sh
```

**Expected output** (all checks pass):
```
========================================
OpenAI Tunnel Doctor
========================================
Profile: chatgpt-mcp-cmux-local

[tunnel-client doctor output]
========================================
SUCCESS: Tunnel doctor reports no issues.
========================================

Your tunnel profile 'chatgpt-mcp-cmux-local' appears correctly configured.
You can now start the tunnel with: ./scripts/openai-tunnel-run.sh
```

**If doctor reports issues**:
- Verify `CONTROL_PLANE_API_KEY` is set correctly
- Verify `CONTROL_PLANE_TUNNEL_ID` is correct
- Check network connectivity
- Try re-initializing the profile with `./scripts/openai-tunnel-init-stdio.sh`

**Do not proceed until doctor passes.**

---

## 7. Tunnel Run

Start the tunnel. This process must remain running for ChatGPT to connect.

### Step 7.1: Start the tunnel
```bash
./scripts/openai-tunnel-run.sh
```

**Expected output**:
```
========================================
OpenAI Tunnel Run (stdio MCP)
========================================
Profile:     chatgpt-mcp-cmux-local
Tunnel ID:   tun_...

Starting tunnel-client...
Press Ctrl+C to stop.
========================================

[tunnel-client connects]
Connected to OpenAI tunnel cloud
```

**The terminal will now show tunnel-client logs.** Keep this terminal open.

### Step 7.2: Verify connection
Look for output containing:
- `Connected to OpenAI tunnel cloud`
- No error messages
- Heartbeat/ping messages (periodic)

**Leave this terminal running.** Open a new terminal for the next steps.

---

## 8. ChatGPT Connection

Now connect from the ChatGPT app. The tunnel must be running (Step 7) for this to work.

### Step 8.1: Open ChatGPT app
Open ChatGPT on macOS, iOS, or web.

### Step 8.2: Navigate to MCP Servers
```
Settings > MCP Servers
```

### Step 8.3: Find ChatGPTMCPcmux
Look for **ChatGPTMCPcmux** (or your tunnel ID) in the list of available MCP servers.

### Step 8.4: Enable the server
Toggle the switch **ON** to enable the MCP server.

### Step 8.5: Wait for tool discovery
ChatGPT will fetch the tool list from your local MCP server via the tunnel. This takes a few seconds.

**Expected**: ChatGPT shows "Tools available" or lists the tools. You should see 27 tools.

### Step 8.6: Start a new conversation
Create a new chat to ensure MCP tools are loaded.

---

## 9. Verification Checks

Perform each check in order. Mark [x] as you complete each one.

### Check 1: System Health
**In ChatGPT, type**:
```
Check the health of the MCP server
```

- [ ] **PASS**: ChatGPT calls `system.health` and reports the gateway is running

**Expected response**: See [Check 1 in Section 10](#check-1-systemhealth)

---

### Check 2: System Version
**In ChatGPT, type**:
```
What version is the MCP gateway?
```

- [ ] **PASS**: ChatGPT calls `system.version` and reports version `0.3.0`

**Expected response**: See [Check 2 in Section 10](#check-2-systemversion)

---

### Check 3: Project Info
**In ChatGPT, type**:
```
Show me the project info
```

- [ ] **PASS**: ChatGPT calls `project.info` and shows your project root, confirms it exists, and shows git status

**Expected response**: See [Check 3 in Section 10](#check-3-projectinfo)

---

### Check 4: Project Tree
**In ChatGPT, type**:
```
List the files in the project
```

- [ ] **PASS**: ChatGPT calls `project.tree` and shows the directory tree

**Expected response**: JSON with file tree listing, truncated to reasonable depth

---

### Check 5: Project Read File
**In ChatGPT, type**:
```
Read the README.md file
```

- [ ] **PASS**: ChatGPT calls `project.read_file` with path `README.md` and shows contents

**Expected response**: Contents of your README.md file

---

### Check 6: Project Git Status
**In ChatGPT, type**:
```
What is the git status?
```

- [ ] **PASS**: ChatGPT calls `project.git_status` and shows current git state

**Expected response**: Git status output (branch, modified files, etc.)

---

### Check 7: cmux List Surfaces
**In ChatGPT, type**:
```
List the cmux surfaces
```

- [ ] **PASS**: ChatGPT calls `cmux.list_surfaces` and lists surfaces matching allowed prefixes

**Expected response**: List of cmux surfaces with names matching `surfaces.allowed_name_prefixes`

---

### Check 8: Agent List
**In ChatGPT, type**:
```
List available agents
```

- [ ] **PASS**: ChatGPT calls `agent.list` and shows `claude-main` (matching allowed prefix)
- [ ] **PASS**: `other-session` does NOT appear (doesn't match allowed prefix)

**Expected response**: See [Check 8 in Section 10](#check-8-agentlist)

---

### Check 9: Agent Status
**In ChatGPT, type**:
```
What is the status of claude-main?
```

- [ ] **PASS**: ChatGPT calls `agent.status` with `agent_id: "claude-main"` and returns status

**Expected response**: JSON with agent state, PID, and runtime info

---

### Check 10: Agent Read Output
**In ChatGPT, type**:
```
Read the output from claude-main
```

- [ ] **PASS**: ChatGPT calls `agent.read` with `agent_id: "claude-main"` and shows recent output

**Expected response**: Recent terminal output from the claude-main session

---

### Check 11: Agent Send Task
**In ChatGPT, type**:
```
Send a task to claude-main to check the git status
```

- [ ] **PASS**: ChatGPT calls `agent.send_task` with `agent_id: "claude-main"`
- [ ] **PASS**: Either task is accepted OR confirmation_required response is returned (both are correct behavior)

**Expected response**: See [Check 11 in Section 10](#check-11-agentsendtask)

---

### Check 12: Project Search
**In ChatGPT, type**:
```
Search the project for "TODO"
```

- [ ] **PASS**: ChatGPT calls `project.search` with query `"TODO"` and returns results

**Expected response**: List of files containing "TODO" with line numbers

---

### Check 13: Project Grep
**In ChatGPT, type**:
```
Search the project for files matching pattern "function.*health"
```

- [ ] **PASS**: ChatGPT calls `project.grep` with pattern and returns matches

**Expected response**: Matching lines from project files

---

### Check 14: Audit Recent
**In ChatGPT, type**:
```
Show me recent audit events
```

- [ ] **PASS**: ChatGPT calls `audit.recent` and shows a list of recent tool calls
- [ ] **PASS**: All previous tool calls from this session appear in the audit log

**Expected response**: JSONL-formatted audit events with tool names, decisions, timestamps

---

### Check 15: System Policy View
**In ChatGPT, type**:
```
Show me the current security policy
```

- [ ] **PASS**: ChatGPT calls `system.policy` and shows the active policy (sanitized)

**Expected response**: JSON with the active policy configuration

---

### Check 16: System cmux Health
**In ChatGPT, type**:
```
Check the cmux health
```

- [ ] **PASS**: ChatGPT calls `system.cmux_health` and reports socket connectivity

**Expected response**: JSON with cmux socket path and connection status

---

### Check 17: Agent Extract Summary
**In ChatGPT, type**:
```
Extract a summary from claude-main's output
```

- [ ] **PASS**: ChatGPT calls `agent.extract_summary` and returns a parsed summary

**Expected response**: Structured summary of the agent's recent activity

---

### Check 18: No Secrets in Any Response
Review all responses from Checks 1-17:

- [ ] **PASS**: No API keys appear in any response
- [ ] **PASS**: No private keys appear in any response
- [ ] **PASS**: No tokens or passwords appear in any response
- [ ] **PASS**: Any secret-like strings are replaced with `[REDACTED_SECRET]`

---

## 10. Expected Responses

For each check in Section 9, the expected JSON response is documented below.

### Check 1: system.health
```json
{"ok":true,"service":"ChatGPTMCPcmux","mode":"stdio-secure"}
```

### Check 2: system.version
```json
{"ok":true,"version":"0.3.0","name":"@danissimode/chatgpt-mcp-cmux"}
```

### Check 3: project.info
```json
{"ok":true,"root":"/Users/YOUR_USERNAME/path/to/project","exists":true,"git":true,"branch":"main"}
```
*(Values depend on your actual project)*

### Check 8: agent.list
```json
{"ok":true,"agents":[
  {"id":"claude-main","status":"running","prefix":"claude-"}
]}
```
**Note**: `other-session` (from Step 4.3) should NOT appear because it doesn't match `agents.allowed_prefixes`.

### Check 11: agent.send_task
Two possible correct responses:

**If confirmation is enabled** (default):
```json
{"ok":false,"error":"Tool \"agent.send_task\" requires user confirmation before execution","confirmation_required":true,"tool":"agent.send_task"}
```
ChatGPT will ask you to confirm. Say yes to proceed.

**If allowed directly**:
```json
{"ok":true,"agent_id":"claude-main","task_sent":true}
```

---

## 11. Negative Tests

These tests verify that dangerous operations are properly denied. Perform each one.

### Negative Test 1: Read denied file (.env)
**In ChatGPT, type**:
```
Read the .env file
```

**Expected**: `project.read_file` with `path=".env"` is **DENIED**.
```json
{"ok":false,"error":"Path \".env\" is not allowed","tool":"project.read_file"}
```
- [ ] **PASS**: Request denied

---

### Negative Test 2: Read file outside project
**In ChatGPT, type**:
```
Read the file /etc/passwd
```

**Expected**: `project.read_file` with `path="/etc/passwd"` is **DENIED**.
```json
{"ok":false,"error":"Path \"/etc/passwd\" is outside the project root","tool":"project.read_file"}
```
- [ ] **PASS**: Request denied

---

### Negative Test 3: Path traversal attempt
**In ChatGPT, type**:
```
Read the file ../../.ssh/id_rsa
```

**Expected**: `project.read_file` with `path="../../.ssh/id_rsa"` is **DENIED**.
```json
{"ok":false,"error":"Path \"../../.ssh/id_rsa\" is outside the project root","tool":"project.read_file"}
```
- [ ] **PASS**: Request denied

---

### Negative Test 4: Access agent outside prefix
**In ChatGPT, type**:
```
Read output from agent unauthorized-agent
```

**Expected**: `agent.read` with `agent_id="unauthorized-agent"` is **DENIED** (if it doesn't match allowed prefixes).
```json
{"ok":false,"error":"Target \"unauthorized-agent\" does not match allowed agent prefixes: ...","tool":"agent.read"}
```
- [ ] **PASS**: Request denied

---

### Negative Test 5: Dangerous command in task
**In ChatGPT, type**:
```
Tell claude-main to run: rm -rf /
```

**Expected**: `agent.send_task` is **DENIED** or requires confirmation due to command guard detecting `rm -rf`.
```json
{"ok":false,"error":"Tool \"agent.send_task\" requires user confirmation before execution","confirmation_required":true,"tool":"agent.send_task"}
```
- [ ] **PASS**: Blocked or confirmation required

---

### Negative Test 6: Unknown tool not exposed
**In ChatGPT, type**:
```
Kill the claude-main process
```

**Expected**: ChatGPT **cannot** call `kill`, `stop_agent`, or `shell.exec` because these tools are **not registered** in the secure server. ChatGPT will report that no such tool is available.
- [ ] **PASS**: No kill/stop_agent/shell.exec tool available

---

### Negative Test 7: Denied tool (system.memory_usage)
If `system.memory_usage` is in the `tools.deny` list (as in the example policy):

**In ChatGPT, type**:
```
Show me the memory usage
```

**Expected**: `system.memory_usage` is **DENIED**.
```json
{"ok":false,"error":"Tool \"system.memory_usage\" is not allowed by policy","tool":"system.memory_usage"}
```
- [ ] **PASS**: Request denied

---

### Negative Test 8: Audit log contains no secrets
**In ChatGPT, type**:
```
Show me the audit log for recent events
```

**Expected**: In the `audit.recent` response, verify that no raw secrets appear. Any secret-like content should be `[REDACTED_SECRET]`.
- [ ] **PASS**: No raw secrets in audit output

---

## 12. Emergency Stop

If at any point you need to immediately disconnect (suspect compromise, unusual behavior, etc.):

### Option A: Graceful stop
In the terminal running the tunnel, press **Ctrl+C**. This runs the cleanup handler.

### Option B: Script stop
In a separate terminal:
```bash
cd /mnt/agents/ChatGPTMCPcmux
./scripts/openai-tunnel-stop.sh
```

**Expected**:
```
========================================
OpenAI Tunnel Stop
========================================
Profile: chatgpt-mcp-cmux-local

Found tunnel-client process(es): <PID>
========================================
SUCCESS: Tunnel stopped for profile 'chatgpt-mcp-cmux-local'.
========================================
```

### Option C: Emergency stop (nuclear option)
If the tunnel is stuck or compromised:
```bash
cd /mnt/agents/ChatGPTMCPcmux
./scripts/emergency-stop.sh
```

**Expected**:
```
========================================
EMERGENCY STOP
========================================
Profile: chatgpt-mcp-cmux-local

Killing tunnel-client processes: <PID>
Killing chatgpt-mcp-cmux processes: ...
Killing ChatGPTMCPcmux processes: ...

========================================
Emergency stop completed. Processes were terminated.
========================================
```

This kills ALL tunnel-client, chatgpt-mcp-cmux, and ChatGPTMCPcmux processes. It always exits 0 even if nothing was running.

### Verify stop
After any stop method:
```bash
pgrep -f tunnel-client   # Should return nothing
pgrep -f "dist/index.js" # Should return nothing
```

In ChatGPT, the MCP server should show as "Unavailable" or tools should fail to respond.

---

## 13. Cleanup

After completing all tests (or if you want to start fresh):

### Step 13.1: Stop the tunnel
```bash
./scripts/openai-tunnel-stop.sh
# or
./scripts/emergency-stop.sh
```

### Step 13.2: Stop cmux sessions (optional)
```bash
cmux kill-session -t claude-main
cmux kill-session -t other-session
```

### Step 13.3: Review audit log
```bash
cat ~/.local/share/chatgpt-mcp-cmux/audit.jsonl | tail -20
```
Review the audit log to verify all tool calls were recorded correctly.

### Step 13.4: Remove tunnel profile (optional)
```bash
tunnel-client delete --profile chatgpt-mcp-cmux-local
```

### Step 13.5: Archive or delete policy (optional)
```bash
# Keep for later use:
# ~/.config/chatgpt-mcp-cmux/policy.yaml is safe to keep

# Or remove:
# rm ~/.config/chatgpt-mcp-cmux/policy.yaml
```

---

## Quick Reference Card

Print this and keep it handy during E2E testing:

```
=== ENV VARS ===
export CONTROL_PLANE_API_KEY="sk-..."
export CONTROL_PLANE_TUNNEL_ID="tun_..."

=== BUILD ===
cd /mnt/agents/ChatGPTMCPcmux
npm install && npm run build && npm run typecheck && npm test

=== CMUX SESSION ===
cmux new-session -s claude-main -d "claude code"

=== TUNNEL LIFECYCLE ===
./scripts/openai-tunnel-init-stdio.sh   # First time only
./scripts/openai-tunnel-doctor.sh       # Check health
./scripts/openai-tunnel-run.sh          # Start (keep running)
Ctrl+C                                   # Graceful stop
./scripts/openai-tunnel-stop.sh         # Script stop
./scripts/emergency-stop.sh             # Nuclear option

=== CHATGPT PROMPTS ===
"Check the health of the MCP server"     -> system.health
"Show me the project info"               -> project.info
"List available agents"                  -> agent.list
"Send a task to claude-main to ..."      -> agent.send_task
"Show me recent audit events"            -> audit.recent

=== VERIFY STOP ===
pgrep -f tunnel-client   # should return nothing
pgrep -f "dist/index.js" # should return nothing
```

---

## Troubleshooting

### Problem: tunnel-client not found
```bash
npm install -g @openai/tunnel-client
```

### Problem: "Profile not found"
Re-run init:
```bash
./scripts/openai-tunnel-init-stdio.sh
```

### Problem: Doctor fails with auth error
- Verify `CONTROL_PLANE_API_KEY` is set and correct
- Verify `CONTROL_PLANE_TUNNEL_ID` is correct
- Check that your OpenAI account has MCP beta access

### Problem: ChatGPT doesn't show MCP Servers option
- You may not have MCP beta access yet. Wait for OpenAI to grant access.
- Ensure ChatGPT app is updated to the latest version

### Problem: Tools don't appear in ChatGPT
- Verify tunnel is running (`./scripts/openai-tunnel-run.sh` showing connected)
- Check doctor passes (`./scripts/openai-tunnel-doctor.sh`)
- Restart ChatGPT app
- Toggle the MCP server off and on in Settings

### Problem: "Path outside project root" on legitimate request
- Check `project.root` in your policy.yaml is set correctly
- The path must be an absolute path (e.g., `/Users/danil/project` not `~/project`)

### Problem: Agent not showing in agent.list
- Verify cmux session name matches `agents.allowed_prefixes` in policy
- Example: session `claude-main` requires prefix `claude-` in allowed_prefixes

### Problem: Audit log file not created
```bash
mkdir -p ~/.local/share/chatgpt-mcp-cmux
touch ~/.local/share/chatgpt-mcp-cmux/audit.jsonl
```

---

*End of E2E readiness checklist. All steps above require manual execution by Danil.*
