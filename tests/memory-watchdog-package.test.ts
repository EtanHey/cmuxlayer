import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("cmux memory watchdog package", () => {
  const root = join(import.meta.dirname, "..", "launchd", "cmux-memory-watchdog");

  it("documents the tested watchdog and ships a portable opt-in installer", () => {
    const readme = join(root, "README.md");
    const installer = join(root, "install.sh");
    expect(existsSync(readme)).toBe(true);
    expect(existsSync(installer)).toBe(true);
    expect(readFileSync(readme, "utf8")).toContain("--install");

    const result = spawnSync("bash", [installer, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, HOME: "/Users/example" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      join(root, "bin", "cmux-memory-watchdog.sh"),
    );
    expect(result.stdout).toContain(
      "/Users/example/Library/Logs/cmux-watchdog/launchd.stdout.log",
    );
    expect(result.stdout).not.toContain(
      "/Users/etanheyman/Gits/cmuxlayer/launchd/cmux-memory-watchdog/",
    );
    expect(result.stdout).not.toContain("launchctl bootstrap");
  });

  it("keeps the macOS unit suite compatible with BSD find", () => {
    const unitSuite = readFileSync(
      join(root, "tests", "cmux-memory-watchdog.sh"),
      "utf8",
    );
    expect(unitSuite).not.toContain("-maxdepth");
  });
});
