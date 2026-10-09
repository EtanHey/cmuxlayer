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
    writeFileSync(join(root, "dist/index.js"), "");
    writeFileSync(join(root, "dist/daemon.js"), "");
    const sha = "a".repeat(40);
    writeFileSync(join(root, "xmac-build.json"), JSON.stringify({ sha }));
    expect(privateBuild(root, sha).entry).toBe(join(realpathSync(root), "dist/index.js"));
    expect(() => privateBuild(root, "b".repeat(40))).toThrow("SHA");
    expect(() => privateBuild("/opt/homebrew/opt/cmuxlayer", sha)).toThrow("private replay");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("compiled reference digest changes when a module changes and refuses empty trees", async () => {
  const { distDigest } = await import("../scripts/xmac/target.mjs");
  const root = mkdtempSync(join(tmpdir(), "xmac-digest-test-"));
  try {
    expect(() => distDigest(root)).toThrow("empty");
    writeFileSync(join(root, "entry.js"), "export const x = 1;");
    const before = distDigest(root);
    writeFileSync(join(root, "entry.js"), "export const x = 2;");
    expect(distDigest(root)).not.toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps app pointer HOME private while the M1 CLI auth environment stays real", async () => {
  const { appLaunchEnvironment, targetEnvironment } = await import("../scripts/soak-runtime.mjs");
  const opts = { target: "m1-gate", app: "/Applications/cmux.app", privateAppHome: true };
  const env = targetEnvironment({}, "/private/run", opts, "/target/auth-home");
  const app = appLaunchEnvironment(env, opts, "/private/run", opts.app, env.CMUX_SOCKET_PATH);
  expect(app.HOME).toBe("/private/run/home");
  expect(env.HOME).toBe("/target/auth-home");
  expect(app.CMUXLAYER_DAEMON_SOCKET).toBe(env.CMUXLAYER_DAEMON_SOCKET);
  expect(app.ZDOTDIR).toBe("/private/run/zdot");
});

it("direct socket screens preserve UTF-8 split across packets and every blank/composer row", async () => {
  const net = await import("node:net");
  const { rpc } = await import("../scripts/soak-runtime.mjs");
  const root = mkdtempSync(join(tmpdir(), "xmac-socket-test-")), path = join(root, "s.sock");
  const text = "header\n\n› שלום\n";
  const server = net.createServer(socket => socket.once("data", () => {
    const bytes = Buffer.from(JSON.stringify({ result: { text } }) + "\n"), split = bytes.indexOf(Buffer.from("שלום")) + 1;
    socket.write(bytes.subarray(0, split));
    setTimeout(() => socket.end(bytes.subarray(split)), 20);
  }));
  await new Promise<void>(resolve => server.listen(path, resolve));
  try { expect((await rpc(path, "surface.read_text", { surface_id: "synthetic" })).text).toBe(text); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

it("M1 gate needs an observed matching repoGolem launch, never a registry-less raw fallback", async () => {
  const { requireLauncherMode } = await import("../scripts/xmac/target.mjs");
  expect(() => requireLauncherMode({ launch_mode: "raw", launcher_name: null }, "fixtureCodex")).toThrow("launcher gate mismatch");
  expect(() => requireLauncherMode({ launch_mode: "launcher", launcher_name: "otherCodex" }, "fixtureCodex")).toThrow("launcher gate mismatch");
  expect(() => requireLauncherMode({ launch_mode: "launcher", launcher_name: "fixtureCodex" }, "fixtureCodex")).not.toThrow();
});
