# cmuxLayer

**Your AI agents can't see each other's terminals.** One runs in tab 1, another in tab 2 — and you're the clipboard between them. cmuxLayer fixes that: 22 MCP tools that give AI agents programmatic control over terminal workspaces.

<p align="center">
  <img src="./assets/cmuxlayer-logo-split-pane-grid.svg" alt="cmuxLayer" width="96" height="96" />
</p>

[![install](https://img.shields.io/badge/install-npm%20install%20--g%20cmuxlayer-22c55e)](https://github.com/EtanHey/cmuxlayer#quick-start)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![MCP Tools](https://img.shields.io/badge/MCP-22%20tools-green.svg)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-335%20passing-brightgreen.svg)](#testing)

## Quick Start

```bash
npm install -g cmuxlayer
```

Requires [cmux](https://github.com/manaflow-ai/cmux) to be running.

Add to your MCP config (Claude Code, Cursor, VS Code, Claude Desktop):

```json
{
  "mcpServers": {
    "cmux": {
      "command": "cmuxlayer"
    }
  }
}
```

> **Config locations:** Claude Code `.mcp.json` or `claude mcp add cmuxlayer -s user -- cmuxlayer` | Cursor `.cursor/mcp.json` | VS Code `.vscode/mcp.json` | Claude Desktop — see [MCP docs](https://modelcontextprotocol.io/quickstart/user) for platform-specific paths

## What You Can Do

Tell your AI agent things like:

- *"Split a pane to the right and run my test suite there"*
- *"Spawn a Claude Code agent in a new pane to refactor auth.ts"*
- *"Read the screen of surface:2 and tell me if the build passed"*
- *"Wait for all agents to finish, then read their output"*
- *"Set the sidebar status to show our deploy progress"*

Under the hood, cmuxLayer exposes 22 MCP tools for terminal control, screen reading, and multi-agent orchestration. `read_screen` parses agent metadata (status, model, tokens, context %) for Claude Code, Codex, Gemini, Cursor, and Kiro.

## MCP Tools (22)

All tools ship with [ToolAnnotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) for automatic safety policy enforcement.

**Terminal control** — `new_split` `send_input` `send_key` `read_screen` `rename_tab` `close_surface` `browser_surface`

**Agent lifecycle** — `spawn_agent` `send_to_agent` `wait_for` `wait_for_all` `interact` `stop_agent` `kill`

**Workspace** — `list_surfaces` `list_agents` `my_agents` `get_agent_state` `read_agent_output` `notify` `set_status` `set_progress`

<details>
<summary>Full tool reference (22 tools)</summary>

### Read-only (6)

| Tool | What it does |
|------|-------------|
| `list_surfaces` | List all surfaces across workspaces |
| `read_screen` | Read terminal output with parsed agent status |
| `get_agent_state` | Full state of a tracked agent |
| `list_agents` | All agents, with optional filters |
| `my_agents` | Children of a parent agent with live screen status |
| `read_agent_output` | Structured output between delimiter markers |

### Mutating (13)

| Tool | What it does |
|------|-------------|
| `new_split` | Create a terminal or browser split pane |
| `send_input` | Send text to a surface |
| `send_key` | Send key press (return, escape, ctrl-c, etc.) |
| `rename_tab` | Rename a surface tab |
| `notify` | Show a cmux notification banner |
| `set_status` | Set sidebar status key-value pair |
| `set_progress` | Set progress indicator (0.0-1.0) |
| `browser_surface` | Interact with browser surfaces |
| `spawn_agent` | Spawn a CLI agent in a new pane |
| `send_to_agent` | Send a prompt to a running agent |
| `wait_for` | Block until agent reaches a target state |
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
| Codex | `codex` | status, model |
| Gemini CLI | `gemini` | status, model |
| Cursor | `cursor agent` | status |
| Kiro | `kiro-cli` | status |

`read_screen` auto-detects agent type and parses metadata from terminal output.

## Architecture

```text
AI Agent  ─── MCP ───>  cmuxLayer  ─── Unix socket ───>  cmux
                         ├── Agent engine (spawn → monitor → teardown)
                         ├── Screen parser (5 agent formats)
                         ├── Mode policy (autonomous vs manual)
                         └── State manager + event log
```

The socket client connects to cmux via Unix socket. Auto-reconnects on disconnect, falls back to CLI subprocess if socket is unavailable.

| Connection | Latency | Speedup |
|------------|---------|---------|
| CLI subprocess | ~142ms | baseline |
| Unix socket | ~0.1ms | **1,423x** |

## Troubleshooting

**cmux is not running**
cmuxLayer requires a running [cmux](https://github.com/manaflow-ai/cmux) instance. Install it first, then start a cmux session before using cmuxLayer.

**Tools not appearing in Claude Code**
Restart Claude Code after adding the MCP config. Run `claude mcp list` to verify cmuxlayer is connected.

**Socket connection failed**
cmuxLayer auto-discovers the cmux socket (macOS: `~/Library/Application Support/cmux/cmux.sock`). Override with `CMUX_SOCKET_PATH` if needed.

## Testing

```bash
npm test            # 335 tests via vitest
npm run typecheck   # Type checking
```

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
