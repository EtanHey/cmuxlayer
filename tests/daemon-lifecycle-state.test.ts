/**
 * #530 round-2 review P2-3: daemon lifecycle state is GENERATION-scoped.
 *
 * Carrying a dead generation's exit forward made `control_health` warn "this
 * runtime is not daemon-backed" permanently, even after a healthy successor
 * daemon was serving — a false alarm that trains readers to ignore the warning
 * that actually matters.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DaemonReadinessTimeoutError,
  DaemonSocketInUseError,
  DaemonStartupFailedError,
  daemonLifecycleSnapshot,
  daemonLifecycleSnapshotFor,
  daemonLifecycleSidecarPath,
  daemonStderrExcerpt,
  recordDaemonExit,
  recordDaemonLifecycleError,
  recordDaemonSocketInUse,
  recordDaemonSocketReap,
  recordDaemonSpawnAttempt,
  resetDaemonLifecycleState,
} from "../src/daemon-lifecycle-state.js";

describe("daemon lifecycle state", () => {
  beforeEach(() => {
    resetDaemonLifecycleState();
  });

  it("starts empty", () => {
    const snapshot = daemonLifecycleSnapshot();
    expect(snapshot.spawn_attempts).toBe(0);
    expect(snapshot.last_exit).toBeNull();
    expect(snapshot.last_error).toBeNull();
    expect(snapshot.socket_path).toBeNull();
  });

  it("clears the previous generation's failure state on a new spawn attempt", () => {
    recordDaemonSpawnAttempt({ socketPath: "/tmp/gen.sock", pid: 100 });
    recordDaemonExit({
      code: 1,
      signal: null,
      pid: 100,
      stderrExcerpt: "boom",
    });
    recordDaemonLifecycleError("spawn failed");
    recordDaemonSocketInUse({ path: "/tmp/gen.sock", ownerPid: 100 });

    const failed = daemonLifecycleSnapshot();
    expect(failed.last_exit?.code).toBe(1);
    expect(failed.last_error).toBe("spawn failed");
    expect(failed.last_socket_in_use).not.toBeNull();

    // A healthy successor generation starts here.
    recordDaemonSpawnAttempt({ socketPath: "/tmp/gen.sock", pid: 200 });

    const successor = daemonLifecycleSnapshot();
    expect(successor.last_exit).toBeNull();
    expect(successor.last_error).toBeNull();
    expect(successor.last_socket_in_use).toBeNull();
    // Cumulative facts survive: the counter is how you see spawn churn.
    expect(successor.spawn_attempts).toBe(2);
    expect(successor.last_spawn_pid).toBe(200);
  });

  it("ignores a late exit from a superseded daemon generation", () => {
    // #530 final pass F9 (Codex addendum): the OLD child's `exit` can land
    // AFTER a healthy successor has spawned. Recording it re-poisoned
    // `last_exit` and re-raised the "not daemon-backed" warning against a
    // daemon that is serving fine.
    recordDaemonSpawnAttempt({ socketPath: "/tmp/gen.sock", pid: 100 });
    recordDaemonSpawnAttempt({ socketPath: "/tmp/gen.sock", pid: 200 });
    recordDaemonExit({
      code: 1,
      signal: null,
      pid: 100,
      stderrExcerpt: "late",
    });

    const snapshot = daemonLifecycleSnapshot();
    expect(snapshot.last_exit).toBeNull();
    expect(snapshot.last_spawn_pid).toBe(200);
  });

  it("still records an exit from the CURRENT generation", () => {
    recordDaemonSpawnAttempt({ socketPath: "/tmp/gen.sock", pid: 200 });
    recordDaemonExit({
      code: 3,
      signal: null,
      pid: 200,
      stderrExcerpt: "boom",
    });
    expect(daemonLifecycleSnapshot().last_exit?.code).toBe(3);
  });

  it("records an exit whose pid is unknown rather than dropping it", () => {
    // An unknown pid cannot be attributed to a generation; dropping it would
    // reintroduce silence, so it is recorded.
    recordDaemonSpawnAttempt({ socketPath: "/tmp/gen.sock", pid: 200 });
    recordDaemonExit({ code: 1, signal: null, stderrExcerpt: "no pid" });
    expect(daemonLifecycleSnapshot().last_exit?.code).toBe(1);
  });

  it("crosses the process boundary through the sidecar", () => {
    // Codex P2 (#530): the PROXY spawns the daemon and records its exits, but
    // `control_health` is served by the detached DAEMON — a different process
    // with its own module-local snapshot. Without a sidecar the health block
    // reported zeros in exactly the normal topology.
    const dir = mkdtempSync(join(tmpdir(), "cmux530-sidecar-"));
    const socketPath = join(dir, "cmuxlayer-stated.sock");

    // Proxy side.
    recordDaemonSpawnAttempt({ socketPath, pid: 4242 });
    recordDaemonExit({ code: 1, signal: null, pid: 4242, stderrExcerpt: "boom" });
    expect(existsSync(daemonLifecycleSidecarPath(socketPath))).toBe(true);

    // Daemon side: a fresh process with an empty local record.
    resetDaemonLifecycleState();
    expect(daemonLifecycleSnapshot().spawn_attempts).toBe(0);

    const merged = daemonLifecycleSnapshotFor(socketPath);
    expect(merged.spawn_attempts).toBe(1);
    expect(merged.last_exit?.code).toBe(1);
    expect(merged.last_exit?.stderr_excerpt).toBe("boom");

    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers this process's own record over the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux530-sidecar2-"));
    const socketPath = join(dir, "cmuxlayer-stated.sock");
    recordDaemonSpawnAttempt({ socketPath, pid: 1 });
    recordDaemonExit({ code: 9, signal: null, pid: 1, stderrExcerpt: "local" });
    // Local activity exists, so the sidecar must not override it.
    expect(daemonLifecycleSnapshotFor(socketPath).last_exit?.code).toBe(9);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps reap history across generations", () => {
    recordDaemonSocketReap({
      path: "/tmp/gen.sock",
      reason: "dead-owner-leftover",
    });
    recordDaemonSpawnAttempt({ socketPath: "/tmp/gen.sock", pid: 300 });
    expect(daemonLifecycleSnapshot().last_socket_reap?.reason).toBe(
      "dead-owner-leftover",
    );
  });

  it("bounds the stderr excerpt from the tail", () => {
    const excerpt = daemonStderrExcerpt(`${"x".repeat(5_000)}TAIL`);
    expect(excerpt.length).toBeLessThanOrEqual(4_000);
    expect(excerpt.endsWith("TAIL")).toBe(true);
    expect(daemonStderrExcerpt(undefined)).toBe("");
  });

  it("carries structured detail on every daemon failure error", () => {
    const inUse = new DaemonSocketInUseError({
      socketPath: "/tmp/a.sock",
      ownerPid: 42,
      probe: "superseded",
    });
    expect(inUse.code).toBe("EDAEMONSOCKETINUSE");
    expect(inUse.ownerPid).toBe(42);
    expect(inUse.message).toContain("superseded");

    const failed = new DaemonStartupFailedError({
      socketPath: "/tmp/a.sock",
      exitCode: 1,
      stderrExcerpt: "fatal: socket is already in use",
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.message).toContain("fatal: socket is already in use");

    const timedOut = new DaemonReadinessTimeoutError({
      socketPath: "/tmp/a.sock",
      waitedMs: 5_000,
    });
    expect(timedOut.waitedMs).toBe(5_000);
    expect(timedOut.code).toBe("EDAEMONREADINESSTIMEOUT");
  });
});
