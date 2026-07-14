/**
 * TDD tests for Task 19 — Quality Tracking.
 * Tests parseContextPercent, quality field, /compact at 80%, warn for depth>0.
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
    const workspaceRef = "workspace:quality";
    const paneRef = "pane:quality";
    (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        workspaces:
          liveSurfaces.length === 0
            ? []
            : [
                {
                  ref: workspaceRef,
                  title: "quality",
                  index: 0,
                  selected: true,
                  pinned: false,
                },
              ],
      }),
    );
    (mockClient.listPanes as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ workspace }: { workspace?: string } = {}) => ({
        workspace_ref: workspace ?? workspaceRef,
        window_ref: "window:quality",
        panes:
          liveSurfaces.length === 0
            ? []
            : [
                {
                  ref: paneRef,
                  index: 0,
                  focused: true,
                  surface_count: liveSurfaces.length,
                  surface_refs: liveSurfaces.map((surface) => surface.ref),
                  selected_surface_ref: liveSurfaces[0]?.ref,
                },
              ],
      }),
    );
    (
      mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
    ).mockImplementation(
      async ({ workspace, pane }: { workspace?: string; pane?: string } = {}) => ({
        workspace_ref: workspace ?? workspaceRef,
        window_ref: "window:quality",
        pane_ref: pane ?? paneRef,
        surfaces: liveSurfaces,
      }),
    );
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
    });
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

    // Mock readScreen: 160K tokens on older Sonnet (200K window) = 80% used
    (mockClient.readScreen as any).mockResolvedValue({
      surface: "s:1",
      text: "✻ Working…\nToken usage: total=160,000\n🤖 Sonnet 4.5 | 💰 $3.50",
      lines: 5,
      scrollback_used: false,
    });

    await engine.runSweep();

    // Should send /compact + return
    expect(mockClient.send).toHaveBeenCalledWith("s:1", "/compact", {
      workspace: "workspace:quality",
    });
    expect(mockClient.sendKey).toHaveBeenCalledWith("s:1", "return", {
      workspace: "workspace:quality",
    });
  });

  it("auto-compact follows a stable UUID after its cached surface ref is recycled", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    stateMgr.writeState(
      makeRecord({
        agent_id: "uuid-compact",
        state: "working",
        surface_id: "surface:old",
        surface_uuid: stableUuid,
        workspace_id: "workspace:quality",
        spawn_depth: 0,
      }),
    );
    liveSurfaces = [{ ...makeSurface("surface:old"), id: stableUuid }];
    await engine.getRegistry().reconstitute();
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
      async (surface: string) => {
        queueMicrotask(() => {
          liveSurfaces = [
            { ...makeSurface("surface:old"), id: "uuid-recycled" },
            { ...makeSurface("surface:new"), id: stableUuid },
          ];
        });
        return {
          surface,
          text: "gpt-5.5 · 5% left · ~/Gits/cmuxlayer\nWorking (1m • esc to interrupt)",
          lines: 5,
          scrollback_used: false,
        };
      },
    );

    await engine.runSweep();

    // The first sweep must discard screen evidence read through the old ref
    // after the UUID moves. A fresh sweep may then act on the new binding.
    expect(mockClient.send).not.toHaveBeenCalled();
    await engine.runSweep();

    expect(mockClient.send).toHaveBeenCalledWith(
      "surface:new",
      "/compact",
      { workspace: "workspace:quality" },
    );
    expect(mockClient.sendKey).toHaveBeenCalledWith(
      "surface:new",
      "return",
      { workspace: "workspace:quality" },
    );
    expect(mockClient.send).not.toHaveBeenCalledWith(
      "surface:old",
      "/compact",
      expect.anything(),
    );
  });

  it("at 80% context, depth-1 agent is warned but not killed", async () => {
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

    // Mock readScreen: 170K tokens on Haiku (200K window) = 85% used
    (mockClient.readScreen as any).mockResolvedValue({
      surface: "s:2",
      text: "✻ Working…\nToken usage: total=170,000\n🤖 Haiku 3.5 | 💰 $0.10",
      lines: 5,
      scrollback_used: false,
    });

    await engine.runSweep();

    expect(mockClient.sendKey).not.toHaveBeenCalledWith("s:2", "c-c", {});
    expect(engine.getAgentState("child1")).toMatchObject({
      state: "working",
      quality: "degraded",
    });
    // Should log the context-limit warning
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

    // 160K tokens on older Sonnet (200K window) = 80% used
    (mockClient.readScreen as any).mockResolvedValue({
      surface: "s:1",
      text: "✻ Working…\nToken usage: total=160,000\n🤖 Sonnet 4.5 | 💰 $2.00",
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

    // 100K tokens on older Sonnet (200K window) = 50% used — below threshold
    (mockClient.readScreen as any).mockResolvedValue({
      surface: "s:1",
      text: "✻ Working…\nToken usage: total=100,000\n🤖 Sonnet 4.5 | 💰 $1.00",
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

  it("depth>0 agent at 80% is degraded but not killed or respawned", async () => {
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

    // 180K tokens on Haiku (200K window) = 90% used — above threshold
    (mockClient.readScreen as any).mockResolvedValue({
      surface: "s:2",
      text: "✻ Working…\nToken usage: total=180,000\n🤖 Haiku 3.5 | 💰 $0.15",
      lines: 5,
      scrollback_used: false,
    });

    await engine.runSweep();

    const agent = engine.getAgentState("child1");
    expect(agent!.state).toBe("working");
    expect(agent!.quality).toBe("degraded");
    expect(mockClient.sendKey).not.toHaveBeenCalledWith("s:2", "c-c", {});

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
