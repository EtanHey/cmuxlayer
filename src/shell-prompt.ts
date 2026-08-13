const SHELL_PROMPT_TERMINATOR = "[$%#>❯›»]";

export function matchShellPromptLine(
  line: string,
  opts?: { allowRootInput?: boolean; strict?: boolean },
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

  if (!opts?.strict) {
    // Preserve the app-server's established readiness contract while still
    // exposing text after the decorated terminator to pending-input checks.
    const decoratedPrompt = normalized.match(
      /^.+?[$%#](?:\s+(.*))?$/u,
    );
    if (decoratedPrompt) {
      return { input: decoratedPrompt[1] ?? "" };
    }
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
  return matchesShellPromptWithOptions(text, false);
}

export function matchesShellPromptStrict(text: string): boolean {
  return matchesShellPromptWithOptions(text, true);
}

function matchesShellPromptWithOptions(text: string, strict: boolean): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  const prompt =
    end > 0
      ? matchShellPromptLine(lines[end - 1] ?? "", { strict })
      : null;
  return prompt?.input.trim() === "";
}

export function launcherFailureFromShell(text: string): string | null {
  if (!matchesShellPromptStrict(text)) return null;
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
