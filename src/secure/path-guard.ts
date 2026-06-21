/**
 * Path validation module.
 *
 * Ensures every file-system path stays inside the configured project root.
 * Blocks directory-traversal, absolute paths outside the project, home-dir
 * references, symlink escapes, and paths matching configured deny-glob
 * patterns (e.g. `node_modules/**`, `.env.*`).
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Policy } from "./policy-schema.js";
import { PathDeniedError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a user-provided path to a real (symlink-free) absolute path and
 * verify it lies inside the project root.
 *
 * Rejects:
 * - Home-directory references (`~/.ssh/id_rsa`)
 * - Absolute paths outside the project (`/Users/danissimode/.ssh/id_rsa`)
 * - Directory traversal (`../../.ssh/id_rsa`)
 * - Symlinks that resolve outside the project
 *
 * @param inputPath Raw path from user input (may be relative).
 * @param policy    Parsed policy containing `project.root`.
 * @returns Resolved real absolute path inside the project.
 * @throws PathDeniedError if the path escapes the project root.
 */
export async function resolveInsideProject(
  inputPath: string,
  policy: Policy,
): Promise<string> {
  const root = path.resolve(policy.project.root);

  // Reject home-directory references
  if (inputPath.startsWith("~/") || inputPath === "~") {
    throw new PathDeniedError(inputPath);
  }

  // Reject absolute paths outside the project root
  if (path.isAbsolute(inputPath)) {
    const candidate = path.resolve(inputPath);
    if (!isInsideRoot(candidate, root)) {
      throw new PathDeniedError(inputPath);
    }
    // Verify symlink target stays inside
    const real = await safeRealpath(candidate);
    if (!isInsideRoot(real, root)) {
      throw new PathDeniedError(inputPath);
    }
    return real;
  }

  // Relative path: resolve against root, then resolve symlinks
  const joined = path.resolve(root, inputPath);
  const real = await safeRealpath(joined);

  if (!isInsideRoot(real, root)) {
    throw new PathDeniedError(inputPath);
  }

  return real;
}

/**
 * Check whether a resolved (real) path matches any deny-glob pattern in the
 * policy, or matches built-in always-denied file names.
 *
 * @param realPath Fully-resolved absolute path.
 * @param policy   Parsed policy containing `project.deny` globs.
 * @returns `true` if the path is denied.
 */
export function isDeniedPath(realPath: string, policy: Policy): boolean {
  const relative = path.relative(policy.project.root, realPath);

  // Check user-configured deny globs against both absolute and relative paths
  for (const pattern of policy.project.deny) {
    if (matchesGlob(realPath, pattern) || matchesGlob(relative, pattern)) {
      return true;
    }
  }

  // Always deny well-known sensitive files regardless of explicit policy
  const basename = path.basename(realPath);
  const alwaysDeniedBasenames: string[] = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.staging",
    ".env.test",
  ];
  if (alwaysDeniedBasenames.includes(basename)) {
    return true;
  }

  return false;
}

/**
 * Resolve a path and validate it is both inside the project and not on the
 * deny list.
 *
 * This is the primary entry-point for tool handlers that need to read files.
 *
 * @param inputPath Raw path from user input.
 * @param policy    Parsed policy.
 * @returns Resolved real absolute path that is safe to read.
 * @throws PathDeniedError if the path is outside the project or denied.
 */
export async function assertReadableProjectPath(
  inputPath: string,
  policy: Policy,
): Promise<string> {
  const resolved = await resolveInsideProject(inputPath, policy);

  if (isDeniedPath(resolved, policy)) {
    throw new PathDeniedError(inputPath);
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Match a file path against a simple glob pattern.
 *
 * Supported syntax:
 * - `*`   – matches any sequence except `/`
 * - `**`  – matches any sequence including `/`
 * - `?`   – matches a single character except `/`
 *
 * When the pattern contains no `/` it is matched against the basename of
 * *filePath* only.
 *
 * @param filePath Path to test.
 * @param pattern  Glob pattern.
 * @returns `true` if the path matches.
 *
 * @example
 * ```ts
 * matchesGlob("node_modules/foo/bar.js", "node_modules/**"); // true
 * matchesGlob(".env.local", ".env.*");                       // true
 * matchesGlob("/project/key.pem", "*.pem");                  // true
 * ```
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const normalisedFile = filePath.split(path.sep).join("/");

  // Normalize pattern: strip trailing slashes and collapse to meaningful parts
  const normalisedPattern = pattern.replace(/\/+$/, "");
  if (!normalisedPattern) return false;

  // Pattern without slash: match against basename only
  if (!normalisedPattern.includes("/")) {
    return matchSegment(path.basename(normalisedFile), normalisedPattern);
  }

  const fileParts = normalisedFile.split("/");
  const patParts = normalisedPattern.split("/");

  return matchGlobParts(fileParts, patParts, 0, 0);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether *candidate* lies inside *root*.
 */
function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  const normalised = rel.split(path.sep).join("/");
  return normalised === "" || !normalised.startsWith("..");
}

/**
 * Wrapper around `fs.realpath` that falls back to `path.resolve` when the
 * target does not exist, so non-existent but safe paths can still be
 * validated.
 */
async function safeRealpath(inputPath: string): Promise<string> {
  try {
    return await realpath(inputPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // For non-existent paths, use path.resolve to get the absolute path
      // without resolving symlinks. This maintains the expected behavior
      // for paths that don't exist yet (e.g., when creating new files).
      return path.resolve(inputPath);
    }
    throw err;
  }
}

/**
 * Match a single path segment against a glob segment (no `/` inside).
 */
function matchSegment(part: string, pattern: string): boolean {
  const regex = globSegmentToRegex(pattern);
  return regex.test(part);
}

/**
 * Recursively match glob parts with support for `**`.
 */
function matchGlobParts(
  fileParts: string[],
  patParts: string[],
  fi: number,
  pi: number,
): boolean {
  // All pattern parts consumed
  if (pi >= patParts.length) {
    return fi >= fileParts.length || (fi === fileParts.length - 1 && fileParts[fi] === "");
  }

  const pat = patParts[pi];

  // `**` can match zero or more path parts
  if (pat === "**") {
    for (let i = fi; i <= fileParts.length; i++) {
      if (matchGlobParts(fileParts, patParts, i, pi + 1)) {
        return true;
      }
    }
    return false;
  }

  // Single pattern must consume exactly one file part
  if (fi >= fileParts.length) return false;
  if (!matchSegment(fileParts[fi], pat)) return false;

  return matchGlobParts(fileParts, patParts, fi + 1, pi + 1);
}

/**
 * Convert a single glob segment (without `/`) to an anchored RegExp.
 */
function globSegmentToRegex(pattern: string): RegExp {
  let src = "^";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      src += "[^/]*";
      i++;
    } else if (ch === "?") {
      src += "[^/]";
      i++;
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        src += "\\[";
        i++;
      } else {
        src += `[${pattern.slice(i + 1, end)}]`;
        i = end + 1;
      }
    } else if (/[.^$+(){}|\\]/.test(ch)) {
      // Escape regex metacharacters; letters/digits pass through as-is
      src += "\\" + ch;
      i++;
    } else {
      src += ch;
      i++;
    }
  }

  src += "$";
  return new RegExp(src);
}
