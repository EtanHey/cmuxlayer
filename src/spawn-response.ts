const FRESH_SPAWN_INFO_CODES = new Set([
  "missing_cli_session_id",
  "non_resumable",
  "inbox_monitor_not_alive",
  "registry_screen_disagreement",
]);

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

function bootUnsubmittedNextAction(
  surface: unknown,
  receipt: unknown,
  callerOwnsDraft: boolean,
): string {
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
  // #793: advise the key-Return only when the engine recorded this caller as
  // the draft's owner; otherwise the ownership guard refuses it.
  const recovery = callerOwnsDraft
    ? `if the exact boot prompt still occupies the composer, submit your owned draft with send_to({mode:"key",surface:"${surfaceRef}",text:"return"}) within 5 minutes (ownership lapses after that, or if the draft changes). Otherwise stop and`
    : "this caller does not own the draft, so do not send a key Return (the ownership guard refuses it); stop and";
  return `${status} Read the pane with read_screen({surface:"${surfaceRef}"}); ${recovery} report boot_unsubmitted with this agent ID to the lead using the contract collab path. Keep the existing brief intact; never re-spawn.`;
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

/** Five identity/outcome fields, plus one optional actionable warning. */
export function shapeSpawnResponse(
  full: JsonObject,
  verbose = false,
): JsonObject {
  if (verbose || full.ok !== true) return full;

  const health = leanHealth(full.health);
  const healthWarnings = Array.isArray(health?.issues) && health.issues.length > 0
    ? health.issues : (health?.issue_codes ?? []);
  const reportedWarnings = Array.isArray(full.warnings)
    ? full.warnings.filter((value): value is string =>
        typeof value === "string" && value.length > 0)
    : [];
  const warnings = [
    full.warning === reportedWarnings.join(" | ") ? undefined : full.warning,
    ...reportedWarnings,
    full.duplicate_spawn_warning,
    full.next_action,
    ...(Array.isArray(healthWarnings) ? healthWarnings : []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const warning = [...new Set(warnings)].join(" | ");
  return {
    ok: true,
    agent_id: full.agent_id ?? null,
    surface_id: full.surface_id,
    state: full.spawn_state ?? full.state ?? "started",
    delivered: full.delivered ?? (full.boot_prompt_delivered === true),
    ...(warning ? { warning } : {}),
  };
}

export function buildSpawnToolReturn(
  data: JsonObject,
  verbose = false,
  legacyText?: string,
  leanData?: JsonObject,
  opts: { callerOwnsBootDraft?: boolean } = {},
): SpawnToolReturn {
  const state = data.spawn_state;
  const stateFields = state
    ? { spawn_state: state,
        ...(state === "boot_unsubmitted"
          ? { next_action: bootUnsubmittedNextAction(
              data.surface_id, data.boot_prompt_receipt, opts.callerOwnsBootDraft === true) }
          : {}) }
    : {};
  const full = { ok: true, ...stateFields, ...data };
  const payload = verbose || full.ok !== true
    ? full
    : shapeSpawnResponse(leanData ? { ...full, ...leanData } : full);
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
