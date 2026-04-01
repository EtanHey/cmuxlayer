/**
 * cmux MCP server — registers 11 core tools + 11 agent lifecycle tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { CmuxClient, type ExecFn } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import { parseReservedModeKey } from "./mode-policy.js";
import { replaceTaskSuffix } from "./naming.js";
import { StateManager } from "./state-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import { AgentEngine, type AgentLifecycleEvent } from "./agent-engine.js";
import type { AgentRecord } from "./agent-types.js";
import {
  formatListSurfaces,
  formatReadScreen,
  formatListAgents,
  formatAgentState,
  formatOk,
} from "./format.js";
import { inferContextWindow, parseScreen } from "./screen-parser.js";
import type { CmuxSurface, ParsedScreenResult } from "./types.js";

type TextContent = { type: "text"; text: string };
type ToolReturn = {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** ToolAnnotations for MCP spec compliance */
const ANNOTATIONS = {
  readOnly: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const,
  mutating: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const,
  destructive: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  } as const,
  idempotentMutating: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const,
};

/**
 * Strip dangerous terminal control sequences from text before sending to panes.
 * Preserves newline (\n), tab (\t), and carriage return (\r).
 * Strips: ESC sequences, BEL, and other C0/C1 control characters.
 */
export function sanitizeTerminalInput(text: string): string {
  // Strip ANSI escape sequences (ESC [ ... letter, ESC ] ... BEL/ST, ESC ( ..., etc.)
  let result = text.replace(/\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@`]/g, "");
  // Strip remaining ESC + any following char
  result = result.replace(/\x1b./g, "");
  // Strip standalone ESC
  result = result.replace(/\x1b/g, "");
  // Strip C0 control chars except HT(0x09), LF(0x0a), CR(0x0d)
  result = result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Strip C1 control chars (0x80-0x9f)
  result = result.replace(/[\x80-\x9f]/g, "");
  return result;
}

const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";
const CLAUDE_CHANNEL_NOTIFICATION = "notifications/claude/channel";
const CLAUDE_CHANNEL_INSTRUCTIONS =
  "When loaded with Claude Code --channels, this server may emit notifications/claude/channel for cmux agent lifecycle events. These arrive as <channel> status updates and are one-way only.";

function ok(data: Record<string, unknown>): ToolReturn {
  const payload = { ok: true, ...data };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** ok() variant with formatted human-readable text content */
function okFormatted(
  formattedText: string,
  data: Record<string, unknown>,
): ToolReturn {
  const payload = { ok: true, ...data };
  return {
    content: [{ type: "text", text: formattedText }],
    structuredContent: payload,
  };
}

function err(error: unknown): ToolReturn {
  const message = error instanceof Error ? error.message : String(error);
  const payload = { ok: false, error: message };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function requireValue(
  value: string | number | undefined,
  message: string,
): asserts value is string | number {
  if (value === undefined || value === "") {
    throw new Error(message);
  }
}

function pickLatestSurfaceModel(
  stateMgr: StateManager,
  surfaceRef: string,
): string | null {
  const matches = stateMgr
    .listStates()
    .filter((record) => record.surface_id === surfaceRef && record.model);

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  return matches[0]?.model ?? null;
}

function enrichParsedScreen(
  parsed: ParsedScreenResult,
  rawText: string,
  fallbackModel: string | null,
): ParsedScreenResult {
  const model = parsed.model ?? fallbackModel;
  const contextWindow =
    parsed.context_window ??
    inferContextWindow(model, parsed.token_count, rawText);

  let contextPct = parsed.context_pct;
  if (
    contextPct === null &&
    parsed.agent_type !== "codex" &&
    parsed.token_count !== null &&
    contextWindow !== null
  ) {
    contextPct = Math.min(
      100,
      Math.round((parsed.token_count / contextWindow) * 100),
    );
  }

  return {
    ...parsed,
    model,
    context_window: contextWindow,
    context_pct: contextPct,
  };
}

export interface CreateServerOptions {
  exec?: ExecFn;
  bin?: string;
  /** Pre-built client (socket or CLI). If omitted, creates a CLI client. */
  client?: CmuxClient | CmuxSocketClient;
  /** Base directory for agent state files. Defaults to ~/.local/state/cmux-agents */
  stateDir?: string;
  /** Skip agent lifecycle initialization (for testing low-level tools only) */
  skipAgentLifecycle?: boolean;
  /** Opt into Claude Code channel notifications for lifecycle events */
  enableClaudeChannels?: boolean;
}

function formatLifecycleChannelContent(
  event: AgentLifecycleEvent,
  agent: AgentRecord,
): string {
  switch (event) {
    case "spawned":
      return `cmux agent spawned: ${agent.repo} (${agent.agent_id}) is ${agent.state}`;
    case "done":
      return `cmux agent done: ${agent.repo} (${agent.agent_id}) finished`;
    case "errored":
      return agent.error
        ? `cmux agent errored: ${agent.repo} (${agent.agent_id}) - ${agent.error}`
        : `cmux agent errored: ${agent.repo} (${agent.agent_id})`;
  }
}

function buildLifecycleChannelMeta(
  event: AgentLifecycleEvent,
  agent: AgentRecord,
): Record<string, string> {
  const meta: Record<string, string> = {
    source: "cmux-agent-status",
    event,
    agent_id: agent.agent_id,
    repo: agent.repo,
    state: agent.state,
    surface_id: agent.surface_id,
    model: agent.model,
    cli: agent.cli,
    spawn_depth: String(agent.spawn_depth),
  };

  if (agent.parent_agent_id) {
    meta.parent_agent_id = agent.parent_agent_id;
  }
  if (agent.cli_session_id) {
    meta.cli_session_id = agent.cli_session_id;
  }

  return meta;
}

export function createServer(opts?: CreateServerOptions): McpServer {
  const client =
    opts?.client ?? new CmuxClient({ exec: opts?.exec, bin: opts?.bin });
  const stateDir =
    opts?.stateDir ?? join(homedir(), ".local", "state", "cmux-agents");
  const stateMgr = new StateManager(stateDir);
  const enableClaudeChannels =
    opts?.enableClaudeChannels ??
    process.env.CMUXLAYER_ENABLE_CLAUDE_CHANNELS === "1";

  const server = new McpServer(
    {
      name: "@golems/cmux-mcp",
      version: "0.1.0",
    },
    enableClaudeChannels
      ? { instructions: CLAUDE_CHANNEL_INSTRUCTIONS }
      : undefined,
  );

  if (enableClaudeChannels) {
    server.server.registerCapabilities({
      experimental: {
        [CLAUDE_CHANNEL_CAPABILITY]: {},
      },
    });
  }

  const findSurfaceByRef = async (
    surfaceRef: string,
    workspace?: string,
  ): Promise<CmuxSurface | null> => {
    try {
      const workspaceRefs = workspace
        ? [workspace]
        : (await client.listWorkspaces()).workspaces.map((ws) => ws.ref);

      for (const workspaceRef of workspaceRefs) {
        const panes = await client.listPanes({ workspace: workspaceRef });
        for (const pane of panes.panes) {
          const group = await client.listPaneSurfaces({
            workspace: workspaceRef,
            pane: pane.ref,
          });
          const surface = group.surfaces.find(
            (entry) => entry.ref === surfaceRef,
          );
          if (surface) {
            return surface;
          }
        }
      }
    } catch {
      return null;
    }

    return null;
  };

  // 1. list_surfaces
  server.tool(
    "list_surfaces",
    "List all surfaces (terminal/browser panes) across workspaces",
    {
      workspace: z.string().optional().describe("Filter by workspace ref"),
      include_screen_preview: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include screen content preview"),
      preview_lines: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(8)
        .describe("Number of preview lines"),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        const workspaces = await client.listWorkspaces();
        const targetWorkspaceRefs = args.workspace
          ? [args.workspace]
          : workspaces.workspaces.map((workspace) => workspace.ref);
        const panesByWorkspace = await Promise.all(
          targetWorkspaceRefs.map(async (workspaceRef) => ({
            workspaceRef,
            panes: await client.listPanes({ workspace: workspaceRef }),
          })),
        );
        const surfaceGroups = await Promise.all(
          panesByWorkspace.flatMap(({ workspaceRef, panes }) =>
            panes.panes.map((pane) =>
              client.listPaneSurfaces({
                workspace: workspaceRef,
                pane: pane.ref,
              }),
            ),
          ),
        );
        const surfaces = await Promise.all(
          surfaceGroups.flatMap((group) =>
            group.surfaces.map(async (surface) => {
              const enrichedSurface: Record<string, unknown> = {
                ...surface,
                workspace_ref: group.workspace_ref,
                window_ref: group.window_ref,
                pane_ref: group.pane_ref,
              };

              if (args.include_screen_preview && surface.type === "terminal") {
                try {
                  const preview = await client.readScreen(surface.ref, {
                    workspace: group.workspace_ref,
                    lines: args.preview_lines,
                  });
                  enrichedSurface.screen_preview = preview.text;
                } catch (error) {
                  enrichedSurface.screen_preview_error =
                    error instanceof Error ? error.message : String(error);
                }
              }

              return enrichedSurface;
            }),
          ),
        );
        const data = {
          workspaces: workspaces.workspaces,
          surfaces,
          workspace_ref: args.workspace,
        };
        const formatted = formatListSurfaces(
          surfaces as Array<{
            ref?: string;
            title?: string;
            type?: string;
            workspace_ref?: string;
            pane_ref?: string;
            screen_preview?: string;
          }>,
          workspaces.workspaces as Array<{ ref: string; title?: string }>,
        );
        return okFormatted(formatted, data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 2. new_split
  server.tool(
    "new_split",
    "Create a new split pane (terminal or browser)",
    {
      direction: z
        .enum(["left", "right", "up", "down"])
        .describe("Split direction"),
      workspace: z.string().optional().describe("Target workspace ref"),
      surface: z.string().optional().describe("Target surface ref"),
      pane: z.string().optional().describe("Target pane ref"),
      type: z
        .enum(["terminal", "browser"])
        .optional()
        .default("terminal")
        .describe("Surface type"),
      url: z.string().optional().describe("URL for browser surfaces"),
      title: z.string().optional().describe("Tab title"),
      focus: z
        .boolean()
        .optional()
        .default(true)
        .describe("Focus the new pane"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const result = await client.newSplit(args.direction, {
          workspace: args.workspace,
          surface: args.surface,
          pane: args.pane,
          type: args.type,
          url: args.url,
          title: args.title,
          focus: args.focus,
        });
        if (args.title) {
          await client.renameTab(result.surface, args.title, {
            workspace: result.workspace || args.workspace,
          });
          result.title = args.title;
        }
        const data = { ...result };
        return okFormatted(
          formatOk("new_split", {
            surface: result.surface,
            direction: args.direction,
            type: args.type,
            title: result.title,
          }),
          data,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  // 3. send_input
  server.tool(
    "send_input",
    "Send text input to a terminal surface. When sending commands to another Claude session, press_enter can be unreliable — for critical inputs, use send_input without press_enter, then call send_key with key 'return' separately.",
    {
      surface: z.string().describe("Target surface ref"),
      text: z.string().describe("Text to send"),
      workspace: z.string().optional().describe("Target workspace ref"),
      press_enter: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Press enter after sending text. For reliability with interactive programs, send text first, then use a separate send_key 'return' call.",
        ),
      rename_to_task: z
        .string()
        .optional()
        .describe("Rename tab suffix to this task name"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const sanitizedText = sanitizeTerminalInput(args.text);
        await client.send(args.surface, sanitizedText, {
          workspace: args.workspace,
        });
        if (args.press_enter) {
          // Small delay to let the terminal process the text input before
          // sending the return key. Without this, the enter keypress can
          // arrive before the text is fully inserted into the terminal's
          // input buffer, causing the enter to be swallowed.
          await new Promise((resolve) => setTimeout(resolve, 50));
          await client.sendKey(args.surface, "return", {
            workspace: args.workspace,
          });
        }
        if (args.rename_to_task) {
          const surfaces = await client.listPaneSurfaces({
            workspace: args.workspace,
          });
          const surface = surfaces.surfaces.find((s) => s.ref === args.surface);
          const currentTitle = surface?.title ?? "";
          const newTitle = replaceTaskSuffix(currentTitle, args.rename_to_task);
          await client.renameTab(args.surface, newTitle, {
            workspace: args.workspace,
          });
        }
        const data = { surface: args.surface };
        return okFormatted(formatOk("send_input", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 4. send_key
  server.tool(
    "send_key",
    "Send a key press to a terminal surface. Use this after send_input to reliably submit commands — especially when targeting interactive programs like Claude sessions.",
    {
      surface: z.string().describe("Target surface ref"),
      key: z.string().describe("Key name (e.g. 'return', 'escape', 'tab')"),
      workspace: z.string().optional().describe("Target workspace ref"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        await client.sendKey(args.surface, args.key, {
          workspace: args.workspace,
        });
        const data = { surface: args.surface, key: args.key };
        return okFormatted(formatOk("send_key", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 5. read_screen
  server.tool(
    "read_screen",
    "Read terminal screen with parsed agent status. Returns parsed fields: agent_type, status, model, token_count, context_pct (% used), context_window (max tokens), cost, done_signal, response, errors. Use parsed_only=true for monitoring (omits raw terminal content).",
    {
      surface: z.string().describe("Target surface ref"),
      workspace: z.string().optional().describe("Target workspace ref"),
      lines: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(20)
        .describe("Number of lines to read"),
      scrollback: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include scrollback buffer"),
      parsed_only: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, return only parsed fields (omit raw content). Best for agent monitoring.",
        ),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        const result = await client.readScreen(args.surface, {
          workspace: args.workspace,
          lines: args.lines,
          scrollback: args.scrollback,
        });
        const surface = await findSurfaceByRef(result.surface, args.workspace);
        const parsed = enrichParsedScreen(
          parseScreen(result.text),
          result.text,
          pickLatestSurfaceModel(stateMgr, result.surface),
        );

        if (args.parsed_only) {
          const data = {
            surface: result.surface,
            title: surface?.title ?? null,
            parsed,
          };
          const formatted = formatReadScreen(
            result.surface,
            surface?.title ?? null,
            null,
            parsed,
            false,
            0,
          );
          return okFormatted(formatted, data);
        }

        const data = {
          surface: result.surface,
          title: surface?.title ?? null,
          lines: result.lines,
          content: result.text,
          scrollback_used: result.scrollback_used,
          parsed,
        };
        const formatted = formatReadScreen(
          result.surface,
          surface?.title ?? null,
          result.text,
          parsed,
          result.scrollback_used,
          result.lines,
        );
        return okFormatted(formatted, data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 6. rename_tab
  server.tool(
    "rename_tab",
    "Rename a surface tab",
    {
      surface: z.string().describe("Target surface ref"),
      title: z.string().describe("New tab title"),
      workspace: z.string().optional().describe("Target workspace ref"),
      preserve_prefix: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only replace the task suffix, keeping launcher prefix"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        let finalTitle = args.title;
        if (args.preserve_prefix) {
          const surfaces = await client.listPaneSurfaces({
            workspace: args.workspace,
          });
          const surface = surfaces.surfaces.find((s) => s.ref === args.surface);
          const currentTitle = surface?.title ?? "";
          finalTitle = replaceTaskSuffix(currentTitle, args.title);
        }
        await client.renameTab(args.surface, finalTitle, {
          workspace: args.workspace,
        });
        const data = { surface: args.surface, title: finalTitle };
        return okFormatted(formatOk("rename_tab", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 7. notify
  server.tool(
    "notify",
    "Show a cmux notification banner for a workspace or specific surface.",
    {
      title: z
        .string()
        .optional()
        .describe(
          'Notification title; omit to use cmux CLI default ("Notification")',
        ),
      subtitle: z.string().optional().describe("Notification subtitle"),
      body: z.string().optional().describe("Notification body"),
      workspace: z.string().optional().describe("Target workspace ref"),
      surface: z.string().optional().describe("Target surface ref"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        await client.notify({
          title: args.title,
          subtitle: args.subtitle,
          body: args.body,
          workspace: args.workspace,
          surface: args.surface,
        });
        const data = {
          title: args.title ?? null,
          subtitle: args.subtitle ?? null,
          body: args.body ?? null,
          workspace: args.workspace ?? null,
          surface: args.surface ?? null,
        };
        return okFormatted(formatOk("notify", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 8. set_status
  server.tool(
    "set_status",
    "Set a sidebar status key-value pair",
    {
      key: z.string().describe("Status key"),
      value: z.string().describe("Status value"),
      workspace: z.string().optional().describe("Target workspace ref"),
      surface: z.string().optional().describe("Target surface ref"),
      icon: z.string().max(8).optional().describe("Icon name"),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional()
        .describe("Hex color"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        parseReservedModeKey(args.key, args.value);
        await client.setStatus(args.key, args.value, {
          icon: args.icon,
          color: args.color,
          workspace: args.workspace,
          surface: args.surface,
        });
        const data = { key: args.key, value: args.value };
        return okFormatted(formatOk("set_status", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 9. set_progress
  server.tool(
    "set_progress",
    "Set sidebar progress indicator (0.0 to 1.0)",
    {
      value: z
        .number()
        .min(0)
        .max(1)
        .describe("Progress value between 0 and 1"),
      label: z.string().optional().describe("Progress label text"),
      workspace: z.string().optional().describe("Target workspace ref"),
      surface: z.string().optional().describe("Target surface ref"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        await client.setProgress(args.value, {
          label: args.label,
          workspace: args.workspace,
          surface: args.surface,
        });
        const data = { value: args.value, label: args.label };
        return okFormatted(formatOk("set_progress", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 10. close_surface
  server.tool(
    "close_surface",
    "Close a surface (terminal or browser pane)",
    {
      surface: z.string().describe("Target surface ref"),
      workspace: z.string().optional().describe("Target workspace ref"),
    },
    ANNOTATIONS.destructive,
    async (args) => {
      try {
        await client.closeSurface(args.surface, {
          workspace: args.workspace,
        });
        const data = { surface: args.surface };
        return okFormatted(formatOk("close_surface", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 11. browser_surface
  server.tool(
    "browser_surface",
    "Interact with a browser surface (open, navigate, snapshot, click, type, eval, wait)",
    {
      action: z
        .enum([
          "open",
          "goto",
          "snapshot",
          "click",
          "type",
          "eval",
          "wait",
          "url",
        ])
        .describe("Browser action to perform"),
      surface: z.string().optional().describe("Target surface ref"),
      workspace: z.string().optional().describe("Target workspace ref"),
      url: z.string().optional().describe("URL for open/goto actions"),
      selector: z
        .string()
        .optional()
        .describe("CSS selector for click/type/wait actions"),
      text: z.string().optional().describe("Text for type action"),
      script: z.string().optional().describe("JavaScript for eval action"),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout for wait action"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const browserArgs: string[] = [];
        if (args.surface) {
          browserArgs.push("--surface", args.surface);
        }

        switch (args.action) {
          case "open":
            browserArgs.push("open");
            if (args.url) {
              browserArgs.push(args.url);
            }
            break;
          case "goto":
            requireValue(args.surface, "surface is required for goto");
            requireValue(args.url, "url is required for goto");
            browserArgs.push("goto", args.url);
            break;
          case "snapshot":
            requireValue(args.surface, "surface is required for snapshot");
            browserArgs.push("snapshot");
            break;
          case "click":
            requireValue(args.surface, "surface is required for click");
            requireValue(args.selector, "selector is required for click");
            browserArgs.push("click", args.selector);
            break;
          case "type":
            requireValue(args.surface, "surface is required for type");
            requireValue(args.selector, "selector is required for type");
            requireValue(args.text, "text is required for type");
            browserArgs.push("type", args.selector, args.text);
            break;
          case "eval":
            requireValue(args.surface, "surface is required for eval");
            requireValue(args.script, "script is required for eval");
            browserArgs.push("eval", args.script);
            break;
          case "wait":
            requireValue(args.surface, "surface is required for wait");
            if (!args.selector && !args.text && !args.timeout_ms) {
              throw new Error(
                "wait requires at least one of selector, text, or timeout_ms",
              );
            }
            browserArgs.push("wait");
            if (args.selector) {
              browserArgs.push("--selector", args.selector);
            }
            if (args.text) {
              browserArgs.push("--text", args.text);
            }
            if (args.timeout_ms) {
              browserArgs.push("--timeout-ms", String(args.timeout_ms));
            }
            break;
          case "url":
            requireValue(args.surface, "surface is required for url");
            browserArgs.push("url");
            break;
        }

        const result = await client.browser(browserArgs);
        // browser_surface actions map to cmux browser-surface subcommands
        const data = { action: args.action, surface: args.surface, result };
        return okFormatted(formatOk("browser_surface", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // --- Agent Lifecycle Tools (Phase 5) ---

  if (!opts?.skipAgentLifecycle) {
    const surfaceProvider = async () => {
      try {
        const workspaces = await client.listWorkspaces();
        const panesByWorkspace = await Promise.all(
          workspaces.workspaces.map(async (ws) => ({
            ref: ws.ref,
            panes: await client.listPanes({ workspace: ws.ref }),
          })),
        );
        const surfaceGroups = await Promise.all(
          panesByWorkspace.flatMap(({ ref, panes }) =>
            panes.panes.map((p) =>
              client.listPaneSurfaces({ workspace: ref, pane: p.ref }),
            ),
          ),
        );
        return surfaceGroups.flatMap((g) => g.surfaces);
      } catch {
        return [];
      }
    };
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    const notifyLifecycleEvent = async (
      event: AgentLifecycleEvent,
      agent: AgentRecord,
    ): Promise<void> => {
      if (!enableClaudeChannels || !server.server.transport) {
        return;
      }

      // Claude turns meta keys into <channel ...> attributes, so keep keys simple.
      await server.server.notification({
        method: CLAUDE_CHANNEL_NOTIFICATION,
        params: {
          content: formatLifecycleChannelContent(event, agent),
          meta: buildLifecycleChannelMeta(event, agent),
        },
      });
    };
    const engine = new AgentEngine(stateMgr, registry, {
      log: (message, eventOpts) => client.log(message, eventOpts),
      setStatus: (key, value, statusOpts) =>
        client.setStatus(key, value, statusOpts),
      readScreen: (surface, readOpts) => client.readScreen(surface, readOpts),
      send: (surface, text, sendOpts) => client.send(surface, text, sendOpts),
      sendKey: (surface, key, keyOpts) => client.sendKey(surface, key, keyOpts),
      setProgress: (value, progressOpts) =>
        client.setProgress(value, progressOpts),
      newSplit: (direction, splitOpts) => client.newSplit(direction, splitOpts),
      notifyLifecycleEvent,
    });

    // Reconstitute registry from disk on startup (async, best-effort)
    registry
      .reconstitute()
      .catch((e) =>
        console.error("[cmux-mcp] registry reconstitution failed:", e),
      );
    engine.startSweep(5000);

    // 11. spawn_agent
    server.tool(
      "spawn_agent",
      "Spawn an AI agent in a new terminal surface. Returns immediately — use wait_for to block until ready.",
      {
        repo: z
          .string()
          .describe("Repository name (e.g. 'brainlayer', 'golems')"),
        model: z
          .string()
          .describe("Model name (e.g. 'sonnet', 'codex', 'opus')"),
        cli: z
          .enum(["claude", "codex", "gemini", "kiro", "cursor"])
          .describe("CLI tool to launch"),
        prompt: z.string().describe("Task prompt to send after agent is ready"),
        workspace: z.string().optional().describe("Target workspace ref"),
        parent_agent_id: z
          .string()
          .optional()
          .describe(
            "ID of the parent agent for hierarchical spawning. Parent must exist.",
          ),
        max_cost_per_agent: z
          .number()
          .optional()
          .describe("Maximum cost cap in USD for this agent"),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          const result = await engine.spawnAgent({
            repo: args.repo,
            model: args.model,
            cli: args.cli,
            prompt: args.prompt,
            workspace: args.workspace,
            parent_agent_id: args.parent_agent_id,
            max_cost_per_agent: args.max_cost_per_agent,
          });
          return okFormatted(
            formatOk("spawn_agent", {
              agent_id: result.agent_id,
              repo: args.repo,
              model: args.model,
              surface: result.surface_id,
            }),
            { ...result },
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    // 12. wait_for
    server.tool(
      "wait_for",
      "Block until an agent reaches a target state (ready, done, error). Checks retroactively first.",
      {
        agent_id: z.string().describe("Agent ID from spawn_agent"),
        target_state: z
          .enum(["ready", "working", "idle", "done", "error"])
          .describe("State to wait for"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .default(300000)
          .describe("Timeout in milliseconds (default: 5 minutes)"),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          const result = await engine.waitFor(
            args.agent_id,
            args.target_state,
            args.timeout_ms,
          );
          return okFormatted(
            formatOk("wait_for", {
              agent_id: args.agent_id,
              state: result.state,
            }),
            { ...result },
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    // 13. wait_for_all
    server.tool(
      "wait_for_all",
      "Block until ALL agents reach target state OR any agent errors (fail-fast with partial results).",
      {
        agent_ids: z.array(z.string()).describe("Array of agent IDs"),
        target_state: z
          .enum(["ready", "working", "idle", "done", "error"])
          .describe("State to wait for"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .default(300000)
          .describe("Timeout in milliseconds (default: 5 minutes)"),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          const results = await engine.waitForAll(
            args.agent_ids,
            args.target_state,
            args.timeout_ms,
          );
          return okFormatted(
            formatOk("wait_for_all", {
              count: results.length,
              target: args.target_state,
            }),
            { results },
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    // 14. get_agent_state
    server.tool(
      "get_agent_state",
      "Get the full state of an agent including cli_session_id for resume.",
      {
        agent_id: z.string().describe("Agent ID"),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          const state = engine.getAgentState(args.agent_id);
          if (!state)
            return err(new Error(`Agent not found: ${args.agent_id}`));
          const formatted = formatAgentState(state);
          return okFormatted(
            formatted,
            state as unknown as Record<string, unknown>,
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    // 15. list_agents
    server.tool(
      "list_agents",
      "List all agents with optional filters by state, repo, or model.",
      {
        state: z
          .enum([
            "creating",
            "booting",
            "ready",
            "working",
            "idle",
            "done",
            "error",
          ])
          .optional()
          .describe("Filter by state"),
        repo: z.string().optional().describe("Filter by repository"),
        model: z.string().optional().describe("Filter by model"),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          const agents = engine.listAgents({
            state: args.state,
            repo: args.repo,
            model: args.model,
          });
          const data = {
            agents: agents as unknown as Record<string, unknown>[],
            count: agents.length,
          };
          const formatted = formatListAgents(agents, agents.length);
          return okFormatted(formatted, data);
        } catch (e) {
          return err(e);
        }
      },
    );

    // 16. stop_agent
    server.tool(
      "stop_agent",
      "Stop an agent gracefully (Ctrl+C) or forcefully (kill process).",
      {
        agent_id: z.string().describe("Agent ID to stop"),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe("Force kill instead of graceful Ctrl+C"),
      },
      ANNOTATIONS.destructive,
      async (args) => {
        try {
          await engine.stopAgent(args.agent_id, args.force);
          const state = engine.getAgentState(args.agent_id);
          const data = {
            agent_id: args.agent_id,
            state: state?.state ?? "done",
          };
          return okFormatted(formatOk("stop_agent", data), data);
        } catch (e) {
          return err(e);
        }
      },
    );

    // 17. send_to_agent
    server.tool(
      "send_to_agent",
      "Send text input to an agent. Agent must be in ready or idle state.",
      {
        agent_id: z.string().describe("Agent ID"),
        text: z.string().describe("Text to send"),
        press_enter: z
          .boolean()
          .optional()
          .default(true)
          .describe("Press enter after sending text"),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          await engine.sendToAgent(args.agent_id, args.text, args.press_enter);
          const data = { agent_id: args.agent_id };
          return okFormatted(formatOk("send_to_agent", data), data);
        } catch (e) {
          return err(e);
        }
      },
    );
    // 18. read_agent_output
    server.tool(
      "read_agent_output",
      "Extract structured output from an agent's terminal between delimiter markers (e.g., REVIEW_OUTPUT_START / REVIEW_OUTPUT_END). Returns the content between the markers, or null if not found.",
      {
        surface: z.string().describe("Target surface ref (e.g., 'surface:78')"),
        tag: z
          .string()
          .optional()
          .default("OUTPUT")
          .describe(
            "Delimiter tag name. Looks for {TAG}_START and {TAG}_END markers. Default: OUTPUT (matches OUTPUT_START/OUTPUT_END). Examples: REVIEW_OUTPUT, SYNTHESIS_OUTPUT, PUSHBACK_OUTPUT",
          ),
        lines: z
          .number()
          .optional()
          .default(200)
          .describe("Number of screen lines to scan (default: 200)"),
        workspace: z.string().optional().describe("Target workspace ref"),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          const opts: Record<string, unknown> = {
            lines: args.lines,
            scrollback: true,
          };
          if (args.workspace) opts.workspace = args.workspace;

          const raw = await client.readScreen(args.surface, opts);
          const text = typeof raw === "string" ? raw : (raw.text ?? "");

          const startMarker = `${args.tag}_START`;
          const endMarker = `${args.tag}_END`;

          const startIdx = text.indexOf(startMarker);
          const endIdx = text.indexOf(endMarker);

          if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
            return ok({
              found: false,
              tag: args.tag,
              surface: args.surface,
              content: null,
            });
          }

          const content = text
            .slice(startIdx + startMarker.length, endIdx)
            .trim();

          return ok({
            found: true,
            tag: args.tag,
            surface: args.surface,
            content,
          });
        } catch (e) {
          return err(e);
        }
      },
    );
    // --- V2 Public API: interact + kill ---

    // 19. interact
    server.tool(
      "interact",
      "Send a message to an agent, or perform an agent action (interrupt, model switch, resume, skill, usage). If the agent is alive, sends directly. If not found, returns an error — use spawn_agent first.",
      {
        agent: z
          .string()
          .describe("Agent ID (from spawn_agent or list_agents)"),
        action: z
          .enum([
            "send",
            "interrupt",
            "model",
            "resume",
            "skill",
            "usage",
            "mcp",
          ])
          .describe("Action to perform"),
        text: z
          .string()
          .optional()
          .describe("Text to send (required for action=send)"),
        model: z
          .string()
          .optional()
          .describe("Model to switch to (required for action=model)"),
        session_id: z
          .string()
          .optional()
          .describe("Session ID to resume (optional for action=resume)"),
        command: z
          .string()
          .optional()
          .describe("Slash command to run (required for action=skill)"),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          // Runtime validation per action (Decision 2)
          switch (args.action) {
            case "send":
              if (!args.text) {
                return err(
                  new Error(
                    "text is required for action=send. Provide the message to send to the agent.",
                  ),
                );
              }
              break;
            case "model":
              if (!args.model) {
                return err(
                  new Error(
                    "model is required for action=model. Provide the model name to switch to (e.g. 'sonnet', 'opus').",
                  ),
                );
              }
              break;
            case "skill":
              if (!args.command) {
                return err(
                  new Error(
                    "command is required for action=skill. Provide the slash command (e.g. '/commit', '/review').",
                  ),
                );
              }
              break;
            // interrupt, resume, usage, mcp — no extra fields required
          }

          // Resolve agent
          const agent = engine.getAgentState(args.agent);
          if (!agent) {
            return err(
              new Error(
                `Agent not found: "${args.agent}". Use list_agents to see available agents, or spawn_agent to create one.`,
              ),
            );
          }

          // Dispatch action
          switch (args.action) {
            case "send": {
              await engine.sendToAgent(args.agent, args.text!, true);
              const d = { agent_id: args.agent, action: "send" };
              return okFormatted(formatOk("interact:send", d), d);
            }
            case "interrupt": {
              await client.sendKey(agent.surface_id, "c-c", {});
              const d = { agent_id: args.agent, action: "interrupt" };
              return okFormatted(formatOk("interact:interrupt", d), d);
            }
            case "model": {
              const modelCmd = `/model ${args.model}`;
              await engine.sendToAgent(args.agent, modelCmd, true);
              const d = {
                agent_id: args.agent,
                action: "model",
                model: args.model,
              };
              return okFormatted(formatOk("interact:model", d), d);
            }
            case "resume": {
              const resumeCmd = args.session_id
                ? `/resume ${args.session_id}`
                : "/resume";
              await engine.sendToAgent(args.agent, resumeCmd, true);
              const d = {
                agent_id: args.agent,
                action: "resume",
                session_id: args.session_id,
              };
              return okFormatted(formatOk("interact:resume", d), d);
            }
            case "skill": {
              await engine.sendToAgent(args.agent, args.command!, true);
              const d = {
                agent_id: args.agent,
                action: "skill",
                command: args.command,
              };
              return okFormatted(formatOk("interact:skill", d), d);
            }
            case "usage": {
              // Read screen to extract usage info
              const screen = await client.readScreen(agent.surface_id, {
                lines: 5,
              });
              return ok({
                agent_id: args.agent,
                action: "usage",
                surface_id: agent.surface_id,
                screen_tail: screen.text,
              });
            }
            case "mcp": {
              // Read screen for MCP server status
              const mcpScreen = await client.readScreen(agent.surface_id, {
                lines: 10,
              });
              return ok({
                agent_id: args.agent,
                action: "mcp",
                surface_id: agent.surface_id,
                screen_tail: mcpScreen.text,
              });
            }
          }
        } catch (e) {
          return err(e);
        }
      },
    );

    // Expose engine on the tool for test access
    (server as any)._registeredTools["interact"]._engine = engine;

    // 20. kill
    server.tool(
      "kill",
      "Stop one or more agents. Target can be a single agent ID, an array of IDs, or 'all'.",
      {
        target: z
          .union([z.string(), z.array(z.string())])
          .describe(
            "Agent ID, array of agent IDs, or 'all' to stop all agents",
          ),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe("Force kill (SIGKILL) instead of graceful (Ctrl+C)"),
      },
      ANNOTATIONS.destructive,
      async (args) => {
        try {
          const killed: string[] = [];
          const errors: string[] = [];

          // Resolve target list
          let targetIds: string[];
          if (args.target === "all") {
            const agents = engine.listAgents();
            targetIds = agents
              .filter((a) => a.state !== "done" && a.state !== "error")
              .map((a) => a.agent_id);
          } else if (Array.isArray(args.target)) {
            targetIds = args.target;
          } else {
            targetIds = [args.target];
          }

          if (targetIds.length === 0) {
            return okFormatted(
              formatOk("kill", { message: "No agents to kill" }),
              { killed: [] },
            );
          }

          // Kill each agent, collecting results
          for (const agentId of targetIds) {
            try {
              await engine.stopAgent(agentId, args.force);
              killed.push(agentId);
            } catch (e) {
              errors.push(
                `${agentId}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }

          if (killed.length === 0 && errors.length > 0) {
            return err(
              new Error(`Failed to kill any agents: ${errors.join("; ")}`),
            );
          }

          const data = {
            killed,
            errors: errors.length > 0 ? errors : undefined,
            force: args.force,
          };
          return okFormatted(formatOk("kill", { count: killed.length }), data);
        } catch (e) {
          return err(e);
        }
      },
    );
    // 21. my_agents
    server.tool(
      "my_agents",
      "Get all children of a parent agent with live status from read_screen. Combines registry state + parsed screen output in one call.",
      {
        parent_agent_id: z
          .string()
          .optional()
          .describe(
            "Parent agent ID. If omitted, returns all root agents (no parent).",
          ),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          let agents: AgentRecord[];
          if (args.parent_agent_id) {
            // Look up children directly — parent record may be gone
            // but children still reference it via parent_agent_id
            agents = engine.getRegistry().getChildren(args.parent_agent_id);
          } else {
            agents = engine
              .listAgents()
              .filter((a) => a.parent_agent_id === null);
          }

          const SCREEN_TIMEOUT = 3000;
          const enriched = await Promise.all(
            agents.map(async (agent) => {
              let screenData: ParsedScreenResult | null = null;
              try {
                const screen = await Promise.race([
                  client.readScreen(agent.surface_id, { lines: 20 }),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error("timeout")),
                      SCREEN_TIMEOUT,
                    ),
                  ),
                ]);
                screenData = enrichParsedScreen(
                  parseScreen(screen.text),
                  screen.text,
                  pickLatestSurfaceModel(stateMgr, agent.surface_id),
                );
              } catch {
                // Surface may be closed, unavailable, or timed out
              }

              return {
                agent_id: agent.agent_id,
                repo: agent.repo,
                state: agent.state,
                model: agent.model,
                cli: agent.cli,
                surface_id: agent.surface_id,
                token_count: screenData?.token_count ?? null,
                context_pct: screenData?.context_pct ?? null,
                cost: screenData?.cost ?? null,
                task_summary: agent.task_summary,
                spawn_depth: agent.spawn_depth,
                created_at: agent.created_at,
                quality: agent.quality,
              };
            }),
          );

          const lines = enriched.map((a) => {
            const ctx = a.context_pct !== null ? `${a.context_pct}%` : "—";
            const cost = a.cost !== null ? `$${a.cost.toFixed(2)}` : "—";
            const tokens =
              a.token_count !== null
                ? `${Math.round(a.token_count / 1000)}K`
                : "—";
            return `${a.agent_id}  ${a.state}  ${tokens}  ${ctx}  ${cost}`;
          });

          const formatted =
            `┌─ my_agents ─ ${enriched.length} agent${enriched.length !== 1 ? "s" : ""}\n` +
            lines.map((l) => `│ ${l}`).join("\n") +
            "\n└─";

          return okFormatted(formatted, {
            agents: enriched,
            count: enriched.length,
            parent_agent_id: args.parent_agent_id ?? null,
          });
        } catch (e) {
          return err(e);
        }
      },
    );
  } // end skipAgentLifecycle guard

  return server;
}
