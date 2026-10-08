// Dedicated standard-account contract. Importing never inspects or mutates a host.
import { userInfo } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, realpathSync, readdirSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const accountContract = "dedicated-test-502-v1";
const socketPath = "/tmp/cmux-soak-stable.sock";
export const fixtureMarkers = ["/Users/test/.local/state/cmux/last-socket-path",
  "/Users/test/Library/Application Support/cmux/last-socket-path", "/tmp/cmux-last-socket-path"];
export const stateRoots = home => [".local/state/cmux", ".local/state/cmuxlayer", ".cmux/agents", ".cmuxlayer/tickets",
  "Library/Application Support/cmux", "Library/Preferences/com.cmuxterm.app.plist",
  "Library/Caches/com.cmuxterm.app", "Library/Logs/cmux"].map(path => join(home, path));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 5000,
  env: { ...process.env, LC_ALL: "C" } }).trim();
const absent = fn => { try { return fn(); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };

export function validateDedicatedIdentity(s) {
  const f = s?.fixture, p = s?.production;
  if (f?.username !== "test" || f.uid !== 502 || f.home !== "/Users/test" || f.source !== "os.userInfo" ||
      p?.username !== "happycampr" || p.uid !== 501 || p.home !== "/Users/happycampr" || p.source !== "dscl" ||
      s.processUid !== f.uid || s.consoleUid !== f.uid || s.aqua !== true || s.admin !== false ||
      f.home === p.home || f.uid === p.uid) throw new Error("dedicated account identity/Aqua proof invalid or unavailable");
  return s;
}
function accountLookup(username) {
  const text = run("/usr/bin/dscl", ["/Search", "-read", `/Users/${username}`, "UniqueID", "NFSHomeDirectory"]);
  const uid = /^UniqueID: (\d+)$/m.exec(text), home = /^NFSHomeDirectory: (\/[^\n]+)$/m.exec(text);
  if (!uid || !home) throw new Error("account API identity unavailable");
  return { username, uid: Number(uid[1]), home: home[1], source: "dscl" };
}
export function observeDedicatedIdentity() {
  const info = userInfo(), fixture = { username: info.username, uid: info.uid, home: info.homedir, source: "os.userInfo" };
  if (fixture.username !== "test" || fixture.uid !== 502 || fixture.home !== "/Users/test" || process.getuid() !== 502) throw new Error("execute only in actual test account context");
  const production = accountLookup("happycampr"), fixtureLookup = accountLookup("test");
  if (fixtureLookup.uid !== fixture.uid || fixtureLookup.home !== fixture.home) throw new Error("fixture account APIs disagree");
  for (const account of [fixture, production]) {
    const stat = lstatSync(account.home);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== account.uid || realpathSync(account.home) !== account.home) throw new Error("account home owner/path invalid");
    Object.assign(account, { dev: stat.dev, ino: stat.ino });
  }
  const membership = run("/usr/bin/dsmemberutil", ["checkmembership", "-U", "test", "-G", "admin"]);
  if (membership !== "user is not a member of the group") throw new Error("standard account membership unavailable or admin");
  // Query as test, not through another user's bootstrap. Denial is unavailable proof.
  run("/bin/launchctl", ["print", "gui/502"]);
  return validateDedicatedIdentity({ fixture, production, processUid: process.getuid(),
    consoleUid: lstatSync("/dev/console").uid, aqua: true, admin: false });
}
function safeAncestors(path, statPath = lstatSync, canonical = realpathSync) {
  for (let current = dirname(path); current !== "/"; current = dirname(current)) {
    const stat = absent(() => statPath(current));
    if (stat?.isSymbolicLink() && !(current === "/tmp" && canonical(current) === "/private/tmp")) throw new Error("state ancestor symlink refused");
  }
}
export function readStatePaths(paths, io = {}) {
  const statPath = io.lstatSync ?? lstatSync, list = io.readdirSync ?? readdirSync, canonical = io.realpathSync ?? realpathSync;
  const records = {}; let count = 0, total = 0;
  const walk = path => {
    safeAncestors(path, statPath, canonical);
    const stat = absent(() => statPath(path)); if (!stat) return;
    if (++count > 4096 || stat.isSymbolicLink()) throw new Error("state symlink or inventory limit refused");
    const facts = { uid: stat.uid, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
    if (stat.isDirectory()) {
      records[path] = { kind: "directory", ...facts };
      for (const name of list(path).sort()) walk(join(path, name));
      safeAncestors(path, statPath, canonical);
      const after = statPath(path);
      if (!after.isDirectory() || after.isSymbolicLink() ||
          ["uid", "gid", "mode", "dev", "ino", "nlink", "size", "mtimeMs", "ctimeMs"].some(key => after[key] !== stat[key]))
        throw new Error("state directory changed during traversal");
    } else if (stat.isFile()) {
      if (stat.nlink !== 1 || stat.size > 4 * 1024 * 1024 || (total += stat.size) > 16 * 1024 * 1024) throw new Error("state file links or byte limit refused");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd);
        if (before.dev !== stat.dev || before.ino !== stat.ino || before.uid !== stat.uid || before.size !== stat.size) throw new Error("state file changed before read");
        const buffer = Buffer.alloc(stat.size + 1); let size = 0, read;
        while (size < buffer.length && (read = readSync(fd, buffer, size, buffer.length - size, size))) size += read;
        const bytes = buffer.subarray(0, size), after = fstatSync(fd);
        if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("state file changed during read");
        records[path] = { kind: "file", ...facts, nlink: stat.nlink, size: bytes.length, hash: digest(bytes) };
        if (fixtureMarkers.includes(path)) {
          if (bytes.length > 4096) throw new Error("marker exceeds source limit");
          records[path].value = bytes.toString("utf8");
        }
      } finally { closeSync(fd); }
    } else if (stat.isSocket()) records[path] = { kind: "socket", ...facts };
    else throw new Error("unexpected state file type");
  };
  for (const path of [...paths].sort()) walk(path);
  return records;
}
export function validateProtectedMirror(row) {
  if (row?.path !== fixtureMarkers[2] || row.canonical !== "/private/tmp/cmux-last-socket-path" || row.kind !== "file" ||
      row.uid !== 501 || row.nlink !== 1 || row.mode & 0o022 || row.flags !== 0 || row.aclEmpty !== true ||
      row.writableToFixture !== false || !Number.isInteger(row.size) || row.size < 0 || row.size > 4096 || !/^[a-f0-9]{64}$/.test(row.hash) ||
      row.parent?.path !== "/private/tmp" || row.parent.kind !== "directory" || row.parent.uid !== 0 || row.parent.mode !== 0o1777 || row.parent.aclEmpty !== true ||
      row.ancestor?.path !== "/private" || row.ancestor.kind !== "directory" || row.ancestor.uid !== 0 || row.ancestor.mode & 0o022 || row.ancestor.aclEmpty !== true)
    throw new Error("protected mirror filesystem/write-denial proof invalid");
  return row;
}
export function verifyDedicatedState(binding, before, after, { requireMarkers = false, protectedMirror = false } = {}) {
  validateDedicatedIdentity(binding);
  if (protectedMirror) {
    validateProtectedMirror(before.mirror); validateProtectedMirror(after.mirror);
    if (!same(before.mirror, after.mirror)) throw new Error("protected mirror changed or replaced");
    if (before.fixture[fixtureMarkers[2]] || after.fixture[fixtureMarkers[2]]) throw new Error("protected mirror cannot be fixture state");
  }
  if (!same(before.production, after.production) || !same(before.processes, after.processes)) throw new Error("protected production state/process changed");
  const parents = fixtureMarkers.filter(path => path.startsWith(binding.fixture.home + "/")).map(dirname);
  for (const snapshot of [before, after]) {
    for (const [path, row] of Object.entries(snapshot.fixture)) {
      if ((!path.startsWith(binding.fixture.home + "/") && path !== fixtureMarkers[2]) || row.uid !== 502 || row.mode & 0o022) throw new Error("fixture state path/owner unsafe");
    }
    for (const path of fixtureMarkers) {
      const row = snapshot.fixture[path];
      if (row && (row.kind !== "file" || row.uid !== binding.fixture.uid || row.nlink !== 1 ||
          row.mode & 0o022 || row.value !== socketPath + "\n")) throw new Error("fixture marker owner/content/path invalid");
    }
  }
  for (const path of new Set([...Object.keys(before.fixture), ...Object.keys(after.fixture)])) {
    if (same(before.fixture[path], after.fixture[path])) continue;
    const row = after.fixture[path];
    if (fixtureMarkers.includes(path)) continue;
    if (!before.fixture[path] && parents.includes(path) && row?.kind === "directory" && row.uid === 502 && row.mode === 0o700) continue;
    throw new Error(`unexpected fixture state write: ${path}`);
  }
  if (requireMarkers && fixtureMarkers.slice(0, protectedMirror ? 2 : 3).some(path => !after.fixture[path])) throw new Error("documented fixture markers not all observed");
}
const processes = () => run("/bin/ps", ["-axo", "uid=,pid=,lstart=,comm="]).split("\n")
  .filter(line => /^\s*501\s/.test(line)).map(line => line.trim()).sort();
export function createDedicatedAccountGuard({ observe = observeDedicatedIdentity, capture, protectedObserver, mirrorAccess, fixtureCapture = readStatePaths, processQuery = run, statPath = lstatSync, realpath = realpathSync } = {}) {
  const binding = observe();
  const snapshot = capture ?? (protectedObserver ? (context = {}) => {
    const remote = protectedObserver(context), row = remote.mirror;
    if (["uid", "home", "dev", "ino"].some(key => remote.identity[key] !== binding.production[key])) throw new Error("protected observer home identity mismatch");
    const writable = mirrorAccess ? mirrorAccess(row) : (() => {
      const stat = statPath(fixtureMarkers[2]);
      if (!stat.isFile() || stat.isSymbolicLink() || ["uid", "gid", "dev", "ino", "nlink", "size"].some(key => stat[key] !== row[key]) || (stat.mode & 0o777) !== row.mode || realpath(fixtureMarkers[2]) !== row.canonical) throw new Error("protected mirror local identity mismatch");
      const access = spawnSync("/bin/test", ["-w", fixtureMarkers[2]], { timeout: 5000 });
      if (access.error || ![0, 1].includes(access.status)) throw new Error("protected mirror write access unavailable");
      return access.status === 0;
    })();
    validateProtectedMirror({ ...row, writableToFixture: writable });
    return { ...remote, mirror: { ...row, writableToFixture: writable }, fixture: fixtureCapture(stateRoots(binding.fixture.home)) };
  } : () => ({ fixture: readStatePaths([...stateRoots(binding.fixture.home), fixtureMarkers[2]]),
    production: readStatePaths(stateRoots(binding.production.home)), processes: processes() }));
  const verify = (a, b, options) => verifyDedicatedState(binding, a, b, { ...options, protectedMirror: !!protectedObserver });
  if (!capture && !protectedObserver) {
    const global = { fixture: readStatePaths([fixtureMarkers[2]]), production: {}, processes: [] };
    verifyDedicatedState(binding, global, global); // Reject the shared marker before protected-tree reads.
  }
  const before = snapshot({ phase: "baseline" }); verify(before, before);
  let checks = 0, last = before, failure = null;
  const check = ({ receipt, env, phase, identifiers = [], agentIds = [] } = {}) => {
    try {
      if (!same(binding, observe())) throw new Error("dedicated account identity changed");
      last = snapshot({ phase: phase ?? "checkpoint", identifiers, agentIds });
      if (last.append?.violations.length) throw new Error("protected production append changed");
      verify(before, last, { requireMarkers: phase === "socket-ready" || phase === "runtime-ready" }); checks++;
      for (const process of [receipt?.app_process, receipt?.daemon].filter(Boolean)) {
        if (processQuery("/bin/ps", ["-p", String(process.pid), "-o", "uid="]) !== "502" ||
            processQuery("/bin/ps", ["-p", String(process.pid), "-o", "pid=,lstart=,comm="]).replace(/\s+/g, " ") !== process.saved.replace(/\s+/g, " ")) throw new Error("fixture process UID/identity changed");
      }
      if (receipt?.scratch) {
        const scratch = realpath(receipt.scratch), stat = statPath(scratch);
        if (!stat.isDirectory() || stat.uid !== 502 || stat.mode & 0o077 || !scratch.startsWith(realpath(process.env.TMPDIR ?? "/tmp") + "/")) throw new Error("run scratch owner/path invalid");
        if (env?.CMUXLAYER_DAEMON_SOCKET && (realpath(dirname(env.CMUXLAYER_DAEMON_SOCKET)) !== scratch || resolve(env.CMUXLAYER_DAEMON_SOCKET).split("/").at(-1) !== "d.sock")) throw new Error("daemon socket escapes run scratch");
      }
      for (const path of [socketPath, env?.CMUXLAYER_DAEMON_SOCKET].filter(Boolean)) {
        const stat = absent(() => statPath(path));
        if (stat && (!stat.isSocket() || stat.uid !== 502)) throw new Error("fixture socket owner/type invalid");
        const owner = path === socketPath ? receipt?.app_process : receipt?.daemon;
        if (stat && owner) {
          const files = processQuery("/usr/sbin/lsof", ["-n", "-U", "-a", "-p", String(owner.pid), "-Fpn"]).split("\n");
          if (!files.includes(`p${owner.pid}`) || !files.includes(`n${path}`)) throw new Error("fixture socket PID ownership unverified");
        }
      }
    } catch (error) { failure = String(error).slice(0, 512); throw error; }
  };
  return { binding, before, check, result: () => ({ binding, before, after: last, checks,
    status: failure ? "FAIL" : "PASS", ...(failure ? { error: failure } : {}) }) };
}
