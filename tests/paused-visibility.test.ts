import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-paused-visibility-test");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux-paused-visibility-test.sock";

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function callTool(
  server: any,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = server._registeredTools[name];
  if (!tool) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tool.handler(args, {} as any);
}

class PausedClaudeSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly surface = "surface:paused";
  readonly title = "cmuxlayerCursor";
  readonly sendCalls: string[] = [];
  readonly sendKeyCalls: string[] = [];
  screenText = `Claude Code
>
Paused
press enter to resume
🤖 Opus 5 | 💰 $1.25
CLAUDE_COUNTER: 1
`;

  async listWorkspaces() {
    return {
      workspaces: [
        {
          ref: this.workspace,
          title: "Main",
          index: 0,
          selected: true,
          pinned: false,
        },
      ],
    };
  }

  async listPanes() {
    return {
      workspace_ref: this.workspace,
      window_ref: "window:1",
      panes: [
        {
          ref: this.pane,
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: [this.surface],
          selected_surface_ref: this.surface,
        },
      ],
    };
  }

  async listPaneSurfaces() {
    return {
      workspace_ref: this.workspace,
      window_ref: "window:1",
      pane_ref: this.pane,
      surfaces: [
        {
          ref: this.surface,
          title: this.title,
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    };
  }

  async send(surface: string, text: string) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    this.sendCalls.push(text);
  }

  async sendKey(surface: string, key: string) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    this.sendKeyCalls.push(key);
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (surface !== this.surface) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    return {
      surface,
      text: this.screenText,
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }

  async renameTab() {}
}

function createPausedServer(client: PausedClaudeSurfaceClient) {
  return createServer({
    client,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    surfaceObserverOwnerIdProvider: () => TEST_OBSERVER_OWNER,
    surfaceObserverEpochProvider: () => `${TEST_OBSERVER_OWNER}@test`,
  });
}

function registerPausedAgent(server: any): AgentRecord {
  const engine = server._registeredTools["interact"]._engine;
  const stateMgr = engine["stateMgr"] as StateManager;
  const registry = engine.getRegistry();
  const now = "2026-08-18T13:40:00.000Z";
  const record: AgentRecord = {
    agent_id: "agent-paused",
    surface_id: "surface:paused",
    surface_observer_id: TEST_OBSERVER_OWNER,
    workspace_id: "workspace:1",
    state: "idle",
    repo: "cmuxlayer",
    model: "opus",
    cli: "claude",
    cli_session_id: null,
    task_summary: "paused visibility",
    pid: null,
    version: 1,
    created_at: now,
    updated_at: now,
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    respawn_attempts: 0,
    user_killed: false,
    paused: true,
    paused_source: "inferred",
  };
  stateMgr.writeState(record);
  registry.set(record.agent_id, record);
  return record;
}

function disposeServer(server: any) {
  const engine = server?._registeredTools?.interact?._engine;
  if (engine && typeof engine.dispose === "function") {
    engine.dispose();
  }
}

describe("paused pane visibility", () => {
  let server: any;
  let client: PausedClaudeSurfaceClient;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    client = new PausedClaudeSurfaceClient();
    server = createPausedServer(client);
    registerPausedAgent(server);
  });

  afterEach(() => {
    disposeServer(server);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("list_agents summary rows include paused with source", async () => {
    const result = await callTool(server, "list_agents", {});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.agents[0]).toMatchObject({
      agent_id: "agent-paused",
      paused: {
        value: true,
        source: "inferred",
      },
    });
  });

  it("read_screen parsed output includes paused with inferred source", async () => {
    const result = await callTool(server, "read_screen", {
      surface: "surface:paused",
      parsed_only: true,
    });
    const parsed = parseResult(result);
    expect(parsed.parsed).toMatchObject({
      paused: true,
      paused_source: "inferred",
    });
  });

  it("send_to a paused target queues with an unmissable warning and never submitted", async () => {
    const result = await callTool(server, "send_to", {
      agent_id: "agent-paused",
      text: "please continue",
      press_enter: true,
    });
    const parsed = parseResult(result);

    expect(result.isError).not.toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.delivered).toBe(false);
    expect(parsed.delivery_state).toBe("queued");
    expect(parsed.WARNING).toMatch(/paused/i);
    expect(parsed.WARNING).toMatch(/do not relay as sent/i);
    expect(client.sendCalls).toEqual([]);
    expect(client.sendKeyCalls).toEqual([]);
  });
});
