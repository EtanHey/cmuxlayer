import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { privateBuild, distDigest } from "../scripts/xmac/target.mjs";
import { reviewedConfigDigest } from "../scripts/xmac/account-observer-bridge.mjs";
import { requiredRunnerFiles, rows, runNative } from "../scripts/xmac/m1-ratchet.mjs";
const root = "/private/tmp/cmux-xmac-replay-fixture", run = "a".repeat(32);
const cfg = () => ({ nativeApproved: true, accountContract: "dedicated-test-502-v1", accountObserverContract: "protected-ssh-mirror-v1", runnerSha: "5".repeat(40), driverRoot: root,
  fixtureConfigPath: root + "/reviewed-config.json", runnerFiles: Object.fromEntries(requiredRunnerFiles.map(p => [p, createHash("sha256").update(readFileSync(p)).digest("hex")])),
  products: Object.fromEntries(rows.map(row => [row.name, Object.fromEntries(["baseline", "candidate"].map(side => [side, { root: root + "-" + row.fixture + "-" + side, sha: side === "baseline" ? row.bug : row.fix, distDigest: "b".repeat(64) }]))])) });
async function attempt(fault = "") {
  const expected = cfg(), remote: any = structuredClone(expected), effects: string[] = [];
  if (fault === "stale-config") remote.runnerSha = "6c62b0ee0cc9f19c3a190b2e5c35e0e00df84350";
  if (fault === "config-product") remote.products.spawn_contract_once.candidate.distDigest = "0".repeat(64);
  if (fault === "config-source") remote.runnerFiles[requiredRunnerFiles[0]] = "0".repeat(64);
  const stat = (path: string) => ({ uid: 502, mode: path === root ? 0o700 : fault === "config-permissions" && path.endsWith("reviewed-config.json") ? 0o644 : 0o600,
    isDirectory: () => path === root, isFile: () => path !== root });
  const io = { crypto: { createHash }, uid: fault === "principal" ? 501 : 502, os: { tmpdir: () => "/private/tmp" }, fs: { lstatSync: stat,
    realpathSync: (path: string) => fault === "alias" && path.endsWith("reviewed-config.json") ? "/foreign" : path,
    readFileSync: (path: string) => path.endsWith("reviewed-config.json") ? JSON.stringify(remote) :
      fault === "stale-source" && path.endsWith("app-admission.mjs") ? Buffer.from("stale") : readFileSync(path.slice(root.length + 1)) },
    load: async (path: string) => {
      effects.push(path.endsWith("target.mjs") ? "target-import" : path.endsWith("m1-ratchet.mjs") ? "native-import" : "bridge-import");
      if (path.endsWith("target.mjs")) return { privateBuild: (path: string, sha: string) => {
        effects.push("build-check"); if (fault === "product-marker" && path !== root || fault === "runner-marker" && path === root) throw Error("private replay SHA mismatch");
        return { root: fault === "product-alias" && path !== root ? "/foreign" : path, sha };
      }, distDigest: () => fault === "product-bytes" ? "0".repeat(64) : "b".repeat(64) };
      if (path.endsWith("m1-ratchet.mjs")) return { runNative: async (cfg: any, options: any) => {
        effects.push("native-entry"); expect(cfg).toEqual(expected); expect(options.controllerBinding).toEqual({ run, configDigest: reviewedConfigDigest(expected) });
        expect(typeof options.protectedObserver).toBe("function"); return { status: "PASS" };
      } };
      return { createFixtureObserver: (id: string) => { expect(id).toBe(run); return () => {}; } };
    }, finish: () => effects.push("finished") };
  // Execute exactly the self-contained body that SSH receives; no hidden module closure.
  const source = readFileSync("scripts/xmac/account-observer-bridge.mjs", "utf8");
  const body = source.slice(source.indexOf("export async function admitReviewedFixture"), source.indexOf("export const checkpointSummary")).replace("export ", "");
  const bootstrap = (0, eval)("(" + body + ")");
  return { effects, result: bootstrap(expected, fault === "run" ? "foreign" : run, io) };
}
it.each(["stale-config", "config-product", "config-source", "stale-source", "config-permissions", "alias", "principal", "run"])("refuses %s before any fixture source import", async fault => {
  const message = ["principal", "run"].includes(fault) ? "fixture principal/run mismatch" : ["config-permissions", "alias"].includes(fault) ? "unsafe fixture config" : fault === "stale-source" ? "controller fixture source mismatch" : "controller fixture config mismatch";
  const a = await attempt(fault); await expect(a.result).rejects.toThrow(message); expect(a.effects).toEqual([]);
});
it.each(["runner-marker", "product-marker", "product-bytes", "product-alias"])("refuses %s before native module/entry", async fault => {
  const a = await attempt(fault); await expect(a.result).rejects.toThrow(fault.endsWith("marker") ? "private replay SHA mismatch" : "controller fixture product mismatch"); expect(a.effects).not.toContain("native-import"); expect(a.effects).not.toContain("native-entry");
});
it("enters only after all source and seven build identities/six product digests pass", async () => {
  const a = await attempt(); await expect(a.result).resolves.toEqual({ status: "PASS" });
  expect(a.effects.filter(p => p === "build-check")).toHaveLength(7);
  expect(a.effects.slice(-4)).toEqual(["native-import", "bridge-import", "native-entry", "finished"]);
});
it("rejects unbound direct native entry before host/account inspection", async () => {
  await expect(runNative(cfg(), { protectedObserver: () => { throw Error("must not observe"); } })).rejects.toThrow("reviewed controller binding required");
});
it("config digest is key-order independent and binds every setting", () => {
  const a = cfg(), b = Object.fromEntries(Object.entries(a).reverse()); expect(reviewedConfigDigest(a)).toBe(reviewedConfigDigest(b));
  expect(reviewedConfigDigest({ ...a, options: { humanSessionQuitApproved: true } })).not.toBe(reviewedConfigDigest(a));
});
it("consumes the node-e run argument before actual runner imports inspect argv", () => {
  const bridge = new URL("../scripts/xmac/account-observer-bridge.mjs", import.meta.url).href, native = new URL("../scripts/xmac/m1-ratchet.mjs", import.meta.url).href;
  const source = readFileSync("scripts/xmac/account-observer-bridge.mjs", "utf8"); expect(source).toContain("const run=process.argv.pop(); await");
  const code = `const run=process.argv.pop(); await import(${JSON.stringify(bridge)}); await import(${JSON.stringify(native)}); process.stdout.write(run);`;
  expect(execFileSync(process.execPath, ["--input-type=module", "-e", code, run], { encoding: "utf8", timeout: 10000 })).toBe(run);
});
it.each(["healthy", "bytes", "marker"])("uses actual build/digest bodies on local synthetic products (%s)", async fault => {
  const scratch = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "cmux-xmac-replay-a3-"))), expected: any = cfg();
  expected.driverRoot = scratch; expected.fixtureConfigPath = scratch + "/reviewed-config.json";
  const build = (path: string, sha: string) => {
    fs.mkdirSync(path, { recursive: true, mode: 0o700 }); fs.mkdirSync(path + "/dist", { mode: 0o700 });
    fs.writeFileSync(path + "/dist/index.js", "// synthetic index\n"); fs.writeFileSync(path + "/dist/daemon.js", "// synthetic daemon\n");
    fs.writeFileSync(path + "/xmac-build.json", JSON.stringify({ sha }));
  };
  let entered = false;
  try {
    build(scratch, expected.runnerSha);
    for (const [file, hash] of Object.entries(expected.runnerFiles)) {
      const path = scratch + "/" + file; fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); fs.writeFileSync(path, readFileSync(file));
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(hash);
    }
    for (const row of rows) for (const side of ["baseline", "candidate"]) {
      const product = expected.products[row.name][side]; product.root = scratch + "/cmux-xmac-replay-" + row.fixture + "-" + side;
      build(product.root, product.sha); product.distDigest = distDigest(product.root + "/dist");
    }
    fs.writeFileSync(expected.fixtureConfigPath, JSON.stringify(expected), { mode: 0o600 });
    const product = expected.products.spawn_contract_once.candidate;
    if (fault === "bytes") fs.appendFileSync(product.root + "/dist/index.js", "// drift\n");
    if (fault === "marker") fs.writeFileSync(product.root + "/xmac-build.json", JSON.stringify({ sha: "0".repeat(40) }));
    const body = readFileSync("scripts/xmac/account-observer-bridge.mjs", "utf8").split("export async function admitReviewedFixture")[1].split("export const checkpointSummary")[0];
    const bootstrap = (0, eval)("(async function admitReviewedFixture" + body + ")");
    const result = bootstrap(expected, run, { crypto: { createHash }, os, uid: 502,
      fs: { ...fs, lstatSync: (path: string) => Object.assign(fs.lstatSync(path), { uid: 502 }) },
      load: async (path: string) => path.endsWith("target.mjs") ? { privateBuild, distDigest } : path.endsWith("m1-ratchet.mjs") ?
        { runNative: async () => { entered = true; return { status: "PASS" }; } } : { createFixtureObserver: () => () => {} }, finish: () => {} });
    if (fault === "healthy") { await expect(result).resolves.toEqual({ status: "PASS" }); expect(entered).toBe(true); }
    else { await expect(result).rejects.toThrow(fault === "bytes" ? "controller fixture product mismatch" : "private replay SHA mismatch"); expect(entered).toBe(false); }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
