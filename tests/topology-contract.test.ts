import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDiscovery } from "../src/agent-discovery.js";
import { AgentEngine } from "../src/agent-engine.js";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
} from "../src/agent-registry.js";
import type {
  AgentHealthIssueCode,
  AgentHealthIssueSeverity,
} from "../src/agent-health.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxClient } from "../src/cmux-client.js";
import {
  buildFleetSidebarSnapshot,
  FleetSidebarCollapseStore,
  FleetSidebarPublisher,
  renderFleetSidebar,
  type FleetSidebarCandidate,
  type FleetSidebarPublication,
} from "../src/fleet-sidebar.js";
import { StateManager } from "../src/state-manager.js";
import type {
  CmuxNewSplitResult,
  CmuxSurface,
} from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function candidate(
  surfaceRef: string,
  overrides: Partial<FleetSidebarCandidate> = {},
): FleetSidebarCandidate {
  return {
    agentId: `agent-${surfaceRef}`,
    surfaceRef,
    surfaceTitle: `cmuxlayerCodex [${surfaceRef}]`,
    repo: "cmuxlayer",
    seatLane: "cmuxlayer",
    seatId: surfaceRef,
    launcherName: "cmuxlayerCodex",
    role: "worker",
    discovered: false,
    registryVersion: 1,
    registryUpdatedAt: "2026-07-14T09:00:00.000Z",
    createdAt: "2026-07-14T08:00:00.000Z",
    taskSummary: `Working on ${surfaceRef}`,
    healthStatus: "healthy",
    healthReasons: [],
    healthIssueCodes: [],
    healthIssueSeverities: {},
    screenCurrentAction: null,
    screenStatus: "working",
    ...overrides,
  };
}

function publication(
  state: FleetSidebarPublication["state"],
  renderedSurfaceRefs: string[],
  observedLiveSurfaceRefs: string[] | null,
  overrides: Record<string, Partial<FleetSidebarCandidate>> = {},
): FleetSidebarPublication {
  const candidates = renderedSurfaceRefs.map((surfaceRef) =>
    candidate(surfaceRef, overrides[surfaceRef]),
  );
  return {
    state,
    snapshot: buildFleetSidebarSnapshot(candidates, {
      liveSurfaceRefs: new Set(renderedSurfaceRefs),
    }),
    observedLiveSurfaceRefs,
  };
}

function tempOutputPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmuxlayer-topology-contract-"));
  tempDirs.push(dir);
  return join(dir, "fleet.swift");
}

function makeOutputImmediatelyWritable(outputPath: string): void {
  const old = new Date(Date.now() - 1_000);
  utimesSync(outputPath, old, old);
}

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agent_id: "agent-cmuxlayer",
    surface_id: "surface:agent",
    state: "working",
    repo: "cmuxlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: null,
    task_summary: "",
    pid: null,
    version: 1,
    created_at: "2026-07-14T08:00:00.000Z",
    updated_at: "2026-07-14T09:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    ...overrides,
  };
}

function surface(ref: string, title = `cmuxlayerCodex [${ref}]`): CmuxSurface {
  return {
    ref,
    title,
    type: "terminal",
    index: 0,
    selected: false,
    workspace_ref: "workspace:fleet",
  };
}

type MockClient = CmuxClient & {
  setStatus: ReturnType<typeof vi.fn>;
  setStatuses: ReturnType<typeof vi.fn>;
  readScreen: ReturnType<typeof vi.fn>;
};

function engineFixture(): {
  engine: AgentEngine;
  stateManager: StateManager;
  client: MockClient;
  publications: FleetSidebarPublication[];
  setTopology: (surfaces: CmuxSurface[]) => void;
  getTopology: () => CmuxSurface[];
} {
  const root = mkdtempSync(join(tmpdir(), "cmuxlayer-topology-engine-"));
  tempDirs.push(root);
  const stateManager = new StateManager(root);
  let liveSurfaces: CmuxSurface[] = [];
  const publications: FleetSidebarPublication[] = [];
  const client = {
    newSplit: vi.fn().mockResolvedValue({
      workspace: "workspace:fleet",
      surface: "surface:new",
      pane: "pane:fleet",
      title: "",
      type: "terminal",
    } satisfies CmuxNewSplitResult),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockImplementation(async (surfaceRef: string) => ({
      surface: surfaceRef,
      text: "$ ",
      lines: 20,
      scrollback_used: false,
    })),
    renameTab: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setStatuses: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockImplementation(async () => ({
      workspaces:
        liveSurfaces.length === 0
          ? []
          : [
              {
                ref: "workspace:fleet",
                title: "fleet",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
    })),
    listPanes: vi.fn().mockImplementation(async () => ({
      workspace_ref: "workspace:fleet",
      window_ref: "window:fleet",
      panes:
        liveSurfaces.length === 0
          ? []
          : [
              {
                ref: "pane:fleet",
                index: 0,
                focused: true,
                surface_count: liveSurfaces.length,
                surface_refs: liveSurfaces.map((entry) => entry.ref),
              },
            ],
    })),
    listPaneSurfaces: vi.fn().mockImplementation(async () => ({
      workspace_ref: "workspace:fleet",
      window_ref: "window:fleet",
      pane_ref: "pane:fleet",
      surfaces: liveSurfaces,
    })),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
    notifyLifecycleEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockClient;
  const registry = new AgentRegistry(stateManager, async () => liveSurfaces);
  const engine = new AgentEngine(stateManager, registry, client, {
    spawnPreflight: async () => {},
    sessionIdentityResolver: () => null,
    fleetSidebarPublisher: {
      publish: (input) => {
        if (!("snapshot" in input)) {
          throw new Error("topology contract requires explicit publication state");
        }
        publications.push(input);
      },
      dispose: () => {},
    },
  });

  return {
    engine,
    stateManager,
    client,
    publications,
    setTopology: (next) => {
      liveSurfaces = next;
    },
    getTopology: () => liveSurfaces,
  };
}

describe("topology contract: publication monotonicity", () => {
  it("never overwrites populated last-good with unknown, live-shrunk, or non-authoritative empty scans", () => {
    const outputPath = tempOutputPath();
    const publisher = new FleetSidebarPublisher({ outputPath });
    publisher.publish(
      publication(
        "populated",
        ["surface:1", "surface:2"],
        ["surface:1", "surface:2"],
      ),
    );
    const lastGood = readFileSync(outputPath, "utf8");

    makeOutputImmediatelyWritable(outputPath);
    publisher.publish(
      publication("unknown", ["surface:1"], ["surface:1", "surface:2"]),
    );
    expect(readFileSync(outputPath, "utf8")).toBe(lastGood);

    makeOutputImmediatelyWritable(outputPath);
    publisher.publish(
      publication("populated", ["surface:1"], ["surface:1", "surface:2"]),
    );
    expect(readFileSync(outputPath, "utf8")).toBe(lastGood);

    makeOutputImmediatelyWritable(outputPath);
    publisher.publish(publication("empty", [], ["surface:1"]));
    expect(readFileSync(outputPath, "utf8")).toBe(lastGood);

    publisher.dispose();
  });
});

describe("topology contract: authoritative ghost eviction", () => {
  it("requires two authoritative misses across the confirmation window and resets on a live observation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T09:00:00.000Z"));
    const fixture = engineFixture();
    fixture.stateManager.writeState(
      record({
        agent_id: "ghost-agent",
        surface_id: "surface:ghost",
        workspace_id: "workspace:fleet",
      }),
    );

    fixture.setTopology([
      surface("surface:ghost"),
      surface("surface:notes", "notes"),
    ]);
    await fixture.engine.getRegistry().reconstitute();

    vi.setSystemTime(new Date("2026-07-14T09:00:01.000Z"));
    fixture.setTopology([]);
    await fixture.engine.runSweep();
    expect(fixture.engine.getAgentState("ghost-agent")).toMatchObject({
      state: "working",
      surface_id: "surface:ghost",
    });

    vi.setSystemTime(new Date("2026-07-14T09:00:02.000Z"));
    fixture.setTopology([surface("surface:notes", "notes")]);
    await fixture.engine.runSweep();
    expect(fixture.engine.getAgentState("ghost-agent")).toMatchObject({
      state: "error",
      error: "Surface surface:ghost disappeared",
    });

    vi.setSystemTime(new Date("2026-07-14T09:00:03.000Z"));
    fixture.setTopology([
      surface("surface:ghost"),
      surface("surface:notes", "notes"),
    ]);
    await fixture.engine.runSweep();
    expect(fixture.engine.getAgentState("ghost-agent")).not.toBeNull();

    vi.setSystemTime(new Date("2026-07-14T09:00:10.000Z"));
    fixture.setTopology([surface("surface:notes", "notes")]);
    await fixture.engine.runSweep();
    expect(fixture.engine.getAgentState("ghost-agent")).not.toBeNull();

    vi.setSystemTime(
      new Date(
        Date.parse("2026-07-14T09:00:10.000Z") +
          SURFACE_EVICTION_CONFIRMATION_MS +
          1,
      ),
    );
    await fixture.engine.runSweep();
    expect(fixture.engine.getAgentState("ghost-agent")).toBeNull();
  });
});

describe("topology contract: first paint", () => {
  it("publishes discovering before the first populated sync without waiting for a sweep", async () => {
    const fixture = engineFixture();
    fixture.setTopology([
      surface("surface:first", "cmuxlayerCodex [surface:first]"),
    ]);
    fixture.client.readScreen.mockResolvedValue({
      surface: "surface:first",
      text:
        "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)\n  Reading src/fleet-sidebar.ts",
      lines: 30,
      scrollback_used: false,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => fixture.getTopology(),
      readScreen: (surfaceRef, opts) =>
        fixture.client.readScreen(surfaceRef, opts),
    });
    const sweep = vi.spyOn(fixture.engine, "runSweep");

    await fixture.engine.initialize(discovery);

    expect(sweep).not.toHaveBeenCalled();
    expect(fixture.publications[0]).toMatchObject({
      state: "discovering",
      observedLiveSurfaceRefs: null,
      snapshot: { seatCount: 0 },
    });
    expect(fixture.publications.at(-1)).toMatchObject({
      state: "populated",
      observedLiveSurfaceRefs: ["surface:first"],
      snapshot: {
        seatCount: 1,
        lanes: [
          {
            seats: [
              expect.objectContaining({
                surfaceRef: "surface:first",
                screenState: "working",
              }),
            ],
          },
        ],
      },
    });
    expect(fixture.publications.map((entry) => entry.state)).not.toContain(
      "empty",
    );
  });
});

describe("topology contract: seat binding", () => {
  it("binds each first-render seat to its own surface identity and screen parse", async () => {
    const fixture = engineFixture();
    fixture.stateManager.writeState(
      record({
        agent_id: "alpha-worker",
        surface_id: "surface:alpha",
        workspace_id: "workspace:fleet",
        seat_lane: "cmuxlayer",
        seat_id: "alpha",
      }),
    );
    fixture.stateManager.writeState(
      record({
        agent_id: "beta-worker",
        surface_id: "surface:beta",
        workspace_id: "workspace:fleet",
        seat_lane: "cmuxlayer",
        seat_id: "beta",
      }),
    );
    fixture.setTopology([
      surface("surface:alpha", "cmuxlayerCodex alpha"),
      surface("surface:beta", "cmuxlayerCodex beta"),
    ]);
    fixture.client.readScreen.mockImplementation(async (surfaceRef: string) => ({
      surface: surfaceRef,
      text:
        surfaceRef === "surface:alpha"
          ? "✻ Working (1m 2s • esc to interrupt)\n  Reading src/alpha.ts"
          : "✻ Working (2m 3s • esc to interrupt)\n  Editing src/beta.ts",
      lines: 20,
      scrollback_used: false,
    }));
    await fixture.engine.getRegistry().reconstitute();

    await fixture.engine.runSweep();

    const seats = fixture.publications
      .at(-1)
      ?.snapshot.lanes.flatMap((lane) => lane.seats);
    expect(seats).toHaveLength(2);
    expect(seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "alpha-worker",
          surfaceRef: "surface:alpha",
          name: "cmuxlayerCodex alpha",
          status: "Reading src/alpha.ts",
        }),
        expect.objectContaining({
          agentId: "beta-worker",
          surfaceRef: "surface:beta",
          name: "cmuxlayerCodex beta",
          status: "Editing src/beta.ts",
        }),
      ]),
    );
    expect(new Set(seats?.map((seat) => seat.surfaceRef))).toEqual(
      new Set(["surface:alpha", "surface:beta"]),
    );
  });
});

describe("topology contract: row content", () => {
  it("suppresses binding artifacts, caps status, and leaves actionable health wrapping", () => {
    const bindingCodes: AgentHealthIssueCode[] = [
      "seat_identity_mismatch",
      "non_claude_orchestrator",
      "orchestrator_not_leftmost",
      "worker_in_leftmost_column",
      "registry_surface_workspace_mismatch",
    ];
    const bindingReasons = bindingCodes.map(
      (code) => `binding artifact must stay hidden: ${code}`,
    );
    const actionableReason =
      "agent screen and registry heartbeat are stale and require operator recovery";
    const severities = Object.fromEntries(
      [...bindingCodes, "agent_wedged"].map((code) => [code, "blocking"]),
    ) as Partial<Record<AgentHealthIssueCode, AgentHealthIssueSeverity>>;
    const status = "Review topology contract\nthen publish evidence";
    const snapshot = buildFleetSidebarSnapshot(
      [
        candidate("surface:content", {
          taskSummary: status,
          healthStatus: "unhealthy",
          healthIssueCodes: [...bindingCodes, "agent_wedged"],
          healthReasons: [...bindingReasons, actionableReason],
          healthIssueSeverities: severities,
        }),
      ],
      { liveSurfaceRefs: new Set(["surface:content"]) },
    );

    expect(snapshot.lanes[0]?.seats[0]).toMatchObject({
      status,
      healthVisible: true,
      health: actionableReason,
    });
    const source = renderFleetSidebar(snapshot);
    for (const reason of bindingReasons) expect(source).not.toContain(reason);
    const statusBlock = source.slice(
      source.indexOf("Text(seat.status)"),
      source.indexOf("if seat.healthVisible"),
    );
    expect(statusBlock).toContain(".lineLimit(1)");
    expect(statusBlock).toContain(".truncationMode(.tail)");
    const healthBlockStart = source.indexOf("if seat.healthVisible");
    const healthBlockEnd = source.indexOf("    }\n    .padding(6)");
    expect(healthBlockStart).toBeGreaterThan(-1);
    expect(healthBlockEnd).toBeGreaterThan(healthBlockStart);
    const healthBlock = source.slice(healthBlockStart, healthBlockEnd);
    expect(healthBlock).not.toContain(".lineLimit");
    expect(healthBlock).not.toContain(".truncationMode");
  });
});

describe("topology contract: collapse", () => {
  it("folds lanes independently without turning the same live topology into a shrink", () => {
    const outputPath = tempOutputPath();
    const collapseStore = new FleetSidebarCollapseStore({
      statePath: join(outputPath, "..", "collapse.json"),
    });
    const publisher = new FleetSidebarPublisher({
      outputPath,
      collapseStore,
    });
    const live = publication(
      "populated",
      ["surface:golems", "surface:cmuxlayer"],
      ["surface:golems", "surface:cmuxlayer"],
      {
        "surface:golems": {
          repo: "golems",
          seatLane: "golems",
          launcherName: "golemsCodex",
          surfaceTitle: "golemsCodex",
        },
      },
    );
    publisher.publish(live);
    const expanded = readFileSync(outputPath, "utf8");

    collapseStore.setLaneCollapsed("cmuxlayer", true);
    makeOutputImmediatelyWritable(outputPath);
    publisher.publish(live);

    const folded = readFileSync(outputPath, "utf8");
    expect(folded).not.toBe(expanded);
    expect(folded).toContain('fleetLane("golems", 1, 1, false, 0');
    expect(folded).toContain('fleetLane("cmuxlayer", 1, 1, true, 1');
    expect(folded).toContain('surfaces=["surface:golems","surface:cmuxlayer"]');
    publisher.dispose();
  });
});
