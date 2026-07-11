import { describe, expect, it } from "vitest";
import {
  buildSpawnToolReturn,
  shapeSpawnResponse,
} from "../src/spawn-response.js";

const base = {
  agent_id: "agent-1",
  surface_id: "surface:1",
  workspace_id: "workspace:1",
  state: "booting",
  model: "codex",
  role: "worker",
  cwd: "/tmp/cmuxlayer",
  boot_prompt_delivered: false,
  boot_prompt_submit_verified: null,
};

describe("spawn response shaping", () => {
  it("omits healthy fresh-spawn health, non-coerced policy, and empty warnings", () => {
    const shaped = shapeSpawnResponse({
      ...base,
      warnings: [],
      health: {
        status: "healthy",
        issue_codes: [
          "missing_cli_session_id",
          "non_resumable",
          "inbox_monitor_not_alive",
          "registry_screen_disagreement",
        ],
        issues: ["missing session", "cannot resume", "monitor booting", "screen ahead"],
        issue_severities: {
          missing_cli_session_id: "info",
          non_resumable: "info",
          inbox_monitor_not_alive: "info",
          registry_screen_disagreement: "info",
        },
      },
      model_policy: { coerced: false, effective_model: "codex" },
    });

    expect(shaped).toEqual({ ...base });
  });

  it("keeps only real health issues when a spawn is degraded", () => {
    const shaped = shapeSpawnResponse({
      ...base,
      health: {
        status: "degraded",
        issue_codes: ["missing_cli_session_id", "missing_managed_lead_agent_id"],
        issues: ["missing session", "lead is missing"],
        issue_severities: {
          missing_cli_session_id: "info",
          missing_managed_lead_agent_id: "degraded",
        },
        recommended_actions: ["spawn_lead"],
      },
    });

    expect(shaped.health).toEqual({
      status: "degraded",
      issue_codes: ["missing_managed_lead_agent_id"],
      issues: ["lead is missing"],
      issue_severities: { missing_managed_lead_agent_id: "degraded" },
      recommended_actions: ["spawn_lead"],
    });
  });

  it("preserves issue-message alignment when an invalid code precedes a real issue", () => {
    const shaped = shapeSpawnResponse({
      ...base,
      health: {
        status: "degraded",
        issue_codes: [null, "missing_managed_lead_agent_id"],
        issues: ["invalid entry", "lead is missing"],
        issue_severities: {
          missing_managed_lead_agent_id: "degraded",
        },
      },
    });

    expect(shaped.health).toMatchObject({
      issue_codes: ["missing_managed_lead_agent_id"],
      issues: ["lead is missing"],
    });
  });

  it("includes a coerced model policy and non-empty warnings", () => {
    const policy = { coerced: true, effective_model: "codex" };
    const shaped = shapeSpawnResponse({
      ...base,
      warnings: ["model coerced"],
      model_policy: policy,
    });

    expect(shaped.warnings).toEqual(["model coerced"]);
    expect(shaped.model_policy).toBe(policy);
  });

  it("keeps only essential worktree fields in lean mode", () => {
    const shaped = shapeSpawnResponse({
      ...base,
      worktree: {
        path: "/tmp/cmuxlayer",
        name: "lean-response",
        branch: "feat/lean-response",
        created: false,
        reused: true,
        node_modules_linked: true,
        mcp_json_copied: true,
      },
    });

    expect(shaped.worktree).toEqual({
      path: "/tmp/cmuxlayer",
      name: "lean-response",
      branch: "feat/lean-response",
      created: false,
      reused: true,
    });
  });

  it("returns the full legacy object unchanged in verbose mode", () => {
    const full = {
      ...base,
      retry_count: 0,
      mcp_env: "MCP_PROFILE=inherit",
      model_policy: { coerced: false },
      warnings: [],
      monitor_boot: { alive: false },
    };

    expect(shapeSpawnResponse(full, true)).toBe(full);
  });

  it("uses the same lean payload for text and structured content", () => {
    const result = buildSpawnToolReturn({ ...base, retry_count: 0 });

    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(result.structuredContent).not.toHaveProperty("retry_count");
  });
});
