/**
 * cmuxlayer MCP server — registers core tools + agent lifecycle tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, mkdtempSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CmuxClient, type ExecFn } from "./cmux-client.js";
import {
  CMUXLAYER_DEFAULT_PALETTE_ENV,
  createDefaultToolPalette,
} from "./palette.js";
import type { CmuxSocketClient } from "./cmux-socket-client.js";
import {
  createFileSystemSeatManifestWriter,
  type SeatManifestWriter,
} from "./seat-manifest.js";
import { assertMutationAllowed, parseReservedModeKey } from "./mode-policy.js";
import { extractPrefix, replaceTaskSuffix } from "./naming.js";
import { createStaleBuildWarner, RUNNING_VERSION } from "./version.js";
import {
  buildSpawnToolReturn,
  shapeSpawnResponse,
} from "./spawn-response.js";
import { StateManager } from "./state-manager.js";
import { createDefaultCloseForensicsRunner } from "./close-forensics.js";
import {
  currentTransportRetryCount,
  withTransportRetryTracking,
} from "./transport-retry-context.js";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
} from "./agent-registry.js";
import {
  deriveCmuxObserverEpoch,
  deriveCmuxObserverOwnerId,
} from "./cmux-observer-identity.js";
import {
  AgentEngine,
  buildLaunchCommand,
  resolveSweepTiming,
  type AgentLifecycleEvent,
  type SessionIdentityResolver,
  type SpawnAgentParams,
} from "./agent-engine.js";
import {
  deregisterMonitor,
  queryMonitorRegistryForGates,
  readMonitorRegistry,
  registerMonitor,
  signalMonitor,
  type MonitorDeadmanNotify,
  type MonitorRegistryOptions,
  type RegisterMonitorInput,
} from "./monitor-registry.js";
import {
  AgentDiscovery,
  SurfaceBindingChangedDuringDiscoveryError,
  type DiscoveredAgent,
} from "./agent-discovery.js";
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
  isPickerOrMenuScreen,
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
  inferRecordRoleOrNull,
  isAgentRoleInferenceError,
  launcherNameForCli,
} from "./layout-policy.js";
import type {
  CmuxNewSplitResult,
  CmuxNewSurfaceResult,
  CmuxPane,
  CmuxReadScreenResult,
  CmuxSurface,
  CmuxStatusEntry,
  CmuxTerminalMetadata,
  CmuxWorkspace,
  ControlMode,
  ParsedScreenResult,
} from "./types.js";
import { normalizeKeyName } from "./key-names.js";
import { currentCallerContext } from "./caller-context.js";
import {
  CLI_INPUT_PROMPT_PREFIXES,
  matchReadyPattern,
  screenHasActiveAgentMarker,
  screenHasReadyAgentIdentity,
} from "./pattern-registry.js";
import { reposEquivalent, resolveWorkspaceRefForRepo } from "./repo-workspace.js";
import { partitionPaneSurfacesByMembership } from "./pane-surfaces.js";
import {
  buildSurfaceBindingObservation,
  isPaneSurfaceEnumerationComplete,
  resolveObservedAgentSurfaceRef,
  type SurfaceBindingObservation,
} from "./surface-binding-observation.js";
import {
  collectSelfHealHealth,
  collectControlHealth,
  formatControlHealth,
  type ControlHealth,
} from "./control-health.js";
import {
  captureSurfaceObserverEpoch as captureObserverEpoch,
  collectSurfaceTopology as collectCmuxSurfaceTopology,
  EMPTY_SURFACE_TOPOLOGY,
  enrichSurfaceIdsFromPanes,
  healthTopologyOverrides,
  isSurfaceObserverEpochCurrent,
  resolveAgentSurfaceBinding,
  type SurfaceObserverEpoch,
  type SurfaceObserverIdProvider,
  type SurfaceTopologySnapshot,
  type SurfaceTopology,
} from "./surface-topology.js";
import {
  formatMcpProfileEnv,
  prepareWorktree,
  type McpProfile,
  type WorktreeExec,
} from "./worktree.js";
import {
  loadSeatRegistryFromConfig,
  type SeatRegistry,
} from "./seat-identity.js";
import {
  isBrokenPipeError,
  SurfaceWriteLivenessTracker,
} from "./surface-write-liveness.js";
import type { FleetSidebarPublisherLike } from "./fleet-sidebar.js";

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

const MonitorMechanismSchema = z.enum(["event", "offset-poll"]);
const MonitorDedupeSchema = z.enum(["offset", "seen-set", "header-keyed"]);
const MonitorRegistryGateSchema = z.enum(["gate-9", "gate-10"]);

const RegisterMonitorArgsSchema = {
  monitor_id: z.string().describe("Stable unique monitor id"),
  owner_seat: z.string().describe("Seat/agent responsible for the monitor"),
  watch_targets: z
    .array(z.string())
    .min(1)
    .describe("Files, channels, or resources this monitor watches"),
  mechanism: MonitorMechanismSchema.describe("Monitor mechanism"),
  watermark_key: z
    .string()
    .optional()
    .describe("Required for offset-poll monitors"),
  dedupe: MonitorDedupeSchema.optional().describe("Dedupe strategy"),
  pattern: z.string().optional().describe("Optional delivery/watch pattern"),
  deadman_timeout_s: z
    .number()
    .positive()
    .describe("Required deadman timeout in seconds"),
  addressee: z.string().optional().describe("Owner to notify on deadman fire"),
  rearm_command: z
    .string()
    .optional()
    .describe("Exact command the owner must use to recreate the watcher"),
} as const;

const MonitorIdArgsSchema = {
  monitor_id: z.string().describe("Monitor id"),
} as const;

const QueryMonitorRegistryArgsSchema = {
  gate: MonitorRegistryGateSchema.optional().describe(
    "Optional gate query mode",
  ),
  owner_seat: z.string().optional().describe("Filter by owner seat"),
  monitor_id: z.string().optional().describe("Filter or claimed monitor id"),
  monitor_ids: z
    .array(z.string())
    .optional()
    .describe("Filter or claimed monitor ids"),
  claimed_monitor_ids: z
    .array(z.string())
    .optional()
    .describe("Additional monitor ids claimed by a gate caller"),
  include_dead: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include intentionally deregistered dead monitors"),
} as const;

// Re-export for test access
export { sanitizeTerminalInput } from "./sanitize.js";

/**
 * Process-wide stale-build warner. After a brew release, an already-running
 * per-agent MCP stdio child keeps serving spawns from its OLD dist until the
 * agent `/mcp reconnect`s — silently mis-placing workers with pre-release logic
 * (the #247 recurrence root cause). The warner (see version.ts) caches the
 * warning FOREVER once stale, but RE-CHECKS (throttled) while not-yet-stale, so
 * a fresh child that later goes stale via `brew upgrade` is still flagged
 * rather than silenced by a permanently-cached non-stale verdict.
 */
const defaultStaleBuildWarner = createStaleBuildWarner();

const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";
const CLAUDE_CHANNEL_NOTIFICATION = "notifications/claude/channel";
const CLAUDE_CHANNEL_INSTRUCTIONS =
  "When loaded with Claude Code --channels, this server may emit notifications/claude/channel for cmuxlayer agent lifecycle events. These arrive as <channel> status updates and are one-way only.";
export const SEND_INPUT_CHUNK_THRESHOLD = 500;
const BOOT_PROMPT_PATH_WARNING_CHARS = 500;
export const DEFAULT_SEND_INPUT_MAX_INLINE_CHARS = 1_800;
export const SEND_INPUT_PASTE_BATCH_MAX_BYTES = 16_000;
const SEND_INPUT_CHUNK_DELAY_MS = 5;
const SEND_INPUT_RETRY_ATTEMPTS = 3;
const SEND_INPUT_RETRY_DELAY_MS = 25;
const SEND_INPUT_ENTER_DELAY_MS = 50;
const SEND_INPUT_RECOVERY_ENTER_DELAY_MS = 150;
const DEFAULT_SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS = 5000;
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
const SEND_INPUT_SAFE_RETRY_OBSERVE_MS = 2500;
const SEND_INPUT_POST_RETRY_VERIFY_GRACE_MS = 300;
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
  mode: z
    .enum(["agent", "surface", "command", "key"])
    .optional()
    .default("agent"),
  target: z.string().optional(),
  agent_id: z.string().optional(),
  surface: z.string().optional(),
  text: z.string().optional(),
  command: z.string().optional(),
  key: z.string().optional(),
  workspace: z.string().optional(),
  chunk_size: z.number().int().min(1).optional().default(200),
  background: z.boolean().optional().default(false),
  rename_to_task: z.string().optional(),
  boot_prompt_path: z.string().nullable().optional(),
  boot_prompt_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .default(BOOT_PROMPT_TIMEOUT_MS),
  press_enter: z.boolean().optional().default(true),
  allow_busy: z.boolean().optional().default(false),
  allow_long_inline: z.boolean().optional().default(false),
});

export const THIN_CORE_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_to",
  "wait_for",
  "read_screen",
  "my_agents",
  "list_agents",
  "broadcast",
  "close_surface",
  "dispatch_to_agent",
  "list_surfaces",
  "control_health",
  "stop_agent",
]);

// DRIFT: retire next release. The signed-off prose says 9 legacy names, while
// its exhaustive mapping names these 8; do not invent an unnamed alias.
export const THIN_CORE_LEGACY_REPLACEMENTS: Readonly<Record<string, string>> = {
  send_to_agent: "send_to(mode=agent)",
  send_input: "send_to(mode=surface)",
  send_command: "send_to(mode=command)",
  send_key: "send_to(mode=key)",
  new_worktree_split: "spawn_agent(worktree=true, role=worker)",
  spawn_in_workspace: "spawn_agent(workspace=...)",
  new_split: "spawn_agent(role=...)",
  wait_for_all: "wait_for(ids=[...])",
};

const BroadcastRoleSchema = z.enum(["leads", "workers", "all"]);
const BroadcastArgsSchema = z.object({
  text: z.string(),
  role: BroadcastRoleSchema.optional().default("leads"),
  exclude: z.array(z.string()).optional().default([]),
  workspace: z.string().optional(),
  press_enter: z.boolean().optional().default(true),
});
type BroadcastRole = z.infer<typeof BroadcastRoleSchema>;
type BroadcastReceipt = {
  agent_id: string;
  seat: string;
  delivered: boolean;
  submit_verified: boolean | null;
  error?: string;
  skipped?: string;
};

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
  readonly delivered = false;
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
        : "target surface has an open picker/menu; refused to type (would be consumed as menu keystrokes)",
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
    "Codex kept showing the interactive update menu after cmuxlayer accepted the default 'Update now' option. Rerun the spawn; the bounded updater guard prevents an infinite loop.";

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
  const payload = {
    ok: true,
    retry_count: currentTransportRetryCount(),
    ...data,
  };
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
  const payload = {
    ok: true,
    retry_count: currentTransportRetryCount(),
    ...data,
  };
  return {
    content: [{ type: "text", text: formattedText }],
    structuredContent: payload,
  };
}

function withDeprecationWarning(
  result: ToolReturn,
  legacyName: string,
  replacement: string,
): ToolReturn {
  const warning = `${legacyName} is deprecated for one release; use ${replacement}`;
  console.warn(`[cmuxlayer] ${warning}`);
  return {
    ...result,
    structuredContent: {
      ...(result.structuredContent ?? {}),
      deprecation_warning: warning,
    },
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
  const deliverySafetyExtra =
    error instanceof DeliverySafetyGateError
      ? {
          delivered: error.delivered,
          error_code: error.error_code,
          submit_verified: error.submit_verified,
          screen: error.screen,
        }
      : {};
  const retryMeta =
    error && typeof error === "object"
      ? {
          retry_count:
            "retry_count" in error &&
            typeof (error as { retry_count?: unknown }).retry_count === "number"
              ? (error as { retry_count: number }).retry_count
              : currentTransportRetryCount(),
          ...(error &&
          "transport_state" in error &&
          typeof (error as { transport_state?: unknown }).transport_state ===
            "string"
            ? {
                transport_state: (error as { transport_state: string })
                  .transport_state,
              }
            : {}),
        }
      : { retry_count: currentTransportRetryCount() };
  const payload = {
    ok: false,
    error: message,
    ...retryMeta,
    ...modeExtra,
    ...deliverySafetyExtra,
    ...extra,
  };
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

function limitInputChunksByUtf8ByteSize(
  chunks: string[],
  maxBytes = SEND_INPUT_PASTE_BATCH_MAX_BYTES,
): string[] {
  return chunks.flatMap((chunk) =>
    Buffer.byteLength(chunk, "utf-8") > maxBytes
      ? splitTextByUtf8ByteLimit(chunk, maxBytes)
      : [chunk],
  );
}

export interface InputDeliveryBatch {
  text: string;
  firstChunkNumber: number;
  deliveredChunkCounts: number[];
}

export function splitTextByUtf8ByteLimit(
  text: string,
  maxBytes: number,
): string[] {
  if (text.length === 0) {
    return [text];
  }

  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (current && currentBytes + charBytes > maxBytes) {
      parts.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }

    current += char;
    currentBytes += charBytes;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

export function buildInputDeliveryBatches(
  chunks: string[],
  maxPasteBytes = SEND_INPUT_PASTE_BATCH_MAX_BYTES,
): InputDeliveryBatch[] {
  const batches: InputDeliveryBatch[] = [];
  let pendingText = "";
  let pendingBytes = 0;
  let pendingFirstChunkNumber = 1;
  let pendingDeliveredChunkCounts: number[] = [];

  const flushPending = () => {
    if (pendingDeliveredChunkCounts.length === 0) {
      return;
    }

    batches.push({
      text: pendingText,
      firstChunkNumber: pendingFirstChunkNumber,
      deliveredChunkCounts: pendingDeliveredChunkCounts,
    });
    pendingText = "";
    pendingBytes = 0;
    pendingDeliveredChunkCounts = [];
  };

  for (const [index, chunk] of chunks.entries()) {
    const chunkNumber = index + 1;
    const chunkBytes = Buffer.byteLength(chunk, "utf-8");

    if (chunkBytes > maxPasteBytes) {
      flushPending();
      const parts = splitTextByUtf8ByteLimit(chunk, maxPasteBytes);
      for (const [partIndex, part] of parts.entries()) {
        batches.push({
          text: part,
          firstChunkNumber: chunkNumber,
          deliveredChunkCounts:
            partIndex === parts.length - 1 ? [chunkNumber] : [],
        });
      }
      continue;
    }

    if (
      pendingDeliveredChunkCounts.length > 0 &&
      pendingBytes + chunkBytes > maxPasteBytes
    ) {
      flushPending();
    }

    if (pendingDeliveredChunkCounts.length === 0) {
      pendingFirstChunkNumber = chunkNumber;
    }
    pendingText += chunk;
    pendingBytes += chunkBytes;
    pendingDeliveredChunkCounts.push(chunkNumber);
  }

  flushPending();
  return batches;
}

function shouldPasteInputChunk(text: string, totalChunks: number): boolean {
  return totalChunks > 1 || /[\n\r\t]|\\[nrt]/.test(text);
}

function shouldPasteInputDelivery(
  chunks: string[],
  deliveryBatchCount: number,
): boolean {
  return (
    chunks.length > 1 ||
    deliveryBatchCount > 1 ||
    chunks.some((chunk) => shouldPasteInputChunk(chunk, 1))
  );
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
  if (reason.startsWith("paste delivery is required")) {
    return new Error(reason);
  }
  return new Error(
    `paste delivery is required for chunked or multiline input: ${reason}. No Return key was sent. Write the payload to a file and send "Read and follow <path>"; for launcher boot prompts, pass boot_prompt_path.`,
  );
}

const MULTILINE_INLINE_AGENT_CLIS = new Set<CliType>([
  "codex",
  "claude",
  "cursor",
  "gemini",
]);

function assertInteractiveMultilineInputAllowed(opts: {
  tool: "send_input" | "send_to" | "send_to_agent" | "spawn_agent";
  value: string | undefined;
  cli: CliType | undefined;
  allowLongInline?: boolean;
}): void {
  if (
    opts.allowLongInline ||
    !opts.value ||
    !opts.cli ||
    !MULTILINE_INLINE_AGENT_CLIS.has(opts.cli) ||
    !/\r?\n[\t ]*\r?\n/.test(opts.value)
  ) {
    return;
  }

  throw new Error(
    `${opts.tool} refuses multi-paragraph inline text for an interactive ${opts.cli} composer because paragraph breaks can become separate submitted messages. Write the payload to a file and send "Read and follow <path>" instead; for launcher boot prompts, pass boot_prompt_path. To deliberately bypass this guard, pass allow_long_inline:true.`,
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

function assertBroadcastInlineInputAllowed(text: string): void {
  if (text.length <= SEND_INPUT_MAX_INLINE_CHARS) {
    return;
  }

  throw new Error(
    `broadcast.text is ${text.length} characters, above CMUXLAYER_MAX_INLINE_CHARS=${SEND_INPUT_MAX_INLINE_CHARS}. ` +
      `Broadcasts are capped to one-line pointers: write the payload to a file and broadcast "Read and follow <path>" instead. ` +
      `CMUXLAYER_MAX_INLINE_CHARS may be set to a positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}.`,
  );
}

function broadcastRoleMatches(
  requestedRole: BroadcastRole,
  agentRole: AgentRole | null,
): boolean {
  if (requestedRole === "all") return true;
  if (requestedRole === "workers") return agentRole === "worker";
  return agentRole === "orchestrator" || agentRole === "ic";
}

function inferBroadcastRecordRole(agent: AgentRecord): AgentRole | null {
  try {
    return inferAgentRole({
      role: agent.role,
      cli: agent.cli,
      launcherName: agent.launcher_name ?? launcherNameForCli(agent.repo, agent.cli),
      title: agent.task_summary,
    });
  } catch (error) {
    if (isAgentRoleInferenceError(error)) {
      return inferRecordRoleOrNull(agent);
    }
    throw error;
  }
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

function isLauncherShellCommand(command: string): boolean {
  return /(?:^|\s)[\w.-]+(?:Claude|Codex|Cursor|Gemini)(?=\s|$)/.test(command);
}

function matchShellPromptLine(
  line: string,
  opts?: { allowRootInput?: boolean },
): { input: string } | null {
  const normalized = line.trimEnd();
  const barePrompt = normalized.match(/^\s*([$%])(?:\s+(.*))?$/);
  if (barePrompt) {
    return { input: barePrompt[2] ?? "" };
  }
  const rootPrompt = normalized.match(/^\s*#(?:\s+(.*))?$/);
  if (rootPrompt && (!rootPrompt[1] || opts?.allowRootInput)) {
    return { input: rootPrompt[1] ?? "" };
  }

  const prefixedPrompt = normalized.match(
    /^\s*(?:(?:\S+@\S+)(?:\s+(?:~|\/)\S*)?|(?:\S+\s+)?(?:~|\/)\S*)(?:\s+\[[^\]]+\])?\s*[$%#](?:\s+(.*))?$/,
  );
  return prefixedPrompt ? { input: prefixedPrompt[1] ?? "" } : null;
}

function matchesShellPrompt(text: string): boolean {
  const lines = normalizeTerminalText(text).split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  const prompt = end > 0 ? matchShellPromptLine(lines[end - 1] ?? "") : null;
  return prompt?.input.trim() === "";
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
    /Claude Code|CLAUDE_COUNTER|bypass permissions on|What can I help you with\?|(?:^|\n)\s*(?:codex>|cursor>|kiro>)(?:\s|$)/im.test(
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

export function screenShowsPendingShellInput(
  screenText: string,
  submittedText: string,
): boolean {
  const trimmed = submittedText.trim();
  if (!trimmed) {
    return false;
  }

  const lines = normalizeTerminalText(screenText).split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) {
    end -= 1;
  }

  const compactSubmitted = trimmed.replace(/\s+/g, "");
  const promptOptions = {
    allowRootInput: isLauncherShellCommand(trimmed),
  };
  let activePromptIndex = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trimEnd() ?? "";
    const prompt = matchShellPromptLine(line, promptOptions);
    if (prompt) {
      activePromptIndex = index;
      break;
    }
  }
  if (activePromptIndex < 0) {
    return false;
  }

  const prompt = matchShellPromptLine(
    lines[activePromptIndex] ?? "",
    promptOptions,
  );
  const pending = [
    prompt?.input ?? "",
    ...lines.slice(activePromptIndex + 1, end),
  ]
    .join("")
    .trimEnd();
  return (
    pending === trimmed ||
    pending.replace(/\s+/g, "") === compactSubmitted
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
  /** Override stable socket-node ownership derivation (primarily for tests). */
  surfaceObserverOwnerIdProvider?: () => string | null | undefined;
  /** Override transient reconnect/route epoch derivation (primarily for tests). */
  surfaceObserverEpochProvider?: () => string | null | undefined;
  /** Shared server-side world-model reused across many MCP connections. */
  context?: CmuxServerContext;
  /** Base directory for agent state files. Defaults to ~/.local/state/cmux-agents */
  stateDir?: string;
  /** Skip agent lifecycle initialization (for testing low-level tools only) */
  skipAgentLifecycle?: boolean;
  /** Override the per-session resident-tool palette (primarily for entry wiring/tests). */
  defaultPalette?: string;
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
  /** Extra warnings surfaced by control_health, e.g. daemon fallback mode. */
  controlHealthWarnings?: string[];
  /** Override seat registry repair/identity lookup (primarily for tests). */
  seatRegistry?: SeatRegistry | null;
  seatRegistryPath?: string;
  /**
   * Override the process-wide stale-build warner (primarily for tests). Returns
   * the loud warning string when this MCP build is stale vs the installed brew
   * build, or null. Defaults to a real, throttled, sticky-once-stale warner.
   */
  staleBuildWarner?: () => string | null;
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
  /**
   * Enable close forensics: ingest cmux's OWN app-level `tab_close` events from
   * `~/.cmuxterm/events.jsonl` and attribute them each sweep. Omitted/false by
   * default so tests never read the real cmux events file; the real MCP
   * entrypoint (index.ts) passes `true`.
   */
  enableCloseForensics?: boolean;
  /** Override per-surface PTY write-liveness tracking (primarily for tests). */
  surfaceWriteLiveness?: SurfaceWriteLivenessTracker;
  /**
   * Publish deliberate per-seat expected state. Tests inject a recorder/no-op;
   * production defaults to the orchestrator-backed filesystem writer.
   */
  seatManifestWriter?: SeatManifestWriter;
  /** Override the manifest timestamp source for deterministic tests. */
  seatManifestNow?: () => string;
  /** Publish the opt-in generated fleet.swift from reconciled lifecycle state. */
  fleetSidebarPublisher?: FleetSidebarPublisherLike;
}

type CmuxLayerClient = CmuxClient | CmuxSocketClient;

interface ReadScreenSnapshot {
  result: CmuxReadScreenResult;
  topology: SurfaceTopologySnapshot | null;
}

export type LifecycleAgentInputDeliverer = (args: {
  agent_id: string;
  text: string;
  press_enter: boolean;
  allow_busy?: boolean;
  source_event: DeliveryEventType;
}) => Promise<unknown>;

export interface CmuxServerContext {
  client: CmuxLayerClient;
  /** Persisted stable socket-node owner identity. */
  surfaceObserverId: string | null;
  /** Non-persisted transport/route generation for in-flight guards. */
  surfaceObserverEpoch: string | null;
  stateDir: string;
  stateMgr: StateManager;
  roleSurfaceOverrides: Map<
    string,
    { role: AgentRole; workspace: string | null; surfaceUuid: string | null }
  >;
  eventLog: ReturnType<StateManager["getEventLog"]>;
  deliveries: Map<string, DeliveryRecord>;
  latestDeliveryBySurface: Map<string, string>;
  activeDeliveryBySurface: Map<string, string>;
  activeSurfaceWrites: Map<string, string>;
  originalLaunchCommandsBySurface: Map<string, string>;
  surfaceWriteLivenessCandidates: Set<string>;
  surfacePtyDeadSince: Map<string, number>;
  readScreenInflight: Map<string, Promise<ReadScreenSnapshot>>;
  surfaceWriteLiveness: SurfaceWriteLivenessTracker;
  enableClaudeChannels: boolean;
  skipAgentLifecycle: boolean;
  spawnPreflight?: (params: SpawnAgentParams) => Promise<void>;
  disableSpawnPreflight?: boolean;
  sessionIdentityResolver?: SessionIdentityResolver;
  lifecycleRegistry: AgentRegistry | null;
  lifecycleStarted: boolean;
  lifecycleStartPromise: Promise<void> | null;
  lifecycleSweepEngine: AgentEngine | null;
  lifecycleAgentInputDeliverer: LifecycleAgentInputDeliverer | null;
  lifecycleAgentInputDelivererReadyListeners: Set<() => void>;
  setLifecycleAgentInputDeliverer(
    deliverer: LifecycleAgentInputDeliverer | null,
  ): void;
  controlHealthCollector?: () => Promise<ControlHealth>;
  controlHealthWarnings: string[];
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
    opts?.client ??
    new CmuxClient({
      exec: opts?.exec,
      bin: opts?.bin ?? (opts?.exec ? "cmux" : undefined),
    });
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
  const readObserverProvider = (
    provider: () => string | null | undefined,
  ): string | null => {
    try {
      return provider()?.trim() || null;
    } catch {
      return null;
    }
  };
  const observerOwnerIdProvider =
    opts?.surfaceObserverOwnerIdProvider ??
    (() => deriveCmuxObserverOwnerId(client));
  const observerEpochProvider =
    opts?.surfaceObserverEpochProvider ??
    (() => deriveCmuxObserverEpoch(client));
  const context: CmuxServerContext = {
    client,
    get surfaceObserverId() {
      return readObserverProvider(observerOwnerIdProvider);
    },
    get surfaceObserverEpoch() {
      return readObserverProvider(observerEpochProvider);
    },
    stateDir,
    stateMgr,
    roleSurfaceOverrides: new Map(),
    eventLog: stateMgr.getEventLog(),
    deliveries: new Map(),
    latestDeliveryBySurface: new Map(),
    activeDeliveryBySurface: new Map(),
    activeSurfaceWrites: new Map(),
    originalLaunchCommandsBySurface: new Map(),
    surfaceWriteLivenessCandidates: new Set(),
    surfacePtyDeadSince: new Map(),
    readScreenInflight: new Map(),
    surfaceWriteLiveness:
      opts?.surfaceWriteLiveness ?? new SurfaceWriteLivenessTracker(),
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
    lifecycleAgentInputDeliverer: null,
    lifecycleAgentInputDelivererReadyListeners: new Set(),
    setLifecycleAgentInputDeliverer(deliverer) {
      const becameReady =
        context.lifecycleAgentInputDeliverer === null && deliverer !== null;
      context.lifecycleAgentInputDeliverer = deliverer;
      if (becameReady) {
        for (const listener of context.lifecycleAgentInputDelivererReadyListeners) {
          listener();
        }
      }
    },
    controlHealthCollector: opts?.controlHealthCollector,
    controlHealthWarnings: opts?.controlHealthWarnings ?? [],
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
      context.lifecycleAgentInputDeliverer = null;
      context.lifecycleAgentInputDelivererReadyListeners.clear();
      context.originalLaunchCommandsBySurface.clear();
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
  const originalLaunchCommandsBySurface =
    context.originalLaunchCommandsBySurface;
  const surfaceWriteLiveness = context.surfaceWriteLiveness;
  const surfaceWriteLivenessCandidates =
    context.surfaceWriteLivenessCandidates;
  const surfacePtyDeadSince = context.surfacePtyDeadSince;
  const seatManifestWriter: SeatManifestWriter =
    opts?.seatManifestWriter ??
    (process.env.VITEST === "true"
      ? async () => {}
      : createFileSystemSeatManifestWriter());
  const seatManifestNow =
    opts?.seatManifestNow ?? (() => new Date().toISOString());
  const enableClaudeChannels =
    opts?.enableClaudeChannels ?? context.enableClaudeChannels;
  const skipAgentLifecycle =
    opts?.skipAgentLifecycle ?? context.skipAgentLifecycle;
  const spawnPreflight = opts?.spawnPreflight ?? context.spawnPreflight;
  const disableSpawnPreflight =
    opts?.disableSpawnPreflight ?? context.disableSpawnPreflight;
  const controlHealthCollector =
    opts?.controlHealthCollector ?? context.controlHealthCollector;
  const controlHealthWarnings =
    opts?.controlHealthWarnings ?? context.controlHealthWarnings;
  const seatRegistry =
    opts?.seatRegistry !== undefined
      ? opts.seatRegistry
      : loadSeatRegistryFromConfig(opts?.seatRegistryPath);
  const staleBuildWarning = opts?.staleBuildWarner ?? defaultStaleBuildWarner;
  const appendStaleBuildWarning = (result: { warnings?: string[] }): void => {
    const warning = staleBuildWarning();
    if (warning) {
      result.warnings = [...(result.warnings ?? []), warning];
    }
  };
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
  let lifecycleAgentInputDeliverer: LifecycleAgentInputDeliverer | null = null;
  let lifecycleSeatManifestPublisher: (input: {
    agentId?: string;
    surfaceId?: string;
    tabName?: string;
    model?: string;
  }) => Promise<void> = async () => {};
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

  const monitorRegistryOptions = (): MonitorRegistryOptions => ({
    ...(opts?.monitorRegistryPath ? { registryPath: opts.monitorRegistryPath } : {}),
    ...(opts?.monitorRegistryNow ? { now: opts.monitorRegistryNow } : {}),
  });
  const monitorRegistryError = (
    reason: string,
    monitorId?: string | null,
    message = reason,
  ): ToolReturn =>
    err(new Error(message), {
      reason,
      monitor_id: monitorId ?? "<missing-monitor-id>",
    });
  const validateRegisterMonitorArgs = (
    args: Record<string, unknown>,
  ): RegisterMonitorInput | ToolReturn => {
    const monitorId = nonEmptyString(args.monitor_id);
    if (!monitorId) {
      return monitorRegistryError("missing-monitor-id", null);
    }
    const ownerSeat = nonEmptyString(args.owner_seat);
    if (!ownerSeat || /^(?:unknown|none|null|n\/a)$/i.test(ownerSeat)) {
      return monitorRegistryError(
        "missing-or-unknown-owner-seat",
        monitorId,
      );
    }
    const watchTargets = Array.isArray(args.watch_targets)
      ? args.watch_targets.map(nonEmptyString)
      : null;
    if (
      !watchTargets ||
      watchTargets.length === 0 ||
      watchTargets.some((target) => target === null)
    ) {
      return monitorRegistryError("invalid-watch-targets", monitorId);
    }
    if (args.mechanism !== "event" && args.mechanism !== "offset-poll") {
      return monitorRegistryError("invalid-mechanism", monitorId);
    }
    const watermarkKey = nonEmptyString(args.watermark_key);
    if (args.mechanism === "offset-poll" && !watermarkKey) {
      return monitorRegistryError(
        "offset-poll-missing-watermark-key",
        monitorId,
      );
    }
    const dedupe =
      args.dedupe === "offset" ||
      args.dedupe === "seen-set" ||
      args.dedupe === "header-keyed"
        ? args.dedupe
        : undefined;
    if (args.dedupe !== undefined && !dedupe) {
      return monitorRegistryError("invalid-dedupe", monitorId);
    }
    if (
      typeof args.deadman_timeout_s !== "number" ||
      !Number.isFinite(args.deadman_timeout_s) ||
      args.deadman_timeout_s <= 0
    ) {
      return monitorRegistryError("invalid-deadman-timeout", monitorId);
    }
    const addressee = nonEmptyString(args.addressee);
    if (args.addressee !== undefined && !addressee) {
      return monitorRegistryError("invalid-addressee", monitorId);
    }
    const rearmCommand = nonEmptyString(args.rearm_command);
    if (args.rearm_command !== undefined && !rearmCommand) {
      return monitorRegistryError("invalid-rearm-command", monitorId);
    }
    if (
      rearmCommand &&
      (watchTargets as string[]).some(
        (target) =>
          target !== "~" && !target.startsWith("~/") && !isAbsolute(target),
      )
    ) {
      return monitorRegistryError(
        "rearm-watch-target-not-absolute",
        monitorId,
      );
    }

    return {
      monitor_id: monitorId,
      owner_seat: ownerSeat,
      watch_targets: watchTargets as string[],
      mechanism: args.mechanism,
      ...(nonEmptyString(args.pattern)
        ? { pattern: nonEmptyString(args.pattern)! }
        : {}),
      ...(watermarkKey ? { watermark_key: watermarkKey } : {}),
      ...(dedupe ? { dedupe } : {}),
      ...(addressee ? { addressee } : {}),
      ...(rearmCommand ? { rearm_command: rearmCommand } : {}),
      deadman_timeout_s: args.deadman_timeout_s,
    };
  };
  const isToolReturn = (
    value: RegisterMonitorInput | ToolReturn,
  ): value is ToolReturn => "content" in value;
  const collectMonitorIds = (args: {
    monitor_id?: string;
    monitor_ids?: string[];
    claimed_monitor_ids?: string[];
  }): string[] => {
    const ids = [
      ...(nonEmptyString(args.monitor_id) ? [nonEmptyString(args.monitor_id)!] : []),
      ...(Array.isArray(args.monitor_ids) ? args.monitor_ids : []),
      ...(Array.isArray(args.claimed_monitor_ids)
        ? args.claimed_monitor_ids
        : []),
    ]
      .map(nonEmptyString)
      .filter((id): id is string => id !== null);
    return [...new Set(ids)];
  };
  const filterMonitorRegistryRecords = <
    T extends { monitor_id: string; owner_seat?: string; state?: string },
  >(
    records: T[],
    args: {
      owner_seat?: string;
      include_dead?: boolean;
      monitor_id?: string;
      monitor_ids?: string[];
      claimed_monitor_ids?: string[];
    },
    includeDeadByDefault: boolean,
  ): T[] => {
    const ownerSeat = nonEmptyString(args.owner_seat);
    const ids = collectMonitorIds(args);
    const idSet = new Set(ids);
    const includeDead = args.include_dead ?? includeDeadByDefault;
    return records.filter((record) => {
      if (!includeDead && record.state === "dead") return false;
      if (ownerSeat && record.owner_seat !== ownerSeat) return false;
      if (idSet.size > 0 && !idSet.has(record.monitor_id)) return false;
      return true;
    });
  };
  const queryMonitorRegistryTool = (
    args: {
      gate?: "gate-9" | "gate-10";
      owner_seat?: string;
      monitor_id?: string;
      monitor_ids?: string[];
      claimed_monitor_ids?: string[];
      include_dead?: boolean;
    },
    toolName: "list_monitors" | "query_monitor_registry",
  ): ToolReturn => {
    const gate = args.gate;
    if (!gate) {
      const registry = readMonitorRegistry(monitorRegistryOptions());
      const monitors = filterMonitorRegistryRecords(
        registry.monitors,
        args,
        false,
      );
      return ok({
        tool: toolName,
        version: registry.version,
        monitors,
      });
    }

    const claimedMonitorIds = collectMonitorIds(args);
    const query = queryMonitorRegistryForGates({
      ...monitorRegistryOptions(),
      ...(claimedMonitorIds.length > 0 ? { claimedMonitorIds } : {}),
    });
    const requestedIds = new Set(claimedMonitorIds);
    const monitors = filterMonitorRegistryRecords(
      query.monitors,
      args,
      true,
    );
    const monitorById = new Map(
      query.monitors.map((monitor) => [monitor.monitor_id, monitor]),
    );
    const violations = query.violations.filter((violation) => {
      if (violation.gate !== gate) return false;
      if (requestedIds.size > 0 && !requestedIds.has(violation.monitor_id)) {
        return false;
      }
      const ownerSeat = nonEmptyString(args.owner_seat);
      if (!ownerSeat) return true;
      const monitor = monitorById.get(violation.monitor_id);
      return !monitor || monitor.owner_seat === ownerSeat;
    });
    return ok({
      tool: toolName,
      gate,
      verdict: violations.length > 0 ? "fire" : "pass",
      queried_at: query.queried_at,
      latency_ms: query.latency_ms,
      monitors,
      violations,
    });
  };

  const server = new McpServer(
    {
      name: "cmuxlayer",
      version: RUNNING_VERSION,
    },
    enableClaudeChannels
      ? { instructions: CLAUDE_CHANNEL_INSTRUCTIONS }
      : undefined,
  );
  const rawTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const toolHandlersByName = new Map<
    string,
    (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<ToolReturn>
  >();
  const palette = createDefaultToolPalette(
    opts?.defaultPalette ?? process.env[CMUXLAYER_DEFAULT_PALETTE_ENV],
  );
  (
    server as unknown as { tool: (...args: unknown[]) => unknown }
  ).tool = (...args: unknown[]): unknown => {
    const toolName = args[0];
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler === "function") {
      const trackedHandler = (...handlerArgs: unknown[]) =>
        withTransportRetryTracking(() => handler(...handlerArgs));
      args[handlerIndex] = trackedHandler;
      if (typeof toolName === "string") {
        toolHandlersByName.set(
          toolName,
          trackedHandler as (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<ToolReturn>,
        );
      }
    }
    if (
      palette &&
      typeof toolName === "string" &&
      !palette.shouldRegister(toolName)
    ) {
      return palette.defer(toolName, args);
    }
    return rawTool(...args);
  };
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
    observation?: SurfaceBindingObservation,
  ) => {
    const roleRecords = context.lifecycleRegistry?.list() ?? [];
    const observedRoleRecords = observation
      ? roleRecords.flatMap((record) => {
          const surfaceRef = resolveObservedAgentSurfaceRef(
            record,
            observation,
          );
          const observedUuid = surfaceRef
            ? observation.surfaceUuidByRef.get(surfaceRef)
            : null;
          return surfaceRef &&
            context.lifecycleRegistry?.canUseObservedBinding(
              record,
              observedUuid,
            )
            ? [{ ...record, surface_id: surfaceRef }]
            : [];
        })
      : roleRecords;
    const ids = collectRoleSurfaceIds(observedRoleRecords);
    if (liveSurfaceIds) {
      for (const role of ["orchestrator", "ic", "worker"] as const) {
        for (const surfaceId of ids[role]) {
          if (!liveSurfaceIds.has(surfaceId)) {
            ids[role].delete(surfaceId);
          }
        }
      }
    }
    const movedOverrides: Array<{
      oldRef: string;
      newRef: string;
      override: {
        role: AgentRole;
        workspace: string | null;
        surfaceUuid: string | null;
      };
    }> = [];
    for (const [surfaceId, override] of roleSurfaceOverrides) {
      if (observation) {
        const observedRef = resolveObservedAgentSurfaceRef(
          {
            surface_id: surfaceId,
            surface_uuid: override.surfaceUuid,
          },
          observation,
        );
        if (!observedRef) {
          if (
            workspace &&
            override.workspace === workspace &&
            (observation.coverage === "uuid" ||
              observation.coverage === "ref")
          ) {
            roleSurfaceOverrides.delete(surfaceId);
          }
          continue;
        }
        ids[override.role].add(observedRef);
        if (observedRef !== surfaceId) {
          movedOverrides.push({
            oldRef: surfaceId,
            newRef: observedRef,
            override,
          });
        }
        continue;
      }
      if (liveSurfaceIds && !liveSurfaceIds.has(surfaceId)) {
        if (workspace && override.workspace === workspace) {
          roleSurfaceOverrides.delete(surfaceId);
        }
        continue;
      }
      ids[override.role].add(surfaceId);
    }
    for (const { oldRef, newRef, override } of movedOverrides) {
      roleSurfaceOverrides.delete(oldRef);
      roleSurfaceOverrides.set(newRef, override);
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

  const recordSurfaceWriteSuccess = (surface: string): void => {
    surfaceWriteLiveness.recordSuccess(surface);
    surfaceWriteLivenessCandidates.delete(surface);
    surfacePtyDeadSince.delete(surface);
  };

  const recordSurfaceWriteFailure = (
    surface: string,
    error: unknown,
  ): void => {
    if (!isBrokenPipeError(error)) return;
    surfaceWriteLiveness.recordFailure(surface, error);
    const observation = surfaceWriteLiveness.observe(surface);
    if (!observation || observation.consecutive_broken_pipe_failures === 0) {
      surfaceWriteLivenessCandidates.delete(surface);
      surfacePtyDeadSince.delete(surface);
      return;
    }
    if (!observation.pty_dead) {
      surfaceWriteLivenessCandidates.delete(surface);
      surfacePtyDeadSince.delete(surface);
      return;
    }
    surfaceWriteLivenessCandidates.add(surface);
    if (!surfacePtyDeadSince.has(surface)) {
      surfacePtyDeadSince.set(surface, observation.last_attempt_at);
    }
  };

  const withSurfaceWrite = async <T>(
    surface: string,
    fn: () => Promise<T>,
    opts: {
      toolName?: string;
      workspace?: string;
      owner?: string;
      observePtyWrite?: boolean;
    } = {},
  ): Promise<T> => {
    if (opts.toolName) {
      await assertSurfaceMutationAllowed(opts.toolName, surface, opts.workspace);
    }
    const owner = opts.owner ?? `surface-write:${randomUUID()}`;
    acquireSurfaceWrite(surface, owner);
    try {
      const result = await fn();
      if (opts.observePtyWrite) {
        recordSurfaceWriteSuccess(surface);
      }
      return result;
    } catch (error) {
      if (opts.observePtyWrite) {
        recordSurfaceWriteFailure(surface, error);
      }
      throw error;
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
    if (status === "delivered") {
      recordSurfaceWriteSuccess(record.surface);
    } else if (status === "failed") {
      recordSurfaceWriteFailure(record.surface, error);
    }
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
    shouldPaste: boolean,
    avoidDuplicateOnAmbiguousRetry: boolean,
    beforeMutation?: () => Promise<void>,
  ) => {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < SEND_INPUT_RETRY_ATTEMPTS) {
      try {
        await beforeMutation?.();
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
          const rawMessage =
            error instanceof Error ? error.message : String(error);
          const message = shouldPaste
            ? pasteRequiredError(rawMessage).message
            : rawMessage;
          throw new DeliveryError(
            `chunk ${chunkNumber}/${totalChunks} failed: ${message}`,
            chunkNumber,
          );
        }
        if (avoidDuplicateOnAmbiguousRetry) {
          const observationStartedAt = Date.now();
          while (
            Date.now() - observationStartedAt <
            SEND_INPUT_SAFE_RETRY_OBSERVE_MS
          ) {
            try {
              const snapshot = await readParsedSurface(
                surface,
                opts.workspace,
                { throwOnSurfaceGone: true },
              );
              if (
                snapshot &&
                (screenShowsPendingInput(snapshot.text, chunk) ||
                  screenShowsPendingShellInput(snapshot.text, chunk))
              ) {
                return;
              }
            } catch (observeError) {
              if (observeError instanceof SurfaceGoneError) {
                throw observeError;
              }
              // Keep observing until the bounded deadline. Retrying the text
              // mutation after an unreadable pane can concatenate launchers.
            }

            const remainingMs =
              SEND_INPUT_SAFE_RETRY_OBSERVE_MS -
              (Date.now() - observationStartedAt);
            if (remainingMs <= 0) break;
            await delay(Math.min(SEND_INPUT_SUBMIT_VERIFY_POLL_MS, remainingMs));
          }

          const message =
            error instanceof Error ? error.message : String(error);
          throw new DeliveryError(
            `chunk ${chunkNumber}/${totalChunks} acknowledgement was ambiguous and launcher text was not retried: ${message}`,
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
    beforeMutation?: () => Promise<void>,
  ) => {
    let attempt = 0;

    while (attempt < SEND_INPUT_RETRY_ATTEMPTS) {
      try {
        await beforeMutation?.();
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
    const rawHealth = controlHealthCollector
      ? await controlHealthCollector()
      : await collectControlHealth({ client });
    const knownSurfaceIds = [
      ...stateMgr.listStates().map((record) => record.surface_id),
      ...roleSurfaceOverrides.keys(),
      ...latestDeliveryBySurface.keys(),
      ...activeSurfaceWrites.keys(),
      ...surfaceWriteLivenessCandidates,
    ];
    const healthWithSelfHeal: ControlHealth = {
      ...rawHealth,
      self_heal: collectSelfHealHealth({
        surfaceWriteLiveness,
        surfaceIds: knownSurfaceIds,
        panePtyDeadSince: surfacePtyDeadSince,
        monitorRegistry: opts?.monitorRegistryPath
          ? monitorRegistryOptions()
          : undefined,
      }),
    };
    const health =
      controlHealthWarnings.length > 0
        ? {
            ...healthWithSelfHeal,
            warnings: [
              ...healthWithSelfHeal.warnings,
              ...controlHealthWarnings,
            ],
          }
        : healthWithSelfHeal;
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
    cli?: CliType,
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

    if (isPickerOrMenuScreen(snapshot.text, cli)) {
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
    await lifecycleSeatManifestPublisher({
      surfaceId: opts.surface,
      tabName: newTitle,
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
    allow_recovery_enter_retry?: boolean;
    timeout_ms?: number;
    beforeMutation?: () => Promise<void>;
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
    let sawClearedComposerEvidence = false;
    let sawAllowedClearedComposerEvidence = false;
    let lastHasPendingInput = false;
    let lastRetryEligiblePendingInput = false;
    let retryEligiblePendingSince: number | null = null;
    let retriedAt: number | null = null;
    const screenIncludesSubmittedText = (screenText: string): boolean => {
      const trimmed = opts.text.trim();
      if (!trimmed) {
        return false;
      }
      const tail = trimmed.slice(-Math.min(80, trimmed.length));
      return normalizeTerminalText(screenText).includes(tail);
    };

    while (Date.now() - startedAt < timeoutMs) {
      await opts.beforeMutation?.();
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
      lastHasPendingInput = hasPendingInput;
      const composerInput = extractComposerInputRegion(snapshot.text);
      const hasClearedAgentComposer =
        composerInput !== null &&
        composerInput.trim() === "" &&
        !hasPendingInput &&
        screenHasAnyAgentIdentity(snapshot.text, snapshot.parsed);
      if (hasClearedAgentComposer) {
        sawClearedComposerEvidence = true;
        const allowClearedComposerSubmitEvidence =
          opts.source_event !== "spawn_agent" ||
          !screenIncludesSubmittedText(snapshot.text);
        if (allowClearedComposerSubmitEvidence) {
          sawAllowedClearedComposerEvidence = true;
          return { submit_verified: true, retry_count: retryCount };
        }
      }

      const shouldRetryEnter =
        hasPendingInput ||
        (opts.source_event === "spawn_agent" &&
          screenIncludesSubmittedText(snapshot.text));
      const retryEligiblePendingInput =
        opts.allow_recovery_enter_retry !== false &&
        shouldRetryEnter &&
        !screenHasAnyAgentIdentity(snapshot.text, snapshot.parsed) &&
        opts.source_event === "spawn_agent" &&
        !hasParsedAgentIdentity(snapshot.parsed);
      lastRetryEligiblePendingInput = retryEligiblePendingInput;
      if (retryEligiblePendingInput) {
        retryEligiblePendingSince ??= Date.now();
      } else {
        retryEligiblePendingSince = null;
      }
      const retryObserveMs =
        opts.source_event === "spawn_agent" &&
        !hasParsedAgentIdentity(snapshot.parsed)
          ? 0
          : Math.min(timeoutMs, SEND_INPUT_SAFE_RETRY_OBSERVE_MS);

      // Pending input is ambiguous: the first Return may have been missed, or
      // it may have landed while a slow agent has not repainted the composer
      // yet. Observe before retrying, and only retry an idle agent composer that
      // still definitively holds the original text.
      if (
        !retried &&
        retryEligiblePendingInput &&
        retryEligiblePendingSince !== null &&
        Date.now() - retryEligiblePendingSince >= retryObserveMs
      ) {
        await delay(SEND_INPUT_RECOVERY_ENTER_DELAY_MS);
        await sendKeyWithRetry(
          opts.surface,
          "return",
          opts.workspace,
          opts.beforeMutation,
        );
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
        retriedAt = Date.now();
        continue;
      }

      if (
        retriedAt !== null &&
        retryEligiblePendingInput &&
        Date.now() - retriedAt >= SEND_INPUT_POST_RETRY_VERIFY_GRACE_MS
      ) {
        return { submit_verified: false, retry_count: retryCount };
      }

      await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
    }
    return {
      submit_verified:
        sawClearedComposerEvidence && sawAllowedClearedComposerEvidence
          ? true
          : opts.require_working_status
            ? false
          : lastHasPendingInput
            ? false
          : lastRetryEligiblePendingInput
            ? false
            : null,
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
    allow_recovery_enter_retry?: boolean;
    submit_verify_timeout_ms?: number;
    beforeMutation?: () => Promise<void>;
  }): Promise<{
    bytes: number;
    retry_count: number;
    submit_verified: boolean | null;
  }> => {
    await opts.beforeMutation?.();
    await assertDeliveryTargetIsSafe(opts.surface, opts.workspace);
    const deliveryBatches = buildInputDeliveryBatches(opts.chunks);
    const shouldPaste = shouldPasteInputDelivery(
      opts.chunks,
      deliveryBatches.length,
    );
    for (const [index, batch] of deliveryBatches.entries()) {
      await sendChunkWithRetry(
        opts.surface,
        batch.text,
        {
          workspace: opts.workspace,
        },
        batch.firstChunkNumber,
        opts.chunks.length,
        shouldPaste,
        opts.source_event === "spawn_agent",
        opts.beforeMutation,
      );
      for (const sentChunks of batch.deliveredChunkCounts) {
        opts.onChunkDelivered?.(sentChunks);
      }
      if (index < deliveryBatches.length - 1) {
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
      await sendKeyWithRetry(
        opts.surface,
        "return",
        opts.workspace,
        opts.beforeMutation,
      );
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
        allow_recovery_enter_retry: opts.allow_recovery_enter_retry,
        timeout_ms: opts.submit_verify_timeout_ms,
        require_working_status: opts.source_event === "boot_prompt",
        beforeMutation: opts.beforeMutation,
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
    resolveRoute?: () => Promise<{ surface: string; workspace?: string }>;
  }): Promise<{
    metrics: RawSubmitEvidenceMetrics | null;
    route: { surface: string; workspace?: string };
  }> => {
    let deadline = Date.now() + opts.timeout_ms;
    let lastText = "";
    let lastSurface = opts.surface;
    const consecutiveMatches = new Map<CliType, number>();
    const candidates = readyPatternCandidates(opts.cli);
    let updateStartedAt: number | null = null;
    let updateElapsedMs = 0;
    let updateWasSeen = false;
    let updateShellRelaunches = 0;
    let codexUpdateMenuAccepted = false;
    let codexUpdateMenuAcceptedAt: number | null = null;
    const updateMaxMs = bootPromptUpdateMaxMs();
    const postUpdateReadyBudgetMs = () =>
      Math.max(opts.timeout_ms, BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS);

    while (Date.now() < deadline || updateStartedAt !== null) {
      let target: { surface: string; workspace?: string } = {
        surface: opts.surface,
        workspace: opts.workspace,
      };
      try {
        target = opts.resolveRoute ? await opts.resolveRoute() : target;
        lastSurface = target.surface;
        const screen = await client.readScreen(target.surface, {
          workspace: target.workspace,
          lines: 80,
          scrollback: false,
        });
        lastText = screen.text;
        const parsed = parseScreen(screen.text);
        const now = Date.now();
        const updateState = parsed.cli_update_state;

        if (shouldHandleCodexUpdateMenu(opts.cli, screen.text)) {
          if (codexUpdateMenuAccepted) {
            const elapsedSinceAcceptMs =
              codexUpdateMenuAcceptedAt === null
                ? BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS
                : now - codexUpdateMenuAcceptedAt;
            if (
              elapsedSinceAcceptMs < BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS
            ) {
              consecutiveMatches.clear();
              await delay(BOOT_PROMPT_READY_POLL_MS);
              continue;
            }
            throw new BootPromptUpdateMenuBlockedError(
              `Boot prompt delivery blocked by Codex update menu on ${target.surface}`,
              tailLines(lastText, 10),
            );
          }
          updateWasSeen = true;
          consecutiveMatches.clear();
          await sendKeyWithRetry(
            target.surface,
            "return",
            target.workspace,
            opts.resolveRoute
              ? async () => {
                  const current = await opts.resolveRoute!();
                  if (
                    current.surface !== target.surface ||
                    (current.workspace ?? null) !==
                      (target.workspace ?? null)
                  ) {
                    throw new Error(
                      `Boot prompt route changed before update-menu Return; ` +
                        `refusing terminal mutation.`,
                    );
                  }
                }
              : undefined,
          );
          codexUpdateMenuAccepted = true;
          const acceptedAt = Date.now();
          codexUpdateMenuAcceptedAt = acceptedAt;
          deadline = Math.max(
            deadline,
            acceptedAt + postUpdateReadyBudgetMs(),
            acceptedAt +
              BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS +
              BOOT_PROMPT_READY_POLL_MS,
          );
          await delay(BOOT_PROMPT_READY_POLL_MS);
          continue;
        }

        if (updateState === "updating") {
          updateWasSeen = true;
          updateStartedAt ??= now;
          updateElapsedMs = Math.max(
            updateElapsedMs + BOOT_PROMPT_READY_POLL_MS,
            updateStartedAt === null ? 0 : now - updateStartedAt,
          );
          if (updateElapsedMs >= updateMaxMs) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for boot prompt readiness on ${target.surface}: CLI update marker persisted for ${updateMaxMs}ms`,
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

        if (updateState === "update_complete") {
          updateWasSeen = true;
          consecutiveMatches.clear();
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
              `Timed out waiting for boot prompt readiness on ${target.surface}: CLI returned to shell after ${updateShellRelaunches} post-update relaunch attempts`,
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
            return {
              metrics: parseRawSubmitEvidenceMetrics(screen.text),
              route: target,
            };
          }
        }
      } catch (error) {
        if (
          error instanceof BootPromptTimeoutError ||
          error instanceof BootPromptUpdateMenuBlockedError
        ) {
          throw error;
        }
        if (isSurfaceGoneReadFailure(error, target.surface)) {
          throw new SurfaceGoneError(target.surface, error);
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
      `Timed out after ${opts.timeout_ms}ms waiting for boot prompt readiness on ${lastSurface}`,
      tailLines(lastText, 10),
    );
  };

  const waitForBootPromptSubmitEvidence = async (opts: {
    surface: string;
    workspace?: string;
    text: string;
    timeout_ms: number;
    baseline_metrics?: RawSubmitEvidenceMetrics | null;
    beforeRead?: () => Promise<void>;
  }): Promise<void> => {
    const start = Date.now();
    let lastText = "";
    let lastClearedComposerInput: string | null = null;
    let stableClearedComposerPolls = 0;

    while (Date.now() - start < opts.timeout_ms) {
      await opts.beforeRead?.();
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
    require_fresh_shell_prompt?: boolean;
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
          (!opts.require_fresh_shell_prompt &&
            READY_PATTERN_CLIS.some(
              (cli) => matchReadyPattern(cli, screen.text).matched,
            ))
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
    onUpdateShellRelaunch?: () => Promise<void>;
  }): Promise<void> => {
    const timeoutMs = opts.timeout_ms ?? LAUNCH_SUBMIT_READY_TIMEOUT_MS;
    let deadline = Date.now() + timeoutMs;
    let lastText = "";
    let updateStartedAt: number | null = null;
    let updateElapsedMs = 0;
    let updateWasSeen = false;
    let updateShellRelaunches = 0;
    const updateMaxMs = bootPromptUpdateMaxMs();

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

        if (parsed.cli_update_state === "updating") {
          updateWasSeen = true;
          updateStartedAt ??= now;
          updateElapsedMs = Math.max(
            updateElapsedMs + LAUNCH_SHELL_READY_POLL_MS,
            now - updateStartedAt,
          );
          if (updateElapsedMs >= updateMaxMs) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for agent launch readiness on ${opts.surface}: CLI update marker persisted for ${updateMaxMs}ms`,
              tailLines(lastText, 10),
            );
          }
          await delay(LAUNCH_SHELL_READY_POLL_MS);
          continue;
        }

        if (updateStartedAt !== null) {
          const updateDuration = Math.max(
            now - updateStartedAt,
            updateElapsedMs,
          );
          deadline = Math.max(
            deadline + updateDuration,
            now + Math.max(timeoutMs, BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS),
          );
          updateStartedAt = null;
          updateElapsedMs = 0;
        }

        if (parsed.cli_update_state === "update_complete") {
          updateWasSeen = true;
        }

        if (
          updateWasSeen &&
          opts.onUpdateShellRelaunch &&
          matchesShellPrompt(screen.text) &&
          !READY_PATTERN_CLIS.some(
            (cli) => matchReadyPattern(cli, screen.text).matched,
          )
        ) {
          if (updateShellRelaunches >= BOOT_PROMPT_UPDATE_RELAUNCH_MAX) {
            throw new BootPromptTimeoutError(
              `Timed out waiting for agent launch readiness on ${opts.surface}: CLI returned to shell after ${updateShellRelaunches} post-update relaunch attempts`,
              tailLines(lastText, 10),
            );
          }
          updateShellRelaunches += 1;
          const relaunchStartedAt = Date.now();
          await opts.onUpdateShellRelaunch();
          const relaunchEndedAt = Date.now();
          deadline = Math.max(
            deadline + (relaunchEndedAt - relaunchStartedAt),
            relaunchEndedAt +
              Math.max(timeoutMs, BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS),
          );
          continue;
        }

        if (
          READY_PATTERN_CLIS.some(
            (cli) => matchReadyPattern(cli, screen.text).matched,
          )
        ) {
          return;
        }
      } catch (error) {
        if (error instanceof BootPromptTimeoutError) {
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
    relaunch?: boolean;
    assertSurfaceBindingCurrent?: () => Promise<void>;
  }): Promise<void> => {
    const sanitizedCommand = sanitizeTerminalInput(opts.command);
    const chunks =
      sanitizedCommand.length > SEND_INPUT_CHUNK_THRESHOLD
        ? chunkTerminalInput(sanitizedCommand, SEND_INPUT_CHUNK_THRESHOLD)
        : [sanitizedCommand];

    if (!opts.relaunch) {
      await waitForLaunchShellReady({
        surface: opts.surface,
        workspace: opts.workspace,
      });
    }
    await opts.assertSurfaceBindingCurrent?.();
    await withSurfaceWrite(opts.surface, async () => {
      const submitPendingLauncherCommand = async (): Promise<boolean> => {
        const readLauncherScreen = () =>
          client.readScreen(opts.surface, {
            workspace: opts.workspace,
            lines: 80,
            scrollback: false,
          });

        let screen;
        try {
          screen = await readLauncherScreen();
        } catch (error) {
          if (isSurfaceGoneReadFailure(error, opts.surface)) {
            throw new SurfaceGoneError(opts.surface, error);
          }
          return false;
        }
        if (!screenShowsPendingShellInput(screen.text, sanitizedCommand)) {
          return false;
        }

        try {
          // Return is a mutation: retrying after a lost acknowledgement can
          // submit into the newly started CLI. Probe before any fallback.
          await opts.assertSurfaceBindingCurrent?.();
          await client.sendKey(opts.surface, "return", {
            workspace: opts.workspace,
          });
          return true;
        } catch (error) {
          if (isSurfaceGoneReadFailure(error, opts.surface)) {
            throw new SurfaceGoneError(opts.surface, error);
          }
          try {
            const confirmation = await readLauncherScreen();
            return !screenShowsPendingShellInput(
              confirmation.text,
              sanitizedCommand,
            );
          } catch (confirmationError) {
            if (isSurfaceGoneReadFailure(confirmationError, opts.surface)) {
              throw new SurfaceGoneError(opts.surface, confirmationError);
            }
            throw error;
          }
        }
      };
      const clearAndVerifyFreshShellPrompt = async (): Promise<void> => {
        await opts.assertSurfaceBindingCurrent?.();
        await sendKeyWithRetry(opts.surface, "ctrl-c", opts.workspace);
        await waitForLaunchShellReady({
          surface: opts.surface,
          workspace: opts.workspace,
          require_fresh_shell_prompt: true,
        });
      };
      if (opts.relaunch) {
        if (await submitPendingLauncherCommand()) {
          return;
        }
        await clearAndVerifyFreshShellPrompt();
      }
      const relaunchOriginalCommand = async (): Promise<void> => {
        await clearAndVerifyFreshShellPrompt();
        await deliverInputChunks({
          surface: opts.surface,
          workspace: opts.workspace,
          chunks,
          chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
          chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
          press_enter: true,
          source_event: "spawn_agent",
          verify_submit: false,
          beforeMutation: opts.assertSurfaceBindingCurrent,
        });
      };
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
          beforeMutation: opts.assertSurfaceBindingCurrent,
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
          onUpdateShellRelaunch: relaunchOriginalCommand,
        });
      }
    }, {
      toolName: "send_command",
      workspace: opts.workspace,
      observePtyWrite: true,
    });
  };

  const deliverBootPrompt = async (opts: {
    surface: string;
    workspace?: string;
    cli?: CliType;
    prompt?: string;
    boot_prompt_path?: string | null;
    timeout_ms?: number;
    onUpdateShellRelaunch?: () => Promise<void>;
    resolveRoute?: () => Promise<{ surface: string; workspace?: string }>;
  }): Promise<{
    bytes: number;
    retry_count: number;
    submit_verified: boolean | null;
    prompt_text: string | null;
    prompt_warning: string | null;
  }> => {
    const bootPromptPath = getBootPromptPath(opts.boot_prompt_path);
    assertBootPromptMode(opts.prompt, bootPromptPath);
    if (!hasInlinePrompt(opts.prompt) && !bootPromptPath) {
      return {
        bytes: 0,
        retry_count: 0,
        submit_verified: null,
        prompt_text: null,
        prompt_warning: null,
      };
    }

    let readiness = await waitForBootPromptReady({
      surface: opts.surface,
      workspace: opts.workspace,
      cli: opts.cli,
      timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
      onUpdateShellRelaunch: opts.onUpdateShellRelaunch,
      resolveRoute: opts.resolveRoute,
    });

    const rawPrompt = bootPromptPath
      ? await readFile(bootPromptPath, "utf8")
      : opts.prompt!;
    let deliveryRoute = opts.resolveRoute
      ? await opts.resolveRoute()
      : readiness.route;
    const sameRoute = (
      left: { surface: string; workspace?: string },
      right: { surface: string; workspace?: string },
    ): boolean =>
      left.surface === right.surface &&
      (left.workspace ?? null) === (right.workspace ?? null);
    if (!sameRoute(readiness.route, deliveryRoute)) {
      readiness = await waitForBootPromptReady({
        surface: deliveryRoute.surface,
        workspace: deliveryRoute.workspace,
        cli: opts.cli,
        timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
        onUpdateShellRelaunch: opts.onUpdateShellRelaunch,
        resolveRoute: opts.resolveRoute,
      });
      deliveryRoute = opts.resolveRoute
        ? await opts.resolveRoute()
        : readiness.route;
      if (!sameRoute(readiness.route, deliveryRoute)) {
        throw new Error(
          "Boot prompt route changed after readiness; refusing stale delivery",
        );
      }
    }
    const assertDeliveryRouteCurrent = opts.resolveRoute
      ? async (): Promise<void> => {
          const current = await opts.resolveRoute!();
          if (!sameRoute(deliveryRoute, current)) {
            throw new Error(
              "Boot prompt route changed during delivery; refusing to split prompt across terminals",
            );
          }
        }
      : undefined;
    const useFilePointer =
      Boolean(bootPromptPath) &&
      (/[\r\n]/.test(rawPrompt) || rawPrompt.length > SEND_INPUT_MAX_INLINE_CHARS);
    const promptWarning =
      bootPromptPath &&
      rawPrompt.length > BOOT_PROMPT_PATH_WARNING_CHARS &&
      !useFilePointer
        ? `boot_prompt_path is ${rawPrompt.length} characters; prefer a one-line file pointer for boot prompts over ${BOOT_PROMPT_PATH_WARNING_CHARS} characters`
        : null;
    const deliveryText = useFilePointer
      ? `Read and follow ${bootPromptPath}`
      : rawPrompt;
    const sanitizedText = sanitizeTerminalInput(deliveryText);
    const chunks =
      sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
        ? chunkTerminalInput(sanitizedText, SEND_INPUT_CHUNK_THRESHOLD)
        : [sanitizedText];
    let sentChunks = 0;

    try {
      const delivery = await withSurfaceWrite(
        deliveryRoute.surface,
        async () =>
          deliverInputChunks({
            surface: deliveryRoute.surface,
            workspace: deliveryRoute.workspace,
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
            beforeMutation: assertDeliveryRouteCurrent,
          }),
        {
          toolName: "boot_prompt",
          workspace: deliveryRoute.workspace,
          observePtyWrite: true,
        },
      );
      return {
        ...delivery,
        prompt_text: rawPrompt,
        prompt_warning: promptWarning,
      };
    } catch (error) {
      if (error instanceof SurfaceGoneError) {
        throw error;
      }
      if (error instanceof SubmitVerificationError) {
        await assertDeliveryRouteCurrent?.();
        const snapshot = await readParsedSurface(
          deliveryRoute.surface,
          deliveryRoute.workspace,
        );
        if (
          !snapshot ||
          !screenShowsPendingInput(snapshot.text, sanitizedText)
        ) {
          await waitForBootPromptSubmitEvidence({
            surface: deliveryRoute.surface,
            workspace: deliveryRoute.workspace,
            text: sanitizedText,
            timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
            baseline_metrics: readiness.metrics,
            beforeRead: assertDeliveryRouteCurrent,
          });
          return {
            bytes: Buffer.byteLength(sanitizedText, "utf8"),
            retry_count: error.retry_count,
            submit_verified: true,
            prompt_text: rawPrompt,
            prompt_warning: promptWarning,
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
      const normalized = candidate.trim();
      return (
        workspaces.find(
          (workspace) =>
            envWorkspaceMatches(workspace, candidate) ||
            workspace.title === normalized,
        )?.ref ?? candidate
      );
    } catch {
      return candidate;
    }
  };

  const callerWorkspaceStrict = async (): Promise<string | undefined> => {
    try {
      const { workspaces } = await client.listWorkspaces();
      const callerContext = currentCallerContext();
      const requestCandidates = [
        callerContext?.workspaceId,
        callerContext?.tabId,
      ].filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
      const envCandidates =
        requestCandidates.length > 0
          ? []
          : [process.env.CMUX_WORKSPACE_ID, process.env.CMUX_TAB_ID].filter(
              (value): value is string =>
                typeof value === "string" && value.trim().length > 0,
            );
      const candidates = [...requestCandidates, ...envCandidates];
      for (const candidate of candidates) {
        const match = workspaces.find((workspace) =>
          envWorkspaceMatches(workspace, candidate),
        );
        if (match) return match.ref;
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  /** Caller pane workspace ref first, then focused workspace as fallback. */
  const currentCallerWorkspace = async (): Promise<string | undefined> => {
    const callerWorkspace = await callerWorkspaceStrict();
    return callerWorkspace ?? (await currentFocusedWorkspace());
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

  const focusedWorkspaceFallbackWarning =
    "No explicit workspace, caller workspace, or repo workspace could be resolved; falling back to the currently focused workspace.";

  const resolvePlacementWorkspace = async (opts: {
    explicitWorkspace?: string;
    callerWorkspace?: string;
    repo?: string | null;
    allowFocusedFallback?: boolean;
  }): Promise<{ workspace?: string; warnings: string[] }> => {
    const explicitWorkspace = opts.explicitWorkspace
      ? await canonicalWorkspaceRef(opts.explicitWorkspace)
      : undefined;
    if (explicitWorkspace) return { workspace: explicitWorkspace, warnings: [] };

    const callerWorkspace = opts.callerWorkspace ?? (await callerWorkspaceStrict());
    if (callerWorkspace) return { workspace: callerWorkspace, warnings: [] };

    const repoWorkspace = await resolveWorkspaceForRepo(opts.repo);
    if (repoWorkspace) return { workspace: repoWorkspace, warnings: [] };

    if (opts.allowFocusedFallback === false) {
      return { workspace: undefined, warnings: [] };
    }

    const focusedWorkspace = await currentFocusedWorkspace();
    if (focusedWorkspace) {
      return {
        workspace: focusedWorkspace,
        warnings: [focusedWorkspaceFallbackWarning],
      };
    }

    return { workspace: undefined, warnings: [] };
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

  const surfaceObserverEpochProvider =
    (): SurfaceObserverIdProvider | undefined =>
      () => context.surfaceObserverEpoch;

  const assertSurfaceObserverEpochCurrent = (
    observerEpoch: SurfaceObserverEpoch,
    operation: string,
  ): void => {
    const provider = surfaceObserverEpochProvider();
    if (isSurfaceObserverEpochCurrent(observerEpoch, provider)) return;
    const currentObserverEpoch = captureObserverEpoch(provider);
    throw new Error(
      `Surface observer changed or became unavailable during ${operation} ` +
        `(${observerEpoch ?? "unknown"} -> ${currentObserverEpoch ?? "unknown"}); ` +
        `refusing to mutate a different cmux instance.`,
    );
  };

  const collectSurfaceTopology = async (workspace?: string) =>
    collectCmuxSurfaceTopology(
      client,
      workspace,
      surfaceObserverEpochProvider(),
    );

  const readScreenSnapshotKey = (opts: {
    surface: string;
    workspace?: string;
    lines?: number;
    scrollback?: boolean;
  }): string =>
    JSON.stringify([
      opts.surface,
      opts.workspace ?? null,
      opts.lines ?? null,
      opts.scrollback === true,
    ]);

  const readScreenSnapshot = async (opts: {
    surface: string;
    workspace?: string;
    lines?: number;
    scrollback?: boolean;
  }): Promise<ReadScreenSnapshot> => {
    const key = readScreenSnapshotKey(opts);
    const existing = context.readScreenInflight.get(key);
    if (existing) {
      return existing;
    }

    const snapshot = (async () => {
      const result = await client.readScreen(opts.surface, {
        workspace: opts.workspace,
        lines: opts.lines,
        scrollback: opts.scrollback,
      });
      const topology = await collectSurfaceTopology(opts.workspace);
      return { result, topology };
    })();
    context.readScreenInflight.set(key, snapshot);
    try {
      return await snapshot;
    } finally {
      if (context.readScreenInflight.get(key) === snapshot) {
        context.readScreenInflight.delete(key);
      }
    }
  };

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

  const resolveAuthorizedAgentSurfaceBinding = (
    agent: AgentRecord,
    topology: SurfaceTopologySnapshot | null,
  ) => {
    const binding = resolveAgentSurfaceBinding(agent, topology);
    if (!binding) return null;

    const observedUuid =
      topology?.surfaceIdByRef.get(binding.surfaceRef) ?? null;
    return context.lifecycleRegistry?.canUseObservedBinding(
      agent,
      observedUuid,
    ) === true
      ? binding
      : null;
  };

  const evaluateServerAgentHealth = async (
    agent: AgentRecord,
    overrides?: AgentHealthInputOverrides,
    topologyOverride?: SurfaceTopologySnapshot | null,
  ) => {
    const topology =
      topologyOverride === undefined
        ? await collectSurfaceTopology()
        : topologyOverride;
    const binding = resolveAuthorizedAgentSurfaceBinding(agent, topology);
    let parsedSurface: Awaited<ReturnType<typeof readParsedSurface>> = null;
    if (
      binding &&
      (overrides?.screen_status === undefined ||
        overrides?.screen_actions === undefined)
    ) {
      parsedSurface = await readParsedSurface(
        binding.surfaceRef,
        binding.workspaceId ?? undefined,
      );
    }
    const surfaceOverrides = healthTopologyOverrides(
      agent,
      binding ? topology : null,
    );
    const safeSurfaceOverrides: AgentHealthInputOverrides = {
      ...surfaceOverrides,
      screen_status: binding
        ? overrides?.screen_status !== undefined
          ? overrides.screen_status
          : (parsedSurface?.parsed.status ?? null)
        : null,
      screen_actions: binding
        ? overrides?.screen_actions !== undefined
          ? overrides.screen_actions
          : (parsedSurface?.parsed.actions ?? null)
        : null,
      surface_write_liveness: binding
        ? surfaceWriteLiveness.observe(binding.surfaceRef)
        : null,
    };
    const input = await buildAgentHealthInput(
      agent,
      {
        inboxOpts,
        monitorMaxAgeMs: INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS,
        dispatchAckTimeoutMs: AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
        assessHarvestability: (target) =>
          lifecycleHealthEngine?.assessHarvestability(target),
        resolveCollapsedMonitors: (ownerSeats) => {
          if (!opts?.monitorRegistryPath) return [];
          const owners = new Set(ownerSeats);
          return readMonitorRegistry(monitorRegistryOptions()).monitors
            .filter(
              (monitor) =>
                monitor.state === "collapsed" &&
                owners.has(monitor.owner_seat),
            )
            .map((monitor) => ({
              monitor_id: monitor.monitor_id,
              reason: monitor.collapsed_reason ?? "unknown",
            }));
        },
      },
      {
        ...overrides,
        ...safeSurfaceOverrides,
      },
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
    if (surface.has_agent) {
      issueCodes.push("auto_discovered_agent");
      issues.push(
        "live agent surface has no managed registry seat; repair/register the seat or leave it visible as an unresolved orphan",
      );
    }
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
    const topology = await collectSurfaceTopology();
    const binding = resolveAuthorizedAgentSurfaceBinding(agent, topology);
    const screen = binding
      ? await readParsedSurface(
          binding.surfaceRef,
          binding.workspaceId ?? undefined,
        )
      : null;
    const health = await evaluateServerAgentHealth(
      agent,
      {
        screen_status: screen?.parsed.status ?? null,
        screen_actions: screen?.parsed.actions ?? null,
      },
      topology,
    );
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
        const staleWarning = staleBuildWarning();
        const healthWithStale = staleWarning
          ? { ...health, warnings: [...health.warnings, staleWarning] }
          : health;
        return okFormatted(formatControlHealth(healthWithStale), {
          health: healthWithStale,
        });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "register_monitor",
    "Register or re-arm a shared monitor-registry deadman record. Offset-poll monitors require a watermark_key; fired monitor ids cannot be reused.",
    RegisterMonitorArgsSchema,
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const inputOrError = validateRegisterMonitorArgs(args);
        if (isToolReturn(inputOrError)) {
          return inputOrError;
        }
        const existing = readMonitorRegistry(monitorRegistryOptions()).monitors.find(
          (record) => record.monitor_id === inputOrError.monitor_id,
        );
        if (existing?.state === "deadman-fired") {
          return monitorRegistryError(
            "cannot-rearm-fired-monitor-id",
            inputOrError.monitor_id,
            "cannot re-arm a fired monitor_id; use a new id",
          );
        }
        const record = await registerMonitor(
          inputOrError,
          monitorRegistryOptions(),
        );
        return ok({ record });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/cannot re-arm a fired monitor_id/i.test(message)) {
          return monitorRegistryError(
            "cannot-rearm-fired-monitor-id",
            nonEmptyString(args.monitor_id),
            message,
          );
        }
        return err(e);
      }
    },
  );

  server.tool(
    "signal_monitor",
    "Signal a registered monitor's liveness heartbeat by updating last_signal_at.",
    MonitorIdArgsSchema,
    ANNOTATIONS.idempotentMutating,
    async (args) => {
      try {
        const monitorId = nonEmptyString(args.monitor_id);
        if (!monitorId) {
          return monitorRegistryError("missing-monitor-id", null);
        }
        const record = await signalMonitor(monitorId, monitorRegistryOptions());
        if (!record) {
          return monitorRegistryError(
            "monitor-id-absent-or-not-alive",
            monitorId,
            `Monitor not found or not alive: ${monitorId}`,
          );
        }
        return ok({ record });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "deregister_monitor",
    "Mark a monitor as intentionally stopped so later signals do not revive it.",
    MonitorIdArgsSchema,
    ANNOTATIONS.idempotentMutating,
    async (args) => {
      try {
        const monitorId = nonEmptyString(args.monitor_id);
        if (!monitorId) {
          return monitorRegistryError("missing-monitor-id", null);
        }
        const record = await deregisterMonitor(
          monitorId,
          monitorRegistryOptions(),
        );
        if (!record) {
          return monitorRegistryError(
            "monitor-id-absent",
            monitorId,
            `Monitor not found: ${monitorId}`,
          );
        }
        return ok({ record });
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "list_monitors",
    "List monitor-registry records, optionally filtering by gate, owner_seat, or monitor id.",
    QueryMonitorRegistryArgsSchema,
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        return queryMonitorRegistryTool(args, "list_monitors");
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "query_monitor_registry",
    "Query the monitor registry for gate-9/gate-10 pass/fire verdicts and monitor metadata.",
    QueryMonitorRegistryArgsSchema,
    ANNOTATIONS.readOnly,
    async (args) => {
      try {
        return queryMonitorRegistryTool(args, "query_monitor_registry");
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

  // Deferred layout/UI tool: keep beside create_workspace so the thin-core
  // palette classifies both workspace-management tools together off-default.
  const deleteWorkspaceTool = server.tool(
    "delete_workspace",
    "Delete a whole workspace tab and all of its panes/surfaces. SAFETY: refuses a workspace that backs a live agent, or the caller's own workspace, unless force:true. Refusals include the current surfaces and agents for verification.",
    {
      workspace: z.string().describe("Target workspace ref"),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Delete even when the workspace backs a live agent or is the caller's workspace.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const targetWorkspace =
          (await canonicalWorkspaceRef(args.workspace)) ?? args.workspace;
        await assertWorkspaceMutationAllowed(
          "delete_workspace",
          targetWorkspace,
        );

        const [{ workspaces }, panes] = await Promise.all([
          client.listWorkspaces(),
          client.listPanes({ workspace: targetWorkspace }),
        ]);
        const paneGroups = await Promise.all(
          panes.panes.map((pane) =>
            client.listPaneSurfaces({
              workspace: targetWorkspace,
              pane: pane.ref,
            }),
          ),
        );
        const surfaces = paneGroups
          .flatMap((group) => group.surfaces)
          .filter(
            (surface, index, all) =>
              all.findIndex((candidate) => candidate.ref === surface.ref) ===
              index,
          );
        const surfaceRefs = new Set(surfaces.map((surface) => surface.ref));
        const agents = stateMgr
          .listStates()
          .filter(
            (agent) =>
              surfaceRefs.has(agent.surface_id) ||
              agent.workspace_id === targetWorkspace,
          );
        const liveAgents = agents.filter(
          (agent) => !TERMINAL_AGENT_STATES.has(agent.state),
        );
        const callerWorkspace = await currentCallerWorkspace();
        const deletingCallerWorkspace = callerWorkspace === targetWorkspace;

        if (
          !args.force &&
          (deletingCallerWorkspace || liveAgents.length > 0)
        ) {
          const reasons = [
            ...(deletingCallerWorkspace ? ["it is the caller workspace"] : []),
            ...(liveAgents.length > 0
              ? [`it backs ${liveAgents.length} live agent(s)`]
              : []),
          ];
          return err(
            new Error(
              `Refused to delete ${targetWorkspace}: ${reasons.join(" and ")}. Pass force:true to delete anyway.`,
            ),
            {
              refused: true,
              workspace: targetWorkspace,
              caller_workspace: deletingCallerWorkspace,
              surfaces,
              agents,
              live_agents: liveAgents,
            },
          );
        }

        await client.deleteWorkspace(targetWorkspace);
        const removedWorkspace =
          workspaces.find((workspace) => workspace.ref === targetWorkspace) ?? {
            ref: targetWorkspace,
          };
        const data = {
          workspace: targetWorkspace,
          force: args.force ?? false,
          removed: {
            workspaces: [removedWorkspace],
            surfaces,
          },
        };
        return okFormatted(formatOk("delete_workspace", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );
  deleteWorkspaceTool.update({
    _meta: {
      defer_loading: true,
      "cmuxlayer/interim": true,
    },
  });

  // 2. new_split
  server.tool(
    "new_split",
    "Create a new split pane (terminal or browser). PLACEMENT IS BY ROLE, NOT BY HAND: pass `role` (or let it infer from the launcher title) and the layout policy enforces the two-column invariant — leads/orchestrators land in the LEFT column, workers land in the RIGHT column, and extra workers dock as tabs in the rightmost worker pane (never a third column). Workspace-targeted splits auto-focus the target before splitting and restore your prior focus after the new pane renders, so you do not hand-run focus-pane around splits. For terminal panes that boot an agent, boot_prompt_path safely submits multiline or over-cap files as one `Read and follow <path>` pointer after the agent reaches a ready prompt.",
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
          "Optional readable prompt-file path. Checked before pane creation. Multiline or over-cap files are delivered as one `Read and follow <path>` pointer after readiness; shorter files retain direct delivery. Mutually exclusive with inline prompt fields.",
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
        if (bootPromptPath) {
          if ((args.type ?? "terminal") !== "terminal") {
            throw new Error(
              "boot_prompt_path is only supported for terminal surfaces",
            );
          }
          await preflightBootPromptFile(bootPromptPath);
        }
        const rolePlacementObserverEpoch =
          inferredRole && (args.type ?? "terminal") === "terminal"
            ? captureObserverEpoch(surfaceObserverEpochProvider())
            : undefined;
        if (inferredRole && (args.type ?? "terminal") === "terminal") {
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
        }
        const targetResolution =
          args.pane || args.surface
            ? {
                workspace: args.workspace,
                warnings: [],
              }
            : await resolvePlacementWorkspace({
                explicitWorkspace: args.workspace,
                repo: inferRepoFromLauncherTitle(args.title),
              });
        if (inferredRole && (args.type ?? "terminal") === "terminal") {
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
        }
        const targetWorkspace = targetResolution.workspace;
        if (args.surface) {
          await assertSurfaceMutationAllowed("new_split", args.surface);
        } else if (targetWorkspace) {
          await assertWorkspaceMutationAllowed("new_split", targetWorkspace);
        }

        // Auto-focus only applies to workspace-targeted splits (no explicit
        // pane/surface anchor). Captured right before creation, AFTER all
        // validation, so a rejected request has no focus side effects.
        let priorFocus: string | null = null;
        let actualPlacement: "split" | "surface" = "split";
        let actualDirection: string | null = args.direction;
        if (inferredRole && (args.type ?? "terminal") === "terminal") {
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
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
          const surfaceObservation = buildSurfaceBindingObservation(
            panes.panes,
            paneSurfaces,
          );
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
          const liveSurfaceIds = surfaceObservation.liveSurfaceRefs;
          const placement = chooseAgentSpawnPlacement(
            panes.panes,
            paneSurfaces,
            collectServerRoleSurfaceIds(
              liveSurfaceIds,
              targetWorkspace,
              surfaceObservation,
            ),
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
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
          priorFocus = await focusTargetBeforeSplit(targetWorkspace);
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
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
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
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
            surfaceUuid: result.surface_id ?? null,
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
                    relaunch: true,
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
        if (targetResolution.warnings.length > 0) {
          data.warnings = targetResolution.warnings;
        }
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
    "Create a new surface (tab) in an existing pane. For terminal tabs that boot an agent, boot_prompt_path safely submits multiline or over-cap files as one `Read and follow <path>` pointer after the agent reaches a ready prompt.",
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
          "Optional readable prompt-file path. Checked before tab creation. Multiline or over-cap files are delivered as one `Read and follow <path>` pointer after readiness; shorter files retain direct delivery.",
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
                    relaunch: true,
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

  // 5. send_input
  server.tool(
    "send_input",
    `Low-level surface tool: send text input to a terminal surface. For tracked agents, prefer send_to(agent_id) so cmuxlayer resolves the current backing surface. WARNING — DO NOT include a bare \`@word\` (e.g. \`@narration-lead\`) in text destined for an interactive agent composer (Claude Code / Codex / Cursor TUIs): the receiving composer treats \`@\` as its file-reference trigger and pops a file-picker overlay, swallowing the rest of your message — silent delivery corruption that the ok:true result will NOT report. Use the bare name (\`narration-lead:\`) for pane-to-pane addressing; reserve \`@<name>\` for collab-file posts where monitors match it. If a literal \`@\` is unavoidable, deliver via a file the agent cat-reads, not live keystrokes. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters by default (CMUXLAYER_MAX_INLINE_CHARS, positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}); tracked Codex/Claude/Cursor/Gemini agents also refuse multi-paragraph inline text by default. Write the payload to a file and send one line: "Read and follow <path>". Pass allow_long_inline:true only for deliberate raw sends. Text over ${SEND_INPUT_CHUNK_THRESHOLD} characters that is allowed is automatically chunked into line-aligned batches before delivery, and each chunk waits for cmux acknowledgment before the next is sent. Chunked or multiline text is pasted into the composer so embedded newlines do not submit partial messages; press_enter=true presses return once after the final chunk. Paste failure returns an error without pressing Return. Set background=true to return immediately with a delivery_id while chunking continues in the background. For full commands, prefer send_command so text and return land on the same surface atomically.`,
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
          "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
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
        const effectiveChunkSize = Math.min(
          args.chunk_size,
          SEND_INPUT_PASTE_BATCH_MAX_BYTES,
        );
        const chunks =
          sanitizedText.length > SEND_INPUT_CHUNK_THRESHOLD
            ? limitInputChunksByUtf8ByteSize(
                chunkTerminalInput(sanitizedText, effectiveChunkSize),
              )
            : [sanitizedText];
        const targetRecord = resolveLatestSurfaceAgentRecord(
          stateMgr,
          args.surface,
        );
        assertInteractiveMultilineInputAllowed({
          tool: "send_input",
          value: args.text,
          cli: targetRecord?.cli,
          allowLongInline: args.allow_long_inline,
        });
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
            chunk_size: effectiveChunkSize,
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
          return deliverInputChunks({
            surface: args.surface,
            workspace: args.workspace,
            chunks,
            chunk_size: effectiveChunkSize,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: args.press_enter,
            rename_to_task: args.rename_to_task,
            source_event: "send_input",
            verify_submit: shouldVerifySubmit,
          });
        }, {
          toolName: "send_input",
          workspace: args.workspace,
          observePtyWrite: true,
        });

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
    `Atomically send a command and press return on the same raw surface. Prefer this over separate send_input + send_key calls when launching or resuming agents. If the user provided an exact command, send exactly that command only when it fits the ${SEND_INPUT_MAX_INLINE_CHARS}-character inline cap. WARNING — never include a bare \`@word\` in text destined for an interactive agent composer: it fires the receiver's file-reference picker and corrupts delivery (use the bare name; \`@<name>\` belongs in collab files, not pane keystrokes). For known agent launchers with -s (for example brainlayerCodex -s), boot_prompt_path is checked before launch and safely submits multiline or over-cap files as one \`Read and follow <path>\` pointer after readiness; use it instead of embedding a multi-paragraph boot prompt in pane keystrokes. Passing boot_prompt_path for plain shell commands is rejected. Pass allow_long_inline:true only for deliberate raw long commands.`,
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
          "Optional readable prompt-file path for launcher commands matching <repo>Codex|Claude|Cursor|Gemini|Kiro with -s. Checked before launch; multiline or over-cap files are submitted as one `Read and follow <path>` pointer after readiness.",
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
        }, {
          toolName: "send_command",
          workspace: args.workspace,
          observePtyWrite: true,
        });

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
                relaunch: true,
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
          boot_prompt_warning: bootPromptDelivery?.prompt_warning ?? null,
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
        }, {
          toolName: "send_key",
          workspace: args.workspace,
          observePtyWrite: true,
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
        const { result, topology } = await readScreenSnapshot({
          surface: args.surface,
          workspace: args.workspace,
          lines: args.lines,
          scrollback: args.scrollback,
        });
        const title = topology?.titleBySurface.get(result.surface) ?? null;
        const { column, column_count } =
          topology?.topologyBySurface.get(result.surface) ??
          EMPTY_SURFACE_TOPOLOGY;
        const parsed = applyHarnessState(
          enrichParsedScreen(
            parseScreen(result.text),
            result.text,
            pickLatestSurfaceModel(stateMgr, result.surface),
          ),
          resolveHarnessStateForSurface(stateMgr, result.surface),
        );

        if (args.parsed_only) {
          const data = {
            surface: result.surface,
            title,
            column,
            column_count,
            parsed,
            delivery: getSurfaceDelivery(result.surface),
          };
          const formatted = formatReadScreen(
            result.surface,
            title,
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
            title,
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
            title,
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
          title,
          column,
          column_count,
          parsed,
          ...(screenPreview ? { screen_preview: screenPreview } : {}),
          delivery: getSurfaceDelivery(result.surface),
        };
        const formatted = formatReadScreen(
          result.surface,
          title,
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
        await lifecycleSeatManifestPublisher({
          surfaceId: args.surface,
          tabName: finalTitle,
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
    let lastLifecycleSurfaceObserverEpoch: string | null = null;
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
          const groups = partitionPaneSurfacesByMembership(paneList, rawGroups, {
            workspace_ref: panes.workspace_ref ?? ref,
            window_ref: panes.window_ref,
          });
          if (!isPaneSurfaceEnumerationComplete(paneList, groups)) {
            throw new SurfaceEnumerationError(
              `Incomplete cmux surface enumeration for ${ref}`,
            );
          }
          return groups;
        }),
      );
      const surfaceGroups = surfaceGroupsByWorkspace.flat();
      return enrichSurfaceIdsFromPanes(panesByWorkspace, surfaceGroups);
    };
    const surfaceProvider = async () => {
      const observerEpoch = context.surfaceObserverEpoch;
      if (
        lastLifecycleSurfaces &&
        (!observerEpoch ||
          lastLifecycleSurfaceObserverEpoch !== observerEpoch)
      ) {
        lastLifecycleSurfaces = null;
        lastLifecycleSurfaceObserverEpoch = null;
      }
      try {
        const surfaces = await readLifecycleSurfaces();
        const completedObserverEpoch = context.surfaceObserverEpoch;
        if (completedObserverEpoch !== observerEpoch) {
          lastLifecycleSurfaces = null;
          lastLifecycleSurfaceObserverEpoch = null;
          throw new SurfaceEnumerationError(
            `cmux surface observer changed during enumeration (${observerEpoch ?? "unknown"} -> ${completedObserverEpoch ?? "unknown"})`,
          );
        }
        if (observerEpoch) {
          lastLifecycleSurfaces = surfaces;
          lastLifecycleSurfaceObserverEpoch = observerEpoch;
        } else {
          lastLifecycleSurfaces = null;
          lastLifecycleSurfaceObserverEpoch = null;
        }
        return surfaces;
      } catch (error) {
        if (!isSurfaceEnumerationError(error)) {
          throw error;
        }
        const completedObserverEpoch = context.surfaceObserverEpoch;
        if (completedObserverEpoch !== observerEpoch) {
          lastLifecycleSurfaces = null;
          lastLifecycleSurfaceObserverEpoch = null;
          throw error;
        }
        if (
          observerEpoch &&
          lastLifecycleSurfaces &&
          lastLifecycleSurfaceObserverEpoch === observerEpoch
        ) {
          return lastLifecycleSurfaces;
        }
        if (!registry || registry.list().length === 0) {
          return [];
        }
        throw error;
      }
    };
    registry =
      context.lifecycleRegistry ??
      new AgentRegistry(
        stateMgr,
        surfaceProvider,
        {
          observerIdProvider: () => context.surfaceObserverId,
          observerEpochProvider: () => context.surfaceObserverEpoch,
        },
      );
    context.lifecycleRegistry = registry;
    const discovery = new AgentDiscovery({
      observerIdProvider: () => context.surfaceObserverEpoch,
      listSurfaces: surfaceProvider,
      readScreen: (surface, opts) => client.readScreen(surface, opts),
    });
    const awaitLifecycleStart = async (): Promise<void> => {
      if (context.lifecycleStartPromise) {
        await context.lifecycleStartPromise;
      }
    };
    const notifyLifecycleEvent = async (
      event: AgentLifecycleEvent,
      agent: AgentRecord,
      healthSummary?: string,
    ): Promise<void> => {
      if (!enableClaudeChannels) {
        return;
      }
      if (!server.server.transport) {
        throw new Error("Claude channel transport is not connected yet");
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
          setStatuses: async (updates) => {
            if (typeof client.setStatuses === "function") {
              return client.setStatuses(updates);
            }
            for (const update of updates) {
              await client.setStatus(update.key, update.value, update);
            }
            return true;
          },
          clearStatus: (key, clearOpts) => client.clearStatus(key, clearOpts),
          readScreen: (surface, readOpts) =>
            client.readScreen(surface, readOpts),
          send: (surface, text, sendOpts) => {
            const { beforeMutation, ...clientOpts } = sendOpts ?? {};
            return withSurfaceWrite(
              surface,
              async () => {
                await beforeMutation?.();
                return client.send(surface, text, clientOpts);
              },
              {
                toolName: "agent_engine",
                workspace: sendOpts?.workspace,
                observePtyWrite: true,
              },
            );
          },
          sendKey: (surface, key, keyOpts) => {
            const { beforeMutation, ...clientOpts } = keyOpts ?? {};
            return withSurfaceWrite(
              surface,
              async () => {
                await beforeMutation?.();
                return client.sendKey(surface, key, clientOpts);
              },
              {
                toolName: "send_key",
                workspace: keyOpts?.workspace,
                observePtyWrite: true,
              },
            );
          },
          setProgress: (value, progressOpts) =>
            client.setProgress(value, progressOpts),
          clearProgress: (progressOpts) => client.clearProgress(progressOpts),
          newSplit: async (direction, splitOpts) => {
            await assertWorkspaceMutationAllowed(
              "agent_engine",
              splitOpts?.workspace,
            );
            return client.newSplit(direction, splitOpts);
          },
          newSurface: async (surfaceOpts) => {
            await assertWorkspaceMutationAllowed(
              "agent_engine",
              surfaceOpts?.workspace,
            );
            return client.newSurface(surfaceOpts);
          },
          renameTab: async (surface, title, renameOpts) => {
            await assertSurfaceMutationAllowed(
              "agent_engine",
              surface,
              renameOpts?.workspace,
            );
            return typeof client.renameTab === "function"
              ? client.renameTab(surface, title, renameOpts)
              : undefined;
          },
          selectWorkspace: async (workspace) => {
            await assertWorkspaceMutationAllowed("agent_engine", workspace);
            return client.selectWorkspace(workspace);
          },
          listPanes: (paneOpts) => client.listPanes(paneOpts),
          listPaneSurfaces: (surfaceOpts) =>
            client.listPaneSurfaces(surfaceOpts),
          closeSurface: (surface, closeOpts) => {
            const { beforeMutation, ...clientOpts } = closeOpts ?? {};
            return withSurfaceWrite(
              surface,
              async () => {
                await beforeMutation?.();
                const result = await client.closeSurface(surface, clientOpts);
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
            );
          },
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
          launchCommandSender: async ({
            surface,
            workspace,
            command,
            assertSurfaceBindingCurrent,
          }) => {
            originalLaunchCommandsBySurface.set(surface, command);
            try {
              await sendLauncherCommandToSurface({
                surface,
                workspace,
                command,
                assertSurfaceBindingCurrent,
              });
            } catch (error) {
              originalLaunchCommandsBySurface.delete(surface);
              throw error;
            }
          },
          beforeCrashRecoveryMutation: async ({
            phase,
            surface,
            workspace,
          }) => {
            if (phase === "placement") {
              await assertWorkspaceMutationAllowed(
                "agent_engine",
                workspace,
              );
              return;
            }
            if (!surface) {
              throw new Error(
                "Crash recovery resume mutation requires a surface route",
              );
            }
            await assertSurfaceMutationAllowed(
              "agent_engine",
              surface,
              workspace,
            );
          },
          outboxDrain: opts?.outboxDrain,
          monitorRegistryPath: opts?.monitorRegistryPath,
          monitorRegistryNow: opts?.monitorRegistryNow,
          monitorRegistryNotify: opts?.monitorRegistryNotify,
          closeForensicsRunner: opts?.enableCloseForensics
            ? createDefaultCloseForensicsRunner({
                stateMgr,
                listSurfacesForRefMap: surfaceProvider,
              })
            : null,
          seatRegistry,
          seatRegistryPath: opts?.seatRegistryPath,
          fleetSidebarPublisher: opts?.fleetSidebarPublisher,
        },
      );
    lifecycleSeatManifestPublisher = async (input) => {
      try {
        const existing = input.agentId
          ? engine.getAgentState(input.agentId)
          : registry.list().find(
              (record) => record.surface_id === input.surfaceId,
            ) ?? null;
        if (!existing) return;

        const updated =
          input.tabName !== undefined || input.model !== undefined
            ? stateMgr.updateRecord(existing.agent_id, {
                ...(input.tabName !== undefined
                  ? { tab_name: input.tabName }
                  : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
              })
            : existing;
        if (updated !== existing) {
          registry.set(updated.agent_id, updated);
        }

        const tabName =
          updated.tab_name ??
          `${updated.launcher_name ?? launcherNameForCli(updated.repo, updated.cli)} [${updated.surface_id}]`;
        await seatManifestWriter({
          surface_id: updated.surface_id,
          ...(updated.surface_uuid
            ? { surface_uuid: updated.surface_uuid }
            : {}),
          agent_id: updated.agent_id,
          tab_name: tabName,
          session_name: updated.cli_session_id,
          model: updated.model,
          permission_mode:
            updated.cli === "kiro" ? "default" : "skip-permissions",
          cwd:
            updated.launch_cwd ?? join(homedir(), "Gits", updated.repo),
          repo: updated.repo,
          cli: updated.cli,
          updated_at: seatManifestNow(),
        });
      } catch (error) {
        console.error(
          "[cmuxlayer] seat manifest publish failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    context.lifecycleSweepEngine = engine;
    lifecycleHealthEngine = engine;
    lifecycleEnsureRegistered = async () => {
      await awaitLifecycleStart();
      await engine.runLifecycleMutation(() =>
        registry.listMerged(discovery, { force: true }).then(() => undefined),
      );
    };
    lifecycleRefreshManagedMetadata = async (agentId?: string) => {
      await awaitLifecycleStart();
      await engine.runLifecycleMutation(() =>
        registry
          .refreshManagedSurfaceMetadata(discovery, {
            agentId,
            force: true,
          })
          .then(() => undefined),
      );
    };

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

    const resolveManagedDeliveryRoute = async (
      agentId: string,
    ): Promise<{ surface: string; workspace?: string }> => {
      const route = await engine.resolveAgentIoRoute(agentId);
      return {
        surface: route.surface_id,
        workspace: route.workspace_id ?? undefined,
      };
    };

    const relaunchSpawnAgentAfterUpdate = async (opts: {
      agentId: string;
      surface: string;
      workspace?: string;
      model?: string | null;
      mcpEnv?: string;
      originalCommand?: string;
    }): Promise<void> => {
      const record = resolveSpawnRecord(opts.agentId, opts.surface);
      if (!record) {
        throw new Error(
          `Cannot relaunch ${opts.agentId} after CLI update: agent record not found`,
        );
      }

      const launchCwd = record.launch_cwd?.trim() || undefined;
      const launcherName = record.launcher_name?.trim() || undefined;
      const command =
        opts.originalCommand ??
        buildLaunchCommand(
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
      const route = await resolveManagedDeliveryRoute(record.agent_id);
      const assertSurfaceBindingCurrent = async (): Promise<void> => {
        const current = await resolveManagedDeliveryRoute(record.agent_id);
        if (
          current.surface !== route.surface ||
          (current.workspace ?? null) !== (route.workspace ?? null)
        ) {
          throw new Error(
            `Agent "${record.agent_id}" surface route changed during ` +
              `post-update relaunch; refusing terminal mutation.`,
          );
        }
      };
      await sendLauncherCommandToSurface({
        surface: route.surface,
        workspace: route.workspace,
        command,
        relaunch: true,
        assertSurfaceBindingCurrent,
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
      let route = await engine.resolveAgentIoRoute(args.agent_id);
      const requiresMutableRefGuards = !route.surface_uuid;
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
      if (
        requiresMutableRefGuards &&
        isPositivelyStale(await liveSurfaceRefs(), route.surface_id)
      ) {
        discovery.invalidate();
        await registry.listMerged(discovery, { force: true });
        // Re-resolve after the resync. The agent may have been evicted (its
        // surface vanished) or still point at a dead surface — either way,
        // refuse with a clear stale-ref error instead of misdelivering.
        let reresolved: typeof route | null;
        try {
          reresolved = await engine.resolveAgentIoRoute(args.agent_id);
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
      if (requiresMutableRefGuards && expectedCli) {
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
          // on it alone would false-refuse a healthy relay.
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
      const routeSurfaceAlive =
        route.state === "error" &&
        (await registry.isSurfaceAlive(route, {
          ptyDead:
            surfaceWriteLiveness.observe(route.surface_id)?.pty_dead === true,
        }));
      if (
        !args.allow_busy &&
        !INTERACTIVE_AGENT_STATES.has(route.state) &&
        !routeSurfaceAlive
      ) {
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

      // All validation above can await. Establish the delivery binding only
      // after those gates, then prove the exact UUID/ref/workspace pair again
      // immediately before every chunk attempt and Return. Once any text has
      // landed, following a moved UUID would split one logical message across
      // terminals, so route changes fail closed instead.
      route = await engine.resolveAgentIoRoute(args.agent_id);
      const deliveryRoute = route;
      const assertDeliveryRouteCurrent = async (): Promise<void> => {
        const current = await engine.resolveAgentIoRoute(args.agent_id);
        if (
          current.surface_id !== deliveryRoute.surface_id ||
          (current.surface_uuid ?? null) !==
            (deliveryRoute.surface_uuid ?? null) ||
          (current.workspace_id ?? null) !==
            (deliveryRoute.workspace_id ?? null)
        ) {
          throw new Error(
            `Agent "${args.agent_id}" surface route changed during terminal ` +
              `delivery; refusing to continue on another surface.`,
          );
        }
      };

      return withSurfaceWrite(
        deliveryRoute.surface_id,
        async () => {
          return deliverInputChunks({
            surface: deliveryRoute.surface_id,
            workspace: deliveryRoute.workspace_id ?? undefined,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: args.press_enter,
            source_event: args.source_event,
            source_agent: args.agent_id,
            // Verify every relay to an interactive agent — not just long ones.
            // A short relay (the common agent-to-agent case) to a frozen
            // terminal must be caught, never reported as ok. allow_busy sends
            // are deliberate queue/interjection writes and stay unverified to
            // avoid false-failing accepted queued input.
            verify_submit:
              args.press_enter &&
              !args.allow_busy &&
              INTERACTIVE_AGENT_STATES.has(deliveryRoute.state),
            allow_recovery_enter_retry: !args.allow_busy,
            beforeMutation: assertDeliveryRouteCurrent,
          });
        },
        {
          toolName: args.source_event,
          workspace: deliveryRoute.workspace_id ?? undefined,
          observePtyWrite: true,
        },
      );
    };
    // Expose the guarded relay to dispatch_to_agent's nudge (registered above,
    // outside this lifecycle block).
    lifecycleAgentInputDeliverer = deliverAgentInput;

    // Reconstitute and discover live surfaces before the first sidebar paint.
    // The engine initializer is idempotent because daemon connections share a
    // context and may construct more than one MCP server over its lifetime.
    if (!context.lifecycleStarted) {
      context.lifecycleStarted = true;
      context.lifecycleStartPromise = engine
        .initialize(discovery)
        .catch((e) =>
          console.error("[cmuxlayer] lifecycle initialization failed:", e),
        )
        .then(() => {
          if (
            context.lifecycleStarted &&
            context.lifecycleSweepEngine === engine
          ) {
            engine.startSweep(resolveSweepTiming());
          }
        });
    }
    // The daemon may immediately use this relay for monitor recovery. Publish
    // it only after persisted lifecycle state has been reconstituted so route
    // resolution is ready, then wake any boot-time recovery claim.
    void (context.lifecycleStartPromise ?? Promise.resolve()).then(() => {
      if (context.lifecycleStarted && context.lifecycleSweepEngine === engine) {
        context.setLifecycleAgentInputDeliverer(deliverAgentInput);
      }
    });

    // 11. spawn_agent
    server.tool(
      "spawn_agent",
      `Spawn a managed AI agent in a terminal surface and return an agent_id plus lean routing and delivery evidence by default; pass verbose:true for the full legacy response including informational health and bookkeeping. For collabs, call list_agents/get_agent_state first and reuse or supersede a viable existing agent instead of spawning a duplicate lane. Unless workspace is explicitly provided, the new agent should land in the caller/current workspace; workers should land in the right worker pane by role. Use send_to and wait_for with the returned agent_id instead of remembering the created surface. If prompt or boot_prompt_path is provided, waits for the agent ready prompt, submits that boot instruction, and returns after submission evidence; submission is not proof of task completion or healthy lifecycle state. Multi-paragraph inline prompts are refused for interactive agents unless allow_long_inline:true. Prefer boot_prompt_path: it is checked before spawning and safely submits multiline or over-cap files as one \`Read and follow <path>\` pointer after readiness. Without a boot prompt, returns immediately and wait_for can be used separately.`,
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
            "Optional readable prompt-file path. Checked before spawning; multiline or over-cap files are submitted as one `Read and follow <path>` pointer and one final return after readiness. Mutually exclusive with prompt.",
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
        placement: z
          .enum(["orchestrator", "ic", "worker"])
          .optional()
          .describe(
            "Canonical role-driven placement. role remains accepted as a compatibility spelling.",
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
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Return the full legacy spawn response instead of the lean default.",
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
          assertInteractiveMultilineInputAllowed({
            tool: "spawn_agent",
            value: args.prompt,
            cli: args.cli,
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
          const targetResolution = await resolvePlacementWorkspace({
            explicitWorkspace: args.workspace,
            callerWorkspace: parentWorkspace,
            repo: args.repo,
          });
          const spawnWorkspace = targetResolution.workspace;
          const comparisonWorkspace = spawnWorkspace ?? parentWorkspace;
          await assertWorkspaceMutationAllowed("spawn_agent", comparisonWorkspace);
          const worktree = await prepareSpawnWorktree(
            args.repo,
            args.worktree,
            args.mcp_profile as McpProfile | undefined,
          );
          const effectiveRole = args.placement ?? args.role;
          const requestedRole = inferAgentRole({
            role: effectiveRole,
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
            role: effectiveRole,
            auto_archive_on_done: args.auto_archive_on_done ?? false,
            max_cost_per_agent: args.max_cost_per_agent,
            crash_recover: args.crash_recover,
          });
          const originalLaunchCommand = originalLaunchCommandsBySurface.get(
            result.surface_id,
          );
          originalLaunchCommandsBySurface.delete(result.surface_id);
          appendStaleBuildWarning(result);
          if (targetResolution.warnings.length > 0) {
            result.warnings = [
              ...(result.warnings ?? []),
              ...targetResolution.warnings,
            ];
          }

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
                resolveRoute: () =>
                  resolveManagedDeliveryRoute(result.agent_id),
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
                    originalCommand: originalLaunchCommand,
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
          await lifecycleSeatManifestPublisher({
            agentId: result.agent_id,
          });
          const currentAgent = engine.getAgentState(result.agent_id);
          const role =
            currentAgent?.role ??
            inferAgentRole({
              role: effectiveRole,
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
                topology,
              )
            : undefined;

          const formattedData = {
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
            };
          const responseData = {
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
            };
          return buildSpawnToolReturn(
            {
              retry_count: currentTransportRetryCount(),
              ...responseData,
            },
            args.verbose,
            formatOk("spawn_agent", formattedData),
          );
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SurfaceGoneError) {
            return err(e, surfaceGonePayload(e));
          }
          return err(e);
        }
      },
    );

    server.tool(
      "new_worktree_split",
      "Create or reuse a git worktree and spawn one worker agent into a right-side cmux split. Returns a lean response by default; pass verbose:true for the full legacy health and worktree bookkeeping. Defaults to inherited MCPs and preserves the existing worker layout policy.",
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
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Return the full legacy spawn response instead of the lean default.",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          assertBootPromptMode(args.prompt, null);
          await refreshManagedMetadataBestEffort(args.parent_agent_id);
          const parentWorkspace = args.parent_agent_id
            ? (engine.getAgentState(args.parent_agent_id)?.workspace_id ??
              undefined)
            : undefined;
          const targetResolution = await resolvePlacementWorkspace({
            explicitWorkspace: args.workspace,
            callerWorkspace: parentWorkspace,
            repo: args.repo,
          });
          const mutationWorkspace = targetResolution.workspace;
          await assertWorkspaceMutationAllowed(
            "new_worktree_split",
            mutationWorkspace,
          );
          const priorFocus = await focusTargetBeforeSplit(mutationWorkspace);
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
            workspace: mutationWorkspace,
            cwd: worktree.prepared?.path,
            mcp_env: worktree.mcpEnv,
            mcp_profile_label: worktree.mcpProfileLabel,
            worktree_branch: worktree.prepared?.branch,
            parent_agent_id: args.parent_agent_id,
            role: "worker",
            auto_archive_on_done: args.auto_archive_on_done ?? false,
            crash_recover: args.crash_recover,
          });
          const originalLaunchCommand = originalLaunchCommandsBySurface.get(
            result.surface_id,
          );
          originalLaunchCommandsBySurface.delete(result.surface_id);
          appendStaleBuildWarning(result);
          if (targetResolution.warnings.length > 0) {
            result.warnings = [
              ...(result.warnings ?? []),
              ...targetResolution.warnings,
            ];
          }

          let bootPromptDelivery:
            | Awaited<ReturnType<typeof deliverBootPrompt>>
            | undefined;
          if (hasPrompt) {
            const deliveryWorkspace = spawnDeliveryWorkspace(
              result,
              mutationWorkspace,
            );
            bootPromptDelivery = await deliverBootPrompt({
              surface: result.surface_id,
              workspace: deliveryWorkspace,
              resolveRoute: () => resolveManagedDeliveryRoute(result.agent_id),
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
                  originalCommand: originalLaunchCommand,
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
            spawnDeliveryWorkspace(result, mutationWorkspace),
          );
          await refreshManagedMetadataBestEffort(result.agent_id);
          await lifecycleSeatManifestPublisher({
            agentId: result.agent_id,
          });
          const currentAgent = engine.getAgentState(result.agent_id);
          const topology = currentAgent ? await collectSurfaceTopology() : null;
          const health = currentAgent
            ? await evaluateServerAgentHealth(
                agentForSpawnHealth(currentAgent, result),
                {
                  ...healthTopologyOverrides(currentAgent, topology),
                },
                topology,
              )
            : undefined;

          const formattedData = {
              agent_id: result.agent_id,
              surface: result.surface_id,
              worktree: worktree.prepared?.path ?? "",
              mcp_profile: worktree.mcpProfileLabel ?? "inherit",
              health,
            };
          const responseData = {
              ...result,
              role: "worker",
              health,
              worktree: worktree.prepared,
              mcp_profile: worktree.mcpProfileLabel ?? "inherit",
              boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
              boot_prompt_bytes: bootPromptDelivery?.bytes,
              boot_prompt_submit_verified:
                bootPromptDelivery?.submit_verified ?? null,
            };
          return buildSpawnToolReturn(
            {
              retry_count: currentTransportRetryCount(),
              ...responseData,
            },
            args.verbose,
            formatOk("new_worktree_split", formattedData),
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
      "Create a workspace and spawn a set of agents into it as a clean 2-pane grid (commanders LEFT, workers RIGHT). Returns lean per-agent responses by default; pass verbose:true for the full legacy response. Handles workspace creation, selection, and role-based pane placement atomically. Use this instead of repeated spawn_agent calls when standing up a multi-agent team.",
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
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Return the full legacy spawn response instead of the lean default.",
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
          const leanSpawnedAgents: Record<string, unknown>[] = [];

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
            const originalLaunchCommand = originalLaunchCommandsBySurface.get(
              result.surface_id,
            );
            originalLaunchCommandsBySurface.delete(result.surface_id);
            appendStaleBuildWarning(result);
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
                resolveRoute: () =>
                  resolveManagedDeliveryRoute(result.agent_id),
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
                    originalCommand: originalLaunchCommand,
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
                  topology,
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
            leanSpawnedAgents.push(
              shapeSpawnResponse({
                ...result,
                role,
                health,
                boot_prompt_delivered: hasPrompt
                  ? isBootPromptDelivered(bootPromptDelivery)
                  : false,
                boot_prompt_submit_verified: hasPrompt
                  ? (bootPromptDelivery?.submit_verified ?? null)
                  : null,
              }),
            );
          }

          const lastSurface =
            spawnedAgents[spawnedAgents.length - 1]?.surface_id;
          await restoreFocusAfterRender(priorFocus, lastSurface, workspace);

          // spawn_in_workspace builds its response from the per-agent objects,
          // which drop each result.warnings — so surface the stale-build warning
          // at the aggregate level (otherwise a stale MCP serving a multi-agent
          // workspace spawn would return NO warning).
          const staleWarning = staleBuildWarning();
          const workspaceWarnings = staleWarning ? [staleWarning] : [];

          const formattedData = {
              workspace,
              agents: spawnedAgents.length,
              ...(staleWarning ? { warning: staleWarning } : {}),
            };
          const responseData = {
              workspace,
              title: workspaceResult.title,
              agents: spawnedAgents,
              ...(workspaceWarnings.length > 0
                ? { warnings: workspaceWarnings }
                : {}),
            };
          return buildSpawnToolReturn(
            {
              retry_count: currentTransportRetryCount(),
              ...responseData,
            },
            args.verbose,
            formatOk("spawn_in_workspace", formattedData),
            {
              workspace,
              title: workspaceResult.title,
              agents: leanSpawnedAgents,
              ...(workspaceWarnings.length > 0
                ? { warnings: workspaceWarnings }
                : {}),
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
      "Block until one agent_id or every agent in ids reaches a target registry state and return health. Defaults to waiting for completion (`done`).",
      {
        agent_id: z.string().optional().describe("Single agent ID from spawn_agent"),
        ids: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Agent IDs to wait for together"),
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
          if (args.ids) {
            const results = await engine.waitForAll(
              args.ids,
              targetState,
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
                  ? await evaluateServerAgentHealth(
                      resultAgent,
                      {
                        ...healthTopologyOverrides(resultAgent, topology),
                      },
                      topology,
                    )
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
              formatOk("wait_for", {
                count: results.length,
                target: targetState,
              }),
              { results: enrichedResults },
            );
          }
          if (!args.agent_id) {
            throw new Error("wait_for requires agent_id or ids");
          }
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
            ? await evaluateServerAgentHealth(
                resultAgent,
                {
                  ...healthTopologyOverrides(resultAgent, topology),
                },
                topology,
              )
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
                ? await evaluateServerAgentHealth(
                    resultAgent,
                    {
                      ...healthTopologyOverrides(resultAgent, topology),
                    },
                    topology,
                  )
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
          const health = await evaluateServerAgentHealth(
            state,
            {
              ...healthTopologyOverrides(state, topology),
              harvestability,
            },
            topology,
          );
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
              const health = await evaluateServerAgentHealth(
                agent,
                {
                  ...healthTopologyOverrides(agent, topology),
                },
                topology,
              );
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
          await awaitLifecycleStart();
          const merged = await engine.runLifecycleMutation(() =>
            registry.listMerged(discovery, { filter }),
          );
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

    const resolveBroadcastCallerRefs = async (): Promise<Set<string>> => {
      const refs = new Set<string>();
      const add = (value: string | undefined): void => {
        const trimmed = value?.trim();
        if (trimmed) refs.add(trimmed);
      };
      add(process.env.CMUX_AGENT_ID);
      add(process.env.CMUX_TAB_ID);
      add(process.env.CMUX_SURFACE_ID);

      for (const surface of [process.env.CMUX_SURFACE_ID, process.env.CMUX_TAB_ID]) {
        if (!surface?.trim()) continue;
        try {
          const identified = await client.identify(surface.trim());
          add(identified.caller?.surface_ref);
          add(identified.focused?.surface_ref);
        } catch {
          // Caller identity is best-effort. Explicit env refs above still apply.
        }
      }
      return refs;
    };

    const broadcastSkipReason = async (
      agent: AgentRecord,
    ): Promise<string | null> => {
      if (agent.state === "error") {
        let livenessTarget: Pick<
          AgentRecord,
          "surface_id" | "surface_uuid"
        > = agent;
        try {
          livenessTarget = await engine.resolveAgentIoRoute(agent.agent_id);
        } catch {
          // Preserve the existing registry/PTY liveness semantics when no
          // fresh I/O route can be established.
        }
        if (
          await registry.isSurfaceAlive(livenessTarget, {
            ptyDead:
              surfaceWriteLiveness.observe(livenessTarget.surface_id)
                ?.pty_dead === true,
          })
        ) {
          return null;
        }
      }
      if (TERMINAL_AGENT_STATES.has(agent.state)) {
        return `dead:${agent.state}`;
      }
      if (!INTERACTIVE_AGENT_STATES.has(agent.state)) {
        return `not_interactive:${agent.state}`;
      }
      return null;
    };

    const agentSeatLabel = (agent: AgentRecord): string =>
      agent.seat_id?.trim() ||
      agent.surface_id ||
      agent.agent_id;

    server.tool(
      "broadcast",
      `Fan out a short pointer-style message to registered agents by role using the same guarded delivery path as send_to. Defaults to role=leads (orchestrator + ic). Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters; for larger payloads write a file and broadcast "Read and follow <path>". Returns per-agent receipts so one failed target never hides the rest.`,
      {
        text: BroadcastArgsSchema.shape.text.describe(
          `Message to broadcast. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters; write larger payloads to a file and broadcast "Read and follow <path>".`,
        ),
        role: BroadcastArgsSchema.shape.role.describe(
          "Target role set: leads means orchestrator + ic; workers means worker; all means every registered agent.",
        ),
        exclude: BroadcastArgsSchema.shape.exclude.describe(
          "Agent IDs to skip in addition to the caller's own agent.",
        ),
        workspace: BroadcastArgsSchema.shape.workspace.describe(
          "Optional workspace ref/id to scope targets. Omit to broadcast across all workspaces.",
        ),
        press_enter: BroadcastArgsSchema.shape.press_enter.describe(
          "Press enter after sending the text to each target.",
        ),
      },
      ANNOTATIONS.mutating,
      async (rawArgs) => {
        try {
          await awaitLifecycleStart();
          const parsedArgs = BroadcastArgsSchema.safeParse(rawArgs);
          if (!parsedArgs.success) {
            return err(
              new Error(formatToolValidationError("broadcast", parsedArgs.error)),
            );
          }
          const args = parsedArgs.data;
          assertBroadcastInlineInputAllowed(args.text);

          const scopedWorkspace = await canonicalWorkspaceRef(args.workspace);
          const excludedAgentIds = new Set(args.exclude);
          const callerRefs = await resolveBroadcastCallerRefs();
          const workspaceMatches = (agent: AgentRecord): boolean =>
            !scopedWorkspace ||
            agent.workspace_id === scopedWorkspace ||
            agent.workspace_id === args.workspace;
          const isCaller = (agent: AgentRecord): boolean =>
            callerRefs.has(agent.agent_id) || callerRefs.has(agent.surface_id);

          const collectTargets = async (): Promise<AgentRecord[]> => {
            try {
              return await engine.runLifecycleMutation(async () => {
                try {
                  return await registry.listMerged(discovery);
                } catch (error) {
                  if (
                    !(error instanceof SurfaceBindingChangedDuringDiscoveryError)
                  ) {
                    throw error;
                  }
                  // The first scan's screen evidence was correctly rejected.
                  // Retry once from the now-current topology; a second move
                  // still propagates and fails the broadcast closed.
                  discovery.invalidate();
                  return registry.listMerged(discovery, { force: true });
                }
              });
            } catch (e) {
              if (isSurfaceEnumerationError(e)) {
                throw new Error(
                  `Refusing broadcast because live surface enumeration failed: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                );
              }
              throw e;
            }
          };

          const targets = (await collectTargets()).filter(
            (agent) =>
              broadcastRoleMatches(args.role, inferBroadcastRecordRole(agent)) &&
              workspaceMatches(agent) &&
              !excludedAgentIds.has(agent.agent_id) &&
              !isCaller(agent),
          );

          const receipts: BroadcastReceipt[] = [];
          for (const agent of targets) {
            const skipped = await broadcastSkipReason(agent);
            if (skipped) {
              receipts.push({
                agent_id: agent.agent_id,
                seat: agentSeatLabel(agent),
                delivered: false,
                submit_verified: null,
                skipped,
              });
              continue;
            }

            try {
              const delivery = await deliverAgentInput({
                agent_id: agent.agent_id,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
              });
              receipts.push({
                agent_id: agent.agent_id,
                seat: agentSeatLabel(agent),
                delivered: true,
                submit_verified: delivery.submit_verified,
              });
            } catch (e) {
              receipts.push({
                agent_id: agent.agent_id,
                seat: agentSeatLabel(agent),
                delivered: false,
                submit_verified:
                  e instanceof SubmitVerificationError
                    ? false
                    : e instanceof DeliverySafetyGateError
                      ? e.submit_verified
                      : null,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }

          const deliveredCount = receipts.filter(
            (receipt) => receipt.delivered,
          ).length;
          const skippedCount = receipts.filter(
            (receipt) => receipt.skipped,
          ).length;
          const failedCount = receipts.length - deliveredCount - skippedCount;
          const data = {
            role: args.role,
            target_count: receipts.length,
            delivered_count: deliveredCount,
            failed_count: failedCount,
            skipped_count: skippedCount,
            receipts: receipts as unknown as Record<string, unknown>[],
          };
          return okFormatted(
            `broadcast ${args.role}: ${deliveredCount} delivered, ${failedCount} failed, ${skippedCount} skipped`,
            data,
          );
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
        await awaitLifecycleStart();
        return engine.runLifecycleMutation(async () => {
          try {
            const beforeIds = new Set(
              registry.list().map((agent) => agent.agent_id),
            );
            const surfaceAbsenceConfirmation = {
              confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
            };
            await registry.reconcile(surfaceAbsenceConfirmation);
            for (const agent of registry.list()) {
              beforeIds.add(agent.agent_id);
            }
            discovery.invalidate();
            const discoveredBeforeRepair = await discovery.scan(true);
            const repair = registry.repairFromDiscovery(discoveredBeforeRepair, {
              seatRegistry,
            });
            discovery.invalidate();
            await registry.listMerged(discovery, { force: true });
            const surfacelessEvicted = await registry.evictSurfaceless(
              surfaceAbsenceConfirmation,
            );
            engine.evictDeadProcessAgents();
            discovery.invalidate();
            let after = await registry.listMerged(discovery, { force: true });
            const reflowObserverEpoch = captureObserverEpoch(
              surfaceObserverEpochProvider(),
            );
            const topologyBeforeReflow = await collectSurfaceTopology();
            const topologyIsCoherent = (
              topology: SurfaceTopologySnapshot | null,
            ): topology is SurfaceTopologySnapshot => {
              const surfaceCount = topology?.workspaceBySurface.size ?? 0;
              const uuidCount = topology?.surfaceIdByRef.size ?? 0;
              return (
                topology?.complete === true &&
                surfaceCount > 0 &&
                (uuidCount === 0 || uuidCount === surfaceCount)
              );
            };
            const topologyBeforeReflowIsCoherent = topologyIsCoherent(
              topologyBeforeReflow,
            );
            const reflowed: Array<{
              agent_id: string;
              surface_id: string;
              from_column: number;
              to_column: number;
              pane: string;
            }> = [];
            type ReflowOperation =
              | "new_split"
              | "move_surface"
              | "verify_reflow"
              | "close_surface";
            const reflowSkipped: Array<{
              agent_id: string;
              surface_id: string;
              operation: ReflowOperation;
              reason: string;
            }> = [];
            const recordReflowSkip = (
              agent: AgentRecord,
              surfaceId: string,
              operation: ReflowOperation,
              error: unknown,
            ): void => {
              reflowSkipped.push({
                agent_id: agent.agent_id,
                surface_id: surfaceId,
                operation,
                reason: error instanceof Error ? error.message : String(error),
              });
            };
            const resolveFreshReflowBinding = async (
              agent: AgentRecord,
              expectedSurfaceRef: string,
              expectedWorkspace: string,
              operation: ReflowOperation,
            ) => {
              assertSurfaceObserverEpochCurrent(
                reflowObserverEpoch,
                `resync_agents ${operation}`,
              );
              const topology = await collectSurfaceTopology();
              assertSurfaceObserverEpochCurrent(
                reflowObserverEpoch,
                `resync_agents ${operation}`,
              );
              if (!topologyIsCoherent(topology)) {
                throw new Error(
                  `Fresh topology is incomplete before ${operation}; refusing reflow mutation.`,
                );
              }
              const binding = resolveAgentSurfaceBinding(agent, topology);
              if (!binding) {
                throw new Error(
                  `Stable surface UUID ${agent.surface_uuid ?? "unavailable"} is not uniquely bound before ${operation}; refusing reflow mutation.`,
                );
              }
              const observedUuid =
                topology.surfaceIdByRef.get(binding.surfaceRef) ?? null;
              if (!registry.canUseObservedBinding(agent, observedUuid)) {
                throw new Error(
                  `Fresh binding ${binding.surfaceRef} is not owned by the current observer before ${operation}; refusing reflow mutation.`,
                );
              }
              const workspace =
                topology.workspaceBySurface.get(binding.surfaceRef) ??
                binding.workspaceId;
              if (
                binding.surfaceRef !== expectedSurfaceRef ||
                workspace !== expectedWorkspace
              ) {
                throw new Error(
                  `Surface binding changed before ${operation} ` +
                    `(${expectedSurfaceRef}@${expectedWorkspace} -> ` +
                    `${binding.surfaceRef}@${workspace ?? "unknown"}); refusing to mutate a recycled ref.`,
                );
              }
              const current = topology.topologyBySurface.get(binding.surfaceRef);
              if (current?.column !== 0) {
                throw new Error(
                  `Stable surface UUID ${agent.surface_uuid ?? "unavailable"} no longer needs left-column reflow before ${operation}.`,
                );
              }
              return { binding, current, topology, workspace };
            };

            if (topologyBeforeReflow && topologyBeforeReflowIsCoherent) {
              const panesByWorkspace = new Map<
                string,
                Awaited<ReturnType<typeof client.listPanes>>
              >();

              for (const agent of after) {
                if (inferRecordRoleOrNull(agent) !== "worker") continue;
                const binding = resolveAgentSurfaceBinding(
                  agent,
                  topologyBeforeReflow,
                );
                if (!binding) continue;
                const observedUuid =
                  topologyBeforeReflow.surfaceIdByRef.get(binding.surfaceRef) ??
                  null;
                if (!registry.canUseObservedBinding(agent, observedUuid)) {
                  continue;
                }
                const liveSurfaceRef = binding.surfaceRef;
                const current = topologyBeforeReflow.topologyBySurface.get(
                  liveSurfaceRef,
                );
                if (current?.column !== 0) continue;

                let seededSurface: string | null = null;
                let seededSurfaceUuid: string | null = null;
                let workspace: string | null = null;
                let attemptedOperation: ReflowOperation =
                  (current.column_count ?? 0) < 2
                    ? "new_split"
                    : "move_surface";
                try {
                  workspace =
                    topologyBeforeReflow.workspaceBySurface.get(
                      liveSurfaceRef,
                    ) ?? agent.workspace_id ?? null;
                  if (!workspace) continue;

                  let targetPane: string | null = null;
                  if ((current.column_count ?? 0) < 2) {
                    attemptedOperation = "new_split";
                    await resolveFreshReflowBinding(
                      agent,
                      liveSurfaceRef,
                      workspace,
                      attemptedOperation,
                    );
                    await assertWorkspaceMutationAllowed(
                      "new_split",
                      workspace,
                    );
                    await withSurfaceWrite(
                      liveSurfaceRef,
                      async () => {
                        const immediate = await resolveFreshReflowBinding(
                          agent,
                          liveSurfaceRef,
                          workspace!,
                          attemptedOperation,
                        );
                        await assertWorkspaceMutationAllowed(
                          "new_split",
                          immediate.workspace ?? workspace!,
                        );
                        assertSurfaceObserverEpochCurrent(
                          reflowObserverEpoch,
                          "resync_agents new_split",
                        );
                        const seed = await client.newSplit("right", {
                          workspace: immediate.workspace,
                          surface: immediate.binding.surfaceRef,
                          type: "terminal",
                        });
                        seededSurface = seed.surface;
                        seededSurfaceUuid = seed.surface_id ?? null;
                        targetPane = seed.pane;
                        assertSurfaceObserverEpochCurrent(
                          reflowObserverEpoch,
                          "resync_agents new_split",
                        );
                      },
                      {
                        owner: `resync-reflow:new_split:${agent.agent_id}`,
                      },
                    );
                    panesByWorkspace.delete(workspace);
                  } else {
                    assertSurfaceObserverEpochCurrent(
                      reflowObserverEpoch,
                      "resync_agents move_surface pane selection",
                    );
                    let panes = panesByWorkspace.get(workspace);
                    if (!panes) {
                      panes = await client.listPanes({ workspace });
                      panesByWorkspace.set(workspace, panes);
                    }
                    assertSurfaceObserverEpochCurrent(
                      reflowObserverEpoch,
                      "resync_agents move_surface pane selection",
                    );
                    const columns = deriveColumnIndex(panes.panes);
                    targetPane = [...panes.panes]
                      .filter((pane) => (columns.get(pane.ref) ?? 0) > 0)
                      .sort((a, b) => {
                        const columnDelta =
                          (columns.get(a.ref) ?? 0) -
                          (columns.get(b.ref) ?? 0);
                        return columnDelta || a.index - b.index;
                      })
                      .at(-1)?.ref ?? null;
                  }
                  if (!targetPane) continue;

                  attemptedOperation = "move_surface";
                  const freshBeforeMove = await resolveFreshReflowBinding(
                    agent,
                    liveSurfaceRef,
                    workspace,
                    attemptedOperation,
                  );
                  await withSurfaceWrite(
                    freshBeforeMove.binding.surfaceRef,
                    async () => {
                      const immediate = await resolveFreshReflowBinding(
                        agent,
                        liveSurfaceRef,
                        workspace!,
                        attemptedOperation,
                      );
                      await assertSurfaceMutationAllowed(
                        "move_surface",
                        immediate.binding.surfaceRef,
                        immediate.workspace ?? workspace!,
                      );
                      assertSurfaceObserverEpochCurrent(
                        reflowObserverEpoch,
                        "resync_agents move_surface",
                      );
                      await client.moveSurface({
                        surface: immediate.binding.surfaceRef,
                        pane: targetPane!,
                        workspace: immediate.workspace,
                        focus: false,
                      });
                      assertSurfaceObserverEpochCurrent(
                        reflowObserverEpoch,
                        "resync_agents move_surface",
                      );
                    },
                    {
                      toolName: "move_surface",
                      workspace: freshBeforeMove.workspace ?? workspace,
                      owner: `resync-reflow:move_surface:${agent.agent_id}`,
                    },
                  );
                  panesByWorkspace.delete(workspace);

                  attemptedOperation = "verify_reflow";
                  const topologyAfterMove = await collectSurfaceTopology(workspace);
                  assertSurfaceObserverEpochCurrent(
                    reflowObserverEpoch,
                    "resync_agents verify_reflow",
                  );
                  if (!topologyIsCoherent(topologyAfterMove)) {
                    throw new Error(
                      "Post-move topology is incomplete; reflow could not be verified.",
                    );
                  }
                  const bindingAfterMove = resolveAgentSurfaceBinding(
                    agent,
                    topologyAfterMove,
                  );
                  if (!bindingAfterMove) {
                    throw new Error(
                      "Post-move stable UUID binding is unavailable; reflow could not be verified.",
                    );
                  }
                  const actual = topologyAfterMove.topologyBySurface.get(
                    bindingAfterMove.surfaceRef,
                  );
                  if (actual?.column == null || actual.column === 0) {
                    throw new Error(
                      "Post-move topology still places the worker in column 0.",
                    );
                  }

                  reflowed.push({
                    agent_id: agent.agent_id,
                    surface_id: bindingAfterMove.surfaceRef,
                    from_column: current.column,
                    to_column: actual.column,
                    pane: targetPane,
                  });
                } catch (error) {
                  // Reflow is self-healing best effort. One stale workspace, pane,
                  // or topology read must not abort the registry-wide resync.
                  recordReflowSkip(
                    agent,
                    liveSurfaceRef,
                    attemptedOperation,
                    error,
                  );
                } finally {
                  if (seededSurface) {
                    try {
                      const cleanupSeedUuid = seededSurfaceUuid as string | null;
                      assertSurfaceObserverEpochCurrent(
                        reflowObserverEpoch,
                        "resync_agents close_surface",
                      );
                      if (!cleanupSeedUuid) {
                        throw new Error(
                          `Seed ${seededSurface} has no stable UUID; refusing cleanup by mutable ref.`,
                        );
                      }
                      const cleanupTopology = await collectSurfaceTopology();
                      assertSurfaceObserverEpochCurrent(
                        reflowObserverEpoch,
                        "resync_agents close_surface",
                      );
                      if (!topologyIsCoherent(cleanupTopology)) {
                        throw new Error(
                          "Fresh topology is incomplete before seed cleanup; refusing close_surface.",
                        );
                      }
                      const seedUuidKey = cleanupSeedUuid.toLowerCase();
                      const freshSeedRef = [...cleanupTopology.surfaceRefById]
                        .find(([surfaceUuid]) =>
                          surfaceUuid.toLowerCase() === seedUuidKey,
                        )?.[1];
                      if (!freshSeedRef) {
                        throw new Error(
                          `Seed UUID ${cleanupSeedUuid} is no longer uniquely bound; refusing close_surface.`,
                        );
                      }
                      const cleanupWorkspace =
                        cleanupTopology.workspaceBySurface.get(freshSeedRef) ??
                        workspace ??
                        undefined;
                      await withSurfaceWrite(
                        freshSeedRef,
                        async () => {
                          const immediateTopology =
                            await collectSurfaceTopology();
                          assertSurfaceObserverEpochCurrent(
                            reflowObserverEpoch,
                            "resync_agents close_surface",
                          );
                          if (!topologyIsCoherent(immediateTopology)) {
                            throw new Error(
                              "Immediate topology is incomplete before seed cleanup; refusing close_surface.",
                            );
                          }
                          const immediateSeedRef = [
                            ...immediateTopology.surfaceRefById,
                          ].find(([surfaceUuid]) =>
                            surfaceUuid.toLowerCase() === seedUuidKey,
                          )?.[1];
                          if (immediateSeedRef !== freshSeedRef) {
                            throw new Error(
                              `Seed binding changed before close_surface (${freshSeedRef} -> ${immediateSeedRef ?? "missing"}); refusing to close a recycled ref.`,
                            );
                          }
                          const immediateCleanupWorkspace =
                            immediateTopology.workspaceBySurface.get(
                              freshSeedRef,
                            ) ?? cleanupWorkspace;
                          await assertSurfaceMutationAllowed(
                            "close_surface",
                            freshSeedRef,
                            immediateCleanupWorkspace,
                          );
                          assertSurfaceObserverEpochCurrent(
                            reflowObserverEpoch,
                            "resync_agents close_surface",
                          );
                          await client.closeSurface(freshSeedRef, {
                            ...(immediateCleanupWorkspace
                              ? { workspace: immediateCleanupWorkspace }
                              : {}),
                          });
                          assertSurfaceObserverEpochCurrent(
                            reflowObserverEpoch,
                            "resync_agents close_surface",
                          );
                        },
                        {
                          toolName: "close_surface",
                          workspace: cleanupWorkspace,
                          owner: `resync-reflow:close_surface:${agent.agent_id}`,
                        },
                      );
                    } catch (error) {
                      // A seed cleanup race is isolated to this worker as well.
                      recordReflowSkip(
                        agent,
                        seededSurface,
                        "close_surface",
                        error,
                      );
                    }
                  }
                }
              }
            }

            if (reflowed.length > 0) {
              discovery.invalidate();
              after = await registry.listMerged(discovery, { force: true });
            }
            const discovered = await discovery.scan();
            const afterIds = new Set(after.map((agent) => agent.agent_id));
            const managedSurfaceIds = new Set(
              registry
                .list()
                .filter((agent) => !agent.agent_id.startsWith("auto-"))
                .map((agent) => agent.surface_id),
            );
            const orphanedSurfaces = discovered.filter(
              (surface) =>
                !surface.read_error &&
                !managedSurfaceIds.has(surface.surface_id),
            );
            const orphanedHealth = orphanedSurfaces.map(buildOrphanSurfaceHealth);
            const evicted = [
              ...new Set([
                ...repair.evicted,
                ...surfacelessEvicted,
                ...[...beforeIds].filter((id) => !afterIds.has(id)),
              ]),
            ];
            const diff = {
              added: [...afterIds].filter((id) => !beforeIds.has(id)),
              evicted,
              repaired: repair.repaired,
              reflowed,
              reflow_skipped: reflowSkipped,
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
        });
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
          await engine.stopAgent(args.agent_id, args.force, {
            beforeSurfaceMutation: (route) =>
              assertSurfaceMutationAllowed(
                "stop_agent",
                route.surface_id,
                route.workspace_id ?? undefined,
              ),
          });
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
      `Unified send path. mode=agent (default) routes by agent_id without exposing surface details; mode=surface writes text to a raw surface; mode=command atomically sends a command and Return; mode=key sends one normalized key. Raw-surface modes accept target or surface directly and deliberately do not require a healthy agent registry, preserving the fleet recovery escape hatch. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters by default; use file-backed boot_prompt_path for launcher prompts or allow_long_inline:true only for deliberate raw sends.`,
      {
        ...SendToArgsSchema.shape,
        text: SendToArgsSchema.shape.text.describe(
          `Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default; for large payloads write a file and send "Read and follow <path>" instead.`,
        ),
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "If true, bypass the lifecycle-state gate so a working agent can receive an interjection. Picker/menu and permission-prompt safety gates still refuse text; use mode=key for deliberate menu driving.",
        ),
        allow_long_inline: SendToArgsSchema.shape.allow_long_inline.describe(
          "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
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
          const mode = args.mode ?? "agent";
          if (mode !== "agent") {
            const surface = args.surface ?? args.target;
            if (!surface) {
              throw new Error(
                `send_to mode=${mode} requires target or surface`,
              );
            }
            const legacyHandler = (name: string) => {
              const handler = toolHandlersByName.get(name);
              if (!handler) {
                throw new Error(`Internal tool handler unavailable: ${name}`);
              }
              return handler;
            };
            if (mode === "surface") {
              if (args.text === undefined) {
                throw new Error("send_to mode=surface requires text");
              }
              return legacyHandler("send_input")(
                {
                  surface,
                  workspace: args.workspace,
                  text: args.text,
                  chunk_size: args.chunk_size,
                  background: args.background,
                  press_enter: args.press_enter,
                  rename_to_task: args.rename_to_task,
                  allow_long_inline: args.allow_long_inline,
                },
                {},
              );
            }
            if (mode === "command") {
              const command = args.command ?? args.text;
              if (command === undefined) {
                throw new Error("send_to mode=command requires command or text");
              }
              return legacyHandler("send_command")(
                {
                  surface,
                  workspace: args.workspace,
                  command,
                  boot_prompt_path: args.boot_prompt_path,
                  boot_prompt_timeout_ms: args.boot_prompt_timeout_ms,
                  allow_long_inline: args.allow_long_inline,
                },
                {},
              );
            }
            if (!args.key) {
              throw new Error("send_to mode=key requires key");
            }
            return legacyHandler("send_key")(
              { surface, workspace: args.workspace, key: args.key },
              {},
            );
          }

          const agentId = args.agent_id ?? args.target;
          if (!agentId) {
            throw new Error("send_to mode=agent requires agent_id or target");
          }
          if (args.text === undefined) {
            throw new Error("send_to mode=agent requires text");
          }
          assertInlineInputAllowed({
            tool: "send_to",
            arg: "text",
            value: args.text,
            allowLongInline: args.allow_long_inline,
          });
          const targetAgent =
            engine.getAgentState(agentId) ?? registry.get(agentId);
          assertInteractiveMultilineInputAllowed({
            tool: "send_to",
            value: args.text,
            cli: targetAgent?.cli,
            allowLongInline: args.allow_long_inline,
          });
          const delivery = await deliverAgentInput({
            agent_id: agentId,
            text: args.text,
            press_enter: args.press_enter,
            allow_busy: args.allow_busy,
            source_event: "send_to",
          });
          const evidence = await collectDeliveryEvidence(agentId);
          const data = {
            agent_id: agentId,
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
          "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
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
          const agentId = args.agent_id ?? args.target;
          if (!agentId || args.text === undefined) {
            throw new Error("send_to_agent requires agent_id and text");
          }
          assertInlineInputAllowed({
            tool: "send_to_agent",
            arg: "text",
            value: args.text,
            allowLongInline: args.allow_long_inline,
          });
          const targetAgent =
            engine.getAgentState(agentId) ?? registry.get(agentId);
          assertInteractiveMultilineInputAllowed({
            tool: "send_to_agent",
            value: args.text,
            cli: targetAgent?.cli,
            allowLongInline: args.allow_long_inline,
          });
          const delivery = await deliverAgentInput({
            agent_id: agentId,
            text: args.text,
            press_enter: args.press_enter,
            allow_busy: args.allow_busy,
            source_event: "send_to_agent",
          });
          const evidence = await collectDeliveryEvidence(agentId);
          const data = {
            agent_id: agentId,
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
              const route = await engine.resolveAgentIoRoute(args.agent);
              await withSurfaceWrite(
                route.surface_id,
                () =>
                  client.sendKey(route.surface_id, "c-c", {
                    workspace: route.workspace_id ?? undefined,
                  }),
                {
                  toolName: "interact",
                  workspace: route.workspace_id ?? undefined,
                  observePtyWrite: true,
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
              await lifecycleSeatManifestPublisher({
                agentId: args.agent,
                model: args.model,
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
              const route = await engine.resolveAgentIoRoute(args.agent);
              const screen = await client.readScreen(route.surface_id, {
                workspace: route.workspace_id ?? undefined,
                lines: 5,
              });
              return ok({
                agent_id: args.agent,
                action: "usage",
                surface_id: route.surface_id,
                screen_tail: screen.text,
              });
            }
            case "mcp": {
              // Read screen for MCP server status
              const route = await engine.resolveAgentIoRoute(args.agent);
              const mcpScreen = await client.readScreen(route.surface_id, {
                workspace: route.workspace_id ?? undefined,
                lines: 10,
              });
              return ok({
                agent_id: args.agent,
                action: "mcp",
                surface_id: route.surface_id,
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
    const registeredInteract = (server as any)._registeredTools["interact"];
    if (registeredInteract) {
      registeredInteract._engine = engine;
    }

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
              await engine.stopAgent(agentId, args.force, {
                beforeSurfaceMutation: (route) =>
                  assertSurfaceMutationAllowed(
                    "kill",
                    route.surface_id,
                    route.workspace_id ?? undefined,
                  ),
              });
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
          await awaitLifecycleStart();
          const merged = await engine.runLifecycleMutation(() =>
            registry.listMerged(discovery),
          );
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
          const topology = await collectSurfaceTopology().catch(() => null);

          const SCREEN_TIMEOUT = 3000;
          const enriched = await Promise.all(
            agents.map(async (agent) => {
              let screenData: ParsedScreenResult | null = null;
              let liveSurfaceId: string | null = null;
              let screenFailure:
                | {
                    screen_unavailable: true;
                    error_code: "screen_unavailable";
                    screen_error: string;
                  }
                | null = null;
              try {
                const resolved = await Promise.race([
                  (async () => {
                    const binding = resolveAuthorizedAgentSurfaceBinding(
                      agent,
                      topology,
                    );
                    if (!binding) {
                      throw new Error(
                        `No authorized live surface binding for ${agent.agent_id}`,
                      );
                    }
                    const route = {
                      surface_id: binding.surfaceRef,
                      workspace_id: binding.workspaceId,
                    };
                    const screen = await client.readScreen(route.surface_id, {
                      lines: 20,
                      workspace: route.workspace_id ?? undefined,
                    });
                    return { route, screen };
                  })(),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () => reject(new Error("timeout")),
                      SCREEN_TIMEOUT,
                    ),
                  ),
                ]);
                liveSurfaceId = resolved.route.surface_id;
                const screen = resolved.screen;
                screenData = applyHarnessState(
                  enrichParsedScreen(
                    parseScreen(screen.text),
                    screen.text,
                    pickLatestSurfaceModel(stateMgr, liveSurfaceId),
                  ),
                  resolveHarnessStateForSurface(stateMgr, liveSurfaceId),
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
                surface_id: liveSurfaceId,
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

  if (palette) {
    palette.warnAboutUnknownTools();
    rawTool(
      "expand_palette",
      "Register the tools deferred by CMUXLAYER_DEFAULT_PALETTE for this MCP session",
      {},
      ANNOTATIONS.idempotentMutating,
      async () =>
        withTransportRetryTracking(async () => {
          const sendToolListChanged = server.sendToolListChanged;
          server.sendToolListChanged = () => {};
          let expansion;
          try {
            expansion = palette.expand(rawTool);
          } finally {
            server.sendToolListChanged = sendToolListChanged;
          }
          if (expansion.expanded) {
            server.sendToolListChanged();
          }
          return ok({ ...expansion });
        }),
    );
  } else {
    // The hardcoded thin-core cut is the default. A configured per-session
    // palette supersedes it above and controls residency until expansion.
    const registeredTools = (server as any)._registeredTools as Record<
      string,
      {
        _meta?: Record<string, unknown>;
        handler: (
          args: Record<string, unknown>,
          extra: unknown,
        ) => Promise<ToolReturn>;
        _cmuxlayerOriginalHandler?: (
          args: Record<string, unknown>,
          extra: unknown,
        ) => Promise<ToolReturn>;
        update: (updates: {
          _meta?: Record<string, unknown>;
          callback?: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<ToolReturn>;
        }) => void;
      }
    >;
    for (const [name, tool] of Object.entries(registeredTools)) {
      if (THIN_CORE_TOOL_NAMES.has(name)) continue;
      const replacement = THIN_CORE_LEGACY_REPLACEMENTS[name];
      const originalHandler = tool.handler;
      if (replacement) {
        tool._cmuxlayerOriginalHandler = originalHandler;
      }
      tool.update({
        _meta: {
          ...(tool._meta ?? {}),
          defer_loading: true,
          "cmuxlayer/interim": true,
          ...(replacement
            ? { deprecated: true, "cmuxlayer/replacement": replacement }
            : {}),
        },
        ...(replacement
          ? {
              callback: async (
                args: Record<string, unknown>,
                extra: unknown,
              ) =>
                withDeprecationWarning(
                  await originalHandler(args, extra),
                  name,
                  replacement,
                ),
            }
          : {}),
      });
    }
  }

  return server;
}
