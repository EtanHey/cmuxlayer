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
    expect(source).toContain("ps -eo pid=,comm=");
    expect(source).toContain('executable == "claude" || executable == "codex"');
    expect(source).not.toContain(".local/bin/(claude|codex)");
  });

  it("states that casualty output is evidence rather than a release verdict", () => {
    expect(source).toContain("mandatory evidence report, not a release gate");
  });
});
