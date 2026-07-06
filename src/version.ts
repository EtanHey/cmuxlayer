import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function readVersion(): string {
  // package.json sits one level above the compiled entrypoint (dist/version.js
  // -> ../package.json, and likewise libexec/dist/version.js -> libexec/package.json
  // for a brew install). Best-effort; never throw from a --version probe.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
