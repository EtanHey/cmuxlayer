// AIDEV-NOTE: Live agent-state from the harness transcript JSONL — the sterile READ
// channel that replaces fragile terminal scraping for tokens/context/model/response.
// Field paths are the contract in docs/harness-jsonl-field-map.md (shared, verified vs
// on-disk JSONL 2026-06-04). Phoenix ingest (golems jsonl_to_phoenix_traces.py) reads
// the SAME map — keep both in lockstep. Terminal scraping survives ONLY for live-TUI
// liveness (wedge/menu/permission/idle) the JSONL can't show, and for Cursor context%
// (its JSONL carries neither tokens nor window).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type Harness = "claude" | "codex" | "cursor";

export interface HarnessSessionState {
  harness: Harness;
  model: string | null;
  /** Current context occupancy (last turn), NOT session cumulative. */
  tokens_used: number | null;
  /** Codex: from JSONL. Claude: from model table. Cursor: null (TUI strip owns it). */
  context_window: number | null;
  context_pct: number | null;
  last_text: string | null;
  last_tool: string | null;
  done: boolean;
}

// AIDEV-NOTE: Verified per-model context windows (researcher, BrainLayer brainbar-8a3da79c-159,
// 2026-06-04). Used ONLY as the Claude denominator (Claude JSONL has no window) and as the
// no-JSONL fallback. Codex NEVER uses this — it carries model_context_window in-JSONL per session.
// Ordered longest-key-first via length sort below for deterministic substring matching.
const MODEL_WINDOW_RULES: Array<[RegExp, number]> = [
  // Claude — current gen ships 1M standard (Opus 4.6/4.7/4.8, Sonnet 4.6)
  [/(opus-4-?[678])|(sonnet-4-?6)/, 1_000_000],
  // Claude — 200K tier (Haiku, and 4.0–4.5 generation incl. opus-4-1)
  [/haiku|(sonnet-4(?!-6))|(opus-4(?!-?[678]))|(opus-4-1)/, 200_000],
  // OpenAI GPT-5 / Codex family — 400K total window (272K input + 128K output)
  [/gpt-5/, 400_000],
  // OpenAI GPT-4 family
  [/gpt-4/, 128_000],
  // Google Gemini 2.x / 3.x
  [/gemini-[123]/, 1_048_576],
];

/**
 * Resolve a model's context window from the verified table.
 * Returns null for unknown models — NEVER a wrong 1M.
 * NOTE: Codex must prefer its in-JSONL model_context_window over this.
 */
export function modelContextWindow(model: string | null): number | null {
  if (!model) return null;
  const lower = model.toLowerCase().trim();
  for (const [re, window] of MODEL_WINDOW_RULES) {
    if (re.test(lower)) return window;
  }
  return null;
}

function pct(used: number | null, window: number | null): number | null {
  if (used === null || window === null || window <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / window) * 100)));
}

function parseLines(jsonl: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object")
        out.push(obj as Record<string, unknown>);
    } catch {
      // tolerate partial/corrupt lines — never throw on a live transcript
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Last text + tool from Claude/Cursor-style `message.content[]` blocks. */
function lastContentTextAndTool(
  events: Record<string, unknown>[],
  role: string,
) {
  let lastText: string | null = null;
  let lastTool: string | null = null;
  for (const ev of events) {
    if (ev.role !== role && ev.type !== role) continue;
    const message = asRecord(ev.message);
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const block = asRecord(item);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        lastText = block.text;
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        lastTool = block.name;
      }
    }
  }
  return { lastText, lastTool };
}

const CLAUDE_TRAILING_METADATA_TYPES = new Set([
  "system",
  "permission-mode",
  "mode",
  "last-prompt",
  "bridge-session",
  "custom-title",
  "agent-name",
  "pr-link",
  "user",
  "attachment",
  "file-history-snapshot",
  "queue-operation",
  "agent-setting",
  "worktree-state",
]);

function messageContent(ev: Record<string, unknown>): unknown[] {
  const message = asRecord(ev.message);
  return Array.isArray(message?.content) ? message.content : [];
}

function collectClaudeToolResults(ev: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const item of messageContent(ev)) {
    const block = asRecord(item);
    if (block?.type !== "tool_result") continue;
    if (typeof block.tool_use_id === "string") ids.add(block.tool_use_id);
  }
  return ids;
}

function collectClaudeToolUses(message: Record<string, unknown>): {
  ids: string[];
  missingId: boolean;
} {
  const ids: string[] = [];
  let missingId = false;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const item of content) {
    const block = asRecord(item);
    if (block?.type !== "tool_use") continue;
    if (typeof block.id === "string") ids.push(block.id);
    else missingId = true;
  }
  return { ids, missingId };
}

function claudeDone(events: Record<string, unknown>[]): boolean {
  const answeredToolUseIds = new Set<string>();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.type === "user" || ev.role === "user") {
      for (const id of collectClaudeToolResults(ev)) {
        answeredToolUseIds.add(id);
      }
      continue;
    }

    if (ev.type !== "assistant" && ev.role !== "assistant") {
      const type = typeof ev.type === "string" ? ev.type : null;
      if (type && CLAUDE_TRAILING_METADATA_TYPES.has(type)) continue;
      continue;
    }

    const message = asRecord(ev.message);
    if (!message) return false;
    const stopReason =
      typeof message.stop_reason === "string" ? message.stop_reason : null;
    const toolUses = collectClaudeToolUses(message);
    if (toolUses.missingId) return false;
    const hasUnansweredTool = toolUses.ids.some(
      (id) => !answeredToolUseIds.has(id),
    );
    if (hasUnansweredTool) return false;
    if (stopReason === "end_turn" || stopReason === "stop_sequence") {
      return true;
    }
    return stopReason === "tool_use" && toolUses.ids.length > 0;
  }
  return false;
}

function parseClaude(events: Record<string, unknown>[]): HarnessSessionState {
  let model: string | null = null;
  let tokensUsed: number | null = null;
  for (const ev of events) {
    if (ev.type !== "assistant") continue;
    const message = asRecord(ev.message);
    if (!message) continue;
    if (typeof message.model === "string") model = message.model;
    const usage = asRecord(message.usage);
    if (usage) {
      const input = asNumber(usage.input_tokens) ?? 0;
      const cacheRead = asNumber(usage.cache_read_input_tokens) ?? 0;
      const cacheCreate = asNumber(usage.cache_creation_input_tokens) ?? 0;
      const output = asNumber(usage.output_tokens) ?? 0;
      tokensUsed = input + cacheRead + cacheCreate + output;
    }
  }
  const window = modelContextWindow(model);
  const { lastText, lastTool } = lastContentTextAndTool(events, "assistant");
  return {
    harness: "claude",
    model,
    tokens_used: tokensUsed,
    context_window: window,
    context_pct: pct(tokensUsed, window),
    last_text: lastText,
    last_tool: lastTool,
    done: claudeDone(events),
  };
}

/** Codex envelope: every line is { type, timestamp, payload }; real type is payload.type. */
function codexPayload(ev: Record<string, unknown>): {
  type: string | null;
  payload: Record<string, unknown>;
} {
  const payload = asRecord(ev.payload) ?? {};
  const type =
    (typeof payload.type === "string" ? payload.type : null) ??
    (typeof ev.type === "string" ? (ev.type as string) : null);
  return { type, payload };
}

function parseCodex(events: Record<string, unknown>[]): HarnessSessionState {
  let model: string | null = null;
  let tokensUsed: number | null = null;
  let window: number | null = null;
  let lastText: string | null = null;
  let lastTool: string | null = null;
  let done = false;
  for (const ev of events) {
    const { type, payload } = codexPayload(ev);
    switch (type) {
      case "turn_context": {
        if (typeof payload.model === "string") model = payload.model;
        break;
      }
      case "token_count": {
        const info = asRecord(payload.info);
        if (info) {
          const last = asRecord(info.last_token_usage);
          const total = asNumber(last?.total_tokens);
          if (total !== null) tokensUsed = total;
          const w = asNumber(info.model_context_window);
          if (w !== null) window = w;
        }
        break;
      }
      case "agent_message": {
        if (typeof payload.message === "string") lastText = payload.message;
        break;
      }
      case "function_call":
      case "custom_tool_call":
      case "mcp_tool_call_end": {
        if (typeof payload.name === "string") lastTool = payload.name;
        break;
      }
      case "task_complete": {
        done = true;
        break;
      }
      case "task_started": {
        done = false;
        break;
      }
    }
  }
  return {
    harness: "codex",
    model,
    tokens_used: tokensUsed,
    context_window: window, // ALWAYS the in-JSONL value; never the table
    context_pct: pct(tokensUsed, window),
    last_text: lastText,
    last_tool: lastTool,
    done,
  };
}

function parseCursor(events: Record<string, unknown>[]): HarnessSessionState {
  // Cursor JSONL carries neither tokens nor window — text/tool only.
  const { lastText, lastTool } = lastContentTextAndTool(events, "assistant");
  return {
    harness: "cursor",
    model: null,
    tokens_used: null,
    context_window: null,
    context_pct: null,
    last_text: lastText,
    last_tool: lastTool,
    // AIDEV-NOTE: Cursor done is screen-scrape-fallback-only until its JSONL has a reliable lifecycle marker.
    done: false,
  };
}

/** Parse a full JSONL transcript string into live agent state. Pure; never throws. */
export function parseHarnessSession(
  harness: Harness,
  jsonl: string,
): HarnessSessionState {
  const events = parseLines(jsonl);
  switch (harness) {
    case "claude":
      return parseClaude(events);
    case "codex":
      return parseCodex(events);
    case "cursor":
      return parseCursor(events);
  }
}

function encodeClaudeCwd(cwd: string): string {
  // "/Users/e/Gits/cmuxlayer" → "-Users-e-Gits-cmuxlayer"
  return cwd.replaceAll("/", "-");
}

function encodeCursorCwd(cwd: string): string {
  // "/Users/e/Gits/golems" → "Users-e-Gits-golems" (no leading dash)
  return cwd.replace(/^\//, "").replaceAll("/", "-");
}

export interface ResolveOpts {
  home?: string;
  codexHome?: string;
}

export interface HarnessSessionIdentity {
  harness: Harness;
  session_id: string;
  cwd: string | null;
  path: string;
  mtime_ms: number;
}

export interface IdentityResolveOpts extends ResolveOpts {
  sinceMs?: number;
}

/**
 * Resolve the JSONL path from a thread's cwd + sessionId.
 * Claude/Cursor are deterministic. Codex rollout filenames embed a timestamp, so the
 * caller globs `*<sessionId>*.jsonl` under codexHome/sessions (handled by the reader);
 * here we return the sessions root marker for codex.
 */
export function resolveSessionPath(
  harness: Harness,
  cwd: string,
  sessionId: string,
  opts: ResolveOpts = {},
): string | null {
  if (!cwd || !sessionId) return null;
  const home = opts.home ?? homedir();
  switch (harness) {
    case "claude":
      return join(
        home,
        ".claude",
        "projects",
        encodeClaudeCwd(cwd),
        `${sessionId}.jsonl`,
      );
    case "cursor":
      return join(
        home,
        ".cursor",
        "projects",
        encodeCursorCwd(cwd),
        "agent-transcripts",
        sessionId,
        `${sessionId}.jsonl`,
      );
    case "codex":
      // Rollout filename carries a timestamp prefix; resolved by glob in the reader.
      return null;
  }
}

/** Read + parse a transcript file. Returns null if missing/unreadable (→ screen-parser fallback). */
export function readHarnessSessionFromFile(
  harness: Harness,
  path: string,
): HarnessSessionState | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseHarnessSession(harness, content);
}

export interface HarnessSessionWithMeta {
  state: HarnessSessionState;
  path: string;
  mtime_ms: number;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function afterSince(path: string, sinceMs: number | undefined): boolean {
  return sinceMs === undefined || mtimeMs(path) >= sinceMs;
}

function newestIdentity(
  current: HarnessSessionIdentity | null,
  candidate: HarnessSessionIdentity,
): HarnessSessionIdentity {
  return !current || candidate.mtime_ms > current.mtime_ms
    ? candidate
    : current;
}

function sessionIdFromJsonlName(path: string): string | null {
  const name = basename(path);
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : null;
}

function parseCodexSessionMeta(
  path: string,
): { session_id: string; cwd: string | null } | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type !== "session_meta") continue;
      const payload = asRecord(obj.payload);
      const id = typeof payload?.id === "string" ? payload.id : null;
      if (!id) continue;
      return {
        session_id: id,
        cwd: typeof payload?.cwd === "string" ? payload.cwd : null,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Find the newest harness transcript identity for a cwd. This is the bootstrap
 * path for resume: it discovers the real session id before callers already know
 * that id.
 */
export function findLatestHarnessSessionIdentity(
  harness: Harness,
  cwd: string,
  opts: IdentityResolveOpts = {},
): HarnessSessionIdentity | null {
  if (!cwd) return null;
  const home = opts.home ?? homedir();

  switch (harness) {
    case "claude": {
      const root = join(home, ".claude", "projects", encodeClaudeCwd(cwd));
      let found: HarnessSessionIdentity | null = null;
      for (const name of safeReaddir(root)) {
        const path = join(root, name);
        if (!name.endsWith(".jsonl") || !isFile(path) || !afterSince(path, opts.sinceMs)) {
          continue;
        }
        const sessionId = sessionIdFromJsonlName(path);
        if (!sessionId) continue;
        found = newestIdentity(found, {
          harness,
          session_id: sessionId,
          cwd,
          path,
          mtime_ms: mtimeMs(path),
        });
      }
      return found;
    }
    case "cursor": {
      const root = join(
        home,
        ".cursor",
        "projects",
        encodeCursorCwd(cwd),
        "agent-transcripts",
      );
      let found: HarnessSessionIdentity | null = null;
      for (const dir of safeReaddir(root)) {
        const transcriptDir = join(root, dir);
        if (!isDir(transcriptDir)) continue;
        for (const name of safeReaddir(transcriptDir)) {
          const path = join(transcriptDir, name);
          if (!name.endsWith(".jsonl") || !isFile(path) || !afterSince(path, opts.sinceMs)) {
            continue;
          }
          const sessionId = sessionIdFromJsonlName(path) ?? dir;
          found = newestIdentity(found, {
            harness,
            session_id: sessionId,
            cwd,
            path,
            mtime_ms: mtimeMs(path),
          });
        }
      }
      return found;
    }
    case "codex": {
      const root = join(opts.codexHome ?? join(home, ".codex"), "sessions");
      let found: HarnessSessionIdentity | null = null;
      const walk = (dir: string, depth: number): void => {
        for (const name of safeReaddir(dir)) {
          const child = join(dir, name);
          if (isFile(child) && name.endsWith(".jsonl")) {
            if (!afterSince(child, opts.sinceMs)) continue;
            const meta = parseCodexSessionMeta(child);
            if (!meta || meta.cwd !== cwd) continue;
            found = newestIdentity(found, {
              harness,
              session_id: meta.session_id,
              cwd: meta.cwd,
              path: child,
              mtime_ms: mtimeMs(child),
            });
            continue;
          }
          if (depth > 0 && isDir(child)) {
            walk(child, depth - 1);
          }
        }
      };
      walk(root, 4);
      return found;
    }
  }
}

/**
 * Find a harness transcript by its (UUID) sessionId — no cwd needed, since the id is
 * globally unique. Dependency-free bounded walk of the harness root. Returns null if
 * not found (caller falls back to screen-parser).
 */
export function findHarnessSessionPath(
  harness: Harness,
  sessionId: string,
  opts: ResolveOpts = {},
): string | null {
  if (!sessionId) return null;
  const home = opts.home ?? homedir();
  switch (harness) {
    case "claude": {
      // ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl — scan project dirs.
      const root = join(home, ".claude", "projects");
      for (const dir of safeReaddir(root)) {
        const candidate = join(root, dir, `${sessionId}.jsonl`);
        if (isFile(candidate)) return candidate;
      }
      return null;
    }
    case "cursor": {
      // ~/.cursor/projects/<enc-cwd>/agent-transcripts/<id>/<id>.jsonl — scan project dirs.
      const root = join(home, ".cursor", "projects");
      for (const dir of safeReaddir(root)) {
        const candidate = join(
          root,
          dir,
          "agent-transcripts",
          sessionId,
          `${sessionId}.jsonl`,
        );
        if (isFile(candidate)) return candidate;
      }
      return null;
    }
    case "codex": {
      // ~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<sessionId>.jsonl — bounded 3-level walk.
      const root = join(opts.codexHome ?? join(home, ".codex"), "sessions");
      const suffix = `${sessionId}.jsonl`;
      const walk = (dir: string, depth: number): string | null => {
        for (const name of safeReaddir(dir)) {
          const child = join(dir, name);
          if (name.endsWith(suffix) && isFile(child)) return child;
          if (depth > 0 && !name.includes(".")) {
            const found = walk(child, depth - 1);
            if (found) return found;
          }
        }
        return null;
      };
      return walk(root, 4);
    }
  }
}

// AIDEV-NOTE: sessionId → resolved path cache. Transcript paths never move once created,
// so caching avoids re-walking the harness root on every read_screen/my_agents call.
const sessionPathCache = new Map<string, string>();

/**
 * Resolve (cached) + read + parse a harness session by sessionId. Returns null if the
 * harness is unsupported, the file can't be found, or it can't be read.
 */
export function loadHarnessSession(
  harness: Harness,
  sessionId: string,
  opts: ResolveOpts = {},
): HarnessSessionState | null {
  if (!sessionId) return null;
  const cacheKey = `${harness}:${sessionId}`;
  let path = sessionPathCache.get(cacheKey) ?? null;
  if (path && !isFile(path)) path = null; // stale (e.g. rotated) → re-resolve
  if (!path) {
    path = findHarnessSessionPath(harness, sessionId, opts);
    if (path) sessionPathCache.set(cacheKey, path);
  }
  if (!path) return null;
  return readHarnessSessionFromFile(harness, path);
}

export function loadHarnessSessionWithMeta(
  harness: Harness,
  sessionId: string,
  opts: ResolveOpts = {},
): HarnessSessionWithMeta | null {
  if (!sessionId) return null;
  const cacheKey = `${harness}:${sessionId}`;
  let path = sessionPathCache.get(cacheKey) ?? null;
  if (path && !isFile(path)) path = null;
  if (!path) {
    path = findHarnessSessionPath(harness, sessionId, opts);
    if (path) sessionPathCache.set(cacheKey, path);
  }
  if (!path) return null;
  const state = readHarnessSessionFromFile(harness, path);
  if (!state) return null;
  const mtime_ms = mtimeMs(path);
  if (mtime_ms <= 0) return null;
  return { state, path, mtime_ms };
}

/**
 * True when JSONL-derived agent state is enabled. DEFAULT-ON (validated 2026-06-04: 647
 * tests + 4 live Codex sessions correct; strictly additive — overlay only fires when a
 * session JSONL resolves, else screen-parser stands). Opt OUT with CMUXLAYER_HARNESS_JSONL=0.
 */
export function harnessJsonlEnabled(): boolean {
  return process.env.CMUXLAYER_HARNESS_JSONL !== "0";
}

/** Context/usage fields an overlay can fill. ParsedScreenResult satisfies this. */
export interface ContextFields {
  token_count: number | null;
  context_window: number | null;
  context_pct: number | null;
  model: string | null;
}

/**
 * Overlay JSONL-derived state onto a screen-parsed result. JSONL wins when it provides a
 * value; otherwise the screen-parser value is kept. This is what makes Cursor "just work":
 * its JSONL carries no tokens/window (all null) → the TUI-strip-derived screen values stand.
 */
export function applyHarnessState<T extends ContextFields>(
  parsed: T,
  state: HarnessSessionState | null,
): T {
  if (!state) return parsed;
  return {
    ...parsed,
    token_count: state.tokens_used ?? parsed.token_count,
    context_window: state.context_window ?? parsed.context_window,
    context_pct: state.context_pct ?? parsed.context_pct,
    model: state.model ?? parsed.model,
  };
}
