# cmuxlayer

> Terminal multiplexer MCP — multi-agent workspace orchestration for [cmux](https://github.com/manaflow-ai/cmux).

<p align="center">
  <img src="./assets/cmuxlayer-logo-split-pane-grid.svg" alt="cmuxlayer Split Pane Grid logo" width="96" height="96" />
</p>

[![cmuxlayer MCP server](https://glama.ai/mcp/servers/EtanHey/cmuxlayer/badges/card.svg)](https://glama.ai/mcp/servers/EtanHey/cmuxlayer)

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-233%20passing-brightgreen.svg)](#testing)
[![MCP](https://img.shields.io/badge/MCP-10%20tools-green.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

---

**233 tests** · **1,423x socket speedup** · **Native MCP in cmux Swift fork** · **10 MCP tools** · **Agent lifecycle engine**

cmuxlayer gives AI agents programmatic control over terminal workspaces via MCP. Spawn split panes, send commands, read screen output, manage agent lifecycles — all through typed MCP tools that any MCP-compatible AI client can use.

`read_screen` returns raw terminal text alongside structured parsed agent metadata for common CLI agents including Claude, Codex, and Gemini. That makes status checks, done-signal detection, token counting, and model extraction available directly through MCP without forcing each client to re-parse terminal output.

## Quick Start

```bash
git clone https://github.com/EtanHey/cmuxlayer.git && cd cmuxlayer
bun install
bun run build
```

Add to your editor's MCP config:

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

## MCP Tools (10)

| Tool | Description |
|------|-------------|
| `list_surfaces` | List all surfaces across workspaces |
| `new_split` | Create a new split pane (terminal or browser) |
| `send_input` | Send text to a terminal surface (with optional enter/rename) |
| `send_key` | Send a key press to a surface |
| `read_screen` | Read raw screen text plus parsed agent state from a surface |
| `rename_tab` | Rename a surface tab (with optional prefix preservation) |
| `set_status` | Set sidebar status key-value pair |
| `set_progress` | Set sidebar progress indicator (0.0-1.0) |
| `close_surface` | Close a surface |
| `browser_surface` | Interact with browser surfaces |

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
bun run test        # 230 tests via vitest
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