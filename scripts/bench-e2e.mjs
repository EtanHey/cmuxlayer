#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

function fairnessContract(operation, work, note) {
  const frozenWork = Object.freeze([...work]);
  return Object.freeze({
    operation,
    comparable: true,
    mcp_work: frozenWork,
    cli_work: Object.freeze([...work]),
    note,
  });
}

export const FAIRNESS_CONTRACTS = Object.freeze({
  send_to: Object.freeze({
    operation: "send_to",
    comparable: false,
    mcp_work: Object.freeze([
      "topology:all-windows:sequential",
      "dynamic-route-and-control-validation",
      "read-screen:safety",
      "payload-dependent-send-or-paste-with-retries",
      "send-key:return-with-retries",
    ]),
    cli_work: null,
    reason:
      "MCP send_to performs dynamic route, control, safety, retry, and payload-dependent paste work that cannot be mirrored by direct cmux send without reimplementing the server; the CLI comparison row is explicitly absent.",
  }),
  read_screen: fairnessContract(
    "read_screen",
    [
      "read-screen:raw-surface",
      "topology:all-windows:sequential-best-effort",
    ],
    "MCP reads a raw surface without a workspace qualifier and then collects all-window topology best-effort; direct CLI uses the same request identity, external primitives, ordering, and churn semantics.",
  ),
  list_surfaces: fairnessContract(
    "list_surfaces",
    [
      "enumerate:all-window-workspaces",
      "topology:target-workspace:parallel-panes",
      "terminal-metadata:socket-empty-noop",
    ],
    "MCP enumerates all-window workspaces, fans target-workspace pane surface reads concurrently, then calls the socket client's in-process empty terminal-metadata method; direct CLI mirrors those external primitives and records the same no-op.",
  ),
});

export function assertCliFairnessTrace(operation, observedWork) {
  const contract = FAIRNESS_CONTRACTS[operation];
  if (!contract) throw new Error(`missing fairness contract for ${operation}`);
  if (!contract.comparable || !contract.cli_work) {
    throw new Error(
      `${operation} is not comparable: ${contract.reason ?? "no equivalent direct CLI arm"}`,
    );
  }
  if (JSON.stringify(observedWork) !== JSON.stringify(contract.cli_work)) {
    throw new Error(
      `fairness contract drift for ${operation}: expected ${JSON.stringify(contract.cli_work)}, observed ${JSON.stringify(observedWork)}`,
    );
  }
}

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
  const allowedOperations = new Set([
    "send_to",
    "read_screen",
    "list_surfaces",
  ]);
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
            comparison_status:
              operation === "send_to" && client === "cli"
                ? "NOT_COMPARABLE"
                : "MEASURED",
            ...(operation === "send_to" && client === "cli"
              ? { comparison_note: FAIRNESS_CONTRACTS.send_to.reason }
              : {}),
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
  const nowMs =
    deps.nowMs ?? (() => Number(process.hrtime.bigint()) / 1_000_000);
  const workerRuns = Array.from({ length: row.concurrency }, (_, worker) =>
    (async () => {
      const samples = [];
      for (let sample = 0; sample < row.samples_per_worker; sample += 1) {
        deps.signal?.throwIfAborted();
        const started = nowMs();
        try {
          const receipt = await deps.runOperation({ row, worker, sample });
          deps.signal?.throwIfAborted();
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
          if (deps.signal?.aborted) throw deps.signal.reason;
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
  const latencies = samples
    .filter((sample) => sample.ok)
    .map((sample) => sample.latency_ms);
  const attemptCount = samples.length;
  const successCount = latencies.length;
  const failureCount = attemptCount - successCount;
  return {
    ...row,
    concurrency_profile: `c${row.concurrency}`,
    sample_count: samples.length,
    attempt_count: attemptCount,
    success_count: successCount,
    failure_rate_pct:
      attemptCount > 0 ? round((failureCount / attemptCount) * 100) : 0,
    p50_ms:
      latencies.length > 0 ? round(nearestRankPercentile(latencies, 50)) : null,
    p95_ms:
      latencies.length > 0 ? round(nearestRankPercentile(latencies, 95)) : null,
    error_count: failureCount,
    ...summarizeTransport(samples),
    samples,
  };
}

export function buildAbsentComparisonRow(row) {
  return {
    ...row,
    comparison_status: "NOT_COMPARABLE",
    attempt_count: 0,
    success_count: 0,
    failure_rate_pct: null,
    sample_count: 0,
    p50_ms: null,
    p95_ms: null,
    error_count: 0,
    transport_counts: {},
    transport_fallback_counts: {},
    samples: [],
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

function execCapture(
  command,
  args,
  { env, timeoutMs = 30_000, signal = null } = {},
) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const cancel = (reason) => {
      timedOut = true;
      terminateChild(child).then(
        () => settle(reject, reason),
        (terminationError) =>
          settle(
            reject,
            new AggregateError(
              [reason, terminationError],
              "command cancellation and child termination failed",
            ),
          ),
      );
    };
    const onAbort = () => cancel(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      const timeoutError = new Error(
        `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`,
      );
      cancel(timeoutError);
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
      if (timedOut) return;
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

export async function terminateChild(child, graceMs = 5_000) {
  const isLive = () => child.exitCode === null && child.signalCode === null;
  const streamsClosed = () =>
    [child.stdout, child.stderr]
      .filter(Boolean)
      .every((stream) => stream.closed || stream.destroyed);
  let resolveFailure = () => undefined;
  const failurePromise = new Promise((resolveFailurePromise) => {
    resolveFailure = resolveFailurePromise;
  });
  const onError = (error) => resolveFailure({ kind: "error", error });
  child.on("error", onError);
  let resolveClose = () => undefined;
  const closePromise = new Promise((resolveClosePromise) => {
    resolveClose = resolveClosePromise;
  });
  const onClose = () => resolveClose({ kind: "close" });
  child.once("close", onClose);
  const waitBounded = async () => {
    let timer = null;
    const outcome = await Promise.race([
      closePromise,
      failurePromise,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ kind: "timeout" }), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome.kind === "error") throw outcome.error;
    return outcome.kind === "close";
  };
  const deliver = (signal) => {
    const delivered = child.kill(signal);
    if (!delivered && isLive()) {
      throw new Error(`failed to deliver ${signal} to child`);
    }
  };
  try {
    if (!isLive()) {
      if (streamsClosed() || (await waitBounded())) return;
      throw new Error(
        "child exited but stdio did not close within the bounded wait",
      );
    }
    deliver("SIGTERM");
    if (await waitBounded()) return;
    if (!isLive()) {
      throw new Error(
        "child exited but stdio did not close within the bounded wait",
      );
    }
    deliver("SIGKILL");
    if (!(await waitBounded())) {
      throw new Error(
        isLive()
          ? "child did not exit after SIGKILL within the bounded wait"
          : "child exited after SIGKILL but stdio did not close within the bounded wait",
      );
    }
  } finally {
    child.off("error", onError);
    child.off("close", onClose);
  }
}

export function beginObservedTermination(child, terminate = terminateChild) {
  const promise = (() => {
    try {
      return terminate(child);
    } catch (error) {
      return Promise.reject(error);
    }
  })();
  promise.catch(() => undefined);
  return promise;
}

export function waitForSocket(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let activeSocket = null;
  let retryTimer = null;
  let settled = false;
  let resolveWait = () => undefined;
  let rejectWait = () => undefined;
  const promise = new Promise((resolvePromise, reject) => {
    resolveWait = resolvePromise;
    rejectWait = reject;
  });
  const settle = (error = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(retryTimer);
    if (activeSocket) {
      activeSocket.removeAllListeners();
      activeSocket.on("error", () => undefined);
      activeSocket.destroy();
      activeSocket = null;
    }
    if (error) rejectWait(error);
    else resolveWait();
  };
  const attempt = () => {
    if (settled) return;
    const socket = net.createConnection({ path });
    activeSocket = socket;
    let attemptSettled = false;
    const finish = (connected) => {
      if (attemptSettled) return;
      attemptSettled = true;
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      if (activeSocket === socket) activeSocket = null;
      if (connected) {
        settle();
      } else if (Date.now() >= deadline) {
        settle(new Error(`timed out waiting for socket ${path}`));
      } else {
        retryTimer = setTimeout(attempt, 50);
      }
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  };
  attempt();
  return {
    promise,
    cancel(reason = new Error(`cancelled socket wait for ${path}`)) {
      settle(reason);
    },
  };
}

export function openExclusiveWriteStream(path, onRuntimeError = null) {
  return new Promise((resolvePromise, reject) => {
    const stream = createWriteStream(path, { flags: "wx" });
    let opened = false;
    const onOpen = () => {
      opened = true;
      resolvePromise(stream);
    };
    const onError = (error) => {
      if (!opened) {
        stream.off("open", onOpen);
        reject(error);
      } else if (onRuntimeError) {
        onRuntimeError(error);
      }
    };
    stream.once("open", onOpen);
    stream.on("error", onError);
  });
}

export async function createSocketReservation(requestedPath) {
  if (existsSync(requestedPath)) {
    throw new Error(
      `isolated daemon socket already exists; refusing to reuse an unowned path: ${requestedPath}`,
    );
  }
  await mkdir(dirname(requestedPath), { recursive: true });
  const ownerDirectory = await mkdtemp(`${requestedPath}.owner-`);
  const socketPath = join(ownerDirectory, "daemon.sock");
  let released = false;
  return {
    ownerDirectory,
    socketPath,
    async release() {
      if (released) return;
      released = true;
      await rm(ownerDirectory, { recursive: true, force: true });
    },
  };
}

export async function createOutputReservation(outputPath) {
  const canonicalOutput = resolve(outputPath);
  const lockPath = `${canonicalOutput}.lock`;
  const reservation = await createPidLock(
    lockPath,
    `benchmark output ${canonicalOutput}`,
  );
  return Object.freeze({
    outputPath: canonicalOutput,
    lockPath,
    release: reservation.release,
  });
}

function processIsLive(pid, signalPid = process.kill) {
  try {
    signalPid(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function createPidLock(lockPath, label) {
  await mkdir(dirname(lockPath), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    acquired = await execCapture(
      "/usr/bin/shlock",
      ["-p", String(process.pid), "-f", lockPath],
      { env: process.env },
    ).then(
      () => true,
      () => false,
    );
    if (acquired) break;
    const ownerText = await readFile(lockPath, "utf8").catch(() => "");
    const ownerPid = Number.parseInt(ownerText.trim(), 10);
    if (
      Number.isSafeInteger(ownerPid) &&
      ownerPid > 0 &&
      processIsLive(ownerPid)
    ) {
      throw new Error(`${label} is already reserved by pid ${ownerPid}`);
    }
    if (attempt === 0) {
      // shlock deliberately refuses to reap a lock whose timestamp changed in
      // the current second. Retry after that atomic-safety window expires.
      await new Promise((resolvePause) => setTimeout(resolvePause, 1_100));
    }
  }
  if (!acquired) {
    throw new Error(`${label} could not reclaim atomic lock ${lockPath}`);
  }
  let released = false;
  return {
    lockPath,
    async release() {
      if (released) return;
      const ownerText = await readFile(lockPath, "utf8");
      if (Number.parseInt(ownerText.trim(), 10) !== process.pid) {
        throw new Error(`${label} ownership changed before release`);
      }
      released = true;
      await rm(lockPath, { force: false });
    },
  };
}

export function createWorkspaceReservation(
  cmuxSocketPath,
  workspace,
  lockRoot = "/tmp",
) {
  const key = createHash("sha256")
    .update(`${resolve(cmuxSocketPath)}\0${workspace}`)
    .digest("hex")
    .slice(0, 24);
  const lockPath = join(lockRoot, `cmuxlayer-bench-workspace-${key}.lock`);
  return createPidLock(
    lockPath,
    `Nightly workspace ${workspace} on ${cmuxSocketPath}`,
  );
}

async function endWritable(log) {
  if (log.writableFinished || log.closed || log.destroyed) return;
  await new Promise((resolvePromise, reject) => {
    function cleanup() {
      log.off("finish", onFinish);
      log.off("error", onError);
    }
    function onFinish() {
      cleanup();
      resolvePromise();
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    log.once("finish", onFinish);
    log.once("error", onError);
    log.end();
  });
}

export async function cleanupDaemonResources({
  child,
  log,
  reservation,
  terminate = terminateChild,
}) {
  const errors = [];
  try {
    await terminate(child);
  } catch (error) {
    errors.push(error);
  }
  child.stdout?.unpipe?.(log);
  child.stderr?.unpipe?.(log);
  try {
    await endWritable(log);
  } catch (error) {
    errors.push(error);
  }
  try {
    await reservation.release();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "isolated daemon cleanup failed");
  }
}

export function daemonLogPath(
  receiptPath,
  pid = process.pid,
  now = Date.now(),
) {
  return `${receiptPath}.daemon-${pid}-${now}.log`;
}

export function buildIsolatedRuntimeEnv(baseEnv, reservation, cmuxSocketPath) {
  const cleanBaseEnv = { ...baseEnv };
  delete cleanBaseEnv.CMUXLAYER_FORCE_INPROCESS;
  delete cleanBaseEnv.CMUXLAYER_DEFAULT_PALETTE;
  delete cleanBaseEnv.CMUXLAYER_DAEMON_FD;
  delete cleanBaseEnv.LISTEN_FDS;
  delete cleanBaseEnv.LISTEN_PID;
  delete cleanBaseEnv.LISTEN_FDNAMES;
  const root = reservation.ownerDirectory;
  const isolatedHome = join(root, "home");
  return stringEnv({
    ...cleanBaseEnv,
    HOME: isolatedHome,
    CMUX_SOCKET_PATH: cmuxSocketPath,
    CMUXLAYER_DAEMON_SOCKET: reservation.socketPath,
    CMUXLAYER_STATE_DIR: join(root, "state"),
    CMUXLAYER_INBOX_BASE_DIR: join(root, "inbox"),
    CMUXLAYER_SESSION_REGISTRY: join(root, "session-registry.jsonl"),
    CMUXLAYER_SEAT_REGISTRY_PATH: join(root, "seat-registry.json"),
    CMUXLAYER_LAUNCHER_REGISTRY_PATH: join(root, "launcher-registry.json"),
    CMUXLAYER_DAEMON_PID_RECEIPT: join(root, "unexpected-daemon-pids.txt"),
    CMUXLAYER_BENCH_OWNER_TOKEN: randomUUID(),
    CMUXLAYER_FLEET_SIDEBAR_OUTPUT_PATH: join(root, "fleet-sidebar.swift"),
    CMUXLAYER_HARNESS_HOME: join(root, "harness"),
    CMUXLAYER_DEV: "1",
  });
}

export function appendFatalError(current, error, phase) {
  const details = [];
  const seen = new Set();
  const visit = (value) => {
    if (value && typeof value === "object") {
      if (seen.has(value)) return;
      seen.add(value);
    }
    const message = value instanceof Error ? value.message : String(value);
    if (message && !details.includes(message)) details.push(message);
    if (Array.isArray(value?.errors)) {
      for (const nested of value.errors) visit(nested);
    }
  };
  visit(error);
  const detail = details.join(" -> ");
  const entry = `${phase}: ${detail}`;
  return current ? `${current}; ${entry}` : entry;
}

export function assertOwnedDaemonHealthy(child, logError = null) {
  if (logError) throw logError;
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `owned isolated daemon pid ${child.pid ?? "unknown"} exited after readiness: ${JSON.stringify({ exitCode: child.exitCode, signalCode: child.signalCode })}`,
    );
  }
}

async function readRecordedDaemonPids(path) {
  const text = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return [...new Set(text.split(/\s+/).filter(Boolean).map(Number))].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0,
  );
}

export async function assertNoUnexpectedDaemons(path, ownedPid) {
  const unexpected = (await readRecordedDaemonPids(path)).filter(
    (pid) => pid !== ownedPid,
  );
  if (unexpected.length > 0) {
    throw new Error(
      `MCP client autostarted unowned daemon pid(s): ${unexpected.join(",")}`,
    );
  }
}

export async function terminateUnexpectedDaemons(
  path,
  ownedPid,
  ownerToken,
  {
    signalPid = process.kill,
    pause = (ms) =>
      new Promise((resolvePause) => setTimeout(resolvePause, ms)),
    verifyPid = async (pid, token) => {
      const result = await execCapture(
        "/bin/ps",
        ["eww", "-p", String(pid), "-o", "command="],
        { env: process.env },
      ).catch(() => null);
      return result?.stdout.includes(
        `CMUXLAYER_BENCH_OWNER_TOKEN=${token}`,
      );
    },
  } = {},
) {
  const unexpected = (await readRecordedDaemonPids(path)).filter(
    (pid) => pid !== ownedPid,
  );
  const failures = [];
  for (const pid of unexpected) {
    try {
      if (!processIsLive(pid, signalPid)) continue;
      if (!(await verifyPid(pid, ownerToken))) {
        throw new Error(
          `refusing to signal unowned or PID-reused process ${pid}`,
        );
      }
      signalPid(pid, "SIGTERM");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!processIsLive(pid, signalPid)) break;
        await pause(25);
      }
      if (processIsLive(pid, signalPid)) {
        signalPid(pid, "SIGKILL");
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (!processIsLive(pid, signalPid)) break;
          await pause(25);
        }
      }
      if (processIsLive(pid, signalPid)) {
        throw new Error(`unowned daemon pid ${pid} survived SIGKILL`);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "unowned daemon cleanup failed");
  }
}

export function appendSettledFailures(current, results, phase) {
  let combined = current;
  for (const result of results) {
    if (result.status === "rejected") {
      combined = appendFatalError(combined, result.reason, phase);
    }
  }
  return combined;
}

async function startIsolatedDaemon(entry, env, reservation, logPath) {
  const daemonSocketPath = reservation.socketPath;
  const daemonPidReceipt = env.CMUXLAYER_DAEMON_PID_RECEIPT;
  const daemonOwnerToken = env.CMUXLAYER_BENCH_OWNER_TOKEN;
  let child = null;
  let logError = null;
  let terminationPromise = null;
  let rejectLogFailure = () => undefined;
  const logFailure = new Promise((_, reject) => {
    rejectLogFailure = reject;
  });
  const log = await openExclusiveWriteStream(logPath, (error) => {
    logError ??= error;
    rejectLogFailure(error);
    if (child) {
      terminationPromise ??= beginObservedTermination(child);
    }
  });
  child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let earlyExit = null;
  let rejectSpawnFailure = () => undefined;
  const spawnFailure = new Promise((_, reject) => {
    rejectSpawnFailure = reject;
  });
  const onSpawnError = (error) => rejectSpawnFailure(error);
  const onEarlyExit = (code, signal) => {
    earlyExit = { code, signal };
    rejectSpawnFailure(
      new Error(
        `isolated daemon exited before readiness: ${JSON.stringify(earlyExit)}`,
      ),
    );
  };
  child.once("error", onSpawnError);
  child.once("exit", onEarlyExit);
  const socketWait = waitForSocket(daemonSocketPath);
  try {
    await Promise.race([socketWait.promise, spawnFailure, logFailure]);
    socketWait.cancel();
    child.off("error", onSpawnError);
    child.off("exit", onEarlyExit);
    spawnFailure.catch(() => undefined);
    logFailure.catch(() => undefined);
    if (logError) throw logError;
    if (earlyExit) {
      throw new Error(
        `isolated daemon exited before readiness: ${JSON.stringify(earlyExit)}`,
      );
    }
  } catch (error) {
    socketWait.cancel();
    child.off("error", onSpawnError);
    child.off("exit", onEarlyExit);
    spawnFailure.catch(() => undefined);
    logFailure.catch(() => undefined);
    let cleanupError = null;
    try {
      await cleanupDaemonResources({
        child,
        log,
        reservation,
        terminate: () => {
          terminationPromise ??= terminateChild(child);
          return terminationPromise;
        },
      });
    } catch (caught) {
      cleanupError = caught;
    }
    const failures = [error, cleanupError, logError].filter(
      (failure, index, all) => failure && all.indexOf(failure) === index,
    );
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "isolated daemon startup and cleanup failed",
      );
    }
    throw failures[0];
  }
  return {
    pid: child.pid,
    async assertHealthy() {
      assertOwnedDaemonHealthy(child, logError);
      await assertNoUnexpectedDaemons(daemonPidReceipt, child.pid);
    },
    async stop() {
      let cleanupError = null;
      let unexpectedDaemonError = null;
      try {
        await terminateUnexpectedDaemons(
          daemonPidReceipt,
          child.pid,
          daemonOwnerToken,
        );
      } catch (error) {
        unexpectedDaemonError = error;
      }
      try {
        await cleanupDaemonResources({
          child,
          log,
          reservation,
          terminate: () => {
            terminationPromise ??= terminateChild(child);
            return terminationPromise;
          },
        });
      } catch (error) {
        cleanupError = error;
      }
      const failures = [unexpectedDaemonError, cleanupError, logError].filter(
        (failure, index, all) => failure && all.indexOf(failure) === index,
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "isolated daemon stop failed");
      }
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
  const client = new Client({
    name: `cmuxlayer-bench-e2e-${label}`,
    version: "1",
  });
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
    try {
      await closeRecorded();
    } catch (teardownError) {
      throw new AggregateError(
        [error, teardownError],
        "scratch target creation and teardown failed",
      );
    }
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

const CMUX_JSON_PREFIX = Object.freeze(["--json", "--id-format", "both"]);

export function cliArgs(row, config, worker, sample) {
  if (row.operation === "send_to") {
    return [
      "send",
      "--workspace",
      config.workspace,
      "--surface",
      config.surface,
      `${payloadText(row.payload_chars, worker, sample)}\n`,
    ];
  }
  if (row.operation === "read_screen") {
    return [
      "read-screen",
      "--surface",
      config.surface,
      "--lines",
      "20",
    ];
  }
  return listWindowsCliArgs();
}

export function listWindowsCliArgs() {
  return [...CMUX_JSON_PREFIX, "list-windows"];
}

export function listWorkspacesCliArgs(window) {
  return [...CMUX_JSON_PREFIX, "list-workspaces", "--window", window];
}

export function listPanesCliArgs(workspace) {
  return [...CMUX_JSON_PREFIX, "list-panes", "--workspace", workspace];
}

export function listPaneSurfacesCliArgs(workspace, pane) {
  return [
    ...CMUX_JSON_PREFIX,
    "list-pane-surfaces",
    "--workspace",
    workspace,
    "--pane",
    pane,
  ];
}

export function paneRefsFromListPanesStdout(stdout) {
  const parsed = parseCliJson(stdout, "list-panes");
  const panes =
    isRecord(parsed) && Array.isArray(parsed.panes) ? parsed.panes : [];
  return panes
    .map((pane) => (isRecord(pane) ? nonEmptyString(pane.ref) : null))
    .filter((ref) => ref !== null);
}

function parseCliJson(stdout, operation) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `cmux ${operation} returned non-JSON: ${JSON.stringify(stdout.trim())}`,
    );
  }
}

async function enumerateCliWorkspaces(config, exec = execCapture) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const windowsOut = await exec(config.cmuxBin, listWindowsCliArgs(), {
      env: config.env,
      signal: config.signal,
    });
    const parsedWindows = parseCliJson(windowsOut.stdout, "list-windows");
    const windows = Array.isArray(parsedWindows)
      ? parsedWindows
      : isRecord(parsedWindows) && Array.isArray(parsedWindows.windows)
        ? parsedWindows.windows
        : null;
    if (!windows) throw new Error("cmux list-windows returned malformed JSON");
    let complete = windows.length > 0;
    const workspaceLists = await Promise.all(
      windows.map(async (window) => {
        const target = isRecord(window)
          ? (nonEmptyString(window.ref) ?? nonEmptyString(window.id))
          : null;
        if (!target) {
          complete = false;
          return [];
        }
        const output = await exec(
          config.cmuxBin,
          listWorkspacesCliArgs(target),
          { env: config.env, signal: config.signal },
        );
        const parsed = parseCliJson(output.stdout, "list-workspaces");
        if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) {
          throw new Error(
            `cmux list-workspaces returned malformed JSON for ${target}`,
          );
        }
        const expected =
          typeof window.workspace_count === "number"
            ? window.workspace_count
            : null;
        if (
          expected === null
            ? parsed.workspaces.length === 0
            : parsed.workspaces.length !== expected
        ) {
          complete = false;
        }
        return parsed.workspaces;
      }),
    );
    if (complete) return workspaceLists.flat();
  }
  throw new Error("incomplete all-window workspace enumeration after retry");
}

function workspaceRefs(workspaces) {
  return workspaces
    .map((workspace) =>
      isRecord(workspace)
        ? (nonEmptyString(workspace.ref) ?? nonEmptyString(workspace.id))
        : null,
    )
    .filter((ref) => ref !== null);
}

async function runCliTopology(
  config,
  workspaces,
  exec = execCapture,
  {
    parallelWorkspaces = false,
    parallelPanes = false,
    bestEffort = false,
  } = {},
) {
  const runWorkspace = async (workspace) => {
    const panes = await (async () => {
      try {
        const panesOut = await exec(
          config.cmuxBin,
          listPanesCliArgs(workspace),
          { env: config.env, signal: config.signal },
        );
        return paneRefsFromListPanesStdout(panesOut.stdout);
      } catch (error) {
        if (bestEffort) return null;
        throw error;
      }
    })();
    if (panes === null) return;
    if (parallelPanes) {
      const work = panes.map((pane) =>
        exec(config.cmuxBin, listPaneSurfacesCliArgs(workspace, pane), {
          env: config.env,
          signal: config.signal,
        }),
      );
      if (bestEffort) await Promise.allSettled(work);
      else await Promise.all(work);
    } else {
      for (const pane of panes) {
        try {
          await exec(config.cmuxBin, listPaneSurfacesCliArgs(workspace, pane), {
            env: config.env,
            signal: config.signal,
          });
        } catch (error) {
          if (!bestEffort) throw error;
        }
      }
    }
  };
  if (parallelWorkspaces) {
    await Promise.all(workspaces.map(runWorkspace));
  } else {
    for (const workspace of workspaces) await runWorkspace(workspace);
  }
}

export async function runCliListSurfaces(config, exec = execCapture) {
  const observedWork = [];
  await enumerateCliWorkspaces(config, exec);
  observedWork.push("enumerate:all-window-workspaces");
  await runCliTopology(config, [config.workspace], exec, {
    parallelWorkspaces: true,
    parallelPanes: true,
  });
  observedWork.push("topology:target-workspace:parallel-panes");
  observedWork.push("terminal-metadata:socket-empty-noop");
  assertCliFairnessTrace("list_surfaces", observedWork);
}

export async function runCliReadScreen(
  config,
  worker,
  sample,
  exec = execCapture,
) {
  const observedWork = [];
  await exec(
    config.cmuxBin,
    cliArgs({ operation: "read_screen" }, config, worker, sample),
    { env: config.env, signal: config.signal },
  );
  observedWork.push("read-screen:raw-surface");
  let workspaces = [];
  try {
    workspaces = await enumerateCliWorkspaces(config, exec);
  } catch {
    // MCP collectSurfaceTopology returns null when all-window enumeration
    // races with topology churn; the successful screen read still succeeds.
  }
  await runCliTopology(config, workspaceRefs(workspaces), exec, {
    bestEffort: true,
  });
  observedWork.push("topology:all-windows:sequential-best-effort");
  assertCliFairnessTrace("read_screen", observedWork);
}

async function runCliOperation(row, config, worker, sample) {
  if (row.operation === "list_surfaces") {
    await runCliListSurfaces(config);
    return { ok: true, transport: "cli", transport_fallbacks: [] };
  }
  if (row.operation === "read_screen") {
    await runCliReadScreen(config, worker, sample);
    return { ok: true, transport: "cli", transport_fallbacks: [] };
  }
  if (row.operation === "send_to") {
    throw new Error(FAIRNESS_CONTRACTS.send_to.reason);
  }
  const args = cliArgs(row, config, worker, sample);
  await execCapture(config.cmuxBin, args, {
    env: config.env,
    signal: config.signal,
  });
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
    "| operation | profile | payload | client | status | attempts | successes | failure % | p50 ms | p95 ms | transport | fallbacks |",
    "|---|---:|---:|---|---|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.operation} | ${row.concurrency_profile} | ${row.payload_chars ?? "-"} | ${row.client} | ${row.comparison_status ?? "MEASURED"} | ${row.attempt_count} | ${row.success_count} | ${row.failure_rate_pct ?? "-"} | ${row.p50_ms ?? "-"} | ${row.p95_ms ?? "-"} | ${compactCounts(row.transport_counts)} | ${compactCounts(row.transport_fallback_counts)} |`,
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
    payloadSizes: listArg(
      namedArg(argv, "--payload-sizes"),
      DEFAULT_PAYLOAD_SIZES,
    ),
    operations,
    clients,
    out,
    surface: namedArg(argv, "--surface") ?? nonEmptyString(env.CMUX_SURFACE_ID),
    workspace:
      namedArg(argv, "--workspace") ?? nonEmptyString(env.CMUX_WORKSPACE_ID),
    cmuxBin: namedArg(argv, "--cmux-bin") ?? "cmux",
    mcpEntry: resolve(
      namedArg(argv, "--mcp-entry") ?? join(repoRoot, "dist", "index.js"),
    ),
    daemonEntry: resolve(
      namedArg(argv, "--daemon-entry") ?? join(repoRoot, "dist", "daemon.js"),
    ),
  };
}

export async function buildRowsAndReserve(
  config,
  requestedSocketPath,
  reserve = createSocketReservation,
) {
  const rows = buildBenchmarkRows({
    concurrency: config.concurrency,
    payloadSizes: config.payloadSizes,
    samplesPerWorker: config.samplesPerWorker,
    operations: config.operations,
    clients: config.clients,
  });
  const socketReservation = await reserve(requestedSocketPath);
  return { rows, socketReservation };
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function prepareBuiltEntries(config, deps = {}) {
  const root = deps.repoRoot ?? repoRoot;
  const exec = deps.exec ?? execCapture;
  const exists = deps.exists ?? existsSync;
  const hashFile = deps.hashFile ?? sha256File;
  const expectedMcpEntry = join(root, "dist", "index.js");
  const expectedDaemonEntry = join(root, "dist", "daemon.js");
  if (
    config.mcpEntry !== expectedMcpEntry ||
    config.daemonEntry !== expectedDaemonEntry
  ) {
    throw new Error(
      "custom built entries have unverifiable source provenance; use the repository dist/index.js and dist/daemon.js",
    );
  }
  const readTrackedStatus = () =>
    exec("git", ["status", "--porcelain", "--untracked-files=no"], {
      env: config.env,
    });
  const readHead = () =>
    exec("git", ["rev-parse", "HEAD"], { env: config.env });
  const status = await readTrackedStatus();
  if (status.stdout.trim()) {
    throw new Error(
      "refusing to benchmark built artifacts from a dirty tracked worktree",
    );
  }
  const head = await readHead();
  await exec("bun", ["run", "build"], { env: config.env });
  const finalStatus = await readTrackedStatus();
  if (finalStatus.stdout.trim()) {
    throw new Error("tracked worktree changed during artifact build");
  }
  const finalHead = await readHead();
  if (finalHead.stdout.trim() !== head.stdout.trim()) {
    throw new Error("repository revision changed during build");
  }
  for (const path of [config.mcpEntry, config.daemonEntry]) {
    if (!exists(path)) throw new Error(`built entry does not exist: ${path}`);
  }
  return {
    git_head: head.stdout.trim(),
    entries: {
      mcp: {
        path: config.mcpEntry,
        sha256: await hashFile(config.mcpEntry),
      },
      daemon: {
        path: config.daemonEntry,
        sha256: await hashFile(config.daemonEntry),
      },
    },
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

export function installGracefulSignalAbort(
  controller,
  processLike = process,
) {
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`benchmark interrupted by ${signal}`));
      }
    };
    handlers.set(signal, handler);
    processLike.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      processLike.off(signal, handler);
    }
  };
}

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
  const abortController = new AbortController();
  const removeSignalHandlers = installGracefulSignalAbort(abortController);
  try {
    const workspaceReservation = await createWorkspaceReservation(
      isolation.cmuxSocketPath,
      config.workspace,
    );
    try {
      abortController.signal.throwIfAborted();
      const outputReservation = await createOutputReservation(config.out);
      try {
        abortController.signal.throwIfAborted();
        await executeBenchmark(config, isolation, abortController.signal);
      } finally {
        await outputReservation.release();
      }
    } finally {
      await workspaceReservation.release();
    }
  } finally {
    removeSignalHandlers();
  }
}

async function executeBenchmark(config, isolation, abortSignal) {
  const artifactProvenance = await prepareBuiltEntries({
    ...config,
    env: process.env,
  });
  abortSignal.throwIfAborted();
  const nightlySocket = await stat(isolation.cmuxSocketPath).catch(() => null);
  if (!nightlySocket?.isSocket()) {
    throw new Error(`nightly socket is not live: ${isolation.cmuxSocketPath}`);
  }
  await mkdir(dirname(config.out), { recursive: true });
  const logPath = daemonLogPath(config.out);
  const { rows, socketReservation } = await buildRowsAndReserve(
    config,
    isolation.daemonSocketPath,
  );
  const env = buildIsolatedRuntimeEnv(
    process.env,
    socketReservation,
    isolation.cmuxSocketPath,
  );
  const startedAt = new Date().toISOString();
  let daemon = null;
  try {
    daemon = await startIsolatedDaemon(
      config.daemonEntry,
      env,
      socketReservation,
      logPath,
    );
  } catch (error) {
    await socketReservation.release();
    throw error;
  }
  const mcpClients = [];
  const results = [];
  let fixture = null;
  let fatalError = null;
  try {
    abortSignal.throwIfAborted();
    const maxConcurrency = Math.max(1, ...rows.map((row) => row.concurrency));
    fixture = await createScratchTargets(maxConcurrency, {
      workspace: config.workspace,
      controllerSurface: config.surface,
      execCmux: (args) => execCapture(config.cmuxBin, args, { env }),
    });
    const maxMcpConcurrency = Math.max(
      0,
      ...rows
        .filter((row) => row.client === "mcp")
        .map((row) => row.concurrency),
    );
    for (let index = 0; index < maxMcpConcurrency; index += 1) {
      abortSignal.throwIfAborted();
      await daemon.assertHealthy();
      mcpClients.push(await connectMcpClient(config.mcpEntry, env, index));
      await daemon.assertHealthy();
      abortSignal.throwIfAborted();
    }
    await daemon.assertHealthy();
    await Promise.all(
      mcpClients.map((client) =>
        client.callTool(
          { name: "list_surfaces", arguments: { workspace: config.workspace } },
          undefined,
          { timeout: 30_000, signal: abortSignal },
        ),
      ),
    );
    await daemon.assertHealthy();
    abortSignal.throwIfAborted();
    for (const [index, row] of rows.entries()) {
      abortSignal.throwIfAborted();
      await daemon.assertHealthy();
      if (row.comparison_status === "NOT_COMPARABLE") {
        process.stderr.write(
          `[bench-e2e] row ${index + 1}/${rows.length} ${row.operation} c${row.concurrency} payload=${row.payload_chars ?? "-"} ${row.client} NOT_COMPARABLE\n`,
        );
        results.push(buildAbsentComparisonRow(row));
        continue;
      }
      process.stderr.write(
        `[bench-e2e] row ${index + 1}/${rows.length} ${row.operation} c${row.concurrency} payload=${row.payload_chars ?? "-"} ${row.client}\n`,
      );
      const measured = await runBenchmarkRow(row, {
        signal: abortSignal,
        runOperation: async ({ worker, sample }) => {
          if (row.client === "cli") {
            return runCliOperation(
              row,
              {
                cmuxBin: config.cmuxBin,
                env,
                signal: abortSignal,
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
            { timeout: 30_000, signal: abortSignal },
          );
          return mcpReceipt(toolResult);
        },
      });
      const result = markSurfaceTransportUntrusted(measured);
      results.push(result);
      await daemon.assertHealthy();
      abortSignal.throwIfAborted();
    }
  } catch (error) {
    fatalError = appendFatalError(fatalError, error, "benchmark");
  } finally {
    const clientStops = await Promise.allSettled(
      mcpClients.map((client) => client.close()),
    );
    fatalError = appendSettledFailures(
      fatalError,
      clientStops,
      "MCP client stop",
    );
    if (fixture) {
      try {
        await fixture.close();
      } catch (error) {
        fatalError = appendFatalError(fatalError, error, "scratch teardown");
      }
    }
    try {
      await daemon.stop();
    } catch (error) {
      fatalError = appendFatalError(fatalError, error, "daemon stop");
    }
  }

  const receipt = {
    schema_version: 1,
    kind: "cmuxlayer-agent-side-e2e-benchmark",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    git_head: artifactProvenance.git_head,
    artifact_provenance: artifactProvenance,
    environment: {
      cmux_socket_path: isolation.cmuxSocketPath,
      requested_daemon_socket_path: isolation.daemonSocketPath,
      daemon_socket_path: socketReservation.socketPath,
      configured_state_path: join(socketReservation.ownerDirectory, "state"),
      daemon_state_path: join(
        socketReservation.ownerDirectory,
        "home",
        ".local",
        "state",
        "cmux-agents",
      ),
      monitor_registry_path: join(
        socketReservation.ownerDirectory,
        "home",
        ".golems-zikaron",
        "monitor-registry.json",
      ),
      watch_registry_path: join(
        socketReservation.ownerDirectory,
        "home",
        ".golems-zikaron",
        "watch-specs.json",
      ),
      isolated_daemon_pid: daemon.pid,
      daemon_log: logPath,
      controller_surface: config.surface,
      scratch_surfaces: fixture?.targets ?? [],
      workspace: config.workspace,
      load_model: "none (synthetic MCP/CLI clients; no LLM seats launched)",
      estimated_model_cost_usd: 0,
    },
    fairness_contracts: FAIRNESS_CONTRACTS,
    row_schema: {
      identity: ["operation", "client", "concurrency_profile", "payload_chars"],
      comparison: ["comparison_status", "comparison_note?"],
      aggregate: [
        "attempt_count",
        "success_count",
        "failure_rate_pct",
        "p50_ms",
        "p95_ms",
        "error_count",
      ],
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
      `[bench-e2e] fatal ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
