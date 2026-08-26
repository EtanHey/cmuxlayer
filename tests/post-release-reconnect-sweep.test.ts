import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("post-release reconnect sweep portability", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "scripts", "post-release-reconnect-sweep.sh"),
    "utf8",
  );

  it("discovers the installed binary without assuming an Apple Silicon prefix", () => {
    expect(source).toContain("brew --prefix cmuxlayer");
    expect(source).toContain("command -v cmuxlayer");
    expect(source).not.toContain("/opt/homebrew/opt/cmuxlayer/bin/cmuxlayer");
  });

  it("enumerates Claude and Codex by executable basename at any path", () => {
    expect(source).toContain("ps -c -eo pid=,comm=");
    expect(source).toContain('$1 = ""');
    expect(source).toContain('executable = $0');
    expect(source).toContain('executable == "claude" || executable == "codex"');
    expect(source).not.toContain(".local/bin/(claude|codex)");

    const parsed = spawnSync(
      "awk",
      [
        '{ pid = $1; $1 = ""; sub(/^[[:space:]]+/, "", $0); executable = $0; sub(/^.*\\//, "", executable); if (executable == "claude" || executable == "codex") print pid, executable }',
      ],
      { input: "123 /home/test-user/.local/bin/claude\n", encoding: "utf8" },
    );
    expect(parsed.status).toBe(0);
    expect(parsed.stdout.trim()).toBe("123 claude");
  });

  it("states that casualty output is evidence rather than a release verdict", () => {
    expect(source).toContain("mandatory evidence report, not a release gate");
  });
});
import { spawnSync } from "node:child_process";
