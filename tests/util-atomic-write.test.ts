import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJson,
} from "../src/util/atomic-write.js";
import { sleep } from "../src/util/sleep.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cmuxlayer-atomic-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("atomicWriteFileSync", () => {
  it("throws the write's own error when temp cleanup also fails", () => {
    const dir = tempDir();
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    // The parent is a file: the write fails (ENOTDIR), and so would a cleanup rm.
    let thrown: NodeJS.ErrnoException | undefined;
    try {
      atomicWriteFileSync(join(file, "child.json"), "{}");
    } catch (error) {
      thrown = error as NodeJS.ErrnoException;
    }
    expect(thrown?.syscall).toBe("open");
  });

  it("replaces the file with exactly the given content and leaves no temp file", () => {
    const dir = tempDir();
    const path = join(dir, "state.json");
    writeFileSync(path, "old");

    atomicWriteFileSync(path, '{"a":1}\n');

    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n');
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("creates the parent directory when asked", () => {
    const dir = tempDir();
    const path = join(dir, "nested", "deeper", "cursor");

    atomicWriteFileSync(path, "m1\n", { mkdir: true });

    expect(readFileSync(path, "utf8")).toBe("m1\n");
  });

  it("removes its temp file when the rename fails", () => {
    const dir = tempDir();
    const path = join(dir, "target");
    mkdirSync(path); // a directory: rename(tmp file -> dir) fails

    expect(() => atomicWriteFileSync(path, "x")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});

describe("atomicWriteFile (async)", () => {
  it("writes the content and removes its temp file on failure", async () => {
    const dir = tempDir();
    const ok = join(dir, "manifest.json");
    await atomicWriteFile(ok, "{}\n");
    expect(readFileSync(ok, "utf8")).toBe("{}\n");

    const blocked = join(dir, "blocked");
    mkdirSync(blocked);
    await expect(atomicWriteFile(blocked, "x")).rejects.toThrow();
    expect(readdirSync(dir).sort()).toEqual(["blocked", "manifest.json"]);
  });
});

describe("atomic write options", () => {
  it("applies the file mode despite the umask and can hide its temp file", async () => {
    const dir = tempDir();
    const path = join(dir, "surface.json");
    const seen: string[] = [];
    const watcher = setInterval(() => seen.push(...readdirSync(dir)), 0);
    await atomicWriteFile(path, "{}\n", { mode: 0o600, hiddenTemp: true });
    atomicWriteFileSync(join(dir, "hooks.json"), "{}", { mode: 0o640 });
    clearInterval(watcher);

    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(join(dir, "hooks.json")).mode & 0o777).toString(8)).toBe("640");
    expect(seen.filter((name) => name.endsWith(".tmp") && !name.startsWith("."))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["hooks.json", "surface.json"]);
  });
});

describe("atomicWriteJson", () => {
  it("keeps its existing JSON formatting (no trailing newline, optional indent)", () => {
    const dir = tempDir();
    const path = join(dir, "x.json");
    atomicWriteJson(path, { a: 1 }, 2);
    expect(readFileSync(path, "utf8")).toBe('{\n  "a": 1\n}');
  });
});

describe("sleep", () => {
  it("resolves only after the given delay", async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = sleep(1_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });
});
