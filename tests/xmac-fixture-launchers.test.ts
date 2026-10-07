import { expect, it } from "vitest";
import { fixtureLaunchArgs, installFixtureLaunchers, verifyFixtureLaunchers } from "../scripts/xmac/fixture-launchers.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
it("converts actual launcher worker/model/cwd flags without inventing worker provenance", () => {
  const worker = fixtureLaunchArgs("codex", ["-s", "--worker", "-m", "gpt-6-luna", "-E", "low", "-w", "/scratch/repo"]);
  expect(worker).toEqual({ cwd: "/scratch/repo", argv: ["--model", "gpt-6-luna", "-c", "model_reasoning_effort=low",
    "-c", "features.apps=false", "-c", "apps._default.enabled=false"], worker: true });
  expect(fixtureLaunchArgs("codex", ["-m", "gpt-6-luna"]).argv).not.toContain("features.apps=false");
});
it("provisions both private CLIs and a fresh registry, strips credentials and refuses binary drift", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xmac-fixture-launchers-")));
  try {
    const cwd = join(root, "repo"); mkdirSync(cwd);
    const env: any = { HOME: join(root, "home"), OPENAI_API_KEY: "synthetic", ANTHROPIC_API_KEY: "synthetic", PATH: "/human/bin" };
    const receipt = installFixtureLaunchers(env, { repo: "fixture", app: "/absent/app" }, root, cwd);
    expect(env).not.toHaveProperty("OPENAI_API_KEY"); expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env.PATH).not.toContain("/human/bin");
    expect(env.CMUX_CUSTOM_CODEX_PATH).toBe(receipt.binaries.codex);
    expect(readFileSync(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH, "utf8")).toContain("repoGolem fixture");
    verifyFixtureLaunchers(receipt);
    expect(() => verifyFixtureLaunchers({ ...receipt, binaries: {} })).toThrow("missing");
    for (const cli of ["codex", "claude"]) {
      const value = JSON.parse(execFileSync(receipt.binaries[cli], ["--xmac-preflight"], { env, encoding: "utf8" }));
      expect(value).toMatchObject({ fixture: true, cli });
    }
    writeFileSync(receipt.binaries.codex, "changed");
    expect(() => verifyFixtureLaunchers(receipt)).toThrow("identity changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("retains resume identity and only bounds fixture metadata", () => {
  expect(fixtureLaunchArgs("claude", ["--worker", "--resume", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "-m", "haiku"]))
    .toMatchObject({ worker: true, argv: ["--resume", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "--model", "haiku"] });
  expect(() => fixtureLaunchArgs("codex", ["-m"])).toThrow();
  expect(() => fixtureLaunchArgs("claude", ["-m", "opus"])).toThrow();
  expect(() => fixtureLaunchArgs("codex", ["-E", "high"])).toThrow();
});
