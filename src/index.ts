#!/usr/bin/env node

/**
 * cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.
 *
 * 41 MCP tools across four categories (keep in sync with server.ts and the
 * "total tool count" assertion in tests/server-agent-tools.test.ts):
 *   Core (18): list_surfaces, control_health, select_workspace,
 *              create_workspace, new_split, new_surface, move_surface,
 *              reorder_surface, send_input, send_command, send_key,
 *              read_screen, rename_tab, notify, set_status, set_progress,
 *              close_surface, browser_surface
 *   Metacommlayer write channel (2): dispatch_to_agent, inbox_check
 *   Monitor registry (5): register_monitor, signal_monitor,
 *                         deregister_monitor, list_monitors,
 *                         query_monitor_registry
 *   Agent lifecycle (16): spawn_agent, new_worktree_split, spawn_in_workspace,
 *                         resync_agents,
 *                         send_to (canonical), send_to_agent (deprecated alias),
 *                         supersede_agent_goal, read_agent_output,
 *                         get_agent_state, list_agents, my_agents, wait_for,
 *                         wait_for_all, stop_agent, kill, interact
 */

import { renderDoctorJson, renderDoctorText, runDoctor } from "./doctor.js";
import { readVersion } from "./version.js";
import { runDaemonFirstEntry } from "./entry.js";

const HELP_TEXT = `cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.

Usage:
  cmuxlayer            Start the MCP server on stdio (the normal mode; an MCP
                       client such as cmux/Claude Code launches it and speaks
                       JSON-RPC over stdin/stdout).
  cmuxlayer --version  Print the version and exit.
  cmuxlayer --help     Print this help and exit.
  cmuxlayer doctor     Run non-interactive health checks (Robust Brew Layer
                       standard §0/§1/§3/§6) and exit. Read-only; no mutation.
                       Add --json for machine-readable output. Exits 0 when
                       healthy.

Environment:
  CMUX_SOCKET_PATH     Pin the MCP to a specific cmux instance's Unix socket
                       (authoritative — never falls through to another instance).
  CMUXLAYER_DAEMON_SOCKET
                       Override the cmuxlayer daemon Unix socket. Defaults to
                       ~/.local/state/cmux/cmuxlayer-stated.sock.
  CMUXLAYER_FORCE_INPROCESS=1
                       Escape hatch: run the legacy in-process MCP runtime and
                       log/surface a warning in control_health.
`;

async function main() {
  const arg = process.argv[2];
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`cmuxlayer ${readVersion()}\n`);
    return;
  }
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (arg === "doctor") {
    // Non-interactive, read-only health check (Robust Brew Layer standard).
    // Best-effort brew probes; exits 0 when healthy, 1 otherwise — so a runbook
    // can branch on the code. No bare sudo; never prompts.
    const json = process.argv.includes("--json");
    const report = await runDoctor({ version: readVersion() });
    process.stdout.write(
      (json ? renderDoctorJson(report) : renderDoctorText(report)) + "\n",
    );
    process.exitCode = report.healthy ? 0 : 1;
    return;
  }

  await runDaemonFirstEntry();
}

main().catch((error) => {
  console.error("[cmuxlayer] fatal", error);
  process.exit(1);
});
