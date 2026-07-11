import { describe, it, expect } from "vitest";
import {
  assertBuildVersion,
  createStaleBuildWarner,
  detectStaleBuild,
  readVersion,
  resolveInstalledDaemonScript,
} from "../src/version.js";

describe("resolveInstalledDaemonScript", () => {
  it("resolves the daemon beside the formula libexec package.json", () => {
    expect(
      resolveInstalledDaemonScript(
        "/opt/homebrew/opt/cmuxlayer/libexec/package.json",
      ),
    ).toBe("/opt/homebrew/opt/cmuxlayer/libexec/dist/daemon.js");
  });
});

describe("assertBuildVersion", () => {
  it("returns ok when the running build matches expected", () => {
    const running = readVersion();
    const result = assertBuildVersion(running);
    expect(result).toEqual({ ok: true, running, expected: running });
  });

  it("reports a mismatch structurally without throwing by default", () => {
    const running = readVersion();
    const result = assertBuildVersion("0.0.0-nope", { running });
    expect(result).toEqual({
      ok: false,
      running,
      expected: "0.0.0-nope",
    });
  });

  it("throws on mismatch when throwOnMismatch is set", () => {
    expect(() =>
      assertBuildVersion("0.0.0-nope", {
        running: "1.2.3",
        throwOnMismatch: true,
      }),
    ).toThrow(/Build version mismatch: running 1\.2\.3, expected 0\.0\.0-nope/);
  });

  it("does not throw on a match even with throwOnMismatch set", () => {
    const result = assertBuildVersion("1.2.3", {
      running: "1.2.3",
      throwOnMismatch: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("detectStaleBuild", () => {
  const optPath = "/fake/opt/cmuxlayer/package.json";
  const readInstalled = (version: string) => () => JSON.stringify({ version });

  it("reports stale:false when running matches installed", () => {
    const result = detectStaleBuild({
      isDev: false,
      running: "0.3.17",
      optPackageJsonPath: optPath,
      readFile: readInstalled("0.3.17"),
    });
    expect(result).toEqual({
      stale: false,
      running: "0.3.17",
      installed: "0.3.17",
    });
  });

  it("reports stale:true when running differs from installed", () => {
    const result = detectStaleBuild({
      isDev: false,
      running: "0.3.16",
      optPackageJsonPath: optPath,
      readFile: readInstalled("0.3.18"),
    });
    expect(result).toEqual({
      stale: true,
      running: "0.3.16",
      installed: "0.3.18",
    });
  });

  it("returns null (skip) when the opt package.json is unreadable", () => {
    const result = detectStaleBuild({
      isDev: false,
      running: "0.3.17",
      optPackageJsonPath: optPath,
      readFile: () => {
        throw new Error("ENOENT: no such file");
      },
    });
    expect(result).toBeNull();
  });

  it("returns null (skip) when the opt package.json is unparseable", () => {
    const result = detectStaleBuild({
      isDev: false,
      running: "0.3.17",
      optPackageJsonPath: optPath,
      readFile: () => "not json {{{",
    });
    expect(result).toBeNull();
  });

  it("returns null (skip) when the installed version field is missing", () => {
    const result = detectStaleBuild({
      isDev: false,
      running: "0.3.17",
      optPackageJsonPath: optPath,
      readFile: () => JSON.stringify({ name: "cmuxlayer" }),
    });
    expect(result).toBeNull();
  });

  it("returns null (skip) under CMUXLAYER_DEV (running from source)", () => {
    const result = detectStaleBuild({
      isDev: true,
      running: "0.3.16",
      optPackageJsonPath: optPath,
      readFile: readInstalled("0.3.18"),
    });
    expect(result).toBeNull();
  });

  it("returns null (skip) when the running version is unknown", () => {
    const result = detectStaleBuild({
      isDev: false,
      running: "unknown",
      optPackageJsonPath: optPath,
      readFile: readInstalled("0.3.18"),
    });
    expect(result).toBeNull();
  });

  it("returns null (skip) when the opt path cannot be resolved", () => {
    const result = detectStaleBuild({
      isDev: false,
      running: "0.3.17",
      optPackageJsonPath: null,
      readFile: readInstalled("0.3.18"),
    });
    expect(result).toBeNull();
  });

  it("never throws even when the reader throws a non-Error", () => {
    expect(() =>
      detectStaleBuild({
        isDev: false,
        running: "0.3.17",
        optPackageJsonPath: optPath,
        readFile: () => {
          throw "boom";
        },
      }),
    ).not.toThrow();
  });
});

describe("createStaleBuildWarner", () => {
  const stale = (running: string, installed: string) => ({
    stale: running !== installed,
    running,
    installed,
  });

  it("does NOT permanently cache a not-yet-stale verdict — warns once a later upgrade bumps installed", () => {
    // This is the exact timeline this feature exists to catch: a fresh child
    // boots non-stale, a `brew upgrade` bumps the installed build mid-lifetime,
    // and the very next (post-throttle) spawn must surface the warning.
    let installed = "0.3.17";
    let t = 0;
    const warn = createStaleBuildWarner({
      detect: () => stale("0.3.17", installed),
      now: () => t,
      recheckIntervalMs: 30_000,
    });

    // Fresh process: running == installed -> no warning.
    expect(warn()).toBeNull();
    // Within the throttle window: still no warning, not permanently cached.
    t = 10_000;
    expect(warn()).toBeNull();

    // brew upgrade bumps the installed build; advance past the throttle.
    installed = "0.3.18";
    t = 40_000;
    const message = warn();
    expect(message).toContain("STALE build");
    expect(message).toContain("running v0.3.17");
    expect(message).toContain("installed v0.3.18");
  });

  it("caches the warning FOREVER once stale (it can never un-stale)", () => {
    let installed = "0.3.18";
    let t = 0;
    const warn = createStaleBuildWarner({
      detect: () => stale("0.3.17", installed),
      now: () => t,
      recheckIntervalMs: 30_000,
    });

    const first = warn();
    expect(first).toContain("STALE build");

    // Even if the installed build somehow matches again, the warning sticks.
    installed = "0.3.17";
    t = 1_000_000;
    expect(warn()).toBe(first);
  });

  it("throttles re-checks while not yet stale (no per-spawn fs read)", () => {
    let calls = 0;
    let t = 0;
    const warn = createStaleBuildWarner({
      detect: () => {
        calls += 1;
        return stale("1.0.0", "1.0.0");
      },
      now: () => t,
      recheckIntervalMs: 30_000,
    });

    expect(warn()).toBeNull();
    expect(calls).toBe(1);

    // Inside the throttle window: no re-read.
    t = 5_000;
    expect(warn()).toBeNull();
    expect(calls).toBe(1);

    // Past the throttle window: re-checks.
    t = 35_000;
    expect(warn()).toBeNull();
    expect(calls).toBe(2);
  });

  it("re-checks on every call when the running version cannot be determined (detect returns null)", () => {
    let calls = 0;
    const warn = createStaleBuildWarner({
      detect: () => {
        calls += 1;
        return null;
      },
      now: () => 0,
      recheckIntervalMs: 0,
    });

    expect(warn()).toBeNull();
    expect(warn()).toBeNull();
    expect(calls).toBe(2);
  });
});
