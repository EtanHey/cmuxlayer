#!/usr/bin/env node

/**
 * cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.
 *
 * 36 MCP tools across three categories (keep in sync with server.ts and the
 * "total tool count" assertion in tests/server-agent-tools.test.ts):
 *   Core (18): list_surfaces, control_health, select_workspace,
 *              create_workspace, new_split, new_surface, move_surface,
 *              reorder_surface, send_input, send_command, send_key,
 *              read_screen, rename_tab, notify, set_status, set_progress,
 *              close_surface, browser_surface
 *   Metacommlayer write channel (2): dispatch_to_agent, inbox_check
 *   Agent lifecycle (16): spawn_agent, new_worktree_split, spawn_in_workspace,
 *                         resync_agents,
 *                         send_to (canonical), send_to_agent (deprecated alias),
 *                         supersede_agent_goal, read_agent_output,
 *                         get_agent_state, list_agents, my_agents, wait_for,
 *                         wait_for_all, stop_agent, kill, interact
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createCmuxClient } from "./cmux-client-factory.js";
import { renderDoctorJson, renderDoctorText, runDoctor } from "./doctor.js";

function readVersion(): string {
  // package.json sits one level above the compiled entrypoint (dist/index.js
  // → ../package.json, and likewise libexec/dist/index.js → libexec/package.json
  // for a brew install). Best-effort; never throw from a --version probe.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

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

  const client = await createCmuxClient();
  const worktreeRepoRoots = process.env.CMUXLAYER_WORKTREE_REPO_ROOTS?.split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const server = createServer({
    client,
    ...(worktreeRepoRoots && worktreeRepoRoots.length > 0
      ? { worktreeRepoRoots }
      : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[cmuxlayer] fatal", error);
  process.exit(1);
});
