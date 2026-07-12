import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("registry-liveness live acceptance harness", () => {
  it("§b: self-tests dead-child receipt, screen-context, and convergence classification", () => {
    const script = resolve("scripts/acceptance-registry-liveness.mjs");
    const result = spawnSync(
      process.execPath,
      [script, "--self-test-dead-child"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("delivered_false=PASS");
    expect(result.stdout).toContain("dead_error_skip=PASS");
    expect(result.stdout).toContain("live_agent_echo=PASS");
    expect(result.stdout).toContain("shell_false_green=PASS");
    expect(result.stdout).toContain("stale_identity_shell_false_green=PASS");
    expect(result.stdout).toContain("three_attempt_convergence=PASS");
    expect(result.stdout).toContain("GREEN_DEADCHILD_SELFTEST");
  });

  it("reports a controlled RED result when the MCP server cannot spawn", () => {
    const script = resolve("scripts/acceptance-registry-liveness.mjs");
    const result = spawnSync(
      process.execPath,
      [script, "--server", "/definitely/missing/cmuxlayer-server", "--count", "1"],
      {
        encoding: "utf8",
        env: { ...process.env, CMUX_LIVE_HARNESS: "1" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("RED_REGISTRY_LIVENESS");
    expect(result.stderr).not.toContain("Unhandled 'error' event");
  });
});
