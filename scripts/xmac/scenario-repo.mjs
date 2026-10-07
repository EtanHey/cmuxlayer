import { join } from "node:path";
import { mkdirSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";

function directory(path, privateMode = false) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || privateMode && stat.mode & 0o077) throw new Error("unsafe scenario repo parent");
  return stat;
}
export function createScenarioRepo(env, opts, scratch, token, lockPath) {
  if (opts.target !== "m1-gate") {
    const path = join(scratch, "repo"); mkdirSync(path, { mode: 0o700 });
    return { path, close() {} };
  }
  if (!/^[A-Za-z0-9-]+$/u.test(token)) throw new Error("invalid scenario run id");
  if (!lockPath) throw new Error("scenario repo requires harness lock");
  let savedLock;
  const assertLock = () => {
    const stat = lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 ||
        readFileSync(lockPath, "utf8") !== token || savedLock && (stat.dev !== savedLock.dev || stat.ino !== savedLock.ino)) {
      throw new Error("scenario harness lock ownership changed");
    }
    return stat;
  };
  savedLock = assertLock();
  const cache = join(realpathSync(env.HOME), ".cache"), base = join(cache, "cmuxlayer-xmac");
  for (const path of [cache, base]) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    directory(path, path === base);
  }
  const path = join(base, "repo"), run_dir = path;
  // This reserved harness path has one owner at a time. Recreate it empty for
  // each sample, without changing the owner's exact-path Codex trust entry.
  let previous;
  try { previous = directory(path, true); } catch (error) { if (error.code !== "ENOENT") throw error; }
  assertLock();
  if (previous) rmSync(path, { recursive: true });
  mkdirSync(path, { mode: 0o700 }); const saved = directory(path, true);
  const close = () => {
    assertLock();
    directory(cache); directory(base, true);
    let current; try { current = directory(run_dir, true); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (current.dev !== saved.dev || current.ino !== saved.ino) throw new Error("scenario run directory identity changed");
    rmSync(run_dir, { recursive: true });
  };
  return { path, run_dir, close };
}
