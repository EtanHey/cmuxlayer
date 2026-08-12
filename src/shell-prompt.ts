const SHELL_PROMPT_TERMINATOR = "[$%#>❯›»]";

export function matchShellPromptLine(
  line: string,
  opts?: { allowRootInput?: boolean },
): { input: string } | null {
  const normalized = line.trimEnd();
  const barePrompt = normalized.match(
    new RegExp(`^\\s*(${SHELL_PROMPT_TERMINATOR})(?:\\s+(.*))?$`, "u"),
  );
  if (barePrompt && barePrompt[1] !== "#") {
    return { input: barePrompt[2] ?? "" };
  }
  if (
    barePrompt?.[1] === "#" &&
    (!barePrompt[2] || opts?.allowRootInput)
  ) {
    return { input: barePrompt[2] ?? "" };
  }

  // Preserve the app-server's established contract: any decorated prompt
  // ending in $, %, or # is ready. Pending input follows the terminator and
  // therefore cannot match this suffix-only fallback.
  if (/^.+[$%#]$/u.test(normalized)) {
    return { input: "" };
  }

  const prefixedPrompt = normalized.match(
    new RegExp(
      `^\\s*(?:(?:\\S+@\\S+)(?:\\s+(?:~|\\/)\\S*)?|(?:.*\\s)?(?:~|\\/)\\S*)(?:\\s+\\[[^\\]]+\\])?\\s*${SHELL_PROMPT_TERMINATOR}(?:\\s+(.*))?$`,
      "u",
    ),
  );
  return prefixedPrompt ? { input: prefixedPrompt[1] ?? "" } : null;
}

export function matchesShellPrompt(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  const prompt = end > 0 ? matchShellPromptLine(lines[end - 1] ?? "") : null;
  return prompt?.input.trim() === "";
}

export function launcherFailureFromShell(text: string): string | null {
  if (!matchesShellPrompt(text)) return null;
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
  if (lines.length < 2) return null;
  const adjacentLine = lines.at(-2)?.trim() ?? "";
  return /(?:command not found|no such file(?: or directory)?|permission denied|traceback \(most recent call last\)|invalid (?:option|argument|model|effort))/i.test(
    adjacentLine,
  )
    ? adjacentLine
    : null;
}
