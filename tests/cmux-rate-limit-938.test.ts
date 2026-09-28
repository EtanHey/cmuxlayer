/**
 * #938: the daemon must survive cmux's per-connection polling rate limiter.
 *
 * The fake cmux socket below mirrors cmux 0.64.25's `ControlClientRateLimiter`
 * (Packages/macOS/CmuxControlSocket/.../ControlClientRateLimiter.swift): a
 * per-connection token bucket that only charges the read-plane polling
 * methods, admits every mutation, and answers a limited request with
 * `rate_limited` BEFORE executing it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { CmuxLayerDaemon, SocketJsonRpcTransport } from "../src/daemon.js";
import {
  createServer,
  createServerContext as createProductionServerContext,
  type CreateServerOptions,
} from "../src/server.js";
import { CmuxSocketClient } from "../src/cmux-socket-client.js";
import { CmuxSocketError } from "../src/cmux-socket-error.js";
import {
  currentTransportRetryCount,
  withTransportRetryTracking,
} from "../src/transport-retry-context.js";
import type { ExecFn } from "../src/cmux-client.js";

// Unix socket paths cap near 104 bytes on macOS; keep the root short.
const TEST_ROOT = join("/tmp", "cmux938");
const TEST_OBSERVER_OWNER = "cmux:/tmp/cmux938.sock";

// cmux 0.64.25 ControlCommandExecutionPolicy.pollingMethods (v2 names).
const CMUX_POLLING_METHODS = new Set([
  "system.top",
  "system.memory",
  "system.tree",
  "system.identify",
  "window.list",
  "window.current",
  "window.displays",
  "workspace.list",
  "workspace.current",
  "surface.list",
  "surface.current",
  "surface.read_text",
  "surface.read_selection",
  "pane.list",
  "pane.surfaces",
]);

interface FakeLimiter {
  burst: number;
  refillMs: number;
  /** Every polling request is refused until this many ms after listen. */
  refuseAllForMs?: number;
  /** Methods the fake refuses on every call, polling or not. */
  alwaysLimited?: Set<string>;
}

interface FakeCmux {
  path: string;
  requests: Array<{ method: string; limited: boolean }>;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function uniquePath(name: string, suffix = ".sock"): string {
  return join(
    TEST_ROOT,
    `${name}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${suffix}`,
  );
}

function fakeResult(method: string): Record<string, unknown> {
  switch (method) {
    case "window.list":
      return {
        windows: [{ id: "w1", ref: "window:1", index: 0, selected: true }],
      };
    case "workspace.list":
      return {
        workspaces: [
          {
            id: "ws1",
            ref: "workspace:1",
            title: "Main",
            index: 0,
            selected: true,
            pinned: false,
          },
        ],
      };
    case "pane.list":
      return { workspace_ref: "workspace:1", window_ref: "window:1", panes: [] };
    case "surface.list":
      return { surfaces: [] };
    case "surface.read_text":
      return { text: "" };
    default:
      return {};
  }
}

async function startFakeCmux(limiter: FakeLimiter): Promise<FakeCmux> {
  mkdirSync(TEST_ROOT, { recursive: true });
  const path = uniquePath("cmux");
  const requests: FakeCmux["requests"] = [];
  const listenedAt = Date.now();
  const server = net.createServer((conn) => {
    // Per-connection bucket, exactly like cmux: a fresh connection gets a
    // full burst, and only polling methods spend tokens.
    let tokens = limiter.burst;
    let lastRefill = Date.now();
    let buffer = "";
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as { id: string; method: string };
        const now = Date.now();
        const refilled = Math.floor((now - lastRefill) / limiter.refillMs);
        if (refilled > 0) {
          tokens = Math.min(limiter.burst, tokens + refilled);
          lastRefill += refilled * limiter.refillMs;
        }
        let limited = false;
        if (limiter.alwaysLimited?.has(request.method)) {
          limited = true;
        } else if (CMUX_POLLING_METHODS.has(request.method)) {
          if (
            limiter.refuseAllForMs !== undefined &&
            now - listenedAt < limiter.refuseAllForMs
          ) {
            limited = true;
          } else if (tokens <= 0) {
            limited = true;
          } else {
            tokens -= 1;
          }
        }
        requests.push({ method: request.method, limited });
        const response = limited
          ? {
              id: request.id,
              ok: false,
              error: {
                code: "rate_limited",
                message: "Polling rate limited for this connection",
                data: { retry_after_ms: limiter.refillMs },
              },
            }
          : { id: request.id, ok: true, result: fakeResult(request.method) };
        conn.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  rmSync(path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      rmSync(path, { force: true });
    });
  cleanups.push(close);
  return { path, requests, close };
}

function socketClient(path: string): CmuxSocketClient {
  const client = new CmuxSocketClient({ socketPath: path });
  cleanups.push(() => client.disconnect());
  return client;
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

function rateLimitedError(): CmuxSocketError {
  return new CmuxSocketError(
    "rate_limited: Polling rate limited for this connection",
    "rate_limited",
  );
}

function emptyExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes("list-workspaces")) {
      return { stdout: JSON.stringify({ workspaces: [] }), stderr: "" };
    }
    return { stdout: "{}", stderr: "" };
  }) as unknown as ExecFn;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fastLifecycleRetry(): void {
  vi.stubEnv("CMUXLAYER_LIFECYCLE_RETRY_BASE_MS", "5");
  vi.stubEnv("CMUXLAYER_LIFECYCLE_RETRY_MAX_MS", "20");
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  return (content ?? [])
    .map((entry) => (entry.type === "text" ? entry.text ?? "" : ""))
    .join("\n");
}

describe("#938 cmux polling reads go through the budget and the rate_limited retry", () => {
  it("a discovery-shaped read fan-out succeeds under the limiter and counts its retries", async () => {
    const cmux = await startFakeCmux({ burst: 2, refillMs: 20 });
    const client = socketClient(cmux.path);

    const retries = await withTransportRetryTracking(async () => {
      await Promise.all([
        client.listWorkspaces(),
        ...Array.from({ length: 11 }, (_, index) =>
          client.listPanes({ workspace: `workspace:${index + 1}` }),
        ),
      ]);
      return currentTransportRetryCount();
    });

    expect(cmux.requests.some((request) => request.limited)).toBe(true);
    expect(retries).toBeGreaterThan(0);
  });

  it("does not pace reads against a cmux without a limiter (0.64.22)", async () => {
    // Paced from the first call, 40 reads at cmux's budget (8 burst, then
    // one per 100ms) would take about 3.2s.
    const cmux = await startFakeCmux({ burst: 1_000, refillMs: 100 });
    const client = socketClient(cmux.path);

    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: 40 }, () => client.listPanes()),
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(cmux.requests.every((request) => !request.limited)).toBe(true);
  });

  it("an exhausted read carries a numeric retry_count, not undefined", async () => {
    const cmux = await startFakeCmux({
      burst: 9,
      refillMs: 100,
      alwaysLimited: new Set(["pane.list"]),
    });
    const client = socketClient(cmux.path);

    const error = await client.listPanes().then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "rate_limited" });
    expect((error as CmuxSocketError).retry_count).toBe(3);
    expect(cmux.requests.filter((r) => r.method === "pane.list")).toHaveLength(4);
  });

  it("never blindly retries a mutating call", async () => {
    // cmux never limits mutations; if one ever answered rate_limited, a
    // blind retry could double-type into a pane.
    const cmux = await startFakeCmux({
      burst: 9,
      refillMs: 100,
      alwaysLimited: new Set(["surface.send_text"]),
    });
    const client = socketClient(cmux.path);

    await expect(client.send("surface:1", "hello", { workspace: "workspace:1" })).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(
      cmux.requests.filter((r) => r.method === "surface.send_text"),
    ).toHaveLength(1);
  });
});

describe("#938 lifecycle init never latches a transient error", () => {
  it("retries lifecycle init with backoff until it succeeds", async () => {
    fastLifecycleRetry();
    let calls = 0;
    const lifecycleInitializer = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw rateLimitedError();
    });
    const context = createProductionServerContext(
      withTestObserver({
        exec: emptyExec(),
        stateDir: uniquePath("state", ""),
        disableSpawnPreflight: true,
        lifecycleInitializer,
      }),
    );
    cleanups.push(() => context.dispose());
    createServer({ context });

    await waitUntil(() => lifecycleInitializer.mock.calls.length >= 3);
    await context.lifecycleReadyPromise;

    expect(lifecycleInitializer).toHaveBeenCalledTimes(3);
    expect(context.lifecycleStartError).toBeNull();
  });

  it("reaches ready against a fake cmux that refuses every read for a window", async () => {
    fastLifecycleRetry();
    const cmux = await startFakeCmux({
      burst: 9,
      refillMs: 100,
      refuseAllForMs: 600,
    });
    const context = createProductionServerContext(
      withTestObserver({
        client: socketClient(cmux.path),
        stateDir: uniquePath("state", ""),
        disableSpawnPreflight: true,
      }),
    );
    cleanups.push(() => context.dispose());
    createServer({ context });

    await waitUntil(
      () =>
        cmux.requests.some((r) => r.limited) &&
        cmux.requests.some((r) => !r.limited),
      10_000,
    );
    await context.lifecycleReadyPromise;

    expect(context.lifecycleStartError).toBeNull();
  }, 20_000);
});

describe("#938 a connection during lifecycle retry gets an answer, not a drop", () => {
  it("serves initialize, names the cause on engine tools, and reports the state in control_health", async () => {
    fastLifecycleRetry();
    let release = false;
    const lifecycleInitializer = vi.fn(async () => {
      if (!release) throw rateLimitedError();
    });
    const context = createProductionServerContext(
      withTestObserver({
        exec: emptyExec(),
        stateDir: uniquePath("state", ""),
        disableSpawnPreflight: true,
        lifecycleInitializer,
      }),
    );
    const path = uniquePath("daemon");
    const daemon = new CmuxLayerDaemon({ socketPath: path, context });
    await daemon.start();
    cleanups.push(async () => {
      await daemon.shutdown();
      context.dispose();
    });

    // Lifecycle starts with the first connection's server; on main that
    // first failed attempt latched and this connect was dropped.
    const socket = net.createConnection(path);
    const client = new Client({ name: "938-test", version: "0.1.0" });
    await client.connect(new SocketJsonRpcTransport(socket));
    cleanups.push(() => client.close());

    const gated = await client.callTool({
      name: "list_agents",
      arguments: {},
    });
    expect(gated.isError).toBe(true);
    expect(toolText(gated)).toMatch(
      /lifecycle initializing: rate_limited by cmux, retrying \(attempt \d+\)/,
    );

    const health = await client.callTool({
      name: "control_health",
      arguments: {},
    });
    expect(health.isError).not.toBe(true);
    expect(
      (health.structuredContent as any).health.daemon_lifecycle.lifecycle_start,
    ).toMatchObject({
      state: "retrying",
      last_error: expect.stringContaining("rate_limited"),
    });

    release = true;
    await context.lifecycleReadyPromise;
    const served = await client.callTool({
      name: "list_agents",
      arguments: {},
    });
    expect(served.isError).not.toBe(true);
  });
});
