#!/usr/bin/env node

import net from "node:net";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import {
  ReadBuffer,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_SOCKET_PATH = "/tmp/cmuxlayer.sock";
const DEFAULT_INITIAL_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 5_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.3;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BUFFERED_REQUESTS = 100;
const PROXY_ERROR_CODE = -32001;

export interface ReconnectDelayOptions {
  initialBackoffMs: number;
  maxBackoffMs: number;
  jitterRatio: number;
  random: () => number;
}

export interface CmuxLayerProxyOptions {
  socketPath?: string;
  input?: Readable;
  output?: Writable;
  connect?: (socketPath: string) => net.Socket;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  reconnectJitterRatio?: number;
  random?: () => number;
  requestTimeoutMs?: number;
  maxBufferedRequests?: number;
  onReconnectDelay?: (delayMs: number, attempt: number) => void;
  logger?: Pick<Console, "error">;
}

type JsonRpcRequest = JSONRPCMessage & {
  id: RequestId;
  method: string;
};

type JsonRpcNotification = JSONRPCMessage & {
  method: string;
};

type JsonRpcResponse = JSONRPCMessage & {
  id: RequestId;
};

interface QueuedMessage {
  message: JSONRPCMessage;
  sequence: number;
  requestKey?: string;
}

interface PendingRequest extends QueuedMessage {
  id: RequestId;
  timeout: NodeJS.Timeout;
  sent: boolean;
}

export function computeReconnectDelay(
  attempt: number,
  opts: ReconnectDelayOptions,
): number {
  const base = Math.min(
    opts.maxBackoffMs,
    opts.initialBackoffMs * 2 ** Math.max(0, attempt),
  );
  const jitter = base * opts.jitterRatio * opts.random();
  return Math.min(opts.maxBackoffMs, Math.round(base + jitter));
}

function isJsonRpcRequest(message: JSONRPCMessage): message is JsonRpcRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    "method" in message &&
    typeof message.method === "string"
  );
}

function isJsonRpcNotification(
  message: JSONRPCMessage,
): message is JsonRpcNotification {
  return (
    typeof message === "object" &&
    message !== null &&
    !("id" in message) &&
    "method" in message &&
    typeof message.method === "string"
  );
}

function isJsonRpcResponse(
  message: JSONRPCMessage,
): message is JsonRpcResponse {
  return (
    typeof message === "object" &&
    message !== null &&
    "id" in message &&
    ("result" in message || "error" in message)
  );
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function cloneMessage<T extends JSONRPCMessage>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
}

function writeMessage(
  stream: Pick<Writable, "write" | "once" | "off"> &
    Partial<Pick<Writable, "destroyed" | "writableEnded">>,
  message: JSONRPCMessage,
): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.reject(new Error("stream is closed"));
  }
  const payload = serializeMessage(message);
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error: Error) => settle(error);
    const onClose = () =>
      settle(new Error("stream closed before write completed"));
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    function settle(error?: Error | null) {
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
    }

    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      stream.write(payload, settle);
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export class CmuxLayerProxy {
  private readonly socketPath: string;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly connect: (socketPath: string) => net.Socket;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;
  private readonly maxBufferedRequests: number;
  private readonly onReconnectDelay?: (
    delayMs: number,
    attempt: number,
  ) => void;
  private readonly logger: Pick<Console, "error">;

  private readonly agentReadBuffer = new ReadBuffer();
  private daemonReadBuffer: ReadBuffer | null = null;
  private daemonSocket: net.Socket | null = null;
  private running = false;
  private connecting = false;
  private daemonReady = false;
  private flushing = false;
  private replayingInitialize = false;
  private initializeResultDelivered = false;
  private initializeRequest: JsonRpcRequest | null = null;
  private initializedNotification: JsonRpcNotification | null = null;
  private nextSequence = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectTimerResolve: (() => void) | null = null;
  private readonly queue: QueuedMessage[] = [];
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly expiredRequestKeys = new Set<string>();

  private readonly onAgentData = (chunk: Buffer) => {
    this.agentReadBuffer.append(chunk);
    this.processAgentBuffer();
  };

  private readonly onAgentError = (error: Error) => {
    this.logger.error("[cmuxlayer-proxy] agent stdio error", error);
  };

  constructor(opts: CmuxLayerProxyOptions = {}) {
    this.socketPath =
      opts.socketPath ??
      process.env.CMUXLAYER_DAEMON_SOCKET ??
      DEFAULT_SOCKET_PATH;
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
    this.connect = opts.connect ?? ((path) => net.createConnection(path));
    this.initialBackoffMs = opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.reconnectJitterRatio =
      opts.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO;
    this.random = opts.random ?? Math.random;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxBufferedRequests =
      opts.maxBufferedRequests ?? DEFAULT_MAX_BUFFERED_REQUESTS;
    this.onReconnectDelay = opts.onReconnectDelay;
    this.logger = opts.logger ?? console;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.input.on("data", this.onAgentData);
    this.input.on("error", this.onAgentError);
    this.ensureConnecting();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.input.off("data", this.onAgentData);
    this.input.off("error", this.onAgentError);
    this.agentReadBuffer.clear();
    this.clearReconnectTimer();
    this.disconnectDaemon();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();
    this.queue.length = 0;
  }

  isRunning(): boolean {
    return this.running;
  }

  private processAgentBuffer(): void {
    while (this.running) {
      try {
        const message = this.agentReadBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.handleAgentMessage(message);
      } catch (error) {
        this.logger.error(
          "[cmuxlayer-proxy] failed to parse agent frame",
          error,
        );
      }
    }
  }

  private handleAgentMessage(message: JSONRPCMessage): void {
    if (isJsonRpcRequest(message)) {
      if (message.method === "initialize") {
        this.initializeRequest = cloneMessage(message);
      }
      this.enqueueRequest(message);
      return;
    }

    if (
      isJsonRpcNotification(message) &&
      message.method === "notifications/initialized"
    ) {
      this.initializedNotification = cloneMessage(message);
    }

    this.queue.push({
      message: cloneMessage(message),
      sequence: this.nextSequence++,
    });
    this.kickConnectionIfIdle();
    void this.flushQueue();
  }

  private enqueueRequest(message: JsonRpcRequest): void {
    const key = requestKey(message.id);
    if (this.pendingRequests.has(key)) {
      void this.sendAgentError(
        message.id,
        "duplicate JSON-RPC request id is already pending",
      );
      return;
    }

    if (
      !this.daemonReady &&
      this.bufferedRequestCount() >= this.maxBufferedRequests
    ) {
      void this.sendAgentError(
        message.id,
        "cmuxlayer daemon request buffer is full while reconnecting",
      );
      return;
    }

    this.expiredRequestKeys.delete(key);
    const pending: PendingRequest = {
      id: message.id,
      message: cloneMessage(message),
      sequence: this.nextSequence++,
      requestKey: key,
      sent: false,
      timeout: setTimeout(() => {
        this.failPendingRequest(
          key,
          "cmuxlayer daemon temporarily offline or request timed out while retrying",
        );
      }, this.requestTimeoutMs),
    };
    this.pendingRequests.set(key, pending);
    this.queue.push(pending);
    this.kickConnectionIfIdle();
    void this.flushQueue();
  }

  private bufferedRequestCount(): number {
    return this.queue.filter((queued) => queued.requestKey).length;
  }

  private ensureConnecting(): void {
    if (!this.running || this.connecting || this.daemonSocket) {
      return;
    }
    this.connecting = true;
    void this.reconnectLoop();
  }

  // Resume connecting after we went quiescent (e.g. the daemon rejected the
  // replayed initialize). No-ops while connected, connecting, or a reconnect
  // is already scheduled, so it only fires when the proxy is fully idle.
  private kickConnectionIfIdle(): void {
    if (
      !this.running ||
      this.daemonSocket ||
      this.connecting ||
      this.reconnectTimer
    ) {
      return;
    }
    this.reconnectAttempt = 0;
    this.ensureConnecting();
  }

  private async reconnectLoop(): Promise<void> {
    while (this.running && !this.daemonSocket) {
      try {
        const socket = await this.openDaemonSocket();
        this.connecting = false;
        this.attachDaemonSocket(socket);
        return;
      } catch {
        const attempt = this.reconnectAttempt++;
        const delayMs = computeReconnectDelay(attempt, {
          initialBackoffMs: this.initialBackoffMs,
          maxBackoffMs: this.maxBackoffMs,
          jitterRatio: this.reconnectJitterRatio,
          random: this.random,
        });
        this.onReconnectDelay?.(delayMs, attempt);
        await this.delay(delayMs);
      }
    }
    this.connecting = false;
  }

  private openDaemonSocket(): Promise<net.Socket> {
    const socket = this.connect(this.socketPath);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };
      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          socket.destroy();
          reject(error);
          return;
        }
        resolve(socket);
      };
      const onConnect = () => settle();
      const onError = (error: Error) => settle(error);
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  private attachDaemonSocket(socket: net.Socket): void {
    if (!this.running) {
      socket.destroy();
      return;
    }
    this.daemonSocket = socket;
    this.daemonReadBuffer = new ReadBuffer();
    socket.on("data", this.onDaemonData);
    socket.on("error", this.onDaemonError);
    socket.on("close", this.onDaemonClose);
    socket.resume();

    if (
      this.initializeRequest &&
      !this.pendingRequests.has(requestKey(this.initializeRequest.id))
    ) {
      this.replayInitialize();
      return;
    }

    this.daemonReady = true;
    this.reconnectAttempt = 0;
    void this.flushQueue();
  }

  private readonly onDaemonData = (chunk: Buffer) => {
    if (!this.daemonReadBuffer) {
      return;
    }
    this.daemonReadBuffer.append(chunk);
    // handleDaemonMessage may disconnect the daemon mid-loop (e.g. on a rejected
    // initialize replay), which nulls daemonReadBuffer — re-check it each pass so
    // we don't dereference null and spin forever logging TypeErrors.
    while (this.running && this.daemonReadBuffer) {
      const buffer = this.daemonReadBuffer;
      try {
        const message = buffer.readMessage();
        if (message === null) {
          break;
        }
        this.handleDaemonMessage(message);
      } catch (error) {
        this.logger.error(
          "[cmuxlayer-proxy] failed to parse daemon frame",
          error,
        );
        break;
      }
    }
  };

  private readonly onDaemonError = (error: Error) => {
    this.logger.error("[cmuxlayer-proxy] daemon socket error", error);
    // The following "close" event still drives reconnection.
  };

  private readonly onDaemonClose = () => {
    this.handleDaemonDrop();
  };

  private handleDaemonMessage(message: JSONRPCMessage): void {
    if (this.replayingInitialize && this.isInitializeResponse(message)) {
      this.replayingInitialize = false;
      if ("error" in message) {
        this.failAllPendingRequests(
          "cmuxlayer daemon initialize replay failed while reconnecting",
        );
        // A replayed initialize that the daemon *answers with an error* is a
        // protocol rejection (e.g. handshake/version mismatch), not a transport
        // drop. Reconnecting-and-replaying immediately would hammer the daemon
        // in a tight loop (a connection storm), so go quiescent here and only
        // reconnect when fresh agent traffic arrives — see kickConnectionIfIdle.
        this.disconnectDaemon();
        return;
      }
      void this.sendInitializedThenFlush();
      return;
    }

    if (isJsonRpcResponse(message)) {
      const key = requestKey(message.id);
      const pending = this.pendingRequests.get(key);
      if (!pending) {
        if (this.expiredRequestKeys.has(key)) {
          this.logger.error(
            "[cmuxlayer-proxy] late daemon response for expired request id dropped",
            { id: message.id },
          );
          return;
        }
        void this.writeAgent(message);
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(key);
      this.expiredRequestKeys.delete(key);
      if (
        this.initializeRequest &&
        key === requestKey(this.initializeRequest.id)
      ) {
        this.initializeResultDelivered = true;
      }
      void this.writeAgent(message);
      return;
    }

    void this.writeAgent(message);
  }

  private isInitializeResponse(message: JSONRPCMessage): boolean {
    return (
      isJsonRpcResponse(message) &&
      this.initializeRequest !== null &&
      requestKey(message.id) === requestKey(this.initializeRequest.id)
    );
  }

  private replayInitialize(): void {
    if (!this.daemonSocket || !this.initializeRequest) {
      this.handleDaemonDrop();
      return;
    }
    this.daemonReady = false;
    this.replayingInitialize = true;
    void writeMessage(this.daemonSocket, this.initializeRequest).catch(() => {
      this.handleDaemonDrop();
    });
  }

  private async sendInitializedThenFlush(): Promise<void> {
    if (!this.daemonSocket) {
      this.handleDaemonDrop();
      return;
    }
    if (this.initializedNotification) {
      this.removeQueuedInitializedNotifications();
      try {
        await writeMessage(this.daemonSocket, this.initializedNotification);
      } catch {
        this.handleDaemonDrop();
        return;
      }
    }
    this.daemonReady = true;
    this.reconnectAttempt = 0;
    await this.flushQueue();
  }

  private removeQueuedInitializedNotifications(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index];
      if (
        isJsonRpcNotification(queued.message) &&
        queued.message.method === "notifications/initialized"
      ) {
        this.queue.splice(index, 1);
      }
    }
  }

  private async flushQueue(): Promise<void> {
    if (
      this.flushing ||
      !this.running ||
      !this.daemonReady ||
      !this.daemonSocket
    ) {
      return;
    }
    this.flushing = true;
    try {
      while (
        this.running &&
        this.daemonReady &&
        this.daemonSocket &&
        this.queue.length > 0
      ) {
        const queued = this.queue.shift();
        if (!queued) {
          continue;
        }
        const pending = queued.requestKey
          ? this.pendingRequests.get(queued.requestKey)
          : undefined;
        if (queued.requestKey && !pending) {
          continue;
        }
        if (pending) {
          pending.sent = true;
        }
        try {
          await writeMessage(this.daemonSocket, queued.message);
        } catch {
          if (pending) {
            pending.sent = false;
          }
          this.queue.unshift(queued);
          this.handleDaemonDrop();
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private handleDaemonDrop(): void {
    if (!this.daemonSocket && !this.daemonReadBuffer) {
      this.reconnectAfterDelay();
      return;
    }
    this.disconnectDaemon();
    this.daemonReady = false;
    this.replayingInitialize = false;
    this.requeueSentRequests();
    this.enforceBufferCap();
    this.reconnectAfterDelay();
  }

  private reconnectAfterDelay(): void {
    if (!this.running || this.connecting || this.daemonSocket) {
      return;
    }
    const attempt = this.reconnectAttempt++;
    const delayMs = computeReconnectDelay(attempt, {
      initialBackoffMs: this.initialBackoffMs,
      maxBackoffMs: this.maxBackoffMs,
      jitterRatio: this.reconnectJitterRatio,
      random: this.random,
    });
    this.onReconnectDelay?.(delayMs, attempt);
    this.connecting = true;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectTimerResolve = null;
      this.connecting = false;
      this.ensureConnecting();
    }, delayMs);
  }

  private disconnectDaemon(): void {
    const socket = this.daemonSocket;
    if (socket) {
      socket.off("data", this.onDaemonData);
      socket.off("error", this.onDaemonError);
      socket.off("close", this.onDaemonClose);
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    this.daemonSocket = null;
    this.daemonReadBuffer?.clear();
    this.daemonReadBuffer = null;
  }

  private requeueSentRequests(): void {
    const queued = new Set(this.queue);
    for (const pending of this.pendingRequests.values()) {
      if (!pending.sent || queued.has(pending)) {
        continue;
      }
      pending.sent = false;
      this.queue.push(pending);
    }
    this.queue.sort((left, right) => left.sequence - right.sequence);
  }

  private failPendingRequest(key: string, message: string): void {
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(key);
    this.expiredRequestKeys.add(key);
    const index = this.queue.findIndex((queued) => queued.requestKey === key);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    void this.sendAgentError(pending.id, message);
  }

  private enforceBufferCap(): void {
    const queuedRequests = this.queue
      .filter((queued) => queued.requestKey)
      .sort((left, right) => left.sequence - right.sequence);
    for (const queued of queuedRequests.slice(this.maxBufferedRequests)) {
      if (!queued.requestKey) {
        continue;
      }
      this.failPendingRequest(
        queued.requestKey,
        "cmuxlayer daemon request buffer is full while reconnecting",
      );
    }
  }

  private failAllPendingRequests(message: string): void {
    for (const key of [...this.pendingRequests.keys()]) {
      this.failPendingRequest(key, message);
    }
  }

  private sendAgentError(id: RequestId, message: string): Promise<void> {
    return this.writeAgent({
      jsonrpc: "2.0",
      id,
      error: {
        code: PROXY_ERROR_CODE,
        message,
      },
    });
  }

  private async writeAgent(message: JSONRPCMessage): Promise<void> {
    try {
      await writeMessage(this.output, message);
    } catch (error) {
      this.logger.error("[cmuxlayer-proxy] failed to write agent frame", error);
    }
  }

  private delay(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectTimerResolve = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectTimerResolve = null;
        resolve();
      }, delayMs);
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectTimerResolve?.();
    this.reconnectTimerResolve = null;
  }
}

export async function runProxy(
  opts: CmuxLayerProxyOptions = {},
): Promise<CmuxLayerProxy> {
  const proxy = new CmuxLayerProxy(opts);
  proxy.start();
  return proxy;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runProxy().catch((error) => {
    console.error("[cmuxlayer-proxy] fatal", error);
    process.exit(1);
  });
}
