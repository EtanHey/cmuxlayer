import { describe, it, expect } from "vitest";
import { assertBuildVersion, readVersion } from "../src/version.js";

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
