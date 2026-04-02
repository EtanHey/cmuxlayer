# cmuxLayer

**Your AI agents can't see each other's terminals.** One runs in tab 1, another in tab 2 — and you're the clipboard between them. cmuxLayer fixes that: 22 MCP tools that give AI agents programmatic control over terminal workspaces.

<p align="center">
  <img src="./assets/cmuxlayer-logo-split-pane-grid.svg" alt="cmuxLayer" width="96" height="96" />
</p>

[![npm](https://img.shields.io/npm/v/cmuxlayer?color=22c55e)](https://www.npmjs.com/package/cmuxlayer)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![MCP Tools](https://img.shields.io/badge/MCP-22%20tools-green.svg)](https://modelcontextprotocol.io)
[![Tests](https://img.shields.io/badge/tests-335%20passing-brightgreen.svg)](#testing)

## Quick Start

```bash
npm install -g cmuxlayer
```

Add to your MCP config (Claude Code, Cursor, VS Code, etc.):

```json
{
  "mcpServers": {
    "cmux": {
      "command": "cmuxlayer"
    }
  }
}
```

Requires [cmux](https://github.com/manaflow-ai/cmux) to be running.

## What it does

Spawn split panes, send commands, read screen output, and manage agent lifecycles — all through typed MCP tools. `read_screen` returns raw terminal text alongside parsed agent metadata (status, model, tokens, context %, done signals) for Claude Code, Codex, Gemini, Cursor, and Kiro.

## MCP Tools (22)

All tools ship with [ToolAnnotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) so MCP clients can enforce safety policies automatically.

### Read-only (5)

| Tool | Description |
|------|-------------|
| `list_surfaces` | List all surfaces across workspaces |
| `read_screen` | Read terminal screen with parsed agent status |
| `get_agent_state` | Get full state of a tracked agent |
| `list_agents` | List all agents with optional filters |
| `my_agents` | Get children of a parent agent with live screen status |
| `read_agent_output` | Extract structured output between delimiter markers |

### Mutating (13)

| Tool | Description |
|------|-------------|
| `new_split` | Create a new terminal or browser split pane |
| `send_input` | Send text input to a terminal surface |
| `send_key` | Send key press (return, escape, ctrl-c, etc.) |
| `rename_tab` | Rename a surface tab |
| `notify` | Show a cmux notification banner |
| `set_status` | Set sidebar status key-value pair |
| `set_progress` | Set sidebar progress indicator (0.0-1.0) |
| `browser_surface` | Interact with browser surfaces (navigate, click, eval) |
| `spawn_agent` | Spawn a CLI agent in a new pane |
| `send_to_agent` | Send a prompt or message to a running agent |
| `wait_for` | Block until an agent reaches a target state |
| `wait_for_all` | Block until multiple agents finish |
| `interact` | Send interactive input (confirm, cancel, skill, resume) |

### Destructive (3)

| Tool | Description |
|------|-------------|
| `close_surface` | Close a terminal or browser pane |
| `stop_agent` | Gracefully stop a running agent |
| `kill` | Force-kill one or more agent processes |

## Supported Agents

| CLI | Command |
|-----|---------|
| Claude Code | `claude` |
| Codex | `codex` |
| Gemini CLI | `gemini` |
| Cursor | `cursor agent` |
| Kiro | `kiro-cli` |

`read_screen` auto-detects agent type and parses status, model, token count, and context percentage from terminal output.

## Architecture

```
AI Agent  ─── MCP ───>  cmuxLayer
                         ├── Persistent Unix socket (0.1ms, 1,423x faster than CLI)
                         ├── Agent lifecycle engine (spawn → monitor → teardown)
                         ├── Screen parser (auto-detect Claude/Codex/Gemini/Cursor/Kiro)
                         ├── Mode policy (autonomous vs manual control)
                         └── State manager + event log
```

The socket client connects to cmux via Unix socket at the path from `cmux socket-path`. Auto-reconnects on disconnect, falls back to CLI subprocess if socket is unavailable.

| Method | Latency |
|--------|---------|
| CLI subprocess | ~142ms |
| Persistent socket | ~0.1ms (**1,423x faster**) |

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
