# ChatGPTMCPcmux

**Secure ChatGPT → local cmux agents gateway over OpenAI Secure MCP Tunnel.**
Based on cmuxLayer by [@EtanHey](https://github.com/EtanHey).

<p align="center">
  <img src="./assets/cmuxlayer-logo-split-pane-grid.svg" alt="ChatGPTMCPcmux" width="96" height="96" />
</p>

[![install](https://img.shields.io/badge/install-npm%20install%20--g%20chatgpt--mcp--cmux-22c55e)](https://github.com/Danissimode/ChatGPTMCPcmux#quick-start-secure-mode)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![MCP Tools](https://img.shields.io/badge/MCP-27%20secure%20tools-green.svg)](https://modelcontextprotocol.io)

## What is this?

This fork adds a **security-hardened layer** for connecting ChatGPT to your local cmux agents via the **OpenAI Secure MCP Tunnel**. When enabled with `--config`, only policy-approved tools are exposed — with audit logging, secret redaction, path guards, and command filtering.

ChatGPT gets **orchestration access**, not an unrestricted remote shell:

- **Read** allowed project files only (no `~/.ssh`, no `.env`, no Keychain)
- **Inspect** git status/diff
- **View** allowed cmux/agent sessions (filtered by prefix: `petpals-`, `cao-`, `chatgpt-`)
- **Send tasks** to allowed agents (with command guard)
- **Audit** every tool call is logged to `~/.local/share/chatgpt-mcp-cmux/audit.jsonl`

> **IMPORTANT:** Secure ChatGPT mode does NOT expose the original 35-tool cmuxLayer surface. The original 35 tools (like `kill`, `spawn`, `close_surface`) are available only in standard upstream mode. Secure mode exposes only a filtered, policy-controlled toolset.



### Quick Start (Secure Mode)

```bash
# 1. Build the project
npm install && npm run build

# 2. Create your policy config
cp config/policy.example.yaml ~/.config/chatgpt-mcp-cmux/policy.yaml
# Edit: set project.root, adjust allowed prefixes

# 3. Initialize OpenAI tunnel
export CONTROL_PLANE_API_KEY="your-api-key"
export CONTROL_PLANE_TUNNEL_ID="your-tunnel-id"
scripts/openai-tunnel-init-stdio.sh

# 4. Run the tunnel
scripts/openai-tunnel-run.sh

# 5. Connect from ChatGPT app — the tunnel appears as a local MCP server
```

### Architecture

```text
ChatGPT (iPhone/Web)
  |
  v
OpenAI Secure MCP Tunnel (cloud)
  |
  v
tunnel-client (MacBook)
  |
  v
ChatGPTMCPcmux stdio --config policy.yaml
  |
  +-- Policy engine (allow/deny/confirm)
  +-- Path guard (project-root only)
  +-- Command guard (dangerous pattern filter)
  +-- Secret redactor
  +-- Audit logger (JSONL)
  |
  v
cmux / local CLI agents
```

### Documentation

- [`docs/openai-secure-mcp-tunnel.md`](docs/openai-secure-mcp-tunnel.md) — Tunnel setup and operation
- [`docs/chatgpt-connector.md`](docs/chatgpt-connector.md) — Connecting from ChatGPT
- [`docs/security-model.md`](docs/security-model.md) — Security architecture and threat model
- [`docs/mcpkit-reference-audit.md`](docs/mcpkit-reference-audit.md) — MCPKit pattern analysis
- [`docs/implementation-closeout.md`](docs/implementation-closeout.md) — Closeout checklist

### Secure Mode Command

```bash
# Stdio with security policy
node dist/index.js stdio --config ~/.config/chatgpt-mcp-cmux/policy.yaml

# Without --config: standard upstream mode (backward compatible)
cmuxlayer
```

### Secure Tools (27 exposed when policy enabled)

| Category | Tools |
|----------|-------|
| `system.*` | health, version, policy, cmux_health, memory_usage |
| `project.*` | info, tree, read_file, search, grep, git_status, git_diff, git_log_recent |
| `cmux.*` | list_surfaces, read_screen, read_output, read_recent_activity, get_agent_metadata |
| `agent.*` | list, status, read, send_task, continue, extract_summary, extract_errors, extract_next_actions |
| `audit.*` | recent, search |

See [`docs/security-model.md`](docs/security-model.md) for full policy reference.

---

## Upstream cmuxLayer Compatibility

For local agents (Cursor, Claude Code, etc.), you can still run the server in standard upstream mode without the `--config` flag to get all 35 terminal control tools.

```bash
# Standard mode (no security policy)
cmuxlayer
```

See [Upstream cmuxLayer Compatibility details](#mcp-tools-35-standard-mode-only) below.

## MCP Tools (35) - Standard Mode Only

> **WARNING:** These tools are only available when running without a `--config` policy. They are NEVER exposed to remote ChatGPT connections.

All tools ship with [ToolAnnotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) for automatic safety policy enforcement.

**Terminal control** — `list_surfaces` `control_health` `select_workspace` `create_workspace` `new_split` `new_surface` `move_surface` `reorder_surface` `send_input` `send_command` `send_key` `read_screen` `rename_tab` `close_surface` `browser_surface`

**Agent lifecycle** — `spawn_agent` `new_worktree_split` `spawn_in_workspace` `resync_agents` `send_to` `send_to_agent` `wait_for` `wait_for_all` `interact` `stop_agent` `kill`

**Metacomm (agent inbox)** — `dispatch_to_agent` `inbox_check`

**Workspace state** — `list_agents` `my_agents` `get_agent_state` `read_agent_output` `notify` `set_status` `set_progress`

<details>
<summary>Full standard tool reference (35 tools)</summary>

### Read-only (8)

| Tool | What it does |
|------|-------------|
| `list_surfaces` | List all surfaces across workspaces |
| `control_health` | Report socket, binary, process, and job-control diagnostics |
| `read_screen` | Read terminal output with parsed agent status |
| `get_agent_state` | Full state of a tracked agent |
| `list_agents` | All agents, with optional filters |
| `my_agents` | Children of a parent agent with live screen status |
| `read_agent_output` | Structured output between delimiter markers |
| `inbox_check` | Inspect an agent's inbox channel: pending messages, monitor liveness, stale dispatches |

### Mutating (24)

| Tool | What it does |
|------|-------------|
| `select_workspace` | Switch the active workspace |
| `create_workspace` | Create a new named workspace |
| `new_split` | Create a terminal or browser split pane |
| `new_surface` | Create a tab in an existing pane |
| `move_surface` | Move a surface to another pane or position |
| `reorder_surface` | Reorder tabs within a pane |
| `send_input` | Send text to a raw surface; use `send_to` for tracked agents |
| `send_command` | Atomically send a command and press return on the same surface |
| `send_key` | Send key press (return, escape, ctrl-c, etc.) to a raw surface |
| `rename_tab` | Rename a surface tab |
| `notify` | Show a cmux notification banner |
| `set_status` | Set sidebar status key-value pair |
| `set_progress` | Set progress indicator (0.0-1.0) |
| `browser_surface` | Interact with browser surfaces |
| `spawn_agent` | Spawn a CLI agent and return an `agent_id` for routing |
| `new_worktree_split` | Create or reuse a git worktree and spawn a worker there |
| `spawn_in_workspace` | Create a workspace and spawn a multi-agent team into a clean grid |
| `resync_agents` | Re-sync the agent registry from live surfaces |
| `dispatch_to_agent` | Append a task to an agent's inbox file (deterministic write channel) |
| `send_to` | Preferred path for sending text to a tracked agent by `agent_id` |
| `send_to_agent` | Legacy/internal agent send path; prefer `send_to` |
| `wait_for` | Block until agent reaches a target state (defaults to `done`) |
| `wait_for_all` | Block until multiple agents finish |
| `interact` | Send interactive input (confirm, cancel, resume) |

### Destructive (3)

| Tool | What it does |
|------|-------------|
| `close_surface` | Close a terminal or browser pane |
| `stop_agent` | Gracefully stop an agent |
| `kill` | Force-kill agent processes |

</details>

## Supported Agents

| CLI | Command | Auto-detected |
|-----|---------|---------------|
| Claude Code | `claude` | status, model, tokens, context % |
| Codex | `codex` | status, model, context % |
| Gemini CLI | `gemini` | status, model, tokens, context % |
| Cursor | `cursor agent` | status, model, tokens, context % |
`read_screen` auto-detects agent type and parses metadata from terminal output.

## Architecture

```text
AI Agent  ─── MCP ───>  cmuxLayer  ─── Unix socket ───>  cmux
                         ├── Agent engine (spawn → monitor → teardown)
                         ├── Screen parser (5 agent formats)
                         ├── Mode policy (autonomous vs manual)
                         ├── State manager + event log
                         ├── Metacomm READ  — harness JSONL (real tokens/context/model)
                         └── Metacomm WRITE — per-agent inbox file + Monitor dispatch
```

The socket client connects to cmux via Unix socket. Auto-reconnects on disconnect, falls back to CLI subprocess if socket is unavailable.

| Connection | Latency | Speedup |
|------------|---------|---------|
| CLI subprocess | ~142ms | baseline |
| Unix socket | ~0.1ms | **1,423x** |

## Troubleshooting

**cmux is not running**
cmuxLayer requires a running [cmux](https://github.com/manaflow-ai/cmux) instance. Install it first, then start a cmux session before using cmuxLayer.

**Tools not appearing in Codex CLI or T3 Code**
Restart the client after adding `cmuxlayer` to `~/.codex/config.toml`. If you use a custom Codex home, verify `$CODEX_HOME/config.toml` contains the same `mcp_servers.cmux` entry.

**Tools not appearing in Claude Code**
Restart Claude Code after adding the MCP config. Run `claude mcp list` to verify cmuxlayer is connected.

**Socket connection failed**
cmuxLayer auto-discovers the cmux socket (macOS: `~/Library/Application Support/cmux/cmux.sock`). Override with `CMUX_SOCKET_PATH` if needed.

## Known Limitations

- **Tunnel Client Restart**: The `tunnel-client` and `chatgpt-mcp-cmux` processes must remain running locally. If the tunnel disconnects, you may need to restart the process and reconnect from the ChatGPT app.
- **Manual Authentication**: The current E2E workflow relies on manually obtaining the `CONTROL_PLANE_API_KEY` and `CONTROL_PLANE_TUNNEL_ID` from the OpenAI developer portal.
- **Agent Send Command**: Directly sending interactive commands via `send_command` is explicitly denied in secure mode. You must use `send_task` to dispatch natural language tasks to the AI agent's inbox instead.
- **File Reading Depth**: `project.tree` and `project.read_file` are strictly limited by `max_file_read_bytes` and depth. Very large repositories may truncate results to protect ChatGPT token context.

## Testing

```bash
npm run build
npm run typecheck
npm run test        # 800+ tests via vitest
```

## Git hooks

Enable project hooks to run the regression gate automatically on `git push`:

```bash
git config core.hooksPath .githooks
```

This enables `.githooks/pre-push`, which runs `scripts/run_tests.sh` and blocks pushes on regression failures.

## Development

```bash
npm install
npm run dev         # Run with tsx (hot reload)
npm run build       # Compile TypeScript
npm start           # Run compiled output
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

Part of the [Golems](https://github.com/EtanHey/golems) AI agent ecosystem. Original by [@EtanHey](https://github.com/EtanHey).
**Hardened, reworked, and securely deployed for ChatGPT by [@Danissimode](https://github.com/Danissimode).**
