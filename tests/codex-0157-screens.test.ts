// #905: Codex 0.157 queue blocks and draft status, read from real captures
// (tests/fixtures/codex-0.157/README.md).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScreen } from "../src/screen-parser.js";
import {
  countVisibleExactQueuedRows,
  screenShowsQueuedAgentInput,
} from "../src/delivery/composer-screen.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/codex-0.157/${name}.txt`, import.meta.url), "utf8");

const LONG =
  "Read and follow ~/Gits/cmuxlayer/docs.local/lanes/2026-09-27-905-opus-scratch-capture-only-do-not-act-on-this-pointer.md then reply with a one-line summary.";
const DATE = "Then print the current date.";
const LIST = "Please also list the files in this folder when you finish.";
const BRANCH = "Also tell me the git branch.";

describe("#905 Codex 0.157 queue blocks", () => {
  it("recognises a Tab-queued follow-up as queued, not delivered", () => {
    expect(screenShowsQueuedAgentInput(fixture("midturn-followup-queued"), DATE)).toBe(true);
    expect(screenShowsQueuedAgentInput(fixture("midturn-followup-queued"), BRANCH)).toBe(false);
  });

  it("recognises items in both stacked blocks, including a wrapped steer item", () => {
    const screen = fixture("midturn-steer-and-followup-queued");
    expect(screenShowsQueuedAgentInput(screen, LONG)).toBe(true);
    expect(screenShowsQueuedAgentInput(screen, DATE)).toBe(true);
    expect(screenShowsQueuedAgentInput(screen, DATE, { exact: true })).toBe(true);
    expect(countVisibleExactQueuedRows(screen, DATE)).toBe(1);
  });

  // Round 2 (review finding 3): an indented `↳` row continues the item above
  // it; it was never queued on its own.
  it("treats an indented arrow row as a continuation, not a second item", () => {
    const screen = "OpenAI Codex\n• Queued follow-up inputs\n  ↳ Other text\n    ↳ Then print the current date.\n\n" +
      "› Ask Codex to do anything\n  gpt-6-sol medium · ~/Gits/cmuxlayer\n";
    expect(screenShowsQueuedAgentInput(screen, DATE, { exact: true })).toBe(false);
    expect(countVisibleExactQueuedRows(screen, DATE)).toBe(0);
    expect(screenShowsQueuedAgentInput(screen, `Other text ↳ ${DATE}`)).toBe(true);
  });

  it("keeps the pre-0.157 single steer block working", () => {
    expect(screenShowsQueuedAgentInput(fixture("midturn-steer-queued"), LIST)).toBe(true);
    expect(screenShowsQueuedAgentInput(fixture("midturn-wrapped-steer-queued"), LONG)).toBe(true);
  });
});

describe("#905 Codex 0.157 draft status", () => {
  it("reports a new draft under queue blocks as draft_pending, not working", () => {
    const parsed = parseScreen(fixture("midturn-draft-under-queues"));
    expect(parsed.status).toBe("draft_pending");
    expect(parsed.control_state).toBe("composer_dirty");
  });

  it("keeps an empty composer under queue blocks busy", () => {
    expect(parseScreen(fixture("midturn-steer-and-followup-queued")).control_state).toBe("busy");
    expect(parseScreen(fixture("midturn-steer-queued")).control_state).toBe("busy");
  });
});
