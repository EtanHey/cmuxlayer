# cmuxlayer

> Terminal multiplexer MCP — multi-agent workspace orchestration for [cmux](https://github.com/manaflow-ai/cmux).

<p align="center">
  <img src="./assets/cmuxlayer-logo-split-pane-grid.svg" alt="cmuxlayer Split Pane Grid logo" width="96" height="96" />
</p>

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-326%20passing-brightgreen.svg)](#testing)
[![MCP](https://img.shields.io/badge/MCP-22%20tools-green.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

---

**326 tests** · **1,423x socket speedup** · **Native MCP in cmux Swift fork** · **22 MCP tools** · **Agent lifecycle engine**

cmuxlayer gives AI agents programmatic control over terminal workspaces via MCP. Spawn split panes, send commands, read screen output, manage agent lifecycles — all through typed MCP tools that any MCP-compatible AI client can use.

`read_screen` returns raw terminal text alongside structured parsed agent metadata for common CLI agents including Claude, Codex, and Gemini. That makes status checks, done-signal detection, token counting, and model extraction available directly through MCP without forcing each client to re-parse terminal output.

## Install

```bash
npm install -g cmuxlayer
```

Or from source:

```bash
git clone https://github.com/EtanHey/cmuxlayer.git && cd cmuxlayer
npm install && npm run build
```

## Quick Start

Add to your editor's MCP config (Claude Code `settings.json`, VS Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "cmux": {
      "command": "cmuxlayer"
    }
  }
}
```

Or with a local build:

```json
{
  "mcpServers": {
    "cmux": {
      "command": "node",
      "args": ["/path/to/cmuxlayer/dist/index.js"]
    }
  }
}
```

Requires [cmux](https://github.com/manaflow-ai/cmux) to be installed and running.

## Claude Channels Preview

Set `CMUXLAYER_ENABLE_CLAUDE_CHANNELS=1` in the server environment and launch Claude Code with `--channels <server-name>` plus `--dangerously-load-development-channels <server-name>` during preview. With that enabled, cmuxlayer advertises `experimental["claude/channel"]` and emits one-way `notifications/claude/channel` updates when tracked agents are spawned, finish, or error.

See [docs/claude-channels-mobile.md](docs/claude-channels-mobile.md) for the notification format, OpenClaw pairing patterns worth stealing, and the remaining gaps for a real cmux mobile client.

## MCP Tools (22)

All 22 tools ship with [ToolAnnotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so MCP clients can enforce safety policies automatically.

### Core (11)

| Tool | Annotation | Description |
|------|------------|-------------|
| `list_surfaces` | readOnly | List all surfaces across workspaces |
| `new_split` | mutating | Create a new split pane (terminal or browser) |
| `send_input` | mutating | Send text to a terminal surface (with optional enter/rename) |
| `send_key` | mutating | Send a key press to a surface |
| `read_screen` | readOnly | Read raw screen text plus parsed agent state from a surface |
| `rename_tab` | mutating | Rename a surface tab (with optional prefix preservation) |
| `notify` | mutating | Show a cmux notification banner |
| `set_status` | mutating | Set sidebar status key-value pair |
| `set_progress` | mutating | Set sidebar progress indicator (0.0-1.0) |
| `close_surface` | destructive | Close a surface |
| `browser_surface` | mutating | Interact with browser surfaces |

### Agent Lifecycle (11)

| Tool | Annotation | Description |
|------|------------|-------------|
| `spawn_agent` | mutating | Spawn a CLI agent in a new or existing surface |
| `send_to_agent` | mutating | Send a prompt or message to a running agent |
| `read_agent_output` | readOnly | Read recent output from an agent's surface |
| `get_agent_state` | readOnly | Get current state of a tracked agent |
| `list_agents` | readOnly | List all tracked agents and their states |
| `my_agents` | readOnly | Get all children of a parent agent with live screen status |
| `wait_for` | mutating | Wait for an agent to reach a target state (with timeout) |
| `wait_for_all` | mutating | Wait for multiple agents to reach target states |
| `stop_agent` | destructive | Gracefully stop a running agent |
| `kill` | destructive | Force-kill one or more agent processes |
| `interact` | mutating | Send interactive input (confirm, cancel, etc.) to an agent |

## Architecture

```
AI Agent  ─── MCP ───>  cmuxlayer
                         ├── Persistent socket connection (1,423x faster than CLI)
                         ├── Agent lifecycle engine (spawn, monitor, teardown)
                         ├── Mode policy (autonomous vs manual control)
                         ├── Event log + state manager
                         └── Pattern registry for naming conventions
```

### Key Components

| File | Role |
|------|------|
| `cmux-socket-client.ts` | Persistent Unix socket connection to cmux (1,423x speedup over CLI) |
| `cmux-client.ts` | CLI wrapper fallback |
| `server.ts` | MCP tool registration and handlers |
| `agent-engine.ts` | Agent lifecycle — spawn, monitor, quality tracking |
| `agent-registry.ts` | Registry of active agents across surfaces |
| `naming.ts` | Surface naming rules (launcher prefix preservation) |
| `mode-policy.ts` | Mode enforcement (autonomous = full access, manual = read-only) |
| `state-manager.ts` | Sidebar state synchronization |
| `screen-parser.ts` | Parse terminal output to extract agent type, model, token count, context % |
| `event-log.ts` | Audit trail for all agent actions |
| `pattern-registry.ts` | Reusable patterns for common workflows |

## Mode Model

Two axes per surface:

- **control**: `autonomous` (full access) or `manual` (read-only for mutating tools)
- **intent**: `chat` or `audit`

Set via `set_status` with reserved keys `mode.control` / `mode.intent`.

## Socket Performance

cmuxlayer connects to cmux via a persistent Unix socket instead of spawning CLI subprocesses:

| Method | Latency | Throughput |
|--------|---------|------------|
| CLI subprocess | ~142ms | Baseline |
| Persistent socket | ~0.1ms | **1,423x faster** |

The socket client auto-reconnects on disconnect and falls back to CLI if the socket is unavailable.

## Upstream Contributions

cmuxlayer development has contributed back to cmux:

| PR | Status | What |
|----|--------|------|
| [#1522](https://github.com/manaflow-ai/cmux/pull/1522) | Open | Fix: background workspace PTY initialization |
| [#1562](https://github.com/manaflow-ai/cmux/pull/1562) | Open | Fix: thread starvation in MCP server |

## Testing

```bash
bun run test        # 326 tests via vitest
bun run typecheck   # Type checking
```

## Development

```bash
bun install
bun run dev         # Run with tsx (hot reload)
bun run build       # Compile TypeScript
bun run start       # Run compiled output
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and PR guidelines.

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

Part of the [Golems](https://github.com/EtanHey/golems) AI agent ecosystem. Built by [@EtanHey](https://github.com/EtanHey).
