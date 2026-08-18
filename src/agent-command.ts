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

function cleanLauncherName(
  _cli: CliType,
  launcherName: string | null | undefined,
): string | null {
  if (!launcherName) return null;
  // Legacy records stored decorated titles ("brainlayerCodex [surface:606]").
  // Strip only that bracketed decoration -- anything else unparseable stays
  // unparseable and drops to the raw CLI.
  const trimmed = launcherName.trim().replace(/\s*\[[^\]]*\]$/, "");
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Harnesses whose transcript store is keyed by working directory. Resuming one
 * from the wrong cwd silently starts a NEW session instead of resuming, so a
 * raw resume command for these is only advertised when a cwd is known.
 * `codex` keeps its sessions in a global store, and `kiro` carries its own cd.
 */
const CWD_KEYED_RESUME: ReadonlySet<CliType> = new Set([
  "claude",
  "cursor",
  "gemini",
]);

export function rawResumeNeedsCwd(cli: CliType): boolean {
  return CWD_KEYED_RESUME.has(cli);
}

export interface ResumeCommandOptions {
  /**
   * Directory the resumed harness must run in. Honoured only by the raw-CLI
   * form: repoGolem launchers already cd themselves, and adding a cd would
   * change behaviour for existing registered installs.
   *
   * AIDEV-NOTE: this is not cosmetic for Claude Code — its transcripts are
   * keyed by cwd (~/.claude/projects/<slugified-cwd>), so `claude --resume`
   * from the wrong directory cannot find the session.
   */
  cwd?: string | null;
}

/**
 * Resume command for an agent. Prefers the repoGolem launcher recorded at
 * spawn; falls back to the raw CLI when no launcher was recorded.
 *
 * AIDEV-NOTE (issue #392): the old fallback guessed `${repo}${Suffix}` — a
 * binary that does not exist on a machine without repoGolem, so fresh
 * installs (and crash recovery, which reuses this) got an uncallable command.
 * Absence of a launcher now means "raw CLI", never "guess a launcher".
 */
export function buildResumeCommand(
  cli: CliType,
  repo: string,
  sessionId: string,
  launcherName?: string | null,
  opts?: ResumeCommandOptions,
): string {
  if (!FULL_SESSION_UUID_RE.test(sessionId)) {
    throw new Error(
      `Invalid session id: "${sessionId}". A full session UUID is required.`,
    );
  }
  const launcher = cleanLauncherName(cli, launcherName);
  if (!launcher) return buildRawResumeCommand(cli, repo, sessionId, opts);
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

/**
 * Resume a captured harness session without routing through a repoGolem
 * launcher. The surviving terminal is already at a shell prompt, and launcher
 * resume wrappers are not concurrency-safe for this engine-owned recovery
 * path.
 */
export function buildRawResumeCommand(
  cli: CliType,
  repo: string,
  sessionId: string,
  opts?: ResumeCommandOptions,
): string {
  if (!FULL_SESSION_UUID_RE.test(sessionId)) {
    throw new Error(
      `Invalid session id: "${sessionId}". A full session UUID is required.`,
    );
  }
  const cwd = opts?.cwd?.trim();
  const cd = cwd ? `cd ${shellQuote(cwd)} && ` : "";
  switch (cli) {
    case "claude":
      return `${cd}${AGENT_ENV} claude --resume ${sessionId}`;
    case "codex":
      return `${cd}codex resume ${sessionId}`;
    // `cursor agent` exposes `--resume [chatId]`; it has no `--session` flag
    // (`error: unknown option '--session'`). Verified against `cursor agent --help`.
    case "cursor":
      return `${cd}cursor agent --resume ${sessionId}`;
    case "gemini":
      return `${cd}${AGENT_ENV} gemini --resume ${sessionId}`;
    case "kiro": {
      const safeRepo = sanitizeRepoName(repo);
      const kiroCd = cd || `cd ~/Gits/${safeRepo} && `;
      return `${kiroCd}${AGENT_ENV} kiro-cli chat --resume-id ${sessionId}`;
    }
  }
}
