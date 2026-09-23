import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  defaultDaemonSocketPath,
  runDaemonFirstEntry,
  type DaemonFirstEntryOptions,
} from "../src/entry.js";
import { AgentEngine } from "../src/agent-engine.js";
import { createServer } from "../src/server.js";

function createEntryOptions(
  overrides: Partial<DaemonFirstEntryOptions> = {},
): DaemonFirstEntryOptions {
  return {
    env: {},
    logger: { error: vi.fn() },
    output: { write: vi.fn() } as unknown as Writable,
    probeDaemon: vi.fn().mockResolvedValue(true),
    probeCmuxSocket: vi.fn().mockResolvedValue({
      usable: true,
      socketPath: "/tmp/cmux.sock",
    }),
    runProxy: vi.fn().mockResolvedValue({ stop: vi.fn() }),
    spawnDaemon: vi.fn(),
    startInProcess: vi.fn().mockResolvedValue({
      close: vi.fn(),
    }),
    sleep: vi.fn().mockResolvedValue(undefined),
    autostartTimeoutMs: 0,
    ...overrides,
  };
}

describe("daemon-first MCP entry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the state-dir daemon socket by default and allows an env override", () => {
    expect(defaultDaemonSocketPath({})).toBe(
      join(homedir(), ".local", "state", "cmux", "cmuxlayer-stated.sock"),
    );
    expect(
      defaultDaemonSocketPath({
        CMUXLAYER_DAEMON_SOCKET: "/custom/cmuxlayer.sock",
      } as NodeJS.ProcessEnv),
    ).toBe("/custom/cmuxlayer.sock");
  });

  it("connects to an already-running daemon and starts only the thin proxy", async () => {
    const startSweep = vi.spyOn(AgentEngine.prototype, "startSweep");
    const opts = createEntryOptions({
      env: { CMUXLAYER_DAEMON_SOCKET: "/tmp/running-daemon.sock" },
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("daemon-proxy");
    expect(opts.probeDaemon).toHaveBeenCalledWith("/tmp/running-daemon.sock");
    expect(opts.runProxy).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: "/tmp/running-daemon.sock" }),
    );
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(opts.startInProcess).not.toHaveBeenCalled();
    expect(startSweep).not.toHaveBeenCalled();
  });

  it("autostarts the daemon when absent, then forwards through the proxy", async () => {
    const probeDaemon = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const opts = createEntryOptions({
      env: { CMUXLAYER_DAEMON_SOCKET: "/tmp/autostarted.sock" },
      probeDaemon,
      autostartTimeoutMs: 100,
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("daemon-proxy");
    expect(opts.spawnDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: "/tmp/autostarted.sock" }),
    );
    expect(opts.runProxy).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: "/tmp/autostarted.sock" }),
    );
    expect(opts.startInProcess).not.toHaveBeenCalled();
  });

  it("does not autostart a daemon when this proxy is denied by cmux", async () => {
    const logger = { error: vi.fn() };
    const opts = createEntryOptions({
      env: { CMUXLAYER_DAEMON_SOCKET: "/tmp/denied-parent.sock" },
      logger,
      probeDaemon: vi.fn().mockResolvedValue(false),
      probeCmuxSocket: vi.fn().mockResolvedValue({
        usable: false,
        socketPath: "/tmp/cmux.sock",
        denied_reason: "access-control",
        error: "Access denied - only processes started inside cmux can connect",
      }),
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("in-process");
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(opts.runProxy).not.toHaveBeenCalled();
    expect(opts.startInProcess).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/daemon must be spawned from inside a cmux pane/i),
    );
  });

  it("REG1 initializes and lists tools within five seconds without cmux", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "cmuxlayer-reg1-"));
    const logger = { error: vi.fn() };
    const opts = createEntryOptions({
      logger,
      probeDaemon: vi.fn().mockResolvedValue(false),
      probeCmuxSocket: vi.fn().mockResolvedValue({
        usable: false,
        socketPath: "/tmp/missing-cmux.sock",
      }),
      spawnDaemon: vi.fn().mockResolvedValue(undefined),
      startInProcess: vi.fn().mockImplementation(async ({ fallbackWarnings }) =>
        createServer({
          stateDir,
          skipAgentLifecycle: true,
          exposeInternalToolsForTests: false,
          controlHealthWarnings: fallbackWarnings,
          exec: vi.fn().mockRejectedValue(
            Object.assign(new Error("Command failed: cmux list-windows\nError: Socket not found at /tmp/missing-cmux.sock"), { code: 1 }),
          ),
        }),
      ),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      autostartTimeoutMs: 5_500,
    });
    const startedAt = Date.now();
    let mcpClient: Client | null = null;
    let result: Awaited<ReturnType<typeof runDaemonFirstEntry>> | null = null;
    try {
      result = await runDaemonFirstEntry(opts);
      expect(result.mode).toBe("in-process");
      if (result.mode !== "in-process") return;
      mcpClient = new Client({ name: "reg1-no-cmux", version: "0.1.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        result.server.connect(serverTransport),
        mcpClient.connect(clientTransport),
      ]);
      expect(mcpClient.getServerVersion()?.name).toBe("cmuxlayer");
      const tools = (await mcpClient.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain("list_surfaces");
      expect(tools).toContain("control_health");
      expect(Date.now() - startedAt).toBeLessThanOrEqual(5_000);

      const unavailable = await mcpClient.callTool({
        name: "list_surfaces",
        arguments: {},
      });
      expect(unavailable.isError).toBe(true);
      expect(unavailable.structuredContent).toMatchObject({
        error_code: "cmux_unavailable",
        retryable: true,
      });
      expect(opts.spawnDaemon).not.toHaveBeenCalled();
      expect(opts.runProxy).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("cmux is unavailable"),
      );
    } finally {
      await mcpClient?.close();
      if (result?.mode === "in-process") await result.server.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 12_000);

  it("REG1b passes the probed instance env into the no-cmux fallback", async () => {
    const env = {
      CMUX_SOCKET_PATH: "/tmp/reg1b-instance-a.sock",
      CMUX_SOCKET_CAPABILITY: "instance-a-token",
    };
    const opts = createEntryOptions({
      env,
      probeDaemon: vi.fn().mockResolvedValue(false),
      probeCmuxSocket: vi.fn().mockResolvedValue({
        usable: false,
        socketPath: env.CMUX_SOCKET_PATH,
      }),
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("in-process");
    expect(opts.startInProcess).toHaveBeenCalledWith(
      expect.objectContaining({ env }),
    );
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(opts.runProxy).not.toHaveBeenCalled();
  });

  it("falls back to in-process mode with a loud warning when daemon start fails", async () => {
    const logger = { error: vi.fn() };
    const opts = createEntryOptions({
      env: { CMUXLAYER_DAEMON_SOCKET: "/tmp/down.sock" },
      logger,
      probeDaemon: vi.fn().mockResolvedValue(false),
      spawnDaemon: vi.fn().mockRejectedValue(new Error("spawn denied")),
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("in-process");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("WARNING: daemon unavailable"),
    );
    expect(opts.startInProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackWarnings: [
          expect.stringContaining(
            "daemon unavailable; using heavy in-process runtime",
          ),
        ],
      }),
    );
    expect(opts.runProxy).not.toHaveBeenCalled();
  });

  it("terminates an autostarted daemon before fallback when readiness times out", async () => {
    const spawned = { kill: vi.fn() };
    const opts = createEntryOptions({
      env: { CMUXLAYER_DAEMON_SOCKET: "/tmp/slow.sock" },
      probeDaemon: vi.fn().mockResolvedValue(false),
      spawnDaemon: vi.fn().mockResolvedValue(spawned),
      autostartTimeoutMs: 0,
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("in-process");
    expect(spawned.kill).toHaveBeenCalledWith("SIGTERM");
    expect(opts.startInProcess).toHaveBeenCalled();
  });

  it("uses the proxy instead of killing the autostarted daemon if the final timeout re-probe succeeds", async () => {
    const spawned = { kill: vi.fn() };
    const probeDaemon = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const opts = createEntryOptions({
      env: { CMUXLAYER_DAEMON_SOCKET: "/tmp/raced-online.sock" },
      probeDaemon,
      spawnDaemon: vi.fn().mockResolvedValue(spawned),
      autostartTimeoutMs: 0,
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("daemon-proxy");
    expect(spawned.kill).not.toHaveBeenCalled();
    expect(opts.runProxy).toHaveBeenCalledWith(
      expect.objectContaining({ socketPath: "/tmp/raced-online.sock" }),
    );
    expect(opts.startInProcess).not.toHaveBeenCalled();
  });

  it("stops the proxy and exits when daemon-proxy stdin ends", async () => {
    const input = new PassThrough();
    const proxy = { stop: vi.fn().mockResolvedValue(undefined) };
    const exit = vi.fn();
    const opts = createEntryOptions({
      input,
      runProxy: vi.fn().mockResolvedValue(proxy),
      exit,
    });

    await runDaemonFirstEntry(opts);
    input.emit("end");
    await Promise.resolve();
    await Promise.resolve();

    expect(proxy.stop).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("honors CMUXLAYER_FORCE_INPROCESS as a loud escape hatch", async () => {
    const logger = { error: vi.fn() };
    const opts = createEntryOptions({
      env: { CMUXLAYER_FORCE_INPROCESS: "1" },
      logger,
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("in-process");
    expect(opts.probeDaemon).not.toHaveBeenCalled();
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(opts.runProxy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("CMUXLAYER_FORCE_INPROCESS=1"),
    );
  });

  it("keeps a nonblank default palette isolated from a shared daemon", async () => {
    const logger = { error: vi.fn() };
    const opts = createEntryOptions({
      env: {
        CMUXLAYER_DEFAULT_PALETTE: "list_surfaces,control_health,read_screen",
      },
      logger,
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("in-process");
    expect(opts.probeDaemon).not.toHaveBeenCalled();
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(opts.runProxy).not.toHaveBeenCalled();
    expect(opts.startInProcess).toHaveBeenCalledWith({
      env: opts.env,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps a report-watch deadline override isolated from a shared daemon", async () => {
    const opts = createEntryOptions({
      env: { CMUXLAYER_REPORT_WATCH_DEADLINE_MS: "250" },
    });

    const result = await runDaemonFirstEntry(opts);

    expect(result.mode).toBe("in-process");
    expect(opts.probeDaemon).not.toHaveBeenCalled();
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(opts.runProxy).not.toHaveBeenCalled();
    expect(opts.startInProcess).toHaveBeenCalledWith({ env: opts.env });
  });
});
