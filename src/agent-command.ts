import type { CliType } from "./agent-types.js";

// Env vars for headless/spawned agent sessions:
// - MCP_CONNECTION_NONBLOCKING: skip MCP connection wait (Claude Code 2.1.90+)
// - CLAUDE_CODE_NO_FLICKER: stable alt-screen rendering for terminal parsing
export const AGENT_ENV =
  "MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1";

export function sanitizeRepoName(repo: string): string {
  const safeRepo = repo.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeRepo || safeRepo !== repo || safeRepo === "." || safeRepo === "..") {
    throw new Error(
      `Invalid repo name: "${repo}". Only alphanumeric, dots, hyphens, and underscores allowed. "." and ".." are not permitted.`,
    );
  }
  return safeRepo;
}

export function buildResumeCommand(
  cli: CliType,
  repo: string,
  sessionId: string,
): string {
  const safeRepo = sanitizeRepoName(repo);
  switch (cli) {
    case "claude":
      return `${safeRepo}Claude -s --resume ${sessionId}`;
    case "codex":
      return `${safeRepo}Codex --dangerously-bypass-approvals-and-sandbox resume ${sessionId}`;
    case "gemini":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} gemini --resume ${sessionId}`;
    case "kiro":
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} kiro-cli chat --resume-id ${sessionId}`;
    case "cursor":
      return `${safeRepo}Cursor -s --resume ${sessionId}`;
  }
}
