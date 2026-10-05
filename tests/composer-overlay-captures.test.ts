import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { isPickerOrMenuScreen, parseScreen } from "../src/screen-parser.js";
import { composerPickerInputRegion } from "../src/delivery/composer-screen.js";
import { dismissAccountSecurityBanner } from "../src/delivery/account-security.js";

const capture = (name: string) => readFileSync(new URL(`./fixtures/composer-overlays/${name}.txt`, import.meta.url), "utf8");

describe("#999(e) real captured composer overlays", () => {
  it.each([
    ["codex-mention", "codex", "@999e_no_match_capture"],
    ["codex-slash", "codex", "/"],
    ["claude-slash", "claude", "/"],
    ["cursor-path", "cursor", "/999e_no_match_capture"],
  ] as const)("recognizes %s and reads only its draft", (name, cli, draft) => {
    expect(isPickerOrMenuScreen(capture(name), cli)).toBe(true);
    expect(composerPickerInputRegion(capture(name), cli)).toBe(draft);
  });

  it("recognizes the security banner as blocked input, even above a ready composer", () => {
    expect(isPickerOrMenuScreen(capture("codex-boot"), "codex")).toBe(true);
    expect(parseScreen(capture("codex-boot")).control_state).not.toBe("ready");
  });

  it("waits for a slow security-banner redraw after exactly one Esc", async () => {
    const banner = { text: capture("codex-boot") };
    const closed = { text: capture("codex-dismissed") };
    const escape = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValueOnce(banner).mockResolvedValue(closed);
    expect(await dismissAccountSecurityBanner(banner, { escape, read })).toBe(closed);
    expect(escape).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
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
