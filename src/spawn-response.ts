const FRESH_SPAWN_INFO_CODES = new Set([
  "missing_cli_session_id",
  "non_resumable",
  "inbox_monitor_not_alive",
  "registry_screen_disagreement",
]);

const ESSENTIAL_FIELDS = [
  "agent_id",
  "surface_id",
  "workspace_id",
  "state",
  "model",
  "requested_model",
  "role",
  "cwd",
  "boot_prompt_delivered",
  "boot_prompt_submit_verified",
] as const;

type JsonObject = Record<string, unknown>;

export interface SpawnToolReturn {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonObject;
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function leanHealth(value: unknown): JsonObject | undefined {
  const health = record(value);
  if (!health || health.status === "healthy") return undefined;

  const codeEntries = Array.isArray(health.issue_codes)
    ? health.issue_codes
        .map((code, index) => ({ code, index }))
        .filter(
          (entry): entry is { code: string; index: number } =>
            typeof entry.code === "string",
        )
    : [];
  const issues = Array.isArray(health.issues) ? health.issues : [];
  const severities = record(health.issue_severities) ?? {};
  const realIndexes = codeEntries
    .map(({ code, index }) => ({ code, index, severity: severities[code] }))
    .filter(({ code, severity }) =>
      !(FRESH_SPAWN_INFO_CODES.has(code) && severity === "info"),
    );

  if (
    !realIndexes.some(
      ({ severity }) => severity === "degraded" || severity === "blocking",
    )
  ) {
    return undefined;
  }

  const issueCodes = realIndexes.map(({ code }) => code);
  const issueSeverities = Object.fromEntries(
    realIndexes.map(({ code, severity }) => [code, severity]),
  );
  return {
    ...health,
    issue_codes: issueCodes,
    issues: realIndexes.map(({ index }) => issues[index]).filter(Boolean),
    issue_severities: issueSeverities,
  };
}

function leanWorktree(value: unknown): JsonObject | undefined {
  const worktree = record(value);
  if (!worktree) return undefined;
  return Object.fromEntries(
    ["path", "name", "branch", "created", "reused"]
      .filter((key) => worktree[key] !== undefined)
      .map((key) => [key, worktree[key]]),
  );
}

export function shapeSpawnResponse(
  full: JsonObject,
  verbose = false,
): JsonObject {
  if (verbose) return full;

  const lean: JsonObject = {};
  if (full.ok !== undefined) lean.ok = full.ok;
  for (const field of ESSENTIAL_FIELDS) {
    if (full[field] !== undefined) lean[field] = full[field];
  }

  const worktree = leanWorktree(full.worktree);
  if (worktree) lean.worktree = worktree;

  const warnings = Array.isArray(full.warnings) ? [...full.warnings] : [];
  if (
    typeof full.duplicate_spawn_warning === "string" &&
    full.duplicate_spawn_warning.length > 0
  ) {
    warnings.push(full.duplicate_spawn_warning);
  }
  if (warnings.length > 0) {
    lean.warnings = warnings;
  }

  const health = leanHealth(full.health);
  if (health) lean.health = health;

  const modelPolicy = record(full.model_policy);
  if (modelPolicy?.coerced === true) lean.model_policy = full.model_policy;

  return lean;
}

export function buildSpawnToolReturn(
  data: JsonObject,
  verbose = false,
  legacyText?: string,
  leanData?: JsonObject,
): SpawnToolReturn {
  const full = { ok: true, ...data };
  const payload = verbose
    ? full
    : leanData
      ? { ok: true, ...leanData }
      : shapeSpawnResponse(full);
  return {
    content: [
      {
        type: "text",
        text: verbose && legacyText ? legacyText : JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
  };
}
