// VALIDATION: Claude/Cursor keep the default-on synchronous harness behavior, while Codex
// uses its exact self-registration path through the async provider and fixed 400K service
// denominator. No harness may fall back to an inferred 1M Codex window.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createServerContext } from "../src/server.js";
import { StateManager } from "../src/state-manager.js";

const FIX = join(__dirname, "fixtures", "harness");

function record(
  agent_id: string,
  surface_id: string,
  cli: string,
  sid: string,
  model: string,
) {
  return {
    agent_id,
    surface_id,
    state: "idle" as const,
    repo: "x",
    model,
    cli: cli as never,
    cli_session_id: sid,
    task_summary: "validate",
    pid: null,
    version: 1,
    created_at: "2026-06-04T00:00:00Z",
    updated_at: "2026-06-04T00:00:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown" as const,
    max_cost_per_agent: null,
  };
}

describe("CMUXLAYER_HARNESS_JSONL=1 validation (real windows from JSONL)", () => {
  const home = mkdtempSync(join(tmpdir(), "cmux-validate-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "cmux-validate-state-"));
  const prevFlag = process.env.CMUXLAYER_HARNESS_JSONL;
  const prevHome = process.env.CMUXLAYER_HARNESS_HOME;
  const codexUuid = "11111111-1111-4111-8111-111111111111";
  const claudeUuid = "22222222-2222-4222-8222-222222222222";
  const cursorUuid = "33333333-3333-4333-8333-333333333333";
  const codexPath = join(
    home,
    ".codex",
    "sessions",
    "2026",
    "06",
    "04",
    "rollout-2026-06-04T22-46-15-vsid-codex.jsonl",
  );

  beforeAll(() => {
    // Place the verified fixtures where findHarnessSessionPath resolves them by sessionId.
    mkdirSync(join(home, ".codex", "sessions", "2026", "06", "04"), {
      recursive: true,
    });
    cpSync(
      join(FIX, "codex.jsonl"),
      join(
        home,
        ".codex",
        "sessions",
        "2026",
        "06",
        "04",
        "rollout-2026-06-04T22-46-15-vsid-codex.jsonl",
      ),
    );
    mkdirSync(join(home, ".claude", "projects", "-x"), { recursive: true });
    cpSync(
      join(FIX, "claude.jsonl"),
      join(home, ".claude", "projects", "-x", "vsid-claude.jsonl"),
    );
    mkdirSync(
      join(
        home,
        ".cursor",
        "projects",
        "x",
        "agent-transcripts",
        "vsid-cursor",
      ),
      { recursive: true },
    );
    cpSync(
      join(FIX, "cursor.jsonl"),
      join(
        home,
        ".cursor",
        "projects",
        "x",
        "agent-transcripts",
        "vsid-cursor",
        "vsid-cursor.jsonl",
      ),
    );

    const sm = new StateManager(stateDir);
    sm.writeState({
      ...record("a-codex", "surface:1", "codex", "vsid-codex", "gpt-5.5"),
      surface_uuid: codexUuid,
      cli_session_path: codexPath,
    });
    sm.writeState(
      {
        ...record(
          "a-claude",
          "surface:2",
          "claude",
          "vsid-claude",
          "claude-opus-4-8",
        ),
        surface_uuid: claudeUuid,
      },
    );
    sm.writeState(
      {
        ...record("a-cursor", "surface:3", "cursor", "vsid-cursor", "cursor"),
        surface_uuid: cursorUuid,
      },
    );

    process.env.CMUXLAYER_HARNESS_JSONL = "1";
    process.env.CMUXLAYER_HARNESS_HOME = home;
  });

  afterAll(() => {
    if (prevFlag === undefined) delete process.env.CMUXLAYER_HARNESS_JSONL;
    else process.env.CMUXLAYER_HARNESS_JSONL = prevFlag;
    if (prevHome === undefined) delete process.env.CMUXLAYER_HARNESS_HOME;
    else process.env.CMUXLAYER_HARNESS_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const screens: Record<string, string> = {
    "surface:1":
      "gpt-5.5 xhigh · 60% left · ~/x\nWorking (2m 00s • esc to interrupt)",
    "surface:2": "Token usage: total=40,000\nCLAUDE_COUNTER: 7",
    "surface:3":
      "Auto · 22% · 3 files edited\n→ Add a follow-up\nctrl+c to stop",
  };

  function makeTool() {
    const mockClient = {
      // Real client signature: readScreen(surfaceRef, opts) — surface is positional.
      readScreen: async (surface: string) => ({
        surface,
        text: screens[surface],
        lines: 20,
        scrollback_used: false,
      }),
      listWorkspaces: async () => ({ workspaces: [{ ref: "workspace:1" }] }),
      listPanes: async () => ({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:1",
            surface_count: 3,
            surface_refs: ["surface:1", "surface:2", "surface:3"],
            surface_ids: [codexUuid, claudeUuid, cursorUuid],
          },
        ],
      }),
      listPaneSurfaces: async ({}: any) => ({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ref: "surface:1",
            id: codexUuid,
            title: "codex",
            type: "terminal",
            index: 0,
          },
          {
            ref: "surface:2",
            id: claudeUuid,
            title: "claude",
            type: "terminal",
            index: 1,
          },
          {
            ref: "surface:3",
            id: cursorUuid,
            title: "cursor",
            type: "terminal",
            index: 2,
          },
        ],
      }),
    } as any;
    const context = createServerContext({
      client: mockClient,
      stateDir,
      skipAgentLifecycle: true,
      surfaceObserverEpochProvider: () => "test:1",
    });
    context.lifecycleRegistry = {
      canUseObservedBinding: () => true,
    } as any;
    const server = createServer({ context });
    return (server as any)._registeredTools["read_screen"];
  }

  const callParsed = async (surface: string) => {
    const tool = makeTool();
    const res = await tool.handler({ surface, parsed_only: true }, {} as any);
    return (res.structuredContent ?? JSON.parse(res.content[0].text)).parsed;
  };

  it("Codex: exact rollout path uses last usage against fixed 400K", async () => {
    const p = await callParsed("surface:1");
    expect(p.agent_type).toBe("codex");
    expect(p.context_window).toBe(400000);
    expect(p.context_window).not.toBe(1_000_000);
    expect(p.token_count).toBe(108569);
    expect(p.context_pct).toBe(27);
  });

  it("Claude: table window (opus-4-8 → 1M) from JSONL usage tail", async () => {
    const p = await callParsed("surface:2");
    expect(p.context_window).toBe(1_000_000);
    expect(p.token_count).toBe(82000);
    expect(p.context_pct).toBe(8);
  });

  it("Cursor: clean TUI-strip fallback (JSONL has no tokens/window)", async () => {
    const p = await callParsed("surface:3");
    expect(p.agent_type).toBe("cursor");
    expect(p.context_pct).toBe(22); // from "Auto · 22%" strip, NOT overwritten
    expect(p.context_window).toBeNull();
  });
});
