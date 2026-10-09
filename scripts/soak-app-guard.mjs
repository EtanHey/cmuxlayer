import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

const productionId = "com.cmuxterm.app", nightlyId = productionId + ".nightly";
const plist = (app, key) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();
export function processBundleId(executable, { realpath = realpathSync, readPlist = plist } = {}) {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(realpath(executable));
  if (!match) throw new Error("app executable is outside an app bundle");
  return readPlist(match[1], "CFBundleIdentifier");
}
export function assertAppTarget(app, { target = "nightly", gateHost = "", hostname = "", socketPath = "/tmp/cmux-nightly.sock",
  realpath = realpathSync, readPlist = plist } = {}) {
  if (!["nightly", "m1-gate"].includes(target)) throw new Error("unknown soak target");
  if (target === "m1-gate" && (!gateHost || gateHost !== hostname || hostname === "MacBook-Pro.local")) {
    throw new Error("stable soak requires the lead-designated dedicated M1 host");
  }
  const expectedSocket = target === "nightly" ? "/tmp/cmux-nightly.sock" : "/tmp/cmux-soak-stable.sock";
  if (socketPath !== expectedSocket) throw new Error("production or alternate socket refused");
  const resolved = realpath(app), executable = join(resolved, "Contents/MacOS/cmux");
  const bundleId = readPlist(resolved, "CFBundleIdentifier"), targetId = processBundleId(executable, { realpath, readPlist });
  const expected = target === "m1-gate" ? productionId : nightlyId;
  if (bundleId !== expected || targetId !== expected) throw new Error("production bundle or app/target identity mismatch");
  const version = readPlist(resolved, "CFBundleShortVersionString");
  if (target === "m1-gate" && version !== "0.64.22") throw new Error("M1 gate requires pinned cmux 0.64.22");
  return { bundleId, executable, version, target };
}
export function assertProcessTarget(executable, target = "nightly") {
  if (processBundleId(executable) !== (target === "m1-gate" ? productionId : nightlyId)) throw new Error("process target identity mismatch");
}
