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
const REQUEST_TIMEOUT_MS = 10_000;
const V1_SAFE_VALUE_RE = /^(?!-)[A-Za-z0-9_./:@%+=#,-]+$/;

interface V1RawArg {
  raw: string;
}

type V1Arg = string | V1RawArg;

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

      let authId: string | null = null;

      const socket = net.createConnection({ path: this.socketPath }, () => {
        if (this.password) {
          // Send auth first — payload is deferred until auth succeeds
          authId = crypto.randomUUID();
          const authReq: V2Request = {
            id: authId,
            method: "auth.login",
            params: { password: this.password },
          };
          socket.write(JSON.stringify(authReq) + "\n");
        } else {
          socket.write(payload);
        }
      });

      let buffer = "";
      let authDone = !this.password;
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
            if (!authDone && authId && parsed.id === authId) {
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
                return;
              }
              // Auth succeeded — now send the actual request
              socket.write(payload);
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
        // Reject immediately if we haven't received a response
        reject(
          new CmuxSocketError(
            "Socket closed before receiving response",
            "connection_closed",
          ),
        );
      });
    });
  }

  /**
   * Send a V1 plain-text command. Some cmux operations (set_status,
   * set_progress, log, rename_tab) only exist as V1 commands.
   */
  private sendV1(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const payload = command + "\n";

      const socket = net.createConnection({ path: this.socketPath }, () => {
        socket.write(payload);
      });

      let buffer = "";
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(
          new CmuxSocketError(
            `Timeout after ${this.timeoutMs}ms waiting for V1: ${command.split(" ")[0]}`,
            "timeout",
          ),
        );
      }, this.timeoutMs);

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        if (buffer.includes("\n")) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(buffer.trim());
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
        if (buffer.trim()) {
          resolve(buffer.trim());
        } else {
          reject(
            new CmuxSocketError(
              "Socket closed before receiving response",
              "connection_closed",
            ),
          );
        }
      });
    });
  }

  private quoteV1Arg(arg: string): string {
    if (!arg) return '""';
    if (V1_SAFE_VALUE_RE.test(arg)) return arg;
    return JSON.stringify(arg);
  }

  private rawV1Arg(arg: string): V1RawArg {
    return { raw: arg };
  }

  private sendV1Args(command: string, args: V1Arg[] = []): Promise<string> {
    return this.sendV1(
      [
        command,
        ...args.map((arg) =>
          typeof arg === "string" ? this.quoteV1Arg(arg) : arg.raw,
        ),
      ].join(" "),
    );
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
    const workspace = await this.resolveWorkspace(surface, opts?.workspace);
    const params: Record<string, unknown> = {
      surface_id: surface,
      text,
      workspace_id: workspace,
    };
    await this.call("surface.send_text", params);
  }

  async sendKey(
    surface: string,
    key: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const workspace = await this.resolveWorkspace(surface, opts?.workspace);
    const params: Record<string, unknown> = {
      surface_id: surface,
      key,
      workspace_id: workspace,
    };
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
    const workspace = await this.resolveWorkspace(surface, opts?.workspace);
    const params: Record<string, unknown> = {
      surface_id: surface,
      workspace_id: workspace,
    };
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
    const args: V1Arg[] = [this.rawV1Arg("--surface"), surface];
    if (opts?.workspace) {
      args.push(this.rawV1Arg("--workspace"), opts.workspace);
    }
    args.push(title);
    await this.sendV1Args("rename_tab", args);
  }

  async notify(opts?: {
    title?: string;
    subtitle?: string;
    body?: string;
    workspace?: string;
    surface?: string;
  }): Promise<void> {
    const args: V1Arg[] = [
      this.rawV1Arg("--title"),
      opts?.title ?? "Notification",
    ];
    if (opts?.subtitle) args.push(this.rawV1Arg("--subtitle"), opts.subtitle);
    if (opts?.body) args.push(this.rawV1Arg("--body"), opts.body);
    if (opts?.workspace) {
      args.push(this.rawV1Arg("--workspace"), opts.workspace);
    }
    if (opts?.surface) {
      args.push(this.rawV1Arg("--surface"), opts.surface);
    }
    await this.sendV1Args("notify", args);
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
    const args: V1Arg[] = [key, value];
    if (opts?.icon) args.push(this.rawV1Arg("--icon"), opts.icon);
    if (opts?.color) args.push(this.rawV1Arg("--color"), opts.color);
    const tabId = await this.resolveSidebarTabId(opts);
    if (tabId) args.push(this.rawV1Arg(`--tab=${tabId}`));
    await this.sendV1Args("set_status", args);
  }

  async clearStatus(key: string, opts?: { workspace?: string }): Promise<void> {
    const args: V1Arg[] = [key];
    if (opts?.workspace) {
      args.push(
        this.rawV1Arg(`--tab=${await this.resolveWorkspaceTabId(opts.workspace)}`),
      );
    }
    await this.sendV1Args("clear_status", args);
  }

  async setProgress(
    value: number,
    opts?: {
      label?: string;
      workspace?: string;
      surface?: string;
    },
  ): Promise<void> {
    const args: V1Arg[] = [String(value)];
    if (opts?.label) args.push(this.rawV1Arg("--label"), opts.label);
    const tabId = await this.resolveSidebarTabId(opts);
    if (tabId) args.push(this.rawV1Arg(`--tab=${tabId}`));
    await this.sendV1Args("set_progress", args);
  }

  async clearProgress(opts?: { workspace?: string }): Promise<void> {
    const args: V1Arg[] = [];
    if (opts?.workspace) {
      args.push(
        this.rawV1Arg(`--tab=${await this.resolveWorkspaceTabId(opts.workspace)}`),
      );
    }
    await this.sendV1Args("clear_progress", args);
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
    const args: V1Arg[] = [];
    if (opts?.level) args.push(this.rawV1Arg("--level"), opts.level);
    if (opts?.source) args.push(this.rawV1Arg("--source"), opts.source);
    const tabId = await this.resolveSidebarTabId(opts);
    if (tabId) args.push(this.rawV1Arg(`--tab=${tabId}`));
    args.push(this.rawV1Arg("--"), message);
    await this.sendV1Args("log", args);
  }

  async closeSurface(
    surface: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const workspace = await this.resolveWorkspace(surface, opts?.workspace);
    const params: Record<string, unknown> = {
      surface_id: surface,
      workspace_id: workspace,
    };
    await this.call("surface.close", params);
  }

  async listStatus(opts?: { workspace?: string }): Promise<CmuxStatusEntry[]> {
    const args: V1Arg[] = [];
    if (opts?.workspace) {
      args.push(
        this.rawV1Arg(`--tab=${await this.resolveWorkspaceTabId(opts.workspace)}`),
      );
    }
    const raw = await this.sendV1Args("list_status", args);
    if (!raw || raw === "OK") return [];
    try {
      return JSON.parse(raw) as CmuxStatusEntry[];
    } catch {
      // Parse key=value format
      return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const match = line.match(
            /^([^=]+)=(.*?)(?:\s+icon=([^\s]+))?(?:\s+color=(#[0-9a-fA-F]{6}))?$/,
          );
          if (!match) return { key: line, value: "" };
          const [, key, value, icon, color] = match;
          return {
            key: key ?? "",
            value: value?.trim() ?? "",
            ...(icon ? { icon } : {}),
            ...(color ? { color } : {}),
          };
        });
    }
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
    const [subcommand, ...rest] = args;
    const method = `browser.${subcommand ?? "status"}`;
    const params: Record<string, unknown> = {};
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg?.startsWith("--")) {
        const key = arg.replace(/^--/, "");
        const next = rest[i + 1];
        if (next && !next.startsWith("--")) {
          params[key] = next;
          i++; // skip consumed value
        } else {
          params[key] = true;
        }
      }
    }
    return this.call(method, params);
  }

  /**
   * Resolve workspace for a surface ref when workspace is not provided.
   * V2 protocol requires workspace_id for surface operations — unlike
   * the CLI which resolves internally.
   */
  private async resolveWorkspace(
    surface: string,
    workspace?: string,
  ): Promise<string> {
    if (workspace) return workspace;

    const { workspaces } = await this.listWorkspaces();
    for (const ws of workspaces) {
      const surfaces = await this.listPaneSurfaces({ workspace: ws.ref });
      if (surfaces.surfaces.some((s) => s.ref === surface)) {
        return ws.ref;
      }
    }
    throw new CmuxSocketError(
      `Unable to resolve workspace for surface ${surface}`,
      "not_found",
    );
  }

  private async resolveSidebarTabId(opts?: {
    workspace?: string;
    surface?: string;
  }): Promise<string | undefined> {
    const workspace =
      opts?.workspace ??
      (opts?.surface
        ? (await this.identify(opts.surface)).caller?.workspace_ref
        : undefined);
    if (!workspace) return undefined;
    return this.resolveWorkspaceTabId(workspace);
  }

  private async resolveWorkspaceTabId(workspace: string): Promise<string> {
    const { workspaces } = await this.listWorkspaces();
    const match = workspaces.find(
      (candidate) => candidate.ref === workspace || candidate.id === workspace,
    );

    if (match?.id) return match.id;
    if (this.looksLikeUuid(workspace)) return workspace;

    throw new CmuxSocketError(
      `Unable to resolve tab id for workspace ${workspace}`,
      "not_found",
    );
  }

  private looksLikeUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
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
