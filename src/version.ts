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

export interface BuildVersionCheck {
  /** True when the running build matches `expected`. */
  ok: boolean;
  /** The version this build actually reports (same source as serverInfo). */
  running: string;
  /** The version the caller asserted it should be. */
  expected: string;
}

/**
 * Checkable primitive for restart-readiness: instead of a blind "fresh cmux
 * loads vX.Y.Z" claim, assert `build == expected` against the version this
 * process actually reports (the same `readVersion()` the MCP serverInfo uses).
 * Returns a structured verdict; with `throwOnMismatch`, also throws so a
 * restart flow can hard-fail on a stale binary.
 */
export function assertBuildVersion(
  expected: string,
  opts?: { throwOnMismatch?: boolean; running?: string },
): BuildVersionCheck {
  const running = opts?.running ?? readVersion();
  const ok = running === expected;
  if (!ok && opts?.throwOnMismatch) {
    throw new Error(
      `Build version mismatch: running ${running}, expected ${expected}`,
    );
  }
  return { ok, running, expected };
}
