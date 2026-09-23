const FRESH_SPAWN_INFO_CODES = new Set([
  "missing_cli_session_id",
  "non_resumable",
  "inbox_monitor_not_alive",
  "registry_screen_disagreement",
]);

const ESSENTIAL_FIELDS = [
  "spawn_state",
  "next_action",
  "retry_count",
  "agent_id",
  "surface_id",
  "workspace_id",
  "delivered_chars",
  "state",
  "model",
  "requested_model",
  "role",
  "authority",
  "placement",
  "parent_agent_id",
  "collab_path",
  "version",
  "type",
  "runtime_initialization",
  "resumed",
  "cwd",
  "boot_prompt_delivered",
  "boot_prompt_receipt",
  "boot_prompt_submit_verified",
  "update_menu_skipped",
  "update_menu_text_hash",
  "readiness_recovered",
  "readiness_cleared",
  // P11/U10: the engine-issued coordination contract is ESSENTIAL, not verbose
  // detail -- a lead that cannot see it falls back to inventing its own path,
  // which is the S3 disagreement this lane exists to make impossible.
  "report_path",
  "done_marker",
  "coordination_footer_bytes",
  // P11b: the file the boot pointer points at. A lead that cannot see it cannot
  // check whether the worker was actually told -- the whole point of the trade.
  "contract_path",
  // Provenance travels WITH the byte count or the count is a false claim.
  "coordination_footer_delivered",
  "coordination_footer_note",
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

function bootUnsubmittedNextAction(surface: unknown, receipt: unknown): string {
  const surfaceRef = typeof surface === "string" ? surface : "<surface_id>";
  const evidence = record(receipt);
  const retryCount = typeof evidence?.retry_count === "number"
    ? evidence.retry_count : 0;
  const status = evidence?.submit_dispatched === false
    ? evidence.typed === true
      ? "Boot prompt was typed, but Return was not dispatched."
      : "Boot prompt was not submitted; Return was not dispatched."
    : retryCount > 0
      ? `Boot prompt submission was not verified after ${retryCount} automatic Return ${retryCount === 1 ? "retry" : "retries"}.`
      : evidence?.submit_dispatched === true
        ? "Return was dispatched, but boot prompt submission was not verified."
        : "Boot prompt submission was not verified.";
  return `${status} Read the pane with read_screen({surface:"${surfaceRef}"}); if the exact boot prompt still occupies the composer, the spawning caller may submit its owned draft with send_to({mode:"key",surface:"${surfaceRef}",text:"return"}). Otherwise stop and report boot_unsubmitted with this agent ID to the lead using the contract collab path. Keep the existing brief intact; never re-spawn.`;
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
    .filter(
      ({ code, severity }) =>
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

/** Retain actionable spawn identity and evidence while omitting routine detail. */
export function shapeSpawnResponse(
  full: JsonObject,
  verbose = false,
): JsonObject {
  if (verbose) return full;

  const hasBootPromptReceipt = record(full.boot_prompt_receipt) !== null;
  const lean: JsonObject = {
    ...(full.ok !== undefined ? { ok: full.ok } : {}),
    ...Object.fromEntries(ESSENTIAL_FIELDS.filter(
      (field) =>
        full[field] !== undefined &&
        !(
          field.startsWith("boot_prompt_") &&
          full[field] === null &&
          !(field === "boot_prompt_submit_verified" && hasBootPromptReceipt)
        ),
    ).map((field) => [field, full[field]])),
  };

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
  const state = data.spawn_state;
  const stateFields = state
    ? { spawn_state: state,
        ...(state === "boot_unsubmitted"
          ? { next_action: bootUnsubmittedNextAction(data.surface_id, data.boot_prompt_receipt) }
          : {}) }
    : {};
  const full = { ok: true, ...stateFields, ...data };
  const payload = verbose
    ? full
    : leanData
      ? { ok: true, ...stateFields, ...leanData }
      : shapeSpawnResponse(full);
  return {
    content: [
      {
        type: "text",
        text: verbose && legacyText
          ? state
            ? `${JSON.stringify(payload)}\n${legacyText}`
            : legacyText
          : JSON.stringify(payload),
      },
    ],
    structuredContent: payload,
  };
}
