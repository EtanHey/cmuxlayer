import { statSync, readdirSync, readFileSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { join } from "node:path";
import { isHostedCapabilityTarget } from "./ratchet-app-guard.mjs";

const pointers = [".local/state/cmux/last-socket-path", ".local/state/cmux/nightly-last-socket-path"];
const missing = fn => { try { return fn(); } catch (error) { if (error.code !== "ENOENT") throw error; return null; } };
export function productionSnapshot(home) {
  const files = {}, socket_pointers = {};
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
  return { home, files, socket_pointers, agents: missing(() => readdirSync(join(home, ".cmux/agents"))) ?? [] };
}

// Read only appended bytes; retain no production content in a receipt.
export function productionChanges(before, after, identifiers, agentIds, reads = [], context = {}) {
  const changed = [], needles = [...new Set(identifiers.filter(Boolean))].map(value => Buffer.from(value));
  if (!needles.length) throw new Error("guard identifiers missing");
  if (Object.values(before.files).some(old => !Object.values(after.files).some(current => old.dev === current.dev && old.ino === current.ino))) throw new Error("production append source disappeared");
  for (const id of after.agents.filter(id => !before.agents.includes(id))) if (agentIds.includes(id) || id.startsWith("ratchet")) changed.push(`.cmux/agents/${id}`);
  const runnerLocal = isHostedCapabilityTarget(context.app, context);
  for (const path of pointers) {
    // Only this marker is runner-local on an ephemeral hosted capability run.
    // Keep both actual snapshots and all other production attribution intact.
    if (runnerLocal && path === ".local/state/cmux/last-socket-path") {
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
