/**
 * Worker docking when the socket's surface.list omits pane_ref. The real cmux
 * socket leaves pane_ref out; cmux-socket-client.ts backfills it from the
 * requested pane. This pins that a worker spawn docks into the existing
 * workers pane (pane:2) instead of opening a fresh split. Spawn placement
 * docks by column, so this holds even without the backfill -- the backfill's
 * own guard is the list_surfaces test in server.test.ts. (Ported from the
 * retired new_split tool, CX-3 S8a-1.)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { AgentRecord } from "../src/agent-types.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";
import { engineForTests } from "../src/server.js";

const TEST_DIR = join(tmpdir(), "cmux-dock-pane-ref-test");

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function callTool(
  server: any,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {} as any);
}

/**
 * Fake client that reproduces the REAL cmux socket format:
 * - listPaneSurfaces does NOT return pane_ref (like the real socket)
 * - two panes: commanders LEFT (pane:1), workers RIGHT (pane:2)
 * - right pane has 2 Codex workers (no non-role surfaces)
 */
class RealCmuxFormatClient {
  readonly sendCalls: string[] = [];
  readonly newSurfacePanes: string[] = [];
  readonly newSplitCalls: string[] = [];

  async listWorkspaces() {
    return {
      workspaces: [
        {
          ref: "workspace:1",
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
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: false,
          surface_count: 2,
          surface_refs: ["surface:orc", "surface:lead"],
        },
        {
          ref: "pane:2",
          index: 1,
          focused: true,
          surface_count: 2,
          surface_refs: ["surface:w1", "surface:w2"],
        },
      ],
    };
  }

  async listPaneSurfaces(opts?: { workspace?: string; pane?: string }) {
    const pane = opts?.pane ?? "";
    // Real cmux socket format: NO pane_ref field in the response
    return {
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      // pane_ref intentionally ABSENT — this is what the real socket sends
      surfaces:
        pane === "pane:2"
          ? [
              {
                ref: "surface:w1",
                title: "brainlayerCodex-w1",
                type: "terminal",
                index: 0,
                selected: true,
              },
              {
                ref: "surface:w2",
                title: "brainlayerCodex-w2",
                type: "terminal",
                index: 1,
                selected: false,
              },
            ]
          : [
              {
                ref: "surface:orc",
                title: "orcClaude",
                type: "terminal",
                index: 0,
                selected: true,
              },
              {
                ref: "surface:lead",
                title: "brainlayerClaude-LEAD",
                type: "terminal",
                index: 1,
                selected: false,
              },
            ],
    } as any; // pane_ref absent = real socket format
  }

  async newSurface(opts: { pane: string }) {
    this.newSurfacePanes.push(opts.pane);
    return {
      workspace: "workspace:1",
      surface: "surface:new",
      pane: opts.pane,
      title: "cmuxlayerCodex-test",
      type: "terminal" as const,
    };
  }

  async newSplit(direction: string) {
    this.newSplitCalls.push(direction);
    return {
      workspace: "workspace:1",
      surface: "surface:stray",
      pane: "pane:3",
      title: "",
      type: "terminal" as const,
    };
  }

  async send(surface: string, text: string) {
    this.sendCalls.push(`${surface}:${text}`);
  }
  async sendKey() {}
  async readScreen() {
    return { surface: "", text: "", lines: 20, scrollback_used: false };
  }
  async renameTab() {}
  async identify() {
    return null;
  }
  async closeSurface() {}
  async listWorkspaceSurfaces() {
    return { workspaces: [], surfaces: [] };
  }
}

function createDockServer(client: RealCmuxFormatClient) {
  return createServer(
    withTestSurfaceObserver({
      client: client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
    }),
  );
}

function registerWorkers(server: any) {
  const engine = engineForTests(server);
  const stateMgr = engine["stateMgr"];
  const registry = engine.getRegistry();
  const now = "2026-05-30T12:00:00Z";

  const make = (id: string, surfaceId: string): AgentRecord => ({
    agent_id: id,
    surface_id: surfaceId,
    workspace_id: "workspace:1",
    state: "working",
    repo: "brainlayer",
    model: "gpt-5.3",
    cli: "codex",
    cli_session_id: null,
    task_summary: "dock test worker",
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
  });

  for (const [id, surfaceId] of [
    ["w1", "surface:w1"],
    ["w2", "surface:w2"],
  ]) {
    const r = make(id, surfaceId);
    stateMgr.writeState(r);
    registry.set(r.agent_id, r);
  }
}

function disposeServer(server: any) {
  const engine = engineForTests(server);
  if (engine && typeof engine.dispose === "function") engine.dispose();
}

describe("dock pane-ref matching", () => {
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

  it("spawn_agent role=worker docks into the workers pane when listPaneSurfaces omits pane_ref", async () => {
    const client = new RealCmuxFormatClient();
    server = createDockServer(client);
    registerWorkers(server);

    await callTool(server, "spawn_agent", {
      repo: "brainlayer",
      cli: "codex",
      role: "worker",
      workspace: "workspace:1",
      boot_prompt_timeout_ms: 100,
    });

    // Must dock into the existing workers pane (pane:2), not create a new split.
    expect(client.newSurfacePanes).toEqual(["pane:2"]);
    expect(client.newSplitCalls).toEqual([]);
  });
});
