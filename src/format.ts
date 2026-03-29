/**
 * Beautiful terminal output formatting for cmux MCP tool responses.
 *
 * Uses Unicode box-drawing characters for clean, professional display.
 * No ANSI color codes (MCP tool output doesn't support them in Claude Code).
 */

import type { AgentRecord } from "./agent-types.js";
import type { CmuxSurface, ParsedScreenResult } from "./types.js";

function truncate(text: string, maxLen: number = 60): string {
  if (!text) return "";
  text = text.replace(/\n/g, " ").trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

function pad(text: string, width: number): string {
  const s = String(text ?? "");
  if (s.length >= width) return s.slice(0, width - 1) + "\u2026";
  return s.padEnd(width);
}

function alignRight(text: string, width: number): string {
  const s = String(text ?? "");
  if (s.length >= width) return s.slice(0, width - 1) + "\u2026";
  return s.padStart(width);
}

// Context bar: visual fill indicator
function contextBar(pct: number | null): string {
  if (pct === null) return "   \u2500";
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
  return `${bar} ${pct}%`;
}

interface SurfaceEntry {
  ref?: string;
  title?: string;
  type?: string;
  workspace_ref?: string;
  pane_ref?: string;
  screen_preview?: string;
}

export function formatListSurfaces(
  surfaces: SurfaceEntry[],
  workspaces: Array<{ ref: string; title?: string }>,
): string {
  if (!surfaces || surfaces.length === 0) {
    return "\u250c\u2500 cmux surfaces\n\u2502 No surfaces found.\n\u2514\u2500";
  }

  const lines: string[] = [];
  lines.push(
    `\u250c\u2500 cmux surfaces \u2500 ${surfaces.length} surface${surfaces.length !== 1 ? "s" : ""} in ${workspaces.length} workspace${workspaces.length !== 1 ? "s" : ""}`,
  );
  lines.push(
    `\u2502 ${pad("Ref", 14)} ${pad("Type", 10)} ${pad("Title", 30)} ${pad("Workspace", 14)}`,
  );
  lines.push(
    `\u251c${"─".repeat(14)}${"─".repeat(11)}${"─".repeat(31)}${"─".repeat(14)}`,
  );

  for (const s of surfaces) {
    const ref = pad(s.ref ?? "", 14);
    const type = pad(s.type ?? "terminal", 10);
    const title = pad(truncate(s.title ?? "", 28), 30);
    const ws = pad(s.workspace_ref ?? "", 14);
    lines.push(`\u2502 ${ref} ${type} ${title} ${ws}`);
    if (s.screen_preview) {
      const previewLine = truncate(s.screen_preview, 60);
      lines.push(`\u2502   \u2514 ${previewLine}`);
    }
  }

  lines.push("\u2514\u2500");
  return lines.join("\n");
}

export function formatReadScreen(
  surfaceRef: string,
  title: string | null,
  content: string | null,
  parsed: ParsedScreenResult,
  scrollbackUsed: boolean,
  lines: number,
): string {
  const result: string[] = [];

  // Header with surface info
  const titleStr = title ? ` "${truncate(title, 30)}"` : "";
  result.push(`\u250c\u2500 ${surfaceRef}${titleStr}`);

  // Parsed agent status line
  const statusParts: string[] = [];
  if (parsed.agent_type) statusParts.push(`agent: ${parsed.agent_type}`);
  if (parsed.status) statusParts.push(`status: ${parsed.status}`);
  if (parsed.model) statusParts.push(`model: ${truncate(parsed.model, 20)}`);
  if (parsed.context_pct !== null)
    statusParts.push(`ctx: ${contextBar(parsed.context_pct)}`);
  else if (parsed.token_count !== null)
    statusParts.push(`tokens: ${parsed.token_count.toLocaleString()}`);
  if (parsed.cost !== null)
    statusParts.push(`cost: $${parsed.cost.toFixed(2)}`);
  if (parsed.done_signal) statusParts.push("DONE");

  if (statusParts.length > 0) {
    result.push(`\u2502 ${statusParts.join("  \u2502  ")}`);
  }

  if (parsed.errors && parsed.errors.length > 0) {
    result.push(
      `\u2502 errors: ${parsed.errors.map((e) => truncate(e, 40)).join(", ")}`,
    );
  }

  if (parsed.response) {
    result.push(`\u251c\u2500 Response`);
    result.push(`\u2502 ${truncate(parsed.response, 70)}`);
  }

  // Content (if not parsed_only)
  if (content) {
    result.push(
      `\u251c\u2500 Screen (${lines} line${lines !== 1 ? "s" : ""}${scrollbackUsed ? " + scrollback" : ""})`,
    );
    const contentLines = content.split("\n").slice(0, 25);
    for (const line of contentLines) {
      result.push(`\u2502 ${line}`);
    }
    if (content.split("\n").length > 25) {
      result.push(`\u2502 ... (${content.split("\n").length - 25} more lines)`);
    }
  }

  result.push("\u2514\u2500");
  return result.join("\n");
}

export function formatListAgents(agents: AgentRecord[], count: number): string {
  if (count === 0) {
    return "\u250c\u2500 cmux agents\n\u2502 No agents running.\n\u2514\u2500";
  }

  const lines: string[] = [];
  lines.push(
    `\u250c\u2500 cmux agents \u2500 ${count} agent${count !== 1 ? "s" : ""}`,
  );
  lines.push(
    `\u2502 ${pad("ID", 20)} ${pad("Repo", 16)} ${pad("State", 8)} ${pad("Model", 18)} ${pad("Surface", 12)}`,
  );
  lines.push(
    `\u251c${"─".repeat(20)}${"─".repeat(17)}${"─".repeat(9)}${"─".repeat(19)}${"─".repeat(12)}`,
  );

  for (const a of agents) {
    const id = pad(truncate(a.agent_id, 18), 20);
    const repo = pad(truncate(a.repo, 14), 16);
    const state = pad(a.state, 8);
    const model = pad(truncate(a.model, 16), 18);
    const surface = pad(a.surface_id, 12);
    lines.push(`\u2502 ${id} ${repo} ${state} ${model} ${surface}`);
    if (a.error) {
      lines.push(`\u2502   err: ${truncate(a.error, 60)}`);
    }
  }

  lines.push("\u2514\u2500");
  return lines.join("\n");
}

export function formatAgentState(agent: AgentRecord): string {
  const lines: string[] = [];
  lines.push(`\u250c\u2500 Agent: ${agent.agent_id}`);
  lines.push(
    `\u2502 repo: ${agent.repo}  state: ${agent.state}  model: ${agent.model}`,
  );
  lines.push(`\u2502 surface: ${agent.surface_id}  cli: ${agent.cli}`);
  if (agent.cli_session_id) {
    lines.push(`\u2502 session: ${agent.cli_session_id}`);
  }
  if (agent.parent_agent_id) {
    lines.push(`\u2502 parent: ${agent.parent_agent_id}`);
  }
  if (agent.error) {
    lines.push(`\u2502 error: ${truncate(agent.error, 60)}`);
  }
  lines.push(
    `\u2502 created: ${agent.created_at}  depth: ${agent.spawn_depth}`,
  );
  lines.push("\u2514\u2500");
  return lines.join("\n");
}

export function formatOk(
  action: string,
  details: Record<string, unknown>,
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(details)) {
    if (v !== undefined && v !== null && k !== "ok" && k !== "applied") {
      parts.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }
  return `\u2714 ${action}${parts.length > 0 ? " \u2500 " + parts.join("  ") : ""}`;
}
