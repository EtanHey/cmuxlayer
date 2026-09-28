// #905: own-draft recognition and the Codex submit proof, read from real
// Codex 0.157 captures (tests/fixtures/codex-0.157/README.md).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  codexTranscriptEchoCount,
  codexTranscriptShowsNewEcho,
  composerHoldsForeignDraft,
} from "../src/delivery/composer-screen.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/codex-0.157/${name}.txt`, import.meta.url), "utf8");

const LONG =
  "Read and follow ~/Gits/cmuxlayer/docs.local/lanes/2026-09-27-905-opus-scratch-capture-only-do-not-act-on-this-pointer.md then reply with a one-line summary.";
const BRANCH = "Also tell me the git branch.";
const PANG = "Reply with the single word pang.";
const BOOT =
  "You are a scratch capture pane for issue 905. Reply with the single word ok.\n\nRead and follow ~/.cmux/agents/scratch-905-capture/contract.md";

describe("#905 own-draft recognition across soft-wrap", () => {
  it.each(["idle-wrapped-draft", "midturn-wrapped-draft"])("owns the caller's wrapped draft in %s", (name) => {
    expect(composerHoldsForeignDraft(fixture(name), LONG, { cli: "codex", exact: true })).toBe(false);
  });

  it("owns a padded boot brief whose paragraphs Codex indents", () => {
    expect(composerHoldsForeignDraft(fixture("boot-brief-padded"), BOOT, { cli: "codex", exact: true })).toBe(false);
  });

  it("still treats any other text as foreign (#802/#636)", () => {
    expect(composerHoldsForeignDraft(fixture("idle-wrapped-draft"), `${LONG} x`, { cli: "codex", exact: true })).toBe(true);
    expect(composerHoldsForeignDraft(fixture("idle-wrapped-draft"), "", { cli: "codex", exact: true })).toBe(true);
    expect(composerHoldsForeignDraft(fixture("idle-draft"), PANG, { cli: "codex", exact: true })).toBe(true);
  });
});

describe("#905 Codex submit evidence is the message in the transcript", () => {
  it("finds no echo in the burst frame that shows only the placeholder", () => {
    expect(codexTranscriptEchoCount(fixture("burst-return-placeholder-frame"), PANG)).toBe(0);
    expect(codexTranscriptEchoCount(fixture("burst-return-draft-reappears"), PANG)).toBe(0);
  });

  it("counts a submitted message, but never the draft in the composer", () => {
    expect(codexTranscriptEchoCount(fixture("idle-submitted-working"), "Reply with the single word pong and nothing else.")).toBe(1);
    expect(codexTranscriptEchoCount(fixture("idle-draft"), "Reply with the single word pong and nothing else.")).toBe(0);
    expect(codexTranscriptEchoCount(fixture("midturn-steer-drained-draft-pending"), LONG)).toBe(1);
    expect(codexTranscriptEchoCount(fixture("midturn-steer-drained-draft-pending"), BRANCH)).toBe(0);
  });
});

// Round 2 (review findings 1 and 2): the reviewer's direct probes.
describe("#905 r2: proof is a user-message row; ownership keeps inline spaces", () => {
  const frame = (body: string) =>
    `OpenAI Codex\n${body}\n\n› Ask Codex to do anything\n  gpt-6-sol medium · ~/Gits/cmuxlayer\n`;

  it("never counts assistant output, status chrome, or a frame with no composer", () => {
    expect(codexTranscriptEchoCount(frame("• ok"), "ok")).toBe(0);
    expect(codexTranscriptEchoCount(frame("Thinking (1s • esc to interrupt)"), "Thinking")).toBe(0);
    expect(codexTranscriptEchoCount("OpenAI Codex\n› ok\nWorking (1s • esc to interrupt)", "ok")).toBe(0);
    expect(codexTranscriptEchoCount(frame("› ok and more"), "ok")).toBe(0);
    expect(codexTranscriptEchoCount(frame("› ok"), "ok")).toBe(1);
  });

  it("counts a soft-wrapped user row, including a mid-word hyphen wrap", () => {
    expect(codexTranscriptEchoCount(fixture("midturn-steer-drained-draft-pending"), LONG)).toBe(1);
  });

  it("refuses a draft that differs only by an inline space", () => {
    const draft = (text: string) => `OpenAI Codex\n› ${text}\n  gpt-6-sol medium · ~/Gits/cmuxlayer`;
    expect(composerHoldsForeignDraft(draft("review foobar"), "review foo bar", { cli: "codex", exact: true })).toBe(true);
    expect(composerHoldsForeignDraft(draft("review foo bar"), "review foobar", { cli: "codex", exact: true })).toBe(true);
    expect(composerHoldsForeignDraft(draft("review foo"), "review foo bar", { cli: "codex", exact: true })).toBe(true);
  });
});

// #917 (review of #913): ownership forgives only what the renderer does. A
// soft-wrap consumes exactly the space it broke at (or nothing after a
// hyphen), and only when the row was full at the pane's width; inline spaces
// and blank-line counts are authored text.
describe("#917 own-draft match is exact", () => {
  const draft = (text: string) => `OpenAI Codex\n› ${text}\n  gpt-6-sol medium · ~/Gits/cmuxlayer`;
  const foreign = (screen: string, own: string) => composerHoldsForeignDraft(screen, own, { cli: "codex", exact: true });
  const frame = (body: string) =>
    `OpenAI Codex\n${body}\n\n› Ask Codex to do anything\n  gpt-6-sol medium · ~/Gits/cmuxlayer\n`;
  // 30 four-letter words: at the fixtures' 99 columns Codex breaks after 19.
  const WORDS = Array.from({ length: 30 }, () => "word").join(" ");
  const wrapped = (first: number, sep = " ") => {
    const words = WORDS.split(" ");
    return `${words.slice(0, first).join(" ")}\n  ${words.slice(first).join(sep)}`;
  };

  it("refuses a foreign double space", () => {
    expect(foreign(draft("review  foo bar"), "review foo bar")).toBe(true);
    expect(codexTranscriptEchoCount(frame("› review  foo bar"), "review foo bar")).toBe(0);
  });

  it("refuses a row break the pane width could not have made", () => {
    expect(foreign(draft("prefix\n  suffix"), "prefixsuffix")).toBe(true);
    expect(foreign(draft("review\n  foo bar"), "review foo bar")).toBe(true);
    expect(codexTranscriptEchoCount(frame("› prefix\n  suffix"), "prefixsuffix")).toBe(0);
  });

  it("refuses a different number of blank paragraph rows", () => {
    expect(foreign(draft("foo\n \n \n  bar"), "foo\n\nbar")).toBe(true);
    expect(foreign(draft("foo\n \n  bar"), "foo\n\n\nbar")).toBe(true);
    expect(foreign(draft("foo\n  bar"), "foo\n\nbar")).toBe(true);
  });

  it("still owns a single paragraph break, a hyphen wrap, and a full-row space wrap", () => {
    expect(foreign(draft("foo\n \n  bar"), "foo\n\nbar")).toBe(false);
    expect(foreign(fixture("idle-wrapped-draft"), LONG)).toBe(false);
    const screen = fixture("idle-draft").replace(`› Reply with the single word pong and nothing else.`, `› ${wrapped(19)}`);
    expect(foreign(screen, WORDS)).toBe(false);
    // The same rows, one word short of the width: not a wrap Codex makes.
    const early = fixture("idle-draft").replace(`› Reply with the single word pong and nothing else.`, `› ${wrapped(18)}`);
    expect(foreign(early, WORDS)).toBe(true);
    expect(foreign(fixture("idle-draft").replace(`› Reply with the single word pong and nothing else.`, `› ${wrapped(19, "  ")}`), WORDS)).toBe(true);
  });
});


// #917 (review of #913): the submit proof is a matching user row below
// everything the pre-type frame showed, not a rising count of matching rows.
describe("#917 a new user row is proven by position", () => {
  const frame = (body: string) =>
    `OpenAI Codex\n${body}\n\n› Ask Codex to do anything\n  gpt-6-sol medium · ~/Gits/cmuxlayer\n`;
  const pre = frame("› again\n\n• old response\n\n  14:06\n\n› status?\n\n• all green");

  it("never verifies an unchanged stale row, or the burst frame that repaints it", () => {
    expect(codexTranscriptShowsNewEcho(pre, pre, "again")).toBe(false);
    expect(codexTranscriptShowsNewEcho(pre, pre.replace("› Ask", "Working (0s • esc to interrupt)\n\n› Ask"), "again")).toBe(false);
  });

  it("verifies a repeated message whose predecessor scrolled out", () => {
    const post = frame("  14:06\n\n› status?\n\n• all green\n\n› again\n\nWorking (0s • esc to interrupt)");
    expect(codexTranscriptEchoCount(post, "again")).toBe(codexTranscriptEchoCount(pre, "again"));
    expect(codexTranscriptShowsNewEcho(pre, post, "again")).toBe(true);
  });

  it("verifies a repeated message appended with nothing scrolled", () => {
    const post = pre.replace("› Ask", "› again\n\n› Ask");
    expect(codexTranscriptShowsNewEcho(pre, post, "again")).toBe(true);
    expect(codexTranscriptShowsNewEcho(pre, post, "status?")).toBe(false);
  });

  it("reads a footer above the composer as chrome, never as the anchor", () => {
    const footer = "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\ncodex> ";
    expect(codexTranscriptShowsNewEcho(footer, `› again\n\nWorking (1s)\n${footer}`, "again")).toBe(true);
    const stale = `› again\n• ok\n${footer}`;
    expect(codexTranscriptShowsNewEcho(stale, stale, "again")).toBe(false);
  });

  it("finds the fixture's submitted message below the idle frame", () => {
    const PONG = "Reply with the single word pong and nothing else.";
    expect(codexTranscriptShowsNewEcho(fixture("idle-empty"), fixture("idle-submitted-working"), PONG)).toBe(true);
    expect(codexTranscriptShowsNewEcho(fixture("idle-submitted-working"), fixture("idle-submitted-working"), PONG)).toBe(false);
  });
});
