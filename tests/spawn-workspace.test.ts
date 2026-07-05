import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import { inboxPath, monitorAlive } from "../src/inbox.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-spawn-workspace-test");
const wrongWorkspaceFixtureUrl = new URL(
  "./fixtures/painpoints/wrong-workspace-spawn.json",
  import.meta.url,
);

type RegisteredTool = {
  handler(
    args: Record<string, unknown>,
    extra: Record<string, unknown>,
  ): Promise<{
    structuredContent?: unknown;
    content: Array<{ text: string }>;
  }>;
};

type ServerWithRegisteredTools = {
  _registeredTools: Record<string, RegisteredTool>;
};

type WrongWorkspaceFixture = {
  parent_agent: {
    repo: string;
    workspace_id: string;
  };
  spawn_request: {
    repo: string;
    explicit_workspace: string | null;
  };
};

function getTool(server: unknown, name: string): RegisteredTool {
  return (server as ServerWithRegisteredTools)._registeredTools[name]!;
}

function parseStructuredResult<T>(result: {
  structuredContent?: unknown;
  content: Array<{ text: string }>;
}): T {
  return (result.structuredContent ?? JSON.parse(result.content[0]!.text)) as T;
}

function readWrongWorkspaceFixture(): WrongWorkspaceFixture {
  return JSON.parse(
    readFileSync(wrongWorkspaceFixtureUrl, "utf8"),
  ) as WrongWorkspaceFixture;
}

function repoLabelFromFixturePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const worktreeSegment = segments.find((segment) =>
    segment.endsWith(".wt"),
  );
  if (worktreeSegment) return worktreeSegment.slice(0, -3);
  return segments.at(-1) ?? path;
}

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
      text: "Claude Code\n>",
      lines: 1,
      scrollback_used: false,
    }),
    log: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    listStatus: vi.fn().mockResolvedValue([]),
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
    const inboxDir = join(TEST_DIR, "inbox");
    const server = createServer({
      client: client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      inboxBaseDir: inboxDir,
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
        monitor_boot: {
          status: "bootstrapped",
          heartbeat_written: true,
          heartbeat_source: "server_boot",
          monitor_command: expect.any(String),
        },
      }),
      expect.objectContaining({
        surface_id: "surface:2",
        repo: "cmuxlayer",
        cli: "codex",
      }),
    ]);
    expect(parsed.agents[1].monitor_boot).toBeUndefined();
    expect(
      existsSync(inboxPath(parsed.agents[0].agent_id, { baseDir: inboxDir })),
    ).toBe(true);
    expect(
      monitorAlive(parsed.agents[0].agent_id, 1_000, { baseDir: inboxDir }),
    ).toBe(false);
    expect(client.createWorkspace).toHaveBeenCalledTimes(1);
    expect(client.newSplit).toHaveBeenCalledTimes(2);
    expect(
      client.newSplit.mock.calls.map(([, opts]) => opts.workspace),
    ).toEqual(["workspace:grid", "workspace:grid"]);
  });

  it("spawn_in_workspace refuses a manual-mode caller workspace before creating", async () => {
    const client = makeWorkspaceClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [{ ref: "workspace:manual", title: "Manual", selected: true }],
    });
    client.listStatus.mockResolvedValue([
      { key: "mode.control", value: "manual" },
    ]);
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
          { repo: "cmuxlayer", model: "gpt-5.4", cli: "codex", role: "worker" },
        ],
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      ok: false,
      error_code: "manual_mode",
      tool: "spawn_in_workspace",
      workspace: "workspace:manual",
    });
    expect(client.listStatus).toHaveBeenCalledWith({
      workspace: "workspace:manual",
    });
    expect(client.createWorkspace).not.toHaveBeenCalled();
    expect(client.newSplit).not.toHaveBeenCalled();
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

  it("spawn_in_workspace refuses a manual-mode reused workspace before selecting", async () => {
    const client = makeWorkspaceClient();
    client.listStatus.mockResolvedValue([
      { key: "mode.control", value: "manual" },
    ]);
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
    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      ok: false,
      error_code: "manual_mode",
      tool: "spawn_in_workspace",
      workspace: "workspace:existing",
    });
    expect(client.listStatus).toHaveBeenCalledWith({
      workspace: "workspace:existing",
    });
    expect(client.selectWorkspace).not.toHaveBeenCalled();
    expect(client.newSplit).not.toHaveBeenCalled();
  });

  it("same-repo child spawn inherits parent workspace and reports wrong actual workspace as unhealthy", async () => {
    const fixture = readWrongWorkspaceFixture();
    const repo = repoLabelFromFixturePath(fixture.parent_agent.repo);
    const childRepo = repoLabelFromFixturePath(fixture.spawn_request.repo);
    let surfaceIndex = 0;
    const surfaceWorkspace = new Map<string, string>();
    const surfacePane = new Map<string, string>();
    const client = makeWorkspaceClient();
    client.listWorkspaces.mockResolvedValue({
      workspaces: [
        {
          ref: fixture.parent_agent.workspace_id,
          current_directory: fixture.parent_agent.repo,
        },
        {
          ref: "workspace:B",
          current_directory: "/example/workspaces/other",
          selected: true,
        },
      ],
    });
    client.listPanes.mockImplementation(async ({ workspace } = {}) => {
      const workspaceRef =
        typeof workspace === "string" ? workspace : "workspace:B";
      const paneRefs = [...surfacePane.entries()]
        .filter(([surface]) => surfaceWorkspace.get(surface) === workspaceRef)
        .map(([, pane]) => pane);
      return {
        workspace_ref: workspaceRef,
        window_ref: `window:${workspaceRef}`,
        panes: [...new Set(paneRefs)].map((pane, index) => ({
          ref: pane,
          index,
          focused: index === 0,
          surface_count: [...surfacePane.values()].filter(
            (candidate) => candidate === pane,
          ).length,
          surface_refs: [...surfacePane.entries()]
            .filter(([, candidate]) => candidate === pane)
            .map(([surface]) => surface),
        })),
      };
    });
    client.listPaneSurfaces.mockImplementation(
      async ({ workspace, pane } = {}) => {
        const workspaceRef =
          typeof workspace === "string" ? workspace : "workspace:B";
        const paneRef = typeof pane === "string" ? pane : "pane:focused";
        return {
          workspace_ref: workspaceRef,
          window_ref: `window:${workspaceRef}`,
          pane_ref: paneRef,
          surfaces: [...surfacePane.entries()]
            .filter(
              ([surface, candidatePane]) =>
                candidatePane === paneRef &&
                surfaceWorkspace.get(surface) === workspaceRef,
            )
            .map(([surface], index) => ({
              ref: surface,
              title:
                surface === "surface:1" ? "cmuxlayerClaude" : "cmuxlayerCodex",
              type: "terminal" as const,
              index,
              selected: index === 0,
            })),
        };
      },
    );
    client.newSplit.mockImplementation(async (_direction, opts) => {
      surfaceIndex += 1;
      const surface = `surface:${surfaceIndex}`;
      const pane = `pane:${surfaceIndex}`;
      const actualWorkspace =
        surfaceIndex > 1 ? "workspace:B" : opts.workspace;
      surfaceWorkspace.set(surface, actualWorkspace ?? "workspace:B");
      surfacePane.set(surface, pane);
      return {
        workspace: actualWorkspace,
        surface,
        pane,
        title: "",
        type: "terminal",
      };
    });
    const server = createServer({
      client: client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
    });
    const spawnAgent = getTool(server, "spawn_agent");

    const parentResult = await spawnAgent.handler(
      {
        repo,
        cli: "claude",
        role: "orchestrator",
        workspace: fixture.parent_agent.workspace_id,
        force_new: true,
      },
      {},
    );
    const parent = parseStructuredResult<{ agent_id: string }>(parentResult);
    expect(parent.agent_id).toEqual(expect.any(String));
    const childResult = await spawnAgent.handler(
      {
        repo: childRepo,
        cli: "codex",
        role: "worker",
        workspace: fixture.spawn_request.explicit_workspace ?? undefined,
        parent_agent_id: parent.agent_id,
        force_new: true,
      },
      {},
    );
    const child = parseStructuredResult<{
      ok: boolean;
      workspace_id?: string;
      warnings?: string[];
      health?: { status: string; issue_codes: string[] };
    }>(childResult);

    expect(client.newSplit.mock.calls[1]?.[1]?.workspace).toBe(
      fixture.parent_agent.workspace_id,
    );
    expect(child.ok).toBe(true);
    expect(child.workspace_id).toBe(fixture.parent_agent.workspace_id);
    expect(child.warnings).toEqual([
      expect.stringMatching(/Spawn placement mismatch/),
    ]);
    expect(child.health).toMatchObject({
      status: "unhealthy",
      issue_codes: expect.arrayContaining([
        "registry_surface_workspace_mismatch",
      ]),
    });
  });
});
