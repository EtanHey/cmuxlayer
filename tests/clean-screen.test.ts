import { describe, expect, it } from "vitest";
import { cleanScreenText } from "../src/screen-parser.js";

describe("cleanScreenText (read_screen leanness)", () => {
  it("drops box-drawing rule/separator lines, keeps real content", () => {
    const input = [
      "────────────────────────",
      "Real output line one",
      "═══════════ • ═══════════",
      "Real output line two",
      "----------",
    ].join("\n");
    expect(cleanScreenText(input)).toBe(
      "Real output line one\nReal output line two",
    );
  });

  it("strips the agent status-bar art (🤖 model · cost, spinner, esc to interrupt)", () => {
    const input = [
      "Did the work",
      "✻ Working… Reticulating",
      "  esc to interrupt",
      "🤖 Sonnet 4.6 | 💰 $1.25 | ⏱️  2m",
    ].join("\n");
    expect(cleanScreenText(input)).toBe("Did the work");
  });

  it("strips Codex '% left' footer and Cursor status strip + prompts", () => {
    const codex = "answer text\ngpt-5.5 xhigh · 60% left · ~/x";
    expect(cleanScreenText(codex)).toBe("answer text");
    const cursor = [
      "cursor answer",
      "Auto · 22% · 3 files edited",
      "→ Add a follow-up",
      "ctrl+c to stop",
    ].join("\n");
    expect(cleanScreenText(cursor)).toBe("cursor answer");
  });

  it("collapses blank runs and trims edges", () => {
    const input = "\n\nfirst\n\n\n\nsecond\n\n";
    expect(cleanScreenText(input)).toBe("first\n\nsecond");
  });

  it("returns only the last maxLines meaningful lines", () => {
    const input = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const out = cleanScreenText(input, 3).split("\n");
    expect(out).toEqual(["line 18", "line 19", "line 20"]);
  });

  it("strips ANSI escapes before cleaning", () => {
    const input = "[32mGreen output[0m\n──────";
    expect(cleanScreenText(input)).toBe("Green output");
  });

  it("empty / all-chrome input → empty string", () => {
    expect(cleanScreenText("")).toBe("");
    expect(cleanScreenText("─────\n🤖 model\n  esc to interrupt")).toBe("");
  });
});
