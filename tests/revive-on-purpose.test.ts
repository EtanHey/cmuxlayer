/**
 * Lane REVIVE (#492) — "close means closed".
 *
 * cmuxlayer must NEVER respawn a pane on its own. The only revive is the
 * explicit one, by agent id, and it must refuse rather than open an empty pane
 * when the session it would resume into cannot be found on disk (#482).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine, managedPaneTitle } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import {
  AgentRegistry,
  SURFACE_EVICTION_CONFIRMATION_MS,
} from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface } from "../src/types.js";
import { resetResumeArtifactResolver } from "../src/resume-verification.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-revive-on-purpose");
const CODEX_SESSION = "019faccc-1111-7222-8333-444455556666";

function makeSurface(ref: string): CmuxSurface {
  return { ref, title: "", type: "terminal", index: 0, selected: false };
}

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "cmuxlayerCodex-revive",
    surface_id: "surface:revive",
    state: "working",
    repo: "cmuxlayer",
    model: "gpt-5.4",
    cli: "codex",
    cli_session_id: CODEX_SESSION,
    task_summary: "lane work",
    pid: null,
    version: 0,
    created_at: "2026-08-19T03:40:00Z",
    updated_at: "2026-08-19T03:40:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    user_killed: false,
    surface_provenance: "cmuxlayer_spawn",
    ...overrides,
  } as AgentRecord;
}

/** A pane whose CLI has died back to a bare shell. */
const DEAD_SHELL_SCREEN = "etanheyman@mac cmuxlayer % ";

function makeMockClient(): CmuxClient {
  return {
    getTransportHealth: () => ({ mode: "socket", degraded: false }),
    newSplit: vi.fn().mockImplementation(async (_direction, opts) => ({
      workspace: opts?.workspace ?? "ws:1",
      surface: "surface:new",
      surface_id: "11111111-2222-4333-8444-555555555555",
      pane: "pane:1",
      title: "",
      type: "terminal",
    })),
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
      surface: "surface:revive",
      text: DEAD_SHELL_SCREEN,
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
  } as unknown as CmuxClient;
}

/** Write the codex rollout transcript that proves a session exists on disk. */
function writeCodexSessionArtifact(home: string, sessionId: string): void {
  const dir = join(home, ".codex", "sessions", "2026", "08", "19");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-08-19T03-40-00-${sessionId}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`,
  );
}

describe("revive on purpose (#492)", () => {
  let stateMgr: StateManager;
  let mockClient: CmuxClient;
  let engine: AgentEngine;
  let registry: AgentRegistry;
  let liveSurfaces: CmuxSurface[];
  let harnessHome: string;
  let previousHarnessHome: string | undefined;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    harnessHome = mkdtempSync(join(tmpdir(), "cmux-harness-home-"));
    previousHarnessHome = process.env.CMUXLAYER_HARNESS_HOME;
    process.env.CMUXLAYER_HARNESS_HOME = harnessHome;
    resetResumeArtifactResolver();
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    const workspaceForSurface = (surface: CmuxSurface): string =>
      surface.workspace_ref ??
      stateMgr.listStates().find((record) => record.surface_id === surface.ref)
        ?.workspace_id ??
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
                    selected_surface_ref: surfaces[0]?.ref,
                  },
                ],
        };
      },
    );
    (
      mockClient.listPaneSurfaces as ReturnType<typeof vi.fn>
    ).mockImplementation(
      async ({
        workspace,
        pane,
      }: { workspace?: string; pane?: string } = {}) => {
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
    registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts: { baseDir: TEST_DIR },
    });
  });

  afterEach(() => {
    engine.dispose();
    resetResumeArtifactResolver();
    rmSync(TEST_DIR, { recursive: true, force: true });
    rmSync(harnessHome, { recursive: true, force: true });
    if (previousHarnessHome === undefined) {
      delete process.env.CMUXLAYER_HARNESS_HOME;
    } else {
      process.env.CMUXLAYER_HARNESS_HOME = previousHarnessHome;
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

  it("never respawns a pane the operator closed in the UI", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(
      makeRecord({
        workspace_id: "ws:1",
        launcher_name: "cmuxlayerCodex",
      }),
    );
    liveSurfaces = [
      { ...makeSurface("surface:revive"), workspace_ref: "ws:1" },
    ];
    await engine.getRegistry().reconstitute();

    // The operator closes the tab: that surface is gone, the workspace is not.
    liveSurfaces = [{ ...makeSurface("surface:other"), workspace_ref: "ws:1" }];
    await runConfirmedSurfaceAbsenceSweep();
    await engine.runSweep();

    expect(mockClient.newSplit).not.toHaveBeenCalled();
    expect(mockClient.newSurface).not.toHaveBeenCalled();
    const state = engine.getAgentState("cmuxlayerCodex-revive");
    expect(state?.state).toBe("error");
    expect(state?.error).toContain("disappeared");
  });

  it("does not revive an unexpected CLI death; it records the terminal state", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(makeRecord({ workspace_id: "ws:1" }));
    liveSurfaces = [
      { ...makeSurface("surface:revive"), workspace_ref: "ws:1" },
    ];
    await engine.getRegistry().reconstitute();

    // The pane survives; the CLI inside it died back to a shell.
    await engine.runSweep();
    await engine.runSweep();
    await engine.runSweep();

    expect(mockClient.newSplit).not.toHaveBeenCalled();
    const sends = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[1]),
    );
    expect(sends.some((text) => text.includes(CODEX_SESSION))).toBe(false);
    const state = engine.getAgentState("cmuxlayerCodex-revive");
    expect(state?.state).toBe("error");
    expect(state?.error).toContain("CLI exited");
  });

  it("keeps a CLI death resumable by id after its pane is closed", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(makeRecord({ workspace_id: "ws:1" }));
    liveSurfaces = [
      { ...makeSurface("surface:revive"), workspace_ref: "ws:1" },
    ];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();
    await engine.runSweep();
    expect(engine.getAgentState("cmuxlayerCodex-revive")).toMatchObject({
      state: "error",
      error: "Agent CLI exited to shell without done evidence",
    });

    liveSurfaces = [{ ...makeSurface("surface:other"), workspace_ref: "ws:1" }];
    await runConfirmedSurfaceAbsenceSweep();

    const resumed = await engine.resumeAgent("cmuxlayerCodex-revive");
    expect(resumed.agent_id).toBe("cmuxlayerCodex-revive");
    expect(resumed.surface_id).toBe("surface:new");
  });

  it("explicit resume by agent id works when the session artifact exists", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(
      makeRecord({
        state: "done",
        workspace_id: "ws:1",
        surface_id: "surface:old",
      }),
    );
    await engine.getRegistry().reconstitute();

    const result = await engine.resumeAgent("cmuxlayerCodex-revive");

    expect(result.agent_id).toBe("cmuxlayerCodex-revive");
    expect(result.surface_id).toBe("surface:new");
    const sends = (mockClient.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[1]),
    );
    expect(sends.some((text) => text.includes(CODEX_SESSION))).toBe(true);
  });

  it("retains a resumable tombstone when a terminal agent is force-closed", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(
      makeRecord({
        state: "done",
        workspace_id: "ws:1",
        surface_id: "surface:old",
      }),
    );
    await engine.getRegistry().reconstitute();
    liveSurfaces = [
      {
        ...makeSurface("surface:witness"),
        workspace_ref: "ws:witness",
      },
    ];

    await engine.stopAgent("cmuxlayerCodex-revive", true);

    expect(stateMgr.readState("cmuxlayerCodex-revive")).toMatchObject({
      agent_id: "cmuxlayerCodex-revive",
      cli_session_id: CODEX_SESSION,
      state: "done",
      user_killed: true,
    });
    expect(registry.purgeAllTerminal()).toEqual([]);
    expect(stateMgr.readState("cmuxlayerCodex-revive")).not.toBeNull();
    const resumed = await engine.resumeAgent("cmuxlayerCodex-revive");
    expect(resumed).toMatchObject({
      agent_id: "cmuxlayerCodex-revive",
      surface_id: "surface:new",
    });
  });

  it("resumes by the raw harness session id and preserves the public agent id", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(
      makeRecord({
        state: "done",
        workspace_id: "ws:1",
        surface_id: "surface:old",
      }),
    );
    await engine.getRegistry().reconstitute();

    const resumed = await engine.resumeAgent(CODEX_SESSION);

    expect(resumed).toMatchObject({
      agent_id: "cmuxlayerCodex-revive",
      surface_id: "surface:new",
    });
  });

  it("rejects duplicate persisted owners of one raw harness session", async () => {
    for (const agentId of ["duplicate-session-a", "duplicate-session-b"]) {
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          state: "done",
          cli_session_id: CODEX_SESSION,
        }),
      );
    }

    expect(engine.resolveResumeAgent(CODEX_SESSION)).toBeNull();
  });

  it("recovers a missing captured id from the session registry before raw-id resume", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      selfRegistrationSessionLookup: (sessionId) =>
        sessionId === CODEX_SESSION
          ? {
              session_id: CODEX_SESSION,
              surface_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              cwd: "/home/test-user/Gits/cmuxlayer/.worktrees/run3",
              pid: null,
              cli: "codex",
              launcher: "cmuxlayerCodex",
              session_path: null,
              ts: Date.now(),
            }
          : null,
      inboxOpts: { baseDir: TEST_DIR },
    });
    stateMgr.writeState(
      makeRecord({
        state: "done",
        workspace_id: "ws:1",
        surface_id: "surface:old",
        surface_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        cli_session_id: null,
      }),
    );
    await registry.reconstitute();

    const resumed = await engine.resumeAgent(CODEX_SESSION);

    expect(resumed.agent_id).toBe("cmuxlayerCodex-revive");
    expect(stateMgr.readState("cmuxlayerCodex-revive")?.cli_session_id).toBe(
      CODEX_SESSION,
    );
  });

  it("prefers an exact registration surface over same-cwd fallback records", async () => {
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      selfRegistrationSessionLookup: () => ({
        session_id: CODEX_SESSION,
        surface_uuid: "exact-surface-uuid",
        cwd: "/shared/worktree",
        pid: null,
        cli: "codex",
        launcher: "cmuxlayerCodex",
        session_path: null,
        ts: Date.now(),
      }),
    });
    stateMgr.writeState(
      makeRecord({
        agent_id: "exact-agent",
        state: "done",
        cli_session_id: null,
        surface_uuid: "exact-surface-uuid",
        launch_cwd: "/shared/worktree",
      }),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "same-cwd-agent",
        cli_session_id: null,
        surface_uuid: "different-surface-uuid",
        launch_cwd: "/shared/worktree",
      }),
    );

    expect(engine.resolveResumeAgent(CODEX_SESSION)?.agent_id).toBe(
      "exact-agent",
    );
  });

  it("rejects ambiguous same-cwd registration fallback records", async () => {
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      selfRegistrationSessionLookup: () => ({
        session_id: CODEX_SESSION,
        surface_uuid: "missing-surface-uuid",
        cwd: "/shared/worktree",
        pid: null,
        cli: "codex",
        launcher: "cmuxlayerCodex",
        session_path: null,
        ts: Date.now(),
      }),
    });
    for (const agentId of ["first-cwd-agent", "second-cwd-agent"]) {
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          cli_session_id: null,
          surface_uuid: `${agentId}-surface`,
          launch_cwd: "/shared/worktree",
        }),
      );
    }

    expect(engine.resolveResumeAgent(CODEX_SESSION)).toBeNull();
  });

  it("rejects a raw-session registration that matches only by cwd", async () => {
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      selfRegistrationSessionLookup: () => ({
        session_id: CODEX_SESSION,
        surface_uuid: "missing-surface-uuid",
        cwd: "/shared/worktree",
        pid: null,
        cli: "codex",
        launcher: "cmuxlayerCodex",
        session_path: null,
        ts: Date.now(),
      }),
    });
    stateMgr.writeState(
      makeRecord({
        agent_id: "cwd-only-agent",
        state: "done",
        cli_session_id: null,
        surface_uuid: "different-surface-uuid",
        launch_cwd: "/shared/worktree",
      }),
    );

    expect(engine.resolveResumeAgent(CODEX_SESSION)).toBeNull();
  });

  it("rejects a stale registration that matches a newer record only by reused pid and cwd", async () => {
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      selfRegistrationSessionLookup: () => ({
        session_id: CODEX_SESSION,
        surface_uuid: "long-gone-surface",
        cwd: "/shared/worktree",
        pid: 4242,
        cli: "codex",
        launcher: "cmuxlayerCodex",
        session_path: null,
        ts: 1_700_000_000_000,
      }),
    });
    stateMgr.writeState(
      makeRecord({
        agent_id: "newer-unrelated-agent",
        state: "done",
        cli_session_id: null,
        surface_uuid: "new-surface",
        launch_cwd: "/shared/worktree",
        pid: 4242,
        created_at: "2026-08-25T10:00:00.000Z",
      }),
    );

    expect(engine.resolveResumeAgent(CODEX_SESSION)).toBeNull();
    expect(stateMgr.readState("newer-unrelated-agent")?.cli_session_id).toBeNull();
  });

  it("clears prior-run done and halt evidence when reopening for resume", () => {
    stateMgr.writeState(
      makeRecord({
        state: "done",
        task_done_candidate_at: "2026-08-24T10:00:00.000Z",
        task_done_detected_at: "2026-08-24T10:00:05.000Z",
        halt_last_active_at: "2026-08-24T10:00:06.000Z",
      }),
    );

    expect(stateMgr.reopenForResume("cmuxlayerCodex-revive")).toMatchObject({
      state: "creating",
      task_done_candidate_at: null,
      task_done_detected_at: null,
      halt_last_active_at: null,
    });
  });

  it("does not mutate an active fallback match during raw-id resolution", async () => {
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      selfRegistrationSessionLookup: () => ({
        session_id: CODEX_SESSION,
        surface_uuid: "active-surface-uuid",
        cwd: "/shared/worktree",
        pid: null,
        cli: "codex",
        launcher: "cmuxlayerCodex",
        session_path: "/rollout/raw.jsonl",
        ts: Date.now(),
      }),
    });
    stateMgr.writeState(
      makeRecord({
        agent_id: "active-agent",
        state: "working",
        cli_session_id: null,
        cli_session_path: null,
        surface_uuid: "active-surface-uuid",
        launch_cwd: "/shared/worktree",
      }),
    );

    expect(engine.resolveResumeAgent(CODEX_SESSION)).toBeNull();
    expect(stateMgr.readState("active-agent")).toMatchObject({
      cli_session_id: null,
      cli_session_path: null,
      state: "working",
    });
  });

  it("captures the full harness session id before spawn returns", async () => {
    engine.dispose();
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      selfRegistrationSessionResolver: (agent) => ({
        session_id: CODEX_SESSION,
        path: "/rollout/codex.jsonl",
        pid: null,
        pid_registered_at: null,
      }),
      inboxOpts: { baseDir: TEST_DIR },
    });

    const spawned = await engine.spawnAgent({
      repo: "cmuxlayer",
      cli: "codex",
      prompt: "capture my real harness id",
    });

    expect(stateMgr.readState(spawned.agent_id)?.cli_session_id).toBe(
      CODEX_SESSION,
    );
  });

  it("restores the persisted caller title when resuming an agent", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(
      makeRecord({
        state: "done",
        workspace_id: "ws:1",
        surface_id: "surface:old",
        tab_name: "cmuxlayer-WORKER · golden-path",
      }),
    );
    await engine.getRegistry().reconstitute();

    await engine.resumeAgent("cmuxlayerCodex-revive");

    expect(mockClient.renameTab).toHaveBeenCalledWith(
      "surface:new",
      "cmuxlayer-WORKER · golden-path",
      { workspace: "ws:1" },
    );
  });

  it("refuses to resume into a session that is not on disk, and opens no pane", async () => {
    mkdirSync(join(harnessHome, ".codex", "sessions"), { recursive: true });
    stateMgr.writeState(
      makeRecord({
        state: "done",
        workspace_id: "ws:1",
        surface_id: "surface:old",
      }),
    );
    await engine.getRegistry().reconstitute();

    await expect(engine.resumeAgent("cmuxlayerCodex-revive")).rejects.toThrow(
      /no .*session transcript|session .* (?:not found on disk|not in the harness session store)/i,
    );
    expect(mockClient.newSplit).not.toHaveBeenCalled();
    expect(mockClient.newSurface).not.toHaveBeenCalled();
  });

  it("uses the caller's role-first title verbatim", async () => {
    (mockClient.newSplit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      workspace: "ws:1",
      surface: "surface:worker-a",
      pane: "pane:1",
      title: "",
      type: "terminal",
    });

    await engine.spawnAgent({
      repo: "cmuxlayer",
      cli: "codex",
      prompt: "lane work",
      title: "cmuxlayer-WORKER · golden-path",
    });

    expect(mockClient.renameTab).toHaveBeenCalledWith(
      "surface:worker-a",
      "cmuxlayer-WORKER · golden-path",
      { workspace: "ws:1" },
    );
    expect(stateMgr.listStates()[0]?.tab_name).toBe(
      "cmuxlayer-WORKER · golden-path",
    );
  });

  it("keeps the existing agent-id fallback when the caller omits a title", () => {
    expect(
      managedPaneTitle(
        "cmuxlayerCodex-99887766",
        "surface:9",
      ),
    ).toBe("cmuxlayerCodex-99887766 [surface:9]");
  });

  it("uses the identifiable fallback when the caller supplies a blank title", () => {
    expect(
      managedPaneTitle("cmuxlayerCodex-99887766", "surface:9", ""),
    ).toBe("cmuxlayerCodex-99887766 [surface:9]");
    expect(
      managedPaneTitle("cmuxlayerCodex-99887766", "surface:9", "   "),
    ).toBe("cmuxlayerCodex-99887766 [surface:9]");
  });

  it("binds managed identity by UUID instead of a mutable ref or display title", async () => {
    const surfaceUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    stateMgr.writeState(
      makeRecord({
        surface_id: "surface:managed",
        surface_uuid: surfaceUuid,
        repo: "cmuxlayer",
        cli: "codex",
        role: "worker",
      }),
    );
    await registry.reconstitute();

    expect(
      registry.managedIdentityForSurface({ ref: "surface:managed" }),
    ).toBeNull();
    expect(
      registry.managedIdentityForSurface({
        ref: "surface:renumbered",
        id: surfaceUuid,
      }),
    ).toMatchObject({ repo: "cmuxlayer", cli: "codex", role: "worker" });
  });

  it("does not compose caller-supplied role-first titles", () => {
    const leadTitle = managedPaneTitle(
      "brainlayerClaude-ab12cd34",
      "surface:3",
      "cmuxlayer-LEAD · review Codex output",
    );
    const workerTitle = managedPaneTitle(
      "cmuxlayerCodex-99887766",
      "surface:9",
      "  cmuxlayer-WORKER · pair with Claude  ",
    );

    expect(leadTitle).toBe(
      "cmuxlayer-LEAD · review Codex output",
    );
    expect(workerTitle).toBe(
      "  cmuxlayer-WORKER · pair with Claude  ",
    );
  });

  it("refuses a resume rename after the surface observer epoch changes", async () => {
    engine.dispose();
    const observerId = "cmux:/tmp/cmux.sock";
    let observerEpoch = `${observerId}@socket:1`;
    registry = new AgentRegistry(stateMgr, async () => liveSurfaces, {
      observerIdProvider: () => observerId,
      observerEpochProvider: () => observerEpoch,
    });
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts: { baseDir: TEST_DIR },
    });
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(
      makeRecord({
        state: "done",
        workspace_id: "ws:1",
        surface_id: "surface:old",
      }),
    );
    await registry.reconstitute();
    const updateRecord = stateMgr.updateRecord.bind(stateMgr);
    vi.spyOn(stateMgr, "updateRecord").mockImplementation((agentId, patch) => {
      const updated = updateRecord(agentId, patch);
      if (patch.surface_id === "surface:new") {
        observerEpoch = `${observerId}@socket:2`;
      }
      return updated;
    });

    await expect(engine.resumeAgent("cmuxlayerCodex-revive")).rejects.toThrow(
      /surface observer changed.*resume rename/i,
    );
    expect(mockClient.renameTab).not.toHaveBeenCalled();
    expect(mockClient.send).not.toHaveBeenCalled();
  });

  it("retains a recoverable crash row when its stale process is gone", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(
      makeRecord({
        state: "error",
        error: "Surface surface:revive disappeared",
        pid: 424242,
      }),
    );
    await registry.reconstitute();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });

    expect(engine.evictDeadProcessAgents()).toEqual([]);
    expect(stateMgr.readState("cmuxlayerCodex-revive")).not.toBeNull();
    killSpy.mockRestore();
  });

  it("retains a recoverable legacy crash row during startup purge", async () => {
    writeCodexSessionArtifact(harnessHome, CODEX_SESSION);
    stateMgr.writeState(
      makeRecord({
        state: "error",
        error: "Surface surface:revive disappeared",
        surface_observer_id: null,
      }),
    );
    registry = new AgentRegistry(stateMgr, async () => [], {
      observerId: "cmux:/tmp/prod.sock",
    });
    await registry.reconstitute();

    expect(registry.purgeAllTerminal()).toEqual([]);
    expect(stateMgr.readState("cmuxlayerCodex-revive")).not.toBeNull();
  });
});
