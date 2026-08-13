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
    "➜  cmuxlayer git:(main) $ ",
    "[etan@mac cmuxlayer]$ ",
    "cmuxlayer (main) % ",
    "bash-5.2$ ",
  ])("accepts a ready %s prompt", (prompt) => {
    expect(matchesShellPrompt(`old output\n${prompt}`)).toBe(true);
  });

  it.each([
    "> cmuxlayerCodex -s",
    "❯ cmuxlayerClaude -s",
    "user in ~/code/cmuxlayer > still pending",
    "bash-5.2$ cmuxlayerCodex -s",
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

  it.each([
    "⠋ Building bundle... 62%",
    "Installing dependencies  45%",
    "Context left: 12%",
    "Total cost: $",
    "issue #",
  ])("does not treat a loose readiness suffix as launcher-exit evidence: %s", (line) => {
    expect(
      launcherFailureFromShell(`zsh: command not found: pyenv\n${line}`),
    ).toBeNull();
  });

  it.each([
    ["➜  cmuxlayer git:(main) $ ralphCodex -s", "ralphCodex -s"],
    ["bash-5.2$ ralphCodex -s", "ralphCodex -s"],
    ["[etan@mac cmuxlayer]$ ralphCodex -s", "ralphCodex -s"],
  ])("captures pending input from decorated prompt %s", (line, input) => {
    expect(matchShellPromptLine(line)).toEqual({ input });
  });
});
