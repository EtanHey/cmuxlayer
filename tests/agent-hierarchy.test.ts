/**
 * TDD tests for Task 18 — Agent Hierarchy.
 * Tests spawn_depth, parent_agent_id, MAX_SPAWN_DEPTH, MAX_CHILDREN,
 * getSubtree, and cascadeKill.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import { MAX_SPAWN_DEPTH, MAX_CHILDREN } from "../src/agent-types.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-hierarchy");

function makeMockClient(overrides?: Partial<CmuxClient>): CmuxClient {
  return {
    newSplit: vi.fn().mockResolvedValue({
      workspace: "ws:1",
      surface: "surface:new",
      pane: "pane:1",
      title: "",
      type: "terminal",
    } satisfies CmuxNewSplitResult),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:new",
      text: "$ ",
      lines: 20,
      scrollback_used: false,
    }),
    renameTab: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CmuxClient;
}

function makeSurface(ref: string): CmuxSurface {
  return { ref, title: "", type: "terminal", index: 0, selected: false };
}

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "codex-brainlayer-1710388800",
    surface_id: "surface:42",
    state: "working",
    repo: "brainlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: null,
    task_summary: "Fix search gap F",
    pid: null,
    version: 1,
    created_at: "2026-03-14T03:40:00Z",
    updated_at: "2026-03-14T03:40:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  };
}

describe("Agent Hierarchy", () => {
  let stateMgr: StateManager;
  let mockClient: CmuxClient;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient);
  });

  afterEach(() => {
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("root agents have spawn_depth=0 and parent_agent_id=null", async () => {
    const result = await engine.spawnAgent({
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "Fix gap F",
    });

    const agent = engine.getAgentState(result.agent_id);
    expect(agent).not.toBeNull();
    expect(agent!.spawn_depth).toBe(0);
    expect(agent!.parent_agent_id).toBeNull();
  });

  it("child agent inherits spawn_depth + 1 from parent", async () => {
    // Spawn a root agent
    const root = await engine.spawnAgent({
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "Root task",
    });
    liveSurfaces = [makeSurface("surface:new")];

    // Spawn a child (second newSplit call will also return surface:new — ok for test)
    const child = await engine.spawnAgent({
      repo: "voicelayer",
      model: "haiku",
      cli: "claude",
      prompt: "Sub task",
      parent_agent_id: root.agent_id,
    });

    const childAgent = engine.getAgentState(child.agent_id);
    expect(childAgent).not.toBeNull();
    expect(childAgent!.spawn_depth).toBe(1);
    expect(childAgent!.parent_agent_id).toBe(root.agent_id);
  });

  it("spawnAgent rejects when spawn_depth would exceed MAX_SPAWN_DEPTH", async () => {
    // Build a chain: root → depth1 → depth2
    const root = await engine.spawnAgent({
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "Root",
    });
    liveSurfaces = [makeSurface("surface:new")];

    const depth1 = await engine.spawnAgent({
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "Depth 1",
      parent_agent_id: root.agent_id,
    });

    const depth2 = await engine.spawnAgent({
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "Depth 2",
      parent_agent_id: depth1.agent_id,
    });

    // Attempt depth3 — should fail because MAX_SPAWN_DEPTH = 2
    await expect(
      engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Depth 3 — should fail",
        parent_agent_id: depth2.agent_id,
      }),
    ).rejects.toThrow(`Max spawn depth exceeded: ${MAX_SPAWN_DEPTH}`);
  });

  it("spawnAgent rejects when parent already has MAX_CHILDREN children", async () => {
    const root = await engine.spawnAgent({
      repo: "root-repo",
      model: "sonnet",
      cli: "claude",
      prompt: "Root",
    });
    liveSurfaces = [makeSurface("surface:new")];

    // Spawn MAX_CHILDREN children — each with a unique repo to avoid ID collision
    for (let i = 0; i < MAX_CHILDREN; i++) {
      await engine.spawnAgent({
        repo: `child-${i}`,
        model: "sonnet",
        cli: "claude",
        prompt: `Child ${i}`,
        parent_agent_id: root.agent_id,
      });
    }

    // One more should fail
    await expect(
      engine.spawnAgent({
        repo: "child-overflow",
        model: "sonnet",
        cli: "claude",
        prompt: "One too many",
        parent_agent_id: root.agent_id,
      }),
    ).rejects.toThrow(`Max children exceeded: ${MAX_CHILDREN}`);
  });

  it("spawnAgent rejects when parent_agent_id not found", async () => {
    await expect(
      engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Orphan",
        parent_agent_id: "nonexistent-parent",
      }),
    ).rejects.toThrow("Parent agent not found: nonexistent-parent");
  });

  describe("getSubtree", () => {
    it("getSubtree returns only root when no children", async () => {
      stateMgr.writeState(makeRecord({ agent_id: "root", surface_id: "s:1" }));
      liveSurfaces = [makeSurface("s:1")];
      await engine.getRegistry().reconstitute();

      const subtree = engine.getRegistry().getSubtree("root");
      expect(subtree).toHaveLength(1);
      expect(subtree[0].agent_id).toBe("root");
    });

    it("getSubtree returns children before root (DFS post-order)", async () => {
      stateMgr.writeState(makeRecord({ agent_id: "root", surface_id: "s:1" }));
      stateMgr.writeState(
        makeRecord({
          agent_id: "child1",
          surface_id: "s:2",
          parent_agent_id: "root",
          spawn_depth: 1,
        }),
      );
      liveSurfaces = [makeSurface("s:1"), makeSurface("s:2")];
      await engine.getRegistry().reconstitute();

      const subtree = engine.getRegistry().getSubtree("root");
      expect(subtree).toHaveLength(2);
      // Children before root in post-order
      expect(subtree[0].agent_id).toBe("child1");
      expect(subtree[1].agent_id).toBe("root");
    });

    it("getSubtree returns full tree in post-order", async () => {
      // root → child1 → grandchild
      //       → child2
      stateMgr.writeState(makeRecord({ agent_id: "root", surface_id: "s:1" }));
      stateMgr.writeState(
        makeRecord({
          agent_id: "child1",
          surface_id: "s:2",
          parent_agent_id: "root",
          spawn_depth: 1,
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "child2",
          surface_id: "s:3",
          parent_agent_id: "root",
          spawn_depth: 1,
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "grandchild",
          surface_id: "s:4",
          parent_agent_id: "child1",
          spawn_depth: 2,
        }),
      );
      liveSurfaces = [
        makeSurface("s:1"),
        makeSurface("s:2"),
        makeSurface("s:3"),
        makeSurface("s:4"),
      ];
      await engine.getRegistry().reconstitute();

      const subtree = engine.getRegistry().getSubtree("root");
      expect(subtree).toHaveLength(4);

      // Post-order: grandchild before child1, both children before root
      const ids = subtree.map((a) => a.agent_id);
      expect(ids.indexOf("grandchild")).toBeLessThan(ids.indexOf("child1"));
      expect(ids.indexOf("child1")).toBeLessThan(ids.indexOf("root"));
      expect(ids.indexOf("child2")).toBeLessThan(ids.indexOf("root"));
      expect(ids[ids.length - 1]).toBe("root");
    });
  });

  describe("cascadeKill", () => {
    it("cascadeKill stops children before the root", async () => {
      const stoppedOrder: string[] = [];
      const stopAgent = vi
        .spyOn(engine, "stopAgent")
        .mockImplementation(async (agentId) => {
          stoppedOrder.push(agentId);
        });

      stateMgr.writeState(makeRecord({ agent_id: "root", surface_id: "s:1" }));
      stateMgr.writeState(
        makeRecord({
          agent_id: "child1",
          surface_id: "s:2",
          parent_agent_id: "root",
          spawn_depth: 1,
        }),
      );
      liveSurfaces = [makeSurface("s:1"), makeSurface("s:2")];
      await engine.getRegistry().reconstitute();

      await engine.cascadeKill("root");

      // child1 must appear before root
      expect(stoppedOrder.indexOf("child1")).toBeLessThan(
        stoppedOrder.indexOf("root"),
      );
      stopAgent.mockRestore();
    });

    it("cascadeKill continues if one child stop fails", async () => {
      let callCount = 0;
      const stopAgent = vi
        .spyOn(engine, "stopAgent")
        .mockImplementation(async (agentId) => {
          callCount++;
          if (agentId === "child1") throw new Error("stop failed");
        });

      stateMgr.writeState(makeRecord({ agent_id: "root", surface_id: "s:1" }));
      stateMgr.writeState(
        makeRecord({
          agent_id: "child1",
          surface_id: "s:2",
          parent_agent_id: "root",
          spawn_depth: 1,
        }),
      );
      liveSurfaces = [makeSurface("s:1"), makeSurface("s:2")];
      await engine.getRegistry().reconstitute();

      // Should not throw even though child1 stop fails
      await expect(engine.cascadeKill("root")).resolves.toBeUndefined();
      // Both root and child1 were attempted
      expect(callCount).toBe(2);
      stopAgent.mockRestore();
    });
  });

  describe("orphan survival", () => {
    it("children continue running when parent surface disappears", async () => {
      // Parent on surface s:1, child on surface s:2
      stateMgr.writeState(
        makeRecord({
          agent_id: "parent",
          surface_id: "s:1",
          state: "working",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "child",
          surface_id: "s:2",
          parent_agent_id: "parent",
          spawn_depth: 1,
          state: "working",
        }),
      );
      liveSurfaces = [makeSurface("s:1"), makeSurface("s:2")];
      await engine.getRegistry().reconstitute();

      // Parent surface disappears, child surface remains
      liveSurfaces = [makeSurface("s:2")];
      await engine.getRegistry().reconcile();

      // Parent should be in error state
      const parent = engine.getAgentState("parent");
      expect(parent!.state).toBe("error");
      expect(parent!.error).toContain("disappeared");

      // Child should still be working — orphan survival, NOT cascade kill
      const child = engine.getAgentState("child");
      expect(child!.state).toBe("working");
      // Child retains its parent reference (no reparenting)
      expect(child!.parent_agent_id).toBe("parent");
    });
  });
});
