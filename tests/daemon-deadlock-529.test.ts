/**
 * Regression suite for #529 — the control-plane daemon deadlock.
 *
 * Incident shape (2026-08-24, packaged 0.4.56): a leftover file at the daemon
 * socket path made `unlinkStaleSocket` throw instead of reaping it, the daemon
 * exited code 1 immediately after the proxy spawned it, that exit was never
 * propagated to its readiness waiters, and every daemon-dependent tool
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
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CmuxLayerDaemon, unlinkStaleSocket } from "../src/daemon.js";
import {
  DaemonReadinessTimeoutError,
  DaemonSocketInUseError,
  DaemonSocketPathOccupiedError,
  DaemonStartupFailedError,
  daemonLifecycleSnapshot,
  resetDaemonLifecycleState,
} from "../src/daemon-lifecycle-state.js";
import { awaitDaemonReadiness } from "../src/entry.js";
import { AgentEngine, LifecycleLockTimeoutError } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { collectControlHealth } from "../src/control-health.js";
import type { CmuxClient, ExecFn } from "../src/cmux-client.js";

// Unix socket paths are capped near 104 bytes on macOS, so keep the root short.
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
    // (`detachOwnedSocketPath` writes the placeholder and never removed it), so
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

  it("never deletes a non-empty file at the socket path", async () => {
    // A mistyped CMUXLAYER_DAEMON_SOCKET pointing at real data must not be
    // treated as a stale daemon artifact. Only cmuxlayer's own shape — an EMPTY
    // regular placeholder, or a dead socket — is reapable.
    const path = testSocketPath("user-data");
    rmSync(path, { force: true });
    writeFileSync(path, "important user data\n");
    cleanups.push(() => rmSync(path, { force: true }));

    const error = await unlinkStaleSocket(path).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DaemonSocketPathOccupiedError);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("important user data\n");
  });

  it("fails closed on an inconclusive probe", async () => {
    // An unanswered probe is not evidence that the path is free.
    const path = testSocketPath("inconclusive");
    rmSync(path, { force: true });
    writeFileSync(path, "");
    cleanups.push(() => rmSync(path, { force: true }));

    const error = await unlinkStaleSocket(path, {
      probe: async () => "unknown",
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DaemonSocketInUseError);
    expect((error as DaemonSocketInUseError).probe).toBe("unknown");
    expect(existsSync(path)).toBe(true);
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

  it("refuses when the path is replaced between classification and reap", async () => {
    // dev/ino ALONE cannot identify an object across delete-and-recreate: Linux
    // hands the freed inode number straight back, so a successor's new SOCKET
    // can carry the placeholder's exact dev/ino. Identity includes the node
    // type, which cannot collide.
    const path = testSocketPath("superseded");
    rmSync(path, { force: true });
    writeFileSync(path, "");

    const successor = net.createServer(() => {});
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          successor.close(() => resolve());
          rmSync(path, { force: true });
        }),
    );

    let probed = false;
    const error = await unlinkStaleSocket(path, {
      probe: async () => {
        if (!probed) {
          probed = true;
          rmSync(path, { force: true });
          await new Promise<void>((resolve) =>
            successor.listen(path, () => resolve()),
          );
        }
        return "stale";
      },
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DaemonSocketInUseError);
    expect((error as DaemonSocketInUseError).probe).toBe("superseded");
    // The successor's live socket is still at the well-known path.
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

  it("reports the exit code of a daemon that died BEFORE readiness attached", async () => {
    // Node never replays a missed `exit`, so a child that failed fast used to
    // surface as a readiness TIMEOUT after the full deadline instead of the
    // exit code that explains it.
    const child = Object.assign(new EventEmitter(), {
      pid: 5150,
      exitCode: 1,
      signalCode: null,
    });
    const alreadyDead = awaitDaemonReadiness({
      socketPath: "/tmp/cmux529/died-early.sock",
      child,
      readStderr: () =>
        "[cmuxlayer-daemon] fatal Error: socket is already in use",
      probeDaemon: async () => false,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      // A deadline far beyond the test: reaching it would be the bug.
      timeoutMs: 30_000,
      pollMs: 5,
    });

    const error = await alreadyDead.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DaemonStartupFailedError);
    expect((error as DaemonStartupFailedError).exitCode).toBe(1);
    expect((error as DaemonStartupFailedError).stderrExcerpt).toContain(
      "socket is already in use",
    );
  }, 3_000);

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
