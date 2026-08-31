/**
 * Integration tests for the agent lifecycle MCP tools registered in server.ts.
 * Tests tool registration and handler dispatch with mocked cmux client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useHarnessHome } from "./helpers/harness-home.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  createServer,
  createServerContext,
  reconcileAgentLiveState,
  SEND_INPUT_MAX_INLINE_CHARS,
  type CmuxServerContext,
  type CreateServerOptions,
} from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import { generateAgentId, type AgentRecord } from "../src/agent-types.js";
import type { ParsedScreenResult } from "../src/types.js";
import type { SeatManifest } from "../src/seat-manifest.js";
import { AgentRegistry } from "../src/agent-registry.js";
import {
  coordinationContractPath,
  issueCoordinationContract,
} from "../src/coordination-paths.js";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import {
  reconcileMonitorRegistry,
  registerMonitor,
} from "../src/monitor-registry.js";
import { SurfaceWriteLivenessTracker } from "../src/surface-write-liveness.js";
import { makeCodexRolloutFillProvider } from "../src/codex-rollout-fill.js";
import type { CodexRolloutFill } from "../src/codex-rollout-fill.js";
import { readInbox } from "../src/inbox.js";
import {
  currentCallerContext,
  runWithCallerContext,
} from "../src/caller-context.js";
import { MODEL_OVERRIDE_ENV } from "../src/model-policy.js";
import {
  armWatch,
  readWatchRegistry,
  sweepWatches,
} from "../src/watch-spec.js";

let TEST_DIR = join(tmpdir(), "cmux-agents-test-server-tools");
const serverContexts: CmuxServerContext[] = [];

// #482/#492: `resumable` now asks whether the transcript is on disk, so these
// tests own a throwaway harness home and put the sessions they claim into it.
const harnessHome = useHarnessHome();
const FIXTURE_SESSIONS = [
  "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
  "019ec0e6-1111-2222-3333-444455556666",
];
beforeEach(() => {
  for (const session of FIXTURE_SESSIONS) {
    for (const cli of ["claude", "codex", "cursor"] as const) {
      harnessHome.give(cli, session);
    }
  }
});
const hermeticSpawnStateDirs: string[] = [];
let hermeticSpawnFixtureSequence = 0;
const originalLauncherRegistryPath =
  process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
const originalAllowModel = process.env.REPOGOLEM_ALLOW_MODEL;

afterEach(async () => {
  if (originalLauncherRegistryPath === undefined) {
    delete process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
  } else {
    process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = originalLauncherRegistryPath;
  }
  if (originalAllowModel === undefined) {
    delete process.env.REPOGOLEM_ALLOW_MODEL;
  } else {
    process.env.REPOGOLEM_ALLOW_MODEL = originalAllowModel;
  }
  await Promise.allSettled(
    serverContexts.map(
      (context) => context.lifecycleStartPromise ?? Promise.resolve(),
    ),
  );
  for (const context of serverContexts.splice(0)) {
    context.dispose();
  }
  for (const stateDir of hermeticSpawnStateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

const AGENT_TOOLS = [
  "spawn_agent",
  "new_worktree_split",
  "spawn_in_workspace",
  "resync_agents",
  "send_to",
  "supersede_agent_goal",
  "wait_for",
  "wait_for_all",
  "get_agent_state",
  "list_agents",
  "broadcast",
  "stop_agent",
  "send_to_agent",
  "read_agent_output",
  "my_agents",
] as const;

function makeLifecycleExec(opts?: {
  closeKeepsSurface?: boolean;
  createdWorkspace?: string;
  shellPrompt?: string;
  shellNeverReady?: boolean;
  surfaceUuid?: string;
}): ExecFn {
  let readyText = "What can I help you with?\n>";
  let surfaceLive = true;
  let promptPending = false;
  let pendingText = "";
  let activeCli: "claude" | "codex" | "cursor" = "claude";
  let createdSurfaceCount = 0;
  let currentSurface = "surface:new";
  const listedSurface = () =>
    surfaceLive
      ? {
          paneRef: "pane:1",
          surfaceRef: currentSurface,
          title: "agent-pane",
        }
      : {
          paneRef: "pane:witness",
          surfaceRef: "surface:post-close-witness",
          title: "witness-pane",
        };
  const workingText = () => {
    if (activeCli === "codex") {
      return "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)";
    }
    if (activeCli === "cursor") {
      return "Cursor Agent\nWorking (1s • esc to interrupt)\ncursor> ";
    }
    return "Claude Code\n✻ Working\n❯";
  };
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("new-split") || args.includes("new-surface")) {
      surfaceLive = true;
      createdSurfaceCount += 1;
      currentSurface =
        createdSurfaceCount === 1
          ? "surface:new"
          : `surface:new-${createdSurfaceCount}`;
      readyText = opts?.shellPrompt ?? "$ ";
      promptPending = false;
    }
    if (args.includes("close-surface") && !opts?.closeKeepsSurface) {
      surfaceLive = false;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send-key") && args.includes("return")) {
      if (promptPending) {
        readyText =
          activeCli === "codex"
            ? `${pendingText}\n${workingText()}`
            : activeCli === "cursor"
              ? `Cursor Agent\n${pendingText}\nWorking (1s • esc to interrupt)\ncursor> `
              : workingText();
        promptPending = false;
        pendingText = "";
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send") || args.includes("set-buffer")) {
      const text = String(args[args.length - 1] ?? "");
      if (text.includes("Codex")) {
        activeCli = "codex";
        readyText = "codex> ";
      }
      if (text.includes("Claude")) {
        activeCli = "claude";
        readyText = "Claude Code\nWhat can I help you with?\n>";
      }
      if (text.includes("Cursor")) {
        activeCli = "cursor";
        readyText = "cursor> ";
      }
      if (
        text.trim() &&
        !/^\s*(?:[A-Z_]+=\S+\s+)*[A-Za-z0-9_.-]+(?:Claude|Codex|Cursor|Gemini|Kiro)\b.*(?:^|\s)-s(?:\s|$)/.test(
          text,
        )
      ) {
        promptPending = true;
        pendingText = text;
        if (activeCli === "codex") {
          readyText = [
            ">_ OpenAI Codex",
            `› ${text}`,
            "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer",
          ].join("\n");
        } else if (activeCli === "cursor") {
          readyText = `Cursor Agent\ncursor> ${text}\nAuto`;
        } else {
          readyText = `Claude Code\n❯ ${text}`;
        }
      }
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

    if (args.includes("list-windows")) {
      return {
        stdout: JSON.stringify({
          windows: [{ ref: "window:1", workspace_count: 1 }],
        }),
        stderr: "",
      };
    }

    if (args.includes("list-panes")) {
      const listed = listedSurface();
      return {
        stdout: JSON.stringify({
          workspace_ref: "workspace:1",
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
          workspace_ref: "workspace:1",
          window_ref: "window:1",
          pane_ref: listed.paneRef,
          surfaces: [
            {
              ...(opts?.surfaceUuid ? { id: opts.surfaceUuid } : {}),
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
          surface: currentSurface,
          text: opts?.shellNeverReady ? "terminal initializing" : readyText,
          lines: 20,
          scrollback_used: false,
        }),
        stderr: "",
      };
    }

    const workspaceIndex = args.indexOf("--workspace");
    const workspace =
      opts?.createdWorkspace ??
      (workspaceIndex >= 0 ? String(args[workspaceIndex + 1]) : "ws:1");
    return {
      stdout: JSON.stringify({
        workspace,
        surface: currentSurface,
        ...(opts?.surfaceUuid ? { surface_id: opts.surfaceUuid } : {}),
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

function createTrackedServer(
  opts: Omit<CreateServerOptions, "context">,
  defaultCallerContext = true,
) {
  const testObserverOwnerId = (): string | null => {
    const currentSocketPath = (
      opts.client as { currentSocketPath?: () => string | null } | undefined
    )?.currentSocketPath;
    if (typeof currentSocketPath === "function") {
      const socketPath = currentSocketPath.call(opts.client)?.trim();
      return socketPath ? `cmux:${socketPath}` : null;
    }
    return "cmux:/tmp/cmuxlayer-test.sock";
  };
  const normalizedOpts: Omit<CreateServerOptions, "context"> = {
    ...opts,
    sessionIdentityResolver: opts.sessionIdentityResolver ?? (() => null),
    surfaceObserverOwnerIdProvider:
      opts.surfaceObserverOwnerIdProvider ?? testObserverOwnerId,
    surfaceObserverEpochProvider:
      opts.surfaceObserverEpochProvider ??
      (() => {
        const ownerId = testObserverOwnerId();
        if (!ownerId) return null;
        const transportEpoch = (
          opts.client as
            | {
                currentObserverTransportEpoch?: () => string | null;
              }
            | undefined
        )?.currentObserverTransportEpoch?.();
        return `${ownerId}@${transportEpoch || "test"}`;
      }),
  };
  const context = createServerContext(normalizedOpts);
  serverContexts.push(context);
  const server = createServer({ ...normalizedOpts, context });
  const sendToTool = (server as any)._registeredTools?.send_to;
  if (sendToTool?.handler) {
    const sendToHandler = sendToTool.handler.bind(sendToTool);
    sendToTool.handler = (args: Record<string, unknown>, toolContext: unknown) =>
      sendToHandler({ mode: "agent", ...args }, toolContext);
  }
  if (defaultCallerContext) {
    const registeredTools = (server as any)._registeredTools as Record<
      string,
      { handler?: (...handlerArgs: any[]) => any }
    >;
    for (const toolName of [
      "spawn_agent",
      "new_worktree_split",
      "spawn_in_workspace",
      "new_split",
    ]) {
      const tool = registeredTools?.[toolName];
      if (!tool?.handler) continue;
      const handler = tool.handler.bind(tool);
      tool.handler = (...handlerArgs: any[]) =>
        currentCallerContext()
          ? handler(...handlerArgs)
          : runWithCallerContext({ workspaceId: "workspace:1" }, () =>
              handler(...handlerArgs),
            );
    }
  }
  return server;
}

function createLifecycleServer(exec: ExecFn) {
  return createTrackedServer({
    exec,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    sessionIdentityResolver: () => null,
  });
}

function createInMemoryStateManager(
  baseDir = "/in-memory/spawn-manifest",
): StateManager {
  const records = new Map<string, AgentRecord>();
  const eventLog = {
    append: vi.fn(),
    appendDelivery: vi.fn(),
    appendControlHealth: vi.fn(),
    appendClose: vi.fn(),
    appendCloseForensics: vi.fn(),
    readAll: vi.fn(() => []),
    readEntries: vi.fn(() => []),
    readForAgent: vi.fn(() => []),
    readCloseEvents: vi.fn(() => []),
  } as unknown as ReturnType<StateManager["getEventLog"]>;
  const surfaceSessionIndex = {
    persist: vi.fn(),
    persistRecord: vi.fn(() => null),
    removeAgent: vi.fn(),
    lookup: vi.fn(() => null),
  } as unknown as ReturnType<StateManager["getSurfaceSessionIndex"]>;
  const readRecord = (agentId: string): AgentRecord | null => {
    const record = records.get(agentId);
    return record ? { ...record } : null;
  };
  const requireRecord = (agentId: string): AgentRecord => {
    const record = readRecord(agentId);
    if (!record) throw new Error(`Agent not found: ${agentId}`);
    return record;
  };
  const updateRecord = (
    agentId: string,
    fields: Partial<AgentRecord>,
  ): AgentRecord => {
    const current = requireRecord(agentId);
    const updated: AgentRecord = {
      ...current,
      ...fields,
      agent_id: current.agent_id,
      created_at: current.created_at,
      version: current.version + 1,
      updated_at: new Date().toISOString(),
    };
    records.set(agentId, updated);
    return { ...updated };
  };

  return {
    getBaseDir: () => baseDir,
    getEventLog: () => eventLog,
    getSurfaceSessionIndex: () => surfaceSessionIndex,
    writeState: (record) => {
      records.set(record.agent_id, { ...record });
    },
    readState: readRecord,
    hasStateFile: (agentId) => records.has(agentId),
    transition: (agentId, toState, extra) =>
      updateRecord(agentId, { state: toState, ...extra }),
    updateRecord,
    resetState: (agentId, toState, fields) =>
      updateRecord(agentId, { ...fields, state: toState }),
    renameState: (agentId, newAgentId) => {
      const current = requireRecord(agentId);
      if (agentId !== newAgentId && records.has(newAgentId)) {
        throw new Error(`Agent already exists: ${newAgentId}`);
      }
      records.delete(agentId);
      const renamed: AgentRecord = {
        ...current,
        agent_id: newAgentId,
        version: current.version + 1,
        updated_at: new Date().toISOString(),
      };
      records.set(newAgentId, renamed);
      for (const child of records.values()) {
        if (child.parent_agent_id === agentId) {
          records.set(child.agent_id, {
            ...child,
            parent_agent_id: newAgentId,
            version: child.version + 1,
            updated_at: new Date().toISOString(),
          });
        }
      }
      return { ...renamed };
    },
    listStates: () => [...records.values()].map((record) => ({ ...record })),
    removeState: (agentId) => {
      records.delete(agentId);
    },
  } as unknown as StateManager;
}

function createHermeticSpawnServer(
  opts: Omit<CreateServerOptions, "context" | "stateDir">,
) {
  const stateDir = join(
    tmpdir(),
    `cmuxlayer-spawn-hermetic-${process.pid}-${hermeticSpawnFixtureSequence++}`,
  );
  rmSync(stateDir, { recursive: true, force: true });
  hermeticSpawnStateDirs.push(stateDir);

  const stateManager = createInMemoryStateManager(stateDir);
  const lifecycleSurfaceProvider = vi.fn(async () => {
    throw new Error("Hermetic spawn fixture attempted registry surface I/O");
  });
  const lifecycleRegistry = new AgentRegistry(
    stateManager,
    lifecycleSurfaceProvider,
  );
  vi.spyOn(
    lifecycleRegistry,
    "refreshManagedSurfaceMetadata",
  ).mockImplementation(async (_discovery, refreshOpts) =>
    refreshOpts?.agentId ? lifecycleRegistry.get(refreshOpts.agentId) : null,
  );
  const lifecycleInitializer = vi.fn(async () => {});
  const serverOptions = {
    ...opts,
    stateDir,
    stateManager,
    lifecycleRegistry,
    lifecycleInitializer,
  } as Omit<CreateServerOptions, "context">;
  const server = createTrackedServer(serverOptions);

  return {
    server,
    context: serverContexts.at(-1)!,
    stateDir,
    lifecycleInitializer,
    lifecycleSurfaceProvider,
  };
}

describe("lifecycle dependency seams", () => {
  it("uses the injected state manager as the state directory authority", () => {
    const stateManager = createInMemoryStateManager();
    const context = createServerContext({
      stateDir: "/conflicting/spawn-manifest-state",
      stateManager,
    });

    try {
      expect(context.stateDir).toBe(stateManager.getBaseDir());
    } finally {
      context.dispose();
    }
  });

  it("prefers a per-server lifecycle initializer for a shared context", async () => {
    const stateManager = createInMemoryStateManager();
    const lifecycleSurfaceProvider = vi.fn(async () => {
      throw new Error("Shared-context seam attempted lifecycle surface I/O");
    });
    const lifecycleRegistry = new AgentRegistry(
      stateManager,
      lifecycleSurfaceProvider,
    );
    const contextInitializer = vi.fn(async () => {});
    const serverInitializer = vi.fn(async () => {});
    const context = createServerContext({
      exec: makeLifecycleExec(),
      stateManager,
      lifecycleRegistry,
      lifecycleInitializer: contextInitializer,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    serverContexts.push(context);

    createServer({ context, lifecycleInitializer: serverInitializer });
    await context.lifecycleStartPromise;

    expect(serverInitializer).toHaveBeenCalledTimes(1);
    expect(contextInitializer).not.toHaveBeenCalled();
    expect(lifecycleSurfaceProvider).not.toHaveBeenCalled();
  });

  it("captures synchronous injected lifecycle initializer failures", async () => {
    const stateManager = createInMemoryStateManager();
    const lifecycleRegistry = new AgentRegistry(stateManager, async () => []);
    const initializationError = new Error("synchronous lifecycle failure");
    const lifecycleInitializer = vi.fn((): Promise<void> => {
      throw initializationError;
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() =>
        createTrackedServer({
          exec: makeLifecycleExec(),
          stateManager,
          lifecycleRegistry,
          lifecycleInitializer,
          disableSpawnPreflight: true,
          sessionIdentityResolver: () => null,
        }),
      ).not.toThrow();

      const context = serverContexts.at(-1)!;
      await context.lifecycleStartPromise;
      expect(context.lifecycleStartError).toBe(initializationError);
      expect(lifecycleInitializer).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        "[cmuxlayer] lifecycle initialization failed:",
        initializationError,
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe("lean spawn tool responses", () => {
  it.each([
    ["role", "gatherr"],
    ["role", "reviwer"],
    ["role", ""],
    ["placement", "sideways"],
  ] as const)(
    "rejects invalid spawn %s=%j before creating a surface",
    async (field, value) => {
      const exec = makeLifecycleExec();
      const server = createLifecycleServer(exec);
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const result = await spawn.handler(
        spawn.inputSchema.parse({
          version: 1,
          repo: "cmuxlayer",
          cli: "codex",
          ...(field === "placement" ? { role: "implementor" } : {}),
          [field]: value,
        }),
        {} as any,
      );

      expect(result.structuredContent).toMatchObject({ ok: false });
      expect(result.structuredContent.error).toContain(`Invalid ${field}=`);
      expect(
        exec.mock.calls.some(
          ([, args]) =>
            args.includes("new-split") || args.includes("new-surface"),
        ),
      ).toBe(false);
    },
  );

  it("rejects a spawn missing repo, cli, and role in one error that names all three", async () => {
    const exec = makeLifecycleExec();
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      { version: 1, type: "agent" },
      {} as any,
    );
    const parsed = result.structuredContent as Record<string, unknown>;

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/repo/i);
    expect(parsed.error).toMatch(/cli/i);
    expect(parsed.error).toMatch(/role/i);
    expect(
      exec.mock.calls.some(
        ([, args]) =>
          args.includes("new-split") || args.includes("new-surface"),
      ),
    ).toBe(false);
  });

  it("rejects roleless Claude before creating any surface and names both fixes", async () => {
    const exec = makeLifecycleExec();
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      spawn.inputSchema.parse({ repo: "cmuxlayer", cli: "claude" }),
      {} as any,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error_code: "ROLE_REQUIRED",
    });
    expect(result.structuredContent.error).toMatch(
      /use either .*authority.*lead.*role.*implementor.*or .*authority.*worker.*role.*reviewer/i,
    );
    expect(
      exec.mock.calls.some(
        ([, args]) =>
          args.includes("new-split") || args.includes("new-surface"),
      ),
    ).toBe(false);
  });

  it("rejects placement-only Claude as roleless", async () => {
    const exec = makeLifecycleExec();
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      spawn.inputSchema.parse({
        version: 1,
        repo: "cmuxlayer",
        cli: "claude",
        placement: "left",
      }),
      {} as any,
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error_code: "ROLE_REQUIRED",
    });
    expect(
      exec.mock.calls.some(
        ([, args]) =>
          args.includes("new-split") || args.includes("new-surface"),
      ),
    ).toBe(false);
  });

  it("stores reviewer function independently and places Claude on the right", async () => {
    const exec = makeLifecycleExec();
    const { server } = createHermeticSpawnServer({
      exec,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const args = spawn.inputSchema.parse({
      version: 1,
      type: "agent",
      repo: "cmuxlayer",
      cli: "claude",
      role: "reviewer",
    });
    const result = await spawn.handler(args, {} as any);

    expect(result.structuredContent).toMatchObject({
      ok: true,
      version: 1,
      type: "agent",
      role: "reviewer",
      authority: "worker",
      placement: "right",
    });
    expect(
      exec.mock.calls.some(
        ([, callArgs]) =>
          callArgs.includes("new-split") && callArgs.includes("right"),
      ),
    ).toBe(true);

    const engine = (server as any)._registeredTools["interact"]._engine;
    expect(
      engine.getAgentState(result.structuredContent.agent_id),
    ).toMatchObject({
      function: "reviewer",
      authority: "worker",
      placement: "right",
    });
  });

  it("defaults implementor axes independently of harness", async () => {
    const spawnWith = async (cli: "claude" | "codex") => {
      const { server } = createHermeticSpawnServer({
        exec: makeLifecycleExec(),
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
      });
      const spawn = (server as any)._registeredTools["spawn_agent"];
      return spawn.handler(
        spawn.inputSchema.parse({
          version: 1,
          repo: "cmuxlayer",
          cli,
          role: "implementor",
          force_new: true,
        }),
        {} as any,
      );
    };

    const claude = await spawnWith("claude");
    const codex = await spawnWith("codex");

    expect(claude.structuredContent).toMatchObject({
      ok: true,
      role: "implementor",
      authority: "worker",
      placement: "right",
    });
    expect(codex.structuredContent).toMatchObject({
      ok: true,
      role: "implementor",
      authority: "worker",
      placement: "right",
    });
  });

  it("rejects a reviewer placed left before creating a surface", async () => {
    const exec = makeLifecycleExec();
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const args = spawn.inputSchema.parse({
      version: 1,
      type: "agent",
      repo: "cmuxlayer",
      cli: "claude",
      role: "reviewer",
      placement: "left",
    });

    const result = await spawn.handler(args, {} as any);

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toMatch(
      /reviewer.*right|left.*reviewer/i,
    );
    expect(
      exec.mock.calls.some(
        ([, callArgs]) =>
          callArgs.includes("new-split") || callArgs.includes("new-surface"),
      ),
    ).toBe(false);
  });

  it("spawns a plain terminal in the parent workspace with cwd and no agent fields", async () => {
    const exec = makeLifecycleExec();
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const args = spawn.inputSchema.parse({
      version: 1,
      type: "terminal",
      cwd: "/tmp/spawn-spec-terminal",
      title: "P5 live probe",
    });

    const result = await runWithCallerContext(
      { workspaceId: "workspace:1" },
      () => spawn.handler(args, {} as any),
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      version: 1,
      type: "terminal",
      workspace_id: "workspace:1",
      surface_id: "surface:new",
      cwd: "/tmp/spawn-spec-terminal",
      title: "P5 live probe",
      cwd_receipt: {
        delivered: false,
        terminal: true,
        typed: true,
        submit_attempted: true,
        submit_verified: null,
        retry_count: 0,
      },
    });
    expect(result.structuredContent).not.toHaveProperty("agent_id");
    expect(result.structuredContent).not.toHaveProperty("role");
    expect(
      exec.mock.calls.some(
        ([, callArgs]) =>
          callArgs.includes("send") &&
          callArgs.includes("cd -- '/tmp/spawn-spec-terminal'"),
      ),
    ).toBe(true);
    expect(
      exec.mock.calls.some(
        ([, callArgs]) =>
          callArgs.includes("rename-tab") && callArgs.includes("P5 live probe"),
      ),
    ).toBe(true);
  });

  it("docks a plain terminal into the existing worker column", async () => {
    const baseExec = makeLifecycleExec();
    const exec = vi.fn().mockImplementation(async (cmd, callArgs: string[]) => {
      if (callArgs.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:lead",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:lead"],
                pixel_frame: { x: 0, y: 0, width: 800, height: 900 },
              },
              {
                ref: "pane:worker",
                index: 1,
                focused: false,
                surface_count: 1,
                surface_refs: ["surface:worker"],
                pixel_frame: { x: 800, y: 0, width: 800, height: 900 },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (callArgs.includes("new-surface")) {
        return {
          stdout: JSON.stringify({
            workspace: "workspace:1",
            surface: "surface:terminal",
            pane: "pane:worker",
            title: "",
            type: "terminal",
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, callArgs);
    }) as unknown as ExecFn;
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      spawn.inputSchema.parse({
        version: 1,
        type: "terminal",
        workspace: "workspace:1",
      }),
      {} as any,
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      type: "terminal",
      surface_id: "surface:terminal",
      workspace_id: "workspace:1",
    });
    expect(
      exec.mock.calls.some(
        ([, callArgs]) =>
          callArgs.includes("new-surface") &&
          callArgs.includes("--pane") &&
          callArgs.includes("pane:worker"),
      ),
    ).toBe(true);
    expect(
      exec.mock.calls.some(([, callArgs]) => callArgs.includes("new-split")),
    ).toBe(false);
  });

  it("creates a named workspace for a terminal workspace=new request", async () => {
    const exec = makeLifecycleExec({ createdWorkspace: "workspace:created" });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const args = spawn.inputSchema.parse({
      version: 1,
      type: "terminal",
      workspace: "new:Scratch Pad",
    });

    const result = await spawn.handler(args, {} as any);

    expect(result.structuredContent).toMatchObject({
      ok: true,
      type: "terminal",
      workspace_id: "workspace:created",
    });
    expect(
      exec.mock.calls.some(
        ([, callArgs]) =>
          callArgs.includes("workspace") &&
          callArgs.includes("create") &&
          callArgs.includes("Scratch Pad"),
      ),
    ).toBe(true);
  });

  it("terminal new workspace refuses manual mode before creating workspace", async () => {
    const baseExec = makeLifecycleExec({
      createdWorkspace: "workspace:created",
    });
    const exec = vi.fn().mockImplementation(async (cmd, args) => {
      if (Array.isArray(args) && args.includes("list-status")) {
        return {
          stdout: JSON.stringify([{ key: "mode.control", value: "manual" }]),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec as ExecFn);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const args = spawn.inputSchema.parse({
      version: 1,
      type: "terminal",
      workspace: "new:Scratch Pad",
    });

    const result = await runWithCallerContext(
      { workspaceId: "workspace:1" },
      () => spawn.handler(args, {} as any),
    );

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error_code: "manual_mode",
    });
    expect(
      exec.mock.calls.some(
        ([, callArgs]) =>
          callArgs.includes("workspace") && callArgs.includes("create"),
      ),
    ).toBe(false);
  });

  it("returns a stable identity triple for a worker-spawned reviewer", async () => {
    const { server } = createHermeticSpawnServer({
      exec: makeLifecycleExec(),
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    const parent = makeServerAgentRecord({
      agent_id: "cmuxlayerCodex-parent",
      surface_id: "surface:caller",
      workspace_id: "workspace:1",
      state: "working",
      cli: "codex",
      role: "worker",
    });
    engine.stateMgr.writeState(parent);
    engine.getRegistry().set(parent.agent_id, parent);
    const args = spawn.inputSchema.parse({
      version: 1,
      type: "agent",
      repo: "cmuxlayer",
      cli: "claude",
      role: "reviewer",
      force_new: true,
    });

    const result = await runWithCallerContext(
      { workspaceId: "workspace:1", surfaceId: parent.surface_id },
      () => spawn.handler(args, {} as any),
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      agent_id: expect.any(String),
      parent_agent_id: parent.agent_id,
      role: "reviewer",
      transport: "cli",
      socket_path: null,
      socket_path_state: "unavailable",
      warnings: expect.arrayContaining(["cli_fallback_active"]),
    });
    expect(result.structuredContent.agent_id).not.toContain("-pending-");
    expect(
      engine.getAgentState(result.structuredContent.agent_id),
    ).toMatchObject({
      agent_id: result.structuredContent.agent_id,
      parent_agent_id: parent.agent_id,
      function: "reviewer",
    });
  });

  it("spawn_agent publishes the exact expected-state manifest through the injected writer", async () => {
    const manifests: SeatManifest[] = [];
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const fixture = createHermeticSpawnServer({
      exec: makeLifecycleExec({ surfaceUuid }),
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      seatManifestWriter: async (manifest) => {
        manifests.push(manifest);
      },
      seatManifestNow: () => "2026-07-12T12:00:00.000Z",
    });
    const {
      server,
      context,
      stateDir,
      lifecycleInitializer,
      lifecycleSurfaceProvider,
    } = fixture;
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "cmuxlayer",
        model: "sonnet",
        cli: "claude",
        role: "implementor",
        authority: "lead",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(manifests).toEqual([
      {
        surface_id: "surface:new",
        surface_uuid: surfaceUuid,
        agent_id: parsed.agent_id,
        tab_name: "cmuxlayerClaude [surface:new]",
        session_name: null,
        model: "sonnet",
        permission_mode: "skip-permissions",
        cwd: join(homedir(), "Gits", "cmuxlayer"),
        repo: "cmuxlayer",
        cli: "claude",
        updated_at: "2026-07-12T12:00:00.000Z",
      },
    ]);
    expect(lifecycleInitializer).toHaveBeenCalledTimes(1);
    expect(lifecycleSurfaceProvider).not.toHaveBeenCalled();
    expect(context.stateDir).toBe(stateDir);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("spawn_agent manifest uses the launcher name resolved by preflight", async () => {
    const manifests: SeatManifest[] = [];
    const fixture = createHermeticSpawnServer({
      exec: makeLifecycleExec(),
      spawnPreflight: async () => ({ launcherName: "registeredClaude" }),
      sessionIdentityResolver: () => null,
      seatManifestWriter: async (manifest) => manifests.push(manifest),
      seatManifestNow: () => "2026-07-12T12:00:00.000Z",
    });
    const {
      server,
      context,
      stateDir,
      lifecycleInitializer,
      lifecycleSurfaceProvider,
    } = fixture;
    const spawn = (server as any)._registeredTools["spawn_agent"];

    await spawn.handler(
      { repo: "cmuxlayer", model: "sonnet", cli: "claude" },
      {} as any,
    );

    expect(manifests[0]?.tab_name).toBe("registeredClaude [surface:new]");
    expect(lifecycleInitializer).toHaveBeenCalledTimes(1);
    expect(lifecycleSurfaceProvider).not.toHaveBeenCalled();
    expect(context.stateDir).toBe(stateDir);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("spawn_agent defaults to the lean payload in text and structured content", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      { repo: "cmuxlayer", cli: "codex" },
      {} as any,
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual(result.structuredContent);
    expect(parsed).toMatchObject({
      ok: true,
      agent_id: expect.any(String),
      surface_id: "surface:new",
      workspace_id: "workspace:1",
      state: "booting",
      model: "codex",
      role: "worker",
      boot_prompt_delivered: true,
      boot_prompt_submit_verified: true,
    });
    expect(parsed).not.toHaveProperty("health");
    expect(parsed).not.toHaveProperty("model_policy");
    expect(parsed.retry_count).toBe(0);
    expect(parsed).not.toHaveProperty("monitor_boot");
  });

  it("spawn_agent preserves the full legacy payload with verbose true", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      { repo: "cmuxlayer", cli: "codex", verbose: true },
      {} as any,
    );

    expect(result.structuredContent).toHaveProperty("health");
    expect(result.structuredContent).toHaveProperty("model_policy");
    expect(result.structuredContent).toHaveProperty("retry_count", 0);
    expect(result.content[0].text).not.toBe(
      JSON.stringify(result.structuredContent),
    );
  });

  it("injects the agent-owned inbox cursor helper into orchestrator boot metadata", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "cmuxlayer",
        cli: "claude",
        placement: "orchestrator",
        verbose: true,
      },
      {} as any,
    );

    expect(result.structuredContent.monitor_boot).toMatchObject({
      cursor_path: expect.stringMatching(/inbox\.cursor$/),
      cursor_update_command: expect.stringContaining("inbox-cursor"),
      cursor_update_env: "CMUX_INBOX_MSG_ID",
    });
  });

  it("spawn_agent surfaces Codex model pass-through in lean mode", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      { repo: "cmuxlayer", model: "gpt-5.5", cli: "codex", verbose: true },
      {} as any,
    );

    expect(result.structuredContent.model_policy).toMatchObject({
      coerced: false,
      effective_model: "gpt-5.5",
      launcher_model: "gpt-5.5",
      override_allowed: true,
    });
  });

  it("spawn_agent passes an explicit Codex effort to the launcher", async () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const args = spawn.inputSchema.parse({
      repo: "cmuxlayer",
      cli: "codex",
      effort: "medium",
    });

    const result = await spawn.handler(args, {} as any);

    expect(result.structuredContent.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "cmuxlayerCodex -s --worker -E medium"]),
    );
  });

  it("spawn_agent schema advertises the installed Codex effort set", () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      expect(
        spawn.inputSchema.safeParse({
          repo: "cmuxlayer",
          cli: "codex",
          effort,
        }).success,
      ).toBe(true);
    }

    for (const effort of ["turbo"]) {
      expect(
        spawn.inputSchema.safeParse({
          repo: "cmuxlayer",
          cli: "codex",
          effort,
        }).success,
      ).toBe(false);
    }
  });

  it("documents caller-supplied agent pane titles as verbatim", () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const spawn = (server as any)._registeredTools["spawn_agent"];

    expect(spawn.inputSchema.shape.title.description).toContain(
      "caller-supplied agent pane title is applied verbatim",
    );
    expect(spawn.inputSchema.shape.title.description).toContain(
      "when omitted or blank",
    );
    expect(spawn.inputSchema.shape.title.description).toContain(
      "identity comes from the agent registry, not this display title",
    );
  });

  it("spawn_agent rejects launcher-incompatible effort before creating a worktree or surface", async () => {
    const repoRoot = join(TEST_DIR, "Gits", "cmuxlayer");
    const registryPath = join(TEST_DIR, "launchers-effort-preflight.zsh");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(registryPath, `repoGolem cmuxlayer "${repoRoot}"\n`);
    vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
    const worktreeExec = vi.fn();
    const exec = makeLifecycleExec();
    const server = createTrackedServer({
      exec,
      stateDir: TEST_DIR,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: join(TEST_DIR, "Gits"),
      worktreeExec,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        effort: "turbo",
        worktree: {
          name: "incompatible-effort",
          branch: "wt/incompatible-effort",
        },
      },
      {} as any,
    );

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toContain(
      'Invalid Codex effort "turbo" (expected: low, medium, high, xhigh, max, ultra)',
    );
    expect(worktreeExec).not.toHaveBeenCalled();
    expect(
      (exec as any).mock.calls.some(
        ([, args]: [string, string[]]) =>
          args.includes("new-split") || args.includes("new-surface"),
      ),
    ).toBe(false);
  });

  it("spawn_agent rejects Codex effort for another CLI before creating a surface", async () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const args = spawn.inputSchema.parse({
      repo: "cmuxlayer",
      cli: "claude",
      role: "implementor",
      authority: "lead",
      effort: "medium",
    });

    const result = await spawn.handler(args, {} as any);

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toContain(
      'Codex effort "medium" cannot be used with cli "claude"',
    );
    expect(
      mockExec.mock.calls.some(([, callArgs]) =>
        callArgs.includes("new-split"),
      ),
    ).toBe(false);
  });

  it("spawn_agent rejects an unsupported model before creating a surface", async () => {
    delete process.env.REPOGOLEM_ALLOW_MODEL;
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const previousOverride = process.env[MODEL_OVERRIDE_ENV];
    process.env[MODEL_OVERRIDE_ENV] = "1";

    let result: any;
    try {
      result = await spawn.handler(
        { repo: "cmuxlayer", cli: "claude", model: "fable-5" },
        {} as any,
      );
    } finally {
      if (previousOverride === undefined) {
        delete process.env[MODEL_OVERRIDE_ENV];
      } else {
        process.env[MODEL_OVERRIDE_ENV] = previousOverride;
      }
    }

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toContain(
      'Unsupported model "fable-5" for cli "claude"',
    );
    expect(result.structuredContent.error).toContain(
      'would actually run "claude-opus-5[1m]"',
    );
    expect(result.structuredContent.error).toContain("Accepted models:");
    for (const alias of ["opus", "sonnet", "haiku"]) {
      expect(result.structuredContent.error).toMatch(
        new RegExp(`Accepted models: [^.]*\\b${alias}\\b`),
      );
    }
    expect(
      mockExec.mock.calls.some(([, callArgs]) =>
        callArgs.includes("new-split"),
      ),
    ).toBe(false);
  });

  it("new_worktree_split rejects an unsupported model before preparing a worktree", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    mkdirSync(join(gitsDir, "cmuxlayer"), { recursive: true });
    const mockExec = makeLifecycleExec();
    const worktreeExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const spawn = (server as any)._registeredTools["new_worktree_split"];

    const result = await spawn.handler(
      {
        repo: "cmuxlayer",
        cli: "claude",
        model: "fable-5",
        worktree: { name: "must-not-exist" },
      },
      {} as any,
    );

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toContain(
      'Unsupported model "fable-5" for cli "claude"',
    );
    expect(worktreeExec).not.toHaveBeenCalled();
    expect(
      mockExec.mock.calls.some(([, callArgs]) =>
        callArgs.includes("new-split"),
      ),
    ).toBe(false);
  });

  it("spawn_in_workspace validates every model before creating the workspace", async () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_in_workspace"];

    const result = await spawn.handler(
      {
        workspace_title: "Must not exist",
        agents: [
          {
            repo: "cmuxlayer",
            cli: "codex",
            model: "codex",
            role: "worker",
          },
          {
            repo: "cmuxlayer",
            cli: "claude",
            model: "fable-5",
            role: "worker",
          },
        ],
      },
      {} as any,
    );

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toContain(
      'Unsupported model "fable-5" for cli "claude"',
    );
    expect(
      mockExec.mock.calls.some(([, callArgs]) =>
        callArgs.includes("create-workspace"),
      ),
    ).toBe(false);
    expect(
      mockExec.mock.calls.some(([, callArgs]) =>
        callArgs.includes("new-split"),
      ),
    ).toBe(false);
  });
});

function moveOnlyAgentStateDir(prefix: string) {
  const entries = readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "events");
  expect(entries).toHaveLength(1);
  renameSync(
    join(TEST_DIR, entries[0]),
    join(TEST_DIR, `${prefix}-${entries[0]}`),
  );
}

function renameOnlyAgentStateToSession(sessionId: string): string {
  const entries = readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "events");
  expect(entries).toHaveLength(1);

  const statePath = join(TEST_DIR, entries[0], "state.json");
  const current = JSON.parse(readFileSync(statePath, "utf8")) as AgentRecord;
  const finalAgentId = generateAgentId(current.cli, current.repo, sessionId);
  const updated: AgentRecord = {
    ...current,
    agent_id: finalAgentId,
    cli_session_id: sessionId,
    version: current.version + 1,
    updated_at: new Date().toISOString(),
  };

  const finalDir = join(TEST_DIR, finalAgentId);
  mkdirSync(finalDir, { recursive: true });
  writeFileSync(join(finalDir, "state.json"), JSON.stringify(updated, null, 2));
  rmSync(join(TEST_DIR, entries[0]), { recursive: true, force: true });
  return finalAgentId;
}

function resolveCurrentTestAgentId(
  stateMgr: { readState(agentId: string): AgentRecord | null },
  agentId: string,
): string {
  if (stateMgr.readState(agentId)) return agentId;
  const entries = readdirSync(TEST_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "events" && !name.startsWith("Gits"));
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

function makeServerAgentRecord(
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    agent_id: "codex-golems-000000",
    surface_id: "surface:new",
    workspace_id: "ws:1",
    state: "done",
    repo: "golems",
    model: "gpt-5.5",
    cli: "codex",
    cli_session_id: null,
    cli_session_path: null,
    task_summary: "fixture worker",
    pid: null,
    version: 1,
    created_at: "2026-07-05T07:00:00.000Z",
    updated_at: "2026-07-05T07:00:00.000Z",
    error: null,
    parent_agent_id: null,
    spawn_depth: 0,
    role: "worker",
    auto_archive_on_done: false,
    task_done_candidate_at: null,
    task_done_detected_at: "2000-01-01T00:00:00.000Z",
    deletion_intent: false,
    quality: "unknown",
    max_cost_per_agent: null,
    crash_recover: false,
    respawn_attempts: 0,
    user_killed: false,
    boot_prompt_pending: false,
    goal_file: null,
    launch_cwd: null,
    mcp_profile: null,
    worktree_path: null,
    worktree_branch: null,
    ...overrides,
  };
}

type BroadcastMockClient = {
  client: Record<string, any>;
  sendCalls: Array<{ surface: string; text: string; workspace?: string }>;
  sendKeyCalls: Array<{ surface: string; key: string; workspace?: string }>;
};

type UuidRouteSurface = {
  ref: string;
  id?: string;
  workspace_ref: string;
  window_ref?: string;
  title?: string;
};

function makeUuidRouteClient(initialSurfaces: UuidRouteSurface[]) {
  let liveSurfaces = initialSurfaces;
  let screenText = "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\ncodex> ";
  const sendCalls: Array<{ surface: string; text: string }> = [];
  const pasteCalls: Array<{ surface: string; text: string }> = [];
  const surfacesForWorkspace = (workspace?: string) =>
    liveSurfaces.filter(
      (surface) => !workspace || surface.workspace_ref === workspace,
    );
  const client = {
    currentSocketPath: vi.fn(() => "/tmp/current.sock"),
    currentObserverTransportEpoch: vi.fn(() => "test:1"),
    listWorkspaces: vi.fn().mockImplementation(async () => ({
      workspaces: [
        ...new Set(liveSurfaces.map((surface) => surface.workspace_ref)),
      ].map((ref, index) => ({
        ref,
        title: ref,
        index,
        selected: index === 0,
        pinned: false,
      })),
    })),
    listPanes: vi
      .fn()
      .mockImplementation(async (opts?: { workspace?: string }) => {
        const surfaces = surfacesForWorkspace(opts?.workspace);
        const surfaceIds = surfaces
          .map((surface) => surface.id)
          .filter((id): id is string => Boolean(id));
        return {
          workspace_ref: opts?.workspace,
          window_ref: `window:${opts?.workspace ?? "1"}`,
          panes:
            surfaces.length === 0
              ? []
              : [
                  {
                    ref: `pane:${opts?.workspace ?? "1"}`,
                    index: 0,
                    focused: true,
                    surface_count: surfaces.length,
                    surface_refs: surfaces.map((surface) => surface.ref),
                    ...(surfaceIds.length === surfaces.length
                      ? { surface_ids: surfaceIds }
                      : {}),
                    selected_surface_ref: surfaces[0]?.ref,
                  },
                ],
        };
      }),
    listPaneSurfaces: vi
      .fn()
      .mockImplementation(
        async (opts?: { workspace?: string; pane?: string }) => ({
          workspace_ref: opts?.workspace,
          window_ref: `window:${opts?.workspace ?? "1"}`,
          pane_ref: opts?.pane ?? `pane:${opts?.workspace ?? "1"}`,
          surfaces: surfacesForWorkspace(opts?.workspace).map(
            (surface, index) => ({
              ...surface,
              title: surface.title ?? "cmuxlayerCodex",
              type: "terminal",
              index,
              selected: index === 0,
              pane_ref: opts?.pane ?? `pane:${opts?.workspace ?? "1"}`,
            }),
          ),
        }),
      ),
    readScreen: vi.fn().mockImplementation(async (surface: string) => ({
      surface,
      text: screenText,
      lines: 20,
      scrollback_used: false,
    })),
    send: vi.fn().mockImplementation(async (surface: string, text: string) => {
      sendCalls.push({ surface, text });
    }),
    pasteText: vi
      .fn()
      .mockImplementation(async (surface: string, text: string) => {
        pasteCalls.push({ surface, text });
      }),
    sendKey: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    newSplit: vi.fn(),
    newSurface: vi.fn(),
    selectWorkspace: vi.fn(),
    closeSurface: vi.fn().mockImplementation(async (surface: string) => {
      liveSurfaces = liveSurfaces.filter(
        (candidate) => candidate.ref !== surface,
      );
    }),
    moveSurface: vi
      .fn()
      .mockImplementation(async (opts: { surface: string }) => ({
        surface: opts.surface,
        pane: null,
        workspace: null,
      })),
    renameTab: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    listStatus: vi.fn().mockResolvedValue([]),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
  };

  return {
    client,
    sendCalls,
    pasteCalls,
    setLiveSurfaces(next: UuidRouteSurface[]) {
      liveSurfaces = next;
    },
    setScreenText(next: string) {
      screenText = next;
    },
  };
}

function makeCrossWindowUuidRouteClient(initialSurfaces: UuidRouteSurface[]) {
  const routeClient = makeUuidRouteClient(initialSurfaces);
  const windows = ["window:A", "window:B"];
  const workspaceForWindow = new Map([
    ["window:A", "workspace:A"],
    ["window:B", "workspace:B"],
  ]);
  const workspaceIdForRef = new Map([
    ["workspace:A", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"],
    ["workspace:B", "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"],
  ]);
  (routeClient.client as any).listWindows = vi.fn().mockResolvedValue({
    windows: windows.map((ref) => ({ ref, workspace_count: 1 })),
  });
  routeClient.client.listWorkspaces.mockImplementation(
    async (opts?: { window?: string }) => {
      // Reproduce D89: the daemon belongs to window A, so an unscoped call
      // sees only A even though window B is live.
      const workspaceRef = opts?.window
        ? workspaceForWindow.get(opts.window)
        : "workspace:A";
      return {
        workspaces: workspaceRef
          ? [
              {
                ref: workspaceRef,
                id: workspaceIdForRef.get(workspaceRef),
                title: workspaceRef,
                index: 0,
                selected: workspaceRef === "workspace:A",
                pinned: false,
              },
            ]
          : [],
      };
    },
  );
  (routeClient.client as any).focusSurface = vi
    .fn()
    .mockResolvedValue(undefined);
  return routeClient;
}

function moveUuidRouteAfterNextSurfaceSnapshot(
  routeClient: ReturnType<typeof makeUuidRouteClient>,
  nextSurfaces: UuidRouteSurface[],
): void {
  const currentImplementation =
    routeClient.client.listPaneSurfaces.getMockImplementation();
  if (!currentImplementation) {
    throw new Error("UUID route client has no surface-list implementation");
  }
  routeClient.client.listPaneSurfaces.mockImplementationOnce(async (opts) => {
    const snapshot = await currentImplementation(opts);
    queueMicrotask(() => routeClient.setLiveSurfaces(nextSurfaces));
    return snapshot;
  });
}

async function createUuidRouteServer(
  routeClient: ReturnType<typeof makeUuidRouteClient>,
  record: AgentRecord,
  extraOptions: Record<string, unknown> = {},
) {
  const stateMgr = new StateManager(TEST_DIR);
  stateMgr.writeState(record);
  const server = createTrackedServer({
    client: routeClient.client as any,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    sessionIdentityResolver: () => null,
    ...extraOptions,
  });
  await serverContexts.at(-1)?.lifecycleStartPromise;

  const engine = testLifecycleEngine(server);
  engine.stateMgr.writeState(record);
  engine.getRegistry().set(record.agent_id, record);
  return server;
}

function bypassEngineSurfaceWriteWrappers(
  server: unknown,
  routeClient: ReturnType<typeof makeUuidRouteClient>,
): void {
  const engine = testLifecycleEngine(server) as any;
  engine.client.sendKey = routeClient.client.sendKey;
  engine.client.closeSurface = routeClient.client.closeSurface;
}

function enforceTestObserverOwnership(
  server: unknown,
  observerId: string,
): { engine: any; registry: any } {
  const engine = testLifecycleEngine(server) as any;
  const registry = engine.getRegistry();
  expect(registry.isObserverOwnershipEnforced()).toBe(true);
  expect(registry.getObserverId()).toBe(observerId);
  return { engine, registry };
}

function makeBroadcastClient(
  records: AgentRecord[],
  opts: {
    failSurface?: string;
    callerSurface?: string;
    malformedEnumeration?: boolean;
    rescuedSurface?: string;
  } = {},
): BroadcastMockClient {
  const submittedSurfaces = new Set<string>();
  const pendingTextBySurface = new Map<string, string>();
  const sendCalls: Array<{
    surface: string;
    text: string;
    workspace?: string;
  }> = [];
  const sendKeyCalls: Array<{
    surface: string;
    key: string;
    workspace?: string;
  }> = [];
  const workspaces = [
    ...new Set(records.map((record) => record.workspace_id ?? "workspace:1")),
  ];
  const recordsForWorkspace = (workspace?: string) =>
    records.filter(
      (record) => (record.workspace_id ?? "workspace:1") === workspace,
    );
  const screenFor = (surface: string): string => {
    const record = records.find(
      (candidate) => candidate.surface_id === surface,
    );
    if (submittedSurfaces.has(surface)) {
      if (opts.rescuedSurface === surface) {
        return [
          ">_ OpenAI Codex",
          "■ Conversation interrupted - tell the model what to do differently",
          `• ${pendingTextBySurface.get(surface) ?? ""}`,
          "Working (1s • esc to interrupt)",
          "gpt-5.6-sol medium · ~/Gits/cmuxlayer",
        ].join("\n");
      }
      return record?.cli === "claude"
        ? "Claude Code\nWorking\n"
        : "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)";
    }
    if (record?.cli === "claude") {
      return "Claude Code\nWhat can I help you with?\n>";
    }
    if (record?.cli === "cursor") {
      return "cursor>\n";
    }
    if (opts.rescuedSurface === surface) {
      const pendingText = pendingTextBySurface.get(surface);
      return pendingText
        ? [
            ">_ OpenAI Codex",
            `» ${pendingText}`,
            "gpt-5.6-sol medium · ~/Gits/cmuxlayer",
          ].join("\n")
        : [
            ">_ OpenAI Codex",
            "Conversation interrupted",
            "›",
            "gpt-5.6-sol medium · ~/Gits/cmuxlayer",
          ].join("\n");
    }
    return "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\ncodex> ";
  };

  const client = {
    getTransportHealth: () => ({
      mode: "socket" as const,
      degraded: false,
      current_socket_path: "/tmp/cmuxlayer-test.sock",
    }),
    listWorkspaces: vi.fn().mockImplementation(async () =>
      opts.malformedEnumeration
        ? { workspaces: null }
        : {
            workspaces: workspaces.map((ref, index) => ({
              ref,
              title: ref,
              index,
              selected: index === 0,
              pinned: false,
            })),
          },
    ),
    listPanes: vi.fn().mockImplementation(async ({ workspace }) => {
      const workspaceRecords = recordsForWorkspace(workspace);
      return {
        workspace_ref: workspace,
        window_ref: `window:${workspace}`,
        panes: [
          {
            ref: `pane:${workspace}`,
            index: 0,
            focused: true,
            surface_count: workspaceRecords.length,
            surface_refs: workspaceRecords.map((record) => record.surface_id),
            selected_surface_ref: workspaceRecords[0]?.surface_id,
          },
        ],
      };
    }),
    listPaneSurfaces: vi
      .fn()
      .mockImplementation(async ({ workspace, pane }) => {
        const workspaceRecords = recordsForWorkspace(workspace);
        return {
          workspace_ref: workspace,
          window_ref: `window:${workspace}`,
          pane_ref: pane ?? `pane:${workspace}`,
          surfaces: workspaceRecords.map((record, index) => ({
            ref: record.surface_id,
            title: record.task_summary,
            type: "terminal",
            index,
            selected: index === 0,
            workspace_ref: workspace,
            pane_ref: pane ?? `pane:${workspace}`,
          })),
        };
      }),
    readScreen: vi.fn().mockImplementation(async (surface) => ({
      surface,
      text: screenFor(surface),
      lines: 20,
      scrollback_used: false,
    })),
    send: vi.fn().mockImplementation(async (surface, text, sendOpts) => {
      sendCalls.push({ surface, text, workspace: sendOpts?.workspace });
      pendingTextBySurface.set(surface, text);
      if (opts.failSurface === surface) {
        throw new Error(`send failed for ${surface}`);
      }
    }),
    sendKey: vi.fn().mockImplementation(async (surface, key, keyOpts) => {
      sendKeyCalls.push({ surface, key, workspace: keyOpts?.workspace });
      if (key === "return") {
        submittedSurfaces.add(surface);
      }
    }),
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
    identify: vi.fn().mockImplementation(async () => ({
      caller: {
        surface_ref: opts.callerSurface ?? process.env.CMUX_TAB_ID,
        workspace_ref: records.find(
          (record) =>
            record.surface_id ===
            (opts.callerSurface ?? process.env.CMUX_TAB_ID),
        )?.workspace_id,
      },
      focused: {
        surface_ref: opts.callerSurface ?? process.env.CMUX_TAB_ID,
      },
    })),
    browser: vi.fn().mockResolvedValue({}),
  };

  return { client, sendCalls, sendKeyCalls };
}

async function createBroadcastServer(
  records: AgentRecord[],
  opts: {
    failSurface?: string;
    callerSurface?: string;
    malformedEnumeration?: boolean;
    rescuedSurface?: string;
  } = {},
) {
  const ownedRecords = records.map((record) => ({
    ...record,
    surface_observer_id:
      record.surface_observer_id ?? "cmux:/tmp/cmuxlayer-test.sock",
  }));
  const { client, sendCalls, sendKeyCalls } = makeBroadcastClient(
    ownedRecords,
    opts,
  );
  const persistedState = new StateManager(TEST_DIR);
  for (const record of ownedRecords) {
    persistedState.writeState(record);
  }
  const server = createTrackedServer({
    client: client as any,
    stateDir: TEST_DIR,
    disableSpawnPreflight: true,
    sessionIdentityResolver: () => null,
  });
  await serverContexts[serverContexts.length - 1]?.lifecycleStartPromise;
  const engine = testLifecycleEngine(server);
  const registry = engine.getRegistry();
  for (const record of ownedRecords) {
    engine.stateMgr.writeState(record);
    registry.set(record.agent_id, record);
  }
  return { server, client, sendCalls, sendKeyCalls };
}

function readOutboxMtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}

type TestToolResult = {
  structuredContent?: Record<string, unknown>;
  content: Array<{ text: string }>;
  isError?: boolean;
};

type RegisteredTestTool = {
  handler(
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<TestToolResult>;
};

type TestLifecycleEngine = {
  stateMgr: { writeState(record: AgentRecord): void };
  getRegistry(): { set(agentId: string, record: AgentRecord): void };
};

function registeredTestTool(server: unknown, name: string): RegisteredTestTool {
  const registry = (
    server as {
      _registeredTools: Record<string, RegisteredTestTool>;
    }
  )._registeredTools;
  const tool = registry[name]!;
  if (name !== "send_to") return tool;
  return {
    handler(args, context) {
      return tool.handler({ mode: "agent", ...args }, context);
    },
  };
}

function testLifecycleEngine(server: unknown): TestLifecycleEngine {
  const interact = registeredTestTool(
    server,
    "interact",
  ) as RegisteredTestTool & {
    _engine: TestLifecycleEngine;
  };
  return interact._engine;
}

function parseToolResult(result: TestToolResult): Record<string, unknown> {
  return (
    result.structuredContent ??
    (JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>)
  );
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Read the durable close/kill telemetry the handlers append to events.jsonl. */
function readCloseEvents(stateDir: string): Array<Record<string, unknown>> {
  const filePath = join(stateDir, "events.jsonl");
  try {
    return readFileSync(filePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event_type === "close");
  } catch {
    return [];
  }
}

describe("agent lifecycle tool registration", () => {
  it("registers all 15 phase-5 lifecycle tools when lifecycle is enabled", () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const registeredTools = (server as any)._registeredTools;
    const toolNames = Object.keys(registeredTools);

    for (const expected of AGENT_TOOLS) {
      expect(toolNames, `Missing tool: ${expected}`).toContain(expected);
    }
  });

  it("does NOT register agent tools when skipAgentLifecycle is true", () => {
    const mockExec: ExecFn = vi.fn().mockResolvedValue({
      stdout: "{}",
      stderr: "",
    });
    const server = createServer({
      exec: mockExec,
      skipAgentLifecycle: true,
    });
    const registeredTools = (server as any)._registeredTools;
    const toolNames = Object.keys(registeredTools);

    for (const tool of AGENT_TOOLS) {
      expect(toolNames).not.toContain(tool);
    }
  });

  it("registers the internal compatibility handlers in test mode", () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const registeredTools = (server as any)._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(45);
  });

  it("keeps resync_agents only as a removed compatibility stub", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const result = await (server as any)._registeredTools.resync_agents.handler(
      {},
      {},
    );
    const parsed = parseToolResult(result);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(parsed.error).toContain("resync_agents was removed");
  });
});

describe("agent lifecycle tool handlers", () => {
  let mockExec: ExecFn;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), "cmux-agents-test-server-tools-"));
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mockExec = makeLifecycleExec();
  });

  it("does not adopt cached lifecycle UUID evidence after an observer reconnect", async () => {
    let socketPath = "/tmp/cmux-primary.sock";
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:primary",
        id: surfaceUuid,
        workspace_ref: "workspace:primary",
      },
    ]);
    routeClient.client.currentSocketPath = vi.fn(() => socketPath);
    const record = makeServerAgentRecord({
      agent_id: "observer-cache-worker",
      surface_id: "surface:primary",
      surface_uuid: surfaceUuid,
      surface_observer_id: "cmux:/tmp/cmux-primary.sock",
      workspace_id: "workspace:primary",
      state: "ready",
      error: null,
      task_done_detected_at: null,
    });
    const server = await createUuidRouteServer(routeClient, record);
    const context = serverContexts.at(-1)!;
    const registry = testLifecycleEngine(server).getRegistry() as any;

    socketPath = "/tmp/cmux-secondary.sock";
    routeClient.client.listWorkspaces.mockResolvedValue({});

    await registry.reconcile();

    expect(context.stateMgr.readState(record.agent_id)).toMatchObject({
      surface_id: "surface:primary",
      surface_uuid: surfaceUuid,
      surface_observer_id: "cmux:/tmp/cmux-primary.sock",
      workspace_id: "workspace:primary",
    });
  });

  it("treats a successful lifecycle pane subset as inconclusive", async () => {
    const firstUuid = "11111111-2222-4333-8444-555555555555";
    const secondUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:first",
        id: firstUuid,
        workspace_ref: "workspace:one",
      },
      {
        ref: "surface:second",
        id: secondUuid,
        workspace_ref: "workspace:one",
      },
    ]);
    routeClient.client.currentSocketPath = vi.fn(() => "/tmp/current.sock");
    const listPaneSurfaces =
      routeClient.client.listPaneSurfaces.getMockImplementation()!;
    routeClient.client.listPaneSurfaces.mockImplementation(async (opts) => {
      const group = await listPaneSurfaces(opts);
      return { ...group, surfaces: group.surfaces.slice(0, 1) };
    });
    const record = makeServerAgentRecord({
      agent_id: "lifecycle-successful-subset",
      surface_id: "surface:second",
      surface_uuid: secondUuid,
      surface_observer_id: "cmux:/tmp/current.sock",
      workspace_id: "workspace:one",
      state: "ready",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const registry = testLifecycleEngine(server).getRegistry();

    await registry.reconcile({ confirmationMs: 0 });

    expect(registry.get(record.agent_id)).toMatchObject({
      state: "ready",
      surface_id: "surface:second",
      surface_uuid: secondUuid,
      workspace_id: "workspace:one",
    });
  });

  it("rejects lifecycle UUID evidence when the observer changes mid-enumeration", async () => {
    let socketPath = "/tmp/cmux-primary.sock";
    let switchDuringEnumeration = false;
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:primary",
        id: surfaceUuid,
        workspace_ref: "workspace:primary",
      },
    ]);
    routeClient.client.currentSocketPath = vi.fn(() => socketPath);
    const listWorkspaces =
      routeClient.client.listWorkspaces.getMockImplementation()!;
    routeClient.client.listWorkspaces.mockImplementation(async () => {
      const result = await listWorkspaces();
      if (switchDuringEnumeration) {
        socketPath = "/tmp/cmux-secondary.sock";
      }
      return result;
    });
    const record = makeServerAgentRecord({
      agent_id: "observer-mid-scan-worker",
      surface_id: "surface:primary",
      surface_uuid: surfaceUuid,
      surface_observer_id: "cmux:/tmp/cmux-primary.sock",
      workspace_id: "workspace:primary",
      state: "ready",
      error: null,
      task_done_detected_at: null,
    });
    const server = await createUuidRouteServer(routeClient, record);
    const context = serverContexts.at(-1)!;
    const registry = testLifecycleEngine(server).getRegistry() as any;
    switchDuringEnumeration = true;

    await registry.reconcile();

    expect(context.stateMgr.readState(record.agent_id)).toMatchObject({
      surface_id: "surface:primary",
      surface_uuid: surfaceUuid,
      surface_observer_id: "cmux:/tmp/cmux-primary.sock",
      workspace_id: "workspace:primary",
    });
    expect(context.surfaceObserverId).toBe("cmux:/tmp/cmux-secondary.sock");
  });

  it("rejects lifecycle evidence when transport epoch changes under one owner", async () => {
    let transportEpoch = "socket:1";
    let switchDuringEnumeration = false;
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:current",
        id: surfaceUuid,
        workspace_ref: "workspace:current",
      },
    ]);
    routeClient.client.currentObserverTransportEpoch = vi.fn(
      () => transportEpoch,
    );
    const listWorkspaces =
      routeClient.client.listWorkspaces.getMockImplementation()!;
    routeClient.client.listWorkspaces.mockImplementation(async () => {
      const result = await listWorkspaces();
      if (switchDuringEnumeration) {
        transportEpoch = "socket:2";
      }
      return result;
    });
    const record = makeServerAgentRecord({
      agent_id: "observer-transport-epoch-worker",
      surface_id: "surface:persisted",
      surface_uuid: surfaceUuid,
      surface_observer_id: "cmux:/tmp/current.sock",
      workspace_id: "workspace:persisted",
      state: "ready",
      error: null,
    });
    const server = await createUuidRouteServer(routeClient, record);
    const context = serverContexts.at(-1)!;
    const registry = testLifecycleEngine(server).getRegistry();
    switchDuringEnumeration = true;

    await registry.reconcile({ confirmationMs: 0 });

    expect(context.surfaceObserverId).toBe("cmux:/tmp/current.sock");
    expect(context.surfaceObserverEpoch).toBe(
      "cmux:/tmp/current.sock@socket:2",
    );
    expect(context.stateMgr.readState(record.agent_id)).toMatchObject({
      surface_id: "surface:persisted",
      surface_uuid: surfaceUuid,
      surface_observer_id: "cmux:/tmp/current.sock",
      workspace_id: "workspace:persisted",
    });
  });

  it("does not reuse lifecycle UUID evidence while observer identity is unknown", async () => {
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:cached",
        id: surfaceUuid,
        workspace_ref: "workspace:cached",
      },
    ]);
    routeClient.client.currentSocketPath = vi.fn(() => "");
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    const context = serverContexts.at(-1)!;
    const registry = testLifecycleEngine(server).getRegistry() as any;
    const record = makeServerAgentRecord({
      agent_id: "observer-unknown-worker",
      surface_id: "surface:cached",
      surface_uuid: surfaceUuid,
      surface_observer_id: null,
      workspace_id: "workspace:persisted",
      state: "ready",
      error: null,
      task_done_detected_at: null,
    });
    context.stateMgr.writeState(record);
    registry.set(record.agent_id, record);
    routeClient.client.listWorkspaces.mockResolvedValue({});

    await registry.reconcile();

    expect(context.surfaceObserverId).toBeNull();
    expect(context.stateMgr.readState(record.agent_id)).toMatchObject({
      surface_id: "surface:cached",
      surface_uuid: surfaceUuid,
      surface_observer_id: null,
      workspace_id: "workspace:persisted",
    });
  });

  it("refreshes server discovery within its TTL after an observer reconnect", async () => {
    let socketPath = "/tmp/cmux-primary.sock";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:primary",
        id: "11111111-2222-4333-8444-555555555555",
        workspace_ref: "workspace:primary",
      },
    ]);
    routeClient.client.currentSocketPath = vi.fn(() => socketPath);
    routeClient.setScreenText(
      "gpt-5.4 high · 87% left · ~/Gits/cmuxlayer\n• Working (1s · esc to interrupt)",
    );
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    routeClient.client.readScreen.mockClear();

    socketPath = "/tmp/cmux-secondary.sock";
    routeClient.setLiveSurfaces([
      {
        ref: "surface:secondary",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:secondary",
      },
    ]);
    const listAgents = (server as any)._registeredTools["list_agents"];

    const result = await listAgents.handler({}, {} as any);
    const parsed = parseToolResult(result) as {
      ok: boolean;
      agents: Array<{ agent_id: string }>;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: "cmuxlayerCodex",
        }),
      ]),
    );
    expect(routeClient.client.readScreen).toHaveBeenCalledWith(
      "surface:secondary",
      expect.objectContaining({ workspace: "workspace:secondary" }),
    );
  });

  it("spawn_agent returns agent_id and surface_id", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix gap F",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toMatch(/^brainlayerClaude-[0-9a-f]{8}$/);
    expect(parsed.surface_id).toBe("surface:new");
    expect(parsed.state).toBe("ready");
    expect(parsed.health).toBeUndefined();

    const stateTool = (server as any)._registeredTools["get_agent_state"];
    const stateResult = await stateTool.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const persisted =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(persisted.auto_archive_on_done).toBe(false);
  });

  it("spawn_agent resume_agent_id rebinds a captured session without minting a new public id", async () => {
    const agentId = "cmuxlayerCodex-stable-resume";
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeServerAgentRecord({
        agent_id: agentId,
        repo: "brainlayer",
        cli: "codex",
        state: "done",
        surface_id: "surface:old",
        cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      }),
    );
    const exec = makeLifecycleExec();
    const server = createLifecycleServer(exec);
    await serverContexts.at(-1)?.lifecycleStartPromise;
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler({ resume_agent_id: agentId }, {} as any);
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      resumed: true,
      agent_id: agentId,
      surface_id: "surface:new",
    });
    expect(spawn.inputSchema.shape.resume_agent_id).toBeDefined();
  });

  it("P11b/#462: resume issues, persists, and REFRESHES the contract -- and says it was not re-delivered", async () => {
    // Before this, resume returned no contract at all: no report_path, no
    // done_marker, no contract file. The crash-recovery case this repo exists
    // for was the one case where a lead could not even see where its worker
    // should report.
    const agentId = "cmuxlayerCodex-stable-resume-contract";
    const parentId = "cmuxlayerClaude-resume-parent";
    const resumeInboxDir = mkdtempSync(join(tmpdir(), "p11b-resume-inbox-"));
    const watchRegistryPath = join(resumeInboxDir, "watch-specs.json");
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(
      makeServerAgentRecord({
        agent_id: parentId,
        repo: "cmuxlayer",
        cli: "claude",
        role: "orchestrator",
        state: "ready",
        surface_id: "surface:parent",
      }),
    );
    stateMgr.writeState(
      makeServerAgentRecord({
        agent_id: agentId,
        repo: "brainlayer",
        cli: "codex",
        state: "done",
        surface_id: "surface:old",
        cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        parent_agent_id: parentId,
        spawn_depth: 1,
      }),
    );
    const expected = issueCoordinationContract(agentId, {
      baseDir: resumeInboxDir,
    });
    mkdirSync(join(resumeInboxDir, agentId), { recursive: true });
    writeFileSync(expected.report_path, "", "utf8");
    const oldWatch = await armWatch(
      {
        owner: parentId,
        subject_agent_id: agentId,
        target: expected.report_path,
        change: "content",
        deadline: Number.MAX_SAFE_INTEGER,
      },
      { registryPath: watchRegistryPath },
    );
    appendFileSync(expected.report_path, "first revision\n", "utf8");
    await sweepWatches({
      registryPath: watchRegistryPath,
      notify: async () => true,
    });
    expect(
      readWatchRegistry({ registryPath: watchRegistryPath }).watches.find(
        (watch) => watch.watch_id === oldWatch.watch_id,
      )?.state,
    ).toBe("armed");
    const exec = makeLifecycleExec();
    const server = createTrackedServer({
      exec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      inboxBaseDir: resumeInboxDir,
      watchRegistryPath,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    const spawn = (server as any)._registeredTools["spawn_agent"];

    try {
      const result = await spawn.handler(
        { resume_agent_id: agentId },
        {} as any,
      );
      const parsed = parseToolResult(result) as Record<string, any>;
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(parsed.resumed).toBe(true);

      // Byte-identical to what the original spawn issued -- both strings derive
      // from agent_id alone, which is why refreshing is safe and idempotent.
      expect(parsed.report_path).toBe(expected.report_path);
      expect(parsed.done_marker).toBe(expected.done_marker);
      expect(parsed.contract_path).toBe(
        coordinationContractPath(agentId, { baseDir: resumeInboxDir }),
      );
      const file = readFileSync(parsed.contract_path, "utf8");
      expect(file).toContain(expected.report_path);
      expect(file).toContain(expected.done_marker);

      // The honest half: nothing was typed into the resuming pane, and the
      // receipt must say so rather than inheriting the spawn path's `true`.
      expect(parsed.coordination_footer_delivered).toBe(false);
      expect(parsed.coordination_footer_note).toMatch(
        /refreshed_not_redelivered/,
      );

      // Persisted, so the closure consumer reads what resume issued.
      const stateTool = (server as any)._registeredTools["get_agent_state"];
      const detail = parseToolResult(
        await stateTool.handler({ agent_id: agentId }, {} as any),
      ) as Record<string, unknown>;
      expect(detail.report_path).toBe(expected.report_path);
      expect(detail.done_marker).toBe(expected.done_marker);
      const reportWatches = readWatchRegistry({
        registryPath: watchRegistryPath,
      }).watches.filter(
        (watch) =>
          watch.owner === parentId && watch.target === expected.report_path,
      );
      expect(reportWatches).toHaveLength(1);
      expect(reportWatches[0]).toMatchObject({
        subject_agent_id: agentId,
        change: "content",
        state: "armed",
      });
    } finally {
      rmSync(resumeInboxDir, { recursive: true, force: true });
    }
  });

  it("rejects a resumed agent's report path when a live sibling owns it", async () => {
    const agentId = "cmuxlayerCodex-resume-path-collision";
    const siblingId = "cmuxlayerCodex-live-sibling";
    const parentId = "cmuxlayerClaude-resume-collision-parent";
    const resumeInboxDir = mkdtempSync(
      join(tmpdir(), "resume-path-collision-"),
    );
    const watchRegistryPath = join(resumeInboxDir, "watch-specs.json");
    const sharedReportPath = join(resumeInboxDir, "shared", "report.md");
    const stateMgr = new StateManager(TEST_DIR);
    for (const record of [
      makeServerAgentRecord({
        agent_id: parentId,
        role: "orchestrator",
        state: "ready",
        surface_id: "surface:parent",
      }),
      makeServerAgentRecord({
        agent_id: agentId,
        state: "done",
        surface_id: "surface:old",
        cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
        parent_agent_id: parentId,
        spawn_depth: 1,
      }),
      makeServerAgentRecord({
        agent_id: siblingId,
        state: "ready",
        surface_id: "surface:sibling",
        parent_agent_id: parentId,
        spawn_depth: 1,
      }),
    ]) {
      stateMgr.writeState(record);
    }
    mkdirSync(join(resumeInboxDir, "shared"), { recursive: true });
    writeFileSync(sharedReportPath, "working\n", "utf8");
    await armWatch(
      {
        owner: parentId,
        subject_agent_id: siblingId,
        target: sharedReportPath,
        change: "content",
        deadline: Number.MAX_SAFE_INTEGER,
      },
      { registryPath: watchRegistryPath },
    );
    const exec = makeLifecycleExec();
    const server = createTrackedServer({
      exec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      inboxBaseDir: resumeInboxDir,
      watchRegistryPath,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const splitCalls = () =>
      exec.mock.calls.filter(([, args]) => args.includes("new-split")).length;
    const before = splitCalls();

    try {
      const result = await spawn.handler(
        { resume_agent_id: agentId, report_path: sharedReportPath },
        {} as any,
      );
      const parsed = parseToolResult(result) as Record<string, unknown>;

      expect(parsed.ok).toBe(false);
      expect(parsed.error_code).toBe("REPORT_PATH_IN_USE");
      expect(String(parsed.error)).toMatch(/already assigned.*sibling/i);
      expect(splitCalls()).toBe(before);
      expect(
        readWatchRegistry({ registryPath: watchRegistryPath }).watches,
      ).toHaveLength(1);
    } finally {
      rmSync(resumeInboxDir, { recursive: true, force: true });
    }
  });

  it("spawn_agent accepts placement as the canonical role-placement argument", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "brainlayer",
        cli: "claude",
        placement: "worker",
      },
      {} as any,
    );

    expect(parseToolResult(result)).toMatchObject({ ok: true, role: "worker" });
  });

  it("spawn_agent refuses a manual-mode caller workspace before spawning", async () => {
    const baseExec = makeLifecycleExec();
    const exec = vi.fn().mockImplementation(async (cmd, args) => {
      if (Array.isArray(args) && args.includes("list-status")) {
        return {
          stdout: JSON.stringify([{ key: "mode.control", value: "manual" }]),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec as ExecFn);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(parsed).toMatchObject({
      ok: false,
      error_code: "manual_mode",
      tool: "spawn_agent",
      workspace: "workspace:1",
    });
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["list-status", "--workspace", "workspace:1"]),
    );
    expect(
      exec.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("new-split"),
      ),
    ).toBe(false);
  });

  it("spawn_agent rechecks manual mode immediately before placement mutation", async () => {
    const baseExec = makeLifecycleExec();
    let modeReads = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args) => {
      if (Array.isArray(args) && args.includes("list-status")) {
        modeReads += 1;
        return {
          stdout: JSON.stringify(
            modeReads === 1 ? [] : [{ key: "mode.control", value: "manual" }],
          ),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec as ExecFn);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(parseToolResult(result)).toMatchObject({
      ok: false,
      error_code: "manual_mode",
    });
    expect(modeReads).toBeGreaterThanOrEqual(2);
    expect(
      exec.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("new-split"),
      ),
    ).toBe(false);
    expect(
      exec.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("new-surface"),
      ),
    ).toBe(false);
  });

  it("spawn_agent uses the repo workspace before the selected workspace when caller env is absent", async () => {
    const calls: string[] = [];
    let launchSent = false;
    let pendingBootText = "";
    let bootSubmitted = false;
    const mockClient = {
      createWorkspace: vi.fn(),
      selectWorkspace: vi.fn().mockImplementation(async (workspace: string) => {
        calls.push(`select:${workspace}`);
      }),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:1",
            title: "Collab",
            selected: true,
            current_directory: "/repo/orchestrator",
          },
          {
            ref: "workspace:5",
            title: "SkillCreator",
            selected: false,
            current_directory: "/repo/skillcreator",
          },
        ],
      }),
      listPanes: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:5",
        window_ref: "window:1",
        panes: [],
      }),
      listPaneSurfaces: vi.fn().mockResolvedValue({
        workspace_ref: "workspace:5",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [],
      }),
      newSplit: vi.fn().mockImplementation(async (_direction, opts) => {
        calls.push(`spawn:${opts.workspace}`);
        return {
          workspace: opts.workspace,
          surface: "surface:inherit",
          pane: "pane:inherit",
          title: "",
          type: "terminal",
        };
      }),
      newSurface: vi.fn(),
      focusSurface: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockImplementation(async (_surface, text: string) => {
        if (!launchSent) launchSent = true;
        else pendingBootText += text;
      }),
      sendKey: vi.fn().mockImplementation(async (_surface, key: string) => {
        if (key === "return" && pendingBootText) bootSubmitted = true;
      }),
      readScreen: vi.fn().mockImplementation(async () => ({
        surface: "surface:inherit",
        text: !pendingBootText
          ? "OpenAI Codex\ncodex> "
          : bootSubmitted
            ? `${pendingBootText}\nOpenAI Codex\nWorking (1s)`
            : `OpenAI Codex\n› ${pendingBootText}\ngpt-5.5 high · ~/repo`,
        lines: 20,
        scrollback_used: false,
      })),
      log: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      setProgress: vi.fn().mockResolvedValue(undefined),
      closeSurface: vi.fn().mockResolvedValue(undefined),
      listSurfaces: vi.fn().mockResolvedValue([
        {
          ref: "surface:inherit",
          title: "skillcreatorCodex",
          type: "terminal",
          index: 0,
          selected: true,
          workspace_ref: "workspace:5",
        },
      ]),
      identify: vi.fn().mockResolvedValue({}),
      browser: vi.fn().mockResolvedValue({}),
    };
    const server = createTrackedServer(
      {
        client: mockClient as any,
        stateDir: TEST_DIR,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
      },
      false,
    );
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "skillcreator",
        model: "gpt-5.5",
        cli: "codex",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.workspace_id).toBe("workspace:5");
    expect(calls).toContain("spawn:workspace:5");
    expect(calls).not.toContain("spawn:workspace:1");
  });

  it("spawn_agent prefers the caller pane workspace over the selected workspace when workspace is omitted", async () => {
    const previousWorkspaceId = process.env.CMUX_WORKSPACE_ID;
    const previousTabId = process.env.CMUX_TAB_ID;
    process.env.CMUX_WORKSPACE_ID = "selected-workspace-uuid";
    delete process.env.CMUX_TAB_ID;

    try {
      const calls: string[] = [];
      let launchSent = false;
      let pendingBootText = "";
      let bootSubmitted = false;
      const mockClient = {
        createWorkspace: vi.fn(),
        selectWorkspace: vi
          .fn()
          .mockImplementation(async (workspace: string) => {
            calls.push(`select:${workspace}`);
          }),
        listWorkspaces: vi.fn().mockResolvedValue({
          workspaces: [
            {
              id: "caller-workspace-uuid",
              ref: "workspace:1",
              title: "Voice Remediation",
              selected: false,
              current_directory: "/repo/voicelayer",
            },
            {
              id: "selected-workspace-uuid",
              ref: "workspace:5",
              title: "Other Active Workspace",
              selected: true,
              current_directory: "/repo/t3layer",
            },
          ],
        }),
        listPanes: vi.fn().mockImplementation(async ({ workspace }) => ({
          workspace_ref: workspace,
          window_ref: "window:1",
          panes: [],
        })),
        listPaneSurfaces: vi.fn().mockImplementation(async ({ workspace }) => ({
          workspace_ref: workspace,
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [],
        })),
        newSplit: vi.fn().mockImplementation(async (_direction, opts) => {
          calls.push(`spawn:${opts.workspace}`);
          return {
            workspace: opts.workspace,
            surface: "surface:caller",
            pane: "pane:caller",
            title: "",
            type: "terminal",
          };
        }),
        newSurface: vi.fn(),
        focusSurface: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation(async (_surface, text: string) => {
          if (!launchSent) launchSent = true;
          else pendingBootText += text;
        }),
        sendKey: vi.fn().mockImplementation(async (_surface, key: string) => {
          if (key === "return" && pendingBootText) bootSubmitted = true;
        }),
        readScreen: vi.fn().mockImplementation(async () => ({
          surface: "surface:caller",
          text: !pendingBootText
            ? "OpenAI Codex\ncodex> "
            : bootSubmitted
              ? `${pendingBootText}\nOpenAI Codex\nWorking (1s)`
              : `OpenAI Codex\n› ${pendingBootText}\ngpt-5.5 high · ~/repo`,
          lines: 20,
          scrollback_used: false,
        })),
        log: vi.fn().mockResolvedValue(undefined),
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        setProgress: vi.fn().mockResolvedValue(undefined),
        closeSurface: vi.fn().mockResolvedValue(undefined),
        listSurfaces: vi.fn().mockResolvedValue([
          {
            ref: "surface:caller",
            title: "voicelayerCodex",
            type: "terminal",
            index: 0,
            selected: true,
            workspace_ref: "workspace:1",
          },
        ]),
        identify: vi.fn().mockResolvedValue({}),
        browser: vi.fn().mockResolvedValue({}),
      };
      const server = createTrackedServer({
        client: mockClient as any,
        stateDir: TEST_DIR,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
      });
      const tool = (server as any)._registeredTools["spawn_agent"];

      const result = await runWithCallerContext(
        { workspaceId: "caller-workspace-uuid" },
        () =>
          tool.handler(
            {
              repo: "voicelayer",
              model: "gpt-5.5",
              cli: "codex",
            },
            {} as any,
          ),
      );
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);

      expect(parsed.ok).toBe(true);
      expect(parsed.workspace_id).toBe("workspace:1");
      expect(calls).toContain("spawn:workspace:1");
      expect(calls).not.toContain("spawn:workspace:5");
    } finally {
      if (previousWorkspaceId === undefined) {
        delete process.env.CMUX_WORKSPACE_ID;
      } else {
        process.env.CMUX_WORKSPACE_ID = previousWorkspaceId;
      }
      if (previousTabId === undefined) {
        delete process.env.CMUX_TAB_ID;
      } else {
        process.env.CMUX_TAB_ID = previousTabId;
      }
    }
  });

  it("spawn_agent refuses an explicit workspace owned by another repo before mutation", async () => {
    const baseExec = makeLifecycleExec();
    const exec = vi.fn().mockImplementation(async (cmd, args) => {
      if (Array.isArray(args) && args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:brainlayer",
                title: "brainlayer",
                selected: false,
                current_directory: "/home/test-user/Gits/brainlayer",
              },
              {
                ref: "workspace:t3layer",
                title: "t3layer",
                selected: true,
                current_directory: "/home/test-user/Gits/t3layer",
              },
            ],
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec as ExecFn);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
        workspace: "workspace:t3layer",
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(
      /workspace.*t3layer.*brainlayer|brainlayer.*workspace.*t3layer/i,
    );
    expect(
      exec.mock.calls.some(
        ([, args]) =>
          Array.isArray(args) &&
          (args.includes("new-split") || args.includes("new-surface")),
      ),
    ).toBe(false);
  });

  it("spawn_agent allows an explicit workspace whose cwd does not identify a repo", async () => {
    const baseExec = makeLifecycleExec();
    const exec = vi.fn().mockImplementation(async (cmd, args) => {
      if (Array.isArray(args) && args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:brainlayer",
                title: "brainlayerClaude",
                selected: true,
                current_directory: "/home/test-user",
              },
            ],
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec as ExecFn);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
        workspace: "workspace:brainlayer",
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(
      exec.mock.calls.some(
        ([, args]) =>
          Array.isArray(args) &&
          (args.includes("new-split") || args.includes("new-surface")),
      ),
    ).toBe(true);
  });

  it("spawn_agent preserves parent workspace inheritance when workspace is omitted", async () => {
    const previousWorkspaceId = process.env.CMUX_WORKSPACE_ID;
    process.env.CMUX_WORKSPACE_ID = "workspace:caller";
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    const parentRecord: AgentRecord = {
      agent_id: "parent-codex",
      surface_id: "surface:parent",
      workspace_id: "workspace:parent",
      state: "working",
      repo: "brainlayer",
      model: "gpt-5.5",
      cli: "codex",
      cli_session_id: "019f0001-1111-7222-8333-444455556666",
      cli_session_path: null,
      task_summary: "parent mission",
      pid: null,
      version: 1,
      created_at: "2026-04-16T00:00:00Z",
      updated_at: "2026-04-16T00:00:00Z",
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
      boot_prompt_pending: false,
      launch_cwd: null,
      mcp_profile: null,
      worktree_path: null,
      worktree_branch: null,
    };
    engine.stateMgr.writeState(parentRecord);
    engine.getRegistry().set(parentRecord.agent_id, parentRecord);
    mockExec.mockClear();

    try {
      const result = await spawn.handler(
        {
          repo: "brainlayer",
          model: "gpt-5.5",
          cli: "codex",
          role: "worker",
          parent_agent_id: parentRecord.agent_id,
        },
        {} as any,
      );
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);
      const splitCall = mockExec.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes("new-split"),
      );

      expect(parsed.ok).toBe(true);
      expect(splitCall?.[1]).toEqual(
        expect.arrayContaining(["--workspace", "workspace:parent"]),
      );
      expect(splitCall?.[1]).not.toEqual(
        expect.arrayContaining(["--workspace", "workspace:caller"]),
      );
    } finally {
      if (previousWorkspaceId === undefined) {
        delete process.env.CMUX_WORKSPACE_ID;
      } else {
        process.env.CMUX_WORKSPACE_ID = previousWorkspaceId;
      }
    }
  });

  it("#378 binding: a worker caller forces reviewer-Claude to worker and records parentage", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    const parent = makeServerAgentRecord({
      agent_id: "cmuxlayerCodex-parent",
      surface_id: "surface:caller",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      cli: "codex",
      role: "worker",
      task_summary: "Implement #379",
      task_done_detected_at: null,
    });
    engine.stateMgr.writeState(parent);
    engine.getRegistry().set(parent.agent_id, parent);
    mockExec.mockClear();

    const result = await runWithCallerContext(
      { workspaceId: "workspace:1", surfaceId: parent.surface_id },
      () =>
        spawn.handler(
          {
            repo: "cmuxlayer",
            cli: "claude",
            role: "orchestrator",
            prompt: "Review PR #380",
            force_new: true,
          },
          {} as any,
        ),
    );
    const parsed = parseToolResult(result);
    const child = engine.getAgentState(parsed.agent_id);

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      role: "worker",
      authority: "worker",
      placement: "right",
    });
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/worker caller.*forced.*role.*worker/i),
      ]),
    );
    expect(child).toMatchObject({
      cli: "claude",
      role: "worker",
      parent_agent_id: parent.agent_id,
      spawn_depth: 1,
    });
  });

  it("#378 MEDIUM-A: a terminal caller record cannot shadow the live registry on a reused surface", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    const deadWorker = makeServerAgentRecord({
      agent_id: "cmuxlayerCodex-dead",
      surface_id: "surface:reused",
      workspace_id: "workspace:1",
      state: "done",
      repo: "cmuxlayer",
      cli: "codex",
      role: "worker",
      task_done_detected_at: "2026-08-10T00:00:00Z",
    });
    const liveLead = makeServerAgentRecord({
      agent_id: "cmuxlayerClaude-live",
      surface_id: "surface:reused",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      cli: "claude",
      role: "orchestrator",
      task_done_detected_at: null,
    });
    engine.stateMgr.writeState(deadWorker);
    engine.stateMgr.writeState(liveLead);
    engine.getRegistry().set(deadWorker.agent_id, deadWorker);
    engine.getRegistry().set(liveLead.agent_id, liveLead);
    mockExec.mockClear();

    const result = await runWithCallerContext(
      { workspaceId: "workspace:1", surfaceId: "surface:reused" },
      () =>
        spawn.handler(
          {
            repo: "cmuxlayer",
            cli: "claude",
            role: "orchestrator",
            prompt: "Lead the next task",
            force_new: true,
          },
          {} as any,
        ),
    );
    const parsed = parseToolResult(result);
    const child = engine.getAgentState(parsed.agent_id);

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed.role).toBe("orchestrator");
    expect(parsed.warnings ?? []).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/worker caller/i)]),
    );
    expect(child).toMatchObject({
      role: "orchestrator",
      parent_agent_id: liveLead.agent_id,
      spawn_depth: 1,
    });
  });

  it("F1: a caller whose registry record went stale-done is still recorded as parent", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    // #408 poisons the record of a live lead within minutes. Under the old
    // terminal-state filter this caller was invisible, so the child it spawned
    // got parent_agent_id:null -- the U6 violation observed live.
    const staleLead = makeServerAgentRecord({
      agent_id: "cmuxlayerClaude-stale",
      surface_id: "surface:caller",
      workspace_id: "workspace:1",
      state: "done",
      repo: "cmuxlayer",
      cli: "claude",
      role: "orchestrator",
      task_done_detected_at: "2026-08-18T00:00:00Z",
      // #468: a managed seat carries this observer's stamp -- spawn writes it.
      // The ref-only caller tier now requires it, because a ref stamped by a
      // dead generation (or never stamped) cannot prove who occupies it now.
      surface_observer_id: "cmux:/tmp/cmuxlayer-test.sock",
    });
    engine.stateMgr.writeState(staleLead);
    engine.getRegistry().set(staleLead.agent_id, staleLead);
    mockExec.mockClear();

    const result = await runWithCallerContext(
      { workspaceId: "workspace:1", surfaceId: staleLead.surface_id },
      () =>
        spawn.handler(
          {
            repo: "cmuxlayer",
            cli: "claude",
            role: "reviewer",
            prompt: "Review PR #456",
            force_new: true,
          },
          {} as any,
        ),
    );
    const parsed = parseToolResult(result);
    const child = engine.getAgentState(parsed.agent_id);

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed.parent_agent_id).toBe(staleLead.agent_id);
    expect(child).toMatchObject({
      parent_agent_id: staleLead.agent_id,
      spawn_depth: 1,
    });
  });

  it("F1: the #378 worker guard still fires for a stale-done worker caller", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    const staleWorker = makeServerAgentRecord({
      agent_id: "cmuxlayerCodex-staleworker",
      surface_id: "surface:caller",
      workspace_id: "workspace:1",
      state: "done",
      repo: "cmuxlayer",
      cli: "codex",
      role: "worker",
      task_done_detected_at: "2026-08-18T00:00:00Z",
      // #468: see the note on the stale-lead fixture above.
      surface_observer_id: "cmux:/tmp/cmuxlayer-test.sock",
    });
    engine.stateMgr.writeState(staleWorker);
    engine.getRegistry().set(staleWorker.agent_id, staleWorker);
    mockExec.mockClear();

    const result = await runWithCallerContext(
      { workspaceId: "workspace:1", surfaceId: staleWorker.surface_id },
      () =>
        spawn.handler(
          {
            repo: "cmuxlayer",
            cli: "claude",
            role: "orchestrator",
            prompt: "Review PR #380",
            force_new: true,
          },
          {} as any,
        ),
    );
    const parsed = parseToolResult(result);
    const child = engine.getAgentState(parsed.agent_id);

    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      role: "worker",
      authority: "worker",
      placement: "right",
    });
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/worker caller.*forced.*role.*worker/i),
      ]),
    );
    expect(child).toMatchObject({
      role: "worker",
      parent_agent_id: staleWorker.agent_id,
    });
  });

  it("stop_agent logs a durable close entry carrying caller, force, and target", async () => {
    const server = createLifecycleServer(mockExec);
    const stopTool = (server as any)._registeredTools["stop_agent"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    // Seed a terminal agent so stopAgent short-circuits (no surface teardown),
    // isolating the handler's own close-event emission.
    const record = makeServerAgentRecord({
      agent_id: "codex-golems-stopme",
      surface_id: "surface:stopme",
      state: "done",
    });
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(record.agent_id, record);

    await stopTool.handler(
      { agent_id: record.agent_id, force: false },
      {} as any,
    );

    const stopEvents = readCloseEvents(TEST_DIR).filter(
      (e) => e.event === "stop_agent",
    );
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0]).toMatchObject({
      event_type: "close",
      event: "stop_agent",
      target: "codex-golems-stopme",
      force: false,
      refused: false,
    });
    expect(typeof stopEvents[0].caller).toBe("string");
    expect((stopEvents[0].caller as string).length).toBeGreaterThan(0);
    expect(typeof stopEvents[0].ts).toBe("string");
  });

  it("close_surface scope=agent preserves the stop_agent path", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const close = (server as any)._registeredTools["close_surface"];

    const result = await close.handler(
      { scope: "agent", agent_id: "missing-agent", force: true },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result)).toMatchObject({
      ok: false,
      scope: "agent",
      error: expect.stringMatching(/agent not found/i),
    });
  });

  it("kill logs a durable close entry per killed agent with caller and force", async () => {
    const server = createLifecycleServer(mockExec);
    const killTool = (server as any)._registeredTools["kill"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    const record = makeServerAgentRecord({
      agent_id: "codex-golems-killme",
      surface_id: "surface:killme",
      state: "done",
    });
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(record.agent_id, record);

    const result = await killTool.handler(
      { target: record.agent_id, force: true },
      {} as any,
    );
    const parsed = parseToolResult(result);
    expect(parsed.killed).toContain("codex-golems-killme");

    const killEvents = readCloseEvents(TEST_DIR).filter(
      (e) => e.event === "kill",
    );
    expect(killEvents).toHaveLength(1);
    expect(killEvents[0]).toMatchObject({
      event_type: "close",
      event: "kill",
      target: "codex-golems-killme",
      force: true,
      refused: false,
    });
    expect(typeof killEvents[0].caller).toBe("string");
  });

  it("spawn_agent warns when an existing same-lane idle agent can be reused", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const firstResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
        workspace: "ws:1",
      },
      {} as any,
    );
    const first =
      firstResult.structuredContent ?? JSON.parse(firstResult.content[0].text);
    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const firstRecord = registry.get(first.agent_id);
    registry.set(first.agent_id, { ...firstRecord, state: "idle" });

    const secondResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
        workspace: "ws:1",
      },
      {} as any,
    );
    const second =
      secondResult.structuredContent ??
      JSON.parse(secondResult.content[0].text);

    expect(second.ok).toBe(true);
    expect(second.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Existing same-lane agent/),
      ]),
    );
    expect(second.duplicate_spawn_warning).toBeUndefined();
    expect(second.existing_same_lane_agents).toBeUndefined();
  });

  it("spawn_agent force_new suppresses same-lane duplicate warnings", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const firstResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
        workspace: "ws:1",
      },
      {} as any,
    );
    const first =
      firstResult.structuredContent ?? JSON.parse(firstResult.content[0].text);
    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const firstRecord = registry.get(first.agent_id);
    registry.set(first.agent_id, { ...firstRecord, state: "ready" });

    const secondResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
        workspace: "ws:1",
        force_new: true,
      },
      {} as any,
    );
    const second =
      secondResult.structuredContent ??
      JSON.parse(secondResult.content[0].text);

    expect(second.ok).toBe(true);
    expect(second.warnings).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Existing same-lane agent/),
      ]),
    );
    expect(second.duplicate_spawn_warning).toBeUndefined();
    expect(second.existing_same_lane_agents).toBeUndefined();
  });

  it("spawn_agent accepts an omitted model and resolves the CLI default", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        cli: "claude",
        prompt: "fix gap F",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.model).toBe("claude-opus-5[1m]");
    expect(parsed.requested_model).toBe("");
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "brainlayerClaude -s"]),
    );

    const stateTool = (server as any)._registeredTools["get_agent_state"];
    const stateResult = await stateTool.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const persisted =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(persisted.model).toBe("claude-opus-5[1m]");
  });

  it("spawn_agent coerces legacy placement=ic to worker and reports the compatibility correction", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const args = tool.inputSchema.parse({
      repo: "brainlayer",
      model: "sonnet",
      cli: "claude",
      role: "implementor",
      placement: "ic",
      prompt: "coordinate task",
    });
    const result = await tool.handler(args, {} as any);

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed).toMatchObject({
      role: "implementor",
      authority: "worker",
      placement: "right",
    });
    expect(parsed.warnings.join(" | ")).toMatch(
      /legacy.*ic.*worker|ic.*coerc.*worker/i,
    );
    expect(parsed.health).toBeUndefined();

    const stateTool = (server as any)._registeredTools["get_agent_state"];
    const stateResult = await stateTool.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const persisted =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(persisted.role).toBe("worker");
  });

  it("spawn_agent sends inline prompt after the agent is ready", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "fix prompt delivery",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "--surface", "surface:new"]),
    );
    expect(
      mockExec.mock.calls.some(
        ([, args]) =>
          args.includes("set-buffer") &&
          String(args.at(-1) ?? "").includes("fix prompt delivery"),
      ),
    ).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send-key",
        "--surface",
        "surface:new",
        "return",
      ]),
    );
  });

  it("spawn_agent routes its boot prompt through the stable UUID after readiness moves", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const foreignUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const baseExec = makeLifecycleExec({ surfaceUuid: stableUuid });
    let launcherSent = false;
    let moved = false;
    mockExec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (
        args.includes("send") &&
        /brainlayerCodex\s+-s/.test(String(args.at(-1) ?? ""))
      ) {
        launcherSent = true;
      }
      if (moved && args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:1",
                index: 0,
                focused: true,
                surface_count: 2,
                surface_refs: ["surface:new", "surface:moved"],
                surface_ids: [foreignUuid, stableUuid],
                selected_surface_ref: "surface:moved",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (moved && args.includes("list-pane-surfaces")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: "pane:1",
            surfaces: [
              {
                id: foreignUuid,
                ref: "surface:new",
                title: "foreignCodex",
                type: "terminal",
                index: 0,
                selected: false,
              },
              {
                id: stableUuid,
                ref: "surface:moved",
                title: "brainlayerCodex",
                type: "terminal",
                index: 1,
                selected: true,
              },
            ],
          }),
          stderr: "",
        };
      }

      const result = await baseExec(cmd, args);
      if (launcherSent && !moved && args.includes("read-screen")) {
        moved = true;
      }
      return result;
    });
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "UUID-bound boot prompt",
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(
      mockExec.mock.calls.some(
        ([, args]) =>
          args.includes("set-buffer") &&
          String(args.at(-1) ?? "").includes("UUID-bound boot prompt"),
      ),
    ).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["paste-buffer", "--surface", "surface:moved"]),
    );
  });

  it("spawn_agent blocks the internal boot_prompt mutation when control becomes manual", async () => {
    const baseExec = makeLifecycleExec({
      surfaceUuid: "11111111-2222-4333-8444-555555555555",
    });
    let launcherSent = false;
    mockExec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (args.includes("list-status")) {
        return {
          stdout: JSON.stringify([
            {
              key: "mode.control",
              value: launcherSent ? "manual" : "autonomous",
            },
          ]),
          stderr: "",
        };
      }
      const result = await baseExec(cmd, args);
      if (
        args.includes("send") &&
        /brainlayerCodex\s+-s/.test(String(args.at(-1) ?? ""))
      ) {
        launcherSent = true;
      }
      return result;
    });
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "must not type in manual mode",
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/boot prompt.*manual mode/i);
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["send", "must not type in manual mode"]),
    );
  });

  it("spawn_agent canonicalizes a ws: alias and delivers inline prompts to the requested workspace", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];
    const prompt = "fix placement mismatch prompt delivery";

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace_id).toBe("workspace:1");
    expect(parsed.actual_workspace_id).toBeUndefined();

    const promptBufferCall = mockExec.mock.calls.find(([, args]) => {
      const argv = args as string[];
      return (
        argv.includes("set-buffer") &&
        String(argv.at(-1) ?? "").includes(prompt)
      );
    });
    expect(promptBufferCall).toBeDefined();
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["paste-buffer", "--workspace", "workspace:1"]),
    );
  });

  it("spawn_agent delivers prompts to the resolved workspace when cmux returns an empty workspace", async () => {
    const exec = makeLifecycleExec({ createdWorkspace: "" });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_agent"];
    const prompt = "empty backend workspace fallback";

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt,
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect(parsed.ok).toBe(true);
    const promptBufferCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, args]) => {
        const argv = args as string[];
        return (
          argv.includes("set-buffer") &&
          String(argv.at(-1) ?? "").includes(prompt)
        );
      },
    );
    expect(promptBufferCall).toBeDefined();
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["paste-buffer", "--workspace", "workspace:1"]),
    );
  });

  it("spawn_agent deliberately allowed inline prompts preserve blank lines without empty chunks", async () => {
    const baseExec = makeLifecycleExec();
    const prompt = `${"a".repeat(500)}\n\n${"b".repeat(600)}`;
    const buffers = new Map<string, string>();
    let promptPasted = false;
    let promptSubmitted = false;
    let pastedPrompt = "";
    mockExec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (args.includes("set-buffer")) {
        const chunk = String(args.at(-1) ?? "");
        if (chunk.trim().length === 0) {
          throw new Error("set-buffer requires text");
        }
        const nameIndex = args.indexOf("--name");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : "default";
        buffers.set(name, chunk);
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("paste-buffer")) {
        promptPasted = true;
        const nameIndex = args.indexOf("--name");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : "default";
        pastedPrompt = buffers.get(name) ?? "";
        return { stdout: "{}", stderr: "" };
      }
      if (
        args.includes("send-key") &&
        args.includes("return") &&
        promptPasted
      ) {
        promptSubmitted = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen") && promptPasted) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: promptSubmitted
              ? `${pastedPrompt}\ngpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)`
              : [
                  ">_ OpenAI Codex",
                  `› ${pastedPrompt}`,
                  "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer",
                ].join("\n"),
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt,
        allow_long_inline: true,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const chunks = mockExec.mock.calls
      .filter(([, args]) => Array.isArray(args) && args.includes("set-buffer"))
      .map(([, args]) => String(args.at(-1) ?? ""));

    expect(parsed.ok).toBe(true);
    expect(parsed.boot_prompt_delivered).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.trim().length > 0)).toBe(true);
    expect(
      chunks.every((chunk) => Buffer.byteLength(chunk, "utf-8") <= 16_000),
    ).toBe(true);
    expect(chunks.join("")).toContain(prompt);
    expect(chunks.join("")).toContain("cmuxlayer contract for");
    expect(chunks.join("")).toContain("\n\n");
  });

  it("spawn_agent canonicalizes the agent id after session capture renames pending state", async () => {
    const sessionId = "019ec0e6-1111-2222-3333-444455556666";
    let finalAgentId: string | null = null;
    let renamed = false;
    const baseExec = makeLifecycleExec();
    mockExec = vi.fn().mockImplementation(async (cmd, args) => {
      if (
        !renamed &&
        args.includes("set-buffer") &&
        String(args.at(-1) ?? "").includes("probe renamed state")
      ) {
        renamed = true;
        finalAgentId = renameOnlyAgentStateToSession(sessionId);
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        prompt: "probe renamed state",
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(finalAgentId);
    expect(parsed.agent_id).toBe("cmuxlayerCodex-019ec0e6");
    expect(parsed.boot_prompt_delivered).toBe(true);

    const stateTool = (server as any)._registeredTools["get_agent_state"];
    const stateResult = await stateTool.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const persisted =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(persisted.boot_prompt_pending).toBe(false);
    expect(persisted.prompt_delivered).toBe(true);
    expect(persisted.submit_verified).toBe(true);
    expect(persisted.task_summary).toBe("probe renamed state");
  });

  it("spawn_agent with worktree launches from the worktree and inherits MCPs by default", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "cmuxlayer");
    mkdirSync(repoRoot, { recursive: true });
    const worktreeExec = vi.fn().mockImplementation(async () => {
      mkdirSync(join(gitsDir, "cmuxlayer", ".worktrees", "skill-eval"), {
        recursive: true,
      });
      return { stdout: "", stderr: "" };
    });
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        role: "worker",
        worktree: {
          name: "skill eval",
          branch: "fix/skill-eval",
          base: "origin/main",
        },
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const worktreePath = join(gitsDir, "cmuxlayer", ".worktrees", "skill-eval");
    expect(parsed.ok).toBe(true);
    expect(parsed.worktree).toMatchObject({
      path: worktreePath,
      branch: "fix/skill-eval",
      created: true,
      reused: false,
    });
    expect(parsed.mcp_profile).toBeUndefined();
    expect(parsed.worktree).not.toHaveProperty("node_modules_linked");
    expect(parsed.worktree).not.toHaveProperty("mcp_json_copied");
    expect(worktreeExec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-b",
      "fix/skill-eval",
      worktreePath,
      "origin/main",
    ]);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        `cmuxlayerCodex -s --worker -w '${worktreePath}'`,
      ]),
    );
  });

  it("spawn_agent resolves a mismatched repo key from the launcher registry path", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "skill-creator");
    const registryPath = join(TEST_DIR, "launchers.zsh");
    const worktreePath = join(repoRoot, ".worktrees", "registry-root");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(registryPath, `repoGolem skillcreator "${repoRoot}"\n`);
    vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
    const worktreeExec = vi.fn().mockImplementation(async () => {
      mkdirSync(worktreePath, { recursive: true });
      return { stdout: "", stderr: "" };
    });
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "skillcreator",
        cli: "codex",
        role: "worker",
        worktree: { name: "registry-root" },
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.worktree.path).toBe(worktreePath);
    expect(worktreeExec).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["-C", repoRoot, "worktree", "add"]),
    );
    expect(worktreeExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["-C", join(gitsDir, "skillcreator")]),
    );
  });

  it("spawn_agent supports a registry repo path outside the Gits directory without redirecting", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(TEST_DIR, ".config", "ralph");
    const registryPath = join(TEST_DIR, "launchers-outside-gits.zsh");
    const worktreePath = join(repoRoot, ".worktrees", "outside-root");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(registryPath, `repoGolem ralph "${repoRoot}"\n`);
    vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
    const worktreeExec = vi.fn().mockImplementation(async () => {
      mkdirSync(worktreePath, { recursive: true });
      return { stdout: "", stderr: "" };
    });
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "ralph",
        cli: "codex",
        role: "worker",
        worktree: { name: "outside-root" },
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.worktree.path).toBe(worktreePath);
    expect(
      worktreeExec.mock.calls.some(([, args]) =>
        args.includes(join(gitsDir, "ralph")),
      ),
    ).toBe(false);
  });

  it("spawn_agent rejects an unresolvable repo before worktree or focus mutation", async () => {
    const registryPath = join(TEST_DIR, "launchers-missing-repo.zsh");
    writeFileSync(
      registryPath,
      `repoGolem cmuxlayer "${join(TEST_DIR, "Gits", "cmuxlayer")}"\n`,
    );
    vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
    const lifecycleExec = makeLifecycleExec();
    const exec = vi.fn().mockImplementation(lifecycleExec);
    const worktreeExec = vi.fn();
    const server = createTrackedServer({
      exec,
      stateDir: TEST_DIR,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: join(TEST_DIR, "Gits"),
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "wt-eval-scratch",
        cli: "codex",
        role: "worker",
        worktree: true,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    // Registry-optional (#392): an unregistered repo now falls through to the
    // raw-CLI path, which still refuses when the repo exists nowhere on disk.
    expect(parsed.error).toMatch(
      /Cannot resolve a working directory for repo "wt-eval-scratch".*Searched:/s,
    );
    expect(worktreeExec).not.toHaveBeenCalled();
    expect(
      exec.mock.calls.some(
        ([, args]) =>
          args.includes("select-workspace") || args.includes("surface.focus"),
      ),
    ).toBe(false);
  });

  it("spawn_agent rolls back a newly created worktree and branch when spawning fails", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(TEST_DIR, ".config", "ralph");
    const registryPath = join(TEST_DIR, "launchers-rollback.zsh");
    const worktreePath = join(repoRoot, ".worktrees", "spawn-failure");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(registryPath, `repoGolem ralph "${repoRoot}"\n`);
    vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
    const worktreeExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("worktree") && args.includes("add")) {
        mkdirSync(worktreePath, { recursive: true });
      }
      if (args.includes("worktree") && args.includes("remove")) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      return { stdout: "", stderr: "" };
    });
    const lifecycleExec = makeLifecycleExec();
    const failingExec = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes("new-split") || args.includes("new-surface")) {
        throw new Error("deliberate spawn failure");
      }
      return lifecycleExec(cmd, args);
    });
    const server = createTrackedServer({
      exec: failingExec,
      stateDir: TEST_DIR,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "ralph",
        cli: "codex",
        role: "worker",
        worktree: {
          name: "spawn-failure",
          branch: "wt/spawn-failure",
        },
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("deliberate spawn failure");
    expect(worktreeExec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    expect(worktreeExec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "branch",
      "-D",
      "wt/spawn-failure",
    ]);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("spawn_agent preserves a newly created worktree when a recoverable surface survives", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "cmuxlayer");
    const worktreePath = join(repoRoot, ".worktrees", "recoverable-surface");
    mkdirSync(repoRoot, { recursive: true });
    const worktreeExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("worktree") && args.includes("add")) {
        mkdirSync(worktreePath, { recursive: true });
      }
      return { stdout: "", stderr: "" };
    });
    const lifecycleExec = makeLifecycleExec();
    const failingFocusExec = vi.fn().mockImplementation(async (cmd, args) => {
      if (
        args.includes("rpc") &&
        args.includes("surface.focus") &&
        args.some((value) => String(value).includes("surface:new"))
      ) {
        throw new Error("deliberate created-surface focus failure");
      }
      return lifecycleExec(cmd, args);
    });
    const server = createTrackedServer({
      exec: failingFocusExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        role: "worker",
        worktree: {
          name: "recoverable-surface",
          branch: "wt/recoverable-surface",
        },
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("deliberate created-surface focus failure");
    expect(parsed.surface_id).toBe("surface:new");
    expect(worktreeExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "remove"]),
    );
    expect(worktreeExec).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["branch", "-D"]),
    );
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("spawn_agent closes a failed launcher surface before rolling back its new worktree", async () => {
    vi.useFakeTimers();
    try {
      const gitsDir = join(TEST_DIR, "Gits");
      const repoRoot = join(TEST_DIR, ".config", "ralph-launch-failure");
      const registryPath = join(
        TEST_DIR,
        "launchers-post-surface-rollback.zsh",
      );
      const worktreePath = join(repoRoot, ".worktrees", "post-surface-failure");
      mkdirSync(repoRoot, { recursive: true });
      writeFileSync(registryPath, `repoGolem ralph "${repoRoot}"\n`);
      vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
      const worktreeExec = vi.fn().mockImplementation(async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) {
          mkdirSync(worktreePath, { recursive: true });
        }
        if (args.includes("worktree") && args.includes("remove")) {
          rmSync(worktreePath, { recursive: true, force: true });
        }
        return { stdout: "", stderr: "" };
      });
      const baseExec = makeLifecycleExec({ surfaceUuid: "surface-uuid:new" });
      let launcherSent = false;
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        if (
          args.includes("send") &&
          /ralphCodex\b/.test(String(args.at(-1) ?? ""))
        ) {
          launcherSent = true;
          return { stdout: "{}", stderr: "" };
        }
        if (launcherSent && args.includes("read-screen")) {
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text: "zsh: command not found: ralphCodex\n$ ",
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(cmd, args);
      });
      const server = createTrackedServer({
        exec,
        stateDir: TEST_DIR,
        sessionIdentityResolver: () => null,
        worktreeHomeDir: gitsDir,
        worktreeExec,
      });
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = spawn.handler(
        {
          repo: "ralph",
          cli: "codex",
          role: "worker",
          worktree: {
            name: "post-surface-failure",
            branch: "wt/post-surface-failure",
          },
          boot_prompt_timeout_ms: 20,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const parsed = parseToolResult(await resultPromise);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("zsh: command not found: ralphCodex");
      expect(parsed.surface_id).toBe("surface:new");
      expect(exec).toHaveBeenCalledWith(
        "cmux",
        expect.arrayContaining(["close-surface", "surface-uuid:new"]),
      );
      expect(worktreeExec).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["worktree", "remove", "--force", worktreePath]),
      );
      expect(worktreeExec).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["branch", "-D", "wt/post-surface-failure"]),
      );
      const getState = (server as any)._registeredTools["get_agent_state"];
      const state = parseToolResult(
        await getState.handler({ agent_id: parsed.agent_id }, {} as any),
      );
      expect(state.state).toBe("error");
      expect(existsSync(worktreePath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent waits through an 800ms launcher first-paint delay without cleanup", async () => {
    vi.useFakeTimers();
    try {
      const baseExec = makeLifecycleExec();
      let launcherSentAt: number | null = null;
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        const text = String(args.at(-1) ?? "");
        if (args.includes("send") && text === "voicelayerCodex -s --worker") {
          launcherSentAt = Date.now();
          return { stdout: "{}", stderr: "" };
        }
        if (
          launcherSentAt !== null &&
          args.includes("send-key") &&
          args.includes("return")
        ) {
          return { stdout: "{}", stderr: "" };
        }
        if (launcherSentAt !== null && args.includes("read-screen")) {
          const elapsed = Date.now() - launcherSentAt;
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text: elapsed < 800 ? "$ voicelayerCodex -s --worker" : "codex> ",
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(cmd, args);
      });
      const server = createLifecycleServer(exec);
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = spawn.handler(
        {
          repo: "voicelayer",
          model: "codex",
          cli: "codex",
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(launcherSentAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(3_000);
      const parsed = parseToolResult(await resultPromise);

      expect(parsed.error).toBeUndefined();
      expect(parsed).toMatchObject({ ok: true });
      expect(
        exec.mock.calls.some(([, args]) => args.includes("close-surface")),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent ignores transient shell-rc errors above percentage boot progress", async () => {
    vi.useFakeTimers();
    try {
      const gitsDir = join(TEST_DIR, "Gits");
      const repoRoot = join(TEST_DIR, ".config", "ralph-progress");
      const registryPath = join(TEST_DIR, "launchers-progress.zsh");
      const worktreePath = join(repoRoot, ".worktrees", "boot-progress");
      mkdirSync(repoRoot, { recursive: true });
      writeFileSync(registryPath, `repoGolem ralph "${repoRoot}"\n`);
      vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
      const worktreeExec = vi.fn().mockImplementation(async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) {
          mkdirSync(worktreePath, { recursive: true });
        }
        return { stdout: "", stderr: "" };
      });
      const baseExec = makeLifecycleExec();
      let launcherSentAt: number | null = null;
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        if (
          args.includes("send") &&
          /ralphCodex\b/.test(String(args.at(-1) ?? ""))
        ) {
          launcherSentAt = Date.now();
          return { stdout: "{}", stderr: "" };
        }
        if (launcherSentAt !== null && args.includes("read-screen")) {
          const elapsed = Date.now() - launcherSentAt;
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text:
                elapsed < 500
                  ? "zsh: command not found: pyenv\n⠋ Installing... 62%"
                  : "codex> ",
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(cmd, args);
      });
      const server = createTrackedServer({
        exec,
        stateDir: TEST_DIR,
        sessionIdentityResolver: () => null,
        worktreeHomeDir: gitsDir,
        worktreeExec,
      });
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = spawn.handler(
        {
          repo: "ralph",
          cli: "codex",
          role: "worker",
          worktree: {
            name: "boot-progress",
            branch: "wt/boot-progress",
          },
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(launcherSentAt).not.toBeNull();
      await vi.advanceTimersByTimeAsync(3_000);
      const parsed = parseToolResult(await resultPromise);

      expect(parsed).toMatchObject({ ok: true });
      expect(
        exec.mock.calls.some(([, args]) => args.includes("close-surface")),
      ).toBe(false);
      expect(worktreeExec).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["worktree", "remove"]),
      );
      expect(existsSync(worktreePath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent keeps a generic launch-timeout surface and worktree recoverable", async () => {
    vi.useFakeTimers();
    try {
      const gitsDir = join(TEST_DIR, "Gits");
      const repoRoot = join(TEST_DIR, ".config", "ralph-timeout");
      const registryPath = join(TEST_DIR, "launchers-timeout.zsh");
      const worktreePath = join(repoRoot, ".worktrees", "launch-timeout");
      mkdirSync(repoRoot, { recursive: true });
      writeFileSync(registryPath, `repoGolem ralph "${repoRoot}"\n`);
      vi.stubEnv("CMUXLAYER_LAUNCHER_REGISTRY_PATH", registryPath);
      const worktreeExec = vi.fn().mockImplementation(async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) {
          mkdirSync(worktreePath, { recursive: true });
        }
        return { stdout: "", stderr: "" };
      });
      const exec = makeLifecycleExec({ shellNeverReady: true });
      const server = createTrackedServer({
        exec,
        stateDir: TEST_DIR,
        sessionIdentityResolver: () => null,
        worktreeHomeDir: gitsDir,
        worktreeExec,
      });
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = spawn.handler(
        {
          repo: "ralph",
          cli: "codex",
          role: "worker",
          worktree: {
            name: "launch-timeout",
            branch: "wt/launch-timeout",
          },
          boot_prompt_timeout_ms: 20,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const parsed = parseToolResult(await resultPromise);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("waiting for shell readiness");
      expect(
        exec.mock.calls.some(([, args]) => args.includes("close-surface")),
      ).toBe(false);
      expect(worktreeExec).not.toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["worktree", "remove"]),
      );
      expect(existsSync(worktreePath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("new_worktree_split rolls back a newly created worktree and branch when spawning fails", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "cmuxlayer");
    const worktreePath = join(repoRoot, ".worktrees", "legacy-spawn-failure");
    mkdirSync(repoRoot, { recursive: true });
    const worktreeExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("worktree") && args.includes("add")) {
        mkdirSync(worktreePath, { recursive: true });
      }
      if (args.includes("worktree") && args.includes("remove")) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      return { stdout: "", stderr: "" };
    });
    const lifecycleExec = makeLifecycleExec();
    const failingExec = vi.fn().mockImplementation(async (cmd, args) => {
      if (args.includes("new-split") || args.includes("new-surface")) {
        throw new Error("deliberate legacy spawn failure");
      }
      return lifecycleExec(cmd, args);
    });
    const server = createTrackedServer({
      exec: failingExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["new_worktree_split"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        worktree: {
          name: "legacy-spawn-failure",
          branch: "wt/legacy-spawn-failure",
        },
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("deliberate legacy spawn failure");
    expect(worktreeExec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    expect(worktreeExec).toHaveBeenCalledWith("git", [
      "-C",
      repoRoot,
      "branch",
      "-D",
      "wt/legacy-spawn-failure",
    ]);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("new_worktree_split launches a worker with the requested MCP profile", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "cmuxlayer");
    mkdirSync(repoRoot, { recursive: true });
    const worktreeExec = vi.fn().mockImplementation(async () => {
      mkdirSync(join(gitsDir, "cmuxlayer", ".worktrees", "sterile-worker"), {
        recursive: true,
      });
      return { stdout: "", stderr: "" };
    });
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["new_worktree_split"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        worktree: { name: "sterile worker" },
        mcp_profile: "sterile",
        verbose: true,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const worktreePath = join(
      gitsDir,
      "cmuxlayer",
      ".worktrees",
      "sterile-worker",
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.role).toBe("worker");
    expect(parsed.mcp_profile).toBe("sterile");
    expect(parsed.worktree).toHaveProperty("node_modules_linked");
    expect(parsed.worktree).toHaveProperty("mcp_json_copied");
    expect(parsed.worktree.path).toBe(worktreePath);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        `CMUXLAYER_MCP_PROFILE=sterile cmuxlayerCodex -s --worker -w '${worktreePath}'`,
      ]),
    );
  });

  it("new_worktree_split publishes its worktree cwd through the injected manifest writer", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    mkdirSync(join(gitsDir, "cmuxlayer"), { recursive: true });
    const worktreePath = join(
      gitsDir,
      "cmuxlayer",
      ".worktrees",
      "manifest-worker",
    );
    const worktreeExec = vi.fn().mockImplementation(async () => {
      mkdirSync(worktreePath, { recursive: true });
      return { stdout: "", stderr: "" };
    });
    const manifests: SeatManifest[] = [];
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
      seatManifestWriter: async (manifest) => manifests.push(manifest),
      seatManifestNow: () => "2026-07-12T12:00:00.000Z",
    });
    const tool = (server as any)._registeredTools["new_worktree_split"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        worktree: { name: "manifest worker" },
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(manifests).toEqual([
      expect.objectContaining({
        surface_id: "surface:new",
        agent_id: parsed.agent_id,
        tab_name: "cmuxlayerCodex [surface:new]",
        model: "codex",
        permission_mode: "skip-permissions",
        cwd: worktreePath,
        repo: "cmuxlayer",
        cli: "codex",
      }),
    ]);
  });

  it("interact model refreshes the manifest with the deliberate model pin", async () => {
    const manifests: SeatManifest[] = [];
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      seatManifestWriter: async (manifest) => manifests.push(manifest),
      seatManifestNow: () => "2026-07-12T12:00:00.000Z",
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const interact = (server as any)._registeredTools["interact"];
    const spawnResult = await spawn.handler(
      {
        repo: "cmuxlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "start model-pin test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    manifests.length = 0;

    await interact.handler(
      { agent: agentId, action: "model", model: "fable-5" },
      {} as any,
    );

    expect(manifests).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        tab_name: "cmuxlayerClaude [surface:new]",
        model: "fable-5",
      }),
    ]);
  });

  it("rename_tab refreshes the manifest with the deliberate tab title", async () => {
    const manifests: SeatManifest[] = [];
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      seatManifestWriter: async (manifest) => manifests.push(manifest),
      seatManifestNow: () => "2026-07-12T12:00:00.000Z",
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const rename = (server as any)._registeredTools["rename_tab"];
    const spawnResult = await spawn.handler(
      { repo: "cmuxlayer", model: "sonnet", cli: "claude" },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    manifests.length = 0;

    await rename.handler(
      { surface: "surface:new", title: "cmuxlayerClaude [review-seat]" },
      {} as any,
    );

    expect(manifests).toEqual([
      expect.objectContaining({
        agent_id: agentId,
        tab_name: "cmuxlayerClaude [review-seat]",
        model: "sonnet",
      }),
    ]);
  });

  it("send_input rename_to_task refreshes the manifest after the task rename", async () => {
    const manifests: SeatManifest[] = [];
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      seatManifestWriter: async (manifest) => manifests.push(manifest),
      seatManifestNow: () => "2026-07-12T12:00:00.000Z",
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendInput = (server as any)._registeredTools["send_input"];
    await spawn.handler(
      { repo: "cmuxlayer", model: "sonnet", cli: "claude" },
      {} as any,
    );
    manifests.length = 0;

    await sendInput.handler(
      {
        surface: "surface:new",
        text: "status",
        press_enter: false,
        rename_to_task: "audit",
      },
      {} as any,
    );

    expect(manifests).toEqual([
      expect.objectContaining({
        surface_id: "surface:new",
        tab_name: "agent-pane: audit",
      }),
    ]);
  });

  it("a bare Vitest server never writes to the real or overridden manifest directory", async () => {
    const manifestDir = join(TEST_DIR, "must-stay-absent");
    const previous = process.env.CMUXLAYER_SEAT_MANIFEST_DIR;
    process.env.CMUXLAYER_SEAT_MANIFEST_DIR = manifestDir;
    try {
      const server = createLifecycleServer(mockExec);
      const spawn = (server as any)._registeredTools["spawn_agent"];
      await spawn.handler(
        { repo: "cmuxlayer", model: "sonnet", cli: "claude" },
        {} as any,
      );

      expect(existsSync(manifestDir)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.CMUXLAYER_SEAT_MANIFEST_DIR;
      } else {
        process.env.CMUXLAYER_SEAT_MANIFEST_DIR = previous;
      }
    }
  });

  it("new_worktree_split defaults to the caller workspace instead of the selected workspace", async () => {
    const previousWorkspaceId = process.env.CMUX_WORKSPACE_ID;
    const previousTabId = process.env.CMUX_TAB_ID;
    process.env.CMUX_WORKSPACE_ID = "selected-workspace-uuid";
    delete process.env.CMUX_TAB_ID;
    try {
      const gitsDir = join(TEST_DIR, "Gits");
      const repoRoot = join(gitsDir, "cmuxlayer");
      mkdirSync(repoRoot, { recursive: true });
      const worktreeExec = vi.fn().mockImplementation(async () => {
        mkdirSync(join(gitsDir, "cmuxlayer", ".worktrees", "caller-worker"), {
          recursive: true,
        });
        return { stdout: "", stderr: "" };
      });
      const calls: string[] = [];
      const mockClient = {
        createWorkspace: vi.fn(),
        selectWorkspace: vi
          .fn()
          .mockImplementation(async (workspace: string) => {
            calls.push(`select:${workspace}`);
          }),
        listWorkspaces: vi.fn().mockResolvedValue({
          workspaces: [
            {
              id: "caller-workspace-uuid",
              ref: "workspace:caller",
              title: "Caller",
              selected: false,
              current_directory: repoRoot,
            },
            {
              id: "selected-workspace-uuid",
              ref: "workspace:selected",
              title: "Selected",
              selected: true,
              current_directory: "/repo/voicelayer",
            },
          ],
        }),
        listPanes: vi.fn().mockImplementation(async ({ workspace }) => ({
          workspace_ref: workspace,
          window_ref: "window:1",
          panes: [],
        })),
        listPaneSurfaces: vi.fn().mockImplementation(async ({ workspace }) => ({
          workspace_ref: workspace,
          window_ref: "window:1",
          pane_ref: "pane:1",
          surfaces: [],
        })),
        newSplit: vi.fn().mockImplementation(async (_direction, opts) => {
          calls.push(`spawn:${opts.workspace}`);
          return {
            workspace: opts.workspace,
            surface: "surface:caller-worktree",
            pane: "pane:caller-worktree",
            title: "",
            type: "terminal",
          };
        }),
        newSurface: vi.fn(),
        focusSurface: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        sendKey: vi.fn().mockResolvedValue(undefined),
        readScreen: vi.fn().mockResolvedValue({
          surface: "surface:caller-worktree",
          text: "OpenAI Codex\ncodex> ",
          lines: 1,
          scrollback_used: false,
        }),
        log: vi.fn().mockResolvedValue(undefined),
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        setProgress: vi.fn().mockResolvedValue(undefined),
        closeSurface: vi.fn().mockResolvedValue(undefined),
        listSurfaces: vi.fn().mockResolvedValue([
          {
            ref: "surface:caller-worktree",
            title: "cmuxlayerCodex",
            type: "terminal",
            index: 0,
            selected: true,
            workspace_ref: "workspace:caller",
          },
        ]),
        identify: vi.fn().mockResolvedValue({}),
        browser: vi.fn().mockResolvedValue({}),
      };
      const server = createTrackedServer({
        client: mockClient as any,
        stateDir: TEST_DIR,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
        worktreeHomeDir: gitsDir,
        worktreeExec,
      });
      const tool = (server as any)._registeredTools["new_worktree_split"];

      const result = await runWithCallerContext(
        { workspaceId: "caller-workspace-uuid" },
        () =>
          tool.handler(
            {
              repo: "cmuxlayer",
              model: "codex",
              cli: "codex",
              worktree: { name: "caller worker" },
            },
            {} as any,
          ),
      );
      const parsed = parseToolResult(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.workspace_id).toBe("workspace:caller");
      expect(calls).toContain("spawn:workspace:caller");
      expect(calls).not.toContain("spawn:workspace:selected");
    } finally {
      if (previousWorkspaceId === undefined) {
        delete process.env.CMUX_WORKSPACE_ID;
      } else {
        process.env.CMUX_WORKSPACE_ID = previousWorkspaceId;
      }
      if (previousTabId === undefined) {
        delete process.env.CMUX_TAB_ID;
      } else {
        process.env.CMUX_TAB_ID = previousTabId;
      }
    }
  });

  it("new_worktree_split refuses a manual-mode caller workspace before worktree setup", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "cmuxlayer");
    mkdirSync(repoRoot, { recursive: true });
    const baseExec = makeLifecycleExec();
    const exec = vi.fn().mockImplementation(async (cmd, args) => {
      if (Array.isArray(args) && args.includes("list-status")) {
        return {
          stdout: JSON.stringify([{ key: "mode.control", value: "manual" }]),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const worktreeExec = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const server = createTrackedServer({
      exec: exec as ExecFn,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      worktreeHomeDir: gitsDir,
      worktreeExec,
    });
    const tool = (server as any)._registeredTools["new_worktree_split"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        model: "codex",
        cli: "codex",
        worktree: { name: "sterile worker" },
      },
      {} as any,
    );

    const parsed = parseToolResult(result);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(parsed).toMatchObject({
      ok: false,
      error_code: "manual_mode",
      tool: "new_worktree_split",
      workspace: "workspace:1",
    });
    expect(worktreeExec).not.toHaveBeenCalled();
    expect(
      exec.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("new-split"),
      ),
    ).toBe(false);
  });

  it("spawn_agent finalizes a pending Cursor prompt when the state directory is noncanonical", async () => {
    let movedStateDir = false;
    const baseExec = makeLifecycleExec();
    mockExec = vi.fn().mockImplementation(async (cmd, args) => {
      if (
        !movedStateDir &&
        args.includes("send") &&
        String(args.at(-1) ?? "") === "cmuxlayerCursor -s"
      ) {
        movedStateDir = true;
        moveOnlyAgentStateDir("legacy");
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const stop = (server as any)._registeredTools["stop_agent"];

    const result = await spawn.handler(
      {
        repo: "cmuxlayer",
        model: "",
        cli: "cursor",
        prompt: "Say VERIFY_OK and stop.",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toMatch(/^cmuxlayerCursor-[0-9a-f]{8}$/);
    expect(parsed.state).toBe("ready");
    expect(parsed.boot_prompt_delivered).toBe(true);

    const stopResult = await stop.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const stopped =
      stopResult.structuredContent ?? JSON.parse(stopResult.content[0].text);
    expect(stopped.ok).toBe(true);
    expect(stopped.state).toBe("done");
  });

  it("stop_agent returns an error when the stopped pane remains live", async () => {
    mockExec = makeLifecycleExec({ closeKeepsSurface: true });
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const stop = (server as any)._registeredTools["stop_agent"];

    const result = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "idle after stop",
      },
      {} as any,
    );
    const spawned =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    const stopResult = await stop.handler(
      { agent_id: spawned.agent_id },
      {} as any,
    );
    const stopped =
      stopResult.structuredContent ?? JSON.parse(stopResult.content[0].text);

    expect(stopResult.isError).toBe(true);
    expect(stopped.ok).toBe(false);
    expect(stopped.error).toMatch(/post-condition/i);
  });

  it("spawn_agent sends boot_prompt_path contents after readiness", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(
      mockExec.mock.calls.some(
        ([, args]) =>
          args.includes("set-buffer") &&
          String(args.at(-1) ?? "").includes("file prompt body"),
      ),
    ).toBe(true);
  });

  it("read_agent_output scans bounded tail lines by default", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["read_agent_output"];

    const result = await tool.handler(
      { surface: "surface:new", tag: "OUTPUT", lines: 80 },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.found).toBe(false);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "read-screen",
        "--surface",
        "surface:new",
        "--lines",
        "80",
      ]),
    );
    const readCalls = (mockExec as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("read-screen"),
    );
    expect(readCalls.at(-1)?.[1]).not.toContain("--scrollback");
  });

  it("read_agent_output can opt into full scrollback", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["read_agent_output"];

    await tool.handler(
      { surface: "surface:new", tag: "OUTPUT", lines: 80, scrollback: true },
      {} as any,
    );

    const readCalls = (mockExec as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("read-screen"),
    );
    expect(readCalls.at(-1)?.[1]).toContain("--scrollback");
  });

  it("spawn_agent retries Enter when the launcher command remains pending at the shell", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    let launcherReturnCount = 0;
    let promptDelivered = false;
    let lastSentText = "";
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:voice",
                title: "VoiceLayer",
                current_directory: "/home/test-user/Gits/voicelayer",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:voice",
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
            workspace_ref: "workspace:voice",
            window_ref: "window:1",
            pane_ref: "pane:1",
            surfaces: [
              {
                ref: "surface:new",
                title: "agent-pane",
                type: "terminal",
                index: 0,
                selected: true,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("send") || args.includes("set-buffer")) {
        lastSentText = String(args.at(-1) ?? "");
        if (lastSentText.includes("file prompt body")) {
          promptDelivered = true;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("send-key")) {
        if (lastSentText === "voicelayerCodex -s --worker") {
          launcherReturnCount += 1;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: lastSentText.includes("file prompt body")
              ? "gpt-5.5 xhigh · 99% left · ~/Gits/voicelayer\nWorking (1s • esc to interrupt)"
              : lastSentText === ""
                ? "$ "
                : launcherReturnCount < 2
                  ? "$ voicelayerCodex -s --worker"
                  : "codex> ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          workspace: "workspace:voice",
          surface: "surface:new",
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    });
    const server = createTrackedServer(
      {
        exec: mockExec,
        stateDir: TEST_DIR,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
      },
      false,
    );
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "voicelayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 5_000,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace_id).toBe("workspace:voice");
    expect(launcherReturnCount).toBe(2);
    expect(promptDelivered).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "read-screen",
        "--workspace",
        "workspace:voice",
        "--surface",
        "surface:new",
      ]),
    );
    expect(
      mockExec.mock.calls.some(
        ([, args]) =>
          args.includes("set-buffer") &&
          String(args.at(-1) ?? "").includes("file prompt body"),
      ),
    ).toBe(true);
  }, 10_000);

  it("spawn_agent fails with decorated-prompt pending evidence when Return never submits", async () => {
    vi.useFakeTimers();
    try {
      const baseExec = makeLifecycleExec();
      let launcherSent = false;
      let launcherReturns = 0;
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        const text = String(args.at(-1) ?? "");
        if (args.includes("send") && text === "voicelayerCodex -s --worker") {
          launcherSent = true;
          return { stdout: "{}", stderr: "" };
        }
        if (
          launcherSent &&
          args.includes("send-key") &&
          args.includes("return")
        ) {
          launcherReturns += 1;
          return { stdout: "{}", stderr: "" };
        }
        if (launcherSent && args.includes("read-screen")) {
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text: "bash-5.2$ voicelayerCodex -s --worker",
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(cmd, args);
      });
      const server = createLifecycleServer(exec);
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = spawn.handler(
        {
          repo: "voicelayer",
          model: "codex",
          cli: "codex",
          boot_prompt_timeout_ms: 20,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      const parsed = parseToolResult(await resultPromise);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(
        "launcher command remained pending after Return",
      );
      expect(parsed.last_10_lines).toContain(
        "bash-5.2$ voicelayerCodex -s --worker",
      );
      expect(launcherReturns).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent recovers a human-prefixed launcher line with ctrl-u then retypes", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "";
    let humanPrefix = "ng ";
    let launched = false;
    let ctrlUCount = 0;
    let typedLaunches = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        typedLaunches += 1;
        composer += `${humanPrefix}${command}`;
        humanPrefix = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: launched
              ? "cursor> \nWorking (1s • esc to interrupt)"
              : `$ ${composer}`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 400,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBeGreaterThanOrEqual(1);
    expect(ctrlUCount).toBeLessThanOrEqual(2);
    expect(typedLaunches).toBeGreaterThanOrEqual(2);
    expect(launched).toBe(true);
  }, 10_000);

  it("spawn_agent does not ctrl-u a clean pending launcher line", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "";
    let launched = false;
    let ctrlUCount = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        composer += command;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: launched
              ? "cursor> \nWorking (1s • esc to interrupt)"
              : `$ ${composer}`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 5_000,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBe(0);
    expect(launched).toBe(true);
  }, 10_000);

  it("spawn_agent treats an empty prompt after human Enter as already submitted", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let launched = false;
    let ctrlUCount = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        launched = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: launched ? "cursor> \nWorking (1s • esc to interrupt)" : "$ ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 5_000,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBe(0);
  }, 10_000);

  it("spawn_agent errors when launcher-line corruption recovery is exhausted", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "";
    let ctrlUCount = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        composer = `ng ${command}`;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: `$ ${composer}`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 400,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain(
      "launcher line corrupted by external input; manual Enter may have executed a modified command",
    );
    expect(ctrlUCount).toBe(2);
    const getState = (server as any)._registeredTools["get_agent_state"];
    const state = parseToolResult(
      await getState.handler({ agent_id: parsed.agent_id }, {} as any),
    );
    expect(state.state).toBe("error");
    expect(String(state.error)).toContain(
      "launcher line corrupted by external input",
    );
    const list = (server as any)._registeredTools["list_agents"];
    const listed = parseToolResult(
      await list.handler({ state: "error" }, {} as any),
    );
    const listedAgent = (
      listed.agents as Array<{
        agent_id?: string;
        state?: string;
      }>
    ).find((agent) => agent.agent_id === parsed.agent_id);
    expect(listedAgent?.state).toBe("error");
  }, 10_000);

  it("spawn_agent does not ctrl-u a healthy booting pane with echoed launcher output", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let sent = false;
    let ctrlUCount = 0;
    let readyReads = 0;
    const bootScreen = [
      "etanheyman ~  $ voicelayerCursor -s",
      "[4] 55084",
      "Starting Cursor Agent...",
    ].join("\n");
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        sent = true;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        if (sent) {
          readyReads += 1;
        }
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text:
              sent && readyReads > 2
                ? "cursor> \nWorking (1s • esc to interrupt)"
                : sent
                  ? bootScreen
                  : "$ ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 5_000,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBe(0);
  }, 10_000);

  it("spawn_agent recovers interleaved human characters inside the launcher command", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "";
    let launched = false;
    let ctrlUCount = 0;
    let typedLaunches = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        typedLaunches += 1;
        composer = typedLaunches === 1 ? "voicelayerCurng sor -s" : command;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: launched
              ? "cursor> \nWorking (1s • esc to interrupt)"
              : `$ ${composer}`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 400,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBeGreaterThanOrEqual(1);
    expect(ctrlUCount).toBeLessThanOrEqual(2);
    expect(typedLaunches).toBeGreaterThanOrEqual(2);
    expect(launched).toBe(true);
  }, 10_000);

  it("spawn_agent clears junk on the shell-readiness prompt before typing the launcher", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "wenfnng";
    let launched = false;
    let ctrlUCount = 0;
    let typedLaunches = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        typedLaunches += 1;
        composer = command;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: launched
              ? "cursor> \nWorking (1s • esc to interrupt)"
              : `etanheyman ~  $ ${composer}`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBeGreaterThanOrEqual(1);
    expect(ctrlUCount).toBeLessThanOrEqual(3);
    expect(typedLaunches).toBe(1);
    expect(launched).toBe(true);
    expect(parsed.readiness_recovered).toBe(true);
    expect(parsed.readiness_cleared).toEqual(
      expect.arrayContaining(["wenfnng"]),
    );
  }, 10_000);

  it("spawn_agent ctrl-u during readiness prevents human Enter from executing typed garbage", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "sjnfjdnsf";
    let launched = false;
    let ctrlUCount = 0;
    let reads = 0;
    const executed: string[] = [];
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        composer = command;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (composer.trim() && composer.trim() !== command) {
          executed.push(composer.trim());
          composer = "";
        } else if (composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        reads += 1;
        if (
          reads > 4 &&
          composer.trim() &&
          composer.trim() !== command &&
          !executed.includes(composer.trim())
        ) {
          executed.push(composer.trim());
          composer = "";
        }
        const screen = launched
          ? "cursor> \nWorking (1s • esc to interrupt)"
          : executed.length > 0 && composer.trim() === ""
            ? `zsh: command not found: ${executed[0]}\netanheyman ~  $ `
            : `etanheyman ~  $ ${composer}`;
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: screen,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBeGreaterThanOrEqual(1);
    expect(executed).toEqual([]);
    expect(launched).toBe(true);
    expect(parsed.readiness_recovered).toBe(true);
    expect(parsed.readiness_cleared).toEqual(
      expect.arrayContaining(["sjnfjdnsf"]),
    );
  }, 10_000);

  it("spawn_agent does not claim a clean boot after clearing readiness junk", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "";
    let launched = false;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        composer = command;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: launched
              ? "cursor> \nWorking (1s • esc to interrupt)"
              : `$ ${composer}`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(launched).toBe(true);
    expect(parsed.readiness_recovered).toBeUndefined();
    expect(parsed.readiness_cleared).toBeUndefined();
  }, 10_000);

  it("spawn_agent recovers junk in both the readiness window and the typed launcher line", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "wenfnng";
    let launched = false;
    let ctrlUCount = 0;
    let typedLaunches = 0;
    let humanPrefix = "ng ";
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        typedLaunches += 1;
        composer = `${humanPrefix}${command}`;
        humanPrefix = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: launched
              ? "cursor> \nWorking (1s • esc to interrupt)"
              : `etanheyman ~  $ ${composer}`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBeGreaterThanOrEqual(2);
    expect(typedLaunches).toBeGreaterThanOrEqual(2);
    expect(launched).toBe(true);
    expect(parsed.readiness_recovered).toBe(true);
    expect(parsed.readiness_cleared).toEqual(
      expect.arrayContaining(["wenfnng"]),
    );
  }, 10_000);

  it("spawn_agent falls back to ctrl-c when readiness junk survives ctrl-u", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let composer = "gjrbgjbrgjrbgjrbgjrgbjrgbjrgbjrgb";
    let launched = false;
    let ctrlUCount = 0;
    let ctrlCCount = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && text === command) {
        composer = command;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-c")) {
        ctrlCCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: launched
              ? "cursor> \nWorking (1s • esc to interrupt)"
              : `etanheyman ~  $ ${composer}`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const parsed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(ctrlUCount).toBeGreaterThanOrEqual(1);
    expect(ctrlCCount).toBeGreaterThanOrEqual(1);
    expect(launched).toBe(true);
    expect(parsed.readiness_recovered).toBe(true);
  }, 10_000);

  it("spawn_agent closes a junk shell that never becomes ready after bounded clears", async () => {
    vi.useFakeTimers();
    try {
      const baseExec = makeLifecycleExec({ surfaceUuid: "surface-uuid:new" });
      let ctrlUCount = 0;
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        if (args.includes("send-key") && args.includes("ctrl-u")) {
          ctrlUCount += 1;
          return { stdout: "{}", stderr: "" };
        }
        if (args.includes("read-screen")) {
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text: "etanheyman ~  $ wenfnng",
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(cmd, args);
      });
      const server = createLifecycleServer(exec);
      const spawn = (server as any)._registeredTools["spawn_agent"];
      const resultPromise = spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 8_000,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(9_000);
      const parsed = parseToolResult(await resultPromise);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("waiting for shell readiness");
      expect(parsed.last_10_lines).toEqual(
        expect.arrayContaining(["etanheyman ~  $ wenfnng"]),
      );
      expect(ctrlUCount).toBe(3);
      expect(exec).toHaveBeenCalledWith(
        "cmux",
        expect.arrayContaining(["close-surface", "surface-uuid:new"]),
      );
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("spawn_agent does not reuse a failed spawn's readiness_recovered on a recycled surface id", async () => {
    const command = "voicelayerCursor -s";
    const baseExec = makeLifecycleExec();
    let spawnCount = 0;
    let composer = "";
    let sentLauncher = false;
    let launched = false;
    let ctrlUCount = 0;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("new-split")) {
        spawnCount += 1;
        composer = spawnCount === 1 ? "wenfnng" : "";
        sentLauncher = false;
        launched = false;
      }
      if (args.includes("send") && text === command) {
        sentLauncher = true;
        composer = command;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("ctrl-u")) {
        ctrlUCount += 1;
        composer = "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key") && args.includes("return")) {
        if (spawnCount > 1 && composer.trim() === command) {
          launched = true;
          composer = "";
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("read-screen")) {
        const screen =
          spawnCount === 1 && sentLauncher
            ? "zsh: command not found: voicelayerCursor\n$ "
            : launched
              ? "cursor> \nWorking (1s • esc to interrupt)"
              : `etanheyman ~  $ ${composer}`;
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: screen,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      const result = await baseExec(cmd, args);
      if (
        typeof result.stdout === "string" &&
        result.stdout.includes("surface:")
      ) {
        return {
          ...result,
          stdout: result.stdout.replace(/surface:new-\d+/g, "surface:new"),
        };
      }
      return result;
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const failed = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      ),
    );
    expect(failed.ok).toBe(false);
    expect(failed.surface_id).toBe("surface:new");
    expect(ctrlUCount).toBeGreaterThanOrEqual(1);
    expect(String(failed.error)).toMatch(
      /Launcher exited before reaching readiness/,
    );
    const context = serverContexts.at(-1)!;
    expect(context.launchShellRecoveryBySurface.size).toBe(0);
    expect(context.originalLaunchCommandsBySurface.size).toBe(0);

    const reused = parseToolResult(
      await spawn.handler(
        {
          repo: "voicelayer",
          cli: "cursor",
          boot_prompt_timeout_ms: 2_000,
        },
        {} as any,
      ),
    );

    expect(reused.ok).toBe(true);
    expect(reused.surface_id).toBe("surface:new");
    expect(launched).toBe(true);
    expect(reused.readiness_recovered).toBeUndefined();
    expect(reused.readiness_cleared).toBeUndefined();
  }, 15_000);

  it("spawn_agent treats launch submit verification as advisory when readiness appears with shell history", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    let launcherReturnCount = 0;
    let promptDelivered = false;
    let lastSentText = "";
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:voice",
                title: "VoiceLayer",
                current_directory: "/home/test-user/Gits/voicelayer",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:voice",
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
            workspace_ref: "workspace:voice",
            window_ref: "window:1",
            pane_ref: "pane:1",
            surfaces: [
              {
                ref: "surface:new",
                title: "agent-pane",
                type: "terminal",
                index: 0,
                selected: true,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("send") || args.includes("set-buffer")) {
        lastSentText = String(args.at(-1) ?? "");
        if (lastSentText.includes("file prompt body")) {
          promptDelivered = true;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("send-key")) {
        if (lastSentText === "voicelayerCodex -s --worker") {
          launcherReturnCount += 1;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: lastSentText.includes("file prompt body")
              ? "gpt-5.5 xhigh · 99% left · ~/Gits/voicelayer\nWorking (1s • esc to interrupt)"
              : lastSentText === ""
                ? "$ "
                : "$ voicelayerCodex -s --worker\ncodex> ",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          workspace: "workspace:voice",
          surface: "surface:new",
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    });
    const server = createTrackedServer(
      {
        exec: mockExec,
        stateDir: TEST_DIR,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
      },
      false,
    );
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "voicelayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 1_000,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(launcherReturnCount).toBe(1);
    expect(promptDelivered).toBe(true);
  });

  it("spawn_agent stores boot_prompt_path contents as boot_prompt_text and a short task_summary", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const actualAgentId =
      engine.getAgentState(agentId)?.agent_id ??
      engine.stateMgr
        .listStates()
        .find((agent: AgentRecord) => agent.repo === "brainlayer")?.agent_id ??
      agentId;

    const stateResult = await getState.handler(
      { agent_id: actualAgentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(state.boot_prompt_text).toBe("file prompt body");
    expect(state.task_summary).toBe("mandate.md");
  });

  it("spawn_agent rejects prompt and boot_prompt_path together", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "inline",
        boot_prompt_path: promptPath,
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("mutually exclusive");
  });

  it("spawn_agent rejects missing boot_prompt_path before creating a surface", async () => {
    const server = createLifecycleServer(mockExec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        boot_prompt_path: join(TEST_DIR, "missing.md"),
      },
      {} as any,
    );

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("ENOENT");
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["new-split"]),
    );
  });

  it("spawn_agent applies boot_prompt_timeout_ms to initial shell readiness", async () => {
    vi.useFakeTimers();
    try {
      const server = createLifecycleServer(
        makeLifecycleExec({ shellNeverReady: true }),
      );
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const spawnArgs = spawn.inputSchema.parse({
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "readiness timeout contract",
        boot_prompt_timeout_ms: 90_000,
      });
      const resultPromise = spawn.handler(spawnArgs, {} as any);
      await vi.advanceTimersByTimeAsync(90_100);
      const result = await resultPromise;
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(
        "Timed out after 90000ms waiting for shell readiness",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["user in ~/repo > ", "❯ ", "› ", "» "])(
    "spawn_agent launches from a ready %s shell prompt",
    async (shellPrompt) => {
      const server = createLifecycleServer(makeLifecycleExec({ shellPrompt }));
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const result = await spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          boot_prompt_timeout_ms: 20,
        },
        {} as any,
      );
      const parsed = parseToolResult(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.surface_id).toBe("surface:new");
    },
  );

  it("spawn terminal preserves created identity when cwd delivery fails", async () => {
    const baseExec = makeLifecycleExec();
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (
        args.includes("send") &&
        String(args.at(-1) ?? "").startsWith("cd -- ")
      ) {
        throw new Error("deliberate terminal cwd failure");
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      {
        version: 1,
        type: "terminal",
        cwd: "/tmp/cmuxlayer-p7-terminal",
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("deliberate terminal cwd failure");
    expect(parsed.surface_id).toBe("surface:new");
    expect(parsed.workspace_id).toBe("workspace:1");
  });

  it("spawn_agent preserves the 10000ms shell-readiness default when no override is supplied", async () => {
    vi.useFakeTimers();
    try {
      const server = createLifecycleServer(
        makeLifecycleExec({ shellNeverReady: true }),
      );
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const spawnArgs = spawn.inputSchema.parse({
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "default readiness timeout contract",
      });
      const resultPromise = spawn.handler(spawnArgs, {} as any);
      await vi.advanceTimersByTimeAsync(60_100);
      const result = await resultPromise;
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(
        "Timed out after 10000ms waiting for shell readiness",
      );
      expect(parsed.error).not.toContain("60000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent reports the created agent and surface when initial shell readiness fails", async () => {
    vi.useFakeTimers();
    try {
      const server = createLifecycleServer(
        makeLifecycleExec({
          createdWorkspace: "ws:1",
          shellNeverReady: true,
        }),
      );
      const spawn = (server as any)._registeredTools["spawn_agent"];
      const engine = (server as any)._registeredTools["interact"]._engine;

      const resultPromise = spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "readiness failure identity",
          boot_prompt_timeout_ms: 20,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("Timed out after 20ms");
      expect(parsed.error).toContain("waiting for shell readiness");
      expect(parsed.agent_id).toEqual(expect.any(String));
      expect(parsed.surface_id).toBe("surface:new");
      expect(parsed.workspace_id).toBe("ws:1");

      const state = engine.stateMgr
        .listStates()
        .find(
          (candidate: AgentRecord) => candidate.agent_id === parsed.agent_id,
        );
      expect(state).toBeDefined();
      expect(state?.surface_id).toBe(parsed.surface_id);
      expect(state?.state).toBe("error");
      expect(state?.error).toContain("waiting for shell readiness");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent applies boot_prompt_timeout_ms to agent-launch readiness", async () => {
    vi.useFakeTimers();
    try {
      const baseExec = makeLifecycleExec();
      let launcherSentAt: number | null = null;
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        if (
          args.includes("send") &&
          /[A-Za-z0-9_.-]+Codex\b/.test(String(args.at(-1) ?? ""))
        ) {
          launcherSentAt ??= Date.now();
        }
        if (args.includes("read-screen")) {
          if (launcherSentAt !== null && Date.now() - launcherSentAt < 200) {
            throw new Error("EAGAIN: launcher screen not readable yet");
          }
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text:
                launcherSentAt === null
                  ? "$ "
                  : "agent launcher still starting",
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(cmd, args);
      });
      const server = createLifecycleServer(exec);
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "agent-launch timeout contract",
          boot_prompt_timeout_ms: 37,
        },
        {} as any,
      );
      for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
        await vi.advanceTimersByTimeAsync(50);
      }
      const result = await resultPromise;
      const parsed = parseToolResult(result);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(
        "Timed out after 37ms waiting for agent launch readiness",
      );
      expect(parsed.agent_id).toEqual(expect.any(String));
      expect(parsed.surface_id).toBe("surface:new");
      expect(parsed.last_10_lines).toContain("agent launcher still starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent applies boot_prompt_timeout_ms to the post-update fresh-shell retry", async () => {
    vi.useFakeTimers();
    try {
      const baseExec = makeLifecycleExec();
      let launcherSentAt: number | null = null;
      let clearingForRelaunch = false;
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        if (
          args.includes("send") &&
          /[A-Za-z0-9_.-]+Codex\b/.test(String(args.at(-1) ?? ""))
        ) {
          launcherSentAt ??= Date.now();
        }
        if (args.includes("send-key") && args.includes("ctrl-c")) {
          clearingForRelaunch = true;
        }
        if (args.includes("read-screen")) {
          let text = "$ ";
          if (clearingForRelaunch) {
            text = "terminal initializing after update";
          } else if (launcherSentAt !== null) {
            const elapsed = Date.now() - launcherSentAt;
            text =
              elapsed < 200
                ? "agent launcher still starting"
                : elapsed < 325
                  ? "Updating Codex CLI from 0.142.5 → 0.143.0 …"
                  : "Update ran successfully! Please restart Codex.\netan@mac % ";
          }
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text,
              lines: 20,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return baseExec(cmd, args);
      });
      const server = createLifecycleServer(exec);
      const spawn = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "fresh-shell timeout contract",
          boot_prompt_timeout_ms: 400,
        },
        {} as any,
      );
      for (let elapsed = 0; elapsed < 2_000; elapsed += 50) {
        await vi.advanceTimersByTimeAsync(50);
      }
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;
      const parsed = parseToolResult(result);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(
        "Timed out after 400ms waiting for shell readiness",
      );
      expect(clearingForRelaunch).toBe(true);
      expect(parsed.agent_id).toEqual(expect.any(String));
      expect(parsed.surface_id).toBe("surface:new");
    } finally {
      vi.useRealTimers();
    }
  });

  it("new_worktree_split reports the created identity when initial readiness fails", async () => {
    vi.useFakeTimers();
    try {
      const gitsDir = join(TEST_DIR, "Gits");
      mkdirSync(join(gitsDir, "cmuxlayer"), { recursive: true });
      const worktreePath = join(
        gitsDir,
        "cmuxlayer",
        ".worktrees",
        "readiness-failure-worker",
      );
      const worktreeExec = vi.fn().mockImplementation(async () => {
        mkdirSync(worktreePath, { recursive: true });
        return { stdout: "", stderr: "" };
      });
      const server = createTrackedServer({
        exec: makeLifecycleExec({
          createdWorkspace: "ws:1",
          shellNeverReady: true,
        }),
        stateDir: TEST_DIR,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
        worktreeHomeDir: gitsDir,
        worktreeExec,
      });
      const tool = (server as any)._registeredTools["new_worktree_split"];

      const resultPromise = tool.handler(
        {
          repo: "cmuxlayer",
          model: "codex",
          cli: "codex",
          worktree: { name: "readiness failure worker" },
          boot_prompt_timeout_ms: 23,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;
      const parsed = parseToolResult(result);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain(
        "Timed out after 23ms waiting for shell readiness",
      );
      expect(parsed.agent_id).toEqual(expect.any(String));
      expect(parsed.surface_id).toBe("surface:new");
      expect(parsed.workspace_id).toBe("ws:1");
      expect(parsed.last_10_lines).toContain("terminal initializing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("new_worktree_split reports pending verification when boot prompt evidence is unreadable", async () => {
    vi.useFakeTimers();
    try {
      const gitsDir = join(TEST_DIR, "Gits");
      mkdirSync(join(gitsDir, "cmuxlayer"), { recursive: true });
      const worktreePath = join(
        gitsDir,
        "cmuxlayer",
        ".worktrees",
        "boot-verification-failure-worker",
      );
      const worktreeExec = vi.fn().mockImplementation(async () => {
        mkdirSync(worktreePath, { recursive: true });
        return { stdout: "", stderr: "" };
      });
      const baseExec = makeLifecycleExec();
      let promptSent = false;
      const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
        const text = String(args.at(-1) ?? "");
        if (args.includes("send") && text === "verify this prompt") {
          promptSent = true;
          return { stdout: "{}", stderr: "" };
        }
        if (promptSent && args.includes("send-key")) {
          return { stdout: "{}", stderr: "" };
        }
        if (promptSent && args.includes("read-screen")) {
          throw new Error("screen unavailable after prompt delivery");
        }
        return baseExec(cmd, args);
      });
      const server = createTrackedServer({
        exec,
        stateDir: TEST_DIR,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
        worktreeHomeDir: gitsDir,
        worktreeExec,
      });
      const tool = (server as any)._registeredTools["new_worktree_split"];

      const resultPromise = tool.handler(
        {
          repo: "cmuxlayer",
          model: "codex",
          cli: "codex",
          prompt: "verify this prompt",
          worktree: { name: "boot verification failure worker" },
          boot_prompt_timeout_ms: 23,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(500);
      const result = await resultPromise;
      const parsed = parseToolResult(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.agent_id).toEqual(expect.any(String));
      expect(parsed.surface_id).toBe("surface:new");
      expect(parsed.workspace_id).toBe("workspace:1");
      expect(parsed.boot_prompt_receipt).toMatchObject({
        delivered: false,
        terminal: false,
        typed: true,
        submit_attempted: true,
        submit_verified: null,
        delivery_state: "pending_verify",
        retry_count: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent timeout keeps the live pane bound through close_surface and explicit resume", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    let launchSent = false;
    let readCountAfterLaunch = 0;
    let surfaceClosed = false;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-windows")) {
        return {
          stdout: JSON.stringify({
            windows: [{ ref: "window:1", workspace_count: 1 }],
          }),
          stderr: "",
        };
      }
      if (args.includes("send")) {
        if (surfaceClosed) {
          surfaceClosed = false;
          readCountAfterLaunch = 0;
        }
        launchSent = true;
      }
      if (args.includes("close-surface")) {
        surfaceClosed = true;
      }
      if (args.includes("new-split")) {
        surfaceClosed = false;
        launchSent = false;
        readCountAfterLaunch = 0;
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
              ...(surfaceClosed
                ? []
                : [
                    {
                      ref: "pane:1",
                      index: 0,
                      focused: true,
                      surface_count: 1,
                      surface_refs: ["surface:new"],
                      surface_ids: [stableUuid],
                      selected_surface_ref: "surface:new",
                    },
                  ]),
              {
                ref: "pane:2",
                index: 1,
                focused: surfaceClosed,
                surface_count: 1,
                surface_refs: ["surface:witness"],
                surface_ids: ["aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"],
                selected_surface_ref: "surface:witness",
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("list-pane-surfaces")) {
        const pane = args[args.indexOf("--pane") + 1];
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            pane_ref: pane,
            surfaces:
              pane === "pane:2"
                ? [
                    {
                      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                      ref: "surface:witness",
                      title: "witness",
                      type: "terminal",
                      index: 0,
                      selected: true,
                    },
                  ]
                : surfaceClosed
                  ? []
                  : [
                      {
                        id: stableUuid,
                        ref: "surface:new",
                        title: "agent-pane",
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
        if (launchSent) {
          readCountAfterLaunch += 1;
        }
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text:
              !launchSent || readCountAfterLaunch === 1
                ? "$ "
                : readCountAfterLaunch === 2
                  ? "codex> "
                  : "$ waiting",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          workspace: "workspace:1",
          surface: "surface:new",
          surface_id: stableUuid,
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    });
    const sessionId = "019ec0e6-1111-2222-3333-444455556666";
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: (agent) =>
        agent.surface_id === "surface:new"
          ? { session_id: sessionId, path: null }
          : null,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];
    const close = (server as any)._registeredTools["close_surface"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "codex",
        cli: "codex",
        prompt: "",
        boot_prompt_path: promptPath,
        boot_prompt_timeout_ms: 20,
      },
      {} as any,
    );
    const parsed =
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.agent_id).toBeDefined();
    expect(parsed.surface_id).toBe("surface:new");
    expect(parsed.last_10_lines).toContain("$ waiting");

    const stateResult = await getState.handler(
      { agent_id: parsed.agent_id },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(["booting", "ready"]).toContain(state.state);
    expect(state.error).toBeNull();
    expect(state.boot_prompt_text).toBe("file prompt body");
    expect(state.task_summary).toBe("mandate.md");
    expect(state.boot_prompt_pending).toBe(true);
    expect(state.prompt_delivered).toBe(false);
    expect(state.submit_verified).toBeNull();
    expect(state.cli_session_id).toBe(sessionId);
    expect(state.resumable).toBe(true);
    expect(state.health.issue_codes).not.toContain("missing_cli_session_id");
    expect(state.health.issue_codes).not.toContain("non_resumable");
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        "file prompt body",
      ]),
    );

    const closeResult = await close.handler(
      { scope: "agent", agent_id: parsed.agent_id, force: true },
      {} as any,
    );
    const closed = parseToolResult(closeResult);
    expect(surfaceClosed).toBe(true);
    expect(closed).toMatchObject({
      scope: "agent",
    });
    expect(closed.ok, JSON.stringify(closed)).toBe(true);
    expect(String(closed.error ?? "")).not.toMatch(/Agent not found/i);

    const resumeResult = await spawn.handler(
      { resume_agent_id: parsed.agent_id, force: true },
      {} as any,
    );
    const resumed = parseToolResult(resumeResult);
    expect(resumed, JSON.stringify(resumed)).toMatchObject({
      ok: true,
      resumed: true,
      agent_id: parsed.agent_id,
      surface_id: "surface:new",
    });
  });

  it("spawn_agent keeps a live registered pane when front-matter delivery reaches its queued deadline", async () => {
    const promptPath = join(TEST_DIR, "front-matter.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const baseExec = makeLifecycleExec();
    let launched = false;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && /Codex\b/.test(text)) {
        launched = true;
      }
      if (launched && args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: [
              " ",
              "• Ran 6 commands · ctrl + t to view transcript",
              " ",
              "Working (19s • esc to interrupt)",
              " ",
              " ",
              "›",
              " ",
              " ",
              "  tab to queue message                                                    88% context left",
            ].join("\n"),
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createTrackedServer({
      exec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const result = parseToolResult(
      await spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          boot_prompt_path: promptPath,
          boot_prompt_timeout_ms: 250,
        },
        {} as any,
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.surface_id).toBe("surface:new");
    expect(result.boot_prompt_receipt).toMatchObject({
      delivery_state: "queued",
      delivered: false,
      terminal: false,
      typed: false,
      submit_attempted: false,
      submit_verified: null,
    });
    const state = parseToolResult(
      await getState.handler({ agent_id: result.agent_id }, {} as any),
    );
    expect(state).toMatchObject({
      surface_id: "surface:new",
      boot_prompt_pending: true,
      prompt_delivered: false,
      submit_verified: null,
    });
    expect(exec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining(["close-surface", "surface:new"]),
    );
  }, 20_000);

  it("spawn_agent keeps injected-only queued boot work pending", async () => {
    const baseExec = makeLifecycleExec();
    let launched = false;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (args.includes("send") && /Codex\b/.test(text)) {
        launched = true;
      }
      if (launched && args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: [
              " ",
              "• Ran 6 commands · ctrl + t to view transcript",
              " ",
              "Working (19s • esc to interrupt)",
              " ",
              " ",
              "›",
              " ",
              " ",
              "  tab to queue message                                                    88% context left",
            ].join("\n"),
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createTrackedServer({
      exec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const result = parseToolResult(
      await spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          boot_prompt_timeout_ms: 250,
        },
        {} as any,
      ),
    );

    expect(result.boot_prompt_receipt).toMatchObject({
      delivery_state: "queued",
      delivered: false,
      typed: false,
      submit_verified: null,
      prompt_text: null,
    });
    const state = parseToolResult(
      await getState.handler({ agent_id: result.agent_id }, {} as any),
    );
    expect(state).toMatchObject({
      state: "booting",
      surface_id: "surface:new",
      boot_prompt_pending: true,
      prompt_delivered: false,
      submit_verified: null,
    });
  }, 20_000);

  it("spawn_agent defaults managed agents to lifecycle escalation and persists explicit opt-outs", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const defaultArgs = spawn.inputSchema.parse({
      repo: "cmuxlayer",
      model: "gpt-5.4",
      cli: "codex",
      role: "implementor",
      authority: "worker",
      prompt: "default escalation",
    });
    const optedOutArgs = spawn.inputSchema.parse({
      repo: "cmuxlayer",
      model: "gpt-5.4",
      cli: "codex",
      role: "implementor",
      authority: "worker",
      prompt: "debug CLI death",
      halt_escalation: false,
      force_new: true,
    });

    const defaultResult = await spawn.handler(defaultArgs, {} as any);
    const optedOutResult = await spawn.handler(optedOutArgs, {} as any);
    const defaultId = (
      defaultResult.structuredContent ??
      JSON.parse(defaultResult.content[0].text)
    ).agent_id;
    const optedOutId = (
      optedOutResult.structuredContent ??
      JSON.parse(optedOutResult.content[0].text)
    ).agent_id;
    const defaultStateResult = await getState.handler(
      { agent_id: defaultId },
      {} as any,
    );
    const optedOutStateResult = await getState.handler(
      { agent_id: optedOutId },
      {} as any,
    );
    const defaultState =
      defaultStateResult.structuredContent ??
      JSON.parse(defaultStateResult.content[0].text);
    const optedOutState =
      optedOutStateResult.structuredContent ??
      JSON.parse(optedOutStateResult.content[0].text);

    expect(defaultState.halt_escalation).toBe(true);
    expect(optedOutState.halt_escalation).toBe(false);
  });

  it("#492: a disappeared surface is never respawned, in any workspace mode", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:witness",
        id: "uuid-witness",
        workspace_ref: "workspace:witness",
      },
    ]);
    routeClient.client.listStatus.mockResolvedValue([
      { key: "mode.control", value: "manual" },
    ]);
    routeClient.client.newSplit.mockResolvedValue({
      workspace: "workspace:manual",
      surface: "surface:should-not-create",
      surface_id: "uuid-should-not-create",
      pane: "pane:manual",
      title: "",
      type: "terminal",
    });
    const record = makeServerAgentRecord({
      agent_id: "crash-recovery-manual-agent",
      state: "error",
      surface_id: "surface:dead-manual",
      surface_uuid: "uuid-dead-manual",
      surface_observer_id: "cmux:/tmp/current.sock",
      workspace_id: "workspace:manual",
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      error: "Surface surface:dead-manual disappeared",
      role: "orchestrator",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const engine = testLifecycleEngine(server) as any;
    routeClient.client.listStatus.mockClear();
    routeClient.client.newSplit.mockClear();
    routeClient.client.send.mockClear();

    await engine.runSweep();

    // cmuxlayer no longer respawns anything on its own: the pane that vanished
    // stays gone and the row keeps its honest terminal state, which is the
    // handle an explicit spawn_agent({resume_agent_id}) resumes from.
    expect(routeClient.client.newSplit).not.toHaveBeenCalled();
    expect(routeClient.client.send).not.toHaveBeenCalled();
    expect(engine.getAgentState(record.agent_id)).toMatchObject({
      state: "error",
      surface_id: "surface:dead-manual",
      error: "Surface surface:dead-manual disappeared",
    });
  });

  it("list_agents returns agents after spawn", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];

    await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "task 1",
      },
      {} as any,
    );

    const result = await list.handler({ state: "working" }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.derived_at).toEqual(expect.any(Number));
    expect(parsed.count).toBe(1);
    expect(Object.keys(parsed.agents[0]).sort()).toEqual(
      [
        "agent_id",
        "blocked_on_prompt",
        "cli",
        "closure",
        "model",
        "paused",
        "repo",
        "resumable",
        "resume_command",
        "role",
        "send_via",
        "session_id",
        "state",
        "surface_id",
      ].sort(),
    );
    expect(parsed.agents[0]).toMatchObject({
      repo: "brainlayer",
      cli: "claude",
      role: "worker",
      state: "working",
      model: "sonnet",
      session_id: null,
      resumable: false,
      resume_command: null,
      paused: false,
      blocked_on_prompt: false,
      send_via: "send_to",
    });
  });

  it("list_agents detail=full includes health diagnostics", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];

    await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "task 1",
      },
      {} as any,
    );

    const result = await list.handler(
      { state: "working", detail: "full" },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.agents[0].health).toMatchObject({
      status: "healthy",
      issue_codes: expect.arrayContaining([
        "missing_cli_session_id",
        "non_resumable",
      ]),
    });
  });

  it("list_agents bounds caller-declared staleness to five seconds", () => {
    const server = createLifecycleServer(mockExec);
    const list = (server as any)._registeredTools["list_agents"];

    expect(list.inputSchema.parse({ max_age_ms: 5_000 })).toMatchObject({
      max_age_ms: 5_000,
    });
    expect(() => list.inputSchema.parse({ max_age_ms: 5_001 })).toThrow();
  });

  it("list_agents stamps current observations and labels only the channel actually read", async () => {
    const stableUuid = "21111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:truthful-observation",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText(
      "OpenAI Codex\nModel: gpt-5.6-sol xhigh\n\ncodex> ",
    );
    const record = makeServerAgentRecord({
      agent_id: "truthful-observation-agent",
      surface_id: "surface:truthful-observation",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      model: "stale-registry-model",
      parsed_model: "stale-screen-model",
      cli_session_id: "019fec96-588d-7000-8000-000000000099",
      updated_at: "not-a-timestamp",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const before = Date.now();

    const parsed = parseToolResult(
      await registeredTestTool(server, "list_agents").handler(
        { detail: "full" },
        {},
      ),
    );
    const agent = parsed.agents.find(
      (candidate: { agent_id: string }) =>
        candidate.agent_id === "truthful-observation-agent",
    );

    expect(agent.state).toMatchObject({
      value: "ready",
      source: "screen",
      observed_at_ms: expect.any(Number),
    });
    expect(agent.state.observed_at_ms).toBeGreaterThanOrEqual(before);
    expect(agent.model).toMatchObject({
      value: "gpt-5.6-sol xhigh",
      source: "screen",
      observed_at_ms: agent.state.observed_at_ms,
    });
    expect(agent.session_id).toMatchObject({
      value: record.cli_session_id,
      source: "registry",
      observed_at_ms: expect.any(Number),
    });
    expect(agent.session_id.observed_at_ms).toBeGreaterThanOrEqual(before);
    expect(parsed.derived_at).toBeGreaterThanOrEqual(
      Math.max(
        agent.state.observed_at_ms,
        agent.model.observed_at_ms,
        agent.session_id.observed_at_ms,
      ),
    );
  });

  it("list_agents force-discovers a surface added after lifecycle startup", async () => {
    const firstUuid = "31111111-2222-4333-8444-555555555555";
    const secondUuid = "41111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:first-live",
        id: firstUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText("OpenAI Codex\nModel: gpt-5.5\n\ncodex> ");
    const record = makeServerAgentRecord({
      agent_id: "first-live-agent",
      surface_id: "surface:first-live",
      surface_uuid: firstUuid,
      workspace_id: "workspace:1",
      state: "ready",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const list = registeredTestTool(server, "list_agents");
    await list.handler({}, {});

    routeClient.setLiveSurfaces([
      {
        ref: "surface:first-live",
        id: firstUuid,
        workspace_ref: "workspace:1",
      },
      {
        ref: "surface:second-live",
        id: secondUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const parsed = parseToolResult(await list.handler({}, {}));

    expect(parsed.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: "cmuxlayerCodex",
        }),
      ]),
    );
  });

  it("list_agents declares its registry-repair behavior as mutating", () => {
    const server = createLifecycleServer(mockExec);
    const list = registeredTestTool(server, "list_agents") as any;

    expect(list.annotations?.readOnlyHint).toBe(false);
  });

  it("list_agents repairs discovered orphans even when no pending registration exists", async () => {
    const stableUuid = "42111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:managed",
        id: stableUuid,
        workspace_ref: "workspace:1",
        title: "cmuxlayerCodex",
      },
    ]);
    routeClient.setScreenText("OpenAI Codex\nModel: gpt-5.6-sol\n\ncodex> ");
    const record = makeServerAgentRecord({
      agent_id: "managed-stable-sibling",
      surface_id: "surface:managed",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const registry = testLifecycleEngine(server).getRegistry();
    const repair = vi.spyOn(registry, "repairFromDiscovery");

    await registeredTestTool(server, "list_agents").handler({}, {});

    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("list_agents publishes a tracked ready agent fallen back to shell as an unhealthy error", async () => {
    const stableUuid = "51111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:corpse",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText("etan@mac cmuxlayer % ");
    const record = makeServerAgentRecord({
      agent_id: "corpse-agent",
      surface_id: "surface:corpse",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);

    const parsed = parseToolResult(
      await registeredTestTool(server, "list_agents").handler(
        { detail: "full" },
        {},
      ),
    );
    const corpse = parsed.agents.find(
      (candidate: { agent_id: string }) =>
        candidate.agent_id === "corpse-agent",
    );

    expect(corpse.state).toMatchObject({ value: "error", source: "screen" });
    expect(corpse.health).toMatchObject({
      status: "unhealthy",
      issue_codes: expect.arrayContaining(["agent_shell_fallback"]),
      screen_confirmed_state: "error",
    });
  });

  it("list_agents publishes a live ready screen over a stale registry error", async () => {
    const stableUuid = "61111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:mirror",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText("OpenAI Codex\nModel: gpt-5.6-sol\n\ncodex> ");
    const record = makeServerAgentRecord({
      agent_id: "mirror-agent",
      surface_id: "surface:mirror",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "error",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);

    const parsed = parseToolResult(
      await registeredTestTool(server, "list_agents").handler(
        { detail: "full" },
        {},
      ),
    );
    const live = parsed.agents.find(
      (candidate: { agent_id: string }) =>
        candidate.agent_id === "mirror-agent",
    );

    expect(live.state).toMatchObject({ value: "ready", source: "screen" });
    expect(live.health.issue_codes).toContain("registry_screen_disagreement");
  });

  it("inbox_check preserves harness API errors through the general health evaluator", async () => {
    const stableUuid = "71111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:api-error",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText(
      'Claude Code\nAPI Error: 500 {"request_id":"req_inboxhealth"}\n❯',
    );
    const record = makeServerAgentRecord({
      agent_id: "api-error-health-agent",
      surface_id: "surface:api-error",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "working",
      cli: "claude",
    });
    const server = await createUuidRouteServer(routeClient, record);

    const parsed = parseToolResult(
      await registeredTestTool(server, "inbox_check").handler(
        { agent_id: record.agent_id },
        {},
      ),
    );

    expect(parsed.health).toMatchObject({
      status: expect.not.stringMatching(/^healthy$/),
      issue_codes: expect.arrayContaining(["harness_api_error"]),
    });
    expect(parsed.health.issues.join(" ")).toContain("req_inboxhealth");
  });

  it("interact skill observes the result through the stable UUID and bound workspace", async () => {
    const stableUuid = "81111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:skill",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    (routeClient.client as any).supportsStableSurfaceReads = true;
    routeClient.setScreenText("Claude Code\n❯ ");
    const record = makeServerAgentRecord({
      agent_id: "stable-skill-agent",
      surface_id: "surface:skill",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      cli: "claude",
    });
    const server = await createUuidRouteServer(routeClient, record);

    const result = parseToolResult(
      await registeredTestTool(server, "interact").handler(
        { agent: record.agent_id, action: "skill", command: "/review" },
        {},
      ),
    );

    expect(result.ok).toBe(true);
    expect(routeClient.client.readScreen).toHaveBeenLastCalledWith(stableUuid, {
      workspace: "workspace:1",
      lines: 20,
    });
  });

  it("list_agents reuses a bounded snapshot until live topology changes", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:observed",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "observed-cache-agent",
      surface_id: "surface:observed",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
      model: "gpt-5.4",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const list = registeredTestTool(server, "list_agents");

    const first = parseToolResult(
      await list.handler({ max_age_ms: 5_000, detail: "full" }, {}),
    );
    routeClient.client.readScreen.mockClear();
    const cached = parseToolResult(
      await list.handler({ max_age_ms: 5_000, detail: "full" }, {}),
    );

    expect(cached.derived_at).toBe(first.derived_at);
    expect(routeClient.client.readScreen).not.toHaveBeenCalled();

    routeClient.setLiveSurfaces([
      {
        ref: "surface:moved",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const refreshed = parseToolResult(
      await list.handler({ max_age_ms: 5_000, detail: "full" }, {}),
    );

    expect(routeClient.client.readScreen).toHaveBeenCalled();
    expect(refreshed.agents[0].state).toMatchObject({
      value: "working",
      source: "screen",
    });
  });

  it("list_agents keeps a corrupt legacy repo visible and raw-resumable", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:healthy",
        id: "11111111-2222-4333-8444-555555555555",
        workspace_ref: "workspace:1",
      },
      {
        ref: "surface:corrupt",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    const engine = testLifecycleEngine(server);
    const healthy = makeServerAgentRecord({
      agent_id: "healthy-agent",
      surface_id: "surface:healthy",
      surface_uuid: "11111111-2222-4333-8444-555555555555",
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
    const corrupt = makeServerAgentRecord({
      agent_id: "corrupt-agent",
      surface_id: "surface:corrupt",
      surface_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      workspace_id: "workspace:1",
      state: "ready",
      repo: "brainlayerClaude [surface:199]",
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f4f",
    });
    harnessHome.give(corrupt.cli, corrupt.cli_session_id!);
    for (const record of [healthy, corrupt]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }
    vi.spyOn(engine.getRegistry(), "listMerged").mockResolvedValue([
      healthy,
      corrupt,
    ]);

    const result = await registeredTestTool(server, "list_agents").handler(
      {},
      {} as any,
    );
    const parsed = parseToolResult(result) as {
      ok: boolean;
      agents: Array<{ agent_id: string }>;
      skipped_agents?: Array<{ agent_id: string; error: string }>;
    };

    expect(parsed.ok).toBe(true);
    // Issue #392: `codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust resume <uuid>` reads a global session store, so a
    // corrupt repo LABEL no longer blocks recovery -- the raw form is real and
    // runnable. Previously this row advertised nothing at all.
    expect(parsed.agents).toEqual([
      expect.objectContaining({ agent_id: "healthy-agent" }),
      expect.objectContaining({
        agent_id: "corrupt-agent",
        resumable: true,
        resume_command:
          "codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust resume 019d9aa5-93c0-7a52-9c47-9be1f7625f4f",
      }),
    ]);
    expect(parsed.skipped_agents).toBeUndefined();
  });

  it("list_agents withholds a cwd-keyed resume for a corrupt legacy repo", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:corrupt-claude",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef",
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    const engine = testLifecycleEngine(server);
    const corrupt = makeServerAgentRecord({
      agent_id: "corrupt-claude-agent",
      surface_id: "surface:corrupt-claude",
      surface_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef",
      workspace_id: "workspace:1",
      state: "ready",
      cli: "claude",
      repo: "brainlayerClaude [surface:199]",
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f4f",
    });
    engine.stateMgr.writeState(corrupt);
    engine.getRegistry().set(corrupt.agent_id, corrupt);
    vi.spyOn(engine.getRegistry(), "listMerged").mockResolvedValue([corrupt]);

    const result = await registeredTestTool(server, "list_agents").handler(
      {},
      {} as any,
    );
    const parsed = parseToolResult(result) as {
      agents: Array<Record<string, unknown>>;
    };

    expect(parsed.agents[0]).toMatchObject({
      agent_id: "corrupt-claude-agent",
      resumable: false,
    });
    expect(parsed.agents[0]).toHaveProperty("resume_command", null);
  });

  it("send_to keeps repaired registry repo ownership when a title contains a surface suffix", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:199",
        id: stableUuid,
        workspace_ref: "workspace:1",
        title: "brainlayerClaude [surface:199]",
      },
    ]);
    routeClient.setScreenText("Claude Code\n> ");
    const record = makeServerAgentRecord({
      agent_id: "auto-claude-11111111-2222-4333-8444-555555555555",
      surface_id: "surface:199",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "brainlayer",
      cli: "claude",
      model: "sonnet",
      cli_session_id: "claude-session",
      task_summary: "(auto-discovered)",
    });
    // The repaired id is the SEAT, not the launcher, so this test states the
    // seat registry it repairs against. Reading the host's ~/.golems/config.yaml
    // instead is what made this assertion green on one Mac and red in CI.
    const server = await createUuidRouteServer(routeClient, record, {
      seatRegistry: {
        brainClaude: {
          repo: "brainlayer",
          lane: "brainlayer",
          role: "lead",
          launchers: { claude: "brainlayerClaude" },
        },
      },
    });
    const listResult = await registeredTestTool(server, "list_agents").handler(
      {},
      {} as any,
    );
    const listed = parseToolResult(listResult) as {
      ok: boolean;
      agents: Array<{ agent_id: string; repo: string }>;
    };
    expect(listed).toMatchObject({
      ok: true,
      agents: [
        expect.objectContaining({
          agent_id: "brainClaude",
          repo: "brainlayer",
        }),
      ],
    });
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: "brainClaude",
        text: "keep going",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:199", text: "keep going" },
    ]);
    expect(testLifecycleEngine(server).getAgentState("brainClaude")?.repo).toBe(
      "brainlayer",
    );
  });

  it("list_agents surfaces a collapsed monitor on its owning agent health", async () => {
    const registryPath = join(TEST_DIR, "monitor-registry.json");
    const watchedFile = join(TEST_DIR, "collab.md");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    const server = createTrackedServer({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => 62_000,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];
    const spawnResult = await spawn.handler(
      {
        repo: "cmuxlayer",
        model: "gpt-5.5",
        cli: "codex",
        prompt: "watch collab",
      },
      {} as any,
    );
    const agentId = parseToolResult(spawnResult).agent_id;
    await registerMonitor(
      {
        monitor_id: "agent-collab-watch",
        owner_seat: agentId,
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath, now: () => 1_000 },
    );
    await reconcileMonitorRegistry({
      registryPath,
      now: () => 62_000,
      ownerAlive: async () => false,
      rearm: vi.fn(),
    });

    const parsed = parseToolResult(
      await list.handler({ detail: "full" }, {} as any),
    );

    expect(parsed.agents[0]?.health).toMatchObject({
      status: "unhealthy",
      issue_codes: expect.arrayContaining(["monitor_collapsed"]),
    });
  });

  it("broadcast defaults to leads and excludes the caller, workers, and explicit excludes", async () => {
    const previousTabId = process.env.CMUX_TAB_ID;
    const previousAgentId = process.env.CMUX_AGENT_ID;
    process.env.CMUX_TAB_ID = "surface:caller";
    delete process.env.CMUX_AGENT_ID;

    try {
      const records = [
        makeServerAgentRecord({
          agent_id: "orc-caller",
          surface_id: "surface:caller",
          state: "ready",
          role: "orchestrator",
          task_summary: "caller lead",
        }),
        makeServerAgentRecord({
          agent_id: "ic-target",
          surface_id: "surface:ic",
          state: "ready",
          role: "orchestrator",
          task_summary: "ic lane",
        }),
        makeServerAgentRecord({
          agent_id: "orc-target",
          surface_id: "surface:orc",
          state: "idle",
          role: "orchestrator",
          task_summary: "orchestrator lane",
        }),
        makeServerAgentRecord({
          agent_id: "ic-excluded",
          surface_id: "surface:excluded",
          state: "ready",
          role: "orchestrator",
          task_summary: "excluded lane",
        }),
        makeServerAgentRecord({
          agent_id: "worker-target",
          surface_id: "surface:worker",
          state: "ready",
          role: "worker",
          task_summary: "worker lane",
        }),
      ];
      const { server, sendCalls, sendKeyCalls } = await createBroadcastServer(
        records,
        { callerSurface: "surface:caller" },
      );
      const broadcast = (server as any)._registeredTools["broadcast"];

      const result = await broadcast.handler(
        {
          text: "Read and follow /tmp/lead-update.md",
          exclude: ["ic-excluded"],
        },
        {} as any,
      );
      const parsed = parseToolResult(result);
      const receipts = parsed.receipts as Array<Record<string, unknown>>;

      expect(result.isError).toBeFalsy();
      expect(parsed).toMatchObject({
        ok: true,
        role: "leads",
        target_count: 2,
        delivered_count: 2,
        failed_count: 0,
        skipped_count: 0,
      });
      expect(sendCalls.map((call) => call.surface)).toEqual([
        "surface:ic",
        "surface:orc",
      ]);
      expect(sendKeyCalls.map((call) => call.surface)).toEqual([
        "surface:ic",
        "surface:orc",
      ]);
      expect(receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agent_id: "ic-target",
            seat: "surface:ic",
            delivered: true,
            submit_verified: true,
          }),
          expect.objectContaining({
            agent_id: "orc-target",
            seat: "surface:orc",
            delivered: true,
            submit_verified: true,
          }),
        ]),
      );
      expect(receipts.map((receipt) => receipt.agent_id)).not.toContain(
        "orc-caller",
      );
      expect(receipts.map((receipt) => receipt.agent_id)).not.toContain(
        "worker-target",
      );
      expect(receipts.map((receipt) => receipt.agent_id)).not.toContain(
        "ic-excluded",
      );
    } finally {
      if (previousTabId === undefined) {
        delete process.env.CMUX_TAB_ID;
      } else {
        process.env.CMUX_TAB_ID = previousTabId;
      }
      if (previousAgentId === undefined) {
        delete process.env.CMUX_AGENT_ID;
      } else {
        process.env.CMUX_AGENT_ID = previousAgentId;
      }
    }
  });

  it("broadcast infers unset record roles before selecting lead targets", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "implicit-orchestrator",
        surface_id: "surface:implicit-orc",
        state: "ready",
        role: undefined,
        cli: "claude",
        repo: "orchestrator",
        task_summary: "implicit Claude lead",
      }),
      makeServerAgentRecord({
        agent_id: "implicit-worker",
        surface_id: "surface:implicit-worker",
        state: "ready",
        role: undefined,
        cli: "codex",
        repo: "brainlayer",
        task_summary: "implicit Codex worker",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = await broadcast.handler(
      { text: "Role inference target test", role: "leads", press_enter: false },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      ok: true,
      role: "leads",
      target_count: 1,
      delivered_count: 1,
    });
    expect(sendCalls.map((call) => call.surface)).toEqual([
      "surface:implicit-orc",
    ]);
  });

  it("broadcast returns per-lead receipts when one delivery fails without aborting others", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "orc-ok-1",
        surface_id: "surface:ok-1",
        state: "ready",
        role: "orchestrator",
        task_summary: "first ok lead",
      }),
      makeServerAgentRecord({
        agent_id: "orc-fail",
        surface_id: "surface:fail",
        state: "ready",
        role: "orchestrator",
        task_summary: "failing lead",
      }),
      makeServerAgentRecord({
        agent_id: "orc-ok-2",
        surface_id: "surface:ok-2",
        state: "ready",
        role: "orchestrator",
        task_summary: "second ok lead",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records, {
      failSurface: "surface:fail",
    });
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = await broadcast.handler(
      { text: "Short receipt test", role: "leads" },
      {} as any,
    );
    const parsed = parseToolResult(result);
    const receipts = parsed.receipts as Array<Record<string, unknown>>;

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      ok: true,
      target_count: 3,
      delivered_count: 2,
      failed_count: 1,
      skipped_count: 0,
    });
    expect(sendCalls.map((call) => call.surface)).toEqual(
      expect.arrayContaining(["surface:ok-1", "surface:fail", "surface:ok-2"]),
    );
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: "orc-ok-1",
          delivered: true,
          submit_verified: true,
        }),
        expect.objectContaining({
          agent_id: "orc-fail",
          delivered: false,
          submit_verified: null,
          error: expect.stringContaining("send failed for surface:fail"),
        }),
        expect.objectContaining({
          agent_id: "orc-ok-2",
          delivered: true,
          submit_verified: true,
        }),
      ]),
    );
  });

  it("broadcast does not count a rescued send as delivered", async () => {
    const record = makeServerAgentRecord({
      agent_id: "rescued-lead",
      surface_id: "surface:rescued",
      state: "ready",
      role: "orchestrator",
      cli: "codex",
      task_summary: "rescued lead",
    });
    const { server } = await createBroadcastServer([record], {
      rescuedSurface: record.surface_id,
    });
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = parseToolResult(
      await broadcast.handler(
        { text: "Reply with the single word OK", role: "leads" },
        {} as any,
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      target_count: 1,
      delivered_count: 0,
      failed_count: 1,
      receipts: [
        expect.objectContaining({
          agent_id: record.agent_id,
          delivered: false,
          delivery_state: "rescued",
          submit_verified: false,
        }),
      ],
    });
  }, 20_000);

  it("RC6: broadcast receipt seat labels never contain the full boot prompt", async () => {
    const bootPrompt = "Implement the registry liveness brief. ".repeat(40);
    const records = [
      makeServerAgentRecord({
        agent_id: "worker-long-prompt",
        surface_id: "surface:short-label",
        state: "ready",
        role: "worker",
        seat_id: null,
        task_summary: bootPrompt,
      }),
    ];
    const { server } = await createBroadcastServer(records);
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = await broadcast.handler(
      { text: "Status", role: "workers", press_enter: false },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(parsed.receipts).toEqual([
      expect.objectContaining({
        agent_id: "worker-long-prompt",
        seat: "surface:short-label",
        delivered: true,
      }),
    ]);
    expect(JSON.stringify(parsed.receipts)).not.toContain(bootPrompt);
  });

  it("broadcast refuses over-cap text with file-pointer guidance before delivery", async () => {
    const outboxPath = join(TEST_DIR, "mock-outbox.md");
    writeFileSync(outboxPath, "not touched by broadcast\n", "utf8");
    const outboxMtimeBefore = readOutboxMtimeMs(outboxPath);
    const records = [
      makeServerAgentRecord({
        agent_id: "ic-target",
        surface_id: "surface:ic",
        state: "ready",
        role: "orchestrator",
      }),
    ];
    const { server, sendCalls, sendKeyCalls } =
      await createBroadcastServer(records);
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = await broadcast.handler(
      { text: "x".repeat(SEND_INPUT_MAX_INLINE_CHARS + 1) },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("broadcast.text");
    expect(parsed.error).toContain("Read and follow <path>");
    expect(parsed.error).not.toContain("allow_long_inline");
    expect(sendCalls).toHaveLength(0);
    expect(sendKeyCalls).toHaveLength(0);
    expect(readOutboxMtimeMs(outboxPath)).toBe(outboxMtimeBefore);
  });

  it("broadcast refuses the dense incident below the general inline cap", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "ic-target",
        surface_id: "surface:ic",
        state: "ready",
        role: "orchestrator",
      }),
    ];
    const { server, sendCalls, sendKeyCalls } =
      await createBroadcastServer(records);
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = await broadcast.handler(
      { text: "x".repeat(1_734) },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain("broadcast.text");
    expect(parsed.error).toContain("1734 characters");
    expect(parsed.error).toContain("longest unbroken run is 1734");
    expect(parsed.error).toContain("routing policy threshold 1500");
    expect(parsed.error).toContain("Read and follow <path>");
    expect(parsed.error).not.toContain("allow_long_inline");
    expect(sendCalls).toHaveLength(0);
    expect(sendKeyCalls).toHaveLength(0);
  });

  it("broadcast fails closed when live surface enumeration is malformed", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "ic-stale",
        surface_id: "surface:stale",
        state: "ready",
        role: "orchestrator",
        task_summary: "possibly stale lead",
      }),
    ];
    const { server, sendCalls, sendKeyCalls } = await createBroadcastServer(
      records,
      { malformedEnumeration: true },
    );
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = await broadcast.handler(
      { text: "Must not deliver on stale enumeration", role: "leads" },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Malformed cmux surface enumeration");
    expect(sendCalls).toHaveLength(0);
    expect(sendKeyCalls).toHaveLength(0);
  });

  it("broadcast records done and non-interactive lead targets as skipped", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "ic-ready",
        surface_id: "surface:ready",
        state: "ready",
        role: "orchestrator",
      }),
      makeServerAgentRecord({
        agent_id: "orc-working",
        surface_id: "surface:working",
        state: "working",
        role: "orchestrator",
      }),
      makeServerAgentRecord({
        agent_id: "orc-done",
        surface_id: "surface:error",
        state: "done",
        role: "orchestrator",
        error: null,
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = await broadcast.handler(
      { text: "Skip accounting", role: "leads", press_enter: false },
      {} as any,
    );
    const parsed = parseToolResult(result);
    const receipts = parsed.receipts as Array<Record<string, unknown>>;

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      ok: true,
      target_count: 3,
      delivered_count: 1,
      failed_count: 0,
      skipped_count: 2,
    });
    expect(sendCalls.map((call) => call.surface)).toEqual(["surface:ready"]);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: "ic-ready",
          delivered: true,
          submit_verified: null,
        }),
        expect.objectContaining({
          agent_id: "orc-working",
          delivered: false,
          submit_verified: null,
          skipped: "not_interactive:working",
        }),
        expect.objectContaining({
          agent_id: "orc-done",
          delivered: false,
          submit_verified: null,
          skipped: "dead:done",
        }),
      ]),
    );
  });

  it("RC3: broadcast delivers to an error-state agent whose surface is alive", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "orc-live-error",
        surface_id: "surface:live-error",
        state: "error",
        role: "orchestrator",
        error: "Boot prompt delivery interrupted before completion",
      }),
      makeServerAgentRecord({
        agent_id: "worker-live-error",
        surface_id: "surface:second-live-error",
        state: "error",
        role: "worker",
        error: "stale registry classification",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);
    const broadcast = (server as any)._registeredTools["broadcast"];

    const result = await broadcast.handler(
      { text: "Recover live seat", role: "all", press_enter: false },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      target_count: 2,
      delivered_count: 2,
      failed_count: 0,
      skipped_count: 0,
      receipts: expect.arrayContaining([
        expect.objectContaining({
          agent_id: "orc-live-error",
          delivered: true,
        }),
        expect.objectContaining({
          agent_id: "worker-live-error",
          delivered: true,
        }),
      ]),
    });
    expect(sendCalls.map((call) => call.surface)).toEqual(
      expect.arrayContaining([
        "surface:live-error",
        "surface:second-live-error",
      ]),
    );
  });

  it("broadcast ignores stale PTY-dead evidence after an error-state agent UUID moves", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const oldSurfaceRef = "surface:old-broadcast-target";
    const newSurfaceRef = "surface:new-broadcast-target";
    const routeClient = makeUuidRouteClient([
      {
        ref: oldSurfaceRef,
        id: stableUuid,
        workspace_ref: "workspace:old",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "orc-moved-live-error",
      surface_id: oldSurfaceRef,
      surface_uuid: stableUuid,
      surface_observer_id: "cmux:/tmp/current.sock",
      workspace_id: "workspace:old",
      state: "error",
      role: "orchestrator",
      error: "stale registry classification",
    });
    const tracker = new SurfaceWriteLivenessTracker({ now: () => 1_000 });
    const brokenPipe = Object.assign(new Error("broken pipe"), {
      code: "EPIPE",
    });
    tracker.recordFailure(oldSurfaceRef, brokenPipe);
    tracker.recordFailure(oldSurfaceRef, brokenPipe);
    const persistedState = new StateManager(TEST_DIR);
    persistedState.writeState(record);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      surfaceWriteLiveness: tracker,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    const engine = testLifecycleEngine(server) as any;
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(record.agent_id, record);

    const defaultReadScreen =
      routeClient.client.readScreen.getMockImplementation();
    routeClient.client.readScreen.mockImplementationOnce(
      async (...args: unknown[]) => {
        const screen = await defaultReadScreen?.(...args);
        routeClient.setLiveSurfaces([
          {
            ref: newSurfaceRef,
            id: stableUuid,
            workspace_ref: "workspace:new",
          },
        ]);
        return screen;
      },
    );
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now + 3_000);

    try {
      const result = await registeredTestTool(server, "broadcast").handler(
        { text: "Recover moved live seat", role: "all", press_enter: false },
        {},
      );
      const parsed = parseToolResult(result);

      expect(tracker.observe(oldSurfaceRef)?.pty_dead).toBe(true);
      expect(result.isError).toBeFalsy();
      expect(parsed).toMatchObject({
        target_count: 1,
        delivered_count: 1,
        failed_count: 0,
        skipped_count: 0,
        receipts: [
          expect.objectContaining({
            agent_id: record.agent_id,
            delivered: true,
          }),
        ],
      });
      expect(routeClient.sendCalls).toEqual([
        { surface: newSurfaceRef, text: "Recover moved live seat" },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("broadcast role=workers and role=all select the requested target sets", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "orc-target",
        surface_id: "surface:orc",
        state: "ready",
        role: "orchestrator",
      }),
      makeServerAgentRecord({
        agent_id: "worker-target-2",
        surface_id: "surface:worker-2",
        state: "ready",
        role: "worker",
      }),
      makeServerAgentRecord({
        agent_id: "worker-target",
        surface_id: "surface:worker",
        state: "ready",
        role: "worker",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);
    const broadcast = (server as any)._registeredTools["broadcast"];

    let result = await broadcast.handler(
      { text: "Workers only", role: "workers", press_enter: false },
      {} as any,
    );
    let parsed = parseToolResult(result);
    expect(parsed).toMatchObject({
      ok: true,
      role: "workers",
      target_count: 2,
      delivered_count: 2,
    });
    expect(sendCalls.map((call) => call.surface).sort()).toEqual(
      ["surface:worker", "surface:worker-2"].sort(),
    );

    sendCalls.splice(0);

    result = await broadcast.handler(
      { text: "Everyone", role: "all", press_enter: false },
      {} as any,
    );
    parsed = parseToolResult(result);

    expect(parsed).toMatchObject({
      ok: true,
      role: "all",
      target_count: 3,
      delivered_count: 3,
    });
    expect(sendCalls.map((call) => call.surface).sort()).toEqual(
      ["surface:orc", "surface:worker-2", "surface:worker"].sort(),
    );
  });

  it("send_to preserves socket RPC provenance in a rebuilt agent receipt", async () => {
    const record = makeServerAgentRecord({
      agent_id: "worker-rpc-receipt",
      surface_id: "surface:worker-rpc-receipt",
      workspace_id: "workspace:one",
      state: "ready",
      function: "implementor",
    });
    const { server } = await createBroadcastServer([record]);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "Inspect receipt provenance",
        press_enter: false,
      },
      {},
    );

    expect(parseToolResult(result)).toMatchObject({
      ok: true,
      rpc_methods: ["surface.send_text"],
    });
  });

  it("send_to surface mode persists socket RPC provenance for wait_for", async () => {
    const record = makeServerAgentRecord({
      agent_id: "worker-surface-rpc-receipt",
      surface_id: "surface:worker-surface-rpc-receipt",
      workspace_id: "workspace:one",
      state: "ready",
      function: "implementor",
    });
    const { server } = await createBroadcastServer([record]);

    const sent = parseToolResult(
      await registeredTestTool(server, "send_to").handler(
        {
          mode: "surface",
          target: record.surface_id,
          text: "Persist surface receipt provenance",
          press_enter: false,
        },
        {},
      ),
    );
    const waited = parseToolResult(
      await registeredTestTool(server, "wait_for").handler(
        { delivery_id: sent.delivery_id },
        {},
      ),
    );

    expect(sent).toMatchObject({
      ok: true,
      rpc_methods: ["surface.send_text"],
      delivery_id: expect.any(String),
    });
    expect(waited).toMatchObject({
      ok: true,
      rpc_methods: ["surface.send_text"],
      delivery_id: sent.delivery_id,
    });
  });

  it("send_to resolves structured targeting by job function, workspace, ids, and exclude", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "reviewer-a",
        surface_id: "surface:reviewer-a",
        workspace_id: "workspace:one",
        state: "ready",
        function: "reviewer",
      }),
      makeServerAgentRecord({
        agent_id: "reviewer-excluded",
        surface_id: "surface:reviewer-excluded",
        workspace_id: "workspace:one",
        state: "ready",
        function: "reviewer",
      }),
      makeServerAgentRecord({
        agent_id: "reviewer-other-workspace",
        surface_id: "surface:reviewer-other",
        workspace_id: "workspace:two",
        state: "ready",
        function: "reviewer",
      }),
      makeServerAgentRecord({
        agent_id: "implementor-a",
        surface_id: "surface:implementor-a",
        workspace_id: "workspace:one",
        state: "ready",
        function: "implementor",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Review the P6 receipt set",
        press_enter: true,
        targeting: {
          role: "reviewer",
          workspace: "workspace:one",
          agent_ids: ["reviewer-a", "reviewer-excluded", "implementor-a"],
          exclude: ["reviewer-excluded"],
        },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(Object.isFrozen(parsed.receipts)).toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      targeting: {
        role: "reviewer",
        workspace: "workspace:one",
        agent_ids: ["reviewer-a", "reviewer-excluded", "implementor-a"],
        exclude: ["reviewer-excluded"],
      },
      target_count: 3,
      resolved_target_count: 1,
      delivered_count: 1,
      failed_count: 0,
      skipped_count: 2,
      receipts: expect.arrayContaining([
        expect.objectContaining({
          requested_agent_id: "reviewer-a",
          agent_id: "reviewer-a",
          resolution: "resolved",
          delivered: true,
          typed: true,
          terminal: true,
          submit_verified: true,
          submit_evidence: "status_only",
          rpc_methods: ["surface.send_text", "surface.send_key"],
        }),
        expect.objectContaining({
          requested_agent_id: "reviewer-excluded",
          agent_id: "reviewer-excluded",
          resolution: "filtered_out",
          predicate: "exclude",
        }),
        expect.objectContaining({
          requested_agent_id: "implementor-a",
          agent_id: "implementor-a",
          resolution: "filtered_out",
          predicate: "role",
        }),
      ]),
    });
    expect(sendCalls.map((call) => call.surface)).toEqual([
      "surface:reviewer-a",
    ]);
  });

  it("send_to targeting reports unknown named ids alongside resolved deliveries", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "reviewer-known",
        surface_id: "surface:reviewer-known",
        state: "ready",
        function: "reviewer",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Review the named targets",
        press_enter: false,
        targeting: { agent_ids: ["reviewer-known", "reviewer-typo"] },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      ok: true,
      target_count: 2,
      resolved_target_count: 1,
      delivered_count: 0,
      skipped_count: 1,
      receipts: expect.arrayContaining([
        expect.objectContaining({
          requested_agent_id: "reviewer-known",
          agent_id: "reviewer-known",
          resolution: "resolved",
          delivered: false,
          typed: true,
          terminal: false,
        }),
        expect.objectContaining({
          requested_agent_id: "reviewer-typo",
          resolution: "unknown",
          delivered: false,
        }),
      ]),
    });
    expect(sendCalls.map((call) => call.surface)).toEqual([
      "surface:reviewer-known",
    ]);
  });

  it("send_to targeting refuses a zero-target resolution", async () => {
    const { server, sendCalls } = await createBroadcastServer([]);

    const result = await registeredTestTool(server, "send_to").handler(
      { text: "Gather now", targeting: { role: "gatherer" } },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("resolved zero targets");
    expect(sendCalls).toHaveLength(0);
  });

  it("send_to targeting resolves an unambiguous short agent-id prefix", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "cmuxlayerClaude-9c55eb04",
        surface_id: "surface:lead",
        state: "ready",
        function: "reviewer",
      }),
      makeServerAgentRecord({
        agent_id: "otherClaude-12345678",
        surface_id: "surface:other",
        state: "ready",
        function: "reviewer",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Reply with the verdict",
        press_enter: false,
        targeting: { agent_ids: ["cmuxlayerClaude-9c55"] },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.receipts).toEqual([
      expect.objectContaining({
        requested_agent_id: "cmuxlayerClaude-9c55",
        agent_id: "cmuxlayerClaude-9c55eb04",
        resolution: "resolved",
        delivered: false,
        typed: true,
        terminal: false,
      }),
    ]);
    expect(sendCalls.map((call) => call.surface)).toEqual(["surface:lead"]);
  });

  it("send_to targeting force-discovers a surface added after lifecycle startup", async () => {
    const firstUuid = "51111111-2222-4333-8444-555555555555";
    const secondUuid = "61111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:first-target",
        id: firstUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText("OpenAI Codex\nModel: gpt-5.5\n\ncodex> ");
    const record = makeServerAgentRecord({
      agent_id: "first-target-agent",
      surface_id: "surface:first-target",
      surface_uuid: firstUuid,
      workspace_id: "workspace:1",
      state: "ready",
    });
    const server = await createUuidRouteServer(routeClient, record);

    routeClient.setLiveSurfaces([
      {
        ref: "surface:first-target",
        id: firstUuid,
        workspace_ref: "workspace:1",
      },
      {
        ref: "surface:second-target",
        id: secondUuid,
        workspace_ref: "workspace:1",
      },
    ]);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Resolve against live reality",
        press_enter: false,
        targeting: { agent_ids: [`auto-codex-${secondUuid}`] },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.receipts).toEqual([
      expect.objectContaining({
        requested_agent_id: `auto-codex-${secondUuid}`,
        agent_id: `auto-codex-${secondUuid}`,
        resolution: "resolved",
        delivered: false,
        typed: true,
        terminal: false,
      }),
    ]);
    expect(routeClient.sendCalls.map((call) => call.surface)).toEqual([
      "surface:second-target",
    ]);
  });

  it("send_to targeting refuses an ambiguous agent-id prefix with candidates", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "cmuxlayerClaude-11111111",
        surface_id: "surface:one",
        state: "ready",
      }),
      makeServerAgentRecord({
        agent_id: "cmuxlayerClaude-22222222",
        surface_id: "surface:two",
        state: "ready",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Must not guess",
        targeting: { agent_ids: ["cmuxlayerClaude"] },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain(
      'Ambiguous agent_id prefix "cmuxlayerClaude"',
    );
    expect(parsed.error).toContain("cmuxlayerClaude-11111111");
    expect(parsed.error).toContain("cmuxlayerClaude-22222222");
    expect(sendCalls).toHaveLength(0);
  });

  it("send_to targeting delivers to a working agent without waiting for idle", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "implementor-busy",
        surface_id: "surface:implementor-busy",
        state: "working",
        function: "implementor",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Deliver this instruction",
        targeting: { agent_ids: ["implementor-busy"] },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.receipts).toEqual([
      expect.objectContaining({
        agent_id: "implementor-busy",
        delivery_state: "submitted",
        terminal: true,
        accepted: true,
        delivered: true,
        queued_behind_turn: true,
      }),
    ]);
    expect(sendCalls).toHaveLength(1);
  });

  it("send_to targeting counts a rescued target as failed", async () => {
    const record = makeServerAgentRecord({
      agent_id: "rescued-target",
      surface_id: "surface:rescued-target",
      state: "ready",
      function: "reviewer",
      cli: "codex",
    });
    const { server } = await createBroadcastServer([record], {
      rescuedSurface: record.surface_id,
    });

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Reply with the single word OK",
        targeting: { agent_ids: [record.agent_id] },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      target_count: 1,
      submitted_count: 0,
      queued_count: 0,
      delivered_count: 0,
      failed_count: 1,
      skipped_count: 0,
      receipts: [
        expect.objectContaining({
          agent_id: record.agent_id,
          delivery_state: "rescued",
          delivered: false,
          terminal: true,
        }),
      ],
    });
    expect(result.content[0].text).toContain("1 failed");
  }, 20_000);

  it("send_to rejects targeting combined with a singular agent id", async () => {
    const { server, sendCalls } = await createBroadcastServer([]);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: "one-agent",
        text: "Do not choose a route",
        targeting: { role: "reviewer" },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain(
      "send_to accepts either targeting or agent_id/target, not both",
    );
    expect(sendCalls).toHaveLength(0);
  });

  it("send_to structured targeting returns one stable receipt set when one target fails", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "gatherer-ok",
        surface_id: "surface:gatherer-ok",
        state: "ready",
        function: "gatherer",
      }),
      makeServerAgentRecord({
        agent_id: "gatherer-fail",
        surface_id: "surface:gatherer-fail",
        state: "ready",
        function: "gatherer",
      }),
    ];
    const { server } = await createBroadcastServer(records, {
      failSurface: "surface:gatherer-fail",
    });

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Gather receipts",
        targeting: { role: "gatherer" },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      target_count: 2,
      delivered_count: 1,
      failed_count: 1,
      skipped_count: 0,
      receipts: expect.arrayContaining([
        expect.objectContaining({
          agent_id: "gatherer-ok",
          delivered: true,
        }),
        expect.objectContaining({
          agent_id: "gatherer-fail",
          delivered: false,
          error: expect.stringContaining(
            "send failed for surface:gatherer-fail",
          ),
        }),
      ]),
    });
  });

  it("send_to structured targeting skips non-deliverable targets with stable receipts", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "implementor-ready",
        surface_id: "surface:implementor-ready",
        state: "ready",
        function: "implementor",
      }),
      makeServerAgentRecord({
        agent_id: "implementor-done",
        surface_id: "surface:implementor-done",
        state: "done",
        function: "implementor",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);

    const result = await registeredTestTool(server, "send_to").handler(
      { text: "Apply P6", targeting: { role: "implementor" } },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      target_count: 2,
      delivered_count: 1,
      failed_count: 0,
      skipped_count: 1,
      receipts: expect.arrayContaining([
        expect.objectContaining({
          agent_id: "implementor-done",
          delivered: false,
          skipped: "dead:done",
        }),
      ]),
    });
    expect(sendCalls.map((call) => call.surface)).toEqual([
      "surface:implementor-ready",
    ]);
  });

  it("send_to structured targeting preflights every composer before the first delivery", async () => {
    const records = [
      makeServerAgentRecord({
        agent_id: "a-gatherer-gemini",
        surface_id: "surface:gatherer-gemini",
        state: "ready",
        function: "gatherer",
        cli: "gemini",
      }),
      makeServerAgentRecord({
        agent_id: "z-gatherer-claude",
        surface_id: "surface:gatherer-claude",
        state: "ready",
        function: "gatherer",
        cli: "claude",
      }),
    ];
    const { server, sendCalls } = await createBroadcastServer(records);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "paragraph one\n\nparagraph two",
        targeting: { role: "gatherer" },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain("refuses multi-paragraph inline text");
    expect(sendCalls).toHaveLength(0);
  });

  it("send_to targeting rejects authority and placement labels as roles", async () => {
    const { server, sendCalls } = await createBroadcastServer([]);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        text: "Must not target by authority",
        targeting: { role: "worker" },
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain("targeting.role");
    expect(sendCalls).toHaveLength(0);
  });

  it("list_agents state filter uses the reconciled screen-active state", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];

    await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "begin work",
      },
      {} as any,
    );

    const result = await list.handler({ detail: "full" }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0]).toMatchObject({
      repo: "brainlayer",
      state: {
        value: "working",
        source: "screen",
        observed_at_ms: expect.any(Number),
      },
      health: {
        status: "healthy",
        issue_codes: expect.arrayContaining(["registry_screen_disagreement"]),
        issue_severities: {
          registry_screen_disagreement: "info",
        },
        reconciled_state: "working",
      },
    });
  });

  it("list_agents does not invert a UUID-backed row from its recycled cached ref", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:old",
        id: stableUuid,
        workspace_ref: "workspace:old",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "uuid-list-health-missing",
      surface_id: "surface:old",
      surface_uuid: stableUuid,
      workspace_id: "workspace:old",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:old",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:old",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)",
    );

    const parsed = parseToolResult(
      await registeredTestTool(server, "list_agents").handler(
        { detail: "full" },
        {},
      ),
    );
    const agent = (parsed.agents as Array<Record<string, any>>).find(
      (candidate) => candidate.agent_id === record.agent_id,
    );

    expect(agent).toBeDefined();
    expect(agent?.state).toMatchObject({
      value: "ready",
      source: "registry",
    });
    expect(agent?.health?.reconciled_state).toBeUndefined();
    expect(agent?.health?.issue_codes ?? []).not.toContain(
      "registry_screen_disagreement",
    );
  });

  it("list_agents does not read a UUID-less row owned by a foreign observer", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:shared",
        workspace_ref: "workspace:current",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "foreign-observer-list-health",
      surface_id: "surface:shared",
      surface_uuid: null,
      surface_observer_id: "cmux:/tmp/foreign.sock",
      workspace_id: "workspace:foreign",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    enforceTestObserverOwnership(server, "cmux:/tmp/current.sock");
    routeClient.setScreenText(
      "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)",
    );

    const parsed = parseToolResult(
      await registeredTestTool(server, "list_agents").handler(
        { detail: "full" },
        {},
      ),
    );
    const agent = (parsed.agents as Array<Record<string, any>>).find(
      (candidate) => candidate.agent_id === record.agent_id,
    );

    expect(agent).toBeDefined();
    expect(agent?.state).toMatchObject({
      value: "ready",
      source: "registry",
    });
    expect(agent?.health?.reconciled_state).toBeUndefined();
    expect(agent?.health?.issue_codes ?? []).not.toContain(
      "registry_screen_disagreement",
    );
  });

  it("get_agent_state reads health from a UUID's fresh moved ref", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:old",
        id: stableUuid,
        workspace_ref: "workspace:old",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "uuid-get-health-moved",
      surface_id: "surface:old",
      surface_uuid: stableUuid,
      workspace_id: "workspace:old",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:old",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:old",
      },
      {
        ref: "surface:new",
        id: stableUuid,
        workspace_ref: "workspace:new",
      },
    ]);
    routeClient.client.readScreen.mockImplementation(
      async (surface: string) => ({
        surface,
        text:
          surface === "surface:new"
            ? "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)"
            : "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\ncodex> ",
        lines: 20,
        scrollback_used: false,
      }),
    );

    const parsed = parseToolResult(
      await registeredTestTool(server, "get_agent_state").handler(
        { agent_id: record.agent_id },
        {},
      ),
    );

    expect(parsed.health).toMatchObject({
      reconciled_state: "working",
      issue_codes: expect.arrayContaining(["registry_screen_disagreement"]),
    });
    expect(routeClient.client.readScreen).toHaveBeenCalledWith(
      "surface:new",
      expect.anything(),
    );
  });

  it("list_agents reports an active pane unhealthy after repeated broken-pipe writes", async () => {
    const record = makeServerAgentRecord({
      agent_id: "codex-dead-pty",
      surface_id: "surface:dead-pty",
      workspace_id: "workspace:1",
      state: "done",
    });
    const { server, client } = await createBroadcastServer([record]);
    client.readScreen.mockResolvedValue({
      surface: record.surface_id,
      text: "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (41s - esc to interrupt)",
      lines: 20,
      scrollback_used: false,
    });
    client.send.mockRejectedValue(
      Object.assign(
        new Error("Failed to write to socket (Broken pipe, errno 32)"),
        {
          code: "EPIPE",
          errno: 32,
        },
      ),
    );
    const sendInput = (server as any)._registeredTools["send_input"];
    const listAgents = (server as any)._registeredTools["list_agents"];
    const sendArgs = sendInput.inputSchema.parse({
      surface: record.surface_id,
      text: "ping",
      press_enter: false,
    });

    await sendInput.handler(sendArgs, {} as any);
    await sendInput.handler(sendArgs, {} as any);
    const parsed = parseToolResult(
      await listAgents.handler({ detail: "full" }, {} as any),
    ) as {
      agents: Array<{ health: { status: string; issue_codes: string[] } }>;
    };

    expect(parsed.agents[0]?.health).toMatchObject({
      status: "unhealthy",
      issue_codes: expect.arrayContaining(["pane_pty_dead"]),
    });
  });

  it("list_agents includes resume_command when a session id is captured", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "task 1",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const stateMgr = engine["stateMgr"];
    const currentAgentId = resolveCurrentTestAgentId(stateMgr, agentId);
    const updated = stateMgr.updateRecord(currentAgentId, {
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      launcher_name: "brainlayerClaude",
      launch_cwd: "/home/test-user/Gits/brainlayer",
    });
    engine.getRegistry().set(currentAgentId, updated);

    const result = await list.handler({}, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.agents[0]).toMatchObject({
      session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      resume_command:
        "brainlayerClaude -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
  });

  it("list_agents emits a raw cd+CLI resume for a launcher-less agent (#392)", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const list = (server as any)._registeredTools["list_agents"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "task 1",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const stateMgr = engine["stateMgr"];
    const currentAgentId = resolveCurrentTestAgentId(stateMgr, agentId);
    const updated = stateMgr.updateRecord(currentAgentId, {
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      launcher_name: null,
      launch_cwd: "/srv/repos/brainlayer",
    });
    engine.getRegistry().set(currentAgentId, updated);

    const result = await list.handler({}, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.agents[0].resume_command).toBe(
      "cd '/srv/repos/brainlayer' && MCP_CONNECTION_NONBLOCKING=1 CLAUDE_CODE_NO_FLICKER=1 claude --dangerously-skip-permissions --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
  });

  it("get_agent_state returns full record", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "golems",
        model: "codex",
        cli: "codex",
        prompt: "prune skills",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const result = await getState.handler({ agent_id: agentId }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(parsed.cli).toBe("codex");
    expect(parsed.resume_command).toBeUndefined();
    expect(parsed.health).toMatchObject({
      status: "healthy",
      issue_codes: expect.arrayContaining([
        "missing_cli_session_id",
        "non_resumable",
        "inbox_monitor_not_alive",
      ]),
    });
  });

  it("get_agent_state reports terminal workers without done evidence as closure health failures", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      {
        repo: "golems",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    // Detach the seat from any live pane. Under F1 a screen that still reads
    // WORKING overrules a `done` record — so to test the closure-evidence rule
    // the record has to be the only evidence there is, which is exactly the
    // case a lead faces when a worker's pane is gone.
    const done = {
      ...engine.stateMgr.transition(agentId, "done"),
      surface_uuid: "00000000-0000-4000-8000-00000000dead",
    };
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.health).toMatchObject({
      status: "unhealthy",
      issue_codes: expect.arrayContaining(["closure_without_artifact"]),
    });
  });

  it("get_agent_state verifies the report artifact before marking a done worker closeable", async () => {
    const goalPath = join(TEST_DIR, "phase-7-goal.md");
    const reportPath = join(TEST_DIR, "phase-7-report.md");
    writeFileSync(
      goalPath,
      [
        "# Phase 7 Goal",
        "",
        "Write the report to:",
        "",
        `\`${reportPath}\``,
        "",
        "The final report line must be exactly:",
        "",
        "`DONE_P7_HARVESTABILITY`",
        "",
      ].join("\n"),
      "utf8",
    );

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-harvestability";
    const doneWithTimestamp = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
    });
    engine.stateMgr.writeState(doneWithTimestamp);
    engine.getRegistry().set(agentId, doneWithTimestamp);

    const missingResult = await getState.handler({ agent_id: agentId }, {});
    const missing = parseToolResult(missingResult);
    expect(missing.harvestability).toMatchObject({
      closeable: false,
      closure_artifact_verified: false,
      report_path: reportPath,
      done_marker: "DONE_P7_HARVESTABILITY",
    });
    expect((missing.health as { issue_codes: string[] }).issue_codes).toContain(
      "closure_without_artifact",
    );

    writeFileSync(
      reportPath,
      "Status: COMPLETE\nDONE_P7_HARVESTABILITY\n",
      "utf8",
    );
    const verifiedResult = await getState.handler({ agent_id: agentId }, {});
    const verified = parseToolResult(verifiedResult);
    expect(verified.harvestability).toMatchObject({
      closeable: true,
      closure_artifact_verified: true,
      report_path: reportPath,
      done_marker: "DONE_P7_HARVESTABILITY",
    });
    expect(
      (verified.health as { issue_codes: string[] }).issue_codes,
    ).not.toContain("closure_without_artifact");
  });

  it("get_agent_state accepts a report written before done detection when it is newer than the goal file", async () => {
    const goalPath = join(TEST_DIR, "pre-done-report-goal.md");
    const reportPath = join(TEST_DIR, "pre-done-report.md");
    writeFileSync(
      goalPath,
      [
        "# Pre Done Report Goal",
        "",
        "Write the report to:",
        "",
        `\`${reportPath}\``,
        "",
        "Final line:",
        "",
        "`DONE_PRE_DETECTION_REPORT`",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      reportPath,
      "Status: COMPLETE\nDONE_PRE_DETECTION_REPORT\n",
      "utf8",
    );
    const goalTime = new Date("2026-07-05T06:00:00.000Z");
    const reportTime = new Date("2026-07-05T06:30:00.000Z");
    utimesSync(goalPath, goalTime, goalTime);
    utimesSync(reportPath, reportTime, reportTime);

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-pre-done-report";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
      task_done_detected_at: "2026-07-05T07:00:00.000Z",
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: true,
      closure_artifact_verified: true,
      report_fresh: true,
    });
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).not.toContain("closure_without_artifact");
  });

  it("get_agent_state prefers report-path context over unrelated markdown code spans", async () => {
    const goalPath = join(TEST_DIR, "report-path-context-goal.md");
    const reportPath = join(TEST_DIR, "report-path-context-report.md");
    writeFileSync(
      goalPath,
      [
        "# Report Path Context Goal",
        "",
        "Read `README.md` and `docs/design.md` before implementation.",
        "",
        "Report:",
        "",
        `\`${reportPath}\``,
        "",
        "End with:",
        "",
        "`DONE_REPORT_PATH_CONTEXT`",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      reportPath,
      "Status: COMPLETE\nDONE_REPORT_PATH_CONTEXT\n",
      "utf8",
    );

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-report-path-context";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: true,
      closure_artifact_verified: true,
      report_path: reportPath,
    });
  });

  it("get_agent_state keeps PR-loop workers uncloseable until PR status or handoff is recorded", async () => {
    const goalPath = join(TEST_DIR, "pr-loop-goal.md");
    const reportPath = join(TEST_DIR, "pr-loop-report.md");
    writeFileSync(
      goalPath,
      [
        "# PR Loop Goal",
        "",
        "Report:",
        "",
        `\`${reportPath}\``,
        "",
        "End with:",
        "",
        "`DONE_PR_LOOP_WORKER`",
        "",
        "Run `/pr-loop` after implementation.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      reportPath,
      "Status: COMPLETE\nhandoff: none\nDONE_PR_LOOP_WORKER\n",
      "utf8",
    );

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-pr-loop";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
      task_summary: "pr-loop implementation worker",
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: false,
      closure_artifact_verified: true,
      pr_loop_required: true,
    });
    expect((parsed.health as { issue_codes: string[] }).issue_codes).toContain(
      "pr_loop_incomplete",
    );
  });

  it("get_agent_state accepts completed handoff evidence for PR-loop workers", async () => {
    const goalPath = join(TEST_DIR, "pr-loop-handoff-goal.md");
    const reportPath = join(TEST_DIR, "pr-loop-handoff-report.md");
    writeFileSync(
      goalPath,
      [
        "# PR Loop Handoff Goal",
        "",
        "Report:",
        "",
        `\`${reportPath}\``,
        "",
        "End with:",
        "",
        "`DONE_PR_LOOP_HANDOFF`",
        "",
        "Run `/pr-loop` after implementation.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      reportPath,
      "Status: COMPLETE\nhandoff: complete to lead for merge ownership\nDONE_PR_LOOP_HANDOFF\n",
      "utf8",
    );

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-pr-loop-handoff";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
      task_summary: "pr-loop implementation worker",
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: true,
      closure_artifact_verified: true,
      pr_loop_required: true,
      pr_loop_satisfied: true,
    });
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).not.toContain("pr_loop_incomplete");
  });

  it("get_agent_state ignores reviewer-pairing boilerplate and negated PR-loop mentions", async () => {
    const goalPath = join(TEST_DIR, "non-pr-loop-goal.md");
    const reportPath = join(TEST_DIR, "non-pr-loop-report.md");
    writeFileSync(
      goalPath,
      [
        "# Non PR Deliverable Goal",
        "",
        "Report:",
        "",
        `\`${reportPath}\``,
        "",
        "End with:",
        "",
        "`DONE_NO_PR_WORKER`",
        "",
        "Claude reviewer pairs before pr-loop.",
        "No pr loop deliverable for this worker.",
        "Do not open a PR in this lane.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(reportPath, "Status: COMPLETE\nDONE_NO_PR_WORKER\n", "utf8");

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-no-pr-loop";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
      task_summary: "worker with no pr loop phrase in the title",
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: true,
      closure_artifact_verified: true,
      pr_loop_required: false,
      pr_loop_satisfied: null,
    });
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).not.toContain("pr_loop_incomplete");
  });

  it("get_agent_state rejects stale reports written before the goal contract file", async () => {
    const goalPath = join(TEST_DIR, "stale-report-goal.md");
    const reportPath = join(TEST_DIR, "stale-report.md");
    writeFileSync(
      goalPath,
      [
        "# Stale Report Goal",
        "",
        "Write report to:",
        "",
        `\`${reportPath}\``,
        "",
        "Final line:",
        "",
        "`DONE_STALE_REPORT`",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(reportPath, "Status: COMPLETE\nDONE_STALE_REPORT\n", "utf8");
    const goalTime = new Date("2026-07-05T07:00:00.000Z");
    const staleReportTime = new Date("2026-07-05T06:59:00.000Z");
    utimesSync(goalPath, goalTime, goalTime);
    utimesSync(reportPath, staleReportTime, staleReportTime);

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-stale-report";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
      task_done_detected_at: "2026-07-05T07:00:00.000Z",
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: false,
      closure_artifact_verified: false,
      report_fresh: false,
    });
    expect(
      (parsed.harvestability as { issue_codes: string[] }).issue_codes,
    ).toContain("report_stale");
    expect((parsed.health as { issue_codes: string[] }).issue_codes).toContain(
      "closure_without_artifact",
    );
  });

  it("get_agent_state does not treat non-DONE terminal markers as closeable", async () => {
    const goalPath = join(TEST_DIR, "not-green-goal.md");
    const reportPath = join(TEST_DIR, "not-green-report.md");
    writeFileSync(
      goalPath,
      [
        "# Not Green Goal",
        "",
        "Write report to:",
        "",
        `\`${reportPath}\``,
        "",
        "Final line:",
        "",
        "`NOT_GREEN_P7`",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(reportPath, "Status: NOT_GREEN\nNOT_GREEN_P7\n", "utf8");

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-not-green";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: false,
      closure_artifact_verified: false,
      done_marker: null,
    });
    expect((parsed.health as { issue_codes: string[] }).issue_codes).toContain(
      "closure_without_artifact",
    );
  });

  it("get_agent_state normalizes persisted legacy IC agents to workers that require closure artifacts", async () => {
    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "claude-cmuxlayer-ic-done";
    const doneWorker = makeServerAgentRecord({
      agent_id: agentId,
      cli: "claude",
      role: "worker",
      task_summary: "legacy integration coordinator",
    });
    engine.stateMgr.writeState(doneWorker);
    writeFileSync(
      join(TEST_DIR, agentId, "state.json"),
      JSON.stringify({ ...doneWorker, role: "ic" }),
      "utf8",
    );
    const normalized = engine.stateMgr.readState(agentId);
    expect(normalized?.role).toBe("worker");
    engine.getRegistry().set(agentId, normalized!);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: false,
      closure_artifact_verified: false,
    });
    expect((parsed.health as { issue_codes: string[] }).issue_codes).toContain(
      "closure_without_artifact",
    );
  });

  it("get_agent_state does not mark non-done workers unhealthy for missing completion evidence", async () => {
    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-working-no-session-file";
    const working = makeServerAgentRecord({
      agent_id: agentId,
      state: "working",
      cli_session_id: "019eab06-57d6-72b1-b3a8-6cf98a30a3f6",
      cli_session_path: join(TEST_DIR, "missing-working-codex-session.jsonl"),
      task_done_detected_at: null,
    });
    engine.stateMgr.writeState(working);
    engine.getRegistry().set(agentId, working);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: false,
      closure_artifact_verified: null,
      evidence_channel: {
        done_source: "none",
        degraded: false,
      },
    });
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).not.toContain("degraded_evidence_channel");
  });

  it("get_agent_state anchors KEPT_OPEN owner and next check to the KEPT_OPEN block", async () => {
    const goalPath = join(TEST_DIR, "kept-open-block-goal.md");
    const reportPath = join(TEST_DIR, "kept-open-block-report.md");
    writeFileSync(
      goalPath,
      [
        "# Kept Open Goal",
        "",
        "Write report to:",
        "",
        `\`${reportPath}\``,
        "",
        "Final line:",
        "",
        "`DONE_KEEP_OPEN_BLOCK`",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      reportPath,
      [
        "owner: stale lead metadata",
        "next check: not part of kept-open",
        "",
        "Status: needs human follow-up",
        "KEPT_OPEN: waiting for reviewer handoff",
        "DONE_KEEP_OPEN_BLOCK",
        "",
      ].join("\n"),
      "utf8",
    );

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-kept-open-block";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: false,
      closure_artifact_verified: true,
      kept_open: {
        present: true,
        reason: "waiting for reviewer handoff",
        owner: null,
        next_check: null,
        complete: false,
      },
    });
    expect((parsed.health as { issue_codes: string[] }).issue_codes).toContain(
      "kept_open_contract_incomplete",
    );
  });

  it("get_agent_state reports degraded evidence when done relies on screen fallback after harness read failure", async () => {
    const goalPath = join(TEST_DIR, "degraded-goal.md");
    const reportPath = join(TEST_DIR, "degraded-report.md");
    writeFileSync(
      goalPath,
      [
        "# Degraded Evidence Goal",
        "",
        "Write report to:",
        "",
        `\`${reportPath}\``,
        "",
        "Final report line:",
        "",
        "`DONE_DEGRADED_EVIDENCE`",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      reportPath,
      "Status: COMPLETE\nDONE_DEGRADED_EVIDENCE\n",
      "utf8",
    );

    const server = createLifecycleServer(mockExec);
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-degraded";
    const done = makeServerAgentRecord({
      agent_id: agentId,
      cli_session_id: "019eab06-57d6-72b1-b3a8-6cf98a30a3f6",
      cli_session_path: join(TEST_DIR, "missing-codex-session.jsonl"),
      goal_file: goalPath,
    });
    engine.stateMgr.writeState(done);
    engine.getRegistry().set(agentId, done);

    const result = await getState.handler({ agent_id: agentId }, {});
    const parsed = parseToolResult(result);
    expect(parsed.harvestability).toMatchObject({
      closeable: true,
      closure_artifact_verified: true,
      evidence_channel: {
        done_source: "screen",
        degraded: true,
      },
    });
    expect((parsed.health as { issue_codes: string[] }).issue_codes).toContain(
      "degraded_evidence_channel",
    );
  });

  it("get_agent_state does not require closure artifacts for errored workers", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      {
        repo: "golems",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    engine
      .getRegistry()
      .set(agentId, engine.stateMgr.transition(agentId, "ready"));
    engine
      .getRegistry()
      .set(agentId, engine.stateMgr.transition(agentId, "working"));
    const errored = engine.stateMgr.transition(agentId, "error", {
      error: "tool transport closed",
    });
    engine.getRegistry().set(agentId, errored);

    const result = await getState.handler({ agent_id: agentId }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.health.issue_codes).not.toContain("closure_without_artifact");
  });

  it("get_agent_state reports recoverable blocker health from parsed screen actions", async () => {
    const blockerScreen = `
OpenAI Codex

I cannot commit, push, or open a PR without explicit permission, so I am waiting for Etan.

codex>
`;
    let blockerSurfaceLive = false;
    let launchSent = false;
    let pendingBootText = "";
    let bootSubmitted = false;
    const mockClient = {
      createWorkspace: vi.fn(),
      selectWorkspace: vi.fn().mockResolvedValue(undefined),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:1",
            title: "Main",
            selected: true,
            current_directory: "/home/test-user/Gits/cmuxlayer",
          },
        ],
      }),
      listPanes: vi.fn().mockImplementation(async () => ({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        panes: blockerSurfaceLive
          ? [
              {
                ref: "pane:blocker",
                index: 0,
                focused: true,
                surface_count: 1,
                surface_refs: ["surface:blocker"],
                selected_surface_ref: "surface:blocker",
              },
            ]
          : [],
      })),
      listPaneSurfaces: vi.fn().mockImplementation(async () => ({
        workspace_ref: "workspace:1",
        window_ref: "window:1",
        pane_ref: "pane:blocker",
        surfaces: blockerSurfaceLive
          ? [
              {
                ref: "surface:blocker",
                title: "cmuxlayerCodex",
                type: "terminal",
                index: 0,
                selected: true,
              },
            ]
          : [],
      })),
      newSplit: vi.fn().mockImplementation(async () => {
        blockerSurfaceLive = true;
        return {
          workspace: "workspace:1",
          surface: "surface:blocker",
          pane: "pane:blocker",
          title: "",
          type: "terminal",
        };
      }),
      newSurface: vi.fn(),
      focusSurface: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockImplementation(async (_surface, text: string) => {
        if (!launchSent) launchSent = true;
        else pendingBootText += text;
      }),
      sendKey: vi.fn().mockImplementation(async (_surface, key: string) => {
        if (key === "return" && pendingBootText) bootSubmitted = true;
      }),
      readScreen: vi.fn().mockImplementation(async () => ({
        surface: "surface:blocker",
        text:
          pendingBootText && !bootSubmitted
            ? `OpenAI Codex\n› ${pendingBootText}\ngpt-5.5 high · ~/repo`
            : bootSubmitted
              ? `OpenAI Codex\n• ${pendingBootText}\nWorking\n${blockerScreen}`
              : blockerScreen,
        lines: 20,
        scrollback_used: false,
      })),
      log: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
      setProgress: vi.fn().mockResolvedValue(undefined),
      closeSurface: vi.fn().mockResolvedValue(undefined),
      listSurfaces: vi.fn().mockResolvedValue([
        {
          ref: "surface:blocker",
          title: "cmuxlayerCodex",
          type: "terminal",
          index: 0,
          selected: true,
          workspace_ref: "workspace:1",
        },
      ]),
      identify: vi.fn().mockResolvedValue({}),
      browser: vi.fn().mockResolvedValue({}),
    };
    const server = createTrackedServer({
      client: mockClient as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "cmuxlayer",
        model: "gpt-5.5",
        cli: "codex",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const result = await getState.handler({ agent_id: agentId }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.health).toMatchObject({
      status: "unhealthy",
      issue_codes: expect.arrayContaining([
        "recoverable_blocker_requires_action",
      ]),
      recommended_actions: ["route_pr_loop"],
    });
  });

  it("get_agent_state marks auto-discovered null-session agents unresumable", async () => {
    const context = createServerContext({
      exec: mockExec,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    serverContexts.push(context);
    context.stateMgr.ensureAutoRecord("auto-codex-surface-new", {
      surface_id: "surface:new",
      surface_title: "cmuxlayerCodex",
      workspace_id: "workspace:1",
      cli: "codex",
      parsed_status: "idle",
      model: null,
      token_count: null,
      context_pct: null,
      has_agent: true,
      read_error: false,
    });
    const server = createServer({ context });
    await context.lifecycleStartPromise;
    const getState = (server as any)._registeredTools["get_agent_state"];

    const result = await getState.handler(
      { agent_id: "auto-codex-surface-new" },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      ok: true,
      agent_id: "auto-codex-surface-new",
      task_summary: "(auto-discovered)",
      cli_session_id: null,
      cli_session_path: null,
      pid: null,
      resumable: false,
      health: {
        status: "healthy",
        issue_codes: expect.arrayContaining([
          "auto_discovered_agent",
          "missing_cli_session_id",
          "non_resumable",
          "inbox_monitor_not_alive",
        ]),
        issues: expect.any(Array),
      },
    });
    expect(parsed.resume_command).toBeUndefined();
  });

  it("get_agent_state includes resume_command when a session id is captured", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      {
        repo: "golems",
        model: "codex",
        cli: "codex",
        prompt: "prune skills",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const stateMgr = engine["stateMgr"];
    const currentAgentId = resolveCurrentTestAgentId(stateMgr, agentId);
    const updated = stateMgr.updateRecord(currentAgentId, {
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      launcher_name: "golemsCodex",
    });
    engine.getRegistry().set(currentAgentId, updated);

    const result = await getState.handler(
      { agent_id: currentAgentId },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.resume_command).toBe(
      "golemsCodex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    );
  });

  it("get_agent_state returns error for unknown agent", async () => {
    const server = createLifecycleServer(mockExec);
    const getState = (server as any)._registeredTools["get_agent_state"];

    const result = await getState.handler(
      { agent_id: "nonexistent" },
      {} as any,
    );
    expect(result.isError).toBe(true);
  });

  it("send_to_agent compatibility path inherits send_to's no-idle-wait behavior", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to_agent"];

    const spawnResult = await spawn.handler(
      {
        repo: "test",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const result = await sendTo.handler(
      { agent_id: agentId, text: "hello", press_enter: true },
      {} as any,
    );
    const parsed = parseToolResult(result);
    expect(result.isError).toBeFalsy();
    expect(parsed.terminal).toBe(true);
    expect(parsed.delivery_state).toBe("submitted");
    expect(parsed.submit_verified).toBe(true);
  });

  it("send_to_agent leaves an idle agent idle when submitted delivery fails", async () => {
    let failReturn = false;
    const base = makeLifecycleExec({
      surfaceUuid: "11111111-2222-4333-8444-555555555555",
    });
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      if (failReturn && args.includes("send-key") && args.includes("return")) {
        throw new Error("Return delivery failed");
      }
      return base(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to_agent"];
    const spawnResult = await spawn.handler(
      { repo: "test", model: "sonnet", cli: "claude" },
      {} as any,
    );
    const agentId = parseToolResult(spawnResult).agent_id as string;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const idle = engine.stateMgr.resetState(
      agentId,
      "idle",
      {},
      "test delivery precondition",
    );
    engine.getRegistry().set(agentId, idle);
    failReturn = true;

    const result = await sendTo.handler(
      { agent_id: agentId, text: "continue", press_enter: true },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(engine.getAgentState(agentId)?.state).toBe("idle");
  });

  it("send_to returns a keyed terminal failed receipt when delivery fails", async () => {
    let failReturn = false;
    const base = makeLifecycleExec({
      surfaceUuid: "11111111-2222-4333-8444-555555555555",
    });
    const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
      if (failReturn && args.includes("send-key") && args.includes("return")) {
        throw new Error("Return delivery failed");
      }
      return base(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];
    const spawnResult = await spawn.handler(
      { repo: "test", model: "sonnet", cli: "claude" },
      {} as any,
    );
    const agentId = parseToolResult(spawnResult).agent_id as string;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const idle = engine.stateMgr.resetState(agentId, "idle", {});
    engine.getRegistry().set(agentId, idle);
    failReturn = true;

    const result = await sendTo.handler(
      { agent_id: agentId, text: "continue", press_enter: true },
      {} as any,
    );
    const failed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(failed).toMatchObject({
      delivery_id: expect.any(String),
      delivery_state: "failed",
      terminal: true,
    });
    expect(engine.getDeliveryReceipt(failed.delivery_id)).toMatchObject({
      delivery_state: "failed",
      terminal: true,
    });
  });

  it.each(["send_to", "send_to_agent"] as const)(
    "%s refuses routed delivery when the agent pane has fallen back to a bare shell",
    async (toolName) => {
      let showBareShell = false;
      const base = makeLifecycleExec({
        surfaceUuid: "11111111-2222-4333-8444-555555555555",
      });
      const exec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
        if (showBareShell && args.includes("read-screen")) {
          return {
            stdout: JSON.stringify({
              surface: "surface:new",
              text: "etan@mac cmuxlayer %",
              lines: 1,
              scrollback_used: false,
            }),
            stderr: "",
          };
        }
        return base(cmd, args);
      });
      const server = createLifecycleServer(exec);
      const spawn = (server as any)._registeredTools["spawn_agent"];
      const sendTo = (server as any)._registeredTools[toolName];
      const spawnResult = await spawn.handler(
        { repo: "test", model: "sonnet", cli: "claude" },
        {} as any,
      );
      const agentId = parseToolResult(spawnResult).agent_id as string;
      const engine = (server as any)._registeredTools["interact"]._engine;
      const registry = engine.getRegistry();
      const exited = engine.stateMgr.updateRecord(agentId, {
        state: "error",
        error: "Agent CLI exited",
      });
      registry.set(agentId, exited);
      showBareShell = true;
      exec.mockClear();

      const result = await sendTo.handler(
        { agent_id: agentId, text: "Etan routed message", press_enter: false },
        {} as any,
      );

      expect(result.isError).toBe(true);
      expect(parseToolResult(result).error).toMatch(
        /exited \/ no agent currently initiated/i,
      );
      expect(
        exec.mock.calls.filter(([, args]) => args.includes("send")),
      ).toEqual([]);
    },
  );

  it.each(["send_to", "send_to_agent"] as const)(
    "RC3: %s delivers to an error-state agent whose surface is alive",
    async (toolName) => {
      const server = createLifecycleServer(mockExec);
      const spawn = (server as any)._registeredTools["spawn_agent"];
      const sendTo = (server as any)._registeredTools[toolName];
      const spawnResult = await spawn.handler(
        { repo: "test", model: "sonnet", cli: "claude" },
        {} as any,
      );
      const agentId = parseToolResult(spawnResult).agent_id as string;
      const engine = (server as any)._registeredTools["interact"]._engine;
      const registry = engine.getRegistry();
      const liveError = engine.stateMgr.updateRecord(agentId, {
        state: "error",
        error: "Boot prompt delivery interrupted before completion",
      });
      registry.set(agentId, liveError);
      mockExec.mockClear();

      const result = await sendTo.handler(
        { agent_id: agentId, text: "recover", press_enter: false },
        {} as any,
      );

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toMatchObject({
        ok: true,
        agent_id: agentId,
      });
      expect(mockExec).toHaveBeenCalledWith(
        "cmux",
        expect.arrayContaining(["send", "--surface", "surface:new", "recover"]),
      );
    },
  );

  it("send_to delivers to a working agent without an idle gate", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const working = engine.stateMgr.transition(agentId, "working");
    registry.set(agentId, working);
    mockExec.mockClear();

    const result = await sendTo.handler(
      {
        agent_id: agentId,
        text: "interject while working",
        press_enter: true,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const sendCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("send"),
    );
    const deliveredText = sendCalls.map(([, args]) => args.at(-1)).join("");

    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(parsed.queued_behind_turn).toBe(true);
    expect(parsed.transport).toBe("cli");
    expect(parsed.socket_path).toBeNull();
    expect(parsed.socket_path_state).toBe("unavailable");
    expect(parsed.warnings).toContain("cli_fallback_active");
    expect(deliveredText).toBe("interject while working");
    expect(sendCalls[0]?.[1]).toEqual(
      expect.arrayContaining(["--workspace", "workspace:1"]),
    );
  });

  it("send_to follows a stable UUID when its mutable surface ref changes", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const recycledUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:7",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const stateMgr = new StateManager(TEST_DIR);
    const record = makeServerAgentRecord({
      agent_id: "uuid-routed-agent",
      surface_id: "surface:7",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    stateMgr.writeState(record);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;
    routeClient.setLiveSurfaces([
      {
        ref: "surface:7",
        id: recycledUuid,
        workspace_ref: "workspace:1",
      },
      {
        ref: "surface:8",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "route by UUID",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:8", text: "route by UUID" },
    ]);
    expect(routeClient.client.send).not.toHaveBeenCalledWith(
      "surface:7",
      expect.anything(),
      expect.anything(),
    );
  });

  it("send_to delivers to an idle live agent with a recorded pid when its stable UUID route is valid", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:send-1",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "send-1-recorded-pid",
      surface_id: "surface:send-1",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "idle",
      pid: process.pid,
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "send 1",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:send-1", text: "send 1" },
    ]);
    expect(String(parseToolResult(result).error ?? "")).not.toMatch(
      /topology did not prove its surface route/i,
    );
  });

  it("send_to rechecks for a bare shell after its final agent route resolution", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:agent",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText(
      "OpenAI Codex\nModel: gpt-5.5\nWorking (1s - esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "uuid-route-rebinds-to-shell",
      surface_id: "surface:agent",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const engine = testLifecycleEngine(server) as any;
    const originalResolveAgentIoRoute = engine.resolveAgentIoRoute.bind(engine);
    let resolveCount = 0;
    vi.spyOn(engine, "resolveAgentIoRoute").mockImplementation(
      async (agentId: string) => {
        resolveCount += 1;
        if (resolveCount === 2) {
          routeClient.setLiveSurfaces([
            {
              ref: "surface:shell",
              id: stableUuid,
              workspace_ref: "workspace:1",
            },
          ]);
          routeClient.setScreenText("etan@mac cmuxlayer %");
        }
        return originalResolveAgentIoRoute(agentId);
      },
    );
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "must not execute after route rebind",
        press_enter: false,
      },
      {},
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(
      /exited \/ no agent currently initiated/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
    expect(routeClient.client.send).not.toHaveBeenCalled();
  });

  it("send_to ignores unrelated surface churn while the target agent stays healthy", async () => {
    const targetUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:agent",
        id: targetUuid,
        workspace_ref: "workspace:1",
      },
      {
        ref: "surface:other",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText(
      "OpenAI Codex\nModel: gpt-5.5\nWorking (1s - esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "healthy-target-during-unrelated-churn",
      surface_id: "surface:agent",
      surface_uuid: targetUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const engine = testLifecycleEngine(server) as any;
    const originalResolveAgentIoRoute = engine.resolveAgentIoRoute.bind(engine);
    let resolveCount = 0;
    vi.spyOn(engine, "resolveAgentIoRoute").mockImplementation(
      async (agentId: string) => {
        const route = await originalResolveAgentIoRoute(agentId);
        resolveCount += 1;
        if (resolveCount === 1) {
          moveUuidRouteAfterNextSurfaceSnapshot(routeClient, [
            {
              ref: "surface:agent",
              id: targetUuid,
              workspace_ref: "workspace:1",
            },
            {
              ref: "surface:replacement",
              id: "99999999-8888-4777-8666-555555555555",
              workspace_ref: "workspace:1",
            },
          ]);
        }
        return route;
      },
    );
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "deliver despite foreign pane churn",
        press_enter: false,
      },
      {},
    );

    expect(result.isError).not.toBe(true);
    expect(routeClient.sendCalls).toEqual([
      {
        surface: "surface:agent",
        text: "deliver despite foreign pane churn",
      },
    ]);
  });

  it("raw send_to refuses an ambiguous numeric ref after it is recycled", async () => {
    const originalUuid = "11111111-2222-4333-8444-555555555555";
    const otherUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:230",
        id: originalUuid,
        workspace_ref: "workspace:1",
      },
      {
        ref: "surface:219",
        id: otherUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });
    await registeredTestTool(server, "list_surfaces").handler({}, {} as any);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:236",
        id: originalUuid,
        workspace_ref: "workspace:1",
      },
      {
        ref: "surface:230",
        id: otherUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:230",
        text: "follow the captured UUID",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(
      /ambiguous|recycled|multiple/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
  });

  it("raw send_to forwards a stale ref to a live managed agent and reports remap fields", async () => {
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:89",
        id: surfaceUuid,
        workspace_ref: "workspace:1",
        title: "skillcreatorClaude",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "skillcreatorClaude",
      surface_id: "surface:524",
      surface_uuid: surfaceUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "skill-creator",
      cli: "claude",
      task_summary: "live peer",
    });
    const server = await createUuidRouteServer(routeClient, record);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:524",
        text: "are you alive",
        press_enter: false,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      ok: true,
      surface: "surface:89",
      remapped_from: "surface:524",
      remapped_to: "surface:89",
    });
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:89", text: "are you alive" },
    ]);
  });

  it("read_screen forwards a stale ref to a live managed agent and reports remap fields", async () => {
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:89",
        id: surfaceUuid,
        workspace_ref: "workspace:1",
        title: "skillcreatorClaude",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "skillcreatorClaude",
      surface_id: "surface:524",
      surface_uuid: surfaceUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "skill-creator",
      cli: "claude",
    });
    const server = await createUuidRouteServer(routeClient, record);

    const result = await registeredTestTool(server, "read_screen").handler(
      { surface: "surface:524" },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      ok: true,
      surface: "surface:89",
      remapped_from: "surface:524",
      remapped_to: "surface:89",
    });
  });

  it.each(["read_screen", "update_surface", "close_surface"] as const)(
    "%s routes a live surface in another window without a workspace argument",
    async (toolName) => {
      const routeClient = makeCrossWindowUuidRouteClient([
        {
          ref: "surface:A",
          id: "11111111-2222-4333-8444-555555555555",
          workspace_ref: "workspace:A",
          window_ref: "window:A",
          title: "daemon-window-agent",
        },
        {
          ref: "surface:B",
          id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
          workspace_ref: "workspace:B",
          window_ref: "window:B",
          title: "caller-window-agent",
        },
      ]);
      const server = createTrackedServer({
        client: routeClient.client as any,
        stateDir: TEST_DIR,
        skipAgentLifecycle: true,
      });
      const args =
        toolName === "read_screen"
          ? { surface: "surface:B", parsed_only: true }
          : toolName === "update_surface"
            ? {
                action: "move",
                surface: "surface:B",
                pane: "pane:destination",
              }
            : { surface: "surface:B" };

      const result = await registeredTestTool(server, toolName).handler(
        args,
        {} as any,
      );

      expect(result.isError).not.toBe(true);
      expect(parseToolResult(result)).toMatchObject({ ok: true });
      expect(routeClient.client.listWorkspaces).toHaveBeenCalledWith({
        window: "window:B",
      });
      if (toolName === "update_surface") {
        expect(routeClient.client.moveSurface).toHaveBeenCalledWith(
          expect.objectContaining({
            surface: "surface:B",
          }),
        );
      }
      if (toolName === "close_surface") {
        expect(routeClient.client.closeSurface).toHaveBeenCalledWith(
          "surface:B",
          expect.objectContaining({ workspace: "workspace:B" }),
        );
      }
    },
  );

  it("agent-mode send_to routes a live agent in another window", async () => {
    const surfaceUuid = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const routeClient = makeCrossWindowUuidRouteClient([
      {
        ref: "surface:A",
        id: "11111111-2222-4333-8444-555555555555",
        workspace_ref: "workspace:A",
        window_ref: "window:A",
      },
      {
        ref: "surface:B",
        id: surfaceUuid,
        workspace_ref: "workspace:B",
        window_ref: "window:B",
        title: "crossWindowCodex",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "crossWindowCodex",
      surface_id: "surface:B",
      surface_uuid: surfaceUuid,
      workspace_id: "workspace:B",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;
    routeClient.client.listWindows.mockClear();
    routeClient.client.listWorkspaces.mockClear();

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "cross-window delivery",
        press_enter: false,
      },
      {} as any,
    );

    expect(parseToolResult(result).error).toBeUndefined();
    expect(result.isError).not.toBe(true);
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:B", text: "cross-window delivery" },
    ]);
    // D97 regression budget: one enumeration per stable phase -- initial
    // route proof, post-write evidence, and derived status publication --
    // instead of allowing the old route/read/guard multiplier to return.
    expect(
      routeClient.client.listWindows.mock.calls.length,
    ).toBeLessThanOrEqual(3);
    expect(
      routeClient.client.listWorkspaces.mock.calls.length,
    ).toBeLessThanOrEqual(6);
  });

  it("spawn_agent creates a worker in an explicit workspace in another window", async () => {
    const spawnedUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const initialSurfaces: UuidRouteSurface[] = [
      {
        ref: "surface:A",
        id: "11111111-2222-4333-8444-555555555555",
        workspace_ref: "workspace:A",
        window_ref: "window:A",
      },
      {
        ref: "surface:B",
        id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        workspace_ref: "workspace:B",
        window_ref: "window:B",
      },
    ];
    const routeClient = makeCrossWindowUuidRouteClient(initialSurfaces);
    routeClient.client.newSplit.mockImplementation(
      async (_direction: string, opts?: { workspace?: string }) => {
        routeClient.setLiveSurfaces([
          ...initialSurfaces,
          {
            ref: "surface:spawned",
            id: spawnedUuid,
            workspace_ref: opts?.workspace ?? "workspace:B",
            window_ref: "window:B",
            title: "cross-window spawn",
          },
        ]);
        return {
          workspace: opts?.workspace ?? "workspace:B",
          surface: "surface:spawned",
          surface_id: spawnedUuid,
          pane: "pane:spawned",
          title: "cross-window spawn",
          type: "terminal" as const,
        };
      },
    );
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      lifecycleInitializer: async () => {},
      sessionIdentityResolver: () => null,
    });

    const result = await registeredTestTool(server, "spawn_agent").handler(
      {
        repo: "cmuxlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "implementor",
        workspace: "workspace:B",
        force_new: true,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      workspace_id: "workspace:B",
      surface_id: "surface:spawned",
    });
    expect(routeClient.client.newSplit).toHaveBeenCalledWith(
      "right",
      expect.objectContaining({ workspace: "workspace:B" }),
    );
  });

  it("spawn_agent resolves an unscoped caller workspace in another window", async () => {
    const callerWorkspaceId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const spawnedUuid = "cccccccc-dddd-4eee-8fff-000000000000";
    const initialSurfaces: UuidRouteSurface[] = [
      {
        ref: "surface:A",
        id: "11111111-2222-4333-8444-555555555555",
        workspace_ref: "workspace:A",
        window_ref: "window:A",
      },
      {
        ref: "surface:B",
        id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        workspace_ref: "workspace:B",
        window_ref: "window:B",
      },
    ];
    const routeClient = makeCrossWindowUuidRouteClient(initialSurfaces);
    routeClient.client.newSplit.mockImplementation(
      async (_direction: string, opts?: { workspace?: string }) => {
        routeClient.setLiveSurfaces([
          ...initialSurfaces,
          {
            ref: "surface:spawned",
            id: spawnedUuid,
            workspace_ref: opts?.workspace ?? "workspace:A",
            window_ref:
              opts?.workspace === "workspace:B" ? "window:B" : "window:A",
          },
        ]);
        return {
          workspace: opts?.workspace ?? "workspace:A",
          surface: "surface:spawned",
          surface_id: spawnedUuid,
          pane: "pane:spawned",
          title: "caller workspace spawn",
          type: "terminal" as const,
        };
      },
    );
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      lifecycleInitializer: async () => {},
      sessionIdentityResolver: () => null,
    });

    const result = await runWithCallerContext(
      { workspaceId: callerWorkspaceId },
      () =>
        registeredTestTool(server, "spawn_agent").handler(
          {
            repo: "cmuxlayer",
            model: "gpt-5.5",
            cli: "codex",
            role: "implementor",
            force_new: true,
          },
          {} as any,
        ),
    );
    const parsed = parseToolResult(result);

    expect(result.isError).not.toBe(true);
    expect(parsed).toMatchObject({
      ok: true,
      workspace_id: "workspace:B",
      surface_id: "surface:spawned",
    });
    expect(routeClient.client.newSplit).toHaveBeenCalledWith(
      "right",
      expect.objectContaining({ workspace: "workspace:B" }),
    );
  });

  it("read_screen retries the same cross-window surface with its resolved workspace", async () => {
    const routeClient = makeCrossWindowUuidRouteClient([
      {
        ref: "surface:A",
        id: "11111111-2222-4333-8444-555555555555",
        workspace_ref: "workspace:A",
        window_ref: "window:A",
      },
      {
        ref: "surface:B",
        id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        workspace_ref: "workspace:B",
        window_ref: "window:B",
      },
    ]);
    routeClient.client.readScreen.mockImplementation(
      async (surface: string, opts?: { workspace?: string }) => {
        if (surface === "surface:B" && opts?.workspace !== "workspace:B") {
          throw new Error("Unable to resolve workspace for surface surface:B");
        }
        return {
          surface,
          text: "gpt-5.6-sol medium - 80% left\ncodex> ",
          lines: 20,
          scrollback_used: false,
        };
      },
    );
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });

    const result = await registeredTestTool(server, "read_screen").handler(
      { surface: "surface:B" },
      {} as any,
    );

    expect(result.isError).not.toBe(true);
    expect(routeClient.client.readScreen).toHaveBeenLastCalledWith(
      "surface:B",
      expect.objectContaining({ workspace: "workspace:B" }),
    );
  });

  it("uses the selected workspace from the caller's window when two windows are selected", async () => {
    const routeClient = makeCrossWindowUuidRouteClient([
      {
        ref: "surface:A",
        workspace_ref: "workspace:A",
        window_ref: "window:A",
      },
      {
        ref: "surface:B",
        workspace_ref: "workspace:B",
        window_ref: "window:B",
      },
    ]);
    routeClient.client.listWorkspaces.mockImplementation(
      async (opts?: { window?: string }) => ({
        workspaces: [
          {
            ref: opts?.window === "window:B" ? "workspace:B" : "workspace:A",
            id:
              opts?.window === "window:B"
                ? "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
                : "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            title: opts?.window ?? "window:A",
            index: 0,
            selected: true,
            pinned: false,
          },
        ],
      }),
    );
    routeClient.client.newSplit.mockResolvedValue({
      workspace: "workspace:A",
      surface: "surface:new",
      pane: "pane:new",
      title: "",
      type: "terminal" as const,
    });

    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      lifecycleInitializer: async () => {},
    });
    const result = await runWithCallerContext(
      { workspaceId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" },
      () =>
        registeredTestTool(server, "new_split").handler(
          { direction: "right", workspace: "workspace:A" },
          {} as any,
        ),
    );

    expect(result.isError).not.toBe(true);
    expect(routeClient.client.selectWorkspace).toHaveBeenCalledWith(
      "workspace:A",
    );
  });

  it("raw send_to on a stale ref with no mapped agent names that no live agent occupies it", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:89",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:524",
        text: "anyone there",
        press_enter: false,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/surface:524 is stale/i);
    expect(parsed.error).toMatch(/no live managed agent/i);
    expect(parsed.error).not.toMatch(
      /Fresh topology did not provide a stable surface UUID/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
  });

  it("raw send_to on a stale ref does not name an unrelated live agent", async () => {
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:89",
        id: surfaceUuid,
        workspace_ref: "workspace:1",
        title: "skillcreatorClaude",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "skillcreatorClaude",
      surface_id: "surface:89",
      surface_uuid: surfaceUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "skill-creator",
      cli: "claude",
    });
    const server = await createUuidRouteServer(routeClient, record);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:524",
        text: "are you dead",
        press_enter: false,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(
      /surface:524 is stale; no live managed agent maps this ref/i,
    );
    expect(parsed.error).not.toMatch(/skillcreatorClaude/i);
    expect(parsed.error).not.toMatch(
      /Fresh topology did not provide a stable surface UUID/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
  });

  it("raw send_to to an exact live ref is unchanged and has no remap fields", async () => {
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:89",
        id: surfaceUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:89",
        text: "exact ref",
        press_enter: false,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.surface).toBe("surface:89");
    expect(parsed).not.toHaveProperty("remapped_from");
    expect(parsed).not.toHaveProperty("remapped_to");
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:89", text: "exact ref" },
    ]);
  });

  it("raw send_to does not name an unrelated agent when a captured UUID is no longer live", async () => {
    const deadUuid = "11111111-2222-4333-8444-555555555555";
    const liveUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:524",
        id: deadUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "skillcreatorClaude",
      surface_id: "surface:89",
      surface_uuid: liveUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "skill-creator",
      cli: "claude",
    });
    const server = await createUuidRouteServer(routeClient, record);
    await registeredTestTool(server, "list_surfaces").handler({}, {} as any);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:89",
        id: liveUuid,
        workspace_ref: "workspace:1",
        title: "skillcreatorClaude",
      },
    ]);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:524",
        text: "are you dead",
        press_enter: false,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(
      /surface:524 is stale; no live managed agent maps this ref/i,
    );
    expect(parsed.error).not.toMatch(/skillcreatorClaude/i);
    expect(parsed.error).not.toMatch(
      /^Stable surface UUID .* is no longer live; refusing/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
  });

  it("raw send_to names only the managed agent that owns a stale ref", async () => {
    const deadUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:other",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:1",
      },
    ]);
    const owner = makeServerAgentRecord({
      agent_id: "staleRefOwner",
      surface_id: "surface:524",
      surface_uuid: deadUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, owner);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:524",
        text: "owner diagnostic",
        press_enter: false,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(
      /surface:524 is stale; agent staleRefOwner owns this ref but no live route was proven — use agent_id/i,
    );
    expect(parsed.error).not.toMatch(/surface:other/i);
    expect(routeClient.sendCalls).toEqual([]);
  });

  it("raw send_to says no live agent when a captured UUID is gone and none remain", async () => {
    const deadUuid = "11111111-2222-4333-8444-555555555555";
    const otherUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:524",
        id: deadUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });
    await registeredTestTool(server, "list_surfaces").handler({}, {} as any);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:other",
        id: otherUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:524",
        text: "anyone there",
        press_enter: false,
      },
      {} as any,
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toMatch(/surface:524 is stale/i);
    expect(parsed.error).toMatch(/no live managed agent/i);
    expect(parsed.error).not.toMatch(
      /^Stable surface UUID .* is no longer live; refusing/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
  });

  it("read_screen catch-path forward keeps Codex rollout enrichment", async () => {
    const surfaceUuid = "11111111-2222-4333-8444-555555555555";
    const path = "/fixtures/codex/catch-path-forward.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:89",
        id: surfaceUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-catch-path-forward",
      surface_id: "surface:524",
      surface_uuid: surfaceUuid,
      workspace_id: "workspace:1",
      state: "ready",
      cli: "codex",
      cli_session_id: "session-catch",
      cli_session_path: path,
    });
    const get = vi.fn().mockResolvedValue({
      token_count: 100_000,
      context_window: 400_000,
      context_pct: 25,
      observed_model_context_window: 258_400,
    });
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });
    const originalRead = routeClient.client.readScreen.getMockImplementation();
    routeClient.client.readScreen.mockImplementation(
      async (surface: string, opts?: { lines?: number }) => {
        if (surface === "surface:524") {
          throw new Error("surface:524 is gone");
        }
        if (!originalRead) {
          throw new Error("missing readScreen implementation");
        }
        return originalRead(surface, opts);
      },
    );

    const result = await registeredTestTool(server, "read_screen").handler(
      { surface: "surface:524", parsed_only: true },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed).toMatchObject({
      ok: true,
      surface: "surface:89",
      remapped_from: "surface:524",
      remapped_to: "surface:89",
    });
    expect(get).toHaveBeenCalledWith(path);
    expect(parsed.parsed).toMatchObject({
      agent_type: "codex",
      token_count: 100_000,
      context_window: 400_000,
      context_pct: 25,
    });
  });

  it("raw send_to follows the captured UUID when the old ref is vacated", async () => {
    const originalUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:230",
        id: originalUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });
    await registeredTestTool(server, "list_surfaces").handler({}, {} as any);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:236",
        id: originalUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:230",
        text: "follow the captured UUID",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:236", text: "follow the captured UUID" },
    ]);
  });

  it("raw send_to refuses to follow a UUID outside the caller's explicit workspace", async () => {
    const originalUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:230",
        id: originalUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });
    await registeredTestTool(server, "list_surfaces").handler({}, {} as any);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:236",
        id: originalUuid,
        workspace_ref: "workspace:2",
      },
    ]);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:230",
        workspace: "workspace:1",
        text: "must stay workspace-scoped",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(
      /explicit workspace|workspace:1/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
  });

  it("background ref-only delivery attributes failure to its start observer", async () => {
    vi.useFakeTimers();
    try {
      const routeClient = makeUuidRouteClient([
        {
          ref: "surface:230",
          workspace_ref: "workspace:1",
        },
      ]);
      const tracker = new SurfaceWriteLivenessTracker({ now: () => 1_000 });
      let observerOwner = "cmux:/tmp/observer-old.sock";
      routeClient.client.send.mockImplementation(async () => {
        observerOwner = "cmux:/tmp/observer-new.sock";
        throw Object.assign(new Error("broken pipe"), { code: "EPIPE" });
      });
      const server = createTrackedServer({
        client: routeClient.client as any,
        stateDir: TEST_DIR,
        skipAgentLifecycle: true,
        surfaceWriteLiveness: tracker,
        surfaceObserverOwnerIdProvider: () => observerOwner,
        surfaceObserverEpochProvider: () => "stable-test-epoch",
      });

      const accepted = await registeredTestTool(server, "send_input").handler(
        {
          surface: "surface:230",
          text: "fail after observer capture",
          background: true,
          press_enter: false,
        },
        {} as any,
      );
      expect(parseToolResult(accepted)).toMatchObject({ status: "delivering" });

      await vi.advanceTimersByTimeAsync(1);

      expect(
        tracker.observe("surface:230", null, "cmux:/tmp/observer-old.sock"),
      ).toMatchObject({ consecutive_broken_pipe_failures: 1 });
      expect(
        tracker.observe("surface:230", null, "cmux:/tmp/observer-new.sock"),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("raw send_to refuses an absent ref in complete ref-only topology", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:other",
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:missing",
        text: "must not reach a later occupant",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(
      /surface:missing is stale; no live managed agent/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
  });

  it("list_surfaces discards UUID captures when the observer changes mid-list", async () => {
    const staleUuid = "11111111-2222-4333-8444-555555555555";
    const currentUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:230",
        id: staleUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    let observerEpoch = "test:1";
    const listPaneSurfaces =
      routeClient.client.listPaneSurfaces.getMockImplementation()!;
    routeClient.client.listPaneSurfaces.mockImplementationOnce(async (opts) => {
      const snapshot = await listPaneSurfaces(opts);
      observerEpoch = "test:2";
      return snapshot;
    });
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
      surfaceObserverEpochProvider: () => observerEpoch,
    });

    const listed = await registeredTestTool(server, "list_surfaces").handler(
      {},
      {} as any,
    );
    expect(parseToolResult(listed)).toMatchObject({
      surfaces: [
        expect.objectContaining({ ref: "surface:230", id: staleUuid }),
      ],
    });
    routeClient.setLiveSurfaces([
      {
        ref: "surface:230",
        id: currentUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:230",
        text: "current observer only",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:230", text: "current observer only" },
    ]);
  });

  it.each(["move_surface", "rename_tab"])(
    "%s refuses a recycled raw ref",
    async (toolName) => {
      const originalUuid = "11111111-2222-4333-8444-555555555555";
      const replacementUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const routeClient = makeUuidRouteClient([
        {
          ref: "surface:230",
          id: originalUuid,
          workspace_ref: "workspace:1",
        },
      ]);
      const server = createTrackedServer({
        client: routeClient.client as any,
        stateDir: TEST_DIR,
        lifecycleInitializer: async () => {},
      });
      await registeredTestTool(server, "list_surfaces").handler({}, {} as any);
      routeClient.setLiveSurfaces([
        {
          ref: "surface:236",
          id: originalUuid,
          workspace_ref: "workspace:1",
        },
        {
          ref: "surface:230",
          id: replacementUuid,
          workspace_ref: "workspace:1",
        },
      ]);

      const args =
        toolName === "move_surface"
          ? { surface: "surface:230", pane: "pane:destination" }
          : { surface: "surface:230", title: "must not rename replacement" };
      const result = await registeredTestTool(server, toolName).handler(
        args,
        {} as any,
      );

      expect(result.isError).toBe(true);
      expect(parseToolResult(result).error).toMatch(
        /ambiguous|recycled|multiple/i,
      );
      expect(routeClient.client.moveSurface).not.toHaveBeenCalled();
      expect(routeClient.client.renameTab).not.toHaveBeenCalled();
    },
  );

  it("raw send_to refuses when the UUID captured for a numeric ref is gone", async () => {
    const originalUuid = "11111111-2222-4333-8444-555555555555";
    const replacementUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:230",
        id: originalUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });
    await registeredTestTool(server, "list_surfaces").handler({}, {} as any);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:230",
        id: replacementUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:230",
        text: "must not reach the replacement",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/stable surface UUID|stale/i);
    expect(routeClient.sendCalls).toEqual([]);
    expect(routeClient.client.send).not.toHaveBeenCalled();
  });

  it("raw send_to pastes multiline text through the captured stable UUID", async () => {
    const originalUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:230",
        id: originalUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      lifecycleInitializer: async () => {},
    });
    await registeredTestTool(server, "list_surfaces").handler({}, {} as any);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:236",
        id: originalUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.client.pasteText.mockClear();
    routeClient.pasteCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        mode: "surface",
        target: "surface:230",
        text: "first line\nsecond line",
        press_enter: false,
        allow_long_inline: true,
      },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(routeClient.pasteCalls).toEqual([
      { surface: "surface:236", text: "first line\nsecond line" },
    ]);
  });

  it.each([undefined, "workspace:1"])(
    "close_surface uses the same stable binding with workspace=%s",
    async (workspace) => {
      const routeClient = makeUuidRouteClient([
        {
          ref: "surface:230",
          id: "11111111-2222-4333-8444-555555555555",
          workspace_ref: "workspace:1",
        },
      ]);
      routeClient.client.closeSurface.mockImplementation(
        async (_surface: string, opts?: { workspace?: string }) => {
          if (!opts?.workspace) {
            throw new Error("Workspace not found");
          }
        },
      );
      const server = createTrackedServer({
        client: routeClient.client as any,
        stateDir: TEST_DIR,
        skipAgentLifecycle: true,
      });
      await registeredTestTool(server, "list_surfaces").handler({}, {} as any);

      const result = await registeredTestTool(server, "close_surface").handler(
        { surface: "surface:230", ...(workspace ? { workspace } : {}) },
        {} as any,
      );

      expect(result.isError).toBeFalsy();
      expect(routeClient.client.closeSurface).toHaveBeenCalledWith(
        "surface:230",
        expect.objectContaining({ workspace: "workspace:1" }),
      );
    },
  );

  it("records managed send failures against the stable UUID instead of its mutable ref", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const otherUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const surfaceRef = "surface:shared-liveness-ref";
    const routeClient = makeUuidRouteClient([
      {
        ref: surfaceRef,
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const tracker = new SurfaceWriteLivenessTracker({ now: () => 1_000 });
    const record = makeServerAgentRecord({
      agent_id: "uuid-write-liveness-agent",
      surface_id: surfaceRef,
      surface_uuid: stableUuid,
      surface_observer_id: "cmux:/tmp/current.sock",
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const stateMgr = new StateManager(TEST_DIR);
    stateMgr.writeState(record);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
      surfaceWriteLiveness: tracker,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    routeClient.client.send.mockRejectedValue(
      Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
    );

    for (const text of ["first failed write", "second failed write"]) {
      const result = await registeredTestTool(server, "send_to").handler(
        {
          agent_id: record.agent_id,
          text,
          press_enter: false,
        },
        {},
      );
      expect(result.isError).toBe(true);
    }

    expect(tracker.observe(surfaceRef, stableUuid)?.pty_dead).toBe(true);
    expect(tracker.observe(surfaceRef, otherUuid)).toBeNull();
  });

  it("send_to fails closed before Return when the stable UUID moves after a chunk", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:delivery-old",
        id: stableUuid,
        workspace_ref: "workspace:old",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "uuid-delivery-return-race",
      surface_id: "surface:delivery-old",
      surface_uuid: stableUuid,
      workspace_id: "workspace:old",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const originalSend = routeClient.client.send.getMockImplementation();
    routeClient.client.send.mockImplementationOnce(
      async (surface: string, text: string, opts?: unknown) => {
        await originalSend?.(surface, text, opts);
        routeClient.setLiveSurfaces([
          {
            ref: "surface:delivery-old",
            id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            workspace_ref: "workspace:old",
          },
          {
            ref: "surface:delivery-new",
            id: stableUuid,
            workspace_ref: "workspace:new",
          },
        ]);
      },
    );
    routeClient.client.sendKey.mockClear();

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "one guarded chunk",
        press_enter: true,
        allow_busy: true,
      },
      {},
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(
      /surface route changed.*terminal delivery/i,
    );
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:delivery-old", text: "one guarded chunk" },
    ]);
    expect(routeClient.client.sendKey).not.toHaveBeenCalled();
  });

  it("send_to refuses a recycled ref when the stored UUID is absent", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:7",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const stateMgr = new StateManager(TEST_DIR);
    const record = makeServerAgentRecord({
      agent_id: "missing-uuid-agent",
      surface_id: "surface:7",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    stateMgr.writeState(record);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;
    routeClient.setLiveSurfaces([
      {
        ref: "surface:7",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:1",
      },
    ]);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "must not reach recycled ref",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(
      /stable surface UUID.*not live/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
    expect(routeClient.client.send).not.toHaveBeenCalled();
  });

  it("send_to refuses a stale UUID route when fresh topology exposes refs only", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:7",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const stateMgr = new StateManager(TEST_DIR);
    const record = makeServerAgentRecord({
      agent_id: "ref-only-stale-uuid-agent",
      surface_id: "surface:7",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    stateMgr.writeState(record);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;
    routeClient.setLiveSurfaces([
      {
        ref: "surface:8",
        workspace_ref: "workspace:1",
      },
    ]);

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "must not reach a stale mutable ref",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(
      /stale|no longer maps|not live/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
    expect(routeClient.client.send).not.toHaveBeenCalled();
  });

  it("send_to refuses a recycled UUID route when fresh topology exposes refs only", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:7",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const stateMgr = new StateManager(TEST_DIR);
    const record = makeServerAgentRecord({
      agent_id: "ref-only-recycled-uuid-agent",
      surface_id: "surface:7",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    stateMgr.writeState(record);
    const server = createTrackedServer({
      client: routeClient.client as any,
      stateDir: TEST_DIR,
      disableSpawnPreflight: true,
      sessionIdentityResolver: () => null,
    });
    await serverContexts.at(-1)?.lifecycleStartPromise;
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;
    routeClient.setLiveSurfaces([
      {
        ref: "surface:7",
        workspace_ref: "workspace:1",
      },
    ]);
    routeClient.setScreenText("Claude Code\nWhat can I help you with?\n> ");

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "must not reach a recycled occupant",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(
      /recycled|no longer occupies|identity/i,
    );
    expect(routeClient.sendCalls).toEqual([]);
    expect(routeClient.client.send).not.toHaveBeenCalled();
  });

  it("send_to freshly validates a UUID-less route after stale-ref resync", async () => {
    const replacementUuid = "11111111-2222-4333-8444-555555555555";
    const observerId = "cmux:/tmp/current.sock";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:old",
        workspace_ref: "workspace:old",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "legacy-resync-route-agent",
      surface_id: "surface:old",
      surface_uuid: null,
      surface_observer_id: observerId,
      workspace_id: "workspace:old",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
      launcher_name: "cmuxlayerCodex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const { engine, registry } = enforceTestObserverOwnership(
      server,
      observerId,
    );
    const originalResolveAgentIoRoute = engine.resolveAgentIoRoute.bind(engine);
    let resolveCount = 0;
    const resolveAgentIoRoute = vi
      .spyOn(engine, "resolveAgentIoRoute")
      .mockImplementation(async (agentId: string) => {
        const route = await originalResolveAgentIoRoute(agentId);
        resolveCount += 1;
        if (resolveCount === 1) {
          routeClient.setLiveSurfaces([
            {
              ref: "surface:new",
              workspace_ref: "workspace:new",
            },
          ]);
        }
        return route;
      });
    vi.spyOn(registry, "listMerged").mockImplementation(async () => {
      const repaired = engine.stateMgr.updateRecord(record.agent_id, {
        surface_id: "surface:new",
        workspace_id: "workspace:new",
      });
      registry.set(record.agent_id, repaired);
      routeClient.setLiveSurfaces([
        {
          ref: "surface:new",
          id: replacementUuid,
          workspace_ref: "workspace:new",
        },
      ]);
      return [];
    });
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "must revalidate the repaired route",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(parseToolResult(result).error).toMatch(/stale surface ref/i);
    expect(resolveAgentIoRoute).toHaveBeenCalledTimes(2);
    expect(routeClient.sendCalls).toEqual([]);
    expect(routeClient.client.send).not.toHaveBeenCalled();
  });

  it("send_to delivers to a busy agent immediately and records queued_behind_turn", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const working = engine.stateMgr.updateRecord(agentId, { state: "working" });
    registry.set(agentId, working);
    mockExec.mockClear();

    const result = await sendTo.handler(
      { agent_id: agentId, text: "hello", press_enter: true },
      {} as any,
    );
    const delivered = parseToolResult(result);
    expect(result.isError).toBeFalsy();
    expect(delivered).toMatchObject({
      ok: true,
      agent_id: agentId,
      delivery_id: expect.any(String),
      delivery: "submitted",
      delivery_state: "submitted",
      terminal: true,
      submit_verified: true,
      queued_behind_turn: true,
    });
    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("send")),
    ).not.toHaveLength(0);
    expect(engine.getDeliveryReceipt(delivered.delivery_id)).toMatchObject({
      delivery_id: delivered.delivery_id,
      delivery_state: "submitted",
      terminal: true,
    });
  });

  it("send_to_agent with allow_busy=true delivers to agents in working state", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to_agent"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    registry.set(agentId, { ...agent, state: "working" });
    mockExec.mockClear();

    const result = await sendTo.handler(
      {
        agent_id: agentId,
        text: "force deliver",
        press_enter: true,
        allow_busy: true,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
  });

  it("send_to reserves an idle agent as working before health evidence", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const idle = engine.stateMgr.resetState(
      agentId,
      "idle",
      {},
      "test delivery precondition",
    );
    registry.set(agentId, idle);

    const result = await sendTo.handler(
      { agent_id: agentId, text: "begin work", press_enter: true },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.registry_state).toBe("working");
    expect(parsed.screen).toMatchObject({
      agent_type: "claude",
      status: "working",
    });
    expect(parsed.state_conflict).toBe(false);
    expect(parsed.health.issue_codes).not.toContain(
      "registry_screen_disagreement",
    );
  });

  it("re-tasking a done worker through send_to still escalates a later approval halt", async () => {
    const retaskAt = Date.parse("2026-08-13T14:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(retaskAt);
    try {
      const server = createTrackedServer({
        exec: mockExec,
        stateDir: TEST_DIR,
        inboxBaseDir: TEST_DIR,
        disableSpawnPreflight: true,
        sessionIdentityResolver: () => null,
      });
      const spawn = (server as any)._registeredTools["spawn_agent"];
      const sendTo = (server as any)._registeredTools["send_to"];
      const spawnResult = await spawn.handler(
        {
          repo: "cmuxlayer",
          model: "gpt-5.6-sol",
          cli: "codex",
        },
        {} as any,
      );
      const agentId = (
        spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
      ).agent_id;
      const engine = (server as any)._registeredTools["interact"]._engine;
      const registry = engine.getRegistry();
      const spawned = engine.getAgentState(agentId) as AgentRecord;
      const parent = makeServerAgentRecord({
        agent_id: "retask-parent",
        surface_id: spawned.surface_id,
        workspace_id: spawned.workspace_id,
        state: "working",
        role: "orchestrator",
      });
      engine.stateMgr.writeState(parent);
      registry.set(parent.agent_id, parent);
      const idle = engine.stateMgr.resetState(
        agentId,
        "idle",
        {},
        "task one completed",
      );
      const completedTaskOne = engine.stateMgr.updateRecord(agentId, {
        parent_agent_id: parent.agent_id,
        spawn_depth: 1,
        task_done_detected_at: new Date(retaskAt - 7_200_000).toISOString(),
        halt_last_active_at: null,
      });
      registry.set(agentId, { ...idle, ...completedTaskOne });

      const sendResult = await sendTo.handler(
        { agent_id: agentId, text: "Begin task two", press_enter: true },
        {} as any,
      );
      expect(sendResult.isError).toBeFalsy();
      expect(engine.getAgentState(agentId)).toMatchObject({
        state: "working",
        halt_last_active_at: new Date(retaskAt).toISOString(),
      });
      vi.spyOn(engine as any, "readAgentScreen").mockResolvedValue({
        surface: parent.surface_id,
        text: "Claude Code\nProcessed child report\nWorking (2s • esc to interrupt)",
        lines: 80,
        scrollback_used: false,
      });

      const approvalScreen =
        "OpenAI Codex\nDo you want to allow this command?\n[y/n]";
      nowSpy.mockReturnValue(retaskAt + 1);
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(agentId) as AgentRecord,
        approvalScreen,
      );
      expect(engine.getAgentState(agentId)).toMatchObject({
        halt_episode_type: "awaiting_input",
        halt_notification_sent_at: null,
      });
      nowSpy.mockReturnValue(retaskAt + 120_002);
      await (engine as any).maybeEscalateLiveHalt(
        engine.getAgentState(agentId) as AgentRecord,
        approvalScreen,
      );

      expect(
        readInbox(parent.agent_id, { baseDir: TEST_DIR }).filter(
          (message) => message.tag === "agent_halt_awaiting_input",
        ),
      ).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("send_to omits post-delivery evidence when the stable UUID disappears", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:old",
        id: stableUuid,
        workspace_ref: "workspace:old",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "uuid-delivery-evidence-missing",
      surface_id: "surface:old",
      surface_uuid: stableUuid,
      workspace_id: "workspace:old",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const originalSend = routeClient.client.send.getMockImplementation();
    routeClient.client.send.mockImplementation(
      async (surface: string, text: string) => {
        await originalSend?.(surface, text);
        routeClient.setLiveSurfaces([
          {
            ref: "surface:old",
            id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            workspace_ref: "workspace:old",
          },
        ]);
        routeClient.setScreenText(
          "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)",
        );
      },
    );

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "deliver before UUID disappears",
        press_enter: false,
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.registry_state).toBe("ready");
    expect(parsed.screen).toBeNull();
    expect(parsed.state_conflict).toBe(false);
    expect(
      (parsed.health as Record<string, unknown>).reconciled_state,
    ).toBeUndefined();
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).not.toContain("registry_screen_disagreement");
  });

  it("send_to preserves an honest typed-only receipt when post-delivery evidence throws", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:evidence-error",
        id: "11111111-2222-4333-8444-555555555555",
        workspace_ref: "workspace:evidence-error",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "receipt-survives-evidence-error",
      surface_id: "surface:evidence-error",
      surface_uuid: "11111111-2222-4333-8444-555555555555",
      workspace_id: "workspace:evidence-error",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const engine = registeredTestTool(server, "interact")._engine;
    const originalSend = routeClient.client.send.getMockImplementation();
    routeClient.client.send.mockImplementation(
      async (surface: string, text: string) => {
        await originalSend?.(surface, text);
        vi.spyOn(engine, "getAgentState").mockImplementation(() => {
          throw new Error("post-delivery topology unavailable");
        });
      },
    );

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "delivered before evidence failed",
        press_enter: false,
      },
      {},
    );

    expect(result.isError).toBe(true);
    const receipt = parseToolResult(result);
    expect(receipt).toMatchObject({
      delivery_id: expect.any(String),
      delivered: false,
      terminal: true,
      typed: true,
      submit_attempted: false,
      submit_verified: null,
      error: expect.stringContaining("post-delivery topology unavailable"),
    });
    expect(receipt.delivery).toBe("typed");
    expect(receipt.delivery_state).toBe("typed");
  });

  it("send_to omits evidence when a UUID-less row becomes foreign after delivery", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:shared",
        workspace_ref: "workspace:current",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "foreign-observer-delivery-evidence",
      surface_id: "surface:shared",
      surface_uuid: null,
      surface_observer_id: "cmux:/tmp/current.sock",
      workspace_id: "workspace:current",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const { engine, registry } = enforceTestObserverOwnership(
      server,
      "cmux:/tmp/current.sock",
    );
    const originalSend = routeClient.client.send.getMockImplementation();
    routeClient.client.send.mockImplementation(
      async (surface: string, text: string) => {
        await originalSend?.(surface, text);
        const foreign = engine.stateMgr.updateRecord(record.agent_id, {
          surface_observer_id: "cmux:/tmp/foreign.sock",
        });
        registry.set(record.agent_id, foreign);
        routeClient.setScreenText(
          "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)",
        );
      },
    );

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "deliver before ownership changes",
        press_enter: false,
      },
      {},
    );
    const parsed = parseToolResult(result);

    expect(result.isError).toBeFalsy();
    expect(parsed.registry_state).toBe("ready");
    expect(parsed.screen).toBeNull();
    expect(parsed.state_conflict).toBe(false);
    expect(
      (parsed.health as Record<string, unknown>).reconciled_state,
    ).toBeUndefined();
  });

  it("interact interrupt sends the key in the agent workspace", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const interact = (server as any)._registeredTools["interact"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    mockExec.mockClear();

    const result = await interact.handler(
      { agent: agentId, action: "interrupt" },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const sendKeyCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("send-key"),
    );

    expect(parsed.ok).toBe(true);
    expect(sendKeyCalls).toHaveLength(1);
    expect(sendKeyCalls[0][1]).toEqual(
      expect.arrayContaining([
        "send-key",
        "--surface",
        "surface:new",
        "--workspace",
        "workspace:1",
        "ctrl-c",
      ]),
    );
  });

  it("UUID I/O: interact interrupt follows a stable UUID after its surface ref moves", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:7",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "uuid-interrupt-agent",
      surface_id: "surface:7",
      surface_uuid: stableUuid,
      workspace_id: "workspace:1",
      state: "ready",
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    routeClient.client.sendKey.mockClear();
    moveUuidRouteAfterNextSurfaceSnapshot(routeClient, [
      {
        ref: "surface:7",
        id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        workspace_ref: "workspace:1",
      },
      {
        ref: "surface:8",
        id: stableUuid,
        workspace_ref: "workspace:1",
      },
    ]);

    const result = await registeredTestTool(server, "interact").handler(
      { agent: record.agent_id, action: "interrupt" },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(routeClient.client.sendKey).toHaveBeenCalledWith(
      "surface:8",
      "c-c",
      { workspace: "workspace:1" },
    );
    expect(routeClient.client.sendKey).not.toHaveBeenCalledWith(
      "surface:7",
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    ["usage", 5],
    ["mcp", 10],
  ] as const)(
    "UUID I/O: interact %s reads the stable UUID route after its surface ref moves",
    async (action, lines) => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const routeClient = makeUuidRouteClient([
        {
          ref: "surface:7",
          id: stableUuid,
          workspace_ref: "workspace:1",
        },
      ]);
      const record = makeServerAgentRecord({
        agent_id: `uuid-${action}-agent`,
        surface_id: "surface:7",
        surface_uuid: stableUuid,
        workspace_id: "workspace:1",
        state: "ready",
        repo: "cmuxlayer",
        cli: "codex",
      });
      const server = await createUuidRouteServer(routeClient, record);
      routeClient.client.readScreen.mockClear();
      moveUuidRouteAfterNextSurfaceSnapshot(routeClient, [
        {
          ref: "surface:7",
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          workspace_ref: "workspace:1",
        },
        {
          ref: "surface:8",
          id: stableUuid,
          workspace_ref: "workspace:1",
        },
      ]);

      const result = await registeredTestTool(server, "interact").handler(
        { agent: record.agent_id, action },
        {} as any,
      );

      expect(result.isError).toBeFalsy();
      expect(parseToolResult(result)).toMatchObject({
        agent_id: record.agent_id,
        action,
        surface_id: "surface:8",
      });
      expect(routeClient.client.readScreen).toHaveBeenCalledWith(
        "surface:8",
        expect.objectContaining({ lines }),
      );
    },
  );

  it.each(["stop_agent", "kill"] as const)(
    "UUID I/O: %s checks manual mode on the freshly resolved route",
    async (toolName) => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const routeClient = makeUuidRouteClient([
        {
          ref: "surface:7",
          id: stableUuid,
          workspace_ref: "workspace:old",
        },
      ]);
      routeClient.client.listStatus.mockImplementation(
        async (opts?: { workspace?: string }) =>
          opts?.workspace === "workspace:old"
            ? [{ key: "mode.control", value: "manual" }]
            : [],
      );
      const record = makeServerAgentRecord({
        agent_id: `uuid-${toolName}-agent`,
        surface_id: "surface:7",
        surface_uuid: stableUuid,
        workspace_id: "workspace:old",
        state: "working",
        repo: "cmuxlayer",
        cli: "codex",
      });
      const server = await createUuidRouteServer(routeClient, record);
      bypassEngineSurfaceWriteWrappers(server, routeClient);
      routeClient.client.listStatus.mockClear();
      routeClient.client.sendKey.mockClear();
      routeClient.client.closeSurface.mockClear();
      routeClient.setLiveSurfaces([
        {
          ref: "surface:7",
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          workspace_ref: "workspace:old",
        },
        {
          ref: "surface:8",
          id: stableUuid,
          workspace_ref: "workspace:new",
        },
      ]);

      const args =
        toolName === "stop_agent"
          ? { agent_id: record.agent_id, force: false }
          : { target: record.agent_id, force: false };
      const result = await registeredTestTool(server, toolName).handler(
        args,
        {} as any,
      );

      expect(result.isError).toBeFalsy();
      expect(routeClient.client.listStatus).toHaveBeenCalledWith({
        workspace: "workspace:new",
      });
      expect(routeClient.client.listStatus).not.toHaveBeenCalledWith({
        workspace: "workspace:old",
      });
      expect(routeClient.client.sendKey).toHaveBeenCalledWith(
        "surface:8",
        "c-c",
        expect.objectContaining({
          workspace: "workspace:new",
          beforeMutation: expect.any(Function),
        }),
      );
      expect(routeClient.client.closeSurface).toHaveBeenCalledWith(
        "surface:8",
        expect.objectContaining({ workspace: "workspace:new" }),
      );
    },
  );

  it.each([
    ["stop_agent", false],
    ["kill", false],
    ["stop_agent", true],
    ["kill", true],
  ] as const)(
    "%s force=%s refuses manual mode on a freshly moved UUID route before mutation",
    async (toolName, force) => {
      const stableUuid = "11111111-2222-4333-8444-555555555555";
      const routeClient = makeUuidRouteClient([
        {
          ref: "surface:7",
          id: stableUuid,
          workspace_ref: "workspace:old",
        },
      ]);
      routeClient.client.listStatus.mockImplementation(
        async (opts?: { workspace?: string }) =>
          opts?.workspace === "workspace:new"
            ? [{ key: "mode.control", value: "manual" }]
            : [],
      );
      const record = makeServerAgentRecord({
        agent_id: `manual-${toolName}-moved-agent`,
        surface_id: "surface:7",
        surface_uuid: stableUuid,
        workspace_id: "workspace:old",
        state: "working",
        repo: "cmuxlayer",
        cli: "codex",
      });
      const server = await createUuidRouteServer(routeClient, record);
      bypassEngineSurfaceWriteWrappers(server, routeClient);
      routeClient.client.listStatus.mockClear();
      routeClient.client.sendKey.mockClear();
      routeClient.client.closeSurface.mockClear();
      routeClient.setLiveSurfaces([
        {
          ref: "surface:7",
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          workspace_ref: "workspace:old",
        },
        {
          ref: "surface:8",
          id: stableUuid,
          workspace_ref: "workspace:new",
        },
      ]);

      const args =
        toolName === "stop_agent"
          ? { agent_id: record.agent_id, force }
          : { target: record.agent_id, force };
      const result = await registeredTestTool(server, toolName).handler(
        args,
        {} as any,
      );
      const parsed = parseToolResult(result);

      expect(result.isError).toBe(true);
      expect(parsed.error).toMatch(/surface:8.*workspace:new.*manual mode/i);
      expect(routeClient.client.listStatus).toHaveBeenCalledWith({
        workspace: "workspace:new",
      });
      expect(routeClient.client.listStatus).not.toHaveBeenCalledWith({
        workspace: "workspace:old",
      });
      expect(routeClient.client.sendKey).not.toHaveBeenCalled();
      expect(routeClient.client.closeSurface).not.toHaveBeenCalled();
    },
  );

  it("send_to sanitizes and chunks delivery through the agent surface", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    registry.set(agentId, { ...agent, state: "ready" });
    mockExec.mockClear();

    const rawText = `${"a".repeat(510)}\x1b[31mHELLO\x1b[0m\x07${"b".repeat(10)}`;
    const sanitizedText = `${"a".repeat(510)}HELLO${"b".repeat(10)}`;

    const result = await sendTo.handler(
      { agent_id: agentId, text: rawText, press_enter: true },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    const setBufferCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("set-buffer"),
    );
    const pasteBufferCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("paste-buffer"),
    );
    const sendKeyCalls = mockExec.mock.calls.filter(
      ([, args]) => Array.isArray(args) && args.includes("send-key"),
    );
    const deliveredText = setBufferCalls
      .map(([, args]) => args.at(-1))
      .join("");

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(setBufferCalls).toHaveLength(1);
    expect(pasteBufferCalls).toHaveLength(1);
    expect(sendKeyCalls).toHaveLength(1);
    expect(deliveredText).toBe(sanitizedText);
    expect(deliveredText).not.toContain("\x1b");
    expect(deliveredText).not.toContain("\x07");
  });

  it("send_to reports rescued when a new interrupt follows a scrolled-off stale marker", async () => {
    const message = "Reply with the single word OK";
    const baseExec = makeLifecycleExec();
    let relayActive = false;
    let relayTyped = false;
    let relayReturned = false;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (
        relayActive &&
        (args.includes("send") || args.includes("set-buffer")) &&
        text.includes(message)
      ) {
        relayTyped = true;
        return { stdout: "{}", stderr: "" };
      }
      if (relayActive && args.includes("send-key") && args.includes("return")) {
        relayReturned = true;
        return { stdout: "{}", stderr: "" };
      }
      if (relayActive && args.includes("read-screen")) {
        const screen = !relayTyped
          ? [
              ">_ OpenAI Codex",
              "Conversation interrupted",
              "›",
              "gpt-5.6-sol medium · ~/Gits/brainlayer",
            ].join("\n")
          : !relayReturned
            ? [
                ">_ OpenAI Codex",
                `» ${message}`,
                "gpt-5.6-sol medium · ~/Gits/brainlayer",
              ].join("\n")
            : [
                ">_ OpenAI Codex",
                "■ Conversation interrupted - tell the model what to do differently",
                `• ${message}`,
                "Working (1s • esc to interrupt)",
                "gpt-5.6-sol medium · ~/Gits/brainlayer",
              ].join("\n");
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: screen,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];
    const spawned = parseToolResult(
      await spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "initial work",
        },
        {} as any,
      ),
    );
    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const ready = engine.stateMgr.updateRecord(spawned.agent_id, {
      state: "ready",
    });
    registry.set(spawned.agent_id, ready);
    relayActive = true;

    const result = parseToolResult(
      await sendTo.handler(
        { agent_id: spawned.agent_id, text: message, press_enter: true },
        {} as any,
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      delivery_state: "rescued",
      terminal: true,
      delivered: false,
      submit_verified: false,
      submit_evidence: "transcript_echo",
    });
  }, 20_000);

  it("send_to reports rescued on a first-ever interrupt after Return", async () => {
    const message = "Reply with the single word OK";
    const baseExec = makeLifecycleExec();
    let relayActive = false;
    let relayTyped = false;
    let relayReturned = false;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (
        relayActive &&
        (args.includes("send") || args.includes("set-buffer")) &&
        text.includes(message)
      ) {
        relayTyped = true;
        return { stdout: "{}", stderr: "" };
      }
      if (relayActive && args.includes("send-key") && args.includes("return")) {
        relayReturned = true;
        return { stdout: "{}", stderr: "" };
      }
      if (relayActive && args.includes("read-screen")) {
        const screen = !relayTyped
          ? [
              ">_ OpenAI Codex",
              "› Ask Codex to do anything",
              "gpt-5.6-sol medium · ~/Gits/brainlayer",
            ].join("\n")
          : !relayReturned
            ? [
                ">_ OpenAI Codex",
                `» ${message}`,
                "gpt-5.6-sol medium · ~/Gits/brainlayer",
              ].join("\n")
            : [
                ">_ OpenAI Codex",
                "■ Conversation interrupted - tell the model what to do differently",
                `• ${message}`,
                "Working (1s • esc to interrupt)",
                "gpt-5.6-sol medium · ~/Gits/brainlayer",
              ].join("\n");
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: screen,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];
    const spawned = parseToolResult(
      await spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "initial work",
        },
        {} as any,
      ),
    );
    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const ready = engine.stateMgr.updateRecord(spawned.agent_id, {
      state: "ready",
    });
    registry.set(spawned.agent_id, ready);
    relayActive = true;

    const result = parseToolResult(
      await sendTo.handler(
        { agent_id: spawned.agent_id, text: message, press_enter: true },
        {} as any,
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      delivery_state: "rescued",
      terminal: true,
      delivered: false,
      submit_verified: false,
      submit_evidence: "transcript_echo",
    });
  }, 20_000);

  it("keeps a latched interrupt rescued after pending delivery verification sweeps", async () => {
    const message = "Reply with the single word OK";
    const baseExec = makeLifecycleExec();
    let relayActive = false;
    let relayTyped = false;
    let relayReturned = false;
    const exec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      const text = String(args.at(-1) ?? "");
      if (
        relayActive &&
        (args.includes("send") || args.includes("set-buffer")) &&
        text.includes(message)
      ) {
        relayTyped = true;
        return { stdout: "{}", stderr: "" };
      }
      if (relayActive && args.includes("send-key") && args.includes("return")) {
        relayReturned = true;
        return { stdout: "{}", stderr: "" };
      }
      if (relayActive && args.includes("read-screen")) {
        const screen = !relayTyped
          ? [
              ">_ OpenAI Codex",
              "› Ask Codex to do anything",
              "gpt-5.6-sol medium · ~/Gits/brainlayer",
            ].join("\n")
          : !relayReturned
            ? [
                ">_ OpenAI Codex",
                `» ${message}`,
                "gpt-5.6-sol medium · ~/Gits/brainlayer",
              ].join("\n")
            : [
                ">_ OpenAI Codex",
                "■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/",
                "  feedback` to report the issue.",
                "",
                "› Ask Codex to do anything",
                "",
                "gpt-5.6-sol medium · ~/Gits/brainlayer",
              ].join("\n");
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: screen,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return baseExec(cmd, args);
    });
    const server = createLifecycleServer(exec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];
    const spawned = parseToolResult(
      await spawn.handler(
        {
          repo: "brainlayer",
          model: "codex",
          cli: "codex",
          prompt: "initial work",
        },
        {} as any,
      ),
    );
    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const ready = engine.stateMgr.updateRecord(spawned.agent_id, {
      state: "ready",
    });
    registry.set(spawned.agent_id, ready);
    relayActive = true;

    const sent = parseToolResult(
      await sendTo.handler(
        { agent_id: spawned.agent_id, text: message, press_enter: true },
        {} as any,
      ),
    );
    await engine.verifyPendingDeliveries();

    expect(engine.getDeliveryReceipt(sent.delivery_id)).toMatchObject({
      delivery_id: sent.delivery_id,
      delivery_state: "rescued",
      terminal: true,
      submit_verified: false,
    });
  }, 20_000);

  it("send_to submits chunked multiline text as one receiver message", async () => {
    const baseExec = makeLifecycleExec();
    const buffers = new Map<string, string>();
    let composer = "";
    let collectReceiverInput = false;
    const submittedMessages: string[] = [];
    const submitComposer = () => {
      submittedMessages.push(composer);
      composer = "";
    };
    const typeCmuxSendText = (text: string) => {
      for (const char of text) {
        if (char === "\n" || char === "\r") {
          submitComposer();
        } else {
          composer += char;
        }
      }
    };
    mockExec = vi.fn().mockImplementation(async (cmd, args: string[]) => {
      if (!collectReceiverInput) {
        return baseExec(cmd, args);
      }
      if (args.includes("set-buffer")) {
        const nameIndex = args.indexOf("--name");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : "default";
        buffers.set(name, args[args.length - 1]);
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("paste-buffer")) {
        const nameIndex = args.indexOf("--name");
        const name = nameIndex >= 0 ? args[nameIndex + 1] : "default";
        composer += buffers.get(name) ?? "";
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send-key")) {
        const key = args[args.length - 1];
        if (key === "return" || key === "enter") {
          submitComposer();
        }
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("send")) {
        typeCmuxSendText(args[args.length - 1]);
        return { stdout: "{}", stderr: "" };
      }
      return baseExec(cmd, args);
    });

    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const sendTo = (server as any)._registeredTools["send_to"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "test",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const agent = registry.get(agentId);
    registry.set(agentId, { ...agent, state: "ready" });
    collectReceiverInput = true;
    mockExec.mockClear();

    const longText = [
      "alpha ".repeat(24),
      "bravo ".repeat(24),
      "charlie ".repeat(24),
      "delta ".repeat(24),
      "echo ".repeat(24),
    ].join("\n");

    const result = await sendTo.handler(
      { agent_id: agentId, text: longText, press_enter: true },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(submittedMessages).toEqual([longText]);
  });

  it("send_to returns an error for an unknown agent_id", async () => {
    const server = createLifecycleServer(mockExec);
    const sendTo = (server as any)._registeredTools["send_to"];

    const result = await sendTo.handler(
      { agent_id: "missing-agent", text: "hello facade", press_enter: true },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatch(/Agent not found/);
  });

  it("supersede_agent_goal updates registry metadata and delivers a file-backed goal", async () => {
    const goalPath = join(TEST_DIR, "mission.md");
    writeFileSync(
      goalPath,
      "# Mission\n\nFinish the lifecycle repair.\n",
      "utf8",
    );
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const supersede = (server as any)._registeredTools["supersede_agent_goal"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const registry = engine.getRegistry();
    const ready = engine.stateMgr.transition(agentId, "ready");
    registry.set(agentId, ready);
    const working = engine.stateMgr.transition(agentId, "working");
    registry.set(agentId, working);
    mockExec.mockClear();

    const result = await supersede.handler(
      {
        agent_id: agentId,
        goal_file: goalPath,
        summary: "full baseline mission",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(parsed.ok).toBe(true);
    expect(parsed.task_summary).toBe("full baseline mission");
    expect(parsed.goal_file).toBe(goalPath);
    expect(parsed.registry_state).toBe("working");
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        `/goal Read and execute this goal file until complete: ${goalPath}`,
      ]),
    );

    const stateResult = await getState.handler(
      { agent_id: agentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(state.task_summary).toBe("full baseline mission");
    expect(state.goal_file).toBe(goalPath);
  });

  it("supersede_agent_goal reports an unverified pane side effect without patching the registry", async () => {
    const goalPath = join(TEST_DIR, "queued-mission.md");
    writeFileSync(
      goalPath,
      "# Queued mission\n\nReplace the active work.\n",
      "utf8",
    );
    const baseExec = makeLifecycleExec();
    let goalWasWritten = false;
    const supersedeExec = vi.fn(async (cmd, args) => {
      const text = String(args[args.length - 1] ?? "");
      if (args.includes("send") && text.startsWith("/goal ")) {
        goalWasWritten = true;
      }
      const result = await baseExec(cmd, args);
      if (goalWasWritten && args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: `OpenAI Codex\nWorking (3s • esc to interrupt)\n\n• Messages to be submitted after next tool call (press esc to interrupt and send\n  immediately)\n  ↳ /goal Read and execute this goal file until complete: ${goalPath}\n\n› Summarize recent commits\n\n  gpt-5.6-sol xhigh`,
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      return result;
    });
    const server = createLifecycleServer(supersedeExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const supersede = (server as any)._registeredTools["supersede_agent_goal"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const stateMgr = engine.stateMgr;
    const currentAgentId = resolveCurrentTestAgentId(stateMgr, agentId);
    const registry = engine.getRegistry();
    const ready = stateMgr.transition(currentAgentId, "ready");
    registry.set(currentAgentId, ready);
    const working = stateMgr.transition(currentAgentId, "working", {
      task_summary: "original mission",
      goal_file: null,
    });
    registry.set(currentAgentId, working);

    vi.useFakeTimers();
    try {
      const resultPromise = supersede.handler(
        {
          agent_id: agentId,
          goal_file: goalPath,
          summary: "queued replacement mission",
        },
        {} as any,
      );
      for (let elapsed = 0; elapsed < 10_000; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const result = await resultPromise;
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(parsed).toMatchObject({
        error_code: "supersede_submit_unverified",
        submit_verified: false,
        submit_verification_reason: "input_still_pending",
        retry_count: 0,
        registry_updated: false,
        goal_delivery_state: "unverified_pane_side_effect",
        retry_safe: false,
      });
      expect(parsed.recovery).toContain("Do not retry");
      expect(goalWasWritten).toBe(true);

      const state = stateMgr.readState(currentAgentId);
      expect(state?.task_summary).not.toBe("queued replacement mission");
      expect(state?.goal_file).not.toBe(goalPath);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it("supersede_agent_goal rejects a null submit receipt without patching an error-state agent", async () => {
    const goalPath = join(TEST_DIR, "unverified-error-state-mission.md");
    writeFileSync(
      goalPath,
      "# Mission\n\nDo not record without proof.\n",
      "utf8",
    );
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const supersede = (server as any)._registeredTools["supersede_agent_goal"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const stateMgr = engine.stateMgr;
    const currentAgentId = resolveCurrentTestAgentId(stateMgr, agentId);
    const registry = engine.getRegistry();
    const errored = stateMgr.updateRecord(currentAgentId, {
      state: "error",
      error: "stale terminal error",
      task_summary: "original mission",
      goal_file: null,
    });
    registry.set(currentAgentId, errored);

    const result = await supersede.handler(
      {
        agent_id: agentId,
        goal_file: goalPath,
        summary: "unverified replacement mission",
        allow_busy: false,
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      error_code: "supersede_submit_unverified",
      submit_verified: false,
      registry_updated: false,
      retry_safe: false,
    });
    const state = stateMgr.readState(currentAgentId);
    expect(state?.state).toBe("error");
    expect(state?.task_summary).toBe("original mission");
    expect(state?.goal_file).toBeNull();
  });

  it("supersede_agent_goal updates the canonical record when called through an alias", async () => {
    const goalPath = join(TEST_DIR, "alias-mission.md");
    writeFileSync(goalPath, "# Mission\n\nUse the canonical state.\n", "utf8");
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const supersede = (server as any)._registeredTools["supersede_agent_goal"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const pendingAgentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const currentAgentId = resolveCurrentTestAgentId(
      engine.stateMgr,
      pendingAgentId,
    );
    const finalAgentId = "brainlayerCodex-019f0001";
    const renamed = engine.stateMgr.renameState(currentAgentId, finalAgentId);
    engine.getRegistry().rename(currentAgentId, finalAgentId, renamed);
    mockExec.mockClear();

    const result = await supersede.handler(
      {
        agent_id: pendingAgentId,
        goal_file: goalPath,
        summary: "alias mission",
      },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(parsed.agent_id).toBe(finalAgentId);
    expect(parsed.task_summary).toBe("alias mission");

    const stateResult = await getState.handler(
      { agent_id: finalAgentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(state.task_summary).toBe("alias mission");
    expect(state.goal_file).toBe(goalPath);
  });

  it("supersede_agent_goal clears stale boot prompt metadata after delivery", async () => {
    const goalPath = join(TEST_DIR, "boot-pending-mission.md");
    writeFileSync(
      goalPath,
      "# Mission\n\nReplace boot prompt state.\n",
      "utf8",
    );
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const supersede = (server as any)._registeredTools["supersede_agent_goal"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const current = engine.stateMgr.updateRecord(agentId, {
      boot_prompt_pending: true,
    });
    engine.getRegistry().set(agentId, current);
    mockExec.mockClear();

    const result = await supersede.handler(
      {
        agent_id: agentId,
        goal_file: goalPath,
        summary: "boot replacement mission",
      },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    const stateResult = await getState.handler(
      { agent_id: agentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(state.state).toBe("working");
    expect(state.boot_prompt_pending).toBe(false);
    expect(state.task_summary).toBe("boot replacement mission");
  });

  it.each(["done", "error"] as const)(
    "supersede_agent_goal resets stale %s lifecycle metadata after delivery",
    async (terminalState) => {
      const goalPath = join(TEST_DIR, `reset-${terminalState}-mission.md`);
      writeFileSync(
        goalPath,
        "# Mission\n\nReplace stale lifecycle state.\n",
        "utf8",
      );
      const server = createLifecycleServer(mockExec);
      const spawn = (server as any)._registeredTools["spawn_agent"];
      const supersede = (server as any)._registeredTools[
        "supersede_agent_goal"
      ];
      const getState = (server as any)._registeredTools["get_agent_state"];

      const spawnResult = await spawn.handler(
        {
          repo: "brainlayer",
          model: "gpt-5.5",
          cli: "codex",
          role: "worker",
        },
        {} as any,
      );
      const agentId = (
        spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
      ).agent_id;
      const engine = (server as any)._registeredTools["interact"]._engine;
      const registry = engine.getRegistry();
      let current = engine.stateMgr.transition(agentId, "ready");
      registry.set(agentId, current);
      current = engine.stateMgr.transition(agentId, "working");
      registry.set(agentId, current);
      current =
        terminalState === "done"
          ? engine.stateMgr.transition(agentId, "done")
          : engine.stateMgr.transition(agentId, "error", {
              error: "stale terminal error",
            });
      current = engine.stateMgr.updateRecord(agentId, {
        task_done_candidate_at: "2026-06-26T21:00:00.000Z",
        task_done_detected_at: "2026-06-26T21:01:00.000Z",
      });
      registry.set(agentId, current);
      mockExec.mockClear();

      const result = await supersede.handler(
        {
          agent_id: agentId,
          goal_file: goalPath,
          summary: "replacement mission",
        },
        {} as any,
      );
      const parsed =
        result.structuredContent ?? JSON.parse(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(parsed.registry_state).toBe("working");

      const stateResult = await getState.handler(
        { agent_id: agentId },
        {} as any,
      );
      const state =
        stateResult.structuredContent ??
        JSON.parse(stateResult.content[0].text);
      expect(state.state).toBe("working");
      expect(state.task_summary).toBe("replacement mission");
      expect(state.goal_file).toBe(goalPath);
      expect(state.task_done_candidate_at ?? null).toBeNull();
      expect(state.task_done_detected_at ?? null).toBeNull();
      expect(state.error ?? null).toBeNull();
    },
  );

  it("supersede_agent_goal does not update registry metadata when delivery fails", async () => {
    const goalPath = join(TEST_DIR, "undelivered-mission.md");
    writeFileSync(
      goalPath,
      "# Mission\n\nThis should not be recorded.\n",
      "utf8",
    );
    const backingExec = makeLifecycleExec();
    const failingExec: ExecFn = vi
      .fn()
      .mockImplementation(async (cmd, args) => {
        const text = String(args[args.length - 1] ?? "");
        if (args.includes("send") && text.startsWith("/goal ")) {
          throw new Error("send failed");
        }
        return backingExec(cmd, args);
      });
    const server = createLifecycleServer(failingExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const supersede = (server as any)._registeredTools["supersede_agent_goal"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;
    const engine = (server as any)._registeredTools["interact"]._engine;
    const stateMgr = engine.stateMgr;
    const currentAgentId = resolveCurrentTestAgentId(stateMgr, agentId);
    const registry = engine.getRegistry();
    const oldState = stateMgr.updateRecord(currentAgentId, {
      task_summary: "old mission",
      goal_file: null,
    });
    registry.set(currentAgentId, oldState);

    const result = await supersede.handler(
      {
        agent_id: currentAgentId,
        goal_file: goalPath,
        summary: "new mission",
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatch(/send failed/);

    const state = stateMgr.readState(currentAgentId);
    expect(state?.task_summary).toBe("old mission");
    expect(state?.goal_file).toBeNull();
  });

  it("supersede_agent_goal rejects a missing goal file", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const supersede = (server as any)._registeredTools["supersede_agent_goal"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "gpt-5.5",
        cli: "codex",
        role: "worker",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const result = await supersede.handler(
      {
        agent_id: agentId,
        goal_file: join(TEST_DIR, "missing.md"),
      },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatch(/ENOENT/);
  });

  it("wait_for defaults to done when target_state is omitted", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const waitFor = (server as any)._registeredTools["wait_for"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const engine = (server as any)._registeredTools["interact"]._engine;
    const stateMgr = engine["stateMgr"];
    const currentAgentId = resolveCurrentTestAgentId(stateMgr, agentId);

    if (stateMgr.readState(currentAgentId)?.state === "booting") {
      stateMgr.transition(currentAgentId, "ready");
    }
    stateMgr.transition(currentAgentId, "done");
    const doneState = stateMgr.updateRecord(currentAgentId, {
      task_done_detected_at: "2026-06-05T17:20:00.000Z",
    });
    if (!doneState) {
      throw new Error("Expected done state to exist");
    }
    engine.getRegistry().set(agentId, doneState);

    const result = await waitFor.handler(
      { agent_id: currentAgentId, timeout_ms: 1500 },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    // F1b (#473): the omitted target still defaults to `done` -- but this
    // fixture's pane shows `✻ Working` while the record was forced to `done`,
    // and a wait may no longer terminate on a record the screen contradicts.
    // So the default-target wait runs and reports the reconciled state instead
    // of matching. Asserting `done` here would re-encode the false completion.
    expect(parsed.state).toBe("working");
    expect(parsed.matched).toBe(false);
    expect(parsed.agent.session_id).toBeNull();
  }, 10_000);

  it("wait_for returns the engine snapshot without a second public-agent read", async () => {
    const server = createLifecycleServer(mockExec);
    const waitFor = (server as any)._registeredTools["wait_for"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    vi.spyOn(engine, "waitFor").mockResolvedValue({
      matched: true,
      state: "done",
      elapsed: 12,
      source: "sweep",
      agent: {
        agent_id: "agent-1",
        repo: "brainlayer",
        model: "sonnet",
        state: "done",
        session_id: "sess-1",
      },
    } as any);
    const getPublicAgentSpy = vi
      .spyOn(engine, "getPublicAgent")
      .mockImplementation(() => {
        throw new Error("unexpected second public-agent read");
      });

    const result = await waitFor.handler(
      { agent_id: "agent-1", timeout_ms: 5000 },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(result.isError).not.toBe(true);
    expect(parsed.ok).toBe(true);
    expect(parsed.agent).toEqual({
      agent_id: "agent-1",
      repo: "brainlayer",
      model: "sonnet",
      state: "done",
      session_id: "sess-1",
    });
    expect(getPublicAgentSpy).not.toHaveBeenCalled();
  });

  it("wait_for mine=true preserves wait_for_all over the caller's direct children", async () => {
    const server = createLifecycleServer(mockExec);
    const waitFor = (server as any)._registeredTools["wait_for"];
    const engine = (server as any)._registeredTools["interact"]._engine;
    const parent = makeServerAgentRecord({
      agent_id: "parent-agent",
      surface_id: "surface:parent",
      state: "ready",
    });
    const child = makeServerAgentRecord({
      agent_id: "child-agent",
      parent_agent_id: parent.agent_id,
      surface_id: "surface:child",
      state: "done",
    });
    engine.stateMgr.writeState(parent);
    engine.stateMgr.writeState(child);
    engine.getRegistry().set(parent.agent_id, parent);
    engine.getRegistry().set(child.agent_id, child);
    const waitForAll = vi.spyOn(engine, "waitForAll").mockResolvedValue([]);

    const result = await runWithCallerContext(
      { surfaceId: parent.surface_id },
      () => waitFor.handler({ mine: true, target_state: "done" }, {} as any),
    );

    expect(result.structuredContent).toMatchObject({ ok: true, results: [] });
    expect(waitForAll).toHaveBeenCalledWith(
      [child.agent_id],
      "done",
      undefined,
    );
  });

  it("wait_for returns an error for an unknown agent_id", async () => {
    const server = createLifecycleServer(mockExec);
    const waitFor = (server as any)._registeredTools["wait_for"];

    const result = await waitFor.handler(
      { agent_id: "missing-agent", timeout_ms: 5000 },
      {} as any,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatch(/Agent not found/);
  });

  // Regression: my_agents reported state:"error" + token_count:null for a HEALTHY idle
  // agent while read_screen returned context_window:1000000. The live screen parse is
  // ground truth for liveness — a stale registry "error" must not mask a running agent.
  describe("reconcileAgentLiveState", () => {
    const liveScreen = (
      status: ParsedScreenResult["status"],
      tokenCount: number | null,
    ): ParsedScreenResult => ({
      agent_type: "claude",
      status,
      token_count: tokenCount,
      context_pct: 20,
      context_window: 1_000_000,
      done_signal: null,
      response: null,
      errors: [],
      model: "Opus",
      cost: null,
    });

    it("surfaces live idle status when registry state is a stale error", () => {
      expect(
        reconcileAgentLiveState("error", liveScreen("idle", 196_000)),
      ).toBe("idle");
    });

    it("surfaces live working status when registry state is a stale error", () => {
      expect(
        reconcileAgentLiveState("error", liveScreen("working", 50_000)),
      ).toBe("working");
    });

    it("surfaces a live harness API error over a stale healthy registry state", () => {
      const harnessError = liveScreen("frozen", 50_000);
      harnessError.errors = [
        "harness_api_error: request refused request_id=req_my_agents",
      ];
      expect(reconcileAgentLiveState("working", harnessError)).toBe("error");
    });

    it("keeps registry error when there is no live screen to reconcile against", () => {
      expect(reconcileAgentLiveState("error", null)).toBe("error");
    });

    it("does not override a healthy registry state", () => {
      expect(reconcileAgentLiveState("working", null)).toBe("working");
      expect(reconcileAgentLiveState("idle", liveScreen("idle", 10_000))).toBe(
        "idle",
      );
    });

    it("keeps registry error when the live screen is a bare shell (crashed agent, unknown type)", () => {
      // parseScreen returns status:"idle" for a plain shell prompt with agent_type:"unknown";
      // a crashed agent fallen back to a shell must NOT be reported healthy.
      const shell: ParsedScreenResult = {
        ...liveScreen("idle", null),
        agent_type: "unknown",
      };
      expect(reconcileAgentLiveState("error", shell)).toBe("error");
    });
  });

  it("read_screen binds a Codex fill by stable UUID and exact session path", async () => {
    const stableUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const path = "/fixtures/codex/rollout-session-a.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:live",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-read-screen",
      surface_id: "surface:live",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      state: "ready",
      cli_session_id: "session-a",
      cli_session_path: path,
    });
    const get = vi.fn().mockResolvedValue({
      token_count: 100_000,
      context_window: 400_000,
      context_pct: 25,
      observed_model_context_window: 258_400,
    });
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = await registeredTestTool(server, "read_screen").handler(
      { surface: "surface:live", parsed_only: true },
      {},
    );
    const parsed = parseToolResult(result);

    expect(get).toHaveBeenCalledWith(path);
    expect(parsed.parsed).toMatchObject({
      agent_type: "codex",
      token_count: 100_000,
      context_window: 400_000,
      context_pct: 25,
    });
  });

  it("read_screen keeps an authorized Codex fill when the viewport lacks a Codex marker", async () => {
    const stableUuid = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
    const path = "/fixtures/codex/viewport-without-marker.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:markerless",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText("plain build output without a status bar");
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-markerless",
      surface_id: "surface:markerless",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      cli_session_path: path,
    });
    const get = vi.fn().mockResolvedValue({
      token_count: 100_000,
      context_window: 400_000,
      context_pct: 25,
      observed_model_context_window: null,
    });
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = parseToolResult(
      await registeredTestTool(server, "read_screen").handler(
        { surface: "surface:markerless", parsed_only: true },
        {},
      ),
    );

    expect(result.parsed).toMatchObject({
      agent_type: "unknown",
      token_count: 100_000,
      context_window: 400_000,
      context_pct: 25,
    });
  });

  it("read_screen never overlays a stale ref-selected harness onto an authorized Codex UUID", async () => {
    const stableUuid = "aaaacccc-eeee-4ddd-8bbb-ffff00002222";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:harness-collision",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const codex = makeServerAgentRecord({
      agent_id: "codex-fill-harness-collision",
      surface_id: "surface:harness-collision",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      cli_session_path: "/fixtures/codex/harness-collision.jsonl",
    });
    const server = await createUuidRouteServer(routeClient, codex, {
      codexRolloutFillProvider: { get: vi.fn().mockResolvedValue(null) },
    });
    const staleClaude = makeServerAgentRecord({
      agent_id: "claude-stale-harness-collision",
      surface_id: "surface:harness-collision",
      surface_uuid: "ffffcccc-eeee-4ddd-8bbb-aaaa00003333",
      workspace_id: "workspace:live",
      cli: "claude",
      model: "claude-opus-4-8",
      cli_session_id: "stale-claude-session",
      cli_session_path: null,
      version: codex.version + 10,
      updated_at: "2026-07-18T04:30:00.000Z",
    });
    const engine = testLifecycleEngine(server);
    engine.stateMgr.writeState(staleClaude);
    engine.getRegistry().set(staleClaude.agent_id, staleClaude);
    const harnessHome = join(TEST_DIR, "harness-collision-home");
    const claudeProject = join(harnessHome, ".claude", "projects", "-x");
    mkdirSync(claudeProject, { recursive: true });
    writeFileSync(
      join(claudeProject, "stale-claude-session.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "stale reply" }],
          usage: { input_tokens: 80_000, output_tokens: 2_000 },
        },
      })}\n`,
    );
    const previousFlag = process.env.CMUXLAYER_HARNESS_JSONL;
    const previousHome = process.env.CMUXLAYER_HARNESS_HOME;
    process.env.CMUXLAYER_HARNESS_JSONL = "1";
    process.env.CMUXLAYER_HARNESS_HOME = harnessHome;
    try {
      const result = parseToolResult(
        await registeredTestTool(server, "read_screen").handler(
          { surface: "surface:harness-collision", parsed_only: true },
          {},
        ),
      );

      expect(result.parsed).toMatchObject({
        agent_type: "codex",
        token_count: null,
        context_pct: 25,
      });
    } finally {
      if (previousFlag === undefined)
        delete process.env.CMUXLAYER_HARNESS_JSONL;
      else process.env.CMUXLAYER_HARNESS_JSONL = previousFlag;
      if (previousHome === undefined) delete process.env.CMUXLAYER_HARNESS_HOME;
      else process.env.CMUXLAYER_HARNESS_HOME = previousHome;
    }
  });

  it("read_screen never crosses Codex rollout paths between distinct stable UUIDs", async () => {
    const firstUuid = "10000000-0000-4000-8000-000000000001";
    const secondUuid = "20000000-0000-4000-8000-000000000002";
    const firstPath = "/fixtures/codex/rollout-first.jsonl";
    const secondPath = "/fixtures/codex/rollout-second.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:first",
        id: firstUuid,
        workspace_ref: "workspace:live",
      },
      {
        ref: "surface:second",
        id: secondUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 99% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const first = makeServerAgentRecord({
      agent_id: "codex-fill-first",
      surface_id: "surface:first",
      surface_uuid: firstUuid,
      workspace_id: "workspace:live",
      cli_session_path: firstPath,
      launch_cwd: null,
    });
    const second = makeServerAgentRecord({
      agent_id: "codex-fill-second",
      surface_id: "surface:second",
      surface_uuid: secondUuid,
      workspace_id: "workspace:live",
      cli_session_path: secondPath,
      launch_cwd: "/intentionally/mismatched",
    });
    const get = vi.fn(async (path: string) => ({
      token_count: path === firstPath ? 40_000 : 120_000,
      context_window: 400_000 as const,
      context_pct: path === firstPath ? 10 : 30,
      observed_model_context_window: null,
    }));
    const server = await createUuidRouteServer(routeClient, first, {
      codexRolloutFillProvider: { get },
    });
    const engine = testLifecycleEngine(server);
    engine.stateMgr.writeState(second);
    engine.getRegistry().set(second.agent_id, second);

    const firstResult = parseToolResult(
      await registeredTestTool(server, "read_screen").handler(
        { surface: "surface:first", parsed_only: true },
        {},
      ),
    );
    const secondResult = parseToolResult(
      await registeredTestTool(server, "read_screen").handler(
        { surface: "surface:second", parsed_only: true },
        {},
      ),
    );

    expect(firstResult.parsed.token_count).toBe(40_000);
    expect(secondResult.parsed.token_count).toBe(120_000);
    expect(get.mock.calls).toEqual([[firstPath], [secondPath]]);
  });

  it("read_screen preserves screen fallback and skips a recycled Codex surface ref", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:recycled",
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-stale-ref",
      surface_id: "surface:recycled",
      surface_uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspace_id: "workspace:live",
      cli_session_path: "/fixtures/codex/stale.jsonl",
    });
    const get = vi.fn();
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = parseToolResult(
      await registeredTestTool(server, "read_screen").handler(
        { surface: "surface:recycled", parsed_only: true },
        {},
      ),
    );

    expect(get).not.toHaveBeenCalled();
    expect(result.parsed).toMatchObject({
      token_count: null,
      context_pct: 25,
    });
  });

  it("read_screen refuses a Codex fill when the surface UUID changes during the read", async () => {
    const oldUuid = "abab0000-0000-4000-8000-000000000001";
    const newUuid = "abab0000-0000-4000-8000-000000000002";
    const path = "/fixtures/codex/recycled-during-read.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:racing",
        id: oldUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-racing-ref",
      surface_id: "surface:racing",
      surface_uuid: oldUuid,
      workspace_id: "workspace:live",
      cli_session_path: path,
    });
    const get = vi.fn().mockResolvedValue({
      token_count: 300_000,
      context_window: 400_000,
      context_pct: 75,
      observed_model_context_window: null,
    });
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });
    routeClient.client.readScreen.mockImplementationOnce(
      async (surface: string) => {
        routeClient.setLiveSurfaces([
          {
            ref: "surface:racing",
            id: newUuid,
            workspace_ref: "workspace:live",
          },
        ]);
        return {
          surface,
          text: "gpt-5.4 high · 75% left · ~/Gits/old-seat\nWorking (2s • esc to interrupt)",
          lines: 20,
          scrollback_used: false,
        };
      },
    );

    const result = parseToolResult(
      await registeredTestTool(server, "read_screen").handler(
        { surface: "surface:racing", parsed_only: true },
        {},
      ),
    );

    expect(get).not.toHaveBeenCalled();
    expect(result.parsed).toMatchObject({
      token_count: null,
      context_pct: 25,
    });
  });

  it("read_screen preserves the visible Codex percent when the bound rollout has no sample", async () => {
    const stableUuid = "abababab-abab-4bab-8bab-abababababab";
    const path = "/fixtures/codex/no-token-sample.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:no-sample",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-no-sample",
      surface_id: "surface:no-sample",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      cli_session_path: path,
    });
    const get = vi.fn().mockResolvedValue(null);
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = parseToolResult(
      await registeredTestTool(server, "read_screen").handler(
        { surface: "surface:no-sample", parsed_only: true },
        {},
      ),
    );

    expect(get).toHaveBeenCalledWith(path);
    expect(result.parsed).toMatchObject({
      token_count: null,
      context_window: 400_000,
      context_pct: 25,
    });
  });

  it("read_screen discards a Codex fill when the exact session path changes during rollout I/O", async () => {
    const stableUuid = "acac0000-0000-4000-8000-000000000001";
    const oldPath = "/fixtures/codex/session-before-read.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:path-race",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-path-race",
      surface_id: "surface:path-race",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      cli_session_path: oldPath,
    });
    const fill = deferred<CodexRolloutFill | null>();
    const get = vi.fn(() => fill.promise);
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const pending = registeredTestTool(server, "read_screen").handler(
      { surface: "surface:path-race", parsed_only: true },
      {},
    );
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(oldPath));
    const updated = {
      ...record,
      cli_session_path: "/fixtures/codex/session-after-read.jsonl",
      version: record.version + 1,
    };
    const engine = testLifecycleEngine(server);
    engine.stateMgr.writeState(updated);
    engine.getRegistry().set(updated.agent_id, updated);
    fill.resolve({
      token_count: 300_000,
      context_window: 400_000,
      context_pct: 75,
      observed_model_context_window: null,
    });

    const result = parseToolResult(await pending);
    expect(result.parsed).toMatchObject({
      token_count: null,
      context_pct: 25,
    });
  });

  it("get_agent_state exposes Codex rollout fill without mutating AgentRecord", async () => {
    const stableUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const path = "/fixtures/codex/get-agent-state.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:state",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-agent-state",
      surface_id: "surface:state",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      cli_session_path: path,
    });
    const get = vi.fn().mockResolvedValue({
      token_count: 80_000,
      context_window: 400_000,
      context_pct: 20,
      observed_model_context_window: null,
    });
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = parseToolResult(
      await registeredTestTool(server, "get_agent_state").handler(
        { agent_id: record.agent_id },
        {},
      ),
    );

    expect(get).toHaveBeenCalledWith(path);
    expect(result).toMatchObject({
      token_count: 80_000,
      context_window: 400_000,
      context_pct: 20,
    });
    expect(
      testLifecycleEngine(server).getAgentState(record.agent_id),
    ).not.toHaveProperty("token_count");
  });

  it("get_agent_state never reads a Codex rollout for a UUID-less record", async () => {
    const path = "/fixtures/codex/uuidless-agent-state.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:uuidless-state",
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-uuidless-state",
      surface_id: "surface:uuidless-state",
      surface_uuid: null,
      surface_observer_id: "cmux:/tmp/current.sock",
      workspace_id: "workspace:live",
      cli_session_path: path,
    });
    const get = vi.fn().mockResolvedValue({
      token_count: 80_000,
      context_window: 400_000,
      context_pct: 20,
      observed_model_context_window: null,
    });
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = parseToolResult(
      await registeredTestTool(server, "get_agent_state").handler(
        { agent_id: record.agent_id },
        {},
      ),
    );

    expect(get).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      token_count: null,
      context_window: null,
      context_pct: null,
    });
  });

  it("get_agent_state discards a Codex fill when the session path changes during rollout I/O", async () => {
    const stableUuid = "cdcd0000-0000-4000-8000-000000000001";
    const oldPath = "/fixtures/codex/state-session-before.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:state-path-race",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-state-path-race",
      surface_id: "surface:state-path-race",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      cli_session_path: oldPath,
    });
    const fill = deferred<CodexRolloutFill | null>();
    const get = vi.fn(() => fill.promise);
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const pending = registeredTestTool(server, "get_agent_state").handler(
      { agent_id: record.agent_id },
      {},
    );
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(oldPath));
    const updated = {
      ...record,
      cli_session_path: "/fixtures/codex/state-session-after.jsonl",
      version: record.version + 1,
    };
    const engine = testLifecycleEngine(server);
    engine.stateMgr.writeState(updated);
    engine.getRegistry().set(updated.agent_id, updated);
    fill.resolve({
      token_count: 300_000,
      context_window: 400_000,
      context_pct: 75,
      observed_model_context_window: null,
    });

    const result = parseToolResult(await pending);
    expect(result).toMatchObject({
      token_count: null,
      context_window: null,
      context_pct: null,
    });
  });

  it("get_agent_state discards a Codex fill when the record changes to another CLI during rollout I/O", async () => {
    const stableUuid = "cece0000-0000-4000-8000-000000000001";
    const path = "/fixtures/codex/state-cli-before.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:state-cli-race",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-state-cli-race",
      surface_id: "surface:state-cli-race",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      cli_session_path: path,
    });
    const fill = deferred<CodexRolloutFill | null>();
    const get = vi.fn(() => fill.promise);
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const pending = registeredTestTool(server, "get_agent_state").handler(
      { agent_id: record.agent_id },
      {},
    );
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(path));
    const updated = {
      ...record,
      cli: "claude" as const,
      version: record.version + 1,
    };
    const engine = testLifecycleEngine(server);
    engine.stateMgr.writeState(updated);
    engine.getRegistry().set(updated.agent_id, updated);
    fill.resolve({
      token_count: 300_000,
      context_window: 400_000,
      context_pct: 75,
      observed_model_context_window: null,
    });

    const result = parseToolResult(await pending);
    expect(result).toMatchObject({
      token_count: null,
      context_window: null,
      context_pct: null,
    });
  });

  it("my_agents applies the authorized Codex rollout fill", async () => {
    const stableUuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const path = "/fixtures/codex/my-agents.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:child",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-my-agents",
      surface_id: "surface:child",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      parent_agent_id: null,
      cli_session_path: path,
    });
    const get = vi.fn().mockResolvedValue({
      token_count: 160_000,
      context_window: 400_000,
      context_pct: 40,
      observed_model_context_window: null,
    });
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = parseToolResult(
      await registeredTestTool(server, "my_agents").handler({}, {}),
    );

    expect(get).toHaveBeenCalledWith(path);
    expect(result.agents[0]).toMatchObject({
      agent_id: record.agent_id,
      token_count: 160_000,
      context_window: 400_000,
      context_pct: 40,
    });
  });

  it("my_agents coalesces a shared Codex rollout across authorized records", async () => {
    const firstUuid = "d1000000-0000-4000-8000-000000000001";
    const secondUuid = "d2000000-0000-4000-8000-000000000002";
    const path = "/fixtures/codex/shared-rollout.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:shared-first",
        id: firstUuid,
        workspace_ref: "workspace:live",
      },
      {
        ref: "surface:shared-second",
        id: secondUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 99% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const first = makeServerAgentRecord({
      agent_id: "codex-shared-first",
      surface_id: "surface:shared-first",
      surface_uuid: firstUuid,
      workspace_id: "workspace:live",
      parent_agent_id: null,
      cli_session_path: path,
    });
    const second = makeServerAgentRecord({
      agent_id: "codex-shared-second",
      surface_id: "surface:shared-second",
      surface_uuid: secondUuid,
      workspace_id: "workspace:live",
      parent_agent_id: null,
      cli_session_path: path,
    });
    const bytes = Buffer.from(
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 200_000 } },
        },
      })}\n`,
    );
    const statFile = vi.fn().mockResolvedValue({
      size: bytes.length,
      mtimeMs: 1,
      dev: 2,
      ino: 50,
      isFile: true,
    });
    const readFileRange = vi.fn(
      async (_requestedPath: string, start: number, length: number) =>
        bytes.subarray(start, start + length),
    );
    const server = await createUuidRouteServer(routeClient, first, {
      codexRolloutFillProvider: makeCodexRolloutFillProvider({
        statFile,
        readFileRange,
      }),
    });
    const engine = testLifecycleEngine(server);
    engine.stateMgr.writeState(second);
    engine.getRegistry().set(second.agent_id, second);

    const result = parseToolResult(
      await registeredTestTool(server, "my_agents").handler({}, {}),
    );

    expect(result.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: first.agent_id,
          token_count: 200_000,
        }),
        expect.objectContaining({
          agent_id: second.agent_id,
          token_count: 200_000,
        }),
      ]),
    );
    expect(statFile).toHaveBeenCalledTimes(2);
    expect(readFileRange).toHaveBeenCalledTimes(1);
  });

  it("my_agents preserves screen data when an optional Codex fill never resolves", async () => {
    const stableUuid = "d3000000-0000-4000-8000-000000000003";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:slow-fill",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-slow-optional-fill",
      surface_id: "surface:slow-fill",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      parent_agent_id: null,
      cli_session_path: "/fixtures/codex/slow-fill.jsonl",
    });
    const get = vi.fn(() => new Promise<never>(() => {}));
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    vi.useFakeTimers();
    try {
      const pending = registeredTestTool(server, "my_agents").handler({}, {});
      for (
        let index = 0;
        index < 250 && get.mock.calls.length === 0;
        index += 1
      ) {
        await Promise.resolve();
      }
      expect(get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);
      const result = parseToolResult(await pending);

      expect(result.agents[0]).toMatchObject({
        agent_id: record.agent_id,
        surface_id: "surface:slow-fill",
        token_count: null,
        context_pct: 25,
      });
      expect(result.agents[0]).not.toHaveProperty("screen_unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("my_agents discards a Codex fill when the stable surface is recycled during rollout I/O", async () => {
    const oldUuid = "d4000000-0000-4000-8000-000000000004";
    const newUuid = "d5000000-0000-4000-8000-000000000005";
    const path = "/fixtures/codex/my-agents-recycled.jsonl";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:my-agents-race",
        id: oldUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\nWorking (2s • esc to interrupt)",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-fill-my-agents-race",
      surface_id: "surface:my-agents-race",
      surface_uuid: oldUuid,
      workspace_id: "workspace:live",
      parent_agent_id: null,
      cli_session_path: path,
    });
    const fill = deferred<CodexRolloutFill | null>();
    const get = vi.fn(() => fill.promise);
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const pending = registeredTestTool(server, "my_agents").handler({}, {});
    for (
      let index = 0;
      index < 250 && get.mock.calls.length === 0;
      index += 1
    ) {
      await Promise.resolve();
    }
    expect(get).toHaveBeenCalledWith(path);
    routeClient.setLiveSurfaces([
      {
        ref: "surface:my-agents-race",
        id: newUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    fill.resolve({
      token_count: 300_000,
      context_window: 400_000,
      context_pct: 75,
      observed_model_context_window: null,
    });

    const result = parseToolResult(await pending);
    expect(result.agents[0]).toMatchObject({
      agent_id: record.agent_id,
      token_count: null,
      context_pct: 25,
    });
  });

  it("never invokes the Codex provider for a Claude read_screen", async () => {
    const stableUuid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:claude",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "Claude Code\n⏺ Completed successfully\nToken usage: total=12,345 input=10,000 output=2,345\n🤖 Sonnet 4.6 | 💰 $1.25 | ⏱️  2m 11s",
    );
    const record = makeServerAgentRecord({
      agent_id: "claude-no-codex-fill",
      surface_id: "surface:claude",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      cli: "claude",
      model: "sonnet",
      cli_session_path: "/fixtures/claude/session.jsonl",
    });
    const get = vi.fn();
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = parseToolResult(
      await registeredTestTool(server, "read_screen").handler(
        { surface: "surface:claude", parsed_only: true },
        {},
      ),
    );

    expect(get).not.toHaveBeenCalled();
    expect(result.parsed).toMatchObject({
      agent_type: "claude",
      token_count: 12_345,
    });
  });

  it("keeps the Codex rollout reader off the delivery-safety path", async () => {
    const stableUuid = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:delivery",
        id: stableUuid,
        workspace_ref: "workspace:live",
      },
    ]);
    routeClient.setScreenText(
      "gpt-5.4 high · 75% left · ~/Gits/cmuxlayer\ncodex> ",
    );
    const record = makeServerAgentRecord({
      agent_id: "codex-delivery-no-fill",
      surface_id: "surface:delivery",
      surface_uuid: stableUuid,
      workspace_id: "workspace:live",
      state: "ready",
      cli_session_path: "/fixtures/codex/delivery.jsonl",
    });
    const get = vi.fn();
    const server = await createUuidRouteServer(routeClient, record, {
      codexRolloutFillProvider: { get },
    });

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "delivery must stay scan-free",
        press_enter: true,
      },
      {},
    );

    expect(result.isError).toBeFalsy();
    expect(get).not.toHaveBeenCalled();
  });

  it("my_agents returns root agents when no parent_agent_id", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];

    await spawn.handler({ repo: "voicelayer", cli: "claude" }, {} as any);
    await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
      },
      {} as any,
    );

    const result = await myAgents.handler({}, {} as any);
    const data = result.structuredContent;
    expect(data.count).toBe(2);
    expect(data.agents).toHaveLength(2);
    expect(data.agents[0].repo).toBeDefined();
    expect(data.agents[0].state).toBeDefined();
    expect(data.agents[0].task_summary).toBeDefined();
    expect(data.parent_agent_id).toBeNull();
  });

  it("my_agents does not read a UUID-less row owned by a foreign observer", async () => {
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:shared",
        workspace_ref: "workspace:current",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "foreign-observer-my-agents",
      surface_id: "surface:shared",
      surface_uuid: null,
      surface_observer_id: "cmux:/tmp/foreign.sock",
      workspace_id: "workspace:foreign",
      state: "ready",
      parent_agent_id: null,
      repo: "cmuxlayer",
      cli: "codex",
    });
    const server = await createUuidRouteServer(routeClient, record);
    enforceTestObserverOwnership(server, "cmux:/tmp/current.sock");
    routeClient.setScreenText(
      "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)",
    );

    const parsed = parseToolResult(
      await registeredTestTool(server, "my_agents").handler({}, {}),
    );
    const agent = (parsed.agents as Array<Record<string, any>>).find(
      (candidate) => candidate.agent_id === record.agent_id,
    );

    expect(agent).toMatchObject({
      agent_id: record.agent_id,
      state: "ready",
      surface_id: null,
      screen_unavailable: true,
      error_code: "screen_unavailable",
    });
  });

  it("my_agents reads and reports the stable UUID route after its ref moves", async () => {
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    const routeClient = makeUuidRouteClient([
      {
        ref: "surface:old",
        id: stableUuid,
        workspace_ref: "workspace:old",
      },
    ]);
    const record = makeServerAgentRecord({
      agent_id: "uuid-my-agents",
      surface_id: "surface:old",
      surface_uuid: stableUuid,
      workspace_id: "workspace:old",
      state: "error",
      error: "stale lifecycle state",
      task_done_detected_at: null,
    });
    const server = await createUuidRouteServer(routeClient, record);
    const movedSurfaces: UuidRouteSurface[] = [
      {
        ref: "surface:old",
        id: "uuid-recycled",
        workspace_ref: "workspace:old",
      },
      {
        ref: "surface:new",
        id: stableUuid,
        workspace_ref: "workspace:new",
      },
    ];
    const engine = testLifecycleEngine(server) as any;
    const registry = engine.getRegistry();
    const originalListMerged = registry.listMerged.bind(registry);
    vi.spyOn(registry, "listMerged").mockImplementation(
      async (...args: any[]) => {
        const merged = await originalListMerged(...args);
        routeClient.setLiveSurfaces(movedSurfaces);
        return merged;
      },
    );
    routeClient.client.readScreen.mockImplementation(
      async (surface: string) => ({
        surface,
        text:
          surface === "surface:new"
            ? "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)"
            : "Claude Code\nWhat can I help you with?\n> ",
        lines: 20,
        scrollback_used: false,
      }),
    );
    routeClient.client.readScreen.mockClear();

    const result = await registeredTestTool(server, "my_agents").handler(
      {},
      {} as any,
    );
    const agents = parseToolResult(result).agents as Array<
      Record<string, unknown>
    >;

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agent_id: record.agent_id,
      surface_id: "surface:new",
      state: "working",
    });
    expect(routeClient.client.readScreen).toHaveBeenCalledWith("surface:new", {
      lines: 20,
      workspace: "workspace:new",
    });
    expect(routeClient.client.readScreen).not.toHaveBeenCalledWith(
      "surface:old",
      expect.anything(),
    );
  });

  it("my_agents returns children of a specific parent", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const parentResult = await spawn.handler(
      {
        repo: "orchestrator",
        cli: "claude",
      },
      {} as any,
    );
    const parentId = parentResult.structuredContent.agent_id;
    const actualParentId =
      engine.getAgentState(parentId)?.agent_id ??
      engine.stateMgr
        .listStates()
        .find((agent: AgentRecord) => agent.repo === "orchestrator")
        ?.agent_id ??
      parentId;

    await spawn.handler(
      {
        repo: "voicelayer",
        model: "sonnet",
        cli: "claude",
        parent_agent_id: actualParentId,
      },
      {} as any,
    );

    const result = await myAgents.handler(
      { parent_agent_id: actualParentId },
      {} as any,
    );
    const data = result.structuredContent;
    expect(data.count).toBe(1);
    expect(data.agents[0].repo).toBe("voicelayer");
    expect(data.parent_agent_id).toBe(actualParentId);
  });

  it("my_agents resolves finalized parents through their pending aliases", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const pendingParentId = "orchestratorClaude-pending-test";
    const parentRecord: AgentRecord = {
      agent_id: pendingParentId,
      surface_id: "surface:parent",
      workspace_id: "workspace:1",
      state: "ready",
      repo: "orchestrator",
      model: "opus",
      cli: "claude",
      cli_session_id: null,
      cli_session_path: null,
      launcher_name: "orchestratorClaude",
      task_summary: "orchestrate",
      pid: null,
      version: 1,
      created_at: "2026-06-25T00:00:00.000Z",
      updated_at: "2026-06-25T00:00:00.000Z",
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
    engine.stateMgr.writeState(parentRecord);
    engine.getRegistry().set(pendingParentId, parentRecord);
    const actualParentId = pendingParentId;
    const finalParentId = "orchestratorClaude-session1";
    const renamed = engine.stateMgr.renameState(actualParentId, finalParentId);
    engine.getRegistry().rename(actualParentId, finalParentId, renamed);

    await spawn.handler(
      {
        repo: "voicelayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix",
        parent_agent_id: pendingParentId,
      },
      {} as any,
    );

    const result = await myAgents.handler(
      { parent_agent_id: pendingParentId },
      {} as any,
    );
    const data = result.structuredContent;
    expect(data.count).toBe(1);
    expect(data.agents[0].repo).toBe("voicelayer");
    expect(data.parent_agent_id).toBe(pendingParentId);
  });

  it("my_agents returns empty array for nonexistent parent (orphan-safe)", async () => {
    const server = createLifecycleServer(mockExec);
    const myAgents = (server as any)._registeredTools["my_agents"];

    const result = await myAgents.handler(
      { parent_agent_id: "nonexistent-id" },
      {} as any,
    );
    const data = result.structuredContent;
    expect(data.count).toBe(0);
    expect(data.agents).toHaveLength(0);
  });

  it("my_agents includes screen data fields (null when no real screen)", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];

    await spawn.handler(
      { repo: "golems", cli: "claude", prompt: "audit" },
      {} as any,
    );

    const result = await myAgents.handler({}, {} as any);
    const agent = result.structuredContent.agents[0];
    expect(agent).toHaveProperty("token_count");
    expect(agent).toHaveProperty("context_pct");
    expect(agent).toHaveProperty("cost");
    expect(agent).toHaveProperty("spawn_depth");
    expect(agent).toHaveProperty("created_at");
    expect(agent).toHaveProperty("quality");
  });

  it("my_agents marks a row when screen data is unavailable", async () => {
    const readError = new Error("screen read timed out");
    mockExec = vi.fn().mockImplementation(async (_cmd, args: string[]) => {
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
            workspaces: [{ ref: "workspace:1", title: "Main", selected: true }],
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
                surface_refs: ["surface:screen-fail"],
                selected_surface_ref: "surface:screen-fail",
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
                ref: "surface:screen-fail",
                title: "screen fail",
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
        throw readError;
      }
      return { stdout: "{}", stderr: "" };
    });
    const server = createLifecycleServer(mockExec);
    const engine = testLifecycleEngine(server);
    const record: AgentRecord = {
      agent_id: "screenFailClaude-session1",
      surface_id: "surface:screen-fail",
      surface_observer_id: "cmux:/tmp/cmuxlayer-test.sock",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      model: "opus",
      cli: "claude",
      cli_session_id: null,
      cli_session_path: null,
      launcher_name: "cmuxlayerClaude",
      task_summary: "screen unavailable",
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
      boot_prompt_pending: false,
      launch_cwd: null,
      mcp_profile: null,
      worktree_path: null,
      worktree_branch: null,
    };
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(record.agent_id, record);
    const myAgents = registeredTestTool(server, "my_agents");

    const result = await myAgents.handler({}, {});
    const data = parseToolResult(result);
    const agents = data.agents as Array<Record<string, unknown>>;

    expect(data.ok).toBe(true);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agent_id: record.agent_id,
      screen_unavailable: true,
      error_code: "screen_unavailable",
      screen_error: "screen read timed out",
      token_count: null,
      context_pct: null,
      cost: null,
    });
  });

  it("my_agents includes resume_command when a session id is captured", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const myAgents = (server as any)._registeredTools["my_agents"];
    const engine = (server as any)._registeredTools["interact"]._engine;

    const spawnResult = await spawn.handler(
      { repo: "voicelayer", cli: "claude", prompt: "fix tts" },
      {} as any,
    );
    const agentId = spawnResult.structuredContent.agent_id;
    const stateMgr = engine["stateMgr"];
    const currentAgentId = resolveCurrentTestAgentId(stateMgr, agentId);
    const updated = stateMgr.updateRecord(currentAgentId, {
      cli_session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      launcher_name: "voicelayerClaude",
    });
    engine.getRegistry().set(currentAgentId, updated);

    const result = await myAgents.handler({}, {} as any);
    const agent = result.structuredContent.agents[0];

    expect(agent).toMatchObject({
      session_id: "019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
      resume_command:
        "voicelayerClaude -s --resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
    });
  });
});

describe("auto-focus discipline (focus target before split, restore after render)", () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  // Builds an exec mock that records every call, reports `selectedWorkspace` as
  // the focused one, and returns a non-ready screen for the first `notReadyFor`
  // read-screen polls before reporting ready.
  function makeFocusExec(opts: {
    selectedWorkspace: string;
    focusedSurface?: string;
    notReadyFor?: number;
    moveFocusDuringReadinessTo?: {
      workspace: string;
      surface: string;
    };
    focusSurfaceFails?: boolean;
  }): { exec: ExecFn; calls: string[][]; readScreenCount: () => number } {
    const calls: string[][] = [];
    let readScreens = 0;
    let focusedWorkspace = opts.selectedWorkspace;
    let focusedSurface = opts.focusedSurface ?? "surface:origin";
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes("list-workspaces")) {
        return {
          stdout: JSON.stringify({
            workspaces: [
              {
                ref: "workspace:1",
                title: "One",
                index: 0,
                selected: focusedWorkspace === "workspace:1",
                pinned: false,
              },
              {
                ref: "workspace:2",
                title: "Two",
                index: 1,
                selected: focusedWorkspace === "workspace:2",
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("identify")) {
        return {
          stdout: JSON.stringify({
            caller: {
              workspace_ref: focusedWorkspace,
              surface_ref: focusedSurface,
              pane_ref: "pane:origin",
            },
            focused: {
              workspace_ref: focusedWorkspace,
              surface_ref: focusedSurface,
              pane_ref: "pane:origin",
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("read-screen")) {
        readScreens++;
        const notReady = (opts.notReadyFor ?? 0) >= readScreens;
        if (opts.moveFocusDuringReadinessTo) {
          focusedWorkspace = opts.moveFocusDuringReadinessTo.workspace;
          focusedSurface = opts.moveFocusDuringReadinessTo.surface;
        }
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: notReady
              ? "still booting up please wait"
              : "What can I help you with?\n>",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      if (args.includes("select-workspace")) {
        focusedWorkspace = args[args.indexOf("--workspace") + 1];
        focusedSurface =
          focusedWorkspace === "workspace:1"
            ? "surface:origin"
            : "surface:target";
      }
      if (args.includes("rpc") && args.includes("surface.focus")) {
        if (opts.focusSurfaceFails) throw new Error("focus restore failed");
        const payload = JSON.parse(args.at(-1) ?? "{}") as {
          surface_id?: string;
          workspace_id?: string;
        };
        focusedWorkspace = payload.workspace_id ?? focusedWorkspace;
        focusedSurface = payload.surface_id ?? focusedSurface;
        return { stdout: "{}", stderr: "" };
      }
      // Default: split/surface creation result.
      return {
        stdout: JSON.stringify({
          workspace: "workspace:2",
          surface: "surface:new",
          pane: "pane:1",
          title: "",
          type: "terminal",
        }),
        stderr: "",
      };
    }) as unknown as ExecFn;
    return { exec, calls, readScreenCount: () => readScreens };
  }

  const selectIdx = (calls: string[][], ws: string) =>
    calls.findIndex((a) => a.includes("select-workspace") && a.includes(ws));
  const focusSurfaceIdx = (calls: string[][], surface: string) =>
    calls.findIndex(
      (a) =>
        a.includes("rpc") &&
        a.includes("surface.focus") &&
        a.some((value) => value.includes(surface)),
    );
  const firstReadScreenIdx = (calls: string[][]) =>
    calls.findIndex((a) => a.includes("read-screen"));
  const lastReadScreenIdx = (calls: string[][]) =>
    calls.reduce((last, a, i) => (a.includes("read-screen") ? i : last), -1);

  function makeFocusLifecycleExec(opts?: {
    selectedWorkspace?: string;
    focusedSurface?: string;
    roleTopology?: boolean;
    focusGatesCreatedSurfaceReadiness?: boolean;
    moveFocusDuringReadinessTo?: {
      workspace: string;
      surface: string;
    };
    focusSurfaceFails?: boolean;
    focusCreatedSurfaceFails?: boolean;
    failFocusObservationAfterCreation?: boolean;
  }): { exec: ExecFn; calls: string[][] } {
    const calls: string[][] = [];
    const lifecycleExec = makeLifecycleExec();
    let focusedWorkspace = opts?.selectedWorkspace ?? "workspace:1";
    let focusedSurface = opts?.focusedSurface ?? "surface:origin";
    let spawnCreated = false;
    let createdSurfaceReadStarted = false;
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes("list-windows")) {
        return {
          stdout: JSON.stringify({
            windows: [{ ref: "window:1", workspace_count: 2 }],
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
                selected: focusedWorkspace === "workspace:1",
                pinned: false,
              },
              {
                ref: "workspace:2",
                title: "Review team",
                index: 1,
                selected: focusedWorkspace === "workspace:2",
                pinned: false,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args.includes("identify")) {
        if (
          opts?.failFocusObservationAfterCreation &&
          spawnCreated &&
          !createdSurfaceReadStarted
        ) {
          throw new Error("transient post-creation identify failure");
        }
        return {
          stdout: JSON.stringify({
            caller: {
              workspace_ref: focusedWorkspace,
              surface_ref: focusedSurface,
              pane_ref: "pane:origin",
            },
            focused: {
              workspace_ref: focusedWorkspace,
              surface_ref: focusedSurface,
              pane_ref: "pane:origin",
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("rpc") && args.includes("surface.focus")) {
        const payload = JSON.parse(args.at(-1) ?? "{}") as {
          surface_id?: string;
          workspace_id?: string;
        };
        if (
          (opts?.focusSurfaceFails && payload.surface_id !== "surface:new") ||
          (opts?.focusCreatedSurfaceFails &&
            payload.surface_id === "surface:new")
        ) {
          throw new Error(
            payload.surface_id === "surface:new"
              ? "created surface focus failed"
              : "focus restore failed",
          );
        }
        focusedWorkspace = payload.workspace_id ?? focusedWorkspace;
        focusedSurface = payload.surface_id ?? focusedSurface;
        return { stdout: "{}", stderr: "" };
      }
      if (args.includes("select-workspace")) {
        focusedWorkspace = args[args.indexOf("--workspace") + 1];
        focusedSurface =
          focusedWorkspace === "workspace:1"
            ? "surface:origin"
            : "surface:target";
      }
      if (args.includes("create-workspace")) {
        focusedWorkspace = "workspace:2";
        focusedSurface = "surface:target";
        return {
          stdout: JSON.stringify({
            workspace: "workspace:2",
            title: "Review team",
          }),
          stderr: "",
        };
      }
      if (
        opts?.failFocusObservationAfterCreation &&
        spawnCreated &&
        !createdSurfaceReadStarted &&
        args.includes("list-workspaces")
      ) {
        throw new Error("transient post-creation workspace-list failure");
      }
      if (opts?.roleTopology && args.includes("list-panes")) {
        return {
          stdout: JSON.stringify({
            workspace_ref: "workspace:1",
            window_ref: "window:1",
            panes: [
              {
                ref: "pane:lead",
                index: 0,
                focused:
                  focusedSurface === "surface:lead" ||
                  focusedSurface === "surface:new",
                surface_count: spawnCreated ? 2 : 1,
                surface_refs: [
                  "surface:lead",
                  ...(spawnCreated ? ["surface:new"] : []),
                ],
                selected_surface_ref: spawnCreated
                  ? "surface:new"
                  : "surface:lead",
                pixel_frame: { x: 0, y: 0, width: 800, height: 900 },
              },
              {
                ref: "pane:worker",
                index: 1,
                focused: focusedSurface === "surface:worker",
                surface_count: 1,
                surface_refs: ["surface:worker"],
                selected_surface_ref: "surface:worker",
                pixel_frame: { x: 800, y: 0, width: 800, height: 900 },
              },
            ],
          }),
          stderr: "",
        };
      }
      if (opts?.roleTopology && args.includes("list-pane-surfaces")) {
        const pane = args[args.indexOf("--pane") + 1];
        const surfaces =
          pane === "pane:worker"
            ? [
                {
                  ref: "surface:worker",
                  title: "cmuxlayerCodex",
                  type: "terminal",
                  index: 0,
                  selected: true,
                },
              ]
            : [
                {
                  ref: "surface:lead",
                  title: "cmuxlayerClaude",
                  type: "terminal",
                  index: 0,
                  selected: !spawnCreated,
                },
                ...(spawnCreated
                  ? [
                      {
                        ref: "surface:new",
                        title: "cmuxlayerClaude [surface:new]",
                        type: "terminal",
                        index: 1,
                        selected: true,
                      },
                    ]
                  : []),
              ];
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
      if (
        spawnCreated &&
        args.includes("read-screen") &&
        args.includes("surface:new")
      ) {
        createdSurfaceReadStarted = true;
      }
      if (
        spawnCreated &&
        opts?.focusGatesCreatedSurfaceReadiness &&
        args.includes("read-screen") &&
        args.includes("surface:new") &&
        focusedSurface !== "surface:new"
      ) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: "terminal initializing",
            lines: 20,
            scrollback_used: false,
          }),
          stderr: "",
        };
      }
      const result = await lifecycleExec(cmd, args);
      if (args.includes("new-split") || args.includes("new-surface")) {
        spawnCreated = true;
        return {
          ...result,
          stdout: JSON.stringify({
            ...(JSON.parse(result.stdout) as Record<string, unknown>),
            workspace: focusedWorkspace,
          }),
        };
      }
      if (
        spawnCreated &&
        args.includes("read-screen") &&
        opts?.moveFocusDuringReadinessTo
      ) {
        focusedWorkspace = opts.moveFocusDuringReadinessTo.workspace;
        focusedSurface = opts.moveFocusDuringReadinessTo.surface;
      }
      return result;
    }) as unknown as ExecFn;
    return { exec, calls };
  }

  it("new_split restores the prior surface after a cross-workspace spawn", async () => {
    const { exec, calls } = makeFocusExec({ selectedWorkspace: "workspace:1" });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", workspace: "workspace:2", type: "terminal" },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.surface).toBe("surface:new");

    const focusTarget = selectIdx(calls, "workspace:2");
    const restorePrior = focusSurfaceIdx(calls, "surface:origin");
    const readScreen = firstReadScreenIdx(calls);

    // Target was focused BEFORE the prior focus was restored.
    expect(focusTarget).toBeGreaterThanOrEqual(0);
    expect(restorePrior).toBeGreaterThan(focusTarget);
    // Readiness was awaited between the split and the focus-back.
    expect(readScreen).toBeGreaterThan(focusTarget);
    expect(readScreen).toBeLessThan(restorePrior);
    // Restoring only the workspace can land on a different pane/tab.
    expect(selectIdx(calls, "workspace:1")).toBe(-1);
  });

  it("new_split restores the prior surface after a same-workspace spawn", async () => {
    const { exec, calls } = makeFocusExec({ selectedWorkspace: "workspace:2" });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    await tool.handler(
      { direction: "right", workspace: "workspace:2", type: "terminal" },
      {} as any,
    );

    const selectCalls = calls.filter((a) => a.includes("select-workspace"));
    expect(selectCalls).toHaveLength(0);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBeGreaterThanOrEqual(0);
  });

  it("spawn_agent restores the prior surface after a same-workspace spawn", async () => {
    const { exec, calls } = makeFocusLifecycleExec();
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        workspace: "workspace:1",
        force_new: true,
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBeGreaterThanOrEqual(0);
  });

  it("spawn_agent restores the prior surface after a cross-workspace spawn", async () => {
    const { exec, calls } = makeFocusLifecycleExec();
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        workspace: "workspace:2",
        force_new: true,
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(selectIdx(calls, "workspace:2")).toBeGreaterThanOrEqual(0);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBeGreaterThanOrEqual(0);
  });

  it.each([
    {
      name: "orchestrator tab while the worker pane holds focus",
      placement: "orchestrator" as const,
      cli: "claude" as const,
      origin: "surface:worker",
    },
    {
      name: "orchestrator tab while the lead pane holds focus",
      placement: "orchestrator" as const,
      cli: "claude" as const,
      origin: "surface:lead",
    },
    {
      name: "worker tab while the lead pane holds focus",
      placement: "worker" as const,
      cli: "codex" as const,
      origin: "surface:lead",
    },
  ])(
    "spawn_agent boots a $name, then restores the exact origin",
    async ({ placement, cli, origin }) => {
      vi.useFakeTimers();
      try {
        const { exec, calls } = makeFocusLifecycleExec({
          focusedSurface: origin,
          roleTopology: true,
          focusGatesCreatedSurfaceReadiness: true,
        });
        const server = createLifecycleServer(exec);
        const tool = (server as any)._registeredTools["spawn_agent"];

        const resultPromise = tool.handler(
          {
            repo: "cmuxlayer",
            cli,
            placement,
            workspace: "workspace:1",
            force_new: true,
            boot_prompt_timeout_ms: 20,
          },
          {} as any,
        );
        await vi.advanceTimersByTimeAsync(100);
        const result = await resultPromise;

        expect(result.structuredContent.ok).toBe(true);
        expect(result.structuredContent.surface_id).toBe("surface:new");
        const created = calls.findIndex((args) => args.includes("new-surface"));
        const focusedCreated = focusSurfaceIdx(calls, "surface:new");
        const firstCreatedRead = calls.findIndex(
          (args, index) =>
            index > created &&
            args.includes("read-screen") &&
            args.includes("surface:new"),
        );
        const restoredOrigin = focusSurfaceIdx(calls, origin);

        expect(created).toBeGreaterThanOrEqual(0);
        expect(focusedCreated).toBeGreaterThan(created);
        expect(firstCreatedRead).toBeGreaterThan(focusedCreated);
        expect(restoredOrigin).toBeGreaterThan(firstCreatedRead);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("spawn_agent with focus=true boots on and leaves focus on the created tab", async () => {
    vi.useFakeTimers();
    try {
      const { exec, calls } = makeFocusLifecycleExec({
        focusedSurface: "surface:worker",
        roleTopology: true,
        focusGatesCreatedSurfaceReadiness: true,
      });
      const server = createLifecycleServer(exec);
      const tool = (server as any)._registeredTools["spawn_agent"];
      const args = tool.inputSchema.parse({
        repo: "cmuxlayer",
        cli: "claude",
        role: "implementor",
        placement: "orchestrator",
        workspace: "workspace:1",
        force_new: true,
        focus: true,
        boot_prompt_timeout_ms: 20,
      });

      const resultPromise = tool.handler(args, {} as any);
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.structuredContent.ok).toBe(true);
      expect(focusSurfaceIdx(calls, "surface:new")).toBeGreaterThanOrEqual(0);
      expect(focusSurfaceIdx(calls, "surface:worker")).toBe(-1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent restores the exact origin without re-observing post-creation focus", async () => {
    vi.useFakeTimers();
    try {
      const { exec, calls } = makeFocusLifecycleExec({
        focusedSurface: "surface:worker",
        roleTopology: true,
        focusGatesCreatedSurfaceReadiness: true,
        failFocusObservationAfterCreation: true,
      });
      const server = createLifecycleServer(exec);
      const tool = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = tool.handler(
        {
          repo: "cmuxlayer",
          cli: "claude",
          placement: "orchestrator",
          workspace: "workspace:1",
          force_new: true,
          boot_prompt_timeout_ms: 20,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.structuredContent.ok).toBe(true);
      expect(focusSurfaceIdx(calls, "surface:worker")).toBeGreaterThan(
        firstReadScreenIdx(calls),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent fails fast with the created identity when the tab cannot be focused", async () => {
    vi.useFakeTimers();
    try {
      const { exec } = makeFocusLifecycleExec({
        focusedSurface: "surface:worker",
        roleTopology: true,
        focusGatesCreatedSurfaceReadiness: true,
        focusCreatedSurfaceFails: true,
      });
      const server = createLifecycleServer(exec);
      const tool = (server as any)._registeredTools["spawn_agent"];

      const resultPromise = tool.handler(
        {
          repo: "cmuxlayer",
          cli: "claude",
          placement: "orchestrator",
          workspace: "workspace:1",
          force_new: true,
          boot_prompt_timeout_ms: 20,
        },
        {} as any,
      );
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result.structuredContent.ok).toBe(false);
      expect(result.structuredContent.error).toMatch(/focus.*surface:new/i);
      expect(result.structuredContent.agent_id).toEqual(expect.any(String));
      expect(result.structuredContent.surface_id).toBe("surface:new");
      expect(result.structuredContent.error).not.toMatch(
        /readiness|timed out/i,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("new_worktree_split restores the prior surface after a cross-workspace spawn", async () => {
    const { exec, calls } = makeFocusLifecycleExec();
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_worktree_split"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        model: "codex",
        workspace: "workspace:2",
        worktree: false,
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(selectIdx(calls, "workspace:2")).toBeGreaterThanOrEqual(0);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBeGreaterThanOrEqual(0);
  });

  it("spawn_in_workspace restores the prior surface after a cross-workspace spawn", async () => {
    const { exec, calls } = makeFocusLifecycleExec();
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_in_workspace"];

    const result = await tool.handler(
      {
        workspace_title: "Review team",
        reuse_workspace: "workspace:2",
        agents: [
          {
            repo: "cmuxlayer",
            cli: "codex",
            model: "codex",
            role: "worker",
          },
        ],
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(selectIdx(calls, "workspace:2")).toBeGreaterThanOrEqual(0);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBeGreaterThanOrEqual(0);
  });

  it("spawn_in_workspace captures the origin before a new workspace auto-focuses", async () => {
    const { exec, calls } = makeFocusLifecycleExec();
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_in_workspace"];

    const result = await tool.handler(
      {
        workspace_title: "Review team",
        agents: [
          {
            repo: "cmuxlayer",
            cli: "codex",
            model: "codex",
            role: "worker",
          },
        ],
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBeGreaterThanOrEqual(0);
  });

  it("spawn_agent keeps its success response when focus restoration fails", async () => {
    const { exec } = makeFocusLifecycleExec({ focusSurfaceFails: true });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        workspace: "workspace:1",
        force_new: true,
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.agent_id).toEqual(expect.any(String));
    expect(result.structuredContent.surface_id).toBe("surface:new");
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/focus restore failed/i)]),
    );
  });

  it("new_split keeps its success response when focus restoration fails", async () => {
    const { exec } = makeFocusExec({
      selectedWorkspace: "workspace:1",
      focusSurfaceFails: true,
    });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", workspace: "workspace:2", type: "terminal" },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(result.structuredContent.surface).toBe("surface:new");
    expect(result.structuredContent.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/focus restore failed/i)]),
    );
  });

  it("new_split does not steal focus back after the user moves during readiness", async () => {
    const { exec, calls } = makeFocusExec({
      selectedWorkspace: "workspace:1",
      moveFocusDuringReadinessTo: {
        workspace: "workspace:1",
        surface: "surface:user-choice",
      },
    });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    const result = await tool.handler(
      { direction: "right", workspace: "workspace:2", type: "terminal" },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBe(-1);
  });

  it("spawn_agent does not steal focus back after the user moves during readiness", async () => {
    const { exec, calls } = makeFocusLifecycleExec({
      moveFocusDuringReadinessTo: {
        workspace: "workspace:1",
        surface: "surface:user-choice",
      },
    });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        workspace: "workspace:1",
        force_new: true,
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBe(-1);
  });

  it("new_worktree_split does not steal focus back after the user moves during readiness", async () => {
    const { exec, calls } = makeFocusLifecycleExec({
      moveFocusDuringReadinessTo: {
        workspace: "workspace:1",
        surface: "surface:user-choice",
      },
    });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_worktree_split"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        model: "codex",
        workspace: "workspace:2",
        worktree: false,
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBe(-1);
  });

  it("spawn_in_workspace does not steal focus back after the user moves during readiness", async () => {
    const { exec, calls } = makeFocusLifecycleExec({
      moveFocusDuringReadinessTo: {
        workspace: "workspace:1",
        surface: "surface:user-choice",
      },
    });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_in_workspace"];

    const result = await tool.handler(
      {
        workspace_title: "Review team",
        reuse_workspace: "workspace:2",
        agents: [
          {
            repo: "cmuxlayer",
            cli: "codex",
            model: "codex",
            role: "worker",
          },
        ],
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(true);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBe(-1);
  });

  it("spawn_agent restores the prior surface when pane creation fails", async () => {
    const calls: string[][] = [];
    const lifecycleExec = makeLifecycleExec();
    const exec = vi.fn(async (cmd: string, args: string[]) => {
      calls.push(args);
      if (args.includes("identify")) {
        return {
          stdout: JSON.stringify({
            caller: {
              workspace_ref: "workspace:1",
              surface_ref: "surface:origin",
              pane_ref: "pane:origin",
            },
            focused: {
              workspace_ref: "workspace:1",
              surface_ref: "surface:origin",
              pane_ref: "pane:origin",
            },
          }),
          stderr: "",
        };
      }
      if (args.includes("new-split") || args.includes("new-surface")) {
        throw new Error("pane creation failed");
      }
      return lifecycleExec(cmd, args);
    }) as unknown as ExecFn;
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["spawn_agent"];

    const result = await tool.handler(
      {
        repo: "cmuxlayer",
        cli: "codex",
        workspace: "workspace:2",
        force_new: true,
      },
      {} as any,
    );

    expect(result.structuredContent.ok).toBe(false);
    expect(result.structuredContent.error).toContain("pane creation failed");
    expect(focusSurfaceIdx(calls, "surface:origin")).toBeGreaterThanOrEqual(0);
  });

  it("new_split with focus=true explicitly focuses and stays on the new surface", async () => {
    const { exec, calls } = makeFocusExec({ selectedWorkspace: "workspace:1" });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    await tool.handler(
      {
        direction: "right",
        workspace: "workspace:2",
        type: "terminal",
        focus: true,
      },
      {} as any,
    );

    expect(selectIdx(calls, "workspace:2")).toBeGreaterThanOrEqual(0);
    expect(focusSurfaceIdx(calls, "surface:new")).toBeGreaterThanOrEqual(0);
    expect(focusSurfaceIdx(calls, "surface:origin")).toBe(-1);
    expect(selectIdx(calls, "workspace:1")).toBe(-1);
  });

  it("new_split waits for the new terminal to render before restoring focus", async () => {
    const { exec, calls, readScreenCount } = makeFocusExec({
      selectedWorkspace: "workspace:1",
      notReadyFor: 2,
    });
    const server = createLifecycleServer(exec);
    const tool = (server as any)._registeredTools["new_split"];

    await tool.handler(
      { direction: "right", workspace: "workspace:2", type: "terminal" },
      {} as any,
    );

    // Polled until ready (2 not-ready + 1 ready) and only then restored focus.
    expect(readScreenCount()).toBeGreaterThanOrEqual(3);
    const restorePrior = focusSurfaceIdx(calls, "surface:origin");
    expect(restorePrior).toBeGreaterThan(lastReadScreenIdx(calls));
  });
});

// AIDEV-NOTE (P11 / lane brief): the S3 regression test is the non-negotiable
// test of this lane. It reproduces the 2026-08-17 deadlock mechanically: a lead
// brief that names one report path while the engine issued another. Before P11
// the prose heuristic won and the consumer verified the WRONG file.
describe("P11 engine-issued coordination paths", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  it("S3 REGRESSION: engine-issued contract beats a brief naming a different path", async () => {
    const goalPath = join(TEST_DIR, "p11-s3-goal.md");
    const briefReportPath = join(TEST_DIR, "p11-brief-invented-report.md");
    const engineReportPath = join(TEST_DIR, "p11-engine-issued-report.md");

    // The lead's brief invents its own path + marker, exactly as briefs do today.
    writeFileSync(
      goalPath,
      [
        "# Lane brief",
        "",
        "Write the report to:",
        "",
        `\`${briefReportPath}\``,
        "",
        "The final report line must be exactly:",
        "",
        "`DONE_BRIEF_INVENTED`",
        "",
      ].join("\n"),
      "utf8",
    );
    // The worker honored the ENGINE-issued contract it was told at boot.
    writeFileSync(engineReportPath, "Status: COMPLETE\nDONE_P11_S3\n", "utf8");

    const server = createLifecycleServer(makeLifecycleExec());
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-p11-s3";
    const record = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
      report_path: engineReportPath,
      done_marker: "DONE_P11_S3",
    });
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(agentId, record);

    const parsed = parseToolResult(
      await getState.handler({ agent_id: agentId }, {}),
    );
    // The engine-issued pair wins; the brief's invented pair is ignored.
    expect(parsed.harvestability).toMatchObject({
      report_path: engineReportPath,
      done_marker: "DONE_P11_S3",
      closure_artifact_verified: true,
      closure: "verified",
    });
    expect(
      (parsed.harvestability as { report_path: string }).report_path,
    ).not.toBe(briefReportPath);
  });

  it("FINDING 1: supersede_agent_goal clears the issued pair so the NEW brief wins", async () => {
    // supersede is the one contract channel that actually reaches the worker --
    // it delivers `/goal Read and execute this goal file` to the pane. If the
    // consumer kept verifying the ORIGINALLY issued path, a superseded worker
    // would render artifact_missing forever: the S3 disagreement re-created
    // through the door that used to work.
    const goalPath = join(TEST_DIR, "p11-supersede-goal.md");
    const supersededReportPath = join(TEST_DIR, "p11-supersede-report.md");
    writeFileSync(
      goalPath,
      [
        "# Superseding brief",
        "",
        "Write the report to:",
        "",
        `\`${supersededReportPath}\``,
        "",
        "Final line:",
        "",
        "`DONE_P11_SUPERSEDED`",
        "",
      ].join("\n"),
      "utf8",
    );

    const server = createLifecycleServer(makeLifecycleExec());
    const spawn = registeredTestTool(server, "spawn_agent");
    const supersede = registeredTestTool(server, "supersede_agent_goal");
    const getState = registeredTestTool(server, "get_agent_state");

    const spawned = parseToolResult(
      await spawn.handler(
        { repo: "brainlayer", model: "gpt-5.5", cli: "codex", role: "worker" },
        {},
      ),
    );
    const agentId = spawned.agent_id as string;
    // Spawned after P11, so it carries an engine-issued pair.
    expect(spawned.report_path).toBeTruthy();

    const engine = testLifecycleEngine(server);
    const registry = engine.getRegistry();
    registry.set(agentId, engine.stateMgr.transition(agentId, "ready"));
    registry.set(agentId, engine.stateMgr.transition(agentId, "working"));

    const superseded = parseToolResult(
      await supersede.handler({ agent_id: agentId, goal_file: goalPath }, {}),
    );
    expect(superseded.ok).toBe(true);

    // The record must stop pinning the now-stale issued pair.
    const after = engine.getAgentState(agentId);
    expect(after?.report_path ?? null).toBeNull();
    expect(after?.done_marker ?? null).toBeNull();

    // And the consumer verifies against the brief the worker actually got.
    writeFileSync(
      supersededReportPath,
      "Status: COMPLETE\nDONE_P11_SUPERSEDED\n",
      "utf8",
    );
    registry.set(agentId, engine.stateMgr.transition(agentId, "done"));
    const parsed = parseToolResult(
      await getState.handler({ agent_id: agentId }, {}),
    );
    expect(parsed.harvestability).toMatchObject({
      report_path: supersededReportPath,
      done_marker: "DONE_P11_SUPERSEDED",
    });
  });

  it("falls back to the prose heuristic for legacy records with no engine-issued contract", async () => {
    const goalPath = join(TEST_DIR, "p11-legacy-goal.md");
    const reportPath = join(TEST_DIR, "p11-legacy-report.md");
    writeFileSync(
      goalPath,
      [
        "# Legacy brief",
        "",
        "Write the report to:",
        "",
        `\`${reportPath}\``,
        "",
        "Final line:",
        "",
        "`DONE_LEGACY_PROSE`",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(reportPath, "Status: COMPLETE\nDONE_LEGACY_PROSE\n", "utf8");

    const server = createLifecycleServer(makeLifecycleExec());
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-p11-legacy";
    const record = makeServerAgentRecord({
      agent_id: agentId,
      goal_file: goalPath,
    });
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(agentId, record);

    const parsed = parseToolResult(
      await getState.handler({ agent_id: agentId }, {}),
    );
    expect(parsed.harvestability).toMatchObject({
      report_path: reportPath,
      done_marker: "DONE_LEGACY_PROSE",
      closure_artifact_verified: true,
      closure: "verified",
    });
  });

  it("done child with no written report reads artifact_missing, not pending", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const getState = registeredTestTool(server, "get_agent_state");
    const engine = testLifecycleEngine(server);
    const agentId = "codex-golems-p11-deadlocked";
    const record = makeServerAgentRecord({
      agent_id: agentId,
      state: "done",
      report_path: join(TEST_DIR, "p11-never-written.md"),
      done_marker: "DONE_P11_DEADLOCK",
    });
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(agentId, record);

    const parsed = parseToolResult(
      await getState.handler({ agent_id: agentId }, {}),
    );
    expect(parsed.harvestability).toMatchObject({
      closure: "artifact_missing",
      closure_artifact_verified: false,
    });
    expect(
      (parsed.harvestability as { issue_codes: string[] }).issue_codes,
    ).toContain("report_missing");
  });
});

// AIDEV-NOTE (P11 Constraint 3): skillcreator's falsifier, from the #727 lane.
// An implementor sat DONE with an open PR and no marker while its lead waited
// on that marker. Under a bare boolean that pane and a busy pane were BOTH
// `false`. These tests pin that they are distinguishable at DEFAULT detail.
describe("P11 closure state at default list_agents detail", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  async function listDefault(server: unknown) {
    const list = registeredTestTool(server, "list_agents");
    const parsed = parseToolResult(await list.handler({}, {}));
    return (parsed.agents ?? []) as Array<Record<string, unknown>>;
  }

  it("a deadlocked child and a working child are DISTINGUISHABLE without detail:full", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const engine = testLifecycleEngine(server);

    const deadlocked = makeServerAgentRecord({
      agent_id: "codex-golems-p11-done-no-artifact",
      state: "done",
      report_path: join(TEST_DIR, "p11-list-never-written.md"),
      done_marker: "DONE_P11_LIST_DEADLOCK",
    });
    const working = makeServerAgentRecord({
      agent_id: "codex-golems-p11-still-working",
      state: "working",
      task_done_detected_at: null,
      report_path: join(TEST_DIR, "p11-list-working.md"),
      done_marker: "DONE_P11_LIST_WORKING",
    });
    for (const record of [deadlocked, working]) {
      engine.stateMgr.writeState(record);
      engine.getRegistry().set(record.agent_id, record);
    }

    const agents = await listDefault(server);
    const byId = new Map(agents.map((a) => [a.agent_id as string, a]));
    expect(byId.get(deadlocked.agent_id)?.closure).toBe("artifact_missing");
    expect(byId.get(working.agent_id)?.closure).toBe("pending");
    // The whole point of Constraint 3.
    expect(byId.get(deadlocked.agent_id)?.closure).not.toBe(
      byId.get(working.agent_id)?.closure,
    );
  });

  it("a child that wrote its report reads verified at default detail", async () => {
    const reportPath = join(TEST_DIR, "p11-list-verified.md");
    writeFileSync(reportPath, "Status: COMPLETE\nDONE_P11_LIST_OK\n", "utf8");
    const server = createLifecycleServer(makeLifecycleExec());
    const engine = testLifecycleEngine(server);
    const record = makeServerAgentRecord({
      agent_id: "codex-golems-p11-list-verified",
      state: "done",
      report_path: reportPath,
      done_marker: "DONE_P11_LIST_OK",
    });
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(record.agent_id, record);

    const agents = await listDefault(server);
    expect(agents.find((a) => a.agent_id === record.agent_id)?.closure).toBe(
      "verified",
    );
  });

  it("a stale report left by an earlier occupant is NOT read as this agent's closure", async () => {
    // The issued path is stable per agent_id, so a resumed/recycled id could
    // otherwise inherit an old report and read `verified` without doing work.
    const reportPath = join(TEST_DIR, "p11-list-stale.md");
    writeFileSync(
      reportPath,
      "Status: COMPLETE\nDONE_P11_LIST_STALE\n",
      "utf8",
    );
    const stale = new Date("2026-07-05T05:00:00.000Z");
    utimesSync(reportPath, stale, stale);

    const server = createLifecycleServer(makeLifecycleExec());
    const engine = testLifecycleEngine(server);
    const record = makeServerAgentRecord({
      agent_id: "codex-golems-p11-list-stale",
      state: "done",
      created_at: "2026-07-05T07:00:00.000Z",
      report_path: reportPath,
      done_marker: "DONE_P11_LIST_STALE",
    });
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(record.agent_id, record);

    const agents = await listDefault(server);
    expect(agents.find((a) => a.agent_id === record.agent_id)?.closure).toBe(
      "artifact_missing",
    );
  });

  it("a contract-less spawn is not_applicable, never a falsey negative", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const engine = testLifecycleEngine(server);
    const record = makeServerAgentRecord({
      agent_id: "codex-golems-p11-no-contract",
      state: "done",
      goal_file: null,
    });
    engine.stateMgr.writeState(record);
    engine.getRegistry().set(record.agent_id, record);

    const agents = await listDefault(server);
    expect(agents.find((a) => a.agent_id === record.agent_id)?.closure).toBe(
      "not_applicable",
    );
  });
});
