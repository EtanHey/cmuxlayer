import { describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CmuxAppServerRuntime } from "../src/app-server-runtime.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-app-server-runtime-test");

function makeClient() {
  return {
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    newSplit: vi.fn().mockResolvedValue({
      workspace: "workspace:app",
      surface: "surface:1",
      pane: "pane:1",
      title: "",
      type: "terminal",
    }),
    newSurface: vi.fn(),
    selectWorkspace: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:1",
      text: "codex> ",
      lines: 1,
      scrollback_used: false,
    }),
    closeSurface: vi.fn(),
    log: vi.fn(),
  } as any;
}

function makeRecord(): AgentRecord {
  const now = new Date().toISOString();
  return {
    agent_id: "agent-1",
    surface_id: "surface:1",
    workspace_id: "workspace:app",
    state: "ready",
    repo: "brainlayer",
    model: "codex",
    cli: "codex",
    cli_session_id: null,
    task_summary: "test",
    pid: null,
    version: 1,
    created_at: now,
    updated_at: now,
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    boot_prompt_pending: false,
  };
}

describe("CmuxAppServerRuntime", () => {
  it("scopes bridge turns, interrupts, and screen reads to the agent workspace", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const client = makeClient();
    const runtime = new CmuxAppServerRuntime({ client, stateDir: TEST_DIR });
    const record = makeRecord();
    (runtime as any).stateMgr.writeState(record);
    (runtime as any).registry.set(record.agent_id, record);

    await runtime.sendTurn({ threadId: "agent-1", text: "hello" });
    await runtime.interruptTurn("agent-1");
    await runtime.readScreen("agent-1");

    expect(client.send).toHaveBeenCalledWith("surface:1", "hello", {
      workspace: "workspace:app",
    });
    expect(client.sendKey).toHaveBeenCalledWith("surface:1", "return", {
      workspace: "workspace:app",
    });
    expect(client.sendKey).toHaveBeenCalledWith("surface:1", "c-c", {
      workspace: "workspace:app",
    });
    expect(client.readScreen).toHaveBeenCalledWith("surface:1", {
      workspace: "workspace:app",
      lines: 40,
      scrollback: true,
    });

    runtime.dispose();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});
