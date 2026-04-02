/**
 * MCP Quality Tests — rename_tab persistence, registry cleanup, stale surface refs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";
import type { CmuxSurface } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "cmuxlayer-mcp-quality-test");

function makeRecord(overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "test-agent-1",
    surface_id: "surface:42",
    state: "working",
    repo: "testrepo",
    model: "opus",
    cli: "claude",
    cli_session_id: null,
    task_summary: "test task",
    pid: 12345,
    version: 1,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:01:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    ...overrides,
  };
}

function makeSurface(ref: string): CmuxSurface {
  return {
    ref,
    title: `Surface ${ref}`,
    type: "terminal",
    index: 0,
    selected: false,
  };
}

// ── Issue 1: rename_tab sends title as positional arg, not --title flag ──

describe("rename_tab persistence — socket V1 command format", () => {
  it("sends title as positional arg matching CLI format", async () => {
    // The CLI sends: cmux --json rename-tab --surface surface:1 "My Title"
    // The socket V1 must send: rename_tab --surface surface:1 "My Title"
    // NOT: rename_tab --surface surface:1 --title "My Title"

    const mockExec: ExecFn = vi
      .fn()
      .mockResolvedValue({ stdout: "{}", stderr: "" });
    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["rename_tab"];

    await tool.handler(
      { surface: "surface:1", title: "Agent Build" },
      {} as any,
    );

    // CLI path: the exec mock captures the args
    expect(mockExec).toHaveBeenCalledWith("cmux", [
      "--json",
      "rename-tab",
      "--surface",
      "surface:1",
      "Agent Build",
    ]);

    // The title should NOT appear as a --title flag
    const callArgs = (mockExec as any).mock.calls[0][1];
    expect(callArgs).not.toContain("--title");
  });
});

// ── Issue 2: close_surface should clean up agent registry ──

describe("close_surface cleans up agent registry", () => {
  let stateMgr: StateManager;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    stateMgr = new StateManager(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("marks agent as error when its surface is closed", async () => {
    // Set up agent on surface:42
    const record = makeRecord({
      agent_id: "agent-on-closed-surface",
      surface_id: "surface:42",
      state: "working",
    });
    stateMgr.writeState(record);

    // Surface provider initially returns the surface
    let liveSurfaces = [makeSurface("surface:42")];
    const surfaceProvider = async () => liveSurfaces;
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    await registry.reconstitute();

    // Verify agent is working
    const before = registry.get("agent-on-closed-surface");
    expect(before?.state).toBe("working");

    // Simulate surface being closed — remove from live surfaces
    liveSurfaces = [];

    // After reconcile, agent should be marked error
    await registry.reconcile();

    const after = registry.get("agent-on-closed-surface");
    expect(after?.state).toBe("error");
    expect(after?.error).toContain("surface:42");
  });

  it("purges terminal-state agents from registry after grace period", async () => {
    // Terminal-state agents (done/error) should not linger forever
    const doneRecord = makeRecord({
      agent_id: "done-agent",
      surface_id: "surface:99",
      state: "done",
    });
    const errorRecord = makeRecord({
      agent_id: "errored-agent",
      surface_id: "surface:100",
      state: "error",
      error: "surface disappeared",
    });
    stateMgr.writeState(doneRecord);
    stateMgr.writeState(errorRecord);

    const surfaceProvider = async () => [] as CmuxSurface[];
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    await registry.reconstitute();

    // Both should exist initially
    expect(registry.list()).toHaveLength(2);

    // After purge, terminal-state agents with no live surface should be removed
    const purged = await registry.purgeTerminal();

    expect(purged).toBe(2);
    expect(registry.list()).toHaveLength(0);
    expect(registry.get("done-agent")).toBeNull();
    expect(registry.get("errored-agent")).toBeNull();
  });

  it("does NOT purge terminal agents whose surface is still alive", async () => {
    const doneRecord = makeRecord({
      agent_id: "done-but-surface-alive",
      surface_id: "surface:42",
      state: "done",
    });
    stateMgr.writeState(doneRecord);

    const surfaceProvider = async () => [makeSurface("surface:42")];
    const registry = new AgentRegistry(stateMgr, surfaceProvider);
    await registry.reconstitute();

    const purged = await registry.purgeTerminal();

    expect(purged).toBe(0);
    // Should NOT be purged — surface is still alive (user might want to inspect)
    expect(registry.get("done-but-surface-alive")).not.toBeNull();
  });
});

// ── Issue 3: Stale surface refs return clear errors ──

describe("stale surface refs return clear errors", () => {
  it("returns surface_not_found error for operations on closed surfaces", async () => {
    // Mock exec that simulates a surface not existing
    const mockExec: ExecFn = vi.fn().mockImplementation((_cmd, args) => {
      // list-workspaces returns a workspace
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                id: "ws-1",
                ref: "workspace:1",
                title: "WS",
                index: 0,
                selected: true,
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      // list-panes returns empty
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [],
          }),
          stderr: "",
        };
      }
      // list-pane-surfaces returns no surfaces
      if (args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:1",
            surfaces: [],
          }),
          stderr: "",
        };
      }
      // Any operation on a stale surface should fail
      if (args.includes("read-screen")) {
        throw Object.assign(new Error("surface not found"), {
          code: 1,
          stderr: "surface not found: surface:dead",
        });
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["read_screen"];

    const result = await tool.handler(
      { surface: "surface:dead", lines: 50 },
      {} as any,
    );

    // Should return an error, not crash
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(false);
    // Error message should mention the surface ref clearly
    expect(parsed.error).toMatch(/surface/i);
  });

  it("send_input returns clear error for stale surface", async () => {
    const mockExec: ExecFn = vi.fn().mockImplementation((_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                id: "ws-1",
                ref: "workspace:1",
                title: "WS",
                index: 0,
                selected: true,
                pinned: false,
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
            surfaces: [],
          }),
          stderr: "",
        };
      }
      if (args.includes("send")) {
        throw Object.assign(new Error("surface not found"), {
          code: 1,
          stderr: "surface not found: surface:gone",
        });
      }
      return { stdout: "{}", stderr: "" };
    });

    const server = createServer({ exec: mockExec, skipAgentLifecycle: true });
    const tool = (server as any)._registeredTools["send_input"];

    const result = await tool.handler(
      { surface: "surface:gone", text: "hello" },
      {} as any,
    );

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/surface/i);
  });
});
