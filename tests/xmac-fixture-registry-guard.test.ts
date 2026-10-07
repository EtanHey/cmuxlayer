import { expect, it } from "vitest";
import { installFixtureLaunchers, verifyFixtureLaunchers } from "../scripts/xmac/fixture-launchers.mjs";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture(run: (receipt: any, env: any) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "m1-launcher-guard-")));
  try {
    mkdirSync(join(root, "repo"));
    const env: any = { HOME: join(root, "home"), PATH: "/synthetic/inherited-models", LC_ALL: "C" };
    const receipt = installFixtureLaunchers(env, { repo: "ratchet", app: "/absent/app", fixtureRow: "contract" }, root, join(root, "repo"));
    run(receipt, env);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it("requires a registry on the actual launch environment and excludes inherited/bundle PATH", () => fixture((r, env) => {
  expect(env.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY).toBe("1");
  expect(env.PATH.split(":")).toEqual([join(r.root, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  expect(() => verifyFixtureLaunchers(r, { ...env, CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY: "0" })).toThrow();
}));
for (const fault of ["missing", "malformed", "unresolvable", "foreign", "symlink"])
  it(`refuses ${fault} registry before a synthetic execution boundary`, () => fixture((r, env) => {
    const path = env.CMUXLAYER_LAUNCHER_REGISTRY_PATH;
    if (fault === "missing") unlinkSync(path);
    if (fault === "malformed") writeFileSync(path, "repoGolem '\n");
    if (fault === "unresolvable") writeFileSync(path, "repoGolem absent /absent\n");
    if (fault === "foreign") env.CMUXLAYER_LAUNCHER_REGISTRY_PATH = "/synthetic/foreign";
    if (fault === "symlink") { const other = join(r.root, "other"); writeFileSync(other, readFileSync(path)); unlinkSync(path); symlinkSync(other, path); }
    const launches: string[] = [];
    expect(() => { verifyFixtureLaunchers(r, env); launches.push("launch"); }).toThrow();
    expect(launches).toEqual([]);
    expect(existsSync(join(r.root, "model-trap.log"))).toBe(false);
  }));

it("blocks model-named raw fallback with executable synthetic traps", () => fixture((r, env) => {
  for (const cli of ["codex", "claude"]) {
    const result = spawnSync(r.binaries[cli], ["--version"], { env, encoding: "utf8" });
    expect(result.status).toBe(86);
  }
  expect(readFileSync(join(r.root, "model-trap.log"), "utf8").trim().split("\n")).toEqual(["codex", "claude"]);
  expect(() => verifyFixtureLaunchers(r, env)).toThrow("trap");
}));

it("rechecks registry identity at the actual launcher boundary", () => fixture((r, env) => {
  writeFileSync(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH, "repoGolem absent /absent\n");
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/xmac/fixture-launchers.mjs"), "launcher", "codex"], { env, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/registry|identity/i);
  expect(existsSync(join(r.root, "ratchet-events.json"))).toBe(false);
}));

it("refuses module, interpreter and binary identity drift", () => fixture((r, env) => {
  expect(r.attestation?.files?.tui?.path).toBe(realpathSync(join(process.cwd(), "scripts/ratchet-fixture-tui.mjs")));
  expect(() => verifyFixtureLaunchers({ ...r, tui: "/synthetic/foreign.mjs" }, env)).toThrow();
  if (r.attestation) {
    for (const key of ["node", "tui", "helper"]) {
      const copy = structuredClone(r); copy.attestation.files[key].sha256 = "0".repeat(64);
      expect(() => verifyFixtureLaunchers(copy, env)).toThrow();
    }
  }
}));
