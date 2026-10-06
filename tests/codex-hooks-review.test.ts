import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { classifyPromptDisposition, hasVisibleAgentProgress, isPickerOrMenuScreen, parseScreen } from "../src/screen-parser.js";
import { composerHoldsForeignDraft, extractComposerInputRegion } from "../src/delivery/composer-screen.js";
import { dismissAccountSecurityBanner } from "../src/delivery/account-security.js";
import { EventLog } from "../src/event-log.js";
import { disableDaemonLog, enableDaemonLog, flushDaemonLog } from "../src/daemon-log.js";
import * as daemonLog from "../src/daemon-log.js";

const hooks = readFileSync(new URL("./fixtures/composer-overlays/codex-hooks-review.txt", import.meta.url), "utf8");
const composer = "› Ask Codex to do anything\nGPT-6-Luna low · ~/scratch";
const roots: string[] = [];
it.each([
  { kind: "hooks", screen: hooks, outcome: "dismissed" }, { kind: "hooks", screen: hooks, outcome: "read failure" },
  { kind: "hooks", screen: hooks, outcome: "stuck" },
])("audit failure preserves $kind dismissal result: $outcome", async ({ kind, screen, outcome }) => {
  vi.useFakeTimers();
  const stderr = vi.spyOn(console, "error").mockReturnValue(undefined);
  const root = mkdtempSync(join(tmpdir(), "cmux-overlay-audit-failure-")); roots.push(root);
  const eventLog = new EventLog(root);
  // A directory at the append path fails real filesystem I/O, even as root.
  mkdirSync(join(root, "events.jsonl"));
  const logPath = join(root, "daemon.log"); enableDaemonLog({ path: logPath });
  const originalError = new Error("synthetic read failure");
  const escape = vi.fn().mockResolvedValue(undefined);
  const read = outcome === "read failure" ? vi.fn().mockRejectedValue(originalError) : vi.fn().mockResolvedValue({ text: outcome === "stuck" ? screen : composer });
  const pending = dismissAccountSecurityBanner({ text: screen }, { escape, read }, { agent_id: "synthetic-audit", surface: "surface:synthetic", eventLog });
  const settled = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await vi.advanceTimersByTimeAsync(1_100);
  const result = await settled;
  if (outcome === "dismissed") expect(result).toEqual({ value: { text: composer }, error: null });
  else expect(result.error).toMatchObject({ error_code: "hooks_review_not_dismissed" });
  expect(escape).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(outcome === "stuck" ? 5 : 1);
  await flushDaemonLog();
  expect(stderr).toHaveBeenCalledWith("[cmuxlayer] account_security_banner audit failed", expect.objectContaining({ agent_id: "synthetic-audit", variant: kind === "hooks" ? "hooks_review" : "daybreak", error_name: "Error" }));
});
afterEach(async () => {
  await flushDaemonLog(); disableDaemonLog(); vi.useRealTimers(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([hooks, `${hooks}\n${"\n".repeat(60)}`, `OpenAI Codex\n• Working (3s • esc to interrupt)\nOLD_TASK_DONE\n${hooks}`, `${hooks}\n${composer}`,
  hooks.replace("› 1.", "  1.").replace("  2.", "› 2.")])("recognizes current Hooks review as Codex blocked input, never a foreign draft", screen => {
  expect(parseScreen(screen)).toMatchObject({ agent_type: "codex", status: "frozen", control_state: "interactive_overlay", errors: ["interactive_prompt"] });
  expect(classifyPromptDisposition(screen, "codex")).toEqual({ kind: "escalate", prompt_type: "human_or_unknown_chooser" });
  expect(hasVisibleAgentProgress(screen, "codex")).toBe(false);
  expect(isPickerOrMenuScreen(screen, "codex")).toBe(true);
  expect(extractComposerInputRegion(screen, "synthetic boot", "codex")).toBeNull();
  expect(composerHoldsForeignDraft(screen, "synthetic boot", { cli: "codex" })).toBe(false);
});

it.each([
  hooks.replace("Hooks need review", "Choose a color"),
  hooks.replace("  3. Continue without trusting (hooks won't run)", ""),
  hooks.replace("enter confirm · esc skip", ""),
  hooks.replace("› 1.", "  1."),
  `${hooks}\n• A newer response\n${composer}`,
  `${hooks}\n${composer}\nWorking (3s • esc to interrupt)`,
  `${hooks}\n${"old history\n".repeat(45)}${composer}`,
])("never auto-dismisses incomplete or historical Hooks review text", async screen => {
  const escape = vi.fn(); const read = vi.fn();
  expect(await dismissAccountSecurityBanner({ text: screen }, { escape, read })).toEqual({ text: screen });
  expect(escape).not.toHaveBeenCalled();
});

it.each(["dismissed", "stuck", "escape failure", "read failure"])("Hooks review uses one Esc and audits %s without trusting", async outcome => {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "cmux-hooks-review-")); roots.push(root);
  const logPath = join(root, "daemon.log"); enableDaemonLog({ path: logPath });
  const eventLog = new EventLog(root);
  const escape = vi.fn(async () => { if (outcome === "escape failure") throw new Error("write failed"); });
  const read = vi.fn(async () => {
    if (outcome === "read failure") throw new Error("read failed");
    return { text: outcome === "stuck" ? hooks : composer };
  });
  const pending = dismissAccountSecurityBanner({ text: hooks }, { escape, read }, { agent_id: "synthetic-hooks", surface: "surface:synthetic", eventLog });
  const settled = pending.then(value => ({ value, code: null }), error => ({ value: null, code: error.error_code }));
  await vi.advanceTimersByTimeAsync(1_100);
  expect(await settled).toMatchObject(outcome === "dismissed" ? { value: { text: composer }, code: null } : { code: "hooks_review_not_dismissed" });
  expect(escape).toHaveBeenCalledTimes(1);
  expect(read.mock.calls.length).toBeLessThanOrEqual(5);
  await flushDaemonLog();
  const fields = { agent_id: "synthetic-hooks", surface: "surface:synthetic", variant: "hooks_review", outcome: outcome === "dismissed" ? "dismissed" : "failed" };
  expect(eventLog.readEntries()).toEqual([expect.objectContaining(fields)]);
  const lines = readFileSync(logPath, "utf8").trim().split("\n"); expect(lines).toHaveLength(1);
  for (const [key, value] of Object.entries(fields)) expect(lines[0]).toContain(`${key}=${value}`);
});

it("daemon audit failure cannot replace a successful dismissal", async () => {
  vi.useFakeTimers();
  const stderr = vi.spyOn(console, "error").mockReturnValue(undefined);
  vi.spyOn(daemonLog, "appendDaemonLog").mockImplementation(() => { throw new Error("synthetic daemon audit failure"); });
  const appendAccountSecurityBanner = vi.fn();
  const escape = vi.fn().mockResolvedValue(undefined);
  const pending = dismissAccountSecurityBanner({ text: hooks }, { escape, read: vi.fn().mockResolvedValue({ text: composer }) }, {
    agent_id: "synthetic-audit", surface: "surface:synthetic", eventLog: { appendAccountSecurityBanner },
  });
  const settled = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await vi.advanceTimersByTimeAsync(1_100);
  expect(await settled).toEqual({ value: { text: composer }, error: null });
  expect(escape).toHaveBeenCalledTimes(1);
  expect(stderr).toHaveBeenCalledWith("[cmuxlayer] account_security_banner audit failed", expect.objectContaining({ variant: "hooks_review", error_name: "Error" }));
});
