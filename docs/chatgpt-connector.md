# ChatGPT Connector Guide

## Connection Path

When you connect from ChatGPT, the full request path is:

```
ChatGPT (iOS/macOS/Web)
    |
    v
OpenAI Tunnel Cloud (encrypted, authenticated)
    |
    v
tunnel-client (running on your MacBook)
    |
    v
ChatGPTMCPcmux (stdio --config policy.yaml)
    |
    v
cmux (Unix socket — local terminal multiplexer)
    |
    +---> Claude Code session
    +---> Codex CLI session
    +---> Gemini CLI session
    +---> Custom agent sessions
```

Every request flows through **7 layers** before reaching an agent. Each layer adds its own security boundary. The tunnel-client and ChatGPTMCPcmux layers are the critical security gateways.

## Required Local Processes

Before connecting from ChatGPT, ensure these processes are running on your machine:

| Process | Purpose | Check Command |
|---------|---------|--------------|
| `cmux` | Terminal multiplexer hosting agent sessions | `pgrep -f cmux` |
| `tunnel-client` | Bridges stdio to OpenAI tunnel cloud | `pgrep -f tunnel-client` |
| `node dist/index.js` | ChatGPTMCPcmux MCP server (started by tunnel-client) | N/A (child of tunnel-client) |

**At least one agent session must be started** and accessible through cmux. The policy's `agents.allowed_prefixes` must match the session names you start.

### Starting cmux with allowed sessions

```bash
# Start cmux (in a terminal or via launchd)
cmux

# Create and start agent sessions with allowed prefixes
# (Prefixes must match agents.allowed_prefixes in policy.yaml)
cmux new-session -s claude-code-1 -d "claude code"
cmux new-session -s codex-dev-1 -d "codex"
cmux new-session -s gemini-task-1 -d "gemini"

# Verify sessions are running
cmux list-sessions
```

## Required Environment Variables

These must be set **before** starting the tunnel:

```bash
export CONTROL_PLANE_API_KEY="sk-proj-..."      # Your OpenAI API key
export CONTROL_PLANE_TUNNEL_ID="tun_..."         # Your tunnel ID from OpenAI dashboard
```

Add them to your shell profile (`~/.zshenv` or `~/.bash_profile`) to persist across restarts. **Warning:** `~/.zshrc` is often world-readable (644). Use `chmod 600` on your profile file or store secrets in a dedicated env file loaded by your profile:

```bash
# Option A: Append to a restricted env file
echo 'export CONTROL_PLANE_API_KEY="sk-proj-..."' >> ~/.config/chatgpt-mcp-cmux/env
echo 'export CONTROL_PLANE_TUNNEL_ID="tun_..."' >> ~/.config/chatgpt-mcp-cmux/env
chmod 600 ~/.config/chatgpt-mcp-cmux/env

# Then source it in your shell profile (e.g. ~/.zshrc):
# source ~/.config/chatgpt-mcp-cmux/env
```

## Step-by-Step Setup

Follow these steps in order. Do not skip steps.

### Step 1: Build the project

```bash
export CHATGPT_MCP_CMUX_REPO="$HOME/Documents/GitHub/ChatGPTMCPcmux"
cd "$CHATGPT_MCP_CMUX_REPO"
npm install
npm run build
```

### Step 2: Create policy.yaml from example

```bash
# Create config directory
mkdir -p ~/.config/chatgpt-mcp-cmux

# Copy and edit the example policy
cp "$CHATGPT_MCP_CMUX_REPO/config/policy.example.yaml" \
   ~/.config/chatgpt-mcp-cmux/policy.yaml

# Edit the policy — at minimum, set project.root
# nano ~/.config/chatgpt-mcp-cmux/policy.yaml
```

**Minimum required changes** to `policy.yaml`:
```yaml
project:
  root: /ABSOLUTE/PATH/TO/YOUR/PROJECT   # <-- Change this
  # ... rest stays the same

agents:
  allowed_prefixes:
    - "claude-"      # <-- Match your cmux session names
    - "codex-"
    - "gemini-"
    - "task-"
```

### Step 3: Start cmux with allowed sessions

```bash
# Start cmux if not already running
cmux

# Start your agent sessions (prefixes must match policy)
cmux new-session -s claude-main -d "cd ~/your-project && claude code"
cmux new-session -s codex-dev -d "cd ~/your-project && codex"
```

### Step 4: Run tunnel-client init

```bash
# Create the tunnel profile
./scripts/openai-tunnel-init-stdio.sh
```

Or manually:
```bash
tunnel-client create-profile \
  --name chatgpt-mcp-cmux \
  --command "node \"$CHATGPT_MCP_CMUX_REPO/dist/index.js\" stdio --config ~/.config/chatgpt-mcp-cmux/policy.yaml"
```

### Step 5: Run tunnel-client doctor

```bash
# Verify everything is healthy before connecting
./scripts/openai-tunnel-doctor.sh
```

Fix any `[FAIL]` items before proceeding.

### Step 6: Run tunnel-client run

```bash
# Start the tunnel (keeps running)
./scripts/openai-tunnel-run.sh
```

Leave this running. You should see:
```
[Tunnel] Connected to OpenAI tunnel cloud
[Tunnel] Waiting for ChatGPT connections...
```

### Step 7: Connect from ChatGPT app

1. Open the **ChatGPT app** on iOS, macOS, or web
2. Navigate to **Settings > MCP Servers** (or equivalent MCP configuration)
3. You should see your tunnel listed (it uses the `CONTROL_PLANE_TUNNEL_ID`)
4. **Enable** the ChatGPTMCPcmux server
5. ChatGPT will discover the available tools and display them

**First connection verification**: Send a test message like "Check the health of the MCP server." ChatGPT should call `system.health` and report back that the service is running.

## Recommended First Tool Calls

When ChatGPT first connects, it needs to understand the environment. These are the recommended initial tool calls, in order:

### 1. `system.health`
**Purpose**: Verify the secure gateway is running.
```json
{"tool": "system.health", "args": {}}
```
**Expected**: `{"ok": true, "service": "ChatGPTMCPcmux", "mode": "stdio-secure"}`

### 2. `project.info`
**Purpose**: Discover the project root, git status, and current branch.
```json
{"tool": "project.info", "args": {}}
```
**Expected**: `{"ok": true, "root": "/path/to/project", "git": true, "branch": "main"}`

### 3. `project.git_status`
**Purpose**: See what files have changed.
```json
{"tool": "project.git_status", "args": {}}
```
**Expected**: `{"ok": true, "branch": "main", "clean": false, "changes": [...]}`

### 4. `agent.list`
**Purpose**: Discover which agents are running.
```json
{"tool": "agent.list", "args": {}}
```
**Expected**: `{"ok": true, "agents": [{"id": "claude-main", "state": "active", ...}]}`

### 5. `audit.recent`
**Purpose**: Review recent activity for security awareness.
```json
{"tool": "audit.recent", "args": {"count": 10}}
```
**Expected**: List of recent tool calls with timestamps and decisions.

These five calls give ChatGPT a complete picture of the environment before it starts sending tasks to agents.

## Safe Tool Reference

ChatGPTMCPcmux exposes 27 secure tools organized into 5 categories. All tools are **read-only or safe-mutating** — no destructive operations are exposed.

### System Tools (`system.*`)

| Tool | Input | Description | Risk |
|------|-------|-------------|------|
| `system.health` | `{}` | Check gateway status | Read-only |
| `system.version` | `{}` | Get gateway version | Read-only |
| `system.policy` | `{}` | View sanitized policy | Read-only |
| `system.cmux_health` | `{}` | Check cmux connectivity | Read-only |
| `system.memory_usage` | `{}` | Get memory usage | Read-only |

### Project Tools (`project.*`)

| Tool | Input | Description | Risk |
|------|-------|-------------|------|
| `project.info` | `{}` | Project root, git status | Read-only |
| `project.tree` | `{path?, max_depth?}` | List directory tree | Read-only |
| `project.read_file` | `{path}` | Read a file (redacted) | Read-only |
| `project.search` | `{query, path?}` | Search files for text | Read-only |
| `project.grep` | `{pattern, path?}` | Grep with regex | Read-only |
| `project.git_status` | `{}` | Git working tree status | Read-only |
| `project.git_diff` | `{path?}` | Git diff (confirmation req.) | Confirmation |
| `project.git_log_recent` | `{n?}` | Recent commits | Read-only |

### Cmux Tools (`cmux.*`)

| Tool | Input | Description | Risk |
|------|-------|-------------|------|
| `cmux.list_surfaces` | `{workspace?}` | List surfaces (filtered) | Read-only |
| `cmux.read_screen` | `{surface, lines?}` | Read terminal screen | Read-only |
| `cmux.read_output` | `{surface, lines?}` | Read raw output | Read-only |
| `cmux.read_recent_activity` | `{surface, since_seconds?}` | Recent activity | Read-only |
| `cmux.get_agent_metadata` | `{surface}` | Agent metadata | Read-only |

### Agent Tools (`agent.*`)

| Tool | Input | Description | Risk |
|------|-------|-------------|------|
| `agent.list` | `{}` | List agents (filtered) | Read-only |
| `agent.status` | `{agent_id}` | Agent status | Read-only |
| `agent.read` | `{agent_id, lines?}` | Read agent output | Read-only |
| `agent.send_task` | `{agent_id, task}` | Send task to agent | Confirmation |
| `agent.continue` | `{agent_id, instruction?}` | Continue agent | Confirmation |
| `agent.extract_summary` | `{agent_id}` | Extract summary | Read-only |
| `agent.extract_errors` | `{agent_id}` | Extract errors | Read-only |
| `agent.extract_next_actions` | `{agent_id}` | Extract next actions | Read-only |

### Audit Tools (`audit.*`)

| Tool | Input | Description | Risk |
|------|-------|-------------|------|
| `audit.recent` | `{count?}` | Recent audit events | Read-only |
| `audit.search` | `{tool?, decision?, since?}` | Search audit log | Read-only |

### Tools NOT exposed (deliberately)

The following upstream tools are **never** exposed in secure mode:

- `send_to` / `send_to_agent` — raw agent messaging (use `agent.send_task` instead)
- `spawn_agent` — spawning new agents
- `stop_agent` — stopping agents
- `kill` — killing processes
- `close_surface` — closing surfaces
- `send_input` / `send_command` — raw terminal input
- `select_workspace` / `create_workspace` — workspace management
- `new_split` / `new_surface` / `move_surface` — surface manipulation
- All `notify`, `set_status`, `set_progress` — UI mutating tools

## Warnings

### Do NOT expose raw command tools

Never add tools that allow ChatGPT to execute arbitrary shell commands directly. The only command-execution path should be through `agent.send_task`, which:
1. Targets a specific, prefix-allowed agent
2. Requires confirmation by default
3. Has its input scanned by the command guard
4. Is fully audited

**Bad idea**: Adding a `terminal.exec` tool.
**Good idea**: Using `agent.send_task` to send natural language instructions to a Claude Code session.

### Do NOT enable destructive cmux tools

The following cmux tools are **destructive** and must never be enabled in `tools.allow`:
- `cmux.close_surface`
- `cmux.kill_process`
- `cmux.send_input` (can inject arbitrary keystrokes)
- `cmux.spawn` (can spawn arbitrary processes)

Only the read-only cmux tools (`cmux.list_surfaces`, `cmux.read_screen`, `cmux.read_output`, `cmux.read_recent_activity`, `cmux.get_agent_metadata`) are safe.

### Do NOT add a public HTTP endpoint

Do not run an HTTP server to expose ChatGPTMCPcmux. The stdio + tunnel-client architecture is the security model. Adding HTTP:
- Creates a permanent attack surface
- Bypasses the tunnel's authentication
- Requires managing TLS, certs, and auth yourself
- Violates the defense-in-depth architecture

### Do NOT use Tailscale Funnel

Tailscale Funnel exposes your machine to the public internet. Even with ACLs, it creates a reachable endpoint that can be scanned and attacked. The OpenAI tunnel:
- Has no public endpoint
- Authenticates both sides through OpenAI
- Is ephemeral (only active while running)
- Has no port binding on your machine

## CAO Workflow Example

**CAO (Controller-Agent-Orchestrator)** is a powerful pattern where ChatGPT acts as the high-level controller, sending tasks to a supervisor agent that manages worker agents.

### Architecture

```
ChatGPT (controller — high-level reasoning)
    |
    v
agent.send_task("petpals-cao-supervisor", task)
    |
    v
petpals-cao-supervisor (Claude Code session)
    |
    +---> worker-1: "Implement login form"
    +---> worker-2: "Write API tests"
    +---> worker-3: "Update documentation"
```

### Example session

**ChatGPT**: "Implement user authentication for the petpals app."

1. ChatGPT calls `project.info` to understand the codebase
2. ChatGPT calls `agent.list` to find available agents
3. ChatGPT sends the task to the CAO supervisor:
   ```json
   {
     "tool": "agent.send_task",
     "args": {
       "agent_id": "petpals-cao-supervisor",
       "task": "Implement user authentication with JWT tokens, bcrypt password hashing, and login/registration endpoints. Follow the existing code style in src/auth/."
     }
   }
   ```
4. The CAO supervisor receives the task and breaks it down:
   - Spawns `worker-frontend` to build the login UI
   - Spawns `worker-backend` to implement the API
   - Spawns `worker-tests` to write tests
5. ChatGPT monitors progress with `agent.read` calls:
   ```json
   {"tool": "agent.read", "args": {"agent_id": "petpals-cao-supervisor"}}
   ```
6. ChatGPT extracts summaries and errors:
   ```json
   {"tool": "agent.extract_summary", "args": {"agent_id": "petpals-cao-supervisor"}}
   {"tool": "agent.extract_errors", "args": {"agent_id": "worker-backend"}}
   ```

### Policy configuration for CAO

```yaml
agents:
  allowed_prefixes:
    - "petpals-"       # CAO supervisor and workers
    - "claude-"        # General Claude Code sessions
    - "codex-"         # Codex CLI sessions

tools:
  allow:
    - "system.*"
    - "project.*"
    - "cmux.*"
    - "agent.*"
    - "audit.*"
  require_confirmation:
    - "agent.send_task"   # Always confirm before sending tasks
    - "agent.continue"
```

The CAO pattern keeps ChatGPT in control while delegating execution to specialized local agents that have full access to the codebase, IDE, and terminal — all within the security boundary of your machine.
