/**
 * Composer and submit screen analysis: pure functions over screen text that
 * decide whether input is pending, submitted, queued or foreign. Moved
 * verbatim from server.ts (CX-2 S1); imports nothing from the server.
 */

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
        /\bOpenAI\s+Codex\b/i.test(trimmed) || /\bModel:\s*gpt-/i.test(trimmed)
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
        /\bModel:\s*gpt-/i.test(trimmed) ||
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
  if (!trimmed) {
    return true;
  }
  return (
    /^─{8,}$/.test(trimmed) ||
    /^(?:⎇|🤖)(?:\s|$)/.test(trimmed) ||
    /^⏵+.*\bbypass permissions on\b/i.test(trimmed) ||
    /^[✻✢✳✶]\s+Cogitated\s+for\s+\d+s\b/i.test(trimmed) ||
    /^CLAUDE_COUNTER:/i.test(trimmed) ||
    /^gpt-[0-9][0-9a-z.-]*(?:\s+\w+)?\s*[·•]\s*/i.test(trimmed) ||
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
    return region !== null && region !== normalizeTerminalText(submittedText).trimEnd();
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

export function screenShowsQueuedAgentInput(
  screenText: string,
  submittedText: string,
  opts: { exact?: boolean } = {},
): boolean {
  const lines = normalizeTerminalText(screenText).split("\n");
  if (inferComposerCli(screenText) !== "codex") {
    return false;
  }

  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (matchComposerPromptLine(stripCodexQueueGutter(lines[index] ?? ""))) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) {
    return false;
  }

  let index = composerIndex - 1;
  while (
    index >= 0 &&
    (!stripCodexQueueGutter(lines[index] ?? "").trim() ||
      /^[•✻✢✳✶]?\s*(?:Working|Thinking)\b/i.test(
        stripCodexQueueGutter(lines[index] ?? ""),
      ))
  ) {
    index -= 1;
  }

  const queuedItemRows: string[] = [];
  let foundQueuedItem = false;
  let exactQueuedItemText: string | null = null;
  while (index >= 0) {
    const rawLine = lines[index] ?? "";
    const activeLine = stripCodexQueueGutter(rawLine).trim();
    const itemMatch = /^↳(?:\s+(.*)|\s*$)/.exec(activeLine);
    if (itemMatch) {
      queuedItemRows.unshift(itemMatch[1] ?? "");
      exactQueuedItemText = /^↳ (.*)$/.exec(activeLine)?.[1] ?? null;
      foundQueuedItem = true;
      index -= 1;
      break;
    }
    const isWrappedItemRow =
      /^\s*[│┃║┆┊]/.test(rawLine) || /^\s{2,}\S/.test(rawLine);
    if (!activeLine || !isWrappedItemRow) {
      return false;
    }
    queuedItemRows.unshift(activeLine);
    index -= 1;
  }
  if (!foundQueuedItem) {
    return false;
  }

  while (index >= 0 && !stripCodexQueueGutter(lines[index] ?? "").trim()) {
    index -= 1;
  }
  const queueHeadingPattern =
    /^messages to be submitted after next tool call(?: \(press esc to interrupt and send immediately\))?$/i;
  let wrappedHeading = "";
  let foundHeading = false;
  for (let headingRows = 0; index >= 0 && headingRows < 4; headingRows += 1) {
    const headingRow = stripCodexQueueGutter(lines[index] ?? "")
      .trim()
      .replace(/^•\s*/, "");
    if (!headingRow) {
      break;
    }
    wrappedHeading = `${headingRow} ${wrappedHeading}`
      .replace(/\s+/g, " ")
      .trim();
    if (queueHeadingPattern.test(wrappedHeading)) {
      foundHeading = true;
      break;
    }
    index -= 1;
  }
  if (!foundHeading) {
    return false;
  }

  if (opts.exact) {
    // A wrapped or partially rendered item cannot prove ownership. Preserve
    // authored spaces; only CR line endings and terminal right padding vary.
    if (queuedItemRows.length !== 1 || exactQueuedItemText === null) {
      return false;
    }
    const stripRightPadding = (text: string): string =>
      normalizeTerminalText(text).replace(/[ \t]+$/, "");
    const visible = stripRightPadding(exactQueuedItemText);
    return visible.length > 0 && visible === submittedText;
  }

  const visiblePrefix = compactQueueCorrelationText(
    queuedItemRows.join(" ").replace(/(?:…|\.\.\.)+\s*$/, ""),
  );
  const submitted = compactQueueCorrelationText(submittedText.trim());
  return visiblePrefix.length > 0 && submitted.startsWith(visiblePrefix);
}

export function countVisibleExactQueuedRows(
  screenText: string,
  authoredText: string,
): number | null {
  const lines = normalizeTerminalText(screenText).split("\n");
  let cursor = lines.length - 1;
  while (cursor >= 0 && !matchComposerPromptLine(stripCodexQueueGutter(lines[cursor] ?? ""))) cursor -= 1;
  if (cursor < 0) return null;
  cursor -= 1;
  while (cursor >= 0 && (!stripCodexQueueGutter(lines[cursor] ?? "").trim() || /^[•✻✢✳✶]?\s*(?:Working|Thinking)\b/i.test(stripCodexQueueGutter(lines[cursor] ?? "")))) cursor -= 1;
  const queueRow = (index: number): RegExpExecArray | null => /^↳ (.*)$/.exec(stripCodexQueueGutter(lines[index] ?? "").trimStart());
  const queueHeadingStart = (index: number): number => {
    let wrappedHeading = "";
    for (let rows = 0; index >= 0 && rows < 4; rows += 1, index -= 1) {
      const row = stripCodexQueueGutter(lines[index] ?? "").trim().replace(/^•\s*/, "");
      if (!row) break;
      wrappedHeading = `${row} ${wrappedHeading}`.replace(/\s+/g, " ").trim();
      if (/^messages to be submitted after next tool call(?: \(press esc to interrupt and send immediately\))?$/i.test(wrappedHeading)) return index;
    }
    return -1;
  };
  let count: number | null = null;
  while (cursor >= 0) {
    const blockEnd = cursor;
    let blockCount = 0;
    let row: RegExpExecArray | null;
    while (cursor >= 0 && (row = queueRow(cursor))) {
      if (row[1] === authoredText) blockCount += 1;
      cursor -= 1;
    }
    if (cursor === blockEnd) return count;
    while (cursor >= 0 && !stripCodexQueueGutter(lines[cursor] ?? "").trim()) cursor -= 1;
    const headingStart = queueHeadingStart(cursor);
    if (headingStart < 0) return count;
    count = (count ?? 0) + blockCount;
    cursor = headingStart - 1;
  }
  return count;
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
  if (!normalizeTerminalText(screenText).includes(tail)) {
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
