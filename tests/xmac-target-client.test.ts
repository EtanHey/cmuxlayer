import { expect, it } from "vitest";
import { boundedSpawn, claudeWrapper } from "../scripts/xmac/target-client.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

it("real registered launcher Claude argv receives only the private MCP config", () => {
  const root = mkdtempSync(join(tmpdir(), "xmac-wrapper-test-"));
  try {
    const binary = join(root, "fake claude");
    writeFileSync(binary, '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const wrapper = join(root, "wrapper");
    writeFileSync(wrapper, claudeWrapper(binary, join(root, "private-mcp.json")), { mode: 0o700 });
    const args = execFileSync(wrapper, ["--model", "haiku", "--mcp-config", "/foreign/config", "--mcp-config=/other/config", "--strict-mcp-config", "--resume", "synthetic"], { encoding: "utf8" }).trim().split("\n");
    expect(args).toEqual(["--strict-mcp-config", "--mcp-config", join(root, "private-mcp.json"), "--model", "haiku", "--resume", "synthetic"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("lead-spawned children remain cheap and in the private workspace without injecting a role", () => {
  const defaults = { repo: "registered", cwd: "/private/repo", workspace: "workspace:test" };
  const args = boundedSpawn({ repo: "other", workspace: "production", cwd: "/foreign", worktree: true, cli: "codex" }, defaults);
  expect(args).toMatchObject({ ...defaults, worktree: false, cli: "codex", model: "gpt-6-luna", effort: "low" });
  expect(args).not.toHaveProperty("role"); // Preserve the omitted-role defect trigger.
  expect(() => boundedSpawn({ cli: "claude", model: "opus" }, defaults)).toThrow("cheapest");
  expect(() => boundedSpawn({ cli: "codex", effort: "high" }, defaults)).toThrow("cheapest");
});
