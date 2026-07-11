import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  CmuxLayerDaemon,
  daemonExitCode,
  SocketJsonRpcTransport,
} from "../src/daemon.js";
import { createServer, createServerContext } from "../src/server.js";
import type { ExecFn } from "../src/cmux-client.js";
import {
  readMonitorRegistry,
  registerMonitor,
} from "../src/monitor-registry.js";
import { ack, readInbox } from "../src/inbox.js";

const TEST_ROOT = join("/tmp", "cmuxlayer-daemon-test");

function socketPath(name: string): string {
  return join(TEST_ROOT, `${name}-${process.pid}-${Date.now()}.sock`);
}

function stateDir(name: string): string {
  return join(TEST_ROOT, `${name}-${process.pid}-${Date.now()}`);
}

function createListSurfacesExec(): ExecFn {
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
              surface_count: 1,
              surface_refs: ["surface:1"],
              selected_surface_ref: "surface:1",
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
              ref: "surface:1",
              title: "agent",
              type: "terminal",
              index: 0,
              selected: true,
            },
          ],
        }),
        stderr: "",
      };
    }

    return { stdout: "{}", stderr: "" };
  });
}

function createLifecycleExec(): ExecFn {
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
              title: "agent",
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
          text: "codex> ",
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
        pane: "pane:1",
        title: "",
        type: "terminal",
      }),
      stderr: "",
    };
  });
}

function createPlacementClient(
  workspaces: Array<Record<string, unknown>>,
  calls: string[] = [],
) {
  let surfaceIndex = 0;
  return {
    createWorkspace: vi.fn(),
    selectWorkspace: vi.fn().mockImplementation(async (workspace: string) => {
      calls.push(`select:${workspace}`);
    }),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces }),
    listPanes: vi
      .fn()
      .mockImplementation(async ({ workspace }: { workspace?: string } = {}) => ({
        workspace_ref: workspace ?? "workspace:focused",
        window_ref: "window:1",
        panes: [],
      })),
    listPaneSurfaces: vi
      .fn()
      .mockImplementation(async ({ workspace }: { workspace?: string } = {}) => ({
        workspace_ref: workspace ?? "workspace:focused",
        window_ref: "window:1",
        pane_ref: "pane:1",
        surfaces: [],
      })),
    newSplit: vi
      .fn()
      .mockImplementation(
        async (_direction: string, opts: { workspace?: string }) => {
          surfaceIndex += 1;
          calls.push(`spawn:${opts.workspace}`);
          return {
            workspace: opts.workspace,
            surface: `surface:caller-${surfaceIndex}`,
            pane: `pane:caller-${surfaceIndex}`,
            title: "",
            type: "terminal",
          };
        },
      ),
    newSurface: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    sendKey: vi.fn().mockResolvedValue(undefined),
    readScreen: vi.fn().mockResolvedValue({
      surface: "surface:caller",
      text: "codex> ",
      lines: 20,
      scrollback_used: false,
    }),
    log: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    closeSurface: vi.fn().mockResolvedValue(undefined),
    listSurfaces: vi.fn().mockResolvedValue([]),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
  };
}

async function connectClient(path: string): Promise<Client> {
  const socket = net.createConnection(path);
  const transport = new SocketJsonRpcTransport(socket);
  const client = new Client({ name: "daemon-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function connectInMemoryServer(
  server: ReturnType<typeof createServer>,
): Promise<Client> {
  const client = new Client({ name: "direct-test", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await delay(5);
  }
}

async function rawToolCall(
  path: string,
  params: Record<string, unknown>,
  timeoutMs = 1_000,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settle(new Error("timed out waiting for raw tools/call response"));
    }, timeoutMs);
    const send = (message: Record<string, unknown>) => {
      socket.write(`${JSON.stringify(message)}\n`);
    };
    const settle = (error?: Error, response?: Record<string, any>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve(response ?? {});
    };

    socket.on("connect", () => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw-spawn-test", version: "0.1.0" },
        },
      });
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params });
          continue;
        }
        if (message.id === 2) {
          settle(undefined, message);
        }
      }
    });
    socket.on("error", (error) => settle(error));
  });
}

async function listen(server: net.Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function rawToolsList(
  path: string,
  timeoutMs = 500,
): Promise<{
  server?: string;
  toolCount?: number;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(`timed out waiting for tools/list after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const send = (message: Record<string, unknown>) => {
      socket.write(`${JSON.stringify(message)}\n`);
    };

    socket.on("connect", () => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw-daemon-test", version: "0.1.0" },
        },
      });
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
          continue;
        }
        if (message.id === 2) {
          clearTimeout(timeout);
          socket.end();
          resolve({
            server: message.result?.serverInfo?.name,
            toolCount: message.result?.tools?.length,
          });
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function readOnce(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

describe("CmuxLayerDaemon", () => {
  const intervalDaemons = new Set<CmuxLayerDaemon>();
  const trackIntervalDaemon = (daemon: CmuxLayerDaemon): CmuxLayerDaemon => {
    intervalDaemons.add(daemon);
    return daemon;
  };

  afterEach(async () => {
    await Promise.all(
      [...intervalDaemons].map((daemon) => daemon.shutdown().catch(() => {})),
    );
    intervalDaemons.clear();
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("rejects start after the socket transport has been closed", async () => {
    const socket = new net.Socket();
    const transport = new SocketJsonRpcTransport(socket);

    await transport.close();

    await expect(transport.start()).rejects.toThrow(/closed/i);
    socket.destroy();
  });

  it("exits zero for retirement even when draining was forced", () => {
    const forced = {
      forced: true,
      activeConnections: 1,
      inFlightRequests: 1,
    };

    expect(daemonExitCode("stale-build", forced)).toBe(0);
    expect(daemonExitCode("irrecoverable-transport", forced)).toBe(0);
    expect(daemonExitCode("SIGTERM", forced)).toBe(1);
  });

  it("retires exactly once when the installed build becomes stale", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("stale-retire");
    const onRetire = vi.fn();
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
      staleCheckIntervalMs: 5,
      detectStaleBuild: () => ({
        stale: true,
        running: "0.3.31",
        installed: "0.3.33",
      }),
      onRetire,
    });
    const shutdown = vi.spyOn(daemon, "shutdown");

    await daemon.start();
    await waitUntil(() => onRetire.mock.calls.length === 1);
    await delay(20);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(onRetire).toHaveBeenCalledWith(
      "stale-build",
      expect.objectContaining({ forced: false }),
    );
  });

  it("does not retire for null or matching stale-build checks", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("not-stale");
    const detectStaleBuild = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue({
        stale: false,
        running: "0.3.33",
        installed: "0.3.33",
      });
    const onRetire = vi.fn();
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
      staleCheckIntervalMs: 5,
      detectStaleBuild,
      onRetire,
    });

    await daemon.start();
    await delay(25);

    expect(detectStaleBuild).toHaveBeenCalled();
    expect(onRetire).not.toHaveBeenCalled();
    await daemon.shutdown();
  });

  it("retires exactly once when the self-healing client signals irrecoverable denial", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("transport-retire");
    let signalIrrecoverable: (() => void) | undefined;
    const onRetire = vi.fn();
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      createClient: async (opts) => {
        signalIrrecoverable = opts.onIrrecoverableTransport;
        return {} as any;
      },
      skipAgentLifecycle: true,
      staleCheckIntervalMs: 60_000,
      detectStaleBuild: () => null,
      onRetire,
    });
    const shutdown = vi.spyOn(daemon, "shutdown");

    await daemon.start();
    expect(signalIrrecoverable).toBeTypeOf("function");
    signalIrrecoverable?.();
    signalIrrecoverable?.();
    await waitUntil(() => onRetire.mock.calls.length === 1);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(onRetire).toHaveBeenCalledWith(
      "irrecoverable-transport",
      expect.objectContaining({ forced: false }),
    );
  });

  it("clears the stale-build timer after shutdown", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("stale-timer-clear");
    const detectStaleBuild = vi.fn(() => null);
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
      staleCheckIntervalMs: 5,
      detectStaleBuild,
    });

    await daemon.start();
    await waitUntil(() => detectStaleBuild.mock.calls.length >= 2);
    await daemon.shutdown();
    const callsAfterShutdown = detectStaleBuild.mock.calls.length;
    await delay(20);

    expect(detectStaleBuild).toHaveBeenCalledTimes(callsAfterShutdown);
  });

  it("runs monitor reconciliation immediately on daemon boot", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const monitorReconcile = vi.fn().mockResolvedValue(undefined);
    const daemon = new CmuxLayerDaemon({
      socketPath: socketPath("monitor-reconcile-boot"),
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
      monitorReconcile,
      monitorReconcileIntervalMs: 0,
    });

    await daemon.start();

    expect(monitorReconcile).toHaveBeenCalledTimes(1);
    await daemon.shutdown();
  });

  it("does not overlap periodic monitor reconciliation passes", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const firstPass = deferred<void>();
    const monitorReconcile = vi
      .fn()
      .mockImplementationOnce(() => firstPass.promise)
      .mockResolvedValue(undefined);
    const daemon = trackIntervalDaemon(new CmuxLayerDaemon({
      socketPath: socketPath("monitor-reconcile-overlap"),
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
      monitorReconcile,
      monitorReconcileIntervalMs: 5,
    }));

    await daemon.start();
    await delay(20);
    expect(monitorReconcile).toHaveBeenCalledTimes(1);

    firstPass.resolve();
    await waitUntil(() => monitorReconcile.mock.calls.length >= 2);
    await daemon.shutdown();
  });

  it("does not force a second pass when relay readiness lands during a successful pass", async () => {
    let finishFirst: ((value: unknown) => void) | null = null;
    const firstPass = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const monitorReconcile = vi
      .fn()
      .mockImplementationOnce(() => firstPass)
      .mockResolvedValue({ rearmed: [], collapsed: [], failed: [] });
    const context = createServerContext({
      exec: createListSurfacesExec(),
      stateDir: stateDir("relay-ready-successful-pass"),
      skipAgentLifecycle: true,
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: socketPath("relay-ready-successful-pass"),
      context,
      monitorReconcile,
      monitorReconcileIntervalMs: 0,
    });

    await daemon.start();
    await waitUntil(() => monitorReconcile.mock.calls.length === 1);
    context.setLifecycleAgentInputDeliverer(vi.fn().mockResolvedValue(undefined));
    finishFirst?.({ rearmed: ["monitor-a"], collapsed: [], failed: [] });
    await delay(20);

    expect(monitorReconcile).toHaveBeenCalledTimes(1);
    await daemon.shutdown();
  });

  it("scopes a relay-ready retry to failed monitors from a mixed pass", async () => {
    let finishFirst: ((value: unknown) => void) | null = null;
    const firstPass = new Promise((resolve) => {
      finishFirst = resolve;
    });
    const monitorReconcile = vi
      .fn()
      .mockImplementationOnce(() => firstPass)
      .mockResolvedValue({
        rearmed: ["monitor-a"],
        collapsed: [],
        failed: [],
      });
    const context = createServerContext({
      exec: createListSurfacesExec(),
      stateDir: stateDir("relay-ready-mixed-pass"),
      skipAgentLifecycle: true,
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: socketPath("relay-ready-mixed-pass"),
      context,
      monitorReconcile,
      monitorReconcileIntervalMs: 0,
    });

    await daemon.start();
    await waitUntil(() => monitorReconcile.mock.calls.length === 1);
    context.setLifecycleAgentInputDeliverer(vi.fn().mockResolvedValue(undefined));
    finishFirst?.({
      rearmed: ["monitor-b"],
      collapsed: [],
      failed: ["monitor-a"],
    });
    await waitUntil(() => monitorReconcile.mock.calls.length === 2);

    expect(monitorReconcile.mock.calls[1]?.[0]).toEqual({
      rearmClaimTimeoutMs: 0,
      monitorIds: ["monitor-a"],
    });
    await daemon.shutdown();
  });

  it("clears the monitor reconciliation timer during shutdown", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const monitorReconcile = vi.fn().mockResolvedValue(undefined);
    const daemon = trackIntervalDaemon(new CmuxLayerDaemon({
      socketPath: socketPath("monitor-reconcile-clear"),
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
      monitorReconcile,
      monitorReconcileIntervalMs: 5,
    }));

    await daemon.start();
    await waitUntil(() => monitorReconcile.mock.calls.length >= 2);
    await daemon.shutdown();
    const callsAfterShutdown = monitorReconcile.mock.calls.length;
    await delay(20);

    expect(monitorReconcile).toHaveBeenCalledTimes(callsAfterShutdown);
  });

  it("does not enqueue a duplicate monitor re-arm after daemon restart", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const registryPath = join(TEST_ROOT, "restart-monitor-registry.json");
    const watchedFile = join(TEST_ROOT, "restart-collab.md");
    const inboxBaseDir = join(TEST_ROOT, "restart-inbox");
    const sharedStateDir = stateDir("restart-state");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "restart-monitor",
        owner_seat: "worker-a",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath, now: () => 1_000 },
    );

    const clients: ReturnType<typeof createPlacementClient>[] = [];
    const guardedRelays: Array<ReturnType<typeof vi.fn>> = [];
    const monitorOwnerWedgedNotify = vi.fn().mockResolvedValue(true);
    const createContext = () => {
      const client = createPlacementClient([]);
      clients.push(client);
      const context = createServerContext({
        client: client as any,
        stateDir: sharedStateDir,
        skipAgentLifecycle: true,
      });
      const guardedRelay = vi.fn().mockResolvedValue(undefined);
      guardedRelays.push(guardedRelay);
      context.setLifecycleAgentInputDeliverer(guardedRelay);
      if (context.stateMgr.listStates().length === 0) {
        context.stateMgr.writeState({
          agent_id: "worker-a",
          surface_id: "surface:caller",
          workspace_id: "workspace:1",
          state: "working",
          repo: "cmuxlayer",
          model: "codex",
          cli: "codex",
          cli_session_id: "session-a",
          task_summary: "watch collab",
          pid: 123,
          version: 1,
          created_at: new Date(1_000).toISOString(),
          updated_at: new Date(1_000).toISOString(),
          error: null,
          parent_agent_id: null,
          spawn_depth: 0,
          deletion_intent: false,
          quality: "verified",
          max_cost_per_agent: null,
        });
      }
      return context;
    };
    const first = new CmuxLayerDaemon({
      socketPath: socketPath("monitor-restart-first"),
      context: createContext(),
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => 62_000,
      monitorReconcileIntervalMs: 0,
      monitorOwnerWedgedNotify,
      inboxBaseDir,
    });
    await first.start();
    await first.shutdown();

    const second = new CmuxLayerDaemon({
      socketPath: socketPath("monitor-restart-second"),
      context: createContext(),
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => 123_001,
      monitorReconcileIntervalMs: 0,
      monitorOwnerWedgedNotify,
      inboxBaseDir,
    });
    await second.start();
    await second.shutdown();

    expect(readInbox("worker-a", { baseDir: inboxBaseDir })).toHaveLength(1);
    expect(readInbox("worker-a", { baseDir: inboxBaseDir })[0]).toMatchObject({
      from: "cmuxlayer-daemon",
      tag: "monitor-rearm",
      task: expect.stringContaining(`tail -n0 -F ${watchedFile}`),
    });
    expect(readMonitorRegistry({ registryPath }).monitors[0]).toMatchObject({
      monitor_id: "restart-monitor",
      state: "collapsed",
      collapsed_reason: "owner-wedged",
    });
    expect(monitorOwnerWedgedNotify).toHaveBeenCalledTimes(1);
    expect(guardedRelays[0]).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "worker-a",
        text: expect.stringContaining("read"),
        press_enter: true,
        allow_busy: true,
        source_event: "dispatch_nudge",
      }),
    );
    expect(clients[0]?.send).not.toHaveBeenCalled();
    expect(clients[0]?.sendKey).not.toHaveBeenCalled();
  });

  it("collapses and loudly escalates a pty-dead monitor owner without inbox re-arm", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const registryPath = join(TEST_ROOT, "pty-dead-monitor-registry.json");
    const watchedFile = join(TEST_ROOT, "pty-dead-collab.md");
    const inboxBaseDir = join(TEST_ROOT, "pty-dead-inbox");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "pty-dead-monitor",
        owner_seat: "worker-wedged",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath, now: () => 1_000 },
    );

    const context = createServerContext({
      client: createPlacementClient([]) as any,
      stateDir: stateDir("pty-dead-state"),
      skipAgentLifecycle: true,
    });
    context.stateMgr.writeState({
      agent_id: "worker-wedged",
      surface_id: "surface:caller",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: "session-wedged",
      task_summary: "watch collab",
      pid: 123,
      version: 1,
      created_at: new Date(1_000).toISOString(),
      updated_at: new Date(1_000).toISOString(),
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "verified",
      max_cost_per_agent: null,
    });
    context.surfaceWriteLiveness.recordFailure("surface:caller", {
      code: "EPIPE",
    });
    context.surfaceWriteLiveness.recordFailure("surface:caller", {
      code: "EPIPE",
    });
    const guardedRelay = vi.fn().mockResolvedValue(undefined);
    context.setLifecycleAgentInputDeliverer(guardedRelay);
    const monitorOwnerPtyDeadNotify = vi.fn().mockResolvedValue(true);
    const daemon = trackIntervalDaemon(new CmuxLayerDaemon({
      socketPath: socketPath("monitor-owner-pty-dead"),
      context,
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => 62_000,
      monitorReconcileIntervalMs: 5,
      monitorOwnerPtyDeadNotify,
      inboxBaseDir,
    }));

    await daemon.start();
    await waitUntil(
      () => readMonitorRegistry({ registryPath }).monitors[0]?.state !== "alive",
    );
    await delay(20);
    await daemon.shutdown();

    expect(readMonitorRegistry({ registryPath }).monitors[0]).toMatchObject({
      monitor_id: "pty-dead-monitor",
      state: "collapsed",
      collapsed_reason: "owner-pty-dead",
    });
    expect(monitorOwnerPtyDeadNotify).toHaveBeenCalledTimes(1);
    expect(monitorOwnerPtyDeadNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Monitor owner PTY dead",
        body: expect.stringContaining("pty-dead-monitor"),
        priority: "high",
        dedupe_key: "pty-dead-monitor:owner-pty-dead",
      }),
    );
    expect(readInbox("worker-wedged", { baseDir: inboxBaseDir })).toEqual([]);
    expect(guardedRelay).not.toHaveBeenCalled();
  });

  it("collapses and loudly escalates a pane-alive owner that never acknowledges re-arm", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const registryPath = join(TEST_ROOT, "wedged-monitor-registry.json");
    const watchedFile = join(TEST_ROOT, "wedged-collab.md");
    const inboxBaseDir = join(TEST_ROOT, "wedged-inbox");
    let now = 62_000;
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "wedged-monitor",
        owner_seat: "worker-wedged",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath, now: () => 1_000 },
    );

    const context = createServerContext({
      client: createPlacementClient([]) as any,
      stateDir: stateDir("wedged-state"),
      skipAgentLifecycle: true,
    });
    context.stateMgr.writeState({
      agent_id: "worker-wedged",
      surface_id: "surface:caller",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: "session-wedged",
      task_summary: "watch collab",
      pid: 123,
      version: 1,
      created_at: new Date(1_000).toISOString(),
      updated_at: new Date(1_000).toISOString(),
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "verified",
      max_cost_per_agent: null,
    });
    const guardedRelay = vi.fn().mockResolvedValue(undefined);
    context.setLifecycleAgentInputDeliverer(guardedRelay);
    const monitorOwnerWedgedNotify = vi.fn().mockResolvedValue(true);
    const daemon = trackIntervalDaemon(new CmuxLayerDaemon({
      socketPath: socketPath("monitor-owner-wedged"),
      context,
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
      monitorReconcileIntervalMs: 5,
      monitorOwnerWedgedNotify,
      inboxBaseDir,
    }));

    await daemon.start();
    await waitUntil(
      () => readMonitorRegistry({ registryPath }).monitors[0]?.state === "rearming",
    );
    now = 72_001;
    await waitUntil(
      () => readMonitorRegistry({ registryPath }).monitors[0]?.state === "collapsed",
    );
    await delay(20);
    await daemon.shutdown();

    expect(readMonitorRegistry({ registryPath }).monitors[0]).toMatchObject({
      monitor_id: "wedged-monitor",
      state: "collapsed",
      collapsed_reason: "owner-wedged",
    });
    expect(monitorOwnerWedgedNotify).toHaveBeenCalledTimes(1);
    expect(monitorOwnerWedgedNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Monitor owner wedged",
        body: expect.stringContaining("wedged-monitor"),
        priority: "high",
        dedupe_key: "wedged-monitor:owner-wedged",
      }),
    );
    expect(readInbox("worker-wedged", { baseDir: inboxBaseDir })).toHaveLength(1);
    expect(guardedRelay).toHaveBeenCalledTimes(1);
  });

  it("keeps normal re-arm flow when the pane-alive owner acknowledges in time", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const registryPath = join(TEST_ROOT, "acked-monitor-registry.json");
    const watchedFile = join(TEST_ROOT, "acked-collab.md");
    const inboxBaseDir = join(TEST_ROOT, "acked-inbox");
    let now = 62_000;
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "acked-monitor",
        owner_seat: "worker-live",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath, now: () => 1_000 },
    );

    const context = createServerContext({
      client: createPlacementClient([]) as any,
      stateDir: stateDir("acked-state"),
      skipAgentLifecycle: true,
    });
    context.stateMgr.writeState({
      agent_id: "worker-live",
      surface_id: "surface:caller",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: "session-live",
      task_summary: "watch collab",
      pid: 123,
      version: 1,
      created_at: new Date(1_000).toISOString(),
      updated_at: new Date(1_000).toISOString(),
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "verified",
      max_cost_per_agent: null,
    });
    const guardedRelay = vi.fn().mockResolvedValue(undefined);
    context.setLifecycleAgentInputDeliverer(guardedRelay);
    const monitorOwnerWedgedNotify = vi.fn();
    const daemon = trackIntervalDaemon(new CmuxLayerDaemon({
      socketPath: socketPath("monitor-owner-acked"),
      context,
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => now,
      monitorReconcileIntervalMs: 5,
      monitorOwnerWedgedNotify,
      inboxBaseDir,
    }));

    await daemon.start();
    await waitUntil(
      () => readMonitorRegistry({ registryPath }).monitors[0]?.state === "rearming",
    );
    now = 65_000;
    ack(
      "worker-live",
      `monitor-rearm:acked-monitor:${new Date(1_000).toISOString()}`,
      "rearmed",
      { baseDir: inboxBaseDir, now: () => now },
    );
    now = 72_001;
    await waitUntil(
      () =>
        readMonitorRegistry({ registryPath }).monitors[0]?.rearm_claimed_at ===
        new Date(72_001).toISOString(),
    );
    await daemon.shutdown();

    const record = readMonitorRegistry({ registryPath }).monitors[0];
    expect(record).toMatchObject({
      monitor_id: "acked-monitor",
      state: "rearming",
    });
    expect(record).not.toHaveProperty("collapsed_reason");
    expect(monitorOwnerWedgedNotify).not.toHaveBeenCalled();
    expect(readInbox("worker-live", { baseDir: inboxBaseDir })).toHaveLength(1);
    expect(guardedRelay).toHaveBeenCalledTimes(1);
  });

  it("retries a claimed monitor as soon as the guarded relay becomes ready", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const registryPath = join(TEST_ROOT, "relay-ready-monitor-registry.json");
    const watchedFile = join(TEST_ROOT, "relay-ready-collab.md");
    const inboxBaseDir = join(TEST_ROOT, "relay-ready-inbox");
    writeFileSync(watchedFile, "# collab\n", "utf8");
    await registerMonitor(
      {
        monitor_id: "relay-ready-monitor",
        owner_seat: "worker-a",
        watch_targets: [watchedFile],
        mechanism: "event",
        deadman_timeout_s: 60,
        rearm_command: `tail -n0 -F ${watchedFile}`,
      },
      { registryPath, now: () => 1_000 },
    );

    const context = createServerContext({
      client: createPlacementClient([]) as any,
      stateDir: stateDir("relay-ready-state"),
      skipAgentLifecycle: true,
    });
    context.stateMgr.writeState({
      agent_id: "worker-a",
      surface_id: "surface:caller",
      workspace_id: "workspace:1",
      state: "working",
      repo: "cmuxlayer",
      model: "codex",
      cli: "codex",
      cli_session_id: "session-a",
      task_summary: "watch collab",
      pid: 123,
      version: 1,
      created_at: new Date(1_000).toISOString(),
      updated_at: new Date(1_000).toISOString(),
      error: null,
      parent_agent_id: null,
      spawn_depth: 0,
      deletion_intent: false,
      quality: "verified",
      max_cost_per_agent: null,
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: socketPath("monitor-relay-ready"),
      context,
      monitorRegistryPath: registryPath,
      monitorRegistryNow: () => 62_000,
      monitorReconcileIntervalMs: 0,
      monitorOwnerWedgedNotify: vi.fn(),
      inboxBaseDir,
    });

    await daemon.start();
    await waitUntil(
      () =>
        readMonitorRegistry({ registryPath }).monitors[0]?.state ===
        "rearming",
    );
    const guardedRelay = vi.fn().mockResolvedValue(undefined);
    context.setLifecycleAgentInputDeliverer(guardedRelay);

    await waitUntil(() => guardedRelay.mock.calls.length === 1);
    expect(readInbox("worker-a", { baseDir: inboxBaseDir })).toHaveLength(1);
    await daemon.shutdown();
  });

  it("reuses one lifecycle AgentEngine across servers sharing a context", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const context = createServerContext({
      exec: createLifecycleExec(),
      stateDir: stateDir("shared-engine"),
      disableSpawnPreflight: true,
    });

    try {
      const firstServer = createServer({ context });
      const secondServer = createServer({ context });

      expect((firstServer as any)._registeredTools.interact._engine).toBe(
        (secondServer as any)._registeredTools.interact._engine,
      );
      expect(context.lifecycleAgentInputDeliverer).toBeNull();
      await context.lifecycleStartPromise;
      expect(context.lifecycleAgentInputDeliverer).toBeTypeOf("function");
    } finally {
      context.dispose();
    }
  });

  it("serves initialize and list_surfaces over a unix socket", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("basic");
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
    });

    await daemon.start();
    const client = await connectClient(path);

    const result = await client.callTool({
      name: "list_surfaces",
      arguments: { verbose: false },
    });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      column_count: 1,
    });
    expect(result.structuredContent?.surfaces).toHaveLength(1);

    await client.close();
    await daemon.shutdown();
  });

  it("serves the first cold connection after lazy context creation", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("cold-first");
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      createClient: async () => {
        await delay(200);
        return {} as any;
      },
      skipAgentLifecycle: true,
    });

    await daemon.start();

    await expect(rawToolsList(path, 100)).resolves.toMatchObject({
      toolCount: 25,
    });

    await daemon.shutdown();
  });

  it("closes the per-connection MCP server when a client disconnects", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("connection-close");
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
    });
    const closeSpy = vi.spyOn(McpServer.prototype, "close");

    try {
      await daemon.start();
      const client = await connectClient(path);
      closeSpy.mockClear();

      await client.close();
      await delay(10);

      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await daemon.shutdown().catch(() => {});
      closeSpy.mockRestore();
    }
  });

  it("observes incoming requests even when onmessage is replaced", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("request-observer");
    const observed = deferred<Record<string, unknown>>();
    const server = net.createServer(async (socket) => {
      const transport = new SocketJsonRpcTransport(socket);
      (transport as any).onRequestObserved = (
        message: Record<string, unknown>,
      ) => observed.resolve(message);
      transport.onmessage = () => {};
      await transport.start();
      transport.onmessage = () => {};
    });

    await listen(server, path);
    const socket = net.createConnection(path);
    await once(socket, "connect");
    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n`,
    );

    try {
      await expect(
        Promise.race([
          observed.promise,
          delay(50).then(() => {
            throw new Error("request observer was not called");
          }),
        ]),
      ).resolves.toMatchObject({ id: 99, method: "ping" });
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("observes sent responses only after socket writes complete", async () => {
    const writeCallbacks: Array<() => void> = [];
    const fakeSocket = new EventEmitter() as net.Socket & {
      destroyed: boolean;
      write: ReturnType<typeof vi.fn>;
    };
    fakeSocket.destroyed = false;
    fakeSocket.write = vi.fn((_payload, callback?: () => void) => {
      if (callback) {
        writeCallbacks.push(callback);
      }
      return true;
    });

    const transport = new SocketJsonRpcTransport(fakeSocket);
    const sent: unknown[] = [];
    transport.onSend = (message) => sent.push(message);
    let sendSettled = false;
    const send = transport
      .send({ jsonrpc: "2.0", id: 1, result: {} })
      .then(() => {
        sendSettled = true;
      });

    await Promise.resolve();
    expect(sent).toHaveLength(0);
    expect(sendSettled).toBe(false);
    expect(writeCallbacks).toHaveLength(1);

    writeCallbacks[0]();
    await send;

    expect(sendSettled).toBe(true);
    expect(sent).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("shares one world-model across concurrent MCP connections", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("shared");
    const dir = stateDir("shared-state");
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createLifecycleExec(),
      stateDir: dir,
      disableSpawnPreflight: true,
    });

    await daemon.start();
    const [clientA, clientB] = await Promise.all([
      connectClient(path),
      connectClient(path),
    ]);

    const spawned = await clientA.callTool({
      name: "spawn_agent",
      arguments: {
        repo: "brainlayer",
        model: "gpt-5.4",
        cli: "codex",
      },
    });
    const agentId = String(spawned.structuredContent?.agent_id);
    const state = await clientB.callTool({
      name: "get_agent_state",
      arguments: { agent_id: agentId },
    });

    expect(state.structuredContent).toMatchObject({
      ok: true,
      agent_id: agentId,
      surface_id: "surface:new",
      cli: "codex",
    });

    await clientA.close();
    await clientB.close();
    await daemon.shutdown();
  });

  it("uses per-request caller workspace metadata when daemon env has no workspace", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const previousWorkspaceId = process.env.CMUX_WORKSPACE_ID;
    const previousTabId = process.env.CMUX_TAB_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_TAB_ID;
    const path = socketPath("caller-workspace");
    const calls: string[] = [];
    const context = createServerContext({
      client: createPlacementClient(
        [
          {
            id: "caller-workspace-uuid",
            ref: "workspace:1",
            title: "Caller Workspace",
            selected: false,
          },
          {
            id: "selected-workspace-uuid",
            ref: "workspace:5",
            title: "Focused Workspace",
            selected: true,
          },
        ],
        calls,
      ) as any,
      stateDir: stateDir("caller-workspace-state"),
      disableSpawnPreflight: true,
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      context,
      disableSpawnPreflight: true,
    });

    try {
      await daemon.start();

      const response = await rawToolCall(path, {
        name: "spawn_agent",
        arguments: {
          repo: "brainlayer",
          model: "gpt-5.5",
          cli: "codex",
          force_new: true,
        },
        _meta: {
          "cmuxlayer/callerContext": {
            workspaceId: "caller-workspace-uuid",
            tabId: "caller-tab-id",
            surfaceId: "surface:caller",
          },
        },
      });

      expect(response.result?.structuredContent).toMatchObject({
        ok: true,
        workspace_id: "workspace:1",
      });
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
      await daemon.shutdown().catch(() => {});
    }
  });

  it("keeps concurrent caller workspace metadata isolated per request", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const previousWorkspaceId = process.env.CMUX_WORKSPACE_ID;
    const previousTabId = process.env.CMUX_TAB_ID;
    delete process.env.CMUX_WORKSPACE_ID;
    delete process.env.CMUX_TAB_ID;
    const path = socketPath("caller-workspace-concurrent");
    const calls: string[] = [];
    const context = createServerContext({
      client: createPlacementClient(
        [
          {
            id: "workspace-x-uuid",
            ref: "workspace:10",
            title: "Caller X",
            selected: false,
          },
          {
            id: "workspace-y-uuid",
            ref: "workspace:11",
            title: "Caller Y",
            selected: false,
          },
          {
            id: "focused-workspace-uuid",
            ref: "workspace:5",
            title: "Focused Workspace",
            selected: true,
          },
        ],
        calls,
      ) as any,
      stateDir: stateDir("caller-workspace-concurrent-state"),
      disableSpawnPreflight: true,
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      context,
      disableSpawnPreflight: true,
    });

    try {
      await daemon.start();

      const [xResponse, yResponse] = await Promise.all([
        rawToolCall(path, {
          name: "spawn_agent",
          arguments: {
            repo: "brainlayer",
            model: "gpt-5.5",
            cli: "codex",
            force_new: true,
          },
          _meta: {
            "cmuxlayer/callerContext": {
              workspaceId: "workspace-x-uuid",
              surfaceId: "surface:x",
            },
          },
        }),
        rawToolCall(path, {
          name: "spawn_agent",
          arguments: {
            repo: "voicelayer",
            model: "gpt-5.5",
            cli: "codex",
            force_new: true,
          },
          _meta: {
            "cmuxlayer/callerContext": {
              workspaceId: "workspace-y-uuid",
              surfaceId: "surface:y",
            },
          },
        }),
      ]);

      expect(xResponse.result?.structuredContent).toMatchObject({
        ok: true,
        workspace_id: "workspace:10",
      });
      expect(yResponse.result?.structuredContent).toMatchObject({
        ok: true,
        workspace_id: "workspace:11",
      });
      expect(calls).toContain("spawn:workspace:10");
      expect(calls).toContain("spawn:workspace:11");
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
      await daemon.shutdown().catch(() => {});
    }
  });

  it("serves the same list_agents and read_screen state as a direct in-process server", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("truthful-state");
    const dir = stateDir("truthful-state");
    const context = createServerContext({
      exec: createLifecycleExec(),
      stateDir: dir,
      disableSpawnPreflight: true,
    });
    const directServer = createServer({ context });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      context,
      disableSpawnPreflight: true,
    });

    await daemon.start();
    const directClient = await connectInMemoryServer(directServer);
    const daemonClient = await connectClient(path);

    try {
      const spawned = await directClient.callTool({
        name: "spawn_agent",
        arguments: {
          repo: "brainlayer",
          model: "gpt-5.4",
          cli: "codex",
        },
      });
      const agentId = String(spawned.structuredContent?.agent_id);
      const [directAgents, daemonAgents, directScreen, daemonScreen] =
        await Promise.all([
          directClient.callTool({
            name: "list_agents",
            arguments: { include_completed: true },
          }),
          daemonClient.callTool({
            name: "list_agents",
            arguments: { include_completed: true },
          }),
          directClient.callTool({
            name: "read_screen",
            arguments: { surface: "surface:new", lines: 5 },
          }),
          daemonClient.callTool({
            name: "read_screen",
            arguments: { surface: "surface:new", lines: 5 },
          }),
        ]);

      expect(daemonAgents.structuredContent).toEqual(
        directAgents.structuredContent,
      );
      expect(daemonScreen.structuredContent).toEqual(
        directScreen.structuredContent,
      );
      expect(daemonAgents.structuredContent).toMatchObject({
        agents: [expect.objectContaining({ agent_id: agentId })],
      });
    } finally {
      await directClient.close();
      await daemonClient.close();
      await daemon.shutdown();
      await directServer.close();
      context.dispose();
    }
  });

  it("drains an in-flight request before shutdown completes", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("drain");
    const gate = deferred<{ stdout: string; stderr: string }>();
    const started = deferred<void>();
    const exec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        started.resolve();
        return gate.promise;
      }
      return createListSurfacesExec()(_cmd, args);
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec,
      skipAgentLifecycle: true,
      drainTimeoutMs: 500,
    });

    await daemon.start();
    const client = await connectClient(path);
    const pending = client.callTool({
      name: "list_surfaces",
      arguments: { verbose: false },
    });

    await started.promise;
    const shutdown = daemon.shutdown("SIGTERM");
    gate.resolve({
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
    });

    await expect(pending).resolves.toMatchObject({
      structuredContent: expect.objectContaining({ ok: true }),
    });
    await expect(shutdown).resolves.toMatchObject({ forced: false });

    await client.close();
  });

  it("keeps shutdown pending while a request is in-flight", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("drain-waits");
    const gate = deferred<{ stdout: string; stderr: string }>();
    const started = deferred<void>();
    const exec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        started.resolve();
        return gate.promise;
      }
      return createListSurfacesExec()(_cmd, args);
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec,
      skipAgentLifecycle: true,
      drainTimeoutMs: 500,
    });

    await daemon.start();
    const client = await connectClient(path);
    const pending = client.callTool({
      name: "list_surfaces",
      arguments: { verbose: false },
    });

    await started.promise;
    let shutdownSettled = false;
    const shutdown = daemon.shutdown("SIGTERM").then((result) => {
      shutdownSettled = true;
      return result;
    });
    await delay(30);

    expect(shutdownSettled).toBe(false);
    expect(daemon.inFlightRequestCount()).toBe(1);

    gate.resolve({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    await expect(pending).resolves.toMatchObject({
      structuredContent: expect.objectContaining({ ok: true }),
    });
    await expect(shutdown).resolves.toMatchObject({ forced: false });
    await client.close();
  });

  it("does not start new requests on existing connections after drain begins", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("drain-blocks-new-work");
    const gate = deferred<{ stdout: string; stderr: string }>();
    const started = deferred<void>();
    let listWorkspacesCalls = 0;
    const exec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        listWorkspacesCalls += 1;
        if (listWorkspacesCalls === 1) {
          started.resolve();
          return gate.promise;
        }
        return {
          stdout: JSON.stringify({ workspaces: [] }),
          stderr: "",
        };
      }
      return createListSurfacesExec()(_cmd, args);
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec,
      skipAgentLifecycle: true,
      drainTimeoutMs: 500,
    });

    await daemon.start();
    let socket: net.Socket | null = null;
    try {
      socket = net.createConnection(path);
      socket.on("error", () => {});
      const messages: Record<string, any>[] = [];
      const messageEvents = new EventEmitter();
      let buffer = "";
      const send = (message: Record<string, unknown>) => {
        socket?.write(`${JSON.stringify(message)}\n`);
      };
      const waitForResponse = (id: number) => {
        const existing = messages.find((message) => message.id === id);
        if (existing) {
          return Promise.resolve(existing);
        }
        return new Promise<Record<string, any>>((resolve, reject) => {
          const timeout = setTimeout(() => {
            messageEvents.off("message", onMessage);
            reject(new Error(`timed out waiting for response ${id}`));
          }, 500);
          const onMessage = (message: Record<string, any>) => {
            if (message.id !== id) {
              return;
            }
            clearTimeout(timeout);
            messageEvents.off("message", onMessage);
            resolve(message);
          };
          messageEvents.on("message", onMessage);
        });
      };
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) {
            continue;
          }
          const message = JSON.parse(line);
          messages.push(message);
          messageEvents.emit("message", message);
        }
      });

      await once(socket, "connect");
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw-drain-test", version: "0.1.0" },
        },
      });
      await waitForResponse(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_surfaces", arguments: { verbose: false } },
      });

      await started.promise;
      const shutdown = daemon.shutdown("SIGTERM");
      await delay(10);
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_surfaces", arguments: { verbose: false } },
      });
      await delay(30);

      expect(listWorkspacesCalls).toBe(1);
      gate.resolve({
        stdout: JSON.stringify({ workspaces: [] }),
        stderr: "",
      });
      await expect(waitForResponse(2)).resolves.toMatchObject({ id: 2 });
      await expect(shutdown).resolves.toMatchObject({ forced: false });
      expect(listWorkspacesCalls).toBe(1);
    } finally {
      socket?.destroy();
      await daemon.shutdown().catch(() => {});
    }
  });

  it("keeps drain pending until response bytes finish writing", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("drain-waits-for-write");
    const gate = deferred<{ stdout: string; stderr: string }>();
    const started = deferred<void>();
    const responseWriteStarted = deferred<void>();
    const responseWriteFlushed = deferred<void>();
    let responseWriteCallback: (() => void) | null = null;
    let delayNextResponseWrite = false;
    const releaseResponseWrite = () => {
      const callback = responseWriteCallback;
      responseWriteCallback = null;
      callback?.();
    };
    const exec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        started.resolve();
        return gate.promise;
      }
      return createListSurfacesExec()(_cmd, args);
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec,
      skipAgentLifecycle: true,
      drainTimeoutMs: 500,
      serverFactory: (connectionListener) =>
        net.createServer((socket) => {
          const originalWrite = socket.write.bind(
            socket,
          ) as typeof socket.write;
          socket.write = ((
            chunk: any,
            encodingOrCallback?: any,
            callback?: any,
          ) => {
            const payload = Buffer.isBuffer(chunk)
              ? chunk.toString("utf8")
              : String(chunk);
            const encoding =
              typeof encodingOrCallback === "function"
                ? undefined
                : encodingOrCallback;
            const writeCallback =
              typeof encodingOrCallback === "function"
                ? encodingOrCallback
                : callback;
            if (delayNextResponseWrite && payload.includes('"id"')) {
              delayNextResponseWrite = false;
              responseWriteStarted.resolve();
              const deferredCallback = (error?: Error | null) => {
                responseWriteCallback = () => writeCallback?.(error);
                responseWriteFlushed.resolve();
              };
              if (encoding === undefined) {
                return originalWrite(chunk, deferredCallback);
              }
              return originalWrite(chunk, encoding, deferredCallback);
            }
            return originalWrite(chunk, encodingOrCallback, callback);
          }) as typeof socket.write;
          connectionListener(socket);
        }),
    });

    await daemon.start();
    let client: Client | null = null;
    try {
      client = await connectClient(path);
      const pending = client.callTool({
        name: "list_surfaces",
        arguments: { verbose: false },
      });

      await started.promise;
      const shutdown = daemon.shutdown("SIGTERM");
      let shutdownSettled = false;
      const observedShutdown = shutdown.then((result) => {
        shutdownSettled = true;
        return result;
      });
      delayNextResponseWrite = true;
      gate.resolve({
        stdout: JSON.stringify({ workspaces: [] }),
        stderr: "",
      });
      await responseWriteStarted.promise;
      await responseWriteFlushed.promise;
      await delay(30);

      expect(daemon.inFlightRequestCount()).toBe(1);
      expect(shutdownSettled).toBe(false);

      releaseResponseWrite();

      await expect(pending).resolves.toMatchObject({
        structuredContent: expect.objectContaining({ ok: true }),
      });
      await expect(observedShutdown).resolves.toMatchObject({ forced: false });
    } finally {
      gate.resolve({
        stdout: JSON.stringify({ workspaces: [] }),
        stderr: "",
      });
      releaseResponseWrite();
      await client?.close().catch(() => {});
      await daemon.shutdown().catch(() => {});
    }
  });

  it("forces shutdown after the drain timeout when a request hangs", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("drain-timeout");
    const started = deferred<void>();
    const exec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        started.resolve();
        return new Promise(() => {});
      }
      return createListSurfacesExec()(_cmd, args);
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec,
      skipAgentLifecycle: true,
      drainTimeoutMs: 30,
    });

    await daemon.start();
    const client = await connectClient(path);
    const pending = client
      .callTool({
        name: "list_surfaces",
        arguments: { verbose: false },
      })
      .then(
        () => null,
        (error) => error,
      );

    await started.promise;
    await expect(daemon.shutdown("SIGTERM")).resolves.toMatchObject({
      forced: true,
    });
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Connection closed|closed/i);
    await client.close().catch(() => {});
  });

  it("closes client transports promptly when retirement interrupts a hung request", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("retirement-hung-request");
    const started = deferred<void>();
    const exec: ExecFn = vi.fn().mockImplementation(async (_cmd, args) => {
      if (args.includes("list-workspaces")) {
        started.resolve();
        return new Promise(() => {});
      }
      return createListSurfacesExec()(_cmd, args);
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec,
      skipAgentLifecycle: true,
      drainTimeoutMs: 2_000,
    });

    await daemon.start();
    const client = await connectClient(path);
    const pending = client
      .callTool({
        name: "list_surfaces",
        arguments: { verbose: false },
      })
      .then(
        () => null,
        (error) => error,
      );
    await started.promise;

    const shutdown = daemon.shutdown("irrecoverable-transport");
    await expect(
      Promise.race([
        shutdown,
        delay(200).then(() => {
          throw new Error("retirement left the client hanging");
        }),
      ]),
    ).resolves.toMatchObject({ forced: true });
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Connection closed|closed/i);
    await client.close().catch(() => {});
  });

  it("unlinks its owned socket after graceful shutdown", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("owned-cleanup");
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
    });

    await daemon.start();
    expect(existsSync(path)).toBe(true);
    await daemon.shutdown();
    expect(existsSync(path)).toBe(false);
  });

  it("does not unlink a replacement file that it does not own", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("foreign-replacement");
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
    });

    await daemon.start();
    rmSync(path, { force: true });
    writeFileSync(path, "replacement-owner");
    await daemon.shutdown();

    await expect(readFile(path, "utf8")).resolves.toBe("replacement-owner");
  });

  it("uses listen({ fd }) for socket activation without unlinking the socket path", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("fd");
    writeFileSync(path, "launchd-owned");
    const fakeServer = new EventEmitter() as net.Server;
    const listen = vi.fn((_opts: unknown, cb?: () => void) => {
      cb?.();
      return fakeServer;
    });
    const close = vi.fn((cb?: (err?: Error) => void) => {
      cb?.();
      return fakeServer;
    });
    Object.assign(fakeServer, {
      listen,
      close,
      on: fakeServer.on.bind(fakeServer),
      once: fakeServer.once.bind(fakeServer),
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      listenFd: 42,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
      serverFactory: () => fakeServer,
    });

    await daemon.start();

    expect(listen).toHaveBeenCalledWith({ fd: 42 }, expect.any(Function));
    await expect(readFile(path, "utf8")).resolves.toBe("launchd-owned");

    await daemon.shutdown();
  });

  it("does not unlink a live daemon socket when another daemon is running", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = socketPath("live-socket");
    const acceptedSockets = new Set<net.Socket>();
    const liveServer = net.createServer((socket) => {
      acceptedSockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => acceptedSockets.delete(socket));
      socket.end("live\n");
    });
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: createListSurfacesExec(),
      skipAgentLifecycle: true,
    });

    await listen(liveServer, path);

    try {
      await expect(daemon.start()).rejects.toThrow(/already.*running|in use/i);
      await expect(readOnce(path)).resolves.toBe("live\n");
    } finally {
      await daemon.shutdown().catch(() => {});
      for (const socket of acceptedSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => liveServer.close(() => resolve()));
    }
  });
});
