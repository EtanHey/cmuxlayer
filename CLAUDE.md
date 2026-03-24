# cmuxlayer — Terminal Multiplexer MCP

> MCP server for multi-agent workspace orchestration via [cmux](https://github.com/manaflow-ai/cmux).

## Stack
- TypeScript + Zod, built with `tsc`, runs on Node 20+
- MCP SDK (`@modelcontextprotocol/sdk`)
- Persistent Unix socket connection to cmux (1,423x faster than CLI subprocess fallback)
- Vitest for testing (278 tests across 17 test files)

## Development
```bash
bun install
bun run dev          # Run with tsx (hot reload)
bun run build        # Compile TypeScript to dist/
bun run test         # 278 tests via vitest
bun run typecheck    # Type checking only
```

## Architecture

### MCP Tools (21 total)
- **11 core tools**: list_surfaces, new_split, send_input, send_key, read_screen, rename_tab, notify, set_status, set_progress, close_surface, browser_surface
- **10 agent lifecycle tools**: spawn_agent, send_to_agent, read_agent_output, get_agent_state, list_agents, wait_for, wait_for_all, stop_agent, kill, interact

### Key Source Files
| File | Role |
|------|------|
| `server.ts` | MCP tool registration and handlers (all 21 tools) |
| `cmux-socket-client.ts` | Persistent Unix socket to cmux |
| `cmux-client.ts` | CLI wrapper fallback |
| `agent-engine.ts` | Agent lifecycle — spawn, monitor, quality tracking |
| `agent-registry.ts` | Registry of active agents across surfaces |
| `screen-parser.ts` | Parse terminal output for agent type, model, tokens, context % |
| `mode-policy.ts` | Mode enforcement (autonomous vs manual) |
| `state-manager.ts` | Sidebar state synchronization |
| `naming.ts` | Surface naming rules (launcher prefix preservation) |
| `event-log.ts` | Audit trail for agent actions |
| `pattern-registry.ts` | Reusable workflow patterns |

### Connection Model
Socket client connects to cmux via Unix socket at the path provided by `cmux socket-path`.
Auto-reconnects on disconnect. Falls back to CLI subprocess if socket unavailable.

### Mode Policy
Two axes per surface:
- **control**: `autonomous` (full access) or `manual` (read-only for mutating tools)
- **intent**: `chat` or `audit`

### Claude Channels (Preview)
Set `CMUXLAYER_ENABLE_CLAUDE_CHANNELS=1` to enable one-way lifecycle notifications via `notifications/claude/channel`.

## Testing Conventions
- Test files mirror source: `src/foo.ts` -> `tests/foo.test.ts`
- Agent engine tests use 1-second timeouts for state change detection
- Server tests mock the cmux client via `createServer({ exec, skipAgentLifecycle })` pattern
- No integration tests requiring a running cmux instance — all mocked

## Key Patterns
- `ok(data)` / `err(error)` helpers for consistent MCP tool responses
- All tool handlers return `{ content: TextContent[], structuredContent?, isError? }`
- Screen parser recognizes Claude, Codex, Gemini, and Cursor agent output formats
- Agent lifecycle tools are registered conditionally (skipped when `skipAgentLifecycle: true`)
