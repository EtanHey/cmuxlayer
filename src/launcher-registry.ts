import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CliType } from "./agent-types.js";
import { sanitizeRepoName } from "./agent-command.js";

export const DEFAULT_LAUNCHER_REGISTRY_PATH = join(
  homedir(),
  ".config/ralphtools/launchers.zsh",
);

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

function normalizeLauncherKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
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

export function parseLauncherRegistry(
  input: string,
  _sourcePath: string,
): LauncherRegistryEntry[] {
  const entries: LauncherRegistryEntry[] = [];
  for (const line of input.split(/\r?\n/)) {
    const words = shellWords(line.trim());
    if (words[0] !== "repoGolem" || words.length < 3) continue;
    const [, prefix, path] = words;
    if (!prefix || !path) continue;
    entries.push({
      prefix,
      path,
      repoBasename: basename(path),
    });
  }
  return entries;
}

function loadLauncherRegistry(
  options?: LauncherRegistryOptions,
): { entries: LauncherRegistryEntry[]; sourcePath: string } {
  const sourcePath = registryPath(options);
  if (options?.entries) return { entries: options.entries, sourcePath };
  const reader = options?.readRegistry ?? ((path: string) => readFileSync(path, "utf8"));
  let input: string;
  try {
    input = reader(sourcePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Launcher registry unavailable at ${sourcePath}: ${reason}. ` +
        "Register repoGolem launchers before using spawn_agent.",
    );
  }
  return {
    entries: parseLauncherRegistry(input, sourcePath),
    sourcePath,
  };
}

export function resolveLauncherPrefix(
  input: string,
  entries: readonly LauncherRegistryEntry[],
): string | null {
  const normalized = normalizeLauncherKey(input);
  for (const entry of entries) {
    if (
      normalizeLauncherKey(entry.prefix) === normalized ||
      normalizeLauncherKey(entry.repoBasename) === normalized ||
      normalizeLauncherKey(entry.path) === normalized
    ) {
      return entry.prefix;
    }
  }
  return null;
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
