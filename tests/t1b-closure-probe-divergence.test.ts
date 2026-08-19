/**
 * Lane T1b (#488): ONE resolution per `list_agents` response.
 *
 * `closure` used to derive from the discovery-cache probe (null once the cache
 * is 2000ms old) while the SAME row's `state` derived from the live scan the
 * call had just taken. Cache warm, the two agreed; cache cold, one row said
 * `state: working` and `closure: artifact_missing` -- "route a reviewer NOW"
 * against an agent mid-turn -- and the field flapped as the cache aged.
 *
 * These tests drive the divergence directly: the probe is poisoned to its
 * COLD shape (registry fallback) while the response's own scan sees the live
 * screen. Closure must follow the scan, not the cold probe.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server.js";
import { resolveLiveAgentState } from "../src/live-agent-state.js";
import type { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";

const TEST_DIR = join(tmpdir(), "cmux-t1b-closure-probe-divergence-test");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux-t1b-closure-probe.sock";

const READY_CODEX_SCREEN = [
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

class LiveSurfaceClient {
  readonly workspace = "workspace:1";
  readonly pane = "pane:1";
  readonly readySurface = "surface:ready";
  readonly workingSurface = "surface:working";
  readonly screens: Record<string, string> = {
    "surface:ready": READY_CODEX_SCREEN,
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
          surface_refs: [this.readySurface, this.workingSurface],
          selected_surface_ref: this.readySurface,
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
          ref: this.readySurface,
          title: "cmuxlayerCodex-ready",
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

  async send() {}
  async sendKey() {}

  readScreenCalls = 0;

  async readScreen(surface: string, opts?: { lines?: number }) {
    const text = this.screens[surface];
    if (text == null) throw new Error(`Unknown surface: ${surface}`);
    this.readScreenCalls += 1;
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
  const now = "2026-08-19T13:40:00.000Z";
  return {
    workspace_id: "workspace:1",
    surface_observer_id: TEST_OBSERVER_OWNER,
    state: "idle",
    repo: "cmuxlayer",
    model: "gpt-5.5",
    cli: "codex",
    cli_session_id: null,
    task_summary: "t1b closure divergence",
    pid: null,
    version: 1,
    created_at: now,
    updated_at: now,
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    task_done_candidate_at: null,
    task_done_detected_at: null,
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

function testEngine(server: any) {
  return server._registeredTools["interact"]._engine;
}

function registerAgent(server: any, record: AgentRecord): AgentRecord {
  const engine = testEngine(server);
  const stateMgr = engine["stateMgr"] as StateManager;
  stateMgr.writeState(record);
  engine.getRegistry().set(record.agent_id, record);
  return record;
}

/** The cold-cache probe: `cachedScan()` returned null, so no screen evidence. */
function poisonProbeCold(server: any): void {
  testEngine(server).setLiveStateResolver((agent: AgentRecord) =>
    resolveLiveAgentState(agent, null),
  );
}

function rowFor(parsed: any, agentId: string): any {
  return parsed.agents.find((agent: any) => agent.agent_id === agentId);
}

function disposeServer(server: any) {
  const engine = server?._registeredTools?.interact?._engine;
  if (engine && typeof engine.dispose === "function") engine.dispose();
}

describe("T1b (#488) — closure and state resolve from ONE observation", () => {
  let server: any;
  let client: LiveSurfaceClient;

  beforeEach(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    client = new LiveSurfaceClient();
    server = createLiveServer(client);
  });

  afterEach(() => {
    disposeServer(server);
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("working screen + COLD closure probe reads pending, never artifact_missing", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-busy",
        surface_id: client.workingSurface,
        // #408's lie plus real prior done evidence: even THAT must not outrank
        // a screen this same response read as mid-turn.
        state: "done",
        task_done_detected_at: "2026-08-19T13:41:00.000Z",
        report_path: join(TEST_DIR, "reports", "busy.md"),
        done_marker: "DONE_T1B_BUSY",
      } as Partial<AgentRecord> as any),
    );

    // First call warms lifecycle start (which installs the real probe).
    await callTool(server, "list_agents", {});
    poisonProbeCold(server);

    const parsed = parseResult(await callTool(server, "list_agents", {}));
    const row = rowFor(parsed, "cmuxlayerCodex-t1b-busy");
    expect(row, JSON.stringify(parsed)).toBeTruthy();
    expect(row.state.value).toBe("working");
    expect(row.state.source).toBe("screen");
    expect(row.closure).toBe("pending");
  });

  it("ready screen + stale-done record with NO done evidence reads pending", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-flip",
        surface_id: client.readySurface,
        // The bare #408 record flip: `done` with nothing that ever observed a
        // done. `artifact_missing` from this alone is the false deadlock.
        state: "done",
        task_done_detected_at: null,
        report_path: join(TEST_DIR, "reports", "flip.md"),
        done_marker: "DONE_T1B_FLIP",
      } as Partial<AgentRecord> as any),
    );

    const parsed = parseResult(await callTool(server, "list_agents", {}));
    const row = rowFor(parsed, "cmuxlayerCodex-t1b-flip");
    expect(row, JSON.stringify(parsed)).toBeTruthy();
    expect(row.closure).toBe("pending");
    expect(row.closure).not.toBe("artifact_missing");
  });

  it("the deadlock signal SURVIVES: done evidence + missing report is artifact_missing", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-deadlocked",
        surface_id: client.readySurface,
        state: "done",
        // Positive done evidence: the sweep observed the done, then no report.
        task_done_detected_at: "2026-08-19T13:41:00.000Z",
        report_path: join(TEST_DIR, "reports", "never-written.md"),
        done_marker: "DONE_T1B_DEADLOCK",
      } as Partial<AgentRecord> as any),
    );

    const parsed = parseResult(await callTool(server, "list_agents", {}));
    const row = rowFor(parsed, "cmuxlayerCodex-t1b-deadlocked");
    expect(row, JSON.stringify(parsed)).toBeTruthy();
    expect(row.closure).toBe("artifact_missing");
  });

  it("costs ZERO extra screen reads: one scan per call, both fields off it (#425)", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-cost",
        surface_id: client.workingSurface,
        state: "done",
        task_done_detected_at: "2026-08-19T13:41:00.000Z",
        report_path: join(TEST_DIR, "reports", "cost.md"),
        done_marker: "DONE_T1B_COST",
      } as Partial<AgentRecord> as any),
    );

    await callTool(server, "list_agents", {});
    const before = client.readScreenCalls;
    const parsed = parseResult(await callTool(server, "list_agents", {}));
    const reads = client.readScreenCalls - before;

    // Two surfaces exist, so one scan is two reads. Threading that scan into
    // closure adds none: the alternative -- forcing fresh evidence on the
    // closure path -- would have added one read per row per call.
    expect(rowFor(parsed, "cmuxlayerCodex-t1b-cost")?.closure).toBe("pending");
    expect(reads).toBe(Object.keys(client.screens).length);
  });

  it("get_agent_state does not render artifact_missing beside a working screen", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-getstate",
        surface_id: client.workingSurface,
        // The residual shape the reviewer reproduced: a done that WAS once
        // observed, on an agent that is demonstrably working again.
        state: "done",
        task_done_detected_at: "2026-08-19T13:41:00.000Z",
        report_path: join(TEST_DIR, "reports", "getstate.md"),
        done_marker: "DONE_T1B_GETSTATE",
      } as Partial<AgentRecord> as any),
    );

    await callTool(server, "list_agents", {});
    poisonProbeCold(server);

    const parsed = parseResult(
      await callTool(server, "get_agent_state", {
        agent_id: "cmuxlayerCodex-t1b-getstate",
      }),
    );
    expect(parsed.health?.reconciled_state, JSON.stringify(parsed)).toBe(
      "working",
    );
    expect(parsed.harvestability.closure).toBe("pending");
  });

  it("wait_for does not render artifact_missing beside a working screen", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-waitfor",
        surface_id: client.workingSurface,
        state: "done",
        task_done_detected_at: "2026-08-19T13:41:00.000Z",
        report_path: join(TEST_DIR, "reports", "waitfor.md"),
        done_marker: "DONE_T1B_WAITFOR",
      } as Partial<AgentRecord> as any),
    );

    await callTool(server, "list_agents", {});
    poisonProbeCold(server);

    const parsed = parseResult(
      await callTool(server, "wait_for", {
        ids: ["cmuxlayerCodex-t1b-waitfor"],
        target_state: "done",
        timeout_ms: 2000,
      }),
    );
    const result = parsed.results[0];
    expect(result.health?.reconciled_state, JSON.stringify(parsed)).toBe(
      "working",
    );
    expect(result.closure).toBe("pending");
  });

  it("the deadlock signal survives on ALL THREE emitters, not just list_agents", async () => {
    // The false-negative the reviewer named: narrowing `artifact_missing` must
    // not silence the case it exists for. Done evidence, ready prompt, report
    // never written -- every path that emits closure must still say so.
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-realdeadlock",
        surface_id: client.readySurface,
        state: "done",
        task_done_detected_at: "2026-08-19T13:41:00.000Z",
        report_path: join(TEST_DIR, "reports", "real-deadlock.md"),
        done_marker: "DONE_T1B_REALDEADLOCK",
      } as Partial<AgentRecord> as any),
    );

    const listed = parseResult(await callTool(server, "list_agents", {}));
    const state = parseResult(
      await callTool(server, "get_agent_state", {
        agent_id: "cmuxlayerCodex-t1b-realdeadlock",
      }),
    );
    const waited = parseResult(
      await callTool(server, "wait_for", {
        ids: ["cmuxlayerCodex-t1b-realdeadlock"],
        target_state: "done",
        timeout_ms: 2000,
      }),
    );

    expect(
      rowFor(listed, "cmuxlayerCodex-t1b-realdeadlock")?.closure,
      JSON.stringify(listed),
    ).toBe("artifact_missing");
    expect(state.harvestability.closure).toBe("artifact_missing");
    expect(waited.results[0].closure).toBe("artifact_missing");
  });

  it("narrowing artifact_missing silences the CLAIM, not the evidence: health still flags it", async () => {
    // The reviewer's named false-negative: a worker that finished without a
    // recognized done marker looks identical to a #408 flip. Closure withholds
    // the deadlock CLAIM there -- but `closure_artifact_verified:false` and the
    // blocking `closure_without_artifact` health issue still render, so the
    // population is auditable rather than invisible. This is the post-merge
    // signal to watch: records at `done` with `closure:"pending"` and
    // `done_source:"none"`.
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-unobserved",
        surface_id: client.readySurface,
        state: "done",
        task_done_detected_at: null,
        report_path: join(TEST_DIR, "reports", "unobserved.md"),
        done_marker: "DONE_T1B_UNOBSERVED",
      } as Partial<AgentRecord> as any),
    );

    const parsed = parseResult(
      await callTool(server, "get_agent_state", {
        agent_id: "cmuxlayerCodex-t1b-unobserved",
      }),
    );
    expect(parsed.harvestability.closure, JSON.stringify(parsed)).toBe(
      "pending",
    );
    expect(parsed.harvestability.closure_artifact_verified).toBe(false);
    expect(parsed.harvestability.evidence_channel.done_source).toBe("none");
    expect(parsed.health.issue_codes).toContain("closure_without_artifact");
  });

  it("three consecutive calls for an unchanged agent do not flap the closure", async () => {
    registerAgent(
      server,
      makeAgent({
        agent_id: "cmuxlayerCodex-t1b-flap",
        surface_id: client.workingSurface,
        state: "done",
        task_done_detected_at: "2026-08-19T13:41:00.000Z",
        report_path: join(TEST_DIR, "reports", "flap.md"),
        done_marker: "DONE_T1B_FLAP",
      } as Partial<AgentRecord> as any),
    );

    // The reported flap (`db1ff995`, working→done→working in 17s) is the probe
    // cache expiring between calls while nothing about the agent changed.
    const first = parseResult(await callTool(server, "list_agents", {}));
    poisonProbeCold(server);
    const second = parseResult(await callTool(server, "list_agents", {}));
    const third = parseResult(await callTool(server, "list_agents", {}));

    const closures = [first, second, third].map(
      (parsed) => rowFor(parsed, "cmuxlayerCodex-t1b-flap")?.closure,
    );
    expect(closures, JSON.stringify(closures)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });
});
