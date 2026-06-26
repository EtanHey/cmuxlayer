/**
 * Per-CLI ready pattern registry.
 * High-confidence patterns match immediately.
 * Low-confidence patterns require consecutive matches to prevent false positives.
 */

import type { CliType } from "./agent-types.js";
import { parseScreen } from "./screen-parser.js";
import type { ParsedScreenResult } from "./types.js";

export interface ReadyPattern {
  pattern: RegExp;
  confidence: "high" | "low";
  consecutive: number;
}

export interface PatternMatch {
  matched: boolean;
  confidence: "high" | "low";
  consecutive: number;
}

const CLAUDE_READY_RE =
  /What can I help you with\?|╭─|(?=[\s\S]*(?:Claude Code|CLAUDE_COUNTER|bypass permissions on|🤖))(?=[\s\S]*(?:^|\n)\s*(?:>|❯)\s*$)/m;
const CLAUDE_ACTIVE_RE =
  /(?:^|\n)\s*(?:[✻✢✳✶]|[⏺●])\s+(?:Thinking|Working|Running|Receiving|Preparing|Updating|Sending|Reading|Analyzing)\b/im;

const CURSOR_ACTIVE_RE =
  /(?:^|\n)[^\S\r\n]*(?:(?:[⠀-⣿]+|⬢|⬡|•)[^\S\r\n]*)?(?:Calling|Editing|Reading|Writing|Searching|Planning|Running|Generating|Thinking|Waiting)\b(?:\.\.\.|…)?(?:[^\S\r\n]+[0-9][0-9,]*(?:\.[0-9]+)?[km]?[^\S\r\n]+tokens\b|[^\S\r\n]*(?=\r?(?:\n|$)))/i;
const CURSOR_READY_RE = new RegExp(
  [
    String.raw`cursor>`,
    String.raw`⬡\s+Idle\b`,
    String.raw`→\s*Add a follow-up`,
    String.raw`\/ commands · @ files · ! shell`,
    String.raw`(?:^|\n)\s*(?:Auto|Agent)\s*·\s*\d+(?:\.\d+)?\s*%\s*·[^\n]*files? edited\b`,
    String.raw`(?=[\s\S]*(?:^|\n)\s*Cursor Agent\s*(?:\n|$))(?=[\s\S]*(?:^|\n)\s*(?:v20\d{2}\.\d{2}\.\d{2}-[a-f0-9]+|Use\s+\/plan to iterate\b|→\s+Plan, search, build anything|Auto(?:\s*·\s*\d+(?:\.\d+)?\s*%)?)\s*(?:\n|$))`,
    String.raw`(?=[\s\S]*(?:^|\n)\s*→\s+Plan, search, build anything\s*(?:\n|$))(?=[\s\S]*(?:^|\n)\s*Auto(?:\s*·\s*\d+(?:\.\d+)?\s*%)?\s*(?:\n|$))`,
  ].join("|"),
  "i",
);
const CODEX_READY_RE = new RegExp(
  [
    String.raw`codex>`,
    String.raw`^(?![\s\S]*(?:Working \(|•\s*(?:Working|Waiting|Thinking)))[\s\S]*(?:^|\n)\s*›[^\n]*(?:\n|$)[\s\S]*\bgpt-\d[\w.-]*(?:\s+\w+)?\s*·[^\n]+`,
    String.raw`^(?![\s\S]*(?:Working \(|•\s*(?:Working|Waiting|Thinking)))[\s\S]*(?:^|\n)[^\n]*\bOpenAI\s+Codex\b[^\n]*(?:\n|$)[\s\S]*(?:^|\n)[^\n]*\b(?:Model|model)\s*:?\s*gpt-\d[\w.-]*(?:\s+\w+)?\b[^\n]*(?:\n|$)[\s\S]*(?:^|\n)\s*›[^\n]*(?:\n|$)`,
  ].join("|"),
  "im",
);
const CODEX_ACTIVE_RE = /(?:^|\n)\s*(?:•\s*)?(?:Working|Waiting|Thinking)\b|Working\s*\(/i;

export const CLI_READY_PATTERNS: Record<CliType, ReadyPattern> = {
  claude: {
    pattern: CLAUDE_READY_RE,
    confidence: "high",
    consecutive: 1,
  },
  codex: {
    pattern: CODEX_READY_RE,
    confidence: "high",
    consecutive: 1,
  },
  gemini: {
    pattern: /^>\s*$/m,
    confidence: "low",
    consecutive: 2,
  },
  kiro: {
    pattern: /kiro>|^>\s*$/m,
    confidence: "low",
    consecutive: 2,
  },
  cursor: {
    pattern: CURSOR_READY_RE,
    confidence: "high",
    consecutive: 1,
  },
};

export function matchReadyPattern(
  cli: CliType,
  screenContent: string,
): PatternMatch {
  const entry = CLI_READY_PATTERNS[cli];
  if (!entry) {
    return { matched: false, confidence: "low", consecutive: 1 };
  }
  return {
    matched:
      entry.pattern.test(screenContent) &&
      (cli !== "claude" || !CLAUDE_ACTIVE_RE.test(screenContent)) &&
      (cli !== "codex" || !CODEX_ACTIVE_RE.test(screenContent)) &&
      (cli !== "cursor" || !CURSOR_ACTIVE_RE.test(screenContent)),
    confidence: entry.confidence,
    consecutive: entry.consecutive,
  };
}

export function screenHasActiveAgentMarker(
  cli: CliType,
  screenText: string,
  parsed: ParsedScreenResult = parseScreen(screenText),
): boolean {
  if (parsed.status === "working" || parsed.status === "thinking") {
    return true;
  }

  switch (cli) {
    case "claude":
      return CLAUDE_ACTIVE_RE.test(screenText);
    case "codex":
      return CODEX_ACTIVE_RE.test(screenText);
    case "cursor":
      return CURSOR_ACTIVE_RE.test(screenText);
    case "gemini":
      return /(?:^|\n)\s*(?:✦\s*)?Working(?:\.\.\.|…)?\s*$/im.test(
        screenText,
      );
    case "kiro":
      return false;
  }
}

export function screenHasReadyAgentIdentity(
  cli: CliType,
  screenText: string,
  parsed: ParsedScreenResult = parseScreen(screenText),
): boolean {
  if (parsed.agent_type === cli) {
    return true;
  }

  switch (cli) {
    case "claude":
      return /Claude Code|CLAUDE_COUNTER|bypass permissions on|What can I help you with\?/i.test(
        screenText,
      );
    case "codex":
      return (
        /(?:^|\n)\s*codex>\s*$/im.test(screenText) ||
        parsed.agent_type === "codex" ||
        /(?:^|\n)\s*OpenAI\s+Codex\s*(?:\n|$)/i.test(screenText)
      );
    case "cursor":
      return /(?:^|\n)\s*(?:cursor>|Cursor Agent)\s*$/im.test(screenText);
    case "kiro":
      return /(?:^|\n)\s*kiro>\s*$/im.test(screenText);
    case "gemini":
      return false;
  }
}

export function readyPatternRequiresAgentIdentity(cli: CliType): boolean {
  return cli !== "gemini" && cli !== "kiro";
}
