/**
 * Composer and submit screen analysis: pure functions over screen text that
 * decide whether input is pending, submitted, queued or foreign. Moved
 * verbatim from server.ts (CX-2 S1); imports nothing from the server.
 */

import { CODEX_FOOTER_RE, CODEX_HINT_LINE_RE } from "../codex-chrome.js";
import type { CliType } from "../agent-types.js";
import {
  antigravityComposerDraft,
  isAntigravityScreen,
  isPickerOrMenuScreen,
  parseScreen,
} from "../screen-parser.js";
import { matchShellPromptLine } from "../shell-prompt.js";
import type { ParsedScreenResult } from "../types.js";
import {
  CLI_INPUT_PROMPT_PREFIXES,
  CURSOR_FOLLOWUP_ENTER_SEND_NOW_RE,
  CURSOR_FOLLOWUP_PLACEHOLDER_RE,
} from "../pattern-registry.js";

export function hasInlinePrompt(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isLauncherShellCommand(command: string): boolean {
  return /(?:^|\s)[\w.-]+(?:Claude|Codex|Cursor|Gemini)(?=\s|$)/.test(command);
}

export function isSubmitVerifiedStatus(
  status: ParsedScreenResult["status"] | null | undefined,
): boolean {
  return status === "working" || status === "thinking";
}

export function hasParsedAgentIdentity(
  parsed: ParsedScreenResult | null | undefined,
): boolean {
  return Boolean(parsed && parsed.agent_type !== "unknown");
}

export function screenHasWorkingCodexChrome(screenText: string): boolean {
  return (
    /(?:^|\n)\s*(?:•\s*)?(?:Working|Waiting|Thinking)\b[^\n]*\besc to interrupt\b/im.test(
      screenText,
    ) &&
    /(?:^|\n)[ \t]*[›»][ \t]*$/m.test(screenText) &&
    /(?:^|\n)\s*tab to queue message\b/im.test(screenText)
  );
}

export function screenHasAnyAgentIdentity(
  screenText: string,
  parsed: ParsedScreenResult = parseScreen(screenText),
): boolean {
  return (
    hasParsedAgentIdentity(parsed) ||
    screenHasWorkingCodexChrome(screenText) ||
    /Claude Code|CLAUDE_COUNTER|bypass permissions on|What can I help you with\?|(?:^|\n)\s*(?:codex>|cursor>|kiro>)(?:\s|$)/im.test(
      screenText,
    )
  );
}

export type RawSubmitEvidenceMetrics = {
  tokenCount: number | null;
  cost: number | null;
};

export type ComposerPromptLineMatch = {
  input: string;
};

export const COMPOSER_PROMPT_PREFIXES = Array.from(
  new Set(Object.values(CLI_INPUT_PROMPT_PREFIXES).flat()),
).sort((a, b) => b.length - a.length);

export const RAW_SCREEN_TOKENS_LINE_RE =
  /(?:^\s*|.*\s{2,})([0-9][0-9,]*)\s+tokens\s*$/i;

export const RAW_SCREEN_COST_LINE_RE =
  /(?:^|\s)🤖\s*[^|\n]+?\s*\|\s*💰\s*\$([0-9]+(?:\.[0-9]+)?)(?:\s|$)|^\s*💰\s*\$([0-9]+(?:\.[0-9]+)?)(?:\s|$)/i;

export function normalizeTerminalText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function matchComposerPromptLine(line: string): ComposerPromptLineMatch | null {
  const trimmedStart = line.trimStart();
  for (const prefix of COMPOSER_PROMPT_PREFIXES) {
    if (!trimmedStart.toLowerCase().startsWith(prefix.toLowerCase())) {
      continue;
    }
    return { input: trimmedStart.slice(prefix.length).replace(/^\s/, "") };
  }

  return null;
}

export function inferComposerCli(
  screenText: string,
  parsed: ParsedScreenResult = parseScreen(screenText),
): CliType | null {
  if (parsed.agent_type !== "unknown") {
    return parsed.agent_type;
  }
  if (/(?:^|\n)\s*(?:Kiro\b|kiro>)/i.test(screenText)) {
    return "kiro";
  }
  if (/(?:^|\n)\s*Gemini CLI\b|(?:^|\n)\s*gemini>/i.test(screenText)) {
    return "gemini";
  }
  if (/(?:^|\n)\s*Cursor Agent\b|(?:^|\n)\s*cursor>/i.test(screenText)) {
    return "cursor";
  }
  if (
    /\bOpenAI\s+Codex\b/i.test(screenText) ||
    screenText.split("\n").some(line => CODEX_FOOTER_RE.test(line)) ||
    /(?:^|\n)\s*(?:Model:\s*)?gpt-[0-9]/i.test(screenText) ||
    screenHasWorkingCodexChrome(screenText)
  ) {
    return "codex";
  }
  if (
    /Claude Code|CLAUDE_COUNTER|bypass permissions on|What can I help you with\?/i.test(
      screenText,
    )
  ) {
    return "claude";
  }

  return null;
}

export function lineIsCurrentComposerRegionAnchor(
  cli: CliType | null,
  line: string,
): boolean {
  const trimmed = line.trim();
  switch (cli) {
    case "claude":
      return /Claude Code|What can I help you with\?/i.test(trimmed);
    case "codex":
      return (
        /\bOpenAI\s+Codex\b/i.test(trimmed) || /^[│┃║][ \t]*Model:[ \t]+[^│┃║]+[│┃║]$/iu.test(trimmed)
      );
    case "cursor":
      return /^Cursor Agent$/i.test(trimmed) || /^cursor>\s*$/i.test(trimmed);
    case "gemini":
      return /^Gemini CLI$/i.test(trimmed) || /^gemini>\s*$/i.test(trimmed);
    case "kiro":
      return /^Kiro\b/i.test(trimmed) || /^kiro>\s*$/i.test(trimmed);
    case null:
      return (
        /Claude Code|What can I help you with\?/i.test(trimmed) ||
        /\bOpenAI\s+Codex\b/i.test(trimmed) ||
        /^[│┃║][ \t]*Model:[ \t]+[^│┃║]+[│┃║]$/iu.test(trimmed) ||
        /^Cursor Agent$/i.test(trimmed) ||
        /^cursor>\s*$/i.test(trimmed) ||
        /^Gemini CLI$/i.test(trimmed) ||
        /^gemini>\s*$/i.test(trimmed) ||
        /^Kiro\b/i.test(trimmed) ||
        /^kiro>\s*$/i.test(trimmed)
      );
  }
}

export function currentComposerRegionStart(
  cli: CliType | null,
  lines: string[],
): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lineIsCurrentComposerRegionAnchor(cli, lines[index] ?? "")) {
      // Cursor's empty prompt is itself an anchor, and must remain readable
      // as the empty baseline before a caller can acquire draft ownership.
      if (cli === "cursor" && /^cursor>\s*$/i.test((lines[index] ?? "").trim())) return index;
      return index + 1;
    }
  }
  return 0;
}

export function isComposerFooterOrChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^[›»❯](?:[ \t]|$)/u.test(trimmed)) return false;
  if (!trimmed) {
    return true;
  }
  return (
    /^─{8,}$/u.test(trimmed) ||
    /^(?:⎇|🤖)(?:\s|$)/u.test(trimmed) ||
    /^⏵+.*\bbypass permissions on\b/i.test(trimmed) ||
    /^[✻✢✳✶]\s+Cogitated\s+for\s+\d+s\b/i.test(trimmed) ||
    /^CLAUDE_COUNTER:/i.test(trimmed) ||
    CODEX_FOOTER_RE.test(trimmed) ||
    CODEX_HINT_LINE_RE.test(trimmed) ||
    /^gpt-[0-9][0-9a-z.-]*(?:\s+\w+)?$/i.test(trimmed) ||
    /^\d+(?:\.\d+)?%\s+(?:context\s+)?left\b/i.test(trimmed) ||
    /^\/ commands\b/i.test(trimmed) ||
    /^(?:Auto|Agent)(?:\s*·|$)/i.test(trimmed) ||
    /^ctrl\+c to stop\b/i.test(trimmed) ||
    /\btab to queue message\b.*\b\d+(?:\.\d+)?%\s+context left\b/i.test(
      trimmed,
    ) ||
    CURSOR_FOLLOWUP_ENTER_SEND_NOW_RE.test(trimmed) ||
    /^bypass permissions on\b/i.test(trimmed) ||
    /^⬡\s+Idle\b/i.test(trimmed) ||
    /^v20\d{2}\.\d{2}\.\d{2}-[a-f0-9]+$/i.test(trimmed)
  );
}

export function isEligibleBareReadyPromptLine(
  cli: CliType | null,
  line: string,
): boolean {
  if (!/^\s*(?:>|>>>)\s*$/.test(line)) {
    return false;
  }
  return cli === "claude" || cli === "gemini" || cli === "kiro";
}

export function matchLegacyClaudePromptLine(
  cli: CliType | null,
  line: string,
): ComposerPromptLineMatch | null {
  if (cli !== "claude") {
    return null;
  }
  const match = line.trimStart().match(/^>(?!>)\s?(.*)$/);
  return match ? { input: match[1] ?? "" } : null;
}

/**
 * Codex renders empty-composer hints as dim text. The `surface.read_text`
 * frame used by this path is flattened, but styling is available separately
 * through `terminal.replay`'s `render_grid` capability. Until that richer
 * frame is wired into delivery classification, keep the observed hints in one
 * anchored pattern so they cannot be mistaken for arbitrary human prose.
 * These are exact rendered placeholders, not templates: expanding their
 * variable-looking segments would swallow real drafts such as
 * `Write tests for @server.ts`. Richer style detection is tracked in #504.
 *
 * Observed on 2026-08-20: `Implement {feature}`,
 * `Ask Codex to do anything`, and `Write tests for @filename`.
 */
export const CODEX_EMPTY_COMPOSER_PLACEHOLDER_RE =
  /^(?:Implement \{feature\}|Ask Codex to do anything|Write tests for @filename)$/;

export function normalizeKnownPlaceholderComposerInput(
  cli: CliType | null,
  input: string,
  submittedText?: string,
): string {
  const withoutCursorBorders = input
    .split("\n")
    .filter((line) => !/^\s*[▄▀]{8,}\s*$/.test(line))
    .join("\n")
    .trim();
  const [firstLine = "", ...followingLines] = withoutCursorBorders.split("\n");
  const codexPlaceholder = cli === "codex" &&
    CODEX_EMPTY_COMPOSER_PLACEHOLDER_RE.test(firstLine) &&
    followingLines.every((line) => !line.trim() || line.trim() === "esc again to edit previous message");
  if (
    codexPlaceholder ||
    (cli === "claude" && withoutCursorBorders === "Press up to edit queued messages") ||
    (cli === "cursor" &&
      (withoutCursorBorders === "Plan, search, build anything" ||
        CURSOR_FOLLOWUP_PLACEHOLDER_RE.test(withoutCursorBorders)))
  ) {
    if (withoutCursorBorders === submittedText?.trim()) {
      return input;
    }
    return "";
  }
  return input;
}

export function extractComposerInputRegion(
  screenText: string,
  submittedText?: string,
  knownCli?: CliType,
  preservePlaceholderText = false,
): string | null {
  // Antigravity (cli "gemini") draws a bare `>` composer between `─` rules,
  // which the prompt-prefix map cannot express without turning every `> text`
  // blockquote into a composer line. Read its composer structurally (#802).
  if (isAntigravityScreen(normalizeTerminalText(screenText))) {
    return antigravityComposerDraft(normalizeTerminalText(screenText));
  }
  const lines = normalizeTerminalText(screenText).split("\n");
  const cli = knownCli ?? inferComposerCli(screenText);
  // Menu selectors are not input boxes; their existing safety gate owns them.
  if (isPickerOrMenuScreen(screenText, cli ?? undefined)) return null;
  const start = currentComposerRegionStart(cli, lines);
  let end = lines.length;
  while (end > start && isComposerFooterOrChromeLine(lines[end - 1] ?? "")) {
    end -= 1;
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const match = matchComposerPromptLine(lines[index] ?? "");
    if (!match) {
      continue;
    }

    const inputLines = [match.input];
    const remainingLines = lines.slice(index + 1, end);
    for (const [offset, line] of remainingLines.entries()) {
      if (!line.trim()) {
        const nextContentLine = remainingLines
          .slice(offset + 1)
          .find((candidate) => candidate.trim());
        if (
          nextContentLine === undefined ||
          isComposerFooterOrChromeLine(nextContentLine)
        ) {
          break;
        }
        inputLines.push("");
        continue;
      }
      if (isComposerFooterOrChromeLine(line)) {
        break;
      }
      inputLines.push(line);
    }

    if (preservePlaceholderText) return inputLines.join("\n").trimEnd();
    return normalizeKnownPlaceholderComposerInput(
      cli,
      inputLines.join("\n").trimEnd(),
      submittedText,
    );
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const match = matchLegacyClaudePromptLine(cli, lines[index] ?? "");
    if (!match) {
      continue;
    }

    const inputLines = [match.input];
    const remainingLines = lines.slice(index + 1, end);
    for (const [offset, line] of remainingLines.entries()) {
      if (!line.trim()) {
        const nextContentLine = remainingLines
          .slice(offset + 1)
          .find((candidate) => candidate.trim());
        if (
          nextContentLine === undefined ||
          isComposerFooterOrChromeLine(nextContentLine)
        ) {
          break;
        }
        inputLines.push("");
        continue;
      }
      if (isComposerFooterOrChromeLine(line)) {
        break;
      }
      inputLines.push(line);
    }

    if (preservePlaceholderText) return inputLines.join("\n").trimEnd();
    return normalizeKnownPlaceholderComposerInput(
      cli,
      inputLines.join("\n").trimEnd(),
      submittedText,
    );
  }

  const lastActiveLine = lines[end - 1] ?? "";
  if (end > start && isEligibleBareReadyPromptLine(cli, lastActiveLine)) {
    return "";
  }

  return null;
}

export function screenShowsPendingInput(
  screenText: string,
  submittedText: string,
): boolean {
  const trimmed = submittedText.trim();
  if (!trimmed) {
    return false;
  }

  const composerInput = extractComposerInputRegion(screenText, submittedText);
  if (composerInput === null) {
    return false;
  }
  const normalizedComposer = normalizeTerminalText(composerInput).trim();
  const visibleTail = trimmed.slice(-Math.min(80, trimmed.length));
  const compactVisibleTail = visibleTail.replace(/\s+/g, "");
  return (
    normalizedComposer.includes(visibleTail) ||
    (compactVisibleTail.length > 0 &&
      normalizedComposer.replace(/\s+/g, "").includes(compactVisibleTail))
  );
}

export function screenShowsCompletePendingInput(
  screenText: string,
  submittedText: string,
): boolean {
  const trimmed = normalizeTerminalText(submittedText).trim();
  if (!trimmed) {
    return false;
  }
  const composerInput = extractComposerInputRegion(screenText, submittedText);
  if (composerInput === null) {
    return false;
  }
  const normalizedComposer = normalizeTerminalText(composerInput).trim();
  const compactSubmitted = trimmed.replace(/\s+/g, "");
  return (
    normalizedComposer.includes(trimmed) ||
    (compactSubmitted.length > 0 &&
      normalizedComposer.replace(/\s+/g, "").includes(compactSubmitted))
  );
}

/** Compare transcript text above the final composer, excluding its draft. */
export function screenTranscriptContainsText(screen: string, text: string): boolean {
  const lines = normalizeTerminalText(screen).split("\n");
  const cli = inferComposerCli(screen);
  let composer = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? "";
    if (matchComposerPromptLine(line) || matchLegacyClaudePromptLine(cli, line) || isEligibleBareReadyPromptLine(cli, line)) { composer = index; break; }
  }
  return composer >= 0 && screenContainsCompleteSubmittedText(lines.slice(0, composer).join("\n"), text);
}

export function screenContainsCompleteSubmittedText(
  screenText: string,
  submittedText: string,
): boolean {
  const trimmed = normalizeTerminalText(submittedText).trim();
  if (!trimmed) {
    return false;
  }
  const normalizedScreen = normalizeTerminalText(screenText);
  const compactSubmitted = trimmed.replace(/\s+/g, "");
  return (
    normalizedScreen.includes(trimmed) ||
    (compactSubmitted.length > 0 &&
      normalizedScreen.replace(/\s+/g, "").includes(compactSubmitted))
  );
}

/**
 * The text sitting on the composer's OWN input line, or null when no composer
 * prompt line is on screen.
 *
 * AIDEV-NOTE (T2 #442/B1): deliberately NOT `extractComposerInputRegion`. That
 * one appends every following line until it recognises a chrome line, so any
 * footer missing from `isComposerFooterOrChromeLine` -- `? for shortcuts`,
 * `accept edits on`, `Working (2s * esc to interrupt)` -- reads as composer
 * content. That is fine for its own callers, which ask "is the composer
 * CLEAR", where a false non-empty just withholds submit evidence. It is not
 * fine for the draft guard, where a false non-empty REFUSES a ready pane. So
 * the guard reads only the prompt line: a human draft always begins there,
 * and chrome never does. Widening the chrome whitelist instead is what put
 * this hole in the first place.
 */
export function composerPromptLineInput(screenText: string, knownCli?: CliType, preservePlaceholderText = false): string | null {
  const lines = normalizeTerminalText(screenText).split("\n");
  const cli = knownCli ?? inferComposerCli(screenText);
  const start = currentComposerRegionStart(cli, lines);
  let end = lines.length;
  while (end > start && isComposerFooterOrChromeLine(lines[end - 1] ?? "")) {
    end -= 1;
  }

  for (let index = end - 1; index >= start; index -= 1) {
    const line = lines[index] ?? "";
    const match =
      matchComposerPromptLine(line) ?? matchLegacyClaudePromptLine(cli, line);
    if (match) {
      return preservePlaceholderText ? match.input : normalizeKnownPlaceholderComposerInput(cli, match.input.trim());
    }
  }
  return null;
}

/** Columns Codex spends on a message row's `› ` or two-space prefix. */
const CODEX_ROW_PREFIX_COLS = 2;
/** Right-edge slack between the widest screen row and Codex's wrap width. */
const CODEX_WRAP_EDGE_SLACK_COLS = 2;

/**
 * The narrowest wrap width Codex can have used on this screen: no row is wider
 * than the pane, and a message row wraps within a column or two of its edge.
 * Captured 0.157 panes put a wrapped message row at the widest row's column.
 */
export function codexWrapWidthFloor(screenText: string): number {
  let widest = 0;
  for (const line of normalizeTerminalText(screenText).split("\n")) {
    widest = Math.max(widest, [...line.trimEnd()].length);
  }
  return Math.max(1, widest - CODEX_ROW_PREFIX_COLS - CODEX_WRAP_EDGE_SLACK_COLS);
}

/**
 * The text Codex keeps on one row when wrapping at `from`: up to the next
 * whitespace, or up to and including a hyphen between two alphanumerics (the
 * textwrap hyphen split Codex's wrapper uses).
 */
function codexWrapFragment(text: string, from: number): string {
  const word = /^[^\s]*/.exec(text.slice(from))?.[0] ?? "";
  const hyphen = /[\p{L}\p{N}]-(?=[\p{L}\p{N}])/u.exec(word);
  return hyphen ? word.slice(0, hyphen.index + 2) : word;
}

/**
 * Whether Codex's rendering of a message (its first row without the `› `
 * prefix, then continuation rows) is exactly this payload at some wrap width
 * of at least `minWidth` columns.
 *
 * AIDEV-NOTE (#917): forgive only what the renderer does. Codex wraps first-fit
 * and indents every row after the first by two spaces. A row break is then
 * one of: the payload's own newline; a wrap at whitespace, which consumes that
 * whitespace and is possible only when the next fragment would not have fit;
 * a wrap after a hyphen between alphanumerics, which consumes nothing; or a
 * forced break of a word wider than the row, which fills it exactly. Each
 * break bounds the width, and a match needs one width that satisfies every
 * row. Inside a row, text matches exactly, spaces included, and each blank row
 * is one empty payload line, so blank-line counts must match too. A short row
 * cannot be a wrap, so `prefix` / `suffix` is not `prefixsuffix` or
 * `prefix suffix` (#802/#636, #917).
 *
 * AIDEV-NOTE (#923 follow-up): whitespace at a row end is invisible (a
 * terminal shows trailing spaces as empty cells), so `a  b` wrapped after `a`
 * looks exactly like `a b`. Only the single space a wrap consumes is the
 * renderer's; any other whitespace at a row break (two spaces, a tab, spaces
 * before a newline) cannot be proven from the screen and never matches.
 */
function codexRenderedRowsMatch(rows: string[], payload: string, minWidth = 1): boolean {
  const text = normalizeTerminalText(payload).trimEnd();
  const visible = rows.map((row) => row.trimEnd());
  while (visible.length > 0 && !visible[visible.length - 1]) visible.pop();
  if (!text || visible.length === 0) return false;
  const width = (value: string) => [...value].length;
  let low = Math.max(1, minWidth);
  let high = Number.POSITIVE_INFINITY;
  let position = 0;
  for (const [index, visibleRow] of visible.entries()) {
    let row = visibleRow;
    if (index > 0 && row) {
      if (!row.startsWith("  ")) return false;
      row = row.slice(CODEX_ROW_PREFIX_COLS);
    }
    if (!text.startsWith(row, position)) return false;
    position += row.length;
    low = Math.max(low, width(row));
    const whitespace = /^[ \t]*/.exec(text.slice(position))?.[0] ?? "";
    const next = position + whitespace.length;
    const lastRow = index === visible.length - 1;
    if (whitespace && whitespace !== " ") return false;
    if (next >= text.length) {
      if (!lastRow) return false;
      position = next;
      break;
    }
    if (lastRow) return false;
    if (text[next] === "\n") {
      if (whitespace) return false;
      position = next + 1;
      continue;
    }
    if (!row) return false;
    if (whitespace) {
      high = Math.min(high, width(row) + width(whitespace) + width(codexWrapFragment(text, next)));
      position = next;
    } else if (/[\p{L}\p{N}]-$/u.test(row) && /^[\p{L}\p{N}]/u.test(text.slice(position))) {
      high = Math.min(high, width(row) + width(codexWrapFragment(text, position)));
    } else {
      high = Math.min(high, width(row) + 1);
    }
  }
  return position === text.length && low < high;
}

/**
 * Whether a composer region is exactly this payload as the CLI renders it.
 * For Codex, only renderer-made row breaks are forgiven, measured against the
 * screen's wrap width (see codexRenderedRowsMatch); pass the screen so a
 * short row cannot pass as a wrap.
 */
export function composerRegionMatchesPayload(
  region: string,
  payload: string,
  cli: CliType | null | undefined,
  screenText?: string,
): boolean {
  const expected = normalizeTerminalText(payload).trimEnd();
  // An empty composer is an empty payload on every CLI. For Codex a
  // multi-row region is never compared literally: `a\n  b` on screen is the
  // payload `a\nb` (or a wrap), not `a\n  b`.
  if (cli !== "codex") return region === expected;
  if (!region.trim()) return expected === "";
  const [first = "", ...following] = region.split("\n");
  return codexRenderedRowsMatch(
    [first, ...following],
    payload,
    screenText === undefined ? 1 : codexWrapWidthFloor(screenText),
  );
}

type CodexTranscript = { lines: string[]; composerIndex: number; history: number[] };

/**
 * The Codex transcript on screen: the composer row, and the indexes of the
 * non-blank rows above the live region between the transcript and the
 * composer (status row, tip, footer chrome, queue blocks). Null with no
 * composer on screen.
 */
function codexTranscript(screenText: string): CodexTranscript | null {
  const lines = normalizeTerminalText(screenText).split("\n").map((line) => line.trimEnd());
  let composerIndex = lines.length - 1;
  while (composerIndex >= 0 && !matchComposerPromptLine(lines[composerIndex] ?? "")) composerIndex -= 1;
  if (composerIndex < 0) return null;
  let top = composerIndex - 1;
  for (;;) {
    while (
      top >= 0 &&
      (!(lines[top] ?? "").trim() ||
        CODEX_STATUS_ROW_RE.test(stripCodexQueueGutter(lines[top] ?? "")) ||
        CODEX_TIP_ROW_RE.test(lines[top] ?? "") ||
        isComposerFooterOrChromeLine(lines[top] ?? ""))
    ) top -= 1;
    const scanned = codexQueueScan(lines, top).top;
    if (scanned === top) break;
    top = scanned;
  }
  const history: number[] = [];
  for (let index = 0; index <= top; index += 1) if ((lines[index] ?? "").trim()) history.push(index);
  return { lines, composerIndex, history };
}

/**
 * Start rows of Codex user messages above the composer that are exactly this
 * payload. Codex renders a submitted message as a `› ` row at column 0 plus
 * two-space continuation rows.
 */
function codexMatchingUserRows(transcript: CodexTranscript, screenText: string, submittedText: string): number[] {
  if (!submittedText.trim()) return [];
  const { lines, composerIndex } = transcript;
  const minWidth = codexWrapWidthFloor(screenText);
  const starts: number[] = [];
  for (let index = 0; index < composerIndex; index += 1) {
    const start = index;
    const first = /^› (.*)$/.exec(lines[index] ?? "");
    if (!first) continue;
    const following: string[] = [];
    while (index + 1 < composerIndex && /^(?:\s*$| {2}\S)/.test(lines[index + 1] ?? "")) {
      index += 1;
      following.push(lines[index] ?? "");
    }
    if (codexRenderedRowsMatch([first[1] ?? "", ...following], submittedText, minWidth)) starts.push(start);
  }
  return starts;
}

/**
 * Start rows of the Codex user messages on screen that are exactly this
 * payload. Classification only, with no claim that a row is new: assistant
 * output (`• …`), status chrome and queue rows (`↳ …`) are never user rows,
 * and with no composer on screen nothing counts (#905 r2).
 */
export function codexTranscriptUserRows(screenText: string, submittedText: string): number[] {
  const transcript = codexTranscript(screenText);
  return transcript ? codexMatchingUserRows(transcript, screenText, submittedText) : [];
}

/**
 * The first row of `post` that was not already on screen in `pre`, or null
 * when the frames cannot be aligned well enough to say. `preMatches` are the
 * rows of `pre` where this payload already stood as a user message.
 *
 * Codex only appends to its transcript, so the pre-type rows are either all
 * still there, or the top ones scrolled away and the rest lead the screen.
 * When that alignment fails (a live row changed in place), the boundary is
 * the latest pre-type row still on screen, found with the longest run of
 * pre-type rows ending at it, at its last occurrence, which never admits an
 * older row. A payload row of `pre` below that anchor is unaccounted for (a
 * reflow re-wraps it), so it could be the one on screen now: null. When no
 * pre-type row is on screen at all (a boot repaint, or everything scrolled
 * away), every visible row is newer, unless `pre` held the payload.
 */
function codexNewTranscriptStart(pre: CodexTranscript | null, post: CodexTranscript, preMatches: number[]): number | null {
  if (!pre || pre.history.length === 0) return 0;
  const after = post.history.map((index) => post.lines[index] ?? "");
  // Rows that end both frames and are not user messages are persistent
  // chrome (a footer drawn above the composer), not transcript: new messages
  // appear above them. Stopping at a user row keeps every stale message
  // above the anchor.
  let end = pre.history.length;
  while (
    end > 0 &&
    end > pre.history.length - after.length &&
    !/^› /.test(pre.lines[pre.history[end - 1] ?? -1] ?? "") &&
    pre.lines[pre.history[end - 1] ?? -1] === after[after.length - (pre.history.length - end) - 1]
  ) end -= 1;
  const before = pre.history.slice(0, end).map((index) => pre.lines[index] ?? "");
  if (before.length === 0) return 0;
  const lineAfter = (kept: number) => (post.history[kept - 1] ?? -1) + 1;
  for (let shift = 0; shift < before.length; shift += 1) {
    const kept = before.length - shift;
    if (kept <= after.length && before.slice(shift).every((row, offset) => row === after[offset])) {
      return lineAfter(kept);
    }
  }
  const unaccounted = (anchor: number) => preMatches.some((start) => start > anchor);
  for (let last = before.length - 1; last >= 0; last -= 1) {
    let best = -1;
    let bestRun = 0;
    for (let at = after.length - 1; at >= 0; at -= 1) {
      let run = 0;
      while (run <= Math.min(last, at) && before[last - run] === after[at - run]) run += 1;
      if (run > bestRun) { best = at; bestRun = run; }
    }
    if (best >= 0) return unaccounted(pre.history[last] ?? -1) ? null : lineAfter(best + 1);
  }
  return unaccounted(-1) ? null : 0;
}

/**
 * Whether this payload is on screen as a Codex user message that arrived
 * after the pre-type frame: a matching `› ` row below everything that frame
 * already showed. This is the Codex submit proof; the caller also requires an
 * empty composer.
 *
 * AIDEV-NOTE (#905, #917, #923): an empty composer alone is not proof: when
 * Return lands inside a paste burst, 0.157 briefly paints only its
 * placeholder, then repaints the same text with the Return as a newline. Nor
 * is a rising count of matching rows: when an earlier identical message
 * scrolls out as the new one appears, the count stays level. Position is the
 * proof, so an unchanged stale row never verifies and a repeated message
 * does. When the frames cannot be aligned, nothing is proven: false here, and
 * the send stays pending rather than claiming a submit (#923).
 */
export function codexTranscriptShowsNewEcho(
  preTypeScreen: string | null | undefined,
  screenText: string,
  submittedText: string,
): boolean {
  // No pre-type frame (its read failed) is no baseline: an old identical row
  // would pass as new, so nothing here is proof (#923 follow-up). A blank
  // frame is a failed read too: a live Codex pane always paints its composer
  // (#935 follow-up).
  if (!preTypeScreen?.trim()) return false;
  const post = codexTranscript(screenText);
  if (!post) return false;
  const starts = codexMatchingUserRows(post, screenText, submittedText);
  if (starts.length === 0) return false;
  const pre = codexTranscript(preTypeScreen);
  const preMatches = pre ? codexMatchingUserRows(pre, preTypeScreen, submittedText) : [];
  const boundary = codexNewTranscriptStart(pre, post, preMatches);
  return boundary !== null && starts.some((start) => start >= boundary);
}

/**
 * The Codex submit proof: an empty composer and this payload as a new user
 * row below the pre-type frame (codexTranscriptShowsNewEcho). The send's own
 * verifier and the pending sweep both use it; the caller adds its own
 * pending-input guard. An empty composer alone is not proof (a paste burst
 * paints only the placeholder), and neither is the payload somewhere on
 * screen (an old identical row) (#905, #935).
 */
export function codexScreenShowsSubmit(
  preTypeScreen: string | null | undefined,
  screenText: string,
  submittedText: string,
): boolean {
  const composer = extractComposerInputRegion(screenText);
  return composer !== null && composer.trim() === "" &&
    codexTranscriptShowsNewEcho(preTypeScreen, screenText, submittedText);
}

/**
 * True when the target composer holds text that this delivery did not put
 * there -- a human's half-written draft, or an earlier message still unflushed.
 *
 * AIDEV-NOTE (T2 #442): a partially-typed payload (chunk 1 landed, chunk 2
 * pending) IS ours and must stay deliverable, so the line content is compared
 * whitespace-insensitively against the payload rather than required to be
 * empty.
 */
export function composerHoldsForeignDraft(
  screenText: string,
  submittedText: string,
  options?: { cli?: CliType; exact?: boolean },
): boolean {
  const cli = options?.cli ?? inferComposerCli(screenText);
  // A selected permission option resembles a non-empty Claude composer line.
  // Let the menu classifier own it, including the exact Return guard.
  if (
    cli === "claude" &&
    /(?:^|\n)\s*[>❯›]\s+\d+\.\s+\S/m.test(screenText) &&
    isPickerOrMenuScreen(screenText, cli)
  ) {
    return false;
  }
  // AIDEV-NOTE (T2 #442): Cursor text sends are exempt. Its composer RETAINS
  // the accepted text after a submit (the "retained composer" state #441/#449
  // built evidence rules around), so a non-empty Cursor composer is the normal
  // post-send screen, not an unsent draft -- and nothing on that screen
  // distinguishes the two. Guarding it would refuse every legitimate second
  // send to a Cursor pane. Claude and Codex clear on submit, so there a
  // non-empty composer really does mean somebody's text is sitting unsent.
  if (!options?.exact && cli === "cursor") {
    return false;
  }
  // No recognisable composer prompt line (bare shell, unreadable frame). The
  // pre-existing gates own those cases; do not invent a refusal here.
  const promptLine = composerPromptLineInput(screenText, options?.cli, true);
  if (options?.exact) {
    const region = extractComposerInputRegion(screenText, submittedText, options.cli);
    return region !== null && !composerRegionMatchesPayload(region, submittedText, cli, screenText);
  }
  // Antigravity has no prompt prefix (a bare `>` under a rule), so the prefix
  // reader sees nothing; read its composer structurally (#809 review F7).
  if (isAntigravityScreen(normalizeTerminalText(screenText))) {
    const compactAgyDraft = (antigravityComposerDraft(normalizeTerminalText(screenText)) ?? "")
      .replace(/\s+/g, "");
    if (!compactAgyDraft) return false;
    const compactAgyPayload = submittedText.replace(/\s+/g, "");
    return compactAgyPayload.length === 0 || !compactAgyPayload.includes(compactAgyDraft);
  }
  if (promptLine === null || !promptLine.trim()) return false;
  // An empty first line may be a placeholder followed by real draft text.
  // Only the whole-region normalizer can certify that shape as empty.
  const placeholderLine = normalizeKnownPlaceholderComposerInput(options?.cli ?? inferComposerCli(screenText), promptLine) === "";
  const draft = placeholderLine
    ? extractComposerInputRegion(screenText, submittedText, options?.cli) ?? promptLine
    : promptLine;
  const compactDraft = draft.replace(/\s+/g, "");
  if (!compactDraft) {
    return false;
  }
  const compactPayload = submittedText.replace(/\s+/g, "");
  if (compactPayload.length === 0) {
    return true;
  }
  return !compactPayload.includes(compactDraft);
}

export function stripCodexQueueGutter(line: string): string {
  return line.replace(/^\s*[│┃║┆┊]\s?/, "").trimEnd();
}

export function compactQueueCorrelationText(text: string): string {
  return normalizeTerminalText(text).replace(/\s+/g, "");
}

export function cursorSubmittedResponseEvidenceSignatures(
  screenText: string,
  submittedText: string,
): string[] {
  const trimmed = submittedText.trim();
  if (!trimmed || inferComposerCli(screenText) !== "cursor") {
    return [];
  }

  const lines = normalizeTerminalText(screenText).split("\n");
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (matchComposerPromptLine(lines[index] ?? "")) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) {
    return [];
  }

  const correlationTail = compactQueueCorrelationText(
    trimmed.slice(-Math.min(80, trimmed.length)),
  );
  let regionStart = 0;
  for (let index = composerIndex - 1; index >= 0; index -= 1) {
    if (lineIsCurrentComposerRegionAnchor("cursor", lines[index] ?? "")) {
      regionStart = index + 1;
      break;
    }
  }
  const evidence: string[] = [];
  for (let index = composerIndex - 1; index >= regionStart; index -= 1) {
    const submittedTranscriptWindow = compactQueueCorrelationText(
      lines.slice(Math.max(regionStart, index - 16), index).join("\n"),
    );
    if (!submittedTranscriptWindow.includes(correlationTail)) {
      continue;
    }

    const activityMatch = (lines[index] ?? "").match(
      /^\s*(?:[\u2800-\u28ff]+\s*)?(Working|Thinking|Running)\b/i,
    );
    if (activityMatch?.[1]) {
      evidence.push(`activity:${activityMatch[1].toLowerCase()}`);
      continue;
    }

    if (
      !/^\s*[│┃║]\s*(?:…|\.\.\.)?\s*Thought for \d+(?:\.\d+)?(?:ms|s|m)\b/i.test(
        lines[index] ?? "",
      )
    ) {
      continue;
    }

    const responseRows: string[] = [];
    for (
      let rowIndex = index + 1;
      rowIndex < Math.min(composerIndex, index + 17);
      rowIndex += 1
    ) {
      const row = lines[rowIndex] ?? "";
      if (/^\s*[└╰].*[┘╯]\s*$/.test(row)) {
        break;
      }
      const content = row.replace(/^\s*[│┃║]\s?/, "").trim();
      if (content && !/^[─━┌┐└┘╭╮╰╯]+$/.test(content)) {
        responseRows.push(content);
      }
    }
    if (responseRows.length > 0) {
      evidence.push(
        `thought:${responseRows.join(" ").replace(/\s+/g, " ").trim()}`,
      );
    }
  }

  return evidence;
}

export function screenShowsFreshCursorResponseAfterSubmittedInput(
  screenText: string,
  submittedText: string,
  baselineEvidence: readonly string[] | null,
): boolean {
  if (baselineEvidence === null) {
    return false;
  }

  const baselineCounts = new Map<string, number>();
  for (const signature of baselineEvidence) {
    baselineCounts.set(signature, (baselineCounts.get(signature) ?? 0) + 1);
  }
  for (const signature of cursorSubmittedResponseEvidenceSignatures(
    screenText,
    submittedText,
  )) {
    const remaining = baselineCounts.get(signature) ?? 0;
    if (remaining === 0) {
      return true;
    }
    baselineCounts.set(signature, remaining - 1);
  }

  return false;
}

type CodexQueuedItem = { rows: string[]; exact: string | null };

const CODEX_QUEUE_HEADING_RE =
  /^(?:messages to be submitted after next tool call(?: \(press esc to interrupt and send immediately\))?|queued follow-up inputs)$/i;

/**
 * The start row of a Codex queue heading ending at `index`, or -1. A heading
 * can wrap onto up to four rows.
 */
function codexQueueHeadingStart(lines: string[], index: number): number {
  let wrappedHeading = "";
  for (let rows = 0; index >= 0 && rows < 4; rows += 1, index -= 1) {
    const row = stripCodexQueueGutter(lines[index] ?? "").trim().replace(/^•\s*/, "");
    if (!row) break;
    wrappedHeading = `${row} ${wrappedHeading}`.replace(/\s+/g, " ").trim();
    if (CODEX_QUEUE_HEADING_RE.test(wrappedHeading)) return index;
  }
  return -1;
}

const CODEX_STATUS_ROW_RE = /^[•✻✢✳✶]?\s*(?:Working|Thinking)\b/i;
const CODEX_TIP_ROW_RE = /^\s*Tip: /;

/** A queue row's indent, measured from its gutter glyph when it has one. */
function codexQueueRowIndent(line: string): number {
  return /^ */.exec(line.replace(/^\s*[│┃║┆┊]/, ""))?.[0].length ?? 0;
}

/**
 * Queue blocks read upward from `cursor` (the row above the composer), and
 * `top`, the row above the last complete block. Codex 0.157 can stack two
 * blocks there: "Messages to be submitted after next tool call" (Return during
 * a turn, drains at the next tool call) and "Queued follow-up inputs" (Tab,
 * drains when the turn ends). A block is counted only once its heading is
 * found.
 */
function codexQueueScan(lines: string[], cursor: number): { items: CodexQueuedItem[]; top: number } {
  const skipBlank = () => {
    while (cursor >= 0 && !stripCodexQueueGutter(lines[cursor] ?? "").trim()) cursor -= 1;
  };
  while (
    cursor >= 0 &&
    (!stripCodexQueueGutter(lines[cursor] ?? "").trim() ||
      CODEX_STATUS_ROW_RE.test(stripCodexQueueGutter(lines[cursor] ?? "")))
  ) cursor -= 1;
  const items: CodexQueuedItem[] = [];
  for (;;) {
    const blockBottom = cursor;
    const rows: string[] = [];
    let headingStart = -1;
    let belowIsArrow = false;
    while (cursor >= 0) {
      const rawLine = lines[cursor] ?? "";
      const activeLine = stripCodexQueueGutter(rawLine).trim();
      if (!activeLine) {
        if (!belowIsArrow) break;
        skipBlank();
        continue;
      }
      // A heading sits directly above the block's first item row.
      if (belowIsArrow) {
        headingStart = codexQueueHeadingStart(lines, cursor);
        if (headingStart >= 0) break;
      }
      if (/^(?:⌥\+↑|shift\+←) edit last queued message$/.test(activeLine)) {
        cursor -= 1;
        continue;
      }
      const arrow = activeLine.startsWith("↳");
      if (!arrow && !/^\s*[│┃║┆┊]/.test(rawLine) && !/^\s{2,}\S/.test(rawLine)) break;
      rows.unshift(rawLine);
      belowIsArrow = arrow;
      cursor -= 1;
    }
    if (headingStart < 0 || rows.length === 0) return { items, top: blockBottom };
    // AIDEV-NOTE (#917): an item starts at the indent of the block's first
    // row. A deeper row continues the item above it, even when its text
    // begins with `↳`. Indents are measured from the gutter glyph, not after
    // its optional padding, so `│    ↳ …` under `│  ↳ …` stays a continuation.
    const itemIndent = codexQueueRowIndent(rows[0] ?? "");
    const block: { rows: string[]; exact: string | null }[] = [];
    for (const rawLine of rows) {
      const activeLine = stripCodexQueueGutter(rawLine).trim();
      const itemMatch = codexQueueRowIndent(rawLine) <= itemIndent ? /^↳(?:\s+(.*)|\s*$)/.exec(activeLine) : null;
      const current = block[block.length - 1];
      if (itemMatch || !current) {
        block.push({ rows: [itemMatch?.[1] ?? activeLine], exact: /^↳ (.*)$/.exec(activeLine)?.[1] ?? null });
      } else {
        current.rows.push(activeLine);
      }
    }
    items.unshift(...block.map((item) => ({ rows: item.rows, exact: item.rows.length === 1 ? item.exact : null })));
    cursor = headingStart - 1;
    skipBlank();
  }
}

/** Queued items shown above the Codex composer, or null when no composer is visible. */
function codexQueuedItems(screenText: string): CodexQueuedItem[] | null {
  const lines = normalizeTerminalText(screenText).split("\n");
  let cursor = lines.length - 1;
  while (cursor >= 0 && !matchComposerPromptLine(stripCodexQueueGutter(lines[cursor] ?? ""))) cursor -= 1;
  if (cursor < 0) return null;
  return codexQueueScan(lines, cursor - 1).items;
}

export function screenShowsQueuedAgentInput(
  screenText: string,
  submittedText: string,
  opts: { exact?: boolean } = {},
): boolean {
  if (inferComposerCli(screenText) !== "codex") {
    return false;
  }
  const items = codexQueuedItems(screenText) ?? [];
  if (opts.exact) {
    // A wrapped or partially rendered item cannot prove ownership. Preserve
    // authored spaces; only CR line endings and terminal right padding vary.
    const stripRightPadding = (text: string): string =>
      normalizeTerminalText(text).replace(/[ \t]+$/, "");
    return items.some((item) => {
      if (item.rows.length !== 1 || item.exact === null) return false;
      const visible = stripRightPadding(item.exact);
      return visible.length > 0 && visible === submittedText;
    });
  }
  const submitted = compactQueueCorrelationText(submittedText.trim());
  return items.some((item) => {
    const visiblePrefix = compactQueueCorrelationText(
      item.rows.join(" ").replace(/(?:…|\.\.\.)+\s*$/, ""),
    );
    return visiblePrefix.length > 0 && submitted.startsWith(visiblePrefix);
  });
}

/** Number of visible queued inputs; an unreadable queue cannot prove ownership. */
export function countVisibleCodexQueuedInputs(screenText: string): number {
  return codexQueuedItems(screenText)?.length ?? 0;
}

export function countVisibleExactQueuedRows(
  screenText: string,
  authoredText: string,
): number | null {
  const items = codexQueuedItems(screenText);
  if (items === null || items.length === 0) return null;
  return items.filter((item) => item.exact === authoredText).length;
}

/** Submission correlation only; Return ownership continues to require exact rows. */
export function countVisibleQueuedSubmitMatches(screenText: string, text: string): number {
  const authored = compactQueueCorrelationText(text);
  if (!authored || inferComposerCli(screenText) !== "codex") return 0;
  return (codexQueuedItems(screenText) ?? []).filter(item => {
    const displayed = item.rows.join(" ").replace(/\s+/g, " ").trim();
    const truncated = /(?:…|\.\.\.)$/.test(displayed);
    const visible = displayed.replace(/(?:…|\.\.\.)$/, "").trim();
    const normalized = compactQueueCorrelationText(visible);
    return compactQueueCorrelationText(displayed) === authored || (truncated &&
      normalized.length > 0 && authored.startsWith(normalized) &&
      visible.length >= 40);
  }).length;
}

export function screenShowsCursorFollowupNeedsEnter(screenText: string): boolean {
  return (
    inferComposerCli(screenText) === "cursor" &&
    CURSOR_FOLLOWUP_ENTER_SEND_NOW_RE.test(normalizeTerminalText(screenText))
  );
}

export function screenShowsQueuedCursorFollowup(
  screenText: string,
  submittedText: string,
  opts: { exact?: boolean } = {},
): boolean {
  if (inferComposerCli(screenText) !== "cursor") {
    return false;
  }
  if (screenShowsPendingInput(screenText, submittedText)) {
    return false;
  }
  const trimmed = submittedText.trim();
  if (!trimmed) {
    return false;
  }
  const tail = trimmed.slice(-Math.min(80, trimmed.length));
  const composer = extractComposerInputRegion(screenText, submittedText);
  if (composer === null || composer.trim() !== "") {
    return false;
  }
  if (opts.exact ? !screenContainsCompleteSubmittedText(screenText, submittedText) : !normalizeTerminalText(screenText).includes(tail)) {
    return false;
  }
  return (
    CURSOR_FOLLOWUP_PLACEHOLDER_RE.test(screenText) ||
    /ctrl\+c to stop/i.test(screenText)
  );
}

export type PendingLauncherLineKind = "exact" | "corrupted" | "empty" | "other";

export function inspectPendingShellInput(
  screenText: string,
  submittedText: string,
): { pending: string; outputBelowPrompt: boolean } | null {
  const trimmed = submittedText.trim();
  if (!trimmed) {
    return null;
  }

  const lines = normalizeTerminalText(screenText).split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) {
    end -= 1;
  }

  const promptOptions = {
    allowRootInput: isLauncherShellCommand(trimmed),
  };
  let activePromptIndex = -1;
  for (let index = end - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trimEnd() ?? "";
    const strictPrompt = matchShellPromptLine(line, {
      ...promptOptions,
      strict: true,
    });
    const prompt = strictPrompt ?? matchShellPromptLine(line, promptOptions);
    if (prompt) {
      // The readiness matcher intentionally accepts any decorated $/%/#
      // suffix. Only use that loose fallback as pending-input evidence for a
      // launcher command; ordinary output such as "Building... 62%" is not a
      // trustworthy prompt anchor.
      if (!strictPrompt && !promptOptions.allowRootInput) {
        return null;
      }
      activePromptIndex = index;
      break;
    }
  }
  if (activePromptIndex < 0) {
    return null;
  }

  const prompt = matchShellPromptLine(
    lines[activePromptIndex] ?? "",
    promptOptions,
  );
  const below = lines.slice(activePromptIndex + 1, end);
  return {
    pending: [prompt?.input ?? "", ...below].join("").trimEnd(),
    outputBelowPrompt: below.some((line) => line.trim().length > 0),
  };
}

export function screenShowsPendingShellInput(
  screenText: string,
  submittedText: string,
): boolean {
  const inspected = inspectPendingShellInput(screenText, submittedText);
  if (inspected === null) {
    return false;
  }
  const trimmed = submittedText.trim();
  return (
    inspected.pending === trimmed ||
    inspected.pending.replace(/\s+/g, "") === trimmed.replace(/\s+/g, "")
  );
}

export function classifyPendingLauncherLine(
  screenText: string,
  submittedText: string,
): PendingLauncherLineKind {
  const inspected = inspectPendingShellInput(screenText, submittedText);
  if (inspected === null) {
    return "other";
  }
  const compactPending = inspected.pending.replace(/\s+/g, "");
  const compactSubmitted = submittedText.trim().replace(/\s+/g, "");
  if (!compactPending) {
    return "empty";
  }
  if (compactPending === compactSubmitted) {
    return "exact";
  }
  // Output below the prompt is boot/history, not pending input. Only a
  // single non-exact prompt line is recoverable corruption.
  if (inspected.outputBelowPrompt) {
    return "other";
  }
  return "corrupted";
}

export function parseRawSubmitEvidenceMetrics(
  screenText: string,
): RawSubmitEvidenceMetrics {
  const normalized = normalizeTerminalText(screenText);
  let tokenCount: number | null = null;
  let cost: number | null = null;

  for (const line of normalized.split("\n")) {
    const tokenMatch = line.match(RAW_SCREEN_TOKENS_LINE_RE);
    if (tokenMatch) {
      tokenCount = Number.parseInt(tokenMatch[1].replaceAll(",", ""), 10);
    }

    const costMatch = line.match(RAW_SCREEN_COST_LINE_RE);
    if (costMatch) {
      const rawCost = costMatch[1] ?? costMatch[2];
      if (rawCost !== undefined) {
        cost = Number.parseFloat(rawCost);
      }
    }
  }

  return { tokenCount, cost };
}

export function parseSubmitEvidenceMetrics(
  screenText: string,
  parsed: ParsedScreenResult = parseScreen(screenText),
): RawSubmitEvidenceMetrics {
  const raw = parseRawSubmitEvidenceMetrics(screenText);
  return {
    tokenCount: raw.tokenCount ?? parsed.token_count,
    cost: raw.cost ?? parsed.cost,
  };
}

export function composeBootDeliveryText(
  callerDeliveryText: string,
  injectedPrompt?: string,
  cli?: CliType,
): string {
  if (!hasInlinePrompt(injectedPrompt)) return callerDeliveryText;
  if (!hasInlinePrompt(callerDeliveryText)) return injectedPrompt;
  // Claude and Antigravity (cli "gemini", #801) can treat a paragraph break in
  // a pasted boot payload as a submit boundary. Keep the brief and pointer in
  // one composer message so the brief cannot run while the engine-issued
  // contract remains unsent. A multi-line brief without a paragraph break has
  // the same boundary risk.
  if (
    (cli === "claude" || cli === "gemini") &&
    !/\r?\n\s*\r?\n/.test(callerDeliveryText) &&
    !/\r?\n\s*\r?\n/.test(injectedPrompt)
  ) {
    return `${callerDeliveryText} ; ${injectedPrompt}`;
  }
  return `${callerDeliveryText}\n\n${injectedPrompt}`;
}

export function hasRawSubmitEvidenceIncrease(
  current: RawSubmitEvidenceMetrics,
  baseline: RawSubmitEvidenceMetrics | null | undefined,
): boolean {
  if (
    current.tokenCount !== null &&
    (baseline?.tokenCount === null || baseline?.tokenCount === undefined
      ? current.tokenCount > 0
      : current.tokenCount > baseline.tokenCount)
  ) {
    return true;
  }

  return (
    current.cost !== null &&
    (baseline?.cost === null || baseline?.cost === undefined
      ? current.cost > 0
      : current.cost > baseline.cost)
  );
}
