import { statSync, lstatSync, readdirSync, readFileSync, openSync, readSync, fstatSync, closeSync, realpathSync } from "node:fs";
import { join, resolve, dirname, basename, sep } from "node:path";
import { isHostedCapabilityTarget } from "./ratchet-app-guard.mjs";

const pointers = [".local/state/cmux/last-socket-path", ".local/state/cmux/nightly-last-socket-path"];
const missing = fn => { try { return fn(); } catch (error) { if (error.code !== "ENOENT") throw error; return null; } };
// Resolve the marker, or its nearest existing ancestor when absent. lstat is
// deliberate: a dangling link is ambiguous, not an absent ordinary directory.
function nightlyMarkerLocation(home) {
  try {
    const marker = resolve(home, pointers[1]), tail = []; let existing = marker;
    while (!missing(() => lstatSync(existing))) { tail.unshift(basename(existing)); existing = dirname(existing); }
    const canonical = realpathSync(existing);
    if (tail.length && !statSync(existing).isDirectory()) throw new Error("marker ancestor is not a directory");
    return { home: realpathSync(home), path: join(canonical, ...tail),
      existing_parent: tail.length ? canonical : realpathSync(dirname(marker)) };
  } catch (error) { return { error: error.code ?? "AMBIGUOUS" }; }
}
export function productionSnapshot(home) {
  const files = {}, socket_pointers = {}, nightly_marker_location = nightlyMarkerLocation(home);
  for (const [dir, select] of [[".local/state/cmuxlayer", () => true], [".cmuxlayer/tickets", () => true], [".local/state/cmux", name => /^cmuxlayer-daemon-.*\.log(?:\.\d+)?$/.test(name)]]) {
    for (const name of missing(() => readdirSync(join(home, dir))) ?? []) {
      if (!select(name)) continue;
      const path = join(dir, name), stat = missing(() => statSync(join(home, path)));
      if (stat?.isFile()) files[path] = { size: stat.size, ino: stat.ino, dev: stat.dev };
    }
  }
  for (const path of pointers) socket_pointers[path] = missing(() => {
    if (statSync(join(home, path)).size > 8192) throw new Error("socket pointer exceeds guard limit");
    return readFileSync(join(home, path), "utf8");
  });
  if (JSON.stringify(nightly_marker_location) !== JSON.stringify(nightlyMarkerLocation(home))) throw new Error("NIGHTLY marker location changed during snapshot");
  return { home, files, socket_pointers, nightly_marker_location, agents: missing(() => readdirSync(join(home, ".cmux/agents"))) ?? [] };
}

// Read only appended bytes; retain no production content in a receipt.
export function productionChanges(before, after, identifiers, agentIds, reads = [], context = {}) {
  const changed = [], needles = [...new Set(identifiers.filter(Boolean))].map(value => Buffer.from(value));
  if (!needles.length) throw new Error("guard identifiers missing");
  if (Object.values(before.files).some(old => !Object.values(after.files).some(current => old.dev === current.dev && old.ino === current.ino))) throw new Error("production append source disappeared");
  for (const id of after.agents.filter(id => !before.agents.includes(id))) if (agentIds.includes(id) || id.startsWith("ratchet")) changed.push(`.cmux/agents/${id}`);
  const runnerLocal = isHostedCapabilityTarget(context.app, context);
  const env = context.env ?? process.env;
  const nightlyHome = runnerLocal && context.nightly === true && env.HOME ? realpathSync(env.HOME) : null;
  const markerLocal = snapshot => {
    const location = snapshot.nightly_marker_location;
    return location && !location.error && location.home === nightlyHome && typeof location.path === "string" && location.path.startsWith(nightlyHome + sep) &&
      typeof location.existing_parent === "string" && (location.existing_parent === nightlyHome || location.existing_parent.startsWith(nightlyHome + sep));
  };
  const nightlyRunnerLocal = nightlyHome && realpathSync(before.home) === nightlyHome && realpathSync(after.home) === nightlyHome &&
    realpathSync(env.RUNNER_TEMP).startsWith(nightlyHome + sep) && markerLocal(before) && markerLocal(after);
  for (const path of pointers) {
    // NIGHTLY requires runner scratch and both captured marker locations in HOME.
    // Keep both actual snapshots and all other production attribution intact.
    if ((runnerLocal && path === ".local/state/cmux/last-socket-path") || (nightlyRunnerLocal && path === ".local/state/cmux/nightly-last-socket-path")) {
      if (!context.runnerLocal) throw new Error("hosted marker receipt missing");
      context.runnerLocal.push({ path, before: before.socket_pointers[path], after: after.socket_pointers[path] });
      continue;
    }
    if (before.socket_pointers[path] !== after.socket_pointers[path] && after.socket_pointers[path] && [...identifiers, "/tmp/cmux-nightly.sock"].filter(Boolean).some(id => after.socket_pointers[path].includes(id))) changed.push(path);
  }
  for (const [path, stat] of Object.entries(after.files)) {
    const previous = Object.values(before.files).find(old => old.dev === stat.dev && old.ino === stat.ino);
    const start = previous?.size ?? 0, end = stat.size;
    if (end < start || end - start > 4 * 1024 * 1024) throw new Error("production append range truncated or exceeds guard limit");
    if (end === start) continue;
    const fd = openSync(join(after.home, path), "r"); let found = false, carry = Buffer.alloc(0);
    try {
      const current = fstatSync(fd);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.size < end) throw new Error("production file changed during guard read");
      const overlap = Math.max(...needles.map(needle => needle.length)) - 1;
      for (let pos = start; pos < end;) {
        const chunk = Buffer.alloc(Math.min(65536, end - pos)), count = readSync(fd, chunk, 0, chunk.length, pos);
        if (!count) throw new Error("production append range disappeared");
        pos += count; const bytes = Buffer.concat([carry, chunk.subarray(0, count)]);
        found ||= needles.some(needle => bytes.includes(needle)); carry = overlap ? bytes.subarray(-overlap) : Buffer.alloc(0);
      }
    } finally { closeSync(fd); }
    reads.push({ path, start, end }); if (found) changed.push(path);
  }
  return changed.sort();
}

export function privateWrites(home) {
  const path = home && join(home, ".local/state/cmuxlayer/daemon.log");
  const stat = path && missing(() => statSync(path));
  return { status: stat?.isFile() && stat.size > 0 ? "PASS" : "FAIL", path, bytes: stat?.size ?? 0 };
}
