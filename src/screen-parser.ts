import type { ParsedScreenAgentType, ParsedScreenResult, ParsedScreenStatus } from "./types.js";

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const DONE_SIGNAL_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_DONE)\b/;
const RESPONSE_BLOCK_RE =
  /---RESPONSE_START---\s*(.*?)\s*---RESPONSE_END---/s;
const TOKEN_USAGE_RE = /Token usage:\s*total=([0-9][0-9,]*)/i;
const TOKENS_RE = /\b([0-9][0-9,]*)\s+tokens\b/i;
const MODEL_COST_RE = /🤖\s*([^|\n]+?)\s*\|\s*💰\s*\$([0-9]+(?:\.[0-9]+)?)/i;
const HEADER_MODEL_RE =
  /^\s*[▝▜▛▘▐].*?\b((?:Opus|Sonnet|Haiku|GPT|Claude)\s+[0-9][^(\n·|]*)/m;
const EXIT_CODE_RE = /(?:exit(?:ed)?\s+with\s+code|code)\s+(\d+)/gi;
const CODEX_MODEL_RE =
  /^(gpt-[0-9][0-9a-z.-]*(?:\s+\w+)?)\s*[·•]\s*(\d+)%\s+left/m;
const CODEX_WORKING_RE =
  /Working\s*\(([0-9]+m\s*[0-9]+s)\s*[•·]\s*esc to interrupt\)/i;
const CODEX_RESUME_RE = /To continue this session,\s*run\s+codex\s+resume/i;
const CODEX_ACTION_RE =
  /^\s*[•·]\s+(.+)$/gm;
const GEMINI_MODEL_RE =
  /(?:^|\n)\s*(?:Model:\s*)?(gemini-[0-9][0-9a-z.-]*)\b/im;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function normalizeText(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  if (HEADER_MODEL_RE.test(text)) {
    return "claude";
  }

  if (CODEX_MODEL_RE.test(text) || CODEX_WORKING_RE.test(text) || CODEX_RESUME_RE.test(text)) {
    return "codex";
  }

  if (/Gemini CLI/i.test(text)) {
    return "gemini";
  }
  if (GEMINI_MODEL_RE.test(text) && !CODEX_MODEL_RE.test(text)) {
    return "gemini";
  }

  return "unknown";
}

function parseTokenCount(text: string): number | null {
  const usageMatch = text.match(TOKEN_USAGE_RE);
  if (usageMatch) {
    return Number.parseInt(usageMatch[1].replaceAll(",", ""), 10);
  }

  const tokensMatch = text.match(TOKENS_RE);
  if (tokensMatch) {
    return Number.parseInt(tokensMatch[1].replaceAll(",", ""), 10);
  }

  return null;
}

function parseDoneSignal(text: string): string | null {
  return text.match(DONE_SIGNAL_RE)?.[1] ?? null;
}

function parseResponse(text: string): string | null {
  const response = text.match(RESPONSE_BLOCK_RE)?.[1]?.trim();
  return response || null;
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

  const model = text.match(HEADER_MODEL_RE)?.[1]?.trim() ?? null;
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

  const workingMarkers = [
    "✻",
    "⏺",
    "thinking",
    "working",
    "receiving ",
    " /loop",
    "bypass permissions on",
    "esc to interrupt",
    "running",
  ];
  if (workingMarkers.some((marker) => joined.toLowerCase().includes(marker.toLowerCase()))) {
    return "working";
  }

  if (agentType === "gemini" && /Gemini CLI/i.test(text) && /Thinking/i.test(text)) {
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
  const doneSignal = parseDoneSignal(normalized);
  const errors = parseErrors(normalized);
  const { model, cost } = parseModelAndCost(normalized, agentType);

  const result: ParsedScreenResult = {
    agent_type: agentType,
    status: inferStatus(normalized, doneSignal, errors, agentType),
    token_count: parseTokenCount(normalized),
    done_signal: doneSignal,
    response: parseResponse(normalized),
    errors,
    model,
    cost,
  };

  if (agentType === "codex") {
    result.context_pct = parseCodexContextPct(normalized);
    result.actions = parseCodexActions(normalized);
  }

  return result;
}
