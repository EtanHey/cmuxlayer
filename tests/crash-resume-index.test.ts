import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import { StateManager } from "../src/state-manager.js";

const TEST_DIR = join(tmpdir(), "cmux-crash-resume-index-test");

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "brainlayerCodex-pending",
    surface_id: "surface:42",
    workspace_id: "workspace:old",
    state: "booting",
    repo: "brainlayer",
    model: "gpt-5.4",
    cli: "codex",
    cli_session_id: null,
    cli_session_path: null,
    task_summary: "Fix crash recovery",
    pid: null,
    version: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "orchestrator",
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: true,
    respawn_attempts: 0,
    user_killed: false,
    ...overrides,
  };
}

function makeClient(): CmuxClient {
  return {
    newSplit: vi.fn().mockResolvedValue({
      workspace: "workspace:new",
      surface: "surface:new",
      pane: "pane:1",
      title: "",
      type: "terminal",
    }),
    newSurface: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:42",
      text: "codex> ",
      lines: 20,
      scrollback_used: false,
    }),
    renameTab: vi.fn(),
    setStatus: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    selectWorkspace: vi.fn(),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn(),
    identify: vi.fn(),
    browser: vi.fn(),
    log: vi.fn().mockResolvedValue(undefined),
  } as unknown as CmuxClient;
}

describe("surface session crash-resume index", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("persists surface session lookup independently of agent state", () => {
    const stateMgr = new StateManager(TEST_DIR);
    const index = stateMgr.getSurfaceSessionIndex();
    stateMgr.writeState(makeRecord({ agent_id: "agent-a" }));

    index.persist({
      workspace_id: "workspace:old",
      surface_id: "surface:42",
      cli_session_id: "session-a",
      agent_id: "agent-a",
    });
    stateMgr.removeState("agent-a");

    const reloaded = new StateManager(TEST_DIR).getSurfaceSessionIndex();
    expect(
      reloaded.lookup({
        workspace_id: "workspace:old",
        surface_id: "surface:42",
      }),
    ).toMatchObject({
      agent_id: "agent-a",
      cli_session_id: "session-a",
      surface_id: "surface:42",
      workspace_id: "workspace:old",
    });
    expect(
      reloaded.lookup({
        workspace_id: "workspace:recycled",
        surface_id: "surface:42",
      }),
    ).toBeNull();
  });

  it("indexes the final agent id when a boot session is captured", async () => {
    const sessionId = "019e942c-0dda-76f2-bbca-0ef6e484d1c9";
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeRecord({
        agent_id: "brainlayerCodex-pending-1",
        surface_id: "surface:42",
        workspace_id: "workspace:old",
      }),
    );
    const registry = new AgentRegistry(stateMgr, async () => [
      { ref: "surface:42", title: "", type: "terminal", index: 0, selected: true },
    ]);
    const engine = new AgentEngine(stateMgr, registry, makeClient(), {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => sessionId,
    });

    try {
      await registry.reconstitute();
      await engine.runSweep();

      const entry = stateMgr.getSurfaceSessionIndex().lookup({
        workspace_id: "workspace:old",
        surface_id: "surface:42",
      });
      expect(entry).toMatchObject({
        agent_id: "brainlayerCodex-019e942c",
        cli_session_id: sessionId,
        workspace_id: "workspace:old",
        surface_id: "surface:42",
      });
      const rawIndex = JSON.parse(
        readFileSync(join(TEST_DIR, "surface-session-index.json"), "utf-8"),
      );
      expect(rawIndex.by_agent_id["brainlayerCodex-pending-1"]).toBeUndefined();
      stateMgr.removeState("brainlayerCodex-019e942c");
      expect(
        stateMgr.getSurfaceSessionIndex().lookup({
          workspace_id: "workspace:old",
          surface_id: "surface:42",
        }),
      ).toMatchObject({ cli_session_id: sessionId });
    } finally {
      engine.dispose();
    }
  });
});
