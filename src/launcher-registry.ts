import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { CliType } from "./agent-types.js";
import { sanitizeRepoName } from "./agent-command.js";

/** Where the repoGolem launcher registry lives under a given home dir. */
export function launcherRegistryPathForHome(home: string): string {
  return join(home, ".config/ralphtools/launchers.zsh");
}

export const DEFAULT_LAUNCHER_REGISTRY_PATH =
  launcherRegistryPathForHome(homedir());

export interface LauncherRegistryEntry {
  prefix: string;
  path: string;
  repoBasename: string;
}

export interface LauncherRegistryOptions {
  sourcePath?: string;
  entries?: LauncherRegistryEntry[];
  readRegistry?: (path: string) => string;
}

export type LauncherSuffix = "Claude" | "Codex" | "Cursor" | "Gemini";

const CLI_SUFFIX: Partial<Record<CliType, LauncherSuffix>> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
};

const LAUNCHER_SUFFIXES: LauncherSuffix[] = [
  "Claude",
  "Codex",
  "Cursor",
  "Gemini",
];

function registryPath(options?: LauncherRegistryOptions): string {
  return (
    options?.sourcePath ??
    process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH ??
    DEFAULT_LAUNCHER_REGISTRY_PATH
  );
}

/**
 * Registry key normalization: case-, hyphen-, and underscore-insensitive.
 * Exported so the registry-less fallback path matches repos to directories by
 * exactly the same rule the registered path uses (spawn/resume parity).
 */
export function normalizeRepoKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
}

function normalizeLauncherKey(value: string): string {
  return normalizeRepoKey(value);
}

function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") break;
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

/**
 * Read one registry line, or null when the line is not a registration.
 *
 * Exported so a writer can patch registrations IN PLACE and leave everything
 * else — shell functions, aliases, source guards, comments — untouched. A
 * registry file is a hand-maintained zsh file that happens to contain
 * `repoGolem` lines, not a file cmuxlayer owns.
 */
export function parseLauncherRegistryLine(
  line: string,
): { prefix: string; path: string } | null {
  const words = shellWords(line.trim());
  if (words[0] !== "repoGolem" || words.length < 3) return null;
  const [, prefix, path] = words;
  if (!prefix || !path) return null;
  return { prefix, path };
}

export function parseLauncherRegistry(
  input: string,
  _sourcePath: string,
): LauncherRegistryEntry[] {
  const entries: LauncherRegistryEntry[] = [];
  for (const line of input.split(/\r?\n/)) {
    const parsed = parseLauncherRegistryLine(line);
    if (!parsed) continue;
    entries.push({
      prefix: parsed.prefix,
      path: parsed.path,
      repoBasename: basename(parsed.path),
    });
  }
  return entries;
}

/**
 * Non-throwing registry probe. The registry is an OPTIONAL enhancement
 * (issue #392): a fresh install has no `launchers.zsh`, and that is a
 * supported state, not an error. Callers that need the strict behaviour keep
 * using the throwing resolvers below.
 */
export interface LauncherRegistrySnapshot {
  available: boolean;
  entries: LauncherRegistryEntry[];
  sourcePath: string;
  unavailable_reason: string | null;
}

export function loadLauncherRegistrySnapshot(
  options?: LauncherRegistryOptions,
): LauncherRegistrySnapshot {
  const sourcePath = registryPath(options);
  if (options?.entries) {
    return {
      available: true,
      entries: options.entries,
      sourcePath,
      unavailable_reason: null,
    };
  }
  const reader =
    options?.readRegistry ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    const input = reader(sourcePath);
    return {
      available: true,
      entries: parseLauncherRegistry(input, sourcePath),
      sourcePath,
      unavailable_reason: null,
    };
  } catch (error) {
    return {
      available: false,
      entries: [],
      sourcePath,
      unavailable_reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function loadLauncherRegistry(
  options?: LauncherRegistryOptions,
): { entries: LauncherRegistryEntry[]; sourcePath: string } {
  const snapshot = loadLauncherRegistrySnapshot(options);
  if (!snapshot.available) {
    throw new Error(
      `Launcher registry unavailable at ${snapshot.sourcePath}: ` +
        `${snapshot.unavailable_reason}. ` +
        "Register repoGolem launchers before using spawn_agent.",
    );
  }
  return { entries: snapshot.entries, sourcePath: snapshot.sourcePath };
}

export function resolveLauncherPrefix(
  input: string,
  entries: readonly LauncherRegistryEntry[],
): string | null {
  return resolveLauncherEntry(input, entries)?.prefix ?? null;
}

function resolveLauncherEntry(
  input: string,
  entries: readonly LauncherRegistryEntry[],
): LauncherRegistryEntry | null {
  const normalized = normalizeLauncherKey(input);
  const exactPrefix = entries.find(
    (entry) => normalizeLauncherKey(entry.prefix) === normalized,
  );
  if (exactPrefix) return exactPrefix;

  const fallbackMatches = entries.filter(
    (entry) =>
      normalizeLauncherKey(entry.repoBasename) === normalized ||
      normalizeLauncherKey(entry.path) === normalized,
  );
  if (fallbackMatches.length === 0) return null;
  const paths = new Set(fallbackMatches.map((entry) => resolve(entry.path)));
  if (paths.size > 1) {
    throw new Error(
      `Ambiguous launcher registry match for repo "${input}": ${fallbackMatches
        .map((entry) => `${entry.prefix}=${entry.path}`)
        .join(", ")}. Use the exact launcher prefix.`,
    );
  }
  return fallbackMatches[0] ?? null;
}

function launcherName(prefix: string, suffix: LauncherSuffix): string {
  return `${prefix}${suffix}`;
}

function registeredLauncherSummary(
  entries: readonly LauncherRegistryEntry[],
): string {
  if (entries.length === 0) return "(none parsed)";
  return entries
    .map((entry) => {
      const names = LAUNCHER_SUFFIXES.map((suffix) =>
        launcherName(entry.prefix, suffix),
      ).join(", ");
      return `${entry.prefix} (${entry.repoBasename} at ${entry.path}): ${names}`;
    })
    .join("; ");
}

export function launcherNameCandidates(
  repo: string,
  suffix: LauncherSuffix,
  entries?: readonly LauncherRegistryEntry[],
): string[] {
  const safeRepo = sanitizeRepoName(repo);
  const prefixes = [safeRepo, safeRepo.replace(/-/g, "").toLowerCase()];
  const registeredPrefix = entries
    ? resolveLauncherPrefix(repo, entries)
    : null;
  if (registeredPrefix) prefixes.push(registeredPrefix);
  return [...new Set(prefixes)].map((prefix) => launcherName(prefix, suffix));
}

export function resolveLauncherNameFromRegistry(
  repo: string,
  cli: CliType,
  options?: LauncherRegistryOptions,
): string {
  const suffix = CLI_SUFFIX[cli];
  if (!suffix) return sanitizeRepoName(repo);

  const { entries, sourcePath } = loadLauncherRegistry(options);
  const registeredPrefix = resolveLauncherPrefix(repo, entries);
  if (registeredPrefix) return launcherName(registeredPrefix, suffix);

  const candidates = launcherNameCandidates(repo, suffix);
  throw new Error(
    `Launcher registry miss for repo "${repo}" cli="${cli}". ` +
      `Resolved candidates: ${candidates.join(", ")}. ` +
      `Registry source: ${sourcePath}. ` +
      `Registered launchers: ${registeredLauncherSummary(entries)}.`,
  );
}

export function resolveRepoRootFromLauncherRegistry(
  repo: string,
  options?: LauncherRegistryOptions,
): string {
  const { entries, sourcePath } = loadLauncherRegistry(options);
  const entry = resolveLauncherEntry(repo, entries);
  if (!entry) {
    throw new Error(
      `Launcher registry miss for repo "${repo}". ` +
        `Registry source: ${sourcePath}. ` +
        `Registered launchers: ${registeredLauncherSummary(entries)}.`,
    );
  }
  if (!isAbsolute(entry.path)) {
    throw new Error(
      `Launcher registry path for repo "${repo}" must be absolute: ` +
        `"${entry.path}" in ${sourcePath}.`,
    );
  }
  return resolve(entry.path);
}

/**
 * Registry-optional launcher lookup: `null` means "no registry, or no entry
 * for this repo" — the caller should fall back to the raw CLI. A malformed
 * registry (ambiguous alias, relative path) still throws, because that is a
 * broken config rather than an absent one.
 */
export function resolveLauncherNameFromRegistryOrNull(
  repo: string,
  cli: CliType,
  options?: LauncherRegistryOptions,
): string | null {
  const suffix = CLI_SUFFIX[cli];
  if (!suffix) return null;

  const { entries } = loadLauncherRegistrySnapshot(options);
  const registeredPrefix = resolveLauncherPrefix(repo, entries);
  return registeredPrefix ? launcherName(registeredPrefix, suffix) : null;
}

/** Registry-optional repo-root lookup. See the launcher variant above. */
export function resolveRepoRootFromLauncherRegistryOrNull(
  repo: string,
  options?: LauncherRegistryOptions,
): string | null {
  const { entries, sourcePath } = loadLauncherRegistrySnapshot(options);
  const entry = resolveLauncherEntry(repo, entries);
  if (!entry) return null;
  if (!isAbsolute(entry.path)) {
    throw new Error(
      `Launcher registry path for repo "${repo}" must be absolute: ` +
        `"${entry.path}" in ${sourcePath}.`,
    );
  }
  return resolve(entry.path);
}
