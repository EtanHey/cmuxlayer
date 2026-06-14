import { describe, it, expect, vi } from "vitest";
import { CmuxClient, type ExecFn } from "../src/cmux-client.js";

function mockExec(response: object | string): ExecFn {
  const stdout =
    typeof response === "string" ? response : JSON.stringify(response);
  return vi.fn().mockResolvedValue({ stdout, stderr: "" });
}

function mockClient(response: object | string) {
  const exec = mockExec(response);
  const client = new CmuxClient({ exec });
  return { client, exec };
}

describe("CmuxClient.listWorkspaces", () => {
  it("calls cmux --json list-workspaces", async () => {
    const data = {
      workspaces: [
        {
          ref: "workspace:1",
          title: "Main",
          index: 0,
          selected: true,
          pinned: false,
        },
      ],
    };
    const { client, exec } = mockClient(data);

    const result = await client.listWorkspaces();

    expect(exec).toHaveBeenCalledWith("cmux", ["--json", "list-workspaces"]);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0].ref).toBe("workspace:1");
  });
});

describe("CmuxClient.createWorkspace", () => {
  it("uses the current workspace create --name CLI shape", async () => {
    const { client, exec } = mockClient({
      workspace_ref: "workspace:7",
      title: "red-team",
    });

    const result = await client.createWorkspace("red-team");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "workspace",
      "create",
      "--name",
      "red-team",
    ]);
    expect(result).toEqual({ workspace: "workspace:7", title: "red-team" });
  });
});

describe("CmuxClient.listPaneSurfaces", () => {
  it("calls with workspace flag when provided", async () => {
    const data = {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [
        {
          ref: "surface:1",
          title: "Terminal",
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    };
    const { client, exec } = mockClient(data);

    await client.listPaneSurfaces({ workspace: "workspace:1" });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "list-pane-surfaces",
      "--workspace",
      "workspace:1",
    ]);
  });

  it("calls without workspace flag when not provided", async () => {
    const data = {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [],
    };
    const { client, exec } = mockClient(data);

    await client.listPaneSurfaces();

    expect(exec).toHaveBeenCalledWith("cmux", ["--json", "list-pane-surfaces"]);
  });
});

describe("CmuxClient.newSplit", () => {
  it("calls cmux new-split with direction", async () => {
    const data = {
      workspace: "workspace:1",
      surface: "surface:2",
      pane: "pane:1",
      title: "New Split",
      type: "terminal",
    };
    const { client, exec } = mockClient(data);

    const result = await client.newSplit("right");

    expect(exec).toHaveBeenCalledWith("cmux", ["--json", "new-split", "right"]);
    expect(result.surface).toBe("surface:2");
  });

  it("passes workspace and surface options", async () => {
    const data = {
      workspace: "workspace:1",
      surface: "surface:3",
      pane: "pane:2",
      title: "Split",
      type: "terminal",
    };
    const { client, exec } = mockClient(data);

    await client.newSplit("left", {
      workspace: "workspace:1",
      surface: "surface:1",
    });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "new-split",
      "left",
      "--workspace",
      "workspace:1",
      "--surface",
      "surface:1",
    ]);
  });

  it("resolves a pane target to the selected surface instead of using --panel", async () => {
    const paneSurfaces = {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:2",
      surfaces: [
        {
          ref: "surface:old",
          title: "Old tab",
          type: "terminal",
          index: 0,
          selected: false,
        },
        {
          ref: "surface:selected",
          title: "Selected tab",
          type: "terminal",
          index: 1,
          selected: true,
        },
      ],
    };
    const split = {
      workspace: "workspace:1",
      surface: "surface:3",
      pane: "pane:2",
      title: "Split",
      type: "terminal",
    };
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify(paneSurfaces),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify(split), stderr: "" });
    const client = new CmuxClient({ exec });

    await client.newSplit("left", {
      workspace: "workspace:1",
      pane: "pane:2",
    });

    expect(exec).toHaveBeenNthCalledWith(1, "cmux", [
      "--json",
      "list-pane-surfaces",
      "--workspace",
      "workspace:1",
      "--pane",
      "pane:2",
    ]);
    expect(exec).toHaveBeenNthCalledWith(2, "cmux", [
      "--json",
      "new-split",
      "left",
      "--workspace",
      "workspace:1",
      "--surface",
      "surface:selected",
    ]);
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["--panel"]),
    );
  });

  it("omits the pane anchor when no surface can be resolved for the pane", async () => {
    const paneSurfaces = {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:empty",
      surfaces: [],
    };
    const split = {
      workspace: "workspace:1",
      surface: "surface:3",
      pane: "pane:2",
      title: "Split",
      type: "terminal",
    };
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify(paneSurfaces),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify(split), stderr: "" });
    const client = new CmuxClient({ exec });

    await client.newSplit("left", {
      workspace: "workspace:1",
      pane: "pane:empty",
    });

    expect(exec).toHaveBeenNthCalledWith(2, "cmux", [
      "--json",
      "new-split",
      "left",
      "--workspace",
      "workspace:1",
    ]);
  });

  it("uses cmux new-pane for browser splits", async () => {
    const data = {
      workspace_ref: "workspace:1",
      surface_ref: "surface:8",
      pane_ref: "pane:4",
      type: "browser",
    };
    const { client, exec } = mockClient(data);

    const result = await client.newSplit("down", {
      type: "browser",
      workspace: "workspace:1",
      url: "https://example.com",
    });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "new-pane",
      "--type",
      "browser",
      "--direction",
      "down",
      "--workspace",
      "workspace:1",
      "--url",
      "https://example.com",
    ]);
    expect(result).toEqual({
      workspace: "workspace:1",
      surface: "surface:8",
      pane: "pane:4",
      title: "",
      type: "browser",
    });
  });
});

describe("CmuxClient.newSurface", () => {
  it("calls cmux new-surface with pane and optional flags", async () => {
    const data = {
      workspace: "workspace:1",
      surface: "surface:9",
      pane: "pane:2",
      title: "New Tab",
      type: "browser",
    };
    const { client, exec } = mockClient(data);

    const result = await client.newSurface({
      pane: "pane:2",
      workspace: "workspace:1",
      type: "browser",
      url: "https://example.com",
    });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "new-surface",
      "--pane",
      "pane:2",
      "--type",
      "browser",
      "--workspace",
      "workspace:1",
      "--url",
      "https://example.com",
    ]);
    expect(result).toEqual({
      workspace: "workspace:1",
      surface: "surface:9",
      pane: "pane:2",
      title: "New Tab",
      type: "browser",
    });
  });
});

describe("CmuxClient.moveSurface", () => {
  it("calls cmux move-surface with surface and optional flags", async () => {
    const data = {
      ok: true,
      workspace: "workspace:2",
      surface: "surface:9",
      pane: "pane:3",
    };
    const { client, exec } = mockClient(data);

    const result = await client.moveSurface({
      surface: "surface:9",
      pane: "pane:3",
      workspace: "workspace:2",
      before: "surface:10",
      index: 1,
      focus: false,
    });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "move-surface",
      "--surface",
      "surface:9",
      "--pane",
      "pane:3",
      "--workspace",
      "workspace:2",
      "--before",
      "surface:10",
      "--index",
      "1",
      "--focus",
      "false",
    ]);
    expect(result).toEqual({
      ok: true,
      workspace: "workspace:2",
      surface: "surface:9",
      pane: "pane:3",
    });
  });
});

describe("CmuxClient.reorderSurface", () => {
  it("calls cmux reorder-surface with index placement", async () => {
    const data = {
      ok: true,
      surface: "surface:9",
    };
    const { client, exec } = mockClient(data);

    const result = await client.reorderSurface({
      surface: "surface:9",
      index: 2,
    });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "reorder-surface",
      "--surface",
      "surface:9",
      "--index",
      "2",
    ]);
    expect(result).toEqual({
      ok: true,
      surface: "surface:9",
    });
  });
});

describe("CmuxClient.send", () => {
  it("calls cmux send with surface and text", async () => {
    const { client, exec } = mockClient({});

    await client.send("surface:1", "echo hello");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "send",
      "--surface",
      "surface:1",
      "echo hello",
    ]);
  });

  it("passes workspace option", async () => {
    const { client, exec } = mockClient({});

    await client.send("surface:1", "ls", { workspace: "workspace:2" });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "send",
      "--surface",
      "surface:1",
      "--workspace",
      "workspace:2",
      "ls",
    ]);
  });

  it("rejects server-only chunking options at the client boundary", async () => {
    const { client, exec } = mockClient({});

    await expect(
      client.send("surface:1", "chunk me", {
        workspace: "workspace:2",
        chunk_size: 180,
        chunk_delay_ms: 7,
      }),
    ).rejects.toThrow(/does not support chunk_size, chunk_delay_ms/i);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("CmuxClient.pasteText", () => {
  it("sets and pastes a workspace-scoped buffer without interpreting newlines", async () => {
    const { client, exec } = mockClient({});

    await client.pasteText("surface:1", "line one\nline two", {
      workspace: "workspace:2",
    });

    expect(exec).toHaveBeenNthCalledWith(1, "cmux", [
      "--json",
      "set-buffer",
      "--name",
      expect.stringMatching(/^cmuxlayer-workspace-2-surface-1-[a-f0-9-]+$/),
      "--",
      "line one\nline two",
    ]);
    const bufferName = exec.mock.calls[0][1][3];
    expect(exec).toHaveBeenNthCalledWith(2, "cmux", [
      "--json",
      "paste-buffer",
      "--name",
      bufferName,
      "--surface",
      "surface:1",
      "--workspace",
      "workspace:2",
    ]);
  });

  it("uses a unique buffer name for each paste call", async () => {
    const { client, exec } = mockClient({});

    await client.pasteText("surface:1", "first", {
      workspace: "workspace:2",
    });
    await client.pasteText("surface:1", "second", {
      workspace: "workspace:2",
    });

    const setBufferNames = exec.mock.calls
      .filter(([, args]) => args.includes("set-buffer"))
      .map(([, args]) => args[3]);
    expect(setBufferNames).toHaveLength(2);
    expect(setBufferNames[0]).not.toBe(setBufferNames[1]);
  });
});

describe("CmuxClient.sendKey", () => {
  it("calls cmux send-key with surface and key", async () => {
    const { client, exec } = mockClient({});

    await client.sendKey("surface:1", "return");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "send-key",
      "--surface",
      "surface:1",
      "return",
    ]);
  });

  it.each(["C-c", "ctrl-c", "^c", "Ctrl+C", "Ctrl-C"])(
    "normalizes %s to ctrl-c",
    async (key) => {
      const { client, exec } = mockClient({});

      await client.sendKey("surface:1", key);

      expect(exec).toHaveBeenCalledWith("cmux", [
        "--json",
        "send-key",
        "--surface",
        "surface:1",
        "ctrl-c",
      ]);
    },
  );
});

describe("CmuxClient.selectWorkspace", () => {
  it("calls cmux select-workspace with workspace", async () => {
    const { client, exec } = mockClient({});

    await client.selectWorkspace("workspace:3");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "select-workspace",
      "--workspace",
      "workspace:3",
    ]);
  });
});

describe("CmuxClient.readScreen", () => {
  it("calls cmux read-screen with surface", async () => {
    const data = {
      surface_ref: "surface:1",
      text: "hello world",
      lines: 20,
    };
    const { client, exec } = mockClient(data);

    const result = await client.readScreen("surface:1");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "read-screen",
      "--surface",
      "surface:1",
    ]);
    expect(result.text).toBe("hello world");
  });

  it("passes lines and scrollback options", async () => {
    const data = { surface_ref: "surface:1", text: "output", lines: 50 };
    const { client, exec } = mockClient(data);

    await client.readScreen("surface:1", { lines: 50, scrollback: true });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "read-screen",
      "--surface",
      "surface:1",
      "--lines",
      "50",
      "--scrollback",
    ]);
  });
});

describe("CmuxClient.renameTab", () => {
  it("calls cmux rename-tab with surface and title", async () => {
    const { client, exec } = mockClient({});

    await client.renameTab("surface:1", "New Title");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "rename-tab",
      "--surface",
      "surface:1",
      "New Title",
    ]);
  });
});

describe("CmuxClient.setStatus", () => {
  it("calls cmux set-status with key and value", async () => {
    const { client, exec } = mockClient({});

    await client.setStatus("task", "building");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "set-status",
      "task",
      "building",
    ]);
  });

  it("passes icon and color options", async () => {
    const { client, exec } = mockClient({});

    await client.setStatus("task", "building", {
      icon: "hammer",
      color: "#ff0000",
      workspace: "workspace:1",
    });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "set-status",
      "task",
      "building",
      "--icon",
      "hammer",
      "--color",
      "#ff0000",
      "--workspace",
      "workspace:1",
    ]);
  });
});

describe("CmuxClient.clearStatus", () => {
  it("calls cmux clear-status with key", async () => {
    const { client, exec } = mockClient({});

    await client.clearStatus("task");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "clear-status",
      "task",
    ]);
  });
});

describe("CmuxClient.listStatus", () => {
  it("parses plain-text status entries from cmux", async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({
      stdout: [
        "build=compiling icon=hammer color=#ff9500",
        "deploy=v1.2.3",
      ].join("\n"),
      stderr: "",
    });
    const client = new CmuxClient({ exec });

    const result = await client.listStatus({ workspace: "workspace:1" });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "list-status",
      "--workspace",
      "workspace:1",
    ]);
    expect(result).toEqual([
      {
        key: "build",
        value: "compiling",
        icon: "hammer",
        color: "#ff9500",
      },
      {
        key: "deploy",
        value: "v1.2.3",
      },
    ]);
  });
});

describe("CmuxClient.setProgress", () => {
  it("calls cmux set-progress with value", async () => {
    const { client, exec } = mockClient({});

    await client.setProgress(0.5);

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "set-progress",
      "0.5",
    ]);
  });

  it("passes label option", async () => {
    const { client, exec } = mockClient({});

    await client.setProgress(0.75, { label: "Building..." });

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "set-progress",
      "0.75",
      "--label",
      "Building...",
    ]);
  });
});

describe("CmuxClient.closeSurface", () => {
  it("calls cmux close-surface with surface", async () => {
    const { client, exec } = mockClient({});

    await client.closeSurface("surface:1");

    expect(exec).toHaveBeenCalledWith("cmux", [
      "--json",
      "close-surface",
      "--surface",
      "surface:1",
    ]);
  });
});

describe("CmuxClient CLI error handling", () => {
  it("throws on non-zero exit code", async () => {
    const exec: ExecFn = vi.fn().mockRejectedValue(
      Object.assign(new Error("Command failed"), {
        code: 1,
        stderr: "surface not found",
      }),
    );
    const client = new CmuxClient({ exec });

    await expect(client.readScreen("surface:999")).rejects.toThrow();
  });

  it("includes stderr details in CLI errors", async () => {
    const exec: ExecFn = vi.fn().mockRejectedValue(
      Object.assign(new Error("Command failed"), {
        code: 2,
        stderr: "surface not found",
      }),
    );
    const client = new CmuxClient({ exec });

    await expect(client.readScreen("surface:999")).rejects.toThrow(
      /surface not found/,
    );
  });

  it("throws a contextual error when cmux returns invalid JSON", async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "not json",
      stderr: "",
    });
    const client = new CmuxClient({ exec });

    await expect(client.listWorkspaces()).rejects.toThrow(
      /invalid JSON.*list-workspaces/i,
    );
  });
});
