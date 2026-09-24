import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bootReadinessDriftNote,
  geminiScreenSignature,
  matchReadyPattern,
  screenHasActiveAgentMarker,
  screenHasReadyAgentIdentity,
} from "../src/pattern-registry.js";
import { parseScreen } from "../src/screen-parser.js";

// repoGolem's `{repo}Gemini` launches the Antigravity CLI (`agy` 1.2.10), not the
// old gemini CLI. Fixtures are verbatim `read_screen raw:true` / `cmux read-screen`
// captures of live Antigravity panes (issue #799).
const readFixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/gemini-antigravity/${name}`, import.meta.url),
    "utf8",
  );

const WORKING = [
  // banner + spinner + `esc to cancel` footer + a running task row
  "working-banner-esc-footer.txt",
  // spinner + queued message + running task rows, no banner
  "working-queued-tasks-pro-low.txt",
  "working-queued-pro-high.txt",
  // spinner + queued message only: no banner, no `esc to cancel`, no task rows
  "working-spinner-only-pro-low.txt",
  "working-spinner-only-pro-high.txt",
  // live-proof pane (surface:918): `esc to cancel` footer, spinner, and the
  // boot text's second paragraph left as a composer draft
  "working-esc-footer-contract-draft-pro-high.txt",
] as const;

const IDLE = [
  "idle-finished-reply-pro-high.txt",
  "boot-ready-flash.txt",
  "boot-ready-pro-high.txt",
] as const;

describe("Antigravity CLI screens (cli: gemini)", () => {
  for (const name of [...WORKING, ...IDLE, "idle-reply-contract-draft-pro-high.txt"]) {
    it(`${name}: identifies as gemini with its footer model`, () => {
      const text = readFixture(name);
      const parsed = parseScreen(text);
      expect(parsed.agent_type).toBe("gemini");
      expect(parsed.model).toBe(
        name.includes("flash") ? "gemini-3.8-flash" : "gemini-3.1-pro",
      );
      expect(parsed.context_window).toBe(1_048_576);
      expect(screenHasReadyAgentIdentity("gemini", text)).toBe(true);
    });
  }

  for (const name of WORKING) {
    it(`${name}: is working and never ready`, () => {
      const text = readFixture(name);
      expect(parseScreen(text).status).toBe("working");
      expect(screenHasActiveAgentMarker("gemini", text)).toBe(true);
      expect(matchReadyPattern("gemini", text).matched).toBe(false);
    });
  }

  for (const name of IDLE) {
    it(`${name}: is idle and ready despite past-tense Thought rows`, () => {
      const text = readFixture(name);
      expect(parseScreen(text).status).toBe("idle");
      expect(screenHasActiveAgentMarker("gemini", text)).toBe(false);
      expect(matchReadyPattern("gemini", text).matched).toBe(true);
    });
  }

  it("does not count a thought row's token count as context usage", () => {
    const parsed = parseScreen(readFixture("idle-finished-reply-pro-high.txt"));
    expect(parsed.token_count).toBeNull();
    expect(parsed.context_pct).toBeNull();
  });

  it("does not count running background tasks as a busy turn", () => {
    // upstream-sources.md §C.5: task rows and the `N task(s) · /tasks` footer
    // segment persist while agy is idle.
    const text = readFixture("idle-finished-reply-pro-high.txt").replace(
      /\n(─+)\n\? for shortcuts {2,}Gemini 3\.1 Pro · high/,
      "\n$1\n  ● [18:57:30] grep -rn \"APEX_SEATS\" . running\n$1\n? for shortcuts                                    Gemini 3.1 Pro · high · 1 task(s) · /tasks",
    );
    expect(text).toContain("1 task(s) · /tasks");
    expect(parseScreen(text).status).toBe("idle");
    expect(screenHasActiveAgentMarker("gemini", text)).toBe(false);
    expect(matchReadyPattern("gemini", text).matched).toBe(true);
  });

  it("live proof pane: reply finished with an unsent draft is idle but not ready", () => {
    const text = readFixture("idle-reply-contract-draft-pro-high.txt");
    expect(parseScreen(text).agent_type).toBe("gemini");
    expect(parseScreen(text).status).toBe("idle");
    expect(screenHasActiveAgentMarker("gemini", text)).toBe(false);
    expect(matchReadyPattern("gemini", text).matched).toBe(false);
  });

  it("is not ready while the composer holds a draft below a bare `>`", () => {
    const text = readFixture("boot-ready-flash.txt").replace(
      /\n>\n(─+)\n\? for shortcuts +/,
      "\n>\n  cmuxlayer contract for x: Read and follow\n  ~/.cmux/agents/x/contract.md\n$1\n                    ",
    );
    expect(text).toContain("contract.md");
    expect(screenHasActiveAgentMarker("gemini", text)).toBe(false);
    expect(matchReadyPattern("gemini", text).matched).toBe(false);
  });

  it("is not ready while an approval dialog sits in the composer region", () => {
    // No agy approval specimen exists yet; the dialog is placed where a live
    // dialog can be (between the composer and the footer), never in transcript.
    const text = readFixture("idle-finished-reply-pro-high.txt").replace(
      /\n>\n(─+)\n/,
      "\n>\n$1\n⚠ Approval Required\n  Do you want to proceed?\n$1\n",
    );
    expect(text).toContain("⚠ Approval Required");
    expect(matchReadyPattern("gemini", text).matched).toBe(false);
  });

  it("stays ready when the reply transcript merely quotes approval wording (review F1)", () => {
    const text = readFixture("idle-finished-reply-pro-high.txt").replace(
      "  I have read the contract.",
      "  Plan drafted. Do you want to proceed?\n  ⚠ Approval Required was shown earlier.\n  I have read the contract.",
    );
    expect(text).toContain("Do you want to proceed?");
    expect(parseScreen(text).status).toBe("idle");
    expect(matchReadyPattern("gemini", text).matched).toBe(true);
  });

  it("does not claim a Claude pane that quotes Antigravity chrome", () => {
    const text = [
      "Claude Code",
      "● Read(specimens/working-surface903.txt)",
      "      ▄▀▀▄        Antigravity CLI 1.2.10",
      "esc to cancel                                    Gemini 3.1 Pro · low · 1 task(s) · /tasks",
      "",
      "❯ ",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(parseScreen(text).agent_type).toBe("claude");
  });

  for (const [label, banner] of [
    ["after a transcript row", ["  ⬢ Read specimens/working-surface903.txt"]],
    ["before any transcript row", []],
  ] as const) {
    it(`does not claim a Cursor pane that quotes the agy banner ${label} (review F2)`, () => {
      const text = [
        "  Cursor Agent",
        "  v2026.06.04-5fd875e",
        "",
        ...banner,
        "      ▄▀▀▄        Antigravity CLI 1.2.10",
        "     ▀▀▀▀▀▀       user@example.com (Google AI Pro)",
        "    ▀▀▀▀▀▀▀▀      Gemini 3.1 Pro (Low)",
        "",
        "  → Add a follow-up",
        "  Auto · 12% · 1 file edited",
      ].join("\n");
      expect(parseScreen(text).agent_type).toBe("cursor");
      expect(geminiScreenSignature(text)).toBe("unrecognized_screen");
    });
  }

  it("drift note stays silent on a plain shell prompt (agy never launched; review F3)", () => {
    expect(bootReadinessDriftNote("gemini", "etanheyman ~  $ cmuxlayerGemini -s\n")).toBe("");
    expect(bootReadinessDriftNote("gemini", "user@host ~ % \n")).toBe("");
  });

  it("is not ready while agy is still loading (banner and composer, no model footer yet)", () => {
    const text = readFixture("boot-loading-no-model-flash.txt");
    expect(parseScreen(text).agent_type).toBe("gemini");
    expect(screenHasReadyAgentIdentity("gemini", text)).toBe(true);
    expect(matchReadyPattern("gemini", text).matched).toBe(false);
  });

  it("drift check: names the gemini screen signature, or unrecognized_screen", () => {
    expect(geminiScreenSignature(readFixture("working-banner-esc-footer.txt"))).toBe("antigravity");
    expect(geminiScreenSignature(readFixture("working-spinner-only-pro-low.txt"))).toBe("antigravity");
    expect(geminiScreenSignature("Gemini CLI\n> ")).toBe("gemini_cli");
    expect(geminiScreenSignature("gemini> ")).toBe("gemini_cli");
    expect(geminiScreenSignature("Some Future CLI 9.0\n\n> \n? for help")).toBe(
      "unrecognized_screen",
    );
  });

  it("drift check: a gemini boot timeout on an unrecognized screen says so", () => {
    const unknown = "Some Future CLI 9.0\n\n> \n? for help";
    expect(bootReadinessDriftNote("gemini", unknown)).toMatch(/unrecognized_screen/);
    expect(bootReadinessDriftNote("gemini", readFixture("boot-ready-flash.txt"))).toBe("");
    expect(bootReadinessDriftNote("codex", unknown)).toBe("");
    expect(bootReadinessDriftNote(undefined, unknown)).toBe("");
    expect(bootReadinessDriftNote("gemini", "")).toBe("");
  });
});
