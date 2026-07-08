import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord, AgentState } from "../src/agent-types.js";
import type { DiscoveredAgent } from "../src/agent-discovery.js";
import type { SeatRegistry } from "../src/seat-identity.js";
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

function makeDiscovered(
  overrides: Partial<DiscoveredAgent>,
): DiscoveredAgent {
  return {
    surface_id: "surface:live",
    surface_title: "cmuxlayerClaude",
    workspace_id: "workspace:1",
    cli: "claude",
    parsed_status: "working",
    model: "Sonnet 4.6",
    token_count: null,
    context_pct: null,
    has_agent: true,
    read_error: false,
    ...overrides,
  };
}

const REPAIR_SEATS: SeatRegistry = {
  driverBuddy: {
    repo: "driverBuddy",
    launchers: {
      claude: "driverBuddyClaude",
    },
    lane: "driverBuddy",
    role: "lead",
  },
  cmuxlayerLead: {
    repo: "cmuxlayer",
    launchers: {
      claude: "cmuxlayerClaude",
    },
    lane: "cmuxlayer",
    role: "lead",
  },
};

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

      // Non-empty surface enumeration proves surface:99 is gone.
      const surfaceProvider = async () => [makeSurface("surface:live")];
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

      const surfaceProvider = async () => [makeSurface("surface:live")];
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
      const surfaceProvider = async () => [makeSurface("surface:live")];
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
      surfaces = [makeSurface("surface:2")];
      await registry.reconcile();

      const agent = registry.get("agent-alive");
      expect(agent!.state).toBe("error");
      expect(agent!.error).toContain("disappeared");
    });

    it("does not mark agents disappeared when surface enumeration fails", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-live",
          surface_id: "surface:1",
          state: "working",
        }),
      );

      let shouldThrow = false;
      const surfaceProvider = async () => {
        if (shouldThrow) {
          throw new Error("socket unavailable");
        }
        return [makeSurface("surface:1")];
      };
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      shouldThrow = true;
      await registry.reconcile();

      const agent = registry.get("agent-live");
      expect(agent!.state).toBe("working");
      expect(agent!.error).toBeNull();
    });

    it("does not mark live agents disappeared when surface enumeration is empty", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-live-empty-scan",
          surface_id: "surface:1",
          state: "working",
        }),
      );

      let surfaces = [makeSurface("surface:1")];
      const surfaceProvider = async () => surfaces;
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      surfaces = [];
      await registry.reconcile();

      const agent = registry.get("agent-live-empty-scan");
      expect(agent!.state).toBe("working");
      expect(agent!.error).toBeNull();
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

    it("does not evict auto agents for plain substring-matching errors", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-claude-surface-42",
          surface_id: "surface:42",
          repo: "stale-repo",
          model: "old-model",
          cli: "claude",
        }),
      );

      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:42"),
      ]);
      await registry.reconstitute();

      const removeStateSpy = vi.spyOn(stateMgr, "removeState");
      vi.spyOn(stateMgr, "updateRecord").mockImplementation(() => {
        throw new Error("Agent not found: auto-claude-surface-42");
      });

      const discovery = {
        scan: vi.fn().mockResolvedValue([
          {
            surface_id: "surface:42",
            surface_title: "brainlayerClaude",
            cli: "claude",
            parsed_status: "working",
            model: "Sonnet 4.6",
            token_count: null,
            context_pct: null,
            has_agent: true,
            read_error: false,
          },
        ]),
      };

      await expect(registry.listMerged(discovery as any)).rejects.toThrow(
        "Agent not found: auto-claude-surface-42",
      );
      expect(removeStateSpy).not.toHaveBeenCalled();
    });

    it("does not clear managed workspace_id when discovery omits workspace metadata", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "managed-codex",
          surface_id: "surface:42",
          workspace_id: "workspace:known",
        }),
      );

      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:42"),
      ]);
      await registry.reconstitute();

      const discovery = {
        scan: vi.fn().mockResolvedValue([
          {
            surface_id: "surface:42",
            surface_title: "brainlayerCodex",
            cli: "codex",
            parsed_status: "working",
            model: "gpt-5.5",
            token_count: null,
            context_pct: null,
            has_agent: true,
            read_error: false,
          },
        ]),
      };

      await registry.listMerged(discovery as any);

      expect(stateMgr.readState("managed-codex")?.workspace_id).toBe(
        "workspace:known",
      );
      expect(registry.get("managed-codex")?.workspace_id).toBe(
        "workspace:known",
      );
    });

    it("does not clear managed workspace_id when discovery reports null workspace metadata", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "managed-codex-null",
          surface_id: "surface:42",
          workspace_id: "workspace:known",
        }),
      );

      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:42"),
      ]);
      await registry.reconstitute();

      const discovery = {
        scan: vi.fn().mockResolvedValue([
          {
            surface_id: "surface:42",
            surface_title: "brainlayerCodex",
            cli: "codex",
            parsed_status: "working",
            model: "gpt-5.5",
            token_count: null,
            context_pct: null,
            has_agent: true,
            read_error: false,
            workspace_id: null,
          },
        ]),
      };

      await registry.listMerged(discovery as any);

      expect(stateMgr.readState("managed-codex-null")?.workspace_id).toBe(
        "workspace:known",
      );
      expect(registry.get("managed-codex-null")?.workspace_id).toBe(
        "workspace:known",
      );
    });
  });

  describe("repairFromDiscovery", () => {
    it("repairs no-suffix auto-discovered panes from parsed cli and title repo evidence", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-claude-surface-32",
          surface_id: "surface:32",
          workspace_id: "workspace:1",
          repo: "driverBuddy",
          cli: "claude",
          role: "orchestrator",
          task_summary: "(auto-discovered)",
        }),
      );

      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:32"),
      ]);
      await registry.reconstitute();

      const result = registry.repairFromDiscovery(
        [
          makeDiscovered({
            surface_id: "surface:32",
            surface_title: "🤝 driverBuddy",
            cli: "claude",
          }),
        ],
        { seatRegistry: REPAIR_SEATS },
      );

      expect(result.repaired).toEqual([
        expect.objectContaining({
          surface_id: "surface:32",
          agent_id: "driverBuddy",
          repo: "driverBuddy",
          cli: "claude",
          launcher_name: "driverBuddyClaude",
          seat_id: "driverBuddy",
          action: "created",
        }),
      ]);
      expect(result.evicted).toEqual(["auto-claude-surface-32"]);
      expect(stateMgr.readState("auto-claude-surface-32")).toBeNull();
      expect(stateMgr.readState("driverBuddy")).toMatchObject({
        agent_id: "driverBuddy",
        surface_id: "surface:32",
        repo: "driverBuddy",
        cli: "claude",
        launcher_name: "driverBuddyClaude",
        seat_id: "driverBuddy",
        seat_lane: "driverBuddy",
        seat_role: "lead",
        role: "orchestrator",
      });
    });

    it("keeps duplicate launcher-title surfaces on one canonical repaired registration", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-claude-surface-35",
          surface_id: "surface:35",
          workspace_id: "workspace:1",
          repo: "cmuxlayer",
          cli: "claude",
          task_summary: "(auto-discovered)",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-claude-surface-121",
          surface_id: "surface:121",
          workspace_id: "workspace:1",
          repo: "cmuxlayer",
          cli: "claude",
          task_summary: "(auto-discovered)",
        }),
      );

      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:35"),
        makeSurface("surface:121"),
      ]);
      await registry.reconstitute();

      const result = registry.repairFromDiscovery(
        [
          makeDiscovered({
            surface_id: "surface:35",
            surface_title: "cmuxlayerClaude",
          }),
          makeDiscovered({
            surface_id: "surface:121",
            surface_title: "cmuxlayerClaude",
          }),
        ],
        { seatRegistry: REPAIR_SEATS },
      );

      expect(result.repaired).toEqual([
        expect.objectContaining({
          surface_id: "surface:35",
          agent_id: "cmuxlayerLead",
          action: "created",
        }),
      ]);
      expect(result.evicted).toEqual(
        expect.arrayContaining([
          "auto-claude-surface-35",
          "auto-claude-surface-121",
        ]),
      );
      expect(stateMgr.readState("cmuxlayerLead")).toMatchObject({
        agent_id: "cmuxlayerLead",
        surface_id: "surface:35",
        seat_id: "cmuxlayerLead",
      });
      expect(stateMgr.readState("cmuxlayerLead-surface-121")).toBeNull();
    });

    it("self-heals a suppressed duplicate surface when the canonical surface closes", async () => {
      const surfaceA = "surface:35";
      const surfaceB = "surface:121";
      const duplicateDiscoveries = [
        makeDiscovered({
          surface_id: surfaceA,
          surface_title: "cmuxlayerClaude",
        }),
        makeDiscovered({
          surface_id: surfaceB,
          surface_title: "cmuxlayerClaude",
        }),
      ];
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-claude-surface-35",
          surface_id: surfaceA,
          workspace_id: "workspace:1",
          repo: "cmuxlayer",
          cli: "claude",
          task_summary: "(auto-discovered)",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-claude-surface-121",
          surface_id: surfaceB,
          workspace_id: "workspace:1",
          repo: "cmuxlayer",
          cli: "claude",
          task_summary: "(auto-discovered)",
        }),
      );

      let surfaces = [makeSurface(surfaceA), makeSurface(surfaceB)];
      const registry = new AgentRegistry(stateMgr, async () => surfaces);
      await registry.reconstitute();
      registry.repairFromDiscovery(duplicateDiscoveries, {
        seatRegistry: REPAIR_SEATS,
      });

      surfaces = [makeSurface(surfaceB)];
      const merged = await registry.listMerged({
        scan: vi.fn().mockResolvedValue([
          makeDiscovered({
            surface_id: surfaceB,
            surface_title: "cmuxlayerClaude",
          }),
        ]),
      } as any);

      expect(merged.map((record) => record.agent_id)).toEqual([
        "cmuxlayerLead",
      ]);
      expect(merged[0]).toMatchObject({
        agent_id: "cmuxlayerLead",
        surface_id: surfaceB,
        state: "working",
        error: null,
        launcher_name: "cmuxlayerClaude",
      });
      expect(stateMgr.readState("cmuxlayerLead")).toMatchObject({
        agent_id: "cmuxlayerLead",
        surface_id: surfaceB,
        state: "working",
        error: null,
      });
      expect(stateMgr.readState("auto-claude-surface-121")).toBeNull();
    });

    it("deduplicates M1 mimir pending ghosts to one row per launcher seat", async () => {
      const discovered = [
        makeDiscovered({
          surface_id: "surface:101",
          surface_title: "mimir",
          cli: "claude",
        }),
        makeDiscovered({
          surface_id: "surface:102",
          surface_title: "mimir",
          cli: "claude",
        }),
        makeDiscovered({
          surface_id: "surface:103",
          surface_title: "mimir",
          cli: "claude",
        }),
        makeDiscovered({
          surface_id: "surface:201",
          surface_title: "mimir",
          cli: "codex",
          model: "gpt-5.5",
        }),
        makeDiscovered({
          surface_id: "surface:202",
          surface_title: "mimir",
          cli: "codex",
          model: "gpt-5.5",
        }),
      ];
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-claude-surface-101",
          surface_id: "surface:101",
          repo: "mimir",
          cli: "claude",
          task_summary: "(auto-discovered)",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-claude-surface-102",
          surface_id: "surface:102",
          repo: "mimir",
          cli: "claude",
          task_summary: "(auto-discovered)",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "mimirClaude-pending-1710000000-abcd",
          surface_id: "surface:103",
          repo: "mimir",
          cli: "claude",
          launcher_name: "mimirClaude",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "mimirCodex-pending-1710000000-cafe",
          surface_id: "surface:201",
          repo: "mimir",
          cli: "codex",
          launcher_name: "mimirCodex",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "mimirCodex-pending-1710000000-dead",
          surface_id: "surface:202",
          repo: "mimir",
          cli: "codex",
          launcher_name: "mimirCodex",
        }),
      );

      const registry = new AgentRegistry(
        stateMgr,
        async () => discovered.map((entry) => makeSurface(entry.surface_id)),
      );
      await registry.reconstitute();

      const result = registry.repairFromDiscovery(discovered);

      expect(result.repaired).toEqual([
        expect.objectContaining({
          surface_id: "surface:101",
          agent_id: "mimirClaude",
          launcher_name: "mimirClaude",
          action: "created",
        }),
        expect.objectContaining({
          surface_id: "surface:201",
          agent_id: "mimirCodex",
          launcher_name: "mimirCodex",
          action: "created",
        }),
      ]);
      expect(result.evicted).toEqual(
        expect.arrayContaining([
          "auto-claude-surface-101",
          "auto-claude-surface-102",
          "mimirClaude-pending-1710000000-abcd",
          "mimirCodex-pending-1710000000-cafe",
          "mimirCodex-pending-1710000000-dead",
        ]),
      );

      const liveRows = registry
        .list()
        .map((record) => record.agent_id)
        .sort();
      expect(liveRows).toEqual(["mimirClaude", "mimirCodex"]);
      expect(stateMgr.readState("mimirClaude")).toMatchObject({
        agent_id: "mimirClaude",
        surface_id: "surface:101",
        repo: "mimir",
        cli: "claude",
        role: "orchestrator",
      });
      expect(stateMgr.readState("mimirCodex")).toMatchObject({
        agent_id: "mimirCodex",
        surface_id: "surface:201",
        repo: "mimir",
        cli: "codex",
        role: "worker",
      });
      expect(
        stateMgr
          .listStates()
          .filter(
            (record) =>
              record.agent_id.startsWith("auto-") ||
              record.agent_id.includes("-pending-"),
          ),
      ).toEqual([]);

      const merged = await registry.listMerged({
        scan: vi.fn().mockResolvedValue(discovered),
      } as any);
      expect(merged.map((record) => record.agent_id).sort()).toEqual([
        "mimirClaude",
        "mimirCodex",
      ]);
    });
  });

  describe("hasLiveSurface", () => {
    it("treats empty surface enumeration as inconclusive", async () => {
      const registry = new AgentRegistry(
        stateMgr,
        async () => [] as CmuxSurface[],
      );

      await expect(registry.hasLiveSurface("surface:maybe-live")).resolves.toBe(
        true,
      );
    });

    it("treats surface enumeration failures as inconclusive", async () => {
      const registry = new AgentRegistry(stateMgr, async () => {
        throw new Error("socket unavailable");
      });

      await expect(registry.hasLiveSurface("surface:maybe-live")).resolves.toBe(
        true,
      );
    });

    it("returns false only when a non-empty topology lacks the surface", async () => {
      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:other"),
      ]);

      await expect(registry.hasLiveSurface("surface:missing")).resolves.toBe(
        false,
      );
    });
  });

  describe("purgeTerminal", () => {
    it("does not purge terminal workers when surface enumeration is empty", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "terminal-worker-empty-scan",
          state: "done",
          surface_id: "surface:maybe-live",
          role: "worker",
        }),
      );

      const surfaceProvider = async () => [] as CmuxSurface[];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const purged = await registry.purgeTerminal();

      expect(purged).toBe(0);
      expect(registry.get("terminal-worker-empty-scan")).toMatchObject({
        agent_id: "terminal-worker-empty-scan",
        state: "done",
      });
    });

    it("keeps absent terminal lead roles while purging absent terminal workers", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "orchestrator-terminal",
          state: "done",
          surface_id: "surface:missing-orchestrator",
          role: "orchestrator",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "ic-terminal",
          state: "error",
          surface_id: "surface:missing-ic",
          role: "ic",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "worker-terminal",
          state: "done",
          surface_id: "surface:missing-worker",
          role: "worker",
        }),
      );

      const surfaceProvider = async () => [makeSurface("surface:live")];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const purged = await registry.purgeTerminal();

      expect(purged).toBe(1);
      expect(registry.get("orchestrator-terminal")).toMatchObject({
        agent_id: "orchestrator-terminal",
        role: "orchestrator",
      });
      expect(registry.get("ic-terminal")).toMatchObject({
        agent_id: "ic-terminal",
        role: "ic",
      });
      expect(registry.get("worker-terminal")).toBeNull();
    });

    it("purges crash_recover errors that are no longer recoverable", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "stale-recovery-error",
          state: "error",
          surface_id: "surface:gone",
          crash_recover: true,
          cli_session_id: null,
          error: "Crash recovery failed: missing session id",
        }),
      );

      const surfaceProvider = async () => [makeSurface("surface:live")];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();

      const purged = await registry.purgeTerminal();

      expect(purged).toBe(1);
      expect(registry.get("stale-recovery-error")).toBeNull();
    });

    it("clears aliases that point at purged finalized agents", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-pending",
          state: "done",
          surface_id: "surface:gone",
        }),
      );

      const surfaceProvider = async () => [makeSurface("surface:live")];
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      await registry.reconstitute();
      const renamed = stateMgr.renameState("agent-pending", "agent-final");
      registry.rename("agent-pending", "agent-final", renamed);

      const purged = await registry.purgeTerminal();
      registry.set(
        "agent-pending",
        makeRecord({
          agent_id: "agent-pending",
          state: "working",
          surface_id: "surface:new",
        }),
      );

      expect(purged).toBe(1);
      expect(registry.get("agent-pending")).toMatchObject({
        agent_id: "agent-pending",
        surface_id: "surface:new",
      });
    });
  });
});
