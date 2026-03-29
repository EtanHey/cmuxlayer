import type {
  ParsedScreenAgentType,
  ParsedScreenResult,
  ParsedScreenStatus,
} from "./types.js";

// AIDEV-NOTE: DEFAULT context window sizes per model family. All Claude models default to 200K.
// The 1M tier is detected via "(1M" suffix in the status line or inferred from token_count > 200K.
// ORDER MATTERS: resolveModelMax uses substring matching — longer keys must come first.
export const MODEL_MAX_TOKENS: Record<string, number> = {
  // Claude models — ALL default to 200K (1M is the Max-plan tier, detected separately)
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  // GPT / Codex models
  "gpt-5": 1_000_000,
  "gpt-4": 128_000,
  // Gemini models
  "gemini-3": 1_000_000,
  "gemini-2": 1_000_000,
  "gemini-1": 1_000_000,
};

// Pre-sorted by key length descending for deterministic longest-match-first.
const SORTED_MODEL_ENTRIES = Object.entries(MODEL_MAX_TOKENS).sort(
  ([a], [b]) => b.length - a.length,
);

/**
 * Resolve the DEFAULT context window for a model string.
 * Returns the base tier (e.g. 200K for Claude). Use inferContextWindow() for
 * smart inference that detects the 1M tier from "(1M" suffix or token count.
 */
export function resolveModelMax(model: string | null): number | null {
  if (!model) return null;
  const lower = model.toLowerCase().trim();

  for (const [key, max] of SORTED_MODEL_ENTRIES) {
    if (lower.includes(key) || lower.includes(key.replace("-", " ")))
      return max;
  }

  return null;
}

/**
 * Smart context window inference. Uses three signals:
 * 1. Explicit "(1M" in screen text → 1M (Max plan confirmed)
 * 2. token_count > default window → must be 1M (can't exceed 200K on 200K tier)
 * 3. Fall back to resolveModelMax() default
 */
export function inferContextWindow(
  model: string | null,
  tokenCount: number | null,
  rawText: string,
): number | null {
  // Signal 1: explicit "(1M" in the status line should win even if model parsing fails.
  if (/\(1M\b/i.test(rawText)) return 1_000_000;

  const defaultMax = resolveModelMax(model);
  const looksLikeClaudePane =
    /CLAUDE_COUNTER|bypass permissions on|Claude Code|🤖/i.test(rawText);
  if (defaultMax === null) {
    if (looksLikeClaudePane && tokenCount !== null) {
      return tokenCount > 200_000 ? 1_000_000 : 200_000;
    }
    return null;
  }

  // Signal 2: token count exceeds default → must be a larger tier
  if (tokenCount !== null && tokenCount > defaultMax) return 1_000_000;

  return defaultMax;
}

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const DONE_SIGNAL_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_DONE)\b/;
const CLAUDE_COUNTER_RE = /^\s*CLAUDE_COUNTER:\s*(\d+)\s*$/m;
const RESPONSE_BLOCK_RE = /---RESPONSE_START---\s*(.*?)\s*---RESPONSE_END---/s;
const TOKEN_USAGE_RE = /Token usage:\s*total=([0-9][0-9,]*)/i;
// Match token counts only at end of status lines to avoid false positives from prose.
// Example valid: "418310 tokens" or "  100,000 tokens"
// Example invalid: "I mentioned 42 tokens in this note"
const TOKENS_RE = /(?:^|\n).*?\b([0-9][0-9,]*)\s+tokens\s*$/im;
const MODEL_COST_RE = /🤖\s*([^|\n]+?)\s*\|\s*💰\s*\$([0-9]+(?:\.[0-9]+)?)/i;
const HEADER_MODEL_RE =
  /^\s*[▝▜▛▘▐].*?\b((?:Opus|Sonnet|Haiku|GPT|Claude)\s+[0-9][^(\n·|]*)/m;
// Fallback: 🤖 + model name + version, without requiring cost or pipe
const MODEL_EMOJI_RE =
  /🤖\s*((?:Opus|Sonnet|Haiku|GPT|Claude)\s+[0-9][0-9.]*)/i;
// Last resort: 🤖 + bare model family name (for narrow panes where version is cut off)
const MODEL_KEYWORD_RE = /🤖\s*(Opus|Sonnet|Haiku)\b/i;
const EXIT_CODE_RE = /(?:exit(?:ed)?\s+with\s+code|code)\s+(\d+)/gi;
const CODEX_MODEL_RE =
  /^(gpt-[0-9][0-9a-z.-]*(?:\s+\w+)?)\s*[·•]\s*(\d+)%\s+left/m;
const CODEX_WORKING_RE =
  /Working\s*\(([0-9]+m\s*[0-9]+s)\s*[•·]\s*esc to interrupt\)/i;
const CODEX_RESUME_RE = /To continue this session,\s*run\s+codex\s+resume/i;
const CODEX_ACTION_RE = /^\s*[•·]\s+(.+)$/gm;
const GEMINI_MODEL_RE =
  /(?:^|\n)\s*(?:Model:\s*)?(gemini-[0-9][0-9a-z.-]*)\b/im;
const CLAUDE_DONE_LINE_RE = /^\s*[⏺●]\s+Completed(?: successfully)?\s*$/im;
const CLAUDE_WORKING_LINE_RE =
  /^\s*(?:[✻✢✳✶]|[⏺●])\s+(?:Thinking|Working|Running|Receiving|Preparing|Updating|Sending|Reading|Analyzing)\b/im;

/** Cursor Agent CLI — mode bar, hex status, context strip, follow-up prompt */
const CURSOR_MODE_BAR_RE =
  /\/ commands · @ files · ! shell · ctrl\+r to review edits/i;
const CURSOR_HEX_RUNNING_RE = /⬡\s+Running\.\.\./i;
const CURSOR_HEX_IDLE_RE = /⬡\s+Idle\b/i;
const CURSOR_TOKEN_LINE_RE =
  /⬡\s+(?:Running\.\.\.|Idle)\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*([km])?\s*tokens\b/i;
const CURSOR_STATUS_PCT_RE =
  /(?:^|\n)\s*(?:Auto|Agent)\s*·\s*(\d+(?:\.\d+)?)\s*%\s*·/i;
const CURSOR_FOLLOWUP_RE = /→\s*Add a follow-up/i;
const CURSOR_STOP_RE = /ctrl\+c to stop/i;
const CURSOR_SESSION_COMPLETE_RE =
  /\b(?:Task completed|Generation complete|All edits applied|Session complete)\b/i;
const CURSOR_CHECKMARK_DONE_RE =
  /(?:^|\n)\s*[✓✔]\s*(?:Done|Complete|Completed)\b/i;
const CURSOR_MODEL_LINE_RE = /^\s*Model:\s*(.+)$/im;
const CURSOR_USING_LINE_RE = /^\s*Using\s*:?\s*(.+)$/im;
const CURSOR_MODEL_INLINE_RE =
  /\b(claude-[0-9][0-9a-z.-]*|gpt-[0-9][0-9a-z.-]*(?:\s+(?:high|low|mini))?|gemini-[0-9][0-9a-z.-]*)\b/i;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function normalizeText(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isCursorAgentScreen(text: string): boolean {
  if (CURSOR_MODE_BAR_RE.test(text)) return true;
  if (CURSOR_FOLLOWUP_RE.test(text) && CURSOR_STOP_RE.test(text)) return true;
  if (CURSOR_STATUS_PCT_RE.test(text) && /files edited/i.test(text)) {
    return true;
  }
  if (
    (CURSOR_HEX_RUNNING_RE.test(text) || CURSOR_HEX_IDLE_RE.test(text)) &&
    CURSOR_TOKEN_LINE_RE.test(text)
  ) {
    return true;
  }
  return false;
}

function detectAgentType(text: string): ParsedScreenAgentType {
  const claudeMarkers = [
    "CLAUDE_COUNTER",
    "bypass permissions on",
    "---RESPONSE_START---",
    "Claude Code",
  ];
  if (claudeMarkers.some((marker) => text.includes(marker))) {
    return "claude";
  }
  if (
    HEADER_MODEL_RE.test(text) ||
    MODEL_COST_RE.test(text) ||
    CLAUDE_DONE_LINE_RE.test(text) ||
    CLAUDE_WORKING_LINE_RE.test(text)
  ) {
    return "claude";
  }

  if (
    CODEX_MODEL_RE.test(text) ||
    CODEX_WORKING_RE.test(text) ||
    CODEX_RESUME_RE.test(text)
  ) {
    return "codex";
  }

  if (/Gemini CLI/i.test(text)) {
    return "gemini";
  }
  if (GEMINI_MODEL_RE.test(text) && !CODEX_MODEL_RE.test(text)) {
    return "gemini";
  }

  if (isCursorAgentScreen(text)) {
    return "cursor";
  }

  return "unknown";
}

function parseTokenCount(text: string): number | null {
  const usageMatch = text.match(TOKEN_USAGE_RE);
  if (usageMatch) {
    return Number.parseInt(usageMatch[1].replaceAll(",", ""), 10);
  }

  // AIDEV-NOTE: TOKENS_RE is a loose fallback ("N tokens") that can false-positive on prose.
  // Restrict it to the last 5 non-empty lines of the screen buffer where footer/status lines live.
  const lines = text.split("\n");
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const tail = nonEmpty.slice(-5).join("\n");
  const tokensMatch = tail.match(TOKENS_RE);
  if (tokensMatch) {
    return Number.parseInt(tokensMatch[1].replaceAll(",", ""), 10);
  }

  return null;
}

function parseDoneSignal(text: string): string | null {
  const explicitDoneSignal = text.match(DONE_SIGNAL_RE)?.[1];
  if (explicitDoneSignal) {
    return explicitDoneSignal;
  }

  const claudeCounter = text.match(CLAUDE_COUNTER_RE)?.[1];
  return claudeCounter ? `CLAUDE_COUNTER:${claudeCounter}` : null;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;

  return lines.slice(start, end);
}

function extractClaudeResponseTail(text: string): string | null {
  if (!CLAUDE_COUNTER_RE.test(text)) {
    return null;
  }

  const lines = text.split("\n");
  const counterIndex = lines.findIndex((line) => CLAUDE_COUNTER_RE.test(line));
  if (counterIndex === -1) {
    return null;
  }

  let startIndex = 0;
  for (let i = counterIndex - 1; i >= 0; i--) {
    const line = lines[i];
    if (CLAUDE_WORKING_LINE_RE.test(line) || CLAUDE_DONE_LINE_RE.test(line)) {
      startIndex = i + 1;
      break;
    }
  }

  const candidateLines = trimBlankEdges(
    lines
      .slice(startIndex, counterIndex)
      .filter(
        (line) =>
          !/^\s*(?:Token usage:|🤖\s|CLAUDE_COUNTER:)/.test(line) &&
          !/^\s*(?:[⏺●✻✢✳✶]\s+(?:Thinking|Working|Running|Receiving|Preparing|Updating|Sending|Reading|Analyzing))\b/.test(
            line,
          ) &&
          !/^\s{2,}(?:Thinking|Working|Running|Receiving|Preparing|Updating|Sending|Reading|Analyzing)\b/.test(
            line,
          ) &&
          !/^\s*(?:Bash|Read|Edit|Write|Glob|Grep|LS)\(/.test(line) &&
          !/^\s*\/Users\//.test(line),
      ),
  );

  if (candidateLines.length === 0) {
    return null;
  }

  return candidateLines.join("\n");
}

function parseResponse(text: string): string | null {
  const response = text.match(RESPONSE_BLOCK_RE)?.[1]?.trim();
  return response || extractClaudeResponseTail(text);
}

function parseErrors(text: string): string[] {
  const errors: string[] = [];
  const lowered = text.toLowerCase();
  const permissionPatterns = [
    "approve command?",
    "permission denied",
    "permission prompt",
    "do you want to allow",
    "[y/n]",
  ];

  if (permissionPatterns.some((pattern) => lowered.includes(pattern))) {
    errors.push("permission_prompt");
  }

  if (text.includes("SQLITE_BUSY")) {
    errors.push("SQLITE_BUSY");
  }

  for (const match of text.matchAll(EXIT_CODE_RE)) {
    const code = `exit_code:${match[1]}`;
    if (!errors.includes(code)) {
      errors.push(code);
    }
  }

  return errors;
}

function parseModelAndCost(
  text: string,
  agentType: ParsedScreenAgentType,
): { model: string | null; cost: number | null } {
  if (agentType === "codex") {
    const codexMatch = text.match(CODEX_MODEL_RE);
    return {
      model: codexMatch?.[1]?.trim() ?? null,
      cost: null,
    };
  }

  if (agentType === "cursor") {
    return {
      model: parseCursorModel(text),
      cost: null,
    };
  }

  if (agentType === "gemini") {
    return {
      model: text.match(GEMINI_MODEL_RE)?.[1] ?? null,
      cost: null,
    };
  }

  const modelCostMatch = text.match(MODEL_COST_RE);
  if (modelCostMatch) {
    return {
      model: modelCostMatch[1].trim(),
      cost: Number.parseFloat(modelCostMatch[2]),
    };
  }

  // Fallback chain: header spinner → 🤖+version → 🤖+keyword (narrow panes)
  const model =
    text.match(HEADER_MODEL_RE)?.[1]?.trim() ??
    text.match(MODEL_EMOJI_RE)?.[1]?.trim() ??
    text.match(MODEL_KEYWORD_RE)?.[1]?.trim() ??
    null;
  const costMatch = text.match(/💰\s*\$([0-9]+(?:\.[0-9]+)?)/);

  return {
    model,
    cost: costMatch ? Number.parseFloat(costMatch[1]) : null,
  };
}

function parseCodexContextPct(text: string): number | null {
  const match = text.match(CODEX_MODEL_RE);
  return match ? Number.parseInt(match[2], 10) : null;
}

function parseCodexActions(text: string): string[] {
  return Array.from(text.matchAll(CODEX_ACTION_RE), (match) => match[1].trim());
}

function parseCursorScaledTokenCount(raw: string, suffix?: string): number {
  const n = Number.parseFloat(raw.replaceAll(",", ""));
  if (!Number.isFinite(n)) return NaN;
  const s = (suffix ?? "").toLowerCase();
  if (s === "k") return Math.round(n * 1000);
  if (s === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

function parseCursorTokenCount(text: string): number | null {
  const m = text.match(CURSOR_TOKEN_LINE_RE);
  if (!m) return null;
  const value = parseCursorScaledTokenCount(m[1], m[2]);
  return Number.isFinite(value) ? value : null;
}

/** Context % used from the "Auto · 22.5% · …" status strip */
function parseCursorStatusContextPct(text: string): number | null {
  const m = text.match(CURSOR_STATUS_PCT_RE);
  if (!m) return null;
  const pct = Number.parseFloat(m[1]);
  if (!Number.isFinite(pct)) return null;
  return Math.min(100, Math.round(pct));
}

function parseCursorModel(text: string): string | null {
  const labeled =
    text.match(CURSOR_MODEL_LINE_RE)?.[1]?.trim() ??
    text.match(CURSOR_USING_LINE_RE)?.[1]?.trim();
  if (labeled) return labeled;
  const inline = text.match(CURSOR_MODEL_INLINE_RE)?.[0]?.trim();
  return inline ?? null;
}

function parseCursorDoneSignal(text: string): string | null {
  if (CURSOR_SESSION_COMPLETE_RE.test(text)) return "CURSOR_SESSION_COMPLETE";
  if (CURSOR_CHECKMARK_DONE_RE.test(text)) return "CURSOR_SESSION_COMPLETE";
  return null;
}

function inferStatus(
  text: string,
  doneSignal: string | null,
  errors: string[],
  agentType: ParsedScreenAgentType,
): ParsedScreenStatus {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join("\n");

  if (doneSignal) {
    if (doneSignal.startsWith("CLAUDE_COUNTER:")) {
      return "idle";
    }
    return "done";
  }

  if (errors.length > 0) {
    return "frozen";
  }

  if (agentType === "codex" && CODEX_WORKING_RE.test(joined)) {
    return "working";
  }

  if (agentType === "codex" && CODEX_RESUME_RE.test(text)) {
    return "done";
  }

  if (agentType === "cursor") {
    if (CURSOR_HEX_RUNNING_RE.test(text)) {
      return "working";
    }
    if (CURSOR_FOLLOWUP_RE.test(text) || CURSOR_HEX_IDLE_RE.test(text)) {
      return "idle";
    }
    return "idle";
  }

  if (agentType === "claude" && CLAUDE_DONE_LINE_RE.test(text)) {
    return "done";
  }

  if (agentType === "claude" && CLAUDE_WORKING_LINE_RE.test(text)) {
    return "working";
  }

  const workingMarkers = [
    "thinking",
    " /loop",
    "bypass permissions on",
    "esc to interrupt",
  ];
  if (
    workingMarkers.some((marker) =>
      joined.toLowerCase().includes(marker.toLowerCase()),
    )
  ) {
    return "working";
  }

  if (
    agentType === "gemini" &&
    /Gemini CLI/i.test(text) &&
    /Thinking/i.test(text)
  ) {
    return "working";
  }

  if (agentType === "codex" && /(^|\n)\s*codex\s*>\s*$/m.test(text)) {
    return "idle";
  }

  if (/(^|\n)\s*(❯|>>>|\$|>)\s*$/m.test(text)) {
    return "idle";
  }

  return "idle";
}

export function parseScreen(text: string): ParsedScreenResult {
  const normalized = normalizeText(text);
  const agentType = detectAgentType(normalized);
  let doneSignal = parseDoneSignal(normalized);
  if (agentType === "cursor" && doneSignal === null) {
    doneSignal = parseCursorDoneSignal(normalized);
  }
  const errors = parseErrors(normalized);
  const { model, cost } = parseModelAndCost(normalized, agentType);
  let tokenCount = parseTokenCount(normalized);
  if (agentType === "cursor") {
    const cursorTokens = parseCursorTokenCount(normalized);
    if (cursorTokens !== null) {
      tokenCount = cursorTokens;
    }
  }
  const contextWindow = inferContextWindow(model, tokenCount, normalized);

  // Compute context_pct: percentage of context window USED (0=fresh, 100=full)
  // Clamped to [0, 100] — token_count can exceed context_window in practice
  // but >100% is noise for monitoring. For Codex: invert "% left" → "% used".
  // AIDEV-NOTE: For Codex, token_count may be null while context_pct is populated
  // (Codex surfaces show "% left" directly rather than raw token counts).
  // Cursor: prefer the status strip "Auto · 22.5% · …" when present.
  let contextPct: number | null = null;
  if (agentType === "codex") {
    const codexLeft = parseCodexContextPct(normalized);
    contextPct = codexLeft !== null ? 100 - codexLeft : null;
  } else if (agentType === "cursor") {
    contextPct = parseCursorStatusContextPct(normalized);
    if (contextPct === null && tokenCount !== null && contextWindow !== null) {
      contextPct = Math.min(
        100,
        Math.round((tokenCount / contextWindow) * 100),
      );
    }
  } else if (tokenCount !== null && contextWindow !== null) {
    contextPct = Math.min(100, Math.round((tokenCount / contextWindow) * 100));
  }

  const result: ParsedScreenResult = {
    agent_type: agentType,
    status: inferStatus(normalized, doneSignal, errors, agentType),
    token_count: tokenCount,
    context_pct: contextPct,
    context_window: contextWindow,
    done_signal: doneSignal,
    response: parseResponse(normalized),
    errors,
    model,
    cost,
  };

  if (agentType === "codex") {
    result.actions = parseCodexActions(normalized);
  }

  return result;
}
