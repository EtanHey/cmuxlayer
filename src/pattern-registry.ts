/**
 * Per-CLI ready pattern registry.
 * High-confidence patterns match immediately.
 * Low-confidence patterns require consecutive matches to prevent false positives.
 */

import type { CliType } from "./agent-types.js";

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

export const CLI_READY_PATTERNS: Record<CliType, ReadyPattern> = {
  claude: {
    pattern: /What can I help you with\?|╭─/,
    confidence: "high",
    consecutive: 1,
  },
  codex: {
    pattern: /codex>/,
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
    pattern: /cursor>/,
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
    matched: entry.pattern.test(screenContent),
    confidence: entry.confidence,
    consecutive: entry.consecutive,
  };
}
