import net from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CmuxPersistentSocket } from "../src/cmux-persistent-socket.js";
import type { ExecFn } from "../src/cmux-client.js";
import {
  runReaper,
  selectReapablePids,
  type ProcessInfo,
} from "../src/mcp-reaper.js";
import { createServer, type CreateServerOptions } from "../src/server.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord, AgentState, CliType } from "../src/agent-types.js";
import {
  closeToolServer,
  getEngine,
  getTool,
  parseToolResult,
} from "./helpers/mcp-tool-harness.js";

type StatusCall = {
  key: string;
  value: string;
  args: string[];
};

const tempDirs: string[] = [];
const servers: net.Server[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cmuxlayer-p10-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agent_id: "codex-cmuxlayer-p10",
    surface_id: "surface:p10",
    workspace_id: "workspace:1",
    state: "ready",
    repo: "cmuxlayer",
    model: "gpt-5.5",
    cli: "codex",
    cli_session_id: null,
    cli_session_path: null,
    task_summary: "Phase 10 replay fixture",
    pid: null,
    version: 1,
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    respawn_attempts: 0,
    user_killed: false,
    ...overrides,
  };
}

function surfaceArg(args: string[]): string {
  const index = args.indexOf("--surface");
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

function paneArg(args: string[]): string {
  const index = args.indexOf("--pane");
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

function makeLifecycleExec(surfaceRefs: string[], opts?: {
  emptyPanes?: boolean;
  screenBySurface?: Map<string, string>;
}): {
  exec: ExecFn;
  statusCalls: StatusCall[];
  closeCalls: string[];
} {
  const liveSurfaces = new Set(surfaceRefs);
  const statusCalls: StatusCall[] = [];
  const closeCalls: string[] = [];
  const screenBySurface = opts?.screenBySurface ?? new Map<string, string>();
  const exec: ExecFn = async (_cmd, args) => {
    const command = args[1];
    if (command === "list-workspaces") {
      return {
        stdout: JSON.stringify({
          workspaces: [
            {
              ref: "workspace:1",
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
    if (command === "list-panes") {
      if (opts?.emptyPanes) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [],
          }),
          stderr: "",
        };
      }
      const liveWorkerSurfaces = [...liveSurfaces].filter(
        (surface) => surface !== "surface:lead",
      );
      const panes = [
        {
          ref: "pane:lead",
          index: 0,
          focused: liveWorkerSurfaces.length === 0,
          surface_count: liveSurfaces.has("surface:lead") ? 1 : 0,
          surface_refs: liveSurfaces.has("surface:lead")
            ? ["surface:lead"]
            : [],
          selected_surface_ref: liveSurfaces.has("surface:lead")
            ? "surface:lead"
            : undefined,
          pixel_frame: { x: 0, y: 0, width: 400, height: 900 },
        },
        ...(liveWorkerSurfaces.length > 0
          ? [
              {
                ref: "pane:workers",
                index: 1,
                focused: true,
                surface_count: liveWorkerSurfaces.length,
                surface_refs: liveWorkerSurfaces,
                selected_surface_ref: liveWorkerSurfaces[0],
                pixel_frame: { x: 400, y: 0, width: 800, height: 900 },
              },
            ]
          : []),
      ];
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes,
        }),
        stderr: "",
      };
    }
    if (command === "list-pane-surfaces") {
      const pane = paneArg(args);
      const surfaces =
        pane === "pane:lead"
          ? liveSurfaces.has("surface:lead")
            ? [
                {
                  ref: "surface:lead",
                  title: "cmuxlayerClaude",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ]
            : []
          : [...liveSurfaces]
              .filter((surface) => surface !== "surface:lead")
              .map((surface, index) => ({
                ref: surface,
                title: `cmuxlayerCodex ${index}`,
                type: "terminal",
                index,
                selected: index === 0,
              }));
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: pane,
          surfaces,
        }),
        stderr: "",
      };
    }
    if (command === "read-screen") {
      const surface = surfaceArg(args);
      return {
        stdout: JSON.stringify({
          surface_ref: surface,
          text:
            screenBySurface.get(surface) ??
            "OpenAI Codex\nModel: gpt-5.5\n\ncodex> ",
          lines: 20,
        }),
        stderr: "",
      };
    }
    if (command === "identify") {
      return {
        stdout: JSON.stringify({
          caller: { workspace_ref: "workspace:1" },
          focused: { workspace_ref: "workspace:1" },
        }),
        stderr: "",
      };
    }
    if (command === "set-status") {
      statusCalls.push({
        key: args[2] ?? "",
        value: args[3] ?? "",
        args: [...args],
      });
      return { stdout: "{}", stderr: "" };
    }
    if (command === "clear-status") {
      return { stdout: "{}", stderr: "" };
    }
    if (command === "close-surface") {
      const surface = surfaceArg(args);
      closeCalls.push(surface);
      liveSurfaces.delete(surface);
      return { stdout: "{}", stderr: "" };
    }
    if (command === "log" || command === "notify") {
      return { stdout: "{}", stderr: "" };
    }
    return { stdout: "{}", stderr: "" };
  };
  return { exec, statusCalls, closeCalls };
}

async function closeServer(server: unknown): Promise<void> {
  await closeToolServer(server);
}

function startEngineServer(
  exec: ExecFn,
  stateDir: string,
  overrides: Omit<Partial<CreateServerOptions>, "exec" | "stateDir"> = {},
) {
  return createServer({
    exec,
    stateDir,
    controlHealthIntervalMs: 0,
    disableSpawnPreflight: true,
    sessionIdentityResolver: () => null,
    ...overrides,
  });
}

describe("Phase 10 painpoint e2e replay", () => {
  it("sidebar-scale sweeps many agents with bounded, diffed status emissions", async () => {
    const dir = tempDir("sidebar-scale");
    const stateMgr = new StateManager(dir);
    const agentCount = 25;
    const agentIds = Array.from({ length: agentCount }, (_entry, index) => {
      const agentId = `codex-cmuxlayer-sidebar-${index}`;
      stateMgr.writeState(
        makeRecord({
          agent_id: agentId,
          surface_id: `surface:worker-${index}`,
          state: "ready",
          task_summary: `sidebar scale worker ${index}`,
          cli_session_id: `session-${index}`,
        }),
      );
      return agentId;
    });
    const { exec, statusCalls } = makeLifecycleExec([
      "surface:lead",
      ...agentIds.map((_agentId, index) => `surface:worker-${index}`),
    ]);
    const server = startEngineServer(exec, dir);

    try {
      const engine = getEngine(server);
      await engine.getRegistry().reconstitute();
      statusCalls.length = 0;

      await engine.runSweep();

      expect(statusCalls).toHaveLength(agentCount);
      expect(statusCalls.map((call) => call.key).sort()).toEqual(
        [...agentIds].sort(),
      );
      expect(
        statusCalls.every(
          (call) =>
            call.value.includes("role=worker") &&
            call.value.includes("state=ready"),
        ),
      ).toBe(true);

      statusCalls.length = 0;
      await engine.runSweep();

      expect(statusCalls).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("MCP reaper matches only orphan MCP node servers and writes before/after audit evidence", async () => {
    const processes: ProcessInfo[] = [
      {
        pid: 701,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etanheyman/Gits/cmuxlayer/dist/index.js",
      },
      {
        pid: 702,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etanheyman/Gits/acme-mcp/scripts/dev.js",
      },
      {
        pid: 703,
        ppid: 2,
        etimes: 1200,
        command: "node /Users/etanheyman/Gits/brainlayer-mcp/dist/index.js",
      },
      {
        pid: 704,
        ppid: 1,
        etimes: 60,
        command: "node /Users/etanheyman/Gits/voicelayer-mcp/dist/index.js",
      },
      {
        pid: 705,
        ppid: 1,
        etimes: 1200,
        command: "node /Users/etanheyman/Gits/context7-mcp/dist/index.js",
        launchdManaged: true,
      },
    ];
    expect(selectReapablePids(processes, { minAgeSeconds: 600 })).toEqual([
      701,
    ]);

    const lines: string[] = [];
    const outputs: string[] = [];
    const readProcessTable = vi
      .fn<() => Promise<ProcessInfo[]>>()
      .mockResolvedValueOnce(processes)
      .mockResolvedValueOnce(processes);

    await runReaper(
      {
        dryRun: true,
        graceSeconds: 0,
        knownServerNames: [],
        logFile: join(tempDir("reaper"), "audit.log"),
        minAgeSeconds: 600,
      },
      {
        appendAuditLine: async (line) => {
          lines.push(line);
        },
        readProcessTable,
        readRamEvidence: () => ({
          processRssBytes: 11,
          systemFreeBytes: 22,
          systemTotalBytes: 33,
        }),
        writeStdout: (line) => {
          outputs.push(line);
        },
      },
    );

    expect(outputs).toContainEqual(
      expect.stringContaining("DRY_RUN would terminate pid=701"),
    );
    expect(lines).toContainEqual(
      expect.stringContaining(
        "AUDIT phase=before dry_run=true total_processes=5 reapable_processes=1 reapable_pids=701",
      ),
    );
    expect(lines).toContainEqual(
      expect.stringContaining(
        "AUDIT phase=after dry_run=true total_processes=5 reapable_processes=1 reapable_pids=701",
      ),
    );
  });

  it("PR-loop worker retention blocks unmerged reports and allows verified merged artifacts", async () => {
    const dir = tempDir("pr-loop-retention");
    const reportsDir = join(dir, "reports");
    mkdirSync(reportsDir, { recursive: true });
    const goalPath = join(dir, "GOAL-pr-worker.md");
    const reportPath = join(reportsDir, "pr-worker-report.md");
    const doneMarker = "DONE_PR_LOOP_WORKER";
    writeFileSync(
      goalPath,
      [
        "# Goal",
        "",
        `Write report path: \`${reportPath}\`.`,
        "Open a PR for the implementation and run `/pr-loop`.",
        `End with \`${doneMarker}\`.`,
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      reportPath,
      [
        "# Worker Report",
        "PR: https://github.com/EtanHey/cmuxlayer/pull/999",
        "PR status: open",
        doneMarker,
      ].join("\n"),
      "utf8",
    );
    const now = new Date("2026-07-05T12:00:00.000Z");
    const later = new Date("2026-07-05T12:01:00.000Z");
    utimesSync(goalPath, now, now);
    utimesSync(reportPath, later, later);

    const stateMgr = new StateManager(dir);
    stateMgr.writeState(
      makeRecord({
        agent_id: "codex-pr-loop-worker",
        surface_id: "surface:pr-loop-worker",
        state: "done",
        goal_file: goalPath,
        task_summary: "PR deliverable: true",
        task_done_detected_at: later.toISOString(),
      }),
    );
    const { exec } = makeLifecycleExec([
      "surface:lead",
      "surface:pr-loop-worker",
    ]);
    const server = startEngineServer(exec, dir);

    try {
      const engine = getEngine(server);
      await engine.getRegistry().reconstitute();
      const getState = getTool(server, "get_agent_state");
      const first = parseToolResult<{
        harvestability: {
          closeable: boolean;
          closure_artifact_verified: boolean;
          pr_loop_required: boolean;
          pr_loop_satisfied: boolean;
        };
        health: { issue_codes: string[] };
      }>(
        await getState.handler({ agent_id: "codex-pr-loop-worker" }, {}),
      );

      expect(first.harvestability).toMatchObject({
        closeable: false,
        closure_artifact_verified: true,
        pr_loop_required: true,
        pr_loop_satisfied: false,
      });
      expect(first.health.issue_codes).toContain("pr_loop_incomplete");

      writeFileSync(
        reportPath,
        [
          "# Worker Report",
          "PR: https://github.com/EtanHey/cmuxlayer/pull/999",
          "PR status: merged",
          "Reviewed complete.",
          doneMarker,
        ].join("\n"),
        "utf8",
      );
      utimesSync(reportPath, later, later);

      const second = parseToolResult<{
        harvestability: {
          closeable: boolean;
          closure_artifact_verified: boolean;
          pr_loop_required: boolean;
          pr_loop_satisfied: boolean;
        };
        health: { issue_codes: string[] };
      }>(
        await getState.handler({ agent_id: "codex-pr-loop-worker" }, {}),
      );

      expect(second.harvestability).toMatchObject({
        closeable: true,
        closure_artifact_verified: true,
        pr_loop_required: true,
        pr_loop_satisfied: true,
      });
      expect(second.health.issue_codes).not.toContain("pr_loop_incomplete");
    } finally {
      await closeServer(server);
    }
  });

  it("candidate 14: public resync/list keeps terminal workers on empty surface enumeration", async () => {
    const dir = tempDir("candidate-14");
    new StateManager(dir).writeState(
      makeRecord({
        agent_id: "terminal-worker-empty-scan",
        surface_id: "surface:maybe-live",
        state: "done",
      }),
    );
    const { exec } = makeLifecycleExec([], { emptyPanes: true });
    const server = startEngineServer(exec, dir);

    try {
      const engine = getEngine(server);
      await engine.getRegistry().reconstitute();
      const resync = parseToolResult<{ ok: boolean; count: number }>(
        await getTool(server, "resync_agents").handler({}, {}),
      );
      const listed = parseToolResult<{
        agents: Array<{ agent_id: string; state: AgentState }>;
      }>(await getTool(server, "list_agents").handler({}, {}));

      expect(resync.ok).toBe(true);
      expect(resync.count).toBe(1);
      expect(listed.agents).toEqual([
        expect.objectContaining({
          agent_id: "terminal-worker-empty-scan",
          state: "done",
        }),
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("candidate 15: public wait_for(done) requires output evidence, not registry done alone", async () => {
    vi.useFakeTimers();
    const dir = tempDir("candidate-15");
    new StateManager(dir).writeState(
      makeRecord({
        agent_id: "worker-registry-done",
        surface_id: "surface:worker-registry-done",
        state: "done",
      }),
    );
    const { exec } = makeLifecycleExec(["surface:worker-registry-done"], {
      screenBySurface: new Map([
        [
          "surface:worker-registry-done",
          "gpt-5.5\nWorking (1m 02s - esc to interrupt)",
        ],
      ]),
    });
    const server = startEngineServer(exec, dir);

    try {
      const engine = getEngine(server);
      await engine.getRegistry().reconstitute();
      const pending = getTool(server, "wait_for").handler(
        {
          agent_id: "worker-registry-done",
          target_state: "done",
          timeout_ms: 2_500,
        },
        {},
      );
      await vi.advanceTimersByTimeAsync(3_000);
      const result = parseToolResult<{
        matched: boolean;
        source: string;
        state: AgentState;
      }>(await pending);

      expect(result).toMatchObject({
        matched: false,
        source: "timeout",
        state: "done",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("candidate 16: public get_agent_state reports closure artifacts as unverified without a final DONE artifact", async () => {
    const dir = tempDir("candidate-16");
    const goalPath = join(dir, "GOAL-worker.md");
    const reportPath = join(dir, "reports", "worker-report.md");
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeFileSync(
      goalPath,
      [`Report path: \`${reportPath}\`.`, "End with `DONE_WORKER_REPORT`."].join(
        "\n",
      ),
      "utf8",
    );
    writeFileSync(reportPath, "Status: stopped before final marker\n", "utf8");
    const now = new Date("2026-07-05T12:00:00.000Z");
    const later = new Date("2026-07-05T12:01:00.000Z");
    utimesSync(goalPath, now, now);
    utimesSync(reportPath, later, later);
    new StateManager(dir).writeState(
      makeRecord({
        agent_id: "worker-without-artifact",
        surface_id: "surface:worker-without-artifact",
        state: "done",
        goal_file: goalPath,
        task_done_detected_at: later.toISOString(),
      }),
    );
    const { exec } = makeLifecycleExec([
      "surface:worker-without-artifact",
    ]);
    const server = startEngineServer(exec, dir);

    try {
      const engine = getEngine(server);
      await engine.getRegistry().reconstitute();
      const state = parseToolResult<{
        harvestability: { closure_artifact_verified: boolean; closeable: boolean };
        health: { issue_codes: string[] };
      }>(
        await getTool(server, "get_agent_state").handler(
          { agent_id: "worker-without-artifact" },
          {},
        ),
      );

      expect(state.harvestability).toMatchObject({
        closure_artifact_verified: false,
        closeable: false,
      });
      expect(state.health.issue_codes).toContain("closure_without_artifact");
    } finally {
      await closeServer(server);
    }
  });

  it("candidate 19: public stop_agent force treats kill(0) EPERM as unknown/gone after SIGKILL", async () => {
    const dir = tempDir("candidate-19");
    new StateManager(dir).writeState(
      makeRecord({
        agent_id: "agent-force-unknown",
        surface_id: "surface:force-unknown",
        state: "working",
        pid: 23_456,
      }),
    );
    const { exec, closeCalls } = makeLifecycleExec([
      "surface:lead",
      "surface:force-unknown",
    ]);
    const killCalls: Array<[number, NodeJS.Signals | 0]> = [];
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
        killCalls.push([pid, signal ?? 0]);
        if (signal === 0) {
          throw Object.assign(new Error("operation not permitted"), {
            code: "EPERM",
          });
        }
        return true;
      }) as typeof process.kill);
    const server = startEngineServer(exec, dir);

    try {
      const engine = getEngine(server);
      await engine.getRegistry().reconstitute();
      const stopped = parseToolResult<{ state: AgentState }>(
        await getTool(server, "stop_agent").handler(
          { agent_id: "agent-force-unknown", force: true },
          {},
        ),
      );

      expect(stopped.state).toBe("done");
      expect(killCalls).toContainEqual([23_456, "SIGKILL"]);
      expect(killCalls).toContainEqual([23_456, 0]);
      expect(closeCalls).toEqual(["surface:force-unknown"]);
      expect(new StateManager(dir).readState("agent-force-unknown")).toBeNull();
    } finally {
      killSpy.mockRestore();
      await closeServer(server);
    }
  });

  it("candidate 21: public background send_input records submit verification evidence after completion", async () => {
    vi.useFakeTimers();
    const dir = tempDir("candidate-21");
    new StateManager(dir).writeState(
      makeRecord({
        agent_id: "agent-background-submit",
        surface_id: "surface:agent-bg",
        state: "idle",
        cli: "claude",
        model: "Opus 4.8",
      }),
    );
    const exec: ExecFn = async (_cmd, args) => {
      const command = args[1];
      if (command === "read-screen") {
        return {
          stdout: JSON.stringify({
            surface_ref: "surface:agent-bg",
            text: "Claude Code\n> \nCLAUDE_COUNTER:1\n",
            lines: 3,
          }),
          stderr: "",
        };
      }
      if (command === "list-workspaces") {
        return { stdout: JSON.stringify({ workspaces: [] }), stderr: "" };
      }
      return { stdout: "{}", stderr: "" };
    };
    const server = startEngineServer(exec, dir, { skipAgentLifecycle: true });

    try {
      const send = getTool(server, "send_input");
      const read = getTool(server, "read_screen");
      const accepted = parseToolResult<{
        status: string;
        submit_verified: boolean | null;
        delivery_id: string;
      }>(
        await send.handler(
          {
            surface: "surface:agent-bg",
            text: "ping",
            background: true,
            press_enter: true,
          },
          {},
        ),
      );

      expect(accepted).toMatchObject({
        status: "delivering",
        submit_verified: null,
      });

      await vi.advanceTimersByTimeAsync(3_000);
      const after = parseToolResult<{
        delivery: {
          delivery_id: string;
          status: string;
          submit_verified: boolean | null;
          retry_count: number;
        };
      }>(
        await read.handler(
          { surface: "surface:agent-bg", parsed_only: true },
          {},
        ),
      );

      expect(after.delivery).toMatchObject({
        delivery_id: accepted.delivery_id,
        status: "delivered",
        submit_verified: null,
        retry_count: 1,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("candidate 23: malformed socket frames reject pending requests instead of completing the wrong operation", async () => {
    const root = tempDir("candidate-23");
    const socketPath = join(root, "cmux.sock");
    const received: string[] = [];
    const server = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim()) {
            received.push(line);
            if (received.length === 1) {
              conn.write('{"id":\n');
            } else {
              conn.write("OK\n");
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    servers.push(server);

    const socket = new CmuxPersistentSocket({
      socketPath,
      timeoutMs: 500,
    });
    try {
      await expect(socket.sendLine("set_status first")).rejects.toMatchObject({
        code: "protocol_error",
      });
      await expect(socket.sendLine("set_status second")).resolves.toBe("OK");
      expect(received).toEqual(["set_status first", "set_status second"]);
    } finally {
      socket.disconnect();
    }
  });
});
