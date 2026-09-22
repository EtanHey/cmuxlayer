/**
 * W27b / D232 — the spawn contract must hand over a PID, never a pattern.
 *
 * Every issued contract orders `tail -n0 -F <inbox> &` and stops there. With no
 * teardown line, a seat improvises one. On 2026-09-05 a brainlayer seat improvised
 * `pkill -f 'inbox.jsonl' -P 1`; BSD getopt stops at the first non-option operand, so
 * `-P` and `1` folded INTO the pattern and SIGTERM went to every process whose argv
 * held a `1` — 20 launchd jobs and every `--model claude-opus-5[1m]` Claude seat.
 * See docs.local/incidents/2026-09-05-mass-claude-kill.md.
 *
 * The contract is the upstream fix: it must give the exact stop command.
 */
import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderBootContractFile } from "../src/coordination-paths.js";
import { shellQuote } from "../src/shell-safe.js";

const AGENT_ID = "cmuxlayerClaude-w27bfake";
const BASE_DIR = "/tmp/cmux-w27b-fixture";
const INBOX = join(BASE_DIR, AGENT_ID, "inbox.jsonl");
const PID_FILE = join(BASE_DIR, AGENT_ID, "inbox-tail.pid");

function render(baseDir: string = BASE_DIR): string {
  const inbox = join(baseDir, AGENT_ID, "inbox.jsonl");
  return renderBootContractFile({
    agentId: AGENT_ID,
    mailbox: {
      monitor_command: `tail -n0 -F ${inbox}`,
      tail_pid_path: join(baseDir, AGENT_ID, "inbox-tail.pid"),
      cursor_update_command: `cmuxlayer inbox-cursor '${AGENT_ID}'`,
      cursor_update_env: "CMUX_INBOX_MSG_ID",
    },
    coordination: null,
  });
}

/** The "## Mailbox" section, up to the next `## ` heading or end of file. */
function mailboxBlock(contract: string): string {
  const start = contract.indexOf("## Mailbox");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = contract.slice(start + "## Mailbox".length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("boot contract mailbox teardown", () => {
  it("records the tail's pid so the seat never has to find it", () => {
    const block = mailboxBlock(render());
    expect(block).toContain(`perl -MPOSIX=setsid -e 'my $pidfile=shift;`);
    expect(block).toContain("rename $tmp, $pidfile or die $!; print $write");
    expect(block).toContain(`' ${shellQuote(PID_FILE)} tail -n0 -F ${INBOX}`);
  });

  it("publishes the detached PID before returning and keeps inbox output visible", () => {
    const base = mkdtempSync(join(tmpdir(), "cmux-inbox-detach-"));
    const agentDir = join(base, AGENT_ID);
    const inbox = join(agentDir, "inbox.jsonl");
    const pidFile = join(agentDir, "inbox-tail.pid");
    const output = join(base, "monitor.out");
    mkdirSync(agentDir);
    writeFileSync(inbox, "");
    writeFileSync(pidFile, "999999\n");
    let pid = 0;
    try {
      const block = mailboxBlock(render(base));
      const command = block.match(/^    (.*perl -MPOSIX=setsid.*)$/m)?.[1];
      const launcher = spawnSync("/bin/sh", ["-c", `( ${command!} ) > ${shellQuote(output)} 2>&1`], { timeout: 3000 });
      expect(launcher.status).toBe(0);
      pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).not.toBe(999999);
      const state = spawnSync("ps", ["-p", String(pid), "-o", "pgid=", "-o", "stat="], { encoding: "utf8" });
      const [pgid] = state.stdout.trim().split(/\s+/);
      expect(Number(pgid)).toBe(pid);
      for (let attempt = 0; attempt < 20 && !readFileSync(output, "utf8").includes("visible-after-launch"); attempt++) {
        appendFileSync(inbox, '{"id":"visible-after-launch"}\n');
        spawnSync("sleep", ["0.05"]);
      }
      expect(readFileSync(output, "utf8")).toContain("visible-after-launch");
    } finally {
      if (pid > 0 && pid !== 999999) {
        try { process.kill(pid); } catch { /* already exited */ }
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("gives the exact stop command, addressed by pid", () => {
    const block = mailboxBlock(render());
    expect(block).toContain(
      `kill "$(cat ${shellQuote(PID_FILE)})" && rm -f ${shellQuote(PID_FILE)}`,
    );
  });

  it("survives an agent dir with spaces in it", () => {
    // CMUXLAYER_INBOX_BASE_DIR is user-configurable, so the path can carry
    // spaces; unquoted, the redirect would write to the wrong file and the
    // teardown would `cat` a path that does not exist.
    const spaced = "/tmp/cmux w27b fixture";
    const pid = join(spaced, AGENT_ID, "inbox-tail.pid");
    const block = mailboxBlock(render(spaced));
    expect(block).toContain(`' '${pid}' tail -n0 -F`);
    expect(block).toContain(`kill "$(cat '${pid}')" && rm -f '${pid}'`);
  });

  it("never hands the seat a pattern-matching killer", () => {
    const contract = render();
    expect(contract).not.toMatch(/\bpkill\b/);
    expect(contract).not.toMatch(/\bkillall\b/);
  });

  it("names the folding footgun so an improvised pkill is not a blank slate", () => {
    const block = mailboxBlock(render());
    expect(block.toLowerCase()).toContain("pattern");
  });
});
