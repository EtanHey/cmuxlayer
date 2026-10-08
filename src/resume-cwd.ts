import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { AgentRecord } from "./agent-types.js";

type Refuse = (reason: string) => never;
const stamp = (value: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string =>
  `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;

// UUID launch does not consume cli_session_path. Enumerate both local stores
// instead of inheriting the historical first-suffix-match helper's ambiguity.
async function uuidCandidates(codexHome: string, sessionId: string, refuse: Refuse) {
  const candidates: { path: string; active: boolean }[] = [];
  const pattern = new RegExp(`^rollout-.*-${sessionId}(?:_[0-9a-f-]{36})?\\.jsonl(?:\\.zst)?$`, "i");
  let entriesSeen = 0;
  for (const [subdir, active] of [["sessions", true], ["archived_sessions", false]] as const) {
    const root = join(codexHome, subdir);
    const rootState = await stat(root).catch(error => {
      if (error.code === "ENOENT") return null;
      return refuse(`UUID store ${JSON.stringify(root)} cannot be inspected`);
    });
    if (!rootState) continue;
    if (!rootState.isDirectory()) return refuse("UUID store is not a directory");
    const directories = [root];
    while (directories.length) {
      const dir = directories.pop()!;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => refuse("UUID store scan is incomplete; retry after restoring access"));
      entriesSeen += entries.length;
      if (entriesSeen > 100000) return refuse("UUID store scan exceeds safe bound; narrow the configured store");
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile() && pattern.test(entry.name)) candidates.push({ path, active });
      }
    }
  }
  return candidates;
}

async function readCwdEvidence(path: string, sessionId: string, refuse: Refuse) {
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
      if (identitySeen || event.payload?.id !== sessionId) return refuse("session identity is ambiguous or mismatched");
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
  return { cwd, stamp: stamp(after) };
}

export interface SavedResumeContext {
  cwd: string | null;
  /** Absolute store inspected for this UUID; bind it on the launch invocation. */
  codexHome?: string;
}

/** Explicit resume binds fresh cwd evidence to the unique UUID-addressed local store. */
export async function resolveSavedResumeContext(record: AgentRecord): Promise<SavedResumeContext> {
  if (record.cli !== "codex") return { cwd: record.worktree_path ?? record.launch_cwd ?? null };
  const refuse: Refuse = reason => {
    throw new Error(`Cannot restore saved Codex directory: ${reason}. Restore the session file/directory or correct its captured identity, then retry resume_agent_id; no pane was opened`);
  };
  const sessionId = record.cli_session_id;
  if (!sessionId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return refuse("session identity is invalid");
  const home = process.env.CMUXLAYER_HARNESS_HOME ?? homedir();
  const configuredHome = process.env.CODEX_HOME ?? join(home, ".codex");
  if (!configuredHome || /[\r\n\0]/.test(configuredHome)) return refuse("configured session store is invalid");
  // Relative roots must not be reinterpreted after the pane changes directory.
  const codexHome = resolve(configuredHome);
  const candidates = await uuidCandidates(codexHome, sessionId, refuse);
  if (candidates.length !== 1) return refuse(candidates.length
    ? "multiple UUID candidates are ambiguous in the configured active/archive stores; reconcile conflicting copies"
    : "UUID-addressed session is unavailable in the configured stores; restore it there before resuming");
  const selected = candidates[0];
  if (!selected.active || selected.path.endsWith(".zst")) return refuse("UUID session requires unarchiving or supported transcript restoration before resume");
  const evidence = await readCwdEvidence(selected.path, sessionId, refuse);
  if (record.cli_session_path && resolve(record.cli_session_path) !== resolve(selected.path)) {
    const captured = await readCwdEvidence(record.cli_session_path, sessionId, refuse);
    if (captured.cwd !== evidence.cwd) return refuse("captured and UUID-addressed current transcript cwd differ; reconcile the captured/canonical copies");
  }
  const verifiedCwd = evidence.cwd;
  const directory = await stat(verifiedCwd).catch(() => null);
  if (!directory?.isDirectory()) return refuse(`directory ${JSON.stringify(verifiedCwd)} is missing or moved; restore that directory`);
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
  const currentCandidates = await uuidCandidates(codexHome, sessionId, refuse);
  const finalState = await stat(selected.path).catch(() => null);
  if (currentCandidates.length !== 1 || currentCandidates[0].path !== selected.path || !finalState || stamp(finalState) !== evidence.stamp) return refuse("UUID session evidence changed during verification; retry after it is settled");
  return { cwd: verifiedCwd, codexHome };
}

/** Cwd-only compatibility projection; launch consumers must carry the context. */
export async function resolveSavedResumeCwd(record: AgentRecord): Promise<string | null> {
  return (await resolveSavedResumeContext(record)).cwd;
}
