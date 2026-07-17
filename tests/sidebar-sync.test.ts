/**
 * TDD tests for Task 17 — Sidebar Sync.
 * Tests syncSidebar(), runSweep(), and lifecycle log events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentDiscovery } from "../src/agent-discovery.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { ack, dispatch, writeHeartbeat } from "../src/inbox.js";
import { AGENT_HEALTH_MONITOR_MAX_AGE_MS } from "../src/agent-health-input.js";
import { readMonitorRegistry, registerMonitor } from "../src/monitor-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import { generateAgentId, type AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";
import {
  renderFleetSidebar,
  type FleetSidebarPublication,
} from "../src/fleet-sidebar.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-sidebar");

type MockClient = CmuxClient & {
  notify: ReturnType<typeof vi.fn>;
  notifyLifecycleEvent: ReturnType<typeof vi.fn>;
  setStatuses: ReturnType<typeof vi.fn>;
};

interface Round5SeatBindingFixture {
  workspace: string;
  surfaces: Array<{
    surface_uuid: string;
    surface_ref: string;
    title: string;
    screen: string;
    parsed_status: "working" | "idle" | null;
  }>;
  registry: Array<{
    agent_id: string;
    surface_uuid: string;
    stale_surface_ref: string;
    expected_surface_ref?: string;
    expected_state?: "working" | "idle" | "stalled";
    expected_rendered?: boolean;
    never_active?: boolean;
  }>;
}

const ROUND5_SEAT_BINDING = JSON.parse(
  readFileSync(
    new URL("./fixtures/sidebar/round5-seat-binding.json", import.meta.url),
    "utf8",
  ),
) as Round5SeatBindingFixture;

function makeMockClient(overrides?: Partial<CmuxClient>): MockClient {
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
    setStatuses: vi.fn().mockResolvedValue(undefined),
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
    notify: vi.fn().mockResolvedValue(undefined),
    notifyLifecycleEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MockClient;
}

function makeSurface(ref: string): CmuxSurface {
  return { ref, title: "", type: "terminal", index: 0, selected: false };
}

function makeWorkspace(ref: string) {
  return {
    ref,
    title: ref,
    index: 0,
    selected: false,
    pinned: false,
  };
}

async function armLeadMonitor(input: {
  registryPath: string;
  monitorId: string;
  ownerSeat: string;
  now: () => number;
  timeoutS?: number;
}): Promise<void> {
  await registerMonitor(
    {
      monitor_id: input.monitorId,
      owner_seat: input.ownerSeat,
      watch_targets: ["orchestrator/collab/example.md"],
      mechanism: "event",
      deadman_timeout_s: input.timeoutS ?? 60,
    },
    { registryPath: input.registryPath, now: input.now },
  );
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

describe("Sidebar Sync", () => {
  let stateMgr: StateManager;
  let mockClient: MockClient;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];
  let inboxOpts: { baseDir: string };
  let publishedFleetPublications: FleetSidebarPublication[];

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    const workspaceForSurface = (surface: CmuxSurface): string =>
      surface.workspace_ref ??
      stateMgr
        .listStates()
        .find((record) => record.surface_id === surface.ref)?.workspace_id ??
      "workspace:test";
    mockClient.listWorkspaces.mockImplementation(async () => ({
      workspaces: [...new Set(liveSurfaces.map(workspaceForSurface))].map(
        (ref, index) => ({
          ref,
          title: ref,
          index,
          selected: index === 0,
          pinned: false,
        }),
      ),
    }));
    mockClient.listPanes.mockImplementation(
      async ({ workspace }: { workspace?: string } = {}) => {
        const workspaceRef = workspace ?? "workspace:test";
        const surfaces = liveSurfaces.filter(
          (surface) => workspaceForSurface(surface) === workspaceRef,
        );
        return {
          workspace_ref: workspaceRef,
          window_ref: `window:${workspaceRef}`,
          panes:
            surfaces.length === 0
              ? []
              : [
                  {
                    ref: `pane:${workspaceRef}`,
                    index: 0,
                    focused: true,
                    surface_count: surfaces.length,
                    surface_refs: surfaces.map((surface) => surface.ref),
                    ...(surfaces.every((surface) => surface.id)
                      ? { surface_ids: surfaces.map((surface) => surface.id!) }
                      : {}),
                    selected_surface_ref: surfaces[0]?.ref,
                  },
                ],
        };
      },
    );
    mockClient.listPaneSurfaces.mockImplementation(
      async ({ workspace, pane }: { workspace?: string; pane?: string } = {}) => {
        const workspaceRef = workspace ?? "workspace:test";
        return {
          workspace_ref: workspaceRef,
          window_ref: `window:${workspaceRef}`,
          pane_ref: pane ?? `pane:${workspaceRef}`,
          surfaces: liveSurfaces.filter(
            (surface) => workspaceForSurface(surface) === workspaceRef,
          ),
        };
      },
    );
    publishedFleetPublications = [];
    inboxOpts = { baseDir: join(TEST_DIR, "inbox") };
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts,
      fleetSidebarPublisher: {
        publish: (publication) => {
          if (!("snapshot" in publication)) {
            throw new Error("engine must publish an explicit fleet state");
          }
          publishedFleetPublications.push(publication);
        },
        dispose: () => {},
      },
    });
  });

  it("binds state and identity to the stable UUID in the round-5 capture", async () => {
    const workingBinding = ROUND5_SEAT_BINDING.registry.find(
      (entry) => entry.expected_state === "working",
    )!;
    const idleBinding = ROUND5_SEAT_BINDING.registry.find(
      (entry) => entry.expected_state === "idle",
    )!;
    const ghostBinding = ROUND5_SEAT_BINDING.registry.find(
      (entry) => entry.expected_rendered === false,
    )!;
    const neverActiveBinding = ROUND5_SEAT_BINDING.registry.find(
      (entry) => entry.never_active === true,
    )!;
    stateMgr.writeState(
      makeRecord({
        agent_id: workingBinding.agent_id,
        surface_id: workingBinding.stale_surface_ref,
        surface_uuid: workingBinding.surface_uuid,
        workspace_id: ROUND5_SEAT_BINDING.workspace,
        repo: "cmuxlayer",
        launcher_name: "cmuxlayerCodex",
        role: "worker",
        state: "working",
        task_summary: "Topology contract verification",
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: idleBinding.agent_id,
        surface_id: idleBinding.stale_surface_ref,
        surface_uuid: idleBinding.surface_uuid,
        workspace_id: ROUND5_SEAT_BINDING.workspace,
        repo: "cmuxlayer",
        launcher_name: "cmuxlayerCodex",
        role: "worker",
        state: "idle",
        task_summary: "Await next assignment",
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: neverActiveBinding.agent_id,
        surface_id: neverActiveBinding.stale_surface_ref,
        surface_uuid: neverActiveBinding.surface_uuid,
        workspace_id: ROUND5_SEAT_BINDING.workspace,
        repo: "skillcreator",
        launcher_name: "skillcreatorCodex",
        role: "worker",
        state: "booting",
        task_summary: "Await first prompt",
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: ghostBinding.agent_id,
        surface_id: ghostBinding.stale_surface_ref,
        surface_uuid: ghostBinding.surface_uuid,
        workspace_id: ROUND5_SEAT_BINDING.workspace,
        repo: "voicelayer",
        launcher_name: "voicelayerCodex",
        role: "worker",
        state: "idle",
        task_summary: "Must not borrow a live surface",
      }),
    );

    liveSurfaces = ROUND5_SEAT_BINDING.surfaces.map((entry, index) => ({
      ...makeSurface(entry.surface_ref),
      id: entry.surface_uuid,
      title: entry.title,
      index,
      workspace_ref: ROUND5_SEAT_BINDING.workspace,
    }));
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace(ROUND5_SEAT_BINDING.workspace)],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: ROUND5_SEAT_BINDING.workspace,
      window_ref: "window:round5",
      panes: [
        {
          ref: "pane:round5",
          index: 0,
          focused: true,
          surface_count: liveSurfaces.length,
          surface_refs: liveSurfaces.map((surface) => surface.ref),
          surface_ids: liveSurfaces.map((surface) => surface.id!),
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: ROUND5_SEAT_BINDING.workspace,
      window_ref: "window:round5",
      pane_ref: "pane:round5",
      surfaces: liveSurfaces,
    });
    mockClient.readScreen.mockImplementation(async (surfaceRef: string) => {
      const captured = ROUND5_SEAT_BINDING.surfaces.find(
        (entry) => entry.surface_ref === surfaceRef,
      );
      if (!captured) throw new Error(`unexpected surface read: ${surfaceRef}`);
      return {
        surface: surfaceRef,
        text: captured.screen,
        lines: captured.screen.split("\n").length,
        scrollback_used: false,
      };
    });

    await engine.getRegistry().reconstitute();
    await engine.runSweep();

    const publication = publishedFleetPublications.at(-1)!;
    expect(publication.state).toBe("populated");
    expect(publication.snapshot.seatCount).toBe(3);
    const seats = publication.snapshot.lanes.flatMap((lane) => lane.seats);
    expect(seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: workingBinding.agent_id,
          surfaceUuid: workingBinding.surface_uuid,
          surfaceRef: workingBinding.expected_surface_ref,
          name: "cmuxlayerCodex [surface:595]",
          screenState: workingBinding.expected_state,
        }),
        expect.objectContaining({
          agentId: idleBinding.agent_id,
          surfaceUuid: idleBinding.surface_uuid,
          surfaceRef: idleBinding.expected_surface_ref,
          name: "cmuxlayerCodex [surface:594]",
          screenState: idleBinding.expected_state,
        }),
        expect.objectContaining({
          agentId: neverActiveBinding.agent_id,
          surfaceUuid: neverActiveBinding.surface_uuid,
          surfaceRef: neverActiveBinding.expected_surface_ref,
          name: "skillcreatorCodex [surface:591]",
          screenState: neverActiveBinding.expected_state,
        }),
      ]),
    );
    expect(seats).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: ghostBinding.agent_id }),
      ]),
    );
    expect(mockClient.readScreen).toHaveBeenCalledWith(
      workingBinding.expected_surface_ref,
      expect.objectContaining({ workspace: ROUND5_SEAT_BINDING.workspace }),
    );
    expect(mockClient.readScreen).toHaveBeenCalledWith(
      idleBinding.expected_surface_ref,
      expect.objectContaining({ workspace: ROUND5_SEAT_BINDING.workspace }),
    );
    const rendered = renderFleetSidebar(publication.snapshot, {
      state: publication.state,
      observedLiveSurfaceRefs: publication.observedLiveSurfaceRefs,
    });
    expect(rendered).toContain(
      'cmux("surface.focus", surface_id: seat.surfaceUuid)',
    );
    expect(rendered).toContain(
      `"surfaceUuid": "${neverActiveBinding.surface_uuid}"`,
    );
  });

  it("publishes the canonical observed UUID when persisted casing differs", async () => {
    const observedUuid = "078D1A5B-A3F4-40A5-8A59-A6C840BAF832";
    const persistedUuid = observedUuid.toLowerCase();
    stateMgr.writeState(
      makeRecord({
        agent_id: "case-normalized-seat",
        surface_id: "surface:case",
        surface_uuid: persistedUuid,
        workspace_id: "workspace:test",
        repo: "cmuxlayer",
        launcher_name: "cmuxlayerCodex",
        role: "worker",
        state: "working",
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:case"),
        id: observedUuid,
        title: "cmuxlayerCodex [surface:case]",
        workspace_ref: "workspace:test",
      },
    ];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(publishedFleetPublications.at(-1)).toMatchObject({
      state: "populated",
      observedLiveSurfaceRefs: ["surface:case"],
      observedLiveSurfaceUuids: [observedUuid],
      snapshot: {
        seatCount: 1,
        lanes: [
          {
            seats: [
              {
                agentId: "case-normalized-seat",
                surfaceRef: "surface:case",
                surfaceUuid: observedUuid,
              },
            ],
          },
        ],
      },
    });
  });

  it("publishes no mixed row when the stable UUID moves during the screen read", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    stateMgr.writeState(
      makeRecord({
        agent_id: "mid-sweep-move",
        surface_id: "surface:old",
        surface_uuid: stableUuid,
        workspace_id: "workspace:test",
        state: "ready",
        role: "worker",
        launcher_name: "cmuxlayerCodex",
        repo: "cmuxlayer",
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:old"),
        id: stableUuid,
        title: "old binding",
        workspace_ref: "workspace:test",
      },
    ];
    await engine.getRegistry().reconstitute();
    const listPaneSurfaces =
      mockClient.listPaneSurfaces.getMockImplementation();
    if (!listPaneSurfaces) {
      throw new Error("missing pane-surface test implementation");
    }
    mockClient.listPaneSurfaces.mockImplementationOnce(async (opts) => {
      const snapshot = await listPaneSurfaces(opts);
      queueMicrotask(() => {
        liveSurfaces = [
          {
            ...makeSurface("surface:old"),
            id: "uuid-recycled",
            title: "foreign occupant",
            workspace_ref: "workspace:test",
          },
          {
            ...makeSurface("surface:new"),
            id: stableUuid,
            title: "moved binding",
            workspace_ref: "workspace:test",
          },
        ];
      });
      return snapshot;
    });
    mockClient.readScreen.mockImplementation(async (surface: string) => ({
      surface,
      text:
        surface === "surface:new"
          ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
          : "Claude Code\nWhat can I help you with?\n> ",
      lines: 20,
      scrollback_used: false,
    }));

    await engine.runSweep();

    expect(mockClient.readScreen).toHaveBeenCalledWith(
      "surface:new",
      expect.anything(),
    );
    expect(mockClient.setStatus).not.toHaveBeenCalled();
    expect(publishedFleetPublications.at(-1)?.snapshot.seatCount).toBe(0);
  });

  it("quarantines a foreign ref-only row instead of reading its recycled surface", async () => {
    engine.dispose();
    const scopedRegistry = new AgentRegistry(
      stateMgr,
      async () => liveSurfaces,
      { observerId: "cmux:/tmp/nightly.sock" },
    );
    engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts,
      fleetSidebarPublisher: {
        publish: (publication) => {
          if (!("snapshot" in publication)) {
            throw new Error("engine must publish an explicit fleet state");
          }
          publishedFleetPublications.push(publication);
        },
        dispose: () => {},
      },
    });
    stateMgr.writeState(
      makeRecord({
        agent_id: "prod-ref-only-row",
        surface_id: "surface:shared",
        surface_uuid: null,
        surface_observer_id: "cmux:/tmp/prod.sock",
        workspace_id: "workspace:prod",
        state: "working",
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:shared"),
        id: "uuid-nightly-occupant",
        workspace_ref: "workspace:nightly",
      },
    ];
    await scopedRegistry.reconstitute();
    mockClient.readScreen.mockClear();

    await engine.runSweep();

    expect(mockClient.readScreen).not.toHaveBeenCalled();
    expect(stateMgr.readState("prod-ref-only-row")).toMatchObject({
      surface_uuid: null,
      surface_observer_id: "cmux:/tmp/prod.sock",
      workspace_id: "workspace:prod",
    });
    expect(publishedFleetPublications.at(-1)).toMatchObject({
      state: "empty",
      snapshot: { seatCount: 0 },
    });
  });

  it("publishes screen current-action fallback with truthful state and lane identity", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "auto-voicelayer-worker",
        surface_id: "surface:42",
        workspace_id: "workspace:voice",
        repo: "misc",
        seat_lane: "voicelayer",
        seat_id: "transcription-worker",
        state: "idle",
        task_summary: " ",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:voice")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:voice",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:42"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:voice",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [
        {
          ...makeSurface("surface:42"),
          title: "voicelayerCodex [surface:42]",
        },
      ],
    });
    mockClient.readScreen.mockResolvedValue({
      surface: "surface:42",
      text: "✻ Working (1m 2s • esc to interrupt)\n  Reading src/transcribe.ts",
      lines: 20,
      scrollback_used: false,
    });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(publishedFleetPublications).toHaveLength(1);
    expect(publishedFleetPublications[0]).toMatchObject({
      state: "populated",
      observedLiveSurfaceRefs: ["surface:42"],
      snapshot: {
        seatCount: 1,
        activeCount: 1,
        lanes: [
          {
            key: "voicelayer",
            liveCount: 1,
            activeCount: 1,
            collapsed: false,
            seats: [
              {
                agentId: "auto-voicelayer-worker",
                surfaceRef: "surface:42",
                name: "voicelayerCodex [surface:42]",
                screenState: "working",
                status: "Reading src/transcribe.ts",
                healthVisible: false,
                health: "",
              },
            ],
          },
        ],
      },
    });
  });

  it("discovers and publishes live seats exactly once during idempotent startup", async () => {
    const transcriptResolver = vi.fn(() => null);
    engine.dispose();
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: transcriptResolver,
      inboxOpts,
      fleetSidebarPublisher: {
        publish: (publication) => {
          if (!("snapshot" in publication)) {
            throw new Error("engine must publish an explicit fleet state");
          }
          publishedFleetPublications.push(publication);
        },
        dispose: () => {},
      },
    });
    liveSurfaces = [
      {
        ...makeSurface("surface:42"),
        title: "cmuxlayerCodex [surface:42]",
        workspace_ref: "workspace:cmuxlayer",
      },
    ];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:cmuxlayer")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:cmuxlayer",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:42"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:cmuxlayer",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: liveSurfaces,
    });
    mockClient.readScreen.mockResolvedValue({
      surface: "surface:42",
      text:
        "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)",
      lines: 30,
      scrollback_used: false,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });
    const scan = vi.spyOn(discovery, "scan");

    await engine.initialize(discovery);
    await engine.initialize(discovery);

    expect(scan).toHaveBeenCalledTimes(1);
    expect(transcriptResolver).not.toHaveBeenCalled();
    expect(publishedFleetPublications).toHaveLength(2);
    expect(publishedFleetPublications[0]).toMatchObject({
      state: "discovering",
      observedLiveSurfaceRefs: null,
    });
    expect(publishedFleetPublications.at(-1)).toMatchObject({
      state: "populated",
      observedLiveSurfaceRefs: ["surface:42"],
      snapshot: {
        seatCount: 1,
        lanes: [
          {
            key: "cmuxlayer",
            seats: [
              {
                surfaceRef: "surface:42",
                screenState: "working",
              },
            ],
          },
        ],
      },
    });

    await engine.runSweep();

    expect(transcriptResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "auto-codex-surface-42",
        cli: "codex",
      }),
    );
  });

  it("persists deferred transcript capture across restart and identity-write failure", async () => {
    const capturedSessionId = "12345678-1234-4234-8234-123456789abc";
    const deferredTranscriptResolver = vi.fn(() => ({
      session_id: capturedSessionId,
      path: "/tmp/codex-session.jsonl",
    }));
    stateMgr.writeState(
      makeRecord({
        agent_id: "cmuxlayerCodex-pending-startup",
        repo: "cmuxlayer",
        launcher_name: "cmuxlayerCodex",
        task_done_candidate_at: "2026-03-14T03:40:00Z",
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:42"),
        title: "cmuxlayerCodex [surface:42]",
        workspace_ref: "workspace:cmuxlayer",
      },
    ];
    engine.dispose();
    const terminalRegistry = new AgentRegistry(
      stateMgr,
      async () => liveSurfaces,
    );
    engine = new AgentEngine(stateMgr, terminalRegistry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: deferredTranscriptResolver,
      inboxOpts,
      fleetSidebarPublisher: {
        publish: () => {},
        dispose: () => {},
      },
    });
    mockClient.readScreen
      .mockResolvedValueOnce({
        surface: "surface:42",
        text:
          "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)",
        lines: 30,
        scrollback_used: false,
      })
      .mockResolvedValue({
        surface: "surface:42",
        text:
          "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\nImplemented the fix.\nTASK_DONE",
        lines: 30,
        scrollback_used: false,
      });
    const terminalDiscovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(terminalDiscovery);

    expect(deferredTranscriptResolver).not.toHaveBeenCalled();
    expect(engine.getAgentState("cmuxlayerCodex-pending-startup")).toMatchObject(
      {
        state: "done",
        cli_session_id: null,
        transcript_session_capture_deferred: true,
      },
    );

    engine.dispose();
    const restartedRegistry = new AgentRegistry(
      stateMgr,
      async () => liveSurfaces,
    );
    engine = new AgentEngine(stateMgr, restartedRegistry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: deferredTranscriptResolver,
      inboxOpts,
      fleetSidebarPublisher: {
        publish: () => {},
        dispose: () => {},
      },
    });
    const restartedDiscovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(restartedDiscovery);

    expect(deferredTranscriptResolver).not.toHaveBeenCalled();
    const updateRecord = stateMgr.updateRecord.bind(stateMgr);
    let rejectCapturedSessionWrite = true;
    const updateRecordSpy = vi
      .spyOn(stateMgr, "updateRecord")
      .mockImplementation((agentId, patch) => {
        if (
          rejectCapturedSessionWrite &&
          patch.cli_session_id === capturedSessionId
        ) {
          rejectCapturedSessionWrite = false;
          throw new Error("transient state write failure");
        }
        return updateRecord(agentId, patch);
      });

    await engine.runSweep();

    expect(deferredTranscriptResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "cmuxlayerCodex-pending-startup",
        cli: "codex",
        state: "done",
      }),
    );
    expect(engine.getAgentState("cmuxlayerCodex-pending-startup")).toMatchObject(
      {
        state: "done",
        cli_session_id: null,
        transcript_session_capture_deferred: true,
      },
    );

    updateRecordSpy.mockRestore();
    await engine.runSweep();

    expect(deferredTranscriptResolver).toHaveBeenCalledTimes(2);
    expect(
      engine.getAgentState(
        generateAgentId("codex", "cmuxlayer", capturedSessionId),
      ),
    ).toMatchObject({
      state: "done",
      cli_session_id: capturedSessionId,
      cli_session_path: "/tmp/codex-session.jsonl",
      transcript_session_capture_deferred: false,
    });
  });

  it("treats an empty first-connect enumeration as unknown, not authoritative empty", async () => {
    const discovery = new AgentDiscovery({
      listSurfaces: async () => [],
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(discovery);

    expect(publishedFleetPublications).toEqual([
      expect.objectContaining({ state: "discovering" }),
      expect.objectContaining({
        state: "unknown",
        observedLiveSurfaceRefs: [],
      }),
    ]);
  });

  it("keeps placement unavailable when first-connect discovery fails", async () => {
    mockClient.listWorkspaces.mockRejectedValue(
      new Error("cmux socket unavailable"),
    );
    const discovery = new AgentDiscovery({
      listSurfaces: async () => {
        throw new Error("cmux socket unavailable");
      },
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await expect(engine.initialize(discovery)).rejects.toThrow(
      /cmux socket unavailable/,
    );

    expect(publishedFleetPublications).toEqual([
      expect.objectContaining({ state: "discovering" }),
    ]);
  });

  it("suppresses terminal lifecycle and status side effects on first connect", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "stale-done-agent",
        surface_id: "surface:stale",
        state: "done",
      }),
    );
    const discovery = new AgentDiscovery({
      listSurfaces: async () => [],
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(discovery);

    expect(mockClient.log).not.toHaveBeenCalled();
    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalled();
    expect(mockClient.setStatus).not.toHaveBeenCalled();
    expect(mockClient.setStatuses).not.toHaveBeenCalled();
  });

  it("uses the discovered live occupant when a terminal record has the recycled surface ref", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "stale-done-agent",
        surface_id: "surface:42",
        state: "done",
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:42"),
        title: "cmuxlayerCodex [surface:42]",
        workspace_ref: "workspace:cmuxlayer",
      },
    ];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:cmuxlayer")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:cmuxlayer",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:42"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:cmuxlayer",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: liveSurfaces,
    });
    mockClient.readScreen.mockResolvedValue({
      surface: "surface:42",
      text:
        "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)",
      lines: 30,
      scrollback_used: false,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(discovery);

    expect(publishedFleetPublications.at(-1)).toMatchObject({
      state: "populated",
      snapshot: {
        seatCount: 1,
        lanes: [
          {
            seats: [
              {
                agentId: "auto-codex-surface-42",
                surfaceRef: "surface:42",
              },
            ],
          },
        ],
      },
    });
  });

  it("preserves the last generated fleet when topology enumeration is unknown", async () => {
    stateMgr.writeState(makeRecord());
    liveSurfaces = [makeSurface("surface:42")];
    mockClient.listWorkspaces.mockRejectedValue(new Error("socket unavailable"));
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.readScreen).not.toHaveBeenCalled();
    expect(publishedFleetPublications).toEqual([
      expect.objectContaining({
        state: "unknown",
        observedLiveSurfaceRefs: null,
      }),
    ]);
  });

  it("preserves the last generated fleet when topology is empty but registry seats remain", async () => {
    stateMgr.writeState(makeRecord());
    liveSurfaces = [makeSurface("surface:42")];
    mockClient.listWorkspaces.mockResolvedValue({ workspaces: [] });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(publishedFleetPublications).toEqual([
      expect.objectContaining({
        state: "unknown",
        observedLiveSurfaceRefs: [],
      }),
    ]);
  });

  it("auto-evicts a registry ghost on the next authoritative normal sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T05:00:00.000Z"));
    stateMgr.writeState(
      makeRecord({
        agent_id: "ghost-voicelayer-codex",
        surface_id: "surface:ghost",
        workspace_id: "workspace:voice",
        repo: "voicelayer",
        cli: "codex",
        launcher_name: "voicelayerCodex",
        role: "orchestrator",
        crash_recover: false,
      }),
    );
    liveSurfaces = [makeSurface("surface:notes")];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:notes")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:notes",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:notes",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:notes"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:notes",
      window_ref: "window:1",
      pane_ref: "pane:notes",
      surfaces: liveSurfaces,
    });
    const newlySurfacelessAgentIds =
      await engine.getRegistry().reconstitute();
    engine.enableStartupPurge({ retainAgentIds: newlySurfacelessAgentIds });

    await engine.runSweep();

    expect(engine.getAgentState("ghost-voicelayer-codex")).toMatchObject({
      state: "error",
      error: "Surface surface:ghost disappeared",
    });
    expect(
      publishedFleetPublications
        .at(-1)
        ?.snapshot.lanes.flatMap((lane) => lane.seats)
        .map((seat) => seat.surfaceRef),
    ).not.toContain("surface:ghost");

    await vi.advanceTimersByTimeAsync(5_001);
    await engine.runSweep();

    expect(engine.getAgentState("ghost-voicelayer-codex")).toBeNull();
  });

  it("does not let terminal worker cleanup bypass the sweep confirmation window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T05:00:00.000Z"));
    stateMgr.writeState(
      makeRecord({
        agent_id: "ghost-worker",
        surface_id: "surface:ghost-worker",
        workspace_id: "workspace:workers",
        role: "worker",
        crash_recover: false,
      }),
    );
    liveSurfaces = [makeSurface("surface:notes")];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:notes")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:notes",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:notes",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:notes"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:notes",
      window_ref: "window:1",
      pane_ref: "pane:notes",
      surfaces: liveSurfaces,
    });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(engine.getAgentState("ghost-worker")).toMatchObject({
      state: "error",
      error: "Surface surface:ghost-worker disappeared",
    });

    await vi.advanceTimersByTimeAsync(5_001);
    await engine.runSweep();

    expect(engine.getAgentState("ghost-worker")).toBeNull();
  });

  it("requires observed absence instead of using generic terminal record age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T05:00:00.000Z"));
    stateMgr.writeState(
      makeRecord({
        agent_id: "old-terminal-lead",
        surface_id: "surface:old-terminal-lead",
        workspace_id: "workspace:lead",
        state: "done",
        role: "orchestrator",
        updated_at: "2026-07-01T00:00:00.000Z",
        crash_recover: false,
      }),
    );
    liveSurfaces = [makeSurface("surface:notes")];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:notes")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:notes",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:notes",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:notes"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:notes",
      window_ref: "window:1",
      pane_ref: "pane:notes",
      surfaces: liveSurfaces,
    });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(engine.getAgentState("old-terminal-lead")).toMatchObject({
      state: "done",
      updated_at: "2026-07-01T00:00:00.000Z",
    });

    await vi.advanceTimersByTimeAsync(5_001);
    await engine.runSweep();

    expect(engine.getAgentState("old-terminal-lead")).toBeNull();
  });

  it("keeps registry seats when a normal sweep sees only a transient empty topology", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "possibly-live-voicelayer-codex",
        surface_id: "surface:possibly-live",
        workspace_id: "workspace:voice",
        repo: "voicelayer",
        cli: "codex",
        launcher_name: "voicelayerCodex",
        role: "orchestrator",
        crash_recover: false,
      }),
    );
    liveSurfaces = [];
    mockClient.listWorkspaces.mockResolvedValue({ workspaces: [] });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(engine.getAgentState("possibly-live-voicelayer-codex")).toMatchObject({
      surface_id: "surface:possibly-live",
      state: "working",
    });
    expect(publishedFleetPublications.at(-1)).toMatchObject({
      state: "unknown",
      observedLiveSurfaceRefs: [],
    });
  }, 10_000);

  it("publishes authoritative empty when only unrelated terminals remain", async () => {
    liveSurfaces = [makeSurface("surface:notes")];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:notes")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:notes",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:notes"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:notes",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: liveSurfaces,
    });

    await engine.runSweep();

    expect(publishedFleetPublications).toEqual([
      expect.objectContaining({
        state: "empty",
        observedLiveSurfaceRefs: ["surface:notes"],
      }),
    ]);
  });

  it("preserves the last generated fleet when topology enumeration is partial", async () => {
    stateMgr.writeState(makeRecord());
    liveSurfaces = [makeSurface("surface:42")];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:coach")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:coach",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:42"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockRejectedValue(
      new Error("pane closed during enumeration"),
    );
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(publishedFleetPublications).toEqual([
      expect.objectContaining({
        state: "unknown",
        observedLiveSurfaceRefs: null,
      }),
    ]);
  });

  it("marks a registry-working screen stalled after de-chromed output stops progressing", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-14T16:00:00.000Z");
    vi.setSystemTime(startedAt);
    stateMgr.writeState(
      makeRecord({
        agent_id: "no-transcript-progress",
        surface_id: "surface:no-progress",
        workspace_id: "workspace:cmuxlayer",
        repo: "cmuxlayer",
        launcher_name: "cmuxlayerCodex",
        state: "working",
        cli_session_id: null,
        cli_session_path: null,
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:no-progress"),
        title: "cmuxlayerCodex [surface:no-progress]",
        workspace_ref: "workspace:cmuxlayer",
      },
    ];
    mockClient.readScreen.mockResolvedValue({
      surface: "surface:no-progress",
      text:
        "Claude Code\n✻ Baking… (1s · ↑ 4)\n🤖 Opus 4.8 | ⏱️ 1s\n⏵⏵ bypass permissions on",
      lines: 4,
      scrollback_used: false,
    });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(
      publishedFleetPublications.at(-1)?.snapshot.lanes.flatMap(
        (lane) => lane.seats,
      ),
    ).toEqual([
      expect.objectContaining({
        agentId: "no-transcript-progress",
        screenState: "working",
      }),
    ]);

    vi.setSystemTime(startedAt.getTime() + 120_001);
    mockClient.readScreen.mockResolvedValue({
      surface: "surface:no-progress",
      text:
        "Claude Code\n✻ Baking… (2m 1s · ↑ 99)\n🤖 Opus 4.8 | ⏱️ 2m\n⏵⏵ bypass permissions on",
      lines: 4,
      scrollback_used: false,
    });

    await engine.runSweep();

    expect(
      publishedFleetPublications.at(-1)?.snapshot.lanes.flatMap(
        (lane) => lane.seats,
      ),
    ).toEqual([
      expect.objectContaining({
        agentId: "no-transcript-progress",
        screenState: "stalled",
      }),
    ]);
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("calls setStatus with compact sidebar truth for an active agent", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:42",
        workspace_id: "workspace:coach",
        cli_session_id: "session-a1",
        task_summary: "Read and follow GOAL-p8-sidebar.md",
        role: "worker",
        worktree_path:
          "/Users/etanheyman/Gits/cmuxlayer.wt/cmuxlayer-worker-p8",
        worktree_branch: "p8-sidebar",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("a1", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "a1",
      "brainlayer | role=worker | state=working | health=healthy | blocked=- | last_prompt=Read and follow GOAL-p8-sidebar.md | worktree=/Users/etanheyman/Gits/cmuxlayer.wt/cmuxlayer-worker-p8 | branch=p8-sidebar | report=n/a | pr=n/a",
      expect.objectContaining({
        icon: "bolt.fill",
        color: "#3B82F6",
        workspace: "workspace:coach",
        surface: "surface:42",
      }),
    );
  });

  it("batches a 12-agent sweep into one status session and keeps skipped rows dirty", async () => {
    for (let index = 0; index < 12; index++) {
      const agentId = `batch-${index}`;
      const surfaceId = `surface:${index}`;
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: surfaceId,
          workspace_id: "workspace:cmuxlayer",
          cli_session_id: `session-${index}`,
        }),
      );
      liveSurfaces.push(makeSurface(surfaceId));
      writeHeartbeat(agentId, inboxOpts);
    }
    await engine.getRegistry().reconstitute();
    mockClient.setStatuses.mockResolvedValue(false);

    await engine.runSweep();

    expect(mockClient.setStatuses).toHaveBeenCalledTimes(1);
    expect(mockClient.setStatuses.mock.calls[0]?.[0]).toHaveLength(12);
    expect(mockClient.setStatus).not.toHaveBeenCalled();

    await engine.runSweep();
    expect(mockClient.setStatuses).toHaveBeenCalledTimes(2);
  });

  it("discriminates health by state instead of marking every missing-session row unhealthy", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "booting-agent",
        state: "booting",
        surface_id: "surface:1",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: null,
        task_summary: "Boot worker",
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "working-agent",
        state: "working",
        surface_id: "surface:2",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: null,
        task_summary: "Run worker",
      }),
    );
    liveSurfaces = [makeSurface("surface:1"), makeSurface("surface:2")];
    writeHeartbeat("booting-agent", inboxOpts);
    writeHeartbeat("working-agent", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.setStatuses).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          key: "booting-agent",
          value:
            "brainlayer | role=worker | state=booting | health=healthy | blocked=- | last_prompt=Boot worker | worktree=- | branch=- | report=n/a | pr=n/a",
          workspace: "workspace:cmuxlayer",
        }),
        expect.objectContaining({
          key: "working-agent",
          value:
            "brainlayer | role=worker | state=working | health=healthy(missing_cli_session_id:info,non_resumable:info) | blocked=- | last_prompt=Run worker | worktree=- | branch=- | report=n/a | pr=n/a",
          workspace: "workspace:cmuxlayer",
        }),
      ]),
    );
  });

  it("surfaces a registry seat identity mismatch as blocking health", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "seat-mismatch",
        state: "working",
        surface_id: "surface:seat-mismatch",
        workspace_id: "workspace:cmuxlayer",
        repo: "cmuxlayer",
        cli: "codex",
        cli_session_id: "session-seat-mismatch",
        launcher_name: "golemsCodex",
        task_summary: "Fix seat assertion",
        role: "worker",
        seat_id: "golemsClaude",
        seat_lane: "golems",
        seat_role: "worker",
        seat_identity_status: "mismatch",
        seat_identity_error:
          "launcher golemsCodex belongs to seat golemsClaude repo=golems lane=golems, not requested repo=cmuxlayer",
      } as Partial<AgentRecord>),
    );
    liveSurfaces = [makeSurface("surface:seat-mismatch")];
    writeHeartbeat("seat-mismatch", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "seat-mismatch",
      "cmuxlayer | role=worker | seat=golemsClaude | lane=golems | state=working | health=unhealthy(seat_identity_mismatch:blocking) | blocked=- | last_prompt=Fix seat assertion | worktree=- | branch=- | report=n/a | pr=n/a",
      expect.objectContaining({
        icon: "bolt.fill",
        color: "#3B82F6",
        workspace: "workspace:cmuxlayer",
        surface: "surface:seat-mismatch",
      }),
    );
  });

  it("clears stale workspace-scoped sidebar rows during startup purge after restart", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "stale-done-agent",
        state: "done",
        surface_id: "surface:recycled",
        workspace_id: "workspace:previous-session",
      }),
    );
    liveSurfaces = [makeSurface("surface:recycled")];
    await engine.getRegistry().reconstitute();
    engine.enableStartupPurge();

    await engine.runSweep();

    expect(mockClient.clearStatus).toHaveBeenCalledWith("stale-done-agent", {
      workspace: "workspace:previous-session",
    });
    expect(mockClient.clearProgress).toHaveBeenCalledWith();
    expect(mockClient.setStatus).not.toHaveBeenCalledWith(
      "stale-done-agent",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("purges a preexisting surfaceless error when its ref is recycled at startup", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "stale-surface-error",
        state: "error",
        error: "Surface surface:recycled disappeared",
        surface_id: "surface:recycled",
        workspace_id: "workspace:previous-session",
      }),
    );
    liveSurfaces = [makeSurface("surface:recycled")];
    await engine.getRegistry().reconstitute();
    engine.enableStartupPurge();

    await engine.runSweep();

    expect(engine.getAgentState("stale-surface-error")).toBeNull();
    expect(mockClient.clearStatus).toHaveBeenCalledWith(
      "stale-surface-error",
      { workspace: "workspace:previous-session" },
    );
  });

  it("does not emit channel notifications for initial spawned rows", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:42",
        cli_session_id: "session-a1",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("a1", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalled();
  });

  it("continues sidebar sync when health screen reads fail", async () => {
    mockClient.readScreen.mockRejectedValue(new Error("cmux read failed"));
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:1",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-a1",
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "a2",
        state: "working",
        surface_id: "surface:2",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-a2",
      }),
    );
    liveSurfaces = [makeSurface("surface:1"), makeSurface("surface:2")];
    writeHeartbeat("a1", inboxOpts);
    writeHeartbeat("a2", inboxOpts);
    await engine.getRegistry().reconstitute();

    await expect(engine.runSweep()).resolves.toBeUndefined();

    expect(mockClient.setStatuses).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: "a1", surface: "surface:1" }),
        expect.objectContaining({ key: "a2", surface: "surface:2" }),
      ]),
    );
  });

  it("repairs registry workspace drift from the bound surface observation", async () => {
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:actual")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:actual",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:actual",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:42"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:actual",
      window_ref: "window:1",
      pane_ref: "pane:actual",
      surfaces: [
        {
          ref: "surface:42",
          title: "worker lane",
          type: "terminal",
          index: 0,
          selected: false,
        },
      ],
    });
    stateMgr.writeState(
      makeRecord({
        agent_id: "workspace-drift",
        state: "working",
        surface_id: "surface:42",
        workspace_id: "workspace:registry",
        cli_session_id: "session-workspace-drift",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("workspace-drift", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "workspace-drift",
      "brainlayer | role=worker | state=working | health=healthy | blocked=- | last_prompt=Fix search gap F | worktree=- | branch=- | report=n/a | pr=n/a",
      expect.objectContaining({
        surface: "surface:42",
        workspace: "workspace:actual",
      }),
    );
    expect(engine.getAgentState("workspace-drift")?.workspace_id).toBe(
      "workspace:actual",
    );
    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ agent_id: "workspace-drift" }),
      expect.stringContaining("registry_surface_workspace_mismatch"),
    );
  });

  it("scopes sidebar health screen reads to the agent workspace", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "scoped-read",
        state: "working",
        surface_id: "surface:42",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-scoped-read",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("scoped-read", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.readScreen).toHaveBeenCalledWith(
      "surface:42",
      expect.objectContaining({ workspace: "workspace:cmuxlayer" }),
    );
  });

  it("notifies when a wedged holder is already unhealthy on the first sweep", async () => {
    const inboxDir = join(TEST_DIR, "initial-wedged-inbox");
    const agentId = "initial-wedged-holder";
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:42",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-wedged",
        role: "worker",
        task_summary: "Drain existing stale dispatch",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir },
    });
    writeHeartbeat(agentId, { baseDir: inboxDir });
    dispatch(
      agentId,
      {
        id: "already-stale-dispatch",
        ts_ms: Date.now() - 180_000,
        from: "lead",
        tag: "dispatch",
        task: "stale work item",
      },
      { baseDir: inboxDir },
    );
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    const healthSummary =
      "unhealthy(stale_inbox_dispatches:blocking,agent_wedged:blocking)";
    expect(mockClient.notifyLifecycleEvent).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ agent_id: agentId }),
      healthSummary,
    );
  });

  it("marks a wedged holder unhealthy and notifies with the health issue summary", async () => {
    const inboxDir = join(TEST_DIR, "wedged-inbox");
    const agentId = "wedged-holder";
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:42",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-wedged",
        role: "worker",
        task_summary: "Keep draining inbox dispatches",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir },
    });
    writeHeartbeat(agentId, { baseDir: inboxDir });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      agentId,
      "brainlayer | role=worker | state=working | health=healthy | blocked=- | last_prompt=Keep draining inbox dispatches | worktree=- | branch=- | report=n/a | pr=n/a",
      expect.objectContaining({ workspace: "workspace:cmuxlayer" }),
    );

    (mockClient.setStatus as ReturnType<typeof vi.fn>).mockClear();
    mockClient.notifyLifecycleEvent.mockClear();
    dispatch(
      agentId,
      {
        id: "stale-dispatch",
        ts_ms: Date.now() - 180_000,
        from: "lead",
        tag: "dispatch",
        task: "stale work item",
      },
      { baseDir: inboxDir },
    );

    await engine.runSweep();

    const healthSummary =
      "unhealthy(stale_inbox_dispatches:blocking,agent_wedged:blocking)";
    expect(mockClient.setStatus).toHaveBeenCalledWith(
      agentId,
      `brainlayer | role=worker | state=working | health=${healthSummary} | blocked=self:agent_wedged | last_prompt=Keep draining inbox dispatches | worktree=- | branch=- | report=n/a | pr=n/a`,
      expect.objectContaining({ workspace: "workspace:cmuxlayer" }),
    );
    expect(mockClient.notifyLifecycleEvent).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ agent_id: agentId }),
      healthSummary,
    );

    mockClient.notifyLifecycleEvent.mockClear();
    ack(agentId, "stale-dispatch", "done", { baseDir: inboxDir });

    await engine.runSweep();

    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalled();

    mockClient.notifyLifecycleEvent.mockClear();
    dispatch(
      agentId,
      {
        id: "stale-dispatch-2",
        ts_ms: Date.now() - 180_000,
        from: "lead",
        tag: "dispatch",
        task: "second stale work item",
      },
      { baseDir: inboxDir },
    );

    await engine.runSweep();

    expect(mockClient.notifyLifecycleEvent).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ agent_id: agentId }),
      healthSummary,
    );
  });

  it("retries health notifications when channel delivery fails", async () => {
    const inboxDir = join(TEST_DIR, "wedged-retry-inbox");
    const agentId = "wedged-retry-holder";
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:42",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-wedged-retry",
        role: "worker",
        task_summary: "Retry health channel",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir },
    });
    writeHeartbeat(agentId, { baseDir: inboxDir });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    dispatch(
      agentId,
      {
        id: "stale-dispatch",
        ts_ms: Date.now() - 180_000,
        from: "lead",
        tag: "dispatch",
        task: "stale work item",
      },
      { baseDir: inboxDir },
    );
    mockClient.notifyLifecycleEvent.mockRejectedValueOnce(
      new Error("channel down"),
    );

    await engine.runSweep();
    await engine.runSweep();

    const healthSummary =
      "unhealthy(stale_inbox_dispatches:blocking,agent_wedged:blocking)";
    const healthCalls = mockClient.notifyLifecycleEvent.mock.calls.filter(
      (call) => call[0] === "health",
    );
    expect(healthCalls).toHaveLength(2);
    expect(healthCalls[0]).toEqual([
      "health",
      expect.objectContaining({ agent_id: agentId }),
      healthSummary,
    ]);
    expect(healthCalls[1]).toEqual([
      "health",
      expect.objectContaining({ agent_id: agentId }),
      healthSummary,
    ]);
  });

  it("fires one proactive alert when the registry deadman fires for a lead", async () => {
    const inboxDir = join(TEST_DIR, "lead-registry-deadman-inbox");
    const registryPath = join(TEST_DIR, "lead-deadman-registry.json");
    const agentId = "cmuxlayer-lead-registry-deadman";
    let now = 1_000_000;
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:lead-stale",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-lead-stale",
        cli: "claude",
        model: "claude",
        role: "orchestrator",
        repo: "cmuxlayer",
        task_summary: "Lead remediation lane",
      }),
    );
    liveSurfaces = [makeSurface("surface:lead-stale")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir, now: () => now },
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
    });
    await armLeadMonitor({
      registryPath,
      monitorId: "lead-deadman-1",
      ownerSeat: agentId,
      now: () => now,
    });
    now += 61_000;
    await engine.getRegistry().reconstitute();

    await engine.runSweep();
    await engine.runSweep();

    expect(mockClient.notify).toHaveBeenCalledTimes(1);
    expect(mockClient.notify).toHaveBeenCalledWith({
      title: "Lead monitor/session ended",
      subtitle: "cmuxlayer lead cmuxlayer-lead-registry-deadman",
      body: "Lead seat cmuxlayer-lead-registry-deadman in workspace workspace:cmuxlayer is watch-blind: monitor/session ended - lead is watch-blind. Last-known state: working.",
      workspace: "workspace:cmuxlayer",
      surface: "surface:lead-stale",
    });
    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ agent_id: agentId }),
      expect.stringContaining("inbox_monitor_not_alive"),
    );
  });

  it("suppresses watch-blind alerts and sidebar status when the lead pane is already closed", async () => {
    const inboxDir = join(TEST_DIR, "lead-closed-pane-inbox");
    const registryPath = join(TEST_DIR, "lead-closed-pane-registry.json");
    const agentId = "cmuxlayer-lead-closed-pane";
    let now = 1_250_000;
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:lead-closed",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-lead-closed",
        cli: "claude",
        model: "claude",
        role: "orchestrator",
        repo: "cmuxlayer",
        task_summary: "Lead remediation lane",
      }),
    );
    liveSurfaces = [makeSurface("surface:other-live")];
    mockClient.listWorkspaces.mockResolvedValue({
      workspaces: [makeWorkspace("workspace:cmuxlayer")],
    });
    mockClient.listPanes.mockResolvedValue({
      workspace_ref: "workspace:cmuxlayer",
      panes: [
        {
          ref: "pane:other-live",
          index: 0,
          focused: false,
          surface_count: 1,
          surface_refs: ["surface:other-live"],
        },
      ],
    });
    mockClient.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:cmuxlayer",
      window_ref: "window:1",
      pane_ref: "pane:other-live",
      surfaces: [makeSurface("surface:other-live")],
    });
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir, now: () => now },
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
    });
    await armLeadMonitor({
      registryPath,
      monitorId: "lead-closed-pane-1",
      ownerSeat: agentId,
      now: () => now,
    });
    now += 61_000;
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.notify).not.toHaveBeenCalled();
    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalled();
    expect(mockClient.setStatus).not.toHaveBeenCalledWith(
      agentId,
      expect.any(String),
      expect.any(Object),
    );
  });

  it("does not alert from stale inbox heartbeat when no registry deadman fired", async () => {
    const inboxDir = join(TEST_DIR, "lead-stale-inbox-only");
    const registryPath = join(TEST_DIR, "lead-stale-inbox-only-registry.json");
    const agentId = "cmuxlayer-lead-stale-inbox-only";
    let now = 1_500_000;
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:lead-never-armed",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-lead-never-armed",
        cli: "claude",
        model: "claude",
        role: "orchestrator",
        repo: "cmuxlayer",
        task_summary: "Lead remediation lane",
      }),
    );
    liveSurfaces = [makeSurface("surface:lead-never-armed")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir, now: () => now },
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
    });
    writeHeartbeat(agentId, { baseDir: inboxDir, now: () => now });
    now += 61_000;
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.notify).not.toHaveBeenCalled();
    expect(mockClient.setStatus).toHaveBeenCalledWith(
      agentId,
      expect.stringContaining(
        "health=degraded(inbox_monitor_not_alive:degraded)",
      ),
      expect.any(Object),
    );
  });

  it("does not fire the lead monitor-death alert for a worker registry deadman", async () => {
    const inboxDir = join(TEST_DIR, "worker-registry-deadman-inbox");
    const registryPath = join(TEST_DIR, "worker-registry-deadman.json");
    const agentId = "cmuxlayer-worker-registry-deadman";
    let now = 2_000_000;
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:worker-stale",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-worker-stale",
        role: "worker",
        repo: "cmuxlayer",
        task_summary: "Worker remediation lane",
      }),
    );
    liveSurfaces = [makeSurface("surface:worker-stale")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir, now: () => now },
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
    });
    await armLeadMonitor({
      registryPath,
      monitorId: "worker-deadman-1",
      ownerSeat: agentId,
      now: () => now,
    });
    now += 61_000;
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.notify).not.toHaveBeenCalled();
    expect(mockClient.setStatus).toHaveBeenCalledWith(
      agentId,
      expect.stringContaining(
        "health=degraded(inbox_monitor_not_alive:degraded)",
      ),
      expect.any(Object),
    );
  });

  it("re-arms the lead monitor-death alert after a newer alive registry monitor appears", async () => {
    const inboxDir = join(TEST_DIR, "lead-monitor-rearm-inbox");
    const registryPath = join(TEST_DIR, "lead-monitor-rearm-registry.json");
    const agentId = "cmuxlayer-lead-monitor-rearm";
    let now = 3_000_000;
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:lead-rearm",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-lead-rearm",
        cli: "claude",
        model: "claude",
        role: "orchestrator",
        repo: "cmuxlayer",
        task_summary: "Lead remediation lane",
      }),
    );
    liveSurfaces = [makeSurface("surface:lead-rearm")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir, now: () => now },
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
    });
    await armLeadMonitor({
      registryPath,
      monitorId: "lead-rearm-1",
      ownerSeat: agentId,
      now: () => now,
    });
    now += 61_000;
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    now += 1_000;
    await armLeadMonitor({
      registryPath,
      monitorId: "lead-rearm-2",
      ownerSeat: agentId,
      now: () => now,
    });
    await engine.runSweep();

    now += 61_000;
    await engine.runSweep();

    expect(mockClient.notify).toHaveBeenCalledTimes(2);
  });

  it("registry deadman timeout waits for a cross-agent sweep instead of an owner-local timer", async () => {
    vi.useFakeTimers();
    const inboxDir = join(TEST_DIR, "lead-monitor-cross-agent-inbox");
    const registryPath = join(TEST_DIR, "lead-monitor-cross-agent-sweep.json");
    const agentId = "cmuxlayer-lead-monitor-deadman";
    let now = 4_000_000;
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "working",
        surface_id: "surface:lead-deadman",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: "session-lead-deadman",
        cli: "claude",
        model: "claude",
        role: "orchestrator",
        repo: "cmuxlayer",
        task_summary: "Lead remediation lane",
      }),
    );
    liveSurfaces = [makeSurface("surface:lead-deadman")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir, now: () => now },
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
    });
    await armLeadMonitor({
      registryPath,
      monitorId: "lead-cross-agent-1",
      ownerSeat: agentId,
      now: () => now,
    });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.notify).not.toHaveBeenCalled();

    now += AGENT_HEALTH_MONITOR_MAX_AGE_MS + 1;
    const advanceTimersByTimeAsync = (
      vi as unknown as {
        advanceTimersByTimeAsync?: (ms: number) => Promise<void>;
      }
    ).advanceTimersByTimeAsync;
    if (advanceTimersByTimeAsync) {
      await advanceTimersByTimeAsync.call(
        vi,
        AGENT_HEALTH_MONITOR_MAX_AGE_MS + 1,
      );
    } else {
      vi.advanceTimersByTime(AGENT_HEALTH_MONITOR_MAX_AGE_MS + 1);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(mockClient.notify).not.toHaveBeenCalled();

    await engine.runSweep();

    expect(mockClient.notify).toHaveBeenCalledTimes(1);
    expect(mockClient.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Lead monitor/session ended",
        surface: "surface:lead-deadman",
        workspace: "workspace:cmuxlayer",
      }),
    );
  });

  it("lead monitor-death delivery memory follows session-capture rename", async () => {
    const inboxDir = join(TEST_DIR, "lead-monitor-rename-inbox");
    const registryPath = join(TEST_DIR, "lead-monitor-rename-registry.json");
    const pendingAgentId = "claude-cmuxlayer-pending-lead";
    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const finalAgentId = generateAgentId("claude", "cmuxlayer", sessionId);
    let now = 5_000_000;
    let capturedSessionId: string | null = null;
    stateMgr.writeState(
      makeRecord({
        agent_id: pendingAgentId,
        state: "working",
        surface_id: "surface:lead-rename",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: null,
        cli: "claude",
        model: "claude",
        role: "orchestrator",
        repo: "cmuxlayer",
        task_summary: "Lead remediation lane",
      }),
    );
    liveSurfaces = [makeSurface("surface:lead-rename")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts: { baseDir: inboxDir, now: () => now },
      sessionIdentityResolver: () => capturedSessionId,
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
    });
    await armLeadMonitor({
      registryPath,
      monitorId: "lead-rename-1",
      ownerSeat: pendingAgentId,
      now: () => now,
    });
    now += AGENT_HEALTH_MONITOR_MAX_AGE_MS + 1;
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.notify).toHaveBeenCalledTimes(1);
    expect(mockClient.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        subtitle: `cmuxlayer lead ${pendingAgentId}`,
        body: expect.stringContaining(`Lead seat ${pendingAgentId}`),
      }),
    );

    capturedSessionId = sessionId;
    await engine.runSweep();

    expect(stateMgr.readState(pendingAgentId)).toBeNull();
    expect(stateMgr.readState(finalAgentId)).not.toBeNull();
    expect(mockClient.notify).toHaveBeenCalledTimes(1);
    expect(readMonitorRegistry({ registryPath }).monitors[0]).toMatchObject({
      monitor_id: "lead-rename-1",
      owner_seat: finalAgentId,
    });
  });

  it("does not emit done notifications until a worker has verified terminal evidence", async () => {
    const goalPath = join(TEST_DIR, "phase-8-goal.md");
    const reportPath = join(TEST_DIR, "phase-8-report.md");
    writeFileSync(
      goalPath,
      [
        "# Phase 8 Goal",
        "",
        "Write the report to:",
        "",
        `\`${reportPath}\``,
        "",
        "The final report line must be exactly:",
        "",
        "`DONE_P8_WORKER`",
        "",
      ].join("\n"),
      "utf8",
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "done-worker",
        state: "done",
        surface_id: "surface:42",
        goal_file: goalPath,
        role: "worker",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("done-worker", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ agent_id: "done-worker" }),
    );

    writeFileSync(reportPath, "Status: COMPLETE\nDONE_P8_WORKER\n", "utf8");

    await engine.runSweep();

    expect(mockClient.notifyLifecycleEvent).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ agent_id: "done-worker" }),
    );
  });

  it("refreshes sidebar status when an unchanged agent moves workspace", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:42",
        workspace_id: "workspace:brainlayer",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("a1", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    const moved = stateMgr.updateRecord("a1", {
      surface_id: "surface:99",
      workspace_id: "workspace:coach",
    });
    engine.getRegistry().set("a1", moved);
    liveSurfaces = [makeSurface("surface:99")];

    await engine.runSweep();

    expect(mockClient.setStatus).toHaveBeenCalledTimes(2);
    expect(mockClient.setStatus).toHaveBeenLastCalledWith(
      "a1",
      "brainlayer | role=worker | state=working | health=healthy(missing_cli_session_id:info,non_resumable:info) | blocked=- | last_prompt=Fix search gap F | worktree=- | branch=- | report=n/a | pr=n/a",
      expect.objectContaining({
        workspace: "workspace:coach",
        surface: "surface:99",
      }),
    );
  });

  it("does not call setStatus again when state is unchanged between sweeps", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:42",
        cli_session_id: "session-a1",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("a1", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();
    const firstCallCount = (mockClient.setStatus as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    await engine.runSweep();
    const secondCallCount = (mockClient.setStatus as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    // Should not have called again because state didn't change
    expect(secondCallCount).toBe(firstCallCount);
  });

  it("calls setStatus again when agent state changes between sweeps", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:42",
        cli_session_id: "session-a1",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("a1", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    // Transition to done
    stateMgr.transition("a1", "done");
    await engine.getRegistry().reconcile();

    await engine.runSweep();

    const calls = (mockClient.setStatus as ReturnType<typeof vi.fn>).mock.calls;
    const doneCall = calls.find(
      (c) => typeof c[1] === "string" && c[1].includes("done"),
    );
    expect(doneCall).toBeDefined();
  });

  it("does not emit an opaque global progress bar while preserving agent status", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:1",
        workspace_id: "workspace:alpha",
        cli_session_id: "session-a1",
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "a2",
        state: "done",
        surface_id: "surface:2",
        workspace_id: "workspace:beta",
        cli_session_id: "session-a2",
      }),
    );
    liveSurfaces = [makeSurface("surface:1"), makeSurface("surface:2")];
    writeHeartbeat("a1", inboxOpts);
    writeHeartbeat("a2", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.setProgress).not.toHaveBeenCalled();
    expect(mockClient.setStatuses).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          key: "a1",
          value: expect.stringContaining("state=working"),
          workspace: "workspace:alpha",
        }),
        expect.objectContaining({
          key: "a2",
          value: expect.stringContaining("state=done"),
          workspace: "workspace:beta",
        }),
      ]),
    );
  });

  it("logs spawned event on first sweep for each new agent", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:42",
        cli_session_id: "session-a1",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("a1", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.log).toHaveBeenCalledWith(
      "spawned: brainlayer",
      expect.objectContaining({ level: "info", source: "cmuxlayer" }),
    );
    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalled();
  });

  it("logs done event when agent reaches done state", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:42",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    // First sweep — sees agent as working
    await engine.runSweep();

    // Transition to done
    stateMgr.transition("a1", "done");
    await engine.getRegistry().reconcile();

    await engine.runSweep();

    expect(mockClient.log).toHaveBeenCalledWith(
      "done: brainlayer",
      expect.objectContaining({ level: "success", source: "cmuxlayer" }),
    );
    expect(mockClient.notifyLifecycleEvent).not.toHaveBeenCalledWith(
      "done",
      expect.objectContaining({ agent_id: "a1" }),
    );
  });

  it("logs error event when agent enters error state", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "error",
        surface_id: "surface:42",
        error: "crashed",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.log).toHaveBeenCalledWith(
      "errored: brainlayer",
      expect.objectContaining({ level: "error", source: "cmuxlayer" }),
    );
    expect(mockClient.notifyLifecycleEvent).toHaveBeenCalledWith(
      "errored",
      expect.objectContaining({
        agent_id: "a1",
        repo: "brainlayer",
        state: "error",
      }),
    );
  });

  it("does not double-log lifecycle events on repeated sweeps", async () => {
    stateMgr.writeState(
      makeRecord({ agent_id: "a1", state: "done", surface_id: "surface:42" }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();
    await engine.runSweep();
    await engine.runSweep();

    const logCalls = (mockClient.log as ReturnType<typeof vi.fn>).mock.calls;
    // "spawned" should appear exactly once
    const spawnedCalls = logCalls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("spawned:"),
    );
    expect(spawnedCalls).toHaveLength(1);
    // "done" should appear exactly once
    const doneCalls = logCalls.filter(
      (c) => typeof c[0] === "string" && c[0].startsWith("done:"),
    );
    expect(doneCalls).toHaveLength(1);

    const channelCalls = mockClient.notifyLifecycleEvent.mock.calls;
    const spawnedChannelCalls = channelCalls.filter((c) => c[0] === "spawned");
    expect(spawnedChannelCalls).toHaveLength(0);
    const doneChannelCalls = channelCalls.filter((c) => c[0] === "done");
    expect(doneChannelCalls).toHaveLength(0);
  });

  it("does not re-emit spawned lifecycle events when late session capture renames an agent", async () => {
    const sessionId = "019f0123-1111-7222-8333-444455556666";
    const pendingId = "brainlayerCodex-pending-late-jsonl";
    const finalId = "brainlayerCodex-019f0123";
    let capturedIdentity: { session_id: string; path: string | null } | null =
      null;
    const transcriptResolver = vi.fn(() => capturedIdentity);
    engine.dispose();
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts,
      sessionIdentityResolver: transcriptResolver,
    });
    stateMgr.writeState(
      makeRecord({
        agent_id: pendingId,
        state: "ready",
        surface_id: "surface:late-jsonl",
        repo: "brainlayer",
        cli: "codex",
        model: "gpt-5.4",
        task_summary: "Fix late lifecycle rename",
        launch_cwd: "/Users/etanheyman/Gits/brainlayer",
        worktree_path: "/Users/etanheyman/Gits/brainlayer",
      }),
    );
    liveSurfaces = [makeSurface("surface:late-jsonl")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.log).toHaveBeenCalledWith(
      "spawned: brainlayer",
      expect.objectContaining({ level: "info", source: "cmuxlayer" }),
    );
    mockClient.log.mockClear();
    mockClient.setStatus.mockClear();
    mockClient.clearStatus.mockClear();
    capturedIdentity = {
      session_id: sessionId,
      path: "/tmp/codex-session.jsonl",
    };

    await engine.runSweep();

    const spawnedCalls = mockClient.log.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" && call[0].startsWith("spawned:"),
    );
    expect(spawnedCalls).toHaveLength(0);
    expect(
      mockClient.setStatus.mock.calls.some((call) => call[0] === finalId),
    ).toBe(true);
    expect(
      mockClient.clearStatus.mock.calls.some((call) => call[0] === pendingId),
    ).toBe(true);
    expect(stateMgr.readState(pendingId)).toBeNull();
    expect(stateMgr.readState(finalId)).toMatchObject({
      agent_id: finalId,
      cli_session_id: sessionId,
    });
  });
});
