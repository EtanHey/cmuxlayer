/**
 * Agent lifecycle types — flat, SQLite-importable schema.
 * Every field is a primitive (string | number | null).
 */

export type AgentState =
  | "creating"
  | "booting"
  | "ready"
  | "working"
  | "idle"
  | "done"
  | "error";

export type CliType = "claude" | "codex" | "gemini" | "kiro" | "cursor";

export type AgentQuality = "unknown" | "verified" | "suspect" | "degraded";
export type AgentRole = "orchestrator" | "ic" | "worker";

export const MAX_SPAWN_DEPTH = 2;
export const MAX_CHILDREN = 10;
export const MAX_RESPAWN_ATTEMPTS = 10;

export interface AgentRecord {
  agent_id: string;
  surface_id: string;
  workspace_id?: string | null;
  state: AgentState;
  repo: string;
  model: string;
  cli: CliType;
  cli_session_id: string | null;
  cli_session_path?: string | null;
  task_summary: string;
  pid: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  error: string | null;
  // Hierarchy fields (Task 18)
  parent_agent_id: string | null;
  spawn_depth: number;
  role?: AgentRole;
  auto_archive_on_done?: boolean;
  task_done_candidate_at?: string | null;
  task_done_detected_at?: string | null;
  deletion_intent: boolean;
  // Quality fields (Task 19)
  quality: AgentQuality;
  max_cost_per_agent: number | null;
  // Crash recovery fields (Task 20)
  crash_recover?: boolean;
  respawn_attempts?: number;
  user_killed?: boolean;
  // Boot prompt delivery guard
  boot_prompt_pending?: boolean;
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
  resume_command?: string;
}

export interface AgentRoute {
  agent_id: string;
  surface_id: string;
  workspace_id?: string | null;
  state: AgentState;
  session_id: string | null;
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
    "state" | "crash_recover" | "user_killed" | "cli_session_id" | "error"
  >,
): boolean {
  return (
    agent.state === "error" &&
    agent.crash_recover === true &&
    agent.user_killed !== true &&
    !!agent.cli_session_id &&
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
  | "spawn_agent"
  | "send_command"
  | "send_to"
  | "send_to_agent"
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

export type EventLogEntry =
  | StateTransition
  | DeliveryTelemetryEvent
  | ControlHealthTelemetryEvent;

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
  const ts = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${golemName}-pending-${ts}-${rand}`;
}
