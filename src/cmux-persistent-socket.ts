/**
 * Persistent socket connection for high-frequency cmux operations.
 *
 * Unlike CmuxSocketClient (which opens/closes a connection per request),
 * this keeps a single socket open and multiplexes requests over it.
 * Useful for sidebar sweeps (3+ calls every 5 seconds).
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import { isCmuxAccessControlDenied } from "./cmux-access-control.js";
import { CmuxSocketError } from "./cmux-socket-error.js";
import { DEFAULT_SOCKET_PATH } from "./cmux-socket-path.js";
import { isCmuxSidebarStatusFrame } from "./cmux-status-frame.js";

const REQUEST_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 2_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 15_000;
const MAX_IN_FLIGHT = 256;
const POLLING_BURST = 8;
const POLLING_REFILL_MS = 100;
const POLLING_MAX_CONCURRENT = 4;
const RATE_LIMIT_RETRY_MAX = 3;
const RATE_LIMIT_BACKOFF_BASE_MS = 100;
const RATE_LIMIT_BACKOFF_MAX_MS = 1_000;

export interface BackoffOptions {
  /** Base delay in milliseconds (default: 2_000) */
  baseMs?: number;
  /** Maximum delay in milliseconds (default: 15_000) */
  maxMs?: number;
  /** Apply random jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
}

export interface PollingOptions {
  /** Shared per-connection burst budget. Defaults below cmux's burst of 9. */
  burst?: number;
  /** One token is restored per interval (cmux 0.64.24: approximately 100ms). */
  refillMs?: number;
  /** Cap simultaneous polling requests on the shared connection. */
  maxConcurrent?: number;
  /** Retry count after an application-level rate_limited response. */
  maxRateLimitRetries?: number;
  /** Initial application-level limiter delay. */
  rateLimitBackoffBaseMs?: number;
  /** Maximum application-level limiter delay. */
  rateLimitBackoffMaxMs?: number;
  /** Apply jitter to limiter backoff (default: true). */
  jitter?: boolean;
}

export interface CmuxCallOptions {
  /** Safe polling/read call: budget it and retry only rate_limited responses. */
  polling?: boolean;
}

export interface CmuxPersistentSocketOptions {
  socketPath?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxInFlight?: number;
  backoff?: BackoffOptions;
  polling?: PollingOptions;
  /** Override connection creation for deterministic connect-leg tests. */
  createConnection?: typeof net.createConnection;
}

interface PollingQueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}

interface PollingBackoffEntry {
  timer: ReturnType<typeof setTimeout>;
  reject: (error: Error) => void;
}

interface V2Request {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface V2Response {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; data?: unknown };
}

export class CmuxPersistentSocket {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private buffer = "";
  private pending = new Map<
    string,
    {
      resolve: (v: V2Response) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private pendingV1: Array<{
    resolve: (v: string) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    payload: string;
  }> = [];
  private connected = false;
  private timeoutMs: number;
  private connectTimeoutMs: number;
  private maxInFlight: number;
  /** Guards against concurrent connect() calls */
  private connectPromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private createConnection: typeof net.createConnection;

  // Backoff state
  private backoffBaseMs: number;
  private backoffMaxMs: number;
  private backoffJitter: boolean;
  private backoffAttempt = 0;
  private _currentBackoffMs = 0;

  // Shared cmux polling-limiter budget. This is deliberately independent of
  // reconnect backoff: rate_limited is an application response on a healthy
  // connection, not a reason to reconnect and evade the per-connection limit.
  private pollingBurst: number;
  private pollingRefillMs: number;
  private pollingMaxConcurrent: number;
  private maxRateLimitRetries: number;
  private rateLimitBackoffBaseMs: number;
  private rateLimitBackoffMaxMs: number;
  private rateLimitJitter: boolean;
  private pollingTokens: number;
  private pollingLastRefillAt = Date.now();
  private pollingActive = 0;
  private pollingOutstanding = 0;
  private pollingCancellationGeneration = 0;
  private pollingQueue: PollingQueueEntry[] = [];
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingBackoffs = new Set<PollingBackoffEntry>();

  constructor(opts?: CmuxPersistentSocketOptions) {
    this.socketPath =
      opts?.socketPath ?? process.env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
    this.timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = opts?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.maxInFlight = opts?.maxInFlight ?? MAX_IN_FLIGHT;
    this.backoffBaseMs = opts?.backoff?.baseMs ?? BACKOFF_BASE_MS;
    this.backoffMaxMs = opts?.backoff?.maxMs ?? BACKOFF_MAX_MS;
    this.backoffJitter = opts?.backoff?.jitter ?? true;
    this.pollingBurst = Math.max(1, opts?.polling?.burst ?? POLLING_BURST);
    this.pollingRefillMs = Math.max(
      1,
      opts?.polling?.refillMs ?? POLLING_REFILL_MS,
    );
    this.pollingMaxConcurrent = Math.max(
      1,
      opts?.polling?.maxConcurrent ?? POLLING_MAX_CONCURRENT,
    );
    this.maxRateLimitRetries = Math.max(
      0,
      opts?.polling?.maxRateLimitRetries ?? RATE_LIMIT_RETRY_MAX,
    );
    this.rateLimitBackoffBaseMs = Math.max(
      1,
      opts?.polling?.rateLimitBackoffBaseMs ?? RATE_LIMIT_BACKOFF_BASE_MS,
    );
    this.rateLimitBackoffMaxMs = Math.max(
      this.rateLimitBackoffBaseMs,
      opts?.polling?.rateLimitBackoffMaxMs ?? RATE_LIMIT_BACKOFF_MAX_MS,
    );
    this.rateLimitJitter = opts?.polling?.jitter ?? true;
    this.pollingTokens = this.pollingBurst;
    this.createConnection = opts?.createConnection ?? net.createConnection;
  }

  private refillPollingTokens(now = Date.now()): void {
    const elapsed = now - this.pollingLastRefillAt;
    if (elapsed < this.pollingRefillMs) return;
    const restored = Math.floor(elapsed / this.pollingRefillMs);
    this.pollingTokens = Math.min(
      this.pollingBurst,
      this.pollingTokens + restored,
    );
    this.pollingLastRefillAt += restored * this.pollingRefillMs;
  }

  private schedulePollingPump(): void {
    if (this.pollingTimer || this.pollingQueue.length === 0) return;
    if (this.pollingActive >= this.pollingMaxConcurrent) return;
    this.refillPollingTokens();
    if (this.pollingTokens > 0) {
      queueMicrotask(() => this.pumpPollingQueue());
      return;
    }
    const elapsed = Date.now() - this.pollingLastRefillAt;
    const delay = Math.max(1, this.pollingRefillMs - elapsed);
    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = null;
      this.pumpPollingQueue();
    }, delay);
    this.pollingTimer.unref?.();
  }

  private pumpPollingQueue(): void {
    this.refillPollingTokens();
    while (
      this.pollingQueue.length > 0 &&
      this.pollingTokens > 0 &&
      this.pollingActive < this.pollingMaxConcurrent
    ) {
      const entry = this.pollingQueue.shift();
      if (!entry) break;
      this.pollingTokens -= 1;
      this.pollingActive += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.pollingActive = Math.max(0, this.pollingActive - 1);
        this.pumpPollingQueue();
      });
    }
    this.schedulePollingPump();
  }

  private acquirePollingSlot(): Promise<() => void> {
    return new Promise((resolve, reject) => {
      this.pollingQueue.push({ resolve, reject });
      this.pumpPollingQueue();
    });
  }

  private rateLimitBackoffMs(attempt: number): number {
    const unjittered = Math.min(
      this.rateLimitBackoffMaxMs,
      this.rateLimitBackoffBaseMs * 2 ** attempt,
    );
    if (!this.rateLimitJitter) return unjittered;
    return Math.max(
      this.rateLimitBackoffBaseMs,
      Math.round(unjittered * (0.5 + Math.random() * 0.5)),
    );
  }

  private waitForPollingBackoff(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry: PollingBackoffEntry = {
        timer: setTimeout(() => {
          this.pollingBackoffs.delete(entry);
          resolve();
        }, ms),
        reject,
      };
      entry.timer.unref?.();
      this.pollingBackoffs.add(entry);
    });
  }

  private cancelPollingWaiters(error: CmuxSocketError): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    for (const entry of this.pollingQueue.splice(0)) {
      entry.reject(error);
    }
    for (const entry of this.pollingBackoffs) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pollingBackoffs.clear();
    this.pollingTokens = this.pollingBurst;
    this.pollingLastRefillAt = Date.now();
  }

  /** Current backoff delay in ms (0 when connected or no failures). */
  currentBackoffMs(): number {
    return this._currentBackoffMs;
  }

  /** Advance backoff to the next exponential step. */
  incrementBackoff(): void {
    this.backoffAttempt++;
    if (!this.backoffJitter) {
      this._currentBackoffMs = Math.min(
        this.backoffBaseMs * Math.pow(2, this.backoffAttempt - 1),
        this.backoffMaxMs,
      );
      return;
    }

    const previous = this._currentBackoffMs || this.backoffBaseMs;
    const upper = Math.max(this.backoffBaseMs, previous * 3);
    this._currentBackoffMs = Math.min(
      this.backoffMaxMs,
      Math.round(
        this.backoffBaseMs + Math.random() * (upper - this.backoffBaseMs),
      ),
    );
  }

  /** Reset backoff after a successful connection. */
  resetBackoff(): void {
    this.backoffAttempt = 0;
    this._currentBackoffMs = 0;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    // Deduplicate concurrent connect() calls
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;

      const socket = this.createConnection({ path: this.socketPath }, () => {
        if (settled || this.socket !== socket) {
          if (!settled) {
            settled = true;
            reject(
              new CmuxSocketError("Socket disconnected", "connection_closed"),
            );
          }
          socket.destroy();
          return;
        }
        this.connectionGeneration++;
        this.connected = true;
        settled = true;
        this.connectPromise = null;
        this.resetBackoff();
        if (this.pollingTimer) clearTimeout(this.pollingTimer);
        this.pollingTimer = null;
        this.pollingTokens = this.pollingBurst;
        this.pollingLastRefillAt = Date.now();
        this.pumpPollingQueue();
        resolve();
      });
      this.socket = socket;
      this.raiseSocketListenerLimit(socket);

      socket.setTimeout(this.connectTimeoutMs, () => {
        const transportPhase = settled ? "response" : "connect";
        const error = new CmuxSocketError(
          `Connect timeout after ${this.connectTimeoutMs}ms`,
          "connection_error",
          { transportPhase },
        );
        this.connected = false;
        this.connectPromise = null;
        socket.destroy();
        this.rejectAllPending(error);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on("data", (chunk: Buffer) => {
        // A connected socket is not usable until cmux produces its first
        // response bytes. Keep the connect-leg deadline armed across the OS
        // connect event so an accepted-but-wedged daemon cannot inherit the
        // much longer request timeout.
        socket.setTimeout(0);
        this.buffer += chunk.toString("utf-8");
        this.processBuffer();
      });

      socket.on("error", (err: Error) => {
        if (this.socket !== socket) return;
        this.connected = false;
        const socketError = this.toConnectionError(
          err,
          settled ? "response" : "connect",
        );
        this.rejectAllPending(socketError);
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(socketError);
        }
      });

      socket.on("close", () => {
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(
            new CmuxSocketError(
              "Socket closed unexpectedly",
              "connection_closed",
              { transportPhase: "response" },
            ),
          );
        }
        if (this.socket !== socket) return;
        this.connected = false;
        this.socket = null;
        // Reject all inflight requests — transport is gone
        this.rejectAllPending(
          new CmuxSocketError(
            "Socket closed unexpectedly",
            "connection_closed",
            { transportPhase: "response" },
          ),
        );
      });
    });

    return this.connectPromise;
  }

  private raiseSocketListenerLimit(socket: net.Socket): void {
    const current = socket.getMaxListeners();
    if (current > 0 && current < this.maxInFlight + 8) {
      socket.setMaxListeners(this.maxInFlight + 8);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.socket) return;
    if (this.connectPromise) return this.connectPromise;

    if (this._currentBackoffMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this._currentBackoffMs),
      );
    }

    try {
      await this.connect();
    } catch (error) {
      this.incrementBackoff();
      throw error;
    }
  }

  private rejectAllPending(error: CmuxSocketError): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const entry of this.pendingV1) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pendingV1 = [];
  }

  private rejectPendingV2(error: CmuxSocketError): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<V2Response>;
        if (typeof parsed.id === "string") {
          const entry = this.pending.get(parsed.id);
          if (!entry) {
            continue;
          }
          clearTimeout(entry.timer);
          this.pending.delete(parsed.id);
          entry.resolve(parsed as V2Response);
        } else if (this.pendingV1.length > 0) {
          this.resolveNextV1(line);
        }
      } catch (error) {
        if (!this.isJsonLikeFrame(line) && isCmuxAccessControlDenied(line)) {
          this.rejectAllPending(
            new CmuxSocketError(
              `cmux access-control denial: ${line.slice(0, 120)}`,
              "access_denied",
              { transportPhase: "response" },
            ),
          );
          continue;
        }
        if (this.isJsonLikeFrame(line)) {
          if (line.trimStart().startsWith("[") && this.pendingV1.length > 0) {
            this.resolveNextV1(line);
            continue;
          }
          this.rejectMalformedFrame(line, error);
        } else if (this.pendingV1.length > 0) {
          this.resolveNextV1(line);
        } else if (this.pending.size > 0) {
          if (isCmuxSidebarStatusFrame(line)) {
            continue;
          }
          this.rejectUnexpectedV2Frame(line);
        }
      }
    }
  }

  private isJsonLikeFrame(line: string): boolean {
    const trimmed = line.trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[");
  }

  private rejectMalformedFrame(line: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const socketError = new CmuxSocketError(
      `Malformed cmux socket frame: ${detail}; frame=${line.slice(0, 120)}`,
      "protocol_error",
    );
    if (line.trimStart().startsWith("{") && this.pending.size > 0) {
      this.rejectPendingV2(socketError);
      return;
    }

    const entry = this.pendingV1.shift();
    if (entry) {
      clearTimeout(entry.timer);
      entry.reject(socketError);
      this.writeNextV1();
      return;
    }

    if (this.pending.size > 0) {
      this.rejectPendingV2(socketError);
    }
  }

  private rejectUnexpectedV2Frame(line: string): void {
    this.rejectPendingV2(
      new CmuxSocketError(
        `Unexpected cmux socket frame: frame=${line.slice(0, 120)}`,
        "protocol_error",
      ),
    );
  }

  private resolveNextV1(line: string): void {
    const entry = this.pendingV1.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve(line.trim());
    this.writeNextV1();
  }

  private writeNextV1(): void {
    if (!this.socket || this.pendingV1.length === 0) return;
    const entry = this.pendingV1[0];
    this.writePayload(entry.payload, (error) => {
      const index = this.pendingV1.indexOf(entry);
      if (index === -1) return;
      const wasHead = index === 0;
      this.pendingV1.splice(index, 1);
      clearTimeout(entry.timer);
      entry.reject(error);
      if (wasHead) this.writeNextV1();
    });
  }

  private toConnectionError(
    error: Error,
    transportPhase: "connect" | "write" | "response" = "response",
  ): CmuxSocketError {
    return new CmuxSocketError(
      `Socket error: ${error.message}`,
      "connection_error",
      { transportPhase },
    );
  }

  private writePayload(
    payload: string,
    onWriteError: (error: CmuxSocketError) => void,
  ): void {
    const socket = this.socket;
    if (!socket) {
      onWriteError(
        new CmuxSocketError("Socket disconnected", "connection_closed", {
          transportPhase: "write",
        }),
      );
      return;
    }

    let settled = false;
    const cleanup = () => {
      socket.off("error", onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      onWriteError(this.toConnectionError(error, "write"));
    };
    const onError = (error: Error) => fail(error);

    // Run the write-scoped listener before the connection-wide listener. Node
    // invokes EventEmitter listeners in registration order; without prepend,
    // an asynchronous EPIPE is conservatively mislabeled as post-response and
    // a safe pre-response mutation retry is suppressed.
    socket.prependOnceListener("error", onError);
    try {
      socket.write(payload, () => {
        if (settled) return;
        settled = true;
        cleanup();
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private assertInFlightCapacity(): void {
    const inFlight = this.pending.size + this.pendingV1.length;
    if (inFlight >= this.maxInFlight) {
      throw new CmuxSocketError(
        `Too many in-flight cmux socket requests (${inFlight}/${this.maxInFlight})`,
        "too_many_requests",
      );
    }
  }

  private async callOnce<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    pollingGeneration = this.pollingCancellationGeneration,
  ): Promise<T> {
    if (pollingGeneration !== this.pollingCancellationGeneration) {
      throw new CmuxSocketError("Socket disconnected", "connection_closed");
    }
    this.assertInFlightCapacity();
    await this.ensureConnected();
    if (pollingGeneration !== this.pollingCancellationGeneration) {
      throw new CmuxSocketError("Socket disconnected", "connection_closed");
    }

    const id = crypto.randomUUID();
    const request: V2Request = { id, method, params };
    const payload = JSON.stringify(request) + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CmuxSocketError(
            `Timeout after ${this.timeoutMs}ms waiting for ${method}`,
            "timeout",
          ),
        );
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (response: V2Response) => {
          if (!response.ok) {
            const errCode = response.error?.code ?? "unknown";
            const errMsg = response.error?.message ?? "Unknown error";
            reject(new CmuxSocketError(`${errCode}: ${errMsg}`, errCode));
          } else {
            resolve((response.result ?? {}) as T);
          }
        },
        reject,
        timer,
      });

      this.writePayload(payload, (error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.reject(error);
      });
    });
  }

  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts: CmuxCallOptions = {},
  ): Promise<T> {
    if (!opts.polling) {
      return this.callOnce<T>(method, params);
    }

    if (this.pollingOutstanding >= this.maxInFlight) {
      throw new CmuxSocketError(
        `Too many queued cmux polling requests (${this.pollingOutstanding}/${this.maxInFlight})`,
        "too_many_requests",
      );
    }
    this.pollingOutstanding += 1;
    const pollingGeneration = this.pollingCancellationGeneration;
    try {
      for (let attempt = 0; ; attempt += 1) {
        const release = await this.acquirePollingSlot();
        try {
          return await this.callOnce<T>(method, params, pollingGeneration);
        } catch (error) {
          if (
            !(error instanceof CmuxSocketError) ||
            error.code !== "rate_limited" ||
            attempt >= this.maxRateLimitRetries
          ) {
            throw error;
          }
        } finally {
          release();
        }
        await this.waitForPollingBackoff(this.rateLimitBackoffMs(attempt));
      }
    } finally {
      this.pollingOutstanding = Math.max(0, this.pollingOutstanding - 1);
    }
  }

  async sendLine(command: string): Promise<string> {
    this.assertInFlightCapacity();
    await this.ensureConnected();

    const shouldWriteNow = this.pendingV1.length === 0;
    const payload = command + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pendingV1.findIndex(
          (entry) => entry.timer === timer,
        );
        const wasHead = index === 0;
        if (index !== -1) this.pendingV1.splice(index, 1);
        reject(
          new CmuxSocketError(
            `Timeout after ${this.timeoutMs}ms waiting for V1: ${command.split(" ")[0]}`,
            "timeout",
          ),
        );
        if (wasHead) this.writeNextV1();
      }, this.timeoutMs);

      this.pendingV1.push({ resolve, reject, timer, payload });
      if (shouldWriteNow) {
        this.writeNextV1();
      }
    });
  }

  disconnect(): void {
    const disconnected = new CmuxSocketError(
      "Socket disconnected",
      "connection_closed",
    );
    this.pollingCancellationGeneration += 1;
    this.cancelPollingWaiters(disconnected);
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
    this.connectPromise = null;
    this.rejectAllPending(disconnected);
  }

  isConnected(): boolean {
    return this.connected;
  }

  currentConnectionGeneration(): number {
    return this.connectionGeneration;
  }
}
