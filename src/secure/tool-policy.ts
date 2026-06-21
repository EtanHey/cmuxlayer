// Tool access control — determine whether a tool may be invoked under a policy

import type { Policy, ToolDecision } from "./policy-schema.js";

/**
 * Check whether a tool name is allowed, denied, or requires confirmation.
 *
 * The decision order is:
 *   1. Deny list    — if matched → "denied"
 *   2. Allow list   — if matched → "allowed"
 *   3. Require-confirmation list — if matched → "confirmation_required"
 *   4. Default      → "denied" (deny-by-default policy)
 *
 * @param toolName  – the secure tool name (e.g. "project.read_file")
 * @param policy    – loaded security policy
 * @returns the access decision
 */
export function checkToolAccess(toolName: string, policy: Policy): ToolDecision {
  const { tools } = policy;

  // 1. Explicit deny list takes highest precedence
  if (isAllowedPrefix(toolName, tools.deny)) {
    return "denied";
  }

  // 2. Allow list
  if (tools.allow.length > 0) {
    if (isAllowedPrefix(toolName, tools.allow)) {
      // 2a. Within allowed tools, some may require confirmation
      if (isAllowedPrefix(toolName, tools.require_confirmation)) {
        return "confirmation_required";
      }
      return "allowed";
    }
    // Allow list is non-empty but tool not in it → denied
    return "denied";
  }

  // 3. No allow list defined — check confirmation list globally
  if (isAllowedPrefix(toolName, tools.require_confirmation)) {
    return "confirmation_required";
  }

  // 4. Deny-by-default when no allow list matches
  return "denied";
}

/**
 * Get the tool decision together with a human-readable reason.
 *
 * @param toolName – the secure tool name
 * @param policy   – loaded security policy
 * @returns decision and optional explanation
 */
export function getToolDecision(
  toolName: string,
  policy: Policy,
): { decision: ToolDecision; reason?: string } {
  const decision = checkToolAccess(toolName, policy);

  switch (decision) {
    case "denied": {
      if (isAllowedPrefix(toolName, policy.tools.deny)) {
        return { decision, reason: `Tool "${toolName}" is on the deny list` };
      }
      if (policy.tools.allow.length > 0) {
        return {
          decision,
          reason: `Tool "${toolName}" is not on the allow list`,
        };
      }
      return {
        decision,
        reason: `Tool "${toolName}" is denied by default (no matching allow rule)`,
      };
    }
    case "allowed": {
      if (policy.tools.allow.length > 0) {
        return {
          decision,
          reason: `Tool "${toolName}" is on the allow list`,
        };
      }
      return { decision, reason: `Tool "${toolName}" is allowed` };
    }
    case "confirmation_required": {
      return {
        decision,
        reason: `Tool "${toolName}" requires human confirmation`,
      };
    }
  }
}

/**
 * Return `true` if {@link name} starts with any of the given {@link prefixes}.
 * Supports wildcard `*` at end of prefix for glob-style matching.
 *
 * @param name     – the string to test (e.g. a tool name)
 * @param prefixes – list of allowed prefixes (e.g. `["project.*", "system."]`)
 */
export function isAllowedPrefix(name: string, prefixes: string[]): boolean {
  if (!name || !prefixes) return false;
  for (const prefix of prefixes) {
    if (!prefix) continue;
    if (prefix === "*") return true;
    if (prefix.endsWith("*")) {
      const base = prefix.slice(0, -1);
      if (name.startsWith(base)) return true;
    } else if (name === prefix) {
      return true;
    } else if (prefix.endsWith(".") && name.startsWith(prefix)) {
      return true;
    } else if (name.startsWith(prefix)) {
      // Plain prefix match for workspace/agent/surface prefixes (e.g. "ws-", "dev-")
      return true;
    }
  }
  return false;
}

/**
 * Filter an array of items, keeping only those whose identifier matches at
 * least one of the given {@link prefixes}.
 *
 * The identifier is extracted via {@link keyFn} when provided; otherwise the
 * function looks for `name`, `title`, or `ref` properties on each item.
 *
 * @typeParam T      – element type of the array
 * @param items      – array to filter
 * @param keyFn      – optional function extracting the identifier string
 * @param prefixes   – allowed prefixes
 * @returns filtered array
 */
export function filterByPrefix<T>(
  items: T[],
  keyFn: (item: T) => string | undefined,
  prefixes: string[],
): T[];
export function filterByPrefix<
  T extends { name?: string; title?: string; ref?: string },
>(items: T[], prefixes: string[]): T[];
export function filterByPrefix<T>(
  items: T[],
  keyFnOrPrefixes: ((item: T) => string | undefined) | string[],
  maybePrefixes?: string[],
): T[] {
  if (!items || items.length === 0) return [];

  if (!maybePrefixes) {
    // Overload 2: (items, prefixes) — use default key extractor
    const prefixes = keyFnOrPrefixes as string[];
    if (!prefixes || prefixes.length === 0) return [];
    return items.filter((item) => {
      const key = extractKey(item as Record<string, unknown>);
      if (key === undefined) return false;
      return isAllowedPrefix(key, prefixes);
    });
  }

  // Overload 1: (items, keyFn, prefixes)
  const keyFn = keyFnOrPrefixes as (item: T) => string | undefined;
  const prefixes = maybePrefixes;
  if (!prefixes || prefixes.length === 0) return [];
  return items.filter((item) => {
    const key = keyFn(item);
    if (key === undefined) return false;
    return isAllowedPrefix(key, prefixes);
  });
}

/** Default key extractor for the overload without keyFn. */
function extractKey(
  item: Record<string, unknown>,
): string | undefined {
  if (typeof item.name === "string") return item.name;
  if (typeof item.title === "string") return item.title;
  if (typeof item.ref === "string") return item.ref;
  return undefined;
}
