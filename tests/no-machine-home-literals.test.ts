import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("portable committed paths", () => {
  it("rejects machine-literal macOS home paths outside documentation", () => {
    const pattern = ["", "Users", "[^/]+", ""].join("/");
    let matches = "";
    try {
      matches = execFileSync(
        "git",
        [
          "grep",
          "-nE",
          pattern,
          "--",
          ":!docs/**",
          ":!docs.local/**",
        ],
        { encoding: "utf8" },
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 1) throw error;
    }

    expect(matches, matches).toBe("");
  });
});
