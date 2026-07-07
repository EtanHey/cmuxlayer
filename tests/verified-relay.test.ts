import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-verified-relay-test");

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

/**
 * A Claude surface whose terminal is FROZEN: keystrokes are echoed into the
 * input box but Enter never submits — the text stays pending forever. This is
 * the "ok:true on a frozen terminal" failure mode the verified-relay primitive
 * must catch: a relay that cannot confirm the input landed must NOT report ok.
 */
class FrozenClaudeSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly surface = "surface:agent";
  readonly title = "brainlayerClaude";
  readonly sendCalls: string[] = [];
  readonly sendKeyCalls: string[] = [];
  private pendingText = "";

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
    if (surface !== this.surface)
      throw new Error(`Unknown surface: ${surface}`);
    this.sendCalls.push(text);
    this.pendingText += text;
  }

  async sendKey(surface: string, key: string) {
    if (surface !== this.surface)
      throw new Error(`Unknown surface: ${surface}`);
    this.sendKeyCalls.push(key);
    // FROZEN: Enter never submits — pendingText is never cleared.
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    if (surface !== this.surface)
      throw new Error(`Unknown surface: ${surface}`);
    const tail = this.pendingText.slice(-160);
    return {
      surface,
      text: `Claude Code\n> ${tail}\nCLAUDE_COUNTER:1\n`,
      lines: opts?.lines ?? 30,
      scrollback_used: false,
    };
  }

  async renameTab() {}
}

function createRelayServer(client: any) {
  return createServer({
    client,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
  });
}

function registerAgent(
  server: any,
  overrides?: Partial<AgentRecord>,
): AgentRecord {
  const engine = server._registeredTools["interact"]._engine;
  const stateMgr = engine["stateMgr"];
  const registry = engine.getRegistry();

  const now = "2026-05-29T12:00:00Z";
  const record: AgentRecord = {
    agent_id: "agent-1",
    surface_id: "surface:agent",
    workspace_id: "workspace:1",
    state: "ready",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: null,
    task_summary: "verified relay test",
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
    ...overrides,
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

describe("verified relay", () => {
  let server: any;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    server = null;
  });

  afterEach(() => {
    disposeServer(server);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("send_to a frozen terminal returns an error instead of ok:true (short relay)", async () => {
    const client = new FrozenClaudeSurfaceClient();
    server = createRelayServer(client);
    registerAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "ping", // short relay — the common agent-to-agent case
      press_enter: true,
    });
    const parsed = parseResult(result);

    // A relay that cannot confirm the input landed must NOT report success.
    expect(result.isError).toBe(true);
    expect(parsed.ok).not.toBe(true);
    expect(
      client.sendKeyCalls.filter((key) => key === "return").length,
    ).toBe(1);
  }, 10_000);
});
