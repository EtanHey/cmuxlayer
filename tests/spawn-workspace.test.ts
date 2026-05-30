import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-spawn-workspace-test");

function makeWorkspaceClient() {
  let surfaceIndex = 0;
  const calls: string[] = [];
  const client = {
    calls,
    createWorkspace: vi.fn().mockImplementation(async (title: string) => {
      calls.push(`create:${title}`);
      return { workspace: "workspace:grid", title };
    }),
    selectWorkspace: vi.fn().mockImplementation(async (workspace: string) => {
      calls.push(`select:${workspace}`);
    }),
    listWorkspaces: vi.fn().mockResolvedValue({
      workspaces: [{ ref: "workspace:grid", title: "grid" }],
    }),
    listPanes: vi.fn().mockResolvedValue({
      workspace_ref: "workspace:grid",
      window_ref: "window:1",
      panes: [],
    }),
    listPaneSurfaces: vi.fn().mockResolvedValue({
      workspace_ref: "workspace:grid",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [],
    }),
    newSplit: vi.fn().mockImplementation(async (_direction, opts) => {
      surfaceIndex += 1;
      calls.push(`spawn:${opts.workspace}:surface:${surfaceIndex}`);
      return {
        workspace: opts.workspace,
        surface: `surface:${surfaceIndex}`,
        pane: `pane:${surfaceIndex}`,
        title: "",
        type: "terminal",
      };
    }),
    newSurface: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:1",
      text: "$ ",
      lines: 1,
      scrollback_used: false,
    }),
    log: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
  };
  return client;
}

describe("workspace spawn tools", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("create_workspace tool returns a workspace ref", async () => {
    const client = makeWorkspaceClient();
    const server = createServer({
      client: client as any,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["create_workspace"];

    const result = await tool.handler({ title: "red-team" }, {} as any);

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(client.createWorkspace).toHaveBeenCalledWith("red-team");
    expect(parsed).toMatchObject({
      ok: true,
      workspace: "workspace:grid",
      title: "red-team",
    });
  });

  it("spawn_in_workspace spawns agents into the created workspace", async () => {
    const client = makeWorkspaceClient();
    const server = createServer({
      client: client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
    });
    const tool = (server as any)._registeredTools["spawn_in_workspace"];

    const result = await tool.handler(
      {
        workspace_title: "red-team",
        agents: [
          { repo: "brainlayer", model: "sonnet", cli: "claude", role: "orchestrator" },
          { repo: "cmuxlayer", model: "gpt-5.4", cli: "codex", role: "worker" },
        ],
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.workspace).toBe("workspace:grid");
    expect(parsed.agents).toEqual([
      expect.objectContaining({
        surface_id: "surface:1",
        repo: "brainlayer",
        cli: "claude",
      }),
      expect.objectContaining({
        surface_id: "surface:2",
        repo: "cmuxlayer",
        cli: "codex",
      }),
    ]);
    expect(client.createWorkspace).toHaveBeenCalledTimes(1);
    expect(client.newSplit).toHaveBeenCalledTimes(2);
    expect(
      client.newSplit.mock.calls.map(([, opts]) => opts.workspace),
    ).toEqual(["workspace:grid", "workspace:grid"]);
  });

  it("spawn_in_workspace with reuse_workspace skips workspace creation", async () => {
    const client = makeWorkspaceClient();
    const server = createServer({
      client: client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
    });
    const tool = (server as any)._registeredTools["spawn_in_workspace"];

    const result = await tool.handler(
      {
        workspace_title: "ignored-title",
        reuse_workspace: "workspace:existing",
        agents: [
          { repo: "cmuxlayer", model: "gpt-5.4", cli: "codex", role: "worker" },
        ],
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.workspace).toBe("workspace:existing");
    expect(client.createWorkspace).not.toHaveBeenCalled();
    expect(client.selectWorkspace).toHaveBeenCalledWith("workspace:existing");
    expect(client.newSplit).toHaveBeenCalledWith("right", {
      workspace: "workspace:existing",
      type: "terminal",
    });
  });
});
