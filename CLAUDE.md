# cmuxlayer — Terminal Multiplexer MCP

> MCP server for multi-agent workspace orchestration via [cmux](https://github.com/manaflow-ai/cmux).

## Stack
- TypeScript + Zod, built with `tsc`, runs on Node 20+
- MCP SDK (`@modelcontextprotocol/sdk`)
- Persistent Unix socket connection to cmux (1,423x faster than CLI subprocess fallback)
- Vitest for testing (335 tests across 20 test files)

## Development
```bash
bun install
bun run dev          # Run with tsx (hot reload)
bun run build        # Compile TypeScript to dist/
bun run test         # 335 tests via vitest
bun run typecheck    # Type checking only
```

## Architecture

### MCP Tools (33 total)
- **33 registered tools**: terminal control, browser surface control, workspace state, agent lifecycle orchestration, and the metacommlayer write channel (dispatch_to_agent, inbox_check).

### Key Source Files
| File | Role |
|------|------|
| `server.ts` | MCP tool registration and handlers (all 33 tools) |
| `harness-session.ts` | metacommlayer READ channel — real agent state (tokens/context/model) from harness transcript JSONL (see docs/harness-jsonl-field-map.md) |
| `inbox.ts` | metacommlayer WRITE channel — per-agent inbox file dispatch + replay/ack/heartbeat (Monitor-driven, send_input fallback) |
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

**Instance pinning (`CMUX_SOCKET_PATH`).** cmux exports `CMUX_SOCKET_PATH` into each agent's
environment, pointing at the instance that spawned it. When set (or `socketPath` is passed),
cmuxlayer binds to **that one instance only** and never falls through to another live cmux's
socket — this is what keeps a worker from opening in a *different* cmux app/window (e.g. stable
vs nightly). When it is unset and more than one cmux socket answers, the factory logs which one
it bound to and how to pin it. Set `CMUX_SOCKET_PATH` to force the MCP onto the instance you are
actually using.

### Placement & teardown invariants
- **Same workspace by default.** A spawned worker inherits its parent orchestrator's
  `workspace_id` before any repo-name resolution, so co-working agents land in the same
  workspace (split to the right) instead of a new one — even for worktree workers whose cwd
  (`~/Gits/<repo>.wt/<name>`) does not match the repo name. An explicit `workspace` arg still wins.
- **Panes are protected.** Automatic/idle pane closing is disabled (#170). `close_surface`
  refuses to destroy a surface backing a still-live agent unless `force: true`, and returns a
  fresh pane read on refusal so callers verify the real screen rather than a stale state record.
- **Sleep survival is launchd-backed.** The durable guard lives in `launchd/cmux-caffeinate/`;
  see [docs/sleep-survival.md](docs/sleep-survival.md) before changing sleep assertions.

### Distribution & releases
The fleet runs the **brew-pinned** binary, not a working tree. Source of truth is
`~/.golems/config.yaml` (`mcpServers.cmux`); `golems/scripts/sync-config.sh --enforce`
regenerates each repo's `~/Gits/<repo>/.mcp.json` (generated — don't hand-edit),
which points at `~/.golems/bin/cmuxlayer-mcp` (launcher) → `brew --prefix`/opt/cmuxlayer/bin/cmuxlayer.
Set `CMUXLAYER_DEV=1` to run your live source instead. Cut a release with `scripts/release.sh <X.Y.Z>` (bumps
package.json → tags → bumps the `EtanHey/homebrew-layers` formula → pushes).
Dogfood latest main with `brew install --HEAD etanhey/layers/cmuxlayer`.
Full guide: [docs/releases-and-brew.md](docs/releases-and-brew.md).

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
