#!/usr/bin/env node

import net from "node:net";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  reconcileMonitorRegistry,
} from "./monitor-registry.js";
import {
  ackedIds,
  dispatchOnce,
  inboxPath,
  monitorAlive,
  readLastAgentHeartbeat,
  type InboxOpts,
} from "./inbox.js";
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
import { isMainModule } from "./is-main.js";

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_CHECK_INTERVAL_MS = 30_000;
const DEFAULT_MONITOR_RECONCILE_INTERVAL_MS = 15_000;
const DEFAULT_NOTIFY_URL = "http://127.0.0.1:3847/notify";
const MONITOR_REARM_INBOX_HEARTBEAT_MAX_AGE_MS = 60_000;
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

export interface MonitorOwnerCollapseNotification {
  title: string;
  body: string;
  source: string;
  priority: "high";
  dedupe_key: string;
}

export type MonitorOwnerPtyDeadNotification = MonitorOwnerCollapseNotification;

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
  monitorReconcile?: (options?: {
    rearmClaimTimeoutMs?: number;
    monitorIds?: readonly string[];
  }) => Promise<unknown> | unknown;
  monitorReconcileIntervalMs?: number;
  monitorOwnerPtyDeadNotify?: (
    notification: MonitorOwnerPtyDeadNotification,
  ) => Promise<unknown> | unknown;
  monitorOwnerWedgedNotify?: (
    notification: MonitorOwnerCollapseNotification,
  ) => Promise<unknown> | unknown;
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
  private monitorReconcileTimer: NodeJS.Timeout | null = null;
  private monitorReconcileInFlight = false;
  private monitorRelayReadyPending = false;
  private readonly monitorReconcileFailedIds = new Set<string>();
  private monitorReconcileFn:
    | ((options?: {
        rearmClaimTimeoutMs?: number;
        monitorIds?: readonly string[];
      }) =>
        | Promise<unknown>
        | unknown)
    | null;
  private readonly monitorRelayReadyListener = () => {
    void this.retryFailedMonitorRearmsWhenRelayReady();
  };
  private retirementPromise: Promise<void> | null = null;
  private readonly detectStaleBuildFn: (
    deps?: DetectStaleBuildDeps,
  ) => StaleBuildResult | null;
  private readonly staleCheckIntervalMs: number;
  private readonly monitorReconcileIntervalMs: number;
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
    this.monitorReconcileIntervalMs =
      opts.monitorReconcileIntervalMs ?? DEFAULT_MONITOR_RECONCILE_INTERVAL_MS;
    this.monitorReconcileFn = opts.monitorReconcile ?? null;
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

    const context = await this.getContext();
    if (!this.monitorReconcileFn && this.opts.monitorRegistryPath) {
      this.monitorReconcileFn = this.createDefaultMonitorReconciler(context);
    }
    context.lifecycleAgentInputDelivererReadyListeners.add(
      this.monitorRelayReadyListener,
    );

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
    void this.runMonitorReconcile();
    this.startMonitorReconcileWatcher();
    this.startStaleBuildWatcher();
  }

  async shutdown(
    signal: DaemonShutdownReason = "manual",
  ): Promise<DaemonShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.clearStaleBuildWatcher();
    this.clearMonitorReconcileWatcher();
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
      outboxDrain: this.opts.outboxDrain,
      monitorRegistryPath: this.opts.monitorRegistryPath,
      monitorRegistryNow: this.opts.monitorRegistryNow,
      monitorRegistryNotify: this.opts.monitorRegistryNotify,
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

  private createDefaultMonitorReconciler(
    context: CmuxServerContext,
  ): (options?: {
    rearmClaimTimeoutMs?: number;
    monitorIds?: readonly string[];
  }) => Promise<unknown> {
    const registryPath =
      this.opts.monitorRegistryPath ?? defaultMonitorRegistryPath();
    const findOwner = (ownerSeat: string) =>
      context.stateMgr
        .listStates()
        .find(
          (record) =>
            record.agent_id === ownerSeat || record.seat_id === ownerSeat,
        ) ?? null;

    return (options) =>
      reconcileMonitorRegistry({
        registryPath,
        now: this.opts.monitorRegistryNow,
        rearmAckTimeoutMs:
          (this.monitorReconcileIntervalMs > 0
            ? this.monitorReconcileIntervalMs
            : DEFAULT_MONITOR_RECONCILE_INTERVAL_MS) * 2,
        ...(options?.rearmClaimTimeoutMs !== undefined
          ? { rearmClaimTimeoutMs: options.rearmClaimTimeoutMs }
          : {}),
        ...(options?.monitorIds ? { monitorIds: options.monitorIds } : {}),
        ownerPtyDead: (ownerSeat) => {
          const owner = findOwner(ownerSeat);
          return (
            owner !== null &&
            context.surfaceWriteLiveness.observe(owner.surface_id)?.pty_dead ===
              true
          );
        },
        ownerAlive: async (ownerSeat) => {
          const owner = findOwner(ownerSeat);
          if (!owner || owner.state === "done" || owner.state === "error") {
            return false;
          }
          try {
            await context.client.readScreen(owner.surface_id, {
              ...(owner.workspace_id
                ? { workspace: owner.workspace_id }
                : {}),
            });
            return true;
          } catch {
            return false;
          }
        },
        ownerProgressedSince: (record) => {
          const owner = findOwner(record.owner_seat);
          if (!owner || !record.rearm_claimed_at) return false;
          const inboxOpts: InboxOpts = {
            ...(this.opts.inboxBaseDir
              ? { baseDir: this.opts.inboxBaseDir }
              : {}),
            ...(this.opts.monitorRegistryNow
              ? { now: this.opts.monitorRegistryNow }
              : {}),
          };
          const messageId = `monitor-rearm:${record.monitor_id}:${record.last_signal_at}`;
          if (ackedIds(owner.agent_id, inboxOpts).has(messageId)) return true;
          const heartbeat = readLastAgentHeartbeat(owner.agent_id, inboxOpts);
          return (
            heartbeat !== null &&
            heartbeat.ts_ms > Date.parse(record.rearm_claimed_at)
          );
        },
        rearm: async (record) => {
          const owner = findOwner(record.owner_seat);
          if (!owner || !record.rearm_command || !record.rearm_claimed_at) {
            throw new Error(
              `Monitor re-arm owner or command missing: ${record.monitor_id}`,
            );
          }
          const inboxOpts: InboxOpts = {
            ...(this.opts.inboxBaseDir
              ? { baseDir: this.opts.inboxBaseDir }
              : {}),
            ...(this.opts.monitorRegistryNow
              ? { now: this.opts.monitorRegistryNow }
              : {}),
          };
          const message = dispatchOnce(
            owner.agent_id,
            {
              id: `monitor-rearm:${record.monitor_id}:${record.last_signal_at}`,
              from: "cmuxlayer-daemon",
              tag: "monitor-rearm",
              task: `Re-arm monitor ${record.monitor_id} with this exact command, then signal_monitor after the watcher is live:\n${record.rearm_command}`,
            },
            inboxOpts,
          );
          if (
            monitorAlive(
              owner.agent_id,
              MONITOR_REARM_INBOX_HEARTBEAT_MAX_AGE_MS,
              inboxOpts,
            )
          ) {
            return;
          }
          const guardedRelay = context.lifecycleAgentInputDeliverer;
          if (!guardedRelay) {
            throw new Error("guarded agent relay is not ready");
          }
          await guardedRelay({
            agent_id: owner.agent_id,
            text: `[inbox] monitor recovery message ${message.id} — read ${inboxPath(owner.agent_id, inboxOpts)}, re-arm, then ack`,
            press_enter: true,
            allow_busy: true,
            source_event: "dispatch_nudge",
          });
        },
        escalate: async (record) => {
          const ownerWedged = record.collapsed_reason === "owner-wedged";
          const notify = ownerWedged
            ? (this.opts.monitorOwnerWedgedNotify ??
              (async () => false))
            : (this.opts.monitorOwnerPtyDeadNotify ??
              (async () => false));
          await notify({
            title: ownerWedged
              ? "Monitor owner wedged"
              : "Monitor owner PTY dead",
            body: ownerWedged
              ? `Monitor ${record.monitor_id} collapsed because pane-alive owner ${record.owner_seat} did not acknowledge re-arm; watch_targets=${record.watch_targets.join(", ")}`
              : `Monitor ${record.monitor_id} collapsed because owner ${record.owner_seat} cannot accept terminal writes; watch_targets=${record.watch_targets.join(", ")}`,
            source: "cmuxlayer-monitor-registry",
            priority: "high",
            dedupe_key: `${record.monitor_id}:${record.collapsed_reason}`,
          });
        },
      });
  }

  private async retryFailedMonitorRearmsWhenRelayReady(): Promise<void> {
    if (this.monitorReconcileInFlight) {
      this.monitorRelayReadyPending = true;
      return;
    }
    const monitorIds = [...this.monitorReconcileFailedIds];
    if (monitorIds.length === 0) return;
    await this.runMonitorReconcile({
      rearmClaimTimeoutMs: 0,
      monitorIds,
    });
  }

  private async runMonitorReconcile(options?: {
    rearmClaimTimeoutMs?: number;
    monitorIds?: readonly string[];
  }): Promise<void> {
    if (!this.monitorReconcileFn) return;
    if (this.monitorReconcileInFlight) return;
    this.monitorReconcileInFlight = true;
    let reconcileResult: unknown;
    try {
      reconcileResult = await this.monitorReconcileFn(options);
    } catch (error) {
      this.logger.error(
        "[cmuxlayer-daemon] monitor reconciliation failed",
        error,
      );
    } finally {
      this.monitorReconcileInFlight = false;
      if (typeof reconcileResult === "object" && reconcileResult !== null) {
        const result = reconcileResult as Record<string, unknown>;
        if (Array.isArray(result.failed)) {
          for (const monitorId of result.failed) {
            if (typeof monitorId === "string") {
              this.monitorReconcileFailedIds.add(monitorId);
            }
          }
        }
        for (const key of ["rearmed", "collapsed", "reaped"] as const) {
          const outcomes = result[key];
          if (Array.isArray(outcomes)) {
            for (const outcome of outcomes) {
              const monitorId =
                typeof outcome === "string"
                  ? outcome
                  : typeof outcome === "object" &&
                      outcome !== null &&
                      "monitor_id" in outcome &&
                      typeof outcome.monitor_id === "string"
                    ? outcome.monitor_id
                    : null;
              if (monitorId) this.monitorReconcileFailedIds.delete(monitorId);
            }
          }
        }
      }
      if (this.monitorRelayReadyPending && !this.draining) {
        this.monitorRelayReadyPending = false;
        void this.retryFailedMonitorRearmsWhenRelayReady();
      }
    }
  }

  private startMonitorReconcileWatcher(): void {
    if (!this.monitorReconcileFn || this.monitorReconcileIntervalMs <= 0) return;
    this.monitorReconcileTimer = setInterval(() => {
      void this.runMonitorReconcile();
    }, this.monitorReconcileIntervalMs);
    this.monitorReconcileTimer.unref?.();
  }

  private clearMonitorReconcileWatcher(): void {
    if (!this.monitorReconcileTimer) return;
    clearInterval(this.monitorReconcileTimer);
    this.monitorReconcileTimer = null;
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
        "[cmuxlayer-daemon] upstream cmux transport remained unreachable; retiring so a pane-descended respawn can reconnect",
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
  const testProcess =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test";
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
    outboxDrain:
      opts.outboxDrain ??
      (testProcess
        ? async () => undefined
        : () => drainOutbox({ deliver: httpDeliver })),
    monitorRegistryNotify:
      opts.monitorRegistryNotify ??
      (testProcess ? async () => undefined : httpNotifyMonitorDeadman),
    monitorRegistryPath:
      opts.monitorRegistryPath ?? defaultMonitorRegistryPath(),
    monitorOwnerPtyDeadNotify:
      opts.monitorOwnerPtyDeadNotify ??
      (testProcess
        ? async () => false
        : (notification) => httpDeliver(notification, DEFAULT_NOTIFY_URL)),
    monitorOwnerWedgedNotify:
      opts.monitorOwnerWedgedNotify ??
      (testProcess
        ? async () => false
        : (notification) => httpDeliver(notification, DEFAULT_NOTIFY_URL)),
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

if (isMainModule(import.meta.url, process.argv[1])) {
  runDaemon().catch((error) => {
    console.error("[cmuxlayer-daemon] fatal", error);
    process.exit(1);
  });
}
