/**
 * Session-ID self-registration — cmuxlayer READ side (P0 root fix).
 *
 * Agents SELF-REGISTER their real session id at boot: a Claude SessionStart hook
 * (or a Codex launcher wrapper) appends one JSON object per line to an
 * append-only registry file. cmuxlayer READS that file instead of scanning
 * `~/.claude`/`~/.codex` transcript dirs and inferring identity by cwd+recency —
 * the fragile mechanism that breaks with raw spawns, worktrees, and
 * many-agents-per-repo (25/25 agents `session_id:null`).
 *
 * The resolver here is the PRIMARY `SessionIdentityResolver`; the old transcript
 * scan (`findLatestHarnessSessionIdentity`) is kept only as a deprecated
 * last-resort fallback for hook-less agents, reached when this returns null.
 *
 * Registry contract (written by the boot hook / launcher wrapper; verified live):
 *   {"session_id":"<id>","cwd":"<abs worktree cwd>","pid":<agent pid,int>,
 *    "cli":"claude|codex","launcher":"<e.g. cmuxlayerCodex>",
 *    "session_path":"<optional rollout path>","ts":<epoch MILLISECONDS,int>}
 * Path: ${CMUXLAYER_SESSION_REGISTRY:-$HOME/.cmuxlayer/session-registry.jsonl}.
 * Tolerant reader: skip malformed lines, ignore unknown extra fields, require
 * only session_id + cwd to bind, never fabricate an id.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "./agent-types.js";
import type {
  CapturedSessionIdentity,
  SessionIdentityResolver,
} from "./agent-engine.js";

/** A single self-registration record, after tolerant parsing. */
export interface SelfRegistrationEntry {
  session_id: string;
  cwd: string;
  /** Agent CLI process pid (getppid past the shell wrapper). May be absent. */
  pid: number | null;
  cli: string | null;
  launcher: string | null;
  /** Optional rollout/transcript path; returned as the resolved `path`. */
  session_path: string | null;
  /** Epoch MILLISECONDS. Sorted descending; missing sorts oldest. */
  ts: number | null;
}

export interface SelfRegistrationResolverOptions {
  /**
   * Registry file path. Defaults to
   * `${CMUXLAYER_SESSION_REGISTRY:-$HOME/.cmuxlayer/session-registry.jsonl}`.
   */
  registryPath?: string;
  /**
   * Injectable reader (default `fs.readFileSync` utf8). Returns the file body,
   * `null` for a missing/unreadable file, or throws (also treated as null).
   * Injected in tests so no real HOME I/O is touched.
   */
  readFile?: (path: string) => string | null;
}

/** Resolve the registry path from env, defaulting under `$HOME/.cmuxlayer`. */
export function resolveSessionRegistryPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CMUXLAYER_SESSION_REGISTRY?.trim();
  if (override) return override;
  return join(homedir(), ".cmuxlayer", "session-registry.jsonl");
}

function toFiniteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse JSONL registry text into entries. Malformed lines and records missing
 * the required `session_id`/`cwd` are skipped; unknown fields are ignored.
 */
export function parseSelfRegistrationLines(
  text: string,
): SelfRegistrationEntry[] {
  const entries: SelfRegistrationEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed line — skip
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    const session_id =
      typeof rec.session_id === "string" ? rec.session_id.trim() : "";
    const cwd = typeof rec.cwd === "string" ? rec.cwd : "";
    if (!session_id || !cwd) continue; // require session_id + cwd to bind
    entries.push({
      session_id,
      cwd,
      pid: toFiniteInt(rec.pid),
      cli: toStringOrNull(rec.cli),
      launcher: toStringOrNull(rec.launcher),
      session_path: toStringOrNull(rec.session_path),
      ts: toFiniteInt(rec.ts),
    });
  }
  return entries;
}

/**
 * Choose the winning entry among same-cwd candidates.
 *
 * pid is a SECONDARY tiebreaker: if the agent's pid is known AND some candidate
 * shares it, restrict to those; otherwise the whole cwd-matched pool competes.
 * The winner is the newest `ts` (epoch ms); on an exact tie the later (appended
 * last) record wins. Note: cmuxlayer's AgentRecord.pid is currently never
 * populated in production (always null), so in practice this reduces to
 * newest-ts-among-same-cwd — cwd-exact already carries the worktree case.
 */
function chooseCandidate(
  candidates: SelfRegistrationEntry[],
  agentPid: number | null | undefined,
): SelfRegistrationEntry | null {
  if (candidates.length === 0) return null;
  let pool = candidates;
  if (agentPid != null) {
    const pidMatches = candidates.filter((e) => e.pid === agentPid);
    if (pidMatches.length > 0) pool = pidMatches;
  }
  return pool.reduce((best, entry) => {
    const bestTs = best.ts ?? Number.NEGATIVE_INFINITY;
    const entryTs = entry.ts ?? Number.NEGATIVE_INFINITY;
    return entryTs >= bestTs ? entry : best;
  });
}

/**
 * Build the self-registration `SessionIdentityResolver`.
 *
 * Match is cwd-exact PRIMARY (`entry.cwd === agent.launch_cwd`, worktree-precise)
 * with pid as a secondary tiebreaker and newest `ts` deciding. Returns
 * `{ session_id, path }` or `null`. NO filesystem scan of session dirs; a
 * missing/unreadable/empty registry, an agent without a launch_cwd, or no
 * cwd match all return `null` (the caller then falls back to the scan).
 */
export function makeSelfRegistrationSessionResolver(
  options: SelfRegistrationResolverOptions = {},
): SessionIdentityResolver {
  const registryPath = options.registryPath ?? resolveSessionRegistryPath();
  const readFile = options.readFile ?? defaultReadFile;

  return (agent: AgentRecord): CapturedSessionIdentity | null => {
    const launchCwd = agent.launch_cwd?.trim();
    if (!launchCwd) return null; // no cwd key → cannot bind

    let text: string | null;
    try {
      text = readFile(registryPath);
    } catch {
      return null; // missing/unreadable → fall back to scan
    }
    if (!text) return null;

    const candidates = parseSelfRegistrationLines(text).filter(
      (entry) => entry.cwd === launchCwd,
    );
    const chosen = chooseCandidate(candidates, agent.pid);
    if (!chosen) return null;
    return {
      session_id: chosen.session_id,
      path: chosen.session_path ?? null,
    };
  };
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
