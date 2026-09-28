/**
 * #955: a daemon-log close that times out while a batch is still being
 * written must report that tail on stderr, not claim nothing was lost.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const control = vi.hoisted(() => ({ hang: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: (...args: Parameters<typeof actual.appendFile>) =>
      control.hang
        ? new Promise<void>(() => {})
        : actual.appendFile(...args),
  };
});

const { appendDaemonLog, closeDaemonLog, enableDaemonLog } = await import(
  "../src/daemon-log.js"
);

const TEST_ROOT = join("/tmp", "cmux955");

afterEach(() => {
  control.hang = false;
  vi.restoreAllMocks();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("#955 daemon-log close timeout", () => {
  it("reports lines whose write is still in flight when the close times out", async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    enableDaemonLog({ path: join(TEST_ROOT, `inflight-${process.pid}.log`) });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    control.hang = true;

    appendDaemonLog("daemon_stopped", "reason=a");
    // Let the writer take the batch off the queue and start its write.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await closeDaemonLog(20);

    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/close timed out after 20ms; 1 line\(s\) queued or in flight/),
    );
  });
});
