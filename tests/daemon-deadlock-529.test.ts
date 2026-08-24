/**
 * Regression suite for #529 — the control-plane daemon deadlock.
 *
 * Incident shape (2026-08-24, packaged 0.4.56): a leftover file at the daemon
 * socket path made `unlinkStaleSocket` throw instead of reaping it, the daemon
 * exited code 1 immediately after the proxy spawned it, that exit was never
 * propagated to the readiness waiters, and every daemon-dependent tool
 * (`list_agents`, `spawn_agent`) deadlocked forever while lock-free tools kept
 * answering in milliseconds.
 *
 * Each test here must fail (hang, throw the wrong shape, or fail to import)
 * against the pre-fix code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CmuxLayerDaemon, unlinkStaleSocket } from "../src/daemon.js";
import {
  DaemonSocketInUseError,
  DaemonStartupFailedError,
  DaemonReadinessTimeoutError,
  daemonLifecycleSnapshot,
  resetDaemonLifecycleState,
} from "../src/daemon-lifecycle-state.js";
import { awaitDaemonReadiness } from "../src/entry.js";
import { AgentEngine, LifecycleLockTimeoutError } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { collectControlHealth } from "../src/control-health.js";
import type { CmuxClient } from "../src/cmux-client.js";
import type { ExecFn } from "../src/cmux-client.js";

// Unix socket paths are capped near 104 bytes on macOS, so keep the test root short.
const TEST_ROOT = join(tmpdir(), "cmux529");

function testSocketPath(name: string): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  return join(TEST_ROOT, `${name}-${process.pid}.sock`);
}

function listSurfacesExec(): ExecFn {
  return vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
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
    return { stdout: "{}", stderr: "" };
  }) as unknown as ExecFn;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  vi.restoreAllMocks();
  resetDaemonLifecycleState();
});

describe("#529 daemon socket path handling", () => {
  it("reaps a dead-owner leftover at the socket path and starts", async () => {
    // A clean daemon shutdown leaves an empty REGULAR FILE at the socket path
    // (`detachOwnedSocketPath` writes the placeholder and never removes it), so
    // a reboot-time SIGTERM leaves exactly this shape. connect(2) on it returns
    // ENOTSOCK, which the pre-fix probe re-threw: the successor daemon fataled
    // instead of reaping a leftover that provably has no live owner.
    const path = testSocketPath("dead-owner-leftover");
    rmSync(path, { force: true });
    writeFileSync(path, "");
    expect(statSync(path).isSocket()).toBe(false);

    const outcome = await unlinkStaleSocket(path);
    expect(outcome).toBe("reaped");
    expect(existsSync(path)).toBe(false);

    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: listSurfacesExec(),
      skipAgentLifecycle: true,
    });
    cleanups.push(async () => {
      await daemon.shutdown();
      rmSync(path, { force: true });
    });
    await daemon.start();
    expect(statSync(path).isSocket()).toBe(true);
  });

  it("refuses a LIVE owner with a structured error instead of a bare throw", async () => {
    const path = testSocketPath("live-owner");
    rmSync(path, { force: true });
    const owner = net.createServer(() => {});
    await new Promise<void>((resolve) => owner.listen(path, () => resolve()));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          owner.close(() => resolve());
          rmSync(path, { force: true });
        }),
    );

    const error = await unlinkStaleSocket(path).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DaemonSocketInUseError);
    expect((error as DaemonSocketInUseError).code).toBe("EDAEMONSOCKETINUSE");
    expect((error as DaemonSocketInUseError).socketPath).toBe(path);
    // The live owner's socket must survive — this is the "connect to it" case.
    expect(statSync(path).isSocket()).toBe(true);
  });
});

describe("#529 daemon readiness propagation", () => {
  it("rejects with exit code and stderr when the daemon child dies before ready", async () => {
    const child = new EventEmitter() as EventEmitter & { pid?: number };
    child.pid = 4242;
    const stderr =
      "[cmuxlayer-daemon] fatal Error: cmuxlayer daemon socket is already in use";

    const readiness = awaitDaemonReadiness({
      socketPath: "/tmp/cmux529/never-ready.sock",
      child,
      readStderr: () => stderr,
      probeDaemon: async () => false,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: 5_000,
      pollMs: 5,
    });
    setTimeout(() => child.emit("exit", 1, null), 10);

    const error = await readiness.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DaemonStartupFailedError);
    expect((error as DaemonStartupFailedError).exitCode).toBe(1);
    expect((error as DaemonStartupFailedError).stderrExcerpt).toContain(
      "socket is already in use",
    );
    // The failure is recorded, so a dead daemon no longer looks like a healthy one.
    const snapshot = daemonLifecycleSnapshot();
    expect(snapshot.last_exit?.code).toBe(1);
    expect(snapshot.last_exit?.stderr_excerpt).toContain(
      "socket is already in use",
    );
  });

  it("bounds readiness so a silent daemon never leaves the promise unsettled", async () => {
    const readiness = awaitDaemonReadiness({
      socketPath: "/tmp/cmux529/silent.sock",
      probeDaemon: async () => false,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: 20,
      pollMs: 5,
    });
    await expect(readiness).rejects.toBeInstanceOf(DaemonReadinessTimeoutError);
  }, 2_000);
});

describe("#529 bounded lifecycle lock", () => {
  function createEngine(baseDir: string): AgentEngine {
    mkdirSync(baseDir, { recursive: true });
    const stateMgr = new StateManager(baseDir);
    const client = {
      listWorkspaces: async () => ({ workspaces: [] }),
      listPanes: async () => ({ panes: [] }),
      listPaneSurfaces: async () => ({ surfaces: [] }),
    } as unknown as CmuxClient;
    const registry = new AgentRegistry(stateMgr, async () => []);
    return new AgentEngine(stateMgr, registry, client, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts: { baseDir },
      lifecycleLockAcquireTimeoutMs: 40,
      lifecycleLockHoldTimeoutMs: 80,
    });
  }

  it("fails a queued caller fast and names the holder instead of waiting forever", async () => {
    const baseDir = join(tmpdir(), `cmux529-engine-${process.pid}`);
    const engine = createEngine(baseDir);
    cleanups.push(() => {
      engine.dispose();
      rmSync(baseDir, { recursive: true, force: true });
    });

    // A wedged holder: an operation that never settles.
    const wedged = engine.runLifecycleMutation(
      () => new Promise<void>(() => {}),
      { label: "wedged-op" },
    );
    void wedged.catch(() => {});

    const error = await engine
      .runLifecycleMutation(async () => "queued", { label: "queued-op" })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(LifecycleLockTimeoutError);
    const timeout = error as LifecycleLockTimeoutError;
    expect(timeout.holder).toBe("wedged-op");
    expect(timeout.waiter).toBe("queued-op");
    expect(timeout.heldForMs).toBeGreaterThanOrEqual(0);
    expect(timeout.message).toContain("wedged-op");

    // A wedged operation must not poison the tail: once the hold guard fires,
    // later callers get the lock instead of inheriting the deadlock.
    await expect(
      engine.runLifecycleMutation(async () => "later", { label: "later-op" }),
    ).resolves.toBe("later");
  }, 5_000);

  it("reports lock holder, held-for-ms and queue depth", async () => {
    const baseDir = join(tmpdir(), `cmux529-engine2-${process.pid}`);
    const engine = createEngine(baseDir);
    cleanups.push(() => {
      engine.dispose();
      rmSync(baseDir, { recursive: true, force: true });
    });

    let release!: () => void;
    const held = engine.runLifecycleMutation(
      () => new Promise<void>((resolve) => (release = resolve)),
      { label: "held-op" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const state = engine.lifecycleLockState();
    expect(state.holder).toBe("held-op");
    expect(state.held_for_ms).toBeGreaterThanOrEqual(0);
    expect(state.queue_depth).toBe(0);
    release();
    await held;
    expect(engine.lifecycleLockState().holder).toBeNull();
  });
});

describe("#529 control_health observability", () => {
  it("reports daemon lifecycle state so a dead daemon looks different", async () => {
    resetDaemonLifecycleState();
    const health = await collectControlHealth({
      execFile: async () => ({ stdout: "", stderr: "" }),
      homeDir: TEST_ROOT,
      tmpDir: TEST_ROOT,
    });
    expect(health.daemon_lifecycle).toBeDefined();
    expect(health.daemon_lifecycle.spawn_attempts).toBe(0);
    expect(health.daemon_lifecycle.last_exit).toBeNull();
  });
});
