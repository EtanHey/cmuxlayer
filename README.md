# cmuxLayer

**Your AI agents can't see each other's terminals.** One runs in tab 1, another in tab 2 — and you're the clipboard between them. cmuxLayer fixes that: 35 MCP tools that give AI agents programmatic control over terminal workspaces.

<p align="center">
  <img src="./assets/cmuxlayer-logo-split-pane-grid.svg" alt="cmuxLayer" width="96" height="96" />
</p>

[![install](https://img.shields.io/badge/install-npm%20install%20--g%20cmuxlayer-22c55e)](https://github.com/EtanHey/cmuxlayer#quick-start)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![MCP Tools](https://img.shields.io/badge/MCP-35%20tools-green.svg)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-798%20passing-brightgreen.svg)](#testing)

## Quick Start

```bash
brew install etanhey/layers/cmuxlayer       # stable, pinned release
brew install --HEAD etanhey/layers/cmuxlayer # or: dogfood the latest main
```

This installs the `cmuxlayer` command (plus `cmuxlayer-app-server` /
`cmuxlayer-proxy`). Requires [cmux](https://github.com/manaflow-ai/cmux) to be
running. For how the golem fleet wires, versions, and dogfoods it — and the
`CMUX_SOCKET_PATH` instance pin — see
[docs/releases-and-brew.md](docs/releases-and-brew.md).

Add to your MCP config:

**Codex CLI / T3 Code**

T3 Code inherits MCP servers from the Codex CLI config file at `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`).

```toml
[mcp_servers.cmuxlayer]
command = "cmuxlayer"
```

**Claude Code, Cursor, VS Code, Claude Desktop**

```json
{
  "mcpServers": {
    "cmuxlayer": {
      "command": "cmuxlayer"
    }
  }
}
```

To keep only a per-session resident subset of tools, set
`CMUXLAYER_DEFAULT_PALETTE` to comma-separated bare tool names, for example
`list_surfaces,spawn_agent,send_to`. The server also exposes `expand_palette`,
which makes every deferred tool available for the rest of that MCP session.
Unset or blank values preserve the full tool list; unknown names are warned and
ignored while valid names still load.

> **Config locations:** Codex CLI / T3 Code `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) | Claude Code `.mcp.json` or `claude mcp add cmuxlayer -s user -- cmuxlayer` | Cursor `.cursor/mcp.json` | VS Code `.vscode/mcp.json` | Claude Desktop — see [MCP docs](https://modelcontextprotocol.io/quickstart/user) for platform-specific paths

## What You Can Do

Tell your AI agent things like:

- *"Split a pane to the right and run my test suite there"*
- *"Spawn a Claude Code agent in a new pane to refactor auth.ts"*
- *"Read the screen of surface:2 and tell me if the build passed"*
- *"Wait for all agents to finish, then read their output"*
- *"Set the sidebar status to show our deploy progress"*

Under the hood, cmuxLayer exposes 35 MCP tools for terminal control, screen reading, layout management, and multi-agent orchestration. `read_screen` parses agent metadata (status, model, tokens, context %) for Claude Code, Codex, Gemini, and Cursor.

## Agent Routing Workflow

For managed agents, use the agent-first path: `list_agents` to find the target, `send_to` to deliver work by `agent_id`, then `wait_for` when you need completion. Raw surface tools such as `send_input`, `send_command`, and `send_key` are still available for shells, launch/resume commands, stuck-pane recovery, and explicit terminal UI operations.

See [Agent Routing and Handling Workflow](docs/agent-routing-and-handling.md) for the full operator playbook, including stuck surface recovery and safe `/mcp` menu reconnects.

## MCP Tools (35)

All tools ship with [ToolAnnotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) for automatic safety policy enforcement.

**Terminal control** — `list_surfaces` `control_health` `select_workspace` `create_workspace` `new_split` `new_surface` `move_surface` `reorder_surface` `send_input` `send_command` `send_key` `read_screen` `rename_tab` `close_surface` `browser_surface`

**Agent lifecycle** — `spawn_agent` `new_worktree_split` `spawn_in_workspace` `resync_agents` `send_to` `send_to_agent` `wait_for` `wait_for_all` `interact` `stop_agent` `kill`

**Metacomm (agent inbox)** — `dispatch_to_agent` `inbox_check`

**Workspace state** — `list_agents` `my_agents` `get_agent_state` `read_agent_output` `notify` `set_status` `set_progress`

<details>
<summary>Full tool reference (35 tools)</summary>

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
Restart the client after adding `cmuxlayer` to `~/.codex/config.toml`. If you use a custom Codex home, verify `$CODEX_HOME/config.toml` contains the same `mcp_servers.cmuxlayer` entry.

**Tools not appearing in Claude Code**
Restart Claude Code after adding the MCP config. Run `claude mcp list` to verify cmuxlayer is connected.

**Socket connection failed**
cmuxLayer auto-discovers the cmux socket (macOS: `~/Library/Application Support/cmux/cmux.sock`). Override with `CMUX_SOCKET_PATH` if needed.

## Testing

```bash
bun run test        # 798 tests via vitest
npm run typecheck   # Type checking
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

Part of the [Golems](https://github.com/EtanHey/golems) AI agent ecosystem. [cmuxlayer.etanheyman.com](https://cmuxlayer.etanheyman.com) | Built by [@EtanHey](https://github.com/EtanHey).
