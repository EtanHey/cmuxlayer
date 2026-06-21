// Policy loading, validation, and path utilities

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { PolicySchema } from "./policy-schema.js";
import type { Policy } from "./policy-schema.js";
import { PolicyLoadError } from "./errors.js";

// ---------------------------------------------------------------------------
// YAML parser (minimal — no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Parse a restricted but practical subset of YAML into a plain JavaScript
 * object.  Supports:
 *   - scalar key: value pairs
 *   - nested maps via indentation (2+ spaces)
 *   - arrays via "- item" syntax
 *   - inline arrays:  [a, b, c]
 *   - single-line comments (# …)
 *   - quoted and unquoted string values
 *   - blank lines
 *
 * This is intentionally **not** a full YAML implementation; it is sufficient
 * for human-written policy files.
 */
export function parseYaml(text: string): unknown {
  const lines = text.split(/\r?\n/);
  const { value } = parseYamlValue(lines, 0, 0);
  return value;
}

/** State holder while walking the line array. */
interface ParseState {
  value: unknown;
  index: number;
}

/**
 * Recursively parse YAML starting at {@link startIndex}.
 *
 * @param lines       – all lines of the file
 * @param startIndex  – line to start on
 * @param baseIndent  – indentation level (in spaces) of the parent block
 */
function parseYamlValue(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): ParseState {
  let idx = startIndex;
  while (idx < lines.length && isBlank(lines[idx])) idx++;

  if (
    idx < lines.length &&
    getIndent(lines[idx]) === baseIndent &&
    lines[idx].trimStart().startsWith("- ")
  ) {
    return parseYamlArray(lines, startIndex, baseIndent);
  }
  return parseYamlObject(lines, startIndex, baseIndent);
}

function parseYamlObject(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): ParseState {
  const obj: Record<string, unknown> = {};
  let idx = startIndex;

  while (idx < lines.length) {
    const raw = lines[idx];
    if (isBlank(raw) || isCommentLine(raw)) {
      idx++;
      continue;
    }

    const indent = getIndent(raw);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      idx++;
      continue;
    }

    const trimmed = raw.trimStart();
    if (trimmed.startsWith("- ")) break;

    const colonPos = trimmed.indexOf(":");
    if (colonPos === -1) {
      idx++;
      continue;
    }

    const key = trimmed.slice(0, colonPos).trim();
    let rest = trimmed.slice(colonPos + 1).trim();
    rest = stripInlineComment(rest);

    if (rest === "") {
      const nextIdx = idx + 1;
      if (nextIdx < lines.length) {
        const nextIndent = getNonBlankIndent(lines, nextIdx);
        if (nextIndent !== null && nextIndent > baseIndent) {
          const child = parseYamlValue(lines, nextIdx, nextIndent);
          obj[key] = child.value;
          idx = child.index;
          continue;
        }
      }
      obj[key] = null;
    } else {
      obj[key] = parseInlineValue(rest);
    }
    idx++;
  }

  return { value: obj, index: idx };
}

function parseYamlArray(
  lines: string[],
  startIndex: number,
  baseIndent: number,
): ParseState {
  const arr: unknown[] = [];
  let idx = startIndex;

  while (idx < lines.length) {
    const raw = lines[idx];
    if (isBlank(raw) || isCommentLine(raw)) {
      idx++;
      continue;
    }

    const indent = getIndent(raw);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      idx++;
      continue;
    }

    const trimmed = raw.trimStart();
    if (!trimmed.startsWith("- ")) break;

    const itemContent = trimmed.slice(2).trim();
    const stripped = stripInlineComment(itemContent);

    if (stripped === "") {
      const nextIdx = idx + 1;
      const childIndent = getNonBlankIndent(lines, nextIdx);
      if (childIndent !== null && childIndent > baseIndent) {
        const child = parseYamlValue(lines, nextIdx, childIndent);
        arr.push(child.value);
        idx = child.index;
        continue;
      }
      arr.push(null);
    } else {
      arr.push(parseInlineValue(stripped));
    }
    idx++;
  }

  return { value: arr, index: idx };
}

// ---------------------------------------------------------------------------
// YAML helper functions
// ---------------------------------------------------------------------------

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith("#");
}

function getIndent(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") count++;
    else if (ch === "\t") count += 2;
    else break;
  }
  return count;
}

function getNonBlankIndent(
  lines: string[],
  start: number,
): number | null {
  let i = start;
  while (i < lines.length) {
    if (isBlank(lines[i]) || isCommentLine(lines[i])) {
      i++;
      continue;
    }
    return getIndent(lines[i]);
  }
  return null;
}

function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseInlineValue(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;

  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);

  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    if (inner.trim() === "") return [];
    return inner.split(",").map((s) => parseInlineValue(s.trim()));
  }

  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` in a path to the current user's home directory.
 */
export function expandHomeDir(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return resolve(homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return homedir();
  }
  return filePath;
}

/**
 * Resolve the absolute path for the audit log file defined in the policy.
 * Falls back to the default path if the policy has no audit section.
 */
export function resolveAuditPath(policy: Policy): string {
  const raw =
    policy.audit?.path ?? "~/.local/share/chatgpt-mcp-cmux/audit.jsonl";
  return expandHomeDir(raw);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw JavaScript object against the {@link PolicySchema}.
 *
 * @throws {PolicyLoadError} when validation fails.
 */
export function validatePolicy(raw: unknown): Policy {
  const result = PolicySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new PolicyLoadError(
      "<inline>",
      `Schema validation failed: ${issues}`,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Asynchronously load and validate a policy from a YAML file.
 *
 * @param configPath – absolute or relative path to the YAML file
 * @throws {PolicyLoadError} when the file cannot be read or parsed
 */
export async function loadPolicy(configPath: string): Promise<Policy> {
  let rawText: string;
  try {
    rawText = await readFile(configPath, "utf-8");
  } catch (err) {
    const cause = err instanceof Error ? err : undefined;
    throw new PolicyLoadError(
      configPath,
      cause?.message ?? "Unknown read error",
      cause,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawText);
  } catch (err) {
    const cause = err instanceof Error ? err : undefined;
    throw new PolicyLoadError(
      configPath,
      `YAML parse error: ${cause?.message ?? "unknown"}`,
      cause,
    );
  }

  expandProjectRoot(parsed);
  return validatePolicy(parsed);
}

/**
 * Synchronously load and validate a policy from a YAML file.
 *
 * @param configPath – absolute or relative path to the YAML file
 * @throws {PolicyLoadError} when the file cannot be read or parsed
 */
export function loadPolicySync(configPath: string): Policy {
  let rawText: string;
  try {
    rawText = readFileSync(configPath, "utf-8");
  } catch (err) {
    const cause = err instanceof Error ? err : undefined;
    throw new PolicyLoadError(
      configPath,
      cause?.message ?? "Unknown read error",
      cause,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawText);
  } catch (err) {
    const cause = err instanceof Error ? err : undefined;
    throw new PolicyLoadError(
      configPath,
      `YAML parse error: ${cause?.message ?? "unknown"}`,
      cause,
    );
  }

  expandProjectRoot(parsed);
  return validatePolicy(parsed);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Expand `~` inside `project.root` when present. */
function expandProjectRoot(parsed: unknown): void {
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "project" in parsed &&
    parsed.project !== null &&
    typeof parsed.project === "object" &&
    !Array.isArray(parsed.project) &&
    "root" in parsed.project &&
    typeof parsed.project.root === "string"
  ) {
    (parsed.project as Record<string, unknown>).root = expandHomeDir(
      parsed.project.root,
    );
  }
}
