import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runDaemon,
  SocketJsonRpcTransport,
  type CmuxLayerDaemon,
} from "../src/daemon.js";
import {
  defaultWatchRegistryPath,
  readWatchRegistry,
} from "../src/watch-spec.js";
import net from "node:net";

const TEST_DIR = join(tmpdir(), "cmuxlayer-watch-spec-production-test");

function productionClient() {
  return {
    currentSocketPath: vi.fn(() => join(TEST_DIR, "cmux.sock")),
    listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    listPanes: vi.fn().mockResolvedValue({ panes: [] }),
    listPaneSurfaces: vi.fn().mockResolvedValue({ surfaces: [] }),
    listSurfaces: vi.fn().mockResolvedValue([]),
    readScreen: vi.fn(),
    log: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    setStatuses: vi.fn().mockResolvedValue(true),
    clearStatus: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    clearProgress: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn(),
    selectWorkspace: vi.fn(),
    newSplit: vi.fn(),
    newSurface: vi.fn(),
    focusSurface: vi.fn(),
    send: vi.fn(),
    sendKey: vi.fn(),
    closeSurface: vi.fn(),
    identify: vi.fn().mockResolvedValue({}),
    browser: vi.fn().mockResolvedValue({}),
  };
}

describe("WatchSpec production wiring", () => {
  let daemon: CmuxLayerDaemon | null = null;
  let mcpClient: Client | null = null;
  let originalHome: string | undefined;
  const originalSigterm = new Set(process.listeners("SIGTERM"));
  const originalSigint = new Set(process.listeners("SIGINT"));

  afterEach(async () => {
    await mcpClient?.close().catch(() => {});
    await daemon?.shutdown().catch(() => {});
    for (const listener of process.listeners("SIGTERM")) {
      if (!originalSigterm.has(listener))
        process.removeListener("SIGTERM", listener);
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!originalSigint.has(listener))
        process.removeListener("SIGINT", listener);
    }
    daemon = null;
    mcpClient = null;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("boots the production daemon, arms through MCP, and heartbeats on its lifecycle sweep", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = TEST_DIR;
    const socketPath = join(TEST_DIR, "daemon.sock");
    const registryPath = defaultWatchRegistryPath();
    const target = join(TEST_DIR, "findings.md");
    writeFileSync(target, "", "utf8");
    let now = 1_000;
    daemon = await runDaemon({
      socketPath,
      client: productionClient() as any,
      stateDir: join(TEST_DIR, "state"),
      watchRegistryNow: () => now,
      watchNotify: vi.fn().mockResolvedValue(true),
      staleCheckIntervalMs: 60_000,
    });

    const socket = net.createConnection(socketPath);
    mcpClient = new Client({ name: "watch-production-test", version: "0.1.0" });
    await mcpClient.connect(new SocketJsonRpcTransport(socket));
    const armed = await mcpClient.callTool({
      name: "arm_watch",
      arguments: {
        owner: "lead-a",
        target,
        marker: "DONE",
        deadline: 10_000,
      },
    });
    expect(armed.isError).not.toBe(true);
    expect(
      readWatchRegistry({ registryPath }).watches[0]?.last_heartbeat_at_ms,
    ).toBe(1_000);

    now = 2_000;
    const context = await (
      daemon as unknown as {
        getContext(): Promise<{
          lifecycleSweepEngine: { runSweep(): Promise<void> } | null;
        }>;
      }
    ).getContext();
    await context.lifecycleSweepEngine?.runSweep();

    expect(readWatchRegistry({ registryPath }).watches[0]).toMatchObject({
      state: "armed",
      last_heartbeat_at_ms: 2_000,
      liveness_source: target,
    });
  });
});
