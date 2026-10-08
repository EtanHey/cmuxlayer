// Runnable local501 entry. No host I/O on import; no SSH or implicit migration.
import * as filesystem from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { runFixtureController } from "./happycampr-controller.mjs";
import { createHappycamprSnapshotAdapter } from "./happycampr-runtime.mjs";
import { happycamprContract, validateHappycamprPlan } from "./happycampr-effects.mjs";
import { createOwnedStageAdapters } from "./happycampr-stages.mjs";
import { createHostTopology, hostQuery } from "./happycampr-transport.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export async function runHappycamprEntry(input, injected = {}) {
  const cfg = input?.config;
  if (cfg?.accountContract !== happycamprContract) return runFixtureController(cfg, injected);
  const plan = cfg.happycamprPlan, expected = cfg.expectedBinding, packet = input.executionPacket;
  validateHappycamprPlan(plan, expected);
  const offline = packet?.mode === "offline", owned = !!plan.composition?.ownedStages;
  if (owned && injected.stages) throw Error("owned lifecycle cannot substitute stage callbacks");
  if (!packet || packet.contract !== "happycampr-local-execution-v1" || packet.approved !== true ||
      !["offline", "host"].includes(packet.mode) || packet.run !== plan.run || packet.config !== expected.config ||
      packet.source !== plan.sourceManifest.head || packet.tree !== plan.sourceManifest.tree ||
      !same(packet.product, expected.product) || !same(packet.node, plan.runtime) ||
      cfg.target !== "m1-gate" || cfg.fixtureMode !== true || plan.zeroModel !== true ||
      plan.composition?.transport !== "private-daemon-v1") throw Error("reviewed explicit local501 execution packet required");
  for (const name of ["happycampr-entry.mjs", "happycampr-transport.mjs"]) {
    if (!/^[a-f0-9]{64}$/.test(plan.sourceManifest.files["scripts/xmac/" + name])) throw Error("entry/transport source binding missing");
  }
  const fs = injected.io?.fs ?? filesystem;
  if ((injected.entryPath ?? fileURLToPath(import.meta.url)) !== plan.sourceManifest.root + "/scripts/xmac/happycampr-entry.mjs") throw Error("executing local entry mismatch");
  if (offline && (!injected.io || !injected.fixtureIO || !injected.env || (!owned && !injected.stages) ||
      ["identity", "query", "runtimeIdentity", "sourceIdentity"].some(name => typeof injected.io[name] !== "function") ||
      !injected.io.fs || injected.fixtureIO.fs !== fs || ["uid", "spawnProcess"].some(name => typeof injected.fixtureIO[name] !== "function") ||
      ["realpathSync", "readFileSync", "lstatSync", "readdirSync", "mkdirSync", "writeFileSync", "existsSync"].some(name => typeof fs[name] !== "function") ||
      !injected.transportIO || injected.transportIO.fs !== fs || ["query", "health", "rpc", "runtimeIdentity"].some(name => typeof injected.transportIO[name] !== "function"))) throw Error("complete offline entry I/O required");
  const io = injected.io ?? {
    fs, query: hostQuery, identity: createHappycamprSnapshotAdapter(plan, expected).identity,
    modulePath: plan.sourceManifest.root + "/scripts/xmac/happycampr-runtime.mjs",
    runtimeIdentity: () => ({ node: fs.realpathSync(process.execPath), sha256: hash(fs.readFileSync(process.execPath)) }),
  };
  createHappycamprSnapshotAdapter(plan, expected, io).attest(); // Before imports, connection or stage factory.
  const source = io.sourceIdentity ? io.sourceIdentity() : { head: io.query("/usr/bin/git", ["-C", plan.sourceManifest.root, "rev-parse", "HEAD"]), tree: io.query("/usr/bin/git", ["-C", plan.sourceManifest.root, "rev-parse", "HEAD^{tree}"]) };
  if (source.head !== plan.sourceManifest.head || source.tree !== plan.sourceManifest.tree) throw Error("executing source Git identity mismatch");
  const fixtureIO = injected.fixtureIO ?? { fs, uid: process.getuid, node: plan.runtime.node,
    helper: plan.sourceManifest.root + "/scripts/xmac/fixture-launchers.mjs", tui: plan.sourceManifest.root + "/scripts/ratchet-fixture-tui.mjs", spawnProcess: spawn };
  const env = injected.env ?? { HOME: plan.identity.home, PATH: "/usr/bin:/bin", LC_ALL: "C" };
  if (owned) io.stageIO = injected.stageIO;
  let stages = owned ? createOwnedStageAdapters({ cfg, executionPacket: packet, io, fixtureIO, env }) : injected.stages;
  if (owned && (packet.stageModule !== plan.sourceManifest.root + "/scripts/xmac/happycampr-stages.mjs" || !/^[a-f0-9]{64}$/.test(plan.sourceManifest.files["scripts/xmac/happycampr-stages.mjs"]))) throw Error("reviewed owned stage module binding required");
  if (!stages) {
    const path = packet.stageModule, relative = typeof path === "string" && path.slice(plan.sourceManifest.root.length + 1);
    if (path !== plan.sourceManifest.root + "/scripts/xmac/happycampr-stages.mjs" || !plan.sourceManifest.files[relative]) throw Error("Packet B reviewed owned stage module required");
    const module = await import(pathToFileURL(path));
    if (typeof module.createOwnedStageAdapters !== "function") throw Error("owned stage adapter export missing");
    stages = await module.createOwnedStageAdapters({ cfg, executionPacket: packet, io, fixtureIO, env });
  }
  return runFixtureController(cfg, { io, fixtureIO, env, stages,
    modulePath: injected.modulePath ?? plan.sourceManifest.root + "/scripts/xmac/happycampr-controller.mjs",
    topology: createHostTopology(plan, injected.transportIO) });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw Error("one reviewed execution packet file required");
  const stat = filesystem.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 1024 * 1024) throw Error("private execution packet file required");
  const input = JSON.parse(filesystem.readFileSync(path, "utf8"));
  if (input.executionPacket?.mode !== "host") throw Error("CLI requires separately authorized host packet; offline injection uses the same exported entry");
  const instance = await runHappycamprEntry(input); console.log(JSON.stringify(await instance.close()));
}
