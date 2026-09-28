/**
 * A force-stopped agent keeps a tombstone record that default list_agents
 * hides and a terminal-state or full-detail query still returns. Ported from
 * v2-interact-kill.test.ts, whose kill tool was retired in CX-3 S8a-2; the
 * stop now goes through the public close_surface scope="agent".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { withFakeRightSplitTopology } from "./helpers/fake-right-split-topology.js";
import { StateManager } from "../src/state-manager.js";
import { UNBOUND_SURFACE_REF, type AgentRecord } from "../src/agent-types.js";
import { alive, armTailer, waitGone } from "./helpers/inbox-tailer.js";

const TEST_DIR = join(tmpdir(), "cmux-agents-test-v2");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux-v2-test.sock";

function callTool(server: any, name: string, args: Record<string, unknown>) {
  const tool = server._registeredTools[name];
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(
    name === "spawn_agent" ? { workspace: "workspace:1", ...args } : args,
    {} as any,
  );
}

function parseResult(result: any): any {
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

function makeSpawnReadyExec(opts?: { closeKeepsSurface?: boolean }): ExecFn {
  let launchSent = false;
  let agentMessageSubmitted = false;
  let surfaceLive = true;
  const listedSurface = () =>
    surfaceLive
      ? {
          paneRef: "pane:1",
          surfaceRef: "surface:new",
          title: "agent-pane",
        }
      : {
          paneRef: "pane:witness",
          surfaceRef: "surface:post-close-witness",
          title: "witness-pane",
        };
  return withFakeRightSplitTopology(vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-windows")) {
      return {
        stdout: JSON.stringify({
          windows: [{ ref: "window:1", workspace_count: 1 }],
        }),
        stderr: "",
      };
    }
    if (args.includes("new-split") || args.includes("new-surface")) {
      surfaceLive = true;
    }
    if (args.includes("close-surface") && !opts?.closeKeepsSurface) {
      surfaceLive = false;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send")) {
      const text = String(args.at(-1) ?? "");
      if (text.includes("Claude") || text.includes("Codex") || text.includes("Cursor")) {
        launchSent = true;
      } else {
        agentMessageSubmitted = true;
      }
    }
    if (args.includes("list-workspaces")) {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "ws:1",
              title: "Main",
              index: 0,
              selected: true,
              pinned: false,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-panes")) {
      const listed = listedSurface();
      return {
        stdout: JSON.stringify({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          panes: [
            {
              ref: listed.paneRef,
              index: 0,
              focused: true,
              surface_count: 1,
              surface_refs: [listed.surfaceRef],
              selected_surface_ref: listed.surfaceRef,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      const listed = listedSurface();
      return {
        stdout: JSON.stringify({
          workspace_ref: "ws:1",
          window_ref: "window:1",
          pane_ref: listed.paneRef,
          surfaces: [
            {
              ref: listed.surfaceRef,
              title: listed.title,
              type: "terminal",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("read-screen")) {
      return {
        stdout: JSON.stringify({
          surface: "surface:new",
          text: agentMessageSubmitted
            ? "Claude Code\n✻ Working\n"
            : launchSent
              ? "Claude Code\nWhat can I help you with?\n>"
              : "$ ",
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    return {
      stdout: JSON.stringify({
        workspace: "ws:1",
        surface: "surface:new",
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  }));
}

function makeAgentRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    agent_id: "agent",
    surface_id: "surface:agent",
    surface_observer_id: TEST_OBSERVER_OWNER,
    workspace_id: "workspace:1",
    state: "working",
    repo: "brainlayer",
    model: "sonnet",
    cli: "claude",
    cli_session_id: null,
    task_summary: "test agent",
    pid: null,
    version: 1,
    created_at: "2026-04-19T20:00:00.000Z",
    updated_at: "2026-04-19T20:00:00.000Z",
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
}

function createV2Server(exec: ExecFn) {
  return createServer({
    exec,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    surfaceObserverOwnerIdProvider: () => TEST_OBSERVER_OWNER,
    surfaceObserverEpochProvider: () => `${TEST_OBSERVER_OWNER}@test`,
  });
}

describe("force-stopped agent tombstone", () => {
  let mockExec: ExecFn;
  let server: any;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mockExec = makeSpawnReadyExec();
    server = createV2Server(mockExec);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("close_surface scope=agent force retains a tombstone hidden from default list_agents", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "recoverable-crash-agent",
        surface_id: "surface:crashed",
        state: "error",
        cli_session_id: "019ec0e6-aaaa-bbbb-cccc-ddddeeeeffff",
        role: "worker",
        error: "Surface surface:crashed disappeared",
        crash_recover: false,
        user_killed: false,
      }),
    );
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "surfaceless-done-agent",
        surface_id: "surface:ghost",
        state: "done",
        cli_session_id: "019ec0e6-1111-2222-3333-444455556666",
        role: "orchestrator",
        error: null,
        crash_recover: false,
      }),
    );
    await callTool(server, "list_agents", {});

    const result = await callTool(server, "close_surface", {
      scope: "agent",
      agent_id: "surfaceless-done-agent",
      force: true,
    });
    const parsed = parseResult(result);

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed.agent_stopped).toBe(true);
    expect(stateMgr.readState("surfaceless-done-agent")).toMatchObject({
      agent_id: "surfaceless-done-agent",
      cli_session_id: "019ec0e6-1111-2222-3333-444455556666",
      state: "done",
      user_killed: true,
      pid: null,
    });

    const listed = parseResult(await callTool(server, "list_agents", {}));
    expect(
      listed.agents.map((agent: { agent_id: string }) => agent.agent_id),
    ).not.toContain("surfaceless-done-agent");
    expect(
      listed.agents.map((agent: { agent_id: string }) => agent.agent_id),
    ).toContain("recoverable-crash-agent");
    const filtered = parseResult(
      await callTool(server, "list_agents", { state: "done" }),
    );
    expect(
      filtered.agents.map((agent: { agent_id: string }) => agent.agent_id),
    ).toContain("surfaceless-done-agent");
    const detailed = parseResult(
      await callTool(server, "list_agents", { detail: "full" }),
    );
    expect(
      detailed.agents.map((agent: { agent_id: string }) => agent.agent_id),
    ).toContain("surfaceless-done-agent");
    const explicitlyRequested = parseResult(
      await callTool(server, "list_agents", {
        agent_ids: ["surfaceless-done-agent"],
      }),
    );
    expect(
      explicitlyRequested.agents.map(
        (agent: { agent_id: string }) => agent.agent_id,
      ),
    ).toContain("surfaceless-done-agent");
  });
  it("hides an unbound resumable done row from the default summary but keeps it addressable (#926)", async () => {
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({
        agent_id: "unbound-done-lead",
        surface_id: UNBOUND_SURFACE_REF,
        surface_uuid: null,
        state: "done",
        cli_session_id: "019ec0e6-9260-2222-3333-444455556666",
        role: "worker",
        updated_at: new Date().toISOString(),
      }),
    );
    const ids = (parsed: { agents: Array<{ agent_id: string }> }) =>
      parsed.agents.map((agent) => agent.agent_id);

    const listed = parseResult(await callTool(server, "list_agents", {}));
    expect(ids(listed)).not.toContain("unbound-done-lead");
    const filtered = parseResult(
      await callTool(server, "list_agents", { state: "done" }),
    );
    expect(ids(filtered)).toContain("unbound-done-lead");
    const explicitlyRequested = parseResult(
      await callTool(server, "list_agents", {
        agent_ids: ["unbound-done-lead"],
      }),
    );
    expect(ids(explicitlyRequested)).toContain("unbound-done-lead");
    // Listing ran the surfaceless eviction; the row is still on disk.
    expect(stateMgr.readState("unbound-done-lead")).toMatchObject({
      state: "done",
      surface_id: UNBOUND_SURFACE_REF,
    });
  });
});

describe("#911 close_surface scope=surface reaps the closed agent's inbox tailer", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("stops the tailer through the PID+token reaper once the pane is confirmed closed", async () => {
    // 2026-09-27: the skill-creator eval panes and orchestratorCodex-c92208aa
    // were closed with scope=surface force=true; none reached the reaper.
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const inboxBaseDir = mkdtempSync(join(tmpdir(), "cmux-911-close-"));
    cleanups.push(() => rmSync(inboxBaseDir, { recursive: true, force: true }));
    const server = createServer({
      exec: makeSpawnReadyExec(),
      stateDir: TEST_DIR,
      inboxBaseDir,
      disableSpawnPreflight: true,
      surfaceObserverOwnerIdProvider: () => TEST_OBSERVER_OWNER,
      surfaceObserverEpochProvider: () => `${TEST_OBSERVER_OWNER}@test`,
    });
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeAgentRecord({ agent_id: "evalWorker-c911", surface_id: "surface:new" }),
    );
    const tailer = armTailer("evalWorker-c911", { baseDir: inboxBaseDir }, cleanups);

    const parsed = parseResult(
      await callTool(server, "close_surface", { surface: "surface:new", force: true }),
    );

    expect(parsed.surface_closed, JSON.stringify(parsed)).toBe(true);
    expect(parsed.inbox_tails).toEqual({ "evalWorker-c911": "reaped" });
    expect(await waitGone(tailer.wrapper)).toBe(true);
    expect(await waitGone(tailer.tail)).toBe(true);
    expect(alive(tailer.tail)).toBe(false);
  });
});
