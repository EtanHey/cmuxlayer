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
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server.js";
import {
  agentDir,
  writeHeartbeat,
  readInbox,
} from "../src/inbox.js";
import type { ExecFn } from "../src/cmux-client.js";
import { withFakeRightSplitTopology } from "./helpers/fake-right-split-topology.js";
import {
  withTestSurfaceObserver,
} from "./helpers/test-surface-observer.js";
import { runWithCallerContext } from "../src/caller-context.js";
import { bootContractPointer, coordinationContractPath } from "../src/coordination-paths.js";
import type { AgentRecord } from "../src/agent-types.js";
import { engineForTests } from "../src/server.js";
import { agentStateTool } from "./helpers/mcp-tool-harness.js";

const STATE_DIR = join(tmpdir(), "cmux-agents-test-inbox-nudge");

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
  return withFakeRightSplitTopology(vi.fn().mockImplementation(async (_cmd, args) => {
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
  }));
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

describe("inbox channel health", () => {
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

  it("get_agent_state reports a deleted inbox channel dir distinctly from a never-armed monitor", async () => {
    const agentId = await spawnTestAgent(server);
    writeHeartbeat(agentId, { baseDir: inboxDir });
    rmSync(agentDir(agentId, { baseDir: inboxDir }), {
      recursive: true,
      force: true,
    });

    const getState = agentStateTool(server);
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
    const engine = engineForTests(server);
    for (const record of records) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
  }

  it.each(["agent", "surface", "command", "key", "report"])("#636 D3 refuses worker-to-parent %s with its collab path", async (mode) => {
    const parent = hierarchyRecord({ agentId: "lead-parent", surfaceId: "surface:new", surfaceUuid: parentUuid, parentAgentId: null });
    const child = { ...hierarchyRecord({ agentId: "worker-child", surfaceId: "surface:child", surfaceUuid: childUuid, parentAgentId: parent.agent_id }), collab_path: join(inboxDir, "collab.md") };
    register(parent, child);
    const before = sendCalls(exec).length;
    const tool = mode === "report" ? "report_to_parent" : "send_to";
    const args = mode === "report" ? { blocker: "blocked" } : { mode, ...(mode === "agent" ? { agent_id: parent.agent_id } : { surface: parent.surface_id }), text: mode === "key" ? "return" : "blocked" };
    const result = await runWithCallerContext({ surfaceId: childUuid }, () => server._registeredTools[tool].handler(args, {}));
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(data.error).toContain(child.collab_path);
    expect(sendCalls(exec)).toHaveLength(before);
    expect(readInbox(parent.agent_id, { baseDir: inboxDir })).toHaveLength(0);
  });

  it("#636 D3 also refuses a worker addressing an ancestor lead", async () => {
    const root = hierarchyRecord({ agentId: "root", surfaceId: "surface:new", surfaceUuid: parentUuid, parentAgentId: null });
    const parent = { ...hierarchyRecord({ agentId: "lead", surfaceId: "surface:child-two", surfaceUuid: childTwoUuid, parentAgentId: root.agent_id }), role: "orchestrator" as const };
    const child = { ...hierarchyRecord({ agentId: "worker", surfaceId: "surface:child", surfaceUuid: childUuid, parentAgentId: parent.agent_id }), collab_path: join(inboxDir, "collab.md") };
    register(root, parent, child);
    const result = await runWithCallerContext({ surfaceId: childUuid }, () => server._registeredTools.send_to.handler({ mode: "agent", agent_id: root.agent_id, text: "blocked" }, {}));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(child.collab_path);
  });

  it.each(["lead-to-worker", "orc-to-lead", "peer-leads", "lead-to-parent", "unknown-caller"])("#636 D3 preserves %s delivery with collab paths", async (direction) => {
    const parent = { ...hierarchyRecord({ agentId: "parent", surfaceId: "surface:new", surfaceUuid: parentUuid, parentAgentId: null }), collab_path: join(inboxDir, "collab.md") };
    const child = { ...hierarchyRecord({ agentId: "child", surfaceId: "surface:child", surfaceUuid: childUuid, parentAgentId: parent.agent_id }), role: direction === "lead-to-worker" ? "worker" as const : "orchestrator" as const, collab_path: parent.collab_path };
    if (direction === "peer-leads") child.parent_agent_id = null;
    const caller = direction === "lead-to-parent" ? childUuid : direction === "unknown-caller" ? undefined : parentUuid;
    const target = direction === "lead-to-parent" ? parent.agent_id : child.agent_id;
    register(parent, child);
    const result = await runWithCallerContext({ surfaceId: caller }, () => server._registeredTools.send_to.handler({ mode: "agent", agent_id: target, text: "hello" }, {}));
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(sendCalls(exec).length).toBeGreaterThan(0);
  });

  it("#636 D3 preserves engine halt escalation with a worker collab channel", async () => {
    const parent = hierarchyRecord({ agentId: "parent", surfaceId: "surface:new", surfaceUuid: parentUuid, parentAgentId: null });
    const child = { ...hierarchyRecord({ agentId: "worker", surfaceId: "surface:child", surfaceUuid: childUuid, parentAgentId: parent.agent_id, state: "working" }), collab_path: join(inboxDir, "collab.md"), halt_escalation: true };
    register(parent, child);
    const engine = engineForTests(server);
    await server._registeredTools.list_agents.handler({}, {});
    const episode = await runWithCallerContext({ surfaceId: childUuid }, () => engine.maybeEscalateLiveHalt(child, 'Claude Code\nAPI Error: 500 {"request_id":"req_636halt"}\n❯'));
    expect(readInbox(parent.agent_id, { baseDir: inboxDir }).some(message => message.tag === "agent_halt_harness_api_error"), JSON.stringify(episode)).toBe(true);
    expect(episode.halt_notified_ancestor_id).toBe(parent.agent_id);
    expect(episode.halt_last_delivery_error).toBeNull();
  });

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
    const engine = engineForTests(server);
    expect(engine.getDeliveryReceipt(parsed.delivery_id)).toMatchObject({
      delivery_state: "submitted",
      source_event: "report_to_parent",
      rpc_methods: [],
      typed: true,
      submit_dispatched: true,
    });
  });

  it("validates G2-G8 recovery receipts with the SDK declared output schemas", async () => {
    await server.close();
    const screen = { text: "Claude Code\n❯ " };
    const baseExec = makeExec(screen.text, "parent-pane", screen,
      [{ id: childUuid, ref: "surface:child", title: "child-pane", text: "Claude Code\n❯ " }], parentUuid);
    exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (args.includes("send-key") && args.includes("return")) throw new Error("lost ack");
      return baseExec(cmd, args);
    });
    server = createInboxServer(exec, inboxDir);
    const parent = { ...hierarchyRecord({ agentId: "lead-parent", surfaceId: "surface:new",
      surfaceUuid: parentUuid, parentAgentId: null }), boot_prompt_pending: true,
      prompt_delivered: false, submit_verified: null };
    const child = hierarchyRecord({ agentId: "worker-child", surfaceId: "surface:child", surfaceUuid: childUuid, parentAgentId: parent.agent_id });
    register(parent, child);
    screen.text = `Claude Code\nWorking\n❯ ${bootContractPointer(parent.agent_id,
      coordinationContractPath(parent.agent_id, { baseDir: inboxDir }))}`;
    const tool = server._registeredTools.report_to_parent;
    const result = await runWithCallerContext({ surfaceId: childUuid }, () =>
      tool.handler({ blocker: "Boot receipt needs verification" }, {}));
    expect(result.structuredContent).toMatchObject({ ok: true, delivery: "pending_verify",
      delivery_id: expect.any(String), route: "direct", durable: true });
    expect((exec as ReturnType<typeof vi.fn>).mock.calls.filter(([, args]: [string, string[]]) => args.includes("send-key") && args.includes("return"))).toHaveLength(1);
    expect(engineForTests(server).getDeliveryReceipt(result.structuredContent?.delivery_id))
      .toMatchObject({ boot_recovery: true, delivery_state: "pending_verify" });
    await expect(server.validateToolOutput(tool, result, "report_to_parent")).resolves.toBeUndefined();
    const pending = { delivery_id: "receipt-1", delivery_state: "pending_verify",
      submit_verified: null, boot_recovery: true, boot_instance_id: "boot-1" };
    const base = { ok: true, retry_count: 0 };
    const cases = [
      ["send_to", { ...base, delivery: "pending_verify", ...pending, boot_prompt_receipt: pending }],
      ["spawn_agent", { ...base, spawn_state: "boot_unsubmitted", boot_prompt_receipt: pending }],
      ["wait_for", { ...base, ...pending }],
    ] as const;
    for (const [name, structuredContent] of cases) {
      const candidate = server._registeredTools[name];
      expect(candidate.outputSchema, name).toBeDefined();
      await expect(server.validateToolOutput(candidate,
        { content: [{ type: "text", text: name }], structuredContent }, name)).resolves.toBeUndefined();
    }
    // The SDK bypasses output validation for error results.
    await expect(server.validateToolOutput(server._registeredTools.send_to,
      { isError: true, content: [], structuredContent: { ok: false, retry_count: 0,
        error_code: "owned_boot_contract_pending", ...pending } }, "send_to")).resolves.toBeUndefined();
  }, 15_000);

  it("keeps a parent blocker durable and escalates past a foreign draft", async () => {
    await server.close();
    const grandparentUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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
        {
          id: grandparentUuid,
          ref: "surface:grandparent",
          title: "grandparent-pane",
          text: "Claude Code\nWhat can I help you with?\n❯ ",
        },
      ],
      parentUuid,
    );
    server = createInboxServer(exec, inboxDir);
    const grandparent = hierarchyRecord({
      agentId: "orc-grandparent",
      surfaceId: "surface:grandparent",
      surfaceUuid: grandparentUuid,
      parentAgentId: null,
    });
    const parent = hierarchyRecord({
      agentId: "lead-parent",
      surfaceId: "surface:new",
      surfaceUuid: parentUuid,
      parentAgentId: grandparent.agent_id,
    });
    const child = hierarchyRecord({
      agentId: "worker-child",
      surfaceId: "surface:child",
      surfaceUuid: childUuid,
      parentAgentId: parent.agent_id,
    });
    register(grandparent, parent, child);
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
      route: "fallback",
      notified_agent_id: grandparent.agent_id,
      delivery: "submitted",
      durable: true,
    });
    expect(sendCalls(exec)).toHaveLength(before + 1);
    expect(readInbox(parent.agent_id, { baseDir: inboxDir })[0]?.task).toBe(
      "Blocked while parent is composing",
    );
    expect(
      readInbox(grandparent.agent_id, { baseDir: inboxDir })[0],
    ).toMatchObject({
      tag: "parent_delivery_failed",
      task: expect.stringContaining("Blocked while parent is composing"),
    });
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
