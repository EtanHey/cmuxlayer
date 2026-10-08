import { expect, it } from "vitest";
import { happycamprContract, happycamprPlanDigest, validateHappycamprPlan, verifyHappycamprEffects, planHappycamprCleanup } from "../scripts/xmac/happycampr-effects.mjs";
const hash = "a".repeat(64), root = "/Users/happycampr/Library/Caches/cmuxlayer-native-Abc123", workspace = "b".repeat(8) + "-bbbb-bbbb-bbbb-" + "b".repeat(12), surface = workspace.replaceAll("b", "c");
function fixture() {
  const identity = { username: "happycampr", uid: 501, processUid: 501, consoleUid: 501, home: "/Users/happycampr", source: "os.userInfo+dscl", host: "Locals-MacBook-Pro.local", aqua: true, dev: 1, ino: 2 };
  const path = (kind: string, id: string) => ({ kind, canonical: id, uid: 501, dev: 1, ino: 8, mode: 0o600, nlink: 1, hash });
  const marker = "/private/tmp/cmux-last-socket-path", key = "setting:com.cmuxterm.app:socketMode";
  const plan: any = { contract: happycamprContract, run: "a".repeat(32), products: ["report", "spawn", "focus"], identity, observerEpoch: "epoch1", scratch: { path: root, canonical: root, uid: 501, mode: 0o700, dev: 1, ino: 3 },
    runtime: { node: "/opt/homebrew/Cellar/node/26.10.0_2/bin/node", sha256: "832eaf52cafa7ff1364c2ca378451db14fb043d8d23a5cfd18a0a103d66226fc" },
    binding: { source: "5".repeat(40), observer: hash, config: "", product: { head: "d539fbefc75327375d144d3108ce1b7a0157d225", tree: "e5cf40901e80897319f9a9daea0c9982fa604294", version: "0.4.101", manifest: "b06ffeb7b29ae1933b385e54f6ac08f365080744ceb69b063608d38a0a5b9c4f", buildIdentity: "71b55eac8766278d5d6390d05d29d7f14d5895df03654d5ccd74bef6e02248b7" } }, effects: [
      { id: root + "/state", kind: "directory", before: null, owned: { ...path("directory", root + "/state"), mode: 0o700 } },
      { id: root + "/state/receipt", kind: "file", before: null, owned: path("file", root + "/state/receipt") },
      { id: "pid:77", kind: "process", before: null, owned: { kind: "process", uid: 501, pid: 77, start: "exact-start", executable: "/opt/homebrew/Cellar/node/26.10.0_2/bin/node", entry: root + "/candidate/dist/index.js", distManifest: "b06ffeb7b29ae1933b385e54f6ac08f365080744ceb69b063608d38a0a5b9c4f" } },
      { id: root + "/d.sock", kind: "socket", before: null, owned: { ...path("socket", root + "/d.sock"), pid: 77, start: "exact-start" } },
      { id: "workspace:" + workspace, kind: "workspace", before: null, owned: { kind: "workspace", uuid: workspace, observerEpoch: "epoch1" } },
      { id: "surface:" + surface, kind: "surface", before: null, owned: { kind: "surface", uuid: surface, workspace, observerEpoch: "epoch1" } },
      { id: marker, kind: "marker", before: path("marker", marker), owned: { ...path("marker", marker), hash: "b".repeat(64) } },
      { id: key, kind: "setting", before: { kind: "setting", domain: "com.cmuxterm.app", key: "socketMode", value: "old" }, owned: { kind: "setting", domain: "com.cmuxterm.app", key: "socketMode", value: "owned" } } ] };
  plan.binding.config = happycamprPlanDigest(plan); const expected = structuredClone(plan.binding);
  const resources = { "unrelated-focus": { uuid: "user-focus", draft: hash }, "auth/config/BrainLayer": { hash } };
  const before = { identity, binding: expected, observerEpoch: "epoch1", resources: { ...resources, ...Object.fromEntries(plan.effects.filter((e: any) => e.before).map((e: any) => [e.id, e.before])) } };
  const after = { ...before, resources: { ...resources, ...Object.fromEntries(plan.effects.map((e: any) => [e.id, e.owned])) } }; return { plan, expected, before, after };
}
it("allows only witnessed501 scratch/candidate PID+socket/new UUIDs/exact settings and known marker effects", () => {
  const f = fixture(); expect(verifyHappycamprEffects(f.plan, f.before, f.after, f.expected).status).toBe("PASS");
  const cleanup = planHappycamprCleanup(f.plan, f.before, f.after, f.expected); expect(cleanup.status).toBe("READY"); expect(cleanup.executes).toBe(false); expect(cleanup.actions).toHaveLength(8);
});
it.each(["identity", "source", "config", "product", "runner", "observer", "epoch", "missing-owned", "unknown-write", "protected-focus", "protected-auth"])("refuses %s effect/binding without a host operation", fault => {
  const f = fixture();
  if (fault === "identity") f.after.identity = { ...f.after.identity, uid: 502 };
  if (fault === "source") f.plan.binding.source = "6".repeat(40);
  if (fault === "config") f.plan.effects[7].owned.value = "unreviewed";
  if (fault === "product") f.plan.binding.product.head = "6".repeat(40);
  if (fault === "runner") f.plan.runtime.node = "/unreviewed/node";
  if (fault === "observer") f.after.binding = { ...f.after.binding, observer: "0".repeat(64) };
  if (fault === "epoch") f.after.observerEpoch = "recycled";
  if (fault === "missing-owned") delete f.after.resources[f.plan.effects[0].id];
  if (fault === "unknown-write") f.after.resources[root + "/foreign"] = { hash };
  if (fault === "protected-focus") f.after.resources["unrelated-focus"] = { uuid: "changed", draft: hash };
  if (fault === "protected-auth") f.after.resources["auth/config/BrainLayer"] = { hash: "changed" };
  expect(() => verifyHappycamprEffects(f.plan, f.before, f.after, f.expected)).toThrow();
});
it.each(["pid-reuse", "uuid-reuse", "marker-drift", "settings-drift", "inode-reuse", "missing-id", "unknown-entry"])("preserves ambiguous %s instead of planning unsafe cleanup", fault => {
  const f = fixture(), index = fault === "pid-reuse" ? 2 : fault === "uuid-reuse" ? 5 : fault === "marker-drift" ? 6 : fault === "settings-drift" ? 7 : 1, id = f.plan.effects[index].id;
  if (fault === "unknown-entry") f.after.resources[root + "/unexpected"] = { hash };
  else if (fault === "missing-id") delete f.after.resources[id];
  else f.after.resources[id] = { ...f.after.resources[id], [fault === "pid-reuse" ? "start" : fault === "uuid-reuse" ? "observerEpoch" : fault === "settings-drift" ? "value" : fault === "inode-reuse" ? "ino" : "hash"]: "foreign" };
  const c = planHappycamprCleanup(f.plan, f.before, f.after, f.expected); expect(c.status).toBe("PENDING"); expect(c.preserved).toContain(fault === "unknown-entry" ? root + "/unexpected" : id); expect(c.actions.some((a: any) => a.id === (fault === "unknown-entry" ? root + "/unexpected" : id))).toBe(false);
});
it.each(["path-traversal", "existing-workspace", "links", "foreign-owner", "socket-owner", "self-consistent-wrong-product"])("rejects reviewed but unsafe %s manifest shape", fault => {
  const f = fixture();
  if (fault === "path-traversal") Object.assign(f.plan.effects[1], { id: root + "/../auth", owned: { ...f.plan.effects[1].owned, canonical: root + "/../auth" } });
  if (fault === "existing-workspace") f.plan.effects[4].before = f.plan.effects[4].owned;
  if (fault === "links") f.plan.effects[1].owned.nlink = 2;
  if (fault === "foreign-owner") f.plan.effects[1].owned.uid = 502;
  if (fault === "socket-owner") f.plan.effects[3].owned.pid = 99;
  if (fault === "self-consistent-wrong-product") f.plan.binding.product.head = "6".repeat(40);
  f.plan.binding.config = happycamprPlanDigest(f.plan);
  expect(() => validateHappycamprPlan(f.plan, structuredClone(f.plan.binding))).toThrow();
});
