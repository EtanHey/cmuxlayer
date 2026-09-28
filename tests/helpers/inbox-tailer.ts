// #911: arm a real mailbox tailer the way a seat does, from the boot
// contract's own command, so tests exercise the process the fleet runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "vitest";
import { renderBootContractFile } from "../../src/coordination-paths.js";
import { inboxPath, inboxTailPidPath } from "../../src/inbox.js";

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function armTailer(
  agentId: string,
  inboxOpts: { baseDir: string },
  cleanups: Array<() => void>,
): { wrapper: number; tail: number } {
  const dir = join(inboxOpts.baseDir, agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(inboxPath(agentId, inboxOpts), "");
  const contract = renderBootContractFile({
    agentId,
    mailbox: {
      monitor_command: `tail -n0 -F ${inboxPath(agentId, inboxOpts)}`,
      tail_pid_path: inboxTailPidPath(agentId, inboxOpts),
      cursor_update_command: "true",
      cursor_update_env: "CMUX_INBOX_MSG_ID",
    },
    coordination: null,
  });
  const command = contract.match(/^    (.*perl -MPOSIX=setsid.*)$/m)?.[1];
  const launched = spawnSync("/bin/sh", ["-c", `( ${command!} ) > /dev/null 2>&1`], { timeout: 3000 });
  expect(launched.status).toBe(0);
  const wrapper = Number(readFileSync(inboxTailPidPath(agentId, inboxOpts), "utf8").split(" ")[0]);
  const child = spawnSync("pgrep", ["-P", String(wrapper)], { encoding: "utf8" }).stdout.trim();
  const tail = Number(child);
  expect(tail).toBeGreaterThan(1);
  cleanups.push(() => {
    for (const pid of [tail, wrapper]) {
      try { process.kill(pid); } catch { /* already reaped */ }
    }
    // Wait for both to exit: a dying wrapper re-creates its pidfile lock, which
    // races the scratch dir's removal (ENOTEMPTY) if the dir goes first.
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let attempt = 0; attempt < 120 && (alive(tail) || alive(wrapper)); attempt++) {
      Atomics.wait(pause, 0, 0, 25);
    }
  });
  return { wrapper, tail };
}

export async function waitGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80 && alive(pid); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}
