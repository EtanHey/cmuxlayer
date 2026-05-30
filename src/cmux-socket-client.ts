/**
 * cmux native socket client — connects to /tmp/cmux.sock directly.
 * Eliminates process spawning overhead from CLI shell-outs.
 *
 * Protocol: newline-delimited JSON (V2)
 * Request:  {"id":"<uuid>","method":"<method>","params":{...}}\n
 * Response: {"id":"<uuid>","ok":true,"result":{...}}\n
 *        or {"id":"<uuid>","ok":false,"error":{"code":"...","message":"..."}}\n
 */

import type {
  CmuxWorkspace,
  CmuxPaneSurfaces,
  CmuxPane,
  CmuxNewSplitResult,
  CmuxNewSurfaceResult,
  CmuxMoveSurfaceResult,
  CmuxReorderSurfaceResult,
  CmuxReadScreenResult,
  CmuxSendOptions,
  CmuxStatusEntry,
} from "./types.js";
import type { CmuxClient } from "./cmux-client.js";
import { normalizeKeyName } from "./key-names.js";
import { CmuxPersistentSocket } from "./cmux-persistent-socket.js";
import { CmuxSocketError } from "./cmux-socket-error.js";
import { DEFAULT_SOCKET_PATH } from "./cmux-socket-path.js";
export { CmuxSocketError } from "./cmux-socket-error.js";

// ── Configuration ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;
const V1_SAFE_VALUE_RE = /^(?!-)[A-Za-z0-9_./:@%+=#,-]+$/;

interface V1RawArg {
  raw: string;
}

type V1Arg = string | V1RawArg;

export interface CmuxSocketClientOptions {
  socketPath?: string;
  timeoutMs?: number;
  maxInFlight?: number;
  /** Password for socket access mode "password" */
  password?: string;
  /** CLI client fallback for V2 methods not supported by the daemon */
  cliFallback?: CmuxClient;
}

// ── The Client ─────────────────────────────────────────────────────────

export class CmuxSocketClient {
  private socketPath: string;
  private timeoutMs: number;
  private password?: string;
  private cliFallback?: CmuxClient;
  private transport: CmuxPersistentSocket;

  constructor(opts?: CmuxSocketClientOptions) {
    this.socketPath =
      opts?.socketPath ?? process.env.CMUX_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
    this.timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.password = opts?.password;
    this.cliFallback = opts?.cliFallback;
    this.transport = new CmuxPersistentSocket({
      socketPath: this.socketPath,
      timeoutMs: this.timeoutMs,
      maxInFlight: opts?.maxInFlight,
    });
  }

  private assertSupportedSendOptions(opts?: CmuxSendOptions): void {
    const unsupported = [
      opts?.chunk_size !== undefined ? "chunk_size" : null,
      opts?.chunk_delay_ms !== undefined ? "chunk_delay_ms" : null,
    ].filter((value): value is string => value !== null);

    if (unsupported.length > 0) {
      throw new CmuxSocketError(
        `CmuxSocketClient.send does not support ${unsupported.join(", ")}; chunking is handled by send_input in the server layer`,
        "unsupported_send_option",
      );
    }
  }

  /**
   * Send a V1 plain-text command. Some cmux operations (set_status,
   * set_progress, log) only exist as V1 commands.
   */
  private sendV1(command: string): Promise<string> {
    return this.transport.sendLine(command);
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
    if (this.password) {
      await this.transport.call("auth.login", { password: this.password });
      this.password = undefined;
    }
    return this.transport.call<T>(method, params);
  }

  // ── Public API (mirrors CmuxClient interface) ──────────────────────

  async ping(): Promise<boolean> {
    const result = await this.call<{ pong: boolean }>("system.ping");
    return result.pong === true;
  }

  async listWorkspaces(): Promise<{ workspaces: CmuxWorkspace[] }> {
    return this.call("workspace.list");
  }

  async selectWorkspace(workspace: string): Promise<void> {
    try {
      await this.call("workspace.select", { workspace_id: workspace });
    } catch (e) {
      if (this.isMethodNotFound(e) && this.cliFallback) {
        return this.cliFallback.selectWorkspace(workspace);
      }
      throw e;
    }
  }

  async createWorkspace(
    title: string,
  ): Promise<{ workspace: string; title: string }> {
    try {
      const result = await this.call<Record<string, unknown>>(
        "workspace.create",
        { title },
      );
      return {
        workspace:
          (result.workspace_ref as string) ?? (result.workspace as string) ?? "",
        title: (result.title as string) ?? title,
      };
    } catch (e) {
      if (this.isMethodNotFound(e) && this.cliFallback) {
        return this.cliFallback.createWorkspace(title);
      }
      throw e;
    }
  }

  async listPaneSurfaces(opts?: {
    workspace?: string;
    pane?: string;
  }): Promise<CmuxPaneSurfaces> {
    const params: Record<string, unknown> = {};
    if (opts?.workspace) params.workspace_id = opts.workspace;
    if (opts?.pane) params.pane_id = opts.pane;
    const result = (await this.call(
      "surface.list",
      params,
    )) as CmuxPaneSurfaces;
    // The cmux socket omits pane_ref from the response; inject it from the
    // known input so describePaneLayouts can match panes to their surfaces.
    if (opts?.pane && !result.pane_ref) {
      result.pane_ref = opts.pane;
    }
    return result;
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

      try {
        const result = await this.call<Record<string, unknown>>(
          "pane.create",
          params,
        );
        return this.mapSplitResult(result, "browser");
      } catch (e) {
        if (this.isMethodNotFound(e) && this.cliFallback) {
          return this.cliFallback.newSplit(direction, opts);
        }
        throw e;
      }
    }

    if (opts?.url) {
      throw new CmuxSocketError("Terminal splits do not accept a browser URL");
    }

    const params: Record<string, unknown> = { direction };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    if (opts?.surface) params.surface_id = opts.surface;
    if (opts?.pane) params.pane_id = opts.pane;

    try {
      const result = await this.call<Record<string, unknown>>(
        "pane.split",
        params,
      );
      return this.mapSplitResult(result, "terminal");
    } catch (e) {
      if (this.isMethodNotFound(e) && this.cliFallback) {
        return this.cliFallback.newSplit(direction, opts);
      }
      throw e;
    }
  }

  async newSurface(opts: {
    pane: string;
    type?: "terminal" | "browser";
    workspace?: string;
    title?: string;
    url?: string;
  }): Promise<CmuxNewSurfaceResult> {
    if (!this.cliFallback) {
      throw new CmuxSocketError(
        "new-surface is only available through the CLI fallback",
      );
    }
    return this.cliFallback.newSurface(opts);
  }

  async moveSurface(opts: {
    surface: string;
    pane?: string;
    workspace?: string;
    before?: string;
    after?: string;
    index?: number;
    focus?: boolean;
  }): Promise<CmuxMoveSurfaceResult> {
    if (!this.cliFallback) {
      throw new CmuxSocketError(
        "move-surface is only available through the CLI fallback",
      );
    }
    return this.cliFallback.moveSurface(opts);
  }

  async reorderSurface(opts: {
    surface: string;
    index?: number;
    before?: string;
    after?: string;
  }): Promise<CmuxReorderSurfaceResult> {
    if (!this.cliFallback) {
      throw new CmuxSocketError(
        "reorder-surface is only available through the CLI fallback",
      );
    }
    return this.cliFallback.reorderSurface(opts);
  }

  async send(
    surface: string,
    text: string,
    opts?: CmuxSendOptions,
  ): Promise<void> {
    this.assertSupportedSendOptions(opts);
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
      key: normalizeKeyName(key),
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
    // Use V2 tab.action — the V1 protocol has no rename command.
    // The old V1 "rename_tab" silently failed with "Unknown command".
    const params: Record<string, unknown> = {
      action: "rename",
      surface_id: surface,
      title,
    };
    if (opts?.workspace) params.workspace_id = opts.workspace;
    await this.call("tab.action", params);
  }

  async notify(opts?: {
    title?: string;
    subtitle?: string;
    body?: string;
    workspace?: string;
    surface?: string;
  }): Promise<void> {
    const args: V1Arg[] = [];
    if (opts?.title) {
      args.push(this.rawV1Arg("--title"), opts.title);
    }
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
        this.rawV1Arg(
          `--tab=${await this.resolveWorkspaceTabId(opts.workspace)}`,
        ),
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
        this.rawV1Arg(
          `--tab=${await this.resolveWorkspaceTabId(opts.workspace)}`,
        ),
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
    try {
      await this.call("surface.close", params);
    } catch (e) {
      if (this.isMethodNotFound(e) && this.cliFallback) {
        return this.cliFallback.closeSurface(surface, opts);
      }
      throw e;
    }
  }

  async listStatus(opts?: { workspace?: string }): Promise<CmuxStatusEntry[]> {
    const args: V1Arg[] = [];
    if (opts?.workspace) {
      args.push(
        this.rawV1Arg(
          `--tab=${await this.resolveWorkspaceTabId(opts.workspace)}`,
        ),
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

  disconnect(): void {
    this.transport.disconnect();
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

  private isMethodNotFound(e: unknown): boolean {
    return e instanceof CmuxSocketError && e.code === "method_not_found";
  }

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
