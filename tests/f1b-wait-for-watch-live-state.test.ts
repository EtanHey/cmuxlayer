import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxClient } from "../src/cmux-client.js";
import { resolveLiveAgentState } from "../src/live-agent-state.js";
import { StateManager } from "../src/state-manager.js";
import { WatchArmError, readWatchRegistry } from "../src/watch-spec.js";
import type { CmuxSurface } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-f1b-wait-for-watch-live-state");
const registryPath = () => join(TEST_DIR, "watches.json");

/**
 * A Claude pane mid-turn: the exact live shape from the VoiceLayer report --
 * registry `done`, screen `working`.
 */
const WORKING_SCREEN = [
  "> brew install ffmpeg",
  "",
  "✻ Compiling… (esc to interrupt)",
  "",
  "╭──────────────────────────────────────────────╮",
  "│ >                                            │",
  "╰──────────────────────────────────────────────╯",
].join("\n");

function makeMockClient(overrides?: Partial<CmuxClient>): CmuxClient {
  return {
    newSplit: vi.fn(),
    newSurface: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:worker",
      text: WORKING_SCREEN,
      lines: 30,
      scrollback_used: false,
    }),
    renameTab: vi.fn(),
    setStatus: vi.fn(),
    closeSurface: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    selectWorkspace: vi.fn(),
    clearStatus: vi.fn(),
    setProgress: vi.fn(),
    clearProgress: vi.fn(),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
    log: vi.fn(),
    ...overrides,
  } as unknown as CmuxClient;
}

function makeSurface(ref: string): CmuxSurface {
  return { ref, title: "", type: "terminal", index: 0, selected: false };
}

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "voicelayerClaude-2ac0d960",
    surface_id: "surface:worker",
    state: "done",
    repo: "voicelayer",
    model: "opus",
    cli: "claude",
    cli_session_id: null,
    task_summary: "F1b live-state fixture",
    pid: null,
    version: 0,
    created_at: "2026-08-19T10:00:00.000Z",
    updated_at: "2026-08-19T10:01:00.000Z",
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

/** The server's live probe, standing in for a fresh screen scan. */
const workingScreenProbe = (agent: AgentRecord) =>
  resolveLiveAgentState(agent, {
    status: "working",
    agent_type: "claude",
    control_state: "busy",
  });

describe("F1b #473 — wait_for terminates on live state, never on a contradicted record", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const buildEngine = (client?: CmuxClient): void => {
    stateMgr = new StateManager(TEST_DIR);
    liveSurfaces = [makeSurface("surface:worker")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, client ?? makeMockClient(), {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      watchRegistryPath: registryPath(),
      watchRegistryNow: () => 1_000,
    });
  };

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    buildEngine();
  });

  afterEach(() => {
    vi.useRealTimers();
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("blocks when the registry says done and the screen says working", async () => {
    vi.useFakeTimers();
    stateMgr.writeState(makeRecord({ state: "done" }));
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(workingScreenProbe);

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.matched).toBe(false);
    // The wait must NOT have short-circuited: it ran to its own deadline.
    expect(result.source).toBe("timeout");
    expect(result.elapsed).toBeGreaterThanOrEqual(1_500);
    // Top-level state is the reconciled value, not the poisoned record.
    expect(result.state).toBe("working");
    expect(result.error).not.toBe("Agent has already completed");
  });

  it("blocks when the registry says error and the screen says working", async () => {
    vi.useFakeTimers();
    stateMgr.writeState(
      makeRecord({ state: "error", error: "stale registry error" }),
    );
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(workingScreenProbe);

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.matched).toBe(false);
    expect(result.source).toBe("timeout");
    expect(result.state).toBe("working");
    expect(result.error).not.toBe("stale registry error");
  });

  it("still short-circuits on a recorded done when no live evidence contradicts it", async () => {
    stateMgr.writeState(makeRecord({ state: "done" }));
    await engine.getRegistry().reconstitute();

    const result = await engine.waitFor(
      "voicelayerClaude-2ac0d960",
      "idle",
      1_500,
    );

    expect(result.matched).toBe(false);
    expect(result.source).toBe("immediate");
    expect(result.state).toBe("done");
    expect(result.error).toBe("Agent has already completed");
  });

  it("does not report a match from a record state the screen contradicts", async () => {
    vi.useFakeTimers();
    stateMgr.writeState(makeRecord({ state: "idle" }));
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(workingScreenProbe);

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.matched).toBe(false);
    expect(result.state).toBe("working");
  });
});

describe("F1b #472 — a watch arms on any observable agent", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const buildEngine = (client?: CmuxClient): void => {
    stateMgr = new StateManager(TEST_DIR);
    liveSurfaces = [makeSurface("surface:worker")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, client ?? makeMockClient(), {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      watchRegistryPath: registryPath(),
      watchRegistryNow: () => 1_000,
    });
  };

  const spec = (predicate: "idle" | "working" | "done") => ({
    owner: "voiceClaude",
    target: "voicelayerClaude-2ac0d960",
    predicate,
    deadline: 60_000,
  });

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("arms against an agent the in-memory registry has not reconstituted", async () => {
    buildEngine();
    // Written to disk, never reconstituted: exactly the divergence that made
    // the watch path deny an agent `send_to` was delivering to.
    stateMgr.writeState(makeRecord({ state: "working" }));
    expect(engine.getRegistry().get("voicelayerClaude-2ac0d960")).toBeNull();

    const watch = await engine.armWatch(spec("idle"));

    expect(watch.state).toBe("armed");
    expect(watch.target).toBe("voicelayerClaude-2ac0d960");
  });

  it("retries once and arms when the screen read fails", async () => {
    const readScreen = vi
      .fn()
      .mockRejectedValueOnce(new Error("surface busy"))
      .mockResolvedValue({
        surface: "surface:worker",
        text: WORKING_SCREEN,
        lines: 30,
        scrollback_used: false,
      });
    buildEngine(makeMockClient({ readScreen } as Partial<CmuxClient>));
    stateMgr.writeState(makeRecord({ state: "working" }));
    await engine.getRegistry().reconstitute();

    const watch = await engine.armWatch(spec("idle"));

    expect(readScreen).toHaveBeenCalledTimes(2);
    expect(watch.state).toBe("armed");
  });

  it("arms when the screen is unreadable, rather than calling the agent missing", async () => {
    const readScreen = vi.fn().mockRejectedValue(new Error("surface busy"));
    buildEngine(makeMockClient({ readScreen } as Partial<CmuxClient>));
    stateMgr.writeState(makeRecord({ state: "working" }));
    await engine.getRegistry().reconstitute();

    const watch = await engine.armWatch(spec("idle"));

    expect(watch.state).toBe("armed");
    expect(readScreen).toHaveBeenCalledTimes(2);
  });

  it("arms on a booting agent and leaves the predicate to resolve", async () => {
    const readScreen = vi.fn().mockResolvedValue({
      surface: "surface:worker",
      text: "\n\n",
      lines: 30,
      scrollback_used: false,
    });
    buildEngine(makeMockClient({ readScreen } as Partial<CmuxClient>));
    stateMgr.writeState(makeRecord({ state: "booting" }));
    await engine.getRegistry().reconstitute();

    const watch = await engine.armWatch(spec("idle"));
    expect(watch.state).toBe("armed");

    // An unparseable frame must not be read as an idle prompt: the watch
    // stays armed through a real sweep instead of firing on a booting pane.
    const swept = await engine.waitForWatch(spec("idle"), 150);
    expect(swept.matched).toBe(false);
    expect(swept.watch.state).toBe("armed");
    expect(
      readWatchRegistry({ registryPath: registryPath() }).watches.find(
        (row) => row.watch_id === watch.watch_id,
      )?.state,
    ).toBe("armed");
  });

  it("names what was observed when it must still refuse", async () => {
    buildEngine();

    await expect(engine.armWatch(spec("idle"))).rejects.toMatchObject({
      name: "WatchArmError",
      code: "watch_target_missing",
    });
    const error = await engine.armWatch(spec("idle")).catch((e) => e as WatchArmError);
    expect(error.message).not.toContain("does not exist");
    expect(error.message).toContain("voicelayerClaude-2ac0d960");
    expect(error.message).toMatch(/no registry or state record/i);
  });
});
