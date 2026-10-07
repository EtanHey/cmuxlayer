import { realpathSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function targetOptions(opts) {
  if (!["m1", "mbp"].includes(opts.host)) throw new Error("host must be m1 or mbp");
  if (!["prod", "nightly"].includes(opts.cmux)) throw new Error("cmux must be prod or nightly");
  if (opts.host === "mbp" && opts.cmux === "prod") throw new Error("MBP production launches are forbidden");
  if (opts.cmux === "nightly" && !opts.privateHome) throw new Error("NIGHTLY requires --private-home");
  if (opts.cmux === "prod" && !opts.dmg) throw new Error("M1 requires pinned DMG provenance");
  if (opts.cmux === "prod" && !opts.repo) throw new Error("M1 requires a registered repoGolem repo");
  return { ...opts, target: opts.cmux === "prod" ? "m1-gate" : "nightly",
    gateHost: "Locals-MacBook-Pro.local", app: opts.cmux === "prod" ? "/Applications/cmux.app" : "/Applications/cmux NIGHTLY.app" };
}
export function privateBuild(root, sha) {
  if (!/^cmux-xmac-replay-[A-Za-z0-9-]+$/.test(basename(root))) throw new Error("not a private replay prefix");
  const real = realpathSync(root), stat = statSync(real);
  if (!real.startsWith(realpathSync(tmpdir()) + "/") || stat.uid !== process.getuid() || stat.mode & 0o077 || !stat.isDirectory()) throw new Error("unsafe private replay prefix");
  const marker = JSON.parse(readFileSync(join(real, "xmac-build.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(sha) || marker.sha !== sha) throw new Error("private replay SHA mismatch");
  const entry = join(real, "dist/entry.js"), daemon = join(real, "dist/daemon.js");
  for (const path of [entry, daemon]) if (!realpathSync(path).startsWith(real + "/")) throw new Error("private replay executable escapes prefix");
  return { root: real, entry, daemon, sha };
}
export function launcherEnvironment(env, target) {
  return { ...env, PATH: `${env.PATH}:${env.HOME}/.local/bin:/opt/homebrew/bin`,
    ...(target === "m1-gate" ? { CMUXLAYER_LAUNCHER_REGISTRY_PATH: join(env.HOME, ".config/ralphtools/launchers.zsh") } : {}) };
}

// The expected digest must come from the exact SHA's compiled reference build.
export function distDigest(root) {
  const hash = createHash("sha256"); let count = 0;
  const walk = relative => {
    for (const item of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, item.name);
      if (item.isSymbolicLink()) throw new Error("dist symlink refused");
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && item.name.endsWith(".js")) { hash.update(path + "\0"); hash.update(readFileSync(join(root, path))); count++; }
    }
  };
  walk(""); if (!count) throw new Error("compiled reference dist is empty");
  return hash.digest("hex");
}
