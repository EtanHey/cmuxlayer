import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliType } from "./agent-types.js";
import { findHarnessSessionPath, type Harness } from "./harness-session.js";

/**
 * AIDEV-NOTE (#482): `resumable` used to mean "we can format a string".
 * `buildResumeCommand` validates only that the captured id looks like a UUID,
 * so a lead that survived a restart kept a stale `cli_session_id` and was
 * advertised as recoverable while its session existed nowhere on disk (2 of 13
 * rows, both LEAD seats, measured 2026-08-19). This module is the observation
 * that claim was missing.
 *
 * Three answers, never two: `missing` requires having LOOKED in a store that
 * exists. When the harness keeps no addressable session store, or this machine
 * has none, the answer is `unverifiable` — the claim stays unverified rather
 * than being flipped to a confident false.
 */
export type ResumeArtifactStatus = "present" | "missing" | "unverifiable";

export type ResumeArtifactResolver = (
  cli: CliType,
  sessionId: string,
) => ResumeArtifactStatus;

export interface ResumeArtifactOptions {
  /** Home directory holding the harness stores. Defaults to `os.homedir()`. */
  home?: string;
  /** Codex root override, mirroring `findHarnessSessionPath`. */
  codexHome?: string;
}

/** Harnesses whose session store cmuxlayer can address by session id. */
function harnessForCli(cli: CliType): Harness | null {
  switch (cli) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    // gemini has no UUID-addressable store; kiro's is not readable here.
    default:
      return null;
  }
}

/**
 * Same override contract the session-capture paths already use
 * (`agent-engine.ts`, `server.ts`): `CMUXLAYER_HARNESS_HOME` relocates the
 * whole harness home, `CODEX_HOME` relocates codex's.
 */
function resolveOptionsFromEnv(
  opts: ResumeArtifactOptions,
): ResumeArtifactOptions {
  return {
    ...(process.env.CMUXLAYER_HARNESS_HOME
      ? { home: process.env.CMUXLAYER_HARNESS_HOME }
      : {}),
    ...(process.env.CODEX_HOME ? { codexHome: process.env.CODEX_HOME } : {}),
    ...opts,
  };
}

function storeRoot(harness: Harness, opts: ResumeArtifactOptions): string {
  const home = opts.home ?? homedir();
  switch (harness) {
    case "claude":
      return join(home, ".claude", "projects");
    case "cursor":
      return join(home, ".cursor", "projects");
    case "codex":
      return join(opts.codexHome ?? join(home, ".codex"), "sessions");
  }
}

/** The real filesystem observation. Cheap: a bounded walk of one store root. */
export function resolveResumeArtifact(
  cli: CliType,
  sessionId: string,
  callerOpts: ResumeArtifactOptions = {},
): ResumeArtifactStatus {
  if (!sessionId) return "unverifiable";
  const harness = harnessForCli(cli);
  if (!harness) return "unverifiable";
  const opts = resolveOptionsFromEnv(callerOpts);
  const root = storeRoot(harness, opts);
  // No store on this machine (fresh install, relocated home, sandboxed test):
  // that proves nothing about the session.
  if (!existsSync(root)) return "unverifiable";
  return findHarnessSessionPath(harness, sessionId, opts)
    ? "present"
    : "missing";
}

const PRESENT_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 5_000;
const statusCache = new Map<
  string,
  { status: ResumeArtifactStatus; expiresAt: number }
>();

/**
 * Default resolver: the filesystem check, memoised. `list_agents` asks once
 * per row, so an uncached miss would re-walk the store for every row on every
 * call. A `present` answer is stable enough to hold for a minute; a `missing`
 * one expires fast because a resume creates the file.
 */
function cachedResolver(cli: CliType, sessionId: string): ResumeArtifactStatus {
  const key = `${cli}:${sessionId}`;
  const now = Date.now();
  const cached = statusCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.status;
  }
  const status = resolveResumeArtifact(cli, sessionId);
  statusCache.set(key, {
    status,
    expiresAt: now + (status === "present" ? PRESENT_TTL_MS : NEGATIVE_TTL_MS),
  });
  return status;
}

let resolver: ResumeArtifactResolver = cachedResolver;

/** Test and embedding seam; production uses the cached filesystem resolver. */
export function setResumeArtifactResolver(next: ResumeArtifactResolver): void {
  resolver = next;
  statusCache.clear();
}

export function resetResumeArtifactResolver(): void {
  resolver = cachedResolver;
  statusCache.clear();
}

export function resumeArtifactStatus(
  cli: CliType,
  sessionId: string,
): ResumeArtifactStatus {
  return resolver(cli, sessionId);
}
