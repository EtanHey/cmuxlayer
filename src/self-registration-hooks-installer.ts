import {
  access,
  chmod,
  copyFile,
  lstat,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { shellQuote } from "./shell-safe.js";
import { atomicWriteFile } from "./util/atomic-write.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

export interface InstallSessionHooksOptions {
  homeDir?: string;
  assetsDir?: string;
}

export interface InstallSessionHooksResult {
  changed: string[];
  backups: string[];
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * AIDEV-NOTE: installers before CX-2 U1b quoted with the `'"'"'` spelling. It is
 * the same shell word as shellQuote's `'\''`, and identical text for any path
 * without an apostrophe; matching it keeps a re-install from adding a second
 * copy of an already-installed hook.
 */
function legacyInstallerQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hookCommandSpellings(hookPath: string): string[] {
  return [
    `exec python3 ${shellQuote(hookPath)}`,
    `exec python3 ${legacyInstallerQuote(hookPath)}`,
  ];
}

function parseJsonObject(path: string, text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} must contain valid JSON; refusing to overwrite it`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${path} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sessionStartGroups(config: JsonObject, path: string): JsonObject[] {
  const hooks = config.hooks ?? (config.hooks = {});
  if (!isObject(hooks)) {
    throw new Error(`${path} hooks must be a JSON object; refusing to overwrite it`);
  }
  const groups = hooks.SessionStart ?? (hooks.SessionStart = []);
  if (!Array.isArray(groups) || !groups.every(isObject)) {
    throw new Error(
      `${path} hooks.SessionStart must be an array; refusing to overwrite it`,
    );
  }
  return groups;
}

function hasCommand(groups: JsonObject[], spellings: readonly string[]): boolean {
  return groups.some((group) => {
    const handlers = group.hooks;
    return (
      Array.isArray(handlers) &&
      handlers.some(
        (handler) =>
          isObject(handler) &&
          typeof handler.command === "string" &&
          spellings.includes(handler.command),
      )
    );
  });
}

function mergeClaudeSettings(config: JsonObject, path: string, hookPath: string) {
  const groups = sessionStartGroups(config, path);
  const [command] = hookCommandSpellings(hookPath);
  if (!hasCommand(groups, hookCommandSpellings(hookPath))) {
    groups.push({
      matcher: ".*",
      hooks: [
        {
          type: "command",
          command,
          timeout: 5,
          async: true,
        },
      ],
    });
  }
}

function mergeCodexHooks(config: JsonObject, path: string, hookPath: string) {
  const groups = sessionStartGroups(config, path);
  const [command] = hookCommandSpellings(hookPath);
  if (!hasCommand(groups, hookCommandSpellings(hookPath))) {
    groups.push({
      matcher: "startup|resume",
      hooks: [
        {
          type: "command",
          command,
          timeout: 5,
          async: true,
        },
      ],
    });
  }
}

async function nextBackupPath(path: string): Promise<string> {
  for (let index = 0; ; index += 1) {
    const candidate = index === 0 ? `${path}.bak` : `${path}.bak.${index}`;
    try {
      await access(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
}

async function writeChangedFile(
  path: string,
  content: string,
  result: InstallSessionHooksResult,
  mode?: number,
  defaultMode?: number,
): Promise<void> {
  const existing = await readOptional(path);
  if (existing === content) {
    if (mode !== undefined) await chmod(path, mode);
    return;
  }
  let writePath = path;
  let writeMode = mode;
  if (existing !== null) {
    if ((await lstat(path)).isSymbolicLink()) {
      writePath = await realpath(path);
    }
    if (writeMode === undefined) {
      writeMode = (await stat(writePath)).mode & 0o7777;
    }
    const backup = await nextBackupPath(path);
    await copyFile(path, backup);
    result.backups.push(backup);
  } else if (writeMode === undefined) {
    writeMode = defaultMode;
  }
  await atomicWriteFile(writePath, content, { mkdir: true, mode: writeMode });
  if (writeMode !== undefined) await chmod(writePath, writeMode);
  result.changed.push(path);
}

export function defaultSessionHookAssetsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "hooks");
}

export async function installSessionHooks(
  options: InstallSessionHooksOptions = {},
): Promise<InstallSessionHooksResult> {
  const homeDir = options.homeDir ?? homedir();
  const assetsDir = options.assetsDir ?? defaultSessionHookAssetsDir();
  const claudeSettingsPath = join(homeDir, ".claude", "settings.json");
  const codexHooksPath = join(homeDir, ".codex", "hooks.json");
  const claudeHookPath = join(homeDir, ".claude", "hooks", "cmux-self-register.py");
  const codexHookPath = join(
    homeDir,
    ".codex",
    "hooks",
    "codex-cmux-self-register.py",
  );

  const [claudeText, codexText, claudeAsset, codexAsset] = await Promise.all([
    readOptional(claudeSettingsPath),
    readOptional(codexHooksPath),
    readFile(join(assetsDir, "cmux-self-register.py"), "utf8"),
    readFile(join(assetsDir, "codex-cmux-self-register.py"), "utf8"),
  ]);

  // Parse and validate every existing config before making the first mutation.
  const claudeConfig = claudeText !== null
    ? parseJsonObject(claudeSettingsPath, claudeText)
    : {};
  const codexConfig =
    codexText !== null ? parseJsonObject(codexHooksPath, codexText) : {};
  mergeClaudeSettings(claudeConfig, claudeSettingsPath, claudeHookPath);
  mergeCodexHooks(codexConfig, codexHooksPath, codexHookPath);

  const result: InstallSessionHooksResult = { changed: [], backups: [] };
  await writeChangedFile(claudeHookPath, claudeAsset, result, 0o755);
  await writeChangedFile(codexHookPath, codexAsset, result, 0o755);
  await writeChangedFile(
    claudeSettingsPath,
    JSON.stringify(claudeConfig, null, 2) + "\n",
    result,
    undefined,
    0o600,
  );
  await writeChangedFile(
    codexHooksPath,
    JSON.stringify(codexConfig, null, 2) + "\n",
    result,
    undefined,
    0o600,
  );
  return result;
}
