#!/usr/bin/env node

/**
 * cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.
 *
 * 42 registered MCP tools with a 12-tool default palette (keep in sync with
 * server.ts and the total-tool-count assertion):
 *   Default (12): spawn_agent, send_to, wait_for, read_screen, my_agents,
 *                 list_agents, broadcast, close_surface, dispatch_to_agent,
 *                 list_surfaces, control_health, stop_agent
 *   Remaining tools are INTERIM ToolSearch-deferred and remain callable;
 *   reorder_surface is the single approved deletion.
 *   Legacy aliases retire next release; the broader deferral is deliberately
 *   reversible pending the MCP-vs-CLI/programmatic architecture rethink.
 */

import { renderDoctorJson, renderDoctorText, runDoctor } from "./doctor.js";
import { RUNNING_VERSION } from "./version.js";
import { runDaemonFirstEntry } from "./entry.js";
import { isMainModule } from "./is-main.js";

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
    process.stdout.write(`cmuxlayer ${RUNNING_VERSION}\n`);
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
    const report = await runDoctor({ version: RUNNING_VERSION });
    process.stdout.write(
      (json ? renderDoctorJson(report) : renderDoctorText(report)) + "\n",
    );
    process.exitCode = report.healthy ? 0 : 1;
    return;
  }

  await runDaemonFirstEntry();
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error("[cmuxlayer] fatal", error);
    process.exit(1);
  });
}
