import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/agent-engine.js";
import type { CliType } from "../src/agent-types.js";

// The engine finds a still-typed boot prompt by scanning the composer region
// below the LAST anchor line. Claude's status line and bypass-permissions
// footer sit BELOW the composer, so treating them as anchors left an empty
// region and hid a typed-but-unsubmitted prompt (CX-2 S1 finding).
const engine = Object.create(AgentEngine.prototype) as unknown as {
  screenInputRegionContainsPromptTail(
    cli: CliType,
    screenText: string,
    tail: string,
  ): boolean;
};

const PROMPT = "Read and follow the brief";
const BYPASS_FOOTER =
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents";

describe("engine composer region anchor", () => {
  it("finds a typed Claude prompt with only the banner above it", () => {
    expect(
      engine.screenInputRegionContainsPromptTail(
        "claude",
        `Claude Code\n❯ ${PROMPT}\n`,
        PROMPT,
      ),
    ).toBe(true);
  });

  it("still finds it when the bypass-permissions footer is visible", () => {
    expect(
      engine.screenInputRegionContainsPromptTail(
        "claude",
        `Claude Code\n❯ ${PROMPT}\n${BYPASS_FOOTER}\n`,
        PROMPT,
      ),
    ).toBe(true);
  });

  it("still finds it when the CLAUDE_COUNTER status line is visible", () => {
    expect(
      engine.screenInputRegionContainsPromptTail(
        "claude",
        `Claude Code\n❯ ${PROMPT}\nCLAUDE_COUNTER:1\n`,
        PROMPT,
      ),
    ).toBe(true);
  });

  it("does not read a prompt from above the latest banner", () => {
    expect(
      engine.screenInputRegionContainsPromptTail(
        "claude",
        `❯ ${PROMPT}\nClaude Code\n❯ \n${BYPASS_FOOTER}\n`,
        PROMPT,
      ),
    ).toBe(false);
  });
});
