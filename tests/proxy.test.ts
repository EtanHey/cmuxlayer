import net from "node:net";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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
import {
  CmuxLayerProxy,
  computeReconnectDelay,
  VersionBumpReconnectGuard,
} from "../src/proxy.js";

const TEST_ROOT = join("/tmp", "cmuxlayer-proxy-test");

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

async function leaveRefusedUnixSocket(path: string): Promise<void> {
  rmSync(path, { force: true });
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require("node:net").createServer(() => {}).listen(${JSON.stringify(path)})`,
    ],
    { stdio: "ignore" },
  );
  try {
    await waitFor(() => existsSync(path));
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  child.kill("SIGKILL");
  await once(child, "exit");
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

function createRawLineCollector(stream: NodeJS.ReadableStream) {
  const lines: string[] = [];
  const events = new EventEmitter();
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex + 1);
      buffer = buffer.slice(newlineIndex + 1);
      lines.push(line);
      events.emit("line", line);
    }
  });

  const waitForLine = (
    predicate: (line: string) => boolean,
    timeoutMs = 1_000,
  ): Promise<string> => {
    const existing = lines.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        events.off("line", onLine);
        reject(new Error("timed out waiting for raw line"));
      }, timeoutMs);
      const onLine = (line: string) => {
        if (!predicate(line)) {
          return;
        }
        clearTimeout(timeout);
        events.off("line", onLine);
        resolve(line);
      };
      events.on("line", onLine);
    });
  };

  return { lines, waitForLine };
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

function callerContextMeta(message: JSONRPCMessage): unknown {
  if (
    typeof message !== "object" ||
    message === null ||
    !("params" in message) ||
    typeof message.params !== "object" ||
    message.params === null
  ) {
    return undefined;
  }
  const params = message.params as { _meta?: Record<string, unknown> };
  return params._meta?.["cmuxlayer/callerContext"];
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

  async stop(opts: { leaveStaleSocket?: boolean } = {}): Promise<void> {
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
    if (opts.leaveStaleSocket) {
      await leaveRefusedUnixSocket(this.path);
    } else {
      rmSync(this.path, { force: true });
    }
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
      logger: { error: vi.fn() },
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

  it("attaches caller cmux env to each forwarded tool call", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const previousWorkspaceId = process.env.CMUX_WORKSPACE_ID;
    const previousTabId = process.env.CMUX_TAB_ID;
    const previousSurfaceId = process.env.CMUX_SURFACE_ID;
    process.env.CMUX_WORKSPACE_ID = "workspace-x-uuid";
    process.env.CMUX_TAB_ID = "tab-x";
    process.env.CMUX_SURFACE_ID = "surface-x";

    try {
      const path = socketPath("caller-context");
      const daemon = new FakeDaemon(path);
      daemons.push(daemon);
      await daemon.start();
      const { input, collector } = createProxy(path);

      writeFrame(input, request(1, "initialize", { capabilities: {} }));
      await collector.waitForMessage(isResponseFor(1));
      writeFrame(input, notification("notifications/initialized"));
      writeFrame(
        input,
        request(2, "tools/call", {
          name: "spawn_agent",
          arguments: { repo: "brainlayer", cli: "codex" },
        }),
      );

      await collector.waitForMessage(isResponseFor(2));
      const forwarded = await daemon.waitForMessage(
        0,
        (message) => "method" in message && message.method === "tools/call",
      );
      expect(callerContextMeta(forwarded)).toEqual({
        workspaceId: "workspace-x-uuid",
        tabId: "tab-x",
        surfaceId: "surface-x",
      });
    } finally {
      if (previousWorkspaceId === undefined) {
        delete process.env.CMUX_WORKSPACE_ID;
      } else {
        process.env.CMUX_WORKSPACE_ID = previousWorkspaceId;
      }
      if (previousTabId === undefined) {
        delete process.env.CMUX_TAB_ID;
      } else {
        process.env.CMUX_TAB_ID = previousTabId;
      }
      if (previousSurfaceId === undefined) {
        delete process.env.CMUX_SURFACE_ID;
      } else {
        process.env.CMUX_SURFACE_ID = previousSurfaceId;
      }
    }
  });

  it("relays large daemon responses without parsing and reserializing the frame", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("large-raw-relay");
    const largeText = "read-screen-payload-".repeat(16_384);
    const rawReadScreenResponse = ` { "result" : { "content" : [ { "type" : "text" , "text" : ${JSON.stringify(
      largeText,
    )} } ] , "structuredContent" : { "ok" : true , "text" : ${JSON.stringify(
      largeText,
    )} } } , "id" : 2 , "jsonrpc" : "2.0" }\n`;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      const readBuffer = new ReadBuffer();
      socket.on("data", (chunk) => {
        readBuffer.append(chunk);
        while (true) {
          const message = readBuffer.readMessage();
          if (message === null) {
            break;
          }
          if (
            typeof message === "object" &&
            message !== null &&
            "id" in message &&
            "method" in message &&
            message.method === "initialize"
          ) {
            writeFrame(socket, {
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                serverInfo: { name: "fake-daemon", version: "0.1.0" },
              },
            });
          } else if (
            typeof message === "object" &&
            message !== null &&
            "id" in message
          ) {
            socket.write(rawReadScreenResponse);
          }
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
    const { input, output, collector } = createProxy(path);
    const rawOutput = createRawLineCollector(output);

    try {
      writeFrame(input, request(1, "initialize", { capabilities: {} }));
      await collector.waitForMessage(isResponseFor(1));
      writeFrame(input, notification("notifications/initialized"));
      writeFrame(input, request(2, "tools/call", { name: "read_screen" }));

      await expect(
        rawOutput.waitForLine((line) => line.includes('"id" : 2')),
      ).resolves.toBe(rawReadScreenResponse);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(path, { force: true });
    }
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

  it("spawns the installed daemon after the second refused reconnect attempt", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("reconnect-spawn");
    const logger = { error: vi.fn() };
    const spawnDaemonForVersionBump = vi.fn().mockResolvedValue({ pid: 4242 });
    const attempts: number[] = [];
    const { proxy } = createProxy(path, {
      initialBackoffMs: 10,
      maxBackoffMs: 10,
      installedDaemonScriptPath: () => "/opt/cmuxlayer/dist/daemon.js",
      logger,
      onReconnectDelay: (_delayMs, attempt) => attempts.push(attempt),
      reconnectLogIntervalMs: 0,
      spawnDaemonForVersionBump,
    });

    await waitFor(() => spawnDaemonForVersionBump.mock.calls.length === 1);
    await proxy.stop();

    expect(attempts.slice(0, 2)).toEqual([0, 1]);
    expect(spawnDaemonForVersionBump).toHaveBeenCalledTimes(1);
    expect(spawnDaemonForVersionBump).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonScriptPath: "/opt/cmuxlayer/dist/daemon.js",
        socketPath: path,
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/reconnect attempt 0 failed \(ENOENT\)/),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer-proxy] daemon spawn skipped (reason=gate, attempt=0)",
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer-proxy] daemon spawn fired (script=/opt/cmuxlayer/dist/daemon.js, pid=4242)",
    );
  });

  it("caps reconnect-driven daemon spawns within the guard window", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("reconnect-spawn-guard");
    const spawnDaemonForVersionBump = vi.fn().mockResolvedValue(undefined);
    const attempts: number[] = [];
    createProxy(path, {
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      installedDaemonScriptPath: () => "/opt/cmuxlayer/dist/daemon.js",
      onReconnectDelay: (_delayMs, attempt) => attempts.push(attempt),
      reconnectDaemonSpawnGuard: new VersionBumpReconnectGuard({
        maxAttempts: 2,
        windowMs: 60_000,
      }),
      spawnDaemonForVersionBump,
    });

    await waitFor(() => attempts.length >= 6);

    expect(spawnDaemonForVersionBump).toHaveBeenCalledTimes(2);
  });

  it("replays queued requests after reconnect autostart brings up the daemon", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("reconnect-spawn-replay");
    const daemon = new FakeDaemon(path);
    daemons.push(daemon);
    const spawnDaemonForVersionBump = vi.fn(async () => daemon.start());
    const { input, collector } = createProxy(path, {
      initialBackoffMs: 5,
      maxBackoffMs: 10,
      installedDaemonScriptPath: () => "/opt/cmuxlayer/dist/daemon.js",
      requestTimeoutMs: 1_000,
      spawnDaemonForVersionBump,
    });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(2, "tools/list"));

    await expect(
      collector.waitForMessage(isResponseFor(2), 1_000),
    ).resolves.toMatchObject({
      id: 2,
      result: { tools: expect.any(Array) },
    });
    expect(spawnDaemonForVersionBump).toHaveBeenCalledTimes(1);
    expect(
      daemon.connections[0].messages
        .filter((message) => "method" in message)
        .map((message) => message.method),
    ).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("autostarts within two reconnect attempts after a connected daemon leaves a stale socket", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("connected-stale-restart");
    const firstDaemon = new FakeDaemon(path, {
      holdMethods: new Set(["tools/list"]),
    });
    daemons.push(firstDaemon);
    await firstDaemon.start();

    const secondDaemon = new FakeDaemon(path);
    daemons.push(secondDaemon);
    const reconnectAttempts: number[] = [];
    const logger = { error: vi.fn() };
    const spawnDaemonForVersionBump = vi.fn(async () => secondDaemon.start());
    const { input, collector } = createProxy(path, {
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      reconnectJitterRatio: 0,
      installedDaemonScriptPath: () => "/opt/cmuxlayer/dist/daemon.js",
      logger,
      requestTimeoutMs: 1_000,
      onReconnectDelay: (_delayMs, attempt) =>
        reconnectAttempts.push(attempt),
      spawnDaemonForVersionBump,
    });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(2, "tools/list"));
    await firstDaemon.waitForMessage(
      0,
      (message) => "method" in message && message.method === "tools/list",
    );

    await firstDaemon.stop({ leaveStaleSocket: true });
    daemons.splice(daemons.indexOf(firstDaemon), 1);

    await expect(
      collector.waitForMessage(isResponseFor(2), 1_000),
    ).resolves.toMatchObject({
      id: 2,
      result: { tools: expect.any(Array) },
    });
    expect(spawnDaemonForVersionBump).toHaveBeenCalledTimes(1);
    expect(reconnectAttempts.slice(0, 2)).toEqual([0, 1]);
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer-proxy] daemon drop detected; reconnecting",
    );
    expect(
      secondDaemon.connections[0].messages
        .filter((message) => "method" in message)
        .map((message) => message.method),
    ).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("does not resolve or spawn a daemon during reconnect when no callback is set", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("reconnect-no-spawn");
    const attempts: number[] = [];
    const installedDaemonScriptPath = vi.fn(() => {
      throw new Error("should not resolve without a spawn callback");
    });
    const { proxy } = createProxy(path, {
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      installedDaemonScriptPath,
      onReconnectDelay: (_delayMs, attempt) => attempts.push(attempt),
    });

    await waitFor(() => attempts.length >= 3);

    expect(installedDaemonScriptPath).not.toHaveBeenCalled();
    expect(proxy.isRunning()).toBe(true);
  });

  it("logs no-script and guard reasons when reconnect autostart is skipped", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const noScriptPath = socketPath("reconnect-no-script");
    const noScriptLogger = { error: vi.fn() };
    const spawnDaemon = vi.fn();
    const noScript = createProxy(noScriptPath, {
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      installedDaemonScriptPath: () => null,
      logger: noScriptLogger,
      reconnectLogIntervalMs: 0,
      spawnDaemonForVersionBump: spawnDaemon,
    });
    await waitFor(() =>
      noScriptLogger.error.mock.calls.some(([message]) =>
        String(message).includes("reason=no-script"),
      ),
    );
    await noScript.proxy.stop();

    const guardPath = socketPath("reconnect-blocked-guard");
    const guardLogger = { error: vi.fn() };
    const guard = createProxy(guardPath, {
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      installedDaemonScriptPath: () => "/opt/cmuxlayer/dist/daemon.js",
      logger: guardLogger,
      reconnectDaemonSpawnGuard: new VersionBumpReconnectGuard({
        maxAttempts: 0,
      }),
      reconnectLogIntervalMs: 0,
      spawnDaemonForVersionBump: spawnDaemon,
    });
    await waitFor(() =>
      guardLogger.error.mock.calls.some(([message]) =>
        String(message).includes("reason=guard"),
      ),
    );
    await guard.proxy.stop();

    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it("fails buffered requests within the outage bound and accepts new work after recovery", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("bounded-outage");
    const { input, collector } = createProxy(path, {
      bufferedRequestTimeoutMs: 30,
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      requestTimeoutMs: 1_000,
    });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await expect(
      collector.waitForMessage(isResponseFor(1), 300),
    ).resolves.toMatchObject({
      id: 1,
      error: expect.objectContaining({
        code: -32001,
        message: expect.stringMatching(/daemon unavailable.*reconnect/i),
      }),
    });

    const daemon = new FakeDaemon(path);
    daemons.push(daemon);
    await daemon.start();
    writeFrame(input, request(2, "initialize", { capabilities: {} }));
    await expect(
      collector.waitForMessage(isResponseFor(2), 1_000),
    ).resolves.toMatchObject({ id: 2, result: expect.any(Object) });
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(3, "tools/list"));
    await expect(
      collector.waitForMessage(isResponseFor(3), 1_000),
    ).resolves.toMatchObject({
      id: 3,
      result: { tools: expect.any(Array) },
    });
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

  it("keeps expired request ids quarantined after repeated late responses", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("late-expired-response");
    const daemon = new FakeDaemon(path, {
      holdMethods: new Set(["tools/list"]),
    });
    daemons.push(daemon);
    await daemon.start();
    const logger = { error: vi.fn() };
    const { input, collector, proxy } = createProxy(path, {
      logger,
      requestTimeoutMs: 30,
    });

    writeFrame(input, request(1, "initialize", { capabilities: {} }));
    await collector.waitForMessage(isResponseFor(1));
    writeFrame(input, notification("notifications/initialized"));
    writeFrame(input, request(2, "tools/list"));
    await daemon.waitForMessage(
      0,
      (message) => "method" in message && message.method === "tools/list",
    );

    await expect(
      collector.waitForMessage(isResponseFor(2), 500),
    ).resolves.toMatchObject({
      id: 2,
      error: expect.objectContaining({
        code: -32001,
        message: expect.stringMatching(/offline|timeout|retry/i),
      }),
    });

    daemon.releaseHeld("tools/list");

    await waitFor(() =>
      logger.error.mock.calls.some((call) =>
        String(call[0]).includes("late daemon response"),
      ),
    );
    writeFrame(daemon.connections[0].socket, {
      jsonrpc: "2.0",
      id: 2,
      result: { stale: true },
    });
    await waitFor(
      () =>
        logger.error.mock.calls.filter((call) =>
          String(call[0]).includes("late daemon response"),
        ).length >= 2,
    );
    await expect(
      collector.waitForMessage(
        (message) => isResponseFor(2)(message) && "result" in message,
        100,
      ),
    ).rejects.toThrow(/timed out/);
    expect(
      (
        proxy as unknown as {
          expiredRequestKeys: Set<string>;
        }
      ).expiredRequestKeys.has("number:2"),
    ).toBe(true);
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

  it("logs daemon socket errors while leaving close-driven reconnect semantics intact", async () => {
    const logger = { error: vi.fn() };
    const fakeSocket = new PassThrough() as unknown as net.Socket;
    const { proxy } = createProxy("unused-fake-socket", {
      connect: () => {
        queueMicrotask(() => fakeSocket.emit("connect"));
        return fakeSocket;
      },
      logger,
    });

    await waitFor(() => fakeSocket.listenerCount("data") > 0);

    const error = new Error("daemon link failed");
    fakeSocket.emit("error", error);

    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer-proxy] daemon socket error",
      error,
    );
    expect(proxy.isRunning()).toBe(true);
  });
});
