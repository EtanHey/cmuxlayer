import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSelectedCodexSessionDirectoryChooser } from "../src/codex-resume-chooser.js";

// Lead's live read_screen frame from c37b0ffb's 16:29 resume, copied exactly.
const frame = readFileSync(new URL("./fixtures/live/codex-resume-working-directory.txt", import.meta.url), "utf8");
const sessionCwd = "/Users/etanheyman/Gits/cmuxlayer/.worktrees/lane-g-claude-boot-submit";

describe("Codex resume cwd chooser", () => {
  it("recognizes the exact current frame with one selected session-directory row", () => {
    expect(isSelectedCodexSessionDirectoryChooser(frame, sessionCwd)).toBe(true);
  });

  it("rejects a different cwd, selected current directory, altered text, or another menu", () => {
    for (const [text, cwd] of [
      [frame, "/Users/etanheyman/Gits/cmuxlayer"],
      [frame.replace("› 1.", "  1.").replace("  2.", "› 2."), sessionCwd],
      [frame.replace("Use session directory", "Trust this directory"), sessionCwd],
      [frame + "\nAllow access?", sessionCwd],
      ["OpenAI Codex\n›", sessionCwd],
    ]) {
      expect(isSelectedCodexSessionDirectoryChooser(text, cwd)).toBe(false);
    }
  });
});
