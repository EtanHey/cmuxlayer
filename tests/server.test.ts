import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";

// The 12 low-level tools from the design doc
const EXPECTED_TOOLS = [
  "list_surfaces",
  "select_workspace",
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
] as const;

const CHANNEL_TEST_DIR = join(tmpdir(), "cmuxlayer-channels-server-test");

async function advanceTimers(ms: number): Promise<void> {
  const advanceAsync = (vi as any).advanceTimersByTimeAsync;
  if (typeof advanceAsync === "function") {
    await advanceAsync.call(vi, ms);
    return;
  }

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
  it("registers all 16 core tools", () => {
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
    try {
      vi.clearAllTimers();
    } catch {
      // Bun's Vitest shim throws here when fake timers were never activated.
    }
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
    await advanceTimers(5000);

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

    const result = await tool.handler(
      { workspace: "workspace:3" },
      {} as any,
    );

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
    expect(parsed.surfaces.map((surface: { ref: string }) => surface.ref)).toEqual(
      ["surface:1", "surface:2"],
    );
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
      title: "One",
      type: "terminal",
    });
    expect(parsed.surfaces[1]).toEqual({
      ref: "surface:2",
      workspace_ref: "workspace:1",
      title: "Two",
      type: "browser",
    });
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
    expect(parsed.content).toContain("hello");
    expect(parsed.parsed).toMatchObject({
      agent_type: "claude",
      status: "done",
      token_count: 2345,
      done_signal: "ENRICHMENT_PROMPT_DONE",
      response: "hello",
      model: "Sonnet 4.6",
      cost: 1.25,
    });
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
      context_pct: 1,
      context_window: 200000,
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

    const server = createServer({
      client: mockClient,
      skipAgentLifecycle: true,
    });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["read_screen"];

    const result = await tool.handler(
      { surface: "surface:1", parsed_only: true, lines: 40 },
      {} as any,
    );

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

    // Should have called send and then send-key
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      "cmux",
      expect.arrayContaining(["send"]),
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "cmux",
      expect.arrayContaining(["send-key"]),
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

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:6"]),
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      "cmux",
      expect.arrayContaining(["send-key", "--surface", "surface:6", "return"]),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.surface).toBe("surface:6");
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
    expect(mockExec).toHaveBeenCalledWith("cmux", expect.arrayContaining([
      "send",
      "--surface",
      "surface:1",
      "brainlayerCodex -s",
    ]));
    expect(mockExec).toHaveBeenCalledWith("cmux", expect.arrayContaining([
      "send",
      "--surface",
      "surface:1",
      "boot prompt",
    ]));
  });

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
    expect(mockExec).toHaveBeenCalledWith("cmux", expect.arrayContaining([
      "send",
      "--surface",
      "surface:1",
      "brainlayerCodex -s",
    ]));
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

    expect(mockExec).toHaveBeenCalledTimes(5);
    for (const [index, call] of mockExec.mock.calls.entries()) {
      expect(call[0]).toBe("cmux");
      expect(call[1]).toEqual(expect.arrayContaining(["send"]));
      const chunk = call[1][call[1].length - 1];
      expect(typeof chunk).toBe("string");
      expect((chunk as string).length).toBeLessThanOrEqual(121);
      if (index < mockExec.mock.calls.length - 1) {
        expect((chunk as string).endsWith("\n")).toBe(true);
      }
    }

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
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
      mockExec.mock.calls.filter(([, args]) => args.includes("send")),
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
        mockExec.mock.calls.filter(([, args]) => args.includes("send"))
          .length === 5
      ) {
        break;
      }
    }

    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("send")),
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
      otherSurface.structuredContent ?? JSON.parse(otherSurface.content[0].text);
    expect(otherSurfaceParsed.ok).toBe(true);
    expect(otherSurfaceParsed.surface).toBe("surface:2");
  });

  it("send_input rejects concurrent foreground sends on the same surface", async () => {
    let releaseSend: ((value: { stdout: string; stderr: string }) => void) | null =
      null;
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
    await Promise.resolve();

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
      renameResult.structuredContent ?? JSON.parse(renameResult.content[0].text);
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
    vi.useFakeTimers();
    let sendAttempts = 0;
    mockExec = vi.fn().mockImplementation((_cmd, args) => {
      if (args.includes("send")) {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          return Promise.reject(new Error("socket closed before receiving response"));
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

    await advanceTimers(25);

    const result = await resultPromise;
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(sendAttempts).toBe(2);
  });

  it("send_input reports the failed chunk when retries are exhausted", async () => {
    vi.useFakeTimers();
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

    await advanceTimers(50);

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

    await tool.handler(
      { pane: "pane:1", title: "Build Logs" },
      {} as any,
    );

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
    mockExec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["close_surface"];

    await tool.handler({ surface: "surface:1" }, {} as any);

    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["close-surface"]),
    );
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

    const result = await tool.handler({ surface: "surface:worker-1" }, {} as any);

    expect(mockClient.closeSurface).toHaveBeenCalledWith("surface:worker-1", {
      workspace: undefined,
    });
    expect(result.structuredContent).toMatchObject({
      surface: "surface:worker-1",
      pane: "pane:right",
      collapse_pane: true,
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
  beforeEach(() => {
    vi.useFakeTimers();
  });

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

    // Allow the async .catch() handler to run
    await vi.waitFor(() => {
      expect(console.error).toHaveBeenCalledWith(
        "[cmux-mcp] registry reconstitution failed:",
        expect.any(Error),
      );
    });
  });
});
