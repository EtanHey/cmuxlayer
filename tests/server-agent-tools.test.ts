/**
 * Integration tests for the agent lifecycle MCP tools registered in server.ts.
 * Tests tool registration and handler dispatch with mocked cmux client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
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
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import {
  reconcileMonitorRegistry,
  registerMonitor,
} from "../src/monitor-registry.js";
import { SurfaceWriteLivenessTracker } from "../src/surface-write-liveness.js";
import { makeCodexRolloutFillProvider } from "../src/codex-rollout-fill.js";
import type { CodexRolloutFill } from "../src/codex-rollout-fill.js";
import {
  currentCallerContext,
  runWithCallerContext,
} from "../src/caller-context.js";

let TEST_DIR = join(tmpdir(), "cmux-agents-test-server-tools");
const serverContexts: CmuxServerContext[] = [];
const hermeticSpawnStateDirs: string[] = [];
let hermeticSpawnFixtureSequence = 0;
const originalLauncherRegistryPath =
  process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;

afterEach(async () => {
  if (originalLauncherRegistryPath === undefined) {
    delete process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
  } else {
    process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH =
      originalLauncherRegistryPath;
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
  shellNeverReady?: boolean;
  surfaceUuid?: string;
}): ExecFn {
  let readyText = "What can I help you with?\n>";
  let surfaceLive = true;
  let promptPending = false;
  let activeCli: "claude" | "codex" | "cursor" = "claude";
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
  const workingText = () => {
    if (activeCli === "codex") {
      return "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)";
    }
    if (activeCli === "cursor") {
      return "cursor> \nWorking (1s • esc to interrupt)";
    }
    return "Claude Code\n✻ Working\n";
  };
  return vi.fn().mockImplementation(async (_cmd, args) => {
    if (args.includes("new-split") || args.includes("new-surface")) {
      surfaceLive = true;
    }
    if (args.includes("close-surface") && !opts?.closeKeepsSurface) {
      surfaceLive = false;
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send-key") && args.includes("return")) {
      if (promptPending) {
        readyText = workingText();
        promptPending = false;
      }
      return { stdout: "{}", stderr: "" };
    }
    if (args.includes("send")) {
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
        !/[A-Za-z0-9_.-]+(?:Claude|Codex|Cursor|Gemini|Kiro)\b/.test(text)
      ) {
        promptPending = true;
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
          surface: "surface:new",
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
        surface: "surface:new",
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
          opts.client as {
            currentObserverTransportEpoch?: () => string | null;
          } | undefined
        )?.currentObserverTransportEpoch?.();
        return `${ownerId}@${transportEpoch || "test"}`;
      }),
  };
  const context = createServerContext(normalizedOpts);
  serverContexts.push(context);
  const server = createServer({ ...normalizedOpts, context });
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
      { repo: "cmuxlayer", model: "sonnet", cli: "claude" },
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

    expect(manifests[0]?.tab_name).toBe(
      "registeredClaude [surface:new]",
    );
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
      boot_prompt_delivered: false,
      boot_prompt_submit_verified: null,
    });
    expect(parsed).not.toHaveProperty("health");
    expect(parsed).not.toHaveProperty("model_policy");
    expect(parsed).not.toHaveProperty("retry_count");
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

  it("spawn_agent surfaces a real model coercion in lean mode", async () => {
    const server = createLifecycleServer(makeLifecycleExec());
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      { repo: "cmuxlayer", model: "gpt-5.5", cli: "codex" },
      {} as any,
    );

    expect(result.structuredContent.model_policy).toMatchObject({
      coerced: true,
      effective_model: "codex",
    });
    expect(result.structuredContent.warnings).not.toHaveLength(0);
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
      expect.arrayContaining(["send", "cmuxlayerCodex -s -E medium"]),
    );
  });

  it("spawn_agent schema advertises only the cross-version Codex effort set", () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    for (const effort of ["medium", "high", "xhigh", "ultra"]) {
      expect(
        spawn.inputSchema.safeParse({
          repo: "cmuxlayer",
          cli: "codex",
          effort,
        }).success,
      ).toBe(true);
    }

    for (const effort of ["low", "max", "turbo"]) {
      expect(
        spawn.inputSchema.safeParse({
          repo: "cmuxlayer",
          cli: "codex",
          effort,
        }).success,
      ).toBe(false);
    }
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
        effort: "low",
        worktree: {
          name: "incompatible-effort",
          branch: "wt/incompatible-effort",
        },
      },
      {} as any,
    );

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toContain(
      'Invalid Codex effort "low" (expected: medium, high, xhigh, ultra)',
    );
    expect(worktreeExec).not.toHaveBeenCalled();
    expect(
      (exec as any).mock.calls.some(([, args]: [string, string[]]) =>
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
      effort: "medium",
    });

    const result = await spawn.handler(args, {} as any);

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toContain(
      'Codex effort "medium" cannot be used with cli "claude"',
    );
    expect(
      mockExec.mock.calls.some(([, callArgs]) => callArgs.includes("new-split")),
    ).toBe(false);
  });

  it("spawn_agent rejects an unsupported model before creating a surface", async () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];

    const result = await spawn.handler(
      { repo: "cmuxlayer", cli: "claude", model: "fable-5" },
      {} as any,
    );

    expect(result.structuredContent).toMatchObject({ ok: false });
    expect(result.structuredContent.error).toContain(
      'Unsupported model "fable-5" for cli "claude"',
    );
    expect(result.structuredContent.error).toContain(
      'would actually run "claude-opus-5[1m]"',
    );
    expect(result.structuredContent.error).toContain(
      "Accepted models: claude-opus-5[1m], sonnet",
    );
    expect(
      mockExec.mock.calls.some(([, callArgs]) => callArgs.includes("new-split")),
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
      mockExec.mock.calls.some(([, callArgs]) => callArgs.includes("new-split")),
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
      mockExec.mock.calls.some(([, callArgs]) => callArgs.includes("new-split")),
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
  title?: string;
};

function makeUuidRouteClient(initialSurfaces: UuidRouteSurface[]) {
  let liveSurfaces = initialSurfaces;
  let screenText =
    "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\ncodex> ";
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
      workspaces: [...new Set(liveSurfaces.map((surface) => surface.workspace_ref))].map(
        (ref, index) => ({
          ref,
          title: ref,
          index,
          selected: index === 0,
          pinned: false,
        }),
      ),
    })),
    listPanes: vi.fn().mockImplementation(async (opts?: { workspace?: string }) => {
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
    listPaneSurfaces: vi.fn().mockImplementation(
      async (opts?: { workspace?: string; pane?: string }) => ({
        workspace_ref: opts?.workspace,
        window_ref: `window:${opts?.workspace ?? "1"}`,
        pane_ref: opts?.pane ?? `pane:${opts?.workspace ?? "1"}`,
        surfaces: surfacesForWorkspace(opts?.workspace).map((surface, index) => ({
          ...surface,
          title: surface.title ?? "cmuxlayerCodex",
          type: "terminal",
          index,
          selected: index === 0,
          pane_ref: opts?.pane ?? `pane:${opts?.workspace ?? "1"}`,
        })),
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
      liveSurfaces = liveSurfaces.filter((candidate) => candidate.ref !== surface);
    }),
    moveSurface: vi.fn().mockImplementation(async (opts: { surface: string }) => ({
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
  } = {},
): BroadcastMockClient {
  const submittedSurfaces = new Set<string>();
  const sendCalls: Array<{ surface: string; text: string; workspace?: string }> =
    [];
  const sendKeyCalls: Array<{
    surface: string;
    key: string;
    workspace?: string;
  }> = [];
  const workspaces = [
    ...new Set(records.map((record) => record.workspace_id ?? "workspace:1")),
  ];
  const recordsForWorkspace = (workspace?: string) =>
    records.filter((record) => (record.workspace_id ?? "workspace:1") === workspace);
  const screenFor = (surface: string): string => {
    const record = records.find((candidate) => candidate.surface_id === surface);
    if (submittedSurfaces.has(surface)) {
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
    return "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\ncodex> ";
  };

  const client = {
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
    listPaneSurfaces: vi.fn().mockImplementation(async ({ workspace, pane }) => {
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
            record.surface_id === (opts.callerSurface ?? process.env.CMUX_TAB_ID),
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
  handler(args: Record<string, unknown>, context: unknown): Promise<TestToolResult>;
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
  return registry[name]!;
}

function testLifecycleEngine(server: unknown): TestLifecycleEngine {
  const interact = registeredTestTool(server, "interact") as RegisteredTestTool & {
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

  it("total registered tool count is 42 after deleting reorder_surface", () => {
    const mockExec = makeLifecycleExec();
    const server = createLifecycleServer(mockExec);
    const registeredTools = (server as any)._registeredTools;
    expect(Object.keys(registeredTools)).toHaveLength(42);
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
          agent_id: "auto-codex-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
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
    expect(parsed.agent_id).toMatch(/^brainlayerClaude-pending-\d+-[a-z0-9]+$/);
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
      expect.arrayContaining([
        "list-status",
        "--workspace",
        "workspace:1",
      ]),
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
            modeReads === 1
              ? []
              : [{ key: "mode.control", value: "manual" }],
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
      send: vi.fn().mockResolvedValue(undefined),
      sendKey: vi.fn().mockResolvedValue(undefined),
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:inherit",
        text: "Codex\n>",
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
      const mockClient = {
        createWorkspace: vi.fn(),
        selectWorkspace: vi.fn().mockImplementation(async (workspace: string) => {
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
        send: vi.fn().mockResolvedValue(undefined),
        sendKey: vi.fn().mockResolvedValue(undefined),
        readScreen: vi.fn().mockResolvedValue({
          surface: "surface:caller",
          text: "Codex\n>",
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
                current_directory: "/Users/etanheyman/Gits/brainlayer",
              },
              {
                ref: "workspace:t3layer",
                title: "t3layer",
                selected: true,
                current_directory: "/Users/etanheyman/Gits/t3layer",
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
    expect(parsed.error).toMatch(/workspace.*t3layer.*brainlayer|brainlayer.*workspace.*t3layer/i);
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
                current_directory: "/Users/etanheyman",
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
    expect(parsed.role).toBe("worker");
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
    const first = firstResult.structuredContent ?? JSON.parse(firstResult.content[0].text);
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
      secondResult.structuredContent ?? JSON.parse(secondResult.content[0].text);

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
    const first = firstResult.structuredContent ?? JSON.parse(firstResult.content[0].text);
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
      secondResult.structuredContent ?? JSON.parse(secondResult.content[0].text);

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
      placement: "ic",
      prompt: "coordinate task",
    });
    const result = await tool.handler(args, {} as any);

    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.role).toBe("worker");
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
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        "fix prompt delivery",
      ]),
    );
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
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:moved",
        "UUID-bound boot prompt",
      ]),
    );
    expect(mockExec).not.toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        "UUID-bound boot prompt",
      ]),
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
      expect.arrayContaining([
        "send",
        "must not type in manual mode",
      ]),
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

    const promptSendCall = mockExec.mock.calls.find(([, args]) => {
      const argv = args as string[];
      return argv.includes("send") && argv.includes(prompt);
    });
    expect(promptSendCall).toBeDefined();
    const argv = promptSendCall![1] as string[];
    const workspaceIndex = argv.indexOf("--workspace");
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    expect(argv[workspaceIndex + 1]).toBe("workspace:1");
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
    const promptSendCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, args]) => {
        const argv = args as string[];
        return argv.includes("send") && argv.includes(prompt);
      },
    );
    expect(promptSendCall).toBeDefined();
    expect(promptSendCall![1]).toEqual(
      expect.arrayContaining(["--workspace", "workspace:1"]),
    );
  });

  it("spawn_agent deliberately allowed inline prompts preserve blank lines without empty chunks", async () => {
    const baseExec = makeLifecycleExec();
    const prompt = `${"a".repeat(500)}\n\n${"b".repeat(600)}`;
    const buffers = new Map<string, string>();
    let promptPasted = false;
    let promptSubmitted = false;
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
      if (args.includes("read-screen") && promptSubmitted) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text: "gpt-5.5 xhigh · 99% left · ~/Gits/cmuxlayer\nWorking (1s • esc to interrupt)",
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
      chunks.every(
        (chunk) => Buffer.byteLength(chunk, "utf-8") <= 16_000,
      ),
    ).toBe(true);
    expect(chunks.join("")).toBe(prompt);
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
        args.includes("send") &&
        String(args.at(-1) ?? "") === "probe renamed state"
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
        `cmuxlayerCodex -s -w '${worktreePath}'`,
      ]),
    );
  });

  it("spawn_agent resolves a mismatched repo key from the launcher registry path", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    const repoRoot = join(gitsDir, "skill-creator");
    const registryPath = join(TEST_DIR, "launchers.zsh");
    const worktreePath = join(repoRoot, ".worktrees", "registry-root");
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(
      registryPath,
      `repoGolem skillcreator "${repoRoot}"\n`,
    );
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

  it("spawn_agent rejects an unregistered repo before worktree or focus mutation", async () => {
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
    expect(parsed.error).toMatch(/Launcher registry miss.*wt-eval-scratch/s);
    expect(worktreeExec).not.toHaveBeenCalled();
    expect(
      exec.mock.calls.some(([, args]) =>
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
    const worktreePath = join(gitsDir, "cmuxlayer", ".worktrees", "sterile-worker");
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
        `CMUXLAYER_MCP_PROFILE=sterile cmuxlayerCodex -s -w '${worktreePath}'`,
      ]),
    );
  });

  it("new_worktree_split publishes its worktree cwd through the injected manifest writer", async () => {
    const gitsDir = join(TEST_DIR, "Gits");
    mkdirSync(join(gitsDir, "cmuxlayer"), { recursive: true });
    const worktreePath = join(gitsDir, "cmuxlayer", ".worktrees", "manifest-worker");
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
        selectWorkspace: vi.fn().mockImplementation(async (workspace: string) => {
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
          text: "Codex\n>",
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
    expect(parsed.agent_id).toMatch(/^cmuxlayerCursor-pending-\d+-[a-z0-9]+$/);
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
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--surface",
        "surface:new",
        "file prompt body",
      ]),
    );
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
                current_directory: "/Users/etanheyman/Gits/voicelayer",
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
      if (args.includes("send")) {
        lastSentText = String(args.at(-1) ?? "");
        if (lastSentText === "file prompt body") {
          promptDelivered = true;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("send-key")) {
        if (lastSentText === "voicelayerCodex -s") {
          launcherReturnCount += 1;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text:
              lastSentText === "file prompt body"
                ? "gpt-5.5 xhigh · 99% left · ~/Gits/voicelayer\nWorking (1s • esc to interrupt)"
                : lastSentText === ""
                ? "$ "
                : launcherReturnCount < 2
                  ? "$ voicelayerCodex -s"
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
    expect(mockExec).toHaveBeenCalledWith(
      "cmux",
      expect.arrayContaining([
        "send",
        "--workspace",
        "workspace:voice",
        "--surface",
        "surface:new",
        "file prompt body",
      ]),
    );
  }, 10_000);

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
                current_directory: "/Users/etanheyman/Gits/voicelayer",
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
      if (args.includes("send")) {
        lastSentText = String(args.at(-1) ?? "");
        if (lastSentText === "file prompt body") {
          promptDelivered = true;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("send-key")) {
        if (lastSentText === "voicelayerCodex -s") {
          launcherReturnCount += 1;
        }
        return { stdout: JSON.stringify({ ok: true }), stderr: "" };
      }
      if (args.includes("read-screen")) {
        return {
          stdout: JSON.stringify({
            surface: "surface:new",
            text:
              lastSentText === "file prompt body"
                ? "gpt-5.5 xhigh · 99% left · ~/Gits/voicelayer\nWorking (1s • esc to interrupt)"
                : lastSentText === ""
                  ? "$ "
                  : "$ voicelayerCodex -s\ncodex> ",
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

  it("spawn_agent stores boot_prompt_path contents as task_summary after delivery", async () => {
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
    expect(state.task_summary).toBe("file prompt body");
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
        .find((candidate: AgentRecord) =>
          candidate.agent_id === parsed.agent_id
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
          if (
            launcherSentAt !== null &&
            Date.now() - launcherSentAt < 200
          ) {
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("new_worktree_split reports the created identity when boot prompt verification fails", async () => {
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

      expect(parsed.ok).toBe(false);
      expect(parsed.agent_id).toEqual(expect.any(String));
      expect(parsed.surface_id).toBe("surface:new");
      expect(parsed.workspace_id).toBe("workspace:1");
      expect(parsed.submit_verification_reason).toBe(
        "surface_read_unavailable",
      );
      expect(parsed.retry_safe).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn_agent reports readiness timeout without poisoning agent state", async () => {
    const promptPath = join(TEST_DIR, "mandate.md");
    writeFileSync(promptPath, "file prompt body", "utf8");
    const stableUuid = "11111111-2222-4333-8444-555555555555";
    let launchSent = false;
    let readCountAfterLaunch = 0;
    mockExec = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("send")) {
        launchSent = true;
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
                surface_count: 1,
                surface_refs: ["surface:new"],
                surface_ids: [stableUuid],
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
    expect(state.task_summary).toBe("file prompt body");
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
  });

  it("spawn_agent persists crash_recover=true in agent state", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnResult = await spawn.handler(
      {
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix gap F",
        crash_recover: true,
      },
      {} as any,
    );
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const stateResult = await getState.handler(
      { agent_id: agentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);

    expect(state.crash_recover).toBe(true);
  });

  it("lifecycle crash recovery refuses placement in a manual workspace", async () => {
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
      crash_recover: true,
      error: "Surface surface:dead-manual disappeared",
      role: "orchestrator",
    });
    const server = await createUuidRouteServer(routeClient, record);
    const engine = testLifecycleEngine(server) as any;
    routeClient.client.listStatus.mockClear();
    routeClient.client.newSplit.mockClear();
    routeClient.client.send.mockClear();

    await engine.runSweep();

    expect(routeClient.client.listStatus).toHaveBeenCalledWith({
      workspace: "workspace:manual",
    });
    expect(routeClient.client.newSplit).not.toHaveBeenCalled();
    expect(routeClient.client.send).not.toHaveBeenCalled();
    expect(engine.getAgentState(record.agent_id)).toMatchObject({
      state: "error",
      surface_id: "surface:dead-manual",
    });
    expect(engine.getAgentState(record.agent_id)?.error).toMatch(/manual mode/i);
  });

  it("spawn_agent defaults crash_recover to true for orchestrators", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnArgs = spawn.inputSchema.parse({
        repo: "brainlayer",
        model: "sonnet",
        cli: "claude",
        prompt: "fix gap F",
    });
    const spawnResult = await spawn.handler(spawnArgs, {} as any);
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const stateResult = await getState.handler(
      { agent_id: agentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);

    expect(state.crash_recover).toBe(true);
  });

  it("spawn_agent keeps worker crash_recover default off", async () => {
    const server = createLifecycleServer(mockExec);
    const spawn = (server as any)._registeredTools["spawn_agent"];
    const getState = (server as any)._registeredTools["get_agent_state"];

    const spawnArgs = spawn.inputSchema.parse({
        repo: "cmuxlayer",
        model: "gpt-5.4",
        cli: "codex",
        prompt: "fix gap F",
        role: "worker",
    });
    const spawnResult = await spawn.handler(spawnArgs, {} as any);
    const agentId = (
      spawnResult.structuredContent ?? JSON.parse(spawnResult.content[0].text)
    ).agent_id;

    const stateResult = await getState.handler(
      { agent_id: agentId },
      {} as any,
    );
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);

    expect(state.crash_recover).toBe(false);
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

    const result = await list.handler({}, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0].repo).toBe("brainlayer");
    expect(parsed.agents[0].session_id).toBeNull();
    expect(parsed.agents[0].resume_command).toBeUndefined();
    expect(parsed.agents[0].surface_id).toBeUndefined();
    expect(parsed.agents[0].health).toMatchObject({
      status: "healthy",
      issue_codes: expect.arrayContaining([
        "missing_cli_session_id",
        "non_resumable",
      ]),
    });
  });

  it("list_agents keeps a corrupt legacy repo visible but not resumable", async () => {
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
    expect(parsed.agents).toEqual([
      expect.objectContaining({ agent_id: "healthy-agent" }),
      expect.objectContaining({
        agent_id: "corrupt-agent",
        resumable: false,
      }),
    ]);
    expect(parsed.agents[1]).not.toHaveProperty("resume_command");
    expect(parsed.skipped_agents).toBeUndefined();
  });

  it("send_to keeps registry repo ownership when a title contains a surface suffix", async () => {
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
    const server = await createUuidRouteServer(routeClient, record);
    const listResult = await registeredTestTool(server, "list_agents").handler(
      {},
      {} as any,
    );
    expect(parseToolResult(listResult)).toMatchObject({
      ok: true,
      agents: [expect.objectContaining({ repo: "brainlayer" })],
    });
    routeClient.client.send.mockClear();
    routeClient.sendCalls.length = 0;

    const result = await registeredTestTool(server, "send_to").handler(
      {
        agent_id: record.agent_id,
        text: "keep going",
        press_enter: false,
      },
      {} as any,
    );

    expect(result.isError).toBeFalsy();
    expect(routeClient.sendCalls).toEqual([
      { surface: "surface:199", text: "keep going" },
    ]);
    expect(testLifecycleEngine(server).getAgentState(record.agent_id)?.repo).toBe(
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

    const parsed = parseToolResult(await list.handler({}, {} as any));

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
    const { server, sendCalls, sendKeyCalls } = await createBroadcastServer(records);
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

    const result = await list.handler({ state: "working" }, {} as any);
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.agents[0]).toMatchObject({
      repo: "brainlayer",
      state: "working",
      health: {
        status: "healthy",
        issue_codes: expect.arrayContaining([
          "registry_screen_disagreement",
        ]),
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
      await registeredTestTool(server, "list_agents").handler({}, {}),
    );
    const agent = (parsed.agents as Array<Record<string, any>>).find(
      (candidate) => candidate.agent_id === record.agent_id,
    );

    expect(agent).toBeDefined();
    expect(agent?.state).toBe("ready");
    expect(agent?.health?.reconciled_state).toBeUndefined();
    expect(agent?.health?.issue_codes).not.toContain(
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
      await registeredTestTool(server, "list_agents").handler({}, {}),
    );
    const agent = (parsed.agents as Array<Record<string, any>>).find(
      (candidate) => candidate.agent_id === record.agent_id,
    );

    expect(agent).toBeDefined();
    expect(agent?.state).toBe("ready");
    expect(agent?.health?.reconciled_state).toBeUndefined();
    expect(agent?.health?.issue_codes).not.toContain(
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
    routeClient.client.readScreen.mockImplementation(async (surface: string) => ({
      surface,
      text:
        surface === "surface:new"
          ? "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\nWorking (1s - esc to interrupt)"
          : "gpt-5.5 xhigh - 99% left - ~/Gits/cmuxlayer\ncodex> ",
      lines: 20,
      scrollback_used: false,
    }));

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
    const parsed = parseToolResult(await listAgents.handler({}, {} as any)) as {
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
    const done = engine.stateMgr.transition(agentId, "done");
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
    expect(
      (missing.health as { issue_codes: string[] }).issue_codes,
    ).toContain("closure_without_artifact");

    writeFileSync(
      reportPath,
      "Status: COMPLETE\nDONE_P7_HARVESTABILITY\n",
      "utf8",
    );
    const verifiedResult = await getState.handler(
      { agent_id: agentId },
      {},
    );
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
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).toContain("closure_without_artifact");
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
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).toContain("closure_without_artifact");
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
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).toContain("closure_without_artifact");
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
    expect(
      (parsed.health as { issue_codes: string[] }).issue_codes,
    ).toContain("kept_open_contract_incomplete");
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
    const mockClient = {
      createWorkspace: vi.fn(),
      selectWorkspace: vi.fn().mockResolvedValue(undefined),
      listWorkspaces: vi.fn().mockResolvedValue({
        workspaces: [
          {
            ref: "workspace:1",
            title: "Main",
            selected: true,
            current_directory: "/Users/etanheyman/Gits/cmuxlayer",
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
      send: vi.fn().mockResolvedValue(undefined),
      sendKey: vi.fn().mockResolvedValue(undefined),
      readScreen: vi.fn().mockResolvedValue({
        surface: "surface:blocker",
        text: blockerScreen,
        lines: 20,
        scrollback_used: false,
      }),
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
    });
    engine.getRegistry().set(currentAgentId, updated);

    const result = await getState.handler(
      { agent_id: currentAgentId },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.resume_command).toBe(
      "golemsCodex --dangerously-bypass-approvals-and-sandbox resume 019d9aa5-93c0-7a52-9c47-9be1f7625f3e",
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

  it("send_to_agent rejects agents not in interactive state", async () => {
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

    // Agent is in "booting" state — not interactive
    const result = await sendTo.handler(
      { agent_id: agentId, text: "hello", press_enter: true },
      {} as any,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not in an interactive state/);
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
        expect.arrayContaining([
          "send",
          "--surface",
          "surface:new",
          "recover",
        ]),
      );
    },
  );

  it("send_to with allow_busy=true delivers to agents in working state", async () => {
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
        allow_busy: true,
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
    const originalResolveAgentIoRoute =
      engine.resolveAgentIoRoute.bind(engine);
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
    const originalResolveAgentIoRoute =
      engine.resolveAgentIoRoute.bind(engine);
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
    expect(parseToolResult(result).error).toMatch(/ambiguous|recycled|multiple/i);
    expect(routeClient.sendCalls).toEqual([]);
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
    expect(parseToolResult(result).error).toMatch(/explicit workspace|workspace:1/i);
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
        tracker.observe(
          "surface:230",
          null,
          "cmux:/tmp/observer-old.sock",
        ),
      ).toMatchObject({ consecutive_broken_pipe_failures: 1 });
      expect(
        tracker.observe(
          "surface:230",
          null,
          "cmux:/tmp/observer-new.sock",
        ),
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
    expect(parseToolResult(result).error).toMatch(/fresh topology|not live/i);
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
      surfaces: [expect.objectContaining({ ref: "surface:230", id: staleUuid })],
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
      expect(parseToolResult(result).error).toMatch(/ambiguous|recycled|multiple/i);
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
    expect(parseToolResult(result).error).toMatch(/stable surface UUID.*not live/i);
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
    expect(parseToolResult(result).error).toMatch(/stale|no longer maps|not live/i);
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
    expect(parseToolResult(result).error).toMatch(/recycled|no longer occupies|identity/i);
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
    const originalResolveAgentIoRoute =
      engine.resolveAgentIoRoute.bind(engine);
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

  it("send_to queues a busy composer and drains to a terminal submitted event", async () => {
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
    const queued = parseToolResult(result);
    expect(result.isError).toBeFalsy();
    expect(queued).toMatchObject({
      agent_id: agentId,
      delivery_id: expect.any(String),
      delivery_state: "queued",
      terminal: false,
    });
    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes("send")),
    ).toHaveLength(0);

    const restartedState = new StateManager(TEST_DIR);
    const restartedRegistry = new AgentRegistry(restartedState, async () => []);
    const restartedEngine = new AgentEngine(
      restartedState,
      restartedRegistry,
      {} as any,
    );
    expect(restartedEngine.getDeliveryReceipt(queued.delivery_id)).toMatchObject({
      delivery_id: queued.delivery_id,
      text: "hello",
      delivery_state: "queued",
      terminal: false,
    });

    const ready = engine.stateMgr.updateRecord(agentId, { state: "idle" });
    registry.set(agentId, ready);
    await engine.drainDeliveryQueue();

    const receipt = engine.getDeliveryReceipt(queued.delivery_id);
    expect(receipt).toMatchObject({
      delivery_id: queued.delivery_id,
      delivery_state: "submitted",
      terminal: true,
    });
    expect(
      engine.stateMgr
        .getEventLog()
        .readEntries()
        .filter((entry: any) => entry.delivery_id === queued.delivery_id)
        .at(-1),
    ).toMatchObject({
      delivery_state: "submitted",
      delivery_id: queued.delivery_id,
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

  it("send_to preserves a submitted receipt when post-delivery evidence throws", async () => {
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
    expect(parseToolResult(result)).toMatchObject({
      delivery_id: expect.any(String),
      delivery_state: "submitted",
      terminal: true,
      error: expect.stringContaining("post-delivery topology unavailable"),
    });
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

  it.each(["stop_agent", "kill"] as const)(
    "%s refuses manual mode on a freshly moved UUID route before mutation",
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
          ? { agent_id: record.agent_id, force: false }
          : { target: record.agent_id, force: false };
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
    writeFileSync(goalPath, "# Mission\n\nFinish the lifecycle repair.\n", "utf8");
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

    const stateResult = await getState.handler({ agent_id: agentId }, {} as any);
    const state =
      stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
    expect(state.task_summary).toBe("full baseline mission");
    expect(state.goal_file).toBe(goalPath);
  });

  it("supersede_agent_goal reports an unverified pane side effect without patching the registry", async () => {
    const goalPath = join(TEST_DIR, "queued-mission.md");
    writeFileSync(goalPath, "# Queued mission\n\nReplace the active work.\n", "utf8");
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
    writeFileSync(goalPath, "# Mission\n\nDo not record without proof.\n", "utf8");
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
    writeFileSync(goalPath, "# Mission\n\nReplace boot prompt state.\n", "utf8");
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
    const stateResult = await getState.handler({ agent_id: agentId }, {} as any);
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
      writeFileSync(goalPath, "# Mission\n\nReplace stale lifecycle state.\n", "utf8");
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

      const stateResult = await getState.handler({ agent_id: agentId }, {} as any);
      const state =
        stateResult.structuredContent ?? JSON.parse(stateResult.content[0].text);
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
    writeFileSync(goalPath, "# Mission\n\nThis should not be recorded.\n", "utf8");
    const backingExec = makeLifecycleExec();
    const failingExec: ExecFn = vi.fn().mockImplementation(async (cmd, args) => {
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
      { agent_id: currentAgentId, timeout_ms: 5000 },
      {} as any,
    );
    const parsed =
      result.structuredContent ?? JSON.parse(result.content[0].text);

    expect(parsed.ok).toBe(true);
    expect(parsed.agent_id).toBe(agentId);
    expect(parsed.state).toBe("done");
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
      if (previousFlag === undefined) delete process.env.CMUXLAYER_HARNESS_JSONL;
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
    for (let index = 0; index < 50 && get.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(get).toHaveBeenCalledWith(oldPath);
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
    expect(testLifecycleEngine(server).getAgentState(record.agent_id)).not.toHaveProperty(
      "token_count",
    );
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
    for (let index = 0; index < 50 && get.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(get).toHaveBeenCalledWith(oldPath);
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
    for (let index = 0; index < 50 && get.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(get).toHaveBeenCalledWith(path);
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
      for (let index = 0; index < 50 && get.mock.calls.length === 0; index += 1) {
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
    for (let index = 0; index < 50 && get.mock.calls.length === 0; index += 1) {
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

    await spawn.handler(
      { repo: "voicelayer", cli: "claude" },
      {} as any,
    );
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
    vi.spyOn(registry, "listMerged").mockImplementation(async (...args: any[]) => {
      const merged = await originalListMerged(...args);
      routeClient.setLiveSurfaces(movedSurfaces);
      return merged;
    });
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
    expect(routeClient.client.readScreen).toHaveBeenCalledWith(
      "surface:new",
      { lines: 20, workspace: "workspace:new" },
    );
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
        const created = calls.findIndex((args) =>
          args.includes("new-surface"),
        );
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
      expect(result.structuredContent.error).not.toMatch(/readiness|timed out/i);
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
