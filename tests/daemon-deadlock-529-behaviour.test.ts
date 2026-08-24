/**
 * #529 BEHAVIOURAL bite tests — the reviewer's round-2 requirement.
 *
 * These deliberately import ONLY symbols that already existed on `main`
 * (`CmuxLayerDaemon`, `AgentEngine`, `StateManager`, `AgentRegistry`) and steer
 * the new bounds through ENVIRONMENT VARIABLES rather than new options. So they
 * keep failing on the unfixed tree, and they survive any later refactor or
 * rename of the symbols this PR introduced.
 *
 * TEST1 (ENOTSOCK bite): a dead-owner leftover at the socket path must be
 *   reaped, not fataled on. Pre-fix: `daemon.start()` rejects with ENOTSOCK.
 * TEST4 (unbounded acquire): a wedged lifecycle holder must not make later
 *   callers wait forever. Pre-fix: the queued call never settles and this test
 *   fails by timeout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CmuxLayerDaemon } from "../src/daemon.js";
import { AgentEngine } from "../src/agent-engine.js";
import { StateManager } from "../src/state-manager.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type { CmuxClient, ExecFn } from "../src/cmux-client.js";

// Unix socket paths cap near 104 bytes on macOS; keep the root short.
const TEST_ROOT = join(tmpdir(), "cmux529b");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

function listWorkspacesExec(): ExecFn {
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

describe("#529 behavioural bite", () => {
  it("TEST1: starts over a dead-owner leftover instead of fataling on ENOTSOCK", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = join(TEST_ROOT, `bite1-${process.pid}.sock`);
    rmSync(path, { force: true });
    // Exactly what a clean daemon shutdown leaves behind: an empty REGULAR
    // FILE at the socket path. connect(2) answers ENOTSOCK.
    writeFileSync(path, "");

    const daemon = new CmuxLayerDaemon({
      socketPath: path,
      exec: listWorkspacesExec(),
      skipAgentLifecycle: true,
    });
    cleanups.push(async () => {
      await daemon.shutdown();
      rmSync(path, { force: true });
      rmSync(`${path}.owner`, { force: true });
    });

    await expect(daemon.start()).resolves.toBeUndefined();
    expect(statSync(path).isSocket()).toBe(true);
  });

  it("TEST4: a wedged lifecycle holder does not make a later caller wait forever", async () => {
    const baseDir = join(tmpdir(), `cmux529b-engine-${process.pid}`);
    rmSync(baseDir, { recursive: true, force: true });
    mkdirSync(baseDir, { recursive: true });

    // Steer the bound through env only — no symbol this PR added.
    const priorAcquire =
      process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS;
    const priorHold = process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS;
    process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS = "60";
    process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS = "150";

    const stateMgr = new StateManager(baseDir);
    const client = {
      listWorkspaces: async () => ({ workspaces: [] }),
      listPanes: async () => ({ panes: [] }),
      listPaneSurfaces: async () => ({ surfaces: [] }),
    } as unknown as CmuxClient;
    const registry = new AgentRegistry(stateMgr, async () => []);
    const engine = new AgentEngine(stateMgr, registry, client, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts: { baseDir },
    });

    cleanups.push(() => {
      engine.dispose();
      rmSync(baseDir, { recursive: true, force: true });
      if (priorAcquire === undefined) {
        delete process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS;
      } else {
        process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS = priorAcquire;
      }
      if (priorHold === undefined) {
        delete process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS;
      } else {
        process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS = priorHold;
      }
    });

    // The wedge: an operation that never settles.
    void engine
      .runLifecycleMutation(() => new Promise<void>(() => {}))
      .catch(() => {});

    const settled = await Promise.race([
      engine
        .runLifecycleMutation(async () => "queued")
        .then(() => "resolved")
        .catch(() => "rejected"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("never-settled"), 2_000),
      ),
    ]);

    // The point is only that it SETTLES. Which way is the bound's business.
    expect(settled).not.toBe("never-settled");
  }, 10_000);

  it("TEST4b: the acquire timeout does not let a waiter run beside the live holder", async () => {
    // #530 review P1-1: releasing the timed-out waiter's own tail slot let the
    // NEXT caller chain off an already-resolved promise and execute
    // concurrently with the still-live holder. Mutual exclusion must hold.
    const baseDir = join(tmpdir(), `cmux529b-excl-${process.pid}`);
    rmSync(baseDir, { recursive: true, force: true });
    mkdirSync(baseDir, { recursive: true });

    const priorAcquire =
      process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS;
    const priorHold = process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS;
    process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS = "40";
    // Hold bound far beyond the test: the holder stays live throughout.
    process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS = "60000";

    const stateMgr = new StateManager(baseDir);
    const client = {
      listWorkspaces: async () => ({ workspaces: [] }),
      listPanes: async () => ({ panes: [] }),
      listPaneSurfaces: async () => ({ surfaces: [] }),
    } as unknown as CmuxClient;
    const registry = new AgentRegistry(stateMgr, async () => []);
    const engine = new AgentEngine(stateMgr, registry, client, {
      spawnPreflight: async () => {},
      sessionIdentityResolver: () => null,
      inboxOpts: { baseDir },
    });

    cleanups.push(() => {
      engine.dispose();
      rmSync(baseDir, { recursive: true, force: true });
      if (priorAcquire === undefined) {
        delete process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS;
      } else {
        process.env.CMUXLAYER_LIFECYCLE_LOCK_ACQUIRE_TIMEOUT_MS = priorAcquire;
      }
      if (priorHold === undefined) {
        delete process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS;
      } else {
        process.env.CMUXLAYER_LIFECYCLE_LOCK_HOLD_TIMEOUT_MS = priorHold;
      }
    });

    let concurrent = 0;
    let maxConcurrent = 0;
    let releaseHolder!: () => void;

    const holder = engine.runLifecycleMutation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => (releaseHolder = resolve));
      concurrent -= 1;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // This one gives up on the acquire while the holder is still live.
    const abandoned = engine
      .runLifecycleMutation(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        concurrent -= 1;
      })
      .catch(() => "timed-out");

    // Queued behind the abandoned waiter. It must NOT start early.
    const follower = engine.runLifecycleMutation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      concurrent -= 1;
      return "follower";
    });
    follower.catch(() => {});

    await abandoned;
    // Give a broken implementation ample room to run the follower early.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(maxConcurrent).toBe(1);

    releaseHolder();
    await holder;
    await Promise.allSettled([follower]);
    expect(maxConcurrent).toBe(1);
  }, 10_000);
});
