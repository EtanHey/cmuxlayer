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
  /** H1: which daemon served the run (#800). */
  daemon?: HarnessDaemonBlock & { stopped?: boolean };
  daemon_failures?: string[];
  preflight?: { tools: string[]; missing: string[] };
  /** A run-level failure (preflight, daemon identity) recorded, not thrown. */
  error?: string;
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
  // H1: stateAfterClose is a list_agents({agent_ids}) reply (the hidden
  // get_agent_state is gone); the record is stale while that list still names
  // it. Older artifacts carry a get_agent_state reply, where ok:true meant found.
  const directAgents = stateAfterClose?.structured?.agents;
  if (Array.isArray(directAgents)) {
    if (listNamesAgent(directAgents, agentId)) return true;
  } else if (stateAfterClose?.ok === true) {
    return true;
  }
  const agents = agentsAfterClose?.structured?.agents;
  if (!Array.isArray(agents)) return false;
  return listNamesAgent(agents, agentId);
}

const TERMINAL_AGENT_STATES = new Set(["done", "error"]);

/**
 * Names the agent as still LIVE. A stopped agent keeps a persisted done
 * (resumable) record by design, so a terminal state is not stale; a row with
 * no state (older artifacts) counts as live.
 */
function listNamesAgent(agents: unknown[], agentId: string): boolean {
  return agents.some((agent) => {
    if (typeof agent !== "object" || agent === null) return false;
    const id =
      typeof (agent as { agent_id?: unknown }).agent_id === "string"
        ? (agent as { agent_id: string }).agent_id
        : typeof (agent as { id?: unknown }).id === "string"
          ? (agent as { id: string }).id
          : "";
    const state = (agent as { state?: unknown }).state;
    return id === agentId && !(typeof state === "string" && TERMINAL_AGENT_STATES.has(state));
  });
}

/**
 * H1 (#808): the public tools the live runner calls. The runner checks
 * tools/list for these up front and exits non-zero naming any that are
 * missing, instead of failing mid-run on a removed tool.
 */
export const REQUIRED_HARNESS_TOOLS = [
  "spawn_agent",
  "list_agents",
  "list_surfaces",
  "wait_for",
  "close_surface",
  "control_health",
] as const;

export function missingHarnessTools(listed: readonly string[]): string[] {
  const have = new Set(listed);
  return REQUIRED_HARNESS_TOOLS.filter((name) => !have.has(name));
}

/**
 * H1 (#800): the entry proxies to whichever daemon owns the socket, so on a
 * fleet Mac the default socket is the INSTALLED daemon. The runner therefore
 * pins a private socket per run, which makes the proxy start a daemon from
 * this build's dist/.
 */
export function defaultHarnessDaemonSocket(home: string, pid: number): string {
  return `${home}/.local/state/cmux/cmuxlayer-harness-${pid}.sock`;
}

export interface HarnessDaemonBlock {
  socket_path: string;
  private: boolean;
  version: string | null;
  binary: string | null;
  pid: number | null;
  expected_dist: string;
  from_this_build: boolean;
}

/**
 * Which daemon actually served the run: control_health(detail:"full") runs
 * inside the serving daemon, so its current_process names that binary.
 */
export function buildHarnessDaemonBlock(input: {
  socketPath: string;
  privateSocket: boolean;
  serverVersion: string | null;
  controlHealth: Record<string, unknown> | undefined;
  distDir: string;
}): HarnessDaemonBlock {
  const health = input.controlHealth?.health as
    | { current_process?: { pid?: unknown; script_path?: unknown } }
    | undefined;
  const current = health?.current_process;
  const binary = typeof current?.script_path === "string" ? current.script_path : null;
  const pid = typeof current?.pid === "number" ? current.pid : null;
  const dist = input.distDir.replace(/\/+$/, "");
  return {
    socket_path: input.socketPath,
    private: input.privateSocket,
    version: input.serverVersion,
    binary,
    pid,
    expected_dist: dist,
    from_this_build: binary !== null && binary.startsWith(`${dist}/`),
  };
}

export function harnessDaemonFailures(block: HarnessDaemonBlock): string[] {
  return block.from_this_build ? [] : ["daemon_not_from_this_build"];
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
  } else if (!waitIsDone(input.wait)) {
    const waitState =
      typeof input.wait.structured?.state === "string"
        ? input.wait.structured.state
        : "";
    failures.push(`wait_for_state_${waitState || "missing"}`);
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
    // A worker the runner never classified (its loop was cut off) is a
    // failure, never an empty pass (H1 live finding).
    const failures = worker.failures ?? ["worker_not_classified"];
    workerFailures[worker.name] = failures;
    if (!workerIsGreen(failures)) {
      green = false;
    }
  }
  return { green, workerFailures, finalMarker: "" };
}

/**
 * The worker is done when wait_for matched: either the registry reached
 * `done`, or (#808) the file-backed report marker matched, which leaves the
 * registry state wherever it is (a sterile worker never learns the engine path).
 */
export function waitIsDone(wait: ToolCallRecord | undefined): boolean {
  if (!wait || wait.ok !== true) return false;
  const structured = wait.structured;
  if (structured?.matched === true && structured.source === "report_file") {
    return true;
  }
  return structured?.state === "done";
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
    "## Daemon",
    "",
    ...(results.daemon
      ? [
          `- Version: \`${results.daemon.version ?? "unknown"}\``,
          `- Binary: \`${results.daemon.binary ?? "unknown"}\` (pid ${results.daemon.pid ?? "unknown"}, this build: ${results.daemon.from_this_build ? "yes" : "NO"})`,
          `- Socket: \`${results.daemon.socket_path}\` (${results.daemon.private ? "private" : "installed/default"})`,
        ]
      : ["- not identified (run failed before control_health)"]),
    "",
    ...(results.error ? ["## Run error", "", results.error, ""] : []),
    "## Worker Summary",
    "",
    "| Worker | Agent ID | Spawn | Wait | Report | Failures |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const worker of results.workers) {
    const failures = workerFailures[worker.name] ?? worker.failures ?? [];
    lines.push(
      `| ${worker.name} | \`${worker.agent_id ?? "—"}\` | ${worker.spawn?.ok === true ? "ok" : "fail"} | ${waitIsDone(worker.wait) ? "done" : "fail"} | ${worker.report_missing ? "missing" : (worker.report_final_line ?? "—")} | ${failures.length === 0 ? "—" : failures.join(", ")} |`,
    );
  }

  lines.push(
    "",
    "## Artifacts",
    "",
    `- JSON: \`${results.config.root}/mcp-run-results.json\``,
    "",
  );

  const failuresOf = (worker: WorkerRunRecord): string[] =>
    worker.failures ?? ["worker_not_classified"];
  const allFailures = [
    ...results.workers.flatMap(failuresOf),
    ...(results.error ? ["run_error"] : []),
    ...(results.daemon_failures ?? []),
    ...(results.workers.length === 0 ? ["no_workers_ran"] : []),
  ];
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
      const failures = failuresOf(worker);
      if (failures.length === 0) continue;
      lines.push(`- ${worker.name}: ${failures.join(", ")}`);
    }
    lines.push("");
  }

  lines.push(finalMarker);
  return `${lines.join("\n")}\n`;
}
