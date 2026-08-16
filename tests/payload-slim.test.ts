/**
 * #424 payload slim — response title must be the real tab title.
 * TDD: fails until send path stops echoing task_summary/boot prompt as title
 * and reports the same surface title list_surfaces already returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createServer,
  createServerContext,
  type CmuxServerContext,
  type CreateServerOptions,
} from "../src/server.js";
import { StateManager } from "../src/state-manager.js";
import type { AgentRecord } from "../src/agent-types.js";
import {
  bootPromptRegistryFields,
  resolveBootPromptText,
  summarizeTaskSummary,
} from "../src/agent-types.js";
import {
  currentCallerContext,
  runWithCallerContext,
} from "../src/caller-context.js";

const TEST_DIR = join(tmpdir(), `cmux-payload-slim-${process.pid}`);
const REAL_TAB_TITLE = "cmuxlayerClaude [surface:82]";
const BOOT_PROMPT = [
  "# Lane: CURSOR RESUME — wrong flag, and it types a broken command into a live agent",
  "",
  "Reported by brainlayerClaude from Etan's screen, verified in code and against the live CLI.",
  "",
  "## Defect 1 — the flag is wrong",
  "Full brief body that must never come back on send_to.",
].join("\n");

const serverContexts: CmuxServerContext[] = [];

function createTrackedServer(opts: Omit<CreateServerOptions, "context">) {
  const context = createServerContext({
    ...opts,
    sessionIdentityResolver: opts.sessionIdentityResolver ?? (() => null),
    surfaceObserverOwnerIdProvider:
      opts.surfaceObserverOwnerIdProvider ??
      (() => "cmux:/tmp/cmuxlayer-payload-slim.sock"),
    surfaceObserverEpochProvider:
      opts.surfaceObserverEpochProvider ??
      (() => "cmux:/tmp/cmuxlayer-payload-slim.sock@test"),
  });
  serverContexts.push(context);
  const server = createServer({ ...opts, context });
  const sendTo = (server as any)._registeredTools?.send_to;
  if (sendTo?.handler) {
    const handler = sendTo.handler.bind(sendTo);
    sendTo.handler = (...handlerArgs: any[]) =>
      currentCallerContext()
        ? handler(...handlerArgs)
        : runWithCallerContext({ workspaceId: "workspace:1" }, () =>
            handler(...handlerArgs),
          );
  }
  return server;
}

function makeSurfaceClient(title: string) {
  const surface = {
    ref: "surface:82",
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    workspace_ref: "workspace:1",
    title,
  };
  return {
    currentSocketPath: vi.fn(() => "/tmp/cmuxlayer-payload-slim.sock"),
    currentObserverTransportEpoch: vi.fn(() => "test"),
    listWorkspaces: vi.fn().mockResolvedValue({
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
    listPanes: vi.fn().mockResolvedValue({
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      panes: [
        {
          ref: "pane:1",
          index: 0,
          focused: true,
          surface_count: 1,
          surface_refs: [surface.ref],
          surface_ids: [surface.id],
          selected_surface_ref: surface.ref,
        },
      ],
    }),
    listPaneSurfaces: vi.fn().mockResolvedValue({
      workspace_ref: "workspace:1",
      window_ref: "window:1",
      pane_ref: "pane:1",
      surfaces: [
        {
          ...surface,
          type: "terminal",
          index: 0,
          selected: true,
          pane_ref: "pane:1",
        },
      ],
    }),
    readScreen: vi.fn().mockResolvedValue({
      surface: surface.ref,
      text: "claude> ",
      lines: 20,
      scrollback_used: false,
    }),
    send: vi.fn().mockResolvedValue(undefined),
    pasteText: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    newSplit: vi.fn(),
    newSurface: vi.fn(),
    selectWorkspace: vi.fn(),
    closeSurface: vi.fn(),
    notify: vi.fn(),
    listStatus: vi.fn().mockResolvedValue([]),
    identify: vi.fn().mockResolvedValue({}),
  };
}

function seedBriefedAgent(stateDir: string): AgentRecord {
  const fields = bootPromptRegistryFields(BOOT_PROMPT, "/tmp/brief.md");
  const record: AgentRecord = {
    agent_id: "cmuxlayerClaude-briefed",
    surface_id: "surface:82",
    surface_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    surface_observer_id: "cmux:/tmp/cmuxlayer-payload-slim.sock",
    workspace_id: "workspace:1",
    state: "idle",
    repo: "cmuxlayer",
    model: "claude-opus-5",
    cli: "claude",
    cli_session_id: null,
    ...fields,
    pid: null,
    version: 1,
    created_at: "2026-08-16T00:00:00Z",
    updated_at: "2026-08-16T00:00:00Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "orchestrator",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    boot_prompt_pending: false,
  };
  new StateManager(stateDir).writeState(record);
  return record;
}

describe("payload slim #424", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await Promise.allSettled(
      serverContexts.map(
        (context) => context.lifecycleStartPromise ?? Promise.resolve(),
      ),
    );
    for (const context of serverContexts.splice(0)) {
      context.dispose();
    }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("summarizeTaskSummary prefers boot_prompt_path basename and preserves full text separately", () => {
    expect(summarizeTaskSummary(BOOT_PROMPT, "/tmp/docs/brief.md")).toBe(
      "brief.md",
    );
    expect(summarizeTaskSummary(BOOT_PROMPT)).toBe(
      "# Lane: CURSOR RESUME — wrong flag, and it types a broken command into a live a…",
    );
    const fields = bootPromptRegistryFields(BOOT_PROMPT, "/tmp/brief.md");
    expect(fields.task_summary).toBe("brief.md");
    expect(fields.boot_prompt_text).toBe(BOOT_PROMPT);
    expect(resolveBootPromptText(fields)).toBe(BOOT_PROMPT);
    expect(resolveBootPromptText({ task_summary: BOOT_PROMPT })).toBe(
      BOOT_PROMPT,
    );
  });

  it("send_to title equals list_surfaces title and never echoes the boot prompt", async () => {
    const client = makeSurfaceClient(REAL_TAB_TITLE);
    seedBriefedAgent(TEST_DIR);
    const server = createTrackedServer({
      client: client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts[serverContexts.length - 1]?.lifecycleStartPromise;

    const listSurfaces = (server as any)._registeredTools["list_surfaces"];
    const listed = await listSurfaces.handler({}, {} as any);
    const listedData =
      listed.structuredContent ?? JSON.parse(listed.content[0].text);
    const listedSurface = (
      listedData.surfaces as Array<Record<string, unknown>>
    ).find((surface) => surface.ref === "surface:82");
    expect(listedSurface?.title).toBe(REAL_TAB_TITLE);

    const sendTo = (server as any)._registeredTools["send_to"];
    const result = await sendTo.handler(
      {
        mode: "surface",
        target: "surface:82",
        text: "ping",
        press_enter: false,
      },
      {} as any,
    );
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    const serialized = JSON.stringify({
      data,
      text: result.content?.[0]?.text ?? "",
    });

    expect(result.isError).not.toBe(true);
    expect(data.title).toBe(listedSurface?.title);
    expect(data.title).toBe(REAL_TAB_TITLE);
    expect(serialized).not.toContain(BOOT_PROMPT);
    expect(serialized).not.toContain("Defect 1 — the flag is wrong");
  });

  it("list_agents summary omits health and includes send_via", async () => {
    const client = makeSurfaceClient(REAL_TAB_TITLE);
    seedBriefedAgent(TEST_DIR);
    const server = createTrackedServer({
      client: client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts[serverContexts.length - 1]?.lifecycleStartPromise;

    const list = (server as any)._registeredTools["list_agents"];
    const summary = await list.handler({}, {} as any);
    const summaryData =
      summary.structuredContent ?? JSON.parse(summary.content[0].text);
    expect(summaryData.agents[0].agent_id).toBe("cmuxlayerClaude-briefed");
    expect(summaryData.agents[0].surface_id).toBe("surface:82");
    expect(summaryData.agents[0].send_via).toBe("send_to");
    expect(summaryData.agents[0].health).toBeUndefined();
    expect(JSON.stringify(summaryData)).not.toContain(BOOT_PROMPT);

    const full = await list.handler({ detail: "full" }, {} as any);
    const fullData = full.structuredContent ?? JSON.parse(full.content[0].text);
    expect(fullData.agents[0].health).toBeDefined();
    expect(fullData.agents[0].detail.boot_prompt_text).toBe(BOOT_PROMPT);
    expect(fullData.agents[0].detail.task_summary).toBe("brief.md");
  });
});
