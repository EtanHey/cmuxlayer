/**
 * Persistent socket connection for high-frequency cmux operations.
 *
 * Unlike CmuxSocketClient (which opens/closes a connection per request),
 * this keeps a single socket open and multiplexes requests over it.
 * Useful for sidebar sweeps (3+ calls every 5 seconds).
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import { CmuxSocketError } from "./cmux-socket-error.js";
import { DEFAULT_SOCKET_PATH } from "./cmux-socket-path.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_IN_FLIGHT = 256;

export interface BackoffOptions {
  /** Base delay in milliseconds (default: 1000) */
  baseMs?: number;
  /** Maximum delay in milliseconds (default: 30_000) */
  maxMs?: number;
  /** Apply random jitter to prevent thundering herd (default: true) */
  jitter?: boolean;
}

export interface CmuxPersistentSocketOptions {
  socketPath?: string;
  timeoutMs?: number;
  maxInFlight?: number;
  backoff?: BackoffOptions;
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
  private maxInFlight: number;
  /** Guards against concurrent connect() calls */
  private connectPromise: Promise<void> | null = null;

  // Backoff state
  private backoffBaseMs: number;
  private backoffMaxMs: number;
  private backoffJitter: boolean;
  private backoffAttempt = 0;
  private _currentBackoffMs = 0;

  constructor(opts?: CmuxPersistentSocketOptions) {
    this.socketPath =
      opts?.socketPath ?? process.env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
    this.timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxInFlight = opts?.maxInFlight ?? MAX_IN_FLIGHT;
    this.backoffBaseMs = opts?.backoff?.baseMs ?? 1000;
    this.backoffMaxMs = opts?.backoff?.maxMs ?? 30_000;
    this.backoffJitter = opts?.backoff?.jitter ?? true;
  }

  /** Current backoff delay in ms (0 when connected or no failures). */
  currentBackoffMs(): number {
    return this._currentBackoffMs;
  }

  /** Advance backoff to the next exponential step. */
  incrementBackoff(): void {
    this.backoffAttempt++;
    const exponential = Math.min(
      this.backoffBaseMs * Math.pow(2, this.backoffAttempt - 1),
      this.backoffMaxMs,
    );
    this._currentBackoffMs = this.backoffJitter
      ? Math.round(exponential * (0.5 + Math.random() * 0.5))
      : exponential;
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

      this.socket = net.createConnection({ path: this.socketPath }, () => {
        this.connected = true;
        settled = true;
        this.connectPromise = null;
        this.resetBackoff();
        resolve();
      });

      this.socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf-8");
        this.processBuffer();
      });

      this.socket.on("error", (err: Error) => {
        this.connected = false;
        this.rejectAllPending(
          new CmuxSocketError(
            `Socket error: ${err.message}`,
            "connection_error",
          ),
        );
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(
            new CmuxSocketError(
              `Socket error: ${err.message}`,
              "connection_error",
            ),
          );
        }
      });

      this.socket.on("close", () => {
        this.connected = false;
        this.socket = null;
        // Reject all inflight requests — transport is gone
        this.rejectAllPending(
          new CmuxSocketError(
            "Socket closed unexpectedly",
            "connection_closed",
          ),
        );
      });
    });

    return this.connectPromise;
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
        if (this.isJsonLikeFrame(line)) {
          if (line.trimStart().startsWith("[") && this.pendingV1.length > 0) {
            this.resolveNextV1(line);
            continue;
          }
          this.rejectMalformedFrame(line, error);
        } else if (this.pendingV1.length > 0) {
          this.resolveNextV1(line);
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
    this.socket.write(entry.payload);
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

  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.assertInFlightCapacity();
    await this.ensureConnected();

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

      this.socket!.write(payload);
    });
  }

  async sendLine(command: string): Promise<string> {
    this.assertInFlightCapacity();
    await this.ensureConnected();

    const shouldWriteNow = this.pendingV1.length === 0;
    const payload = command + "\n";

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.pendingV1.findIndex((entry) => entry.timer === timer);
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
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
    this.connectPromise = null;
    this.rejectAllPending(
      new CmuxSocketError("Socket disconnected", "connection_closed"),
    );
  }

  isConnected(): boolean {
    return this.connected;
  }
}
