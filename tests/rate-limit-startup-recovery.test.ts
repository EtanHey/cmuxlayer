import net from "node:net";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { CmuxLayerDaemon } from "../src/daemon.js";
import { CmuxLayerProxy } from "../src/proxy.js";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { createServerContext } from "../src/server.js";

const TEST_ROOT = join(tmpdir(), "cmux-rate-startup");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function socketPath(name: string): string {
  return join(TEST_ROOT, `${name}-${process.pid}-${Date.now()}.sock`);
}

function writeFrame(stream: NodeJS.WritableStream, message: JSONRPCMessage) {
  stream.write(serializeMessage(message));
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): JSONRPCRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function responseFor(id: number) {
  return (message: JSONRPCMessage) =>
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    message.id === id &&
    ("result" in message || "error" in message);
}

function collectMessages(stream: NodeJS.ReadableStream) {
  const messages: JSONRPCMessage[] = [];
  const events = new EventEmitter();
  const buffer = new ReadBuffer();
  stream.on("data", (chunk: Buffer) => {
    buffer.append(chunk);
    while (true) {
      const message = buffer.readMessage();
      if (message === null) break;
      messages.push(message);
      events.emit("message", message);
    }
  });
  return {
    waitFor(
      predicate: (message: JSONRPCMessage) => boolean,
      timeoutMs = 2_000,
    ): Promise<JSONRPCMessage> {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          events.off("message", onMessage);
          reject(new Error("timed out waiting for proxy response"));
        }, timeoutMs);
        const onMessage = (message: JSONRPCMessage) => {
          if (!predicate(message)) return;
          clearTimeout(timer);
          events.off("message", onMessage);
          resolve(message);
        };
        events.on("message", onMessage);
      });
    },
  };
}

async function startLimiterSocket(path: string) {
  let pollCount = 0;
  let connectionCount = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connectionCount += 1;
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
        const message = JSON.parse(line) as {
          id: string;
          method: string;
        };
        const polling = new Set([
          "window.list",
          "workspace.list",
          "pane.list",
          "surface.list",
          "surface.read_text",
        ]).has(message.method);
        if (polling) pollCount += 1;
        if (polling && pollCount === 1) {
          socket.write(
            `${JSON.stringify({
              id: message.id,
              ok: false,
              error: {
                code: "rate_limited",
                message: "Polling rate limited for this connection",
              },
            })}\n`,
          );
          continue;
        }
        const result =
          message.method === "window.list"
            ? { windows: [{ ref: "window:1", workspace_count: 1 }] }
            : message.method === "workspace.list"
              ? {
                  workspaces: [
                    {
                      ref: "workspace:1",
                      title: "Test",
                      index: 0,
                      selected: true,
                      pinned: false,
                    },
                  ],
                }
              : message.method === "pane.list"
                ? {
                    workspace_ref: "workspace:1",
                    window_ref: "window:1",
                    panes: [],
                  }
                : message.method === "surface.list"
                  ? {
                      workspace_ref: "workspace:1",
                      window_ref: "window:1",
                      pane_ref: "",
                      surfaces: [],
                    }
                  : { pong: true };
        socket.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    get pollCount() {
      return pollCount;
    },
    get connectionCount() {
      return connectionCount;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(path, { force: true });
    },
  };
}

describe("daemon startup rate-limit recovery", () => {
  it("recovers from rate_limited on the first bootstrap poll and serves a proxy", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const cmuxPath = socketPath("cmux");
    const daemonPath = socketPath("daemon");
    const stateDir = join(TEST_ROOT, `state-${process.pid}`);
    const limiter = await startLimiterSocket(cmuxPath);
    cleanups.push(() => limiter.stop());

    const client = new CmuxSocketClient({
      socketPath: cmuxPath,
      timeoutMs: 500,
      polling: {
        refillMs: 1,
        rateLimitBackoffBaseMs: 1,
        rateLimitBackoffMaxMs: 2,
        maxRateLimitRetries: 2,
        jitter: false,
      },
    });
    const context = createServerContext({
      client,
      stateDir,
      disableSpawnPreflight: true,
      surfaceObserverOwnerIdProvider: () => "observer:test",
      surfaceObserverEpochProvider: () => "observer:test:1",
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: daemonPath,
      context,
      logger: { error: vi.fn() },
    });
    await daemon.start();
    cleanups.push(async () => {
      await daemon.shutdown();
      client.disconnect();
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const collector = collectMessages(output);
    const proxy = new CmuxLayerProxy({
      socketPath: daemonPath,
      input,
      output,
      initialBackoffMs: 1,
      maxBackoffMs: 2,
      reconnectJitterRatio: 0,
      requestTimeoutMs: 1_000,
      logger: { error: vi.fn() },
      env: {},
      probeCmuxSocket: vi.fn().mockResolvedValue({
        usable: true,
        socketPath: cmuxPath,
      }),
    });
    proxy.start();
    cleanups.push(() => proxy.stop());

    writeFrame(input, request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "rate-limit-startup-test", version: "0.1.0" },
    }));

    await expect(collector.waitFor(responseFor(1))).resolves.toMatchObject({
      id: 1,
      result: { serverInfo: { name: "cmuxlayer" } },
    });
    await context.lifecycleStartPromise;
    expect(context.lifecycleStartError).toBeNull();
    expect(limiter.pollCount).toBeGreaterThanOrEqual(2);
    expect(limiter.connectionCount).toBe(1);

    writeFrame(input, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    writeFrame(input, request(2, "tools/list"));

    await expect(collector.waitFor(responseFor(2))).resolves.toMatchObject({
      id: 2,
      result: { tools: expect.any(Array) },
    });
    expect(daemon.activeConnectionCount()).toBe(1);
  }, 5_000);
});
