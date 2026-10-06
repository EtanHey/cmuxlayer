import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { classifyPromptDisposition, hasVisibleAgentProgress, isCodexAccountSecurityBanner, isBlockingPromptChooserScreen, isPickerOrMenuScreen, parseScreen } from "../src/screen-parser.js";
import { screenConfirmedAgentState } from "../src/live-agent-state.js";
import { dismissAccountSecurityBanner } from "../src/delivery/account-security.js";

const capture = (name: string) => readFileSync(new URL(`./fixtures/composer-overlays/${name}.txt`, import.meta.url), "utf8");
const daybreak = capture("codex-daybreak-synthetic");
const composer = "› Ask Codex to do anything\nGPT-6-Luna low · ~/scratch\n? for shortcuts";
const capacity = `■ Selected model is at capacity. Please try a different model.\n\n${composer}`;
describe("Codex silent stalls (Daybreak fixture is synthetic)", () => {
  it.each(["codex-boot", "codex-daybreak-real", "codex-daybreak-real-draft"])("P0 nonblocking %s parses normal chrome", name => {
    const screen = capture(name);
    const parsed = parseScreen(screen);
    expect(parsed.agent_type).toBe("codex");
    expect(parsed.status).not.toBe("frozen");
    expect(parsed.control_state).not.toBe("interactive_overlay");
    expect(parsed.errors).not.toContain("interactive_prompt");
    expect(isBlockingPromptChooserScreen(screen)).toBe(false);
    expect(isPickerOrMenuScreen(screen, "codex")).toBe(false);
    expect(classifyPromptDisposition(screen, "codex")).toEqual({ kind: "none" });
  });

  it.each([
    ["real capture", capture("codex-boot")],
    ["Daybreak without composer", daybreak],
    ["Daybreak with composer", `${daybreak}\n${composer}`],
    ["wrapped composed draft", `${daybreak}\n› Read synthetic instructions\n  and preserve wrapped input\nGPT-6-Luna low · ~/scratch`],
    ["case insensitive, arbitrary option", daybreak.replace("security for Daybreak mode", "SECURITY check").replace("Continue security setup", "Enable protection")],
    ["Advanced Account Security only", daybreak.replace("security for Daybreak mode", "Advanced Account Security")],
  ])("keeps %s nonblocking alongside ordinary activity", (_name, modal) => {
    const screen = `OpenAI Codex\n• Working (3s • esc to interrupt)\nPREVIOUS_SYNTHETIC_TASK_DONE\n${modal}`;
    expect(isCodexAccountSecurityBanner(screen)).toBe(true);
    expect(parseScreen(screen).errors).not.toContain("interactive_prompt");
    expect(classifyPromptDisposition(screen, "codex")).not.toMatchObject({ kind: "escalate" });
    expect(hasVisibleAgentProgress(screen, "codex")).toBe(true);
  });

  it.each([
    daybreak.replace("security for Daybreak mode", "Choose a color").replace("Continue security setup", "Pick blue"),
    `${daybreak}\n• The modal was dismissed.\n${composer}`,
    `${daybreak}\n${composer}\nWorking (3s • esc to interrupt)`,
    `${daybreak}\n${composer}\n› A newer user turn`,
    `${daybreak}\nGPT-6-Luna low · ~/scratch\nA newer response`,
    `${daybreak}\n${Array.from({ length: 45 }, () => "old history").join("\n")}\n${composer}`,
    daybreak.replace("› 1.", "  1."),
  ])("does not authorize Esc for an unrelated or historical footer", screen => {
    expect(isCodexAccountSecurityBanner(screen)).toBe(false);
  });

  it("surfaces the latest capacity error despite historical activity and done", () => {
    const parsed = parseScreen(`OpenAI Codex\n• Working (3s • esc to interrupt)\nPREVIOUS_SYNTHETIC_TASK_DONE\n${capacity}`);
    expect(parsed).toMatchObject({ agent_type: "codex", status: "frozen", errors: ["model_at_capacity"] });
    expect(parsed.control_state).not.toBe("ready");
    expect(screenConfirmedAgentState(parsed)).toBe("error");
    expect(hasVisibleAgentProgress(capacity, "codex")).toBe(false);
  });

  it.each([
    `■ Selected model is at capacity. Please try a different model.\n• Recovered with the current model.\n${composer}`,
    `› Quote: ■ Selected model is at capacity. Please try a different model.\n${composer}`,
    "Claude Code\n■ Selected model is at capacity. Please try a different model.\n❯",
  ])("ignores historical, quoted, and non-Codex capacity text", screen => {
    expect(parseScreen(screen).errors).not.toContain("model_at_capacity");
  });

  it("does not Esc or audit an account-security notice as a recovery", async () => {
    const escape = vi.fn(); const read = vi.fn(); const appendAccountSecurityBanner = vi.fn();
    const screen = { text: daybreak };
    expect(await dismissAccountSecurityBanner(screen, { escape, read }, {
      agent_id: "synthetic-child", surface: "surface:synthetic", eventLog: { appendAccountSecurityBanner },
    })).toBe(screen);
    expect(escape).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(appendAccountSecurityBanner).not.toHaveBeenCalled();
  });
});
