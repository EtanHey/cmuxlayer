import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
