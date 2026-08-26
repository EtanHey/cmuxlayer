import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { AgentRecord } from "../src/agent-types.js";
import {
  ensureNodeMaxOldSpaceEnv,
  HEAP_GUARD_EXIT_CODE,
  installHeapGuard,
} from "../src/heap-guard.js";
import { readInbox } from "../src/inbox.js";
import { StateManager } from "../src/state-manager.js";

const TEST_DIR = join(
  process.cwd(),
  "docs.local",
  "scratch",
  "run7",
  "env-seam-test",
);

const ENV_KEYS = [
  "CMUXLAYER_HEAP_GUARD_BYTES",
  "CMUXLAYER_NODE_MAX_OLD_SPACE_MB",
  "CMUXLAYER_POST_SPAWN_LIVENESS_MS",
  "CMUXLAYER_HALT_WEDGED_DWELL_MS",
  "CMUXLAYER_HALT_WEDGED_SWEEPS",
  "CMUXLAYER_STOP_POST_CONDITION_TIMEOUT_MS",
  "NODE_OPTIONS",
] as const;

function record(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "env-seam-worker",
    surface_id: "surface:env-seam-worker",
    state: "working",
    repo: "cmuxlayer",
    model: "gpt-5.6-sol",
    cli: "codex",
    cli_session_id: null,
    task_summary: "exercise production environment seams",
    pid: null,
    version: 0,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    user_killed: false,
    ...overrides,
  };
}

function client(screenBySurface: Record<string, string> = {}) {
  return {
    getTransportHealth: () => ({ mode: "socket", degraded: false }),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    readScreen: vi.fn(async (surface: string) => ({
      surface,
      text: screenBySurface[surface] ?? "$ ",
      lines: 80,
      scrollback_used: false,
    })),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    newSplit: vi.fn(),
    newSurface: vi.fn(),
    renameTab: vi.fn().mockResolvedValue(undefined),
    focusSurface: vi.fn().mockResolvedValue(undefined),
    selectWorkspace: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    moveSurface: vi.fn(),
  };
}

describe("production environment seams", () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("uses heap and old-space environment limits in their runtime guards", () => {
    process.env.CMUXLAYER_HEAP_GUARD_BYTES = "1500";
    process.env.CMUXLAYER_NODE_MAX_OLD_SPACE_MB = "321";
    delete process.env.NODE_OPTIONS;
    let tick: (() => void) | undefined;
    const exit = vi.fn();

    installHeapGuard({
      memoryUsage: () => ({ heapUsed: 1_100, rss: 1_600 }),
      log: vi.fn(),
      exit,
      setIntervalFn: (callback) => {
        tick = callback;
        return "env-seam-timer";
      },
      clearIntervalFn: vi.fn(),
    });
    tick?.();
    ensureNodeMaxOldSpaceEnv();

    expect(exit).toHaveBeenCalledWith(HEAP_GUARD_EXIT_CODE);
    expect(process.env.NODE_OPTIONS).toBe("--max-old-space-size=321");
  });

  it("delays the post-spawn liveness assertion by the configured interval", async () => {
    vi.useFakeTimers();
    process.env.CMUXLAYER_POST_SPAWN_LIVENESS_MS = "25";
    const state = new StateManager(TEST_DIR);
    const worker = record({ state: "booting" });
    state.writeState(worker);
    const registry = new AgentRegistry(state, async () => []);
    const engine = new AgentEngine(state, registry, client() as never);

    (engine as unknown as { schedulePostSpawnLivenessAssertion(id: string): void })
      .schedulePostSpawnLivenessAssertion(worker.agent_id);
    await vi.advanceTimersByTimeAsync(24);
    expect(state.readState(worker.agent_id)?.quality).toBe("unknown");
    await vi.advanceTimersByTimeAsync(1);
    expect(state.readState(worker.agent_id)).toMatchObject({
      quality: "degraded",
      error: expect.stringContaining("Post-spawn liveness failed"),
    });
    engine.dispose();
  });

  it("requires both configured wedge dwell and sweep observations before escalating", async () => {
    process.env.CMUXLAYER_HALT_WEDGED_DWELL_MS = "1000";
    process.env.CMUXLAYER_HALT_WEDGED_SWEEPS = "3";
    let now = Date.parse("2026-08-26T00:00:00.000Z");
    const state = new StateManager(TEST_DIR);
    const parent = record({
      agent_id: "env-seam-parent",
      surface_id: "surface:env-seam-parent",
      role: "orchestrator",
    });
    const worker = record({ parent_agent_id: parent.agent_id, spawn_depth: 1 });
    state.writeState(parent);
    state.writeState(worker);
    const activeScreen = "OpenAI Codex\nWorking (2s • esc to interrupt)";
    const surfaces = [parent, worker].map((agent) => ({
      ref: agent.surface_id,
      title: "",
      type: "terminal" as const,
      index: 0,
      selected: false,
    }));
    const registry = new AgentRegistry(state, async () => surfaces);
    await registry.reconstitute();
    const engine = new AgentEngine(
      state,
      registry,
      client({
        [parent.surface_id]: activeScreen,
        [worker.surface_id]: activeScreen,
      }) as never,
      { haltNow: () => now, inboxOpts: { baseDir: TEST_DIR } },
    );
    const escalate = () =>
      (engine as unknown as {
        maybeEscalateLiveHalt(agent: AgentRecord, screen: string): Promise<AgentRecord>;
      }).maybeEscalateLiveHalt(
        engine.getAgentState(worker.agent_id) as AgentRecord,
        activeScreen,
      );

    await escalate();
    now += 500;
    await escalate();
    now += 501;
    await escalate();
    expect(readInbox(parent.agent_id, { baseDir: TEST_DIR })).toEqual([]);
    await escalate();
    expect(
      readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter(
        (message) => message.tag === "agent_halt_wedged",
      ),
    ).toHaveLength(1);
    engine.dispose();
  });

  it("bounds stop post-condition polling with the configured timeout", async () => {
    vi.useFakeTimers();
    process.env.CMUXLAYER_STOP_POST_CONDITION_TIMEOUT_MS = "100";
    const state = new StateManager(TEST_DIR);
    const registry = new AgentRegistry(state, async () => []);
    const engine = new AgentEngine(state, registry, client() as never);
    const readCondition = vi.fn().mockResolvedValue({
      processGone: false,
      surfaceGone: false,
      paneGone: false,
      paneRef: "pane:env-seam",
    });
    (engine as unknown as { readStopPostCondition: typeof readCondition })
      .readStopPostCondition = readCondition;
    const wait = (
      engine as unknown as {
        waitForStopPostCondition(
          agent: AgentRecord,
          paneRef: string,
          expectPaneGone: boolean,
          treatUnknownProcessAsGone: boolean,
        ): Promise<unknown>;
      }
    ).waitForStopPostCondition(record({}), "pane:env-seam", true, false);

    await vi.advanceTimersByTimeAsync(99);
    expect(readCondition).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(readCondition).toHaveBeenCalledTimes(3);
    engine.dispose();
  });
});
