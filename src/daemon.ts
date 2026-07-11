#!/usr/bin/env node

import net from "node:net";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createCmuxClient,
  type CreateCmuxClientOptions,
} from "./cmux-client-factory.js";
import { createServer, createServerContext } from "./server.js";
import { drainOutbox, httpDeliver } from "./outbox-drainer.js";
import {
  defaultMonitorRegistryPath,
  httpNotifyMonitorDeadman,
} from "./monitor-registry.js";
import type { ExecFn } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import type { CmuxClient } from "./cmux-client.js";
import type { CmuxServerContext, CreateServerOptions } from "./server.js";
import { defaultDaemonSocketPath } from "./daemon-socket-path.js";
import { ensureNodeMaxOldSpaceEnv, installHeapGuard } from "./heap-guard.js";
import { JsonRpcLineBuffer } from "./json-rpc-line-buffer.js";
import {
  callerContextFromMessage,
  runWithCallerContext,
} from "./caller-context.js";
import {
  detectStaleBuild,
  type DetectStaleBuildDeps,
  type StaleBuildResult,
} from "./version.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_CHECK_INTERVAL_MS = 30_000;
const LISTEN_FD_START = 3;

/**
 * TODO(phase3-hot-reload): After Gemini research, implement drain→swap→resume on
 * daemon version bump: pause accepts, drain in-flight MCP requests, hand off the
 * listen socket to a successor process (launchd activation prior art), and
 * resume proxy children without losing registry state.
 */
export interface DaemonHotReloadPlan {
  readonly kind: "drain-swap-resume";
  targetVersion: string;
}

export type DaemonHotReloadHandler = (
  plan: DaemonHotReloadPlan,
) => Promise<"not_implemented">;

type CmuxLayerClient = CmuxClient | CmuxSocketClient;
export type DaemonRetirementReason = "stale-build" | "irrecoverable-transport";
export type DaemonShutdownReason =
  | NodeJS.Signals
  | "manual"
  | DaemonRetirementReason;

export class SocketJsonRpcTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onRequestObserved?: (message: JSONRPCMessage) => void;
  onSend?: (message: JSONRPCMessage) => void;

  private readBuffer = new JsonRpcLineBuffer();
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
        settle(
          new Error("SocketJsonRpcTransport closed before write completed"),
        );
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
        runWithCallerContext(callerContextFromMessage(message), () => {
          this.onmessage?.(message);
        });
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

export interface CmuxLayerDaemonOptions extends Omit<
  CreateServerOptions,
  "context" | "client"
> {
  socketPath?: string;
  listenFd?: number;
  drainTimeoutMs?: number;
  context?: CmuxServerContext;
  client?: CmuxLayerClient;
  createClient?: (
    opts: Pick<CreateCmuxClientOptions, "onIrrecoverableTransport">,
  ) => Promise<CmuxLayerClient>;
  detectStaleBuild?: (
    deps?: DetectStaleBuildDeps,
  ) => StaleBuildResult | null;
  staleCheckIntervalMs?: number;
  logger?: Pick<Console, "error">;
  onRetire?: (
    reason: DaemonRetirementReason,
    result: DaemonShutdownResult,
  ) => Promise<void> | void;
  serverFactory?: (
    connectionListener: (socket: net.Socket) => void,
  ) => net.Server;
}

export interface DaemonShutdownResult {
  forced: boolean;
  activeConnections: number;
  inFlightRequests: number;
}

export function daemonExitCode(
  reason: DaemonShutdownReason,
  result: DaemonShutdownResult,
): number {
  if (reason === "stale-build" || reason === "irrecoverable-transport") {
    return 0;
  }
  return result.forced ? 1 : 0;
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

function positiveEnvMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
  private staleCheckTimer: NodeJS.Timeout | null = null;
  private retirementPromise: Promise<void> | null = null;
  private readonly detectStaleBuildFn: (
    deps?: DetectStaleBuildDeps,
  ) => StaleBuildResult | null;
  private readonly staleCheckIntervalMs: number;
  private readonly logger: Pick<Console, "error">;
  private ownedSocketIdentity: { dev: number; ino: number } | null = null;

  constructor(private readonly opts: CmuxLayerDaemonOptions = {}) {
    this.context = opts.context ?? null;
    this.socketPath = opts.socketPath ?? defaultDaemonSocketPath(process.env);
    this.listenFd = opts.listenFd ?? parseListenFd(process.env);
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.detectStaleBuildFn = opts.detectStaleBuild ?? detectStaleBuild;
    this.staleCheckIntervalMs =
      opts.staleCheckIntervalMs ??
      positiveEnvMs(process.env.CMUXLAYER_STALE_CHECK_INTERVAL_MS) ??
      DEFAULT_STALE_CHECK_INTERVAL_MS;
    this.logger = opts.logger ?? console;
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
    } else {
      await this.listen(this.socketPath);
      const stats = await lstat(this.socketPath);
      this.ownedSocketIdentity = { dev: stats.dev, ino: stats.ino };
    }
    this.startStaleBuildWatcher();
  }

  async shutdown(
    signal: DaemonShutdownReason = "manual",
  ): Promise<DaemonShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.clearStaleBuildWatcher();
    this.shutdownPromise = this.doShutdown(signal);
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
            ? await this.opts.createClient({
                onIrrecoverableTransport: () =>
                  this.requestRetirement("irrecoverable-transport"),
              })
            : this.opts.exec || this.opts.bin
              ? undefined
              : await createCmuxClient({
                  onIrrecoverableTransport: () =>
                    this.requestRetirement("irrecoverable-transport"),
                }));
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

  private async doShutdown(
    reason: DaemonShutdownReason,
  ): Promise<DaemonShutdownResult> {
    this.draining = true;
    this.pauseActiveTransports();
    const listenerClosed = this.closeListener();

    const retiring =
      reason === "stale-build" || reason === "irrecoverable-transport";
    if (retiring) {
      const forced = this.inFlightRequests > 0;
      for (const transport of [...this.activeTransports]) {
        transport.destroy();
      }
      for (const server of [...this.activeServers]) {
        await server.close().catch(() => {});
      }
      await listenerClosed;
      this.context?.dispose();
      return {
        forced,
        activeConnections: this.activeTransports.size,
        inFlightRequests: this.inFlightRequests,
      };
    }

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

  private startStaleBuildWatcher(): void {
    this.staleCheckTimer = setInterval(() => {
      const stale = this.detectStaleBuildFn();
      if (stale?.stale) {
        this.requestRetirement("stale-build", stale);
      }
    }, this.staleCheckIntervalMs);
    this.staleCheckTimer.unref?.();
  }

  private clearStaleBuildWatcher(): void {
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }
  }

  private requestRetirement(
    reason: DaemonRetirementReason,
    stale?: StaleBuildResult,
  ): void {
    if (this.retirementPromise) {
      return;
    }
    if (reason === "stale-build" && stale) {
      this.logger.error(
        `[cmuxlayer-daemon] installed version bump detected (running v${stale.running}, installed v${stale.installed}); retiring`,
      );
    } else {
      this.logger.error(
        "[cmuxlayer-daemon] transport irrecoverably denied (orphaned ancestry); retiring so a pane-descended respawn can reconnect",
      );
    }
    this.retirementPromise = this.shutdown(reason)
      .then(async (result) => {
        await this.opts.onRetire?.(reason, result);
      })
      .catch((error) => {
        this.logger.error("[cmuxlayer-daemon] retirement failed", error);
      });
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

  private async closeListener(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    const detachedSocket = await this.detachOwnedSocketPath();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (detachedSocket?.restore) {
      await rename(detachedSocket.path, this.socketPath);
    } else if (detachedSocket) {
      await unlink(detachedSocket.path).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        },
      );
    }
  }

  private async detachOwnedSocketPath(): Promise<{
    path: string;
    restore: boolean;
  } | null> {
    if (this.listenFd !== undefined || !this.ownedSocketIdentity) {
      return null;
    }

    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeFile(this.socketPath, "", { flag: "wx" });
        return null;
      }
      throw error;
    }

    if (
      current.dev !== this.ownedSocketIdentity.dev ||
      current.ino !== this.ownedSocketIdentity.ino
    ) {
      const shelteredPath = `${this.socketPath}.foreign-${process.pid}-${Date.now()}`;
      await rename(this.socketPath, shelteredPath);
      await writeFile(this.socketPath, "", { flag: "wx" });
      return { path: shelteredPath, restore: true };
    }

    const detachedPath = `${this.socketPath}.closing-${process.pid}-${Date.now()}`;
    await rename(this.socketPath, detachedPath);
    await writeFile(this.socketPath, "", { flag: "wx" });
    return { path: detachedPath, restore: false };
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
  let exitStarted = false;
  const exitAfterShutdown = (
    reason: DaemonShutdownReason,
    result: DaemonShutdownResult,
  ) => {
    if (exitStarted) return;
    exitStarted = true;
    process.exit(daemonExitCode(reason, result));
  };
  const daemon = new CmuxLayerDaemon({
    ...opts,
    onRetire: async (reason, result) => {
      await opts.onRetire?.(reason, result);
      exitAfterShutdown(reason, result);
    },
  });
  const shutdownThenExit = (signal: NodeJS.Signals) => {
    daemon
      .shutdown(signal)
      .then((result) => exitAfterShutdown(signal, result))
      .catch((error) => {
        console.error("[cmuxlayer-daemon] shutdown failed", error);
        process.exit(1);
      });
  };

  process.once("SIGTERM", shutdownThenExit);
  process.once("SIGINT", shutdownThenExit);
  await daemon.start();
  return daemon;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runDaemon().catch((error) => {
    console.error("[cmuxlayer-daemon] fatal", error);
    process.exit(1);
  });
}
