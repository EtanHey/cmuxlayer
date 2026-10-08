import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { AgentRecord } from "./agent-types.js";
import { findHarnessSessionPath } from "./harness-session.js";

/** Explicit resume reads fresh session evidence, not the launch-time registry cwd. */
export async function resolveSavedResumeCwd(record: AgentRecord): Promise<string | null> {
  if (record.cli !== "codex") return record.worktree_path ?? record.launch_cwd ?? null;
  const home = process.env.CMUXLAYER_HARNESS_HOME ?? homedir();
  const path = record.cli_session_path ?? findHarnessSessionPath("codex", record.cli_session_id!, {
    home, codexHome: process.env.CODEX_HOME ?? join(home, ".codex"),
  });
  const refuse = (reason: string): never => {
    throw new Error(`Cannot restore saved Codex directory: ${reason}. Restore the session file/directory or correct its captured identity, then retry resume_agent_id; no pane was opened`);
  };
  if (!path) return refuse("session file is unavailable");
  let cwd: unknown = null;
  let identitySeen = false;
  const before = await stat(path).catch(() => null);
  if (!before?.isFile()) return refuse("session file is unavailable");
  // Stream the complete transcript so /cd in an older turn cannot be missed by
  // a tail window. Bound memory per JSONL row; never retain conversation text.
  let pending = "";
  const consume = (line: string): void => {
    if (line.length > 8 * 1024 * 1024) return refuse("session row exceeds safe read bound");
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return refuse("invalid or incomplete session data"); }
    if (event.type === "session_meta") {
      if (identitySeen || event.payload?.id !== record.cli_session_id) return refuse("session identity is ambiguous or mismatched");
      identitySeen = true;
      cwd = event.payload?.cwd;
    } else if (event.type === "turn_context") {
      if (!identitySeen) return refuse("session identity is missing before turn context");
      cwd = event.payload?.cwd;
    }
  };
  try {
    for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 65536 })) {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > 8 * 1024 * 1024) return refuse("session row exceeds safe read bound");
    }
    consume(pending);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Cannot restore saved Codex directory:")) throw error;
    return refuse(error instanceof Error ? error.message : "session read failed");
  }
  const after = await stat(path).catch(() => null);
  if (!after || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return refuse("session changed while reading; retry once it is settled");
  if (!identitySeen) return refuse("session identity is missing");
  if (typeof cwd !== "string" || !isAbsolute(cwd) || /[\r\n\0]/.test(cwd)) return refuse("an absolute working directory is missing or invalid");
  const verifiedCwd = cwd;
  const directory = await stat(verifiedCwd).catch(() => null);
  if (!directory?.isDirectory()) return refuse(`directory ${JSON.stringify(cwd)} is missing or moved; restore that directory`);
  if (record.worktree_branch) {
    let branch: string;
    try {
      branch = await new Promise<string>((resolve, reject) => {
        execFile("git", ["-C", verifiedCwd, "symbolic-ref", "--short", "HEAD"], {
          encoding: "utf8", timeout: 5000, maxBuffer: 65536,
        }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
      });
    } catch { return refuse("saved worktree branch cannot be verified; inspect its Git HEAD"); }
    if (branch !== record.worktree_branch) return refuse(`saved branch ${JSON.stringify(record.worktree_branch)} differs from current branch ${JSON.stringify(branch)}; inspect the worktree without changing it automatically`);
  }
  return verifiedCwd;
}
