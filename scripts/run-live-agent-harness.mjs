#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
let harness;

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
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "cmuxlayer-live-agent-harness",
        version: "0.1.0",
      },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
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
    await writeFile(
      spec.goal,
      harness.buildWorkerGoalContent(spec.name, spec.report, spec.marker),
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

function errorLooksNotFound(call) {
  const text = `${call?.error ?? ""}\n${call?.text ?? ""}`;
  return /not found/i.test(text);
}

function listIncludesAgent(call, agentId) {
  const agents = call?.structured?.agents;
  if (!agentId || !Array.isArray(agents)) return false;
  return agents.some((agent) => {
    if (typeof agent !== "object" || agent === null) return false;
    const id =
      typeof agent.agent_id === "string"
        ? agent.agent_id
        : typeof agent.id === "string"
          ? agent.id
          : "";
    return id === agentId;
  });
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
      stateAfterClose = await client.callTool("get_agent_state", {
        agent_id: worker.agent_id,
      });
    }
    agentsAfterClose = await client.callTool("list_agents", {
      repo: config.repo,
    });
    surfacesAfterClose = await client.callTool("list_surfaces", {
      workspace: config.workspace,
      verbose: true,
    });

    const stateGone =
      !worker.agent_id ||
      stateAfterClose?.ok === false ||
      errorLooksNotFound(stateAfterClose);
    const agentListed = listIncludesAgent(agentsAfterClose, worker.agent_id);
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

  const specs = harness.buildWorkerSpecs(config);
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

  const client = new McpStdioClient(server.command, server.args, process.env);
  const seenAgentIds = new Set();
  let baselineWorkerSurfaceCount = 0;

  try {
    await client.initialize();

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
        worker.state_after_spawn = await client.callTool("get_agent_state", {
          agent_id: worker.agent_id,
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
        worker.wait = await client.callTool(
          "wait_for",
          {
            agent_id: worker.agent_id,
            target_state: "done",
            timeout_ms: config.waitTimeoutMs,
            report_path: spec.report,
            done_marker: spec.marker,
          },
          config.waitTimeoutMs + 30_000,
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
        worker.state_after_done = await client.callTool("get_agent_state", {
          agent_id: worker.agent_id,
        });
      }

      if (worker.surface_id) {
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
  } finally {
    results.stderr = client.stderr.trim() || undefined;
    results.finished_at = new Date().toISOString();
    client.close();
  }

  const summary = harness.summarizeHarnessRun(results.workers);
  results.green = summary.green;
  results.final_marker = summary.green
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
  process.exit(summary.green ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
