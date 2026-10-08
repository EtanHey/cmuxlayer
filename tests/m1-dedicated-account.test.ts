import { expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionChanges } from "../scripts/xmac/production-guard.mjs";
const path = process.env.M1_DEDICATED_ACCOUNT_UNDER_TEST ? new URL(process.env.M1_DEDICATED_ACCOUNT_UNDER_TEST) : new URL("../scripts/xmac/dedicated-account.mjs", import.meta.url);
// Parent RED adapters expose the old policy: matching process UID is sufficient,
// and any run marker in the real account is forbidden. No native default runs.
const api: any = existsSync(path) ? await import(path.href) : {
  validateDedicatedIdentity: (s: any) => { if (s.fixture.uid !== s.processUid) throw Error("identity invalid"); },
  verifyDedicatedState: (_binding: any, before: any, after: any) => {
    const convert = (s: any) => ({ home: "/synthetic", files: {}, agents: [], socket_pointers: {
      ".local/state/cmux/last-socket-path": s.fixture["/Users/test/.local/state/cmux/last-socket-path"]?.value } });
    if (productionChanges(convert(before), convert(after), ["/tmp/cmux-soak-stable.sock"], []).length) throw Error("legacy account marker violation");
  },
};
const noSocket = () => { throw Object.assign(new Error("synthetic absent"), { code: "ENOENT" }); };
const identity = () => ({ fixture: { username: "test", uid: 502, home: "/Users/test", source: "os.userInfo", dev: 1, ino: 2 },
  production: { username: "happycampr", uid: 501, home: "/Users/happycampr", source: "dscl", dev: 1, ino: 3 },
  processUid: 502, consoleUid: 502, aqua: true, admin: false });
const markers = ["/Users/test/.local/state/cmux/last-socket-path", "/Users/test/Library/Application Support/cmux/last-socket-path", "/tmp/cmux-last-socket-path"];
const file = (value = "/tmp/cmux-soak-stable.sock\n") => ({ kind: "file", uid: 502, mode: 0o600, nlink: 1, value, hash: "synthetic", dev: 1, ino: 4 });
const state = () => ({ fixture: {} as any, production: {} as any, processes: ["501 77 exact-start /Applications/cmux.app/Contents/MacOS/cmux"] });
it("accepts only actual test identity plus its console and Aqua bootstrap", () => expect(() => api.validateDedicatedIdentity(identity())).not.toThrow());
it.each(["username", "uid", "home", "source"])("rejects wrong fixture %s despite matching private HOME/process UID", key => {
  const s: any = identity(); s.fixture[key] = key === "uid" ? 501 : key === "home" ? "/Users/happycampr" : "foreign";
  if (key === "uid") s.processUid = 501;
  expect(() => api.validateDedicatedIdentity(s)).toThrow();
});
it.each(["consoleUid", "aqua", "admin", "processUid"])("rejects absent or wrong actual %s proof", key => {
  const s: any = identity(); s[key] = key === "consoleUid" ? 501 : key === "processUid" ? 0 : key === "admin";
  expect(() => api.validateDedicatedIdentity(s)).toThrow();
});
it.each(["uid", "home", "username"])("rejects changed protected production %s", key => {
  const s: any = identity(); s.production[key] = key === "uid" ? 502 : "foreign";
  expect(() => api.validateDedicatedIdentity(s)).toThrow();
});
it("permits exact fixture-owned current, legacy and tmp marker writes and matching removal", () => {
  const before = state(), during = state(); for (const p of markers) during.fixture[p] = file();
  expect(() => api.verifyDedicatedState(identity(), before, during)).not.toThrow();
  expect(() => api.verifyDedicatedState(identity(), during, before)).not.toThrow();
});
it.each(["content", "owner", "type", "links", "path"])("rejects unsafe fixture marker %s", fault => {
  const before = state(), after = state(); after.fixture[markers[0]] = file();
  if (fault === "content") after.fixture[markers[0]].value = "/tmp/cmux.sock\n";
  if (fault === "owner") after.fixture[markers[0]].uid = 501;
  if (fault === "type") after.fixture[markers[0]].kind = "symlink";
  if (fault === "links") after.fixture[markers[0]].nlink = 2;
  if (fault === "path") { delete after.fixture[markers[0]]; after.fixture["/Users/happycampr/.local/state/cmux/last-socket-path"] = file(); }
  expect(() => api.verifyDedicatedState(identity(), before, after)).toThrow();
});
it("refuses an unchanged production-owned global marker before launch", () => {
  const before = state(); before.fixture[markers[2]] = { ...file(), uid: 501 };
  expect(() => api.verifyDedicatedState(identity(), before, structuredClone(before))).toThrow();
});
it.each(["marker", "defaults", "agents", "log", "process"])("rejects protected production %s change", name => {
  const before = state(), after = state();
  if (name === "process") after.processes = [];
  else after.production[`/Users/happycampr/${name}`] = file("unrelated-write-without-run-token");
  expect(() => api.verifyDedicatedState(identity(), before, after)).toThrow();
});
it("rejects unexpected fixture state without a run token", () => {
  const after = state(); after.fixture["/Users/test/.local/state/cmux/unexpected"] = file("unrelated");
  expect(() => api.verifyDedicatedState(identity(), state(), after)).toThrow();
});
it("requires all three valid markers at socket-ready admission", () => {
  expect(() => api.verifyDedicatedState(identity(), state(), state(), { requireMarkers: true })).toThrow();
});
it("captures real private files without retaining non-marker text and rejects symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "m1-account-state-"));
  try {
    mkdirSync(join(root, "state")); writeFileSync(join(root, "state/log"), "DO_NOT_RETAIN");
    expect(typeof api.readStatePaths).toBe("function");
    const captured = api.readStatePaths([join(root, "state")]);
    expect(captured[join(root, "state/log")].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(captured)).not.toContain("DO_NOT_RETAIN");
    symlinkSync(join(root, "state/log"), join(root, "state/redirect"));
    expect(() => api.readStatePaths([join(root, "state")])).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps before/during/after guards active and records a later protected write as FAIL", () => {
  let current = state();
  const guard = api.createDedicatedAccountGuard({ statPath: noSocket, observe: identity, capture: () => structuredClone(current) });
  guard.check(); expect(guard.result().checks).toBe(1);
  current.production["/Users/happycampr/Library/Preferences/com.cmuxterm.app.plist"] = file("changed");
  expect(() => guard.check()).toThrow("protected production");
  expect(guard.result()).toMatchObject({ status: "FAIL" });
  expect(guard.result().after.production).toEqual(current.production);
});
it("rechecks identity between checkpoints and refuses changed UID before process inspection", () => {
  let current = identity(); let calls = 0;
  const guard = api.createDedicatedAccountGuard({ statPath: noSocket, observe: () => current, capture: state, processQuery: () => { calls++; throw Error("forbidden"); } });
  current = { ...current, processUid: 501 };
  expect(() => guard.check({ receipt: { app_process: { pid: 99 } } })).toThrow("identity changed");
  expect(calls).toBe(0); expect(guard.result().status).toBe("FAIL");
});
it("requires fixture process UID and the recorded start identity before admission", () => {
  const saved = "77 exact-start /Applications/cmux.app/Contents/MacOS/cmux";
  const make = (uid: string, observed: string) => api.createDedicatedAccountGuard({ statPath: noSocket, observe: identity, capture: state,
    processQuery: (_cmd: string, args: string[]) => args.at(-1) === "uid=" ? uid : observed });
  expect(() => make("501", saved).check({ receipt: { app_process: { pid: 77, saved } } })).toThrow("UID/identity changed");
  expect(() => make("502", "77 changed").check({ receipt: { app_process: { pid: 77, saved } } })).toThrow("UID/identity changed");
  expect(() => make("502", saved).check({ receipt: { app_process: { pid: 77, saved } } })).not.toThrow();
});
it("native fixture entry refuses a missing contract, quit approval, and failed account check before native defaults", async () => {
  const { startSoakRuntime } = await import("../scripts/soak-runtime.mjs");
  await expect(startSoakRuntime({ target: "m1-gate", fixtureMode: true }, "/never-created")).rejects.toThrow("dedicated fixture account admission");
  await expect(startSoakRuntime({ target: "m1-gate", fixtureMode: true, accountContract: "dedicated-test-502-v1", assertAccount: () => {}, humanSessionQuitApproved: "77:exact" }, "/never-created")).rejects.toThrow("dedicated fixture account admission");
  const primary = new Error("synthetic wrong identity");
  await expect(startSoakRuntime({ target: "m1-gate", fixtureMode: true, accountContract: "dedicated-test-502-v1", assertAccount: () => { throw primary; } }, "/never-created")).rejects.toBe(primary);
});
it.each(["owner", "type", "pid"])("rejects fixture socket %s mismatch using private injected observations", fault => {
  const saved = "77 exact-start /Applications/cmux.app/Contents/MacOS/cmux";
  const guard = api.createDedicatedAccountGuard({ observe: identity, capture: state,
    statPath: () => ({ uid: fault === "owner" ? 501 : 502, isSocket: () => fault !== "type" }),
    processQuery: (cmd: string, args: string[]) => cmd.includes("lsof") ?
      `p${fault === "pid" ? 88 : 77}\nn/tmp/cmux-soak-stable.sock` : args.at(-1) === "uid=" ? "502" : saved });
    if (fault === "pid") expect(() => guard.check({ receipt: { app_process: { pid: 77, saved } } })).toThrow("PID ownership unverified");
    else expect(() => guard.check()).toThrow("socket owner/type invalid");
});
it("cleanup refuses production UID before signalling even a matching recorded process", async () => {
  const { stopOwnedProcess } = await import("../scripts/soak-runtime.mjs"); const signals: any[] = [];
  await expect(stopOwnedProcess({ pid: 77, saved: "synthetic", runReceipt: { fixture_account_uid: 502 } }, [],
    () => "synthetic", (...args: any[]) => signals.push(args), async () => {}, () => [], () => "501")).rejects.toThrow("non-fixture UID");
  expect(signals).toEqual([]);
});
