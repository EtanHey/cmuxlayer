import { describe, it, expect } from "vitest";
import {
  assertBuildVersion,
  detectStaleBuild,
  readVersion,
} from "../src/version.js";

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
