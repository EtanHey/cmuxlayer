import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyPromptDisposition,
  containsPromptApprovalChooser,
  isPickerOrMenuScreen,
  parseScreen,
} from "../src/screen-parser.js";

interface CorpusFrame {
  id: string;
  file: string;
  redacted_sha256: string;
  expected_status: string;
  expected_control_state: string;
  expected_current_action: string | null;
  expected_response_prefix: string | null;
  expected_errors?: string[];
  capture_method: string;
}

const corpus = JSON.parse(
  readFileSync(new URL("./fixtures/a3-claude/manifest.json", import.meta.url), "utf8"),
) as { frames: CorpusFrame[] };

describe("A3 Claude screen corpus", () => {
  it.each(corpus.frames)("classifies $id", (frame) => {
    const text = readFileSync(
      new URL(`./fixtures/a3-claude/${frame.file}`, import.meta.url),
      "utf8",
    );
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      frame.redacted_sha256,
    );
    // The soak's two marker-only candidate previews contain no proven
    // authored final reply. Keep them in the corpus without inventing a label.
    if (frame.expected_status === "review_needed") return;

    const parsed = parseScreen(text);
    expect(parsed.agent_type).toBe("claude");
    expect(parsed.status).toBe(frame.expected_status);
    expect(parsed.control_state).toBe(frame.expected_control_state);
    if (frame.expected_errors) {
      expect(parsed.errors).toEqual(expect.arrayContaining(frame.expected_errors));
    }
    if (frame.expected_current_action === null) {
      expect(parsed.current_action).toBeNull();
    } else if (frame.expected_current_action.startsWith("non-null")) {
      expect(parsed.current_action).toBeTruthy();
    } else {
      expect(parsed.current_action).toContain(frame.expected_current_action);
    }
    if (frame.expected_response_prefix === null) {
      expect(parsed.response).toBeNull();
    } else {
      expect(parsed.response).toContain(frame.expected_response_prefix);
    }
    if (frame.capture_method === "reconstruction") {
      expect(containsPromptApprovalChooser(text)).toBe(true);
      expect(isPickerOrMenuScreen(text, "claude")).toBe(true);
      expect(classifyPromptDisposition(text, "claude")).toEqual({
        kind: "escalate",
        prompt_type: "permission_prompt",
      });
    }
  });

  it.each(["·", "✢", "✳", "✶", "✻", "✽"])(
    "keeps Claude %s elapsed spinner busy above a ready-looking composer",
    (glyph) => {
      const parsed = parseScreen(
        `Claude Code\n${glyph} Sublimating… (1s)\n❯\n  ⎇ main | 🔧 13`,
      );
      expect(parsed.status).toBe("working");
      expect(parsed.control_state).toBe("busy");
      expect(parsed.current_action).toBe("Sublimating");
      expect(parsed.response).toBeNull();
    },
  );

  it.each([
    ["✻ Working", "Working"],
    ["· Sublimating…", "Sublimating"],
  ])("keeps untimed Claude spinner %s busy", (line, action) => {
    const parsed = parseScreen(`Claude Code\n${line}\n❯`);
    expect(parsed.status).toBe("working");
    expect(parsed.control_state).toBe("busy");
    expect(parsed.current_action).toBe(action);
  });

  it.each(["✻", "·"])("keeps unresolved bare spinner %s busy", (glyph) => {
    const parsed = parseScreen(`Claude Code\n${glyph}\n❯`);
    expect(parsed.status).toBe("working");
    expect(parsed.control_state).toBe("busy");
  });

  it("keeps an unresolved bare Claude glyph busy", () => {
    const parsed = parseScreen("Claude Code\n⏺ Running tests\n❯");
    expect(parsed.status).toBe("working");
    expect(parsed.control_state).toBe("busy");
    expect(parsed.response).toBeNull();
  });

  it("keeps a command-shaped action busy without a path target", () => {
    const parsed = parseScreen("Claude Code\n⏺ Running npm test");
    expect(parsed.status).toBe("working");
    expect(parsed.current_action).toBe("Running npm test");
  });

  it("keeps a finished Claude reply idle after the spinner disappears", () => {
    const parsed = parseScreen(
      "Claude Code\n⏺ Read the report: it has two lines.\n✻ Worked for 4s · done\n❯",
    );
    expect(parsed.status).toBe("idle");
    expect(parsed.control_state).toBe("ready");
    expect(parsed.response).toContain("Read the report: it has two lines.");
    expect(parsed.current_action).toBeNull();
  });

  it("treats a Completed sentence as a reply rather than completion chrome", () => {
    const parsed = parseScreen(
      "Claude Code\n⏺ Completed the parser explanation.\n❯",
    );
    expect(parsed.status).toBe("idle");
    expect(parsed.response).toContain("Completed the parser explanation.");
  });
});
