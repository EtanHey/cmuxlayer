import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-paused-visibility-test");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux-paused-visibility-test.sock";
const GOAL_PAUSED_SCREEN = [
  "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer",
  "Goal paused (/goal resume)",
  "codex>",
].join("\n");
const IDLE_CODEX_SCREEN = [
  "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer",
  "codex>",
].join("\n");

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

class DualCodexSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly pausedSurface = "surface:paused";
  readonly idleSurface = "surface:idle";
  readonly sendCalls: string[] = [];
  readonly sendKeyCalls: string[] = [];
  readonly screens: Record<string, string> = {
    "surface:paused": GOAL_PAUSED_SCREEN,
    "surface:idle": IDLE_CODEX_SCREEN,
  };

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
          surface_count: 2,
          surface_refs: [this.pausedSurface, this.idleSurface],
          selected_surface_ref: this.pausedSurface,
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
          ref: this.pausedSurface,
          title: "cmuxlayerCodex-paused",
          type: "terminal",
          index: 0,
          selected: true,
        },
        {
          ref: this.idleSurface,
          title: "cmuxlayerCodex-idle",
          type: "terminal",
          index: 1,
          selected: false,
        },
      ],
    };
  }

  async send(surface: string, text: string) {
    if (!(surface in this.screens)) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    this.sendCalls.push(`${surface}:${text}`);
  }

  async sendKey(surface: string, key: string) {
    if (!(surface in this.screens)) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    this.sendKeyCalls.push(`${surface}:${key}`);
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    const text = this.screens[surface];
    if (text == null) {
      throw new Error(`Unknown surface: ${surface}`);
    }
    return {
      surface,
      text,
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }

  async renameTab() {}
}

function createPausedServer(client: DualCodexSurfaceClient) {
  return createServer({
    client,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    surfaceObserverOwnerIdProvider: () => TEST_OBSERVER_OWNER,
    surfaceObserverEpochProvider: () => `${TEST_OBSERVER_OWNER}@test`,
  });
}

function makeAgent(
  overrides: Partial<AgentRecord> &
    Pick<AgentRecord, "agent_id" | "surface_id">,
): AgentRecord {
  const now = "2026-08-18T13:40:00.000Z";
  return {
    workspace_id: "workspace:1",
    surface_observer_id: TEST_OBSERVER_OWNER,
    state: "idle",
    repo: "cmuxlayer",
    model: "gpt-5.5",
    cli: "codex",
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
    paused: false,
    paused_source: null,
    ...overrides,
  };
}

function registerAgent(server: any, record: AgentRecord): AgentRecord {
  const engine = server._registeredTools["interact"]._engine;
  const stateMgr = engine["stateMgr"] as StateManager;
  stateMgr.writeState(record);
  engine.getRegistry().set(record.agent_id, record);
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
  let client: DualCodexSurfaceClient;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    client = new DualCodexSurfaceClient();
    server = createPausedServer(client);
  });

  afterEach(() => {
    disposeServer(server);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("list_agents summary rows include paused with source", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "agent-paused",
        surface_id: "surface:paused",
        paused: true,
        paused_source: "inferred",
      }),
    );
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
    registerAgent(
      server,
      makeAgent({
        agent_id: "agent-paused",
        surface_id: "surface:paused",
      }),
    );
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
    registerAgent(
      server,
      makeAgent({
        agent_id: "agent-paused",
        surface_id: "surface:paused",
      }),
    );
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

  it("fan-out send_to live-checks pause chrome the same way as a single target", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "agent-paused",
        surface_id: "surface:paused",
      }),
    );
    registerAgent(
      server,
      makeAgent({
        agent_id: "agent-idle",
        surface_id: "surface:idle",
      }),
    );

    const result = await callTool(server, "send_to", {
      text: "please continue",
      press_enter: true,
      targeting: { agent_ids: ["agent-paused", "agent-idle"] },
    });
    const parsed = parseResult(result);
    const receipts = parsed.receipts as Array<Record<string, unknown>>;
    const pausedReceipt = receipts.find(
      (receipt) => receipt.agent_id === "agent-paused",
    );
    const idleReceipt = receipts.find(
      (receipt) => receipt.agent_id === "agent-idle",
    );

    expect(result.isError).not.toBe(true);
    expect(pausedReceipt).toMatchObject({
      agent_id: "agent-paused",
      delivered: false,
      delivery_state: "queued",
    });
    expect(String(pausedReceipt?.WARNING ?? "")).toMatch(/paused/i);
    expect(idleReceipt?.delivered).toBe(true);
    expect(client.sendCalls).toEqual(["surface:idle:please continue"]);
  });
});
