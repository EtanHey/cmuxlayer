/**
 * TDD tests for Task 19 — Quality Tracking.
 * Tests parseContextPercent, quality field, /compact at 80%, kill for depth>0.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { parseContextPercent } from "../src/agent-types.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-quality");

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
    listStatus: vi.fn().mockResolvedValue([]),
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

describe("parseContextPercent", () => {
  it("returns null when no context info in text", () => {
    expect(parseContextPercent("$ ls -la")).toBeNull();
    expect(parseContextPercent("")).toBeNull();
    expect(parseContextPercent("some random text")).toBeNull();
  });

  it("returns 80 for '80% context used'", () => {
    expect(parseContextPercent("80% context used")).toBe(80);
  });

  it("returns 75 for 'context 75%'", () => {
    expect(parseContextPercent("context 75%")).toBe(75);
  });

  it("handles '75% context remaining'", () => {
    expect(parseContextPercent("75% context remaining")).toBe(75);
  });

  it("handles mixed text with context percentage", () => {
    expect(
      parseContextPercent("Claude Code  ● 85% context  Model: sonnet"),
    ).toBe(85);
  });

  it("rejects values over 100", () => {
    expect(parseContextPercent("150% context")).toBeNull();
  });
});

describe("Quality Tracking (sweep)", () => {
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

  it("agent record quality field defaults to unknown", async () => {
    const result = await engine.spawnAgent({
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "test",
    });
    const agent = engine.getAgentState(result.agent_id);
    expect(agent!.quality).toBe("unknown");
  });

  it("at 80% context, depth-0 agent sends /compact command", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "s:1",
        spawn_depth: 0,
      }),
    );
    liveSurfaces = [makeSurface("s:1")];
    await engine.getRegistry().reconstitute();

    // Mock readScreen to return 80% context
    vi.mocked(mockClient.readScreen).mockResolvedValue({
      surface: "s:1",
      text: "Claude Code  ● 80% context  Model: sonnet",
      lines: 5,
      scrollback_used: false,
    });

    await engine.runSweep();

    // Should send /compact + return
    expect(mockClient.send).toHaveBeenCalledWith("s:1", "/compact", {});
    expect(mockClient.sendKey).toHaveBeenCalledWith("s:1", "return", {});
  });

  it("at 80% context, depth-1 agent is killed", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "child1",
        state: "working",
        surface_id: "s:2",
        spawn_depth: 1,
        parent_agent_id: "some-parent",
      }),
    );
    liveSurfaces = [makeSurface("s:2")];
    await engine.getRegistry().reconstitute();

    // Mock readScreen to return 85% context
    vi.mocked(mockClient.readScreen).mockResolvedValue({
      surface: "s:2",
      text: "Claude Code  ● 85% context  Model: haiku",
      lines: 5,
      scrollback_used: false,
    });

    await engine.runSweep();

    // Should have been killed (sendKey c-c for graceful stop)
    expect(mockClient.sendKey).toHaveBeenCalledWith("s:2", "c-c", {});
    // Should log the context-limit kill
    expect(mockClient.log).toHaveBeenCalledWith(
      expect.stringContaining("context-limit"),
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("quality is set to degraded at 80% context", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "s:1",
        spawn_depth: 0,
        quality: "unknown",
      }),
    );
    liveSurfaces = [makeSurface("s:1")];
    await engine.getRegistry().reconstitute();

    vi.mocked(mockClient.readScreen).mockResolvedValue({
      surface: "s:1",
      text: "80% context remaining",
      lines: 5,
      scrollback_used: false,
    });

    await engine.runSweep();

    const agent = engine.getAgentState("a1");
    expect(agent!.quality).toBe("degraded");
  });

  it("agent below 80% context is not affected", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "s:1",
        spawn_depth: 0,
        quality: "unknown",
      }),
    );
    liveSurfaces = [makeSurface("s:1")];
    await engine.getRegistry().reconstitute();

    vi.mocked(mockClient.readScreen).mockResolvedValue({
      surface: "s:1",
      text: "Claude Code  ● 50% context  Model: sonnet",
      lines: 5,
      scrollback_used: false,
    });

    await engine.runSweep();

    const agent = engine.getAgentState("a1");
    expect(agent!.quality).toBe("unknown");
    // Should NOT send /compact
    expect(mockClient.send).not.toHaveBeenCalledWith(
      "s:1",
      "/compact",
      expect.anything(),
    );
  });

  it("depth>0 agent at 80% is killed but NOT respawned (kill-only, no auto-respawn)", async () => {
    // Kill-only is intentional. Auto-respawn is wrong because:
    // 1. Respawn loses all work-in-progress context (new agent starts from scratch)
    // 2. Parent orchestrator should decide retry strategy, not the sweep
    // 3. Each respawn adds a dead child — repeated cycles hit MAX_CHILDREN with corpses
    stateMgr.writeState(
      makeRecord({
        agent_id: "child1",
        state: "working",
        surface_id: "s:2",
        spawn_depth: 1,
        parent_agent_id: "some-parent",
      }),
    );
    liveSurfaces = [makeSurface("s:2")];
    await engine.getRegistry().reconstitute();

    vi.mocked(mockClient.readScreen).mockResolvedValue({
      surface: "s:2",
      text: "Claude Code  ● 90% context  Model: haiku",
      lines: 5,
      scrollback_used: false,
    });

    await engine.runSweep();

    // Agent should be in terminal state (killed)
    const agent = engine.getAgentState("child1");
    expect(agent!.state).toBe("done");

    // No new agent should have been spawned (newSplit not called for respawn)
    // newSplit is only called during spawnAgent — 0 calls means no respawn
    expect(mockClient.newSplit).not.toHaveBeenCalled();
  });

  it("maxCostPerAgent is stored in AgentRecord at spawn time", async () => {
    const result = await engine.spawnAgent({
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "test",
      max_cost_per_agent: 5.0,
    });
    const agent = engine.getAgentState(result.agent_id);
    expect(agent!.max_cost_per_agent).toBe(5.0);
  });
});
