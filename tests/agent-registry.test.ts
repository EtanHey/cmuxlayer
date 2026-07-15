import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentRegistry,
  deriveSurfaceObserverId,
} from "../src/agent-registry.js";
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
    vi.useRealTimers();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("fails closed when the observer socket path is not a live socket node", () => {
    expect(
      deriveSurfaceObserverId(
        { currentSocketPath: () => join(TEST_DIR, "definitely-missing.sock") },
        null,
      ),
    ).toBeNull();
    expect(deriveSurfaceObserverId({}, null)).toBeNull();
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

    it("scopes absence reconciliation to the observing cmux instance", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "prod-agent",
          surface_id: "surface:prod",
          surface_uuid: "uuid-prod",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "nightly-agent",
          surface_id: "surface:nightly",
          surface_uuid: "uuid-nightly",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "legacy-unobserved",
          surface_id: "surface:legacy",
          surface_uuid: "uuid-legacy",
        }),
      );

      let prodSurfaces: CmuxSurface[] = [
        { ...makeSurface("surface:prod"), id: "uuid-prod" },
      ];
      const nightlySurfaces: CmuxSurface[] = [
        { ...makeSurface("surface:nightly"), id: "uuid-nightly" },
      ];
      const prodRegistry = new AgentRegistry(
        stateMgr,
        async () => prodSurfaces,
        { observerId: "cmux:/tmp/prod.sock" },
      );
      const nightlyRegistry = new AgentRegistry(
        stateMgr,
        async () => nightlySurfaces,
        { observerId: "cmux:/tmp/nightly.sock" },
      );

      expect(prodRegistry.getObserverId()).toBe("cmux:/tmp/prod.sock");

      await prodRegistry.reconstitute();
      await nightlyRegistry.reconstitute();
      await prodRegistry.reconcile();

      expect(stateMgr.readState("prod-agent")).toMatchObject({
        state: "working",
        surface_observer_id: "cmux:/tmp/prod.sock",
      });
      expect(stateMgr.readState("nightly-agent")).toMatchObject({
        state: "working",
        surface_observer_id: "cmux:/tmp/nightly.sock",
      });
      expect(stateMgr.readState("legacy-unobserved")).toMatchObject({
        state: "working",
      });
      expect(stateMgr.readState("legacy-unobserved")).not.toHaveProperty(
        "surface_observer_id",
      );

      // The owning registry may still act on confirmed absence. Its sibling
      // must continue to leave both foreign and legacy-unscoped records alone.
      prodSurfaces = [makeSurface("surface:some-other-prod-tab")];
      await prodRegistry.reconcile();
      await nightlyRegistry.reconcile();

      expect(stateMgr.readState("prod-agent")).toMatchObject({
        state: "error",
        error: "Surface surface:prod disappeared",
      });
      expect(stateMgr.readState("nightly-agent")).toMatchObject({
        state: "working",
        surface_observer_id: "cmux:/tmp/nightly.sock",
      });
      expect(stateMgr.readState("legacy-unobserved")).toMatchObject({
        state: "working",
      });

      expect(nightlyRegistry.evict("prod-agent")).toBeNull();
      expect(stateMgr.readState("prod-agent")).not.toBeNull();
      await expect(
        nightlyRegistry.evictSurfaceless({ confirmationMs: 0 }),
      ).resolves.toEqual([]);
      await expect(
        prodRegistry.evictSurfaceless({ confirmationMs: 0 }),
      ).resolves.toEqual(["prod-agent"]);
      expect(stateMgr.readState("prod-agent")).toBeNull();
    });

    it("does not claim UUID ownership from an identity-free legacy observation", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "legacy-ref-only-observation",
          surface_id: "surface:shared-ref",
          surface_uuid: "uuid-not-observed",
        }),
      );
      const registry = new AgentRegistry(
        stateMgr,
        async () => [makeSurface("surface:shared-ref")],
        { observerId: "cmux:/tmp/prod.sock" },
      );

      await registry.reconstitute();

      expect(stateMgr.readState("legacy-ref-only-observation")).not.toHaveProperty(
        "surface_observer_id",
      );
    });

    it("does not let the first observer claim a ref-only legacy record", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "legacy-shared-ref",
          surface_id: "surface:shared",
          surface_uuid: null,
          workspace_id: "workspace:legacy",
        }),
      );
      const nightlyRegistry = new AgentRegistry(
        stateMgr,
        async () => [{
          ...makeSurface("surface:shared"),
          id: "uuid-nightly",
          workspace_ref: "workspace:nightly",
        }],
        { observerId: "cmux:/tmp/nightly.sock" },
      );
      const prodRegistry = new AgentRegistry(
        stateMgr,
        async () => [{
          ...makeSurface("surface:shared"),
          id: "uuid-prod",
          workspace_ref: "workspace:prod",
        }],
        { observerId: "cmux:/tmp/prod.sock" },
      );

      await nightlyRegistry.reconstitute();
      await prodRegistry.reconstitute();

      expect(stateMgr.readState("legacy-shared-ref")).toMatchObject({
        surface_id: "surface:shared",
        surface_uuid: null,
        workspace_id: "workspace:legacy",
      });
      expect(stateMgr.readState("legacy-shared-ref")).not.toHaveProperty(
        "surface_observer_id",
      );
    });

    it("migrates observer ownership only with exact UUID evidence", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "legacy-uuid-binding",
          surface_id: "surface:stale",
          surface_uuid: "uuid-prod",
          workspace_id: "workspace:legacy",
        }),
      );
      const nightlyRegistry = new AgentRegistry(
        stateMgr,
        async () => [{
          ...makeSurface("surface:stale"),
          id: "uuid-nightly",
          workspace_ref: "workspace:nightly",
        }],
        { observerId: "cmux:/tmp/nightly.sock" },
      );
      const prodRegistry = new AgentRegistry(
        stateMgr,
        async () => [{
          ...makeSurface("surface:moved"),
          id: "uuid-prod",
          workspace_ref: "workspace:prod",
        }],
        { observerId: "cmux:/tmp/prod.sock" },
      );

      await nightlyRegistry.reconstitute();
      expect(stateMgr.readState("legacy-uuid-binding")).toMatchObject({
        surface_id: "surface:stale",
        surface_uuid: "uuid-prod",
        workspace_id: "workspace:legacy",
      });

      await prodRegistry.reconstitute();
      expect(stateMgr.readState("legacy-uuid-binding")).toMatchObject({
        surface_id: "surface:moved",
        surface_uuid: "uuid-prod",
        surface_observer_id: "cmux:/tmp/prod.sock",
        workspace_id: "workspace:prod",
      });
    });

    it("treats mixed UUID coverage as inconclusive for a UUID-backed record", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "mixed-coverage-agent",
          surface_id: "surface:mixed-target",
          surface_uuid: "uuid-mixed-target",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:mixed-target"),
        { ...makeSurface("surface:identified-neighbor"), id: "uuid-neighbor" },
      ]);

      await registry.reconstitute({ confirmationMs: 0 });

      expect(stateMgr.readState("mixed-coverage-agent")).toMatchObject({
        state: "working",
        surface_id: "surface:mixed-target",
        surface_uuid: "uuid-mixed-target",
      });
      await expect(
        registry.evictSurfaceless({ confirmationMs: 0 }),
      ).resolves.toEqual([]);
      expect(stateMgr.readState("mixed-coverage-agent")).not.toBeNull();
    });

    it("does not mark an owned UUID-less row absent from mixed identity coverage", async () => {
      const agentId = "mixed-coverage-legacy-reconcile";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: "surface:legacy-target",
          surface_uuid: null,
          surface_observer_id: "cmux:/tmp/prod.sock",
          state: "working",
        }),
      );
      const registry = new AgentRegistry(
        stateMgr,
        async () => [
          makeSurface("surface:ref-only-witness"),
          {
            ...makeSurface("surface:identified-neighbor"),
            id: "11111111-2222-4333-8444-555555555555",
          },
        ],
        { observerId: "cmux:/tmp/prod.sock" },
      );

      await registry.reconstitute({ confirmationMs: 0 });

      expect(stateMgr.readState(agentId)).toMatchObject({
        state: "working",
        surface_id: "surface:legacy-target",
        surface_uuid: null,
      });
    });

    it("does not evict an owned UUID-less row from mixed identity coverage", async () => {
      const agentId = "mixed-coverage-legacy-evict";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: "surface:legacy-target",
          surface_uuid: null,
          surface_observer_id: "cmux:/tmp/prod.sock",
          state: "working",
        }),
      );
      let surfaces: CmuxSurface[] = [makeSurface("surface:legacy-target")];
      const registry = new AgentRegistry(stateMgr, async () => surfaces, {
        observerId: "cmux:/tmp/prod.sock",
      });
      await registry.reconstitute();
      surfaces = [
        makeSurface("surface:ref-only-witness"),
        {
          ...makeSurface("surface:identified-neighbor"),
          id: "11111111-2222-4333-8444-555555555555",
        },
      ];

      await expect(
        registry.evictSurfaceless({ confirmationMs: 0 }),
      ).resolves.toEqual([]);
      expect(stateMgr.readState(agentId)).not.toBeNull();
    });

    it("does not purge an owned UUID-less terminal row from mixed identity coverage", async () => {
      const agentId = "mixed-coverage-legacy-purge";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: "surface:legacy-target",
          surface_uuid: null,
          surface_observer_id: "cmux:/tmp/prod.sock",
          state: "done",
          role: "worker",
        }),
      );
      let surfaces: CmuxSurface[] = [makeSurface("surface:legacy-target")];
      const registry = new AgentRegistry(stateMgr, async () => surfaces, {
        observerId: "cmux:/tmp/prod.sock",
      });
      await registry.reconstitute();
      surfaces = [
        makeSurface("surface:ref-only-witness"),
        {
          ...makeSurface("surface:identified-neighbor"),
          id: "11111111-2222-4333-8444-555555555555",
        },
      ];

      await expect(
        registry.purgeTerminal({ confirmationMs: 0 }),
      ).resolves.toBe(0);
      expect(stateMgr.readState(agentId)).not.toBeNull();
    });

    it("resets UUID-less absence confirmation after mixed identity coverage", async () => {
      const agentId = "mixed-coverage-legacy-reset";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: "surface:legacy-target",
          surface_uuid: null,
          surface_observer_id: "cmux:/tmp/prod.sock",
          state: "working",
        }),
      );
      let surfaces: CmuxSurface[] = [makeSurface("surface:legacy-target")];
      const registry = new AgentRegistry(stateMgr, async () => surfaces, {
        observerId: "cmux:/tmp/prod.sock",
      });
      await registry.reconstitute();

      surfaces = [makeSurface("surface:all-ref-witness")];
      await registry.reconcile({ confirmationMs: 5_000, now: 0 });
      surfaces = [
        makeSurface("surface:ref-only-witness"),
        {
          ...makeSurface("surface:identified-neighbor"),
          id: "11111111-2222-4333-8444-555555555555",
        },
      ];
      await registry.reconcile({ confirmationMs: 5_000, now: 6_000 });
      expect(stateMgr.readState(agentId)?.state).toBe("working");

      surfaces = [makeSurface("surface:all-ref-witness")];
      await registry.reconcile({ confirmationMs: 5_000, now: 6_000 });
      expect(stateMgr.readState(agentId)?.state).toBe("working");
      await registry.reconcile({ confirmationMs: 5_000, now: 11_001 });
      expect(stateMgr.readState(agentId)?.state).toBe("error");
    });

    it("owns a newly discovered UUID-backed auto record in the observing instance", async () => {
      const surfaceUuid = "11111111-2222-4333-8444-555555555555";
      const discovered = makeDiscovered({
        surface_id: "surface:auto-owned",
        surface_uuid: surfaceUuid,
        surface_title: "brainlayerCodex",
        cli: "codex",
      });
      const registry = new AgentRegistry(
        stateMgr,
        async () => [
          { ...makeSurface("surface:auto-owned"), id: surfaceUuid },
        ],
        { observerId: "cmux:/tmp/prod.sock" },
      );
      await registry.reconstitute();

      await registry.listMerged({
        scan: vi.fn().mockResolvedValue([discovered]),
      } as any);

      expect(
        stateMgr
          .listStates()
          .find((record) => record.surface_uuid === surfaceUuid),
      ).toMatchObject({
        surface_observer_id: "cmux:/tmp/prod.sock",
      });
    });

    it("owns a newly discovered ref-only auto record in the observing instance", async () => {
      const discovered = makeDiscovered({
        surface_id: "surface:auto-ref-only",
        surface_uuid: null,
        surface_title: "brainlayerCodex",
        cli: "codex",
      });
      const registry = new AgentRegistry(
        stateMgr,
        async () => [makeSurface("surface:auto-ref-only")],
        { observerId: "cmux:/tmp/prod.sock" },
      );
      await registry.reconstitute();

      await registry.listMerged({
        scan: vi.fn().mockResolvedValue([discovered]),
      } as any);

      expect(
        stateMgr
          .listStates()
          .find((record) => record.surface_id === "surface:auto-ref-only"),
      ).toMatchObject({
        surface_uuid: null,
        surface_observer_id: "cmux:/tmp/prod.sock",
      });
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
    it("rebinds the mutable ref by stable UUID instead of reading a recycled ref", async () => {
      const surfaceUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
      stateMgr.writeState(
        makeRecord({
          agent_id: "uuid-bound-agent",
          surface_id: "surface:594",
          surface_uuid: surfaceUuid,
          state: "working",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => [
        { ...makeSurface("surface:595"), id: surfaceUuid },
        {
          ...makeSurface("surface:594"),
          id: "033F0B64-780F-4F0B-BCF1-3B8E085A7383",
        },
      ]);

      await registry.reconstitute();

      expect(registry.get("uuid-bound-agent")).toMatchObject({
        state: "working",
        surface_id: "surface:595",
        surface_uuid: surfaceUuid,
      });
    });

    it("does not backfill a UUID-less owned row by mutable ref in UUID topology", async () => {
      const agentId = "owned-legacy-no-uuid-adoption";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: "surface:shared",
          surface_uuid: null,
          surface_observer_id: "cmux:/tmp/prod.sock",
          workspace_id: "workspace:persisted",
        }),
      );
      const registry = new AgentRegistry(
        stateMgr,
        async () => [
          {
            ...makeSurface("surface:shared"),
            id: "11111111-2222-4333-8444-555555555555",
            workspace_ref: "workspace:observed",
          },
        ],
        { observerId: "cmux:/tmp/prod.sock" },
      );

      await registry.reconstitute({ confirmationMs: 0 });

      expect(stateMgr.readState(agentId)).toMatchObject({
        state: "working",
        surface_id: "surface:shared",
        surface_uuid: null,
        surface_observer_id: "cmux:/tmp/prod.sock",
        workspace_id: "workspace:persisted",
      });
    });

    it("pins the observer epoch across asynchronous surface reconciliation", async () => {
      let observerId = "cmux:/tmp/primary.sock";
      const agentId = "observer-epoch-reconcile";
      const surfaceUuid = "11111111-2222-4333-8444-555555555555";
      const record = makeRecord({
        agent_id: agentId,
        surface_id: "surface:old",
        surface_uuid: surfaceUuid,
        surface_observer_id: observerId,
        workspace_id: "workspace:old",
      });
      stateMgr.writeState(record);
      const registry = new AgentRegistry(
        stateMgr,
        async () => {
          queueMicrotask(() => {
            observerId = "cmux:/tmp/replacement.sock";
          });
          return [
            {
              ...makeSurface("surface:new"),
              id: surfaceUuid,
              workspace_ref: "workspace:new",
            },
          ];
        },
        { observerIdProvider: () => observerId },
      );
      registry.set(record.agent_id, record);

      await registry.reconcile({ confirmationMs: 0 });

      expect(observerId).toBe("cmux:/tmp/replacement.sock");
      expect(stateMgr.readState(agentId)).toMatchObject({
        surface_id: "surface:old",
        surface_uuid: surfaceUuid,
        surface_observer_id: "cmux:/tmp/primary.sock",
        workspace_id: "workspace:old",
      });
    });

    it("rejects reconciliation when transient epoch changes under one owner", async () => {
      const ownerId = "cmux:/tmp/stable.sock#1:2:3:4";
      let observerEpoch = `${ownerId}@route:1`;
      const agentId = "observer-transient-epoch-reconcile";
      const surfaceUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
      const record = makeRecord({
        agent_id: agentId,
        surface_id: "surface:old",
        surface_uuid: surfaceUuid,
        surface_observer_id: ownerId,
        workspace_id: "workspace:old",
      });
      stateMgr.writeState(record);
      const registry = new AgentRegistry(
        stateMgr,
        async () => {
          queueMicrotask(() => {
            observerEpoch = `${ownerId}@route:2`;
          });
          return [
            {
              ...makeSurface("surface:new"),
              id: surfaceUuid,
              workspace_ref: "workspace:new",
            },
          ];
        },
        {
          observerIdProvider: () => ownerId,
          observerEpochProvider: () => observerEpoch,
        },
      );
      registry.set(record.agent_id, record);

      await registry.reconcile({ confirmationMs: 0 });

      expect(observerEpoch).toBe(`${ownerId}@route:2`);
      expect(stateMgr.readState(agentId)).toMatchObject({
        surface_id: "surface:old",
        surface_observer_id: ownerId,
        workspace_id: "workspace:old",
      });
    });

    it("treats one UUID on two refs as inconclusive for both match and absence", async () => {
      const duplicateUuid = "11111111-2222-4333-8444-555555555555";
      stateMgr.writeState(
        makeRecord({
          agent_id: "ambiguous-positive",
          surface_id: "surface:old",
          surface_uuid: duplicateUuid,
          workspace_id: "workspace:old",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "ambiguous-absence",
          surface_id: "surface:absent",
          surface_uuid: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => [
        {
          ...makeSurface("surface:first"),
          id: duplicateUuid,
          workspace_ref: "workspace:first",
        },
        {
          ...makeSurface("surface:second"),
          id: duplicateUuid,
          workspace_ref: "workspace:second",
        },
      ]);

      await registry.reconstitute({ confirmationMs: 0 });

      expect(registry.get("ambiguous-positive")).toMatchObject({
        state: "working",
        surface_id: "surface:old",
        surface_uuid: duplicateUuid,
        workspace_id: "workspace:old",
      });
      expect(registry.get("ambiguous-absence")).toMatchObject({
        state: "working",
        surface_id: "surface:absent",
      });
      await expect(
        registry.evictSurfaceless({ confirmationMs: 0 }),
      ).resolves.toEqual([]);
    });

    it("treats one ref with two UUIDs as inconclusive for both match and absence", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "ambiguous-legacy-positive",
          surface_id: "surface:shared",
          surface_uuid: null,
          workspace_id: "workspace:old",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "ambiguous-uuid-absence",
          surface_id: "surface:absent",
          surface_uuid: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => [
        {
          ...makeSurface("surface:shared"),
          id: "11111111-2222-4333-8444-555555555555",
          workspace_ref: "workspace:first",
        },
        {
          ...makeSurface("surface:shared"),
          id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
          workspace_ref: "workspace:second",
        },
      ]);

      await registry.reconstitute({ confirmationMs: 0 });

      expect(registry.get("ambiguous-legacy-positive")).toMatchObject({
        state: "working",
        surface_id: "surface:shared",
        surface_uuid: null,
        workspace_id: "workspace:old",
      });
      expect(registry.get("ambiguous-uuid-absence")).toMatchObject({
        state: "working",
        surface_id: "surface:absent",
      });
      await expect(
        registry.evictSurfaceless({ confirmationMs: 0 }),
      ).resolves.toEqual([]);
    });

    it("requires the confirmation window before a non-empty partial scan becomes disappearance", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "transient-partial-agent",
          surface_id: "surface:42",
          state: "working",
        }),
      );
      let surfaces = [makeSurface("surface:42")];
      const registry = new AgentRegistry(stateMgr, async () => surfaces);
      await registry.reconstitute();

      surfaces = [makeSurface("surface:other")];
      await registry.reconcile({ confirmationMs: 5_000, now: 1_000 });
      expect(registry.get("transient-partial-agent")?.state).toBe("working");

      await registry.reconcile({ confirmationMs: 5_000, now: 6_001 });
      expect(registry.get("transient-partial-agent")).toMatchObject({
        state: "error",
        error: "Surface surface:42 disappeared",
      });
    });

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

    it("does not let listMerged purge a worker on its first partial omission", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-14T05:00:00.000Z"));
      stateMgr.writeState(
        makeRecord({
          agent_id: "list-worker-transient-gap",
          surface_id: "surface:maybe-live",
          state: "working",
          role: "worker",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:other"),
      ]);
      await registry.reconstitute();
      const discovery = { scan: vi.fn().mockResolvedValue([]) };

      await registry.listMerged(discovery as any);

      expect(registry.get("list-worker-transient-gap")).toMatchObject({
        state: "error",
        error: "Surface surface:maybe-live disappeared",
      });

      await vi.advanceTimersByTimeAsync(5_001);
      await registry.listMerged(discovery as any);

      expect(registry.get("list-worker-transient-gap")).toBeNull();
    });

    it("does not evict an owned UUID-less booting row from mixed discovery identity coverage", async () => {
      const agentId = "mixed-discovery-legacy-booting";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: "surface:legacy-target",
          surface_uuid: null,
          surface_observer_id: "cmux:/tmp/prod.sock",
          state: "booting",
        }),
      );
      const registry = new AgentRegistry(
        stateMgr,
        async () => [makeSurface("surface:legacy-target")],
        { observerId: "cmux:/tmp/prod.sock" },
      );
      await registry.reconstitute();
      const discovery = {
        scan: vi.fn().mockResolvedValue([
          makeDiscovered({
            surface_id: "surface:legacy-target",
            surface_uuid: null,
            has_agent: false,
          }),
          makeDiscovered({
            surface_id: "surface:identified-neighbor",
            surface_uuid: "11111111-2222-4333-8444-555555555555",
            has_agent: false,
          }),
        ]),
      };

      const merged = await registry.listMerged(discovery as any);

      expect(stateMgr.readState(agentId)).toMatchObject({
        state: "booting",
        surface_id: "surface:legacy-target",
        surface_uuid: null,
      });
      expect(merged).toEqual(
        expect.arrayContaining([expect.objectContaining({ agent_id: agentId })]),
      );
    });

    it("does not evict an owned UUID-less auto row from mixed discovery identity coverage", async () => {
      const agentId = "auto-codex-mixed-discovery-legacy";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: "surface:legacy-target",
          surface_uuid: null,
          surface_observer_id: "cmux:/tmp/prod.sock",
          state: "working",
        }),
      );
      const registry = new AgentRegistry(
        stateMgr,
        async () => [makeSurface("surface:legacy-target")],
        { observerId: "cmux:/tmp/prod.sock" },
      );
      await registry.reconstitute();
      const discovery = {
        scan: vi.fn().mockResolvedValue([
          makeDiscovered({
            surface_id: "surface:legacy-target",
            surface_uuid: null,
            has_agent: false,
          }),
          makeDiscovered({
            surface_id: "surface:identified-neighbor",
            surface_uuid: "11111111-2222-4333-8444-555555555555",
            has_agent: false,
          }),
        ]),
      };

      const merged = await registry.listMerged(discovery as any);

      expect(stateMgr.readState(agentId)).toMatchObject({
        state: "working",
        surface_id: "surface:legacy-target",
        surface_uuid: null,
      });
      expect(merged).toEqual(
        expect.arrayContaining([expect.objectContaining({ agent_id: agentId })]),
      );
    });

    it.each([
      {
        label: "booting",
        agentId: "legacy-all-ref-booting",
        state: "booting" as const,
      },
      {
        label: "auto",
        agentId: "auto-codex-legacy-all-ref",
        state: "working" as const,
      },
    ])(
      "still evicts an owned UUID-less $label row from homogeneous all-ref discovery",
      async ({ agentId, state }) => {
        stateMgr.writeState(
          makeRecord({
            agent_id: agentId,
            surface_id: "surface:legacy-target",
            surface_uuid: null,
            surface_observer_id: "cmux:/tmp/prod.sock",
            state,
          }),
        );
        const registry = new AgentRegistry(
          stateMgr,
          async () => [makeSurface("surface:legacy-target")],
          { observerId: "cmux:/tmp/prod.sock" },
        );
        await registry.reconstitute();

        await registry.listMerged({
          scan: vi.fn().mockResolvedValue([
            makeDiscovered({
              surface_id: "surface:legacy-target",
              surface_uuid: null,
              has_agent: false,
            }),
          ]),
        } as any);

        expect(stateMgr.readState(agentId)).toBeNull();
        expect(registry.get(agentId)).toBeNull();
      },
    );

    it("resets UUID-less absence confirmation after mixed discovery identity coverage", async () => {
      const agentId = "mixed-discovery-legacy-reset";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: "surface:legacy-target",
          surface_uuid: null,
          surface_observer_id: "cmux:/tmp/prod.sock",
          state: "working",
        }),
      );
      let surfaces: CmuxSurface[] = [makeSurface("surface:legacy-target")];
      const registry = new AgentRegistry(stateMgr, async () => surfaces, {
        observerId: "cmux:/tmp/prod.sock",
      });
      await registry.reconstitute();

      surfaces = [makeSurface("surface:all-ref-witness")];
      await registry.reconcile({ confirmationMs: 5_000, now: 0 });
      await registry.listMerged({ scan: vi.fn() } as any, {
        nonDestructive: true,
        discovered: [
          makeDiscovered({
            surface_id: "surface:ref-only-witness",
            surface_uuid: null,
          }),
          makeDiscovered({
            surface_id: "surface:identified-neighbor",
            surface_uuid: "11111111-2222-4333-8444-555555555555",
          }),
        ],
      });

      await registry.reconcile({ confirmationMs: 5_000, now: 6_000 });
      expect(stateMgr.readState(agentId)?.state).toBe("working");
      await registry.reconcile({ confirmationMs: 5_000, now: 11_001 });
      expect(stateMgr.readState(agentId)?.state).toBe("error");
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

    it("does not backfill a managed UUID-less row from UUID discovery by ref", async () => {
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
            surface_uuid: "11111111-2222-4333-8444-555555555555",
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
      expect(
        stateMgr.readState("managed-codex")?.surface_uuid ?? null,
      ).toBeNull();
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

    it("pins observer epoch across discovery-backed registry metadata sync", async () => {
      const ownerId = "cmux:/tmp/stable.sock#socket=1:2:3:4";
      let observerEpoch = `${ownerId}@route:1`;
      const surfaceUuid = "11111111-2222-4333-8444-555555555555";
      const record = makeRecord({
        agent_id: "managed-discovery-epoch-race",
        surface_id: "surface:old",
        surface_uuid: surfaceUuid,
        surface_observer_id: ownerId,
        workspace_id: "workspace:old",
      });
      stateMgr.writeState(record);
      const registry = new AgentRegistry(stateMgr, async () => [], {
        observerIdProvider: () => ownerId,
        observerEpochProvider: () => observerEpoch,
      });
      registry.set(record.agent_id, record);
      const discovery = {
        scan: vi.fn().mockImplementation(async () => {
          queueMicrotask(() => {
            observerEpoch = `${ownerId}@route:2`;
          });
          return [
            makeDiscovered({
              surface_id: "surface:new",
              surface_uuid: surfaceUuid,
              workspace_id: "workspace:new",
            }),
          ];
        }),
      };

      await registry.listMerged(discovery as any, {
        force: true,
        nonDestructive: true,
      });

      expect(stateMgr.readState(record.agent_id)).toMatchObject({
        surface_id: "surface:old",
        surface_observer_id: ownerId,
        workspace_id: "workspace:old",
      });
    });

    it("listMerged refreshes a managed ref and workspace from exact UUID evidence", async () => {
      const surfaceUuid = "11111111-2222-4333-8444-555555555555";
      const record = makeRecord({
        agent_id: "managed-list-moved-uuid",
        surface_id: "surface:old",
        surface_uuid: surfaceUuid,
        surface_observer_id: "cmux:/tmp/previous.sock",
        workspace_id: "workspace:old",
      });
      stateMgr.writeState(record);
      const registry = new AgentRegistry(stateMgr, async () => [], {
        observerId: "cmux:/tmp/current.sock",
      });
      registry.set(record.agent_id, record);
      const moved = makeDiscovered({
        surface_id: "surface:new",
        surface_uuid: surfaceUuid.toUpperCase(),
        workspace_id: "workspace:new",
        cli: "codex",
      });
      const refOnlyNeighbor = makeDiscovered({
        surface_id: "surface:ref-only-neighbor",
        surface_uuid: null,
      });

      const merged = await registry.listMerged(
        { scan: vi.fn() } as any,
        { discovered: [moved, refOnlyNeighbor], nonDestructive: true },
      );

      expect(
        merged.find((candidate) => candidate.agent_id === record.agent_id),
      ).toMatchObject({
        surface_id: "surface:new",
        surface_uuid: surfaceUuid,
        surface_observer_id: "cmux:/tmp/current.sock",
        workspace_id: "workspace:new",
      });
      expect(stateMgr.readState(record.agent_id)).toMatchObject({
        surface_id: "surface:new",
        workspace_id: "workspace:new",
      });
    });

    it("refreshManagedSurfaceMetadata follows a managed UUID to its current ref", async () => {
      const surfaceUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
      const record = makeRecord({
        agent_id: "managed-refresh-moved-uuid",
        surface_id: "surface:old",
        surface_uuid: surfaceUuid,
        surface_observer_id: "cmux:/tmp/previous.sock",
        workspace_id: "workspace:old",
      });
      stateMgr.writeState(record);
      const registry = new AgentRegistry(stateMgr, async () => [], {
        observerId: "cmux:/tmp/current.sock",
      });
      registry.set(record.agent_id, record);
      const discovery = {
        scan: vi.fn().mockResolvedValue([
          makeDiscovered({
            surface_id: "surface:new",
            surface_uuid: surfaceUuid.toUpperCase(),
            workspace_id: "workspace:new",
            cli: "codex",
          }),
          makeDiscovered({
            surface_id: "surface:ref-only-neighbor",
            surface_uuid: null,
          }),
        ]),
      };

      const refreshed = await registry.refreshManagedSurfaceMetadata(
        discovery as any,
        { agentId: record.agent_id, force: true },
      );

      expect(refreshed).toMatchObject({
        surface_id: "surface:new",
        surface_uuid: surfaceUuid,
        surface_observer_id: "cmux:/tmp/current.sock",
        workspace_id: "workspace:new",
      });
      expect(stateMgr.readState(record.agent_id)).toMatchObject({
        surface_id: "surface:new",
        workspace_id: "workspace:new",
      });
    });

    it("keeps a recycled ref's new auto occupant separate from the old UUID record", async () => {
      const oldUuid = "11111111-2222-4333-8444-555555555555";
      const newUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
      const oldAgentId = "auto-codex-surface-42";
      stateMgr.writeState(
        makeRecord({
          agent_id: oldAgentId,
          surface_id: "surface:42",
          surface_uuid: oldUuid,
          repo: "brainlayer",
          cli: "codex",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => [
        { ...makeSurface("surface:42"), id: newUuid },
      ]);
      await registry.reconstitute();
      const discovered = makeDiscovered({
        surface_id: "surface:42",
        surface_uuid: newUuid,
        surface_title: "brainlayerCodex",
        cli: "codex",
        model: "gpt-5.5",
      });

      const merged = await registry.listMerged({
        scan: vi.fn().mockResolvedValue([discovered]),
      } as any);

      expect(stateMgr.readState(oldAgentId)?.surface_uuid).toBe(oldUuid);
      expect(merged).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agent_id: oldAgentId,
            surface_uuid: oldUuid,
          }),
          expect.objectContaining({
            surface_id: "surface:42",
            surface_uuid: newUuid,
          }),
        ]),
      );
      expect(
        merged.find((agent) => agent.surface_uuid === newUuid)?.agent_id,
      ).not.toBe(oldAgentId);
    });

    it("does not sync registry metadata from one discovered ref with two UUIDs", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "managed-ambiguous-discovery",
          surface_id: "surface:shared",
          surface_uuid: null,
          workspace_id: "workspace:old",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:shared"),
      ]);
      await registry.reconstitute();
      const discovered = [
        makeDiscovered({
          surface_id: "surface:shared",
          surface_uuid: "11111111-2222-4333-8444-555555555555",
          workspace_id: "workspace:first",
          cli: "codex",
        }),
        makeDiscovered({
          surface_id: "surface:shared",
          surface_uuid: "66666666-7777-4888-8999-aaaaaaaaaaaa",
          workspace_id: "workspace:second",
          cli: "codex",
        }),
      ];

      await registry.listMerged({ scan: vi.fn() } as any, {
        discovered,
        nonDestructive: true,
      });

      expect(stateMgr.readState("managed-ambiguous-discovery")).toMatchObject({
        surface_id: "surface:shared",
        surface_uuid: null,
        workspace_id: "workspace:old",
      });
      expect(stateMgr.listStates()).toHaveLength(1);
    });
  });

  describe("repairFromDiscovery", () => {
    it("does not repair or evict from a non-bijective discovery observation", () => {
      const duplicateUuid = "11111111-2222-4333-8444-555555555555";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex",
          surface_id: "surface:old",
          surface_uuid: duplicateUuid,
          repo: "cmuxlayer",
          cli: "codex",
          launcher_name: "cmuxlayerCodex",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => []);
      registry.set(
        "cmuxlayerCodex",
        stateMgr.readState("cmuxlayerCodex")!,
      );
      const discovered = [
        makeDiscovered({
          surface_id: "surface:first",
          surface_uuid: duplicateUuid,
          surface_title: "cmuxlayerCodex",
          cli: "codex",
        }),
        makeDiscovered({
          surface_id: "surface:second",
          surface_uuid: duplicateUuid,
          surface_title: "cmuxlayerCodex",
          cli: "codex",
        }),
      ];

      expect(registry.repairFromDiscovery(discovered)).toEqual({
        repaired: [],
        evicted: [],
        skipped: [],
      });
      expect(stateMgr.listStates()).toEqual([
        expect.objectContaining({
          agent_id: "cmuxlayerCodex",
          surface_id: "surface:old",
          surface_uuid: duplicateUuid,
        }),
      ]);
    });

    it("does not rebind a managed record when its ref is recycled to a different UUID", async () => {
      const persistedUuid = "11111111-2222-4333-8444-555555555555";
      const recycledOccupantUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex",
          surface_id: "surface:42",
          surface_uuid: persistedUuid,
          repo: "cmuxlayer",
          cli: "codex",
          launcher_name: "cmuxlayerCodex",
        }),
      );

      const registry = new AgentRegistry(stateMgr, async () => [
        {
          ...makeSurface("surface:42"),
          id: recycledOccupantUuid,
        },
      ]);
      await registry.reconstitute({ confirmationMs: 5_000, now: 1_000 });

      const result = registry.repairFromDiscovery([
        makeDiscovered({
          surface_id: "surface:42",
          surface_uuid: recycledOccupantUuid,
          surface_title: "cmuxlayerCodex",
          cli: "codex",
        }),
      ]);

      expect(result.repaired).toEqual([]);
      expect(registry.get("cmuxlayerCodex")).toMatchObject({
        surface_id: "surface:42",
        surface_uuid: persistedUuid,
        repo: "cmuxlayer",
        cli: "codex",
        launcher_name: "cmuxlayerCodex",
      });
      expect(stateMgr.readState("cmuxlayerCodex")?.surface_uuid).toBe(
        persistedUuid,
      );
    });

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
            surface_uuid: "11111111-2222-4333-8444-555555555555",
            surface_title: "🤝 driverBuddy",
            cli: "claude",
          }),
        ],
        { seatRegistry: REPAIR_SEATS },
      );

      expect(result.repaired).toEqual([
        expect.objectContaining({
          surface_id: "surface:32",
          surface_uuid: "11111111-2222-4333-8444-555555555555",
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
        surface_uuid: "11111111-2222-4333-8444-555555555555",
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

    it("RC4: preserves live pending sibling seats on different surfaces during repair", async () => {
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
          "mimirCodex-pending-1710000000-cafe",
        ]),
      );
      expect(result.evicted).not.toEqual(
        expect.arrayContaining([
          "mimirClaude-pending-1710000000-abcd",
          "mimirCodex-pending-1710000000-dead",
        ]),
      );

      const liveRows = registry
        .list()
        .map((record) => record.agent_id)
        .sort();
      expect(liveRows).toEqual([
        "mimirClaude",
        "mimirClaude-pending-1710000000-abcd",
        "mimirCodex",
        "mimirCodex-pending-1710000000-dead",
      ]);
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
          .filter((record) => record.agent_id.includes("-pending-"))
          .map((record) => record.agent_id)
          .sort(),
      ).toEqual([
        "mimirClaude-pending-1710000000-abcd",
        "mimirCodex-pending-1710000000-dead",
      ]);

      const merged = await registry.listMerged({
        scan: vi.fn().mockResolvedValue(discovered),
      } as any);
      expect(merged.map((record) => record.agent_id).sort()).toEqual([
        "mimirClaude",
        "mimirClaude-pending-1710000000-abcd",
        "mimirCodex",
        "mimirCodex-pending-1710000000-dead",
      ]);
    });
  });

  describe("hasLiveSurface", () => {
    it("RC1: treats a confirmed dead PTY as not alive even when its surface is enumerable", async () => {
      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:dead-pty"),
      ]);

      await expect(
        registry.isSurfaceAlive(
          { surface_id: "surface:dead-pty" },
          { ptyDead: true },
        ),
      ).resolves.toBe(false);
    });

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

  describe("observer-scoped cleanup", () => {
    it("keeps absence guarded while explicit terminal eviction is global", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "foreign-terminal",
          state: "done",
          surface_id: "surface:foreign-gone",
          surface_uuid: "uuid-foreign",
          surface_observer_id: "cmux:/tmp/prod.sock",
        }),
      );
      const registry = new AgentRegistry(
        stateMgr,
        async () => [{ ...makeSurface("surface:witness"), id: "uuid-witness" }],
        { observerId: "cmux:/tmp/nightly.sock" },
      );
      await registry.reconstitute();

      await expect(
        registry.evictSurfaceless({ confirmationMs: 0 }),
      ).resolves.toEqual([]);
      expect(registry.evict("foreign-terminal")).toBeNull();
      expect(registry.evictExplicit("foreign-terminal")).toBe(
        "foreign-terminal",
      );
      expect(stateMgr.readState("foreign-terminal")).toBeNull();
    });

    it("startup-purges legacy and local terminal rows but retains foreign rows", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "legacy-terminal",
          state: "done",
          surface_id: "surface:legacy",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "local-terminal",
          state: "error",
          surface_id: "surface:local",
          surface_observer_id: "cmux:/tmp/prod.sock",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "foreign-terminal",
          state: "done",
          surface_id: "surface:foreign",
          surface_observer_id: "cmux:/tmp/nightly.sock",
        }),
      );
      const registry = new AgentRegistry(
        stateMgr,
        async () => [makeSurface("surface:witness")],
        { observerId: "cmux:/tmp/prod.sock" },
      );
      await registry.reconstitute();

      expect(
        registry
          .purgeAllTerminal()
          .map((record) => record.agent_id)
          .sort(),
      ).toEqual(["legacy-terminal", "local-terminal"]);
      expect(stateMgr.readState("legacy-terminal")).toBeNull();
      expect(stateMgr.readState("local-terminal")).toBeNull();
      expect(stateMgr.readState("foreign-terminal")).not.toBeNull();
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

      const purged = await registry.purgeTerminal({ confirmationMs: 0 });

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

      const purged = await registry.purgeTerminal({ confirmationMs: 0 });

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

      const purged = await registry.purgeTerminal({ confirmationMs: 0 });

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

      const purged = await registry.purgeTerminal({ confirmationMs: 0 });
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

  describe("evictSurfaceless confirmation", () => {
    it("does not evict a UUID-backed record when a legacy topology confirms its ref live", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "uuid-agent-on-legacy-topology",
          state: "done",
          surface_id: "surface:legacy-live",
          surface_uuid: "uuid-known-but-unreported",
          role: "orchestrator",
        }),
      );
      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:legacy-live"),
      ]);
      await registry.reconstitute();

      await expect(
        registry.evictSurfaceless({ confirmationMs: 0 }),
      ).resolves.toEqual([]);
      expect(registry.get("uuid-agent-on-legacy-topology")).not.toBeNull();
    });

    it("resets the absence window when the same surface is observed live", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "terminal-with-transient-gap",
          state: "done",
          surface_id: "surface:maybe-live",
          role: "orchestrator",
        }),
      );
      let liveSurfaces = [makeSurface("surface:other")];
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      await registry.reconstitute();

      await expect(
        registry.evictSurfaceless({ confirmationMs: 5_000, now: 1_000 }),
      ).resolves.toEqual([]);

      liveSurfaces = [makeSurface("surface:maybe-live")];
      await registry.reconcile();

      liveSurfaces = [makeSurface("surface:other")];
      await expect(
        registry.evictSurfaceless({ confirmationMs: 5_000, now: 8_000 }),
      ).resolves.toEqual([]);
      expect(registry.get("terminal-with-transient-gap")).not.toBeNull();

      await expect(
        registry.evictSurfaceless({ confirmationMs: 5_000, now: 13_001 }),
      ).resolves.toEqual(["terminal-with-transient-gap"]);
      expect(registry.get("terminal-with-transient-gap")).toBeNull();
    });
  });
});
