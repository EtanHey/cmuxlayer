import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBootContractFile } from "../src/coordination-paths.js";
describe("issued inbox tail teardown", () => {
  it("clears a dead PID and never signals a reused PID", () => {
    const base = mkdtempSync(join(tmpdir(), "cmux-stale-pid-"));
    const agentDir = join(base, "worker");
    const pidFile = join(agentDir, "inbox-tail.pid");
    mkdirSync(agentDir);
    const stop = renderBootContractFile({
      agentId: "worker",
      mailbox: {
        monitor_command: `tail -n0 -F ${join(agentDir, "inbox.jsonl")}`,
        tail_pid_path: pidFile,
        cursor_update_env: "CMUX_INBOX_MSG_ID",
        cursor_update_command: "cmuxlayer inbox-cursor worker",
      },
    }).split("To stop it, kill that PID -- never a pattern:")[1]?.match(/^    (.+)$/m)?.[1];
    const unrelated = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      writeFileSync(pidFile, "999999\n");
      spawnSync("/bin/sh", ["-c", stop!]);
      expect(existsSync(pidFile)).toBe(false);
      writeFileSync(pidFile, `${unrelated.pid}\n`);
      const conflict = spawnSync("/bin/sh", ["-c", stop!]);
      expect([conflict.status, existsSync(pidFile)]).toEqual([1, true]);
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      unrelated.kill();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
