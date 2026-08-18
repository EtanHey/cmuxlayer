/**
 * Lane F1 regressions: consumers must resolve caller identity, delivery gating
 * and P11 closure from the LIVE-derived state, never from the registry record.
 *
 * The registry marks live agents `done` within minutes (#408). This lane does
 * not fix that; it makes the consumers immune to it. Every test here seeds a
 * record whose `state` is a lie and asserts the consumer believes the screen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import type { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-f1-live-state-truth-test");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux-f1-live-state-truth.sock";

const IDLE_CODEX_SCREEN = [
  "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer",
  "codex>",
].join("\n");
const WORKING_CODEX_SCREEN = [
  "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer",
  "• Working (12s • esc to interrupt)",
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
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {} as any);
}

/** Two live codex surfaces: one at a prompt, one mid-turn. */
class LiveSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly idleSurface = "surface:idle";
  readonly workingSurface = "surface:working";
  readonly sendCalls: string[] = [];
  readonly sendKeyCalls: string[] = [];
  readonly screens: Record<string, string> = {
    "surface:idle": IDLE_CODEX_SCREEN,
    "surface:working": WORKING_CODEX_SCREEN,
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
          surface_refs: [this.idleSurface, this.workingSurface],
          selected_surface_ref: this.idleSurface,
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
          ref: this.idleSurface,
          title: "cmuxlayerCodex-idle",
          type: "terminal",
          index: 0,
          selected: true,
        },
        {
          ref: this.workingSurface,
          title: "cmuxlayerCodex-working",
          type: "terminal",
          index: 1,
          selected: false,
        },
      ],
    };
  }

  async send(surface: string, text: string) {
    if (!(surface in this.screens)) throw new Error(`Unknown surface: ${surface}`);
    this.sendCalls.push(`${surface}:${text}`);
  }

  async sendKey(surface: string, key: string) {
    if (!(surface in this.screens)) throw new Error(`Unknown surface: ${surface}`);
    this.sendKeyCalls.push(`${surface}:${key}`);
  }

  async readScreen(surface: string, opts?: { lines?: number }) {
    const text = this.screens[surface];
    if (text == null) throw new Error(`Unknown surface: ${surface}`);
    return { surface, text, lines: opts?.lines ?? 30, scrollback_used: false };
  }

  async renameTab() {}
}

function createLiveServer(client: LiveSurfaceClient) {
  return createServer({
    client: client as any,
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
    task_summary: "f1 live state",
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
  } as AgentRecord;
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
  if (engine && typeof engine.dispose === "function") engine.dispose();
}

describe("F1 — live state, not the stale registry record", () => {
  let server: any;
  let client: LiveSurfaceClient;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    client = new LiveSurfaceClient();
    server = createLiveServer(client);
  });

  afterEach(() => {
    disposeServer(server);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("send_to a screen-idle agent whose record says done returns a NONTERMINAL receipt", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-stale",
        surface_id: client.idleSurface,
        // The #408 lie: registry says the task is over, the prompt is live.
        state: "done",
        task_done_detected_at: "2026-08-18T13:41:00.000Z",
      } as Partial<AgentRecord> as any),
    );

    const result = await callTool(server, "send_to", {
      mode: "agent",
      agent_id: "cmuxlayerCodex-stale",
      text: "status?",
    });
    const parsed = parseResult(result);

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed.terminal, JSON.stringify(parsed)).toBe(false);
    expect(parsed.delivery).not.toBe("failed");
    expect(parsed.delivery_state).not.toBe("failed");
    // The registry lie survives as provenance, not as the verdict.
    expect(parsed.registry_state).toBe("done");
    expect(parsed.health?.reconciled_state).toBe("ready");
  });

  it("send_to still refuses when the live screen agrees the surface is dead", async () => {
    client.screens["surface:idle"] = "$ ";
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-dead",
        surface_id: client.idleSurface,
        state: "done",
      }),
    );

    const result = await callTool(server, "send_to", {
      mode: "agent",
      agent_id: "cmuxlayerCodex-dead",
      text: "status?",
    });
    const parsed = parseResult(result);
    expect(parsed.ok === false || parsed.delivery === "failed").toBe(true);
  });

  it("send_to to a mid-turn agent never resolves as a terminal failure", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-midturn",
        surface_id: client.workingSurface,
        // Stale-done record on an agent that is demonstrably mid-turn. The gate
        // refuses -- correctly, it is busy -- but that refusal is RETRYABLE, so
        // flattening it into `failed`/`terminal:true` would be the same receipt
        // lie in a different costume. The engine will drain it when the turn ends.
        state: "done",
      }),
    );

    const result = await callTool(server, "send_to", {
      mode: "agent",
      agent_id: "cmuxlayerCodex-midturn",
      text: "status?",
    });
    const parsed = parseResult(result);

    expect(parsed.terminal, JSON.stringify(parsed)).not.toBe(true);
    expect(parsed.delivery_state ?? parsed.delivery).not.toBe("failed");
    expect(parsed.accepted ?? parsed.ok).toBe(true);
  });

  it("P11 closure reads pending, not artifact_missing, on a screen-working agent", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-busy",
        surface_id: client.workingSurface,
        // Registry lie again: done with no artifact would read artifact_missing,
        // which P11's own table means "route a reviewer NOW".
        state: "done",
        report_path: join(TEST_DIR, "reports", "cmuxlayerCodex-busy.md"),
        done_marker: "### @cmuxlayerCodex-busy DONE",
      } as Partial<AgentRecord> as any),
    );

    const result = await callTool(server, "list_agents", {});
    const parsed = parseResult(result);
    const row = parsed.agents.find(
      (agent: any) => agent.agent_id === "cmuxlayerCodex-busy",
    );

    expect(row, JSON.stringify(parsed)).toBeTruthy();
    expect(row.state.value).toBe("working");
    expect(row.state.source).toBe("screen");
    expect(row.closure).toBe("pending");
  });

  it("P11 closure still reports artifact_missing when the screen confirms done", async () => {
    client.screens["surface:idle"] = [
      "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer",
      "codex>",
    ].join("\n");
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-finished",
        surface_id: client.idleSurface,
        state: "done",
        report_path: join(TEST_DIR, "reports", "missing.md"),
        done_marker: "### @cmuxlayerCodex-finished DONE",
      } as Partial<AgentRecord> as any),
    );

    const result = await callTool(server, "list_agents", { detail: "full" });
    const parsed = parseResult(result);
    const row = parsed.agents.find(
      (agent: any) => agent.agent_id === "cmuxlayerCodex-finished",
    );
    expect(row, JSON.stringify(parsed)).toBeTruthy();
    // A finished worker sits at a ready prompt too, so `ready` must NOT
    // overturn a recorded done: the deadlock signal has to survive.
    expect(row.closure).toBe("artifact_missing");
  });
});
