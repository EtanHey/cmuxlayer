#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const DEFAULT_CONCURRENCY = Object.freeze([1, 5, 10]);
const DEFAULT_PAYLOAD_SIZES = Object.freeze([250, 450, 520, 900]);
const DEFAULT_SAMPLES_PER_WORKER = 12;
const REQUIRED_NIGHTLY_SOCKET = "/tmp/cmux-nightly.sock";

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter((entry) => typeof entry[1] === "string"),
  );
}

function listArg(raw, fallback) {
  if (!raw) return [...fallback];
  return raw.split(",").map((value) => {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`expected comma-separated positive integers, got ${raw}`);
    }
    return parsed;
  });
}

function namedArg(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function nearestRankPercentile(samples, percentile) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("percentile requires at least one sample");
  }
  if (!(percentile > 0 && percentile <= 100)) {
    throw new Error(`percentile must be in (0, 100], got ${percentile}`);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export function buildBenchmarkRows({
  concurrency = DEFAULT_CONCURRENCY,
  payloadSizes = DEFAULT_PAYLOAD_SIZES,
  samplesPerWorker = DEFAULT_SAMPLES_PER_WORKER,
  operations = ["send_to", "read_screen", "list_surfaces"],
  clients = ["mcp", "cli"],
} = {}) {
  if (!Number.isInteger(samplesPerWorker) || samplesPerWorker < 12) {
    throw new Error(
      `samplesPerWorker must be at least 12, got ${samplesPerWorker}`,
    );
  }
  const allowedOperations = new Set(["send_to", "read_screen", "list_surfaces"]);
  const allowedClients = new Set(["mcp", "cli"]);
  for (const operation of operations) {
    if (!allowedOperations.has(operation)) {
      throw new Error(`unsupported operation ${operation}`);
    }
  }
  for (const client of clients) {
    if (!allowedClients.has(client)) {
      throw new Error(`unsupported client ${client}`);
    }
  }

  const rows = [];
  for (const operation of operations) {
    for (const workerCount of concurrency) {
      const sizes = operation === "send_to" ? payloadSizes : [null];
      for (const payloadChars of sizes) {
        for (const client of clients) {
          rows.push({
            operation,
            client,
            concurrency: workerCount,
            payload_chars: payloadChars,
            samples_per_worker: samplesPerWorker,
          });
        }
      }
    }
  }
  return rows;
}

export function summarizeTransport(samples) {
  const transportCounts = {};
  const fallbackCounts = {};
  for (const sample of samples) {
    const transport = nonEmptyString(sample.transport) ?? "unknown";
    transportCounts[transport] = (transportCounts[transport] ?? 0) + 1;
    const fallbacks = Array.isArray(sample.transport_fallbacks)
      ? sample.transport_fallbacks
      : [];
    for (const fallback of fallbacks) {
      const source = nonEmptyString(fallback) ?? "unknown";
      fallbackCounts[source] = (fallbackCounts[source] ?? 0) + 1;
    }
  }
  return {
    transport_counts: transportCounts,
    transport_fallback_counts: fallbackCounts,
  };
}

export function markSurfaceTransportUntrusted(row) {
  if (row.operation !== "send_to" || row.client !== "mcp") return row;
  const inferredTransport = row.payload_chars > 500 ? "cli" : "socket";
  const samples = row.samples.map((sample) => ({
    ...sample,
    reported_transport: sample.transport,
    reported_transport_fallbacks: [...(sample.transport_fallbacks ?? [])],
    transport: "UNTRUSTED",
    transport_fallbacks: ["UNTRUSTED_D180"],
    transport_trust: "untrusted",
    inferred_transport: inferredTransport,
    transport_note:
      "D180: raw-surface send_to outer provenance overwrites the inner paste_text transport context",
  }));
  return {
    ...row,
    reported_transport_counts: { ...row.transport_counts },
    reported_transport_fallback_counts: {
      ...row.transport_fallback_counts,
    },
    transport_counts: { UNTRUSTED: samples.length },
    transport_fallback_counts: { UNTRUSTED_D180: samples.length },
    transport_trust: "untrusted",
    inferred_transport: inferredTransport,
    inference_basis:
      "known 500-character route boundary corroborated by the measured timing signature; inferred, not attested",
    transport_note:
      "D180: raw-surface send_to outer provenance overwrites the inner paste_text transport context",
    samples,
  };
}

export async function runBenchmarkRow(row, deps) {
  const nowMs = deps.nowMs ?? (() => Number(process.hrtime.bigint()) / 1_000_000);
  const workerRuns = Array.from({ length: row.concurrency }, (_, worker) =>
    (async () => {
      const samples = [];
      for (let sample = 0; sample < row.samples_per_worker; sample += 1) {
        const started = nowMs();
        try {
          const receipt = await deps.runOperation({ row, worker, sample });
          samples.push({
            worker,
            sample,
            latency_ms: round(nowMs() - started),
            ok: receipt.ok === true,
            transport: nonEmptyString(receipt.transport) ?? "unknown",
            transport_fallbacks: Array.isArray(receipt.transport_fallbacks)
              ? [...receipt.transport_fallbacks]
              : [],
            ...(receipt.error ? { error: String(receipt.error) } : {}),
          });
        } catch (error) {
          samples.push({
            worker,
            sample,
            latency_ms: round(nowMs() - started),
            ok: false,
            transport: "unknown",
            transport_fallbacks: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return samples;
    })(),
  );
  const samples = (await Promise.all(workerRuns)).flat();
  const latencies = samples.map((sample) => sample.latency_ms);
  return {
    ...row,
    concurrency_profile: `c${row.concurrency}`,
    sample_count: samples.length,
    p50_ms: round(nearestRankPercentile(latencies, 50)),
    p95_ms: round(nearestRankPercentile(latencies, 95)),
    error_count: samples.filter((sample) => !sample.ok).length,
    ...summarizeTransport(samples),
    samples,
  };
}

export function assertNightlyIsolation(env) {
  const cmuxSocketPath = nonEmptyString(env.CMUX_SOCKET_PATH);
  if (cmuxSocketPath !== REQUIRED_NIGHTLY_SOCKET) {
    throw new Error(
      `refusing non-nightly cmux socket ${cmuxSocketPath ?? "(unset)"}; set CMUX_SOCKET_PATH=${REQUIRED_NIGHTLY_SOCKET}`,
    );
  }
  const daemonSocketPath = nonEmptyString(env.CMUXLAYER_DAEMON_SOCKET);
  if (
    !daemonSocketPath ||
    daemonSocketPath.endsWith("/cmuxlayer-stated.sock") ||
    !/(nightly|run10)/i.test(daemonSocketPath)
  ) {
    throw new Error(
      "refusing shared daemon socket; set CMUXLAYER_DAEMON_SOCKET to an isolated daemon path containing Nightly/Run10",
    );
  }
  return { cmuxSocketPath, daemonSocketPath };
}

function resultPayload(result) {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return { text };
  }
}

function mcpReceipt(result) {
  const payload = resultPayload(result);
  return {
    ok: result.isError !== true && payload.ok !== false,
    transport: nonEmptyString(payload.transport) ?? "unknown",
    transport_fallbacks: Array.isArray(payload.transport_fallbacks)
      ? payload.transport_fallbacks.filter((value) => typeof value === "string")
      : [],
    ...(result.isError === true || payload.ok === false
      ? { error: nonEmptyString(payload.error) ?? "MCP tool returned an error" }
      : {}),
  };
}

function execCapture(command, args, { env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(
        reject,
        new Error(
          `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      settle(reject, error);
    });
    child.once("close", (code, signal) => {
      if (code !== 0) {
        settle(
          reject,
          new Error(
            `${command} ${args.join(" ")} exited code=${code} signal=${signal}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      settle(resolvePromise, { stdout, stderr });
    });
  });
}

function waitForSocket(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  let retryTimer = null;
  const promise = new Promise((resolvePromise, reject) => {
    const attempt = () => {
      if (cancelled) return;
      const socket = net.createConnection({ path });
      let settled = false;
      const finish = (connected) => {
        if (settled || cancelled) {
          socket.removeAllListeners();
          // Swallow destroy-time errors from a cancelled or already-finished probe.
          socket.on("error", ignoreFollowOnError);
          socket.destroy();
          return;
        }
        settled = true;
        socket.removeAllListeners();
        socket.on("error", ignoreFollowOnError);
        socket.destroy();
        if (connected) {
          resolvePromise();
        } else if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for socket ${path}`));
        } else {
          retryTimer = setTimeout(attempt, 50);
        }
      };
      socket.setTimeout(250, () => finish(false));
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    };
    attempt();
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}

function ignoreFollowOnError() {
  // Used for destroy-time socket errors and best-effort scratch teardown after
  // a create failure so the original error remains the thrown cause.
}

export function openExclusiveWriteStream(path) {
  return new Promise((resolvePromise, reject) => {
    const stream = createWriteStream(path, { flags: "wx" });
    function onOpen() {
      stream.off("error", onError);
      resolvePromise(stream);
    }
    function onError(error) {
      stream.off("open", onOpen);
      reject(error);
    }
    stream.once("open", onOpen);
    stream.once("error", onError);
  });
}

async function startIsolatedDaemon(entry, env, daemonSocketPath, logPath) {
  if (existsSync(daemonSocketPath)) {
    throw new Error(
      `isolated daemon socket already exists; refusing to reap an unowned path: ${daemonSocketPath}`,
    );
  }
  const log = await openExclusiveWriteStream(logPath);
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let earlyExit = null;
  let rejectSpawnFailure = ignoreFollowOnError;
  const spawnFailure = new Promise((_, reject) => {
    rejectSpawnFailure = reject;
  });
  const onSpawnError = (error) => rejectSpawnFailure(error);
  child.once("error", onSpawnError);
  child.once("exit", (code, signal) => {
    earlyExit = { code, signal };
  });
  const socketWait = waitForSocket(daemonSocketPath);
  try {
    await Promise.race([socketWait.promise, spawnFailure]);
    child.off("error", onSpawnError);
    if (earlyExit) {
      throw new Error(
        `isolated daemon exited before readiness: ${JSON.stringify(earlyExit)}`,
      );
    }
  } catch (error) {
    socketWait.cancel();
    child.off("error", onSpawnError);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    log.end();
    await rm(daemonSocketPath, { force: true });
    throw error;
  }
  return {
    pid: child.pid,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((resolveExit) => child.once("exit", resolveExit)),
          new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
        ]);
      }
      log.end();
      await rm(daemonSocketPath, { force: true });
    },
  };
}

export async function readGitHead(
  execGit = () => execCapture("git", ["rev-parse", "HEAD"]),
) {
  try {
    const { stdout } = await execGit();
    return stdout.trim();
  } catch {
    return null;
  }
}

async function connectMcpClient(entry, env, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: repoRoot,
    env: stringEnv(env),
    stderr: "inherit",
  });
  const client = new Client({ name: `cmuxlayer-bench-e2e-${label}`, version: "1" });
  await client.connect(transport);
  return client;
}

export function payloadText(size, worker, sample) {
  const prefix = `: run10-e2e w${worker}s${sample} `;
  if (prefix.length > size) return prefix.slice(0, size);
  return prefix + "x".repeat(size - prefix.length);
}

function createdSurfaceFromOutput(stdout) {
  const match = stdout.match(/\b(surface:\d+)\b/);
  if (!match) {
    throw new Error(
      `cmux new-split returned no surface ref: ${JSON.stringify(stdout.trim())}`,
    );
  }
  return match[1];
}

export async function createScratchTargets(count, deps) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`scratch target count must be positive, got ${count}`);
  }
  const targets = [];
  let anchor = deps.controllerSurface;
  const closeRecorded = async () => {
    const failures = [];
    for (const surface of [...targets].reverse()) {
      try {
        await deps.execCmux([
          "close-surface",
          "--workspace",
          deps.workspace,
          "--surface",
          surface,
        ]);
      } catch (error) {
        failures.push(
          `${surface}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(`scratch teardown failed: ${failures.join("; ")}`);
    }
  };
  try {
    for (let index = 0; index < count; index += 1) {
      const { stdout } = await deps.execCmux([
        "new-split",
        "right",
        "--workspace",
        deps.workspace,
        "--surface",
        anchor,
        "--focus",
        "false",
      ]);
      const surface = createdSurfaceFromOutput(stdout);
      targets.push(surface);
      anchor = surface;
    }
  } catch (error) {
    await closeRecorded().catch(ignoreFollowOnError);
    throw error;
  }
  return { targets: Object.freeze([...targets]), close: closeRecorded };
}

export function operationArgs(row, surface, workspace, worker, sample) {
  if (row.operation === "send_to") {
    return {
      mode: "surface",
      surface,
      text: payloadText(row.payload_chars, worker, sample),
      press_enter: true,
      allow_long_inline: true,
    };
  }
  if (row.operation === "read_screen") {
    return { surface, lines: 20, parsed_only: true };
  }
  return { workspace, verbose: false };
}

export function cliOperationArgs(row, surface, workspace, worker, sample) {
  if (row.operation === "send_to") {
    return [
      "send",
      "--workspace",
      workspace,
      "--surface",
      surface,
      `${payloadText(row.payload_chars, worker, sample)}\n`,
    ];
  }
  if (row.operation === "read_screen") {
    return [
      "read-screen",
      "--workspace",
      workspace,
      "--surface",
      surface,
      "--lines",
      "20",
    ];
  }
  return ["list-workspaces"];
}

async function runCliOperation(row, config, worker, sample) {
  const args = cliOperationArgs(
    row,
    config.surface,
    config.workspace,
    worker,
    sample,
  );
  await execCapture(config.cmuxBin, args, { env: config.env });
  return { ok: true, transport: "cli", transport_fallbacks: [] };
}

function compactCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0
    ? "none"
    : entries.map(([name, count]) => `${name}:${count}`).join(",");
}

export function renderMarkdownTable(rows) {
  const lines = [
    "| operation | profile | payload | client | n | p50 ms | p95 ms | errors | transport | fallbacks |",
    "|---|---:|---:|---|---:|---:|---:|---:|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.operation} | ${row.concurrency_profile} | ${row.payload_chars ?? "-"} | ${row.client} | ${row.sample_count} | ${row.p50_ms} | ${row.p95_ms} | ${row.error_count} | ${compactCounts(row.transport_counts)} | ${compactCounts(row.transport_fallback_counts)} |`,
    );
  }
  return lines.join("\n");
}

function parseConfig(argv, env) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const samplesPerWorker = Number(
    namedArg(argv, "--samples-per-worker") ?? DEFAULT_SAMPLES_PER_WORKER,
  );
  const operations = (
    namedArg(argv, "--operations") ?? "send_to,read_screen,list_surfaces"
  ).split(",");
  const clients = (namedArg(argv, "--clients") ?? "mcp,cli").split(",");
  const out = resolve(
    namedArg(argv, "--out") ??
      join(repoRoot, "docs.local", "scratch", "run10-phase1", "bench-e2e.json"),
  );
  return {
    help: false,
    samplesPerWorker,
    concurrency: listArg(namedArg(argv, "--concurrency"), DEFAULT_CONCURRENCY),
    payloadSizes: listArg(namedArg(argv, "--payload-sizes"), DEFAULT_PAYLOAD_SIZES),
    operations,
    clients,
    out,
    surface: namedArg(argv, "--surface") ?? nonEmptyString(env.CMUX_SURFACE_ID),
    workspace: namedArg(argv, "--workspace") ?? nonEmptyString(env.CMUX_WORKSPACE_ID),
    cmuxBin: namedArg(argv, "--cmux-bin") ?? "cmux",
    mcpEntry: resolve(namedArg(argv, "--mcp-entry") ?? join(repoRoot, "dist", "index.js")),
    daemonEntry: resolve(
      namedArg(argv, "--daemon-entry") ?? join(repoRoot, "dist", "daemon.js"),
    ),
  };
}

const HELP = `bench-e2e.mjs — isolated agent-side MCP vs direct cmux CLI benchmark

Required environment:
  CMUX_SOCKET_PATH=/tmp/cmux-nightly.sock
  CMUXLAYER_DAEMON_SOCKET=<isolated path containing nightly or run10>

Options:
  --surface <surface:ref>        default: CMUX_SURFACE_ID
  --workspace <workspace:ref>    default: CMUX_WORKSPACE_ID
  --samples-per-worker <n>       minimum/default: 12
  --concurrency <csv>            default: 1,5,10
  --payload-sizes <csv>          default: 250,450,520,900
  --operations <csv>             default: send_to,read_screen,list_surfaces
  --clients <csv>                default: mcp,cli
  --out <path>                   JSON receipt path
`;

async function main() {
  const config = parseConfig(process.argv.slice(2), process.env);
  if (config.help) {
    process.stdout.write(HELP);
    return;
  }
  const isolation = assertNightlyIsolation(process.env);
  if (!config.surface || !config.workspace) {
    throw new Error(
      "surface and workspace are required; run inside the Nightly terminal or pass --surface/--workspace",
    );
  }
  for (const path of [config.mcpEntry, config.daemonEntry]) {
    if (!existsSync(path)) throw new Error(`built entry does not exist: ${path}`);
  }
  const nightlySocket = await stat(isolation.cmuxSocketPath).catch(() => null);
  if (!nightlySocket?.isSocket()) {
    throw new Error(`nightly socket is not live: ${isolation.cmuxSocketPath}`);
  }
  await mkdir(dirname(config.out), { recursive: true });
  const logPath = `${config.out}.daemon.log`;
  const env = stringEnv({
    ...process.env,
    CMUX_SOCKET_PATH: isolation.cmuxSocketPath,
    CMUXLAYER_DAEMON_SOCKET: isolation.daemonSocketPath,
    CMUXLAYER_DEV: "1",
  });
  const rows = buildBenchmarkRows({
    concurrency: config.concurrency,
    payloadSizes: config.payloadSizes,
    samplesPerWorker: config.samplesPerWorker,
    operations: config.operations,
    clients: config.clients,
  });
  const startedAt = new Date().toISOString();
  const daemon = await startIsolatedDaemon(
    config.daemonEntry,
    env,
    isolation.daemonSocketPath,
    logPath,
  );
  const mcpClients = [];
  const results = [];
  let fixture = null;
  let fatalError = null;
  try {
    const maxConcurrency = Math.max(1, ...rows.map((row) => row.concurrency));
    fixture = await createScratchTargets(maxConcurrency, {
      workspace: config.workspace,
      controllerSurface: config.surface,
      execCmux: (args) => execCapture(config.cmuxBin, args, { env }),
    });
    const maxMcpConcurrency = Math.max(
      0,
      ...rows.filter((row) => row.client === "mcp").map((row) => row.concurrency),
    );
    for (let index = 0; index < maxMcpConcurrency; index += 1) {
      mcpClients.push(await connectMcpClient(config.mcpEntry, env, index));
    }
    await Promise.all(
      mcpClients.map((client) =>
        client.callTool(
          { name: "list_surfaces", arguments: { workspace: config.workspace } },
          undefined,
          { timeout: 30_000 },
        ),
      ),
    );
    for (const [index, row] of rows.entries()) {
      process.stderr.write(
        `[bench-e2e] row ${index + 1}/${rows.length} ${row.operation} c${row.concurrency} payload=${row.payload_chars ?? "-"} ${row.client}\n`,
      );
      const measured = await runBenchmarkRow(row, {
        runOperation: async ({ worker, sample }) => {
          if (row.client === "cli") {
            return runCliOperation(
              row,
              {
                cmuxBin: config.cmuxBin,
                env,
                surface: fixture.targets[worker],
                workspace: config.workspace,
              },
              worker,
              sample,
            );
          }
          const toolResult = await mcpClients[worker].callTool(
            {
              name: row.operation,
              arguments: operationArgs(
                row,
                fixture.targets[worker],
                config.workspace,
                worker,
                sample,
              ),
            },
            undefined,
            { timeout: 30_000 },
          );
          return mcpReceipt(toolResult);
        },
      });
      const result = markSurfaceTransportUntrusted(measured);
      results.push(result);
    }
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
  } finally {
    await Promise.allSettled(mcpClients.map((client) => client.close()));
    if (fixture) {
      try {
        await fixture.close();
      } catch (error) {
        fatalError ??= error instanceof Error ? error.message : String(error);
      }
    }
    await daemon.stop();
  }

  const receipt = {
    schema_version: 1,
    kind: "cmuxlayer-agent-side-e2e-benchmark",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    git_head: await readGitHead(() =>
      execCapture("git", ["rev-parse", "HEAD"], { env }),
    ),
    environment: {
      cmux_socket_path: isolation.cmuxSocketPath,
      daemon_socket_path: isolation.daemonSocketPath,
      isolated_daemon_pid: daemon.pid,
      daemon_log: logPath,
      controller_surface: config.surface,
      scratch_surfaces: fixture?.targets ?? [],
      workspace: config.workspace,
      load_model: "none (synthetic MCP/CLI clients; no LLM seats launched)",
      estimated_model_cost_usd: 0,
    },
    row_schema: {
      identity: ["operation", "client", "concurrency_profile", "payload_chars"],
      aggregate: ["sample_count", "p50_ms", "p95_ms", "error_count"],
      transport: ["transport_counts", "transport_fallback_counts"],
      raw_sample: [
        "worker",
        "sample",
        "latency_ms",
        "ok",
        "transport",
        "transport_fallbacks",
        "error?",
      ],
    },
    rows: results,
    fatal_error: fatalError,
  };
  await writeFile(config.out, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${renderMarkdownTable(results)}\n`);
  process.stdout.write(`[bench-e2e] receipt ${config.out}\n`);
  if (fatalError || results.some((row) => row.error_count > 0)) {
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  main().catch((error) => {
    process.stderr.write(
      `[bench-e2e] fatal ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
