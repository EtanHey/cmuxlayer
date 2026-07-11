import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnedDaemonSocket,
  assertDoctorReport,
  assertLiveHealth,
  assertPingShape,
  classifyLivePin,
  classifyProductionPin,
  cleanupPidOrder,
  daemonPidFromHealth,
  daemonExitPidFromLog,
  daemonSpawnPidFromLog,
  extractStructuredContent,
  isAncestryDenial,
  McpPeer,
  parseOrphanReceipt,
  probeSystemPing,
  selectTerminalSurface,
  trackChildPid,
  waitForChildExit,
} from "../scripts/run-real-cmux-contract.js";

const tempRoots: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("real cmux contract runner helpers", () => {
  it("skips clearly and successfully when no live cmux pin is provided", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(process.cwd(), "scripts", "run-real-cmux-contract.ts"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, CMUX_SOCKET_PATH: "" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "SKIP: CMUX_SOCKET_PATH is not set",
    );
  });

  it("accepts only the live system.ping response shape", () => {
    expect(() => assertPingShape({ pong: true })).not.toThrow();
    expect(() => assertPingShape({ pong: false })).toThrow(/pong: true/);
    expect(() => assertPingShape({ ok: true })).toThrow(/pong: true/);
    expect(() => assertPingShape(null)).toThrow(/pong: true/);
  });

  it("classifies only explicit reachable pins as runnable", () => {
    expect(classifyLivePin(undefined, null)).toEqual({
      kind: "skip",
      reason: "CMUX_SOCKET_PATH is not set",
    });
    expect(
      classifyLivePin("/tmp/cmux-nightly.sock", {
        ok: false,
        code: "ENOENT",
        message: "connect ENOENT",
      }),
    ).toEqual({
      kind: "skip",
      reason:
        "CMUX_SOCKET_PATH is not reachable: /tmp/cmux-nightly.sock (ENOENT: connect ENOENT)",
    });
    expect(
      classifyLivePin("/tmp/cmux-nightly.sock", {
        ok: true,
        result: { pong: true },
      }),
    ).toEqual({ kind: "run", socketPath: "/tmp/cmux-nightly.sock" });
  });

  it("skips the default production socket before probing", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-contract-prod-home-"));
    tempRoots.push(home);
    const productionSocket = join(
      home,
      ".local",
      "state",
      "cmux",
      "cmux-501.sock",
    );

    await expect(
      classifyProductionPin(productionSocket, { homeDir: home, env: {} }),
    ).resolves.toEqual({
      kind: "skip",
      reason: `refusing production cmux socket ${productionSocket}; pin NIGHTLY /tmp/cmux-nightly.sock (or set CMUX_CONTRACT_ALLOW_PROD=1 to override)`,
    });
  });

  it("admits the NIGHTLY socket through the production guard", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-contract-nightly-home-"));
    tempRoots.push(home);

    await expect(
      classifyProductionPin("/tmp/cmux-nightly.sock", {
        homeDir: home,
        env: {},
      }),
    ).resolves.toEqual({
      kind: "admit",
      socketPath: "/tmp/cmux-nightly.sock",
    });
  });

  it("admits production only with the deliberate override", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-contract-prod-override-"));
    tempRoots.push(home);
    const productionSocket = join(
      home,
      ".local",
      "state",
      "cmux",
      "cmux-501.sock",
    );

    await expect(
      classifyProductionPin(productionSocket, {
        homeDir: home,
        env: { CMUX_CONTRACT_ALLOW_PROD: "1" },
      }),
    ).resolves.toEqual({ kind: "admit", socketPath: productionSocket });
  });

  it("treats the canonical last-socket-path target as production", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmux-contract-prod-marker-"));
    tempRoots.push(home);
    const stateDir = join(home, ".local", "state", "cmux");
    const actualSocket = join(home, "actual-production.sock");
    const socketAlias = join(home, "production-alias.sock");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(actualSocket, "socket fixture");
    symlinkSync(actualSocket, socketAlias);
    writeFileSync(join(stateDir, "last-socket-path"), `${socketAlias}\n`);

    await expect(
      classifyProductionPin(actualSocket, { homeDir: home, env: {} }),
    ).resolves.toEqual({
      kind: "skip",
      reason: `refusing production cmux socket ${actualSocket}; pin NIGHTLY /tmp/cmux-nightly.sock (or set CMUX_CONTRACT_ALLOW_PROD=1 to override)`,
    });
  });

  it("performs a bounded system.ping against an exact Unix socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmux-contract-probe-"));
    tempRoots.push(root);
    const socketPath = join(root, "cmux.sock");
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) return;
        const request = JSON.parse(buffer.trim()) as { id: string };
        socket.end(
          `${JSON.stringify({ id: request.id, ok: true, result: { pong: true } })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    await expect(probeSystemPing(socketPath, 500)).resolves.toEqual({
      ok: true,
      result: { pong: true },
    });
    await expect(
      probeSystemPing(join(root, "missing.sock"), 100),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, code: "ENOENT" }),
    );
  });

  it("recognizes the detached-orphan EPIPE ancestry contract", () => {
    expect(
      isAncestryDenial({
        pid: 42,
        ppid: 1,
        ok: false,
        code: "EPIPE",
        message: "write EPIPE",
      }),
    ).toBe(true);
    expect(
      isAncestryDenial({
        pid: 42,
        ppid: 1,
        ok: false,
        errno: 32,
        message: "Broken pipe",
      }),
    ).toBe(true);
    expect(
      isAncestryDenial({
        pid: 42,
        ppid: 99,
        ok: false,
        code: "EPIPE",
        message: "write EPIPE",
      }),
    ).toBe(false);
    expect(
      isAncestryDenial({
        pid: 42,
        ppid: 1,
        ok: false,
        code: "ECONNREFUSED",
        message: "connect refused",
      }),
    ).toBe(false);
  });

  it("parses a complete orphan receipt", () => {
    expect(
      parseOrphanReceipt(
        JSON.stringify({
          pid: 42,
          ppid: 1,
          ok: false,
          code: "EPIPE",
          message: "write EPIPE",
        }),
      ),
    ).toEqual({
      pid: 42,
      ppid: 1,
      ok: false,
      code: "EPIPE",
      message: "write EPIPE",
    });
    expect(() => parseOrphanReceipt('{"pid":42}')).toThrow(
      /invalid orphan probe receipt/,
    );
  });

  it("extracts structured MCP payloads and rejects tool errors", () => {
    expect(
      extractStructuredContent({
        result: {
          structuredContent: { surfaces: [] },
          content: [{ type: "text", text: "ignored" }],
        },
      }),
    ).toEqual({ surfaces: [] });
    expect(
      extractStructuredContent({
        result: {
          content: [{ type: "text", text: '{"surfaces":[]}' }],
        },
      }),
    ).toEqual({ surfaces: [] });
    expect(() =>
      extractStructuredContent({
        result: {
          isError: true,
          content: [{ type: "text", text: "cmux failed" }],
        },
      }),
    ).toThrow(/cmux failed/);
  });

  it("selects a terminal surface with its workspace", () => {
    expect(
      selectTerminalSurface({
        surfaces: [
          {
            ref: "surface:browser",
            type: "browser",
            workspace_ref: "workspace:1",
          },
          {
            ref: "surface:terminal",
            type: "terminal",
            workspace_ref: "workspace:2",
          },
        ],
      }),
    ).toEqual({ surface: "surface:terminal", workspace: "workspace:2" });
    expect(() => selectTerminalSurface({ surfaces: [] })).toThrow(
      /terminal surface/,
    );
  });

  it("extracts the daemon pid from control_health", () => {
    expect(
      daemonPidFromHealth({
        health: { current_process: { pid: 9876 } },
      }),
    ).toBe(9876);
    expect(() => daemonPidFromHealth({ health: {} })).toThrow(/daemon pid/);
  });

  it("records replacement daemon pids from proxy spawn receipts", () => {
    expect(
      daemonSpawnPidFromLog(
        "[cmuxlayer-proxy] daemon spawn fired (script=/tmp/dist/daemon.js, pid=12345)",
      ),
    ).toBe(12345);
    expect(daemonSpawnPidFromLog("transport selected: socket")).toBeNull();
    expect(
      daemonSpawnPidFromLog(
        "[cmuxlayer-proxy] daemon spawn fired (script=/tmp/dist/daemon.js, pid=unknown)",
      ),
    ).toBeNull();
    expect(
      daemonExitPidFromLog(
        "[cmuxlayer-proxy] spawned daemon exited (pid=12345, code=0, signal=none)",
      ),
    ).toBe(12345);
  });

  it("rejects MCP requests on malformed child output instead of throwing", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const peer = new McpPeer(child as never);

    const pending = peer.request("initialize");
    child.stdout.write("not-json\n");

    await expect(pending).rejects.toThrow(/malformed JSON/);
    await expect(peer.request("tools/list")).rejects.toThrow(/malformed JSON/);
    peer.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });

  it("disposes MCP listeners and pending timers when closed", async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const peer = new McpPeer(child as never);
    const pending = peer.request("initialize", {}, 50);

    peer.close();

    await expect(pending).rejects.toThrow(/closed/);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });

  it("removes tracked child pids as soon as the child exits", () => {
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 4242;
    const pids = new Set<number>();

    trackChildPid(child, pids);
    expect(pids).toEqual(new Set([4242]));
    child.emit("exit", 0, null);
    expect(pids).toEqual(new Set());
  });

  it("requires socket-mode health on the exact live cmux pin", () => {
    const payload = {
      health: {
        current_process: { pid: 9876 },
        selected_transport: {
          transport_mode: "socket",
          current_socket_path: "/tmp/cmux-nightly.sock",
          transport_degraded: false,
        },
      },
    };
    expect(() =>
      assertLiveHealth(payload, "/tmp/cmux-nightly.sock"),
    ).not.toThrow();
    expect(() =>
      assertLiveHealth(
        {
          health: {
            current_process: { pid: 9876 },
            selected_transport: {
              transport_mode: "cli",
              current_socket_path: "/tmp/cmux-nightly.sock",
              transport_degraded: true,
            },
          },
        },
        "/tmp/cmux-nightly.sock",
      ),
    ).toThrow(/socket-mode health/);
    expect(() =>
      assertLiveHealth(
        {
          health: {
            current_process: { pid: 9876 },
            selected_transport: {
              transport_mode: "socket",
              current_socket_path: "/tmp/cmux-nightly.sock",
            },
          },
        },
        "/tmp/cmux-nightly.sock",
      ),
    ).toThrow(/socket-mode health/);
  });

  it("requires doctor JSON to be healthy on both isolated pins", () => {
    expect(() =>
      assertDoctorReport(
        {
          healthy: true,
          daemon: {
            ok: true,
            socketPath: "/tmp/contract/stated.sock",
          },
          socketPath: {
            set: true,
            value: "/tmp/cmux-nightly.sock",
          },
        },
        "/tmp/cmux-nightly.sock",
        "/tmp/contract/stated.sock",
      ),
    ).not.toThrow();
    expect(() =>
      assertDoctorReport(
        {
          healthy: false,
          daemon: {
            ok: false,
            socketPath: "/tmp/contract/stated.sock",
          },
          socketPath: {
            set: true,
            value: "/tmp/cmux-nightly.sock",
          },
        },
        "/tmp/cmux-nightly.sock",
        "/tmp/contract/stated.sock",
      ),
    ).toThrow(/doctor --json was not healthy/);
  });

  it("refuses daemon lifecycle actions outside the owned temp root", () => {
    const root = "/tmp/cmuxlayer-contract-123";
    expect(() =>
      assertOwnedDaemonSocket(root, join(root, "stated.sock")),
    ).not.toThrow();
    expect(() =>
      assertOwnedDaemonSocket(
        root,
        "/Users/example/.local/state/cmux/cmuxlayer-stated.sock",
      ),
    ).toThrow(/outside owned contract root/);
    expect(() => assertOwnedDaemonSocket(root, root)).toThrow(
      /outside owned contract root/,
    );
  });

  it("cleans up the proxy before isolated daemons can respawn", () => {
    expect(cleanupPidOrder(new Set([10, 20, 30, 40]), 30)).toEqual([
      30,
      40,
      20,
      10,
    ]);
    expect(cleanupPidOrder(new Set([10, 20]), undefined)).toEqual([20, 10]);
  });

  it("enforces a SIGTERM to SIGKILL deadline for stuck children", async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = 4242;
    const signals: Array<[number, NodeJS.Signals]> = [];

    await expect(
      waitForChildExit(child, {
        timeoutMs: 5,
        killGraceMs: 5,
        processExists: () => true,
        kill: (pid, signal) => signals.push([pid, signal]),
      }),
    ).rejects.toThrow(/timed out/);
    expect(signals).toEqual([
      [4242, "SIGTERM"],
      [4242, "SIGKILL"],
    ]);
  });
});
