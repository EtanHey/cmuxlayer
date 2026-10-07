import { expect, it } from "vitest";
import { boundedSpawn } from "../scripts/xmac/target-client.mjs";

it("lead-spawned children remain cheap and in the private workspace without injecting a role", () => {
  const defaults = { repo: "registered", cwd: "/private/repo", workspace: "workspace:test" };
  const args = boundedSpawn({ repo: "other", workspace: "production", cwd: "/foreign", worktree: true, cli: "codex" }, defaults);
  expect(args).toMatchObject({ ...defaults, worktree: false, cli: "codex", model: "gpt-6-luna", effort: "low" });
  expect(args).not.toHaveProperty("role"); // Preserve the omitted-role defect trigger.
  expect(() => boundedSpawn({ cli: "claude", model: "opus" }, defaults)).toThrow("cheapest");
  expect(() => boundedSpawn({ cli: "codex", effort: "high" }, defaults)).toThrow("cheapest");
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
