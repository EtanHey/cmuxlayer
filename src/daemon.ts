#!/usr/bin/env node

import net from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCmuxClient } from "./cmux-client-factory.js";
import { createServer, createServerContext } from "./server.js";
import { drainOutbox, httpDeliver } from "./outbox-drainer.js";
import {
  defaultMonitorRegistryPath,
  httpNotifyMonitorDeadman,
} from "./monitor-registry.js";
import type { ExecFn } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import type { CmuxClient } from "./cmux-client.js";
import type {
  CmuxServerContext,
  CreateServerOptions,
} from "./server.js";
import { defaultDaemonSocketPath } from "./daemon-socket-path.js";
import { ensureNodeMaxOldSpaceEnv, installHeapGuard } from "./heap-guard.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const LISTEN_FD_START = 3;

type CmuxLayerClient = CmuxClient | CmuxSocketClient;

export class SocketJsonRpcTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onRequestObserved?: (message: JSONRPCMessage) => void;
  onSend?: (message: JSONRPCMessage) => void;

  private readBuffer = new ReadBuffer();
  private started = false;
  private closed = false;

  private readonly onData = (chunk: Buffer) => {
    this.readBuffer.append(chunk);
    this.processReadBuffer();
  };

  private readonly onError = (error: Error) => {
    this.onerror?.(error);
  };

  private readonly onClose = () => {
    this.finishClose();
  };

  constructor(private readonly socket: net.Socket) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("SocketJsonRpcTransport already started");
    }
    if (this.closed) {
      throw new Error("SocketJsonRpcTransport is closed");
    }
    this.started = true;
    this.socket.on("data", this.onData);
    this.socket.on("error", this.onError);
    this.socket.on("close", this.onClose);
    this.socket.resume();
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("SocketJsonRpcTransport is closed");
    }
    const payload = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: Error) => {
        settle(error);
      };
      const onClose = () => {
        settle(new Error("SocketJsonRpcTransport closed before write completed"));
      };
      const cleanup = () => {
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      const settle = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      try {
        this.socket.write(payload, settle);
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.onSend?.(message);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.finishClose();
    if (!this.socket.destroyed) {
      this.socket.resume();
      this.socket.end();
    }
  }

  pauseInput(): void {
    if (!this.closed) {
      this.socket.pause();
    }
  }

  destroy(): void {
    this.finishClose();
    if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          break;
        }
        if (isJsonRpcRequest(message)) {
          this.onRequestObserved?.(message);
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private finishClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.readBuffer.clear();
    this.onclose?.();
  }
}

export interface CmuxLayerDaemonOptions
  extends Omit<CreateServerOptions, "context" | "client"> {
  socketPath?: string;
  listenFd?: number;
  drainTimeoutMs?: number;
  context?: CmuxServerContext;
  client?: CmuxLayerClient;
  createClient?: () => Promise<CmuxLayerClient>;
  serverFactory?: (
    connectionListener: (socket: net.Socket) => void,
  ) => net.Server;
}

export interface DaemonShutdownResult {
  forced: boolean;
  activeConnections: number;
  inFlightRequests: number;
}

function parseListenFd(env: NodeJS.ProcessEnv): number | undefined {
  const explicit = env.CMUXLAYER_DAEMON_FD;
  if (explicit) {
    const fd = Number(explicit);
    if (!Number.isInteger(fd) || fd < 0) {
      throw new Error(`Invalid CMUXLAYER_DAEMON_FD: ${explicit}`);
    }
    return fd;
  }

  const listenFds = Number(env.LISTEN_FDS ?? 0);
  if (Number.isInteger(listenFds) && listenFds > 0) {
    return LISTEN_FD_START;
  }

  return undefined;
}

function isJsonRpcRequest(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: RequestId; method: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    "method" in message &&
    typeof message.method === "string"
  );
}

function isJsonRpcResponse(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: RequestId } {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    ("result" in message || "error" in message)
  );
}

async function unlinkStaleSocket(path: string): Promise<void> {
  const status = await probeSocket(path);
  if (status === "live") {
    throw new Error(`cmuxlayer daemon socket is already in use: ${path}`);
  }
  if (status === "missing") {
    return;
  }

  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

function probeSocket(path: string): Promise<"live" | "missing" | "stale"> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let settled = false;
    const ignoreLateError = () => {};
    const settle = (value: "live" | "missing" | "stale") => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.on("error", ignoreLateError);
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(250, () => settle("live"));
    socket.once("connect", () => settle("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        settle("missing");
        return;
      }
      if (error.code === "ECONNREFUSED") {
        settle("stale");
        return;
      }
      reject(error);
    });
  });
}

export class CmuxLayerDaemon {
  private server: net.Server | null = null;
  private context: CmuxServerContext | null;
  private contextPromise: Promise<CmuxServerContext> | null = null;
  private readonly socketPath: string;
  private readonly listenFd?: number;
  private readonly drainTimeoutMs: number;
  private readonly activeTransports = new Set<SocketJsonRpcTransport>();
  private readonly activeServers = new Set<McpServer>();
  private readonly drainWaiters = new Set<() => void>();
  private inFlightRequests = 0;
  private draining = false;
  private shutdownPromise: Promise<DaemonShutdownResult> | null = null;

  constructor(private readonly opts: CmuxLayerDaemonOptions = {}) {
    this.context = opts.context ?? null;
    this.socketPath =
      opts.socketPath ?? defaultDaemonSocketPath(process.env);
    this.listenFd = opts.listenFd ?? parseListenFd(process.env);
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("cmuxlayer daemon already started");
    }

    if (this.listenFd === undefined) {
      await mkdir(dirname(this.socketPath), { recursive: true });
      await unlinkStaleSocket(this.socketPath);
    }

    await this.getContext();

    this.server = (this.opts.serverFactory ?? net.createServer)(
      (socket) => void this.acceptConnection(socket),
    );
    this.server.on("error", (error) => {
      if (!this.draining) {
        console.error("[cmuxlayer-daemon] server error", error);
      }
    });

    if (this.listenFd !== undefined) {
      await this.listen({ fd: this.listenFd });
      return;
    }

    await this.listen(this.socketPath);
  }

  async shutdown(
    _signal: NodeJS.Signals | "manual" = "manual",
  ): Promise<DaemonShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  activeConnectionCount(): number {
    return this.activeTransports.size;
  }

  inFlightRequestCount(): number {
    return this.inFlightRequests;
  }

  private async getContext(): Promise<CmuxServerContext> {
    if (this.context) {
      return this.context;
    }
    if (!this.contextPromise) {
      this.contextPromise = (async () => {
        const client =
          this.opts.client ??
          (this.opts.createClient
            ? await this.opts.createClient()
            : this.opts.exec || this.opts.bin
              ? undefined
              : await createCmuxClient());
        this.context = createServerContext({
          exec: this.opts.exec,
          bin: this.opts.bin,
          client,
          stateDir: this.opts.stateDir,
          skipAgentLifecycle: this.opts.skipAgentLifecycle,
          enableClaudeChannels: this.opts.enableClaudeChannels,
          spawnPreflight: this.opts.spawnPreflight,
          disableSpawnPreflight: this.opts.disableSpawnPreflight,
        });
        return this.context;
      })();
    }
    return this.contextPromise;
  }

  private async acceptConnection(socket: net.Socket): Promise<void> {
    if (this.draining) {
      socket.destroy();
      return;
    }
    socket.pause();

    let context: CmuxServerContext;
    try {
      context = await this.getContext();
    } catch (error) {
      socket.destroy(error instanceof Error ? error : undefined);
      return;
    }

    const transport = new SocketJsonRpcTransport(socket);
    const mcpServer = createServer({
      context,
      outboxDrain: () => drainOutbox({ deliver: httpDeliver }),
      monitorRegistryPath: defaultMonitorRegistryPath(),
      monitorRegistryNotify: httpNotifyMonitorDeadman,
    });
    const pendingRequestIds = new Set<RequestId>();
    this.activeTransports.add(transport);
    this.activeServers.add(mcpServer);

    transport.onRequestObserved = (message) => {
      if (!isJsonRpcRequest(message)) {
        return;
      }
      pendingRequestIds.add(message.id);
      this.inFlightRequests += 1;
    };
    transport.onSend = (message) => {
      if (!isJsonRpcResponse(message)) {
        return;
      }
      if (pendingRequestIds.delete(message.id)) {
        this.inFlightRequests -= 1;
        this.resolveDrainWaiters();
      }
    };
    transport.onclose = () => {
      if (pendingRequestIds.size > 0) {
        this.inFlightRequests -= pendingRequestIds.size;
        pendingRequestIds.clear();
      }
      this.activeTransports.delete(transport);
      this.activeServers.delete(mcpServer);
      this.resolveDrainWaiters();
      void mcpServer.close().catch((error) => {
        if (!this.draining) {
          console.error("[cmuxlayer-daemon] MCP server close failed", error);
        }
      });
    };
    transport.onerror = (error) => {
      if (!this.draining) {
        console.error("[cmuxlayer-daemon] transport error", error);
      }
    };

    try {
      await mcpServer.connect(transport);
    } catch (error) {
      transport.onerror?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      transport.destroy();
    }
  }

  private async doShutdown(): Promise<DaemonShutdownResult> {
    this.draining = true;
    this.pauseActiveTransports();
    const listenerClosed = this.closeListener();

    const forced = !(await this.waitForDrain());
    for (const server of [...this.activeServers]) {
      await server.close().catch(() => {});
    }
    for (const transport of [...this.activeTransports]) {
      if (forced) {
        transport.destroy();
      } else {
        await transport.close().catch(() => {});
      }
    }
    await listenerClosed;
    this.context?.dispose();

    return {
      forced,
      activeConnections: this.activeTransports.size,
      inFlightRequests: this.inFlightRequests,
    };
  }

  private pauseActiveTransports(): void {
    for (const transport of this.activeTransports) {
      transport.pauseInput();
    }
  }

  private listen(options: string | { fd: number }): Promise<void> {
    const server = this.server;
    if (!server) {
      throw new Error("daemon server was not created");
    }
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      if (typeof options === "string") {
        server.listen(options, onListening);
      } else {
        server.listen(options, onListening);
      }
    });
  }

  private closeListener(): Promise<void> {
    const server = this.server;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  private waitForDrain(): Promise<boolean> {
    if (this.inFlightRequests === 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.drainWaiters.delete(onDrained);
        resolve(false);
      }, this.drainTimeoutMs);

      const onDrained = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      this.drainWaiters.add(onDrained);
    });
  }

  private resolveDrainWaiters(): void {
    if (this.inFlightRequests !== 0) {
      return;
    }
    for (const waiter of this.drainWaiters) {
      waiter();
    }
    this.drainWaiters.clear();
  }
}

export async function runDaemon(
  opts: CmuxLayerDaemonOptions = {},
): Promise<CmuxLayerDaemon> {
  ensureNodeMaxOldSpaceEnv();
  installHeapGuard();
  const daemon = new CmuxLayerDaemon(opts);
  const shutdown = (signal: NodeJS.Signals) => {
    daemon
      .shutdown(signal)
      .then((result) => {
        process.exit(result.forced ? 1 : 0);
      })
      .catch((error) => {
        console.error("[cmuxlayer-daemon] shutdown failed", error);
        process.exit(1);
      });
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await daemon.start();
  return daemon;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runDaemon().catch((error) => {
    console.error("[cmuxlayer-daemon] fatal", error);
    process.exit(1);
  });
}
