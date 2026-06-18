import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
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
  assertLauncherAvailable,
  buildLaunchCommand,
  buildResumeCommand,
  extractSessionId,
  launcherNameCandidates,
  resolveLauncherName,
  resolveSweepTiming,
} from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import { MAX_RESPAWN_ATTEMPTS, type AgentRecord } from "../src/agent-types.js";
import { SpawnGuard, SpawnRateLimitedError } from "../src/spawn-guard.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-engine");

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
    newSplit: vi.fn().mockResolvedValue({
      workspace: "ws:1",
      surface: "surface:new",
      pane: "pane:1",
      title: "",
      type: "terminal",
    } satisfies CmuxNewSplitResult),
    newSurface: vi.fn().mockResolvedValue({
      workspace: "ws:1",
      surface: "surface:new",
      pane: "pane:1",
      title: "",
      type: "terminal",
    }),
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

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => mockSpawnExit(1));
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
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

      expect(result.agent_id).toMatch(
        /^brainlayerClaude-pending-\d+-[a-z0-9]+$/,
      );
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

        await vi.runOnlyPendingTimersAsync();

        expect(stateMgr.readState(result.agent_id)).toMatchObject({
          state: "error",
          error: "Post-spawn liveness failed: surface surface:new is not live",
        });
        expect(mockClient.closeSurface).toHaveBeenCalledWith("surface:new", {
          workspace: "ws:1",
          collapsePane: true,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a healthy post-launch surface booting", async () => {
      vi.useFakeTimers();
      try {
        liveSurfaces = [makeSurface("surface:new")];
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
      expect(launchCmd).toBe("brainlayerClaude -s -m sonnet");
    });

    it("launches with the launcher name resolved by preflight", async () => {
      const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
      const resolvingEngine = new AgentEngine(stateMgr, registry, mockClient, {
        // agent-html-host registered only as the hyphen-stripped form.
        spawnPreflight: async () => ({ launcherName: "agenthtmlhostCursor" }),
        sessionIdentityResolver: () => null,
      });

      await resolvingEngine.spawnAgent({
        repo: "agent-html-host",
        cli: "cursor",
        prompt: "Fix gap F",
      });

      const [, launchCmd] = (mockClient.send as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(launchCmd).toBe("agenthtmlhostCursor -s");

      resolvingEngine.dispose();
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

    it("persists explicit role on spawned agents", async () => {
      const result = await engine.spawnAgent({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "Coordinate work",
        role: "ic",
      });

      expect(stateMgr.readState(result.agent_id)?.role).toBe("ic");
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
          ic: new Set(),
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

    it("partitions unfiltered surface lists by pane membership when placing spawned agents", async () => {
      engine.dispose();
      const surfaceProvider = async () => liveSurfaces;
      const registry = new AgentRegistry(stateMgr, surfaceProvider);
      engine = new AgentEngine(stateMgr, registry, mockClient, {
        spawnPreflight: async () => {},
        roleSurfaceIdsProvider: () => ({
          orchestrator: new Set(["surface:orc"]),
          ic: new Set(),
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

    it("splits a child worker under its parent IC pane", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "ic-1",
          state: "ready",
          surface_id: "surface:ic",
          cli: "claude",
          role: "ic",
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

      expect(mockClient.newSplit).toHaveBeenCalledWith("down", {
        pane: "pane:ic",
        workspace: "ws:1",
        type: "terminal",
      });
    });

    it("auto-closes archived Codex worker panes after TASK_DONE inactivity", async () => {
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

        expect(mockClient.closeSurface).toHaveBeenCalledWith(
          "surface:done-worker",
          { workspace: undefined },
        );
      } finally {
        vi.useRealTimers();
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
            role: "ic",
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

    it("prefers TASK_DONE auto-archive milliseconds over minutes when both env vars are set", async () => {
      const previousMs = process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MS;
      const previousMinutes =
        process.env.CMUXLAYER_TASK_DONE_AUTO_ARCHIVE_MINUTES;
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

        expect(mockClient.closeSurface).toHaveBeenCalledWith(
          "surface:done-worker-ms",
          { workspace: undefined },
        );
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

    it("measures TASK_DONE auto-archive delay from detection time, not updated_at", async () => {
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

        expect(mockClient.closeSurface).toHaveBeenCalledWith(
          "surface:detected-done-worker",
          { workspace: undefined },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips sidebar status writes after auto-archiving a done worker surface", async () => {
      vi.useFakeTimers();
      try {
        const doneAt = new Date("2026-05-25T12:00:00.000Z");
        vi.setSystemTime(new Date(doneAt.getTime() + 31 * 60_000));
        stateMgr.writeState(
          makeRecord({
            agent_id: "worker-archived-before-status",
            state: "done",
            surface_id: "surface:archived-before-status",
            cli: "codex",
            role: "worker",
            auto_archive_on_done: true,
            task_done_detected_at: doneAt.toISOString(),
          }),
        );
        liveSurfaces = [makeSurface("surface:archived-before-status")];
        await engine.getRegistry().reconstitute();
        (mockClient.setStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error("surface missing"),
        );

        await expect(engine.runSweep()).resolves.toBeUndefined();

        expect(mockClient.closeSurface).toHaveBeenCalledWith(
          "surface:archived-before-status",
          { workspace: undefined },
        );
        expect(mockClient.clearStatus).toHaveBeenCalledWith(
          "worker-archived-before-status",
          { workspace: undefined },
        );
        expect(mockClient.setStatus).not.toHaveBeenCalled();
        expect(
          engine.getAgentState("worker-archived-before-status"),
        ).toBeNull();
        expect(stateMgr.readState("worker-archived-before-status")).toBeNull();

        (mockClient.setStatus as ReturnType<typeof vi.fn>).mockClear();
        await engine.runSweep();
        expect(mockClient.setStatus).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not rewrite TASK_DONE candidates during the confirmation window", async () => {
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
        expect(after?.version).toBe(before?.version);
        expect(after?.updated_at).toBe(before?.updated_at);
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

      liveSurfaces = [];
      await engine.runSweep();

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
      expect(recovered?.respawn_attempts).toBe(1);
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

      liveSurfaces = [];
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

      liveSurfaces = [];
      await engine.runSweep();
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

      liveSurfaces = [];
      await engine.runSweep();

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

      liveSurfaces = [];
      await engine.runSweep();

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
      vi.useRealTimers();
    });

    it.each([
      [
        "codex",
        "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        `gpt-5.4
Working (12s • esc to interrupt)
To continue this session, run codex resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e`,
      ],
      [
        "claude",
        "5b9f4f35-2942-4c8b-b1af-d89d4e36c95d",
        `Claude Code
Session ID: 5b9f4f35-2942-4c8b-b1af-d89d4e36c95d`,
      ],
      [
        "cursor",
        "9e26fe1a-2374-4b15-b9b2-646ac7a8c2ef",
        `Cursor Agent
chatId: 9e26fe1a-2374-4b15-b9b2-646ac7a8c2ef`,
      ],
      [
        "gemini",
        "8c2f7f0c-00ee-4c6e-856d-cc7ae91f5274",
        `Gemini CLI
Resumable session: 8c2f7f0c-00ee-4c6e-856d-cc7ae91f5274`,
      ],
    ] as const)(
      "captures %s session ids from the boot banner within the first sweep",
      async (cli, sessionId, banner) => {
        liveSurfaces = [makeSurface("surface:new")];
        (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
          surface: "surface:new",
          text: banner,
          lines: 80,
          scrollback_used: true,
        });

        engine.startSweep(1000);
        const result = await engine.spawnAgent({
          repo: "brainlayer",
          model: "sonnet",
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

    it("finalizes agent_id to golemName-session-prefix and aliases the provisional id", async () => {
      const sessionId = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";
      liveSurfaces = [makeSurface("surface:new")];
      (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
        surface: "surface:new",
        text: `gpt-5.4
Working (12s • esc to interrupt)
To continue this session, run codex resume ${sessionId}`,
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

      const finalAgentId = "brainlayerCodex-019d9aa5";
      expect(result.agent_id).toMatch(
        /^brainlayerCodex-pending-\d+-[a-z0-9]+$/,
      );

      await vi.advanceTimersByTimeAsync(1000);

      expect(engine.getAgentState(finalAgentId)).toMatchObject({
        agent_id: finalAgentId,
        cli_session_id: sessionId,
        cli_session_path: null,
      });
      expect(engine.getAgentState(result.agent_id)).toMatchObject({
        agent_id: finalAgentId,
        cli_session_id: sessionId,
        cli_session_path: null,
      });
      expect(stateMgr.readState(result.agent_id)).toBeNull();
      expect(stateMgr.readState(finalAgentId)?.agent_id).toBe(finalAgentId);
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
      liveSurfaces = [makeSurface("surface:new")];
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

      expect(engine.getAgentState("brainlayerCodex-019e942c")).toMatchObject({
        agent_id: "brainlayerCodex-019e942c",
        cli_session_id: sessionId,
        cli_session_path: sessionPath,
      });
      expect(engine.getAgentState(result.agent_id)?.agent_id).toBe(
        "brainlayerCodex-019e942c",
      );
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
      vi.useFakeTimers();
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
        await vi.advanceTimersByTimeAsync(8_000);
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

    it("fails fast when reconcile detects the waited agent surface disappeared", async () => {
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

        liveSurfaces = [];
        const pending = engine.waitFor(
          "agent-surface-gone",
          "done",
          25 * 60_000,
        );
        await vi.advanceTimersByTimeAsync(1_100);
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
      expect(result.agent?.agent_id).toBe("agent-boot");
      expect(result.agent?.state).toBe("ready");
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

    it("does not promote booting agents while boot prompt delivery is pending", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-boot",
          state: "booting",
          surface_id: "surface:42",
          cli: "codex",
          boot_prompt_pending: true,
          updated_at: new Date().toISOString(),
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

      await engine.runSweep();

      expect(engine.getAgentState("agent-boot")?.state).toBe("booting");
    });

    it("marks stale pending boot prompt agents as errored", async () => {
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
        error: "Boot prompt delivery interrupted before completion",
      });
    });

    it("promotes low-confidence CLI prompts after consecutive matches", async () => {
      stateMgr.writeState(
        makeRecord({
          agent_id: "agent-gemini",
          state: "booting",
          surface_id: "surface:42",
          cli: "gemini",
          task_summary: "",
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
      expect(engine.getAgentState("agent-gemini")?.state).toBe("ready");
    });

    it("throws for non-existent agent", async () => {
      await expect(
        engine.waitFor("nonexistent", "ready", 1000),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("startSweep", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
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
        const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
        const defaultEngine = new AgentEngine(stateMgr, registry, mockClient);
        try {
          await expect(
            defaultEngine.spawnAgent({
              repo: `missinglauncher${suffix}`,
              model: "test",
              cli,
              prompt: "",
            }),
          ).rejects.toThrow(`missinglauncher${suffix}${suffix}`);
          expect(mockClient.newSplit).not.toHaveBeenCalled();
        } finally {
          defaultEngine.dispose();
        }
      },
    );
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

  it("adds safe model flags for recognized launcher model aliases", () => {
    expect(buildLaunchCommand("claude", "brainlayer", "sonnet")).toBe(
      "brainlayerClaude -s -m sonnet",
    );
    expect(
      buildLaunchCommand("codex", "brainlayer", "gpt-5.3-codex-spark"),
    ).toBe("brainlayerCodex -s -m gpt-5.3-codex-spark");
    expect(buildLaunchCommand("codex", "brainlayer", "codex")).toBe(
      "brainlayerCodex -s",
    );
    expect(buildLaunchCommand("cursor", "cmuxlayer", "sonnet")).toBe(
      "cmuxlayerCursor -s -m sonnet-4",
    );
  });

  it("preserves launcher defaults when model is omitted", () => {
    expect(buildLaunchCommand("claude", "brainlayer", undefined)).toBe(
      "brainlayerClaude -s",
    );
  });

  it("omits unsafe or unrecognized model values instead of passing them raw", () => {
    expect(
      buildLaunchCommand("claude", "brainlayer", "Opus 4.8 (1M context)"),
    ).toBe("brainlayerClaude -s");
    expect(buildLaunchCommand("codex", "brainlayer", "gpt-5.5 xhigh")).toBe(
      "brainlayerCodex -s",
    );
    expect(buildLaunchCommand("codex", "brainlayer", "codex;rm-rf")).toBe(
      "brainlayerCodex -s",
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
    ).toBe("agenthtmlhostClaude -s -m sonnet");
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
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubEnv("SHELL", "/bin/zsh");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves to the verbatim launcher name when the probe returns 0", async () => {
    spawnMock.mockImplementation(() => mockSpawnExit(0));

    await expect(assertLauncherAvailable("brainlayer", "Cursor")).resolves.toBe(
      "brainlayerCursor",
    );

    expect(spawnMock).toHaveBeenCalledWith(
      "/bin/zsh",
      [
        "-ilc",
        "type brainlayerCursor >/dev/null 2>&1 || command -v brainlayerCursor >/dev/null 2>&1",
      ],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
  });

  it("falls back to the hyphen-stripped launcher when verbatim is unregistered", async () => {
    // agent-html-host registered only as agenthtmlhostCursor (hyphens stripped).
    spawnMock.mockImplementation((_cmd, args) => {
      const probe = String(args?.[1] ?? "");
      if (probe.includes("agenthtmlhostCursor")) {
        return mockSpawnExit(0);
      }
      return mockSpawnExit(1);
    });

    await expect(
      assertLauncherAvailable("agent-html-host", "Cursor"),
    ).resolves.toBe("agenthtmlhostCursor");
  });

  it("throws listing every candidate when none resolve", async () => {
    spawnMock.mockImplementation(() => mockSpawnExit(1));

    await expect(
      assertLauncherAvailable("skill-creator", "Cursor"),
    ).rejects.toThrow(/skill-creatorCursor.*skillcreatorCursor.*cli="kiro"/s);
  });
});

describe("launcherNameCandidates", () => {
  it("returns a single candidate for hyphenless repos", () => {
    expect(launcherNameCandidates("brainlayer", "Cursor")).toEqual([
      "brainlayerCursor",
    ]);
  });

  it("includes the repoGolem orc alias for orchestrator", () => {
    expect(launcherNameCandidates("orchestrator", "Cursor")).toEqual([
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

describe("resolveLauncherName", () => {
  it("returns the verbatim launcher when it resolves first", async () => {
    const probe = vi.fn(async (name: string) => name === "maakaf-homeCursor");
    await expect(
      resolveLauncherName("maakaf-home", "Cursor", probe),
    ).resolves.toBe("maakaf-homeCursor");
    expect(probe).toHaveBeenCalledWith("maakaf-homeCursor");
  });

  it("probes the stripped form only after the verbatim form misses", async () => {
    const probe = vi.fn(async (name: string) => name === "agenthtmlhostCursor");
    await expect(
      resolveLauncherName("agent-html-host", "Cursor", probe),
    ).resolves.toBe("agenthtmlhostCursor");
    expect(probe).toHaveBeenNthCalledWith(1, "agent-html-hostCursor");
    expect(probe).toHaveBeenNthCalledWith(2, "agenthtmlhostCursor");
  });

  it("falls back to the orc launcher alias for the orchestrator repo", async () => {
    const probe = vi.fn(async (name: string) => name === "orcCursor");
    await expect(
      resolveLauncherName("orchestrator", "Cursor", probe),
    ).resolves.toBe("orcCursor");
    expect(probe).toHaveBeenNthCalledWith(1, "orchestratorCursor");
    expect(probe).toHaveBeenNthCalledWith(2, "orcCursor");
  });

  it("throws when no candidate resolves", async () => {
    const probe = vi.fn(async () => false);
    await expect(
      resolveLauncherName("agent-html-host", "Cursor", probe),
    ).rejects.toThrow(/agent-html-hostCursor.*agenthtmlhostCursor/s);
  });
});

describe("buildResumeCommand", () => {
  const sessionId = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";

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
    expect(buildResumeCommand("kiro", "brainlayer", sessionId)).toBe(
      "cd ~/Gits/brainlayer && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 kiro-cli chat --resume-id 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
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
