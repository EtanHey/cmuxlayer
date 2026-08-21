import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { LiveAgentState } from "../src/live-agent-state.js";
import {
  resolveLiveAgentState,
  screenConfirmedAgentState,
} from "../src/live-agent-state.js";
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

const RESTING_CODEX_SCREEN = [
  ">_ OpenAI Codex",
  "› Ask Codex to do anything",
  "",
  "gpt-5.6-sol high · ~/Gits/cmuxlayer",
].join("\n");

type TestEngineClient = CmuxClient & {
  notifyLifecycleEvent: ReturnType<typeof vi.fn>;
};

function makeMockClient(overrides?: Partial<CmuxClient>): TestEngineClient {
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
    // A complete topology: terminal I/O refuses to read a surface it cannot
    // prove is live and uniquely bound, so a suite that asserts on screen
    // reads has to describe the pane the record points at.
    listWorkspaces: vi.fn().mockResolvedValue({
      workspaces: [
        {
          ref: "workspace:fleet",
          title: "Fleet",
          index: 0,
          selected: true,
          pinned: false,
        },
      ],
    }),
    listPanes: vi.fn().mockResolvedValue({
      workspace_ref: "workspace:fleet",
      window_ref: "window:fleet",
      panes: [
        {
          ref: "pane:fleet",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: ["surface:worker"],
        },
      ],
    }),
    listPaneSurfaces: vi.fn().mockResolvedValue({
      workspace_ref: "workspace:fleet",
      window_ref: "window:fleet",
      pane_ref: "pane:fleet",
      surfaces: [
        {
          id: "uuid-worker",
          ref: "surface:worker",
          title: "cmuxlayerClaude",
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    }),
    selectWorkspace: vi.fn(),
    clearStatus: vi.fn(),
    setProgress: vi.fn(),
    clearProgress: vi.fn(),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
    log: vi.fn(),
    notifyLifecycleEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TestEngineClient;
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

/** A Codex pane at rest: the screen says idle while live state normalises ready. */
const restingCodexProbe = (agent: AgentRecord) =>
  resolveLiveAgentState(agent, {
    status: "idle",
    agent_type: "codex",
    control_state: "ready",
  });

describe("F1b #473 — wait_for terminates on live state, never on a contradicted record", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const buildEngine = (client?: TestEngineClient): void => {
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

  it("matches target idle immediately when a Codex agent is already resting at ready", async () => {
    stateMgr.writeState(makeRecord({ state: "ready", cli: "codex" }));
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(restingCodexProbe);

    const result = await engine.waitFor(
      "voicelayerClaude-2ac0d960",
      "idle",
      20_000,
    );

    expect(result.matched).toBe(true);
    expect(result.state).toBe("ready");
    expect(result.source).toBe("immediate");
    expect(result.elapsed).toBeLessThan(1_000);
  });

  it("matches final resting evidence instead of timing out beside an idle observation", async () => {
    vi.useFakeTimers();
    engine.dispose();
    buildEngine(
      makeMockClient({
        readScreen: vi.fn().mockResolvedValue({
          surface: "surface:worker",
          text: RESTING_CODEX_SCREEN,
          lines: 30,
          scrollback_used: false,
        }),
      } as Partial<CmuxClient>),
    );
    liveSurfaces = [{ ...makeSurface("surface:worker"), id: "uuid-worker" }];
    stateMgr.writeState(
      makeRecord({
        state: "working",
        cli: "codex",
        surface_uuid: "uuid-worker",
      }),
    );
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(workingScreenProbe);
    // The live resolver remains stale-working even after the final direct
    // screen read sees rest. The screen-backed transition must win.
    const freshProbe = vi.fn(async (agent: AgentRecord) =>
      workingScreenProbe(agent),
    );
    engine.setFreshLiveStateProbe(freshProbe);

    const pending = engine.waitFor(
      "voicelayerClaude-2ac0d960",
      "idle",
      500,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await pending;

    expect(result.matched).toBe(true);
    expect(result.state).toBe("idle");
    expect(result.source).toBe("screen");
    expect(result.agent?.state).toBe("idle");
    expect(result.error).toBeUndefined();
  });
});

describe("F1b #472 — a watch arms on any observable agent", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const buildEngine = (client?: TestEngineClient): void => {
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
    let error: WatchArmError | null = null;
    try {
      await engine.armWatch(spec("idle"));
    } catch (caught) {
      error = caught as WatchArmError;
    }
    if (!error) throw new Error("Expected watch arm to fail");
    expect(error.message).not.toContain("does not exist");
    expect(error.message).toContain("voicelayerClaude-2ac0d960");
    expect(error.message).toMatch(/no registry or state record/i);
  });
});


/**
 * The cold discovery cache, modelled honestly.
 *
 * `screenObservationForRecord` reads `discovery.cachedScan()`, which returns
 * null once the scan is 2000ms old — so the SYNC resolver's ordinary answer on
 * the `wait_for` path is "no evidence", not "working". A probe that returns
 * live evidence forever models the resolver's shape and never its availability,
 * which is how round 1 shipped a fix that reproduced the original bug live.
 */
const coldSyncResolver = (agent: AgentRecord): LiveAgentState =>
  resolveLiveAgentState(agent, null);

/** A sync resolver that goes cold after N calls, as the real cache does. */
function coldAfter(calls: number): {
  resolve: (agent: AgentRecord) => LiveAgentState;
  calls: () => number;
} {
  let seen = 0;
  return {
    resolve: (agent) => {
      seen += 1;
      return seen <= calls ? workingScreenProbe(agent) : coldSyncResolver(agent);
    },
    calls: () => seen,
  };
}

/** The forcing probe: what a real single-surface screen read would return. */
const workingFreshProbe = async (
  agent: AgentRecord,
): Promise<LiveAgentState> => workingScreenProbe(agent);

describe("F1b round 2 — the wait buys its own evidence instead of hoping the cache is warm", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const buildEngine = (client?: TestEngineClient): void => {
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

  it("blocks with a COLD cache at entry — the reported bug, byte for byte", async () => {
    vi.useFakeTimers();
    stateMgr.writeState(makeRecord({ state: "done" }));
    await engine.getRegistry().reconstitute();
    // Nothing scanned recently: the sync resolver has no evidence at all.
    engine.setLiveStateResolver(coldSyncResolver);
    engine.setFreshLiveStateProbe(workingFreshProbe);

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.source).toBe("timeout");
    expect(result.elapsed).toBeGreaterThanOrEqual(1_500);
    expect(result.state).toBe("working");
    expect(result.error).not.toBe("Agent has already completed");
  });

  it("blocks when the cache goes cold mid-wait, not just at entry", async () => {
    vi.useFakeTimers();
    stateMgr.writeState(makeRecord({ state: "done" }));
    await engine.getRegistry().reconstitute();
    const resolver = coldAfter(1);
    engine.setLiveStateResolver(resolver.resolve);
    engine.setFreshLiveStateProbe(workingFreshProbe);

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 3_500);
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await pending;

    expect(result.source).toBe("timeout");
    expect(result.state).toBe("working");
  });

  it("forces one read at entry and then only on the declared cadence", async () => {
    vi.useFakeTimers();
    stateMgr.writeState(makeRecord({ state: "done" }));
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(coldSyncResolver);
    const probe = vi.fn(workingFreshProbe);
    engine.setFreshLiveStateProbe(probe);

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 4_500);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    // Entry + one per 2000ms of a 4500ms wait: bounded and countable, not
    // one screen read per 1000ms tick.
    expect(probe.mock.calls.length).toBeLessThanOrEqual(4);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("still short-circuits with a cold cache and NO forcing probe", async () => {
    stateMgr.writeState(makeRecord({ state: "done" }));
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(coldSyncResolver);

    const result = await engine.waitFor(
      "voicelayerClaude-2ac0d960",
      "idle",
      1_500,
    );

    // Unprobed, no evidence exists anywhere: the record stands, unchanged.
    expect(result.source).toBe("immediate");
    expect(result.state).toBe("done");
  });

  it("renders closure:pending — never artifact_missing — for a working child on a cold cache", async () => {
    vi.useFakeTimers();
    stateMgr.writeState(
      makeRecord({
        state: "done",
        report_path: "/tmp/report.md",
        done_marker: "DONE_WORKER",
      }),
    );
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(coldSyncResolver);
    engine.setFreshLiveStateProbe(workingFreshProbe);
    const record = engine.getAgentState("voicelayerClaude-2ac0d960");
    if (!record) throw new Error("fixture record missing");

    // Cold, before the wait. Round 3 also made this `pending` -- with no
    // evidence anywhere, a bare `done` record may not fire the alarm either --
    // so what this test now pins is the STATE half: the wait's own evidence.
    expect(engine.assessHarvestability(record).closure).toBe("pending");

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    // P11 Contract B: the closure the lead reads in the wait's own reply is
    // computed from the evidence that wait bought. Two fields of one payload
    // must not disagree about whether the child is working.
    expect(result.state).toBe("working");
    expect(engine.assessHarvestability(record).closure).toBe("pending");
  });

  it("expires forced evidence rather than answering from a stale observation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
    stateMgr.writeState(makeRecord({ state: "done" }));
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(coldSyncResolver);
    engine.setFreshLiveStateProbe(workingFreshProbe);
    const record = engine.getAgentState("voicelayerClaude-2ac0d960");
    if (!record) throw new Error("fixture record missing");

    await engine.refreshLiveState(record);
    expect(engine.liveStateOf(record).state).toBe("working");

    vi.setSystemTime(new Date("2026-08-19T10:00:03.000Z"));
    // Three seconds later the observation is older than the discovery TTL, so
    // it stops speaking for the agent instead of aging into a new lie.
    expect(engine.liveStateOf(record).state).toBe("done");
  });
});

describe("F1b round 2 — finding B: the ready-evidence gate no longer reads the raw record", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const buildEngine = (readScreen: ReturnType<typeof vi.fn>): void => {
    stateMgr = new StateManager(TEST_DIR);
    // A UUID-bound surface: terminal I/O refuses a UUID-less ref it cannot
    // prove ownership of, and this suite is about whether the read HAPPENS.
    liveSurfaces = [{ ...makeSurface("surface:worker"), id: "uuid-worker" }];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(
      stateMgr,
      registry,
      makeMockClient({ readScreen } as Partial<CmuxClient>),
      {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      },
    );
  };

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reads the screen for a working record whose live state agrees", async () => {
    vi.useFakeTimers();
    const readScreen = vi.fn().mockResolvedValue({
      surface: "surface:worker",
      text: WORKING_SCREEN,
      lines: 30,
      scrollback_used: false,
    });
    buildEngine(readScreen);
    stateMgr.writeState(
      makeRecord({ state: "working", surface_uuid: "uuid-worker" }),
    );
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(workingScreenProbe);

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(readScreen).toHaveBeenCalled();
  });

  it("does not buy a screen read for a transition the record cannot make", async () => {
    vi.useFakeTimers();
    const readScreen = vi.fn().mockResolvedValue({
      surface: "surface:worker",
      text: WORKING_SCREEN,
      lines: 30,
      scrollback_used: false,
    });
    buildEngine(readScreen);
    // `VALID_TRANSITIONS.done` is empty: no screen can move this record to
    // idle, so the widened gate must not spend a read per tick trying.
    stateMgr.writeState(
      makeRecord({ state: "done", surface_uuid: "uuid-worker" }),
    );
    await engine.getRegistry().reconstitute();
    engine.setLiveStateResolver(workingScreenProbe);

    const pending = engine.waitFor("voicelayerClaude-2ac0d960", "idle", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(readScreen).not.toHaveBeenCalled();
    // Fails safe: a timeout, never a false completion. Closing the other half
    // means #408 stopping the poisoning, which is not this lane.
    expect(result.source).toBe("timeout");
    expect(result.matched).toBe(false);
  });
});

describe("F1b — a watch still refuses when the surface is positively gone", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const buildEngine = (screenText: string): void => {
    stateMgr = new StateManager(TEST_DIR);
    liveSurfaces = [makeSurface("surface:worker")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(
      stateMgr,
      registry,
      makeMockClient({
        readScreen: vi.fn().mockResolvedValue({
          surface: "surface:worker",
          text: screenText,
          lines: 30,
          scrollback_used: false,
        }),
      } as Partial<CmuxClient>),
      {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
        watchRegistryPath: registryPath(),
        watchRegistryNow: () => 1_000,
      },
    );
  };

  const spec = {
    owner: "voiceClaude",
    target: "voicelayerClaude-2ac0d960",
    predicate: "idle" as const,
    deadline: 60_000,
  };

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("refuses a bare shell, naming it — existence did not become unconditional", async () => {
    buildEngine("etanheyman@Mac cmuxlayer % \n");
    stateMgr.writeState(makeRecord({ state: "working" }));
    await engine.getRegistry().reconstitute();

    const error = await engine
      .armWatch(spec)
      .then(() => null)
      .catch((e: WatchArmError) => e);

    expect(error?.code).toBe("watch_target_missing");
    expect(error?.message).toMatch(/bare shell/i);
    expect(error?.message).not.toContain("does not exist");
  });
});



/** A fresh agent sitting at a live prompt, waiting for its first instruction. */
const readyScreenProbe = (agent: AgentRecord): LiveAgentState =>
  resolveLiveAgentState(agent, {
    status: "idle",
    agent_type: "claude",
    control_state: "ready",
  });

describe("F1b round 3 — one row, one state rule: closure cannot contradict the state beside it", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  const buildEngine = (): void => {
    stateMgr = new StateManager(TEST_DIR);
    liveSurfaces = [makeSurface("surface:worker")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, makeMockClient(), {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
    });
  };

  const contractRecord = (overrides?: Partial<AgentRecord>): AgentRecord =>
    makeRecord({
      report_path: join(TEST_DIR, "report.md"),
      done_marker: "DONE_WORKER",
      ...overrides,
    });

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

  it("shape 1 — a READY agent whose record flipped done reads pending, not artifact_missing", () => {
    // golemsClaude's live specimen: five agents, one spawned two minutes
    // earlier, all on v0.4.47 with the F1 fix present. The screen said `ready`,
    // the row said `ready`, and the closure beside it said `artifact_missing`.
    stateMgr.writeState(contractRecord({ state: "done" }));
    const record = stateMgr.readState("voicelayerClaude-2ac0d960");
    if (!record) throw new Error("fixture record missing");
    engine.setLiveStateResolver(readyScreenProbe);

    const harvest = engine.assessHarvestability(record);

    expect(harvest.closure).toBe("pending");
    // And it says why, in the field that was already in the payload.
    expect(harvest.evidence_channel.done_source).toBe("none");
  });

  it("shape 2 — a WORKING agent on a cold cache reads pending, not artifact_missing", () => {
    // Same alarm, different root: no live evidence at all, so the record's
    // bare `done` is the only thing speaking. It still must not fire the alarm.
    stateMgr.writeState(contractRecord({ state: "done" }));
    const record = stateMgr.readState("voicelayerClaude-2ac0d960");
    if (!record) throw new Error("fixture record missing");
    engine.setLiveStateResolver((agent) => resolveLiveAgentState(agent, null));

    expect(engine.assessHarvestability(record).closure).toBe("pending");
  });

  it("the deadlock alarm SURVIVES for a worker that earned its done", () => {
    // The other half of the contract: a finished worker sits at a ready prompt
    // too. With real done evidence and no report, `artifact_missing` must still
    // fire -- otherwise this change trades a false alarm for a silent one.
    stateMgr.writeState(
      contractRecord({
        state: "done",
        task_done_detected_at: "2026-08-19T10:05:00.000Z",
      }),
    );
    const record = stateMgr.readState("voicelayerClaude-2ac0d960");
    if (!record) throw new Error("fixture record missing");
    engine.setLiveStateResolver(readyScreenProbe);

    const harvest = engine.assessHarvestability(record);

    expect(harvest.closure).toBe("artifact_missing");
    expect(harvest.evidence_channel.done_source).toBe("screen");
  });

  it("a screen showing work in progress still outranks an earned done", () => {
    // Ordering check: evidence that the agent is working NOW beats evidence
    // that it finished earlier — a re-tasked worker is not a deadlocked one.
    stateMgr.writeState(
      contractRecord({
        state: "done",
        task_done_detected_at: "2026-08-19T10:05:00.000Z",
      }),
    );
    const record = stateMgr.readState("voicelayerClaude-2ac0d960");
    if (!record) throw new Error("fixture record missing");
    engine.setLiveStateResolver(workingScreenProbe);

    expect(engine.assessHarvestability(record).closure).toBe("pending");
  });

  it("closure agrees with the state the same response reports", () => {
    // The row publishes `reconciled_state ?? record.state`, derived from
    // `screenConfirmedAgentState`. Closure now reads the same value, so the two
    // fields of one row cannot disagree about whether the agent is done.
    stateMgr.writeState(contractRecord({ state: "done" }));
    const record = stateMgr.readState("voicelayerClaude-2ac0d960");
    if (!record) throw new Error("fixture record missing");
    engine.setLiveStateResolver(readyScreenProbe);

    const rowState =
      screenConfirmedAgentState({
        status: "idle",
        agent_type: "claude",
        control_state: "ready",
      }) ?? record.state;

    expect(rowState).toBe("ready");
    expect(engine.assessHarvestability(record).closure).toBe("pending");
  });
});
