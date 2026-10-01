import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeKeyName, isSubmitKey } from "../src/key-names.js";
import { parseScreen } from "../src/screen-parser.js";
import { matchReadyPattern } from "../src/pattern-registry.js";
import { extractComposerInputRegion, composerHoldsForeignDraft } from "../src/delivery/composer-screen.js";

// Derived from real 0.157 captures; only model labels change to the display
// names reported in #974 and #987. These are replay variants, not new captures.
const capture = (name: string) => readFileSync(new URL(`./fixtures/codex-0.157/${name}.txt`, import.meta.url), "utf8");
const labels = ["Daybreak Blue high", "GPT-6.1-Sol high", "GPT-6.1-Sol medium"];

describe("P0 named keys", () => {
  it.each(["Enter", "Return", "RETURN", "Escape", "Tab", "CTRL+C"])("normalizes %s before dispatch", key => {
    expect(normalizeKeyName(key)).toBe(key === "CTRL+C" ? "ctrl-c" : key.toLowerCase());
  });
  it.each(["A", "a", "Z", "?", " "])("preserves literal %j", key => {
    expect(normalizeKeyName(key)).toBe(key);
    expect(isSubmitKey(normalizeKeyName(key))).toBe(false);
  });
});

describe("P0 structural Codex footer", () => {
  it.each(labels.flatMap(label => ["idle-empty", "midturn-empty", "midturn-steer-and-followup-queued"].map(frame => ({ label, frame }))))("reads chrome without treating it as a draft: %j", ({ label, frame }) => {
    const screen = capture(frame).replaceAll("GPT-6-Sol medium", label);
    expect(parseScreen(screen).agent_type).toBe("codex");
    expect(extractComposerInputRegion(screen)).toBe("");
    expect(composerHoldsForeignDraft(screen, "new request")).toBe(false);
    expect(matchReadyPattern("codex", screen).matched).toBe(frame === "idle-empty");
  });
  it.each(labels)("detects readiness and drafts without a boot banner: %s", label => {
    const footer = `  ${label} · ~/Gits/cmuxlayer · Read brief
  ? for shortcuts · 82% left
  ⚠ 1 warning · f2 to view`;
    expect(matchReadyPattern("codex", `›
${footer}`).matched).toBe(true);
    expect(parseScreen(`›
${footer}`).agent_type).toBe("codex");
    expect(extractComposerInputRegion(`› Ask Codex to do anything
${footer}`)).toBe("");
    expect(extractComposerInputRegion(`› human draft
${footer}`)).toBe("human draft");
    expect(composerHoldsForeignDraft(`› human draft
${footer}`, "new request")).toBe(true);
  });
  it("accepts an optional effort and legacy context footer", () => {
    for (const footer of ["Daybreak Blue · ~/Gits/cmuxlayer", "Daybreak Blue high · 82% left · ~/Gits/cmuxlayer"]) {
      expect(extractComposerInputRegion(`›
  ${footer}`)).toBe("");
      expect(parseScreen(`›
  ${footer}`).agent_type).toBe("codex");
    }
  });
  it.each(["Daybreak Blue high · ~/Gits/cmuxlayer", "? for shortcuts", "⚠ 1 warning · f2 to view"])("does not identify chrome as input: %s", chrome => {
    expect(extractComposerInputRegion(`OpenAI Codex
› ${chrome}`)).toBeNull();
  });
  it("does not identify a picker option as a composer", () => {
    expect(extractComposerInputRegion(`OpenAI Codex
Update available!
› 1. Update now
  2. Skip until next version
Press enter to continue`)).toBeNull();
  });
});
