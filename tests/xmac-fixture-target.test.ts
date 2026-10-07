import { expect, it } from "vitest";
import { targetOptions } from "../scripts/xmac/target.mjs";
import { targetEnvironment, shellStartup } from "../scripts/soak-runtime.mjs";
import { createContext } from "../scripts/xmac/ctx.mjs";
import { parseScreen } from "../src/screen-parser";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("makes fixtures mandatory and provisions NIGHTLY without an authenticated HOME", () => {
  expect(targetOptions({ host: "mbp", cmux: "nightly" })).toMatchObject({ fixtureMode: true });
  expect(() => targetOptions({ host: "m1", cmux: "prod", repo: "cmuxlayer", dmg: "/pin", fixtureMode: false })).toThrow("fixture");
});
it("keeps fixture shells in scratch and sources only the run's private launchers", () => {
  const env = targetEnvironment({}, "/scratch/run", { target: "m1-gate", fixtureMode: true }, "/human/home");
  expect(env.HOME).toBe("/scratch/run/home");
  const startup = shellStartup({ ...env, CMUXLAYER_LAUNCHER_REGISTRY_PATH: "/scratch/run/fixtures.zsh" }, {
    target: "m1-gate", launcherMode: true, fixtureMode: true });
  expect(startup).toContain("source '/scratch/run/fixtures.zsh'");
  expect(startup).not.toContain("golem-dispatch.zsh");
});
it("busy waiting consumes the real parser's status field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xmac-busy-status-"));
  try {
    const text = readFileSync("tests/fixtures/codex-0.157/idle-submitted-working.txt", "utf8");
    let clock = 0;
    const ctx = createContext({ evidenceDir: dir, parseScreen, now: () => clock, sleep: async () => { clock += 10000; },
      driver: { target: {}, call: async (name: string) => ({ structuredContent: name === "list_agents" ?
        { agents: [{ agent_id: "seat", surface_id: "surface" }] } : { ok: true } }), readScreen: async () => ({ text }) } });
    await expect(ctx.busy("seat", 10)).resolves.toMatchObject({ ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
