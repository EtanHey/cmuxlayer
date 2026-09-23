import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Replace one JSON file atomically without sharing a temp path with other writers. */
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
