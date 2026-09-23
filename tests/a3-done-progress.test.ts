import { describe, expect, it } from "vitest";
import { hasVisibleAgentProgress, parseScreen } from "../src/screen-parser.js";

const bypass = "  ⏵⏵ bypass permissions on (shift+tab to cycle)";

describe("A3b live Claude progress", () => {
  it.each([
    ["without composer", "Claude Code v2.1\n⏺ Running tests\nTASK_DONE"],
    ["with composer", `Claude Code v2.1\n⏺ Running tests\nTASK_DONE\n\n❯ \n${bypass}`],
  ])("does not accept TASK_DONE beside a live action %s", (_name, text) => {
    const parsed = parseScreen(text);
    expect(parsed.agent_type).toBe("claude");
    expect(parsed.status).toBe("working");
    expect(parsed.done_signal).toBeNull();
  });

  it("keeps a bare terminal Working line above the ready composer busy", () => {
    const text = `Claude Code v2.1\nWorking (2s • esc to interrupt)\n\n❯ \n${bypass}`;
    const parsed = parseScreen(text);
    expect(hasVisibleAgentProgress(text, "claude")).toBe(true);
    expect(parsed.status).toBe("working");
    expect(parsed.control_state).toBe("busy");
  });

  it("ignores older terminal activity before the latest Claude reply", () => {
    const text = `Claude Code v2.1\nWorking (2s • esc to interrupt)\n⏺ The report is ready.\n\n❯ \n${bypass}`;
    expect(hasVisibleAgentProgress(text, "claude")).toBe(false);
    expect(parseScreen(text).status).toBe("idle");
  });

  it("keeps an unresolved tool call busy without a result line", () => {
    const parsed = parseScreen(`Claude Code v2.1\n⏺ Bash(true)\n\n❯ \n${bypass}`);
    expect(parsed.status).toBe("working");
    expect(parsed.control_state).toBe("busy");
  });
});
