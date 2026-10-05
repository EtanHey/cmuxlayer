import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPromptDisposition, hasVisibleAgentProgress, isCodexAccountSecurityBanner, parseScreen } from "../src/screen-parser.js";
import { screenConfirmedAgentState } from "../src/live-agent-state.js";
import { dismissAccountSecurityBanner } from "../src/delivery/account-security.js";
import { EventLog } from "../src/event-log.js";
import { disableDaemonLog, enableDaemonLog, flushDaemonLog } from "../src/daemon-log.js";

const capture = (name: string) => readFileSync(new URL(`./fixtures/composer-overlays/${name}.txt`, import.meta.url), "utf8");
const daybreak = capture("codex-daybreak-synthetic");
const composer = "› Ask Codex to do anything\nGPT-6-Luna low · ~/scratch\n? for shortcuts";
const capacity = `■ Selected model is at capacity. Please try a different model.\n\n${composer}`;
const roots: string[] = [];
afterEach(async () => {
  await flushDaemonLog(); disableDaemonLog(); vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex silent stalls (Daybreak fixture is synthetic)", () => {
  it.each([
    ["real capture", capture("codex-boot")],
    ["Daybreak without composer", daybreak],
    ["Daybreak with composer", `${daybreak}\n${composer}`],
    ["wrapped composed draft", `${daybreak}\n› Read synthetic instructions\n  and preserve wrapped input\nGPT-6-Luna low · ~/scratch`],
    ["case insensitive, arbitrary option", daybreak.replace("security for Daybreak mode", "SECURITY check").replace("Continue security setup", "Enable protection")],
    ["Advanced Account Security only", daybreak.replace("security for Daybreak mode", "Advanced Account Security")],
  ])("blocks %s and escalates instead of treating historical activity as progress", (_name, modal) => {
    const screen = `OpenAI Codex\n• Working (3s • esc to interrupt)\nPREVIOUS_SYNTHETIC_TASK_DONE\n${modal}`;
    expect(isCodexAccountSecurityBanner(screen)).toBe(true);
    expect(parseScreen(screen)).toMatchObject({ agent_type: "codex", status: "frozen", control_state: "interactive_overlay", errors: ["interactive_prompt"] });
    expect(classifyPromptDisposition(screen, "codex")).toEqual({ kind: "escalate", prompt_type: "human_or_unknown_chooser" });
    expect(hasVisibleAgentProgress(screen, "codex")).toBe(false);
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

  it.each(["dismissed", "failed", "escape failure", "read failure"] as const)("records %s in both logs after exactly one Esc", async outcome => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "cmux-stall-")); roots.push(root);
    const logPath = join(root, "daemon.log"); enableDaemonLog({ path: logPath });
    const eventLog = new EventLog(root);
    const escape = vi.fn(async () => { if (outcome === "escape failure") throw new Error("write failed"); });
    const read = vi.fn(async () => {
      if (outcome === "read failure") throw new Error("read failed");
      return { text: outcome === "dismissed" ? composer : daybreak };
    });
    const operation = dismissAccountSecurityBanner({ text: daybreak }, { escape, read }, {
      agent_id: "synthetic-child", surface: "surface:synthetic", eventLog,
    });
    const settled = operation.then(() => "dismissed", () => "failed");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await settled).toBe(outcome === "dismissed" ? "dismissed" : "failed");
    expect(escape).toHaveBeenCalledTimes(1);
    await flushDaemonLog();
    const fields = { agent_id: "synthetic-child", surface: "surface:synthetic", variant: "daybreak", outcome: outcome === "dismissed" ? "dismissed" : "failed" };
    expect(eventLog.readEntries()).toEqual([expect.objectContaining({ event_type: "account_security_banner", ...fields })]);
    expect(eventLog.readAll()).toEqual([]);
    expect(eventLog.readForAgent("synthetic-child")).toEqual([]);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" account_security_banner ");
    for (const [key, value] of Object.entries(fields)) expect(lines[0]).toContain(`${key}=${value}`);
  });
});
