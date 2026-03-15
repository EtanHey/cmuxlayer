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

export interface AgentRecord {
  agent_id: string;
  surface_id: string;
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
 * Parses context usage percentage from Claude Code status bar text.
 * Matches patterns like "80% context", "context 80%", "80% context remaining"
 */
export function parseContextPercent(text: string): number | null {
  const m =
    text.match(/(\d{1,3})%\s*context/i) ??
    text.match(/context[^%]*?(\d{1,3})%/i);
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
