/**
 * B5 — smoke tests for scripts/hooks/inbox_hook.py (the cmux-state-independent
 * inbox-wake transport). Drives the script exactly as Claude Code would:
 * hook payload JSON on stdin, JSON (or silence) on stdout, ALWAYS exit 0.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);
const HOOK = join(__dirname, "..", "scripts", "hooks", "inbox_hook.py");

let agentsDir: string;
let cwdDir: string;

function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      [HOOK],
      { env: { ...process.env, CMUX_AGENTS_DIR: agentsDir, ...env } },
      (error, stdout, stderr) => {
        // Fail-open contract: exit code must be 0 in every case.
        if (error) reject(new Error(`hook exited non-zero: ${error.message}`));
        else resolve({ stdout, stderr });
      },
    );
    child.stdin!.write(JSON.stringify(payload));
    child.stdin!.end();
  });
}

function seedInbox(agentId: string, tasks: string[], ackFirst = false) {
  const dir = join(agentsDir, agentId);
  mkdirSync(dir, { recursive: true });
  const lines = tasks.map((task, i) =>
    JSON.stringify({
      id: `m${i}`,
      ts_ms: 1000 + i,
      from: "orc",
      to: agentId,
      tag: "dispatch",
      task,
    }),
  );
  writeFileSync(join(dir, "inbox.jsonl"), lines.join("\n") + "\n");
  if (ackFirst) {
    writeFileSync(
      join(dir, "inbox.ack.jsonl"),
      JSON.stringify({
        ts_ms: 2000,
        agent: agentId,
        ack_of: "m0",
        status: "done",
      }) + "\n",
    );
  }
}

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "cmux-hook-agents-"));
  cwdDir = mkdtempSync(join(tmpdir(), "myrepo-"));
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

describe("inbox_hook.py", () => {
  it("SessionStart creates the canonical inbox dir and registers watchPaths", async () => {
    const { stdout } = await runHook({
      hook_event_name: "SessionStart",
      session_id: "abcdef12-3456-7890-abcd-ef1234567890",
      cwd: cwdDir,
    });
    const out = JSON.parse(stdout);
    const expectedId = `${cwdDir.split("/").pop()}Claude-abcdef12`;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.watchPaths).toEqual([
      join(agentsDir, expectedId, "inbox.jsonl"),
    ]);
    expect(out.hookSpecificOutput.additionalContext).toContain(expectedId);
    expect(existsSync(join(agentsDir, expectedId, "inbox.jsonl"))).toBe(true);
  });

  it("SessionStart announces already-waiting undelivered messages", async () => {
    seedInbox("wakerClaude-deadbeef", ["GO build the thing"]);
    const { stdout } = await runHook(
      { hook_event_name: "SessionStart", session_id: "x", cwd: cwdDir },
      { CMUX_INBOX_ID: "wakerClaude-deadbeef" },
    );
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "ALREADY WAITING",
    );
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "GO build the thing",
    );
  });

  it("FileChanged injects undelivered messages and the ack instruction", async () => {
    seedInbox("wakerClaude-deadbeef", ["msg A", "msg B"], true); // m0 acked
    const { stdout } = await runHook(
      { hook_event_name: "FileChanged", session_id: "x", cwd: cwdDir },
      { CMUX_INBOX_ID: "wakerClaude-deadbeef" },
    );
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.additionalContext).toContain("1 undelivered");
    expect(out.hookSpecificOutput.additionalContext).toContain("msg B");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("msg A");
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "inbox.ack.jsonl",
    );
  });

  it("FileChanged is silent when everything is acked", async () => {
    seedInbox("quietClaude-cafe0000", ["only"], false);
    const dir = join(agentsDir, "quietClaude-cafe0000");
    writeFileSync(
      join(dir, "inbox.ack.jsonl"),
      JSON.stringify({ ts_ms: 1, agent: "q", ack_of: "m0", status: "done" }) +
        "\n",
    );
    const { stdout } = await runHook(
      { hook_event_name: "FileChanged", session_id: "x", cwd: cwdDir },
      { CMUX_INBOX_ID: "quietClaude-cafe0000" },
    );
    expect(stdout.trim()).toBe("");
  });

  it("Stop blocks with a reason while undelivered messages exist", async () => {
    seedInbox("stopperClaude-12345678", ["drain me"]);
    const { stdout } = await runHook(
      { hook_event_name: "Stop", session_id: "x", cwd: cwdDir },
      { CMUX_INBOX_ID: "stopperClaude-12345678" },
    );
    const out = JSON.parse(stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("drain me");
  });

  it("Stop is silent with an empty/absent inbox", async () => {
    const { stdout } = await runHook(
      { hook_event_name: "Stop", session_id: "x", cwd: cwdDir },
      { CMUX_INBOX_ID: "nobody-here" },
    );
    expect(stdout.trim()).toBe("");
  });

  it("fail-open: garbage stdin still exits 0 with no output", async () => {
    const { stdout } = await new Promise<{ stdout: string }>(
      (resolve, reject) => {
        const child = execFile(
          "python3",
          [HOOK],
          { env: { ...process.env, CMUX_AGENTS_DIR: agentsDir } },
          (error, stdout) =>
            error ? reject(new Error("non-zero exit")) : resolve({ stdout }),
        );
        child.stdin!.write("not json at all{{{");
        child.stdin!.end();
      },
    );
    expect(stdout.trim()).toBe("");
  });

  it("tolerates corrupt inbox lines (live-channel partial writes)", async () => {
    const dir = join(agentsDir, "corruptClaude-00000000");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "inbox.jsonl"),
      '{"id":"ok1","from":"orc","task":"good"}\n{broken json\n',
    );
    const { stdout } = await runHook(
      { hook_event_name: "Stop", session_id: "x", cwd: cwdDir },
      { CMUX_INBOX_ID: "corruptClaude-00000000" },
    );
    const out = JSON.parse(stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("good");
  });
});
