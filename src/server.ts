/**
 * cmux MCP server — registers 16 core tools + 13 agent lifecycle tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CmuxClient, type ExecFn } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import { parseReservedModeKey } from "./mode-policy.js";
import { replaceTaskSuffix } from "./naming.js";
import { StateManager } from "./state-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import {
  AgentEngine,
  type AgentLifecycleEvent,
  type SpawnAgentParams,
} from "./agent-engine.js";
import { AgentDiscovery } from "./agent-discovery.js";
import { toPublicAgent } from "./agent-facade.js";
import type {
  AgentRecord,
  AgentRole,
  AgentState,
  CliType,
  DeliveryEventType,
  DeliveryTelemetryEvent,
} from "./agent-types.js";
import {
  formatListSurfaces,
  formatReadScreen,
  formatListAgents,
  formatAgentState,
  formatOk,
  formatResync,
} from "./format.js";
import { inferContextWindow, parseScreen } from "./screen-parser.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import {
  collectRoleSurfaceIds,
  chooseAgentSpawnPlacement,
  chooseSurfaceClosePolicy,
  inferAgentRole,
} from "./layout-policy.js";
import type {
  CmuxNewSplitResult,
  CmuxNewSurfaceResult,
  CmuxSurface,
  ParsedScreenResult,
} from "./types.js";
import { normalizeKeyName } from "./key-names.js";
import { matchReadyPattern } from "./pattern-registry.js";

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

// Re-export for test access
export { sanitizeTerminalInput } from "./sanitize.js";

const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";
const CLAUDE_CHANNEL_NOTIFICATION = "notifications/claude/channel";
const CLAUDE_CHANNEL_INSTRUCTIONS =
  "When loaded with Claude Code --channels, this server may emit notifications/claude/channel for cmux agent lifecycle events. These arrive as <channel> status updates and are one-way only.";
const SEND_INPUT_CHUNK_THRESHOLD = 500;
const SEND_INPUT_CHUNK_DELAY_MS = 5;
const SEND_INPUT_RETRY_ATTEMPTS = 3;
const SEND_INPUT_RETRY_DELAY_MS = 25;
const SEND_INPUT_ENTER_DELAY_MS = 50;
const SEND_INPUT_RECOVERY_ENTER_DELAY_MS = 150;
const SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS = 2000;
const SEND_INPUT_SUBMIT_VERIFY_POLL_MS = 100;
const BOOT_PROMPT_TIMEOUT_MS = 60_000;
const BOOT_PROMPT_READY_POLL_MS = 250;
const INTERACTIVE_AGENT_STATES = new Set<AgentState>(["ready", "idle"]);
const READY_PATTERN_CLIS: CliType[] = ["claude", "codex", "gemini", "kiro", "cursor"];
const SendToArgsSchema = z.object({
  agent_id: z.string(),
  text: z.string(),
  press_enter: z.boolean().optional().default(true),
  allow_busy: z.boolean().optional().default(false),
});

type DeliveryStatus = "delivering" | "delivered" | "failed";

interface DeliveryRecord {
  delivery_id: string;
  surface: string;
  workspace?: string;
  status: DeliveryStatus;
  total_chunks: number;
  sent_chunks: number;
  chunk_size: number;
  chunk_delay_ms: number;
  chunks: string[];
  press_enter: boolean;
  rename_to_task?: string;
  started_at: string;
  completed_at?: string;
  error?: string;
  failed_chunk?: number;
}

class DeliveryError extends Error {
  constructor(
    message: string,
    readonly failed_chunk?: number,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

class BootPromptTimeoutError extends Error {
  constructor(
    message: string,
    readonly last_10_lines: string[],
  ) {
    super(message);
    this.name = "BootPromptTimeoutError";
  }
}

class BootPromptDeliveryError extends Error {
  constructor(
    message: string,
    readonly delivered_chars: number,
  ) {
    super(message);
    this.name = "BootPromptDeliveryError";
  }
}

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

function err(error: unknown, extra: Record<string, unknown> = {}): ToolReturn {
  const message = error instanceof Error ? error.message : String(error);
  const payload = { ok: false, error: message, ...extra };
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

type ListSurfacesRemoteState =
  | "local"
  | "connected"
  | "disconnected"
  | "unavailable";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function summarizeRemoteState(remoteValue: unknown): ListSurfacesRemoteState {
  const remote = asRecord(remoteValue);
  if (!remote) {
    return "local";
  }

  const state =
    typeof remote.state === "string"
      ? (remote.state as ListSurfacesRemoteState | string)
      : undefined;
  const connected = remote.connected === true || state === "connected";
  if (connected) {
    return "connected";
  }

  const hasRemoteHints =
    remote.enabled === true ||
    remote.has_ssh_options === true ||
    remote.has_identity_file === true ||
    (typeof remote.destination === "string" && remote.destination.length > 0) ||
    (remote.port !== null && remote.port !== undefined) ||
    (remote.local_proxy_port !== null && remote.local_proxy_port !== undefined);

  if (!hasRemoteHints && (state === undefined || state === "disconnected")) {
    return "local";
  }

  if (state === "unavailable") {
    return hasRemoteHints ? "unavailable" : "local";
  }

  return "disconnected";
}

function toMinimalWorkspace(
  workspace: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ref: typeof workspace.ref === "string" ? workspace.ref : "",
    title: typeof workspace.title === "string" ? workspace.title : "",
    current_directory:
      typeof workspace.current_directory === "string"
        ? workspace.current_directory
        : null,
    remote_state: summarizeRemoteState(workspace.remote),
  };
}

function toMinimalSurface(
  surface: Record<string, unknown>,
): Record<string, unknown> {
  const minimal: Record<string, unknown> = {
    ref: typeof surface.ref === "string" ? surface.ref : "",
    title: typeof surface.title === "string" ? surface.title : "",
    type: typeof surface.type === "string" ? surface.type : "terminal",
    workspace_ref:
      typeof surface.workspace_ref === "string" ? surface.workspace_ref : "",
  };

  if (typeof surface.screen_preview === "string") {
    minimal.screen_preview = surface.screen_preview;
  }
  if (typeof surface.screen_preview_error === "string") {
    minimal.screen_preview_error = surface.screen_preview_error;
  }

  return minimal;
}

function chunkTerminalInput(text: string, chunkSize: number): string[] {
  if (!text || text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > chunkSize) {
    const newlineIndex = remaining.lastIndexOf("\n", chunkSize);
    const splitAt = newlineIndex >= 0 ? newlineIndex + 1 : chunkSize;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function getBootPromptPath(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasInlinePrompt(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertBootPromptMode(
  prompt: string | undefined,
  bootPromptPath: string | null,
): void {
  if (hasInlinePrompt(prompt) && bootPromptPath) {
    throw new Error("prompt and boot_prompt_path are mutually exclusive");
  }
}

function tailLines(text: string, count: number): string[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-count);
}

async function preflightBootPromptFile(path: string): Promise<void> {
  try {
    await access(path, fsConstants.R_OK);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "ERROR";
    if (code === "ENOENT") {
      throw new Error(`boot_prompt_path ENOENT: ${path}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`boot_prompt_path permission denied: ${path}`);
    }
    throw error;
  }
}

function inferLauncherCli(command: string): CliType | null {
  if (!/(^|\s)-s(?:\s|$)/.test(command)) {
    return null;
  }

  const match = command.match(
    /(?:^|\s)[A-Za-z0-9_.-]+(Claude|Codex|Cursor|Gemini|Kiro)\b/,
  );
  if (!match) {
    return null;
  }

  return match[1].toLowerCase() as CliType;
}

function readyPatternCandidates(cli?: CliType): CliType[] {
  return cli ? [cli] : READY_PATTERN_CLIS;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDeliveryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /socket|connection_|connection closed|timeout/i.test(message);
}


function formatToolValidationError(toolName: string, error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "input";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `${toolName} invalid arguments: ${details}`;
}

function isSubmitVerifiedStatus(
  status: ParsedScreenResult["status"] | null | undefined,
): boolean {
  return status === "working" || status === "thinking" || status === "done";
}

function screenShowsPendingInput(screenText: string, submittedText: string): boolean {
  const trimmed = submittedText.trim();
  if (!trimmed) {
    return false;
  }

  const tail = trimmed.slice(-Math.min(80, trimmed.length));
  return screenText.includes(tail);
}

function computeEnterDelayMs(bytes: number, chunkCount: number): number {
  const extraChunks = Math.max(0, chunkCount - 1);
  const longPayloadPenalty = bytes >= SEND_INPUT_CHUNK_THRESHOLD ? 100 : 0;
  return Math.min(250, SEND_INPUT_ENTER_DELAY_MS + extraChunks * 50 + longPayloadPenalty);
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
  /** Override spawn preflight checks (primarily for tests). */
  spawnPreflight?: (params: SpawnAgentParams) => Promise<void>;
  /** Explicitly disable spawn preflight checks (primarily for mocked tests). */
  disableSpawnPreflight?: boolean;
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
  const roleSurfaceOverrides = new Map<
    string,
    { role: AgentRole; workspace: string | null }
  >();
  let lifecycleRegistry: AgentRegistry | null = null;
  const eventLog = stateMgr.getEventLog();
  const deliveries = new Map<string, DeliveryRecord>();
  const latestDeliveryBySurface = new Map<string, string>();
  const activeDeliveryBySurface = new Map<string, string>();
  const activeSurfaceWrites = new Map<string, string>();
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

  const snapshotDelivery = (record: DeliveryRecord) => ({
    delivery_id: record.delivery_id,
    surface: record.surface,
    status: record.status,
    sent_chunks: record.sent_chunks,
    total_chunks: record.total_chunks,
    chunk_size: record.chunk_size,
    started_at: record.started_at,
    completed_at: record.completed_at ?? null,
    failed_chunk: record.failed_chunk ?? null,
    error: record.error ?? null,
  });

  const collectServerRoleSurfaceIds = (
    liveSurfaceIds?: ReadonlySet<string>,
    workspace?: string,
  ) => {
    const roleRecords = lifecycleRegistry?.list() ?? [];
    const ids = collectRoleSurfaceIds(roleRecords);
    if (liveSurfaceIds) {
      for (const role of ["orchestrator", "ic", "worker"] as const) {
        for (const surfaceId of ids[role]) {
          if (!liveSurfaceIds.has(surfaceId)) {
            ids[role].delete(surfaceId);
          }
        }
      }
    }
    for (const [surfaceId, override] of roleSurfaceOverrides) {
      if (liveSurfaceIds && !liveSurfaceIds.has(surfaceId)) {
        if (workspace && override.workspace === workspace) {
          roleSurfaceOverrides.delete(surfaceId);
        }
        continue;
      }
      ids[override.role].add(surfaceId);
    }
    return ids;
  };

  const getSurfaceDelivery = (surface: string) => {
    const deliveryId = latestDeliveryBySurface.get(surface);
    if (!deliveryId) {
      return null;
    }

    const record = deliveries.get(deliveryId);
    return record ? snapshotDelivery(record) : null;
  };

  const getSurfaceWriteConflict = (surface: string) => {
    const activeDeliveryId = activeDeliveryBySurface.get(surface);
    if (activeDeliveryId) {
      const record = deliveries.get(activeDeliveryId);
      if (record?.status === "delivering") {
        return new Error(
          `delivery ${activeDeliveryId} is still in progress for ${surface}`,
        );
      }

      activeDeliveryBySurface.delete(surface);
    }

    if (activeSurfaceWrites.has(surface)) {
      return new Error(`surface ${surface} is busy`);
    }

    return null;
  };

  const acquireSurfaceWrite = (surface: string, owner: string) => {
    const conflict = getSurfaceWriteConflict(surface);
    if (conflict) {
      throw conflict;
    }

    activeSurfaceWrites.set(surface, owner);
  };

  const releaseSurfaceWrite = (surface: string, owner: string) => {
    if (activeSurfaceWrites.get(surface) === owner) {
      activeSurfaceWrites.delete(surface);
    }
  };

  const withSurfaceWrite = async <T>(
    surface: string,
    fn: () => Promise<T>,
    owner = `surface-write:${randomUUID()}`,
  ): Promise<T> => {
    acquireSurfaceWrite(surface, owner);
    try {
      return await fn();
    } finally {
      releaseSurfaceWrite(surface, owner);
    }
  };

  const pruneCompletedDeliveryHistory = (surface: string) => {
    const latestDeliveryId = latestDeliveryBySurface.get(surface);
    for (const [deliveryId, record] of deliveries.entries()) {
      if (record.surface !== surface) continue;
      if (deliveryId === latestDeliveryId) continue;
      if (record.status === "delivering") continue;
      deliveries.delete(deliveryId);
    }
  };

  const finishDelivery = (
    record: DeliveryRecord,
    status: DeliveryStatus,
    error?: string,
    failedChunk?: number,
  ) => {
    record.status = status;
    record.completed_at = new Date().toISOString();
    record.error = error;
    record.failed_chunk = failedChunk;
    record.chunks = [];
    latestDeliveryBySurface.set(record.surface, record.delivery_id);
    if (activeDeliveryBySurface.get(record.surface) === record.delivery_id) {
      activeDeliveryBySurface.delete(record.surface);
    }
    releaseSurfaceWrite(record.surface, record.delivery_id);
    pruneCompletedDeliveryHistory(record.surface);
  };

  const sendChunkWithRetry = async (
    surface: string,
    chunk: string,
    opts: { workspace?: string },
    chunkNumber: number,
    totalChunks: number,
  ) => {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < SEND_INPUT_RETRY_ATTEMPTS) {
      try {
        await client.send(surface, chunk, opts);
        return;
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (
          !isRetryableDeliveryError(error) ||
          attempt >= SEND_INPUT_RETRY_ATTEMPTS
        ) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new DeliveryError(
            `chunk ${chunkNumber}/${totalChunks} failed: ${message}`,
            chunkNumber,
          );
        }
        await delay(SEND_INPUT_RETRY_DELAY_MS);
      }
    }

    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new DeliveryError(
      `chunk ${chunkNumber}/${totalChunks} failed: ${message}`,
      chunkNumber,
    );
  };

  const sendKeyWithRetry = async (
    surface: string,
    key: string,
    workspace?: string,
  ) => {
    let attempt = 0;

    while (attempt < SEND_INPUT_RETRY_ATTEMPTS) {
      try {
        await client.sendKey(surface, key, { workspace });
        return;
      } catch (error) {
        attempt += 1;
        if (
          !isRetryableDeliveryError(error) ||
          attempt >= SEND_INPUT_RETRY_ATTEMPTS
        ) {
          throw error;
        }
        await delay(SEND_INPUT_RETRY_DELAY_MS);
      }
    }
  };

  const appendDeliveryEvent = (event: Omit<DeliveryTelemetryEvent, "ts">) => {
    eventLog.appendDelivery({
      ts: new Date().toISOString(),
      ...event,
    });
  };

  const readParsedSurface = async (
    surface: string,
    workspace?: string,
  ): Promise<{ text: string; parsed: ParsedScreenResult } | null> => {
    try {
      const screen = await client.readScreen(surface, {
        ...(workspace ? { workspace } : {}),
        lines: 30,
      });
      const text = typeof screen === "string" ? screen : (screen.text ?? "");
      const parsed = enrichParsedScreen(
        parseScreen(text),
        text,
        pickLatestSurfaceModel(stateMgr, surface),
      );
      return { text, parsed };
    } catch {
      return null;
    }
  };

  const maybeRenameTask = async (opts: {
    surface: string;
    workspace?: string;
    rename_to_task?: string;
  }) => {
    if (!opts.rename_to_task) {
      return;
    }

    const surfaces = await client.listPaneSurfaces({
      workspace: opts.workspace,
    });
    const surface = surfaces.surfaces.find((s) => s.ref === opts.surface);
    const currentTitle = surface?.title ?? "";
    const newTitle = replaceTaskSuffix(currentTitle, opts.rename_to_task);
    await client.renameTab(opts.surface, newTitle, {
      workspace: opts.workspace,
    });
  };

  const verifySubmitAfterEnter = async (opts: {
    surface: string;
    workspace?: string;
    text: string;
    bytes: number;
    source_event: DeliveryEventType;
    source_agent?: string | null;
    verify_submit: boolean;
  }): Promise<{ submit_verified: boolean | null; retry_count: number }> => {
    if (!opts.verify_submit) {
      return { submit_verified: null, retry_count: 0 };
    }

    const startedAt = Date.now();
    let retried = false;
    let retryCount = 0;

    while (Date.now() - startedAt < SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS) {
      const snapshot = await readParsedSurface(opts.surface, opts.workspace);
      if (!snapshot) {
        return { submit_verified: null, retry_count: retryCount };
      }

      if (snapshot.parsed.agent_type === "unknown" || !snapshot.text.trim()) {
        return { submit_verified: null, retry_count: retryCount };
      }

      if (isSubmitVerifiedStatus(snapshot.parsed.status)) {
        return { submit_verified: true, retry_count: retryCount };
      }

      if (!screenShowsPendingInput(snapshot.text, opts.text)) {
        // The submitted text is no longer echoed in the input box: the terminal
        // accepted it and cleared the prompt, even if the agent has already
        // settled back to idle. Treat that as a verified landing.
        return { submit_verified: true, retry_count: retryCount };
      }

      // The submitted text is still pending in the input box. Retry Enter once,
      // then keep polling; if it never clears (a frozen terminal) we fall
      // through to the timeout below and report the relay as unverified.
      if (!retried) {
        await delay(SEND_INPUT_RECOVERY_ENTER_DELAY_MS);
        await sendKeyWithRetry(opts.surface, "return", opts.workspace);
        retryCount += 1;
        appendDeliveryEvent({
          event_type: "press_enter",
          source_agent: opts.source_agent ?? null,
          target_surface: opts.surface,
          bytes: opts.bytes,
          press_enter: true,
          submit_verified: null,
          retry_count: retryCount,
        });
        retried = true;
        continue;
      }

      await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
    }
    return { submit_verified: false, retry_count: retryCount };
  };

  const deliverInputChunks = async (opts: {
    surface: string;
    workspace?: string;
    chunks: string[];
    chunk_size: number;
    chunk_delay_ms: number;
    press_enter: boolean;
    rename_to_task?: string;
    onChunkDelivered?: (sentChunks: number) => void;
    source_event?: DeliveryEventType;
    source_agent?: string | null;
    verify_submit?: boolean;
  }): Promise<{
    bytes: number;
    retry_count: number;
    submit_verified: boolean | null;
  }> => {
    for (const [index, chunk] of opts.chunks.entries()) {
      await sendChunkWithRetry(
        opts.surface,
        chunk,
        {
          workspace: opts.workspace,
        },
        index + 1,
        opts.chunks.length,
      );
      opts.onChunkDelivered?.(index + 1);
      if (index < opts.chunks.length - 1) {
        await delay(opts.chunk_delay_ms);
      }
    }

    const bytes = opts.chunks.reduce(
      (sum, chunk) => sum + Buffer.byteLength(chunk, "utf-8"),
      0,
    );
    let submit_verified: boolean | null = null;
    let retry_count = 0;

    if (opts.press_enter) {
      await delay(computeEnterDelayMs(bytes, opts.chunks.length));
      await sendKeyWithRetry(opts.surface, "return", opts.workspace);
      appendDeliveryEvent({
        event_type: "press_enter",
        source_agent: opts.source_agent ?? null,
        target_surface: opts.surface,
        bytes,
        press_enter: true,
        submit_verified: null,
        retry_count,
      });

      const verification = await verifySubmitAfterEnter({
        surface: opts.surface,
        workspace: opts.workspace,
        text: opts.chunks.join(""),
        bytes,
        source_event: opts.source_event ?? "send_command",
        source_agent: opts.source_agent,
        verify_submit: opts.verify_submit ?? false,
      });
      submit_verified = verification.submit_verified;
      retry_count = verification.retry_count;
    }

    await maybeRenameTask({
      surface: opts.surface,
      workspace: opts.workspace,
      rename_to_task: opts.rename_to_task,
    });

    if (opts.source_event) {
      appendDeliveryEvent({
        event_type: opts.source_event,
        source_agent: opts.source_agent ?? null,
        target_surface: opts.surface,
        bytes,
        press_enter: opts.press_enter,
        submit_verified,
        retry_count,
      });
    }

    if (submit_verified === false) {
      throw new Error(
        `Enter submit could not be verified for ${opts.surface} within ${SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS}ms`,
      );
    }

    return { bytes, retry_count, submit_verified };
  };

  const waitForBootPromptReady = async (opts: {
    surface: string;
    workspace?: string;
    cli?: CliType;
    timeout_ms: number;
  }): Promise<void> => {
    const start = Date.now();
    let lastText = "";
    const consecutiveMatches = new Map<CliType, number>();
    const candidates = readyPatternCandidates(opts.cli);

    while (Date.now() - start < opts.timeout_ms) {
      try {
        const screen = await client.readScreen(opts.surface, {
          workspace: opts.workspace,
          lines: 80,
          scrollback: false,
        });
        lastText = screen.text;

        for (const candidate of candidates) {
          const match = matchReadyPattern(candidate, screen.text);
          const count = match.matched
            ? (consecutiveMatches.get(candidate) ?? 0) + 1
            : 0;
          consecutiveMatches.set(candidate, count);
          if (count >= match.consecutive) {
            return;
          }
        }
      } catch (error) {
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining = opts.timeout_ms - (Date.now() - start);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(BOOT_PROMPT_READY_POLL_MS, remaining));
    }

    throw new BootPromptTimeoutError(
      `Timed out after ${opts.timeout_ms}ms waiting for boot prompt readiness on ${opts.surface}`,
      tailLines(lastText, 10),
    );
  };

  const deliverBootPrompt = async (opts: {
    surface: string;
    workspace?: string;
    cli?: CliType;
    prompt?: string;
    boot_prompt_path?: string | null;
    timeout_ms?: number;
  }): Promise<{
    bytes: number;
    retry_count: number;
    submit_verified: boolean | null;
    prompt_text: string | null;
  }> => {
    const bootPromptPath = getBootPromptPath(opts.boot_prompt_path);
    assertBootPromptMode(opts.prompt, bootPromptPath);
    if (!hasInlinePrompt(opts.prompt) && !bootPromptPath) {
      return {
        bytes: 0,
        retry_count: 0,
        submit_verified: null,
        prompt_text: null,
      };
    }

    await waitForBootPromptReady({
      surface: opts.surface,
      workspace: opts.workspace,
      cli: opts.cli,
      timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
    });

    const rawPrompt = bootPromptPath
      ? await readFile(bootPromptPath, "utf8")
      : opts.prompt!;
    const sanitizedText = sanitizeTerminalInput(rawPrompt);
    const chunks =
      sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
        ? chunkTerminalInput(sanitizedText, SEND_INPUT_CHUNK_THRESHOLD)
        : [sanitizedText];
    let sentChunks = 0;

    try {
      const delivery = await withSurfaceWrite(opts.surface, async () =>
        deliverInputChunks({
          surface: opts.surface,
          workspace: opts.workspace,
          chunks,
          chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
          chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
          press_enter: true,
          onChunkDelivered: (count) => {
            sentChunks = count;
          },
          verify_submit: sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD,
        }),
      );
      return { ...delivery, prompt_text: rawPrompt };
    } catch (error) {
      const deliveredChars = chunks
        .slice(0, sentChunks)
        .reduce((sum, chunk) => sum + chunk.length, 0);
      const message = error instanceof Error ? error.message : String(error);
      throw new BootPromptDeliveryError(
        `Boot prompt delivery failed after ${deliveredChars} chars: ${message}`,
        deliveredChars,
      );
    }
  };

  const startBackgroundDelivery = (record: DeliveryRecord) => {
    acquireSurfaceWrite(record.surface, record.delivery_id);
    deliveries.set(record.delivery_id, record);
    latestDeliveryBySurface.set(record.surface, record.delivery_id);
    activeDeliveryBySurface.set(record.surface, record.delivery_id);
    pruneCompletedDeliveryHistory(record.surface);

    const run = async () => {
      try {
        await deliverInputChunks({
          surface: record.surface,
          workspace: record.workspace,
          chunks: record.chunks,
          chunk_size: record.chunk_size,
          chunk_delay_ms: record.chunk_delay_ms,
          press_enter: record.press_enter,
          rename_to_task: record.rename_to_task,
          onChunkDelivered: (sentChunks) => {
            record.sent_chunks = sentChunks;
          },
        });
        finishDelivery(record, "delivered");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedChunk =
          error instanceof DeliveryError ? error.failed_chunk : undefined;
        finishDelivery(record, "failed", message, failedChunk);
      }
    };

    setTimeout(() => {
      void run();
    }, 0);
  };

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
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Return the current full schema instead of the condensed default",
        ),
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
        const uniqueSurfaceEntries: Array<{
          group: {
            workspace_ref: string;
            window_ref: string;
            pane_ref: string;
            surfaces: CmuxSurface[];
          };
          surface: CmuxSurface;
        }> = [];
        const seenSurfaceRefs = new Set<string>();
        let anonymousSurfaceIndex = 0;

        for (const group of surfaceGroups) {
          for (const surface of group.surfaces) {
            const dedupeKey =
              typeof surface.ref === "string" && surface.ref.length > 0
                ? surface.ref
                : `${group.workspace_ref}:${group.pane_ref}:anonymous:${anonymousSurfaceIndex++}`;

            if (seenSurfaceRefs.has(dedupeKey)) {
              continue;
            }

            seenSurfaceRefs.add(dedupeKey);
            uniqueSurfaceEntries.push({ group, surface });
          }
        }

        const verboseSurfaces = await Promise.all(
          uniqueSurfaceEntries.map(async ({ group, surface }) => {
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
        );

        const verboseWorkspaces = workspaces.workspaces as unknown as Array<
          Record<string, unknown>
        >;
        const responseWorkspaces = args.verbose
          ? verboseWorkspaces
          : verboseWorkspaces.map((workspace) => toMinimalWorkspace(workspace));
        const responseSurfaces = args.verbose
          ? verboseSurfaces
          : verboseSurfaces.map((surface) => toMinimalSurface(surface));

        const data: Record<string, unknown> = {
          workspaces: responseWorkspaces,
          surfaces: responseSurfaces,
        };
        if (args.workspace) {
          data.workspace_ref = args.workspace;
        }
        const formatted = formatListSurfaces(
          responseSurfaces as Array<{
            ref?: string;
            title?: string;
            type?: string;
            workspace_ref?: string;
            pane_ref?: string;
            screen_preview?: string;
          }>,
          responseWorkspaces as Array<{ ref: string; title?: string }>,
        );
        return okFormatted(formatted, data);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "select_workspace",
    "Focus a workspace tab so subsequent terminal input is delivered to the intended workspace.",
    {
      workspace: z.string().describe("Target workspace ref"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        await client.selectWorkspace(args.workspace);
        const data = { workspace: args.workspace };
        return okFormatted(formatOk("select_workspace", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 2. new_split
  server.tool(
    "new_split",
    "Create a new split pane (terminal or browser). For terminal panes that boot an agent, boot_prompt_path can deliver a file prompt after the agent reaches a ready prompt.",
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
      role: z
        .enum(["orchestrator", "ic", "worker"])
        .optional()
        .describe(
          "Optional agent role used for deterministic placement. Defaults from title launcher suffix: *Claude=orchestrator, *Codex/*Cursor=worker.",
        ),
      focus: z
        .boolean()
        .optional()
        .default(true)
        .describe("Focus the new pane"),
      boot_prompt_path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional path to a prompt file to read after readiness and submit to the new terminal surface. Checked before pane creation. Mutually exclusive with inline prompt fields.",
        ),
      boot_prompt_timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .default(BOOT_PROMPT_TIMEOUT_MS)
        .describe("Timeout in milliseconds waiting for the agent ready prompt"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      let result: CmuxNewSplitResult | undefined;
      try {
        const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
        if (bootPromptPath) {
          if ((args.type ?? "terminal") !== "terminal") {
            throw new Error("boot_prompt_path is only supported for terminal surfaces");
          }
          await preflightBootPromptFile(bootPromptPath);
        }

        const shouldInferRole =
          Boolean(args.role) ||
          Boolean(
            args.title &&
              /(Claude|Codex|Cursor)$/i.test(args.title) &&
              !args.pane &&
              !args.surface,
          );
        const inferredRole = shouldInferRole
          ? inferAgentRole({ role: args.role, title: args.title })
          : null;
        let actualPlacement: "split" | "surface" = "split";
        let actualDirection: string | null = args.direction;
        if (inferredRole && (args.type ?? "terminal") === "terminal") {
          if (args.pane || args.surface) {
            throw new Error(
              "pane/surface cannot be combined with role-based new_split; omit the explicit target or omit role",
            );
          }
          const panes = await client.listPanes({ workspace: args.workspace });
          const paneSurfaces = await Promise.all(
            panes.panes.map((pane) =>
              client.listPaneSurfaces({
                workspace: args.workspace,
                pane: pane.ref,
              }),
            ),
          );
          const liveSurfaceIds = new Set(
            paneSurfaces.flatMap((group) =>
              group.surfaces.map((surface) => surface.ref),
            ),
          );
          const placement = chooseAgentSpawnPlacement(
            panes.panes,
            paneSurfaces,
            collectServerRoleSurfaceIds(liveSurfaceIds, args.workspace),
            { role: inferredRole },
          );
          actualPlacement = placement.kind;
          actualDirection =
            placement.kind === "split" ? placement.direction : null;
          if (placement.kind === "surface" && args.focus === false) {
            throw new Error(
              "focus=false is not supported when role-based new_split reuses an existing pane as a tab",
            );
          }
          result =
            placement.kind === "surface"
              ? await client.newSurface({
                  pane: placement.pane,
                  workspace: args.workspace,
                  type: "terminal",
                })
              : await client.newSplit(placement.direction, {
                  workspace: args.workspace,
                  ...(placement.pane ? { pane: placement.pane } : {}),
                  surface: args.surface,
                  type: args.type,
                  url: args.url,
                  title: args.title,
                  focus: args.focus,
                });
        } else {
          result = await client.newSplit(args.direction, {
            workspace: args.workspace,
            surface: args.surface,
            pane: args.pane,
            type: args.type,
            url: args.url,
            title: args.title,
            focus: args.focus,
          });
        }
        if (args.title) {
          await client.renameTab(result.surface, args.title, {
            workspace: result.workspace || args.workspace,
          });
          result.title = args.title;
        }
        if (inferredRole && (args.type ?? "terminal") === "terminal") {
          roleSurfaceOverrides.set(result.surface, {
            role: inferredRole,
            workspace: result.workspace ?? args.workspace ?? null,
          });
        }
        let bootPromptDelivery:
          | Awaited<ReturnType<typeof deliverBootPrompt>>
          | undefined;
        if (bootPromptPath) {
          bootPromptDelivery = await deliverBootPrompt({
            surface: result.surface,
            workspace: result.workspace || args.workspace,
            boot_prompt_path: bootPromptPath,
            timeout_ms: args.boot_prompt_timeout_ms,
          });
        }
        const data: Record<string, unknown> = { ...result };
        data.placement = actualPlacement;
        data.direction = actualDirection;
        if (inferredRole) {
          data.role = inferredRole;
        }
        if (bootPromptDelivery) {
          data.boot_prompt_delivered = true;
          data.boot_prompt_bytes = bootPromptDelivery.bytes;
        }
        return okFormatted(
          formatOk("new_split", {
            surface: result.surface,
            direction: actualDirection,
            placement: actualPlacement,
            type: args.type,
            title: result.title,
            role: inferredRole ?? undefined,
            boot_prompt_delivered: Boolean(bootPromptDelivery),
          }),
          data,
        );
      } catch (e) {
        if (e instanceof BootPromptTimeoutError) {
          return err(e, {
            surface: result?.surface,
            last_10_lines: e.last_10_lines,
          });
        }
        if (e instanceof BootPromptDeliveryError) {
          return err(e, {
            surface: result?.surface,
            delivered_chars: e.delivered_chars,
          });
        }
        return err(e);
      }
    },
  );

  // 3. new_surface
  server.tool(
    "new_surface",
    "Create a new surface (tab) in an existing pane. For terminal tabs that boot an agent, boot_prompt_path can deliver a file prompt after the agent reaches a ready prompt.",
    {
      pane: z.string().describe("Target pane ref"),
      workspace: z.string().optional().describe("Target workspace ref"),
      type: z
        .enum(["terminal", "browser"])
        .optional()
        .default("terminal")
        .describe("Surface type"),
      title: z.string().optional().describe("Tab title"),
      url: z.string().optional().describe("URL for browser surfaces"),
      boot_prompt_path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional path to a prompt file to read after readiness and submit to the new terminal surface. Checked before tab creation.",
        ),
      boot_prompt_timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .default(BOOT_PROMPT_TIMEOUT_MS)
        .describe("Timeout in milliseconds waiting for the agent ready prompt"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      let result: CmuxNewSurfaceResult | undefined;
      try {
        const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
        if (bootPromptPath) {
          if ((args.type ?? "terminal") !== "terminal") {
            throw new Error("boot_prompt_path is only supported for terminal surfaces");
          }
          await preflightBootPromptFile(bootPromptPath);
        }

        result = await client.newSurface({
          pane: args.pane,
          workspace: args.workspace,
          type: args.type,
          url: args.url,
        });
        if (args.title) {
          await client.renameTab(result.surface, args.title, {
            workspace: result.workspace || args.workspace,
          });
          result.title = args.title;
        }
        let bootPromptDelivery:
          | Awaited<ReturnType<typeof deliverBootPrompt>>
          | undefined;
        if (bootPromptPath) {
          bootPromptDelivery = await deliverBootPrompt({
            surface: result.surface,
            workspace: result.workspace || args.workspace,
            boot_prompt_path: bootPromptPath,
            timeout_ms: args.boot_prompt_timeout_ms,
          });
        }
        const data: Record<string, unknown> = { ...result };
        if (bootPromptDelivery) {
          data.boot_prompt_delivered = true;
          data.boot_prompt_bytes = bootPromptDelivery.bytes;
        }
        return okFormatted(
          formatOk("new_surface", {
            pane: args.pane,
            surface: result.surface,
            type: result.type,
            title: result.title,
            boot_prompt_delivered: Boolean(bootPromptDelivery),
          }),
          data,
        );
      } catch (e) {
        if (e instanceof BootPromptTimeoutError) {
          return err(e, {
            surface: result?.surface,
            last_10_lines: e.last_10_lines,
          });
        }
        if (e instanceof BootPromptDeliveryError) {
          return err(e, {
            surface: result?.surface,
            delivered_chars: e.delivered_chars,
          });
        }
        return err(e);
      }
    },
  );

  // 4. move_surface
  server.tool(
    "move_surface",
    "Move a surface (tab) between panes or workspaces",
    {
      surface: z.string().describe("Surface ref to move"),
      pane: z.string().optional().describe("Target pane ref"),
      workspace: z.string().optional().describe("Target workspace ref"),
      before: z.string().optional().describe("Insert before this surface ref"),
      after: z.string().optional().describe("Insert after this surface ref"),
      index: z.number().int().optional().describe("Insert at this tab index"),
      focus: z
        .boolean()
        .optional()
        .describe("Whether to focus the moved surface"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const result = await client.moveSurface({
          surface: args.surface,
          pane: args.pane,
          workspace: args.workspace,
          before: args.before,
          after: args.after,
          index: args.index,
          focus: args.focus,
        });
        const data = { ...result };
        return okFormatted(
          formatOk("move_surface", {
            surface: result.surface,
            pane: result.pane,
            workspace: result.workspace,
          }),
          data,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  // 5. reorder_surface
  server.tool(
    "reorder_surface",
    "Reorder a surface (tab) within its current pane",
    {
      surface: z.string().describe("Surface ref to reorder"),
      index: z.number().int().optional().describe("Move to this tab index"),
      before: z.string().optional().describe("Insert before this surface ref"),
      after: z.string().optional().describe("Insert after this surface ref"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const result = await client.reorderSurface({
          surface: args.surface,
          index: args.index,
          before: args.before,
          after: args.after,
        });
        const data = { ...result };
        return okFormatted(
          formatOk("reorder_surface", {
            surface: result.surface,
          }),
          data,
        );
      } catch (e) {
        return err(e);
      }
    },
  );

  // 6. send_input
  server.tool(
    "send_input",
    "Send text input to a terminal surface. Long text over 500 characters is automatically chunked into line-aligned batches before delivery, and each chunk waits for cmux acknowledgment before the next is sent. Set background=true to return immediately with a delivery_id while chunking continues in the background. For full commands, prefer send_command so text and return land on the same surface atomically.",
    {
      surface: z.string().describe("Target surface ref"),
      text: z.string().describe("Text to send"),
      workspace: z.string().optional().describe("Target workspace ref"),
      chunk_size: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(200)
        .describe("Chunk size for automatic long-text delivery"),
      background: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Return immediately with a delivery_id and continue chunked delivery in the background",
        ),
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
        const chunks =
          sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
            ? chunkTerminalInput(sanitizedText, args.chunk_size)
            : [sanitizedText];

        if (args.background) {
          const record: DeliveryRecord = {
            delivery_id: randomUUID(),
            surface: args.surface,
            workspace: args.workspace,
            status: "delivering",
            total_chunks: chunks.length,
            sent_chunks: 0,
            chunk_size: args.chunk_size,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            chunks,
            press_enter: args.press_enter,
            rename_to_task: args.rename_to_task,
            started_at: new Date().toISOString(),
          };
          startBackgroundDelivery(record);

          const data = {
            surface: args.surface,
            delivery_id: record.delivery_id,
            status: record.status,
          };
          return okFormatted(formatOk("send_input", data), data);
        }

        await withSurfaceWrite(args.surface, async () => {
          await deliverInputChunks({
            surface: args.surface,
            workspace: args.workspace,
            chunks,
            chunk_size: args.chunk_size,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: args.press_enter,
            rename_to_task: args.rename_to_task,
          });
        });

        const data = { surface: args.surface };
        return okFormatted(formatOk("send_input", data), data);
      } catch (e) {
        if (e instanceof DeliveryError) {
          return err(e, { failed_chunk: e.failed_chunk ?? null });
        }
        return err(e);
      }
    },
  );

  // 7. send_command
  server.tool(
    "send_command",
    "Atomically send a command and press return on the same surface. Prefer this over separate send_input + send_key calls when launching or resuming agents. For known agent launchers with -s (for example brainlayerCodex -s), boot_prompt_path reads a prompt file after the launcher reaches readiness and submits it; passing boot_prompt_path for plain shell commands is rejected.",
    {
      surface: z.string().describe("Target surface ref"),
      command: z
        .string()
        .describe("Command text to send before pressing return"),
      workspace: z.string().optional().describe("Target workspace ref"),
      boot_prompt_path: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Optional path to a prompt file for launcher commands matching <repo>Codex|Claude|Cursor|Gemini|Kiro with -s. File is checked before sending the launcher and read after readiness.",
        ),
      boot_prompt_timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .default(BOOT_PROMPT_TIMEOUT_MS)
        .describe("Timeout in milliseconds waiting for the agent ready prompt"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
        const launcherCli = bootPromptPath
          ? inferLauncherCli(args.command)
          : null;
        if (bootPromptPath && !launcherCli) {
          throw new Error(
            "boot_prompt_path is only supported for agent launcher commands with -s",
          );
        }
        if (bootPromptPath) {
          await preflightBootPromptFile(bootPromptPath);
        }

        const sanitizedCommand = sanitizeTerminalInput(args.command);
        const chunks =
          sanitizedCommand.length > SEND_INPUT_CHUNK_THRESHOLD
            ? chunkTerminalInput(sanitizedCommand, SEND_INPUT_CHUNK_THRESHOLD)
            : [sanitizedCommand];

        const delivery = await withSurfaceWrite(args.surface, async () =>
          deliverInputChunks({
            surface: args.surface,
            workspace: args.workspace,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: true,
            source_event: "send_command",
            verify_submit:
              sanitizedCommand.length > SEND_INPUT_CHUNK_THRESHOLD,
          }),
        );

        let bootPromptDelivery:
          | Awaited<ReturnType<typeof deliverBootPrompt>>
          | undefined;
        if (bootPromptPath && launcherCli) {
          bootPromptDelivery = await deliverBootPrompt({
            surface: args.surface,
            workspace: args.workspace,
            cli: launcherCli,
            boot_prompt_path: bootPromptPath,
            timeout_ms: args.boot_prompt_timeout_ms,
          });
        }

        const data = {
          surface: args.surface,
          command: sanitizedCommand,
          retry_count: delivery.retry_count,
          submit_verified: delivery.submit_verified,
          boot_prompt_delivered: Boolean(bootPromptDelivery),
          boot_prompt_bytes: bootPromptDelivery?.bytes,
        };
        return okFormatted(formatOk("send_command", data), data);
      } catch (e) {
        if (e instanceof BootPromptTimeoutError) {
          return err(e, { last_10_lines: e.last_10_lines });
        }
        if (e instanceof BootPromptDeliveryError) {
          return err(e, { delivered_chars: e.delivered_chars });
        }
        if (e instanceof DeliveryError) {
          return err(e, { failed_chunk: e.failed_chunk ?? null });
        }
        return err(e);
      }
    },
  );

  // 8. send_key
  server.tool(
    "send_key",
    "Send a key press to a terminal surface. Accepted Ctrl+C aliases are normalized automatically: ctrl-c, C-c, ^c, Ctrl+C, Ctrl-C.",
    {
      surface: z.string().describe("Target surface ref"),
      key: z
        .string()
        .describe("Key name (e.g. 'return', 'escape', 'tab', 'ctrl-c')"),
      workspace: z.string().optional().describe("Target workspace ref"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const key = normalizeKeyName(args.key);
        await withSurfaceWrite(args.surface, async () => {
          await sendKeyWithRetry(args.surface, key, args.workspace);
        });
        const data = { surface: args.surface, key };
        return okFormatted(formatOk("send_key", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 9. read_screen
  server.tool(
    "read_screen",
    "Read terminal screen with parsed agent status. Returns parsed fields: agent_type, status, model, token_count, context_pct (% used), context_window (max tokens), cost, done_signal, response, errors, plus delivery metadata for the current or most recent background send_input operation. Use parsed_only=true for monitoring (omits raw terminal content).",
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
            delivery: getSurfaceDelivery(result.surface),
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
          delivery: getSurfaceDelivery(result.surface),
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
        await withSurfaceWrite(args.surface, async () => {
          await client.renameTab(args.surface, finalTitle, {
            workspace: args.workspace,
          });
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
        let closePolicy:
          | ReturnType<typeof chooseSurfaceClosePolicy>
          | undefined;

        try {
          const identified = args.workspace
            ? null
            : await client.identify(args.surface);
          const workspace =
            args.workspace ??
            identified?.caller?.workspace_ref ??
            identified?.focused?.workspace_ref;
          if (workspace) {
            const panes = await client.listPanes({ workspace });
            const paneSurfaces = await Promise.all(
              panes.panes.map((pane) =>
                client.listPaneSurfaces({ workspace, pane: pane.ref }),
              ),
            );
            const workerSurfaceIds = new Set(
              stateMgr.listStates().map((record) => record.surface_id),
            );
            closePolicy = chooseSurfaceClosePolicy(
              panes.panes,
              paneSurfaces,
              workerSurfaceIds,
              args.surface,
            );
          }
        } catch {
          // Layout hints are best-effort only; the close itself must still run.
        }

        await client.closeSurface(args.surface, {
          workspace: args.workspace,
        });
        const data = {
          surface: args.surface,
          pane: closePolicy?.pane ?? undefined,
          collapse_pane: closePolicy?.collapsePane ?? false,
        };
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
    lifecycleRegistry = registry;
    const discovery = new AgentDiscovery({
      listSurfaces: surfaceProvider,
      readScreen: (surface, opts) => client.readScreen(surface, opts),
    });
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
    const engine = new AgentEngine(
      stateMgr,
      registry,
      {
        log: (message, eventOpts) => client.log(message, eventOpts),
        setStatus: (key, value, statusOpts) =>
          client.setStatus(key, value, statusOpts),
        clearStatus: (key, clearOpts) => client.clearStatus(key, clearOpts),
        readScreen: (surface, readOpts) => client.readScreen(surface, readOpts),
        send: (surface, text, sendOpts) =>
          withSurfaceWrite(surface, () => client.send(surface, text, sendOpts)),
        sendKey: (surface, key, keyOpts) =>
          withSurfaceWrite(surface, () =>
            client.sendKey(surface, key, keyOpts),
          ),
        setProgress: (value, progressOpts) =>
          client.setProgress(value, progressOpts),
        newSplit: (direction, splitOpts) =>
          client.newSplit(direction, splitOpts),
        newSurface: (surfaceOpts) => client.newSurface(surfaceOpts),
        listPanes: (paneOpts) => client.listPanes(paneOpts),
        listPaneSurfaces: (surfaceOpts) => client.listPaneSurfaces(surfaceOpts),
        closeSurface: (surface, closeOpts) =>
          withSurfaceWrite(surface, () =>
            client.closeSurface(surface, closeOpts),
          ),
        notifyLifecycleEvent,
      },
      {
        spawnPreflight:
          opts?.spawnPreflight ??
          (opts?.disableSpawnPreflight ? async () => {} : undefined),
        roleSurfaceIdsProvider: collectServerRoleSurfaceIds,
      },
    );

    const deliverAgentInput = async (args: {
      agent_id: string;
      text: string;
      press_enter: boolean;
      allow_busy?: boolean;
      source_event: DeliveryEventType;
    }) => {
      const route = engine.resolveAgentRoute(args.agent_id);
      if (!args.allow_busy && !INTERACTIVE_AGENT_STATES.has(route.state)) {
        throw new Error(
          `Agent "${args.agent_id}" is not in an interactive state (current: ${route.state}). ` +
            `Must be in: ${[...INTERACTIVE_AGENT_STATES].join(", ")}. ` +
            `Pass allow_busy: true to bypass this gate and deliver raw keystrokes regardless of state.`,
        );
      }

      const sanitizedText = sanitizeTerminalInput(args.text);
      const chunks =
        sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
          ? chunkTerminalInput(sanitizedText, SEND_INPUT_CHUNK_THRESHOLD)
          : [sanitizedText];

      return withSurfaceWrite(route.surface_id, async () =>
        deliverInputChunks({
          surface: route.surface_id,
          chunks,
          chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
          chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
          press_enter: args.press_enter,
          source_event: args.source_event,
          source_agent: args.agent_id,
          // Verify every relay to an interactive agent — not just long ones.
          // A short relay (the common agent-to-agent case) to a frozen
          // terminal must be caught, never reported as ok. allow_busy sends to
          // a non-interactive (working) agent stay unverified to avoid
          // false-failing a legitimate interjection.
          verify_submit:
            args.press_enter && INTERACTIVE_AGENT_STATES.has(route.state),
        }),
      );
    };

    // Reconstitute registry from disk on startup (async, best-effort).
    // Enable startup purge so the first sweep clears stale terminal-state
    // agents from previous cmux sessions.
    registry
      .reconstitute()
      .then(() => engine.enableStartupPurge())
      .catch((e) =>
        console.error("[cmux-mcp] registry reconstitution failed:", e),
      );
    engine.startSweep(5000);

    // 11. spawn_agent
    server.tool(
      "spawn_agent",
      "Spawn an AI agent in a new terminal surface. If prompt or boot_prompt_path is provided, waits for the agent ready prompt, submits that boot prompt, and returns after submission. boot_prompt_path is checked before spawning and read after readiness. Without a boot prompt, returns immediately and wait_for can be used separately.",
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
        prompt: z
          .string()
          .optional()
          .describe(
            "Inline task prompt to send after the agent is ready. Mutually exclusive with boot_prompt_path.",
          ),
        boot_prompt_path: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Optional path to a prompt file. The file is checked before spawning, read after readiness, sent with chunked delivery, then submitted with return. Mutually exclusive with prompt.",
          ),
        boot_prompt_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .default(BOOT_PROMPT_TIMEOUT_MS)
          .describe("Timeout in milliseconds waiting for the agent ready prompt"),
        workspace: z.string().optional().describe("Target workspace ref"),
        parent_agent_id: z
          .string()
          .optional()
          .describe(
            "ID of the parent agent for hierarchical spawning. Parent must exist.",
          ),
        role: z
          .enum(["orchestrator", "ic", "worker"])
          .optional()
          .describe(
            "Optional placement role. Defaults from launcher: *Claude=orchestrator, *Codex/*Cursor=worker.",
          ),
        auto_archive_on_done: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "When true, Codex worker panes that emit TASK_DONE are auto-closed after the inactivity window.",
          ),
        max_cost_per_agent: z
          .number()
          .optional()
          .describe("Maximum cost cap in USD for this agent"),
        crash_recover: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, automatically respawn the agent after unexpected PTY death using its captured CLI session ID.",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
          assertBootPromptMode(args.prompt, bootPromptPath);
          if (bootPromptPath) {
            await preflightBootPromptFile(bootPromptPath);
          }

          const result = await engine.spawnAgent({
            repo: args.repo,
            model: args.model,
            cli: args.cli,
            prompt: args.prompt ?? "",
            boot_prompt_pending: hasInlinePrompt(args.prompt) || Boolean(bootPromptPath),
            workspace: args.workspace,
            parent_agent_id: args.parent_agent_id,
            role: args.role,
            auto_archive_on_done: args.auto_archive_on_done ?? true,
            max_cost_per_agent: args.max_cost_per_agent,
            crash_recover: args.crash_recover,
          });

          let bootPromptDelivery:
            | Awaited<ReturnType<typeof deliverBootPrompt>>
            | undefined;
          try {
            if (hasInlinePrompt(args.prompt) || bootPromptPath) {
              bootPromptDelivery = await deliverBootPrompt({
                surface: result.surface_id,
                workspace: args.workspace,
                cli: args.cli,
                prompt: args.prompt,
                boot_prompt_path: bootPromptPath,
                timeout_ms: args.boot_prompt_timeout_ms,
              });

              if (bootPromptDelivery.prompt_text !== null) {
                const updated = stateMgr.updateRecord(result.agent_id, {
                  task_summary: bootPromptDelivery.prompt_text,
                  boot_prompt_pending: false,
                });
                registry.set(result.agent_id, updated);
              } else {
                const updated = stateMgr.updateRecord(result.agent_id, {
                  boot_prompt_pending: false,
                });
                registry.set(result.agent_id, updated);
              }

              const current = engine.getAgentState(result.agent_id);
              if (current?.state === "booting") {
                const ready = stateMgr.transition(result.agent_id, "ready");
                registry.set(result.agent_id, ready);
                result.state = "ready";
              } else if (current?.state === "ready") {
                result.state = "ready";
              }
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            try {
              let updated = stateMgr.updateRecord(result.agent_id, {
                boot_prompt_pending: false,
              });
              registry.set(result.agent_id, updated);
              if (updated.state !== "done" && updated.state !== "error") {
                updated = stateMgr.transition(result.agent_id, "error", {
                  error: `Boot prompt failed: ${message}`,
                });
                registry.set(result.agent_id, updated);
              }
            } catch {
              // Preserve the original boot prompt error response.
            }
            const extra = {
              agent_id: result.agent_id,
              surface_id: result.surface_id,
            };
            if (e instanceof BootPromptTimeoutError) {
              return err(e, { ...extra, last_10_lines: e.last_10_lines });
            }
            if (e instanceof BootPromptDeliveryError) {
              return err(e, { ...extra, delivered_chars: e.delivered_chars });
            }
            return err(e, extra);
          }

          return okFormatted(
            formatOk("spawn_agent", {
              agent_id: result.agent_id,
              repo: args.repo,
              model: args.model,
              surface: result.surface_id,
              role:
                engine.getAgentState(result.agent_id)?.role ??
                inferAgentRole({ role: args.role, cli: args.cli }),
              boot_prompt_delivered: Boolean(bootPromptDelivery),
            }),
            {
              ...result,
              role:
                engine.getAgentState(result.agent_id)?.role ??
                inferAgentRole({ role: args.role, cli: args.cli }),
              boot_prompt_delivered: Boolean(bootPromptDelivery),
              boot_prompt_bytes: bootPromptDelivery?.bytes,
            },
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    // 12. wait_for
    server.tool(
      "wait_for",
      "Block until an agent reaches a target state. Defaults to waiting for completion (`done`) so GUI clients can wait on an agent without knowing lifecycle choreography.",
      {
        agent_id: z.string().describe("Agent ID from spawn_agent"),
        target_state: z
          .enum(["ready", "working", "idle", "done", "error"])
          .optional()
          .default("done")
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
          const targetState = args.target_state ?? "done";
          const result = await engine.waitFor(
            args.agent_id,
            targetState,
            args.timeout_ms,
          );
          return okFormatted(
            formatOk("wait_for", {
              agent_id: args.agent_id,
              state: result.state,
            }),
            {
              agent_id: args.agent_id,
              ...result,
            },
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
          const merged = await registry.listMerged(discovery, {
            filter: {
              state: args.state,
              repo: args.repo,
              model: args.model,
            },
          });
          const agents = merged.map(toPublicAgent);
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

    server.tool(
      "resync_agents",
      "Force-refresh the agent registry by scanning all surfaces. Evicts ghosts, registers discovered agents, and returns a diff.",
      {},
      ANNOTATIONS.mutating,
      async () => {
        try {
          const beforeIds = new Set(
            registry.list().map((agent) => agent.agent_id),
          );
          discovery.invalidate();
          const after = await registry.listMerged(discovery, { force: true });
          const afterIds = new Set(after.map((agent) => agent.agent_id));
          const diff = {
            added: [...afterIds].filter((id) => !beforeIds.has(id)),
            evicted: [...beforeIds].filter((id) => !afterIds.has(id)),
            mismatches: after
              .filter((agent) => agent.parsed_cli_mismatch)
              .map((agent) => agent.agent_id),
          };

          return okFormatted(formatResync(diff), {
            diff,
            count: after.length,
          });
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

    // 17. send_to
    server.tool(
      "send_to",
      "Send text input to an agent by `agent_id`. Resolves the backing surface internally so clients do not need pane or surface references.",
      {
        ...SendToArgsSchema.shape,
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "If true, bypass the interactive-state gate and deliver raw keystrokes regardless of agent state (matches send_input behavior). Use to interject while an agent is working — e.g., to cancel, steer, or stack an instruction.",
        ),
      },
      ANNOTATIONS.mutating,
      async (rawArgs) => {
        try {
          const parsedArgs = SendToArgsSchema.safeParse(rawArgs);
          if (!parsedArgs.success) {
            return err(
              new Error(formatToolValidationError("send_to", parsedArgs.error)),
            );
          }

          const args = parsedArgs.data;
          const delivery = await deliverAgentInput({
            agent_id: args.agent_id,
            text: args.text,
            press_enter: args.press_enter,
            allow_busy: args.allow_busy,
            source_event: "send_to",
          });
          const data = {
            agent_id: args.agent_id,
            retry_count: delivery.retry_count,
            submit_verified: delivery.submit_verified,
          };
          return okFormatted(formatOk("send_to", data), data);
        } catch (e) {
          return err(e);
        }
      },
    );

    // 18. send_to_agent
    server.tool(
      "send_to_agent",
      "Deprecated for client integrations: use `send_to` instead. Internal/advanced path for sending text input to an agent in `ready` or `idle` state.",
      {
        ...SendToArgsSchema.shape,
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "If true, bypass the interactive-state gate and deliver raw keystrokes regardless of agent state (matches send_input behavior).",
        ),
      },
      ANNOTATIONS.mutating,
      async (rawArgs) => {
        try {
          const parsedArgs = SendToArgsSchema.safeParse(rawArgs);
          if (!parsedArgs.success) {
            return err(
              new Error(
                formatToolValidationError("send_to_agent", parsedArgs.error),
              ),
            );
          }

          const args = parsedArgs.data;
          const delivery = await deliverAgentInput({
            agent_id: args.agent_id,
            text: args.text,
            press_enter: args.press_enter,
            allow_busy: args.allow_busy,
            source_event: "send_to_agent",
          });
          const data = {
            agent_id: args.agent_id,
            retry_count: delivery.retry_count,
            submit_verified: delivery.submit_verified,
          };
          return okFormatted(formatOk("send_to_agent", data), data);
        } catch (e) {
          return err(e);
        }
      },
    );
    // 19. read_agent_output
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
              const delivery = await deliverAgentInput({
                agent_id: args.agent,
                text: args.text!,
                press_enter: true,
                source_event: "interact",
              });
              const d = {
                agent_id: args.agent,
                action: "send",
                retry_count: delivery.retry_count,
                submit_verified: delivery.submit_verified,
              };
              return okFormatted(formatOk("interact:send", d), d);
            }
            case "interrupt": {
              await withSurfaceWrite(agent.surface_id, () =>
                client.sendKey(agent.surface_id, "c-c", {}),
              );
              const d = { agent_id: args.agent, action: "interrupt" };
              return okFormatted(formatOk("interact:interrupt", d), d);
            }
            case "model": {
              const modelCmd = `/model ${args.model}`;
              const delivery = await deliverAgentInput({
                agent_id: args.agent,
                text: modelCmd,
                press_enter: true,
                source_event: "interact",
              });
              const d = {
                agent_id: args.agent,
                action: "model",
                model: args.model,
                retry_count: delivery.retry_count,
                submit_verified: delivery.submit_verified,
              };
              return okFormatted(formatOk("interact:model", d), d);
            }
            case "resume": {
              const resumeCmd = args.session_id
                ? `/resume ${args.session_id}`
                : "/resume";
              const delivery = await deliverAgentInput({
                agent_id: args.agent,
                text: resumeCmd,
                press_enter: true,
                source_event: "interact",
              });
              const d = {
                agent_id: args.agent,
                action: "resume",
                session_id: args.session_id,
                retry_count: delivery.retry_count,
                submit_verified: delivery.submit_verified,
              };
              return okFormatted(formatOk("interact:resume", d), d);
            }
            case "skill": {
              const delivery = await deliverAgentInput({
                agent_id: args.agent,
                text: args.command!,
                press_enter: true,
                source_event: "interact",
              });
              const d = {
                agent_id: args.agent,
                action: "skill",
                command: args.command,
                retry_count: delivery.retry_count,
                submit_verified: delivery.submit_verified,
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
          const merged = await registry.listMerged(discovery);
          const agents = args.parent_agent_id
            ? merged.filter(
                (agent) => agent.parent_agent_id === args.parent_agent_id,
              )
            : merged.filter((agent) => agent.parent_agent_id === null);

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
