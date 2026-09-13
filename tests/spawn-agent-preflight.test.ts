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

  it("rejects an unknown Codex model from Codex's account model list before creating anything", async () => {
    const registryPath = join(TEST_DIR, "launchers.zsh");
    writeFileSync(
      registryPath,
      'repoGolem cmuxlayer "/home/test-user/Gits/cmuxlayer"\n',
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

  // AIDEV-NOTE: the catalog stubs below are ARGS-AWARE on purpose. The bug was
  // which catalog we asked, so a stub that answers every call identically
  // cannot tell `debug models` from `debug models --bundled` and proves nothing.
  const catalogRunner =
    (account: string[] | "throws", bundled: string[] | "throws") =>
    async (args: string[]) => {
      const list = args.includes("--bundled") ? bundled : account;
      if (list === "throws") throw new Error("catalog unavailable (offline)");
      return {
        stdout: JSON.stringify({ models: list.map((slug) => ({ slug })) }),
        stderr: "",
      };
    };

  const spawnWith = async (
    runner: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
    model: string,
  ) => {
    const registryPath = join(TEST_DIR, "launchers.zsh");
    writeFileSync(
      registryPath,
      'repoGolem cmuxlayer "/home/test-user/Gits/cmuxlayer"\n',
    );
    vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
    const engine = new AgentEngine(
      stateMgr,
      new AgentRegistry(stateMgr, async () => []),
      mockClient,
      { codexModelListRunner: runner },
    );
    try {
      return await engine
        .spawnAgent({ repo: "cmuxlayer", model, cli: "codex", prompt: "" })
        .then(
          () => ({ ok: true as const, error: null }),
          (error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    } finally {
      engine.dispose();
      vi.unstubAllEnvs();
    }
  };

  it("accepts a model the ACCOUNT catalog lists even when the bundled list omits it", async () => {
    // The live specimen: gpt-5.3-codex-spark is in `codex debug models` with
    // medium supported, and absent from `--bundled`. Validating against
    // bundled made 100% of Etan's Spark quota unreachable at 3% general.
    const result = await spawnWith(
      catalogRunner(
        ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.3-codex-spark"],
        ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.4"],
      ),
      "gpt-5.3-codex-spark",
    );
    expect(result.error ?? "").not.toMatch(/Unsupported Codex model/);
  });

  it("rejects a model only the bundled list carries when the account catalog lacks it", async () => {
    // The other direction of the same defect: bundled green-lit models the
    // account does not have, which would only fail later, at runtime.
    const result = await spawnWith(
      catalogRunner(["gpt-6-astra", "gpt-5.6-sol"], ["gpt-6-astra", "gpt-5.4"]),
      "gpt-5.4",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unsupported Codex model "gpt-5\.4".*No agent was spawned/s);
    expect(mockClient.newSplit).not.toHaveBeenCalled();
  });

  it("does not invent a rejection from the bundled list when the account catalog is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await spawnWith(
        catalogRunner("throws", ["gpt-6-astra", "gpt-5.6-sol"]),
        "gpt-5.3-codex-spark",
      );
      expect(result.error ?? "").not.toMatch(/Unsupported Codex model/);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/bundled omission is not proof/),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("fails closed when neither catalog can be read", async () => {
    const result = await spawnWith(
      catalogRunner("throws", "throws"),
      "gpt-5.3-codex-spark",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unable to discover Codex models.*No agent was spawned/s);
    expect(mockClient.newSplit).not.toHaveBeenCalled();
  });
});
