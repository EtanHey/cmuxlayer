import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { CmuxNewSplitResult } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-preflight");

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
    listPanes: vi.fn().mockResolvedValue({
      workspace_ref: "ws:1",
      window_ref: "window:1",
      panes: [],
    }),
    listPaneSurfaces: vi.fn().mockResolvedValue({
      workspace_ref: "ws:1",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [],
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
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
    log: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CmuxClient;
}

describe("spawn_agent launcher preflight", () => {
  let stateMgr: StateManager;
  let mockClient: CmuxClient;
  let engine: AgentEngine;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
    mockClient = makeMockClient();
    const registry = new AgentRegistry(stateMgr, async () => []);
    engine = new AgentEngine(stateMgr, registry, mockClient, {
      spawnPreflight: async () => {
        throw new Error(
          'Launcher "skill-creatorClaude" not found in PATH. Expected repoGolem launcher.',
        );
      },
    });
  });

  afterEach(() => {
    engine.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("fails before creating surfaces or state when the Claude launcher does not exist", async () => {
    await expect(
      engine.spawnAgent({
        repo: "skill-creator",
        model: "sonnet",
        cli: "claude",
        prompt: "design handoff",
      }),
    ).rejects.toThrow(/Launcher "skill-creatorClaude" not found/);

    expect(stateMgr.listStates()).toHaveLength(0);
    expect(engine.listAgents()).toHaveLength(0);
    expect(mockClient.newSplit).not.toHaveBeenCalled();
  });

  it("rejects an unknown Codex model from Codex's bundled model list before creating anything", async () => {
    const registryPath = join(TEST_DIR, "launchers.zsh");
    writeFileSync(
      registryPath,
      'repoGolem cmuxlayer "/Users/etanheyman/Gits/cmuxlayer"\n',
    );
    vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
    const defaultEngine = new AgentEngine(stateMgr, new AgentRegistry(stateMgr, async () => []), mockClient, {
      codexModelListRunner: async () => ({
        stdout: JSON.stringify({ models: [{ slug: "gpt-5.6-luna" }] }),
        stderr: "",
      }),
    });

    try {
      await expect(
        defaultEngine.spawnAgent({
          repo: "cmuxlayer",
          model: "gpt-9.9-totally-not-a-model",
          cli: "codex",
          prompt: "",
        }),
      ).rejects.toThrow(
        /Unsupported Codex model "gpt-9\.9-totally-not-a-model".*gpt-5\.6-luna.*No agent was spawned/s,
      );
      expect(mockClient.newSplit).not.toHaveBeenCalled();
      expect(stateMgr.listStates()).toHaveLength(0);
    } finally {
      defaultEngine.dispose();
      vi.unstubAllEnvs();
    }
  });
});
