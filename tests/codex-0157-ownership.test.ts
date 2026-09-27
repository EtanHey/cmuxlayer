// #905: own-draft recognition and the Codex submit proof, read from real
// Codex 0.157 captures (tests/fixtures/codex-0.157/README.md).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  codexTranscriptEchoCount,
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
    expect(composerHoldsForeignDraft(draft("review  foo bar"), "review foo bar", { cli: "codex", exact: true })).toBe(false);
  });
});

