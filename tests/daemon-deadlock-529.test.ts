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
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CmuxLayerDaemon,
  daemonSocketOwnerReceiptText,
  unlinkStaleSocket,
} from "../src/daemon.js";
import {
  DaemonSocketInUseError,
  DaemonSocketPathOccupiedError,
  DaemonStartupFailedError,
  DaemonReadinessTimeoutError,
  daemonLifecycleSnapshot,
  resetDaemonLifecycleState,
} from "../src/daemon-lifecycle-state.js";
import {
  awaitDaemonHandoff,
  awaitDaemonReadiness,
  isOwnerBusyFailure,
} from "../src/entry.js";
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
    rmSync(`${path}.owner`, { force: true });
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
    // Codex P1: a mistyped CMUXLAYER_DAEMON_SOCKET pointing at real data used to
    // classify as a stale daemon artifact and get deleted. Only cmuxlayer's own
    // shape — an EMPTY regular placeholder, or a dead socket — is reapable.
    const path = testSocketPath("user-data");
    rmSync(path, { force: true });
    rmSync(`${path}.owner`, { force: true });
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

  it("F3: refuses a shutdown placeholder whose receipt names a LIVE owner", async () => {
    // Codex P1: closeListener() parks a regular-file placeholder BEFORE
    // waitForDrain(), so a daemon still draining in-flight requests presents a
    // non-socket path for up to 5s. Classifying every non-socket as stale let a
    // racing autostart reap it and bind a SECOND live daemon over the same
    // state dir. The receipt must outrank the probe.
    const path = testSocketPath("live-owner-placeholder");
    rmSync(path, { force: true });
    rmSync(`${path}.owner`, { force: true });
    writeFileSync(path, "");
    // This process is unquestionably alive, so it stands in for the drainer.
    writeFileSync(`${path}.owner`, daemonSocketOwnerReceiptText());
    cleanups.push(() => {
      rmSync(path, { force: true });
      rmSync(`${path}.owner`, { force: true });
    });

    const error = await unlinkStaleSocket(path).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DaemonSocketInUseError);
    expect((error as DaemonSocketInUseError).ownerPid).toBe(process.pid);
    // The draining daemon's placeholder survives.
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.owner`)).toBe(true);
  });

  it("F3: still reaps a placeholder whose receipt names a DEAD owner", async () => {
    // The #529 reboot case must keep working: leftover placeholder plus a
    // receipt naming a pid that no longer exists.
    const path = testSocketPath("dead-owner-placeholder");
    rmSync(path, { force: true });
    writeFileSync(path, "");
    writeFileSync(`${path}.owner`, "999999 1\n");
    cleanups.push(() => {
      rmSync(path, { force: true });
      rmSync(`${path}.owner`, { force: true });
    });

    await expect(unlinkStaleSocket(path)).resolves.toBe("reaped");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.owner`)).toBe(false);
  });

  it("fails closed on an inconclusive probe even with a dead-pid receipt", async () => {
    // Macroscope (#530, post-cf2f66c): the receipt write is best-effort and an
    // fd-activated daemon never writes one, so a stale receipt naming a dead
    // pid can coexist with a LIVE owner. Reaping on that combination orphans a
    // running daemon and lets a second one bind the same control plane.
    const path = testSocketPath("unknown-dead-receipt");
    rmSync(path, { force: true });
    writeFileSync(path, "");
    writeFileSync(`${path}.owner`, "999999 1\n");
    cleanups.push(() => {
      rmSync(path, { force: true });
      rmSync(`${path}.owner`, { force: true });
    });

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

  it("keeps a successor's receipt when it reuses the classified pid", async () => {
    // Macroscope (#530): comparing only the pid deleted a successor's receipt
    // when the pid was recycled, destroying the evidence later probes rely on.
    const path = testSocketPath("receipt-pid-reuse");
    rmSync(path, { force: true });
    writeFileSync(path, "");
    writeFileSync(`${path}.owner`, "999999 111\n");
    cleanups.push(() => {
      rmSync(path, { force: true });
      rmSync(`${path}.owner`, { force: true });
    });

    await expect(
      unlinkStaleSocket(path, {
        probe: async () => "stale",
        // The successor rewrites the receipt with the SAME pid but a different
        // start time between classification and reap.
        readOwnerReceipt: (() => {
          let call = 0;
          return () => {
            call += 1;
            return { pid: 999999, startedAtMs: call === 1 ? 111 : 222 };
          };
        })(),
        ownerAlive: () => false,
      }),
    ).resolves.toBe("reaped");
    // Socket reaped, but the successor's receipt survives.
    expect(existsSync(`${path}.owner`)).toBe(true);
  });

  it("F8: refuses a socket that appeared during classification", async () => {
    // Codex addendum: with the path ABSENT at classification, observedIdentity
    // is null and the superseded comparison used to be skipped entirely — so a
    // successor that bound mid-classification was unlinked.
    const path = testSocketPath("appeared-mid-classify");
    rmSync(path, { force: true });
    rmSync(`${path}.owner`, { force: true });

    const successor = net.createServer(() => {});
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          successor.close(() => resolve());
          rmSync(path, { force: true });
        }),
    );

    // Path is absent now; the successor binds while the probe is "running".
    const error = await unlinkStaleSocket(path, {
      probe: async () => {
        await new Promise<void>((resolve) =>
          successor.listen(path, () => resolve()),
        );
        return "stale";
      },
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DaemonSocketInUseError);
    expect((error as DaemonSocketInUseError).probe).toBe("superseded");
    // The successor's live socket survives.
    expect(statSync(path).isSocket()).toBe(true);
  });

  it("restores, never deletes, a successor's socket grabbed by the reap", async () => {
    // Codex P1: a dev/ino check followed by a separate unlink(2) cannot be made
    // safe — two successors can both validate the old inode and the loser then
    // deletes the winner's LIVE socket. The reap now moves the object with
    // rename(2) and verifies identity on a name nobody else knows, so anything
    // it did not mean to move is put back rather than destroyed.
    const path = testSocketPath("reap-restores-successor");
    rmSync(path, { force: true });
    rmSync(`${path}.owner`, { force: true });
    writeFileSync(path, "");

    const successor = net.createServer(() => {});
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          successor.close(() => resolve());
          rmSync(path, { force: true });
        }),
    );

    // Classification sees the placeholder; the successor swaps in its live
    // socket before the reap runs.
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
    // The successor's live socket is still at the well-known path.
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

  it("reports the exit code of a daemon that died BEFORE readiness attached", async () => {
    // #530 review (Macroscope): node never replays a missed `exit`, so a child
    // that failed fast used to surface as a readiness TIMEOUT after the full
    // deadline instead of the exit code that explains it.
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

describe("#530 daemon handoff instead of a competing backend", () => {
  it("waits for a draining owner and attaches instead of falling back in-process", async () => {
    // Codex P1: when autostart overlaps a clean shutdown, our spawned daemon
    // refuses (live-owner placeholder) and exits at once. Falling back
    // in-process there starts a SECOND backend against the same registry while
    // the old daemon is still draining in-flight mutations.
    let probes = 0;
    const attached = await awaitDaemonHandoff({
      socketPath: "/tmp/cmux529/draining.sock",
      // The drainer hands off on the third probe.
      probeDaemon: async () => ++probes >= 3,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: 2_000,
      pollMs: 5,
      isPathClear: async () => false,
      spawnDaemon: vi.fn().mockResolvedValue({ pid: 1 }),
      awaitReady: vi.fn().mockResolvedValue(undefined),
      logger: { error: vi.fn() },
    });

    expect(attached).toBe(true);
  }, 5_000);

  it("defers the respawn until the drainer's placeholder is gone", async () => {
    // Macroscope (#530): firing the single respawn on the first probe failure
    // spent it while the placeholder was still present, so that daemon refused
    // too and nothing started once the path finally cleared.
    let clearChecks = 0;
    const spawnDaemon = vi.fn().mockResolvedValue({ pid: 7 });

    const attached = await awaitDaemonHandoff({
      socketPath: "/tmp/cmux529/deferred.sock",
      probeDaemon: async () => false,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: 2_000,
      pollMs: 5,
      // The placeholder survives the first three checks.
      isPathClear: async () => ++clearChecks > 3,
      spawnDaemon,
      awaitReady: vi.fn().mockResolvedValue(undefined),
      logger: { error: vi.fn() },
    });

    expect(attached).toBe(true);
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    // Proof it waited rather than firing immediately.
    expect(clearChecks).toBeGreaterThan(3);
  }, 5_000);

  it("gives up on the handoff instead of waiting forever", async () => {
    const attached = await awaitDaemonHandoff({
      socketPath: "/tmp/cmux529/never.sock",
      probeDaemon: async () => false,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      timeoutMs: 30,
      pollMs: 5,
      isPathClear: async () => true,
      spawnDaemon: vi.fn().mockRejectedValue(new Error("nope")),
      awaitReady: vi.fn(),
      logger: { error: vi.fn() },
    });

    expect(attached).toBe(false);
  }, 5_000);

  it("classifies a socket-in-use daemon exit as owner-busy, not a hard failure", () => {
    const busy = new DaemonStartupFailedError({
      socketPath: "/tmp/cmux529/x.sock",
      exitCode: 1,
      stderrExcerpt: "[cmuxlayer-daemon] fatal code=EDAEMONSOCKETINUSE",
    });
    expect(isOwnerBusyFailure(busy)).toBe(true);

    const broken = new DaemonStartupFailedError({
      socketPath: "/tmp/cmux529/x.sock",
      exitCode: 1,
      stderrExcerpt: "SyntaxError: Unexpected token",
    });
    expect(isOwnerBusyFailure(broken)).toBe(false);
  });
});
