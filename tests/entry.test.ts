import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";
import {
  defaultDaemonSocketPath,
  runDaemonFirstEntry,
  type DaemonFirstEntryOptions,
} from "../src/entry.js";
import { AgentEngine } from "../src/agent-engine.js";

function createEntryOptions(
  overrides: Partial<DaemonFirstEntryOptions> = {},
): DaemonFirstEntryOptions {
  return {
    env: {},
    logger: { error: vi.fn() },
    output: { write: vi.fn() } as unknown as Writable,
    probeDaemon: vi.fn().mockResolvedValue(true),
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
          expect.stringContaining("daemon unavailable; using heavy in-process runtime"),
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
});
