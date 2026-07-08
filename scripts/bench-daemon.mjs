#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = join(repoRoot, "dist", "index.js");
const distDaemon = join(repoRoot, "dist", "daemon.js");
const DEFAULT_CLIENTS = 8;
const DEFAULT_ROUNDS = 12;
const LATENCY_REGRESSION_RATIO = 1.25;
const LATENCY_REGRESSION_SLACK_MS = 5;

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const clientCount = Math.max(
  DEFAULT_CLIENTS,
  parsePositiveInt(process.env.CMUXLAYER_BENCH_N, DEFAULT_CLIENTS),
);
const rounds = parsePositiveInt(
  process.env.CMUXLAYER_BENCH_ROUNDS,
  DEFAULT_ROUNDS,
);

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function percentile(samples, pct) {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compact(value) {
  return JSON.stringify(value);
}

async function execCapture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolvePromise(stdout);
    });
  });
}

async function processStats(pid) {
  try {
    const stdout = await execCapture("ps", ["-o", "rss=,pcpu=", "-p", String(pid)]);
    const [rssKbRaw, cpuPctRaw] = stdout.trim().split(/\s+/);
    return {
      rssKb: Number(rssKbRaw) || 0,
      cpuPct: Number(cpuPctRaw) || 0,
    };
  } catch {
    return { rssKb: 0, cpuPct: 0 };
  }
}

async function totalRssMb(pids) {
  const stats = await Promise.all(pids.map((pid) => processStats(pid)));
  return round(
    stats.reduce((sum, stat) => sum + stat.rssKb, 0) / 1024,
    2,
  );
}

function waitForSocket(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const tryOnce = () => {
      const socket = net.createConnection(path);
      let settled = false;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.on("error", () => {});
        socket.destroy();
        if (ok) {
          resolvePromise();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for daemon socket ${path}`));
          return;
        }
        setTimeout(tryOnce, 50);
      };
      socket.setTimeout(200, () => settle(false));
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    };
    tryOnce();
  });
}

class McpProcess {
  constructor(label, command, args, env) {
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.readBuffer = new ReadBuffer();
    this.child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => {
      this.readBuffer.append(chunk);
      while (true) {
        const message = this.readBuffer.readMessage();
        if (message === null) break;
        this.handleMessage(message);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `${this.label} exited code=${code} signal=${signal} stderr=${this.stderr.trim()}`,
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  get pid() {
    return this.child.pid;
  }

  handleMessage(message) {
    if (!message || typeof message !== "object" || !("id" in message)) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if ("error" in message) {
      pending.reject(
        new Error(`${this.label} JSON-RPC error: ${compact(message.error)}`),
      );
      return;
    }
    pending.resolve(message);
  }

  send(message) {
    this.child.stdin.write(serializeMessage(message));
  }

  request(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timeout });
      this.send(message);
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cmuxlayer-bench", version: "0.1.0" },
    });
    this.notify("notifications/initialized");
  }

  async callTool(name, args = {}) {
    const response = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return response.result;
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${this.label} closed`));
    }
    this.pending.clear();
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child.exitCode === null) {
        this.child.kill("SIGKILL");
      }
    }, 1_000).unref();
  }
}

async function writeFakeCmux(binDir) {
  const fakePath = join(binDir, "cmux");
  await writeFile(
    fakePath,
    `#!/usr/bin/env node
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--json" ? rawArgs.slice(1) : rawArgs;
const command = args[0] || "";
const surfaceCount = Number(process.env.CMUXLAYER_BENCH_SURFACES || "8");
const cwd = process.env.PWD || process.cwd();
const surfaces = Array.from({ length: surfaceCount }, (_, index) => ({
  ref: "surface:bench-" + index,
  title: "bench-agent-" + index,
  type: "terminal",
  index,
  selected: index === 0,
  current_directory: cwd
}));
function write(value) {
  process.stdout.write(JSON.stringify(value));
}
if (command === "list-workspaces") {
  write({ workspaces: [{ ref: "workspace:bench", title: "Bench", index: 0, selected: true, pinned: false, current_directory: cwd }] });
} else if (command === "list-panes") {
  write({ workspace_ref: "workspace:bench", window_ref: "window:bench", panes: [{ ref: "pane:bench", index: 0, focused: true, surface_count: surfaces.length, surface_refs: surfaces.map((surface) => surface.ref), selected_surface_ref: surfaces[0].ref, current_directory: cwd }] });
} else if (command === "list-pane-surfaces") {
  write({ workspace_ref: "workspace:bench", window_ref: "window:bench", pane_ref: "pane:bench", surfaces });
} else if (command === "debug-terminals") {
  write({ terminals: surfaces.map((surface) => ({ surface_ref: surface.ref, current_directory: cwd })) });
} else if (command === "read-screen") {
  const surface = args[args.indexOf("--surface") + 1] || surfaces[0].ref;
  write({ surface_ref: surface, text: "codex> benchmark ready on " + surface + "\\nTASK_DONE", lines: 2, scrollback_used: false });
} else if (command === "identify") {
  write({ caller: { workspace_ref: "workspace:bench", pane_ref: "pane:bench", surface_ref: surfaces[0].ref }, focused: { workspace_ref: "workspace:bench", pane_ref: "pane:bench", surface_ref: surfaces[0].ref } });
} else if (command === "list-status") {
  write([]);
} else {
  write({ ok: true });
}
`,
  );
  await chmod(fakePath, 0o755);
  return fakePath;
}

async function startClients(label, count, env) {
  const clients = [];
  for (let index = 0; index < count; index += 1) {
    const client = new McpProcess(`${label}-${index}`, process.execPath, [
      distIndex,
    ], env);
    clients.push(client);
  }
  await Promise.all(clients.map((client) => client.initialize()));
  return clients;
}

async function measureLatency(clients) {
  const listSamples = [];
  const readSamples = [];
  let listResult = null;
  let readResult = null;

  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    await Promise.all(
      clients.map(async (client) => {
        let startedAt = nowMs();
        const list = await client.callTool("list_surfaces", {
          verbose: false,
          include_screen_preview: false,
        });
        listSamples.push(nowMs() - startedAt);
        listResult ??= list;

        startedAt = nowMs();
        const read = await client.callTool("read_screen", {
          surface: "surface:bench-0",
          workspace: "workspace:bench",
          lines: 5,
        });
        readSamples.push(nowMs() - startedAt);
        readResult ??= read;
      }),
    );
  }

  return {
    list_surfaces: {
      p50_ms: round(percentile(listSamples, 50)),
      p99_ms: round(percentile(listSamples, 99)),
    },
    read_screen: {
      p50_ms: round(percentile(readSamples, 50)),
      p99_ms: round(percentile(readSamples, 99)),
    },
    firstResults: { listResult, readResult },
  };
}

function latencyGate(baseline, daemon, tool, percentileName) {
  const base = baseline[tool][percentileName];
  const candidate = daemon[tool][percentileName];
  return (
    candidate <= base * LATENCY_REGRESSION_RATIO + LATENCY_REGRESSION_SLACK_MS
  );
}

async function main() {
  if (!existsSync(distIndex) || !existsSync(distDaemon)) {
    throw new Error("dist/index.js and dist/daemon.js are required; run bun run build first");
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "cmuxlayer-daemon-bench-"));
  const binDir = join(tempRoot, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFakeCmux(binDir);
  const daemonSocket = join(tempRoot, "cmuxlayer-stated.sock");
  const missingCmuxSocket = join(tempRoot, "missing-cmux.sock");
  const baseEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CMUX_SOCKET_PATH: missingCmuxSocket,
    CMUXLAYER_BENCH_SURFACES: String(clientCount),
    CMUXLAYER_CONTROL_HEALTH_INTERVAL_MS: "0",
    CMUXLAYER_SWEEP_INTERVAL_MS: "60000",
    CMUXLAYER_SWEEP_IDLE_INTERVAL_MS: "60000",
    CMUXLAYER_NODE_MAX_OLD_SPACE_MB: "1536",
  };

  let baselineClients = [];
  let daemonClients = [];
  let daemon = null;
  try {
    baselineClients = await startClients("baseline", clientCount, {
      ...baseEnv,
      CMUXLAYER_FORCE_INPROCESS: "1",
      CMUXLAYER_DAEMON_SOCKET: join(tempRoot, "baseline-unused.sock"),
    });
    const baselineLatency = await measureLatency(baselineClients);
    const baselineRssMb = await totalRssMb(
      baselineClients.map((client) => client.pid).filter(Boolean),
    );

    daemon = spawn(process.execPath, [distDaemon], {
      cwd: repoRoot,
      env: {
        ...baseEnv,
        CMUXLAYER_DAEMON_SOCKET: daemonSocket,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let daemonStderr = "";
    daemon.stderr.on("data", (chunk) => {
      daemonStderr += chunk.toString("utf8");
    });
    daemon.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(
          `[bench] daemon exited code=${code} signal=${signal}: ${daemonStderr.trim()}`,
        );
      }
    });
    await waitForSocket(daemonSocket);

    daemonClients = await startClients("daemon", clientCount, {
      ...baseEnv,
      CMUXLAYER_DAEMON_SOCKET: daemonSocket,
    });
    const daemonLatency = await measureLatency(daemonClients);
    const daemonRssMb = await totalRssMb(
      [daemon.pid, ...daemonClients.map((client) => client.pid)].filter(Boolean),
    );
    const daemonStats = await processStats(daemon.pid);
    const truthfulState =
      compact(baselineLatency.firstResults.listResult?.structuredContent) ===
        compact(daemonLatency.firstResults.listResult?.structuredContent) &&
      compact(baselineLatency.firstResults.readResult?.structuredContent) ===
        compact(daemonLatency.firstResults.readResult?.structuredContent);

    const gates = {
      rss_improved: daemonRssMb < baselineRssMb,
      truthful_state: truthfulState,
      list_surfaces_p50_no_regression: latencyGate(
        baselineLatency,
        daemonLatency,
        "list_surfaces",
        "p50_ms",
      ),
      list_surfaces_p99_no_regression: latencyGate(
        baselineLatency,
        daemonLatency,
        "list_surfaces",
        "p99_ms",
      ),
      read_screen_p50_no_regression: latencyGate(
        baselineLatency,
        daemonLatency,
        "read_screen",
        "p50_ms",
      ),
      read_screen_p99_no_regression: latencyGate(
        baselineLatency,
        daemonLatency,
        "read_screen",
        "p99_ms",
      ),
    };
    const green = Object.values(gates).every(Boolean);
    const result = {
      verdict: green ? "GREEN" : "RED",
      clients: clientCount,
      rounds,
      rss: {
        baseline_inprocess_total_mb: baselineRssMb,
        daemon_total_mb: daemonRssMb,
        reduction_mb: round(baselineRssMb - daemonRssMb),
        reduction_pct: round(
          ((baselineRssMb - daemonRssMb) / baselineRssMb) * 100,
        ),
      },
      latency: {
        baseline_inprocess: {
          list_surfaces: baselineLatency.list_surfaces,
          read_screen: baselineLatency.read_screen,
        },
        daemon_path: {
          list_surfaces: daemonLatency.list_surfaces,
          read_screen: daemonLatency.read_screen,
        },
      },
      daemon_cpu_pct: round(daemonStats.cpuPct, 2),
      gates,
    };

    console.log(`cmuxlayer daemon benchmark: ${result.verdict}`);
    console.log(
      `N=${result.clients} rounds=${result.rounds} RSS baseline=${result.rss.baseline_inprocess_total_mb}MB daemon=${result.rss.daemon_total_mb}MB reduction=${result.rss.reduction_mb}MB (${result.rss.reduction_pct}%)`,
    );
    console.log(
      `list_surfaces p50/p99 baseline=${result.latency.baseline_inprocess.list_surfaces.p50_ms}/${result.latency.baseline_inprocess.list_surfaces.p99_ms}ms daemon=${result.latency.daemon_path.list_surfaces.p50_ms}/${result.latency.daemon_path.list_surfaces.p99_ms}ms`,
    );
    console.log(
      `read_screen p50/p99 baseline=${result.latency.baseline_inprocess.read_screen.p50_ms}/${result.latency.baseline_inprocess.read_screen.p99_ms}ms daemon=${result.latency.daemon_path.read_screen.p50_ms}/${result.latency.daemon_path.read_screen.p99_ms}ms`,
    );
    console.log(`daemon CPU=${result.daemon_cpu_pct}%`);
    console.log(JSON.stringify(result, null, 2));

    if (!green) {
      process.exitCode = 1;
    }
  } finally {
    for (const client of [...baselineClients, ...daemonClients]) {
      client.close();
    }
    daemon?.kill("SIGTERM");
    setTimeout(() => {
      if (daemon && daemon.exitCode === null) {
        daemon.kill("SIGKILL");
      }
    }, 1_000).unref();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
