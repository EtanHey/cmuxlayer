import type { CliType } from "./agent-types.js";

export const MODEL_OVERRIDE_ENV = "REPOGOLEM_ALLOW_MODEL";
// Match the installed repoGolem launcher sourced by fresh interactive shells
// (~/.config/ralphtools/golem-dispatch.zsh), not the potentially newer golems
// checkout. The drift gate fails when that live contract changes; validation
// must still reject mismatches before any worktree or surface is created.
export const CODEX_EFFORT_VALUES = [
  "medium",
  "high",
  "xhigh",
  "ultra",
] as const;
export type CodexEffort = (typeof CODEX_EFFORT_VALUES)[number];

export interface CliModelPolicyContract {
  defaultModel: string;
  allowModelOverrideByDefault: boolean;
  forbiddenModelPatterns: string[];
  modelAliases: Record<string, string>;
}

export interface SpawnModelPolicy {
  cli: CliType;
  requested_model: string;
  effective_model: string;
  launcher_model: string | null;
  coerced: boolean;
  warnings: string[];
  override_env: typeof MODEL_OVERRIDE_ENV;
  override_allowed: boolean;
}

export const MODEL_POLICY_CONTRACT: {
  version: 1;
  escapeEnv: typeof MODEL_OVERRIDE_ENV;
  cli: Record<CliType, CliModelPolicyContract>;
} = {
  version: 1,
  escapeEnv: MODEL_OVERRIDE_ENV,
  cli: {
    cursor: {
      defaultModel: "auto",
      allowModelOverrideByDefault: false,
      forbiddenModelPatterns: ["^claude-", "sonnet", "opus", "haiku"],
      modelAliases: {},
    },
    gemini: {
      // repoGolem owns Antigravity alias-to-canonical resolution. Keep cmux on
      // the short launcher token so canonical model renames cannot drift here.
      defaultModel: "pro",
      allowModelOverrideByDefault: true,
      forbiddenModelPatterns: [],
      modelAliases: {
        pro: "pro",
        "pro-high": "pro-high",
        "pro-low": "pro-low",
        flash: "flash",
        "flash-high": "flash-high",
        "flash-med": "flash-med",
        "flash-medium": "flash-medium",
        "flash-low": "flash-low",
        "gemini-2.5-pro": "gemini-2.5-pro",
        "gemini-2.5-flash": "gemini-2.5-flash",
        "gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
        "gemini-3.1-pro": "gemini-3.1-pro",
      },
    },
    codex: {
      defaultModel: "codex",
      allowModelOverrideByDefault: false,
      forbiddenModelPatterns: [],
      modelAliases: {
        "gpt-5": "gpt-5",
        "gpt-5-codex": "gpt-5-codex",
        "gpt-5.3": "gpt-5.3",
        "gpt-5.3-codex": "gpt-5.3-codex",
        "gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
        "gpt-5.4": "gpt-5.4",
        "gpt-5.4-mini": "gpt-5.4-mini",
        "gpt-5.5": "gpt-5.5",
        "gpt-5.5-mini": "gpt-5.5-mini",
      },
    },
    claude: {
      defaultModel: "claude-opus-5[1m]",
      allowModelOverrideByDefault: true,
      forbiddenModelPatterns: [],
      modelAliases: {
        opus: "opus",
        sonnet: "sonnet",
        haiku: "haiku",
      },
    },
    kiro: {
      defaultModel: "opus",
      allowModelOverrideByDefault: true,
      forbiddenModelPatterns: [],
      modelAliases: {
        opus: "opus",
        sonnet: "sonnet",
        haiku: "haiku",
      },
    },
  },
};

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

function modelMatchesDefault(cli: CliType, model: string): boolean {
  const contract = MODEL_POLICY_CONTRACT.cli[cli];
  const normalized = normalizeModelKey(model);
  const defaultModel = normalizeModelKey(contract.defaultModel);
  return (
    normalized === defaultModel ||
    normalizeModelKey(resolveModelAlias(cli, model)) === defaultModel
  );
}

function forbiddenModelFamily(cli: CliType, model: string): string {
  const contract = MODEL_POLICY_CONTRACT.cli[cli];
  for (const pattern of contract.forbiddenModelPatterns) {
    if (new RegExp(pattern, "i").test(model)) return "Claude model";
  }
  return "non-default model";
}

function ownModelAlias(cli: CliType, normalized: string): string | null {
  const aliases = MODEL_POLICY_CONTRACT.cli[cli].modelAliases;
  if (!Object.prototype.hasOwnProperty.call(aliases, normalized)) return null;

  const alias = aliases[normalized];
  return typeof alias === "string" && alias ? alias : null;
}

function modelAliasUsesUngatedLauncherPath(
  cli: CliType,
  alias: string,
): boolean {
  if (cli === "claude") return alias === "sonnet";
  return cli === "gemini" || cli === "kiro";
}

function acceptedModelNames(
  cli: CliType,
  allowModelOverride: boolean,
): string[] {
  const contract = MODEL_POLICY_CONTRACT.cli[cli];
  const aliases = Object.keys(contract.modelAliases).filter(
    (alias) =>
      allowModelOverride || modelAliasUsesUngatedLauncherPath(cli, alias),
  );
  return [...new Set([contract.defaultModel, ...aliases])];
}

export function resolveSpawnEffort(
  cli: CliType,
  effort?: string,
): CodexEffort | null {
  const requested = effort?.trim();
  if (!requested) return null;

  if (!(CODEX_EFFORT_VALUES as readonly string[]).includes(requested)) {
    throw new Error(
      `Invalid Codex effort "${requested}" (expected: ${CODEX_EFFORT_VALUES.join(", ")}). No agent was spawned.`,
    );
  }
  if (cli !== "codex") {
    throw new Error(
      `Codex effort "${requested}" cannot be used with cli "${cli}". Set cli to "codex" or omit effort. No agent was spawned.`,
    );
  }

  return requested as CodexEffort;
}

export function resolveModelAlias(cli: CliType, model: string): string {
  const trimmed = model.trim();
  const normalized = normalizeModelKey(trimmed);
  return ownModelAlias(cli, normalized) ?? trimmed;
}

export function resolveLaunchModelFlag(
  cli: CliType,
  model: string | undefined,
  opts?: { allowModelOverride?: boolean },
): string | null {
  const requested = model?.trim();
  if (!requested) return null;

  if (cli === "codex") {
    if (modelMatchesDefault(cli, requested)) return null;
    if (!opts?.allowModelOverride) return null;
  }

  if (cli === "cursor") {
    if (modelMatchesDefault(cli, requested)) return null;
    return opts?.allowModelOverride ? requested : null;
  }

  const alias = ownModelAlias(cli, normalizeModelKey(requested));
  if (cli === "claude" && alias !== "sonnet" && !opts?.allowModelOverride) {
    return null;
  }
  return alias ?? null;
}

export function resolveSpawnModelPolicy(
  cli: CliType,
  model?: string,
  env: Record<string, string | undefined> = process.env,
): SpawnModelPolicy {
  const contract = MODEL_POLICY_CONTRACT.cli[cli];
  const requestedModel = model?.trim() ?? "";
  const requestedWasOmitted = requestedModel.length === 0;
  const overrideAllowed = envFlagEnabled(env[MODEL_OVERRIDE_ENV]);
  const defaultModel = contract.defaultModel;
  const requestedOrDefault = requestedWasOmitted
    ? defaultModel
    : requestedModel;
  const resolvedRequested = resolveModelAlias(cli, requestedOrDefault);

  // Cursor deliberately accepts arbitrary model strings behind its escape
  // hatch. Every launcher-backed CLI, however, has a finite alias table. Do
  // not let the older Codex coercion branch turn an unknown alias into an
  // apparently successful default-model spawn.
  if (
    !requestedWasOmitted &&
    cli !== "cursor" &&
    !modelMatchesDefault(cli, requestedModel) &&
    ownModelAlias(cli, normalizeModelKey(requestedModel)) === null
  ) {
    const acceptedModels = acceptedModelNames(cli, overrideAllowed);
    throw new Error(
      `Unsupported model "${requestedModel}" for cli "${cli}": without a valid alias, the launcher would actually run "${defaultModel}". Accepted models: ${acceptedModels.join(", ")}. No agent was spawned.`,
    );
  }

  if (
    !requestedWasOmitted &&
    !contract.allowModelOverrideByDefault &&
    !overrideAllowed &&
    !modelMatchesDefault(cli, requestedModel)
  ) {
    const effectiveModel = resolveModelAlias(cli, defaultModel);
    const family = forbiddenModelFamily(cli, requestedModel);
    const warning =
      `WARNING: ${cli.toUpperCase()} MODEL POLICY: requested ${family} "${requestedModel}" ` +
      `was coerced to "${effectiveModel}". ${cli} agents must use ${effectiveModel} ` +
      `unless ${MODEL_OVERRIDE_ENV}=1 is set.`;

    return {
      cli,
      requested_model: requestedModel,
      effective_model: effectiveModel,
      launcher_model: null,
      coerced: true,
      warnings: [warning],
      override_env: MODEL_OVERRIDE_ENV,
      override_allowed: false,
    };
  }

  const launcherModel = requestedWasOmitted
    ? null
    : resolveLaunchModelFlag(cli, resolvedRequested, {
        allowModelOverride: overrideAllowed,
      });
  if (
    !requestedWasOmitted &&
    !modelMatchesDefault(cli, resolvedRequested) &&
    launcherModel === null
  ) {
    const acceptedModels = acceptedModelNames(cli, overrideAllowed);
    throw new Error(
      `Unsupported model "${requestedModel}" for cli "${cli}": without a valid alias, the launcher would actually run "${defaultModel}". Accepted models: ${acceptedModels.join(", ")}. No agent was spawned.`,
    );
  }

  return {
    cli,
    requested_model: requestedModel,
    effective_model: resolvedRequested,
    launcher_model: launcherModel,
    coerced: false,
    warnings: [],
    override_env: MODEL_OVERRIDE_ENV,
    override_allowed: overrideAllowed,
  };
}
