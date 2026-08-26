import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("launchd CI wiring", () => {
  it("runs every launchd bundle test on a macOS CI runner without installing it", () => {
    const workflow = readFileSync(
      join(import.meta.dirname, "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("launchd-units:");
    expect(workflow).toMatch(/launchd-units:[\s\S]*runs-on: macos-latest/);
    for (const unit of [
      "cmux-caffeinate",
      "cmux-contract-nightly",
      "cmux-memory-watchdog",
      "cmux-ram-sampler",
    ]) {
      expect(workflow).toContain(`bash launchd/${unit}/tests/run-tests.sh`);
    }
    expect(workflow).not.toMatch(/launchd-units:[\s\S]*launchctl\s+(?:bootstrap|load)/);
  });
});
