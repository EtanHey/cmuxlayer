# @golems/cmux-mcp

MCP server for programmatic cmux terminal control. Wraps cmux CLI into 10 typed MCP tools.

## Tools

| Tool | Description |
|------|-------------|
| `list_surfaces` | List all surfaces across workspaces |
| `new_split` | Create a new split pane (terminal or browser) |
| `send_input` | Send text to a terminal surface (with optional enter/rename) |
| `send_key` | Send a key press to a surface |
| `read_screen` | Read screen content from a surface |
| `rename_tab` | Rename a surface tab (with optional prefix preservation) |
| `set_status` | Set sidebar status key-value pair |
| `set_progress` | Set sidebar progress indicator (0.0-1.0) |
| `close_surface` | Close a surface |
| `browser_surface` | Interact with browser surfaces |

## Usage

### As MCP server (stdio)

```json
{
  "mcpServers": {
    "cmux": {
      "command": "node",
      "args": ["~/Gits/orchestrator/tools/cmux-mcp/dist/index.js"]
    }
  }
}
```

### Development

```bash
npm install
npm test        # run tests (vitest)
npm run build   # compile TypeScript
npm run dev     # run with tsx (hot reload)
```

## Architecture

- `src/cmux-client.ts` — CLI wrapper (only file that knows shell commands)
- `src/server.ts` — MCP tool registration and handlers
- `src/naming.ts` — Surface naming rules (launcher prefix preservation)
- `src/mode-policy.ts` — Mode enforcement (manual = read-only)
- `src/types.ts` — Shared TypeScript types

## Mode Model

Two axes per surface:
- **control**: `autonomous` (full access) or `manual` (read-only for mutating tools)
- **intent**: `chat` or `audit`

Set via `set_status` with reserved keys `mode.control` / `mode.intent`.
