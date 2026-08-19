const CTRL_C_ALIASES = new Set(["c-c", "ctrl-c", "ctrl+c", "^c"]);

// AIDEV-NOTE (#484): every one of these means "submit" to the target CLI, but
// the delivery engine used to test `key === "return"` by exact match. A lead
// pressing "Enter" (or sending a raw CR) therefore got a receipt claiming
// submit_attempted:false for a submit that really was dispatched — a success
// receipt whose own fields said nothing had been attempted. Canonicalize them
// so both the dispatched key name and the receipt agree.
const SUBMIT_KEY_ALIASES = new Set([
  "return",
  "enter",
  "kpenter",
  "kp_enter",
  "kp-enter",
  "c-m",
  "ctrl-m",
  "ctrl+m",
  "^m",
  "\r",
  "\n",
]);

/**
 * Reduce a key name to the token the alias sets are keyed on. Raw carriage
 * returns and newlines are collapsed to "\r" before the trim that every other
 * alias needs, because trimming them away would erase the key entirely.
 */
function canonicalKeyToken(key: string): string {
  if (/^[\r\n]+$/.test(key)) {
    return "\r";
  }
  return key.trim().toLowerCase().replace(/\s+/g, "");
}

/** True when this key name submits the composer on the target CLI. */
export function isSubmitKey(key: string): boolean {
  return SUBMIT_KEY_ALIASES.has(canonicalKeyToken(key));
}

export function normalizeKeyName(key: string): string {
  const token = canonicalKeyToken(key);
  if (!token) {
    return key.trim();
  }

  if (CTRL_C_ALIASES.has(token)) {
    return "ctrl-c";
  }

  if (SUBMIT_KEY_ALIASES.has(token)) {
    return "return";
  }

  return key.trim();
}
