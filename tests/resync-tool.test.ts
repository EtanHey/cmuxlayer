import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { StateManager } from "../src/state-manager.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-resync-tool");

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function makeDiscoveryExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args) => {
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
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: 2,
              surface_refs: ["surface:1", "surface:2"],
              selected_surface_ref: "surface:1",
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:1",
              title: "brainlayerClaude",
              type: "terminal",
              index: 0,
              selected: true,
            },
            {
              ref: "surface:2",
              title: "notes",
              type: "terminal",
              index: 1,
              selected: false,
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("read-screen")) {
      const surface = args[args.indexOf("--surface") + 1];
      if (surface === "surface:1") {
        return {
          stdout: JSON.stringify({
            surface,
            text: `
✻ Working…
  Reading files
🤖 Sonnet 4.6 | 💰 $0.50 | ⏱️  41s
`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }

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

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

function makeIdleDiscoveryExec(): ExecFn {
  const base = makeDiscoveryExec();
  return vi.fn().mockImplementation(async (cmd, args) => {
    if (args.includes("read-screen")) {
      const surface = args[args.indexOf("--surface") + 1];
      if (surface === "surface:1") {
        return {
          stdout: JSON.stringify({
            surface,
            text: `
✻ Working…
  Reading src/server.ts

No idle agents to reassign right now. Everything is either done or Codex is handling the last task.

Token usage: total=356,835
🤖 Sonnet 4.6
CLAUDE_COUNTER: 92
`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
    }

    return base(cmd, args);
  });
}

function makeReadErrorExec(): ExecFn {
  const base = makeDiscoveryExec();
  return vi.fn().mockImplementation(async (cmd, args) => {
    if (args.includes("read-screen")) {
      throw new Error("cmux read failed");
    }
    return base(cmd, args);
  });
}

function makeShellPromptExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd, args) => {
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
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: ["surface:999"],
              selected_surface_ref: "surface:999",
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [
            {
              ref: "surface:999",
              title: "shell",
              type: "terminal",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      };
    }

    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:999",
          text: "$ ",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    return {
      stdout: JSON.stringify({}),
      stderr: "",
    };
  });
}

describe("resync_agents tool", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("registers resync_agents alongside the lifecycle tools", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const server = createServer({
      exec: mockExec,
      stateDir: TEST_DIR,
    });

    expect((server as any)._registeredTools["resync_agents"]).toBeDefined();
  });

  it("list_agents discovers live agents from surfaces even with an empty registry", async () => {
    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools["list_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0].state).toBe("working");
  });

  it("my_agents returns discovered root agents even when no parent_agent_id is provided", async () => {
    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools["my_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.count).toBe(1);
    expect(parsed.parent_agent_id).toBeNull();
    expect(parsed.agents[0].state).toBe("working");
  });

  it("resync_agents force-refreshes discovery and reports added agents", async () => {
    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const tool = (server as any)._registeredTools["resync_agents"];
    const result = await tool.handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.added).toHaveLength(1);
    expect(parsed.count).toBe(1);
  });

  it("list_agents persists live state updates for existing auto-discovered agents", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState({
      agent_id: "auto-claude-surface-1",
      surface_id: "surface:1",
      workspace_id: null,
      state: "working",
      repo: "brainlayer",
      model: "Sonnet 4.6",
      cli: "claude",
      cli_session_id: null,
      task_summary: "(auto-discovered)",
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
    });

    const server = createServer({
      exec: makeIdleDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const listResult = await (server as any)._registeredTools["list_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(listResult);

    expect(parsed.count).toBe(1);
    expect(parsed.agents[0].state).toBe("idle");
    expect(stateMgr.readState("auto-claude-surface-1")?.state).toBe("idle");
  });

  it("resync_agents keeps existing auto agents when discovery hits read-screen errors", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState({
      agent_id: "auto-claude-surface-1",
      surface_id: "surface:1",
      workspace_id: null,
      state: "working",
      repo: "brainlayer",
      model: "Sonnet 4.6",
      cli: "claude",
      cli_session_id: null,
      task_summary: "(auto-discovered)",
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
    });

    const server = createServer({
      exec: makeReadErrorExec(),
      stateDir: TEST_DIR,
    });

    const resyncResult = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(resyncResult);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).not.toContain("auto-claude-surface-1");
    expect(stateMgr.readState("auto-claude-surface-1")?.state).toBe("working");

    const listResult = await (server as any)._registeredTools["list_agents"].handler(
      {},
      {} as any,
    );
    const listed = parseResult(listResult);
    expect(listed.count).toBe(1);
    expect(listed.agents[0].agent_id).toBe("auto-claude-surface-1");
  });

  it("resync_agents evicts ghost booting agents whose surface no longer exists", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState({
      agent_id: "ghost-agent",
      surface_id: "surface:999",
      workspace_id: "workspace:1",
      state: "booting",
      repo: "skill-creator",
      model: "sonnet",
      cli: "claude",
      cli_session_id: null,
      task_summary: "stuck boot",
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
    });

    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const tool = (server as any)._registeredTools["resync_agents"];
    const result = await tool.handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).toContain("ghost-agent");
    expect(parsed.count).toBe(1);
  });

  it("resync_agents evicts booting ghosts when the surface is alive but no agent is detected", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState({
      agent_id: "booting-ghost",
      surface_id: "surface:999",
      workspace_id: "workspace:1",
      state: "booting",
      repo: "skill-creator",
      model: "sonnet",
      cli: "claude",
      cli_session_id: null,
      task_summary: "failed launcher",
      pid: null,
      version: 1,
      created_at: "2026-04-19T19:00:00.000Z",
      updated_at: "2026-04-19T19:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    });

    const server = createServer({
      exec: makeShellPromptExec(),
      stateDir: TEST_DIR,
    });

    const tool = (server as any)._registeredTools["resync_agents"];
    const result = await tool.handler({}, {} as any);
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).toContain("booting-ghost");
    expect(parsed.count).toBe(0);
  });

  it("resync_agents reports agent-less terminal surfaces as orphaned instead of clean", async () => {
    const server = createServer({
      exec: makeShellPromptExec(),
      stateDir: TEST_DIR,
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.added).toEqual([]);
    expect(parsed.diff.evicted).toEqual([]);
    expect(parsed.diff.mismatches).toEqual([]);
    expect(parsed.diff.orphaned).toEqual(["surface:999"]);
    expect(parsed.count).toBe(0);
  });

  it("resync_agents evicts registry-only phantom agents instead of failing", async () => {
    const server = createServer({
      exec: makeDiscoveryExec(),
      stateDir: TEST_DIR,
    });

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    registry.set("gpt-5.4-mcplayer-1776645230-hmep", {
      agent_id: "gpt-5.4-mcplayer-1776645230-hmep",
      surface_id: "surface:phantom",
      workspace_id: "workspace:1",
      state: "ready",
      repo: "mcplayer",
      model: "gpt-5.4",
      cli: "codex",
      cli_session_id: null,
      task_summary: "phantom",
      pid: null,
      version: 1,
      created_at: "2026-04-21T00:00:00.000Z",
      updated_at: "2026-04-21T00:00:00.000Z",
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "unknown",
      max_cost_per_agent: null,
      crash_recover: false,
      respawn_attempts: 0,
      user_killed: false,
    });

    const result = await (server as any)._registeredTools["resync_agents"].handler(
      {},
      {} as any,
    );
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.diff.evicted).toContain("gpt-5.4-mcplayer-1776645230-hmep");
    expect(parsed.count).toBe(1);
  });
});
