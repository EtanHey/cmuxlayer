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
 *   - agent unknown to the registry → dispatch still succeeds, nudge skipped.
 *   - nudge="never" → file append only.
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
import { agentDir, writeHeartbeat, readInbox } from "../src/inbox.js";
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
        setScreenText("Claude Code\n✻ Working\n");
        promptPending = false;
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send")) {
      const text = String(args.at(-1) ?? "");
      if (
        text.trim() &&
        !/[A-Za-z0-9_.-]+(?:Claude|Codex|Cursor|Gemini|Kiro)\b/.test(text)
      ) {
        promptPending = true;
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
  const result = await tool.handler(
    {
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      role: "ic",
      prompt: "task",
    },
    {} as any,
  );
  const parsed = result.structuredContent ?? JSON.parse(result.content[0].text);
  expect(parsed.ok).toBe(true);
  return parsed.agent_id as string;
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

  it("nudges via the agent's surface when heartbeat is absent — even in a TERMINAL state", async () => {
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
    expect(parsed.monitor_alive).toBe(false);
    expect(parsed.nudge.attempted).toBe(true);
    expect(parsed.nudge.sent).toBe(true);
    // The pointer was typed into the agent's surface despite terminal state.
    const after = sendCalls(exec);
    expect(after.length).toBeGreaterThan(before);
    const nudgeCall = after.at(-1)!;
    const nudgeText = String(nudgeCall.at(-1) ?? "");
    expect(nudgeCall.join(" ")).toContain("surface:new");
    expect(nudgeCall.join(" ")).toContain("inbox");
    expect(nudgeText).not.toMatch(/[\n\r]/);
    // And the message itself is durably in the inbox file.
    expect(
      readInbox(agentId, { baseDir: inboxDir }).map((m) => m.task),
    ).toContain("GO");
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
    expect(parsed.nudge.attempted).toBe(false);
    expect(sendCalls(exec).length).toBe(before);
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

  it("dispatch still succeeds for an agent unknown to the registry (nudge skipped, not failed)", async () => {
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

    expect(parsed.ok).toBe(true);
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

    expect(parsed.ok).toBe(true);
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

    expect(parsed.ok).toBe(true);
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

    expect(parsed.ok).toBe(true);
    expect(parsed.nudge.attempted).toBe(false);
    expect(sendCalls(exec).length).toBe(before);
  });

  it("a failed nudge send never fails the dispatch (file append is the contract)", async () => {
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

    expect(parsed.ok).toBe(true);
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

    expect(parsed.ok).toBe(true);
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
