import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-stale-surface-ref-test");

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
 * The registry believes the agent lives on `surface:stale`, but that surface no
 * longer exists — only `surface:live` is currently open (a crash/respawn moved
 * the agent, or the pane was recycled). A relay by agent_id must NOT blindly
 * send keystrokes to the dead surface; it must re-resolve against live surfaces
 * and, if the ref can't be confirmed, error clearly instead of misdelivering.
 */
class DriftedSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly liveSurface = "surface:live";
  readonly staleSurface = "surface:stale";
  // Every surface a send/sendKey was attempted against, so the test can assert
  // nothing was delivered to the stale ref.
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
          surface_refs: [this.liveSurface],
          selected_surface_ref: this.liveSurface,
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
          ref: this.liveSurface,
          title: "otherClaude",
          type: "terminal",
          index: 0,
          selected: true,
        },
      ],
    };
  }

  async send(surface: string, _text: string) {
    // A zombie/recycled surface would silently accept input — record it so the
    // test can prove the relay refused to deliver to the stale ref.
    this.sendTargets.push(surface);
  }

  async sendKey(surface: string, _key: string) {
    this.sendKeyTargets.push(surface);
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    return {
      surface,
      text: "Claude Code\n> \nCLAUDE_COUNTER:1\n",
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

function registerStaleAgent(server: any): AgentRecord {
  const engine = server._registeredTools["interact"]._engine;
  const stateMgr = engine["stateMgr"];
  const registry = engine.getRegistry();

  const now = "2026-05-29T12:00:00Z";
  const record: AgentRecord = {
    agent_id: "agent-1",
    surface_id: "surface:stale", // registry ref is stale — surface no longer exists
    workspace_id: "workspace:1",
    state: "ready",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: null,
    task_summary: "stale surface ref test",
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

describe("stale surface ref", () => {
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

  it("send_to refuses to deliver to a surface that is no longer live", async () => {
    const client = new DriftedSurfaceClient();
    server = createRelayServer(client);
    registerStaleAgent(server);

    const result = await callTool(server, "send_to", {
      agent_id: "agent-1",
      text: "are you there?",
    });
    const parsed = parseResult(result);

    // The relay must error rather than silently delivering to the dead ref.
    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/stale|no longer live|resync|surface/i);
    // Crucially: nothing was sent to the stale surface (no misdelivery).
    expect(client.sendTargets).not.toContain(client.staleSurface);
    expect(client.sendKeyTargets).not.toContain(client.staleSurface);
  });
});
