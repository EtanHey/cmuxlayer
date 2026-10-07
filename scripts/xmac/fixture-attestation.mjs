import { lstatSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const fileDigest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function file(path, privateFile = false) {
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() ||
      stat.mode & (privateFile ? 0o077 : 0o022)) throw new Error("fixture file identity changed");
  return { path, sha256: fileDigest(path), dev: stat.dev, ino: stat.ino };
}
export function sealFixtureInstall(receipt, env, helper) {
  receipt.attestation = {
    files: { node: file(realpathSync(process.execPath)), tui: file(realpathSync(receipt.tui)), helper: file(realpathSync(helper)),
      registry: file(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH, true) },
    path: env.PATH, registry: env.CMUXLAYER_LAUNCHER_REGISTRY_PATH,
  };
  return receipt;
}
export function attestFixtureInstall(receipt, env) {
  if (!receipt?.attestation || realpathSync(receipt.root) !== receipt.root) throw new Error("fixture attestation missing");
  const root = lstatSync(receipt.root);
  if (!root.isDirectory() || root.uid !== process.getuid() || root.mode & 0o077) throw new Error("fixture root identity changed");
  const { files } = receipt.attestation;
  if (files.tui.path !== realpathSync(receipt.tui) || files.node.path !== realpathSync(process.execPath) ||
      files.registry.path !== join(receipt.root, "fixture-launchers.zsh")) throw new Error("fixture registry/module identity changed");
  for (const [name, expected] of Object.entries(files)) {
    const observed = file(expected.path, name === "registry");
    if (Object.keys(observed).some(key => observed[key] !== expected[key])) throw new Error(`fixture ${name} identity changed`);
  }
  if (env && (env.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY !== "1" || env.CMUXLAYER_LAUNCHER_REGISTRY_PATH !== files.registry.path ||
      env.PATH !== receipt.attestation.path || env.CMUX_CUSTOM_CODEX_PATH !== receipt.binaries.codex ||
      env.CMUX_CUSTOM_CLAUDE_PATH !== receipt.binaries.claude)) throw new Error("fixture registry enforcement/routing changed");
  if (existsSync(join(receipt.root, "model-trap.log"))) throw new Error("raw model fallback trap hit");
}
