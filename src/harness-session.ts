// AIDEV-NOTE: Live agent-state from the harness transcript JSONL — the sterile READ
// channel that replaces fragile terminal scraping for tokens/context/model/response.
// Field paths are the contract in docs/harness-jsonl-field-map.md (shared, verified vs
// on-disk JSONL 2026-06-04). Phoenix ingest (golems jsonl_to_phoenix_traces.py) reads
// the SAME map — keep both in lockstep. Terminal scraping survives ONLY for live-TUI
// liveness (wedge/menu/permission/idle) the JSONL can't show, and for Cursor context%
// (its JSONL carries neither tokens nor window).
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
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
// 2026-06-04; gpt-5.6: Etan web-verify + fleet rules doc §10, 2026-07-11, superseded
// for the app tier by Etan's 400K ruling, 2026-07-15). Used as the
// Claude denominator (Claude JSONL has no window), the no-JSONL fallback, and a floor only
// for explicitly versioned Codex rules when a lagging CLI reports a smaller session window.
// Rules are checked in order, so specific versions must precede generic family matches.
const MODEL_WINDOW_RULES: Array<
  [pattern: RegExp, window: number, jsonlFloor?: boolean]
> = [
  // Claude — current gen ships 1M standard (Opus 4.6/4.7/4.8, Sonnet 4.6)
  [/(opus-4-?[678])|(sonnet-4-?6)/, 1_000_000],
  // Claude — Fable (Mythos tier) ships 1M standard. A live 151% reading proved it was
  // falling through to the 200K default. Matches "fable", "fable-5", "claude-fable-5".
  [/fable/, 1_000_000],
  // Claude — 200K tier (Haiku, and 4.0–4.5 generation incl. opus-4-1)
  [/haiku|(sonnet-4(?!-6))|(opus-4(?!-?[678]))|(opus-4-1)/, 200_000],
  // OpenAI GPT-5.6 / Codex app tier — 400K, with an explicit stale-JSONL floor.
  [/gpt-5[.-]6(?:$|[^0-9])/, 400_000, true],
  // OpenAI generic GPT-5 / Codex family — 400K total window (272K input + 128K output)
  [/gpt-5/, 400_000],
  // OpenAI GPT-4 family
  [/gpt-4/, 128_000],
  // Google Gemini 2.x / 3.x
  [/gemini-[123]/, 1_048_576],
];

/**
 * Resolve a model's context window from the verified table.
 * Returns null for unknown models — NEVER a wrong 1M.
 * NOTE: Codex normally prefers its in-JSONL model_context_window; explicitly versioned
 * rules may provide a verified larger floor when the client CLI lags model reality.
 */
export function modelContextWindow(model: string | null): number | null {
  if (!model) return null;
  const lower = model.toLowerCase().trim();
  for (const [re, window] of MODEL_WINDOW_RULES) {
    if (re.test(lower)) return window;
  }
  return null;
}

function modelContextWindowJsonlFloor(model: string | null): number | null {
  if (!model) return null;
  const lower = model.toLowerCase().trim();
  for (const [re, window, jsonlFloor] of MODEL_WINDOW_RULES) {
    if (jsonlFloor && re.test(lower)) return window;
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
  const verifiedWindowFloor = modelContextWindowJsonlFloor(model);
  if (verifiedWindowFloor !== null) {
    // Client CLIs can lag model reality (codex-cli 0.144.1 reports 353400 for gpt-5.6).
    // Prefer the larger denominator: undersizing wrongly retires orchestrated seats, while
    // unknown models retain JSONL as their only signal because they have no verified floor.
    window = window === null ? verifiedWindowFloor : Math.max(window, verifiedWindowFloor);
  }
  return {
    harness: "codex",
    model,
    tokens_used: tokensUsed,
    context_window: window,
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
  expectedText?: string | null;
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
  const content = readHarnessSessionTextWindow(path);
  if (content === null) return null;
  return parseHarnessSession(harness, content);
}

const DEFAULT_HARNESS_SESSION_TAIL_BYTES = 512 * 1024;
const DEFAULT_HARNESS_SESSION_IDENTITY_BYTES = 256 * 1024;

export function readHarnessSessionTextWindow(
  path: string,
  opts: { maxBytes?: number } = {},
): string | null {
  try {
    const maxBytes = Math.max(
      1,
      opts.maxBytes ?? DEFAULT_HARNESS_SESSION_TAIL_BYTES,
    );
    const size = statSync(path).size;
    if (size <= maxBytes) return readFileSync(path, "utf8");

    const start = size - maxBytes;
    const buffer = Buffer.allocUnsafe(maxBytes);
    const fd = openSync(path, "r");
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buffer, 0, maxBytes, start);
    } finally {
      closeSync(fd);
    }
    if (bytesRead <= 0) return "";

    let text = buffer.subarray(0, bytesRead).toString("utf8");
    const firstNewline = text.indexOf("\n");
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    return text;
  } catch {
    return null;
  }
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

function sessionIdFromJsonlName(path: string): string | null {
  const name = basename(path);
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : null;
}

function readTextFile(path: string): string | null {
  return readHarnessSessionIdentityWindow(path);
}

function readHarnessSessionIdentityWindow(path: string): string | null {
  try {
    const size = statSync(path).size;
    const maxBytes = DEFAULT_HARNESS_SESSION_IDENTITY_BYTES;
    if (size <= maxBytes * 2) return readFileSync(path, "utf8");

    const headBuffer = Buffer.allocUnsafe(maxBytes);
    const tailBuffer = Buffer.allocUnsafe(maxBytes);
    const fd = openSync(path, "r");
    let headBytes = 0;
    let tailBytes = 0;
    try {
      headBytes = readSync(fd, headBuffer, 0, maxBytes, 0);
      tailBytes = readSync(fd, tailBuffer, 0, maxBytes, size - maxBytes);
    } finally {
      closeSync(fd);
    }

    let tail = tailBuffer.subarray(0, tailBytes).toString("utf8");
    const firstTailNewline = tail.indexOf("\n");
    if (firstTailNewline >= 0) tail = tail.slice(firstTailNewline + 1);
    return `${headBuffer.subarray(0, headBytes).toString("utf8")}\n${tail}`;
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePromptText(value: string): string {
  return normalizeText(value.replace(/<\/?\s*user_query\s*>/gi, " "));
}

function promptTextMatchesExpected(
  value: string,
  expectedText: string,
): boolean {
  return normalizePromptText(value) === expectedText;
}

function promptFieldContainsExpectedText(
  value: unknown,
  expectedText: string,
): boolean {
  if (typeof value === "string") {
    return promptTextMatchesExpected(value, expectedText);
  }
  if (Array.isArray(value)) {
    const textParts = value.flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      const block = asRecord(item);
      if (block?.type === "text" && typeof block.text === "string") {
        return [block.text];
      }
      return [];
    });
    return (
      textParts.some((text) => promptTextMatchesExpected(text, expectedText)) ||
      (textParts.length > 1 &&
        promptTextMatchesExpected(textParts.join(" "), expectedText))
    );
  }
  const block = asRecord(value);
  if (block?.type === "text" && typeof block.text === "string") {
    return promptTextMatchesExpected(block.text, expectedText);
  }
  return false;
}

function recordPromptFields(event: Record<string, unknown>): unknown[] {
  const fields: unknown[] = [];
  const type = typeof event.type === "string" ? event.type : null;
  const role = typeof event.role === "string" ? event.role : null;
  const message = asRecord(event.message);
  const payload = asRecord(event.payload);

  if (type === "user_message") {
    fields.push(payload?.message, payload?.text, payload?.input);
  }

  if (role === "user" || type === "user") {
    fields.push(
      message?.content,
      message?.text,
      event.content,
      payload?.message,
      payload?.text,
      payload?.input,
    );
  }

  const payloadType = typeof payload?.type === "string" ? payload.type : null;
  if (payloadType === "user_message" || payloadType === "user") {
    fields.push(payload?.message, payload?.text, payload?.input);
  }

  return fields;
}

function jsonlContainsExpectedPromptText(
  content: string,
  expectedText: string | null | undefined,
): boolean {
  const normalizedExpected = normalizeText(expectedText ?? "");
  if (!normalizedExpected) return false;

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const event = asRecord(JSON.parse(line));
      if (
        event &&
        recordPromptFields(event).some((field) =>
          promptFieldContainsExpectedText(field, normalizedExpected),
        )
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function parseCodexSessionMetaFromContent(
  content: string,
): { session_id: string; cwd: string | null } | null {
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

interface HarnessSessionIdentityCandidate extends HarnessSessionIdentity {
  expected_text_match: boolean;
}

function chooseIdentityCandidate(
  candidates: HarnessSessionIdentityCandidate[],
  expectedText: string | null | undefined,
): HarnessSessionIdentity | null {
  if (candidates.length === 0) return null;
  const hasExpectedText = !!normalizeText(expectedText ?? "");
  if (candidates.length === 1) {
    const { expected_text_match, ...identity } = candidates[0]!;
    return !hasExpectedText || expected_text_match ? identity : null;
  }

  if (hasExpectedText) {
    const matches = candidates.filter(
      (candidate) => candidate.expected_text_match,
    );
    if (matches.length === 1) {
      const { expected_text_match, ...identity } = matches[0]!;
      return identity;
    }
  }

  return null;
}

/**
 * Find a precise harness transcript identity for a cwd. This is the bootstrap
 * path for resume: it discovers the real session id before callers already know
 * that id. When the caller provides expectedText, the candidate must contain it
 * in a user-origin prompt field; ambiguous or mismatched candidates fail closed.
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
      const candidates: HarnessSessionIdentityCandidate[] = [];
      for (const name of safeReaddir(root)) {
        const path = join(root, name);
        if (
          !name.endsWith(".jsonl") ||
          !isFile(path) ||
          !afterSince(path, opts.sinceMs)
        ) {
          continue;
        }
        const sessionId = sessionIdFromJsonlName(path);
        if (!sessionId) continue;
        const content = readTextFile(path) ?? "";
        candidates.push({
          harness,
          session_id: sessionId,
          cwd,
          path,
          mtime_ms: mtimeMs(path),
          expected_text_match: jsonlContainsExpectedPromptText(
            content,
            opts.expectedText,
          ),
        });
      }
      return chooseIdentityCandidate(candidates, opts.expectedText);
    }
    case "cursor": {
      const root = join(
        home,
        ".cursor",
        "projects",
        encodeCursorCwd(cwd),
        "agent-transcripts",
      );
      const candidates: HarnessSessionIdentityCandidate[] = [];
      for (const dir of safeReaddir(root)) {
        const transcriptDir = join(root, dir);
        if (!isDir(transcriptDir)) continue;
        for (const name of safeReaddir(transcriptDir)) {
          const path = join(transcriptDir, name);
          if (
            !name.endsWith(".jsonl") ||
            !isFile(path) ||
            !afterSince(path, opts.sinceMs)
          ) {
            continue;
          }
          const sessionId = sessionIdFromJsonlName(path) ?? dir;
          const content = readTextFile(path) ?? "";
          candidates.push({
            harness,
            session_id: sessionId,
            cwd,
            path,
            mtime_ms: mtimeMs(path),
            expected_text_match: jsonlContainsExpectedPromptText(
              content,
              opts.expectedText,
            ),
          });
        }
      }
      return chooseIdentityCandidate(candidates, opts.expectedText);
    }
    case "codex": {
      const root = join(opts.codexHome ?? join(home, ".codex"), "sessions");
      const candidates: HarnessSessionIdentityCandidate[] = [];
      const walk = (dir: string, depth: number): void => {
        for (const name of safeReaddir(dir)) {
          const child = join(dir, name);
          if (isFile(child) && name.endsWith(".jsonl")) {
            if (!afterSince(child, opts.sinceMs)) continue;
            const content = readTextFile(child);
            if (!content) continue;
            const meta = parseCodexSessionMetaFromContent(content);
            if (!meta || meta.cwd !== cwd) continue;
            candidates.push({
              harness,
              session_id: meta.session_id,
              cwd: meta.cwd,
              path: child,
              mtime_ms: mtimeMs(child),
              expected_text_match: jsonlContainsExpectedPromptText(
                content,
                opts.expectedText,
              ),
            });
            continue;
          }
          if (depth > 0 && isDir(child)) {
            walk(child, depth - 1);
          }
        }
      };
      walk(root, 4);
      return chooseIdentityCandidate(candidates, opts.expectedText);
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
