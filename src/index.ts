#!/usr/bin/env node

/**
 * cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.
 *
 * 22 MCP tools across two categories:
 *   Core (11): list_surfaces, new_split, send_input, send_key, read_screen,
 *              rename_tab, notify, set_status, set_progress, close_surface,
 *              browser_surface
 *   Agent lifecycle (11): spawn_agent, send_to_agent, read_agent_output,
 *                         get_agent_state, list_agents, my_agents, wait_for,
 *                         wait_for_all, stop_agent, kill, interact
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
