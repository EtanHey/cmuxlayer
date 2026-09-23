import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const renamedTemps = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (source: string, destination: string) => {
      renamedTemps.push(source);
      fs.renameSync(source, destination);
    },
  };
});

import { atomicWriteJson } from "../src/atomic-json-write.js";

let testDir: string;

beforeEach(() => {
  renamedTemps.length = 0;
  testDir = mkdtempSync(join(tmpdir(), "cmux-atomic-json-write-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

it("does not import crypto for a registry JSON write", () => {
  const source = readFileSync(new URL("../src/atomic-json-write.ts", import.meta.url), "utf-8");
  expect(source).not.toContain("node:crypto");
});

it("uses distinct temp paths for two writes in one process", () => {
  const target = join(testDir, "state.json");
  atomicWriteJson(target, { version: 1 });
  atomicWriteJson(target, { version: 2 });

  expect(renamedTemps).toHaveLength(2);
  expect(new Set(renamedTemps).size).toBe(2);
  expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ version: 2 });
});
