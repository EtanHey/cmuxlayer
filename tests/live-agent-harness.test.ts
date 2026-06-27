import { describe, expect, it } from "vitest";
import {
  buildWorkerGoalContent,
  buildWorkerSpecs,
  classifyWorkerFailures,
  extractReportFinalLine,
  formatWorkerMarker,
  formatWorkerName,
  isAutoAgentId,
  isBootPromptSubmitted,
  isManagedAgentId,
  isStaleManagedRecord,
  parseToolPayload,
  reportMarkerMatches,
  summarizeTopology,
  validateLauncherPolicy,
  validateSpawnModelPolicy,
  workerIsGreen,
} from "../src/live-agent-harness.js";

describe("live-agent-harness helpers", () => {
  it("formats worker names and markers deterministically", () => {
    expect(formatWorkerName("cursor", 1)).toBe("cursor-01");
    expect(formatWorkerMarker("DONE_CURSOR_DUMMY", 8)).toBe(
      "DONE_CURSOR_DUMMY_08",
    );
  });

  it("builds worker specs from config", () => {
    const specs = buildWorkerSpecs({
      cli: "cursor",
      repo: "skill-creator",
      workspace: "workspace:1",
      count: 2,
      root: "/tmp/run",
      markerPrefix: "DONE_CURSOR_DUMMY",
      workerNamePrefix: "cursor",
      finalGreen: "GREEN",
      finalRed: "RED",
      mcpProfile: "sterile",
      waitTimeoutMs: 1000,
      cleanupTimeoutMs: 10_000,
      cleanupPollMs: 500,
      workerTitlePattern: /cursor agent/i,
    });
    expect(specs).toHaveLength(2);
    expect(specs[0].goal).toBe("/tmp/run/goals/cursor-01.md");
    expect(specs[1].marker).toBe("DONE_CURSOR_DUMMY_02");
  });

  it("builds read-only worker goal content", () => {
    const content = buildWorkerGoalContent(
      "cursor-03",
      "/tmp/reports/cursor-03.md",
      "DONE_CURSOR_DUMMY_03",
    );
    expect(content).toContain("cursor-03");
    expect(content).toContain("command -v cmuxlayer");
    expect(content).toContain("DONE_CURSOR_DUMMY_03");
  });

  it("detects managed and auto agent ids", () => {
    expect(isAutoAgentId("auto-codex-surface-123")).toBe(true);
    expect(
      isManagedAgentId("skill-creatorCursor-abc123", "skill-creator", "cursor"),
    ).toBe(true);
    expect(
      isManagedAgentId("auto-codex-surface-123", "skill-creator", "cursor"),
    ).toBe(false);
  });

  it("parses MCP tool payloads from structured content", () => {
    const parsed = parseToolPayload({
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        ok: true,
        agent_id: "skill-creatorCursor-1",
        boot_prompt_delivered: true,
      },
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.structured?.agent_id).toBe("skill-creatorCursor-1");
  });

  it("validates report markers from final line", () => {
    const report = "Status: COMPLETE\n\nDONE_CURSOR_DUMMY_01\n";
    expect(extractReportFinalLine(report)).toBe("DONE_CURSOR_DUMMY_01");
    expect(reportMarkerMatches(report, "DONE_CURSOR_DUMMY_01")).toBe(true);
    expect(reportMarkerMatches(report, "DONE_CURSOR_DUMMY_02")).toBe(false);
  });

  it("accepts boot prompt submission evidence", () => {
    expect(isBootPromptSubmitted({ boot_prompt_submit_verified: true })).toBe(
      true,
    );
    expect(isBootPromptSubmitted({ boot_prompt_delivered: true })).toBe(true);
    expect(isBootPromptSubmitted({ boot_prompt_delivered: false })).toBe(false);
  });

  it("enforces cursor spawn model policy defaults", () => {
    expect(
      validateSpawnModelPolicy(
        { model: "auto", requested_model: "" },
        "cursor",
      ),
    ).toEqual([]);
    expect(
      validateSpawnModelPolicy(
        { model: "sonnet", requested_model: "" },
        "cursor",
      ),
    ).toContain("spawn_model_not_default:sonnet");
  });

  it("flags hyphenated cursor launcher resume commands", () => {
    expect(
      validateLauncherPolicy(
        "resume: skill-creatorCursor -s --resume abc\nagent_id: skill-creatorCursor-abc",
      ),
    ).toContain("launcher_uses_hyphenated_skill-creatorCursor");
    expect(
      validateLauncherPolicy(
        "resume: skillcreatorCursor -s --resume abc\nagent_id: skill-creatorCursor-abc",
      ),
    ).toEqual([]);
  });

  it("summarizes topology from verbose list_surfaces payload", () => {
    const topology = summarizeTopology(
      {
        workspace_ref: "workspace:1",
        column_count: 2,
        workspaces: [
          { ref: "workspace:1", selected: true },
          { ref: "workspace:2", selected: false },
        ],
        surfaces: [
          {
            ref: "surface:1",
            title: "skill-creator",
            workspace_ref: "workspace:1",
            column: 0,
          },
          {
            ref: "surface:2",
            title: "Cursor Agent",
            workspace_ref: "workspace:1",
            column: 1,
          },
        ],
      },
      "workspace:1",
      "surface:2",
      /cursor agent/i,
    );
    expect(topology.selectedWorkspaceRef).toBe("workspace:1");
    expect(topology.workerColumn).toBe(1);
    expect(topology.workerSurfacesInWorkspace).toEqual(["surface:2"]);
  });

  it("detects stale managed records after close", () => {
    expect(
      isStaleManagedRecord(
        { ok: true, structured: { agent_id: "skill-creatorCursor-1" } },
        undefined,
        "skill-creatorCursor-1",
      ),
    ).toBe(true);
    expect(
      isStaleManagedRecord(
        { ok: false, error: "Agent not found: skill-creatorCursor-1" },
        { structured: { agents: [] } },
        "skill-creatorCursor-1",
      ),
    ).toBe(false);
  });

  it("classifies worker failures for common red cases", () => {
    const failures = classifyWorkerFailures({
      repo: "skill-creator",
      cli: "cursor",
      workspace: "workspace:1",
      marker: "DONE_CURSOR_DUMMY_01",
      spawn: {
        ok: false,
        error: "Boot prompt delivery failed",
      },
      wait: { ok: false, structured: { state: "error" } },
      reportMissing: true,
      duplicateAgentId: false,
      agentId: "auto-codex-surface-1",
      baselineWorkerSurfaceCount: 0,
      workerTitlePattern: /cursor agent/i,
    });
    expect(failures).toContain("spawn_ok_false");
    expect(failures).toContain("managed_agent_id_invalid");
    expect(failures).toContain("report_missing");
    expect(workerIsGreen(failures)).toBe(false);
  });
});
