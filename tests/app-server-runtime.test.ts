import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CmuxAppServerRuntime as ProductionCmuxAppServerRuntime,
  type CmuxAppServerRuntimeOptions,
} from "../src/app-server-runtime.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-app-server-runtime-test");

class CmuxAppServerRuntime extends ProductionCmuxAppServerRuntime {
  constructor(opts: CmuxAppServerRuntimeOptions) {
    const ownerId = (): string | null => {
      const socketPath = (
        opts.client as { currentSocketPath?: () => string | null }
      ).currentSocketPath?.()?.trim();
      return socketPath ? `cmux:${socketPath}` : null;
    };
    super({
      ...opts,
      surfaceObserverOwnerIdProvider: ownerId,
      surfaceObserverEpochProvider: () => {
        const owner = ownerId();
        if (!owner) return null;
        const transportEpoch = (
          opts.client as {
            currentObserverTransportEpoch?: () => string | null;
          }
        ).currentObserverTransportEpoch?.();
        return `${owner}@${transportEpoch || "test"}`;
      },
    });
  }
}

function makeClient() {
  return {
    currentSocketPath: vi.fn(() => "/tmp/cmux-app-test.sock"),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    listStatus: vi.fn().mockResolvedValue([]),
    newSplit: vi.fn().mockResolvedValue({
      workspace: "workspace:app",
      surface: "surface:1",
      pane: "pane:1",
      title: "",
      type: "terminal",
    }),
    newSurface: vi.fn(),
    selectWorkspace: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:1",
      text: "codex> ",
      lines: 1,
      scrollback_used: false,
    }),
    closeSurface: vi.fn(),
    log: vi.fn(),
  } as any;
}

function makeRecord(): AgentRecord {
  const now = new Date().toISOString();
  return {
    agent_id: "agent-1",
    surface_id: "surface:1",
    workspace_id: "workspace:app",
    state: "ready",
    repo: "brainlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: null,
    task_summary: "test",
    pid: null,
    version: 1,
    created_at: now,
    updated_at: now,
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    boot_prompt_pending: false,
  };
}

describe("CmuxAppServerRuntime", () => {
  it("refreshes discovery within its TTL after an observer reconnect", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    let socketPath = "/tmp/cmux-primary.sock";
    let workspaceRef = "workspace:primary";
    let surfaceRef = "surface:primary";
    let surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const client = makeClient();
    client.currentSocketPath = vi.fn(() => socketPath);
    client.listWorkspaces.mockImplementation(async () => ({
      workspaces: [{ ref: workspaceRef }],
    }));
    client.listPanes.mockImplementation(async () => ({
      workspace_ref: workspaceRef,
      panes: [
        {
          ref: "pane:1",
          surface_count: 1,
          surface_refs: [surfaceRef],
          surface_ids: [surfaceUuid],
        },
      ],
    }));
    client.listPaneSurfaces.mockImplementation(async () => ({
      workspace_ref: workspaceRef,
      pane_ref: "pane:1",
      surfaces: [
        {
          id: surfaceUuid,
          ref: surfaceRef,
          title: "cmuxlayerCodex",
          type: "terminal",
        },
      ],
    }));
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });

    try {
      await expect(
        (runtime as any).discovery.scan(false),
      ).resolves.toMatchObject([{ surface_id: "surface:primary" }]);

      socketPath = "/tmp/cmux-secondary.sock";
      workspaceRef = "workspace:secondary";
      surfaceRef = "surface:secondary";
      surfaceUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

      await expect(
        (runtime as any).discovery.scan(false),
      ).resolves.toMatchObject([{ surface_id: "surface:secondary" }]);
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("rejects a surface enumeration assembled across an observer reconnect", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    let socketPath = "/tmp/cmux-primary.sock";
    const client = makeClient();
    client.currentSocketPath.mockImplementation(() => socketPath);
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:primary" }],
    });
    client.listPanes.mockImplementation(async () => {
      const result = {
        workspace_ref: "workspace:primary",
        panes: [
          {
            ref: "pane:shared",
            surface_count: 1,
            surface_refs: ["surface:shared"],
            surface_ids: [stableUuid],
          },
        ],
      };
      socketPath = "/tmp/cmux-secondary.sock";
      return result;
    });
    client.listPaneSurfaces.mockResolvedValue({
      // The replacement process recycled the same workspace/pane/ref. Its
      // ref-only response must not inherit the prior observer's pane UUID.
      workspace_ref: "workspace:primary",
      pane_ref: "pane:shared",
      surfaces: [
        {
          ref: "surface:shared",
          title: "replacement observer occupant",
          type: "terminal",
        },
      ],
    });
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const original = {
      ...makeRecord(),
      surface_id: "surface:shared",
      surface_uuid: stableUuid,
      surface_observer_id: "cmux:/tmp/cmux-primary.sock",
      workspace_id: "workspace:primary",
    };
    (runtime as any).stateMgr.writeState(original);

    try {
      await (runtime as any).registry.reconstitute();

      expect(
        (runtime as any).stateMgr.readState(original.agent_id),
      ).toMatchObject({
        surface_id: "surface:shared",
        surface_uuid: stableUuid,
        surface_observer_id: "cmux:/tmp/cmux-primary.sock",
        workspace_id: "workspace:primary",
      });
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("treats a successful subset of pane surfaces as non-authoritative", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const keptUuid = "11111111-2222-4333-8444-555555555555";
    const missingUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const client = makeClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:app" }],
    });
    client.listPanes.mockResolvedValue({
      workspace_ref: "workspace:app",
      panes: [
        {
          ref: "pane:1",
          surface_count: 2,
          surface_refs: ["surface:kept", "surface:missing"],
          surface_ids: [keptUuid, missingUuid],
        },
      ],
    });
    client.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:app",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:kept",
          id: keptUuid,
          title: "partial positive witness",
          type: "terminal",
        },
      ],
    });
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const original = {
      ...makeRecord(),
      surface_id: "surface:missing",
      surface_uuid: missingUuid,
      surface_observer_id: (runtime as any).registry.getObserverId(),
    };
    (runtime as any).stateMgr.writeState(original);

    try {
      await (runtime as any).registry.reconstitute({ confirmationMs: 0 });

      expect((runtime as any).stateMgr.readState(original.agent_id)).toMatchObject({
        state: "ready",
        error: null,
        surface_id: "surface:missing",
        surface_uuid: missingUuid,
      });
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("discovers and publishes a live seat on first initialize", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const client = makeClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [
        {
          ref: "workspace:app",
          title: "App",
          index: 0,
          selected: true,
          pinned: false,
        },
      ],
    });
    client.listPanes.mockResolvedValue({
      workspace_ref: "workspace:app",
      window_ref: "window:app",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:1"],
        },
      ],
    });
    client.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:app",
      window_ref: "window:app",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:1",
          title: "cmuxlayerCodex [surface:1]",
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    });
    client.readScreen.mockResolvedValue({
      surface: "surface:1",
      text: "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)",
      lines: 30,
      scrollback_used: false,
    });
    const publisher = {
      publish: vi.fn(),
      dispose: vi.fn(),
    };
    const runtime = new CmuxAppServerRuntime({
      client,
      stateDir: TEST_DIR,
      fleetSidebarPublisher: publisher,
    });

    try {
      await runtime.initialize();

      expect(publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "populated",
          observedLiveSurfaceRefs: ["surface:1"],
          snapshot: expect.objectContaining({
            seatCount: 1,
            lanes: [
              expect.objectContaining({
                key: "cmuxlayer",
                seats: [
                  expect.objectContaining({
                    surfaceRef: "surface:1",
                    screenState: "working",
                  }),
                ],
              }),
            ],
          }),
        }),
      );
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("forwards an injected fleet publisher to the reconciler and disposes it", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const publisher = {
      publish: vi.fn(),
      dispose: vi.fn(),
    };
    const runtime = new CmuxAppServerRuntime({
      client: makeClient(),
      stateDir: TEST_DIR,
      fleetSidebarPublisher: publisher,
    });

    try {
      await (runtime as any).engine.runSweep();

      expect(publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "unknown",
          observedLiveSurfaceRefs: [],
          snapshot: {
            seatCount: 0,
            activeCount: 0,
            lanes: [],
          },
        }),
      );
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    expect(publisher.dispose).toHaveBeenCalledOnce();
  });

  it("does not collapse surface listing failures into an absent surface", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const client = makeClient();
    client.listWorkspaces.mockRejectedValueOnce(
      new Error("socket unavailable"),
    );
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });

    await expect(
      (runtime as any).registry.hasLiveSurface("surface:1"),
    ).resolves.toBe(true);

    runtime.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("rejects contradictory pane and surface UUIDs before registry mutation", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const client = makeClient();
    client.currentSocketPath = vi.fn(() => "/tmp/cmux-conflict.sock");
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:app" }],
    });
    client.listPanes.mockResolvedValue({
      workspace_ref: "workspace:app",
      panes: [
        {
          ref: "pane:1",
          surface_count: 1,
          surface_refs: ["surface:shared"],
          surface_ids: ["11111111-2222-4333-8444-555555555555"],
        },
      ],
    });
    client.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:app",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:shared",
          id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
          title: "contradictory identity",
          type: "terminal",
        },
      ],
    });
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = {
      ...makeRecord(),
      surface_id: "surface:shared",
      surface_uuid: "11111111-2222-4333-8444-555555555555",
      surface_observer_id: "cmux:/tmp/cmux-conflict.sock",
      workspace_id: "workspace:old",
    };
    (runtime as any).stateMgr.writeState(record);

    try {
      await (runtime as any).registry.reconstitute({ confirmationMs: 0 });

      expect(
        (runtime as any).stateMgr.readState(record.agent_id),
      ).toMatchObject({
        state: "ready",
        error: null,
        surface_id: "surface:shared",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "workspace:old",
      });
      await expect(
        (runtime as any).registry.isSurfaceAlive(record),
      ).resolves.toBe(true);
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("quarantines rows owned by the prior socket after a runtime reconnect", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    let socketPath = "/tmp/cmux-primary.sock";
    let workspaceRef = "workspace:primary";
    const client = makeClient();
    client.currentSocketPath = vi.fn(() => socketPath);
    client.listWorkspaces.mockImplementation(async () => ({
      workspaces: [{ ref: workspaceRef }],
    }));
    client.listPanes.mockImplementation(async () => ({
      workspace_ref: workspaceRef,
      panes: [
        {
          ref: "pane:1",
          surface_count: 1,
          surface_refs: ["surface:shared"],
        },
      ],
    }));
    client.listPaneSurfaces.mockImplementation(async () => ({
      workspace_ref: workspaceRef,
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:shared",
          title: "shared mutable ref",
          type: "terminal",
        },
      ],
    }));

    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const original = {
      ...makeRecord(),
      surface_id: "surface:shared",
      workspace_id: workspaceRef,
      surface_observer_id: "cmux:/tmp/cmux-primary.sock",
    };
    (runtime as any).stateMgr.writeState(original);

    try {
      await (runtime as any).registry.reconstitute();

      socketPath = "/tmp/cmux-secondary.sock";
      workspaceRef = "workspace:secondary";
      await (runtime as any).registry.reconcile();

      expect(
        (runtime as any).stateMgr.readState(original.agent_id),
      ).toMatchObject({
        workspace_id: "workspace:primary",
        surface_observer_id: "cmux:/tmp/cmux-primary.sock",
      });
      expect((runtime as any).registry.getObserverId()).toBe(
        "cmux:/tmp/cmux-secondary.sock",
      );
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("scopes bridge turns, interrupts, and screen reads to the agent workspace", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const client = makeClient();
    client.currentSocketPath = vi.fn(() => "/tmp/cmux-app.sock");
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:app" }],
    });
    client.listPanes.mockResolvedValue({
      workspace_ref: "workspace:app",
      window_ref: "window:app",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:1"],
          selected_surface_ref: "surface:1",
        },
      ],
    });
    client.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:app",
      window_ref: "window:app",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:1",
          title: "agent",
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    });
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = {
      ...makeRecord(),
      surface_observer_id: (runtime as any).registry.getObserverId(),
    };
    (runtime as any).stateMgr.writeState(record);
    (runtime as any).registry.set(record.agent_id, record);

    await runtime.sendTurn({ threadId: "agent-1", text: "hello" });
    await runtime.interruptTurn("agent-1");
    await runtime.readScreen("agent-1");

    expect(client.send).toHaveBeenCalledWith("surface:1", "hello", {
      workspace: "workspace:app",
    });
    expect(client.sendKey).toHaveBeenCalledWith("surface:1", "return", {
      workspace: "workspace:app",
    });
    expect(client.sendKey).toHaveBeenCalledWith("surface:1", "c-c", {
      workspace: "workspace:app",
    });
    expect(client.readScreen).toHaveBeenCalledWith("surface:1", {
      workspace: "workspace:app",
      lines: 40,
    });

    runtime.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("blocks bridge turns when the bound workspace is in manual mode", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const client = makeClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:app" }],
    });
    client.listPanes.mockResolvedValue({
      workspace_ref: "workspace:app",
      panes: [
        {
          ref: "pane:1",
          surface_count: 1,
          surface_refs: ["surface:1"],
          surface_ids: [stableUuid],
        },
      ],
    });
    client.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:app",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:1",
          id: stableUuid,
          title: "agent",
          type: "terminal",
        },
      ],
    });
    client.listStatus.mockResolvedValue([
      { key: "mode.control", value: "manual" },
    ]);
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = {
      ...makeRecord(),
      surface_uuid: stableUuid,
      surface_observer_id: (runtime as any).registry.getObserverId(),
    };
    (runtime as any).stateMgr.writeState(record);
    (runtime as any).registry.set(record.agent_id, record);

    try {
      await expect(
        runtime.sendTurn({ threadId: record.agent_id, text: "do not send" }),
      ).rejects.toThrow(/manual mode/i);
      expect(client.send).not.toHaveBeenCalled();
      expect(client.sendKey).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("blocks bridge interrupts when the bound workspace is in manual mode", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const client = makeClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:app" }],
    });
    client.listPanes.mockResolvedValue({
      workspace_ref: "workspace:app",
      panes: [
        {
          ref: "pane:1",
          surface_count: 1,
          surface_refs: ["surface:1"],
          surface_ids: [stableUuid],
        },
      ],
    });
    client.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:app",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:1",
          id: stableUuid,
          title: "agent",
          type: "terminal",
        },
      ],
    });
    client.listStatus.mockResolvedValue([
      { key: "mode.control", value: "manual" },
    ]);
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = {
      ...makeRecord(),
      surface_uuid: stableUuid,
      surface_observer_id: (runtime as any).registry.getObserverId(),
    };
    (runtime as any).stateMgr.writeState(record);
    (runtime as any).registry.set(record.agent_id, record);

    try {
      await expect(runtime.interruptTurn(record.agent_id)).rejects.toThrow(
        /manual mode/i,
      );
      expect(client.sendKey).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("blocks starting a thread in a selected manual workspace", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const client = makeClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [
        {
          ref: "workspace:app",
          title: "brainlayer",
          selected: true,
          current_directory: "/Users/test/Gits/brainlayer",
        },
      ],
    });
    client.listStatus.mockResolvedValue([
      { key: "mode.control", value: "manual" },
    ]);
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const spawnAgent = vi
      .spyOn((runtime as any).engine, "spawnAgent")
      .mockRejectedValue(new Error("spawn should be gated"));

    try {
      await expect(
        runtime.startThread({ cwd: "/Users/test/Gits/brainlayer" }),
      ).rejects.toThrow(/manual mode/i);
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(client.newSplit).not.toHaveBeenCalled();
      expect(client.newSurface).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("re-resolves the stable UUID before every bridge chunk and Return", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    let liveSurfaceRef = "surface:first";
    const client = makeClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:app" }],
    });
    client.listPanes.mockImplementation(async () => ({
      workspace_ref: "workspace:app",
      panes: [
        {
          ref: "pane:1",
          surface_count: 1,
          surface_refs: [liveSurfaceRef],
          surface_ids: [stableUuid],
        },
      ],
    }));
    client.listPaneSurfaces.mockImplementation(async () => ({
      workspace_ref: "workspace:app",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: liveSurfaceRef,
          id: stableUuid,
          title: "agent",
          type: "terminal",
        },
      ],
    }));
    client.send.mockImplementation(async () => {
      liveSurfaceRef =
        client.send.mock.calls.length === 1
          ? "surface:second"
          : "surface:third";
    });
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = {
      ...makeRecord(),
      surface_id: "surface:first",
      surface_uuid: stableUuid,
      surface_observer_id: (runtime as any).registry.getObserverId(),
    };
    (runtime as any).stateMgr.writeState(record);
    (runtime as any).registry.set(record.agent_id, record);

    try {
      await runtime.sendTurn({
        threadId: record.agent_id,
        text: "x".repeat(501),
      });

      expect(client.send).toHaveBeenNthCalledWith(
        1,
        "surface:first",
        "x".repeat(500),
        { workspace: "workspace:app" },
      );
      expect(client.send).toHaveBeenNthCalledWith(2, "surface:second", "x", {
        workspace: "workspace:app",
      });
      expect(client.sendKey).toHaveBeenCalledWith("surface:third", "return", {
        workspace: "workspace:app",
      });
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("re-resolves the stable UUID after the manual-mode check before interrupting", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    let liveSurfaceRef = "surface:old";
    const client = makeClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:app" }],
    });
    client.listPanes.mockImplementation(async () => ({
      workspace_ref: "workspace:app",
      panes: [
        {
          ref: "pane:1",
          surface_count: 1,
          surface_refs: [liveSurfaceRef],
          surface_ids: [stableUuid],
        },
      ],
    }));
    client.listPaneSurfaces.mockImplementation(async () => ({
      workspace_ref: "workspace:app",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: liveSurfaceRef,
          id: stableUuid,
          title: "agent",
          type: "terminal",
        },
      ],
    }));
    client.listStatus.mockImplementation(async () => {
      liveSurfaceRef = "surface:new";
      return [];
    });
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = {
      ...makeRecord(),
      surface_id: "surface:old",
      surface_uuid: stableUuid,
      surface_observer_id: (runtime as any).registry.getObserverId(),
    };
    (runtime as any).stateMgr.writeState(record);
    (runtime as any).registry.set(record.agent_id, record);

    try {
      await runtime.interruptTurn(record.agent_id);

      expect(client.sendKey).toHaveBeenCalledWith("surface:new", "c-c", {
        workspace: "workspace:app",
      });
      expect(client.sendKey).not.toHaveBeenCalledWith(
        "surface:old",
        "c-c",
        expect.anything(),
      );
    } finally {
      runtime.dispose();
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("re-resolves a moved UUID for bridge writes, interrupts, and reads", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const client = makeClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:new" }],
    });
    client.listPanes.mockResolvedValue({
      workspace_ref: "workspace:new",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 2,
          surface_refs: ["surface:old", "surface:new"],
          surface_ids: ["uuid-foreign", stableUuid],
          selected_surface_ref: "surface:new",
        },
      ],
    });
    client.listPaneSurfaces.mockResolvedValue({
      workspace_ref: "workspace:new",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:old",
          id: "uuid-foreign",
          title: "foreign",
          type: "terminal",
          index: 0,
          selected: false,
        },
        {
          ref: "surface:new",
          id: stableUuid,
          title: "agent",
          type: "terminal",
          index: 1,
          selected: true,
        },
      ],
    });
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = {
      ...makeRecord(),
      surface_uuid: stableUuid,
      surface_id: "surface:old",
      workspace_id: "workspace:old",
    };
    (runtime as any).stateMgr.writeState(record);
    (runtime as any).registry.set(record.agent_id, record);

    await runtime.sendTurn({ threadId: "agent-1", text: "hello" });
    await runtime.interruptTurn("agent-1");
    await runtime.readScreen("agent-1");

    expect(client.send).toHaveBeenCalledWith("surface:new", "hello", {
      workspace: "workspace:new",
    });
    expect(client.sendKey).toHaveBeenCalledWith("surface:new", "c-c", {
      workspace: "workspace:new",
    });
    expect(client.readScreen).toHaveBeenCalledWith("surface:new", {
      workspace: "workspace:new",
      lines: 40,
    });
    expect(client.send).not.toHaveBeenCalledWith(
      "surface:old",
      expect.anything(),
      expect.anything(),
    );

    runtime.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});
