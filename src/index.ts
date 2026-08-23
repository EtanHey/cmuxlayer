#!/usr/bin/env node

/**
 * cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.
 *
 * Nine public MCP tools. Internal lifecycle and compatibility handlers remain
 * engine implementation details and are never registered on the MCP surface.
 */

import { renderDoctorJson, renderDoctorText, runDoctor } from "./doctor.js";
import { runFleetSidebarCommand } from "./fleet-sidebar-cli.js";
import { RUNNING_VERSION } from "./version.js";
import { runDaemonFirstEntry } from "./entry.js";
import { isMainModule } from "./is-main.js";
import { writeInboxCursor } from "./inbox.js";
import { runInitCli } from "./init-cli.js";
import { loadCmuxlayerConfigFile } from "./config-file.js";
import { installSessionHooks } from "./self-registration-hooks-installer.js";

const HELP_TEXT = `cmuxlayer — Terminal multiplexer MCP server for AI agent workspace orchestration.

Usage:
  cmuxlayer            Start the MCP server on stdio (the normal mode; an MCP
                       client such as cmux/Claude Code launches it and speaks
                       JSON-RPC over stdin/stdout).
  cmuxlayer init       Interactive first-run setup: register the repositories
                       agents can be spawned in, choose whether cmuxlayer calls
                       shell launcher functions or the agent CLIs directly, and
                       choose how agents handle tool approvals. Writes the
                       config those choices produce. Add --yes with --repo for
                       scripted installs; "cmuxlayer init --help" lists flags.
  cmuxlayer --version  Print the version and exit.
  cmuxlayer --help     Print this help and exit.
  cmuxlayer doctor     Run non-interactive health checks (Robust Brew Layer
                       standard §0/§1/§3/§6) and exit. Read-only; no mutation.
                       Add --json for machine-readable output. Exits 0 when
                       healthy.
  cmuxlayer install-session-hooks
                       Install the Claude and Codex SessionStart registry hooks.
                       Existing hook configuration is merged and backed up.
  cmuxlayer fleet-sidebar <collapse|expand|toggle> <lane>
                       Persist an independent Fleet lane state. Supported lanes:
                       orc, golems, voicelayer, skillCreator, cmuxlayer, other.
  cmuxlayer fleet-sidebar state
                       Print the persisted per-lane collapse preferences.
  CMUX_INBOX_MSG_ID=<id> cmuxlayer inbox-cursor <agent-id>
                       Advance the agent-owned inbox cursor after handling a
                       message. CMUXLAYER_INBOX_BASE_DIR overrides its base dir.

Environment:
  CMUX_SOCKET_PATH     Pin the MCP to a specific cmux instance's Unix socket
                       (authoritative — never falls through to another instance).
  CMUXLAYER_DAEMON_SOCKET
                       Override the cmuxlayer daemon Unix socket. Defaults to
                       ~/.local/state/cmux/cmuxlayer-stated.sock.
  CMUXLAYER_CONFIG_FILE
                       Override the config file cmuxlayer reads at startup.
                       Defaults to ~/.config/cmuxlayer/env.sh, written by
                       "cmuxlayer init". Variables already set in the
                       environment always win over the file.
  CMUXLAYER_REPO_HOME  Colon-separated directories that contain your checkouts.
                       A repo named <repo> resolves to <root>/<repo>.
  CMUXLAYER_SPAWN_PERMISSION_MODE
                       "skip-permissions" (default) starts agents with their
                       CLI approval prompt bypassed; "default" leaves them
                       prompting.
  CMUXLAYER_FORCE_INPROCESS=1
                       Escape hatch: run the legacy in-process MCP runtime and
                       log/surface a warning in control_health.
`;

async function main() {
  const arg = process.argv[2];
  // The config `cmuxlayer init` wrote applies wherever cmuxlayer is launched
  // from, not only from a shell that sourced it. Real env vars still win.
  loadCmuxlayerConfigFile();
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`cmuxlayer ${RUNNING_VERSION}\n`);
    return;
  }
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (arg === "init") {
    process.exitCode = await runInitCli(process.argv.slice(3));
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
  if (arg === "install-session-hooks") {
    const result = await installSessionHooks();
    for (const path of result.changed) process.stdout.write(`updated ${path}\n`);
    for (const path of result.backups) process.stdout.write(`backup ${path}\n`);
    if (result.changed.length === 0) process.stdout.write("already installed\n");
    return;
  }
  if (arg === "fleet-sidebar") {
    const result = runFleetSidebarCommand(process.argv.slice(3));
    const stream = result.ok ? process.stdout : process.stderr;
    stream.write(`${result.message}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (arg === "inbox-cursor") {
    const agentId = process.argv[3];
    const messageId = process.env.CMUX_INBOX_MSG_ID;
    if (!agentId || !messageId) {
      process.stderr.write(
        "Usage: CMUX_INBOX_MSG_ID=<id> cmuxlayer inbox-cursor <agent-id>\n",
      );
      process.exitCode = 2;
      return;
    }
    writeInboxCursor(
      agentId,
      messageId,
      process.env.CMUXLAYER_INBOX_BASE_DIR
        ? { baseDir: process.env.CMUXLAYER_INBOX_BASE_DIR }
        : undefined,
    );
    process.stdout.write(`${messageId}\n`);
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
