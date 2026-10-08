import { expect, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { startSoakRuntime } from "../scripts/soak-runtime.mjs";
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
  const sourceFiles = Object.fromEntries(runtimeSourceFiles.map(path => {
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
    sourceManifest: { root: root + "/fixture", head: "5e2588e4b93d5eb3374a7bae6ba9b6aa7dd479a5", tree: "2f91a3bb55c7058f7662bade7914ea16abc3e641", files: sourceFiles },
    binding: { source: "5e2588e4b93d5eb3374a7bae6ba9b6aa7dd479a5", observer, config: "", product: { head: "d539fbefc75327375d144d3108ce1b7a0157d225", tree: "e5cf40901e80897319f9a9daea0c9982fa604294", version: "0.4.101", manifest: digest(manifestBytes), buildIdentity: digest(buildBytes) } } };
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
const run = async (f: ReturnType<typeof fixture>) => {
  const api = process.env.RUNTIME_ENTRY_UNDER_TEST ? await import(process.env.RUNTIME_ENTRY_UNDER_TEST) : { startSoakRuntime };
  return api.startSoakRuntime(f.opts, "/synthetic/output");
};
it("valid bound501 reaches actual runtime, scoped producer/consumer and effects checks", async () => {
  const f = fixture(), instance = await run(f), result = await instance.close();
  expect(result.error).toBeUndefined(); expect(result.status).toBe("PASS"); expect(result.cleanup.status).toBe("READY"); expect(result.cleanup.executes).toBe(false);
  expect(result.observer_checkpoints).toHaveLength(25); expect(result.observer_checkpoints.at(-1).phase).toBe("run-final");
  expect(result.observer_checkpoints.every((row: any, i: number) => row.run === f.plan.run && row.sequence === i + 1 && row.identifiers[0] === "runtime501" && row.agentIds[0] === "fixture-worker")).toBe(true);
  expect(f.mutationCount()).toBe(11); expect(await instance.close()).toBe(result);
});
it.each(["uid", "console", "home", "host", "node", "source", "product", "config", "observer", "epoch", "baseline", "template", "aqua", "module", "scope", "run", "topology", "link"])("rejects %s before any stage mutation", async fault => {
  const f = fixture();
  if (fault === "uid") f.identity.uid = 502;
  if (fault === "console") f.identity.consoleUid = 502;
  if (fault === "home") f.identity.home = "/Users/test";
  if (fault === "host") f.identity.host = "wrong-host";
  if (fault === "aqua") f.identity.aqua = false;
  if (fault === "module") f.io.modulePath = root + "/foreign-runtime.mjs";
  if (fault === "scope" || fault === "run") {
    if (fault === "scope") f.plan.agentIds = ["duplicate", "duplicate"]; else f.plan.run = "foreign";
    f.plan.binding.config = happycamprPlanDigest(f.plan); f.opts.expectedBinding = structuredClone(f.plan.binding);
  }
  if (fault === "topology") delete f.topology.surfaces;
  if (fault === "link") f.io.fs.realpathSync = (path: string) => path.endsWith("account-observer.mjs") ? "/foreign/link" : path;
  if (fault === "node") f.io.runtimeIdentity = () => ({ node, sha256: "0".repeat(64) });
  if (fault === "source") f.files.get(root + "/fixture/scripts/xmac/account-observer.mjs").bytes = Buffer.from("wrong-source");
  if (fault === "product") f.files.get(root + "/candidate/" + candidateFiles[0]).bytes = Buffer.from("wrong-product");
  if (fault === "config") f.opts.expectedBinding.config = "0".repeat(64);
  if (fault === "observer") f.opts.expectedBinding.observer = "0".repeat(64);
  if (fault === "epoch") f.topology.epoch = "replaced";
  if (fault === "baseline") f.files.get(root + "/fixture/package.json").ino++;
  if (fault === "template") f.opts.happycamprPlan = JSON.parse(readFileSync(join(process.cwd(), "../native-happycampr-fixture/docs.local/happycampr-native-fixture/preparation-config.json"), "utf8"));
  const result = (await run(f)).receipt; expect(result.status).toBe("FAIL"); expect(result.error).toBeTruthy(); expect(f.mutationCount()).toBe(0); expect(result.cleanup.executes).toBe(false);
});
it("preserves the primary stage error and truthful partial ledger when the post-check also fails", async () => {
  const f = fixture(); f.stages.config = () => { f.topology.focus = { workspace: "30000000-0000-0000-0000-000000000001", surface: "30000000-0000-0000-0000-000000000002" }; throw Error("PRIMARY_STAGE_FAILURE"); };
  const result = (await run(f)).receipt; expect(result.error).toContain("PRIMARY_STAGE_FAILURE"); expect(result.status).toBe("FAIL");
  expect(result.observer_checkpoints.at(-1).phase).toBe("config"); expect(result.observer_checkpoints).toHaveLength(10); expect(result.cleanup.status).toBe("PENDING");
  expect(result.cleanup.actions).toEqual([]); expect(result.cleanup.unobserved).toEqual(f.plan.effects.map((e: any) => e.id)); expect(result.cleanup.executes).toBe(false);
});
it.each(["pid", "inode", "uuid", "unavailable"])("fresh close preserves ambiguous %s without any cleanup action", async fault => {
  const f = fixture(), instance = await run(f);
  if (fault === "pid") f.process.start = "reused-start";
  if (fault === "inode") f.files.get(root + "/d.sock").ino++;
  if (fault === "uuid") f.topology.surfaces.at(-1).workspace = "30000000-0000-0000-0000-000000000001";
  if (fault === "unavailable") f.io.topology = () => { throw Error("observer unavailable"); };
  const result = await instance.close(); expect(result.status).toBe("FAIL"); expect(result.cleanup.status).toBe("PENDING"); expect(result.cleanup.executes).toBe(false);
  if (fault === "unavailable" || fault === "uuid") {
    expect(result.cleanup.actions).toEqual([]); expect(result.cleanup.unobserved).toEqual(f.plan.effects.map((e: any) => e.id));
    expect(result.observer_checkpoints).toHaveLength(24);
  }
  else expect(result.cleanup.preserved).toContain(fault === "pid" ? "pid:77" : fault === "inode" ? root + "/d.sock" : f.plan.effects.find((e: any) => e.kind === "surface").id);
});
it("retains the legacy502 admission boundary independently of the new501 branch", async () => {
  await expect(admitReviewedFixture({}, "1".repeat(32), { uid: 501, fs: new Proxy({}, { get: () => { throw Error("UNEXPECTED READ"); } }) })).rejects.toThrow("principal/run mismatch");
  await expect(admitReviewedFixture({ driverRoot: "/wrong" }, "1".repeat(32), { uid: 502, fs: { lstatSync: () => ({ isDirectory: () => false }) } })).rejects.toThrow("private root mismatch");
});
it("blocks unmanifested baseline scratch without reading unknown contents", async () => {
  const f = fixture(), path = root + "/unknown";
  f.files.set(path, { kind: "file", uid: 501, dev: 1, ino: 888, mode: 0o600, nlink: 1, size: 0 });
  const result = (await run(f)).receipt;
  expect(result.error).toContain("unmanifested scratch"); expect(f.mutationCount()).toBe(0); expect(result.cleanup.status).toBe("PENDING"); expect(result.cleanup.preserved).toContain(path);
});
it.each(["unknown-file", "unknown-workspace", "marker", "socket-owner"])("rejects %s after launch with a truthful partial receipt", async fault => {
  const f = fixture(), launch = f.stages.launch;
  f.stages.launch = () => {
    launch();
    if (fault === "unknown-file") f.files.set(root + "/foreign", { kind: "file", uid: 501, dev: 1, ino: 889, mode: 0o600, nlink: 1, size: 0 });
    if (fault === "unknown-workspace") f.topology.workspaces.push({ uuid: "40000000-0000-0000-0000-000000000001" });
    if (fault === "marker") f.files.get("/private/tmp/cmux-last-socket-path").ino++;
    if (fault === "socket-owner") f.io.socketOwner = 999;
  };
  const instance = await run(f), result = await instance.close();
  expect(result.status).toBe("FAIL"); expect(result.error).toBeTruthy(); expect(result.cleanup.status).toBe("PENDING"); expect(result.cleanup.executes).toBe(false);
  expect(result.observer_checkpoints.every((row: any, i: number) => row.sequence === i + 1 && row.run === f.plan.run)).toBe(true);
});

// R1 relationship controls exercise the actual runtime, collector, consumer and effects chain.
const foreignWorkspace = "abcdef00-0000-0000-0000-000000000001", foreignSurface = "abcdef00-0000-0000-0000-000000000002";
const relationshipFaults: Record<string, (t: any) => void> = {
  "reviewer missing-focus-members": t => { t.workspaces = []; t.surfaces = []; },
  "reviewer dangling-surface-workspace": t => { t.surfaces[0].workspace = foreignWorkspace; },
  "foreign focus workspace": t => { t.focus.workspace = foreignWorkspace; },
  "foreign focus surface": t => { t.focus.surface = foreignSurface; },
  "mismatched existing focus pair": t => { t.workspaces.push({ uuid: foreignWorkspace }); t.focus.workspace = foreignWorkspace; },
  "surface focus without workspace": t => { t.focus.workspace = null; },
  "unfocused dangling surface": t => { t.surfaces.push({ uuid: foreignSurface, workspace: foreignWorkspace }); },
  "unavailable workspaces": t => { delete t.workspaces; },
  "unavailable surfaces": t => { delete t.surfaces; },
  "missing focus": t => { delete t.focus; },
  "missing focus workspace": t => { delete t.focus.workspace; },
  "missing focus surface": t => { delete t.focus.surface; },
  "duplicate workspace": t => { t.workspaces.push({ ...t.workspaces[0] }); },
  "duplicate surface": t => { t.surfaces.push({ ...t.surfaces[0] }); },
  "case-aliased workspace": t => { t.workspaces[0].uuid = t.surfaces[0].workspace = t.focus.workspace = foreignWorkspace; t.workspaces.push({ uuid: foreignWorkspace.toUpperCase() }); },
  "case-aliased surface": t => { t.surfaces[0].uuid = t.focus.surface = foreignSurface; t.surfaces.push({ ...t.surfaces[0], uuid: foreignSurface.toUpperCase() }); },
};
function r1Ledger(r: any, f: ReturnType<typeof fixture>) {
  assert(r.observer_checkpoints.every((row: any, i: number) => row.sequence === i + 1 && row.run === f.plan.run && row.identifiers.join() === "runtime501" && row.agentIds.join() === "fixture-worker"));
  assert.equal(new Set(r.observer_checkpoints.map((row: any) => row.nonce)).size, r.observer_checkpoints.length);
  assert.equal(r.cleanup.executes, false);
}
it.each(Object.entries(relationshipFaults))("R1 rejects %s before baseline acceptance or mutation", async (_name, fault) => {
  const f = fixture(); fault(f.topology); const baseline = structuredClone(f.topology), i = await run(f), r = await i.close();
  assert.equal(r.status, "FAIL"); assert(r.error); assert.equal(f.mutationCount(), 0); assert.equal(r.before, undefined);
  assert.equal(r.observer_checkpoints.length, 0); assert.equal(r.cleanup.status, "PENDING"); assert.deepEqual(r.cleanup.actions, []);
  assert.deepEqual(r.cleanup.unobserved, f.plan.effects.map((e: any) => e.id)); assert.deepEqual(f.topology, baseline); r1Ledger(r, f);
});
it.each(Object.entries(relationshipFaults))("R1 fresh close latches %s without stale READY proposals", async (_name, fault) => {
  const f = fixture(), i = await run(f); assert.equal(i.receipt.status, "PASS"); assert.equal(i.receipt.cleanup.status, "READY");
  const healthy = structuredClone(f.topology); fault(f.topology); const r = await i.close();
  assert.equal(r.status, "FAIL"); assert(r.error); assert.equal(r.observer_checkpoints.length, 24);
  assert.equal(r.cleanup.status, "PENDING"); assert.deepEqual(r.cleanup.actions, []); assert.deepEqual(r.cleanup.unobserved, f.plan.effects.map((e: any) => e.id));
  Object.assign(f.topology, healthy); assert.equal(await i.close(), r); assert.equal(r.status, "FAIL"); assert.equal(r.observer_checkpoints.length, 24);
  assert.equal(f.mutationCount(), 11); r1Ledger(r, f);
});
it.each(["complete", "empty-null", "populated-null", "workspace-only", "empty-workspace"])("R1 admits healthy %s topology without inventing focus", async mode => {
  const f = fixture();
  if (mode === "empty-null") { f.topology.workspaces = []; f.topology.surfaces = []; }
  if (mode.endsWith("null")) f.topology.focus = { workspace: null, surface: null };
  if (mode === "workspace-only" || mode === "empty-workspace") f.topology.focus.surface = null;
  if (mode === "empty-workspace") f.topology.surfaces = [];
  const focus = structuredClone(f.topology.focus), r = await (await run(f)).close();
  assert.equal(r.status, "PASS"); assert.equal(r.error, undefined); assert.equal(r.cleanup.status, "READY"); assert.equal(r.observer_checkpoints.length, 25);
  assert.equal(f.mutationCount(), 11); assert.deepEqual(r.before.resources["protected-focus"], focus); assert.deepEqual(r.after.resources["protected-focus"], focus); r1Ledger(r, f);
});
it.each([false, true])("R1 conserves partial ledger and primary error on invalid post-stage topology (primary=%s)", async primary => {
  const f = fixture(), config = f.stages.config;
  f.stages.config = () => { config(); relationshipFaults["reviewer dangling-surface-workspace"](f.topology); if (primary) throw Error("R1_PRIMARY_STAGE_FAILURE"); };
  const i = await run(f), r = await i.close();
  assert.equal(r.status, "FAIL"); assert.match(r.error, primary ? /R1_PRIMARY_STAGE_FAILURE/ : /topology relationship/);
  assert.equal(f.mutationCount(), 5); assert.equal(r.observer_checkpoints.length, 10); assert.equal(r.observer_checkpoints.at(-1).phase, "config");
  assert.equal(r.cleanup.status, "PENDING"); assert.deepEqual(r.cleanup.actions, []); assert.deepEqual(r.cleanup.unobserved, f.plan.effects.map((e: any) => e.id)); r1Ledger(r, f);
});
