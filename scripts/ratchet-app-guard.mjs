import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";

const productionId = "com.cmuxterm.app", nightlyId = productionId + ".nightly";
const plist = (app, key) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();
export function processBundleId(executable) {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(realpathSync(executable));
  if (!match) throw new Error("app executable is outside an app bundle");
  return plist(match[1], "CFBundleIdentifier");
}
export function assertAppTarget(app, { hostedRelease = false, capability = false, env = process.env } = {}) {
  const resolved = realpathSync(app), executable = join(resolved, "Contents/MacOS/cmux");
  const bundleId = plist(resolved, "CFBundleIdentifier"), targetId = processBundleId(executable);
  // This exception is capability-only on an ephemeral GitHub-hosted Mac, never a local version switch.
  const hosted = hostedRelease && capability && env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted" && env.RUNNER_OS === "macOS" && env.RUNNER_TEMP && resolved.startsWith(realpathSync(env.RUNNER_TEMP) + sep);
  if ((bundleId === productionId || targetId === productionId) && !hosted) throw new Error("production bundle refused: local ratchet is NIGHTLY only");
  if (hostedRelease && !hosted) throw new Error("hosted release requires GitHub-hosted capability mode and a scratch app");
  const expected = hostedRelease ? productionId : nightlyId;
  if (bundleId !== expected || targetId !== expected) throw new Error("app/target bundle identity mismatch");
  if (hostedRelease && plist(resolved, "CFBundleShortVersionString") !== "0.64.22") throw new Error("hosted release version mismatch");
  return { bundleId, executable, hostedRelease };
}
export function assertProcessTarget(executable, hostedRelease = false) {
  const id = processBundleId(executable);
  if (id === productionId && !hostedRelease) throw new Error("production process target refused");
  if (id !== (hostedRelease ? productionId : nightlyId)) throw new Error("process target bundle identity mismatch");
}
