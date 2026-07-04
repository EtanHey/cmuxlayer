import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";

// Core low-level and metadata tools.
const EXPECTED_TOOLS = [
  "list_surfaces",
  "control_health",
  "select_workspace",
  "create_workspace",
  "new_split",
  "new_surface",
  "move_surface",
  "reorder_surface",
  "send_input",
  "send_command",
  "send_key",
  "read_screen",
  "rename_tab",
  "notify",
  "set_status",
  "set_progress",
  "close_surface",
  "browser_surface",
  "dispatch_to_agent",
  "inbox_check",
] as const;

const CHANNEL_TEST_DIR = join(tmpdir(), "cmuxlayer-channels-server-test");
const BOOT_PROMPT_READY_POLL_MS_FOR_TESTS = 250;

async function advanceTimers(ms: number): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

describe("createServer", () => {
  it("returns an McpServer with a connect method", async () => {
    const server = createServer({ skipAgentLifecycle: true });
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });

  it("registers Claude channel capability when enabled", () => {
    const server = createServer({
      skipAgentLifecycle: true,
      enableClaudeChannels: true,
    });
    const rawServer = (server as any).server;

    expect(rawServer._capabilities.experimental).toEqual({
      "claude/channel": {},
    });
    expect(rawServer._instructions).toContain("notifications/claude/channel");
  });

  it("does not register Claude channel capability by default", () => {
    const server = createServer({ skipAgentLifecycle: true });
    const rawServer = (server as any).server;

    expect(rawServer._capabilities.experimental).toBeUndefined();
    expect(rawServer._instructions).toBeUndefined();
  });
});

describe("tool registration", () => {
  it("registers all 20 core tools", () => {
    const server = createServer({ skipAgentLifecycle: true });
    // Access internal registered tools via the server property
    const registeredTools = (server as any)._registeredTools;
    expect(registeredTools).toBeDefined();

    const toolNames = Object.keys(registeredTools);
    for (const expected of EXPECTED_TOOLS) {
      expect(toolNames).toContain(expected);
    }
    expect(toolNames).toHaveLength(EXPECTED_TOOLS.length);
  });
});

describe("Claude channels", () => {
  afterEach(() => {
    vi.useRealTimers();
    rmSync(CHANNEL_TEST_DIR, { recursive: true, force: true });
  });

  it("emits lifecycle notifications over the MCP transport when enabled", async () => {
    vi.useFakeTimers();
    rmSync(CHANNEL_TEST_DIR, { recursive: true, force: true });
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });

    // Use "working" state (not terminal) so the agent survives startup purge.
    // Terminal-state agents from previous sessions are silently purged on startup.
    const stateMgr = new StateManager(CHANNEL_TEST_DIR);
    stateMgr.writeState({
      agent_id: "a1",
      surface_id: "surface:42",
      state: "working",
      repo: "brainlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: null,
      task_summary: "Ship channel prototype",
      pid: null,
      version: 1,
      created_at: "2026-03-21T00:00:00Z",
      updated_at: "2026-03-21T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    });

    const mockClient = {
      listWorkspaces: vi
        .fn()
        .mockResolvedValue({ workspaces: [{ ref: "workspace:1" }] }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes: [{ ref: "pane:1" }],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ref: "surface:42",
            title: "agent",
            type: "terminal",
            index: 0,
            selected: true,
          },
        ],
      }),
      log: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:42",
        text: "$ ",
        lines: 5,
        scrollback_used: false,
      }),
      send: vi.fn().mockResolvedValue(undefined),
      sendKey: vi.fn().mockResolvedValue(undefined),
      setProgress: vi.fn().mockResolvedValue(undefined),
      newSplit: vi.fn(),
    };

    const server = createServer({
      client: mockClient as any,
      stateDir: CHANNEL_TEST_DIR,
      enableClaudeChannels: true,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const messages: any[] = [];
    clientTransport.onmessage = (message) => {
      messages.push(message);
    };

    await server.connect(serverTransport);
    const advanceAsync = (vi as any).advanceTimersByTimeAsync;
    if (typeof advanceAsync === "function") {
      await advanceAsync.call(vi, 5000);
    } else {
      await advanceTimers(5000);
    }

    const notifications = messages.filter(
      (message) =>
        "method" in message &&
        message.method === "notifications/claude/channel",
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          meta: expect.objectContaining({
            event: "spawned",
            agent_id: "a1",
            repo: "brainlayer",
          }),
        }),
      }),
    );

    await server.close();
    await clientTransport.close();
  });
});

describe("tool handler integration", () => {
  let mockExec: ExecFn;

  beforeEach(() => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
  });

  afterEach(() => {
    try {
      vi.clearAllTimers();
    } catch {
      // Bun's Vitest shim throws here when fake timers were never activated.
    }
    vi.useRealTimers();
    rmSync(CHANNEL_TEST_DIR, { recursive: true, force: true });
  });

  it("list_surfaces handler calls cmux list-workspaces", async () => {
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["list_surfaces"];

    // Invoke the tool callback directly
    const result = await tool.handler({}, {} as any);

    expect(mockExec).toHaveBeenCalled();
    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe("text");
    expect(result.structuredContent.ok).toBe(true);
  });

  it("select_workspace handler calls cmux select-workspace", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({}),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["select_workspace"];

    const result = await tool.handler({ workspace: "workspace:3" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "--json",
        "select-workspace",
        "--workspace",
        "workspace:3",
      ]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace).toBe("workspace:3");
  });

  it("create_workspace handler calls client.createWorkspace", async () => {
    const mockClient = {
      createWorkspace: vi.fn().mockResolvedValue({
        workspace: "workspace:7",
        title: "red-team",
      }),
    };
    const server = createServer({
      client: mockClient as any,
      skipAgentLifecycle: true,
    });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["create_workspace"];

    const result = await tool.handler({ title: "red-team" }, {} as any);

    expect(mockClient.createWorkspace).toHaveBeenCalledWith("red-team");
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      ok: true,
      workspace: "workspace:7",
      title: "red-team",
    });
  });

  it("spawn_in_workspace tool handler creates, selects, then spawns agents", async () => {
    const calls: string[] = [];
    let surfaceIndex = 0;
    const mockClient = {
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
      browser: vi.fn().mockResolvedValue({}),
    };
    const stateDir = join(CHANNEL_TEST_DIR, "spawn-in-workspace-sequence");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    const server = createServer({
      client: mockClient as any,
      stateDir,
      disableSpawnPreflight: true,
    });
    const tool = (server as any)._registeredTools["spawn_in_workspace"];

    const result = await tool.handler(
      {
        workspace_title: "red-team",
        agents: [
          {
            repo: "brainlayer",
            model: "sonnet",
            cli: "claude",
            role: "orchestrator",
          },
          { repo: "cmuxlayer", model: "gpt-5.4", cli: "codex", role: "worker" },
        ],
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace).toBe("workspace:grid");
    expect(parsed.agents).toHaveLength(2);
    expect(calls.slice(0, 4)).toEqual([
      "create:red-team",
      "select:workspace:grid",
      "select:workspace:grid",
      "spawn:workspace:grid:surface:1",
    ]);
    expect(calls).toContain("spawn:workspace:grid:surface:2");

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("list_surfaces dedupes overlapping pane results and returns the condensed default schema", async () => {
    mockExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Main",
              id: "workspace-uuid-1",
              index: 0,
              selected: true,
              pinned: false,
              current_directory: "/tmp/main",
              remote: {
                state: "disconnected",
                connected: false,
                enabled: false,
                destination: null,
                detail: null,
                daemon: { state: "unavailable" },
                proxy: { state: "unavailable" },
                heartbeat: { count: 0, age_seconds: null, last_seen_at: null },
              },
            },
            {
              ref: "workspace:2",
              title: "Empty",
              id: "workspace-uuid-2",
              index: 1,
              selected: false,
              pinned: false,
              current_directory: null,
              remote: {
                state: "disconnected",
                connected: false,
                enabled: false,
                destination: null,
                detail: null,
                daemon: { state: "unavailable" },
                proxy: { state: "unavailable" },
                heartbeat: { count: 0, age_seconds: null, last_seen_at: null },
              },
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:1"],
              selected_surface_ref: "surface:1",
            },
            {
              ref: "pane:2",
              index: 1,
              focused: false,
              surface_count: 2,
              surface_refs: ["surface:1", "surface:2"],
              selected_surface_ref: "surface:2",
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:2",
          window_ref: "window:2",
          panes: [],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:1",
              title: "One",
              type: "terminal",
              index: 0,
              focused: true,
              id: "surface-uuid-1",
              pane_id: "pane-uuid-1",
              index_in_pane: 0,
              selected_in_pane: true,
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:2",
          surfaces: [
            {
              ref: "surface:1",
              title: "One",
              type: "terminal",
              index: 0,
              focused: true,
              id: "surface-uuid-1",
              pane_id: "pane-uuid-1",
              index_in_pane: 0,
              selected_in_pane: true,
            },
            {
              ref: "surface:2",
              title: "Two",
              type: "browser",
              index: 0,
              focused: false,
              id: "surface-uuid-2",
              pane_id: "pane-uuid-2",
              index_in_pane: 1,
              selected_in_pane: true,
            },
          ],
        }),
        stderr: "",
      });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["list_surfaces"];

    const result = await tool.handler({}, {} as any);

    expect(mockExec).toHaveBeenCalledWith("cmux", [
      "--json",
      "list-panes",
      "--workspace",
      "workspace:1",
    ]);
    expect(mockExec).toHaveBeenCalledWith("cmux", [
      "--json",
      "list-panes",
      "--workspace",
      "workspace:2",
    ]);

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surfaces).toHaveLength(2);
    expect(
      parsed.surfaces.map((surface: { ref: string }) => surface.ref),
    ).toEqual(["surface:1", "surface:2"]);
    expect(parsed.workspaces).toEqual([
      {
        ref: "workspace:1",
        title: "Main",
        current_directory: "/tmp/main",
        remote_state: "local",
      },
      {
        ref: "workspace:2",
        title: "Empty",
        current_directory: null,
        remote_state: "local",
      },
    ]);
    expect(parsed.surfaces[0]).toEqual({
      ref: "surface:1",
      workspace_ref: "workspace:1",
      pane_ref: "pane:1",
      column: 0,
      title: "One",
      type: "terminal",
      current_directory: "/tmp/main",
      requested_working_directory: "/tmp/main",
      working_directory_source: "workspace_fallback",
      working_directory_fallback: true,
    });
    expect(parsed.surfaces[1]).toEqual({
      ref: "surface:2",
      workspace_ref: "workspace:1",
      pane_ref: "pane:2",
      column: 1,
      title: "Two",
      type: "browser",
      current_directory: "/tmp/main",
      requested_working_directory: "/tmp/main",
      working_directory_source: "workspace_fallback",
      working_directory_fallback: true,
    });
  });

  it("list_surfaces reports pane_ref, column, and column_count in condensed and verbose output", async () => {
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "Main",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:left",
                index: 0,
                focused: false,
                surface_count: 1,
                surface_refs: ["surface:left"],
                pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
              },
              {
                ref: "pane:right-top",
                index: 1,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:right-top"],
                pixel_frame: { x: 500, y: 0, width: 500, height: 450 },
              },
              {
                ref: "pane:right-bottom",
                index: 2,
                focused: false,
                surface_count: 1,
                surface_refs: ["surface:right-bottom"],
                pixel_frame: { x: 500, y: 450, width: 500, height: 450 },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        const pane = String(args[args.indexOf("--pane") + 1] ?? "");
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: pane,
            surfaces: [
              {
                ref:
                  pane === "pane:left"
                    ? "surface:left"
                    : pane === "pane:right-top"
                      ? "surface:right-top"
                      : "surface:right-bottom",
                title: pane,
                type: "terminal",
                index: 0,
                selected: true,
              },
            ],
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["list_surfaces"];

    const condensedResult = await tool.handler({}, {} as any);
    const condensed =
      condensedResult.structuredContent ??
      JSON.parse(condensedResult.content[0].text);

    expect(condensed.column_count).toBe(2);
    expect(condensed.surfaces).toEqual([
      expect.objectContaining({
        ref: "surface:left",
        pane_ref: "pane:left",
        column: 0,
      }),
      expect.objectContaining({
        ref: "surface:right-top",
        pane_ref: "pane:right-top",
        column: 1,
      }),
      expect.objectContaining({
        ref: "surface:right-bottom",
        pane_ref: "pane:right-bottom",
        column: 1,
      }),
    ]);

    const verboseResult = await tool.handler({ verbose: true }, {} as any);
    const verbose =
      verboseResult.structuredContent ??
      JSON.parse(verboseResult.content[0].text);

    expect(verbose.column_count).toBe(2);
    expect(verbose.surfaces).toEqual([
      expect.objectContaining({
        ref: "surface:left",
        pane_ref: "pane:left",
        column: 0,
      }),
      expect.objectContaining({
        ref: "surface:right-top",
        pane_ref: "pane:right-top",
        column: 1,
      }),
      expect.objectContaining({
        ref: "surface:right-bottom",
        pane_ref: "pane:right-bottom",
        column: 1,
      }),
    ]);
  });

  it("list_surfaces backfills pane_ref before assigning columns when the client omits it", async () => {
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "Main",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:left",
                id: "pane-left-id",
                index: 0,
                focused: false,
                surface_count: 1,
                surface_refs: ["surface:left"],
                surface_ids: ["surface-left-id"],
                pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
              },
              {
                ref: "pane:right",
                id: "pane-right-id",
                index: 1,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:right"],
                surface_ids: ["surface-right-id"],
                pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        const pane = String(args[args.indexOf("--pane") + 1] ?? "");
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            surfaces: [
              {
                id: "surface-left-id",
                pane_id: "pane-left-id",
                ref: "surface:left",
                title: "left",
                type: "terminal",
                index: 0,
                selected: true,
              },
              {
                id: "surface-right-id",
                pane_id: "pane-right-id",
                ref: "surface:right",
                title: "right",
                type: "terminal",
                index: 1,
                selected: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["list_surfaces"];

    const result = await tool.handler({}, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.surfaces).toEqual([
      expect.objectContaining({
        ref: "surface:left",
        pane_ref: "pane:left",
        column: 0,
      }),
      expect.objectContaining({
        ref: "surface:right",
        pane_ref: "pane:right",
        column: 1,
      }),
    ]);
    expect(parsed.column_count).toBe(2);
  });

  it("list_surfaces keeps working when a screen preview fails", async () => {
    mockExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Main",
              index: 0,
              selected: true,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:1"],
              selected_surface_ref: "surface:1",
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:1",
              title: "One",
              type: "terminal",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("read failed"), {
          stderr: "surface unavailable",
        }),
      );

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["list_surfaces"];

    const result = await tool.handler(
      { workspace: "workspace:1", include_screen_preview: true },
      {} as any,
    );

    expect(result.isError).toBeUndefined();
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surfaces[0].screen_preview_error).toMatch(
      /surface unavailable/,
    );
  });

  it("list_surfaces preserves the current full schema behind verbose=true while still deduping", async () => {
    mockExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
              title: "Main",
              id: "workspace-uuid-1",
              index: 0,
              selected: true,
              pinned: false,
              current_directory: "/tmp/main",
              remote: {
                state: "connected",
                connected: true,
                enabled: true,
                destination: "ssh://box",
                detail: "ready",
              },
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:1"],
              selected_surface_ref: "surface:1",
            },
            {
              ref: "pane:2",
              index: 1,
              focused: false,
              surface_count: 2,
              surface_refs: ["surface:1", "surface:2"],
              selected_surface_ref: "surface:2",
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:1",
              title: "One",
              type: "terminal",
              id: "surface-uuid-1",
              pane_id: "pane-uuid-1",
              index: 0,
              index_in_pane: 0,
              focused: true,
              selected_in_pane: true,
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:2",
          surfaces: [
            {
              ref: "surface:1",
              title: "One",
              type: "terminal",
              id: "surface-uuid-1",
              pane_id: "pane-uuid-1",
              index: 0,
              index_in_pane: 0,
              focused: true,
              selected_in_pane: true,
            },
            {
              ref: "surface:2",
              title: "Two",
              type: "browser",
              id: "surface-uuid-2",
              pane_id: "pane-uuid-2",
              index: 1,
              index_in_pane: 1,
              focused: false,
              selected_in_pane: true,
            },
          ],
        }),
        stderr: "",
      });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["list_surfaces"];

    const result = await tool.handler({ verbose: true }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.surfaces).toHaveLength(2);
    expect(parsed.workspaces[0]).toMatchObject({
      ref: "workspace:1",
      title: "Main",
      id: "workspace-uuid-1",
      index: 0,
      selected: true,
      pinned: false,
      current_directory: "/tmp/main",
      remote: {
        state: "connected",
        connected: true,
        enabled: true,
        destination: "ssh://box",
        detail: "ready",
      },
    });
    expect(parsed.surfaces[0]).toMatchObject({
      ref: "surface:1",
      title: "One",
      type: "terminal",
      id: "surface-uuid-1",
      pane_id: "pane-uuid-1",
      index: 0,
      index_in_pane: 0,
      focused: true,
      selected_in_pane: true,
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:1",
    });
  });

  it("list_surfaces reports terminal metadata cwd instead of workspace fallback cwd", async () => {
    const workspaceCwd = "/Users/etanheyman/Gits/golems";
    const realSurfaceCwd =
      "/Users/etanheyman/Gits/cmuxlayer.wt/adopted-pane-binding";
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "golems",
                index: 0,
                selected: true,
                pinned: false,
                current_directory: workspaceCwd,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:worker",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:adopted"],
                selected_surface_ref: "surface:adopted",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:worker",
            surfaces: [
              {
                ref: "surface:adopted",
                title: "adopted-pane-binding",
                type: "terminal",
                index: 0,
                selected: true,
                requested_working_directory: workspaceCwd,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("debug-terminals")) {
        return {
          stdout: JSON.stringify({
            terminals: [
              {
                surface_ref: "surface:adopted",
                pane_ref: "pane:worker",
                workspace_ref: "workspace:1",
                current_directory: realSurfaceCwd,
                requested_working_directory: workspaceCwd,
              },
            ],
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["list_surfaces"];

    const result = await tool.handler({ verbose: true }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.surfaces[0]).toMatchObject({
      ref: "surface:adopted",
      pane_ref: "pane:worker",
      current_directory: realSurfaceCwd,
      requested_working_directory: realSurfaceCwd,
      working_directory_source: "terminal_metadata",
      working_directory_fallback: false,
    });
  });

  it("read_screen handler calls cmux read-screen", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        surface_ref: "surface:1",
        text: [
          "---RESPONSE_START---",
          "hello",
          "---RESPONSE_END---",
          "ENRICHMENT_PROMPT_DONE",
          "Token usage: total=2,345",
          "🤖 Sonnet 4.6 | 💰 $1.25",
        ].join("\n"),
        lines: 20,
      }),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["read_screen"];

    const result = await tool.handler({ surface: "surface:1" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["read-screen"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    // LEAN DEFAULT: response returned once (parsed.response); NOT duplicated in a raw
    // content dump, and no screen_preview when there's a response.
    expect(parsed.content).toBeUndefined();
    expect(parsed.screen_preview).toBeUndefined();
    expect(parsed.parsed).toMatchObject({
      agent_type: "claude",
      status: "done",
      token_count: 2345,
      done_signal: "ENRICHMENT_PROMPT_DONE",
      response: "hello",
      model: "Sonnet 4.6",
      cost: 1.25,
    });

    // raw=true returns the full untrimmed terminal content.
    const rawResult = await tool.handler(
      { surface: "surface:1", raw: true },
      {} as any,
    );
    const rawParsed =
      rawResult.structuredContent ?? JSON.parse(rawResult.content[0].text);
    expect(rawParsed.content).toContain("hello");
  });

  it("read_screen parsed_only includes the tab title and recovers model context from agent state", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-read-screen-parser-fallback");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });

    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "sonnet-orchestrator-123",
      surface_id: "surface:1",
      state: "idle",
      repo: "orchestrator",
      model: "Sonnet 4.6",
      cli: "claude",
      cli_session_id: null,
      task_summary: "Monitor parser output",
      pid: null,
      version: 1,
      created_at: "2026-03-23T00:00:00Z",
      updated_at: "2026-03-23T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    });

    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:1",
        text: [
          "Parser fallback is running in the narrow pane.",
          "Token usage: total=40,000",
          "CLAUDE_COUNTER: 7",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      }),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [{ ref: "workspace:1" }],
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes: [{ ref: "pane:1" }],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ref: "surface:1",
            title: "orchestratorClaude",
            type: "terminal",
            index: 0,
            selected: true,
          },
        ],
      }),
    } as any;

    const server = createServer({
      client: mockClient,
      stateDir,
      skipAgentLifecycle: true,
    });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["read_screen"];

    const result = await tool.handler(
      { surface: "surface:1", parsed_only: true },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.title).toBe("orchestratorClaude");
    expect(parsed.parsed).toMatchObject({
      agent_type: "claude",
      status: "idle",
      model: "Sonnet 4.6",
      context_window: 200000,
      context_pct: 20,
      done_signal: "CLAUDE_COUNTER:7",
      response: "Parser fallback is running in the narrow pane.",
    });

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("read_screen title is additive and preserves existing Claude parsed fields", async () => {
    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:1",
        text: [
          "---RESPONSE_START---",
          "hello",
          "---RESPONSE_END---",
          "ENRICHMENT_PROMPT_DONE",
          "Token usage: total=2,345",
          "🤖 Sonnet 4.6 | 💰 $1.25",
        ].join("\n"),
        lines: 20,
        scrollback_used: false,
      }),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [{ ref: "workspace:1" }],
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes: [{ ref: "pane:1" }],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ref: "surface:1",
            title: "orchestratorClaude",
            type: "terminal",
            index: 0,
            selected: true,
          },
        ],
      }),
    } as any;

    const server = createServer({
      client: mockClient,
      skipAgentLifecycle: true,
    });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["read_screen"];

    const result = await tool.handler(
      { surface: "surface:1", parsed_only: true },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.title).toBe("orchestratorClaude");
    expect(parsed.parsed).toMatchObject({
      agent_type: "claude",
      status: "done",
      token_count: 2345,
      context_pct: 0,
      context_window: 1_000_000,
      done_signal: "ENRICHMENT_PROMPT_DONE",
      response: "hello",
      model: "Sonnet 4.6",
      cost: 1.25,
    });
  });

  it("read_screen infers context fields for live Claude panes with fully truncated model footers", async () => {
    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:1",
        text: [
          "  Say \"go\" when you're ready and I'll start your timer.",
          "",
          "  CLAUDE_COUNTER: 186",
          "",
          "──────────────────────────────────────────────────────────────────────────────────────────",
          "❯",
          "──────────────────────────────────────────────────────────────────────────────────────────",
          "  ⎇ master | +1273,-196 | 🔧 11                                           418310 tokens",
          "  🤖 …                                                        current: 2.1.81 · latest…",
          "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
        ].join("\n"),
        lines: 40,
        scrollback_used: false,
      }),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [{ ref: "workspace:1" }],
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes: [{ ref: "pane:1" }],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [
          {
            ref: "surface:1",
            title: "qwanClaude (main)",
            type: "terminal",
            index: 0,
            selected: true,
          },
        ],
      }),
    } as any;

    // Use an isolated stateDir so enrichParsedScreen doesn't pick up live
    // agent state from the default state directory and overwrite model/cost.
    const isolatedStateDir = join(tmpdir(), "cmux-read-screen-isolation-test");
    rmSync(isolatedStateDir, { recursive: true, force: true });
    mkdirSync(isolatedStateDir, { recursive: true });
    const server = createServer({
      client: mockClient,
      skipAgentLifecycle: true,
      stateDir: isolatedStateDir,
    });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["read_screen"];

    const result = await tool.handler(
      { surface: "surface:1", parsed_only: true, lines: 40 },
      {} as any,
    );
    rmSync(isolatedStateDir, { recursive: true, force: true });

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.title).toBe("qwanClaude (main)");
    expect(parsed.parsed).toMatchObject({
      agent_type: "claude",
      status: "idle",
      token_count: 418310,
      context_window: 1_000_000,
      context_pct: 42,
      done_signal: "CLAUDE_COUNTER:186",
      response: `  Say "go" when you're ready and I'll start your timer.`,
      model: null,
      cost: null,
    });
  });

  it("read_screen reports the surface column + workspace column_count inline (F7)", async () => {
    // Simulates the real cmux bug: surface.list is unfiltered (every per-pane
    // query returns the WHOLE workspace list). The column must still be correct
    // via pane_id membership, NOT first-seen attribution.
    const fullList = {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      surfaces: [
        {
          id: "surface-left-id",
          pane_id: "pane-left-id",
          ref: "surface:left",
          title: "left",
          type: "terminal",
          index: 0,
          selected: false,
        },
        {
          id: "surface-right-id",
          pane_id: "pane-right-id",
          ref: "surface:right",
          title: "rightAgent",
          type: "terminal",
          index: 1,
          selected: true,
        },
      ],
    };
    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:right",
        text: "right pane content\n",
        lines: 20,
        scrollback_used: false,
      }),
      listWorkspaces: vi
        .fn()
        .mockResolvedValue({ workspaces: [{ ref: "workspace:1" }] }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            id: "pane-left-id",
            index: 0,
            surface_refs: ["surface:left"],
            surface_ids: ["surface-left-id"],
            pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
          },
          {
            ref: "pane:right",
            id: "pane-right-id",
            index: 1,
            surface_refs: ["surface:right"],
            surface_ids: ["surface-right-id"],
            pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
          },
        ],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue(fullList),
    } as any;

    const server = createServer({
      client: mockClient,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["read_screen"];
    const result = await tool.handler(
      { surface: "surface:right", workspace: "workspace:1" },
      {} as any,
    );
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(data.column).toBe(1);
    expect(data.column_count).toBe(2);
    expect(result.content[0].text).toContain("col 2/2");
  });

  it("read_screen omits column when pane geometry is unavailable but still returns the screen (F7)", async () => {
    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:1",
        text: "screen content\n",
        lines: 20,
        scrollback_used: false,
      }),
      listWorkspaces: vi
        .fn()
        .mockResolvedValue({ workspaces: [{ ref: "workspace:1" }] }),
      // geometry unavailable: listPanes fails — column resolution must degrade.
      listPanes: vi.fn().mockRejectedValue(new Error("no panes")),
      listPaneSurfaces: vi.fn().mockRejectedValue(new Error("no surfaces")),
    } as any;

    const server = createServer({
      client: mockClient,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["read_screen"];
    const result = await tool.handler(
      { surface: "surface:1", workspace: "workspace:1" },
      {} as any,
    );
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(data.column).toBeNull();
    expect(data.column_count).toBeNull();
    // Lean default: no parsed.response → cleaned screen_preview carries the content.
    expect(data.content).toBeUndefined();
    expect(data.screen_preview).toBe("screen content");
    expect(result.content[0].text).not.toContain("col ");
  });

  it("send_input handler calls cmux send", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_input"];

    const result = await tool.handler(
      { surface: "surface:1", text: "echo hello" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("send_input with press_enter sends key after text", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_input"];

    await tool.handler(
      { surface: "surface:1", text: "ls", press_enter: true },
      {} as any,
    );

    // Should preflight the screen, then send, press enter, and verify submit.
    expect(mockExec).toHaveBeenCalledTimes(4);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      "cmux",
      expect.arrayContaining(["read-screen"]),
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "cmux",
      expect.arrayContaining(["send"]),
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      3,
      "cmux",
      expect.arrayContaining(["send-key"]),
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      4,
      "cmux",
      expect.arrayContaining(["read-screen"]),
    );
  });

  it("send_command sends text and return to the same surface", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_command"];

    const result = await tool.handler(
      { surface: "surface:6", command: "codex resume 123" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledTimes(3);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      "cmux",
      expect.arrayContaining(["read-screen", "--surface", "surface:6"]),
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:6"]),
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      3,
      "cmux",
      expect.arrayContaining(["send-key", "--surface", "surface:6", "return"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.surface).toBe("surface:6");
  });

  it("send_input background reads 'delivering' (not FAILED) while in flight (F8)", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-f8-send-input-background");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir,
    });
    const tool = (server as any)._registeredTools["send_input"];
    const result = await tool.handler(
      { surface: "surface:7", text: "hi", background: true },
      {} as any,
    );
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(data.status).toBe("delivering");
    expect(typeof data.delivery_id).toBe("string");
    expect(result.content[0].text).toContain("delivering to surface:7");
    expect(result.content[0].text).not.toContain("FAILED");
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("send_input returns delivered + cheap target identity from the state cache (F8)", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-f8-send-input");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "bl-lead-1",
      surface_id: "surface:95",
      state: "idle",
      repo: "brainlayer",
      model: "Opus 4.8",
      cli: "claude",
      cli_session_id: null,
      task_summary: "BL-LEAD",
      pid: null,
      version: 1,
      created_at: "2026-06-04T00:00:00Z",
      updated_at: "2026-06-04T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    });

    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({
      exec: mockExec,
      stateDir,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["send_input"];
    const result = await tool.handler(
      { surface: "surface:95", text: "hi" },
      {} as any,
    );
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(data.delivered).toBe(true);
    expect(data.surface).toBe("surface:95");
    expect(data.title).toBe("BL-LEAD");
    expect(data.model).toBe("Opus 4.8");
    expect(data.agent_type).toBe("claude");
    expect(result.content[0].text).toContain("delivered to BL-LEAD");
    expect(result.content[0].text).toContain("Opus 4.8");
    expect(result.content[0].text).toContain("claude");
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("send_input degrades gracefully when no identity is cached (F8)", async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_input"];
    const result = await tool.handler(
      { surface: "surface:unknown", text: "hi" },
      {} as any,
    );
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(data.delivered).toBe(true);
    expect(data.surface).toBe("surface:unknown");
    expect(data.title).toBeUndefined();
    expect(data.model).toBeUndefined();
    expect(data.agent_type).toBeUndefined();
    expect(result.content[0].text).toContain("delivered to surface:unknown");
  });

  it("send_command returns delivered + identity + submit_verified (F8)", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-f8-send-command");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "codex-1",
      surface_id: "surface:6",
      state: "idle",
      repo: "cmuxlayer",
      model: "GPT-5.5",
      cli: "codex",
      cli_session_id: null,
      task_summary: "cmuxlayerCodex",
      pid: null,
      version: 1,
      created_at: "2026-06-04T00:00:00Z",
      updated_at: "2026-06-04T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    });

    const mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({
      exec: mockExec,
      stateDir,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["send_command"];
    const result = await tool.handler(
      { surface: "surface:6", command: "codex resume 123" },
      {} as any,
    );
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(data.delivered).toBe(true);
    expect(data.surface).toBe("surface:6");
    expect(data.title).toBe("cmuxlayerCodex");
    expect(data.model).toBe("GPT-5.5");
    expect(data.agent_type).toBe("codex");
    expect("submit_verified" in data).toBe(true);
    expect(result.content[0].text).toContain("delivered to cmuxlayerCodex");
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("move_surface returns a slim, phone-readable confirmation (F8)", async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        workspace: "workspace:1",
        surface: "surface:102",
        pane: "pane:1",
        // verbose passthrough that should NOT leak into the slim response:
        window_ref: "window:1",
        surfaces: [{ ref: "surface:102" }],
      }),
      stderr: "",
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["move_surface"];
    const result = await tool.handler(
      { surface: "surface:102", pane: "pane:1" },
      {} as any,
    );
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(Object.keys(data).sort()).toEqual([
      "ok",
      "pane",
      "surface",
      "workspace",
    ]);
    expect(data.surface).toBe("surface:102");
    expect(data.pane).toBe("pane:1");
    expect(result.content[0].text).toContain("moved surface:102 → pane:1");
  });

  it("send_command rejects boot_prompt_path for non-launcher commands before sending", async () => {
    const promptPath = join(CHANNEL_TEST_DIR, "mandate.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_command"];

    const result = await tool.handler(
      {
        surface: "surface:1",
        command: "echo hello",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("launcher");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("send_command sends boot_prompt_path contents after launcher readiness", async () => {
    const promptPath = join(CHANNEL_TEST_DIR, "mandate.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");
    let promptSent = false;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:1",
            text: promptSent
              ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
              : "codex> ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      if (
        args.includes("send") &&
        String(args.at(-1) ?? "") === "boot prompt"
      ) {
        promptSent = true;
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_command"];

    const result = await tool.handler(
      {
        surface: "surface:1",
        command: "brainlayerCodex -s",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:1",
        "brainlayerCodex -s",
      ]),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1", "boot prompt"]),
    );
  });

  it("send_command accepts a cleared Claude boot prompt before a working marker streams", async () => {
    const promptPath = join(CHANNEL_TEST_DIR, "slow-claude.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");
    let promptSent = false;
    let returnPresses = 0;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:1",
            text: "Claude Code\nWhat can I help you with?\n>",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
      }
      if (
        args.includes("send") &&
        String(args.at(-1) ?? "") === "boot prompt"
      ) {
        promptSent = true;
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_command"];

    const result = await tool.handler(
      {
        surface: "surface:1",
        command: "brainlayerClaude -s",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(parsed.boot_prompt_submit_verified).toBe(true);
    expect(promptSent).toBe(true);
    expect(returnPresses).toBe(3);
  }, 10_000);

  it("send_command reports timeout with last screen lines and leaves launcher surface alive", async () => {
    const promptPath = join(CHANNEL_TEST_DIR, "mandate.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:1",
            text: "line 1\nline 2\n$ waiting",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_command"];

    const result = await tool.handler(
      {
        surface: "surface:1",
        command: "brainlayerCodex -s",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 20,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Timed out");
    expect(parsed.last_10_lines).toContain("$ waiting");
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:1",
        "brainlayerCodex -s",
      ]),
    );
  });

  it("send_command does not treat another CLI prompt as launcher readiness", async () => {
    const promptPath = join(CHANNEL_TEST_DIR, "mandate.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:1",
            text: "codex> ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_command"];

    const result = await tool.handler(
      {
        surface: "surface:1",
        command: "brainlayerClaude -s",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 20,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1", "boot prompt"]),
    );
  });

  it("send_command requires consecutive low-confidence ready matches", async () => {
    const promptPath = join(CHANNEL_TEST_DIR, "mandate.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");
    let reads = 0;
    let readsWhenBootPromptSent: number | null = null;
    let promptSent = false;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        reads += 1;
        return {
          stdout: JSON.stringify({
            surface: "surface:1",
            text: promptSent
              ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
              : reads === 1
                ? "Gemini CLI\nbooting\n>"
                : "Gemini CLI\nready\n>",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      if (
        args.includes("send") &&
        String(args.at(-1) ?? "") === "boot prompt"
      ) {
        readsWhenBootPromptSent = reads;
        promptSent = true;
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_command"];

    const result = await tool.handler(
      {
        surface: "surface:1",
        command: "brainlayerGemini -s",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(readsWhenBootPromptSent).toBe(3);
    expect(reads).toBe(4);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:1", "boot prompt"]),
    );
  });

  it("send_input chunks long text transparently before sending", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_input"];
    const longText = [
      "abcdef".repeat(20),
      "ghijkl".repeat(20),
      "mnopqr".repeat(20),
      "stuvwx".repeat(20),
      "yz1234".repeat(20),
    ].join("\n");

    const result = await tool.handler(
      { surface: "surface:1", text: longText, chunk_size: 120 },
      {} as any,
    );

    const setBufferCalls = mockExec.mock.calls.filter(([, args]) =>
      args.includes("set-buffer"),
    );
    const pasteBufferCalls = mockExec.mock.calls.filter(([, args]) =>
      args.includes("paste-buffer"),
    );
    expect(setBufferCalls).toHaveLength(5);
    expect(pasteBufferCalls).toHaveLength(5);
    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("send")),
    ).toHaveLength(0);
    for (const [index, call] of setBufferCalls.entries()) {
      expect(call[0]).toBe("cmux");
      expect(call[1]).toEqual(expect.arrayContaining(["set-buffer"]));
      const chunk = call[1][call[1].length - 1];
      expect(typeof chunk).toBe("string");
      expect((chunk as string).length).toBeLessThanOrEqual(121);
      if (index < setBufferCalls.length - 1) {
        expect((chunk as string).endsWith("\n")).toBe(true);
      }
    }

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("send_input submits chunked multiline text as one receiver message", async () => {
    const buffers = new Map<string, string>();
    let composer = "";
    const submittedMessages: string[] = [];
    const submitComposer = () => {
      submittedMessages.push(composer);
      composer = "";
    };
    const typeCmuxSendText = (text: string) => {
      for (const char of text) {
        if (char === "\n" || char === "\r") {
          submitComposer();
        } else {
          composer += char;
        }
      }
    };
    mockExec = vi.fn().mockImplementation((_cmd, args: string[]) => {
      if (args.includes("set-buffer")) {
        const nameIndex = args.indexOf("--name");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : "default";
        buffers.set(name, args[args.length - 1]);
        return Promise.resolve({ stdout: "{}", stderr: "" });
      }
      if (args.includes("paste-buffer")) {
        const nameIndex = args.indexOf("--name");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : "default";
        composer += buffers.get(name) ?? "";
        return Promise.resolve({ stdout: "{}", stderr: "" });
      }
      if (args.includes("send-key")) {
        const key = args[args.length - 1];
        if (key === "return" || key === "enter") {
          submitComposer();
        }
        return Promise.resolve({ stdout: "{}", stderr: "" });
      }
      if (args.includes("send")) {
        typeCmuxSendText(args[args.length - 1]);
        return Promise.resolve({ stdout: "{}", stderr: "" });
      }
      return Promise.resolve({ stdout: "{}", stderr: "" });
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_input"];
    const longText = [
      "section-one ".repeat(12),
      "section-two ".repeat(12),
      "section-three ".repeat(12),
      "section-four ".repeat(12),
      "section-five ".repeat(12),
    ].join("\n");

    const result = await tool.handler(
      {
        surface: "surface:1",
        text: longText,
        chunk_size: 120,
        press_enter: true,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(submittedMessages).toEqual([longText]);
  });

  it("send_input fails instead of falling back to send when paste delivery is unsupported", async () => {
    const unsupportedPaste = Object.assign(new Error("method unavailable"), {
      code: "method_not_found",
    });
    const mockClient = {
      send: vi.fn().mockResolvedValue(undefined),
      pasteText: vi.fn().mockRejectedValue(unsupportedPaste),
    };
    const server = createServer({
      client: mockClient as any,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["send_input"];
    const longText = "fallback ".repeat(90);

    const result = await tool.handler(
      { surface: "surface:1", text: longText, chunk_size: 120 },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(parsed.error).toContain("paste delivery is required");
    expect(mockClient.pasteText).toHaveBeenCalled();
    expect(mockClient.send).not.toHaveBeenCalled();
  });

  it("send_input fails instead of falling back to send when pasteText is absent", async () => {
    const mockClient = {
      send: vi.fn().mockResolvedValue(undefined),
    };
    const server = createServer({
      client: mockClient as any,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["send_input"];
    const longText = "fallback ".repeat(90);

    const result = await tool.handler(
      { surface: "surface:1", text: longText, chunk_size: 120 },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(parsed.error).toContain("client does not support pasteText");
    expect(mockClient.send).not.toHaveBeenCalled();
  });

  it("send_input can deliver long text in the background and expose status via read_screen", async () => {
    vi.useFakeTimers();
    mockExec = vi.fn().mockImplementation((_cmd, args) => {
      if (args.includes("read-screen")) {
        return Promise.resolve({
          stdout: JSON.stringify({
            surface_ref: "surface:1",
            text: "$ ",
            lines: 1,
          }),
          stderr: "",
        });
      }
      if (args.includes("list-workspaces")) {
        return Promise.resolve({
          stdout: JSON.stringify({ workspaces: [] }),
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "{}", stderr: "" });
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const sendTool = registeredTools["send_input"];
    const readTool = registeredTools["read_screen"];
    const longText = [
      "abcdef".repeat(20),
      "ghijkl".repeat(20),
      "mnopqr".repeat(20),
      "stuvwx".repeat(20),
      "yz1234".repeat(20),
    ].join("\n");

    const result = await sendTool.handler(
      {
        surface: "surface:1",
        text: longText,
        chunk_size: 120,
        background: true,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe("delivering");
    expect(parsed.delivery_id).toEqual(expect.any(String));
    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("paste-buffer")),
    ).toHaveLength(0);

    const readWhileDelivering = await readTool.handler(
      { surface: "surface:1", parsed_only: true },
      {} as any,
    );
    const readWhileDeliveringParsed =
      readWhileDelivering.structuredContent ??
      JSON.parse(readWhileDelivering.content[0].text);
    expect(readWhileDeliveringParsed.delivery).toMatchObject({
      delivery_id: parsed.delivery_id,
      status: "delivering",
      sent_chunks: 0,
      total_chunks: 5,
    });

    for (let i = 0; i < 50; i++) {
      await advanceTimers(5);
      if (
        mockExec.mock.calls.filter(([, args]) => args.includes("paste-buffer"))
          .length === 5
      ) {
        break;
      }
    }

    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("paste-buffer")),
    ).toHaveLength(5);

    await Promise.resolve();

    const readAfterDelivery = await readTool.handler(
      { surface: "surface:1", parsed_only: true },
      {} as any,
    );
    const readAfterDeliveryParsed =
      readAfterDelivery.structuredContent ??
      JSON.parse(readAfterDelivery.content[0].text);
    expect(readAfterDeliveryParsed.delivery).toMatchObject({
      delivery_id: parsed.delivery_id,
      status: "delivered",
      sent_chunks: 5,
      total_chunks: 5,
    });
  });

  it("send_input background mode blocks the same surface but allows other surfaces", async () => {
    vi.useFakeTimers();
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_input"];
    const longText = [
      "abcdef".repeat(20),
      "ghijkl".repeat(20),
      "mnopqr".repeat(20),
      "stuvwx".repeat(20),
      "yz1234".repeat(20),
    ].join("\n");

    const first = await tool.handler(
      {
        surface: "surface:1",
        text: longText,
        chunk_size: 120,
        background: true,
      },
      {} as any,
    );
    const firstParsed =
      first.structuredContent ?? JSON.parse(first.content[0].text);
    expect(firstParsed.status).toBe("delivering");

    const sameSurface = await tool.handler(
      { surface: "surface:1", text: "echo nope" },
      {} as any,
    );
    expect(sameSurface.isError).toBe(true);
    const sameSurfaceParsed =
      sameSurface.structuredContent ?? JSON.parse(sameSurface.content[0].text);
    expect(sameSurfaceParsed.error).toMatch(/delivery.*in progress/i);

    const otherSurface = await tool.handler(
      { surface: "surface:2", text: "echo ok" },
      {} as any,
    );
    const otherSurfaceParsed =
      otherSurface.structuredContent ??
      JSON.parse(otherSurface.content[0].text);
    expect(otherSurfaceParsed.ok).toBe(true);
    expect(otherSurfaceParsed.surface).toBe("surface:2");
  });

  it("send_input rejects concurrent foreground sends on the same surface", async () => {
    let releaseSend:
      | ((value: { stdout: string; stderr: string }) => void)
      | null = null;
    mockExec = vi.fn().mockImplementation((_cmd, args) => {
      if (args.includes("send") && !releaseSend) {
        return new Promise((resolve) => {
          releaseSend = resolve;
        });
      }
      return Promise.resolve({ stdout: "{}", stderr: "" });
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_input"];

    const firstPromise = tool.handler(
      { surface: "surface:1", text: "echo first" },
      {} as any,
    );
    for (let attempt = 0; attempt < 10 && !releaseSend; attempt += 1) {
      await Promise.resolve();
    }
    expect(releaseSend).toBeTruthy();

    const second = await tool.handler(
      { surface: "surface:1", text: "echo second" },
      {} as any,
    );
    expect(second.isError).toBe(true);
    const secondParsed =
      second.structuredContent ?? JSON.parse(second.content[0].text);
    expect(secondParsed.error).toMatch(/surface surface:1 is busy/i);

    releaseSend?.({ stdout: "{}", stderr: "" });
    const first = await firstPromise;
    const firstParsed =
      first.structuredContent ?? JSON.parse(first.content[0].text);
    expect(firstParsed.ok).toBe(true);
  });

  it("background delivery blocks other same-surface write tools", async () => {
    vi.useFakeTimers();
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const sendInput = registeredTools["send_input"];
    const sendKey = registeredTools["send_key"];
    const renameTab = registeredTools["rename_tab"];
    const longText = [
      "abcdef".repeat(20),
      "ghijkl".repeat(20),
      "mnopqr".repeat(20),
      "stuvwx".repeat(20),
      "yz1234".repeat(20),
    ].join("\n");

    await sendInput.handler(
      {
        surface: "surface:1",
        text: longText,
        chunk_size: 120,
        background: true,
      },
      {} as any,
    );

    const keyResult = await sendKey.handler(
      { surface: "surface:1", key: "return" },
      {} as any,
    );
    expect(keyResult.isError).toBe(true);
    const keyParsed =
      keyResult.structuredContent ?? JSON.parse(keyResult.content[0].text);
    expect(keyParsed.error).toMatch(/delivery.*in progress/i);

    const renameResult = await renameTab.handler(
      { surface: "surface:1", title: "blocked" },
      {} as any,
    );
    expect(renameResult.isError).toBe(true);
    const renameParsed =
      renameResult.structuredContent ??
      JSON.parse(renameResult.content[0].text);
    expect(renameParsed.error).toMatch(/delivery.*in progress/i);
  });

  it("send_key normalizes Ctrl+C aliases before dispatch", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_key"];

    const result = await tool.handler(
      { surface: "surface:1", key: "Ctrl+C" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send-key", "--surface", "surface:1", "ctrl-c"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.key).toBe("ctrl-c");
  });

  it("send_input retries a transient socket failure before succeeding", async () => {
    let sendAttempts = 0;
    mockExec = vi.fn().mockImplementation((_cmd, args) => {
      if (args.includes("send")) {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          return Promise.reject(
            new Error("socket closed before receiving response"),
          );
        }
      }
      return Promise.resolve({ stdout: "{}", stderr: "" });
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_input"];

    const resultPromise = tool.handler(
      { surface: "surface:1", text: "echo retry me" },
      {} as any,
    );

    const result = await resultPromise;
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(sendAttempts).toBe(2);
  });

  it("send_input reports the failed chunk when retries are exhausted", async () => {
    let sendAttempts = 0;
    mockExec = vi.fn().mockImplementation((_cmd, args) => {
      if (args.includes("send")) {
        sendAttempts += 1;
        return Promise.reject(new Error("socket connection_error"));
      }
      return Promise.resolve({ stdout: "{}", stderr: "" });
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["send_input"];

    const resultPromise = tool.handler(
      { surface: "surface:1", text: "echo fail me" },
      {} as any,
    );

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.failed_chunk).toBe(1);
    expect(parsed.error).toMatch(/chunk 1\/1 failed/i);
    expect(sendAttempts).toBe(3);
  });

  it("new_split handler calls cmux new-split", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:2",
        pane: "pane:1",
        title: "New",
        type: "terminal",
      }),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["new_split"];

    const result = await tool.handler({ direction: "right" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-split", "right"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:2");
  });

  it("new_split inherits workspace from a launcher-style title repo", async () => {
    const mockClient = {
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:brainlayer",
            title: "BrainLayer",
            current_directory: "/Users/etanheyman/Gits/brainlayer",
          },
          {
            ref: "workspace:voice",
            title: "VoiceLayer",
            current_directory: "/Users/etanheyman/Gits/voicelayer",
          },
        ],
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:voice",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:voice",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:shell"],
            selected_surface_ref: "surface:shell",
          },
        ],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:voice",
        window_ref: "window:1",
        pane_ref: "pane:voice",
        surfaces: [
          {
            ref: "surface:shell",
            title: "shell",
            type: "terminal",
            index: 0,
            selected: true,
          },
        ],
      }),
      newSplit: vi.fn().mockResolvedValue({
        workspace: "workspace:voice",
        surface: "surface:voice-worker",
        pane: "pane:worker",
        title: "",
        type: "terminal",
      }),
      newSurface: vi.fn().mockResolvedValue({
        workspace: "workspace:voice",
        surface: "surface:voice-orchestrator",
        pane: "pane:voice",
        title: "",
        type: "terminal",
      }),
      renameTab: vi.fn().mockResolvedValue(undefined),
    };
    const server = createServer({
      client: mockClient as any,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", title: "voicelayerCodex", role: "worker" },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(mockClient.listPanes).toHaveBeenCalledWith({
      workspace: "workspace:voice",
    });
    expect(mockClient.newSplit).toHaveBeenCalledWith(
      "right",
      expect.objectContaining({
        workspace: "workspace:voice",
        title: "voicelayerCodex",
      }),
    );
  });

  it("new_split inherits workspace from a task-suffixed launcher title repo", async () => {
    const mockClient = {
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:brainlayer",
            title: "BrainLayer",
            current_directory: "/Users/etanheyman/Gits/brainlayer",
          },
          {
            ref: "workspace:voice",
            title: "VoiceLayer",
            current_directory: "/Users/etanheyman/Gits/voicelayer",
          },
        ],
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:voice",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:voice",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:shell"],
            selected_surface_ref: "surface:shell",
          },
        ],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:voice",
        window_ref: "window:1",
        pane_ref: "pane:voice",
        surfaces: [
          {
            ref: "surface:shell",
            title: "shell",
            type: "terminal",
            index: 0,
            selected: true,
          },
        ],
      }),
      newSplit: vi.fn().mockResolvedValue({
        workspace: "workspace:voice",
        surface: "surface:voice-worker",
        pane: "pane:worker",
        title: "",
        type: "terminal",
      }),
      newSurface: vi.fn().mockResolvedValue({
        workspace: "workspace:voice",
        surface: "surface:voice-orchestrator",
        pane: "pane:voice",
        title: "",
        type: "terminal",
      }),
      renameTab: vi.fn().mockResolvedValue(undefined),
    };
    const server = createServer({
      client: mockClient as any,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        title: "voicelayerClaude: audit",
        role: "orchestrator",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(mockClient.listPanes).toHaveBeenCalledWith({
      workspace: "workspace:voice",
    });
  });

  it("new_split with role=worker reuses the existing worker pane", async () => {
    const stateDir = join(CHANNEL_TEST_DIR, "new-split-role-state");
    rmSync(stateDir, { recursive: true, force: true });
    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "worker-1",
      surface_id: "surface:worker-1",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      model: "gpt-5.4",
      cli: "codex",
      cli_session_id: null,
      task_summary: "existing worker",
      pid: null,
      version: 1,
      created_at: "2026-05-25T12:00:00.000Z",
      updated_at: "2026-05-25T12:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
      role: "worker",
    });
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "Main",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            panes: [
              {
                ref: "pane:left",
                index: 0,
                focused: false,
                surface_count: 1,
                surface_refs: ["surface:orc"],
              },
              {
                ref: "pane:right",
                index: 1,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:worker-1"],
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        const pane = String(args[args.indexOf("--pane") + 1] ?? "");
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: pane,
            surfaces:
              pane === "pane:right"
                ? [
                    {
                      ref: "surface:worker-1",
                      title: "",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ]
                : [
                    {
                      ref: "surface:orc",
                      title: "",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ],
          }),
          stderr: "",
        };
      }
      if (args.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:right",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      stateDir,
    });
    await Promise.resolve();
    await Promise.resolve();
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:1" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface", "--pane", "pane:right"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:2");
    expect(parsed.role).toBe("worker");
    expect(parsed.placement).toBe("surface");
    expect(parsed.direction).toBeNull();
  });

  it("new_split with role=orchestrator tabs into the left lead pane despite stale IC state", async () => {
    const stateDir = join(CHANNEL_TEST_DIR, "new-split-orchestrator-stale-ic");
    rmSync(stateDir, { recursive: true, force: true });
    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "opus-voicelayer-1780659054-nsnv",
      surface_id: "surface:voicelayer-lead",
      workspace_id: "workspace:1",
      state: "working",
      repo: "voicelayer",
      model: "opus",
      cli: "claude",
      cli_session_id: null,
      task_summary: "stale lead record",
      pid: null,
      version: 1,
      created_at: "2026-06-05T17:00:00.000Z",
      updated_at: "2026-06-05T17:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
      role: "ic",
    });
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:left",
                index: 1,
                focused: false,
                surface_count: 1,
                surface_refs: ["surface:voicelayer-lead"],
                pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
              },
              {
                ref: "pane:right",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:cmuxlayer-worker"],
                pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        const pane = String(args[args.indexOf("--pane") + 1] ?? "");
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: pane,
            surfaces:
              pane === "pane:left"
                ? [
                    {
                      ref: "surface:voicelayer-lead",
                      title: "voicelayerClaude-LEAD",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ]
                : [
                    {
                      ref: "surface:cmuxlayer-worker",
                      title: "cmuxlayerCodex W-B1",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ],
          }),
          stderr: "",
        };
      }
      if (args.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:new-orchestrator",
            pane: "pane:left",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:unexpected-split",
            pane: "pane:third",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      stateDir,
    });
    await Promise.resolve();
    await Promise.resolve();
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", role: "orchestrator", workspace: "workspace:1" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface", "--pane", "pane:left"]),
    );
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-split", "left"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:new-orchestrator");
    expect(parsed.role).toBe("orchestrator");
    expect(parsed.placement).toBe("surface");
    expect(parsed.direction).toBeNull();
  });

  it("new_split with role=worker partitions unfiltered surface lists by pane membership", async () => {
    const stateDir = join(CHANNEL_TEST_DIR, "new-split-unfiltered-surfaces");
    rmSync(stateDir, { recursive: true, force: true });
    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "worker-1",
      surface_id: "surface:worker-1",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      model: "gpt-5.4",
      cli: "codex",
      cli_session_id: null,
      task_summary: "existing worker",
      pid: null,
      version: 1,
      created_at: "2026-05-25T12:00:00.000Z",
      updated_at: "2026-05-25T12:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
      role: "worker",
    });
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:left",
                id: "pane-left-id",
                index: 0,
                focused: false,
                surface_count: 1,
                surface_refs: ["surface:orc"],
                surface_ids: ["surface-orc-id"],
                pixel_frame: { x: 0, y: 0, width: 500, height: 900 },
              },
              {
                ref: "pane:right",
                id: "pane-right-id",
                index: 1,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:worker-1"],
                surface_ids: ["surface-worker-id"],
                pixel_frame: { x: 500, y: 0, width: 500, height: 900 },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            surfaces: [
              {
                id: "surface-orc-id",
                pane_id: "pane-left-id",
                ref: "surface:orc",
                title: "orc",
                type: "terminal",
                index: 0,
                selected: true,
              },
              {
                id: "surface-worker-id",
                pane_id: "pane-right-id",
                ref: "surface:worker-1",
                title: "worker",
                type: "terminal",
                index: 1,
                selected: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:right",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:unexpected-split",
            pane: "pane:third",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      stateDir,
    });
    await Promise.resolve();
    await Promise.resolve();
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:1" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface", "--pane", "pane:right"]),
    );
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-split"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:2");
    expect(parsed.placement).toBe("surface");
  });

  it("new_split ignores disk-only role state when no live lifecycle registry is available", async () => {
    const stateDir = join(CHANNEL_TEST_DIR, "new-split-stale-role-state");
    rmSync(stateDir, { recursive: true, force: true });
    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "stale-worker",
      surface_id: "surface:recycled",
      workspace_id: "workspace:1",
      state: "working",
      repo: "old-repo",
      model: "gpt-5.4",
      cli: "codex",
      cli_session_id: null,
      task_summary: "stale worker",
      pid: null,
      version: 1,
      created_at: "2026-05-25T12:00:00.000Z",
      updated_at: "2026-05-25T12:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
      role: "worker",
    });
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            panes: [
              {
                ref: "pane:only",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:recycled"],
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:only",
            surfaces: [
              {
                ref: "surface:recycled",
                title: "manual shell",
                type: "terminal",
                index: 0,
                selected: true,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:new-worker",
            pane: "pane:right",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir,
    });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:1" },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:new-worker");
    expect(parsed.placement).toBe("split");
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface", "--pane", "pane:only"]),
    );
  });

  it("new_split remembers role-created surfaces for subsequent placement", async () => {
    const stateDir = join(CHANNEL_TEST_DIR, "new-split-role-memory-state");
    rmSync(stateDir, { recursive: true, force: true });
    let workerSurface: string | null = null;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            panes: workerSurface
              ? [
                  {
                    ref: "pane:left",
                    index: 0,
                    focused: false,
                    surface_count: 1,
                    surface_refs: ["surface:orc"],
                  },
                  {
                    ref: "pane:right",
                    index: 1,
                    focused: true,
                    surface_count: 1,
                    surface_refs: [workerSurface],
                  },
                ]
              : [
                  {
                    ref: "pane:left",
                    index: 0,
                    focused: true,
                    surface_count: 1,
                    surface_refs: ["surface:orc"],
                  },
                ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        const pane = String(args[args.indexOf("--pane") + 1] ?? "");
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: pane,
            surfaces:
              pane === "pane:right" && workerSurface
                ? [
                    {
                      ref: workerSurface,
                      title: "",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ]
                : [
                    {
                      ref: "surface:orc",
                      title: "",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ],
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split")) {
        workerSurface = "surface:worker-created";
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: workerSurface,
            pane: "pane:right",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:worker-tab",
            pane: "pane:right",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir,
    });
    const tool = (server as any)._registeredTools["new_split"];

    const first = await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:1" },
      {} as any,
    );
    const firstParsed =
      first.structuredContent ?? JSON.parse(first.content[0].text);
    expect(firstParsed.surface).toBe("surface:worker-created");
    expect(firstParsed.placement).toBe("split");

    const second = await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:1" },
      {} as any,
    );
    const secondParsed =
      second.structuredContent ?? JSON.parse(second.content[0].text);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface", "--pane", "pane:right"]),
    );
    expect(secondParsed.surface).toBe("surface:worker-tab");
    expect(secondParsed.placement).toBe("surface");
    expect(secondParsed.direction).toBeNull();
  });

  it("new_split does not prune role overrides from other workspaces", async () => {
    const stateDir = join(CHANNEL_TEST_DIR, "new-split-role-workspace-state");
    rmSync(stateDir, { recursive: true, force: true });
    let workerSurfaceWorkspace1: string | null = null;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      const workspace = args.includes("--workspace")
        ? String(args[args.indexOf("--workspace") + 1])
        : "workspace:1";
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: workspace,
            panes:
              workspace === "workspace:1" && workerSurfaceWorkspace1
                ? [
                    {
                      ref: "pane:w1-left",
                      index: 0,
                      focused: false,
                      surface_count: 1,
                      surface_refs: ["surface:w1-orc"],
                    },
                    {
                      ref: "pane:w1-right",
                      index: 1,
                      focused: true,
                      surface_count: 1,
                      surface_refs: [workerSurfaceWorkspace1],
                    },
                  ]
                : [
                    {
                      ref: `${workspace}:pane:only`,
                      index: 0,
                      focused: true,
                      surface_count: 1,
                      surface_refs: [`${workspace}:surface:manual`],
                    },
                  ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        const pane = String(args[args.indexOf("--pane") + 1] ?? "");
        const surfaces =
          pane === "pane:w1-right" && workerSurfaceWorkspace1
            ? [
                {
                  ref: workerSurfaceWorkspace1,
                  title: "",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ]
            : [
                {
                  ref: pane.includes("workspace:2")
                    ? "workspace:2:surface:manual"
                    : "surface:w1-orc",
                  title: "",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ];
        return {
          stdout: JSON.stringify({
            workspace_ref: workspace,
            window_ref: "window:1",
            pane_ref: pane,
            surfaces,
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split")) {
        const surface =
          workspace === "workspace:1" && !workerSurfaceWorkspace1
            ? "surface:w1-worker"
            : "surface:w2-worker";
        if (workspace === "workspace:1") {
          workerSurfaceWorkspace1 = surface;
        }
        return {
          stdout: JSON.stringify({
            workspace,
            surface,
            pane:
              workspace === "workspace:1" ? "pane:w1-right" : "pane:w2-right",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:w1-worker-tab",
            pane: "pane:w1-right",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir,
    });
    const tool = (server as any)._registeredTools["new_split"];

    await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:1" },
      {} as any,
    );
    await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:2" },
      {} as any,
    );
    const third = await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:1" },
      {} as any,
    );

    const parsed = third.structuredContent ?? JSON.parse(third.content[0].text);
    expect(parsed.surface).toBe("surface:w1-worker-tab");
    expect(parsed.placement).toBe("surface");
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface", "--pane", "pane:w1-right"]),
    );
  });

  it("new_split does not remember browser surfaces as role panes", async () => {
    const stateDir = join(CHANNEL_TEST_DIR, "new-split-browser-role-state");
    rmSync(stateDir, { recursive: true, force: true });
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            panes: [
              {
                ref: "pane:browser",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:browser-codex"],
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:browser",
            surfaces: [
              {
                ref: "surface:browser-codex",
                title: "researchCodex",
                type: "browser",
                index: 0,
                selected: true,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split") && args.includes("browser")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:browser-codex",
            pane: "pane:browser",
            title: "researchCodex",
            type: "browser",
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:worker-split",
            pane: "pane:worker",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:unexpected-tab",
            pane: "pane:browser",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir,
    });
    const tool = (server as any)._registeredTools["new_split"];

    await tool.handler(
      {
        direction: "right",
        type: "browser",
        role: "worker",
        url: "https://example.com",
        workspace: "workspace:1",
      },
      {} as any,
    );
    const workerResult = await tool.handler(
      { direction: "right", role: "worker", workspace: "workspace:1" },
      {} as any,
    );
    const parsed =
      workerResult.structuredContent ??
      JSON.parse(workerResult.content[0].text);

    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface"]),
    );
    expect(parsed.surface).toBe("surface:worker-split");
    expect(parsed.placement).toBe("split");
    expect(parsed.direction).toBe("right");
  });

  it("new_split with role rejects explicit pane targets", async () => {
    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        role: "worker",
        pane: "pane:manual",
        workspace: "workspace:1",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/pane\/surface cannot be combined/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("new_split with launcher-style title honors explicit pane when role is omitted", async () => {
    mockExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:manual",
          surfaces: [
            {
              ref: "surface:manual-anchor",
              title: "existing",
              type: "terminal",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace: "workspace:1",
          surface: "surface:manual-title",
          pane: "pane:manual",
          title: "brainlayerCodex",
          type: "terminal",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
      });
    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        title: "brainlayerCodex",
        pane: "pane:manual",
        workspace: "workspace:1",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.role).toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "new-split",
        "right",
        "--surface",
        "surface:manual-anchor",
      ]),
    );
  });

  it("new_split with role=worker rejects focus=false when placement becomes a tab", async () => {
    const stateDir = join(CHANNEL_TEST_DIR, "new-split-role-focus-state");
    rmSync(stateDir, { recursive: true, force: true });
    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "worker-1",
      surface_id: "surface:worker-1",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      model: "gpt-5.4",
      cli: "codex",
      cli_session_id: null,
      task_summary: "existing worker",
      pid: null,
      version: 1,
      created_at: "2026-05-25T12:00:00.000Z",
      updated_at: "2026-05-25T12:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
      role: "worker",
    });
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "Main",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            panes: [
              {
                ref: "pane:right",
                index: 1,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:worker-1"],
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:right",
            surfaces: [
              {
                ref: "surface:worker-1",
                title: "",
                type: "terminal",
                index: 0,
                selected: true,
              },
            ],
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      stateDir,
    });
    await Promise.resolve();
    await Promise.resolve();
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        role: "worker",
        workspace: "workspace:1",
        focus: false,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("focus=false");
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface"]),
    );
  });

  it("new_split rejects missing boot_prompt_path before creating a pane", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:2",
        pane: "pane:1",
        title: "New",
        type: "terminal",
      }),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: join(CHANNEL_TEST_DIR, "missing.md"),
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("ENOENT");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("new_split reports boot prompt timeout with surface and last screen lines", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-mandate.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text: "line 1\nline 2\n$ waiting",
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 20,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.surface).toBe("surface:2");
    expect(parsed.last_10_lines).toContain("$ waiting");
  });

  it("spawn_agent waits out a Codex auto-update, relaunches after bare shell, then delivers the boot prompt", async () => {
    vi.useRealTimers();
    const previousAllowModel = process.env.REPOGOLEM_ALLOW_MODEL;
    process.env.REPOGOLEM_ALLOW_MODEL = "1";
    const stateDir = join(CHANNEL_TEST_DIR, "spawn-update-relaunch-state");
    const promptPath = join(CHANNEL_TEST_DIR, "spawn-update-relaunch.md");
    const prompt = "boot after update";
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");

    let launcherSends = 0;
    let promptSent = false;
    let returnPresses = 0;
    let readsAfterFirstLaunch = 0;
    const sentTexts: string[] = [];

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "cmuxlayer",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [],
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send")) {
        const text = String(args.at(-1) ?? "");
        sentTexts.push(text);
        if (text.includes("cmuxlayerCodex")) {
          if (launcherSends === 0) {
            delete process.env.REPOGOLEM_ALLOW_MODEL;
          }
          launcherSends += 1;
        } else if (text === prompt) {
          promptSent = true;
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        let text = "$ ";
        if (launcherSends === 1) {
          readsAfterFirstLaunch += 1;
          if (readsAfterFirstLaunch === 1) {
            text = "codex> ";
          } else if (readsAfterFirstLaunch === 2) {
            text = "Updating Codex via bun install -g @openai/codex";
          } else if (readsAfterFirstLaunch === 3) {
            text = "🎉 Update ran successfully! Please restart Codex";
          } else {
            text = "etan@mac % ";
          }
        } else if (launcherSends >= 2 && !promptSent) {
          text = "codex> ";
        } else if (promptSent) {
          text =
            "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)";
        }
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text,
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({
      exec: mockExec,
      stateDir,
      disableSpawnPreflight: true,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    try {
      const result = await tool.handler(
        {
          repo: "cmuxlayer",
          model: "gpt-5.5",
          cli: "codex",
          boot_prompt_path: promptPath,
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      );
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.boot_prompt_delivered).toBe(true);
      expect(launcherSends).toBe(2);
      expect(
        sentTexts.filter((text) => text.includes("cmuxlayerCodex")),
      ).toEqual(["cmuxlayerCodex -s -m gpt-5.5", "cmuxlayerCodex -s"]);
      expect(sentTexts.filter((text) => text === prompt)).toHaveLength(1);
      expect(returnPresses).toBeGreaterThanOrEqual(3);
    } finally {
      if (previousAllowModel === undefined) {
        delete process.env.REPOGOLEM_ALLOW_MODEL;
      } else {
        process.env.REPOGOLEM_ALLOW_MODEL = previousAllowModel;
      }
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 10_000);

  it("new_split times out when a CLI auto-update marker never clears", async () => {
    vi.useFakeTimers();
    const previousUpdateMax = process.env.CMUXLAYER_BOOT_PROMPT_UPDATE_MAX_MS;
    process.env.CMUXLAYER_BOOT_PROMPT_UPDATE_MAX_MS = String(
      BOOT_PROMPT_READY_POLL_MS_FOR_TESTS,
    );
    const promptPath = join(CHANNEL_TEST_DIR, "split-hung-update.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text: "Updating Codex via bun install -g @openai/codex",
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const resultPromise = tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 20,
      },
      {} as any,
    );

    const result = await resultPromise;

    if (previousUpdateMax === undefined) {
      delete process.env.CMUXLAYER_BOOT_PROMPT_UPDATE_MAX_MS;
    } else {
      process.env.CMUXLAYER_BOOT_PROMPT_UPDATE_MAX_MS = previousUpdateMax;
    }

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Timed out waiting for boot prompt readiness");
    expect(parsed.error).toContain(
      `CLI update marker persisted for ${BOOT_PROMPT_READY_POLL_MS_FOR_TESTS}ms`,
    );
    expect(parsed.last_10_lines).toEqual(
      expect.arrayContaining([expect.stringContaining("Updating Codex via")]),
    );
  });

  it("new_split ignores unrelated bare bun install scrollback while waiting for readiness", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-bun-scrollback.md");
    const prompt = "boot prompt";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    let promptSent = false;
    let returnPresses = 0;

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:1",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:2"],
                selected_surface_ref: "surface:2",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:1",
            surfaces: [
              {
                ref: "surface:2",
                title: "cmuxlayerCodex",
                type: "terminal",
                index: 0,
                selected: true,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("send") && !args.includes("send-key")) {
        promptSent = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text: promptSent
              ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
              : "previous shell output: bun install\ncodex> ",
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 50,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(returnPresses).toBe(1);
  }, 10_000);

  it("new_split relaunches a launcher-title terminal after update drops to shell", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-update-relaunch.md");
    const prompt = "boot after update";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");

    let launcherSends = 0;
    let promptSent = false;
    let returnPresses = 0;
    let reads = 0;

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "cmuxlayer",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "cmuxlayerCodex",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:1",
                index: 0,
                focused: true,
                surface_count: 0,
                surface_refs: [],
                selected_surface_ref: null,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:1",
            surfaces: [],
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send")) {
        const text = String(args.at(-1) ?? "");
        if (text.includes("cmuxlayerCodex")) {
          launcherSends += 1;
        } else if (text === prompt) {
          promptSent = true;
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        reads += 1;
        const text =
          launcherSends === 0 && reads === 1
            ? "Updating Codex via bun install -g @openai/codex"
            : launcherSends === 0 && reads === 2
              ? "Please restart Codex\netan@mac % "
              : promptSent
                ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
                : "codex> ";
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text,
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        title: "cmuxlayerCodex",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 50,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(launcherSends).toBe(1);
    expect(returnPresses).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("new_surface relaunches a launcher-title terminal after update drops to shell", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "surface-update-relaunch.md");
    const prompt = "boot after update";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");

    let launcherSends = 0;
    let promptSent = false;
    let returnPresses = 0;
    let reads = 0;

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:3",
            pane: "pane:1",
            title: "cmuxlayerCodex",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send")) {
        const text = String(args.at(-1) ?? "");
        if (text.includes("cmuxlayerCodex")) {
          launcherSends += 1;
        } else if (text === prompt) {
          promptSent = true;
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        reads += 1;
        const text =
          launcherSends === 0 && reads === 1
            ? "Updating Codex via bun install -g @openai/codex"
            : launcherSends === 0 && reads === 2
              ? "Please restart Codex\netan@mac % "
              : promptSent
                ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
                : "codex> ";
        return {
          stdout: JSON.stringify({
            surface: "surface:3",
            text,
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_surface"];

    const result = await tool.handler(
      {
        pane: "pane:1",
        title: "cmuxlayerCodex",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 50,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(launcherSends).toBe(1);
    expect(returnPresses).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("new_split retries Return when the boot prompt clears but the agent does not start working", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-idle-clear-retry.md");
    const prompt = "short boot prompt";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    let returnPresses = 0;
    let promptSent = false;

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send") || args.includes("set-buffer")) {
        promptSent = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        const text =
          promptSent && returnPresses >= 2
            ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
            : "codex> ";
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text,
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(returnPresses).toBe(2);
  }, 10_000);

  it("new_split reports pane_died when the new surface disappears during boot prompt submit verification", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-pane-died.md");
    const prompt = "short boot prompt";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    let promptSent = false;
    let returnPresses = 0;

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send") || args.includes("set-buffer")) {
        promptSent = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        if (promptSent && returnPresses > 0) {
          throw Object.assign(new Error("Command failed"), {
            code: 1,
            stderr: "not_found: Surface not found for the given surface_id",
          });
        }
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text: "codex> ",
            lines: 30,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 50,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("pane_died");
    expect(parsed.error).toContain("surface surface:2 disappeared");
    expect(parsed.surface).toBe("surface:2");
  }, 10_000);

  it("new_split does not classify transient read errors as pane_died during boot prompt fallback", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-transient-read.md");
    const prompt = "short boot prompt";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    let promptSent = false;
    let returnPresses = 0;
    let transientFailureThrown = false;

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send") || args.includes("set-buffer")) {
        promptSent = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        if (!transientFailureThrown) {
          transientFailureThrown = true;
          throw Object.assign(new Error("temporary read unavailable"), {
            stderr: "Surface is not a terminal",
          });
        }
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text:
              promptSent && returnPresses >= 2
                ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
                : promptSent
                  ? `codex> ${prompt}`
                  : "codex> ",
            lines: 30,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(parsed.error_code).toBeUndefined();
    expect(transientFailureThrown).toBe(true);
  }, 10_000);

  it("new_split fails when the boot prompt clears after retry without agent identity", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-idle-after-clear.md");
    const prompt = "short boot prompt";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    let returnPresses = 0;
    let promptSent = false;

    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send")) {
        promptSent = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text:
              !promptSent
                ? "codex> "
                : returnPresses >= 1
                  ? "> "
                  : `> ${prompt}`,
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 50,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Timed out");
    expect(parsed.boot_prompt_delivered).not.toBe(true);
    expect(returnPresses).toBe(2);
  }, 10_000);

  it("new_split fails loudly when a short boot prompt stays pending after submit retry", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-short-dropped-return.md");
    const prompt = "short boot prompt";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    let returnPresses = 0;
    let promptSent = false;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send")) {
        promptSent = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text:
              promptSent && returnPresses > 0
                ? `codex> ${prompt}`
                : "codex> ",
            lines: 30,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Boot prompt delivery failed");
    expect(parsed.error).toContain("Enter submit could not be verified");
    expect(parsed.boot_prompt_delivered).not.toBe(true);
    expect(returnPresses).toBe(2);
  }, 10_000);

  it("new_split reports a short boot prompt delivered after submit verification succeeds", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-short-submitted.md");
    const prompt = "short boot prompt";
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    let returnPresses = 0;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text:
              returnPresses > 0
                ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
                : "codex> ",
            lines: 30,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(returnPresses).toBe(1);
  });

  it("new_split keeps verifying long boot prompts and retries a missed submit", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "split-long-retry.md");
    const prompt = "long boot prompt ".repeat(40);
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, prompt, "utf8");
    let returnPresses = 0;
    let typedText = "";
    let promptSent = false;
    const sendCalls: string[] = [];
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:2",
            pane: "pane:1",
            title: "New",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("send") || args.includes("set-buffer")) {
        const chunk = String(args.at(-1) ?? "");
        sendCalls.push(chunk);
        typedText += chunk;
        promptSent = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        returnPresses += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:2",
            text:
              !promptSent
                ? "codex> "
                : returnPresses === 1
                  ? `codex> ${typedText.slice(-100)}`
                  : "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)",
            lines: 30,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      {
        direction: "right",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(sendCalls.length).toBeGreaterThan(1);
    expect(returnPresses).toBe(2);
  });

  it("new_split renames the new surface when a title is provided", async () => {
    mockExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace: "workspace:1",
          surface: "surface:2",
          pane: "pane:1",
          title: "New",
          type: "terminal",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["new_split"];

    await tool.handler({ direction: "right", title: "Build Task" }, {} as any);

    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "cmux",
      expect.arrayContaining([
        "rename-tab",
        "--surface",
        "surface:2",
        "Build Task",
      ]),
    );
  });

  it("new_surface handler calls cmux new-surface", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:3",
        pane: "pane:1",
        title: "New Tab",
        type: "terminal",
      }),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["new_surface"];

    const result = await tool.handler({ pane: "pane:1" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-surface", "--pane", "pane:1"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:3");
  });

  it("new_surface renames the new surface when a title is provided", async () => {
    mockExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          workspace: "workspace:1",
          surface: "surface:3",
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["new_surface"];

    await tool.handler({ pane: "pane:1", title: "Build Logs" }, {} as any);

    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "cmux",
      expect.arrayContaining([
        "rename-tab",
        "--surface",
        "surface:3",
        "Build Logs",
      ]),
    );
  });

  it("new_surface rejects missing boot_prompt_path before creating a tab", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:3",
        pane: "pane:1",
        title: "New Tab",
        type: "terminal",
      }),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["new_surface"];

    const result = await tool.handler(
      {
        pane: "pane:1",
        boot_prompt_path: join(CHANNEL_TEST_DIR, "missing.md"),
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("ENOENT");
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("new_surface reports boot prompt timeout with surface and last screen lines", async () => {
    vi.useRealTimers();
    const promptPath = join(CHANNEL_TEST_DIR, "surface-mandate.md");
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });
    writeFileSync(promptPath, "boot prompt", "utf8");
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:3",
            pane: "pane:1",
            title: "New Tab",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:3",
            text: "line 1\nline 2\n$ waiting",
            lines: 80,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["new_surface"];

    const result = await tool.handler(
      {
        pane: "pane:1",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 20,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.surface).toBe("surface:3");
    expect(parsed.last_10_lines).toContain("$ waiting");
  });

  it("move_surface handler calls cmux move-surface", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        workspace: "workspace:1",
        surface: "surface:3",
        pane: "pane:2",
      }),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["move_surface"];

    const result = await tool.handler(
      {
        surface: "surface:3",
        pane: "pane:2",
        workspace: "workspace:1",
        index: 1,
        focus: false,
      },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "move-surface",
        "--surface",
        "surface:3",
        "--pane",
        "pane:2",
        "--workspace",
        "workspace:1",
        "--index",
        "1",
        "--focus",
        "false",
      ]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      ok: true,
      surface: "surface:3",
      pane: "pane:2",
      workspace: "workspace:1",
    });
  });

  it("reorder_surface handler calls cmux reorder-surface", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        surface: "surface:3",
      }),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["reorder_surface"];

    const result = await tool.handler(
      { surface: "surface:3", after: "surface:4" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "reorder-surface",
        "--surface",
        "surface:3",
        "--after",
        "surface:4",
      ]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      ok: true,
      surface: "surface:3",
    });
  });

  it("set_status handler calls cmux set-status", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["set_status"];

    const result = await tool.handler(
      { key: "task", value: "building" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-status", "task", "building"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("set_status rejects invalid reserved mode values", async () => {
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["set_status"];

    const result = await tool.handler(
      { key: "mode.control", value: "invalid" },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid control mode/i);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("set_status resolves workspace from the target surface when only surface is provided", async () => {
    mockExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          caller: {
            workspace_ref: "workspace:6",
            surface_ref: "surface:52",
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["set_status"];

    await tool.handler(
      { key: "task", value: "building", surface: "surface:52" },
      {} as any,
    );

    expect(mockExec).toHaveBeenNthCalledWith(1, "cmux", [
      "--json",
      "identify",
      "--surface",
      "surface:52",
    ]);
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "cmux",
      expect.arrayContaining([
        "set-status",
        "task",
        "building",
        "--workspace",
        "workspace:6",
      ]),
    );
  });

  it("close_surface handler calls cmux close-surface", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-close-surface-basic");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
      stateDir,
    });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["close_surface"];

    await tool.handler({ surface: "surface:1" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["close-surface"]),
    );
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("close_surface reports pane collapse when closing the last dedicated worker tab", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-close-surface-layout");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });

    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "worker-1",
      surface_id: "surface:worker-1",
      state: "working",
      repo: "brainlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: null,
      task_summary: "Layout policy",
      pid: null,
      version: 1,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    });

    const mockClient = {
      identify: vi.fn().mockResolvedValue({
        caller: { workspace_ref: "workspace:1" },
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes: [
          {
            ref: "pane:left",
            index: 0,
            focused: true,
            surface_count: 1,
            surface_refs: ["surface:interactive"],
          },
          {
            ref: "pane:right",
            index: 1,
            focused: false,
            surface_count: 1,
            surface_refs: ["surface:worker-1"],
          },
        ],
      }),
      listPaneSurfaces: vi.fn().mockImplementation(async ({ pane }) => ({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: pane,
        surfaces:
          pane === "pane:right"
            ? [
                {
                  ref: "surface:worker-1",
                  title: "worker",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ]
            : [
                {
                  ref: "surface:interactive",
                  title: "interactive",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ],
      })),
      closeSurface: vi.fn().mockResolvedValue(undefined),
    };

    const server = createServer({
      client: mockClient as any,
      stateDir,
      skipAgentLifecycle: true,
    });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["close_surface"];

    // A "working" agent backs this surface, so closing it now requires force;
    // force:true exercises the collapse-policy forwarding path.
    const result = await tool.handler(
      { surface: "surface:worker-1", force: true },
      {} as any,
    );

    expect(mockClient.closeSurface).toHaveBeenCalledWith("surface:worker-1", {
      workspace: undefined,
      collapsePane: true,
    });
    expect(result.structuredContent).toMatchObject({
      surface: "surface:worker-1",
      pane: "pane:right",
      collapse_pane: true,
    });

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("close_surface refuses a live agent without force and returns a pane read", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-close-surface-guard");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });

    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "worker-live",
      surface_id: "surface:worker-live",
      state: "working",
      repo: "brainlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: null,
      task_summary: "mid task",
      pid: null,
      version: 1,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    });

    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:worker-live",
        text: "running tests... 115 passed",
        lines: 1,
        scrollback_used: false,
      }),
      closeSurface: vi.fn().mockResolvedValue(undefined),
    };

    const server = createServer({
      client: mockClient as any,
      stateDir,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["close_surface"];

    const result = await tool.handler(
      { surface: "surface:worker-live" },
      {} as any,
    );

    // The live surface is protected: cmux is never told to close it, and the
    // caller gets the real pane contents to assess instead of a stale state.
    expect(mockClient.closeSurface).not.toHaveBeenCalled();
    expect(mockClient.readScreen).toHaveBeenCalledWith("surface:worker-live", {
      workspace: undefined,
      lines: 40,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      refused: true,
      surface: "surface:worker-live",
      agent_id: "worker-live",
      state: "working",
      screen: "running tests... 115 passed",
    });

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("close_surface consolidates stale live registry when pane shows TASK_DONE", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-close-surface-done-consolidate");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });

    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "worker-done-stale",
      surface_id: "surface:worker-done-stale",
      state: "working",
      repo: "brainlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: null,
      task_summary: "finished task",
      pid: null,
      version: 1,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    });

    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:worker-done-stale",
        text: "gpt-5.5 xhigh · 60% left · ~/Gits/brainlayer\nImplemented.\nTASK_DONE",
        lines: 3,
        scrollback_used: false,
      }),
      closeSurface: vi.fn().mockResolvedValue(undefined),
    };

    const server = createServer({
      client: mockClient as any,
      stateDir,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["close_surface"];

    const result = await tool.handler(
      { surface: "surface:worker-done-stale" },
      {} as any,
    );

    expect(result.isError).not.toBe(true);
    expect(mockClient.closeSurface).toHaveBeenCalledWith(
      "surface:worker-done-stale",
      {
        workspace: undefined,
        collapsePane: false,
      },
    );
    expect(stateMgr.readState("worker-done-stale")).toMatchObject({
      state: "done",
      task_done_detected_at: expect.any(String),
      task_done_candidate_at: null,
    });
    expect(result.structuredContent).toMatchObject({
      surface: "surface:worker-done-stale",
      stale_registry_done_consolidated: {
        agent_id: "worker-done-stale",
        previous_state: "working",
        done_signal: "TASK_DONE",
      },
    });

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("close_surface refuses stale DONE consolidation when pane shows an active Codex marker", async () => {
    const stateDir = join(
      tmpdir(),
      "cmuxlayer-close-surface-done-active-refuse",
    );
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });

    const stateMgr = new StateManager(stateDir);
    stateMgr.writeState({
      agent_id: "worker-done-active",
      surface_id: "surface:worker-done-active",
      state: "working",
      repo: "brainlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: null,
      task_summary: "still active",
      pid: null,
      version: 1,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
    });

    const screenText = [
      "gpt-5.5 xhigh · 60% left · ~/Gits/brainlayer",
      "• Waiting for command approval",
      "TASK_DONE",
    ].join("\n");
    const closeSurfaceSpy = vi.fn();
    const exec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:worker-done-active",
            text: screenText,
            lines: 3,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      if (args.includes("close-surface")) {
        closeSurfaceSpy(args);
      }
      return { stdout: JSON.stringify({}), stderr: "" };
    });
    const server = createServer({
      exec,
      stateDir,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["close_surface"];

    const result = await tool.handler(
      { surface: "surface:worker-done-active" },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(closeSurfaceSpy).not.toHaveBeenCalled();
    expect(stateMgr.readState("worker-done-active")?.state).toBe("working");
    expect(result.structuredContent).toMatchObject({
      refused: true,
      surface: "surface:worker-done-active",
      agent_id: "worker-done-active",
      state: "working",
      screen: screenText,
    });

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("close_surface guard is fail-safe when a stale terminal record shares the surface with a live one", async () => {
    const stateDir = join(tmpdir(), "cmuxlayer-close-surface-collision");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });

    const stateMgr = new StateManager(stateDir);
    const base = {
      surface_id: "surface:shared",
      repo: "brainlayer",
      model: "codex",
      cli: "codex" as const,
      cli_session_id: null,
      task_summary: "",
      pid: null,
      version: 1,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown" as const,
      max_cost_per_agent: null,
    };
    // A stale terminal record AND a live record both point at one surface
    // (crash-resume collision before canonicalization). The guard must key off
    // the LIVE one and refuse, regardless of directory iteration order.
    stateMgr.writeState({ ...base, agent_id: "aaa-stale", state: "done" });
    stateMgr.writeState({ ...base, agent_id: "zzz-live", state: "working" });

    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:shared",
        text: "still working",
        lines: 1,
        scrollback_used: false,
      }),
      closeSurface: vi.fn().mockResolvedValue(undefined),
    };

    const server = createServer({
      client: mockClient as any,
      stateDir,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["close_surface"];

    const result = await tool.handler({ surface: "surface:shared" }, {} as any);

    expect(mockClient.closeSurface).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      refused: true,
      agent_id: "zzz-live",
      state: "working",
    });

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("close_surface refuses after stale DONE consolidation when another live agent shares the surface", async () => {
    const stateDir = join(
      tmpdir(),
      "cmuxlayer-close-surface-post-consolidation-live",
    );
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });

    const stateMgr = new StateManager(stateDir);
    const base = {
      surface_id: "surface:shared-done",
      repo: "brainlayer",
      model: "codex",
      cli: "codex" as const,
      cli_session_id: null,
      task_summary: "",
      pid: null,
      version: 1,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown" as const,
      max_cost_per_agent: null,
    };
    stateMgr.writeState({
      ...base,
      agent_id: "aaa-live-done",
      state: "working",
    });
    stateMgr.writeState({
      ...base,
      agent_id: "zzz-live-shared",
      state: "working",
    });

    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:shared-done",
        text: "All done.\nTASK_DONE",
        lines: 2,
        scrollback_used: false,
      }),
      closeSurface: vi.fn().mockResolvedValue(undefined),
    };

    const server = createServer({
      client: mockClient as any,
      stateDir,
      skipAgentLifecycle: true,
    });
    const tool = (server as any)._registeredTools["close_surface"];

    const result = await tool.handler(
      { surface: "surface:shared-done" },
      {} as any,
    );

    expect(mockClient.closeSurface).not.toHaveBeenCalled();
    const finalStates = [
      stateMgr.readState("aaa-live-done"),
      stateMgr.readState("zzz-live-shared"),
    ];
    const doneState = finalStates.find((state) => state?.state === "done");
    const liveState = finalStates.find((state) => state?.state === "working");
    expect(doneState).toMatchObject({
      state: "done",
      task_done_detected_at: expect.any(String),
    });
    expect(liveState).toMatchObject({ state: "working" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      refused: true,
      agent_id: liveState?.agent_id,
      state: "working",
      stale_registry_done_consolidated: {
        agent_id: doneState?.agent_id,
        previous_state: "working",
        done_signal: "TASK_DONE",
      },
    });

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("rename_tab handler calls cmux rename-tab", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["rename_tab"];

    await tool.handler({ surface: "surface:1", title: "New Title" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "rename-tab",
        "--surface",
        "surface:1",
        "New Title",
      ]),
    );
  });

  it("notify handler calls cmux notify without --title when title omitted", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["notify"];

    const result = await tool.handler(
      {
        subtitle: "Build",
        body: "Finished successfully",
        workspace: "workspace:1",
        surface: "surface:1",
      },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith("cmux", [
      "--json",
      "notify",
      "--subtitle",
      "Build",
      "--body",
      "Finished successfully",
      "--workspace",
      "workspace:1",
      "--surface",
      "surface:1",
    ]);

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      ok: true,
      title: null,
      subtitle: "Build",
      body: "Finished successfully",
      workspace: "workspace:1",
      surface: "surface:1",
    });
  });

  it("notify handler passes --title when title is provided", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["notify"];

    await tool.handler({ title: "Done" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith("cmux", [
      "--json",
      "notify",
      "--title",
      "Done",
    ]);
  });

  it("set_progress handler calls cmux set-progress", async () => {
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["set_progress"];

    await tool.handler({ value: 0.5, label: "Halfway" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["set-progress", "0.5", "--label", "Halfway"]),
    );
  });

  it("set_progress resolves workspace from the target surface when only surface is provided", async () => {
    mockExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          caller: {
            workspace_ref: "workspace:6",
            surface_ref: "surface:52",
          },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["set_progress"];

    await tool.handler(
      { value: 0.75, label: "Halfway", surface: "surface:52" },
      {} as any,
    );

    expect(mockExec).toHaveBeenNthCalledWith(1, "cmux", [
      "--json",
      "identify",
      "--surface",
      "surface:52",
    ]);
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "cmux",
      expect.arrayContaining([
        "set-progress",
        "0.75",
        "--label",
        "Halfway",
        "--workspace",
        "workspace:6",
      ]),
    );
  });

  it("handler returns error for CLI failures", async () => {
    mockExec = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("not found"), { stderr: "surface not found" }),
      );

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["read_screen"];

    const result = await tool.handler({ surface: "surface:999" }, {} as any);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/error/i);
  });

  it("browser_surface dispatches supported browser commands", async () => {
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ url: "https://example.com" }),
      stderr: "",
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["browser_surface"];

    const result = await tool.handler(
      { action: "url", surface: "surface:9" },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith("cmux", [
      "--json",
      "browser",
      "--surface",
      "surface:9",
      "url",
    ]);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toEqual({ url: "https://example.com" });
  });

  it("browser_surface validates action-specific required arguments", async () => {
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["browser_surface"];

    const result = await tool.handler(
      { action: "click", surface: "surface:9" },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/selector.*required/i);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe("registry reconstitution error logging", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs errors instead of silently swallowing them", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AgentRegistry.prototype, "reconstitute").mockRejectedValueOnce(
      new Error("disk corrupted"),
    );

    const mockExec: ExecFn = vi
      .fn()
      .mockResolvedValue({ stdout: "{}", stderr: "" });

    createServer({ exec: mockExec });

    // Allow the async .catch() handler to run.
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    expect(console.error).toHaveBeenCalledWith(
      "[cmuxlayer] registry reconstitution failed:",
      expect.any(Error),
    );
  });
});
