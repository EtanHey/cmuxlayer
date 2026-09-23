/** Exact known Codex working-directory chooser from the September 2026 resume. */
export function isSelectedCodexSessionDirectoryChooser(
  screenText: string,
  recordedCwd: string,
): boolean {
  if (!recordedCwd.startsWith("/") || recordedCwd.includes("\n")) return false;
  const lines = screenText.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length !== 8) return false;
  return (
    lines[0] === "Working directory · resume" &&
    lines[1] === "Session = latest cwd recorded in the resumed session" &&
    lines[2] === "Current = your current working directory" &&
    lines[3] === `› 1. Use session directory (${recordedCwd})` &&
    /^  2\. Use current directory \(\/[^()\n]+\)$/.test(lines[4]) &&
    lines[5] === "  3. Always use session directory" &&
    lines[6] === "  4. Always use current directory" &&
    lines[7] === "enter continue · esc use session · ctrl+c quit"
  );
}
