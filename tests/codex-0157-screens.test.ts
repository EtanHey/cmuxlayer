// #905: Codex 0.157 queue blocks and draft status, read from real captures
// (tests/fixtures/codex-0.157/README.md).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScreen } from "../src/screen-parser.js";
import {
  countVisibleExactQueuedRows,
  countVisibleOwnedQueuedInputs,
  countVisibleQueuedSubmitMatches,
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

  // #917: with a `│` gutter the indent is measured from the gutter, so the
  // deeper row still continues the item above it.
  it.each(["│", "│ "])("treats an indented arrow row under a %j gutter as a continuation", (gutter) => {
    const block = ["• Queued follow-up inputs", "  ↳ Other text", `    ↳ ${DATE}`].map((row) => gutter + row).join("\n");
    const screen = `OpenAI Codex\n${block}\n\n› Ask Codex to do anything\n  gpt-6-sol medium · ~/Gits/cmuxlayer\n`;
    expect(screenShowsQueuedAgentInput(screen, DATE, { exact: true })).toBe(false);
    expect(countVisibleExactQueuedRows(screen, DATE)).toBe(0);
    expect(screenShowsQueuedAgentInput(screen, `Other text ↳ ${DATE}`)).toBe(true);
    const twoItems = block.replace(`    ↳ ${DATE}`, `  ↳ ${DATE}`);
    const twoScreen = screen.replace(block, twoItems);
    expect(screenShowsQueuedAgentInput(twoScreen, DATE, { exact: true })).toBe(true);
    expect(countVisibleExactQueuedRows(twoScreen, DATE)).toBe(1);
  });

  it("#999 each owned entry covers only one queue item, including overlapping prefixes", () => {
    const prefix = "This authored request has a prefix of at least forty characters";
    const screen = `OpenAI Codex\n• Queued follow-up inputs\n  ↳ ${prefix}…\n  ↳ foreign row\n› Ask Codex to do anything`;
    expect(countVisibleOwnedQueuedInputs(screen, [`${prefix} first`, `${prefix} second`])).toBe(0);
    expect(countVisibleQueuedSubmitMatches(screen, `${prefix} first`)).toBe(1);
    const duplicates = screen.replace("foreign row", `${prefix} first`).replace(`${prefix}…`, `${prefix} first`);
    expect(countVisibleOwnedQueuedInputs(duplicates, [`${prefix} first`])).toBe(1);
    expect(countVisibleOwnedQueuedInputs(duplicates, [`${prefix} first`, `${prefix} first`])).toBe(2);
    const mixed = screen.replace("foreign row", `${prefix} first`);
    expect(countVisibleOwnedQueuedInputs(mixed, [`${prefix} first`, `${prefix} second`])).toBe(1);
  });

  it.each(["…", "..."])("#1004 owns complete text ending in authored %s", suffix => {
    const text = `This complete caller-owned message has more than forty characters${suffix}`;
    const screen = `OpenAI Codex\n• Queued follow-up inputs\n  ↳ ${text}\n› Ask Codex to do anything`;
    expect(countVisibleOwnedQueuedInputs(screen, [text])).toBe(1);
    expect(countVisibleOwnedQueuedInputs(screen, [`${text} hidden foreign suffix`])).toBe(0);
  });

  it.each([
    ["delete foo", "deletefoo", 0],
    ["deletefoo", "delete foo", 0],
    ["delete\nfoo", "deletefoo", 0],
    ["Keep meaningful spaces across a long message", "Keep meaningful spaces\n    across a long message", 1],
    ["wrap-tolerant", "wrap-\n    tolerant", 1],
    ["delete  foo", "delete foo", 1],
    ["delete foo", "delete  foo", 1],
    ["a b", "a\n    b", 1],
    ["ab", "a\n    b", 1],
  ])("#1004 whitespace ownership: %j vs %j => %i", (text, rows, owned) => {
    const screen = `OpenAI Codex\n• Queued follow-up inputs\n  ↳ ${rows}\n› Ask Codex to do anything`;
    expect(countVisibleOwnedQueuedInputs(screen, [text])).toBe(owned);
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
