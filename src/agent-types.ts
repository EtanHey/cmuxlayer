/**
 * Agent lifecycle types — flat, SQLite-importable schema.
 * Every field is a primitive (string | number | null).
 */
import { randomUUID } from "node:crypto";
import type {
  ParsedControlPlaneState,
  PauseCoverage,
  PauseSource,
} from "./types.js";

export type AgentState =
  "creating" | "booting" | "ready" | "working" | "idle" | "done" | "error";

export type CliType = "claude" | "codex" | "gemini" | "kiro" | "cursor";

export type AgentQuality = "unknown" | "verified" | "suspect" | "degraded";
export type AgentRole = "orchestrator" | "worker";
export type AgentAuthority = "lead" | "worker";
export type AgentFunction = "implementor" | "reviewer" | "gatherer";
export type AgentPlacement = "left" | "right";
export type SurfaceProvenance = "cmuxlayer_spawn" | "unknown";
export type SeatIdentityStatus = "ok" | "mismatch" | "unknown";
// `disk` is a filesystem observation (today: the harness session artifact
// behind `resumable`, #482), as opposed to a remembered registry field.
export type ObservationSource = "screen" | "registry" | "process" | "disk";
export type AgentReviveOutcome =
  "pending" | "failed" | "revived" | "unrecoverable";
export type AgentHaltType =
  "awaiting_input" | "idle_without_done" | "wedged" | "paused";

export interface Observed<T> {
  value: T;
  source: ObservationSource;
  observed_at_ms: number;
}

export const MAX_SPAWN_DEPTH = 2;
export const MAX_CHILDREN = 10;
export const MAX_RESPAWN_ATTEMPTS = 10;

export interface AgentRecord {
  agent_id: string;
  surface_id: string;
  /** Stable cmux surface UUID paired with the mutable `surface_id` ref. */
  surface_uuid?: string | null;
  /** cmux app/socket instance that is authoritative for surface absence. */
  surface_observer_id?: string | null;
  /** Durable authority for automated role-placement mutations. */
  surface_provenance?: SurfaceProvenance;
  workspace_id?: string | null;
  state: AgentState;
  repo: string;
  model: string;
  /** Requested Codex reasoning effort; null/absent for other harnesses. */
  effort?: string | null;
  cli: CliType;
  cli_session_id: string | null;
  cli_session_path?: string | null;
  launcher_name?: string | null;
  /**
   * Which door launched this agent: the repoGolem launcher, or the raw CLI
   * because no launcher registration answered (#392). Recorded rather than
   * inferred from `launcher_name === null`, so a raw launch past a PRESENT
   * registry is legible after the fact.
   */
  launch_mode?: "launcher" | "raw" | null;
  /**
   * Whether `model` was actually pinned at launch, and by what (#433 family):
   * "launcher" (repoGolem carries it), "cli_flag" (an explicit --model the raw
   * binary understands), or "cli_default" (UNPINNED -- the CLI chose).
   */
  model_pin?: "launcher" | "cli_flag" | "cli_default" | null;
  /** Deliberately pinned tab title used by the resume-integrity manifest. */
  tab_name?: string | null;
  seat_id?: string | null;
  seat_lane?: string | null;
  seat_role?: string | null;
  seat_identity_status?: SeatIdentityStatus;
  seat_identity_error?: string | null;
  /**
   * Short label for role inference, sidebar, and registry echoes.
   * Never store the full boot brief here — that lives in `boot_prompt_text`.
   */
  task_summary: string;
  /**
   * Full boot-prompt payload typed/verified on spawn. Delivery and session
   * matching read this; legacy records may still have the full text only in
   * `task_summary` until rewritten.
   */
  boot_prompt_text?: string | null;
  pid: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  error: string | null;
  // Hierarchy fields (Task 18)
  parent_agent_id: string | null;
  spawn_depth: number;
  role?: AgentRole;
  /** SpawnSpec v1 axes. `role` remains a persisted compatibility field. */
  authority?: AgentAuthority;
  function?: AgentFunction;
  placement?: AgentPlacement;
  auto_archive_on_done?: boolean;
  task_done_candidate_at?: string | null;
  task_done_detected_at?: string | null;
  /** First-connect skipped transcript identity resolution; retry on bounded sweeps. */
  transcript_session_capture_deferred?: boolean;
  /** Failed deferred transcript resolver calls, persisted across restarts. */
  transcript_session_capture_attempts?: number;
  deletion_intent: boolean;
  // Quality fields (Task 19)
  quality: AgentQuality;
  max_cost_per_agent: number | null;
  // Crash recovery fields (Task 20)
  crash_recover?: boolean;
  respawn_attempts?: number;
  user_killed?: boolean;
  /** Engine-owned same-surface CLI recovery; managed spawns default true. */
  auto_revive?: boolean;
  revive_attempts?: number;
  revive_last_attempt_at?: string | null;
  revive_next_attempt_at?: string | null;
  revive_completed_at?: string | null;
  revive_last_outcome?: AgentReviveOutcome | null;
  revive_last_error?: string | null;
  revive_observation_source?: ObservationSource | null;
  revive_observed_at_ms?: number | null;
  revive_previous_state?: AgentState | null;
  revive_consecutive_observations?: number;
  revive_notification_sent_at?: string | null;
  /** Set false for deliberate debugging lanes that must not notify ancestors. */
  halt_escalation?: boolean;
  /** Durable identity and delivery state for one continuous live-halt episode. */
  halt_episode_type?: AgentHaltType | null;
  halt_episode_started_at?: string | null;
  halt_episode_observations?: number;
  halt_notification_sent_at?: string | null;
  halt_notified_ancestor_id?: string | null;
  /** Screen-authoritative prompt blocker, persisted independently of inbox delivery. */
  blocked_on_prompt?: boolean;
  blocked_on_prompt_since?: string | null;
  /** Screen-inferred or cmux-reported pause; panes that cannot act. */
  paused?: boolean;
  paused_source?: PauseSource | null;
  paused_since?: string | null;
  /** Number of mature halt attempts whose hierarchy had no healthy ancestor. */
  halt_missing_ancestor_count?: number;
  /** Best-effort sink selected after hierarchy delivery was unavailable. */
  halt_fallback_sink_id?: string | null;
  /** Failed dispatch attempts; notification remains retryable while nonzero. */
  halt_delivery_failure_count?: number;
  halt_last_delivery_error?: string | null;
  halt_last_observable_action?: string | null;
  halt_last_active_at?: string | null;
  halt_last_progress_at_ms?: number | null;
  halt_last_progress_signature?: string | null;
  // Boot prompt delivery guard
  boot_prompt_pending?: boolean;
  // Spawn settlement evidence (PR #326): a managed agent must not report
  // ready without retaining what was actually observed about prompt delivery
  // and the model shown by the CLI.
  submit_verified?: boolean | null;
  prompt_delivered?: boolean;
  parsed_model?: string | null;
  model_mismatch?: boolean | null;
  /** Codex effort observed in the live status line. */
  parsed_effort?: string | null;
  effort_mismatch?: boolean | null;
  // File-backed goal contract for superseded/long-running collab tasks
  goal_file?: string | null;
  // AIDEV-NOTE (P11/U10): engine-ISSUED coordination contract. Authored once at
  // spawn, returned in the receipt, and told to the worker -- so the DONE
  // signal's producer and consumer read the same string instead of each
  // re-deriving one from the lead's prose. Null on legacy/superseded records,
  // which fall back to the goal_file prose heuristic.
  report_path?: string | null;
  done_marker?: string | null;
  // Launch context for worktree/profile-aware spawns
  launch_cwd?: string | null;
  mcp_profile?: string | null;
  worktree_path?: string | null;
  worktree_branch?: string | null;
}

export interface MergedAgent extends AgentRecord {
  discovered: boolean;
  parsed_cli_mismatch: boolean;
}

export interface PublicAgent {
  agent_id: string;
  repo: string;
  model: string;
  state: AgentState;
  session_id: string | null;
  resumable: boolean;
  resume_command?: string;
  submit_verified?: boolean | null;
  model_mismatch?: boolean | null;
}

/** Provenance-labelled projection used by live-derived list_agents output. */
export interface ObservedPublicAgent {
  agent_id: string;
  repo: string;
  surface_provenance: SurfaceProvenance;
  model: Observed<string | null>;
  state: Observed<AgentState | null>;
  session_id: Observed<string | null>;
  resumable: Observed<boolean>;
  resume_command?: string;
  submit_verified: Observed<boolean | null>;
  model_mismatch: Observed<boolean | null>;
  blocked_on_prompt: Observed<boolean>;
  paused: {
    value: boolean;
    source: PauseSource;
    observed_at_ms: number;
    coverage?: PauseCoverage;
    note?: string;
  };
}

export interface AgentRoute {
  agent_id: string;
  surface_id: string;
  /** Stable surface identity used to refresh the mutable ref before I/O. */
  surface_uuid?: string | null;
  workspace_id?: string | null;
  state: AgentState;
  session_id: string | null;
  resumable: boolean;
  resume_command?: string;
}

export function hasRecoverableCrashError(error: string | null): boolean {
  if (!error) return false;
  return (
    error.includes("disappeared") || error.startsWith("Crash recovery failed:")
  );
}

export function isCrashRecoveryExhausted(error: string | null): boolean {
  return error?.startsWith("Max crash recoveries exceeded:") ?? false;
}

export function isCrashRecoveryEligible(
  agent: Pick<
    AgentRecord,
    | "state"
    | "crash_recover"
    | "user_killed"
    | "cli_session_id"
    | "error"
    | "revive_last_outcome"
  >,
): boolean {
  return (
    agent.state === "error" &&
    agent.crash_recover === true &&
    agent.user_killed !== true &&
    !!agent.cli_session_id &&
    !["pending", "failed", "unrecoverable"].includes(
      agent.revive_last_outcome ?? "",
    ) &&
    hasRecoverableCrashError(agent.error)
  );
}

export function shouldRetainCrashRecoveryError(
  agent: Pick<
    AgentRecord,
    "state" | "crash_recover" | "user_killed" | "cli_session_id" | "error"
  >,
): boolean {
  return (
    isCrashRecoveryEligible(agent) || isCrashRecoveryExhausted(agent.error)
  );
}

export interface StateTransition {
  ts: string;
  agent_id: string;
  event: "created" | "transition" | "error" | "removed";
  from_state: AgentState | null;
  to_state: AgentState;
  surface_id: string | null;
  source: string | null;
  error: string | null;
}

export type DeliveryEventType =
  | "boot_prompt"
  | "spawn_agent"
  | "send_input"
  | "send_command"
  | "send_key"
  | "send_to"
  | "send_to_agent"
  | "supersede_agent_goal"
  | "interact"
  | "press_enter"
  | "dispatch_nudge";

export interface DeliveryTelemetryEvent {
  ts: string;
  event_type: DeliveryEventType;
  source_agent: string | null;
  target_surface: string;
  bytes: number;
  press_enter: boolean | null;
  submit_verified: boolean | null;
  retry_count: number;
  /** Stable receipt identity for agent-routed delivery state transitions. */
  delivery_id?: string;
  /** Nonterminal acceptance or terminal resolution. */
  delivery_state?:
    | "submitted"
    | "queued"
    | "queued_followup"
    | "failed"
    | "pending_verify"
    | "failed_confirmed";
  target_agent?: string;
}

export interface ControlHealthTelemetryEvent {
  ts: string;
  event_type: "control_health";
  selected_socket_path: string | null;
  production_socket_path: string | null;
  nightly_socket_path: string | null;
  cmux_binary: string | null;
  warnings: string[];
  snapshot: unknown;
}

export interface AgentCliExitEvent {
  ts: string;
  event_type: "agent_cli_exit";
  agent_id: string;
  surface_id: string;
  parent_agent_id: string | null;
  previous_state: AgentState;
  control_state: "shell";
  consecutive_observations: number;
  inbox_dispatched: boolean;
  error: string;
  auto_revive?: boolean;
  revive_attempts?: number;
  revive_outcome?: AgentReviveOutcome | null;
  verified_model?: string | null;
  manual_resume_command?: string | null;
}

export interface AgentHaltEscalationEvent {
  ts: string;
  event_type: "agent_halt_escalation";
  agent_id: string;
  surface_id: string;
  parent_agent_id: string | null;
  halt_type: AgentHaltType;
  outcome:
    | "ancestor_dispatched"
    | "fallback_dispatched"
    | "undeliverable"
    | "dispatch_failed";
  sink_agent_id: string | null;
  missing_ancestor_count: number;
  delivery_failure_count: number;
  error: string | null;
}

export interface ResolvedPromptEvent {
  ts: string;
  event_type: "resolved_prompt";
  agent_id: string;
  surface_id: string;
  workspace_id: string | null;
  prompt_type: "model_menu" | "codex_update_menu";
  key_sent: "escape";
  outcome: "recovered" | "failed";
  before_control_state: ParsedControlPlaneState;
  after_control_state: ParsedControlPlaneState | null;
  screen_signature: string;
  screen_excerpt: string;
  error: string | null;
}

/** Which close/kill path emitted the event. */
export type CloseEventPath =
  "close_surface" | "stop_agent" | "kill" | "internal";

/**
 * Durable, attributed record of a surface close or agent kill/stop. Answers
 * "who tore this down, forcibly or not, and was the attempt refused?" from the
 * SAME events.jsonl the other telemetry entries land in, so a pane-death
 * investigation reads one log instead of reconstructing intent from transcripts.
 */
export interface CloseTelemetryEvent {
  ts: string;
  event_type: "close";
  /** Which handler/teardown path initiated the close. */
  event: CloseEventPath;
  /** Surface ref and/or agent_id being closed/killed. */
  target: string;
  /**
   * Best available identity of the caller: an env-derived id
   * (`CMUX_TAB_ID=...`), the `mcp:<toolName>` fallback for a tool-driven call
   * with no resolvable id, or `internal:<reason>` for a teardown path.
   */
  caller: string;
  /** The force flag on the originating call (kill/stop/close force). */
  force: boolean;
  /** Short reason / opts summary if available. */
  reason: string | null;
  /** True when a protected live-agent close was refused (attempt still logged). */
  refused: boolean;
}

/**
 * Client/attach context around an app-level close, derived by correlating the
 * cmux `surface.closed` event with nearby `window.keyed`/`window.unkeyed` events
 * and boot_id changes. This is the rc/screen-share-reconnect signal: the
 * operator drives this Mac over remote-control + Screens5 screen-sharing, so an
 * attach/detach or reconnect cycles window key-focus (and can restart cmux,
 * changing boot_id) right around the moment tabs die.
 */
export interface CloseForensicsClientContext {
  /** A window.keyed/unkeyed event occurred within delta-t of the close. */
  window_key_cycle_near_close: boolean;
  /** The nearest window key-focus event within delta-t: "keyed"/"unkeyed"/none. */
  last_window_key_event: "keyed" | "unkeyed" | null;
  /** The close's boot_id differs from the previous close's boot_id (cmux restart). */
  boot_id_changed_since_prev: boolean;
}

/**
 * Forensics record that ATTRIBUTES a cmux app-level `surface.closed`
 * (origin `tab_close`/`workspace_teardown`) -- events cmux emits to its OWN
 * stream (`~/.cmuxterm/events.jsonl`) with NO actor. cmuxlayer's
 * `CloseTelemetryEvent` only sees MCP-tool-driven closes, so app-level tab
 * deaths were invisible/unattributed; this pairs each app-level close with the
 * MCP close (if any) for the mapped surface within delta-t, and captures the
 * client/attach context that reveals rc/screen-share churn as the culprit.
 */
export interface CloseForensicsEvent {
  /** When forensics ingested this record (injected clock). */
  ts: string;
  event_type: "close_forensics";
  /** cmux internal surface UUID from the surface.closed event. */
  cmux_surface_id: string | null;
  /** cmux internal pane UUID. */
  cmux_pane_id: string | null;
  /** cmux window id (UUID or numeric), often null for a bare tab_close. */
  window_id: string | number | null;
  /** cmux app boot session UUID; a change signals a cmux restart/reconnect. */
  boot_id: string | null;
  /** cmux workspace UUID. */
  workspace_id: string | null;
  /** payload.origin: "tab_close" | "workspace_teardown" | other. */
  origin: string;
  /** The cmux event's own occurred_at (ISO) -- when the surface actually closed. */
  occurred_at: string;
  /**
   * Attribution verdict:
   *  - `mcp:<tool> caller=<x>` when a cmuxlayer MCP close for the mapped surface
   *    landed within delta-t of this app-level close (cmuxlayer DID tear it down).
   *  - `app-level:no-mcp-close` when no MCP close matches -- the smoking gun that
   *    something OUTSIDE cmuxlayer (the app, or an rc/attach cycle) killed it.
   */
  attribution: string;
  /** rc/screen-share-reconnect signal (see CloseForensicsClientContext). */
  client_context: CloseForensicsClientContext;
}

export type EventLogEntry =
  | StateTransition
  | DeliveryTelemetryEvent
  | ControlHealthTelemetryEvent
  | AgentCliExitEvent
  | AgentHaltEscalationEvent
  | ResolvedPromptEvent
  | CloseTelemetryEvent
  | CloseForensicsEvent;

export interface WaitResult {
  matched: boolean;
  state: AgentState;
  elapsed: number;
  source:
    | "immediate"
    | "poll"
    | "sweep"
    | "watch"
    | "evidence"
    | "transcript"
    | "screen"
    | "timeout";
  agent: PublicAgent | null;
  error?: string;
}

/**
 * Valid state transitions. Key = current state, value = allowed next states.
 */
export const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  creating: ["booting", "error"],
  booting: ["ready", "done", "error"],
  ready: ["working", "done", "error"],
  working: ["idle", "done", "error"],
  idle: ["working", "done", "error"],
  done: [],
  error: ["creating"],
};

/**
 * Validate a state transition. Returns true if valid, false otherwise.
 */
export function isValidTransition(from: AgentState, to: AgentState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Assert a state transition is valid. Throws on invalid.
 */
export function assertValidTransition(from: AgentState, to: AgentState): void {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid state transition: ${from} → ${to}. Allowed from ${from}: [${VALID_TRANSITIONS[from].join(", ")}]`,
    );
  }
}

/**
 * @deprecated Use parseScreen().context_pct instead — it computes context usage from
 * token_count/model_max and works for all agent types, not just Claude text patterns.
 * Parses context usage percentage from Claude Code status bar text.
 * Matches patterns like "80% context", "context 80%", "80% context remaining"
 */
export function parseContextPercent(text: string): number | null {
  const m =
    text.match(/\b(\d{1,3})%\s*context/i) ??
    text.match(/context[^%]*?\b(\d{1,3})%/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return isNaN(n) || n < 0 || n > 100 ? null : n;
}

/**
 * Generate a unique agent ID from components.
 */
export const SESSION_ID_PREFIX_LENGTH = 8;

const CLI_GOLEM_SUFFIX: Record<CliType, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  kiro: "Kiro",
  cursor: "Cursor",
};

function sanitizeAgentIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
}

export function golemNameForAgent(cli: CliType, repo: string): string {
  const safeRepo = sanitizeAgentIdPart(repo).replace(/^-+|-+$/g, "");
  return `${safeRepo || "agent"}${CLI_GOLEM_SUFFIX[cli]}`;
}

export function sessionIdPrefix(sessionId: string): string {
  return sanitizeAgentIdPart(sessionId.trim().toLowerCase()).slice(
    0,
    SESSION_ID_PREFIX_LENGTH,
  );
}

export function generateAgentId(
  cli: CliType,
  repo: string,
  sessionId?: string | null,
): string {
  const golemName = golemNameForAgent(cli, repo);
  if (sessionId) {
    return `${golemName}-${sessionIdPrefix(sessionId)}`;
  }
  return `${golemName}-${randomUUID().slice(0, SESSION_ID_PREFIX_LENGTH)}`;
}

const TASK_SUMMARY_MAX_CHARS = 80;

/**
 * Build the short registry label for an agent. Prefer a boot-prompt filename
 * when spawn used `boot_prompt_path`; otherwise the first non-empty line,
 * capped. Never used as a response `title` — that is the live surface title.
 */
export function summarizeTaskSummary(
  prompt: string,
  bootPromptPath?: string | null,
): string {
  const pathLabel = bootPromptPath?.trim();
  if (pathLabel) {
    const base = pathLabel.split(/[\\/]/).pop()?.trim();
    if (base) return base;
  }
  const firstLine =
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  if (firstLine.length <= TASK_SUMMARY_MAX_CHARS) return firstLine;
  return `${firstLine.slice(0, TASK_SUMMARY_MAX_CHARS - 1)}…`;
}

/** Full boot-prompt text for delivery/verification; falls back for legacy rows. */
export function resolveBootPromptText(
  agent: Pick<AgentRecord, "boot_prompt_text" | "task_summary">,
): string {
  const dedicated = agent.boot_prompt_text?.trim();
  if (dedicated) return dedicated;
  return agent.task_summary?.trim() ?? "";
}

/** Persist both fields when a boot prompt (or replacement mission) is known. */
export function bootPromptRegistryFields(
  promptText: string,
  bootPromptPath?: string | null,
): Pick<AgentRecord, "task_summary" | "boot_prompt_text"> {
  return {
    boot_prompt_text: promptText,
    task_summary: summarizeTaskSummary(promptText, bootPromptPath),
  };
}
