/**
 * Phase 3 Scope B — proxy child version-bump auto-reconnect.
 */
import net from "node:net";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { CmuxLayerProxy, VersionBumpReconnectGuard } from "../src/proxy.js";

const TEST_ROOT = join("/tmp", "cmuxlayer-proxy-version-bump");

function socketPath(name: string): string {
  return join(TEST_ROOT, `${name}-${process.pid}-${Date.now()}.sock`);
}

function writeFrame(stream: NodeJS.WritableStream, message: JSONRPCMessage) {
  stream.write(serializeMessage(message));
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function createCollector(stream: NodeJS.ReadableStream) {
  const messages: JSONRPCMessage[] = [];
  const events = new EventEmitter();
  const readBuffer = new ReadBuffer();
  stream.on("data", (chunk: Buffer) => {
    readBuffer.append(chunk);
    while (true) {
      const message = readBuffer.readMessage();
      if (message === null) {
        break;
      }
      messages.push(message);
      events.emit("message", message);
    }
  });
  return { messages };
}

class FakeDaemon {
  private server: net.Server | null = null;
  readonly connections: net.Socket[] = [];

  constructor(private readonly path: string) {}

  async start(): Promise<void> {
    rmSync(this.path, { force: true });
    this.server = net.createServer((socket) => {
      this.connections.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          if (req.method === "initialize") {
            socket.write(
              serializeMessage({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  protocolVersion: "2024-11-05",
                  serverInfo: { name: "cmuxlayer", version: "0.3.31" },
                  capabilities: {},
                },
              }),
            );
            return;
          }
          if (req.method === "tools/list") {
            socket.write(
              serializeMessage({
                jsonrpc: "2.0",
                id: req.id,
                result: { tools: [] },
              }),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.path, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.connections.splice(0)) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
  }
}

describe("proxy version-bump auto-reconnect", () => {
  const daemons: FakeDaemon[] = [];
  const proxies: CmuxLayerProxy[] = [];

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
      await proxy.stop();
    }
    for (const daemon of daemons.splice(0)) {
      await daemon.stop();
    }
    rmSync(TEST_ROOT, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reconnects to the daemon when an installed-version bump is detected", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("bump");
    const daemon = new FakeDaemon(path);
    daemons.push(daemon);
    await daemon.start();

    const spawnDaemonForVersionBump = vi.fn().mockResolvedValue(undefined);
    let stale = false;
    const detectStaleBuild = vi.fn(() =>
      stale
        ? { stale: true, running: "0.3.30", installed: "0.3.31" }
        : { stale: false, running: "0.3.30", installed: "0.3.30" },
    );

    const input = new PassThrough();
    const output = new PassThrough();
    createCollector(output);
    const logger = { error: vi.fn() };
    const proxy = new CmuxLayerProxy({
      socketPath: path,
      input,
      output,
      logger,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      reconnectJitterRatio: 0,
      requestTimeoutMs: 500,
      staleRecheckIntervalMs: 20,
      detectStaleBuild,
      spawnDaemonForVersionBump,
      installedDaemonScriptPath: () =>
        "/opt/homebrew/opt/cmuxlayer/dist/daemon.js",
    });
    proxies.push(proxy);
    proxy.start();

    writeFrame(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: {} },
    });
    await waitFor(() => daemon.connections.length > 0);
    const firstConnection = daemon.connections[0];

    stale = true;
    await vi.waitFor(() => spawnDaemonForVersionBump.mock.calls.length > 0, {
      timeout: 2_000,
      interval: 25,
    });
    await waitFor(
      () =>
        daemon.connections.length > 1 ||
        daemon.connections[0] !== firstConnection,
      2_000,
    );

    expect(spawnDaemonForVersionBump).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonScriptPath: "/opt/homebrew/opt/cmuxlayer/dist/daemon.js",
        socketPath: path,
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("installed version bump detected"),
    );
  });

  it("trips the reconnect-storm guard after repeated version-bump attempts", () => {
    const guard = new VersionBumpReconnectGuard({
      maxAttempts: 2,
      windowMs: 60_000,
      now: () => 1_000,
    });

    expect(guard.allow()).toBe(true);
    expect(guard.allow()).toBe(true);
    expect(guard.allow()).toBe(false);
  });
});
