import type { CliType } from "./agent-types.js";

export const MODEL_OVERRIDE_ENV = "REPOGOLEM_ALLOW_MODEL";
export const CURSOR_DEFAULT_MODEL = "auto";

export interface SpawnModelPolicy {
  cli: CliType;
  requested_model: string;
  effective_model: string;
  coerced: boolean;
  warnings: string[];
  override_env: typeof MODEL_OVERRIDE_ENV;
  override_allowed: boolean;
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function isClaudeModelName(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith("claude-") ||
    normalized.includes("sonnet") ||
    normalized.includes("opus") ||
    normalized.includes("haiku")
  );
}

export function resolveSpawnModelPolicy(
  cli: CliType,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): SpawnModelPolicy {
  const requestedModel = model.trim();
  const overrideAllowed = envFlagEnabled(env[MODEL_OVERRIDE_ENV]);

  if (cli !== "cursor") {
    return {
      cli,
      requested_model: requestedModel,
      effective_model: requestedModel,
      coerced: false,
      warnings: [],
      override_env: MODEL_OVERRIDE_ENV,
      override_allowed: overrideAllowed,
    };
  }

  if (
    overrideAllowed &&
    requestedModel &&
    requestedModel.toLowerCase() !== CURSOR_DEFAULT_MODEL
  ) {
    return {
      cli,
      requested_model: requestedModel,
      effective_model: requestedModel,
      coerced: false,
      warnings: [],
      override_env: MODEL_OVERRIDE_ENV,
      override_allowed: true,
    };
  }

  const effectiveModel = CURSOR_DEFAULT_MODEL;
  const requestedIsDefault =
    !requestedModel || requestedModel.toLowerCase() === CURSOR_DEFAULT_MODEL;

  if (requestedIsDefault) {
    return {
      cli,
      requested_model: requestedModel,
      effective_model: effectiveModel,
      coerced: false,
      warnings: [],
      override_env: MODEL_OVERRIDE_ENV,
      override_allowed: overrideAllowed,
    };
  }

  const family = isClaudeModelName(requestedModel)
    ? "Claude model"
    : "non-default model";
  const warning =
    `WARNING: CURSOR MODEL POLICY: requested ${family} "${requestedModel}" ` +
    `was coerced to "${effectiveModel}". Cursor agents must use Cursor Auto ` +
    `unless ${MODEL_OVERRIDE_ENV}=1 is set.`;

  return {
    cli,
    requested_model: requestedModel,
    effective_model: effectiveModel,
    coerced: true,
    warnings: [warning],
    override_env: MODEL_OVERRIDE_ENV,
    override_allowed: false,
  };
}
