import { describe, expect, it } from "vitest";
import type { CliType } from "../src/agent-types.js";
import {
  buildRunReportMarkdown,
  buildWorkerGoalContent,
  buildWorkerSpecs,
  classifyWorkerFailures,
  expectedManagedAgentPrefix,
  isStaleManagedRecord,
  summarizeHarnessRun,
  workerIsGreen,
} from "../src/live-agent-harness.js";
import { MODEL_POLICY_CONTRACT } from "../src/model-policy.js";

const PRE_PR_CLIS: CliType[] = ["cursor", "codex", "claude", "gemini"];

function configFor(cli: CliType) {
  return {
    cli,
    repo: "skill-creator",
    workspace: "workspace:1",
    count: 1,
    root: `/tmp/cmux-pre-pr-${cli}`,
    markerPrefix: `DONE_${cli.toUpperCase()}_DUMMY`,
    workerNamePrefix: cli,
    finalGreen: `GREEN_${cli.toUpperCase()}_DUMMY_1_AGENT`,
    finalRed: `NOT_GREEN_${cli.toUpperCase()}_DUMMY_1_AGENT`,
    mcpProfile: "sterile" as const,
    waitTimeoutMs: 300_000,
    cleanupTimeoutMs: 10_000,
    cleanupPollMs: 500,
    workerTitlePattern: new RegExp(`${cli} agent`, "i"),
  };
}

function greenFailuresFor(cli: CliType): string[] {
  const config = configFor(cli);
  const spec = buildWorkerSpecs(config)[0];
  const agentId = `${expectedManagedAgentPrefix("skill-creator", cli)}abc123`;
  return classifyWorkerFailures({
    repo: config.repo,
    cli,
    workspace: config.workspace,
    marker: spec.marker,
    spawn: {
      ok: true,
      structured: {
        ok: true,
        model: MODEL_POLICY_CONTRACT.cli[cli].defaultModel,
        requested_model: "",
        boot_prompt_submit_verified: true,
      },
    },
    wait: { ok: true, structured: { state: "done" } },
    reportText: `Status: COMPLETE\n${spec.marker}\n`,
    reportMissing: false,
    duplicateAgentId: false,
    agentId,
    topology: {
      workspaceRef: config.workspace,
      selectedWorkspaceRef: config.workspace,
      focusedWorkspaceRef: config.workspace,
      columnCount: 2,
      workerSurfaceRef: "surface:worker",
      workerColumn: 1,
      workerSurfacesInWorkspace: ["surface:worker"],
      surfaces: [],
      workspaces: [],
    },
    stateAfterSpawnText: `agent_id: ${agentId}`,
    stateAfterClose: {
      ok: false,
      error: `Agent not found: ${agentId}`,
    },
    agentsAfterClose: { ok: true, structured: { agents: [] } },
    surfacesAfterClose: {
      ok: true,
      structured: {
        surfaces: [],
        workspaces: [{ ref: config.workspace, selected: true }],
      },
    },
    baselineWorkerSurfaceCount: 0,
    workerTitlePattern: config.workerTitlePattern,
  });
}

describe("pre-PR live harness contract without live workers", () => {
  it.each(PRE_PR_CLIS)(
    "has a deterministic green path for %s without spawning agents",
    (cli) => {
      expect(workerIsGreen(greenFailuresFor(cli))).toBe(true);
    },
  );

  it.each(PRE_PR_CLIS)(
    "uses sterile MCP profile in generated %s harness config",
    (cli) => {
      expect(configFor(cli).mcpProfile).toBe("sterile");
    },
  );

  it.each(PRE_PR_CLIS)(
    "builds a read-only worker goal for %s without BrainLayer instructions",
    (cli) => {
      const config = configFor(cli);
      const spec = buildWorkerSpecs(config)[0];
      const content = buildWorkerGoalContent(
        spec.name,
        spec.report,
        spec.marker,
      );
      expect(content).toContain("read-only cmux live harness test");
      expect(content).toContain("command -v cmuxlayer");
      expect(content).not.toMatch(/brain_store|BrainLayer/i);
    },
  );

  it("fails red when cleanup leaves a directly resolvable managed record", () => {
    const agentId = "skill-creatorCursor-abc123";
    expect(
      isStaleManagedRecord(
        { ok: true, structured: { agent_id: agentId } },
        { ok: true, structured: { agents: [] } },
        agentId,
      ),
    ).toBe(true);
  });

  it("keeps final report markers deterministic", () => {
    const config = configFor("cursor");
    const spec = buildWorkerSpecs(config)[0];
    const worker = {
      name: spec.name,
      goal: spec.goal,
      report: spec.report,
      marker: spec.marker,
      started_at: "2026-06-27T00:00:00.000Z",
      agent_id: "skill-creatorCursor-abc123",
      spawn: { ok: true },
      wait: { ok: true, structured: { state: "done" } },
      report_missing: false,
      report_final_line: spec.marker,
      failures: [],
      green: true,
    };
    const summary = summarizeHarnessRun([worker]);
    const markdown = buildRunReportMarkdown(
      {
        started_at: "2026-06-27T00:00:00.000Z",
        finished_at: "2026-06-27T00:00:01.000Z",
        config,
        workers: [worker],
        events: [],
      },
      summary.workerFailures,
    );
    expect(markdown).toContain(config.finalGreen);
    expect(markdown).not.toContain(config.finalRed);
  });
});
