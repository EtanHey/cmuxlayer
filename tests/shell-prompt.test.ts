import { describe, expect, it } from "vitest";
import {
  launcherFailureFromShell,
  matchShellPromptLine,
  matchesShellPrompt,
} from "../src/shell-prompt.js";

describe("shell prompt recognition", () => {
  it.each([
    "$ ",
    "% ",
    "# ",
    "> ",
    "❯ ",
    "› ",
    "» ",
    "user in ~/code/cmuxlayer > ",
    "etan@mac ~/Gits/cmuxlayer [main] ❯ ",
  ])("accepts a ready %s prompt", (prompt) => {
    expect(matchesShellPrompt(`old output\n${prompt}`)).toBe(true);
  });

  it.each([
    "> cmuxlayerCodex -s",
    "❯ cmuxlayerClaude -s",
    "user in ~/code/cmuxlayer > still pending",
  ])("rejects pending input at %s", (prompt) => {
    expect(matchesShellPrompt(prompt)).toBe(false);
  });

  it("keeps root input fail-closed unless explicitly allowed", () => {
    expect(matchShellPromptLine("# rm -rf example")).toBeNull();
    expect(
      matchShellPromptLine("# echo safe", { allowRootInput: true }),
    ).toEqual({ input: "echo safe" });
  });

  it("recognizes only adjacent, specific launcher failure evidence", () => {
    expect(
      launcherFailureFromShell("zsh: command not found: cmuxlayerCodex\n$ "),
    ).toBe("zsh: command not found: cmuxlayerCodex");
    expect(launcherFailureFromShell("build failed earlier\nsummary\n$ ")).toBeNull();
    expect(launcherFailureFromShell("error: cached warning\n$ ")).toBeNull();
  });
});
