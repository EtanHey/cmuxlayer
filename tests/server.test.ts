import { describe, it, expect, vi, beforeEach } from "vitest";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";

// The 10 tools from the design doc
const EXPECTED_TOOLS = [
  "list_surfaces",
  "new_split",
  "send_input",
  "send_key",
  "read_screen",
  "rename_tab",
  "set_status",
  "set_progress",
  "close_surface",
  "browser_surface",
] as const;

describe("createServer", () => {
  it("returns an McpServer with a connect method", async () => {
    const server = createServer({ skipAgentLifecycle: true });
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });
});

describe("tool registration", () => {
  it("registers all 10 tools", () => {
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
        text: "hello",
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
    expect(parsed.content).toBe("hello");
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
