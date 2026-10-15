import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isPickerOrMenuScreen, parseScreen } from "../src/screen-parser.js";
import { composerPickerInputRegion, composerRegionMatchesPayload } from "../src/delivery/composer-screen.js";
import { dismissAccountSecurityBanner } from "../src/delivery/account-security.js";

const capture = (name: string) => readFileSync(new URL(`./fixtures/composer-overlays/${name}.txt`, import.meta.url), "utf8");

describe("#999(e) real captured composer overlays", () => {
  it("reads and owns every wrapped row of the Cursor 2026.10.14 boot pointer", () => {
    const screen = capture("cursor-2026-10-14-boot-path");
    const payload = "Read and follow /home/fixtureusrx/Gits/cmuxlayer/.worktrees/cursor-submit/docs.local/cursor-submit/live-capture/goals/cursor-01.md";
    const region = composerPickerInputRegion(screen, "cursor");
    expect(region).toBe("Read and follow /home/fixtureusrx/Gits/cmuxlayer/.worktrees/cursor-submit/docs.local/\n    cursor-submit/live-capture/goals/cursor-01.md");
    expect(composerRegionMatchesPayload(region!, payload, "cursor", screen)).toBe(true);
    expect(composerRegionMatchesPayload(region!, payload.replace("goals", "other"), "cursor", screen)).toBe(false);
  });
  it("retains even a matching-width authored rule before the actual lower border", () => {
    const screen = capture("cursor-path");
    const border = screen.split("\n").find(line => /^\s*▀{8,}$/u.test(line))!;
    const edited = screen.replace("/999e_no_match_capture", `/999e_no_match_capture\n${border}\n    human change`);
    const region = composerPickerInputRegion(edited, "cursor");
    expect(region).toContain("human change");
    expect(composerRegionMatchesPayload(region!, "/999e_no_match_capture", "cursor", edited)).toBe(false);
  });
  it.each([
    ["codex-mention", "codex", "@999e_no_match_capture"],
    ["codex-slash", "codex", "/"],
    ["claude-slash", "claude", "/"],
    ["cursor-path", "cursor", "/999e_no_match_capture"],
  ] as const)("recognizes %s and reads only its draft", (name, cli, draft) => {
    expect(isPickerOrMenuScreen(capture(name), cli)).toBe(true);
    expect(composerPickerInputRegion(capture(name), cli)).toBe(draft);
  });

  it("treats the security banner as normal chrome above the composer", () => {
    expect(isPickerOrMenuScreen(capture("codex-boot"), "codex")).toBe(false);
    expect(parseScreen(capture("codex-boot")).control_state).toBe("ready");
  });

  it("leaves a security notice alone without Esc or reread", async () => {
    const banner = { text: capture("codex-boot") };
    const escape = vi.fn(); const read = vi.fn();
    expect(await dismissAccountSecurityBanner(banner, { escape, read })).toBe(banner);
    expect(escape).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it.each(["codex-dismissed", "cursor-closed", "claude-closed"])("does not mistake Esc-closed %s for an overlay", name => {
    expect(isPickerOrMenuScreen(capture(name))).toBe(false);
  });

  it("keeps a historical completion footer inactive below a later empty composer", () => {
    const stale = capture("codex-mention").replace("@999e_no_match_capture", "Ask Codex to do anything");
    expect(isPickerOrMenuScreen(stale, "codex")).toBe(false);
  });

  it("recognizes a Claude slash menu with 45 options from captured rows", () => {
    const rows = capture("claude-slash").split("\n");
    const options = rows.filter(line => /^\s*\/\w[\w-]*\s{2,}\S/u.test(line));
    const first = rows.findIndex(line => line === options[0]);
    expect(options.length).toBeGreaterThan(0);
    const long = [...rows.slice(0, first), ...Array.from({ length: 45 }, (_, i) => options[i % options.length])].join("\n");
    expect(isPickerOrMenuScreen(long, "claude")).toBe(true);
    expect(composerPickerInputRegion(long, "claude")).toBe("/");
  });
});
