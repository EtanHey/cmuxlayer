import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import {
  CmuxLayerDaemon,
  SocketJsonRpcTransport,
} from "../src/daemon.js";
import type { ExecFn } from "../src/cmux-client.js";

const TEST_ROOT = join(tmpdir(), "cmuxlayer-daemon-test");

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

async function connectClient(path: string): Promise<Client> {
  const socket = net.createConnection(path);
  const transport = new SocketJsonRpcTransport(socket);
  const client = new Client({ name: "daemon-test", version: "0.1.0" });
  await client.connect(transport);
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

async function rawToolsList(path: string, timeoutMs = 500): Promise<{
  server?: string;
  toolCount?: number;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out waiting for tools/list after ${timeoutMs}ms`));
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

describe("CmuxLayerDaemon", () => {
  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
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
      toolCount: 17,
    });

    await daemon.shutdown();
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
});
