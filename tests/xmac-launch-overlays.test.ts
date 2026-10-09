import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, statSync, existsSync, rmSync, symlinkSync, realpathSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyLaunchOverlay, guardLaunch } from "../scripts/xmac/launch-overlay.mjs";
import { createScenarioRepo } from "../scripts/xmac/scenario-repo.mjs";
import { runScenarios } from "../scripts/xmac/runner.mjs";
const trust = "Codex\n\n› 1. Trust and continue\n  2. Quit\n\nenter continue · esc quit\n";
const update = "› 1. Update now (runs brew upgrade --cask codex)\n  2. Skip\n  3. Skip until next version\n";
it("recognizes real trust/update and generic numbered launch pickers without treating normal prose as an overlay", () => {
  expect(classifyLaunchOverlay(trust)).toMatchObject({ status: "PRECONDITION_ABSENT", kind: "launch_overlay", overlay: "trust", first_lines: expect.arrayContaining(["› 1. Trust and continue"]) });
  expect(classifyLaunchOverlay(update)?.overlay).toBe("update");
  expect(classifyLaunchOverlay("› 1. First\n  2. Second")?.overlay).toBe("numbered_picker");
  expect(classifyLaunchOverlay("1. First\n2. Second\n› Ask Codex to do anything")).toBeNull();
});
it("fails launch immediately on an independent raw overlay frame even when spawn readiness is still pending", async () => {
  const start = vi.fn(() => new Promise(() => {})), frames = vi.fn(async () => [{ surface: "owned-new-seat", text: trust }]);
  await expect(guardLaunch(start, { frames })).rejects.toMatchObject({ precondition: { kind: "launch_overlay", surface: "owned-new-seat", overlay: "trust" } });
  expect(start).toHaveBeenCalledOnce(); expect(frames).toHaveBeenCalledOnce();
});
it("puts M1 scenario repo below the authenticated home with mode0700 and removes only its recorded run directory", () => {
  const home = mkdtempSync(join(tmpdir(), "xmac-home-test-")), scratch = mkdtempSync(join(tmpdir(), "xmac-scratch-test-"));
  try {
    const lock = join(scratch, "harness.lock"); writeFileSync(lock, "fixture-run", { mode: 0o600, flag: "wx" });
    const run = createScenarioRepo({ HOME: home }, { target: "m1-gate" }, scratch, "fixture-run", lock);
    expect(run.path).toBe(join(realpathSync(home), ".cache/cmuxlayer-xmac/repo"));
    expect(statSync(run.path).mode & 0o777).toBe(0o700); run.close();
    expect(existsSync(run.run_dir)).toBe(false); expect(existsSync(scratch)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});
it("checks a raw frame even if the product reports ready before the screen RPC completes", async () => {
  await expect(guardLaunch(async () => ({ ok: true }), { frames: async () => {
    await new Promise(resolve => setTimeout(resolve, 10)); return [{ surface: "new", text: update }];
  } })).rejects.toMatchObject({ precondition: { kind: "launch_overlay", overlay: "update" } });
});
it("refuses symlink parents and a replaced run directory without deleting unrelated data", () => {
  const home = mkdtempSync(join(tmpdir(), "xmac-home-test-")), foreign = mkdtempSync(join(tmpdir(), "xmac-foreign-test-"));
  try {
    const lock = join(foreign, "harness.lock"); writeFileSync(lock, "fixture-run", { mode: 0o600, flag: "wx" });
    writeFileSync(join(foreign, "sentinel"), "retain"); symlinkSync(foreign, join(home, ".cache"));
    expect(() => createScenarioRepo({ HOME: home }, { target: "m1-gate" }, foreign, "fixture-run", lock)).toThrow("unsafe");
    rmSync(join(home, ".cache"));
    const run = createScenarioRepo({ HOME: home }, { target: "m1-gate" }, foreign, "fixture-run", lock);
    renameSync(run.run_dir, run.run_dir + "-original"); mkdirSync(run.run_dir, { mode: 0o700 });
    expect(() => run.close()).toThrow("identity changed");
    expect(readFileSync(join(foreign, "sentinel"), "utf8")).toBe("retain"); expect(existsSync(run.run_dir)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }); }
});
it("preserves structured overlay failure through a scenario catch and stops before the next scenario", async () => {
  const root = mkdtempSync(join(tmpdir(), "xmac-overlay-runner-")), precondition = { status: "PRECONDITION_ABSENT", kind: "launch_overlay", overlay: "trust", first_lines: ["› 1. Trust and continue", "2. Quit"] };
  const d = { target: { host: "m1", cmux: "prod-0.64.22", cmuxVersion: "0.64.22", cmuxlayerSha: "a".repeat(40) }, call: vi.fn(async () => { throw Object.assign(new Error("launch overlay"), { precondition }); }), sweepChildren: async () => ({}), close: vi.fn(async () => ({ status: "PASS" })) };
  const next = vi.fn(), scenario = { id: "overlay", targets: ["m1:prod-0.64.22"], bug: { sha: "bug" }, async run(ctx: any) { try { await ctx.spawn({ cli: "codex" }); } catch (error: any) { return { status: "FAIL", notes: [error.message], evidence: {} }; } } };
  try {
    const result = await runScenarios({ scenarios: [scenario, { ...scenario, id: "next", run: next }], driver: d, evidenceDir: root, parseScreen: () => ({}) });
    expect(result.rows[0]).toMatchObject({ status: "PRECONDITION_ABSENT", precondition, failure_kind: "infrastructure", expected_defect: false });
    expect(next).not.toHaveBeenCalled(); expect(d.close).toHaveBeenCalledOnce(); expect(result.rows[0].notes.join(" ")).not.toContain("independent receipt/screen evidence missing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("stops bug-to-fix replay before the fix and remaining cases after a launch overlay", async () => {
  const { replaySamples } = await import("../scripts/xmac/live.mjs");
  const absent = { status: "PRECONDITION_ABSENT", precondition: { kind: "launch_overlay" }, failure_kind: "infrastructure", expected_defect: false };
  const sample = vi.fn(async () => ({ rows: [absent] }));
  const cases = [{ id: "first", bug: { sha: "bug" }, fix: { sha: "fix" } }, { id: "next", bug: { sha: "other-bug" }, fix: { sha: "other-fix" } }];
  const rows = await replaySamples(cases, sample);
  expect(sample).toHaveBeenCalledOnce(); expect(sample).toHaveBeenCalledWith([cases[0]], "bug", "bug", true);
  expect(rows).toMatchObject([{ status: "UNPROVEN", candidate: "not run: launch_overlay" }]);
});
it("keeps ordinary launch results/errors and safely consumes a late spawn rejection after an overlay", async () => {
  expect(await guardLaunch(async () => ({ ok: true }), { frames: async () => [], sleep: async () => {} })).toEqual({ ok: true });
  await expect(guardLaunch(async () => { throw new Error("spawn rejected"); }, { frames: async () => [], sleep: async () => {} })).rejects.toThrow("spawn rejected");
  let reject!: (error: Error) => void;
  const pending = new Promise((_, no) => { reject = no; });
  await expect(guardLaunch(() => pending, { frames: async () => [{ surface: "new", text: trust }] })).rejects.toMatchObject({ precondition: { overlay: "trust" } });
  reject(new Error("private client closed")); await Promise.resolve();
});
