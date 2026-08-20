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
import { inferAgentRole } from "../src/layout-policy.js";
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
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
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

  it("titles a managed pane with the agent id so a close is unambiguous", async () => {
    (mockClient.newSplit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      workspace: "ws:1",
      surface: "surface:worker-a",
      pane: "pane:1",
      title: "",
      type: "terminal",
    });

    const spawned = await engine.spawnAgent({
      repo: "cmuxlayer",
      cli: "codex",
      prompt: "lane work",
    });

    expect(mockClient.renameTab).toHaveBeenCalledWith(
      "surface:worker-a",
      expect.stringContaining(spawned.agent_id),
      { workspace: "ws:1" },
    );
  });

  it("keeps caller labels outside the launcher prefix used for role inference", () => {
    const leadTitle = managedPaneTitle(
      "brainlayerClaude-ab12cd34",
      "surface:3",
      "review Codex output",
    );
    const workerTitle = managedPaneTitle(
      "cmuxlayerCodex-99887766",
      "surface:9",
      "pair with Claude",
    );

    expect(leadTitle).toBe(
      "brainlayerClaude-ab12cd34 [surface:3]: review Codex output",
    );
    expect(workerTitle).toBe(
      "cmuxlayerCodex-99887766 [surface:9]: pair with Claude",
    );
    expect(inferAgentRole({ title: leadTitle })).toBe("orchestrator");
    expect(inferAgentRole({ title: workerTitle })).toBe("worker");
  });
});
