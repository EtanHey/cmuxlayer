/**
 * Tests for CmuxSocketClient and createCmuxClient factory.
 *
 * These tests use a mock Unix socket server to validate:
 * 1. CmuxSocketClient implements the same interface as CmuxClient
 * 2. The factory pattern (socket-first, CLI fallback)
 * 3. Error handling and connection lifecycle
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { createCmuxClient } from "../src/cmux-client-factory.js";

// ── Mock V2 Socket Server ──────────────────────────────────────────────

const MOCK_SOCKET_PATH = "/tmp/cmux-test-mock.sock";

const MOCK_RESPONSES: Record<string, unknown> = {
  "system.ping": { pong: true },
  "workspace.list": {
    workspaces: [
      {
        ref: "workspace:1",
        title: "Test WS",
        index: 0,
        selected: true,
        pinned: false,
      },
    ],
  },
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
  "pane.split": {
    workspace_ref: "workspace:1",
    surface_ref: "surface:2",
    pane_ref: "pane:2",
    title: "",
    type: "terminal",
  },
  "surface.rename": {},
  "status.set": {},
  "status.clear": {},
  "status.list": { entries: [{ key: "agent", value: "active", icon: "bolt" }] },
  "progress.set": {},
  "progress.clear": {},
  "notification.create": {},
  "surface.close": {},
  "system.identify": {
    caller: {
      workspace_ref: "workspace:1",
      surface_ref: "surface:1",
      pane_ref: "pane:1",
    },
  },
};

let mockServer: net.Server;

function startMockServer(): Promise<void> {
  return new Promise((resolve) => {
    // Clean up stale socket
    try {
      fs.unlinkSync(MOCK_SOCKET_PATH);
    } catch {
      /* ignore */
    }

    mockServer = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;

          try {
            const req = JSON.parse(line);
            const method = req.method as string;
            const result = MOCK_RESPONSES[method];

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
            // ignore parse errors
          }
        }
      });
    });

    mockServer.listen(MOCK_SOCKET_PATH, () => resolve());
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
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

// ── Shared lifecycle ───────────────────────────────────────────────────

beforeAll(async () => {
  await startMockServer();
});

afterAll(async () => {
  await stopMockServer();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("CmuxSocketClient", () => {
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

  it("send delivers text to a surface", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    // Should not throw
    await client.send("surface:1", "echo hello", { workspace: "workspace:1" });
  });

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
    expect(result).toHaveProperty("workspace");
    expect(result).toHaveProperty("surface");
    expect(result).toHaveProperty("pane");
    expect(result).toHaveProperty("type");
    expect(result.type).toBe("terminal");
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

  it("listStatus returns entries", async () => {
    const client = new CmuxSocketClient({ socketPath: MOCK_SOCKET_PATH });
    const result = await client.listStatus({ workspace: "workspace:1" });
    expect(result).toBeInstanceOf(Array);
    expect(result[0].key).toBe("agent");
  });
});

describe("createCmuxClient factory", () => {
  it("returns CmuxSocketClient when socket is available", async () => {
    const client = await createCmuxClient({ socketPath: MOCK_SOCKET_PATH });
    expect(client).toBeInstanceOf(CmuxSocketClient);
  });

  it("falls back to CmuxClient when socket is unavailable", async () => {
    const client = await createCmuxClient({
      socketPath: "/tmp/cmux-does-not-exist.sock",
    });
    // Should not be a CmuxSocketClient
    expect(client).not.toBeInstanceOf(CmuxSocketClient);
  });
});
