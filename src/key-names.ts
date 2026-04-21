const CTRL_C_ALIASES = new Set(["c-c", "ctrl-c", "ctrl+c", "^c"]);

export function normalizeKeyName(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    return trimmed;
  }

  const normalized = trimmed.toLowerCase().replace(/\s+/g, "");
  if (CTRL_C_ALIASES.has(normalized)) {
    return "ctrl-c";
  }

  return trimmed;
}
