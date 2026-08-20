const CTRL_C_ALIASES = new Set(["c-c", "ctrl-c", "ctrl+c", "^c"]);

// AIDEV-NOTE (#484): every one of these means "submit" to the target CLI, but
// the delivery engine used to test `key === "return"` by exact match. A lead
// pressing "Enter" therefore got a receipt claiming submit_attempted:false for
// a submit that really was dispatched — a success receipt whose own fields said
// nothing had been attempted. This set exists to make the RECEIPT truthful; it
// deliberately does NOT rewrite the key handed to cmux. Raw "\r"/"\n" are not
// listed: a newline is how a composer expresses shift+enter, so treating it as
// a submit would claim an attempt the caller did not make.
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
]);

function canonicalKeyToken(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "");
}

/** True when this key name submits the composer on the target CLI. */
export function isSubmitKey(key: string): boolean {
  return SUBMIT_KEY_ALIASES.has(canonicalKeyToken(key));
}

export function normalizeKeyName(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (CTRL_C_ALIASES.has(canonicalKeyToken(trimmed))) {
    return "ctrl-c";
  }

  return trimmed;
}
