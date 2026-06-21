import type { CliType } from "./agent-types.js";

export const MODEL_OVERRIDE_ENV = "REPOGOLEM_ALLOW_MODEL";

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
      allowModelOverrideByDefault: true,
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
      defaultModel: "claude-opus-4-8[1m]",
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

  if (cli === "cursor") {
    if (modelMatchesDefault(cli, requested)) return null;
    return opts?.allowModelOverride ? requested : null;
  }

  const alias = ownModelAlias(cli, normalizeModelKey(requested));
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
  const requestedOrDefault = requestedWasOmitted ? defaultModel : requestedModel;
  const resolvedRequested = resolveModelAlias(cli, requestedOrDefault);

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

  return {
    cli,
    requested_model: requestedModel,
    effective_model: resolvedRequested,
    launcher_model:
      requestedWasOmitted || modelMatchesDefault(cli, resolvedRequested)
        ? null
        : resolvedRequested,
    coerced: false,
    warnings: [],
    override_env: MODEL_OVERRIDE_ENV,
    override_allowed: overrideAllowed,
  };
}
