/**
 * Persistent socket connection for high-frequency cmux operations.
 *
 * Unlike CmuxSocketClient (which opens/closes a connection per request),
 * this keeps a single socket open and multiplexes requests over it.
 * Useful for sidebar sweeps (3+ calls every 5 seconds).
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import {
  CmuxSocketError,
  type CmuxSocketClientOptions,
} from "./cmux-socket-client.js";

const DEFAULT_SOCKET_PATH = "/tmp/cmux.sock";
const REQUEST_TIMEOUT_MS = 10_000;

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
  private connected = false;
  private timeoutMs: number;

  constructor(opts?: CmuxSocketClientOptions) {
    this.socketPath =
      opts?.socketPath ?? process.env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
    this.timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      let settled = false;

      this.socket = net.createConnection({ path: this.socketPath }, () => {
        this.connected = true;
        settled = true;
        resolve();
      });

      this.socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf-8");
        this.processBuffer();
      });

      this.socket.on("error", (err: Error) => {
        this.connected = false;
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(
            new CmuxSocketError(
              `Socket error: ${err.message}`,
              "connection_error",
            ),
          );
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
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
      });
    });
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line) as V2Response;
        const entry = this.pending.get(parsed.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(parsed.id);
          entry.resolve(parsed);
        }
      } catch {
        // Skip non-JSON lines
      }
    }
  }

  async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.connected || !this.socket) {
      await this.connect();
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

      this.socket!.write(payload);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new CmuxSocketError("Socket disconnected", "disconnected"));
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
