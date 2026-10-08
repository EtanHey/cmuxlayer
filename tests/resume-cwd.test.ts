import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSavedResumeCwd } from "../src/resume-cwd.js";
import { buildRawResumeCommand } from "../src/agent-command.js";
import type { AgentRecord } from "../src/agent-types.js";

describe("saved resume directory evidence", () => {
  let root: string;
  const id = "019d9aa5-93c0-7a52-9c47-9be1f7625f3e";
  let record: AgentRecord;
  const row = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "resume-cwd-"));
    const store = join(root, ".codex", "sessions", "2026", "10", "08");
    mkdirSync(store, { recursive: true });
    vi.stubEnv("CODEX_HOME", join(root, ".codex"));
    record = { cli: "codex", cli_session_id: id, cli_session_path: join(store, `rollout-2026-10-08T00-00-00-${id}.jsonl`), launch_cwd: "/stale" } as AgentRecord;
    writeFileSync(record.cli_session_path!, row("session_meta", { id, cwd: root }));
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it("reads current cwd even when its last turn is outside a tail window", async () => {
    const cwd = join(root, "current"); mkdirSync(cwd);
    writeFileSync(record.cli_session_path!, row("session_meta", { id, cwd: root }) + row("turn_context", { cwd }) + row("response_item", { text: "x".repeat(2 * 1024 * 1024) }));
    expect(await resolveSavedResumeCwd(record)).toBe(cwd);
  });
  it("finds the UUID-addressed canonical transcript when no path was captured", async () => {
    expect(await resolveSavedResumeCwd({ ...record, cli_session_path: null })).toBe(root);
  });
  it.each(["missing", "duplicate", "null", "omitted"])("refuses %s current directory evidence", async kind => {
    const meta = row("session_meta", { id, cwd: root });
    const content = kind === "missing" ? row("turn_context", { cwd: root })
      : kind === "duplicate" ? meta + meta
      : meta + row("turn_context", kind === "null" ? { cwd: null } : {});
    writeFileSync(record.cli_session_path!, content);
    await expect(resolveSavedResumeCwd(record)).rejects.toThrow(/identity|absolute/);
  });
  it("refuses a divergent captured copy rather than overriding UUID-selected cwd", async () => {
    const captured = join(root, "captured-old.jsonl");
    const stale = join(root, "old"); mkdirSync(stale);
    writeFileSync(captured, row("session_meta", { id, cwd: stale }));
    await expect(resolveSavedResumeCwd({ ...record, cli_session_path: captured })).rejects.toThrow(/captured.*canonical|captured.*differ/);
  });
  it("allows a captured copy whose verified cwd agrees with the unique canonical transcript", async () => {
    const captured = join(root, "captured.jsonl");
    writeFileSync(captured, row("session_meta", { id, cwd: root }));
    expect(await resolveSavedResumeCwd({ ...record, cli_session_path: captured })).toBe(root);
  });
  it.each(["different-cwd", "same-cwd", "reverted", "archived"])("refuses duplicate UUID candidates: %s", async kind => {
    const dir = kind === "archived" ? join(root, ".codex", "archived_sessions") : join(root, ".codex", "sessions", "2026", "10", "09");
    mkdirSync(dir, { recursive: true });
    const suffix = kind === "reverted" ? "_aaaaaaaa-bbbb-4333-8444-555555555555" : "";
    writeFileSync(join(dir, `rollout-2026-10-09T00-00-00-${id}${suffix}.jsonl`), row("session_meta", { id, cwd: kind === "different-cwd" ? "/old" : root }));
    await expect(resolveSavedResumeCwd({ ...record, cli_session_path: null })).rejects.toThrow(/multiple.*ambiguous/);
  });
  it("refuses a captured-only path that the configured UUID store cannot address", async () => {
    const captured = join(root, "Drive-restored-copy.jsonl");
    writeFileSync(captured, row("session_meta", { id, cwd: root }));
    rmSync(record.cli_session_path!);
    await expect(resolveSavedResumeCwd({ ...record, cli_session_path: captured })).rejects.toThrow(/UUID-addressed.*unavailable/);
  });
  it("ignores other UUIDs while retaining current and metadata-only valid contexts", async () => {
    writeFileSync(join(root, ".codex", "sessions", "rollout-2026-10-08T00-00-00-aaaaaaaa-bbbb-4333-8444-555555555555.jsonl"), row("session_meta", { id: "aaaaaaaa-bbbb-4333-8444-555555555555", cwd: "/unrelated" }));
    expect(await resolveSavedResumeCwd(record)).toBe(root);
    writeFileSync(record.cli_session_path!, row("session_meta", { id, cwd: root }) + row("turn_context", { cwd: root }));
    expect(await resolveSavedResumeCwd(record)).toBe(root);
  });
  it("verifies a recorded branch against real Git without changing HEAD", async () => {
    execFileSync("git", ["init", "-b", "saved", root], { stdio: "ignore" });
    expect(await resolveSavedResumeCwd({ ...record, worktree_branch: "saved" })).toBe(root);
    await expect(resolveSavedResumeCwd({ ...record, worktree_branch: "other" })).rejects.toThrow(/differs/);
    expect(execFileSync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim()).toBe("saved");
  });
  it("raw shell execution preserves spaces, apostrophes and trailing whitespace", () => {
    const cwd = join(root, "chat's cwd "); mkdirSync(cwd);
    writeFileSync(join(root, "codex"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)}));', { mode: 0o700 });
    const command = buildRawResumeCommand("codex", "test", id, { cwd, permissionMode: "default" });
    const result = JSON.parse(execFileSync("/bin/zsh", ["-c", command], { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}` } }));
    expect(result).toEqual({ cwd: realpathSync(cwd), argv: ["resume", id, "--cd", cwd] });
  });
});
