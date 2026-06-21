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
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("resolves done promptly when a Cursor agent reaches its terminal idle state", async () => {
    const parsed = parseScreen(CURSOR_IDLE_SCREEN);
    expect(parsed.agent_type).toBe("cursor");
    expect(parsed.status).toBe("idle");

    stateMgr.writeState(makeRecord({ state: parsed.status }));
    await engine.getRegistry().reconstitute();

    const result = await engine.waitFor("cmuxlayerCursor-idle", "done", 50);

    expect(result.matched).toBe(true);
    expect(result.state).toBe("idle");
    expect(result.source).toBe("immediate");
    expect(result.agent).toMatchObject({
      agent_id: "cmuxlayerCursor-idle",
      state: "idle",
    });
  });
});
