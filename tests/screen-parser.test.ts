import { describe, expect, it } from "vitest";
import { parseScreen } from "../src/screen-parser.js";

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
    expect(parsed.context_pct).toBe(87);
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

  it("detects idle shell output and strips ANSI sequences", () => {
    const parsed = parseScreen(`
\u001b[36mLast login:\u001b[0m Fri Mar 13 18:10:54 on ttys016
etanheyman ~ [master] $
`);

    expect(parsed.agent_type).toBe("unknown");
    expect(parsed.status).toBe("idle");
    expect(parsed.errors).toEqual([]);
  });
});
