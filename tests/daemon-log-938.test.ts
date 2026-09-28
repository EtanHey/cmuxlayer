/**
 * #938 PR-B: daemon lifecycle errors and refused or gated connections survive
 * the spawning proxy exiting, in a size-capped log that control_health names.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import {
  CmuxLayerDaemon,
  runDaemon,
  SocketJsonRpcTransport,
} from "../src/daemon.js";
import {
  createServer,
  createServerContext as createProductionServerContext,
  type CreateServerOptions,
} from "../src/server.js";
import { CmuxSocketError } from "../src/cmux-socket-error.js";
import {
  MIN_DAEMON_LOG_MAX_BYTES,
  appendCoalescedDaemonLog,
  appendDaemonLog,
  daemonLogPath,
  defaultDaemonLogPath,
  describeLogError,
  disableDaemonLog,
  enableDaemonLog,
  flushDaemonLog,
} from "../src/daemon-log.js";
import type { ExecFn } from "../src/cmux-client.js";

// Unix socket paths cap near 104 bytes on macOS; keep the root short.
const TEST_ROOT = join("/tmp", "cmux938b");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux938b.sock";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await flushDaemonLog();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  disableDaemonLog();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function uniquePath(name: string, suffix = ""): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  const path = join(
    TEST_ROOT,
    `${name}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${suffix}`,
  );
  cleanups.push(() => {
    rmSync(path, { recursive: true, force: true });
    rmSync(`${path}.1`, { force: true });
  });
  return path;
}

function withTestObserver<T extends Omit<CreateServerOptions, "context">>(
  opts: T,
): T {
  return {
    ...opts,
    surfaceObserverOwnerIdProvider: () => TEST_OBSERVER_OWNER,
    surfaceObserverEpochProvider: () => `${TEST_OBSERVER_OWNER}@test`,
  };
}

function emptyExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("list-workspaces")) {
      return { stdout: JSON.stringify({ workspaces: [] }), stderr: "" };
    }
    return { stdout: "{}", stderr: "" };
  }) as unknown as ExecFn;
}

function rateLimitedError(): CmuxSocketError {
  return new CmuxSocketError(
    "rate_limited: Polling rate limited for this connection",
    "rate_limited",
  );
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

describe("#938 persistent daemon log", () => {
  it("records each failed lifecycle attempt and the eventual ready", async () => {
    vi.stubEnv("CMUXLAYER_LIFECYCLE_RETRY_BASE_MS", "5");
    vi.stubEnv("CMUXLAYER_LIFECYCLE_RETRY_MAX_MS", "20");
    const logPath = uniquePath("lifecycle", ".log");
    enableDaemonLog({ path: logPath });
    let calls = 0;
    const context = createProductionServerContext(
      withTestObserver({
        exec: emptyExec(),
        stateDir: uniquePath("state"),
        disableSpawnPreflight: true,
        lifecycleInitializer: async () => {
          calls += 1;
          if (calls === 1) throw rateLimitedError();
        },
      }),
    );
    cleanups.push(() => context.dispose());
    createServer({ context });

    await context.lifecycleReadyPromise;
    await flushDaemonLog();

    const log = readLog(logPath);
    expect(log).toMatch(
      /lifecycle_attempt_failed attempt=1 retry_in_ms=\d+ error_code=rate_limited error=CmuxSocketError: rate_limited/,
    );
    expect(log).toMatch(/lifecycle_ready attempts=2/);
  });

  it("names refused-or-gated connections and the log path in control_health", async () => {
    vi.stubEnv("CMUXLAYER_LIFECYCLE_RETRY_BASE_MS", "5");
    vi.stubEnv("CMUXLAYER_LIFECYCLE_RETRY_MAX_MS", "20");
    const logPath = uniquePath("gated", ".log");
    const context = createProductionServerContext(
      withTestObserver({
        exec: emptyExec(),
        stateDir: uniquePath("state"),
        disableSpawnPreflight: true,
        lifecycleInitializer: async () => {
          throw rateLimitedError();
        },
      }),
    );
    const path = uniquePath("daemon", ".sock");
    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      context,
      daemonLog: { path: logPath },
    });
    await daemon.start();
    cleanups.push(async () => {
      await daemon.shutdown();
      context.dispose();
    });

    const client = new Client({ name: "938b-test", version: "0.1.0" });
    await client.connect(new SocketJsonRpcTransport(net.createConnection(path)));
    cleanups.push(() => client.close());

    await waitUntil(() => readLog(logPath).includes("connection_gated"));
    expect(readLog(logPath)).toMatch(
      /connection_gated cause=lifecycle_not_ready state=retrying attempt=\d+ last_error_code=rate_limited/,
    );

    const health = await client.callTool({
      name: "control_health",
      arguments: {},
    });
    expect(
      (health.structuredContent as any).health.daemon_lifecycle.log_path,
    ).toBe(logPath);

    await client.close();
    await daemon.shutdown();
    // The daemon owned the log: shutdown flushed and closed it.
    expect(daemonLogPath()).toBeNull();
    expect(readLog(logPath)).toMatch(/daemon_stopped reason=manual/);
  });

  it("coalesces a storm of one cause into the first line plus a count", async () => {
    const logPath = uniquePath("coalesce", ".log");
    enableDaemonLog({ path: logPath });

    for (let index = 0; index < 50; index += 1) {
      appendCoalescedDaemonLog(
        "connection_gated",
        "lifecycle_not_ready:retrying:rate_limited",
        `cause=lifecycle_not_ready attempt=${index}`,
        30,
      );
    }
    await waitUntil(() => readLog(logPath).includes("repeated="));
    await flushDaemonLog();

    const lines = readLog(logPath).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("cause=lifecycle_not_ready attempt=0");
    expect(lines[1]).toMatch(
      /connection_gated cause=lifecycle_not_ready:retrying:rate_limited repeated=49 window_ms=30/,
    );
  });

  it("masks secret-shaped free text, not only the exact capability", async () => {
    const logPath = uniquePath("broad-redact", ".log");
    enableDaemonLog({ path: logPath });
    const hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";

    appendDaemonLog(
      "lifecycle_attempt_failed",
      `error=boom FOO_TOKEN=abc123secret api_key: "k-9" Authorization: Bearer eyJhbGciOi.payload.sig id=${hex}`,
    );
    await flushDaemonLog();

    const log = readLog(logPath);
    for (const secret of ["abc123secret", "k-9", "eyJhbGciOi", hex]) {
      expect(log).not.toContain(secret);
    }
    expect(log).toContain("FOO_TOKEN=[REDACTED]");
    expect(log).toContain("error=boom");
  });

  it("runDaemon in a test process writes no log unless the test asks", async () => {
    const sandbox = uniquePath("rundaemon");
    const daemon = await runDaemon({
      socketPath: join(sandbox, "d.sock"),
      exec: emptyExec(),
      skipAgentLifecycle: true,
      stateDir: join(sandbox, "state"),
      watchRegistryPath: join(sandbox, "watch.json"),
      detectStaleBuild: () => null,
    });
    cleanups.push(async () => {
      await daemon.shutdown();
    });

    expect(daemonLogPath()).toBeNull();
    await daemon.shutdown();
    expect(existsSync(defaultDaemonLogPath())).toBe(false);
  });

  it("caps the log at one live file plus one rotated file", async () => {
    const logPath = uniquePath("capped", ".log");
    enableDaemonLog({ path: logPath, maxBytes: 400 });

    for (let index = 0; index < 60; index += 1) {
      appendDaemonLog("lifecycle_attempt_failed", `attempt=${index} error=x`);
    }
    await flushDaemonLog();

    expect(statSync(logPath).size).toBeLessThanOrEqual(400);
    expect(statSync(`${logPath}.1`).size).toBeLessThanOrEqual(400);
    expect(readLog(logPath)).toContain("attempt=59");
  });

  it("redacts the cmux capability and keeps each entry on one line", async () => {
    vi.stubEnv("CMUX_SOCKET_CAPABILITY", "cap-secret-938");
    const logPath = uniquePath("redact", ".log");
    enableDaemonLog({ path: logPath });

    appendDaemonLog("connection_refused", "cause=cap-secret-938 failed\nsecond line");
    await flushDaemonLog();

    const log = readLog(logPath);
    expect(log).not.toContain("cap-secret-938");
    expect(log).toContain("[REDACTED]");
    expect(log.trimEnd().split("\n")).toHaveLength(1);
  });

  it("writes nothing unless the daemon enabled it", async () => {
    const logPath = uniquePath("disabled", ".log");
    vi.stubEnv("CMUXLAYER_DAEMON_LOG_PATH", logPath);

    appendDaemonLog("connection_refused", "cause=test");
    await flushDaemonLog();

    expect(existsSync(logPath)).toBe(false);
  });

  it("never does disk I/O on the caller's path, even in a burst", async () => {
    const logPath = uniquePath("burst", ".log");
    enableDaemonLog({ path: logPath });

    for (let index = 0; index < 5_000; index += 1) {
      appendDaemonLog("connection_gated", `cause=storm ${index}`);
    }
    // Nothing is written synchronously: the file appears only after the
    // async writer runs.
    expect(existsSync(logPath)).toBe(false);

    await flushDaemonLog();
    const log = readLog(logPath);
    expect(log).toContain("cause=storm 0");
    expect(log).toMatch(/daemon_log_dropped lines=\d+/);
  });

  it("keeps whole, bounded lines under a tiny configured cap", async () => {
    const logPath = uniquePath("tiny-cap", ".log");
    enableDaemonLog({ path: logPath, maxBytes: 50 });

    for (let index = 0; index < 20; index += 1) {
      appendDaemonLog(
        "lifecycle_attempt_failed",
        `attempt=${index} error=${"x".repeat(400)}`,
      );
    }
    await flushDaemonLog();

    for (const file of [logPath, `${logPath}.1`]) {
      const text = readLog(file);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(
        MIN_DAEMON_LOG_MAX_BYTES,
      );
      expect(text.endsWith("\n")).toBe(true);
      for (const line of text.trimEnd().split("\n")) {
        expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z pid=\d+ lifecycle_attempt_failed /);
      }
    }
    expect(readLog(logPath)).toContain("attempt=19");
  });

  it("never lets a lone CR or a Unicode separator forge an entry", async () => {
    const logPath = uniquePath("forge", ".log");
    enableDaemonLog({ path: logPath });

    appendDaemonLog(
      "connection_refused",
      "cause=a\r2026-01-01T00:00:00.000Z pid=1 daemon_fatal forged\u2028x\u0085y\u0007z",
    );
    await flushDaemonLog();

    const log = readLog(logPath);
    expect(log.split("\n").filter(Boolean)).toHaveLength(1);
    expect(log).not.toMatch(/[\r\u2028\u0085\u0007]/);
    expect(log).toContain("cause=a | 2026-01-01T00:00:00.000Z pid=1 daemon_fatal forged | x | yz");
  });

  it("describes hostile errors without throwing", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter");
      },
    });
    const hostileString = {
      toString() {
        throw new Error("toString");
      },
    };

    expect(describeLogError(hostile)).toBe("<unprintable error>");
    expect(describeLogError(hostileString)).toBe("<unprintable error>");
  });
});
