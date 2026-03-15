import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-engine");

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
    state: "creating",
    repo: "brainlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: null,
    task_summary: "Fix search gap F",
    pid: null,
    version: 0,
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

describe("AgentEngine", () => {
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

  describe("spawnAgent", () => {
    it("creates a cmux surface and returns agent handle", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Fix gap F",
      });

      expect(result.agent_id).toMatch(/^sonnet-brainlayer-\d+-[a-z0-9]+$/);
      expect(result.surface_id).toBe("surface:new");
      expect(result.state).toBe("booting");
    });

    it("sends the launch command to the surface", async () => {
      await engine.spawnAgent({
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "Fix gap F",
      });

      expect(mockClient.send).toHaveBeenCalled();
      expect(mockClient.sendKey).toHaveBeenCalled();
    });

    it("writes initial state file", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Fix gap F",
      });

      const state = stateMgr.readState(result.agent_id);
      expect(state).not.toBeNull();
      expect(state!.state).toBe("booting");
      expect(state!.repo).toBe("brainlayer");
      expect(state!.task_summary).toBe("Fix gap F");
    });

    it("records creation in events.jsonl", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Fix gap F",
      });

      const events = stateMgr.getEventLog().readForAgent(result.agent_id);
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.to_state === "booting")).toBe(true);
    });
  });

  describe("waitFor", () => {
    it("returns immediately if agent is already in target state", async () => {
      stateMgr.writeState(
        makeRecord({ agent_id: "agent-ready", state: "ready" }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      const result = await engine.waitFor("agent-ready", "ready", 5000);
      expect(result.matched).toBe(true);
      expect(result.source).toBe("immediate");
      expect(result.elapsed).toBeLessThan(100);
    });

    it("returns error result when agent is in error state", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-err",
          state: "error",
          error: "crashed",
        }),
      );
      liveSurfaces = [];
      await engine.getRegistry().reconstitute();

      const result = await engine.waitFor("agent-err", "ready", 5000);
      expect(result.matched).toBe(false);
      expect(result.state).toBe("error");
    });

    it("times out when target state is never reached", async () => {
      stateMgr.writeState(
        makeRecord({ agent_id: "agent-stuck", state: "booting" }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      const result = await engine.waitFor("agent-stuck", "ready", 500);
      expect(result.matched).toBe(false);
      expect(result.source).toBe("timeout");
    });

    it("detects state change via sweep", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot",
          state: "booting",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      // Simulate another process transitioning the state after 200ms
      setTimeout(() => {
        stateMgr.transition("agent-boot", "ready");
      }, 200);

      const result = await engine.waitFor("agent-boot", "ready", 5000);
      expect(result.matched).toBe(true);
      expect(result.source).toBe("sweep");
    });

    it("throws for non-existent agent", async () => {
      await expect(
        engine.waitFor("nonexistent", "ready", 1000),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("waitForAll", () => {
    it("succeeds when all agents reach target state", async () => {
      stateMgr.writeState(
        makeRecord({ agent_id: "a1", state: "ready", surface_id: "s:1" }),
      );
      stateMgr.writeState(
        makeRecord({ agent_id: "a2", state: "ready", surface_id: "s:2" }),
      );
      liveSurfaces = [makeSurface("s:1"), makeSurface("s:2")];
      await engine.getRegistry().reconstitute();

      const results = await engine.waitForAll(["a1", "a2"], "ready", 5000);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.matched)).toBe(true);
    });

    it("fail-fast: returns partial results when any agent errors", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "ok",
          state: "ready",
          surface_id: "s:1",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "bad",
          state: "error",
          error: "crashed",
          surface_id: "s:2",
        }),
      );
      liveSurfaces = [makeSurface("s:1")];
      await engine.getRegistry().reconstitute();

      const results = await engine.waitForAll(["ok", "bad"], "ready", 5000);
      const okResult = results.find((r) => r.state === "ready" && r.matched);
      const badResult = results.find((r) => r.state === "error");
      expect(okResult).toBeDefined();
      expect(badResult).toBeDefined();
      expect(badResult!.matched).toBe(false);
    });
  });

  describe("getAgentState", () => {
    it("returns full agent record", async () => {
      stateMgr.writeState(makeRecord({ agent_id: "agent-x" }));
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      const state = engine.getAgentState("agent-x");
      expect(state).not.toBeNull();
      expect(state!.agent_id).toBe("agent-x");
    });

    it("returns null for unknown agent", async () => {
      await engine.getRegistry().reconstitute();
      expect(engine.getAgentState("unknown")).toBeNull();
    });
  });

  describe("listAgents", () => {
    it("returns all agents when no filter", async () => {
      stateMgr.writeState(makeRecord({ agent_id: "a", surface_id: "s:1" }));
      stateMgr.writeState(makeRecord({ agent_id: "b", surface_id: "s:2" }));
      liveSurfaces = [makeSurface("s:1"), makeSurface("s:2")];
      await engine.getRegistry().reconstitute();

      expect(engine.listAgents()).toHaveLength(2);
    });

    it("filters by state", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "a",
          state: "working",
          surface_id: "s:1",
        }),
      );
      stateMgr.writeState(
        makeRecord({ agent_id: "b", state: "done", surface_id: "s:2" }),
      );
      liveSurfaces = [makeSurface("s:1"), makeSurface("s:2")];
      await engine.getRegistry().reconstitute();

      expect(engine.listAgents({ state: "working" })).toHaveLength(1);
    });
  });

  describe("stopAgent", () => {
    it("sends Ctrl+C for graceful stop", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stop",
          state: "working",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await engine.stopAgent("agent-stop");

      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:42",
        "c-c",
        expect.anything(),
      );
    });

    it("transitions agent to done state", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stop",
          state: "working",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await engine.stopAgent("agent-stop");

      const state = stateMgr.readState("agent-stop");
      expect(state!.state).toBe("done");
    });

    it("force stop kills the process when pid is available", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-force",
          state: "working",
          surface_id: "surface:42",
          pid: 99999,
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      // Force stop — won't actually kill since PID doesn't exist, but should not throw
      await engine.stopAgent("agent-force", true);

      const state = stateMgr.readState("agent-force");
      expect(["done", "error"]).toContain(state!.state);
    });

    it("throws for non-existent agent", async () => {
      await engine.getRegistry().reconstitute();
      await expect(engine.stopAgent("nonexistent")).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe("sendToAgent", () => {
    it("sends text to the agent's surface", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-send",
          state: "ready",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await engine.sendToAgent("agent-send", "do something", true);

      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:42",
        "do something",
        expect.anything(),
      );
      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:42",
        "return",
        expect.anything(),
      );
    });

    it("works for agents in idle state", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-idle",
          state: "idle",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await engine.sendToAgent("agent-idle", "continue");
      expect(mockClient.send).toHaveBeenCalled();
    });

    it("rejects sending to agents in non-interactive states", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot",
          state: "booting",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await expect(engine.sendToAgent("agent-boot", "hello")).rejects.toThrow(
        /not in an interactive state/,
      );
    });

    it("rejects sending to done agents", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-done",
          state: "done",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await expect(engine.sendToAgent("agent-done", "hello")).rejects.toThrow(
        /not in an interactive state/,
      );
    });
  });
});
