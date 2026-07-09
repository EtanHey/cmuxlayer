/**
 * Phase 3 Scope A — transport self-healing (ping retry, CLI→socket upgrade, health).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CmuxClient } from "../src/cmux-client.js";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { createCmuxClient } from "../src/cmux-client-factory.js";
import {
  CmuxSelfHealingClient,
  getTransportHealth,
  wrapCliWithSelfHeal,
} from "../src/cmux-transport-self-heal.js";

const CAN_BIND_MOCK_SOCKET = process.env.CODEX_SANDBOX !== "seatbelt";

function startPingServer(
  socketPath: string,
  opts: { respondAfterAttempts?: number } = {},
): Promise<{ server: net.Server; attempts: { count: number } }> {
  const attempts = { count: 0 };
  return new Promise((resolve) => {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    const connections = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      connections.add(conn);
      conn.on("close", () => connections.delete(conn));
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          attempts.count += 1;
          const respondAfter = opts.respondAfterAttempts ?? 0;
          if (attempts.count <= respondAfter) {
            continue;
          }
          const req = JSON.parse(line);
          conn.write(
            JSON.stringify({ id: req.id, ok: true, result: { pong: true } }) +
              "\n",
          );
        }
      });
    });
    (server as unknown as { _conns: Set<net.Socket> })._conns = connections;
    server.listen(socketPath, () => resolve({ server, attempts }));
  });
}

function stopPingServer(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    const conns = (server as unknown as { _conns: Set<net.Socket> })._conns;
    for (const conn of conns ?? []) conn.destroy();
    server.close(() => {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
      resolve();
    });
  });
}

describe.skipIf(!CAN_BIND_MOCK_SOCKET)("transport self-healing", () => {
  const servers: Array<{ server: net.Server; path: string }> = [];

  afterEach(async () => {
    for (const { server, path } of servers.splice(0)) {
      await stopPingServer(server, path);
    }
  });

  function track(server: net.Server, path: string): void {
    servers.push({ server, path });
  }

  it("retries startup system.ping before falling back to CLI", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-retry-"));
    const socketPath = join(stateDir, "flaky.sock");
    const { server } = await startPingServer(socketPath, {
      respondAfterAttempts: 2,
    });
    track(server, socketPath);
    const logger = { error: vi.fn() };
    const sleep = vi.fn().mockResolvedValue(undefined);

    const client = await createCmuxClient({
      socketPath,
      logger,
      pingRetryAttempts: 3,
      pingRetryBackoffMs: [1, 1],
      sleep,
    });

    expect(client).toBeInstanceOf(CmuxSocketClient);
    expect(sleep).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer] transport selected: socket",
    );
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("upgrades from CLI to socket when the app recovers", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-upgrade-"));
    const socketPath = join(stateDir, "late.sock");
    const logger = { error: vi.fn() };
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });

    const client = await createCmuxClient({
      socketPath,
      exec,
      logger,
      pingRetryAttempts: 1,
      reprobeIntervalMs: 20,
    });

    expect(client).not.toBeInstanceOf(CmuxSocketClient);
    expect(getTransportHealth(client)).toMatchObject({
      mode: "cli",
      degraded: true,
    });

    const { server } = await startPingServer(socketPath);
    track(server, socketPath);

    await vi.waitFor(
      async () => {
        expect(await client.ping()).toBe(true);
      },
      { timeout: 2_000, interval: 25 },
    );

    expect(getTransportHealth(client)).toMatchObject({
      mode: "socket",
      degraded: false,
      current_socket_path: socketPath,
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer] transport degraded: cli (periodic socket re-probe active)",
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer] transport upgraded: cli -> socket",
    );
    if ("stop" in client && typeof client.stop === "function") {
      client.stop();
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("drains in-flight CLI calls before upgrading to socket", async () => {
    const socketPath = join(tmpdir(), `cmux-drain-${process.pid}.sock`);
    const logger = { error: vi.fn() };
    let releaseCli!: () => void;
    const cliGate = new Promise<void>((resolve) => {
      releaseCli = resolve;
    });
    const exec = vi.fn().mockImplementation(async () => {
      await cliGate;
      return {
        stdout: JSON.stringify({ workspaces: [] }),
        stderr: "",
      };
    });
    const cli = new CmuxClient({ exec });
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

    const client = wrapCliWithSelfHeal(cli, {
      socketPath,
      logger,
      reprobeIntervalMs: 15,
      probeUsable: probe,
      factoryOpts: { socketPath },
    });

    const listPromise = client.listWorkspaces();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probe).not.toHaveBeenCalledWith(socketPath, expect.anything());

    const { server } = await startPingServer(socketPath);
    track(server, socketPath);
    releaseCli();
    await listPromise;

    await vi.waitFor(
      async () => {
        expect(getTransportHealth(client)?.mode).toBe("socket");
      },
      { timeout: 2_000, interval: 25 },
    );
    client.stop();
  });

  it("reports degraded CLI transport via getTransportHealth", () => {
    const cli = new CmuxClient();
    const client = new CmuxSelfHealingClient({
      cli,
      socketPath: "/tmp/example.sock",
      reprobeIntervalMs: 60_000,
    });

    expect(getTransportHealth(client)).toEqual({
      mode: "cli",
      degraded: true,
      current_socket_path: "/tmp/example.sock",
    });
    client.stop();
  });
});
