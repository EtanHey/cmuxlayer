import type { CliType } from "./agent-types.js";

// Env vars for headless/spawned agent sessions:
// - MCP_CONNECTION_NONBLOCKING: skip MCP connection wait (Claude Code 2.1.90+)
// - CLAUDE_CODE_NO_FLICKER: stable alt-screen rendering for terminal parsing
export const AGENT_ENV =
  "MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sanitizeRepoName(repo: string): string {
  const safeRepo = repo.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeRepo || safeRepo !== repo || safeRepo === "." || safeRepo === "..") {
    throw new Error(
      `Invalid repo name: "${repo}". Only alphanumeric, dots, hyphens, and underscores allowed. "." and ".." are not permitted.`,
    );
  }
  return safeRepo;
}

const FULL_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LAUNCHER_SUFFIX: Partial<Record<CliType, string>> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
};

function cleanLauncherName(
  _cli: CliType,
  launcherName: string | null | undefined,
): string | null {
  if (!launcherName) return null;
  const trimmed = launcherName.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(trimmed)) return null;
  return trimmed;
}

export function buildResumeCommand(
  cli: CliType,
  repo: string,
  sessionId: string,
  launcherName?: string | null,
): string {
  if (!FULL_SESSION_UUID_RE.test(sessionId)) {
    throw new Error(
      `Invalid session id: "${sessionId}". A full session UUID is required.`,
    );
  }
  const suffix = LAUNCHER_SUFFIX[cli];
  const launcher =
    cleanLauncherName(cli, launcherName) ??
    (suffix ? `${sanitizeRepoName(repo)}${suffix}` : null);
  switch (cli) {
    case "claude":
      return `${launcher} -s --resume ${sessionId}`;
    case "codex":
      return `${launcher} --dangerously-bypass-approvals-and-sandbox resume ${sessionId}`;
    case "gemini":
      return `${launcher} -s --resume ${sessionId}`;
    case "kiro": {
      const safeRepo = sanitizeRepoName(repo);
      return `cd ~/Gits/${safeRepo} && ${AGENT_ENV} kiro-cli chat --resume-id ${sessionId}`;
    }
    case "cursor":
      return `${launcher} -s --resume ${sessionId}`;
  }
}
