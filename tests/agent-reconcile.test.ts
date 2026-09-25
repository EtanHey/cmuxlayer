/**
 * TDD tests for Task 17 — agent reconcile (formerly "Sidebar Sync").
 * Tests reconcileAgents(), runSweep(), cmux status pills, and lifecycle log events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentDiscovery } from "../src/agent-discovery.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { armWatch, readWatchRegistry } from "../src/watch-spec.js";
import { ack, dispatch, writeHeartbeat } from "../src/inbox.js";
import { AGENT_HEALTH_MONITOR_MAX_AGE_MS } from "../src/agent-health-input.js";
import {
  readMonitorRegistry,
  registerMonitor,
} from "../src/monitor-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import { generateAgentId, type AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-sidebar");
const ORIGINAL_PROMPT_AUTO_RESOLVE =
  process.env.CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE;

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
    getTransportHealth: () => ({ mode: "socket", degraded: false }),
    ...overrides,
  } as unknown as MockClient;
}

function makeSurface(ref: string): CmuxSurface {
  return { ref, title: "", type: "terminal", index: 0, selected: false };
}

function useActiveCodexScreen(client: MockClient): void {
  client.readScreen.mockImplementation(async (surface: string) => ({
    surface,
    text: "gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer\nWorking (1m 02s • esc to interrupt)",
    lines: 20,
    scrollback_used: false,
  }));
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
    role: "worker",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  };
}

/** Every cmux status pill the engine pushed, single or batched. */
function pushedStatuses(client: MockClient): Array<{
  key: string;
  value: string;
  surface?: string;
  workspace?: string;
}> {
  return [
    ...(client.setStatus as ReturnType<typeof vi.fn>).mock.calls.map(
      ([key, value, opts]) => ({ key, value, ...(opts ?? {}) }),
    ),
    ...client.setStatuses.mock.calls.flatMap(([batch]) => batch),
  ];
}

describe("Agent reconcile", () => {
  let stateMgr: StateManager;
  let mockClient: MockClient;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];
  let inboxOpts: { baseDir: string };
  let sweepDebugLogs: string[];

  beforeEach(() => {
    delete process.env.CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE;
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    const workspaceForSurface = (surface: CmuxSurface): string =>
      surface.workspace_ref ??
      stateMgr.listStates().find((record) => record.surface_id === surface.ref)
        ?.workspace_id ??
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
      async ({
        workspace,
        pane,
      }: { workspace?: string; pane?: string } = {}) => {
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
    sweepDebugLogs = [];
    inboxOpts = { baseDir: join(TEST_DIR, "inbox") };
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      sweepDebugLog: (message) => sweepDebugLogs.push(message),
      inboxOpts,
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
        updated_at: new Date().toISOString(),
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

    for (const binding of [workingBinding, idleBinding, neverActiveBinding]) {
      expect(engine.getAgentState(binding.agent_id)).toMatchObject({
        surface_id: binding.expected_surface_ref,
        surface_uuid: binding.surface_uuid,
      });
    }
    const statuses = pushedStatuses(mockClient);
    expect(statuses).toEqual(
      expect.arrayContaining(
        [workingBinding, idleBinding, neverActiveBinding].map((binding) =>
          expect.objectContaining({
            key: binding.agent_id,
            surface: binding.expected_surface_ref,
          }),
        ),
      ),
    );
    expect(statuses.map((status) => status.key)).not.toContain(
      ghostBinding.agent_id,
    );
    expect(mockClient.readScreen).toHaveBeenCalledWith(
      workingBinding.expected_surface_ref,
      expect.objectContaining({ workspace: ROUND5_SEAT_BINDING.workspace }),
    );
    expect(mockClient.readScreen).toHaveBeenCalledWith(
      idleBinding.expected_surface_ref,
      expect.objectContaining({ workspace: ROUND5_SEAT_BINDING.workspace }),
    );
  });

  it("skips destructive mutations when CLI topology is degraded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    (mockClient as unknown as Record<string, unknown>).getTransportHealth =
      () => ({
        mode: "cli",
        degraded: true,
        denied_reason: "access-control",
      });
    for (let index = 1; index <= 3; index += 1) {
      stateMgr.writeState(
        makeRecord({
          agent_id: `degraded-agent-${index}`,
          surface_id: `surface:${index}`,
          state: "done",
          role: "worker",
          cli_session_id: `session-${index}`,
        }),
      );
    }
    liveSurfaces = [makeSurface("surface:1")];
    const removeState = vi.spyOn(stateMgr, "removeState");
    await engine.getRegistry().reconstitute();

    await engine.runSweep();
    vi.setSystemTime(new Date("2026-08-24T12:01:00.000Z"));
    await engine.runSweep();

    expect(removeState).not.toHaveBeenCalled();
    expect(mockClient.readScreen).not.toHaveBeenCalled();
    expect(engine.getRegistry().list()).toHaveLength(3);
    expect(engine.lifecycleLockState()).toMatchObject({
      sweep_skipped_mutations: 2,
    });

    (mockClient as unknown as Record<string, unknown>).getTransportHealth =
      () => ({ mode: "socket", degraded: false });
    liveSurfaces = [1, 2, 3].map((index) => makeSurface(`surface:${index}`));
    await engine.runSweep();

    expect(engine.lifecycleLockState()).toMatchObject({
      sweep_skipped_mutations: 0,
    });
  });

  it("fails closed when transport health is unknown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    delete (mockClient as unknown as Record<string, unknown>)
      .getTransportHealth;
    for (let index = 1; index <= 3; index += 1) {
      stateMgr.writeState(
        makeRecord({
          agent_id: `unknown-health-agent-${index}`,
          surface_id: `surface:${index}`,
          state: "done",
          role: "worker",
          cli_session_id: `session-${index}`,
        }),
      );
    }
    liveSurfaces = [makeSurface("surface:1")];
    const removeState = vi.spyOn(stateMgr, "removeState");
    await engine.getRegistry().reconstitute();

    await engine.runSweep();
    vi.setSystemTime(new Date("2026-08-24T12:01:00.000Z"));
    await engine.runSweep();

    expect(removeState).not.toHaveBeenCalled();
    expect(engine.getRegistry().list()).toHaveLength(3);
    expect(engine.lifecycleLockState()).toMatchObject({
      sweep_skipped_mutations: 2,
    });
  });

  it("skips every snapshot-backed mutation when the observer epoch changes after collection", async () => {
    engine.dispose();
    (mockClient as unknown as Record<string, unknown>).moveSurface = vi
      .fn()
      .mockResolvedValue(undefined);
    const observerId = "cmux:/tmp/cmux-primary.sock";
    let observerEpoch = `${observerId}@socket:1`;
    const stableUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces, {
      observerIdProvider: () => observerId,
      observerEpochProvider: () => observerEpoch,
    });
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      sweepDebugLog: (message) => sweepDebugLogs.push(message),
      inboxOpts,
    });
    stateMgr.writeState(
      makeRecord({
        agent_id: "epoch-race-agent",
        surface_id: "surface:stale",
        surface_uuid: stableUuid,
        surface_observer_id: observerId,
        workspace_id: "workspace:test",
        state: "done",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      }),
    );
    registry.set("epoch-race-agent", stateMgr.readState("epoch-race-agent")!);
    liveSurfaces = [
      {
        ...makeSurface("surface:witness"),
        id: "11111111-2222-4333-8444-555555555555",
        workspace_ref: "workspace:test",
      },
    ];

    const reconcile = vi.spyOn(registry, "reconcile");
    const evictSurfaceless = vi.spyOn(registry, "evictSurfaceless");
    const purgeTerminal = vi.spyOn(registry, "purgeTerminal");
    const purgeAllTerminal = vi.spyOn(registry, "purgeAllTerminal");
    const removeState = vi.spyOn(stateMgr, "removeState");
    const engineWithReaper = engine as unknown as {
      reapChannelMarkersBestEffort: () => Promise<void>;
    };
    engineWithReaper.reapChannelMarkersBestEffort = async () => {
      observerEpoch = `${observerId}@socket:2`;
    };

    await engine.runSweep();

    expect(reconcile).not.toHaveBeenCalled();
    expect(evictSurfaceless).not.toHaveBeenCalled();
    expect(purgeTerminal).not.toHaveBeenCalled();
    expect(purgeAllTerminal).not.toHaveBeenCalled();
    expect(removeState).not.toHaveBeenCalled();
    expect(mockClient.moveSurface).not.toHaveBeenCalled();
    expect(mockClient.setStatus).not.toHaveBeenCalled();
    expect(mockClient.setStatuses).not.toHaveBeenCalled();
    expect(mockClient.clearStatus).not.toHaveBeenCalled();
    expect(registry.get("epoch-race-agent")).toMatchObject({
      state: "done",
      surface_id: "surface:stale",
      surface_uuid: stableUuid,
    });
    expect(engine.lifecycleLockState().sweep_skipped_mutations).toBe(1);
  });

  it("stops status updates when the observer epoch changes during an earlier agent read", async () => {
    engine.dispose();
    (
      mockClient as unknown as Record<string, unknown>
    ).supportsStableSurfaceReads = true;
    const observerId = "cmux:/tmp/cmux-primary.sock";
    let observerEpoch = `${observerId}@socket:1`;
    const firstUuid = "11111111-2222-4333-8444-555555555551";
    const secondUuid = "11111111-2222-4333-8444-555555555552";
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces, {
      observerIdProvider: () => observerId,
      observerEpochProvider: () => observerEpoch,
    });
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts,
    });
    const first = makeRecord({
      agent_id: "epoch-read-agent-1",
      surface_id: "surface:one",
      surface_uuid: firstUuid,
      surface_observer_id: observerId,
      workspace_id: "workspace:test",
      state: "working",
      role: "worker",
      cli_session_id: "session-1",
    });
    const second = makeRecord({
      agent_id: "epoch-read-agent-2",
      surface_id: "surface:stale-two",
      surface_uuid: secondUuid,
      surface_observer_id: observerId,
      workspace_id: "workspace:stale",
      state: "working",
      role: "worker",
      cli_session_id: "session-2",
    });
    for (const record of [first, second]) {
      stateMgr.writeState(record);
      registry.set(record.agent_id, record);
    }
    vi.spyOn(registry, "reconcile").mockResolvedValue(new Set());
    liveSurfaces = [
      {
        ...makeSurface("surface:one"),
        id: firstUuid,
        workspace_ref: "workspace:test",
      },
      {
        ...makeSurface("surface:two"),
        id: secondUuid,
        workspace_ref: "workspace:test",
      },
    ];
    let releaseFirstRead: (() => void) | undefined;
    const firstReadStarted = new Promise<void>((resolve) => {
      mockClient.readScreen.mockImplementation(async (surface: string) => {
        if (surface.toLowerCase() === firstUuid.toLowerCase()) {
          resolve();
          await new Promise<void>((release) => {
            releaseFirstRead = release;
          });
        }
        return {
          surface,
          text: "gpt-5.6 · Working",
          lines: 20,
          scrollback_used: false,
        };
      });
    });

    const sweep = engine.runSweep();
    await firstReadStarted;
    observerEpoch = `${observerId}@socket:2`;
    releaseFirstRead?.();
    await sweep;

    expect(registry.get(second.agent_id)).toMatchObject({
      surface_id: "surface:stale-two",
      workspace_id: "workspace:stale",
      surface_observer_id: observerId,
    });
    expect(stateMgr.readState(second.agent_id)).toMatchObject({
      surface_id: "surface:stale-two",
      workspace_id: "workspace:stale",
      surface_observer_id: observerId,
    });
    expect(mockClient.setStatus).not.toHaveBeenCalledWith(
      second.agent_id,
      expect.anything(),
      expect.anything(),
    );
    expect(pushedStatuses(mockClient).map((status) => status.key)).not.toContain(
      second.agent_id,
    );
    expect(engine.lifecycleLockState().sweep_skipped_mutations).toBe(1);
  });

  it("enumerates topology once through live-agent sidebar and liveness paths", async () => {
    let clientTopologyEnumerations = 0;
    let registryTopologyEnumerations = 0;
    (
      mockClient as unknown as Record<string, unknown>
    ).supportsStableSurfaceReads = true;
    (mockClient as unknown as Record<string, unknown>).getTransportHealth =
      () => ({ mode: "socket", degraded: false });
    for (let index = 1; index <= 3; index += 1) {
      const stableUuid = `11111111-2222-4333-8444-55555555555${index}`;
      stateMgr.writeState(
        makeRecord({
          agent_id: `topology-agent-${index}`,
          surface_id: `surface:${index}`,
          surface_uuid: stableUuid,
          workspace_id: "workspace:test",
          state: "working",
          role: "worker",
          cli_session_id: `session-${index}`,
        }),
      );
      liveSurfaces.push({
        ...makeSurface(`surface:${index}`),
        id: stableUuid,
        workspace_ref: "workspace:test",
      });
    }
    useActiveCodexScreen(mockClient);
    const originalListWorkspaces =
      mockClient.listWorkspaces.getMockImplementation()!;
    mockClient.listWorkspaces.mockImplementation(async () => {
      clientTopologyEnumerations += 1;
      return originalListWorkspaces();
    });
    engine.dispose();
    const registry = new AgentRegistry(stateMgr, async () => {
      registryTopologyEnumerations += 1;
      return liveSurfaces;
    });
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      sweepDebugLog: (message) => sweepDebugLogs.push(message),
      inboxOpts,
    });
    await registry.reconstitute();
    clientTopologyEnumerations = 0;
    registryTopologyEnumerations = 0;

    await engine.runSweep();

    expect({
      clientTopologyEnumerations,
      registryTopologyEnumerations,
    }).toEqual({
      clientTopologyEnumerations: 1,
      registryTopologyEnumerations: 0,
    });
    expect(mockClient.readScreen).toHaveBeenCalledTimes(3);
    expect(sweepDebugLogs.at(-1)).toMatch(
      /sweep timing topology_ms=\d+.*reconcile_ms=\d+.*total_ms=\d+/,
    );
  });

  it("guards every sweep-reachable mutation helper before its first side effect", () => {
    // Extracted engine collaborators (src/engine/*.ts) hold the bodies; the
    // engine keeps one-line delegates, so an extracted function wins.
    const engineDir = new URL("../src/engine/", import.meta.url);
    const source = [
      readFileSync(new URL("../src/agent-engine.ts", import.meta.url), "utf8"),
      ...readdirSync(engineDir)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFileSync(new URL(name, engineDir), "utf8")),
    ].join("\n");
    const guardedHelpers = [
      "maybeCaptureBootSessionId",
      "maybeMarkBootReady",
      "maybeMarkTaskDone",
      "maybeMarkCliExited",
      "maybeEscalateLiveHalt",
      "logLifecycleEvent",
      "notifyLifecycleEventForSweep",
      "publishSweepStatus",
      "evictSurfacelessForSweep",
      "purgeTerminalForSweep",
      "removeStateForSweep",
      "reconcileRolePlacements",
      "markIntentionalSurfaceCloses",
    ];

    for (const helper of guardedHelpers) {
      const extracted = [
        `export async function ${helper}(`,
        `export function ${helper}(`,
      ]
        .map((needle) => source.indexOf(needle))
        .filter((offset) => offset >= 0)
        .sort((left, right) => left - right)[0];
      const declaration = extracted ?? [
        `private async ${helper}(`,
        `private ${helper}(`,
        `async ${helper}(`,
      ]
        .map((needle) => source.indexOf(needle))
        .filter((offset) => offset >= 0)
        .sort((left, right) => left - right)[0];
      expect(declaration, `${helper} must exist`).toBeGreaterThanOrEqual(0);
      const bodyStart = source.indexOf("{", declaration);
      expect(
        source.slice(bodyStart + 1, bodyStart + 420),
        `${helper} must guard before writing or dispatching`,
      ).toMatch(/assertSweepInputCurrent\(/);
    }
  });

  it("hands the lock to a queued interactive waiter and resumes the sweep", async () => {
    const registry = engine.getRegistry();
    let releaseReconcile: (() => void) | undefined;
    const reconcileStarted = new Promise<void>((resolve) => {
      vi.spyOn(registry, "reconcile").mockImplementation(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseReconcile = release;
        });
        return new Set();
      });
    });
    const evict = vi.spyOn(registry, "evictSurfaceless");
    liveSurfaces = [makeSurface("surface:one")];

    const sweep = engine.runSweep();
    await reconcileStarted;
    let waiterRan = false;
    const waiter = engine.runLifecycleMutation(
      async () => {
        waiterRan = true;
      },
      { label: "interactive-test" },
    );
    expect(engine.lifecycleLockState().queue_depth).toBe(1);
    releaseReconcile?.();
    await Promise.all([sweep, waiter]);

    expect(waiterRan).toBe(true);
    expect(evict).toHaveBeenCalled();
    expect(engine.lifecycleLockState().sweep_yielded).toBe(1);
  });

  it("bounds an interactive lock wait during a 23-agent slow-screen sweep", async () => {
    const agentCount = 23;
    const readDelayMs = 100;
    for (let index = 0; index < agentCount; index += 1) {
      const surfaceId = `surface:slow-${index}`;
      stateMgr.writeState(makeRecord({
        agent_id: `slow-agent-${index}`,
        surface_id: surfaceId,
        workspace_id: "workspace:test",
      }));
      liveSurfaces.push(makeSurface(surfaceId));
    }
    let signalFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      signalFirstRead();
      await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      return { surface, text: "Working (1m 02s • esc to interrupt)", lines: 20, scrollback_used: false };
    });

    const sweep = engine.runSweep();
    await firstRead;
    const startedAt = performance.now();
    const waiter = engine.runLifecycleMutation(async () => {
      const updated = stateMgr.updateRecord("slow-agent-21", {
        task_summary: "interactive update",
      });
      engine.getRegistry().set(updated.agent_id, updated);
      stateMgr.removeState("slow-agent-22");
      engine.getRegistry().remove("slow-agent-22");
      liveSurfaces = liveSurfaces.filter((surface) => surface.ref !== "surface:slow-22");
    }, { label: "interactive-test" });
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const acquiredWithinBudget = await Promise.race([
      waiter.then(() => true),
      new Promise<false>((resolve) => {
        budgetTimer = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    if (budgetTimer) clearTimeout(budgetTimer);
    await Promise.all([sweep, waiter]);
    expect(acquiredWithinBudget, `interactive waiter took ${Math.round(performance.now() - startedAt)}ms while ${agentCount} screens each took ${readDelayMs}ms`).toBe(true);
    expect(stateMgr.readState("slow-agent-21")?.task_summary).toBe("interactive update");
    expect(stateMgr.readState("slow-agent-22")).toBeNull();
    mockClient.readScreen.mockImplementation(async (surface: string) => ({
      surface,
      text: "Working (1m 02s • esc to interrupt)",
      lines: 20,
      scrollback_used: false,
    }));
    await engine.runSweep();
    expect(stateMgr.readState("slow-agent-21")?.task_summary).toBe("interactive update");
    expect(stateMgr.readState("slow-agent-22")).toBeNull();
    expect(engine.getRegistry().get("slow-agent-22")).toBeNull();
  }, 20_000);

  it("lets a client screen read run during per-agent sweep work", async () => {
    for (let index = 0; index < 23; index += 1) {
      const surfaceId = `surface:cpu-${index}`;
      stateMgr.writeState(makeRecord({
        agent_id: `cpu-agent-${index}`,
        surface_id: surfaceId,
        workspace_id: "workspace:test",
      }));
      liveSurfaces.push(makeSurface(surfaceId));
    }
    let signalFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      signalFirstRead();
      const until = performance.now() + 15;
      while (performance.now() < until) { /* model synchronous parse/transport work */ }
      return { surface, text: "Working (1m 02s • esc to interrupt)", lines: 20, scrollback_used: false };
    });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    try {
      const sweep = engine.runSweep();
      await firstRead;
      const startedAt = performance.now();
      const clientRead = new Promise<number>((resolve) => {
        setTimeout(() => {
          void mockClient.readScreen("surface:operator").then(() => resolve(performance.now() - startedAt));
        }, 0);
      });
      const latencyMs = await clientRead;
      await sweep;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(latencyMs, `client read waited ${Math.round(latencyMs)}ms during the sweep; event-loop max ${Math.round(delay.max / 1e6)}ms`).toBeLessThan(1_000);
      expect(delay.max / 1e6).toBeLessThan(1_500);
    } finally {
      delay.disable();
    }
  }, 20_000);

  it("persists the in-progress sweep phase before slow I/O", async () => {
    stateMgr.writeState(makeRecord({
      agent_id: "slow-phase-agent",
      surface_id: "surface:phase",
      workspace_id: "workspace:test",
    }));
    liveSurfaces = [makeSurface("surface:phase")];
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      signalRead();
      await readHeld;
      return { surface, text: "Working", lines: 20, scrollback_used: false };
    });

    const sweep = engine.runSweep();
    await readStarted;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const inProgress = stateMgr.getEventLog().readEntries().filter(
      (entry) => "event_type" in entry && entry.event_type === "sweep_phase" && "phase" in entry && entry.phase === "reconcile_ms",
    );
    releaseRead();
    await sweep;
    expect(inProgress).toEqual([
      expect.objectContaining({
        stage: "started",
        agent_count: 1,
        lock_held: false,
      }),
    ]);
    const completed = stateMgr.getEventLog().readEntries().filter(
      (entry) => "event_type" in entry && entry.event_type === "sweep_phase" && "phase" in entry && entry.phase === "reconcile_ms",
    );
    expect(completed).toEqual([
      expect.objectContaining({ stage: "started" }),
      expect.objectContaining({ stage: "completed", duration_ms: expect.any(Number) }),
    ]);
    expect(stateMgr.getEventLog().readEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: "sweep_phase", phase: "summary", durations_ms: expect.objectContaining({ reconcile_ms: expect.any(Number) }) }),
    ]));
  });

  it("records a failed sweep summary with the failing phase", async () => {
    vi.spyOn(engine as any, "collectObservedSurfaceTopology").mockRejectedValueOnce(
      new Error("topology scan failed"),
    );

    await expect(engine.runSweep()).rejects.toThrow("topology scan failed");
    const summary = stateMgr.getEventLog().readEntries().find(
      (entry) => "event_type" in entry && entry.event_type === "sweep_phase" &&
        "phase" in entry && entry.phase === "summary",
    );
    expect(summary).toMatchObject({
      stage: "failed",
      failed_phase: "topology_ms",
    });
  });

  it("records the sweep's longest event-loop stall on its summary row (#810)", async () => {
    stateMgr.writeState(makeRecord({
      agent_id: "loop-stall-agent",
      surface_id: "surface:loop",
      workspace_id: "workspace:test",
    }));
    liveSurfaces = [makeSurface("surface:loop")];
    const quietScreen = async (surface: string) => ({
      surface, text: "Working", lines: 20, scrollback_used: false,
    });
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      // Hold the loop the way a blocking reconciler body would.
      const until = performance.now() + 80;
      while (performance.now() < until) { /* busy */ }
      return quietScreen(surface);
    });
    await engine.runSweep();
    mockClient.readScreen.mockImplementation(quietScreen);
    await engine.runSweep();

    const summaries = stateMgr.getEventLog().readEntries().filter(
      (entry) => "event_type" in entry && entry.event_type === "sweep_phase" &&
        "phase" in entry && entry.phase === "summary",
    ) as Array<{ loop_stall_max_ms?: number }>;
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.loop_stall_max_ms).toBeGreaterThanOrEqual(60);
    // No upper bound on the quiet sweep: machine load can stall any process
    // (#817). The per-sweep reset is pinned with an injected clock in
    // tests/loop-stall.test.ts.
    expect(summaries[1]?.loop_stall_max_ms).toEqual(expect.any(Number));
  });

  it("does not hold the lifecycle lock during one blocked screen read", async () => {
    stateMgr.writeState(makeRecord({
      agent_id: "blocked-read-agent",
      surface_id: "surface:blocked-read",
      workspace_id: "workspace:test",
    }));
    liveSurfaces = [makeSurface("surface:blocked-read")];
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      signalRead();
      await readHeld;
      return { surface, text: "Working", lines: 20, scrollback_used: false };
    });

    const sweep = engine.runSweep();
    await readStarted;
    let waiterRan = false;
    const waiter = engine.runLifecycleMutation(async () => {
      waiterRan = true;
      const updated = stateMgr.updateRecord("blocked-read-agent", {
        task_summary: "new interactive state",
      });
      engine.getRegistry().set(updated.agent_id, updated);
    }, { label: "interactive-test" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ranBeforeReadCompleted = waiterRan;
    releaseRead();
    await Promise.all([sweep, waiter]);
    expect(ranBeforeReadCompleted).toBe(true);
    expect(stateMgr.readState("blocked-read-agent")?.task_summary).toBe("new interactive state");
    expect(mockClient.setStatuses).not.toHaveBeenCalled();
  });

  it("rejects a stale two-agent sidebar snapshot after a direct stop write during another agent's unlocked read", async () => {
    for (const agentId of ["b-stopped-agent", "a-reading-agent"]) {
      const surfaceId = `surface:${agentId}`;
      const record = makeRecord({
        agent_id: agentId,
        surface_id: surfaceId,
        workspace_id: "workspace:test",
      });
      stateMgr.writeState(record);
      engine.getRegistry().set(agentId, record);
      liveSurfaces.push(makeSurface(surfaceId));
    }
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      if (surface === "surface:a-reading-agent") {
        signalRead();
        await readHeld;
      }
      return { surface, text: "Working (1m 02s • esc to interrupt)", lines: 20, scrollback_used: false };
    });

    const sweep = engine.runSweep();
    await readStarted;
    const stopped = stateMgr.updateRecord("b-stopped-agent", { state: "done" });
    engine.getRegistry().set(stopped.agent_id, stopped);
    releaseRead();
    await sweep;

    expect(stateMgr.readState("b-stopped-agent")?.state).toBe("done");
    expect(mockClient.setStatuses).not.toHaveBeenCalled();
    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "a-reading-agent",
      expect.stringContaining("state=working"),
      expect.anything(),
    );
    expect(mockClient.setStatus).not.toHaveBeenCalledWith(
      "b-stopped-agent",
      expect.anything(),
      expect.anything(),
    );
  });

  it("keeps reconciling twelve agents during unrelated lifecycle refreshes", async () => {
    for (let index = 0; index < 12; index += 1) {
      const agentId = `steady-agent-${index}`;
      const record = makeRecord({ agent_id: agentId, surface_id: `surface:${agentId}`, workspace_id: "workspace:test" });
      stateMgr.writeState(record);
      engine.getRegistry().set(agentId, record);
      liveSurfaces.push(makeSurface(record.surface_id));
    }
    let refreshOnRead = false;
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      if (refreshOnRead) {
        refreshOnRead = false;
        await engine.runLifecycleMutation(async () => {}, { label: "lifecycle-refresh-managed-metadata" });
      }
      return { surface, text: "Working (1m 02s • esc to interrupt)", lines: 20, scrollback_used: false };
    });
    for (let sweepIndex = 0; sweepIndex < 5; sweepIndex += 1) {
      const priorVersion = stateMgr.readState("steady-agent-11")?.version ?? 0;
      mockClient.setStatuses.mockClear();
      refreshOnRead = true;
      await engine.runSweep();
      if (sweepIndex === 0) {
        const updates = mockClient.setStatuses.mock.calls.flatMap(([batch]) => batch);
        expect(updates).toEqual(expect.arrayContaining([
          expect.objectContaining({ key: "steady-agent-11" }),
        ]));
      }
      expect(stateMgr.readState("steady-agent-11")?.version, `sweep ${sweepIndex} skipped the later row`).toBeGreaterThan(priorVersion);
    }
  }, 20_000);

  it("does not hold the lifecycle lock during topology enumeration", async () => {
    stateMgr.writeState(makeRecord({
      agent_id: "topology-race-agent",
      surface_id: "surface:topology-race",
      workspace_id: "workspace:test",
    }));
    liveSurfaces = [makeSurface("surface:topology-race")];
    const reconcile = vi.spyOn(engine.getRegistry(), "reconcile");
    let releaseTopology!: () => void;
    const topologyHeld = new Promise<void>((resolve) => { releaseTopology = resolve; });
    let signalTopology!: () => void;
    const topologyStarted = new Promise<void>((resolve) => { signalTopology = resolve; });
    mockClient.listWorkspaces.mockImplementation(async () => {
      signalTopology();
      await topologyHeld;
      return { workspaces: [makeWorkspace("workspace:test")] };
    });
    const sweep = engine.runSweep();
    await topologyStarted;
    let waiterRan = false;
    const waiter = engine.runLifecycleMutation(async () => {
      waiterRan = true;
      const updated = stateMgr.updateRecord("topology-race-agent", {
        task_summary: "newer lifecycle mutation",
      });
      engine.getRegistry().set(updated.agent_id, updated);
    }, { label: "interactive-test" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ranBeforeTopologyCompleted = waiterRan;
    releaseTopology();
    await Promise.all([sweep, waiter]);
    expect(ranBeforeTopologyCompleted).toBe(true);
    expect(reconcile).toHaveBeenCalled();
    expect(stateMgr.readState("topology-race-agent")?.task_summary).toBe("newer lifecycle mutation");
  });

  it("does not hold the lifecycle lock during a blocked watch screen read", async () => {
    const watchRegistryPath = join(TEST_DIR, "sweep-watches.json");
    const watchAgent = makeRecord({
      agent_id: "watch-agent",
      surface_id: "surface:watch-agent",
      workspace_id: "workspace:test",
    });
    stateMgr.writeState(watchAgent);
    engine.getRegistry().set(watchAgent.agent_id, watchAgent);
    liveSurfaces = [makeSurface(watchAgent.surface_id)];
    const notify = vi.fn(async () => {});
    engine = new AgentEngine(stateMgr, engine.getRegistry(), mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      watchRegistryPath,
      watchRegistryNow: () => 0,
      watchNotify: notify,
    });
    await armWatch({
      owner: "lead",
      target: watchAgent.agent_id,
      predicate: "done",
      deadline: 60_000,
    }, {
      registryPath: watchRegistryPath,
      now: () => 0,
      agentObservation: async () => ({ exists: true, state: "working", source: "fixture" }),
    });
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    let signalRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      signalRead();
      await readHeld;
      return { surface, text: "Working", lines: 20, scrollback_used: false };
    });

    const sweep = engine.runSweep();
    await readStarted;
    let waiterRan = false;
    const waiter = engine.runLifecycleMutation(async () => {
      waiterRan = true;
      const updated = stateMgr.updateRecord(watchAgent.agent_id, {
        task_summary: "newer watch target state",
      });
      engine.getRegistry().set(updated.agent_id, updated);
    }, { label: "interactive-test" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ranBeforeReadCompleted = waiterRan;
    releaseRead();
    await Promise.all([sweep, waiter]);
    expect(ranBeforeReadCompleted).toBe(true);
    expect(readWatchRegistry({ registryPath: watchRegistryPath }).watches[0]?.state).toBe("armed");
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not expose a sweep snapshot to concurrent terminal routing", async () => {
    const stableUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    (
      mockClient as unknown as Record<string, unknown>
    ).supportsStableSurfaceReads = true;
    (mockClient as unknown as Record<string, unknown>).getTransportHealth =
      () => ({ mode: "socket", degraded: false });
    stateMgr.writeState(
      makeRecord({
        agent_id: "concurrent-route-agent",
        surface_id: "surface:old",
        surface_uuid: stableUuid,
        workspace_id: "workspace:test",
        state: "working",
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:old"),
        id: stableUuid,
        workspace_ref: "workspace:test",
      },
    ];
    await engine.getRegistry().reconstitute();
    let releaseRead: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      mockClient.readScreen.mockImplementation(async (surface: string) => {
        releaseRead?.();
        liveSurfaces = [
          {
            ...makeSurface("surface:new"),
            id: stableUuid,
            workspace_ref: "workspace:test",
          },
        ];
        resolve();
        await new Promise<void>((release) => {
          releaseRead = release;
        });
        return {
          surface,
          text: "gpt-5.6 · Working",
          lines: 20,
          scrollback_used: false,
        };
      });
    });

    const sweep = engine.runSweep();
    await readStarted;
    const concurrentRoute = await engine.resolveAgentIoRoute(
      "concurrent-route-agent",
    );
    releaseRead?.();
    await sweep;

    expect(concurrentRoute.surface_id).toBe("surface:new");
  });

  it("binds the canonical observed UUID when persisted casing differs", async () => {
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

    expect(engine.getAgentState("case-normalized-seat")).toMatchObject({
      surface_id: "surface:case",
      surface_uuid: observedUuid,
    });
    expect(pushedStatuses(mockClient)).toEqual([
      expect.objectContaining({
        key: "case-normalized-seat",
        surface: "surface:case",
      }),
    ]);
  });

  it("pushes no mixed status row when the stable UUID moves during the screen read", async () => {
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
    expect(pushedStatuses(mockClient)).toEqual([]);
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
    expect(pushedStatuses(mockClient)).toEqual([]);
  });

  it("discovers and reconciles live seats exactly once during idempotent startup", async () => {
    const transcriptResolver = vi.fn(() => null);
    engine.dispose();
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: transcriptResolver,
      inboxOpts,
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
      text: "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)",
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
    expect(engine.getRegistry().list()).toEqual([
      expect.objectContaining({
        agent_id: "auto-codex-surface-42",
        surface_id: "surface:42",
      }),
    ]);
    expect(pushedStatuses(mockClient)).toEqual([
      expect.objectContaining({
        key: "auto-codex-surface-42",
        surface: "surface:42",
      }),
    ]);

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
    });
    mockClient.readScreen
      .mockResolvedValueOnce({
        surface: "surface:42",
        text: "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)",
        lines: 30,
        scrollback_used: false,
      })
      .mockResolvedValue({
        surface: "surface:42",
        text: "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\nImplemented the fix.\nTASK_DONE",
        lines: 30,
        scrollback_used: false,
      });
    const terminalDiscovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(terminalDiscovery);

    expect(deferredTranscriptResolver).not.toHaveBeenCalled();
    expect(
      engine.getAgentState("cmuxlayerCodex-pending-startup"),
    ).toMatchObject({
      state: "done",
      cli_session_id: null,
      transcript_session_capture_deferred: true,
    });

    engine.dispose();
    const restartedRegistry = new AgentRegistry(
      stateMgr,
      async () => liveSurfaces,
    );
    engine = new AgentEngine(stateMgr, restartedRegistry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: deferredTranscriptResolver,
      inboxOpts,
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

    liveSurfaces = [
      {
        ...makeSurface("surface:witness"),
        title: "unrelated live surface",
        workspace_ref: "workspace:other",
      },
    ];

    await engine.runSweep();

    expect(deferredTranscriptResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "cmuxlayerCodex-pending-startup",
        cli: "codex",
        state: "done",
      }),
    );
    expect(
      engine.getAgentState("cmuxlayerCodex-pending-startup"),
    ).toMatchObject({
      state: "done",
      cli_session_id: null,
      transcript_session_capture_deferred: true,
    });

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

  it("retains a successful deferred capture through the pending startup purge", async () => {
    const capturedSessionId = "87654321-4321-4321-8321-cba987654321";
    const deferredTranscriptResolver = vi.fn(() => ({
      session_id: capturedSessionId,
      path: "/tmp/codex-startup-purge-session.jsonl",
    }));
    stateMgr.writeState(
      makeRecord({
        agent_id: "cmuxlayerCodex-deferred-startup-purge",
        repo: "cmuxlayer",
        launcher_name: "cmuxlayerCodex",
        state: "done",
        transcript_session_capture_deferred: true,
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
    const restartedRegistry = new AgentRegistry(
      stateMgr,
      async () => liveSurfaces,
    );
    engine = new AgentEngine(stateMgr, restartedRegistry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: deferredTranscriptResolver,
      inboxOpts,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(discovery);

    expect(deferredTranscriptResolver).not.toHaveBeenCalled();

    await engine.runSweep();

    expect(deferredTranscriptResolver).toHaveBeenCalledTimes(1);
    expect(
      engine.getAgentState("cmuxlayerCodex-deferred-startup-purge"),
    ).toMatchObject({
      state: "done",
      cli_session_id: capturedSessionId,
      cli_session_path: "/tmp/codex-startup-purge-session.jsonl",
      transcript_session_capture_deferred: false,
    });
  });

  it("bounds unresolved deferred capture across restart and reaps the terminal row", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-17T20:00:00.000Z");
    vi.setSystemTime(startedAt);
    const deferredTranscriptResolver = vi.fn(() => null);
    stateMgr.writeState(
      makeRecord({
        agent_id: "cmuxlayerCodex-stuck-deferred-capture",
        repo: "cmuxlayer",
        launcher_name: "cmuxlayerCodex",
        role: "worker",
        state: "done",
        surface_id: "surface:missing",
        transcript_session_capture_deferred: true,
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:witness"),
        title: "unrelated live surface",
        workspace_ref: "workspace:other",
      },
    ];
    const makeDeferredEngine = () => {
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      return new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: deferredTranscriptResolver,
        inboxOpts,
      });
    };
    const discovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    engine.dispose();
    engine = makeDeferredEngine();
    await engine.initialize(discovery);
    await engine.runSweep();

    expect(deferredTranscriptResolver).toHaveBeenCalledTimes(1);
    expect(
      engine.getAgentState("cmuxlayerCodex-stuck-deferred-capture"),
    ).toMatchObject({
      cli_session_id: null,
      transcript_session_capture_deferred: true,
    });

    engine.dispose();
    engine = makeDeferredEngine();
    await engine.initialize(discovery);
    expect(deferredTranscriptResolver).toHaveBeenCalledTimes(1);

    for (let sweep = 1; sweep <= 3; sweep += 1) {
      vi.setSystemTime(startedAt.getTime() + sweep * 6_000);
      await engine.runSweep();
    }

    expect(deferredTranscriptResolver).toHaveBeenCalledTimes(3);
    expect(
      engine.getAgentState("cmuxlayerCodex-stuck-deferred-capture"),
    ).toBeNull();
  });

  it("clears an ineligible deferred marker without invoking the resolver", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-17T20:30:00.000Z");
    vi.setSystemTime(startedAt);
    const deferredTranscriptResolver = vi.fn(() => null);
    stateMgr.writeState(
      makeRecord({
        agent_id: "gemini-stale-deferred-capture",
        cli: "gemini",
        model: "gemini",
        launcher_name: "geminiWorker",
        role: "worker",
        state: "done",
        surface_id: "surface:missing",
        transcript_session_capture_deferred: true,
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:witness"),
        title: "unrelated live surface",
        workspace_ref: "workspace:other",
      },
    ];
    engine.dispose();
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: deferredTranscriptResolver,
      inboxOpts,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(discovery);
    await engine.runSweep();

    expect(deferredTranscriptResolver).not.toHaveBeenCalled();
    expect(engine.getAgentState("gemini-stale-deferred-capture")).toMatchObject(
      { transcript_session_capture_deferred: false },
    );

    vi.setSystemTime(startedAt.getTime() + 6_000);
    await engine.runSweep();

    expect(engine.getAgentState("gemini-stale-deferred-capture")).toBeNull();
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
      text: "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)",
      lines: 30,
      scrollback_used: false,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(discovery);

    expect(pushedStatuses(mockClient)).toEqual([
      expect.objectContaining({
        key: "auto-codex-surface-42",
        surface: "surface:42",
      }),
    ]);
  });

  it("preserves registry seats and pushes no status when topology enumeration is unknown", async () => {
    const record = makeRecord();
    stateMgr.writeState(record);
    liveSurfaces = [makeSurface("surface:42")];
    mockClient.listWorkspaces.mockRejectedValue(
      new Error("socket unavailable"),
    );
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.readScreen).not.toHaveBeenCalled();
    expect(pushedStatuses(mockClient)).toEqual([]);
    expect(engine.getAgentState(record.agent_id)).not.toBeNull();
  });

  it("preserves registry seats and pushes no status when topology is empty", async () => {
    const record = makeRecord();
    stateMgr.writeState(record);
    liveSurfaces = [makeSurface("surface:42")];
    mockClient.listWorkspaces.mockResolvedValue({ workspaces: [] });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(pushedStatuses(mockClient)).toEqual([]);
    expect(engine.getAgentState(record.agent_id)).not.toBeNull();
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
    const newlySurfacelessAgentIds = await engine.getRegistry().reconstitute();
    engine.enableStartupPurge({ retainAgentIds: newlySurfacelessAgentIds });

    await engine.runSweep();

    expect(engine.getAgentState("ghost-voicelayer-codex")).toMatchObject({
      state: "error",
      error: "Surface surface:ghost disappeared",
    });
    expect(
      pushedStatuses(mockClient).map((status) => status.surface),
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

    expect(
      engine.getAgentState("possibly-live-voicelayer-codex"),
    ).toMatchObject({
      surface_id: "surface:possibly-live",
      state: "working",
    });
  }, 10_000);

  it("preserves registry seats and pushes no status when topology enumeration is partial", async () => {
    const record = makeRecord();
    stateMgr.writeState(record);
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

    expect(pushedStatuses(mockClient)).toEqual([]);
    expect(engine.getAgentState(record.agent_id)).not.toBeNull();
  });

  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
    rmSync(TEST_DIR, { recursive: true, force: true });
    if (ORIGINAL_PROMPT_AUTO_RESOLVE === undefined) {
      delete process.env.CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE;
    } else {
      process.env.CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE =
        ORIGINAL_PROMPT_AUTO_RESOLVE;
    }
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
        worktree_path: "/home/test-user/Gits/cmuxlayer.wt/cmuxlayer-worker-p8",
        worktree_branch: "p8-sidebar",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    writeHeartbeat("a1", inboxOpts);
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "a1",
      "brainlayer | role=worker | state=working | health=healthy | blocked=- | last_prompt=Read and follow GOAL-p8-sidebar.md | worktree=/home/test-user/Gits/cmuxlayer.wt/cmuxlayer-worker-p8 | branch=p8-sidebar | report=n/a | pr=n/a",
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
  }, 20_000);

  it("discriminates health by state instead of marking every missing-session row unhealthy", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "booting-agent",
        state: "booting",
        surface_id: "surface:1",
        workspace_id: "workspace:cmuxlayer",
        cli_session_id: null,
        task_summary: "Boot worker",
        updated_at: new Date().toISOString(),
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

  it("keeps a prompt-blocked agent discoverable through startup purge after restart", async () => {
    const agentId = "auto-claude-frozen-across-restart";
    const surfaceRef = "surface:frozen-across-restart";
    const frozenPrompt = [
      "Bash command",
      "  cat /etc/shells",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, allow reading from etc/ from this project",
      "  3. No",
    ].join("\n");
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        surface_id: surfaceRef,
        workspace_id: "workspace:cmuxlayer",
        state: "error",
        error: "Auto-discovered agent reported a frozen state",
        blocked_on_prompt: true,
        blocked_on_prompt_since: "2026-08-14T13:00:00.000Z",
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface(surfaceRef),
        title: "",
        workspace_ref: "workspace:cmuxlayer",
      },
    ];
    mockClient.readScreen.mockResolvedValue({
      surface: surfaceRef,
      text: frozenPrompt,
      lines: frozenPrompt.split("\n").length,
      scrollback_used: false,
    });

    engine.dispose();
    const restartedRegistry = new AgentRegistry(
      stateMgr,
      async () => liveSurfaces,
    );
    engine = new AgentEngine(stateMgr, restartedRegistry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(discovery);
    await engine.runSweep();

    expect(engine.listAgents({ blocked_on_prompt: true })).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        blocked_on_prompt: true,
      }),
    ]);
    expect(mockClient.clearStatus).not.toHaveBeenCalledWith(
      agentId,
      expect.anything(),
    );
  });

  it("escalates prompt menus and never auto-resolves them, even with the retired flag set", async () => {
    // N1b: CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE is gone. A stale "1" in
    // a user's environment must not bring the key-sending path back.
    process.env.CMUXLAYER_EXPERIMENTAL_PROMPT_AUTO_RESOLVE = "1";
    const parentId = "prompt-freeze-parent";
    const parentSurface = "surface:prompt-freeze-parent";
    const cases = [
      {
        name: "codex-model-menu",
        cli: "codex" as const,
        screen: [
          ">_ OpenAI Codex",
          "",
          "› /model",
          "",
          "› 1. gpt-5.6-sol (current)",
          "  2. gpt-5.6-terra",
          "",
          "Press enter to confirm or esc to go back",
        ].join("\n"),
      },
      {
        name: "codex-update-menu",
        cli: "codex" as const,
        screen: readFileSync(
          new URL(
            "./fixtures/painpoints/codex-update-menu.txt",
            import.meta.url,
          ),
          "utf8",
        ),
      },
      {
        name: "reviewer-p1-apply-abort",
        cli: "codex" as const,
        screen: [
          ">_ OpenAI Codex",
          "› /model",
          "❯ 1. gpt-5.6-sol",
          "  2. gpt-5.6-terra",
          "",
          "Codex wants to run: rm -rf /home/test-user/Gits/cmuxlayer",
          "  1. Apply",
          "  2. Abort",
          "Press enter to confirm or esc to go back",
        ].join("\n"),
      },
    ].map((entry) => ({
      ...entry,
      agentId: `prompt-freeze-${entry.name}`,
      surfaceRef: `surface:prompt-freeze-${entry.name}`,
    }));
    const screens = new Map<string, string>([
      [parentSurface, "Claude Code\n✶ Coordinating… (4s · esc to interrupt)"],
      ...cases.map((entry) => [entry.surfaceRef, entry.screen] as const),
    ]);

    engine.dispose();
    engine = new AgentEngine(
      stateMgr,
      new AgentRegistry(stateMgr, async () => liveSurfaces),
      mockClient,
      {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        inboxOpts,
        haltAwaitingInputDwellMs: 0,
      },
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: parentId,
        surface_id: parentSurface,
        workspace_id: "workspace:cmuxlayer",
        cli: "claude",
        role: "orchestrator",
        state: "working",
        halt_escalation: false,
      }),
    );
    for (const entry of cases) {
      stateMgr.writeState(
        makeRecord({
          agent_id: entry.agentId,
          surface_id: entry.surfaceRef,
          workspace_id: "workspace:cmuxlayer",
          cli: entry.cli,
          role: "worker",
          parent_agent_id: parentId,
          spawn_depth: 1,
          state: "idle",
          blocked_on_prompt: false,
          blocked_on_prompt_since: null,
        }),
      );
    }
    liveSurfaces = [
      {
        ...makeSurface(parentSurface),
        title: "cmuxlayerClaude",
        workspace_ref: "workspace:cmuxlayer",
      },
      ...cases.map((entry) => ({
        ...makeSurface(entry.surfaceRef),
        title: "cmuxlayerCodex",
        workspace_ref: "workspace:cmuxlayer",
      })),
    ];
    mockClient.readScreen.mockImplementation(async (surface: string) => {
      const text = screens.get(surface);
      if (text === undefined)
        throw new Error(`missing prompt-freeze screen for ${surface}`);
      return {
        surface,
        text,
        lines: text.split("\n").length,
        scrollback_used: false,
      };
    });
    await engine.getRegistry().reconstitute();

    await engine.runSweep();
    await engine.runSweep();

    expect(mockClient.sendKey).not.toHaveBeenCalled();
    expect(
      stateMgr
        .getEventLog()
        .readEntries()
        .filter(
          (event) =>
            (event as { event_type?: string }).event_type === "resolved_prompt",
        ),
    ).toEqual([]);
    expect(
      engine
        .listAgents({ blocked_on_prompt: true })
        .map((agent) => agent.agent_id)
        .sort(),
    ).toEqual(cases.map((entry) => entry.agentId).sort());
    expect(
      stateMgr
        .getEventLog()
        .readEntries()
        .filter(
          (event) =>
            (event as { event_type?: string }).event_type ===
            "agent_halt_escalation",
        )
        .map((event) => (event as { agent_id: string }).agent_id)
        .sort(),
    ).toEqual(cases.map((entry) => entry.agentId).sort());
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

  it("keeps a managed id and its lineage when restart observes a live interactive overlay", async () => {
    const agentId = "cmuxlayerClaude-cfc87803";
    const surfaceUuid = "845F3804-D185-4C7D-90EC-48E78A6A65B3";
    stateMgr.writeState(
      makeRecord({
        agent_id: agentId,
        state: "error",
        surface_id: "surface:1025",
        surface_uuid: surfaceUuid,
        surface_provenance: "cmuxlayer_spawn",
        workspace_id: "workspace:cmuxlayer",
        repo: "cmuxlayer",
        cli: "claude",
        cli_session_id: "cfc87803-1111-4222-8333-444444444444",
        cli_session_path: "/durable/claude/cfc87803.jsonl",
        launcher_name: "cmuxlayerClaude",
        parent_agent_id: "cmuxlayerCodex-parent",
        spawn_depth: 1,
        role: "worker",
        error: "interactive_prompt",
      }),
    );
    liveSurfaces = [
      {
        ...makeSurface("surface:1025"),
        id: surfaceUuid,
        title: "cmuxlayerClaude [surface:1025]",
        workspace_ref: "workspace:cmuxlayer",
        current_directory: "/home/test-user/Gits/cmuxlayer/.worktrees/id-churn",
        working_directory_source: "surface",
      },
    ];
    const overlay = readFileSync(
      new URL(
        "./fixtures/painpoints/claude-ask-user-question-overlay.txt",
        import.meta.url,
      ),
      "utf8",
    );
    mockClient.readScreen.mockResolvedValue({
      surface: "surface:1025",
      text: overlay,
      lines: 30,
      scrollback_used: false,
    });
    const discovery = new AgentDiscovery({
      listSurfaces: async () => liveSurfaces,
      readScreen: (surface, opts) => mockClient.readScreen(surface, opts),
    });

    await engine.initialize(discovery);
    expect(
      engine
        .getRegistry()
        .list()
        .map((record) => ({ id: record.agent_id, state: record.state })),
    ).toEqual([{ id: agentId, state: "error" }]);
    await engine.runSweep();

    expect(engine.getAgentState(agentId)).toMatchObject({
      agent_id: agentId,
      state: "error",
      surface_uuid: surfaceUuid,
      cli_session_id: "cfc87803-1111-4222-8333-444444444444",
      cli_session_path: "/durable/claude/cfc87803.jsonl",
      parent_agent_id: "cmuxlayerCodex-parent",
      spawn_depth: 1,
      role: "worker",
    });
    expect(
      engine
        .getRegistry()
        .list()
        .filter((record) => record.surface_uuid === surfaceUuid)
        .map((record) => record.agent_id),
    ).toEqual([agentId]);

    mockClient.readScreen.mockResolvedValue({
      surface: "surface:1025",
      text: "Claude Code\nWorking (1s)\nImplementing the requested follow-up after the overlay.",
      lines: 30,
      scrollback_used: false,
    });
    discovery.invalidate();
    await engine.getRegistry().listMerged(discovery, { force: true });

    expect(engine.getAgentState(agentId)).toMatchObject({
      agent_id: agentId,
      state: "idle",
      cli_session_id: "cfc87803-1111-4222-8333-444444444444",
      parent_agent_id: "cmuxlayerCodex-parent",
      role: "worker",
    });
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
    expect(mockClient.clearStatus).toHaveBeenCalledWith("stale-surface-error", {
      workspace: "workspace:previous-session",
    });
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
    useActiveCodexScreen(mockClient);
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
    useActiveCodexScreen(mockClient);
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
      expect.stringContaining("health=healthy"),
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
      expect.stringContaining("health=healthy"),
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
    useActiveCodexScreen(mockClient);
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
    useActiveCodexScreen(mockClient);
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

  it("publishes the rest of a sweep when one agent status cannot resolve", async () => {
    useActiveCodexScreen(mockClient);
    for (const [agentId, workspace, surface] of [
      ["status-good", "workspace:alpha", "surface:good"],
      ["status-missing", "workspace:missing", "surface:missing"],
    ] as const) {
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          state: "working",
          surface_id: surface,
          workspace_id: workspace,
          cli_session_id: `session-${agentId}`,
        }),
      );
      liveSurfaces.push({ ...makeSurface(surface), workspace_ref: workspace });
      writeHeartbeat(agentId, inboxOpts);
    }
    mockClient.setStatuses.mockRejectedValueOnce(
      new Error(
        "cmux set-status failed for keys [status-missing]: Unable to resolve tab id",
      ),
    );
    mockClient.setStatus.mockImplementation(async (key: string) => {
      if (key === "status-missing") {
        throw new Error(
          "Unable to resolve tab id for workspace workspace:missing",
        );
      }
    });
    await engine.getRegistry().reconstitute();

    await expect(engine.runSweep()).resolves.toBeUndefined();

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "status-good",
      expect.stringContaining("state=working"),
      expect.objectContaining({ workspace: "workspace:alpha" }),
    );
    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "status-missing",
      expect.stringContaining("state=working"),
      expect.objectContaining({ workspace: "workspace:missing" }),
    );
    expect(sweepDebugLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "status-missing: Unable to resolve tab id for workspace workspace:missing",
        ),
      ]),
    );

    mockClient.setStatus.mockClear();
    await expect(engine.runSweep()).resolves.toBeUndefined();
    expect(mockClient.setStatus.mock.calls.map(([key]) => key)).toEqual([
      "status-missing",
    ]);
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
        launch_cwd: "/home/test-user/Gits/brainlayer",
        worktree_path: "/home/test-user/Gits/brainlayer",
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
      (call) => typeof call[0] === "string" && call[0].startsWith("spawned:"),
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
