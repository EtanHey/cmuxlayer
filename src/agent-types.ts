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
  task_summary: string;
  pid: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  error: string | null;
  // Hierarchy fields (Task 18)
  parent_agent_id: string | null;
  spawn_depth: number;
  deletion_intent: boolean;
  // Quality fields (Task 19)
  quality: AgentQuality;
  max_cost_per_agent: number | null;
  // Crash recovery fields (Task 20)
  crash_recover?: boolean;
  respawn_attempts?: number;
  user_killed?: boolean;
}

export interface PublicAgent {
  agent_id: string;
  repo: string;
  model: string;
  state: AgentState;
  session_id: string | null;
}

export interface AgentRoute {
  agent_id: string;
  surface_id: string;
  state: AgentState;
  session_id: string | null;
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
  return isCrashRecoveryEligible(agent) || isCrashRecoveryExhausted(agent.error);
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

export interface WaitResult {
  matched: boolean;
  state: AgentState;
  elapsed: number;
  source: "immediate" | "poll" | "sweep" | "watch" | "timeout";
  agent: PublicAgent | null;
  error?: string;
}

/**
 * Valid state transitions. Key = current state, value = allowed next states.
 */
export const VALID_TRANSITIONS: Record<AgentState, AgentState[]> = {
  creating: ["booting", "error"],
  booting: ["ready", "error"],
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
export function generateAgentId(model: string, repo: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 6);
  const slug = repo.replace(/[^a-zA-Z0-9-]/g, "-");
  return `${model}-${slug}-${ts}-${rand}`;
}
