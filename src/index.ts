#!/usr/bin/env node

/**
 * @golems/cmux-mcp — MCP server for programmatic cmux terminal control.
 *
 * Exposes 21 tools by default:
 *   11 surface/workspace tools plus 10 agent lifecycle tools
 *   (pass skipAgentLifecycle=true to createServer() for the low-level subset)
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
