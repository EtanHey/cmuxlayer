import net from "node:net";
import { EventEmitter } from "node:events";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  JSONRPCMessage,
  JSONRPCRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { CmuxLayerProxy, computeReconnectDelay } from "../src/proxy.js";

const TEST_ROOT = join(tmpdir(), "cmuxlayer-proxy-test");

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

  const waitForMessage = (
    predicate: (message: JSONRPCMessage) => boolean,
    timeoutMs = 1_000,
  ): Promise<JSONRPCMessage> => {
    const existing = messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        events.off("message", onMessage);
        reject(new Error("timed out waiting for message"));
      }, timeoutMs);
      const onMessage = (message: JSONRPCMessage) => {
        if (!predicate(message)) {
          return;
        }
        clearTimeout(timeout);
        events.off("message", onMessage);
        resolve(message);
      };
      events.on("message", onMessage);
    });
  };

  return { messages, waitForMessage };
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): JSONRPCRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function notification(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0" as const, method, params };
}

function isResponseFor(id: number) {
  return (message: JSONRPCMessage) =>
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    message.id === id &&
    ("result" in message || "error" in message);
}

class FakeDaemon {
  readonly connections: Array<{
    socket: net.Socket;
    messages: JSONRPCMessage[];
  }> = [];
  private server: net.Server | null = null;
  private readonly events = new EventEmitter();
  private readonly sockets = new Set<net.Socket>();
  private readonly held: Array<{
    socket: net.Socket;
    message: JSONRPCMessage;
  }> = [];

  constructor(
    private readonly path: string,
    private readonly opts: {
      holdMethods?: Set<string>;
      initializeError?: boolean;
      closeAfterInitializeError?: boolean;
    } = {},
  ) {}

  async start(): Promise<void> {
    rmSync(this.path, { force: true });
    this.server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.path, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    this.server = null;
    rmSync(this.path, { force: true });
  }

  releaseHeld(method: string): void {
    for (let index = this.held.length - 1; index >= 0; index -= 1) {
      const held = this.held[index];
      if (
        typeof held.message === "object" &&
        held.message !== null &&
        "method" in held.message &&
        held.message.method === method
      ) {
        this.held.splice(index, 1);
        this.respond(held.socket, held.message, { ignoreHold: true });
      }
    }
  }

  waitForMessage(
    connectionIndex: number,
    predicate: (message: JSONRPCMessage) => boolean,
    timeoutMs = 1_000,
  ): Promise<JSONRPCMessage> {
    const existing =
      this.connections[connectionIndex]?.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.events.off("message", onMessage);
        reject(new Error("timed out waiting for daemon message"));
      }, timeoutMs);
      const onMessage = (payload: {
        index: number;
        message: JSONRPCMessage;
      }) => {
        if (payload.index !== connectionIndex || !predicate(payload.message)) {
          return;
        }
        clearTimeout(timeout);
        this.events.off("message", onMessage);
        resolve(payload.message);
      };
      this.events.on("message", onMessage);
    });
  }

  private accept(socket: net.Socket) {
    const connection = { socket, messages: [] as JSONRPCMessage[] };
    const connectionIndex = this.connections.push(connection) - 1;
    const readBuffer = new ReadBuffer();
    this.sockets.add(socket);
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      readBuffer.append(chunk);
      while (true) {
        const message = readBuffer.readMessage();
        if (message === null) {
          break;
        }
        connection.messages.push(message);
        this.events.emit("message", { index: connectionIndex, message });
        this.respond(socket, message);
      }
    });
  }

  private respond(
    socket: net.Socket,
    message: JSONRPCMessage,
    opts: { ignoreHold?: boolean } = {},
  ) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("id" in message) ||
      !("method" in message)
    ) {
      return;
    }
    if (!opts.ignoreHold && this.opts.holdMethods?.has(message.method)) {
      this.held.push({ socket, message });
      return;
    }
    if (message.method === "initialize") {
      if (this.opts.initializeError) {
        const payload = serializeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32000,
            message: "initialize rejected by fake daemon",
          },
        });
        if (this.opts.closeAfterInitializeError) {
          socket.end(payload);
          return;
        }
        socket.write(payload);
        return;
      }
      writeFrame(socket, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          serverInfo: { name: "fake-daemon", version: "0.1.0" },
        },
      });
      return;
    }
    if (message.method === "tools/list") {
      writeFrame(socket, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{ name: "list_surfaces", inputSchema: { type: "object" } }],
        },
      });
      return;
    }
    writeFrame(socket, {
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true },
    });
  }
}

describe("CmuxLayerProxy", () => {
  const daemons: FakeDaemon[] = [];
  const proxies: CmuxLayerProxy[] = [];

  afterEach(async () => {
    await Promise.allSettled(proxies.splice(0).map((proxy) => proxy.stop()));
    await Promise.allSettled(daemons.splice(0).map((daemon) => daemon.stop()));
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  function createProxy(
    path: string,
    opts: Partial<ConstructorParameters<typeof CmuxLayerProxy>[0]> = {},
  ) {
    const input = new PassThrough();
    const output = new PassThrough();
    const collector = createCollector(output);
    const proxy = new CmuxLayerProxy({
      socketPath: path,
      input,
      output,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      reconnectJitterRatio: 0,
      requestTimeoutMs: 500,
      maxBufferedRequests: 8,
      ...opts,
    });
    proxies.push(proxy);
    proxy.start();
    return { input, output, collector, proxy };
  }

  it("forwards initialize and tools/list over the daemon socket", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("happy");
    const daemon = new FakeDaemon(path);
    daemons.push(daemon);
    await daemon.start();
    const { input, collector } = createProxy(path);

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(2, "tools/list"));

    await expect(
      collector.waitForMessage(isResponseFor(1)),
    ).resolves.toMatchObject({
      id: 1,
      result: { serverInfo: { name: "fake-daemon" } },
    });
    await expect(
      collector.waitForMessage(isResponseFor(2)),
    ).resolves.toMatchObject({
      id: 2,
      result: { tools: [expect.objectContaining({ name: "list_surfaces" })] },
    });
    await daemon.waitForMessage(
      0,
      (message) => "method" in message && message.method === "tools/list",
    );
  });

  it("replays initialize on daemon restart and completes buffered in-flight requests", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("restart");
    const firstDaemon = new FakeDaemon(path, {
      holdMethods: new Set(["tools/list"]),
    });
    daemons.push(firstDaemon);
    await firstDaemon.start();
    const { input, collector } = createProxy(path, { requestTimeoutMs: 1_000 });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(2, "tools/list"));
    await firstDaemon.waitForMessage(
      0,
      (message) => "method" in message && message.method === "tools/list",
    );
    await firstDaemon.stop();
    daemons.splice(daemons.indexOf(firstDaemon), 1);

    const secondDaemon = new FakeDaemon(path);
    daemons.push(secondDaemon);
    await secondDaemon.start();

    await expect(
      collector.waitForMessage(isResponseFor(2)),
    ).resolves.toMatchObject({
      id: 2,
      result: { tools: expect.any(Array) },
    });
    await waitFor(() => secondDaemon.connections[0]?.messages.length >= 3);
    expect(
      secondDaemon.connections[0].messages
        .filter((message) => "method" in message)
        .map((message) => message.method),
    ).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(
      collector.messages.filter(
        (message) => "id" in message && message.id === 1,
      ),
    ).toHaveLength(1);
  });

  it("rejects duplicate request ids without replacing the original pending request", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("duplicate-id");
    const daemon = new FakeDaemon(path, {
      holdMethods: new Set(["tools/list"]),
    });
    daemons.push(daemon);
    await daemon.start();
    const { input, collector } = createProxy(path, { requestTimeoutMs: 1_000 });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(2, "tools/list"));
    await daemon.waitForMessage(
      0,
      (message) => "method" in message && message.method === "tools/list",
    );

    writeFrame(input, request(2, "read_screen"));

    await expect(
      collector.waitForMessage(
        (message) =>
          isResponseFor(2)(message) &&
          "error" in message &&
          /duplicate/i.test(message.error.message),
      ),
    ).resolves.toMatchObject({
      id: 2,
      error: expect.objectContaining({
        code: -32001,
      }),
    });

    daemon.releaseHeld("tools/list");

    await expect(
      collector.waitForMessage(
        (message) =>
          isResponseFor(2)(message) &&
          "result" in message &&
          Array.isArray(message.result.tools),
      ),
    ).resolves.toMatchObject({
      id: 2,
      result: { tools: expect.any(Array) },
    });
  });

  it("replays initialize if the daemon restarts before initialized notification is cached", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("restart-before-initialized");
    const firstDaemon = new FakeDaemon(path);
    daemons.push(firstDaemon);
    await firstDaemon.start();
    const { input, collector } = createProxy(path, { requestTimeoutMs: 1_000 });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    await firstDaemon.stop();
    daemons.splice(daemons.indexOf(firstDaemon), 1);

    const secondDaemon = new FakeDaemon(path);
    daemons.push(secondDaemon);
    await secondDaemon.start();
    await secondDaemon.waitForMessage(
      0,
      (message) => "method" in message && message.method === "initialize",
    );
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(2, "tools/list"));

    await expect(
      collector.waitForMessage(isResponseFor(2)),
    ).resolves.toMatchObject({
      id: 2,
      result: { tools: expect.any(Array) },
    });
    expect(
      secondDaemon.connections[0].messages
        .filter((message) => "method" in message)
        .map((message) => message.method),
    ).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(
      collector.messages.filter(
        (message) => "id" in message && message.id === 1,
      ),
    ).toHaveLength(1);
  });

  it("does not flush queued RPCs when replayed initialize returns an error", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("replay-init-error");
    const firstDaemon = new FakeDaemon(path, {
      holdMethods: new Set(["tools/list"]),
    });
    daemons.push(firstDaemon);
    await firstDaemon.start();
    const { input, collector } = createProxy(path, {
      requestTimeoutMs: 500,
      initialBackoffMs: 5,
      maxBackoffMs: 10,
    });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(2, "tools/list"));
    await firstDaemon.waitForMessage(
      0,
      (message) => "method" in message && message.method === "tools/list",
    );
    await firstDaemon.stop();
    daemons.splice(daemons.indexOf(firstDaemon), 1);

    const secondDaemon = new FakeDaemon(path, {
      initializeError: true,
      closeAfterInitializeError: true,
    });
    daemons.push(secondDaemon);
    await secondDaemon.start();
    await secondDaemon.waitForMessage(
      0,
      (message) => "method" in message && message.method === "initialize",
    );
    await expect(
      collector.waitForMessage(isResponseFor(2), 500),
    ).resolves.toMatchObject({
      id: 2,
      error: expect.objectContaining({
        code: -32001,
        message: expect.stringMatching(/initialize replay/i),
      }),
    });

    expect(
      secondDaemon.connections.flatMap((connection) =>
        connection.messages
          .filter((message) => "method" in message)
          .map((message) => message.method),
      ),
    ).not.toContain("tools/list");
  });

  it("replays initialize before queued RPCs after the original initialize timed out", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("init-timeout-replay");
    const { input, collector } = createProxy(path, {
      requestTimeoutMs: 50,
      initialBackoffMs: 5,
      maxBackoffMs: 10,
    });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    writeFrame(input, notification("notifications/initialized"));

    // No daemon is listening, so the original initialize times out and the agent
    // gets a keyed error (it is not re-sent — see the outage-timeout test).
    await expect(
      collector.waitForMessage(isResponseFor(1), 500),
    ).resolves.toMatchObject({
      id: 1,
      error: expect.objectContaining({
        code: -32001,
      }),
    });

    const daemon = new FakeDaemon(path);
    daemons.push(daemon);
    await daemon.start();

    // The agent retries once the daemon is back. The proxy must replay the
    // cached initialize (and initialized) before forwarding this request, even
    // though the original initialize already "completed" with a timeout error.
    writeFrame(input, request(2, "tools/list"));

    await expect(
      collector.waitForMessage(isResponseFor(2), 1_000),
    ).resolves.toMatchObject({
      id: 2,
      result: { tools: expect.any(Array) },
    });
    expect(
      daemon.connections[0].messages
        .filter((message) => "method" in message)
        .map((message) => message.method),
    ).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("computes exponential reconnect backoff with jitter", () => {
    const delays = [0, 1, 2, 3].map((attempt) =>
      computeReconnectDelay(attempt, {
        initialBackoffMs: 100,
        maxBackoffMs: 800,
        jitterRatio: 0.5,
        random: () => 0.5,
      }),
    );

    expect(delays).toEqual([125, 250, 500, 800]);
    expect(
      delays.every((delay, index) => index === 0 || delay > delays[index - 1]),
    ).toBe(true);
  });

  it("returns a JSON-RPC error when buffered requests exceed the cap", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("cap");
    const daemon = new FakeDaemon(path);
    daemons.push(daemon);
    await daemon.start();
    const { input, collector } = createProxy(path, {
      maxBufferedRequests: 1,
      requestTimeoutMs: 1_000,
    });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    writeFrame(input, notification("notifications/initialized"));
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    writeFrame(input, request(2, "tools/list"));
    writeFrame(input, request(3, "tools/list"));

    await expect(
      collector.waitForMessage(isResponseFor(3)),
    ).resolves.toMatchObject({
      id: 3,
      error: expect.objectContaining({
        code: -32001,
        message: expect.stringMatching(/buffer/i),
      }),
    });
  });

  it("returns a keyed JSON-RPC error when an outage exceeds request timeout", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("timeout");
    const daemon = new FakeDaemon(path);
    daemons.push(daemon);
    await daemon.start();
    const { input, collector } = createProxy(path, { requestTimeoutMs: 30 });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    writeFrame(input, notification("notifications/initialized"));
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);

    writeFrame(input, request(2, "tools/list"));

    await expect(
      collector.waitForMessage(isResponseFor(2), 500),
    ).resolves.toMatchObject({
      id: 2,
      error: expect.objectContaining({
        code: -32001,
        message: expect.stringMatching(/offline|timeout|retry/i),
      }),
    });
  });

  it("keeps agent stdio open while the daemon is offline", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("stdio-open");
    const daemon = new FakeDaemon(path);
    daemons.push(daemon);
    await daemon.start();
    const { input, output, collector, proxy } = createProxy(path, {
      requestTimeoutMs: 200,
    });
    let outputEnded = false;
    output.on("end", () => {
      outputEnded = true;
    });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(outputEnded).toBe(false);
    expect(input.destroyed).toBe(false);
    expect(proxy.isRunning()).toBe(true);
  });
});
