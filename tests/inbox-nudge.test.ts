/**
 * B5 — inbox wake must arm independent of spawn/agent state.
 *
 * dispatch_to_agent appends to the inbox file (state-independent already), but
 * the WAKE was state-dependent: send_to_agent gates on INTERACTIVE_STATES, so a
 * poisoned (error) registry record silently killed the fallback nudge and GO
 * messages sat unread (2026-06-05 incident). These tests pin the new contract:
 *
 *   - nudge="auto" (default): when the recipient's inbox monitor heartbeat is
 *     stale/absent, best-effort type a one-line inbox pointer into the agent's
 *     surface — REGARDLESS of registry state (error/done included).
 *   - heartbeat fresh → no nudge (monitor will deliver).
 *   - no agent-authored heartbeat ever → message remains durable, but the
 *     receipt is a non-retryable error instead of false delivery success.
 *   - stale heartbeat → explicit degraded success plus the recovery nudge.
 *   - nudge="never" → file append only; receipt truth is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import {
  agentDir,
  inboxPath,
  writeHeartbeat,
  readInbox,
} from "../src/inbox.js";
import type { ExecFn } from "../src/cmux-client.js";
import {
  FleetSidebarPublisher,
  type FleetSidebarPublication,
  type FleetSidebarPublisherLike,
} from "../src/fleet-sidebar.js";
import {
  TEST_SURFACE_OBSERVER_OWNER,
  withTestSurfaceObserver,
} from "./helpers/test-surface-observer.js";
import { runWithCallerContext } from "../src/caller-context.js";
import type { AgentRecord } from "../src/agent-types.js";

const STATE_DIR = join(tmpdir(), "cmux-agents-test-inbox-nudge");
const PRIMARY_SURFACE_UUID = "11111111-1111-4111-8111-111111111111";

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
  let pastePending = false;
  let pendingText = "";
  let pasteText = "";
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
  const setScreenText = (text: string) => {
    currentScreenText = text;
    if (mutableScreen) mutableScreen.text = text;
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
          surfaces: surfaces.map((surface, index) =>
            ({
              id: surface.id,
              ref: surface.ref,
              title: surface.title,
              type: "terminal",
              index,
              selected: index === 0,
            }),
          ),
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
    if (args.includes("send-key") && args.includes("return")) {
      if (promptPending) {
        setScreenText(`Claude Code\n• ${pendingText}\n✻ Working\n❯`);
        promptPending = false;
        pendingText = "";
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("set-buffer")) {
      pasteText = String(args.at(-1) ?? "");
      pastePending = pasteText.trim().length > 0;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("paste-buffer")) {
      if (pastePending) {
        promptPending = true;
        pendingText = pasteText;
        setScreenText(`Claude Code\n❯ ${pendingText}`);
      }
      pastePending = false;
      pasteText = "";
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
        pendingText = text;
        setScreenText(`Claude Code\n❯ ${pendingText}`);
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

function sendCalls(exec: ExecFn): string[][] {
  return (exec as ReturnType<typeof vi.fn>).mock.calls
    .filter(([, args]: [string, string[]]) => args.includes("send"))
    .map(([, args]: [string, string[]]) => args);
}

function createInboxServer(exec: ExecFn, inboxDir: string) {
  return createServer(
    withTestSurfaceObserver({
      exec,
      stateDir: STATE_DIR,
      disableSpawnPreflight: true,
      inboxBaseDir: inboxDir,
    }),
  );
}

async function spawnTestAgent(server: any): Promise<string> {
  const tool = server._registeredTools["spawn_agent"];
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
        },
        {} as any,
      ),
  );
  const parsed = result.structuredContent ?? JSON.parse(result.content[0].text);
  expect(parsed.ok).toBe(true);
  return parsed.agent_id as string;
}

function hierarchyRecord(input: {
  agentId: string;
  surfaceId: string;
  surfaceUuid: string;
  parentAgentId: string | null;
  state?: AgentRecord["state"];
}): AgentRecord {
  return {
    agent_id: input.agentId,
    surface_id: input.surfaceId,
    surface_uuid: input.surfaceUuid,
    workspace_id: "workspace:1",
    state: input.state ?? "ready",
    repo: "cmuxlayer",
    model: "claude-sonnet-4-5",
    cli: "claude",
    cli_session_id: null,
    cli_session_path: null,
    task_summary: "hierarchy fixture",
    pid: null,
    version: 1,
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: "2026-08-23T00:00:00.000Z",
    error: null,
    parent_agent_id: input.parentAgentId,
    spawn_depth: input.parentAgentId ? 1 : 0,
    role: input.parentAgentId ? "worker" : "orchestrator",
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

describe("dispatch_to_agent nudge (state-independent inbox wake)", () => {
  let inboxDir: string;
  let exec: ExecFn;
  let server: any;

  beforeEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    mkdirSync(STATE_DIR, { recursive: true });
    inboxDir = mkdtempSync(join(tmpdir(), "cmux-inbox-nudge-"));
    exec = makeExec();
    server = createInboxServer(exec, inboxDir);
  });

  afterEach(async () => {
    await server.close();
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
  });

  it("returns verified success when never armed but the TERMINAL-agent nudge submits", async () => {
    const agentId = await spawnTestAgent(server);

    // Poison-equivalent: force a terminal state. The nudge must still go out.
    const stop = server._registeredTools["stop_agent"];
    await stop.handler({ agent_id: agentId }, {} as any);

    const before = sendCalls(exec).length;
    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_state).toBe("never-armed");
    expect(parsed.delivery_status).toBe("queued_monitor_never_armed");
    expect(parsed.durable).toBe(true);
    expect(parsed.dispatched.task).toBe("GO");
    expect(parsed.monitor_alive).toBe(false);
    expect(parsed.nudge.attempted).toBe(true);
    expect(parsed.nudge.sent).toBe(true);
    expect(parsed.nudge.delivery).toBe("submitted");
    expect(parsed.nudge.delivery_id).toEqual(expect.any(String));
    const engine = server._registeredTools["interact"]._engine;
    expect(engine.getDeliveryReceipt(parsed.nudge.delivery_id)).toMatchObject({
      delivery_state: "submitted",
      terminal: true,
      source_event: "dispatch_nudge",
    });
    // The pointer was typed into the agent's surface despite terminal state.
    const after = sendCalls(exec);
    expect(after.length).toBeGreaterThan(before);
    const nudgeCall = after.at(-1)!;
    const nudgeText = String(nudgeCall.at(-1) ?? "");
    expect(nudgeCall.join(" ")).toContain("surface:new");
    const message = readInbox(agentId, { baseDir: inboxDir }).at(-1)!;
    expect(nudgeText).toBe(
      `[inbox] ${message.id} — reply_to: ${message.reply_to} — read ${inboxPath(agentId, { baseDir: inboxDir })}`,
    );
    // And the message itself is durably in the inbox file.
    expect(
      readInbox(agentId, { baseDir: inboxDir }).map((m) => m.task),
    ).toContain("GO");
  });

  it("returns explicit degraded success when a previously armed monitor is stale", async () => {
    const agentId = await spawnTestAgent(server);
    writeHeartbeat(agentId, { baseDir: inboxDir, now: () => 1 });

    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_alive).toBe(false);
    expect(parsed.monitor_state).toBe("stale");
    expect(parsed.delivery_status).toBe("queued_monitor_stale");
    expect(parsed.nudge.attempted).toBe(true);
    expect(parsed.nudge.sent).toBe(true);
    expect(readInbox(agentId, { baseDir: inboxDir })).toHaveLength(1);
  });

  it("queues a busy-agent inbox wake without typing into its active composer", async () => {
    const agentId = await spawnTestAgent(server);
    const engine = server._registeredTools["interact"]._engine;
    const working = engine.stateMgr.updateRecord(agentId, { state: "working" });
    engine.getRegistry().set(agentId, working);
    writeHeartbeat(agentId, { baseDir: inboxDir, now: () => 1 });

    const before = sendCalls(exec).length;
    const result = await server._registeredTools["dispatch_to_agent"].handler(
      {
        agent_id: agentId,
        task: "Read the durable inbox after the current turn",
        from: "orc",
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.nudge).toMatchObject({
      attempted: true,
      sent: true,
      delivery: "queued",
      delivery_id: expect.any(String),
    });
    expect(sendCalls(exec)).toHaveLength(before);
    expect(engine.getDeliveryReceipt(parsed.nudge.delivery_id)).toMatchObject({
      delivery_state: "queued",
      terminal: false,
      source_event: "dispatch_nudge",
    });
  });

  it("reports success when a never-armed busy recipient accepts the verified nudge queue", async () => {
    const agentId = await spawnTestAgent(server);
    const engine = server._registeredTools["interact"]._engine;
    const working = engine.stateMgr.updateRecord(agentId, { state: "working" });
    engine.getRegistry().set(agentId, working);

    const before = sendCalls(exec).length;
    const result = await server._registeredTools["dispatch_to_agent"].handler(
      {
        agent_id: agentId,
        task: "Live queue acceptance is delivery evidence",
        from: "orc",
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_state).toBe("never-armed");
    expect(parsed.nudge).toMatchObject({
      attempted: true,
      sent: true,
      delivery: "queued",
      delivery_id: expect.any(String),
    });
    expect(sendCalls(exec)).toHaveLength(before);
  });

  it("does NOT nudge when the monitor heartbeat is fresh", async () => {
    const agentId = await spawnTestAgent(server);
    writeHeartbeat(agentId, { baseDir: inboxDir });

    const before = sendCalls(exec).length;
    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_alive).toBe(true);
    expect(parsed.monitor_state).toBe("alive");
    expect(parsed.delivery_status).toBe("monitor_live");
    expect(parsed.nudge.attempted).toBe(false);
    expect(sendCalls(exec).length).toBe(before);
  });

  it("wakes an idle live agent exactly once on enqueue even when its monitor is fresh", async () => {
    const agentId = await spawnTestAgent(server);
    const engine = server._registeredTools["interact"]._engine;
    const idle = engine.stateMgr.updateRecord(agentId, { state: "idle" });
    engine.getRegistry().set(agentId, idle);
    writeHeartbeat(agentId, { baseDir: inboxDir });

    const before = sendCalls(exec).length;
    const result = await server._registeredTools["dispatch_to_agent"].handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const message = readInbox(agentId, { baseDir: inboxDir }).at(-1)!;
    const after = sendCalls(exec);

    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_state).toBe("alive");
    expect(parsed.nudge).toMatchObject({ attempted: true, sent: true });
    expect(after).toHaveLength(before + 1);
    expect(String(after.at(-1)?.at(-1) ?? "")).toBe(
      `[inbox] ${message.id} — reply_to: ${message.reply_to} — read ${inboxPath(agentId, { baseDir: inboxDir })}`,
    );
  });

  it("puts the resolved caller agent id in the envelope and ping reply address", async () => {
    const agentId = await spawnTestAgent(server);
    const engine = server._registeredTools["interact"]._engine;
    const target = engine.getRegistry().get(agentId)!;
    const idle = engine.stateMgr.updateRecord(agentId, { state: "idle" });
    engine.getRegistry().set(agentId, idle);
    const caller = {
      ...target,
      agent_id: "golems-caller",
      surface_id: "surface:golems",
      surface_uuid: "22222222-2222-4222-8222-222222222222",
      state: "ready",
    };
    engine.stateMgr.writeState(caller);
    engine.getRegistry().set(caller.agent_id, caller);
    writeHeartbeat(agentId, { baseDir: inboxDir });

    const before = sendCalls(exec).length;
    const result = await runWithCallerContext(
      { surfaceId: caller.surface_uuid },
      () =>
        server._registeredTools["dispatch_to_agent"].handler(
          {
            agent_id: agentId,
            task: "Reply to the sender, not your own pane",
            from: "ambiguous-human-label",
            nudge: "auto",
          },
          {} as any,
        ),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const message = readInbox(agentId, { baseDir: inboxDir }).at(-1)!;
    const after = sendCalls(exec);

    expect(parsed.ok).toBe(true);
    expect(message).toMatchObject({
      from: "ambiguous-human-label",
      reply_to: caller.agent_id,
      via: caller.surface_id,
      observed_at: expect.any(String),
    });
    expect(after).toHaveLength(before + 1);
    expect(String(after.at(-1)?.at(-1) ?? "")).toBe(
      `[inbox] ${message.id} — reply_to: ${caller.agent_id} via:${caller.surface_id} observed_at:${message.observed_at} — read ${inboxPath(agentId, { baseDir: inboxDir })}`,
    );
    expect(String(after.at(-1)?.at(-1) ?? "")).not.toContain("workspace:");
  });

  it("durably appends with the supplied sender id when caller surface is unresolved", async () => {
    const agentId = await spawnTestAgent(server);

    const result = await runWithCallerContext(
      { surfaceId: "surface:missing-caller" },
      () =>
        server._registeredTools["dispatch_to_agent"].handler(
          {
            agent_id: agentId,
            task: "Recovery message must survive stale caller state",
            from: "cmuxlayerClaude-recovery",
            nudge: "never",
          },
          {} as any,
        ),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const message = readInbox(agentId, { baseDir: inboxDir }).at(-1)!;

    expect(parsed.ok).toBe(false);
    expect(parsed.durable).toBe(true);
    expect(parsed.error_code).toBe("inbox_monitor_never_armed");
    expect(message).toMatchObject({
      from: "cmuxlayerClaude-recovery",
      reply_to: "cmuxlayerClaude-recovery",
      task: "Recovery message must survive stale caller state",
    });
    expect(message).not.toHaveProperty("via");
  });

  it("republishes a Claude idle-to-working transition without shrinking any lane", async () => {
    await server.close();
    const idleScreen = [
      "Claude Code",
      "What can I help you with?",
      "❯ ",
    ].join("\n");
    const mutableScreen = { text: idleScreen };
    const retainedSurfaces: TestSurface[] = [
      {
        id: "22222222-2222-4222-8222-222222222222",
        ref: "surface:golems",
        title: "golemsClaude",
        text: idleScreen,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        ref: "surface:voicelayer",
        title: "voicelayerClaude",
        text: idleScreen,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        ref: "surface:skill-creator",
        title: "skillCreatorClaude",
        text: idleScreen,
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        ref: "surface:cmuxlayer",
        title: "cmuxlayerClaude",
        text: idleScreen,
      },
    ];
    exec = makeExec(
      idleScreen,
      "brainlayerClaude",
      mutableScreen,
      retainedSurfaces,
      PRIMARY_SURFACE_UUID,
    );
    const outputPath = join(inboxDir, "fleet.swift");
    const publications: FleetSidebarPublication[] = [];
    const writer = new FleetSidebarPublisher({ outputPath });
    const publisher: FleetSidebarPublisherLike = {
      publish(input) {
        if ("state" in input) publications.push(input);
        writer.publish(input);
      },
      dispose() {
        writer.dispose();
      },
    };
    server = createServer(
      withTestSurfaceObserver({
        exec,
        stateDir: STATE_DIR,
        disableSpawnPreflight: true,
        inboxBaseDir: inboxDir,
        fleetSidebarPublisher: publisher,
      }),
    );
    const agentId = await spawnTestAgent(server);
    const engine = server._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const withoutTaskSummary = engine.stateMgr.updateRecord(agentId, {
      task_summary: "(unknown)",
    });
    registry.set(agentId, withoutTaskSummary);
    expect(withoutTaskSummary.surface_uuid).toBe(PRIMARY_SURFACE_UUID);
    expect(withoutTaskSummary.surface_observer_id).toBe(
      TEST_SURFACE_OBSERVER_OWNER,
    );
    const retainedSeats = [
      [
        "golems-seat",
        "surface:golems",
        "22222222-2222-4222-8222-222222222222",
        "golems",
      ],
      [
        "voicelayer-seat",
        "surface:voicelayer",
        "33333333-3333-4333-8333-333333333333",
        "voicelayer",
      ],
      [
        "skill-creator-seat",
        "surface:skill-creator",
        "44444444-4444-4444-8444-444444444444",
        "skill-creator",
      ],
      [
        "cmuxlayer-seat",
        "surface:cmuxlayer",
        "55555555-5555-4555-8555-555555555555",
        "cmuxlayer",
      ],
    ] as const;
    for (const [retainedAgentId, surfaceId, surfaceUuid, repo] of retainedSeats) {
      const record = {
        ...withoutTaskSummary,
        agent_id: retainedAgentId,
        surface_id: surfaceId,
        surface_uuid: surfaceUuid,
        surface_observer_id: TEST_SURFACE_OBSERVER_OWNER,
        repo,
        task_summary: `Retain the ${repo} lane`,
      };
      engine.stateMgr.writeState(record);
      registry.set(retainedAgentId, record);
    }
    mutableScreen.text = idleScreen;
    await engine.runSweep();

    const initialDeadline = Date.now() + 1_200;
    while (
      Date.now() < initialDeadline &&
      (!existsSync(outputPath) ||
        !readFileSync(outputPath, "utf8").includes(
          '"screenState": "idle"',
        ))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(readFileSync(outputPath, "utf8")).toContain(
      '"screenState": "idle"',
    );
    expect(readFileSync(outputPath, "utf8")).toContain("5 live seats");
    publications.length = 0;

    const workingAction = "Boondoggling";
    mutableScreen.text = [
      "✳ Boondoggling… (4m 12s · ↓ 571 tokens · thinking some more with high effort)",
      "  ⎿  Monitoring the render-polish gate",
      "🤖 Opus 4.8 (1M context) | 💰 $10.51 | ⏱️  2hr 43m",
      "⏵⏵ bypass permissions on · 2 monitors · ← for agents",
    ].join("\n");
    let releaseFirstPaint!: () => void;
    engine.startupInitializePromise = new Promise<void>((resolve) => {
      releaseFirstPaint = resolve;
    });
    writeHeartbeat(agentId, { baseDir: inboxDir });
    const runSweep = vi.spyOn(engine, "runSweep");
    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "Wake and inspect the new sidebar state",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.monitor_alive).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toContain(
      '"screenState": "idle"',
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(publications).toHaveLength(0);
    expect(readFileSync(outputPath, "utf8")).toContain(
      '"screenState": "idle"',
    );
    const secondWake = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "Coalesce this second wake behind first paint",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    expect(secondWake.structuredContent?.ok).toBe(true);
    releaseFirstPaint();

    const republishDeadline = Date.now() + 1_200;
    while (
      Date.now() < republishDeadline &&
      !readFileSync(outputPath, "utf8").includes(workingAction)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(runSweep).not.toHaveBeenCalled();
    expect(readFileSync(outputPath, "utf8")).toContain(
      '"screenState": "working"',
    );
    expect(readFileSync(outputPath, "utf8")).toContain(
      `"status": ${JSON.stringify(workingAction)}`,
    );
    const workingPublications = publications.filter(
      (publication) =>
        publication.state === "populated" &&
        publication.snapshot.lanes.some((lane) =>
          lane.seats.some((seat) => seat.status === workingAction),
        ),
    );
    expect(workingPublications).toHaveLength(1);
    expect(workingPublications[0]?.snapshot.seatCount).toBe(5);
    expect(workingPublications[0]?.observedLiveSurfaceUuids?.sort()).toEqual(
      [PRIMARY_SURFACE_UUID, ...retainedSeats.map((seat) => seat[2])].sort(),
    );
    expect(
      workingPublications[0]?.snapshot.lanes
        .flatMap((lane) => lane.seats.map((seat) => seat.surfaceUuid))
        .sort(),
    ).toEqual(
      [PRIMARY_SURFACE_UUID, ...retainedSeats.map((seat) => seat[2])].sort(),
    );
    expect(
      workingPublications[0]?.snapshot.lanes.map(({ key }) => key).sort(),
    ).toEqual(
      ["cmuxlayer", "golems", "other", "skillCreator", "voicelayer"].sort(),
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      publications.every(
        (publication) =>
          publication.state !== "populated" ||
          publication.snapshot.seatCount === 5,
      ),
    ).toBe(true);
    expect(
      publications.filter(
        (publication) =>
          publication.state === "populated" &&
          publication.snapshot.lanes.some((lane) =>
            lane.seats.some((seat) => seat.status === workingAction),
          ),
      ),
    ).toHaveLength(1);
  });

  it("keeps an unknown agent's message durable but does not report false success", async () => {
    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: "ghost-agent",
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("inbox_monitor_never_armed");
    expect(parsed.monitor_state).toBe("never-armed");
    expect(parsed.retryable).toBe(false);
    expect(parsed.nudge.attempted).toBe(false);
    expect(parsed.nudge.sent).toBe(false);
    expect(readInbox("ghost-agent", { baseDir: inboxDir })).toHaveLength(1);
  });

  it("discovers a launcher-spawned Claude permission prompt but does not type a nudge into it", async () => {
    await server.close();
    exec = makeExec(
      [
        "Do you want to allow this command?",
        "",
        "❯ 1. Allow for this session",
        "  2. Allow once",
        "  3. Deny",
        "",
        "[y/n]",
      ].join("\n"),
      "agenthtmlhostClaude",
    );
    server = createInboxServer(exec, inboxDir);

    const agentId = "auto-claude-surface-new";
    const before = sendCalls(exec).length;
    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("inbox_monitor_never_armed");
    expect(parsed.nudge.attempted).toBe(true);
    expect(parsed.nudge.sent).toBe(false);
    expect(parsed.nudge.error_code).toBe("blocked_by_permission_prompt");
    expect(sendCalls(exec).length).toBe(before);
    expect(
      readInbox(agentId, { baseDir: inboxDir }).map((m) => m.task),
    ).toContain("GO");
  });

  it("keeps the inbox message but does not nudge into a real Claude picker", async () => {
    await server.close();
    const pickerText = readFileSync(
      new URL(
        "./fixtures/painpoints/claude-ask-user-question-picker-2026-07-13.txt",
        import.meta.url,
      ),
      "utf8",
    );
    exec = makeExec(pickerText, "agenthtmlhostClaude");
    server = createInboxServer(exec, inboxDir);

    const agentId = "auto-claude-surface-new";
    const before = sendCalls(exec).length;
    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("inbox_monitor_never_armed");
    expect(parsed.nudge.attempted).toBe(true);
    expect(parsed.nudge.sent).toBe(false);
    expect(parsed.nudge.error_code).toBe("blocked_by_interactive_prompt");
    expect(parsed.nudge.reason).toContain("open picker/menu");
    expect(sendCalls(exec)).toHaveLength(before);
    expect(
      readInbox(agentId, { baseDir: inboxDir }).map((message) => message.task),
    ).toContain("GO");
  });

  it('nudge:"never" appends to the file only', async () => {
    const agentId = await spawnTestAgent(server);
    const before = sendCalls(exec).length;

    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "never",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("inbox_monitor_never_armed");
    expect(parsed.retryable).toBe(false);
    expect(parsed.nudge.attempted).toBe(false);
    expect(sendCalls(exec).length).toBe(before);
  });

  it("a failed nudge send does not lose the durable never-armed dispatch", async () => {
    const agentId = await spawnTestAgent(server);
    // Make subsequent send calls explode.
    (exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("send")) throw new Error("socket down");
        return { stdout: "{}", stderr: "" };
      },
    );

    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("inbox_monitor_never_armed");
    expect(parsed.nudge.attempted).toBe(true);
    expect(parsed.nudge.sent).toBe(false);
    expect(parsed.nudge.reason).toMatch(/socket down|failed/i);
    expect(
      readInbox(agentId, { baseDir: inboxDir }).map((m) => m.task),
    ).toContain("GO");
  });

  it("refuses to nudge a RECYCLED surface (foreign occupant) — pointer never lands in another agent's pane", async () => {
    const agentId = await spawnTestAgent(server); // cli: claude
    // Recycle the surface: it now hosts a Codex agent.
    (exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cmd: string, args: string[]) => {
        if (args.includes("list-windows")) {
          return {
            stdout: JSON.stringify({
              windows: [{ ref: "window:1", workspace_count: 1 }],
            }),
            stderr: "",
          };
        }
        if (args.includes("read-screen")) {
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text: "codex>\n gpt-5.5 xhigh · 100% context left",
              lines: 20,
              scrollback_used: false,
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
                  surface_count: 1,
                  surface_refs: ["surface:new"],
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
              surfaces: [
                {
                  ref: "surface:new",
                  title: "recycled",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ],
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
        return { stdout: "{}", stderr: "" };
      },
    );

    const before = sendCalls(exec).length;
    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    const result = await dispatchTool.handler(
      {
        agent_id: agentId,
        task: "GO",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "auto",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("inbox_monitor_never_armed");
    expect(parsed.nudge.attempted).toBe(true);
    expect(parsed.nudge.sent).toBe(false);
    expect(parsed.nudge.reason).toMatch(/recycled/i);
    // No keystrokes reached the foreign occupant.
    expect(sendCalls(exec).length).toBe(before);
    // Message still durable in the inbox file.
    expect(
      readInbox(agentId, { baseDir: inboxDir }).map((m) => m.task),
    ).toContain("GO");
  });

  it("inbox_check honors the injected inboxBaseDir", async () => {
    const dispatchTool = server._registeredTools["dispatch_to_agent"];
    await dispatchTool.handler(
      {
        agent_id: "checker",
        task: "T1",
        from: "orc",
        tag: "dispatch",
        persist: false,
        nudge: "never",
      },
      {} as any,
    );
    const checkTool = server._registeredTools["inbox_check"];
    const result = await checkTool.handler(
      {
        agent_id: "checker",
        ack_timeout_ms: 120000,
        heartbeat_max_age_ms: 60000,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.undelivered_count).toBe(1);
  });

  it("get_agent_state reports a deleted inbox channel dir distinctly from a never-armed monitor", async () => {
    const agentId = await spawnTestAgent(server);
    writeHeartbeat(agentId, { baseDir: inboxDir });
    rmSync(agentDir(agentId, { baseDir: inboxDir }), {
      recursive: true,
      force: true,
    });

    const getState = server._registeredTools["get_agent_state"];
    const result = await getState.handler({ agent_id: agentId }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.health).toMatchObject({
      status: "unhealthy",
      issue_codes: expect.arrayContaining(["inbox_channel_dir_deleted"]),
    });
    expect(parsed.health.issue_codes).not.toContain("inbox_monitor_not_alive");
  });
});

describe("report_to_parent hierarchy-bound escalation", () => {
  let inboxDir: string;
  let exec: ExecFn;
  let server: any;

  const parentUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const childUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const childTwoUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  beforeEach(() => {
    rmSync(STATE_DIR, { recursive: true, force: true });
    mkdirSync(STATE_DIR, { recursive: true });
    inboxDir = mkdtempSync(join(tmpdir(), "cmux-report-parent-"));
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
        {
          id: childTwoUuid,
          ref: "surface:child-two",
          title: "child-two-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    server = createInboxServer(exec, inboxDir);
  });

  afterEach(async () => {
    await server.close();
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
  });

  function register(...records: AgentRecord[]) {
    const engine = server._registeredTools["interact"]._engine;
    for (const record of records) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
  }

  it("routes only to the caller's registry parent and actively wakes it", async () => {
    const parent = hierarchyRecord({
      agentId: "lead-parent",
      surfaceId: "surface:new",
      surfaceUuid: parentUuid,
      parentAgentId: null,
    });
    const child = hierarchyRecord({
      agentId: "worker-child",
      surfaceId: "surface:child",
      surfaceUuid: childUuid,
      parentAgentId: parent.agent_id,
    });
    register(parent, child);

    const result = await runWithCallerContext({ surfaceId: childUuid }, () =>
      server._registeredTools.report_to_parent.handler(
        { blocker: "Blocked on the signed release fixture" },
        {} as any,
      ),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      ok: true,
      child_agent_id: child.agent_id,
      parent_agent_id: parent.agent_id,
      notified_agent_id: parent.agent_id,
      route: "direct",
      durable: true,
      delivery: "submitted",
    });
    expect(readInbox(parent.agent_id, { baseDir: inboxDir })).toHaveLength(1);
    expect(readInbox(parent.agent_id, { baseDir: inboxDir })[0]).toMatchObject({
      from: child.agent_id,
      reply_to: child.agent_id,
      to: parent.agent_id,
      tag: "parent_blocker",
      task: "Blocked on the signed release fixture",
    });
    expect(sendCalls(exec).at(-1)?.join(" ")).toContain("surface:new");
  });

  it("keeps a parent blocker durable without typing into a foreign draft", async () => {
    await server.close();
    exec = makeExec(
      "Claude Code\n❯ do not submit this existing draft",
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
    server = createInboxServer(exec, inboxDir);
    const parent = hierarchyRecord({
      agentId: "lead-parent",
      surfaceId: "surface:new",
      surfaceUuid: parentUuid,
      parentAgentId: null,
    });
    const child = hierarchyRecord({
      agentId: "worker-child",
      surfaceId: "surface:child",
      surfaceUuid: childUuid,
      parentAgentId: parent.agent_id,
    });
    register(parent, child);
    const before = sendCalls(exec).length;

    const result = await runWithCallerContext({ surfaceId: childUuid }, () =>
      server._registeredTools.report_to_parent.handler(
        { blocker: "Blocked while parent is composing" },
        {} as any,
      ),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      ok: true,
      route: "direct",
      delivery: "queued",
      durable: true,
    });
    expect(sendCalls(exec)).toHaveLength(before);
    expect(readInbox(parent.agent_id, { baseDir: inboxDir })[0]?.task).toBe(
      "Blocked while parent is composing",
    );
  });

  it("refuses a root caller with no registry parent", async () => {
    const root = hierarchyRecord({
      agentId: "orc-root",
      surfaceId: "surface:child",
      surfaceUuid: childUuid,
      parentAgentId: null,
    });
    register(root);

    const result = await runWithCallerContext({ surfaceId: childUuid }, () =>
      server._registeredTools.report_to_parent.handler(
        { blocker: "No parent exists" },
        {} as any,
      ),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      ok: false,
      error_code: "report_parent_missing",
      child_agent_id: root.agent_id,
    });
  });

  it("escalates the wake failure to the nearest reachable grandparent", async () => {
    await server.close();
    const grandparentUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    exec = makeExec(
      "Claude Code\nWhat can I help you with?\n❯ ",
      "grandparent-pane",
      undefined,
      [
        {
          id: parentUuid,
          ref: "surface:dead-parent",
          title: "dead-parent-pane",
          text: "$ ",
        },
        {
          id: childUuid,
          ref: "surface:child",
          title: "child-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      grandparentUuid,
    );
    server = createInboxServer(exec, inboxDir);
    const grandparent = hierarchyRecord({
      agentId: "orc-grandparent",
      surfaceId: "surface:new",
      surfaceUuid: grandparentUuid,
      parentAgentId: null,
    });
    const parent = hierarchyRecord({
      agentId: "dead-lead",
      surfaceId: "surface:dead-parent",
      surfaceUuid: parentUuid,
      parentAgentId: grandparent.agent_id,
      state: "error",
    });
    const child = hierarchyRecord({
      agentId: "worker-child",
      surfaceId: "surface:child",
      surfaceUuid: childUuid,
      parentAgentId: parent.agent_id,
    });
    register(grandparent, parent, child);

    const result = await runWithCallerContext({ surfaceId: childUuid }, () =>
      server._registeredTools.report_to_parent.handler(
        { blocker: "Parent pane died during release validation" },
        {} as any,
      ),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      ok: true,
      parent_agent_id: parent.agent_id,
      notified_agent_id: grandparent.agent_id,
      route: "fallback",
      durable: true,
      delivery: "submitted",
    });
    expect(readInbox(parent.agent_id, { baseDir: inboxDir })[0]?.tag).toBe(
      "parent_blocker",
    );
    expect(
      readInbox(grandparent.agent_id, { baseDir: inboxDir })[0],
    ).toMatchObject({
      tag: "parent_delivery_failed",
      task: expect.stringContaining("Parent pane died during release validation"),
    });
  });

  it("returns a loud failure when the recorded parent is unreachable", async () => {
    const child = hierarchyRecord({
      agentId: "orphaned-worker",
      surfaceId: "surface:child",
      surfaceUuid: childUuid,
      parentAgentId: "missing-parent",
    });
    register(child);

    const result = await runWithCallerContext({ surfaceId: childUuid }, () =>
      server._registeredTools.report_to_parent.handler(
        { blocker: "Cannot reach the dependency owner" },
        {} as any,
      ),
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      ok: false,
      error_code: "report_parent_unreachable",
      child_agent_id: child.agent_id,
      parent_agent_id: "missing-parent",
      durable: true,
    });
  });

  it("keeps simultaneous child escalations as distinct durable messages", async () => {
    const parent = hierarchyRecord({
      agentId: "lead-parent",
      surfaceId: "surface:new",
      surfaceUuid: parentUuid,
      parentAgentId: null,
    });
    const first = hierarchyRecord({
      agentId: "worker-one",
      surfaceId: "surface:child",
      surfaceUuid: childUuid,
      parentAgentId: parent.agent_id,
    });
    const second = hierarchyRecord({
      agentId: "worker-two",
      surfaceId: "surface:child-two",
      surfaceUuid: childTwoUuid,
      parentAgentId: parent.agent_id,
    });
    register(parent, first, second);

    const [one, two] = await Promise.all([
      runWithCallerContext({ surfaceId: childUuid }, () =>
        server._registeredTools.report_to_parent.handler(
          { blocker: "First blocker" },
          {} as any,
        ),
      ),
      runWithCallerContext({ surfaceId: childTwoUuid }, () =>
        server._registeredTools.report_to_parent.handler(
          { blocker: "Second blocker" },
          {} as any,
        ),
      ),
    ]);

    expect(one.isError).not.toBe(true);
    expect(two.isError, JSON.stringify(two.structuredContent)).not.toBe(true);
    const messages = readInbox(parent.agent_id, { baseDir: inboxDir });
    expect(messages.map((message) => message.task).sort()).toEqual([
      "First blocker",
      "Second blocker",
    ]);
    expect(new Set(messages.map((message) => message.id))).toHaveLength(2);
  });
});
