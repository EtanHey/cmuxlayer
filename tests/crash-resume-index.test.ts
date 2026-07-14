import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import { StateManager } from "../src/state-manager.js";
import type { CmuxSurface } from "../src/types.js";

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

function makeClient(
  liveSurfaces: CmuxSurface[],
  workspaceId = "workspace:old",
): CmuxClient {
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
    listWorkspaces: vi.fn().mockResolvedValue({
      workspaces: [
        {
          ref: workspaceId,
          title: workspaceId,
          index: 0,
          selected: true,
          pinned: false,
        },
      ],
    }),
    listPanes: vi.fn().mockImplementation(
      async ({ workspace }: { workspace?: string } = {}) => ({
        workspace_ref: workspace ?? workspaceId,
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:1",
            index: 0,
            focused: true,
            surface_count: liveSurfaces.length,
            surface_refs: liveSurfaces.map((surface) => surface.ref),
            selected_surface_ref:
              liveSurfaces.find((surface) => surface.selected)?.ref ??
              liveSurfaces[0]?.ref,
          },
        ],
      }),
    ),
    listPaneSurfaces: vi.fn().mockImplementation(
      async ({ workspace, pane }: { workspace?: string; pane?: string } = {}) => ({
        workspace_ref: workspace ?? workspaceId,
        window_ref: "window:1",
        pane_ref: pane ?? "pane:1",
        surfaces: liveSurfaces,
      }),
    ),
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
    const liveSurfaces: CmuxSurface[] = [
      { ref: "surface:42", title: "", type: "terminal", index: 0, selected: true },
    ];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    const engine = new AgentEngine(stateMgr, registry, makeClient(liveSurfaces), {
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

  it("removes the pending index entry when the final agent already exists", async () => {
    const sessionId = "019e942c-0dda-76f2-bbca-0ef6e484d1c9";
    const sessionPath = "/tmp/codex-session.jsonl";
    const finalAgentId = "brainlayerCodex-019e942c";
    const pendingAgentId = "brainlayerCodex-pending-existing";
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeRecord({
        agent_id: finalAgentId,
        surface_id: "surface:final",
        workspace_id: "workspace:old",
        cli_session_id: sessionId,
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: pendingAgentId,
        surface_id: "surface:pending",
        workspace_id: "workspace:old",
      }),
    );
    const liveSurfaces: CmuxSurface[] = [
      {
        ref: "surface:final",
        title: "",
        type: "terminal",
        index: 0,
        selected: false,
      },
      {
        ref: "surface:pending",
        title: "",
        type: "terminal",
        index: 1,
        selected: true,
      },
    ];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    const engine = new AgentEngine(stateMgr, registry, makeClient(liveSurfaces), {
      spawnPreflight: async () => {},
      sessionIdentityResolver: (agent) =>
        agent.agent_id === pendingAgentId
          ? { session_id: sessionId, path: sessionPath }
          : null,
    });

    try {
      await registry.reconstitute();
      await engine.runSweep();

      const rawIndex = JSON.parse(
        readFileSync(join(TEST_DIR, "surface-session-index.json"), "utf-8"),
      );
      expect(rawIndex.by_agent_id[pendingAgentId]).toBeUndefined();
      expect(rawIndex.by_agent_id[finalAgentId]).toMatchObject({
        agent_id: finalAgentId,
        cli_session_id: sessionId,
      });
      expect(engine.getAgentState(pendingAgentId)).toMatchObject({
        agent_id: finalAgentId,
        cli_session_id: sessionId,
        cli_session_path: sessionPath,
      });
      expect(engine.getAgentState(finalAgentId)).toMatchObject({
        agent_id: finalAgentId,
        cli_session_id: sessionId,
        cli_session_path: sessionPath,
      });
      expect(stateMgr.readState(pendingAgentId)).toBeNull();
    } finally {
      engine.dispose();
    }
  });

  it("preserves an existing final session path when duplicate capture has none", async () => {
    const sessionId = "019e942c-0dda-76f2-bbca-0ef6e484d1c9";
    const existingSessionPath = "/tmp/existing-session.jsonl";
    const finalAgentId = "brainlayerCodex-019e942c";
    const pendingAgentId = "brainlayerCodex-pending-no-path";
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeRecord({
        agent_id: finalAgentId,
        surface_id: "surface:final",
        workspace_id: "workspace:old",
        cli_session_id: sessionId,
        cli_session_path: existingSessionPath,
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: pendingAgentId,
        surface_id: "surface:pending",
        workspace_id: "workspace:old",
      }),
    );
    const liveSurfaces: CmuxSurface[] = [
      {
        ref: "surface:final",
        title: "",
        type: "terminal",
        index: 0,
        selected: false,
      },
      {
        ref: "surface:pending",
        title: "",
        type: "terminal",
        index: 1,
        selected: true,
      },
    ];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    const engine = new AgentEngine(stateMgr, registry, makeClient(liveSurfaces), {
      spawnPreflight: async () => {},
      sessionIdentityResolver: (agent) =>
        agent.agent_id === pendingAgentId ? sessionId : null,
    });

    try {
      await registry.reconstitute();
      await engine.runSweep();

      expect(engine.getAgentState(finalAgentId)).toMatchObject({
        agent_id: finalAgentId,
        cli_session_id: sessionId,
        cli_session_path: existingSessionPath,
      });
      expect(engine.getAgentState(pendingAgentId)).toMatchObject({
        agent_id: finalAgentId,
        cli_session_path: existingSessionPath,
      });
    } finally {
      engine.dispose();
    }
  });

  it("allocates a disambiguated final id when session-id prefixes collide", async () => {
    const existingSessionId = "019e942c-1111-76f2-bbca-0ef6e484d1c9";
    const capturedSessionId = "019e942c-2222-76f2-bbca-0ef6e484d1c9";
    const finalAgentId = "brainlayerCodex-019e942c";
    const disambiguatedAgentId = "brainlayerCodex-019e942c-2222-76f";
    const pendingAgentId = "brainlayerCodex-pending-collision";
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeRecord({
        agent_id: finalAgentId,
        surface_id: "surface:final",
        workspace_id: "workspace:old",
        cli_session_id: existingSessionId,
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: pendingAgentId,
        surface_id: "surface:pending",
        workspace_id: "workspace:old",
      }),
    );
    const liveSurfaces: CmuxSurface[] = [
      {
        ref: "surface:final",
        title: "",
        type: "terminal",
        index: 0,
        selected: false,
      },
      {
        ref: "surface:pending",
        title: "",
        type: "terminal",
        index: 1,
        selected: true,
      },
    ];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    const engine = new AgentEngine(stateMgr, registry, makeClient(liveSurfaces), {
      spawnPreflight: async () => {},
      sessionIdentityResolver: (agent) =>
        agent.agent_id === pendingAgentId ? capturedSessionId : null,
    });

    try {
      await registry.reconstitute();
      await engine.runSweep();

      expect(engine.getAgentState(finalAgentId)).toMatchObject({
        agent_id: finalAgentId,
        cli_session_id: existingSessionId,
      });
      expect(engine.getAgentState(disambiguatedAgentId)).toMatchObject({
        agent_id: disambiguatedAgentId,
        cli_session_id: capturedSessionId,
      });
      expect(engine.getAgentState(pendingAgentId)).toMatchObject({
        agent_id: disambiguatedAgentId,
        cli_session_id: capturedSessionId,
      });
      expect(stateMgr.readState(pendingAgentId)).toBeNull();
    } finally {
      engine.dispose();
    }
  });
});
