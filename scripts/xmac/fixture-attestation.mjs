import * as nativeFs from "node:fs";
import { lstatSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const fileDigest = (path, io = {}) => io.digest ? io.digest(path) : createHash("sha256").update((io.fs ?? nativeFs).readFileSync(path)).digest("hex");
function file(path, privateFile = false, io = {}) {
  const { lstatSync, realpathSync } = io.fs ?? nativeFs;
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== (io.uid ?? process.getuid)() ||
      stat.mode & (privateFile ? 0o077 : 0o022)) throw new Error("fixture file identity changed");
  return { path, sha256: fileDigest(path, io), dev: stat.dev, ino: stat.ino };
}
export function sealFixtureInstall(receipt, env, helper, io = {}) {
  const { realpathSync } = io.fs ?? nativeFs;
  receipt.attestation = {
    files: { node: file(realpathSync(io.node ?? process.execPath), false, io), tui: file(realpathSync(receipt.tui), false, io), helper: file(realpathSync(helper), false, io),
      registry: file(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH, true, io) },
    path: env.PATH, registry: env.CMUXLAYER_LAUNCHER_REGISTRY_PATH,
  };
  return receipt;
}
export function attestFixtureInstall(receipt, env, io = {}) {
  const { lstatSync, realpathSync, existsSync } = io.fs ?? nativeFs;
  if (!receipt?.attestation || realpathSync(receipt.root) !== receipt.root) throw new Error("fixture attestation missing");
  const root = lstatSync(receipt.root);
  if (!root.isDirectory() || root.uid !== (io.uid ?? process.getuid)() || root.mode & 0o077) throw new Error("fixture root identity changed");
  const { files } = receipt.attestation;
  if (files.tui.path !== realpathSync(receipt.tui) || files.node.path !== realpathSync(io.node ?? process.execPath) ||
      files.registry.path !== join(receipt.root, "fixture-launchers.zsh")) throw new Error("fixture registry/module identity changed");
  for (const [name, expected] of Object.entries(files)) {
    const observed = file(expected.path, name === "registry", io);
    if (Object.keys(observed).some(key => observed[key] !== expected[key])) throw new Error(`fixture ${name} identity changed`);
  }
  if (env && (env.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY !== "1" || env.CMUXLAYER_LAUNCHER_REGISTRY_PATH !== files.registry.path ||
      env.PATH !== receipt.attestation.path || env.CMUX_CUSTOM_CODEX_PATH !== receipt.binaries.codex ||
      env.CMUX_CUSTOM_CLAUDE_PATH !== receipt.binaries.claude)) throw new Error("fixture registry enforcement/routing changed");
  if (existsSync(join(receipt.root, "model-trap.log"))) throw new Error("raw model fallback trap hit");
}

export function attestFixtureProcess(receipt, binding, env, observe = pid => {
  const read = field => execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", `${field}=`],
    { encoding: "utf8", timeout: 3000, env: { ...process.env, LC_ALL: "C" } }).trim();
  return { pid, start: read("lstart"), executable: read("comm"), argv: read("args") };
}) {
  attestFixtureInstall(receipt, env);
  file(receipt.events, true);
  const event = JSON.parse(readFileSync(receipt.events, "utf8"));
  const { files } = receipt.attestation;
  if (!Number.isSafeInteger(event.pid) || event.pid <= 1 || binding.pid && binding.pid !== event.pid ||
      event.row !== receipt.row || event.surface !== binding.surface || event.workspace !== binding.workspace ||
      !/^[a-f0-9-]{36}$/i.test(binding.surface ?? "") || !/^[a-f0-9-]{36}$/i.test(binding.workspace ?? "") ||
      event.argv?.length !== 4 || realpathSync(event.argv[0]) !== files.node.path || event.argv[1] !== files.tui.path ||
      event.argv[2] !== receipt.row || event.argv[3] !== receipt.events) throw new Error("fixture event/process binding changed");
  const current = observe(event.pid);
  if (current.pid !== event.pid || !current.start || binding.start && current.start !== binding.start ||
      realpathSync(current.executable) !== files.node.path || current.argv !== event.argv.join(" ")) throw new Error("fixture PID/start/argv identity changed");
  return { ...current, surface: event.surface, workspace: event.workspace };
}
