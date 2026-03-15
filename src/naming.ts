/**
 * Naming rules for cmux surfaces.
 * Task suffixes must preserve the launcher identity.
 */

const SEPARATOR = ": ";

/**
 * Build a surface title from launcher label and optional task name.
 * Format: "launcherLabel: taskName" or just "launcherLabel" if no task.
 */
export function buildTitle(launcherLabel: string, taskName?: string): string {
  const label = launcherLabel.trim();
  const task = taskName?.trim();
  if (!task) return label;
  return `${label}${SEPARATOR}${task}`;
}

/**
 * Replace only the task suffix of a title, preserving the launcher prefix.
 * If the title has no colon separator, appends the suffix.
 */
export function replaceTaskSuffix(
  currentTitle: string,
  newSuffix: string,
): string {
  const prefix = extractPrefix(currentTitle);
  const suffix = newSuffix.trim();
  if (!suffix) return prefix;
  if (!prefix) return suffix;
  return `${prefix}${SEPARATOR}${suffix}`;
}

/**
 * Extract the launcher prefix from a title.
 * Returns everything before the first ": " separator, or the full title.
 */
export function extractPrefix(title: string): string {
  const idx = title.indexOf(SEPARATOR);
  if (idx === -1) return title.trim();
  return title.slice(0, idx).trim();
}
