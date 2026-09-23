import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Replace one JSON file atomically. The synchronous write and rename cannot
 * interleave on this process's single JS thread; the PID separates processes.
 * Do not use this helper from worker_threads or switch to async writes without
 * giving each overlapping call a distinct temp path.
 */
export function atomicWriteJson(path: string, value: unknown, space?: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, space), "utf-8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The write or rename may have failed before the temp file existed.
    }
    throw error;
  }
}
