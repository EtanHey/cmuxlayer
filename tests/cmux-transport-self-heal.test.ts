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
import { CmuxSocketError } from "../src/cmux-socket-error.js";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { createCmuxClient } from "../src/cmux-client-factory.js";
import {
  CmuxSelfHealingClient,
  decorrelatedJitterDelayMs,
  getTransportHealth,
  wrapCliWithSelfHeal,
  wrapSocketWithSelfHeal,
} from "../src/cmux-transport-self-heal.js";

const CAN_BIND_MOCK_SOCKET = process.env.CODEX_SANDBOX !== "seatbelt";
const ACCESS_CONTROL_DENIED_TEXT =
  "Access denied — only processes started inside cmux can connect";

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

function startAccessDeniedPingServer(
  socketPath: string,
): Promise<{ server: net.Server }> {
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
          const req = JSON.parse(line);
          conn.write(
            JSON.stringify({
              id: req.id,
              ok: false,
              error: {
                code: "access_denied",
                message: ACCESS_CONTROL_DENIED_TEXT,
              },
            }) + "\n",
          );
        }
      });
    });
    (server as unknown as { _conns: Set<net.Socket> })._conns = connections;
    server.listen(socketPath, () => resolve({ server }));
  });
}

async function waitForExpectation(
  assertion: () => void | Promise<void>,
  opts: { timeout: number; interval: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, opts.interval));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

describe.skipIf(!CAN_BIND_MOCK_SOCKET)("transport self-healing", () => {
  const servers: Array<{ server: net.Server; path: string }> = [];

  afterEach(async () => {
    vi.useRealTimers();
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

    expect(getTransportHealth(client)).toMatchObject({
      mode: "socket",
      degraded: false,
      current_socket_path: socketPath,
    });
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

    expect(getTransportHealth(client)).toMatchObject({
      mode: "cli",
      degraded: true,
    });

    const { server } = await startPingServer(socketPath);
    track(server, socketPath);

    await waitForExpectation(
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
    const cli = new CmuxClient({ exec, bin: "cmux" });
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

    await waitForExpectation(
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

  it("signals irrecoverable transport after repeated upstream denial failures", async () => {
    const socketPath = join(tmpdir(), `cmux-irrecoverable-${process.pid}.sock`);
    const onIrrecoverableTransport = vi.fn();
    const exec = vi.fn().mockRejectedValue(new Error("Broken pipe (errno 32)"));
    const probeSocketHealth = vi.fn().mockResolvedValue({
      usable: false,
      socketPath,
      error: "write EPIPE",
    });
    const client = wrapCliWithSelfHeal(new CmuxClient({ exec, bin: "cmux" }), {
      socketPath,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      probeSocketHealth,
      irrecoverableMinFailures: 2,
      irrecoverableMinDurationMs: 20,
      onIrrecoverableTransport,
    });

    await expect(client.listWorkspaces()).rejects.toThrow(/errno 32/i);
    await waitForExpectation(
      async () => expect(probeSocketHealth.mock.calls.length).toBeGreaterThan(1),
      { timeout: 1_000, interval: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(client.listWorkspaces()).rejects.toThrow(/errno 32/i);
    await waitForExpectation(
      async () => expect(onIrrecoverableTransport).toHaveBeenCalledTimes(1),
      { timeout: 1_000, interval: 5 },
    );

    client.stop();
  });

  it("signals retirement after repeated upstream connection failures", async () => {
    const socketPath = join(
      tmpdir(),
      `cmux-upstream-dead-${process.pid}.sock`,
    );
    let probeCountAtRetirement: number | undefined;
    const probeSocketHealth = vi.fn().mockResolvedValue({
      usable: false,
      socketPath,
      error: "connect ECONNREFUSED",
    });
    const onIrrecoverableTransport = vi.fn(() => {
      probeCountAtRetirement = probeSocketHealth.mock.calls.length;
    });
    const client = wrapCliWithSelfHeal(new CmuxClient(), {
      socketPath,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      probeSocketHealth,
      irrecoverableMinFailures: 3,
      irrecoverableMinDurationMs: 0,
      onIrrecoverableTransport,
    });

    await waitForExpectation(
      async () => expect(onIrrecoverableTransport).toHaveBeenCalledTimes(1),
      { timeout: 1_000, interval: 5 },
    );

    expect(onIrrecoverableTransport).toHaveBeenCalledTimes(1);
    expect(probeCountAtRetirement).toBe(3);
    client.stop();
  });

  it("signals retirement when an idle active upstream socket dies", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-idle-upstream-death-"));
    const socketPath = join(stateDir, "cmux.sock");
    const { server } = await startPingServer(socketPath);
    const onIrrecoverableTransport = vi.fn();
    const client = await createCmuxClient({
      socketPath,
      pingRetryAttempts: 1,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      irrecoverableMinFailures: 3,
      irrecoverableMinDurationMs: 0,
      onIrrecoverableTransport,
    });

    await stopPingServer(server, socketPath);
    await waitForExpectation(
      async () => expect(onIrrecoverableTransport).toHaveBeenCalledTimes(1),
      { timeout: 1_000, interval: 5 },
    );

    expect(getTransportHealth(client)).toMatchObject({
      mode: "cli",
      degraded: true,
    });
    if ("stop" in client && typeof client.stop === "function") {
      client.stop();
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("does not downgrade an active socket when a request starts during its health probe", async () => {
    const socketPath = join(tmpdir(), `cmux-probe-race-${process.pid}.sock`);
    let resolveProbe!: (result: {
      usable: boolean;
      socketPath: string;
      error?: string;
    }) => void;
    const probeSocketHealth = vi.fn(
      () =>
        new Promise<{
          usable: boolean;
          socketPath: string;
          error?: string;
        }>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    let resolveRequest!: (value: { workspaces: [] }) => void;
    const request = new Promise<{ workspaces: [] }>((resolve) => {
      resolveRequest = resolve;
    });
    const socket = {
      currentSocketPath: () => socketPath,
      disconnect: vi.fn(),
      listWorkspaces: vi.fn(() => request),
    } as unknown as CmuxSocketClient;
    const client = wrapSocketWithSelfHeal(socket, new CmuxClient(), {
      socketPath,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      probeSocketHealth,
    });

    await waitForExpectation(
      async () => expect(probeSocketHealth).toHaveBeenCalledTimes(1),
      { timeout: 1_000, interval: 5 },
    );
    const requestPromise = client.listWorkspaces();
    await waitForExpectation(
      async () => expect(socket.listWorkspaces).toHaveBeenCalledTimes(1),
      { timeout: 1_000, interval: 5 },
    );
    resolveProbe({
      usable: false,
      socketPath,
      error: "connect ECONNREFUSED",
    });
    await waitForExpectation(
      async () => expect((client as any).upgrading).toBe(false),
      { timeout: 1_000, interval: 5 },
    );

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(getTransportHealth(client)?.mode).toBe("socket");
    resolveRequest({ workspaces: [] });
    await expect(requestPromise).resolves.toEqual({ workspaces: [] });
    client.stop();
  });

  it("preserves the transport error when the irrecoverable callback throws", async () => {
    const socketPath = join(tmpdir(), `cmux-callback-throw-${process.pid}.sock`);
    const logger = { error: vi.fn() };
    const onIrrecoverableTransport = vi.fn(() => {
      throw new Error("retirement callback failed");
    });
    const exec = vi.fn().mockRejectedValue(new Error("Broken pipe (errno 32)"));
    const client = wrapCliWithSelfHeal(new CmuxClient({ exec, bin: "cmux" }), {
      socketPath,
      logger,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      retryAttempts: 1,
      probeSocketHealth: async () => ({
        usable: false,
        socketPath,
        error: "write EPIPE",
      }),
      irrecoverableMinFailures: 1,
      irrecoverableMinDurationMs: 0,
      onIrrecoverableTransport,
    });

    await waitForExpectation(
      async () =>
        expect(
          (client as any).upstreamProbeFailures,
        ).toBeGreaterThanOrEqual(1),
      { timeout: 1_000, interval: 5 },
    );
    await expect(client.listWorkspaces()).rejects.toThrow(/errno 32/i);
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer] irrecoverable transport callback failed",
      expect.objectContaining({ message: "retirement callback failed" }),
    );
    client.stop();
  });

  it("logs and reschedules after the socket health probe rejects", async () => {
    const socketPath = join(tmpdir(), `cmux-probe-reject-${process.pid}.sock`);
    const logger = { error: vi.fn() };
    const probeSocketHealth = vi
      .fn()
      .mockRejectedValueOnce(new Error("write EPIPE"))
      .mockResolvedValue({
        usable: false,
        socketPath,
        error: "connect ECONNREFUSED",
      });
    const client = wrapCliWithSelfHeal(new CmuxClient(), {
      socketPath,
      logger,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      probeSocketHealth,
    });

    await waitForExpectation(
      async () => expect(probeSocketHealth.mock.calls.length).toBeGreaterThan(1),
      { timeout: 1_000, interval: 5 },
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("transport upgrade failed"),
    );
    client.stop();
  });

  it("counts the factory initial denial as the first socket denial", async () => {
    const socketPath = join(tmpdir(), `cmux-initial-denial-${process.pid}.sock`);
    const onIrrecoverableTransport = vi.fn();
    const exec = vi.fn().mockRejectedValue(new Error("Broken pipe (errno 32)"));
    const probeSocketHealth = vi
      .fn()
      .mockResolvedValueOnce({ usable: false, socketPath, error: "write EPIPE" })
      .mockResolvedValue({
        usable: false,
        socketPath,
        error: "connect ECONNREFUSED",
      });
    const client = wrapCliWithSelfHeal(new CmuxClient({ exec, bin: "cmux" }), {
      socketPath,
      retryAttempts: 1,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      initialDenial: {
        denied_reason: "access-control",
        socketPath,
        error: "write EPIPE",
      },
      probeSocketHealth,
      irrecoverableMinFailures: 2,
      irrecoverableMinDurationMs: 0,
      onIrrecoverableTransport,
    });

    await expect(client.listWorkspaces()).rejects.toThrow(/errno 32/i);
    await waitForExpectation(
      async () => expect(probeSocketHealth).toHaveBeenCalledTimes(1),
      { timeout: 1_000, interval: 5 },
    );
    await expect(client.listWorkspaces()).rejects.toThrow(/errno 32/i);

    expect(onIrrecoverableTransport).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("counts upstream probe failures until a usable socket probe resets them", () => {
    const client = wrapCliWithSelfHeal(new CmuxClient(), {
      socketPath: "/tmp/cmux-preserve-denial.sock",
      reprobeIntervalMs: 60_000,
    });
    const internals = client as any;

    internals.recordProbeResult({
      usable: false,
      socketPath: "/tmp/cmux-preserve-denial.sock",
      error: "write EPIPE",
    });
    internals.recordCliFailure(new Error("Broken pipe (errno 32)"));

    internals.recordProbeResult({
      usable: false,
      socketPath: "/tmp/cmux-preserve-denial.sock",
      error: "connect ECONNREFUSED",
    });
    internals.recordProbeFailure(new Error("probe timeout"));
    internals.recordCliFailure(new Error("connect ENOENT"));

    expect(internals.upstreamProbeFailures).toBe(3);
    expect(internals.cliDenialFailures).toBe(1);

    internals.recordProbeResult({
      usable: true,
      socketPath: "/tmp/cmux-preserve-denial.sock",
    });

    expect(internals.upstreamProbeFailures).toBe(0);
    expect(internals.upstreamProbeStartedAt).toBeNull();
    expect(internals.cliDenialFailures).toBe(0);
    client.stop();
  });

  it("rate-limits upstream failure progress logs", () => {
    let now = 1_000;
    const logger = { error: vi.fn() };
    const client = wrapCliWithSelfHeal(new CmuxClient(), {
      socketPath: "/tmp/cmux-denial-progress.sock",
      logger,
      now: () => now,
      reprobeIntervalMs: 60_000,
      irrecoverableMinFailures: 3,
      irrecoverableMinDurationMs: 60_000,
    });
    const internals = client as any;
    logger.error.mockClear();

    internals.recordUpstreamProbeFailure();
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer] upstream failure evidence 1/3 probes, 0 cli denials, 0s",
    );

    now += 1_000;
    internals.recordCliFailure(new Error("write EPIPE"));
    expect(logger.error).toHaveBeenCalledTimes(1);

    now += 29_000;
    internals.recordCliFailure(new Error("write EPIPE"));
    expect(logger.error).toHaveBeenLastCalledWith(
      "[cmuxlayer] upstream failure evidence 1/3 probes, 2 cli denials, 30s",
    );
    client.stop();
  });

  it("attributes retry bookkeeping to the delegate used for that attempt", async () => {
    const client = wrapCliWithSelfHeal(new CmuxClient(), {
      socketPath: "/tmp/cmux-retry-attribution.sock",
      retryAttempts: 2,
      retryBaseMs: 0,
      retryCapMs: 0,
      sleep: async () => {},
      reprobeIntervalMs: 60_000,
    });
    const internals = client as any;
    internals.cliDenialFailures = 1;
    internals.delegate = {
      listWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    };

    await expect(
      internals.retryPayload({
        method: "listWorkspaces",
        args: [],
        error: new Error("write EPIPE"),
      }),
    ).resolves.toEqual({ workspaces: [] });
    expect(internals.cliDenialFailures).toBe(1);

    internals.cliDenialFailures = 0;
    internals.delegate = {
      listWorkspaces: vi.fn().mockRejectedValue(new Error("write EPIPE")),
    };
    await expect(
      internals.retryPayload({
        method: "listWorkspaces",
        args: [],
        error: new Error("write EPIPE"),
      }),
    ).rejects.toThrow(/EPIPE/);
    expect(internals.cliDenialFailures).toBe(0);
    client.stop();
  });

  it("signals irrecoverable transport when the cmux app remains down", async () => {
    const socketPath = join(tmpdir(), `cmux-app-down-${process.pid}.sock`);
    const onIrrecoverableTransport = vi.fn();
    const exec = vi.fn().mockRejectedValue(new Error("Broken pipe (errno 32)"));
    const probeSocketHealth = vi.fn().mockResolvedValue({
      usable: false,
      socketPath,
      error: "connect ECONNREFUSED",
    });
    const client = wrapCliWithSelfHeal(new CmuxClient({ exec, bin: "cmux" }), {
      socketPath,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      probeSocketHealth,
      irrecoverableMinFailures: 2,
      irrecoverableMinDurationMs: 10,
      onIrrecoverableTransport,
    });

    await expect(client.listWorkspaces()).rejects.toThrow(/errno 32/i);
    await waitForExpectation(
      async () => expect(probeSocketHealth.mock.calls.length).toBeGreaterThan(2),
      { timeout: 1_000, interval: 5 },
    );
    await expect(client.listWorkspaces()).rejects.toThrow(/errno 32/i);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onIrrecoverableTransport).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("logs the error class when a socket upgrade attempt fails", async () => {
    const socketPath = join(tmpdir(), `cmux-upgrade-log-${process.pid}.sock`);
    const logger = { error: vi.fn() };
    const probeSocketHealth = vi.fn().mockResolvedValue({
      usable: true,
      socketPath,
    });
    const client = wrapCliWithSelfHeal(new CmuxClient(), {
      socketPath,
      factoryOpts: { socketPath },
      logger,
      reprobeIntervalMs: 5,
      reprobeCapMs: 5,
      random: () => 0,
      probeSocketHealth,
    });

    await waitForExpectation(
      async () =>
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("transport upgrade failed"),
        ),
      { timeout: 1_000, interval: 5 },
    );

    client.stop();
  });

  it("logs and exposes cmux access-control denial instead of generic CLI fallback", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmux-access-denied-"));
    const socketPath = join(stateDir, "denied.sock");
    const { server } = await startAccessDeniedPingServer(socketPath);
    track(server, socketPath);
    const logger = { error: vi.fn() };
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });

    const client = await createCmuxClient({
      socketPath,
      exec,
      bin: "cmux",
      logger,
      reprobeIntervalMs: 60_000,
    });

    expect(getTransportHealth(client)).toMatchObject({
      mode: "cli",
      degraded: true,
      current_socket_path: socketPath,
      denied_reason: "access-control",
      last_error: expect.stringContaining(ACCESS_CONTROL_DENIED_TEXT),
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("transport denied: access-control"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(ACCESS_CONTROL_DENIED_TEXT),
    );
    await expect(client.listWorkspaces()).resolves.toEqual({ workspaces: [] });
    if ("stop" in client && typeof client.stop === "function") {
      client.stop();
    }
  });

  it("downgrades from socket to CLI after an EPIPE transport error", async () => {
    const socketPath = join(tmpdir(), `cmux-epipe-${process.pid}.sock`);
    const logger = { error: vi.fn() };
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const cli = new CmuxClient({ exec, bin: "cmux" });
    const socket = {
      currentSocketPath: () => socketPath,
      disconnect: vi.fn(),
      ping: vi
        .fn()
        .mockRejectedValue(
          new CmuxSocketError("Socket error: write EPIPE", "connection_error"),
        ),
    } as unknown as CmuxSocketClient;

    const client = wrapSocketWithSelfHeal(socket, cli, {
      socketPath,
      logger,
      reprobeIntervalMs: 60_000,
      factoryOpts: { socketPath },
    });

    await expect(client.ping()).rejects.toThrow(/EPIPE/);
    expect(getTransportHealth(client)).toEqual({
      mode: "cli",
      degraded: true,
      current_socket_path: socketPath,
    });

    await expect(client.listWorkspaces()).resolves.toEqual({ workspaces: [] });
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      ["--json", "list-workspaces"],
      expect.objectContaining({ CMUX_SOCKET_PATH: socketPath }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer] transport downgraded: socket -> cli (periodic socket re-probe active)",
    );
    client.stop();
  });

  it("queues and flushes a failed socket payload through CLI after EPIPE", async () => {
    const socketPath = join(tmpdir(), `cmux-queue-${process.pid}.sock`);
    const logger = { error: vi.fn() };
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
    });
    const cli = new CmuxClient({ exec, bin: "cmux" });
    const socket = {
      currentSocketPath: () => socketPath,
      disconnect: vi.fn(),
      send: vi
        .fn()
        .mockRejectedValue(
          new CmuxSocketError("Socket error: write EPIPE", "connection_error"),
        ),
      ping: vi
        .fn()
        .mockRejectedValue(
          new CmuxSocketError("Socket error: write EPIPE", "connection_error"),
        ),
    } as unknown as CmuxSocketClient;

    const client = wrapSocketWithSelfHeal(socket, cli, {
      socketPath,
      logger,
      reprobeIntervalMs: 60_000,
      factoryOpts: { socketPath },
    });

    await expect(
      client.send("surface:1", "lost payload", { workspace: "workspace:1" }),
    ).resolves.toBeUndefined();

    expect(socket.send).toHaveBeenCalledWith("surface:1", "lost payload", {
      workspace: "workspace:1",
    });
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      [
        "--json",
        "send",
        "--surface",
        "surface:1",
        "--workspace",
        "workspace:1",
        "lost payload",
      ],
      expect.objectContaining({ CMUX_SOCKET_PATH: socketPath }),
    );
    expect(getTransportHealth(client)).toMatchObject({
      mode: "cli",
      degraded: true,
      current_socket_path: socketPath,
    });
    client.stop();
  });

  it("retries an interactive CLI call after errno 32 with injected backoff", async () => {
    vi.useFakeTimers();
    const transportFailure = Object.assign(
      new Error("Failed to write to socket (Broken pipe, errno 32)"),
      { code: 1, stderr: "Failed to write to socket (Broken pipe, errno 32)" },
    );
    const exec = vi
      .fn()
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ workspaces: [] }),
        stderr: "",
      });
    const client = wrapCliWithSelfHeal(new CmuxClient({ exec, bin: "cmux" }), {
      socketPath: "/tmp/retry.sock",
      reprobeIntervalMs: 60_000,
      retryBaseMs: 100,
      retryCapMs: 400,
      retryAttempts: 3,
      random: () => 0,
    });

    const result = client.listWorkspaces();
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({ workspaces: [] });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(client.consumeRetryCount()).toBe(1);
    client.stop();
  });

  it("surfaces exhausted transport state and retry count", async () => {
    vi.useFakeTimers();
    const transportFailure = Object.assign(
      new Error("write ECONNRESET"),
      { code: 1, stderr: "write ECONNRESET" },
    );
    const exec = vi.fn().mockRejectedValue(transportFailure);
    const client = wrapCliWithSelfHeal(new CmuxClient({ exec, bin: "cmux" }), {
      socketPath: "/tmp/retry-exhausted.sock",
      reprobeIntervalMs: 60_000,
      retryBaseMs: 100,
      retryCapMs: 400,
      retryAttempts: 3,
      random: () => 0,
    });

    const result = client.listWorkspaces();
    const rejection = expect(result).rejects.toMatchObject({
      retry_count: 2,
      transport_state: "write_failed",
    });
    await vi.advanceTimersByTimeAsync(200);

    await rejection;
    expect(exec).toHaveBeenCalledTimes(3);
    client.stop();
  });

  it("does not replay a mutation after a post-response transport failure", async () => {
    const socketPath = join(tmpdir(), `cmux-response-${process.pid}.sock`);
    const exec = vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" });
    const cli = new CmuxClient({
      exec,
      bin: "cmux",
    });
    const responseFailure = Object.assign(
      new CmuxSocketError("connection reset after response", "connection_error"),
      { transport_phase: "response" },
    );
    const socket = {
      currentSocketPath: () => socketPath,
      disconnect: vi.fn(),
      closeSurface: vi.fn().mockRejectedValue(responseFailure),
    } as unknown as CmuxSocketClient;
    const client = wrapSocketWithSelfHeal(socket, cli, {
      socketPath,
      reprobeIntervalMs: 60_000,
    });

    await expect(
      client.closeSurface("surface:1", { workspace: "workspace:1" }),
    ).rejects.toBe(responseFailure);
    expect(exec).not.toHaveBeenCalled();
    client.stop();
  });

  it("forwards deleteWorkspace through the self-healing transport", async () => {
    const socketPath = join(tmpdir(), `cmux-delete-workspace-${process.pid}.sock`);
    const cli = new CmuxClient({
      exec: vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" }),
      bin: "cmux",
    });
    const socket = {
      currentSocketPath: () => socketPath,
      disconnect: vi.fn(),
      deleteWorkspace: vi.fn().mockResolvedValue(undefined),
    } as unknown as CmuxSocketClient;
    const client = wrapSocketWithSelfHeal(socket, cli, {
      socketPath,
      reprobeIntervalMs: 60_000,
    });

    await (client as unknown as CmuxClient).deleteWorkspace("workspace:7");

    expect(socket.deleteWorkspace).toHaveBeenCalledWith("workspace:7");
    client.stop();
  });

  it("flushes queued failed payloads sequentially", async () => {
    const socketPath = join(tmpdir(), `cmux-queue-seq-${process.pid}.sock`);
    let activeFlushes = 0;
    let maxActiveFlushes = 0;
    const flushOrder: string[] = [];
    const exec = vi.fn().mockImplementation(async (_cmd, args) => {
      activeFlushes++;
      maxActiveFlushes = Math.max(maxActiveFlushes, activeFlushes);
      flushOrder.push(String(args.at(-1)));
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeFlushes--;
      return { stdout: JSON.stringify({ ok: true }), stderr: "" };
    });
    const cli = new CmuxClient({ exec, bin: "cmux" });
    const socket = {
      currentSocketPath: () => socketPath,
      disconnect: vi.fn(),
      send: vi
        .fn()
        .mockRejectedValue(
          new CmuxSocketError("Socket error: ECONNRESET", "connection_error", {
            transportPhase: "write",
          }),
        ),
      ping: vi
        .fn()
        .mockRejectedValue(
          new CmuxSocketError("Socket error: ECONNRESET", "connection_error"),
        ),
    } as unknown as CmuxSocketClient;

    const client = wrapSocketWithSelfHeal(socket, cli, {
      socketPath,
      reprobeIntervalMs: 60_000,
      factoryOpts: { socketPath },
    });

    await expect(
      Promise.all([
        client.send("surface:1", "first", { workspace: "workspace:1" }),
        client.send("surface:1", "second", { workspace: "workspace:1" }),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    expect(flushOrder).toEqual(["first", "second"]);
    expect(maxActiveFlushes).toBe(1);
    client.stop();
  });

  it("computes decorrelated jitter delays for re-probe scheduling", () => {
    expect(
      decorrelatedJitterDelayMs({
        baseMs: 100,
        previousMs: 100,
        capMs: 1_000,
        random: () => 0.5,
      }),
    ).toBe(200);
    expect(
      decorrelatedJitterDelayMs({
        baseMs: 100,
        previousMs: 200,
        capMs: 1_000,
        random: () => 0.5,
      }),
    ).toBe(350);
    expect(
      decorrelatedJitterDelayMs({
        baseMs: 100,
        previousMs: 1_000,
        capMs: 1_000,
        random: () => 1,
      }),
    ).toBe(1_000);
  });

  it("resumes socket re-probe after downgrading from a broken socket", async () => {
    const socketPath = join(tmpdir(), `cmux-recover-${process.pid}.sock`);
    const logger = { error: vi.fn() };
    const exec = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ workspaces: [] }),
      stderr: "",
    });
    const cli = new CmuxClient({ exec, bin: "cmux" });
    const socket = {
      currentSocketPath: () => socketPath,
      disconnect: vi.fn(),
      ping: vi
        .fn()
        .mockRejectedValue(
          new CmuxSocketError("Socket error: Broken pipe", "connection_error"),
        ),
    } as unknown as CmuxSocketClient;

    const client = wrapSocketWithSelfHeal(socket, cli, {
      socketPath,
      logger,
      reprobeIntervalMs: 20,
      factoryOpts: { socketPath },
    });
    expect(getTransportHealth(client)).toMatchObject({
      mode: "socket",
      degraded: false,
      current_socket_path: socketPath,
    });

    await expect(client.ping()).rejects.toThrow(/Broken pipe/i);
    expect(getTransportHealth(client)).toMatchObject({
      mode: "cli",
      degraded: true,
      current_socket_path: socketPath,
    });
    await expect(client.listWorkspaces()).resolves.toEqual({ workspaces: [] });
    expect(exec).toHaveBeenCalledWith(
      "cmux",
      ["--json", "list-workspaces"],
      expect.objectContaining({ CMUX_SOCKET_PATH: socketPath }),
    );

    const recovered = await startPingServer(socketPath);
    track(recovered.server, socketPath);

    await waitForExpectation(
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
      "[cmuxlayer] transport downgraded: socket -> cli (periodic socket re-probe active)",
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[cmuxlayer] transport upgraded: cli -> socket",
    );
    if ("stop" in client && typeof client.stop === "function") {
      client.stop();
    }
  });
});
