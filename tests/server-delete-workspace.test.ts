import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { StateManager } from "../src/state-manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function stateDir(label: string): string {
  const root = join(tmpdir(), `cmuxlayer-delete-workspace-${label}-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function writeLiveAgent(root: string): void {
  new StateManager(root).writeState({
    agent_id: "worker-live",
    surface_id: "surface:worker-live",
    workspace_id: "workspace:7",
    state: "working",
    repo: "cmuxlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: null,
    task_summary: "still working",
    pid: null,
    version: 1,
    created_at: "2026-07-12T00:00:00Z",
    updated_at: "2026-07-12T00:00:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
  });
}

function mockClient(opts?: { callerTarget?: boolean; surface?: boolean }) {
  const surface = {
    ref: "surface:worker-live",
    title: "worker",
    type: "terminal",
    index: 0,
    selected: true,
  };
  return {
    surface,
    client: {
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:1",
            title: "caller",
            selected: !opts?.callerTarget,
          },
          {
            ref: "workspace:7",
            title: "scratch",
            selected: opts?.callerTarget ?? false,
          },
        ],
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:7",
        window_ref: "window:1",
        panes: opts?.surface
          ? [{ ref: "pane:7", surface_refs: [surface.ref] }]
          : [],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:7",
        window_ref: "window:1",
        pane_ref: "pane:7",
        surfaces: opts?.surface ? [surface] : [],
      }),
      deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("delete_workspace", () => {
  it("is registered off-default for deferred ToolSearch loading", async () => {
    const { client } = mockClient();
    const server = createServer({ client: client as any, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools.delete_workspace;

    expect(tool._meta).toMatchObject({
      defer_loading: true,
      "cmuxlayer/interim": true,
    });
    await server.close();
  });

  it("removes an empty workspace and returns the removed diff", async () => {
    const { client } = mockClient();
    const server = createServer({ client: client as any, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools.delete_workspace;

    const result = await tool.handler({ workspace: "workspace:7" }, {} as any);

    expect(client.deleteWorkspace).toHaveBeenCalledWith("workspace:7");
    expect(result.structuredContent).toMatchObject({
      ok: true,
      workspace: "workspace:7",
      removed: {
        workspaces: [{ ref: "workspace:7", title: "scratch" }],
        surfaces: [],
      },
    });
    await server.close();
  });

  it("refuses a live-agent workspace and returns its surfaces and agents", async () => {
    const root = stateDir("refuse");
    writeLiveAgent(root);
    const { client, surface } = mockClient({ surface: true });
    const server = createServer({
      client: client as any,
      stateDir: root,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools.delete_workspace;

    const result = await tool.handler({ workspace: "workspace:7" }, {} as any);

    expect(client.deleteWorkspace).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      refused: true,
      surfaces: [surface],
      agents: [expect.objectContaining({ agent_id: "worker-live", state: "working" })],
    });
    await server.close();
  });

  it.each(["ws:7", "7", "scratch"])(
    "refuses a live-agent workspace referenced by alias %s",
    async (workspaceAlias) => {
      const root = stateDir(`live-alias-${workspaceAlias.replace(/\W/g, "-")}`);
      writeLiveAgent(root);
      const { client } = mockClient();
      const server = createServer({
        client: client as any,
        stateDir: root,
        skipAgentLifecycle: true,
      });
      const tool = (server as any)._registeredTools.delete_workspace;

      const result = await tool.handler(
        { workspace: workspaceAlias },
        {} as any,
      );

      expect(client.deleteWorkspace).not.toHaveBeenCalled();
      expect(client.listPanes).toHaveBeenCalledWith({ workspace: "workspace:7" });
      expect(result.structuredContent).toMatchObject({
        refused: true,
        workspace: "workspace:7",
        live_agents: [expect.objectContaining({ agent_id: "worker-live" })],
      });
      await server.close();
    },
  );

  it("force-removes a workspace with a live agent", async () => {
    const root = stateDir("force");
    writeLiveAgent(root);
    const { client } = mockClient({ surface: true });
    const server = createServer({
      client: client as any,
      stateDir: root,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools.delete_workspace;

    const result = await tool.handler(
      { workspace: "workspace:7", force: true },
      {} as any,
    );

    expect(client.deleteWorkspace).toHaveBeenCalledWith("workspace:7");
    expect(result.structuredContent).toMatchObject({ ok: true, force: true });
    await server.close();
  });

  it("refuses the caller workspace without force", async () => {
    const { client } = mockClient({ callerTarget: true });
    const server = createServer({ client: client as any, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools.delete_workspace;

    const result = await tool.handler({ workspace: "workspace:7" }, {} as any);

    expect(client.deleteWorkspace).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      refused: true,
      caller_workspace: true,
      surfaces: [],
      agents: [],
    });
    await server.close();
  });

  it.each(["ws:7", "7", "scratch"])(
    "refuses the caller workspace referenced by alias %s",
    async (workspaceAlias) => {
      const { client } = mockClient({ callerTarget: true });
      const server = createServer({
        client: client as any,
        skipAgentLifecycle: true,
      });
      const tool = (server as any)._registeredTools.delete_workspace;

      const result = await tool.handler(
        { workspace: workspaceAlias },
        {} as any,
      );

      expect(client.deleteWorkspace).not.toHaveBeenCalled();
      expect(client.listPanes).toHaveBeenCalledWith({ workspace: "workspace:7" });
      expect(result.structuredContent).toMatchObject({
        refused: true,
        workspace: "workspace:7",
        caller_workspace: true,
      });
      await server.close();
    },
  );
});
