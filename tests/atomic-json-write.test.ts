import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const operations = vi.hoisted(() => [] as Array<{ kind: "write" | "rename"; path: string }>);

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (path: string, data: string, encoding: BufferEncoding) => {
      operations.push({ kind: "write", path });
      fs.writeFileSync(path, data, encoding);
    },
    renameSync: (source: string, destination: string) => {
      operations.push({ kind: "rename", path: source });
      fs.renameSync(source, destination);
    },
  };
});

import { atomicWriteJson } from "../src/atomic-json-write.js";

let testDir: string;

beforeEach(() => {
  operations.length = 0;
  testDir = mkdtempSync(join(tmpdir(), "cmux-atomic-json-write-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

it("does not import crypto for a registry JSON write", () => {
  const source = readFileSync(new URL("../src/atomic-json-write.ts", import.meta.url), "utf-8");
  expect(source).not.toContain("node:crypto");
});

it("reuses its process temp path with synchronous write-then-rename calls", () => {
  const target = join(testDir, "state.json");
  const tmp = `${target}.${process.pid}.tmp`;

  expect(atomicWriteJson(target, { version: 1 })).toBeUndefined();
  expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ version: 1 });
  expect(existsSync(tmp)).toBe(false);

  expect(atomicWriteJson(target, { version: 2 })).toBeUndefined();
  expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ version: 2 });
  expect(existsSync(tmp)).toBe(false);

  expect(operations).toEqual([
    { kind: "write", path: tmp },
    { kind: "rename", path: tmp },
    { kind: "write", path: tmp },
    { kind: "rename", path: tmp },
  ]);
});
