import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("scratch workspace harness cleanup", () => {
  it("registry-liveness create-workspace mode deletes its scratch workspace in finally", () => {
    const source = readFileSync(
      resolve("scripts/acceptance-registry-liveness.mjs"),
      "utf8",
    );

    expect(source).toContain('a === "--create-workspace"');
    expect(source).toMatch(
      /finally\s*{[\s\S]*?delete_workspace[\s\S]*?force:\s*true/,
    );
  });

  it("worker-placement repro deletes its scratch workspace in finally", () => {
    const source = readFileSync(
      resolve("scripts/run-live-worker-placement-repro.ts"),
      "utf8",
    );

    expect(source).toMatch(
      /finally\s*{[\s\S]*?delete_workspace[\s\S]*?force:\s*true/,
    );
  });
});
