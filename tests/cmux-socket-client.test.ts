/**
 * Tests for CmuxSocketClient and createCmuxClient factory.
 *
 * These tests use a mock Unix socket server to validate:
 * 1. CmuxSocketClient implements the same interface as CmuxClient
 * 2. The factory pattern (socket-first, CLI fallback)
 * 3. Error handling and connection lifecycle
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { CmuxClient, type ExecFn } from "../src/cmux-client.js";
import { createCmuxClient } from "../src/cmux-client-factory.js";
import { getTransportHealth } from "../src/cmux-transport-self-heal.js";

// ── Mock V2 Socket Server ──────────────────────────────────────────────

const CAN_BIND_MOCK_SOCKET = process.env.CODEX_SANDBOX !== "seatbelt";
const MOCK_SOCKET_PATH = "/tmp/cmux-test-mock.sock";
const MOCK_WORKSPACE_ID = "8481D6A0-CE17-4B7C-8695-7A722D30FEE2";
const MOCK_SECOND_WORKSPACE_ID = "7335E54B-6E88-4B19-BE8C-71C39F4E9D10";

interface MockV2Request {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

type MockResponseHandler = (req: MockV2Request) => unknown;

const MOCK_RESPONSES: Record<string, unknown> = {
  "system.ping": { pong: true },
  "workspace.list": {
    workspaces: [
      {
        id: MOCK_WORKSPACE_ID,
        ref: "workspace:1",
        title: "Test WS",
        index: 0,
        selected: true,
        pinned: false,
      },
    ],
  },
  "workspace.select": {},
  "surface.list": {
    workspace_ref: "workspace:1",
    window_ref: "window:1",
    pane_ref: "pane:1",
    surfaces: [
      {
        ref: "surface:1",
        title: "test",
        type: "terminal",
        index: 0,
        selected: true,
      },
    ],
  },
  "pane.list": {
    workspace_ref: "workspace:1",
    window_ref: "window:1",
    panes: [
      {
        ref: "pane:1",
        index: 0,
        focused: true,
        surface_count: 1,
        surface_refs: ["surface:1"],
      },
    ],
  },
  "surface.send_text": {},
  "surface.send_key": {},
  "surface.read_text": {
    surface_ref: "surface:1",
    text: "$ echo hello\nhello\n$",
    lines: 3,
  },
  "surface.split": {
    workspace_ref: "workspace:1",
    surface_ref: "surface:2",
    pane_ref: "pane:2",
    title: "",
    type: "terminal",
  },
  "surface.rename": {},
  "tab.action": {
    surface_ref: "surface:1",
    action: "rename",
    title: "",
    workspace_ref: "workspace:1",
    tab_ref: "tab:1",
    pane_ref: "pane:1",
    window_ref: "window:1",
  },
  "status.set": {},
  "status.clear": {},
  "status.list": { entries: [{ key: "agent", value: "active", icon: "bolt" }] },
  "progress.set": {},
  "progress.clear": {},
  "notification.create": {},
  "surface.close": {},
  "auth.login": {},
  "system.identify": {
    caller: {
      workspace_ref: "workspace:1",
      surface_ref: "surface:1",
      pane_ref: "pane:1",
    },
  },
};

function isMockResponseHandler(response: unknown): response is MockResponseHandler {
  return typeof response === "function";
}

let mockServer: net.Server;
let lastV1Command = "";
let lastV2Request: { method: string; params: Record<string, unknown> } | null =
  null;
const mockEvents: Array<
  | { type: "v1"; command: string }
  | { type: "v2"; method: string; params: Record<string, unknown> }
> = [];
let connectionCount = 0;
const activeConnections = new Set<net.Socket>();
const helperServerConnections = new WeakMap<net.Server, Set<net.Socket>>();

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    // Clean up stale socket
    try {
      fs.unlinkSync(MOCK_SOCKET_PATH);
    } catch {
      /* ignore */
    }

    mockServer = net.createServer((conn) => {
      connectionCount++;
      activeConnections.add(conn);
      conn.on("close", () => activeConnections.delete(conn));
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;

          try {
            const req = JSON.parse(line) as MockV2Request;
            const method = req.method as string;
            lastV2Request = { method, params: req.params ?? {} };
            mockEvents.push({
              type: "v2",
              method,
              params: req.params ?? {},
            });
            const mockResponse = MOCK_RESPONSES[method];
            const result =
              isMockResponseHandler(mockResponse)
                ? mockResponse(req)
                : mockResponse;

            if (result !== undefined) {
              const resp =
                JSON.stringify({ id: req.id, ok: true, result }) + "\n";
              conn.write(resp);
            } else {
              const resp =
                JSON.stringify({
                  id: req.id,
                  ok: false,
                  error: {
                    code: "method_not_found",
                    message: `Unknown: ${method}`,
                  },
                }) + "\n";
              conn.write(resp);
            }
          } catch {
            // Not JSON — handle as V1 plain-text command
            lastV1Command = line;
            mockEvents.push({ type: "v1", command: line });
            const cmd = line.split(" ")[0];
            if (
              cmd &&
              [
                "set_status",
                "clear_status",
                "set_progress",
                "clear_progress",
                "notify",
                "log",
                "list_status",
              ].includes(cmd)
            ) {
              if (cmd === "list_status") {
                conn.write("agent=active icon=bolt\n");
              } else {
                conn.write("OK\n");
              }
            } else {
              conn.write("ERROR: unknown command\n");
            }
          }
        }
      });
    });

    mockServer.listen(MOCK_SOCKET_PATH, () => resolve());
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    for (const conn of activeConnections) {
      conn.destroy();
    }
    mockServer.close(() => {
      try {
        fs.unlinkSync(MOCK_SOCKET_PATH);
      } catch {
        /* ignore */
      }
      resolve();
    });
  });
}

function startSocketServer(socketPath: string): Promise<net.Server> {
  return new Promise((resolve) => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }

    const connections = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      connections.add(conn);
      conn.on("close", () => connections.delete(conn));
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;

          const req = JSON.parse(line);
          conn.write(
            JSON.stringify({
              id: req.id,
              ok: true,
              result: { pong: true },
            }) + "\n",
          );
        }
      });
    });
    helperServerConnections.set(server, connections);

    server.listen(socketPath, () => resolve(server));
  });
}

function stopSocketServer(
  server: net.Server,
  socketPath: string,
): Promise<void> {
  return new Promise((resolve) => {
    for (const conn of helperServerConnections.get(server) ?? []) {
      conn.destroy();
    }
    server.close(() => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
      resolve();
    });
  });
}

function startCloseAfterMethodServer(
  socketPath: string,
  closeMethod: string,
): Promise<{ server: net.Server; seenMethods: string[] }> {
  return new Promise((resolve) => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }

    const seenMethods: string[] = [];
    const connections = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      connections.add(conn);
      conn.on("close", () => connections.delete(conn));
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;

          const req = JSON.parse(line);
          seenMethods.push(req.method);
          if (req.method === closeMethod) {
            conn.destroy();
            continue;
          }
          conn.write(
            JSON.stringify({
              id: req.id,
              ok: true,
              result: { pong: true },
            }) + "\n",
          );
        }
      });
    });
    helperServerConnections.set(server, connections);

    server.listen(socketPath, () => resolve({ server, seenMethods }));
  });
}

function startProtocolErrorServer(socketPath: string): Promise<net.Server> {
  return new Promise((resolve) => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }

    const connections = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      connections.add(conn);
      conn.on("close", () => connections.delete(conn));
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;

          const req = JSON.parse(line);
          conn.write(
            JSON.stringify({
              id: req.id,
              ok: false,
              error: {
                code: "method_not_found",
                message: "controlled protocol failure",
              },
            }) + "\n",
          );
        }
      });
    });
    helperServerConnections.set(server, connections);

    server.listen(socketPath, () => resolve(server));
  });
}

// ── Shared lifecycle ───────────────────────────────────────────────────

beforeAll(async () => {
  if (!CAN_BIND_MOCK_SOCKET) {
    return;
  }
  await startMockServer();
});

afterAll(async () => {
  if (!CAN_BIND_MOCK_SOCKET) {
    return;
  }
  await stopMockServer();
});

beforeEach(() => {
  lastV1Command = "";
  lastV2Request = null;
  mockEvents.length = 0;
  connectionCount = 0;
});

// ── Tests ──────────────────────────────────────────────────────────────

describe.skipIf(!CAN_BIND_MOCK_SOCKET)("CmuxSocketClient", () => {
  it("pings the socket server", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    const result = await client.ping();
    expect(result).toBe(true);
  });

  it("listWorkspaces returns same shape as CmuxClient", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    const result = await client.listWorkspaces();
    expect(result.workspaces).toBeInstanceOf(Array);
    expect(result.workspaces[0]).toHaveProperty("ref");
    expect(result.workspaces[0]).toHaveProperty("title");
    expect(result.workspaces[0]).toHaveProperty("index");
    expect(result.workspaces[0]).toHaveProperty("selected");
  });

  it("selectWorkspace sends a workspace.select request", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.selectWorkspace("workspace:1");

    expect(lastV2Request).not.toBeNull();
    expect(lastV2Request!.method).toBe("workspace.select");
    expect(lastV2Request!.params).toEqual({ workspace_id: "workspace:1" });
  });

  it("send delivers text to a surface", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    // Should not throw
    await client.send("surface:1", "echo hello", { workspace: "workspace:1" });
  });

  it("rejects server-only chunking options at the socket boundary", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await expect(
      client.send("surface:1", "echo hello", {
        workspace: "workspace:1",
        chunk_size: 180,
      }),
    ).rejects.toThrow(/does not support chunk_size/i);
  });

  it.each(["C-c", "ctrl-c", "^c", "Ctrl+C", "Ctrl-C"])(
    "normalizes %s to ctrl-c before sending",
    async (key) => {
      const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

      await client.sendKey("surface:1", key, { workspace: "workspace:1" });

      expect(lastV2Request).not.toBeNull();
      expect(lastV2Request!.method).toBe("surface.send_key");
      expect(lastV2Request!.params).toEqual({
        surface_id: "surface:1",
        key: "ctrl-c",
        workspace_id: "workspace:1",
      });
    },
  );

  it("readScreen returns screen content", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    const result = await client.readScreen("surface:1", {
      workspace: "workspace:1",
    });
    expect(result).toHaveProperty("surface");
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("lines");
    expect(result).toHaveProperty("scrollback_used");
    expect(result.text).toContain("hello");
  });

  it("newSplit creates a surface and returns refs", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    const result = await client.newSplit("right", { workspace: "workspace:1" });
    expect(lastV2Request).toEqual({
      method: "surface.split",
      params: {
        direction: "right",
        workspace_id: "workspace:1",
        surface_id: "surface:1",
      },
    });
    expect(result).toHaveProperty("workspace");
    expect(result).toHaveProperty("surface");
    expect(result).toHaveProperty("pane");
    expect(result).toHaveProperty("type");
    expect(result.type).toBe("terminal");
  });

  it("newSplit resolves pane targets to surface_id for terminal splits", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.newSplit("right", {
      workspace: "workspace:1",
      pane: "pane:1",
    });

    expect(lastV2Request).toEqual({
      method: "surface.split",
      params: {
        direction: "right",
        workspace_id: "workspace:1",
        surface_id: "surface:1",
      },
    });
    expect(lastV2Request?.params).not.toHaveProperty("pane_id");
  });

  it("newSplit omits the pane anchor when the pane has no surfaces", async () => {
    const saved = MOCK_RESPONSES["surface.list"];
    MOCK_RESPONSES["surface.list"] = {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:empty",
      surfaces: [],
    };
    try {
      const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

      await client.newSplit("right", {
        workspace: "workspace:1",
        pane: "pane:empty",
      });

      expect(lastV2Request).toEqual({
        method: "surface.split",
        params: {
          direction: "right",
          workspace_id: "workspace:1",
        },
      });
    } finally {
      MOCK_RESPONSES["surface.list"] = saved;
    }
  });

  it("handles unknown methods gracefully", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    await expect(client.browser(["nonexistent"])).rejects.toThrow();
  });

  it("handles socket not available with CmuxSocketError", async () => {
    const client = new CmuxSocketClient({
      socketPath: "/tmp/cmux-does-not-exist.sock",
      timeoutMs: 1000,
    });
    await expect(client.ping()).rejects.toThrow();
  });

  it("listPaneSurfaces returns surfaces", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    const result = await client.listPaneSurfaces({ workspace: "workspace:1" });
    expect(result.surfaces).toBeInstanceOf(Array);
    expect(result.surfaces[0].ref).toBe("surface:1");
    expect(result.surfaces[0].type).toBe("terminal");
  });

  it("reuses one socket connection for 100 concurrent listPaneSurfaces calls", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: 100 }, () =>
        client.listPaneSurfaces({ workspace: "workspace:1" }),
      ),
    );

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(connectionCount).toBe(1);
  });

  it("listPanes returns panes", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    const result = await client.listPanes({ workspace: "workspace:1" });
    expect(result.panes).toBeInstanceOf(Array);
    expect(result.panes[0].ref).toBe("pane:1");
  });

  it("setStatus sends status", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    await client.setStatus("agent", "active", {
      icon: "bolt",
      workspace: "workspace:1",
    });
    // No throw = success
  });

  it("authenticates before V1 commands when password is configured", async () => {
    const client = new CmuxSocketClient({
      socketPath: MOCK_SOCKET_PATH,
      password: "secret",
    });

    await client.setStatus("agent", "active", {
      icon: "bolt",
      workspace: "workspace:1",
    });

    expect(mockEvents).toEqual(
      expect.arrayContaining([
        { type: "v2", method: "auth.login", params: { password: "secret" } },
        expect.objectContaining({ type: "v1", command: expect.stringContaining("set_status") }),
      ]),
    );
  });

  it("listStatus returns entries", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    const result = await client.listStatus({ workspace: "workspace:1" });
    expect(result).toBeInstanceOf(Array);
    expect(result[0].key).toBe("agent");
  });

  it("quotes status values with spaces for V1 sidebar commands", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.setStatus("agent", "brainlayerCodex: building", {
      workspace: "workspace:1",
    });

    expect(lastV1Command).toBe(
      `set_status agent "brainlayerCodex: building" --tab=${MOCK_WORKSPACE_ID}`,
    );
  });

  it("quotes progress labels with spaces for V1 sidebar commands", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.setProgress(0.95, {
      label: "enrichment 95%",
      workspace: "workspace:1",
    });

    expect(lastV1Command).toBe(
      `set_progress 0.95 --label "enrichment 95%" --tab=${MOCK_WORKSPACE_ID}`,
    );
  });

  it("quotes log values with spaces for V1 sidebar commands", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.log("agent finished cleanly", {
      workspace: "workspace:1",
    });

    expect(lastV1Command).toBe(
      `log --tab=${MOCK_WORKSPACE_ID} -- "agent finished cleanly"`,
    );
  });

  it("preserves flag-shaped log messages as message payloads", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.log("--workspace", {
      workspace: "workspace:1",
    });

    expect(lastV1Command).toBe(
      `log --tab=${MOCK_WORKSPACE_ID} -- "--workspace"`,
    );
  });

  it("quotes flag-shaped status values in the outgoing V1 command", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.setStatus("agent", "--workspace", {
      workspace: "workspace:1",
    });

    expect(lastV1Command).toBe(
      `set_status agent "--workspace" --tab=${MOCK_WORKSPACE_ID}`,
    );
  });

  it("resolves surface-derived workspaces to tab ids for V1 sidebar commands", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.setStatus("agent", "active", {
      surface: "surface:1",
    });

    expect(lastV1Command).toBe(
      `set_status agent active --tab=${MOCK_WORKSPACE_ID}`,
    );
  });

  it("resolves surface-targeted sidebar commands to the target surface workspace", async () => {
    const savedWorkspaceList = MOCK_RESPONSES["workspace.list"];
    const savedSurfaceList = MOCK_RESPONSES["surface.list"];
    const savedIdentify = MOCK_RESPONSES["system.identify"];

    MOCK_RESPONSES["workspace.list"] = {
      workspaces: [
        {
          id: MOCK_WORKSPACE_ID,
          ref: "workspace:1",
          title: "Caller WS",
          index: 0,
          selected: true,
          pinned: false,
        },
        {
          id: MOCK_SECOND_WORKSPACE_ID,
          ref: "workspace:2",
          title: "Target WS",
          index: 1,
          selected: false,
          pinned: false,
        },
      ],
    };
    MOCK_RESPONSES["surface.list"] = (req) => {
      const workspace = String(req.params.workspace_id ?? "");
      return {
        workspace_ref: workspace,
        window_ref: workspace === "workspace:2" ? "window:2" : "window:1",
        pane_ref: workspace === "workspace:2" ? "pane:2" : "pane:1",
        surfaces:
          workspace === "workspace:2"
            ? [
                {
                  ref: "surface:target",
                  title: "target",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ]
            : [
                {
                  ref: "surface:caller",
                  title: "caller",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ],
      };
    };
    MOCK_RESPONSES["system.identify"] = {
      caller: {
        workspace_ref: "workspace:1",
        surface_ref: "surface:caller",
        pane_ref: "pane:1",
      },
    };

    try {
      const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

      await client.setStatus("agent", "active", {
        surface: "surface:target",
      });
      expect(lastV1Command).toBe(
        `set_status agent active --tab=${MOCK_SECOND_WORKSPACE_ID}`,
      );

      await client.setProgress(0.5, {
        label: "halfway",
        surface: "surface:target",
      });
      expect(lastV1Command).toBe(
        `set_progress 0.5 --label halfway --tab=${MOCK_SECOND_WORKSPACE_ID}`,
      );

      await client.notify({
        title: "Done",
        surface: "surface:target",
      });
      expect(lastV1Command).toBe(
        "notify --title Done --workspace workspace:2 --surface surface:target",
      );
    } finally {
      MOCK_RESPONSES["workspace.list"] = savedWorkspaceList;
      MOCK_RESPONSES["surface.list"] = savedSurfaceList;
      MOCK_RESPONSES["system.identify"] = savedIdentify;
    }
  });

  it("falls back to the focused workspace for tab commands when a surface cannot be mapped", async () => {
    const savedWorkspaceList = MOCK_RESPONSES["workspace.list"];
    const savedSurfaceList = MOCK_RESPONSES["surface.list"];
    const savedIdentify = MOCK_RESPONSES["system.identify"];

    MOCK_RESPONSES["workspace.list"] = {
      workspaces: [
        {
          id: MOCK_WORKSPACE_ID,
          ref: "workspace:1",
          title: "Caller WS",
          index: 0,
          selected: true,
          pinned: false,
        },
        {
          id: MOCK_SECOND_WORKSPACE_ID,
          ref: "workspace:2",
          title: "Focused WS",
          index: 1,
          selected: false,
          pinned: false,
        },
      ],
    };
    MOCK_RESPONSES["surface.list"] = (req) => ({
      workspace_ref: String(req.params.workspace_id ?? ""),
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [],
    });
    MOCK_RESPONSES["system.identify"] = {
      focused: {
        workspace_ref: "workspace:2",
        surface_ref: "surface:focused",
        pane_ref: "pane:focused",
      },
    };

    try {
      const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

      await client.setStatus("agent", "active", {
        surface: "surface:unmapped",
      });
      expect(lastV1Command).toBe(
        `set_status agent active --tab=${MOCK_SECOND_WORKSPACE_ID}`,
      );

      await client.notify({
        title: "Done",
        surface: "surface:unmapped",
      });

      expect(lastV1Command).toBe(
        "notify --title Done --surface surface:unmapped",
      );
    } finally {
      MOCK_RESPONSES["workspace.list"] = savedWorkspaceList;
      MOCK_RESPONSES["surface.list"] = savedSurfaceList;
      MOCK_RESPONSES["system.identify"] = savedIdentify;
    }
  });

  it("preserves surface-only notify when workspace mapping is unsupported", async () => {
    const savedWorkspaceList = MOCK_RESPONSES["workspace.list"];
    MOCK_RESPONSES["workspace.list"] = undefined;

    try {
      const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

      await client.notify({
        title: "Done",
        surface: "surface:legacy",
      });

      expect(lastV1Command).toBe(
        "notify --title Done --surface surface:legacy",
      );
    } finally {
      MOCK_RESPONSES["workspace.list"] = savedWorkspaceList;
    }
  });

  it("renameTab sends V2 tab.action with rename params", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.renameTab("surface:1", "build logs", {
      workspace: "workspace:1",
    });

    expect(lastV2Request).not.toBeNull();
    expect(lastV2Request!.method).toBe("tab.action");
    expect(lastV2Request!.params).toEqual({
      action: "rename",
      surface_id: "surface:1",
      title: "build logs",
      workspace_id: "workspace:1",
    });
  });

  it("renameTab sends V2 tab.action without workspace when omitted", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.renameTab("surface:1", "agent run");

    expect(lastV2Request).not.toBeNull();
    expect(lastV2Request!.method).toBe("tab.action");
    expect(lastV2Request!.params).toEqual({
      action: "rename",
      surface_id: "surface:1",
      title: "agent run",
    });
  });
});

describe.skipIf(!CAN_BIND_MOCK_SOCKET)("CmuxSocketClient V2→CLI fallback", () => {
  let cliCalls: { method: string; args: unknown[] }[];

  function createMockCli(): CmuxClient {
    cliCalls = [];
    return {
      newSplit: async (direction: string, opts?: unknown) => {
        cliCalls.push({ method: "newSplit", args: [direction, opts] });
        return {
          workspace: "workspace:1",
          surface: "surface:cli",
          pane: "pane:cli",
          title: "",
          type: "terminal" as const,
        };
      },
      newSurface: async (opts: unknown) => {
        cliCalls.push({ method: "newSurface", args: [opts] });
        return {
          workspace: "workspace:1",
          surface: "surface:cli-tab",
          pane: "pane:cli",
          title: "",
          type: "terminal" as const,
        };
      },
      moveSurface: async (opts: unknown) => {
        cliCalls.push({ method: "moveSurface", args: [opts] });
        return {
          ok: true,
          workspace: "workspace:2",
          surface: "surface:cli-tab",
          pane: "pane:cli",
        };
      },
      reorderSurface: async (opts: unknown) => {
        cliCalls.push({ method: "reorderSurface", args: [opts] });
        return {
          ok: true,
          surface: "surface:cli-tab",
        };
      },
      closeSurface: async (surface: string, opts?: unknown) => {
        cliCalls.push({ method: "closeSurface", args: [surface, opts] });
      },
      pasteText: async (surface: string, text: string, opts?: unknown) => {
        cliCalls.push({ method: "pasteText", args: [surface, text, opts] });
      },
    } as unknown as CmuxClient;
  }

  it("newSplit falls back to CLI when surface.split returns method_not_found", async () => {
    const saved = MOCK_RESPONSES["surface.split"];
    delete MOCK_RESPONSES["surface.split"];
    try {
      const client = new CmuxSocketClient({
        socketPath: MOCK_SOCKET_PATH,
        cliFallback: createMockCli(),
      });
      const result = await client.newSplit("right", {
        workspace: "workspace:1",
      });
      expect(cliCalls).toHaveLength(1);
      expect(cliCalls[0].method).toBe("newSplit");
      expect(result.surface).toBe("surface:cli");
    } finally {
      MOCK_RESPONSES["surface.split"] = saved;
    }
  });

  it("newSplit browser falls back to CLI when pane.create returns method_not_found", async () => {
    // pane.create is already NOT in MOCK_RESPONSES
    const client = new CmuxSocketClient({
      socketPath: MOCK_SOCKET_PATH,
      cliFallback: createMockCli(),
    });
    const result = await client.newSplit("right", {
      workspace: "workspace:1",
      type: "browser",
      url: "https://example.com",
    });
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].method).toBe("newSplit");
    expect(cliCalls[0].args[1]).toMatchObject({ type: "browser" });
  });

  it("closeSurface falls back to CLI when surface.close returns method_not_found", async () => {
    const saved = MOCK_RESPONSES["surface.close"];
    delete MOCK_RESPONSES["surface.close"];
    try {
      const client = new CmuxSocketClient({
        socketPath: MOCK_SOCKET_PATH,
        cliFallback: createMockCli(),
      });
      await client.closeSurface("surface:1", { workspace: "workspace:1" });
      expect(cliCalls).toHaveLength(1);
      expect(cliCalls[0].method).toBe("closeSurface");
      expect(cliCalls[0].args[0]).toBe("surface:1");
    } finally {
      MOCK_RESPONSES["surface.close"] = saved;
    }
  });

  it("closeSurface forwards collapse-pane over the socket", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });

    await client.closeSurface("surface:1", {
      workspace: "workspace:1",
      collapsePane: true,
    });

    expect(lastV2Request).toMatchObject({
      method: "surface.close",
      params: {
        surface_id: "surface:1",
        workspace_id: "workspace:1",
        collapse_pane: true,
      },
    });
  });

  it("newSurface uses CLI fallback", async () => {
    const client = new CmuxSocketClient({
      socketPath: MOCK_SOCKET_PATH,
      cliFallback: createMockCli(),
    });
    const result = await client.newSurface({
      pane: "pane:1",
      workspace: "workspace:1",
    });
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].method).toBe("newSurface");
    expect(cliCalls[0].args[0]).toMatchObject({
      pane: "pane:1",
      workspace: "workspace:1",
    });
    expect(result.surface).toBe("surface:cli-tab");
  });

  it("pasteText fails loudly without a CLI fallback instead of sending raw markers", async () => {
    const client = new CmuxSocketClient({
      socketPath: MOCK_SOCKET_PATH,
      timeoutMs: 1000,
    });

    await expect(
      client.pasteText("surface:1", "line one\nline two", {
        workspace: "workspace:1",
      }),
    ).rejects.toMatchObject({
      name: "CmuxSocketError",
      code: "method_not_found",
      message: expect.stringContaining("requires the cmux CLI"),
    });

    expect(lastV2Request).toBeNull();
  });

  it("pasteText uses CLI paste-buffer fallback without sending bracketed markers over the socket", async () => {
    const execCalls: Array<{
      cmd: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const cliFallback = new CmuxClient({
      exec: async (cmd, args, env) => {
        execCalls.push({ cmd, args, env });
        return { stdout: "{}", stderr: "" };
      },
    });
    const client = new CmuxSocketClient({
      socketPath: MOCK_SOCKET_PATH,
      cliFallback,
    });

    await client.pasteText("surface:1", "line one\nline two", {
      workspace: "workspace:1",
    });

    expect(lastV2Request).toBeNull();
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0].args).toEqual([
      "--json",
      "set-buffer",
      "--name",
      expect.stringMatching(/^cmuxlayer-workspace-1-surface-1-/),
      "--",
      "line one\nline two",
    ]);
    expect(execCalls[1].args).toEqual([
      "--json",
      "paste-buffer",
      "--name",
      execCalls[0].args[3],
      "--surface",
      "surface:1",
      "--workspace",
      "workspace:1",
    ]);
    expect(execCalls[0].env?.CMUX_SOCKET_PATH).toBe(MOCK_SOCKET_PATH);
    expect(execCalls[1].env?.CMUX_SOCKET_PATH).toBe(MOCK_SOCKET_PATH);
  });

  it("moveSurface uses CLI fallback", async () => {
    const client = new CmuxSocketClient({
      socketPath: MOCK_SOCKET_PATH,
      cliFallback: createMockCli(),
    });
    const result = await client.moveSurface({
      surface: "surface:1",
      workspace: "workspace:1",
      pane: "pane:2",
    });
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].method).toBe("moveSurface");
    expect(cliCalls[0].args[0]).toMatchObject({
      surface: "surface:1",
      workspace: "workspace:1",
      pane: "pane:2",
    });
    expect(result.surface).toBe("surface:cli-tab");
  });

  it("reorderSurface uses CLI fallback", async () => {
    const client = new CmuxSocketClient({
      socketPath: MOCK_SOCKET_PATH,
      cliFallback: createMockCli(),
    });
    const result = await client.reorderSurface({
      surface: "surface:1",
      after: "surface:2",
    });
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].method).toBe("reorderSurface");
    expect(cliCalls[0].args[0]).toMatchObject({
      surface: "surface:1",
      after: "surface:2",
    });
    expect(result.surface).toBe("surface:cli-tab");
  });

  it("newSplit throws when no CLI fallback and method_not_found", async () => {
    const saved = MOCK_RESPONSES["surface.split"];
    delete MOCK_RESPONSES["surface.split"];
    try {
      const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
      await expect(
        client.newSplit("right", { workspace: "workspace:1" }),
      ).rejects.toThrow("method_not_found");
    } finally {
      MOCK_RESPONSES["surface.split"] = saved;
    }
  });

  it("closeSurface throws when no CLI fallback and method_not_found", async () => {
    const saved = MOCK_RESPONSES["surface.close"];
    delete MOCK_RESPONSES["surface.close"];
    try {
      const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
      await expect(
        client.closeSurface("surface:1", { workspace: "workspace:1" }),
      ).rejects.toThrow("method_not_found");
    } finally {
      MOCK_RESPONSES["surface.close"] = saved;
    }
  });

  it("uses V2 when method is available (no fallback triggered)", async () => {
    // surface.split IS in MOCK_RESPONSES — V2 should work directly
    const client = new CmuxSocketClient({
      socketPath: MOCK_SOCKET_PATH,
      cliFallback: createMockCli(),
    });
    const result = await client.newSplit("right", { workspace: "workspace:1" });
    expect(cliCalls).toHaveLength(0);
    expect(result.surface).toBe("surface:2"); // from MOCK_RESPONSES
  });

  it("re-pins the shared CLI fallback to its own socket before pasting (collab O2 #8)", async () => {
    // Reproduce the live failure: one CmuxClient is shared as cliFallback by
    // BOTH socket clients (exactly what createCmuxClient does). A long paste to
    // the nightly-pinned client must carry CMUX_SOCKET_PATH=nightly even though
    // the prod-pinned client synced the shared fallback last.
    const execEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const exec: ExecFn = vi.fn(async (_cmd, _args, env) => {
      execEnvs.push(env);
      return { stdout: "{}", stderr: "" };
    });
    const sharedCli = new CmuxClient({ exec });
    const saved = MOCK_RESPONSES["surface.send_text"];
    delete MOCK_RESPONSES["surface.send_text"];

    try {
      const firstClient = new CmuxSocketClient({
        socketPath: MOCK_SOCKET_PATH,
        cliFallback: sharedCli,
      });
      const secondClient = new CmuxSocketClient({
        socketPath: MOCK_SOCKET_PATH,
        cliFallback: sharedCli,
      });
      await secondClient.pasteText("surface:p", "second text", {
        workspace: "workspace:1",
      });

      execEnvs.length = 0;
      await firstClient.pasteText("surface:n", "first text", {
        workspace: "workspace:1",
      });

      expect(execEnvs.length).toBeGreaterThan(0);
      for (const env of execEnvs) {
        expect(env?.CMUX_SOCKET_PATH).toBe(MOCK_SOCKET_PATH);
      }
    } finally {
      MOCK_RESPONSES["surface.send_text"] = saved;
    }
  });
});

describe.skipIf(!CAN_BIND_MOCK_SOCKET)("createCmuxClient factory", () => {
  it("returns a socket-mode client when socket is available", async () => {
    const client = await createCmuxClient({ socketPath: MOCK_SOCKET_PATH });
    expect(getTransportHealth(client)).toMatchObject({
      mode: "socket",
      degraded: false,
      current_socket_path: MOCK_SOCKET_PATH,
    });
  });

  it("falls back to CLI mode when socket is unavailable", async () => {
    const client = await createCmuxClient({
      socketPath: "/tmp/cmux-does-not-exist.sock",
    });
    expect(getTransportHealth(client)).toMatchObject({
      mode: "cli",
      degraded: true,
    });
  });

  it("uses last-socket-path before legacy defaults when no env socket is set", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-state-"));
    const liveSocketPath = join(stateDir, "cmux-live.sock");
    fs.writeFileSync(
      join(stateDir, "last-socket-path"),
      `${liveSocketPath}\n`,
      "utf-8",
    );
    const server = await startSocketServer(liveSocketPath);
    const savedEnv = process.env.CMUX_SOCKET_PATH;
    delete process.env.CMUX_SOCKET_PATH;
    const logger = { error: vi.fn() };

    try {
      const client = await createCmuxClient({
        socketStateDir: stateDir,
        logger,
      });

      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: liveSocketPath,
      });
      expect(logger.error).toHaveBeenCalledWith(
        "[cmuxlayer] transport selected: socket",
      );
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.stringContaining(liveSocketPath),
      );
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CMUX_SOCKET_PATH;
      } else {
        process.env.CMUX_SOCKET_PATH = savedEnv;
      }
      await stopSocketServer(server, liveSocketPath);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("binds CLI fallback calls to the selected socket path", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-state-"));
    const liveSocketPath = join(stateDir, "cmux-live.sock");
    const fakeCmux = join(stateDir, "cmux-fake");
    fs.writeFileSync(
      fakeCmux,
      [
        "#!/bin/sh",
        `if [ "$CMUX_SOCKET_PATH" != "${liveSocketPath}" ]; then`,
        '  echo "wrong socket: $CMUX_SOCKET_PATH" >&2',
        "  exit 42",
        "fi",
        'printf \'{"workspace_ref":"workspace:1","surface_ref":"surface:cli","pane_ref":"pane:1","type":"terminal"}\\n\'',
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(fakeCmux, 0o755);
    const server = await startSocketServer(liveSocketPath);

    try {
      const client = await createCmuxClient({
        socketPath: liveSocketPath,
        bin: fakeCmux,
      });

      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: liveSocketPath,
      });
      const result = await (client as CmuxSocketClient).newSurface({
        pane: "pane:1",
        workspace: "workspace:1",
      });
      expect(result.surface).toBe("surface:cli");
    } finally {
      await stopSocketServer(server, liveSocketPath);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("probes the uid-suffixed state socket when last-socket-path is absent", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-state-"));
    const uid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    const liveSocketPath = join(
      stateDir,
      uid === undefined ? "cmux.sock" : `cmux-${uid}.sock`,
    );
    const server = await startSocketServer(liveSocketPath);
    const savedEnv = process.env.CMUX_SOCKET_PATH;
    delete process.env.CMUX_SOCKET_PATH;

    try {
      const client = await createCmuxClient({
        socketStateDir: stateDir,
      });

      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: liveSocketPath,
      });
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CMUX_SOCKET_PATH;
      } else {
        process.env.CMUX_SOCKET_PATH = savedEnv;
      }
      await stopSocketServer(server, liveSocketPath);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("re-probes candidate sockets after the selected socket fails", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-state-"));
    const firstSocketPath = join(stateDir, "first.sock");
    const secondSocketPath = join(stateDir, "second.sock");
    fs.writeFileSync(
      join(stateDir, "last-socket-path"),
      `${firstSocketPath}\n`,
      "utf-8",
    );
    const firstServer = await startSocketServer(firstSocketPath);
    const savedEnv = process.env.CMUX_SOCKET_PATH;
    delete process.env.CMUX_SOCKET_PATH;

    let secondServer: net.Server | null = null;
    try {
      const client = await createCmuxClient({
        socketStateDir: stateDir,
      });
      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: firstSocketPath,
      });
      expect(await client.ping()).toBe(true);

      await stopSocketServer(firstServer, firstSocketPath);
      fs.writeFileSync(
        join(stateDir, "last-socket-path"),
        `${secondSocketPath}\n`,
        "utf-8",
      );
      secondServer = await startSocketServer(secondSocketPath);

      await expect(client.ping()).resolves.toBe(true);
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CMUX_SOCKET_PATH;
      } else {
        process.env.CMUX_SOCKET_PATH = savedEnv;
      }
      if (secondServer) {
        await stopSocketServer(secondServer, secondSocketPath);
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("flushes a failed mutating socket call through CLI fallback", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-state-"));
    const firstSocketPath = join(stateDir, "first.sock");
    fs.writeFileSync(
      join(stateDir, "last-socket-path"),
      `${firstSocketPath}\n`,
      "utf-8",
    );
    const first = await startCloseAfterMethodServer(
      firstSocketPath,
      "surface.send_text",
    );
    const savedEnv = process.env.CMUX_SOCKET_PATH;
    delete process.env.CMUX_SOCKET_PATH;
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });

    try {
      const client = await createCmuxClient({
        socketStateDir: stateDir,
        exec,
        bin: "cmux",
        reprobeIntervalMs: 60_000,
      });
      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: firstSocketPath,
      });

      await expect(
        client.send("surface:1", "do-not-duplicate", {
          workspace: "workspace:1",
        }),
      ).resolves.toBeUndefined();
      expect(first.seenMethods).toContain("surface.send_text");
      expect(exec).toHaveBeenCalledWith(
        "cmux",
        [
          "--json",
          "send",
          "--surface",
          "surface:1",
          "--workspace",
          "workspace:1",
          "do-not-duplicate",
        ],
        expect.objectContaining({ CMUX_SOCKET_PATH: firstSocketPath }),
      );
      expect(getTransportHealth(client)).toMatchObject({
        mode: "cli",
        degraded: true,
        current_socket_path: firstSocketPath,
      });
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CMUX_SOCKET_PATH;
      } else {
        process.env.CMUX_SOCKET_PATH = savedEnv;
      }
      await stopSocketServer(first.server, firstSocketPath);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not hop sockets after non-transport protocol errors", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-state-"));
    const firstSocketPath = join(stateDir, "first.sock");
    const secondSocketPath = join(stateDir, "second.sock");
    const firstServer = await startProtocolErrorServer(firstSocketPath);
    const secondServer = await startSocketServer(secondSocketPath);

    try {
      const client = new CmuxSocketClient({
        socketPath: firstSocketPath,
        socketPathResolver: async () => secondSocketPath,
      });

      await expect(client.ping()).rejects.toThrow(/method_not_found/i);
    } finally {
      await stopSocketServer(firstServer, firstSocketPath);
      await stopSocketServer(secondServer, secondSocketPath);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("skips listening but unusable sockets during runtime re-resolution", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-state-"));
    const firstSocketPath = join(stateDir, "first.sock");
    const badSocketPath = join(stateDir, "bad.sock");
    const uid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    const healthySocketPath = join(
      stateDir,
      uid === undefined ? "cmux.sock" : `cmux-${uid}.sock`,
    );
    fs.writeFileSync(
      join(stateDir, "last-socket-path"),
      `${firstSocketPath}\n`,
      "utf-8",
    );
    const firstServer = await startSocketServer(firstSocketPath);
    const savedEnv = process.env.CMUX_SOCKET_PATH;
    delete process.env.CMUX_SOCKET_PATH;

    let badServer: net.Server | null = null;
    let healthyServer: net.Server | null = null;
    try {
      const client = await createCmuxClient({
        socketStateDir: stateDir,
      });
      expect(getTransportHealth(client)).toMatchObject({
        mode: "socket",
        degraded: false,
        current_socket_path: firstSocketPath,
      });
      expect(await client.ping()).toBe(true);

      await stopSocketServer(firstServer, firstSocketPath);
      fs.writeFileSync(
        join(stateDir, "last-socket-path"),
        `${badSocketPath}\n`,
        "utf-8",
      );
      badServer = await startProtocolErrorServer(badSocketPath);
      healthyServer = await startSocketServer(healthySocketPath);

      await expect(client.ping()).resolves.toBe(true);
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CMUX_SOCKET_PATH;
      } else {
        process.env.CMUX_SOCKET_PATH = savedEnv;
      }
      if (badServer) await stopSocketServer(badServer, badSocketPath);
      if (healthyServer) {
        await stopSocketServer(healthyServer, healthySocketPath);
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent reconnects through one socket re-resolution", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-state-"));
    const firstSocketPath = join(stateDir, "missing.sock");
    const secondSocketPath = join(stateDir, "second.sock");
    const secondServer = await startSocketServer(secondSocketPath);
    let resolverCalls = 0;

    try {
      const client = new CmuxSocketClient({
        socketPath: firstSocketPath,
        timeoutMs: 50,
        socketPathResolver: async () => {
          resolverCalls++;
          return secondSocketPath;
        },
      });

      await expect(Promise.all([client.ping(), client.ping()])).resolves.toEqual(
        [true, true],
      );
      expect(resolverCalls).toBe(1);
    } finally {
      await stopSocketServer(secondServer, secondSocketPath);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
