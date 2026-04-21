#!/usr/bin/env node

/**
 * cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.
 *
 * 29 MCP tools across two categories:
 *   Core (16): list_surfaces, select_workspace, new_split, new_surface,
 *              move_surface, reorder_surface, send_input, send_command,
 *              send_key, read_screen, rename_tab, notify, set_status,
 *              set_progress, close_surface, browser_surface
 *   Agent lifecycle (13): spawn_agent, resync_agents,
 *                         send_to (canonical), send_to_agent (deprecated alias),
 *                         read_agent_output, get_agent_state, list_agents,
 *                         my_agents, wait_for, wait_for_all, stop_agent,
 *                         kill, interact
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
  console.error("[cmuxlayer] fatal", error);
  process.exit(1);
});
