/**
 * cmuxlayer MCP server — registers core tools + agent lifecycle tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, mkdtempSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CmuxClient, type ExecFn } from "./cmux-client.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import { assertMutationAllowed, parseReservedModeKey } from "./mode-policy.js";
import { extractPrefix, replaceTaskSuffix } from "./naming.js";
import { readVersion } from "./version.js";
import { StateManager } from "./state-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import {
  AgentEngine,
  buildLaunchCommand,
  resolveSweepTiming,
  type AgentLifecycleEvent,
  type SessionIdentityResolver,
  type SpawnAgentParams,
} from "./agent-engine.js";
import type { MonitorDeadmanNotify } from "./monitor-registry.js";
import { AgentDiscovery, type DiscoveredAgent } from "./agent-discovery.js";
import {
  resumeCommandForAgent,
  toAgentStatePayload,
  toPublicAgent,
} from "./agent-facade.js";
import {
  DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY,
  evaluateAgentHealth,
  type AgentHealthIssueCode,
} from "./agent-health.js";
import {
  AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
  AGENT_HEALTH_MONITOR_MAX_AGE_MS,
  buildAgentHealthInput,
  type AgentHealthInputOverrides,
} from "./agent-health-input.js";
import type {
  AgentRecord,
  AgentRole,
  AgentState,
  CliType,
  CloseTelemetryEvent,
  DeliveryEventType,
  DeliveryTelemetryEvent,
} from "./agent-types.js";
import {
  formatListSurfaces,
  formatReadScreen,
  formatListAgents,
  formatAgentState,
  formatOk,
  formatDelivery,
  formatResync,
} from "./format.js";
import {
  cleanScreenText,
  inferContextWindow,
  isCodexUpdateMenuScreen,
  parseScreen,
} from "./screen-parser.js";
import {
  dispatch,
  ensureInboxFile,
  inboxPath,
  monitorAlive,
  pendingDispatches,
  recommendedMonitorCommand,
  replayUndelivered,
  writeHeartbeat,
} from "./inbox.js";
import {
  applyHarnessState,
  harnessJsonlEnabled,
  loadHarnessSession,
  type Harness,
} from "./harness-session.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import {
  canInferAgentRole,
  collectRoleSurfaceIds,
  chooseAgentSpawnPlacement,
  chooseSurfaceClosePolicy,
  deriveColumnIndex,
  inferAgentRole,
  launcherNameForCli,
} from "./layout-policy.js";
import type {
  CmuxNewSplitResult,
  CmuxNewSurfaceResult,
  CmuxPane,
  CmuxSurface,
  CmuxStatusEntry,
  CmuxTerminalMetadata,
  CmuxWorkspace,
  ControlMode,
  ParsedScreenResult,
} from "./types.js";
import { normalizeKeyName } from "./key-names.js";
import {
  CLI_INPUT_PROMPT_PREFIXES,
  matchReadyPattern,
  screenHasActiveAgentMarker,
  screenHasReadyAgentIdentity,
} from "./pattern-registry.js";
import { reposEquivalent, resolveWorkspaceRefForRepo } from "./repo-workspace.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
import {
  collectControlHealth,
  formatControlHealth,
  type ControlHealth,
} from "./control-health.js";
import {
  collectSurfaceTopology as collectCmuxSurfaceTopology,
  EMPTY_SURFACE_TOPOLOGY,
  healthTopologyOverrides,
  type SurfaceTopology,
} from "./surface-topology.js";
import {
  formatMcpProfileEnv,
  prepareWorktree,
  type McpProfile,
  type WorktreeExec,
} from "./worktree.js";

type TextContent = { type: "text"; text: string };
type ToolReturn = {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

class SurfaceEnumerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceEnumerationError";
  }
}

function requireSurfaceEnumerationArray<T>(
  value: unknown,
  label: string,
): T[] {
  if (Array.isArray(value)) return value as T[];
  throw new SurfaceEnumerationError(
    `Malformed cmux surface enumeration: ${label} is not an array`,
  );
}

function isSurfaceEnumerationError(error: unknown): boolean {
  return error instanceof SurfaceEnumerationError;
}

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
  "When loaded with Claude Code --channels, this server may emit notifications/claude/channel for cmuxlayer agent lifecycle events. These arrive as <channel> status updates and are one-way only.";
export const SEND_INPUT_CHUNK_THRESHOLD = 500;
export const DEFAULT_SEND_INPUT_MAX_INLINE_CHARS = 1_800;
const SEND_INPUT_CHUNK_DELAY_MS = 5;
const SEND_INPUT_RETRY_ATTEMPTS = 3;
const SEND_INPUT_RETRY_DELAY_MS = 25;
const SEND_INPUT_ENTER_DELAY_MS = 50;
const SEND_INPUT_RECOVERY_ENTER_DELAY_MS = 150;
const DEFAULT_SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS = 2000;
function parsePositiveIntegerMs(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS = parsePositiveIntegerMs(
  process.env.CMUXLAYER_SUBMIT_VERIFY_TIMEOUT_MS,
  DEFAULT_SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS,
);
export function parseMaxInlineChars(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= SEND_INPUT_CHUNK_THRESHOLD
    ? parsed
    : fallback;
}
export const SEND_INPUT_MAX_INLINE_CHARS = parseMaxInlineChars(
  process.env.CMUXLAYER_MAX_INLINE_CHARS,
  DEFAULT_SEND_INPUT_MAX_INLINE_CHARS,
);
const SEND_INPUT_SUBMIT_VERIFY_POLL_MS = 100;
const BOOT_PROMPT_TIMEOUT_MS = 60_000;
const BOOT_PROMPT_READY_POLL_MS = 250;
const BOOT_PROMPT_UPDATE_MAX_MS = 120_000;
const BOOT_PROMPT_UPDATE_RELAUNCH_MAX = 2;
const BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS =
  BOOT_PROMPT_READY_POLL_MS * 3;
const BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS = BOOT_PROMPT_READY_POLL_MS * 3;

function bootPromptUpdateMaxMs(): number {
  const raw = Number(process.env.CMUXLAYER_BOOT_PROMPT_UPDATE_MAX_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : BOOT_PROMPT_UPDATE_MAX_MS;
}
const LAUNCH_SHELL_READY_TIMEOUT_MS = 10_000;
const LAUNCH_SHELL_READY_POLL_MS = 100;
const LAUNCH_SUBMIT_READY_TIMEOUT_MS = 15_000;
/** Heartbeat freshness window before dispatch_to_agent falls back to a surface nudge. */
const INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS =
  AGENT_HEALTH_MONITOR_MAX_AGE_MS;
const INTERACTIVE_AGENT_STATES = new Set<AgentState>(["ready", "idle"]);
/** Agent states that are safe to close without `force`: the task is over. */
const TERMINAL_AGENT_STATES = new Set<AgentState>(["done", "error"]);
const READY_PATTERN_CLIS: CliType[] = [
  "claude",
  "codex",
  "gemini",
  "kiro",
  "cursor",
];
const SendToArgsSchema = z.object({
  agent_id: z.string(),
  text: z.string(),
  press_enter: z.boolean().optional().default(true),
  allow_busy: z.boolean().optional().default(false),
  allow_long_inline: z.boolean().optional().default(false),
});

type DeliveryStatus = "delivering" | "delivered" | "failed";

export interface DeliveryRecord {
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
  verify_submit: boolean;
  submit_verified: boolean | null;
  retry_count: number;
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

class SubmitVerificationError extends Error {
  constructor(
    message: string,
    readonly retry_count: number,
  ) {
    super(message);
    this.name = "SubmitVerificationError";
  }
}

class DeliverySafetyGateError extends Error {
  readonly submit_verified = false;

  constructor(
    readonly error_code:
      | "blocked_by_interactive_prompt"
      | "blocked_by_permission_prompt",
    readonly screen: ParsedScreenResult,
  ) {
    super(
      error_code === "blocked_by_permission_prompt"
        ? "delivery blocked by active permission prompt"
        : "delivery blocked by active interactive prompt",
    );
    this.name = "DeliverySafetyGateError";
  }
}

class ManualModeMutationError extends Error {
  readonly error_code = "manual_mode";
  readonly control = "manual";

  constructor(
    readonly tool: string,
    readonly surface?: string,
    readonly workspace?: string,
  ) {
    super(
      `Tool "${tool}" is blocked${
        surface ? ` for surface ${surface}` : ""
      }${workspace ? ` in workspace ${workspace}` : ""}: surface is in manual mode`,
    );
    this.name = "ManualModeMutationError";
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

class BootPromptUpdateMenuBlockedError extends Error {
  readonly error_code = "blocked_by_update_menu";
  readonly recovery =
    "Codex is showing the interactive update menu. Select 'Skip until next version' and rerun the spawn, or launch Codex once manually and dismiss the menu.";

  constructor(
    message: string,
    readonly last_10_lines: string[],
  ) {
    super(message);
    this.name = "BootPromptUpdateMenuBlockedError";
  }
}

class SurfaceGoneError extends Error {
  readonly error_code = "pane_died";

  constructor(
    readonly surface: string,
    readonly originalError: unknown,
  ) {
    super(`surface ${surface} disappeared - respawn`);
    this.name = "SurfaceGoneError";
  }
}

function readErrorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as Error & {
      code?: unknown;
      stderr?: unknown;
      stdout?: unknown;
      cause?: unknown;
    };
    return [
      error.name,
      error.message,
      typeof extra.code === "string" ? extra.code : "",
      typeof extra.stderr === "string" ? extra.stderr : "",
      typeof extra.stdout === "string" ? extra.stdout : "",
      extra.cause instanceof Error ? extra.cause.message : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return String(error);
}

function controlModeFromStatusEntries(entries: unknown): ControlMode {
  if (!Array.isArray(entries)) {
    return "autonomous";
  }
  const entry = entries.find((candidate): candidate is CmuxStatusEntry => {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    const maybeEntry = candidate as Partial<CmuxStatusEntry>;
    return maybeEntry.key === "mode.control";
  });
  return entry?.value === "manual" || entry?.value === "autonomous"
    ? entry.value
    : "autonomous";
}

function screenUnavailableMessage(error: unknown): string {
  return readErrorText(error).replace(/^Error\ncmux read-screen failed:\s*/i, "");
}

function isSurfaceGoneReadFailure(error: unknown, surface: string): boolean {
  const text = readErrorText(error).toLowerCase();
  const surfaceLower = surface.toLowerCase();
  if (
    text.includes(`unable to resolve workspace for surface ${surfaceLower}`)
  ) {
    return true;
  }
  if (/\bsurface[-_\s]?not[-_\s]?found\b/.test(text)) {
    return true;
  }
  return /\bnot_found\b/.test(text) && text.includes("surface");
}

function surfaceGonePayload(
  error: SurfaceGoneError,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    error_code: error.error_code,
    pane_died: true,
    surface: error.surface,
    action: "respawn",
    ...extra,
  };
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
  const modeExtra =
    error instanceof ManualModeMutationError
      ? {
          error_code: error.error_code,
          tool: error.tool,
          ...(error.surface ? { surface: error.surface } : {}),
          ...(error.workspace ? { workspace: error.workspace } : {}),
          control: error.control,
        }
      : {};
  const payload = { ok: false, error: message, ...modeExtra, ...extra };
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

  if (typeof surface.pane_ref === "string") {
    minimal.pane_ref = surface.pane_ref;
  }
  if (typeof surface.column === "number") {
    minimal.column = surface.column;
  }
  if (typeof surface.screen_preview === "string") {
    minimal.screen_preview = surface.screen_preview;
  }
  if (typeof surface.screen_preview_error === "string") {
    minimal.screen_preview_error = surface.screen_preview_error;
  }
  if (typeof surface.current_directory === "string") {
    minimal.current_directory = surface.current_directory;
  } else if (surface.current_directory === null) {
    minimal.current_directory = null;
  }
  if (typeof surface.requested_working_directory === "string") {
    minimal.requested_working_directory = surface.requested_working_directory;
  } else if (surface.requested_working_directory === null) {
    minimal.requested_working_directory = null;
  }
  if (typeof surface.working_directory_source === "string") {
    minimal.working_directory_source = surface.working_directory_source;
  }
  if (typeof surface.working_directory_fallback === "boolean") {
    minimal.working_directory_fallback = surface.working_directory_fallback;
  }

  return minimal;
}

type SurfaceWorkingDirectorySource =
  | "terminal_metadata"
  | "surface"
  | "pane"
  | "workspace_fallback"
  | "unavailable";

interface SurfaceWorkingDirectory {
  cwd: string | null;
  source: SurfaceWorkingDirectorySource;
}

interface SurfaceWorkingDirectoryMaps {
  terminalBySurface: Map<string, CmuxTerminalMetadata>;
  paneByWorkspaceAndRef: Map<string, Record<string, unknown>>;
  workspaceCwdByRef: Map<string, string>;
}

interface TerminalMetadataLoadResult {
  terminalBySurface: Map<string, CmuxTerminalMetadata>;
  degraded?: {
    terminal_metadata: true;
    error_code: "terminal_metadata_unavailable";
    error: string;
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function workingDirectoryFromRecord(
  record: Record<string, unknown> | null | undefined,
): string | null {
  return (
    nonEmptyString(record?.current_directory) ??
    nonEmptyString(record?.cwd) ??
    nonEmptyString(record?.working_directory)
  );
}

function paneWorkingDirectoryKey(
  workspaceRef: string,
  paneRef: string,
): string {
  return `${workspaceRef}\0${paneRef}`;
}

async function loadTerminalMetadataBySurface(
  client: CmuxLayerClient,
): Promise<TerminalMetadataLoadResult> {
  const metadataClient = client as CmuxLayerClient & {
    listTerminalMetadata?: () => Promise<{ terminals: CmuxTerminalMetadata[] }>;
  };
  if (typeof metadataClient.listTerminalMetadata !== "function") {
    return { terminalBySurface: new Map() };
  }

  try {
    const { terminals } = await metadataClient.listTerminalMetadata();
    const bySurface = new Map<string, CmuxTerminalMetadata>();
    for (const terminal of terminals) {
      const surfaceRef =
        nonEmptyString(terminal.surface_ref) ??
        nonEmptyString(terminal.surface_id) ??
        nonEmptyString(terminal.ref);
      if (surfaceRef) {
        bySurface.set(surfaceRef, terminal);
      }
    }
    return { terminalBySurface: bySurface };
  } catch (error) {
    return {
      terminalBySurface: new Map(),
      degraded: {
        terminal_metadata: true,
        error_code: "terminal_metadata_unavailable",
        error: readErrorText(error),
      },
    };
  }
}

function resolveSurfaceWorkingDirectory(
  surface: Record<string, unknown>,
  workspaceRef: string,
  paneRef: string,
  maps: SurfaceWorkingDirectoryMaps,
): SurfaceWorkingDirectory {
  const surfaceRef = nonEmptyString(surface.ref);
  const terminal =
    surfaceRef === null ? undefined : maps.terminalBySurface.get(surfaceRef);
  const terminalCwd = workingDirectoryFromRecord(
    terminal ? (terminal as Record<string, unknown>) : null,
  );
  if (terminalCwd) {
    return { cwd: terminalCwd, source: "terminal_metadata" };
  }

  const surfaceCwd = workingDirectoryFromRecord(surface);
  if (surfaceCwd) {
    return { cwd: surfaceCwd, source: "surface" };
  }

  const pane = maps.paneByWorkspaceAndRef.get(
    paneWorkingDirectoryKey(workspaceRef, paneRef),
  );
  const paneCwd = workingDirectoryFromRecord(pane);
  if (paneCwd) {
    return { cwd: paneCwd, source: "pane" };
  }

  const workspaceCwd = maps.workspaceCwdByRef.get(workspaceRef);
  if (workspaceCwd) {
    return { cwd: workspaceCwd, source: "workspace_fallback" };
  }

  return { cwd: null, source: "unavailable" };
}

function applySurfaceWorkingDirectory(
  surface: Record<string, unknown>,
  workspaceRef: string,
  paneRef: string,
  maps: SurfaceWorkingDirectoryMaps,
): void {
  const resolved = resolveSurfaceWorkingDirectory(
    surface,
    workspaceRef,
    paneRef,
    maps,
  );
  surface.current_directory = resolved.cwd;
  surface.requested_working_directory = resolved.cwd;
  surface.working_directory_source = resolved.source;
  surface.working_directory_fallback =
    resolved.source === "workspace_fallback" ||
    resolved.source === "unavailable";
}

function chunkTerminalInput(text: string, chunkSize: number): string[] {
  const rawChunks: string[] = [];
  let remaining = text;

  while (remaining.length > chunkSize) {
    const newlineIndex = remaining.lastIndexOf("\n", chunkSize);
    const splitAt = newlineIndex >= 0 ? newlineIndex + 1 : chunkSize;
    rawChunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    rawChunks.push(remaining);
  }

  const chunks: string[] = [];
  let whitespaceCarry = "";
  for (const chunk of rawChunks) {
    if (chunk.trim().length === 0) {
      whitespaceCarry += chunk;
      continue;
    }

    if (!whitespaceCarry) {
      chunks.push(chunk);
      continue;
    }

    let candidate = whitespaceCarry + chunk;
    whitespaceCarry = "";
    while (candidate.length > chunkSize) {
      const firstTextIndex = candidate.search(/\S/);
      const splitAt =
        firstTextIndex >= chunkSize ? firstTextIndex + 1 : chunkSize;
      chunks.push(candidate.slice(0, splitAt));
      candidate = candidate.slice(splitAt);
    }
    if (candidate.trim().length === 0) {
      whitespaceCarry = candidate;
    } else {
      chunks.push(candidate);
    }
  }

  if (whitespaceCarry && chunks.length > 0) {
    chunks[chunks.length - 1] += whitespaceCarry;
  }

  return chunks;
}

function shouldPasteInputChunk(text: string, totalChunks: number): boolean {
  return totalChunks > 1 || /[\n\r\t]|\\[nrt]/.test(text);
}

function isMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code?: unknown }).code) === "method_not_found"
  );
}

function pasteRequiredError(reason: string): Error {
  return new Error(
    `paste delivery is required for chunked or multiline input: ${reason}`,
  );
}

function getBootPromptPath(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasInlinePrompt(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function assertInlineInputAllowed(opts: {
  tool:
    | "send_input"
    | "send_command"
    | "spawn_agent"
    | "send_to"
    | "send_to_agent";
  arg: "text" | "command" | "prompt";
  value: string | undefined;
  allowLongInline?: boolean;
}): void {
  if (
    opts.allowLongInline ||
    opts.value === undefined ||
    opts.value.length <= SEND_INPUT_MAX_INLINE_CHARS
  ) {
    return;
  }

  const argName = `${opts.tool}.${opts.arg}`;
  const promptPathGuidance =
    opts.tool === "spawn_agent" || opts.tool === "send_command"
      ? " For launcher boot prompts, put the full prompt in a file and pass boot_prompt_path."
      : " For launchers, put the full boot prompt in a file and pass boot_prompt_path.";
  throw new Error(
    `${argName} is ${opts.value.length} characters, above CMUXLAYER_MAX_INLINE_CHARS=${SEND_INPUT_MAX_INLINE_CHARS}. Pane keystrokes are capped to one-line pointers: write the payload to a file and send "Read and follow <path>" instead.${promptPathGuidance} To deliberately send raw inline text, pass allow_long_inline:true. CMUXLAYER_MAX_INLINE_CHARS may be set to a positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}.`,
  );
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

function inferLauncherFromTitle(
  title?: string,
): { repo: string; cli: CliType; launcherName: string } | null {
  if (!title) return null;
  const launcherTitle = extractPrefix(title);
  const match = launcherTitle.match(
    /^(.+?)(Claude|Codex|Cursor|Gemini|Kiro)$/i,
  );
  if (!match) {
    return null;
  }
  const repo = match[1].trim();
  if (!repo || repo === "." || repo === "..") {
    return null;
  }
  return {
    repo,
    cli: match[2].toLowerCase() as CliType,
    launcherName: launcherTitle,
  };
}

function inferRepoFromLauncherTitle(title?: string): string | null {
  return inferLauncherFromTitle(title)?.repo ?? null;
}

function matchesShellPrompt(text: string): boolean {
  return /(?:^|\n)[^\n]*[$%#]\s*$/.test(text);
}

function matchesCliUpdateMarker(text: string): boolean {
  return /(?:^|\n)[^\n]*Updating\s+.+\s+via\s+.+/i.test(text);
}

function matchesCliUpdateContinuationMarker(text: string): boolean {
  return /(?:^|\n)[^\n]*(?:Update ran successfully|Please restart)[^\n]*/i.test(
    text,
  );
}

function shouldHandleCodexUpdateMenu(
  cli: CliType | undefined,
  text: string,
): boolean {
  return (cli === undefined || cli === "codex") && isCodexUpdateMenuScreen(text);
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

function formatToolValidationError(
  toolName: string,
  error: z.ZodError,
): string {
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
  return status === "working" || status === "thinking";
}

function hasParsedAgentIdentity(
  parsed: ParsedScreenResult | null | undefined,
): boolean {
  return Boolean(parsed && parsed.agent_type !== "unknown");
}

function screenHasAnyAgentIdentity(
  screenText: string,
  parsed: ParsedScreenResult = parseScreen(screenText),
): boolean {
  return (
    hasParsedAgentIdentity(parsed) ||
    /Claude Code|CLAUDE_COUNTER|bypass permissions on|What can I help you with\?|(?:^|\n)\s*(?:codex>|cursor>|kiro>)\s*$/im.test(
      screenText,
    )
  );
}

type RawSubmitEvidenceMetrics = {
  tokenCount: number | null;
  cost: number | null;
};

type ComposerPromptLineMatch = {
  input: string;
};

const COMPOSER_PROMPT_PREFIXES = Array.from(
  new Set(Object.values(CLI_INPUT_PROMPT_PREFIXES).flat()),
).sort((a, b) => b.length - a.length);
const RAW_SCREEN_TOKENS_LINE_RE =
  /(?:^\s*|.*\s{2,})([0-9][0-9,]*)\s+tokens\s*$/i;
const RAW_SCREEN_COST_LINE_RE =
  /(?:^|\s)🤖\s*[^|\n]+?\s*\|\s*💰\s*\$([0-9]+(?:\.[0-9]+)?)(?:\s|$)|^\s*💰\s*\$([0-9]+(?:\.[0-9]+)?)(?:\s|$)/i;

function normalizeTerminalText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function matchComposerPromptLine(line: string): ComposerPromptLineMatch | null {
  const trimmedStart = line.trimStart();
  for (const prefix of COMPOSER_PROMPT_PREFIXES) {
    if (!trimmedStart.toLowerCase().startsWith(prefix.toLowerCase())) {
      continue;
    }
    return { input: trimmedStart.slice(prefix.length).replace(/^\s/, "") };
  }

  return null;
}

function inferComposerCli(
  screenText: string,
  parsed: ParsedScreenResult = parseScreen(screenText),
): CliType | null {
  if (parsed.agent_type !== "unknown") {
    return parsed.agent_type;
  }
  if (/(?:^|\n)\s*(?:Kiro\b|kiro>)/i.test(screenText)) {
    return "kiro";
  }
  if (/(?:^|\n)\s*Gemini CLI\b|(?:^|\n)\s*gemini>/i.test(screenText)) {
    return "gemini";
  }
  if (/(?:^|\n)\s*Cursor Agent\b|(?:^|\n)\s*cursor>/i.test(screenText)) {
    return "cursor";
  }
  if (
    /\bOpenAI\s+Codex\b/i.test(screenText) ||
    /(?:^|\n)\s*(?:Model:\s*)?gpt-[0-9]/i.test(screenText)
  ) {
    return "codex";
  }
  if (
    /Claude Code|CLAUDE_COUNTER|bypass permissions on|What can I help you with\?/i.test(
      screenText,
    )
  ) {
    return "claude";
  }

  return null;
}

function lineIsCurrentComposerRegionAnchor(
  cli: CliType | null,
  line: string,
): boolean {
  const trimmed = line.trim();
  switch (cli) {
    case "claude":
      return /Claude Code|What can I help you with\?/i.test(trimmed);
    case "codex":
      return (
        /\bOpenAI\s+Codex\b/i.test(trimmed) ||
        /\bModel:\s*gpt-/i.test(trimmed)
      );
    case "cursor":
      return /^Cursor Agent$/i.test(trimmed) || /^cursor>\s*$/i.test(trimmed);
    case "gemini":
      return /^Gemini CLI$/i.test(trimmed) || /^gemini>\s*$/i.test(trimmed);
    case "kiro":
      return /^Kiro\b/i.test(trimmed) || /^kiro>\s*$/i.test(trimmed);
    case null:
      return (
        /Claude Code|What can I help you with\?/i.test(trimmed) ||
        /\bOpenAI\s+Codex\b/i.test(trimmed) ||
        /\bModel:\s*gpt-/i.test(trimmed) ||
        /^Cursor Agent$/i.test(trimmed) ||
        /^cursor>\s*$/i.test(trimmed) ||
        /^Gemini CLI$/i.test(trimmed) ||
        /^gemini>\s*$/i.test(trimmed) ||
        /^Kiro\b/i.test(trimmed) ||
        /^kiro>\s*$/i.test(trimmed)
      );
  }
}

function currentComposerRegionStart(
  cli: CliType | null,
  lines: string[],
): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lineIsCurrentComposerRegionAnchor(cli, lines[index] ?? "")) {
      return index + 1;
    }
  }
  return 0;
}

function isComposerFooterOrChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }
  return (
    /^─{8,}$/.test(trimmed) ||
    /^(?:⎇|🤖)(?:\s|$)/.test(trimmed) ||
    /^⏵+.*\bbypass permissions on\b/i.test(trimmed) ||
    /^[✻✢✳✶]\s+Cogitated\s+for\s+\d+s\b/i.test(trimmed) ||
    /^CLAUDE_COUNTER:/i.test(trimmed) ||
    /^gpt-[0-9][0-9a-z.-]*(?:\s+\w+)?\s*[·•]\s*/i.test(trimmed) ||
    /^\d+(?:\.\d+)?%\s+(?:context\s+)?left\b/i.test(trimmed) ||
    /^\/ commands\b/i.test(trimmed) ||
    /^(?:Auto|Agent)(?:\s*·|$)/i.test(trimmed) ||
    /^ctrl\+c to stop\b/i.test(trimmed) ||
    /^bypass permissions on\b/i.test(trimmed) ||
    /^⬡\s+Idle\b/i.test(trimmed) ||
    /^v20\d{2}\.\d{2}\.\d{2}-[a-f0-9]+$/i.test(trimmed)
  );
}

function isEligibleBareReadyPromptLine(
  cli: CliType | null,
  line: string,
): boolean {
  if (!/^\s*(?:>|>>>)\s*$/.test(line)) {
    return false;
  }
  return cli === "claude" || cli === "gemini" || cli === "kiro";
}

function matchLegacyClaudePromptLine(
  cli: CliType | null,
  line: string,
): ComposerPromptLineMatch | null {
  if (cli !== "claude") {
    return null;
  }
  const match = line.trimStart().match(/^>(?!>)\s?(.*)$/);
  return match ? { input: match[1] ?? "" } : null;
}

function extractComposerInputRegion(screenText: string): string | null {
  const lines = normalizeTerminalText(screenText).split("\n");
  const cli = inferComposerCli(screenText);
  const start = currentComposerRegionStart(cli, lines);
  let end = lines.length;
  while (end > start && isComposerFooterOrChromeLine(lines[end - 1] ?? "")) {
    end -= 1;
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const match = matchComposerPromptLine(lines[index] ?? "");
    if (!match) {
      continue;
    }

    const inputLines = [match.input];
    for (const line of lines.slice(index + 1, end)) {
      if (isComposerFooterOrChromeLine(line)) {
        break;
      }
      inputLines.push(line);
    }

    return inputLines.join("\n").trimEnd();
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const match = matchLegacyClaudePromptLine(cli, lines[index] ?? "");
    if (!match) {
      continue;
    }

    const inputLines = [match.input];
    for (const line of lines.slice(index + 1, end)) {
      if (isComposerFooterOrChromeLine(line)) {
        break;
      }
      inputLines.push(line);
    }

    return inputLines.join("\n").trimEnd();
  }

  const lastActiveLine = lines[end - 1] ?? "";
  if (end > start && isEligibleBareReadyPromptLine(cli, lastActiveLine)) {
    return "";
  }

  return null;
}

function screenShowsPendingInput(
  screenText: string,
  submittedText: string,
): boolean {
  const trimmed = submittedText.trim();
  if (!trimmed) {
    return false;
  }

  const tail = trimmed.slice(-Math.min(80, trimmed.length));
  const compactTail = tail.replace(/\s+/g, "");
  const composerInput = extractComposerInputRegion(screenText);
  return (
    composerInput !== null &&
    (composerInput.includes(tail) ||
      (compactTail.length > 0 &&
        composerInput.replace(/\s+/g, "").includes(compactTail)))
  );
}

function parseRawSubmitEvidenceMetrics(
  screenText: string,
): RawSubmitEvidenceMetrics {
  const normalized = normalizeTerminalText(screenText);
  let tokenCount: number | null = null;
  let cost: number | null = null;

  for (const line of normalized.split("\n")) {
    const tokenMatch = line.match(RAW_SCREEN_TOKENS_LINE_RE);
    if (tokenMatch) {
      tokenCount = Number.parseInt(tokenMatch[1].replaceAll(",", ""), 10);
    }

    const costMatch = line.match(RAW_SCREEN_COST_LINE_RE);
    if (costMatch) {
      const rawCost = costMatch[1] ?? costMatch[2];
      if (rawCost !== undefined) {
        cost = Number.parseFloat(rawCost);
      }
    }
  }

  return { tokenCount, cost };
}

export const __submitEvidenceTestHooks = {
  extractComposerInputRegion,
  screenShowsPendingInput,
};

function hasRawSubmitEvidenceIncrease(
  current: RawSubmitEvidenceMetrics,
  baseline: RawSubmitEvidenceMetrics | null | undefined,
): boolean {
  if (
    current.tokenCount !== null &&
    (baseline?.tokenCount === null || baseline?.tokenCount === undefined
      ? current.tokenCount > 0
      : current.tokenCount > baseline.tokenCount)
  ) {
    return true;
  }

  return (
    current.cost !== null &&
    (baseline?.cost === null || baseline?.cost === undefined
      ? current.cost > 0
      : current.cost > baseline.cost)
  );
}

type MonitorBootResult = {
  status: "bootstrapped" | "monitor-not-ready";
  heartbeat_written: boolean;
  heartbeat_source: "server_boot";
  monitor_command: string;
  error?: string;
};

function computeEnterDelayMs(bytes: number, chunkCount: number): number {
  const extraChunks = Math.max(0, chunkCount - 1);
  const longPayloadPenalty = bytes >= SEND_INPUT_CHUNK_THRESHOLD ? 100 : 0;
  return Math.min(
    250,
    SEND_INPUT_ENTER_DELAY_MS + extraChunks * 50 + longPayloadPenalty,
  );
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

const JSONL_HARNESSES = new Set<Harness>(["claude", "codex", "cursor"]);

// AIDEV-NOTE: P2 — real agent state from the harness JSONL (the sterile read channel).
// Flag-gated (CMUXLAYER_HARNESS_JSONL=1); screen-parser is the fallback. Resolves the
// surface's cli + cli_session_id from the in-memory state cache, then loads the
// transcript by sessionId (no cwd needed — the id is unique). Returns null whenever the
// flag is off, the harness is unsupported, or no session file is found → screen values stand.
function resolveHarnessStateForSurface(
  stateMgr: StateManager,
  surfaceRef: string,
): ReturnType<typeof loadHarnessSession> {
  if (!harnessJsonlEnabled()) return null;
  const matches = stateMgr
    .listStates()
    .filter((record) => record.surface_id === surfaceRef)
    .sort((a, b) => {
      if (b.version !== a.version) return b.version - a.version;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    });
  const record = matches[0];
  const cli = record?.cli as Harness | undefined;
  const sessionId = record?.cli_session_id ?? null;
  if (!cli || !sessionId || !JSONL_HARNESSES.has(cli)) return null;
  // Honor CODEX_HOME (already used by app-server-bridge) and a test-only home override.
  const opts = {
    ...(process.env.CMUXLAYER_HARNESS_HOME
      ? { home: process.env.CMUXLAYER_HARNESS_HOME }
      : {}),
    ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
  };
  return loadHarnessSession(cli, sessionId, opts);
}

export interface TargetIdentity {
  surface: string;
  title?: string;
  model?: string;
  agent_type?: string;
}

// Best-effort, CHEAP target-agent identity for delivery responses (send_input /
// send_command). Sourced from the in-memory state cache only — no extra socket
// round-trip / read_screen per send. Unknown fields are omitted.
function resolveTargetIdentity(
  stateMgr: StateManager,
  surfaceRef: string,
): TargetIdentity {
  const identity: TargetIdentity = { surface: surfaceRef };
  const record = resolveLatestSurfaceAgentRecord(stateMgr, surfaceRef);
  if (record?.task_summary) identity.title = record.task_summary;
  if (record?.model) identity.model = record.model;
  if (record?.cli) identity.agent_type = record.cli;
  return identity;
}

function resolveLatestSurfaceAgentRecord(
  stateMgr: StateManager,
  surfaceRef: string,
): AgentRecord | undefined {
  return stateMgr
    .listStates()
    .filter((record) => record.surface_id === surfaceRef)
    .sort((a, b) => {
      if (b.version !== a.version) return b.version - a.version;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    })[0];
}

// Map a live screen status onto a healthy AgentState. Only running/idle states are "healthy"
// enough to override a stale registry error — "done"/"frozen" are left to the registry.
const LIVE_HEALTHY_STATE: Partial<
  Record<ParsedScreenResult["status"], AgentState>
> = {
  working: "working",
  thinking: "working",
  idle: "idle",
};

/**
 * Reconcile a registry AgentState with the live read_screen parse for my_agents.
 * An active agent screen is ground truth for liveness, so working/thinking screens win
 * over stale inactive registry states. A healthy idle screen only clears a stale error.
 */
export function reconcileAgentLiveState(
  registryState: AgentState,
  screen: ParsedScreenResult | null,
): AgentState {
  // Only a REAL agent screen can clear an error. parseScreen reports status:"idle" for a
  // plain shell prompt (agent_type:"unknown"), so a crashed agent fallen back to a shell must
  // keep its registry error instead of being masked as healthy idle.
  if (screen && screen.agent_type !== "unknown") {
    const live = LIVE_HEALTHY_STATE[screen.status];
    if (live === "working") return live;
    if (registryState === "error" && live) return live;
  }
  return registryState;
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
  /** Shared server-side world-model reused across many MCP connections. */
  context?: CmuxServerContext;
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
  /** Base directory for agent inbox channels. Defaults to ~/.cmux/agents (primarily for tests). */
  inboxBaseDir?: string;
  /** Override session identity lookup (primarily for mocked tests). */
  sessionIdentityResolver?: SessionIdentityResolver;
  /** Override git worktree execution/home for tests. */
  worktreeExec?: WorktreeExec;
  worktreeHomeDir?: string;
  /** Override control health collection (primarily for tests). */
  controlHealthCollector?: () => Promise<ControlHealth>;
  /** Periodic control health sample interval. Defaults to env or 60000ms; 0 disables. */
  controlHealthIntervalMs?: number;
  /**
   * Best-effort outbox drain invoked at the tail of each agent-engine sweep.
   * Omitted by default (no-op) so tests never touch the real outbox/network;
   * the real MCP entrypoints pass `() => drainOutbox({ deliver: httpDeliver })`
   * to actually flush `~/.golems-zikaron/outbox.md` to the notify path.
   */
  outboxDrain?: () => Promise<unknown>;
  /**
   * Canonical monitor-registry file scanned by the agent-engine deadman sweep.
   * Omitted by default so tests do not touch ~/.golems-zikaron.
   */
  monitorRegistryPath?: string;
  monitorRegistryNow?: () => number;
  monitorRegistryNotify?: MonitorDeadmanNotify;
}

type CmuxLayerClient = CmuxClient | CmuxSocketClient;

export interface CmuxServerContext {
  client: CmuxLayerClient;
  stateDir: string;
  stateMgr: StateManager;
  roleSurfaceOverrides: Map<
    string,
    { role: AgentRole; workspace: string | null }
  >;
  eventLog: ReturnType<StateManager["getEventLog"]>;
  deliveries: Map<string, DeliveryRecord>;
  latestDeliveryBySurface: Map<string, string>;
  activeDeliveryBySurface: Map<string, string>;
  activeSurfaceWrites: Map<string, string>;
  enableClaudeChannels: boolean;
  skipAgentLifecycle: boolean;
  spawnPreflight?: (params: SpawnAgentParams) => Promise<void>;
  disableSpawnPreflight?: boolean;
  sessionIdentityResolver?: SessionIdentityResolver;
  lifecycleRegistry: AgentRegistry | null;
  lifecycleStarted: boolean;
  lifecycleStartPromise: Promise<void> | null;
  lifecycleSweepEngine: AgentEngine | null;
  controlHealthCollector?: () => Promise<ControlHealth>;
  controlHealthIntervalMs: number;
  controlHealthTimer: ReturnType<typeof setInterval> | null;
  dispose(): void;
}

const DEFAULT_CONTROL_HEALTH_INTERVAL_MS = 60_000;
const MIN_CONTROL_HEALTH_INTERVAL_MS = 5_000;
const autoVitestStateDirs = new Set<string>();
let autoVitestStateCleanupRegistered = false;

function resolveControlHealthIntervalMs(input?: number): number {
  const raw =
    input ??
    (process.env.CMUXLAYER_CONTROL_HEALTH_INTERVAL_MS
      ? Number(process.env.CMUXLAYER_CONTROL_HEALTH_INTERVAL_MS)
      : DEFAULT_CONTROL_HEALTH_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw < 0) {
    return DEFAULT_CONTROL_HEALTH_INTERVAL_MS;
  }
  if (raw === 0) {
    return 0;
  }
  return Math.max(MIN_CONTROL_HEALTH_INTERVAL_MS, Math.floor(raw));
}

function registerAutoVitestStateDir(stateDir: string): void {
  autoVitestStateDirs.add(stateDir);
  if (autoVitestStateCleanupRegistered) {
    return;
  }
  autoVitestStateCleanupRegistered = true;
  process.once("exit", () => {
    for (const dir of autoVitestStateDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    autoVitestStateDirs.clear();
  });
}

function removeAutoVitestStateDir(stateDir: string): void {
  autoVitestStateDirs.delete(stateDir);
  rmSync(stateDir, { recursive: true, force: true });
}

export function createServerContext(
  opts?: Omit<CreateServerOptions, "context">,
): CmuxServerContext {
  const client =
    opts?.client ?? new CmuxClient({ exec: opts?.exec, bin: opts?.bin });
  const autoVitestStateDir =
    !opts?.stateDir && process.env.VITEST === "true"
      ? mkdtempSync(join(tmpdir(), "cmuxlayer-vitest-state-"))
      : null;
  const stateDir =
    opts?.stateDir ??
    autoVitestStateDir ??
    join(homedir(), ".local", "state", "cmux-agents");
  if (autoVitestStateDir) {
    registerAutoVitestStateDir(autoVitestStateDir);
  }
  const stateMgr = new StateManager(stateDir);
  const context: CmuxServerContext = {
    client,
    stateDir,
    stateMgr,
    roleSurfaceOverrides: new Map(),
    eventLog: stateMgr.getEventLog(),
    deliveries: new Map(),
    latestDeliveryBySurface: new Map(),
    activeDeliveryBySurface: new Map(),
    activeSurfaceWrites: new Map(),
    enableClaudeChannels:
      opts?.enableClaudeChannels ??
      process.env.CMUXLAYER_ENABLE_CLAUDE_CHANNELS === "1",
    skipAgentLifecycle: opts?.skipAgentLifecycle ?? false,
    spawnPreflight: opts?.spawnPreflight,
    disableSpawnPreflight: opts?.disableSpawnPreflight,
    sessionIdentityResolver: opts?.sessionIdentityResolver,
    lifecycleRegistry: null,
    lifecycleStarted: false,
    lifecycleStartPromise: null,
    lifecycleSweepEngine: null,
    controlHealthCollector: opts?.controlHealthCollector,
    controlHealthIntervalMs: resolveControlHealthIntervalMs(
      opts?.controlHealthIntervalMs,
    ),
    controlHealthTimer: null,
    dispose() {
      context.lifecycleSweepEngine?.dispose();
      if (context.controlHealthTimer) {
        clearInterval(context.controlHealthTimer);
        context.controlHealthTimer = null;
      }
      context.lifecycleSweepEngine = null;
      context.lifecycleStarted = false;
      context.lifecycleStartPromise = null;
      if (autoVitestStateDir) {
        removeAutoVitestStateDir(autoVitestStateDir);
      }
    },
  };

  return context;
}

function formatLifecycleChannelContent(
  event: AgentLifecycleEvent,
  agent: AgentRecord,
  healthSummary?: string,
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
    case "health":
      return `cmux agent health changed: ${agent.repo} (${agent.agent_id}) health=${healthSummary ?? "unknown"} state=${agent.state}`;
  }
}

function buildLifecycleChannelMeta(
  event: AgentLifecycleEvent,
  agent: AgentRecord,
  healthSummary?: string,
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
  if (agent.cli_session_path) {
    meta.cli_session_path = agent.cli_session_path;
  }
  if (event === "health" && healthSummary) {
    meta.health_summary = healthSummary;
  }

  return meta;
}

export function createServer(opts?: CreateServerOptions): McpServer {
  const ownsContext = !opts?.context;
  const context = opts?.context ?? createServerContext(opts);
  const client = context.client;
  const stateMgr = context.stateMgr;
  const roleSurfaceOverrides = context.roleSurfaceOverrides;
  const eventLog = context.eventLog;
  const deliveries = context.deliveries;
  const latestDeliveryBySurface = context.latestDeliveryBySurface;
  const activeDeliveryBySurface = context.activeDeliveryBySurface;
  const activeSurfaceWrites = context.activeSurfaceWrites;
  const enableClaudeChannels =
    opts?.enableClaudeChannels ?? context.enableClaudeChannels;
  const skipAgentLifecycle =
    opts?.skipAgentLifecycle ?? context.skipAgentLifecycle;
  const spawnPreflight = opts?.spawnPreflight ?? context.spawnPreflight;
  const disableSpawnPreflight =
    opts?.disableSpawnPreflight ?? context.disableSpawnPreflight;
  const controlHealthCollector =
    opts?.controlHealthCollector ?? context.controlHealthCollector;
  const inboxOpts = opts?.inboxBaseDir
    ? { baseDir: opts.inboxBaseDir }
    : undefined;
  const ensureMonitorBoot = (agentId: string): MonitorBootResult => {
    let monitorCommand = "";
    try {
      monitorCommand = recommendedMonitorCommand(agentId, inboxOpts);
      ensureInboxFile(agentId, inboxOpts);
      writeHeartbeat(agentId, inboxOpts, "server_boot");
      return {
        status: "bootstrapped",
        heartbeat_written: true,
        heartbeat_source: "server_boot",
        monitor_command: monitorCommand,
      };
    } catch (e) {
      return {
        status: "monitor-not-ready",
        heartbeat_written: false,
        heartbeat_source: "server_boot",
        monitor_command: monitorCommand,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };
  // Wired up by the agent-lifecycle block below (when enabled). Lets the
  // dispatch_to_agent nudge reuse the guarded relay path — stale-surface
  // resync + recycled-occupant identity checks — instead of raw keystrokes.
  let lifecycleAgentInputDeliverer:
    | ((args: {
        agent_id: string;
        text: string;
        press_enter: boolean;
        allow_busy?: boolean;
        source_event: DeliveryEventType;
      }) => Promise<unknown>)
    | null = null;
  let lifecycleEnsureRegistered: (() => Promise<void>) | null = null;
  let lifecycleRefreshManagedMetadata:
    | ((agentId?: string) => Promise<void>)
    | null = null;
  let lifecycleHealthEngine: AgentEngine | null = null;
  const refreshManagedMetadataBestEffort = async (
    agentId?: string,
  ): Promise<void> => {
    try {
      await lifecycleRefreshManagedMetadata?.(agentId);
    } catch {
      // Health/read paths should not fail just because a refresh scan failed.
    }
  };
  const resolveModeWorkspace = async (
    surface: string,
    workspace?: string,
  ): Promise<string | undefined> => {
    if (workspace) {
      return workspace;
    }
    try {
      const identified = await client.identify(surface);
      return (
        identified.caller?.workspace_ref ?? identified.focused?.workspace_ref
      );
    } catch {
      return undefined;
    }
  };
  const readSurfaceControlMode = async (
    surface: string,
    workspace?: string,
  ): Promise<{ control: ControlMode; workspace?: string }> => {
    const statusClient = client as CmuxLayerClient & {
      listStatus?: (opts?: { workspace?: string }) => Promise<unknown>;
    };
    if (typeof statusClient.listStatus !== "function") {
      return { control: "autonomous", workspace };
    }
    const modeWorkspace = await resolveModeWorkspace(surface, workspace);
    if (!modeWorkspace) {
      return { control: "autonomous" };
    }
    try {
      const entries = await statusClient.listStatus({ workspace: modeWorkspace });
      return {
        control: controlModeFromStatusEntries(entries),
        workspace: modeWorkspace,
      };
    } catch {
      return { control: "autonomous", workspace: modeWorkspace };
    }
  };
  const readWorkspaceControlMode = async (
    workspace?: string,
  ): Promise<{ control: ControlMode; workspace?: string }> => {
    const statusClient = client as CmuxLayerClient & {
      listStatus?: (opts?: { workspace?: string }) => Promise<unknown>;
    };
    if (!workspace || typeof statusClient.listStatus !== "function") {
      return { control: "autonomous", workspace };
    }
    try {
      const entries = await statusClient.listStatus({ workspace });
      return {
        control: controlModeFromStatusEntries(entries),
        workspace,
      };
    } catch {
      return { control: "autonomous", workspace };
    }
  };
  const assertSurfaceMutationAllowed = async (
    toolName: string,
    surface: string,
    workspace?: string,
  ): Promise<void> => {
    const mode = await readSurfaceControlMode(surface, workspace);
    try {
      assertMutationAllowed(toolName, mode.control);
    } catch (error) {
      if (mode.control === "manual") {
        throw new ManualModeMutationError(toolName, surface, mode.workspace);
      }
      throw error;
    }
  };
  const assertWorkspaceMutationAllowed = async (
    toolName: string,
    workspace?: string,
  ): Promise<void> => {
    const mode = await readWorkspaceControlMode(workspace);
    try {
      assertMutationAllowed(toolName, mode.control);
    } catch (error) {
      if (mode.control === "manual") {
        throw new ManualModeMutationError(toolName, undefined, mode.workspace);
      }
      throw error;
    }
  };

  const server = new McpServer(
    {
      name: "cmuxlayer",
      version: readVersion(),
    },
    enableClaudeChannels
      ? { instructions: CLAUDE_CHANNEL_INSTRUCTIONS }
      : undefined,
  );
  if (ownsContext) {
    const close = server.close.bind(server);
    server.close = async (): Promise<void> => {
      try {
        await close();
      } finally {
        context.dispose();
      }
    };
  }

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
    submit_verified: record.submit_verified,
    retry_count: record.retry_count,
  });

  const collectServerRoleSurfaceIds = (
    liveSurfaceIds?: ReadonlySet<string>,
    workspace?: string,
  ) => {
    const roleRecords = context.lifecycleRegistry?.list() ?? [];
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

  const resolveWorkspaceForRepo = async (
    repo: string | null | undefined,
  ): Promise<string | undefined> => {
    return resolveWorkspaceRefForRepo(repo, () => client.listWorkspaces());
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
    opts: {
      toolName?: string;
      workspace?: string;
      owner?: string;
    } = {},
  ): Promise<T> => {
    if (opts.toolName) {
      await assertSurfaceMutationAllowed(opts.toolName, surface, opts.workspace);
    }
    const owner = opts.owner ?? `surface-write:${randomUUID()}`;
    acquireSurfaceWrite(surface, owner);
    try {
      return await fn();
    } finally {
      releaseSurfaceWrite(surface, owner);
    }
  };

  const worktreeArgSchema = z.union([
    z.boolean(),
    z.object({
      create: z.boolean().optional(),
      reuse: z.boolean().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      branch: z.string().optional(),
      base: z.string().optional(),
    }),
  ]);

  const mcpProfileSchema = z.union([
    z.enum(["inherit", "sterile", "skill_eval"]),
    z.object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    }),
  ]);

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
        const shouldPaste = shouldPasteInputChunk(chunk, totalChunks);
        if (shouldPaste) {
          if (typeof client.pasteText !== "function") {
            throw pasteRequiredError("client does not support pasteText");
          }
          try {
            await client.pasteText(surface, chunk, opts);
          } catch (error) {
            if (isMethodNotFoundError(error)) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw pasteRequiredError(`pasteText is unavailable (${message})`);
            }
            throw error;
          }
        } else {
          await client.send(surface, chunk, opts);
        }
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

  // Env vars the calling agent's harness sets in this MCP child's environment.
  // First non-empty one is the best available caller identity for a close/kill.
  const CLOSE_CALLER_ENV_KEYS = [
    "CMUX_TAB_ID",
    "CMUX_WORKSPACE_ID",
    "CMUX_SOCKET_PATH",
  ] as const;

  /**
   * Best available identity of whoever drove a close/kill. Prefers a real
   * env-derived id (`CMUX_TAB_ID=...`); falls back to `mcp:<toolName>` for a
   * tool call with no resolvable id. Never fabricates an id.
   */
  const resolveCloseCaller = (toolName: string): string => {
    for (const key of CLOSE_CALLER_ENV_KEYS) {
      const value = process.env[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return `${key}=${value.trim()}`;
      }
    }
    return `mcp:${toolName}`;
  };

  const appendCloseEvent = (
    event: Omit<CloseTelemetryEvent, "ts" | "event_type">,
  ) => {
    eventLog.appendClose({
      ts: new Date().toISOString(),
      event_type: "close",
      ...event,
    });
  };

  const appendControlHealthSnapshot = async (): Promise<ControlHealth> => {
    const health = controlHealthCollector
      ? await controlHealthCollector()
      : await collectControlHealth({ client });
    eventLog.appendControlHealth({
      ts: health.generated_at,
      event_type: "control_health",
      selected_socket_path:
        health.selected_transport.current_socket_path ?? null,
      production_socket_path: health.cmux_instances.production.socket_path,
      nightly_socket_path: health.cmux_instances.nightly.socket_path,
      cmux_binary: health.current_process.cmux_resolution[0]?.path ?? null,
      warnings: health.warnings,
      snapshot: health,
    });
    return health;
  };

  if (
    context.controlHealthIntervalMs > 0 &&
    context.controlHealthTimer === null
  ) {
    context.controlHealthTimer = setInterval(() => {
      appendControlHealthSnapshot().catch((error) => {
        console.error(
          "[cmuxlayer] control_health periodic sample failed:",
          error,
        );
      });
    }, context.controlHealthIntervalMs);
    context.controlHealthTimer.unref?.();
  }

  const readParsedSurface = async (
    surface: string,
    workspace?: string,
    opts?: { throwOnSurfaceGone?: boolean },
  ): Promise<{ text: string; parsed: ParsedScreenResult } | null> => {
    try {
      const screen = await client.readScreen(surface, {
        ...(workspace ? { workspace } : {}),
        lines: 30,
      });
      const text = typeof screen === "string" ? screen : (screen.text ?? "");
      const parsed = applyHarnessState(
        enrichParsedScreen(
          parseScreen(text),
          text,
          pickLatestSurfaceModel(stateMgr, surface),
        ),
        resolveHarnessStateForSurface(stateMgr, surface),
      );
      return { text, parsed };
    } catch (error) {
      if (opts?.throwOnSurfaceGone && isSurfaceGoneReadFailure(error, surface)) {
        throw new SurfaceGoneError(surface, error);
      }
      return null;
    }
  };

  const assertDeliveryTargetIsSafe = async (
    surface: string,
    workspace?: string,
  ): Promise<void> => {
    const snapshot = await readParsedSurface(surface, workspace, {
      throwOnSurfaceGone: true,
    });
    if (!snapshot) {
      return;
    }

    if (snapshot.parsed.control_state === "permission_prompt") {
      throw new DeliverySafetyGateError(
        "blocked_by_permission_prompt",
        snapshot.parsed,
      );
    }

    if (snapshot.parsed.control_state === "interactive_overlay") {
      throw new DeliverySafetyGateError(
        "blocked_by_interactive_prompt",
        snapshot.parsed,
      );
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
    require_working_status?: boolean;
    timeout_ms?: number;
  }): Promise<{ submit_verified: boolean | null; retry_count: number }> => {
    if (!opts.verify_submit) {
      // null means submit verification was not attempted, usually because the
      // command was at or below SEND_INPUT_CHUNK_THRESHOLD; it is not a failure.
      return { submit_verified: null, retry_count: 0 };
    }

    const timeoutMs = opts.timeout_ms ?? SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS;
    const startedAt = Date.now();
    let retried = false;
    let retryCount = 0;
    let sawClearedInput = false;

    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = await readParsedSurface(opts.surface, opts.workspace, {
        throwOnSurfaceGone: true,
      });
      if (!snapshot) {
        return { submit_verified: null, retry_count: retryCount };
      }

      if (!snapshot.text.trim()) {
        return { submit_verified: null, retry_count: retryCount };
      }

      if (isSubmitVerifiedStatus(snapshot.parsed.status)) {
        return { submit_verified: true, retry_count: retryCount };
      }

      const hasPendingInput = screenShowsPendingInput(snapshot.text, opts.text);
      if (!hasPendingInput) {
        sawClearedInput = true;
      }
      if (opts.require_working_status) {
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
        continue;
      }

      // Pending input and cleared-but-idle composers are both ambiguous: the
      // first Return may have been missed, or the CLI may have cleared input
      // without starting the task. Retry Enter once, then keep polling for real
      // working/thinking evidence. Cleared input alone is not submit proof.
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
    return {
      submit_verified:
        sawClearedInput && !opts.require_working_status ? null : false,
      retry_count: retryCount,
    };
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
    submit_verify_timeout_ms?: number;
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
        timeout_ms: opts.submit_verify_timeout_ms,
        require_working_status: opts.source_event === "boot_prompt",
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
      const timeoutMs =
        opts.submit_verify_timeout_ms ?? SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS;
      throw new SubmitVerificationError(
        `Enter submit could not be verified for ${opts.surface} within ${timeoutMs}ms`,
        retry_count,
      );
    }

    return { bytes, retry_count, submit_verified };
  };

  const waitForBootPromptReady = async (opts: {
    surface: string;
    workspace?: string;
    cli?: CliType;
    timeout_ms: number;
    onUpdateShellRelaunch?: () => Promise<void>;
  }): Promise<RawSubmitEvidenceMetrics | null> => {
    let deadline = Date.now() + opts.timeout_ms;
    let lastText = "";
    const consecutiveMatches = new Map<CliType, number>();
    const candidates = readyPatternCandidates(opts.cli);
    let updateStartedAt: number | null = null;
    let updateElapsedMs = 0;
    let updateWasSeen = false;
    let updateShellRelaunches = 0;
    let codexUpdateMenuDismissed = false;
    let codexUpdateMenuDismissedAt: number | null = null;
    const updateMaxMs = bootPromptUpdateMaxMs();
    const postUpdateReadyBudgetMs = () =>
      Math.max(opts.timeout_ms, BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS);

    while (Date.now() < deadline || updateStartedAt !== null) {
      try {
        const screen = await client.readScreen(opts.surface, {
          workspace: opts.workspace,
          lines: 80,
          scrollback: false,
        });
        lastText = screen.text;
        const parsed = parseScreen(screen.text);
        const now = Date.now();
        const updateMarker =
          matchesCliUpdateMarker(screen.text) ||
          (matchesCliUpdateContinuationMarker(screen.text) &&
            !matchesShellPrompt(screen.text));

        if (shouldHandleCodexUpdateMenu(opts.cli, screen.text)) {
          if (codexUpdateMenuDismissed) {
            const elapsedSinceDismissMs =
              codexUpdateMenuDismissedAt === null
                ? BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS
                : now - codexUpdateMenuDismissedAt;
            if (
              elapsedSinceDismissMs < BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS
            ) {
              consecutiveMatches.clear();
              await delay(BOOT_PROMPT_READY_POLL_MS);
              continue;
            }
            throw new BootPromptUpdateMenuBlockedError(
              `Boot prompt delivery blocked by Codex update menu on ${opts.surface}`,
              tailLines(lastText, 10),
            );
          }
          updateWasSeen = true;
          consecutiveMatches.clear();
          await sendKeyWithRetry(opts.surface, "down", opts.workspace);
          await delay(SEND_INPUT_ENTER_DELAY_MS);
          await sendKeyWithRetry(opts.surface, "return", opts.workspace);
          codexUpdateMenuDismissed = true;
          const dismissedAt = Date.now();
          codexUpdateMenuDismissedAt = dismissedAt;
          deadline = Math.max(
            deadline,
            dismissedAt + postUpdateReadyBudgetMs(),
            dismissedAt +
              BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS +
              BOOT_PROMPT_READY_POLL_MS,
          );
          await delay(BOOT_PROMPT_READY_POLL_MS);
          continue;
        }

        if (updateMarker) {
          updateWasSeen = true;
          updateStartedAt ??= now;
          updateElapsedMs = Math.max(
            updateElapsedMs + BOOT_PROMPT_READY_POLL_MS,
            updateStartedAt === null ? 0 : now - updateStartedAt,
          );
          if (updateElapsedMs >= updateMaxMs) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for boot prompt readiness on ${opts.surface}: CLI update marker persisted for ${updateMaxMs}ms`,
              tailLines(lastText, 10),
            );
          }
          await delay(BOOT_PROMPT_READY_POLL_MS);
          continue;
        }

        if (updateStartedAt !== null) {
          const updateDuration = Math.max(now - updateStartedAt, updateElapsedMs);
          deadline = Math.max(
            deadline + updateDuration,
            now + postUpdateReadyBudgetMs(),
          );
          updateStartedAt = null;
          updateElapsedMs = 0;
        }

        if (
          updateWasSeen &&
          opts.onUpdateShellRelaunch &&
          matchesShellPrompt(screen.text) &&
          !candidates.some((candidate) =>
            matchReadyPattern(candidate, screen.text).matched,
          )
        ) {
          if (updateShellRelaunches >= BOOT_PROMPT_UPDATE_RELAUNCH_MAX) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for boot prompt readiness on ${opts.surface}: CLI returned to shell after ${updateShellRelaunches} post-update relaunch attempts`,
              tailLines(lastText, 10),
            );
          }
          updateShellRelaunches += 1;
          consecutiveMatches.clear();
          const relaunchStartedAt = Date.now();
          await opts.onUpdateShellRelaunch();
          const relaunchEndedAt = Date.now();
          deadline = Math.max(
            deadline + (relaunchEndedAt - relaunchStartedAt),
            relaunchEndedAt + postUpdateReadyBudgetMs(),
          );
          continue;
        }

        for (const candidate of candidates) {
          const match = matchReadyPattern(candidate, screen.text);
          const ready =
            match.matched &&
            screenHasReadyAgentIdentity(candidate, screen.text, parsed);
          const count = ready
            ? (consecutiveMatches.get(candidate) ?? 0) + 1
            : 0;
          consecutiveMatches.set(candidate, count);
          if (count >= match.consecutive) {
            return parseRawSubmitEvidenceMetrics(screen.text);
          }
        }
      } catch (error) {
        if (
          error instanceof BootPromptTimeoutError ||
          error instanceof BootPromptUpdateMenuBlockedError
        ) {
          throw error;
        }
        if (isSurfaceGoneReadFailure(error, opts.surface)) {
          throw new SurfaceGoneError(opts.surface, error);
        }
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining = deadline - Date.now();
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

  const waitForBootPromptSubmitEvidence = async (opts: {
    surface: string;
    workspace?: string;
    text: string;
    timeout_ms: number;
    baseline_metrics?: RawSubmitEvidenceMetrics | null;
  }): Promise<void> => {
    const start = Date.now();
    let lastText = "";
    let lastClearedComposerInput: string | null = null;
    let stableClearedComposerPolls = 0;

    while (Date.now() - start < opts.timeout_ms) {
      const snapshot = await readParsedSurface(opts.surface, opts.workspace, {
        throwOnSurfaceGone: true,
      });
      if (snapshot) {
        lastText = snapshot.text;
        if (isSubmitVerifiedStatus(snapshot.parsed.status)) {
          return;
        }

        const composerInput = extractComposerInputRegion(snapshot.text);
        const hasPendingInput = screenShowsPendingInput(snapshot.text, opts.text);
        if (
          composerInput !== null &&
          !hasPendingInput &&
          hasRawSubmitEvidenceIncrease(
            parseRawSubmitEvidenceMetrics(snapshot.text),
            opts.baseline_metrics,
          )
        ) {
          return;
        }

        const composerCleared =
          composerInput !== null &&
          composerInput.trim() === "" &&
          !hasPendingInput;
        if (
          composerCleared &&
          screenHasAnyAgentIdentity(snapshot.text, snapshot.parsed)
        ) {
          if (composerInput === lastClearedComposerInput) {
            stableClearedComposerPolls += 1;
          } else {
            lastClearedComposerInput = composerInput;
            stableClearedComposerPolls = 1;
          }

          if (stableClearedComposerPolls >= 2) {
            return;
          }
        } else {
          lastClearedComposerInput = null;
          stableClearedComposerPolls = 0;
        }
      }

      const remaining = opts.timeout_ms - (Date.now() - start);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(BOOT_PROMPT_READY_POLL_MS, remaining));
    }

    throw new BootPromptTimeoutError(
      `Timed out after ${opts.timeout_ms}ms waiting for boot prompt submit evidence on ${opts.surface}`,
      tailLines(lastText, 10),
    );
  };

  const waitForLaunchShellReady = async (opts: {
    surface: string;
    workspace?: string;
    timeout_ms?: number;
  }): Promise<void> => {
    const timeoutMs = opts.timeout_ms ?? LAUNCH_SHELL_READY_TIMEOUT_MS;
    const start = Date.now();
    let lastText = "";

    while (Date.now() - start < timeoutMs) {
      try {
        const screen = await client.readScreen(opts.surface, {
          workspace: opts.workspace,
          lines: 30,
          scrollback: false,
        });
        lastText = screen.text;
        if (
          matchesShellPrompt(screen.text) ||
          READY_PATTERN_CLIS.some(
            (cli) => matchReadyPattern(cli, screen.text).matched,
          )
        ) {
          return;
        }
      } catch (error) {
        if (isSurfaceGoneReadFailure(error, opts.surface)) {
          throw new SurfaceGoneError(opts.surface, error);
        }
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(LAUNCH_SHELL_READY_POLL_MS, remaining));
    }

    throw new BootPromptTimeoutError(
      `Timed out after ${timeoutMs}ms waiting for shell readiness on ${opts.surface}`,
      tailLines(lastText, 10),
    );
  };

  const waitForAgentLaunchReady = async (opts: {
    surface: string;
    workspace?: string;
    timeout_ms?: number;
  }): Promise<void> => {
    const timeoutMs = opts.timeout_ms ?? LAUNCH_SUBMIT_READY_TIMEOUT_MS;
    const start = Date.now();
    let lastText = "";

    while (Date.now() - start < timeoutMs) {
      try {
        const screen = await client.readScreen(opts.surface, {
          workspace: opts.workspace,
          lines: 80,
          scrollback: false,
        });
        lastText = screen.text;
        if (
          READY_PATTERN_CLIS.some(
            (cli) => matchReadyPattern(cli, screen.text).matched,
          )
        ) {
          return;
        }
      } catch (error) {
        if (isSurfaceGoneReadFailure(error, opts.surface)) {
          throw new SurfaceGoneError(opts.surface, error);
        }
        lastText = error instanceof Error ? error.message : String(error);
      }

      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        break;
      }
      await delay(Math.min(LAUNCH_SHELL_READY_POLL_MS, remaining));
    }

    throw new BootPromptTimeoutError(
      `Timed out after ${timeoutMs}ms waiting for agent launch readiness on ${opts.surface}`,
      tailLines(lastText, 10),
    );
  };

  const probeAgentLaunchReadyOnce = async (opts: {
    surface: string;
    workspace?: string;
  }): Promise<void> => {
    try {
      await client.readScreen(opts.surface, {
        workspace: opts.workspace,
        lines: 80,
        scrollback: false,
      });
    } catch (error) {
      if (isSurfaceGoneReadFailure(error, opts.surface)) {
        throw new SurfaceGoneError(opts.surface, error);
      }
    }
  };

  const sendLauncherCommandToSurface = async (opts: {
    surface: string;
    workspace?: string;
    command: string;
  }): Promise<void> => {
    const sanitizedCommand = sanitizeTerminalInput(opts.command);
    const chunks =
      sanitizedCommand.length > SEND_INPUT_CHUNK_THRESHOLD
        ? chunkTerminalInput(sanitizedCommand, SEND_INPUT_CHUNK_THRESHOLD)
        : [sanitizedCommand];

    await waitForLaunchShellReady({
      surface: opts.surface,
      workspace: opts.workspace,
    });
    await withSurfaceWrite(opts.surface, async () => {
      try {
        const delivery = await deliverInputChunks({
          surface: opts.surface,
          workspace: opts.workspace,
          chunks,
          chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
          chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
          press_enter: true,
          source_event: "spawn_agent",
          verify_submit: true,
          submit_verify_timeout_ms: SEND_INPUT_RECOVERY_ENTER_DELAY_MS,
        });
        if (delivery.submit_verified !== true) {
          // The command can clear from the shell without proving the launcher
          // accepted it. Probe once to consume transient ready evidence, then
          // let boot-prompt readiness own update/relaunch monitoring.
          await probeAgentLaunchReadyOnce({
            surface: opts.surface,
            workspace: opts.workspace,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Enter submit could not be verified/.test(message)) {
          throw error;
        }
        // The command can remain visible in shell history while the launcher is
        // already booting. Readiness detection is the authoritative launch check.
        await waitForAgentLaunchReady({
          surface: opts.surface,
          workspace: opts.workspace,
        });
      }
    }, { toolName: "send_command", workspace: opts.workspace });
  };

  const deliverBootPrompt = async (opts: {
    surface: string;
    workspace?: string;
    cli?: CliType;
    prompt?: string;
    boot_prompt_path?: string | null;
    timeout_ms?: number;
    onUpdateShellRelaunch?: () => Promise<void>;
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

    const baselineSubmitMetrics = await waitForBootPromptReady({
      surface: opts.surface,
      workspace: opts.workspace,
      cli: opts.cli,
      timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
      onUpdateShellRelaunch: opts.onUpdateShellRelaunch,
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
      const delivery = await withSurfaceWrite(
        opts.surface,
        async () =>
          deliverInputChunks({
            surface: opts.surface,
            workspace: opts.workspace,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: true,
            source_event: "boot_prompt",
            onChunkDelivered: (count) => {
              sentChunks = count;
            },
            verify_submit: true,
            submit_verify_timeout_ms: opts.timeout_ms
              ? Math.min(SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS, opts.timeout_ms)
              : undefined,
          }),
        { toolName: "boot_prompt", workspace: opts.workspace },
      );
      return { ...delivery, prompt_text: rawPrompt };
    } catch (error) {
      if (error instanceof SurfaceGoneError) {
        throw error;
      }
      if (error instanceof SubmitVerificationError) {
        const snapshot = await readParsedSurface(opts.surface, opts.workspace);
        if (
          !snapshot ||
          !screenShowsPendingInput(snapshot.text, sanitizedText)
        ) {
          await waitForBootPromptSubmitEvidence({
            surface: opts.surface,
            workspace: opts.workspace,
            text: sanitizedText,
            timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
            baseline_metrics: baselineSubmitMetrics,
          });
          return {
            bytes: Buffer.byteLength(sanitizedText, "utf8"),
            retry_count: error.retry_count,
            submit_verified: true,
            prompt_text: rawPrompt,
          };
        }
      }

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

  const isBootPromptDelivered = (
    delivery: Awaited<ReturnType<typeof deliverBootPrompt>> | undefined,
  ): boolean => delivery?.submit_verified === true;

  // ── Auto-focus discipline for split/pane creation ──────────────────
  // cmux attaches a new split to the *currently focused* workspace. When a
  // spawn targets a different workspace, we must focus it BEFORE creating the
  // pane (otherwise the split lands in the wrong workspace — happy-camper's
  // split failed for exactly this reason), then restore the prior focus AFTER
  // the new terminal is fully rendered — but ONLY when a jump was needed.

  const envWorkspaceMatches = (
    workspace: CmuxWorkspace,
    candidate: string,
  ): boolean => {
    const normalized = candidate.trim();
    if (!normalized) return false;
    const aliasNormalized = normalized.replace(/^ws:/, "workspace:");
    return (
      workspace.ref === normalized ||
      workspace.id === normalized ||
      workspace.ref === aliasNormalized ||
      workspace.id === aliasNormalized ||
      workspace.ref === `workspace:${normalized}` ||
      workspace.id === `workspace:${normalized}`
    );
  };

  const canonicalWorkspaceRef = async (
    candidate?: string,
  ): Promise<string | undefined> => {
    if (!candidate) return undefined;
    try {
      const { workspaces } = await client.listWorkspaces();
      return (
        workspaces.find((workspace) => envWorkspaceMatches(workspace, candidate))
          ?.ref ?? candidate
      );
    } catch {
      return candidate;
    }
  };

  /** Caller pane workspace ref first, then focused workspace as fallback. */
  const currentCallerWorkspace = async (): Promise<string | undefined> => {
    try {
      const { workspaces } = await client.listWorkspaces();
      const envCandidates = [
        process.env.CMUX_WORKSPACE_ID,
        process.env.CMUX_TAB_ID,
      ].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
      for (const candidate of envCandidates) {
        const match = workspaces.find((workspace) =>
          envWorkspaceMatches(workspace, candidate),
        );
        if (match) return match.ref;
      }
      return workspaces.find((w) => w.selected)?.ref;
    } catch {
      return undefined;
    }
  };

  /** Currently-focused workspace ref, or undefined if it can't be read. */
  const currentFocusedWorkspace = async (): Promise<string | undefined> => {
    try {
      const { workspaces } = await client.listWorkspaces();
      return workspaces.find((w) => w.selected)?.ref;
    } catch {
      return undefined;
    }
  };

  /**
   * Focus the target workspace before a split when it differs from the prior
   * focus. Returns the prior focus ref IF a jump was performed (so the caller
   * passes it to restoreFocusAfterRender), or null when no jump was needed.
   */
  const focusTargetBeforeSplit = async (
    targetWorkspace: string | undefined,
  ): Promise<string | null> => {
    if (!targetWorkspace) return null;
    const prior = await currentFocusedWorkspace();
    if (!prior || prior === targetWorkspace) return null;
    await client.selectWorkspace(targetWorkspace);
    return prior;
  };

  /**
   * Restore the prior focus AFTER the new terminal is fully rendered — only
   * when a jump actually happened (priorFocus non-null). Waits for shell
   * readiness so focus is not restored mid-render. Restores focus even if
   * readiness times out (never strand focus on the wrong workspace).
   */
  const restoreFocusAfterRender = async (
    priorFocus: string | null,
    surface: string | undefined,
    workspace: string | undefined,
  ): Promise<void> => {
    if (!priorFocus) return;
    if (surface) {
      try {
        await waitForLaunchShellReady({ surface, workspace });
      } catch {
        // Readiness timed out — restore focus anyway rather than strand it.
      }
    }
    await client.selectWorkspace(priorFocus);
  };

  const startBackgroundDelivery = (record: DeliveryRecord) => {
    acquireSurfaceWrite(record.surface, record.delivery_id);
    deliveries.set(record.delivery_id, record);
    latestDeliveryBySurface.set(record.surface, record.delivery_id);
    activeDeliveryBySurface.set(record.surface, record.delivery_id);
    pruneCompletedDeliveryHistory(record.surface);

    const run = async () => {
      try {
        await assertDeliveryTargetIsSafe(record.surface, record.workspace);
        const delivery = await deliverInputChunks({
          surface: record.surface,
          workspace: record.workspace,
          chunks: record.chunks,
          chunk_size: record.chunk_size,
          chunk_delay_ms: record.chunk_delay_ms,
          press_enter: record.press_enter,
          rename_to_task: record.rename_to_task,
          source_event: "send_input",
          verify_submit: record.verify_submit,
          onChunkDelivered: (sentChunks) => {
            record.sent_chunks = sentChunks;
          },
        });
        record.submit_verified = delivery.submit_verified;
        record.retry_count = delivery.retry_count;
        finishDelivery(record, "delivered");
      } catch (error) {
        if (error instanceof SubmitVerificationError) {
          record.submit_verified = false;
          record.retry_count = error.retry_count;
        } else if (error instanceof DeliverySafetyGateError) {
          record.submit_verified = error.submit_verified;
        }
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

  const collectSurfaceTopology = async (
    workspace?: string,
  ) => collectCmuxSurfaceTopology(client, workspace);

  // Resolve a surface's 0-based column + the workspace column_count using the
  // SAME reliable post-F5 logic as list_surfaces: derive columns from pane
  // geometry, then attribute the surface to its pane by membership (pane_id),
  // NOT the unfiltered surface.list. Best-effort: returns nulls on any failure
  // so callers (e.g. read_screen) never break when geometry is unavailable.
  const resolveSurfaceColumn = async (
    surfaceRef: string,
    workspace?: string,
  ): Promise<SurfaceTopology> =>
    (await collectSurfaceTopology(workspace))?.topologyBySurface.get(
      surfaceRef,
    ) ?? EMPTY_SURFACE_TOPOLOGY;

  const resolveSurfaceWorkspace = async (
    surfaceRef: string,
  ): Promise<string | null> =>
    (await collectSurfaceTopology())?.workspaceBySurface.get(surfaceRef) ?? null;

  const evaluateServerAgentHealth = async (
    agent: AgentRecord,
    overrides?: AgentHealthInputOverrides,
  ) => {
    const input = await buildAgentHealthInput(
      agent,
      {
        inboxOpts,
        monitorMaxAgeMs: INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS,
        dispatchAckTimeoutMs: AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
        assessHarvestability: (target) =>
          lifecycleHealthEngine?.assessHarvestability(target),
        resolveTopology: (target) =>
          resolveSurfaceColumn(
            target.surface_id,
            target.workspace_id ?? undefined,
          ),
        readParsedSurface: async (target) => {
          const screen = await readParsedSurface(
            target.surface_id,
            target.workspace_id ?? undefined,
          );
          return screen
            ? {
                status: screen.parsed.status,
                actions: screen.parsed.actions,
              }
            : null;
        },
        resolveSurfaceWorkspace: (target) =>
          resolveSurfaceWorkspace(target.surface_id),
      },
      overrides,
    );
    return evaluateAgentHealth(agent, input);
  };

  const agentForSpawnHealth = (
    agent: AgentRecord,
    result: { workspace_id?: string; warnings?: string[] },
  ): AgentRecord => {
    const placementMismatch =
      result.warnings?.some((warning) =>
        warning.startsWith("Spawn placement mismatch:"),
      ) ?? false;
    if (!placementMismatch || !result.workspace_id) return agent;
    return { ...agent, workspace_id: result.workspace_id };
  };

  const spawnDeliveryWorkspace = (
    result: { actual_workspace_id?: string; workspace_id?: string },
    fallback?: string,
  ): string | undefined =>
    result.actual_workspace_id ?? result.workspace_id ?? fallback;

  const isLeadLikeSurfaceTitle = (title: string): boolean =>
    /\b(?:lead|orchestrator|coordinator|coord)\b/i.test(title);

  const buildOrphanSurfaceHealth = (surface: DiscoveredAgent) => {
    const issueCodes: AgentHealthIssueCode[] = [];
    const issues: string[] = [];
    if (isLeadLikeSurfaceTitle(surface.surface_title)) {
      issueCodes.push("missing_managed_lead_agent_id");
      issues.push(
        "lead/coordinator surface has no managed agent_id; recover/register or replace with a managed lead",
      );
    }

    const title = surface.surface_title.trim().toLowerCase();
    if (
      title === "" ||
      title === "gits" ||
      title === "git" ||
      title === "repos" ||
      title === "projects" ||
      title === "workspace"
    ) {
      issueCodes.push("ambiguous_repo_cwd_label");
      issues.push(
        "orphan terminal surface has an ambiguous repo/cwd label; tab title is not lane ownership",
      );
    }

    const issueSeverities = Object.fromEntries(
      issueCodes.map((code) => [code, DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY[code]]),
    );
    const hasBlockingIssue = issueCodes.some(
      (code) => DEFAULT_AGENT_HEALTH_ISSUE_SEVERITY[code] === "blocking",
    );
    return {
      surface_id: surface.surface_id,
      surface_title: surface.surface_title,
      workspace_id: surface.workspace_id ?? null,
      status:
        issueCodes.length === 0
          ? "unknown"
          : hasBlockingIssue
            ? "unhealthy"
            : "degraded",
      issue_codes: issueCodes,
      issues,
      ...(issueCodes.length > 0 ? { issue_severities: issueSeverities } : {}),
    };
  };

  const collectDeliveryEvidence = async (agentId: string) => {
    const agent = context.lifecycleSweepEngine?.getAgentState(agentId) ?? null;
    if (!agent) {
      return {
        registry_state: null,
        screen: null,
        state_conflict: false,
        health: undefined,
      };
    }
    const screen = await readParsedSurface(
      agent.surface_id,
      agent.workspace_id ?? undefined,
    );
    const topology = await collectSurfaceTopology();
    const health = await evaluateServerAgentHealth(agent, {
      screen_status: screen?.parsed.status ?? null,
      screen_actions: screen?.parsed.actions ?? null,
      ...healthTopologyOverrides(agent, topology),
    });
    return {
      registry_state: agent.state,
      screen: screen
        ? {
            status: screen.parsed.status,
            agent_type: screen.parsed.agent_type,
            model: screen.parsed.model,
            done_signal: screen.parsed.done_signal,
            actions: screen.parsed.actions ?? [],
          }
        : null,
      state_conflict: health.issue_codes.includes(
        "registry_screen_disagreement",
      ),
      health,
    };
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
        const workspaceCwdByRef = new Map<string, string>();
        for (const workspace of workspaces.workspaces) {
          const cwd = nonEmptyString(workspace.current_directory);
          if (cwd) {
            workspaceCwdByRef.set(workspace.ref, cwd);
          }
        }
        const paneByWorkspaceAndRef = new Map<string, Record<string, unknown>>();
        for (const { workspaceRef, panes } of panesByWorkspace) {
          for (const pane of panes.panes) {
            paneByWorkspaceAndRef.set(
              paneWorkingDirectoryKey(workspaceRef, pane.ref),
              pane as unknown as Record<string, unknown>,
            );
          }
        }
        const columnIndexByWorkspace = new Map<string, Map<string, number>>();
        const columnCountByWorkspace = new Map<string, number>();
        for (const { workspaceRef, panes } of panesByWorkspace) {
          const columnIndex = deriveColumnIndex(panes.panes);
          columnIndexByWorkspace.set(workspaceRef, columnIndex);
          columnCountByWorkspace.set(
            workspaceRef,
            new Set(columnIndex.values()).size,
          );
        }
        const surfaceGroupsByWorkspace = await Promise.all(
          panesByWorkspace.map(async ({ workspaceRef, panes }) => {
            const rawGroups = await Promise.all(
              panes.panes.map(async (pane) => {
                const group = await client.listPaneSurfaces({
                  workspace: workspaceRef,
                  pane: pane.ref,
                });
                return {
                  ...group,
                  workspace_ref: group.workspace_ref ?? workspaceRef,
                  pane_ref: group.pane_ref ?? pane.ref,
                };
              }),
            );
            return partitionPaneSurfacesByMembership(panes.panes, rawGroups, {
              workspace_ref: panes.workspace_ref ?? workspaceRef,
              window_ref: panes.window_ref,
            });
          }),
        );
        const surfaceGroups = surfaceGroupsByWorkspace.flat();
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
            const column = columnIndexByWorkspace
              .get(group.workspace_ref)
              ?.get(group.pane_ref);
            if (typeof column === "number") {
              enrichedSurface.column = column;
            }

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
        const terminalMetadata = await loadTerminalMetadataBySurface(client);
        const workingDirectoryMaps: SurfaceWorkingDirectoryMaps = {
          terminalBySurface: terminalMetadata.terminalBySurface,
          paneByWorkspaceAndRef,
          workspaceCwdByRef,
        };
        for (const surface of verboseSurfaces) {
          const workspaceRef = nonEmptyString(surface.workspace_ref) ?? "";
          const paneRef = nonEmptyString(surface.pane_ref) ?? "";
          applySurfaceWorkingDirectory(
            surface,
            workspaceRef,
            paneRef,
            workingDirectoryMaps,
          );
        }

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
          column_count: targetWorkspaceRefs.reduce(
            (max, workspaceRef) =>
              Math.max(max, columnCountByWorkspace.get(workspaceRef) ?? 0),
            0,
          ),
        };
        if (args.workspace) {
          data.workspace_ref = args.workspace;
        }
        if (terminalMetadata.degraded) {
          data.metadata_degraded = terminalMetadata.degraded;
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
    "control_health",
    "Report cmuxlayer control-path health: selected transport, prod/nightly socket markers, cmux binary resolution, process env, and job-control diagnostics.",
    {},
    ANNOTATIONS.readOnly,
    async () => {
      try {
        const health = await appendControlHealthSnapshot();
        return okFormatted(formatControlHealth(health), {
          health,
        });
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

  server.tool(
    "create_workspace",
    "Create a new workspace tab. Returns the new workspace ref and title.",
    {
      title: z.string().describe("Workspace title"),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        await assertWorkspaceMutationAllowed(
          "create_workspace",
          await currentCallerWorkspace(),
        );
        const result = await client.createWorkspace(args.title);
        const data = {
          workspace: result.workspace,
          title: result.title,
        };
        return okFormatted(formatOk("create_workspace", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 2. new_split
  server.tool(
    "new_split",
    "Create a new split pane (terminal or browser). PLACEMENT IS BY ROLE, NOT BY HAND: pass `role` (or let it infer from the launcher title) and the layout policy enforces the two-column invariant — leads/orchestrators land in the LEFT column, workers land in the RIGHT column, and extra workers dock as tabs in the rightmost worker pane (never a third column). Workspace-targeted splits auto-focus the target before splitting and restore your prior focus after the new pane renders, so you do not hand-run focus-pane around splits. For terminal panes that boot an agent, boot_prompt_path can deliver a file prompt after the agent reaches a ready prompt.",
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
          "Agent role drives deterministic column placement: orchestrator/ic → LEFT column (leads, the Claude that coordinates), worker → RIGHT column (Codex/Cursor that implement/gather). Defaults from title launcher suffix: *Claude=orchestrator, *Codex/*Cursor=worker. Pass this instead of trying to control left/right via direction.",
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
        const targetWorkspace =
          args.workspace ??
          (await resolveWorkspaceForRepo(
            inferRepoFromLauncherTitle(args.title),
          ));
        const shouldInferRole =
          Boolean(args.role) ||
          (!args.pane &&
            !args.surface &&
            canInferAgentRole({ title: args.title }));
        const inferredRole = shouldInferRole
          ? inferAgentRole({ role: args.role, title: args.title })
          : null;
        if (
          inferredRole &&
          (args.type ?? "terminal") === "terminal" &&
          (args.pane || args.surface)
        ) {
          throw new Error(
            "pane/surface cannot be combined with role-based new_split; omit the explicit target or omit role",
          );
        }
        if (args.surface) {
          await assertSurfaceMutationAllowed("new_split", args.surface);
        } else if (targetWorkspace) {
          await assertWorkspaceMutationAllowed("new_split", targetWorkspace);
        }
        if (bootPromptPath) {
          if ((args.type ?? "terminal") !== "terminal") {
            throw new Error(
              "boot_prompt_path is only supported for terminal surfaces",
            );
          }
          await preflightBootPromptFile(bootPromptPath);
        }

        // Auto-focus only applies to workspace-targeted splits (no explicit
        // pane/surface anchor). Captured right before creation, AFTER all
        // validation, so a rejected request has no focus side effects.
        let priorFocus: string | null = null;
        let actualPlacement: "split" | "surface" = "split";
        let actualDirection: string | null = args.direction;
        if (inferredRole && (args.type ?? "terminal") === "terminal") {
          const panes = await client.listPanes({ workspace: targetWorkspace });
          const rawPaneSurfaces = await Promise.all(
            panes.panes.map(async (pane) => {
              const ps = await client.listPaneSurfaces({
                workspace: targetWorkspace,
                pane: pane.ref,
              });
              // cmux socket omits pane_ref; inject it so describePaneLayouts
              // can match panes to their surfaces for role-based placement.
              return ps.pane_ref ? ps : { ...ps, pane_ref: pane.ref };
            }),
          );
          const paneSurfaces = partitionPaneSurfacesByMembership(
            panes.panes,
            rawPaneSurfaces,
            {
              workspace_ref: panes.workspace_ref ?? targetWorkspace,
              window_ref: panes.window_ref,
            },
          );
          const liveSurfaceIds = new Set(
            paneSurfaces.flatMap((group) =>
              group.surfaces.map((surface) => surface.ref),
            ),
          );
          const placement = chooseAgentSpawnPlacement(
            panes.panes,
            paneSurfaces,
            collectServerRoleSurfaceIds(liveSurfaceIds, targetWorkspace),
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
          // Role-based placement has no explicit pane/surface (validated above),
          // so it is always a workspace-targeted split — apply auto-focus.
          priorFocus = await focusTargetBeforeSplit(targetWorkspace);
          result =
            placement.kind === "surface"
              ? await client.newSurface({
                  pane: placement.pane,
                  workspace: targetWorkspace,
                  type: "terminal",
                })
              : await client.newSplit(placement.direction, {
                  workspace: targetWorkspace,
                  ...(placement.pane ? { pane: placement.pane } : {}),
                  surface: args.surface,
                  type: args.type,
                  url: args.url,
                  title: args.title,
                  focus: args.focus,
                });
        } else {
          // Only workspace-targeted splits need auto-focus; an explicit
          // pane/surface anchor already pins the destination workspace.
          if (!args.pane && !args.surface) {
            priorFocus = await focusTargetBeforeSplit(targetWorkspace);
          }
          result = await client.newSplit(args.direction, {
            workspace: targetWorkspace,
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
            workspace: result.workspace || targetWorkspace,
          });
          result.title = args.title;
        }
        if (inferredRole && (args.type ?? "terminal") === "terminal") {
          roleSurfaceOverrides.set(result.surface, {
            role: inferredRole,
            workspace: result.workspace ?? targetWorkspace ?? null,
          });
        }
        let bootPromptDelivery:
          | Awaited<ReturnType<typeof deliverBootPrompt>>
          | undefined;
        if (bootPromptPath) {
          const launcher = inferLauncherFromTitle(args.title ?? result.title);
          bootPromptDelivery = await deliverBootPrompt({
            surface: result.surface,
            workspace: result.workspace || targetWorkspace,
            cli: launcher?.cli,
            boot_prompt_path: bootPromptPath,
            timeout_ms: args.boot_prompt_timeout_ms,
            onUpdateShellRelaunch: launcher
              ? () =>
                  sendLauncherCommandToSurface({
                    surface: result!.surface,
                    workspace: result!.workspace || targetWorkspace,
                    command: buildLaunchCommand(
                      launcher.cli,
                      launcher.repo,
                      undefined,
                      launcher.launcherName,
                    ),
                  })
              : undefined,
          });
        }
        await restoreFocusAfterRender(
          priorFocus,
          result.surface,
          result.workspace || targetWorkspace,
        );
        const data: Record<string, unknown> = { ...result };
        data.placement = actualPlacement;
        data.direction = actualDirection;
        if (inferredRole) {
          data.role = inferredRole;
        }
        if (bootPromptDelivery) {
          data.boot_prompt_delivered = isBootPromptDelivered(
            bootPromptDelivery,
          );
          data.boot_prompt_bytes = bootPromptDelivery.bytes;
          data.boot_prompt_submit_verified =
            bootPromptDelivery.submit_verified;
        }
        return okFormatted(
          formatOk("new_split", {
            surface: result.surface,
            direction: actualDirection,
            placement: actualPlacement,
            type: args.type,
            title: result.title,
            role: inferredRole ?? undefined,
            boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
          }),
          data,
        );
      } catch (e) {
        if (e instanceof SurfaceGoneError) {
          return err(e, surfaceGonePayload(e));
        }
        if (e instanceof BootPromptTimeoutError) {
          return err(e, {
            surface: result?.surface,
            last_10_lines: e.last_10_lines,
          });
        }
        if (e instanceof BootPromptUpdateMenuBlockedError) {
          return err(e, {
            surface: result?.surface,
            error_code: e.error_code,
            last_10_lines: e.last_10_lines,
            recovery: e.recovery,
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
            throw new Error(
              "boot_prompt_path is only supported for terminal surfaces",
            );
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
          const launcher = inferLauncherFromTitle(args.title ?? result.title);
          bootPromptDelivery = await deliverBootPrompt({
            surface: result.surface,
            workspace: result.workspace || args.workspace,
            cli: launcher?.cli,
            boot_prompt_path: bootPromptPath,
            timeout_ms: args.boot_prompt_timeout_ms,
            onUpdateShellRelaunch: launcher
              ? () =>
                  sendLauncherCommandToSurface({
                    surface: result!.surface,
                    workspace: result!.workspace || args.workspace,
                    command: buildLaunchCommand(
                      launcher.cli,
                      launcher.repo,
                      undefined,
                      launcher.launcherName,
                    ),
                  })
              : undefined,
          });
        }
        const data: Record<string, unknown> = { ...result };
        if (bootPromptDelivery) {
          data.boot_prompt_delivered = isBootPromptDelivered(
            bootPromptDelivery,
          );
          data.boot_prompt_bytes = bootPromptDelivery.bytes;
          data.boot_prompt_submit_verified =
            bootPromptDelivery.submit_verified;
        }
        return okFormatted(
          formatOk("new_surface", {
            pane: args.pane,
            surface: result.surface,
            type: result.type,
            title: result.title,
            boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
          }),
          data,
        );
      } catch (e) {
        if (e instanceof SurfaceGoneError) {
          return err(e, surfaceGonePayload(e));
        }
        if (e instanceof BootPromptTimeoutError) {
          return err(e, {
            surface: result?.surface,
            last_10_lines: e.last_10_lines,
          });
        }
        if (e instanceof BootPromptUpdateMenuBlockedError) {
          return err(e, {
            surface: result?.surface,
            error_code: e.error_code,
            last_10_lines: e.last_10_lines,
            recovery: e.recovery,
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
        await assertSurfaceMutationAllowed("move_surface", args.surface);
        const result = await client.moveSurface({
          surface: args.surface,
          pane: args.pane,
          workspace: args.workspace,
          before: args.before,
          after: args.after,
          index: args.index,
          focus: args.focus,
        });
        // F8: slim, phone-readable confirmation — drop the verbose passthrough.
        const data = {
          surface: result.surface,
          pane: result.pane,
          workspace: result.workspace,
        };
        const dest = result.pane ?? result.workspace ?? "destination";
        return okFormatted(
          `✔ move_surface ─ moved ${result.surface} → ${dest}`,
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
        await assertSurfaceMutationAllowed("reorder_surface", args.surface);
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
    `Low-level surface tool: send text input to a terminal surface. For tracked agents, prefer send_to(agent_id) so cmuxlayer resolves the current backing surface. WARNING — DO NOT include a bare \`@word\` (e.g. \`@narration-lead\`) in text destined for an interactive agent composer (Claude Code / Codex / Cursor TUIs): the receiving composer treats \`@\` as its file-reference trigger and pops a file-picker overlay, swallowing the rest of your message — silent delivery corruption that the ok:true result will NOT report. Use the bare name (\`narration-lead:\`) for pane-to-pane addressing; reserve \`@<name>\` for collab-file posts where monitors match it. If a literal \`@\` is unavoidable, deliver via a file the agent cat-reads, not live keystrokes. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters by default (CMUXLAYER_MAX_INLINE_CHARS, positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}); write large payloads to a file and send one line: "Read and follow <path>". Pass allow_long_inline:true only for deliberate raw sends. Text over ${SEND_INPUT_CHUNK_THRESHOLD} characters that is allowed is automatically chunked into line-aligned batches before delivery, and each chunk waits for cmux acknowledgment before the next is sent. Chunked or multiline text is pasted into the composer so embedded newlines do not submit partial messages; press_enter=true presses return once after the final chunk. Set background=true to return immediately with a delivery_id while chunking continues in the background. For full commands, prefer send_command so text and return land on the same surface atomically.`,
    {
      surface: z.string().describe("Target surface ref"),
      text: z
        .string()
        .describe(
          `Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default; for large payloads write a file and send "Read and follow <path>" instead.`,
        ),
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
        .describe("Press return once after all chunks have landed."),
      rename_to_task: z
        .string()
        .optional()
        .describe("Rename tab suffix to this task name"),
      allow_long_inline: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Bypass the inline length cap for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        assertInlineInputAllowed({
          tool: "send_input",
          arg: "text",
          value: args.text,
          allowLongInline: args.allow_long_inline,
        });
        const sanitizedText = sanitizeTerminalInput(args.text);
        const chunks =
          sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
            ? chunkTerminalInput(sanitizedText, args.chunk_size)
            : [sanitizedText];
        const targetRecord = resolveLatestSurfaceAgentRecord(
          stateMgr,
          args.surface,
        );
        const shouldVerifySubmit =
          args.press_enter &&
          !!targetRecord &&
          INTERACTIVE_AGENT_STATES.has(targetRecord.state);

        if (args.background) {
          await assertSurfaceMutationAllowed(
            "send_input",
            args.surface,
            args.workspace,
          );
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
            verify_submit: shouldVerifySubmit,
            submit_verified: null,
            retry_count: 0,
            rename_to_task: args.rename_to_task,
            started_at: new Date().toISOString(),
          };
          startBackgroundDelivery(record);

          const identity = resolveTargetIdentity(stateMgr, args.surface);
          const data = {
            ...identity,
            delivered: false,
            delivery_id: record.delivery_id,
            status: record.status,
            submit_verified: record.submit_verified,
            retry_count: record.retry_count,
          };
          return okFormatted(
            formatDelivery("send_input", {
              ...identity,
              delivered: false,
              pending: true,
            }) + ` (background ${record.delivery_id})`,
            data,
          );
        }

        const delivery = await withSurfaceWrite(args.surface, async () => {
          await assertDeliveryTargetIsSafe(args.surface, args.workspace);
          return deliverInputChunks({
            surface: args.surface,
            workspace: args.workspace,
            chunks,
            chunk_size: args.chunk_size,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: args.press_enter,
            rename_to_task: args.rename_to_task,
            source_event: "send_input",
            verify_submit: shouldVerifySubmit,
          });
        }, { toolName: "send_input", workspace: args.workspace });

        const identity = resolveTargetIdentity(stateMgr, args.surface);
        const data = {
          ...identity,
          delivered: true,
          retry_count: delivery.retry_count,
          submit_verified: delivery.submit_verified,
        };
        return okFormatted(
          formatDelivery("send_input", {
            ...identity,
            delivered: true,
            submit_verified: delivery.submit_verified,
          }),
          data,
        );
      } catch (e) {
        if (e instanceof SurfaceGoneError) {
          return err(e, surfaceGonePayload(e));
        }
        if (e instanceof DeliverySafetyGateError) {
          return err(e, {
            error_code: e.error_code,
            submit_verified: e.submit_verified,
            screen: e.screen,
          });
        }
        if (e instanceof SubmitVerificationError) {
          return err(e, {
            submit_verified: false,
            retry_count: e.retry_count,
          });
        }
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
    `Atomically send a command and press return on the same raw surface. Prefer this over separate send_input + send_key calls when launching or resuming agents. If the user provided an exact command, send exactly that command only when it fits the ${SEND_INPUT_MAX_INLINE_CHARS}-character inline cap. WARNING — never include a bare \`@word\` in text destined for an interactive agent composer: it fires the receiver's file-reference picker and corrupts delivery (use the bare name; \`@<name>\` belongs in collab files, not pane keystrokes). For known agent launchers with -s (for example brainlayerCodex -s), boot_prompt_path reads a prompt file after the launcher reaches readiness and submits it; use boot_prompt_path instead of embedding a long boot prompt in pane keystrokes. Passing boot_prompt_path for plain shell commands is rejected. Pass allow_long_inline:true only for deliberate raw long commands.`,
    {
      surface: z.string().describe("Target surface ref"),
      command: z
        .string()
        .describe(
          `Command text to send before pressing return. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default; for agent boot prompts, keep the command short and pass boot_prompt_path.`,
        ),
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
      allow_long_inline: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Bypass the inline command length cap for a deliberate raw send.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        assertInlineInputAllowed({
          tool: "send_command",
          arg: "command",
          value: args.command,
          allowLongInline: args.allow_long_inline,
        });
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
        const targetRecord = resolveLatestSurfaceAgentRecord(
          stateMgr,
          args.surface,
        );
        const shouldVerifySubmit =
          !!targetRecord && INTERACTIVE_AGENT_STATES.has(targetRecord.state);

        const delivery = await withSurfaceWrite(args.surface, async () => {
          await assertDeliveryTargetIsSafe(args.surface, args.workspace);
          return deliverInputChunks({
            surface: args.surface,
            workspace: args.workspace,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: true,
            source_event: "send_command",
            verify_submit: bootPromptPath ? false : shouldVerifySubmit,
          });
        }, { toolName: "send_command", workspace: args.workspace });

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
            onUpdateShellRelaunch: () =>
              sendLauncherCommandToSurface({
                surface: args.surface,
                workspace: args.workspace,
                command: sanitizedCommand,
              }),
          });
        }

        const identity = resolveTargetIdentity(stateMgr, args.surface);
        const data = {
          ...identity,
          command: sanitizedCommand,
          delivered: true,
          retry_count: delivery.retry_count,
          submit_verified: delivery.submit_verified,
          boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
          boot_prompt_bytes: bootPromptDelivery?.bytes,
          boot_prompt_submit_verified: bootPromptDelivery?.submit_verified ?? null,
        };
        return okFormatted(
          formatDelivery("send_command", {
            ...identity,
            delivered: true,
            submit_verified: delivery.submit_verified,
          }),
          data,
        );
      } catch (e) {
        if (e instanceof SurfaceGoneError) {
          return err(e, surfaceGonePayload(e));
        }
        if (e instanceof DeliverySafetyGateError) {
          return err(e, {
            error_code: e.error_code,
            submit_verified: e.submit_verified,
            screen: e.screen,
          });
        }
        if (e instanceof SubmitVerificationError) {
          return err(e, {
            submit_verified: false,
            retry_count: e.retry_count,
          });
        }
        if (e instanceof BootPromptTimeoutError) {
          return err(e, { last_10_lines: e.last_10_lines });
        }
        if (e instanceof BootPromptUpdateMenuBlockedError) {
          return err(e, {
            error_code: e.error_code,
            last_10_lines: e.last_10_lines,
            recovery: e.recovery,
          });
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
        }, { toolName: "send_key", workspace: args.workspace });
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
    "Read terminal screen with parsed agent status. Returns parsed fields: agent_type, status, model, token_count, context_pct (% used), context_window (max tokens), cost, done_signal, response, errors, plus delivery metadata. LEAN BY DEFAULT: the response is returned once (parsed.response); the raw terminal dump is NOT included — instead a compact, de-chromed screen_preview (box-drawing rules + status-bar art stripped) is included only when there is no parsed.response. Pass raw=true for the full untrimmed terminal content, or parsed_only=true for parsed fields alone (best for monitoring). Do not treat read_screen alone as visual confirmation of the highlighted row in interactive terminal menus.",
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
          "If true, return only parsed fields (omit screen content). Best for agent monitoring.",
        ),
      raw: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, include the full untrimmed terminal content (separators, status-bar art, all lines). Default false returns a compact de-chromed screen_preview instead.",
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
        const parsed = applyHarnessState(
          enrichParsedScreen(
            parseScreen(result.text),
            result.text,
            pickLatestSurfaceModel(stateMgr, result.surface),
          ),
          resolveHarnessStateForSurface(stateMgr, result.surface),
        );
        // F7: surface column + workspace column_count so sprawl is visible on
        // every read. Best-effort — omitted (null) if geometry is unavailable.
        const { column, column_count } = await resolveSurfaceColumn(
          result.surface,
          args.workspace,
        );

        if (args.parsed_only) {
          const data = {
            surface: result.surface,
            title: surface?.title ?? null,
            column,
            column_count,
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
            column,
            column_count,
          );
          return okFormatted(formatted, data);
        }

        if (args.raw) {
          // Full untrimmed terminal content on explicit request.
          const data = {
            surface: result.surface,
            title: surface?.title ?? null,
            column,
            column_count,
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
            column,
            column_count,
          );
          return okFormatted(formatted, data);
        }

        // LEAN DEFAULT: response returned once (parsed.response); no raw dump. Show a
        // compact de-chromed preview ONLY when there's no response, so non-agent panes
        // (shell prompts, menus) still surface something without duplicating the response.
        const screenPreview = parsed.response
          ? null
          : cleanScreenText(result.text, 12) || null;
        const data = {
          surface: result.surface,
          title: surface?.title ?? null,
          column,
          column_count,
          parsed,
          ...(screenPreview ? { screen_preview: screenPreview } : {}),
          delivery: getSurfaceDelivery(result.surface),
        };
        const formatted = formatReadScreen(
          result.surface,
          surface?.title ?? null,
          screenPreview,
          parsed,
          false,
          screenPreview ? screenPreview.split("\n").length : 0,
          column,
          column_count,
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
        }, { toolName: "rename_tab", workspace: args.workspace });
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
    "Close a surface (terminal or browser pane). SAFETY: if the surface still backs a live agent (not done/error), the close is REFUSED unless force:true, and the response includes a fresh read of the pane so you can confirm for yourself whether it is really finished before destroying it. Browser panes and surfaces with no tracked agent close normally.",
    {
      surface: z.string().describe("Target surface ref"),
      workspace: z.string().optional().describe("Target workspace ref"),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Close even when the backing agent is still live (not done/error). Without this, a live agent's surface is protected and the response returns the current pane contents instead of closing.",
        ),
    },
    ANNOTATIONS.destructive,
    async (args) => {
      try {
        await assertSurfaceMutationAllowed(
          "close_surface",
          args.surface,
          args.workspace,
        );
        let staleRegistryDoneConsolidated:
          | { agent_id: string; previous_state: AgentState; done_signal: string }
          | undefined;
        // Liveness guard: never destroy a pane whose agent is still live unless
        // the caller explicitly forces it. This is the safety net for the
        // "stale list said it was gone but it was actually alive" failure — on
        // refusal we hand back a fresh pane read so the caller assesses the
        // real screen, not a possibly-stale state record.
        if (!args.force) {
          // Fail-safe across records: a surface can transiently back more than
          // one state record (crash-resume collisions before canonicalization).
          // Match the first record that is still LIVE rather than an arbitrary
          // first hit, so a stale terminal record can never let us tear down a
          // surface that another, live record still owns.
          const backingAgent = stateMgr
            .listStates()
            .find(
              (record) =>
                record.surface_id === args.surface &&
                !TERMINAL_AGENT_STATES.has(record.state),
            );
          if (backingAgent) {
            let screenText = "(unable to read pane)";
            let screenParsed: ReturnType<typeof parseScreen> | null = null;
            try {
              const screen = await client.readScreen(args.surface, {
                workspace: args.workspace,
                lines: 40,
              });
              screenText = screen.text;
              screenParsed = parseScreen(screen.text);
            } catch {
              // Best-effort read; refuse regardless so a live agent is never
              // torn down without an explicit force.
            }
            if (
              screenParsed?.done_signal &&
              !screenHasActiveAgentMarker(
                backingAgent.cli,
                screenText,
                screenParsed,
              )
            ) {
              try {
                const marked = stateMgr.updateRecord(backingAgent.agent_id, {
                  task_done_candidate_at: null,
                  task_done_detected_at: new Date().toISOString(),
                  ...(backingAgent.boot_prompt_pending
                    ? { boot_prompt_pending: false }
                    : {}),
                });
                context.lifecycleRegistry?.set(backingAgent.agent_id, marked);
                const done = stateMgr.transition(backingAgent.agent_id, "done");
                context.lifecycleRegistry?.set(backingAgent.agent_id, done);
                staleRegistryDoneConsolidated = {
                  agent_id: backingAgent.agent_id,
                  previous_state: backingAgent.state,
                  done_signal: screenParsed.done_signal,
                };
              } catch {
                // If consolidation fails, keep the fail-safe refusal path.
                appendCloseEvent({
                  event: "close_surface",
                  target: `${args.surface} (agent ${backingAgent.agent_id})`,
                  caller: resolveCloseCaller("close_surface"),
                  force: args.force ?? false,
                  reason: `refused: agent still live (${backingAgent.state}), registry consolidation failed`,
                  refused: true,
                });
                return err(
                  new Error(
                    `Refused to close ${args.surface}: agent ${backingAgent.agent_id} is "${backingAgent.state}" (still live) and registry consolidation failed. Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                  ),
                  {
                    refused: true,
                    surface: args.surface,
                    agent_id: backingAgent.agent_id,
                    state: backingAgent.state,
                    screen: screenText,
                    parsed: screenParsed,
                  },
                );
              }
              const remainingLiveAgent = stateMgr
                .listStates()
                .find(
                  (record) =>
                    record.surface_id === args.surface &&
                    !TERMINAL_AGENT_STATES.has(record.state),
                );
              if (remainingLiveAgent) {
                appendCloseEvent({
                  event: "close_surface",
                  target: `${args.surface} (agent ${remainingLiveAgent.agent_id})`,
                  caller: resolveCloseCaller("close_surface"),
                  force: args.force ?? false,
                  reason: `refused: agent still live (${remainingLiveAgent.state}) after stale registry consolidation`,
                  refused: true,
                });
                return err(
                  new Error(
                    `Refused to close ${args.surface}: agent ${remainingLiveAgent.agent_id} is "${remainingLiveAgent.state}" (still live) after stale registry consolidation. Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                  ),
                  {
                    refused: true,
                    surface: args.surface,
                    agent_id: remainingLiveAgent.agent_id,
                    state: remainingLiveAgent.state,
                    screen: screenText,
                    parsed: screenParsed,
                    stale_registry_done_consolidated:
                      staleRegistryDoneConsolidated,
                  },
                );
              }
            } else {
              appendCloseEvent({
                event: "close_surface",
                target: `${args.surface} (agent ${backingAgent.agent_id})`,
                caller: resolveCloseCaller("close_surface"),
                force: args.force ?? false,
                reason: `refused: agent still live (${backingAgent.state})`,
                refused: true,
              });
              return err(
                new Error(
                  `Refused to close ${args.surface}: agent ${backingAgent.agent_id} is "${backingAgent.state}" (still live). Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                ),
                {
                  refused: true,
                  surface: args.surface,
                  agent_id: backingAgent.agent_id,
                  state: backingAgent.state,
                  screen: screenText,
                  parsed: screenParsed,
                },
              );
            }
          }
        }

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
            const rawPaneSurfaces = await Promise.all(
              panes.panes.map(async (pane) => {
                const ps = await client.listPaneSurfaces({
                  workspace,
                  pane: pane.ref,
                });
                return ps.pane_ref ? ps : { ...ps, pane_ref: pane.ref };
              }),
            );
            const paneSurfaces = partitionPaneSurfacesByMembership(
              panes.panes,
              rawPaneSurfaces,
              {
                workspace_ref: panes.workspace_ref ?? workspace,
                window_ref: panes.window_ref,
              },
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

        const collapsePane = closePolicy?.collapsePane ?? false;
        await client.closeSurface(args.surface, {
          workspace: args.workspace,
          collapsePane,
        });
        appendCloseEvent({
          event: "close_surface",
          target: args.surface,
          caller: resolveCloseCaller("close_surface"),
          force: args.force ?? false,
          reason: staleRegistryDoneConsolidated
            ? `closed after stale-registry done consolidation (agent ${staleRegistryDoneConsolidated.agent_id})`
            : null,
          refused: false,
        });
        const data = {
          surface: args.surface,
          pane: closePolicy?.pane ?? undefined,
          collapse_pane: collapsePane,
          stale_registry_done_consolidated: staleRegistryDoneConsolidated,
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

        if (args.surface) {
          await assertSurfaceMutationAllowed(
            "browser_surface",
            args.surface,
            args.workspace,
          );
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

  // 12. dispatch_to_agent — metacommlayer WRITE channel (sterile dispatch; send_input fallback)
  // AIDEV-NOTE: B5 (2026-06-05 incident) — the wake must NOT depend on agent
  // lifecycle state. A poisoned (error) registry record used to silently kill
  // the send_input fallback (INTERACTIVE_STATES gate in sendToAgent) and GO
  // messages sat unread. The nudge below types a one-line inbox pointer
  // directly into the agent's surface, regardless of registry state.
  server.tool(
    "dispatch_to_agent",
    "Append a task to an agent's inbox FILE (the deterministic write channel). The agent acts on it via a persistent native Monitor on its inbox — NO send_input/TUI typing. If the recipient's monitor heartbeat is stale/absent, nudge='auto' (default) best-effort types a one-line inbox pointer into the agent's surface — independent of agent lifecycle state. Address to:'orc' to flag the orchestrator (own-tag triage). Channel is EPHEMERAL plumbing — set persist:true only for decisions that should be brain_store'd.",
    {
      agent_id: z
        .string()
        .describe(
          "Recipient agent id (its inbox is ~/.cmux/agents/<id>/inbox.jsonl)",
        ),
      task: z.string().describe("The dispatch payload / instruction"),
      from: z.string().optional().default("orc").describe("Sender id"),
      tag: z
        .string()
        .optional()
        .default("dispatch")
        .describe("Routing/semantics tag"),
      persist: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Opt-in: mark this message as a candidate for BrainLayer ingestion",
        ),
      nudge: z
        .enum(["auto", "never"])
        .optional()
        .default("auto")
        .describe(
          "auto: when the recipient's inbox-monitor heartbeat is stale/absent, best-effort type a one-line inbox pointer into its surface (bypasses agent-state gates — works even when registry state is poisoned). never: file append only.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const msg = dispatch(
          args.agent_id,
          {
            from: args.from,
            to: args.agent_id,
            tag: args.tag,
            task: args.task,
            persist: args.persist,
          },
          inboxOpts,
        );
        const monitor_alive = monitorAlive(
          args.agent_id,
          INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS,
          inboxOpts,
        );
        const pending = pendingDispatches(
          args.agent_id,
          AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
          inboxOpts,
        );
        const nudge: {
          attempted: boolean;
          sent: boolean;
          reason: string;
          error_code?: string;
        } = { attempted: false, sent: false, reason: "" };
        if (args.nudge === "never") {
          nudge.reason = "nudge disabled by caller";
        } else if (monitor_alive) {
          nudge.reason = "monitor heartbeat fresh — Monitor will deliver";
        } else {
          // State-independent surface lookup: ANY registry record (including
          // error/done) still carries the surface ref. allow_busy bypasses the
          // INTERACTIVE_STATES gate, but the guarded relay path keeps the
          // stale-surface resync + recycled-occupant identity checks so the
          // pointer can never land in a foreign agent's pane.
          await refreshManagedMetadataBestEffort(args.agent_id);
          let record = context.lifecycleRegistry?.get(args.agent_id) ?? null;
          if (!record) {
            try {
              await lifecycleEnsureRegistered?.();
              record = context.lifecycleRegistry?.get(args.agent_id) ?? null;
            } catch {
              // Best-effort only: dispatch has already appended the durable inbox message.
            }
          }
          if (!record || !lifecycleAgentInputDeliverer) {
            nudge.reason = record
              ? "agent lifecycle relay unavailable — message waits in the inbox file"
              : "agent not in lifecycle registry; no surface to nudge — message waits in the inbox file";
          } else {
            nudge.attempted = true;
            try {
              const pointer = `[inbox] new message from ${msg.from} (id ${msg.id}) — read ${inboxPath(args.agent_id, inboxOpts)}, act, then ack`;
              await lifecycleAgentInputDeliverer({
                agent_id: args.agent_id,
                text: pointer,
                press_enter: true,
                allow_busy: true,
                source_event: "dispatch_nudge",
              });
              nudge.sent = true;
              nudge.reason = `heartbeat stale/absent — typed inbox pointer into ${record.surface_id} (state: ${record.state})`;
            } catch (e) {
              if (e instanceof DeliverySafetyGateError) {
                nudge.error_code = e.error_code;
              }
              nudge.reason = `nudge failed (dispatch still durable in inbox file): ${
                e instanceof Error ? e.message : String(e)
              }`;
            }
          }
        }
        await refreshManagedMetadataBestEffort(args.agent_id);
        const record = context.lifecycleRegistry?.get(args.agent_id) ?? null;
        const health = record
          ? await evaluateServerAgentHealth(record, {
              monitor_alive,
              stale_count: pending.length,
            })
          : undefined;
        return ok({
          dispatched: msg,
          inbox: inboxPath(args.agent_id, inboxOpts),
          monitor_alive,
          health,
          nudge,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // 13. inbox_check — orc-side liveness/delivery view of an agent's write channel
  server.tool(
    "inbox_check",
    "Inspect an agent's inbox channel: undelivered (un-acked) messages, monitor liveness (heartbeat freshness), and stale dispatches past the ACK-timeout. A non-empty 'pending' for a live-looking agent means its monitor is wedged → fall back to send_input. Read-only.",
    {
      agent_id: z.string().describe("Agent id to inspect"),
      ack_timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .default(AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS)
        .describe("Treat un-acked dispatches older than this as stale/wedged"),
      heartbeat_max_age_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .default(AGENT_HEALTH_MONITOR_MAX_AGE_MS)
        .describe(
          "Monitor is considered alive if it heartbeated within this window",
        ),
    },
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        const undelivered = replayUndelivered(args.agent_id, inboxOpts);
        const pending = pendingDispatches(
          args.agent_id,
          args.ack_timeout_ms,
          inboxOpts,
        );
        const alive = monitorAlive(
          args.agent_id,
          args.heartbeat_max_age_ms,
          inboxOpts,
        );
        await refreshManagedMetadataBestEffort(args.agent_id);
        const record = context.lifecycleRegistry?.get(args.agent_id) ?? null;
        const health = record
          ? await evaluateServerAgentHealth(record, {
              monitor_alive: alive,
              stale_count: pending.length,
            })
          : undefined;
        return ok({
          agent_id: args.agent_id,
          monitor_alive: alive,
          health,
          undelivered_count: undelivered.length,
          undelivered,
          stale_count: pending.length,
          stale: pending,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  // --- Agent Lifecycle Tools (Phase 5) ---

  if (!skipAgentLifecycle) {
    let registry: AgentRegistry | null = null;
    let lastLifecycleSurfaces: CmuxSurface[] | null = null;
    const readLifecycleSurfaces = async () => {
      const workspaces = await client.listWorkspaces();
      const workspaceList = requireSurfaceEnumerationArray<CmuxWorkspace>(
        workspaces.workspaces,
        "workspaces.workspaces",
      );
      const panesByWorkspace = await Promise.all(
        workspaceList.map(async (ws) => ({
          ref: ws.ref,
          panes: await client.listPanes({ workspace: ws.ref }),
        })),
      );
      const surfaceGroupsByWorkspace = await Promise.all(
        panesByWorkspace.map(async ({ ref, panes }) => {
          const paneList = requireSurfaceEnumerationArray<CmuxPane>(
            panes.panes,
            `panes.panes for ${ref}`,
          );
          const rawGroups = await Promise.all(
            paneList.map((p) =>
              client.listPaneSurfaces({ workspace: ref, pane: p.ref }),
            ),
          );
          return partitionPaneSurfacesByMembership(paneList, rawGroups, {
            workspace_ref: panes.workspace_ref ?? ref,
            window_ref: panes.window_ref,
          });
        }),
      );
      const surfaceGroups = surfaceGroupsByWorkspace.flat();
      return surfaceGroups.flatMap((group) =>
        group.surfaces.map((surface) => ({
          ...surface,
          workspace_ref: group.workspace_ref,
          pane_ref: group.pane_ref,
        })),
      );
    };
    const surfaceProvider = async () => {
      try {
        const surfaces = await readLifecycleSurfaces();
        lastLifecycleSurfaces = surfaces;
        return surfaces;
      } catch (error) {
        if (!isSurfaceEnumerationError(error)) {
          throw error;
        }
        if (lastLifecycleSurfaces) {
          return lastLifecycleSurfaces;
        }
        if (!registry || registry.list().length === 0) {
          return [];
        }
        throw error;
      }
    };
    registry =
      context.lifecycleRegistry ?? new AgentRegistry(stateMgr, surfaceProvider);
    context.lifecycleRegistry = registry;
    const discovery = new AgentDiscovery({
      listSurfaces: surfaceProvider,
      readScreen: (surface, opts) => client.readScreen(surface, opts),
    });
    lifecycleEnsureRegistered = async () => {
      await registry.listMerged(discovery, { force: true });
    };
    lifecycleRefreshManagedMetadata = async (agentId?: string) => {
      await registry.refreshManagedSurfaceMetadata(discovery, {
        agentId,
        force: true,
      });
    };
    const notifyLifecycleEvent = async (
      event: AgentLifecycleEvent,
      agent: AgentRecord,
      healthSummary?: string,
    ): Promise<void> => {
      if (!enableClaudeChannels || !server.server.transport) {
        return;
      }

      // Claude turns meta keys into <channel ...> attributes, so keep keys simple.
      await server.server.notification({
        method: CLAUDE_CHANNEL_NOTIFICATION,
        params: {
          content: formatLifecycleChannelContent(event, agent, healthSummary),
          meta: buildLifecycleChannelMeta(event, agent, healthSummary),
        },
      });
    };
    const engine =
      context.lifecycleSweepEngine ??
      new AgentEngine(
        stateMgr,
        registry,
        {
          log: (message, eventOpts) => client.log(message, eventOpts),
          listWorkspaces: () => client.listWorkspaces(),
          setStatus: (key, value, statusOpts) =>
            client.setStatus(key, value, statusOpts),
          clearStatus: (key, clearOpts) => client.clearStatus(key, clearOpts),
          readScreen: (surface, readOpts) =>
            client.readScreen(surface, readOpts),
          send: (surface, text, sendOpts) =>
            withSurfaceWrite(
              surface,
              () => client.send(surface, text, sendOpts),
              { toolName: "agent_engine", workspace: sendOpts?.workspace },
            ),
          sendKey: (surface, key, keyOpts) =>
            withSurfaceWrite(
              surface,
              () => client.sendKey(surface, key, keyOpts),
              { toolName: "send_key", workspace: keyOpts?.workspace },
            ),
          setProgress: (value, progressOpts) =>
            client.setProgress(value, progressOpts),
          clearProgress: (progressOpts) => client.clearProgress(progressOpts),
          newSplit: (direction, splitOpts) =>
            client.newSplit(direction, splitOpts),
          newSurface: (surfaceOpts) => client.newSurface(surfaceOpts),
          selectWorkspace: (workspace) => client.selectWorkspace(workspace),
          listPanes: (paneOpts) => client.listPanes(paneOpts),
          listPaneSurfaces: (surfaceOpts) =>
            client.listPaneSurfaces(surfaceOpts),
          closeSurface: (surface, closeOpts) =>
            withSurfaceWrite(
              surface,
              async () => {
                const result = await client.closeSurface(surface, closeOpts);
                appendCloseEvent({
                  event: "internal",
                  target: surface,
                  caller: "internal:agent_engine",
                  force: false,
                  reason: "agent_engine teardown",
                  refused: false,
                });
                return result;
              },
              { toolName: "close_surface", workspace: closeOpts?.workspace },
            ),
          notify: (notifyOpts) => client.notify(notifyOpts),
          notifyLifecycleEvent,
        },
        {
          spawnPreflight:
            spawnPreflight ??
            (disableSpawnPreflight ? async () => {} : undefined),
          sessionIdentityResolver: context.sessionIdentityResolver,
          roleSurfaceIdsProvider: collectServerRoleSurfaceIds,
          inboxOpts,
          launchCommandSender: async ({ surface, workspace, command }) => {
            await sendLauncherCommandToSurface({ surface, workspace, command });
          },
          outboxDrain: opts?.outboxDrain,
          monitorRegistryPath: opts?.monitorRegistryPath,
          monitorRegistryNow: opts?.monitorRegistryNow,
          monitorRegistryNotify: opts?.monitorRegistryNotify,
        },
      );
    context.lifecycleSweepEngine = engine;
    lifecycleHealthEngine = engine;

    const resolveSpawnRecord = (
      agentId: string,
      surfaceId: string,
    ): AgentRecord | null => {
      const diskDirect = stateMgr.readState(agentId);
      if (diskDirect) {
        registry.set(agentId, diskDirect);
        return diskDirect;
      }

      const bySurface =
        stateMgr.listStates().find((agent) => agent.surface_id === surfaceId) ??
        registry.list().find((agent) => agent.surface_id === surfaceId) ??
        null;
      if (bySurface) {
        registry.set(agentId, bySurface);
        return bySurface;
      }

      const registryDirect = registry.get(agentId);
      if (registryDirect) {
        registry.set(agentId, registryDirect);
      }
      return registryDirect;
    };

    const relaunchSpawnAgentAfterUpdate = async (opts: {
      agentId: string;
      surface: string;
      workspace?: string;
      model?: string | null;
      mcpEnv?: string;
    }): Promise<void> => {
      const record = resolveSpawnRecord(opts.agentId, opts.surface);
      if (!record) {
        throw new Error(
          `Cannot relaunch ${opts.agentId} after CLI update: agent record not found`,
        );
      }

      const launchCwd = record.launch_cwd?.trim() || undefined;
      const launcherName = record.launcher_name?.trim() || undefined;
      const command = buildLaunchCommand(
        record.cli,
        record.repo,
        record.model ?? opts.model ?? undefined,
        launcherName,
        {
          cwd: launchCwd,
          envPrefix: opts.mcpEnv,
          allowModelOverride: process.env.REPOGOLEM_ALLOW_MODEL === "1",
        },
      );
      await sendLauncherCommandToSurface({
        surface: opts.surface,
        workspace: record.workspace_id ?? opts.workspace,
        command,
      });
    };

    const canonicalizeSpawnResult = <
      T extends {
        agent_id: string;
        surface_id: string;
      },
    >(
      result: T,
    ): AgentRecord | null => {
      const record = resolveSpawnRecord(result.agent_id, result.surface_id);
      if (record) {
        result.agent_id = record.agent_id;
      }
      return record;
    };

    const captureSpawnSessionBestEffort = async <
      T extends {
        agent_id: string;
        surface_id: string;
      },
    >(
      result: T,
    ): Promise<AgentRecord | null> => {
      try {
        await engine.captureBootSessionId(result.agent_id);
      } catch {
        // Keep spawn/boot error handling focused on the original outcome.
      }
      return canonicalizeSpawnResult(result);
    };

    const prepareSpawnWorktree = async (
      repo: string,
      worktree: boolean | object | undefined,
      mcpProfile: McpProfile | undefined,
    ) => {
      if (!worktree) {
        return {
          prepared: undefined,
          mcpProfileLabel: undefined,
          mcpEnv: undefined,
        };
      }

      const profile = mcpProfile ?? "inherit";
      const prepared = await prepareWorktree({
        repo,
        worktree: worktree as Parameters<typeof prepareWorktree>[0]["worktree"],
        exec: opts?.worktreeExec,
        homeGitsDir: opts?.worktreeHomeDir,
      });
      return {
        prepared,
        mcpProfileLabel: typeof profile === "string" ? profile : "custom",
        mcpEnv: formatMcpProfileEnv(profile),
      };
    };

    const deliverAgentInput = async (args: {
      agent_id: string;
      text: string;
      press_enter: boolean;
      allow_busy?: boolean;
      source_event: DeliveryEventType;
    }) => {
      await refreshManagedMetadataBestEffort(args.agent_id);
      let route = engine.resolveAgentRoute(args.agent_id);
      // Guard against stale surface refs before sending. Registry refs drift
      // after a crash/respawn (a pane closes or is recycled), so a cached
      // surface_id can point at a dead surface. Check the resolved ref against
      // the live surface list and, if it is positively gone, resync once and
      // re-resolve; if it still cannot be confirmed live, refuse the relay
      // rather than misdelivering keystrokes. Fail OPEN when the surface list
      // is unavailable (empty) so a transient listing failure never blocks a
      // healthy relay.
      const liveSurfaceRefs = async (): Promise<Set<string> | null> => {
        try {
          const surfaces = await surfaceProvider();
          return surfaces.length > 0
            ? new Set(surfaces.map((surface) => surface.ref))
            : null;
        } catch {
          return null;
        }
      };
      const isPositivelyStale = (
        refs: Set<string> | null,
        surfaceId: string,
      ): boolean => refs !== null && !refs.has(surfaceId);
      if (isPositivelyStale(await liveSurfaceRefs(), route.surface_id)) {
        discovery.invalidate();
        await registry.listMerged(discovery, { force: true });
        // Re-resolve after the resync. The agent may have been evicted (its
        // surface vanished) or still point at a dead surface — either way,
        // refuse with a clear stale-ref error instead of misdelivering.
        let reresolved: ReturnType<typeof engine.resolveAgentRoute> | null;
        try {
          reresolved = engine.resolveAgentRoute(args.agent_id);
        } catch {
          reresolved = null;
        }
        if (
          !reresolved ||
          isPositivelyStale(await liveSurfaceRefs(), reresolved.surface_id)
        ) {
          throw new Error(
            `Agent "${args.agent_id}" no longer maps to a live surface ` +
              `(stale surface ref); its pane likely closed or was recycled. ` +
              `Run resync_agents and retry.`,
          );
        }
        route = reresolved;
      }
      // Identity guard: a live surface ref may have been RECYCLED — a crashed
      // agent's pane reused by a different agent. If the live surface now hosts
      // a known CLI that differs from this agent's recorded CLI, refuse rather
      // than delivering to the new occupant. Fails OPEN when the live CLI is
      // unknown/unreadable so a parse miss never blocks a healthy relay.
      const expectedCli = engine.getAgentState(args.agent_id)?.cli;
      if (expectedCli) {
        const cachedOccupant = (await discovery.scan(false)).find(
          (entry) => entry.surface_id === route.surface_id,
        );
        const isForeign = (occ: typeof cachedOccupant): boolean =>
          Boolean(
            occ &&
            occ.has_agent &&
            !occ.read_error &&
            occ.cli !== "unknown" &&
            occ.cli !== expectedCli,
          );
        if (isForeign(cachedOccupant)) {
          // Confirm against a FRESH scan before refusing. discovery.scan(false)
          // serves a 2s cache that can predate the current occupant; refusing
          // on it alone would false-refuse a healthy relay (adversarial-review
          // finding). Only a mismatch confirmed live is a recycled surface.
          discovery.invalidate();
          const freshOccupant = (await discovery.scan(true)).find(
            (entry) => entry.surface_id === route.surface_id,
          );
          if (isForeign(freshOccupant)) {
            throw new Error(
              `Agent "${args.agent_id}" (${expectedCli}) no longer occupies ` +
                `surface ${route.surface_id} — it now hosts a ${freshOccupant?.cli} ` +
                `agent (surface recycled). Run resync_agents and retry.`,
            );
          }
        }
      }
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

      return withSurfaceWrite(
        route.surface_id,
        async () => {
          await assertDeliveryTargetIsSafe(
            route.surface_id,
            route.workspace_id ?? undefined,
          );
          return deliverInputChunks({
            surface: route.surface_id,
            workspace: route.workspace_id ?? undefined,
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
          });
        },
        {
          toolName: args.source_event,
          workspace: route.workspace_id ?? undefined,
        },
      );
    };
    // Expose the guarded relay to dispatch_to_agent's nudge (registered above,
    // outside this lifecycle block).
    lifecycleAgentInputDeliverer = deliverAgentInput;

    // Reconstitute registry from disk on startup (async, best-effort).
    // Enable startup purge so the first sweep clears stale terminal-state
    // agents from previous cmux sessions.
    if (!context.lifecycleStarted) {
      context.lifecycleStarted = true;
      context.lifecycleStartPromise = registry
        .reconstitute()
        .then(() => engine.enableStartupPurge())
        .catch((e) =>
          console.error("[cmuxlayer] registry reconstitution failed:", e),
        );
      engine.startSweep(resolveSweepTiming());
    }

    // 11. spawn_agent
    server.tool(
      "spawn_agent",
      `Spawn a managed AI agent in a terminal surface and return an agent_id plus health for future routing. For collabs, call list_agents/get_agent_state first and reuse or supersede a viable existing agent instead of spawning a duplicate lane. Unless workspace is explicitly provided, the new agent should land in the caller/current workspace; workers should land in the right worker pane by role. Use send_to and wait_for with the returned agent_id instead of remembering the created surface. If prompt or boot_prompt_path is provided, waits for the agent ready prompt, submits that boot prompt, and returns after submission evidence; submission is not proof of task completion or healthy lifecycle state. Inline prompt is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters by default; use boot_prompt_path for larger boot prompts. boot_prompt_path is checked before spawning and read after readiness. Without a boot prompt, returns immediately and wait_for can be used separately.`,
      {
        repo: z
          .string()
          .describe("Repository name (e.g. 'brainlayer', 'golems')"),
        model: z
          .string()
          .optional()
          .describe("OPTIONAL — leave UNSET so the launcher pins the top-tier model. Only set this if you have a specific reason NOT to use the top model (e.g. a deliberately cheaper 'sonnet' pass, or a non-claude engine variant like 'codex'). Never pass 'opus' for claude — the top Claude model is already the default."),
        cli: z
          .enum(["claude", "codex", "gemini", "kiro", "cursor"])
          .describe("CLI tool to launch"),
        prompt: z
          .string()
          .optional()
          .describe(
            `Inline task prompt to send after the agent is ready. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default; use boot_prompt_path for larger prompts. Mutually exclusive with boot_prompt_path.`,
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
          .describe(
            "Timeout in milliseconds waiting for the agent ready prompt",
          ),
        workspace: z
          .string()
          .optional()
          .describe(
            "Target workspace ref. Omit to use the caller/current workspace; pass only when intentionally spawning in a different workspace.",
          ),
        worktree: worktreeArgSchema
          .optional()
          .describe(
            "When set, create or reuse a git worktree before launch. true uses ~/Gits/<repo>.wt/<generated-name>; object fields can set name, path, branch, base, create, and reuse.",
          ),
        mcp_profile: mcpProfileSchema
          .optional()
          .describe(
            "MCP profile hint for worktree launches. Defaults to inherit. Use sterile/skill_eval or include/exclude lists for narrower evals.",
          ),
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
          .default(false)
          .describe(
            "Deprecated compatibility flag. TASK_DONE updates agent state only; cmuxlayer does not auto-close panes.",
          ),
        max_cost_per_agent: z
          .number()
          .optional()
          .describe("Maximum cost cap in USD for this agent"),
        crash_recover: z
          .boolean()
          .optional()
          .describe(
            "When true, automatically respawn the agent after unexpected PTY death using its captured CLI session ID.",
          ),
        force_new: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, suppress same repo/workspace/role duplicate-lane warnings. Default false so collab leads see reusable existing agents before spawning another lane.",
          ),
        allow_long_inline: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Bypass the inline prompt length cap for a deliberate raw boot-prompt send. Prefer boot_prompt_path for large prompts.",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
          assertBootPromptMode(args.prompt, bootPromptPath);
          assertInlineInputAllowed({
            tool: "spawn_agent",
            arg: "prompt",
            value: args.prompt,
            allowLongInline: args.allow_long_inline,
          });
          if (bootPromptPath) {
            await preflightBootPromptFile(bootPromptPath);
          }
          const bootPromptText = bootPromptPath
            ? await readFile(bootPromptPath, "utf8")
            : null;

          await refreshManagedMetadataBestEffort(args.parent_agent_id);
          const parentWorkspace = args.parent_agent_id
            ? (engine.getAgentState(args.parent_agent_id)?.workspace_id ??
              undefined)
            : undefined;
          const explicitWorkspace = await canonicalWorkspaceRef(args.workspace);
          const spawnWorkspace =
            explicitWorkspace ??
            (args.parent_agent_id ? undefined : await currentCallerWorkspace());
          const comparisonWorkspace = spawnWorkspace ?? parentWorkspace;
          await assertWorkspaceMutationAllowed("spawn_agent", comparisonWorkspace);
          const worktree = await prepareSpawnWorktree(
            args.repo,
            args.worktree,
            args.mcp_profile as McpProfile | undefined,
          );
          const requestedRole = inferAgentRole({
            role: args.role,
            cli: args.cli,
            launcherName: launcherNameForCli(args.repo, args.cli),
          });
          await refreshManagedMetadataBestEffort();
          const existingSameLaneAgents = args.force_new
            ? []
            : registry
                .list()
                .filter(
                  (agent) =>
                    (agent.state === "ready" || agent.state === "idle") &&
                    reposEquivalent(agent.repo, args.repo) &&
                    (agent.workspace_id ?? null) ===
                      (comparisonWorkspace ?? null) &&
                    (agent.role ??
                      inferAgentRole({
                        cli: agent.cli,
                        launcherName:
                          agent.launcher_name ??
                          launcherNameForCli(agent.repo, agent.cli),
                      })) === requestedRole,
                )
                .map((agent) => ({
                  agent_id: agent.agent_id,
                  surface_id: agent.surface_id,
                  workspace_id: agent.workspace_id ?? null,
                  state: agent.state,
                  role:
                    agent.role ??
                    inferAgentRole({
                      cli: agent.cli,
                      launcherName:
                        agent.launcher_name ??
                        launcherNameForCli(agent.repo, agent.cli),
                    }),
                  task_summary: agent.task_summary,
                }));
          const duplicateSpawnWarning =
            existingSameLaneAgents.length > 0
              ? `Existing same-lane agent(s) are idle/ready in ${comparisonWorkspace ?? "unknown workspace"}; reuse or supersede unless a new lane is intentional. Pass force_new:true to suppress this warning.`
              : undefined;
          const spawnPrompt = hasInlinePrompt(args.prompt)
            ? args.prompt
            : (bootPromptText ?? "");
          const result = await engine.spawnAgent({
            repo: args.repo,
            model: args.model,
            cli: args.cli,
            prompt: spawnPrompt,
            boot_prompt_pending:
              hasInlinePrompt(args.prompt) || Boolean(bootPromptPath),
            workspace: spawnWorkspace,
            cwd: worktree.prepared?.path,
            mcp_env: worktree.mcpEnv,
            mcp_profile_label: worktree.mcpProfileLabel,
            worktree_branch: worktree.prepared?.branch,
            parent_agent_id: args.parent_agent_id,
            role: args.role,
            auto_archive_on_done: args.auto_archive_on_done ?? false,
            max_cost_per_agent: args.max_cost_per_agent,
            crash_recover: args.crash_recover,
          });

          let bootPromptDelivery:
            | Awaited<ReturnType<typeof deliverBootPrompt>>
            | undefined;
          try {
            if (hasInlinePrompt(args.prompt) || bootPromptPath) {
              const deliveryWorkspace = spawnDeliveryWorkspace(
                result,
                spawnWorkspace,
              );
              bootPromptDelivery = await deliverBootPrompt({
                surface: result.surface_id,
                workspace: deliveryWorkspace,
                cli: args.cli,
                prompt: args.prompt,
                boot_prompt_path: bootPromptPath,
                timeout_ms: args.boot_prompt_timeout_ms,
                onUpdateShellRelaunch: () =>
                  relaunchSpawnAgentAfterUpdate({
                    agentId: result.agent_id,
                    surface: result.surface_id,
                    workspace: deliveryWorkspace,
                    model: result.model ?? args.model,
                    mcpEnv: result.mcp_env,
                  }),
              });

              await captureSpawnSessionBestEffort(result);
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
            const clearBootPromptPending = () => {
              const record = resolveSpawnRecord(result.agent_id, result.surface_id);
              const agentId = record?.agent_id ?? result.agent_id;
              const updated = stateMgr.updateRecord(agentId, {
                boot_prompt_pending: false,
              });
              registry.set(agentId, updated);
              result.agent_id = updated.agent_id;
              return updated;
            };
            try {
              await captureSpawnSessionBestEffort(result);
              let updated = clearBootPromptPending();
              if (
                !(e instanceof BootPromptTimeoutError) &&
                updated.state !== "done" &&
                updated.state !== "error"
              ) {
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
            if (e instanceof SurfaceGoneError) {
              return err(e, surfaceGonePayload(e, extra));
            }
            if (e instanceof BootPromptTimeoutError) {
              try {
                clearBootPromptPending();
              } catch {
                // Preserve the original timeout response.
              }
              return err(e, { ...extra, last_10_lines: e.last_10_lines });
            }
            if (e instanceof BootPromptUpdateMenuBlockedError) {
              return err(e, {
                ...extra,
                error_code: e.error_code,
                last_10_lines: e.last_10_lines,
                recovery: e.recovery,
              });
            }
            if (e instanceof BootPromptDeliveryError) {
              return err(e, { ...extra, delivered_chars: e.delivered_chars });
            }
            return err(e, extra);
          }

          await refreshManagedMetadataBestEffort(result.agent_id);
          const currentAgent = engine.getAgentState(result.agent_id);
          const role =
            currentAgent?.role ??
            inferAgentRole({
              role: args.role,
              cli: args.cli,
              launcherName: launcherNameForCli(args.repo, args.cli),
            });
          const monitorBoot =
            role === "orchestrator"
              ? ensureMonitorBoot(result.agent_id)
              : undefined;
          const topology = currentAgent ? await collectSurfaceTopology() : null;
          const health = currentAgent
            ? await evaluateServerAgentHealth(
                agentForSpawnHealth(currentAgent, result),
                {
                  ...healthTopologyOverrides(currentAgent, topology),
                },
              )
            : undefined;

          return okFormatted(
            formatOk("spawn_agent", {
              agent_id: result.agent_id,
              repo: args.repo,
              model: result.model ?? args.model,
              requested_model: result.requested_model,
              warning:
                result.warnings && result.warnings.length > 0
                  ? result.warnings.join(" | ")
                  : undefined,
              surface: result.surface_id,
              role,
              health,
              duplicate_spawn_warning: duplicateSpawnWarning,
              monitor_boot: monitorBoot,
              boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
            }),
            {
              ...result,
              worktree: worktree.prepared,
              mcp_profile: worktree.mcpProfileLabel,
              role,
              health,
              duplicate_spawn_warning: duplicateSpawnWarning,
              existing_same_lane_agents: existingSameLaneAgents,
              monitor_boot: monitorBoot,
              boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
              boot_prompt_bytes: bootPromptDelivery?.bytes,
              boot_prompt_submit_verified:
                bootPromptDelivery?.submit_verified ?? null,
            },
          );
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          return err(e);
        }
      },
    );

    server.tool(
      "new_worktree_split",
      "Create or reuse a git worktree and spawn one worker agent into a right-side cmux split. Defaults to inherited MCPs and preserves the existing worker layout policy.",
      {
        repo: z.string().describe("Repository name"),
        model: z.string().describe("Model name"),
        cli: z
          .enum(["claude", "codex", "gemini", "kiro", "cursor"])
          .describe("CLI tool to launch"),
        prompt: z.string().optional().describe("Optional boot prompt"),
        boot_prompt_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .default(BOOT_PROMPT_TIMEOUT_MS),
        workspace: z.string().optional().describe("Target workspace ref"),
        worktree: worktreeArgSchema
          .optional()
          .describe(
            "Worktree options. Defaults to true, creating/reusing ~/Gits/<repo>.wt/<generated-name>.",
          ),
        mcp_profile: mcpProfileSchema
          .optional()
          .describe("MCP profile hint. Defaults to inherit."),
        parent_agent_id: z.string().optional(),
        auto_archive_on_done: z.boolean().optional().default(false),
        crash_recover: z.boolean().optional(),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          assertBootPromptMode(args.prompt, null);
          const explicitWorkspace = await canonicalWorkspaceRef(args.workspace);
          const mutationWorkspace =
            explicitWorkspace ?? (await currentCallerWorkspace());
          await assertWorkspaceMutationAllowed(
            "new_worktree_split",
            mutationWorkspace,
          );
          const priorFocus = await focusTargetBeforeSplit(args.workspace);
          const worktree = await prepareSpawnWorktree(
            args.repo,
            args.worktree ?? true,
            args.mcp_profile as McpProfile | undefined,
          );
          const hasPrompt = hasInlinePrompt(args.prompt);
          const result = await engine.spawnAgent({
            repo: args.repo,
            model: args.model,
            cli: args.cli,
            prompt: args.prompt ?? "",
            boot_prompt_pending: hasPrompt,
            workspace: args.workspace,
            cwd: worktree.prepared?.path,
            mcp_env: worktree.mcpEnv,
            mcp_profile_label: worktree.mcpProfileLabel,
            worktree_branch: worktree.prepared?.branch,
            parent_agent_id: args.parent_agent_id,
            role: "worker",
            auto_archive_on_done: args.auto_archive_on_done ?? false,
            crash_recover: args.crash_recover,
          });

          let bootPromptDelivery:
            | Awaited<ReturnType<typeof deliverBootPrompt>>
            | undefined;
          if (hasPrompt) {
            const deliveryWorkspace = spawnDeliveryWorkspace(
              result,
              args.workspace,
            );
            bootPromptDelivery = await deliverBootPrompt({
              surface: result.surface_id,
              workspace: deliveryWorkspace,
              cli: args.cli,
              prompt: args.prompt,
              timeout_ms: args.boot_prompt_timeout_ms,
              onUpdateShellRelaunch: () =>
                relaunchSpawnAgentAfterUpdate({
                  agentId: result.agent_id,
                  surface: result.surface_id,
                  workspace: deliveryWorkspace,
                  model: result.model ?? args.model,
                  mcpEnv: result.mcp_env,
                }),
            });
            canonicalizeSpawnResult(result);
            const updated = stateMgr.updateRecord(result.agent_id, {
              task_summary: bootPromptDelivery.prompt_text ?? args.prompt ?? "",
              boot_prompt_pending: false,
            });
            registry.set(result.agent_id, updated);
          }

          await restoreFocusAfterRender(
            priorFocus,
            result.surface_id,
            spawnDeliveryWorkspace(result, args.workspace),
          );
          await refreshManagedMetadataBestEffort(result.agent_id);
          const currentAgent = engine.getAgentState(result.agent_id);
          const topology = currentAgent ? await collectSurfaceTopology() : null;
          const health = currentAgent
            ? await evaluateServerAgentHealth(
                agentForSpawnHealth(currentAgent, result),
                {
                  ...healthTopologyOverrides(currentAgent, topology),
                },
              )
            : undefined;

          return okFormatted(
            formatOk("new_worktree_split", {
              agent_id: result.agent_id,
              surface: result.surface_id,
              worktree: worktree.prepared?.path ?? "",
              mcp_profile: worktree.mcpProfileLabel ?? "inherit",
              health,
            }),
            {
              ...result,
              role: "worker",
              health,
              worktree: worktree.prepared,
              mcp_profile: worktree.mcpProfileLabel ?? "inherit",
              boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
              boot_prompt_bytes: bootPromptDelivery?.bytes,
              boot_prompt_submit_verified:
                bootPromptDelivery?.submit_verified ?? null,
            },
          );
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              submit_verified: false,
              retry_count: e.retry_count,
            });
          }
          return err(e);
        }
      },
    );

    server.tool(
      "spawn_in_workspace",
      "Create a workspace and spawn a set of agents into it as a clean 2-pane grid (commanders LEFT, workers RIGHT). Handles workspace creation, selection, and role-based pane placement atomically. Use this instead of repeated spawn_agent calls when standing up a multi-agent team.",
      {
        workspace_title: z
          .string()
          .describe("Title for the new workspace (e.g. 'red-team')"),
        agents: z
          .array(
            z.object({
              repo: z.string(),
              model: z.string(),
              cli: z.enum(["claude", "codex", "cursor", "gemini", "kiro"]),
              role: z.enum(["orchestrator", "worker", "ic"]).optional(),
              prompt: z.string().optional(),
            }),
          )
          .min(1)
          .describe("Agents to spawn, in order"),
        reuse_workspace: z
          .string()
          .optional()
          .describe(
            "Ref of an existing workspace to use instead of creating a new one",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          await assertWorkspaceMutationAllowed(
            "spawn_in_workspace",
            args.reuse_workspace ?? (await currentCallerWorkspace()),
          );
          const workspaceResult = args.reuse_workspace
            ? { workspace: args.reuse_workspace, title: args.workspace_title }
            : await client.createWorkspace(args.workspace_title);
          const workspace = workspaceResult.workspace;
          if (!workspace) {
            throw new Error("create_workspace returned an empty workspace ref");
          }

          const priorFocus = await focusTargetBeforeSplit(workspace);
          // Always focus the target so agents spawn into it; harmless when the
          // workspace was just created (and is already selected) or already
          // focused. priorFocus drives the focus-back only when a jump happened.
          await client.selectWorkspace(workspace);

          const spawnedAgents: Array<{
            agent_id: string;
            surface_id: string;
            repo: string;
            cli: CliType;
            role: AgentRole;
            health?: ReturnType<typeof evaluateAgentHealth>;
            monitor_boot?: MonitorBootResult;
            boot_prompt_delivered?: boolean;
            boot_prompt_submit_verified?: boolean | null;
          }> = [];

          for (const agent of args.agents) {
            const hasPrompt = hasInlinePrompt(agent.prompt);
            const result = await engine.spawnAgent({
              repo: agent.repo,
              model: agent.model,
              cli: agent.cli,
              prompt: agent.prompt ?? "",
              boot_prompt_pending: hasPrompt,
              workspace,
              role: agent.role,
              auto_archive_on_done: false,
            });
            let bootPromptDelivery:
              | Awaited<ReturnType<typeof deliverBootPrompt>>
              | undefined;

            if (hasPrompt) {
              const deliveryWorkspace = spawnDeliveryWorkspace(
                result,
                workspace,
              );
              bootPromptDelivery = await deliverBootPrompt({
                surface: result.surface_id,
                workspace: deliveryWorkspace,
                cli: agent.cli,
                prompt: agent.prompt,
                timeout_ms: BOOT_PROMPT_TIMEOUT_MS,
                onUpdateShellRelaunch: () =>
                  relaunchSpawnAgentAfterUpdate({
                    agentId: result.agent_id,
                    surface: result.surface_id,
                    workspace: deliveryWorkspace,
                    model: result.model ?? agent.model,
                    mcpEnv: result.mcp_env,
                  }),
              });

              canonicalizeSpawnResult(result);
              const updated = stateMgr.updateRecord(result.agent_id, {
                task_summary:
                  bootPromptDelivery.prompt_text ?? agent.prompt ?? "",
                boot_prompt_pending: false,
              });
              registry.set(result.agent_id, updated);

              const current = engine.getAgentState(result.agent_id);
              if (current?.state === "booting") {
                const ready = stateMgr.transition(result.agent_id, "ready");
                registry.set(result.agent_id, ready);
                result.state = "ready";
              } else if (current?.state === "ready") {
                result.state = "ready";
              }
            }

            await refreshManagedMetadataBestEffort(result.agent_id);
            const currentAgent = engine.getAgentState(result.agent_id);
            const role =
              currentAgent?.role ??
              inferAgentRole({
                role: agent.role,
                cli: agent.cli,
                launcherName: launcherNameForCli(agent.repo, agent.cli),
              });
            const monitorBoot =
              role === "orchestrator"
                ? ensureMonitorBoot(result.agent_id)
                : undefined;
            const topology = currentAgent ? await collectSurfaceTopology() : null;
            const health = currentAgent
              ? await evaluateServerAgentHealth(
                  agentForSpawnHealth(currentAgent, result),
                  {
                    ...healthTopologyOverrides(currentAgent, topology),
                  },
                )
              : undefined;

            spawnedAgents.push({
              agent_id: result.agent_id,
              surface_id: result.surface_id,
              repo: agent.repo,
              cli: agent.cli,
              role,
              health,
              monitor_boot: monitorBoot,
              boot_prompt_delivered: hasPrompt
                ? isBootPromptDelivered(bootPromptDelivery)
                : undefined,
              boot_prompt_submit_verified: hasPrompt
                ? (bootPromptDelivery?.submit_verified ?? null)
                : undefined,
            });
          }

          const lastSurface =
            spawnedAgents[spawnedAgents.length - 1]?.surface_id;
          await restoreFocusAfterRender(priorFocus, lastSurface, workspace);

          return okFormatted(
            formatOk("spawn_in_workspace", {
              workspace,
              agents: spawnedAgents.length,
            }),
            {
              workspace,
              title: workspaceResult.title,
              agents: spawnedAgents,
            },
          );
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              submit_verified: false,
              retry_count: e.retry_count,
            });
          }
          return err(e);
        }
      },
    );

    // 12. wait_for
    server.tool(
      "wait_for",
      "Block until an agent reaches a target registry state and return health. Defaults to waiting for completion (`done`) so GUI clients can wait on an agent without knowing lifecycle choreography. When the agent has a file-backed goal contract, returned health includes artifact-backed harvestability by reading the referenced report and DONE marker.",
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
          await refreshManagedMetadataBestEffort(result.agent?.agent_id);
          const resultAgent = result.agent
            ? engine.getAgentState(result.agent.agent_id)
            : null;
          const topology = resultAgent ? await collectSurfaceTopology() : null;
          const health = resultAgent
            ? await evaluateServerAgentHealth(resultAgent, {
                ...healthTopologyOverrides(resultAgent, topology),
              })
            : undefined;
          return okFormatted(
            formatOk("wait_for", {
              agent_id: args.agent_id,
              state: result.state,
              health,
            }),
            {
              agent_id: args.agent_id,
              ...result,
              health,
              agent:
                result.agent && health
                  ? { ...result.agent, health }
                  : result.agent,
            },
          );
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              submit_verified: false,
              retry_count: e.retry_count,
            });
          }
          return err(e);
        }
      },
    );

    // 13. wait_for_all
    server.tool(
      "wait_for_all",
      "Block until ALL agents reach a target registry state OR any agent errors, returning per-agent health with partial results. When agents have file-backed goal contracts, returned health includes artifact-backed harvestability by reading referenced reports and DONE markers.",
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
          await Promise.all(
            results
              .map((result) => result.agent?.agent_id)
              .filter((agentId): agentId is string => Boolean(agentId))
              .map((agentId) => refreshManagedMetadataBestEffort(agentId)),
          );
          const topology = await collectSurfaceTopology();
          const enrichedResults = await Promise.all(
            results.map(async (result) => {
              const resultAgent = result.agent
                ? engine.getAgentState(result.agent.agent_id)
                : null;
              const health = resultAgent
                ? await evaluateServerAgentHealth(resultAgent, {
                    ...healthTopologyOverrides(resultAgent, topology),
                  })
                : undefined;
              return {
                ...result,
                health,
                agent:
                  result.agent && health
                    ? { ...result.agent, health }
                    : result.agent,
              };
            }),
          );
          return okFormatted(
            formatOk("wait_for_all", {
              count: results.length,
              target: args.target_state,
            }),
            { results: enrichedResults },
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    // 14. get_agent_state
    server.tool(
      "get_agent_state",
      "Get the full registry state of an agent, including cli_session_id/resume data, health, and artifact-backed harvestability. Health may flag missing sessions, dead inbox monitors, topology drift, registry/screen disagreement, or unverified worker closure artifacts.",
      {
        agent_id: z.string().describe("Agent ID"),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          await refreshManagedMetadataBestEffort(args.agent_id);
          const state = engine.getAgentState(args.agent_id);
          if (!state)
            return err(new Error(`Agent not found: ${args.agent_id}`));
          const topology = await collectSurfaceTopology();
          const harvestability = engine.assessHarvestability(state);
          const health = await evaluateServerAgentHealth(state, {
            ...healthTopologyOverrides(state, topology),
            harvestability,
          });
          const formatted =
            formatAgentState(state) +
            `\nharvestability: ${
              harvestability.closeable ? "closeable" : "not closeable"
            }` +
            `\nhealth: ${health.status}${
              health.issues.length > 0
                ? ` (${health.issues.join("; ")})`
                : ""
            }`;
          const payload = {
            ...toAgentStatePayload(state),
            harvestability,
            health,
          };
          return okFormatted(
            formatted,
            payload as unknown as Record<string, unknown>,
          );
        } catch (e) {
          return err(e);
        }
      },
    );

    // 15. list_agents
    server.tool(
      "list_agents",
      "List public agent handles with optional filters by state, repo, or model, including health. In collabs, use this before spawn_agent to find an existing lane agent to reuse or supersede. Use returned agent_id values with send_to and wait_for; use get_agent_state when you need internal route/session details.",
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
        const filter = {
          repo: args.repo,
          model: args.model,
        };
        const requestedState = args.state;
        const buildListAgentsResponse = async (records: AgentRecord[]) => {
          const topology = await collectSurfaceTopology();
          const enrichedAgents = await Promise.all(
            records.map(async (agent) => {
              const health = await evaluateServerAgentHealth(agent, {
                ...healthTopologyOverrides(agent, topology),
              });
              return {
                ...toPublicAgent(agent),
                state: health.reconciled_state ?? agent.state,
                health,
              };
            }),
          );
          const agents = requestedState
            ? enrichedAgents.filter((agent) => agent.state === requestedState)
            : enrichedAgents;
          const data = {
            agents: agents as unknown as Record<string, unknown>[],
            count: agents.length,
          };
          const formatted = formatListAgents(agents, agents.length);
          return okFormatted(formatted, data);
        };

        try {
          const merged = await registry.listMerged(discovery, {
            filter,
          });
          return await buildListAgentsResponse(merged);
        } catch (e) {
          if (isSurfaceEnumerationError(e)) {
            try {
              return await buildListAgentsResponse(registry.list(filter));
            } catch (fallbackError) {
              return err(fallbackError);
            }
          }
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
          await registry.listMerged(discovery, { force: true });
          await registry.evictSurfaceless();
          engine.evictDeadProcessAgents();
          discovery.invalidate();
          const after = await registry.listMerged(discovery, { force: true });
          const discovered = await discovery.scan();
          const afterIds = new Set(after.map((agent) => agent.agent_id));
          const orphanedSurfaces = discovered.filter(
            (surface) => !surface.has_agent && !surface.read_error,
          );
          const orphanedHealth = orphanedSurfaces.map(buildOrphanSurfaceHealth);
          const diff = {
            added: [...afterIds].filter((id) => !beforeIds.has(id)),
            evicted: [...beforeIds].filter((id) => !afterIds.has(id)),
            mismatches: after
              .filter((agent) => agent.parsed_cli_mismatch)
              .map((agent) => agent.agent_id),
            orphaned: orphanedSurfaces.map((surface) => surface.surface_id),
            orphaned_health: orphanedHealth,
            health_failures: orphanedHealth.filter(
              (health) => health.status === "unhealthy",
            ),
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
          const current = engine.getAgentState(args.agent_id);
          if (current) {
            await assertSurfaceMutationAllowed(
              "stop_agent",
              current.surface_id,
              current.workspace_id ?? undefined,
            );
          }
          await engine.stopAgent(args.agent_id, args.force);
          const state = engine.getAgentState(args.agent_id);
          appendCloseEvent({
            event: "stop_agent",
            target: args.agent_id,
            caller: resolveCloseCaller("stop_agent"),
            force: args.force ?? false,
            reason: `state after stop: ${state?.state ?? "done"}`,
            refused: false,
          });
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
      `Preferred path for sending text to a tracked agent by agent_id. Resolves the current backing surface internally so clients do not need pane or surface references, and should be used instead of send_input whenever an agent_id is available. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters by default (CMUXLAYER_MAX_INLINE_CHARS, positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}); write large payloads to a file and send one line: "Read and follow <path>". For collab supersession, send a short \`/goal Read and follow <absolute goal file>\` reference rather than a long lossy paste. For launcher boot prompts, put the full prompt in a file and pass boot_prompt_path through spawn_agent/send_command instead of routing raw long text through the agent composer. Pass allow_long_inline:true only for deliberate raw sends. Returns submission evidence plus registry state, parsed screen status, state_conflict, and health; submit_verified means the input was submitted/cleared, not that the agent accepted, started, or completed the task.`,
      {
        ...SendToArgsSchema.shape,
        text: SendToArgsSchema.shape.text.describe(
          `Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default; for large payloads write a file and send "Read and follow <path>" instead.`,
        ),
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "If true, bypass the interactive-state gate and deliver raw keystrokes regardless of agent state (matches send_input behavior). Use to interject while an agent is working — e.g., to cancel, steer, or stack an instruction.",
        ),
        allow_long_inline: SendToArgsSchema.shape.allow_long_inline.describe(
          "Bypass the inline length cap for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
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
          assertInlineInputAllowed({
            tool: "send_to",
            arg: "text",
            value: args.text,
            allowLongInline: args.allow_long_inline,
          });
          const delivery = await deliverAgentInput({
            agent_id: args.agent_id,
            text: args.text,
            press_enter: args.press_enter,
            allow_busy: args.allow_busy,
            source_event: "send_to",
          });
          const evidence = await collectDeliveryEvidence(args.agent_id);
          const data = {
            agent_id: args.agent_id,
            retry_count: delivery.retry_count,
            submit_verified: delivery.submit_verified,
            ...evidence,
          };
          return okFormatted(formatOk("send_to", data), data);
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              submit_verified: false,
              retry_count: e.retry_count,
            });
          }
          return err(e);
        }
      },
    );

    // 18. send_to_agent
    server.tool(
      "send_to_agent",
      `Deprecated for client integrations: use send_to instead. Internal/advanced path for sending text input to an agent in ready or idle state. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters by default (CMUXLAYER_MAX_INLINE_CHARS, positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}); write large payloads to a file and send one line: "Read and follow <path>". For launcher boot prompts, put the full prompt in a file and pass boot_prompt_path through spawn_agent/send_command instead of routing raw long text through the agent composer. Pass allow_long_inline:true only for deliberate raw sends. Returns the same post-delivery registry/screen health evidence as send_to.`,
      {
        ...SendToArgsSchema.shape,
        text: SendToArgsSchema.shape.text.describe(
          `Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default; for large payloads write a file and send "Read and follow <path>" instead.`,
        ),
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "If true, bypass the interactive-state gate and deliver raw keystrokes regardless of agent state (matches send_input behavior).",
        ),
        allow_long_inline: SendToArgsSchema.shape.allow_long_inline.describe(
          "Bypass the inline length cap for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
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
          assertInlineInputAllowed({
            tool: "send_to_agent",
            arg: "text",
            value: args.text,
            allowLongInline: args.allow_long_inline,
          });
          const delivery = await deliverAgentInput({
            agent_id: args.agent_id,
            text: args.text,
            press_enter: args.press_enter,
            allow_busy: args.allow_busy,
            source_event: "send_to_agent",
          });
          const evidence = await collectDeliveryEvidence(args.agent_id);
          const data = {
            agent_id: args.agent_id,
            retry_count: delivery.retry_count,
            submit_verified: delivery.submit_verified,
            ...evidence,
          };
          return okFormatted(formatOk("send_to_agent", data), data);
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              submit_verified: false,
              retry_count: e.retry_count,
            });
          }
          return err(e);
        }
      },
    );

    server.tool(
      "supersede_agent_goal",
      "Replace an existing managed agent's active mission with a file-backed /goal contract. Updates registry task_summary/goal_file, sends `/goal Read and execute this goal file until complete: <path>` through the guarded agent relay, and returns delivery evidence plus health. Use this to reuse an existing pane instead of spawning a duplicate lane.",
      {
        agent_id: z.string().describe("Managed agent_id to supersede"),
        goal_file: z
          .string()
          .describe("Absolute path to the goal file the agent must execute"),
        summary: z
          .string()
          .optional()
          .describe(
            "Optional task_summary to store in the registry. Defaults to the goal_file path.",
          ),
        allow_busy: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "If true, supersede even while the agent is working. Defaults true because supersession intentionally replaces the active mission.",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          await refreshManagedMetadataBestEffort(args.agent_id);
          const current = engine.getAgentState(args.agent_id);
          if (!current) {
            return err(new Error(`Agent not found: ${args.agent_id}`));
          }
          await preflightBootPromptFile(args.goal_file);
          const taskSummary = args.summary?.trim() || args.goal_file;
          const delivery = await deliverAgentInput({
            agent_id: args.agent_id,
            text: `/goal Read and execute this goal file until complete: ${args.goal_file}`,
            press_enter: true,
            allow_busy: args.allow_busy ?? true,
            source_event: "supersede_agent_goal",
          });
          const canonicalAgentId = current.agent_id;
          const supersedePatch = {
            task_summary: taskSummary,
            goal_file: args.goal_file,
            task_done_candidate_at: null,
            task_done_detected_at: null,
            boot_prompt_pending: false,
            error: null,
          };
          let updated =
            current.state === "working"
              ? stateMgr.updateRecord(canonicalAgentId, supersedePatch)
              : stateMgr.resetState(
                  canonicalAgentId,
                  "working",
                  supersedePatch,
                  "supersede_agent_goal",
                );
          registry.set(canonicalAgentId, updated);
          const evidence = await collectDeliveryEvidence(canonicalAgentId);
          const data = {
            agent_id: canonicalAgentId,
            goal_file: args.goal_file,
            task_summary: taskSummary,
            retry_count: delivery.retry_count,
            submit_verified: delivery.submit_verified,
            ...evidence,
          };
          return okFormatted(formatOk("supersede_agent_goal", data), data);
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
        scrollback: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Scan full scrollback instead of only the current terminal tail. Default: false.",
          ),
        workspace: z.string().optional().describe("Target workspace ref"),
      },
      ANNOTATIONS.readOnly,
      async (args) => {
        try {
          const opts: Record<string, unknown> = {
            lines: args.lines,
          };
          if (args.scrollback) opts.scrollback = true;
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
          await refreshManagedMetadataBestEffort(args.agent);
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
              await withSurfaceWrite(
                agent.surface_id,
                () =>
                  client.sendKey(agent.surface_id, "c-c", {
                    workspace: agent.workspace_id ?? undefined,
                  }),
                {
                  toolName: "interact",
                  workspace: agent.workspace_id ?? undefined,
                },
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
              const current = engine.getAgentState(agentId);
              if (current) {
                await assertSurfaceMutationAllowed(
                  "kill",
                  current.surface_id,
                  current.workspace_id ?? undefined,
                );
              }
              await engine.stopAgent(agentId, args.force);
              killed.push(agentId);
              appendCloseEvent({
                event: "kill",
                target: agentId,
                caller: resolveCloseCaller("kill"),
                force: args.force ?? false,
                reason: current ? `state before kill: ${current.state}` : null,
                refused: false,
              });
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
            ? (() => {
                const childIds = new Set(
                  registry
                    .getChildren(args.parent_agent_id)
                    .map((agent) => agent.agent_id),
                );
                return merged.filter((agent) => childIds.has(agent.agent_id));
              })()
            : merged.filter((agent) => agent.parent_agent_id === null);

          const SCREEN_TIMEOUT = 3000;
          const enriched = await Promise.all(
            agents.map(async (agent) => {
              let screenData: ParsedScreenResult | null = null;
              let screenFailure:
                | {
                    screen_unavailable: true;
                    error_code: "screen_unavailable";
                    screen_error: string;
                  }
                | null = null;
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
                screenData = applyHarnessState(
                  enrichParsedScreen(
                    parseScreen(screen.text),
                    screen.text,
                    pickLatestSurfaceModel(stateMgr, agent.surface_id),
                  ),
                  resolveHarnessStateForSurface(stateMgr, agent.surface_id),
                );
              } catch (error) {
                // Surface may be closed, unavailable, or timed out
                screenFailure = {
                  screen_unavailable: true,
                  error_code: "screen_unavailable",
                  screen_error: screenUnavailableMessage(error),
                };
              }

              const resumeCommand = resumeCommandForAgent(agent);
              return {
                agent_id: agent.agent_id,
                repo: agent.repo,
                // Reconcile a stale registry "error" against the live screen: a healthy idle
                // agent must not be reported as errored just because the registry lagged.
                state: reconcileAgentLiveState(agent.state, screenData),
                model: agent.model,
                cli: agent.cli,
                session_id: agent.cli_session_id,
                resumable: !!agent.cli_session_id,
                ...(resumeCommand ? { resume_command: resumeCommand } : {}),
                surface_id: agent.surface_id,
                token_count: screenData?.token_count ?? null,
                context_pct: screenData?.context_pct ?? null,
                cost: screenData?.cost ?? null,
                task_summary: agent.task_summary,
                spawn_depth: agent.spawn_depth,
                created_at: agent.created_at,
                quality: agent.quality,
                ...(screenFailure ?? {}),
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
