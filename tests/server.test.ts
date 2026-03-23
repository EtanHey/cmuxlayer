import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { StateManager } from "../src/state-manager.js";

// The 11 low-level tools from the design doc
const EXPECTED_TOOLS = [
  "list_surfaces",
  "new_split",
  "send_input",
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
  it("registers all 11 tools", () => {
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
    vi.clearAllTimers();
    rmSync(CHANNEL_TEST_DIR, { recursive: true, force: true });
  });

  it("emits lifecycle notifications over the MCP transport when enabled", async () => {
    vi.useFakeTimers();
    rmSync(CHANNEL_TEST_DIR, { recursive: true, force: true });
    mkdirSync(CHANNEL_TEST_DIR, { recursive: true });

    const stateMgr = new StateManager(CHANNEL_TEST_DIR);
    stateMgr.writeState({
      agent_id: "a1",
      surface_id: "surface:42",
      state: "done",
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
    await vi.advanceTimersByTimeAsync(5000);

    const notifications = messages.filter(
      (message) =>
        "method" in message &&
        message.method === "notifications/claude/channel",
    );
    expect(notifications).toHaveLength(2);
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            meta: expect.objectContaining({
              event: "spawned",
              agent_id: "a1",
              repo: "brainlayer",
            }),
          }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({
            meta: expect.objectContaining({
              event: "done",
              agent_id: "a1",
              repo: "brainlayer",
            }),
          }),
        }),
      ]),
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

  it("list_surfaces aggregates pane surfaces and includes optional previews", async () => {
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
            {
              ref: "pane:2",
              index: 1,
              focused: false,
              surface_count: 1,
              surface_refs: ["surface:2"],
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
              index: 0,
              selected: true,
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
              ref: "surface:2",
              title: "Two",
              type: "browser",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          surface_ref: "surface:1",
          text: "line1\nline2",
          lines: 5,
        }),
        stderr: "",
      });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const registeredTools = (server as any)._registeredTools;
    const tool = registeredTools["list_surfaces"];

    const result = await tool.handler(
      {
        workspace: "workspace:1",
        include_screen_preview: true,
        preview_lines: 5,
      },
      {} as any,
    );

    expect(mockExec).toHaveBeenCalledWith("cmux", [
      "--json",
      "list-panes",
      "--workspace",
      "workspace:1",
    ]);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "--json",
        "read-screen",
        "--surface",
        "surface:1",
        "--workspace",
        "workspace:1",
        "--lines",
        "5",
      ]),
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.surfaces).toHaveLength(2);
    expect(parsed.surfaces[0]).toMatchObject({
      ref: "surface:1",
      pane_ref: "pane:1",
      workspace_ref: "workspace:1",
      screen_preview: "line1\nline2",
    });
    expect(parsed.surfaces[1]).toMatchObject({
      ref: "surface:2",
      pane_ref: "pane:2",
      workspace_ref: "workspace:1",
    });
    expect(parsed.workspace_ref).toBe("workspace:1");
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
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.surfaces[0].screen_preview_error).toMatch(
      /surface unavailable/,
    );
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
    const parsed = JSON.parse(result.content[0].text);
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

    const parsed = JSON.parse(result.content[0].text);
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

    const parsed = JSON.parse(result.content[0].text);
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
          '  Say "go" when you\'re ready and I\'ll start your timer.',
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

    const parsed = JSON.parse(result.content[0].text);
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
    const parsed = JSON.parse(result.content[0].text);
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
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:2");
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
    const parsed = JSON.parse(result.content[0].text);
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

  it("notify handler calls cmux notify with defaults and optional args", async () => {
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
      "--title",
      "Notification",
      "--subtitle",
      "Build",
      "--body",
      "Finished successfully",
      "--workspace",
      "workspace:1",
      "--surface",
      "surface:1",
    ]);

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      ok: true,
      applied: "notify",
      title: "Notification",
      subtitle: "Build",
      body: "Finished successfully",
      workspace: "workspace:1",
      surface: "surface:1",
    });
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
    const parsed = JSON.parse(result.content[0].text);
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
