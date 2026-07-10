/**
 * cmux CLI client — the ONLY place that knows shell command details.
 * All handlers go through this boundary.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type {
  CmuxPane,
  CmuxWorkspace,
  CmuxPaneSurfaces,
  CmuxNewSplitResult,
  CmuxNewSurfaceResult,
  CmuxMoveSurfaceResult,
  CmuxReorderSurfaceResult,
  CmuxReadScreenResult,
  CmuxSendOptions,
  CmuxStatusEntry,
  CmuxTerminalMetadata,
} from "./types.js";
import { normalizeKeyName } from "./key-names.js";

const execFileAsync = promisify(execFile);
const STANDARD_BUNDLED_CMUX =
  "/Applications/cmux.app/Contents/Resources/bin/cmux";

function cleanAbsolutePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  return trimmed;
}

function cleanAbsoluteOrCommand(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export interface ExecFn {
  (
    cmd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; stderr: string }>;
}

interface CmuxClientOptions {
  exec?: ExecFn;
  bin?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
}

interface CmuxIdentifyResult {
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
}

export class CmuxClient {
  private exec?: ExecFn;
  private bin?: string;
  private env?: NodeJS.ProcessEnv;
  private existsSync: (path: string) => boolean;

  constructor(opts?: CmuxClientOptions) {
    this.exec = opts?.exec;
    this.bin = opts?.bin;
    this.env = opts?.env;
    this.existsSync = opts?.existsSync ?? fs.existsSync;
  }

  setEnv(env: NodeJS.ProcessEnv | undefined): void {
    this.env = env;
  }

  private async run(args: string[]): Promise<string> {
    try {
      // Pin every CLI-fallback exec to the instance env (CMUX_SOCKET_PATH) so
      // the `cmux` subprocess cannot inherit an ambient socket path pointing at
      // a DIFFERENT instance (e.g. prod) and silently target the wrong one.
      // The env is forwarded on BOTH the injected-exec path and the real
      // execFile path; dropping it on either is collab O2 #8.
      const env = this.env;
      const bin = this.resolveBin(env);
      const { stdout } = this.exec
        ? await this.exec(
            bin,
            ["--json", ...args],
            ...(env ? ([env] as const) : ([] as const)),
          )
        : await execFileAsync(bin, ["--json", ...args], {
            ...(env ? { env } : {}),
          });
      return stdout;
    } catch (error) {
      throw this.normalizeCliError(args, error);
    }
  }

  private resolveBin(env?: NodeJS.ProcessEnv): string {
    const explicitBin = cleanAbsoluteOrCommand(this.bin);
    if (explicitBin) return explicitBin;

    const envBundled = cleanAbsolutePath(env?.CMUX_BUNDLED_CLI_PATH);
    if (envBundled) return envBundled;

    const processBundled = cleanAbsolutePath(
      process.env.CMUX_BUNDLED_CLI_PATH,
    );
    if (processBundled) return processBundled;

    if (this.existsSync(STANDARD_BUNDLED_CMUX)) {
      return STANDARD_BUNDLED_CMUX;
    }

    return "cmux";
  }

  private parse<T>(raw: string, command: string): T {
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`cmux returned invalid JSON for ${command}: ${reason}`);
    }
  }

  private parseBrowserOutput(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }

  private parseStatusOutput(raw: string): CmuxStatusEntry[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return this.parse(trimmed, "list-status");
    }

    return trimmed.split(/\r?\n/).map((line) => {
      const match = line.match(
        /^([^=]+)=(.*?)(?:\s+icon=([^\s]+))?(?:\s+color=(#[0-9a-fA-F]{6}))?$/,
      );
      if (!match) {
        throw new Error(`cmux returned an unparseable status entry: ${line}`);
      }

      const [, key, value, icon, color] = match;
      return {
        key,
        value: value.trim(),
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
      };
    });
  }

  private normalizeCliError(args: string[], error: unknown): Error {
    if (!(error instanceof Error)) {
      return new Error(`cmux ${args[0]} failed: ${String(error)}`);
    }

    const details = [];
    const stderr =
      "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const code = "code" in error ? error.code : undefined;

    if (stderr) details.push(stderr);
    if (code !== undefined && code !== null)
      details.push(`exit ${String(code)}`);

    const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
    return new Error(`cmux ${args[0]} failed: ${error.message}${suffix}`);
  }

  private assertSupportedSendOptions(opts?: CmuxSendOptions): void {
    const unsupported = [
      opts?.chunk_size !== undefined ? "chunk_size" : null,
      opts?.chunk_delay_ms !== undefined ? "chunk_delay_ms" : null,
    ].filter((value): value is string => value !== null);

    if (unsupported.length > 0) {
      throw new Error(
        `CmuxClient.send does not support ${unsupported.join(", ")}; chunking is handled by send_input in the server layer`,
      );
    }
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

  private mapSurfaceResult(
    parsed: Record<string, unknown>,
    fallbackType: "terminal" | "browser",
  ): CmuxNewSurfaceResult {
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

  private mapMoveSurfaceResult(
    parsed: Record<string, unknown>,
  ): CmuxMoveSurfaceResult {
    return {
      ok: (parsed.ok as boolean) ?? true,
      workspace:
        (parsed.workspace_ref as string) ?? (parsed.workspace as string) ?? "",
      surface:
        (parsed.surface_ref as string) ?? (parsed.surface as string) ?? "",
      pane: (parsed.pane_ref as string) ?? (parsed.pane as string) ?? "",
    };
  }

  private mapReorderSurfaceResult(
    parsed: Record<string, unknown>,
  ): CmuxReorderSurfaceResult {
    return {
      ok: (parsed.ok as boolean) ?? true,
      surface:
        (parsed.surface_ref as string) ?? (parsed.surface as string) ?? "",
    };
  }

  private pasteBufferName(surface: string, workspace?: string): string {
    const raw = `cmuxlayer-${workspace ?? "global"}-${surface}`;
    const safe = raw.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 120);
    return `${safe || "cmuxlayer-buffer"}-${randomUUID()}`;
  }

  private async resolveWorkspaceFromSurface(surface: string): Promise<string> {
    const identified = await this.identify(surface);
    const workspace =
      identified.caller?.workspace_ref ?? identified.focused?.workspace_ref;
    if (!workspace) {
      throw new Error(`Unable to resolve workspace for surface ${surface}`);
    }
    return workspace;
  }

  async listWorkspaces(): Promise<{ workspaces: CmuxWorkspace[] }> {
    const raw = await this.run(["list-workspaces"]);
    return this.parse(raw, "list-workspaces");
  }

  async listPaneSurfaces(opts?: {
    workspace?: string;
    pane?: string;
  }): Promise<CmuxPaneSurfaces> {
    const args = ["list-pane-surfaces"];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    if (opts?.pane) args.push("--pane", opts.pane);
    const raw = await this.run(args);
    return this.parse(raw, "list-pane-surfaces");
  }

  async listPanes(opts?: { workspace?: string }): Promise<{
    workspace_ref: string;
    window_ref: string;
    panes: CmuxPane[];
  }> {
    const args = ["list-panes"];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    const raw = await this.run(args);
    return this.parse(raw, "list-panes");
  }

  async listTerminalMetadata(): Promise<{
    terminals: CmuxTerminalMetadata[];
  }> {
    const raw = await this.run(["debug-terminals"]);
    const parsed = this.parse<{ terminals?: CmuxTerminalMetadata[] }>(
      raw,
      "debug-terminals",
    );
    return { terminals: parsed.terminals ?? [] };
  }

  private async resolvePaneAnchorSurface(opts: {
    workspace?: string;
    pane: string;
  }): Promise<string | undefined> {
    const paneSurfaces = await this.listPaneSurfaces({
      workspace: opts.workspace,
      pane: opts.pane,
    });
    const surfaces = paneSurfaces.surfaces ?? [];
    return surfaces.find((surface) => surface.selected)?.ref ?? surfaces[0]?.ref;
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
      throw new Error("cmux does not support creating unfocused splits");
    }

    if (opts?.type === "browser") {
      if (opts.surface || opts.pane) {
        throw new Error(
          "Browser splits cannot target an existing surface or pane",
        );
      }

      const args = ["new-pane", "--type", "browser", "--direction", direction];
      if (opts.workspace) args.push("--workspace", opts.workspace);
      if (opts.url) args.push("--url", opts.url);

      const raw = await this.run(args);
      const parsed = this.parse<Record<string, unknown>>(raw, "new-pane");
      return this.mapSplitResult(parsed, "browser");
    }

    if (opts?.url) {
      throw new Error("Terminal splits do not accept a browser URL");
    }

    const args = ["new-split", direction];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    const anchorSurface =
      opts?.surface ??
      (opts?.pane
        ? await this.resolvePaneAnchorSurface({
            workspace: opts.workspace,
            pane: opts.pane,
          })
        : undefined);
    // AIDEV-NOTE(2026-06-01): raw cmux CLI reproduces
    // `new-split --panel <pane>` failing with "Surface not found" after a cmux
    // app update. Anchor terminal splits through a surface in the target pane;
    // `new-surface --pane` is unaffected and intentionally stays as-is below.
    if (anchorSurface) args.push("--surface", anchorSurface);
    const raw = await this.run(args);
    const parsed = this.parse<Record<string, unknown>>(raw, "new-split");
    return this.mapSplitResult(parsed, "terminal");
  }

  async newSurface(opts: {
    pane: string;
    type?: "terminal" | "browser";
    workspace?: string;
    title?: string;
    url?: string;
  }): Promise<CmuxNewSurfaceResult> {
    if (opts.type !== "browser" && opts.url) {
      throw new Error("Terminal surfaces do not accept a browser URL");
    }

    // AIDEV-NOTE: cmux new-surface does not expose a title flag. Titles are
    // applied by the server/tool layer via renameTab after creation, matching
    // the existing new_split behavior.
    const args = ["new-surface", "--pane", opts.pane];
    if (opts.type) args.push("--type", opts.type);
    if (opts.workspace) args.push("--workspace", opts.workspace);
    if (opts.url) args.push("--url", opts.url);

    const raw = await this.run(args);
    const parsed = this.parse<Record<string, unknown>>(raw, "new-surface");
    return this.mapSurfaceResult(parsed, opts.type ?? "terminal");
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
    const args = ["move-surface", "--surface", opts.surface];
    if (opts.pane) args.push("--pane", opts.pane);
    if (opts.workspace) args.push("--workspace", opts.workspace);
    if (opts.before) args.push("--before", opts.before);
    if (opts.after) args.push("--after", opts.after);
    if (opts.index !== undefined) args.push("--index", String(opts.index));
    if (opts.focus !== undefined) args.push("--focus", String(opts.focus));

    const raw = await this.run(args);
    const parsed = this.parse<Record<string, unknown>>(raw, "move-surface");
    return this.mapMoveSurfaceResult(parsed);
  }

  async reorderSurface(opts: {
    surface: string;
    index?: number;
    before?: string;
    after?: string;
  }): Promise<CmuxReorderSurfaceResult> {
    const targetCount =
      Number(opts.index !== undefined) +
      Number(Boolean(opts.before)) +
      Number(Boolean(opts.after));
    if (targetCount !== 1) {
      throw new Error(
        "reorder-surface requires exactly one of index, before, or after",
      );
    }

    const args = ["reorder-surface", "--surface", opts.surface];
    if (opts.index !== undefined) args.push("--index", String(opts.index));
    if (opts.before) args.push("--before", opts.before);
    if (opts.after) args.push("--after", opts.after);

    const raw = await this.run(args);
    const parsed = this.parse<Record<string, unknown>>(raw, "reorder-surface");
    return this.mapReorderSurfaceResult(parsed);
  }

  async send(
    surface: string,
    text: string,
    opts?: CmuxSendOptions,
  ): Promise<void> {
    this.assertSupportedSendOptions(opts);
    const args = ["send", "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    args.push(text);
    await this.run(args);
  }

  async pasteText(
    surface: string,
    text: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const bufferName = this.pasteBufferName(surface, opts?.workspace);
    await this.run(["set-buffer", "--name", bufferName, "--", text]);

    const args = ["paste-buffer", "--name", bufferName, "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    await this.run(args);
  }

  async sendKey(
    surface: string,
    key: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const args = ["send-key", "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    args.push(normalizeKeyName(key));
    await this.run(args);
  }

  async selectWorkspace(workspace: string): Promise<void> {
    const args = ["select-workspace", "--workspace", workspace];
    await this.run(args);
  }

  async createWorkspace(
    title: string,
  ): Promise<{ workspace: string; title: string }> {
    const raw = await this.run(["workspace", "create", "--name", title]);
    const parsed = this.parse<Record<string, unknown>>(raw, "workspace create");
    return {
      workspace:
        (parsed.workspace_ref as string) ?? (parsed.workspace as string) ?? "",
      title: (parsed.title as string) ?? title,
    };
  }

  async readScreen(
    surface: string,
    opts?: {
      workspace?: string;
      lines?: number;
      scrollback?: boolean;
    },
  ): Promise<CmuxReadScreenResult> {
    const args = ["read-screen", "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    if (opts?.lines) args.push("--lines", String(opts.lines));
    if (opts?.scrollback) args.push("--scrollback");
    const raw = await this.run(args);
    const parsed = this.parse<Record<string, unknown>>(raw, "read-screen");
    return {
      surface: (parsed.surface_ref as string) ?? surface,
      text: parsed.text as string,
      lines: (parsed.lines as number) ?? 0,
      scrollback_used: opts?.scrollback ?? false,
    };
  }

  async renameTab(
    surface: string,
    title: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const args = ["rename-tab", "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    args.push(title);
    await this.run(args);
  }

  async notify(opts?: {
    title?: string;
    subtitle?: string;
    body?: string;
    workspace?: string;
    surface?: string;
  }): Promise<void> {
    const args = ["notify"];
    if (opts?.title) args.push("--title", opts.title);
    if (opts?.subtitle) args.push("--subtitle", opts.subtitle);
    if (opts?.body) args.push("--body", opts.body);
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    if (opts?.surface) args.push("--surface", opts.surface);
    await this.run(args);
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
    const args = ["set-status", key, value];
    if (opts?.icon) args.push("--icon", opts.icon);
    if (opts?.color) args.push("--color", opts.color);
    const workspace =
      opts?.workspace ??
      (opts?.surface
        ? await this.resolveWorkspaceFromSurface(opts.surface)
        : undefined);
    if (workspace) args.push("--workspace", workspace);
    await this.run(args);
  }

  async clearStatus(key: string, opts?: { workspace?: string }): Promise<void> {
    const args = ["clear-status", key];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    await this.run(args);
  }

  async setProgress(
    value: number,
    opts?: {
      label?: string;
      workspace?: string;
      surface?: string;
    },
  ): Promise<void> {
    const args = ["set-progress", String(value)];
    if (opts?.label) args.push("--label", opts.label);
    const workspace =
      opts?.workspace ??
      (opts?.surface
        ? await this.resolveWorkspaceFromSurface(opts.surface)
        : undefined);
    if (workspace) args.push("--workspace", workspace);
    await this.run(args);
  }

  async clearProgress(opts?: { workspace?: string }): Promise<void> {
    const args = ["clear-progress"];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    await this.run(args);
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
    const args = ["log", message];
    if (opts?.level) args.push("--level", opts.level);
    if (opts?.source) args.push("--source", opts.source);
    const workspace =
      opts?.workspace ??
      (opts?.surface
        ? await this.resolveWorkspaceFromSurface(opts.surface)
        : undefined);
    if (workspace) args.push("--workspace", workspace);
    await this.run(args);
  }

  async closeSurface(
    surface: string,
    opts?: { workspace?: string; collapsePane?: boolean },
  ): Promise<void> {
    const args = ["close-surface", "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    if (opts?.collapsePane) args.push("--collapse-pane");
    await this.run(args);
  }

  async listStatus(opts?: { workspace?: string }): Promise<CmuxStatusEntry[]> {
    const args = ["list-status"];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    const raw = await this.run(args);
    return this.parseStatusOutput(raw);
  }

  async identify(surface: string): Promise<CmuxIdentifyResult> {
    const raw = await this.run(["identify", "--surface", surface]);
    return this.parse(raw, "identify");
  }

  async browser(args: string[]): Promise<unknown> {
    const raw = await this.run(["browser", ...args]);
    return this.parseBrowserOutput(raw);
  }
}
