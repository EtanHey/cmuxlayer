import { statSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Metadata only: never read production log, ticket, event or mailbox contents.
export function productionSnapshot(home) {
  const files = {}, visited = new Set();
  function visit(relative, recursive = false) {
    try {
      const stat = statSync(join(home, relative), { bigint: true });
      files[relative] = { size: String(stat.size), mtime_ns: String(stat.mtimeNs) };
      if (recursive && stat.isDirectory()) {
        const real = realpathSync(join(home, relative)); if (visited.has(real)) return; visited.add(real);
        for (const name of readdirSync(join(home, relative)).sort()) visit(join(relative, name), true);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const directory of [".local/state/cmuxlayer", ".cmuxlayer/tickets"]) visit(directory, true);
  for (const file of [".local/state/cmux/last-socket-path", ".local/state/cmux/nightly-last-socket-path", ".cmuxterm/events.jsonl"]) visit(file);
  let agents = null;
  try { agents = readdirSync(join(home, ".cmux/agents")).sort(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { files, agents_count: agents?.length ?? null, agents_sha256: createHash("sha256").update(JSON.stringify(agents)).digest("hex") };
}

export function productionChanges(before, after) {
  const paths = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort();
  const changed = paths.filter(path => JSON.stringify(before.files[path]) !== JSON.stringify(after.files[path]));
  if (before.agents_count !== after.agents_count || before.agents_sha256 !== after.agents_sha256) changed.push(".cmux/agents listing");
  return changed;
}
