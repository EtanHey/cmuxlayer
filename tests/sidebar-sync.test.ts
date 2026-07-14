/**
 * TDD tests for Task 17 — Sidebar Sync.
 * Tests syncSidebar(), runSweep(), and lifecycle log events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface, CmuxNewSplitResult } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-sidebar");

function makeMockClient(overrides?: Partial<CmuxClient>): CmuxClient {
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
  } as unknown as CmuxClient;
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
  let mockClient: CmuxClient;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("calls setStatus for an active agent with state-derived icon and color", async () => {
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

    expect(mockClient.setStatus).toHaveBeenCalledWith(
      "a1",
      "brainlayer: working",
      expect.objectContaining({
        icon: "bolt.fill",
        color: "#3B82F6",
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
      expect.objectContaining({ level: "info", source: "cmux-mcp" }),
    );
    expect((mockClient as any).notifyLifecycleEvent).toHaveBeenCalledWith(
      "spawned",
      expect.objectContaining({
        agent_id: "a1",
        repo: "brainlayer",
        state: "working",
      }),
    );
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
      expect.objectContaining({ level: "success", source: "cmux-mcp" }),
    );
    expect((mockClient as any).notifyLifecycleEvent).toHaveBeenCalledWith(
      "done",
      expect.objectContaining({
        agent_id: "a1",
        repo: "brainlayer",
        state: "done",
      }),
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
      expect.objectContaining({ level: "error", source: "cmux-mcp" }),
    );
    expect((mockClient as any).notifyLifecycleEvent).toHaveBeenCalledWith(
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

    const channelCalls = (
      (mockClient as any).notifyLifecycleEvent as ReturnType<typeof vi.fn>
    ).mock.calls;
    const spawnedChannelCalls = channelCalls.filter((c) => c[0] === "spawned");
    expect(spawnedChannelCalls).toHaveLength(1);
    const doneChannelCalls = channelCalls.filter((c) => c[0] === "done");
    expect(doneChannelCalls).toHaveLength(1);
  });
});

describe("Booting agent advancement (SDLC-87)", () => {
  let stateMgr: StateManager;
  let mockClient: CmuxClient;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const IDLE_CLAUDE_SCREEN = {
    surface: "surface:42",
    text: `
  Say "go" when you're ready and I'll start your timer.

──────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────
  ⎇ master | +1273,-196 | 🔧 11                                           418310 tokens
  🤖 Sonnet 4.6 | 💰 $0.10                                    current: 2.1.81 · latest…
  ⏵⏵ bypass permissions on (shift+tab to cycle)
`,
    lines: 40,
    scrollback_used: false,
  };

  const WORKING_CLAUDE_SCREEN = {
    surface: "surface:42",
    text: `
  Working on it…
  ⏵⏵ bypass permissions on (shift+tab to cycle)
  (esc to interrupt)
`,
    lines: 40,
    scrollback_used: false,
  };

  const UNKNOWN_SCREEN = {
    surface: "surface:42",
    text: "$ ",
    lines: 40,
    scrollback_used: false,
  };

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    liveSurfaces = [];
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {},
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("promotes a booting agent to ready and delivers the stored prompt once the CLI is interactive", async () => {
    let calls = 0;
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        calls += 1;
        return calls === 1 ? IDLE_CLAUDE_SCREEN : WORKING_CLAUDE_SCREEN;
      },
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "booting",
        surface_id: "surface:42",
        model: "sonnet",
        task_summary: "design handoff",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    const record = engine.getAgentState("a1");
    expect(record?.state).toBe("ready");
    expect(record?.parsed_model).toBe("Sonnet 4.6");
    expect(record?.model_mismatch).toBe(false);
    expect(record?.prompt_delivered).toBe(true);
    expect(record?.submit_verified).toBe(true);
    expect(mockClient.send).toHaveBeenCalledWith(
      "surface:42",
      "design handoff",
    );
    expect(mockClient.sendKey).toHaveBeenCalledWith("surface:42", "return");
  });

  it("reports a model mismatch when the parsed banner model disagrees with the requested model", async () => {
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue(
      IDLE_CLAUDE_SCREEN,
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "booting",
        surface_id: "surface:42",
        model: "opus",
        task_summary: "design handoff",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    const record = engine.getAgentState("a1");
    expect(record?.state).toBe("ready");
    expect(record?.parsed_model).toBe("Sonnet 4.6");
    expect(record?.model_mismatch).toBe(true);
  });

  it("reports a stuck-booting agent as errored once it exceeds the boot timeout", async () => {
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue(
      UNKNOWN_SCREEN,
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "booting",
        surface_id: "surface:42",
        updated_at: "2020-01-01T00:00:00Z",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    const record = engine.getAgentState("a1");
    expect(record?.state).toBe("error");
    expect(record?.error).toMatch(/stuck booting/i);
    expect(mockClient.log).toHaveBeenCalledWith(
      "errored: brainlayer",
      expect.objectContaining({ level: "error", source: "cmux-mcp" }),
    );
  });

  it("leaves a booting agent untouched while still within the boot window with no interactive signal", async () => {
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue(
      UNKNOWN_SCREEN,
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "booting",
        surface_id: "surface:42",
        updated_at: new Date().toISOString(),
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(engine.getAgentState("a1")?.state).toBe("booting");
  });

  it("does not advance auto-discovered agents", async () => {
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue(
      IDLE_CLAUDE_SCREEN,
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "auto-brainlayer-1",
        state: "booting",
        surface_id: "surface:42",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    expect(engine.getAgentState("auto-brainlayer-1")?.state).toBe("booting");
    expect(mockClient.send).not.toHaveBeenCalled();
  });

  it("keeps a booting agent retry-safe (not stranded ready) when prompt delivery throws", async () => {
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue(
      IDLE_CLAUDE_SCREEN,
    );
    (mockClient.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("socket dropped mid-send"),
    );
    stateMgr.writeState(
      makeRecord({
        agent_id: "a1",
        state: "booting",
        surface_id: "surface:42",
        model: "sonnet",
        task_summary: "design handoff",
      }),
    );
    liveSurfaces = [makeSurface("surface:42")];
    await engine.getRegistry().reconstitute();

    await engine.runSweep();

    // A transient send failure must not persist "ready" ahead of delivery —
    // otherwise the top-of-function "state !== booting" guard would skip
    // this agent on every future sweep and the prompt would never be
    // retried (SDLC-87 Codex review finding).
    const afterFailure = engine.getAgentState("a1");
    expect(afterFailure?.state).toBe("booting");
    expect(afterFailure?.prompt_delivered).not.toBe(true);

    // Next sweep, with the transient failure resolved, must retry and
    // succeed rather than being permanently skipped.
    (mockClient.readScreen as ReturnType<typeof vi.fn>).mockResolvedValue(
      WORKING_CLAUDE_SCREEN,
    );
    await engine.runSweep();

    const afterRetry = engine.getAgentState("a1");
    expect(afterRetry?.state).toBe("ready");
    expect(afterRetry?.prompt_delivered).toBe(true);
    expect(mockClient.send).toHaveBeenCalledTimes(2);
  });
});
