/**
 * #955: a daemon-log close that times out while a batch is still being
 * written must report that tail on stderr, not claim nothing was lost.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const control = vi.hoisted(() => ({
  hang: false,
  gate: null as Promise<void> | null,
  calls: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: (...args: Parameters<typeof actual.appendFile>) => {
      control.calls.push(String(args[1]));
      if (control.hang) return new Promise<void>(() => {});
      const gate = control.gate;
      if (gate) {
        control.gate = null;
        return gate.then(() => actual.appendFile(...args));
      }
      return actual.appendFile(...args);
    },
  };
});

const {
  appendDaemonLog,
  closeDaemonLog,
  disableDaemonLog,
  enableDaemonLog,
  flushDaemonLog,
} = await import("../src/daemon-log.js");

const TEST_ROOT = join("/tmp", "cmux955");

afterEach(() => {
  control.hang = false;
  control.gate = null;
  control.calls = [];
  vi.restoreAllMocks();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("#955 daemon-log close timeout", () => {
  it("never lets two writers touch the same file at once", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const path = join(TEST_ROOT, `same-path-${process.pid}.log`);
    let release!: () => void;
    control.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    enableDaemonLog({ path });
    appendDaemonLog("daemon_stopped", { reason: "old" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A new daemon re-opens the SAME file while the old write is in flight.
    disableDaemonLog();
    enableDaemonLog({ path });
    appendDaemonLog("daemon_starting", { node: "new" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(control.calls).toHaveLength(1);

    release();
    await flushDaemonLog();
    expect(control.calls).toHaveLength(2);
    expect(control.calls[1]).toContain("daemon_starting");
  });

  it("reports lines whose write is still in flight when the close times out", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    enableDaemonLog({ path: join(TEST_ROOT, `inflight-${process.pid}.log`) });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    control.hang = true;

    appendDaemonLog("daemon_stopped", { reason: "a" });
    // Let the writer take the batch off the queue and start its write.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await closeDaemonLog(20);

    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/close timed out after 20ms; 1 line\(s\) queued or in flight/),
    );
  });
});
