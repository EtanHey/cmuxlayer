import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentEngine,
  RetryableDeliveryError,
  assertLauncherAvailable,
  buildLaunchCommand,
  buildRawResumeCommand,
  buildResumeCommand,
  extractSessionId,
  resolveSweepTiming,
} from "../src/agent-engine.js";
import { launcherNameCandidates } from "../src/launcher-registry.js";
import { toAgentStatePayload } from "../src/agent-facade.js";
import { StateManager } from "../src/state-manager.js";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
} from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import {
  MAX_CHILDREN,
  MAX_RESPAWN_ATTEMPTS,
  type AgentRecord,
  type AgentRoute,
  type CloseForensicsEvent,
} from "../src/agent-types.js";
import { SpawnGuard, SpawnRateLimitedError } from "../src/spawn-guard.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";
import { dispatch, readInbox, writeHeartbeat } from "../src/inbox.js";
import { readWatchRegistry } from "../src/watch-spec.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-engine");
const DEAD_CODEX_SHELL_SCREEN = (
  JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/live/codex-dead-pane-shell-with-stale-banner.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { lines_80: string }
).lines_80;

function mockSpawnExit(code: number): {
  kill: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
} {
  const child = {
    kill: vi.fn(),
    once: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      if (event === "exit") {
        queueMicrotask(() => callback(code, null));
      }
      return child;
    }),
  };
  return child;
}

function makeMockClient(overrides?: Partial<CmuxClient>): CmuxClient {
  return {
    newSplit: vi.fn().mockImplementation(async (_direction, opts) => ({
      workspace: opts?.workspace ?? "ws:1",
      surface: "surface:new",
      surface_id: "11111111-2222-4333-8444-555555555555",
      pane: "pane:1",
      title: "",
      type: "terminal",
    }) satisfies CmuxNewSplitResult),
    newSurface: vi.fn().mockImplementation(async (opts) => ({
      workspace: opts?.workspace ?? "ws:1",
      surface: "surface:new",
      surface_id: "11111111-2222-4333-8444-555555555555",
      pane: opts.pane,
      title: "",
      type: "terminal",
    })),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:new",
      text: "$ ",
      lines: 20,
      scrollback_used: false,
    }),
    focusSurface: vi.fn().mockResolvedValue(undefined),
    renameTab: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    moveSurface: vi.fn().mockResolvedValue({
      ok: true,
      workspace: "ws:1",
      surface: "surface:new",
      pane: "pane:1",
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    selectWorkspace: vi.fn().mockResolvedValue(undefined),
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

const SPAWN_SURFACE_UUID = "11111111-2222-4333-8444-555555555555";

function makeSpawnSurface(): CmuxSurface {
  return { ...makeSurface("surface:new"), id: SPAWN_SURFACE_UUID };
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
    role: "worker",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    respawn_attempts: 0,
    user_killed: false,
    ...overrides,
  };
}

function writeCodexDoneTranscript(path: string): void {
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "019eab06-57d6-72b1-b3a8-6cf98a30a3f6",
          cwd: "/Users/etanheyman/Gits/cmuxlayer",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "019eab07-94c8-7610-be92-95610333aa91",
          last_agent_message: "Implemented the fix.\n\nTASK_DONE",
        },
      }),
    ].join("\n"),
  );
}

describe("AgentEngine", () => {
  let stateMgr: StateManager;
  let mockClient: CmuxClient;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];
  let previousTaskDoneAutoArchive: string | undefined;

  beforeEach(() => {
    previousTaskDoneAutoArchive = process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE;
    delete process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE;
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => mockSpawnExit(1));
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    const workspaceForSurface = (surface: CmuxSurface): string =>
      surface.workspace_ref ??
      stateMgr
        .listStates()
        .find((record) => record.surface_id === surface.ref)?.workspace_id ??
      "";
    (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        workspaces: [...new Set(liveSurfaces.map(workspaceForSurface))].map(
          (ref, index) => ({
            ref,
            title: ref,
            index,
            selected: index === 0,
            pinned: false,
          }),
        ),
      }),
    );
    (mockClient.listPanes as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ workspace }: { workspace?: string } = {}) => {
        const workspaceRef = workspace ?? "";
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
    (
      mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
    ).mockImplementation(
      async ({ workspace, pane }: { workspace?: string; pane?: string } = {}) => {
        const workspaceRef = workspace ?? "";
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
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts: { baseDir: TEST_DIR },
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
    if (previousTaskDoneAutoArchive === undefined) {
      delete process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE;
    } else {
      process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE =
        previousTaskDoneAutoArchive;
    }
  });

  async function runConfirmedSurfaceAbsenceSweep(): Promise<void> {
    const firstObservedAt = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(firstObservedAt);
    try {
      await engine.runSweep();
      nowSpy.mockReturnValue(
        firstObservedAt + SURFACE_EVICTION_CONFIRMATION_MS + 1,
      );
      await engine.runSweep();
    } finally {
      nowSpy.mockRestore();
    }
  }

  it("agent watches judge the live screen instead of registry state", async () => {
    const watchRegistryPath = join(TEST_DIR, "watch-specs.json");
    const surfaceUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const worker = makeRecord({
      agent_id: "worker-a",
      surface_id: "surface:watch-worker",
      surface_uuid: surfaceUuid,
      workspace_id: "workspace:watch",
      state: "done",
    });
    stateMgr.writeState(worker);
    liveSurfaces.push({
      ...makeSurface(worker.surface_id),
      id: surfaceUuid,
      workspace_ref: worker.workspace_id,
    });
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    await registry.reconstitute();
    const notify = vi.fn().mockResolvedValue(true);
    let now = 1_000;
    const watchEngine = new AgentEngine(stateMgr, registry, mockClient, {
      watchRegistryPath,
      watchRegistryNow: () => now,
      watchNotify: notify,
      sessionIdentityResolver: () => null,
      fleetSidebarPublisher: { publish: () => {}, dispose: () => {} },
    });
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
      surface: worker.surface_id,
      text: ["OpenAI Codex", "Model: gpt-5.4", "", "›"].join("\n"),
      lines: 30,
      scrollback_used: false,
    });

    const armed = await watchEngine.armWatch({
      owner: "lead-a",
      target: worker.agent_id,
      predicate: "done",
      deadline: 10_000,
    });
    now = 2_000;
    await watchEngine.runSweep();

    expect(notify).not.toHaveBeenCalled();
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches[0],
    ).toMatchObject({
      watch_id: armed.watch_id,
      state: "armed",
      observed_value: "idle",
      liveness_source: `screen:${surfaceUuid}`,
      liveness: { value: true, source: "screen" },
    });
    watchEngine.dispose();
  });

  describe("spawnAgent", () => {
    it("rate-limits spawn storms before creating extra surfaces", async () => {
      let nowMs = 0;
      const guardedEngine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          spawnPreflight: async () => {},
          spawnGuard: new SpawnGuard(
            {
              maxPerWindow: 8,
              maxPerWorkspacePerWindow: 8,
              windowMs: 6000,
            },
            () => nowMs,
          ),
        },
      );

      let rejected = 0;
      for (let i = 0; i < 44; i++) {
        try {
          await guardedEngine.spawnAgent({
            repo: "brainlayer",
            model: "codex",
            cli: "codex",
            prompt: "Fix gap F",
            workspace: "workspace:brainlayer",
          });
        } catch (error) {
          expect(error).toBeInstanceOf(SpawnRateLimitedError);
          rejected++;
        }
      }

      expect(rejected).toBe(36);
      expect(mockClient.newSplit).toHaveBeenCalledTimes(8);
      expect(mockClient.newSurface).not.toHaveBeenCalled();
      guardedEngine.dispose();
    });

    it("creates a cmux surface and returns agent handle", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Fix gap F",
      });

      expect(result.agent_id).toMatch(/^brainlayerClaude-[a-f0-9]{8}$/);
      expect(result.surface_id).toBe("surface:new");
      expect(result.state).toBe("booting");
      expect(engine.getAgentState(result.agent_id)?.surface_uuid).toBe(
        "11111111-2222-4333-8444-555555555555",
      );
    });

    it("refuses created-surface focus when the observer changes before focus mutation", async () => {
      engine.dispose();
      const ownerId = "cmux:/tmp/cmux.sock#socket=1:2:3:4";
      let observerEpoch = `${ownerId}@socket:1`;
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        {
          observerIdProvider: () => ownerId,
          observerEpochProvider: () => observerEpoch,
        },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.focusSurface as ReturnType<typeof vi.fn>).mockImplementation(
        async (
          _surface: string,
          opts?: { beforeMutation?: () => Promise<void> },
        ) => {
          observerEpoch = `${ownerId}@socket:2`;
          await opts?.beforeMutation?.();
        },
      );

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Do not focus across an observer epoch",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/surface observer changed.*agent focus/i);

      expect(mockClient.focusSurface).toHaveBeenCalledWith(
        "surface:new",
        expect.objectContaining({ beforeMutation: expect.any(Function) }),
      );
      expect(stateMgr.listStates()).toHaveLength(0);
    });

    it.each([
      {
        label: "explicit Claude worker",
        cli: "claude" as const,
        role: "worker" as const,
        expectedRole: "worker" as const,
      },
      {
        label: "no-role harness-neutral fallback",
        cli: "claude" as const,
        role: undefined,
        expectedRole: "worker" as const,
      },
      {
        label: "explicit Codex orchestrator",
        cli: "codex" as const,
        role: "orchestrator" as const,
        expectedRole: "orchestrator" as const,
      },
    ])(
      "persists the $label role on managed spawn records",
      async ({ cli, role, expectedRole }) => {
        const result = await engine.spawnAgent({
          repo: "brainlayer",
          cli,
          prompt: "Verify authoritative role",
          ...(role ? { role } : {}),
        });

        expect(engine.getAgentState(result.agent_id)?.role).toBe(expectedRole);
      },
    );

    it("assigns each managed surface a launcher-preserving unique seat title", async () => {
      (
        mockClient.newSplit as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        workspace: "ws:1",
        surface: "surface:first-worker",
        pane: "pane:1",
        title: "",
        type: "terminal",
      });
      (
        mockClient.newSplit as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        workspace: "ws:1",
        surface: "surface:second-worker",
        pane: "pane:1",
        title: "",
        type: "terminal",
      });

      await engine.spawnAgent({
        repo: "brainlayer",
        cli: "codex",
        prompt: "First worker",
      });
      await engine.spawnAgent({
        repo: "brainlayer",
        cli: "codex",
        prompt: "Second worker",
      });

      expect(mockClient.renameTab).toHaveBeenNthCalledWith(
        1,
        "surface:first-worker",
        "brainlayerCodex [surface:first-worker]",
        { workspace: "ws:1" },
      );
      expect(mockClient.renameTab).toHaveBeenNthCalledWith(
        2,
        "surface:second-worker",
        "brainlayerCodex [surface:second-worker]",
        { workspace: "ws:1" },
      );
    });

    it("enforces max children when parent and children are rehydrated from disk", async () => {
      const parent = makeRecord({
        agent_id: "parent-claude",
        surface_id: "surface:parent",
        state: "ready",
        cli: "claude",
        spawn_depth: 0,
      });
      stateMgr.writeState(parent);
      for (let i = 0; i < MAX_CHILDREN; i++) {
        stateMgr.writeState(
          makeRecord({
            agent_id: `child-${i}`,
            surface_id: `surface:child-${i}`,
            state: "ready",
            cli: "codex",
            parent_agent_id: parent.agent_id,
            spawn_depth: parent.spawn_depth + 1,
          }),
        );
      }

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Fix gap F",
          parent_agent_id: parent.agent_id,
        }),
      ).rejects.toThrow(`Max children exceeded: ${MAX_CHILDREN}`);
      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.newSurface).not.toHaveBeenCalled();
    });

    it("does not count terminal children against max children after disk rehydration", async () => {
      const parent = makeRecord({
        agent_id: "parent-with-terminal-children",
        surface_id: "surface:parent",
        state: "ready",
        cli: "claude",
        spawn_depth: 0,
      });
      stateMgr.writeState(parent);
      for (let i = 0; i < MAX_CHILDREN; i++) {
        stateMgr.writeState(
          makeRecord({
            agent_id: `terminal-child-${i}`,
            surface_id: `surface:terminal-child-${i}`,
            state: i % 2 === 0 ? "done" : "error",
            cli: "codex",
            parent_agent_id: parent.agent_id,
            spawn_depth: parent.spawn_depth + 1,
          }),
        );
      }

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Fix gap F",
          parent_agent_id: parent.agent_id,
        }),
      ).resolves.toMatchObject({
        surface_id: "surface:new",
        state: "booting",
      });
    });

    it("captures session identity before surfacing launch command failures", async () => {
      const sessionId = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:new"),
      ]);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: (agent) =>
          agent.surface_id === "surface:new"
            ? { session_id: sessionId, path: null }
            : null,
        launchCommandSender: async () => {
          throw new Error(
            "Timed out after 15000ms waiting for agent launch readiness on surface:new",
          );
        },
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "Fix gap F",
        }),
      ).rejects.toThrow(/waiting for agent launch readiness/);

      const failedAgent = engine
        .listAgents()
        .find((agent) => agent.surface_id === "surface:new");
      expect(failedAgent).toMatchObject({
        state: "error",
        error: expect.stringContaining("Launch failed:"),
        cli_session_id: sessionId,
        cli_session_path: null,
      });
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

    it("marks a post-launch disappeared surface as error and attempts cleanup", async () => {
      vi.useFakeTimers();
      try {
        engine.dispose();
        engine = new AgentEngine(
          stateMgr,
          new AgentRegistry(stateMgr, async () => liveSurfaces),
          mockClient,
          {
            spawnPreflight: async () => {},
            postSpawnLivenessMs: 0,
          },
        );

        const result = await engine.spawnAgent({
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "Fix gap F",
        });

        expect(stateMgr.readState(result.agent_id)?.state).toBe("booting");
        liveSurfaces = [makeSurface("surface:other-live")];

        await vi.runOnlyPendingTimersAsync();

        expect(stateMgr.readState(result.agent_id)).toMatchObject({
          state: "booting",
          error: "Post-spawn liveness failed: surface surface:new is not live",
          quality: "degraded",
        });
        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a healthy post-launch surface booting", async () => {
      vi.useFakeTimers();
      try {
        liveSurfaces = [makeSpawnSurface()];
        engine.dispose();
        engine = new AgentEngine(
          stateMgr,
          new AgentRegistry(stateMgr, async () => liveSurfaces),
          mockClient,
          {
            spawnPreflight: async () => {},
            postSpawnLivenessMs: 0,
          },
        );

        const result = await engine.spawnAgent({
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "Fix gap F",
        });

        await vi.runOnlyPendingTimersAsync();

        expect(stateMgr.readState(result.agent_id)?.state).toBe("booting");
        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a post-launch surface live when its stable UUID moves before the liveness check", async () => {
      vi.useFakeTimers();
      try {
        liveSurfaces = [makeSpawnSurface()];
        engine.dispose();
        engine = new AgentEngine(
          stateMgr,
          new AgentRegistry(stateMgr, async () => liveSurfaces),
          mockClient,
          {
            spawnPreflight: async () => {},
            postSpawnLivenessMs: 0,
          },
        );

        const result = await engine.spawnAgent({
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "Fix gap F",
        });
        liveSurfaces = [
          {
            ...makeSurface("surface:moved-after-spawn"),
            id: SPAWN_SURFACE_UUID,
          },
        ];

        await vi.runOnlyPendingTimersAsync();

        expect(stateMgr.readState(result.agent_id)).toMatchObject({
          state: "booting",
          surface_uuid: SPAWN_SURFACE_UUID,
          error: null,
          quality: "unknown",
        });
        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("launches Claude via repoGolem launcher with requested model tier", async () => {
      await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Fix gap F",
      });

      const [surface, launchCmd, opts] = (
        mockClient.send as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(surface).toBe("surface:new");
      expect(opts).toEqual({ workspace: "ws:1" });
      expect(launchCmd).toBe("brainlayerClaude -s -S");
    });

    it("launches with the launcher name resolved by preflight", async () => {
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      const resolvingEngine = new AgentEngine(stateMgr, registry, mockClient, {
        // agent-html-host registered only as the hyphen-stripped form.
        spawnPreflight: async () => ({
          launcherName: "agenthtmlhostCursor",
          repoRoot: "/Users/etanheyman/Gits/agent-html-host",
        }),
        sessionIdentityResolver: () => null,
      });

      const result = await resolvingEngine.spawnAgent({
        repo: "agent-html-host",
        cli: "cursor",
        prompt: "Fix gap F",
      });

      const [, launchCmd] = (mockClient.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(launchCmd).toBe("agenthtmlhostCursor -s");
      const state = resolvingEngine.getAgentState(result.agent_id);
      expect(state?.launcher_name).toBe("agenthtmlhostCursor");
      expect(state?.launch_cwd).toBe(
        "/Users/etanheyman/Gits/agent-html-host",
      );

      resolvingEngine.dispose();
    });

    it("records the resolved registry seat identity when repo and launcher match", async () => {
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => ({
          launcherName: "cmuxlayerCodex",
          repoRoot: process.cwd(),
        }),
        sessionIdentityResolver: () => null,
        seatRegistry: {
          cmuxlayerClaude: {
            repo: "cmuxlayer",
            launchers: {
              claude: "cmuxlayerClaude",
              codex: "cmuxlayerCodex",
              cursor: "cmuxlayerCursor",
              gemini: "cmuxlayerGemini",
              kiro: "cmuxlayerKiro",
            },
            lane: "cmuxlayer",
            aliases: [],
            role: "worker",
            orgTree: { parent: "cmuxlayerLead", directReports: [] },
          },
        },
      });

      const result = await engine.spawnAgent({
        repo: "cmuxlayer",
        cli: "codex",
        prompt: "Fix seat identity",
      });

      expect(engine.getAgentState(result.agent_id)).toMatchObject({
        seat_id: "cmuxlayerClaude",
        seat_lane: "cmuxlayer",
        seat_role: "worker",
        seat_identity_status: "ok",
        seat_identity_error: null,
      });
    });

    it("blocks a seat identity mismatch before creating a surface", async () => {
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => ({ launcherName: "cmuxlayerCodex" }),
        sessionIdentityResolver: () => null,
        seatRegistry: {
          brainlayerClaude: {
            repo: "brainlayer",
            launchers: { codex: "brainlayerCodex" },
            lane: "brainlayer",
            role: "worker",
          },
          cmuxlayerClaude: {
            repo: "cmuxlayer",
            launchers: { codex: "cmuxlayerCodex" },
            lane: "cmuxlayer",
            role: "worker",
          },
        },
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Must not occupy the wrong seat",
        }),
      ).rejects.toThrow(/Spawn blocked by seat identity mismatch.*cmuxlayer/i);

      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.newSurface).not.toHaveBeenCalled();
      expect(stateMgr.listStates()).toHaveLength(0);
    });

    it("treats orchestrator repo spawns through orc launchers as the same registry seat", async () => {
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => ({ launcherName: "orcCodex" }),
        sessionIdentityResolver: () => null,
        seatRegistry: {
          orcClaude: {
            repo: "orc",
            launchers: {
              claude: "orcClaude",
              codex: "orcCodex",
              cursor: "orcCursor",
              gemini: "orcGemini",
              kiro: "orcKiro",
            },
            lane: "orc",
            aliases: [],
            role: "orc",
          },
        },
      });

      const result = await engine.spawnAgent({
        repo: "orchestrator",
        cli: "codex",
        prompt: "Coordinate fleet",
      });

      expect(engine.getAgentState(result.agent_id)).toMatchObject({
        seat_id: "orcClaude",
        seat_lane: "orc",
        seat_role: "orc",
        seat_identity_status: "ok",
        seat_identity_error: null,
      });
    });

    it("writes initial state file", async () => {
      const reconcileSpy = vi.spyOn(engine, "reconcileRolePlacements");
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
      expect(state!.surface_provenance).toBe("cmuxlayer_spawn");
      expect(reconcileSpy).toHaveBeenCalledWith("spawn", {
        agentIds: new Set([result.agent_id]),
      });
    });

    it("persists the requested Codex effort for post-revive verification", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        effort: "max",
        cli: "codex",
        prompt: "Keep the effort pin observable",
      });

      expect(stateMgr.readState(result.agent_id)).toMatchObject({
        effort: "max",
        parsed_effort: null,
        effort_mismatch: null,
      });
    });

    it("persists the live launcher default effort for Codex", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Track the launcher default",
      });

      expect(stateMgr.readState(result.agent_id)).toMatchObject({
        effort: "high",
      });
    });

    it("cleans the created surface when initial state persistence fails before commit", async () => {
      vi.spyOn(stateMgr, "writeState").mockImplementationOnce(() => {
        throw new Error("state disk unavailable");
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Fail before durable binding",
        }),
      ).rejects.toThrow("state disk unavailable");

      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:new",
        expect.objectContaining({
          workspace: "ws:1",
          collapsePane: false,
          beforeMutation: expect.any(Function),
        }),
      );
      expect(stateMgr.listStates()).toHaveLength(0);
      expect(mockClient.renameTab).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it("closes and errors an unlaunched durable binding when initial persistence fails after commit", async () => {
      const writeState = stateMgr.writeState.bind(stateMgr);
      vi.spyOn(stateMgr, "writeState").mockImplementationOnce((record) => {
        writeState(record);
        throw new Error("post-commit telemetry failed");
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Retain durable binding",
        }),
      ).rejects.toThrow("post-commit telemetry failed");

      const durableRecord = stateMgr.listStates()[0];
      expect(durableRecord).toMatchObject({
        surface_id: "surface:new",
        surface_uuid: SPAWN_SURFACE_UUID,
        workspace_id: "ws:1",
        state: "error",
        error:
          "Initial agent state persistence failed: post-commit telemetry failed",
      });
      expect(engine.getAgentState(durableRecord!.agent_id)).toMatchObject({
        surface_id: "surface:new",
        surface_uuid: SPAWN_SURFACE_UUID,
        state: "error",
      });
      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:new",
        expect.objectContaining({
          workspace: "ws:1",
          collapsePane: false,
          beforeMutation: expect.any(Function),
        }),
      );
      expect(mockClient.renameTab).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it("persists the spawning registry's surface observer", async () => {
      engine.dispose();
      const ownerId = "cmux:/tmp/prod.sock#socket=1:2:3:4";
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        {
          observerIdProvider: () => ownerId,
          observerEpochProvider: () => `${ownerId}@socket:7`,
        },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.renameTab as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          liveSurfaces = [
            { ...makeSpawnSurface(), workspace_ref: "ws:1" },
          ];
        },
      );

      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Fix gap F",
      });

      expect(stateMgr.readState(result.agent_id)?.surface_observer_id).toBe(
        ownerId,
      );
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

    it("creates the initial worker pane as a right split when only one pane exists", async () => {
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: "pane:left",
        surfaces: [makeSurface("surface:interactive")],
      });

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
        workspace: "ws:1",
      });

      expect(mockClient.newSplit).toHaveBeenCalledWith("right", {
        pane: "pane:left",
        workspace: "ws:1",
        type: "terminal",
      });
      expect(mockClient.newSurface).not.toHaveBeenCalled();
    });

    it("selects the target workspace before creating an agent surface", async () => {
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "workspace:red-team",
        window_ref: "window:1",
        pane_ref: "pane:left",
        surfaces: [makeSurface("surface:interactive")],
      });

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
        workspace: "workspace:red-team",
      });

      expect(mockClient.selectWorkspace).toHaveBeenCalledWith(
        "workspace:red-team",
      );
      expect(mockClient.newSplit).toHaveBeenCalledWith("right", {
        pane: "pane:left",
        workspace: "workspace:red-team",
        type: "terminal",
      });
      expect(
        (mockClient.selectWorkspace as ReturnType<typeof vi.fn>).mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        (mockClient.newSplit as ReturnType<typeof vi.fn>).mock
          .invocationCallOrder[0],
      );
    });

    it("blocks and cleans up when cmux returns a spawned surface in a different workspace than requested", async () => {
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "workspace:intended",
        window_ref: "window:1",
        pane_ref: "pane:left",
        surfaces: [makeSurface("surface:interactive")],
      });
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace: "workspace:wrong",
        surface: "surface:new",
        pane: "pane:new",
        title: "",
        type: "terminal",
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Fix placement",
          workspace: "workspace:intended",
        }),
      ).rejects.toThrow(
        "Spawn placement blocked: requested workspace:intended but cmux returned workspace:wrong for surface surface:new",
      );
      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:new",
        expect.objectContaining({
          workspace: "workspace:wrong",
          collapsePane: false,
          beforeMutation: expect.any(Function),
        }),
      );
      expect(stateMgr.listStates()).toHaveLength(0);
      expect(mockClient.renameTab).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it("inherits the workspace whose current directory matches the target repo", async () => {
      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue(
        {
          workspaces: [
            {
              ref: "workspace:brainlayer",
              title: "BrainLayer",
              current_directory: "/Users/etanheyman/Gits/brainlayer",
            },
            {
              ref: "workspace:voice",
              title: "VoiceLayer",
              current_directory: "/Users/etanheyman/Gits/voicelayer",
            },
          ],
        },
      );
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        panes: [
          {
            ref: "pane:voice",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:voice"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "workspace:voice",
        window_ref: "window:1",
        pane_ref: "pane:voice",
        surfaces: [makeSurface("surface:voice")],
      });
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace: "workspace:voice",
        surface: "surface:new",
        pane: "pane:1",
        title: "",
        type: "terminal",
      });

      const result = await engine.spawnAgent({
        repo: "voicelayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix prompt delivery",
      });

      expect(result.workspace_id).toBe("workspace:voice");
      expect(mockClient.selectWorkspace).toHaveBeenCalledWith(
        "workspace:voice",
      );
      expect(mockClient.newSplit).toHaveBeenCalledWith("right", {
        pane: "pane:voice",
        workspace: "workspace:voice",
        type: "terminal",
      });
    });

    it("pins a worker to the parent orchestrator's workspace even when its cwd is a worktree that does not match by name", async () => {
      // Parent orchestrator lives in workspace:parent. listWorkspaces has NO
      // directory matching the repo, so WITHOUT parent-workspace inheritance the
      // worker would resolve to undefined and land in cmux's focused workspace
      // (or a brand-new one) — the "opened a worker in a new workspace instead
      // of on its right" bug. Parent inheritance must split it right, in-place.
      const parent = makeRecord({
        agent_id: "parent-claude",
        surface_id: "surface:parent",
        workspace_id: "workspace:parent",
        state: "ready",
        role: "orchestrator",
        cli: "claude",
        repo: "brainlayer",
        parent_agent_id: null,
      });
      engine.getRegistry().set(parent.agent_id, parent);
      liveSurfaces = [makeSurface("surface:parent")];

      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue(
        { workspaces: [] },
      );
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "workspace:parent",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:parent",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:parent"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "workspace:parent",
        window_ref: "window:1",
        pane_ref: "pane:parent",
        surfaces: [makeSurface("surface:parent")],
      });
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace: "workspace:parent",
        surface: "surface:worker",
        pane: "pane:worker",
        title: "",
        type: "terminal",
      });

      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix the watcher",
        parent_agent_id: "parent-claude",
        cwd: "/Users/etanheyman/Gits/brainlayer.wt/watcher-fix",
      });

      expect(result.workspace_id).toBe("workspace:parent");
      expect(mockClient.selectWorkspace).toHaveBeenCalledWith(
        "workspace:parent",
      );
      expect(mockClient.newSplit).toHaveBeenCalledWith("right", {
        pane: "pane:parent",
        workspace: "workspace:parent",
        type: "terminal",
      });
      // The parent pin short-circuits repo-name resolution entirely.
      expect(mockClient.listWorkspaces).not.toHaveBeenCalled();
    });

    it("follows a moved parent UUID before inheriting workspace and pane anchor", async () => {
      const persistedUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const observedUuid = persistedUuid.toUpperCase();
      const parent = makeRecord({
        agent_id: "parent-ic-moved",
        surface_id: "surface:old-parent",
        surface_uuid: persistedUuid,
        workspace_id: "workspace:old",
        state: "ready",
        role: "worker",
        cli: "claude",
        repo: "brainlayer",
        parent_agent_id: null,
      });
      stateMgr.writeState(parent);
      engine.getRegistry().set(parent.agent_id, parent);
      liveSurfaces = [
        {
          ...makeSurface("surface:old-parent"),
          id: "uuid-recycled",
          workspace_ref: "workspace:old",
        },
        {
          ...makeSurface("surface:new-parent"),
          id: observedUuid,
          workspace_ref: "workspace:new",
        },
      ];
      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:old",
            title: "Old",
            index: 0,
            selected: false,
            pinned: false,
          },
          {
            ref: "workspace:new",
            title: "New",
            index: 1,
            selected: true,
            pinned: false,
          },
        ],
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ workspace }: { workspace?: string } = {}) => {
          const isNew = workspace === "workspace:new";
          return {
            workspace_ref: workspace,
            window_ref: isNew ? "window:new" : "window:old",
            panes: isNew
              ? [
                  {
                    ref: "pane:new-lead",
                    index: 0,
                    focused: false,
                    surface_count: 1,
                    surface_refs: ["surface:new-lead"],
                    surface_ids: ["uuid-new-lead"],
                  },
                  {
                    ref: "pane:new-parent",
                    index: 1,
                    focused: true,
                    surface_count: 1,
                    surface_refs: ["surface:new-parent"],
                    surface_ids: [observedUuid],
                  },
                ]
              : [
                  {
                    ref: "pane:old-recycled",
                    index: 0,
                    focused: true,
                    surface_count: 1,
                    surface_refs: ["surface:old-parent"],
                    surface_ids: ["uuid-recycled"],
                  },
                ],
          };
        },
      );
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(
        async ({ workspace, pane }: { workspace?: string; pane?: string } = {}) => {
          const isNew = workspace === "workspace:new";
          const isLead = pane === "pane:new-lead";
          return {
            workspace_ref: workspace,
            window_ref: isNew ? "window:new" : "window:old",
            pane_ref: pane,
            surfaces: [
              {
                ...makeSurface(
                  isLead
                    ? "surface:new-lead"
                    : isNew
                      ? "surface:new-parent"
                      : "surface:old-parent",
                ),
                id: isLead
                  ? "uuid-new-lead"
                  : isNew
                    ? observedUuid
                    : "uuid-recycled",
              },
            ],
          };
        },
      );
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace: "workspace:new",
        surface: "surface:child",
        pane: "pane:new-child",
        title: "",
        type: "terminal",
      });

      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Implement delegated task",
        parent_agent_id: parent.agent_id,
      });

      expect(result.workspace_id).toBe("workspace:new");
      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:new-parent",
        workspace: "workspace:new",
        type: "terminal",
      });
      expect(mockClient.newSplit).not.toHaveBeenCalledWith(
        "down",
        expect.objectContaining({ pane: "pane:old-recycled" }),
      );
    });

    it("places a cross-repo child without requiring its UUID parent in the child workspace", async () => {
      const parentUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const parent = makeRecord({
        agent_id: "parent-cross-repo",
        surface_id: "surface:parent",
        surface_uuid: parentUuid,
        workspace_id: "workspace:parent",
        state: "ready",
        role: "worker",
        cli: "claude",
        repo: "brainlayer",
      });
      stateMgr.writeState(parent);
      engine.getRegistry().set(parent.agent_id, parent);
      liveSurfaces = [
        {
          ...makeSurface("surface:parent-live"),
          id: parentUuid,
          workspace_ref: "workspace:parent",
        },
        {
          ...makeSurface("surface:parent"),
          id: "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb",
          workspace_ref: "workspace:voice",
        },
        {
          ...makeSurface("surface:voice-lead"),
          id: "12345678-1234-4123-8123-123456789abc",
          workspace_ref: "workspace:voice",
        },
      ];
      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:parent",
            title: "BrainLayer",
            current_directory: "/Users/etanheyman/Gits/brainlayer",
          },
          {
            ref: "workspace:voice",
            title: "VoiceLayer",
            current_directory: "/Users/etanheyman/Gits/voicelayer",
          },
        ],
      });
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace: "workspace:voice",
        surface: "surface:voice-child",
        surface_id: SPAWN_SURFACE_UUID,
        pane: "pane:voice-child",
        title: "",
        type: "terminal",
      } satisfies CmuxNewSplitResult);

      const result = await engine.spawnAgent({
        repo: "voicelayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix the voice worker",
        parent_agent_id: parent.agent_id,
      });

      expect(result.workspace_id).toBe("workspace:voice");
      expect(mockClient.newSplit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ workspace: "workspace:voice" }),
      );
      expect(mockClient.newSplit).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ workspace: "workspace:parent" }),
      );
    });

    it("refuses an unanchored fallback when UUID-parent pane enumeration fails", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const parent = makeRecord({
        agent_id: "parent-uuid-enumeration-failure",
        surface_id: "surface:parent",
        surface_uuid: stableUuid,
        workspace_id: "workspace:parent",
        state: "ready",
        role: "worker",
        cli: "claude",
        repo: "brainlayer",
      });
      stateMgr.writeState(parent);
      engine.getRegistry().set(parent.agent_id, parent);
      liveSurfaces = [
        {
          ...makeSurface("surface:parent"),
          id: stableUuid,
          workspace_ref: "workspace:parent",
        },
      ];
      (mockClient.listPanes as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          workspace_ref: "workspace:parent",
          window_ref: "window:parent",
          panes: [
            {
              ref: "pane:parent",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:parent"],
              surface_ids: [stableUuid],
            },
          ],
        })
        .mockRejectedValueOnce(new Error("pane enumeration failed"));
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "workspace:parent",
        window_ref: "window:parent",
        pane_ref: "pane:parent",
        surfaces: [
          {
            ...makeSurface("surface:parent"),
            id: stableUuid,
          },
        ],
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Implement delegated task",
          parent_agent_id: parent.agent_id,
        }),
      ).rejects.toThrow("pane enumeration failed");
      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.newSurface).not.toHaveBeenCalled();
    });

    it("seeds a worktree worker beside the current top left lead pane", async () => {
      const parent = makeRecord({
        agent_id: "parent-claude",
        surface_id: "surface:parent",
        workspace_id: "workspace:parent",
        state: "ready",
        role: "orchestrator",
        cli: "claude",
        repo: "brainlayer",
        parent_agent_id: null,
      });
      engine.getRegistry().set(parent.agent_id, parent);
      liveSurfaces = [makeSurface("surface:parent")];

      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: [],
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "workspace:parent",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:parent",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:parent"],
          },
        ],
      });
      (mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "workspace:parent",
        window_ref: "window:1",
        pane_ref: "pane:parent",
        surfaces: [makeSurface("surface:parent")],
      });
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace: "workspace:parent",
        surface: "surface:worker",
        pane: "pane:worker",
        title: "",
        type: "terminal",
      });

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix the watcher",
        parent_agent_id: "parent-claude",
        cwd: "/Users/etanheyman/Gits/brainlayer.wt/watcher-fix",
        worktree_branch: "fix/watcher",
      });

      expect(mockClient.newSplit).toHaveBeenCalledWith("right", {
        pane: "pane:parent",
        workspace: "workspace:parent",
        type: "terminal",
      });
      expect(mockClient.newSurface).not.toHaveBeenCalled();
    });

    it("docks the first worker into the rightmost sparse non-lead pane when user panes already exist", async () => {
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive-left"],
          },
          {
            ref: "pane:right",
            index: 1,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:interactive-right"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: pane ?? "pane:left",
        surfaces:
          pane === "pane:right"
            ? [makeSurface("surface:interactive-right")]
            : [makeSurface("surface:interactive-left")],
      }));

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
        workspace: "ws:1",
      });

      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:right",
        type: "terminal",
        workspace: "ws:1",
      });
      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it("reuses the rightmost pane as worker tabs when a worker pane already exists", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "worker-1",
          state: "working",
          surface_id: "surface:worker-1",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "worker-2",
          state: "working",
          surface_id: "surface:worker-2",
        }),
      );
      liveSurfaces = [
        makeSurface("surface:worker-1"),
        makeSurface("surface:worker-2"),
      ];
      await engine.getRegistry().reconstitute();

      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
          },
          {
            ref: "pane:right",
            index: 1,
            focused: false,
            surface_count: 2,
            surface_refs: ["surface:worker-1", "surface:worker-2"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: pane ?? "pane:left",
        surfaces:
          pane === "pane:right"
            ? [makeSurface("surface:worker-1"), makeSurface("surface:worker-2")]
            : [makeSurface("surface:interactive")],
      }));
      (mockClient.newSurface as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace: "ws:1",
        surface: "surface:new",
        pane: "pane:right",
        title: "",
        type: "terminal",
      });

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
        workspace: "ws:1",
      });

      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:right",
        type: "terminal",
        workspace: "ws:1",
      });
      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it("classifies a UUID-backed worker by its observed ref, not a recycled cached ref", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const worker = makeRecord({
        agent_id: "worker-moved-role",
        state: "working",
        surface_id: "surface:old-worker",
        surface_uuid: stableUuid,
        workspace_id: "ws:1",
        role: "worker",
      });
      stateMgr.writeState(worker);
      engine.getRegistry().set(worker.agent_id, worker);
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:new-worker"],
            surface_ids: [stableUuid],
            pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
          },
          {
            ref: "pane:right-recycled",
            index: 1,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:old-worker"],
            surface_ids: ["uuid-recycled"],
            pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string } = {}) => ({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: pane,
        surfaces:
          pane === "pane:left"
            ? [
                {
                  ...makeSurface("surface:new-worker"),
                  id: stableUuid,
                },
              ]
            : [
                {
                  ...makeSurface("surface:old-worker"),
                  id: "uuid-recycled",
                },
              ],
      }));

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Coordinate gap F",
        role: "worker",
        workspace: "ws:1",
      });

      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:right-recycled",
        type: "terminal",
        workspace: "ws:1",
      });
    });

    it("does not classify a UUID-less worker owned by another surface observer", async () => {
      engine.dispose();
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerId: "cmux:/tmp/prod.sock" },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      const foreignWorker = makeRecord({
        agent_id: "foreign-ref-only-worker",
        state: "working",
        surface_id: "surface:foreign-worker",
        surface_uuid: null,
        surface_observer_id: "cmux:/tmp/nightly.sock",
        workspace_id: "ws:1",
        role: "worker",
      });
      stateMgr.writeState(foreignWorker);
      scopedRegistry.set(foreignWorker.agent_id, foreignWorker);
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
            pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
          },
          {
            ref: "pane:right",
            index: 1,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:foreign-worker"],
            pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string } = {}) => ({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: pane,
        surfaces: [
          makeSurface(
            pane === "pane:right"
              ? "surface:foreign-worker"
              : "surface:interactive",
          ),
        ],
      }));
      (mockClient.renameTab as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          liveSurfaces = [
            { ...makeSpawnSurface(), workspace_ref: "ws:1" },
          ];
          (
            mockClient.listPanes as ReturnType<typeof vi.fn>
          ).mockResolvedValue({
            workspace_ref: "ws:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:new",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:new"],
                surface_ids: [SPAWN_SURFACE_UUID],
                selected_surface_ref: "surface:new",
              },
            ],
          });
          (
            mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
          ).mockResolvedValue({
            workspace_ref: "ws:1",
            window_ref: "window:1",
            pane_ref: "pane:new",
            surfaces: [makeSpawnSurface()],
          });
        },
      );

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Coordinate gap F",
        role: "worker",
        workspace: "ws:1",
      });

      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:right",
        workspace: "ws:1",
        type: "terminal",
      });
      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it("refuses placement from a successful truncated pane enumeration", async () => {
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 2,
            surface_refs: ["surface:one", "surface:two"],
            surface_ids: ["uuid-one", "uuid-two"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: "pane:left",
        surfaces: [{ ...makeSurface("surface:one"), id: "uuid-one" }],
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Do not place against a subset",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/incomplete.*surface enumeration.*placement/i);

      expect(mockClient.newSurface).not.toHaveBeenCalled();
      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: "mixed",
        paneSurfaceIds: undefined,
        observedIds: ["uuid-one", undefined],
        expected: /mixed.*surface identity.*placement/i,
      },
      {
        label: "contradictory",
        paneSurfaceIds: ["uuid-pane-one", "uuid-two"],
        observedIds: ["uuid-observed-one", "uuid-two"],
        expected: /contradictory.*surface identity.*placement/i,
      },
    ])(
      "refuses placement from $label surface identity evidence",
      async ({ paneSurfaceIds, observedIds, expected }) => {
        (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:left",
              index: 0,
              focused: true,
              surface_count: 2,
              surface_refs: ["surface:one", "surface:two"],
              ...(paneSurfaceIds ? { surface_ids: paneSurfaceIds } : {}),
            },
          ],
        });
        (
          mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: "pane:left",
          surfaces: ["surface:one", "surface:two"].map((ref, index) => ({
            ...makeSurface(ref),
            ...(observedIds[index] ? { id: observedIds[index] } : {}),
          })),
        });

        await expect(
          engine.spawnAgent({
            repo: "brainlayer",
            cli: "codex",
            prompt: "Do not place against ambiguous identity",
            workspace: "ws:1",
          }),
        ).rejects.toThrow(expected);

        expect(mockClient.newSurface).not.toHaveBeenCalled();
        expect(mockClient.newSplit).not.toHaveBeenCalled();
      },
    );

    it("refuses placement when the surface observer changes after topology observation", async () => {
      engine.dispose();
      let currentObserverId = "cmux:/tmp/cmux-primary.sock";
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerIdProvider: () => currentObserverId },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async () => {
        currentObserverId = "cmux:/tmp/cmux-secondary.sock";
        return {
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: "pane:left",
          surfaces: [makeSurface("surface:interactive")],
        };
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Fix observer-safe placement",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/surface observer changed.*placement/i);

      expect(currentObserverId).toBe("cmux:/tmp/cmux-secondary.sock");
      expect(mockClient.newSurface).not.toHaveBeenCalled();
      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it("refuses placement when transport epoch changes under one observer owner", async () => {
      engine.dispose();
      const ownerId = "cmux:/tmp/cmux.sock#socket=1:2:3:4";
      let observerEpoch = `${ownerId}@socket:1`;
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        {
          observerIdProvider: () => ownerId,
          observerEpochProvider: () => observerEpoch,
        },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async () => {
        observerEpoch = `${ownerId}@socket:2`;
        return {
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: "pane:left",
          surfaces: [makeSurface("surface:interactive")],
        };
      });

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Do not cross a reconnect generation",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/surface observer changed.*placement/i);

      expect(scopedRegistry.getObserverId()).toBe(ownerId);
      expect(scopedRegistry.getObserverEpoch()).toBe(
        `${ownerId}@socket:2`,
      );
      expect(mockClient.newSurface).not.toHaveBeenCalled();
      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it("refuses launch when the surface observer changes after split creation", async () => {
      engine.dispose();
      let currentObserverId = "cmux:/tmp/cmux-primary.sock";
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerIdProvider: () => currentObserverId },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: "pane:left",
        surfaces: [makeSurface("surface:interactive")],
      });
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<CmuxNewSplitResult>((resolve) => {
            queueMicrotask(() => {
              resolve({
                workspace: "ws:1",
                surface: "surface:new-observer",
                surface_id: SPAWN_SURFACE_UUID,
                pane: "pane:right",
                title: "",
                type: "terminal",
              });
              // The created handle has returned, but `spawnAgent` has not yet
              // resumed to validate ownership, persist, or launch.
              queueMicrotask(() => {
                currentObserverId = "cmux:/tmp/cmux-secondary.sock";
              });
            });
          }),
      );

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Do not launch across an observer epoch",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/surface observer changed.*placement/i);

      expect(currentObserverId).toBe("cmux:/tmp/cmux-secondary.sock");
      expect(mockClient.renameTab).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(mockClient.sendKey).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(mockClient.log).toHaveBeenCalledWith(
        expect.stringMatching(
          /agent-placement: refusing cleanup.*11111111-2222-4333-8444-555555555555.*ownership changed/i,
        ),
        { level: "warning", source: "cmuxlayer" },
      );
      expect(stateMgr.listStates()).toHaveLength(0);
    });

    it("cleans a created tab when the transport epoch changes before placement returns", async () => {
      engine.dispose();
      const ownerId = "cmux:/tmp/cmux.sock#socket=1:2:3:4";
      let observerEpoch = `${ownerId}@socket:1`;
      let created = false;
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        {
          observerIdProvider: () => ownerId,
          observerEpochProvider: () => observerEpoch,
        },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: [
          {
            ref: "ws:1",
            title: "cmuxlayer",
            index: 0,
            selected: true,
            pinned: false,
          },
        ],
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockImplementation(
        async () => ({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:left",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:left"],
              surface_ids: ["uuid-left"],
            },
            {
              ref: "pane:right",
              index: 1,
              focused: false,
              surface_count: created ? 2 : 1,
              surface_refs: created
                ? ["surface:right", "surface:created-tab"]
                : ["surface:right"],
              surface_ids: created
                ? ["uuid-right", SPAWN_SURFACE_UUID]
                : ["uuid-right"],
            },
          ],
        }),
      );
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: pane ?? "pane:left",
        surfaces:
          pane === "pane:right"
            ? [
                { ...makeSurface("surface:right"), id: "uuid-right" },
                ...(created
                  ? [
                      {
                        ...makeSurface("surface:created-tab"),
                        id: SPAWN_SURFACE_UUID,
                      },
                    ]
                  : []),
              ]
            : [{ ...makeSurface("surface:left"), id: "uuid-left" }],
      }));
      (mockClient.newSurface as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          created = true;
          observerEpoch = `${ownerId}@socket:2`;
          return {
            workspace: "ws:1",
            surface: "surface:created-tab",
            surface_id: SPAWN_SURFACE_UUID,
            pane: "pane:right",
            title: "",
            type: "terminal",
          };
        },
      );

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Clean a tab created across reconnect",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/surface observer changed.*placement/i);

      expect(mockClient.newSurface).toHaveBeenCalledTimes(1);
      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:created-tab",
        expect.objectContaining({
          workspace: "ws:1",
          collapsePane: false,
          beforeMutation: expect.any(Function),
        }),
      );
      expect(stateMgr.listStates()).toHaveLength(0);
    });

    it("refuses an enforced-role spawn when placement topology is unavailable", async () => {
      engine.dispose();
      const ownerId = "cmux:/tmp/cmux.sock#socket=1:2:3:4";
      let observerEpoch = `${ownerId}@socket:1`;
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        {
          observerIdProvider: () => ownerId,
          observerEpochProvider: () => observerEpoch,
        },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: [
          {
            ref: "ws:1",
            title: "cmuxlayer",
            index: 0,
            selected: true,
            pinned: false,
          },
        ],
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("placement listing failed"),
      );

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Refuse a blind fallback split",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/placement listing failed/i);

      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.newSurface).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(stateMgr.listStates()).toHaveLength(0);
    });

    it("refuses a third-column workspace before creating an orphan surface", async () => {
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:lead"],
            pixel_frame: { x: 0, y: 0, width: 400, height: 900 },
          },
          {
            ref: "pane:right",
            index: 1,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:worker"],
            pixel_frame: { x: 400, y: 0, width: 400, height: 900 },
          },
          {
            ref: "pane:third",
            index: 2,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:unexpected"],
            pixel_frame: { x: 800, y: 0, width: 400, height: 900 },
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: pane,
        surfaces: [
          makeSurface(
            pane === "pane:left"
              ? "surface:lead"
              : pane === "pane:right"
                ? "surface:worker"
                : "surface:unexpected",
          ),
        ],
      }));

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Refuse placement into a third-column workspace",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/three columns|at most two|two-column/i);

      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.newSurface).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(stateMgr.listStates()).toHaveLength(0);
    });

    it("refuses launch when the surface observer changes during tab rename", async () => {
      engine.dispose();
      let currentObserverId = "cmux:/tmp/cmux-primary.sock";
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerIdProvider: () => currentObserverId },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.renameTab as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          currentObserverId = "cmux:/tmp/cmux-secondary.sock";
        },
      );

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Do not launch after observer replacement",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/surface observer changed.*launch/i);

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(mockClient.sendKey).not.toHaveBeenCalled();
      expect(stateMgr.listStates()).toHaveLength(1);
      expect(stateMgr.listStates()[0]?.state).toBe("error");
    });

    it("gives custom launch senders a fail-closed guard for readiness races", async () => {
      engine.dispose();
      const stableUuid = SPAWN_SURFACE_UUID;
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerId: "cmux:/tmp/cmux-primary.sock" },
      );
      let launchedSurface: string | null = null;
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        launchCommandSender: async ({
          surface,
          assertSurfaceBindingCurrent,
        }) => {
          expect(surface).toBe("surface:new");
          // Model a route move while the production sender waits for shell
          // readiness. The guard must fail before the first terminal write.
          liveSurfaces = [
            {
              ...makeSurface("surface:new"),
              id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              workspace_ref: "ws:1",
            },
            {
              ...makeSurface("surface:moved-before-launch"),
              id: stableUuid,
              workspace_ref: "ws:1",
            },
          ];
          await assertSurfaceBindingCurrent();
          launchedSurface = surface;
        },
      });
      (mockClient.renameTab as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          liveSurfaces = [
            {
              ...makeSurface("surface:new"),
              id: stableUuid,
              workspace_ref: "ws:1",
            },
          ];
        },
      );

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          cli: "codex",
          prompt: "Guard launch readiness",
          workspace: "ws:1",
        }),
      ).rejects.toThrow(/surface route changed.*launch/i);

      expect(launchedSurface).toBeNull();
    });

    it("refuses a launch target that already disagrees with the registry route", async () => {
      const record = makeRecord({
        agent_id: "agent-launch-route-mismatch",
        surface_id: "surface:registry-target",
        workspace_id: "ws:1",
        state: "booting",
      });
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      const internals = engine as unknown as {
        sendLaunchCommand(
          surface: string,
          workspace: string | undefined,
          command: string,
          agentId: string,
          observerEpoch: undefined,
        ): Promise<void>;
      };

      await expect(
        internals.sendLaunchCommand(
          "surface:stale-target",
          "ws:1",
          "brainlayerCodex",
          record.agent_id,
          undefined,
        ),
      ).rejects.toThrow(/launch target.*registry.*surface/i);

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(mockClient.sendKey).not.toHaveBeenCalled();
    });

    it("persists the explicit worker role on spawned agents", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Coordinate work",
        role: "worker",
      });

      expect(stateMgr.readState(result.agent_id)?.role).toBe("worker");
    });

    it("infers worker role for Codex spawns and uses the worker pane", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
      });

      expect(stateMgr.readState(result.agent_id)?.role).toBe("worker");
      expect(
        stateMgr.readState(result.agent_id)?.auto_archive_on_done,
      ).toBeUndefined();
    });

    it("uses role panes created by new_split when placing spawned agents", async () => {
      engine.dispose();
      const surfaceProvider = async () => liveSurfaces;
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        roleSurfaceIdsProvider: () => ({
          orchestrator: new Set(),
          worker: new Set(["surface:worker-shell"]),
        }),
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:orc"],
          },
          {
            ref: "pane:right",
            index: 1,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:worker-shell"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: pane ?? "pane:left",
        surfaces:
          pane === "pane:right"
            ? [makeSurface("surface:worker-shell")]
            : [makeSurface("surface:orc")],
      }));

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
        workspace: "ws:1",
      });

      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:right",
        type: "terminal",
        workspace: "ws:1",
      });
      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it("does not reuse a persisted worker surface in column 0 after reconnect", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "existing-worker",
          state: "ready",
          surface_id: "surface:worker-existing",
          workspace_id: "ws:1",
          role: "worker",
        }),
      );
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:worker",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:worker-existing"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: "pane:worker",
        surfaces: [makeSurface("surface:worker-existing")],
      });

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
        workspace: "ws:1",
      });

      expect(mockClient.newSurface).not.toHaveBeenCalled();
      expect(mockClient.newSplit).toHaveBeenCalledWith("right", {
        pane: "pane:worker",
        type: "terminal",
        workspace: "ws:1",
      });
    });

    it("partitions unfiltered surface lists by pane membership when placing spawned agents", async () => {
      engine.dispose();
      const surfaceProvider = async () => liveSurfaces;
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        roleSurfaceIdsProvider: () => ({
          orchestrator: new Set(["surface:orc"]),
          worker: new Set(["surface:worker-shell"]),
        }),
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            id: "pane-left-id",
            index: 0,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:orc"],
            surface_ids: ["surface-orc-id"],
            pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
          },
          {
            ref: "pane:right",
            id: "pane-right-id",
            index: 1,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:worker-shell"],
            surface_ids: ["surface-worker-id"],
            pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        surfaces: [
          {
            id: "surface-orc-id",
            pane_id: "pane-left-id",
            ref: "surface:orc",
            title: "orc",
            type: "terminal",
            index: 0,
            selected: true,
          },
          {
            id: "surface-worker-id",
            pane_id: "pane-right-id",
            ref: "surface:worker-shell",
            title: "worker",
            type: "terminal",
            index: 1,
            selected: false,
          },
        ],
      });

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
        workspace: "ws:1",
      });

      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:right",
        type: "terminal",
        workspace: "ws:1",
      });
      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it("does not abort placement when an existing parent or sibling has an unclassifiable role", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const parent = makeRecord({
        agent_id: "parent-unknown",
        surface_id: "surface:parent",
        repo: "manual-shell",
        cli: "unknown" as any,
        spawn_depth: 0,
      });
      const sibling = makeRecord({
        agent_id: "sibling-unknown",
        surface_id: "surface:sibling",
        repo: "manual-shell",
        cli: "unknown" as any,
        parent_agent_id: "parent-unknown",
        spawn_depth: 1,
      });
      engine.getRegistry().set(parent.agent_id, parent);
      engine.getRegistry().set(sibling.agent_id, sibling);

      await expect(
        engine.spawnAgent({
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          prompt: "Fix gap F",
          parent_agent_id: "parent-unknown",
        }),
      ).resolves.toMatchObject({
        surface_id: "surface:new",
        state: "booting",
      });

      expect(mockClient.newSplit).toHaveBeenCalledWith(
        "right",
        expect.objectContaining({ type: "terminal" }),
      );
      warnSpy.mockRestore();
    });

    it("docks a child worker into canonical column 1 without a row split", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "ic-1",
          state: "ready",
          surface_id: "surface:ic",
          cli: "claude",
          role: "worker",
        }),
      );
      liveSurfaces = [makeSurface("surface:ic")];
      await engine.getRegistry().reconstitute();

      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:orc"],
          },
          {
            ref: "pane:ic",
            index: 1,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:ic"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: pane ?? "pane:left",
        surfaces:
          pane === "pane:ic"
            ? [makeSurface("surface:ic")]
            : [makeSurface("surface:orc")],
      }));

      await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Implement delegated task",
        workspace: "ws:1",
        parent_agent_id: "ic-1",
      });

      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:ic",
        workspace: "ws:1",
        type: "terminal",
      });
    });

    it("does not auto-close opted-in done workers unless env enables auto-archive", async () => {
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(doneAt.getTime() + 31 * 60_000));
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-done-without-env",
            state: "done",
            surface_id: "surface:done-worker-without-env",
            cli: "codex",
            role: "worker",
            auto_archive_on_done: true,
            task_done_detected_at: doneAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:done-worker-without-env")];
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not auto-close Codex worker panes after TASK_DONE inactivity even when env opts in", async () => {
      process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE = "1";
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(doneAt);
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-done",
            state: "ready",
            surface_id: "surface:done-worker",
            cli: "codex",
            role: "worker",
            auto_archive_on_done: true,
          }),
        );
        liveSurfaces = [makeSurface("surface:done-worker")];
        await engine.getRegistry().reconstitute();
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:done-worker",
          text: "gpt-5.4\nTASK_DONE",
          lines: 20,
          scrollback_used: false,
        });

        await engine.runSweep();
        expect(engine.getAgentState("worker-done")?.state).toBe("ready");
        expect(
          engine.getAgentState("worker-done")?.task_done_candidate_at,
        ).toBe(doneAt.toISOString());
        expect(mockClient.closeSurface).not.toHaveBeenCalled();

        vi.setSystemTime(new Date(doneAt.getTime() + 5_001));
        await engine.runSweep();
        expect(engine.getAgentState("worker-done")?.state).toBe("done");
        expect(
          engine.getAgentState("worker-done")?.task_done_detected_at,
        ).toBeDefined();
        expect(mockClient.closeSurface).not.toHaveBeenCalled();

        vi.setSystemTime(new Date(doneAt.getTime() + 5_001 + 30 * 60_000 + 1));
        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
        expect(engine.getAgentState("worker-done")).toMatchObject({
          state: "done",
          task_done_detected_at: expect.any(String),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("treats post-spawn live-surface listing failures as inconclusive", async () => {
      const guardedRegistry = new AgentRegistry(stateMgr, async () => [
        makeSurface("surface:post-spawn"),
      ]);
      vi.spyOn(guardedRegistry, "hasLiveSurface").mockRejectedValue(
        new Error("surface listing failed"),
      );
      const guardedEngine = new AgentEngine(stateMgr, guardedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-post-spawn",
            state: "booting",
            surface_id: "surface:post-spawn",
            cli: "codex",
            role: "worker",
          }),
        );
        guardedRegistry.set(
          "worker-post-spawn",
          stateMgr.readState("worker-post-spawn")!,
        );

        const engineInternals = guardedEngine as unknown as {
          assertPostSpawnLiveness(agentId: string): Promise<void>;
        };
        await expect(
          engineInternals.assertPostSpawnLiveness("worker-post-spawn"),
        ).resolves.toBeUndefined();
        expect(
          guardedEngine.getAgentState("worker-post-spawn")?.error ?? null,
        ).toBeNull();
      } finally {
        guardedEngine.dispose();
      }
    });

    it("marks TASK_DONE for any cli and role without using the auto-archive gate", async () => {
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(doneAt);
        stateMgr.writeState(
          makeRecord({
            agent_id: "claude-ic-done",
            state: "ready",
            surface_id: "surface:claude-ic-done",
            cli: "claude",
            role: "worker",
            auto_archive_on_done: true,
          }),
        );
        liveSurfaces = [makeSurface("surface:claude-ic-done")];
        await engine.getRegistry().reconstitute();
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:claude-ic-done",
          text: "Claude Code\nTASK_DONE",
          lines: 20,
          scrollback_used: false,
        });

        await engine.runSweep();
        expect(engine.getAgentState("claude-ic-done")).toMatchObject({
          state: "ready",
          task_done_candidate_at: doneAt.toISOString(),
        });

        vi.setSystemTime(new Date(doneAt.getTime() + 5_001));
        await engine.runSweep();
        expect(engine.getAgentState("claude-ic-done")).toMatchObject({
          state: "done",
          task_done_detected_at: expect.any(String),
        });

        vi.setSystemTime(new Date(doneAt.getTime() + 5_001 + 31 * 60_000));
        await engine.runSweep();
        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not close done workers even when TASK_DONE auto-archive delay has elapsed", async () => {
      const previousMs = process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MS;
      const previousMinutes =
        process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MINUTES;
      process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE = "1";
      process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MS = "1";
      process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MINUTES = "1";
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(doneAt);
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-done-ms",
            state: "done",
            surface_id: "surface:done-worker-ms",
            cli: "codex",
            role: "worker",
            updated_at: doneAt.toISOString(),
            auto_archive_on_done: true,
            task_done_detected_at: doneAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:done-worker-ms")];
        await engine.getRegistry().reconstitute();

        vi.setSystemTime(new Date(doneAt.getTime() + 2));
        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
        expect(engine.getAgentState("worker-done-ms")).toMatchObject({
          state: "done",
          task_done_detected_at: doneAt.toISOString(),
        });
      } finally {
        if (previousMs === undefined) {
          delete process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MS;
        } else {
          process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MS = previousMs;
        }
        if (previousMinutes === undefined) {
          delete process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MINUTES;
        } else {
          process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MINUTES =
            previousMinutes;
        }
        vi.useRealTimers();
      }
    });

    it("keeps done workers open regardless of TASK_DONE detection time", async () => {
      process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE = "1";
      vi.useFakeTimers();
      try {
        const detectedAt = new Date("2026-05-25T12:00:00.000Z");
        const updatedAt = new Date(detectedAt.getTime() + 29 * 60_000);
        vi.setSystemTime(new Date(detectedAt.getTime() + 30 * 60_000 + 1));
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-detected-done",
            state: "done",
            surface_id: "surface:detected-done-worker",
            cli: "codex",
            role: "worker",
            updated_at: updatedAt.toISOString(),
            auto_archive_on_done: true,
            task_done_detected_at: detectedAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:detected-done-worker")];
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
        expect(engine.getAgentState("worker-detected-done")).toMatchObject({
          state: "done",
          task_done_detected_at: detectedAt.toISOString(),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps sidebar state for done workers instead of auto-archiving the surface", async () => {
      process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE = "1";
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(doneAt.getTime() + 31 * 60_000));
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-archived-before-status",
            state: "done",
            surface_id: "surface:archived-before-status",
            workspace_id: "workspace:brainlayer",
            cli: "codex",
            role: "worker",
            auto_archive_on_done: true,
            task_done_detected_at: doneAt.toISOString(),
          }),
        );
        liveSurfaces = [
          {
            ...makeSurface("surface:archived-before-status"),
            workspace_ref: "workspace:brainlayer",
          },
        ];
        await engine.getRegistry().reconstitute();
        await expect(engine.runSweep()).resolves.toBeUndefined();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
        expect(mockClient.clearStatus).not.toHaveBeenCalled();
        expect(mockClient.setStatus).toHaveBeenCalledWith(
          "worker-archived-before-status",
          "brainlayer | role=worker | state=done | health=unhealthy(inbox_monitor_not_alive:degraded,closure_without_artifact:blocking) | blocked=- | last_prompt=Fix search gap F | worktree=- | branch=- | report=n/a | pr=n/a",
          expect.objectContaining({
            surface: "surface:archived-before-status",
          }),
        );
        expect(
          engine.getAgentState("worker-archived-before-status"),
        ).toMatchObject({ state: "done" });
        expect(
          stateMgr.readState("worker-archived-before-status"),
        ).toMatchObject({ state: "done" });

        (mockClient.setStatus as ReturnType<typeof vi.fn>).mockClear();
        await engine.runSweep();
        expect(mockClient.setStatus).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not rewrite TASK_DONE candidate metadata while the sweep stamps liveness", async () => {
      vi.useFakeTimers();
      try {
        const candidateAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(candidateAt.getTime() + 1_000));
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-task-done-candidate",
            state: "ready",
            surface_id: "surface:task-done-candidate",
            cli: "codex",
            role: "worker",
            auto_archive_on_done: true,
            task_done_candidate_at: candidateAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:task-done-candidate")];
        await engine.getRegistry().reconstitute();
        const before = stateMgr.readState("worker-task-done-candidate");
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:task-done-candidate",
          text: "gpt-5.4\nTASK_DONE",
          lines: 20,
          scrollback_used: false,
        });

        await engine.runSweep();

        const after = stateMgr.readState("worker-task-done-candidate");
        expect(after?.task_done_candidate_at).toBe(
          before?.task_done_candidate_at,
        );
        expect(after?.version).toBe((before?.version ?? 0) + 1);
        expect(after?.updated_at).toBe(
          new Date(candidateAt.getTime() + 1_000).toISOString(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not auto-close done Codex workers without TASK_DONE provenance", async () => {
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(doneAt.getTime() + 31 * 60_000));
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-manual-done",
            state: "done",
            surface_id: "surface:manual-done-worker",
            cli: "codex",
            role: "worker",
            updated_at: doneAt.toISOString(),
            auto_archive_on_done: true,
          }),
        );
        liveSurfaces = [makeSurface("surface:manual-done-worker")];
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not reap done non-Codex worker panes after the idle close timeout", async () => {
      const previousIdleCloseMs = process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS;
      process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS = "1000";
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        stateMgr.writeState(
          makeRecord({
            agent_id: "cursor-worker-done",
            state: "done",
            surface_id: "surface:cursor-worker",
            workspace_id: "ws:1",
            cli: "cursor",
            role: "worker",
            updated_at: doneAt.toISOString(),
          }),
        );
        liveSurfaces = [
          makeSurface("surface:orchestrator"),
          makeSurface("surface:cursor-worker"),
        ];
        (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:left",
              index: 0,
              focused: false,
              surface_count: 1,
              surface_refs: ["surface:orchestrator"],
              selected_surface_ref: "surface:orchestrator",
            },
            {
              ref: "pane:right",
              index: 1,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:cursor-worker"],
              selected_surface_ref: "surface:cursor-worker",
            },
          ],
        });
        (
          mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
        ).mockImplementation(async ({ pane }: { pane?: string }) => ({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: pane,
          surfaces:
            pane === "pane:right"
              ? [makeSurface("surface:cursor-worker")]
              : [makeSurface("surface:orchestrator")],
        }));
        await engine.getRegistry().reconstitute();

        vi.setSystemTime(new Date(doneAt.getTime() + 999));
        await engine.runSweep();
        expect(mockClient.closeSurface).not.toHaveBeenCalled();

        vi.setSystemTime(new Date(doneAt.getTime() + 1_000));
        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
        expect(engine.getAgentState("cursor-worker-done")).toMatchObject({
          state: "done",
        });
        expect(stateMgr.readState("cursor-worker-done")).toMatchObject({
          state: "done",
        });
      } finally {
        if (previousIdleCloseMs === undefined) {
          delete process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS;
        } else {
          process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS = previousIdleCloseMs;
        }
        vi.useRealTimers();
      }
    });

    it("does not reap an idle orchestrator pane after the idle close timeout", async () => {
      const previousIdleCloseMs = process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS;
      process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS = "1000";
      vi.useFakeTimers();
      try {
        const idleAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(idleAt.getTime() + 1_001));
        stateMgr.writeState(
          makeRecord({
            agent_id: "lead-idle",
            state: "idle",
            surface_id: "surface:lead-idle",
            workspace_id: "ws:1",
            cli: "claude",
            role: "orchestrator",
            updated_at: idleAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:lead-idle")];
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
        expect(engine.getAgentState("lead-idle")).toMatchObject({
          state: "idle",
          role: "orchestrator",
        });
        expect(stateMgr.readState("lead-idle")).toMatchObject({
          state: "idle",
          role: "orchestrator",
        });
      } finally {
        if (previousIdleCloseMs === undefined) {
          delete process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS;
        } else {
          process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS = previousIdleCloseMs;
        }
        vi.useRealTimers();
      }
    });

    it("does not let idle worker reap bypass the Codex TASK_DONE archive delay", async () => {
      const previousIdleCloseMs = process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS;
      process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS = "1000";
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(doneAt.getTime() + 1_001));
        stateMgr.writeState(
          makeRecord({
            agent_id: "codex-worker-pending-archive",
            state: "done",
            surface_id: "surface:codex-pending-archive",
            cli: "codex",
            role: "worker",
            updated_at: doneAt.toISOString(),
            auto_archive_on_done: true,
            task_done_detected_at: doneAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:codex-pending-archive")];
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
        expect(
          engine.getAgentState("codex-worker-pending-archive"),
        ).toMatchObject({
          state: "done",
          task_done_detected_at: doneAt.toISOString(),
        });
      } finally {
        if (previousIdleCloseMs === undefined) {
          delete process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS;
        } else {
          process.env.CMUXLAYER_IDLE_WORKER_CLOSE_MS = previousIdleCloseMs;
        }
        vi.useRealTimers();
      }
    });

    it("does not auto-close legacy Codex workers without explicit archive opt-in", async () => {
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(doneAt.getTime() + 31 * 60_000));
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-legacy-done",
            state: "done",
            surface_id: "surface:legacy-done-worker",
            cli: "codex",
            role: "worker",
            updated_at: doneAt.toISOString(),
            auto_archive_on_done: undefined,
            task_done_detected_at: doneAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:legacy-done-worker")];
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not mark a worker done when TASK_DONE is stale scrollback before active work", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "worker-active",
          state: "ready",
          surface_id: "surface:active-worker",
          cli: "codex",
          role: "worker",
          auto_archive_on_done: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:active-worker")];
      await engine.getRegistry().reconstitute();
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:active-worker",
        text: "gpt-5.4\nTASK_DONE\nWorking (1m 02s • esc to interrupt)",
        lines: 20,
        scrollback_used: false,
      });

      await engine.runSweep();

      expect(engine.getAgentState("worker-active")?.state).toBe("ready");
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(mockClient.readScreen).toHaveBeenCalledTimes(1);
    });

    it("uses only the current screen tail for quality parsing when reusing the TASK_DONE read", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "worker-quality",
          state: "ready",
          surface_id: "surface:quality-worker",
          cli: "codex",
          role: "worker",
          auto_archive_on_done: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:quality-worker")];
      await engine.getRegistry().reconstitute();
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:quality-worker",
        text: [
          "gpt-5.4 high · 5% left · ~/Gits/cmuxlayer",
          "older work",
          "older work",
          "older work",
          "older work",
          "older work",
          "gpt-5.4 high · 90% left · ~/Gits/cmuxlayer",
          "current prompt",
        ].join("\n"),
        lines: 80,
        scrollback_used: false,
      });

      await engine.runSweep();

      expect(engine.getAgentState("worker-quality")?.quality).toBe("unknown");
      expect(mockClient.send).not.toHaveBeenCalledWith(
        "surface:quality-worker",
        "/compact",
        {},
      );
      expect(mockClient.readScreen).toHaveBeenCalledTimes(1);
    });

    it("sends an unsubmitted context nudge with workspace scope", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const record = makeRecord({
        agent_id: "agent-auto-compact-route",
        state: "ready",
        surface_id: "surface:compact-old",
        surface_uuid: stableUuid,
        workspace_id: "workspace:compact-old",
        spawn_depth: 0,
        quality: "unknown",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface("surface:compact-old"),
          id: stableUuid,
          workspace_ref: "workspace:compact-old",
        },
      ];
      await engine.getRegistry().reconstitute();
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:compact-old",
        text:
          "gpt-5.4 high · 5% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)",
        lines: 20,
        scrollback_used: false,
      });
      await engine.runSweep();

      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:compact-old",
        "[cmuxlayer] context at 95% — checkpoint at-risk work and /compact when safe",
        expect.objectContaining({
          workspace: "workspace:compact-old",
          beforeMutation: expect.any(Function),
        }),
      );
      expect(mockClient.send).not.toHaveBeenCalledWith(
        expect.anything(),
        "/compact",
        expect.anything(),
      );
      expect(mockClient.sendKey).not.toHaveBeenCalled();
    });

    it("respawns a crashed agent with its captured session id when crash recovery is enabled", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-crash",
          state: "working",
          surface_id: "surface:dead",
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          crash_recover: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:dead")];
      await engine.getRegistry().reconstitute();

      liveSurfaces = [makeSurface("surface:other")];
      await runConfirmedSurfaceAbsenceSweep();

      expect(mockClient.newSplit).toHaveBeenCalled();
      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:new",
        "brainlayerCodex --dangerously-bypass-approvals-and-sandbox resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        { workspace: "ws:1" },
      );
      expect(mockClient.sendKey).toHaveBeenCalledWith("surface:new", "return", {
        workspace: "ws:1",
      });

      const recovered = engine.getAgentState("agent-crash");
      expect(recovered?.state).toBe("booting");
      expect(recovered?.surface_id).toBe("surface:new");
      expect(recovered?.surface_uuid).toBe(
        "11111111-2222-4333-8444-555555555555",
      );
      expect(recovered?.respawn_attempts).toBe(1);
    });

    it("explicitly resumes a captured session on a new surface without changing the public agent id", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stable-resume",
          state: "done",
          surface_id: "surface:old",
          workspace_id: "ws:1",
          repo: "brainlayer",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        }),
      );
      await engine.getRegistry().reconstitute();

      const resumed = await engine.resumeAgent("agent-stable-resume");

      expect(resumed.agent_id).toBe("agent-stable-resume");
      expect(resumed.surface_id).toBe("surface:new");
      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:new",
        "brainlayerCodex --dangerously-bypass-approvals-and-sandbox resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        { workspace: "ws:1" },
      );
      expect(engine.getAgentState("agent-stable-resume")?.state).toBe("booting");
    });

    it("rejects an invalid crash-recovery session before creating a surface", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-crash-short-session",
          state: "error",
          surface_id: "surface:dead-short-session",
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          cli_session_id: "019d9aa5",
          crash_recover: true,
          error: "Surface surface:dead-short-session disappeared",
        }),
      );
      liveSurfaces = [makeSurface("surface:witness")];
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(engine.getAgentState("agent-crash-short-session")).toMatchObject({
        state: "error",
        surface_id: "surface:dead-short-session",
        respawn_attempts: 0,
        error: expect.stringMatching(/full session UUID/i),
      });
    });

    it.each(["tab_close", "workspace_teardown"] as const)(
      "treats a cmux UI %s as terminal before crash recovery",
      async (closeOrigin) => {
        engine.dispose();
        const closedSurfaceUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
        let closePending = true;
        const tabClose: CloseForensicsEvent = {
          ts: "2026-07-14T16:23:48.900Z",
          event_type: "close_forensics",
          cmux_surface_id: closedSurfaceUuid,
          cmux_pane_id: "pane-uuid",
          window_id: null,
          boot_id: "boot-uuid",
          workspace_id: "workspace-uuid",
          origin: closeOrigin,
          occurred_at: "2026-07-14T16:23:48.852Z",
          attribution: "app-level:no-mcp-close",
          client_context: {
            window_key_cycle_near_close: false,
            last_window_key_event: null,
            boot_id_changed_since_prev: false,
          },
        };
        engine = new AgentEngine(stateMgr, registry, mockClient, {
          spawnPreflight: async () => {},
          sessionIdentityResolver: () => null,
          closeForensicsRunner: async () => {
            const events = closePending ? [tabClose] : [];
            closePending = false;
            return { emitted: events.length, events };
          },
        });
        stateMgr.writeState(
          makeRecord({
            agent_id: "agent-user-closed",
            state: "working",
            surface_id: "surface:user-closed",
            surface_uuid: closedSurfaceUuid,
            workspace_id: "ws:1",
            repo: "brainlayer",
            model: "gpt-5.4",
            cli: "codex",
            cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
            crash_recover: true,
          }),
        );
        liveSurfaces = [
          {
            ...makeSurface("surface:user-closed"),
            id: closedSurfaceUuid,
            workspace_ref: "ws:1",
          },
        ];
        await registry.reconstitute();

        liveSurfaces = [
          {
            ...makeSurface("surface:other"),
            id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
            workspace_ref: "ws:1",
          },
        ];
        const firstObservedAt = Date.now();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(firstObservedAt);
        try {
          await engine.runSweep();
          expect(engine.getAgentState("agent-user-closed")).toMatchObject({
            state: "working",
            user_killed: true,
            surface_uuid: closedSurfaceUuid,
          });
          nowSpy.mockReturnValue(
            firstObservedAt + SURFACE_EVICTION_CONFIRMATION_MS + 1,
          );
          await engine.runSweep();
        } finally {
          nowSpy.mockRestore();
        }

        expect(mockClient.newSplit).not.toHaveBeenCalled();
        expect(engine.getAgentState("agent-user-closed")).toBeNull();
      },
    );

    it("does not recover foreign or unowned crash records in a scoped observer", async () => {
      engine.dispose();
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerId: "cmux:/tmp/nightly.sock" },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      for (const [agentId, surfaceObserverId] of [
        ["foreign-crash", "cmux:/tmp/prod.sock"],
        ["legacy-crash", undefined],
      ] as const) {
        stateMgr.writeState(
          makeRecord({
            agent_id: agentId,
            state: "error",
            surface_id: `surface:${agentId}`,
            surface_uuid: `uuid-${agentId}`,
            surface_observer_id: surfaceObserverId,
            cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
            crash_recover: true,
            error: `Surface surface:${agentId} disappeared`,
          }),
        );
      }
      liveSurfaces = [
        {
          ...makeSurface("surface:witness"),
          id: "uuid-witness",
          workspace_ref: "ws:witness",
        },
      ];
      await scopedRegistry.reconstitute();
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockClear();
      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();

      await engine.runSweep();

      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(engine.getAgentState("foreign-crash")).toMatchObject({
        state: "error",
        respawn_attempts: 0,
      });
      expect(engine.getAgentState("legacy-crash")).toMatchObject({
        state: "error",
        respawn_attempts: 0,
      });
    });

    it("does not place or resume crash recovery in a manually controlled workspace", async () => {
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      const beforeCrashRecoveryMutation = vi.fn(
        async (input: {
          phase: "placement" | "resume";
          agent_id: string;
          surface?: string;
          workspace?: string;
        }) => {
          if (input.workspace === "workspace:manual") {
            throw new Error("surface is in manual mode");
          }
        },
      );
      const recoveryOptions = {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        beforeCrashRecoveryMutation,
      };
      engine = new AgentEngine(
        stateMgr,
        registry,
        mockClient,
        recoveryOptions,
      );
      const record = makeRecord({
        agent_id: "agent-crash-manual-workspace",
        state: "error",
        surface_id: "surface:dead-manual",
        workspace_id: "workspace:manual",
        cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        crash_recover: true,
        error: "Surface surface:dead-manual disappeared",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface("surface:witness"),
          workspace_ref: "workspace:witness",
        },
      ];
      await registry.reconstitute();
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockClear();
      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();

      await engine.runSweep();

      expect(beforeCrashRecoveryMutation).toHaveBeenCalledTimes(1);
      expect(beforeCrashRecoveryMutation).toHaveBeenCalledWith({
        phase: "placement",
        agent_id: record.agent_id,
        workspace: "workspace:manual",
      });
      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(engine.getAgentState(record.agent_id)).toMatchObject({
        state: "error",
        error: "Crash recovery failed: surface is in manual mode",
      });
    });

    it("does not resume crash recovery after the created surface observer changes", async () => {
      engine.dispose();
      let currentObserverId = "cmux:/tmp/cmux-primary.sock";
      const registry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerIdProvider: () => currentObserverId },
      );
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      const record = makeRecord({
        agent_id: "agent-crash-observer-switch",
        state: "error",
        surface_id: "surface:dead-observer",
        surface_uuid: "uuid-dead-observer",
        surface_observer_id: currentObserverId,
        workspace_id: "workspace:recovery",
        cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        crash_recover: true,
        error: "Surface surface:dead-observer disappeared",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface("surface:witness"),
          id: "uuid-witness",
          workspace_ref: "workspace:witness",
        },
      ];
      await registry.reconstitute();
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockImplementation(
        () =>
          new Promise<CmuxNewSplitResult>((resolve) => {
            queueMicrotask(() => {
              resolve({
                workspace: "workspace:recovery",
                surface: "surface:new-recovery",
                surface_id: SPAWN_SURFACE_UUID,
                pane: "pane:recovery",
                title: "",
                type: "terminal",
              });
              queueMicrotask(() => {
                currentObserverId = "cmux:/tmp/cmux-secondary.sock";
              });
            });
          }),
      );
      (mockClient.send as ReturnType<typeof vi.fn>).mockClear();

      await engine.runSweep();

      expect(currentObserverId).toBe("cmux:/tmp/cmux-secondary.sock");
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(mockClient.sendKey).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(engine.getAgentState(record.agent_id)).toMatchObject({
        state: "error",
        surface_id: "surface:dead-observer",
        surface_observer_id: "cmux:/tmp/cmux-primary.sock",
      });
      expect(engine.getAgentState(record.agent_id)?.error).toMatch(
        /crash recovery failed:.*surface observer changed/i,
      );
    });

    it("closes an unbound recovery surface when the resume gate rejects it", async () => {
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        beforeCrashRecoveryMutation: async (input) => {
          if (input.phase === "resume") {
            throw new Error("resume denied");
          }
        },
      });
      const record = makeRecord({
        agent_id: "agent-crash-resume-denied",
        state: "error",
        surface_id: "surface:dead-resume-denied",
        workspace_id: "ws:1",
        cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        crash_recover: true,
        error: "Surface surface:dead-resume-denied disappeared",
      });
      stateMgr.writeState(record);
      liveSurfaces = [makeSurface("surface:witness")];
      await registry.reconstitute();

      await engine.runSweep();

      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:new",
        expect.objectContaining({
          workspace: "ws:1",
          collapsePane: false,
        }),
      );
      expect(engine.getAgentState(record.agent_id)).toMatchObject({
        state: "error",
        surface_id: record.surface_id,
        error: "Crash recovery failed: resume denied",
      });
    });

    it("persists the observer captured when creating a crash recovery surface", async () => {
      engine.dispose();
      const createdObserverId = "cmux:/tmp/created-owner.sock";
      let currentObserverId = createdObserverId;
      let persistedDuringLaunch: AgentRecord | null = null;
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces, {
        observerIdProvider: () => currentObserverId,
        observerEpochProvider: () => "stable-observer-epoch",
      });
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        beforeCrashRecoveryMutation: async (input) => {
          if (input.phase === "resume") {
            currentObserverId = "cmux:/tmp/foreign-owner.sock";
          }
        },
        launchCommandSender: async () => {
          persistedDuringLaunch = engine.getAgentState(
            "agent-crash-captured-owner",
          );
        },
      });
      const record = makeRecord({
        agent_id: "agent-crash-captured-owner",
        state: "error",
        surface_id: "surface:dead-owner",
        surface_uuid: "uuid-dead-owner",
        surface_observer_id: createdObserverId,
        workspace_id: "ws:1",
        cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        crash_recover: true,
        error: "Surface surface:dead-owner disappeared",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface("surface:witness"),
          id: "uuid-witness",
          workspace_ref: "workspace:witness",
        },
      ];
      await registry.reconstitute();

      await engine.runSweep();

      expect(currentObserverId).toBe("cmux:/tmp/foreign-owner.sock");
      expect(persistedDuringLaunch).toMatchObject({
        state: "booting",
        surface_id: "surface:new",
        surface_observer_id: createdObserverId,
        surface_provenance: "cmuxlayer_spawn",
      });
      expect(engine.getAgentState(record.agent_id)).toMatchObject({
        state: "booting",
        surface_observer_id: createdObserverId,
      });
    });

    it("blocks crash recovery and cleans the unbound surface on placement mismatch", async () => {
      engine.dispose();
      const observerId = "cmux:/tmp/recovery-owner.sock";
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces, {
        observerIdProvider: () => observerId,
        observerEpochProvider: () => `${observerId}@socket:1`,
      });
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          liveSurfaces = [
            {
              ...makeSurface("surface:new"),
              id: SPAWN_SURFACE_UUID,
              workspace_ref: "workspace:wrong",
            },
          ];
          return {
            workspace: "workspace:wrong",
            surface: "surface:new",
            surface_id: SPAWN_SURFACE_UUID,
            pane: "pane:1",
            title: "",
            type: "terminal",
          } satisfies CmuxNewSplitResult;
        },
      );
      const record = makeRecord({
        agent_id: "agent-crash-mismatch",
        state: "error",
        surface_id: "surface:dead",
        surface_uuid: "uuid-dead",
        surface_observer_id: observerId,
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        crash_recover: true,
        workspace_id: "workspace:intended",
        error: "Surface surface:dead disappeared",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface("surface:witness"),
          id: "uuid-witness",
          workspace_ref: "workspace:witness",
        },
      ];
      await registry.reconstitute();

      await engine.runSweep();

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(mockClient.sendKey).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:new",
        expect.objectContaining({
          workspace: "workspace:wrong",
          collapsePane: false,
        }),
      );
      expect(engine.getAgentState("agent-crash-mismatch")?.workspace_id).toBe(
        "workspace:intended",
      );
      expect(engine.getAgentState("agent-crash-mismatch")?.state).toBe(
        "error",
      );
      expect(engine.getAgentState("agent-crash-mismatch")?.error).toContain(
        "Spawn placement blocked: requested workspace:intended but cmux returned workspace:wrong",
      );
    });

    it("respawns launcher CLI agents with their resolved launcher name", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-crash",
          state: "working",
          surface_id: "surface:dead",
          repo: "agent-html-host",
          model: "gemini-2.5-pro",
          cli: "gemini",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          launcher_name: "agenthtmlhostGemini",
          crash_recover: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:dead")];
      await engine.getRegistry().reconstitute();

      liveSurfaces = [makeSurface("surface:other")];
      await runConfirmedSurfaceAbsenceSweep();

      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:new",
        "agenthtmlhostGemini -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        { workspace: "ws:1" },
      );
    });

    it("does not respawn an errored agent the user intentionally stopped", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stop",
          state: "error",
          surface_id: "surface:42",
          repo: "brainlayer",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          crash_recover: true,
          error: "Surface surface:42 disappeared",
        }),
      );
      await engine.getRegistry().reconstitute();

      await engine.stopAgent("agent-stop");
      expect(engine.getAgentState("agent-stop")).toMatchObject({
        state: "error",
        user_killed: true,
      });

      liveSurfaces = [makeSurface("surface:other")];
      await engine.runSweep();

      expect(mockClient.newSplit).not.toHaveBeenCalled();
    });

    it("stops retrying once crash recovery hits the max respawn ceiling", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-loop",
          state: "error",
          surface_id: "surface:gone",
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          crash_recover: true,
          respawn_attempts: MAX_RESPAWN_ATTEMPTS,
          error: "Surface surface:gone disappeared",
        }),
      );
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(engine.getAgentState("agent-loop")?.error).toContain(
        `Max crash recoveries exceeded: ${MAX_RESPAWN_ATTEMPTS}`,
      );
    });

    it("keeps crash recovery eligible after a transient respawn failure", async () => {
      (mockClient.send as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error("send failed"))
        .mockResolvedValue(undefined);

      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-retry",
          state: "working",
          surface_id: "surface:dead",
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          crash_recover: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:dead")];
      await engine.getRegistry().reconstitute();

      liveSurfaces = [makeSurface("surface:other")];
      await runConfirmedSurfaceAbsenceSweep();
      await engine.runSweep();

      expect(mockClient.newSplit).toHaveBeenCalledTimes(2);
      expect(engine.getAgentState("agent-retry")?.state).toBe("booting");
      expect(engine.getAgentState("agent-retry")?.respawn_attempts).toBe(2);
    });

    it("transitions crash recovery failures in creating state back to error", async () => {
      const transition = stateMgr.transition.bind(stateMgr);
      vi.spyOn(stateMgr, "transition").mockImplementation((...args) => {
        const [agentId, nextState] = args;
        if (agentId === "agent-creating" && nextState === "booting") {
          throw new Error("boot fail");
        }
        return transition(...args);
      });

      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-creating",
          state: "working",
          surface_id: "surface:dead",
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          crash_recover: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:dead")];
      await engine.getRegistry().reconstitute();

      liveSurfaces = [makeSurface("surface:other")];
      await runConfirmedSurfaceAbsenceSweep();

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(engine.getAgentState("agent-creating")).toMatchObject({
        state: "error",
        error: "Crash recovery failed: boot fail",
      });
    });

    it("counts failed recovery attempts even when surface creation fails immediately", async () => {
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("cmux unavailable"),
      );

      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-preflight",
          state: "working",
          surface_id: "surface:dead",
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          crash_recover: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:dead")];
      await engine.getRegistry().reconstitute();

      liveSurfaces = [makeSurface("surface:other")];
      await runConfirmedSurfaceAbsenceSweep();

      expect(engine.getAgentState("agent-preflight")).toMatchObject({
        state: "error",
        respawn_attempts: 1,
        error: "Crash recovery failed: cmux unavailable",
      });
    });

    it("continues recovering other agents when one recovery record disappears mid-catch", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-missing",
          state: "error",
          surface_id: "surface:gone-1",
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          crash_recover: true,
          error: "Surface surface:gone-1 disappeared",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-ok",
          state: "error",
          surface_id: "surface:gone-2",
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
          cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          crash_recover: true,
          error: "Surface surface:gone-2 disappeared",
        }),
      );
      await engine.getRegistry().reconstitute();

      stateMgr.removeState("agent-missing");

      await expect(engine.runSweep()).resolves.toBeUndefined();

      expect(engine.getAgentState("agent-missing")).toBeNull();
      expect(engine.getAgentState("agent-ok")).toMatchObject({
        state: "booting",
        respawn_attempts: 1,
      });
    });
  });

  describe("boot session capture", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    });

    it("never captures a Codex session id from screen output", async () => {
      const screenSessionId = "11111111-2222-7333-8444-555555555555";
      vi.setSystemTime(new Date("2026-08-11T10:00:30.000Z"));
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-pending-rollout-only",
          repo: "cmuxlayer",
          model: "gpt-5.6-sol",
          cli: "codex",
          surface_id: "surface:rollout-only",
          state: "booting",
          task_summary: "Fix rollout-only capture",
          created_at: "2026-08-11T10:00:00.000Z",
          updated_at: "2026-08-11T10:00:00.000Z",
          launch_cwd: "/Users/etanheyman/Gits/cmuxlayer",
        }),
      );
      liveSurfaces = [makeSurface("surface:rollout-only")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:rollout-only",
        text: [
          "OpenAI Codex",
          `To continue this session, run codex resume ${screenSessionId}`,
          "›",
        ].join("\n"),
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.captureBootSessionId(
        "cmuxlayerCodex-pending-rollout-only",
      );

      expect(
        engine.getAgentState("cmuxlayerCodex-pending-rollout-only"),
      ).toMatchObject({
        cli_session_id: null,
      });
      expect(engine.getAgentState("cmuxlayerCodex-11111111")).toBeNull();
    });

    it("matches Codex rollout identity by cwd and spawn window", async () => {
      const codexHome = join(TEST_DIR, "codex-home-matching");
      const rolloutRoot = join(codexHome, "sessions", "2026", "08", "11");
      const launchCwd = "/tmp/cmuxlayer-a3-rollout-target";
      const correctSessionId = "019fec96-588d-7000-8000-000000000001";
      const wrongCwdSessionId = "019fec96-588d-7000-8000-000000000002";
      const staleSessionId = "019fec96-588d-7000-8000-000000000003";
      const task = "Match this exact A3 rollout prompt";
      mkdirSync(rolloutRoot, { recursive: true });
      const writeRollout = (
        name: string,
        sessionId: string,
        cwd: string,
        mtime: string,
      ): string => {
        const path = join(rolloutRoot, name);
        writeFileSync(
          path,
          [
            JSON.stringify({
              type: "session_meta",
              payload: { id: sessionId, cwd },
            }),
            JSON.stringify({
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: task }],
              },
            }),
          ].join("\n"),
        );
        const timestamp = new Date(mtime);
        utimesSync(path, timestamp, timestamp);
        return path;
      };
      const correctPath = writeRollout(
        "rollout-correct.jsonl",
        correctSessionId,
        launchCwd,
        "2026-08-11T10:00:02.000Z",
      );
      writeRollout(
        "rollout-wrong-cwd.jsonl",
        wrongCwdSessionId,
        "/tmp/other-repo",
        "2026-08-11T10:00:03.000Z",
      );
      writeRollout(
        "rollout-stale.jsonl",
        staleSessionId,
        launchCwd,
        "2026-08-11T09:59:40.000Z",
      );
      vi.stubEnv("CODEX_HOME", codexHome);
      try {
        vi.setSystemTime(new Date("2026-08-11T10:00:05.000Z"));
        engine.dispose();
        const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
        engine = new AgentEngine(stateMgr, registry, mockClient, {
          spawnPreflight: async () => {},
        });
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerCodex-pending-rollout-match",
            repo: "cmuxlayer",
            cli: "codex",
            model: "gpt-5.6-sol",
            state: "booting",
            surface_id: "surface:rollout-match",
            task_summary: task,
            launch_cwd: launchCwd,
            created_at: "2026-08-11T10:00:00.000Z",
            updated_at: "2026-08-11T10:00:00.000Z",
          }),
        );
        liveSurfaces = [makeSurface("surface:rollout-match")];
        await registry.reconstitute();

        await engine.captureBootSessionId(
          "cmuxlayerCodex-pending-rollout-match",
        );

        expect(engine.getAgentState("cmuxlayerCodex-019fec96")).toMatchObject({
          cli_session_id: correctSessionId,
          cli_session_path: correctPath,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("uses Codex rollout identity instead of self-registration", async () => {
      const rolloutSessionId = "019fec96-588d-7000-8000-000000000000";
      const registeredSessionId = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
      const rolloutPath =
        "/Users/etanheyman/.codex/sessions/2026/08/11/rollout-2026-08-11T10-05-00-019fec96-588d-7000-8000-000000000000.jsonl";
      const transcriptResolver = vi.fn(() => ({
        session_id: rolloutSessionId,
        path: rolloutPath,
      }));
      const selfRegistrationResolver = vi.fn(() => ({
        session_id: registeredSessionId,
        path: null,
      }));
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: transcriptResolver,
        selfRegistrationSessionResolver: selfRegistrationResolver,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-pending-source",
          repo: "cmuxlayer",
          cli: "codex",
          model: "gpt-5.6-sol",
          state: "booting",
          surface_id: "surface:rollout-source",
          surface_uuid: "11111111-2222-4333-8444-555555555555",
          task_summary: "Fix rollout identity source",
          launch_cwd: "/Users/etanheyman/Gits/cmuxlayer",
        }),
      );
      liveSurfaces = [
        {
          ...makeSurface("surface:rollout-source"),
          id: "11111111-2222-4333-8444-555555555555",
        },
      ];
      await engine.getRegistry().reconstitute();

      await engine.captureBootSessionId("cmuxlayerCodex-pending-source");

      expect(selfRegistrationResolver).not.toHaveBeenCalled();
      expect(transcriptResolver).toHaveBeenCalledTimes(1);
      expect(engine.getAgentState("cmuxlayerCodex-019fec96")).toMatchObject({
        cli_session_id: rolloutSessionId,
        cli_session_path: rolloutPath,
      });
      expect(engine.getAgentState("cmuxlayerCodex-aaaaaaaa")).toBeNull();
    });

    it("does not advertise an unrunnable legacy session route", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "brainlayerClaude-legacy-route",
          repo: "brainlayerClaude [surface:199]",
          cli: "claude",
          cli_session_id: "019fec96-588d-7000-8000-000000000004",
          launcher_name: null,
        }),
      );
      await engine.getRegistry().reconstitute();

      expect(engine.resolveAgentRoute("brainlayerClaude-legacy-route")).toEqual(
        expect.objectContaining({
          session_id: "019fec96-588d-7000-8000-000000000004",
          resumable: false,
        }),
      );
      expect(
        engine.resolveAgentRoute("brainlayerClaude-legacy-route"),
      ).not.toHaveProperty("resume_command");
    });

    it("reads a moved UUID surface instead of a recycled cached ref", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const targetSession = "019f1111-2222-7333-8444-555555555555";
      const foreignSession = "019faaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
      vi.setSystemTime(new Date("2026-07-14T08:00:00.000Z"));
      stateMgr.writeState(
        makeRecord({
          agent_id: "brainlayerClaude-pending-moved",
          cli: "claude",
          model: "sonnet",
          state: "booting",
          surface_id: "surface:old",
          surface_uuid: stableUuid,
          created_at: "2026-07-14T07:59:55.000Z",
          updated_at: "2026-07-14T07:59:55.000Z",
        }),
      );
      liveSurfaces = [{ ...makeSurface("surface:old"), id: stableUuid }];
      await engine.getRegistry().reconstitute();
      liveSurfaces = [
        { ...makeSurface("surface:old"), id: "uuid-foreign" },
        { ...makeSurface("surface:new-route"), id: stableUuid },
      ];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => ({
          surface,
          text: `Session ID: ${
            surface === "surface:new-route" ? targetSession : foreignSession
          }`,
          lines: 80,
          scrollback_used: true,
        }),
      );

      const captured = await engine.captureBootSessionId(
        "brainlayerClaude-pending-moved",
      );

      expect(captured?.cli_session_id).toBe(targetSession);
      expect(mockClient.readScreen).toHaveBeenCalledWith(
        "surface:new-route",
        expect.anything(),
      );
      expect(mockClient.readScreen).not.toHaveBeenCalledWith(
        "surface:old",
        expect.anything(),
      );
    });

    it.each([
      [
        "claude",
        "sonnet",
        "5b9f4f35-2942-4c8b-b1af-d89d4e36c95d",
        `Claude Code
Session ID: 5b9f4f35-2942-4c8b-b1af-d89d4e36c95d`,
      ],
      [
        "cursor",
        "auto",
        "9e26fe1a-2374-4b15-b9b2-646ac7a8c2ef",
        `Cursor Agent
chatId: 9e26fe1a-2374-4b15-b9b2-646ac7a8c2ef`,
      ],
      [
        "gemini",
        "pro",
        "8c2f7f0c-00ee-4c6e-856d-cc7ae91f5274",
        `Gemini CLI
Resumable session: 8c2f7f0c-00ee-4c6e-856d-cc7ae91f5274`,
      ],
    ] as const)(
      "captures %s session ids from the boot banner within the first sweep",
      async (cli, model, sessionId, banner) => {
        liveSurfaces = [makeSpawnSurface()];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:new",
          text: banner,
          lines: 80,
          scrollback_used: true,
        });

        engine.startSweep(1000);
        const result = await engine.spawnAgent({
          repo: "brainlayer",
          model,
          cli,
          prompt: "Fix gap F",
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(
          (mockClient.readScreen as ReturnType<typeof vi.fn>).mock.calls,
        ).not.toContainEqual(["surface:new", { lines: 80, scrollback: true }]);
        expect(engine.getAgentState(result.agent_id)?.cli_session_id).toBe(
          sessionId,
        );
      },
    );

    it("captures session identity without changing the stable spawn id", async () => {
      const sessionId = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";
      liveSurfaces = [makeSpawnSurface()];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:new",
        text: `Claude Code
Session ID: ${sessionId}`,
        lines: 80,
        scrollback_used: true,
      });

      engine.startSweep(1000);

      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Fix gap F",
      });

      const stableAgentId = result.agent_id;
      expect(stableAgentId).toMatch(/^brainlayerClaude-[a-f0-9]{8}$/);
      writeHeartbeat(result.agent_id, { baseDir: TEST_DIR });
      const stableMarker = join(
        TEST_DIR,
        ".channel-dirs",
        `${encodeURIComponent(result.agent_id)}.created`,
      );
      expect(existsSync(stableMarker)).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);

      expect(engine.getAgentState(stableAgentId)).toMatchObject({
        agent_id: stableAgentId,
        cli_session_id: sessionId,
        cli_session_path: null,
      });
      expect(engine.getAgentState(result.agent_id)).toMatchObject({
        agent_id: stableAgentId,
        cli_session_id: sessionId,
        cli_session_path: null,
      });
      expect(stateMgr.readState(stableAgentId)?.agent_id).toBe(stableAgentId);
      expect(existsSync(stableMarker)).toBe(true);
    });

    it("periodically reaps only old pending markers absent from registry and state", async () => {
      vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const oldOrphan = `brainlayerClaude-pending-${nowSeconds - 90_000}-dead`;
      const oldKnown = `brainlayerClaude-pending-${nowSeconds - 90_000}-live`;
      writeHeartbeat(oldOrphan, { baseDir: TEST_DIR });
      writeHeartbeat(oldKnown, { baseDir: TEST_DIR });
      stateMgr.writeState(
        makeRecord({
          agent_id: oldKnown,
          surface_id: "surface:known-pending",
          state: "error",
        }),
      );
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(
        existsSync(
          join(
            TEST_DIR,
            ".channel-dirs",
            `${encodeURIComponent(oldOrphan)}.created`,
          ),
        ),
      ).toBe(false);
      expect(
        existsSync(
          join(
            TEST_DIR,
            ".channel-dirs",
            `${encodeURIComponent(oldKnown)}.created`,
          ),
        ),
      ).toBe(true);
    });

    it("retries marker maintenance promptly after a filesystem error", async () => {
      vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
      const markerDir = join(TEST_DIR, ".channel-dirs");
      writeFileSync(markerDir, "not a directory");

      await engine.runSweep();

      rmSync(markerDir, { force: true });
      const oldOrphan = `brainlayerClaude-pending-${Math.floor(Date.now() / 1_000) - 90_000}-retry`;
      writeHeartbeat(oldOrphan, { baseDir: TEST_DIR });
      const markerPath = join(
        markerDir,
        `${encodeURIComponent(oldOrphan)}.created`,
      );
      vi.setSystemTime(new Date(Date.now() + 60_000));

      await engine.runSweep();

      expect(existsSync(markerPath)).toBe(false);
    });

    it("captures the real session id from transcript metadata when the screen has no UUID", async () => {
      const sessionId = "019e942c-0dda-76f2-bbca-0ef6e484d1c9";
      const sessionPath =
        "/Users/etanheyman/.codex/sessions/2026/06/05/rollout.jsonl";
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: (agent) =>
          agent.cli === "codex" && agent.repo === "brainlayer"
            ? { session_id: sessionId, path: sessionPath }
            : null,
      });
      liveSurfaces = [makeSpawnSurface()];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:new",
        text: "codex> ",
        lines: 80,
        scrollback_used: true,
      });

      engine.startSweep(1000);
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "Fix gap F",
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(engine.getAgentState(result.agent_id)).toMatchObject({
        agent_id: result.agent_id,
        cli_session_id: sessionId,
        cli_session_path: sessionPath,
      });
      expect(engine.getAgentState(result.agent_id)?.agent_id).toBe(result.agent_id);
    });

    it("captures transcript session identity after boot has already reached ready", async () => {
      vi.setSystemTime(new Date("2026-07-05T19:20:30.000Z"));
      const sessionId = "019f0100-051b-4c8a-b836-28ab64144c85";
      const sessionPath =
        "/Users/etanheyman/.claude/projects/-Users-etanheyman-Gits-cmuxlayer/019f0100-051b-4c8a-b836-28ab64144c85.jsonl";
      const transcriptResolver = vi.fn(() => ({
        session_id: sessionId,
        path: sessionPath,
      }));
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: transcriptResolver,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerClaude-pending-ready-jsonl",
          repo: "cmuxlayer",
          model: "claude-opus-4-8",
          cli: "claude",
          surface_id: "surface:ready-jsonl",
          state: "ready",
          task_summary: "Session-capture live probe",
          created_at: "2026-07-05T19:16:13.285Z",
          updated_at: "2026-07-05T19:17:17.739Z",
          launch_cwd: "/Users/etanheyman/Gits/cmuxlayer",
          worktree_path: "/Users/etanheyman/Gits/cmuxlayer",
        }),
      );
      liveSurfaces = [makeSurface("surface:ready-jsonl")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:ready-jsonl",
        text: "Claude Code\nWhat can I help you with?\n❯ ",
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(transcriptResolver).toHaveBeenCalledTimes(1);
      expect(engine.getAgentState("cmuxlayerClaude-019f0100")).toMatchObject({
        agent_id: "cmuxlayerClaude-019f0100",
        state: "ready",
        cli_session_id: sessionId,
        cli_session_path: sessionPath,
      });
      expect(engine.resolveAgentRoute("cmuxlayerClaude-019f0100")).toMatchObject({
        session_id: sessionId,
        resumable: true,
      });
    });

    it("does not capture Codex screen identity after the initial boot window", async () => {
      vi.setSystemTime(new Date("2026-06-25T08:02:30.000Z"));
      const sessionId = "019f0010-1111-7222-8333-444455556666";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-pending-late",
          repo: "cmuxlayer",
          model: "gpt-5.4",
          cli: "codex",
          surface_id: "surface:late-session",
          state: "booting",
          task_summary: "Fix late session capture",
          created_at: "2026-06-25T08:00:00.000Z",
          updated_at: "2026-06-25T08:00:00.000Z",
        }),
      );
      liveSurfaces = [makeSurface("surface:late-session")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:late-session",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.4",
          `To continue this session, run codex resume ${sessionId}`,
          "",
          "›",
        ].join("\n"),
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("cmuxlayerCodex-pending-late")).toMatchObject({
        agent_id: "cmuxlayerCodex-pending-late",
        state: "ready",
        cli_session_id: null,
      });
      expect(engine.getAgentState("cmuxlayerCodex-019f0010")).toBeNull();
      expect(engine.resolveAgentRoute("cmuxlayerCodex-pending-late")).toMatchObject({
        session_id: null,
        resumable: false,
      });
    });

    it("does not bind a late blank-prompt boot record to an unattributed transcript", async () => {
      vi.setSystemTime(new Date("2026-06-25T08:02:30.000Z"));
      const sessionId = "019f0020-1111-7222-8333-444455556666";
      const transcriptResolver = vi.fn(() => ({
        session_id: sessionId,
        path: "/Users/etanheyman/.codex/sessions/unrelated.jsonl",
      }));
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: transcriptResolver,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-pending-blank",
          repo: "cmuxlayer",
          model: "gpt-5.4",
          cli: "codex",
          surface_id: "surface:blank-session",
          state: "booting",
          task_summary: "",
          created_at: "2026-06-25T08:00:00.000Z",
          updated_at: "2026-06-25T08:00:00.000Z",
        }),
      );
      liveSurfaces = [makeSurface("surface:blank-session")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:blank-session",
        text: ["OpenAI Codex", "Model: gpt-5.4", "", "›"].join("\n"),
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(transcriptResolver).not.toHaveBeenCalled();
      expect(engine.getAgentState("cmuxlayerCodex-pending-blank")).toMatchObject({
        agent_id: "cmuxlayerCodex-pending-blank",
        state: "ready",
        cli_session_id: null,
      });
      expect(engine.getAgentState("cmuxlayerCodex-019f0020")).toBeNull();
    });

    it("captures a blank-prompt managed launch when transcript identity is launch-attributed", async () => {
      vi.setSystemTime(new Date("2026-06-25T08:02:30.000Z"));
      const sessionId = "019f0022-1111-7222-8333-444455556666";
      const sessionPath = "/Users/etanheyman/.codex/sessions/promptless.jsonl";
      const transcriptResolver = vi.fn(() => ({
        session_id: sessionId,
        path: sessionPath,
      }));
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: transcriptResolver,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-pending-promptless",
          repo: "cmuxlayer",
          model: "gpt-5.4",
          cli: "codex",
          surface_id: "surface:promptless-session",
          state: "ready",
          task_summary: "",
          created_at: "2026-06-25T08:00:00.000Z",
          updated_at: "2026-06-25T08:01:00.000Z",
          launch_cwd: "/Users/etanheyman/Gits/cmuxlayer",
          worktree_path: "/Users/etanheyman/Gits/cmuxlayer",
        }),
      );
      liveSurfaces = [makeSurface("surface:promptless-session")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:promptless-session",
        text: ["OpenAI Codex", "Model: gpt-5.4", "", "›"].join("\n"),
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(transcriptResolver).toHaveBeenCalledTimes(1);
      expect(engine.getAgentState("cmuxlayerCodex-019f0022")).toMatchObject({
        agent_id: "cmuxlayerCodex-019f0022",
        state: "ready",
        cli_session_id: sessionId,
        cli_session_path: sessionPath,
      });
    });

    it("does not bind a late prompted boot record to an unattributed transcript", async () => {
      vi.setSystemTime(new Date("2026-06-25T08:02:30.000Z"));
      const sessionId = "019f0021-1111-7222-8333-444455556666";
      const transcriptResolver = vi.fn(() => null);
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: transcriptResolver,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-pending-prompted",
          repo: "cmuxlayer",
          model: "gpt-5.4",
          cli: "codex",
          surface_id: "surface:prompted-session",
          state: "booting",
          task_summary: "Fix launcher resumability",
          created_at: "2026-06-25T08:00:00.000Z",
          updated_at: "2026-06-25T08:00:00.000Z",
        }),
      );
      liveSurfaces = [makeSurface("surface:prompted-session")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:prompted-session",
        text: ["OpenAI Codex", "Model: gpt-5.4", "", "›"].join("\n"),
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(transcriptResolver).toHaveBeenCalledTimes(1);
      expect(
        engine.getAgentState("cmuxlayerCodex-pending-prompted"),
      ).toMatchObject({
        agent_id: "cmuxlayerCodex-pending-prompted",
        state: "ready",
        cli_session_id: null,
      });
      expect(engine.getAgentState("cmuxlayerCodex-019f0021")).toBeNull();
    });

    it("uses the saved launch cwd when capturing worktree transcript sessions", async () => {
      vi.setSystemTime(new Date("2026-06-19T05:00:30.000Z"));
      const home = join(TEST_DIR, "home");
      const worktreeCwd = join(TEST_DIR, "Gits", "cmuxlayer.wt", "skill-eval");
      const sessionId = "019e942c-0dda-76f2-bbca-0ef6e484d1c9";
      const sessionDir = join(home, ".codex", "sessions", "2026", "06", "19");
      const sessionPath = join(sessionDir, "rollout-worktree.jsonl");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        sessionPath,
        [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: sessionId,
              cwd: worktreeCwd,
            },
          }),
          JSON.stringify({
            type: "user_message",
            payload: { message: "Fix search gap F" },
          }),
        ].join("\n"),
      );

      vi.stubEnv("HOME", home);
      try {
        engine.dispose();
        const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
        engine = new AgentEngine(stateMgr, registry, mockClient, {
          spawnPreflight: async () => {},
        });
        liveSurfaces = [makeSurface("surface:new")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:new",
          text: "codex> ",
          lines: 80,
          scrollback_used: true,
        });
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerCodex-pending-worktree",
            repo: "cmuxlayer",
            model: "gpt-5.4",
            cli: "codex",
            surface_id: "surface:new",
            state: "booting",
            created_at: "2026-06-19T05:00:00.000Z",
            updated_at: "2026-06-19T05:00:00.000Z",
            launch_cwd: worktreeCwd,
            worktree_path: worktreeCwd,
          }),
        );
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(engine.getAgentState("cmuxlayerCodex-019e942c")).toMatchObject({
          agent_id: "cmuxlayerCodex-019e942c",
          cli_session_id: sessionId,
          cli_session_path: sessionPath,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each([
      {
        cli: "claude" as const,
        repo: "cmuxlayer",
        model: "sonnet",
        sessionId: "019f0000-1111-7222-8333-444455556666",
        agentId: "cmuxlayerClaude-019f0000",
      },
      {
        cli: "codex" as const,
        repo: "cmuxlayer",
        model: "gpt-5.4",
        sessionId: "019f0000-aaaa-7bbb-8ccc-ddddeeeeeeee",
        agentId: "cmuxlayerCodex-019f0000",
      },
    ])(
      "captures launcher-spawned $cli session identity from the real JSONL on boot",
      async ({ cli, repo, model, sessionId, agentId }) => {
        vi.setSystemTime(new Date("2026-06-25T08:00:30.000Z"));
        const home = join(TEST_DIR, `home-${cli}`);
        const codexHome = join(TEST_DIR, `codex-home-${cli}`);
        const launchCwd = join(TEST_DIR, "Gits", "cmuxlayer");
        const prompt = `Fix launcher resumability for ${cli}`;
        const sessionPath =
          cli === "claude"
            ? join(
                home,
                ".claude",
                "projects",
                launchCwd.replaceAll("/", "-"),
                `${sessionId}.jsonl`,
              )
            : join(
                codexHome,
                "sessions",
                "2026",
                "06",
                "25",
                `rollout-2026-06-25T08-00-01-${sessionId}.jsonl`,
              );
        mkdirSync(join(sessionPath, ".."), { recursive: true });
        writeFileSync(
          sessionPath,
          cli === "claude"
            ? [
                JSON.stringify({
                  type: "user",
                  message: { content: [{ type: "text", text: prompt }] },
                }),
                JSON.stringify({
                  type: "assistant",
                  message: { model, stop_reason: "end_turn", content: [] },
                }),
              ].join("\n")
            : [
                JSON.stringify({
                  type: "session_meta",
                  payload: { id: sessionId, cwd: launchCwd },
                }),
                JSON.stringify({
                  type: "user_message",
                  payload: { message: prompt },
                }),
              ].join("\n"),
        );

        vi.stubEnv("CMUXLAYER_HARNESS_HOME", home);
        vi.stubEnv("CODEX_HOME", codexHome);
        try {
          engine.dispose();
          const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
          engine = new AgentEngine(stateMgr, registry, mockClient, {
            spawnPreflight: async () => {},
          });
          liveSurfaces = [makeSurface("surface:new")];
          (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
            surface: "surface:new",
            text: `${cli}> `,
            lines: 80,
            scrollback_used: true,
          });
          stateMgr.writeState(
            makeRecord({
              agent_id: `${repo}${cli}-pending-jsonl`,
              repo,
              model,
              cli,
              surface_id: "surface:new",
              state: "booting",
              task_summary: prompt,
              created_at: "2026-06-25T08:00:00.000Z",
              updated_at: "2026-06-25T08:00:00.000Z",
              launch_cwd: launchCwd,
              worktree_path: launchCwd,
            }),
          );
          await engine.getRegistry().reconstitute();

          expect(engine.resolveAgentRoute(`${repo}${cli}-pending-jsonl`)).toMatchObject({
            session_id: null,
            resumable: false,
          });

          await engine.runSweep();

          const captured = engine.getAgentState(agentId);
          expect(captured).toMatchObject({
            agent_id: agentId,
            cli_session_id: sessionId,
            cli_session_path: sessionPath,
          });
          expect(engine.resolveAgentRoute(agentId)).toMatchObject({
            session_id: sessionId,
            resumable: true,
          });
          expect(engine.resolveAgentRoute(agentId).resume_command).toContain(
            sessionId,
          );
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );

    it.each([
      {
        cli: "claude" as const,
        sessionId: "019f0003-1111-7222-8333-444455556666",
        finalAgentId: "cmuxlayerClaude-019f0003",
      },
      {
        cli: "codex" as const,
        sessionId: "019f0003-aaaa-7bbb-8ccc-ddddeeeeeeee",
        finalAgentId: "cmuxlayerCodex-019f0003",
      },
    ])(
      "leaves launcher-spawned $cli unbound when the sole JSONL has a different launch prompt",
      async ({ cli, sessionId, finalAgentId }) => {
        vi.setSystemTime(new Date("2026-06-25T08:30:30.000Z"));
        const home = join(TEST_DIR, `home-mismatch-${cli}`);
        const codexHome = join(TEST_DIR, `codex-home-mismatch-${cli}`);
        const launchCwd = join(TEST_DIR, "Gits", "cmuxlayer");
        const expectedPrompt = `Expected launch prompt for ${cli}`;
        const otherPrompt = `Different launch prompt for ${cli}`;
        const pendingAgentId = `cmuxlayer${cli}-pending-mismatch`;
        const sessionPath =
          cli === "claude"
            ? join(
                home,
                ".claude",
                "projects",
                launchCwd.replaceAll("/", "-"),
                `${sessionId}.jsonl`,
              )
            : join(
                codexHome,
                "sessions",
                "2026",
                "06",
                "25",
                `rollout-2026-06-25T08-30-01-${sessionId}.jsonl`,
              );
        mkdirSync(join(sessionPath, ".."), { recursive: true });
        writeFileSync(
          sessionPath,
          cli === "claude"
            ? [
                JSON.stringify({
                  type: "user",
                  message: { content: [{ type: "text", text: otherPrompt }] },
                }),
                JSON.stringify({
                  type: "user",
                  message: {
                    content: [
                      {
                        type: "tool_result",
                        content: expectedPrompt,
                      },
                    ],
                  },
                }),
              ].join("\n")
            : [
                JSON.stringify({
                  type: "session_meta",
                  payload: { id: sessionId, cwd: launchCwd },
                }),
                JSON.stringify({
                  type: "user_message",
                  payload: { message: otherPrompt },
                }),
              ].join("\n"),
        );

        vi.stubEnv("CMUXLAYER_HARNESS_HOME", home);
        vi.stubEnv("CODEX_HOME", codexHome);
        try {
          engine.dispose();
          const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
          engine = new AgentEngine(stateMgr, registry, mockClient, {
            spawnPreflight: async () => {},
          });
          liveSurfaces = [makeSurface("surface:mismatch")];
          (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
            surface: "surface:mismatch",
            text: `${cli}> `,
            lines: 80,
            scrollback_used: true,
          });
          stateMgr.writeState(
            makeRecord({
              agent_id: pendingAgentId,
              repo: "cmuxlayer",
              model: cli === "claude" ? "sonnet" : "gpt-5.4",
              cli,
              surface_id: "surface:mismatch",
              state: "booting",
              task_summary: expectedPrompt,
              created_at: "2026-06-25T08:30:00.000Z",
              updated_at: "2026-06-25T08:30:00.000Z",
              launch_cwd: launchCwd,
              worktree_path: launchCwd,
            }),
          );
          await engine.getRegistry().reconstitute();

          await engine.runSweep();

          expect(engine.getAgentState(finalAgentId)).toBeNull();
          expect(engine.resolveAgentRoute(pendingAgentId)).toMatchObject({
            session_id: null,
            resumable: false,
          });
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );

    it("does not bind the wrong JSONL when two launcher agents share a cwd", async () => {
      vi.setSystemTime(new Date("2026-06-25T09:00:30.000Z"));
      const codexHome = join(TEST_DIR, "codex-home-shared-cwd");
      const launchCwd = join(TEST_DIR, "Gits", "cmuxlayer");
      const sessionDir = join(codexHome, "sessions", "2026", "06", "25");
      const firstSessionId = "019f0001-1111-7222-8333-444455556666";
      const secondSessionId = "019f0002-aaaa-7bbb-8ccc-ddddeeeeeeee";
      const firstPrompt = "Fix launcher resumability first agent";
      const secondPrompt = `${firstPrompt} but for the second agent`;
      const firstPath = join(
        sessionDir,
        `rollout-2026-06-25T09-00-01-${firstSessionId}.jsonl`,
      );
      const secondPath = join(
        sessionDir,
        `rollout-2026-06-25T09-00-02-${secondSessionId}.jsonl`,
      );
      mkdirSync(sessionDir, { recursive: true });
      for (const [path, id, prompt, mtime] of [
        [firstPath, firstSessionId, firstPrompt, "2026-06-25T09:00:10.000Z"],
        [secondPath, secondSessionId, secondPrompt, "2026-06-25T09:00:20.000Z"],
      ] as const) {
        writeFileSync(
          path,
          [
            JSON.stringify({
              type: "session_meta",
              payload: { id, cwd: launchCwd },
            }),
            JSON.stringify({
              type: "user_message",
              payload: { message: prompt },
            }),
            ...(id === secondSessionId
              ? [
                  JSON.stringify({
                    type: "agent_message",
                    payload: {
                      message: `Considering earlier work: ${firstPrompt}`,
                    },
                  }),
                ]
              : []),
          ].join("\n"),
        );
        const date = new Date(mtime);
        utimesSync(path, date, date);
      }

      vi.stubEnv("CODEX_HOME", codexHome);
      try {
        engine.dispose();
        const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
        engine = new AgentEngine(stateMgr, registry, mockClient, {
          spawnPreflight: async () => {},
        });
        liveSurfaces = [makeSurface("surface:first"), makeSurface("surface:second")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:first",
          text: "codex> ",
          lines: 80,
          scrollback_used: true,
        });
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerCodex-pending-first",
            repo: "cmuxlayer",
            model: "gpt-5.4",
            cli: "codex",
            surface_id: "surface:first",
            state: "booting",
            task_summary: firstPrompt,
            created_at: "2026-06-25T09:00:00.000Z",
            updated_at: "2026-06-25T09:00:00.000Z",
            launch_cwd: launchCwd,
            worktree_path: launchCwd,
          }),
        );
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerCodex-pending-second",
            repo: "cmuxlayer",
            model: "gpt-5.4",
            cli: "codex",
            surface_id: "surface:second",
            state: "booting",
            task_summary: secondPrompt,
            created_at: "2026-06-25T09:00:00.000Z",
            updated_at: "2026-06-25T09:00:00.000Z",
            launch_cwd: launchCwd,
            worktree_path: launchCwd,
          }),
        );
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(engine.getAgentState("cmuxlayerCodex-019f0001")).toMatchObject({
          cli_session_id: firstSessionId,
          cli_session_path: firstPath,
        });
        expect(engine.getAgentState("cmuxlayerCodex-019f0002")).toMatchObject({
          cli_session_id: secondSessionId,
          cli_session_path: secondPath,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("does not bind the wrong Claude JSONL when two launcher agents share a cwd", async () => {
      vi.setSystemTime(new Date("2026-06-25T09:30:30.000Z"));
      const home = join(TEST_DIR, "home-claude-shared-cwd");
      const launchCwd = join(TEST_DIR, "Gits", "cmuxlayer");
      const projectDir = join(
        home,
        ".claude",
        "projects",
        launchCwd.replaceAll("/", "-"),
      );
      const firstSessionId = "019f0004-1111-7222-8333-444455556666";
      const secondSessionId = "019f0005-aaaa-7bbb-8ccc-ddddeeeeeeee";
      const firstPrompt = "Fix launcher resumability first Claude agent";
      const secondPrompt = `${firstPrompt} but for the second Claude agent`;
      const firstPath = join(projectDir, `${firstSessionId}.jsonl`);
      const secondPath = join(projectDir, `${secondSessionId}.jsonl`);
      mkdirSync(projectDir, { recursive: true });
      for (const [path, prompt, mtime, includeNoise] of [
        [firstPath, firstPrompt, "2026-06-25T09:30:10.000Z", false],
        [secondPath, secondPrompt, "2026-06-25T09:30:20.000Z", true],
      ] as const) {
        writeFileSync(
          path,
          [
            JSON.stringify({
              type: "user",
              message: { content: [{ type: "text", text: prompt }] },
            }),
            ...(includeNoise
              ? [
                  JSON.stringify({
                    type: "user",
                    message: {
                      content: [
                        {
                          type: "tool_result",
                          content: `Tool output mentions ${firstPrompt}`,
                        },
                      ],
                    },
                  }),
                ]
              : []),
          ].join("\n"),
        );
        const date = new Date(mtime);
        utimesSync(path, date, date);
      }

      vi.stubEnv("CMUXLAYER_HARNESS_HOME", home);
      try {
        engine.dispose();
        const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
        engine = new AgentEngine(stateMgr, registry, mockClient, {
          spawnPreflight: async () => {},
        });
        liveSurfaces = [
          makeSurface("surface:claude-first"),
          makeSurface("surface:claude-second"),
        ];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:claude-first",
          text: "What can I help you with?\n>",
          lines: 80,
          scrollback_used: true,
        });
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerClaude-pending-first",
            repo: "cmuxlayer",
            model: "sonnet",
            cli: "claude",
            surface_id: "surface:claude-first",
            state: "booting",
            task_summary: firstPrompt,
            created_at: "2026-06-25T09:30:00.000Z",
            updated_at: "2026-06-25T09:30:00.000Z",
            launch_cwd: launchCwd,
            worktree_path: launchCwd,
          }),
        );
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerClaude-pending-second",
            repo: "cmuxlayer",
            model: "sonnet",
            cli: "claude",
            surface_id: "surface:claude-second",
            state: "booting",
            task_summary: secondPrompt,
            created_at: "2026-06-25T09:30:00.000Z",
            updated_at: "2026-06-25T09:30:00.000Z",
            launch_cwd: launchCwd,
            worktree_path: launchCwd,
          }),
        );
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(engine.getAgentState("cmuxlayerClaude-019f0004")).toMatchObject({
          cli_session_id: firstSessionId,
          cli_session_path: firstPath,
        });
        expect(engine.getAgentState("cmuxlayerClaude-019f0005")).toMatchObject({
          cli_session_id: secondSessionId,
          cli_session_path: secondPath,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("keeps a rollout-captured Codex spawn resumable after a mid-task stop", async () => {
      const sessionId = "019fec96-588d-7000-8000-000000000000";
      vi.setSystemTime(new Date("2026-08-11T10:10:00.000Z"));
      const codexHome = join(TEST_DIR, "codex-home-decisive");
      const sessionPath = join(
        codexHome,
        "sessions",
        "2026",
        "08",
        "11",
        `rollout-2026-08-11T10-10-00-${sessionId}.jsonl`,
      );
      mkdirSync(join(sessionPath, ".."), { recursive: true });
      const prompt = "Prove resumability after a mid-task stop";
      writeFileSync(
        sessionPath,
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: sessionId, cwd: process.cwd() },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: prompt }],
            },
          }),
        ].join("\n"),
      );
      const rolloutMtime = new Date("2026-08-11T10:10:01.000Z");
      utimesSync(sessionPath, rolloutMtime, rolloutMtime);
      vi.stubEnv("CODEX_HOME", codexHome);
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => ({ launcherName: "cmuxlayerCodex" }),
        stopPostConditionTimeoutMs: 20,
      });
      liveSurfaces = [makeSpawnSurface()];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:new",
        text: "OpenAI Codex\nWorking (12s • esc to interrupt)",
        lines: 80,
        scrollback_used: true,
      });
      const spawned = await engine.spawnAgent({
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        prompt,
        cwd: process.cwd(),
      });
      const spawnedRecord = engine
        .listAgents()
        .find((agent) => agent.surface_id === "surface:new");
      expect(spawnedRecord?.launch_cwd).toBeTruthy();
      writeFileSync(
        sessionPath,
        [
          JSON.stringify({
            type: "session_meta",
            payload: { id: sessionId, cwd: spawnedRecord?.launch_cwd },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: prompt }],
            },
          }),
        ].join("\n"),
      );
      utimesSync(sessionPath, rolloutMtime, rolloutMtime);
      await engine.captureBootSessionId(spawnedRecord!.agent_id);
      const finalAgentId = spawnedRecord!.agent_id;
      stateMgr.transition(finalAgentId, "ready");
      const working = stateMgr.transition(finalAgentId, "working");
      registry.set(finalAgentId, working);
      liveSurfaces.push({
        ...makeSurface("surface:witness"),
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      });
      (mockClient.closeSurface as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => {
          liveSurfaces = liveSurfaces.filter(
            (candidate) => candidate.ref !== surface,
          );
        },
      );

      await engine.stopAgent(finalAgentId);

      expect(engine.resolveAgentRoute(finalAgentId)).toMatchObject({
        state: "done",
        session_id: sessionId,
        resumable: true,
        resume_command:
          "cmuxlayerCodex --dangerously-bypass-approvals-and-sandbox resume 019fec96-588d-7000-8000-000000000000",
      });
      vi.unstubAllEnvs();
    });
  });

  describe("sidebar binding resilience", () => {
    it("preserves status and lifecycle memory when one workspace topology lookup fails", async () => {
      const targetUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
      const otherUuid = "033F0B64-780F-4F0B-BCF1-3B8E085A7383";
      let failTargetWorkspace = false;
      const workspaces = ["workspace:one", "workspace:two"];
      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: workspaces.map((ref, index) => ({
          ref,
          title: ref,
          index,
          selected: index === 0,
          pinned: false,
        })),
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ workspace }: { workspace: string }) => ({
          workspace_ref: workspace,
          window_ref: "window:one",
          panes: [
            {
              ref: `pane:${workspace}`,
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: [
                workspace === "workspace:one"
                  ? "surface:other"
                  : "surface:target",
              ],
            },
          ],
        }),
      );
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(
        async ({ workspace }: { workspace: string }) => {
          if (workspace === "workspace:two" && failTargetWorkspace) {
            throw new Error("workspace topology unavailable");
          }
          return {
            workspace_ref: workspace,
            window_ref: "window:one",
            pane_ref: `pane:${workspace}`,
            surfaces: [
              {
                ...makeSurface(
                  workspace === "workspace:one"
                    ? "surface:other"
                    : "surface:target",
                ),
                id: workspace === "workspace:one" ? otherUuid : targetUuid,
              },
            ],
          };
        },
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "partial-topology-agent",
          surface_id: "surface:target",
          surface_uuid: targetUuid,
          workspace_id: "workspace:two",
          state: "ready",
        }),
      );
      liveSurfaces = [
        { ...makeSurface("surface:other"), id: otherUuid },
        { ...makeSurface("surface:target"), id: targetUuid },
      ];
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      (mockClient.clearStatus as ReturnType<typeof vi.fn>).mockClear();
      (mockClient.log as ReturnType<typeof vi.fn>).mockClear();

      failTargetWorkspace = true;
      await engine.runSweep();
      expect(mockClient.clearStatus).not.toHaveBeenCalled();

      failTargetWorkspace = false;
      await engine.runSweep();
      expect(mockClient.log).not.toHaveBeenCalled();
    });

    it("preserves a UUID-backed row when one live surface loses identity coverage", async () => {
      const targetUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
      const neighborUuid = "033F0B64-780F-4F0B-BCF1-3B8E085A7383";
      let includeTargetUuid = true;
      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:mixed",
            title: "Mixed",
            index: 0,
            selected: true,
            pinned: false,
          },
        ],
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "workspace:mixed",
        window_ref: "window:mixed",
        panes: [
          {
            ref: "pane:mixed",
            index: 0,
            focused: true,
            surface_count: 2,
            surface_refs: ["surface:target", "surface:neighbor"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async () => ({
        workspace_ref: "workspace:mixed",
        window_ref: "window:mixed",
        pane_ref: "pane:mixed",
        surfaces: [
          {
            ...makeSurface("surface:target"),
            ...(includeTargetUuid ? { id: targetUuid } : {}),
          },
          { ...makeSurface("surface:neighbor"), id: neighborUuid },
        ],
      }));
      stateMgr.writeState(
        makeRecord({
          agent_id: "mixed-topology-agent",
          surface_id: "surface:target",
          surface_uuid: targetUuid,
          workspace_id: "workspace:mixed",
          state: "ready",
        }),
      );
      liveSurfaces = [
        { ...makeSurface("surface:target"), id: targetUuid },
        { ...makeSurface("surface:neighbor"), id: neighborUuid },
      ];
      await engine.getRegistry().reconstitute();
      await engine.runSweep();
      (mockClient.clearStatus as ReturnType<typeof vi.fn>).mockClear();
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockClear();

      includeTargetUuid = false;
      liveSurfaces = [
        makeSurface("surface:target"),
        { ...makeSurface("surface:neighbor"), id: neighborUuid },
      ];
      await engine.runSweep();

      expect(mockClient.clearStatus).not.toHaveBeenCalled();
      expect(mockClient.readScreen).not.toHaveBeenCalled();
      expect(engine.getAgentState("mixed-topology-agent")).toMatchObject({
        state: "ready",
        surface_uuid: targetUuid,
      });
    });

    it("does not re-emit spawned when one authoritative scan briefly omits a UUID", async () => {
      const targetUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
      const witnessUuid = "033F0B64-780F-4F0B-BCF1-3B8E085A7383";
      const target = {
        ...makeSurface("surface:target"),
        id: targetUuid,
        workspace_ref: "workspace:sidebar",
      };
      const witness = {
        ...makeSurface("surface:witness"),
        id: witnessUuid,
        workspace_ref: "workspace:sidebar",
      };
      stateMgr.writeState(
        makeRecord({
          agent_id: "sidebar-brief-uuid-miss",
          surface_id: target.ref,
          surface_uuid: targetUuid,
          workspace_id: "workspace:sidebar",
          state: "ready",
        }),
      );
      liveSurfaces = [target, witness];
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      expect(mockClient.log).toHaveBeenCalledWith(
        "spawned: brainlayer",
        expect.anything(),
      );
      (mockClient.log as ReturnType<typeof vi.fn>).mockClear();

      liveSurfaces = [witness];
      await engine.runSweep();
      liveSurfaces = [target, witness];
      await engine.runSweep();

      expect(mockClient.log).not.toHaveBeenCalledWith(
        "spawned: brainlayer",
        expect.anything(),
      );
      expect(engine.getAgentState("sidebar-brief-uuid-miss")?.state).toBe(
        "ready",
      );
    });

    it("does not use a UUID mapping from a contradictory topology snapshot", async () => {
      const duplicateUuid = "369F3724-02E9-4ACF-9F23-5CBA7AFCCF9B";
      (mockClient.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:contradictory",
            title: "Contradictory",
            index: 0,
            selected: true,
            pinned: false,
          },
        ],
      });
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "workspace:contradictory",
        window_ref: "window:contradictory",
        panes: [
          {
            ref: "pane:first",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:first"],
          },
          {
            ref: "pane:second",
            index: 1,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:second"],
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "workspace:contradictory",
        window_ref: "window:contradictory",
        pane_ref: pane ?? "pane:first",
        surfaces: [
          {
            ...makeSurface(
              pane === "pane:second" ? "surface:second" : "surface:first",
            ),
            id: duplicateUuid,
          },
        ],
      }));
      stateMgr.writeState(
        makeRecord({
          agent_id: "contradictory-topology-agent",
          surface_id: "surface:first",
          surface_uuid: duplicateUuid,
          workspace_id: "workspace:contradictory",
          state: "ready",
        }),
      );
      liveSurfaces = [
        { ...makeSurface("surface:first"), id: duplicateUuid },
        { ...makeSurface("surface:second"), id: duplicateUuid },
      ];
      await engine.getRegistry().reconstitute();
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockClear();

      await engine.runSweep();

      expect(mockClient.readScreen).not.toHaveBeenCalled();
      expect(mockClient.clearStatus).not.toHaveBeenCalled();
      expect(engine.getAgentState("contradictory-topology-agent")?.state).toBe(
        "ready",
      );
    });
  });

  describe("role placement reconciliation", () => {
    const leftFrame = { x: 0, y: 0, width: 500, height: 900 };
    const rightFrame = { x: 500, y: 0, width: 500, height: 900 };

    function installTwoColumnTopology(source: AgentRecord): void {
      const targetUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      liveSurfaces = [
        {
          ...makeSurface(source.surface_id),
          id: source.surface_uuid ?? undefined,
          workspace_ref: "ws:placement",
        },
        {
          ...makeSurface("surface:right-target"),
          id: targetUuid,
          workspace_ref: "ws:placement",
        },
      ];
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:placement",
        window_ref: "window:placement",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: [source.surface_id],
            surface_ids: [source.surface_uuid],
            selected_surface_ref: source.surface_id,
            pixel_frame: leftFrame,
          },
          {
            ref: "pane:right",
            index: 1,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:right-target"],
            surface_ids: [targetUuid],
            selected_surface_ref: "surface:right-target",
            pixel_frame: rightFrame,
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "ws:placement",
        window_ref: "window:placement",
        pane_ref: pane ?? "pane:left",
        surfaces:
          pane === "pane:right"
            ? [
                {
                  ...makeSurface("surface:right-target"),
                  id: targetUuid,
                  workspace_ref: "ws:placement",
                },
              ]
            : [
                {
                  ...makeSurface(source.surface_id),
                  id: source.surface_uuid ?? undefined,
                  workspace_ref: "ws:placement",
                },
              ],
      }));
    }

    it("never moves an unknown-provenance operator pane", async () => {
      const record = makeRecord({
        agent_id: "operator-worker",
        surface_id: "surface:operator-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "idle",
        role: "worker",
        surface_provenance: "unknown",
      });
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      installTwoColumnTopology(record);

      await engine.runSweep();

      expect(mockClient.moveSurface).not.toHaveBeenCalled();
    });

    it("moves an idle programmatic worker from column 0 to column 1", async () => {
      const record = makeRecord({
        agent_id: "idle-worker",
        surface_id: "surface:idle-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "idle",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      });
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      installTwoColumnTopology(record);

      await engine.runSweep();

      expect(mockClient.moveSurface).toHaveBeenCalledWith(expect.objectContaining({
        surface: record.surface_id,
        pane: "pane:right",
        workspace: "ws:placement",
        focus: false,
      }));
    });

    it("corrects the just-created programmatic surface at the spawn trigger", async () => {
      const record = makeRecord({
        agent_id: "booting-spawn-worker",
        surface_id: "surface:booting-spawn-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "booting",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      });
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      installTwoColumnTopology(record);

      await engine.reconcileRolePlacements("spawn", {
        agentIds: new Set([record.agent_id]),
      });

      expect(mockClient.moveSurface).toHaveBeenCalledWith(expect.objectContaining({
        surface: record.surface_id,
        pane: "pane:right",
        workspace: "ws:placement",
        focus: false,
      }));
    });

    it("leaves an unknown-provenance leftover untouched during boot sweep", async () => {
      const record = makeRecord({
        agent_id: "boot-operator-worker",
        surface_id: "surface:boot-operator-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "idle",
        role: "worker",
        surface_provenance: "unknown",
      });
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      installTwoColumnTopology(record);

      await engine.reconcileRolePlacements("boot");

      expect(mockClient.moveSurface).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
    });

    it("never moves a mid-work programmatic pane", async () => {
      const record = makeRecord({
        agent_id: "working-worker",
        surface_id: "surface:working-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "working",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      });
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      installTwoColumnTopology(record);

      await engine.runSweep();

      expect(mockClient.moveSurface).not.toHaveBeenCalled();
    });

    it("aborts an idle placement when the agent starts working before mutation", async () => {
      const record = makeRecord({
        agent_id: "idle-to-working-worker",
        surface_id: "surface:idle-to-working-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "idle",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      });
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      installTwoColumnTopology(record);
      let mutated = false;
      (mockClient.moveSurface as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (opts) => {
          const working = stateMgr.transition(record.agent_id, "working");
          engine.getRegistry().set(record.agent_id, working);
          await opts.beforeMutation?.();
          mutated = true;
          return {
            ok: true,
            workspace: opts.workspace ?? "ws:placement",
            surface: opts.surface,
            pane: opts.pane ?? "pane:right",
          };
        },
      );

      const summary = await engine.reconcileRolePlacements("idle");

      expect(mutated).toBe(false);
      expect(summary.moved).toEqual([]);
      expect(summary.skipped).toEqual([
        expect.objectContaining({
          agent_id: record.agent_id,
          reason: expect.stringMatching(/state|busy/i),
        }),
      ]);
    });

    it("aborts placement when the cached ref is recycled before mutation", async () => {
      const record = makeRecord({
        agent_id: "recycled-placement-worker",
        surface_id: "surface:recycled",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "idle",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      });
      const foreignUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      const targetUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      installTwoColumnTopology(record);
      let mutated = false;
      (mockClient.moveSurface as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (opts) => {
          liveSurfaces = [
            {
              ...makeSurface(record.surface_id),
              id: foreignUuid,
              workspace_ref: "ws:placement",
            },
            {
              ...makeSurface("surface:moved-stable-worker"),
              id: record.surface_uuid ?? undefined,
              workspace_ref: "ws:placement",
            },
            {
              ...makeSurface("surface:right-target"),
              id: targetUuid,
              workspace_ref: "ws:placement",
            },
          ];
          (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
            workspace_ref: "ws:placement",
            window_ref: "window:placement",
            panes: [
              {
                ref: "pane:left",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: [record.surface_id],
                surface_ids: [foreignUuid],
                pixel_frame: leftFrame,
              },
              {
                ref: "pane:right",
                index: 1,
                focused: false,
                surface_count: 2,
                surface_refs: [
                  "surface:moved-stable-worker",
                  "surface:right-target",
                ],
                surface_ids: [record.surface_uuid, targetUuid],
                pixel_frame: rightFrame,
              },
            ],
          });
          (
            mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
          ).mockImplementation(async ({ pane }: { pane?: string }) => ({
            workspace_ref: "ws:placement",
            window_ref: "window:placement",
            pane_ref: pane,
            surfaces:
              pane === "pane:left"
                ? [liveSurfaces[0]]
                : [liveSurfaces[1], liveSurfaces[2]],
          }));
          await opts.beforeMutation?.();
          mutated = true;
          return {
            ok: true,
            workspace: opts.workspace ?? "ws:placement",
            surface: opts.surface,
            pane: opts.pane ?? "pane:right",
          };
        },
      );

      const summary = await engine.reconcileRolePlacements("idle");

      expect(mutated).toBe(false);
      expect(summary.moved).toEqual([]);
      expect(summary.skipped).toEqual([
        expect.objectContaining({
          agent_id: record.agent_id,
          reason: expect.stringMatching(/uniquely bound/i),
        }),
      ]);
    });

    it("does not count a successful move as skipped when seed cleanup lacks a stable UUID", async () => {
      const record = makeRecord({
        agent_id: "missing-seed-uuid-worker",
        surface_id: "surface:missing-seed-uuid-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "idle",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      });
      const leadRef = "surface:lead";
      const leadUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      liveSurfaces = [
        {
          ...makeSurface(leadRef),
          id: leadUuid,
          workspace_ref: "ws:placement",
        },
        {
          ...makeSurface(record.surface_id),
          id: record.surface_uuid ?? undefined,
          workspace_ref: "ws:placement",
        },
      ];
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:placement",
        window_ref: "window:placement",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 2,
            surface_refs: [leadRef, record.surface_id],
            surface_ids: [leadUuid, record.surface_uuid],
            pixel_frame: leftFrame,
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        workspace_ref: "ws:placement",
        window_ref: "window:placement",
        pane_ref: "pane:left",
        surfaces: liveSurfaces,
      });
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (_direction, opts) => {
          await opts.beforeMutation?.();
          return {
            workspace: "ws:placement",
            surface: "surface:worker-column-seed",
            pane: "pane:right",
            title: "",
            type: "terminal",
          };
        },
      );
      (mockClient.moveSurface as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (opts) => {
          await opts.beforeMutation?.();
          return {
            ok: true,
            workspace: "ws:placement",
            surface: opts.surface,
            pane: "pane:right",
          };
        },
      );

      const summary = await engine.reconcileRolePlacements("idle");

      expect(summary.moved).toHaveLength(1);
      expect(summary.skipped).toEqual([]);
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
    });

    it("serializes worker-column seed cleanup by the seed's stable UUID", async () => {
      const record = makeRecord({
        agent_id: "single-column-worker",
        surface_id: "surface:single-column-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "idle",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      });
      const leadRef = "surface:lead";
      const leadUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const seedRef = "surface:worker-column-seed";
      const seedUuid = "33333333-4444-4555-8666-777777777777";
      let workerPane: "pane:left" | "pane:right" = "pane:left";
      let seedOpen = false;
      const refreshLiveSurfaces = () => {
        liveSurfaces = [
          {
            ...makeSurface(leadRef),
            id: leadUuid,
            workspace_ref: "ws:placement",
          },
          {
            ...makeSurface(record.surface_id),
            id: record.surface_uuid ?? undefined,
            workspace_ref: "ws:placement",
          },
          ...(seedOpen
            ? [
                {
                  ...makeSurface(seedRef),
                  id: seedUuid,
                  workspace_ref: "ws:placement",
                },
              ]
            : []),
        ];
      };
      refreshLiveSurfaces();
      stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          const leftRefs = [
            leadRef,
            ...(workerPane === "pane:left" ? [record.surface_id] : []),
          ];
          const leftIds = [
            leadUuid,
            ...(workerPane === "pane:left" ? [record.surface_uuid] : []),
          ];
          const rightRefs = [
            ...(seedOpen ? [seedRef] : []),
            ...(workerPane === "pane:right" ? [record.surface_id] : []),
          ];
          const rightIds = [
            ...(seedOpen ? [seedUuid] : []),
            ...(workerPane === "pane:right" ? [record.surface_uuid] : []),
          ];
          return {
            workspace_ref: "ws:placement",
            window_ref: "window:placement",
            panes: [
              {
                ref: "pane:left",
                index: 0,
                focused: true,
                surface_count: leftRefs.length,
                surface_refs: leftRefs,
                surface_ids: leftIds,
                pixel_frame: leftFrame,
              },
              ...(rightRefs.length > 0
                ? [
                    {
                      ref: "pane:right",
                      index: 1,
                      focused: false,
                      surface_count: rightRefs.length,
                      surface_refs: rightRefs,
                      surface_ids: rightIds,
                      pixel_frame: rightFrame,
                    },
                  ]
                : []),
            ],
          };
        },
      );
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async ({ pane }: { pane?: string }) => ({
        workspace_ref: "ws:placement",
        window_ref: "window:placement",
        pane_ref: pane,
        surfaces:
          pane === "pane:right"
            ? [
                ...(seedOpen
                  ? [
                      {
                        ...makeSurface(seedRef),
                        id: seedUuid,
                        workspace_ref: "ws:placement",
                      },
                    ]
                  : []),
                ...(workerPane === "pane:right"
                  ? [
                      {
                        ...makeSurface(record.surface_id),
                        id: record.surface_uuid ?? undefined,
                        workspace_ref: "ws:placement",
                      },
                    ]
                  : []),
              ]
            : [
                {
                  ...makeSurface(leadRef),
                  id: leadUuid,
                  workspace_ref: "ws:placement",
                },
                ...(workerPane === "pane:left"
                  ? [
                      {
                        ...makeSurface(record.surface_id),
                        id: record.surface_uuid ?? undefined,
                        workspace_ref: "ws:placement",
                      },
                    ]
                  : []),
              ],
      }));
      (mockClient.newSplit as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (_direction, opts) => {
          await opts.beforeMutation?.();
          seedOpen = true;
          refreshLiveSurfaces();
          return {
            workspace: "ws:placement",
            surface: seedRef,
            surface_id: seedUuid,
            pane: "pane:right",
            title: "",
            type: "terminal",
          };
        },
      );
      (mockClient.moveSurface as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (opts) => {
          await opts.beforeMutation?.();
          workerPane = "pane:right";
          return {
            ok: true,
            workspace: "ws:placement",
            surface: opts.surface,
            pane: "pane:right",
          };
        },
      );
      (mockClient.closeSurface as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (_surface, opts) => {
          await opts.beforeMutation?.();
          seedOpen = false;
          refreshLiveSurfaces();
        },
      );

      const summary = await engine.reconcileRolePlacements("idle");

      expect(summary.moved).toHaveLength(1);
      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        seedRef,
        expect.objectContaining({
          workspace: "ws:placement",
          stableSurfaceIdentity: seedUuid,
          beforeMutation: expect.any(Function),
        }),
      );
    });

    it("orders boot ingestion before provable-leftover sweep and publication", async () => {
      const events: string[] = [];
      const record = makeRecord({
        agent_id: "boot-leftover-worker",
        surface_id: "surface:boot-leftover-worker",
        surface_uuid: "11111111-2222-4333-8444-555555555555",
        workspace_id: "ws:placement",
        state: "done",
        role: "worker",
        surface_provenance: "cmuxlayer_spawn",
      });
      stateMgr.writeState(record);
      installTwoColumnTopology(record);
      (mockClient.moveSurface as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts) => {
          events.push("sweep");
          return {
            ok: true,
            workspace: opts.workspace ?? "ws:placement",
            surface: opts.surface,
            pane: opts.pane ?? "pane:right",
          };
        },
      );
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        fleetSidebarPublisher: {
          publish: ({ state }) => {
            if (state !== "discovering") events.push("placement-live");
          },
          dispose: () => {},
        },
      });
      const discovery = {
        scan: vi.fn(async () => {
          events.push("ingest");
          return [];
        }),
      };
      (mockClient.newSurface as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ pane, workspace }) => {
          events.push("spawn");
          return {
            workspace: workspace ?? "ws:placement",
            surface: "surface:post-boot-worker",
            surface_id: "99999999-2222-4333-8444-555555555555",
            pane,
            title: "",
            type: "terminal" as const,
          };
        },
      );

      await engine.initialize(discovery as any);
      await engine.spawnAgent({
        repo: "cmuxlayer",
        cli: "codex",
        prompt: "spawn immediately after boot",
        workspace: "ws:placement",
        role: "worker",
      });

      expect(events).toEqual(["ingest", "sweep", "placement-live", "spawn"]);
      expect(mockClient.newSurface).toHaveBeenCalledWith({
        pane: "pane:right",
        type: "terminal",
        workspace: "ws:placement",
      });
    });

    it("backfills legacy pending ids with their captured session identity before first publication", async () => {
      const sessionId = "019fec96-588d-7000-8000-000000000004";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-pending-1710000000-dead",
          repo: "cmuxlayer",
          cli: "codex",
          state: "ready",
          cli_session_id: sessionId,
          cli_session_path: "/tmp/codex-session.jsonl",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      const discovery = { scan: vi.fn(async () => []) };

      await engine.initialize(discovery as any);

      expect(
        stateMgr.readState("cmuxlayerCodex-pending-1710000000-dead"),
      ).toBeNull();
      expect(
        engine
          .getRegistry()
          .list()
          .some((record) => record.agent_id.includes("-pending-")),
      ).toBe(false);
      expect(engine.getAgentState("cmuxlayerCodex-019fec96")).toMatchObject({
        agent_id: "cmuxlayerCodex-019fec96",
        cli_session_id: sessionId,
        cli_session_path: "/tmp/codex-session.jsonl",
      });
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
      expect(result.agent?.agent_id).toBe("agent-ready");
      expect(result.agent?.state).toBe("ready");
      expect(result.agent?.session_id).toBeNull();
    });

    it("resolves ready from screen truth when registry still says booting", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "claude-screen-ready",
            state: "booting",
            surface_id: "surface:claude-screen-ready",
            workspace_id: "ws:screen-ready",
            cli: "claude",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:claude-screen-ready")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:claude-screen-ready",
          text: ["Claude Code", "What can I help you with?", "❯ "].join("\n"),
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("claude-screen-ready", "ready", 1_500);
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("ready");
        expect(engine.getAgentState("claude-screen-ready")?.state).toBe("ready");
        expect(mockClient.moveSurface).not.toHaveBeenCalled();
        expect(mockClient.readScreen).toHaveBeenCalledWith(
          "surface:claude-screen-ready",
          { lines: 80, workspace: "ws:screen-ready" },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves ready from the real Codex 0.144.3 working screen when registry is still booting", async () => {
      vi.useFakeTimers();
      try {
        const screenText = readFileSync(
          join(
            process.cwd(),
            "tests/fixtures/spawn/codex-0.144.3-surface-489-working.txt",
          ),
          "utf8",
        );
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerCodex-pending-1783943911-ep9m",
            state: "booting",
            surface_id: "surface:489",
            workspace_id: "workspace:2",
            cli: "codex",
            role: "worker",
            boot_prompt_pending: true,
            task_summary: "2026-07-13-spawn-reliability-mission.md",
          }),
        );
        liveSurfaces = [makeSurface("surface:489")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:489",
          text: screenText,
          lines: 80,
          scrollback_used: true,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "cmuxlayerCodex-pending-1783943911-ep9m",
          "ready",
          1_500,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("ready");
        expect(
          engine.getAgentState("cmuxlayerCodex-pending-1783943911-ep9m"),
        ).toMatchObject({
          state: "ready",
          boot_prompt_pending: false,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not demote a working Codex agent to idle from the active 0.144.3 screen", async () => {
      vi.useFakeTimers();
      try {
        const screenText = readFileSync(
          join(
            process.cwd(),
            "tests/fixtures/spawn/codex-0.144.3-surface-489-working.txt",
          ),
          "utf8",
        );
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerCodex-active-working",
            state: "working",
            surface_id: "surface:489",
            workspace_id: "workspace:2",
            cli: "codex",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:489")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:489",
          text: screenText,
          lines: 80,
          scrollback_used: true,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "cmuxlayerCodex-active-working",
          "idle",
          1_500,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        expect(result.state).toBe("working");
        expect(
          engine.getAgentState("cmuxlayerCodex-active-working")?.state,
        ).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    it("captures the boot session before waitFor marks a ready screen", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-03-14T03:40:10.000Z"));
        const sessionId = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";
        const provisionalAgentId = "brainlayerClaude-pending-wait";
        const finalAgentId = "brainlayerClaude-019d9aa5";
        stateMgr.writeState(
          makeRecord({
            agent_id: provisionalAgentId,
            repo: "brainlayer",
            model: "claude-sonnet-4.5",
            cli: "claude",
            state: "booting",
            surface_id: "surface:claude-screen-session",
            workspace_id: "ws:screen-session",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:claude-screen-session")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:claude-screen-session",
          text: [
            `Session ID: ${sessionId}`,
            "Claude Code",
            "What can I help you with?",
            "❯ ",
          ].join("\n"),
          lines: 80,
          scrollback_used: true,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(provisionalAgentId, "ready", 1_500);
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.agent?.agent_id).toBe(finalAgentId);
        expect(result.agent?.session_id).toBe(sessionId);
        expect(engine.getAgentState(finalAgentId)).toMatchObject({
          agent_id: finalAgentId,
          state: "ready",
          cli_session_id: sessionId,
        });
        expect(engine.getAgentState(provisionalAgentId)).toMatchObject({
          agent_id: finalAgentId,
          state: "ready",
          cli_session_id: sessionId,
        });
        expect(stateMgr.readState(provisionalAgentId)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves a prompt-pending booting agent once a real ready screen no longer shows the prompt", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "codex-pending-ready",
            state: "booting",
            surface_id: "surface:codex-pending-ready",
            workspace_id: "ws:codex-pending-ready",
            cli: "codex",
            role: "worker",
            boot_prompt_pending: true,
            task_summary: "Read and follow the phase 3 plan",
          }),
        );
        liveSurfaces = [makeSurface("surface:codex-pending-ready")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:codex-pending-ready",
          text: [
            "OpenAI Codex",
            "Model: gpt-5.5",
            "",
            "›",
          ].join("\n"),
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("codex-pending-ready", "ready", 1_500);
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("ready");
        expect(engine.getAgentState("codex-pending-ready")).toMatchObject({
          state: "ready",
          boot_prompt_pending: false,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve Gemini ready from bare prompt screen truth without identity", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "gemini-screen-ready",
            state: "booting",
            surface_id: "surface:gemini-screen-ready",
            cli: "gemini",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:gemini-screen-ready")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:gemini-screen-ready",
          text: "ready\n> ",
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("gemini-screen-ready", "ready", 1_000);
        await vi.advanceTimersByTimeAsync(1_500);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        expect(result.state).toBe("booting");
        expect(engine.getAgentState("gemini-screen-ready")?.state).toBe(
          "booting",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves Gemini ready from consecutive identity-backed screen-truth prompts", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "gemini-identity-screen-ready",
            state: "booting",
            surface_id: "surface:gemini-identity-screen-ready",
            cli: "gemini",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:gemini-identity-screen-ready")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:gemini-identity-screen-ready",
          text: "Gemini CLI\nready\n> ",
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "gemini-identity-screen-ready",
          "ready",
          2_500,
        );
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("ready");
        expect(
          engine.getAgentState("gemini-identity-screen-ready")?.state,
        ).toBe("ready");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve Gemini ready from identity-backed active screen truth", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "gemini-thinking-screen-ready",
            state: "booting",
            surface_id: "surface:gemini-thinking-screen-ready",
            cli: "gemini",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:gemini-thinking-screen-ready")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:gemini-thinking-screen-ready",
          text: "Gemini CLI\n> \nThinking...",
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "gemini-thinking-screen-ready",
          "ready",
          1_000,
        );
        await vi.advanceTimersByTimeAsync(1_500);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        expect(result.state).toBe("booting");
        expect(
          engine.getAgentState("gemini-thinking-screen-ready")?.state,
        ).toBe("booting");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve Kiro ready from a bare prompt without Kiro identity", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "kiro-bare-screen-ready",
            state: "booting",
            surface_id: "surface:kiro-bare-screen-ready",
            cli: "kiro",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:kiro-bare-screen-ready")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:kiro-bare-screen-ready",
          text: "ready\n> ",
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("kiro-bare-screen-ready", "ready", 1_000);
        await vi.advanceTimersByTimeAsync(1_500);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        expect(result.state).toBe("booting");
        expect(engine.getAgentState("kiro-bare-screen-ready")?.state).toBe(
          "booting",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears waitFor prompt progress when a ready wait times out", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "kiro-wait-timeout",
            state: "booting",
            surface_id: "surface:kiro-wait-timeout",
            cli: "kiro",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:kiro-wait-timeout")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:kiro-wait-timeout",
          text: "kiro> ",
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const firstWait = engine.waitFor("kiro-wait-timeout", "ready", 1_500);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await firstWait).toMatchObject({
          matched: false,
          source: "timeout",
        });

        const secondWait = engine.waitFor("kiro-wait-timeout", "ready", 1_500);
        await vi.advanceTimersByTimeAsync(2_000);
        const secondResult = await secondWait;

        expect(secondResult.matched).toBe(false);
        expect(secondResult.source).toBe("timeout");
        expect(engine.getAgentState("kiro-wait-timeout")?.state).toBe(
          "booting",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve ready from a prompt-looking active Claude screen", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "claude-screen-active",
            state: "booting",
            surface_id: "surface:claude-screen-active",
            workspace_id: "ws:screen-active",
            cli: "claude",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:claude-screen-active")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:claude-screen-active",
          text: ["Claude Code", "✻ Thinking", "❯ "].join("\n"),
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("claude-screen-active", "ready", 1_500);
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        expect(result.state).toBe("booting");
        expect(engine.getAgentState("claude-screen-active")?.state).toBe(
          "booting",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves idle from Cursor screen truth when registry still says working", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "cursor-screen-idle",
            state: "working",
            surface_id: "surface:cursor-screen-idle",
            workspace_id: "ws:cursor-idle",
            cli: "cursor",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:cursor-screen-idle")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:cursor-screen-idle",
          text: [
            "Cursor Agent",
            "⬡ Idle  1.2k tokens",
            "/ commands · @ files · ! shell · ctrl+r to review edits",
          ].join("\n"),
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("cursor-screen-idle", "idle", 1_500);
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("idle");
        expect(engine.getAgentState("cursor-screen-idle")?.state).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not clear sweep ready-prompt progress when waitFor polls a non-ready screen", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "gemini-sweep-progress",
            state: "booting",
            surface_id: "surface:gemini-sweep-progress",
            cli: "gemini",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:gemini-sweep-progress")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:gemini-sweep-progress",
          text: "Gemini CLI\nready\n> ",
          lines: 80,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        await engine.runSweep();
        expect(engine.getAgentState("gemini-sweep-progress")?.state).toBe(
          "booting",
        );

        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:gemini-sweep-progress",
          text: "still booting\n",
          lines: 80,
          scrollback_used: false,
        });
        const pending = engine.waitFor(
          "gemini-sweep-progress",
          "ready",
          1_500,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        const waitResult = await pending;
        expect(waitResult.matched).toBe(false);

        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:gemini-sweep-progress",
          text: "Gemini CLI\nready\n> ",
          lines: 80,
          scrollback_used: false,
        });
        await engine.runSweep();

        expect(engine.getAgentState("gemini-sweep-progress")?.state).toBe(
          "ready",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve done for a Codex worker from registry state without TASK_DONE output", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-registry-done",
            state: "done",
            surface_id: "surface:worker-registry-done",
            cli: "codex",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-registry-done")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-registry-done",
          text: "gpt-5.4\nWorking (1m 02s • esc to interrupt)",
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("worker-registry-done", "done", 2_500);
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        expect(result.state).toBe("done");
        expect(mockClient.readScreen).toHaveBeenCalledWith(
          "surface:worker-registry-done",
          { lines: 80 },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve done from Codex resume text without an explicit done signal", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-codex-resume",
            state: "done",
            surface_id: "surface:worker-codex-resume",
            cli: "codex",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-codex-resume")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-codex-resume",
          text: [
            "gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer",
            "To continue this session, run codex resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("worker-codex-resume", "done", 2_500);
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        expect(result.state).toBe("done");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves done for a Codex worker after TASK_DONE output evidence is confirmed", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-output-done",
            state: "ready",
            surface_id: "surface:worker-output-done",
            cli: "codex",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-output-done")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-output-done",
          text: "gpt-5.4\nTASK_DONE",
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("worker-output-done", "done", 7_000);
        await vi.advanceTimersByTimeAsync(6_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("done");
        expect(engine.getAgentState("worker-output-done")).toMatchObject({
          state: "done",
          task_done_detected_at: expect.any(String),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves a working agent with trailing TASK_DONE within two sweep ticks after confirmation", async () => {
      vi.useFakeTimers();
      try {
        const candidateAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(candidateAt.getTime() + 5_001));
        stateMgr.writeState(
          makeRecord({
            agent_id: "incident-working-done",
            state: "working",
            surface_id: "surface:incident-working-done",
            cli: "codex",
            role: "worker",
            task_done_candidate_at: candidateAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:incident-working-done")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:incident-working-done",
          text: "gpt-5.4\nImplemented the fix.\nTASK_DONE",
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "incident-working-done",
          "done",
          25 * 60_000,
        );
        await vi.advanceTimersByTimeAsync(1_100);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("done");
        expect(result.elapsed).toBeLessThan(2_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve done when TASK_DONE appears only in an echoed instruction box with an active spinner", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "incident-echo-active",
            state: "working",
            surface_id: "surface:incident-echo-active",
            cli: "codex",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:incident-echo-active")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:incident-echo-active",
          text: [
            "gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer",
            "→ Implement the fix. When complete, print exactly:",
            "TASK_DONE",
            "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
            "Working (1m 02s • esc to interrupt)",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("incident-echo-active", "done", 7_000);
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("incident-echo-active");
        expect(agent?.state).toBe("working");
        expect(agent?.task_done_candidate_at ?? null).toBeNull();
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve done when TASK_DONE appears with a recoverable blocker", async () => {
      vi.useFakeTimers();
      try {
        const candidateAt = new Date("2026-06-26T20:38:00.000Z");
        vi.setSystemTime(new Date(candidateAt.getTime() + 5_001));
        stateMgr.writeState(
          makeRecord({
            agent_id: "incident-recoverable-blocker-done",
            state: "working",
            surface_id: "surface:incident-recoverable-blocker-done",
            cli: "codex",
            role: "worker",
            task_done_candidate_at: candidateAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:incident-recoverable-blocker-done")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:incident-recoverable-blocker-done",
          text: [
            "OpenAI Codex",
            "Model: gpt-5.5",
            "I cannot commit, push, or open a PR without explicit permission, so I am parked.",
            "TASK_DONE",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "incident-recoverable-blocker-done",
          "done",
          7_000,
        );
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("incident-recoverable-blocker-done");
        expect(agent?.state).toBe("working");
        expect(agent?.task_done_candidate_at ?? null).toBeNull();
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve done from a Claude completion banner without an explicit done signal", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "claude-banner-only",
            state: "ready",
            surface_id: "surface:claude-banner-only",
            cli: "claude",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:claude-banner-only")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:claude-banner-only",
          text: [
            "Claude Code",
            "⏺ Completed successfully",
            "Preparing a follow-up response now.",
            "🤖 Sonnet 4.6 | 💰 $0.10",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("claude-banner-only", "done", 7_000);
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("claude-banner-only");
        expect(agent?.state).toBe("ready");
        expect(agent?.task_done_candidate_at ?? null).toBeNull();
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve done from boot prompt echo while prompt delivery is pending", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-pending-prompt",
            state: "booting",
            surface_id: "surface:worker-pending-prompt",
            cli: "codex",
            role: "worker",
            boot_prompt_pending: true,
            updated_at: new Date().toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-pending-prompt")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-pending-prompt",
          text: [
            "gpt-5.4 xhigh · 64% left · ~/Gits/cmuxlayer",
            "→ Implement the fix. When complete, print exactly:",
            "TASK_DONE",
            "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
            "Working (1m 02s • esc to interrupt)",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("worker-pending-prompt", "done", 7_000);
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("worker-pending-prompt");
        expect(agent?.state).toBe("booting");
        expect(agent?.boot_prompt_pending).toBe(true);
        expect(agent?.task_done_candidate_at ?? null).toBeNull();
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves Cursor done evidence when boot prompt pending is stale", async () => {
      vi.useFakeTimers();
      try {
        const agentId = "cmuxlayerCursor-pending-1780696860-r2fu";
        const candidateAt = new Date("2026-06-05T22:01:10.000Z");
        vi.setSystemTime(new Date(candidateAt.getTime() + 5_001));
        stateMgr.writeState(
          makeRecord({
            agent_id: agentId,
            state: "booting",
            surface_id: "surface:cursor-pending",
            repo: "cmuxlayer",
            model: "",
            cli: "cursor",
            role: "worker",
            boot_prompt_pending: true,
            task_done_candidate_at: candidateAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:cursor-pending")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:cursor-pending",
          text: readFileSync(
            new URL(
              "./fixtures/cursor-2026-06-04-task-done.txt",
              import.meta.url,
            ),
            "utf8",
          ),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(agentId, "done", 7_000);
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("done");
        expect(engine.getAgentState(agentId)).toMatchObject({
          state: "done",
          boot_prompt_pending: false,
          task_done_detected_at: expect.any(String),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve done from Cursor checkmark progress lines", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "cursor-progress-line",
            state: "ready",
            surface_id: "surface:cursor-progress-line",
            cli: "cursor",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:cursor-progress-line")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:cursor-progress-line",
          text: [
            "Auto · 45% · 0 files edited",
            "✓ Done reading src/server.ts",
            "",
            "⬡ Idle  1.2k tokens",
            "/ commands · @ files · ! shell · ctrl+r to review edits",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("cursor-progress-line", "done", 7_000);
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("cursor-progress-line");
        expect(agent?.state).toBe("ready");
        expect(agent?.task_done_candidate_at ?? null).toBeNull();
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves done for a non-Codex worker after trailing done output evidence is confirmed", async () => {
      vi.useFakeTimers({ now: new Date("2026-07-17T12:00:00.000Z") });
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "claude-output-done",
            state: "booting",
            surface_id: "surface:claude-output-done",
            cli: "claude",
            role: "worker",
          }),
        );
        liveSurfaces = [makeSurface("surface:claude-output-done")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:claude-output-done",
          text: "Implemented the requested fix.\nR2_WORKER_DONE 5",
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("claude-output-done", "done", 7_000);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(
          engine.getAgentState("claude-output-done")?.task_done_candidate_at,
        ).toEqual(expect.any(String));
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("screen");
        expect(result.state).toBe("done");
        expect(engine.getAgentState("claude-output-done")).toMatchObject({
          state: "done",
          task_done_detected_at: expect.any(String),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve transcript done while the JSONL mtime is fresh", async () => {
      vi.useFakeTimers();
      try {
        const now = new Date("2026-06-09T10:00:00.000Z");
        vi.setSystemTime(now);
        const transcript = join(TEST_DIR, "fresh-codex-done.jsonl");
        writeCodexDoneTranscript(transcript);
        utimesSync(transcript, now, now);
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-transcript-fresh",
            state: "working",
            surface_id: "surface:worker-transcript-fresh",
            cli: "codex",
            role: "worker",
            cli_session_path: transcript,
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-transcript-fresh")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-transcript-fresh",
          text: "gpt-5.4\nWorking (1m 02s • esc to interrupt)",
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "worker-transcript-fresh",
          "done",
          1_200,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        expect(engine.getAgentState("worker-transcript-fresh")?.state).toBe(
          "working",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve stale transcript done while the live Codex pane is actively working", async () => {
      vi.useFakeTimers();
      try {
        const now = new Date("2026-06-26T20:35:00.000Z");
        const stale = new Date(now.getTime() - 2_000);
        vi.setSystemTime(now);
        const transcript = join(TEST_DIR, "stale-codex-done-active-screen.jsonl");
        writeCodexDoneTranscript(transcript);
        utimesSync(transcript, stale, stale);
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-transcript-active-screen",
            state: "working",
            surface_id: "surface:worker-transcript-active-screen",
            cli: "codex",
            role: "worker",
            cli_session_id: "019f04ff-40c8-70c0-aca4-f0defa559e81",
            cli_session_path: transcript,
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-transcript-active-screen")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-transcript-active-screen",
          text: [
            "gpt-5.5 · 70% left · ~/Gits/voicelayer",
            "Working (1m 02s • esc to interrupt)",
            "• Explored",
            "  └ Read package.json",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "worker-transcript-active-screen",
          "done",
          1_200,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("worker-transcript-active-screen");
        expect(agent?.state).toBe("working");
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve stale transcript done while the live Codex pane is waiting", async () => {
      vi.useFakeTimers();
      try {
        const now = new Date("2026-06-26T20:36:00.000Z");
        const stale = new Date(now.getTime() - 2_000);
        vi.setSystemTime(now);
        const transcript = join(TEST_DIR, "stale-codex-done-waiting-screen.jsonl");
        writeCodexDoneTranscript(transcript);
        utimesSync(transcript, stale, stale);
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-transcript-waiting-screen",
            state: "working",
            surface_id: "surface:worker-transcript-waiting-screen",
            cli: "codex",
            role: "worker",
            cli_session_path: transcript,
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-transcript-waiting-screen")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-transcript-waiting-screen",
          text: [
            "gpt-5.5 · 70% left · ~/Gits/voicelayer",
            "• Waiting for command approval",
            "TASK_DONE",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "worker-transcript-waiting-screen",
          "done",
          1_200,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("worker-transcript-waiting-screen");
        expect(agent?.state).toBe("working");
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve stale transcript done while the live pane has a recoverable blocker", async () => {
      vi.useFakeTimers();
      try {
        const now = new Date("2026-06-26T20:36:30.000Z");
        const stale = new Date(now.getTime() - 2_000);
        vi.setSystemTime(now);
        const transcript = join(
          TEST_DIR,
          "stale-codex-done-recoverable-blocker.jsonl",
        );
        writeCodexDoneTranscript(transcript);
        utimesSync(transcript, stale, stale);
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-transcript-recoverable-blocker",
            state: "working",
            surface_id: "surface:worker-transcript-recoverable-blocker",
            cli: "codex",
            role: "worker",
            cli_session_path: transcript,
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-transcript-recoverable-blocker")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-transcript-recoverable-blocker",
          text: [
            "OpenAI Codex",
            "Model: gpt-5.5",
            "I cannot commit, push, or open a PR without explicit permission, so I am parked.",
            "TASK_DONE",
          ].join("\n"),
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "worker-transcript-recoverable-blocker",
          "done",
          1_200,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("worker-transcript-recoverable-blocker");
        expect(agent?.state).toBe("working");
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not resolve stale transcript done when the current screen cannot be read", async () => {
      vi.useFakeTimers();
      try {
        const now = new Date("2026-06-26T20:37:00.000Z");
        const stale = new Date(now.getTime() - 2_000);
        vi.setSystemTime(now);
        const transcript = join(TEST_DIR, "stale-codex-done-read-failure.jsonl");
        writeCodexDoneTranscript(transcript);
        utimesSync(transcript, stale, stale);
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-transcript-read-failure",
            state: "working",
            surface_id: "surface:worker-transcript-read-failure",
            cli: "codex",
            role: "worker",
            cli_session_path: transcript,
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-transcript-read-failure")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("cmux read failed"),
        );
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor(
          "worker-transcript-read-failure",
          "done",
          1_200,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.source).toBe("timeout");
        const agent = engine.getAgentState("worker-transcript-read-failure");
        expect(agent?.state).toBe("working");
        expect(agent?.task_done_detected_at ?? null).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves done from stale transcript ground truth with no screen banner", async () => {
      vi.useFakeTimers();
      try {
        const now = new Date("2026-06-09T10:00:00.000Z");
        const stale = new Date(now.getTime() - 2_000);
        vi.setSystemTime(now);
        const transcript = join(TEST_DIR, "stale-codex-done.jsonl");
        writeCodexDoneTranscript(transcript);
        utimesSync(transcript, stale, stale);
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-transcript-done",
            state: "working",
            surface_id: "surface:worker-transcript-done",
            cli: "codex",
            role: "worker",
            cli_session_path: transcript,
          }),
        );
        liveSurfaces = [makeSurface("surface:worker-transcript-done")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:worker-transcript-done",
          text: "gpt-5.4\nWorked for 16m 44s\ncodex> ",
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        const pending = engine.waitFor("worker-transcript-done", "done", 7_000);
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await pending;

        expect(result.matched).toBe(true);
        expect(result.source).toBe("transcript");
        expect(result.state).toBe("done");
        expect(engine.getAgentState("worker-transcript-done")).toMatchObject({
          state: "done",
          task_done_detected_at: expect.any(String),
        });
      } finally {
        vi.useRealTimers();
      }
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
      expect(result.agent?.agent_id).toBe("agent-err");
      expect(result.agent?.state).toBe("error");
    });

    it("requires confirmed absence before waitFor marks a missing surface errored", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "agent-surface-gone",
            state: "ready",
            surface_id: "surface:gone-during-wait",
            cli: "claude",
          }),
        );
        liveSurfaces = [makeSurface("surface:gone-during-wait")];
        await engine.getRegistry().reconstitute();

        liveSurfaces = [makeSurface("surface:other")];
        const pending = engine.waitFor(
          "agent-surface-gone",
          "done",
          25 * 60_000,
        );
        await vi.advanceTimersByTimeAsync(1_100);
        expect(engine.getAgentState("agent-surface-gone")?.state).toBe("ready");

        await vi.advanceTimersByTimeAsync(
          SURFACE_EVICTION_CONFIRMATION_MS + 1,
        );
        const result = await pending;

        expect(result.matched).toBe(false);
        expect(result.state).toBe("error");
        expect(result.source).toBe("sweep");
        expect(result.elapsed).toBeLessThan(25 * 60_000);
        expect(result.error).toContain(
          "Surface surface:gone-during-wait disappeared",
        );
      } finally {
        vi.useRealTimers();
      }
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
      expect(result.agent?.agent_id).toBe("agent-stuck");
      expect(result.agent?.state).toBe("booting");
    });

    it("does not promote a stale boot prompt that is still sitting in the composer", async () => {
      const prompt = "Read and follow docs.local/phase-3.md";
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stale-unsent-prompt",
          state: "booting",
          surface_id: "surface:stale-unsent-prompt",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: prompt,
          updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:stale-unsent-prompt")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:stale-unsent-prompt",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "",
          `› ${prompt}`,
          "gpt-5.5 xhigh · ~/Gits/cmuxlayer",
        ].join("\n"),
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-stale-unsent-prompt")).toMatchObject({
        state: "error",
        boot_prompt_pending: false,
        submit_verified: false,
        prompt_delivered: false,
        error: expect.stringMatching(/prompt.*not.*verif/i),
      });
    });

    it("errors a stale booting agent whose CLI never becomes interactive", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stale-shell",
          state: "booting",
          surface_id: "surface:stale-shell",
          updated_at: "2020-01-01T00:00:00.000Z",
        }),
      );
      liveSurfaces = [makeSurface("surface:stale-shell")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:stale-shell",
        text: "$ ",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-stale-shell")).toMatchObject({
        state: "error",
        error: expect.stringMatching(/stuck booting|never became interactive/i),
      });
    });

    it("detects state change via sweep", async () => {
      vi.useFakeTimers();
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "agent-boot",
            state: "booting",
            surface_id: "surface:42",
          }),
        );
        liveSurfaces = [makeSurface("surface:42")];
        await engine.getRegistry().reconstitute();

        // Simulate another process transitioning the state after 200ms.
        const pending = engine.waitFor("agent-boot", "ready", 5000);
        setTimeout(() => {
          stateMgr.transition("agent-boot", "ready");
        }, 200);

        await vi.advanceTimersByTimeAsync(1_000);
        const result = await pending;
        expect(result.matched).toBe(true);
        expect(result.source).toBe("sweep");
        expect(result.agent?.agent_id).toBe("agent-boot");
        expect(result.agent?.state).toBe("ready");
      } finally {
        vi.useRealTimers();
      }
    });

    it("promotes booting agents to ready when their CLI prompt appears", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot",
          state: "booting",
          surface_id: "surface:42",
          cli: "codex",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:42",
        text: "codex> ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();
      engine.startSweep(50);

      const result = await engine.waitFor("agent-boot", "ready", 5000);

      expect(result.matched).toBe(true);
      expect(result.state).toBe("ready");
      expect(mockClient.readScreen).toHaveBeenCalledWith("surface:42", {
        lines: 80,
      });
    });

    it("records a model mismatch when the live CLI banner disagrees with the requested model", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-model-mismatch",
          state: "booting",
          surface_id: "surface:model-mismatch",
          cli: "claude",
          model: "opus",
        }),
      );
      liveSurfaces = [makeSurface("surface:model-mismatch")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:model-mismatch",
        text: [
          "Claude Code",
          "🤖 Sonnet 4.6",
          "❯",
          "⏵⏵ bypass permissions on",
        ].join("\n"),
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-model-mismatch")).toMatchObject({
        state: "ready",
        parsed_model: "Sonnet 4.6",
        model_mismatch: true,
      });
    });

    it("leaves a fresh noninteractive boot record inside its boot window", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-fresh-shell",
          state: "booting",
          surface_id: "surface:fresh-shell",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:fresh-shell")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:fresh-shell",
        text: "$ ",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-fresh-shell")?.state).toBe("booting");
    });

    it("does not advance an auto-discovered boot record", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "auto-brainlayer-1",
          state: "booting",
          surface_id: "surface:auto-boot",
          cli: "claude",
        }),
      );
      liveSurfaces = [makeSurface("surface:auto-boot")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:auto-boot",
        text: "Claude Code\n🤖 Sonnet 4.6\n❯",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("auto-brainlayer-1")?.state).toBe("booting");
    });

    it("clears stale post-spawn liveness errors when a booting agent reaches ready", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-recovered",
          state: "booting",
          surface_id: "surface:recovered",
          cli: "codex",
          error:
            "Post-spawn liveness failed: surface surface:recovered is not live",
          quality: "degraded",
        }),
      );
      liveSurfaces = [makeSurface("surface:recovered")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:recovered",
        text: "codex> ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-recovered")).toMatchObject({
        state: "ready",
        error: null,
        quality: "unknown",
      });
    });

    it("reuses one tail read for boot capture, readiness, task done, and context checks in a sweep", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-reuse",
          state: "booting",
          surface_id: "surface:reuse",
          cli: "codex",
        }),
      );
      liveSurfaces = [makeSurface("surface:reuse")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:reuse",
        text: "codex> ",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(mockClient.readScreen).toHaveBeenCalledTimes(1);
      expect(mockClient.readScreen).toHaveBeenCalledWith("surface:reuse", {
        lines: 80,
      });
      expect(engine.getAgentState("agent-boot-reuse")?.state).toBe("ready");
    });

    it("does not transition lifecycle state from a screen whose UUID moved during read-screen", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-read-race",
          state: "booting",
          surface_id: "surface:old-read-route",
          surface_uuid: stableUuid,
          cli: "codex",
        }),
      );
      liveSurfaces = [
        {
          ...makeSurface("surface:old-read-route"),
          id: stableUuid,
        },
      ];
      (
        mockClient.readScreen as ReturnType<typeof vi.fn>
      ).mockImplementation(async (surface: string) => {
        liveSurfaces = [
          {
            ...makeSurface("surface:old-read-route"),
            id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          },
          {
            ...makeSurface("surface:new-read-route"),
            id: stableUuid,
          },
        ];
        return {
          surface,
          text: "codex> ",
          lines: 80,
          scrollback_used: false,
        };
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-read-race")?.state).toBe(
        "booting",
      );
    });

    it("does not promote booting agents while boot prompt delivery is pending", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot",
          state: "booting",
          surface_id: "surface:42",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:42",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "",
          "codex> Read and follow docs.local/phase-3.md",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot")?.state).toBe("booting");
    });

    it("does not clear prompt-pending when the Codex composer line is above the footer", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-composer-footer",
          state: "booting",
          surface_id: "surface:composer-footer",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:composer-footer")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:composer-footer",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "",
          "› Read and follow docs.local/phase-3.md",
          "gpt-5.5 xhigh · ~/Gits/cmuxlayer",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-composer-footer")).toMatchObject({
        state: "booting",
        boot_prompt_pending: true,
      });
    });

    it("does not clear prompt-pending when the visible prompt tail wraps onto continuation lines", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-wrapped-composer",
          state: "booting",
          surface_id: "surface:wrapped-composer",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:wrapped-composer")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:wrapped-composer",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "",
          "› Read and follow docs.local/",
          "phase-3.md",
          "gpt-5.5 xhigh · ~/Gits/cmuxlayer",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-wrapped-composer")).toMatchObject({
        state: "booting",
        boot_prompt_pending: true,
      });
    });

    it("does not clear prompt-pending when a narrow pane wraps the prompt outside the tail window", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-narrow-wrapped-composer",
          state: "booting",
          surface_id: "surface:narrow-wrapped-composer",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:narrow-wrapped-composer")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:narrow-wrapped-composer",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "› Read",
          "and follow",
          "docs.local/",
          "phase-3.md",
          "gpt-5.5 xhigh",
          "~/Gits/cmuxlayer",
          "99% context left",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(
        engine.getAgentState("agent-boot-narrow-wrapped-composer"),
      ).toMatchObject({
        state: "booting",
        boot_prompt_pending: true,
      });
    });

    it("does not clear prompt-pending when the composer marker wraps before the prompt text", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-marker-only-wrapped-composer",
          state: "booting",
          surface_id: "surface:marker-only-wrapped-composer",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:marker-only-wrapped-composer")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:marker-only-wrapped-composer",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "›",
          "Read and follow",
          "docs.local/phase-3.md",
          "gpt-5.5 xhigh",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(
        engine.getAgentState("agent-boot-marker-only-wrapped-composer"),
      ).toMatchObject({
        state: "booting",
        boot_prompt_pending: true,
      });
    });

    it.each([
      ["cursor", "Cursor Agent\ncursor> Read and follow docs.local/phase-3.md"],
      [
        "cursor",
        "Cursor Agent\nAuto\n→ Read and follow docs.local/phase-3.md",
      ],
      [
        "gemini",
        "Gemini CLI\ngemini> Read and follow docs.local/phase-3.md\n> ",
      ],
      ["kiro", "Kiro\nkiro> Read and follow docs.local/phase-3.md"],
    ] as const)(
      "does not clear prompt-pending for %s composer prefixes",
      async (cli, screenText) => {
        stateMgr.writeState(
          makeRecord({
            agent_id: `agent-boot-${cli}-composer`,
            state: "booting",
            surface_id: `surface:${cli}-composer`,
            cli,
            boot_prompt_pending: true,
            task_summary: "Read and follow docs.local/phase-3.md",
            updated_at: new Date().toISOString(),
          }),
        );
        liveSurfaces = [makeSurface(`surface:${cli}-composer`)];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: `surface:${cli}-composer`,
          text: screenText,
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        await engine.runSweep();
        await engine.runSweep();

        expect(engine.getAgentState(`agent-boot-${cli}-composer`)).toMatchObject(
          {
            state: "booting",
            boot_prompt_pending: true,
          },
        );
      },
    );

    it.each([
      [
        "claude",
        [
          "❯ Read and follow docs.local/phase-3.md",
          "Prompt accepted.",
          "Claude Code",
          "What can I help you with?",
          "❯",
        ].join("\n"),
      ],
      [
        "cursor",
        [
          "cursor> Read and follow docs.local/phase-3.md",
          "Prompt accepted.",
          "Cursor Agent",
          "→ Plan, search, build anything",
          "Auto",
        ].join("\n"),
      ],
      [
        "gemini",
        [
          "gemini> Read and follow docs.local/phase-3.md",
          "Prompt accepted.",
          "Gemini CLI",
          ">",
        ].join("\n"),
      ],
      [
        "kiro",
        [
          "kiro> Read and follow docs.local/phase-3.md",
          "Prompt accepted.",
          "kiro>",
        ].join("\n"),
      ],
    ] as const)(
      "treats stale %s prompt text before the latest identity marker as cleared",
      async (cli, screenText) => {
        stateMgr.writeState(
          makeRecord({
            agent_id: `agent-boot-${cli}-scrollback-ready`,
            state: "booting",
            surface_id: `surface:${cli}-scrollback-ready`,
            cli,
            boot_prompt_pending: true,
            task_summary: "Read and follow docs.local/phase-3.md",
            updated_at: new Date().toISOString(),
          }),
        );
        liveSurfaces = [makeSurface(`surface:${cli}-scrollback-ready`)];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: `surface:${cli}-scrollback-ready`,
          text: screenText,
          lines: 20,
          scrollback_used: false,
        });
        await engine.getRegistry().reconstitute();

        await engine.runSweep();
        await engine.runSweep();

        expect(
          engine.getAgentState(`agent-boot-${cli}-scrollback-ready`),
        ).toMatchObject({
          state: "ready",
          boot_prompt_pending: false,
        });
      },
    );

    it("promotes prompt-pending booting agents once a real ready prompt shows the prompt is gone", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-prompt-cleared",
          state: "booting",
          surface_id: "surface:cleared",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:cleared")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cleared",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "",
          "›",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-prompt-cleared")).toMatchObject({
        state: "ready",
        boot_prompt_pending: false,
      });
    });

    it("does not clear fresh prompt-pending agents when stored prompt text is unknown", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-empty-summary-fresh",
          state: "booting",
          surface_id: "surface:empty-summary-fresh",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:empty-summary-fresh")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:empty-summary-fresh",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "",
          "›",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-empty-summary-fresh")).toMatchObject(
        {
          state: "booting",
          boot_prompt_pending: true,
        },
      );
    });

    it("recovers stale prompt-pending booting agents with no stored prompt text once ready evidence is visible", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-empty-summary-ready",
          state: "booting",
          surface_id: "surface:empty-summary-ready",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "",
          updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:empty-summary-ready")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:empty-summary-ready",
        text: [
          "OpenAI Codex",
          "Model: gpt-5.5",
          "",
          "›",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-empty-summary-ready")).toMatchObject(
        {
          state: "ready",
          boot_prompt_pending: false,
        },
      );
    });

    it("does not treat old scrollback prompt text as pending once the current prompt is ready", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-prompt-scrollback",
          state: "booting",
          surface_id: "surface:scrollback",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:scrollback")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:scrollback",
        text: [
          "OpenAI Codex",
          "codex> Read and follow docs.local/phase-3.md",
          "Task accepted.",
          "",
          "OpenAI Codex",
          "Model: gpt-5.5",
          "",
          "›",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-prompt-scrollback")).toMatchObject(
        {
          state: "ready",
          boot_prompt_pending: false,
        },
      );
    });

    it("does not promote an idle managed pane when its boot prompt was never delivered", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-undelivered-prompt",
          state: "booting",
          surface_id: "surface:undelivered-prompt",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          prompt_delivered: false,
          submit_verified: null,
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:undelivered-prompt")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:undelivered-prompt",
        text: ["OpenAI Codex", "Model: gpt-5.5", "", "›"].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-undelivered-prompt")).toMatchObject({
        state: "booting",
        boot_prompt_pending: true,
        prompt_delivered: false,
        submit_verified: false,
      });
    });

    it("errors a stale managed pane whose boot prompt was never delivered", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stale-undelivered-prompt",
          state: "booting",
          surface_id: "surface:stale-undelivered-prompt",
          cli: "codex",
          boot_prompt_pending: true,
          task_summary: "Read and follow docs.local/phase-3.md",
          prompt_delivered: false,
          submit_verified: null,
          updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:stale-undelivered-prompt")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:stale-undelivered-prompt",
        text: ["OpenAI Codex", "Model: gpt-5.5", "", "›"].join("\n"),
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(
        engine.getAgentState("agent-stale-undelivered-prompt"),
      ).toMatchObject({
        state: "error",
        boot_prompt_pending: false,
        prompt_delivered: false,
        submit_verified: false,
        error: expect.stringMatching(/delivery was not verified/i),
      });
    });

    it("RC5: errors a stale pending boot prompt without readiness evidence even when its surface is alive", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot",
          state: "booting",
          surface_id: "surface:42",
          cli: "codex",
          boot_prompt_pending: true,
          updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot")).toMatchObject({
        state: "error",
        boot_prompt_pending: false,
        prompt_delivered: false,
        submit_verified: false,
        error: expect.stringMatching(/stuck booting|never became interactive/i),
      });
    });

    it("recovers stale pending Codex boot prompt when the pane is already usable", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-ready",
          state: "booting",
          surface_id: "surface:42",
          cli: "codex",
          boot_prompt_pending: true,
          updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:42",
        text: [
          "╭──────────────────────────╮",
          "│ OpenAI Codex             │",
          "│ Model: gpt-5.5 xhigh     │",
          "│ Directory: /Users/etanheyman/Gits/voicelayer │",
          "│ Permissions: YOLO        │",
          "╰──────────────────────────╯",
          "",
          "›",
        ].join("\n"),
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-ready")).toMatchObject({
        state: "ready",
        boot_prompt_pending: false,
        error: null,
      });
    });

    it("restores degraded quality when stale pending Codex boot recovery proves the pane is ready", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot-ready-degraded",
          state: "booting",
          surface_id: "surface:42",
          cli: "codex",
          boot_prompt_pending: true,
          quality: "degraded",
          error: "Post-spawn liveness failed: surface surface:42 is not live",
          updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:42",
        text: [
          "╭──────────────────────────╮",
          "│ OpenAI Codex             │",
          "│ Model: gpt-5.5 xhigh     │",
          "│ Directory: /Users/etanheyman/Gits/voicelayer │",
          "│ Permissions: YOLO        │",
          "╰──────────────────────────╯",
          "",
          "›",
        ].join("\n"),
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot-ready-degraded")).toMatchObject({
        state: "ready",
        boot_prompt_pending: false,
        error: null,
        quality: "unknown",
      });
    });

    it("recovers stale pending Gemini boot prompt with identity-backed readiness", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-gemini-boot-ready",
          state: "booting",
          surface_id: "surface:gemini",
          cli: "gemini",
          boot_prompt_pending: true,
          updated_at: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:gemini")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:gemini",
        text: "Gemini CLI\n> ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      expect(engine.getAgentState("agent-gemini-boot-ready")).toMatchObject({
        state: "booting",
        boot_prompt_pending: true,
      });

      await engine.runSweep();
      expect(engine.getAgentState("agent-gemini-boot-ready")).toMatchObject({
        state: "ready",
        boot_prompt_pending: false,
        error: null,
      });
    });

    it("does not promote low-confidence bare prompts without agent identity", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-gemini",
          state: "booting",
          surface_id: "surface:42",
          cli: "gemini",
          task_summary: "",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:42",
        text: "ready\n> ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      expect(engine.getAgentState("agent-gemini")?.state).toBe("booting");

      await engine.runSweep();
      expect(engine.getAgentState("agent-gemini")?.state).toBe("booting");
    });

    it("promotes low-confidence CLI prompts after consecutive identity-backed matches", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-gemini-identity",
          state: "booting",
          surface_id: "surface:gemini-identity",
          cli: "gemini",
          task_summary: "",
        }),
      );
      liveSurfaces = [makeSurface("surface:gemini-identity")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:gemini-identity",
        text: "Gemini CLI\nready\n> ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      expect(engine.getAgentState("agent-gemini-identity")?.state).toBe(
        "booting",
      );

      await engine.runSweep();
      expect(engine.getAgentState("agent-gemini-identity")?.state).toBe(
        "ready",
      );
    });

    it("throws for non-existent agent", async () => {
      await expect(
        engine.waitFor("nonexistent", "ready", 1000),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("shell-state CLI exit", () => {
    it("transitions a root agent to error after two shell sweeps and records the notification event", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex",
          state: "ready",
          surface_id: "surface:cli-exited",
          parent_agent_id: null,
          spawn_depth: 0,
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-exited")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-exited",
        text: DEAD_CODEX_SHELL_SCREEN,
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      expect(engine.getAgentState("cmuxlayerCodex")?.state).toBe("ready");

      await engine.runSweep();

      expect(engine.getAgentState("cmuxlayerCodex")).toMatchObject({
        state: "error",
        error: "Agent CLI exited to shell without done evidence",
      });
      expect(
        engine.getAgentState("cmuxlayerCodex")?.task_done_detected_at ?? null,
      ).toBeNull();
      expect(stateMgr.getEventLog().readEntries()).toContainEqual(
        expect.objectContaining({
          event_type: "agent_cli_exit",
          agent_id: "cmuxlayerCodex",
          surface_id: "surface:cli-exited",
          parent_agent_id: null,
          previous_state: "ready",
          control_state: "shell",
          consecutive_observations: 2,
          inbox_dispatched: false,
        }),
      );
    });

    it("requires consecutive shell sweeps before marking the CLI exited", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-intermittent",
          state: "ready",
          surface_id: "surface:cli-intermittent",
          parent_agent_id: null,
          spawn_depth: 0,
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-intermittent")];
      const readScreen = mockClient.readScreen as ReturnType<typeof vi.fn>;
      readScreen.mockResolvedValueOnce({
        surface: "surface:cli-intermittent",
        text: "$ ",
        lines: 20,
        scrollback_used: false,
      });
      readScreen.mockResolvedValueOnce({
        surface: "surface:cli-intermittent",
        text: "gpt-5.4 xhigh · 64% left\nWorking (2s • esc to interrupt)",
        lines: 20,
        scrollback_used: false,
      });
      readScreen.mockResolvedValue({
        surface: "surface:cli-intermittent",
        text: "$ ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();
      await engine.runSweep();

      expect(engine.getAgentState("cmuxlayerCodex-intermittent")?.state).toBe(
        "ready",
      );

      await engine.runSweep();

      expect(
        engine.getAgentState("cmuxlayerCodex-intermittent"),
      ).toMatchObject({
        state: "error",
        error: "Agent CLI exited to shell without done evidence",
      });
    });

    it("dispatches the CLI-exit notification to the parent when set", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-child",
          state: "working",
          surface_id: "surface:cli-exited-child",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-exited-child")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-exited-child",
        text: "$ ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          from: "cmuxlayer:lifecycle",
          to: "cmuxlayerClaude",
          tag: "agent_cli_exit",
          task: expect.stringContaining("cmuxlayerCodex-child"),
        }),
      ]);
      expect(stateMgr.getEventLog().readEntries()).toContainEqual(
        expect.objectContaining({
          event_type: "agent_cli_exit",
          agent_id: "cmuxlayerCodex-child",
          parent_agent_id: "cmuxlayerClaude",
          inbox_dispatched: true,
        }),
      );
    });

    it("auto-revives a resumable managed agent in the same surface with the raw harness command", async () => {
      const sessionId = "019faccc-1111-7222-8333-444455556666";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive",
          state: "working",
          surface_id: "surface:cli-auto-revive",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          model: "gpt-5.4",
          effort: "xhigh",
          cli: "codex",
          cli_session_id: sessionId,
          auto_revive: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-auto-revive")];
      const readScreen = mockClient.readScreen as ReturnType<typeof vi.fn>;
      readScreen
        .mockResolvedValueOnce({
          surface: "surface:cli-auto-revive",
          text: DEAD_CODEX_SHELL_SCREEN,
          lines: 80,
          scrollback_used: false,
        })
        .mockResolvedValueOnce({
          surface: "surface:cli-auto-revive",
          text: DEAD_CODEX_SHELL_SCREEN,
          lines: 80,
          scrollback_used: false,
        })
        .mockResolvedValue({
          surface: "surface:cli-auto-revive",
          text:
            `❯ codex resume ${sessionId}\n` +
            "gpt-5.4 xhigh · 64% left\nWorking (2s • esc to interrupt)",
          lines: 80,
          scrollback_used: false,
        });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:cli-auto-revive",
        `codex resume ${sessionId}`,
        expect.objectContaining({ workspace: undefined }),
      );
      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:cli-auto-revive",
        "return",
        expect.objectContaining({ workspace: undefined }),
      );
      expect(engine.getAgentState("cmuxlayerCodex-auto-revive")).toMatchObject({
        state: "booting",
        revive_attempts: 1,
        revive_last_outcome: "pending",
        revive_last_attempt_at: expect.any(String),
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([]);

      await engine.runSweep();

      expect(engine.getAgentState("cmuxlayerCodex-auto-revive")).toMatchObject({
        state: "ready",
        parsed_model: "gpt-5.4 xhigh",
        parsed_effort: "xhigh",
        effort_mismatch: false,
        revive_attempts: 1,
        revive_last_outcome: "revived",
        revive_completed_at: expect.any(String),
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          tag: "agent_cli_exit_revived",
          task: expect.stringContaining(
            "cmuxlayerCodex-auto-revive revived automatically on attempt 1",
          ),
        }),
      ]);
    });

    it("does not finalize revival from stale Codex identity above a failed-resume shell", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-failed-shell",
          state: "booting",
          surface_id: "surface:cli-auto-revive-failed-shell",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          cli: "codex",
          cli_session_id: "019faccc-4040-7555-8666-777788889999",
          auto_revive: true,
          effort: "xhigh",
          revive_attempts: 1,
          revive_last_outcome: "pending",
          revive_previous_state: "working",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [
        makeSurface("surface:cli-auto-revive-failed-shell"),
      ];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-auto-revive-failed-shell",
        text:
          "› signal: killed my current changes\n" +
          "  gpt-5.6-sol xhigh · ~/Gits/cmuxlayer\n" +
          "        %  etanheyman ~/Gits/cmuxlayer [main] $ codex resume 019faccc-4040-7555-8666-777788889999\n" +
          "Shellbook: starting the agent directly.\n" +
          "Shellbook: run `shellbook tui` in another terminal for the social pane.\n" +
          "Error: Failed to resume session: no rollout found (code -32600)\n" +
          "exit status 1\n" +
          "        %  etanheyman ~/Gits/cmuxlayer [main] $",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      // The harness refused the resume, so this is a recorded FAILURE with a
      // backoff -- never a revival, and never a silent hold that burns the boot
      // timeout before retrying the identical command.
      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-failed-shell"),
      ).toMatchObject({
        state: "error",
        revive_attempts: 1,
        revive_last_outcome: "failed",
        revive_last_error: expect.stringContaining("Failed to resume session"),
        revive_next_attempt_at: expect.any(String),
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([]);
    });

    it.each(["$", "#", "❯", "➜", ">"])(
      "does not finalize revival from stale Codex readiness after a %s shell prompt resume",
      async (shellPrompt) => {
        stateMgr.writeState(
          makeRecord({
            agent_id: "cmuxlayerCodex-auto-revive-failed-before-shell",
            state: "booting",
            surface_id: "surface:cli-auto-revive-failed-before-shell",
            surface_provenance: "cmuxlayer_spawn",
            parent_agent_id: "cmuxlayerClaude",
            cli: "codex",
            cli_session_id: "019faccc-4545-7555-8666-777788889999",
            auto_revive: undefined,
            effort: "xhigh",
            revive_attempts: 1,
            revive_last_outcome: "pending",
            revive_previous_state: "working",
            updated_at: new Date().toISOString(),
          }),
        );
        liveSurfaces = [
          makeSurface("surface:cli-auto-revive-failed-before-shell"),
        ];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:cli-auto-revive-failed-before-shell",
          text:
            "› signal: killed my current changes\n" +
            "gpt-5.6-sol xhigh · ~/Gits/cmuxlayer\n" +
            `${shellPrompt} codex resume 019faccc-4545-7555-8666-777788889999\n` +
            "Shellbook: starting the agent directly.\n" +
            "Error: Failed to resume session: no rollout found (code -32600)\n" +
            "exit status 1",
          lines: 80,
          scrollback_used: true,
        });
        await engine.getRegistry().reconstitute();

        await engine.runSweep();

        expect(
          engine.getAgentState("cmuxlayerCodex-auto-revive-failed-before-shell"),
        ).toMatchObject({
          state: "error",
          revive_attempts: 1,
          revive_last_outcome: "failed",
          revive_last_error: expect.stringContaining("Failed to resume session"),
        });
        expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([]);
      },
    );

    it("defers pending auto-revive readiness when the engine command echo is not visible", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-unrecognized-screen",
          state: "booting",
          surface_id: "surface:cli-auto-revive-unrecognized-screen",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          cli: "codex",
          cli_session_id: "019faccc-4747-7555-8666-777788889999",
          auto_revive: true,
          effort: "xhigh",
          revive_attempts: 1,
          revive_last_outcome: "pending",
          revive_previous_state: "working",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [
        makeSurface("surface:cli-auto-revive-unrecognized-screen"),
      ];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-auto-revive-unrecognized-screen",
        text:
          "› signal: killed my current changes\n" +
          "gpt-5.6-sol xhigh · ~/Gits/cmuxlayer\n" +
          "Shellbook: starting the agent directly.\n" +
          "Error: Failed to resume session: no rollout found (code -32600)\n" +
          "exit status 1",
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-unrecognized-screen"),
      ).toMatchObject({
        state: "booting",
        revive_attempts: 1,
        revive_last_outcome: "pending",
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([]);
    });

    it("does not finalize revival from stale Claude readiness after a failed resume", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerClaude-auto-revive-failed-before-shell",
          state: "booting",
          surface_id: "surface:claude-auto-revive-failed-before-shell",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          cli: "claude",
          cli_session_id: "019faccc-4646-7555-8666-777788889999",
          auto_revive: true,
          revive_attempts: 1,
          revive_last_outcome: "pending",
          revive_previous_state: "working",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [
        makeSurface("surface:claude-auto-revive-failed-before-shell"),
      ];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:claude-auto-revive-failed-before-shell",
        text:
          "Claude Code\n" +
          "❯\n" +
          "➜ MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --resume 019faccc-4646-7555-8666-777788889999\n" +
          "Error: No conversation found with session ID 019faccc-4646-7555-8666-777788889999\n" +
          "exit status 1",
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(
        engine.getAgentState("cmuxlayerClaude-auto-revive-failed-before-shell"),
      ).toMatchObject({
        state: "booting",
        revive_attempts: 1,
        revive_last_outcome: "pending",
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([]);
    });

    it.each([
      {
        cli: "cursor" as const,
        id: "019faccc-4848-7555-8666-777788889999",
        command:
          "cursor agent --resume 019faccc-4848-7555-8666-777788889999",
        staleReady: "Cursor Agent\ncursor>",
      },
      {
        cli: "gemini" as const,
        id: "019faccc-4949-7555-8666-777788889999",
        command:
          "MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 gemini --resume 019faccc-4949-7555-8666-777788889999",
        staleReady: "Gemini CLI\n>",
      },
      {
        cli: "kiro" as const,
        id: "019faccc-5151-7555-8666-777788889999",
        command:
          "cd ~/Gits/brainlayer && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli chat --resume-id 019faccc-5151-7555-8666-777788889999",
        staleReady: "kiro>",
      },
    ])(
      "does not finalize revival from stale $cli readiness after a failed resume",
      async ({ cli, id, command, staleReady }) => {
        const agentId = `cmuxlayer-${cli}-auto-revive-failed-before-shell`;
        const surfaceId = `surface:${cli}-auto-revive-failed-before-shell`;
        stateMgr.writeState(
          makeRecord({
            agent_id: agentId,
            state: "booting",
            surface_id: surfaceId,
            surface_provenance: "cmuxlayer_spawn",
            parent_agent_id: "cmuxlayerClaude",
            cli,
            cli_session_id: id,
            auto_revive: true,
            revive_attempts: 1,
            revive_last_outcome: "pending",
            revive_previous_state: "working",
            updated_at: new Date().toISOString(),
          }),
        );
        liveSurfaces = [makeSurface(surfaceId)];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: surfaceId,
          text:
            `${staleReady}\n` +
            `➜ ${command}\n` +
            "Error: resume failed\n" +
            "exit status 1",
          lines: 80,
          scrollback_used: true,
        });
        await engine.getRegistry().reconstitute();

        await engine.runSweep();
        await engine.runSweep();

        expect(engine.getAgentState(agentId)).toMatchObject({
          state: "booting",
          revive_attempts: 1,
          revive_last_outcome: "pending",
        });
        expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([]);
      },
    );

    it("accepts a successful retry after stale failed-resume scrollback", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-retry-success",
          state: "booting",
          surface_id: "surface:cli-auto-revive-retry-success",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          cli: "codex",
          cli_session_id: "019faccc-5050-7666-8777-888899990000",
          auto_revive: true,
          effort: "xhigh",
          revive_attempts: 2,
          revive_last_outcome: "pending",
          revive_previous_state: "working",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [
        makeSurface("surface:cli-auto-revive-retry-success"),
      ];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-auto-revive-retry-success",
        text:
          "Error: Failed to resume session: no rollout found (code -32600)\n" +
          "exit status 1\n" +
          "% codex resume 019faccc-5050-7666-8777-888899990000\n" +
          "OpenAI Codex\n" +
          "Model: gpt-5.6-sol xhigh\n" +
          "› Continue the previous task\n" +
          "gpt-5.6-sol xhigh · ~/Gits/cmuxlayer",
        lines: 80,
        scrollback_used: true,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-retry-success"),
      ).toMatchObject({
        state: "ready",
        revive_attempts: 2,
        revive_last_outcome: "revived",
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          tag: "agent_cli_exit_revived",
          task: expect.stringContaining(
            "cmuxlayerCodex-auto-revive-retry-success revived automatically on attempt 2",
          ),
        }),
      ]);
    });

    it("preserves the lifetime attempt count across repeated CLI-death episodes", async () => {
      const sessionId = "019faccc-1010-7222-8333-444455556666";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-flapping",
          state: "working",
          surface_id: "surface:cli-auto-revive-flapping",
          surface_provenance: "cmuxlayer_spawn",
          cli: "codex",
          cli_session_id: sessionId,
          auto_revive: true,
          revive_attempts: 9,
          revive_last_outcome: "revived",
          revive_completed_at: "2026-08-13T06:59:00.000Z",
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-auto-revive-flapping")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-auto-revive-flapping",
        text: DEAD_CODEX_SHELL_SCREEN,
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:cli-auto-revive-flapping",
        `codex resume ${sessionId}`,
        expect.objectContaining({ workspace: undefined }),
      );
      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-flapping"),
      ).toMatchObject({
        state: "booting",
        revive_attempts: MAX_RESPAWN_ATTEMPTS,
        revive_last_outcome: "pending",
      });
    });

    it("does not route an active failed auto-revive through legacy crash recovery", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-no-legacy-overlap",
          state: "error",
          surface_id: "surface:cli-auto-revive-no-legacy-overlap",
          surface_provenance: "cmuxlayer_spawn",
          cli_session_id: "019faccc-2020-7333-8444-555566667777",
          crash_recover: true,
          auto_revive: true,
          revive_attempts: 1,
          revive_last_outcome: "failed",
          revive_last_error: "agent disappeared during guarded resume",
          revive_next_attempt_at: "2099-08-13T07:00:00.000Z",
          error:
            'Auto-revive attempt 1 failed: Agent "child" disappeared during agent launch',
        }),
      );
      liveSurfaces = [
        makeSurface("surface:cli-auto-revive-no-legacy-overlap"),
      ];
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-no-legacy-overlap"),
      ).toMatchObject({
        state: "error",
        revive_attempts: 1,
        revive_last_outcome: "failed",
      });
    });

    it("records a failed same-surface revive attempt without sending a premature parent notification", async () => {
      engine.dispose();
      const resumeSender = vi.fn();
      engine = new AgentEngine(stateMgr, engine.getRegistry(), mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        launchCommandSender: resumeSender,
      });
      (mockClient.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("resume command rejected"),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-retry",
          state: "working",
          surface_id: "surface:cli-auto-revive-retry",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          cli_session_id: "019faccc-2222-7333-8444-555566667777",
          auto_revive: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-auto-revive-retry")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-auto-revive-retry",
        text: DEAD_CODEX_SHELL_SCREEN,
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(resumeSender).not.toHaveBeenCalled();

      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-retry"),
      ).toMatchObject({
        state: "error",
        revive_attempts: 1,
        revive_last_outcome: "failed",
        revive_last_error: "resume command rejected",
        revive_next_attempt_at: expect.any(String),
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([]);
    });

    it("keeps legacy death notification behavior when auto_revive is explicitly disabled", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-disabled",
          state: "working",
          surface_id: "surface:cli-auto-revive-disabled",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          cli_session_id: "019faccc-3333-7444-8555-666677778888",
          auto_revive: false,
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-auto-revive-disabled")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-auto-revive-disabled",
        text: DEAD_CODEX_SHELL_SCREEN,
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({ tag: "agent_cli_exit" }),
      ]);
    });

    it("treats a managed record with only a session-id prefix as non-resumable", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-invalid-session",
          state: "working",
          surface_id: "surface:cli-auto-revive-invalid-session",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          cli_session_id: "019faccc",
          auto_revive: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-auto-revive-invalid-session")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-auto-revive-invalid-session",
        text: DEAD_CODEX_SHELL_SCREEN,
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-invalid-session"),
      ).toMatchObject({
        state: "error",
      });
      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-invalid-session"),
      ).not.toHaveProperty("revive_last_outcome");
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({ tag: "agent_cli_exit" }),
      ]);
    });

    it("emits one unrecoverable notification with the exact raw manual fallback at the attempt cap", async () => {
      const sessionId = "019faccc-4444-7555-8666-777788889999";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-exhausted",
          state: "error",
          surface_id: "surface:cli-auto-revive-exhausted",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          cli_session_id: sessionId,
          auto_revive: true,
          revive_attempts: MAX_RESPAWN_ATTEMPTS,
          revive_last_attempt_at: "2026-08-13T07:00:00.000Z",
          revive_last_outcome: "failed",
          revive_last_error: "readiness timed out",
          revive_previous_state: "working",
          revive_consecutive_observations: 2,
          error: "Auto-revive attempt failed",
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-auto-revive-exhausted")];
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-exhausted"),
      ).toMatchObject({
        state: "error",
        revive_attempts: MAX_RESPAWN_ATTEMPTS,
        revive_last_outcome: "unrecoverable",
        revive_completed_at: expect.any(String),
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          tag: "agent_cli_exit_unrecoverable",
          task: expect.stringContaining(`Manual fallback: codex resume ${sessionId}`),
        }),
      ]);
      expect(
        readInbox("cmuxlayerClaude", { baseDir: TEST_DIR }).filter(
          (message) => message.tag === "agent_cli_exit_revived",
        ),
      ).toEqual([]);
    });

    it("revives a dead cursor pane with the real --resume flag and verifies it from the post-resume screen", async () => {
      const sessionId = "019faccc-6060-7555-8666-777788889999";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCursor-auto-revive",
          state: "working",
          surface_id: "surface:cursor-auto-revive",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          cli: "cursor",
          cli_session_id: sessionId,
          auto_revive: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:cursor-auto-revive")];
      const deadShell = "% cursor agent exited\n%";
      const readScreen = mockClient.readScreen as ReturnType<typeof vi.fn>;
      readScreen
        .mockResolvedValueOnce({
          surface: "surface:cursor-auto-revive",
          text: deadShell,
          lines: 80,
          scrollback_used: false,
        })
        .mockResolvedValueOnce({
          surface: "surface:cursor-auto-revive",
          text: deadShell,
          lines: 80,
          scrollback_used: false,
        })
        .mockResolvedValue({
          surface: "surface:cursor-auto-revive",
          text:
            `% cursor agent --resume ${sessionId}\n` +
            "Cursor Agent\n→ Plan, search, build anything\nAuto\ncursor>",
          lines: 80,
          scrollback_used: false,
        });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:cursor-auto-revive",
        `cursor agent --resume ${sessionId}`,
        expect.objectContaining({ workspace: undefined }),
      );

      await engine.runSweep();

      expect(engine.getAgentState("cmuxlayerCursor-auto-revive")).toMatchObject(
        {
          state: "ready",
          revive_attempts: 1,
          revive_last_outcome: "revived",
          revive_completed_at: expect.any(String),
        },
      );
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({ tag: "agent_cli_exit_revived" }),
      ]);
    });

    it("never types a pending resume into a surface that already recovered a live agent", async () => {
      const sessionId = "019faccc-6161-7555-8666-777788889999";
      engine.dispose();
      const launchCommandSender = vi.fn().mockResolvedValue(undefined);
      engine = new AgentEngine(stateMgr, engine.getRegistry(), mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        launchCommandSender,
        autoReviveBackoffBaseMs: 0,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCursor-auto-revive-recovered",
          state: "error",
          surface_id: "surface:cursor-auto-revive-recovered",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          cli: "cursor",
          cli_session_id: sessionId,
          auto_revive: true,
          revive_attempts: 1,
          revive_last_attempt_at: "2026-08-13T07:00:00.000Z",
          revive_next_attempt_at: "2026-08-13T07:00:00.000Z",
          revive_last_outcome: "failed",
          revive_last_error: "readiness timed out",
          revive_previous_state: "working",
          error: "Auto-revive attempt 1 failed",
        }),
      );
      liveSurfaces = [makeSurface("surface:cursor-auto-revive-recovered")];
      // Etan resumed this pane by hand: it is no longer a bare shell.
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cursor-auto-revive-recovered",
        text: [
          "Cursor Agent",
          "→ Plan, search, build anything",
          "Auto",
          "cursor>",
        ].join("\n"),
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(launchCommandSender).not.toHaveBeenCalled();
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(mockClient.sendKey).not.toHaveBeenCalled();
      const recovered = engine.getAgentState(
        "cmuxlayerCursor-auto-revive-recovered",
      );
      expect(recovered).toMatchObject({ revive_last_outcome: "revived" });
      expect(recovered?.revive_attempts).toBe(1);
    });

    it("records a rejected cursor resume as a failure instead of waiting out the boot timeout", async () => {
      const sessionId = "019faccc-6262-7555-8666-777788889999";
      engine.dispose();
      engine = new AgentEngine(stateMgr, engine.getRegistry(), mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        autoReviveBackoffBaseMs: 60_000,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCursor-auto-revive-rejected",
          state: "booting",
          surface_id: "surface:cursor-auto-revive-rejected",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          cli: "cursor",
          cli_session_id: sessionId,
          auto_revive: true,
          revive_attempts: 1,
          revive_last_outcome: "pending",
          revive_previous_state: "working",
          updated_at: new Date().toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:cursor-auto-revive-rejected")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cursor-auto-revive-rejected",
        text: [
          `% cursor agent --resume ${sessionId}`,
          "error: unknown option '--resume'",
          "(Did you mean --version?)",
          "%",
        ].join("\n"),
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(
        engine.getAgentState("cmuxlayerCursor-auto-revive-rejected"),
      ).toMatchObject({
        state: "error",
        revive_attempts: 1,
        revive_last_outcome: "failed",
        revive_last_error: expect.stringContaining("unknown option"),
        revive_next_attempt_at: expect.any(String),
      });
      // Backed off, not retried in the same breath.
      expect(mockClient.send).not.toHaveBeenCalled();
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([]);
    });

    it("escalates a repeatedly rejected cursor resume once with the real manual command", async () => {
      const sessionId = "019faccc-6363-7555-8666-777788889999";
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCursor-auto-revive-exhausted",
          state: "error",
          surface_id: "surface:cursor-auto-revive-exhausted",
          surface_provenance: "cmuxlayer_spawn",
          parent_agent_id: "cmuxlayerClaude",
          spawn_depth: 1,
          cli: "cursor",
          cli_session_id: sessionId,
          auto_revive: true,
          revive_attempts: MAX_RESPAWN_ATTEMPTS,
          revive_last_attempt_at: "2026-08-13T07:00:00.000Z",
          revive_next_attempt_at: "2026-08-13T07:00:00.000Z",
          revive_last_outcome: "failed",
          revive_last_error: "error: unknown option",
          revive_previous_state: "working",
          error: "Auto-revive attempt failed",
        }),
      );
      liveSurfaces = [makeSurface("surface:cursor-auto-revive-exhausted")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cursor-auto-revive-exhausted",
        text: [`% cursor agent --resume ${sessionId}`, "%"].join("\n"),
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(mockClient.send).not.toHaveBeenCalled();
      expect(
        engine.getAgentState("cmuxlayerCursor-auto-revive-exhausted"),
      ).toMatchObject({
        state: "error",
        revive_attempts: MAX_RESPAWN_ATTEMPTS,
        revive_last_outcome: "unrecoverable",
      });
      expect(readInbox("cmuxlayerClaude", { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          tag: "agent_cli_exit_unrecoverable",
          task: expect.stringContaining(
            `Manual fallback: cursor agent --resume ${sessionId}`,
          ),
        }),
      ]);
    });

    it("does not retry a failed auto-revive after the agent is intentionally stopped", async () => {
      const launchCommandSender = vi.fn().mockResolvedValue(undefined);
      engine.dispose();
      engine = new AgentEngine(stateMgr, engine.getRegistry(), mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        launchCommandSender,
        autoReviveBackoffBaseMs: 0,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-stopped",
          state: "error",
          surface_id: "surface:cli-auto-revive-stopped",
          surface_provenance: "cmuxlayer_spawn",
          cli_session_id: "019faccc-5555-7666-8777-888899990000",
          auto_revive: true,
          user_killed: true,
          revive_attempts: 1,
          revive_last_attempt_at: "2026-08-13T07:00:00.000Z",
          revive_next_attempt_at: "2026-08-13T07:00:00.000Z",
          revive_last_outcome: "failed",
          revive_last_error: "first resume failed",
          error: "Auto-revive attempt 1 failed",
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-auto-revive-stopped")];
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(launchCommandSender).not.toHaveBeenCalled();
      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-stopped"),
      ).toMatchObject({
        state: "error",
        user_killed: true,
        revive_attempts: 1,
        revive_last_outcome: "failed",
      });
    });

    it("retries failed auto-revive attempts with exponential backoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-13T07:00:00.000Z"));
      const rawResumeSend = mockClient.send as ReturnType<typeof vi.fn>;
      rawResumeSend.mockRejectedValue(new Error("resume still unavailable"));
      engine.dispose();
      engine = new AgentEngine(stateMgr, engine.getRegistry(), mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        autoReviveBackoffBaseMs: 1_000,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "cmuxlayerCodex-auto-revive-backoff",
          state: "working",
          surface_id: "surface:cli-auto-revive-backoff",
          surface_provenance: "cmuxlayer_spawn",
          cli_session_id: "019faccc-6666-7777-8888-999900001111",
          auto_revive: true,
        }),
      );
      liveSurfaces = [makeSurface("surface:cli-auto-revive-backoff")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:cli-auto-revive-backoff",
        text: DEAD_CODEX_SHELL_SCREEN,
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();
      expect(rawResumeSend).toHaveBeenCalledTimes(1);

      await engine.runSweep();
      expect(rawResumeSend).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1_000);
      await engine.runSweep();

      expect(rawResumeSend).toHaveBeenCalledTimes(2);
      expect(
        engine.getAgentState("cmuxlayerCodex-auto-revive-backoff"),
      ).toMatchObject({
        state: "error",
        revive_attempts: 2,
        revive_last_outcome: "failed",
        revive_last_attempt_at: "2026-08-13T07:00:01.000Z",
        revive_next_attempt_at: "2026-08-13T07:00:03.000Z",
      });
      vi.useRealTimers();
    });

    it("prefers settled done evidence over a shell-state screen", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-08-11T09:00:00.000Z");
      const stale = new Date(now.getTime() - 2_000);
      vi.setSystemTime(now);
      const transcriptPath = join(TEST_DIR, "completed-codex-session.jsonl");
      writeCodexDoneTranscript(transcriptPath);
      utimesSync(transcriptPath, stale, stale);
      stateMgr.writeState(
        makeRecord({
          agent_id: "completed-codex",
          state: "working",
          surface_id: "surface:completed-codex",
          cli_session_id: "019eab06-57d6-72b1-b3a8-6cf98a30a3f6",
          cli_session_path: transcriptPath,
        }),
      );
      liveSurfaces = [makeSurface("surface:completed-codex")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:completed-codex",
        text: "$ ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      await engine.runSweep();

      expect(engine.getAgentState("completed-codex")).toMatchObject({
        state: "done",
        error: null,
        task_done_detected_at: expect.any(String),
      });
      expect(
        stateMgr
          .getEventLog()
          .readEntries()
          .filter(
            (entry) =>
              "event_type" in entry &&
              entry.event_type === "agent_cli_exit",
          ),
      ).toEqual([]);
    });
  });

  describe("halt escalation", () => {
    it("persists prompt blockage even when escalation is opted out and clears it from healthy screen truth", async () => {
      const nowMs = Date.parse("2026-08-14T13:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          spawnPreflight: async () => {},
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 60_000,
        },
      );
      const child = makeRecord({
        agent_id: "prompt-opted-out",
        surface_id: "surface:prompt-opted-out",
        state: "working",
        halt_escalation: false,
      });
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(child.surface_id)];
      await engine.getRegistry().reconstitute();

      await (engine as any).maybeEscalateLiveHalt(
        child,
        "OpenAI Codex\nDo you want to allow this command?\n[y/n]",
      );

      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        blocked_on_prompt: true,
        blocked_on_prompt_since: new Date(nowMs).toISOString(),
      });
      expect(readInbox(child.agent_id, { baseDir: TEST_DIR })).toEqual([]);

      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        "OpenAI Codex\nProcessed item 2\nWorking (2s • esc to interrupt)",
      );

      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        blocked_on_prompt: false,
        blocked_on_prompt_since: null,
      });
    });

    it("routes a parentless prompt halt to a same-workspace top-level sink and records the hierarchy miss", async () => {
      const nowMs = Date.parse("2026-08-14T13:10:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          spawnPreflight: async () => {},
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 0,
        },
      );
      const fallback = makeRecord({
        agent_id: "fleet-top-level",
        surface_id: "surface:fleet-top-level",
        workspace_id: "workspace:prompt-probe",
        state: "working",
        role: "orchestrator",
        parent_agent_id: null,
        spawn_depth: 0,
      });
      const child = makeRecord({
        agent_id: "auto-codex-parentless",
        surface_id: "surface:auto-parentless",
        workspace_id: "workspace:prompt-probe",
        state: "working",
        role: "worker",
        parent_agent_id: null,
        spawn_depth: 0,
        halt_escalation: true,
      });
      stateMgr.writeState(fallback);
      stateMgr.writeState(child);
      liveSurfaces = [fallback, child].map((record) =>
        makeSurface(record.surface_id),
      );
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => ({
          surface,
          text:
            surface === fallback.surface_id
              ? "Claude Code\nWorking (2s • esc to interrupt)"
              : "OpenAI Codex\nDo you want to allow this command?\n[y/n]",
          lines: 80,
          scrollback_used: false,
        }),
      );
      await engine.getRegistry().reconstitute();

      const prompt = "OpenAI Codex\nDo you want to allow this command?\n[y/n]";
      await (engine as any).maybeEscalateLiveHalt(child, prompt);
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        prompt,
      );

      expect(readInbox(fallback.agent_id, { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          to: fallback.agent_id,
          tag: "agent_halt_awaiting_input",
          task: expect.stringContaining(child.agent_id),
        }),
      ]);
      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        blocked_on_prompt: true,
        halt_notification_sent_at: expect.any(String),
        halt_notified_ancestor_id: fallback.agent_id,
        halt_fallback_sink_id: fallback.agent_id,
        halt_missing_ancestor_count: 1,
      });
      expect(stateMgr.getEventLog().readEntries()).toContainEqual(
        expect.objectContaining({
          event_type: "agent_halt_escalation",
          agent_id: child.agent_id,
          outcome: "fallback_dispatched",
          sink_agent_id: fallback.agent_id,
        }),
      );
    });

    it("keeps fleet fallback inside the blocked agent workspace when another workspace has a healthy root", async () => {
      const nowMs = Date.parse("2026-08-14T13:15:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          spawnPreflight: async () => {},
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 0,
        },
      );
      const sameWorkspaceBlocked = makeRecord({
        agent_id: "same-workspace-blocked-root",
        surface_id: "surface:same-workspace-blocked-root",
        workspace_id: "workspace:scoped-fallback",
        state: "working",
        role: "orchestrator",
        parent_agent_id: null,
      });
      const otherWorkspaceHealthy = makeRecord({
        agent_id: "other-workspace-healthy-root",
        surface_id: "surface:other-workspace-healthy-root",
        workspace_id: "workspace:other",
        state: "working",
        role: "orchestrator",
        parent_agent_id: null,
      });
      const child = makeRecord({
        agent_id: "scoped-parentless-child",
        surface_id: "surface:scoped-parentless-child",
        workspace_id: sameWorkspaceBlocked.workspace_id,
        state: "working",
        parent_agent_id: null,
      });
      for (const record of [
        sameWorkspaceBlocked,
        otherWorkspaceHealthy,
        child,
      ]) {
        stateMgr.writeState(record);
      }
      liveSurfaces = [sameWorkspaceBlocked, otherWorkspaceHealthy, child].map(
        (record) => makeSurface(record.surface_id),
      );
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => ({
          surface,
          text:
            surface === otherWorkspaceHealthy.surface_id
              ? "Claude Code\nWorking (2s • esc to interrupt)"
              : "Claude Code\nDo you want to proceed?\n❯ 1. Yes\n2. No",
          lines: 80,
          scrollback_used: false,
        }),
      );
      await engine.getRegistry().reconstitute();
      const prompt = "OpenAI Codex\nDo you want to allow this command?\n[y/n]";

      await (engine as any).maybeEscalateLiveHalt(child, prompt);
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        prompt,
      );

      expect(
        readInbox(sameWorkspaceBlocked.agent_id, { baseDir: TEST_DIR }),
      ).toHaveLength(1);
      expect(
        readInbox(otherWorkspaceHealthy.agent_id, { baseDir: TEST_DIR }),
      ).toEqual([]);
      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        halt_fallback_sink_id: sameWorkspaceBlocked.agent_id,
      });
    });

    it("does not let a prompt-blocked parent silence its child when no higher ancestor exists", async () => {
      const nowMs = Date.parse("2026-08-14T13:20:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          spawnPreflight: async () => {},
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 0,
        },
      );
      const parent = makeRecord({
        agent_id: "prompt-blocked-parent",
        surface_id: "surface:prompt-blocked-parent",
        workspace_id: "workspace:blocked-chain",
        state: "working",
        role: "orchestrator",
        parent_agent_id: null,
        spawn_depth: 0,
      });
      const child = makeRecord({
        agent_id: "prompt-blocked-child",
        surface_id: "surface:prompt-blocked-child",
        workspace_id: "workspace:blocked-chain",
        state: "working",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [parent, child].map((record) =>
        makeSurface(record.surface_id),
      );
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nDo you want to proceed?\n❯ 1. Yes\n2. No",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      const prompt = "OpenAI Codex\nDo you want to allow this command?\n[y/n]";
      await (engine as any).maybeEscalateLiveHalt(child, prompt);
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        prompt,
      );

      expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          to: parent.agent_id,
          tag: "agent_halt_awaiting_input",
          task: expect.stringContaining(child.agent_id),
        }),
      ]);
      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        blocked_on_prompt: true,
        halt_notification_sent_at: expect.any(String),
        halt_notified_ancestor_id: parent.agent_id,
      });
    });

    it("records an undeliverable parentless halt and retries when a fallback sink later appears", async () => {
      const nowMs = Date.parse("2026-08-14T13:25:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          spawnPreflight: async () => {},
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 0,
        },
      );
      const child = makeRecord({
        agent_id: "parentless-retry-child",
        surface_id: "surface:parentless-retry-child",
        workspace_id: "workspace:retry",
        state: "working",
        parent_agent_id: null,
        halt_escalation: true,
      });
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(child.surface_id)];
      await engine.getRegistry().reconstitute();
      const prompt = "OpenAI Codex\nDo you want to allow this command?\n[y/n]";

      await (engine as any).maybeEscalateLiveHalt(child, prompt);
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        prompt,
      );

      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        blocked_on_prompt: true,
        halt_notification_sent_at: null,
        halt_missing_ancestor_count: 1,
        halt_last_delivery_error: "no halt escalation sink available",
      });
      expect(stateMgr.getEventLog().readEntries()).toContainEqual(
        expect.objectContaining({
          event_type: "agent_halt_escalation",
          agent_id: child.agent_id,
          outcome: "undeliverable",
          sink_agent_id: null,
        }),
      );

      const fallback = makeRecord({
        agent_id: "late-fleet-sink",
        surface_id: "surface:late-fleet-sink",
        workspace_id: child.workspace_id,
        state: "working",
        role: "orchestrator",
        parent_agent_id: null,
      });
      stateMgr.writeState(fallback);
      engine.getRegistry().set(fallback.agent_id, fallback);
      liveSurfaces.push(makeSurface(fallback.surface_id));
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: fallback.surface_id,
        text: "Claude Code\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });

      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        prompt,
      );

      expect(readInbox(fallback.agent_id, { baseDir: TEST_DIR })).toHaveLength(1);
      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        halt_notification_sent_at: expect.any(String),
        halt_notified_ancestor_id: fallback.agent_id,
        halt_missing_ancestor_count: 2,
      });
    });

    it("records dispatch failure without handling the episode and retries later", async () => {
      const nowMs = Date.parse("2026-08-14T13:27:00.000Z");
      const failedInboxBase = join(TEST_DIR, "inbox-base-is-a-file");
      writeFileSync(failedInboxBase, "not a directory", "utf8");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          spawnPreflight: async () => {},
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: failedInboxBase },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 0,
        },
      );
      const parent = makeRecord({
        agent_id: "dispatch-retry-parent",
        surface_id: "surface:dispatch-retry-parent",
        state: "working",
        role: "orchestrator",
      });
      const child = makeRecord({
        agent_id: "dispatch-retry-child",
        surface_id: "surface:dispatch-retry-child",
        state: "working",
        parent_agent_id: parent.agent_id,
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [parent, child].map((record) => makeSurface(record.surface_id));
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();
      const prompt = "OpenAI Codex\nDo you want to allow this command?\n[y/n]";

      await (engine as any).maybeEscalateLiveHalt(child, prompt);
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        prompt,
      );

      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        halt_notification_sent_at: null,
        halt_delivery_failure_count: 1,
        halt_last_delivery_error: expect.stringMatching(/not a directory|ENOTDIR/i),
      });
      expect(stateMgr.getEventLog().readEntries()).toContainEqual(
        expect.objectContaining({
          event_type: "agent_halt_escalation",
          agent_id: child.agent_id,
          outcome: "dispatch_failed",
          sink_agent_id: parent.agent_id,
        }),
      );

      rmSync(failedInboxBase, { force: true });
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        prompt,
      );

      expect(readInbox(parent.agent_id, { baseDir: failedInboxBase })).toHaveLength(1);
      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        halt_notification_sent_at: expect.any(String),
        halt_delivery_failure_count: 1,
        halt_last_delivery_error: null,
      });
    });

    it("dispatches one actionable awaiting-input episode after dwell", async () => {
      let nowMs = Date.parse("2026-08-13T08:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          spawnPreflight: async () => {},
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 1_000,
        },
      );
      const parent = makeRecord({
        agent_id: "cmuxlayerClaude-parent",
        surface_id: "surface:halt-parent",
        state: "working",
        role: "orchestrator",
        parent_agent_id: null,
        spawn_depth: 0,
      });
      const child = makeRecord({
        agent_id: "cmuxlayerCodex-awaiting",
        surface_id: "surface:halt-awaiting",
        // #408 regression: persisted done must not override a live blocked screen.
        state: "done",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        cli: "codex",
        cli_session_id: "019fad12-1111-7222-8333-444455556666",
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [
        makeSurface(parent.surface_id),
        makeSurface(child.surface_id),
      ];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => ({
          surface,
          text:
            surface === child.surface_id
              ? [
                  "TASK_DONE",
                  "─ Worked for 1m 26s ─",
                  "Select Model and Effort",
                  "Access legacy models by running codex -m <model_name> or in your config.toml",
                  "› 1. gpt-5.6-sol (current)",
                  "2. gpt-5.6-terra",
                  "4. gpt-5.5 Frontier model for complex coding, research, and real-world",
                  "work.",
                  "Press enter to confirm or esc to go back",
                ].join("\n")
              : "Claude Code\nWorking (2s • esc to interrupt)",
          lines: 80,
          scrollback_used: false,
        }),
      );
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toEqual([]);

      nowMs += 1_001;
      await engine.runSweep();
      await engine.runSweep();

      expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          from: "cmuxlayer:lifecycle",
          to: parent.agent_id,
          tag: "agent_halt_awaiting_input",
          task: expect.stringMatching(
            /cmuxlayerCodex-awaiting.*surface:halt-awaiting.*awaiting_input.*1s.*send_key\(surface: "surface:halt-awaiting", key: "return"\).*codex resume 019fad12-1111-7222-8333-444455556666/s,
          ),
        }),
      ]);
      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        halt_episode_type: "awaiting_input",
        halt_notification_sent_at: expect.any(String),
        halt_notified_ancestor_id: parent.agent_id,
      });

      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 1_000,
        },
      );
      await engine.getRegistry().reconstitute();
      await engine.runSweep();
      expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toHaveLength(1);
    });

    it("detects idle-without-done only after observed work and resets for a new episode", async () => {
      let nowMs = Date.parse("2026-08-13T09:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltIdleWithoutDoneDwellMs: 1_000,
        },
      );
      const parent = makeRecord({
        agent_id: "halt-idle-parent",
        surface_id: "surface:halt-idle-parent",
        state: "working",
        role: "orchestrator",
      });
      const child = makeRecord({
        agent_id: "halt-idle-child",
        surface_id: "surface:halt-idle-child",
        state: "working",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(parent.surface_id), makeSurface(child.surface_id)];
      let childScreen = "OpenAI Codex\nModel: gpt-5.6\nWorking (2s • esc to interrupt)";
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => ({
          surface,
          text:
            surface === child.surface_id
              ? childScreen
              : "Claude Code\nWorking (2s • esc to interrupt)",
          lines: 80,
          scrollback_used: false,
        }),
      );
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      childScreen = "OpenAI Codex\nModel: gpt-5.6\n›";
      await engine.runSweep();
      expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toEqual([]);

      nowMs += 1_001;
      await engine.runSweep();
      expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({
          tag: "agent_halt_idle_without_done",
          task: expect.stringContaining(
            'interact(agent: "halt-idle-child", action: "send", text: "Continue and report status.")',
          ),
        }),
      ]);

      childScreen =
        "OpenAI Codex\nStarted the next task\nWorking (4s • esc to interrupt)";
      await engine.runSweep();
      childScreen = "OpenAI Codex\nModel: gpt-5.6\n›";
      await engine.runSweep();
      nowMs += 1_001;
      await engine.runSweep();

      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter(
          (message) => message.tag === "agent_halt_idle_without_done",
        ),
      ).toHaveLength(2);
    });

    it("treats PROBE C's ambient background-terminal footer as healthy idle", async () => {
      let nowMs = Date.parse("2026-08-13T13:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltWedgedDwellMs: 0,
          haltWedgedSweeps: 1,
        },
      );
      const parent = makeRecord({
        agent_id: "probe-c-parent",
        surface_id: "surface:probe-c-parent",
        state: "working",
        role: "orchestrator",
      });
      const child = makeRecord({
        agent_id: "probe-c-child",
        surface_id: "surface:probe-c-child",
        state: "done",
        cli: "codex",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        halt_last_active_at: new Date(nowMs - 60_000).toISOString(),
        halt_last_progress_at_ms: nowMs - 60_000,
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(parent.surface_id), makeSurface(child.surface_id)];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nProcessed child report\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      const ambientFooterScreen = [
        "• Waited for background terminal · tail -n0 -F /Users/example/.cmux/agents/probe-c-child/inbox.jsonl",
        "• OK",
        "─ Worked for 3m 44s ─",
        "1 background terminal running · /ps to view · /stop to close",
        "› Find and fix a bug in @filename",
        "gpt-5.6-sol high · ~/Gits/cmuxlayer",
      ].join("\n");
      await (engine as any).maybeEscalateLiveHalt(child, ambientFooterScreen);
      nowMs += 1;
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id) as AgentRecord,
        ambientFooterScreen,
      );

      expect(engine.getAgentState(child.agent_id)?.halt_episode_type).toBe(
        "idle_without_done",
      );
      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter((message) =>
          message.tag.startsWith("agent_halt_"),
        ),
      ).toEqual([]);
    });

    it("does not re-report idle when durable DONE evidence has scrolled off screen", async () => {
      const nowMs = Date.parse("2026-08-13T14:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltIdleWithoutDoneDwellMs: 0,
        },
      );
      const child = makeRecord({
        agent_id: "probe-f-recorded-done",
        surface_id: "surface:probe-f-recorded-done",
        state: "done",
        task_done_detected_at: new Date(nowMs - 600_000).toISOString(),
        halt_last_active_at: new Date(nowMs - 600_000).toISOString(),
      });
      stateMgr.writeState(child);
      await engine.getRegistry().reconstitute();

      const idleScreen = "OpenAI Codex\n› Find and fix a bug in @filename\ngpt-5.6-sol high";
      await (engine as any).maybeEscalateLiveHalt(child, idleScreen);

      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        halt_episode_type: null,
        halt_last_active_at: null,
      });
    });

    it("does not let a prior task's recorded DONE suppress a newer approval halt", async () => {
      let nowMs = Date.parse("2026-08-13T14:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 0,
        },
      );
      const parent = makeRecord({
        agent_id: "stale-done-parent",
        surface_id: "surface:stale-done-parent",
        state: "working",
        role: "orchestrator",
      });
      const child = makeRecord({
        agent_id: "stale-done-child",
        surface_id: "surface:stale-done-child",
        state: "working",
        cli: "codex",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        task_done_detected_at: new Date(nowMs - 7_200_000).toISOString(),
        halt_last_active_at: new Date(nowMs - 600_000).toISOString(),
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(parent.surface_id), makeSurface(child.surface_id)];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nProcessed child report\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      const approvalScreen =
        "OpenAI Codex\nDo you want to allow this command?\n[y/n]";
      await (engine as any).maybeEscalateLiveHalt(child, approvalScreen);
      nowMs += 1;
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id) as AgentRecord,
        approvalScreen,
      );

      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter(
          (message) => message.tag === "agent_halt_awaiting_input",
        ),
      ).toHaveLength(1);
    });

    it("does not re-report idle when the settled transcript records DONE", async () => {
      const nowMs = Date.now();
      const transcriptPath = join(TEST_DIR, "probe-f-transcript-done.jsonl");
      writeCodexDoneTranscript(transcriptPath);
      const stale = new Date(nowMs - 10_000);
      utimesSync(transcriptPath, stale, stale);
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltIdleWithoutDoneDwellMs: 0,
        },
      );
      const child = makeRecord({
        agent_id: "probe-f-transcript-done",
        surface_id: "surface:probe-f-transcript-done",
        state: "done",
        cli: "codex",
        cli_session_id: "019eab06-57d6-72b1-b3a8-6cf98a30a3f6",
        cli_session_path: transcriptPath,
        halt_last_active_at: new Date(nowMs - 600_000).toISOString(),
      });
      stateMgr.writeState(child);
      await engine.getRegistry().reconstitute();

      const idleScreen = "OpenAI Codex\n› Find and fix a bug in @filename\ngpt-5.6-sol high";
      await (engine as any).maybeEscalateLiveHalt(child, idleScreen);

      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        halt_episode_type: null,
        halt_last_active_at: null,
      });
    });

    it("does not treat a settled Claude end_turn transcript as task DONE", async () => {
      let nowMs = Date.now();
      const transcriptPath = join(TEST_DIR, "probe-j-claude-end-turn.jsonl");
      writeFileSync(
        transcriptPath,
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-5",
            stop_reason: "end_turn",
            content: [
              { type: "text", text: "Looking into the failing spec." },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
      );
      const stale = new Date(nowMs - 10_000);
      utimesSync(transcriptPath, stale, stale);
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltIdleWithoutDoneDwellMs: 0,
        },
      );
      const parent = makeRecord({
        agent_id: "probe-j-parent",
        surface_id: "surface:probe-j-parent",
        state: "working",
        role: "orchestrator",
      });
      const child = makeRecord({
        agent_id: "probe-j-child",
        surface_id: "surface:probe-j-child",
        state: "working",
        cli: "claude",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        cli_session_path: transcriptPath,
        halt_last_active_at: new Date(nowMs - 600_000).toISOString(),
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(parent.surface_id), makeSurface(child.surface_id)];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nProcessed child report\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      const idleScreen =
        "Claude Code\n\n  Looking into the failing spec.\n\n❯ \n  ⏵⏵ bypass permissions on";
      await (engine as any).maybeEscalateLiveHalt(child, idleScreen);
      nowMs += 1;
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id) as AgentRecord,
        idleScreen,
      );

      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter(
          (message) => message.tag === "agent_halt_idle_without_done",
        ),
      ).toHaveLength(1);
    });

    it.each([
      {
        label: "an orchestrator",
        role: "orchestrator" as const,
        footer: "⏵⏵ bypass permissions on",
        expectedType: null,
      },
      {
        label: "a worker with Claude's agent status marker",
        role: "worker" as const,
        footer: "⏵⏵ bypass permissions on · ← 1 agent",
        expectedType: "idle_without_done" as const,
      },
    ])("classifies $label by its durable role", async ({ role, footer, expectedType }) => {
      let nowMs = Date.parse("2026-08-13T14:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltIdleWithoutDoneDwellMs: 0,
        },
      );
      const parent = makeRecord({
        agent_id: `idle-lead-parent-${role}`,
        surface_id: `surface:idle-lead-parent-${role}`,
        state: "working",
        role: "orchestrator",
      });
      const child = makeRecord({
        agent_id: `idle-lead-${role}`,
        surface_id: `surface:idle-lead-${role}`,
        state: "working",
        cli: "claude",
        role,
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        halt_last_active_at: new Date(nowMs - 1_800_000).toISOString(),
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(parent.surface_id), makeSurface(child.surface_id)];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nProcessed child report\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      const idleScreen = `Claude Code\nCompleted the previous turn.\n❯\n${footer}`;
      await (engine as any).maybeEscalateLiveHalt(child, idleScreen);
      nowMs += 1;
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id) as AgentRecord,
        idleScreen,
      );

      expect(
        engine.getAgentState(child.agent_id)?.halt_episode_type ?? null,
      ).toBe(expectedType);
      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter((message) =>
          message.tag.startsWith("agent_halt_"),
        ),
      ).toEqual(
        expectedType === null
          ? []
          : [expect.objectContaining({ tag: `agent_halt_${expectedType}` })],
      );
    });

    it("suppresses idle escalation after the child reports to its parent", async () => {
      let nowMs = Date.parse("2026-08-13T15:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltIdleWithoutDoneDwellMs: 0,
        },
      );
      const parent = makeRecord({
        agent_id: "reported-parent",
        surface_id: "surface:reported-parent",
        state: "working",
      });
      const child = makeRecord({
        agent_id: "reported-child",
        surface_id: "surface:reported-child",
        state: "done",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        halt_last_active_at: new Date(nowMs - 60_000).toISOString(),
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(parent.surface_id), makeSurface(child.surface_id)];
      dispatch(
        parent.agent_id,
        {
          id: "child-finished-report",
          from: child.agent_id,
          reply_to: child.agent_id,
          to: parent.agent_id,
          task: "Finished the assigned lane and posted the PR.",
          ts_ms: nowMs - 30_000,
        },
        { baseDir: TEST_DIR },
      );
      await engine.getRegistry().reconstitute();

      const idleScreen = "OpenAI Codex\n› Find and fix a bug in @filename\ngpt-5.6-sol high";
      await (engine as any).maybeEscalateLiveHalt(child, idleScreen);
      nowMs += 1;
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id) as AgentRecord,
        idleScreen,
      );

      expect(engine.getAgentState(child.agent_id)?.halt_episode_type).toBeNull();
      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter((message) =>
          message.tag.startsWith("agent_halt_"),
        ),
      ).toEqual([]);
    });

    it("uses a 15-minute production dwell for idle-without-done", async () => {
      let nowMs = Date.parse("2026-08-13T16:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
        },
      );
      const parent = makeRecord({
        agent_id: "idle-dwell-parent",
        surface_id: "surface:idle-dwell-parent",
        state: "working",
      });
      const child = makeRecord({
        agent_id: "idle-dwell-child",
        surface_id: "surface:idle-dwell-child",
        state: "done",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        halt_last_active_at: new Date(nowMs - 60_000).toISOString(),
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(parent.surface_id), makeSurface(child.surface_id)];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nProcessed child report\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      const idleScreen = "OpenAI Codex\n› Find and fix a bug in @filename\ngpt-5.6-sol high";
      await (engine as any).maybeEscalateLiveHalt(child, idleScreen);
      nowMs += 899_999;
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id) as AgentRecord,
        idleScreen,
      );
      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter((message) =>
          message.tag === "agent_halt_idle_without_done",
        ),
      ).toEqual([]);

      nowMs += 1;
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id) as AgentRecord,
        idleScreen,
      );
      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter((message) =>
          message.tag === "agent_halt_idle_without_done",
        ),
      ).toHaveLength(1);
    });

    it("detects a wedged active turn after unchanged dwell sweeps but ignores progressing work", async () => {
      let nowMs = Date.parse("2026-08-13T10:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltWedgedDwellMs: 1_000,
          haltWedgedSweeps: 3,
        },
      );
      const parent = makeRecord({
        agent_id: "halt-wedge-parent",
        surface_id: "surface:halt-wedge-parent",
        state: "working",
        role: "orchestrator",
      });
      const wedged = makeRecord({
        agent_id: "halt-wedged-child",
        surface_id: "surface:halt-wedged-child",
        state: "working",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
      });
      const healthy = makeRecord({
        agent_id: "halt-healthy-child",
        surface_id: "surface:halt-healthy-child",
        state: "working",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
      });
      for (const record of [parent, wedged, healthy]) stateMgr.writeState(record);
      liveSurfaces = [parent, wedged, healthy].map((record) =>
        makeSurface(record.surface_id),
      );
      let healthyStep = 0;
      let parentStep = 0;
      let wedgedScreen =
        "OpenAI Codex\nModel: gpt-5.6\nWorking (2s • esc to interrupt)";
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => ({
          surface,
          text:
            surface === wedged.surface_id
              ? wedgedScreen
              : surface === healthy.surface_id
                ? `OpenAI Codex\nProcessed item ${healthyStep++}\nWorking (2s • esc to interrupt)`
                : `Claude Code\nProcessed child report ${parentStep++}\nWorking (2s • esc to interrupt)`,
          lines: 80,
          scrollback_used: false,
        }),
      );
      await engine.getRegistry().reconstitute();

      await engine.runSweep();
      wedgedScreen = [
        "OpenAI Codex",
        "Model: gpt-5.6",
        "Waiting for background terminal (5s • esc to interrupt) · 1 background terminal running",
        "└ tail -n0 -F /tmp/probe.log",
      ].join("\n");
      nowMs += 500;
      await engine.runSweep();
      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter(
          (message) => message.tag === "agent_halt_wedged",
        ),
      ).toEqual([]);
      nowMs += 501;
      await engine.runSweep();
      nowMs += 500;
      await engine.runSweep();
      await engine.runSweep();

      const messages = readInbox(parent.agent_id, { baseDir: TEST_DIR });
      expect(
        messages.filter((message) => message.tag === "agent_halt_wedged"),
      ).toEqual([
        expect.objectContaining({
          task: expect.stringMatching(
            /halt-wedged-child.*surface:halt-wedged-child.*interact\(agent: "halt-wedged-child", action: "interrupt"\)/s,
          ),
        }),
      ]);
      expect(messages.some((message) => message.task.includes(healthy.agent_id))).toBe(false);
    });

    it("routes past a halted parent to the nearest live ancestor and honors opt-out", async () => {
      let nowMs = Date.parse("2026-08-13T11:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltAwaitingInputDwellMs: 0,
          haltIdleWithoutDoneDwellMs: 0,
        },
      );
      const root = makeRecord({
        agent_id: "halt-root",
        surface_id: "surface:halt-root",
        state: "working",
        role: "orchestrator",
      });
      const parent = makeRecord({
        agent_id: "halt-parent",
        surface_id: "surface:halt-parent",
        state: "working",
        parent_agent_id: root.agent_id,
        spawn_depth: 1,
        halt_episode_type: "idle_without_done",
        halt_episode_started_at: new Date(nowMs - 1_000).toISOString(),
        halt_episode_observations: 1,
        halt_last_active_at: new Date(nowMs - 2_000).toISOString(),
      });
      const child = makeRecord({
        agent_id: "halt-child",
        surface_id: "surface:halt-child",
        state: "working",
        parent_agent_id: parent.agent_id,
        spawn_depth: 2,
        halt_episode_type: "awaiting_input",
        halt_episode_started_at: new Date(nowMs - 1_000).toISOString(),
        halt_episode_observations: 1,
      });
      const optedOut = makeRecord({
        agent_id: "halt-opted-out",
        surface_id: "surface:halt-opted-out",
        state: "working",
        parent_agent_id: root.agent_id,
        spawn_depth: 1,
        halt_escalation: false,
      });
      // Persist the child first so ancestor routing cannot depend on the parent
      // having already been processed during this sweep.
      for (const record of [child, optedOut, parent, root]) stateMgr.writeState(record);
      liveSurfaces = [root, parent, child, optedOut].map((record) =>
        makeSurface(record.surface_id),
      );
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => ({
          surface,
          text:
            surface === root.surface_id
              ? "Claude Code\nWorking (2s • esc to interrupt)"
              : surface === parent.surface_id
                ? "OpenAI Codex\nModel: gpt-5.6\n›"
                : "OpenAI Codex\nDo you want to allow this command?\n[y/n]",
          lines: 80,
          scrollback_used: false,
        }),
      );
      await engine.getRegistry().reconstitute();

      const awaitingScreen =
        "OpenAI Codex\nDo you want to allow this command?\n[y/n]";
      await (engine as any).maybeEscalateLiveHalt(child, awaitingScreen);
      await (engine as any).maybeEscalateLiveHalt(
        optedOut,
        awaitingScreen,
      );

      const rootMessages = readInbox(root.agent_id, { baseDir: TEST_DIR });
      expect(rootMessages.some((message) => message.task.includes(child.agent_id))).toBe(true);
      expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toEqual([]);
      expect(rootMessages.some((message) => message.task.includes(optedOut.agent_id))).toBe(false);
    });

    it("starts a fresh durable episode when the halt class changes", async () => {
      let nowMs = Date.parse("2026-08-13T12:00:00.000Z");
      engine.dispose();
      engine = new AgentEngine(
        stateMgr,
        new AgentRegistry(stateMgr, async () => liveSurfaces),
        mockClient,
        {
          sessionIdentityResolver: () => null,
          inboxOpts: { baseDir: TEST_DIR },
          haltNow: () => nowMs,
          haltIdleWithoutDoneDwellMs: 0,
        },
      );
      const parent = makeRecord({
        agent_id: "halt-transition-parent",
        surface_id: "surface:halt-transition-parent",
        state: "working",
      });
      const child = makeRecord({
        agent_id: "halt-transition-child",
        surface_id: "surface:halt-transition-child",
        state: "working",
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        halt_episode_type: "awaiting_input",
        halt_episode_started_at: new Date(nowMs - 10_000).toISOString(),
        halt_episode_observations: 4,
        halt_notification_sent_at: new Date(nowMs - 5_000).toISOString(),
        halt_notified_ancestor_id: parent.agent_id,
        halt_last_active_at: new Date(nowMs - 20_000).toISOString(),
      });
      stateMgr.writeState(parent);
      stateMgr.writeState(child);
      liveSurfaces = [makeSurface(parent.surface_id), makeSurface(child.surface_id)];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nProcessed child status\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      const idleScreen = "OpenAI Codex\nModel: gpt-5.6\n›";
      await (engine as any).maybeEscalateLiveHalt(child, idleScreen);
      expect(engine.getAgentState(child.agent_id)).toMatchObject({
        halt_episode_type: "idle_without_done",
        halt_episode_started_at: new Date(nowMs).toISOString(),
        halt_episode_observations: 1,
        halt_notification_sent_at: null,
        halt_notified_ancestor_id: null,
      });

      nowMs += 1;
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(child.agent_id),
        idleScreen,
      );
      expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toEqual([
        expect.objectContaining({ tag: "agent_halt_idle_without_done" }),
      ]);
    });
  });

  describe("startSweep", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("RC1: stamps updated_at when a live idle agent is observed by a sweep", async () => {
      const sweepAt = new Date("2026-07-12T09:30:00.000Z");
      vi.setSystemTime(sweepAt);
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-idle-heartbeat",
          state: "idle",
          surface_id: "surface:idle-heartbeat",
          updated_at: "2026-07-12T09:00:00.000Z",
        }),
      );
      liveSurfaces = [makeSurface("surface:idle-heartbeat")];
      await engine.getRegistry().reconstitute();

      await engine.runSweep();

      expect(engine.getAgentState("agent-idle-heartbeat")?.updated_at).toBe(
        sweepAt.toISOString(),
      );
    });

    it("§c: evicts an agentless booting ghost after the timeout despite intervening sweeps", async () => {
      const startedAt = new Date("2026-07-12T09:30:00.000Z");
      vi.setSystemTime(startedAt);
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-booting-ghost",
          state: "booting",
          surface_id: "surface:booting-ghost",
          boot_prompt_pending: false,
          created_at: startedAt.toISOString(),
          updated_at: startedAt.toISOString(),
        }),
      );
      liveSurfaces = [makeSurface("surface:booting-ghost")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:booting-ghost",
        text: "$ ",
        lines: 20,
        scrollback_used: false,
      });
      await engine.getRegistry().reconstitute();

      vi.setSystemTime(new Date(startedAt.getTime() + 5_000));
      await engine.runSweep();
      vi.setSystemTime(new Date(startedAt.getTime() + 31_000));
      await engine.getRegistry().listMerged(
        {
          scan: vi.fn().mockResolvedValue([
            {
              surface_id: "surface:booting-ghost",
              surface_title: "shell",
              workspace_id: "workspace:1",
              cli: "unknown",
              parsed_status: "unknown",
              model: null,
              token_count: null,
              context_pct: null,
              has_agent: false,
              read_error: false,
            },
          ]),
        } as any,
        { force: true },
      );

      expect(engine.getAgentState("agent-booting-ghost")).toBeNull();
      expect(stateMgr.readState("agent-booting-ghost")).toBeNull();
    });

    it("backs off to the idle interval after unchanged sweeps", async () => {
      const sweep = vi.spyOn(engine, "runSweep").mockResolvedValue(undefined);

      engine.startSweep({
        activeIntervalMs: 50,
        idleIntervalMs: 150,
        idleAfterSweeps: 1,
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(sweep).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(sweep).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(100);
      expect(sweep).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(50);
      expect(sweep).toHaveBeenCalledTimes(3);
    });

    it("keeps the active cadence while screen output changes", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-active-output",
          state: "ready",
          surface_id: "surface:active-output",
          cli: "codex",
        }),
      );
      liveSurfaces = [makeSurface("surface:active-output")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          surface: "surface:active-output",
          text: "Working 1",
          lines: 80,
          scrollback_used: false,
        })
        .mockResolvedValueOnce({
          surface: "surface:active-output",
          text: "Working 2",
          lines: 80,
          scrollback_used: false,
        })
        .mockResolvedValue({
          surface: "surface:active-output",
          text: "Working 3",
          lines: 80,
          scrollback_used: false,
        });
      await engine.getRegistry().reconstitute();

      engine.startSweep({
        activeIntervalMs: 50,
        idleIntervalMs: 150,
        idleAfterSweeps: 1,
      });

      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(50);

      expect(mockClient.readScreen).toHaveBeenCalledTimes(3);
    });

    it("does not start a second loop while a sweep is running", async () => {
      let finishSweep: (() => void) | null = null;
      const sweep = vi.spyOn(engine, "runSweep").mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSweep = resolve;
          }),
      );

      engine.startSweep({ activeIntervalMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      expect(sweep).toHaveBeenCalledTimes(1);

      engine.startSweep({ activeIntervalMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      expect(sweep).toHaveBeenCalledTimes(1);

      finishSweep?.();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(sweep).toHaveBeenCalledTimes(2);
    });

    it("resolves sweep timing from environment with idle defaults", () => {
      expect(
        resolveSweepTiming({
          CMUXLAYER_SWEEP_INTERVAL_MS: "7000",
          CMUXLAYER_SWEEP_IDLE_INTERVAL_MS: "25000",
          CMUXLAYER_SWEEP_IDLE_AFTER_SWEEPS: "4",
        }),
      ).toEqual({
        activeIntervalMs: 7000,
        idleIntervalMs: 25000,
        idleAfterSweeps: 4,
      });

      expect(resolveSweepTiming({})).toEqual({
        activeIntervalMs: 5000,
        idleIntervalMs: 15000,
        idleAfterSweeps: 3,
      });

      expect(resolveSweepTiming({}, 2500)).toEqual({
        activeIntervalMs: 2500,
        idleIntervalMs: 15000,
        idleAfterSweeps: 3,
      });
    });
  });

  describe("default preflight", () => {
    it.each([
      ["codex", "Codex"],
      ["cursor", "Cursor"],
    ] as const)(
      "rejects missing %s repoGolem launchers before creating a surface",
      async (cli, suffix) => {
        const registryPath = join(TEST_DIR, `missing-${cli}-launchers.zsh`);
        writeFileSync(
          registryPath,
          'repoGolem mm "/Users/etanheyman/Gits/matchmat"\n',
        );
        vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);

        const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
        const defaultEngine = new AgentEngine(stateMgr, registry, mockClient);
        try {
          await expect(
            defaultEngine.spawnAgent({
              repo: `missinglauncher${suffix}`,
              cli,
              prompt: "",
            }),
          ).rejects.toThrow(`missinglauncher${suffix}${suffix}`);
          expect(mockClient.newSplit).not.toHaveBeenCalled();
        } finally {
          defaultEngine.dispose();
          vi.unstubAllEnvs();
        }
      },
    );

    it("uses the launcher registry and fails loudly before any bare split fallback", async () => {
      const registryPath = join(TEST_DIR, "launchers.zsh");
      writeFileSync(
        registryPath,
        'repoGolem mm "/Users/etanheyman/Gits/matchmat"\n',
      );
      vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);

      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      const defaultEngine = new AgentEngine(stateMgr, registry, mockClient);
      try {
        await expect(
          defaultEngine.spawnAgent({
            repo: "missinglauncher",
            cli: "claude",
            prompt: "",
            cwd: "/tmp/cmux-worktree",
          }),
        ).rejects.toThrow(
          /Launcher registry miss.*missinglauncherClaude.*launchers\.zsh.*\/Users\/etanheyman\/Gits\/matchmat.*mmClaude/s,
        );
        expect(mockClient.newSplit).not.toHaveBeenCalled();
        expect(mockClient.send).not.toHaveBeenCalled();
        expect(stateMgr.listStates()).toHaveLength(0);
      } finally {
        defaultEngine.dispose();
        vi.unstubAllEnvs();
      }
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

  describe("resolveAgentIoRoute legacy bindings", () => {
    const observerId = "cmux:/tmp/prod.sock";

    function installLegacyAgent(
      overrides: Partial<AgentRecord>,
      surfaces: CmuxSurface[],
    ): AgentRecord {
      engine.dispose();
      liveSurfaces = surfaces;
      const registry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerId },
      );
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      const record = makeRecord({
        agent_id: "legacy-route-agent",
        surface_id: "surface:legacy",
        surface_uuid: null,
        surface_observer_id: observerId,
        workspace_id: "workspace:legacy",
        state: "working",
        ...overrides,
      });
      stateMgr.writeState(record);
      registry.set(record.agent_id, record);
      return record;
    }

    it("refuses an owned UUID-less route when fresh all-ref topology lacks its ref", async () => {
      const record = installLegacyAgent({}, [makeSurface("surface:witness")]);

      await expect(engine.resolveAgentIoRoute(record.agent_id)).rejects.toThrow(
        /fresh.*ref-only topology|not live.*mutable ref/i,
      );
      expect(mockClient.listWorkspaces).toHaveBeenCalled();
    });

    it("refuses an owned UUID-less route when fresh topology identifies the ref by UUID", async () => {
      const record = installLegacyAgent({}, [
        {
          ...makeSurface("surface:legacy"),
          id: "11111111-2222-4333-8444-555555555555",
        },
      ]);

      await expect(engine.resolveAgentIoRoute(record.agent_id)).rejects.toThrow(
        /fresh.*ref-only topology|UUID-capable.*mutable ref/i,
      );
      expect(mockClient.listWorkspaces).toHaveBeenCalled();
    });

    it("keeps owned UUID-less compatibility when fresh topology is entirely ref-only", async () => {
      const record = installLegacyAgent(
        { workspace_id: "workspace:stale" },
        [
          {
            ...makeSurface("surface:legacy"),
            workspace_ref: "workspace:fresh",
          },
        ],
      );

      await expect(engine.resolveAgentIoRoute(record.agent_id)).resolves.toMatchObject({
        agent_id: record.agent_id,
        surface_id: "surface:legacy",
        surface_uuid: null,
        workspace_id: "workspace:fresh",
      });
      expect(stateMgr.readState(record.agent_id)?.workspace_id).toBe(
        "workspace:fresh",
      );
      expect(mockClient.listWorkspaces).toHaveBeenCalled();
    });

    it("refuses UUID-less I/O when observer enforcement has no current observer", async () => {
      engine.dispose();
      liveSurfaces = [makeSurface("surface:legacy")];
      const registry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerId: null },
      );
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      const record = makeRecord({
        agent_id: "legacy-null-observer",
        surface_id: "surface:legacy",
        surface_uuid: null,
        surface_observer_id: observerId,
        state: "working",
      });
      stateMgr.writeState(record);
      registry.set(record.agent_id, record);

      await expect(engine.resolveAgentIoRoute(record.agent_id)).rejects.toThrow(
        /not owned by the current cmux observer|current cmux observer.*refusing/i,
      );
      expect(mockClient.listWorkspaces).not.toHaveBeenCalled();
    });

    it("refuses UUID I/O when the surface observer changes during fresh topology enumeration", async () => {
      engine.dispose();
      let currentObserverId = "cmux:/tmp/cmux-primary.sock";
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      liveSurfaces = [
        {
          ...makeSurface("surface:fresh"),
          id: stableUuid,
          workspace_ref: "workspace:fresh",
        },
      ];
      const registry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerIdProvider: () => currentObserverId },
      );
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      const record = makeRecord({
        agent_id: "uuid-observer-switch-route",
        surface_id: "surface:stale",
        surface_uuid: stableUuid,
        surface_observer_id: currentObserverId,
        workspace_id: "workspace:stale",
        state: "working",
      });
      stateMgr.writeState(record);
      registry.set(record.agent_id, record);
      const listPaneSurfaces = (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).getMockImplementation()!;
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async (opts) => {
        const result = await listPaneSurfaces(opts);
        currentObserverId = "cmux:/tmp/cmux-secondary.sock";
        return result;
      });

      await expect(engine.resolveAgentIoRoute(record.agent_id)).rejects.toThrow(
        /not live or uniquely resolvable|complete fresh topology/i,
      );

      expect(currentObserverId).toBe("cmux:/tmp/cmux-secondary.sock");
      expect(stateMgr.readState(record.agent_id)).toMatchObject({
        surface_id: "surface:stale",
        surface_uuid: stableUuid,
        surface_observer_id: "cmux:/tmp/cmux-primary.sock",
        workspace_id: "workspace:stale",
      });
    });
  });

  describe("evictDeadProcessAgents", () => {
    it("keeps active agents registered when passive liveness is unknown", async () => {
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
          if (signal === 0) {
            throw Object.assign(new Error("operation not permitted"), {
              code: "EPERM",
            });
          }
          return true;
        }) as typeof process.kill);

      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "agent-passive-unknown",
            state: "working",
            surface_id: "surface:passive-unknown",
            pid: 34567,
          }),
        );
        await engine.getRegistry().reconstitute();

        expect(engine.evictDeadProcessAgents()).toEqual([]);
        expect(killSpy).toHaveBeenCalledWith(34567, 0);
        expect(stateMgr.readState("agent-passive-unknown")).toMatchObject({
          state: "working",
          pid: 34567,
        });
        expect(engine.getAgentState("agent-passive-unknown")).toMatchObject({
          state: "working",
          pid: 34567,
        });
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  describe("stopAgent", () => {
    beforeEach(() => {
      (mockClient.closeSurface as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => {
          liveSurfaces = liveSurfaces.filter((item) => item.ref !== surface);
          if (liveSurfaces.length === 0) {
            liveSurfaces = [
              {
                ...makeSurface("surface:post-close-witness"),
                workspace_ref: "workspace:post-close-witness",
              },
            ];
          }
        },
      );
    });

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

    it("guards a freshly re-resolved moved UUID immediately before stop I/O", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stop-moved",
          state: "working",
          surface_id: "surface:old",
          surface_uuid: stableUuid,
        }),
      );
      liveSurfaces = [
        {
          ...makeSurface("surface:old"),
          id: stableUuid,
          workspace_ref: "ws:1",
        },
      ];
      await engine.getRegistry().reconstitute();
      liveSurfaces = [
        {
          ...makeSurface("surface:old"),
          id: "uuid-foreign",
          workspace_ref: "ws:1",
        },
        {
          ...makeSurface("surface:new-route"),
          id: stableUuid,
          workspace_ref: "ws:1",
        },
      ];
      const beforeSurfaceMutation = vi.fn(async (route: AgentRoute) => {
        expect(route).toMatchObject({
          surface_id: "surface:new-route",
          surface_uuid: stableUuid,
        });
        expect(mockClient.sendKey).not.toHaveBeenCalled();
        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      });

      await engine.stopAgent("agent-stop-moved", false, {
        beforeSurfaceMutation,
      });

      expect(beforeSurfaceMutation).toHaveBeenCalledTimes(1);
      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:new-route",
        "c-c",
        expect.anything(),
      );
      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:new-route",
        expect.anything(),
      );
      expect(mockClient.sendKey).not.toHaveBeenCalledWith(
        "surface:old",
        "c-c",
        expect.anything(),
      );
    });

    it("re-resolves a moved UUID after the awaited close-policy scan", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const recycledUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const record = makeRecord({
        agent_id: "agent-stop-policy-race",
        state: "working",
        surface_id: "surface:old-route",
        surface_uuid: stableUuid,
        workspace_id: "workspace:old",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface("surface:old-route"),
          id: stableUuid,
          workspace_ref: "workspace:old",
        },
      ];
      await engine.getRegistry().reconstitute();

      const listPaneSurfaces = (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).getMockImplementation()!;
      let paneDetailCalls = 0;
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async (opts) => {
        const result = await listPaneSurfaces(opts);
        paneDetailCalls += 1;
        if (paneDetailCalls === 2) {
          // The policy was calculated for the old route, but that mutable ref is
          // recycled before stop reaches its manual gate or terminal writes.
          liveSurfaces = [
            {
              ...makeSurface("surface:old-route"),
              id: recycledUuid,
              workspace_ref: "workspace:old",
            },
            {
              ...makeSurface("surface:final-route"),
              id: stableUuid,
              workspace_ref: "workspace:final",
            },
          ];
        }
        return result;
      });
      const beforeSurfaceMutation = vi.fn(async (route: AgentRoute) => {
        expect(route).toMatchObject({
          surface_id: "surface:final-route",
          surface_uuid: stableUuid,
          workspace_id: "workspace:final",
        });
        expect(mockClient.sendKey).not.toHaveBeenCalled();
        expect(mockClient.closeSurface).not.toHaveBeenCalled();
      });

      await engine.stopAgent(record.agent_id, false, {
        beforeSurfaceMutation,
      });

      expect(beforeSurfaceMutation).toHaveBeenCalledTimes(1);
      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:final-route",
        "c-c",
        expect.objectContaining({ workspace: "workspace:final" }),
      );
      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:final-route",
        expect.objectContaining({ workspace: "workspace:final" }),
      );
      expect(mockClient.sendKey).not.toHaveBeenCalledWith(
        "surface:old-route",
        expect.anything(),
        expect.anything(),
      );
      expect(mockClient.closeSurface).not.toHaveBeenCalledWith(
        "surface:old-route",
        expect.anything(),
      );
    });

    it("refuses stop when the UUID route moves during the manual mutation gate", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const record = makeRecord({
        agent_id: "agent-stop-manual-gate-race",
        state: "working",
        surface_id: "surface:gate-old",
        surface_uuid: stableUuid,
        workspace_id: "workspace:gate-old",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface("surface:gate-old"),
          id: stableUuid,
          workspace_ref: "workspace:gate-old",
        },
      ];
      await engine.getRegistry().reconstitute();
      const beforeSurfaceMutation = vi.fn(async (route: AgentRoute) => {
        expect(route).toMatchObject({
          surface_id: "surface:gate-old",
          workspace_id: "workspace:gate-old",
        });
        liveSurfaces = [
          {
            ...makeSurface("surface:gate-old"),
            id: "uuid-recycled-during-gate",
            workspace_ref: "workspace:gate-old",
          },
          {
            ...makeSurface("surface:gate-final"),
            id: stableUuid,
            workspace_ref: "workspace:gate-final",
          },
        ];
      });

      await expect(
        engine.stopAgent(record.agent_id, false, {
          beforeSurfaceMutation,
        }),
      ).rejects.toThrow(/surface route changed.*mutation gate/i);

      expect(beforeSurfaceMutation).toHaveBeenCalledTimes(1);
      expect(mockClient.sendKey).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(engine.getAgentState(record.agent_id)?.state).toBe("working");
    });

    it("re-evaluates pane collapse when a co-tenant arrives during the mutation gate", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const record = makeRecord({
        agent_id: "agent-stop-new-cotenant",
        state: "working",
        surface_id: "surface:dying",
        surface_uuid: stableUuid,
        workspace_id: "ws:1",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface("surface:dying"),
          id: stableUuid,
          workspace_ref: "ws:1",
        },
      ];
      await engine.getRegistry().reconstitute();

      await engine.stopAgent(record.agent_id, false, {
        beforeSurfaceMutation: async () => {
          liveSurfaces = [
            ...liveSurfaces,
            {
              ...makeSurface("surface:co-tenant"),
              id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              workspace_ref: "ws:1",
            },
          ];
        },
      });

      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:dying",
        expect.objectContaining({
          workspace: "ws:1",
          collapsePane: false,
        }),
      );
    });

    it("re-resolves the stable UUID again after Ctrl+C before closing", async () => {
      engine.dispose();
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const recycledUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      (mockClient.sendKey as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          liveSurfaces = [
            {
              ...makeSurface("surface:stop-old"),
              id: recycledUuid,
              workspace_ref: "ws:1",
            },
            {
              ...makeSurface("surface:stop-new"),
              id: stableUuid,
              workspace_ref: "ws:1",
            },
          ];
        },
      );
      (mockClient.closeSurface as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => {
          liveSurfaces = liveSurfaces.filter(
            (candidate) => candidate.ref !== surface,
          );
        },
      );
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        stopPostConditionTimeoutMs: 20,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stop-after-signal-race",
          state: "working",
          surface_id: "surface:stop-old",
          surface_uuid: stableUuid,
          workspace_id: "ws:1",
        }),
      );
      liveSurfaces = [
        {
          ...makeSurface("surface:stop-old"),
          id: stableUuid,
          workspace_ref: "ws:1",
        },
      ];
      await engine.getRegistry().reconstitute();

      await engine.stopAgent("agent-stop-after-signal-race");

      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:stop-new",
        expect.objectContaining({ collapsePane: false }),
      );
      expect(mockClient.closeSurface).not.toHaveBeenCalledWith(
        "surface:stop-old",
        expect.anything(),
      );
    });

    it("treats UUID disappearance caused by Ctrl+C as an already-closed surface", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const witnessUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const record = makeRecord({
        agent_id: "agent-stop-signal-closed",
        state: "working",
        surface_id: "surface:signal-closed",
        surface_uuid: stableUuid,
        workspace_id: "ws:1",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface(record.surface_id),
          id: stableUuid,
          workspace_ref: "ws:1",
        },
        {
          ...makeSurface("surface:witness"),
          id: witnessUuid,
          workspace_ref: "ws:1",
        },
      ];
      await engine.getRegistry().reconstitute();
      (mockClient.sendKey as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          liveSurfaces = liveSurfaces.filter(
            (surface) => surface.id !== stableUuid,
          );
        },
      );

      await engine.stopAgent(record.agent_id);

      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(engine.getAgentState(record.agent_id)?.state).toBe("done");
    });

    it("does not accept UUID absence observed by a different surface owner", async () => {
      engine.dispose();
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      let observerId = "cmux:/tmp/cmux-primary.sock";
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces, {
        observerIdProvider: () => observerId,
      });
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        stopPostConditionTimeoutMs: 20,
      });
      const record = makeRecord({
        agent_id: "agent-stop-foreign-absence",
        state: "working",
        surface_id: "surface:owned",
        surface_uuid: stableUuid,
        surface_observer_id: observerId,
        workspace_id: "ws:1",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface(record.surface_id),
          id: stableUuid,
          workspace_ref: "ws:1",
        },
      ];
      await registry.reconstitute();
      (mockClient.sendKey as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          observerId = "cmux:/tmp/cmux-secondary.sock";
          liveSurfaces = [
            {
              ...makeSurface("surface:foreign-witness"),
              id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              workspace_ref: "ws:1",
            },
          ];
        },
      );

      await expect(engine.stopAgent(record.agent_id)).rejects.toThrow(
        /stable surface UUID|fresh topology/i,
      );

      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(engine.getAgentState(record.agent_id)?.state).toBe("working");
    });

    it("does not treat an empty post-signal topology as authoritative UUID absence", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const record = makeRecord({
        agent_id: "agent-stop-empty-absence",
        state: "working",
        surface_id: "surface:empty-absence",
        surface_uuid: stableUuid,
        workspace_id: "ws:1",
      });
      stateMgr.writeState(record);
      liveSurfaces = [
        {
          ...makeSurface(record.surface_id),
          id: stableUuid,
          workspace_ref: "ws:1",
        },
      ];
      await engine.getRegistry().reconstitute();
      (mockClient.sendKey as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          liveSurfaces = [];
        },
      );

      await expect(engine.stopAgent(record.agent_id)).rejects.toThrow(
        /stable surface UUID|fresh topology/i,
      );

      expect(mockClient.closeSurface).not.toHaveBeenCalled();
      expect(engine.getAgentState(record.agent_id)?.state).toBe("working");
    });

    it("accepts UUID disappearance even when the cached ref is recycled", async () => {
      engine.dispose();
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const coTenantUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const recycledUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      (mockClient.closeSurface as ReturnType<typeof vi.fn>).mockImplementation(
        async (surface: string) => {
          expect(surface).toBe("surface:postcondition-old");
          liveSurfaces = [
            {
              ...makeSurface("surface:co-tenant"),
              id: coTenantUuid,
              workspace_ref: "ws:1",
            },
            {
              ...makeSurface("surface:postcondition-old"),
              id: recycledUuid,
              workspace_ref: "ws:1",
            },
          ];
        },
      );
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        stopPostConditionTimeoutMs: 20,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stop-postcondition-uuid",
          state: "working",
          surface_id: "surface:postcondition-old",
          surface_uuid: stableUuid,
          workspace_id: "ws:1",
        }),
      );
      liveSurfaces = [
        {
          ...makeSurface("surface:postcondition-old"),
          id: stableUuid,
          workspace_ref: "ws:1",
        },
        {
          ...makeSurface("surface:co-tenant"),
          id: coTenantUuid,
          workspace_ref: "ws:1",
        },
      ];
      await engine.getRegistry().reconstitute();

      await engine.stopAgent("agent-stop-postcondition-uuid");

      expect(
        engine.getAgentState("agent-stop-postcondition-uuid")?.state,
      ).toBe("done");
    });

    it("refuses stop I/O when a stable UUID is absent from fresh topology", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stop-missing-uuid",
          state: "working",
          surface_id: "surface:old",
          surface_uuid: stableUuid,
        }),
      );
      liveSurfaces = [{ ...makeSurface("surface:old"), id: stableUuid }];
      await engine.getRegistry().reconstitute();
      liveSurfaces = [
        { ...makeSurface("surface:old"), id: "uuid-foreign" },
      ];

      await expect(
        engine.stopAgent("agent-stop-missing-uuid"),
      ).rejects.toThrow(/stable surface UUID|fresh topology/i);
      expect(mockClient.sendKey).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
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

    it("rejects graceful stop when the agent surface remains live", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-still-live",
          state: "working",
          surface_id: "surface:still-live",
        }),
      );
      liveSurfaces = [makeSurface("surface:still-live")];
      (mockClient.closeSurface as ReturnType<typeof vi.fn>).mockResolvedValue(
        undefined,
      );
      await engine.getRegistry().reconstitute();

      await expect(engine.stopAgent("agent-still-live")).rejects.toThrow(
        /post-condition/i,
      );
      expect(stateMgr.readState("agent-still-live")?.state).not.toBe("done");
    });

    it("rejects graceful stop when the pane respawns a fresh idle surface", async () => {
      const pane = {
        ref: "pane:agent",
        index: 0,
        focused: true,
        surface_count: 1,
        surface_refs: ["surface:old-agent"],
        selected_surface_ref: "surface:old-agent",
      };
      mockClient = makeMockClient({
        listWorkspaces: vi.fn().mockResolvedValue({
          workspaces: [
            {
              ref: "ws:1",
              title: "ws:1",
              index: 0,
              selected: true,
              pinned: false,
            },
          ],
        }),
        listPanes: vi.fn().mockResolvedValue({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          panes: [pane],
        }),
        listPaneSurfaces: vi.fn().mockResolvedValue({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: "pane:agent",
          surfaces: [makeSurface("surface:old-agent")],
        }),
        closeSurface: vi.fn().mockImplementation(async () => {
          liveSurfaces = [makeSurface("surface:fresh-idle")];
          (
            mockClient.listPanes as ReturnType<typeof vi.fn>
          ).mockResolvedValue({
            workspace_ref: "ws:1",
            window_ref: "window:1",
            panes: [
              {
                ...pane,
                surface_refs: ["surface:fresh-idle"],
                selected_surface_ref: "surface:fresh-idle",
              },
            ],
          });
          (
            mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
          ).mockResolvedValue({
            workspace_ref: "ws:1",
            window_ref: "window:1",
            pane_ref: "pane:agent",
            surfaces: [
              {
                ...makeSurface("surface:fresh-idle"),
                title: "What can I help you with?",
              },
            ],
          });
        }),
      });
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-respawned-pane",
          state: "working",
          surface_id: "surface:old-agent",
          workspace_id: "ws:1",
        }),
      );
      liveSurfaces = [makeSurface("surface:old-agent")];
      await engine.getRegistry().reconstitute();

      await expect(engine.stopAgent("agent-respawned-pane")).rejects.toThrow(
        /post-condition/i,
      );
      expect(stateMgr.readState("agent-respawned-pane")?.state).not.toBe("done");
    });

    it("closes only the stopped agent surface when another live agent shares the pane", async () => {
      const pane = {
        ref: "pane:shared",
        index: 0,
        focused: true,
        surface_count: 2,
        surface_refs: ["surface:dying", "surface:other"],
        selected_surface_ref: "surface:dying",
      };
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [pane],
      });
      (mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        pane_ref: "pane:shared",
        surfaces: [
          makeSurface("surface:dying"),
          makeSurface("surface:other"),
        ],
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-dying",
          state: "working",
          surface_id: "surface:dying",
          workspace_id: "ws:1",
        }),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-other",
          state: "working",
          surface_id: "surface:other",
          workspace_id: "ws:1",
        }),
      );
      liveSurfaces = [makeSurface("surface:dying"), makeSurface("surface:other")];
      await engine.getRegistry().reconstitute();

      await engine.stopAgent("agent-dying");

      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:dying",
        expect.objectContaining({
          workspace: "ws:1",
          collapsePane: false,
        }),
      );
      expect(mockClient.closeSurface).toHaveBeenCalledTimes(1);
      expect(stateMgr.readState("agent-dying")?.state).toBe("done");
      expect(stateMgr.readState("agent-other")?.state).toBe("working");
    });

    it("never collapses a pane when the observer changes during close-policy observation", async () => {
      engine.dispose();
      let currentObserverId = "cmux:/tmp/cmux-primary.sock";
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerIdProvider: () => currentObserverId },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      const record = makeRecord({
        agent_id: "agent-observer-switch-close-policy",
        state: "working",
        surface_id: "surface:worker",
        surface_uuid: stableUuid,
        surface_observer_id: currentObserverId,
        workspace_id: "ws:1",
        role: "worker",
      });
      stateMgr.writeState(record);
      scopedRegistry.set(record.agent_id, record);
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockResolvedValue({
        workspace_ref: "ws:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:worker",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:worker"],
            surface_ids: [stableUuid],
            selected_surface_ref: "surface:worker",
          },
        ],
      });
      (
        mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
      ).mockImplementation(async () => {
        currentObserverId = "cmux:/tmp/cmux-secondary.sock";
        return {
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: "pane:worker",
          surfaces: [
            { ...makeSurface("surface:worker"), id: stableUuid },
          ],
        };
      });

      const policy = await (
        engine as unknown as {
          resolveStopSurfaceClosePolicy(
            surfaceId: string,
            workspaceId?: string,
          ): Promise<{ paneRef: string | null; collapsePane: boolean }>;
        }
      ).resolveStopSurfaceClosePolicy("surface:worker", "ws:1");

      expect(policy).toEqual({ paneRef: null, collapsePane: false });
      expect(currentObserverId).toBe("cmux:/tmp/cmux-secondary.sock");
    });

    it("does not collapse an incompletely observed pane when a co-tenant UUID moved", async () => {
      const targetUuid = "11111111-2222-4333-8444-555555555555";
      const coTenantUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const pane = {
        ref: "pane:shared-moved",
        index: 0,
        focused: true,
        surface_count: 2,
        surface_refs: ["surface:dying", "surface:other-new"],
        surface_ids: [targetUuid, coTenantUuid],
        selected_surface_ref: "surface:dying",
      };
      (mockClient.listPanes as ReturnType<typeof vi.fn>).mockImplementation(
        async () => ({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          panes:
            liveSurfaces.length === 0
              ? []
              : [
                  {
                    ...pane,
                    surface_count: liveSurfaces.length,
                    surface_refs: liveSurfaces.map((surface) => surface.ref),
                    surface_ids: liveSurfaces.map((surface) => surface.id),
                    selected_surface_ref: liveSurfaces[0]?.ref,
                  },
                ],
        }),
      );
      (mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: pane.ref,
          surfaces: [
            { ...makeSurface("surface:dying"), id: targetUuid },
            { ...makeSurface("surface:other-new"), id: coTenantUuid },
          ],
        })
        .mockResolvedValueOnce({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: pane.ref,
          surfaces: [{ ...makeSurface("surface:dying"), id: targetUuid }],
        })
        .mockImplementation(async () => ({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: pane.ref,
          surfaces: liveSurfaces,
        }));
      const target = makeRecord({
        agent_id: "agent-dying-moved-cotenant",
        state: "working",
        surface_id: "surface:dying",
        surface_uuid: targetUuid,
        workspace_id: "ws:1",
      });
      const coTenant = makeRecord({
        agent_id: "agent-other-moved",
        state: "working",
        surface_id: "surface:other-old",
        surface_uuid: coTenantUuid,
        workspace_id: "ws:1",
      });
      stateMgr.writeState(target);
      stateMgr.writeState(coTenant);
      engine.getRegistry().set(target.agent_id, target);
      engine.getRegistry().set(coTenant.agent_id, coTenant);
      liveSurfaces = [
        {
          ...makeSurface("surface:dying"),
          id: targetUuid,
          workspace_ref: "ws:1",
        },
        {
          ...makeSurface("surface:other-new"),
          id: coTenantUuid,
          workspace_ref: "ws:1",
        },
      ];

      await engine.stopAgent(target.agent_id);

      expect(mockClient.closeSurface).toHaveBeenCalledWith(
        "surface:dying",
        expect.objectContaining({
          workspace: "ws:1",
          collapsePane: false,
        }),
      );
      expect(stateMgr.readState(coTenant.agent_id)?.state).toBe("working");
    });

    it("resolves provisional agent aliases before stopping", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-pending",
          state: "working",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();
      const renamed = stateMgr.renameState("agent-pending", "agent-final");
      engine.getRegistry().rename("agent-pending", "agent-final", renamed);

      await engine.stopAgent("agent-pending");

      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:42",
        "c-c",
        expect.anything(),
      );
      expect(stateMgr.readState("agent-final")).toMatchObject({
        agent_id: "agent-final",
        state: "done",
        user_killed: true,
      });
      expect(stateMgr.readState("agent-pending")).toBeNull();
    });

    it("stops a never-renamed pending agent whose state directory is noncanonical", async () => {
      const agentId = "cmuxlayerCursor-pending-1780696860-r2fu";
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          state: "booting",
          surface_id: "surface:cursor-pending",
          repo: "cmuxlayer",
          model: "",
          cli: "cursor",
          role: "worker",
          boot_prompt_pending: true,
        }),
      );
      renameSync(join(TEST_DIR, agentId), join(TEST_DIR, `legacy-${agentId}`));
      expect(existsSync(join(TEST_DIR, agentId, "state.json"))).toBe(false);
      liveSurfaces = [makeSurface("surface:cursor-pending")];
      await engine.getRegistry().reconstitute();

      expect(engine.getAgentState(agentId)).toMatchObject({
        agent_id: agentId,
        state: "booting",
      });

      await engine.stopAgent(agentId);

      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:cursor-pending",
        "c-c",
        expect.anything(),
      );
      expect(engine.getAgentState(agentId)).toMatchObject({
        agent_id: agentId,
        state: "done",
        user_killed: true,
      });
      expect(stateMgr.readState(agentId)).toMatchObject({
        agent_id: agentId,
        state: "done",
        user_killed: true,
      });
    });

    it("force stop kills the process and removes the tracked entry", async () => {
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

      expect(stateMgr.readState("agent-force")).toBeNull();
      expect(engine.getAgentState("agent-force")).toBeNull();
    });

    it("force-removes a terminal ghost without resolving surface I/O", async () => {
      engine.dispose();
      const scopedRegistry = new AgentRegistry(
        stateMgr,
        async () => liveSurfaces,
        { observerId: "cmux:/tmp/nightly.sock" },
      );
      engine = new AgentEngine(stateMgr, scopedRegistry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      });
      stateMgr.writeState(
        makeRecord({
          agent_id: "foreign-terminal-ghost",
          state: "error",
          surface_id: "surface:gone",
          surface_uuid: "uuid-gone",
          surface_observer_id: "cmux:/tmp/prod.sock",
          error: "Surface surface:gone disappeared",
        }),
      );
      liveSurfaces = [
        {
          ...makeSurface("surface:witness"),
          id: "uuid-witness",
          workspace_ref: "ws:witness",
        },
      ];
      await scopedRegistry.reconstitute();
      for (const method of [
        mockClient.listWorkspaces,
        mockClient.listPanes,
        mockClient.listPaneSurfaces,
        mockClient.sendKey,
        mockClient.closeSurface,
      ]) {
        (method as ReturnType<typeof vi.fn>).mockClear();
      }

      await engine.stopAgent("foreign-terminal-ghost", true);

      expect(stateMgr.readState("foreign-terminal-ghost")).toBeNull();
      expect(engine.getAgentState("foreign-terminal-ghost")).toBeNull();
      expect(mockClient.listWorkspaces).not.toHaveBeenCalled();
      expect(mockClient.listPanes).not.toHaveBeenCalled();
      expect(mockClient.listPaneSurfaces).not.toHaveBeenCalled();
      expect(mockClient.sendKey).not.toHaveBeenCalled();
      expect(mockClient.closeSurface).not.toHaveBeenCalled();
    });

    it("rejects force stop when the pid remains alive after SIGKILL", async () => {
      const killCalls: Array<[number, NodeJS.Signals | 0]> = [];
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
          killCalls.push([pid, signal ?? 0]);
          return true;
        }) as typeof process.kill);

      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "agent-force-live",
            state: "working",
            surface_id: "surface:force-live",
            pid: 12345,
          }),
        );
        liveSurfaces = [makeSurface("surface:force-live")];
        await engine.getRegistry().reconstitute();

        await expect(engine.stopAgent("agent-force-live", true)).rejects.toThrow(
          /post-condition/i,
        );
        expect(killCalls).toContainEqual([12345, "SIGKILL"]);
        expect(killCalls).toContainEqual([12345, 0]);
        expect(stateMgr.readState("agent-force-live")?.state).not.toBe("done");
      } finally {
        killSpy.mockRestore();
      }
    });

    it("does not treat kill(0) permission errors as proof the process is still alive", async () => {
      const killCalls: Array<[number, NodeJS.Signals | 0]> = [];
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
          killCalls.push([pid, signal ?? 0]);
          if (signal === 0) {
            throw Object.assign(new Error("operation not permitted"), {
              code: "EPERM",
            });
          }
          return true;
        }) as typeof process.kill);

      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "agent-force-unknown",
            state: "working",
            surface_id: "surface:force-unknown",
            pid: 23456,
          }),
        );
        liveSurfaces = [makeSurface("surface:force-unknown")];
        await engine.getRegistry().reconstitute();

        await engine.stopAgent("agent-force-unknown", true);

        expect(killCalls).toContainEqual([23456, "SIGKILL"]);
        expect(killCalls).toContainEqual([23456, 0]);
        expect(stateMgr.readState("agent-force-unknown")).toBeNull();
        expect(engine.getAgentState("agent-force-unknown")).toBeNull();
      } finally {
        killSpy.mockRestore();
      }
    });

    it("preserves tracking when force SIGKILL is not permitted", async () => {
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        stopPostConditionTimeoutMs: 20,
      });
      const killCalls: Array<[number, NodeJS.Signals | 0]> = [];
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
          killCalls.push([pid, signal ?? 0]);
          throw Object.assign(new Error("operation not permitted"), {
            code: "EPERM",
          });
        }) as typeof process.kill);

      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "agent-force-eperm",
            state: "working",
            surface_id: "surface:force-eperm",
            pid: 56789,
          }),
        );
        liveSurfaces = [makeSurface("surface:force-eperm")];
        await engine.getRegistry().reconstitute();

        await expect(engine.stopAgent("agent-force-eperm", true)).rejects.toThrow(
          /process still alive/i,
        );

        expect(killCalls).toContainEqual([56789, "SIGKILL"]);
        expect(killCalls).toContainEqual([56789, 0]);
        expect(stateMgr.readState("agent-force-eperm")).toMatchObject({
          state: "working",
          quality: "degraded",
          error: expect.stringMatching(/process still alive/i),
        });
        expect(engine.getAgentState("agent-force-eperm")).toMatchObject({
          state: "working",
        });
      } finally {
        killSpy.mockRestore();
      }
    });

    it("treats kill(0) permission errors as live during graceful stop", async () => {
      engine.dispose();
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        stopPostConditionTimeoutMs: 20,
      });
      const killCalls: Array<[number, NodeJS.Signals | 0]> = [];
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
          killCalls.push([pid, signal ?? 0]);
          if (signal === 0) {
            throw Object.assign(new Error("operation not permitted"), {
              code: "EPERM",
            });
          }
          return true;
        }) as typeof process.kill);

      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "agent-grace-unknown",
            state: "working",
            surface_id: "surface:grace-unknown",
            pid: 45678,
          }),
        );
        liveSurfaces = [makeSurface("surface:grace-unknown")];
        await engine.getRegistry().reconstitute();

        await expect(engine.stopAgent("agent-grace-unknown")).rejects.toThrow(
          /process still alive/i,
        );

        expect(killCalls).toContainEqual([45678, 0]);
        expect(mockClient.sendKey).toHaveBeenCalledWith(
          "surface:grace-unknown",
          "c-c",
          expect.anything(),
        );
        expect(stateMgr.readState("agent-grace-unknown")).toMatchObject({
          state: "working",
          quality: "degraded",
          error: expect.stringMatching(/process still alive/i),
        });
      } finally {
        killSpy.mockRestore();
      }
    });

    it("does not mark naturally completed agents as user-killed", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-done",
          state: "done",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await engine.stopAgent("agent-done");

      expect(engine.getAgentState("agent-done")).toMatchObject({
        state: "done",
        user_killed: false,
      });
      expect(mockClient.sendKey).not.toHaveBeenCalled();
    });

    it("does not mark user_killed when the stop signal fails", async () => {
      (mockClient.sendKey as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("tty busy"),
      );
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-busy",
          state: "working",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await expect(engine.stopAgent("agent-busy")).rejects.toThrow("tty busy");
      expect(engine.getAgentState("agent-busy")).toMatchObject({
        state: "working",
        user_killed: false,
      });
    });

    it("marks an intentional stop before sending the CLI signal", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-stop-intent-before-signal",
          state: "working",
          surface_id: "surface:42",
          surface_provenance: "cmuxlayer_spawn",
          auto_revive: true,
          cli_session_id: "019faccc-3030-7444-8555-666677778888",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();
      (mockClient.sendKey as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          expect(
            engine.getAgentState("agent-stop-intent-before-signal"),
          ).toMatchObject({ user_killed: true });
        },
      );

      await engine.stopAgent("agent-stop-intent-before-signal");

      expect(
        engine.getAgentState("agent-stop-intent-before-signal"),
      ).toMatchObject({ state: "done", user_killed: true });
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

    it("re-resolves a moved UUID immediately before send I/O", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-send-moved",
          state: "ready",
          surface_id: "surface:old",
          surface_uuid: stableUuid,
        }),
      );
      liveSurfaces = [{ ...makeSurface("surface:old"), id: stableUuid }];
      await engine.getRegistry().reconstitute();
      liveSurfaces = [
        { ...makeSurface("surface:old"), id: "uuid-foreign" },
        { ...makeSurface("surface:new-route"), id: stableUuid },
      ];

      await engine.sendToAgent("agent-send-moved", "hello", true);

      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:new-route",
        "hello",
        expect.anything(),
      );
      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:new-route",
        "return",
        expect.anything(),
      );
      expect(mockClient.send).not.toHaveBeenCalledWith(
        "surface:old",
        "hello",
        expect.anything(),
      );
    });

    it("does not press Return when the stable UUID moves after sending text", async () => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-send-return-race",
          state: "ready",
          surface_id: "surface:send-old",
          surface_uuid: stableUuid,
        }),
      );
      liveSurfaces = [
        { ...makeSurface("surface:send-old"), id: stableUuid },
      ];
      await engine.getRegistry().reconstitute();
      (mockClient.send as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async () => {
          liveSurfaces = [
            {
              ...makeSurface("surface:send-old"),
              id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            },
            { ...makeSurface("surface:send-new"), id: stableUuid },
          ];
        },
      );

      await expect(
        engine.sendToAgent("agent-send-return-race", "hello", true),
      ).rejects.toThrow(/surface route changed.*Return/i);

      expect(mockClient.send).toHaveBeenCalledWith(
        "surface:send-old",
        "hello",
        expect.anything(),
      );
      expect(mockClient.sendKey).not.toHaveBeenCalled();
    });

    it("keeps an idle agent idle when text is staged without Return", async () => {
      vi.useFakeTimers();
      const sentAt = new Date("2026-05-25T13:00:00.000Z");
      const originalUpdatedAt = "2026-05-25T12:00:00.000Z";
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-idle",
          state: "idle",
          surface_id: "surface:42",
          updated_at: originalUpdatedAt,
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      try {
        vi.setSystemTime(sentAt);
        await engine.sendToAgent("agent-idle", "continue");

        expect(mockClient.send).toHaveBeenCalled();
        expect(engine.getAgentState("agent-idle")).toMatchObject({
          state: "idle",
          updated_at: originalUpdatedAt,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("marks an idle agent working only after Return is delivered", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-idle-submit",
          state: "idle",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();

      await engine.sendToAgent("agent-idle-submit", "continue", true);

      expect(mockClient.sendKey).toHaveBeenCalledWith(
        "surface:42",
        "return",
        expect.anything(),
      );
      expect(engine.getAgentState("agent-idle-submit")?.state).toBe(
        "working",
      );
    });

    it("leaves an idle agent idle when submitted delivery fails", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-idle-send-failure",
          state: "idle",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();
      (mockClient.sendKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Return delivery failed"),
      );

      await expect(
        engine.sendToAgent("agent-idle-send-failure", "continue", true),
      ).rejects.toThrow(/Return delivery failed/);

      expect(engine.getAgentState("agent-idle-send-failure")?.state).toBe(
        "idle",
      );
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

    it("keeps a durably accepted queued receipt when telemetry logging fails", () => {
      vi.spyOn(stateMgr.getEventLog(), "appendDelivery").mockImplementation(
        () => {
          throw new Error("telemetry unavailable");
        },
      );

      const receipt = engine.queueDelivery({
        agent_id: "queued-telemetry-failure",
        text: "persist me",
        press_enter: true,
        source_event: "send_to",
      });

      expect(receipt).toMatchObject({
        delivery_state: "queued",
        terminal: false,
      });
      expect(engine.getDeliveryReceipt(receipt.delivery_id)).toMatchObject({
        text: "persist me",
        delivery_state: "queued",
      });
    });

    it("persists a composer-accepted queue without replaying it", async () => {
      const submitter = vi.fn();
      engine.setDeliverySubmitter(submitter);

      const receipt = engine.acceptComposerQueue({
        delivery_id: "composer-queue-1",
        agent_id: "composer-queued-agent",
        text: "already accepted by the Codex queue",
        press_enter: true,
        source_event: "send_to",
        retry_count: 0,
      });

      expect(receipt).toMatchObject({
        delivery_state: "queued",
        terminal: false,
        composer_accepted: true,
        submit_verified: null,
      });
      await engine.drainDeliveryQueue();
      expect(submitter).not.toHaveBeenCalled();

      const restartedState = new StateManager(TEST_DIR);
      const restarted = new AgentEngine(
        restartedState,
        new AgentRegistry(restartedState, async () => []),
        mockClient,
      );
      try {
        expect(restarted.getDeliveryReceipt(receipt.delivery_id)).toMatchObject({
          delivery_state: "queued",
          terminal: false,
          composer_accepted: true,
        });
      } finally {
        restarted.dispose();
      }
    });

    it("makes a hung queued submission terminal-uncertain without replay", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "hung-queued-delivery",
          state: "idle",
          surface_id: "surface:42",
        }),
      );
      liveSurfaces = [makeSurface("surface:42")];
      await engine.getRegistry().reconstitute();
      (engine as any).deliverySubmitTimeoutMs = 5;
      engine.setDeliverySubmitter(
        async () => await new Promise<never>(() => {}),
      );
      const receipt = engine.queueDelivery({
        agent_id: "hung-queued-delivery",
        text: "submit once",
        press_enter: true,
        source_event: "send_to",
      });

      await engine.drainDeliveryQueue();

      expect(engine.getDeliveryReceipt(receipt.delivery_id)).toMatchObject({
        delivery_state: "failed",
        terminal: true,
        error: expect.stringMatching(/timed out|uncertain/i),
      });
    });

    it("keeps an accepted receipt queued across a transient posture mismatch and retries after capped backoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-11T18:00:00.000Z"));
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "posture-race-delivery",
            state: "idle",
            surface_id: "surface:42",
          }),
        );
        liveSurfaces = [makeSurface("surface:42")];
        await engine.getRegistry().reconstitute();
        const submitter = vi
          .fn()
          .mockRejectedValueOnce(
            new RetryableDeliveryError(
              'Agent "posture-race-delivery" is not in an interactive state (current: working)',
            ),
          )
          .mockResolvedValueOnce({ retry_count: 0, submit_verified: true });
        engine.setDeliverySubmitter(submitter);
        const receipt = engine.queueDelivery({
          agent_id: "posture-race-delivery",
          text: "accepted means eventual",
          press_enter: true,
          source_event: "send_to",
        });

        await engine.drainDeliveryQueue();

        const deferred = engine.getDeliveryReceipt(receipt.delivery_id);
        expect(deferred).toMatchObject({
          delivery_state: "queued",
          terminal: false,
          retry_count: 1,
          submission_started_at: null,
          error: expect.stringMatching(/not in an interactive state/),
        });
        expect(deferred?.next_attempt_at).toBe("2026-08-11T18:00:00.250Z");
        await engine.drainDeliveryQueue();
        expect(submitter).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date("2026-08-11T18:00:00.250Z"));
        await engine.drainDeliveryQueue();

        expect(submitter).toHaveBeenCalledTimes(2);
        expect(engine.getDeliveryReceipt(receipt.delivery_id)).toMatchObject({
          delivery_state: "submitted",
          terminal: true,
          retry_count: 1,
          submit_verified: true,
          error: null,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("terminal-fails a queued receipt only when its target is gone", async () => {
      const submitter = vi.fn();
      engine.setDeliverySubmitter(submitter);
      const receipt = engine.queueDelivery({
        agent_id: "gone-queued-delivery",
        text: "cannot arrive",
        press_enter: true,
        source_event: "send_to",
      });

      await engine.drainDeliveryQueue();

      expect(submitter).not.toHaveBeenCalled();
      expect(engine.getDeliveryReceipt(receipt.delivery_id)).toMatchObject({
        delivery_state: "failed",
        terminal: true,
        error: expect.stringMatching(/target.*gone|no longer exists/i),
      });
    });

    it("caps repeated retryable delivery backoff at thirty seconds", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-11T18:00:00.000Z"));
      try {
        stateMgr.writeState(
          makeRecord({
            agent_id: "bounded-backoff-delivery",
            state: "idle",
            surface_id: "surface:42",
          }),
        );
        liveSurfaces = [makeSurface("surface:42")];
        await engine.getRegistry().reconstitute();
        engine.setDeliverySubmitter(async () => {
          throw new RetryableDeliveryError("route posture changed");
        });
        const receipt = engine.queueDelivery({
          agent_id: "bounded-backoff-delivery",
          text: "keep accepted",
          press_enter: true,
          source_event: "send_to",
        });

        let previousAttemptAt = Date.now();
        for (let attempt = 1; attempt <= 8; attempt += 1) {
          await engine.drainDeliveryQueue();
          const deferred = engine.getDeliveryReceipt(receipt.delivery_id)!;
          expect(deferred).toMatchObject({
            delivery_state: "queued",
            terminal: false,
            retry_count: attempt,
          });
          const nextAttemptAt = Date.parse(deferred.next_attempt_at!);
          const expectedDelay = Math.min(30_000, 250 * 2 ** (attempt - 1));
          expect(nextAttemptAt - previousAttemptAt).toBe(expectedDelay);
          vi.setSystemTime(nextAttemptAt);
          previousAttemptAt = nextAttemptAt;
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not replay a queued receipt whose persisted submission had started", () => {
      const receipt = engine.queueDelivery({
        agent_id: "crashed-queued-delivery",
        text: "maybe landed",
        press_enter: true,
        source_event: "send_to",
      });
      const receiptPath = join(TEST_DIR, "delivery-receipts.json");
      const persisted = JSON.parse(readFileSync(receiptPath, "utf8"));
      persisted[0].submission_started_at = "2026-08-11T18:00:00.000Z";
      writeFileSync(receiptPath, `${JSON.stringify(persisted)}\n`, "utf8");

      const restartedState = new StateManager(TEST_DIR);
      const restarted = new AgentEngine(
        restartedState,
        new AgentRegistry(restartedState, async () => []),
        mockClient,
      );
      try {
        expect(restarted.getDeliveryReceipt(receipt.delivery_id)).toMatchObject({
          delivery_state: "failed",
          terminal: true,
          error: expect.stringMatching(/uncertain|restart/i),
        });
      } finally {
        restarted.dispose();
      }
    });
  });
});

describe("buildLaunchCommand", () => {
  it("uses repoGolem launcher for claude (no cd prefix)", () => {
    expect(buildLaunchCommand("claude", "brainlayer")).toBe(
      "brainlayerClaude -s",
    );
    expect(buildLaunchCommand("claude", "voicelayer")).toBe(
      "voicelayerClaude -s",
    );
    expect(buildLaunchCommand("claude", "golems")).toBe("golemsClaude -s");
  });

  it("uses repoGolem launcher for codex (no positional prompt)", () => {
    expect(buildLaunchCommand("codex", "brainlayer")).toBe(
      "brainlayerCodex -s",
    );
  });

  it("passes an explicit Codex model with the launcher override env", () => {
    expect(
      buildLaunchCommand("codex", "brainlayer", "gpt-5.6-luna"),
    ).toBe("REPOGOLEM_ALLOW_MODEL=1 brainlayerCodex -s -m gpt-5.6-luna");
  });

  it("passes an explicit Codex effort to the repoGolem launcher", () => {
    expect(
      buildLaunchCommand("codex", "brainlayer", undefined, undefined, {
        effort: "medium",
      }),
    ).toBe("brainlayerCodex -s -E medium");
  });

  it("adds safe model flags for launcher-owned Codex model names", () => {
    expect(buildLaunchCommand("claude", "brainlayer", "sonnet")).toBe(
      "brainlayerClaude -s -S",
    );
    expect(
      buildLaunchCommand("codex", "brainlayer", "gpt-5.3-codex-spark"),
    ).toBe(
      "REPOGOLEM_ALLOW_MODEL=1 brainlayerCodex -s -m gpt-5.3-codex-spark",
    );
    expect(
      buildLaunchCommand(
        "codex",
        "brainlayer",
        "gpt-5.3-codex-spark",
        undefined,
        { allowModelOverride: true },
      ),
    ).toBe(
      "REPOGOLEM_ALLOW_MODEL=1 brainlayerCodex -s -m gpt-5.3-codex-spark",
    );
    expect(buildLaunchCommand("codex", "brainlayer", "codex")).toBe(
      "brainlayerCodex -s",
    );
    expect(buildLaunchCommand("cursor", "cmuxlayer", "sonnet")).toBe(
      "cmuxlayerCursor -s",
    );
    expect(
      buildLaunchCommand("cursor", "cmuxlayer", "sonnet", undefined, {
        allowModelOverride: true,
      }),
    ).toBe("cmuxlayerCursor -s -m sonnet");
  });

  it("preserves launcher defaults when model is omitted", () => {
    expect(buildLaunchCommand("claude", "brainlayer", undefined)).toBe(
      "brainlayerClaude -s",
    );
  });

  it("shell-quotes arbitrary launcher-owned Codex model values", () => {
    expect(
      buildLaunchCommand("claude", "brainlayer", "Opus 4.8 (1M context)"),
    ).toBe("brainlayerClaude -s");
    expect(buildLaunchCommand("codex", "brainlayer", "gpt-5.5 xhigh")).toBe(
      "REPOGOLEM_ALLOW_MODEL=1 brainlayerCodex -s -m 'gpt-5.5 xhigh'",
    );
    expect(buildLaunchCommand("codex", "brainlayer", "codex;rm-rf")).toBe(
      "REPOGOLEM_ALLOW_MODEL=1 brainlayerCodex -s -m 'codex;rm-rf'",
    );
    expect(buildLaunchCommand("gemini", "golems", "constructor")).toBe(
      "golemsGemini -s",
    );
  });

  it("uses repoGolem launcher for gemini (no cd prefix, wires MCP)", () => {
    expect(buildLaunchCommand("gemini", "voicelayer")).toBe(
      "voicelayerGemini -s",
    );
    expect(buildLaunchCommand("gemini", "golems")).toBe("golemsGemini -s");
  });

  it("adds safe -m model flags for the gemini launcher", () => {
    expect(buildLaunchCommand("gemini", "voicelayer", "gemini-2.5-pro")).toBe(
      "voicelayerGemini -s -m gemini-2.5-pro",
    );
    expect(buildLaunchCommand("gemini", "golems", "pro")).toBe(
      "golemsGemini -s -m pro",
    );
  });

  it("adds safe --model flags for recognized raw CLI model aliases", () => {
    expect(buildLaunchCommand("kiro", "golems", "sonnet")).toBe(
      "cd ~/Gits/golems && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli --model sonnet",
    );
  });

  it("uses cd + env vars + kiro-cli for kiro", () => {
    expect(buildLaunchCommand("kiro", "golems")).toBe(
      "cd ~/Gits/golems && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli",
    );
  });

  it("uses repoGolem launcher for cursor (no positional prompt)", () => {
    expect(buildLaunchCommand("cursor", "cmuxlayer")).toBe(
      "cmuxlayerCursor -s",
    );
  });

  it("passes cwd as -w to launcher CLIs while keeping kiro on cd", () => {
    const cwd = "/Users/x/Gits/golems.wt/t";

    expect(
      buildLaunchCommand("claude", "golems", undefined, undefined, { cwd }),
    ).toBe("golemsClaude -s -w '/Users/x/Gits/golems.wt/t'");
    expect(
      buildLaunchCommand("codex", "golems", undefined, undefined, { cwd }),
    ).toBe("golemsCodex -s -w '/Users/x/Gits/golems.wt/t'");
    expect(
      buildLaunchCommand("cursor", "golems", undefined, undefined, { cwd }),
    ).toBe("golemsCursor -s -w '/Users/x/Gits/golems.wt/t'");
    expect(
      buildLaunchCommand("gemini", "golems", undefined, undefined, { cwd }),
    ).toBe("golemsGemini -s -w '/Users/x/Gits/golems.wt/t'");
    expect(
      buildLaunchCommand("claude", "golems", "sonnet", undefined, {
        cwd: "/p/wt",
      }),
    ).toBe("golemsClaude -s -S -w '/p/wt'");
    expect(
      buildLaunchCommand("kiro", "golems", undefined, undefined, {
        cwd: "/p/wt",
      }),
    ).toBe(
      "cd '/p/wt' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli",
    );
    expect(
      buildLaunchCommand("claude", "golems", undefined, undefined, {
        cwd: "/Users/x/Gits/worktree launch",
      }),
    ).toBe("golemsClaude -s -w '/Users/x/Gits/worktree launch'");
  });

  it("uses an explicitly resolved launcher name for launcher CLIs", () => {
    expect(
      buildLaunchCommand(
        "cursor",
        "agent-html-host",
        undefined,
        "agenthtmlhostCursor",
      ),
    ).toBe("agenthtmlhostCursor -s");
    expect(
      buildLaunchCommand(
        "claude",
        "agent-html-host",
        "sonnet",
        "agenthtmlhostClaude",
      ),
    ).toBe("agenthtmlhostClaude -s -S");
  });

  it("honors an explicitly resolved launcher name for gemini", () => {
    expect(
      buildLaunchCommand(
        "gemini",
        "agent-html-host",
        undefined,
        "agenthtmlhostGemini",
      ),
    ).toBe("agenthtmlhostGemini -s");
  });

  it("ignores a launcher override for non-launcher CLIs (kiro)", () => {
    expect(buildLaunchCommand("kiro", "golems", undefined, "ignoredKiro")).toBe(
      "cd ~/Gits/golems && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli",
    );
  });

  it("rejects invalid repo names", () => {
    expect(() => buildLaunchCommand("claude", "foo bar")).toThrow(
      /Invalid repo name/,
    );
    expect(() => buildLaunchCommand("claude", "foo;rm -rf")).toThrow(
      /Invalid repo name/,
    );
    expect(() => buildLaunchCommand("claude", "")).toThrow(/Invalid repo name/);
  });

  it("rejects path-traversal names . and ..", () => {
    expect(() => buildLaunchCommand("codex", ".")).toThrow(/Invalid repo name/);
    expect(() => buildLaunchCommand("codex", "..")).toThrow(
      /Invalid repo name/,
    );
    expect(() => buildLaunchCommand("claude", ".")).toThrow(
      /Invalid repo name/,
    );
  });

  it("allows dots, hyphens, underscores in repo names", () => {
    expect(buildLaunchCommand("claude", "my-project")).toBe(
      "my-projectClaude -s",
    );
    expect(buildLaunchCommand("claude", "my_project")).toBe(
      "my_projectClaude -s",
    );
    expect(buildLaunchCommand("claude", "my.project")).toBe(
      "my.projectClaude -s",
    );
  });

  it("does NOT include env vars for codex (launcher handles them)", () => {
    const cmd = buildLaunchCommand("codex", "brainlayer");
    expect(cmd).not.toContain("CLAUDE_CODE_NO_FLICKER");
    expect(cmd).not.toContain("MCP_CONNECTION_NONBLOCKING");
  });

  it("includes MCP_CONNECTION_NONBLOCKING=1 for raw cd+exec CLIs (kiro)", () => {
    const cmd = buildLaunchCommand("kiro", "golems");
    expect(cmd).toContain("MCP_CONNECTION_NONBLOCKING=1");
  });

  it("does NOT include env vars for gemini (launcher handles them)", () => {
    const cmd = buildLaunchCommand("gemini", "voicelayer");
    expect(cmd).not.toContain("MCP_CONNECTION_NONBLOCKING");
    expect(cmd).not.toContain("CLAUDE_CODE_NO_FLICKER");
  });

  it("does NOT include env vars for claude (launcher handles them)", () => {
    const cmd = buildLaunchCommand("claude", "brainlayer");
    expect(cmd).not.toContain("MCP_CONNECTION_NONBLOCKING");
    expect(cmd).not.toContain("CLAUDE_CODE_NO_FLICKER");
  });
});

describe("assertLauncherAvailable", () => {
  const registryPath = join(TEST_DIR, "assert-launchers.zsh");

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(
      registryPath,
      [
        'repoGolem brainlayer "/Users/etanheyman/Gits/brainlayer"',
        'repoGolem agenthtmlhost "/Users/etanheyman/Gits/agent-html-host"',
        'repoGolem orc "/Users/etanheyman/Gits/orchestrator"',
      ].join("\n"),
    );
    vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves to the registered launcher name from launchers.zsh", async () => {
    await expect(assertLauncherAvailable("brainlayer", "Cursor")).resolves.toBe(
      "brainlayerCursor",
    );
  });

  it("resolves the registry prefix when it differs from the repo basename", async () => {
    await expect(
      assertLauncherAvailable("agent-html-host", "Cursor"),
    ).resolves.toBe("agenthtmlhostCursor");
    await expect(
      assertLauncherAvailable("orchestrator", "Cursor"),
    ).resolves.toBe("orcCursor");
  });

  it("throws with candidates, source, and registered launchers when missing", async () => {
    await expect(
      assertLauncherAvailable("skill-creator", "Cursor"),
    ).rejects.toThrow(
      /Launcher registry miss.*skill-creatorCursor.*skillcreatorCursor.*assert-launchers\.zsh.*brainlayerCursor/s,
    );
  });
});

describe("launcherNameCandidates", () => {
  it("returns a single candidate for hyphenless repos", () => {
    expect(launcherNameCandidates("brainlayer", "Cursor")).toEqual([
      "brainlayerCursor",
    ]);
  });

  it("includes the repoGolem orc alias for orchestrator", () => {
    expect(
      launcherNameCandidates("orchestrator", "Cursor", [
        {
          prefix: "orc",
          path: "/Users/etanheyman/Gits/orchestrator",
          repoBasename: "orchestrator",
        },
      ]),
    ).toEqual([
      "orchestratorCursor",
      "orcCursor",
    ]);
  });

  it("adds the lowercased hyphen-stripped form for hyphenated repos", () => {
    expect(launcherNameCandidates("agent-html-host", "Cursor")).toEqual([
      "agent-html-hostCursor",
      "agenthtmlhostCursor",
    ]);
  });

  it("preserves the verbatim form even when it has hyphens", () => {
    expect(launcherNameCandidates("maakaf-home", "Claude")).toEqual([
      "maakaf-homeClaude",
      "maakafhomeClaude",
    ]);
  });
});

describe("buildResumeCommand", () => {
  const sessionId = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";

  it("builds raw harness resume commands for engine-owned same-surface revival", () => {
    expect(buildRawResumeCommand("codex", "brainlayer", sessionId)).toBe(
      `codex resume ${sessionId}`,
    );
    expect(buildRawResumeCommand("claude", "brainlayer", sessionId)).toBe(
      `MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --resume ${sessionId}`,
    );
    // `cursor agent` has no `--session`; the real flag is `--resume [chatId]`.
    // Verified against `cursor agent --help` -- `--session` exits with
    // "error: unknown option '--session'".
    expect(buildRawResumeCommand("cursor", "brainlayer", sessionId)).toBe(
      `cursor agent --resume ${sessionId}`,
    );
    expect(buildRawResumeCommand("gemini", "brainlayer", sessionId)).toBe(
      `MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 gemini --resume ${sessionId}`,
    );
    expect(buildRawResumeCommand("kiro", "brainlayer", sessionId)).toBe(
      `cd ~/Gits/brainlayer && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli chat --resume-id ${sessionId}`,
    );
  });

  it("uses the verified resume command for each supported CLI", () => {
    expect(buildResumeCommand("claude", "brainlayer", sessionId)).toBe(
      "brainlayerClaude -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
    expect(buildResumeCommand("codex", "brainlayer", sessionId)).toBe(
      "brainlayerCodex --dangerously-bypass-approvals-and-sandbox resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
    expect(buildResumeCommand("cursor", "brainlayer", sessionId)).toBe(
      "brainlayerCursor -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
    expect(buildResumeCommand("gemini", "brainlayer", sessionId)).toBe(
      "brainlayerGemini -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
    expect(
      buildResumeCommand(
        "gemini",
        "agent-html-host",
        sessionId,
        "agenthtmlhostGemini",
      ),
    ).toBe(
      "agenthtmlhostGemini -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
    expect(buildResumeCommand("kiro", "brainlayer", sessionId)).toBe(
      "cd ~/Gits/brainlayer && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli chat --resume-id 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
  });

  it("uses a clean launcher field when the legacy repo field contains a tab title", () => {
    expect(
      buildResumeCommand(
        "claude",
        "brainlayer-lead PR647-red-baseline",
        sessionId,
        "brainlayerClaude",
      ),
    ).toBe(
      "brainlayerClaude -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
  });

  it("falls back to the clean repo launcher when launcher_name is decorated", () => {
    expect(
      buildResumeCommand(
        "codex",
        "brainlayer",
        sessionId,
        "brainlayerCodex [surface:606]",
      ),
    ).toBe(
      "brainlayerCodex --dangerously-bypass-approvals-and-sandbox resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
  });

  it("honors a clean registered launcher alias", () => {
    expect(
      buildResumeCommand("codex", "matchmat", sessionId, "mm-worker"),
    ).toBe(
      "mm-worker --dangerously-bypass-approvals-and-sandbox resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
  });

  it("rejects session prefixes instead of emitting an unusable resume command", () => {
    expect(() =>
      buildResumeCommand("claude", "brainlayer", "019d9aa5"),
    ).toThrow(/full session UUID/i);
  });

  it("does not advertise resumable when no clean launcher can be derived", () => {
    const payload = toAgentStatePayload(
      makeRecord({
        cli: "claude",
        repo: "brainlayer-lead PR647-red-baseline",
        launcher_name: null,
        cli_session_id: sessionId,
      }),
    );

    expect(payload.resumable).toBe(false);
    expect(payload).not.toHaveProperty("resume_command");
  });
});

describe("extractSessionId", () => {
  it("prefers contextual session markers over unrelated earlier UUIDs", () => {
    const traceId = "11111111-2222-3333-4444-555555555555";
    const sessionId = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";

    expect(
      extractSessionId(
        `trace_id=${traceId}\nTo continue this session, run codex resume ${sessionId}`,
      ),
    ).toBe(sessionId);
    expect(
      extractSessionId(`request ${traceId}\nSession ID: ${sessionId}`),
    ).toBe(sessionId);
    expect(extractSessionId(`request ${traceId}\nchatId: ${sessionId}`)).toBe(
      sessionId,
    );
    expect(
      extractSessionId(`request ${traceId}\nResumable session: ${sessionId}`),
    ).toBe(sessionId);
  });
});
