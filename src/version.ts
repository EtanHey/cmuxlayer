import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * Verdict for the "running child is a stale build" problem. After a release
 * (`brew upgrade`), the brew-pinned binary + main advance, but every already-
 * running per-agent MCP stdio child keeps executing the OLD `dist/` until the
 * agent `/mcp reconnect`s. That stale child silently serves spawns with the
 * pre-release placement/other logic — the exact class of bug #247 fixed in
 * source yet kept recurring live. `installed` is the version the brew opt path
 * reports (what a fresh reconnect would load); `running` is what this process
 * actually reports. `stale` is true when they differ.
 */
export interface StaleBuildResult {
  /** True when the running build differs from the installed (brew opt) build. */
  stale: boolean;
  /** Version this process actually reports (same source as serverInfo). */
  running: string;
  /** Version the installed brew opt package.json reports. */
  installed: string;
}

export interface DetectStaleBuildDeps {
  /** Override the running version (defaults to `readVersion()`). */
  running?: string;
  /** Override the installed package.json path (defaults to the brew opt path). */
  optPackageJsonPath?: string | null;
  /** Override the file reader (defaults to `readFileSync(path, "utf-8")`). */
  readFile?: (path: string) => string;
  /** Override the dev-mode flag (defaults to `CMUXLAYER_DEV === "1"`). */
  isDev?: boolean;
}

let cachedBrewPrefix: string | null | undefined;

/**
 * Resolve the Homebrew prefix ONCE per process. Prefers `HOMEBREW_PREFIX`, then
 * a single `brew --prefix` probe, then the standard install locations. Never
 * throws; returns null when nothing resolves.
 */
function resolveBrewPrefix(): string | null {
  if (cachedBrewPrefix !== undefined) return cachedBrewPrefix;
  cachedBrewPrefix = (() => {
    const fromEnv = process.env.HOMEBREW_PREFIX;
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
    try {
      // Bounded timeout: this runs on the first stale-check inside the MCP
      // process, so a hung/slow `brew` must never block spawns — fall through
      // to the standard install locations instead. execFileSync throws on
      // timeout (ETIMEDOUT), which the catch swallows.
      const out = execFileSync("brew", ["--prefix"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim();
      if (out) return out;
    } catch {
      // brew missing / not on PATH / slow (timed out) — fall through to the
      // standard locations. Never throw from prefix resolution.
    }
    if (existsSync("/opt/homebrew")) return "/opt/homebrew";
    if (existsSync("/usr/local")) return "/usr/local";
    return null;
  })();
  return cachedBrewPrefix;
}

/** Default installed-package.json path under the brew opt tree. */
export function defaultOptPackageJsonPath(): string | null {
  const prefix = resolveBrewPrefix();
  if (!prefix) return null;
  return join(prefix, "opt", "cmuxlayer", "libexec", "package.json");
}

/**
 * Resolve the brew-installed daemon entrypoint for version-bump reconnect.
 * Returns null when the opt tree cannot be resolved.
 */
export function resolveInstalledDaemonScript(
  optPackageJsonPath: string | null = defaultOptPackageJsonPath(),
): string | null {
  const optPackageJson = optPackageJsonPath;
  if (!optPackageJson) return null;
  return join(dirname(optPackageJson), "dist", "daemon.js");
}

/**
 * Detect whether this process is running a STALE build relative to the version
 * currently installed via brew. Best-effort and side-effect-light: it reads the
 * opt package.json directly via `fs` (no per-call shell-out; the brew prefix is
 * resolved once). Returns `null` (skip — cannot judge) when:
 *   - `CMUXLAYER_DEV=1` (running from live source, not the brew binary),
 *   - the running version is unknown,
 *   - the opt path cannot be resolved or the file is unreadable/unparseable.
 * NEVER throws — staleness detection must never break a spawn.
 */
export function detectStaleBuild(
  deps: DetectStaleBuildDeps = {},
): StaleBuildResult | null {
  try {
    const isDev = deps.isDev ?? process.env.CMUXLAYER_DEV === "1";
    if (isDev) return null;

    const running = deps.running ?? readVersion();
    if (!running || running === "unknown") return null;

    const optPath =
      deps.optPackageJsonPath === undefined
        ? defaultOptPackageJsonPath()
        : deps.optPackageJsonPath;
    if (!optPath) return null;

    const read =
      deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
    let installed: unknown;
    try {
      const pkg = JSON.parse(read(optPath)) as { version?: unknown };
      installed = pkg.version;
    } catch {
      // Missing / unreadable / unparseable opt package.json — cannot judge.
      return null;
    }
    if (typeof installed !== "string" || !installed) return null;

    return { stale: running !== installed, running, installed };
  } catch {
    // Absolutely never let staleness detection break a spawn.
    return null;
  }
}

export interface StaleBuildWarnerDeps {
  /** Override the detector (defaults to `detectStaleBuild`). */
  detect?: (deps?: DetectStaleBuildDeps) => StaleBuildResult | null;
  /** Injectable clock in ms (defaults to `Date.now`). */
  now?: () => number;
  /**
   * Minimum ms between re-checks while NOT yet stale. Small fs read, so cheap;
   * throttled only to avoid a per-spawn read. Defaults to 30s.
   */
  recheckIntervalMs?: number;
}

export const DEFAULT_STALE_RECHECK_INTERVAL_MS = 30_000;

/**
 * Build a memoized stale-build warner for a single process.
 *
 * A running process's OWN build never changes, but the INSTALLED build can bump
 * mid-lifetime (a `brew upgrade` while the per-agent MCP child keeps running),
 * so staleness only ever goes false -> true and NEVER back. Therefore:
 *   - once stale, we cache the warning FOREVER (it cannot un-stale), and
 *   - while NOT yet stale, we RE-CHECK on each call (throttled to
 *     `recheckIntervalMs`) so a later upgrade is caught — we never cache a
 *     not-yet-stale verdict permanently.
 *
 * Caching a not-yet-stale verdict permanently would defeat the entire feature:
 * a child that boots fresh (non-stale) would cache `null` and stay silent
 * through the very upgrade this warner exists to flag.
 */
export function createStaleBuildWarner(
  deps: StaleBuildWarnerDeps = {},
): () => string | null {
  const detect = deps.detect ?? detectStaleBuild;
  const now = deps.now ?? Date.now;
  const recheckIntervalMs =
    deps.recheckIntervalMs ?? DEFAULT_STALE_RECHECK_INTERVAL_MS;

  let stickyWarning: string | null = null;
  let lastCheckedAt: number | null = null;

  return function staleBuildWarning(): string | null {
    // Once stale, keep warning forever — it can never un-stale.
    if (stickyWarning !== null) return stickyWarning;

    const t = now();
    if (lastCheckedAt !== null && t - lastCheckedAt < recheckIntervalMs) {
      return null; // Throttled; still not-yet-stale.
    }
    lastCheckedAt = t;

    const stale = detect();
    if (stale && stale.stale) {
      stickyWarning = `cmuxlayer MCP is running a STALE build (running v${stale.running}, installed v${stale.installed}) — placement/other fixes are not live; /mcp reconnect this agent to load the current build.`;
      return stickyWarning;
    }
    return null;
  };
}
