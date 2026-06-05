import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseScreen,
  MODEL_MAX_TOKENS,
  resolveModelMax,
  inferContextWindow,
} from "../src/screen-parser.js";

const readFixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

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

  it("parses Codex model when the header omits the context-left segment", () => {
    const parsed = parseScreen(`
Improve documentation in @filename

gpt-5.4 xhigh · ~/Gits/cmuxlayer
Working (2m 08s • esc to interrupt)
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.status).toBe("working");
    expect(parsed.model).toBe("gpt-5.4 xhigh");
    expect(parsed.context_pct).toBeNull();
  });

  it("parses Codex context-left headers with trailing whitespace", () => {
    const parsed = parseScreen(`
gpt-5.4 high · 87% left   
Working (2m 06s • esc to interrupt)
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.model).toBe("gpt-5.4 high");
    expect(parsed.context_pct).toBe(13);
  });

  it("does not treat echoed done instructions as a done signal while the agent is working", () => {
    const parsed = parseScreen(`
When the task is complete, print R2_WORKER_DONE on its own line.

gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer
Working (1m 02s • esc to interrupt)
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.done_signal).toBeNull();
    expect(parsed.status).toBe("working");
  });

  it("accepts one short trailing argument on a standalone done signal", () => {
    const parsed = parseScreen(`
Judge complete.
R2_WORKER_DONE 5
`);

    expect(parsed.done_signal).toBe("R2_WORKER_DONE");
    expect(parsed.status).toBe("done");
  });

  it("does not treat echoed numbered done instructions as a done signal", () => {
    const parsed = parseScreen(`
When the task is complete, print R2_WORKER_DONE 5.

gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer
Working (1m 02s • esc to interrupt)
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.done_signal).toBeNull();
    expect(parsed.status).toBe("working");
  });

  it("does not treat a standalone done token inside a Codex echoed prompt box as output", () => {
    const parsed = parseScreen(`
gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer
→ Implement the fix. When complete, print exactly:
TASK_DONE
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.done_signal).toBeNull();
    expect(parsed.status).not.toBe("done");
  });

  it("accepts a real trailing done token after an echoed prompt box and output", () => {
    const parsed = parseScreen(`
gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer
→ Implement the fix. When complete, print exactly:
TASK_DONE
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
Implemented the fix.
TASK_DONE
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.done_signal).toBe("TASK_DONE");
    expect(parsed.status).toBe("done");
  });

  it("accepts a real trailing done token after ordinary output mentioning done signal", () => {
    const parsed = parseScreen(`
gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer
Updated the done signal parser edge case.
TASK_DONE
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.done_signal).toBe("TASK_DONE");
    expect(parsed.status).toBe("done");
  });

  it("does not revive stale done evidence when later output starts with an arrow", () => {
    const parsed = parseScreen(`
gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer
TASK_DONE
→ Later output from the agent
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.done_signal).toBeNull();
    expect(parsed.status).not.toBe("done");
  });

  it("does not treat a done token as output while the current tail is still working", () => {
    const parsed = parseScreen(`
gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer
Working (1m 02s • esc to interrupt)
TASK_DONE
`);

    expect(parsed.agent_type).toBe("codex");
    expect(parsed.done_signal).toBeNull();
    expect(parsed.status).toBe("working");
  });

  it("parses Gemini-style output from explicit Gemini CLI markers", () => {
    const parsed = parseScreen(`
Gemini CLI
Model: gemini-3.1-pro
Thinking...
> Summarizing repository context
`);

    expect(parsed.agent_type).toBe("gemini");
    expect(parsed.status).toBe("thinking");
    expect(parsed.model).toBe("gemini-3.1-pro");
  });

  it("parses Gemini model bullets and working status icons", () => {
    const parsed = parseScreen(`
Gemini CLI
✦ Working
- Model: gemini-2.5-flash-lite
100,000 tokens
`);

    expect(parsed.agent_type).toBe("gemini");
    expect(parsed.status).toBe("working");
    expect(parsed.model).toBe("gemini-2.5-flash-lite");
    expect(parsed.token_count).toBe(100000);
    expect(parsed.context_pct).toBe(10);
  });

  it("does not treat Gemini prose that starts with Working as a working status line", () => {
    const parsed = parseScreen(`
Gemini CLI
Model: gemini-2.5-flash
Working with existing APIs is the safer migration path here.
`);

    expect(parsed.agent_type).toBe("gemini");
    expect(parsed.model).toBe("gemini-2.5-flash");
    expect(parsed.status).toBe("idle");
  });

  it("parses Cursor Agent thinking state with status strip, k tokens, and mode bar", () => {
    const parsed = parseScreen(`
Auto · 22.5% · 4 files edited

⬡ Running...  3.3k tokens

→ Add a follow-up
ctrl+c to stop

/ commands · @ files · ! shell · ctrl+r to review edits
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("thinking");
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

  it("parses Cursor token counts from calling status lines", () => {
    const parsed = parseScreen(`
⬢ Calling     1.59k tokens

│ → Add a follow-up
ctrl+c to stop │

▶︎ Auto-run all commands (shift+tab to turn off)

Auto · 16.1%
/ commands · @ files · ! shell
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.token_count).toBe(1590);
    expect(parsed.context_pct).toBe(16);
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

  it("detects exact Cursor checkmark completion as done_signal and status done", () => {
    const parsed = parseScreen(`
Auto · 90% · 2 files edited
✓ Done

⬡ Idle  1.2k tokens
/ commands · @ files · ! shell · ctrl+r to review edits
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.done_signal).toBe("CURSOR_SESSION_COMPLETE");
    expect(parsed.status).toBe("done");
  });

  it("does not treat Cursor checkmark progress lines as session completion", () => {
    const parsed = parseScreen(`
Auto · 45% · 0 files edited
✓ Done reading src/server.ts

⬡ Idle  1.2k tokens
/ commands · @ files · ! shell · ctrl+r to review edits
`);

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.done_signal).toBeNull();
    expect(parsed.status).toBe("idle");
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

  it("parses Cursor Agent v2026.06.04 fresh-boot ready chrome", () => {
    const parsed = parseScreen(
      readFixture("cursor-2026-06-04-boot-ready.txt"),
    );

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("idle");
    expect(parsed.done_signal).toBeNull();
    expect(parsed.model).toBeNull();
    expect(parsed.context_pct).toBeNull();
  });

  it("parses Cursor Agent v2026.06.04 standalone TASK_DONE output evidence", () => {
    const parsed = parseScreen(
      readFixture("cursor-2026-06-04-task-done.txt"),
    );

    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("done");
    expect(parsed.done_signal).toBe("TASK_DONE");
    expect(parsed.model).toBeNull();
    expect(parsed.context_pct).toBe(19);
  });

  it.each([
    ["Claude thinking indicator", "✶ thinking"],
    ["Claude high-effort thinking indicator", "thinking with high effort"],
    ["Claude whimsical loading phrase", "Reticulating splines..."],
    ["Cursor running spinner", "Running 24k tokens"],
    ["Cursor generating spinner", "Generating 5.2k tokens"],
  ])("detects thinking status for %s", (_label, screen) => {
    const parsed = parseScreen(screen);

    expect(parsed.status).toBe("thinking");
  });

  it.each([
    ["user prose", "I was thinking about cooking"],
    ["non-spinner running text", "Running the tests"],
  ])("does not misclassify %s as thinking", (_label, screen) => {
    const parsed = parseScreen(screen);

    expect(parsed.status).toBe("idle");
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

  it("does not treat prose ending with token count as a status line", () => {
    const parsed = parseScreen(`
⏺ Completed successfully
I only have 42 tokens
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
      expect(parsed.context_window).toBe(400_000); // gpt-5.x/Codex = 400K total window
    });

    it("reports 400K (NOT 1M) for Codex gpt-5.5 — the P1 bug", () => {
      const parsed = parseScreen(`
gpt-5.5 xhigh · 60% left · ~/Gits/brainlayer
Working (1m 12s • esc to interrupt)
• Ran rg -n "context_window" src
`);

      expect(parsed.agent_type).toBe("codex");
      expect(parsed.context_window).toBe(400_000); // NOT 1_000_000
      expect(parsed.context_pct).toBe(40); // 100 - 60 = 40% used
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
      expect(parsed.context_window).toBe(1_048_576); // Gemini real window
      expect(parsed.context_pct).toBe(10); // 100K/1,048,576 ≈ 9.5% → 10%
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

    it("resolves Gemini models to 1,048,576", () => {
      expect(resolveModelMax("gemini-3.1-pro")).toBe(1_048_576);
      expect(resolveModelMax("gemini-2.5-pro")).toBe(1_048_576);
    });

    it("resolves GPT-5/Codex models to 400K (NOT 1M)", () => {
      expect(resolveModelMax("gpt-5.4 high")).toBe(400_000);
      expect(resolveModelMax("gpt-5.4")).toBe(400_000);
      expect(resolveModelMax("GPT 5")).toBe(400_000);
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

    it("uses the real fixed window for non-Claude models (GPT-5=400K, Gemini=1.048M); no 1M bump", () => {
      expect(inferContextWindow("gpt-5.4 high", 50_000, "gpt-5.4")).toBe(
        400_000,
      );
      expect(
        inferContextWindow("gemini-2.5-pro", 50_000, "gemini-2.5-pro"),
      ).toBe(1_048_576);
    });

    it("does NOT bump non-Claude models to 1M even when token_count exceeds their window", () => {
      // gpt-5 at 500K tokens stays 400K (clamps pct), never the Claude-only 1M tier
      expect(inferContextWindow("gpt-5.4 high", 500_000, "gpt-5.4")).toBe(
        400_000,
      );
    });

    it("returns null for unknown models", () => {
      expect(inferContextWindow(null, 50_000, "")).toBeNull();
      expect(inferContextWindow("mystery", 50_000, "")).toBeNull();
    });
  });
});
