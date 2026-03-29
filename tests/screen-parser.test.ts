import { describe, expect, it } from "vitest";
import {
  parseScreen,
  MODEL_MAX_TOKENS,
  resolveModelMax,
  inferContextWindow,
} from "../src/screen-parser.js";

describe("parseScreen", () => {
  it("parses Claude-style output with response block and done signal", () => {
    const parsed = parseScreen(`
\u001b[32m⏺ Completed successfully\u001b[0m
---RESPONSE_START---
Line one
Line two
---RESPONSE_END---
ENRICHMENT_PROMPT_DONE
Token usage: total=12,345 input=10,000 output=2,345
🤖 Sonnet 4.6 | 💰 $7.73 | ⏱️  9hr 58m
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.status).toBe("done");
    expect(parsed.token_count).toBe(12345);
    expect(parsed.done_signal).toBe("ENRICHMENT_PROMPT_DONE");
    expect(parsed.response).toBe("Line one\nLine two");
    expect(parsed.model).toBe("Sonnet 4.6");
    expect(parsed.cost).toBe(7.73);
  });

  it("treats completed Claude banners as done instead of working", () => {
    const parsed = parseScreen(`
\u001b[32m⏺ Completed successfully\u001b[0m
  Added parser integration to read_screen
🤖 Sonnet 4.6 | 💰 $1.25 | ⏱️  2m 11s
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.status).toBe("done");
    expect(parsed.done_signal).toBeNull();
    expect(parsed.response).toBeNull();
  });

  it("treats active Claude status banners as working", () => {
    const parsed = parseScreen(`
✻ Working…
  Reading src/server.ts
🤖 Sonnet 4.6 | 💰 $0.50 | ⏱️  41s
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.status).toBe("working");
  });

  it("extracts model from no-cost status line (production format)", () => {
    const parsed = parseScreen(`
✻ Working…
  Reading files
Token usage: total=356,835
🤖 Opus 4.6 (1M context)
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.model).toBe("Opus 4.6");
    expect(parsed.token_count).toBe(356835);
    // "(1M" detected in text → 1M window
    expect(parsed.context_window).toBe(1_000_000);
    expect(parsed.context_pct).toBe(36); // 356835/1000000
  });

  it("extracts model from narrow pane (keyword only)", () => {
    const parsed = parseScreen(`
✻ Working…
Token usage: total=356,835
🤖 Opus
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.model).toBe("Opus");
    // token_count > 200K default → must be 1M tier
    expect(parsed.context_window).toBe(1_000_000);
    expect(parsed.context_pct).toBe(36);
  });

  it("infers context from truncated Claude model family with ellipsis", () => {
    const parsed = parseScreen(`
✻ Working…
Token usage: total=356,835
🤖 Opus…
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.model).toBe("Opus");
    expect(parsed.context_window).toBe(1_000_000);
    expect(parsed.context_pct).toBe(36);
  });

  it("treats CLAUDE_COUNTER as an idle done signal and extracts fallback response text", () => {
    const parsed = parseScreen(`
✻ Working…
  Reading src/server.ts

Codex is working well — searching through real session files for patterns to parse, writing tests first (TDD). 90% context left.

No idle agents to reassign right now. Everything is either done or Codex is handling the last task.

Token usage: total=356,835
🤖 Opus
CLAUDE_COUNTER: 92
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.status).toBe("idle");
    expect(parsed.done_signal).toBe("CLAUDE_COUNTER:92");
    expect(parsed.response).toBe(
      [
        "Codex is working well — searching through real session files for patterns to parse, writing tests first (TDD). 90% context left.",
        "",
        "No idle agents to reassign right now. Everything is either done or Codex is handling the last task.",
      ].join("\n"),
    );
    expect(parsed.context_window).toBe(1_000_000);
    expect(parsed.context_pct).toBe(36);
  });

  it("extracts model from timer-only status line (no cost)", () => {
    const parsed = parseScreen(`
⏺ Completed successfully
Token usage: total=50,000
🤖 Sonnet 4.6 | ⏱️  2m 11s
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.model).toBe("Sonnet 4.6");
    expect(parsed.cost).toBeNull();
    expect(parsed.context_window).toBe(200_000);
    expect(parsed.context_pct).toBe(25); // 50000/200000
  });

  it("parses Codex-style output with model, context left, and actions", () => {
    const parsed = parseScreen(`
gpt-5.4 high · 87% left · ~/Gits/orchestrator
Working (2m 06s • esc to interrupt)
• Ran rg -n "read_screen" src tests
• Read src/server.ts
• Edited src/screen-parser.ts
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.status).toBe("working");
    expect(parsed.model).toBe("gpt-5.4 high");
    expect(parsed.context_pct).toBe(13); // 100 - 87% left = 13% used
    expect(parsed.actions).toContain('Ran rg -n "read_screen" src tests');
  });

  it("parses Gemini-style output from explicit Gemini CLI markers", () => {
    const parsed = parseScreen(`
Gemini CLI
Model: gemini-3.1-pro
Thinking...
> Summarizing repository context
`);

    expect(parsed.agent_type).toBe("gemini");
    expect(parsed.status).toBe("working");
    expect(parsed.model).toBe("gemini-3.1-pro");
  });

  it("parses Cursor Agent working state with status strip, k tokens, and mode bar", () => {
    const parsed = parseScreen(`
Auto · 22.5% · 4 files edited

⬡ Running...  3.3k tokens

→ Add a follow-up
ctrl+c to stop

/ commands · @ files · ! shell · ctrl+r to review edits
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("working");
    expect(parsed.token_count).toBe(3300);
    expect(parsed.context_pct).toBe(23);
  });

  it("parses Cursor Agent idle with Idle line, comma tokens, and Model line", () => {
    const parsed = parseScreen(`
Auto · 10% · 1 file edited
Model: gpt-5.2 high

⬡ Idle  12,450 tokens

→ Add a follow-up

/ commands · @ files · ! shell · ctrl+r to review edits
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("idle");
    expect(parsed.token_count).toBe(12450);
    expect(parsed.context_pct).toBe(10);
    expect(parsed.model).toBe("gpt-5.2 high");
  });

  it("detects Cursor session completion as done_signal and status done", () => {
    const parsed = parseScreen(`
Auto · 90% · 2 files edited
Task completed

⬡ Idle  1.2k tokens
/ commands · @ files · ! shell · ctrl+r to review edits
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.done_signal).toBe("CURSOR_SESSION_COMPLETE");
    expect(parsed.status).toBe("done");
  });

  it("detects Cursor via follow-up prompt and ctrl+c without mode bar", () => {
    const parsed = parseScreen(`
→ Add a follow-up
ctrl+c to stop
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("idle");
  });

  it("detects Cursor via inline claude model id", () => {
    const parsed = parseScreen(`
Auto · 5% · 0 files edited
Using claude-sonnet-4-20250514

⬡ Idle  800 tokens
4 files edited
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.model).toBe("claude-sonnet-4-20250514");
  });

  it("detects idle shell output and strips ANSI sequences", () => {
    const parsed = parseScreen(`
\u001b[36mLast login:\u001b[0m Fri Mar 13 18:10:54 on ttys016
etanheyman ~ [master] $
`);

    expect(parsed.agent_type).toBe("unknown");
    expect(parsed.status).toBe("idle");
    expect(parsed.errors).toEqual([]);
  });

  it("does not treat incidental prose as a token count", () => {
    const parsed = parseScreen(`
⏺ Completed successfully
I mentioned 42 tokens in this note, but this is just prose and not a status line.
🤖 Sonnet 4.6 | 💰 $0.10
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.token_count).toBeNull();
    expect(parsed.context_pct).toBeNull();
  });

  it("infers Claude context window from token count when the model footer is fully truncated", () => {
    const parsed = parseScreen(`
  Say "go" when you're ready and I'll start your timer.

  CLAUDE_COUNTER: 186

──────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────
  ⎇ master | +1273,-196 | 🔧 11                                           418310 tokens
  🤖 …                                                        current: 2.1.81 · latest…
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`);

    expect(parsed.agent_type).toBe("claude");
    expect(parsed.status).toBe("idle");
    expect(parsed.token_count).toBe(418310);
    expect(parsed.context_window).toBe(1_000_000);
    expect(parsed.context_pct).toBe(42);
    expect(parsed.done_signal).toBe("CLAUDE_COUNTER:186");
    expect(parsed.model).toBeNull();
  });

  // --- context_pct and context_window tests ---

  describe("context_pct computation", () => {
    it("computes context_pct for Claude Sonnet from token_count (200K window)", () => {
      const parsed = parseScreen(`
✻ Working…
  Reading src/server.ts
Token usage: total=40,000 input=35,000 output=5,000
🤖 Sonnet 4.6 | 💰 $0.50 | ⏱️  41s
`);

      expect(parsed.agent_type).toBe("claude");
      expect(parsed.token_count).toBe(40000);
      expect(parsed.model).toBe("Sonnet 4.6");
      expect(parsed.context_window).toBe(200_000);
      expect(parsed.context_pct).toBe(20); // 40000/200000 = 20%
    });

    it("infers 1M window for Opus when token_count > 200K", () => {
      // No "(1M" marker, but 250K tokens can't fit in 200K → must be 1M tier
      const parsed = parseScreen(`
⏺ Completed successfully
Token usage: total=250,000 input=200,000 output=50,000
🤖 Opus 4.6 | 💰 $12.50 | ⏱️  15m
`);

      expect(parsed.agent_type).toBe("claude");
      expect(parsed.token_count).toBe(250000);
      expect(parsed.model).toBe("Opus 4.6");
      expect(parsed.context_window).toBe(1_000_000); // inferred from token_count > 200K
      expect(parsed.context_pct).toBe(25); // 250000/1000000 = 25%
    });

    it("defaults Opus to 200K when token_count is low and no 1M signal", () => {
      const parsed = parseScreen(`
✻ Working…
Token usage: total=50,000
🤖 Opus 4.6 | 💰 $2.00
`);

      expect(parsed.model).toBe("Opus 4.6");
      expect(parsed.context_window).toBe(200_000); // default tier
      expect(parsed.context_pct).toBe(25); // 50000/200000
    });

    it("detects 1M tier from explicit (1M marker in status line", () => {
      const parsed = parseScreen(`
✻ Working…
Token usage: total=50,000
🤖 Opus 4.6 (1M context)
`);

      expect(parsed.context_window).toBe(1_000_000); // "(1M" detected
      expect(parsed.context_pct).toBe(5); // 50000/1000000
    });

    it("computes context_pct for Claude Haiku from token_count (200K window)", () => {
      const parsed = parseScreen(`
✻ Working…
  Running tests
Token usage: total=10,000
🤖 Haiku 3.5 | 💰 $0.05
`);

      expect(parsed.agent_type).toBe("claude");
      expect(parsed.token_count).toBe(10000);
      expect(parsed.context_window).toBe(200_000);
      expect(parsed.context_pct).toBe(5); // 10000/200000 = 5%
    });

    it("inverts Codex '% left' to '% used' for context_pct", () => {
      const parsed = parseScreen(`
gpt-5.4 high · 87% left · ~/Gits/orchestrator
Working (2m 06s • esc to interrupt)
• Ran rg -n "read_screen" src tests
`);

      expect(parsed.agent_type).toBe("codex");
      expect(parsed.context_pct).toBe(13); // 100 - 87 = 13% used
      expect(parsed.context_window).toBe(1_000_000); // gpt-5.4 resolves to 1M
    });

    it("returns null context_pct when model is unknown", () => {
      const parsed = parseScreen(`
etanheyman ~ [master] $
`);

      expect(parsed.agent_type).toBe("unknown");
      expect(parsed.context_pct).toBeNull();
      expect(parsed.context_window).toBeNull();
    });

    it("returns null context_pct when token_count unavailable for Claude", () => {
      const parsed = parseScreen(`
✻ Working…
  Analyzing code
🤖 Sonnet 4.6 | 💰 $0.10
`);

      expect(parsed.agent_type).toBe("claude");
      expect(parsed.token_count).toBeNull();
      expect(parsed.context_pct).toBeNull();
      expect(parsed.context_window).toBe(200_000); // window known even without tokens
    });

    it("always includes context_pct and context_window fields (never undefined)", () => {
      const parsed = parseScreen("etanheyman ~ $");
      expect(parsed).toHaveProperty("context_pct");
      expect(parsed).toHaveProperty("context_window");
    });

    it("clamps context_pct to 100 when near context limit", () => {
      // Sonnet 200K tier with exactly 200K tokens
      const parsed = parseScreen(`
⏺ Completed successfully
Token usage: total=200,000
🤖 Sonnet 4.6 | 💰 $8.00
`);

      expect(parsed.token_count).toBe(200000);
      expect(parsed.context_window).toBe(200_000);
      expect(parsed.context_pct).toBe(100);
    });

    it("infers 1M when Sonnet token_count exceeds 200K default", () => {
      // 300K tokens can't fit in 200K → must be Max plan (1M)
      const parsed = parseScreen(`
⏺ Completed successfully
Token usage: total=300,000 input=250,000 output=50,000
🤖 Sonnet 4.6 | 💰 $8.00
`);

      expect(parsed.token_count).toBe(300000);
      expect(parsed.context_window).toBe(1_000_000); // inferred upgrade
      expect(parsed.context_pct).toBe(30); // 300000/1000000
    });

    it("computes context_pct for Gemini from token_count", () => {
      const parsed = parseScreen(`
Gemini CLI
Model: gemini-2.5-pro
100,000 tokens
`);

      expect(parsed.agent_type).toBe("gemini");
      expect(parsed.model).toBe("gemini-2.5-pro");
      expect(parsed.token_count).toBe(100000);
      expect(parsed.context_window).toBe(1_000_000);
      expect(parsed.context_pct).toBe(10); // 100K/1M = 10%
    });
  });

  describe("resolveModelMax (default tiers)", () => {
    it("resolves ALL Claude models to 200K default", () => {
      expect(resolveModelMax("Sonnet 4.6")).toBe(200_000);
      expect(resolveModelMax("Opus 4.6")).toBe(200_000);
      expect(resolveModelMax("Haiku 3.5")).toBe(200_000);
      expect(resolveModelMax("sonnet")).toBe(200_000);
      expect(resolveModelMax("opus")).toBe(200_000);
      expect(resolveModelMax("haiku")).toBe(200_000);
    });

    it("resolves Gemini models to 1M", () => {
      expect(resolveModelMax("gemini-3.1-pro")).toBe(1_000_000);
      expect(resolveModelMax("gemini-2.5-pro")).toBe(1_000_000);
    });

    it("resolves GPT-5/Codex models to 1M (hyphenated and space-separated)", () => {
      expect(resolveModelMax("gpt-5.4 high")).toBe(1_000_000);
      expect(resolveModelMax("gpt-5.4")).toBe(1_000_000);
      expect(resolveModelMax("GPT 5")).toBe(1_000_000);
    });

    it("resolves GPT-4 variants to 128K", () => {
      expect(resolveModelMax("GPT 4")).toBe(128_000);
      expect(resolveModelMax("gpt-4-turbo")).toBe(128_000);
      expect(resolveModelMax("gpt-4o")).toBe(128_000);
      expect(resolveModelMax("gpt-4o-mini")).toBe(128_000);
    });

    it("returns null for unknown models", () => {
      expect(resolveModelMax(null)).toBeNull();
      expect(resolveModelMax("mystery-model")).toBeNull();
    });
  });

  describe("inferContextWindow (smart tier detection)", () => {
    it("returns default 200K for Opus with low token count", () => {
      expect(inferContextWindow("Opus 4.6", 50_000, "🤖 Opus 4.6")).toBe(
        200_000,
      );
    });

    it("upgrades to 1M when (1M marker present", () => {
      expect(
        inferContextWindow("Opus 4.6", 50_000, "🤖 Opus 4.6 (1M context)"),
      ).toBe(1_000_000);
    });

    it("upgrades to 1M when token_count exceeds default", () => {
      expect(inferContextWindow("Opus 4.6", 250_000, "🤖 Opus 4.6")).toBe(
        1_000_000,
      );
      expect(inferContextWindow("Sonnet 4.6", 300_000, "🤖 Sonnet 4.6")).toBe(
        1_000_000,
      );
    });

    it("keeps 1M for models that default to 1M (GPT, Gemini)", () => {
      expect(inferContextWindow("gpt-5.4 high", 50_000, "gpt-5.4")).toBe(
        1_000_000,
      );
      expect(
        inferContextWindow("gemini-2.5-pro", 50_000, "gemini-2.5-pro"),
      ).toBe(1_000_000);
    });

    it("returns null for unknown models", () => {
      expect(inferContextWindow(null, 50_000, "")).toBeNull();
      expect(inferContextWindow("mystery", 50_000, "")).toBeNull();
    });
  });
});
