import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxClient } from "../src/cmux-client.js";
import { parseScreen } from "../src/screen-parser.js";
import { StateManager } from "../src/state-manager.js";
import type { CmuxSurface } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-wait-for-cursor");
const CURSOR_IDLE_SCREEN = readFileSync(
  join(process.cwd(), "tests/fixtures/cursor-2026-06-04-boot-ready.txt"),
  "utf8",
);
const CURSOR_DONE_SCREEN = readFileSync(
  join(process.cwd(), "tests/fixtures/cursor-2026-06-04-task-done.txt"),
  "utf8",
);

function makeMockClient(overrides?: Partial<CmuxClient>): CmuxClient {
  return {
    newSplit: vi.fn(),
    newSurface: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:cursor-idle",
      text: CURSOR_IDLE_SCREEN,
      lines: 80,
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
    agent_id: "cmuxlayerCursor-idle",
    surface_id: "surface:cursor-idle",
    state: "idle",
    repo: "cmuxlayer",
    model: "auto",
    cli: "cursor",
    cli_session_id: null,
    task_summary: "Cursor idle wait_for fixture",
    pid: null,
    version: 0,
    created_at: "2026-06-04T22:00:00.000Z",
    updated_at: "2026-06-04T22:01:00.000Z",
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

describe("wait_for Cursor terminal idle", () => {
  let stateMgr: StateManager;
  let engine: AgentEngine;
  let liveSurfaces: CmuxSurface[];

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    liveSurfaces = [makeSurface("surface:cursor-idle")];
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(stateMgr, registry, makeMockClient(), {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not resolve done from Cursor idle registry state without output evidence", async () => {
    vi.useFakeTimers();
    const parsed = parseScreen(CURSOR_IDLE_SCREEN);
    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("idle");

    stateMgr.writeState(makeRecord({ state: parsed.status }));
    await engine.getRegistry().reconstitute();

    const pending = engine.waitFor("cmuxlayerCursor-idle", "done", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.matched).toBe(false);
    expect(result.state).toBe("idle");
    expect(result.source).toBe("timeout");
    expect(result.agent).toMatchObject({
      agent_id: "cmuxlayerCursor-idle",
      state: "idle",
    });
  });

  it("resolves done from a Cursor screen with a done signal", async () => {
    vi.useFakeTimers();
    const candidateAt = new Date("2026-06-04T22:01:10.000Z");
    vi.setSystemTime(new Date(candidateAt.getTime() + 5_001));
    const parsed = parseScreen(CURSOR_DONE_SCREEN);
    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("done");
    expect(parsed.done_signal).toBe("TASK_DONE");

    engine.dispose();
    const registry = new AgentRegistry(stateMgr, async () => liveSurfaces);
    engine = new AgentEngine(
      stateMgr,
      registry,
      makeMockClient({
        readScreen: vi.fn().mockResolvedValue({
          surface: "surface:cursor-idle",
          text: CURSOR_DONE_SCREEN,
          lines: 80,
          scrollback_used: false,
        }),
      }),
      {
        spawnPreflight: async () => {},
        sessionIdentityResolver: () => null,
      },
    );

    stateMgr.writeState(
      makeRecord({
        state: "idle",
        task_done_candidate_at: candidateAt.toISOString(),
      }),
    );
    await engine.getRegistry().reconstitute();

    const pending = engine.waitFor("cmuxlayerCursor-idle", "done", 1_500);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.matched).toBe(true);
    expect(result.state).toBe("done");
    expect(result.source).toBe("screen");
    expect(result.agent).toMatchObject({
      agent_id: "cmuxlayerCursor-idle",
      state: "done",
    });
  });
});
