import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  cpSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const ROOTS = new Set<string>();
const CHILDREN = new Set<ChildProcess>();
const SERVERS = new Set<{
  server: net.Server;
  sockets: Set<net.Socket>;
}>();

beforeAll(() => {
  execFileSync(resolve("node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function processExists(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "state="], {
      encoding: "utf8",
    }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function startFakeCmuxSocket(path: string): Promise<void> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        if (!line.startsWith("{")) {
          socket.write("OK\n");
          continue;
        }
        const request = JSON.parse(line) as {
          id?: string;
          method?: string;
        };
        const result =
          request.method === "system.ping"
            ? { pong: true }
            : request.method === "list_workspaces"
              ? { workspaces: [] }
              : request.method === "list_panes"
                ? { panes: [] }
                : {};
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result })}\n`,
        );
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  SERVERS.add({ server, sockets });
}

function packageJson(version: string): string {
  return `${JSON.stringify({ name: "cmuxlayer", version, type: "module" })}\n`;
}

function createFormulaFixture(root: string, version: string): {
  rootPackage: string;
  libexecPackage: string;
} {
  const optRoot = join(root, "brew", "opt", "cmuxlayer");
  const libexec = join(optRoot, "libexec");
  mkdirSync(libexec, { recursive: true });
  cpSync(resolve("dist"), join(libexec, "dist"), { recursive: true });
  symlinkSync(resolve("node_modules"), join(libexec, "node_modules"), "dir");
  const rootPackage = join(optRoot, "package.json");
  const libexecPackage = join(libexec, "package.json");
  writeFileSync(rootPackage, packageJson(version));
  writeFileSync(libexecPackage, packageJson(version));
  return { rootPackage, libexecPackage };
}

function createMcpPeer(child: ChildProcess, stderr: string[]) {
  const output = child.stdout;
  const input = child.stdin;
  if (!output || !input) {
    throw new Error("live MCP child stdio was not piped");
  }
  const messages: JSONRPCMessage[] = [];
  const events = new EventEmitter();
  const readBuffer = new ReadBuffer();
  output.on("data", (chunk: Buffer) => {
    readBuffer.append(chunk);
    while (true) {
      const message = readBuffer.readMessage();
      if (message === null) break;
      messages.push(message);
      events.emit("message", message);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

  const send = (message: Record<string, unknown>) => {
    input.write(`${JSON.stringify(message)}\n`);
  };
  const waitForResponse = (id: number, timeoutMs: number) => {
    const existing = messages.find(
      (message) => isRecord(message) && message.id === id,
    );
    if (existing) return Promise.resolve(existing);
    return new Promise<JSONRPCMessage>((resolveMessage, reject) => {
      const timer = setTimeout(() => {
        events.off("message", onMessage);
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for MCP response ${id}\n--- child stderr ---\n${stderr.join("")}`,
          ),
        );
      }, timeoutMs);
      const onMessage = (message: JSONRPCMessage) => {
        if (!isRecord(message) || message.id !== id) return;
        clearTimeout(timer);
        events.off("message", onMessage);
        resolveMessage(message);
      };
      events.on("message", onMessage);
    });
  };
  return { send, waitForResponse };
}

function daemonPidFromHealth(
  message: JSONRPCMessage,
  stderr: string[] = [],
): number {
  if (!isRecord(message) || !isRecord(message.result)) {
    throw new Error(
      `control_health response had no result: ${JSON.stringify(message)}\n--- child stderr ---\n${stderr.join("")}`,
    );
  }
  const structured = message.result.structuredContent;
  if (!isRecord(structured) || !isRecord(structured.health)) {
    throw new Error("control_health response had no structured health");
  }
  const currentProcess = structured.health.current_process;
  if (!isRecord(currentProcess) || typeof currentProcess.pid !== "number") {
    throw new Error("control_health response had no daemon pid");
  }
  return currentProcess.pid;
}

afterEach(async () => {
  for (const child of CHILDREN) {
    child.stdin?.end();
    child.kill("SIGTERM");
  }
  CHILDREN.clear();
  for (const { server, sockets } of SERVERS) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  SERVERS.clear();
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
  ROOTS.clear();
});

describe("live daemon-first restart topology", () => {
  it(
    "autostarts a replacement daemon after real stale-build retirement",
    async () => {
      const rootPath = join(
        "/tmp",
        `cmuxlayer-live-restart-${process.pid}-${Date.now()}`,
      );
      mkdirSync(rootPath, { recursive: true });
      const root = realpathSync(rootPath);
      ROOTS.add(root);
      const daemonSocket = join(root, "stated.sock");
      const cmuxSocket = join(root, "cmux.sock");
      const formula = createFormulaFixture(root, "0.3.33");
      await startFakeCmuxSocket(cmuxSocket);

      const stderr: string[] = [];
      const child = spawn(process.execPath, [resolve("dist", "index.js")], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
          HOMEBREW_PREFIX: join(root, "brew"),
          CMUX_SOCKET_PATH: cmuxSocket,
          CMUXLAYER_DAEMON_SOCKET: daemonSocket,
          CMUXLAYER_DEV: "0",
          CMUXLAYER_NODE_MAX_OLD_SPACE_MB: "256",
          CMUXLAYER_STALE_CHECK_INTERVAL_MS: "100",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      CHILDREN.add(child);
      const peer = createMcpPeer(child, stderr);

      peer.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "live-topology-test", version: "1" },
        },
      });
      await peer.waitForResponse(1, 10_000);
      peer.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "control_health", arguments: {} },
      });
      const initialHealth = await peer.waitForResponse(2, 10_000);
      const initialDaemonPid = daemonPidFromHealth(initialHealth);
      expect(processExists(initialDaemonPid)).toBe(true);

      writeFileSync(formula.rootPackage, packageJson("0.3.34"));
      writeFileSync(formula.libexecPackage, packageJson("0.3.34"));
      await waitFor(
        () => !processExists(initialDaemonPid),
        5_000,
        `daemon ${initialDaemonPid} to retire; stderr=${stderr.join("")}`,
      );

      const recoveryStartedAt = Date.now();
      peer.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "control_health", arguments: {} },
      });
      const recoveredHealth = await peer.waitForResponse(3, 15_000);
      const replacementDaemonPid = daemonPidFromHealth(recoveredHealth, stderr);
      expect(replacementDaemonPid).not.toBe(initialDaemonPid);
      expect(Date.now() - recoveryStartedAt).toBeLessThan(15_000);
      process.kill(replacementDaemonPid, "SIGTERM");
    },
    70_000,
  );
});
