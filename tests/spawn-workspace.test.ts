import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createServer as createProductionServer,
  type CreateServerOptions,
} from "../src/server.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-spawn-workspace-test");

function createServer(opts: CreateServerOptions = {}) {
  return createProductionServer(
    opts.context ? opts : withTestSurfaceObserver(opts),
  );
}
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
  const activeCli = new Map<string, "claude" | "codex">();
  const submitted = new Set<string>();
  const returnCount = new Map<string, number>();
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
    listPanes: vi.fn().mockImplementation(async () => ({
      workspace_ref: "workspace:grid",
      window_ref: "window:1",
      panes: Array.from({ length: surfaceIndex }, (_unused, index) => ({
        ref: `pane:${index + 1}`,
        index,
        focused: index === surfaceIndex - 1,
        surface_count: 1,
        surface_refs: [`surface:${index + 1}`],
        selected_surface_ref: `surface:${index + 1}`,
      })),
    })),
    listPaneSurfaces: vi.fn().mockImplementation(async (opts) => {
      const pane = opts?.pane ?? "pane:1";
      const index = Number(pane.split(":").at(-1) ?? "1");
      return {
        workspace_ref: "workspace:grid",
        window_ref: "window:1",
        pane_ref: pane,
        surfaces:
          index <= surfaceIndex
            ? [{
                ref: `surface:${index}`,
                title: "agent-pane",
                type: "terminal",
                index: 0,
                selected: true,
              }]
            : [],
      };
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
    focusSurface: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockImplementation(async (surface: string, text: string) => {
      if (/Codex/.test(text)) activeCli.set(surface, "codex");
      if (/Claude/.test(text)) activeCli.set(surface, "claude");
    }),
    pasteText: vi.fn().mockImplementation(async (surface: string, text: string) => {
      if (/Codex/.test(text)) activeCli.set(surface, "codex");
      if (/Claude/.test(text)) activeCli.set(surface, "claude");
    }),
    sendKey: vi.fn().mockImplementation(async (surface: string, key: string) => {
      if (key === "return") {
        const count = (returnCount.get(surface) ?? 0) + 1;
        returnCount.set(surface, count);
        if (count >= 2) submitted.add(surface);
      }
    }),
    readScreen: vi.fn().mockImplementation(async (surface: string) => {
      const cli = activeCli.get(surface) ?? "claude";
      return {
        surface,
        text: submitted.has(surface)
          ? cli === "codex"
            ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
            : "Claude Code\n✻ Working"
          : cli === "codex"
            ? "OpenAI Codex\ncodex> "
            : "Claude Code\nWhat can I help you with?\n>",
        lines: 2,
        scrollback_used: false,
      };
    }),
    log: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue({}),
    listStatus: vi.fn().mockResolvedValue([]),
    browser: vi.fn().mockResolvedValue({}),
  };
  return client;
}

describe("workspace spawn placement", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("same-repo child spawn inherits parent workspace and blocks a wrong actual workspace without leaking", async () => {
    const fixture = readWrongWorkspaceFixture();
    const repo = repoLabelFromFixturePath(fixture.parent_agent.repo);
    const childRepo = repoLabelFromFixturePath(fixture.spawn_request.repo);
    let surfaceIndex = 0;
    const surfaceWorkspace = new Map<string, string>();
    const surfacePane = new Map<string, string>();
    const surfaceUuid = new Map<string, string>();
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
          surface_ids: [...surfacePane.entries()]
            .filter(([, candidate]) => candidate === pane)
            .map(([surface]) => surfaceUuid.get(surface)!),
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
              id: surfaceUuid.get(surface),
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
      const surfaceId = `11111111-2222-4333-8444-${String(surfaceIndex).padStart(12, "0")}`;
      surfaceUuid.set(surface, surfaceId);
      return {
        workspace: actualWorkspace,
        surface,
        surface_id: surfaceId,
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
    const child = parseStructuredResult<{ ok: boolean; error?: string }>(
      childResult,
    );

    expect(client.newSplit.mock.calls[1]?.[1]?.workspace).toBe(
      fixture.parent_agent.workspace_id,
    );
    expect(childResult.isError).toBe(true);
    expect(child.ok).toBe(false);
    expect(child.error).toContain(
      `Spawn placement blocked: requested ${fixture.parent_agent.workspace_id} but cmux returned workspace:B`,
    );
    expect(client.closeSurface).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-000000000002",
      expect.objectContaining({
        workspace: "workspace:B",
        collapsePane: false,
      }),
    );
    expect(client.send).not.toHaveBeenCalledWith(
      "surface:2",
      expect.anything(),
      expect.anything(),
    );
  });
});
