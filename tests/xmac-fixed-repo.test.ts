import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScenarioRepo } from "../scripts/xmac/scenario-repo.mjs";
import { acquireNightlyLock, releaseNightlyLock } from "../scripts/soak-runtime.mjs";

function fixture(test: (f: any) => void) {
  const root = mkdtempSync(join(tmpdir(), "xmac-fixed-repo-")), home = join(root, "home"), scratch = join(root, "scratch"), lock = join(root, "harness.lock");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
  const path = join(realpathSync(home), ".cache/cmuxlayer-xmac/repo");
  const create = (token = "first") => createScenarioRepo({ HOME: home }, { target: "m1-gate" }, scratch, token, lock);
  try { test({ root, home, scratch, lock, path, create }); } finally { rmSync(root, { recursive: true, force: true }); }
}
it("recreates the same private fixed repo empty per run while the actual harness lock excludes another run", () => fixture(({ path, lock, create, scratch }) => {
  mkdirSync(path, { recursive: true, mode: 0o700 }); writeFileSync(join(path, "stale"), "old run");
  writeFileSync(join(scratch, "sentinel"), "retain"); acquireNightlyLock(lock, "first");
  expect(() => acquireNightlyLock(lock, "second")).toThrow();
  const first = create(); expect(first.path).toBe(path); expect(existsSync(join(path, "stale"))).toBe(false);
  expect(statSync(path).mode & 0o777).toBe(0o700); writeFileSync(join(path, "current"), "first");
  first.close(); expect(existsSync(path)).toBe(false); releaseNightlyLock(lock, "first");
  acquireNightlyLock(lock, "second"); const second = create("second");
  expect(second.path).toBe(path); expect(existsSync(join(path, "current"))).toBe(false); second.close(); releaseNightlyLock(lock, "second");
  expect(readFileSync(join(scratch, "sentinel"), "utf8")).toBe("retain");
}));
it("refuses absent or foreign lock ownership before touching a leftover fixed repo", () => fixture(({ path, lock, create }) => {
  mkdirSync(path, { recursive: true, mode: 0o700 }); writeFileSync(join(path, "sentinel"), "retain");
  expect(() => create()).toThrow(); acquireNightlyLock(lock, "foreign"); expect(() => create()).toThrow("lock");
  expect(readFileSync(join(path, "sentinel"), "utf8")).toBe("retain");
}));
it("retains a live repo if the lock token changes before teardown", () => fixture(({ path, lock, create }) => {
  acquireNightlyLock(lock, "first"); const run = create(); writeFileSync(join(run.path, "sentinel"), "retain");
  writeFileSync(lock, "foreign"); expect(() => run.close()).toThrow("lock");
  expect(readFileSync(join(path, "sentinel"), "utf8")).toBe("retain");
}));
it("refuses a replaced lock inode even when its token is unchanged", () => fixture(({ path, lock, create }) => {
  acquireNightlyLock(lock, "first"); const run = create(); renameSync(lock, lock + ".saved"); acquireNightlyLock(lock, "first");
  expect(() => run.close()).toThrow("lock"); expect(existsSync(path)).toBe(true);
}));
it("refuses a symlink at the fixed repo without removing foreign files", () => fixture(({ path, scratch, lock, create }) => {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(join(scratch, "sentinel"), "retain"); symlinkSync(scratch, path);
  acquireNightlyLock(lock, "first"); expect(() => create()).toThrow("unsafe");
  expect(readFileSync(join(scratch, "sentinel"), "utf8")).toBe("retain");
}));
it("keeps NIGHTLY scenario repos in private scratch without requiring the M1 fixed-path lock", () => fixture(({ home, scratch }) => {
  const run = createScenarioRepo({ HOME: home }, { target: "nightly" }, scratch, "nightly");
  expect(run.path).toBe(join(scratch, "repo")); run.close(); expect(existsSync(run.path)).toBe(true);
}));
