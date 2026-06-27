import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "..");

function packageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  return pkg.scripts;
}

describe("pre-PR script ladder", () => {
  it("keeps the default pre-pr gate deterministic and usage-free", () => {
    const scripts = packageScripts();

    expect(scripts["pre-pr"]).toContain("bun run typecheck");
    expect(scripts["pre-pr"]).toContain("bun run pre-pr:harness");
    expect(scripts["pre-pr"]).not.toContain("live:harness");
    expect(scripts["pre-pr"]).not.toContain("pre-pr:live");
  });

  it("includes the production-shaped replay coverage in the deterministic harness tier", () => {
    const scripts = packageScripts();

    expect(scripts["pre-pr:harness"]).toContain(
      "tests/live-agent-harness-replay.test.ts",
    );
  });

  it("exposes an explicit live pre-pr tier through the live harness", () => {
    const scripts = packageScripts();

    expect(scripts["pre-pr:live"]).toBe("bun run live:harness");
  });

  it("refuses the live harness unless CMUX_LIVE_HARNESS=1 is set", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts", "run-live-agent-harness.mjs"), "--help"],
      {
        cwd: repoRoot,
        env: { ...process.env, CMUX_LIVE_HARNESS: "" },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CMUX_LIVE_HARNESS=1");
  });

  it("defaults the live harness to one sterile Cursor worker", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "run-live-agent-harness.mjs"),
      "utf8",
    );

    expect(script).toContain('cli: "cursor"');
    expect(script).toContain("count: 1");
    expect(script).toContain('mcpProfile: "sterile"');
    expect(script).not.toContain("count: 8");
  });

  it("keeps the hook installer explicit and transparent", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "install-hooks.mjs"),
      "utf8",
    );

    expect(script).toContain(".git");
    expect(script).toContain("pre-push");
    expect(script).toContain("exec bun run pre-pr");
  });
});
