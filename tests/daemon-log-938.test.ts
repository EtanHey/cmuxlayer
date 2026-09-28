/**
 * #938 PR-B: daemon lifecycle errors and refused or gated connections survive
 * the spawning proxy exiting, in a size-capped log that control_health names.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { CmuxLayerDaemon, SocketJsonRpcTransport } from "../src/daemon.js";
import {
  createServer,
  createServerContext as createProductionServerContext,
  type CreateServerOptions,
} from "../src/server.js";
import { CmuxSocketError } from "../src/cmux-socket-error.js";
import {
  appendDaemonLog,
  disableDaemonLog,
  enableDaemonLog,
} from "../src/daemon-log.js";
import type { ExecFn } from "../src/cmux-client.js";

// Unix socket paths cap near 104 bytes on macOS; keep the root short.
const TEST_ROOT = join("/tmp", "cmux938b");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux938b.sock";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
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

    const log = readLog(logPath);
    expect(log).toMatch(
      /lifecycle_attempt_failed attempt=1 retry_in_ms=\d+ error=CmuxSocketError: rate_limited/,
    );
    expect(log).toMatch(/lifecycle_ready attempts=2/);
  });

  it("names refused-or-gated connections and the log path in control_health", async () => {
    vi.stubEnv("CMUXLAYER_LIFECYCLE_RETRY_BASE_MS", "5");
    vi.stubEnv("CMUXLAYER_LIFECYCLE_RETRY_MAX_MS", "20");
    const logPath = uniquePath("gated", ".log");
    enableDaemonLog({ path: logPath });
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
    const daemon = new CmuxLayerDaemon({ socketPath: path, context });
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
      /connection_gated cause=lifecycle initializing: rate_limited by cmux, retrying \(attempt \d+\)/,
    );

    const health = await client.callTool({
      name: "control_health",
      arguments: {},
    });
    expect(
      (health.structuredContent as any).health.daemon_lifecycle.log_path,
    ).toBe(logPath);
  });

  it("caps the log at one live file plus one rotated file", () => {
    const logPath = uniquePath("capped", ".log");
    enableDaemonLog({ path: logPath, maxBytes: 400 });

    for (let index = 0; index < 60; index += 1) {
      appendDaemonLog("lifecycle_attempt_failed", `attempt=${index} error=x`);
    }

    expect(statSync(logPath).size).toBeLessThanOrEqual(400);
    expect(statSync(`${logPath}.1`).size).toBeLessThanOrEqual(400);
    expect(readLog(logPath)).toContain("attempt=59");
  });

  it("redacts the cmux capability and keeps each entry on one line", () => {
    vi.stubEnv("CMUX_SOCKET_CAPABILITY", "cap-secret-938");
    const logPath = uniquePath("redact", ".log");
    enableDaemonLog({ path: logPath });

    appendDaemonLog("connection_refused", "cause=cap-secret-938 failed\nsecond line");

    const log = readLog(logPath);
    expect(log).not.toContain("cap-secret-938");
    expect(log).toContain("[REDACTED]");
    expect(log.trimEnd().split("\n")).toHaveLength(1);
  });

  it("writes nothing unless the daemon enabled it", () => {
    const logPath = uniquePath("disabled", ".log");
    vi.stubEnv("CMUXLAYER_DAEMON_LOG_PATH", logPath);

    appendDaemonLog("connection_refused", "cause=test");

    expect(existsSync(logPath)).toBe(false);
  });
});
