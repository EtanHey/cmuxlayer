/**
 * cmuxlayer MCP server — registers core tools + agent lifecycle tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, mkdtempSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
import { buildSpawnToolReturn, shapeSpawnResponse } from "./spawn-response.js";
import {
  CODEX_EFFORT_VALUES,
  resolveSpawnEffort,
  resolveSpawnModelPolicy,
} from "./model-policy.js";
import { StateManager } from "./state-manager.js";
import { shellQuote } from "./agent-command.js";
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
  AgentLaunchError,
  RetryableDeliveryError,
  buildLaunchCommand,
  resolveSweepTiming,
  type AgentDeliveryReceipt,
  type AgentLifecycleEvent,
  type SessionIdentityResolver,
  type SpawnAgentParams,
} from "./agent-engine.js";
import {
  COORDINATION_CONTRACT_DELIVERED_NOTE,
  COORDINATION_CONTRACT_REFRESHED_NOT_REDELIVERED,
  COORDINATION_FOOTER_NOT_DELIVERED,
  bootContractMode,
  bootContractPointer,
  issueCoordinationContract,
  coordinationFooterBytes,
  writeBootContractFile,
  type CoordinationContract,
} from "./coordination-paths.js";
import {
  defaultDeliveryTicketDir,
  fileDeliveryFailureGithubIssue,
  type DeliveryFailureTicket,
} from "./delivery-failure-tickets.js";
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
  WATCH_AGENT_PREDICATES,
  WatchArmError,
  type WatchNotify,
  type WatchSpec,
} from "./watch-spec.js";
import {
  AgentDiscovery,
  SurfaceBindingChangedDuringDiscoveryError,
  type DiscoveredAgent,
} from "./agent-discovery.js";
import {
  INTERACTIVE_AGENT_STATES,
  isLiveDeliverable,
  isLiveTerminal,
  resolveLiveAgentState,
  TERMINAL_AGENT_STATES,
  type LiveAgentState,
} from "./live-agent-state.js";
import {
  resumeCommandForAgent,
  toAgentStatePayload,
  toObservedPublicAgent,
} from "./agent-facade.js";
import {
  evaluateAgentHealth,
  type AgentHealth,
} from "./agent-health.js";
import {
  AGENT_HEALTH_DISPATCH_ACK_TIMEOUT_MS,
  AGENT_HEALTH_MONITOR_MAX_AGE_MS,
  buildAgentHealthInput,
  type AgentHealthInputOverrides,
} from "./agent-health-input.js";
import type {
  AgentRecord,
  AgentAuthority,
  AgentFunction,
  AgentPlacement,
  ObservedPublicAgent,
  AgentRole,
  AgentState,
  CliType,
  CloseTelemetryEvent,
  DeliveryEventType,
  DeliveryTelemetryEvent,
} from "./agent-types.js";
import {
  bootPromptRegistryFields,
  summarizeTaskSummary,
} from "./agent-types.js";
import {
  formatListSurfaces,
  formatReadScreen,
  formatListAgents,
  formatAgentState,
  formatOk,
  formatDelivery,
} from "./format.js";
import {
  cleanScreenText,
  inferContextWindow,
  isCodexUpdateMenuScreen,
  isPickerOrMenuScreen,
  parseScreen,
  screenShowsPaused,
} from "./screen-parser.js";
import {
  launcherFailureFromShell,
  matchShellPromptLine,
  matchesShellPrompt,
  pendingShellPromptInput,
} from "./shell-prompt.js";
import {
  CreatedIdentityScope,
  createdIdentityFromError,
} from "./created-identity.js";
import {
  dispatch,
  ensureInboxFile,
  formatInboxPing,
  inboxCursorPath,
  inboxMonitorState,
  inboxPath,
  monitorAlive,
  pendingDispatches,
  recommendedMonitorCommand,
  replayUndelivered,
  writeHeartbeat,
  type InboxOpts,
} from "./inbox.js";
import {
  applyHarnessState,
  harnessJsonlEnabled,
  loadHarnessSession,
  type Harness,
} from "./harness-session.js";
import {
  makeCodexRolloutFillProvider,
  type CodexRolloutFill,
  type CodexRolloutFillProvider,
} from "./codex-rollout-fill.js";
import { sanitizeTerminalInput } from "./sanitize.js";
import {
  canInferAgentRole,
  collectRoleSurfaceIds,
  chooseAgentSpawnPlacement,
  chooseSurfaceClosePolicy,
  deriveColumnIndex,
  inferAgentRole,
  inferRecordRoleOrNull,
  topPaneInRoleColumn,
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
import { currentCallerContext, type CallerContext } from "./caller-context.js";
import {
  CLI_INPUT_PROMPT_PREFIXES,
  CURSOR_FOLLOWUP_ENTER_SEND_NOW_RE,
  CURSOR_FOLLOWUP_PLACEHOLDER_RE,
  matchReadyPattern,
  screenHasActiveAgentMarker,
  screenHasReadyAgentIdentity,
} from "./pattern-registry.js";
import {
  normalizeWorkspaceRefAlias,
  reposEquivalent,
  resolveWorkspaceRefForRepo,
  workspaceDirectoryRepoMatchScore,
} from "./repo-workspace.js";
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
  rollbackPreparedWorktree,
  type McpProfile,
  type WorktreeExec,
} from "./worktree.js";
import { resolveRepoRootFromLauncherRegistryOrNull } from "./launcher-registry.js";
import {
  defaultRepoCheckoutPath,
  resolveRepoRootWithoutRegistry,
} from "./repo-root-fallback.js";
import { resolveSpawnPermissionMode } from "./permission-mode.js";
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

function requireSurfaceEnumerationArray<T>(value: unknown, label: string): T[] {
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

const WatchSpecArgsSchema = {
  owner: z.string().min(1).describe("Agent/seat notified by the watch"),
  target: z.string().min(1).describe("Absolute file path or public agent_id"),
  predicate: z
    .enum(WATCH_AGENT_PREDICATES)
    .optional()
    .describe(
      "Agent screen-state predicate: thinking, working, idle, done, error; mutually exclusive with marker",
    ),
  marker: z
    .string()
    .min(1)
    .optional()
    .describe("Literal file marker; mutually exclusive with predicate"),
  watermark: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Prior marker count; defaults to count observed at arm time"),
  deadline: z
    .number()
    .int()
    .positive()
    .describe("Absolute Unix deadline in milliseconds"),
} as const;

const WatchSpecSchema = z
  .object(WatchSpecArgsSchema)
  .refine((watch) => Boolean(watch.predicate) !== Boolean(watch.marker), {
    message: "WatchSpec requires exactly one of predicate or marker",
  });

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
export const DENSE_INLINE_POLICY_MAX_UNBROKEN_CHARS =
  3 * SEND_INPUT_CHUNK_THRESHOLD;
const BOOT_PROMPT_PATH_WARNING_CHARS = 500;
export const DEFAULT_SEND_INPUT_MAX_INLINE_CHARS = 1_800;
const PANE_INPUT_BREAKAGE_GUIDANCE =
  "Max 2-3 short lines. Longer payloads BREAK the receiving pane — write the payload to a file and send one line: `Read and follow <path>`.";
const ZSH_BANG_INLINE_WARNING =
  "WARNING — a `!` in an inline brief may be consumed by zsh history expansion before it reaches the worker, leaving the worker idle with no task; file-backed payloads avoid that shell interpretation.";
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
// Busy relays are interjections into an already-running UI. Observe several
// repaint frames, accept a correlated TUI queue, and bound exact-composer
// recovery so fleet fan-out does not inherit the general 5s timeout.
const BUSY_AGENT_SUBMIT_VERIFY_TIMEOUT_MS = 1_000;
const CODEX_PENDING_COMPOSER_RETRY_OBSERVE_MS = 250;
const CURSOR_FOLLOWUP_RETRY_OBSERVE_MS = 250;
const SEND_INPUT_SAFE_RETRY_OBSERVE_MS = 2500;
const SEND_INPUT_POST_RETRY_VERIFY_GRACE_MS = 300;
const BOOT_PROMPT_TIMEOUT_MS = 60_000;
const BOOT_PROMPT_READY_POLL_MS = 250;
const BOOT_PROMPT_UPDATE_MAX_MS = 120_000;
const BOOT_PROMPT_UPDATE_RELAUNCH_MAX = 2;
const BOOT_PROMPT_UPDATE_MENU_DISMISS_GRACE_MS = BOOT_PROMPT_READY_POLL_MS * 3;
const BOOT_PROMPT_POST_UPDATE_READY_GRACE_MS = BOOT_PROMPT_READY_POLL_MS * 3;

function bootPromptUpdateMaxMs(): number {
  const raw = Number(process.env.CMUXLAYER_BOOT_PROMPT_UPDATE_MAX_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : BOOT_PROMPT_UPDATE_MAX_MS;
}
const LAUNCH_SHELL_READY_TIMEOUT_MS = 10_000;
const LAUNCH_SHELL_READY_POLL_MS = 100;
const LAUNCH_SHELL_JUNK_CLEAR_INTERVAL_MS = 2_500;
const LAUNCH_SHELL_JUNK_CLEAR_MAX = 3;
const LAUNCH_SUBMIT_READY_TIMEOUT_MS = 15_000;
const LAUNCHER_LINE_CORRUPTION_RECOVERY_ATTEMPTS = 2;
const LAUNCHER_LINE_CORRUPTION_ERROR =
  "launcher line corrupted by external input; manual Enter may have executed a modified command";
/** Heartbeat freshness window before dispatch_to_agent falls back to a surface nudge. */
const INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS = AGENT_HEALTH_MONITOR_MAX_AGE_MS;
const READY_PATTERN_CLIS: CliType[] = [
  "claude",
  "codex",
  "gemini",
  "kiro",
  "cursor",
];
const SEND_TO_WORKING_EXAMPLE =
  'Example: send_to({ mode: "agent", agent_id: "cmuxlayerCodex-1234", text: "hello" })';
const SendToArgsSchema = z.object({
  mode: z
    .enum(["agent", "surface", "command", "key"], {
      errorMap: () => ({
        message:
          'Expected one of "agent" | "surface" | "command" | "key". ' +
          SEND_TO_WORKING_EXAMPLE,
      }),
    })
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
  targeting: z
    .object({
      role: z.enum(["implementor", "reviewer", "gatherer"]).optional(),
      workspace: z.string().optional(),
      agent_ids: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional().default([]),
    })
    .refine(
      (targeting) =>
        targeting.role !== undefined ||
        targeting.workspace !== undefined ||
        targeting.agent_ids !== undefined,
      "targeting requires at least one of role, workspace, or agent_ids",
    )
    .optional(),
});

export const PUBLIC_TOOL_NAMES = [
  "spawn_agent",
  "send_to",
  "read_screen",
  "list_agents",
  "wait_for",
  "control_health",
  "close_surface",
  "update_surface",
  "list_surfaces",
] as const;

const PUBLIC_TOOL_NAME_SET = new Set<string>(PUBLIC_TOOL_NAMES);

const BaseOutputShape = {
  ok: z.boolean(),
  retry_count: z.number().int().nonnegative(),
};
const DeliveryOutputShape = {
  delivered: z.boolean().optional(),
  delivery: z
    .enum([
      "submitted",
      "queued",
      "queued_followup",
      "failed",
      "pending_verify",
      "failed_confirmed",
    ])
    .optional(),
  delivery_state: z
    .enum([
      "submitted",
      "queued",
      "queued_followup",
      "failed",
      "pending_verify",
      "failed_confirmed",
    ])
    .optional(),
  terminal: z.boolean().optional(),
  typed: z.boolean().optional(),
  submit_attempted: z.boolean().optional(),
  submit_verified: z.boolean().nullable().optional(),
  delivery_id: z.string().optional(),
  duplicate_of: z.string().optional(),
};
const DeliveryReceiptOutputSchema = z
  .object({
    ...DeliveryOutputShape,
    bytes: z.number().int().nonnegative().optional(),
    prompt_text: z.string().nullable().optional(),
    prompt_warning: z.string().nullable().optional(),
  })
  .passthrough();
const PUBLIC_TOOL_OUTPUT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  spawn_agent: z
    .object({
      ...BaseOutputShape,
      version: z.literal(1).optional(),
      type: z.enum(["agent", "terminal"]).optional(),
      agent_id: z.string().optional(),
      parent_agent_id: z.string().nullable().optional(),
      role: z.string().optional(),
      surface_id: z.string().optional(),
      workspace_id: z.string().nullable().optional(),
      cwd: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      cwd_receipt: DeliveryReceiptOutputSchema.optional(),
      boot_prompt_delivered: z.boolean().optional(),
      boot_prompt_receipt: DeliveryReceiptOutputSchema.optional(),
      boot_prompt_bytes: z.number().int().nonnegative().optional(),
      report_path: z.string().optional(),
      done_marker: z.string().optional(),
      coordination_footer_bytes: z.number().int().nonnegative().optional(),
      contract_path: z.string().optional(),
      coordination_footer_delivered: z.boolean().optional(),
      coordination_footer_note: z.string().optional(),
      boot_prompt_submit_verified: z.boolean().nullable().optional(),
    })
    .passthrough(),
  send_to: z
    .object({
      ...BaseOutputShape,
      ...DeliveryOutputShape,
      agent_id: z.string().optional(),
      surface: z.string().optional(),
      command: z.string().optional(),
      key: z.string().optional(),
      title: z.string().optional(),
      model: z.string().optional(),
      agent_type: z.string().optional(),
      accepted: z.boolean().optional(),
      status: z.string().optional(),
      boot_prompt_delivered: z.boolean().optional(),
      boot_prompt_receipt: DeliveryReceiptOutputSchema.optional(),
      boot_prompt_bytes: z.number().int().nonnegative().optional(),
      report_path: z.string().optional(),
      done_marker: z.string().optional(),
      coordination_footer_bytes: z.number().int().nonnegative().optional(),
      contract_path: z.string().optional(),
      coordination_footer_delivered: z.boolean().optional(),
      coordination_footer_note: z.string().optional(),
      boot_prompt_submit_verified: z.boolean().nullable().optional(),
      boot_prompt_warning: z.string().nullable().optional(),
      registry_state: z.string().nullable().optional(),
      screen: z.record(z.unknown()).nullable().optional(),
      state_conflict: z.boolean().optional(),
      health: z.record(z.unknown()).optional(),
      receipts: z
        .array(z.object({ ...DeliveryOutputShape }).passthrough())
        .optional(),
    })
    .passthrough(),
  read_screen: z
    .object({
      ...BaseOutputShape,
      surface: z.string().optional(),
      parsed: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  list_agents: z
    .object({
      ...BaseOutputShape,
      agents: z.array(z.record(z.unknown())).optional(),
      count: z.number().int().nonnegative().optional(),
      derived_at: z.number().optional(),
    })
    .passthrough(),
  wait_for: z
    .object({
      ...BaseOutputShape,
      agent_id: z.string().optional(),
      results: z.array(z.record(z.unknown())).optional(),
      watch: z.record(z.unknown()).optional(),
      delivery_id: z.string().optional(),
      delivery_state: z.string().optional(),
      terminal: z.boolean().optional(),
      timed_out: z.boolean().optional(),
    })
    .passthrough(),
  control_health: z
    .object({
      ...BaseOutputShape,
      health: z.record(z.unknown()).optional(),
    })
    .passthrough(),
  close_surface: z
    .object({
      ...BaseOutputShape,
      scope: z.enum(["surface", "agent", "workspace"]).optional(),
      surface: z.string().optional(),
      agent_id: z.string().optional(),
      workspace: z.string().optional(),
      state: z.string().optional(),
      force: z.boolean().optional(),
      removed: z.record(z.unknown()).optional(),
      pane: z.string().optional(),
      collapse_pane: z.boolean().optional(),
      refused: z.boolean().optional(),
      caller_workspace: z.boolean().optional(),
      surfaces: z.array(z.record(z.unknown())).optional(),
      agents: z.array(z.record(z.unknown())).optional(),
      live_agents: z.array(z.record(z.unknown())).optional(),
    })
    .passthrough(),
  update_surface: z
    .object({
      ...BaseOutputShape,
      action: z.enum(["move", "rename"]).optional(),
      surface: z.string().optional(),
      pane: z.string().optional(),
      workspace: z.string().optional(),
      title: z.string().optional(),
    })
    .passthrough(),
  list_surfaces: z
    .object({
      ...BaseOutputShape,
      workspaces: z.array(z.record(z.unknown())).optional(),
      surfaces: z.array(z.record(z.unknown())).optional(),
      column_count: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
};

const BroadcastRoleSchema = z.enum(["leads", "workers", "all"]);
const legacyCompatibleAgentRoleSchema = () =>
  z
    .enum(["orchestrator", "worker"])
    .catch((context) => context.input as AgentRole);
const spawnFunctionSchema = () =>
  z
    .enum(["orchestrator", "worker", "implementor", "reviewer", "gatherer"])
    .catch((context) => context.input as AgentRole);
const spawnPlacementSchema = () =>
  z
    .enum(["left", "right", "orchestrator", "worker"])
    .catch((context) => context.input as AgentPlacement);

function normalizeToolAgentRole(
  input: unknown,
  field: "role" | "placement",
): { role: AgentRole | undefined; warning: string | undefined } {
  if (input === undefined) return { role: undefined, warning: undefined };
  if (input === "ic") {
    return {
      role: "worker",
      warning: `Legacy ${field}=\"ic\" was coerced to \"worker\"; placement now has only orchestrator/worker columns`,
    };
  }
  if (input === "orchestrator" || input === "worker") {
    return { role: input, warning: undefined };
  }
  throw new Error(
    `Invalid ${field}=${JSON.stringify(input)}; expected orchestrator or worker`,
  );
}

function normalizeSpawnAxes(input: {
  role: unknown;
  placement: unknown;
  authority: AgentAuthority | undefined;
}): {
  role: AgentRole;
  function: AgentFunction;
  authority: AgentAuthority;
  placement: AgentPlacement;
  warning: string | undefined;
} {
  const raw = input.role;
  if (
    raw !== undefined &&
    raw !== "orchestrator" &&
    raw !== "worker" &&
    raw !== "ic" &&
    raw !== "implementor" &&
    raw !== "reviewer" &&
    raw !== "gatherer"
  ) {
    throw new Error(
      `Invalid role=${JSON.stringify(raw)}; expected orchestrator, worker, implementor, reviewer, or gatherer`,
    );
  }
  if (
    input.placement !== undefined &&
    input.placement !== "left" &&
    input.placement !== "right" &&
    input.placement !== "orchestrator" &&
    input.placement !== "worker" &&
    input.placement !== "ic"
  ) {
    throw new Error(
      `Invalid placement=${JSON.stringify(input.placement)}; expected left or right`,
    );
  }
  const legacyRaw =
    raw === "orchestrator" || raw === "worker" || raw === "ic"
      ? raw
      : input.placement === "orchestrator" ||
          input.placement === "worker" ||
          input.placement === "ic"
        ? input.placement
        : undefined;
  const legacy =
    legacyRaw !== undefined
      ? normalizeToolAgentRole(
          legacyRaw,
          legacyRaw === input.role ? "role" : "placement",
        )
      : null;
  const jobFunction: AgentFunction =
    raw === "reviewer" || raw === "gatherer" || raw === "implementor"
      ? raw
      : "implementor";
  const defaultAuthority: AgentAuthority = "worker";
  const authority =
    input.authority ??
    (legacy?.role === "orchestrator"
      ? "lead"
      : legacy?.role === "worker"
        ? "worker"
        : defaultAuthority);
  if (
    (jobFunction === "reviewer" || jobFunction === "gatherer") &&
    authority !== "worker"
  ) {
    throw new Error(
      `${jobFunction} is a worker function and cannot claim lead authority`,
    );
  }
  const derivedPlacement: AgentPlacement =
    authority === "lead" ? "left" : "right";
  const requestedPlacement =
    input.placement === "left" || input.placement === "right"
      ? input.placement
      : undefined;
  if (requestedPlacement && requestedPlacement !== derivedPlacement) {
    throw new Error(
      `${jobFunction} with ${authority} authority must be placed ${derivedPlacement}, not ${requestedPlacement}`,
    );
  }
  return {
    role: authority === "lead" ? "orchestrator" : "worker",
    function: jobFunction,
    authority,
    placement: requestedPlacement ?? derivedPlacement,
    warning: legacy?.warning,
  };
}

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
  submit_verification_reason?: SubmitVerificationFailureReason;
  retry_safe?: false;
  error?: string;
  skipped?: string;
};

type DeliveryStatus = "delivering" | "delivered" | "failed";

export const DELIVERY_RECEIPT_VOCABULARY = [
  "delivered",
  "delivery",
  "delivery_state",
  "terminal",
  "typed",
  "submit_attempted",
  "submit_verified",
  "retry_count",
] as const;

type PublicDeliveryState =
  | "submitted"
  | "queued"
  | "queued_followup"
  | "failed"
  | "pending_verify"
  | "failed_confirmed";

export interface PublicDeliveryReceipt {
  delivered: boolean;
  terminal: boolean;
  typed: boolean;
  submit_attempted: boolean;
  submit_verified: boolean | null;
  retry_count: number;
  delivery?: PublicDeliveryState;
  delivery_state?: PublicDeliveryState;
  delivery_id?: string;
  duplicate_of?: string;
  WARNING?: string;
}

/**
 * The only public receipt builder for text/key delivery. A delivery
 * discriminator is intentionally absent until the engine has evidence for a
 * queued, failed, or verified-submitted outcome.
 */
export function buildPublicDeliveryReceipt(input: {
  delivery_state?: PublicDeliveryState;
  delivery_id?: string;
  typed: boolean;
  submit_attempted: boolean;
  submit_verified: boolean | null;
  retry_count: number;
  WARNING?: string;
}): PublicDeliveryReceipt {
  const evidencedState =
    input.delivery_state === "queued" ||
    input.delivery_state === "queued_followup" ||
    input.delivery_state === "failed" ||
    input.delivery_state === "pending_verify" ||
    input.delivery_state === "failed_confirmed"
      ? input.delivery_state
      : input.delivery_state === "submitted" && input.submit_verified === true
        ? "submitted"
        : undefined;
  const terminal =
    evidencedState === "submitted" ||
    evidencedState === "failed" ||
    evidencedState === "failed_confirmed";
  const warning = input.WARNING ?? defaultNonDeliveryWarning(evidencedState);
  return {
    delivered: evidencedState === "submitted",
    terminal,
    typed: input.typed,
    submit_attempted: input.submit_attempted,
    submit_verified: input.submit_verified,
    retry_count: input.retry_count,
    ...(evidencedState
      ? { delivery: evidencedState, delivery_state: evidencedState }
      : {}),
    ...(input.delivery_id ? { delivery_id: input.delivery_id } : {}),
    ...(warning ? { WARNING: warning } : {}),
  };
}

/**
 * One plain-language line a caller cannot honestly quote as "sent".
 *
 * AIDEV-NOTE (T2 #445): `ok:true` with `delivered:false` was routinely read as
 * success -- a lead's own words: "I treated the first as evidence of the
 * second." The booleans two levels down were correct and still misread, so the
 * receipt now says it in words at the top level. Explicit callers keep their
 * own WARNING (the paused-target line is more specific than this default).
 */
function defaultNonDeliveryWarning(
  state: PublicDeliveryState | undefined,
): string | undefined {
  switch (state) {
    case "pending_verify":
    case "queued":
    case "queued_followup":
      return (
        `NOT DELIVERED YET — state ${state}: the message has not been observed ` +
        "to land. It resolves in the background; do not relay as sent. " +
        "Query wait_for({delivery_id}) for the terminal outcome."
      );
    case "failed":
    case "failed_confirmed":
      return (
        `NOT DELIVERED — terminal failure (${state}). The message did not ` +
        "land and will not be retried; do not relay as sent."
      );
    default:
      return undefined;
  }
}

export function pausedTargetWarning(source: string): string {
  return (
    `WARNING — target pane is paused (source: ${source}) and cannot act. ` +
    "Delivery is queued, not submitted. Do not relay as sent."
  );
}

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
  submit_verification_reason?: SubmitVerificationFailureReason;
  retry_safe?: false;
  retry_count: number;
  rename_to_task?: string;
  started_at: string;
  completed_at?: string;
  error?: string;
  failed_chunk?: number;
  /** Internal UUID guard; omitted from public delivery snapshots. */
  stableSurfaceIdentity?: string | null;
  /** Ref-only provenance captured before an asynchronous write starts. */
  surfaceObserverIdentity?: string | null;
  beforeMutation?: () => Promise<void>;
  lockKey?: string;
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

/**
 * Why a submit could not be verified. This is the sentence a receipt shows the
 * fleet when a delivery did not land, so it is spelled out rather than nested:
 * the order is "what we saw" before "what we required", most specific first.
 */
function resolveSubmitVerificationFailureReason(observed: {
  sawPendingInput: boolean;
  sawReadableScreen: boolean;
  sawBlankScreen: boolean;
  bootConsumptionRefuted: boolean;
  requireWorkingStatus: boolean;
}): SubmitVerificationFailureReason {
  if (observed.sawPendingInput) return "input_still_pending";
  if (!observed.sawReadableScreen) {
    return observed.sawBlankScreen
      ? "surface_screen_empty"
      : "surface_read_unavailable";
  }
  if (observed.bootConsumptionRefuted) return "consumption_not_observed";
  if (observed.requireWorkingStatus) return "working_status_not_observed";
  return "submit_evidence_absent";
}

type SubmitVerificationFailureReason =
  | "surface_read_unavailable"
  | "surface_screen_empty"
  | "input_still_pending"
  | "working_status_not_observed"
  | "consumption_not_observed"
  | "submit_evidence_absent";

class SubmitVerificationError extends Error {
  readonly retry_safe = false;
  readonly receipt: PublicDeliveryReceipt;

  constructor(
    message: string,
    readonly retry_count: number,
    readonly reason: SubmitVerificationFailureReason,
    receipt?: PublicDeliveryReceipt,
  ) {
    super(message);
    this.name = "SubmitVerificationError";
    this.receipt =
      receipt ??
      buildPublicDeliveryReceipt({
        typed: true,
        submit_attempted: true,
        submit_verified: false,
        retry_count,
      });
  }
}

const submitVerificationFailurePayload = (error: SubmitVerificationError) => ({
  ...error.receipt,
  submit_verification_reason: error.reason,
  retry_safe: error.retry_safe,
});

class DeliverySafetyGateError extends Error {
  readonly receipt = buildPublicDeliveryReceipt({
    delivery_state: "failed",
    typed: false,
    submit_attempted: false,
    submit_verified: false,
    retry_count: 0,
  });
  readonly delivered = this.receipt.delivered;
  readonly submit_verified = this.receipt.submit_verified;

  constructor(
    readonly error_code:
      "blocked_by_interactive_prompt" | "blocked_by_permission_prompt",
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

const PLACEMENT_WORKSPACE_UNRESOLVED =
  "PLACEMENT_WORKSPACE_UNRESOLVED" as const;

class BootPromptTimeoutError extends Error {
  constructor(
    message: string,
    readonly last_10_lines: string[],
    readonly pending_input_observed = false,
  ) {
    super(message);
    this.name = "BootPromptTimeoutError";
  }
}

class LauncherReadinessError extends Error {
  constructor(
    message: string,
    readonly last_10_lines: string[],
  ) {
    super(message);
    this.name = "LauncherReadinessError";
  }
}

class BootPromptDeliveryError extends Error {
  constructor(
    message: string,
    readonly delivered_chars: number,
    readonly submit_verification_error?: SubmitVerificationError,
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
  return readErrorText(error).replace(
    /^Error\ncmux read-screen failed:\s*/i,
    "",
  );
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
          ...error.receipt,
          error_code: error.error_code,
          screen: error.screen,
        }
      : {};
  const submitVerificationExtra =
    error instanceof SubmitVerificationError
      ? submitVerificationFailurePayload(error)
      : error instanceof BootPromptDeliveryError &&
          error.submit_verification_error
        ? submitVerificationFailurePayload(error.submit_verification_error)
        : {};
  const placementWorkspaceExtra =
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === PLACEMENT_WORKSPACE_UNRESOLVED
      ? { error_code: PLACEMENT_WORKSPACE_UNRESOLVED }
      : {};
  const readinessTimeout = findErrorInChain(
    error,
    (candidate): candidate is BootPromptTimeoutError | LauncherReadinessError =>
      candidate instanceof BootPromptTimeoutError ||
      candidate instanceof LauncherReadinessError,
  );
  const readinessExtra = readinessTimeout
    ? { last_10_lines: readinessTimeout.last_10_lines }
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
    ...submitVerificationExtra,
    ...placementWorkspaceExtra,
    ...readinessExtra,
    ...extra,
    ...createdIdentityFromError(error),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function findErrorInChain<T extends Error>(
  error: unknown,
  predicate: (error: Error) => error is T,
): T | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (predicate(current)) return current;
    seen.add(current);
    current =
      current instanceof AgentLaunchError && current.launch_cause !== undefined
        ? current.launch_cause
        : current.cause;
  }
  return null;
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
  "local" | "connected" | "disconnected" | "unavailable";

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

  if (typeof surface.id === "string") {
    minimal.id = surface.id;
  }
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
  tool:
    | "send_input"
    | "send_to"
    | "send_to_agent"
    | "spawn_agent"
    | "new_worktree_split"
    | "spawn_in_workspace";
  arg?: "text" | "prompt";
  value: string | undefined;
  cli: CliType | undefined;
  allowLongInline?: boolean;
  allowLongInlineSupported?: boolean;
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

  const overrideGuidance =
    opts.allowLongInlineSupported === false
      ? ""
      : " To deliberately bypass this guard, pass allow_long_inline:true.";
  throw new Error(
    `${opts.tool}${opts.arg ? `.${opts.arg}` : ""} refuses multi-paragraph inline text for an interactive ${opts.cli} composer because paragraph breaks can become separate submitted messages. Write the payload to a file and send "Read and follow <path>" instead; for launcher boot prompts, pass boot_prompt_path.${overrideGuidance}`,
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
    | "new_worktree_split"
    | "spawn_in_workspace"
    | "send_to"
    | "send_to_agent";
  arg: "text" | "command" | "prompt";
  value: string | undefined;
  allowLongInline?: boolean;
  allowLongInlineSupported?: boolean;
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
    opts.arg === "prompt" || opts.tool === "send_command"
      ? " For launcher boot prompts, put the full prompt in a file and pass boot_prompt_path."
      : " For launchers, put the full boot prompt in a file and pass boot_prompt_path.";
  const overrideGuidance =
    opts.allowLongInlineSupported === false
      ? ""
      : " To deliberately send raw inline text, pass allow_long_inline:true.";
  throw new Error(
    `${argName} is ${opts.value.length} characters, above CMUXLAYER_MAX_INLINE_CHARS=${SEND_INPUT_MAX_INLINE_CHARS}. Pane keystrokes are capped to one-line pointers: write the payload to a file and send "Read and follow <path>" instead.${promptPathGuidance}${overrideGuidance} CMUXLAYER_MAX_INLINE_CHARS may be set to a positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}.`,
  );
}

function assertDenseInlineInputAllowed(opts: {
  tool:
    | "send_input"
    | "send_command"
    | "spawn_agent"
    | "new_worktree_split"
    | "spawn_in_workspace"
    | "send_to"
    | "send_to_agent"
    | "broadcast";
  arg: "text" | "command" | "prompt";
  value: string | undefined;
  allowLongInline?: boolean;
  allowLongInlineSupported?: boolean;
}): void {
  if (opts.allowLongInline || opts.value === undefined) {
    return;
  }

  const inputCharacterCount = Array.from(opts.value).length;
  const longestUnbrokenRun = opts.value
    .split(/\r?\n/)
    .reduce((longest, line) => Math.max(longest, Array.from(line).length), 0);
  if (longestUnbrokenRun <= DENSE_INLINE_POLICY_MAX_UNBROKEN_CHARS) {
    return;
  }

  const argName = `${opts.tool}.${opts.arg}`;
  const overrideGuidance =
    opts.tool === "broadcast" || opts.allowLongInlineSupported === false
      ? ""
      : " To deliberately send raw inline text, pass allow_long_inline:true.";
  throw new Error(
    `${argName} is ${inputCharacterCount} characters and its longest unbroken run is ${longestUnbrokenRun}, above the dense inline routing policy threshold ${DENSE_INLINE_POLICY_MAX_UNBROKEN_CHARS}. Long dense payloads belong in a file: write the payload to a file and send one line: "Read and follow <path>".` +
      overrideGuidance,
  );
}

function assertSpawnPromptInputAllowed(opts: {
  tool: "spawn_agent" | "new_worktree_split" | "spawn_in_workspace";
  value: string | undefined;
  cli: CliType;
  allowLongInline?: boolean;
  allowLongInlineSupported?: boolean;
}): void {
  assertInlineInputAllowed({
    tool: opts.tool,
    arg: "prompt",
    value: opts.value,
    allowLongInline: opts.allowLongInline,
    allowLongInlineSupported: opts.allowLongInlineSupported,
  });
  assertDenseInlineInputAllowed({
    tool: opts.tool,
    arg: "prompt",
    value: opts.value,
    allowLongInline: opts.allowLongInline,
    allowLongInlineSupported: opts.allowLongInlineSupported,
  });
  assertInteractiveMultilineInputAllowed({
    tool: opts.tool,
    arg: "prompt",
    value: opts.value,
    cli: opts.cli,
    allowLongInline: opts.allowLongInline,
    allowLongInlineSupported: opts.allowLongInlineSupported,
  });
}

function assertBroadcastInlineInputAllowed(text: string): void {
  if (text.length > SEND_INPUT_MAX_INLINE_CHARS) {
    throw new Error(
      `broadcast.text is ${text.length} characters, above CMUXLAYER_MAX_INLINE_CHARS=${SEND_INPUT_MAX_INLINE_CHARS}. ` +
        `Broadcasts are capped to one-line pointers: write the payload to a file and broadcast "Read and follow <path>" instead. ` +
        `CMUXLAYER_MAX_INLINE_CHARS may be set to a positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}.`,
    );
  }

  assertDenseInlineInputAllowed({
    tool: "broadcast",
    arg: "text",
    value: text,
  });
}

function broadcastRoleMatches(
  requestedRole: BroadcastRole,
  agentRole: AgentRole | null,
): boolean {
  if (requestedRole === "all") return true;
  if (requestedRole === "workers") return agentRole === "worker";
  return agentRole === "orchestrator";
}

function inferBroadcastRecordRole(agent: AgentRecord): AgentRole | null {
  try {
    return inferAgentRole({
      role: agent.role,
      cli: agent.cli,
      launcherName:
        agent.launcher_name ?? launcherNameForCli(agent.repo, agent.cli),
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

function shouldHandleCodexUpdateMenu(
  cli: CliType | undefined,
  text: string,
): boolean {
  return (
    (cli === undefined || cli === "codex") && isCodexUpdateMenuScreen(text)
  );
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
  const example = toolName === "send_to" ? ` ${SEND_TO_WORKING_EXAMPLE}` : "";
  return `${toolName} invalid arguments: ${details}.${example}`;
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
        /\bOpenAI\s+Codex\b/i.test(trimmed) || /\bModel:\s*gpt-/i.test(trimmed)
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
    CURSOR_FOLLOWUP_ENTER_SEND_NOW_RE.test(trimmed) ||
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

function normalizeKnownPlaceholderComposerInput(
  cli: CliType | null,
  input: string,
  submittedText?: string,
): string {
  const withoutCursorBorders = input
    .split("\n")
    .filter((line) => !/^\s*[▄▀]{8,}\s*$/.test(line))
    .join("\n")
    .trim();
  if (
    (cli === "codex" && withoutCursorBorders === "Implement {feature}") ||
    (cli === "cursor" &&
      (withoutCursorBorders === "Plan, search, build anything" ||
        CURSOR_FOLLOWUP_PLACEHOLDER_RE.test(withoutCursorBorders)))
  ) {
    if (withoutCursorBorders === submittedText?.trim()) {
      return input;
    }
    return "";
  }
  return input;
}

function extractComposerInputRegion(
  screenText: string,
  submittedText?: string,
): string | null {
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

    return normalizeKnownPlaceholderComposerInput(
      cli,
      inputLines.join("\n").trimEnd(),
      submittedText,
    );
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

    return normalizeKnownPlaceholderComposerInput(
      cli,
      inputLines.join("\n").trimEnd(),
      submittedText,
    );
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
  const composerInput = extractComposerInputRegion(screenText, submittedText);
  return (
    composerInput !== null &&
    (composerInput.includes(tail) ||
      (compactTail.length > 0 &&
        composerInput.replace(/\s+/g, "").includes(compactTail)))
  );
}

/**
 * The text sitting on the composer's OWN input line, or null when no composer
 * prompt line is on screen.
 *
 * AIDEV-NOTE (T2 #442/B1): deliberately NOT `extractComposerInputRegion`. That
 * one appends every following line until it recognises a chrome line, so any
 * footer missing from `isComposerFooterOrChromeLine` -- `? for shortcuts`,
 * `accept edits on`, `Working (2s * esc to interrupt)` -- reads as composer
 * content. That is fine for its own callers, which ask "is the composer
 * CLEAR", where a false non-empty just withholds submit evidence. It is not
 * fine for the draft guard, where a false non-empty REFUSES a ready pane. So
 * the guard reads only the prompt line: a human draft always begins there,
 * and chrome never does. Widening the chrome whitelist instead is what put
 * this hole in the first place.
 */
function composerPromptLineInput(screenText: string): string | null {
  const lines = normalizeTerminalText(screenText).split("\n");
  const cli = inferComposerCli(screenText);
  const start = currentComposerRegionStart(cli, lines);
  let end = lines.length;
  while (end > start && isComposerFooterOrChromeLine(lines[end - 1] ?? "")) {
    end -= 1;
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const line = lines[index] ?? "";
    const match =
      matchComposerPromptLine(line) ?? matchLegacyClaudePromptLine(cli, line);
    if (match) {
      return normalizeKnownPlaceholderComposerInput(cli, match.input.trim());
    }
  }
  return null;
}

/**
 * True when the target composer holds text that this delivery did not put
 * there -- a human's half-written draft, or an earlier message still unflushed.
 *
 * AIDEV-NOTE (T2 #442): a partially-typed payload (chunk 1 landed, chunk 2
 * pending) IS ours and must stay deliverable, so the line content is compared
 * whitespace-insensitively against the payload rather than required to be
 * empty.
 */
function composerHoldsForeignDraft(
  screenText: string,
  submittedText: string,
): boolean {
  // AIDEV-NOTE (T2 #442): Cursor is deliberately exempt. Its composer RETAINS
  // the accepted text after a submit (the "retained composer" state #441/#449
  // built evidence rules around), so a non-empty Cursor composer is the normal
  // post-send screen, not an unsent draft -- and nothing on that screen
  // distinguishes the two. Guarding it would refuse every legitimate second
  // send to a Cursor pane. Claude and Codex clear on submit, so there a
  // non-empty composer really does mean somebody's text is sitting unsent.
  if (inferComposerCli(screenText) === "cursor") {
    return false;
  }
  // No recognisable composer prompt line (bare shell, unreadable frame). The
  // pre-existing gates own those cases; do not invent a refusal here.
  const promptLine = composerPromptLineInput(screenText);
  if (promptLine === null) {
    return false;
  }
  const compactDraft = promptLine.replace(/\s+/g, "");
  if (!compactDraft) {
    return false;
  }
  const compactPayload = submittedText.replace(/\s+/g, "");
  if (compactPayload.length === 0) {
    return true;
  }
  return !compactPayload.includes(compactDraft);
}

function stripCodexQueueGutter(line: string): string {
  return line.replace(/^\s*[│┃║┆┊]\s?/, "").trimEnd();
}

function compactQueueCorrelationText(text: string): string {
  return normalizeTerminalText(text).replace(/\s+/g, "");
}

function cursorSubmittedResponseEvidenceSignatures(
  screenText: string,
  submittedText: string,
): string[] {
  const trimmed = submittedText.trim();
  if (!trimmed || inferComposerCli(screenText) !== "cursor") {
    return [];
  }

  const lines = normalizeTerminalText(screenText).split("\n");
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (matchComposerPromptLine(lines[index] ?? "")) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) {
    return [];
  }

  const correlationTail = compactQueueCorrelationText(
    trimmed.slice(-Math.min(80, trimmed.length)),
  );
  let regionStart = 0;
  for (let index = composerIndex - 1; index >= 0; index -= 1) {
    if (lineIsCurrentComposerRegionAnchor("cursor", lines[index] ?? "")) {
      regionStart = index + 1;
      break;
    }
  }
  const evidence: string[] = [];
  for (let index = composerIndex - 1; index >= regionStart; index -= 1) {
    const submittedTranscriptWindow = compactQueueCorrelationText(
      lines.slice(Math.max(regionStart, index - 16), index).join("\n"),
    );
    if (!submittedTranscriptWindow.includes(correlationTail)) {
      continue;
    }

    const activityMatch = (lines[index] ?? "").match(
      /^\s*(?:[\u2800-\u28ff]+\s*)?(Working|Thinking|Running)\b/i,
    );
    if (activityMatch?.[1]) {
      evidence.push(`activity:${activityMatch[1].toLowerCase()}`);
      continue;
    }

    if (
      !/^\s*[│┃║]\s*(?:…|\.\.\.)?\s*Thought for \d+(?:\.\d+)?(?:ms|s|m)\b/i.test(
        lines[index] ?? "",
      )
    ) {
      continue;
    }

    const responseRows: string[] = [];
    for (
      let rowIndex = index + 1;
      rowIndex < Math.min(composerIndex, index + 17);
      rowIndex += 1
    ) {
      const row = lines[rowIndex] ?? "";
      if (/^\s*[└╰].*[┘╯]\s*$/.test(row)) {
        break;
      }
      const content = row.replace(/^\s*[│┃║]\s?/, "").trim();
      if (content && !/^[─━┌┐└┘╭╮╰╯]+$/.test(content)) {
        responseRows.push(content);
      }
    }
    if (responseRows.length > 0) {
      evidence.push(
        `thought:${responseRows.join(" ").replace(/\s+/g, " ").trim()}`,
      );
    }
  }

  return evidence;
}

function screenShowsFreshCursorResponseAfterSubmittedInput(
  screenText: string,
  submittedText: string,
  baselineEvidence: readonly string[] | null,
): boolean {
  if (baselineEvidence === null) {
    return false;
  }

  const baselineCounts = new Map<string, number>();
  for (const signature of baselineEvidence) {
    baselineCounts.set(signature, (baselineCounts.get(signature) ?? 0) + 1);
  }
  for (const signature of cursorSubmittedResponseEvidenceSignatures(
    screenText,
    submittedText,
  )) {
    const remaining = baselineCounts.get(signature) ?? 0;
    if (remaining === 0) {
      return true;
    }
    baselineCounts.set(signature, remaining - 1);
  }

  return false;
}

function screenShowsQueuedAgentInput(
  screenText: string,
  submittedText: string,
): boolean {
  const lines = normalizeTerminalText(screenText).split("\n");
  if (inferComposerCli(screenText) !== "codex") {
    return false;
  }

  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (matchComposerPromptLine(stripCodexQueueGutter(lines[index] ?? ""))) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) {
    return false;
  }

  let index = composerIndex - 1;
  while (
    index >= 0 &&
    (!stripCodexQueueGutter(lines[index] ?? "").trim() ||
      /^[•✻✢✳✶]?\s*(?:Working|Thinking)\b/i.test(
        stripCodexQueueGutter(lines[index] ?? ""),
      ))
  ) {
    index -= 1;
  }

  const queuedItemRows: string[] = [];
  let foundQueuedItem = false;
  while (index >= 0) {
    const rawLine = lines[index] ?? "";
    const activeLine = stripCodexQueueGutter(rawLine).trim();
    const itemMatch = /^↳(?:\s+(.*)|\s*$)/.exec(activeLine);
    if (itemMatch) {
      queuedItemRows.unshift(itemMatch[1] ?? "");
      foundQueuedItem = true;
      index -= 1;
      break;
    }
    const isWrappedItemRow =
      /^\s*[│┃║┆┊]/.test(rawLine) || /^\s{2,}\S/.test(rawLine);
    if (!activeLine || !isWrappedItemRow) {
      return false;
    }
    queuedItemRows.unshift(activeLine);
    index -= 1;
  }
  if (!foundQueuedItem) {
    return false;
  }

  while (index >= 0 && !stripCodexQueueGutter(lines[index] ?? "").trim()) {
    index -= 1;
  }
  const queueHeadingPattern =
    /^messages to be submitted after next tool call(?: \(press esc to interrupt and send immediately\))?$/i;
  let wrappedHeading = "";
  let foundHeading = false;
  for (let headingRows = 0; index >= 0 && headingRows < 4; headingRows += 1) {
    const headingRow = stripCodexQueueGutter(lines[index] ?? "")
      .trim()
      .replace(/^•\s*/, "");
    if (!headingRow) {
      break;
    }
    wrappedHeading = `${headingRow} ${wrappedHeading}`
      .replace(/\s+/g, " ")
      .trim();
    if (queueHeadingPattern.test(wrappedHeading)) {
      foundHeading = true;
      break;
    }
    index -= 1;
  }
  if (!foundHeading) {
    return false;
  }

  const visiblePrefix = compactQueueCorrelationText(
    queuedItemRows.join(" ").replace(/(?:…|\.\.\.)+\s*$/, ""),
  );
  const submitted = compactQueueCorrelationText(submittedText.trim());
  return visiblePrefix.length > 0 && submitted.startsWith(visiblePrefix);
}

function screenShowsCursorFollowupNeedsEnter(screenText: string): boolean {
  return (
    inferComposerCli(screenText) === "cursor" &&
    CURSOR_FOLLOWUP_ENTER_SEND_NOW_RE.test(normalizeTerminalText(screenText))
  );
}

function screenShowsQueuedCursorFollowup(
  screenText: string,
  submittedText: string,
): boolean {
  if (inferComposerCli(screenText) !== "cursor") {
    return false;
  }
  if (screenShowsPendingInput(screenText, submittedText)) {
    return false;
  }
  const trimmed = submittedText.trim();
  if (!trimmed) {
    return false;
  }
  const tail = trimmed.slice(-Math.min(80, trimmed.length));
  const composer = extractComposerInputRegion(screenText, submittedText);
  if (composer === null || composer.trim() !== "") {
    return false;
  }
  if (!normalizeTerminalText(screenText).includes(tail)) {
    return false;
  }
  return (
    CURSOR_FOLLOWUP_PLACEHOLDER_RE.test(screenText) ||
    /ctrl\+c to stop/i.test(screenText)
  );
}

export type PendingLauncherLineKind = "exact" | "corrupted" | "empty" | "other";

function inspectPendingShellInput(
  screenText: string,
  submittedText: string,
): { pending: string; outputBelowPrompt: boolean } | null {
  const trimmed = submittedText.trim();
  if (!trimmed) {
    return null;
  }

  const lines = normalizeTerminalText(screenText).split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) {
    end -= 1;
  }

  const promptOptions = {
    allowRootInput: isLauncherShellCommand(trimmed),
  };
  let activePromptIndex = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trimEnd() ?? "";
    const strictPrompt = matchShellPromptLine(line, {
      ...promptOptions,
      strict: true,
    });
    const prompt = strictPrompt ?? matchShellPromptLine(line, promptOptions);
    if (prompt) {
      // The readiness matcher intentionally accepts any decorated $/%/#
      // suffix. Only use that loose fallback as pending-input evidence for a
      // launcher command; ordinary output such as "Building... 62%" is not a
      // trustworthy prompt anchor.
      if (!strictPrompt && !promptOptions.allowRootInput) {
        return null;
      }
      activePromptIndex = index;
      break;
    }
  }
  if (activePromptIndex < 0) {
    return null;
  }

  const prompt = matchShellPromptLine(
    lines[activePromptIndex] ?? "",
    promptOptions,
  );
  const below = lines.slice(activePromptIndex + 1, end);
  return {
    pending: [prompt?.input ?? "", ...below].join("").trimEnd(),
    outputBelowPrompt: below.some((line) => line.trim().length > 0),
  };
}

export function screenShowsPendingShellInput(
  screenText: string,
  submittedText: string,
): boolean {
  const inspected = inspectPendingShellInput(screenText, submittedText);
  if (inspected === null) {
    return false;
  }
  const trimmed = submittedText.trim();
  return (
    inspected.pending === trimmed ||
    inspected.pending.replace(/\s+/g, "") === trimmed.replace(/\s+/g, "")
  );
}

export function classifyPendingLauncherLine(
  screenText: string,
  submittedText: string,
): PendingLauncherLineKind {
  const inspected = inspectPendingShellInput(screenText, submittedText);
  if (inspected === null) {
    return "other";
  }
  const compactPending = inspected.pending.replace(/\s+/g, "");
  const compactSubmitted = submittedText.trim().replace(/\s+/g, "");
  if (!compactPending) {
    return "empty";
  }
  if (compactPending === compactSubmitted) {
    return "exact";
  }
  // Output below the prompt is boot/history, not pending input. Only a
  // single non-exact prompt line is recoverable corruption.
  if (inspected.outputBelowPrompt) {
    return "other";
  }
  return "corrupted";
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
  composerHoldsForeignDraft,
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
  /** Agent-owned consumption watermark; the engine never writes this file. */
  cursor_path: string;
  /** Run after handling with the message id supplied as CMUX_INBOX_MSG_ID. */
  cursor_update_command: string;
  cursor_update_env: "CMUX_INBOX_MSG_ID";
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
  authorizedRecord?: AgentRecord | null,
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
  const record = authorizedRecord ?? matches[0];
  const cli = record?.cli as Harness | undefined;
  const sessionId = record?.cli_session_id ?? null;
  // Codex fill is handled asynchronously from the exact self-registration
  // session path. Never fall back to the legacy synchronous sessions-dir scan.
  if (cli === "codex") return null;
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

// Best-effort target-agent identity for delivery responses (send_input /
// send_command). `title` is the live cmux tab/surface title when known — never
// the boot prompt / task_summary. Model/cli come from the in-memory registry.
function resolveTargetIdentity(
  stateMgr: StateManager,
  surfaceRef: string,
  surfaceTitle?: string | null,
): TargetIdentity {
  const identity: TargetIdentity = { surface: surfaceRef };
  const title = surfaceTitle?.trim();
  if (title) identity.title = title;
  const record = resolveLatestSurfaceAgentRecord(stateMgr, surfaceRef);
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
  /** Override lifecycle persistence (primarily for hermetic tests). */
  stateManager?: StateManager;
  /** Override the lifecycle registry paired with stateManager (primarily for tests). */
  lifecycleRegistry?: AgentRegistry;
  /** Override persisted-state reconstitution at lifecycle startup (primarily for tests). */
  lifecycleInitializer?: () => Promise<void>;
  /** Skip agent lifecycle initialization (for testing low-level tools only) */
  skipAgentLifecycle?: boolean;
  /**
   * In-process-only caller identity used by safety gates, never placement.
   * Shared-daemon entrypoints intentionally leave this unset.
   */
  safetyCallerContextProvider?: () => CallerContext | undefined;
  /** Override the per-session resident-tool palette (primarily for entry wiring/tests). */
  defaultPalette?: string;
  /** Keep retired handlers registered only for direct unit coverage. Never set in production. */
  exposeInternalToolsForTests?: boolean;
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
  /**
   * PRIMARY session-identity resolver — the self-registration READ side. Threaded
   * to the lifecycle engine as its primary resolver (self-registration first,
   * transcript scan only as fallback). Production entrypoints inject
   * `makeSelfRegistrationSessionResolver()`; unset in tests keeps HOME I/O out.
   */
  selfRegistrationSessionResolver?: SessionIdentityResolver;
  /** Async, throttled Codex rollout reader (primarily injectable for tests). */
  codexRolloutFillProvider?: CodexRolloutFillProvider;
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
  /** Canonical persistent WatchSpec registry scanned by the agent engine. */
  watchRegistryPath?: string;
  watchRegistryNow?: () => number;
  watchNotify?: WatchNotify;
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
  /** Background send_to verify deadline; defaults to 10 minutes. */
  deliveryVerifyDeadlineMs?: number;
  /**
   * Local evidence tickets for failed_confirmed deliveries. Omitted in tests;
   * production createServer injects ~/.cmuxlayer/tickets when not VITEST/NODE_ENV=test.
   */
  deliveryTicketDir?: string;
  /** Optional GitHub/local ticket sink (tests inject a recorder; production injects gh). */
  deliveryIssueFiler?: (ticket: DeliveryFailureTicket) => Promise<void>;
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
  delivery_id?: string;
}) => Promise<PublicDeliveryReceipt & { bytes: number }>;

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
  launchShellRecoveryBySurface: Map<
    string,
    { recovered: true; cleared: string[] }
  >;
  surfaceWriteLivenessCandidates: Set<string>;
  surfacePtyDeadSince: Map<string, number>;
  readScreenInflight: Map<string, Promise<ReadScreenSnapshot>>;
  /** First-seen stable identities for caller-visible mutable surface refs. */
  capturedSurfaceUuidByRef: Map<string, string>;
  /** Refs observed with more than one UUID in one observer epoch are unsafe. */
  ambiguousCapturedSurfaceRefs: Set<string>;
  capturedSurfaceObserverEpoch: string | null;
  codexRolloutFillProvider: CodexRolloutFillProvider;
  surfaceWriteLiveness: SurfaceWriteLivenessTracker;
  enableClaudeChannels: boolean;
  skipAgentLifecycle: boolean;
  spawnPreflight?: (params: SpawnAgentParams) => Promise<void>;
  disableSpawnPreflight?: boolean;
  sessionIdentityResolver?: SessionIdentityResolver;
  selfRegistrationSessionResolver?: SessionIdentityResolver;
  lifecycleRegistry: AgentRegistry | null;
  lifecycleInitializer: (() => Promise<void>) | null;
  lifecycleStarted: boolean;
  lifecycleStartPromise: Promise<void> | null;
  lifecycleStartError: Error | null;
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
interface AutoVitestTempCleanupState {
  dirs: Set<string>;
  registered: boolean;
}

type AutoVitestTempCleanupGlobal = typeof globalThis & {
  __cmuxlayerAutoVitestTempCleanupV1?: AutoVitestTempCleanupState;
};

const autoVitestTempCleanupGlobal = globalThis as AutoVitestTempCleanupGlobal;
const autoVitestTempCleanupState =
  autoVitestTempCleanupGlobal.__cmuxlayerAutoVitestTempCleanupV1 ??
  (autoVitestTempCleanupGlobal.__cmuxlayerAutoVitestTempCleanupV1 = {
    dirs: new Set<string>(),
    registered: false,
  });

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

function registerAutoVitestTempDir(dir: string): void {
  autoVitestTempCleanupState.dirs.add(dir);
  if (autoVitestTempCleanupState.registered) {
    return;
  }
  autoVitestTempCleanupState.registered = true;
  process.once("exit", () => {
    for (const dir of autoVitestTempCleanupState.dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    autoVitestTempCleanupState.dirs.clear();
  });
}

function removeAutoVitestTempDir(dir: string): void {
  autoVitestTempCleanupState.dirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
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
    !opts?.stateDir && !opts?.stateManager && process.env.VITEST === "true"
      ? mkdtempSync(join(tmpdir(), "cmuxlayer-vitest-state-"))
      : null;
  const stateDir =
    opts?.stateManager?.getBaseDir() ??
    opts?.stateDir ??
    autoVitestStateDir ??
    join(homedir(), ".local", "state", "cmux-agents");
  if (autoVitestStateDir) {
    registerAutoVitestTempDir(autoVitestStateDir);
  }
  const stateMgr = opts?.stateManager ?? new StateManager(stateDir);
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
    launchShellRecoveryBySurface: new Map(),
    surfaceWriteLivenessCandidates: new Set(),
    surfacePtyDeadSince: new Map(),
    readScreenInflight: new Map(),
    capturedSurfaceUuidByRef: new Map(),
    ambiguousCapturedSurfaceRefs: new Set(),
    capturedSurfaceObserverEpoch: null,
    codexRolloutFillProvider:
      opts?.codexRolloutFillProvider ?? makeCodexRolloutFillProvider(),
    surfaceWriteLiveness:
      opts?.surfaceWriteLiveness ?? new SurfaceWriteLivenessTracker(),
    enableClaudeChannels:
      opts?.enableClaudeChannels ??
      process.env.CMUXLAYER_ENABLE_CLAUDE_CHANNELS === "1",
    skipAgentLifecycle: opts?.skipAgentLifecycle ?? false,
    spawnPreflight: opts?.spawnPreflight,
    disableSpawnPreflight: opts?.disableSpawnPreflight,
    sessionIdentityResolver: opts?.sessionIdentityResolver,
    selfRegistrationSessionResolver: opts?.selfRegistrationSessionResolver,
    lifecycleRegistry: opts?.lifecycleRegistry ?? null,
    lifecycleInitializer: opts?.lifecycleInitializer ?? null,
    lifecycleStarted: false,
    lifecycleStartPromise: null,
    lifecycleStartError: null,
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
      context.launchShellRecoveryBySurface.clear();
      context.capturedSurfaceUuidByRef.clear();
      context.ambiguousCapturedSurfaceRefs.clear();
      context.capturedSurfaceObserverEpoch = null;
      context.lifecycleStarted = false;
      context.lifecycleStartPromise = null;
      context.lifecycleStartError = null;
      if (autoVitestStateDir) {
        removeAutoVitestTempDir(autoVitestStateDir);
      }
    },
  };

  return context;
}

export function resolveServerInboxBaseDir(input: {
  explicitBaseDir?: string;
  isVitest: boolean;
}): string | undefined {
  if (input.explicitBaseDir) return input.explicitBaseDir;
  return input.isVitest
    ? join(tmpdir(), `cmuxlayer-vitest-inbox-${process.pid}`)
    : undefined;
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
  const explicitRoleForDiscoveredSurface = (
    discovered: Pick<
      DiscoveredAgent,
      "surface_id" | "surface_uuid" | "workspace_id"
    >,
  ): AgentRole | null => {
    const uuid = discovered.surface_uuid?.trim().toLowerCase() || null;
    const workspace = discovered.workspace_id ?? null;
    const matchesBinding = (override: {
      role: AgentRole;
      workspace: string | null;
      surfaceUuid: string | null;
    }): boolean => {
      if (workspace && override.workspace && workspace !== override.workspace) {
        return false;
      }
      const overrideUuid = override.surfaceUuid?.trim().toLowerCase() || null;
      return uuid === null ? true : overrideUuid === uuid;
    };
    const direct = roleSurfaceOverrides.get(discovered.surface_id);
    if (direct && matchesBinding(direct)) {
      return direct.role;
    }
    if (!uuid) return null;
    const stableMatches = [...roleSurfaceOverrides.values()].filter(
      (override) =>
        override.surfaceUuid?.trim().toLowerCase() === uuid &&
        matchesBinding(override),
    );
    return stableMatches.length === 1 ? stableMatches[0]!.role : null;
  };
  const eventLog = context.eventLog;
  const deliveries = context.deliveries;
  const latestDeliveryBySurface = context.latestDeliveryBySurface;
  const activeDeliveryBySurface = context.activeDeliveryBySurface;
  const activeSurfaceWrites = context.activeSurfaceWrites;
  const originalLaunchCommandsBySurface =
    context.originalLaunchCommandsBySurface;
  const launchShellRecoveryBySurface = context.launchShellRecoveryBySurface;
  const surfaceWriteLiveness = context.surfaceWriteLiveness;
  const surfaceWriteLivenessCandidates = context.surfaceWriteLivenessCandidates;
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
  const lifecycleInitializer =
    opts?.lifecycleInitializer ?? context.lifecycleInitializer;
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
  const inboxBaseDir = resolveServerInboxBaseDir({
    explicitBaseDir: opts?.inboxBaseDir,
    isVitest: process.env.VITEST === "true",
  });
  if (inboxBaseDir && process.env.VITEST === "true" && !opts?.inboxBaseDir) {
    registerAutoVitestTempDir(inboxBaseDir);
  }
  const inboxOpts: InboxOpts = inboxBaseDir ? { baseDir: inboxBaseDir } : {};
  const ensureMonitorBoot = (agentId: string): MonitorBootResult => {
    let monitorCommand = "";
    const cursorPath = inboxCursorPath(agentId, inboxOpts);
    const cursorUpdateCommand = `${
      inboxBaseDir
        ? `CMUXLAYER_INBOX_BASE_DIR=${shellQuote(inboxBaseDir)} `
        : ""
    }cmuxlayer inbox-cursor ${shellQuote(agentId)}`;
    try {
      monitorCommand = recommendedMonitorCommand(agentId, inboxOpts);
      ensureInboxFile(agentId, inboxOpts);
      writeHeartbeat(agentId, inboxOpts, "server_boot");
      return {
        status: "bootstrapped",
        heartbeat_written: true,
        heartbeat_source: "server_boot",
        monitor_command: monitorCommand,
        cursor_path: cursorPath,
        cursor_update_command: cursorUpdateCommand,
        cursor_update_env: "CMUX_INBOX_MSG_ID",
      };
    } catch (e) {
      return {
        status: "monitor-not-ready",
        heartbeat_written: false,
        heartbeat_source: "server_boot",
        monitor_command: monitorCommand,
        cursor_path: cursorPath,
        cursor_update_command: cursorUpdateCommand,
        cursor_update_env: "CMUX_INBOX_MSG_ID",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  };
  const mailboxBootContract = (
    agentId: string,
    monitorBoot: MonitorBootResult,
  ): string =>
    `cmuxlayer mailbox contract for ${agentId}: monitor with ${monitorBoot.monitor_command}; ` +
    `after each handled message run CMUX_INBOX_MSG_ID=<handled-message-id> ${monitorBoot.cursor_update_command}`;

  // AIDEV-NOTE (P11b): the boot prompt carries a POINTER, not the contract.
  // Inline, the mailbox contract alone is ~479 chars against a 500-char chunk
  // threshold, so #454's report contract could not be added without moving
  // EVERY spawn's boot delivery onto the chunked paste path (#434/#438). The
  // contract now lives in a file the engine writes at spawn; the wire carries
  // one short line. See coordination-paths.ts for the honest cost.
  const buildBootContractInjection = (
    agentId: string,
    monitorBoot: MonitorBootResult,
    coordination: CoordinationContract | null,
  ): { text: string; contract_path: string | null } => {
    if (bootContractMode() === "inline") {
      return { text: mailboxBootContract(agentId, monitorBoot), contract_path: null };
    }
    try {
      const written = writeBootContractFile(
        {
          agentId,
          mailbox: {
            monitor_command: monitorBoot.monitor_command,
            cursor_update_command: monitorBoot.cursor_update_command,
            cursor_update_env: monitorBoot.cursor_update_env,
          },
          coordination,
        },
        inboxOpts,
      );
      return {
        text: bootContractPointer(agentId, written.path),
        contract_path: written.path,
      };
    } catch {
      // A contract-file write failure must not fail an otherwise-successful
      // spawn. Fall back to the pre-P11b inline mailbox contract: the worker
      // loses the report half (exactly as before P11b), not its mailbox.
      return { text: mailboxBootContract(agentId, monitorBoot), contract_path: null };
    }
  };

  // AIDEV-NOTE (P11/U10): the engine issues the coordination contract at spawn,
  // returns it in the receipt, persists it on the record, AND tells the worker
  // the same two strings. That is the whole S3 fix -- producer and consumer read
  // one engine-authored value instead of each re-deriving one from prose.
  // Derived from agent_id alone and applied above launchMode, so a
  // registry-optional / raw-CLI spawn (#453) gets an identical contract.
  const issueSpawnCoordination = (
    agentId: string,
    reportPathOverride?: string | null,
  ): CoordinationContract =>
    issueCoordinationContract(agentId, {
      ...inboxOpts,
      reportPath: reportPathOverride ?? null,
    });
  // Wired up by the agent-lifecycle block below (when enabled). Lets the
  // dispatch_to_agent nudge reuse the guarded relay path — stale-surface
  // resync + recycled-occupant identity checks — instead of raw keystrokes.
  let lifecycleAgentInputDeliverer: LifecycleAgentInputDeliverer | null = null;
  let lifecycleSeatManifestPublisher: (input: {
    agentId?: string;
    surfaceId?: string;
    surfaceUuid?: string;
    tabName?: string;
    model?: string;
  }) => Promise<void> = async () => {};
  let lifecycleEnsureRegistered: (() => Promise<void>) | null = null;
  let lifecycleRefreshManagedMetadata:
    ((agentId?: string) => Promise<void>) | null = null;
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
  /**
   * AIDEV-NOTE (F1): live-derived state for one record, resolved from the last
   * screen scan. Wired to the discovery cache inside the lifecycle block; until
   * then (and whenever no fresh scan exists) it degrades to the registry record
   * as explicit `source: "registry"` provenance, never as silent truth.
   */
  const liveAgentStateProbe: {
    current: ((agent: AgentRecord) => LiveAgentState | null) | null;
  } = { current: null };
  const liveStateFor = (agent: AgentRecord): LiveAgentState =>
    liveAgentStateProbe.current?.(agent) ?? resolveLiveAgentState(agent, null);

  const resolveCurrentCallerAgent = (): AgentRecord | null => {
    const callerSurface = currentCallerContext()?.surfaceId?.trim();
    if (!callerSurface) return null;
    const normalizedSurface = callerSurface.toLowerCase();
    const records = [
      ...(context.lifecycleRegistry?.list() ?? []),
      ...stateMgr.listStates(),
    ];
    const matchesUuid = (agent: AgentRecord): boolean =>
      agent.surface_uuid?.trim().toLowerCase() === normalizedSurface;
    const matchesSurfaceId = (agent: AgentRecord): boolean =>
      agent.surface_id === callerSurface;
    // AIDEV-NOTE (F1): a terminal state is an ORDERING signal here, never an
    // exclusion, and it is read LIVE. #408 flips live agents to `done` within
    // minutes; excluding those records made the caller invisible, so the child
    // it spawned recorded parent_agent_id:null (U6) and the #378 worker guard
    // silently no-opped. A record bound to the surface the call is arriving on
    // is the best available caller identity even when the record is stale --
    // the call itself is the liveness evidence. The live-first ordering still
    // lets a genuinely live record win a recycled surface (#378 MEDIUM-A).
    // AIDEV-NOTE (#468): the LAST tier matches a TERMINAL record by
    // `surface_id`, and `surface_id` is a RECYCLABLE ref -- a dead worker's
    // record whose ref got reused could claim to be the caller, and #378 then
    // forced the new pane's children to worker/right off a corpse. The obvious
    // guard -- compare the live pane's CLI to the record's, as
    // deliverAgentInput does -- does NOT work here: `registry.listMerged`
    // rewrites `record.cli` from the live pane, so by the time caller
    // resolution runs, a recycled record already claims the new occupant's CLI.
    //
    // `surface_observer_id` IS a signal the merge does not overwrite: it is
    // stamped when this observer binds the surface and only ever replaced by
    // another binding. A ref stamped by a dead socket generation (or never
    // stamped at all) proves nothing about who occupies that ref now, so those
    // records are refused at the ref-only tier. Tiers 1 and 3 (UUID) are
    // unaffected -- a UUID is not recyclable -- and a record this observer owns
    // still resolves, which is what keeps U6 working for #408-poisoned rows.
    //
    // Cost, stated plainly: a caller whose record predates observer identity
    // gets no attribution and sees an explicit refusal instead of a wrong
    // parent. That is the trade this repo already makes everywhere else
    // absence is ambiguous.
    const observerOwnerId = context.surfaceObserverId?.trim() || null;
    const ownsRefBinding = (agent: AgentRecord): boolean =>
      Boolean(
        observerOwnerId && agent.surface_observer_id === observerOwnerId,
      );
    const live = (agent: AgentRecord): boolean =>
      !isLiveTerminal(liveStateFor(agent));
    return (
      records.find((agent) => matchesUuid(agent) && live(agent)) ??
      records.find((agent) => matchesSurfaceId(agent) && live(agent)) ??
      records.find(matchesUuid) ??
      records.find(
        (agent) => matchesSurfaceId(agent) && ownsRefBinding(agent),
      ) ??
      null
    );
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
      const entries = await statusClient.listStatus({
        workspace: modeWorkspace,
      });
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
    ...(opts?.monitorRegistryPath
      ? { registryPath: opts.monitorRegistryPath }
      : {}),
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
      return monitorRegistryError("missing-or-unknown-owner-seat", monitorId);
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
      return monitorRegistryError("rearm-watch-target-not-absolute", monitorId);
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
      ...(nonEmptyString(args.monitor_id)
        ? [nonEmptyString(args.monitor_id)!]
        : []),
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
    const monitors = filterMonitorRegistryRecords(query.monitors, args, true);
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
  const rawRegisterTool = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown,
  ) => unknown;
  const registerLegacyToolWithOutputSchema = (
    args: unknown[],
    outputSchema: z.ZodTypeAny,
  ): unknown => {
    const toolName = args[0];
    const handler = args.at(-1);
    if (typeof toolName !== "string" || typeof handler !== "function") {
      throw new Error("Invalid legacy MCP tool registration");
    }

    const legacyArgs = args.slice(1, -1);
    const description =
      typeof legacyArgs[0] === "string"
        ? (legacyArgs.shift() as string)
        : undefined;
    let inputSchema: unknown;
    let annotations: unknown;
    if (legacyArgs.length > 1) {
      inputSchema = legacyArgs.shift();
      annotations = legacyArgs.shift();
    } else if (legacyArgs.length === 1) {
      const candidate = legacyArgs.shift();
      const annotationKeys = new Set([
        "title",
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]);
      const keys =
        typeof candidate === "object" && candidate !== null
          ? Object.keys(candidate)
          : [];
      if (keys.length > 0 && keys.every((key) => annotationKeys.has(key))) {
        annotations = candidate;
      } else {
        inputSchema = candidate;
      }
    }
    if (legacyArgs.length > 0) {
      throw new Error(`Unsupported legacy MCP registration for ${toolName}`);
    }

    return rawRegisterTool(
      toolName,
      {
        ...(description ? { description } : {}),
        ...(inputSchema !== undefined ? { inputSchema } : {}),
        outputSchema,
        ...(annotations !== undefined ? { annotations } : {}),
      },
      handler as (...args: unknown[]) => unknown,
    );
  };
  const toolHandlersByName = new Map<
    string,
    (args: Record<string, unknown>, extra: unknown) => Promise<ToolReturn>
  >();
  const palette = createDefaultToolPalette(
    opts?.defaultPalette ?? process.env[CMUXLAYER_DEFAULT_PALETTE_ENV],
  );
  const exposeInternalToolsForTests =
    opts?.exposeInternalToolsForTests ?? process.env.VITEST === "true";
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
    ...args: unknown[]
  ): unknown => {
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
      typeof toolName === "string" &&
      !PUBLIC_TOOL_NAME_SET.has(toolName) &&
      !exposeInternalToolsForTests
    ) {
      return {
        update(updates: Record<string, unknown>) {
          const callback = updates.callback;
          if (typeof callback === "function") {
            toolHandlersByName.set(
              toolName,
              callback as (
                args: Record<string, unknown>,
                extra: unknown,
              ) => Promise<ToolReturn>,
            );
          }
        },
      };
    }
    if (
      palette &&
      typeof toolName === "string" &&
      !palette.shouldRegister(toolName)
    ) {
      return palette.defer(toolName, args);
    }
    if (typeof toolName === "string") {
      const outputSchema = PUBLIC_TOOL_OUTPUT_SCHEMAS[toolName];
      if (outputSchema) {
        return registerLegacyToolWithOutputSchema(args, outputSchema);
      }
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
    submit_verification_reason: record.submit_verification_reason ?? null,
    retry_safe: record.retry_safe ?? null,
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
      for (const role of ["orchestrator", "worker"] as const) {
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
            (observation.coverage === "uuid" || observation.coverage === "ref")
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

  const recordSurfaceWriteSuccess = (
    surface: string,
    stableSurfaceIdentity?: string | null,
    surfaceObserverIdentity?: string | null,
  ): void => {
    surfaceWriteLiveness.recordSuccess(
      surface,
      stableSurfaceIdentity,
      surfaceObserverIdentity,
    );
    if (stableSurfaceIdentity || surfaceObserverIdentity) {
      // Preserve ref-only telemetry for control-health consumers. Mutating
      // decisions use the identity-scoped observation and never fall back.
      surfaceWriteLiveness.recordSuccess(surface);
    }
    surfaceWriteLivenessCandidates.delete(surface);
    surfacePtyDeadSince.delete(surface);
  };

  const recordSurfaceWriteFailure = (
    surface: string,
    error: unknown,
    stableSurfaceIdentity?: string | null,
    surfaceObserverIdentity?: string | null,
  ): void => {
    if (!isBrokenPipeError(error)) return;
    surfaceWriteLiveness.recordFailure(
      surface,
      error,
      stableSurfaceIdentity,
      surfaceObserverIdentity,
    );
    if (stableSurfaceIdentity || surfaceObserverIdentity) {
      surfaceWriteLiveness.recordFailure(surface, error);
    }
    const observation = surfaceWriteLiveness.observe(
      surface,
      stableSurfaceIdentity,
      surfaceObserverIdentity,
    );
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
      stableSurfaceIdentity?: string | null;
      lockKey?: string;
    } = {},
  ): Promise<T> => {
    if (opts.toolName) {
      await assertSurfaceMutationAllowed(
        opts.toolName,
        surface,
        opts.workspace,
      );
    }
    const owner = opts.owner ?? `surface-write:${randomUUID()}`;
    // Capture the ref-only provenance before the async write. A reconnect or
    // socket replacement after the attempt must not relabel its liveness.
    const surfaceObserverIdentity = context.surfaceObserverId;
    const lockKey =
      opts.lockKey ??
      (opts.stableSurfaceIdentity
        ? `uuid:${opts.stableSurfaceIdentity.toLowerCase()}`
        : surface);
    acquireSurfaceWrite(lockKey, owner);
    try {
      const result = await fn();
      if (opts.observePtyWrite) {
        recordSurfaceWriteSuccess(
          surface,
          opts.stableSurfaceIdentity,
          surfaceObserverIdentity,
        );
      }
      return result;
    } catch (error) {
      if (opts.observePtyWrite) {
        recordSurfaceWriteFailure(
          surface,
          error,
          opts.stableSurfaceIdentity,
          surfaceObserverIdentity,
        );
      }
      throw error;
    } finally {
      releaseSurfaceWrite(lockKey, owner);
    }
  };

  const worktreeArgSchema = z.union([
    z.boolean(),
    z.string(),
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
      recordSurfaceWriteSuccess(
        record.surface,
        record.stableSurfaceIdentity,
        record.surfaceObserverIdentity,
      );
    } else if (status === "failed") {
      recordSurfaceWriteFailure(
        record.surface,
        error,
        record.stableSurfaceIdentity,
        record.surfaceObserverIdentity,
      );
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
    releaseSurfaceWrite(record.lockKey ?? record.surface, record.delivery_id);
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
            await delay(
              Math.min(SEND_INPUT_SUBMIT_VERIFY_POLL_MS, remainingMs),
            );
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
    opts?: { throwOnSurfaceGone?: boolean; agent?: AgentRecord },
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
        resolveHarnessStateForSurface(stateMgr, surface, opts?.agent),
      );
      return { text, parsed };
    } catch (error) {
      if (
        opts?.throwOnSurfaceGone &&
        isSurfaceGoneReadFailure(error, surface)
      ) {
        throw new SurfaceGoneError(surface, error);
      }
      return null;
    }
  };

  const assertDeliveryTargetIsSafe = async (opts: {
    surface: string;
    workspace?: string;
    cli?: CliType;
    /** When set, also refuse a composer already holding someone else's text. */
    draftGuardText?: string;
  }): Promise<{ text: string; parsed: ParsedScreenResult } | null> => {
    const { surface, workspace, cli } = opts;
    const snapshot = await readParsedSurface(surface, workspace, {
      throwOnSurfaceGone: true,
    });
    if (!snapshot) {
      return null;
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

    // AIDEV-NOTE (T2 #442): a composer that already holds text nobody in this
    // delivery wrote is a human (or another agent) mid-draft. Typing into it
    // concatenates, and the Return that follows SUBMITS their words. The
    // picker/permission gates above never covered this: the screen is a
    // perfectly ordinary ready composer, it just is not empty. Refuse before
    // the first keystroke -- a refused send is recoverable, a submitted draft
    // is not.
    //
    // RETRYABLE, not terminal (T2 B1a): the same screen is produced by this
    // delivery's OWN unflushed prior message (the queued_followup shape), and
    // the guard cannot tell that from a human draft. For both, the right
    // answer is "wait for the composer to flush", which the v2 queue already
    // expresses -- and #467's bounded queue lifetime guarantees the caller
    // still gets a terminal answer if it never does. A terminal `failed` here
    // would be this PR's own disease: a verdict the engine did not observe.
    if (
      opts.draftGuardText !== undefined &&
      composerHoldsForeignDraft(snapshot.text, opts.draftGuardText)
    ) {
      throw new RetryableDeliveryError(
        "target composer already holds text this delivery did not write; " +
          "refused to type (typing + Return would submit or mutate it). " +
          "Delivery stays queued until the composer is clear.",
      );
    }

    return snapshot;
  };

  const maybeRenameTask = async (opts: {
    surface: string;
    workspace?: string;
    rename_to_task?: string;
    stableSurfaceIdentity?: string | null;
    beforeMutation?: () => Promise<void>;
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
    await opts.beforeMutation?.();
    await client.renameTab(opts.surface, newTitle, {
      workspace: opts.workspace,
    });
    await lifecycleSeatManifestPublisher({
      surfaceId: opts.surface,
      ...(opts.stableSurfaceIdentity
        ? { surfaceUuid: opts.stableSurfaceIdentity }
        : {}),
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
    cursor_response_baseline: readonly string[] | null;
    beforeMutation?: () => Promise<void>;
  }): Promise<{
    submit_verified: boolean | null;
    submit_verification_reason: SubmitVerificationFailureReason | null;
    retry_count: number;
    delivery: "submitted" | "queued" | "queued_followup" | "pending_verify";
  }> => {
    if (!opts.verify_submit) {
      // null means submit verification was not attempted, usually because the
      // command was at or below SEND_INPUT_CHUNK_THRESHOLD; it is not a failure.
      return {
        submit_verified: null,
        submit_verification_reason: null,
        retry_count: 0,
        delivery: "submitted",
      };
    }

    const timeoutMs = opts.timeout_ms ?? SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS;
    // Once verification is requested, missing or inconclusive evidence is a
    // failed verification. The spawn launcher probe remains advisory because
    // agent-readiness detection is authoritative for that one internal path.
    const noSubmitEvidenceResult =
      opts.source_event === "spawn_agent" ? null : false;
    const startedAt = Date.now();
    let retried = false;
    let retryCount = 0;
    let sawClearedComposerEvidence = false;
    let sawAllowedClearedComposerEvidence = false;
    let lastHasPendingSubmitEvidence = false;
    let lastRetryEligiblePendingInput = false;
    let retryEligiblePendingSince: number | null = null;
    let retriedAt: number | null = null;
    let sawReadableScreen = false;
    let sawBlankScreen = false;
    let lastBootConsumptionRefuted = false;
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
        await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
        continue;
      }

      if (!snapshot.text.trim()) {
        sawBlankScreen = true;
        await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
        continue;
      }
      sawReadableScreen = true;

      const hasPendingInput = screenShowsPendingInput(snapshot.text, opts.text);
      const hasQueuedAgentInput = screenShowsQueuedAgentInput(
        snapshot.text,
        opts.text,
      );
      if (hasQueuedAgentInput) {
        if (
          opts.source_event !== "send_to" &&
          opts.source_event !== "dispatch_nudge"
        ) {
          return {
            submit_verified: false,
            submit_verification_reason: "input_still_pending",
            retry_count: retryCount,
            delivery: "submitted",
          };
        }
        return {
          submit_verified: null,
          submit_verification_reason: null,
          retry_count: retryCount,
          delivery: "queued",
        };
      }
      if (
        (opts.source_event === "send_to" ||
          opts.source_event === "dispatch_nudge") &&
        screenShowsQueuedCursorFollowup(snapshot.text, opts.text)
      ) {
        return {
          submit_verified: null,
          submit_verification_reason: null,
          retry_count: retryCount,
          delivery: "queued_followup",
        };
      }
      // AIDEV-NOTE (T2 #427): `0 tokens` is a definitive negative. An agent
      // handed a prompt that has consumed nothing did not receive it, whatever
      // the composer looks like -- a slow boot can render a working-looking
      // banner while the CLI is still initialising, and that race produced
      // `submit_verified: true` receipts for prompts that never left the
      // composer. A NULL token count stays inconclusive on purpose: several
      // CLIs never report one, and treating unknown as zero would turn this
      // guard into a fleet-wide false negative.
      const bootConsumptionRefuted =
        opts.require_working_status === true &&
        snapshot.parsed.token_count === 0;
      lastBootConsumptionRefuted = bootConsumptionRefuted;
      const screenCli = inferComposerCli(snapshot.text, snapshot.parsed);
      const cursorShowsSubmittedResponse =
        screenCli === "cursor" &&
        screenShowsFreshCursorResponseAfterSubmittedInput(
          snapshot.text,
          opts.text,
          opts.cursor_response_baseline,
        );
      const hasPendingSubmitEvidence =
        hasPendingInput && !cursorShowsSubmittedResponse;
      lastHasPendingSubmitEvidence = hasPendingSubmitEvidence;
      const composerInput = extractComposerInputRegion(snapshot.text);
      if (
        !hasPendingSubmitEvidence &&
        !bootConsumptionRefuted &&
        (isSubmitVerifiedStatus(snapshot.parsed.status) ||
          cursorShowsSubmittedResponse)
      ) {
        return {
          submit_verified: true,
          submit_verification_reason: null,
          retry_count: retryCount,
          delivery: "submitted",
        };
      }
      const hasClearedAgentComposer =
        composerInput !== null &&
        composerInput.trim() === "" &&
        !hasPendingSubmitEvidence &&
        !bootConsumptionRefuted &&
        screenHasAnyAgentIdentity(snapshot.text, snapshot.parsed);
      if (hasClearedAgentComposer) {
        sawClearedComposerEvidence = true;
        const allowClearedComposerSubmitEvidence =
          opts.source_event !== "spawn_agent" ||
          !screenIncludesSubmittedText(snapshot.text);
        if (allowClearedComposerSubmitEvidence) {
          sawAllowedClearedComposerEvidence = true;
          return {
            submit_verified: true,
            submit_verification_reason: null,
            retry_count: retryCount,
            delivery: "submitted",
          };
        }
      }

      const shouldRetryEnter =
        hasPendingInput ||
        (opts.source_event === "spawn_agent" &&
          screenIncludesSubmittedText(snapshot.text));
      const spawnRetryEligiblePendingInput =
        opts.allow_recovery_enter_retry !== false &&
        shouldRetryEnter &&
        !screenHasAnyAgentIdentity(snapshot.text, snapshot.parsed) &&
        opts.source_event === "spawn_agent" &&
        !hasParsedAgentIdentity(snapshot.parsed);
      const codexRetryEligiblePendingInput =
        opts.allow_recovery_enter_retry !== false &&
        (opts.source_event === "send_to" ||
          opts.source_event === "dispatch_nudge") &&
        hasPendingSubmitEvidence &&
        screenCli === "codex";
      const cursorFollowupRetryEligiblePendingInput =
        opts.allow_recovery_enter_retry !== false &&
        (opts.source_event === "send_to" ||
          opts.source_event === "dispatch_nudge") &&
        hasPendingSubmitEvidence &&
        screenCli === "cursor" &&
        screenShowsCursorFollowupNeedsEnter(snapshot.text);
      const retryEligiblePendingInput =
        spawnRetryEligiblePendingInput ||
        codexRetryEligiblePendingInput ||
        cursorFollowupRetryEligiblePendingInput;
      lastRetryEligiblePendingInput = retryEligiblePendingInput;
      if (retryEligiblePendingInput) {
        retryEligiblePendingSince ??= Date.now();
      } else {
        retryEligiblePendingSince = null;
      }
      const retryObserveMs = cursorFollowupRetryEligiblePendingInput
        ? Math.min(timeoutMs, CURSOR_FOLLOWUP_RETRY_OBSERVE_MS)
        : codexRetryEligiblePendingInput
          ? Math.min(timeoutMs, CODEX_PENDING_COMPOSER_RETRY_OBSERVE_MS)
          : opts.source_event === "spawn_agent" &&
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
        return {
          submit_verified: false,
          submit_verification_reason: "input_still_pending",
          retry_count: retryCount,
          delivery:
            opts.source_event === "send_to" ||
            opts.source_event === "dispatch_nudge"
              ? "pending_verify"
              : "submitted",
        };
      }

      await delay(SEND_INPUT_SUBMIT_VERIFY_POLL_MS);
    }
    if (sawClearedComposerEvidence && sawAllowedClearedComposerEvidence) {
      return {
        submit_verified: true,
        submit_verification_reason: null,
        retry_count: retryCount,
        delivery: "submitted",
      };
    }

    const submitVerified =
      opts.require_working_status ||
      lastHasPendingSubmitEvidence ||
      lastRetryEligiblePendingInput ||
      !sawReadableScreen
        ? false
        : noSubmitEvidenceResult;
    const failureReason: SubmitVerificationFailureReason | null =
      submitVerified === false
        ? resolveSubmitVerificationFailureReason({
            sawPendingInput:
              lastHasPendingSubmitEvidence || lastRetryEligiblePendingInput,
            sawReadableScreen,
            sawBlankScreen,
            bootConsumptionRefuted: lastBootConsumptionRefuted,
            requireWorkingStatus: opts.require_working_status === true,
          })
        : null;
    const allowPendingVerify =
      opts.source_event === "send_to" || opts.source_event === "dispatch_nudge";
    if (allowPendingVerify && submitVerified === false) {
      return {
        submit_verified: null,
        submit_verification_reason: null,
        retry_count: retryCount,
        delivery: "pending_verify",
      };
    }
    return {
      submit_verified: submitVerified,
      submit_verification_reason: failureReason,
      retry_count: retryCount,
      delivery: "submitted",
    };
  };

  const executeDeliveryEngine = async (opts: {
    surface: string;
    workspace?: string;
    chunks: string[];
    key?: string;
    chunk_size: number;
    chunk_delay_ms: number;
    press_enter: boolean;
    rename_to_task?: string;
    onChunkDelivered?: (sentChunks: number) => void;
    source_event?: DeliveryEventType;
    source_agent?: string | null;
    delivery_id?: string;
    verify_submit?: boolean;
    allow_recovery_enter_retry?: boolean;
    submit_verify_timeout_ms?: number;
    stableSurfaceIdentity?: string | null;
    beforeMutation?: () => Promise<void>;
  }): Promise<PublicDeliveryReceipt & { bytes: number }> => {
    await opts.beforeMutation?.();
    if (opts.key !== undefined) {
      if (opts.chunks.length > 0 || opts.press_enter) {
        throw new Error(
          "Delivery engine key input is mutually exclusive with text submission",
        );
      }
      const key = normalizeKeyName(opts.key);
      await sendKeyWithRetry(
        opts.surface,
        key,
        opts.workspace,
        opts.beforeMutation,
      );
      const receipt = buildPublicDeliveryReceipt({
        typed: false,
        submit_attempted: key === "return",
        submit_verified: null,
        retry_count: 0,
      });
      if (opts.source_event) {
        appendDeliveryEvent({
          event_type: opts.source_event,
          source_agent: opts.source_agent ?? null,
          target_surface: opts.surface,
          bytes: 0,
          press_enter: key === "return",
          submit_verified: null,
          retry_count: 0,
        });
      }
      return { ...receipt, bytes: 0 };
    }
    // AIDEV-NOTE (T2 #442): the draft guard covers the caller-initiated relay
    // paths, where refusing is cheap and a foreign draft is a live risk. Boot
    // and cwd delivery run against a pane cmuxlayer just launched, where the
    // only text on screen is the launcher's own echo -- refusing there would
    // break spawn, not protect a human.
    const draftGuardedEvent =
      opts.source_event === "send_to" ||
      opts.source_event === "send_to_agent" ||
      opts.source_event === "send_input" ||
      opts.source_event === "dispatch_nudge";
    const draftGuardText = opts.chunks.join("");
    const deliverySafetySnapshot = await assertDeliveryTargetIsSafe({
      surface: opts.surface,
      workspace: opts.workspace,
      ...(draftGuardedEvent && draftGuardText.trim().length > 0
        ? { draftGuardText }
        : {}),
    });
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
    const submittedText = opts.chunks.join("");
    let submit_verified: boolean | null = null;
    let submit_verification_reason: SubmitVerificationFailureReason | null =
      null;
    let retry_count = 0;
    let deliveryOutcome:
      "submitted" | "queued" | "queued_followup" | "pending_verify" =
      "submitted";

    if (opts.press_enter) {
      let cursorResponseBaseline: readonly string[] | null = null;
      if (
        opts.verify_submit &&
        deliverySafetySnapshot &&
        inferComposerCli(
          deliverySafetySnapshot.text,
          deliverySafetySnapshot.parsed,
        ) === "cursor"
      ) {
        await opts.beforeMutation?.();
        const preReturnSnapshot = await readParsedSurface(
          opts.surface,
          opts.workspace,
          { throwOnSurfaceGone: true },
        );
        cursorResponseBaseline = preReturnSnapshot
          ? cursorSubmittedResponseEvidenceSignatures(
              preReturnSnapshot.text,
              submittedText,
            )
          : null;
      }
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
        text: submittedText,
        bytes,
        source_event: opts.source_event ?? "send_command",
        source_agent: opts.source_agent,
        verify_submit: opts.verify_submit ?? false,
        allow_recovery_enter_retry: opts.allow_recovery_enter_retry,
        timeout_ms: opts.submit_verify_timeout_ms,
        cursor_response_baseline: cursorResponseBaseline,
        require_working_status: opts.source_event === "boot_prompt",
        beforeMutation: opts.beforeMutation,
      });
      submit_verified = verification.submit_verified;
      submit_verification_reason = verification.submit_verification_reason;
      retry_count = verification.retry_count;
      deliveryOutcome = verification.delivery;
      if (
        deliveryOutcome === "pending_verify" ||
        deliveryOutcome === "queued_followup"
      ) {
        submit_verified = null;
        submit_verification_reason = null;
      }
    }

    await maybeRenameTask({
      surface: opts.surface,
      workspace: opts.workspace,
      rename_to_task: opts.rename_to_task,
      stableSurfaceIdentity: opts.stableSurfaceIdentity,
      beforeMutation: opts.beforeMutation,
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
        ...(opts.delivery_id
          ? {
              delivery_id: opts.delivery_id,
              delivery_state:
                deliveryOutcome === "queued"
                  ? ("queued" as const)
                  : deliveryOutcome === "queued_followup"
                    ? ("queued_followup" as const)
                    : deliveryOutcome === "pending_verify"
                      ? ("pending_verify" as const)
                      : submit_verified === false
                        ? ("failed" as const)
                        : ("submitted" as const),
            }
          : {}),
      });
    }

    const receipt = buildPublicDeliveryReceipt({
      delivery_state:
        deliveryOutcome === "queued"
          ? "queued"
          : deliveryOutcome === "queued_followup"
            ? "queued_followup"
            : deliveryOutcome === "pending_verify"
              ? "pending_verify"
              : submit_verified === true
                ? "submitted"
                : undefined,
      delivery_id: opts.delivery_id,
      typed: bytes > 0,
      submit_attempted: Boolean(opts.press_enter),
      submit_verified,
      retry_count,
    });

    if (
      submit_verified === false &&
      deliveryOutcome !== "queued" &&
      deliveryOutcome !== "queued_followup" &&
      deliveryOutcome !== "pending_verify"
    ) {
      const timeoutMs =
        opts.submit_verify_timeout_ms ?? SEND_INPUT_SUBMIT_VERIFY_TIMEOUT_MS;
      throw new SubmitVerificationError(
        `Enter submit could not be verified for ${opts.surface} within ${timeoutMs}ms`,
        retry_count,
        submit_verification_reason ?? "submit_evidence_absent",
        receipt,
      );
    }

    return { ...receipt, bytes };
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

        const launcherFailure = launcherFailureFromShell(screen.text);
        if (launcherFailure) {
          throw new LauncherReadinessError(
            `Launcher exited before reaching readiness on ${target.surface}: ${launcherFailure}`,
            tailLines(lastText, 10),
          );
        }

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
                    (current.workspace ?? null) !== (target.workspace ?? null)
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
          const updateDuration = Math.max(
            now - updateStartedAt,
            updateElapsedMs,
          );
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
          !candidates.some(
            (candidate) => matchReadyPattern(candidate, screen.text).matched,
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
          error instanceof LauncherReadinessError ||
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
        const metrics = parseRawSubmitEvidenceMetrics(snapshot.text);
        // AIDEV-NOTE (T2 #427): `0 tokens` is a definitive negative -- an agent
        // handed a prompt that has consumed nothing did not receive it. A slow
        // boot (MCP servers still connecting, banner mid-render) can present a
        // working-looking status while the prompt is still sitting in the
        // composer, and accepting that status produced fully-verified receipts
        // for workers that sat at `0 tokens` with their entire brief unsent.
        // A NULL count stays inconclusive on purpose: several CLIs never
        // report one, and reading unknown as zero would break every boot.
        const consumptionRefuted = metrics.tokenCount === 0;
        if (!consumptionRefuted && isSubmitVerifiedStatus(snapshot.parsed.status)) {
          return;
        }

        const composerInput = extractComposerInputRegion(snapshot.text);
        const hasPendingInput = screenShowsPendingInput(
          snapshot.text,
          opts.text,
        );
        if (
          composerInput !== null &&
          !hasPendingInput &&
          hasRawSubmitEvidenceIncrease(metrics, opts.baseline_metrics)
        ) {
          return;
        }

        const composerCleared =
          composerInput !== null &&
          composerInput.trim() === "" &&
          !hasPendingInput;
        if (
          composerCleared &&
          !consumptionRefuted &&
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
    stableSurfaceIdentity?: string | null;
    assertSurfaceBindingCurrent?: () => Promise<void>;
  }): Promise<{ recovered: boolean; cleared: string[] }> => {
    const timeoutMs = opts.timeout_ms ?? LAUNCH_SHELL_READY_TIMEOUT_MS;
    const start = Date.now();
    let lastText = "";
    const cleared: string[] = [];
    let clears = 0;
    let lastClearAt = 0;
    let lastClearKey: "ctrl-u" | "ctrl-c" | null = null;
    let pendingInputObserved = false;

    const screenShowsAgentReady = (text: string): boolean =>
      READY_PATTERN_CLIS.some((cli) => matchReadyPattern(cli, text).matched);

    const sendClearKey = async (key: "ctrl-u" | "ctrl-c"): Promise<void> => {
      await executeDeliveryEngine({
        surface: opts.surface,
        workspace: opts.workspace,
        chunks: [],
        key,
        chunk_size: 0,
        chunk_delay_ms: 0,
        press_enter: false,
        source_event: "send_key",
        stableSurfaceIdentity: opts.stableSurfaceIdentity,
        beforeMutation: opts.assertSurfaceBindingCurrent,
      });
    };

    while (Date.now() - start < timeoutMs) {
      try {
        const screen = await client.readScreen(opts.surface, {
          workspace: opts.workspace,
          lines: 30,
          scrollback: false,
        });
        lastText = screen.text;
        const agentReady = screenShowsAgentReady(screen.text);
        if (!opts.require_fresh_shell_prompt && agentReady) {
          return { recovered: cleared.length > 0, cleared };
        }
        if (matchesShellPrompt(screen.text)) {
          return { recovered: cleared.length > 0, cleared };
        }
        const pending = agentReady
          ? null
          : pendingShellPromptInput(screen.text);
        if (pending) {
          pendingInputObserved = true;
          if (lastClearKey === "ctrl-u") {
            await sendClearKey("ctrl-c");
            lastClearKey = "ctrl-c";
          } else if (
            clears < LAUNCH_SHELL_JUNK_CLEAR_MAX &&
            (clears === 0 ||
              Date.now() - lastClearAt >= LAUNCH_SHELL_JUNK_CLEAR_INTERVAL_MS)
          ) {
            await sendClearKey("ctrl-u");
            if (!cleared.includes(pending)) {
              cleared.push(pending);
            }
            clears += 1;
            lastClearAt = Date.now();
            lastClearKey = "ctrl-u";
          }
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
      pendingInputObserved,
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

        const launcherFailure = launcherFailureFromShell(screen.text);
        if (launcherFailure) {
          throw new LauncherReadinessError(
            `Launcher exited before reaching readiness on ${opts.surface}: ${launcherFailure}`,
            tailLines(lastText, 10),
          );
        }

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
        if (
          error instanceof BootPromptTimeoutError ||
          error instanceof LauncherReadinessError
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
    stableSurfaceIdentity?: string | null;
    workspace?: string;
    command: string;
    timeout_ms?: number;
    relaunch?: boolean;
    assertSurfaceBindingCurrent?: () => Promise<void>;
  }): Promise<void> => {
    const sanitizedCommand = sanitizeTerminalInput(opts.command);
    const chunks =
      sanitizedCommand.length > SEND_INPUT_CHUNK_THRESHOLD
        ? chunkTerminalInput(sanitizedCommand, SEND_INPUT_CHUNK_THRESHOLD)
        : [sanitizedCommand];

    if (!opts.relaunch) {
      const shellRecovery = await waitForLaunchShellReady({
        surface: opts.surface,
        workspace: opts.workspace,
        timeout_ms: opts.timeout_ms,
        stableSurfaceIdentity: opts.stableSurfaceIdentity,
        assertSurfaceBindingCurrent: opts.assertSurfaceBindingCurrent,
      });
      if (shellRecovery.recovered) {
        launchShellRecoveryBySurface.set(opts.surface, {
          recovered: true,
          cleared: shellRecovery.cleared,
        });
      }
    }
    await opts.assertSurfaceBindingCurrent?.();
    await withSurfaceWrite(
      opts.surface,
      async () => {
        const readLauncherScreen = () =>
          client.readScreen(opts.surface, {
            workspace: opts.workspace,
            lines: 80,
            scrollback: false,
          });
        const submitPendingLauncherCommand = async (): Promise<boolean> => {
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
            await executeDeliveryEngine({
              surface: opts.surface,
              workspace: opts.workspace,
              chunks: [],
              key: "return",
              chunk_size: 0,
              chunk_delay_ms: 0,
              press_enter: false,
              source_event: "send_key",
              beforeMutation: opts.assertSurfaceBindingCurrent,
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
        const clearAndVerifyFreshShellPrompt = async (
          key: "ctrl-c" | "ctrl-u" = "ctrl-c",
        ): Promise<void> => {
          await opts.assertSurfaceBindingCurrent?.();
          await executeDeliveryEngine({
            surface: opts.surface,
            workspace: opts.workspace,
            chunks: [],
            key,
            chunk_size: 0,
            chunk_delay_ms: 0,
            press_enter: false,
            source_event: "send_key",
            beforeMutation: opts.assertSurfaceBindingCurrent,
          });
          await waitForLaunchShellReady({
            surface: opts.surface,
            workspace: opts.workspace,
            timeout_ms: opts.timeout_ms,
            require_fresh_shell_prompt: true,
            stableSurfaceIdentity: opts.stableSurfaceIdentity,
            assertSurfaceBindingCurrent: opts.assertSurfaceBindingCurrent,
          });
        };
        const typeLauncherCommand = async (verifySubmit: boolean) =>
          executeDeliveryEngine({
            surface: opts.surface,
            workspace: opts.workspace,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: true,
            source_event: "spawn_agent",
            verify_submit: verifySubmit,
            submit_verify_timeout_ms: verifySubmit
              ? SEND_INPUT_RECOVERY_ENTER_DELAY_MS
              : undefined,
            beforeMutation: opts.assertSurfaceBindingCurrent,
          });
        const recoverCorruptedLauncherLine = async (): Promise<void> => {
          for (
            let attempt = 0;
            attempt < LAUNCHER_LINE_CORRUPTION_RECOVERY_ATTEMPTS;
            attempt += 1
          ) {
            await clearAndVerifyFreshShellPrompt("ctrl-u");
            try {
              const recovered = await typeLauncherCommand(true);
              if (recovered.submit_verified === true) {
                return;
              }
            } catch (recoveryError) {
              const recoveryMessage =
                recoveryError instanceof Error
                  ? recoveryError.message
                  : String(recoveryError);
              if (!/Enter submit could not be verified/.test(recoveryMessage)) {
                throw recoveryError;
              }
            }
            let recoveredScreen;
            try {
              recoveredScreen = await readLauncherScreen();
            } catch (readError) {
              if (isSurfaceGoneReadFailure(readError, opts.surface)) {
                throw new SurfaceGoneError(opts.surface, readError);
              }
              throw readError;
            }
            const recoveredKind = classifyPendingLauncherLine(
              recoveredScreen.text,
              sanitizedCommand,
            );
            if (recoveredKind !== "corrupted") {
              return;
            }
          }
          let failedScreen;
          try {
            failedScreen = await readLauncherScreen();
          } catch (readError) {
            if (isSurfaceGoneReadFailure(readError, opts.surface)) {
              throw new SurfaceGoneError(opts.surface, readError);
            }
            throw new LauncherReadinessError(
              LAUNCHER_LINE_CORRUPTION_ERROR,
              [],
            );
          }
          throw new LauncherReadinessError(
            LAUNCHER_LINE_CORRUPTION_ERROR,
            tailLines(failedScreen.text, 10),
          );
        };
        if (opts.relaunch) {
          if (await submitPendingLauncherCommand()) {
            return;
          }
          await clearAndVerifyFreshShellPrompt();
        }
        const relaunchOriginalCommand = async (): Promise<void> => {
          await clearAndVerifyFreshShellPrompt();
          await typeLauncherCommand(false);
        };
        const confirmReadyThenRecoverIfCorrupted = async (): Promise<void> => {
          // Readiness is the authoritative launch check. Only recover a
          // corrupted pending line after that check fails — otherwise ctrl-u
          // can land in a healthy booting pane.
          try {
            await waitForAgentLaunchReady({
              surface: opts.surface,
              workspace: opts.workspace,
              timeout_ms: opts.timeout_ms,
              onUpdateShellRelaunch: relaunchOriginalCommand,
            });
          } catch (readinessError) {
            let pendingScreen;
            try {
              pendingScreen = await readLauncherScreen();
            } catch (readError) {
              if (isSurfaceGoneReadFailure(readError, opts.surface)) {
                throw new SurfaceGoneError(opts.surface, readError);
              }
              throw readinessError;
            }
            if (
              classifyPendingLauncherLine(
                pendingScreen.text,
                sanitizedCommand,
              ) === "corrupted"
            ) {
              await recoverCorruptedLauncherLine();
              await waitForAgentLaunchReady({
                surface: opts.surface,
                workspace: opts.workspace,
                timeout_ms: opts.timeout_ms,
                onUpdateShellRelaunch: relaunchOriginalCommand,
              });
              return;
            }
            if (
              screenShowsPendingShellInput(pendingScreen.text, sanitizedCommand)
            ) {
              throw new LauncherReadinessError(
                `launcher command remained pending after Return on ${opts.surface}`,
                tailLines(pendingScreen.text, 10),
              );
            }
            throw readinessError;
          }
        };
        try {
          const delivery = await typeLauncherCommand(true);
          if (delivery.submit_verified === true) {
            return;
          }
          // The command can clear from the shell without proving the launcher
          // accepted it. Probe once to consume transient ready evidence, then
          // let boot-prompt readiness own update/relaunch monitoring.
          await probeAgentLaunchReadyOnce({
            surface: opts.surface,
            workspace: opts.workspace,
          });
          // Interleaved corruption never throws: the exact command is gone, so
          // verify is advisory. Recover only that single-line case here; other
          // screens (Codex update menus, boot output) belong to boot-prompt wait.
          let pendingScreen;
          try {
            pendingScreen = await readLauncherScreen();
          } catch (readError) {
            if (isSurfaceGoneReadFailure(readError, opts.surface)) {
              throw new SurfaceGoneError(opts.surface, readError);
            }
            return;
          }
          if (
            classifyPendingLauncherLine(
              pendingScreen.text,
              sanitizedCommand,
            ) === "corrupted"
          ) {
            await confirmReadyThenRecoverIfCorrupted();
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (!/Enter submit could not be verified/.test(message)) {
            throw error;
          }
          await confirmReadyThenRecoverIfCorrupted();
        }
      },
      {
        toolName: "send_command",
        workspace: opts.workspace,
        observePtyWrite: true,
        stableSurfaceIdentity: opts.stableSurfaceIdentity,
      },
    );
  };

  const deliverBootPrompt = async (opts: {
    surface: string;
    stableSurfaceIdentity?: string | null;
    workspace?: string;
    cli?: CliType;
    prompt?: string;
    boot_prompt_path?: string | null;
    injected_prompt?: string;
    timeout_ms?: number;
    onUpdateShellRelaunch?: () => Promise<void>;
    resolveRoute?: () => Promise<{ surface: string; workspace?: string }>;
  }): Promise<
    PublicDeliveryReceipt & {
      bytes: number;
      prompt_text: string | null;
      prompt_warning: string | null;
    }
  > => {
    const bootPromptPath = getBootPromptPath(opts.boot_prompt_path);
    assertBootPromptMode(opts.prompt, bootPromptPath);
    if (
      !hasInlinePrompt(opts.prompt) &&
      !bootPromptPath &&
      !hasInlinePrompt(opts.injected_prompt)
    ) {
      return {
        ...buildPublicDeliveryReceipt({
          typed: false,
          submit_attempted: false,
          submit_verified: null,
          retry_count: 0,
        }),
        bytes: 0,
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
      : (opts.prompt ?? "");
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
      (/[\r\n]/.test(rawPrompt) ||
        rawPrompt.length > SEND_INPUT_MAX_INLINE_CHARS);
    const promptWarning =
      bootPromptPath &&
      rawPrompt.length > BOOT_PROMPT_PATH_WARNING_CHARS &&
      !useFilePointer
        ? `boot_prompt_path is ${rawPrompt.length} characters; prefer a one-line file pointer for boot prompts over ${BOOT_PROMPT_PATH_WARNING_CHARS} characters`
        : null;
    const callerDeliveryText = useFilePointer
      ? `Read and follow ${bootPromptPath}`
      : rawPrompt;
    const deliveryText = [callerDeliveryText, opts.injected_prompt]
      .filter((part): part is string => hasInlinePrompt(part))
      .join("\n\n");
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
          executeDeliveryEngine({
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
          stableSurfaceIdentity: opts.stableSurfaceIdentity,
        },
      );
      return {
        ...delivery,
        prompt_text: hasInlinePrompt(rawPrompt) ? rawPrompt : null,
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
          try {
            await waitForBootPromptSubmitEvidence({
              surface: deliveryRoute.surface,
              workspace: deliveryRoute.workspace,
              text: sanitizedText,
              timeout_ms: opts.timeout_ms ?? BOOT_PROMPT_TIMEOUT_MS,
              baseline_metrics: readiness.metrics,
              beforeRead: assertDeliveryRouteCurrent,
            });
          } catch (fallbackError) {
            if (fallbackError instanceof SurfaceGoneError) {
              throw fallbackError;
            }
            const deliveredChars = chunks
              .slice(0, sentChunks)
              .reduce((sum, chunk) => sum + chunk.length, 0);
            const fallbackMessage =
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError);
            throw new BootPromptDeliveryError(
              `Boot prompt delivery failed after ${deliveredChars} chars: ${fallbackMessage}`,
              deliveredChars,
              error,
            );
          }
          return {
            ...buildPublicDeliveryReceipt({
              delivery_state: "submitted",
              typed: true,
              submit_attempted: true,
              submit_verified: true,
              retry_count: error.retry_count,
            }),
            bytes: Buffer.byteLength(sanitizedText, "utf8"),
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
        error instanceof SubmitVerificationError ? error : undefined,
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
    const aliasNormalized = normalizeWorkspaceRefAlias(normalized);
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
    const callerContext = currentCallerContext();
    const workspaceCandidate = callerContext?.workspaceId?.trim();
    const candidates = [workspaceCandidate, callerContext?.tabId].filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    try {
      const { workspaces } = await client.listWorkspaces();
      for (const candidate of candidates) {
        const match = workspaces.find((workspace) =>
          envWorkspaceMatches(workspace, candidate),
        );
        if (match) return match.ref;
      }
    } catch {
      // A request-scoped workspace ID remains authoritative when enumeration
      // is temporarily unavailable; only daemon env and UI focus are banned.
    }
    return workspaceCandidate
      ? normalizeWorkspaceRefAlias(workspaceCandidate)
      : undefined;
  };

  /** Per-request caller workspace only; shared-daemon env/focus are not caller identity. */
  const currentCallerWorkspace = async (): Promise<string | undefined> => {
    return callerWorkspaceStrict();
  };

  /**
   * Caller workspace for mutation safety only. In-process runtimes have no
   * transport metadata, so their process-local env can supplement the strict
   * request context without ever influencing spawn placement.
   */
  const currentSafetyCallerWorkspace = async (): Promise<
    string | undefined
  > => {
    const requestWorkspace = await callerWorkspaceStrict();
    if (requestWorkspace) return requestWorkspace;
    const fallbackWorkspace =
      opts?.safetyCallerContextProvider?.()?.workspaceId;
    return fallbackWorkspace
      ? await canonicalWorkspaceRef(fallbackWorkspace)
      : undefined;
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

  type FocusTarget = {
    workspace: string;
    surface?: string;
  };

  type FocusRestoreLease = {
    prior: FocusTarget;
    expected: FocusTarget;
  };

  /** Currently-focused workspace and surface, with workspace-only fallback. */
  const currentFocusTarget = async (): Promise<FocusTarget | null> => {
    try {
      const focused = (await client.identify()).focused;
      if (focused?.workspace_ref) {
        return {
          workspace: focused.workspace_ref,
          ...(focused.surface_ref ? { surface: focused.surface_ref } : {}),
        };
      }
    } catch {
      // Older/degraded transports may not expose global focus via identify.
    }
    const workspace = await currentFocusedWorkspace();
    return workspace ? { workspace } : null;
  };

  class PlacementWorkspaceError extends Error {
    readonly code = PLACEMENT_WORKSPACE_UNRESOLVED;

    constructor(message: string) {
      super(message);
      this.name = "PlacementWorkspaceError";
    }
  }

  const assertWorkspaceBelongsToRepo = async (
    workspaceRef: string,
    repo: string | null | undefined,
  ): Promise<void> => {
    if (!repo) return;
    let workspace: CmuxWorkspace | undefined;
    try {
      const listed = await client.listWorkspaces();
      workspace = listed.workspaces.find((candidate) =>
        envWorkspaceMatches(candidate, workspaceRef),
      );
    } catch {
      return;
    }
    const cwd = workspace?.current_directory?.trim();
    if (!cwd || workspaceDirectoryRepoMatchScore(repo, cwd) > 0) return;
    const title = workspace?.title?.trim();
    const titleCandidates = [inferRepoFromLauncherTitle(title), title].filter(
      (candidate, index, all): candidate is string =>
        Boolean(candidate) && all.indexOf(candidate) === index,
    );
    const identifiedRepo = titleCandidates.find(
      (candidate) => workspaceDirectoryRepoMatchScore(candidate, cwd) > 0,
    );
    if (!identifiedRepo || reposEquivalent(identifiedRepo, repo)) return;
    throw new PlacementWorkspaceError(
      `Refused placement in ${workspace?.ref ?? workspaceRef}: workspace directory ${cwd} does not belong to repo ${repo}`,
    );
  };

  const resolvePlacementWorkspace = async (opts: {
    explicitWorkspace?: string;
    callerWorkspace?: string;
    repo?: string | null;
  }): Promise<{ workspace?: string; warnings: string[] }> => {
    const explicitWorkspace = opts.explicitWorkspace
      ? await canonicalWorkspaceRef(opts.explicitWorkspace)
      : undefined;
    if (explicitWorkspace) {
      await assertWorkspaceBelongsToRepo(explicitWorkspace, opts.repo);
      return { workspace: explicitWorkspace, warnings: [] };
    }

    const callerWorkspace =
      opts.callerWorkspace ?? (await callerWorkspaceStrict());
    if (callerWorkspace) {
      await assertWorkspaceBelongsToRepo(callerWorkspace, opts.repo);
      return { workspace: callerWorkspace, warnings: [] };
    }

    const repoWorkspace = await resolveWorkspaceForRepo(opts.repo);
    if (repoWorkspace) return { workspace: repoWorkspace, warnings: [] };

    throw new PlacementWorkspaceError(
      "Spawn placement requires an explicit workspace, per-request caller workspace, or matching repo workspace; focused workspace and shared-daemon environment fallbacks are forbidden",
    );
  };

  const resolveAnchorWorkspace = async (opts: {
    pane?: string;
    surface?: string;
  }): Promise<string> => {
    if (opts.surface) {
      try {
        const identified = await client.identify(opts.surface);
        const workspace = identified.caller?.workspace_ref;
        if (workspace) {
          return (await canonicalWorkspaceRef(workspace)) ?? workspace;
        }
      } catch (error) {
        const message = error instanceof Error ? `: ${error.message}` : "";
        throw new PlacementWorkspaceError(
          `Unable to resolve current workspace for surface anchor ${opts.surface}${message}`,
        );
      }
      throw new PlacementWorkspaceError(
        `Unable to resolve current workspace for surface anchor ${opts.surface}`,
      );
    }

    if (!opts.pane) {
      throw new PlacementWorkspaceError(
        "Anchored split requires a pane or surface anchor",
      );
    }

    try {
      const { workspaces } = await client.listWorkspaces();
      const paneLists = await Promise.all(
        workspaces.map(async (workspace) => ({
          workspace: workspace.ref,
          panes: (await client.listPanes({ workspace: workspace.ref })).panes,
        })),
      );
      const matches = paneLists
        .filter(({ panes }) =>
          panes.some((pane) => pane.ref === opts.pane || pane.id === opts.pane),
        )
        .map(({ workspace }) => workspace);
      if (matches.length === 1) {
        return matches[0]!;
      }
      if (matches.length > 1) {
        throw new PlacementWorkspaceError(
          `Pane anchor ${opts.pane} is ambiguous across workspaces: ${matches.join(", ")}`,
        );
      }
    } catch (error) {
      if (error instanceof PlacementWorkspaceError) throw error;
      const message = error instanceof Error ? `: ${error.message}` : "";
      throw new PlacementWorkspaceError(
        `Unable to resolve current workspace for pane anchor ${opts.pane}${message}`,
      );
    }
    throw new PlacementWorkspaceError(
      `Unable to resolve current workspace for pane anchor ${opts.pane}`,
    );
  };

  const resolveAnchoredPlacement = async (opts: {
    explicitWorkspace?: string;
    pane?: string;
    surface?: string;
    repo?: string | null;
  }): Promise<{ workspace: string; warnings: string[] }> => {
    const anchor = opts.surface ?? opts.pane ?? "anchor";
    const anchorWorkspace = await resolveAnchorWorkspace({
      pane: opts.pane,
      surface: opts.surface,
    });
    const targetResolution = await resolvePlacementWorkspace({
      explicitWorkspace: opts.explicitWorkspace,
      repo: opts.repo,
    });
    const validatedWorkspace = targetResolution.workspace;
    if (!validatedWorkspace || anchorWorkspace !== validatedWorkspace) {
      throw new PlacementWorkspaceError(
        `Refused ${anchor} anchored placement: anchor currently resolves to ${anchorWorkspace}, but validated placement workspace is ${validatedWorkspace ?? "unresolved"}`,
      );
    }
    return { ...targetResolution, workspace: anchorWorkspace };
  };

  /** Capture origin focus, select the placement workspace, and record the
   * exact focus state caused by that selection. The expected state is refreshed
   * immediately after pane creation so restoration never depends on whether a
   * cmux transport focuses newly-created surfaces by default.
   */
  const focusTargetBeforeSplit = async (
    targetWorkspace: string | undefined,
    restore = true,
    capturedPrior?: FocusTarget | null,
  ): Promise<FocusRestoreLease | null> => {
    if (!targetWorkspace) return null;
    const prior =
      capturedPrior === undefined ? await currentFocusTarget() : capturedPrior;
    const placementFocus =
      capturedPrior === undefined ? prior : await currentFocusTarget();
    if (!placementFocus || placementFocus.workspace !== targetWorkspace) {
      await client.selectWorkspace(targetWorkspace);
    }
    if (!prior || !restore) return null;
    const expected = await currentFocusTarget();
    // Without an exact expected surface, a later same-workspace user move
    // cannot be distinguished from cmuxlayer's own placement focus.
    if (!expected?.surface) return null;
    return { prior, expected };
  };

  /** Refresh the lease immediately after the surface mutation. */
  const capturePostCreationFocus = async (
    lease: FocusRestoreLease | null,
    created?: { surface: string; workspace?: string },
  ): Promise<FocusRestoreLease | null> => {
    if (!lease) return null;
    if (created?.surface) {
      return {
        ...lease,
        expected: {
          workspace: created.workspace ?? lease.expected.workspace,
          surface: created.surface,
        },
      };
    }
    const expected = await currentFocusTarget();
    return expected?.surface ? { ...lease, expected } : lease;
  };

  const sameExactFocus = (left: FocusTarget, right: FocusTarget): boolean =>
    Boolean(
      left.surface &&
      right.surface &&
      left.workspace === right.workspace &&
      left.surface === right.surface,
    );

  /**
   * Restore the prior surface AFTER the new terminal is fully rendered. Waits
   * for shell readiness so focus is not restored mid-render. Restores focus
   * even if readiness times out (never strand focus on the spawned pane).
   */
  const restoreFocusAfterRender = async (
    lease: FocusRestoreLease | null,
    surface: string | undefined,
    workspace: string | undefined,
    opts?: { waitForReady?: boolean },
  ): Promise<string | null> => {
    if (!lease) return null;
    if (surface && opts?.waitForReady !== false) {
      try {
        await waitForLaunchShellReady({ surface, workspace });
      } catch {
        // Readiness timed out — restore focus anyway rather than strand it.
      }
    }
    const current = await currentFocusTarget();
    // The user may deliberately move while a pane boots. Restore only while
    // focus still exactly matches the post-creation state cmuxlayer caused.
    if (!current || !sameExactFocus(current, lease.expected)) return null;
    try {
      if (lease.prior.surface) {
        await client.focusSurface(lease.prior.surface, {
          workspace: lease.prior.workspace,
        });
        return null;
      }
      await client.selectWorkspace(lease.prior.workspace);
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return `Focus restore failed: ${message}`;
    }
  };

  /** Explicit focus:true is best-effort so the created handle is never lost. */
  const focusCreatedSurface = async (
    surface: string,
    workspace: string | undefined,
  ): Promise<string | null> => {
    try {
      await client.focusSurface(surface, { workspace });
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return `Focus request failed: ${message}`;
    }
  };

  const startBackgroundDelivery = (record: DeliveryRecord) => {
    // Preserve the backend owner that accepted the asynchronous write. Reading
    // the observer after completion could attribute old-backend evidence to a
    // new backend that reused the same mutable ref.
    record.surfaceObserverIdentity = context.surfaceObserverId;
    record.lockKey = record.stableSurfaceIdentity
      ? `uuid:${record.stableSurfaceIdentity.toLowerCase()}`
      : record.surface;
    acquireSurfaceWrite(record.lockKey, record.delivery_id);
    deliveries.set(record.delivery_id, record);
    latestDeliveryBySurface.set(record.surface, record.delivery_id);
    activeDeliveryBySurface.set(record.surface, record.delivery_id);
    pruneCompletedDeliveryHistory(record.surface);

    const run = async () => {
      try {
        const delivery = await executeDeliveryEngine({
          surface: record.surface,
          workspace: record.workspace,
          chunks: record.chunks,
          chunk_size: record.chunk_size,
          chunk_delay_ms: record.chunk_delay_ms,
          press_enter: record.press_enter,
          rename_to_task: record.rename_to_task,
          stableSurfaceIdentity: record.stableSurfaceIdentity,
          source_event: "send_input",
          verify_submit: record.verify_submit,
          beforeMutation: record.beforeMutation,
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
          record.submit_verification_reason = error.reason;
          record.retry_safe = error.retry_safe;
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
    (): SurfaceObserverIdProvider | undefined => () =>
      context.surfaceObserverEpoch;

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

  const resetCapturedSurfaceIdentitiesForObserver = (): string | null => {
    const observerEpoch = context.surfaceObserverEpoch;
    if (context.capturedSurfaceObserverEpoch !== observerEpoch) {
      context.capturedSurfaceUuidByRef.clear();
      context.ambiguousCapturedSurfaceRefs.clear();
      context.capturedSurfaceObserverEpoch = observerEpoch;
    }
    return observerEpoch;
  };

  const captureSurfaceIdentities = (
    surfaceIdByRef: ReadonlyMap<string, string>,
    observedEpoch: string | null,
  ): void => {
    const currentEpoch = context.surfaceObserverEpoch;
    if (!observedEpoch || currentEpoch !== observedEpoch) return;
    if (context.capturedSurfaceObserverEpoch !== observedEpoch) {
      context.capturedSurfaceUuidByRef.clear();
      context.ambiguousCapturedSurfaceRefs.clear();
      context.capturedSurfaceObserverEpoch = observedEpoch;
    }
    for (const [surfaceRef, surfaceUuid] of surfaceIdByRef) {
      const capturedUuid = context.capturedSurfaceUuidByRef.get(surfaceRef);
      if (!capturedUuid) {
        // A ref is a caller-visible handle for the first UUID observed there.
        // Never overwrite it with a later occupant after refs renumber/recycle.
        context.capturedSurfaceUuidByRef.set(surfaceRef, surfaceUuid);
      } else if (capturedUuid.toLowerCase() !== surfaceUuid.toLowerCase()) {
        context.ambiguousCapturedSurfaceRefs.add(surfaceRef);
      }
    }
  };

  const findSurfaceRefByUuid = (
    topology: SurfaceTopologySnapshot,
    surfaceUuid: string,
  ): string | null => {
    const uuidKey = surfaceUuid.trim().toLowerCase();
    return (
      [...topology.surfaceRefById].find(
        ([observedUuid]) => observedUuid.trim().toLowerCase() === uuidKey,
      )?.[1] ?? null
    );
  };

  type RawSurfaceMutationRoute = {
    surface: string;
    workspace?: string;
    /** Live cmux tab title for this surface when topology knows it. */
    title: string | null;
    stableSurfaceIdentity: string | null;
    remapped_from?: string;
    remapped_to?: string;
    assertCurrent: () => Promise<void>;
  };

  const remapFields = (
    route: RawSurfaceMutationRoute,
  ): Pick<RawSurfaceMutationRoute, "remapped_from" | "remapped_to"> =>
    route.remapped_from && route.remapped_to
      ? {
          remapped_from: route.remapped_from,
          remapped_to: route.remapped_to,
        }
      : {};

  /**
   * Bind a caller-visible mutable ref to a stable UUID before terminal I/O.
   * Old/ref-only cmux clients retain compatibility, but once UUID evidence has
   * been captured the route always fails closed if that UUID is absent.
   */
  const resolveRawSurfaceMutationRoute = async (
    requestedSurface: string,
    requestedWorkspace: string | undefined,
    operation: string,
  ): Promise<RawSurfaceMutationRoute> => {
    const explicitWorkspace = requestedWorkspace
      ? normalizeWorkspaceRefAlias(requestedWorkspace)
      : undefined;
    const assertExplicitWorkspace = (
      observedWorkspace: string | undefined,
    ): void => {
      if (
        explicitWorkspace &&
        normalizeWorkspaceRefAlias(observedWorkspace ?? "") !==
          explicitWorkspace
      ) {
        throw new Error(
          `Stable surface binding for ${requestedSurface} belongs to ` +
            `${observedWorkspace ?? "an unknown workspace"}, not the caller's ` +
            `explicit workspace ${explicitWorkspace}; refusing ${operation}.`,
        );
      }
    };
    resetCapturedSurfaceIdentitiesForObserver();
    const capturedUuid = context.capturedSurfaceUuidByRef.get(requestedSurface);
    const registryUuids = new Set(
      stateMgr
        .listStates()
        .filter((record) => record.surface_id === requestedSurface)
        .map((record) => record.surface_uuid?.trim())
        .filter((uuid): uuid is string => Boolean(uuid)),
    );
    const registryUuid =
      registryUuids.size === 1 ? [...registryUuids][0] : null;
    const expectedUuid = capturedUuid ?? registryUuid;
    const topologyObserverEpoch = context.surfaceObserverEpoch;
    const topology = await collectSurfaceTopology();
    const withSurfaceRemap = (
      route: Omit<RawSurfaceMutationRoute, "remapped_from" | "remapped_to">,
    ): RawSurfaceMutationRoute =>
      route.surface !== requestedSurface
        ? {
            ...route,
            remapped_from: requestedSurface,
            remapped_to: route.surface,
          }
        : route;
    const throwStaleSurfaceRef = (
      snapshot: SurfaceTopologySnapshot | null,
      diagnostic?: string,
    ): never => {
      const liveAgents: Array<{ agent_id: string; surface_id: string }> = [];
      const seen = new Set<string>();
      for (const record of stateMgr.listStates()) {
        const uuid = record.surface_uuid?.trim();
        const currentRef =
          uuid && snapshot ? findSurfaceRefByUuid(snapshot, uuid) : null;
        const liveRef =
          currentRef ??
          (snapshot?.workspaceBySurface.has(record.surface_id)
            ? record.surface_id
            : null);
        if (!liveRef || seen.has(record.agent_id)) continue;
        seen.add(record.agent_id);
        liveAgents.push({ agent_id: record.agent_id, surface_id: liveRef });
      }
      const occupancy =
        liveAgents.length === 1
          ? `${requestedSurface} is stale; agent ${liveAgents[0].agent_id} is alive at ${liveAgents[0].surface_id} — use agent_id`
          : liveAgents.length > 1
            ? `${requestedSurface} is stale; live managed agents: ${liveAgents
                .map((agent) => `${agent.agent_id} at ${agent.surface_id}`)
                .join(", ")} — use agent_id`
            : `${requestedSurface} is stale; no live managed agent maps this ref`;
      throw new Error(diagnostic ? `${occupancy} (${diagnostic})` : occupancy);
    };

    if (topology?.complete === true) {
      const uuidTargetRef = findSurfaceRefByUuid(topology, requestedSurface);
      captureSurfaceIdentities(topology.surfaceIdByRef, topologyObserverEpoch);
      const currentUuidAtRequestedRef =
        topology.surfaceIdByRef.get(requestedSurface) ?? null;
      if (
        (expectedUuid &&
          currentUuidAtRequestedRef &&
          expectedUuid.toLowerCase() !==
            currentUuidAtRequestedRef.toLowerCase()) ||
        context.ambiguousCapturedSurfaceRefs.has(requestedSurface)
      ) {
        throw new Error(
          `Mutable surface ref ${requestedSurface} was observed for multiple stable UUIDs; ` +
            `refusing ${operation}. Re-address by agent_id or stable surface UUID.`,
        );
      }
      const stableUuid =
        expectedUuid ??
        (uuidTargetRef ? requestedSurface : null) ??
        topology.surfaceIdByRef.get(requestedSurface) ??
        null;

      if (stableUuid) {
        const currentRef = findSurfaceRefByUuid(topology, stableUuid);
        if (!currentRef) {
          return throwStaleSurfaceRef(
            topology,
            `Stable surface UUID ${stableUuid} captured for ${requestedSurface} ` +
              `is no longer live; refusing ${operation} rather than using a recycled ref.`,
          );
        }
        const observedWorkspace = topology.workspaceBySurface.get(currentRef);
        assertExplicitWorkspace(observedWorkspace);
        const workspace = observedWorkspace ?? explicitWorkspace;
        const assertCurrent = async (): Promise<void> => {
          const current = await collectSurfaceTopology();
          const currentRefForUuid =
            current?.complete === true
              ? findSurfaceRefByUuid(current, stableUuid)
              : null;
          const currentWorkspace = currentRefForUuid
            ? current?.workspaceBySurface.get(currentRefForUuid)
            : null;
          if (
            !current ||
            current.complete !== true ||
            currentRefForUuid !== currentRef ||
            (currentWorkspace ?? null) !== (workspace ?? null)
          ) {
            throw new Error(
              `Stable surface UUID ${stableUuid} changed or disappeared during ` +
                `${operation}; refusing terminal mutation.`,
            );
          }
        };
        return withSurfaceRemap({
          surface: currentRef,
          workspace,
          title: topology.titleBySurface.get(currentRef) ?? null,
          stableSurfaceIdentity: stableUuid,
          assertCurrent,
        });
      }

      if (
        topology.surfaceIdByRef.size > 0 ||
        topology.surfaceRefById.size > 0
      ) {
        throwStaleSurfaceRef(topology);
      }

      if (!topology.workspaceBySurface.has(requestedSurface)) {
        throwStaleSurfaceRef(topology);
      }

      const workspace =
        topology.workspaceBySurface.get(requestedSurface) ?? explicitWorkspace;
      assertExplicitWorkspace(workspace);
      return {
        surface: requestedSurface,
        workspace,
        title: topology.titleBySurface.get(requestedSurface) ?? null,
        stableSurfaceIdentity: null,
        assertCurrent: async () => {
          const current = await collectSurfaceTopology();
          if (
            current?.complete !== true ||
            current.surfaceIdByRef.size !== 0 ||
            !current.workspaceBySurface.has(requestedSurface)
          ) {
            throw new Error(
              `Ref-only surface ${requestedSurface} is no longer uniquely live; ` +
                `refusing ${operation}.`,
            );
          }
        },
      };
    }

    if (expectedUuid) {
      throw new Error(
        `Stable surface UUID ${expectedUuid} captured for ${requestedSurface} ` +
          `could not be resolved in fresh topology; refusing ${operation}.`,
      );
    }

    // Compatibility for pre-UUID/mock connectors that cannot produce a
    // complete topology. No stable claim has been made, so preserve ref I/O.
    return {
      surface: requestedSurface,
      workspace: explicitWorkspace,
      title: null,
      stableSurfaceIdentity: null,
      assertCurrent: async () => {},
    };
  };

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
    (await collectSurfaceTopology())?.workspaceBySurface.get(surfaceRef) ??
    null;

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

  const resolveCodexAgentForSurface = (
    surfaceRef: string,
    topology: SurfaceTopologySnapshot | null,
  ): AgentRecord | null => {
    const candidates = stateMgr
      .listStates()
      .filter(
        (agent) =>
          agent.cli === "codex" &&
          Boolean(agent.surface_uuid?.trim()) &&
          Boolean(agent.cli_session_path),
      )
      .sort((a, b) => {
        if (b.version !== a.version) return b.version - a.version;
        return (
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      });

    for (const candidate of candidates) {
      const binding = resolveAuthorizedAgentSurfaceBinding(candidate, topology);
      if (binding?.surfaceRef === surfaceRef) return candidate;
    }
    return null;
  };

  const readCodexRolloutFill = async (
    agent: AgentRecord | null,
  ): Promise<CodexRolloutFill | null> => {
    const path =
      agent?.cli === "codex" && Boolean(agent.surface_uuid?.trim())
        ? agent.cli_session_path
        : null;
    if (!path) return null;
    try {
      return await context.codexRolloutFillProvider.get(path);
    } catch {
      return null;
    }
  };

  const sameCodexSessionBinding = (
    before: AgentRecord | null,
    after: AgentRecord | null,
  ): AgentRecord | null => {
    if (!before || !after) return null;
    if (before.cli !== "codex" || after.cli !== "codex") return null;
    if (before.agent_id !== after.agent_id) return null;
    if (
      before.surface_uuid?.trim().toLowerCase() !==
      after.surface_uuid?.trim().toLowerCase()
    ) {
      return null;
    }
    return before.cli_session_path === after.cli_session_path ? after : null;
  };

  const validateCodexRolloutFill = async (
    agent: AgentRecord | null,
    expectedSurfaceRef: string | null,
    fill: CodexRolloutFill | null,
  ): Promise<CodexRolloutFill | null> => {
    if (!agent || !expectedSurfaceRef || !fill) return null;
    const current = stateMgr.readState(agent.agent_id);
    if (!sameCodexSessionBinding(agent, current)) return null;
    const topology = await collectSurfaceTopology().catch(() => null);
    const binding = current
      ? resolveAuthorizedAgentSurfaceBinding(current, topology)
      : null;
    return binding?.surfaceRef === expectedSurfaceRef ? fill : null;
  };

  const applyCodexRolloutFill = (
    parsed: ParsedScreenResult,
    fill: CodexRolloutFill | null,
  ): ParsedScreenResult =>
    fill
      ? {
          ...parsed,
          token_count: fill.token_count,
          context_window: fill.context_window,
          context_pct: fill.context_pct,
        }
      : parsed;

  const evaluateServerAgentHealth = async (
    agent: AgentRecord,
    overrides?: AgentHealthInputOverrides,
    topologyOverride?: SurfaceTopologySnapshot | null,
  ) => {
    const parent = agent.parent_agent_id
      ? (context.lifecycleRegistry?.get(agent.parent_agent_id) ??
        stateMgr.readState(agent.parent_agent_id))
      : null;
    const parentRole = parent ? inferRecordRoleOrNull(parent) : null;
    const topology =
      topologyOverride === undefined
        ? await collectSurfaceTopology()
        : topologyOverride;
    const binding = resolveAuthorizedAgentSurfaceBinding(agent, topology);
    let parsedSurface: Awaited<ReturnType<typeof readParsedSurface>> = null;
    if (
      binding &&
      (overrides?.screen_status === undefined ||
        overrides?.screen_agent_type === undefined ||
        overrides?.screen_control_state === undefined ||
        overrides?.screen_actions === undefined)
    ) {
      parsedSurface = await readParsedSurface(
        binding.surfaceRef,
        binding.workspaceId ?? undefined,
        { agent },
      );
    }
    const surfaceOverrides = healthTopologyOverrides(
      agent,
      binding ? topology : null,
    );
    const safeSurfaceOverrides: AgentHealthInputOverrides = {
      ...surfaceOverrides,
      screen_status:
        overrides?.screen_status !== undefined
          ? overrides.screen_status
          : binding
            ? (parsedSurface?.parsed.status ?? null)
            : null,
      screen_agent_type:
        overrides?.screen_agent_type !== undefined
          ? overrides.screen_agent_type
          : binding
            ? (parsedSurface?.parsed.agent_type ?? null)
            : null,
      screen_control_state:
        overrides?.screen_control_state !== undefined
          ? overrides.screen_control_state
          : binding
            ? (parsedSurface?.parsed.control_state ?? null)
            : null,
      screen_actions:
        overrides?.screen_actions !== undefined
          ? overrides.screen_actions
          : binding
            ? (parsedSurface?.parsed.actions ?? null)
            : null,
      surface_write_liveness: binding
        ? surfaceWriteLiveness.observe(
            binding.surfaceRef,
            agent.surface_uuid,
            agent.surface_observer_id,
          )
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
          return readMonitorRegistry(monitorRegistryOptions())
            .monitors.filter(
              (monitor) =>
                monitor.state === "collapsed" && owners.has(monitor.owner_seat),
            )
            .map((monitor) => ({
              monitor_id: monitor.monitor_id,
              reason: monitor.collapsed_reason ?? "unknown",
            }));
        },
      },
      {
        ...overrides,
        parent_role: overrides?.parent_role ?? parentRole,
        ...safeSurfaceOverrides,
      },
    );
    const health = evaluateAgentHealth(agent, input);
    return {
      ...health,
      ...(parsedSurface
        ? {
            screen_observation: {
              observed_at_ms: Date.now(),
              status: parsedSurface.parsed.status,
              agent_type: parsedSurface.parsed.agent_type,
              control_state: parsedSurface.parsed.control_state,
              model: parsedSurface.parsed.model,
            },
          }
        : {}),
    };
  };

  const spawnDeliveryWorkspace = (
    result: { workspace_id?: string },
    fallback?: string,
  ): string | undefined => result.workspace_id || fallback;

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
          { agent },
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
    "List workspace, pane, and surface topology. Condensed by default; verbose=true adds raw cmux fields.",
    {
      workspace: z.string().optional().describe("Filter by workspace ref"),
      verbose: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Return all raw cmux fields instead of the condensed default. This materially increases token usage and is rarely needed; use it only when a specific raw field is required.",
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
        const listingObserverEpoch = context.surfaceObserverEpoch;
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
        const paneByWorkspaceAndRef = new Map<
          string,
          Record<string, unknown>
        >();
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
        const surfacesWithStableIds = enrichSurfaceIdsFromPanes(
          panesByWorkspace.map(({ workspaceRef, panes }) => ({
            ref: workspaceRef,
            panes,
          })),
          surfaceGroups,
        );
        const stableIdByRef = new Map(
          surfacesWithStableIds.flatMap((surface) =>
            surface.id ? [[surface.ref, surface.id] as const] : [],
          ),
        );
        captureSurfaceIdentities(stableIdByRef, listingObserverEpoch);
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
              ...(surface.id || !stableIdByRef.has(surface.ref)
                ? {}
                : { id: stableIdByRef.get(surface.ref) }),
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
        const existing = readMonitorRegistry(
          monitorRegistryOptions(),
        ).monitors.find(
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
          await currentSafetyCallerWorkspace(),
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
        const callerWorkspace = await currentSafetyCallerWorkspace();
        const deletingCallerWorkspace = callerWorkspace === targetWorkspace;

        if (!args.force && (deletingCallerWorkspace || liveAgents.length > 0)) {
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
        const removedWorkspace = workspaces.find(
          (workspace) => workspace.ref === targetWorkspace,
        ) ?? {
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
    `${PANE_INPUT_BREAKAGE_GUIDANCE} Create a new split pane (terminal or browser). PLACEMENT IS BY ROLE, NOT BY HAND: pass \`role\` (or let it infer from the launcher title) and the layout policy enforces the two-column invariant — leads/orchestrators land in the LEFT column, workers land in the RIGHT column, and extra workers dock as tabs in the rightmost worker pane (never a third column). Workspace-targeted splits auto-focus the target before splitting and restore your prior focus after the new pane renders, so you do not hand-run focus-pane around splits. For terminal panes that boot an agent, boot_prompt_path safely submits multiline or over-cap files as one \`Read and follow <path>\` pointer after the agent reaches a ready prompt.`,
    {
      direction: z
        .enum(["left", "right", "up", "down"])
        .optional()
        .default("right")
        .describe(
          "Split-direction hint for direct placement; role-based placement may override it. Defaults to right.",
        ),
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
      role: legacyCompatibleAgentRoleSchema()
        .optional()
        .describe(
          "Agent role drives deterministic column placement: orchestrator → LEFT column (leads, the Claude that coordinates), worker → RIGHT column (Codex/Cursor that implement/gather). Defaults from title launcher suffix: *Claude=orchestrator, *Codex/*Cursor=worker. Pass this instead of trying to control left/right via direction.",
        ),
      focus: z
        .boolean()
        .optional()
        .describe(
          "Set true to focus the new pane and leave focus there; otherwise cmuxlayer restores the exact origin after render",
        ),
      boot_prompt_path: z
        .string()
        .nullable()
        .optional()
        .describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Pass the readable prompt-file path here. It is checked before pane creation and delivered as one \`Read and follow <path>\` pointer after readiness when multiline or over-cap; shorter files retain direct delivery. Mutually exclusive with inline prompt fields.`,
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
      let focusRestoreLease: FocusRestoreLease | null = null;
      const creation = new CreatedIdentityScope();
      try {
        const normalizedRole = normalizeToolAgentRole(args.role, "role");
        const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
        const shouldInferRole =
          Boolean(normalizedRole.role) ||
          (!args.pane &&
            !args.surface &&
            canInferAgentRole({ title: args.title }));
        const inferredRole = shouldInferRole
          ? inferAgentRole({ role: normalizedRole.role, title: args.title })
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
        const placementRepo = inferRepoFromLauncherTitle(args.title);
        const targetResolution =
          args.pane || args.surface
            ? await resolveAnchoredPlacement({
                explicitWorkspace: args.workspace,
                pane: args.pane,
                surface: args.surface,
                repo: placementRepo,
              })
            : await resolvePlacementWorkspace({
                explicitWorkspace: args.workspace,
                repo: placementRepo,
              });
        if (inferredRole && (args.type ?? "terminal") === "terminal") {
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
        }
        const targetWorkspace = targetResolution.workspace;
        if (args.surface) {
          await assertSurfaceMutationAllowed(
            "new_split",
            args.surface,
            targetWorkspace,
          );
        } else {
          await assertWorkspaceMutationAllowed("new_split", targetWorkspace);
        }

        // Auto-focus only applies to workspace-targeted splits (no explicit
        // pane/surface anchor). Captured right before creation, AFTER all
        // validation, so a rejected request has no focus side effects.
        let focusRequestWarning: string | null = null;
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
          // Role-based placement has no explicit pane/surface (validated above),
          // so it is always a workspace-targeted split — apply auto-focus.
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
          focusRestoreLease = await focusTargetBeforeSplit(
            targetWorkspace,
            args.focus !== true,
          );
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
                });
          creation.record({
            surface: result.surface,
            workspace: result.workspace,
            ...(result.surface_id ? { surface_id: result.surface_id } : {}),
          });
          assertSurfaceObserverEpochCurrent(
            rolePlacementObserverEpoch,
            "role-based new_split placement",
          );
        } else {
          // Only workspace-targeted splits need auto-focus; an explicit
          // pane/surface anchor already pins the destination workspace.
          if (!args.pane && !args.surface) {
            focusRestoreLease = await focusTargetBeforeSplit(
              targetWorkspace,
              args.focus !== true,
            );
          }
          result = await client.newSplit(args.direction, {
            workspace: targetWorkspace,
            surface: args.surface,
            pane: args.pane,
            type: args.type,
            url: args.url,
            title: args.title,
          });
          creation.record({
            surface: result.surface,
            workspace: result.workspace,
            ...(result.surface_id ? { surface_id: result.surface_id } : {}),
          });
        }
        if (args.focus === true) {
          focusRequestWarning = await focusCreatedSurface(
            result.surface,
            result.workspace || targetWorkspace,
          );
        } else {
          focusRestoreLease = await capturePostCreationFocus(focusRestoreLease);
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
          Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
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
        const focusRestoreWarning = await restoreFocusAfterRender(
          focusRestoreLease,
          result.surface,
          result.workspace || targetWorkspace,
          { waitForReady: !bootPromptPath },
        );
        const data: Record<string, unknown> = { ...result };
        data.placement = actualPlacement;
        data.direction = actualDirection;
        const responseWarnings = [
          ...targetResolution.warnings,
          ...(normalizedRole.warning ? [normalizedRole.warning] : []),
          ...(focusRequestWarning ? [focusRequestWarning] : []),
          ...(focusRestoreWarning ? [focusRestoreWarning] : []),
        ];
        if (responseWarnings.length > 0) {
          data.warning = responseWarnings.join(" | ");
          data.warnings = responseWarnings;
        }
        if (inferredRole) {
          data.role = inferredRole;
        }
        if (bootPromptDelivery) {
          data.boot_prompt_delivered =
            isBootPromptDelivered(bootPromptDelivery);
          data.boot_prompt_receipt = bootPromptDelivery;
          data.boot_prompt_bytes = bootPromptDelivery.bytes;
          data.boot_prompt_submit_verified = bootPromptDelivery.submit_verified;
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
        const caught = creation.attach(e);
        // Creation or boot delivery may fail after cmuxlayer selected a target
        // workspace. Return focus when the user has not moved since then.
        await restoreFocusAfterRender(
          focusRestoreLease,
          result?.surface,
          result?.workspace,
          { waitForReady: false },
        );
        const createdIdentity = result
          ? {
              surface: result.surface,
              workspace: result.workspace,
              ...(result.surface_id ? { surface_id: result.surface_id } : {}),
            }
          : {};
        if (caught instanceof SurfaceGoneError) {
          return err(caught, surfaceGonePayload(caught, createdIdentity));
        }
        if (caught instanceof BootPromptTimeoutError) {
          return err(caught, {
            ...createdIdentity,
            last_10_lines: caught.last_10_lines,
          });
        }
        if (caught instanceof BootPromptUpdateMenuBlockedError) {
          return err(caught, {
            ...createdIdentity,
            error_code: caught.error_code,
            last_10_lines: caught.last_10_lines,
            recovery: caught.recovery,
          });
        }
        if (caught instanceof BootPromptDeliveryError) {
          return err(caught, {
            ...createdIdentity,
            delivered_chars: caught.delivered_chars,
          });
        }
        return err(caught, createdIdentity);
      }
    },
  );

  // 3. new_surface
  server.tool(
    "new_surface",
    `${PANE_INPUT_BREAKAGE_GUIDANCE} Create a new surface (tab) in an existing pane. For terminal tabs that boot an agent, boot_prompt_path safely submits multiline or over-cap files as one \`Read and follow <path>\` pointer after the agent reaches a ready prompt.`,
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
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Pass the readable prompt-file path here. It is checked before tab creation and delivered as one \`Read and follow <path>\` pointer after readiness when multiline or over-cap; shorter files retain direct delivery.`,
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
      const creation = new CreatedIdentityScope();
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

        const targetResolution = await resolveAnchoredPlacement({
          explicitWorkspace: args.workspace,
          pane: args.pane,
          repo: inferRepoFromLauncherTitle(args.title),
        });
        const targetWorkspace = targetResolution.workspace;
        await assertWorkspaceMutationAllowed("new_surface", targetWorkspace);

        result = await client.newSurface({
          pane: args.pane,
          workspace: targetWorkspace,
          type: args.type,
          url: args.url,
        });
        creation.record({
          surface: result.surface,
          workspace: result.workspace,
          ...(result.surface_id ? { surface_id: result.surface_id } : {}),
        });
        if (args.title) {
          await client.renameTab(result.surface, args.title, {
            workspace: result.workspace || targetWorkspace,
          });
          result.title = args.title;
        }
        let bootPromptDelivery:
          Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
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
        const data: Record<string, unknown> = { ...result };
        if (bootPromptDelivery) {
          data.boot_prompt_delivered =
            isBootPromptDelivered(bootPromptDelivery);
          data.boot_prompt_receipt = bootPromptDelivery;
          data.boot_prompt_bytes = bootPromptDelivery.bytes;
          data.boot_prompt_submit_verified = bootPromptDelivery.submit_verified;
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
        const caught = creation.attach(e);
        const createdIdentity = result
          ? {
              surface: result.surface,
              workspace: result.workspace,
              ...(result.surface_id ? { surface_id: result.surface_id } : {}),
            }
          : {};
        if (caught instanceof SurfaceGoneError) {
          return err(caught, surfaceGonePayload(caught, createdIdentity));
        }
        if (caught instanceof BootPromptTimeoutError) {
          return err(caught, {
            ...createdIdentity,
            last_10_lines: caught.last_10_lines,
          });
        }
        if (caught instanceof BootPromptUpdateMenuBlockedError) {
          return err(caught, {
            ...createdIdentity,
            error_code: caught.error_code,
            last_10_lines: caught.last_10_lines,
            recovery: caught.recovery,
          });
        }
        if (caught instanceof BootPromptDeliveryError) {
          return err(caught, {
            ...createdIdentity,
            delivered_chars: caught.delivered_chars,
          });
        }
        return err(caught, createdIdentity);
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
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          undefined,
          "move_surface",
        );
        const result = await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            return client.moveSurface({
              surface: route.surface,
              pane: args.pane,
              workspace: args.workspace,
              before: args.before,
              after: args.after,
              index: args.index,
              focus: args.focus,
            });
          },
          {
            toolName: "move_surface",
            workspace: route.workspace,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
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
    `${PANE_INPUT_BREAKAGE_GUIDANCE} Low-level surface tool: send text input to a terminal surface. For tracked agents, prefer send_to(agent_id) so cmuxlayer resolves the current backing surface. WARNING — DO NOT include a bare \`@word\` (e.g. \`@narration-lead\`) in text destined for an interactive agent composer (Claude Code / Codex / Cursor TUIs): the receiving composer treats \`@\` as its file-reference trigger and pops a file-picker overlay, swallowing the rest of your message — silent delivery corruption that the ok:true result will NOT report. Use the bare name (\`narration-lead:\`) for pane-to-pane addressing; reserve \`@<name>\` for collab-file posts where monitors match it. If a literal \`@\` is unavoidable, deliver via a file the agent cat-reads, not live keystrokes. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters by default (CMUXLAYER_MAX_INLINE_CHARS, positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}); tracked Codex/Claude/Cursor/Gemini agents also refuse multi-paragraph inline text by default. Pass allow_long_inline:true only for deliberate raw sends. Text over ${SEND_INPUT_CHUNK_THRESHOLD} characters that is allowed is split into line-aligned logical chunks and coalesced into bounded paste batches; each physical paste waits for cmux acknowledgment before the next is sent. Chunked or multiline text is pasted into the composer so embedded newlines do not submit partial messages; press_enter=true presses return once after the final chunk. Paste failure returns an error without pressing Return. Set background=true to return immediately with a delivery_id while chunking continues in the background. For full commands, prefer send_command so text and return land on the same surface atomically. ${ZSH_BANG_INLINE_WARNING}`,
    {
      surface: z.string().describe("Target surface ref"),
      text: z
        .string()
        .describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default.`,
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
        const sourceEvent =
          (
            args as typeof args & {
              _cmuxlayer_source_event?: DeliveryEventType;
            }
          )._cmuxlayer_source_event ?? "send_input";
        assertInlineInputAllowed({
          tool: "send_input",
          arg: "text",
          value: args.text,
          allowLongInline: args.allow_long_inline,
        });
        assertDenseInlineInputAllowed({
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
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "send_input",
        );
        const targetRecord = resolveLatestSurfaceAgentRecord(
          stateMgr,
          route.surface,
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
            route.surface,
            route.workspace,
          );
          await route.assertCurrent();
          const record: DeliveryRecord = {
            delivery_id: randomUUID(),
            surface: route.surface,
            workspace: route.workspace,
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
            stableSurfaceIdentity: route.stableSurfaceIdentity,
            beforeMutation: route.assertCurrent,
          };
          startBackgroundDelivery(record);

          const identity = resolveTargetIdentity(
            stateMgr,
            route.surface,
            route.title,
          );
          const data = {
            ...identity,
            ...buildPublicDeliveryReceipt({
              delivery_state: "queued",
              delivery_id: record.delivery_id,
              typed: false,
              submit_attempted: args.press_enter,
              submit_verified: record.submit_verified,
              retry_count: record.retry_count,
            }),
            status: record.status,
            ...remapFields(route),
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

        const delivery = await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            return executeDeliveryEngine({
              surface: route.surface,
              workspace: route.workspace,
              chunks,
              chunk_size: effectiveChunkSize,
              chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
              press_enter: args.press_enter,
              rename_to_task: args.rename_to_task,
              stableSurfaceIdentity: route.stableSurfaceIdentity,
              source_event: sourceEvent,
              verify_submit: shouldVerifySubmit,
              beforeMutation: route.assertCurrent,
            });
          },
          {
            toolName: "send_input",
            workspace: route.workspace,
            observePtyWrite: true,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );

        const identity = resolveTargetIdentity(
          stateMgr,
          route.surface,
          route.title,
        );
        const data = {
          ...identity,
          ...delivery,
          ...remapFields(route),
        };
        return okFormatted(
          formatDelivery("send_input", {
            ...identity,
            delivered: delivery.delivered,
            pending: delivery.delivery === "queued",
            typed: delivery.typed,
            submit_attempted: delivery.submit_attempted,
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
            ...(e.receipt ?? {}),
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
    `${PANE_INPUT_BREAKAGE_GUIDANCE} Atomically send a command and press return on the same raw surface. Prefer this over separate send_input + send_key calls when launching or resuming agents. If the user provided an exact command, send exactly that command only when it fits the ${SEND_INPUT_MAX_INLINE_CHARS}-character inline cap. WARNING — never include a bare \`@word\` in text destined for an interactive agent composer: it fires the receiver's file-reference picker and corrupts delivery (use the bare name; \`@<name>\` belongs in collab files, not pane keystrokes). For known agent launchers with -s (for example brainlayerCodex -s), boot_prompt_path is checked before launch and safely submits multiline or over-cap files as one \`Read and follow <path>\` pointer after readiness; use it instead of embedding a multi-paragraph boot prompt in pane keystrokes. Passing boot_prompt_path for plain shell commands is rejected. Pass allow_long_inline:true only for deliberate raw long commands. ${ZSH_BANG_INLINE_WARNING}`,
    {
      surface: z.string().describe("Target surface ref"),
      command: z
        .string()
        .describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Command text to send before pressing return. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default; for agent boot prompts, pass boot_prompt_path.`,
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
        assertDenseInlineInputAllowed({
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
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "send_command",
        );
        const targetRecord = resolveLatestSurfaceAgentRecord(
          stateMgr,
          route.surface,
        );
        const shouldVerifySubmit =
          !!targetRecord && INTERACTIVE_AGENT_STATES.has(targetRecord.state);

        const delivery = await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            return executeDeliveryEngine({
              surface: route.surface,
              workspace: route.workspace,
              chunks,
              chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
              chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
              press_enter: true,
              stableSurfaceIdentity: route.stableSurfaceIdentity,
              source_event: "send_command",
              verify_submit: bootPromptPath ? false : shouldVerifySubmit,
              beforeMutation: route.assertCurrent,
            });
          },
          {
            toolName: "send_command",
            workspace: route.workspace,
            observePtyWrite: true,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );

        let bootPromptDelivery:
          Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
        if (bootPromptPath && launcherCli) {
          bootPromptDelivery = await deliverBootPrompt({
            surface: route.surface,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
            workspace: route.workspace,
            cli: launcherCli,
            boot_prompt_path: bootPromptPath,
            timeout_ms: args.boot_prompt_timeout_ms,
            resolveRoute: async () => {
              await route.assertCurrent();
              return { surface: route.surface, workspace: route.workspace };
            },
            onUpdateShellRelaunch: () =>
              sendLauncherCommandToSurface({
                surface: route.surface,
                stableSurfaceIdentity: route.stableSurfaceIdentity,
                workspace: route.workspace,
                command: sanitizedCommand,
                relaunch: true,
                assertSurfaceBindingCurrent: route.assertCurrent,
              }),
          });
        }

        const identity = resolveTargetIdentity(
          stateMgr,
          route.surface,
          route.title,
        );
        const data = {
          ...identity,
          command: sanitizedCommand,
          ...delivery,
          ...remapFields(route),
          boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
          boot_prompt_receipt: bootPromptDelivery,
          boot_prompt_bytes: bootPromptDelivery?.bytes,
          boot_prompt_submit_verified:
            bootPromptDelivery?.submit_verified ?? null,
          boot_prompt_warning: bootPromptDelivery?.prompt_warning ?? null,
        };
        return okFormatted(
          formatDelivery("send_command", {
            ...identity,
            delivered: delivery.delivered,
            pending: delivery.delivery === "queued",
            typed: delivery.typed,
            submit_attempted: delivery.submit_attempted,
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
            ...(e.receipt ?? {}),
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
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "send_key",
        );
        const delivery = await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            return executeDeliveryEngine({
              surface: route.surface,
              workspace: route.workspace,
              chunks: [],
              key,
              chunk_size: 0,
              chunk_delay_ms: 0,
              press_enter: false,
              stableSurfaceIdentity: route.stableSurfaceIdentity,
              source_event: "send_key",
              beforeMutation: route.assertCurrent,
            });
          },
          {
            toolName: "send_key",
            workspace: route.workspace,
            observePtyWrite: true,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
        const data = {
          surface: route.surface,
          key,
          ...delivery,
          ...remapFields(route),
        };
        return okFormatted(formatOk("send_key", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  // 9. read_screen
  server.tool(
    "read_screen",
    "Read a terminal screen and parsed harness status. Use raw=true for full text or parsed_only=true for monitoring.",
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
        let codexAgentBeforeRead: AgentRecord | null = null;
        const hasCodexRolloutCandidate = stateMgr
          .listStates()
          .some(
            (agent) =>
              agent.cli === "codex" &&
              Boolean(agent.surface_uuid?.trim()) &&
              Boolean(agent.cli_session_path),
          );
        if (hasCodexRolloutCandidate) {
          const topologyBeforeRead = await collectSurfaceTopology(
            args.workspace,
          ).catch(() => null);
          codexAgentBeforeRead = resolveCodexAgentForSurface(
            args.surface,
            topologyBeforeRead,
          );
        }
        let result: ReadScreenSnapshot["result"];
        let topology: ReadScreenSnapshot["topology"];
        let screenRemap: Pick<
          RawSurfaceMutationRoute,
          "remapped_from" | "remapped_to"
        > = {};
        const snapshotOpts = {
          surface: args.surface,
          workspace: args.workspace,
          lines: args.lines,
          scrollback: args.scrollback,
        };
        try {
          ({ result, topology } = await readScreenSnapshot(snapshotOpts));
        } catch (readError) {
          const route = await resolveRawSurfaceMutationRoute(
            args.surface,
            args.workspace,
            "read_screen",
          );
          if (route.surface === args.surface) throw readError;
          screenRemap = remapFields(route);
          ({ result, topology } = await readScreenSnapshot({
            ...snapshotOpts,
            surface: route.surface,
            workspace: route.workspace ?? args.workspace,
          }));
          if (hasCodexRolloutCandidate) {
            codexAgentBeforeRead = resolveCodexAgentForSurface(
              route.surface,
              topology,
            );
          }
        }
        const requestedIsLive =
          topology?.workspaceBySurface.has(args.surface) === true ||
          topology?.surfaceIdByRef.has(args.surface) === true;
        if (
          topology?.complete === true &&
          !requestedIsLive &&
          !screenRemap.remapped_from
        ) {
          const route = await resolveRawSurfaceMutationRoute(
            args.surface,
            args.workspace,
            "read_screen",
          );
          screenRemap = remapFields(route);
          if (route.surface !== args.surface) {
            const remapped = await readScreenSnapshot({
              ...snapshotOpts,
              surface: route.surface,
              workspace: route.workspace ?? args.workspace,
            });
            result = remapped.result;
            topology = remapped.topology;
            if (hasCodexRolloutCandidate) {
              codexAgentBeforeRead = resolveCodexAgentForSurface(
                route.surface,
                topology,
              );
            }
          }
        }
        const title = topology?.titleBySurface.get(result.surface) ?? null;
        const { column, column_count } =
          topology?.topologyBySurface.get(result.surface) ??
          EMPTY_SURFACE_TOPOLOGY;
        const codexAgent = sameCodexSessionBinding(
          codexAgentBeforeRead,
          resolveCodexAgentForSurface(result.surface, topology),
        );
        const codexFill = await validateCodexRolloutFill(
          codexAgent,
          result.surface,
          await readCodexRolloutFill(codexAgent),
        );
        const parsed = applyCodexRolloutFill(
          applyHarnessState(
            enrichParsedScreen(
              parseScreen(result.text),
              result.text,
              pickLatestSurfaceModel(stateMgr, result.surface),
            ),
            resolveHarnessStateForSurface(stateMgr, result.surface, codexAgent),
          ),
          codexFill,
        );

        if (args.parsed_only) {
          const data = {
            surface: result.surface,
            title,
            column,
            column_count,
            parsed,
            delivery: getSurfaceDelivery(result.surface),
            ...screenRemap,
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
            ...screenRemap,
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
          ...screenRemap,
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
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "rename_tab",
        );
        let finalTitle = args.title;
        if (args.preserve_prefix) {
          const surfaces = await client.listPaneSurfaces({
            workspace: route.workspace,
          });
          const surface = surfaces.surfaces.find(
            (s) => s.ref === route.surface,
          );
          const currentTitle = surface?.title ?? "";
          finalTitle = replaceTaskSuffix(currentTitle, args.title);
        }
        await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            await client.renameTab(route.surface, finalTitle, {
              workspace: route.workspace,
            });
          },
          {
            toolName: "rename_tab",
            workspace: route.workspace,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
        await lifecycleSeatManifestPublisher({
          surfaceId: route.surface,
          ...(route.stableSurfaceIdentity
            ? { surfaceUuid: route.stableSurfaceIdentity }
            : {}),
          tabName: finalTitle,
        });
        const data = { surface: route.surface, title: finalTitle };
        return okFormatted(formatOk("rename_tab", data), data);
      } catch (e) {
        return err(e);
      }
    },
  );

  server.tool(
    "update_surface",
    "Move or rename one terminal surface.",
    {
      action: z.enum(["move", "rename"]),
      surface: z.string(),
      workspace: z.string().optional(),
      pane: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      index: z.number().int().optional(),
      focus: z.boolean().optional(),
      title: z.string().optional(),
      preserve_prefix: z.boolean().optional().default(false),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const handlerName =
          args.action === "move" ? "move_surface" : "rename_tab";
        const handler = toolHandlersByName.get(handlerName);
        if (!handler) {
          throw new Error(
            `Internal surface adapter unavailable: ${handlerName}`,
          );
        }
        if (args.action === "rename" && !args.title) {
          throw new Error("update_surface action=rename requires title");
        }
        const result = await handler(
          args.action === "move"
            ? {
                surface: args.surface,
                workspace: args.workspace,
                pane: args.pane,
                before: args.before,
                after: args.after,
                index: args.index,
                focus: args.focus,
              }
            : {
                surface: args.surface,
                workspace: args.workspace,
                title: args.title,
                preserve_prefix: args.preserve_prefix,
              },
          {},
        );
        const structured = result.structuredContent ?? {};
        return {
          ...result,
          structuredContent: { ...structured, action: args.action },
        };
      } catch (error) {
        return err(error);
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
    "Close one surface, managed agent, or workspace with live-agent guards.",
    {
      scope: z
        .enum(["surface", "agent", "workspace"])
        .optional()
        .default("surface"),
      surface: z.string().optional().describe("Target surface ref"),
      agent_id: z.string().optional().describe("Managed agent ID"),
      workspace: z.string().optional().describe("Target workspace ref"),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Close even when the backing agent is still live (not done/error). This never bypasses stable surface identity checks. Without force, a live agent's surface is protected and the response returns the current pane contents instead of closing.",
        ),
    },
    ANNOTATIONS.destructive,
    async (args) => {
      try {
        if (args.scope === "agent") {
          if (!args.agent_id) {
            throw new Error("close_surface scope=agent requires agent_id");
          }
          const handler = toolHandlersByName.get("stop_agent");
          if (!handler)
            throw new Error("Internal agent close adapter unavailable");
          const result = await handler(
            { agent_id: args.agent_id, force: args.force },
            {},
          );
          return {
            ...result,
            structuredContent: {
              ...(result.structuredContent ?? {}),
              scope: "agent",
            },
          };
        }
        if (args.scope === "workspace") {
          if (!args.workspace) {
            throw new Error("close_surface scope=workspace requires workspace");
          }
          const handler = toolHandlersByName.get("delete_workspace");
          if (!handler) {
            throw new Error("Internal workspace close adapter unavailable");
          }
          const result = await handler(
            { workspace: args.workspace, force: args.force },
            {},
          );
          return {
            ...result,
            structuredContent: {
              ...(result.structuredContent ?? {}),
              scope: "workspace",
            },
          };
        }
        if (!args.surface) {
          throw new Error("close_surface scope=surface requires surface");
        }
        const route = await resolveRawSurfaceMutationRoute(
          args.surface,
          args.workspace,
          "close_surface",
        );
        await assertSurfaceMutationAllowed(
          "close_surface",
          route.surface,
          route.workspace,
        );
        await route.assertCurrent();
        let staleRegistryDoneConsolidated:
          | {
              agent_id: string;
              previous_state: AgentState;
              done_signal: string;
            }
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
                (route.stableSurfaceIdentity && record.surface_uuid
                  ? record.surface_uuid.toLowerCase() ===
                    route.stableSurfaceIdentity.toLowerCase()
                  : record.surface_id === route.surface) &&
                !TERMINAL_AGENT_STATES.has(record.state),
            );
          if (backingAgent) {
            let screenText = "(unable to read pane)";
            let screenParsed: ReturnType<typeof parseScreen> | null = null;
            try {
              const screen = await client.readScreen(route.surface, {
                workspace: route.workspace,
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
                  target: `${route.surface} (agent ${backingAgent.agent_id})`,
                  caller: resolveCloseCaller("close_surface"),
                  force: args.force ?? false,
                  reason: `refused: agent still live (${backingAgent.state}), registry consolidation failed`,
                  refused: true,
                });
                return err(
                  new Error(
                    `Refused to close ${route.surface}: agent ${backingAgent.agent_id} is "${backingAgent.state}" (still live) and registry consolidation failed. Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                  ),
                  {
                    refused: true,
                    surface: route.surface,
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
                    (route.stableSurfaceIdentity && record.surface_uuid
                      ? record.surface_uuid.toLowerCase() ===
                        route.stableSurfaceIdentity.toLowerCase()
                      : record.surface_id === route.surface) &&
                    !TERMINAL_AGENT_STATES.has(record.state),
                );
              if (remainingLiveAgent) {
                appendCloseEvent({
                  event: "close_surface",
                  target: `${route.surface} (agent ${remainingLiveAgent.agent_id})`,
                  caller: resolveCloseCaller("close_surface"),
                  force: args.force ?? false,
                  reason: `refused: agent still live (${remainingLiveAgent.state}) after stale registry consolidation`,
                  refused: true,
                });
                return err(
                  new Error(
                    `Refused to close ${route.surface}: agent ${remainingLiveAgent.agent_id} is "${remainingLiveAgent.state}" (still live) after stale registry consolidation. Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                  ),
                  {
                    refused: true,
                    surface: route.surface,
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
                target: `${route.surface} (agent ${backingAgent.agent_id})`,
                caller: resolveCloseCaller("close_surface"),
                force: args.force ?? false,
                reason: `refused: agent still live (${backingAgent.state})`,
                refused: true,
              });
              return err(
                new Error(
                  `Refused to close ${route.surface}: agent ${backingAgent.agent_id} is "${backingAgent.state}" (still live). Pass force:true to close anyway. Current pane contents follow in screen/structuredContent.`,
                ),
                {
                  refused: true,
                  surface: route.surface,
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
          ReturnType<typeof chooseSurfaceClosePolicy> | undefined;

        try {
          const identified = route.workspace
            ? null
            : await client.identify(route.surface);
          const workspace =
            route.workspace ??
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
              route.surface,
            );
          }
        } catch {
          // Layout hints are best-effort only; the close itself must still run.
        }

        const collapsePane = closePolicy?.collapsePane ?? false;
        const observedSurface = await findSurfaceByRef(
          route.surface,
          route.workspace,
        );
        const requestedSurfaceKey =
          route.stableSurfaceIdentity?.toLowerCase() ??
          route.surface.toLowerCase();
        const observedSurfaceUuid = observedSurface?.id?.toLowerCase();
        await withSurfaceWrite(
          route.surface,
          async () => {
            await route.assertCurrent();
            await client.closeSurface(route.surface, {
              workspace: route.workspace,
              collapsePane,
            });
          },
          {
            toolName: "close_surface",
            workspace: route.workspace,
            stableSurfaceIdentity: route.stableSurfaceIdentity,
          },
        );
        for (const record of stateMgr.listStates()) {
          // Stable identity wins whenever cmux exposes it. On a ref-only or
          // unavailable observation, preserve the explicit close intent by
          // falling back to the mutable ref instead of treating it as a crash.
          const matchesClosedSurface = record.surface_uuid
            ? record.surface_uuid.toLowerCase() === requestedSurfaceKey ||
              record.surface_uuid.toLowerCase() === observedSurfaceUuid ||
              (observedSurfaceUuid === undefined &&
                record.surface_id === route.surface)
            : observedSurfaceUuid === undefined &&
              record.surface_id === route.surface;
          if (!matchesClosedSurface) {
            continue;
          }
          try {
            const terminal = stateMgr.updateRecord(record.agent_id, {
              user_killed: true,
            });
            context.lifecycleRegistry?.set(record.agent_id, terminal);
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === `Agent not found: ${record.agent_id}`
            ) {
              continue;
            }
            throw error;
          }
        }
        appendCloseEvent({
          event: "close_surface",
          target: route.surface,
          caller: resolveCloseCaller("close_surface"),
          force: args.force ?? false,
          reason: staleRegistryDoneConsolidated
            ? `closed after stale-registry done consolidation (agent ${staleRegistryDoneConsolidated.agent_id})`
            : null,
          refused: false,
        });
        const data = {
          surface: route.surface,
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
    "Append a task to an agent's inbox FILE (the deterministic write channel). The agent acts on it via a persistent native Monitor on its inbox. The durable envelope automatically carries reply_to=<resolved sender agent_id> plus optional via:<observed surface_ref> and observed_at metadata; reply_to is the only routing address, via is a stale-able hint, and tab names never enter the contract. The only connector-authored composer wake is `[inbox] <msg_id> — reply_to: <sender_agent_id>[ via:<surface_ref> observed_at:<stamp>] — read <path>`. With nudge='auto' (default), an idle live agent is woken once on enqueue; a stale/absent monitor also gets the same best-effort pointer independent of lifecycle state. A never-armed reader is successful when the verified nudge path submits or queues the pointer; otherwise the durable append returns a non-retryable error. A previously armed but stale reader returns explicit degraded success. Address to:'orc' to flag the orchestrator (own-tag triage). Channel is EPHEMERAL plumbing — set persist:true only for decisions that should be brain_store'd.",
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
          "auto: wake an idle live agent once on enqueue; when the inbox-monitor heartbeat is stale/absent, best-effort type the same exact inbox pointer into its surface (bypasses agent-state gates — works even when registry state is poisoned). never: file append only.",
        ),
    },
    ANNOTATIONS.mutating,
    async (args) => {
      try {
        const callerAgent = resolveCurrentCallerAgent();
        const replyTo = callerAgent?.agent_id ?? args.from.trim();
        if (!replyTo || /[\r\n]/.test(replyTo)) {
          throw new Error(
            "dispatch_to_agent requires a one-line sender agent_id for reply_to",
          );
        }
        const msg = dispatch(
          args.agent_id,
          {
            from: args.from,
            reply_to: replyTo,
            ...(callerAgent ? { via: callerAgent.surface_id } : {}),
            to: args.agent_id,
            tag: args.tag,
            task: args.task,
            persist: args.persist,
          },
          inboxOpts,
        );
        context.lifecycleSweepEngine?.requestFleetSidebarRepublish();
        const monitor_state = inboxMonitorState(
          args.agent_id,
          INBOX_NUDGE_HEARTBEAT_MAX_AGE_MS,
          inboxOpts,
        );
        const monitor_alive = monitor_state === "alive";
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
          delivery?: "submitted" | "queued";
          delivery_id?: string;
        } = { attempted: false, sent: false, reason: "" };
        const acceptedRecord =
          context.lifecycleRegistry?.get(args.agent_id) ?? null;
        const wakeIdleAgent = monitor_alive && acceptedRecord?.state === "idle";
        if (args.nudge === "never") {
          nudge.reason = "nudge disabled by caller";
        } else if (monitor_alive && !wakeIdleAgent) {
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
              const pointer = formatInboxPing(
                msg,
                inboxPath(args.agent_id, inboxOpts),
              );
              if (record.state === "working" && context.lifecycleSweepEngine) {
                const queued = context.lifecycleSweepEngine.queueDelivery({
                  agent_id: args.agent_id,
                  text: pointer,
                  press_enter: true,
                  source_event: "dispatch_nudge",
                });
                nudge.delivery = "queued";
                nudge.delivery_id = queued.delivery_id;
              } else {
                const deliveryId = context.lifecycleSweepEngine
                  ? randomUUID()
                  : undefined;
                const delivered = await lifecycleAgentInputDeliverer({
                  agent_id: args.agent_id,
                  text: pointer,
                  press_enter: true,
                  allow_busy: true,
                  source_event: "dispatch_nudge",
                  delivery_id: deliveryId,
                });
                if (
                  delivered.delivery !== "submitted" &&
                  delivered.delivery !== "queued"
                ) {
                  throw new Error(
                    "inbox nudge produced no evidence-backed delivery state",
                  );
                }
                nudge.delivery = delivered.delivery;
                if (context.lifecycleSweepEngine && deliveryId) {
                  const receipt =
                    delivered.delivery === "queued"
                      ? context.lifecycleSweepEngine.acceptComposerQueue({
                          delivery_id: deliveryId,
                          agent_id: args.agent_id,
                          text: pointer,
                          press_enter: true,
                          source_event: "dispatch_nudge",
                          retry_count: delivered.retry_count,
                        })
                      : context.lifecycleSweepEngine.resolveDelivery({
                          delivery_id: deliveryId,
                          agent_id: args.agent_id,
                          text: pointer,
                          press_enter: true,
                          source_event: "dispatch_nudge",
                          delivery_state: "submitted",
                          terminal: true,
                          retry_count: delivered.retry_count,
                          submit_verified: delivered.submit_verified,
                          error: null,
                        });
                  nudge.delivery_id = receipt.delivery_id;
                }
              }
              nudge.sent = true;
              nudge.reason = wakeIdleAgent
                ? `idle live agent — typed inbox pointer into ${record.surface_id}`
                : record.state === "working"
                  ? `busy agent — queued inbox pointer for verified lifecycle delivery to ${record.surface_id}`
                  : `heartbeat stale/absent — typed inbox pointer into ${record.surface_id} (state: ${record.state})`;
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
        const delivery_status =
          monitor_state === "alive"
            ? "monitor_live"
            : monitor_state === "stale"
              ? "queued_monitor_stale"
              : "queued_monitor_never_armed";
        const receipt = {
          dispatched: msg,
          inbox: inboxPath(args.agent_id, inboxOpts),
          durable: true,
          delivery_status,
          monitor_alive,
          monitor_state,
          health,
          nudge,
        };
        const nudgeAccepted =
          nudge.sent &&
          (nudge.delivery === "submitted" || nudge.delivery === "queued");
        if (monitor_state === "never-armed" && !nudgeAccepted) {
          return err(
            "inbox message was queued, but the recipient has never proved that its inbox monitor is armed",
            {
              error_code: "inbox_monitor_never_armed",
              retryable: false,
              ...receipt,
            },
          );
        }
        return ok(receipt);
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
          const groups = partitionPaneSurfacesByMembership(
            paneList,
            rawGroups,
            {
              workspace_ref: panes.workspace_ref ?? ref,
              window_ref: panes.window_ref,
            },
          );
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
        (!observerEpoch || lastLifecycleSurfaceObserverEpoch !== observerEpoch)
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
      new AgentRegistry(stateMgr, surfaceProvider, {
        observerIdProvider: () => context.surfaceObserverId,
        observerEpochProvider: () => context.surfaceObserverEpoch,
        explicitRoleProvider: explicitRoleForDiscoveredSurface,
      });
    context.lifecycleRegistry = registry;
    const discovery = new AgentDiscovery({
      observerIdProvider: () => context.surfaceObserverEpoch,
      listSurfaces: surfaceProvider,
      readScreen: (surface, opts) => client.readScreen(surface, opts),
    });
    // AIDEV-NOTE (F1): from here on, every consumer that used to read
    // `agent.state` as truth resolves the LIVE state through this probe. It
    // reads the last screen scan only -- no I/O on the caller's path -- and
    // returns null when there is no fresh evidence, which degrades to the
    // registry record with honest `registry` provenance.
    const screenObservationForRecord = (
      agent: AgentRecord,
    ): {
      status: string | null;
      agent_type: string | null;
      control_state: string | null;
    } | null => {
      const cached = discovery.cachedScan();
      if (!cached) return null;
      const uuidKey = (value: string | null | undefined): string | null =>
        value?.trim().toLowerCase() || null;
      const agentUuid = uuidKey(agent.surface_uuid);
      // Same binding rule list_agents uses: a UUID pair, or a surface_id match
      // ONLY when neither side has a UUID and this observer owns the seat.
      // A looser match would let an unrelated pane's screen decide an agent's
      // state, which is a worse lie than the stale record it replaces.
      const row = cached.rows.find((surface) => {
        const surfaceUuid = uuidKey(surface.surface_uuid);
        return agentUuid && surfaceUuid
          ? agentUuid === surfaceUuid
          : Boolean(
              !agentUuid &&
              !surfaceUuid &&
              agent.surface_observer_id &&
              agent.surface_observer_id === registry.getObserverId() &&
              surface.surface_id === agent.surface_id,
            );
      });
      if (!row || row.read_error) return null;
      return {
        status: row.parsed_status ?? null,
        agent_type: row.cli === "kiro" ? "unknown" : (row.cli ?? null),
        control_state: row.control_state ?? null,
      };
    };
    liveAgentStateProbe.current = (agent) =>
      resolveLiveAgentState(agent, screenObservationForRecord(agent));
    const awaitLifecycleStart = async (): Promise<void> => {
      if (context.lifecycleStartPromise) {
        await context.lifecycleStartPromise;
      }
      if (context.lifecycleStartError) {
        throw context.lifecycleStartError;
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
    const testProcess =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test";
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
            const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
              sendOpts ?? {};
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
                stableSurfaceIdentity,
              },
            );
          },
          sendKey: (surface, key, keyOpts) => {
            const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
              keyOpts ?? {};
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
                stableSurfaceIdentity,
              },
            );
          },
          setProgress: (value, progressOpts) =>
            client.setProgress(value, progressOpts),
          clearProgress: (progressOpts) => client.clearProgress(progressOpts),
          newSplit: async (direction, splitOpts) => {
            const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
              splitOpts ?? {};
            await assertWorkspaceMutationAllowed(
              "agent_engine",
              splitOpts?.workspace,
            );
            const mutate = async () => {
              await beforeMutation?.();
              return client.newSplit(direction, clientOpts);
            };
            return splitOpts?.surface
              ? withSurfaceWrite(splitOpts.surface, mutate, {
                  toolName: "new_split",
                  lockKey: stableSurfaceIdentity
                    ? `uuid:${stableSurfaceIdentity.toLowerCase()}`
                    : splitOpts.surface,
                })
              : mutate();
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
          focusSurface: async (surface, focusOpts) => {
            const { beforeMutation, ...clientOpts } = focusOpts ?? {};
            await assertWorkspaceMutationAllowed(
              "agent_engine",
              focusOpts?.workspace,
            );
            await beforeMutation?.();
            return client.focusSurface(surface, clientOpts);
          },
          selectWorkspace: async (workspace) => {
            await assertWorkspaceMutationAllowed("agent_engine", workspace);
            return client.selectWorkspace(workspace);
          },
          listPanes: (paneOpts) => client.listPanes(paneOpts),
          listPaneSurfaces: (surfaceOpts) =>
            client.listPaneSurfaces(surfaceOpts),
          closeSurface: (surface, closeOpts) => {
            const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
              closeOpts ?? {};
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
              {
                toolName: "close_surface",
                workspace: closeOpts?.workspace,
                stableSurfaceIdentity,
              },
            );
          },
          moveSurface: async (moveOpts) => {
            const { beforeMutation, stableSurfaceIdentity, ...clientOpts } =
              moveOpts;
            await assertWorkspaceMutationAllowed(
              "move_surface",
              moveOpts.workspace,
            );
            return withSurfaceWrite(
              moveOpts.surface,
              async () => {
                await beforeMutation?.();
                return client.moveSurface(clientOpts);
              },
              {
                toolName: "move_surface",
                lockKey: stableSurfaceIdentity
                  ? `uuid:${stableSurfaceIdentity.toLowerCase()}`
                  : moveOpts.surface,
              },
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
          selfRegistrationSessionResolver:
            context.selfRegistrationSessionResolver,
          roleSurfaceIdsProvider: collectServerRoleSurfaceIds,
          inboxOpts,
          launchCommandSender: async ({
            surface,
            stableSurfaceIdentity,
            workspace,
            command,
            timeout_ms,
            assertSurfaceBindingCurrent,
          }) => {
            originalLaunchCommandsBySurface.set(surface, command);
            try {
              await sendLauncherCommandToSurface({
                surface,
                stableSurfaceIdentity,
                workspace,
                command,
                timeout_ms,
                assertSurfaceBindingCurrent,
              });
            } catch (error) {
              originalLaunchCommandsBySurface.delete(surface);
              launchShellRecoveryBySurface.delete(surface);
              throw error;
            }
          },
          beforeCrashRecoveryMutation: async ({
            phase,
            surface,
            workspace,
          }) => {
            if (phase === "placement") {
              await assertWorkspaceMutationAllowed("agent_engine", workspace);
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
          watchRegistryPath: opts?.watchRegistryPath,
          watchRegistryNow: opts?.watchRegistryNow,
          watchNotify: opts?.watchNotify,
          closeForensicsRunner: opts?.enableCloseForensics
            ? createDefaultCloseForensicsRunner({
                stateMgr,
                listSurfacesForRefMap: surfaceProvider,
              })
            : null,
          seatRegistry,
          seatRegistryPath: opts?.seatRegistryPath,
          fleetSidebarPublisher: opts?.fleetSidebarPublisher,
          deliveryVerifyDeadlineMs: opts?.deliveryVerifyDeadlineMs,
          deliveryTicketDir:
            opts?.deliveryTicketDir ??
            (testProcess ? undefined : defaultDeliveryTicketDir()),
          deliveryIssueFiler:
            opts?.deliveryIssueFiler ??
            (testProcess
              ? undefined
              : async (ticket) => {
                  await fileDeliveryFailureGithubIssue(ticket);
                }),
        },
      );
    lifecycleSeatManifestPublisher = async (input) => {
      try {
        const existing = input.agentId
          ? engine.getAgentState(input.agentId)
          : (registry
              .list()
              .find((record) =>
                input.surfaceUuid
                  ? record.surface_uuid?.toLowerCase() ===
                    input.surfaceUuid.toLowerCase()
                  : record.surface_id === input.surfaceId,
              ) ?? null);
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
            updated.cli === "kiro" ? "default" : resolveSpawnPermissionMode(),
          cwd: updated.launch_cwd ?? defaultRepoCheckoutPath(updated.repo),
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
    // F1: closure, harvestability and the health report all resolve state
    // through the same live probe the caller/delivery paths use.
    engine.setLiveStateResolver(liveAgentStateProbe.current);

    server.tool(
      "arm_watch",
      "Arm a declared WatchSpec without blocking. Targets are validated immediately; returns the read-only liveness source used by the engine.",
      WatchSpecArgsSchema,
      ANNOTATIONS.mutating,
      async (args) => {
        try {
          await awaitLifecycleStart();
          const watch = await engine.armWatch(args as WatchSpec);
          return ok({ watch });
        } catch (error) {
          if (error instanceof WatchArmError) {
            return err(error, {
              error_code: error.code,
              target: error.target,
            });
          }
          return err(error);
        }
      },
    );

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
      timeout_ms?: number;
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
            allowModelOverride:
              record.cli === "codex"
                ? Boolean(
                    record.model?.trim() &&
                    record.model.trim().toLowerCase() !== "codex",
                  )
                : process.env.REPOGOLEM_ALLOW_MODEL === "1",
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
        timeout_ms: opts.timeout_ms,
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
      worktree: boolean | string | object | undefined,
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
      // Registry-optional (issue #392): a registered repo keeps its registry
      // path; otherwise fall back to the same search spawn uses.
      const repoRoot = disableSpawnPreflight
        ? resolve(opts?.worktreeHomeDir ?? join(homedir(), "Gits"), repo)
        : (resolveRepoRootFromLauncherRegistryOrNull(repo) ??
          resolveRepoRootWithoutRegistry(repo));
      const prepared = await prepareWorktree({
        repo,
        repoRoot,
        worktree: worktree as Parameters<typeof prepareWorktree>[0]["worktree"],
        exec: opts?.worktreeExec,
        homeGitsDir: opts?.worktreeHomeDir,
      });
      return {
        prepared,
        repoRoot,
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
      delivery_id?: string;
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
              `Call list_agents for a refreshed live view and retry.`,
          );
        }
        route = reresolved;
      }
      // Agent-path delivery requires a live agent TUI. A crashed CLI leaves its
      // terminal surface alive at a bare shell; typing a routed message there
      // executes fleet text as shell input. Target-scoped discovery validates
      // only this route's stable UUID/ref binding around read-screen, so
      // unrelated pane churn cannot block a healthy relay. Raw
      // surface/command/key modes bypass this helper and remain available for
      // deliberate recovery.
      const assertAgentRouteHasTui = async (candidateRoute: typeof route) => {
        const freshOccupant = await discovery.scanTarget(candidateRoute);
        if (
          freshOccupant &&
          !freshOccupant.read_error &&
          freshOccupant.control_state === "shell"
        ) {
          throw new Error(
            `Agent "${args.agent_id}" exited / no agent currently initiated on ` +
              `surface ${candidateRoute.surface_id} (control_state=${freshOccupant.control_state}, ` +
              `agent_type=${freshOccupant.cli}); refusing routed agent delivery. ` +
              `Use send_to mode=surface, command, or key for deliberate raw terminal input.`,
          );
        }
        return freshOccupant;
      };
      const freshOccupant = await assertAgentRouteHasTui(route);

      // Identity guard: a live surface ref may have been RECYCLED — a crashed
      // agent's pane reused by a different agent. If the live surface now hosts
      // a known CLI that differs from this agent's recorded CLI, refuse rather
      // than delivering to the new occupant. Fresh shell evidence was already
      // refused above; other unknown/unreadable evidence remains inconclusive.
      const expectedCli = engine.getAgentState(args.agent_id)?.cli;
      if (requiresMutableRefGuards && expectedCli) {
        const cachedOccupant = freshOccupant;
        const isForeign = (occ: typeof cachedOccupant): boolean =>
          Boolean(
            occ &&
            occ.has_agent &&
            !occ.read_error &&
            occ.cli !== "unknown" &&
            occ.cli !== expectedCli,
          );
        if (isForeign(cachedOccupant)) {
          // Confirm against another target-scoped fresh read before refusing;
          // one parse alone can be transient, while a fleet-wide scan would
          // couple this route to unrelated pane churn.
          const freshOccupant = await discovery.scanTarget(route);
          if (isForeign(freshOccupant)) {
            throw new Error(
              `Agent "${args.agent_id}" (${expectedCli}) no longer occupies ` +
                `surface ${route.surface_id} — it now hosts a ${freshOccupant?.cli} ` +
                `agent (surface recycled). Call list_agents for a refreshed ` +
                `live view and retry.`,
            );
          }
        }
      }
      const routeSurfaceAlive =
        route.state === "error" &&
        (await registry.isSurfaceAlive(route, {
          ptyDead:
            surfaceWriteLiveness.observe(
              route.surface_id,
              route.surface_uuid,
              context.surfaceObserverId,
            )?.pty_dead === true,
        }));
      // AIDEV-NOTE (F1): gate on the LIVE state, not the route's registry copy.
      // `freshOccupant` is a target-scoped scan taken moments ago -- the same
      // evidence P4 uses. Reading the record here is what returned a terminal
      // `failed` receipt to an agent sitting at a live prompt (ledger row 4):
      // #408 had flipped its record to `done` while its screen read ready.
      const liveRouteState = resolveLiveAgentState(
        { state: route.state },
        freshOccupant && !freshOccupant.read_error
          ? {
              status: freshOccupant.parsed_status,
              agent_type:
                freshOccupant.cli === "kiro" ? "unknown" : freshOccupant.cli,
              control_state: freshOccupant.control_state,
            }
          : null,
      );
      if (
        !args.allow_busy &&
        !isLiveDeliverable(liveRouteState) &&
        !routeSurfaceAlive
      ) {
        throw new RetryableDeliveryError(
          `Agent "${args.agent_id}" is not in an interactive state ` +
            `(current: ${liveRouteState.state}, source: ${liveRouteState.source}` +
            `${liveRouteState.stale_registry_state ? `, registry record says ${liveRouteState.registry_state}` : ""}). ` +
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
      await assertAgentRouteHasTui(route);
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
          await assertDeliveryRouteCurrent();
          const delivery = await executeDeliveryEngine({
            surface: deliveryRoute.surface_id,
            workspace: deliveryRoute.workspace_id ?? undefined,
            chunks,
            chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
            chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
            press_enter: args.press_enter,
            stableSurfaceIdentity: deliveryRoute.surface_uuid,
            source_event: args.source_event,
            source_agent: args.agent_id,
            delivery_id: args.delivery_id,
            // Verify every submitted agent relay — not just long ones. A short
            // relay (the common agent-to-agent case) to a frozen terminal must
            // be caught, never reported as ok. Verified agent messages may
            // retry Return once only while the exact text remains in a Codex
            // composer; accepted TUI queues are nonterminal receipts instead.
            // AIDEV-NOTE (F1): gate verification on the SAME live-resolved
            // state the delivery gate above used. Reading the registry record
            // here meant the class this lane newly admits -- registry-terminal
            // + screen `ready` + allow_busy:false -- skipped verification
            // entirely and returned an unproven success: the same receipt lie
            // with the sign flipped (false `failed` -> false `ok`). It also
            // suppressed markAgentWorking below, so the poisoned record was
            // never corrected and every later send repeated the unverified path.
            verify_submit:
              args.press_enter &&
              (args.allow_busy || isLiveDeliverable(liveRouteState)),
            // A single recovery Return is part of verified sends and inbox
            // wakeups. Other lifecycle mutations (notably goal supersession)
            // retain their stricter no-retry evidence semantics.
            allow_recovery_enter_retry:
              args.source_event === "send_to" ||
              args.source_event === "dispatch_nudge",
            submit_verify_timeout_ms: args.allow_busy
              ? BUSY_AGENT_SUBMIT_VERIFY_TIMEOUT_MS
              : undefined,
            beforeMutation: assertDeliveryRouteCurrent,
          });
          if (args.press_enter && delivery.submit_verified === true) {
            engine.markAgentWorking(args.agent_id);
          }
          return delivery;
        },
        {
          toolName: args.source_event,
          workspace: deliveryRoute.workspace_id ?? undefined,
          observePtyWrite: true,
          stableSurfaceIdentity: deliveryRoute.surface_uuid,
        },
      );
    };
    // Expose the guarded relay to dispatch_to_agent's nudge (registered above,
    // outside this lifecycle block).
    lifecycleAgentInputDeliverer = deliverAgentInput;
    engine.setDeliverySubmitter(async (receipt) => {
      const delivery = await deliverAgentInput({
        agent_id: receipt.agent_id,
        text: receipt.text,
        press_enter: receipt.press_enter,
        allow_busy: false,
        source_event: receipt.source_event,
        delivery_id: receipt.delivery_id,
      });
      return {
        retry_count: delivery.retry_count,
        submit_verified: delivery.submit_verified,
        ...(delivery.delivery === "submitted" ||
        delivery.delivery === "queued" ||
        delivery.delivery === "queued_followup" ||
        delivery.delivery === "pending_verify"
          ? { delivery: delivery.delivery }
          : {}),
      };
    });
    engine.setDeliverySnapshotReader(async (receipt: AgentDeliveryReceipt) => {
      const agent = engine.getAgentState(receipt.agent_id);
      if (!agent) return null;
      return readParsedSurface(
        agent.surface_id,
        agent.workspace_id ?? undefined,
      );
    });
    engine.setDeliveryVerifier(
      async (receipt: AgentDeliveryReceipt, snapshot) => {
        const agent = engine.getAgentState(receipt.agent_id);
        if (!agent) {
          return { outcome: "pending" as const, reason: "target_gone" };
        }
        const resolvedSnapshot =
          snapshot === undefined
            ? await readParsedSurface(
                agent.surface_id,
                agent.workspace_id ?? undefined,
              )
            : snapshot;
        if (!resolvedSnapshot?.text.trim()) {
          return {
            outcome: "pending" as const,
            reason: "surface_read_unavailable",
          };
        }
        const pending = screenShowsPendingInput(
          resolvedSnapshot.text,
          receipt.text,
        );
        const queued = screenShowsQueuedAgentInput(
          resolvedSnapshot.text,
          receipt.text,
        );
        const cursorQueuedFollowup = screenShowsQueuedCursorFollowup(
          resolvedSnapshot.text,
          receipt.text,
        );
        const composer = extractComposerInputRegion(
          resolvedSnapshot.text,
          receipt.text,
        );
        const cli = inferComposerCli(
          resolvedSnapshot.text,
          resolvedSnapshot.parsed as Parameters<typeof inferComposerCli>[1],
        );
        if (queued || cursorQueuedFollowup || (cli === "cursor" && pending)) {
          return { outcome: "pending" as const };
        }
        const composerCleared = composer !== null && composer.trim() === "";
        const correlationTail = receipt.text
          .trim()
          .slice(-Math.min(80, receipt.text.trim().length));
        const inTranscript =
          correlationTail.length > 0 &&
          normalizeTerminalText(resolvedSnapshot.text).includes(
            correlationTail,
          ) &&
          !pending;
        if (composerCleared || inTranscript) {
          return { outcome: "delivered" as const, submit_verified: true };
        }
        return { outcome: "pending" as const };
      },
    );

    // Reconstitute and discover live surfaces before the first sidebar paint.
    // The engine initializer is idempotent because daemon connections share a
    // context and may construct more than one MCP server over its lifetime.
    if (!context.lifecycleStarted) {
      context.lifecycleStarted = true;
      context.lifecycleStartError = null;
      const lifecycleInitialization = lifecycleInitializer
        ? Promise.resolve().then(() => lifecycleInitializer())
        : engine.initialize(discovery);
      context.lifecycleStartPromise = lifecycleInitialization
        .catch((error) => {
          context.lifecycleStartError =
            error instanceof Error ? error : new Error(String(error));
          console.error(
            "[cmuxlayer] lifecycle initialization failed:",
            context.lifecycleStartError,
          );
        })
        .then(() => {
          if (
            !context.lifecycleStartError &&
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
      if (
        !context.lifecycleStartError &&
        context.lifecycleStarted &&
        context.lifecycleSweepEngine === engine
      ) {
        context.setLifecycleAgentInputDeliverer(deliverAgentInput);
      }
    });

    // 11. spawn_agent
    server.tool(
      "spawn_agent",
      "Spawn a managed agent or terminal, or resume a captured agent on a fresh surface while preserving its ID. Placement is deterministic; boot prompts return evidence-backed receipts.",
      {
        version: z
          .literal(1)
          .optional()
          .default(1)
          .describe("SpawnSpec schema version"),
        type: z
          .enum(["agent", "terminal"])
          .optional()
          .default("agent")
          .describe("Spawn an AI agent or a plain terminal"),
        resume_agent_id: z
          .string()
          .optional()
          .describe(
            "Resume this captured agent session on a fresh surface while preserving its public agent ID. Mutually exclusive with new-spawn fields.",
          ),
        repo: z
          .string()
          .optional()
          .describe("Repository name (e.g. 'brainlayer', 'golems')"),
        model: z
          .string()
          .optional()
          .describe(
            "OPTIONAL — leave UNSET so the launcher pins the top-tier model. For cli:'codex', an explicit model is checked against Codex's runtime model list before any worktree or surface is created, then passed through to the launcher. Never pass 'opus' for claude — the top Claude model is already the default.",
          ),
        effort: z
          .enum(CODEX_EFFORT_VALUES)
          .optional()
          .describe(
            "Codex reasoning effort, passed to the repoGolem launcher. CHOOSE THIS DELIBERATELY PER MISSION — it is a cost decision, not a default to inherit. The installed launcher currently accepts: low, medium, high, xhigh, max, ultra. spawn_agent rejects other values before creating a worktree or surface. The live launcher defaults to HIGH when omitted (~/.config/ralphtools/golem-dispatch.zsh). Per /agent-routing, MEDIUM is the settled floor for well-specified implementation lanes — use it unless the task genuinely needs more; xhigh and above burn budget fast and are rarely warranted for a lane with a clear brief.",
          ),
        cli: z
          .enum(["claude", "codex", "gemini", "kiro", "cursor"])
          .optional()
          .describe("CLI tool to launch"),
        cwd: z
          .string()
          .optional()
          .describe("Initial working directory for type=terminal"),
        title: z.string().optional().describe("Tab title for type=terminal"),
        prompt: z
          .string()
          .optional()
          .describe(
            `${PANE_INPUT_BREAKAGE_GUIDANCE} Inline task prompt to send after the agent is ready. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default; use boot_prompt_path for larger prompts. Mutually exclusive with boot_prompt_path.`,
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
          .describe(
            "Optional timeout override in milliseconds for initial shell readiness, agent launch readiness, and the boot prompt. When omitted, each phase keeps its established default (10s shell, 15s launch, 60s boot prompt).",
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
            'When set, create or reuse a git worktree before launch. Pass a string such as "tool-usage" as the worktree name, true for a generated name, or an object with name, path, branch, base, create, and reuse. When repoGolem registers the repo with an absolute path, that path is the repo root; otherwise the root is resolved from CMUXLAYER_REPO_HOME, the running checkout, or ~/Gits. true uses <registered-root>/.worktrees/<generated-name> (legacy ~/Gits/<repo>.wt read-fallback until ~2026-09). If a later spawn step fails before a recoverable surface exists, a newly created worktree and branch are rolled back.',
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
            "ID of the parent agent for hierarchical spawning. Normally inferred from the managed caller surface; pass explicitly only when no managed caller supplies the hierarchy. Parent must exist.",
          ),
        role: spawnFunctionSchema()
          .optional()
          .describe(
            "Agent job function: implementor, reviewer, or gatherer. Legacy orchestrator/worker aliases remain accepted for compatibility. Claude requires this field explicitly.",
          ),
        placement: spawnPlacementSchema()
          .optional()
          .describe(
            "Physical placement axis: left or right. It must agree with authority (lead=left, worker=right). Legacy orchestrator/worker aliases remain accepted.",
          ),
        authority: z
          .enum(["lead", "worker"])
          .optional()
          .describe(
            "Authority axis, independent from job function and placement",
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
        auto_revive: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Automatically resume a captured CLI session in the same surviving surface after unexpected CLI exit. Set false for debugging sessions where CLI death is intentional evidence.",
          ),
        halt_escalation: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Notify the nearest live ancestor when this agent remains awaiting input, idle without done evidence, or wedged past its dwell threshold. Set false for deliberate debugging lanes.",
          ),
        report_path: z
          .string()
          .refine((value) => isAbsolute(value.trim()), {
            message:
              "report_path must be absolute so the producer and consumer resolve the same file",
          })
          .optional()
          .describe(
            "Optional ABSOLUTE override for the engine-issued report path. Omit in almost all cases: the engine issues `~/.cmux/agents/<agent_id>/report.md`, returns it in this receipt, persists it, and verifies closure against it. The engine also WRITES both strings to the spawn contract file (`contract_path`) and points the boot prompt at it, so the worker is told; check `coordination_footer_delivered` -- if false the contract file could not be written and YOU must relay report_path and done_marker, or a done worker renders closure:\"artifact_missing\". Pass this only to place the report somewhere you already watch (e.g. a collab dir).",
          ),
        force_new: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, suppress same repo/workspace/role duplicate-lane warnings. Default false so collab leads see reusable existing agents before spawning another lane.",
          ),
        focus: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Leave focus on the created agent tab instead of restoring the exact origin after initialization.",
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
        const creation = new CreatedIdentityScope();
        try {
          // P11 finding 2: reject a relative override BEFORE anything launches.
          // The zod .refine() covers real MCP calls; this covers direct handler
          // invocation, so no call path can leave an orphaned pane behind an
          // input-validation error.
          if (
            typeof args.report_path === "string" &&
            !isAbsolute(args.report_path.trim())
          ) {
            return err(
              new Error(
                `report_path must be absolute so the producer and consumer resolve the same file: ${args.report_path}`,
              ),
            );
          }
          if (args.resume_agent_id) {
            const incompatible = [
              "repo",
              "model",
              "effort",
              "cli",
              "cwd",
              "prompt",
              "boot_prompt_path",
              "worktree",
              "mcp_profile",
              "parent_agent_id",
              "role",
              "placement",
              "authority",
              "max_cost_per_agent",
              "crash_recover",
            ].filter((field) =>
              Object.prototype.hasOwnProperty.call(args, field),
            );
            if ((args.type ?? "agent") !== "agent" || incompatible.length > 0) {
              return err(
                new Error(
                  `resume_agent_id is mutually exclusive with new-spawn fields${
                    incompatible.length > 0
                      ? `: ${incompatible.join(", ")}`
                      : ""
                  }`,
                ),
                { error_code: "INVALID_RESUME_SPEC" },
              );
            }
            await awaitLifecycleStart();
            const existing = engine.getAgentState(args.resume_agent_id);
            if (!existing) {
              return err(new Error(`Agent not found: ${args.resume_agent_id}`));
            }
            const workspace = await canonicalWorkspaceRef(
              args.workspace ?? existing.workspace_id ?? undefined,
            );
            await assertWorkspaceMutationAllowed("spawn_agent", workspace);
            let focusRestoreLease = await focusTargetBeforeSplit(
              workspace,
              args.focus !== true,
            );
            const result = await engine.resumeAgent(args.resume_agent_id, {
              workspace,
            });
            creation.record({
              agent_id: result.agent_id,
              surface_id: result.surface_id,
              workspace_id: result.workspace_id ?? workspace ?? null,
            });
            focusRestoreLease = await capturePostCreationFocus(
              focusRestoreLease,
              {
                surface: result.surface_id,
                workspace: result.workspace_id ?? workspace,
              },
            );
            const focusRestoreWarning = await restoreFocusAfterRender(
              focusRestoreLease,
              result.surface_id,
              result.workspace_id ?? workspace,
            );
            // AIDEV-NOTE (P11b / #462 item 2): resume used to return NO
            // contract at all -- no report_path, no done_marker, no contract
            // file -- so the crash-recovery case this repo exists for was the
            // one case where a lead could not even SEE where its worker should
            // report. The contract is derived from agent_id alone, so what is
            // issued here is byte-identical to what the original spawn issued;
            // refreshing the file is idempotent and restores it if the channel
            // dir was reaped between the crash and the resume.
            //
            // What is deliberately NOT done: re-injecting the pointer as
            // keystrokes into a resuming pane. `claude --resume` restores the
            // prior session, so the original pointer message is already in the
            // agent's context, and typing into a pane mid-resume is a change to
            // the most incident-prone path in this repo -- the exact thing this
            // PR exists to move work OFF. That sliver stays open on #462.
            const resumeMonitorBoot = ensureMonitorBoot(result.agent_id);
            const resumeCoordination = issueSpawnCoordination(
              result.agent_id,
              args.report_path,
            );
            const resumeContract = buildBootContractInjection(
              result.agent_id,
              resumeMonitorBoot,
              resumeCoordination,
            );
            result.report_path = resumeCoordination.report_path;
            result.done_marker = resumeCoordination.done_marker;
            result.contract_path = resumeContract.contract_path ?? undefined;
            result.coordination_footer_bytes =
              coordinationFooterBytes(resumeCoordination);
            // Provenance, same rule as the spawn path: the file is refreshed,
            // but nothing was re-delivered to the pane on this call. Saying
            // `true` here would be the claim this PR's own thesis forbids.
            result.coordination_footer_delivered = false;
            result.coordination_footer_note = resumeContract.contract_path
              ? COORDINATION_CONTRACT_REFRESHED_NOT_REDELIVERED
              : COORDINATION_FOOTER_NOT_DELIVERED;
            try {
              const patched = stateMgr.updateRecord(result.agent_id, {
                report_path: resumeCoordination.report_path,
                done_marker: resumeCoordination.done_marker,
              });
              registry.set(result.agent_id, patched);
            } catch {
              // Receipt already carries the contract; a registry write failure
              // must not fail an otherwise-successful resume.
            }
            const resumed = {
              version: 1,
              type: "agent",
              resumed: true,
              ...result,
              role: inferRecordRoleOrNull(existing) ?? "worker",
              ...(focusRestoreWarning
                ? {
                    warning: focusRestoreWarning,
                    warnings: [focusRestoreWarning],
                  }
                : {}),
            };
            return buildSpawnToolReturn(
              { retry_count: currentTransportRetryCount(), ...resumed },
              args.verbose,
              formatOk("spawn_agent", resumed),
            );
          }
          if (args.type === "terminal") {
            if (
              args.role !== undefined ||
              args.authority !== undefined ||
              args.placement !== undefined ||
              args.worktree !== undefined
            ) {
              return err(
                new Error(
                  "Terminal spawns do not accept role, authority, placement, or worktree",
                ),
                { error_code: "INVALID_TERMINAL_SPAWN_SPEC" },
              );
            }
            const requestedWorkspace = args.workspace;
            const callerWorkspace = await currentSafetyCallerWorkspace();
            const createsWorkspace = requestedWorkspace?.startsWith("new:");
            await assertWorkspaceMutationAllowed(
              "spawn_agent",
              createsWorkspace
                ? callerWorkspace
                : (requestedWorkspace ?? callerWorkspace),
            );
            const workspace = createsWorkspace
              ? (await client.createWorkspace(requestedWorkspace!.slice(4)))
                  .workspace
              : (requestedWorkspace ?? callerWorkspace);
            const panes = await client.listPanes({ workspace });
            const placement = chooseAgentSpawnPlacement(
              panes.panes,
              [],
              new Set<string>(),
              { role: "worker" },
            );
            const created =
              placement.kind === "surface"
                ? await client.newSurface({
                    pane: placement.pane,
                    ...(workspace ? { workspace } : {}),
                    type: "terminal",
                  })
                : await client.newSplit(placement.direction, {
                    ...(workspace ? { workspace } : {}),
                    ...(placement.pane ? { pane: placement.pane } : {}),
                    focus: args.focus,
                  });
            creation.record({
              surface_id: created.surface,
              workspace_id: created.workspace ?? workspace ?? null,
            });
            if (args.title) {
              await client.renameTab(created.surface, args.title, {
                workspace: created.workspace ?? workspace,
              });
            }
            const cwdReceipt = args.cwd
              ? await withSurfaceWrite(
                  created.surface,
                  () =>
                    executeDeliveryEngine({
                      surface: created.surface,
                      workspace: created.workspace ?? workspace,
                      chunks: [`cd -- ${shellQuote(args.cwd!)}`],
                      chunk_size: SEND_INPUT_CHUNK_THRESHOLD,
                      chunk_delay_ms: SEND_INPUT_CHUNK_DELAY_MS,
                      press_enter: true,
                      source_event: "send_command",
                      verify_submit: false,
                    }),
                  {
                    toolName: "spawn_agent",
                    workspace: created.workspace ?? workspace,
                    observePtyWrite: true,
                  },
                )
              : undefined;
            return ok({
              version: 1,
              type: "terminal",
              surface_id: created.surface,
              workspace_id: created.workspace ?? workspace ?? null,
              cwd: args.cwd ?? null,
              title: args.title ?? null,
              ...(cwdReceipt ? { cwd_receipt: cwdReceipt } : {}),
            });
          }
          const spawnProblems: string[] = [];
          if (!args.repo) {
            spawnProblems.push("repo is required for type=agent");
          }
          if (!args.cli) {
            spawnProblems.push("cli is required for type=agent");
          }
          const rolelessClaude =
            args.version === 1 &&
            (args.cli === "claude" || args.cli === undefined) &&
            args.role === undefined;
          if (rolelessClaude) {
            spawnProblems.push(
              'Claude spawns require an explicit job role; use either authority:"lead", role:"implementor" or authority:"worker", role:"reviewer"',
            );
          }
          if (args.cli) {
            try {
              resolveSpawnModelPolicy(args.cli, args.model);
            } catch (error) {
              spawnProblems.push(
                error instanceof Error ? error.message : String(error),
              );
            }
            try {
              resolveSpawnEffort(args.cli, args.effort);
            } catch (error) {
              spawnProblems.push(
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          if (spawnProblems.length > 0) {
            const error_code =
              spawnProblems.length === 1 &&
              rolelessClaude &&
              args.cli === "claude"
                ? "ROLE_REQUIRED"
                : spawnProblems.length > 1
                  ? "INVALID_SPAWN_SPEC"
                  : undefined;
            return err(
              new Error(spawnProblems.join("; ")),
              error_code ? { error_code } : {},
            );
          }
          requireValue(args.repo, "repo is required for type=agent");
          requireValue(args.cli, "cli is required for type=agent");
          const normalizedRole = normalizeSpawnAxes({
            role: args.role,
            placement: args.placement,
            authority: args.authority,
          });
          resolveSpawnModelPolicy(args.cli, args.model);
          resolveSpawnEffort(args.cli, args.effort);
          const bootPromptPath = getBootPromptPath(args.boot_prompt_path);
          assertBootPromptMode(args.prompt, bootPromptPath);
          assertSpawnPromptInputAllowed({
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
          await refreshManagedMetadataBestEffort();
          const callerAgent = resolveCurrentCallerAgent();
          const callerRole = callerAgent
            ? inferRecordRoleOrNull(callerAgent)
            : null;
          const callerIsWorker = callerRole === "worker";
          const effectiveParentAgentId = callerIsWorker
            ? callerAgent!.agent_id
            : (args.parent_agent_id ?? callerAgent?.agent_id);
          const effectiveRole = callerIsWorker ? "worker" : normalizedRole.role;
          const workerCallerWarning = callerIsWorker
            ? `Worker caller ${callerAgent!.agent_id} forced child role to worker and recorded itself as parent; worker-spawned agents cannot claim orchestrator placement.`
            : undefined;
          // TODO(#378): a future policy decision may refuse worker-initiated
          // spawn_agent calls entirely. Current binding is force+warn.
          if (
            effectiveParentAgentId &&
            effectiveParentAgentId !== args.parent_agent_id
          ) {
            await refreshManagedMetadataBestEffort(effectiveParentAgentId);
          }
          const parentWorkspace = effectiveParentAgentId
            ? (engine.getAgentState(effectiveParentAgentId)?.workspace_id ??
              undefined)
            : undefined;
          const targetResolution = await resolvePlacementWorkspace({
            explicitWorkspace: args.workspace,
            callerWorkspace: parentWorkspace,
            repo: args.repo,
          });
          const spawnWorkspace = targetResolution.workspace;
          const comparisonWorkspace = spawnWorkspace ?? parentWorkspace;
          await assertWorkspaceMutationAllowed(
            "spawn_agent",
            comparisonWorkspace,
          );
          const requestedRole = inferAgentRole({
            role: effectiveRole,
            cli: args.cli,
            launcherName: launcherNameForCli(args.repo, args.cli),
          });
          const existingSameLaneAgents = args.force_new
            ? []
            : registry
                .list()
                .filter(
                  (agent) =>
                    (agent.state === "ready" || agent.state === "idle") &&
                    reposEquivalent(agent.repo, args.repo!) &&
                    (agent.workspace_id ?? null) ===
                      (comparisonWorkspace ?? null) &&
                    inferRecordRoleOrNull(agent) === requestedRole,
                )
                .map((agent) => ({
                  agent_id: agent.agent_id,
                  surface_id: agent.surface_id,
                  workspace_id: agent.workspace_id ?? null,
                  state: agent.state,
                  role: inferRecordRoleOrNull(agent),
                  task_summary: summarizeTaskSummary(agent.task_summary),
                }));
          const duplicateSpawnWarning =
            existingSameLaneAgents.length > 0
              ? `Existing same-lane agent(s) are idle/ready in ${comparisonWorkspace ?? "unknown workspace"}; reuse or supersede unless a new lane is intentional. Pass force_new:true to suppress this warning.`
              : undefined;
          const spawnPrompt = hasInlinePrompt(args.prompt)
            ? args.prompt
            : (bootPromptText ?? "");
          // Prepare only after every non-spawn gate has passed. From this point
          // onward the catch below owns rollback for any newly created worktree.
          const worktree = await prepareSpawnWorktree(
            args.repo,
            args.worktree,
            args.mcp_profile as McpProfile | undefined,
          );
          const cleanupFailedLauncherArtifacts = async (
            error: Error,
            agentId: string,
            surface: string,
            workspace?: string,
          ): Promise<boolean> => {
            const record = engine.getAgentState(agentId);
            const cleanupSurface = record?.surface_uuid?.trim() || surface;
            try {
              await client.closeSurface(cleanupSurface, { workspace });
            } catch (cleanupError) {
              error.message = `${error.message}. Failed to close launcher surface ${cleanupSurface}: ${
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError)
              }`;
              return false;
            }
            const current = engine.getAgentState(agentId);
            if (current && !TERMINAL_AGENT_STATES.has(current.state)) {
              try {
                const failed = stateMgr.transition(agentId, "error", {
                  error: `Launcher surface closed after failed readiness: ${error.message}`,
                });
                registry.set(agentId, failed);
              } catch (stateError) {
                error.message = `${error.message}. Failed to mark closed launcher agent ${agentId} terminal: ${
                  stateError instanceof Error
                    ? stateError.message
                    : String(stateError)
                }`;
              }
            }
            if (worktree.prepared?.created && worktree.repoRoot) {
              try {
                await rollbackPreparedWorktree(
                  worktree.repoRoot,
                  worktree.prepared,
                  opts?.worktreeExec,
                );
              } catch (rollbackError) {
                error.message = `${error.message}. Worktree rollback also failed: ${
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError)
                }`;
              }
            }
            return true;
          };
          let focusRestoreLease = await focusTargetBeforeSplit(
            spawnWorkspace,
            args.focus !== true,
          );
          let surfaceCreated = false;
          let result: Awaited<ReturnType<typeof engine.spawnAgent>>;
          try {
            result = await engine.spawnAgent({
              repo: args.repo,
              model: args.model,
              effort: args.effort,
              cli: args.cli,
              prompt: spawnPrompt,
              boot_prompt_path: bootPromptPath,
              boot_prompt_pending: true,
              workspace: spawnWorkspace,
              cwd: worktree.prepared?.path,
              mcp_env: worktree.mcpEnv,
              mcp_profile_label: worktree.mcpProfileLabel,
              worktree_branch: worktree.prepared?.branch,
              parent_agent_id: effectiveParentAgentId,
              role: effectiveRole,
              authority: callerIsWorker ? "worker" : normalizedRole.authority,
              function: normalizedRole.function,
              placement: callerIsWorker ? "right" : normalizedRole.placement,
              auto_archive_on_done: args.auto_archive_on_done ?? false,
              max_cost_per_agent: args.max_cost_per_agent,
              crash_recover: args.crash_recover,
              auto_revive: args.auto_revive,
              halt_escalation: args.halt_escalation,
              boot_prompt_timeout_ms: args.boot_prompt_timeout_ms,
              on_surface_created: async (created) => {
                surfaceCreated = true;
                creation.record({
                  agent_id: created.agent_id,
                  surface_id: created.surface,
                  workspace_id: created.workspace ?? spawnWorkspace ?? null,
                });
                focusRestoreLease = await capturePostCreationFocus(
                  focusRestoreLease,
                  created,
                );
              },
            });
          } catch (e) {
            if (
              e instanceof AgentLaunchError &&
              e.launch_phase === "launch" &&
              (e.launch_cause instanceof LauncherReadinessError ||
                (e.launch_cause instanceof BootPromptTimeoutError &&
                  e.launch_cause.pending_input_observed))
            ) {
              await cleanupFailedLauncherArtifacts(
                e,
                e.agent_id,
                e.surface_id,
                e.workspace_id,
              );
            }
            let rollbackError: unknown = null;
            if (
              !surfaceCreated &&
              worktree.prepared?.created &&
              worktree.repoRoot
            ) {
              try {
                await rollbackPreparedWorktree(
                  worktree.repoRoot,
                  worktree.prepared,
                  opts?.worktreeExec,
                );
              } catch (error) {
                rollbackError = error;
              }
            }
            try {
              await restoreFocusAfterRender(
                focusRestoreLease,
                undefined,
                spawnWorkspace,
              );
            } catch {
              // Preserve the original spawn error response.
            }
            if (rollbackError) {
              const rollback =
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError);
              if (e instanceof Error) {
                e.message = `${e.message}. Worktree rollback also failed: ${rollback}`;
                throw e;
              }
              throw new Error(
                `${String(e)}. Worktree rollback also failed: ${rollback}`,
                { cause: e },
              );
            }
            throw e;
          }
          const originalLaunchCommand = originalLaunchCommandsBySurface.get(
            result.surface_id,
          );
          originalLaunchCommandsBySurface.delete(result.surface_id);
          const launchShellRecovery = launchShellRecoveryBySurface.get(
            result.surface_id,
          );
          launchShellRecoveryBySurface.delete(result.surface_id);
          const monitorBoot = ensureMonitorBoot(result.agent_id);
          const coordination = issueSpawnCoordination(
            result.agent_id,
            args.report_path,
          );
          // AIDEV-NOTE (P11b): P11 could not deliver this contract -- inline,
          // the mailbox contract alone was ~479 chars against a 500-char chunk
          // threshold, so appending the report contract (measured 618 chars)
          // moved every spawn onto the chunked paste path (#434/#438). The
          // contract now goes to a file and the wire carries one short line, so
          // the worker is finally TOLD the same two strings the receipt reports.
          const bootContract = buildBootContractInjection(
            result.agent_id,
            monitorBoot,
            coordination,
          );
          const injectedBootPrompt = bootContract.text;
          result.report_path = coordination.report_path;
          result.done_marker = coordination.done_marker;
          // Finding 3: never report the contract's size without reporting how
          // (or whether) it reached the worker -- the v0.4.42 `paused`
          // provenance fix, applied to both outcomes of the fallback above.
          result.coordination_footer_bytes =
            coordinationFooterBytes(coordination);
          result.contract_path = bootContract.contract_path ?? undefined;
          result.coordination_footer_delivered =
            bootContract.contract_path !== null;
          result.coordination_footer_note = bootContract.contract_path
            ? COORDINATION_CONTRACT_DELIVERED_NOTE
            : COORDINATION_FOOTER_NOT_DELIVERED;
          try {
            const patched = stateMgr.updateRecord(result.agent_id, {
              report_path: coordination.report_path,
              done_marker: coordination.done_marker,
            });
            registry.set(result.agent_id, patched);
          } catch {
            // Receipt already carries the contract; a registry write failure
            // must not fail an otherwise-successful spawn.
          }
          const spawnedBinding = engine.getAgentState(result.agent_id);
          appendStaleBuildWarning(result);
          const placementWarnings = [
            ...targetResolution.warnings,
            ...(normalizedRole.warning ? [normalizedRole.warning] : []),
            ...(workerCallerWarning ? [workerCallerWarning] : []),
          ];
          if (placementWarnings.length > 0) {
            result.warnings = [
              ...(result.warnings ?? []),
              ...placementWarnings,
            ];
          }

          let bootPromptDelivery:
            Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
          let launcherSurfaceClosed = false;
          try {
            {
              const deliveryWorkspace = spawnDeliveryWorkspace(
                result,
                spawnWorkspace,
              );
              bootPromptDelivery = await deliverBootPrompt({
                surface: result.surface_id,
                workspace: deliveryWorkspace,
                stableSurfaceIdentity: spawnedBinding?.surface_uuid,
                resolveRoute: spawnedBinding?.surface_uuid
                  ? () => resolveManagedDeliveryRoute(result.agent_id)
                  : undefined,
                cli: args.cli,
                prompt: args.prompt,
                boot_prompt_path: bootPromptPath,
                injected_prompt: injectedBootPrompt,
                timeout_ms: args.boot_prompt_timeout_ms,
                onUpdateShellRelaunch: () =>
                  relaunchSpawnAgentAfterUpdate({
                    agentId: result.agent_id,
                    surface: result.surface_id,
                    workspace: deliveryWorkspace,
                    model: result.model ?? args.model,
                    mcpEnv: result.mcp_env,
                    originalCommand: originalLaunchCommand,
                    timeout_ms: args.boot_prompt_timeout_ms,
                  }),
              });

              await captureSpawnSessionBestEffort(result);
              if (bootPromptDelivery.prompt_text !== null) {
                const updated = stateMgr.updateRecord(result.agent_id, {
                  ...bootPromptRegistryFields(
                    bootPromptDelivery.prompt_text,
                    bootPromptPath,
                  ),
                  boot_prompt_pending: false,
                  prompt_delivered: bootPromptDelivery.submit_verified === true,
                  submit_verified: bootPromptDelivery.submit_verified,
                });
                registry.set(result.agent_id, updated);
              } else {
                const updated = stateMgr.updateRecord(result.agent_id, {
                  boot_prompt_pending: false,
                  prompt_delivered: false,
                  submit_verified: null,
                });
                registry.set(result.agent_id, updated);
              }

              const current = engine.getAgentState(result.agent_id);
              if (
                current?.state === "booting" &&
                (hasInlinePrompt(args.prompt) || Boolean(bootPromptPath)) &&
                bootPromptDelivery.submit_verified === true
              ) {
                const ready = stateMgr.transition(result.agent_id, "ready");
                registry.set(result.agent_id, ready);
                result.state = "ready";
              } else if (current?.state === "ready") {
                result.state = "ready";
              }
            }
          } catch (e) {
            creation.attach(e);
            if (e instanceof LauncherReadinessError) {
              launcherSurfaceClosed = await cleanupFailedLauncherArtifacts(
                e,
                result.agent_id,
                result.surface_id,
                spawnDeliveryWorkspace(result, spawnWorkspace),
              );
            }
            const message = e instanceof Error ? e.message : String(e);
            const clearBootPromptPending = () => {
              const record = resolveSpawnRecord(
                result.agent_id,
                result.surface_id,
              );
              const agentId = record?.agent_id ?? result.agent_id;
              const updated = stateMgr.updateRecord(agentId, {
                // A readiness timeout happens before delivery. Preserve the
                // pending marker so a later idle CLI cannot be mistaken for a
                // successfully tasked agent by the lifecycle sweep.
                boot_prompt_pending: e instanceof BootPromptTimeoutError,
                prompt_delivered: false,
                submit_verified:
                  e instanceof BootPromptDeliveryError ? false : null,
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
            try {
              // Boot delivery already performed its own readiness wait. On a
              // timeout, restore immediately instead of starting a second wait.
              await restoreFocusAfterRender(
                focusRestoreLease,
                launcherSurfaceClosed ? undefined : result.surface_id,
                spawnDeliveryWorkspace(result, spawnWorkspace),
                { waitForReady: false },
              );
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

          const focusRestoreWarning = await restoreFocusAfterRender(
            focusRestoreLease,
            result.surface_id,
            spawnDeliveryWorkspace(result, spawnWorkspace),
            {
              waitForReady: !bootPromptDelivery,
            },
          );
          if (focusRestoreWarning) {
            result.warnings = [...(result.warnings ?? []), focusRestoreWarning];
          }

          await refreshManagedMetadataBestEffort(result.agent_id);
          await lifecycleSeatManifestPublisher({
            agentId: result.agent_id,
          });
          const currentAgent = engine.getAgentState(result.agent_id);
          const topologyRole =
            currentAgent?.role ??
            inferAgentRole({
              role: effectiveRole,
              cli: args.cli,
              launcherName: launcherNameForCli(args.repo, args.cli),
            });
          const topology = currentAgent ? await collectSurfaceTopology() : null;
          const health = currentAgent
            ? await evaluateServerAgentHealth(
                currentAgent,
                {
                  ...healthTopologyOverrides(currentAgent, topology),
                },
                topology,
              )
            : undefined;

          const formattedData = {
            agent_id: result.agent_id,
            parent_agent_id: result.parent_agent_id,
            repo: args.repo,
            model: result.model ?? args.model,
            requested_model: result.requested_model,
            warning:
              result.warnings && result.warnings.length > 0
                ? result.warnings.join(" | ")
                : undefined,
            surface: result.surface_id,
            role: args.version === 1 ? normalizedRole.function : topologyRole,
            authority: callerIsWorker ? "worker" : normalizedRole.authority,
            placement: callerIsWorker ? "right" : normalizedRole.placement,
            version: 1,
            type: "agent",
            health,
            duplicate_spawn_warning: duplicateSpawnWarning,
            monitor_boot: monitorBoot,
            boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
          };
          const responseData = {
            ...result,
            worktree: worktree.prepared,
            mcp_profile: worktree.mcpProfileLabel,
            role: args.version === 1 ? normalizedRole.function : topologyRole,
            authority: callerIsWorker ? "worker" : normalizedRole.authority,
            placement: callerIsWorker ? "right" : normalizedRole.placement,
            version: 1,
            type: "agent",
            health,
            duplicate_spawn_warning: duplicateSpawnWarning,
            existing_same_lane_agents: existingSameLaneAgents,
            monitor_boot: monitorBoot,
            boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
            boot_prompt_receipt: bootPromptDelivery,
            boot_prompt_bytes: bootPromptDelivery?.bytes,
            boot_prompt_submit_verified:
              bootPromptDelivery?.submit_verified ?? null,
            ...(launchShellRecovery?.recovered
              ? {
                  readiness_recovered: true,
                  readiness_cleared: launchShellRecovery.cleared,
                }
              : {}),
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
          const caught = creation.attach(e);
          if (caught instanceof AgentLaunchError) {
            if (caught.launch_cause instanceof DeliverySafetyGateError) {
              creation.attach(caught.launch_cause);
              return err(caught.launch_cause, {
                agent_id: caught.agent_id,
                surface_id: caught.surface_id,
                workspace_id: caught.workspace_id,
                error_code: caught.launch_cause.error_code,
                submit_verified: caught.launch_cause.submit_verified,
                screen: caught.launch_cause.screen,
              });
            }
            if (caught.launch_cause instanceof SurfaceGoneError) {
              creation.attach(caught.launch_cause);
              return err(
                caught.launch_cause,
                surfaceGonePayload(caught.launch_cause, {
                  agent_id: caught.agent_id,
                  surface_id: caught.surface_id,
                  workspace_id: caught.workspace_id,
                }),
              );
            }
            return err(caught, {
              agent_id: caught.agent_id,
              surface_id: caught.surface_id,
              workspace_id: caught.workspace_id,
            });
          }
          if (caught instanceof DeliverySafetyGateError) {
            return err(caught, {
              error_code: caught.error_code,
              submit_verified: caught.submit_verified,
              screen: caught.screen,
            });
          }
          if (caught instanceof SurfaceGoneError) {
            return err(caught, surfaceGonePayload(caught));
          }
          return err(caught);
        }
      },
    );

    server.tool(
      "new_worktree_split",
      `${PANE_INPUT_BREAKAGE_GUIDANCE} Create or reuse a git worktree and spawn one worker agent into a right-side cmux split. Returns a lean response by default; pass verbose:true for the full legacy health and worktree bookkeeping. Defaults to inherited MCPs and preserves the existing worker layout policy.`,
      {
        repo: z.string().describe("Repository name"),
        model: z.string().describe("Model name"),
        cli: z
          .enum(["claude", "codex", "gemini", "kiro", "cursor"])
          .describe("CLI tool to launch"),
        prompt: z
          .string()
          .optional()
          .describe(
            `${PANE_INPUT_BREAKAGE_GUIDANCE} Optional inline boot prompt.`,
          ),
        boot_prompt_timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional timeout override in milliseconds for initial shell readiness, agent launch readiness, and the boot prompt. When omitted, each phase keeps its established default (10s shell, 15s launch, 60s boot prompt).",
          ),
        workspace: z.string().optional().describe("Target workspace ref"),
        worktree: worktreeArgSchema
          .optional()
          .describe(
            'Worktree options. Pass a string such as "tool-usage" as the worktree name, true for a generated name, or an options object. A repoGolem registration with an absolute path names the repo root; without one it is resolved from CMUXLAYER_REPO_HOME, the running checkout, or ~/Gits. Defaults to true, creating/reusing <registered-root>/.worktrees/<generated-name>; a newly created worktree and branch are rolled back if spawn fails before a recoverable surface exists (legacy ~/Gits/<repo>.wt read-fallback until ~2026-09).',
          ),
        mcp_profile: mcpProfileSchema
          .optional()
          .describe("MCP profile hint. Defaults to inherit."),
        parent_agent_id: z.string().optional(),
        auto_archive_on_done: z.boolean().optional().default(false),
        crash_recover: z.boolean().optional(),
        auto_revive: z.boolean().optional().default(true),
        halt_escalation: z.boolean().optional().default(true),
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
        const creation = new CreatedIdentityScope();
        let focusRestoreLease: FocusRestoreLease | null = null;
        let result: Awaited<ReturnType<typeof engine.spawnAgent>> | undefined;
        let mutationWorkspace: string | undefined;
        let surfaceCreated = false;
        let worktree:
          Awaited<ReturnType<typeof prepareSpawnWorktree>> | undefined;
        try {
          resolveSpawnModelPolicy(args.cli, args.model);
          assertBootPromptMode(args.prompt, null);
          assertSpawnPromptInputAllowed({
            tool: "new_worktree_split",
            value: args.prompt,
            cli: args.cli,
            allowLongInlineSupported: false,
          });
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
          mutationWorkspace = targetResolution.workspace;
          await assertWorkspaceMutationAllowed(
            "new_worktree_split",
            mutationWorkspace,
          );
          focusRestoreLease = await focusTargetBeforeSplit(mutationWorkspace);
          worktree = await prepareSpawnWorktree(
            args.repo,
            args.worktree ?? true,
            args.mcp_profile as McpProfile | undefined,
          );
          const hasPrompt = hasInlinePrompt(args.prompt);
          result = await engine.spawnAgent({
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
            auto_revive: args.auto_revive,
            halt_escalation: args.halt_escalation,
            on_surface_created: async (created) => {
              surfaceCreated = true;
              creation.record({
                agent_id: created.agent_id,
                surface_id: created.surface,
                workspace_id: created.workspace ?? mutationWorkspace ?? null,
              });
              focusRestoreLease = await capturePostCreationFocus(
                focusRestoreLease,
                created,
              );
            },
            boot_prompt_timeout_ms: args.boot_prompt_timeout_ms,
          });
          const originalLaunchCommand = originalLaunchCommandsBySurface.get(
            result.surface_id,
          );
          originalLaunchCommandsBySurface.delete(result.surface_id);
          const launchShellRecovery = launchShellRecoveryBySurface.get(
            result.surface_id,
          );
          launchShellRecoveryBySurface.delete(result.surface_id);
          appendStaleBuildWarning(result);
          if (targetResolution.warnings.length > 0) {
            result.warnings = [
              ...(result.warnings ?? []),
              ...targetResolution.warnings,
            ];
          }

          let bootPromptDelivery:
            Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;
          if (hasPrompt) {
            const deliveryWorkspace = spawnDeliveryWorkspace(
              result,
              mutationWorkspace,
            );
            bootPromptDelivery = await deliverBootPrompt({
              surface: result.surface_id,
              workspace: deliveryWorkspace,
              resolveRoute: () => resolveManagedDeliveryRoute(result!.agent_id),
              cli: args.cli,
              prompt: args.prompt,
              timeout_ms: args.boot_prompt_timeout_ms,
              onUpdateShellRelaunch: () =>
                relaunchSpawnAgentAfterUpdate({
                  agentId: result!.agent_id,
                  surface: result!.surface_id,
                  workspace: deliveryWorkspace,
                  model: result!.model ?? args.model,
                  mcpEnv: result!.mcp_env,
                  originalCommand: originalLaunchCommand,
                  timeout_ms: args.boot_prompt_timeout_ms,
                }),
            });
            canonicalizeSpawnResult(result);
            const updated = stateMgr.updateRecord(result.agent_id, {
              ...bootPromptRegistryFields(
                bootPromptDelivery.prompt_text ?? args.prompt ?? "",
              ),
              boot_prompt_pending: false,
            });
            registry.set(result.agent_id, updated);
          }

          const focusRestoreWarning = await restoreFocusAfterRender(
            focusRestoreLease,
            result.surface_id,
            spawnDeliveryWorkspace(result, mutationWorkspace),
            { waitForReady: !hasPrompt },
          );
          if (focusRestoreWarning) {
            result.warnings = [...(result.warnings ?? []), focusRestoreWarning];
          }
          await refreshManagedMetadataBestEffort(result.agent_id);
          await lifecycleSeatManifestPublisher({
            agentId: result.agent_id,
          });
          const currentAgent = engine.getAgentState(result.agent_id);
          const topology = currentAgent ? await collectSurfaceTopology() : null;
          const health = currentAgent
            ? await evaluateServerAgentHealth(
                currentAgent,
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
            boot_prompt_receipt: bootPromptDelivery,
            boot_prompt_bytes: bootPromptDelivery?.bytes,
            boot_prompt_submit_verified:
              bootPromptDelivery?.submit_verified ?? null,
            ...(launchShellRecovery?.recovered
              ? {
                  readiness_recovered: true,
                  readiness_cleared: launchShellRecovery.cleared,
                }
              : {}),
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
          let caught: unknown = creation.attach(e);
          if (
            !result &&
            !surfaceCreated &&
            worktree?.prepared?.created &&
            worktree.repoRoot
          ) {
            try {
              await rollbackPreparedWorktree(
                worktree.repoRoot,
                worktree.prepared,
                opts?.worktreeExec,
              );
            } catch (rollbackError) {
              const rollback =
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError);
              if (e instanceof Error) {
                e.message = `${e.message}. Worktree rollback also failed: ${rollback}`;
                caught = e;
              } else {
                caught = new Error(
                  `${String(e)}. Worktree rollback also failed: ${rollback}`,
                  { cause: e },
                );
              }
            }
          }
          caught = creation.attach(caught);
          await restoreFocusAfterRender(
            focusRestoreLease,
            result?.surface_id,
            result
              ? spawnDeliveryWorkspace(result, mutationWorkspace)
              : mutationWorkspace,
            { waitForReady: false },
          );
          const createdIdentity = result
            ? {
                agent_id: result.agent_id,
                surface_id: result.surface_id,
                workspace_id: result.workspace_id ?? mutationWorkspace,
              }
            : {};
          if (caught instanceof AgentLaunchError) {
            if (caught.launch_cause instanceof DeliverySafetyGateError) {
              return err(caught.launch_cause, {
                agent_id: caught.agent_id,
                surface_id: caught.surface_id,
                workspace_id: caught.workspace_id,
                error_code: caught.launch_cause.error_code,
                submit_verified: caught.launch_cause.submit_verified,
                screen: caught.launch_cause.screen,
              });
            }
            if (caught.launch_cause instanceof SurfaceGoneError) {
              return err(
                caught.launch_cause,
                surfaceGonePayload(caught.launch_cause, {
                  agent_id: caught.agent_id,
                  surface_id: caught.surface_id,
                  workspace_id: caught.workspace_id,
                }),
              );
            }
            return err(caught, {
              agent_id: caught.agent_id,
              surface_id: caught.surface_id,
              workspace_id: caught.workspace_id,
            });
          }
          if (caught instanceof DeliverySafetyGateError) {
            return err(caught, {
              ...createdIdentity,
              error_code: caught.error_code,
              submit_verified: caught.submit_verified,
              screen: caught.screen,
            });
          }
          if (caught instanceof SubmitVerificationError) {
            return err(caught, {
              ...createdIdentity,
              submit_verified: false,
              retry_count: caught.retry_count,
            });
          }
          if (caught instanceof SurfaceGoneError) {
            return err(caught, surfaceGonePayload(caught, createdIdentity));
          }
          if (caught instanceof BootPromptTimeoutError) {
            return err(caught, {
              ...createdIdentity,
              last_10_lines: caught.last_10_lines,
            });
          }
          if (caught instanceof BootPromptUpdateMenuBlockedError) {
            return err(caught, {
              ...createdIdentity,
              error_code: caught.error_code,
              last_10_lines: caught.last_10_lines,
              recovery: caught.recovery,
            });
          }
          if (caught instanceof BootPromptDeliveryError) {
            return err(caught, {
              ...createdIdentity,
              delivered_chars: caught.delivered_chars,
            });
          }
          return err(caught, createdIdentity);
        }
      },
    );

    server.tool(
      "spawn_in_workspace",
      `${PANE_INPUT_BREAKAGE_GUIDANCE} Create a workspace and spawn a set of agents into it as a clean 2-pane grid (commanders LEFT, workers RIGHT). Returns lean per-agent responses by default; pass verbose:true for the full legacy response. Handles workspace creation, selection, and role-based pane placement atomically. Use this instead of repeated spawn_agent calls when standing up a multi-agent team.`,
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
              role: legacyCompatibleAgentRoleSchema().optional(),
              prompt: z
                .string()
                .optional()
                .describe(
                  `${PANE_INPUT_BREAKAGE_GUIDANCE} Optional inline boot prompt.`,
                ),
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
        const creation = new CreatedIdentityScope();
        const originFocus = await currentFocusTarget();
        let focusRestoreLease: FocusRestoreLease | null = null;
        let workspace: string | undefined;
        let lastSurface: string | undefined;
        let activeSpawnIdentity:
          | {
              agent_id: string;
              surface_id: string;
              workspace_id: string | null;
            }
          | undefined;
        const createdAgentIdentities: Array<{
          agent_id: string;
          surface_id: string;
          workspace_id: string | null;
        }> = [];
        const spawnedAgents: Array<{
          agent_id: string;
          surface_id: string;
          repo: string;
          cli: CliType;
          role: AgentRole;
          health?: ReturnType<typeof evaluateAgentHealth>;
          monitor_boot?: MonitorBootResult;
          boot_prompt_delivered?: boolean;
          boot_prompt_receipt?: PublicDeliveryReceipt & {
            bytes: number;
            prompt_text: string | null;
            prompt_warning: string | null;
          };
          boot_prompt_submit_verified?: boolean | null;
        }> = [];
        const leanSpawnedAgents: Record<string, unknown>[] = [];
        try {
          const normalizedAgents = args.agents.map((agent) => {
            assertSpawnPromptInputAllowed({
              tool: "spawn_in_workspace",
              value: agent.prompt,
              cli: agent.cli,
              allowLongInlineSupported: false,
            });
            const normalizedRole = normalizeToolAgentRole(agent.role, "role");
            return {
              ...agent,
              role: normalizedRole.role,
              compatibilityWarning: normalizedRole.warning,
            };
          });
          for (const agent of normalizedAgents) {
            resolveSpawnModelPolicy(agent.cli, agent.model);
          }
          const compatibilityWarnings = normalizedAgents.flatMap((agent) =>
            agent.compatibilityWarning ? [agent.compatibilityWarning] : [],
          );
          if (args.reuse_workspace) {
            for (const agent of normalizedAgents) {
              await assertWorkspaceBelongsToRepo(
                args.reuse_workspace,
                agent.repo,
              );
            }
          }
          await assertWorkspaceMutationAllowed(
            "spawn_in_workspace",
            args.reuse_workspace ?? (await currentSafetyCallerWorkspace()),
          );
          // A newly created workspace may auto-focus immediately, so capture
          // the user's origin before createWorkspace can move it.
          const workspaceResult = args.reuse_workspace
            ? { workspace: args.reuse_workspace, title: args.workspace_title }
            : await client.createWorkspace(args.workspace_title);
          workspace = workspaceResult.workspace;
          if (!workspace) {
            throw new Error("create_workspace returned an empty workspace ref");
          }
          creation.record({ workspace, workspace_id: workspace });

          focusRestoreLease = await focusTargetBeforeSplit(
            workspace,
            true,
            originFocus,
          );
          // focusTargetBeforeSplit ensures the target is selected when cmux's
          // current focus cannot prove it already is. The lease drives
          // focus-back only while the user has not moved since cmuxlayer's
          // latest placement mutation.
          focusRestoreLease = await capturePostCreationFocus(focusRestoreLease);

          for (const agent of normalizedAgents) {
            const hasPrompt = hasInlinePrompt(agent.prompt);
            activeSpawnIdentity = undefined;
            const result = await engine.spawnAgent({
              repo: agent.repo,
              model: agent.model,
              cli: agent.cli,
              prompt: agent.prompt ?? "",
              boot_prompt_pending: true,
              workspace,
              role: agent.role,
              auto_archive_on_done: false,
              on_surface_created: async (created) => {
                const identity = {
                  agent_id: created.agent_id,
                  surface_id: created.surface,
                  workspace_id: created.workspace ?? workspace ?? null,
                };
                creation.record(identity);
                creation.append(
                  "agents",
                  identity,
                  (left, right) => left.surface_id === right.surface_id,
                );
                focusRestoreLease = await capturePostCreationFocus(
                  focusRestoreLease,
                  created,
                );
              },
            });
            activeSpawnIdentity = {
              agent_id: result.agent_id,
              surface_id: result.surface_id,
              workspace_id: result.workspace_id ?? workspace ?? null,
            };
            creation.record(activeSpawnIdentity);
            creation.append(
              "agents",
              activeSpawnIdentity,
              (left, right) => left.surface_id === right.surface_id,
            );
            createdAgentIdentities.push(activeSpawnIdentity);
            lastSurface = result.surface_id;
            const originalLaunchCommand = originalLaunchCommandsBySurface.get(
              result.surface_id,
            );
            originalLaunchCommandsBySurface.delete(result.surface_id);
            const launchShellRecovery = launchShellRecoveryBySurface.get(
              result.surface_id,
            );
            launchShellRecoveryBySurface.delete(result.surface_id);
            const monitorBoot = ensureMonitorBoot(result.agent_id);
            // P11b: pointer form here too, so no spawn path keeps the ~479-char
            // inline contract on the wire. `null` because this batch path never
            // issued a coordination contract (P11 wired spawn_agent only), so
            // the file carries the mailbox half alone -- exactly what this path
            // delivered before, now via the pointer.
            const injectedBootPrompt = buildBootContractInjection(
              result.agent_id,
              monitorBoot,
              null,
            ).text;
            const spawnedBinding = engine.getAgentState(result.agent_id);
            appendStaleBuildWarning(result);
            let bootPromptDelivery:
              Awaited<ReturnType<typeof deliverBootPrompt>> | undefined;

            {
              const deliveryWorkspace = spawnDeliveryWorkspace(
                result,
                workspace,
              );
              bootPromptDelivery = await deliverBootPrompt({
                surface: result.surface_id,
                workspace: deliveryWorkspace,
                stableSurfaceIdentity: spawnedBinding?.surface_uuid,
                resolveRoute: spawnedBinding?.surface_uuid
                  ? () => resolveManagedDeliveryRoute(result.agent_id)
                  : undefined,
                cli: agent.cli,
                prompt: agent.prompt,
                injected_prompt: injectedBootPrompt,
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
              activeSpawnIdentity.agent_id = result.agent_id;
              activeSpawnIdentity.workspace_id =
                result.workspace_id ?? workspace ?? null;
              const updated = stateMgr.updateRecord(result.agent_id, {
                ...bootPromptRegistryFields(
                  bootPromptDelivery.prompt_text ?? agent.prompt ?? "",
                ),
                boot_prompt_pending: false,
                prompt_delivered:
                  hasPrompt && bootPromptDelivery.submit_verified === true,
                submit_verified: hasPrompt
                  ? bootPromptDelivery.submit_verified
                  : null,
              });
              registry.set(result.agent_id, updated);

              const current = engine.getAgentState(result.agent_id);
              if (current?.state === "booting" && hasPrompt) {
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
            const topology = currentAgent
              ? await collectSurfaceTopology()
              : null;
            const health = currentAgent
              ? await evaluateServerAgentHealth(
                  currentAgent,
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
              boot_prompt_delivered: isBootPromptDelivered(bootPromptDelivery),
              boot_prompt_receipt: bootPromptDelivery,
              boot_prompt_submit_verified:
                bootPromptDelivery?.submit_verified ?? null,
              ...(launchShellRecovery?.recovered
                ? {
                    readiness_recovered: true,
                    readiness_cleared: launchShellRecovery.cleared,
                  }
                : {}),
            });
            leanSpawnedAgents.push(
              shapeSpawnResponse({
                ...result,
                role,
                health,
                boot_prompt_delivered:
                  isBootPromptDelivered(bootPromptDelivery),
                boot_prompt_receipt: bootPromptDelivery,
                boot_prompt_submit_verified:
                  bootPromptDelivery?.submit_verified ?? null,
                ...(launchShellRecovery?.recovered
                  ? {
                      readiness_recovered: true,
                      readiness_cleared: launchShellRecovery.cleared,
                    }
                  : {}),
              }),
            );
          }

          const focusRestoreWarning = await restoreFocusAfterRender(
            focusRestoreLease,
            lastSurface,
            workspace,
            { waitForReady: false },
          );

          // spawn_in_workspace builds its response from the per-agent objects,
          // which drop each result.warnings — so surface the stale-build warning
          // at the aggregate level (otherwise a stale MCP serving a multi-agent
          // workspace spawn would return NO warning).
          const staleWarning = staleBuildWarning();
          const workspaceWarnings = [
            ...(staleWarning ? [staleWarning] : []),
            ...(focusRestoreWarning ? [focusRestoreWarning] : []),
            ...compatibilityWarnings,
          ];

          const formattedData = {
            workspace,
            agents: spawnedAgents.length,
            ...(workspaceWarnings.length > 0
              ? { warning: workspaceWarnings.join(" | ") }
              : {}),
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
          const caught = creation.attach(e);
          await restoreFocusAfterRender(
            focusRestoreLease,
            lastSurface,
            workspace,
            { waitForReady: false },
          );
          const failedIdentity =
            caught instanceof AgentLaunchError
              ? {
                  agent_id: caught.agent_id,
                  surface_id: caught.surface_id,
                  workspace_id: caught.workspace_id ?? null,
                }
              : activeSpawnIdentity;
          const failureAgents = [...createdAgentIdentities];
          if (
            failedIdentity &&
            !failureAgents.some(
              (candidate) =>
                candidate.agent_id === failedIdentity.agent_id &&
                candidate.surface_id === failedIdentity.surface_id,
            )
          ) {
            failureAgents.push(failedIdentity);
          }
          const failureIdentityPayload = {
            ...(workspace ? { workspace, workspace_id: workspace } : {}),
            ...(failedIdentity ?? {}),
            ...(failureAgents.length > 0 ? { agents: failureAgents } : {}),
          };
          if (caught instanceof AgentLaunchError) {
            if (caught.launch_cause instanceof DeliverySafetyGateError) {
              creation.attach(caught.launch_cause);
              return err(caught.launch_cause, {
                ...failureIdentityPayload,
                error_code: caught.launch_cause.error_code,
                submit_verified: caught.launch_cause.submit_verified,
                screen: caught.launch_cause.screen,
              });
            }
            if (caught.launch_cause instanceof SurfaceGoneError) {
              creation.attach(caught.launch_cause);
              return err(
                caught.launch_cause,
                surfaceGonePayload(caught.launch_cause, failureIdentityPayload),
              );
            }
            return err(caught, failureIdentityPayload);
          }
          if (caught instanceof DeliverySafetyGateError) {
            return err(caught, {
              ...failureIdentityPayload,
              error_code: caught.error_code,
              submit_verified: caught.submit_verified,
              screen: caught.screen,
            });
          }
          if (caught instanceof SubmitVerificationError) {
            return err(caught, {
              ...failureIdentityPayload,
              submit_verified: false,
              retry_count: caught.retry_count,
            });
          }
          if (caught instanceof SurfaceGoneError) {
            return err(
              caught,
              surfaceGonePayload(caught, failureIdentityPayload),
            );
          }
          if (caught instanceof BootPromptTimeoutError) {
            return err(caught, {
              ...failureIdentityPayload,
              last_10_lines: caught.last_10_lines,
            });
          }
          if (caught instanceof BootPromptUpdateMenuBlockedError) {
            return err(caught, {
              ...failureIdentityPayload,
              error_code: caught.error_code,
              last_10_lines: caught.last_10_lines,
              recovery: caught.recovery,
            });
          }
          if (caught instanceof BootPromptDeliveryError) {
            return err(caught, {
              ...failureIdentityPayload,
              delivered_chars: caught.delivered_chars,
            });
          }
          return err(caught, failureIdentityPayload);
        }
      },
    );

    // 12. wait_for
    server.tool(
      "wait_for",
      "Block until one agent_id or every agent in ids reaches a target registry state and return health. Defaults to waiting for completion (`done`).",
      {
        watch: WatchSpecSchema.optional().describe(
          "Declared WatchSpec alternative to agent_id/ids",
        ),
        agent_id: z
          .string()
          .optional()
          .describe("Single agent ID from spawn_agent"),
        delivery_id: z
          .string()
          .optional()
          .describe(
            "Wait for a send_to delivery_id to reach a terminal outcome",
          ),
        ids: z
          .array(z.string())
          .min(1)
          .optional()
          .describe("Agent IDs to wait for together"),
        mine: z
          .boolean()
          .optional()
          .default(false)
          .describe("Wait for every direct child of the calling agent"),
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
          if (args.watch) {
            if (args.agent_id || args.ids || args.mine || args.delivery_id) {
              throw new Error(
                "wait_for watch is mutually exclusive with agent_id, ids, mine, and delivery_id",
              );
            }
            const result = await engine.waitForWatch(
              args.watch as WatchSpec,
              args.timeout_ms,
            );
            return okFormatted(
              formatOk("wait_for", {
                watch_id: result.watch.watch_id,
                state: result.watch.state,
              }),
              result,
            );
          }
          if (args.delivery_id) {
            if (args.agent_id || args.ids || args.mine) {
              throw new Error(
                "wait_for delivery_id is mutually exclusive with agent_id, ids, and mine",
              );
            }
            const receipt = await engine.waitForDelivery(
              args.delivery_id,
              args.timeout_ms,
            );
            const data = {
              delivery_id: receipt.delivery_id,
              delivery_state: receipt.delivery_state,
              terminal: receipt.terminal,
              submit_verified: receipt.submit_verified,
              agent_id: receipt.agent_id,
              ...(receipt.timed_out ? { timed_out: true } : {}),
            };
            return okFormatted(formatOk("wait_for", data), data);
          }
          const targetState = args.target_state ?? "done";
          if (args.mine && (args.agent_id || args.ids)) {
            throw new Error(
              "wait_for mine=true is mutually exclusive with agent_id and ids",
            );
          }
          let waitIds = args.ids;
          if (args.mine) {
            const caller = resolveCurrentCallerAgent();
            if (!caller) {
              throw new Error(
                "wait_for mine=true requires a managed calling agent identity",
              );
            }
            waitIds = registry
              .getChildren(caller.agent_id)
              .map((agent) => agent.agent_id);
          }
          if (waitIds) {
            if (waitIds.length === 0) {
              return okFormatted(
                formatOk("wait_for", { count: 0, target: targetState }),
                { results: [], mine: args.mine },
              );
            }
            const results = await engine.waitForAll(
              waitIds,
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
                // P11 Contract B: a lead that BLOCKS on its children gets the
                // closure state in the reply it was already waiting for -- the
                // completion signal surfaces where the parent actually looks,
                // with no new carrier (#414: a carrier without a reader is not
                // a carrier).
                const harvest = resultAgent
                  ? engine.assessHarvestability(resultAgent)
                  : null;
                return {
                  ...result,
                  health,
                  ...(harvest
                    ? {
                        closure: harvest.closure,
                        closure_artifact_verified:
                          harvest.closure_artifact_verified,
                        report_path: harvest.report_path,
                        done_marker: harvest.done_marker,
                      }
                    : {}),
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
            throw new Error("wait_for requires agent_id, ids, or delivery_id");
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
          const authorizedBinding = resolveAuthorizedAgentSurfaceBinding(
            state,
            topology,
          );
          const [health, pendingCodexFill] = await Promise.all([
            evaluateServerAgentHealth(
              state,
              {
                ...healthTopologyOverrides(state, topology),
                harvestability,
              },
              topology,
            ),
            readCodexRolloutFill(authorizedBinding ? state : null),
          ]);
          const codexFill = await validateCodexRolloutFill(
            authorizedBinding ? state : null,
            authorizedBinding?.surfaceRef ?? null,
            pendingCodexFill,
          );
          const formatted =
            formatAgentState(state) +
            `\nharvestability: ${
              harvestability.closeable ? "closeable" : "not closeable"
            }` +
            `\nhealth: ${health.status}${
              health.issues.length > 0 ? ` (${health.issues.join("; ")})` : ""
            }` +
            `\ntoken_count: ${codexFill?.token_count ?? "unknown"}` +
            `\ncontext_window: ${codexFill?.context_window ?? "unknown"}` +
            `\ncontext_pct: ${codexFill?.context_pct ?? "unknown"}`;
          const payload = {
            ...toAgentStatePayload(state),
            harvestability,
            health,
            token_count: codexFill?.token_count ?? null,
            context_window: codexFill?.context_window ?? null,
            context_pct: codexFill?.context_pct ?? null,
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
    type ListAgentsCacheEntry = {
      topology_signature: string;
      derived_at: number;
      agents: Array<
        ObservedPublicAgent & {
          surface_id: string;
          send_via: "send_to";
          health?: AgentHealth;
        }
      >;
      skipped_agents: Array<{ agent_id: string; error: string }>;
    };
    const listAgentsCache = new Map<string, ListAgentsCacheEntry>();
    const listAgentsTopologySignature = (
      topology: SurfaceTopologySnapshot | null,
    ): string =>
      JSON.stringify({
        complete: topology?.complete ?? false,
        surfaces: topology
          ? [...topology.workspaceBySurface]
              .map(([surface, workspace]) => ({
                surface,
                workspace,
                uuid: topology.surfaceIdByRef.get(surface) ?? null,
              }))
              .sort((a, b) => a.surface.localeCompare(b.surface))
          : [],
      });

    server.tool(
      "list_agents",
      "List live-derived agents, including registry-persisted prompt blockage and pause state; filter to blocked agents or children with mine/parent_agent_id. Default summary is lean (id, state, surface_id, send_via, paused). Pass detail=full for health diagnostics and the full registry record.",
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
        blocked_on_prompt: z
          .boolean()
          .optional()
          .describe(
            "Return only agents whose registry records show a live prompt blocker",
          ),
        mine: z
          .boolean()
          .optional()
          .default(false)
          .describe("Return direct children of the calling agent"),
        parent_agent_id: z
          .string()
          .optional()
          .describe("Return direct children of this agent"),
        agent_ids: z
          .array(z.string())
          .optional()
          .describe("Return only these agent IDs"),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .default("summary")
          .describe(
            "summary (default): lean addressable rows. full: health diagnostics plus the full registry record.",
          ),
        max_age_ms: z
          .number()
          .int()
          .min(0)
          .max(5_000)
          .optional()
          .describe(
            "Maximum acceptable snapshot age in milliseconds (0-5000); topology changes always invalidate the snapshot",
          ),
      },
      ANNOTATIONS.mutating,
      async (args) => {
        if (args.mine && args.parent_agent_id) {
          return err(
            new Error(
              "list_agents accepts either mine=true or parent_agent_id, not both",
            ),
          );
        }
        const parentAgentId = args.mine
          ? resolveCurrentCallerAgent()?.agent_id
          : args.parent_agent_id;
        if (args.mine && !parentAgentId) {
          return err(
            new Error(
              "list_agents mine=true requires a managed calling agent identity",
            ),
          );
        }
        const filter = {
          repo: args.repo,
          model: args.model,
          blocked_on_prompt: args.blocked_on_prompt,
        };
        const requestedState = args.state;
        const cacheKey = JSON.stringify({
          state: args.state ?? null,
          repo: args.repo ?? null,
          model: args.model ?? null,
          blocked_on_prompt: args.blocked_on_prompt ?? null,
          parent_agent_id: parentAgentId ?? null,
          agent_ids: args.agent_ids ?? null,
          detail: args.detail,
        });
        const renderListAgentsResponse = (entry: ListAgentsCacheEntry) => {
          const data = {
            derived_at: entry.derived_at,
            agents: entry.agents as unknown as Record<string, unknown>[],
            count: entry.agents.length,
            ...(entry.skipped_agents.length > 0
              ? { skipped_agents: entry.skipped_agents }
              : {}),
            ...(args.detail === "full"
              ? {
                  deliveries: engine.listDeliveryReceipts().map((receipt) => ({
                    delivery_id: receipt.delivery_id,
                    agent_id: receipt.agent_id,
                    delivery_state: receipt.delivery_state,
                    terminal: receipt.terminal,
                    created_at: receipt.created_at,
                    resolved_at: receipt.resolved_at,
                  })),
                }
              : {}),
          };
          const formatted = formatListAgents(
            entry.agents,
            entry.agents.length,
            entry.skipped_agents,
          );
          return okFormatted(formatted, data);
        };
        const buildListAgentsResponse = async (
          // `listMerged` hands back MergedAgent rows; the merge-only fields are
          // optional so cached/registry-only callers still type-check.
          records: Array<AgentRecord & { parsed_cli_mismatch?: boolean }>,
          topology: SurfaceTopologySnapshot | null,
          topologySignature: string,
          liveDiscovery?: {
            rows: DiscoveredAgent[];
            observed_at_ms: number;
          },
        ) => {
          const registryObservedAt = Date.now();
          const uuidKey = (value: string | null | undefined) =>
            value?.trim().toLowerCase() || null;
          const rows = await Promise.all(
            records.map(async (agent) => {
              try {
                const agentUuid = uuidKey(agent.surface_uuid);
                const observedSurface = liveDiscovery?.rows.find((surface) => {
                  const surfaceUuid = uuidKey(surface.surface_uuid);
                  return agentUuid && surfaceUuid
                    ? agentUuid === surfaceUuid
                    : Boolean(
                        !agentUuid &&
                        !surfaceUuid &&
                        agent.surface_observer_id &&
                        agent.surface_observer_id ===
                          registry.getObserverId() &&
                        surface.surface_id === agent.surface_id,
                      );
                });
                const trustedScreenObservation =
                  observedSurface && !observedSurface.read_error
                    ? observedSurface
                    : null;
                const health = await evaluateServerAgentHealth(
                  agent,
                  {
                    ...healthTopologyOverrides(agent, topology),
                    ...(trustedScreenObservation
                      ? {
                          screen_status: trustedScreenObservation.parsed_status,
                          screen_agent_type:
                            trustedScreenObservation.cli === "kiro"
                              ? "unknown"
                              : trustedScreenObservation.cli,
                          screen_control_state:
                            trustedScreenObservation.control_state,
                          screen_actions:
                            trustedScreenObservation.actions ?? [],
                        }
                      : {}),
                  },
                  topology,
                );
                const reconciledState = health.reconciled_state ?? agent.state;
                const screenObservation = trustedScreenObservation
                  ? {
                      observed_at_ms: liveDiscovery!.observed_at_ms,
                      status: trustedScreenObservation.parsed_status,
                      agent_type:
                        trustedScreenObservation.cli === "kiro"
                          ? "unknown"
                          : trustedScreenObservation.cli,
                      control_state: trustedScreenObservation.control_state,
                      model: trustedScreenObservation.model,
                    }
                  : health.screen_observation;
                return {
                  agent: {
                    ...toObservedPublicAgent(agent, {
                      derivedAtMs: registryObservedAt,
                      state: reconciledState,
                      stateSource: health.screen_confirmed_state
                        ? "screen"
                        : "registry",
                      screenObservedAtMs: screenObservation?.observed_at_ms,
                      screenModel: screenObservation?.model,
                      ...(trustedScreenObservation?.paused !== undefined
                        ? {
                            paused: trustedScreenObservation.paused,
                            pausedSource:
                              trustedScreenObservation.paused_source ??
                              "inferred",
                          }
                        : agent.paused === true
                          ? {
                              paused: true,
                              pausedSource: agent.paused_source ?? "inferred",
                            }
                          : {}),
                    }),
                    surface_id: agent.surface_id,
                    send_via: "send_to" as const,
                    // #481: computed on every listMerged, read only by the
                    // removed resync tool's dead body -- so a pane whose
                    // observed CLI disagreed with its record was silently
                    // un-surfaced. Sparse on purpose: agreement is the normal
                    // case and must cost no payload.
                    ...(agent.parsed_cli_mismatch === true
                      ? { parsed_cli_mismatch: true }
                      : {}),
                    // P11 Constraint 3: at DEFAULT detail, so a lead can tell a
                    // deadlocked child (done, no artifact -> act) from a busy one
                    // (pending -> wait) WITHOUT a second full-detail call. A bare
                    // boolean made both of those `false`; that was the S3 bug.
                    closure: engine.assessHarvestability(agent).closure,
                    ...(args.detail === "full"
                      ? {
                          health: {
                            ...health,
                            ...(screenObservation
                              ? { screen_observation: screenObservation }
                              : {}),
                          },
                          detail: {
                            ...toAgentStatePayload(agent),
                            harvestability: engine.assessHarvestability(agent),
                          },
                        }
                      : {}),
                  },
                  skipped: null,
                };
              } catch (error) {
                return {
                  agent: null,
                  skipped: {
                    agent_id: agent.agent_id,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                };
              }
            }),
          );
          const enrichedAgents = rows.flatMap((row) =>
            row.agent ? [row.agent] : [],
          );
          const skippedAgents = rows.flatMap((row) =>
            row.skipped ? [row.skipped] : [],
          );
          const agents = requestedState
            ? enrichedAgents.filter(
                (agent) => agent.state.value === requestedState,
              )
            : enrichedAgents;
          const entry: ListAgentsCacheEntry = {
            topology_signature: topologySignature,
            derived_at: Date.now(),
            agents: agents as ListAgentsCacheEntry["agents"],
            skipped_agents: skippedAgents,
          };
          listAgentsCache.set(cacheKey, entry);
          return renderListAgentsResponse(entry);
        };

        try {
          await awaitLifecycleStart();
          const topology = await collectSurfaceTopology();
          const topologySignature = listAgentsTopologySignature(topology);
          const maxAgeMs = args.max_age_ms ?? 0;
          const cached = listAgentsCache.get(cacheKey);
          if (
            maxAgeMs > 0 &&
            cached &&
            cached.topology_signature === topologySignature &&
            Date.now() - cached.derived_at <= maxAgeMs
          ) {
            return renderListAgentsResponse(cached);
          }
          const live = await engine.runLifecycleMutation(async () => {
            discovery.invalidate();
            const discovered = await discovery.scan(true);
            const observedAtMs = Date.now();
            registry.repairFromDiscovery(discovered, {
              seatRegistry,
              orphansOnly: true,
            });
            // #481: `createLiveSeatDiscoveryProof` had exactly one call site --
            // inside the removed resync tool's unreachable body -- so
            // `hasLiveManagedSeatSibling` returned false unconditionally and
            // every crash-recovery-eligible ghost was retained forever. This is
            // the live path that already holds a same-cycle, observer-pinned
            // scan, so the proof belongs here.
            // #480: it is also the only reconciliation callers actually
            // trigger. Without an eviction here `list_agents` was the one
            // reader that never dropped a row: 17 agents against 13 surfaces.
            const liveSeatProof = registry.createLiveSeatDiscoveryProof(
              discovered,
              {
                seatRegistry,
                expectedObserverId: registry.getObserverId(),
                expectedObserverEpoch: registry.getObserverEpoch(),
              },
            );
            await registry.evictSurfaceless({
              confirmationMs: SURFACE_EVICTION_CONFIRMATION_MS,
              now: observedAtMs,
              liveSeatProof,
            });
            const merged = await registry.listMerged(discovery, {
              filter,
              force: true,
              discovered,
            });
            const requestedIds = args.agent_ids
              ? new Set(args.agent_ids)
              : null;
            const scoped = merged.filter(
              (agent) =>
                (!parentAgentId || agent.parent_agent_id === parentAgentId) &&
                (!requestedIds || requestedIds.has(agent.agent_id)),
            );
            return { merged: scoped, discovered, observedAtMs };
          });
          return await buildListAgentsResponse(
            live.merged,
            topology,
            topologySignature,
            {
              rows: live.discovered,
              observed_at_ms: live.observedAtMs,
            },
          );
        } catch (e) {
          if (isSurfaceEnumerationError(e)) {
            try {
              return await buildListAgentsResponse(
                registry.list(filter).filter((agent) => {
                  const requestedIds = args.agent_ids
                    ? new Set(args.agent_ids)
                    : null;
                  return (
                    (!parentAgentId ||
                      agent.parent_agent_id === parentAgentId) &&
                    (!requestedIds || requestedIds.has(agent.agent_id))
                  );
                }),
                null,
                listAgentsTopologySignature(null),
              );
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

      for (const surface of [
        process.env.CMUX_SURFACE_ID,
        process.env.CMUX_TAB_ID,
      ]) {
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
        let livenessTarget: Pick<AgentRecord, "surface_id" | "surface_uuid"> =
          agent;
        try {
          livenessTarget = await engine.resolveAgentIoRoute(agent.agent_id);
        } catch {
          // Preserve the existing registry/PTY liveness semantics when no
          // fresh I/O route can be established.
        }
        if (
          await registry.isSurfaceAlive(livenessTarget, {
            ptyDead:
              surfaceWriteLiveness.observe(
                livenessTarget.surface_id,
                livenessTarget.surface_uuid,
                context.surfaceObserverId,
              )?.pty_dead === true,
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
      agent.seat_id?.trim() || agent.surface_id || agent.agent_id;

    const collectTargetRecords = async (): Promise<AgentRecord[]> => {
      try {
        return await engine.runLifecycleMutation(async () => {
          try {
            discovery.invalidate();
            const discovered = await discovery.scan(true);
            return await registry.listMerged(discovery, {
              force: true,
              discovered,
            });
          } catch (error) {
            if (!(error instanceof SurfaceBindingChangedDuringDiscoveryError)) {
              throw error;
            }
            discovery.invalidate();
            return registry.listMerged(discovery, { force: true });
          }
        });
      } catch (e) {
        if (isSurfaceEnumerationError(e)) {
          throw new Error(
            `Refusing target resolution because live surface enumeration failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        throw e;
      }
    };

    server.tool(
      "broadcast",
      `${PANE_INPUT_BREAKAGE_GUIDANCE} Fan out a short pointer-style message to registered agents by role using the same guarded delivery path as send_to. Defaults to role=leads (orchestrator). Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters. Returns per-agent receipts so one failed target never hides the rest. ${ZSH_BANG_INLINE_WARNING}`,
      {
        text: BroadcastArgsSchema.shape.text.describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Message to broadcast. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters.`,
        ),
        role: BroadcastArgsSchema.shape.role.describe(
          "Target role set: leads means orchestrator; workers means worker; all means every registered agent.",
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
              new Error(
                formatToolValidationError("broadcast", parsedArgs.error),
              ),
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

          const targets = (await collectTargetRecords()).filter(
            (agent) =>
              broadcastRoleMatches(
                args.role,
                inferBroadcastRecordRole(agent),
              ) &&
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
                ...(e instanceof SubmitVerificationError
                  ? {
                      submit_verification_reason: e.reason,
                      retry_safe: e.retry_safe,
                    }
                  : {}),
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
      "Removed. Reconciliation runs automatically on list_agents: fresh discovery, orphan repair, and ghost eviction carrying a same-cycle live-seat proof. Role reflow runs on the periodic sweep. Call list_agents.",
      {},
      ANNOTATIONS.readOnly,
      // AIDEV-NOTE (#481): the original body was kept here behind an early
      // return as an unreachable rollback reference, which made three
      // capabilities look covered while their only producer/consumer sat in
      // dead code. It is deleted; `liveSeatProof` and `parsed_cli_mismatch`
      // now run on the live list_agents path, and orphan surfaces are already
      // visible there as auto-discovered rows.
      async () =>
        err(
          new Error(
            "resync_agents was removed; call list_agents for an automatically refreshed live view",
          ),
        ),
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

    const observePausedTarget = async (
      agent: AgentRecord | null | undefined,
    ): Promise<{ paused: boolean; source: string }> => {
      if (agent?.paused === true) {
        return {
          paused: true,
          source: agent.paused_source ?? "inferred",
        };
      }
      if (!agent?.surface_id) {
        return { paused: false, source: "inferred" };
      }
      const snapshot = await readParsedSurface(
        agent.surface_id,
        agent.workspace_id ?? undefined,
      ).catch(() => null);
      if (snapshot?.parsed.paused === true) {
        engine.markObservedPause(agent.agent_id, true);
        return {
          paused: true,
          source: snapshot.parsed.paused_source,
        };
      }
      if (snapshot?.text && screenShowsPaused(snapshot.text)) {
        engine.markObservedPause(agent.agent_id, true);
        return { paused: true, source: "inferred" };
      }
      return { paused: false, source: "inferred" };
    };

    // 17. send_to
    server.tool(
      "send_to",
      "Send text or a key through the shared delivery engine. Targets may be one agent, structured agent targeting, or a raw surface in surface/command/key mode.",
      {
        ...SendToArgsSchema.shape,
        text: SendToArgsSchema.shape.text.describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default.`,
        ),
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "If true, bypass the lifecycle-state queue so a working agent receives an immediate interjection. Omit it to receive a nonterminal queued receipt that resolves through delivery events. Picker/menu and permission-prompt safety gates still refuse text; use mode=key for deliberate menu driving.",
        ),
        allow_long_inline: SendToArgsSchema.shape.allow_long_inline.describe(
          "Bypass the inline length and multi-paragraph safety guards for a deliberate raw send. Large allowed sends keep the existing chunked delivery behavior.",
        ),
      },
      ANNOTATIONS.mutating,
      async (rawArgs) => {
        let failedReceiptPayload: Record<string, unknown> = {};
        try {
          const parsedArgs = SendToArgsSchema.safeParse(rawArgs);
          if (!parsedArgs.success) {
            return err(
              new Error(formatToolValidationError("send_to", parsedArgs.error)),
            );
          }

          const args = parsedArgs.data;
          const mode = args.mode ?? "agent";
          if (args.targeting && mode !== "agent") {
            throw new Error(
              "send_to.targeting is supported only in mode=agent",
            );
          }
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
                  _cmuxlayer_source_event: "send_to",
                },
                {},
              );
            }
            if (mode === "command") {
              const command = args.command ?? args.text;
              if (command === undefined) {
                throw new Error(
                  "send_to mode=command requires command or text",
                );
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

          if (args.targeting && (args.agent_id || args.target)) {
            throw new Error(
              "send_to accepts either targeting or agent_id/target, not both",
            );
          }
          if (!args.targeting && !args.agent_id && !args.target) {
            throw new Error(
              "send_to mode=agent requires agent_id/target or targeting",
            );
          }
          if (args.text === undefined) {
            throw new Error("send_to mode=agent requires text");
          }
          args.text = sanitizeTerminalInput(args.text);
          assertInlineInputAllowed({
            tool: "send_to",
            arg: "text",
            value: args.text,
            allowLongInline: args.allow_long_inline,
          });
          assertDenseInlineInputAllowed({
            tool: "send_to",
            arg: "text",
            value: args.text,
            allowLongInline: args.allow_long_inline,
          });
          if (args.targeting) {
            await awaitLifecycleStart();
            const allTargets = await collectTargetRecords();
            const excludedIds = new Set(args.targeting.exclude);
            const scopedWorkspace = await canonicalWorkspaceRef(
              args.targeting.workspace,
            );
            type TargetPlan = {
              requested_agent_id?: string;
              agent?: Readonly<AgentRecord>;
              resolution: "resolved" | "filtered_out" | "unknown";
              predicate?: "exclude" | "role" | "workspace";
            };
            const filterPredicate = (
              agent: AgentRecord,
            ): TargetPlan["predicate"] | null => {
              if (excludedIds.has(agent.agent_id)) return "exclude";
              if (
                args.targeting?.role &&
                agent.function !== args.targeting.role
              ) {
                return "role";
              }
              if (
                scopedWorkspace &&
                agent.workspace_id !== scopedWorkspace &&
                agent.workspace_id !== args.targeting?.workspace
              ) {
                return "workspace";
              }
              return null;
            };
            const targetPlan: TargetPlan[] = [];
            if (args.targeting.agent_ids) {
              for (const requestedId of args.targeting.agent_ids) {
                const exact = allTargets.find(
                  (agent) => agent.agent_id === requestedId,
                );
                const candidates = exact
                  ? [exact]
                  : allTargets.filter((agent) =>
                      agent.agent_id.startsWith(requestedId),
                    );
                if (candidates.length > 1) {
                  throw new Error(
                    `Ambiguous agent_id prefix "${requestedId}"; candidates: ${candidates
                      .map((agent) => agent.agent_id)
                      .sort()
                      .join(", ")}. Refusing to guess.`,
                  );
                }
                const agent = candidates[0];
                if (!agent) {
                  targetPlan.push({
                    requested_agent_id: requestedId,
                    resolution: "unknown",
                  });
                  continue;
                }
                const predicate = filterPredicate(agent);
                targetPlan.push({
                  requested_agent_id: requestedId,
                  agent: Object.freeze({ ...agent }),
                  resolution: predicate ? "filtered_out" : "resolved",
                  ...(predicate ? { predicate } : {}),
                });
              }
            } else {
              for (const agent of allTargets) {
                if (filterPredicate(agent)) continue;
                targetPlan.push({
                  agent: Object.freeze({ ...agent }),
                  resolution: "resolved",
                });
              }
            }
            const resolvedTargets = Object.freeze(
              targetPlan
                .filter(
                  (
                    entry,
                  ): entry is TargetPlan & { agent: Readonly<AgentRecord> } =>
                    entry.resolution === "resolved" &&
                    entry.agent !== undefined,
                )
                .map((entry) => entry.agent),
            );
            for (const agent of resolvedTargets) {
              assertInteractiveMultilineInputAllowed({
                tool: "send_to",
                value: args.text,
                cli: agent.cli,
                allowLongInline: args.allow_long_inline,
              });
            }
            const mutableReceipts: Array<Record<string, unknown>> = [];
            for (const plan of targetPlan) {
              if (plan.resolution !== "resolved" || !plan.agent) {
                mutableReceipts.push({
                  ...(plan.requested_agent_id
                    ? { requested_agent_id: plan.requested_agent_id }
                    : {}),
                  ...(plan.agent ? { agent_id: plan.agent.agent_id } : {}),
                  resolution: plan.resolution,
                  ...(plan.predicate ? { predicate: plan.predicate } : {}),
                  ...buildPublicDeliveryReceipt({
                    typed: false,
                    submit_attempted: false,
                    submit_verified: null,
                    retry_count: 0,
                  }),
                  accepted: false,
                  skipped:
                    plan.resolution === "unknown"
                      ? "unknown_agent_id"
                      : `filtered_out:${plan.predicate}`,
                });
                continue;
              }
              const agent = plan.agent;
              const resolutionMetadata = plan.requested_agent_id
                ? {
                    requested_agent_id: plan.requested_agent_id,
                    resolution: "resolved",
                  }
                : {};
              const skipped =
                agent.state === "working"
                  ? null
                  : await broadcastSkipReason(agent);
              if (skipped) {
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    typed: false,
                    submit_attempted: false,
                    submit_verified: null,
                    retry_count: 0,
                  }),
                  accepted: false,
                  skipped,
                });
                continue;
              }
              const duplicate = engine.findOpenDuplicate({
                agent_id: agent.agent_id,
                text: args.text,
                press_enter: args.press_enter,
              });
              if (duplicate) {
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  duplicate_of: duplicate.delivery_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: duplicate.delivery_state,
                    delivery_id: duplicate.delivery_id,
                    typed: false,
                    submit_attempted: false,
                    submit_verified: duplicate.submit_verified,
                    retry_count: duplicate.retry_count,
                  }),
                  accepted: true,
                });
                continue;
              }
              const deliveryId = randomUUID();
              engine.acceptPendingVerify({
                delivery_id: deliveryId,
                agent_id: agent.agent_id,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
                retry_count: 0,
              });
              const livePaused = await observePausedTarget(agent);
              if (livePaused.paused) {
                const queued = engine.queueDelivery({
                  delivery_id: deliveryId,
                  agent_id: agent.agent_id,
                  text: args.text,
                  press_enter: args.press_enter,
                  source_event: "send_to",
                });
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: "queued",
                    delivery_id: queued.delivery_id,
                    typed: false,
                    submit_attempted: false,
                    submit_verified: queued.submit_verified,
                    retry_count: queued.retry_count,
                    WARNING: pausedTargetWarning(livePaused.source),
                  }),
                  accepted: true,
                });
                continue;
              }
              if (!args.allow_busy && agent.state === "working") {
                const queued = engine.queueDelivery({
                  delivery_id: deliveryId,
                  agent_id: agent.agent_id,
                  text: args.text,
                  press_enter: args.press_enter,
                  source_event: "send_to",
                });
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: "queued",
                    delivery_id: queued.delivery_id,
                    typed: false,
                    submit_attempted: false,
                    submit_verified: queued.submit_verified,
                    retry_count: queued.retry_count,
                  }),
                  accepted: true,
                });
                continue;
              }
              try {
                const delivery = await deliverAgentInput({
                  agent_id: agent.agent_id,
                  text: args.text,
                  press_enter: args.press_enter,
                  allow_busy: args.allow_busy,
                  source_event: "send_to",
                  delivery_id: deliveryId,
                });
                const accepted =
                  delivery.delivery === "queued" ||
                  delivery.delivery === "queued_followup"
                    ? engine.acceptComposerQueue({
                        delivery_id: deliveryId,
                        agent_id: agent.agent_id,
                        text: args.text,
                        press_enter: args.press_enter,
                        source_event: "send_to",
                        retry_count: delivery.retry_count,
                        delivery_state: delivery.delivery,
                      })
                    : delivery.delivery === "pending_verify"
                      ? engine.acceptPendingVerify({
                          delivery_id: deliveryId,
                          agent_id: agent.agent_id,
                          text: args.text,
                          press_enter: args.press_enter,
                          source_event: "send_to",
                          retry_count: delivery.retry_count,
                        })
                      : delivery.delivery === "submitted"
                        ? engine.resolveDelivery({
                            delivery_id: deliveryId,
                            agent_id: agent.agent_id,
                            text: args.text,
                            press_enter: args.press_enter,
                            source_event: "send_to",
                            delivery_state: "submitted",
                            terminal: true,
                            retry_count: delivery.retry_count,
                            submit_verified: delivery.submit_verified,
                            error: null,
                          })
                        : null;
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: accepted?.delivery_state,
                    delivery_id: accepted?.delivery_id ?? deliveryId,
                    typed: delivery.typed,
                    submit_attempted: delivery.submit_attempted,
                    submit_verified: delivery.submit_verified,
                    retry_count: delivery.retry_count,
                  }),
                  accepted: true,
                });
              } catch (error) {
                const failed = engine.resolveDelivery(
                  {
                    delivery_id: deliveryId,
                    agent_id: agent.agent_id,
                    text: args.text,
                    press_enter: args.press_enter,
                    source_event: "send_to",
                    delivery_state: "failed",
                    terminal: true,
                    retry_count:
                      error instanceof SubmitVerificationError
                        ? error.retry_count
                        : 0,
                    submit_verified:
                      error instanceof SubmitVerificationError ? false : null,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                  {
                    appendFailureEvent: !(
                      error instanceof SubmitVerificationError
                    ),
                  },
                );
                mutableReceipts.push({
                  ...resolutionMetadata,
                  agent_id: agent.agent_id,
                  ...buildPublicDeliveryReceipt({
                    delivery_state: "failed",
                    delivery_id: failed.delivery_id,
                    typed:
                      error instanceof SubmitVerificationError
                        ? (error.receipt?.typed ?? true)
                        : false,
                    submit_attempted:
                      error instanceof SubmitVerificationError
                        ? (error.receipt?.submit_attempted ?? args.press_enter)
                        : false,
                    submit_verified: failed.submit_verified,
                    retry_count: failed.retry_count,
                  }),
                  accepted: false,
                  error: failed.error,
                });
              }
            }
            const receipts = Object.freeze(
              mutableReceipts.map((receipt) => Object.freeze({ ...receipt })),
            );
            const submittedCount = receipts.filter(
              (receipt) => receipt.delivery_state === "submitted",
            ).length;
            const queuedCount = receipts.filter(
              (receipt) => receipt.delivery_state === "queued",
            ).length;
            const failedCount = receipts.filter(
              (receipt) => receipt.delivery_state === "failed",
            ).length;
            const skippedCount = receipts.filter(
              (receipt) => receipt.skipped !== undefined,
            ).length;
            const data = {
              targeting: Object.freeze({ ...args.targeting }),
              target_count: receipts.length,
              resolved_target_count: resolvedTargets.length,
              submitted_count: submittedCount,
              queued_count: queuedCount,
              delivered_count: submittedCount,
              failed_count: failedCount,
              skipped_count: skippedCount,
              receipts,
            };
            if (resolvedTargets.length === 0) {
              return err(
                new Error(
                  "send_to targeting resolved zero targets; refusing silent no-op",
                ),
                data,
              );
            }
            return okFormatted(
              `send_to targeting: ${submittedCount} submitted, ${queuedCount} queued, ${failedCount} failed, ${skippedCount} skipped`,
              data,
            );
          }

          const agentId = args.agent_id ?? args.target;
          if (!agentId) {
            throw new Error("send_to mode=agent requires agent_id or target");
          }
          const targetAgent =
            engine.getAgentState(agentId) ?? registry.get(agentId);
          assertInteractiveMultilineInputAllowed({
            tool: "send_to",
            value: args.text,
            cli: targetAgent?.cli,
            allowLongInline: args.allow_long_inline,
          });
          const duplicate = engine.findOpenDuplicate({
            agent_id: agentId,
            text: args.text,
            press_enter: args.press_enter,
          });
          if (duplicate) {
            const data = {
              accepted: true,
              agent_id: agentId,
              duplicate_of: duplicate.delivery_id,
              ...buildPublicDeliveryReceipt({
                delivery_state: duplicate.delivery_state,
                delivery_id: duplicate.delivery_id,
                typed: false,
                submit_attempted: false,
                submit_verified: duplicate.submit_verified,
                retry_count: duplicate.retry_count,
              }),
            };
            return okFormatted(
              `send_to duplicate_of ${duplicate.delivery_id}`,
              data,
            );
          }
          const deliveryId = randomUUID();
          engine.acceptPendingVerify({
            delivery_id: deliveryId,
            agent_id: agentId,
            text: args.text,
            press_enter: args.press_enter,
            source_event: "send_to",
            retry_count: 0,
          });
          const livePaused = await observePausedTarget(targetAgent);
          if (livePaused.paused) {
            const receipt = engine.queueDelivery({
              delivery_id: deliveryId,
              agent_id: agentId,
              text: args.text,
              press_enter: args.press_enter,
              source_event: "send_to",
            });
            const data = {
              accepted: true,
              agent_id: agentId,
              ...buildPublicDeliveryReceipt({
                delivery_state: "queued",
                delivery_id: receipt.delivery_id,
                typed: false,
                submit_attempted: false,
                submit_verified: receipt.submit_verified,
                retry_count: receipt.retry_count,
                WARNING: pausedTargetWarning(livePaused.source),
              }),
            };
            return okFormatted(
              `WARNING — send_to queued; paused target ${agentId} cannot act`,
              data,
            );
          }
          if (!args.allow_busy && targetAgent?.state === "working") {
            const receipt = engine.queueDelivery({
              delivery_id: deliveryId,
              agent_id: agentId,
              text: args.text,
              press_enter: args.press_enter,
              source_event: "send_to",
            });
            const data = {
              accepted: true,
              agent_id: agentId,
              ...buildPublicDeliveryReceipt({
                delivery_state: "queued",
                delivery_id: receipt.delivery_id,
                typed: false,
                submit_attempted: false,
                submit_verified: receipt.submit_verified,
                retry_count: receipt.retry_count,
              }),
            };
            return okFormatted(
              `send_to accepted — delivery ${receipt.delivery_id} queued`,
              data,
            );
          }
          let delivery: Awaited<ReturnType<typeof deliverAgentInput>>;
          try {
            delivery = await deliverAgentInput({
              agent_id: agentId,
              text: args.text,
              press_enter: args.press_enter,
              allow_busy: args.allow_busy,
              source_event: "send_to",
              delivery_id: deliveryId,
            });
          } catch (error) {
            // AIDEV-NOTE (F1): a RetryableDeliveryError is, by name and by the
            // drain loop's own handling, NOT a terminal outcome -- the engine
            // backs it off and tries again. Flattening it into a terminal
            // `failed` receipt here contradicted send_to's own published
            // promise ("Omit it to receive a nonterminal queued receipt") and
            // was the fleet's #1 receipt lie: a lead told its live worker was
            // dead. Hand back the queued receipt the drain loop will honour.
            if (error instanceof RetryableDeliveryError) {
              const receipt = engine.queueDelivery({
                delivery_id: deliveryId,
                agent_id: agentId,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
              });
              const data = {
                accepted: true,
                agent_id: agentId,
                ...buildPublicDeliveryReceipt({
                  delivery_state: "queued",
                  delivery_id: receipt.delivery_id,
                  typed: false,
                  submit_attempted: false,
                  submit_verified: receipt.submit_verified,
                  retry_count: receipt.retry_count,
                  WARNING: `Delivery is queued for retry, not delivered yet: ${error.message}`,
                }),
              };
              return okFormatted(
                `send_to accepted — delivery ${receipt.delivery_id} queued for retry`,
                data,
              );
            }
            const failedReceipt = engine.resolveDelivery(
              {
                delivery_id: deliveryId,
                agent_id: agentId,
                text: args.text,
                press_enter: args.press_enter,
                source_event: "send_to",
                delivery_state: "failed",
                terminal: true,
                retry_count:
                  error instanceof SubmitVerificationError
                    ? error.retry_count
                    : 0,
                submit_verified:
                  error instanceof SubmitVerificationError ? false : null,
                error: error instanceof Error ? error.message : String(error),
              },
              {
                // Submission-verification failures already emitted the source
                // event immediately before throwing. Earlier failures did not.
                appendFailureEvent: !(error instanceof SubmitVerificationError),
              },
            );
            failedReceiptPayload = {
              ...buildPublicDeliveryReceipt({
                delivery_state: "failed",
                delivery_id: failedReceipt.delivery_id,
                typed:
                  error instanceof SubmitVerificationError
                    ? (error.receipt?.typed ?? true)
                    : false,
                submit_attempted:
                  error instanceof SubmitVerificationError
                    ? (error.receipt?.submit_attempted ?? args.press_enter)
                    : false,
                submit_verified: failedReceipt.submit_verified,
                retry_count: failedReceipt.retry_count,
              }),
            };
            throw error;
          }
          const receipt =
            delivery.delivery === "queued" ||
            delivery.delivery === "queued_followup"
              ? engine.acceptComposerQueue({
                  delivery_id: deliveryId,
                  agent_id: agentId,
                  text: args.text,
                  press_enter: args.press_enter,
                  source_event: "send_to",
                  retry_count: delivery.retry_count,
                  delivery_state: delivery.delivery,
                })
              : delivery.delivery === "pending_verify"
                ? engine.acceptPendingVerify({
                    delivery_id: deliveryId,
                    agent_id: agentId,
                    text: args.text,
                    press_enter: args.press_enter,
                    source_event: "send_to",
                    retry_count: delivery.retry_count,
                  })
                : delivery.delivery === "submitted"
                  ? engine.resolveDelivery({
                      delivery_id: deliveryId,
                      agent_id: agentId,
                      text: args.text,
                      press_enter: args.press_enter,
                      source_event: "send_to",
                      delivery_state: "submitted",
                      terminal: true,
                      retry_count: delivery.retry_count,
                      submit_verified: delivery.submit_verified,
                      error: null,
                    })
                  : null;
          // Preserve the already-terminal receipt if optional evidence
          // collection fails after the pane mutation has succeeded.
          const publicReceipt = buildPublicDeliveryReceipt({
            delivery_state: receipt?.delivery_state,
            delivery_id: receipt?.delivery_id ?? deliveryId,
            typed: delivery.typed,
            submit_attempted: delivery.submit_attempted,
            submit_verified: delivery.submit_verified,
            retry_count: delivery.retry_count,
          });
          failedReceiptPayload = { ...publicReceipt };
          const evidence = await collectDeliveryEvidence(agentId);
          const data = {
            agent_id: agentId,
            ...publicReceipt,
            ...evidence,
          };
          return okFormatted(formatOk("send_to", data), data);
        } catch (e) {
          if (e instanceof DeliverySafetyGateError) {
            return err(e, {
              ...failedReceiptPayload,
              error_code: e.error_code,
              submit_verified: e.submit_verified,
              screen: e.screen,
            });
          }
          if (e instanceof SubmitVerificationError) {
            return err(e, {
              ...failedReceiptPayload,
              ...submitVerificationFailurePayload(e),
            });
          }
          return err(e, failedReceiptPayload);
        }
      },
    );

    // 18. send_to_agent
    server.tool(
      "send_to_agent",
      `${PANE_INPUT_BREAKAGE_GUIDANCE} Deprecated for client integrations: use send_to instead. Internal/advanced path for sending text input to an agent in ready or idle state. Inline text is capped at ${SEND_INPUT_MAX_INLINE_CHARS} characters by default (CMUXLAYER_MAX_INLINE_CHARS, positive integer >= ${SEND_INPUT_CHUNK_THRESHOLD}). For launcher boot prompts, put the full prompt in a file and pass boot_prompt_path through spawn_agent/send_command instead of routing raw long text through the agent composer. Pass allow_long_inline:true only for deliberate raw sends. Returns the same post-delivery registry/screen health evidence as send_to. ${ZSH_BANG_INLINE_WARNING}`,
      {
        ...SendToArgsSchema.shape,
        text: SendToArgsSchema.shape.text.describe(
          `${PANE_INPUT_BREAKAGE_GUIDANCE} Text to send. Capped at ${SEND_INPUT_MAX_INLINE_CHARS} inline characters by default.`,
        ),
        press_enter: SendToArgsSchema.shape.press_enter.describe(
          "Press enter after sending text",
        ),
        allow_busy: SendToArgsSchema.shape.allow_busy.describe(
          "If true, bypass the interactive-state gate and deliver raw keystrokes regardless of agent state. Queued-but-unsubmitted input returns an error and must not be retried blindly.",
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
          const sendToHandler = toolHandlersByName.get("send_to");
          if (!sendToHandler) {
            throw new Error("Internal tool handler unavailable: send_to");
          }
          const result = await sendToHandler(
            {
              ...args,
              mode: "agent",
              agent_id: agentId,
              target: undefined,
              targeting: undefined,
            },
            {},
          );
          if (!result.isError) return result;

          const preserveLegacyToolLabel = (value: string): string =>
            value.replaceAll("send_to.", "send_to_agent.");
          return {
            ...result,
            content: result.content.map((item) => ({
              ...item,
              text: preserveLegacyToolLabel(item.text),
            })),
            structuredContent: result.structuredContent
              ? {
                  ...result.structuredContent,
                  ...(typeof result.structuredContent.error === "string"
                    ? {
                        error: preserveLegacyToolLabel(
                          result.structuredContent.error,
                        ),
                      }
                    : {}),
                }
              : undefined,
          };
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
      "Replace an existing managed agent's active mission with a file-backed /goal contract. Sends `/goal Read and execute this goal file until complete: <path>` through the guarded agent relay, then applies the supersede registry patch only after verified submission. An unverified submission does not apply that patch but may have mutated the target pane, so it is not safe to retry blindly. Use this to reuse an existing pane instead of spawning a duplicate lane.",
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
            "If true, supersede even while the agent is working. Defaults true because supersession intentionally replaces the active mission. Queued-but-unsubmitted input returns an error and may require manual pane reconciliation before retrying.",
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
          let delivery: Awaited<ReturnType<typeof deliverAgentInput>>;
          try {
            delivery = await deliverAgentInput({
              agent_id: args.agent_id,
              text: `/goal Read and execute this goal file until complete: ${args.goal_file}`,
              press_enter: true,
              allow_busy: args.allow_busy ?? true,
              source_event: "supersede_agent_goal",
            });
          } catch (e) {
            if (e instanceof SubmitVerificationError) {
              return err(e, {
                error_code: "supersede_submit_unverified",
                submit_verified: false,
                retry_count: e.retry_count,
                registry_updated: false,
                goal_delivery_state: "unverified_pane_side_effect",
                retry_safe: false,
                recovery:
                  "Do not retry automatically; inspect the target composer/queue and reconcile the pane before attempting another supersede.",
              });
            }
            throw e;
          }
          if (delivery.submit_verified !== true) {
            const error = new SubmitVerificationError(
              `Supersede submission could not be verified for ${args.agent_id}`,
              delivery.retry_count,
              delivery.delivery === "queued"
                ? "input_still_pending"
                : "submit_evidence_absent",
            );
            return err(error, {
              error_code: "supersede_submit_unverified",
              ...submitVerificationFailurePayload(error),
              registry_updated: false,
              goal_delivery_state: "unverified_pane_side_effect",
              recovery:
                "Do not retry automatically; inspect the target composer/queue and reconcile the pane before attempting another supersede.",
            });
          }
          const canonicalAgentId = current.agent_id;
          const supersedePatch = {
            task_summary: taskSummary,
            goal_file: args.goal_file,
            // AIDEV-NOTE (P11 finding 1): clear the engine-issued pair so the
            // prose fallback resumes for the NEW brief. supersede is the one
            // contract channel that actually reaches the worker -- it delivers
            // `/goal Read and execute this goal file` to the pane -- so the
            // worker will honor the superseding brief's path. If the consumer
            // kept checking the originally issued path it would render
            // artifact_missing forever: the exact S3 disagreement, re-created
            // through the door that used to work. Whatever reached the worker
            // is what the consumer must verify against.
            report_path: null,
            done_marker: null,
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
              const screenDeadline = Date.now() + SCREEN_TIMEOUT;
              let screenData: ParsedScreenResult | null = null;
              let liveSurfaceId: string | null = null;
              let screenFailure: {
                screen_unavailable: true;
                error_code: "screen_unavailable";
                screen_error: string;
              } | null = null;
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
                    const codexFillPromise = readCodexRolloutFill(agent);
                    const screen = await client.readScreen(route.surface_id, {
                      lines: 20,
                      workspace: route.workspace_id ?? undefined,
                    });
                    return { route, screen, codexFillPromise };
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
                const fillWaitMs = Math.max(0, screenDeadline - Date.now());
                const pendingCodexFill =
                  fillWaitMs === 0
                    ? null
                    : await new Promise<CodexRolloutFill | null>((resolve) => {
                        const timeout = setTimeout(
                          () => resolve(null),
                          fillWaitMs,
                        );
                        resolved.codexFillPromise.then(
                          (fill) => {
                            clearTimeout(timeout);
                            resolve(fill);
                          },
                          () => {
                            clearTimeout(timeout);
                            resolve(null);
                          },
                        );
                      });
                const codexFill = await validateCodexRolloutFill(
                  agent,
                  resolved.route.surface_id,
                  pendingCodexFill,
                );
                screenData = applyCodexRolloutFill(
                  applyHarnessState(
                    enrichParsedScreen(
                      parseScreen(screen.text),
                      screen.text,
                      pickLatestSurfaceModel(stateMgr, liveSurfaceId),
                    ),
                    resolveHarnessStateForSurface(
                      stateMgr,
                      liveSurfaceId,
                      agent,
                    ),
                  ),
                  codexFill,
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
                context_window: screenData?.context_window ?? null,
                context_pct: screenData?.context_pct ?? null,
                cost: screenData?.cost ?? null,
                task_summary: summarizeTaskSummary(agent.task_summary),
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
    rawRegisterTool(
      "expand_palette",
      {
        description:
          "Register the remaining Phase 5 tools for this MCP session.",
        inputSchema: {},
        outputSchema: z
          .object({
            ...BaseOutputShape,
            expanded: z.boolean(),
            already_expanded: z.boolean(),
            registered_tools: z.array(z.string()),
          })
          .passthrough(),
        annotations: ANNOTATIONS.idempotentMutating,
      },
      async () =>
        withTransportRetryTracking(async () => {
          const sendToolListChanged = server.sendToolListChanged;
          server.sendToolListChanged = () => {};
          let expansion;
          try {
            expansion = palette.expand((...args) => {
              const toolName = args[0];
              const outputSchema =
                typeof toolName === "string"
                  ? PUBLIC_TOOL_OUTPUT_SCHEMAS[toolName]
                  : undefined;
              return outputSchema
                ? registerLegacyToolWithOutputSchema(args, outputSchema)
                : rawTool(...args);
            });
          } finally {
            server.sendToolListChanged = sendToolListChanged;
          }
          if (expansion.expanded) server.sendToolListChanged();
          return ok({ ...expansion });
        }),
    );
  }

  return server;
}
