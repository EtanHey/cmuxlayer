/**
 * `cmuxlayer init` — the fresh-machine setup wizard.
 *
 * AIDEV-NOTE: AGENTS.md law — "Don't assume my setup: someone installing this
 * fresh has none of my skills or launchers." This wizard is the other half of
 * the registry-optional spawn contract (docs/registry-optional-spawn.md): that
 * work made cmuxlayer *tolerate* a missing launcher registry, and this one
 * GENERATES the config for whichever of the two lanes the machine can run.
 *
 * Everything here is pure and injectable — the filesystem, the environment,
 * and the terminal all arrive as parameters — so the generated artifacts can
 * be tested by parsing them back with the same readers the engine uses.
 */

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { sanitizeRepoName, shellQuote } from "./agent-command.js";
import {
  launcherRegistryPathForHome,
  normalizeRepoKey,
  parseLauncherRegistryLine,
} from "./launcher-registry.js";
import {
  DEFAULT_SPAWN_PERMISSION_MODE,
  type SpawnPermissionMode,
} from "./permission-mode.js";

export type InitLaunchMode = "launcher" | "raw";
export type InitPermissionMode = SpawnPermissionMode;

/** Copy shown to whoever runs the wizard. Kept in one place so it can be
 * reviewed as prose, and asserted to stay free of any one machine's habits. */
export const WIZARD_COPY = {
  intro: [
    "cmuxlayer init — set up agent spawning on this machine.",
    "",
    "cmuxlayer starts coding-agent CLIs (claude, codex, cursor, gemini) inside",
    "cmux terminal panes. To do that it needs to know two things: where your",
    "repositories live, and how each agent should be started.",
    "",
    "Nothing is written until the end, and every answer has a default you can",
    "accept with Enter.",
  ],
  repoSection: [
    "",
    "1. Repositories",
    "   Add each checkout you want to be able to spawn agents in. Give the",
    "   absolute path to the repository root. Press Enter on an empty path when",
    "   you are done.",
  ],
  repoPathPrompt: "Repository path (Enter when done): ",
  repoNamePrompt: (suggestion: string) =>
    `  Name agents will use for it [${suggestion}]: `,
  modeSection: [
    "",
    "2. How agents are started",
    "   1) Shell launcher functions — you already have wrapper commands such as",
    "      `myrepoClaude` that cd into the repo and wire up your own config.",
    "      cmuxlayer will call those.",
    "   2) The CLI binaries directly — cmuxlayer cds into the repo itself and",
    "      runs `claude` / `codex` / `cursor` / `gemini`. Pick this if you are",
    "      not sure; it needs nothing besides the CLIs on your PATH.",
  ],
  modePrompt: (defaultChoice: string) => `Choice [${defaultChoice}]: `,
  modeLauncherUnavailable:
    "   Option 1 is unavailable: no launcher registry was found on this machine.",
  permissionSection: [
    "",
    "3. Tool approvals",
    "   1) Run unattended — agents start with their CLI's approval prompt",
    "      bypassed, so they can edit files and run commands without stopping to",
    "      ask. This is what makes an agent in a background pane useful, and it",
    "      is also a real risk: only choose it for repositories you trust.",
    "   2) Ask every time — agents start in their CLI's normal mode and will sit",
    "      waiting for approval on their first tool call.",
  ],
  permissionPrompt: (defaultChoice: string) => `Choice [${defaultChoice}]: `,
  writeSection: ["", "4. Writing configuration"],
  overwritePrompt:
    "Rewrite it? The current file is backed up first [y/N]: ",
  doneHint: [
    "",
    "Done. Load the configuration in new shells by adding this line to your",
    "shell profile (~/.zshrc, ~/.bashrc, ...):",
  ],
} as const;

export const INIT_HELP_TEXT = `cmuxlayer init — set up agent spawning on this machine.

Usage:
  cmuxlayer init                       Run the interactive wizard.
  cmuxlayer init --yes --repo <spec>   Non-interactive setup for scripted installs.

Options:
  --repo <name>=<path>   Register a repository. Repeatable. <name>= may be
                         omitted, in which case the directory name is used.
  --mode <launcher|raw|auto>
                         How agents are started. "launcher" calls shell
                         launcher functions named <prefix><Cli>; "raw" runs the
                         CLI binaries directly. "auto" (default) picks
                         "launcher" only when a launcher registry already
                         exists on this machine.
  --permissions <skip|ask>
                         "skip" (default) starts agents with their CLI approval
                         prompt bypassed so they can work unattended. "ask"
                         leaves the CLI in its normal, prompting mode.
  --require-registry     Fail a spawn whose repo has no launcher entry instead
                         of falling back to the raw CLI.
  --registry-path <path> Where to write the launcher registry.
  --config-path <path>   Where to write the environment config.
  --print                Print what would be written and exit; write nothing.
  --force                Rewrite files that already exist. Without it, an
                         existing file is only rewritten after you confirm at
                         the prompt, and --yes refuses outright. Either way the
                         current contents are copied to <file>.bak first. A
                         launcher registry is patched in place: its
                         non-registration lines are always preserved.
  --yes, -y              Do not prompt; use the flags above.
  --help, -h             Print this help and exit.

Examples:
  cmuxlayer init
  cmuxlayer init --yes --repo ~/code/my-app --repo api=/srv/api
  cmuxlayer init --yes --repo ~/code/my-app --permissions ask --print
`;

export interface InitRepoInput {
  name: string;
  path: string;
}

export interface InitOptions {
  yes: boolean;
  repos: InitRepoInput[];
  mode: InitLaunchMode | "auto";
  permissionMode: InitPermissionMode;
  requireRegistry: boolean;
  registryPath?: string;
  configPath?: string;
  print: boolean;
  force: boolean;
  help: boolean;
}

export type ParseInitArgsResult =
  | { ok: true; options: InitOptions }
  | { ok: false; error: string };

function needValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value.`);
  }
  return value;
}

function parseRepoSpec(spec: string): InitRepoInput {
  const separator = spec.indexOf("=");
  if (separator > 0) {
    const name = spec.slice(0, separator).trim();
    const path = spec.slice(separator + 1).trim();
    if (!name || !path) {
      throw new Error(`--repo needs <name>=<path>, got "${spec}".`);
    }
    return { name, path };
  }
  const path = spec.trim();
  if (!path) throw new Error("--repo needs a value.");
  return { name: basename(path), path };
}

export function parseInitArgs(argv: readonly string[]): ParseInitArgsResult {
  const options: InitOptions = {
    yes: false,
    repos: [],
    mode: "auto",
    permissionMode: DEFAULT_SPAWN_PERMISSION_MODE,
    requireRegistry: false,
    print: false,
    force: false,
    help: false,
  };

  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index] ?? "";
      const inlineAt = arg.indexOf("=");
      const flag = inlineAt > 0 ? arg.slice(0, inlineAt) : arg;
      const inline = inlineAt > 0 ? arg.slice(inlineAt + 1) : undefined;
      const take = (): string =>
        inline !== undefined ? inline : needValue(flag, argv[++index]);

      switch (flag) {
        case "--help":
        case "-h":
          options.help = true;
          break;
        case "--yes":
        case "-y":
          options.yes = true;
          break;
        case "--print":
          options.print = true;
          break;
        case "--force":
          options.force = true;
          break;
        case "--require-registry":
          options.requireRegistry = true;
          break;
        case "--repo":
          options.repos.push(parseRepoSpec(take()));
          break;
        case "--mode": {
          const value = take().trim().toLowerCase();
          if (value !== "launcher" && value !== "raw" && value !== "auto") {
            throw new Error(
              `--mode must be "launcher", "raw", or "auto", got "${value}".`,
            );
          }
          options.mode = value;
          break;
        }
        case "--permissions": {
          const value = take().trim().toLowerCase();
          if (value === "skip" || value === "skip-permissions") {
            options.permissionMode = "skip-permissions";
          } else if (value === "ask" || value === "default") {
            options.permissionMode = "default";
          } else {
            throw new Error(
              `--permissions must be "skip" or "ask", got "${value}".`,
            );
          }
          break;
        }
        case "--registry-path":
          options.registryPath = take();
          break;
        case "--config-path":
          options.configPath = take();
          break;
        default:
          throw new Error(
            `Unknown option "${arg}". Run \`cmuxlayer init --help\`.`,
          );
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { ok: true, options };
}

/** Everything the wizard needs to know about the machine it is running on. */
export interface InitEnvironment {
  homeDir: string;
  env: Record<string, string | undefined>;
  isDirectory(path: string): boolean;
  fileExists(path: string): boolean;
  /** Existing file contents, or null when unreadable. Used to MERGE into a
   * launcher registry the machine already has instead of replacing it. */
  readFile?(path: string): string | null;
}

export function defaultRegistryPath(environment: InitEnvironment): string {
  const override = environment.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH?.trim();
  if (override) return override;
  return launcherRegistryPathForHome(environment.homeDir);
}

export function defaultConfigPath(environment: InitEnvironment): string {
  return join(environment.homeDir, ".config/cmuxlayer/env.sh");
}

export interface RepoGolemDetection {
  available: boolean;
  registryPath: string;
  reason: string;
}

/**
 * Are shell launcher functions set up on this machine? The registry file is
 * the only thing cmuxlayer can actually read — a zsh function is invisible to
 * a non-interactive child process — so its presence is the signal.
 */
export function detectRepoGolem(
  environment: InitEnvironment,
): RepoGolemDetection {
  const registryPath = defaultRegistryPath(environment);
  if (environment.fileExists(registryPath)) {
    return {
      available: true,
      registryPath,
      reason: `Found a repoGolem launcher registry at ${registryPath}.`,
    };
  }
  return {
    available: false,
    registryPath,
    reason:
      `No repoGolem launcher registry at ${registryPath}. ` +
      "cmuxlayer will run the agent CLIs directly instead.",
  };
}

export interface InitAnswers {
  repos: InitRepoInput[];
  launchMode: InitLaunchMode;
  permissionMode: InitPermissionMode;
  requireRegistry: boolean;
  registryPath: string;
  configPath: string;
}

/** Turn parsed flags into the answers the plan builder consumes. */
export function resolveInitAnswers(
  options: InitOptions,
  environment: InitEnvironment,
): InitAnswers {
  const detection = detectRepoGolem(environment);
  let launchMode: InitLaunchMode;
  if (options.mode === "auto") {
    launchMode = detection.available ? "launcher" : "raw";
  } else {
    launchMode = options.mode;
  }
  if (launchMode === "launcher" && !detection.available) {
    throw new Error(
      `--mode launcher needs repoGolem launchers on this machine. ${detection.reason}`,
    );
  }
  return {
    repos: options.repos,
    launchMode,
    permissionMode: options.permissionMode,
    requireRegistry: options.requireRegistry,
    registryPath: options.registryPath ?? detection.registryPath,
    configPath: options.configPath ?? defaultConfigPath(environment),
  };
}

export interface ResolvedInitRepo extends InitRepoInput {
  launcherPrefix: string;
}

/**
 * repoGolem launcher naming: `{repo}{Cli}` with hyphens stripped
 * (`beta-tool` -> `betatoolClaude`). The registry lookup normalizes case,
 * hyphens, and underscores anyway, so this only has to be stable.
 */
export function launcherPrefixForRepo(name: string): string {
  return sanitizeRepoName(name).replace(/-/g, "");
}

const REGISTRY_HEADER = [
  "# repoGolem launcher registry — generated by `cmuxlayer init`.",
  "#",
  "# One line per repository:",
  "#   repoGolem <launcher-prefix> <absolute path to the repository root>",
  "#",
  "# cmuxlayer reads the prefix and the path. It starts an agent by running",
  "# <prefix>Claude / <prefix>Codex / <prefix>Cursor / <prefix>Gemini, so those",
  "# commands must exist in the shell your terminal panes start.",
  "",
];

function registryLine(prefix: string, path: string): string {
  // The registry parser understands shell quoting; only quote when needed so
  // a hand-maintained file stays readable.
  const rendered = /^[A-Za-z0-9._\-/~]+$/.test(path) ? path : shellQuote(path);
  return `repoGolem ${prefix} ${rendered}`;
}

export interface RegistryRepoint {
  prefix: string;
  from: string;
  to: string;
}

export interface LauncherRegistryPatch {
  contents: string;
  /** Registrations whose path this run changes. Reported, never silent. */
  repoints: RegistryRepoint[];
}

/**
 * Patch `repoGolem` registrations into an existing registry LINE BY LINE.
 *
 * AIDEV-NOTE: an earlier version of this rebuilt the file from the entries it
 * could parse. That silently deleted every line that is not a registration —
 * and a real `launchers.zsh` is mostly shell functions, aliases, and a source
 * guard, with the `repoGolem` lines a minority. Rebuilding it would have
 * destroyed exactly the setup the wizard was pointed at. Non-registration
 * lines are now preserved verbatim; a matching registration is rewritten where
 * it stands, so the file keeps its own order and grouping.
 */
export function patchLauncherRegistry(
  repos: readonly ResolvedInitRepo[],
  existing?: string | null,
): LauncherRegistryPatch {
  if (existing === null || existing === undefined) {
    return {
      contents: `${[
        ...REGISTRY_HEADER,
        ...repos.map((repo) => registryLine(repo.launcherPrefix, repo.path)),
      ].join("\n")}\n`,
      repoints: [],
    };
  }

  const byKey = new Map(
    repos.map((repo) => [normalizeRepoKey(repo.launcherPrefix), repo]),
  );
  const written = new Set<string>();
  const repoints: RegistryRepoint[] = [];

  const lines = existing.split(/\r?\n/);
  const patched = lines.map((line) => {
    const parsed = parseLauncherRegistryLine(line);
    if (!parsed) return line;
    const key = normalizeRepoKey(parsed.prefix);
    const repo = byKey.get(key);
    if (!repo) return line;
    written.add(key);
    if (resolve(parsed.path) !== resolve(repo.path)) {
      repoints.push({
        prefix: parsed.prefix,
        from: parsed.path,
        to: repo.path,
      });
    }
    return registryLine(repo.launcherPrefix, repo.path);
  });

  const appended = repos
    .filter((repo) => !written.has(normalizeRepoKey(repo.launcherPrefix)))
    .map((repo) => registryLine(repo.launcherPrefix, repo.path));

  if (appended.length > 0) {
    // Keep a single trailing blank line rather than growing one per run.
    while (patched.length > 0 && patched[patched.length - 1]?.trim() === "") {
      patched.pop();
    }
    patched.push("", ...appended);
  }

  const contents = patched.join("\n");
  return {
    contents: contents.endsWith("\n") ? contents : `${contents}\n`,
    repoints,
  };
}

/** Back-compat shim: render just the contents of a patched registry. */
export function renderLauncherRegistry(
  repos: readonly ResolvedInitRepo[],
  existing?: string | null,
): string {
  return patchLauncherRegistry(repos, existing).contents;
}

export interface EnvConfigInput {
  repoHomes: readonly string[];
  permissionMode: InitPermissionMode;
  registryPath: string | null;
  requireRegistry: boolean;
}

export function renderEnvConfig(input: EnvConfigInput): string {
  const lines: string[] = [
    "# cmuxlayer configuration — generated by `cmuxlayer init`.",
    "#",
    "# Source this from your shell profile so the terminal panes cmuxlayer",
    "# starts inherit it.",
    "",
  ];

  if (input.repoHomes.length > 0) {
    lines.push(
      "# Directories that contain your checkouts. cmuxlayer resolves a repo",
      "# named <repo> by looking for <root>/<repo> in each of these, in order.",
      `export CMUXLAYER_REPO_HOME=${shellQuote(input.repoHomes.join(":"))}`,
      "",
    );
  }

  if (input.registryPath) {
    lines.push(
      "# Where the launcher registry lives.",
      `export CMUXLAYER_LAUNCHER_REGISTRY_PATH=${shellQuote(input.registryPath)}`,
      "",
    );
  }

  lines.push(
    "# How agents handle tool approvals.",
    "#   skip-permissions  agents run unattended; their CLI approval prompt is",
    "#                     bypassed, so they can edit files and run commands",
    "#                     without waiting for you.",
    "#   default           agents use their CLI's normal mode and stop to ask.",
    `export CMUXLAYER_SPAWN_PERMISSION_MODE=${shellQuote(input.permissionMode)}`,
    "",
  );

  if (input.requireRegistry) {
    lines.push(
      "# Fail a spawn whose repo has no launcher entry, instead of quietly",
      "# falling back to running the CLI directly.",
      "export CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1",
      "",
    );
  }

  return lines.join("\n");
}

export type InitArtifactKind = "launcher-registry" | "env" | "backup";

export interface InitArtifact {
  kind: InitArtifactKind;
  path: string;
  contents: string;
  /**
   * "create" when nothing is there, "update" when this run rewrites a file
   * that already exists. Every "update" is confirmed and backed up first —
   * see `runInitCommand`.
   */
  mode: "create" | "update";
  /** For an "update": where the current contents are preserved first. */
  backupPath?: string;
}

export interface InitPlan {
  launchMode: InitLaunchMode;
  permissionMode: InitPermissionMode;
  repos: ResolvedInitRepo[];
  repoHomes: string[];
  artifacts: InitArtifact[];
  warnings: string[];
  /** Files this run would rewrite. Empty on a clean machine. */
  updates: InitArtifact[];
}

/**
 * A backup path that never overwrites an earlier backup. Deterministic, so a
 * run is reproducible and a test can name the file it expects.
 */
export function backupPathFor(
  path: string,
  exists: (candidate: string) => boolean,
): string {
  const base = `${path}.bak`;
  if (!exists(base)) return base;
  for (let index = 1; index < 1000; index++) {
    const candidate = `${base}.${index}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused backup path next to ${path}.`);
}

/**
 * Derive the raw-lane search roots from the registered repos. The raw lane
 * looks for `<root>/<repo>`, so a checkout whose directory name differs from
 * the name agents use cannot be found that way — the caller is warned rather
 * than handed a root that will never match.
 */
function repoHomesFor(repos: readonly ResolvedInitRepo[]): string[] {
  const roots: string[] = [];
  for (const repo of repos) {
    if (basename(repo.path) !== sanitizeRepoName(repo.name)) continue;
    const root = dirname(repo.path);
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

export function buildInitPlan(
  answers: InitAnswers,
  environment: InitEnvironment,
): InitPlan {
  if (answers.repos.length === 0) {
    throw new Error(
      "Register at least one repo: `cmuxlayer init --yes --repo <name>=<path>`.",
    );
  }

  const warnings: string[] = [];
  const seen = new Map<string, string>();
  const repos: ResolvedInitRepo[] = answers.repos.map((repo) => {
    const name = sanitizeRepoName(repo.name.trim());
    const path = repo.path.trim();
    if (!isAbsolute(path)) {
      throw new Error(
        `Repository path for "${name}" must be absolute, got "${path}".`,
      );
    }
    const previous = seen.get(name.toLowerCase());
    if (previous) {
      throw new Error(
        `Repo "${name}" is registered twice (${previous} and ${path}). ` +
          "Names must be unique — agents address a repo by this name.",
      );
    }
    seen.set(name.toLowerCase(), path);
    if (!environment.isDirectory(path)) {
      warnings.push(
        `${path} is not a directory right now. The entry is still written; ` +
          "spawning in it will fail until the checkout exists.",
      );
    }
    if (
      answers.launchMode === "raw" &&
      basename(path) !== name
    ) {
      warnings.push(
        `Repo "${name}" lives in a directory named "${basename(path)}". ` +
          "Without a launcher registry cmuxlayer finds a repo by directory " +
          `name, so pass repo="${basename(path)}" when you spawn, rename the ` +
          "directory, or re-run with --mode launcher.",
      );
    }
    return { name, path, launcherPrefix: launcherPrefixForRepo(name) };
  });

  const repoHomes = repoHomesFor(repos);
  const artifacts: InitArtifact[] = [];

  const plan = (path: string, kind: InitArtifactKind, contents: string) => {
    const exists = environment.fileExists(path);
    if (!exists) {
      artifacts.push({ kind, path, contents, mode: "create" });
      return;
    }
    const backupPath = backupPathFor(path, environment.fileExists);
    artifacts.push({
      kind: "backup",
      path: backupPath,
      contents: environment.readFile?.(path) ?? "",
      mode: "create",
    });
    artifacts.push({ kind, path, contents, mode: "update", backupPath });
  };

  if (answers.launchMode === "launcher") {
    const existing = environment.readFile?.(answers.registryPath) ?? null;
    const patch = patchLauncherRegistry(repos, existing);
    plan(answers.registryPath, "launcher-registry", patch.contents);
    for (const repoint of patch.repoints) {
      warnings.push(
        `"${repoint.prefix}" is already registered at ${repoint.from}; this ` +
          `run repoints it to ${repoint.to}.`,
      );
    }
    warnings.push(
      "Launcher mode assumes the commands " +
        repos.map((repo) => `${repo.launcherPrefix}Claude`).join(", ") +
        " already exist in the shell your terminal panes start. cmuxlayer " +
        "does not create them.",
    );
  }

  plan(
    answers.configPath,
    "env",
    renderEnvConfig({
      repoHomes,
      permissionMode: answers.permissionMode,
      registryPath:
        answers.launchMode === "launcher" ? answers.registryPath : null,
      requireRegistry: answers.requireRegistry,
    }),
  );

  return {
    launchMode: answers.launchMode,
    permissionMode: answers.permissionMode,
    repos,
    repoHomes,
    artifacts,
    warnings,
    updates: artifacts.filter((artifact) => artifact.mode === "update"),
  };
}

export interface InitIo {
  question(prompt: string): Promise<string>;
  write(text: string): void;
  writeError(text: string): void;
}

export type InitArtifactWriter = (
  path: string,
  contents: string,
) => Promise<void>;

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

async function promptRepos(
  io: InitIo,
  environment: InitEnvironment,
): Promise<InitRepoInput[]> {
  const repos: InitRepoInput[] = [];
  for (;;) {
    const answer = (await io.question(WIZARD_COPY.repoPathPrompt)).trim();
    if (!answer) {
      if (repos.length > 0) return repos;
      io.writeError("Add at least one repository.\n");
      continue;
    }
    const path = expandHome(answer, environment.homeDir);
    if (!isAbsolute(path)) {
      io.writeError(`"${answer}" is not an absolute path.\n`);
      continue;
    }
    if (!environment.isDirectory(path)) {
      io.writeError(`${path} is not a directory on this machine.\n`);
      continue;
    }
    const suggestion = basename(path);
    const nameAnswer = (
      await io.question(WIZARD_COPY.repoNamePrompt(suggestion))
    ).trim();
    repos.push({ name: nameAnswer || suggestion, path });
  }
}

async function confirm(io: InitIo, prompt: string): Promise<boolean> {
  const answer = (await io.question(prompt)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function promptChoice(
  io: InitIo,
  prompt: string,
  choices: readonly string[],
  fallback: string,
): Promise<string> {
  for (;;) {
    const answer = (await io.question(prompt)).trim();
    if (!answer) return fallback;
    if (choices.includes(answer)) return answer;
    io.writeError(`Enter one of: ${choices.join(", ")}.\n`);
  }
}

export async function runInitCommand(
  argv: readonly string[],
  io: InitIo,
  environment: InitEnvironment,
  writeArtifact: InitArtifactWriter,
): Promise<number> {
  const parsed = parseInitArgs(argv);
  if (!parsed.ok) {
    io.writeError(`${parsed.error}\n`);
    return 2;
  }
  const options = parsed.options;
  if (options.help) {
    io.write(INIT_HELP_TEXT);
    return 0;
  }

  const detection = detectRepoGolem(environment);
  let answers: InitAnswers;

  if (options.yes) {
    if (options.repos.length === 0) {
      io.writeError(
        "Nothing to write: --yes needs at least one --repo <name>=<path>.\n",
      );
      return 2;
    }
    try {
      answers = resolveInitAnswers(options, environment);
    } catch (error) {
      io.writeError(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  } else {
    try {
      answers = await runInteractive(options, environment, io, detection);
    } catch (error) {
      io.writeError(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 2;
    }
  }

  let plan: InitPlan;
  try {
    plan = buildInitPlan(answers, environment);
  } catch (error) {
    io.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  io.write(`${WIZARD_COPY.writeSection.join("\n")}\n`);
  for (const warning of plan.warnings) {
    io.write(`  note: ${warning}\n`);
  }

  if (options.print) {
    for (const artifact of plan.artifacts) {
      if (artifact.kind === "backup") continue;
      io.write(
        `\n--- ${artifact.path} (${artifact.mode}${
          artifact.backupPath ? `, backup: ${artifact.backupPath}` : ""
        }) ---\n${artifact.contents}`,
      );
    }
    return 0;
  }

  // Rewriting a file the machine already has is never implicit: it takes an
  // explicit yes (interactively) or --force (scripted), and the current
  // contents are copied to a backup BEFORE the rewrite.
  if (plan.updates.length > 0) {
    for (const update of plan.updates) {
      io.write(
        `  ${update.path} already exists; this run would rewrite it ` +
          `(backup: ${update.backupPath}).\n`,
      );
    }
    let confirmed = options.force;
    if (!confirmed && !options.yes) {
      try {
        confirmed = await confirm(io, WIZARD_COPY.overwritePrompt);
      } catch (error) {
        io.writeError(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 2;
      }
    }
    if (!confirmed) {
      io.writeError(
        `Nothing written. ${
          options.yes
            ? "Re-run with --force to rewrite"
            : "Answer yes, or re-run with --force, to rewrite"
        } ${plan.updates
          .map((artifact) => artifact.path)
          .join(", ")}; --print shows what would be written.\n`,
      );
      return 1;
    }
  }

  for (const artifact of plan.artifacts) {
    await writeArtifact(artifact.path, artifact.contents);
    io.write(
      artifact.kind === "backup"
        ? `  backed up to ${artifact.path}\n`
        : `  wrote ${artifact.path}\n`,
    );
  }

  io.write(`${WIZARD_COPY.doneHint.join("\n")}\n`);
  const configArtifact = plan.artifacts.find(
    (artifact) => artifact.kind === "env",
  );
  if (configArtifact) {
    io.write(
      `\n  [ -f ${configArtifact.path} ] && . ${configArtifact.path}\n\n`,
    );
  }
  return 0;
}

async function runInteractive(
  options: InitOptions,
  environment: InitEnvironment,
  io: InitIo,
  detection: RepoGolemDetection,
): Promise<InitAnswers> {
  io.write(`${WIZARD_COPY.intro.join("\n")}\n`);
  io.write(`${WIZARD_COPY.repoSection.join("\n")}\n`);
  const repos =
    options.repos.length > 0
      ? options.repos
      : await promptRepos(io, environment);

  io.write(`${WIZARD_COPY.modeSection.join("\n")}\n`);
  if (!detection.available) {
    io.write(`${WIZARD_COPY.modeLauncherUnavailable}\n`);
  }
  const defaultModeChoice = detection.available ? "1" : "2";
  const modeChoice = detection.available
    ? await promptChoice(
        io,
        WIZARD_COPY.modePrompt(defaultModeChoice),
        ["1", "2"],
        defaultModeChoice,
      )
    : await promptChoice(
        io,
        WIZARD_COPY.modePrompt(defaultModeChoice),
        ["2"],
        defaultModeChoice,
      );

  io.write(`${WIZARD_COPY.permissionSection.join("\n")}\n`);
  const permissionChoice = await promptChoice(
    io,
    WIZARD_COPY.permissionPrompt("1"),
    ["1", "2"],
    "1",
  );

  return resolveInitAnswers(
    {
      ...options,
      repos,
      mode: modeChoice === "1" ? "launcher" : "raw",
      permissionMode:
        permissionChoice === "1" ? "skip-permissions" : "default",
    },
    environment,
  );
}
