import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-recycled-surface-identity-test");

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
 * The agent was recorded as a Claude agent on surface:1. That surface still
 * exists (so the #101 liveness guard passes), but it has been RECYCLED — it now
 * hosts a *different* agent (a Codex). A relay by the original agent_id must NOT
 * deliver keystrokes to the new occupant; it must detect the identity mismatch
 * and refuse.
 */
class RecycledSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly surface = "surface:1";
  readonly sendTargets: string[] = [];
  readonly sendKeyTargets: string[] = [];

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
          // Title still reads like the old Claude agent, but the live screen
          // (below) is a Codex — identity must be judged by the live content.
          ref: this.surface,
          title: "brainlayerCodex",
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    };
  }

  async send(surface: string, _text: string) {
    this.sendTargets.push(surface);
  }

  async sendKey(surface: string, _key: string) {
    this.sendKeyTargets.push(surface);
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    // surface:1 now hosts a Codex agent (the pane was recycled).
    return {
      surface,
      text: "gpt-5.3-codex · 80% left\n\ncodex>\n",
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

function registerClaudeAgentOnSurface1(server: any): AgentRecord {
  const engine = server._registeredTools["interact"]._engine;
  const stateMgr = engine["stateMgr"];
  const registry = engine.getRegistry();

  const now = "2026-05-29T12:00:00Z";
  const record: AgentRecord = {
    agent_id: "agent-1",
    surface_id: "surface:1",
    workspace_id: "workspace:1",
    state: "ready",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude", // recorded as Claude — but surface:1 now hosts a Codex
    cli_session_id: null,
    task_summary: "recycled surface identity test",
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

describe("recycled surface identity", () => {
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

  it("send_to refuses when the surface was recycled to a different-CLI agent", async () => {
    const client = new RecycledSurfaceClient();
    server = createRelayServer(client);
    registerClaudeAgentOnSurface1(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "still you?",
    });
    const parsed = parseResult(result);

    // The relay must refuse rather than deliver to the new occupant.
    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/recycl|different|no longer|identity|codex/i);
    // Nothing was sent to the recycled surface.
    expect(client.sendTargets).not.toContain(client.surface);
    expect(client.sendKeyTargets).not.toContain(client.surface);
  });
});
