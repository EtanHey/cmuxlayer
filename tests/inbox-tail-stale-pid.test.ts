import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBootContractFile } from "../src/coordination-paths.js";
import { shellQuote } from "../src/shell-safe.js";

function childPid(parentPid: number): number {
  const listing = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).stdout;
  const child = listing.split("\n").map((line) => line.trim().split(/\s+/).map(Number))
    .find(([, ppid]) => ppid === parentPid);
  return child?.[0] ?? 0;
}

async function waitForExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const live = pids.filter((pid) => {
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
      const state = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).stdout.trim();
      return state.length > 0 && !state.startsWith("Z");
    });
    if (live.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`detached inbox processes did not exit: ${pids.join(", ")}`);
}

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

  it("stops its own live tail with a quoted spaced inbox path", () => {
    const base = mkdtempSync(join(tmpdir(), "cmux spaced inbox "));
    const agentDir = join(base, "worker");
    const inbox = join(agentDir, "inbox.jsonl");
    const pidFile = join(agentDir, "inbox-tail.pid");
    mkdirSync(agentDir);
    writeFileSync(inbox, "");
    const contract = renderBootContractFile({ agentId: "worker", mailbox: {
      monitor_command: `tail -n0 -F '${inbox}'`, tail_pid_path: pidFile,
      cursor_update_env: "CMUX_INBOX_MSG_ID", cursor_update_command: "cmuxlayer inbox-cursor worker",
    } });
    const launch = contract.match(/^    (.*perl -MPOSIX=setsid.*)$/m)?.[1];
    const stop = contract.split("To stop it, kill that PID -- never a pattern:")[1]?.match(/^    (.+)$/m)?.[1];
    let pid = 0;
    try {
      expect(spawnSync("/bin/sh", ["-c", `( ${launch} ) > /dev/null 2>&1`], { timeout: 3000 }).status).toBe(0);
      pid = Number(readFileSync(pidFile, "utf8").split(/\s+/)[0]);
      const result = spawnSync("/bin/sh", ["-c", stop!], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      if (pid > 0) { try { process.kill(pid); } catch { /* already stopped */ } }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not stop a different tail running the same inbox command", () => {
    const base = mkdtempSync(join(tmpdir(), "cmux-same-tail-"));
    const agentDir = join(base, "worker");
    const inbox = join(agentDir, "inbox.jsonl");
    const pidFile = join(agentDir, "inbox-tail.pid");
    mkdirSync(agentDir);
    writeFileSync(inbox, "");
    const contract = renderBootContractFile({ agentId: "worker", mailbox: {
      monitor_command: `tail -n0 -F ${inbox}`, tail_pid_path: pidFile,
      cursor_update_env: "CMUX_INBOX_MSG_ID", cursor_update_command: "cmuxlayer inbox-cursor worker",
    } });
    const launch = contract.match(/^    (.*perl -MPOSIX=setsid.*)$/m)?.[1];
    const stop = contract.split("To stop it, kill that PID -- never a pattern:")[1]?.match(/^    (.+)$/m)?.[1];
    const other = spawn("tail", ["-n0", "-F", inbox], { stdio: "ignore" });
    let armedPid = 0;
    try {
      expect(spawnSync("/bin/sh", ["-c", `( ${launch} ) > /dev/null 2>&1`], { timeout: 3000 }).status).toBe(0);
      const armed = readFileSync(pidFile, "utf8").trim().split(" ");
      armedPid = Number(armed[0]);
      expect(armed[1]).toMatch(/^[0-9a-f]{32}$/);
      expect(spawnSync("/bin/sh", ["-c", stop!]).status).toBe(0);
      writeFileSync(pidFile, `${other.pid} ${armed[1]}\n`);
      const result = spawnSync("/bin/sh", ["-c", stop!], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(existsSync(pidFile)).toBe(true);
      expect(() => process.kill(other.pid!, 0)).not.toThrow();
    } finally {
      if (armedPid > 0) { try { process.kill(armedPid); } catch { /* already stopped */ } }
      other.kill();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps a newer monitor record when rearmed after signaling the old one", async () => {
    const base = mkdtempSync(join(tmpdir(), "cmux-tail-rearm-"));
    const agentDir = join(base, "worker");
    const inbox = join(agentDir, "inbox.jsonl");
    const pidFile = join(agentDir, "inbox-tail.pid");
    const capture = join(base, "new-record");
    mkdirSync(agentDir);
    writeFileSync(inbox, "");
    const contract = renderBootContractFile({ agentId: "worker", mailbox: {
      monitor_command: `tail -n0 -F ${inbox}`, tail_pid_path: pidFile,
      cursor_update_env: "CMUX_INBOX_MSG_ID", cursor_update_command: "cmuxlayer inbox-cursor worker",
    } });
    const launch = contract.match(/^    (.*perl -MPOSIX=setsid.*)$/m)?.[1];
    const stop = contract.split("To stop it, kill that PID -- never a pattern:")[1]?.match(/^    (.+)$/m)?.[1];
    let oldPid = 0;
    let newPid = 0;
    let oldTailPid = 0;
    let newTailPid = 0;
    try {
      expect(spawnSync("/bin/sh", ["-c", `( ${launch} ) > /dev/null 2>&1`], { timeout: 3000 }).status).toBe(0);
      oldPid = Number(readFileSync(pidFile, "utf8").split(" ")[0]);
      oldTailPid = childPid(oldPid);
      expect(oldTailPid).toBeGreaterThan(0);
      const interleaved = `kill() { if [ "$1" = -0 ]; then command kill "$@"; return; fi; command kill "$@" || return; ( ${launch} ) > /dev/null 2>&1; cat ${shellQuote(pidFile)} > ${shellQuote(capture)}; }; ${stop}`;
      expect(spawnSync("/bin/sh", ["-c", interleaved], { timeout: 3000 }).status).toBe(0);
      const newRecord = readFileSync(capture, "utf8");
      newPid = Number(newRecord.split(" ")[0]);
      newTailPid = childPid(newPid);
      expect(newTailPid).toBeGreaterThan(0);
      expect(newPid).not.toBe(oldPid);
      expect(readFileSync(pidFile, "utf8")).toBe(newRecord);
      expect(() => process.kill(newPid, 0)).not.toThrow();
    } finally {
      if (oldPid > 0) { try { process.kill(oldPid); } catch { /* already stopped */ } }
      if (newPid > 0) { try { process.kill(newPid); } catch { /* already stopped */ } }
      await waitForExit([oldPid, oldTailPid, newPid, newTailPid].filter((pid) => pid > 0));
      rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });
});
