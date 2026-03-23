#!/usr/bin/env node

/**
 * @golems/cmux-mcp — MCP server for programmatic cmux terminal control.
 *
 * Exposes 11 tools:
 *   list_surfaces, new_split, send_input, send_key, read_screen,
 *   rename_tab, notify, set_status, set_progress, close_surface,
 *   browser_surface
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createCmuxClient } from "./cmux-client-factory.js";

async function main() {
  const client = await createCmuxClient();
  const server = createServer({ client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[cmux-mcp] fatal", error);
  process.exit(1);
});
