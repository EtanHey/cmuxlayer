import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeKeyName, isSubmitKey } from "../src/key-names.js";
import { computeModelMismatch, computeEffortMismatch, parseCodexEffort } from "../src/engine/launch-command.js";
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
  it.each(["Daybreak Blue high · ~/Gits/cmuxlayer", "? for shortcuts", "⚠ 1 warning · f2 to view"])("treats a prompt row as input even when it resembles chrome: %s", chrome => {
    expect(extractComposerInputRegion(`OpenAI Codex
› ${chrome}`)).toBe(chrome);
  });
  it("does not identify a picker option as a composer", () => {
    expect(extractComposerInputRegion(`OpenAI Codex
Update available!
› 1. Update now
  2. Skip until next version
Press enter to continue`)).toBeNull();
  });
});


describe("P0 Codex model identity and effort", () => {
  it.each([
    { header: "gpt-6.1-sol", footer: "GPT-6.1-Sol high", model: "gpt-6.1-sol", requested: "gpt-6.1-sol", mismatch: false, effort: "high" },
    { header: "Model: gpt-6.1-sol", footer: "Daybreak Blue medium", model: "gpt-6.1-sol", requested: "gpt-6.1-sol", mismatch: false, effort: "medium" },
    { header: "", footer: "GPT-6.1-Sol high", model: "GPT-6.1-Sol", requested: "gpt-6.1-sol", mismatch: false, effort: "high" },
    { header: "", footer: "Daybreak Blue high", model: "Daybreak Blue", requested: "gpt-daybreak-blue-latest", mismatch: null, effort: "high" },
    { header: "gpt-6.1-sol high", footer: "GPT-6.1-Sol", model: "gpt-6.1-sol", requested: "gpt-6.1-sol", mismatch: false, effort: "high" },
    { header: "", footer: "Daybreak high", model: "Daybreak", requested: "gpt-daybreak-blue-latest", mismatch: null, effort: "high" },
  ])("keeps the model separate from effort: $footer / $header", ({ header, footer, model, requested, mismatch, effort }) => {
    const screen = `OpenAI Codex\n${header}\n›\n  ${footer} · ~/Gits/cmuxlayer`;
    const parsed = parseScreen(screen);
    expect(parsed.model).toBe(model);
    expect(computeModelMismatch(requested, parsed.model)).toBe(mismatch);
    const parsedEffort = parseCodexEffort(parsed.model, screen);
    expect(parsedEffort).toBe(effort);
    expect(computeEffortMismatch(effort, parsedEffort)).toBe(false);
    expect(computeEffortMismatch(effort === "high" ? "medium" : "high", parsedEffort)).toBe(true);
  });
});


describe("P0 hosted review regressions", () => {
  it.each(["~/My Projects/repo", "/tmp/My Projects/repo"])("reads a structural footer with spaces in cwd: %s", cwd => {
    const screen = `›\n  Daybreak Blue high · ${cwd}`;
    expect(matchReadyPattern("codex", screen).matched).toBe(true);
    expect(extractComposerInputRegion(screen)).toBe("");
    expect(parseScreen(screen).model).toBe("Daybreak Blue");
  });
  it("keeps a Model continuation inside the composer", () => {
    const draft = "first line\nModel: customer";
    expect(extractComposerInputRegion(`OpenAI Codex\n› ${draft}\n  GPT-6.1-Sol high · ~/repo`)).toBe(draft);
  });
  it("keeps prose beginning with a shortcuts hint inside the composer", () => {
    const draft = "? for shortcuts explain this";
    expect(extractComposerInputRegion(`OpenAI Codex\n› ${draft}\n  GPT-6.1-Sol high · ~/repo`)).toBe(draft);
  });
  it("preserves a decomposed literal grapheme", () => {
    expect(normalizeKeyName("E\u0301")).toBe("E\u0301");
  });
});

// The prompt glyph positively identifies input; only unprompted footer rows are chrome.
describe("P0 prompted draft review regressions", () => {
  it.each(["gpt-5.5", "compare /tmp/old · /tmp/new", "Review · /tmp/output", "? for shortcuts explain this"])("preserves prompted input %s", draft => {
    for (const glyph of ["›", "»", "❯"]) {
      const screen = `OpenAI Codex\n${glyph} ${draft}\n  GPT-6.1-Sol high · ~/repo`;
      expect(extractComposerInputRegion(screen)).toBe(draft);
      expect(composerHoldsForeignDraft(screen, draft)).toBe(false);
      expect(composerHoldsForeignDraft(screen, "another message")).toBe(true);
    }
  });
  it("keeps even an id-like Model continuation in input", () => {
    const draft = "first line\nModel: gpt-5.5";
    expect(extractComposerInputRegion(`OpenAI Codex\n› ${draft}\n  GPT-6.1-Sol high · ~/repo`)).toBe(draft);
  });
  it("recognizes boxed model panels before input", () => {
    expect(extractComposerInputRegion("│ OpenAI Codex │\n│ Model: Daybreak Blue │\n› draft\n  Daybreak Blue high · ~/repo")).toBe("draft");
  });
});
