import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPickerOrMenuScreen, parseScreen } from "../src/screen-parser.js";
import { composerPickerInputRegion } from "../src/delivery/composer-screen.js";

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

  it.each(["codex-dismissed", "cursor-closed", "claude-closed"])("does not mistake Esc-closed %s for an overlay", name => {
    expect(isPickerOrMenuScreen(capture(name))).toBe(false);
  });
});
