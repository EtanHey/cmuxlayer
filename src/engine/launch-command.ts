/**
 * Launch-command construction, model/effort pin checks and Codex model
 * validation, moved verbatim from agent-engine.ts (CX-2 E2). Imports nothing
 * from the engine, so the CLI (doctor) can use it without loading the engine.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSafeShellToken } from "../sanitize.js";
import {
  AGENT_ENV,
  buildRawResumeCommand,
  defaultKiroCd,
  rawSkipApprovalFlag,
  sanitizeRepoName,
  shellQuote,
} from "../agent-command.js";
import {
  bypassesApprovals,
  resolveSpawnPermissionMode,
  type SpawnPermissionMode,
} from "../permission-mode.js";
import { type AgentAuthority, type CliType } from "../agent-types.js";
import {
  CODEX_EFFORT_VALUES,
  MODEL_OVERRIDE_ENV,
  resolveLaunchModelFlag,
  type CodexEffort,
} from "../model-policy.js";
import {
  loadLauncherRegistrySnapshot,
  resolveLauncherNameFromRegistry,
  resolveLauncherNameFromRegistryOrNull,
  resolveRepoRootFromLauncherRegistry,
  type LauncherRegistryOptions,
  type LauncherSuffix,
} from "../launcher-registry.js";
import { resolveRepoRootWithoutRegistry, type RepoRootFallbackOptions } from "../repo-root-fallback.js";
import { SESSION_ID_RE, CONTEXTUAL_SESSION_ID_PATTERNS } from "./types.js";
import type {
  SpawnPreflightResult,
  CodexModelListRunner,
  AgentLaunchMode,
  ModelPinSource,
} from "./types.js";

const execFileAsync = promisify(execFile);

export async function defaultCodexModelListRunner(
  args: string[],
): Promise<{ stdout: string; stderr?: string }> {
  return execFileAsync("codex", args, {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

export function parseCodexModelSlugs(stdout: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Codex model discovery returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }. No agent was spawned.`,
    );
  }
  const models =
    payload && typeof payload === "object" && "models" in payload
      ? (payload as { models?: unknown }).models
      : null;
  const slugs = Array.isArray(models)
    ? models.flatMap((model) => {
        if (typeof model === "string") return [model];
        if (model && typeof model === "object" && "slug" in model) {
          const slug = (model as { slug?: unknown }).slug;
          return typeof slug === "string" ? [slug] : [];
        }
        return [];
      })
    : [];
  if (slugs.length === 0) {
    throw new Error(
      "Codex model discovery returned no models. No agent was spawned.",
    );
  }
  return slugs;
}

export async function validateCodexModel(
  model: string | undefined,
  runner: CodexModelListRunner,
): Promise<void> {
  if (!model?.trim() || model.trim().toLowerCase() === "codex") return;

  // AIDEV-NOTE: validate against the ACCOUNT catalog, not `--bundled`.
  //
  // `--bundled` is the list the installed codex binary shipped with. It is
  // wrong in BOTH directions against a real account, verified 2026-09-10:
  //   - it OMITS gpt-5.3-codex-spark, which the account lists with medium
  //     supported. That rejection made 100% of Etan's Spark quota unreachable
  //     while his general weekly sat at 3%.
  //   - it INCLUDES gpt-5.4, gpt-5.4-mini, gpt-5.2 and
  //     gpt-daybreak-red-latest, which the account does NOT list -- so those
  //     passed validation here and would only fail later, at runtime.
  //
  // A bundled omission is not proof of unavailability. So the account catalog
  // is authoritative, and bundled is a FALLBACK that may only warn: if the
  // account list cannot be fetched (offline, auth), we must not invent a
  // rejection from a list we already know disagrees with the account.
  const readCatalog = async (
    args: string[],
  ): Promise<string[] | { error: string }> => {
    try {
      const result = await runner(args);
      return parseCodexModelSlugs(result.stdout);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  const account = await readCatalog(["debug", "models"]);
  if (Array.isArray(account)) {
    if (!account.includes(model.trim())) {
      throw new Error(
        `Unsupported Codex model "${model.trim()}". Codex models: ${account.join(", ")}. No agent was spawned.`,
      );
    }
    return;
  }

  // Account catalog unavailable. Fall back to bundled, but only to catch an
  // obvious typo -- never to reject a model the bundled list simply predates.
  const bundled = await readCatalog(["debug", "models", "--bundled"]);
  if (!Array.isArray(bundled)) {
    throw new Error(
      `Unable to discover Codex models: ${account.error}. No agent was spawned.`,
    );
  }
  if (!bundled.includes(model.trim())) {
    console.warn(
      `[cmuxlayer] Codex account catalog unavailable (${account.error}); "${model.trim()}" is not in the BUNDLED list either. Proceeding anyway: a bundled omission is not proof the account lacks the model. Bundled: ${bundled.join(", ")}`,
    );
  }
}

/** Compare Claude's launcher ID and pane label using their shared model parts. */
export function parseClaudeModelIdentity(model: string): {
  family: string;
  major: string | null;
  minor: string | null;
  context: string | null;
} | null {
  const match = model.match(
    /^(?:claude[-\s]+)?(opus|sonnet|haiku)(?:[-\s]+(\d+)(?:[-.\s]+(\d+))?)?\s*(?:\[(\d+(?:\.\d+)?[km])\]|\((\d+(?:\.\d+)?[km])\s+context\))?$/i,
  );
  if (!match) return null;
  return {
    family: match[1].toLowerCase(),
    major: match[2] ?? null,
    minor: match[3] ?? null,
    context: (match[4] ?? match[5] ?? null)?.toLowerCase() ?? null,
  };
}

/**
 * Loosely compare the requested model with the model reported by the live CLI.
 * A missing side is unknown rather than a match. The pane can omit the context
 * tier, so only an explicit disagreement on both sides proves tier drift.
 */
export function computeModelMismatch(
  requestedModel: string,
  parsedModel: string | null,
): boolean | null {
  const requested = requestedModel.toLowerCase().trim();
  const parsed = parsedModel?.toLowerCase().trim();
  if (!requested || !parsed) return null;
  const requestedClaude = parseClaudeModelIdentity(requested);
  const parsedClaude = parseClaudeModelIdentity(parsed);
  if (requestedClaude && parsedClaude) {
    if (
      requestedClaude.family !== parsedClaude.family ||
      (requestedClaude.major !== null &&
        parsedClaude.major !== null &&
        requestedClaude.major !== parsedClaude.major) ||
      (requestedClaude.minor !== null &&
        parsedClaude.minor !== null &&
        requestedClaude.minor !== parsedClaude.minor)
    ) return true;
    if (requestedClaude.context !== null && parsedClaude.context !== null) {
      return requestedClaude.context !== parsedClaude.context;
    }
    return requestedClaude.context === parsedClaude.context ? false : null;
  }
  return !parsed.includes(requested) && !requested.includes(parsed);
}

export function parseCodexEffort(
  parsedModel: string | null,
): CodexEffort | null {
  const candidate = parsedModel?.trim().split(/\s+/).at(-1)?.toLowerCase();
  return candidate &&
    (CODEX_EFFORT_VALUES as readonly string[]).includes(candidate)
    ? (candidate as CodexEffort)
    : null;
}

export function computeEffortMismatch(
  requestedEffort: string | null | undefined,
  parsedEffort: string | null,
): boolean | null {
  const requested = requestedEffort?.trim().toLowerCase();
  if (!requested || !parsedEffort) return null;
  return requested !== parsedEffort;
}

/**
 * Build the shell command that launches a CLI agent.
 * Repo name is sanitized to prevent command injection.
 *
 * For claude/codex/cursor/gemini: uses repoGolem launchers (e.g.
 * `voicelayerClaude -s`, `golemsGemini -s`) which handle cd, model,
 * iTerm profile, MCP config (brainlayer etc.), and contexts.
 * No `cd` prefix needed — the launcher does it.
 *
 * For kiro: uses `cd ~/Gits/<repo> && kiro-cli` since it doesn't have
 * a launcher function yet.
 */
export function formatModelArg(modelFlag: string): string {
  return isSafeShellToken(modelFlag) ? modelFlag : shellQuote(modelFlag);
}

export function modelMatchesDefaultForLaunch(cli: CliType, model?: string): boolean {
  return cli === "codex" && model?.trim().toLowerCase() === "codex";
}

/**
 * Model tokens in this repo are LAUNCHER vocabulary: `claude-opus-5-5[1m]`,
 * `pro`, `codex`, `auto`. Raw binaries do not share it. This returns the token
 * that is safe to hand a raw CLI, or null when the pin cannot be expressed.
 *
 * - claude/codex/cursor: the resolved flag is already a real CLI model name
 *   (`sonnet`, `gpt-5.4`, ...) because resolveLaunchModelFlag only emits one
 *   when the caller asked for a specific model.
 * - gemini: `pro`/`flash`/`pro-high` are repoGolem aliases that raw gemini
 *   does not define, so only canonical `gemini-*` names are passed through.
 */
export function rawModelFlagToken(
  cli: CliType,
  modelFlag: string | null,
): string | null {
  if (!modelFlag) return null;
  if (cli === "gemini" && !/^gemini-/i.test(modelFlag.trim())) return null;
  return modelFlag;
}

/**
 * The exact model flag buildLaunchCommand will resolve for these inputs.
 * Exported so spawn can report the pin it actually applied without
 * re-deriving (and drifting from) the command builder's own logic.
 */
export function resolveLaunchModelFlagForCommand(
  cli: CliType,
  model: string | undefined,
  opts?: { allowModelOverride?: boolean },
): string | null {
  return resolveLaunchModelFlag(cli, model, {
    allowModelOverride:
      opts?.allowModelOverride ??
      (cli === "codex" &&
        Boolean(model?.trim()) &&
        !modelMatchesDefaultForLaunch(cli, model)),
  });
}

/** Truthful model provenance for a launch, plus the warning it owes the caller. */
export function describeModelPin(
  cli: CliType,
  launchMode: AgentLaunchMode,
  modelFlag: string | null,
  effectiveModel: string | undefined,
): { pin: ModelPinSource; warning: string | null } {
  if (launchMode === "launcher") return { pin: "launcher", warning: null };
  if (cli === "kiro") return { pin: "launcher", warning: null };
  if (rawModelFlagToken(cli, modelFlag)) {
    return { pin: "cli_flag", warning: null };
  }
  const claimed = effectiveModel?.trim();
  return {
    pin: "cli_default",
    warning:
      `MODEL PIN NOT APPLIED: this is a raw ${cli} launch (no repoGolem ` +
      `launcher for this repo), and ${cli} accepts no flag for ` +
      `"${claimed ?? "the policy default"}". The agent starts on whichever ` +
      `model ${cli} has configured, which may be a prior session's. ` +
      `model_pin="cli_default" -- the reported model is the policy default, ` +
      `not an applied pin. Register a repoGolem launcher to pin it.`,
  };
}

export function buildLaunchCommand(
  cli: CliType,
  repo: string,
  model?: string,
  // Resolved launcher function name from launchers.zsh. When provided
  // for a launcher CLI it overrides the naive `${repo}${Suffix}` guess so
  // registry-prefix registrations launch correctly. Honored for the launcher
  // CLIs (claude/codex/cursor/gemini); ignored for kiro (raw cd+exec).
  launcherName?: string,
  opts?: {
    cwd?: string;
    envPrefix?: string;
    allowModelOverride?: boolean;
    effort?: CodexEffort;
    launchMode?: AgentLaunchMode;
    /** Worker-authority Codex launches use repoGolem's light worker prompt. */
    authority?: AgentAuthority;
    /** Approval handling for this launch; defaults to the machine's setting. */
    permissionMode?: SpawnPermissionMode;
  },
): string {
  const safeRepo = sanitizeRepoName(repo);
  const modelFlag = resolveLaunchModelFlagForCommand(cli, model, {
    allowModelOverride: opts?.allowModelOverride,
  });
  const formattedModelFlag = modelFlag ? formatModelArg(modelFlag) : null;
  const launcherModelArgs = formattedModelFlag
    ? ` -m ${formattedModelFlag}`
    : "";
  const claudeModelArgs = modelFlag === "sonnet" ? " -S" : launcherModelArgs;
  const rawModelArgs = formattedModelFlag
    ? ` --model ${formattedModelFlag}`
    : "";
  const bypassApprovals = bypassesApprovals(
    opts?.permissionMode ?? resolveSpawnPermissionMode(),
  );
  const launcherSkipArg = bypassApprovals ? " -s" : "";
  const launcherWorkerArg = opts?.authority === "worker" ? " --worker" : "";
  const launcherWorktreeArg = opts?.cwd ? ` -w ${shellQuote(opts.cwd)}` : "";
  const launcherEffortArg = opts?.effort ? ` -E ${opts.effort}` : "";
  const rawCdPrefix = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ` : "";
  const codexModelOverride =
    cli === "codex" && modelFlag !== null && modelFlag !== "codex";
  const envParts = [
    codexModelOverride ? `${MODEL_OVERRIDE_ENV}=1` : null,
    opts?.envPrefix ?? null,
  ].filter((part): part is string => Boolean(part));
  const envPrefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";

  // AIDEV-NOTE (issue #392): registry-optional launch. With no repoGolem
  // launcher registered, spawn drops to the raw CLI and does the cd itself
  // (the launcher normally owns that). Registered installs are untouched --
  // "raw" is only ever requested explicitly by preflight.
  if (opts?.launchMode === "raw" && cli !== "kiro") {
    // REPOGOLEM_ALLOW_MODEL is a launcher-only escape hatch; it means nothing
    // to a raw binary, so raw mode carries only the harness + caller env.
    const rawEnvParts = [
      cli === "claude" || cli === "gemini" ? AGENT_ENV : null,
      opts?.envPrefix ?? null,
    ].filter((part): part is string => Boolean(part));
    const rawEnvPrefix =
      rawEnvParts.length > 0 ? `${rawEnvParts.join(" ")} ` : "";
    const skipFlag = rawSkipApprovalFlag(cli, opts?.permissionMode);
    const rawEffortArg =
      cli === "codex" && opts?.effort
        ? ` -c model_reasoning_effort=${opts.effort}`
        : "";
    // Only pass a model the raw binary actually understands; launcher-only
    // vocabulary is dropped here and disclosed by describeModelPin instead.
    const rawToken = rawModelFlagToken(cli, modelFlag);
    const formattedRawToken = rawToken ? formatModelArg(rawToken) : null;
    // `codex` takes `-m`; claude/cursor/gemini all accept `--model`.
    const rawModelFlag = formattedRawToken
      ? cli === "codex"
        ? ` -m ${formattedRawToken}`
        : ` --model ${formattedRawToken}`
      : "";
    const binary = cli === "cursor" ? "cursor agent" : cli;
    return `${rawCdPrefix}${rawEnvPrefix}${binary}${
      skipFlag ? ` ${skipFlag}` : ""
    }${rawModelFlag}${rawEffortArg}`;
  }

  switch (cli) {
    case "claude":
      // repoGolem launcher handles env vars via ralph-registry
      return `${envPrefix}${launcherName ?? `${safeRepo}Claude`}${launcherSkipArg}${claudeModelArgs}${launcherWorktreeArg}`;
    case "codex":
      return `${envPrefix}${launcherName ?? `${safeRepo}Codex`}${launcherSkipArg}${launcherWorkerArg}${launcherModelArgs}${launcherEffortArg}${launcherWorktreeArg}`;
    case "gemini":
      // repoGolem launcher (e.g. golemsGemini -s) wires antigravity + MCP.
      return `${envPrefix}${launcherName ?? `${safeRepo}Gemini`}${launcherSkipArg}${launcherModelArgs}${launcherWorktreeArg}`;
    case "kiro":
      return `${rawCdPrefix || defaultKiroCd(repo)}${envPrefix}${AGENT_ENV} kiro-cli${rawModelArgs}`;
    case "cursor":
      // repoGolem launcher - requires registration via golem-powers.
      return `${envPrefix}${launcherName ?? `${safeRepo}Cursor`}${launcherSkipArg}${launcherModelArgs}${launcherWorktreeArg}`;
  }
}

export function extractSessionId(text: string): string | null {
  for (const pattern of CONTEXTUAL_SESSION_ID_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const matches = [...text.matchAll(SESSION_ID_RE)].map((match) => match[0]);
  const uniqueMatches = [...new Set(matches)];
  return uniqueMatches.length === 1 ? uniqueMatches[0] : null;
}

/**
 * `buildRawResumeCommand` throws for harnesses with no UUID resume form
 * (gemini) and for malformed session ids. Callers that only want a human-facing
 * hint treat that as "no hint", never as a sweep-breaking error.
 */
export function rawResumeCommandOrNull(
  cli: CliType,
  repo: string,
  sessionId: string,
  opts?: { cwd?: string | null },
): string | null {
  try {
    return buildRawResumeCommand(cli, repo, sessionId, opts);
  } catch {
    return null;
  }
}

export function cliForLauncherSuffix(suffix: LauncherSuffix): CliType {
  return suffix === "Claude"
    ? "claude"
    : suffix === "Codex"
      ? "codex"
      : suffix === "Cursor"
        ? "cursor"
        : "gemini";
}

/**
 * Validate that a launcher is registered and return its resolved name. Probes
 * the launcher registry instead of executing shell profile code.
 *
 * Strict by design: this is the "registry is mandatory" contract. The default
 * spawn preflight no longer calls it unless
 * CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY is set — see resolveSpawnLaunchPlan.
 */
export async function assertLauncherAvailable(
  repo: string,
  suffix: LauncherSuffix,
): Promise<string> {
  return resolveLauncherNameFromRegistry(repo, cliForLauncherSuffix(suffix));
}

export const REQUIRE_LAUNCHER_REGISTRY_ENV =
  "CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY";

export function launcherRegistryRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[REQUIRE_LAUNCHER_REGISTRY_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Decide how a spawn should start its harness.
 *
 * AIDEV-NOTE (issue #392): the repoGolem launcher registry is an OPTIONAL
 * enhancement. When it names this repo we keep the launcher path verbatim —
 * existing installs see no change. When there is no registry, or no entry for
 * the repo, we fall back to the raw CLI with a cwd resolved from the repo
 * param. Set CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY=1 to restore the old hard
 * failure (useful when a typo'd repo name should be an error, not a raw
 * launch in a lookalike directory).
 */
export function resolveSpawnLaunchPlan(
  repo: string,
  cli: CliType,
  opts?: {
    registryOptions?: LauncherRegistryOptions;
    repoRootFallback?: RepoRootFallbackOptions;
    env?: Record<string, string | undefined>;
  },
): SpawnPreflightResult {
  const registryOptions = opts?.registryOptions;
  const launcherName = resolveLauncherNameFromRegistryOrNull(
    repo,
    cli,
    registryOptions,
  );
  if (launcherName) {
    return {
      launcherName,
      repoRoot: resolveRepoRootFromLauncherRegistry(repo, registryOptions),
      launchMode: "launcher",
    };
  }

  const snapshot = loadLauncherRegistrySnapshot(registryOptions);
  if (launcherRegistryRequired(opts?.env)) {
    // Strict mode: reproduce the self-answering registry error.
    resolveLauncherNameFromRegistry(repo, cli, registryOptions);
  }

  const registryHint = snapshot.available
    ? `Launcher registry ${snapshot.sourcePath} has no entry for "${repo}".`
    : `No launcher registry at ${snapshot.sourcePath} (${snapshot.unavailable_reason}).`;

  return {
    launchMode: "raw",
    launchModeReason: registryHint,
    repoRoot: resolveRepoRootWithoutRegistry(repo, {
      ...opts?.repoRootFallback,
      registryHint,
    }),
  };
}
