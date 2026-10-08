import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentEngine } from "../src/agent-engine.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});

let directory: string;
let path: string;
const snapshot = (path: string) => (AgentEngine.prototype as unknown as {
  readReportWatchSnapshot: (path: string) => { bytes: Buffer; mtimeMs: number } | null;
}).readReportWatchSnapshot(path);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "report-snapshot-"));
  path = join(directory, "report.md");
  vi.mocked(readSync).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("preserves unchanged legacy reopen floors across actual timestamp samples", () => {
  const bytes = Buffer.from("Complete\nDONE_LEGACY_CHILD\n");
  writeFileSync(path, bytes);
  const child = { agent_id: "legacy-child", parent_agent_id: "parent", report_path: path,
    done_marker: "DONE_LEGACY_CHILD", state: "working", boot_instance_id: "boot",
    report_episode_key: "boot:0", report_done_delivery_id: "original-done",
    report_episode_started_at: "", reopen_report_mtime_ms: 0 };
  const engine = Object.assign(Object.create(AgentEngine.prototype), {
    stateMgr: { listStates: () => [child] }, reportOutcomeNotifications: true,
  }) as AgentEngine;
  const digest = createHash("sha256").update(bytes).digest("hex");
  const base = Math.floor(Date.now() / 1000) - 20;
  for (let i = 1; i <= 64; i++) {
    const seconds = base + i / 1_000_000;
    utimesSync(path, seconds, seconds);
    const legacy = statSync(path).mtimeMs;
    child.reopen_report_mtime_ms = legacy;
    child.report_episode_started_at = new Date(legacy - 1000).toISOString();
    expect(snapshot(path)!.mtimeMs).toBe(legacy);
    expect(engine.coalescesReportWatch("parent", path, digest), `sample=${i}; floor=${legacy}`).toBe(false);
    expect(child.report_done_delivery_id).toBe("original-done");
  }
});

it.each([0, 1024 * 1024])("reads a stable %i-byte snapshot once", (size) => {
  const bytes = Buffer.alloc(size, "a");
  writeFileSync(path, bytes);
  const result = snapshot(path)!;
  expect(result.bytes).toEqual(bytes);
  expect(Number.isFinite(result.mtimeMs)).toBe(true);
  expect(readSync).toHaveBeenCalledOnce();
});

it.each(["oversized", "missing", "directory"])("declines %s reports before reading", (mode) => {
  if (mode === "oversized") writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
  if (mode === "directory") mkdirSync(path);
  expect(snapshot(path)).toBeNull();
  expect(readSync).not.toHaveBeenCalled();
});

it.each(["grow", "replace", "ABA"])("declines real %s writes during the byte read", (mode) => {
  const originalBytes = "IN_PROGRESS snapshot A\n";
  writeFileSync(path, originalBytes);
  const realRead = vi.mocked(readSync).getMockImplementation()!;
  vi.mocked(readSync).mockImplementationOnce((...args: Parameters<typeof readSync>) => {
    if (mode === "ABA") writeFileSync(path, "Terminal B\nDONE_SNAPSHOT\n");
    const length = realRead(...args);
    if (mode === "grow") writeFileSync(path, `${originalBytes}extra\n`);
    if (mode === "ABA") writeFileSync(path, originalBytes);
    if (mode === "replace") {
      const replacement = `${path}.replacement`;
      writeFileSync(replacement, originalBytes);
      renameSync(replacement, path);
    }
    return length;
  });
  expect(snapshot(path)).toBeNull();
  expect(readSync).toHaveBeenCalledOnce();
  if (mode === "ABA") expect(readFileSync(path, "utf8")).toBe(originalBytes);
});
