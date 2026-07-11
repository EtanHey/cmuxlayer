import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Compare ESM identity without trusting symlink spelling; never throws. */
export function isMainModule(
  importMetaUrl: string,
  argvEntry: string | undefined,
): boolean {
  if (!argvEntry) return false;
  try {
    return (
      canonicalPath(fileURLToPath(importMetaUrl)) === canonicalPath(argvEntry)
    );
  } catch {
    return false;
  }
}
