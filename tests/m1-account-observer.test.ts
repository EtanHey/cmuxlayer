import { expect, it } from "vitest";
import * as original from "../scripts/xmac/dedicated-account.mjs";
const modulePath = process.env.M1_ACCOUNT_OBSERVER_UNDER_TEST ?? new URL("../scripts/xmac/account-observer.mjs", import.meta.url).href;
const api: any = await import(modulePath).catch(() => ({}));
const guardApi: any = process.env.M1_MIRROR_GUARD_UNDER_TEST ? await import(process.env.M1_MIRROR_GUARD_UNDER_TEST) : original;
const binding = { fixture: { username: "test", uid: 502, home: "/Users/test", source: "os.userInfo" },
  production: { username: "happycampr", uid: 501, home: "/Users/happycampr", source: "dscl", dev: 1, ino: 2 }, processUid: 502, consoleUid: 502, aqua: true, admin: false };
const mirror = () => ({ path: "/tmp/cmux-last-socket-path", canonical: "/private/tmp/cmux-last-socket-path",
  kind: "file", uid: 501, gid: 0, mode: 0o644, nlink: 1, flags: 0, dev: 1, ino: 8, size: 27, hash: "a".repeat(64), mtimeMs: 1, ctimeMs: 1,
  aclEmpty: true, writableToFixture: false, parent: { path: "/private/tmp", kind: "directory", uid: 0, mode: 0o1777, aclEmpty: true, dev: 1, ino: 7 },
  ancestor: { path: "/private", kind: "directory", uid: 0, mode: 0o755, aclEmpty: true, dev: 1, ino: 6 } });
const state = () => ({ fixture: {}, production: {}, processes: ["501 77 exact-start /app"], mirror: mirror() });
const challenge = () => ({ run: "a".repeat(32), nonce: "b".repeat(32), sequence: 1, phase: "before-runtime", identifiers: [], agentIds: [] });
const receipt = () => ({ ...challenge(), capturedAt: 1000, identity: { username: "happycampr", uid: 501, processUid: 501,
  home: "/Users/happycampr", dev: 1, ino: 2, source: "os.userInfo+dscl", host: "Locals-MacBook-Pro.local" }, roots: original.stateRoots?.("/Users/happycampr"),
  production: {}, processes: [], mirror: mirror(), append: { reads: [], violations: [] } });
it("permits only the preserved protected mirror with two valid fixture-local markers", () => {
  const before: any = state(), after: any = state();
  for (const p of original.fixtureMarkers.slice(0, 2)) after.fixture[p] = { kind: "file", uid: 502, mode: 0o600, nlink: 1, value: "/tmp/cmux-soak-stable.sock\n" };
  expect(() => guardApi.verifyDedicatedState(binding, before, after, { requireMarkers: true, protectedMirror: true })).not.toThrow();
  delete after.fixture[original.fixtureMarkers[0]];
  expect(() => guardApi.verifyDedicatedState(binding, before, after, { requireMarkers: true, protectedMirror: true })).toThrow();
});
it.each(["writable", "owner", "acl", "symlink", "links", "sticky", "parent-owner", "flags", "canonical"])("rejects unsafe foreign mirror %s", fault => {
  const s: any = mirror();
  if (fault === "writable") s.writableToFixture = true;
  if (fault === "owner") s.uid = 502;
  if (fault === "acl") s.aclEmpty = false;
  if (fault === "symlink") s.kind = "symlink";
  if (fault === "links") s.nlink = 2;
  if (fault === "sticky") s.parent.mode = 0o777;
  if (fault === "parent-owner") s.parent.uid = 502;
  if (fault === "flags") s.flags = 1;
  if (fault === "canonical") s.canonical = "/foreign/file";
  expect(() => guardApi.validateProtectedMirror(s)).toThrow("protected mirror");
});
it.each(["hash", "ino", "mode", "disappearance"])("rejects protected mirror %s drift", fault => {
  const before: any = state(), after: any = state();
  if (fault === "disappearance") delete after.mirror; else after.mirror[fault] = fault === "hash" ? "b".repeat(64) : 1;
  expect(() => guardApi.verifyDedicatedState(binding, before, after, { protectedMirror: true })).toThrow();
});
it("accepts only a fresh receipt bound to the exact live run request", () => expect(() => api.validateObserverReceipt(receipt(), challenge(), 1001)).not.toThrow());
it.each(["run", "nonce", "sequence", "phase", "stale", "future", "uid", "home", "host", "scope", "content", "unreachable"])("rejects observer %s", fault => {
  const r: any = receipt();
  if (["run", "nonce", "sequence", "phase"].includes(fault)) r[fault] = "foreign";
  if (fault === "stale") r.capturedAt = 0;
  if (fault === "future") r.capturedAt = 20000;
  if (["uid", "home", "host"].includes(fault)) r.identity[fault] = "foreign";
  if (fault === "scope") r.roots = [];
  if (fault === "content") r.production["/Users/happycampr/.local/state/cmux/log"] = { value: "PRIVATE" };
  if (fault === "unreachable") r.error = "SSH unavailable";
  expect(() => api.validateObserverReceipt(r, challenge(), fault === "stale" ? 15000 : 1001)).toThrow("observer");
});
it("retains remote append coverage without exporting pointer or log contents", () => {
  let change = false; const seen: any[] = [];
  const collect = api.createProtectedCollector({ identity: () => receipt().identity, readState: () => ({}), processCapture: () => [],
    mirrorCapture: mirror, legacySnapshot: () => ({ private: "NOT_EXPORTED" }), compareLegacy: (_a: any, _b: any, ids: any, agents: any, reads: any) => {
      seen.push([ids, agents]); reads.push({ path: "log", start: 0, end: 1 }); return change ? ["log"] : [];
    }, clock: () => 1000 });
  const first = collect({ ...challenge(), identifiers: ["TOKEN"], agentIds: ["agent"] });
  expect(JSON.stringify(first)).not.toContain("NOT_EXPORTED"); expect(seen[0]).toEqual([["/tmp/cmux-soak-stable.sock", "TOKEN"], ["agent"]]);
  change = true; expect(collect({ ...challenge(), sequence: 2 }).append.violations).toEqual(["log"]);
});
it.each(["production", "process", "identity", "write-grant", "unreachable"])("keeps remote %s failure fatal across checkpoints", fault => {
  let bad = false; let count = 0;
  const guard = original.createDedicatedAccountGuard({ observe: () => binding, fixtureCapture: () => ({}), mirrorAccess: () => fault === "write-grant" && bad,
    statPath: () => { throw Object.assign(Error("absent"), { code: "ENOENT" }); }, protectedObserver: () => {
      count++; if (bad && fault === "unreachable") throw Error("observer unreachable");
      const r: any = receipt();
      if (bad && fault === "production") r.production["/Users/happycampr/.local/state/cmux/log"] = { hash: "changed" };
      if (bad && fault === "process") r.processes = ["501 new-start /app"];
      if (bad && fault === "identity") r.identity.ino = 99;
      return r;
    } });
  guard.check(); expect(count).toBe(2); bad = true;
  expect(() => guard.check()).toThrow(); expect(guard.result().status).toBe("FAIL");
});
