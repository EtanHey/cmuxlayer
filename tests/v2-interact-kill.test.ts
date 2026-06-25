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
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-v2");

function callTool(server: any, name: string, args: Record<string, unknown>) {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {} as any);
}

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function makeSpawnReadyExec(opts?: { closeKeepsSurface?: boolean }): ExecFn {
  let launchSent = false;
  let surfaceLive = true;
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("new-split") || args.includes("new-surface")) {
      surfaceLive = true;
    }
    if (args.includes("close-surface") && !opts?.closeKeepsSurface) {
      surfaceLive = false;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send")) {
      launchSent = true;
    }
    if (args.includes("list-workspaces")) {
      return { stdout: JSON.stringify({ workspaces: [] }), stderr: "" };
    }
    if (args.includes("list-panes")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          panes: surfaceLive
            ? [
                {
                  ref: "pane:1",
                  index: 0,
                  focused: true,
                  surface_count: 1,
                  surface_refs: ["surface:new"],
                  selected_surface_ref: "surface:new",
                },
              ]
            : [],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: surfaceLive
            ? [
                {
                  ref: "surface:new",
                  title: "agent-pane",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ]
            : [],
        }),
        stderr: "",
      };
    }
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:new",
          text: launchSent ? "What can I help you with?\n>" : "$ ",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    return {
      stdout: JSON.stringify({
        workspace: "ws:1",
        surface: "surface:new",
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

function makeSharedPaneExec(): ExecFn {
  const liveSurfaces = new Set(["surface:dying", "surface:other"]);
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("close-surface")) {
      const surface = String(args[args.indexOf("--surface") + 1] ?? "");
      liveSurfaces.delete(surface);
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send")) {
      return { stdout: "{}", stderr: "" };
    }
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
      const surfaces = [...liveSurfaces];
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes:
            surfaces.length > 0
              ? [
                  {
                    ref: "pane:shared",
                    index: 0,
                    focused: true,
                    surface_count: surfaces.length,
                    surface_refs: surfaces,
                    selected_surface_ref: surfaces[0],
                  },
                ]
              : [],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:shared",
          surfaces: [...liveSurfaces].map((ref, index) => ({
            ref,
            title: "agent-pane",
            type: "terminal",
            index,
            selected: index === 0,
          })),
        }),
        stderr: "",
      };
    }
    if (args.includes("read-screen")) {
      const surface = String(args[args.indexOf("--surface") + 1] ?? "");
      return {
        stdout: JSON.stringify({
          surface,
          text: "$ ",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    return { stdout: JSON.stringify({}), stderr: "" };
  });
}

function makeAgentRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "agent",
    surface_id: "surface:agent",
    workspace_id: "workspace:1",
    state: "working",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: null,
    task_summary: "test agent",
    pid: null,
    version: 1,
    created_at: "2026-04-19T20:00:00.000Z",
    updated_at: "2026-04-19T20:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    respawn_attempts: 0,
    user_killed: false,
    ...overrides,
  };
}

function createV2Server(exec: ExecFn) {
  return createServer({
    exec,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
  });
}

function finalizeAgentAlias(server: any, pendingId: string, finalId: string) {
  const engine = server._registeredTools["interact"]._engine;
  const renamed = engine.stateMgr.renameState(pendingId, finalId);
  engine.getRegistry().rename(pendingId, finalId, renamed);
  return engine;
}

describe("V2 tool registration", () => {
  it("registers interact and kill tools", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const server = createV2Server(mockExec);
    const tools = Object.keys((server as any)._registeredTools);
    expect(tools).toContain("interact");
    expect(tools).toContain("kill");
  });

  it("total tool count is 35 (20 low-level + 13 agent lifecycle + 2 v2)", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const server = createV2Server(mockExec);
    const count = Object.keys((server as any)._registeredTools).length;
    expect(count).toBe(35);
  });
});

describe("interact — runtime validation", () => {
  let mockExec: ExecFn;
  let server: any;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mockExec = makeSpawnReadyExec();
    server = createV2Server(mockExec);
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
    mockExec = makeSpawnReadyExec();
    server = createV2Server(mockExec);
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

  it("send resolves a finalized agent through its pending alias", async () => {
    const spawnResult = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
    });
    const pendingId = parseResult(spawnResult).agent_id;
    const finalId = "brainlayerClaude-session1";
    const engine = finalizeAgentAlias(server, pendingId, finalId);
    const registry = engine.getRegistry();
    const agent = registry.get(pendingId);
    registry.set(finalId, { ...agent, state: "ready" });

    const result = await callTool(server, "interact", {
      agent: pendingId,
      action: "send",
      text: "fix gap F",
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(pendingId);
  });
});

describe("kill — scoped targets", () => {
  let mockExec: ExecFn;
  let server: any;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mockExec = makeSpawnReadyExec();
    server = createV2Server(mockExec);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("kill single agent by id", async () => {
    const spawn = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
    });
    const agentId = parseResult(spawn).agent_id;

    const result = await callTool(server, "kill", {
      target: agentId,
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.killed).toContain(agentId);
  });

  it("kill closes a shared-pane target without collapsing another live agent", async () => {
    mockExec = makeSharedPaneExec();
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "agent-dying",
        surface_id: "surface:dying",
      }),
    );
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "agent-other",
        surface_id: "surface:other",
      }),
    );
    server = createV2Server(mockExec);
    await callTool(server, "list_agents", {});

    const result = await callTool(server, "kill", {
      target: "agent-dying",
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.killed).toContain("agent-dying");
    const closeCalls = (mockExec as any).mock.calls.filter(([, args]: any[]) =>
      args.includes("close-surface"),
    );
    expect(closeCalls).toHaveLength(1);
    const closeCall = closeCalls[0];
    expect(closeCall?.[1]).toEqual(
      expect.arrayContaining([
        "close-surface",
        "--surface",
        "surface:dying",
        "--workspace",
        "workspace:1",
      ]),
    );
    expect(closeCall?.[1]).not.toContain("--collapse-pane");
  });

  it("kill returns an error when the target remains interactable", async () => {
    mockExec = makeSpawnReadyExec({ closeKeepsSurface: true });
    server = createV2Server(mockExec);
    const spawn = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
    });
    const agentId = parseResult(spawn).agent_id;

    const result = await callTool(server, "kill", {
      target: agentId,
    });
    const parsed = parseResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/post-condition/i);
  });

  it("kill resolves a finalized agent through its pending alias", async () => {
    const spawn = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
    });
    const pendingId = parseResult(spawn).agent_id;
    finalizeAgentAlias(server, pendingId, "brainlayerClaude-session1");

    const result = await callTool(server, "kill", {
      target: pendingId,
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.killed).toContain(pendingId);
  });

  it("kill multiple agents by array", async () => {
    const spawn1 = await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
    });
    const spawn2 = await callTool(server, "spawn_agent", {
      repo: "voicelayer",
      model: "haiku",
      cli: "claude",
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
    });
    await callTool(server, "spawn_agent", {
      repo: "voicelayer",
      model: "haiku",
      cli: "claude",
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
    });
    const agentId = parseResult(spawn).agent_id;

    const result = await callTool(server, "kill", {
      target: agentId,
      force: true,
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
  });

  it("kill force removes surfaceless terminal registry ghosts", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "surfaceless-error-agent",
        surface_id: "surface:ghost",
        state: "error",
        cli_session_id: "019ec0e6-1111-2222-3333-444455556666",
        role: "orchestrator",
        error: "Surface surface:ghost disappeared",
        crash_recover: true,
      }),
    );
    await callTool(server, "list_agents", {});

    const result = await callTool(server, "kill", {
      target: "surfaceless-error-agent",
      force: true,
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.killed).toContain("surfaceless-error-agent");
    expect(stateMgr.readState("surfaceless-error-agent")).toBeNull();

    const listed = parseResult(await callTool(server, "list_agents", {}));
    expect(
      listed.agents.map((agent: { agent_id: string }) => agent.agent_id),
    ).not.toContain("surfaceless-error-agent");
  });
});
