import { describe, expect, it } from "vitest";
import {
  launcherFailureFromShell,
  matchShellPromptLine,
  matchesShellPrompt,
  pendingShellPromptInput,
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
    expect(
      launcherFailureFromShell("build failed earlier\nsummary\n$ "),
    ).toBeNull();
    expect(launcherFailureFromShell("error: cached warning\n$ ")).toBeNull();
  });

  it.each([
    "⠋ Building bundle... 62%",
    "Installing dependencies  45%",
    "Context left: 12%",
    "Total cost: $",
    "issue #",
  ])(
    "does not treat a loose readiness suffix as launcher-exit evidence: %s",
    (line) => {
      expect(
        launcherFailureFromShell(`zsh: command not found: pyenv\n${line}`),
      ).toBeNull();
    },
  );

  it.each([
    ["➜  cmuxlayer git:(main) $ ralphCodex -s", "ralphCodex -s"],
    ["bash-5.2$ ralphCodex -s", "ralphCodex -s"],
    ["[etan@mac cmuxlayer]$ ralphCodex -s", "ralphCodex -s"],
  ])("captures pending input from decorated prompt %s", (line, input) => {
    expect(matchShellPromptLine(line)).toEqual({ input });
  });

  it.each([
    [" ngff%\netanheyman ~  $ wenfnng", "wenfnng"],
    [
      "rbgjrbgjrbgjrb%\netanheyman ~  $ gjrbgjbrgjrbgjrbgjrgbjrgbjrgbjrgb",
      "gjrbgjbrgjrbgjrbgjrgbjrgbjrgbjrgb",
    ],
    ["etanheyman ~  $ sjnfjdnsf", "sjnfjdnsf"],
  ])("exposes pending junk on live-probe prompt %j", (screen, junk) => {
    expect(matchesShellPrompt(screen)).toBe(false);
    expect(matchShellPromptLine(screen.split("\n").at(-1) ?? "")).toEqual({
      input: junk,
    });
    expect(pendingShellPromptInput(screen)).toBe(junk);
  });

  it.each([
    ["[oh-my-zsh] 50% of plugins loaded", "of plugins loaded"],
    ["Downloading nvm... 45% complete", "complete"],
    [
      "receiving objects:  72% (720/1000), 1.2 MiB | 400 KiB/s",
      "(720/1000), 1.2 MiB | 400 KiB/s",
    ],
  ])(
    "does not treat digit-prefixed progress %j as pending shell input",
    (line, decoratedTrap) => {
      expect(matchShellPromptLine(line)?.input.trim()).toBe(decoratedTrap);
      expect(pendingShellPromptInput(line)).toBeNull();
    },
  );
});
