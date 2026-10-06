import { expect, it } from "vitest";
import { targetOptions, privateBuild, launcherEnvironment } from "../scripts/xmac/target.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("rejects MBP production before transport or build preparation", () => {
  expect(() => targetOptions({ host: "mbp", cmux: "prod" })).toThrow("MBP");
  expect(() => targetOptions({ host: "unknown", cmux: "nightly" })).toThrow("host");
  expect(() => targetOptions({ host: "mbp", cmux: "nightly" })).toThrow("private-home");
  expect(targetOptions({ host: "m1", cmux: "prod", dmg: "/fixture/pinned.dmg", repo: "cmuxlayer" })).toMatchObject({ target: "m1-gate", gateHost: "Locals-MacBook-Pro.local", app: "/Applications/cmux.app" });
});
it("uses target-host registry and PATH, retains private daemon and inbox", () => {
  const env = launcherEnvironment({ HOME: "/target/home", CMUXLAYER_STATE_DIR: "/private/state", CMUXLAYER_INBOX_BASE_DIR: "/private/inbox", CMUXLAYER_DAEMON_SOCKET: "/private/d.sock", PATH: "/bundle/bin:/usr/bin" }, "m1-gate");
  expect(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH).toBe("/target/home/.config/ralphtools/launchers.zsh");
  expect(env.CMUXLAYER_DAEMON_SOCKET).toBe("/private/d.sock");
  expect(env.CMUXLAYER_INBOX_BASE_DIR).toBe("/private/inbox");
  expect(env.PATH).toContain("/target/home/.local/bin");
});
it("private replay roots must be owned real directories with an exact immutable SHA marker", () => {
  const root = mkdtempSync(join(tmpdir(), "cmux-xmac-replay-"));
  try {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/entry.js"), "");
    writeFileSync(join(root, "dist/daemon.js"), "");
    const sha = "a".repeat(40);
    writeFileSync(join(root, "xmac-build.json"), JSON.stringify({ sha }));
    expect(privateBuild(root, sha).entry).toBe(join(realpathSync(root), "dist/entry.js"));
    expect(() => privateBuild(root, "b".repeat(40))).toThrow("SHA");
    expect(() => privateBuild("/opt/homebrew/opt/cmuxlayer", sha)).toThrow("private replay");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
