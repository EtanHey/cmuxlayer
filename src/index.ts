#!/usr/bin/env node

/**
 * @golems/cmux-mcp — MCP server for programmatic cmux terminal control.
 *
 * Exposes 10 tools:
 *   list_surfaces, new_split, send_input, send_key, read_screen,
 *   rename_tab, set_status, set_progress, close_surface, browser_surface
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[cmux-mcp] fatal", error);
  process.exit(1);
});
