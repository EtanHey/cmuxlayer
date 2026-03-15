import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord, AgentState } from "../src/agent-types.js";
import type { CmuxSurface } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-registry");

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
    pid: 12345,
    version: 3,
    created_at: "2026-03-14T03:40:00Z",
    updated_at: "2026-03-14T03:45:12Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  };
}

function makeSurface(ref: string): CmuxSurface {
  return {
    ref,
    title: `Agent on ${ref}`,
    type: "terminal",
    index: 0,
    selected: false,
  };
}

describe("AgentRegistry", () => {
  let stateMgr: StateManager;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("reconstitute", () => {
    it("loads agents from state files", async () => {
      stateMgr.writeState(makeRecord({ agent_id: "agent-a" }));
      stateMgr.writeState(makeRecord({ agent_id: "agent-b" }));

      const surfaceProvider = async () => [makeSurface("surface:42")];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      expect(registry.list()).toHaveLength(2);
    });

    it("marks agents as error if their surface is gone", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-orphan",
          surface_id: "surface:99",
          state: "working",
        }),
      );

      // Surface provider returns no surfaces — surface:99 is gone
      const surfaceProvider = async () => [] as CmuxSurface[];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const agents = registry.list();
      expect(agents).toHaveLength(1);
      expect(agents[0].state).toBe("error");
      expect(agents[0].error).toContain("disappeared");
    });

    it("does not mark done/error agents as error for missing surfaces", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-done",
          surface_id: "surface:99",
          state: "done",
        }),
      );

      const surfaceProvider = async () => [] as CmuxSurface[];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const agents = registry.list();
      expect(agents[0].state).toBe("done"); // Still done, not error
    });
  });

  describe("get", () => {
    it("returns the agent record by ID", async () => {
      stateMgr.writeState(makeRecord({ agent_id: "agent-x" }));

      const surfaceProvider = async () => [makeSurface("surface:42")];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const agent = registry.get("agent-x");
      expect(agent).not.toBeNull();
      expect(agent!.agent_id).toBe("agent-x");
    });

    it("returns null for unknown agent", async () => {
      const surfaceProvider = async () => [] as CmuxSurface[];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      expect(registry.get("nonexistent")).toBeNull();
    });
  });

  describe("list with filters", () => {
    it("filters by state", async () => {
      stateMgr.writeState(
        makeRecord({ agent_id: "a", state: "working", surface_id: "s:1" }),
      );
      stateMgr.writeState(
        makeRecord({ agent_id: "b", state: "done", surface_id: "s:2" }),
      );
      stateMgr.writeState(
        makeRecord({ agent_id: "c", state: "working", surface_id: "s:3" }),
      );

      const surfaceProvider = async () => [
        makeSurface("s:1"),
        makeSurface("s:2"),
        makeSurface("s:3"),
      ];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const working = registry.list({ state: "working" });
      expect(working).toHaveLength(2);
      expect(working.every((a) => a.state === "working")).toBe(true);
    });

    it("filters by repo", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "a",
          repo: "brainlayer",
          surface_id: "s:1",
        }),
      );
      stateMgr.writeState(
        makeRecord({ agent_id: "b", repo: "golems", surface_id: "s:2" }),
      );

      const surfaceProvider = async () => [
        makeSurface("s:1"),
        makeSurface("s:2"),
      ];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const brainlayer = registry.list({ repo: "brainlayer" });
      expect(brainlayer).toHaveLength(1);
      expect(brainlayer[0].repo).toBe("brainlayer");
    });

    it("filters by model", async () => {
      stateMgr.writeState(
        makeRecord({ agent_id: "a", model: "codex", surface_id: "s:1" }),
      );
      stateMgr.writeState(
        makeRecord({ agent_id: "b", model: "sonnet", surface_id: "s:2" }),
      );

      const surfaceProvider = async () => [
        makeSurface("s:1"),
        makeSurface("s:2"),
      ];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const codex = registry.list({ model: "codex" });
      expect(codex).toHaveLength(1);
    });
  });

  describe("reconcile", () => {
    it("detects surfaces that disappeared and marks agents as error", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-alive",
          surface_id: "surface:1",
          state: "working",
        }),
      );

      let surfaces = [makeSurface("surface:1")];
      const surfaceProvider = async () => surfaces;
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      // Surface disappears
      surfaces = [];
      await registry.reconcile();

      const agent = registry.get("agent-alive");
      expect(agent!.state).toBe("error");
      expect(agent!.error).toContain("disappeared");
    });

    it("picks up new state files created by other processes", async () => {
      const surfaceProvider = async () => [makeSurface("surface:new")];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();
      expect(registry.list()).toHaveLength(0);

      // Another process writes a new agent state
      stateMgr.writeState(
        makeRecord({
          agent_id: "new-agent",
          surface_id: "surface:new",
          state: "ready",
        }),
      );

      await registry.reconcile();
      expect(registry.list()).toHaveLength(1);
      expect(registry.get("new-agent")!.state).toBe("ready");
    });
  });
});
