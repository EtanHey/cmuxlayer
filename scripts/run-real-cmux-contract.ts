#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ORPHAN_PARENT_MODE = "--orphan-parent";
const ORPHAN_CHILD_MODE = "--orphan-child";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface SocketProbeReceipt {
  ok: boolean;
  result?: unknown;
  code?: string;
  errno?: number;
  message?: string;
}

export interface OrphanProbeReceipt extends SocketProbeReceipt {
  pid: number;
  ppid: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorReceipt(error: unknown): SocketProbeReceipt {
  const nodeError = error instanceof Error
    ? (error as Error & { code?: string; errno?: number })
    : null;
  return {
    ok: false,
    code: nodeError?.code ?? "ERROR",
    ...(typeof nodeError?.errno === "number" ? { errno: nodeError.errno } : {}),
    message: nodeError?.message ?? String(error),
  };
}

export function probeSystemPing(
  socketPath: string,
  timeoutMs = 2_000,
): Promise<SocketProbeReceipt> {
  return new Promise((resolveProbe) => {
    const id = randomUUID();
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let buffer = "";
    const settle = (receipt: SocketProbeReceipt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolveProbe(receipt);
    };
    const timer = setTimeout(
      () =>
        settle({
          ok: false,
          code: "ETIMEDOUT",
          message: `system.ping timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    );

    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ id, method: "system.ping", params: {} })}\n`,
        (error) => {
          if (error) settle(errorReceipt(error));
        },
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response: unknown = JSON.parse(line);
        if (!isRecord(response) || response.id !== id) {
          settle({
            ok: false,
            code: "EPROTO",
            message: `system.ping returned an unexpected frame: ${line}`,
          });
          return;
        }
        if (response.ok !== true) {
          const error = isRecord(response.error) ? response.error : {};
          settle({
            ok: false,
            code: typeof error.code === "string" ? error.code : "ERROR",
            message:
              typeof error.message === "string"
                ? error.message
                : JSON.stringify(response.error),
          });
          return;
        }
        settle({ ok: true, result: response.result });
      } catch (error) {
        settle(errorReceipt(error));
      }
    });
    socket.once("error", (error) => settle(errorReceipt(error)));
    socket.once("close", () => {
      settle({
        ok: false,
        code: "ECONNRESET",
        message: "cmux socket closed before system.ping responded",
      });
    });
  });
}

export function assertPingShape(value: unknown): asserts value is {
  pong: true;
} {
  if (!isRecord(value) || value.pong !== true) {
    throw new Error(
      `system.ping must return { pong: true }, got ${JSON.stringify(value)}`,
    );
  }
}

export function classifyLivePin(
  socketPath: string | undefined,
  receipt: SocketProbeReceipt | null,
):
  | { kind: "skip"; reason: string }
  | { kind: "run"; socketPath: string } {
  const pin = socketPath?.trim();
  if (!pin) {
    return { kind: "skip", reason: "CMUX_SOCKET_PATH is not set" };
  }
  if (!receipt?.ok) {
    const detail = receipt
      ? `${receipt.code ?? "ERROR"}: ${receipt.message ?? "unknown error"}`
      : "not probed";
    return {
      kind: "skip",
      reason: `CMUX_SOCKET_PATH is not reachable: ${pin} (${detail})`,
    };
  }
  return { kind: "run", socketPath: pin };
}

export function parseOrphanReceipt(raw: string): OrphanProbeReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid orphan probe receipt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(value) ||
    !Number.isInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    !Number.isInteger(value.ppid) ||
    Number(value.ppid) < 0 ||
    typeof value.ok !== "boolean" ||
    (value.code !== undefined && typeof value.code !== "string") ||
    (value.errno !== undefined && typeof value.errno !== "number") ||
    (value.message !== undefined && typeof value.message !== "string")
  ) {
    throw new Error(`invalid orphan probe receipt: ${raw}`);
  }
  return value as unknown as OrphanProbeReceipt;
}

export function isAncestryDenial(receipt: OrphanProbeReceipt): boolean {
  if (receipt.ok || receipt.ppid !== 1) return false;
  return (
    receipt.code === "EPIPE" ||
    receipt.errno === 32 ||
    /\b(?:EPIPE|broken pipe|errno\s*32)\b/i.test(receipt.message ?? "")
  );
}

function toolText(result: Record<string, unknown>): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is Record<string, unknown> & { text: string } =>
        isRecord(item) && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export function extractStructuredContent(
  response: unknown,
): Record<string, unknown> {
  if (!isRecord(response)) {
    throw new Error(`invalid MCP response: ${JSON.stringify(response)}`);
  }
  if (response.error !== undefined) {
    throw new Error(`MCP response error: ${JSON.stringify(response.error)}`);
  }
  if (!isRecord(response.result)) {
    throw new Error(`MCP response missing result: ${JSON.stringify(response)}`);
  }
  const text = toolText(response.result);
  if (response.result.isError === true) {
    throw new Error(`MCP tool error: ${text || JSON.stringify(response.result)}`);
  }
  if (isRecord(response.result.structuredContent)) {
    return response.result.structuredContent;
  }
  if (text) {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
  }
  throw new Error(
    `MCP response missing structured content: ${JSON.stringify(response.result)}`,
  );
}

export function selectTerminalSurface(payload: Record<string, unknown>): {
  surface: string;
  workspace: string;
} {
  const surfaces = Array.isArray(payload.surfaces) ? payload.surfaces : [];
  for (const surface of surfaces) {
    if (
      isRecord(surface) &&
      surface.type === "terminal" &&
      typeof surface.ref === "string" &&
      surface.ref.length > 0 &&
      typeof surface.workspace_ref === "string" &&
      surface.workspace_ref.length > 0
    ) {
      return { surface: surface.ref, workspace: surface.workspace_ref };
    }
  }
  throw new Error("list_surfaces returned no terminal surface to read");
}

export function daemonPidFromHealth(payload: Record<string, unknown>): number {
  const health = isRecord(payload.health) ? payload.health : null;
  const current = health && isRecord(health.current_process)
    ? health.current_process
    : null;
  const pid = current?.pid;
  if (!Number.isInteger(pid) || Number(pid) <= 0) {
    throw new Error(
      `control_health response had no daemon pid: ${JSON.stringify(payload)}`,
    );
  }
  return Number(pid);
}

export function daemonSpawnPidFromLog(message: string): number | null {
  const matches = [
    ...message.matchAll(/daemon spawn fired \([^\n]*\bpid=(\d+)\)/g),
  ];
  const match = matches.at(-1);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function assertLiveHealth(
  payload: Record<string, unknown>,
  cmuxSocket: string,
): void {
  const health = isRecord(payload.health) ? payload.health : null;
  const transport = health && isRecord(health.selected_transport)
    ? health.selected_transport
    : null;
  if (
    !health ||
    !transport ||
    transport.transport_mode !== "socket" ||
    transport.current_socket_path !== cmuxSocket ||
    transport.transport_degraded !== false
  ) {
    throw new Error(
      `control_health did not report socket-mode health on ${cmuxSocket}: ${JSON.stringify(payload)}`,
    );
  }
}

export function assertDoctorReport(
  report: unknown,
  cmuxSocket: string,
  daemonSocket: string,
): void {
  const record = isRecord(report) ? report : null;
  const daemon = record && isRecord(record.daemon) ? record.daemon : null;
  const socketPath = record && isRecord(record.socketPath)
    ? record.socketPath
    : null;
  if (
    !record ||
    record.healthy !== true ||
    daemon?.ok !== true ||
    daemon.socketPath !== daemonSocket ||
    socketPath?.set !== true ||
    socketPath.value !== cmuxSocket
  ) {
    throw new Error(
      `doctor --json was not healthy on the isolated live stack: ${JSON.stringify(report)}`,
    );
  }
}

export function assertOwnedDaemonSocket(
  ownedRoot: string,
  daemonSocket: string,
): void {
  const root = resolve(ownedRoot);
  const socket = resolve(daemonSocket);
  if (socket === root || !socket.startsWith(`${root}${sep}`)) {
    throw new Error(
      `refusing daemon lifecycle action outside owned contract root: ${socket}`,
    );
  }
}

export function cleanupPidOrder(
  recordedPids: ReadonlySet<number>,
  proxyPid: number | undefined,
): number[] {
  const reverseSpawnOrder = [...recordedPids].reverse();
  if (!proxyPid || !recordedPids.has(proxyPid)) return reverseSpawnOrder;
  return [proxyPid, ...reverseSpawnOrder.filter((pid) => pid !== proxyPid)];
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  await waitFor(() => !processExists(pid), timeoutMs, `process ${pid} to exit`);
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  let value = "";
  await waitFor(
    async () => {
      try {
        value = await readFile(path, "utf8");
        return value.length > 0;
      } catch {
        return false;
      }
    },
    timeoutMs,
    `contract receipt ${path}`,
  );
  return value;
}

class McpPeer {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    {
      resolve: (message: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly stderr: string[] = [];

  constructor(
    readonly child: ChildProcess,
    onSpawnedPid?: (pid: number) => void,
  ) {
    if (!child.stdin || !child.stdout) {
      throw new Error("dist MCP child stdio must be piped");
    }
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.processBuffer();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk.toString("utf8"));
      const pid = daemonSpawnPidFromLog(this.stderr.join(""));
      if (pid !== null) onSpawnedPid?.(pid);
    });
    child.once("exit", (code, signal) => {
      const error = new Error(
        `dist MCP child exited (code=${code ?? "none"}, signal=${signal ?? "none"})\n${this.stderr.join("")}`,
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  private processBuffer(): void {
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `dist MCP emitted malformed JSON: ${line}; ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isRecord(message) || typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  sendNotification(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for MCP ${method}\n${this.stderr.join("")}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return this.request("tools/call", { name, arguments: args }, timeoutMs);
  }

  close(): void {
    this.child.stdin?.end();
  }
}

async function runOrphanChild(): Promise<void> {
  const receiptPath = process.env.CMUX_CONTRACT_ORPHAN_RECEIPT;
  const socketPath = process.env.CMUX_SOCKET_PATH;
  if (!receiptPath || !socketPath) {
    throw new Error("orphan child requires receipt and socket paths");
  }
  const deadline = Date.now() + 3_000;
  while (process.ppid !== 1 && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  const probe = await probeSystemPing(socketPath, 3_000);
  const receipt: OrphanProbeReceipt = {
    pid: process.pid,
    ppid: process.ppid,
    ...probe,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
}

async function runOrphanParent(): Promise<void> {
  const pidPath = process.env.CMUX_CONTRACT_ORPHAN_PID;
  if (!pidPath) throw new Error("orphan parent requires a pid receipt path");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", SCRIPT_PATH, ORPHAN_CHILD_MODE],
    {
      detached: true,
      env: process.env,
      stdio: "ignore",
    },
  );
  if (!child.pid) throw new Error("orphan child did not expose a pid");
  await writeFile(pidPath, `${child.pid}\n`, "utf8");
  child.unref();
}

async function runOrphanContract(
  root: string,
  socketPath: string,
  recordedPids: Set<number>,
): Promise<OrphanProbeReceipt> {
  const receiptPath = join(root, "orphan-result.json");
  const pidPath = join(root, "orphan.pid");
  const parent = spawn(
    process.execPath,
    ["--import", "tsx", SCRIPT_PATH, ORPHAN_PARENT_MODE],
    {
      env: {
        ...process.env,
        CMUX_SOCKET_PATH: socketPath,
        CMUX_CONTRACT_ORPHAN_RECEIPT: receiptPath,
        CMUX_CONTRACT_ORPHAN_PID: pidPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!parent.pid) throw new Error("orphan parent did not expose a pid");
  recordedPids.add(parent.pid);
  const parentErrors: string[] = [];
  parent.stderr?.on("data", (chunk: Buffer) => {
    parentErrors.push(chunk.toString("utf8"));
  });
  await new Promise<void>((resolveExit, reject) => {
    parent.once("error", reject);
    parent.once("exit", (code) => {
      if (code === 0) resolveExit();
      else
        reject(
          new Error(`orphan parent exited ${code}: ${parentErrors.join("")}`),
        );
    });
  });
  const orphanPid = Number((await waitForFile(pidPath, 3_000)).trim());
  if (!Number.isInteger(orphanPid) || orphanPid <= 0) {
    throw new Error(`orphan parent wrote invalid pid: ${orphanPid}`);
  }
  recordedPids.add(orphanPid);
  return parseOrphanReceipt(await waitForFile(receiptPath, 6_000));
}

async function runDoctor(
  distIndex: string,
  env: NodeJS.ProcessEnv,
  cmuxSocket: string,
  daemonSocket: string,
  recordedPids: Set<number>,
): Promise<void> {
  const child = spawn(process.execPath, [distIndex, "doctor", "--json"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("doctor child did not expose a pid");
  recordedPids.add(child.pid);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) =>
    stdout.push(chunk.toString("utf8")),
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    stderr.push(chunk.toString("utf8")),
  );
  const { code, signal } = await waitForChildExit(child, {
    timeoutMs: 15_000,
    killGraceMs: 2_000,
  });
  if (code !== 0) {
    throw new Error(
      `doctor --json exited code=${code ?? "none"} signal=${signal ?? "none"}: ${stderr.join("") || stdout.join("")}`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(stdout.join(""));
  } catch (error) {
    throw new Error(
      `doctor --json returned invalid JSON: ${stdout.join("")}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertDoctorReport(report, cmuxSocket, daemonSocket);
}

interface ChildExitEmitter {
  pid?: number;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "exit",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): unknown;
  off(event: "error" | "exit", listener: (...args: any[]) => void): unknown;
}

export function waitForChildExit(
  child: ChildExitEmitter,
  opts: {
    timeoutMs: number;
    killGraceMs: number;
    processExists?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
  },
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const pid = child.pid;
  if (!pid) return Promise.reject(new Error("child did not expose a pid"));
  const exists = opts.processExists ?? processExists;
  const kill = opts.kill ?? ((target, signal) => process.kill(target, signal));

  return new Promise((resolveExit, reject) => {
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const timeoutError = () =>
      new Error(`child ${pid} timed out after ${opts.timeoutMs}ms`);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      cleanup();
      if (timedOut) reject(timeoutError());
      else resolveExit({ code, signal });
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        if (exists(pid)) kill(pid, "SIGTERM");
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      killTimer = setTimeout(() => {
        try {
          if (exists(pid)) kill(pid, "SIGKILL");
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        cleanup();
        reject(timeoutError());
      }, opts.killGraceMs);
    }, opts.timeoutMs);

    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function socketAccepts(path: string): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection({ path });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(250, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function terminateRecordedPid(
  pid: number,
  recordedPids: Set<number>,
  signal: NodeJS.Signals = "SIGTERM",
  forceAfterTimeout = false,
): Promise<void> {
  if (!recordedPids.has(pid)) {
    throw new Error(`refusing to signal unrecorded pid ${pid}`);
  }
  if (!processExists(pid)) return;
  process.kill(pid, signal);
  try {
    await waitForProcessExit(pid, 5_000);
  } catch (error) {
    if (!forceAfterTimeout || !processExists(pid)) throw error;
    process.kill(pid, "SIGKILL");
    await waitForProcessExit(pid, 2_000);
  }
}

async function runContract(): Promise<void> {
  const requestedSocket = process.env.CMUX_SOCKET_PATH;
  const preflight = requestedSocket?.trim()
    ? await probeSystemPing(requestedSocket.trim(), 2_000)
    : null;
  const classification = classifyLivePin(requestedSocket, preflight);
  if (classification.kind === "skip") {
    console.warn(`[contract] SKIP: ${classification.reason}`);
    return;
  }
  assertPingShape(preflight?.result);
  const cmuxSocket = classification.socketPath;
  console.log(`[contract] PASS system.ping shape on ${cmuxSocket}`);

  const root = await mkdtemp(join(tmpdir(), "cmuxlayer-real-contract-"));
  const daemonSocket = join(root, "cmuxlayer-stated.sock");
  const home = join(root, "home");
  const recordedPids = new Set<number>();
  let peer: McpPeer | null = null;
  assertOwnedDaemonSocket(root, daemonSocket);

  try {
    const orphan = await runOrphanContract(root, cmuxSocket, recordedPids);
    if (!isAncestryDenial(orphan)) {
      throw new Error(
        `detached-orphan probe was not denied with EPIPE ancestry contract: ${JSON.stringify(orphan)}`,
      );
    }
    console.log(
      `[contract] PASS detached orphan pid=${orphan.pid} denied with ${orphan.code ?? `errno ${orphan.errno}`}`,
    );

    const distIndex = resolve("dist", "index.js");
    const distDaemon = resolve("dist", "daemon.js");
    await Promise.all([access(distIndex), access(distDaemon)]);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      CMUX_SOCKET_PATH: cmuxSocket,
      CMUXLAYER_DAEMON_SOCKET: daemonSocket,
      CMUXLAYER_NODE_MAX_OLD_SPACE_MB: "256",
    };

    const initialDaemon = spawn(process.execPath, [distDaemon], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    if (!initialDaemon.pid) {
      throw new Error("dist daemon did not expose a pid");
    }
    recordedPids.add(initialDaemon.pid);
    const initialDaemonErrors: string[] = [];
    initialDaemon.stderr?.on("data", (chunk: Buffer) =>
      initialDaemonErrors.push(chunk.toString("utf8")),
    );
    await waitFor(
      () => socketAccepts(daemonSocket),
      10_000,
      `dist daemon ${initialDaemon.pid} to listen on ${daemonSocket}; stderr=${initialDaemonErrors.join("")}`,
    );

    const proxy = spawn(process.execPath, [distIndex], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!proxy.pid) throw new Error("dist MCP proxy did not expose a pid");
    recordedPids.add(proxy.pid);
    peer = new McpPeer(proxy, (pid) => recordedPids.add(pid));

    await peer.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cmuxlayer-real-contract", version: "1" },
    });
    peer.sendNotification("notifications/initialized");

    const healthResponse = await peer.callTool("control_health", {}, 15_000);
    const health = extractStructuredContent(healthResponse);
    assertLiveHealth(health, cmuxSocket);
    const initialDaemonPid = daemonPidFromHealth(health);
    if (initialDaemonPid !== initialDaemon.pid) {
      throw new Error(
        `control_health daemon pid ${initialDaemonPid} did not match recorded dist daemon ${initialDaemon.pid}`,
      );
    }

    const listResponse = await peer.callTool("list_surfaces", {}, 20_000);
    const surfaces = extractStructuredContent(listResponse);
    const target = selectTerminalSurface(surfaces);
    const readResponse = await peer.callTool(
      "read_screen",
      {
        surface: target.surface,
        workspace: target.workspace,
        lines: 20,
      },
      15_000,
    );
    const screen = extractStructuredContent(readResponse);
    if (screen.ok !== true || screen.surface !== target.surface) {
      throw new Error(
        `read_screen did not round-trip ${target.surface}: ${JSON.stringify(screen)}`,
      );
    }
    console.log(
      `[contract] PASS list_surfaces/read_screen through dist daemon pid=${initialDaemonPid}`,
    );

    await runDoctor(distIndex, env, cmuxSocket, daemonSocket, recordedPids);
    console.log("[contract] PASS doctor --json healthy on isolated live stack");

    assertOwnedDaemonSocket(root, daemonSocket);
    await terminateRecordedPid(initialDaemonPid, recordedPids);

    const recoveredResponse = await peer.callTool("control_health", {}, 20_000);
    const recoveredHealth = extractStructuredContent(recoveredResponse);
    assertLiveHealth(recoveredHealth, cmuxSocket);
    const replacementDaemonPid = daemonPidFromHealth(recoveredHealth);
    recordedPids.add(replacementDaemonPid);
    if (replacementDaemonPid === initialDaemonPid) {
      throw new Error("isolated daemon did not autostart a replacement pid");
    }
    await runDoctor(distIndex, env, cmuxSocket, daemonSocket, recordedPids);
    console.log(
      `[contract] PASS graceful retire/autostart ${initialDaemonPid} -> ${replacementDaemonPid}`,
    );
    console.log("[contract] PASS real-cmux contract lane");
  } finally {
    peer?.close();
    const proxyPid = peer?.child.pid;
    for (const pid of cleanupPidOrder(recordedPids, proxyPid)) {
      await terminateRecordedPid(pid, recordedPids, "SIGTERM", true).catch(
        (error) => {
          console.error(`[contract] cleanup warning for pid ${pid}:`, error);
        },
      );
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === ORPHAN_PARENT_MODE) {
    await runOrphanParent();
    return;
  }
  if (mode === ORPHAN_CHILD_MODE) {
    await runOrphanChild();
    return;
  }
  await runContract();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(
      `[contract] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
