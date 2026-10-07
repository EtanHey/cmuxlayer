import { userInfo } from "node:os";
import { realpathSync, lstatSync } from "node:fs";
import { productionSnapshot } from "./production-guard.mjs";

export function bindAccountHome({ info = userInfo, realpath = realpathSync, stat = lstatSync } = {}) {
  const account = info(), home = realpath(account.homedir), observed = stat(home);
  if (!home.startsWith("/") || !observed.isDirectory() || observed.isSymbolicLink() ||
      account.uid !== process.getuid() || observed.uid !== account.uid) throw new Error("account HOME identity invalid");
  return { home, uid: account.uid, dev: observed.dev, ino: observed.ino, source: "os.userInfo" };
}
export function accountProductionSnapshot(binding, deps) {
  const current = bindAccountHome(deps);
  if (!binding || Object.keys(current).some(key => current[key] !== binding[key])) throw new Error("account HOME identity changed");
  return { ...productionSnapshot(binding.home), account_home: { ...binding } };
}
