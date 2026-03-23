/**
 * cmux CLI client — the ONLY place that knows shell command details.
 * All handlers go through this boundary.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  CmuxPane,
  CmuxWorkspace,
  CmuxPaneSurfaces,
  CmuxNewSplitResult,
  CmuxReadScreenResult,
  CmuxStatusEntry,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ExecFn {
  (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

const defaultExec: ExecFn = (cmd, args) => execFileAsync(cmd, args);

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
  private exec: ExecFn;
  private bin: string;

  constructor(opts?: { exec?: ExecFn; bin?: string }) {
    this.exec = opts?.exec ?? defaultExec;
    this.bin = opts?.bin ?? "cmux";
  }

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await this.exec(this.bin, ["--json", ...args]);
      return stdout;
    } catch (error) {
      throw this.normalizeCliError(args, error);
    }
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
    if (opts?.surface) args.push("--surface", opts.surface);
    if (opts?.pane) args.push("--panel", opts.pane);
    const raw = await this.run(args);
    const parsed = this.parse<Record<string, unknown>>(raw, "new-split");
    return this.mapSplitResult(parsed, "terminal");
  }

  async send(
    surface: string,
    text: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const args = ["send", "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    args.push(text);
    await this.run(args);
  }

  async sendKey(
    surface: string,
    key: string,
    opts?: { workspace?: string },
  ): Promise<void> {
    const args = ["send-key", "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
    args.push(key);
    await this.run(args);
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
    const args = ["notify", "--title", opts?.title ?? "Notification"];
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
    opts?: { workspace?: string },
  ): Promise<void> {
    const args = ["close-surface", "--surface", surface];
    if (opts?.workspace) args.push("--workspace", opts.workspace);
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
