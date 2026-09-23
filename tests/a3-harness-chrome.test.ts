import { describe, expect, it } from "vitest";
import { parseScreen } from "../src/screen-parser.js";

// R1's 13-frame cross-harness probe. C4 and X2 preserve redacted excerpts of
// live read_screen captures (Claude surface:647, Codex surface:323, 2026-09-23);
// the other rows are labelled synthetic or captured excerpts with inserted quotes.
const claudeTail = "\n· Nesting… (1m 41s · ↓ 8.6k tokens · still thinking with high effort)\n                                                                             201491 tokens\n────────────────────────────────────────────────────────────────────────────────────────────\n❯ \n────────────────────────────────────────────────────────────────────────────────────────────\n  ⎇ detached | +28,-0 | 🔧 13\n  🤖 Opus 5.5 (1M context) | 💰 $4.80 | ⏱️  19m | 📦 4hr 59m | 🧠 20.1%\n  ⏵⏵ bypass permissions on · 1 monitor · ← 3 agents";
const realClaude = (body: string) => `     273:      const first = \`SOAK_OK_\${cycle}\`;\n${body}${claudeTail}`;
const codexTail = "\n• Round 5 is ready for R1 review at clean local SHA bcd83e4. The slotted full run passed:\n  168/168 files and 4,234 passing tests; slot 1 is released.\n \nWorking (28m 30s • esc to interrupt)\n \n \n› Ask Codex to do anything\n \n  gpt-6-sol medium · ~/Gits/cmuxlayer/.worktrees/lane-a-true-state · Read cmuxlayer instruc…";
const realCodex = (body: string) => `\n• Ran tail -18 /home/test-user/.cmux/agents/cmuxlayerCodex-fc099174/report.md\n  └\n${body}    full run is green.\n${codexTail}`;
const bypass = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";

const frames: Array<[string, "claude" | "codex", string | null, string]> = [
  ["C1 synthetic model list", "claude", "working", `⏺ Comparing models:\n  gpt-6-sol\n\n✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)\n\n❯ \n${bypass}`],
  ["C2 synthetic quoted percent footer", "claude", "working", `⏺ Comparing models:\n  gpt-5.5 xhigh · 42% left · ~/Gits/cmuxlayer\n\n✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)\n\n❯ \n${bypass}`],
  ["C3 synthetic Codex prose", "claude", "working", `⏺ The pane header reads OpenAI Codex, Model: gpt-5.5 high.\n\n✻ Pondering… (12s · ↓ 1.2k tokens · esc to interrupt)\n\n❯ \n${bypass}`],
  ["C4 captured Claude working", "claude", "working", realClaude("     274:      const second = `SOAK2_${cycle}`;")],
  ["C5 captured Claude plus inserted indented Codex footer", "claude", "working", realClaude("  gpt-6-sol medium · ~/Gits/cmuxlayer · Read cmuxlayer instruc…")],
  ["C6 captured Claude plus inserted unindented Codex footer", "claude", "working", realClaude("gpt-6-sol medium · ~/Gits/cmuxlayer · Read cmuxlayer instruc…")],
  ["C7 captured Claude plus inserted Codex box", "claude", "working", realClaude("│ OpenAI Codex │\n│ Model: gpt-5.5 │")],
  ["X1 synthetic Codex dot action", "codex", null, "OpenAI Codex\nModel: gpt-5.5\n· Searching…\n›"],
  ["X2 captured Codex working", "codex", "working", realCodex("    Source has one `classifyClaudeGlyphLine` function\n")],
  ["X3 captured Codex plus inserted Claude bypass", "codex", "working", realCodex("      ⏵⏵ bypass permissions on · 1 monitor · ← 3 agents\n")],
  ["X4 captured Codex plus inserted Claude banner", "codex", "working", realCodex("    Claude Code v2.1.3\n")],
  ["X5 captured Codex plus inserted Claude prose", "codex", "working", realCodex("    Read the Claude Code notes before editing\n")],
  ["X6 captured Codex plus inserted Claude spinner", "codex", "working", realCodex("    · Nesting… (1m 41s · ↓ 8.6k tokens)\n")],
];

describe("A3 positional harness chrome", () => {
  it.each(frames)("classifies %s", (_name, agentType, status, text) => {
    const parsed = parseScreen(text);
    expect(parsed.agent_type).toBe(agentType);
    if (status) expect(parsed.status).toBe(status);
  });

  it("keeps idle Codex with a quoted Claude spinner idle", () => {
    const parsed = parseScreen("• Called cmuxlayer.read_screen({\"surface_id\":\"surface:647\"})\n    · Nesting… (1m 41s · ↓ 8.6k tokens)\n• I will check again later.\n› Ask Codex to do anything\n  gpt-6-sol medium · ~/Gits/cmuxlayer/.worktrees/lane-a-true-state · Read cmuxlayer instruc…");
    expect(parsed.agent_type).toBe("codex");
    expect(parsed.status).toBe("idle");
  });

  it("does not treat a Claude banner quoted after Codex output as boot chrome", () => {
    const parsed = parseScreen(
      "OpenAI Codex\nModel: gpt-5.5\n• Read the report\n  Claude Code v2.1.3\n›",
    );
    expect(parsed.agent_type).toBe("codex");
  });

  it.each([
    ["surface:665 live footer", "  GPT-6-Sol high · ~/Gits/jobRadarCoach · Review WebGL leak-chec…  ⚠ 1 warning · f2 to view"],
    ["surface:672 live footer", "  GPT-6-Sol medium · ~/Gits/voicelayer · Follow residency hotf…  ⚠ 42 warnings · f2 to view"],
  ])("keeps %s authoritative below Codex composer", (_name, footer) => {
    const base = "• Read the report\n› Ask Codex to do anything\n" + footer;
    for (const quote of [
      "    · Nesting… (1m 41s · ↓ 8.6k tokens)",
      "      ⏵⏵ bypass permissions on · 1 monitor",
      "    Claude Code v2.1.3",
    ]) {
      const parsed = parseScreen("• Read the report\n" + quote + "\nWorking (0s • esc to interrupt)\n› Ask Codex to do anything\n" + footer);
      expect(parsed.agent_type).toBe("codex");
      expect(parsed.status).toBe("working");
    }
    const idle = parseScreen(base.replace("• Read the report\n", "• Read the report\n    · Nesting… (1m 41s · ↓ 8.6k tokens)\n"));
    expect(idle.agent_type).toBe("codex");
    expect(idle.status).toBe("idle");
  });

  it.each(["? for shortcuts", "⏸ plan mode on", "⏵⏵ accept edits on"])(
    "recognizes Claude default footer %s below its composer",
    (footer) => {
      const parsed = parseScreen("⏺ Comparing models:\n  gpt-6-sol\n❯\n  " + footer);
      expect(parsed.agent_type).toBe("claude");
      expect(parsed.status).toBe("idle");
    },
  );
});
