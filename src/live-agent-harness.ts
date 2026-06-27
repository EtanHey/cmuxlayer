import type { CliType } from "./agent-types.js";
import { MODEL_POLICY_CONTRACT } from "./model-policy.js";

export interface HarnessWorkerSpec {
  name: string;
  index: number;
  goal: string;
  report: string;
  marker: string;
}

export interface HarnessRunConfig {
  cli: CliType;
  repo: string;
  workspace: string;
  count: number;
  root: string;
  markerPrefix: string;
  workerNamePrefix: string;
  finalGreen: string;
  finalRed: string;
  mcpProfile: "inherit" | "sterile" | "skill_eval";
  waitTimeoutMs: number;
  cleanupTimeoutMs: number;
  cleanupPollMs: number;
  workerTitlePattern: RegExp;
}

export interface TopologySnapshot {
  workspaceRef: string;
  selectedWorkspaceRef: string | null;
  focusedWorkspaceRef: string | null;
  columnCount: number | null;
  workerSurfaceRef: string | null;
  workerColumn: number | null;
  workerSurfacesInWorkspace: string[];
  surfaces: Array<Record<string, unknown>>;
  workspaces: Array<Record<string, unknown>>;
  text?: string;
}

export interface ToolCallRecord {
  text?: string;
  ok?: boolean;
  error?: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export interface WorkerRunRecord {
  name: string;
  goal: string;
  report: string;
  marker: string;
  started_at: string;
  finished_at?: string;
  spawn?: ToolCallRecord;
  agent_id?: string;
  surface_id?: string;
  duplicate_agent_id?: boolean;
  state_after_spawn?: ToolCallRecord;
  surfaces_after_spawn?: ToolCallRecord;
  topology?: TopologySnapshot;
  wait?: ToolCallRecord;
  report_text?: string;
  report_final_line?: string;
  report_missing?: boolean;
  state_after_done?: ToolCallRecord;
  close?: ToolCallRecord;
  state_after_close?: ToolCallRecord;
  agents_after_close?: ToolCallRecord;
  surfaces_after_close?: ToolCallRecord;
  cleanup_attempts?: number;
  stale_state?: boolean;
  failures?: string[];
  green?: boolean;
}

export interface HarnessRunResults {
  started_at: string;
  finished_at?: string;
  config: HarnessRunConfig;
  stderr?: string;
  baseline_agents?: ToolCallRecord;
  baseline_surfaces?: ToolCallRecord;
  workers: WorkerRunRecord[];
  events: Array<Record<string, unknown>>;
  green?: boolean;
  final_marker?: string;
}

const CLI_LAUNCHER_SUFFIX: Record<CliType, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  kiro: "Kiro",
};

export function formatWorkerIndex(index: number): string {
  return String(index).padStart(2, "0");
}

export function formatWorkerName(prefix: string, index: number): string {
  return `${prefix}-${formatWorkerIndex(index)}`;
}

export function formatWorkerMarker(prefix: string, index: number): string {
  return `${prefix}_${formatWorkerIndex(index)}`;
}

export function buildWorkerGoalContent(
  workerName: string,
  reportPath: string,
  marker: string,
): string {
  return `# ${workerName} Goal

You are \`${workerName}\` in a read-only cmux live harness test.

Run exactly:

\`\`\`bash
pwd
command -v cmuxlayer
\`\`\`

Write a report to:

\`${reportPath}\`

The report must include:

- \`pwd\` output
- \`command -v cmuxlayer\` output
- \`Status: COMPLETE\`

The final report line must be exactly:

\`${marker}\`
`;
}

export function buildWorkerSpecs(
  config: HarnessRunConfig,
): HarnessWorkerSpec[] {
  const specs: HarnessWorkerSpec[] = [];
  for (let index = 1; index <= config.count; index += 1) {
    const name = formatWorkerName(config.workerNamePrefix, index);
    specs.push({
      name,
      index,
      goal: `${config.root}/goals/${name}.md`,
      report: `${config.root}/reports/${name}.md`,
      marker: formatWorkerMarker(config.markerPrefix, index),
    });
  }
  return specs;
}

export function isAutoAgentId(agentId: string | undefined): boolean {
  return typeof agentId === "string" && agentId.startsWith("auto-");
}

export function expectedManagedAgentPrefix(repo: string, cli: CliType): string {
  return `${repo}${CLI_LAUNCHER_SUFFIX[cli]}-`;
}

export function isManagedAgentId(
  agentId: string | undefined,
  repo: string,
  cli: CliType,
): boolean {
  if (!agentId || isAutoAgentId(agentId)) return false;
  return agentId.startsWith(expectedManagedAgentPrefix(repo, cli));
}

export function extractReportFinalLine(reportText: string): string {
  const lines = reportText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "";
}

export function reportMarkerMatches(
  reportText: string | undefined,
  expectedMarker: string,
): boolean {
  if (!reportText) return false;
  return extractReportFinalLine(reportText) === expectedMarker;
}

export function parseToolPayload(
  result: Record<string, unknown> | null | undefined,
): ToolCallRecord {
  if (!result) {
    return { ok: false, error: "missing tool result" };
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find(
    (block): block is { type: string; text?: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "text",
  );
  const text = typeof textBlock?.text === "string" ? textBlock.text : undefined;
  const structured =
    typeof result.structuredContent === "object" &&
    result.structuredContent !== null
      ? (result.structuredContent as Record<string, unknown>)
      : undefined;
  const ok =
    structured && typeof structured.ok === "boolean"
      ? structured.ok
      : result.isError
        ? false
        : undefined;
  const error =
    structured && typeof structured.error === "string"
      ? structured.error
      : undefined;
  return {
    text,
    ok,
    error,
    structured,
    isError: Boolean(result.isError),
  };
}

export function summarizeTopology(
  structured: Record<string, unknown> | undefined,
  workspaceRef: string,
  workerSurfaceRef: string | null,
  workerTitlePattern: RegExp,
): TopologySnapshot {
  const workspaces = Array.isArray(structured?.workspaces)
    ? (structured.workspaces as Array<Record<string, unknown>>)
    : [];
  const surfaces = Array.isArray(structured?.surfaces)
    ? (structured.surfaces as Array<Record<string, unknown>>)
    : [];
  const selectedWorkspaceRef =
    workspaces.find((workspace) => workspace.selected === true)?.ref ??
    (typeof structured?.workspace_ref === "string"
      ? structured.workspace_ref
      : null);
  const focusedWorkspaceRef =
    workspaces.find((workspace) => workspace.focused === true)?.ref ?? null;
  const columnCount =
    typeof structured?.column_count === "number"
      ? structured.column_count
      : null;
  const workerSurface = workerSurfaceRef
    ? surfaces.find((surface) => surface.ref === workerSurfaceRef)
    : undefined;
  const workerColumn =
    workerSurface && typeof workerSurface.column === "number"
      ? workerSurface.column
      : null;
  const workerSurfacesInWorkspace = surfaces
    .filter((surface) => {
      if (surface.workspace_ref !== workspaceRef) return false;
      const title = typeof surface.title === "string" ? surface.title : "";
      return workerTitlePattern.test(title);
    })
    .map((surface) => String(surface.ref ?? ""));

  return {
    workspaceRef,
    selectedWorkspaceRef:
      typeof selectedWorkspaceRef === "string" ? selectedWorkspaceRef : null,
    focusedWorkspaceRef:
      typeof focusedWorkspaceRef === "string" ? focusedWorkspaceRef : null,
    columnCount,
    workerSurfaceRef,
    workerColumn,
    workerSurfacesInWorkspace,
    surfaces,
    workspaces,
  };
}

export function validateLauncherPolicy(
  stateText: string | undefined,
): string[] {
  const failures: string[] = [];
  if (!stateText) return failures;
  const resumeMatch = stateText.match(/resume:\s*(.+)/);
  if (resumeMatch && /skill-creatorCursor\b/.test(resumeMatch[1])) {
    failures.push("launcher_uses_hyphenated_skill-creatorCursor");
  }
  if (/\s-m\s/.test(stateText) || /\s--model\s/.test(stateText)) {
    failures.push("launcher_passes_visible_model_flag");
  }
  return failures;
}

export function validateSpawnModelPolicy(
  structured: Record<string, unknown> | undefined,
  cli: CliType,
): string[] {
  const failures: string[] = [];
  if (!structured) return ["spawn_missing_structured_payload"];
  const model = typeof structured.model === "string" ? structured.model : "";
  const requestedModel =
    typeof structured.requested_model === "string"
      ? structured.requested_model
      : "";
  const expectedDefault = MODEL_POLICY_CONTRACT.cli[cli].defaultModel;
  if (requestedModel.trim().length > 0) {
    failures.push("spawn_requested_model_should_be_omitted");
  }
  if (model !== expectedDefault) {
    failures.push(`spawn_model_not_default:${model || "missing"}`);
  }
  return failures;
}

export function isBootPromptSubmitted(
  structured: Record<string, unknown> | undefined,
): boolean {
  if (!structured) return false;
  if (structured.boot_prompt_submit_verified === true) return true;
  return structured.boot_prompt_delivered === true;
}

export function isStaleManagedRecord(
  stateAfterClose: ToolCallRecord | undefined,
  agentsAfterClose: ToolCallRecord | undefined,
  agentId: string | undefined,
): boolean {
  if (!agentId) return false;
  if (stateAfterClose?.ok === true) return true;
  const agents = agentsAfterClose?.structured?.agents;
  if (!Array.isArray(agents)) return false;
  return agents.some((agent) => {
    if (typeof agent !== "object" || agent === null) return false;
    const id =
      typeof (agent as { agent_id?: unknown }).agent_id === "string"
        ? (agent as { agent_id: string }).agent_id
        : typeof (agent as { id?: unknown }).id === "string"
          ? (agent as { id: string }).id
          : "";
    return id === agentId;
  });
}

export function countUnexpectedWorkerSurfaces(
  topology: TopologySnapshot | undefined,
  baselineWorkerSurfaceCount: number,
  phase: "after_spawn" | "after_close",
): number {
  if (!topology) return phase === "after_close" ? 1 : 0;
  const observed = topology.workerSurfacesInWorkspace.length;
  const expected =
    phase === "after_spawn"
      ? baselineWorkerSurfaceCount + 1
      : baselineWorkerSurfaceCount;
  return Math.max(0, observed - expected);
}

export function classifyWorkerFailures(input: {
  repo: string;
  cli: CliType;
  workspace: string;
  marker: string;
  spawn?: ToolCallRecord;
  wait?: ToolCallRecord;
  reportText?: string;
  reportMissing?: boolean;
  duplicateAgentId?: boolean;
  agentId?: string;
  topology?: TopologySnapshot;
  stateAfterSpawnText?: string;
  stateAfterClose?: ToolCallRecord;
  agentsAfterClose?: ToolCallRecord;
  surfacesAfterClose?: ToolCallRecord;
  baselineWorkerSurfaceCount: number;
  workerTitlePattern: RegExp;
}): string[] {
  const failures: string[] = [];

  if (!input.spawn || input.spawn.ok !== true) {
    failures.push("spawn_ok_false");
    if (input.spawn?.error) {
      failures.push(`spawn_error:${input.spawn.error}`);
    }
  } else {
    failures.push(
      ...validateSpawnModelPolicy(input.spawn.structured, input.cli),
    );
    if (!isBootPromptSubmitted(input.spawn.structured)) {
      failures.push("boot_prompt_not_submitted");
    }
  }

  if (!isManagedAgentId(input.agentId, input.repo, input.cli)) {
    failures.push("managed_agent_id_invalid");
  }
  if (isAutoAgentId(input.agentId)) {
    failures.push("managed_agent_id_is_auto");
  }
  if (input.duplicateAgentId) {
    failures.push("duplicate_managed_agent_id");
  }

  failures.push(...validateLauncherPolicy(input.stateAfterSpawnText));

  if (input.topology) {
    if (input.topology.selectedWorkspaceRef !== input.workspace) {
      failures.push("workspace_not_selected");
    }
    if (input.topology.workerColumn !== 1) {
      failures.push(
        `worker_not_in_right_column:${input.topology.workerColumn ?? "missing"}`,
      );
    }
    if (
      typeof input.topology.columnCount === "number" &&
      input.topology.columnCount > 2
    ) {
      failures.push(`unexpected_column_count:${input.topology.columnCount}`);
    }
    if (
      countUnexpectedWorkerSurfaces(
        input.topology,
        input.baselineWorkerSurfaceCount,
        "after_spawn",
      ) > 0
    ) {
      failures.push("unexpected_extra_worker_surfaces_after_spawn");
    }
  }

  if (input.surfacesAfterClose?.structured) {
    const afterCloseTopology = summarizeTopology(
      input.surfacesAfterClose.structured,
      input.workspace,
      null,
      input.workerTitlePattern,
    );
    if (
      countUnexpectedWorkerSurfaces(
        afterCloseTopology,
        input.baselineWorkerSurfaceCount,
        "after_close",
      ) > 0
    ) {
      failures.push("unexpected_extra_worker_surfaces_after_close");
    }
  }

  if (!input.wait || input.wait.ok !== true) {
    failures.push("wait_for_not_ok");
  } else {
    const waitState =
      typeof input.wait.structured?.state === "string"
        ? input.wait.structured.state
        : "";
    if (waitState !== "done") {
      failures.push(`wait_for_state_${waitState || "missing"}`);
    }
  }

  if (input.reportMissing || !input.reportText) {
    failures.push("report_missing");
  } else if (!reportMarkerMatches(input.reportText, input.marker)) {
    failures.push("report_marker_mismatch");
  }

  if (
    isStaleManagedRecord(
      input.stateAfterClose,
      input.agentsAfterClose,
      input.agentId,
    )
  ) {
    failures.push("stale_managed_record_after_close");
  }

  return failures;
}

export function workerIsGreen(failures: string[]): boolean {
  return failures.length === 0;
}

export function summarizeHarnessRun(workers: WorkerRunRecord[]): {
  green: boolean;
  finalMarker: string;
  workerFailures: Record<string, string[]>;
} {
  const workerFailures: Record<string, string[]> = {};
  let green = true;
  for (const worker of workers) {
    const failures = worker.failures ?? [];
    workerFailures[worker.name] = failures;
    if (!workerIsGreen(failures)) {
      green = false;
    }
  }
  return { green, workerFailures, finalMarker: "" };
}

export function buildRunReportMarkdown(
  results: HarnessRunResults,
  workerFailures: Record<string, string[]>,
): string {
  const lines: string[] = [
    `# Live Agent Harness Run Report`,
    "",
    `Started: ${results.started_at}`,
    `Finished: ${results.finished_at ?? "in progress"}`,
    "",
    "## Config",
    "",
    `- CLI: \`${results.config.cli}\``,
    `- Repo: \`${results.config.repo}\``,
    `- Workspace: \`${results.config.workspace}\``,
    `- Workers: ${results.config.count}`,
    `- Root: \`${results.config.root}\``,
    `- MCP profile: \`${results.config.mcpProfile}\``,
    `- Cleanup timeout: ${results.config.cleanupTimeoutMs}ms`,
    "",
    "## Worker Summary",
    "",
    "| Worker | Agent ID | Spawn | Wait | Report | Failures |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const worker of results.workers) {
    const failures = workerFailures[worker.name] ?? worker.failures ?? [];
    lines.push(
      `| ${worker.name} | \`${worker.agent_id ?? "—"}\` | ${worker.spawn?.ok === true ? "ok" : "fail"} | ${worker.wait?.structured && worker.wait.structured.state === "done" ? "done" : "fail"} | ${worker.report_missing ? "missing" : (worker.report_final_line ?? "—")} | ${failures.length === 0 ? "—" : failures.join(", ")} |`,
    );
  }

  lines.push(
    "",
    "## Artifacts",
    "",
    `- JSON: \`${results.config.root}/mcp-run-results.json\``,
    "",
  );

  const allFailures = results.workers.flatMap(
    (worker) => worker.failures ?? [],
  );
  const finalMarker =
    allFailures.length === 0
      ? results.config.finalGreen
      : results.config.finalRed;

  lines.push("## Verdict", "");
  if (allFailures.length === 0) {
    lines.push("All workers passed the live harness checks.", "");
  } else {
    lines.push("One or more workers failed live harness checks.", "");
    lines.push("Primary failures:", "");
    for (const worker of results.workers) {
      const failures = worker.failures ?? [];
      if (failures.length === 0) continue;
      lines.push(`- ${worker.name}: ${failures.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(finalMarker);
  return `${lines.join("\n")}\n`;
}
