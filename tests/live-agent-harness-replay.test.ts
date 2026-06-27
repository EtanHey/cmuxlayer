import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CliType, AgentRecord } from "../src/agent-types.js";
import { evaluateAgentHealth } from "../src/agent-health.js";
import {
  classifyWorkerFailures,
  expectedManagedAgentPrefix,
  parseToolPayload,
  summarizeTopology,
} from "../src/live-agent-harness.js";
import { MODEL_POLICY_CONTRACT } from "../src/model-policy.js";

type ClassifierInput = Parameters<typeof classifyWorkerFailures>[0];
type ToolResultShape = Record<string, unknown>;

const repoRoot = join(__dirname, "..");
const repo = "skill-creator";
const workspace = "workspace:1";
const launcherSuffix: Record<CliType, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  kiro: "Kiro",
};

function managedAgentId(cli: CliType): string {
  return `${expectedManagedAgentPrefix(repo, cli)}abc123`;
}

function launcherName(cli: CliType): string {
  return `${repo.replaceAll("-", "")}${launcherSuffix[cli]}`;
}

function workerTitlePattern(cli: CliType): RegExp {
  return new RegExp(`${cli} agent`, "i");
}

function defaultSpawnStructured(cli: CliType): Record<string, unknown> {
  return {
    ok: true,
    model: MODEL_POLICY_CONTRACT.cli[cli].defaultModel,
    requested_model: "",
    boot_prompt_submit_verified: true,
  };
}

function baseTopology(cli: CliType = "cursor") {
  return {
    workspaceRef: workspace,
    selectedWorkspaceRef: workspace,
    focusedWorkspaceRef: workspace,
    columnCount: 2,
    workerSurfaceRef: "surface:worker",
    workerColumn: 1,
    workerSurfacesInWorkspace: ["surface:worker"],
    surfaces: [
      {
        ref: "surface:worker",
        title: `${cli} Agent`,
        workspace_ref: workspace,
        column: 1,
      },
    ],
    workspaces: [{ ref: workspace, selected: true, focused: true }],
  };
}

function baseClassifierInput(
  cli: CliType = "cursor",
  overrides: Partial<ClassifierInput> = {},
): ClassifierInput {
  const agentId = managedAgentId(cli);
  return {
    repo,
    cli,
    workspace,
    marker: `DONE_${cli.toUpperCase()}_DUMMY_01`,
    spawn: {
      ok: true,
      structured: defaultSpawnStructured(cli),
    },
    wait: { ok: true, structured: { state: "done" } },
    reportText: `Status: COMPLETE\nDONE_${cli.toUpperCase()}_DUMMY_01\n`,
    reportMissing: false,
    duplicateAgentId: false,
    agentId,
    topology: baseTopology(cli),
    stateAfterSpawnText: `agent_id: ${agentId}\nresume: ${launcherName(cli)} --resume session-1`,
    stateAfterClose: {
      ok: false,
      error: `Agent not found: ${agentId}`,
    },
    agentsAfterClose: { ok: true, structured: { agents: [] } },
    surfacesAfterClose: {
      ok: true,
      structured: {
        surfaces: [],
        workspaces: [{ ref: workspace, selected: true, focused: true }],
      },
    },
    baselineWorkerSurfaceCount: 0,
    workerTitlePattern: workerTitlePattern(cli),
    ...overrides,
  };
}

function toolPayload(
  name: string,
  structuredContent: Record<string, unknown>,
  text = `${name} ok`,
): ToolResultShape {
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: structuredContent.ok === false,
  };
}

function surfaceStructured(cli: CliType, surfaceRef = "surface:worker") {
  return {
    ok: true,
    workspace_ref: workspace,
    column_count: 2,
    workspaces: [{ ref: workspace, selected: true, focused: true }],
    surfaces: [
      {
        ref: surfaceRef,
        title: `${cli} Agent`,
        workspace_ref: workspace,
        column: 1,
      },
    ],
  };
}

function greenMcpReplay(cli: CliType = "cursor") {
  const agentId = managedAgentId(cli);
  const surfaceId = "surface:worker";
  const marker = `DONE_${cli.toUpperCase()}_DUMMY_01`;
  return {
    cli,
    marker,
    reportText: `Status: COMPLETE\n${marker}\n`,
    tools: {
      spawn_agent: toolPayload("spawn_agent", {
        ...defaultSpawnStructured(cli),
        agent_id: agentId,
        surface_id: surfaceId,
      }),
      get_agent_state_after_spawn: toolPayload(
        "get_agent_state",
        { ok: true, agent_id: agentId, state: "ready" },
        `agent_id: ${agentId}\nstate: ready\nresume: ${launcherName(cli)} --resume session-1`,
      ),
      list_surfaces_after_spawn: toolPayload(
        "list_surfaces",
        surfaceStructured(cli, surfaceId),
      ),
      wait_for: toolPayload("wait_for", {
        ok: true,
        agent_id: agentId,
        state: "done",
      }),
      close_surface: toolPayload("close_surface", {
        ok: true,
        surface: surfaceId,
        closed: true,
      }),
      get_agent_state_after_close: toolPayload(
        "get_agent_state",
        { ok: false, error: `Agent not found: ${agentId}` },
        `Agent not found: ${agentId}`,
      ),
      list_agents_after_close: toolPayload("list_agents", {
        ok: true,
        agents: [],
      }),
      list_surfaces_after_close: toolPayload("list_surfaces", {
        ok: true,
        workspace_ref: workspace,
        column_count: 2,
        workspaces: [{ ref: workspace, selected: true, focused: true }],
        surfaces: [],
      }),
    },
  };
}

function classifyReplayFixture(fixture: ReturnType<typeof greenMcpReplay>) {
  const spawn = parseToolPayload(fixture.tools.spawn_agent);
  const stateAfterSpawn = parseToolPayload(
    fixture.tools.get_agent_state_after_spawn,
  );
  const surfacesAfterSpawn = parseToolPayload(
    fixture.tools.list_surfaces_after_spawn,
  );
  const wait = parseToolPayload(fixture.tools.wait_for);
  const close = parseToolPayload(fixture.tools.close_surface);
  const stateAfterClose = parseToolPayload(
    fixture.tools.get_agent_state_after_close,
  );
  const agentsAfterClose = parseToolPayload(
    fixture.tools.list_agents_after_close,
  );
  const surfacesAfterClose = parseToolPayload(
    fixture.tools.list_surfaces_after_close,
  );
  const agentId =
    typeof spawn.structured?.agent_id === "string"
      ? spawn.structured.agent_id
      : undefined;
  const surfaceId =
    typeof spawn.structured?.surface_id === "string"
      ? spawn.structured.surface_id
      : null;
  const pattern = workerTitlePattern(fixture.cli);
  const topology = summarizeTopology(
    surfacesAfterSpawn.structured,
    workspace,
    surfaceId,
    pattern,
  );

  return {
    parsed: { spawn, wait, close },
    failures: classifyWorkerFailures({
      repo,
      cli: fixture.cli,
      workspace,
      marker: fixture.marker,
      spawn,
      wait,
      reportText: fixture.reportText,
      reportMissing: fixture.reportText == null,
      duplicateAgentId: false,
      agentId,
      topology,
      stateAfterSpawnText: stateAfterSpawn.text,
      stateAfterClose,
      agentsAfterClose,
      surfacesAfterClose,
      baselineWorkerSurfaceCount: 0,
      workerTitlePattern: pattern,
    }),
  };
}

function makeAgentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agent_id: managedAgentId("codex"),
    surface_id: "surface:worker",
    workspace_id: workspace,
    state: "working",
    repo,
    model: "gpt-5",
    cli: "codex",
    cli_session_id: "019f0001-1111-7222-8333-444455556666",
    cli_session_path: null,
    launcher_name: "skill-creatorCodex",
    task_summary: "Harness worker",
    pid: null,
    version: 1,
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: true,
    respawn_attempts: 0,
    user_killed: false,
    boot_prompt_pending: false,
    launch_cwd: null,
    mcp_profile: "sterile",
    worktree_path: null,
    worktree_branch: null,
    ...overrides,
  };
}

describe("classifyWorkerFailures regression matrix", () => {
  it.each([
    {
      name: "spawn_agent returns ok false",
      input: baseClassifierInput("cursor", {
        spawn: { ok: false, error: "Boot prompt delivery failed" },
      }),
      expected: ["spawn_ok_false", "spawn_error:Boot prompt delivery failed"],
    },
    {
      name: "spawn_agent omits structured payload",
      input: baseClassifierInput("cursor", {
        spawn: { ok: true },
      }),
      expected: [
        "spawn_missing_structured_payload",
        "boot_prompt_not_submitted",
      ],
    },
    {
      name: "Cursor boot prompt is typed but not submitted",
      input: baseClassifierInput("cursor", {
        spawn: {
          ok: true,
          structured: {
            ...defaultSpawnStructured("cursor"),
            boot_prompt_submit_verified: false,
            boot_prompt_delivered: false,
          },
        },
      }),
      expected: ["boot_prompt_not_submitted"],
    },
    {
      name: "Cursor spawn passes an explicit requested model",
      input: baseClassifierInput("cursor", {
        spawn: {
          ok: true,
          structured: {
            ...defaultSpawnStructured("cursor"),
            requested_model: "gpt-5",
          },
        },
      }),
      expected: ["spawn_requested_model_should_be_omitted"],
    },
    {
      name: "Cursor spawn resolves a non-default model",
      input: baseClassifierInput("cursor", {
        spawn: {
          ok: true,
          structured: { ...defaultSpawnStructured("cursor"), model: "sonnet" },
        },
      }),
      expected: ["spawn_model_not_default:sonnet"],
    },
    {
      name: "managed id is missing",
      input: baseClassifierInput("cursor", { agentId: undefined }),
      expected: ["managed_agent_id_invalid"],
    },
    {
      name: "managed id is auto-discovered",
      input: baseClassifierInput("cursor", {
        agentId: "auto-codex-surface-1",
      }),
      expected: ["managed_agent_id_invalid", "managed_agent_id_is_auto"],
    },
    {
      name: "managed id is duplicated in the run",
      input: baseClassifierInput("cursor", { duplicateAgentId: true }),
      expected: ["duplicate_managed_agent_id"],
    },
    {
      name: "Cursor launcher uses the historical hyphenated binary name",
      input: baseClassifierInput("cursor", {
        stateAfterSpawnText:
          "resume: skill-creatorCursor -s --resume session-1",
      }),
      expected: ["launcher_uses_hyphenated_skill-creatorCursor"],
    },
    {
      name: "launcher passes a visible model flag",
      input: baseClassifierInput("cursor", {
        stateAfterSpawnText:
          "resume: skillcreatorCursor --model gpt-5 --resume session-1",
      }),
      expected: ["launcher_passes_visible_model_flag"],
    },
    {
      name: "target workspace is not selected after spawn",
      input: baseClassifierInput("cursor", {
        topology: {
          ...baseTopology("cursor"),
          selectedWorkspaceRef: "workspace:other",
        },
      }),
      expected: ["workspace_not_selected"],
    },
    {
      name: "worker is not in the right column",
      input: baseClassifierInput("cursor", {
        topology: { ...baseTopology("cursor"), workerColumn: 0 },
      }),
      expected: ["worker_not_in_right_column:0"],
    },
    {
      name: "workspace has more than two columns",
      input: baseClassifierInput("cursor", {
        topology: { ...baseTopology("cursor"), columnCount: 3 },
      }),
      expected: ["unexpected_column_count:3"],
    },
    {
      name: "spawn leaves an extra worker surface",
      input: baseClassifierInput("cursor", {
        topology: {
          ...baseTopology("cursor"),
          workerSurfacesInWorkspace: ["surface:worker", "surface:extra"],
        },
      }),
      expected: ["unexpected_extra_worker_surfaces_after_spawn"],
    },
    {
      name: "cleanup leaves an extra worker surface",
      input: baseClassifierInput("cursor", {
        surfacesAfterClose: {
          ok: true,
          structured: {
            workspace_ref: workspace,
            workspaces: [{ ref: workspace, selected: true }],
            surfaces: [
              {
                ref: "surface:extra",
                title: "Cursor Agent",
                workspace_ref: workspace,
                column: 1,
              },
            ],
          },
        },
      }),
      expected: ["unexpected_extra_worker_surfaces_after_close"],
    },
    {
      name: "wait_for returns ok false",
      input: baseClassifierInput("cursor", { wait: { ok: false } }),
      expected: ["wait_for_not_ok"],
    },
    {
      name: "wait_for is ok but has no state",
      input: baseClassifierInput("cursor", {
        wait: { ok: true, structured: {} },
      }),
      expected: ["wait_for_state_missing"],
    },
    {
      name: "wait_for is ok but not done",
      input: baseClassifierInput("cursor", {
        wait: { ok: true, structured: { state: "working" } },
      }),
      expected: ["wait_for_state_working"],
    },
    {
      name: "report file is missing",
      input: baseClassifierInput("cursor", {
        reportText: undefined,
        reportMissing: true,
      }),
      expected: ["report_missing"],
    },
    {
      name: "report final marker mismatches the goal marker",
      input: baseClassifierInput("cursor", {
        reportText: "Status: COMPLETE\nDONE_OTHER_MARKER\n",
      }),
      expected: ["report_marker_mismatch"],
    },
    {
      name: "cleanup leaves a directly resolvable managed record",
      input: baseClassifierInput("cursor", {
        stateAfterClose: {
          ok: true,
          structured: { agent_id: managedAgentId("cursor") },
        },
      }),
      expected: ["stale_managed_record_after_close"],
    },
  ])("$name", ({ input, expected }) => {
    const failures = classifyWorkerFailures(input);

    expect(failures).toEqual(expect.arrayContaining(expected));
  });
});

describe("MCP-shaped no-live harness replay", () => {
  it("replays a representative green Cursor run through live-runner helpers", () => {
    const result = classifyReplayFixture(greenMcpReplay("cursor"));

    expect(result.parsed.spawn.ok).toBe(true);
    expect(result.parsed.wait.structured?.state).toBe("done");
    expect(result.parsed.close.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("replays the historical boot_prompt_not_submitted red shape", () => {
    const fixture = greenMcpReplay("cursor");
    fixture.tools.spawn_agent = toolPayload("spawn_agent", {
      ...defaultSpawnStructured("cursor"),
      agent_id: managedAgentId("cursor"),
      surface_id: "surface:worker",
      boot_prompt_submit_verified: false,
      boot_prompt_delivered: false,
    });

    expect(classifyReplayFixture(fixture).failures).toContain(
      "boot_prompt_not_submitted",
    );
  });

  it("replays the historical stale_managed_record_after_close red shape", () => {
    const fixture = greenMcpReplay("cursor");
    fixture.tools.get_agent_state_after_close = toolPayload(
      "get_agent_state",
      { ok: true, agent_id: managedAgentId("cursor"), state: "ready" },
      `agent_id: ${managedAgentId("cursor")}\nstate: ready`,
    );
    fixture.tools.list_agents_after_close = toolPayload("list_agents", {
      ok: true,
      agents: [{ agent_id: managedAgentId("cursor"), state: "ready" }],
    });

    expect(classifyReplayFixture(fixture).failures).toContain(
      "stale_managed_record_after_close",
    );
  });

  it("keeps Codex missing cli_session_id and non_resumable in agent-health scope", () => {
    const classifierResult = classifyReplayFixture(greenMcpReplay("codex"));
    const health = evaluateAgentHealth(
      makeAgentRecord({ cli_session_id: null, cli_session_path: null }),
      { monitor_alive: true },
    );

    expect(classifierResult.failures).toEqual([]);
    expect(health.issue_codes).toEqual([
      "missing_cli_session_id",
      "non_resumable",
    ]);
  });

  it("keeps registry screen disagreement in agent-health scope", () => {
    const classifierResult = classifyReplayFixture(greenMcpReplay("codex"));
    const health = evaluateAgentHealth(
      makeAgentRecord({ state: "working" }),
      { monitor_alive: true, screen_status: "done" },
    );

    expect(classifierResult.failures).toEqual([]);
    expect(health.issue_codes).toContain("registry_screen_disagreement");
  });
});

describe("live harness classifier boundary documentation", () => {
  it("documents health codes that are intentionally outside classifyWorkerFailures", () => {
    const docs = readFileSync(
      join(repoRoot, "docs", "live-agent-harness.md"),
      "utf8",
    );

    expect(docs).toContain("Classifier vs agent-health boundary");
    for (const code of [
      "missing_cli_session_id",
      "non_resumable",
      "registry_screen_disagreement",
      "parser_drift_after_done_evidence",
      "inbox_turn_nudge_required",
    ]) {
      expect(docs).toContain(`\`${code}\``);
    }
  });
});
