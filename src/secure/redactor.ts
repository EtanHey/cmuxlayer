/**
 * Secret redaction module.
 *
 * Identifies and replaces known secret patterns (API keys, PATs, private-key
 * blocks, environment-variable assignments, etc.) with a uniform placeholder.
 *
 * ## Guarantees
 * - **Idempotency** – `redact(redact(text)) === redact(text)` because the
 *   replacement string `[REDACTED_SECRET]` never matches any secret pattern.
 * - **Thread-safety** – each call to {@link createDefaultRedactor} returns a
 *   standalone instance with its own mutable pattern list.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type { Redactor } from "./policy-schema.js";
export type { Redactor } from "./policy-schema.js";

/** A single named redaction rule. */
interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

// ---------------------------------------------------------------------------
// Default patterns
// ---------------------------------------------------------------------------

/** Uniform replacement token used by every built-in rule. */
const DEFAULT_REPLACEMENT = "[REDACTED_SECRET]";

/**
 * Built-in secret patterns shipped with the gateway.
 *
 * Each entry contains a human-readable name, a **global** `RegExp`, and the
 * replacement text.  The replacement is deliberately chosen so that repeated
 * application is a no-op (idempotency).
 */
export const DEFAULT_SECRET_PATTERNS: RedactionRule[] = [
  // OpenAI API keys
  {
    name: "openai_api_key",
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    replacement: DEFAULT_REPLACEMENT,
  },
  // GitHub personal-access tokens (classic)
  {
    name: "github_pat_classic",
    pattern: /ghp_[A-Za-z0-9_]{20,}/g,
    replacement: DEFAULT_REPLACEMENT,
  },
  // GitHub personal-access tokens (fine-grained)
  {
    name: "github_pat_fine_grained",
    pattern: /github_pat_[A-Za-z0-9_]{20,}/g,
    replacement: DEFAULT_REPLACEMENT,
  },
  // Tailscale auth keys
  {
    name: "tailscale_key",
    pattern: /tskey-[A-Za-z0-9_-]+/g,
    replacement: DEFAULT_REPLACEMENT,
  },
  // API key assignments — OpenAI
  {
    name: "env_openai_api_key",
    pattern: /OPENAI_API_KEY\s*=\s*.+/g,
    replacement: `OPENAI_API_KEY=${DEFAULT_REPLACEMENT}`,
  },
  // API key assignments — Anthropic
  {
    name: "env_anthropic_api_key",
    pattern: /ANTHROPIC_API_KEY\s*=\s*.+/g,
    replacement: `ANTHROPIC_API_KEY=${DEFAULT_REPLACEMENT}`,
  },
  // API key assignments — DeepSeek
  {
    name: "env_deepseek_api_key",
    pattern: /DEEPSEEK_API_KEY\s*=\s*.+/g,
    replacement: `DEEPSEEK_API_KEY=${DEFAULT_REPLACEMENT}`,
  },
  // API key assignments — Supabase
  {
    name: "env_supabase_service_role_key",
    pattern: /SUPABASE_SERVICE_ROLE_KEY\s*=\s*.+/g,
    replacement: `SUPABASE_SERVICE_ROLE_KEY=${DEFAULT_REPLACEMENT}`,
  },
  // API key assignments — AWS
  {
    name: "env_aws_secret_access_key",
    pattern: /AWS_SECRET_ACCESS_KEY\s*=\s*.+/g,
    replacement: `AWS_SECRET_ACCESS_KEY=${DEFAULT_REPLACEMENT}`,
  },
  // Private key blocks (RSA, EC, OPENSSH, etc.)
  {
    name: "private_key_block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: DEFAULT_REPLACEMENT,
  },
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new {@link Redactor} instance pre-loaded with
 * {@link DEFAULT_SECRET_PATTERNS}.
 *
 * The returned instance is independent (no shared mutable state with other
 * instances) and safe to use concurrently.
 */
export function createDefaultRedactor(): Redactor {
  /** Mutable per-instance rule list (deep copy of defaults). */
  const rules: RedactionRule[] = DEFAULT_SECRET_PATTERNS.map((r) => ({
    ...r,
  }));

  return {
    /**
     * Redact all secrets in the input string.
     *
     * Rules are applied in registration order.  The operation is idempotent:
     * repeated redaction of an already-redacted string returns the same
     * string because the replacement text never contains secret-like
     * substrings.
     */
    redact(input: string): string {
      let output = input;
      for (const rule of rules) {
        output = output.replace(rule.pattern, rule.replacement);
      }
      return output;
    },

    /**
     * Add a custom redaction pattern at runtime.
     *
     * @param name        Human-readable identifier for the rule.
     * @param pattern     RegExp to search for (will be made global if not
     *                    already).
     * @param replacement Optional replacement text (defaults to
     *                    `[REDACTED_SECRET]`).
     */
    addPattern(
      name: string,
      pattern: RegExp,
      replacement: string = DEFAULT_REPLACEMENT,
    ): void {
      // Ensure the pattern is global so replace() catches all occurrences
      const globalPattern: RegExp = pattern.global
        ? pattern
        : new RegExp(
            pattern.source,
            pattern.flags.includes("i")
              ? pattern.flags + "g"
              : pattern.flags + "g",
          );
      rules.push({ name, pattern: globalPattern, replacement });
    },
  };
}
