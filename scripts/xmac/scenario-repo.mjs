import { join } from "node:path";
import { mkdirSync, lstatSync, realpathSync, rmSync } from "node:fs";

function directory(path, privateMode = false) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || privateMode && stat.mode & 0o077) throw new Error("unsafe scenario repo parent");
  return stat;
}
export function createScenarioRepo(env, opts, scratch, token) {
  if (opts.target !== "m1-gate") {
    const path = join(scratch, "repo"); mkdirSync(path, { mode: 0o700 });
    return { path, close() {} };
  }
  if (!/^[A-Za-z0-9-]+$/u.test(token)) throw new Error("invalid scenario run id");
  const cache = join(realpathSync(env.HOME), ".cache"), base = join(cache, "cmuxlayer-xmac");
  for (const path of [cache, base]) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    directory(path, path === base);
  }
  const run_dir = join(base, token), path = join(run_dir, "repo");
  mkdirSync(run_dir, { mode: 0o700 }); const saved = directory(run_dir, true);
  const close = () => {
    directory(cache); directory(base, true);
    let current; try { current = directory(run_dir, true); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (current.dev !== saved.dev || current.ino !== saved.ino) throw new Error("scenario run directory identity changed");
    rmSync(run_dir, { recursive: true });
  };
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { close(); throw error; }
  return { path, run_dir, close };
}
