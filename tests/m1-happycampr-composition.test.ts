import { it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { runFixtureController } from "../scripts/xmac/happycampr-controller.mjs";
import { installFixtureLaunchers } from "../scripts/xmac/fixture-launchers.mjs";
import { runAccountDriver } from "../scripts/xmac/account-observer-bridge.mjs";
import { runtimeSourceFiles } from "../scripts/xmac/happycampr-runtime.mjs";
import { admitReviewedFixture, observerSourceFiles } from "../scripts/xmac/account-observer-bridge.mjs";
import { happycamprPlanDigest } from "../scripts/xmac/happycampr-effects.mjs";
import { admissionStages } from "../scripts/xmac/app-admission.mjs";
const digest = (bytes: any) => createHash("sha256").update(bytes).digest("hex");
const root = "/Users/happycampr/Library/Caches/cmuxlayer-native-Runtime", node = "/opt/homebrew/Cellar/node/26.10.0_2/bin/node";
const productRoot = join(process.cwd(), "../release-0102-roots"), packet = join(productRoot, "docs.local/release-0102-roots");
const manifestBytes = readFileSync(join(packet, "dist-manifest.json")), buildBytes = readFileSync(join(packet, "build-identity.json"));
const candidateFiles = Object.keys(JSON.parse(manifestBytes.toString()));
function fixture() {
  const identity: any = { username: "happycampr", uid: 501, processUid: 501, consoleUid: 501, home: "/Users/happycampr", source: "os.userInfo+dscl", host: "Locals-MacBook-Pro.local", aqua: true, dev: 1, ino: 2 };
  const files = new Map<string, any>(); let inode = 3, running = false, setting = "old", mutations = 0;
  const add = (path: string, kind: string, bytes?: Buffer) => {
    if (path.startsWith(root + "/") && !files.has(dirname(path))) add(dirname(path), "directory");
    files.set(path, { kind, bytes, uid: 501, dev: 1, ino: inode++, mode: kind === "directory" ? 0o700 : 0o600, nlink: 1, size: bytes?.length ?? 0 });
  };
  add(root, "directory");
  const sourceFiles = Object.fromEntries([...runtimeSourceFiles, "scripts/xmac/happycampr-controller.mjs"].map(path => {
    const bytes = readFileSync(path); add(root + "/fixture/" + path, "file", bytes); return [path, digest(bytes)];
  }));
  for (const path of candidateFiles) add(root + "/candidate/" + path, "file", readFileSync(join(productRoot, path)));
  add(root + "/candidate/dist-manifest.json", "file", manifestBytes); add(root + "/candidate/build-identity.json", "file", buildBytes);
  add(root + "/candidate/package.json", "file", readFileSync(join(productRoot, "package.json")));
  const marker = "/private/tmp/cmux-last-socket-path"; add(marker, "file", Buffer.from("old"));
  const witness = (path: string, kind?: string) => {
    const file = files.get(path), row: any = { kind: kind ?? file.kind, canonical: path, uid: file.uid, dev: file.dev, ino: file.ino, mode: file.mode };
    if (file.kind === "file") Object.assign(row, { nlink: file.nlink, hash: digest(file.bytes) }); return row;
  };
  const workspace = "10000000-0000-0000-0000-000000000001", surface = "10000000-0000-0000-0000-000000000002", epoch = "runtime-epoch";
  const focus = { workspace: "20000000-0000-0000-0000-000000000001", surface: "20000000-0000-0000-0000-000000000002" };
  const topology: any = { epoch, workspaces: [{ uuid: focus.workspace }], surfaces: [{ uuid: focus.surface, workspace: focus.workspace }], focus };
  const runtime = { node, sha256: "832eaf52cafa7ff1364c2ca378451db14fb043d8d23a5cfd18a0a103d66226fc" };
  const effects: any[] = [...files.keys()].filter(path => path !== root).map(path => ({ id: path, kind: path === marker ? "marker" : files.get(path).kind, before: witness(path, path === marker ? "marker" : undefined), owned: witness(path, path === marker ? "marker" : undefined) }));
  effects.find(e => e.id === marker).owned.hash = digest("owned");
  const process = { kind: "process", uid: 501, pid: 77, start: "Wed Oct 7 10:00:00 2026", executable: node, entry: root + "/candidate/dist/daemon.js", distManifest: digest(manifestBytes) };
  effects.push({ id: "pid:77", kind: "process", before: null, owned: process },
    { id: root + "/d.sock", kind: "socket", before: null, owned: { kind: "socket", canonical: root + "/d.sock", uid: 501, dev: 1, ino: 9999, mode: 0o600, pid: 77, start: process.start } },
    { id: "workspace:" + workspace, kind: "workspace", before: null, owned: { kind: "workspace", uuid: workspace, observerEpoch: epoch } },
    { id: "surface:" + surface, kind: "surface", before: null, owned: { kind: "surface", uuid: surface, workspace, observerEpoch: epoch } },
    { id: "setting:com.cmuxterm.app:fixtureProbe", kind: "setting", before: { kind: "setting", domain: "com.cmuxterm.app", key: "fixtureProbe", value: "old" }, owned: { kind: "setting", domain: "com.cmuxterm.app", key: "fixtureProbe", value: "owned" } });
  const observer = digest(JSON.stringify(Object.fromEntries(observerSourceFiles.map(path => [path, sourceFiles[path]]).sort(([a], [b]) => a.localeCompare(b)))));
  const plan: any = { contract: "happycampr-owned-effects-v1", executionApproved: true, nativeApproved: true, zeroModel: true, run: "1".repeat(32), identity: structuredClone(identity), products: ["report", "spawn", "focus"], agentIds: ["fixture-worker"], observerEpoch: epoch, runtime,
    scratch: { path: root, canonical: root, uid: 501, mode: 0o700, dev: 1, ino: files.get(root).ino }, effects,
    sourceManifest: { root: root + "/fixture", head: "5d6ce0ec2a079d42aa59b1ec12542c3d5e6c310e", tree: "75e4e83c53fe94fd072dd38dd11755501e433029", files: sourceFiles },
    binding: { source: "5d6ce0ec2a079d42aa59b1ec12542c3d5e6c310e", observer, config: "", product: { head: "d539fbefc75327375d144d3108ce1b7a0157d225", tree: "e5cf40901e80897319f9a9daea0c9982fa604294", version: "0.4.101", manifest: digest(manifestBytes), buildIdentity: digest(buildBytes) } } };
  plan.binding.config = happycamprPlanDigest(plan);
  const fs = { realpathSync: (path: string) => path, readFileSync: (path: string) => files.get(path)?.bytes ?? (() => { throw Error("UNPLANNED FILE READ " + path); })(),
    lstatSync: (path: string) => {
      const row = files.get(path); if (!row) throw Object.assign(Error("absent"), { code: "ENOENT" });
      return { ...row, isDirectory: () => row.kind === "directory", isFile: () => row.kind === "file", isSocket: () => row.kind === "socket", isSymbolicLink: () => false };
    }, readdirSync: (path: string) => [...files.keys()].filter(p => p !== path && dirname(p) === path).map(p => p.slice(path.length + 1)) };
  const io: any = { fs, identity: () => structuredClone(identity), modulePath: root + "/fixture/scripts/xmac/happycampr-runtime.mjs", runtimeIdentity: () => structuredClone(runtime), topology: () => structuredClone(topology),
    query: (cmd: string, args: string[]) => {
      if (cmd === "/bin/ps") return !running ? "" : args.at(-1) === "args=" ? node + " " + process.entry : `501 ${process.start} ${node}`;
      if (cmd === "/usr/sbin/lsof") return "p" + (io.socketOwner ?? 77) + "\nn" + root + "/d.sock";
      if (cmd === "/usr/bin/defaults") return setting;
      throw Error("UNPLANNED OS COMMAND " + cmd);
    } };
  const stages: any = Object.fromEntries([...admissionStages, "refreshAndQuit", "launch"].map(name => [name, () => { mutations++; }]));
  stages.launch = () => { mutations++; running = true; setting = "owned"; files.get(marker).bytes = Buffer.from("owned"); files.get(marker).size = 5; add(root + "/d.sock", "socket"); files.get(root + "/d.sock").ino = 9999; topology.workspaces.push({ uuid: workspace }); topology.surfaces.push({ uuid: surface, workspace }); };
  const opts: any = { target: "m1-gate", fixtureMode: true, accountContract: plan.contract, happycamprPlan: plan, expectedBinding: structuredClone(plan.binding), happycamprIO: io, happycamprStages: stages };
  return { opts, io, plan, identity, files, topology, stages, process, mutationCount: () => mutations };
}
// Explicit synthetic witness providers; source labels are metadata, not native approval.
function composition() {
  const f = fixture(); let next = 50000; const launches: any[] = [];
  f.files.set(node, { kind: "file", bytes: Buffer.from("synthetic Node witness"), uid: 501, dev: 1, ino: 49999, mode: 0o700, nlink: 1, size: 22 });
  const put = (path: string, kind: string, bytes: Buffer | undefined, mode: number) => {
    const before = f.files.get(path); f.files.set(path, { kind, bytes, uid: 501, dev: 1, ino: before?.ino ?? next++, mode, nlink: 1, size: bytes?.length ?? 0 });
  };
  Object.assign(f.io.fs, { existsSync: (p: string) => f.files.has(p), mkdirSync: (p: string, o: any) => put(p, "directory", undefined, o.mode), writeFileSync: (p: string, b: string, o: any) => put(p, "file", Buffer.from(b), o.mode) });
  const fixtureIO: any = { fs: f.io.fs, uid: () => f.identity.processUid, node, helper: root + "/fixture/scripts/xmac/fixture-launchers.mjs", tui: root + "/fixture/scripts/ratchet-fixture-tui.mjs", digest: (p: string) => p === node ? f.plan.runtime.sha256 : digest(f.files.get(p).bytes),
    spawnProcess: (command: string, args: string[], options: any) => { const row = { command, args, options, fixtureOnly: true, captured: readFileSync("tests/fixtures/codex-0.157/idle-submitted-working.txt", "utf8") }; launches.push(row); return row; } };
  const env = { HOME: f.identity.home, OPENAI_API_KEY: "synthetic-denial-canary" };
  const fc = { repo: "Fixture", row: "contract", cwd: root + "/fixture", app: root + "/private.app", args: ["--worker", "-m", "gpt-6-luna", "-E", "low"] };
  const peer: any = { epoch: f.plan.observerEpoch, product: structuredClone(f.plan.binding.product), socket: { path: root + "/observer.sock", uid: 501, mode: 0o600, dev: 1, ino: 60000 }, process: { pid: 78, uid: 501, start: "independent-observer-start", executable: node, entry: root + "/candidate/dist/index.js" } };
  f.plan.composition = { fixture: fc, topologyPeer: structuredClone(peer) };
  // Preview the existing installer only against a cloned/reset mock filesystem.
  const before = new Set(f.files.keys()), saved = next;
  installFixtureLaunchers({ ...env }, { repo: fc.repo, fixtureRow: fc.row, app: fc.app }, root, fc.cwd, fixtureIO);
  for (const path of f.files.keys()) if (!before.has(path)) {
    const r = f.files.get(path); const owned: any = { kind: r.kind, canonical: path, uid: r.uid, dev: r.dev, ino: r.ino, mode: r.mode };
    if (r.kind === "file") Object.assign(owned, { nlink: 1, hash: digest(r.bytes) }); f.plan.effects.push({ id: path, kind: r.kind, before: null, owned });
  }
  for (const path of f.files.keys()) if (!before.has(path)) f.files.delete(path); next = saved;
  f.plan.binding.config = happycamprPlanDigest(f.plan); f.opts.expectedBinding = structuredClone(f.plan.binding);
  let reads = 0; const topology: any = { observePeer: () => structuredClone(peer), readTopology: (...args: any[]) => { assert.equal(args.length, 0); reads++; return { complete: true, ...structuredClone(f.topology) }; } };
  const adapters: any = { io: f.io, fixtureIO, env, topology, modulePath: root + "/fixture/scripts/xmac/happycampr-controller.mjs", stages: { ...f.stages, launch: (ctx: any) => { ctx.launchFixture(); return f.stages.launch(); } } };
  return { ...f, adapters, peer, launches, reads: () => reads };
}
const faults: Record<string, (f: ReturnType<typeof composition>) => void> = {
  "stage": f => { delete f.adapters.stages.lock; }, "topology adapter": f => { delete f.adapters.topology; },
  "filesystem writer": f => { delete f.io.fs.mkdirSync; }, "fixture launcher": f => { delete f.adapters.fixtureIO.spawnProcess; },
  "fixture UID": f => { f.adapters.fixtureIO.uid = () => 502; }, "fixture Node": f => { f.adapters.fixtureIO.digest = () => "0".repeat(64); },
  "approval": f => { f.plan.executionApproved = false; f.plan.binding.config = happycamprPlanDigest(f.plan); f.opts.expectedBinding = structuredClone(f.plan.binding); },
  "source": f => { f.files.get(root + "/fixture/scripts/xmac/happycampr-controller.mjs").bytes = Buffer.from("foreign"); },
  "product": f => { f.files.get(root + "/candidate/" + candidateFiles[0]).bytes = Buffer.from("foreign"); },
  "Node": f => { f.io.runtimeIdentity = () => ({ node, sha256: "0".repeat(64) }); }, "host": f => { f.identity.host = "foreign"; }, "console": f => { f.identity.consoleUid = 502; },
  "observer": f => { f.opts.expectedBinding.observer = "0".repeat(64); }, "config": f => { f.opts.expectedBinding.config = "0".repeat(64); },
  "template": f => { f.opts.happycamprPlan = JSON.parse(readFileSync("../native-happycampr-fixture/docs.local/happycampr-native-fixture/preparation-config.json", "utf8")); },
  "peer PID": f => { f.peer.process.pid++; }, "peer socket": f => { f.peer.socket.ino++; }, "peer product": f => { f.peer.product.manifest = "0".repeat(64); }, "peer epoch": f => { f.peer.epoch = "foreign"; },
  "unavailable inventory": f => { f.adapters.topology.readTopology = () => ({ complete: false }); }, "request echo": f => { f.adapters.topology.readTopology = () => ({ args: f.opts }); },
  "foreign member": f => { f.topology.surfaces[0].workspace = "30000000-0000-0000-0000-000000000001"; },
  "missing focus inventories": f => { f.topology.workspaces = []; f.topology.surfaces = []; },
  "peer drift during read": f => { f.adapters.topology.readTopology = () => { f.peer.socket.ino++; return { complete: true, ...f.topology }; }; },
  "inventory limit": f => { f.topology.workspaces = Array(1025).fill(f.topology.workspaces[0]); },
  "null inventory": f => { f.topology.workspaces = null; },
  "private metadata": f => { f.topology.workspaces[0].title = "must not be captured"; },
  "global socket binding": f => { f.plan.composition.topologyPeer.socket.path = "/private/tmp/cmux.sock"; f.plan.binding.config = happycamprPlanDigest(f.plan); f.opts.expectedBinding = structuredClone(f.plan.binding); },
  "model metadata": f => { f.plan.composition.fixture.args = ["--model", "real-model"]; f.plan.binding.config = happycamprPlanDigest(f.plan); f.opts.expectedBinding = structuredClone(f.plan.binding); },
};
it.each(Object.entries(faults))("composition rejects %s before stage mutation", async (_name, fault) => {
  const f = composition(); fault(f); let r: any;
  try { r = (await runFixtureController(f.opts, f.adapters)).receipt; } catch (error) { assert(error); }
  if (r) { assert.equal(r.status, "FAIL"); assert.equal(r.observer_checkpoints.length, 0); assert.deepEqual(r.cleanup.actions, []); }
  assert.equal(f.mutationCount(), 0); assert.equal(f.launches.length, 0);
});
it.each(["complete", "empty-null"])("composition connects actual entry/reader/installer/launcher/observer/effects with %s topology", async mode => {
  const f = composition(); if (mode === "empty-null") { f.topology.workspaces = []; f.topology.surfaces = []; f.topology.focus = { workspace: null, surface: null }; }
  const i = await runFixtureController(f.opts, f.adapters), r = await i.close();
  assert.equal(r.status, "PASS"); assert.equal(r.cleanup.status, "READY"); assert.equal(r.cleanup.executes, false); assert.equal(r.observer_checkpoints.length, 25); assert.equal(f.mutationCount(), 11);
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].command, node); assert.deepEqual(f.launches[0].args, [f.adapters.fixtureIO.tui, "contract", root + "/ratchet-events.json"]);
  assert.equal(f.launches[0].options.cwd, root + "/fixture");
  assert(!("OPENAI_API_KEY" in f.launches[0].options.env)); assert(f.launches[0].captured.includes("Working")); assert(i.fixtureInstall.fixture_only); assert(f.reads() >= 50); assert.equal(await i.close(), r);
});
it.each(["peer", "foreign-effect", "missing-effect"])("composition fresh close keeps %s ambiguity pending", async mode => {
  const f = composition(), i = await runFixtureController(f.opts, f.adapters); assert.equal(i.receipt.status, "PASS");
  if (mode === "peer") f.peer.socket.ino++; if (mode === "foreign-effect") f.files.set(root + "/foreign", { kind: "file", uid: 501, dev: 1, ino: 70000, mode: 0o600, nlink: 1, size: 0 });
  if (mode === "missing-effect") f.files.delete(root + "/d.sock"); const r = await i.close();
  assert.equal(r.cleanup.status, "PENDING"); assert.equal(r.cleanup.executes, false); if (mode === "peer") { assert.equal(r.status, "FAIL"); assert.deepEqual(r.cleanup.actions, []); assert.equal(r.observer_checkpoints.length, 24); }
  for (const action of r.cleanup.actions) assert.deepEqual(action.identity, r.after.resources[action.id]);
});
it("composition preserves a primary stage error across a repaired observer and forbids launcher replay", async () => {
  const f = composition(); let context: any; f.adapters.stages.launch = (ctx: any) => { context = ctx; ctx.launchFixture(); f.peer.socket.ino++; throw Error("PRIMARY_COMPOSITION"); };
  const i = await runFixtureController(f.opts, f.adapters), count = i.receipt.observer_checkpoints.length; f.peer.socket.ino--;
  const r = await i.close(); assert.match(r.error, /PRIMARY_COMPOSITION/); assert.equal(r.status, "FAIL"); assert.equal(r.observer_checkpoints.length, count); assert.deepEqual(r.cleanup.actions, []); assert.equal(f.launches.length, 1);
  assert.throws(() => context.launchFixture(), /order\/single-dispatch/); assert.equal(f.launches.length, 1);
});
it("composition default/502 route retains the original controller refusal", async () => {
  const io = { spawnProcess: () => { throw Error("UNEXPECTED_PROCESS"); } };
  await assert.rejects(runAccountDriver({}, io), /M1 reviewed runner\/control admission missing/);
  await assert.rejects(runFixtureController({}, io), /M1 reviewed runner\/control admission missing/);
  await assert.rejects(admitReviewedFixture({ driverRoot: "/wrong" }, "1".repeat(32), { uid: 502, fs: { lstatSync: () => ({ isDirectory: () => false }) } }), /fixture private root mismatch/);
});
it.each(["helper", "trap", "routing"])("composition detects %s tampering before fixture dispatch", async kind => {
  const f = composition(); f.adapters.stages.preferences = (ctx: any) => {
    f.stages.preferences(); const install = ctx.fixtureInstall;
    if (kind === "helper") f.files.get(f.adapters.fixtureIO.helper).bytes = Buffer.from("changed");
    if (kind === "trap") f.files.get(install.binaries.codex).bytes = Buffer.from("changed");
    if (kind === "routing") f.files.set(root + "/model-trap.log", { kind: "file", bytes: Buffer.from("codex"), uid: 501, dev: 1, ino: 71000, mode: 0o600 });
  };
  const i = await runFixtureController(f.opts, f.adapters), r = await i.close();
  assert.equal(r.status, "FAIL"); assert.equal(f.launches.length, 0); assert.equal(r.cleanup.executes, false);
});
it.each(["missing", "early", "uncertain"])("composition refuses %s fixture dispatch without replay", async kind => {
  const f = composition(); let context: any;
  if (kind === "early") f.adapters.stages.lock = (ctx: any) => { context = ctx; ctx.launchFixture(); };
  else f.adapters.stages.launch = (ctx: any) => { context = ctx; if (kind === "uncertain") ctx.launchFixture(); };
  if (kind === "uncertain") f.adapters.fixtureIO.spawnProcess = () => { f.launches.push({ attempted: true }); throw Error("DISPATCH_UNCERTAIN"); };
  const i = await runFixtureController(f.opts, f.adapters), r = await i.close();
  assert.equal(r.status, "FAIL"); assert.equal(f.launches.length, kind === "uncertain" ? 1 : 0); assert.equal(r.cleanup.executes, false);
  assert.throws(() => context.launchFixture(), /order\/single-dispatch/); assert.equal(f.launches.length, kind === "uncertain" ? 1 : 0);
});
