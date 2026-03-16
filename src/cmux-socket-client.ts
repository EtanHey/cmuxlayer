/**
 * cmux native socket client — connects to /tmp/cmux.sock directly.
 * Eliminates process spawning overhead from CLI shell-outs.
 *
 * Protocol: newline-delimited JSON (V2)
 * Request:  {"id":"<uuid>","method":"<method>","params":{...}}\n
 * Response: {"id":"<uuid>","ok":true,"result":{...}}\n
 *        or {"id":"<uuid>","ok":false,"error":{"code":"...","message":"..."}}\n
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import type {
  CmuxWorkspace,
  CmuxPaneSurfaces,
  CmuxPane,
  CmuxNewSplitResult,
  CmuxReadScreenResult,
  CmuxStatusEntry,
} from "./types.js";

// ── Configuration ──────────────────────────────────────────────────────

const DEFAULT_SOCKET_PATH = "/tmp/cmux.sock";
const DEBUG_SOCKET_PATH = "/tmp/cmux-debug.sock";
const REQUEST_TIMEOUT_MS = 10_000;

export interface CmuxSocketClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  /** Password for socket access mode "password" */
  password?: string;
}

// ── Socket-level errors ────────────────────────────────────────────────

export class CmuxSocketError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "CmuxSocketError";
  }
}

// ── V2 JSON-RPC types ──────────────────────────────────────────────────

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

// ── The Client ─────────────────────────────────────────────────────────

export class CmuxSocketClient {
  private socketPath: string;
  private timeoutMs: number;
  private password?: string;

  constructor(opts?: CmuxSocketClientOptions) {
    this.socketPath =
      opts?.socketPath ?? process.env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
    this.timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.password = opts?.password;
  }

  // ── Low-level: send a V2 request, get a V2 response ────────────────

  private sendV2(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<V2Response> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const request: V2Request = { id, method, params };
      const payload = JSON.stringify(request) + "\n";

      const socket = net.createConnection({ path: this.socketPath }, () => {
        // If password auth is needed, send it first
        if (this.password) {
          const authReq: V2Request = {
            id: crypto.randomUUID(),
            method: "auth.login",
            params: { password: this.password },
          };
          socket.write(JSON.stringify(authReq) + "\n");
        }

        socket.write(payload);
      });

      let buffer = "";
      let authDone = !this.password; // skip auth parsing if no password
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(
          new CmuxSocketError(
            `Timeout after ${this.timeoutMs}ms waiting for ${method}`,
            "timeout",
          ),
        );
      }, this.timeoutMs);

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");

        // Process all complete lines
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);

          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line) as V2Response;

            // If we sent an auth request, consume its response first
            if (!authDone) {
              authDone = true;
              if (!parsed.ok) {
                clearTimeout(timeout);
                socket.destroy();
                reject(
                  new CmuxSocketError(
                    `Auth failed: ${parsed.error?.message ?? "unknown"}`,
                    "auth_failed",
                  ),
                );
              }
              continue;
            }

            // This is our actual response
            if (parsed.id === id) {
              clearTimeout(timeout);
              socket.destroy();
              resolve(parsed);
            }
          } catch {
            // Non-JSON line (v1 fallback?) — skip
          }
        }
      });

      socket.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(
          new CmuxSocketError(
            `Socket error: ${err.message}`,
            "connection_error",
          ),
        );
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        // If we haven't resolved yet, we got disconnected
      });
    });
  }

  /**
   * Execute a V2 method and return the result. Throws on error.
   */
  private async call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await this.sendV2(method, params);

    if (!response.ok) {
      const errCode = response.error?.code ?? "unknown";
      const errMsg = response.error?.message ?? "Unknown error";
      throw new CmuxSocketError(`${errCode}: ${errMsg}`, errCode);
    }

    return (response.result ?? {}) as T;
  }

  // ── Public API (mirrors CmuxClient interface) ──────────────────────

  async ping(): Promise<boolean> {
    const result = await this.call<{ pong: boolean }>("system.ping");
    return result.pong === true;
  }

  async listWorkspaces(): Promise<{ workspaces: CmuxWorkspace[] }> {
    return this.call("workspace.list");
  }

  async listPaneSurfaces(opts?: {
    workspace?: string;
    pane?: string;
  }): Promise<CmuxPaneSurfaces> {
    const params: Record<string, unknown> = {};
    if (opts?.workspace) params.workspace_id = opts.workspace;
    if (opts?.pane) params.pane_id = opts.pane;
    return this.call("surface.list", params);
  }

  async listPanes(opts?: { workspace?: string }): Promise<{
    workspace_ref: string;
    window_ref: string;
    panes: CmuxPane[];
  }> {
    const params: Record<string, unknown> = {};
    if (opts?.workspace) params.workspace_id = opts.workspace;
    return this.call("pane.list", params);
  }

  async newSplit(
    direction: string,
    opts?: {
      workspace?: string;
      surface?: string;
      pane?: string;
      type?: string;
      url?: string;
      title?: string;
      focus?: boolean;
    },
  ): Promise<CmuxNewSplitResult> {
    if (opts?.focus === false) {
      throw new CmuxSocketError(
        "cmux does not support creating unfocused splits",
      );
    }

    if (opts?.type === "browser") {
      if (opts.surface || opts.pane) {
        throw new CmuxSocketError(
          "Browser splits cannot target an existing surface or pane",
        );
      }

      const params: Record<string, unknown> = {
        type: "browser",
        direction,
      };
      if (opts.workspace) params.workspace_id = opts.workspace;
      if (opts.url) params.url = opts.url;

      const result = await this.call<Record<string, unknown>>(
        "pane.create",
        params,
      );
      return this.mapSplitResult(result, "browser");
    }

    if (opts?.url) {
      throw new CmuxSocketError("Terminal splits do not accept a browser URL");
    }

    const params: Record<string, unknown> = { direction };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    if (opts?.surface) params.surface_id = opts.surface;
    if (opts?.pane) params.pane_id = opts.pane;

    const result = await this.call<Record<string, unknown>>(
      "pane.split",
      params,
    );
    return this.mapSplitResult(result, "terminal");
  }

  async send(
    surface: string,
    text: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const params: Record<string, unknown> = {
      surface_id: surface,
      text,
    };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    await this.call("surface.send_text", params);
  }

  async sendKey(
    surface: string,
    key: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const params: Record<string, unknown> = {
      surface_id: surface,
      key,
    };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    await this.call("surface.send_key", params);
  }

  async readScreen(
    surface: string,
    opts?: {
      workspace?: string;
      lines?: number;
      scrollback?: boolean;
    },
  ): Promise<CmuxReadScreenResult> {
    const params: Record<string, unknown> = { surface_id: surface };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    if (opts?.lines) params.lines = opts.lines;
    if (opts?.scrollback) params.scrollback = true;

    const result = await this.call<Record<string, unknown>>(
      "surface.read_text",
      params,
    );

    return {
      surface: (result.surface_ref as string) ?? surface,
      text: result.text as string,
      lines: (result.lines as number) ?? 0,
      scrollback_used: opts?.scrollback ?? false,
    };
  }

  async renameTab(
    surface: string,
    title: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const params: Record<string, unknown> = {
      surface_id: surface,
      title,
    };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    await this.call("surface.rename", params);
  }

  async setStatus(
    key: string,
    value: string,
    opts?: {
      icon?: string;
      color?: string;
      workspace?: string;
      surface?: string;
    },
  ): Promise<void> {
    const params: Record<string, unknown> = { key, value };
    if (opts?.icon) params.icon = opts.icon;
    if (opts?.color) params.color = opts.color;
    const workspace =
      opts?.workspace ??
      (opts?.surface
        ? (await this.identify(opts.surface)).caller?.workspace_ref
        : undefined);
    if (workspace) params.workspace_id = workspace;
    await this.call("status.set", params);
  }

  async clearStatus(key: string, opts?: { workspace?: string }): Promise<void> {
    const params: Record<string, unknown> = { key };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    await this.call("status.clear", params);
  }

  async setProgress(
    value: number,
    opts?: {
      label?: string;
      workspace?: string;
      surface?: string;
    },
  ): Promise<void> {
    const params: Record<string, unknown> = { value };
    if (opts?.label) params.label = opts.label;
    const workspace =
      opts?.workspace ??
      (opts?.surface
        ? (await this.identify(opts.surface)).caller?.workspace_ref
        : undefined);
    if (workspace) params.workspace_id = workspace;
    await this.call("progress.set", params);
  }

  async clearProgress(opts?: { workspace?: string }): Promise<void> {
    const params: Record<string, unknown> = {};
    if (opts?.workspace) params.workspace_id = opts.workspace;
    await this.call("progress.clear", params);
  }

  async log(
    message: string,
    opts?: {
      level?: "info" | "progress" | "success" | "warning" | "error";
      source?: string;
      workspace?: string;
      surface?: string;
    },
  ): Promise<void> {
    const params: Record<string, unknown> = { message };
    if (opts?.level) params.level = opts.level;
    if (opts?.source) params.source = opts.source;
    const workspace =
      opts?.workspace ??
      (opts?.surface
        ? (await this.identify(opts.surface)).caller?.workspace_ref
        : undefined);
    if (workspace) params.workspace_id = workspace;
    await this.call("notification.create", params);
  }

  async closeSurface(
    surface: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const params: Record<string, unknown> = { surface_id: surface };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    await this.call("surface.close", params);
  }

  async listStatus(opts?: { workspace?: string }): Promise<CmuxStatusEntry[]> {
    const params: Record<string, unknown> = {};
    if (opts?.workspace) params.workspace_id = opts.workspace;
    const result = await this.call<{ entries: CmuxStatusEntry[] }>(
      "status.list",
      params,
    );
    return result.entries ?? [];
  }

  async identify(surface: string): Promise<{
    caller?: {
      workspace_ref?: string;
      surface_ref?: string;
      pane_ref?: string;
    };
    focused?: {
      workspace_ref?: string;
      surface_ref?: string;
      pane_ref?: string;
    };
  }> {
    return this.call("system.identify", { surface_id: surface });
  }

  async browser(args: string[]): Promise<unknown> {
    // Browser commands map to browser.* methods
    // First arg is the browser subcommand
    const [subcommand, ...rest] = args;
    const method = `browser.${subcommand ?? "status"}`;
    // Parse remaining args as key-value pairs
    const params: Record<string, unknown> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i]?.replace(/^--/, "") ?? "";
      params[key] = rest[i + 1] ?? true;
    }
    return this.call(method, params);
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private mapSplitResult(
    parsed: Record<string, unknown>,
    fallbackType: "terminal" | "browser",
  ): CmuxNewSplitResult {
    return {
      workspace:
        (parsed.workspace_ref as string) ?? (parsed.workspace as string) ?? "",
      surface:
        (parsed.surface_ref as string) ?? (parsed.surface as string) ?? "",
      pane: (parsed.pane_ref as string) ?? (parsed.pane as string) ?? "",
      title: (parsed.title as string) ?? "",
      type: (parsed.type as "terminal" | "browser") ?? fallbackType,
    };
  }
}

// ── Persistent connection pool (optional optimization) ──────────────

/**
 * A persistent socket connection that stays open across multiple requests.
 * Useful for high-frequency operations like sidebar sweeps.
 *
 * Unlike CmuxSocketClient (which opens/closes a connection per request),
 * this keeps a single socket open and multiplexes requests over it.
 */
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
      this.socket = net.createConnection({ path: this.socketPath }, () => {
        this.connected = true;
        resolve();
      });

      this.socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf-8");
        this.processBuffer();
      });

      this.socket.on("error", (err: Error) => {
        this.connected = false;
        // Reject all pending requests
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
        reject(
          new CmuxSocketError(
            `Socket error: ${err.message}`,
            "connection_error",
          ),
        );
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
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }
}
