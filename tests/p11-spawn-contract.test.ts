/**
 * P11 / U10 — the PRODUCER half of the coordination contract.
 *
 * The consumer half (assessHarvestability) shipped long ago, but nothing ever
 * issued it a contract: spawn_agent never set goal_file, so every spawned
 * worker read `terminal_contract_missing` forever, and leads invented report
 * paths in prose that a regex heuristic then tried to guess back out. These
 * tests pin the fix: the engine authors the contract ONCE, returns it in the
 * receipt, persists it, and tells the worker the same two strings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, createServerContext } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { withTestSurfaceObserver } from "./helpers/test-surface-observer.js";
import { runWithCallerContext } from "../src/caller-context.js";
import {
  BOOT_INJECTION_CHUNK_THRESHOLD,
  bootContractPointer,
  coordinationContractPath,
  coordinationFooter,
  coordinationFooterBytes,
  issueCoordinationContract,
} from "../src/coordination-paths.js";
import { recommendedMonitorCommand } from "../src/inbox.js";
import { armWatch, readWatchRegistry } from "../src/watch-spec.js";
import type { AgentRecord } from "../src/agent-types.js";
import { StateManager } from "../src/state-manager.js";

const STATE_DIR = join(tmpdir(), "cmux-agents-test-p11-spawn");

interface TestSurface {
  id?: string;
  ref: string;
  title: string;
  text: string;
}

function makeExec(
  screenText = "What can I help you with?\n>",
  surfaceTitle = "agent-pane",
  mutableScreen?: { text: string },
  additionalSurfaces: TestSurface[] = [],
  primarySurfaceUuid?: string,
): ExecFn {
  let promptPending = false;
  let promptSurface = "surface:new";
  let pastePending = false;
  let currentScreenText = screenText;
  const surfaces: TestSurface[] = [
    {
      id: primarySurfaceUuid,
      ref: "surface:new",
      title: surfaceTitle,
      text: screenText,
    },
    ...additionalSurfaces,
  ];
  const setScreenText = (text: string, surfaceRef = "surface:new") => {
    const surface = surfaces.find(({ ref }) => ref === surfaceRef);
    if (surface) surface.text = text;
    if (surfaceRef === "surface:new") {
      currentScreenText = text;
      if (mutableScreen) mutableScreen.text = text;
    }
  };
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("list-windows")) {
      return {
        stdout: JSON.stringify({
          windows: [{ ref: "window:1", workspace_count: 1 }],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-workspaces")) {
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
    if (args.includes("list-panes")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          panes: [
            {
              ref: "pane:1",
              index: 0,
              focused: true,
              surface_count: surfaces.length,
              surface_refs: surfaces.map(({ ref }) => ref),
              ...(surfaces.every(({ id }) => id)
                ? { surface_ids: surfaces.map(({ id }) => id!) }
                : {}),
              selected_surface_ref: "surface:new",
            },
          ],
        }),
        stderr: "",
      };
    }
    if (args.includes("list-pane-surfaces")) {
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: surfaces.map((surface, index) => ({
            id: surface.id,
            ref: surface.ref,
            title: surface.title,
            type: "terminal",
            index,
            selected: index === 0,
          })),
        }),
        stderr: "",
      };
    }
    if (args.includes("read-screen")) {
      const surface =
        surfaces.find(({ ref }) => args.includes(ref)) ?? surfaces[0]!;
      return {
        stdout: JSON.stringify({
          surface: surface.ref,
          text:
            surface.ref === "surface:new"
              ? (mutableScreen?.text ?? currentScreenText)
              : surface.text,
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }
    if (args.includes("close-surface")) {
      const surfaceRef = String(args[args.indexOf("--surface") + 1] ?? "");
      const surfaceIndex = surfaces.findIndex(({ ref }) => ref === surfaceRef);
      if (surfaceIndex >= 0) surfaces.splice(surfaceIndex, 1);
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send-key") && args.includes("return")) {
      if (promptPending) {
        setScreenText("Claude Code\n✻ Working\n", promptSurface);
        promptPending = false;
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("set-buffer")) {
      pastePending = String(args.at(-1) ?? "").trim().length > 0;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("paste-buffer")) {
      if (pastePending) promptPending = true;
      pastePending = false;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send")) {
      const text = String(args.at(-1) ?? "");
      if (
        text.trim() &&
        (text.includes("cmuxlayer contract for") ||
          !/[A-Za-z0-9_.-]+(?:Claude|Codex|Cursor|Gemini|Kiro)\b/.test(text))
      ) {
        promptPending = true;
        promptSurface =
          surfaces.find(({ ref }) => args.includes(ref))?.ref ?? "surface:new";
        setScreenText(`Claude Code\n❯ ${text}`, promptSurface);
      }
    }
    return {
      stdout: JSON.stringify({
        workspace: "workspace:1",
        surface: "surface:new",
        ...(primarySurfaceUuid ? { surface_id: primarySurfaceUuid } : {}),
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

/** Everything typed or pasted at the pane, however it was routed. */
function sentText(exec: ExecFn): string {
  return (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map(([, args]: [string, string[]]) => (args ?? []).join(" "))
    .join("\n");
}

function parentRecord(
  surfaceUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
): AgentRecord {
  return {
    agent_id: "lead-parent",
    surface_id: "surface:new",
    surface_uuid: surfaceUuid,
    workspace_id: "workspace:1",
    state: "ready",
    repo: "cmuxlayer",
    model: "claude-sonnet-4-5",
    cli: "claude",
    cli_session_id: null,
    cli_session_path: null,
    task_summary: "parent fixture",
    pid: null,
    version: 1,
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "orchestrator",
    auto_archive_on_done: false,
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: true,
    respawn_attempts: 0,
    user_killed: false,
    boot_prompt_pending: false,
    launch_cwd: null,
    mcp_profile: null,
    worktree_path: null,
    worktree_branch: null,
  };
}

describe("P11 spawn_agent issues the coordination contract", () => {
  let inboxDir: string;
  let exec: ExecFn;
  let server: any;
  let watchRegistryPath: string;

  beforeEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    mkdirSync(STATE_DIR, { recursive: true });
    inboxDir = mkdtempSync(join(tmpdir(), "p11-inbox-"));
    watchRegistryPath = join(inboxDir, "watch-specs.json");
    exec = makeExec();
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
  });

  afterEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
  });

  async function spawn(
    extra: Record<string, unknown> = {},
    targetServer = server,
  ) {
    const tool = targetServer._registeredTools["spawn_agent"];
    const result = await runWithCallerContext(
      { workspaceId: "workspace:1" },
      () =>
        tool.handler(
          {
            repo: "brainlayer",
            model: "sonnet",
            cli: "claude",
            role: "worker",
            prompt: "task",
            ...extra,
          },
          {} as never,
        ),
    );
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }

  it("returns report_path and done_marker in the LEAN receipt", async () => {
    const parsed = await spawn();
    expect(parsed.ok).toBe(true);
    const expected = issueCoordinationContract(parsed.agent_id as string, {
      baseDir: inboxDir,
    });
    expect(parsed.report_path).toBe(expected.report_path);
    expect(parsed.done_marker).toBe(expected.done_marker);
  });

  it("persists the contract on the record, so the consumer reads what was issued", async () => {
    const parsed = await spawn();
    const getState = server._registeredTools["get_agent_state"];
    const state = await getState.handler(
      { agent_id: parsed.agent_id },
      {} as never,
    );
    const detail = state.structuredContent ?? JSON.parse(state.content[0].text);
    expect(detail.report_path).toBe(parsed.report_path);
    expect(detail.done_marker).toBe(parsed.done_marker);
  });

  it("wakes the parent once per distinct report content", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const baseExec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [
        {
          id: childUuid,
          ref: "surface:child",
          title: "child-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:child",
            surface_id: childUuid,
            pane: "pane:1",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    let watchNow = 1_000;
    const unavailableExternalNotify = vi.fn().mockResolvedValue(false);
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchRegistryNow: () => watchNow,
        watchNotify: unavailableExternalNotify,
      }),
    );
    let engine = server._registeredTools.interact._engine;
    const parent = parentRecord(parentUuid);
    engine.stateMgr.writeState(parent);
    engine.getRegistry().set(parent.agent_id, parent);
    const child = await spawn({ parent_agent_id: parent.agent_id });

    expect(child.ok, JSON.stringify(child)).toBe(true);
    expect(child.parent_agent_id).toBe(parent.agent_id);
    expect(existsSync(child.report_path)).toBe(true);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        owner: parent.agent_id,
        subject_agent_id: child.agent_id,
        target: child.report_path,
        change: "content",
        state: "armed",
      }),
    ]);

    await server.close();
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchRegistryNow: () => watchNow,
        watchNotify: unavailableExternalNotify,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);
    engine = server._registeredTools.interact._engine;
    const before = (exec as ReturnType<typeof vi.fn>).mock.calls.length;
    writeFileSync(
      child.report_path,
      `STATUS: DONE\nfirst stop\n${child.done_marker}\n`,
      "utf8",
    );
    await engine.sweepWatchesBestEffort();
    const afterCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(
      before,
    );
    expect(
      afterCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[report]") && arg.includes(child.report_path),
        ),
      ),
    ).toBe(true);

    const afterFirstWake = (exec as ReturnType<typeof vi.fn>).mock.calls.length;
    watchNow = 2_000;
    await engine.sweepWatchesBestEffort();
    const retryCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(
      afterFirstWake,
    );
    expect(
      retryCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[report]") && arg.includes(child.report_path),
        ),
      ),
    ).toBe(false);

    writeFileSync(
      child.report_path,
      `STATUS: DONE\nfirst stop\n${child.done_marker}\n`,
      "utf8",
    );
    await engine.sweepWatchesBestEffort();
    const secondWakeCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(
      afterFirstWake,
    );
    expect(
      secondWakeCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[report]") && arg.includes(child.report_path),
        ),
      ),
    ).toBe(false);

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        owner: parent.agent_id,
        target: child.report_path,
        change: "content",
        state: "armed",
        notification_pending: false,
      }),
    ]);
  });

  it("drops a child-scoped report watch when close_surface closes the agent", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord();
    const reportPath = join(inboxDir, "closed-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      agent_id: "closed-child",
      surface_id: "surface:already-gone",
      state: "done",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
      // stopAgent is a no-op for an already-terminal child, so deferred
      // cleanup must not rely on user_killed being set by the stop path.
      user_killed: false,
      report_path: reportPath,
      task_summary: "closed child fixture",
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "done\n", "utf8");
    engine.stateMgr.writeState(parent);
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(parent.agent_id, parent);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: parent.agent_id,
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    const closeResult = await server._registeredTools.close_surface.handler(
      { scope: "agent", agent_id: child.agent_id, force: true },
      {} as never,
    );

    expect(closeResult.isError, JSON.stringify(closeResult)).not.toBe(true);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([]);
  });

  it.each(["stop_agent", "kill", "close_surface"] as const)(
    "drops a child-scoped report watch after %s terminates the child",
    async (toolName) => {
      await server._registeredTools.list_agents.handler({}, {} as never);
      const engine = server._registeredTools.interact._engine;
      const reportPath = join(inboxDir, toolName, "report.md");
      const child: AgentRecord = {
        ...parentRecord(),
        agent_id: `terminated-by-${toolName}`,
        surface_id: "surface:new",
        surface_uuid: null,
        state: "done",
        parent_agent_id: "lead-parent",
        spawn_depth: 1,
        role: "worker",
        report_path: reportPath,
      };
      mkdirSync(join(inboxDir, toolName), { recursive: true });
      writeFileSync(reportPath, "done\n", "utf8");
      engine.stateMgr.writeState(child);
      engine.getRegistry().set(child.agent_id, child);
      await engine.armWatch({
        owner: "lead-parent",
        subject_agent_id: child.agent_id,
        target: reportPath,
        change: "content",
        deadline: Number.MAX_SAFE_INTEGER,
      });
      const markerPath = join(inboxDir, toolName, "marker.md");
      writeFileSync(markerPath, "working\n", "utf8");
      await engine.armWatch({
        owner: "lead-parent",
        subject_agent_id: child.agent_id,
        target: markerPath,
        marker: "DONE_MARKER",
        deadline: Number.MAX_SAFE_INTEGER,
      });

      const args =
        toolName === "stop_agent"
          ? { agent_id: child.agent_id, force: true }
          : toolName === "kill"
            ? { target: child.agent_id, force: true }
            : { scope: "surface", surface: child.surface_id, force: true };
      const result = await server._registeredTools[toolName].handler(
        args,
        {} as never,
      );

      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      await vi.waitFor(() =>
        expect(
          readWatchRegistry({ registryPath: watchRegistryPath }).watches,
        ).toEqual([
          expect.objectContaining({
            subject_agent_id: child.agent_id,
            target: markerPath,
            marker: "DONE_MARKER",
            state: "armed",
          }),
        ]),
      );
    },
  );

  it("closes the pane and schedules watch cleanup when the registry lock is contended", async () => {
    await server.close();
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "child-pane",
      undefined,
      [],
      childUuid,
    );
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const reportPath = join(inboxDir, "locked-close-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord(childUuid),
      agent_id: "locked-close-child",
      surface_id: "surface:new",
      state: "done",
      parent_agent_id: "lead-parent",
      spawn_depth: 1,
      role: "worker",
      user_killed: true,
      report_path: reportPath,
      task_summary: "locked close child fixture",
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "done\n", "utf8");
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: "lead-parent",
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    const lockPath = `${watchRegistryPath}.lock`;
    mkdirSync(lockPath);
    vi.useFakeTimers({ now: 10_000 });
    try {
      const closePromise = server._registeredTools.close_surface.handler(
        { scope: "agent", agent_id: child.agent_id, force: true },
        {} as never,
      );
      await vi.advanceTimersByTimeAsync(5_001);
      const closeResult = await closePromise;

      expect(closeResult.isError, JSON.stringify(closeResult)).not.toBe(true);
      expect(closeResult.structuredContent).toMatchObject({
        surface_closed: true,
        watch_cleanup: "scheduled",
      });
      expect(
        (exec as ReturnType<typeof vi.fn>).mock.calls.some(
          ([, args]: [string, string[]]) => args.includes("close-surface"),
        ),
      ).toBe(true);

      rmSync(lockPath, { recursive: true, force: true });
      await vi.advanceTimersByTimeAsync(10);
      await engine.runSweep();
      expect(
        readWatchRegistry({ registryPath: watchRegistryPath }).watches,
      ).toEqual([]);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("keeps a report watch when the child resumes before deferred cleanup acquires the lock", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const reportPath = join(inboxDir, "resumed-during-cleanup", "report.md");
    const child: AgentRecord = {
      ...parentRecord(),
      agent_id: "resumed-during-cleanup",
      surface_id: "surface:new",
      state: "done",
      parent_agent_id: "lead-parent",
      spawn_depth: 1,
      role: "worker",
      user_killed: true,
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "done\n", "utf8");
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: "lead-parent",
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const lockPath = `${watchRegistryPath}.lock`;
    mkdirSync(lockPath);
    vi.useFakeTimers({ now: 10_000 });

    try {
      const closeResult = await server._registeredTools.close_surface.handler(
        { scope: "agent", agent_id: child.agent_id, force: true },
        {} as never,
      );
      expect(closeResult.isError, JSON.stringify(closeResult)).not.toBe(true);

      const resumed = {
        ...child,
        state: "ready" as const,
        user_killed: false,
        deletion_intent: false,
      };
      engine.stateMgr.writeState(resumed);
      engine.getRegistry().set(resumed.agent_id, resumed);
      rmSync(lockPath, { recursive: true, force: true });
      await vi.advanceTimersByTimeAsync(20);

      expect(
        readWatchRegistry({ registryPath: watchRegistryPath }).watches,
      ).toEqual([
        expect.objectContaining({
          subject_agent_id: child.agent_id,
          target: reportPath,
          change: "content",
          state: "armed",
        }),
      ]);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("drops persisted closed-child report watches before the first daemon sweep", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord();
    const reportPath = join(inboxDir, "closed-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      agent_id: "closed-child",
      surface_id: "surface:closed-child",
      state: "done",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
      user_killed: true,
      report_path: reportPath,
      task_summary: "closed child fixture",
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "done\n", "utf8");
    engine.stateMgr.writeState(parent);
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(parent.agent_id, parent);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: parent.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toHaveLength(1);

    await server.close();
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([]);
  });

  it("prunes at least 100 legacy rows whose agent channel directories are absent", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const watches = Array.from({ length: 120 }, (_, index) => ({
      watch_id: `legacy-dead-${index}`,
      owner: "lead-parent",
      target: join(inboxDir, `legacy-dead-${index}`, "report.md"),
      change: "content" as const,
      deadline: Number.MAX_SAFE_INTEGER,
      target_kind: "file" as const,
      armed_at_ms: 1_000,
      last_heartbeat_at_ms: 1_000,
      liveness_source: "process",
      liveness: {
        value: true,
        source: "process" as const,
        observed_at_ms: 1_000,
      },
      state: "armed" as const,
    }));
    writeFileSync(
      watchRegistryPath,
      `${JSON.stringify({ version: 1, watches }, null, 2)}\n`,
      "utf8",
    );
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toHaveLength(120);

    await (
      engine as unknown as {
        pruneClosedChildReportWatches: () => Promise<void>;
      }
    ).pruneClosedChildReportWatches();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toHaveLength(0);
  });

  it("never lets terminal-child pruning remove an undelivered notification", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const reportPath = join(inboxDir, "pending-notification", "report.md");
    const child: AgentRecord = {
      ...parentRecord(),
      agent_id: "pending-notification",
      state: "done",
      parent_agent_id: "lead-parent",
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "done\n", "utf8");
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    const watch = await engine.armWatch({
      owner: "lead-parent",
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const registryFile = JSON.parse(readFileSync(watchRegistryPath, "utf8"));
    registryFile.watches[0] = {
      ...registryFile.watches[0],
      state: "fired",
      terminal_reason: "target_changed",
      terminal_at_ms: 2_000,
      observed_value: "sha256:changed",
      notification_pending: true,
      notification_attempts: 8,
      notification_next_attempt_at_ms: 2_000,
    };
    writeFileSync(
      watchRegistryPath,
      `${JSON.stringify(registryFile, null, 2)}\n`,
      "utf8",
    );

    await (
      engine as unknown as {
        pruneClosedChildReportWatches: () => Promise<void>;
      }
    ).pruneClosedChildReportWatches();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        watch_id: watch.watch_id,
        notification_pending: true,
        notification_attempts: 8,
      }),
    ]);
  });

  it("prunes a settled failed watch on the next prune pass", async () => {
    const engine = server._registeredTools.interact._engine;
    const target = join(inboxDir, "settled-deadline.md");
    writeFileSync(target, "", "utf8");
    await engine.armWatch({
      owner: "lead-parent",
      target,
      marker: "DONE",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const registryFile = JSON.parse(readFileSync(watchRegistryPath, "utf8"));
    registryFile.watches[0] = {
      ...registryFile.watches[0],
      state: "failed",
      terminal_reason: "deadline_elapsed",
      terminal_at_ms: 2_000,
      notification_pending: false,
      notification_attempts: 1,
    };
    writeFileSync(
      watchRegistryPath,
      `${JSON.stringify(registryFile, null, 2)}\n`,
      "utf8",
    );

    await (
      engine as unknown as {
        pruneClosedChildReportWatches: () => Promise<void>;
      }
    ).pruneClosedChildReportWatches();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([]);
  });

  it("fires a deadline-elapsed wait notice once and never again after restart", async () => {
    await server.close();
    let watchNow = 1_000;
    const localDeadlineNotice = vi.fn().mockResolvedValue(false);
    const serverOptions = withTestSurfaceObserver({
      exec,
      stateDir: STATE_DIR,
      disableSpawnPreflight: true,
      inboxBaseDir: inboxDir,
      watchRegistryPath,
      watchRegistryNow: () => watchNow,
    });
    server = createServer(serverOptions);
    let engine = server._registeredTools.interact._engine;
    engine.stateMgr.writeState(parentRecord());
    engine.getRegistry().set("lead-parent", parentRecord());
    (
      engine as unknown as {
        watchNotify: typeof localDeadlineNotice;
      }
    ).watchNotify = localDeadlineNotice;
    const target = join(inboxDir, "deadline-fire-once.md");
    writeFileSync(target, "", "utf8");
    setTimeout(() => {
      watchNow = 2_000;
    }, 10);

    const first = await engine.waitForWatch(
      {
        owner: "lead-parent",
        target,
        marker: "DONE",
        deadline: 2_000,
      },
      500,
    );

    expect(first.watch).toMatchObject({
      state: "failed",
      terminal_reason: "deadline_elapsed",
    });
    expect(localDeadlineNotice).toHaveBeenCalledTimes(1);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches[0],
    ).toMatchObject({
      state: "failed",
      notification_pending: false,
      notification_attempts: 1,
      notification_exhausted_reason: "terminal_notice_fire_once",
    });

    await server.close();
    watchNow = 3_000;
    server = createServer(serverOptions);
    engine = server._registeredTools.interact._engine;
    engine.stateMgr.writeState(parentRecord());
    engine.getRegistry().set("lead-parent", parentRecord());
    (
      engine as unknown as {
        watchNotify: typeof localDeadlineNotice;
      }
    ).watchNotify = localDeadlineNotice;
    await server._registeredTools.list_agents.handler({}, {} as never);
    await engine.sweepWatchesBestEffort();

    expect(localDeadlineNotice).toHaveBeenCalledTimes(1);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([]);
  });

  it("resolves a legacy bare owner seat to the live suffixed lead before delivery", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [],
      parentUuid,
    );
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = {
      ...parentRecord(),
      agent_id: "cmuxlayerClaude-live-seat",
      seat_id: "cmuxlayerClaude",
    };
    const reportPath = join(inboxDir, "bare-owner-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord(),
      agent_id: "bare-owner-child",
      surface_id: "surface:child",
      parent_agent_id: "cmuxlayerClaude",
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    for (const record of [parent, child]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    await engine.armWatch({
      owner: "cmuxlayerClaude",
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const before = (exec as ReturnType<typeof vi.fn>).mock.calls.length;
    writeFileSync(reportPath, "after\n", "utf8");

    await engine.sweepWatchesBestEffort();

    const wakeCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(before);
    expect(
      wakeCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[report]") && arg.includes(reportPath),
        ),
      ),
    ).toBe(true);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches[0],
    ).toMatchObject({
      owner: "cmuxlayerClaude",
      state: "armed",
      notification_pending: false,
      notification_attempts: 0,
    });
  });

  it("fails a missing owner seat fast and re-arms the persistent content watch", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const reportPath = join(inboxDir, "missing-owner-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord(),
      agent_id: "missing-owner-child",
      surface_id: "surface:child",
      parent_agent_id: "retired-lead-seat",
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: "retired-lead-seat",
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    writeFileSync(reportPath, "after\n", "utf8");

    await engine.sweepWatchesBestEffort();

    const watch = readWatchRegistry({
      registryPath: watchRegistryPath,
    }).watches[0];
    expect(watch).toMatchObject({
      state: "armed",
      notification_pending: false,
      notification_attempts: 0,
      notification_exhausted_reason: "owner_not_live",
    });
    expect(watch?.fingerprint).toBe(watch?.observed_value);
  });

  it("re-arms after owner_not_live and wakes the resumed owner for the next revision", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "resumed-parent-pane",
      undefined,
      [],
      parentUuid,
    );
    let watchNow = 1_000;
    const unavailableExternalNotify = vi.fn().mockResolvedValue(false);
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchRegistryNow: () => watchNow,
        watchNotify: unavailableExternalNotify,
      }),
    );
    const engine = server._registeredTools.interact._engine;
    const ownerId = "resumed-lead-seat";
    const reportPath = join(inboxDir, "resumed-owner-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      agent_id: "resumed-owner-child",
      surface_id: "surface:child",
      parent_agent_id: ownerId,
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: ownerId,
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      notify: true,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const initialFingerprint = readWatchRegistry({
      registryPath: watchRegistryPath,
    }).watches[0]?.fingerprint;

    writeFileSync(reportPath, "first revision while owner is away\n", "utf8");
    await engine.sweepWatchesBestEffort();

    const afterOwnerLoss = readWatchRegistry({
      registryPath: watchRegistryPath,
    }).watches[0];
    expect(unavailableExternalNotify).toHaveBeenCalledOnce();
    expect(afterOwnerLoss).toMatchObject({
      state: "armed",
      notification_pending: false,
      notification_attempts: 0,
      notification_exhausted_reason: "owner_not_live",
    });
    expect(afterOwnerLoss?.fingerprint).toBe(afterOwnerLoss?.observed_value);
    expect(afterOwnerLoss?.fingerprint).not.toBe(initialFingerprint);

    const resumedOwner = { ...parentRecord(parentUuid), agent_id: ownerId };
    engine.stateMgr.writeState(resumedOwner);
    engine.getRegistry().set(resumedOwner.agent_id, resumedOwner);
    const beforeResumeWake = (exec as ReturnType<typeof vi.fn>).mock.calls
      .length;
    watchNow = 2_000;
    writeFileSync(reportPath, "second revision after owner resumed\n", "utf8");
    await engine.sweepWatchesBestEffort();

    const resumedWakeCalls = (
      exec as ReturnType<typeof vi.fn>
    ).mock.calls.slice(beforeResumeWake);
    expect(
      resumedWakeCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[report]") && arg.includes(reportPath),
        ),
      ),
    ).toBe(true);
    expect(unavailableExternalNotify).toHaveBeenCalledTimes(2);
    const afterResume = readWatchRegistry({
      registryPath: watchRegistryPath,
    }).watches[0];
    expect(afterResume).toMatchObject({
      state: "armed",
      notification_pending: false,
      notification_attempts: 0,
    });
    expect(afterResume?.fingerprint).toBe(afterResume?.observed_value);
    expect(afterResume?.fingerprint).not.toBe(afterOwnerLoss?.fingerprint);
  });

  it("accepts a successful external watch notification when the owner seat is absent", async () => {
    await server.close();
    const externalNotify = vi.fn().mockResolvedValue(true);
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchNotify: externalNotify,
      }),
    );
    const engine = server._registeredTools.interact._engine;
    const child: AgentRecord = {
      ...parentRecord(),
      agent_id: "externally-notified-child",
      surface_id: "surface:child",
      parent_agent_id: "missing-owner-seat",
      spawn_depth: 1,
      role: "worker",
    };
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    const contentPath = join(inboxDir, child.agent_id, "content-report.md");
    const markerPath = join(inboxDir, child.agent_id, "marker-report.md");
    mkdirSync(dirname(contentPath), { recursive: true });
    writeFileSync(contentPath, "before\n", "utf8");
    writeFileSync(markerPath, "before\n", "utf8");
    await engine.armWatch({
      owner: child.parent_agent_id as string,
      subject_agent_id: child.agent_id,
      target: contentPath,
      change: "content",
      notify: true,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    await engine.armWatch({
      owner: child.parent_agent_id as string,
      subject_agent_id: child.agent_id,
      target: markerPath,
      marker: "DONE_EXTERNAL",
      notify: true,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    writeFileSync(contentPath, "after\n", "utf8");
    appendFileSync(markerPath, "DONE_EXTERNAL\n", "utf8");

    await engine.sweepWatchesBestEffort();

    expect(externalNotify).toHaveBeenCalledTimes(2);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: contentPath,
          state: "armed",
          notification_pending: false,
          notification_attempts: 0,
        }),
        expect.objectContaining({
          target: markerPath,
          state: "fired",
          notification_pending: false,
          notification_attempts: 0,
        }),
      ]),
    );
  });

  it("falls back externally after an aliased owner's local wake is refused", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    exec = makeExec(
      "Claude Code\n❯ preserve this human draft",
      "aliased-parent-pane",
      undefined,
      [
        {
          id: childUuid,
          ref: "surface:child",
          title: "external-fallback-child",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    const externalNotify = vi.fn().mockResolvedValue(true);
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchNotify: externalNotify,
      }),
    );
    const engine = server._registeredTools.interact._engine;
    const owner = {
      ...parentRecord(parentUuid),
      agent_id: "cmuxlayerClaude-live-seat",
      seat_id: "cmuxlayerClaude",
    };
    const child: AgentRecord = {
      ...parentRecord(childUuid),
      agent_id: "external-fallback-child",
      surface_id: "surface:child",
      parent_agent_id: "cmuxlayerClaude",
      spawn_depth: 1,
      role: "worker",
    };
    for (const record of [owner, child]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    await engine.armWatch({
      owner: "cmuxlayerClaude",
      subject_agent_id: child.agent_id,
      target: child.agent_id,
      predicate: "idle",
      notify: true,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const before = (exec as ReturnType<typeof vi.fn>).mock.calls.length;

    await engine.sweepWatchesBestEffort();

    expect(externalNotify).toHaveBeenCalledOnce();
    expect(externalNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "cmuxlayerClaude",
        subject_agent_id: child.agent_id,
        target: child.agent_id,
        reason: "predicate_matched",
      }),
    );
    const localMutationCalls = (
      exec as ReturnType<typeof vi.fn>
    ).mock.calls.slice(before);
    expect(
      localMutationCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[watch]") && arg.includes(child.agent_id),
        ),
      ),
    ).toBe(false);
    const afterFallback = readWatchRegistry({
      registryPath: watchRegistryPath,
    }).watches[0];
    expect(afterFallback).toMatchObject({
      state: "fired",
      notification_pending: false,
      notification_attempts: 0,
    });
  });

  it("delivers to a live owner whose persisted state is terminal", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [],
      parentUuid,
    );
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = { ...parentRecord(parentUuid), state: "done" as const };
    const reportPath = join(inboxDir, "terminal-owner-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      agent_id: "terminal-owner-child",
      surface_id: "surface:child",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    for (const record of [parent, child]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    await engine.armWatch({
      owner: parent.agent_id,
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const before = (exec as ReturnType<typeof vi.fn>).mock.calls.length;
    writeFileSync(reportPath, "after\n", "utf8");

    await engine.sweepWatchesBestEffort();

    const wakeCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(
      before,
    );
    expect(
      wakeCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[report]") && arg.includes(reportPath),
        ),
      ),
    ).toBe(true);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches[0],
    ).toMatchObject({
      state: "armed",
      notification_pending: false,
      notification_attempts: 0,
    });
  });

  it("keeps a first-delivery watch while its terminal child pane is live", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [
        {
          id: childUuid,
          ref: "surface:child",
          title: "child-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord(parentUuid);
    const reportPath = join(inboxDir, "live-first-delivery", "report.md");
    const child: AgentRecord = {
      ...parentRecord(childUuid),
      agent_id: "live-first-delivery",
      surface_id: "surface:child",
      surface_uuid: childUuid,
      state: "done",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    for (const record of [parent, child]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    await engine.armWatch({
      owner: parent.agent_id,
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    await (
      engine as unknown as {
        pruneClosedChildReportWatches: () => Promise<void>;
      }
    ).pruneClosedChildReportWatches();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        subject_agent_id: child.agent_id,
        state: "armed",
      }),
    ]);
  });

  it("keeps a subjectless legacy watch while its terminal child pane is live", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [
        {
          id: childUuid,
          ref: "surface:child",
          title: "child-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord(parentUuid);
    const reportPath = join(inboxDir, "legacy-live-terminal", "report.md");
    const child: AgentRecord = {
      ...parentRecord(childUuid),
      agent_id: "legacy-live-terminal",
      surface_id: "surface:child",
      surface_uuid: childUuid,
      state: "done",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    for (const record of [parent, child]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    await engine.armWatch({
      owner: parent.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    await (
      engine as unknown as {
        pruneClosedChildReportWatches: () => Promise<void>;
      }
    ).pruneClosedChildReportWatches();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        target: reportPath,
        state: "armed",
      }),
    ]);
  });

  it("keeps a delivered content watch armed while a terminal record still has a live pane", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [
        {
          id: childUuid,
          ref: "surface:child",
          title: "child-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord();
    const reportPath = join(inboxDir, "live-terminal-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord(),
      agent_id: "live-terminal-child",
      surface_id: "surface:child",
      surface_uuid: childUuid,
      state: "done",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    for (const record of [parent, child]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    await engine.armWatch({
      owner: parent.agent_id,
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    writeFileSync(reportPath, "first distinct change\n", "utf8");
    await engine.sweepWatchesBestEffort();
    const afterFirstWake = (exec as ReturnType<typeof vi.fn>).mock.calls.length;

    await (
      engine as unknown as {
        pruneClosedChildReportWatches: () => Promise<void>;
      }
    ).pruneClosedChildReportWatches();
    writeFileSync(reportPath, "second distinct change\n", "utf8");
    await engine.sweepWatchesBestEffort();

    const secondWakeCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(
      afterFirstWake,
    );
    expect(
      secondWakeCalls.some(([, args]: [string, string[]]) =>
        args.some(
          (arg) => arg.includes("[report]") && arg.includes(reportPath),
        ),
      ),
    ).toBe(true);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches[0],
    ).toMatchObject({
      state: "armed",
      notification_pending: false,
      notification_delivered_at_ms: expect.any(Number),
    });
  });

  it("does not prune a watch revision that re-arms during liveness probing", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const reportPath = join(inboxDir, "concurrent-rearm", "report.md");
    const child: AgentRecord = {
      ...parentRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      agent_id: "concurrent-rearm",
      surface_id: "surface:closed-child",
      state: "done",
      parent_agent_id: "lead-parent",
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    const watch = await engine.armWatch({
      owner: "lead-parent",
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const initialRegistry = JSON.parse(readFileSync(watchRegistryPath, "utf8"));
    initialRegistry.watches[0] = {
      ...initialRegistry.watches[0],
      notification_delivered_at_ms: 2_000,
    };
    writeFileSync(
      watchRegistryPath,
      `${JSON.stringify(initialRegistry, null, 2)}\n`,
      "utf8",
    );
    let releaseLivenessProbe: (() => void) | undefined;
    let markProbeStarted: (() => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const livenessGate = new Promise<void>((resolve) => {
      releaseLivenessProbe = resolve;
    });
    vi.spyOn(engine.getRegistry(), "isSurfaceAlive").mockImplementation(
      async () => {
        markProbeStarted?.();
        await livenessGate;
        return false;
      },
    );

    const pruning = (
      engine as unknown as {
        pruneClosedChildReportWatches: () => Promise<void>;
      }
    ).pruneClosedChildReportWatches();
    await probeStarted;
    const rearmedRegistry = JSON.parse(readFileSync(watchRegistryPath, "utf8"));
    rearmedRegistry.watches[0] = {
      ...rearmedRegistry.watches[0],
      fingerprint: "concurrent-revision",
      observed_value: "concurrent-revision",
      notification_delivered_at_ms: 3_000,
    };
    writeFileSync(
      watchRegistryPath,
      `${JSON.stringify(rearmedRegistry, null, 2)}\n`,
      "utf8",
    );
    releaseLivenessProbe?.();
    await pruning;

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        watch_id: watch.watch_id,
        fingerprint: "concurrent-revision",
        notification_delivered_at_ms: 3_000,
      }),
    ]);
  });

  it("keeps lifecycle initialization live and retries startup pruning after lock contention", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord();
    const reportPath = join(inboxDir, "locked-startup-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      agent_id: "locked-startup-child",
      surface_id: "surface:closed-child",
      state: "done",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
      user_killed: true,
      report_path: reportPath,
      task_summary: "locked startup child fixture",
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "done\n", "utf8");
    engine.stateMgr.writeState(parent);
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(parent.agent_id, parent);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: parent.agent_id,
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    await server.close();

    const lockPath = `${watchRegistryPath}.lock`;
    mkdirSync(lockPath);
    vi.useFakeTimers({ now: 10_000 });
    try {
      server = createServer(
        withTestSurfaceObserver({
          exec,
          stateDir: STATE_DIR,
          disableSpawnPreflight: true,
          inboxBaseDir: inboxDir,
          watchRegistryPath,
        }),
      );
      const listPromise = server._registeredTools.list_agents.handler(
        {},
        {} as never,
      );
      await vi.advanceTimersByTimeAsync(5_001);
      const listResult = await listPromise;

      expect(listResult.isError, JSON.stringify(listResult)).not.toBe(true);
      expect(
        readWatchRegistry({ registryPath: watchRegistryPath }).watches,
      ).toHaveLength(1);

      rmSync(lockPath, { recursive: true, force: true });
      await server._registeredTools.interact._engine.runSweep();
      expect(
        readWatchRegistry({ registryPath: watchRegistryPath }).watches,
      ).toEqual([]);
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("retains a valid subject watch when retry sees only persisted child state", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord();
    const reportPath = join(inboxDir, "persisted-only-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      agent_id: "persisted-only-child",
      surface_id: "surface:persisted-only-child",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
      task_summary: "persisted-only child fixture",
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "working\n", "utf8");
    engine.stateMgr.writeState(parent);
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(parent.agent_id, parent);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: parent.agent_id,
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    engine.getRegistry().remove(child.agent_id);
    engine.scheduleClosedChildReportWatchPrune();
    await engine.runSweep();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        owner: parent.agent_id,
        subject_agent_id: child.agent_id,
        target: reportPath,
        state: "armed",
      }),
    ]);
  });

  it("prunes a terminal child's report watch when stop left user_killed unset", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const target = join(
      inboxDir,
      "terminal-child-without-stop-flag",
      "report.md",
    );
    const child: AgentRecord = {
      ...parentRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      agent_id: "terminal-child-without-stop-flag",
      surface_id: "surface:closed-child",
      state: "done",
      user_killed: false,
      parent_agent_id: "lead-parent",
      spawn_depth: 1,
      role: "worker",
      report_path: target,
    };
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(target, "done\n", "utf8");
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: "lead-parent",
      subject_agent_id: child.agent_id,
      target,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    engine.scheduleClosedChildReportWatchPrune();
    await engine.runSweep();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([]);
  });

  it("leaves non-report subject watches alone when pruning a closed child", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const child: AgentRecord = {
      ...parentRecord(),
      agent_id: "closed-child-with-marker-watch",
      state: "done",
      user_killed: true,
      parent_agent_id: "lead-parent",
      spawn_depth: 1,
      role: "worker",
    };
    const target = join(inboxDir, child.agent_id, "marker.md");
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(target, "working\n", "utf8");
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(child.agent_id, child);
    await engine.armWatch({
      owner: "lead-parent",
      subject_agent_id: child.agent_id,
      target,
      marker: "DONE_MARKER",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    await engine.armWatch({
      owner: "lead-parent",
      subject_agent_id: child.agent_id,
      target,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    engine.scheduleClosedChildReportWatchPrune();
    await engine.runSweep();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        subject_agent_id: child.agent_id,
        marker: "DONE_MARKER",
        state: "armed",
      }),
    ]);
  });

  it("retains a legacy shared-path watch when any matching direct child is live", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const target = join(inboxDir, "legacy-shared", "report.md");
    const liveChild: AgentRecord = {
      ...parentRecord(),
      agent_id: "legacy-live-child",
      parent_agent_id: "lead-live",
      spawn_depth: 1,
      role: "worker",
      report_path: target,
    };
    const closedChild: AgentRecord = {
      ...parentRecord(),
      agent_id: "legacy-closed-child",
      state: "done",
      user_killed: true,
      parent_agent_id: "lead-closed",
      spawn_depth: 1,
      role: "worker",
      report_path: target,
    };
    mkdirSync(join(inboxDir, "legacy-shared"), { recursive: true });
    writeFileSync(target, "working\n", "utf8");
    engine.stateMgr.writeState(liveChild);
    engine.stateMgr.writeState(closedChild);
    engine.getRegistry().set(liveChild.agent_id, liveChild);
    engine.getRegistry().set(closedChild.agent_id, closedChild);
    await engine.armWatch({
      owner: liveChild.parent_agent_id,
      target,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });

    engine.scheduleClosedChildReportWatchPrune();
    await engine.runSweep();

    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toEqual([
      expect.objectContaining({
        owner: liveChild.parent_agent_id,
        target,
        state: "armed",
      }),
    ]);
  });

  it("preserves a prune request scheduled while the previous prune is in flight", async () => {
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const controlled = engine as unknown as {
      pruneClosedChildReportWatches: () => Promise<void>;
      retryClosedChildReportWatchPrune: () => Promise<void>;
    };
    let releaseFirstPrune: (() => void) | undefined;
    const prune = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstPrune = resolve;
          }),
      )
      .mockResolvedValue();
    controlled.pruneClosedChildReportWatches = prune;

    engine.scheduleClosedChildReportWatchPrune();
    const firstRetry = controlled.retryClosedChildReportWatchPrune();
    await vi.waitFor(() => expect(prune).toHaveBeenCalledOnce());
    engine.scheduleClosedChildReportWatchPrune();
    releaseFirstPrune?.();
    await firstRetry;
    await controlled.retryClosedChildReportWatchPrune();

    expect(prune).toHaveBeenCalledTimes(2);
  });

  it("does not wake a lead for another parent's child report", async () => {
    await server.close();
    const externalNotify = vi.fn().mockResolvedValue(true);
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchNotify: externalNotify,
      }),
    );
    await server._registeredTools.list_agents.handler({}, {} as never);
    const engine = server._registeredTools.interact._engine;
    const owner = parentRecord();
    const foreignParent: AgentRecord = {
      ...parentRecord("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      agent_id: "foreign-parent",
      surface_id: "surface:foreign-parent",
    };
    const reportPath = join(inboxDir, "foreign-child", "report.md");
    const foreignChild: AgentRecord = {
      ...parentRecord("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      agent_id: "foreign-child",
      surface_id: "surface:foreign-child",
      parent_agent_id: foreignParent.agent_id,
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
      task_summary: "foreign child fixture",
    };
    mkdirSync(join(inboxDir, foreignChild.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    for (const record of [owner, foreignParent, foreignChild]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    await engine.armWatch({
      owner: owner.agent_id,
      subject_agent_id: foreignChild.agent_id,
      target: reportPath,
      change: "content",
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const before = (exec as ReturnType<typeof vi.fn>).mock.calls.length;

    writeFileSync(reportPath, "after\n", "utf8");
    await engine.sweepWatchesBestEffort();

    const wakeCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(
      before,
    );
    expect(
      wakeCalls.some(([, args]: [string, string[]]) =>
        args.some((arg) => arg.includes("[report]")),
      ),
    ).toBe(false);
    expect(externalNotify).not.toHaveBeenCalled();
  });

  it("does not wake the former parent when a child is reparented during external notification", async () => {
    await server.close();
    const owner = parentRecord();
    const nextParent: AgentRecord = {
      ...parentRecord("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      agent_id: "next-parent",
      surface_id: "surface:next-parent",
    };
    const reportPath = join(inboxDir, "reparented-child", "report.md");
    const child: AgentRecord = {
      ...parentRecord("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      agent_id: "reparented-child",
      surface_id: "surface:reparented-child",
      parent_agent_id: owner.agent_id,
      spawn_depth: 1,
      role: "worker",
      report_path: reportPath,
      task_summary: "reparent race fixture",
    };
    const externalNotify = vi.fn().mockImplementation(() => {
      const reparented = { ...child, parent_agent_id: nextParent.agent_id };
      engine.stateMgr.writeState(reparented);
      engine.getRegistry().set(reparented.agent_id, reparented);
      return Promise.resolve(true);
    });
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchNotify: externalNotify,
      }),
    );
    const engine = server._registeredTools.interact._engine;
    mkdirSync(join(inboxDir, child.agent_id), { recursive: true });
    writeFileSync(reportPath, "before\n", "utf8");
    for (const record of [owner, nextParent, child]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    await engine.armWatch({
      owner: owner.agent_id,
      subject_agent_id: child.agent_id,
      target: reportPath,
      change: "content",
      notify: true,
      deadline: Number.MAX_SAFE_INTEGER,
    });
    const before = (exec as ReturnType<typeof vi.fn>).mock.calls.length;

    writeFileSync(reportPath, "after\n", "utf8");
    await engine.sweepWatchesBestEffort();

    expect(externalNotify).toHaveBeenCalledOnce();
    const wakeCalls = (exec as ReturnType<typeof vi.fn>).mock.calls.slice(
      before,
    );
    expect(
      wakeCalls.some(([, args]: [string, string[]]) =>
        args.some((arg) => arg.includes("[report]")),
      ),
    ).toBe(false);
  });

  it("does not describe a missing report target as a done marker and preserves the reason-aware notifier", async () => {
    await server.close();
    const externalNotify = vi.fn().mockResolvedValue(true);
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [],
      parentUuid,
    );
    let watchNow = 1_000;
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
        watchRegistryNow: () => watchNow,
        watchNotify: externalNotify,
      }),
    );
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord(parentUuid);
    engine.stateMgr.writeState(parent);
    engine.getRegistry().set(parent.agent_id, parent);
    const reportPath = join(inboxDir, "reaped-child", "report.md");
    mkdirSync(join(inboxDir, "reaped-child"), { recursive: true });
    writeFileSync(reportPath, "", "utf8");
    await engine.armWatch({
      owner: parent.agent_id,
      target: reportPath,
      marker: "DONE_REAPED_CHILD",
      notify: true,
      deadline: Number.MAX_SAFE_INTEGER,
    });

    rmSync(reportPath);
    await engine.sweepWatchesBestEffort();

    expect(sentText(exec)).not.toContain("target missing");
    expect(externalNotify).not.toHaveBeenCalled();

    watchNow = 3_000;
    await engine.sweepWatchesBestEffort();

    expect(sentText(exec)).not.toContain("done marker observed");
    expect(sentText(exec)).toContain("target missing");
    expect(externalNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: parent.agent_id,
        target: reportPath,
        target_kind: "file",
        reason: "target_missing",
      }),
    );
  });

  it("keeps an already-created child spawn successful when its report watch cannot be armed", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const baseExec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [
        {
          id: childUuid,
          ref: "surface:child",
          title: "child-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    exec = vi.fn().mockImplementation((cmd, args: string[]) => {
      if (args.includes("new-split")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:child",
            surface_id: childUuid,
            pane: "pane:1",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        watchRegistryPath,
      }),
    );
    const engine = server._registeredTools.interact._engine;
    const parent = parentRecord(parentUuid);
    engine.stateMgr.writeState(parent);
    engine.getRegistry().set(parent.agent_id, parent);
    const blockingFile = join(inboxDir, "not-a-directory");
    writeFileSync(blockingFile, "blocks mkdir", "utf8");

    const child = await spawn({
      parent_agent_id: parent.agent_id,
      report_path: join(blockingFile, "report.md"),
    });

    expect(child.ok, JSON.stringify(child)).toBe(true);
    expect(child.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/report watch was not armed/i),
      ]),
    );
    expect(engine.getAgentState(child.agent_id)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // P11b: the boot prompt carries a POINTER, not the contract.
  // -------------------------------------------------------------------------

  it("P11b: the contract file exists and carries the mailbox contract AND the issued report contract", async () => {
    const parsed = await spawn();
    expect(parsed.contract_path).toBe(
      coordinationContractPath(parsed.agent_id as string, {
        baseDir: inboxDir,
      }),
    );
    const file = readFileSync(parsed.contract_path, "utf8");
    // Mailbox half -- the ~479 chars that used to ride the wire.
    expect(file).toContain(
      recommendedMonitorCommand(parsed.agent_id, {
        baseDir: inboxDir,
      }),
    );
    expect(file).toContain("CMUX_INBOX_MSG_ID=<handled-message-id>");
    expect(file).toContain(`cmuxlayer inbox-cursor '${parsed.agent_id}'`);
    // Report half -- the #454-issued contract that never fit inline. Byte-equal
    // to the receipt, which is the whole P11 invariant.
    expect(file).toContain(parsed.report_path);
    expect(file).toContain(parsed.done_marker);
  });

  it("P11b: the boot prompt is a one-line pointer, and it points at the file", async () => {
    const parsed = await spawn();
    const injection = bootContractPointer(
      parsed.agent_id as string,
      parsed.contract_path as string,
    );
    expect(injection).not.toMatch(/[\r\n]/);
    expect(sentText(exec)).toContain(injection);
    // The instructions themselves are NOT on the wire any more.
    expect(sentText(exec)).not.toContain("monitor with tail -n0 -F");
  });

  it("P11b: the composed boot prompt stays under SEND_INPUT_CHUNK_THRESHOLD for a real-length agent id", async () => {
    // This is the regression that took the suite 10 red at 618 chars. Asserted
    // on the delivered text, not on the injection alone: what crosses the
    // threshold is caller prompt + injection joined, and that is what splits.
    await spawn();
    const deliveries = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([, args]: [string, string[]]) => String((args ?? []).at(-1) ?? ""))
      .filter((text) => text.includes("cmuxlayer contract for"));
    expect(deliveries.length).toBeGreaterThan(0);
    for (const text of deliveries) {
      expect(text.length).toBeLessThan(BOOT_INJECTION_CHUNK_THRESHOLD);
    }

    // And on the pure function, for an agent id at the long end of the real
    // range -- the spawned id is short, so it alone would not catch a widening.
    const longId = "cmuxlayerClaude-d2fc302f";
    const longPointer = bootContractPointer(
      longId,
      coordinationContractPath(longId, {
        baseDir: "/home/someone-with-a-long-name/.cmux/agents",
      }),
    );
    expect(longPointer.length).toBeLessThan(BOOT_INJECTION_CHUNK_THRESHOLD);
  });

  it("P11b: boot delivery is not SPLIT -- the whole composed prompt lands in one write", async () => {
    // Splitting is the hazard, not pasting: the composed boot prompt (caller
    // text + injection, newline-joined) has always gone through the composer
    // paste, but at 618 chars it CHUNKED, and multi-chunk boot delivery is the
    // most incident-prone route in this repo (#434/#438). So assert one write
    // carrying BOTH halves -- two writes would mean the split came back.
    await spawn();
    const writes = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, args]: [string, string[]]) =>
        (args ?? []).some((arg) =>
          String(arg).includes("cmuxlayer contract for"),
        ),
      )
      .map(([, args]: [string, string[]]) => String((args ?? []).at(-1) ?? ""));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("task");
    expect(writes[0]!.length).toBeLessThan(BOOT_INJECTION_CHUNK_THRESHOLD);
  });

  it("P11b R4: an unwritable contract file falls back to inline WITHOUT emitting a dangling pointer", async () => {
    // The adversarial case: if the write fails, the boot prompt must not point
    // at a file that does not exist. The inline-mode test reaches the same
    // OUTCOME by a different route, so this branch needs its own pin -- a
    // regression that emitted the pointer before the write, or let the throw
    // escape and fail the spawn, would otherwise stay green.
    const blockedBase = join(tmpdir(), `p11b-blocked-${process.pid}-inbox`);
    rmSync(blockedBase, { recursive: true, force: true });
    // A FILE where the base dir should be: every channel-dir mkdir under it
    // fails, so the contract write cannot succeed.
    writeFileSync(blockedBase, "not a directory");
    const blockedExec = makeExec();
    const blockedStateDir = mkdtempSync(join(tmpdir(), "p11b-blocked-state-"));
    const blockedServer: any = createServer(
      withTestSurfaceObserver({
        exec: blockedExec,
        stateDir: blockedStateDir,
        disableSpawnPreflight: true,
        inboxBaseDir: blockedBase,
      }),
    );
    try {
      const parsed = await runWithCallerContext(
        { workspaceId: "workspace:1" },
        async () => {
          const result = await blockedServer._registeredTools[
            "spawn_agent"
          ].handler(
            {
              repo: "brainlayer",
              model: "sonnet",
              cli: "claude",
              role: "worker",
              prompt: "task",
            },
            {} as never,
          );
          return result.structuredContent ?? JSON.parse(result.content[0].text);
        },
      );

      // The spawn still succeeds -- a contract-file failure is not a spawn
      // failure.
      expect(parsed.ok).toBe(true);
      expect(parsed.contract_path).toBeUndefined();
      // No dangling pointer on the wire, and the mailbox contract still got
      // through: the worker loses the report half, not its inbox.
      const wire = sentText(blockedExec);
      expect(wire).not.toContain("Read and follow");
      expect(wire).toContain("cmuxlayer mailbox contract for");
      // And the receipt says the lead must relay.
      expect(parsed.coordination_footer_delivered).toBe(false);
      expect(parsed.coordination_footer_note).toMatch(/not_wired/);
      expect(parsed.coordination_footer_note).toMatch(/LEAD must relay/i);
    } finally {
      rmSync(blockedBase, { recursive: true, force: true });
      rmSync(blockedStateDir, { recursive: true, force: true });
    }
  });

  it("P11b: CMUXLAYER_BOOT_CONTRACT=inline restores the pre-P11b inline contract", async () => {
    process.env.CMUXLAYER_BOOT_CONTRACT = "inline";
    try {
      const parsed = await spawn();
      expect(sentText(exec)).toContain("cmuxlayer mailbox contract for");
      expect(parsed.contract_path).toBeUndefined();
      // Provenance follows the mode: inline cannot carry the report contract,
      // so the receipt must say so rather than claiming delivery.
      expect(parsed.coordination_footer_delivered).toBe(false);
      expect(parsed.coordination_footer_note).toMatch(/not_wired/);
      expect(sentText(exec)).not.toContain(parsed.report_path);
    } finally {
      delete process.env.CMUXLAYER_BOOT_CONTRACT;
    }
  });

  it("declares the footer's own byte cost (Constraint 1, #424/#425)", async () => {
    const parsed = await spawn();
    expect(parsed.coordination_footer_bytes).toBe(
      coordinationFooterBytes({
        report_path: parsed.report_path,
        done_marker: parsed.done_marker,
      }),
    );
    // One line, so the injected boot prompt stays single-line and typed.
    expect(
      coordinationFooter({
        report_path: parsed.report_path,
        done_marker: parsed.done_marker,
      }),
    ).not.toMatch(/[\r\n]/);
    expect(parsed.coordination_footer_bytes).toBeLessThan(240);
  });

  it("REGISTRY-OPTIONAL PARITY (#453): the contract does not depend on the launcher", async () => {
    // The contract is derived from agent_id and applied ABOVE launchMode, so a
    // raw-CLI spawn cannot get a different (or missing) contract. Asserted on
    // real receipts from two independent servers, not on the derivation fn.
    const registered = await spawn();

    const rawInboxDir = mkdtempSync(join(tmpdir(), "p11-inbox-raw-"));
    const rawStateDir = mkdtempSync(join(tmpdir(), "p11-state-raw-"));
    const previousRegistry = process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
    process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = join(
      rawInboxDir,
      "no-such-launcher-registry.zsh",
    );
    try {
      const rawExec = makeExec();
      const rawServer: any = createServer(
        withTestSurfaceObserver({
          exec: rawExec,
          stateDir: rawStateDir,
          disableSpawnPreflight: true,
          inboxBaseDir: rawInboxDir,
        }),
      );
      const rawResult = await runWithCallerContext(
        { workspaceId: "workspace:1" },
        () =>
          rawServer._registeredTools["spawn_agent"].handler(
            {
              repo: "brainlayer",
              cli: "claude",
              role: "worker",
              prompt: "task",
            },
            {} as never,
          ),
      );
      const raw =
        rawResult.structuredContent ?? JSON.parse(rawResult.content[0].text);

      expect(raw.ok).toBe(true);
      expect(raw.report_path).toBe(
        issueCoordinationContract(raw.agent_id as string, {
          baseDir: rawInboxDir,
        }).report_path,
      );
      expect(raw.done_marker).toBeTruthy();
      // Assert both are actually defined -- the earlier ternary compared `raw`
      // to itself when `registered` was undefined, which proved nothing.
      expect(typeof registered.coordination_footer_bytes).toBe("number");
      expect(raw.coordination_footer_bytes).toBe(
        coordinationFooterBytes({
          report_path: raw.report_path,
          done_marker: raw.done_marker,
        }),
      );
      // P11b: provenance travels on both doors, and both now actually DELIVER
      // the contract -- the pointer file is written above launchMode, so a
      // raw-CLI spawn cannot end up as the one door that tells its worker
      // nothing.
      for (const receipt of [registered, raw]) {
        expect(receipt.coordination_footer_delivered).toBe(true);
        expect(receipt.contract_path).toMatch(/^\/.+\/contract\.md$/);
      }
      // Same contract SHAPE on both doors: issued, absolute, marker present.
      for (const receipt of [registered, raw]) {
        expect(receipt.report_path).toMatch(/^\/.+\/report\.md$/);
        expect(receipt.done_marker).toMatch(/^DONE_[A-Z0-9_:-]+$/);
      }
    } finally {
      if (previousRegistry === undefined) {
        delete process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
      } else {
        process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = previousRegistry;
      }
      rmSync(rawInboxDir, { recursive: true, force: true });
      rmSync(rawStateDir, { recursive: true, force: true });
    }
  });

  it("FINDING 3: never reports contract bytes without reporting how they were sent", async () => {
    const parsed = await spawn();
    // The v0.4.41 `paused` hazard: an authoritative number with no provenance.
    // P11b keeps the rule and flips the answer -- the note must now say the
    // contract went via the file, and must not oversell it.
    expect(parsed.coordination_footer_bytes).toBeGreaterThan(0);
    expect(parsed.coordination_footer_delivered).toBe(true);
    expect(parsed.coordination_footer_note).toMatch(
      /delivered_via_contract_file/,
    );
    expect(parsed.coordination_footer_note).not.toMatch(/not_wired/);
    // The honest cost is stated in the receipt, not just the PR body -- and
    // stated at the strength the build actually provides: nothing detects an
    // unread contract file today, so the note must not claim it does.
    expect(parsed.coordination_footer_note).toMatch(/ignores the pointer/i);
    expect(parsed.coordination_footer_note).toMatch(/observable in principle/i);
    // R3: the byte count describes the UNSENT inline rendering, and must say so
    // rather than reading as a measure of what went on the wire.
    expect(parsed.coordination_footer_note).toMatch(/NOT what was sent/i);
  });

  it("FINDING 2: a relative report_path is rejected BEFORE anything launches", async () => {
    const tool = server._registeredTools["spawn_agent"];
    const before = (exec as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    let rejected = false;
    let message = "";
    try {
      const result = await runWithCallerContext(
        { workspaceId: "workspace:1" },
        () =>
          tool.handler(
            {
              repo: "brainlayer",
              cli: "claude",
              role: "worker",
              prompt: "task",
              report_path: "reports/worker.md",
            },
            {} as never,
          ),
      );
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);
      rejected = parsed.ok === false;
      message = String(parsed.error ?? "");
    } catch (error) {
      rejected = true;
      message = error instanceof Error ? error.message : String(error);
    }
    expect(rejected).toBe(true);
    expect(message).toMatch(/absolute/i);
    // The real defect: no pane, no worktree, no launch on a validation error.
    expect(
      (exec as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(before);
  });

  it("echoes and persists an explicit absolute report_path override", async () => {
    const override = join(inboxDir, "collab", "worker-report.md");
    const parsed = await spawn({ report_path: override });
    expect(parsed.report_path).toBe(override);
    const getState = server._registeredTools["get_agent_state"];
    const state = await getState.handler(
      { agent_id: parsed.agent_id },
      {} as never,
    );
    const detail = state.structuredContent ?? JSON.parse(state.content[0].text);
    expect(detail.report_path).toBe(override);
  });

  it("rejects a shared explicit report_path before launching a second child", async () => {
    await server.close();
    const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const existingChildUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const spawnedChildUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let holdNextSplit = false;
    let releaseSplit: (() => void) | null = null;
    const baseExec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "parent-pane",
      undefined,
      [
        {
          id: existingChildUuid,
          ref: "surface:existing",
          title: "existing-child",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
        {
          id: spawnedChildUuid,
          ref: "surface:spawned",
          title: "spawned-child",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (args.includes("new-split")) {
        if (holdNextSplit) {
          holdNextSplit = false;
          await new Promise<void>((resolve) => {
            releaseSplit = resolve;
          });
        }
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:spawned",
            surface_id: spawnedChildUuid,
            pane: "pane:1",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const serverOptions = withTestSurfaceObserver({
      exec,
      stateDir: STATE_DIR,
      disableSpawnPreflight: true,
      inboxBaseDir: inboxDir,
      watchRegistryPath,
    });
    const context = createServerContext(serverOptions);
    server = createServer({ ...serverOptions, context });
    const siblingServer = createServer({ ...serverOptions, context });
    const parent = parentRecord(parentUuid);
    const existingChild: AgentRecord = {
      ...parentRecord(existingChildUuid),
      agent_id: "existing-child",
      surface_id: "surface:existing",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
      role: "worker",
    };
    const stateMgr = new StateManager(STATE_DIR);
    stateMgr.writeState(parent);
    const override = join(inboxDir, "collab", "shared-report.md");
    stateMgr.writeState({ ...existingChild, report_path: override });
    mkdirSync(join(inboxDir, "collab"), { recursive: true });
    writeFileSync(override, "", "utf8");
    const splitCalls = () =>
      (exec as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, args]: [string, string[]]) => args.includes("new-split"),
      ).length;
    const before = splitCalls();

    const second = await spawn({
      parent_agent_id: parent.agent_id,
      report_path: override,
    });

    expect(second.ok).toBe(false);
    expect(String(second.error)).toMatch(/report_path.*already.*child/i);
    expect(splitCalls()).toBe(before);
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches,
    ).toHaveLength(0);

    const concurrentOverride = join(
      inboxDir,
      "collab",
      "concurrent-shared-report.md",
    );
    const beforeConcurrent = splitCalls();
    holdNextSplit = true;
    const winningSpawn = spawn({
      parent_agent_id: parent.agent_id,
      report_path: concurrentOverride,
    });
    await vi.waitFor(() => expect(splitCalls()).toBe(beforeConcurrent + 1));
    const rejectedSpawn = spawn(
      {
        parent_agent_id: parent.agent_id,
        report_path: concurrentOverride,
      },
      siblingServer,
    );
    await Promise.resolve();
    holdNextSplit = false;
    releaseSplit?.();
    const concurrent = await Promise.all([winningSpawn, rejectedSpawn]);
    // This fixture's one successful spawn uses two new-split calls: placement
    // and launch. A third call would prove that the rejected socket launched.
    expect(splitCalls() - beforeConcurrent).toBe(2);
    expect(concurrent.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(concurrent.find((result) => result.ok === false)?.error_code).toBe(
      "REPORT_PATH_IN_USE",
    );

    const isolatedServerA = createServer({
      ...serverOptions,
      context: createServerContext(serverOptions),
    });
    const isolatedServerB = createServer({
      ...serverOptions,
      context: createServerContext(serverOptions),
    });
    const processSharedOverride = join(
      inboxDir,
      "collab",
      "forced-inprocess-shared-report.md",
    );
    const beforeIsolated = splitCalls();
    holdNextSplit = true;
    const isolatedWinner = spawn(
      {
        parent_agent_id: parent.agent_id,
        report_path: processSharedOverride,
      },
      isolatedServerA,
    );
    await vi.waitFor(() => expect(splitCalls()).toBe(beforeIsolated + 1));
    const isolatedLoser = spawn(
      {
        parent_agent_id: parent.agent_id,
        report_path: processSharedOverride,
      },
      isolatedServerB,
    );
    await Promise.resolve();
    releaseSplit?.();
    const isolated = await Promise.all([isolatedWinner, isolatedLoser]);
    expect(isolated.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(isolated.find((result) => result.ok === false)?.error_code).toBe(
      "REPORT_PATH_IN_USE",
    );
    expect(splitCalls() - beforeIsolated).toBe(2);
    await isolatedServerA.close();
    await isolatedServerB.close();
    expect(
      existsSync(`${watchRegistryPath}.report-path-reservations.json`),
    ).toBe(false);
    await siblingServer.close();
  });
});
