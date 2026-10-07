import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLauncherRoots, scenarioLaunchers, launchFailureRows } from "../scripts/xmac/launcher-preflight.mjs";
import { ratchetProof } from "../scripts/xmac/runner.mjs";
import * as registry from "../src/launcher-registry.js";
const targetHome = vi.hoisted(() => ({ value: "" }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(),
  hostname: () => "Locals-MacBook-Pro.local", homedir: () => targetHome.value }));
vi.mock("../scripts/soak-runtime.mjs", async original => ({ ...await original<any>(),
  startSoakRuntime: vi.fn(() => { throw new Error("app launch must not be reached"); }) }));

it("startTarget checks the real target registry before starting the app or private daemon", async () => {
  const home = mkdtempSync(join(tmpdir(), "xmac-root-test-")); targetHome.value = home;
  try {
    const dir = join(home, ".config/ralphtools"); mkdirSync(dir, { recursive: true });
    const path = join(home, "missing repo");
    writeFileSync(join(dir, "launchers.zsh"), `repoGolem fixture '${path}'\n`);
    const { startTarget } = await import("../scripts/xmac/target-client.mjs");
    const { startSoakRuntime } = await import("../scripts/soak-runtime.mjs");
    await expect(startTarget({ host: "m1", cmux: "prod", dmg: "/pinned", repo: "fixture", launcherClis: ["codex"] }, { launcherRegistry: registry })).rejects.toMatchObject({
      precondition: { status: "PRECONDITION_ABSENT", missing: [{ cli: "codex", launcher: "fixtureCodex", path }] },
    });
    expect(startSoakRuntime).not.toHaveBeenCalled();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("missing roots remain explicit non-green rows and cannot prove a historical defect", () => {
  const precondition = { status: "PRECONDITION_ABSENT", kind: "launcher_root", missing: [{ path: "/synthetic/missing" }] };
  const error = Object.assign(new Error("missing /synthetic/missing"), { precondition });
  const [row] = launchFailureRows([{ id: "stray_newline" }], { host: "m1", cmux: "prod" }, "a".repeat(40), "bug", "receipt.json", error);
  expect(row).toMatchObject({ status: "PRECONDITION_ABSENT", failure_kind: "infrastructure", expected_defect: false, precondition });
  expect(ratchetProof(row, { ...row, status: "PASS", cmuxlayer_sha: "b".repeat(40) })).toBe("UNPROVEN");
  expect(launchFailureRows([{ id: "stray_newline" }], { host: "m1", cmux: "prod" }, "a".repeat(40), "bug", "receipt.json", new Error("transport failed"))[0].status).toBe("FAIL");
  expect(scenarioLaunchers({ id: "stray_newline" })).toEqual(["codex"]);
  expect(scenarioLaunchers({ id: "resume_focus" })).toEqual(["codex"]);
  expect(scenarioLaunchers({ id: "send_idle_claude_deadlock" })).toEqual(["claude"]);
  expect(scenarioLaunchers({ id: "lead_spawn_role_worker" })).toEqual(["claude", "codex"]);
  expect(() => scenarioLaunchers({ id: "unknown" })).toThrow("declare");
});

it("missing registered root fails promptly with exact target path, before app launch", async () => {
  const home = mkdtempSync(join(tmpdir(), "xmac-root-test-"));
  try {
    const sourcePath = join(home, "launchers.zsh"), path = join(home, "missing repo");
    writeFileSync(sourcePath, `repoGolem fixture '${path}'\n`);
    const launch = vi.fn(), started = performance.now();
    let caught: any;
    try { await checkLauncherRoots("fixture", ["codex"], { sourcePath, registry }); launch(); }
    catch (error) { caught = error; }
    expect(caught?.precondition).toMatchObject({ status: "PRECONDITION_ABSENT", missing: [{ cli: "codex", launcher: "fixtureCodex", path }] });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(launch).not.toHaveBeenCalled();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("existing registry roots pass read-only and non-directory roots fail", async () => {
  const home = mkdtempSync(join(tmpdir(), "xmac-root-test-"));
  try {
    const sourcePath = join(home, "launchers.zsh"), path = join(home, "repo");
    writeFileSync(sourcePath, `repoGolem fixture '${path}'\n`); mkdirSync(path);
    expect(await checkLauncherRoots("fixture", ["codex", "claude"], { sourcePath, registry })).toMatchObject({ status: "PASS", launchers: [
      { cli: "codex", launcher: "fixtureCodex", path }, { cli: "claude", launcher: "fixtureClaude", path },
    ] });
    rmSync(path, { recursive: true }); writeFileSync(path, "synthetic");
    await expect(checkLauncherRoots("fixture", ["codex"], { sourcePath, registry })).rejects.toThrow("PRECONDITION_ABSENT");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
