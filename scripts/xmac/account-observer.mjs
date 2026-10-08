// Read-only collector runs as happycampr; receipts contain hashes, never private contents.
import { userInfo, hostname } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { readStatePaths, stateRoots, fixtureMarkers } from "./dedicated-account.mjs";
import { productionSnapshot, productionChanges } from "./production-guard.mjs";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const validObservationScope = values => Array.isArray(values) && values.length <= 1024 &&
  values.every(value => typeof value === "string" && value.length > 0 && value.length <= 4096) && new Set(values).size === values.length;
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }).trim();
export function validateObserverReceipt(row, request, now = Date.now()) {
  const id = row?.identity;
  if (!row || row.error || !same([row.run, row.nonce, row.sequence, row.phase], [request.run, request.nonce, request.sequence, request.phase]) ||
      [row.identifiers, row.agentIds, request.identifiers, request.agentIds].some(values => !validObservationScope(values)) ||
      !same(row.identifiers, request.identifiers) || !same(row.agentIds, request.agentIds) ||
      !Number.isFinite(row.capturedAt) || now - row.capturedAt < 0 || now - row.capturedAt > 10000 ||
      id?.username !== "happycampr" || id.uid !== 501 || id.processUid !== 501 || id.home !== "/Users/happycampr" ||
      id.source !== "os.userInfo+dscl" || id.host !== "Locals-MacBook-Pro.local" ||
      !same(row.roots, stateRoots(id.home)) || !row.production || !Array.isArray(row.processes) || !row.mirror ||
      !Array.isArray(row.append?.reads) || !Array.isArray(row.append?.violations) || Buffer.byteLength(JSON.stringify(row)) > 1024 * 1024 ||
      Object.keys(row.production).length > 4096 || Object.entries(row.production).some(([path, record]) =>
        !row.roots.some(root => path === root || path.startsWith(root + "/")) || !record ||
        Object.keys(record).some(key => !["kind", "uid", "mode", "dev", "ino", "nlink", "size", "hash"].includes(key)) ||
        !["file", "directory", "socket"].includes(record.kind) || ["uid", "mode", "dev", "ino"].some(key => !Number.isInteger(record[key])) ||
        record.kind === "file" && (record.nlink !== 1 || !Number.isInteger(record.size) || record.size < 0 || record.size > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(record.hash)))) throw new Error("protected observer receipt invalid, stale, foreign or unreachable");
  return row;
}
function protectedIdentity() {
  const info = userInfo(), home = info.homedir;
  const api = run("/usr/bin/dscl", ["/Search", "-read", "/Users/happycampr", "UniqueID", "NFSHomeDirectory"]);
  const stat = lstatSync(home);
  if (info.username !== "happycampr" || info.uid !== 501 || process.getuid() !== 501 || home !== "/Users/happycampr" ||
      !/^UniqueID: 501$/m.test(api) || !/^NFSHomeDirectory: \/Users\/happycampr$/m.test(api) || stat.uid !== 501 ||
      !stat.isDirectory() || stat.isSymbolicLink() || realpathSync(home) !== home || hostname() !== "Locals-MacBook-Pro.local") throw new Error("protected observer actual account identity invalid");
  return { username: info.username, uid: info.uid, processUid: process.getuid(), home, dev: stat.dev, ino: stat.ino, source: "os.userInfo+dscl", host: hostname() };
}
function protectedProcesses() {
  const result = spawnSync("/bin/ps", ["-axo", "uid=,pid=,lstart=,comm="], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("protected process observation unavailable");
  // Exclude only this exact short-lived ps child; the persistent observer/SSH stay in the inventory.
  return result.stdout.split("\n").filter(line => /^\s*501\s/.test(line) && Number(line.trim().split(/\s+/)[1]) !== result.pid).map(line => line.trim()).sort();
}
export function captureProtectedMirror() {
  const path = fixtureMarkers[2], stat = lstatSync(path), state = readStatePaths([path])[path];
  delete state.value;
  const facts = path => {
    const s = lstatSync(path), acl = run("/bin/ls", ["-lde", path]);
    return { path, kind: s.isDirectory() ? "directory" : "file", uid: s.uid, mode: s.mode & 0o7777, dev: s.dev, ino: s.ino,
      aclEmpty: !acl.split("\n")[0].split(/\s+/)[0].includes("+") && acl.split("\n").length === 1 };
  };
  return { ...state, path, canonical: realpathSync(path), gid: stat.gid, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    flags: Number(run("/usr/bin/stat", ["-f", "%f", path])), aclEmpty: facts(path).aclEmpty,
    parent: facts("/private/tmp"), ancestor: facts("/private") };
}
export function createProtectedCollector({ identity = protectedIdentity, readState = readStatePaths, processCapture = protectedProcesses,
  mirrorCapture = captureProtectedMirror, legacySnapshot = productionSnapshot, compareLegacy = productionChanges, clock = Date.now } = {}) {
  let bound, baseline;
  return request => {
    if (!validObservationScope(request?.identifiers) || !validObservationScope(request.agentIds)) throw Error("protected observer request scope invalid");
    const identifiers = [...request.identifiers], agentIds = [...request.agentIds];
    const id = identity(); if (bound && !same(bound, id)) throw new Error("protected observer identity changed"); bound ??= id;
    const production = readState(stateRoots(id.home)), processes = processCapture(), mirror = mirrorCapture(), after = legacySnapshot(id.home);
    baseline ??= after; const reads = [];
    const violations = compareLegacy(baseline, after, ["/tmp/cmux-soak-stable.sock", ...identifiers], agentIds, reads);
    if (!same(id, identity())) throw new Error("protected observer identity changed during capture");
    return { run: request.run, nonce: request.nonce, sequence: request.sequence, phase: request.phase, capturedAt: clock(),
      identifiers, agentIds: [...agentIds], identity: id, roots: stateRoots(id.home), production, processes, mirror, append: { reads, violations } };
  };
}
