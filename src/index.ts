#!/usr/bin/env node

/**
 * cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.
 *
 * 35 MCP tools across three categories (keep in sync with server.ts and the
 * "total tool count" assertion in tests/server-agent-tools.test.ts):
 *   Core (18): list_surfaces, control_health, select_workspace,
 *              create_workspace, new_split, new_surface, move_surface,
 *              reorder_surface, send_input, send_command, send_key,
 *              read_screen, rename_tab, notify, set_status, set_progress,
 *              close_surface, browser_surface
 *   Metacommlayer write channel (2): dispatch_to_agent, inbox_check
 *   Agent lifecycle (13): spawn_agent, new_worktree_split, spawn_in_workspace,
 *                         resync_agents,
 *                         send_to (canonical), send_to_agent (deprecated alias),
 *                         read_agent_output, get_agent_state, list_agents,
 *                         my_agents, wait_for, wait_for_all, stop_agent
 *   V2 agent controls (2): kill, interact
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
