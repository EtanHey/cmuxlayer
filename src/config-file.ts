/**
 * Reading `~/.config/cmuxlayer/env.sh` — the file `cmuxlayer init` writes.
 *
 * AIDEV-NOTE: the wizard used to write a file that only a *shell* would read.
 * An MCP client launched from the GUI (Claude Desktop, VS Code, a launchd
 * agent) never sources `~/.zshrc`, so on those machines `CMUXLAYER_REPO_HOME`
 * was absent — the exact fresh-machine failure the wizard exists to remove —
 * and worse, `--permissions ask` failed OPEN back to skip-permissions, because
 * an unset variable resolves to the default. A security-relevant answer that
 * quietly reverts is worse than one never offered. The server now reads the
 * file itself at startup.
 *
 * Two rules keep this safe:
 *   - the real environment always wins, so a client that DOES export a value
 *     is never overridden by a stale file;
 *   - only known cmuxlayer settings are applied, so a config file can never
 *     inject arbitrary environment into the server process.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_FILE_ENV = "CMUXLAYER_CONFIG_FILE";

/**
 * Settings a config file may set. Anything else in the file is ignored and
 * reported, never applied.
 */
export const CONFIGURABLE_KEYS = [
  "CMUXLAYER_REPO_HOME",
  "CMUXLAYER_SPAWN_PERMISSION_MODE",
  "CMUXLAYER_LAUNCHER_REGISTRY_PATH",
  "CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY",
] as const;

export type ConfigurableKey = (typeof CONFIGURABLE_KEYS)[number];

export function defaultConfigFilePath(
  env: Record<string, string | undefined> = process.env,
  home: string = env.HOME?.trim() || homedir(),
): string {
  const override = env[CONFIG_FILE_ENV]?.trim();
  if (override) return override;
  return join(home, ".config", "cmuxlayer", "env.sh");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return trimmed;
}

/**
 * Read `export KEY=value` / `KEY=value` assignments. This is deliberately NOT
 * a shell: no expansion, no substitution, no execution. A line it cannot read
 * is skipped, because a config file must never be able to run anything.
 */
export function parseShellEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    values[key] = unquote(rawValue);
  }
  return values;
}

export interface LoadedConfigFile {
  path: string;
  found: boolean;
  /** Keys taken from the file because the environment did not set them. */
  applied: ConfigurableKey[];
  /** Keys the file set that the real environment already answered. */
  overridden: ConfigurableKey[];
  /** Keys the file set that cmuxlayer does not accept from a config file. */
  ignored: string[];
  error: string | null;
}

export interface LoadConfigFileOptions {
  path?: string;
  env?: Record<string, string | undefined>;
  /** Where resolved values land. Defaults to the same object as `env`. */
  target?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

/**
 * What the startup load did, for anything that needs to REPORT it later.
 *
 * AIDEV-NOTE: without this, `doctor` re-loads and sees the values the startup
 * loader already put in `process.env`, so it reports "the environment already
 * sets these" about its own work — true of the object, false about the machine.
 */
let lastStartupLoad: LoadedConfigFile | null = null;

export function getLoadedConfigFile(): LoadedConfigFile | null {
  return lastStartupLoad;
}

/** Test-only: forget the recorded startup load. */
export function resetLoadedConfigFile(): void {
  lastStartupLoad = null;
}

/**
 * Load the config file into the process environment. Idempotent, non-throwing:
 * a missing or unreadable file is a supported state, not an error.
 */
export function loadCmuxlayerConfigFile(
  options?: LoadConfigFileOptions,
): LoadedConfigFile {
  const env = options?.env ?? process.env;
  const target = options?.target ?? env;
  const path = options?.path ?? defaultConfigFilePath(env);
  const read = options?.readFile ?? ((at: string) => readFileSync(at, "utf8"));

  // Only a load into the live process environment is a "startup load" worth
  // recording; a scratch load (doctor, tests) must not clobber that record.
  const isProcessLoad = target === process.env;
  const record = (loaded: LoadedConfigFile): LoadedConfigFile => {
    if (isProcessLoad) lastStartupLoad = loaded;
    return loaded;
  };

  let contents: string;
  try {
    contents = read(path);
  } catch (error) {
    return record({
      path,
      found: false,
      applied: [],
      overridden: [],
      ignored: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const values = parseShellEnvFile(contents);
  const applied: ConfigurableKey[] = [];
  const overridden: ConfigurableKey[] = [];
  const ignored: string[] = [];

  for (const [key, value] of Object.entries(values)) {
    if (!(CONFIGURABLE_KEYS as readonly string[]).includes(key)) {
      ignored.push(key);
      continue;
    }
    const configurable = key as ConfigurableKey;
    // The real environment is authoritative; the file only fills gaps.
    if (env[configurable]?.trim()) {
      overridden.push(configurable);
      continue;
    }
    target[configurable] = value;
    applied.push(configurable);
  }

  return record({
    path,
    found: true,
    applied,
    overridden,
    ignored,
    error: null,
  });
}
