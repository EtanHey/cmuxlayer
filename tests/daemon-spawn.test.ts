import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { spawnDaemonProcess } from "../src/daemon-spawn.js";

describe("spawnDaemonProcess", () => {
  it("logs the exit status when a spawned daemon dies", async () => {
    const root = mkdtempSync(join(tmpdir(), "cmuxlayer-daemon-spawn-"));
    const logger = { error: vi.fn() };
    try {
      const daemonScriptPath = join(root, "exiting-daemon.js");
      writeFileSync(daemonScriptPath, "process.exit(7);\n");
      const child = await spawnDaemonProcess({
        socketPath: join(root, "daemon.sock"),
        env: {},
        logger,
        daemonScriptPath,
      });
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(
          /spawned daemon exited \(pid=\d+, code=7, signal=none\)/,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
