/**
 * Tests for Phase 5 audit fixes:
 * 1. CRITICAL: read_agent_output must use .text (not .content) from readScreen
 * 2. HIGH: CmuxPersistentSocket reconnection with exponential backoff + jitter
 * 3. MEDIUM: spawn_agent MCP schema exposes parent_agent_id and max_cost_per_agent
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as net from "node:net";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { CmuxPersistentSocket } from "../src/cmux-persistent-socket.js";
import { CmuxSocketError } from "../src/cmux-socket-client.js";

const TEST_DIR = join(tmpdir(), "cmux-audit-fixes-test");

// ── 1. CRITICAL: read_agent_output uses .text ──────────────────────────

describe("read_agent_output uses CmuxReadScreenResult.text", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("extracts delimited content from readScreen .text field", async () => {
    const screenText =
      "some preamble\nOUTPUT_START\nhello world\nOUTPUT_END\ntrailing";

    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:1",
        text: screenText,
        lines: 5,
        scrollback_used: true,
      }),
      // Stubs for other client methods used during server init
      listSurfaces: vi.fn().mockResolvedValue([]),
      send: vi.fn(),
      sendKey: vi.fn(),
      newSplit: vi.fn(),
      renameTab: vi.fn(),
      closeSurface: vi.fn(),
      run: vi.fn(),
    };

    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });

    const server = createServer({
      exec: mockExec,
      client: mockClient as any,
      stateDir: TEST_DIR,
    });
    const tool = (server as any)._registeredTools["read_agent_output"];
    expect(tool).toBeDefined();

    const result = await tool.handler(
      { surface: "surface:1", tag: "OUTPUT", lines: 200 },
      {} as any,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.found).toBe(true);
    expect(parsed.content).toBe("hello world");
  });

  it("returns found:false when markers are absent", async () => {
    const mockClient = {
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:1",
        text: "no markers here",
        lines: 1,
        scrollback_used: false,
      }),
      listSurfaces: vi.fn().mockResolvedValue([]),
      send: vi.fn(),
      sendKey: vi.fn(),
      newSplit: vi.fn(),
      renameTab: vi.fn(),
      closeSurface: vi.fn(),
      run: vi.fn(),
    };

    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });

    const server = createServer({
      exec: mockExec,
      client: mockClient as any,
      stateDir: TEST_DIR,
    });
    const tool = (server as any)._registeredTools["read_agent_output"];

    const result = await tool.handler(
      { surface: "surface:1", tag: "OUTPUT", lines: 200 },
      {} as any,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.found).toBe(false);
  });
});

// ── 2. HIGH: CmuxPersistentSocket exponential backoff + jitter ─────────

describe("CmuxPersistentSocket exponential backoff with jitter", () => {
  const MOCK_SOCKET_PATH = join(tmpdir(), "cmux-backoff-test.sock");
  let mockServer: net.Server | null = null;

  function startMockServer(): Promise<net.Server> {
    return new Promise((resolve) => {
      const srv = net.createServer((conn) => {
        conn.on("data", (chunk) => {
          const req = JSON.parse(chunk.toString().trim());
          const resp = JSON.stringify({
            id: req.id,
            ok: true,
            result: { pong: true },
          });
          conn.write(resp + "\n");
        });
      });
      try {
        require("node:fs").unlinkSync(MOCK_SOCKET_PATH);
      } catch {}
      srv.listen(MOCK_SOCKET_PATH, () => resolve(srv));
    });
  }

  afterEach(() => {
    if (mockServer) {
      mockServer.close();
      mockServer = null;
    }
    try {
      require("node:fs").unlinkSync(MOCK_SOCKET_PATH);
    } catch {}
  });

  it("exposes backoff configuration options", () => {
    const socket = new CmuxPersistentSocket({
      socketPath: MOCK_SOCKET_PATH,
      backoff: {
        baseMs: 100,
        maxMs: 5000,
        jitter: true,
      },
    });
    // Should construct without error
    expect(socket).toBeDefined();
    socket.disconnect();
  });

  it("increases delay between reconnection attempts", () => {
    const socket = new CmuxPersistentSocket({
      socketPath: MOCK_SOCKET_PATH,
      timeoutMs: 500,
      backoff: {
        baseMs: 50,
        maxMs: 1000,
        jitter: false, // disable jitter for deterministic test
      },
    });

    expect(socket.currentBackoffMs()).toBe(0);

    // First failure → baseMs * 2^0 = 50
    socket.incrementBackoff();
    const delay1 = socket.currentBackoffMs();
    expect(delay1).toBe(50);

    // Second failure → baseMs * 2^1 = 100
    socket.incrementBackoff();
    const delay2 = socket.currentBackoffMs();
    expect(delay2).toBe(100);

    // Third → 200
    socket.incrementBackoff();
    expect(socket.currentBackoffMs()).toBe(200);

    socket.disconnect();
  });

  it("resets backoff after successful connection", async () => {
    mockServer = await startMockServer();
    const socket = new CmuxPersistentSocket({
      socketPath: MOCK_SOCKET_PATH,
      timeoutMs: 500,
      backoff: {
        baseMs: 50,
        maxMs: 1000,
        jitter: false,
      },
    });

    // Simulate some failures
    socket.incrementBackoff();
    socket.incrementBackoff();
    expect(socket.currentBackoffMs()).toBe(100);

    // Successful connect should reset backoff
    await socket.connect();
    expect(socket.isConnected()).toBe(true);
    expect(socket.currentBackoffMs()).toBe(0);

    socket.disconnect();
  });

  it("caps backoff at maxMs", () => {
    const socket = new CmuxPersistentSocket({
      socketPath: MOCK_SOCKET_PATH,
      backoff: {
        baseMs: 100,
        maxMs: 500,
        jitter: false,
      },
    });

    // Simulate many failures — backoff should never exceed maxMs
    // (This tests the internal calculation, exposed via currentBackoffMs)
    for (let i = 0; i < 20; i++) {
      socket.incrementBackoff();
    }
    expect(socket.currentBackoffMs()).toBeLessThanOrEqual(500);

    socket.disconnect();
  });

  it("applies jitter when enabled", () => {
    const socket = new CmuxPersistentSocket({
      socketPath: MOCK_SOCKET_PATH,
      backoff: {
        baseMs: 100,
        maxMs: 5000,
        jitter: true,
      },
    });

    // With jitter, repeated calls should produce varying delays
    const delays = new Set<number>();
    for (let i = 0; i < 10; i++) {
      socket.incrementBackoff();
      delays.add(socket.currentBackoffMs());
      socket.resetBackoff();
      socket.incrementBackoff();
    }
    // With jitter there should be some variance (not all identical)
    // At minimum it should not be exactly the same every time
    expect(delays.size).toBeGreaterThan(1);

    socket.disconnect();
  });
});

// ── 3. MEDIUM: spawn_agent exposes parent_agent_id + max_cost_per_agent ─

describe("spawn_agent MCP schema includes parent_agent_id and max_cost_per_agent", () => {
  let mockExec: ExecFn;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mockExec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        workspace: "ws:1",
        surface: "surface:new",
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("accepts parent_agent_id in spawn_agent", async () => {
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });

    // First spawn a parent
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parentResult = await spawn.handler(
      { repo: "test", model: "sonnet", cli: "claude", prompt: "parent task" },
      {} as any,
    );
    const parentId = JSON.parse(parentResult.content[0].text).agent_id;

    // Spawn child with parent_agent_id
    const childResult = await spawn.handler(
      {
        repo: "test",
        model: "haiku",
        cli: "claude",
        prompt: "child task",
        parent_agent_id: parentId,
      },
      {} as any,
    );
    const childParsed = JSON.parse(childResult.content[0].text);
    expect(childParsed.ok).toBe(true);
    expect(childParsed.agent_id).toBeDefined();
  });

  it("accepts max_cost_per_agent in spawn_agent", async () => {
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "test",
        model: "opus",
        cli: "claude",
        prompt: "expensive task",
        max_cost_per_agent: 5.0,
      },
      {} as any,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("rejects invalid parent_agent_id", async () => {
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "test",
        model: "sonnet",
        cli: "claude",
        prompt: "orphan",
        parent_agent_id: "nonexistent-agent",
      },
      {} as any,
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not found/i);
  });
});
