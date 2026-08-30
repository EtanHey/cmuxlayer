#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = join(repoRoot, "dist", "index.js");
const distDaemon = join(repoRoot, "dist", "daemon.js");
const DEFAULT_CLIENTS = 8;
const DEFAULT_ROUNDS = 12;
const PARALLEL_STRESS_COUNT = 10;
const LATENCY_REGRESSION_RATIO = 1.25;
const LATENCY_REGRESSION_SLACK_MS = 5;
const READ_SCREEN_P50_BUDGET_MS = 250;
const LOCAL_HARD_GATES = process.env.CMUXLAYER_BENCH_LOCAL_GATE === "1";
let JsonRpcLineBuffer;

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

function requestBytes(name, args) {
  return Buffer.byteLength(
    serializeMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function requestSha256(name, args) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ name, arguments: args })))
    .digest("hex");
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
    const stdout = await execCapture("ps", [
      "-o",
      "rss=,pcpu=",
      "-p",
      String(pid),
    ]);
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
  return round(stats.reduce((sum, stat) => sum + stat.rssKb, 0) / 1024, 2);
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
    this.readBuffer = new JsonRpcLineBuffer();
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
        reject(
          new Error(
            `${this.label} timed out waiting for ${method}; stderr=${this.stderr.trim()}`,
          ),
        );
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

  async callTool(name, args = {}, timeoutMs = 10_000) {
    let response;
    try {
      response = await this.request(
        "tools/call",
        { name, arguments: args },
        timeoutMs,
      );
    } catch (error) {
      throw new Error(
        `${this.label} ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return response.result;
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${this.label} closed`));
    }
    this.pending.clear();
    return stopChild(this.child);
  }
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(forceTimer);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

async function writeFakeCmux(binDir) {
  const fakePath = join(binDir, "cmux");
  await writeFile(
    fakePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const rawArgs = process.argv.slice(2);
const args = [...rawArgs];
if (args[0] === "--json") args.shift();
if (args[0] === "--id-format") args.splice(0, 2);
const command = args[0] || "";
const surfaceCount = Number(process.env.CMUXLAYER_BENCH_SURFACES || "8");
const cwd = process.env.PWD || process.cwd();
const statePath = process.env.CMUXLAYER_BENCH_STATE;
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch { return { composer: "", transcript: "", title: "bench-spawn" }; }
}

function writeState(state) {
  if (statePath) fs.writeFileSync(statePath, JSON.stringify(state));
}
function patchState(patch) {
  writeState({ ...readState(), ...patch });
}
const state = readState();
const baseSurfaces = Array.from({ length: surfaceCount }, (_, index) => ({
  ref: "surface:bench-" + index,
  id: "00000000-0000-4000-8000-" + String(index).padStart(12, "0"),
  title: "bench-agent-" + index,
  type: "terminal",
  index,
  selected: index === 0,
  current_directory: cwd
}));
const spawnedSurface = {
  ref: "surface:bench-spawn",
  id: "00000000-0000-4000-8000-999999999999",
  title: state.title,
  type: "terminal",
  index: surfaceCount,
  selected: false,
  current_directory: cwd
};
const surfaces = state.closed ? baseSurfaces : baseSurfaces.concat([spawnedSurface]);
function write(value) {
  process.stdout.write(JSON.stringify(value));
}
if (command === "list-workspaces") {
  write({ workspaces: [{ ref: "workspace:bench", title: "Bench", index: 0, selected: true, pinned: false, current_directory: cwd }] });
} else if (command === "list-windows") {
  write({ windows: [{ ref: "window:bench", title: "Bench", index: 0, selected: true, workspace_refs: ["workspace:bench"] }] });
} else if (command === "list-panes") {
  write({ workspace_ref: "workspace:bench", window_ref: "window:bench", panes: [{ ref: "pane:bench", index: 0, focused: true, surface_count: surfaces.length, surface_refs: surfaces.map((surface) => surface.ref), surface_ids: surfaces.map((surface) => surface.id), selected_surface_ref: surfaces[0].ref, current_directory: cwd }] });
} else if (command === "list-pane-surfaces") {
  write({ workspace_ref: "workspace:bench", window_ref: "window:bench", pane_ref: "pane:bench", surfaces });
} else if (command === "new-split") {
  patchState({ closed: false });
  write({ workspace_ref: "workspace:bench", pane_ref: "pane:bench", surface_ref: "surface:bench-spawn", surface_id: "00000000-0000-4000-8000-999999999999", title: state.title, type: "terminal" });
} else if (command === "close-surface") {
  patchState({ closed: true });
  write({ ok: true });
} else if (command === "debug-terminals") {
  write({ terminals: surfaces.map((surface) => ({ surface_ref: surface.ref, current_directory: cwd })) });
} else if (command === "read-screen") {
  const surface = args[args.indexOf("--surface") + 1] || surfaces[0].ref;
  const composer = state.composer ? "› " + state.composer : "› ";
  const transcript = state.transcript ? "\\n› " + state.transcript + "\\n" : "";
  write({ surface_ref: surface, text: "╭ OpenAI Codex ╮\\nmodel: gpt-5.6-sol\\n" + transcript + "\\n" + composer, lines: 8, scrollback_used: false });
} else if (command === "identify") {
  write({ caller: { workspace_ref: "workspace:bench", pane_ref: "pane:bench", surface_ref: surfaces[0].ref }, focused: { workspace_ref: "workspace:bench", pane_ref: "pane:bench", surface_ref: surfaces[0].ref } });
} else if (command === "list-status") {
  write([]);
} else if (command === "send") {
  state.composer += args.at(-1) || "";
  writeState(state);
  write({ ok: true });
} else if (command === "set-buffer") {
  state.buffer = args.at(-1) || "";
  writeState(state);
  write({ ok: true });
} else if (command === "paste-buffer") {
  state.composer += state.buffer || "";
  state.buffer = "";
  writeState(state);
  write({ ok: true });
} else if (command === "send-key") {
  if ((args.at(-1) || "").toLowerCase() === "return") {
    state.transcript = state.composer;
    state.composer = "";
    writeState(state);
  }
  write({ ok: true });
} else if (command === "rename-tab") {
  state.title = args.at(-1) || state.title;
  writeState(state);
  write({ ok: true });
} else {
  write({ ok: true });
}
`,
  );
  await chmod(fakePath, 0o755);
  return fakePath;
}

async function startFakeCmuxSocket(socketPath, statePath, surfaceCount) {
  const server = net.createServer((socket) => {
    // Benchmark clients may disappear while the fake server is replying.
    // Treat that expected teardown reset as connection-local evidence, not an
    // uncaught process error that invalidates an otherwise GREEN sample.
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        void handleFakeCmuxSocketLine(socket, line, statePath, surfaceCount);
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  return server;
}

async function handleFakeCmuxSocketLine(socket, line, statePath, surfaceCount) {
  if (!line.startsWith("{")) {
    socket.write(`${line.startsWith("list_status") ? "[]" : "OK"}\n`);
    return;
  }
  const request = JSON.parse(line);
  const params = request.params ?? {};
  const state = await readFakeState(statePath);
  const cwd = process.cwd();
  const baseSurfaces = Array.from({ length: surfaceCount }, (_, index) => ({
    ref: `surface:bench-${index}`,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    title: `bench-agent-${index}`,
    type: "terminal",
    index,
    selected: index === 0,
    current_directory: cwd,
  }));
  const spawned = {
    ref: "surface:bench-spawn",
    id: "00000000-0000-4000-8000-999999999999",
    title: state.title ?? "bench-spawn",
    type: "terminal",
    index: surfaceCount,
    selected: false,
    current_directory: cwd,
  };
  const surfaces = state.closed ? baseSurfaces : [...baseSurfaces, spawned];
  const layout = {
    workspace_ref: "workspace:bench",
    window_ref: "window:bench",
    pane_ref: "pane:bench",
  };
  let result;
  switch (request.method) {
    case "system.ping":
      result = { pong: true };
      break;
    case "system.identify":
      result = {
        caller: {
          ...layout,
          surface_ref: "surface:bench-0",
        },
        focused: {
          ...layout,
          surface_ref: "surface:bench-0",
        },
      };
      break;
    case "window.list":
      result = {
        windows: [
          {
            ref: "window:bench",
            title: "Bench",
            index: 0,
            selected: true,
            workspace_refs: ["workspace:bench"],
          },
        ],
      };
      break;
    case "workspace.list":
      result = {
        workspaces: [
          {
            ref: "workspace:bench",
            title: "Bench",
            index: 0,
            selected: true,
            pinned: false,
            current_directory: cwd,
          },
        ],
      };
      break;
    case "pane.list":
      result = {
        ...layout,
        panes: [
          {
            ref: "pane:bench",
            index: 0,
            focused: true,
            surface_count: surfaces.length,
            surface_refs: surfaces.map((surface) => surface.ref),
            surface_ids: surfaces.map((surface) => surface.id),
            selected_surface_ref: surfaces[0]?.ref,
            current_directory: cwd,
          },
        ],
      };
      break;
    case "surface.list":
      result = { ...layout, surfaces };
      break;
    case "surface.read_text": {
      const transcript = state.transcript ? `\n› ${state.transcript}\n` : "";
      result = {
        surface_ref: params.surface_id,
        text:
          `╭ OpenAI Codex ╮\nmodel: gpt-5.6-sol\n${transcript}\n› ` +
          (state.composer ?? ""),
        lines: 8,
      };
      break;
    }
    case "surface.split":
      await writeFakeState(statePath, { ...state, closed: false });
      result = {
        ...layout,
        surface_ref: spawned.ref,
        surface_id: spawned.id,
        title: spawned.title,
        type: "terminal",
      };
      break;
    case "surface.send_text":
      await writeFakeState(statePath, {
        ...state,
        composer: `${state.composer ?? ""}${params.text ?? ""}`,
      });
      result = { ok: true };
      break;
    case "surface.send_key":
      await writeFakeState(
        statePath,
        String(params.key).toLowerCase() === "return"
          ? { ...state, transcript: state.composer ?? "", composer: "" }
          : state,
      );
      result = { ok: true };
      break;
    case "surface.close":
      await writeFakeState(statePath, { ...state, closed: true });
      result = { ok: true };
      break;
    case "tab.action":
      await writeFakeState(statePath, {
        ...state,
        title: params.title ?? state.title,
      });
      result = { ok: true };
      break;
    case "workspace.select":
    case "surface.focus":
      result = { ok: true };
      break;
    default:
      socket.write(
        `${JSON.stringify({ id: request.id, ok: false, error: { code: "method_not_found", message: request.method } })}\n`,
      );
      return;
  }
  socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
}

async function startClients(label, count, env) {
  const clients = [];
  for (let index = 0; index < count; index += 1) {
    const client = new McpProcess(
      `${label}-${index}`,
      process.execPath,
      [distIndex],
      env,
    );
    clients.push(client);
  }
  await Promise.all(clients.map((client) => client.initialize()));
  return clients;
}

async function measureLatency(clients) {
  const listSamples = [];
  const readSamples = [];
  const listTransports = [];
  const readTransports = [];
  const listFallbackSources = new Set();
  const readFallbackSources = new Set();
  let listResult = null;
  let readResult = null;
  const listArgs = {
    verbose: false,
    include_screen_preview: false,
  };
  const readArgs = {
    surface: "surface:bench-0",
    workspace: "workspace:bench",
    lines: 5,
  };

  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    await Promise.all(
      clients.map(async (client) => {
        let startedAt = nowMs();
        const list = await client.callTool("list_surfaces", listArgs);
        const listReceipt = toolData(list, "list_surfaces");
        listSamples.push(nowMs() - startedAt);
        listResult ??= list;
        listTransports.push(operationTransport(listReceipt, "list_surfaces"));
        for (const source of listReceipt.transport_fallbacks ?? []) {
          listFallbackSources.add(source);
        }

        startedAt = nowMs();
        const read = await client.callTool("read_screen", readArgs);
        const readReceipt = toolData(read, "read_screen");
        readSamples.push(nowMs() - startedAt);
        readResult ??= read;
        readTransports.push(operationTransport(readReceipt, "read_screen"));
        for (const source of readReceipt.transport_fallbacks ?? []) {
          readFallbackSources.add(source);
        }
      }),
    );
  }

  return {
    list_surfaces: {
      request_bytes: requestBytes("list_surfaces", listArgs),
      request_sha256: requestSha256("list_surfaces", listArgs),
      p50_ms: round(percentile(listSamples, 50)),
      p95_ms: round(percentile(listSamples, 95)),
      p99_ms: round(percentile(listSamples, 99)),
      transport: listTransports.every((value) => value === "socket")
        ? "socket"
        : "cli",
      transport_fallbacks: [...listFallbackSources],
    },
    read_screen: {
      request_bytes: requestBytes("read_screen", readArgs),
      request_sha256: requestSha256("read_screen", readArgs),
      p50_ms: round(percentile(readSamples, 50)),
      p95_ms: round(percentile(readSamples, 95)),
      p99_ms: round(percentile(readSamples, 99)),
      transport: readTransports.every((value) => value === "socket")
        ? "socket"
        : "cli",
      transport_fallbacks: [...readFallbackSources],
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

function toolData(result, label) {
  if (result?.isError) {
    throw new Error(`${label} failed: ${compact(result)}`);
  }
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error(`${label} returned no structured receipt`);
  return JSON.parse(text);
}

function operationTransport(receipt, label) {
  if (receipt?.transport === "socket" || receipt?.transport === "cli") {
    return receipt.transport;
  }
  throw new Error(`${label} omitted per-operation transport provenance`);
}

async function readFakeState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return {};
  }
}

async function writeFakeState(statePath, state) {
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state));
  await rename(temporaryPath, statePath);
}

async function armSweepHold(statePath, holdToken) {
  await writeFile(
    statePath,
    JSON.stringify({ token: holdToken, state: "armed" }),
  );
}

async function waitForSweepHoldState(
  statePath,
  holdToken,
  expectedState,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readFakeState(statePath);
    if (state.token === holdToken && state.state === expectedState) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(
    `timed out waiting for benchmark hold ${holdToken} state ${expectedState}`,
  );
}

async function waitForLifecycleWaiter(
  statePath,
  holdToken,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readFakeState(statePath);
    if (
      state.token === holdToken &&
      state.state === "held" &&
      state.waiter === "close-agent"
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("close_surface never queued behind the held lifecycle sweep");
}

function summarizeTimedSamples(samples) {
  const transports = samples.map((sample) => sample.transport);
  return {
    request_bytes: samples[0]?.request_bytes,
    request_sha256: samples[0]?.request_sha256,
    p50_ms: round(percentile(samples.map((sample) => sample.elapsed_ms), 50)),
    p95_ms: round(percentile(samples.map((sample) => sample.elapsed_ms), 95)),
    lock_hold_ms: Math.max(
      ...samples.map((sample) => sample.lock_hold_ms ?? 0),
    ),
    transport: transports.every((value) => value === "socket")
      ? "socket"
      : "cli",
    transport_fallbacks: [
      ...new Set(samples.flatMap((sample) => sample.transport_fallbacks ?? [])),
    ],
    sample_count: samples.length,
    sampling: "sampled",
  };
}

async function measureSpawnLifecycleOnce(
  client,
  sweepHoldState,
) {
  const spawnResult = toolData(
    await client.callTool(
      "spawn_agent",
      {
        repo: "cmuxlayer",
        cli: "codex",
        role: "worker",
        authority: "worker",
        placement: "right",
        workspace: "workspace:bench",
        cwd: repoRoot,
        worktree: false,
        mcp_profile: "sterile",
        title: "bench-first-send",
        prompt: "benchmark boot prompt",
        boot_prompt_timeout_ms: 2_000,
      },
      30_000,
    ),
    "spawn_agent",
  );
  if (!spawnResult.agent_id || !spawnResult.surface_id) {
    throw new Error(`spawn_agent omitted identity: ${compact(spawnResult)}`);
  }

  const measureSend = async (args, { normalizeAgentId = false } = {}) => {
    const startedAt = nowMs();
    const receipt = toolData(await client.callTool("send_to", args), "send_to");
    return {
      elapsed_ms: round(nowMs() - startedAt),
      request_bytes: requestBytes("send_to", args),
      request_sha256: requestSha256("send_to", {
        ...args,
        ...(normalizeAgentId ? { agent_id: "$SPAWNED_AGENT_ID" } : {}),
      }),
      lock_hold_ms: receipt.timings_ms?.lock_hold ?? null,
      transport: receipt.transport,
      receipt,
    };
  };

  // The daemon sweep acknowledges this unique token only after it owns the
  // lifecycle mutex. Restoring the fleet refresh must push first send over 2s.
  const holdToken = `sweep-daemon-owner-${Date.now()}`;
  await armSweepHold(sweepHoldState, holdToken);
  await waitForSweepHoldState(sweepHoldState, holdToken, "held");
  const first = await measureSend(
    {
      mode: "agent",
      agent_id: spawnResult.agent_id,
      text: "Read and follow docs.local/scratch/run5r3/bench-first-send.md",
      press_enter: true,
    },
    { normalizeAgentId: true },
  );
  await writeFile(
    sweepHoldState,
    JSON.stringify({ token: holdToken, state: "release" }),
  );
  await waitForSweepHoldState(sweepHoldState, holdToken, "complete");
  const second = await measureSend(
    {
      mode: "agent",
      agent_id: spawnResult.agent_id,
      text: "Read and follow docs.local/scratch/run5r3/bench-second-send.md",
      press_enter: true,
    },
    { normalizeAgentId: true },
  );
  const surface = await measureSend({
    mode: "surface",
    surface: spawnResult.surface_id,
    workspace: "workspace:bench",
    text: "surface benchmark",
    press_enter: true,
  });
  let surfaceWaitFor;
  if (typeof surface.receipt.delivery_id === "string") {
    try {
      surfaceWaitFor = toolData(
        await client.callTool("wait_for", {
          delivery_id: surface.receipt.delivery_id,
          timeout_ms: 2_000,
        }),
        "wait_for(surface receipt)",
      );
    } catch (error) {
      surfaceWaitFor = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    surfaceWaitFor = {
      ok: false,
      error: "surface receipt omitted delivery_id",
    };
  }

  const closeArgs = {
    scope: "agent",
    agent_id: spawnResult.agent_id,
    force: true,
  };
  const closeHoldToken = `sweep-close-${Date.now()}`;
  await armSweepHold(sweepHoldState, closeHoldToken);
  await waitForSweepHoldState(sweepHoldState, closeHoldToken, "held");
  const closeStartedAt = nowMs();
  const closePromise = client.callTool("close_surface", closeArgs).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await waitForLifecycleWaiter(sweepHoldState, closeHoldToken);
  await writeFile(
    sweepHoldState,
    JSON.stringify({ token: closeHoldToken, state: "release" }),
  );
  const closeOutcome = await closePromise;
  if ("error" in closeOutcome) throw closeOutcome.error;
  const closeReceipt = toolData(closeOutcome.value, "close_surface");
  await waitForSweepHoldState(sweepHoldState, closeHoldToken, "complete");
  const spawnCloseDuringSweep = {
    elapsed_ms: round(nowMs() - closeStartedAt),
    request_bytes: requestBytes("close_surface", closeArgs),
    request_sha256: requestSha256("close_surface", {
      ...closeArgs,
      agent_id: "$SPAWNED_AGENT_ID",
    }),
    lock_hold_ms: closeReceipt.timings_ms?.lock_hold ?? 0,
    transport: closeReceipt.transport,
    transport_fallbacks: closeReceipt.transport_fallbacks ?? [],
    receipt: closeReceipt,
  };

  return {
    agent_id: spawnResult.agent_id,
    surface_id: spawnResult.surface_id,
    first,
    second,
    surface: { ...surface, wait_for: surfaceWaitFor },
    spawn_close_during_sweep: spawnCloseDuringSweep,
  };
}

async function measureWarmToolAcrossClients(clients, name, args) {
  const samples = [];
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    await Promise.all(
      clients.map(async (client) => {
        const startedAt = nowMs();
        const receipt = toolData(
          await client.callTool(name, args, 30_000),
          name,
        );
        samples.push({
          elapsed_ms: nowMs() - startedAt,
          request_bytes: requestBytes(name, args),
          request_sha256: requestSha256(name, args),
          lock_hold_ms: receipt.timings_ms?.lock_hold ?? 0,
          transport: operationTransport(receipt, name),
          transport_fallbacks: receipt.transport_fallbacks ?? [],
        });
      }),
    );
  }
  return summarizeTimedSamples(samples);
}

async function measureSpawnLifecycleAcrossClients(
  clients,
  sweepHoldState,
  onFirstSample,
) {
  const samples = [];
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    for (const client of clients) {
      samples.push(await measureSpawnLifecycleOnce(client, sweepHoldState));
      if (samples.length === 1) await onFirstSample?.();
    }
  }
  return {
    first: samples[0].first,
    second: samples[0].second,
    surface: samples[0].surface,
    spawn_close_sample: samples[0].spawn_close_during_sweep,
    sampled: summarizeTimedSamples(samples.map((sample) => sample.first)),
    send_to_agent_warm: summarizeTimedSamples(
      samples.map((sample) => sample.second),
    ),
    send_to_surface_warm: summarizeTimedSamples(
      samples.map((sample) => sample.surface),
    ),
    spawn_close_during_sweep: summarizeTimedSamples(
      samples.map((sample) => sample.spawn_close_during_sweep),
    ),
  };
}

async function measureParallelStress(clients, name, args) {
  const samples = [];
  const requests = Array.from({ length: PARALLEL_STRESS_COUNT }, (_, index) =>
    typeof args === "function" ? args(index) : args,
  );
  const request = {
    parallel: PARALLEL_STRESS_COUNT,
    name,
    arguments: requests,
  };
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    const startedAt = nowMs();
    const receipts = await Promise.all(
      requests.map(async (requestArgs, index) =>
        toolData(
          await clients[index].callTool(name, requestArgs, 30_000),
          name,
        ),
      ),
    );
    samples.push({
      elapsed_ms: nowMs() - startedAt,
      request_bytes: requests.reduce(
        (total, requestArgs) => total + requestBytes(name, requestArgs),
        0,
      ),
      request_sha256: createHash("sha256")
        .update(JSON.stringify(canonicalize(request)))
        .digest("hex"),
      lock_hold_ms: Math.max(
        ...receipts.map((receipt) => receipt.timings_ms?.lock_hold ?? 0),
      ),
      transport: receipts.every(
        (receipt) => operationTransport(receipt, name) === "socket",
      )
        ? "socket"
        : "cli",
      transport_fallbacks: [
        ...new Set(
          receipts.flatMap((receipt) => receipt.transport_fallbacks ?? []),
        ),
      ],
    });
  }
  return { ...summarizeTimedSamples(samples), stress: true };
}

async function main() {
  if (!existsSync(distIndex) || !existsSync(distDaemon)) {
    throw new Error(
      "dist/index.js and dist/daemon.js are required; run bun run build first",
    );
  }
  ({ JsonRpcLineBuffer } = await import("../dist/json-rpc-line-buffer.js"));

  const scratchRoot = process.env.CMUXLAYER_BENCH_SCRATCH
    ? resolve(process.env.CMUXLAYER_BENCH_SCRATCH)
    : join(repoRoot, "docs.local", "scratch", "run5r3");
  await mkdir(scratchRoot, { recursive: true });
  const tempRoot = await mkdtemp(join(scratchRoot, "b-"));
  const socketScratchRoot = join(
    homedir(),
    ".local",
    "state",
    "cmuxlayer",
    "bench",
  );
  await mkdir(socketScratchRoot, { recursive: true });
  const socketRoot = await mkdtemp(join(socketScratchRoot, "b-"));
  const binDir = join(tempRoot, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, "package.json"), '{"type":"commonjs"}\n');
  await writeFakeCmux(binDir);
  const daemonSocket = join(socketRoot, "d.sock");
  const missingCmuxSocket = join(socketRoot, "m.sock");
  const fakeCmuxState = join(tempRoot, "fake-cmux-state.json");
  const surfaceCount = Math.max(clientCount, PARALLEL_STRESS_COUNT);
  const fakeCmuxSocketServer =
    process.env.CMUXLAYER_BENCH_FORCE_CLI_FALLBACK === "1"
      ? net.createServer((socket) => socket.destroy())
      : await startFakeCmuxSocket(
          missingCmuxSocket,
          fakeCmuxState,
          surfaceCount,
        );
  if (process.env.CMUXLAYER_BENCH_FORCE_CLI_FALLBACK === "1") {
    await new Promise((resolvePromise, reject) => {
      fakeCmuxSocketServer.once("error", reject);
      fakeCmuxSocketServer.listen(missingCmuxSocket, resolvePromise);
    });
  }
  const sweepHoldState = join(tempRoot, "sweep-hold-state.json");
  const baseEnv = {
    ...process.env,
    CMUX_AGENT_ID: "",
    CMUX_SURFACE_ID: "",
    CMUX_WORKSPACE_ID: "",
    CMUX_TAB_ID: "",
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    CMUX_SOCKET_PATH: missingCmuxSocket,
    CMUXLAYER_BENCH_SURFACES: String(surfaceCount),
    CMUXLAYER_BENCH_STATE: fakeCmuxState,
    CMUXLAYER_STATE_DIR: join(tempRoot, "state"),
    CMUXLAYER_CONTROL_HEALTH_INTERVAL_MS: "0",
    CMUXLAYER_SWEEP_INTERVAL_MS: "1000",
    CMUXLAYER_SWEEP_IDLE_INTERVAL_MS: "1000",
    CMUXLAYER_NODE_MAX_OLD_SPACE_MB: "1536",
  };

  let baselineClients = [];
  let daemonClients = [];
  let stressClients = [];
  let daemon = null;
  try {
    baselineClients = await startClients("baseline", clientCount, {
      ...baseEnv,
      CMUXLAYER_FORCE_INPROCESS: "1",
      CMUXLAYER_DAEMON_SOCKET: join(socketRoot, "u.sock"),
    });
    const baselineLatency = await measureLatency(baselineClients);
    const baselineRssMb = await totalRssMb(
      baselineClients.map((client) => client.pid).filter(Boolean),
    );

    daemon = spawn(process.execPath, [distDaemon], {
      cwd: repoRoot,
      env: {
        ...baseEnv,
        CMUXLAYER_BENCH_SWEEP_HOLD_STATE: sweepHoldState,
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

    try {
      daemonClients = await startClients("daemon", clientCount, {
        ...baseEnv,
        CMUXLAYER_DAEMON_SOCKET: daemonSocket,
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; daemon stderr=${daemonStderr.trim()}`,
      );
    }
    const daemonLatency = await measureLatency(daemonClients);
    let daemonRssMb;
    let daemonStats;
    const firstSendAfterSpawn = await measureSpawnLifecycleAcrossClients(
      daemonClients,
      sweepHoldState,
      async () => {
        daemonRssMb = await totalRssMb(
          [daemon.pid, ...daemonClients.map((client) => client.pid)].filter(
            Boolean,
          ),
        );
        daemonStats = await processStats(daemon.pid);
      },
    );
    const listAgents = await measureWarmToolAcrossClients(
      daemonClients,
      "list_agents",
      { detail: "summary" },
    );
    const controlHealth = await measureWarmToolAcrossClients(
      daemonClients,
      "control_health",
      {},
    );
    stressClients = await startClients(
      "daemon-stress",
      PARALLEL_STRESS_COUNT,
      {
        ...baseEnv,
        CMUXLAYER_DAEMON_SOCKET: daemonSocket,
      },
    );
    const sendToSurface10Parallel = await measureParallelStress(
      stressClients,
      "send_to",
      (index) => ({
        mode: "surface",
        surface: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        workspace: "workspace:bench",
        text: "parallel surface benchmark",
        press_enter: true,
      }),
    );
    const readScreen10Parallel = await measureParallelStress(
      stressClients,
      "read_screen",
      (index) => ({
        surface: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        workspace: "workspace:bench",
        lines: 5,
      }),
    );
    await Promise.all(stressClients.map((client) => client.close()));
    stressClients = [];
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
      ...(LOCAL_HARD_GATES
        ? {
            local_read_screen_p50_within_250ms:
              daemonLatency.read_screen.p50_ms <= READ_SCREEN_P50_BUDGET_MS,
            local_first_send_after_spawn_within_2s:
              firstSendAfterSpawn.sampled.p50_ms <= 2_000,
            local_cli_send_within_4s:
              firstSendAfterSpawn.send_to_surface_warm.p50_ms <= 4_000,
          }
        : {}),
      surface_receipt_is_waitable:
        typeof firstSendAfterSpawn.surface.receipt.delivery_id === "string" &&
        firstSendAfterSpawn.surface.wait_for.delivery_id ===
          firstSendAfterSpawn.surface.receipt.delivery_id &&
        firstSendAfterSpawn.surface.wait_for.terminal === true,
      socket_transport_only: [
        daemonLatency.list_surfaces,
        daemonLatency.read_screen,
        firstSendAfterSpawn.first,
        firstSendAfterSpawn.second,
        firstSendAfterSpawn.surface,
        listAgents,
        controlHealth,
        firstSendAfterSpawn.spawn_close_during_sweep,
        sendToSurface10Parallel,
        readScreen10Parallel,
      ].every((measurement) => measurement.transport === "socket"),
    };
    const green = Object.values(gates).every(Boolean);
    const result = {
      invocation_nonce: process.env.CMUXLAYER_BENCH_INVOCATION_NONCE ?? null,
      verdict: green ? "GREEN" : "RED",
      clients: clientCount,
      rounds,
      replay: {
        clients: clientCount,
        rounds,
        operations: [
          "list_surfaces",
          "read_screen",
          "send_to_surface_warm",
          "send_to_agent_warm",
          "list_agents",
          "control_health",
          "spawn_close_during_sweep",
          "first_send_after_spawn",
          "send_to_surface_10_parallel",
          "read_screen_10_parallel",
        ],
        row_metadata: {
          list_surfaces: {
            sampling: "sampled",
            samples_per_run: clientCount * rounds,
          },
          read_screen: {
            sampling: "sampled",
            samples_per_run: clientCount * rounds,
          },
          send_to_surface_warm: {
            sampling: "sampled",
            samples_per_run: firstSendAfterSpawn.send_to_surface_warm.sample_count,
          },
          send_to_agent_warm: {
            sampling: "sampled",
            samples_per_run: firstSendAfterSpawn.send_to_agent_warm.sample_count,
          },
          list_agents: {
            sampling: "sampled",
            samples_per_run: listAgents.sample_count,
          },
          control_health: {
            sampling: "sampled",
            samples_per_run: controlHealth.sample_count,
          },
          spawn_close_during_sweep: {
            sampling: "sampled",
            samples_per_run:
              firstSendAfterSpawn.spawn_close_during_sweep.sample_count,
          },
          first_send_after_spawn: {
            sampling: "sampled",
            samples_per_run: firstSendAfterSpawn.sampled.sample_count,
          },
          send_to_surface_10_parallel: {
            sampling: "sampled",
            samples_per_run: sendToSurface10Parallel.sample_count,
            stress: true,
          },
          read_screen_10_parallel: {
            sampling: "sampled",
            samples_per_run: readScreen10Parallel.sample_count,
            stress: true,
          },
        },
        bytes: {
          list_surfaces: daemonLatency.list_surfaces.request_bytes,
          read_screen: daemonLatency.read_screen.request_bytes,
          send_to_surface_warm:
            firstSendAfterSpawn.send_to_surface_warm.request_bytes,
          send_to_agent_warm:
            firstSendAfterSpawn.send_to_agent_warm.request_bytes,
          list_agents: listAgents.request_bytes,
          control_health: controlHealth.request_bytes,
          spawn_close_during_sweep:
            firstSendAfterSpawn.spawn_close_during_sweep.request_bytes,
          first_send_after_spawn: firstSendAfterSpawn.sampled.request_bytes,
          send_to_surface_10_parallel: sendToSurface10Parallel.request_bytes,
          read_screen_10_parallel: readScreen10Parallel.request_bytes,
        },
        request_sha256: {
          list_surfaces: daemonLatency.list_surfaces.request_sha256,
          read_screen: daemonLatency.read_screen.request_sha256,
          send_to_surface_warm:
            firstSendAfterSpawn.send_to_surface_warm.request_sha256,
          send_to_agent_warm:
            firstSendAfterSpawn.send_to_agent_warm.request_sha256,
          list_agents: listAgents.request_sha256,
          control_health: controlHealth.request_sha256,
          spawn_close_during_sweep:
            firstSendAfterSpawn.spawn_close_during_sweep.request_sha256,
          first_send_after_spawn: firstSendAfterSpawn.sampled.request_sha256,
          send_to_surface_10_parallel: sendToSurface10Parallel.request_sha256,
          read_screen_10_parallel: readScreen10Parallel.request_sha256,
        },
        transport: {
          list_surfaces: daemonLatency.list_surfaces.transport,
          read_screen: daemonLatency.read_screen.transport,
          send_to_surface_warm:
            firstSendAfterSpawn.send_to_surface_warm.transport,
          send_to_agent_warm:
            firstSendAfterSpawn.send_to_agent_warm.transport,
          list_agents: listAgents.transport,
          control_health: controlHealth.transport,
          spawn_close_during_sweep:
            firstSendAfterSpawn.spawn_close_during_sweep.transport,
          first_send_after_spawn: firstSendAfterSpawn.sampled.transport,
          send_to_surface_10_parallel: sendToSurface10Parallel.transport,
          read_screen_10_parallel: readScreen10Parallel.transport,
        },
      },
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
          list_agents: listAgents,
          control_health: controlHealth,
          send_to_surface_10_parallel: sendToSurface10Parallel,
          read_screen_10_parallel: readScreen10Parallel,
        },
        first_send_after_spawn: firstSendAfterSpawn,
        send_to_surface_warm: firstSendAfterSpawn.send_to_surface_warm,
        send_to_agent_warm: firstSendAfterSpawn.send_to_agent_warm,
        spawn_close_during_sweep:
          firstSendAfterSpawn.spawn_close_during_sweep,
        send_to_surface_10_parallel: sendToSurface10Parallel,
        read_screen_10_parallel: readScreen10Parallel,
      },
      daemon_cpu_pct: round(daemonStats.cpuPct, 2),
      gates,
    };

    console.log(`cmuxlayer daemon benchmark: ${result.verdict}`);
    console.log(
      `N=${result.clients} rounds=${result.rounds} RSS baseline=${result.rss.baseline_inprocess_total_mb}MB daemon=${result.rss.daemon_total_mb}MB reduction=${result.rss.reduction_mb}MB (${result.rss.reduction_pct}%)`,
    );
    console.log(
      `list_surfaces p50/p95/p99 baseline=${result.latency.baseline_inprocess.list_surfaces.p50_ms}/${result.latency.baseline_inprocess.list_surfaces.p95_ms}/${result.latency.baseline_inprocess.list_surfaces.p99_ms}ms daemon=${result.latency.daemon_path.list_surfaces.p50_ms}/${result.latency.daemon_path.list_surfaces.p95_ms}/${result.latency.daemon_path.list_surfaces.p99_ms}ms`,
    );
    console.log(
      `read_screen p50/p95/p99 baseline=${result.latency.baseline_inprocess.read_screen.p50_ms}/${result.latency.baseline_inprocess.read_screen.p95_ms}/${result.latency.baseline_inprocess.read_screen.p99_ms}ms daemon=${result.latency.daemon_path.read_screen.p50_ms}/${result.latency.daemon_path.read_screen.p95_ms}/${result.latency.daemon_path.read_screen.p99_ms}ms`,
    );
    console.log(
      `send_to first/second/surface=${result.latency.first_send_after_spawn.first.elapsed_ms}/${result.latency.first_send_after_spawn.second.elapsed_ms}/${result.latency.first_send_after_spawn.surface.elapsed_ms}ms`,
    );
    console.log(`daemon CPU=${result.daemon_cpu_pct}%`);
    console.log(JSON.stringify(result, null, 2));

    if (process.env.CMUXLAYER_BENCH_JSON_PATH) {
      const outputPath = resolve(process.env.CMUXLAYER_BENCH_JSON_PATH);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    }

    if (!green) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(
      [...baselineClients, ...daemonClients, ...stressClients].map((client) =>
        client.close(),
      ),
    );
    await stopChild(daemon);
    await new Promise((resolvePromise) =>
      fakeCmuxSocketServer.close(resolvePromise),
    );
    await rm(tempRoot, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
