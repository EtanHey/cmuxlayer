/**
 * TDD tests for Task 17 — Sidebar Sync.
 * Tests syncSidebar(), runSweep(), and lifecycle log events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { ack, dispatch, writeHeartbeat } from "../src/inbox.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-sidebar");

type MockClient = CmuxClient & {
  notifyLifecycleEvent: ReturnType<typeof vi.fn>;
};

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
    notifyLifecycleEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MockClient;
}

function makeSurface(ref: string): CmuxSurface {
  return { ref, title: "", type: "terminal", index: 0, selected: false };
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

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    inboxOpts = { baseDir: join(TEST_DIR, "inbox") };
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
      inboxOpts,
    });
  });

  afterEach(() => {
    engine.dispose();
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

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "booting-agent",
      "brainlayer | role=worker | state=booting | health=healthy | blocked=- | last_prompt=Boot worker | worktree=- | branch=- | report=n/a | pr=n/a",
      expect.objectContaining({ workspace: "workspace:cmuxlayer" }),
    );
    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "working-agent",
      "brainlayer | role=worker | state=working | health=unhealthy(missing_cli_session_id,non_resumable) | blocked=- | last_prompt=Run worker | worktree=- | branch=- | report=n/a | pr=n/a",
      expect.objectContaining({ workspace: "workspace:cmuxlayer" }),
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
    expect(mockClient.setStatus).not.toHaveBeenCalledWith(
      "stale-done-agent",
      expect.any(String),
      expect.any(Object),
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

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "a1",
      "brainlayer | role=worker | state=working | health=healthy | blocked=- | last_prompt=Fix search gap F | worktree=- | branch=- | report=n/a | pr=n/a",
      expect.objectContaining({ surface: "surface:1" }),
    );
    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "a2",
      "brainlayer | role=worker | state=working | health=healthy | blocked=- | last_prompt=Fix search gap F | worktree=- | branch=- | report=n/a | pr=n/a",
      expect.objectContaining({ surface: "surface:2" }),
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

    const healthSummary = "unhealthy(stale_inbox_dispatches,agent_wedged)";
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

    expect(mockClient.notifyLifecycleEvent).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({ agent_id: agentId }),
      "healthy",
    );

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
      "brainlayer | role=worker | state=working | health=unhealthy(missing_cli_session_id,non_resumable) | blocked=- | last_prompt=Fix search gap F | worktree=- | branch=- | report=n/a | pr=n/a",
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
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
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
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
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

  it("calls setProgress with ratio of done to total agents", async () => {
    stateMgr.writeState(
      makeRecord({ agent_id: "a1", state: "done", surface_id: "surface:1" }),
    );
    stateMgr.writeState(
      makeRecord({ agent_id: "a2", state: "working", surface_id: "surface:2" }),
    );
    liveSurfaces = [makeSurface("surface:1"), makeSurface("surface:2")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(mockClient.setProgress).toHaveBeenCalledWith(
      0.5,
      expect.objectContaining({ label: "agents 1/2" }),
    );
  });

  it("logs spawned event on first sweep for each new agent", async () => {
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "working",
        surface_id: "surface:42",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
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
});
