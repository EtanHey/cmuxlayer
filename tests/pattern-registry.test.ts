import { describe, it, expect } from "vitest";
import {
  CLI_READY_PATTERNS,
  matchReadyPattern,
  type PatternMatch,
} from "../src/pattern-registry.js";

describe("CLI_READY_PATTERNS", () => {
  it("has entries for all supported CLIs", () => {
    expect(CLI_READY_PATTERNS).toHaveProperty("claude");
    expect(CLI_READY_PATTERNS).toHaveProperty("codex");
    expect(CLI_READY_PATTERNS).toHaveProperty("gemini");
    expect(CLI_READY_PATTERNS).toHaveProperty("kiro");
    expect(CLI_READY_PATTERNS).toHaveProperty("cursor");
  });

  it("each entry has pattern, confidence, and consecutive fields", () => {
    for (const [cli, entry] of Object.entries(CLI_READY_PATTERNS)) {
      expect(entry.pattern, `${cli} missing pattern`).toBeInstanceOf(RegExp);
      expect(["high", "low"], `${cli} invalid confidence`).toContain(
        entry.confidence,
      );
      expect(typeof entry.consecutive, `${cli} missing consecutive`).toBe(
        "number",
      );
    }
  });

  it("high-confidence patterns require 1 consecutive match", () => {
    for (const [cli, entry] of Object.entries(CLI_READY_PATTERNS)) {
      if (entry.confidence === "high") {
        expect(entry.consecutive, `${cli} high-confidence should need 1`).toBe(
          1,
        );
      }
    }
  });

  it("low-confidence patterns require 2+ consecutive matches", () => {
    for (const [cli, entry] of Object.entries(CLI_READY_PATTERNS)) {
      if (entry.confidence === "low") {
        expect(
          entry.consecutive,
          `${cli} low-confidence should need >=2`,
        ).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("matchReadyPattern", () => {
  it("matches Claude ready prompt", () => {
    const result = matchReadyPattern("claude", "What can I help you with?\n>");
    expect(result.matched).toBe(true);
  });

  it("matches Codex ready prompt", () => {
    const result = matchReadyPattern("codex", "codex> ");
    expect(result.matched).toBe(true);
  });

  it("matches modern Codex empty prompt with model footer", () => {
    const result = matchReadyPattern(
      "codex",
      `

›

gpt-5.5 xhigh · ~/Gits/brainlayer
`,
    );
    expect(result.matched).toBe(true);
  });

  it("matches modern Codex placeholder prompt with model footer", () => {
    const result = matchReadyPattern(
      "codex",
      `

› Implement {feature}

gpt-5.5 xhigh · ~/Gits/brainlayer
`,
    );
    expect(result.matched).toBe(true);
  });

  it("matches modern Codex skills hint prompt with model footer", () => {
    const result = matchReadyPattern(
      "codex",
      `

› Use /skills to list available

gpt-5.5 xhigh · ~/Gits/brainlayer
`,
    );
    expect(result.matched).toBe(true);
  });

  it("matches modern Codex explain-codebase prompt with model footer", () => {
    const result = matchReadyPattern(
      "codex",
      `

› Explain this codebase

gpt-5.5 xhigh · ~/Gits/brainlayer
`,
    );
    expect(result.matched).toBe(true);
  });

  it("matches modern Codex arbitrary idle suggestion prompt with model footer", () => {
    const result = matchReadyPattern(
      "codex",
      `

› Find and fix a bug in @filename

gpt-5.5 xhigh · ~/Gits/brainlayer
`,
    );
    expect(result.matched).toBe(true);
  });

  it("does not match modern Codex while it is working on a queued prompt", () => {
    const result = matchReadyPattern(
      "codex",
      `
• Working (10m 57s • esc to interrupt)

› Find and fix a bug in @filename

gpt-5.5 xhigh · ~/Gits/brainlayer
`,
    );
    expect(result.matched).toBe(false);
  });

  it("does not match unrelated output", () => {
    const result = matchReadyPattern("claude", "Installing dependencies...");
    expect(result.matched).toBe(false);
  });

  it("returns confidence level in the result", () => {
    const result = matchReadyPattern("claude", "What can I help you with?");
    expect(result.confidence).toBe("high");
  });

  it("returns consecutive requirement in the result", () => {
    const result = matchReadyPattern("gemini", "> ");
    expect(result.consecutive).toBeGreaterThanOrEqual(2);
  });

  it("handles unknown CLI gracefully", () => {
    const result = matchReadyPattern("unknown-cli" as any, "some output");
    expect(result.matched).toBe(false);
  });
});
