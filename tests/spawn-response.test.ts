import { describe, expect, it } from "vitest";
import {
  buildSpawnToolReturn,
  shapeSpawnResponse,
} from "../src/spawn-response.js";

const base = {
  ok: true,
  spawn_state: "started",
  agent_id: "agent-1",
  surface_id: "surface:1",
  workspace_id: "workspace:1",
  state: "booting",
  model: "codex",
  role: "worker",
  cwd: "/tmp/cmuxlayer",
  boot_prompt_delivered: false,
};

describe("spawn response shaping", () => {
  it("keeps failures intact without verbose", () => {
    const failure = { ok: false, error: "launch failed", retry_count: 2,
      contract_path: "/tmp/contract.md", transport: { stderr: "synthetic" } };
    expect(shapeSpawnResponse(failure)).toBe(failure);
  });

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
        issues: [
          "missing session",
          "cannot resume",
          "monitor booting",
          "screen ahead",
        ],
        issue_severities: {
          missing_cli_session_id: "info",
          non_resumable: "info",
          inbox_monitor_not_alive: "info",
          registry_screen_disagreement: "info",
        },
      },
      model_policy: { coerced: false, effective_model: "codex" },
    });

    expect(shaped).toEqual({ ok: true, agent_id: "agent-1", surface_id: "surface:1", state: "started", delivered: false });
  });

  it("keeps only real health issues when a spawn is degraded", () => {
    const shaped = shapeSpawnResponse({
      ...base,
      health: {
        status: "degraded",
        issue_codes: [
          "missing_cli_session_id",
          "missing_managed_lead_agent_id",
        ],
        issues: ["missing session", "lead is missing"],
        issue_severities: {
          missing_cli_session_id: "info",
          missing_managed_lead_agent_id: "degraded",
        },
        recommended_actions: ["spawn_lead"],
      },
    });

    expect(shaped.warning).toBe("lead is missing");
    expect(Object.keys(shaped)).toHaveLength(6);
  });

  it("keeps a real health warning even when its message is missing", () => {
    const result = shapeSpawnResponse({ ...base, health: { status: "degraded",
      issue_codes: ["missing_managed_lead_agent_id"],
      issue_severities: { missing_managed_lead_agent_id: "degraded" } } });
    expect(result.warning).toBe("missing_managed_lead_agent_id");
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

    expect(shaped.warning).toBe("lead is missing");
  });

  it("combines actionable warnings in one field", () => {
    const policy = { coerced: true, effective_model: "codex" };
    const shaped = shapeSpawnResponse({
      ...base,
      warnings: ["model coerced"],
      model_policy: policy,
    });

    expect(shaped.warning).toBe("model coerced");
    expect(shaped).not.toHaveProperty("model_policy");
  });

  it("keeps worktree detail only in verbose mode", () => {
    const shaped = shapeSpawnResponse({
      ...base,
      worktree: {
        path: "/tmp/cmuxlayer",
        name: "lean-response",
        branch: "feat/lean-response",
        created: false,
        reused: true,
        node_modules_bootstrapped: "inline",
        mcp_json_copied: true,
      },
    });

    expect(shaped).not.toHaveProperty("worktree");
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

  it("keeps readiness recovery evidence in verbose mode", () => {
    const shaped = shapeSpawnResponse({
      ...base,
      readiness_recovered: true,
      readiness_cleared: ["wenfnng"],
    }, true);

    expect(shaped.readiness_recovered).toBe(true);
    expect(shaped.readiness_cleared).toEqual(["wenfnng"]);
  });

  it("distinguishes no boot prompt from an attempted but unverified prompt", () => {
    const noPrompt = shapeSpawnResponse({
      ...base,
      boot_prompt_receipt: null,
      boot_prompt_submit_verified: null,
    });
    const attempted = shapeSpawnResponse({
      ...base,
      boot_prompt_receipt: { submit_verified: null },
      boot_prompt_submit_verified: null,
    });

    expect(noPrompt.delivered).toBe(false);
    expect(noPrompt).not.toHaveProperty("boot_prompt_receipt");
    expect(noPrompt).not.toHaveProperty("boot_prompt_submit_verified");
    expect(attempted).toEqual(noPrompt); // Both lack proof of delivery.
    expect(shapeSpawnResponse({ ...base, boot_prompt_delivered: true }).delivered).toBe(true);
  });

  it("names false/null boot submission as partial in lean and verbose receipts", () => {
    for (const submit_verified of [false, null]) {
      for (const verbose of [false, true]) {
        const result = buildSpawnToolReturn({ ...base,
          spawn_state: "boot_unsubmitted",
          boot_prompt_receipt: { submit_verified } }, verbose, "legacy", undefined,
          { callerOwnsBootDraft: true });
        expect(result.structuredContent).toMatchObject(verbose
          ? { ok: true, spawn_state: "boot_unsubmitted", agent_id: "agent-1",
              surface_id: "surface:1", workspace_id: "workspace:1",
              boot_prompt_receipt: { submit_verified } }
          : { ok: true, state: "boot_unsubmitted", agent_id: "agent-1",
              surface_id: "surface:1", delivered: false });
        const action = result.structuredContent[verbose ? "next_action" : "warning"] as string;
        expect(action).toContain('read_screen({surface:"surface:1"})');
        expect(action).toContain('send_to({mode:"key"');
        expect(action).toMatch(/Boot prompt submission was not verified/i);
        expect(action).not.toMatch(/retr(?:y|ies).*exhausted/i);
        if (!verbose) {
          expect(Object.keys(result.structuredContent)).toHaveLength(6);
          expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
        }
      }
    }
  });

  it("#793 advises the key Return only when the spawning caller owns the draft", () => {
    const unsubmitted = { ...base, spawn_state: "boot_unsubmitted",
      boot_prompt_receipt: { typed: true, submit_dispatched: false, submit_verified: false } };
    const owned = buildSpawnToolReturn(unsubmitted, false, undefined, undefined,
      { callerOwnsBootDraft: true }).structuredContent.warning as string;
    expect(owned).toContain('send_to({mode:"key",surface:"surface:1",text:"return"})');
    expect(owned).toMatch(/within 5 minutes/);
    for (const opts of [undefined, { callerOwnsBootDraft: false }]) {
      const unowned = buildSpawnToolReturn(unsubmitted, false, undefined, undefined, opts)
        .structuredContent.warning as string;
      expect(unowned).not.toContain('mode:"key"');
      expect(unowned).toContain('read_screen({surface:"surface:1"})');
      expect(unowned).toMatch(/report boot_unsubmitted .* never re-spawn/);
    }
  });

  it("describes the observed 0.4.80 Claude boot receipt without inventing exhausted retries", () => {
    const result = buildSpawnToolReturn({
      ...base,
      spawn_state: "boot_unsubmitted",
      boot_prompt_receipt: {
        delivered: false,
        typed: true,
        submit_attempted: true,
        submit_dispatched: false,
        submit_verified: null,
        submitted: false,
        retry_count: 0,
        rpc_methods: [],
        delivery_state: "pending_verify",
      },
    });

    expect(result.structuredContent.warning).toMatch(/Return was not dispatched/i);
    expect(result.structuredContent.warning).not.toMatch(/retries.*exhausted/i);
  });

  it.each([
    {
      caller: "new_worktree_split",
      data: { retry_count: 0, agent_id: "agent-1", worktree: { path: "/tmp/wt" } },
      legacyText: '{"ok":true,"tool":"new_worktree_split"}',
    },
    {
      caller: "spawn_in_workspace",
      data: { retry_count: 0, workspace: "workspace:1", agents: [] },
      legacyText: '{"ok":true,"tool":"spawn_in_workspace"}',
    },
  ])("keeps $caller stateless verbose legacy text bare", ({ data, legacyText }) => {
    const result = buildSpawnToolReturn(data, true, legacyText);

    expect(result.content[0]!.text).toBe(legacyText);
  });

  it("does not let alternate lean data bypass the field cap", () => {
    const result = buildSpawnToolReturn(base, false, undefined,
      { workspace_id: "workspace:2", report_path: "/tmp/report", timings: {} });
    expect(Object.keys(result.structuredContent).sort()).toEqual(
      ["ok", "agent_id", "surface_id", "state", "delivered"].sort());
  });

  it("preserves a compact receipt through the registration projection", () => {
    const compact = shapeSpawnResponse({ ...base, boot_prompt_delivered: true,
      warning: "focus restore failed" });
    expect(shapeSpawnResponse(compact)).toEqual(compact);
  });

  it.each(["duplicate", "duplicate | model coerced"])(
    "deduplicates warning sources including the resume aggregate %s",
    (warning) => {
      const result = buildSpawnToolReturn({ ...base, warning,
        warnings: ["duplicate", "model coerced"], duplicate_spawn_warning: "duplicate" });
      expect(result.structuredContent.warning).toBe("duplicate | model coerced");
      expect(Object.keys(result.structuredContent)).toHaveLength(6);
    },
  );

  it("uses the same lean payload for text and structured content", () => {
    const result = buildSpawnToolReturn({ ...base, retry_count: 0 });

    expect(JSON.parse(result.content[0]!.text)).toEqual(
      result.structuredContent,
    );
    expect(result.structuredContent).not.toHaveProperty("retry_count");
  });
});
