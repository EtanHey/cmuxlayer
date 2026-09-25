#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
let harness;
// The daemon-first proxy fails any request at 300 s (DEFAULT_REQUEST_TIMEOUT_MS
// in src/proxy.ts), so one long wait_for dies there. Wait in slices instead.
const WAIT_SLICE_MS = 120_000;

function usage() {
  process.stderr.write(`Usage: run-live-agent-harness.mjs [options]

Options:
  --cli <claude|codex|cursor|gemini|kiro>   Agent CLI (default: cursor)
  --repo <name>                             Repo name (default: skill-creator)
  --workspace <ref>                         Workspace ref (default: workspace:1)
  --count <n>                               Sequential worker count (default: 1)
  --root <dir>                              Run directory root (default: results/live-agent-harness/<cli>-<timestamp>)
  --marker-prefix <PREFIX>                  Report marker prefix (default: DONE_CURSOR_DUMMY)
  --worker-name-prefix <prefix>             Worker name prefix (default: cursor)
  --final-green <MARKER>                    Final green marker line
  --final-red <MARKER>                      Final red marker line
  --mcp-profile <inherit|sterile|skill_eval> Worker MCP profile (default: sterile)
  --wait-timeout-ms <ms>                    wait_for timeout (default: 300000)
  --cleanup-timeout-ms <ms>                 close cleanup timeout (default: 10000)
  --cleanup-poll-ms <ms>                    close cleanup poll interval (default: 500)
  --server-command <cmd>                    MCP server executable
  --server-arg <arg>                        Repeatable MCP server arg
  --daemon-socket <path>                    Daemon socket for this run (default: a private
                                            per-run socket, so THIS build's dist/ serves it).
                                            A socket that already exists is inherited: the
                                            run never stops that daemon
  --installed-daemon                        Opt out of the build check: run against the
                                            installed daemon on its default socket; the
                                            artifact records private:false,
                                            from_this_build:false
  --help                                    Show help
`);
}

function parseArgs(argv) {
  const options = {
    cli: "cursor",
    repo: "skill-creator",
    workspace: "workspace:1",
    count: 1,
    root: "",
    markerPrefix: "DONE_CURSOR_DUMMY",
    workerNamePrefix: "cursor",
    finalGreen: "GREEN_CURSOR_DUMMY_1_AGENT",
    finalRed: "NOT_GREEN_CURSOR_DUMMY_1_AGENT",
    mcpProfile: "sterile",
    waitTimeoutMs: 300_000,
    cleanupTimeoutMs: 10_000,
    cleanupPollMs: 500,
    serverCommand: "",
    serverArgs: [],
    daemonSocket: "",
    installedDaemon: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      case "--cli":
        options.cli = argv[++index];
        break;
      case "--repo":
        options.repo = argv[++index];
        break;
      case "--workspace":
        options.workspace = argv[++index];
        break;
      case "--count":
        options.count = Number(argv[++index]);
        break;
      case "--root":
        options.root = resolve(argv[++index]);
        break;
      case "--marker-prefix":
        options.markerPrefix = argv[++index];
        break;
      case "--worker-name-prefix":
        options.workerNamePrefix = argv[++index];
        break;
      case "--final-green":
        options.finalGreen = argv[++index];
        break;
      case "--final-red":
        options.finalRed = argv[++index];
        break;
      case "--mcp-profile":
        options.mcpProfile = argv[++index];
        break;
      case "--wait-timeout-ms":
        options.waitTimeoutMs = Number(argv[++index]);
        break;
      case "--cleanup-timeout-ms":
        options.cleanupTimeoutMs = Number(argv[++index]);
        break;
      case "--cleanup-poll-ms":
        options.cleanupPollMs = Number(argv[++index]);
        break;
      case "--server-command":
        options.serverCommand = argv[++index];
        break;
      case "--server-arg":
        options.serverArgs.push(argv[++index]);
        break;
      case "--daemon-socket":
        options.daemonSocket = resolve(argv[++index]);
        break;
      case "--installed-daemon":
        options.installedDaemon = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.root === "/path/to/run-dir" || options.root.startsWith("/path/to/")) {
    throw new Error(
      "--root received the placeholder path /path/to/run-dir. Pass a real run directory or omit --root to use the default under results/live-agent-harness/.",
    );
  }
  if (!options.root) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    options.root = resolve(
      REPO_ROOT,
      "results",
      "live-agent-harness",
      `${options.cli}-${stamp}`,
    );
  }
  if (!Number.isFinite(options.count) || options.count < 1) {
    throw new Error("--count must be a positive integer");
  }
  if (!["inherit", "sterile", "skill_eval"].includes(options.mcpProfile)) {
    throw new Error("--mcp-profile must be one of: inherit, sterile, skill_eval");
  }
  if (!Number.isFinite(options.waitTimeoutMs) || options.waitTimeoutMs < 1) {
    throw new Error("--wait-timeout-ms must be a positive integer");
  }
  if (
    !Number.isFinite(options.cleanupTimeoutMs) ||
    options.cleanupTimeoutMs < 1
  ) {
    throw new Error("--cleanup-timeout-ms must be a positive integer");
  }
  if (!Number.isFinite(options.cleanupPollMs) || options.cleanupPollMs < 1) {
    throw new Error("--cleanup-poll-ms must be a positive integer");
  }
  return options;
}

function assertLiveHarnessOptIn(env = process.env) {
  if (env.CMUX_LIVE_HARNESS === "1") return;
  throw new Error(
    "Refusing to run live cmux/agent harness. Set CMUX_LIVE_HARNESS=1 to opt in.",
  );
}

function defaultServerCommand() {
  const distEntry = join(REPO_ROOT, "dist", "index.js");
  return {
    command: process.execPath,
    args: [distEntry],
  };
}

class McpStdioClient {
  constructor(command, args, env = process.env) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.stderr = "";
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("close", () => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        pending.reject(new Error("MCP server exited"));
      }
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.onMessage(JSON.parse(line));
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  onMessage(message) {
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(message.error.message ?? JSON.stringify(message.error)),
      );
      return;
    }
    pending.resolve(message.result ?? {});
  }

  send(message) {
    if (this.closed) {
      throw new Error("MCP server already closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 120_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "cmuxlayer-live-agent-harness",
        version: "0.1.0",
      },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return result;
  }

  async callTool(name, args, timeoutMs) {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
    );
    return harness.parseToolPayload(result);
  }

  close() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

function recordEvent(events, event) {
  events.push({ at: new Date().toISOString(), ...event });
}

function countBaselineWorkerSurfaces(topology, workerTitlePattern) {
  return topology?.workerSurfacesInWorkspace.length ?? 0;
}

async function ensureGoalFiles(config, specs) {
  await mkdir(join(config.root, "goals"), { recursive: true });
  await mkdir(join(config.root, "reports"), { recursive: true });
  for (const spec of specs) {
    // #889: the worker reports under the coordination root, the only place
    // wait_for's file-backed done reads; the runner copies it to spec.report.
    await mkdir(dirname(spec.coordinationReport), { recursive: true });
    await writeFile(
      spec.goal,
      harness.buildWorkerGoalContent(
        spec.name,
        spec.coordinationReport,
        spec.marker,
      ),
      "utf8",
    );
  }
}

async function readReportIfExists(reportPath) {
  try {
    return await readFile(reportPath, "utf8");
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function listIncludesLiveAgent(call, agentId) {
  const agents = call?.structured?.agents;
  if (!agentId || !Array.isArray(agents)) return false;
  return agents.some(
    (agent) =>
      typeof agent === "object" &&
      agent !== null &&
      (agent.agent_id ?? agent.id) === agentId &&
      agent.state !== "done" &&
      agent.state !== "error",
  );
}

function listIncludesSurface(call, surfaceId) {
  const surfaces = call?.structured?.surfaces;
  if (!surfaceId || !Array.isArray(surfaces)) return false;
  return surfaces.some((surface) => {
    if (typeof surface !== "object" || surface === null) return false;
    return surface.ref === surfaceId || surface.id === surfaceId;
  });
}

async function pollCloseCleanup(client, config, worker) {
  const startedAt = Date.now();
  let attempts = 0;
  let stateAfterClose;
  let agentsAfterClose;
  let surfacesAfterClose;

  while (Date.now() - startedAt <= config.cleanupTimeoutMs) {
    attempts += 1;
    if (worker.agent_id) {
      // Default summary hides close tombstones: still listed = still live.
      stateAfterClose = await client.callTool("list_agents", {
        agent_ids: [worker.agent_id],
      });
    }
    agentsAfterClose = await client.callTool("list_agents", {
      repo: config.repo,
    });
    surfacesAfterClose = await client.callTool("list_surfaces", {
      workspace: config.workspace,
      verbose: true,
    });

    // Stopped agents persist as done/resumable by design: "gone" means no
    // longer listed as live, not deleted.
    const stateGone =
      !worker.agent_id ||
      (stateAfterClose?.ok === true &&
        !listIncludesLiveAgent(stateAfterClose, worker.agent_id));
    const agentListed = listIncludesLiveAgent(agentsAfterClose, worker.agent_id);
    const surfacePresent = listIncludesSurface(
      surfacesAfterClose,
      worker.surface_id,
    );

    if (stateGone && !agentListed && !surfacePresent) {
      break;
    }

    await sleep(config.cleanupPollMs);
  }

  return {
    stateAfterClose,
    agentsAfterClose,
    surfacesAfterClose,
    attempts,
  };
}

async function main() {
  assertLiveHarnessOptIn();
  const cliOptions = parseArgs(process.argv.slice(2));
  harness = await import("../dist/live-agent-harness.js");
  const config = {
    cli: cliOptions.cli,
    repo: cliOptions.repo,
    workspace: cliOptions.workspace,
    count: cliOptions.count,
    root: cliOptions.root,
    markerPrefix: cliOptions.markerPrefix,
    workerNamePrefix: cliOptions.workerNamePrefix,
    finalGreen: cliOptions.finalGreen,
    finalRed: cliOptions.finalRed,
    mcpProfile: cliOptions.mcpProfile,
    waitTimeoutMs: cliOptions.waitTimeoutMs,
    cleanupTimeoutMs: cliOptions.cleanupTimeoutMs,
    cleanupPollMs: cliOptions.cleanupPollMs,
    workerTitlePattern:
      cliOptions.cli === "cursor"
        ? /cursor agent/i
        : new RegExp(`${cliOptions.cli}`, "i"),
  };

  const specs = harness.buildWorkerSpecs(config).map((spec) => ({
    ...spec,
    coordinationReport: harness.harnessCoordinationReportPath(
      homedir(),
      basename(config.root),
      spec.name,
    ),
  }));
  await ensureGoalFiles(config, specs);

  const server =
    cliOptions.serverCommand.length > 0
      ? {
          command: cliOptions.serverCommand,
          args: cliOptions.serverArgs,
        }
      : defaultServerCommand();

  const results = {
    started_at: new Date().toISOString(),
    config,
    workers: [],
    events: [],
  };

  // #800: the entry is a daemon-first proxy, so without a pinned socket it
  // talks to whatever daemon owns the default socket (the INSTALLED one on a
  // fleet Mac) and "harness green" proves that binary, not this build.
  // #889: "private" means this run created the socket and so started the
  // daemon; an existing socket (inherited or installed) is never ours to stop.
  const daemonPlan = harness.planHarnessDaemon({
    daemonSocketArg: cliOptions.daemonSocket,
    envSocket: process.env.CMUXLAYER_DAEMON_SOCKET,
    installedDaemon: cliOptions.installedDaemon,
    home: homedir(),
    pid: process.pid,
    socketExists: existsSync,
  });
  const socketPath = daemonPlan.socket_path;
  const childEnv = { ...process.env, CMUXLAYER_DAEMON_SOCKET: socketPath };
  const client = new McpStdioClient(server.command, server.args, childEnv);
  const seenAgentIds = new Set();
  let baselineWorkerSurfaceCount = 0;

  try {
    const initialized = await client.initialize();

    // PREFLIGHT, before any spawn_agent: #808 required tools listed, #889 the
    // calling seat is shallow enough. Fail loudly, up front.
    let preflightError;
    try {
      results.preflight = await harness.runHarnessPreflight(client, {
        callerSurface: process.env.CMUX_SURFACE_ID,
      });
    } catch (error) {
      preflightError = error;
      results.preflight = error?.preflight;
    }
    // Identify the daemon even on a red preflight, so a daemon this run
    // started is still stopped by its recorded PID in finally.
    if (preflightError && !results.preflight?.tools?.includes("control_health")) {
      throw preflightError;
    }
    const health = await client.callTool("control_health", { detail: "full" });
    results.daemon = harness.buildHarnessDaemonBlock({
      plan: daemonPlan,
      serverVersion:
        typeof initialized?.serverInfo?.version === "string"
          ? initialized.serverInfo.version
          : null,
      controlHealth: health.structured,
      distDir: join(REPO_ROOT, "dist"),
    });
    results.daemon_failures = harness.harnessDaemonFailures(results.daemon);
    process.stderr.write(
      `live harness daemon: ${JSON.stringify(results.daemon)}\n`,
    );
    if (preflightError) throw preflightError;
    if (results.daemon_failures.length > 0) {
      throw new Error(
        `live harness: the serving daemon is not this build (${results.daemon.binary ?? "unknown binary"}, expected under ${results.daemon.expected_dist})`,
      );
    }

    recordEvent(results.events, { step: "baseline" });
    results.baseline_agents = await client.callTool("list_agents", {
      repo: config.repo,
    });
    const baselineSurfaces = await client.callTool("list_surfaces", {
      workspace: config.workspace,
      verbose: true,
    });
    results.baseline_surfaces = baselineSurfaces;
    const baselineTopology = harness.summarizeTopology(
      baselineSurfaces.structured,
      config.workspace,
      null,
      config.workerTitlePattern,
    );
    baselineWorkerSurfaceCount = countBaselineWorkerSurfaces(
      baselineTopology,
      config.workerTitlePattern,
    );

    for (const spec of specs) {
      const worker = {
        name: spec.name,
        goal: spec.goal,
        report: spec.report,
        marker: spec.marker,
        started_at: new Date().toISOString(),
      };
      results.workers.push(worker);
      recordEvent(results.events, {
        worker: spec.name,
        step: "spawn_start",
      });

      worker.spawn = await client.callTool(
        "spawn_agent",
        {
          repo: config.repo,
          cli: config.cli,
          role: "worker",
          workspace: config.workspace,
          force_new: true,
          boot_prompt_path: spec.goal,
          mcp_profile: config.mcpProfile,
          report_path: spec.coordinationReport,
        },
        config.waitTimeoutMs,
      );

      worker.agent_id =
        typeof worker.spawn.structured?.agent_id === "string"
          ? worker.spawn.structured.agent_id
          : undefined;
      worker.surface_id =
        typeof worker.spawn.structured?.surface_id === "string"
          ? worker.spawn.structured.surface_id
          : typeof worker.spawn.structured?.surface === "string"
            ? worker.spawn.structured.surface
            : undefined;
      worker.duplicate_agent_id =
        Boolean(worker.agent_id) && seenAgentIds.has(worker.agent_id);
      if (worker.agent_id) {
        seenAgentIds.add(worker.agent_id);
      }
      // #889: wait on the engine-issued report_path from the receipt.
      worker.issued_report_path =
        typeof worker.spawn.structured?.report_path === "string"
          ? worker.spawn.structured.report_path
          : spec.coordinationReport;

      recordEvent(results.events, {
        worker: spec.name,
        step: "spawn_done",
        agent_id: worker.agent_id,
        surface_id: worker.surface_id,
        ok: worker.spawn.ok === true,
        health:
          typeof worker.spawn.structured?.health === "object" &&
          worker.spawn.structured.health !== null
            ? worker.spawn.structured.health.status
            : undefined,
        issues:
          typeof worker.spawn.structured?.health === "object" &&
          worker.spawn.structured.health !== null &&
          Array.isArray(worker.spawn.structured.health.issue_codes)
            ? worker.spawn.structured.health.issue_codes
            : [],
      });

      if (worker.agent_id) {
        worker.state_after_spawn = await client.callTool("list_agents", {
          agent_ids: [worker.agent_id],
          detail: "full",
        });
      }

      worker.surfaces_after_spawn = await client.callTool("list_surfaces", {
        workspace: config.workspace,
        verbose: true,
      });
      worker.topology = harness.summarizeTopology(
        worker.surfaces_after_spawn.structured,
        config.workspace,
        worker.surface_id ?? null,
        config.workerTitlePattern,
      );
      worker.topology.text = worker.surfaces_after_spawn.text;

      recordEvent(results.events, { worker: spec.name, step: "wait_start" });
      if (worker.agent_id) {
        const waitDeadline = Date.now() + config.waitTimeoutMs;
        worker.wait_slices = 0;
        do {
          const slice = Math.max(
            1_000,
            Math.min(WAIT_SLICE_MS, waitDeadline - Date.now()),
          );
          worker.wait_slices += 1;
          worker.wait = await client.callTool(
            "wait_for",
            {
              agent_id: worker.agent_id,
              target_state: "done",
              timeout_ms: slice,
              report_path: worker.issued_report_path,
              done_marker: spec.marker,
            },
            slice + 30_000,
          );
        } while (
          worker.wait?.ok === true &&
          !harness.waitIsDone(worker.wait) &&
          Date.now() < waitDeadline
        );
      }

      recordEvent(results.events, {
        worker: spec.name,
        step: "wait_done",
        wait_state:
          typeof worker.wait?.structured?.state === "string"
            ? worker.wait.structured.state
            : undefined,
        ok: worker.wait?.ok === true,
      });

      // Copy the issued report into results/ for the artifact.
      await copyFile(worker.issued_report_path, spec.report).catch(() => {});
      worker.report_text = await readReportIfExists(spec.report);
      worker.report_missing = worker.report_text == null;
      if (worker.report_text) {
        worker.report_final_line = worker.report_text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
      }

      if (worker.agent_id) {
        worker.state_after_done = await client.callTool("list_agents", {
          agent_ids: [worker.agent_id],
          detail: "full",
        });
      }

      if (worker.agent_id) {
        // The harness owns this dummy and has harvested its report: stop the
        // agent and close its pane. A plain surface close is (correctly)
        // refused for a still-live agent and left pane + record behind (#808).
        worker.close = await client.callTool("close_surface", {
          agent_id: worker.agent_id,
          scope: "agent",
          force: true,
        });
      } else if (worker.surface_id) {
        worker.close = await client.callTool("close_surface", {
          surface: worker.surface_id,
          workspace: config.workspace,
        });
      }

      const cleanup = await pollCloseCleanup(client, config, worker);
      worker.state_after_close = cleanup.stateAfterClose;
      worker.agents_after_close = cleanup.agentsAfterClose;
      worker.surfaces_after_close = cleanup.surfacesAfterClose;
      worker.cleanup_attempts = cleanup.attempts;

      worker.stale_state = harness.isStaleManagedRecord(
        worker.state_after_close,
        worker.agents_after_close,
        worker.agent_id,
      );

      worker.failures = harness.classifyWorkerFailures({
        repo: config.repo,
        cli: config.cli,
        workspace: config.workspace,
        marker: spec.marker,
        spawn: worker.spawn,
        wait: worker.wait,
        reportText: worker.report_text ?? undefined,
        reportMissing: worker.report_missing,
        duplicateAgentId: worker.duplicate_agent_id,
        agentId: worker.agent_id,
        topology: worker.topology,
        stateAfterSpawnText: worker.state_after_spawn?.text,
        stateAfterClose: worker.state_after_close,
        agentsAfterClose: worker.agents_after_close,
        surfacesAfterClose: worker.surfaces_after_close,
        baselineWorkerSurfaceCount,
        workerTitlePattern: config.workerTitlePattern,
      });

      worker.green = harness.workerIsGreen(worker.failures);
      worker.finished_at = new Date().toISOString();

      recordEvent(results.events, {
        worker: spec.name,
        step: "closed",
        final_line: worker.report_final_line,
        stale_state: worker.stale_state,
        green: worker.green,
        failures: worker.failures,
      });
    }
  } catch (error) {
    results.error = error instanceof Error ? error.message : String(error);
  } finally {
    // A red path after spawn_agent must not leak the dummy (#889).
    for (const worker of results.workers) {
      if (!worker.agent_id || worker.close) continue;
      worker.close = await client
        .callTool("close_surface", {
          agent_id: worker.agent_id,
          scope: "agent",
          force: true,
        })
        .catch((error) => ({ ok: false, error: String(error) }));
    }
    results.stderr = client.stderr.trim() || undefined;
    results.finished_at = new Date().toISOString();
    client.close();
    // Stop the daemon only if this run started it, by its recorded PID.
    const stopped = harness.stopHarnessDaemon(results.daemon);
    if (results.daemon && stopped !== undefined) {
      results.daemon.stopped = stopped;
    }
  }

  const summary = harness.summarizeHarnessRun(results.workers);
  results.green =
    summary.green &&
    results.error === undefined &&
    (results.daemon_failures ?? ["daemon_not_identified"]).length === 0 &&
    results.workers.length > 0;
  results.final_marker = results.green
    ? config.finalGreen
    : config.finalRed;

  const jsonPath = join(config.root, "mcp-run-results.json");
  const reportPath = join(config.root, "run-report.md");
  const workerFailures = Object.fromEntries(
    results.workers.map((worker) => [worker.name, worker.failures ?? []]),
  );
  const reportMarkdown = harness.buildRunReportMarkdown(results, workerFailures);

  await writeFile(jsonPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  await writeFile(reportPath, reportMarkdown, "utf8");

  process.stdout.write(`${reportMarkdown}\n`);
  process.exit(results.green ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
