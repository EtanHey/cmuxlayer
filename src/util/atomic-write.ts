import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * AIDEV-NOTE: the one tmp+rename primitive. A reader sees either the old file
 * or the new one, never a partial write. The temp name carries the pid and a
 * UUID so overlapping writers (processes, or async calls in one process) never
 * share a temp path, and a failed write or rename removes its temp file
 * instead of leaving it beside the target.
 */
export interface AtomicWriteOptions {
  /** Create the parent directory first. */
  mkdir?: boolean;
  /** File mode for the new file; applied with chmod so the umask cannot narrow it. */
  mode?: number;
  /** Dot-prefix the temp file so directory scans and `*` globs never see it. */
  hiddenTemp?: boolean;
}

function tempPathFor(path: string, hidden = false): string {
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  return hidden
    ? join(dirname(path), `.${basename(path)}.${suffix}`)
    : `${path}.${suffix}`;
}

/** Replace `path` with `content` atomically (synchronous). */
export function atomicWriteFileSync(
  path: string,
  content: string,
  opts: AtomicWriteOptions = {},
): void {
  if (opts.mkdir) mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path, opts.hiddenTemp);
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: opts.mode });
    if (opts.mode !== undefined) chmodSync(tmp, opts.mode);
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Cleanup is best-effort; never let it replace the write's own error.
    }
    throw error;
  }
}

/** Replace `path` with `content` atomically (async). */
export async function atomicWriteFile(
  path: string,
  content: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  if (opts.mkdir) await mkdir(dirname(path), { recursive: true });
  const tmp = tempPathFor(path, opts.hiddenTemp);
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: opts.mode });
    if (opts.mode !== undefined) await chmod(tmp, opts.mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {
      // Cleanup is best-effort; never let it replace the write's own error.
    });
    throw error;
  }
}

/**
 * Replace one JSON file atomically: `JSON.stringify(value, null, space)`, no
 * trailing newline (the historical format of its callers).
 */
export function atomicWriteJson(path: string, value: unknown, space?: number): void {
  atomicWriteFileSync(path, JSON.stringify(value, null, space));
}
