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

it("auth preflight checks the target environment and refuses a logged-out CLI without model calls", async () => {
  const { checkCliAuth } = await import("../scripts/xmac/target-client.mjs");
  const env = { HOME: "/synthetic/auth", CODEX_HOME: "/synthetic/auth/.codex" };
  const calls: any[] = [];
  checkCliAuth("codex", env, (...args: any[]) => { calls.push(args); return { status: 0, stdout: "" }; });
  expect(calls[0]).toEqual(["/opt/homebrew/bin/codex", ["login", "status"], expect.objectContaining({ env })]);
  expect(() => checkCliAuth("claude", env, () => ({ status: 0, stdout: '{"loggedIn":false}' }))).toThrow("authentication precondition");
  expect(() => checkCliAuth("codex", env, () => ({ status: 1, stdout: "" }))).toThrow("authentication precondition");
});

it("target normalization branches resume before defaults/cheap-model injection and requires pre-close registry identity", async () => {
  const { captureSpawnIdentity } = await import("../scripts/xmac/resume-identity.mjs");
  const identities = new Map(), defaults = { repo: "registered", cwd: "/private/repo", workspace: "workspace:private" };
  await captureSpawnIdentity(identities, { ok: true, agent_id: "seat", surface_id: "surface:1", model_policy: { cli: "claude", effective_model: "haiku" } }, async () => ({ agent_id: "seat", surface_id: "surface:1", cli: "claude", detail: { agent_id: "seat", cli: "claude", cli_session_id: "synthetic" } }));
  expect(boundedSpawn({ resume_agent_id: "seat", force: true, focus: false, workspace: "foreign", verbose: true, cli: "codex", model: "expensive", repo: "foreign", cwd: "/foreign", worktree: true, mcp_profile: "full" }, defaults, identities))
    .toEqual({ resume_agent_id: "seat", force: true, focus: false, verbose: true, workspace: "workspace:private" });
  expect(() => boundedSpawn({ resume_agent_id: "absent", cli: "codex" }, defaults, identities)).toThrow("PRECONDITION_ABSENT");
});

it.each([
  { ok: false, model: "gpt-6-luna" },
  { ok: true, model: "expensive" },
])("never seeds resume identity from failed or non-cheap spawns: %j", async receipt => {
  const { captureSpawnIdentity } = await import("../scripts/xmac/resume-identity.mjs");
  let reads = 0;
  const identities = new Map();
  await captureSpawnIdentity(identities, { agent_id: "seat", surface_id: "surface:1", cli: "codex", ...receipt }, async () => { reads++; return { agent_id: "seat", cli: "codex", cli_session_id: "synthetic" }; });
  expect(reads).toBe(0); expect(identities.size).toBe(0);
});
