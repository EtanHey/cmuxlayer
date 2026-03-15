/**
 * TDD tests for V2 interact + kill tools.
 * These are the 2-tool public facade over the 7 internal engine methods.
 *
 * Design decisions tested:
 * - Flat enum action type (Decision 1)
 * - Runtime validation per action with isError:true (Decision 2)
 * - Extra fields silently ignored — Zod default strip (Decision 3)
 * - interact: alive → send, not alive → spawn+wait+send (Decision 18)
 * - kill: scoped target — single, array, workspace, all (Decision 18)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-v2");

function callTool(server: any, name: string, args: Record<string, unknown>) {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {} as any);
}

function parseResult(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe("V2 tool registration", () => {
  it("registers interact and kill tools", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const server = createServer({ exec: mockExec, stateDir: TEST_DIR });
    const tools = Object.keys((server as any)._registeredTools);
    expect(tools).toContain("interact");
    expect(tools).toContain("kill");
  });

  it("total tool count is 20 (10 low-level + 8 agent lifecycle + 2 v2)", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const server = createServer({ exec: mockExec, stateDir: TEST_DIR });
    const count = Object.keys((server as any)._registeredTools).length;
    expect(count).toBe(20);
  });
});

describe("interact — runtime validation", () => {
  let mockExec: ExecFn;
  let server: any;

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
    server = createServer({ exec: mockExec, stateDir: TEST_DIR });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("action=send requires text field", async () => {
    const result = await callTool(server, "interact", {
      agent: "brain",
      action: "send",
      // text is missing
    });
    const parsed = parseResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/text.*required/i);
  });

  it("action=model requires model field", async () => {
    const result = await callTool(server, "interact", {
      agent: "brain",
      action: "model",
      // model is missing
    });
    const parsed = parseResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/model.*required/i);
  });

  it("action=skill requires command field", async () => {
    const result = await callTool(server, "interact", {
      agent: "brain",
      action: "skill",
      // command is missing
    });
    const parsed = parseResult(result);
    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/command.*required/i);
  });

  it("action=interrupt does not require extra fields", async () => {
    // Spawn an agent first so we can interrupt it
    await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "test",
    });
    // Get the agent_id
    const listResult = await callTool(server, "list_agents", {});
    const agents = parseResult(listResult).agents;
    const agentId = agents[0]?.agent_id;

    // Now interact with interrupt — agent won't be "ready" so it will
    // try to match by name, but the point is that validation passes
    const result = await callTool(server, "interact", {
      agent: agentId,
      action: "interrupt",
    });
    // Should not be a validation error (may be a state error, that's OK)
    const parsed = parseResult(result);
    if (result.isError) {
      expect(parsed.error).not.toMatch(/required/i);
    }
  });

  it("action=usage does not require extra fields", async () => {
    const result = await callTool(server, "interact", {
      agent: "nonexistent",
      action: "usage",
    });
    // Will fail with "agent not found" not "missing field"
    const parsed = parseResult(result);
    if (result.isError) {
      expect(parsed.error).not.toMatch(/required/i);
    }
  });
});

describe("interact — agent resolution", () => {
  let mockExec: ExecFn;
  let server: any;

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
    server = createServer({ exec: mockExec, stateDir: TEST_DIR });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("send to a non-existent agent returns isError", async () => {
    const result = await callTool(server, "interact", {
      agent: "nonexistent",
      action: "send",
      text: "hello",
    });
    expect(result.isError).toBe(true);
  });

  it("send to an existing agent by agent_id", async () => {
    // Spawn an agent first
    const spawnResult = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "test",
    });
    const agentId = parseResult(spawnResult).agent_id;

    // Access engine directly to manipulate agent state for test.
    // In production, the reconciliation sweep would detect readiness.
    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    // Directly set state to ready in registry (bypassing state manager
    // disk transition to avoid surface reconciliation marking it error)
    registry.set(agentId, { ...agent, state: "ready" });

    const result = await callTool(server, "interact", {
      agent: agentId,
      action: "send",
      text: "fix gap F",
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
  });
});

describe("kill — scoped targets", () => {
  let mockExec: ExecFn;
  let server: any;

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
    server = createServer({ exec: mockExec, stateDir: TEST_DIR });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("kill single agent by id", async () => {
    const spawn = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "test",
    });
    const agentId = parseResult(spawn).agent_id;

    const result = await callTool(server, "kill", {
      target: agentId,
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.killed).toContain(agentId);
  });

  it("kill multiple agents by array", async () => {
    const spawn1 = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "test1",
    });
    const spawn2 = await callTool(server, "spawn_agent", {
      repo: "voicelayer",
      model: "haiku",
      cli: "claude",
      prompt: "test2",
    });
    const id1 = parseResult(spawn1).agent_id;
    const id2 = parseResult(spawn2).agent_id;

    const result = await callTool(server, "kill", {
      target: [id1, id2],
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.killed).toHaveLength(2);
  });

  it("kill 'all' stops all non-terminal agents", async () => {
    await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "test1",
    });
    await callTool(server, "spawn_agent", {
      repo: "voicelayer",
      model: "haiku",
      cli: "claude",
      prompt: "test2",
    });

    const result = await callTool(server, "kill", { target: "all" });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.killed.length).toBeGreaterThanOrEqual(2);
  });

  it("kill nonexistent agent returns error", async () => {
    const result = await callTool(server, "kill", {
      target: "nonexistent-agent-id",
    });
    const parsed = parseResult(result);
    expect(result.isError).toBe(true);
  });

  it("kill with force=true", async () => {
    const spawn = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      prompt: "test",
    });
    const agentId = parseResult(spawn).agent_id;

    const result = await callTool(server, "kill", {
      target: agentId,
      force: true,
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
  });
});
