import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  CLI_INPUT_PROMPT_PREFIXES,
  CLI_READY_PATTERNS,
  lineStartsWithCliInputPrompt,
  matchReadyPattern,
  screenHasActiveAgentMarker,
  type PatternMatch,
} from "../src/pattern-registry.js";

const readFixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

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

describe("CLI_INPUT_PROMPT_PREFIXES", () => {
  it("recognizes typed composer lines for each supported CLI", () => {
    expect(lineStartsWithCliInputPrompt("claude", "❯ Do the task")).toBe(true);
    expect(lineStartsWithCliInputPrompt("codex", "› Do the task")).toBe(true);
    expect(lineStartsWithCliInputPrompt("cursor", "cursor> Do the task")).toBe(
      true,
    );
    expect(lineStartsWithCliInputPrompt("cursor", "→ Do the task")).toBe(true);
    expect(lineStartsWithCliInputPrompt("gemini", "gemini> Do the task")).toBe(
      true,
    );
    expect(lineStartsWithCliInputPrompt("kiro", "kiro> Do the task")).toBe(
      true,
    );
  });

  it("keeps every supported CLI in the input prompt prefix map", () => {
    expect(Object.keys(CLI_INPUT_PROMPT_PREFIXES).sort()).toEqual(
      Object.keys(CLI_READY_PATTERNS).sort(),
    );
  });

  it("does not treat an empty ready prompt as typed composer text", () => {
    expect(lineStartsWithCliInputPrompt("gemini", "> ")).toBe(false);
    expect(lineStartsWithCliInputPrompt("codex", "›")).toBe(false);
  });

  it("does not treat Markdown blockquotes as typed composer text", () => {
    expect(lineStartsWithCliInputPrompt("claude", "> Do the task")).toBe(false);
    expect(lineStartsWithCliInputPrompt("codex", "> Do the task")).toBe(false);
    expect(lineStartsWithCliInputPrompt("gemini", "> Do the task")).toBe(false);
    expect(lineStartsWithCliInputPrompt("kiro", "> Do the task")).toBe(false);
  });
});

describe("matchReadyPattern", () => {
  it("matches Claude ready prompt", () => {
    const result = matchReadyPattern("claude", "What can I help you with?\n>");
    expect(result.matched).toBe(true);
  });

  it("matches modern Claude idle prompt with status footer", () => {
    const result = matchReadyPattern(
      "claude",
      [
        "  Say \"go\" when you're ready and I'll start your timer.",
        "",
        "  CLAUDE_COUNTER: 186",
        "",
        "──────────────────────────────────────────────────────────────────────────",
        "❯",
        "──────────────────────────────────────────────────────────────────────────",
        "  ⎇ master | +1273,-196 | 🔧 11                     418310 tokens",
        "  🤖 …                              current: 2.1.81 · latest…",
        "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
      ].join("\n"),
    );
    expect(result.matched).toBe(true);
  });

  it("matches Claude Code prompt when the old welcome copy is absent", () => {
    const result = matchReadyPattern(
      "claude",
      "Claude Code\n> \nCLAUDE_COUNTER:1\n",
    );
    expect(result.matched).toBe(true);
  });

  it("does not match active Claude work as ready", () => {
    const result = matchReadyPattern("claude", "Claude Code\n✻ Working\n");
    expect(result.matched).toBe(false);
  });

  it("does not match active Claude work even when a stale prompt remains visible", () => {
    const result = matchReadyPattern(
      "claude",
      [
        "Claude Code",
        "✻ Working",
        "  Reading src/server.ts",
        "",
        ">",
        "CLAUDE_COUNTER:1",
      ].join("\n"),
    );
    expect(result.matched).toBe(false);
  });

  it("matches Gemini ready when stale active text is above the current prompt", () => {
    const result = matchReadyPattern(
      "gemini",
      ["Gemini CLI", "Thinking...", "Previous response", ">"].join("\n"),
    );

    expect(result.matched).toBe(true);
  });

  it("does not match Gemini ready when active text follows the prompt", () => {
    const result = matchReadyPattern(
      "gemini",
      ["Gemini CLI", ">", "Thinking..."].join("\n"),
    );

    expect(result.matched).toBe(false);
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

  it("does not treat bare active Codex status lines as ready", () => {
    for (const marker of ["Working", "Waiting for command approval", "Thinking"]) {
      const screen = [
        "gpt-5.5 xhigh · 70% left · ~/Gits/cmuxlayer",
        marker,
        "",
        "›",
      ].join("\n");

      expect(matchReadyPattern("codex", screen).matched).toBe(false);
      expect(screenHasActiveAgentMarker("codex", screen)).toBe(true);
    }
  });

  it("matches modern Codex idle prompt outside ~/Gits", () => {
    const result = matchReadyPattern(
      "codex",
      `

› Explain this codebase

gpt-5.5 xhigh · /workspaces/cmuxlayer
`,
    );
    expect(result.matched).toBe(true);
  });

  it("matches Codex boot panel readiness even when the panel is above the composer", () => {
    const result = matchReadyPattern(
      "codex",
      `
╭──────────────────────────╮
│ OpenAI Codex             │
│ Model: gpt-5.5 xhigh     │
│ Directory: /Users/etanheyman/Gits/voicelayer │
│ Permissions: YOLO        │
╰──────────────────────────╯

›
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

  it("matches Cursor idle status without the legacy cursor prompt", () => {
    const result = matchReadyPattern(
      "cursor",
      `
Auto · 10% · 1 file edited
Model: gpt-5.2 high

⬡ Idle  12,450 tokens

→ Add a follow-up

/ commands · @ files · ! shell · ctrl+r to review edits
`,
    );
    expect(result.matched).toBe(true);
  });

  it("matches Cursor follow-up prompt without an Idle token line", () => {
    const result = matchReadyPattern(
      "cursor",
      `
Auto · 22% · 3 files edited

→ Add a follow-up
ctrl+c to stop

/ commands · @ files · ! shell · ctrl+r to review edits
`,
    );
    expect(result.matched).toBe(true);
  });

  it("matches Cursor Agent v2026.06.04 fresh-boot ready chrome", () => {
    const result = matchReadyPattern(
      "cursor",
      readFixture("cursor-2026-06-04-boot-ready.txt"),
    );

    expect(result).toEqual<PatternMatch>({
      matched: true,
      confidence: "high",
      consecutive: 1,
    });
  });

  it("does not match active Cursor generation as ready", () => {
    const result = matchReadyPattern(
      "cursor",
      `
Auto · 22.5% · 4 files edited

⬡ Running...  3.3k tokens

→ Add a follow-up
ctrl+c to stop

/ commands · @ files · ! shell · ctrl+r to review edits
`,
    );
    expect(result.matched).toBe(false);
  });

  it("does not match live Cursor thinking chrome with braille spinner and Auto footer", () => {
    const result = matchReadyPattern(
      "cursor",
      `
 ⠠⠛ Thinking  5.71k tokens
    Tip: Use /debug to instrument and debug complex problems.
  Auto · 20.5% · 4 files edited                    Auto-run
`,
    );
    expect(result.matched).toBe(false);
  });

  it("does not match Cursor spinner work without a token count as ready", () => {
    const result = matchReadyPattern(
      "cursor",
      `
 ⠸ Generating...
  Auto · 20.5% · 4 files edited                    Auto-run
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
