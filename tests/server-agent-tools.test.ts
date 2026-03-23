/**
 * Integration tests for the 7 agent lifecycle MCP tools registered in server.ts.
 * Tests tool registration and handler dispatch with mocked cmux client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-server-tools");

const AGENT_TOOLS = [
  "spawn_agent",
  "wait_for",
  "wait_for_all",
  "get_agent_state",
  "list_agents",
  "stop_agent",
  "send_to_agent",
] as const;

describe("agent lifecycle tool registration", () => {
  it("registers all 7 agent lifecycle tools when lifecycle is enabled", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const registeredTools = (server as any)._registeredTools;
    const toolNames = Object.keys(registeredTools);

    for (const expected of AGENT_TOOLS) {
      expect(toolNames, `Missing tool: ${expected}`).toContain(expected);
    }
  });

  it("does NOT register agent tools when skipAgentLifecycle is true", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "{}",
      stderr: "",
    });
    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
    });
    const registeredTools = (server as any)._registeredTools;
    const toolNames = Object.keys(registeredTools);

    for (const tool of AGENT_TOOLS) {
      expect(toolNames).not.toContain(tool);
    }
  });

  it("total tool count is 21 (11 low-level + 8 agent lifecycle + 2 v2)", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const registeredTools = (server as any)._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(21);
  });
});

describe("agent lifecycle tool handlers", () => {
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

  it("spawn_agent returns agent_id and surface_id", async () => {
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix gap F",
      },
      {} as any,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toMatch(/^sonnet-brainlayer-\d+-[a-z0-9]+$/);
    expect(parsed.surface_id).toBe("surface:new");
    expect(parsed.state).toBe("booting");
  });

  it("list_agents returns agents after spawn", async () => {
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];

    await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "task 1",
      },
      {} as any,
    );

    const result = await list.handler({}, {} as any);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0].repo).toBe("brainlayer");
  });

  it("get_agent_state returns full record", async () => {
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "golems",
        model: "codex",
        cli: "codex",
        prompt: "prune skills",
      },
      {} as any,
    );
    const agentId = JSON.parse(spawnResult.content[0].text).agent_id;

    const result = await getState.handler({ agent_id: agentId }, {} as any);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(parsed.cli).toBe("codex");
  });

  it("get_agent_state returns error for unknown agent", async () => {
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const getState = (server as any)._registeredTools["get_agent_state"];

    const result = await getState.handler(
      { agent_id: "nonexistent" },
      {} as any,
    );
    expect(result.isError).toBe(true);
  });

  it("send_to_agent rejects agents not in interactive state", async () => {
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to_agent"];

    const spawnResult = await spawn.handler(
      {
        repo: "test",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = JSON.parse(spawnResult.content[0].text).agent_id;

    // Agent is in "booting" state — not interactive
    const result = await sendTo.handler(
      { agent_id: agentId, text: "hello", press_enter: true },
      {} as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not in an interactive state/);
  });
});
