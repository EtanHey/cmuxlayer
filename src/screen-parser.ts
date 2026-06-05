import type {
  ParsedScreenAgentType,
  ParsedScreenResult,
  ParsedScreenStatus,
} from "./types.js";

// AIDEV-NOTE: DEFAULT context window sizes per model family. Verified numbers (researcher,
// BrainLayer brainbar-8a3da79c-159, 2026-06-04) — do NOT guess/round. This is the SCREEN-PARSER
// FALLBACK only: when the harness JSONL is available it carries the real per-session window
// (esp. Codex's model_context_window) and supersedes this table — see harness-session.ts +
// docs/harness-jsonl-field-map.md. All Claude models default to 200K; the 1M tier is detected
// via "(1M" suffix or token_count > 200K (Claude-only — it's the Claude Max/standard tier).
// ORDER MATTERS: resolveModelMax uses substring matching — longer keys must come first.
export const MODEL_MAX_TOKENS: Record<string, number> = {
  // Claude models — ALL default to 200K (1M is the Max-plan/standard tier, detected separately)
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  // OpenAI GPT-5 / Codex family — 400K TOTAL window (272K input + 128K output). NOT 1M.
  "gpt-5": 400_000,
  // OpenAI GPT-4 family (gpt-4o, gpt-4-turbo)
  "gpt-4": 128_000,
  // Google Gemini 2.x / 3.x — 1,048,576 (not a round 1M, not 2M)
  "gemini-3": 1_048_576,
  "gemini-2": 1_048_576,
  "gemini-1": 1_048_576,
};

/** True for Claude model strings — the only family with the 200K→1M tier transition. */
function isClaudeModel(model: string | null): boolean {
  if (!model) return false;
  return /opus|sonnet|haiku|claude/i.test(model);
}

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
 * 1. Explicit "(1M" in screen text → 1M (Claude Max/standard tier confirmed)
 * 2. CLAUDE-ONLY: token_count > 200K default → 1M (Claude's only larger tier). Non-Claude
 *    models have FIXED windows (gpt-5=400K, gemini=1.048M, gpt-4=128K) and must NOT be bumped.
 * 3. Fall back to resolveModelMax() default.
 * NOTE: this is the FALLBACK path; harness-session.ts (JSONL) carries the real per-session
 * window when available and should be preferred by callers.
 */
export function inferContextWindow(
  model: string | null,
  tokenCount: number | null,
  rawText: string,
): number | null {
  // Signal 1: explicit "(1M" in the status line (Claude's "(1M context)" marker) wins even
  // if model parsing fails. CASE-SENSITIVE uppercase M on purpose: Codex's working timer
  // "(1m 12s • esc to interrupt)" uses lowercase m and must NOT be read as a 1M window.
  if (/\(1M\b/.test(rawText)) return 1_000_000;

  const defaultMax = resolveModelMax(model);
  const looksLikeClaudePane =
    /CLAUDE_COUNTER|bypass permissions on|Claude Code|🤖/i.test(rawText);
  if (defaultMax === null) {
    if (looksLikeClaudePane && tokenCount !== null) {
      return tokenCount > 200_000 ? 1_000_000 : 200_000;
    }
    return null;
  }

  // Signal 2: Claude-only 200K→1M upgrade. A Claude pane can't exceed 200K on the base tier,
  // so more tokens means the Max/standard 1M tier. Non-Claude windows are fixed — no bump.
  if (
    (isClaudeModel(model) || looksLikeClaudePane) &&
    tokenCount !== null &&
    tokenCount > defaultMax
  ) {
    return 1_000_000;
  }

  return defaultMax;
}

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const DONE_SIGNAL_LINE_RE =
  /^\s*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_DONE)(?:\s+\S{1,16})?\s*$/;
const CLAUDE_COUNTER_RE = /^\s*CLAUDE_COUNTER:\s*(\d+)\s*$/m;
const RESPONSE_BLOCK_RE = /---RESPONSE_START---\s*(.*?)\s*---RESPONSE_END---/s;
const TOKEN_USAGE_RE = /Token usage:\s*total=([0-9][0-9,]*)/i;
// Match standalone token counts in footer/status lines, not prose.
// Valid: "418310 tokens" (standalone) or "  🤖 ... 418310 tokens" (right-aligned)
// Invalid: "I only have 42 tokens" (prose sentence)
// Pattern requires either: (1) line starts with optional whitespace + number, or
// (2) at least 2 spaces before the number (right-aligned footer indicator)
const TOKENS_RE = /(?:^\s*|.*\s{2,})([0-9][0-9,]*)\s+tokens\s*$/im;
const MODEL_COST_RE = /🤖\s*([^|\n]+?)\s*\|\s*💰\s*\$([0-9]+(?:\.[0-9]+)?)/i;
const HEADER_MODEL_RE =
  /^\s*[▝▜▛▘▐].*?\b((?:Opus|Sonnet|Haiku|GPT|Claude)\s+[0-9][^(\n·|]*)/m;
// Fallback: 🤖 + model name + version, without requiring cost or pipe
const MODEL_EMOJI_RE =
  /🤖\s*((?:Opus|Sonnet|Haiku|GPT|Claude)\s+[0-9][0-9.]*)/i;
// Last resort: 🤖 + bare model family name (for narrow panes where version is cut off)
const MODEL_KEYWORD_RE = /🤖\s*(Opus|Sonnet|Haiku)\b/i;
const EXIT_CODE_RE = /(?:exit(?:ed)?\s+with\s+code|code)\s+(\d+)/gi;
const CODEX_HEADER_RE =
  /^\s*(gpt-[0-9][0-9a-z.-]*(?:\s+\w+)?)(?:\s*[·•]\s*[^\n]*)?\s*$/m;
const CODEX_CONTEXT_LEFT_RE =
  /^\s*gpt-[0-9][0-9a-z.-]*(?:\s+\w+)?\s*[·•]\s*(\d+)%\s+left(?:\s*[·•]\s*[^\n]*)?\s*$/m;
const CODEX_WORKING_RE =
  /Working\s*\(([0-9]+m\s*[0-9]+s)\s*[•·]\s*esc to interrupt\)/i;
const CODEX_RESUME_RE = /To continue this session,\s*run\s+codex\s+resume/i;
const CODEX_ACTION_RE = /^\s*[•·]\s+(.+)$/gm;
const GEMINI_MODEL_RE =
  /(?:^|\n)\s*(?:-\s*)?(?:Model:\s*)?(gemini-[0-9][0-9a-z.-]*)\b/im;
const GEMINI_WORKING_RE = /^\s*(?:✦\s*)?Working(?:\.\.\.|…)?\s*$/im;
const CLAUDE_DONE_LINE_RE = /^\s*[⏺●]\s+Completed(?: successfully)?\s*$/im;
const CLAUDE_WORKING_LINE_RE =
  /^\s*(?:[✻✢✳✶]|[⏺●])\s+(?:Thinking|Working|Running|Receiving|Preparing|Updating|Sending|Reading|Analyzing)\b/im;
const THINKING_RE =
  /(?:^|\n)\s*(?:(?:[✻✢✳✶]\s*)?thinking(?:\s+with\s+[a-z-]+\s+effort)?(?:\s*(?:\.{3,}|…))?|(?:Reticulating splines|Perambulating|Cooked|Crunched|Razzmatazzing|Schlepping|Nucleating|Seasoning)(?:\s*(?:\.{3,}|…))?|(?:⬡\s*)?(?:Running|Generating)(?:\s*(?:\.{3,}|…))?\s+[0-9][0-9,]*(?:\.[0-9]+)?[km]?\s+tokens)\s*$/im;

/** Cursor Agent CLI — mode bar, hex status, context strip, follow-up prompt */
const CURSOR_AGENT_BANNER_RE = /(?:^|\n)\s*Cursor Agent\s*(?:\n|$)/i;
const CURSOR_VERSION_RE =
  /(?:^|\n)\s*v20\d{2}\.\d{2}\.\d{2}-[a-f0-9]+\s*(?:\n|$)/i;
const CURSOR_PLAN_HINT_RE = /\bUse\s+\/plan\s+to iterate\b/i;
const CURSOR_COMPOSER_RULE_RE = /(?:^|\n)\s*[▄▀]{12,}\s*(?:\n|$)/;
const CURSOR_COMPOSER_LINE_RE =
  /(?:^|\n)\s*→\s+(?:Plan, search, build anything|[^\n]+)\s*(?:\n|$)/;
const CURSOR_AUTO_FOOTER_RE =
  /(?:^|\n)\s*Auto(?:\s*·\s*\d+(?:\.\d+)?\s*%)?(?:\s*·[^\n]*)?\s*(?:\n|$)/i;
const CURSOR_CWD_FOOTER_RE =
  /(?:^|\n)\s*(?:~|\/)[^\n]*\s+·\s+[^\n]+\s*(?:\n|$)/;
const CURSOR_MODE_BAR_RE =
  /\/ commands · @ files · ! shell · ctrl\+r to review edits/i;
const CURSOR_HEX_RUNNING_RE = /⬡\s+Running\.\.\./i;
const CURSOR_HEX_IDLE_RE = /⬡\s+Idle\b/i;
const CURSOR_TOKEN_LINE_RE =
  /⬡\s+(?:Running\.\.\.|Idle)\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*([km])?\s*tokens\b/i;
const CURSOR_ACTIVITY_TOKEN_RE =
  /(?:^|\n)\s*(?:⬢|⬡|•)?\s*(?:Calling|Editing|Reading|Writing|Searching|Planning|Running|Generating)\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s*([km])?\s*tokens\b/im;
const CURSOR_STATUS_PCT_RE =
  /(?:^|\n)\s*(?:Auto|Agent)\s*·\s*(\d+(?:\.\d+)?)\s*%(?:\s*·|\s*(?:\n|$))/i;
const CURSOR_FOLLOWUP_RE = /→\s*Add a follow-up/i;
const CURSOR_STOP_RE = /ctrl\+c to stop/i;
const CURSOR_SESSION_COMPLETE_RE =
  /^\s*(?:Task completed|Generation complete|All edits applied|Session complete)\s*$/i;
const CURSOR_CHECKMARK_DONE_RE =
  /^\s*[✓✔]\s*(?:Done|Complete|Completed)\s*[.!]?\s*$/i;
const CURSOR_MODEL_LINE_RE = /^\s*Model:\s*(.+)$/im;
const CURSOR_USING_LINE_RE = /^\s*Using\s*:?\s*(.+)$/im;
const CURSOR_MODEL_INLINE_RE =
  /\b(claude-[0-9][0-9a-z.-]*|gpt-[0-9][0-9a-z.-]*(?:\s+(?:high|low|mini))?|gemini-[0-9][0-9a-z.-]*)\b/i;
const RULE_LINE_RE = /^[\s─-╿▀-▟\-=_~·•—–]+$/;

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
  if (
    CURSOR_AGENT_BANNER_RE.test(text) &&
    (CURSOR_VERSION_RE.test(text) ||
      CURSOR_PLAN_HINT_RE.test(text) ||
      (CURSOR_COMPOSER_RULE_RE.test(text) &&
        CURSOR_COMPOSER_LINE_RE.test(text)) ||
      CURSOR_AUTO_FOOTER_RE.test(text))
  ) {
    return true;
  }
  if (
    CURSOR_COMPOSER_RULE_RE.test(text) &&
    CURSOR_COMPOSER_LINE_RE.test(text) &&
    CURSOR_AUTO_FOOTER_RE.test(text) &&
    CURSOR_CWD_FOOTER_RE.test(text)
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
    CODEX_HEADER_RE.test(text) ||
    CODEX_WORKING_RE.test(text) ||
    CODEX_RESUME_RE.test(text)
  ) {
    return "codex";
  }

  if (/Gemini CLI/i.test(text)) {
    return "gemini";
  }
  if (GEMINI_MODEL_RE.test(text) && !CODEX_HEADER_RE.test(text)) {
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
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const explicitDoneSignal = line.match(DONE_SIGNAL_LINE_RE)?.[1];
    if (explicitDoneSignal) {
      if (isUnsafeDoneSignalContext(lines, i)) {
        return null;
      }
      return explicitDoneSignal;
    }

    const claudeCounter = line.match(CLAUDE_COUNTER_RE)?.[1];
    if (claudeCounter) {
      return `CLAUDE_COUNTER:${claudeCounter}`;
    }

    if (isDoneSignalTailChromeLine(line, lines, i)) {
      continue;
    }

    break;
  }

  return null;
}

function isUnsafeDoneSignalContext(lines: string[], index: number): boolean {
  const immediateTail = lines.slice(Math.max(0, index - 3), index);
  const immediateText = immediateTail.join("\n");
  const hasPostDoneCursorComposer = hasCursorComposerAfterDoneSignal(
    lines,
    index,
  );

  if (
    CODEX_WORKING_RE.test(immediateText) ||
    CLAUDE_WORKING_LINE_RE.test(immediateText) ||
    THINKING_RE.test(immediateText) ||
    CURSOR_HEX_RUNNING_RE.test(immediateText) ||
    GEMINI_WORKING_RE.test(immediateText)
  ) {
    return true;
  }

  return immediateTail.some((line) =>
    isUnsafeDoneSignalContextLine(line, hasPostDoneCursorComposer),
  );
}

function isEchoedPromptContextLine(line: string): boolean {
  const hasDoneToken = /\b[A-Z][A-Z0-9_]*_DONE\b/.test(line);
  const hasInstructionVerb = /\b(?:print|emit|write|respond)\b/i.test(line);

  if (
    /^\s*(?:→|>|[│┃║])\s+/.test(line) ||
    /^\s*(?:╭|╰|┌|└|├|┬|┴|┼)/.test(line)
  ) {
    return true;
  }

  return (
    (hasInstructionVerb && hasDoneToken) ||
    (/\bwhen\b.*\bcomplete\b/i.test(line) &&
      (hasInstructionVerb || hasDoneToken || /\bdone signal\b/i.test(line))) ||
    (/\bon its own line\b/i.test(line) &&
      (hasInstructionVerb || hasDoneToken || /\bdone signal\b/i.test(line))) ||
    (/\bdone signal\b/i.test(line) && (hasInstructionVerb || hasDoneToken))
  );
}

function isUnsafeDoneSignalContextLine(
  line: string,
  hasPostDoneCursorComposer: boolean,
): boolean {
  if (!isEchoedPromptContextLine(line)) return false;

  // Cursor v2026 can leave the submitted task text in the transcript above the
  // real output line, then render a fresh composer below. That transcript line
  // is safe; actual composer/box lines before a done token remain unsafe.
  if (hasPostDoneCursorComposer && !isComposerLine(line)) {
    return false;
  }

  return true;
}

function hasCursorComposerAfterDoneSignal(
  lines: string[],
  index: number,
): boolean {
  const tail = lines.slice(index + 1).join("\n");
  return (
    CURSOR_COMPOSER_RULE_RE.test(tail) &&
    CURSOR_COMPOSER_LINE_RE.test(tail) &&
    CURSOR_AUTO_FOOTER_RE.test(tail)
  );
}

function isComposerLine(line: string): boolean {
  return (
    /^\s*(?:→|>|[│┃║])\s+/.test(line) ||
    /^\s*(?:╭|╰|┌|└|├|┬|┴|┼)/.test(line)
  );
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
    const codexMatch = text.match(CODEX_HEADER_RE);
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
  const match = text.match(CODEX_CONTEXT_LEFT_RE);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
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
  const m =
    text.match(CURSOR_TOKEN_LINE_RE) ?? text.match(CURSOR_ACTIVITY_TOKEN_RE);
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
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (CURSOR_SESSION_COMPLETE_RE.test(line)) return "CURSOR_SESSION_COMPLETE";
    if (CURSOR_CHECKMARK_DONE_RE.test(line)) return "CURSOR_SESSION_COMPLETE";
    if (isDoneSignalTailChromeLine(line, lines, i)) continue;
    break;
  }

  return null;
}

function isDoneSignalTailChromeLine(
  line: string,
  lines: string[] = [line],
  index = 0,
): boolean {
  const hasCursorContext = hasCursorChromeContext(lines);

  return (
    RULE_LINE_RE.test(line) ||
    TOKEN_USAGE_RE.test(line) ||
    TOKENS_RE.test(line) ||
    /^🤖\s/.test(line) ||
    /^⎇\s/.test(line) ||
    /^\s*(?:❯|>>>|\$|>)\s*$/.test(line) ||
    /bypass permissions on/i.test(line) ||
    CURSOR_MODE_BAR_RE.test(line) ||
    CURSOR_FOLLOWUP_RE.test(line) ||
    CURSOR_STOP_RE.test(line) ||
    (hasCursorContext && CURSOR_STATUS_PCT_RE.test(line)) ||
    (hasCursorContext && CURSOR_AUTO_FOOTER_RE.test(line)) ||
    (hasCursorContext && CURSOR_CWD_FOOTER_RE.test(line)) ||
    (hasCursorContext && isCursorComposerTailLine(line, lines, index)) ||
    CURSOR_HEX_IDLE_RE.test(line)
  );
}

function hasCursorChromeContext(lines: string[]): boolean {
  const text = lines.join("\n");
  return (
    CURSOR_AGENT_BANNER_RE.test(text) ||
    CURSOR_MODE_BAR_RE.test(text) ||
    CURSOR_FOLLOWUP_RE.test(text) ||
    (CURSOR_COMPOSER_RULE_RE.test(text) && CURSOR_COMPOSER_LINE_RE.test(text))
  );
}

function isCursorComposerTailLine(
  line: string,
  lines: string[],
  index: number,
): boolean {
  if (!CURSOR_COMPOSER_LINE_RE.test(line)) return false;
  const tail = lines.slice(index).join("\n");
  return CURSOR_COMPOSER_RULE_RE.test(tail) && CURSOR_AUTO_FOOTER_RE.test(tail);
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

  if (THINKING_RE.test(text)) {
    return "thinking";
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

  if (agentType === "gemini" && GEMINI_WORKING_RE.test(text)) {
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

// AIDEV-NOTE: read_screen leanness — strip the terminal chrome that bloats output without
// adding signal: box-drawing rule/separator lines and per-harness status-bar art. Returns
// the last `maxLines` of meaningful content. The structured fields (status/tokens/ctx/response)
// already carry the real signal; this is only for a compact human-readable screen preview.
const CHROME_LINE_RES: RegExp[] = [
  /🤖|💰|⏱/, // model/cost/timer status line
  /esc to interrupt/i,
  /bypass permissions on/i,
  /\d+%\s+left\b/i, // Codex context footer
  /(?:^|\s)(?:Auto|Agent)\s*·\s*\d/i, // Cursor status strip
  /→\s*Add a follow-up/i,
  /ctrl\+c to stop/i,
  /ctrl\+r to review edits/i,
  /\/ commands · @ files/i,
  /^[⬡⬢✻✢✳✶●⏺]\s/, // spinner/status glyphs at line start
];

/**
 * Compact, de-chromed screen preview: drops box-drawing rule lines and status-bar art,
 * collapses blank runs, and returns the last `maxLines` meaningful lines. Used by read_screen
 * for a lean default view (full raw text is available via raw=true).
 */
export function cleanScreenText(text: string, maxLines = 8): string {
  const out: string[] = [];
  for (const rawLine of normalizeText(text).split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (RULE_LINE_RE.test(trimmed)) continue;
    if (CHROME_LINE_RES.some((re) => re.test(trimmed))) continue;
    out.push(line);
  }
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.slice(-maxLines).join("\n");
}
