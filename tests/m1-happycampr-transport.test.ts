import { it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createHostTopology } from "../scripts/xmac/happycampr-transport.mjs";
const root = "/Users/happycampr/Library/Caches/cmuxlayer-native-Transport", node = "/opt/homebrew/Cellar/node/26.10.0_2/bin/node";
const productRoot = "../release-0102-roots", productPacket = productRoot + "/docs.local/release-0102-roots/";
const digest = (bytes: any) => createHash("sha256").update(bytes).digest("hex");
export function transportFixture(cacheRoot = root) {
  const root = cacheRoot;
  const runtime = { node, sha256: "832eaf52cafa7ff1364c2ca378451db14fb043d8d23a5cfd18a0a103d66226fc" };
  const control = root + "/control.sock", native = root + "/native.sock", files = new Map<string, Buffer>();
  for (const name of ["dist-manifest.json", "build-identity.json"]) files.set(root + "/candidate/" + name, readFileSync(productPacket + name));
  files.set(root + "/candidate/package.json", readFileSync(productRoot + "/package.json"));
  const manifest = JSON.parse(files.get(root + "/candidate/dist-manifest.json")!.toString());
  for (const path of Object.keys(manifest)) files.set(root + "/candidate/" + path, readFileSync(productRoot + "/" + path));
  const sockets: any = { [control]: { pid: 78, start: "private-start", executable: node, uid: 501, ino: 60000 },
    [native]: { pid: 79, start: "app-start", executable: "/private/cmux.app/cmux", uid: 501, ino: 60001 } };
  const workspace = "10000000-0000-0000-0000-000000000001", surface = "10000000-0000-0000-0000-000000000002";
  const replies: any = { "window.list": { windows: [{ id: "10000000-0000-0000-0000-000000000003", ref: "window:1" }] },
    "workspace.list": { workspaces: [{ id: workspace, ref: "workspace:1" }] }, "surface.list": { surfaces: [{ id: surface, ref: "surface:1", workspace_ref: "workspace:1" }] },
    "system.identify": { focused: { workspace_ref: "workspace:1", surface_ref: "surface:1" } } };
  const queries: any[] = [], calls: any[] = [];
  const fs: any = { realpathSync: (p: string) => p, readFileSync: (p: string) => { assert(files.has(p), p); return files.get(p); }, lstatSync: (p: string) => {
    assert(files.has(p) || sockets[p], p); const s = sockets[p]; return { isFile: () => !s, isSocket: () => !!s, isSymbolicLink: () => false,
      uid: s?.uid ?? 501, mode: 0o600, dev: 1, ino: s?.ino ?? 10, nlink: 1, size: files.get(p)?.length ?? 0, mtimeMs: 1, ctimeMs: 1, birthtimeNs: 1n, ctimeNs: 2n };
  } };
  const io: any = { fs, runtimeIdentity: () => structuredClone(runtime), query: (cmd: string, args: string[]) => {
    queries.push({ cmd, args });
    if (cmd === "/usr/sbin/lsof") { const s = sockets[args.at(-1)!]; return `p${s.pid}\nu${s.uid}\nn${args.at(-1)}`; }
    if (cmd === "/bin/ps") { const s: any = Object.values(sockets).find((s: any) => String(s.pid) === args[1]); return args.at(-1) === "args=" ? `${node} ${root}/candidate/dist/daemon.js` : `${s.uid} ${s.start} ${s.executable}`; }
    if (cmd === "/usr/bin/git") return args.at(-1) === "HEAD" ? "d539fbefc75327375d144d3108ce1b7a0157d225" : "e5cf40901e80897319f9a9daea0c9982fa604294";
    throw Error("UNPLANNED_QUERY");
  }, health: async (p: any, signal: AbortSignal) => { assert(!signal.aborted); return { pid: sockets[control].pid, entry: root + "/candidate/dist/daemon.js", version: "0.4.101", nativeSocket: native }; },
    rpc: async (path: string, method: string, params: any, bounds: any) => { assert.equal(path, native); assert(!bounds.signal.aborted); calls.push({ method, params }); return structuredClone(replies[method]); } };
  const plan: any = { scratch: { path: root }, runtime, composition: { transport: "private-daemon-v1", topologyPeer: { socket: { path: control }, nativeSocket: { path: native } } } };
  return { plan, io, files, sockets, replies, queries, calls, control, native, workspace, surface };
}
it("produces independent private PID/product/socket epoch and minimal fresh all-window topology", async () => {
  const f = transportFixture(), source = createHostTopology(f.plan, f.io), peer = await source.observePeer(), raw = await source.readTopology();
  assert.equal(peer.process.pid, 78); assert.equal(peer.process.entry, root + "/candidate/dist/daemon.js"); assert.equal(peer.product.version, "0.4.101");
  assert.equal(peer.product.manifest, digest(f.files.get(root + "/candidate/dist-manifest.json")));
  assert.equal(raw.epoch, `cmux:${f.native}#socket=1:60001:1:2@static`); assert.deepEqual(raw.workspaces, [{ uuid: f.workspace }]);
  assert.deepEqual(raw.surfaces, [{ uuid: f.surface, workspace: f.workspace }]); assert.deepEqual(raw.focus, { workspace: f.workspace, surface: f.surface });
  assert.deepEqual(f.calls.map(r => r.method), ["window.list", "workspace.list", "surface.list", "system.identify"]);
  assert(f.queries.every(row => row.cmd !== "/bin/ps" || row.args[0] === "-p"));
}, 10000);
const faults: Record<string, (f: ReturnType<typeof transportFixture>) => void> = {
  "PID": f => { f.sockets[f.control].pid = 1; }, "UID": f => { f.sockets[f.native].uid = 502; },
  "Node": f => { f.io.runtimeIdentity = () => ({ node, sha256: "0".repeat(64) }); },
  "dist": f => { f.files.set(f.plan.scratch.path + "/candidate/dist/index.js", Buffer.from("foreign")); },
  "serving health": f => { f.io.health = async () => ({ pid: 90 }); },
  "health rejection": f => { f.io.health = async () => { throw Error("HEALTH_REJECTED"); }; },
  "transport rejection": f => { f.io.rpc = async () => { throw Error("RPC_REJECTED"); }; },
  "incomplete": f => { f.replies["workspace.list"] = {}; }, "non UUID": f => { delete f.replies["surface.list"].surfaces[0].id; },
  "foreign relationship": f => { f.replies["surface.list"].surfaces[0].workspace_ref = "workspace:foreign"; },
  "missing relationship": f => { delete f.replies["surface.list"].surfaces[0].workspace_ref; },
  "focus unknown": f => { f.replies["system.identify"].focused.surface_ref = "surface:foreign"; },
  "focus unavailable": f => { f.replies["system.identify"] = {}; },
  "inode during read": f => { const call = f.io.rpc; f.io.rpc = async (...args: any[]) => { const reply = await call(...args); f.sockets[f.native].ino++; return reply; }; },
  "PID during health": f => { const call = f.io.health; f.io.health = async (...args: any[]) => { const reply = await call(...args); f.sockets[f.control].pid++; return reply; }; },
};
it.each(Object.entries(faults))("rejects %s independent evidence without fallback", async (_name, change) => {
  const f = transportFixture(); change(f); await assert.rejects(createHostTopology(f.plan, f.io).readTopology());
});
it("awaits real asynchronous replies, distinguishes empty/null and aborts missing replies", async () => {
  const f = transportFixture(); f.replies["window.list"] = { windows: [] }; f.replies["system.identify"] = { focused: { workspace_ref: null, surface_ref: null } };
  const call = f.io.rpc; f.io.rpc = async (...args: any[]) => { await Promise.resolve(); return call(...args); };
  assert.deepEqual((await createHostTopology(f.plan, f.io).readTopology()).focus, { workspace: null, surface: null });
  let aborted = false; f.io.rpc = (_p: string, _m: string, _a: any, bounds: any) => new Promise(() => bounds.signal.addEventListener("abort", () => { aborted = true; }));
  await assert.rejects(createHostTopology(f.plan, f.io).readTopology(), /deadline/); assert(aborted);
}, 10000);
