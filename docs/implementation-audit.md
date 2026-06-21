# Implementation Audit — ChatGPTMCPcmux Secure MCP Gateway

## 1. Current Package Manager
- **Primary**: `npm` (package-lock.json existed)
- **Secondary evidence**: pnpm-lock.yaml also existed
- **Scripts available**:
  - `npm run dev` (tsx src/index.ts)
  - `npm run build` (tsc)
  - `npm start` (node dist/index.js)
  - `npm run typecheck` (tsc --noEmit)
  - `npm test` (vitest run)
  - `npm run test:watch` (vitest)

## 2. Commands That Work
- `npm run typecheck` — requires npm install first
- `npm test` — requires npm install first
- `npm run build` — requires npm install first
- Need to run `npm install` to verify (blocked by environment issues, but should work on target MacBook)

## 3. MCP Server Initialization
- **Entry point**: `src/index.ts`
- **Server factory**: `src/server.ts` → `createServer(opts?: CreateServerOptions)`
- **Transport**: `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
- **Server class**: `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`

## 4. Tool Registration Location
All tools registered in `src/server.ts` via `server.tool(name, description, schema, annotations, handler)`.

## 5. stdio Transport
**Yes, exists.** The default mode uses `StdioServerTransport`. Activated when running `cmuxlayer` without arguments or `cmuxlayer stdio`.

## 6. HTTP Transport
**No existing HTTP transport.** The repo has:
- `src/app-server-index.ts` — JSON-RPC stdin/stdout bridge for Codex
- `src/app-server-bridge.ts` — `CodexAppServerBridge` class for thread/turn management
- `src/app-server-runtime.ts` — `CmuxAppServerRuntime`
- But NO HTTP server for remote MCP. Must build from scratch.

## 7. Tools Exported (35 total)

### Read-Only (13 tools):
| # | Tool Name | Annotation |
|---|-----------|------------|
| 1 | list_surfaces | readOnly |
| 2 | control_health | readOnly |
| 3 | read_screen | readOnly |
| 4 | inbox_check | readOnly |
| 5 | wait_for | readOnly (waits, no mutation) |
| 6 | wait_for_all | readOnly |
| 7 | get_agent_state | readOnly |
| 8 | list_agents | readOnly |
| 9 | my_agents | readOnly |
| 10 | resync_agents | readOnly |
| 11 | dispatch_to_agent | mutating (writes to inbox file) |

### Mutating (15 tools):
| # | Tool Name | Annotation |
|---|-----------|------------|
| 12 | select_workspace | mutating |
| 13 | create_workspace | mutating |
| 14 | new_split | mutating |
| 15 | new_surface | mutating |
| 16 | move_surface | mutating |
| 17 | reorder_surface | mutating |
| 18 | send_input | mutating |
| 19 | send_command | mutating |
| 20 | send_key | mutating |
| 21 | rename_tab | mutating |
| 22 | notify | mutating |
| 23 | set_status | mutating |
| 24 | set_progress | mutating |

### Destructive (7 tools):
| # | Tool Name | Annotation |
|---|-----------|------------|
| 25 | close_surface | destructive |
| 26 | browser_surface | mutating |
| 27 | spawn_agent | mutating |
| 28 | new_worktree_split | mutating |
| 29 | spawn_in_workspace | mutating |
| 30 | send_to | mutating |
| 31 | send_to_agent | mutating (deprecated alias) |
| 32 | read_agent_output | readOnly |
| 33 | stop_agent | destructive |
| 34 | kill | destructive |
| 35 | interact | mutating |

## 8. Read-Only Tools
- list_surfaces, control_health, read_screen, inbox_check
- wait_for, wait_for_all, get_agent_state, list_agents, my_agents
- resync_agents, read_agent_output

## 9. Mutating Tools
- select_workspace, create_workspace, new_split, new_surface
- move_surface, reorder_surface, send_input, send_command, send_key
- rename_tab, notify, set_status, set_progress
- browser_surface, spawn_agent, new_worktree_split
- spawn_in_workspace, send_to, send_to_agent, interact

## 10. Destructive Tools
- close_surface, stop_agent, kill

## 11. Best Place for Tool Wrapper
The `server.tool()` calls in `src/server.ts` are the integration point. We have two approaches:

**Approach A (recommended)**: Create a new `src/server-secure.ts` that:
1. Creates the base server via `createServer()` from `server.ts`
2. Wraps/wraps each tool with security checks via `wrapTool()`
3. Only exposes safe tool names (system.*, project.*, cmux.*, agent.*, audit.*)

**Approach B**: Create a proxy/wrapper around the `McpServer` instance that intercepts tool calls.

**Decision**: Use Approach A — create a new server factory `createSecureServer()` that composes with the existing `createServer()` but adds the security layer on top.

## 12. Files to Change for Secure Mode

### New files (~25):
- `src/secure/errors.ts`
- `src/secure/policy-schema.ts`
- `src/secure/policy.ts`
- `src/secure/auth.ts`
- `src/secure/redactor.ts`
- `src/secure/path-guard.ts`
- `src/secure/command-guard.ts`
- `src/secure/audit.ts`
- `src/secure/limits.ts`
- `src/secure/tool-policy.ts`
- `src/secure/tool-wrapper.ts`
- `src/remote/http-server.ts`
- `src/remote/mcp-http-transport.ts`
- `src/remote/health.ts`
- `src/tools/secure-system-tools.ts`
- `src/tools/secure-project-tools.ts`
- `src/tools/secure-cmux-tools.ts`
- `src/tools/secure-agent-tools.ts`
- `src/tools/secure-audit-tools.ts`
- `src/server-secure.ts`
- `src/index-secure.ts` (or extend index.ts)
- `config/policy.example.yaml`
- Tests in `tests/security/` and `tests/remote/`
- Scripts in `scripts/`
- `launchd/com.danil.chatgpt-mcp-cmux.plist`

### Modified files (~3):
- `src/index.ts` — add serve-http command
- `package.json` — add new bin entries if needed
- `README.md` — update documentation

## 13. Key Architecture Notes
- The existing `createServer()` returns an `McpServer` instance with tools already registered
- The `CmuxServerContext` carries state (client, stateMgr, registry, deliveries, etc.)
- For HTTP mode, we need to expose a filtered view of the tools
- The `StdioServerTransport` cannot be reused for HTTP — need a different transport
- The MCP SDK v1.12.0 may have HTTP transport support — need to check

## 14. Risks
1. **MCP SDK HTTP transport**: If `@modelcontextprotocol/sdk@1.12.0` doesn't have a built-in HTTP transport, we'll need to implement JSON-RPC over HTTP manually.
2. **Tool name mapping**: Upstream tools use flat names like `list_surfaces`; secure mode uses namespaced names like `cmux.list_surfaces`. Need a bidirectional mapping.
3. **Agent registry filtering**: The agent registry (`src/agent-registry.ts`) doesn't support prefix filtering natively — need to filter at the tool wrapper level.
4. **State isolation**: HTTP mode may have multiple concurrent requests — the current context is shared, which is fine, but we need to ensure audit logging is concurrency-safe.

## 15. Recommended Implementation Order
1. Security primitives (policy, auth, audit, redaction, path-guard)
2. Tool wrapper
3. HTTP server
4. Safe tool implementations
5. Tests
6. Scripts and docs
