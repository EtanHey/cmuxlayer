import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CmuxAppServerRuntime } from "../src/app-server-runtime.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-app-server-runtime-test");

function makeClient() {
  return {
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
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
      text:
        "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s • esc to interrupt)",
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
          state: "empty",
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
    client.listWorkspaces.mockRejectedValueOnce(new Error("socket unavailable"));
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });

    await expect((runtime as any).registry.hasLiveSurface("surface:1")).resolves.toBe(
      true,
    );

    runtime.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("scopes bridge turns, interrupts, and screen reads to the agent workspace", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const client = makeClient();
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = makeRecord();
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
});
