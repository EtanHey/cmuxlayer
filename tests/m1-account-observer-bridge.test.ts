import { expect, it } from "vitest";
import { stateRoots } from "../scripts/xmac/dedicated-account.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { admissionStages } from "../scripts/xmac/app-admission.mjs";
import { requiredRunnerFiles, rows, runNative } from "../scripts/xmac/m1-ratchet.mjs";
const api: any = await import("../scripts/xmac/account-observer-bridge.mjs").catch(() => ({}));
const run = "a".repeat(32);
function wire(fault = "") {
  let response = Buffer.alloc(0), calls = 0;
  const write = (_fd: number, bytes: Buffer) => {
    const request = JSON.parse(bytes.toString()).observer; calls++;
    const receipt: any = { ...request, capturedAt: 1000, identity: { username: "happycampr", uid: 501, processUid: 501,
      home: "/Users/happycampr", source: "os.userInfo+dscl", host: "Locals-MacBook-Pro.local" }, roots: stateRoots("/Users/happycampr"),
      production: {}, processes: [], mirror: {}, append: { reads: [], violations: [] } };
    if (fault === "replay") receipt.sequence = 0;
    if (fault === "foreign") receipt.nonce = "foreign";
    if (fault === "stale") receipt.capturedAt = 0;
    response = Buffer.from(fault === "noise" ? "not JSON\n" : JSON.stringify({ observer: receipt }) + "\n");
    if (fault === "large") response = Buffer.alloc(1024 * 1024 + 1, 65);
    return bytes.length;
  };
  const read = (_fd: number, bytes: Buffer) => {
    if (fault === "EOF") return 0;
    const count = Math.min(bytes.length, response.length); response.copy(bytes, 0, 0, count); response = response.subarray(count); return count;
  };
  return { observer: () => api.createFixtureObserver(run, { read, write, clock: () => fault === "stale" ? 15000 : 1001 }), calls: () => calls };
}
it("uses fresh requests across checkpoints without credentials or protected content", () => {
  const w = wire(), observer = w.observer();
  expect(observer({ phase: "baseline" }).sequence).toBe(1);
  expect(observer({ phase: "socket-ready", identifiers: ["TOKEN"] }).sequence).toBe(2);
  expect(w.calls()).toBe(2);
});
it.each(["replay", "foreign", "stale", "EOF", "noise", "large"])("refuses observer transport %s without using old data", fault => {
  expect(() => wire(fault).observer()({ phase: "checkpoint" })).toThrow();
});
it("pins explicit distinct SSH principals and reviewed source bootstrap", () => {
  const spec = api.observerCommand("/private/observer", Object.fromEntries(api.observerSourceFiles.map((p: string) => [p, "a".repeat(64)])), run);
  expect(spec.command).toBe("ssh"); expect(spec.args).toContain("happycampr"); expect(spec.args).toContain("-l");
  expect(spec.args.at(-1)).toContain("source hash mismatch");
  expect(() => api.observerCommand("relative", {}, run)).toThrow();
});
it("accepts actual camel-case admission phases and rejects replay before collection", () => {
  const request = { run, sequence: 1, nonce: "b".repeat(32), phase: "refreshAndQuit", identifiers: [], agentIds: [] };
  expect(() => api.validateObserverRequest(request, run, 1)).not.toThrow();
  expect(() => api.validateObserverRequest(request, run, 2)).toThrow("binding");
});
const cfg = () => ({ nativeApproved: true, accountContract: "dedicated-test-502-v1", accountObserverContract: "protected-ssh-mirror-v1", runnerSha: "a".repeat(40),
  driverRoot: "/private/fixture", observerRoot: "/private/observer", fixtureConfigPath: "/private/fixture/reviewed-config.json",
  runnerFiles: Object.fromEntries(requiredRunnerFiles.map((p: string) => [p, createHash("sha256").update(readFileSync(p)).digest("hex")])),
  products: Object.fromEntries(rows.map((r: any) => [r.name, { baseline: { sha: r.bug, distDigest: "a".repeat(64) }, candidate: { sha: r.fix, distDigest: "b".repeat(64) } }])) });
function lifecycle() {
  const points = [{ phase: "baseline", identifiers: [] as string[] }];
  for (const row of rows) for (const side of ["baseline", "candidate"]) {
    const identifiers = [`sample-${row.name}-${side}`];
    for (const phase of ["sample-start", "before-runtime", ...[...admissionStages, "refreshAndQuit", "launch"].flatMap(p => [p, p]), "app-started", "socket-ready", "runtime-ready", "sample-final"]) points.push({ phase, identifiers });
  }
  points.push({ phase: "run-final", identifiers: [] });
  return points.map((point, i) => ({ ...point, sequence: i + 1 }));
}
const completed = (config: any, run: string, observer_checkpoints: any[]) => ({ status: "PASS", runner_sha: config.runnerSha, runner_files: config.runnerFiles,
  runner_sha256: config.runnerFiles["scripts/xmac/m1-ratchet.mjs"], observer_run: run, config_sha256: api.reviewedConfigDigest(config), observer_checkpoints,
  account_home: { source: "os.userInfo", uid: 502, home: "/Users/test" }, production_guard: { status: "PASS" }, outputRoot: config.driverRoot + "/evidence/m1-ratchet-" + "a".repeat(36),
  rows: rows.map(row => ({ name: row.name, status: "PASS", ...Object.fromEntries(["baseline", "candidate"].map(side => [side, { sha: config.products[row.name][side].sha, dist_digest: config.products[row.name][side].distDigest, runner_sha: config.runnerSha }])) })) });
it("rejects missing observer before account/native inspection", async () => {
  await expect(runNative(cfg())).rejects.toThrow("protected SSH observer callback required");
});
it.each([false, true])("routes fresh reverse requests through two fake SSH children (unreachable=%s)", async unavailable => {
  const principals: string[] = [], config = cfg();
  const spawnProcess = (_cmd: string, args: string[]) => {
    const principal = args[args.indexOf("-l") + 1]; principals.push(principal);
    const child: any = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
    if (principal === "happycampr") child.stdin.on("data", (bytes: Buffer) => {
      const request = JSON.parse(bytes.toString());
      child.stdout.write(JSON.stringify(unavailable ? { id: request.id, error: "observer unreachable" } : { id: request.id, result: { ...request.args, capturedAt: Date.now(),
        identity: { username: "happycampr", uid: 501, processUid: 501, home: "/Users/happycampr", source: "os.userInfo+dscl", host: "Locals-MacBook-Pro.local" },
        roots: stateRoots("/Users/happycampr"), production: {}, processes: [], mirror: {}, append: { reads: [], violations: [] } } }) + "\n");
    });
    else {
      const run = /'([a-f0-9]{32})'$/.exec(args.at(-1)!)![1];
      const points = lifecycle(); let index = 0;
      const next = () => {
        if (index < points.length) child.stdout.write(JSON.stringify({ observer: { ...points[index++], run, nonce: "b".repeat(32), agentIds: [] } }) + "\n");
        else { child.stdout.write(JSON.stringify(completed(config, run, points)) + "\n"); child.stdout.end(); child.emit("exit", 0); }
      };
      queueMicrotask(next); child.stdin.on("data", () => queueMicrotask(next));
    }
    return child;
  };
  const result = api.runAccountDriver(config, { spawnProcess });
  if (unavailable) await expect(result).rejects.toThrow("observer unreachable"); else expect(await result).toMatchObject({ status: "PASS", observer_checkpoints: lifecycle() });
  expect(principals).toEqual(["happycampr", "test"]);
});
it.each(["runner", "config", "source", "product", "no-observations", "missing-stage-post", "missing-runtime", "wrong-scope", "reordered", "output", "foreign-run", "invented-observations"])("rejects completion fault %s", fault => {
  const config = cfg(), points = lifecycle(), result = completed(config, run, structuredClone(points));
  if (fault === "runner") result.runner_sha = "6".repeat(40);
  if (fault === "config") result.config_sha256 = "0".repeat(64);
  if (fault === "source") result.runner_files = {};
  if (fault === "product") result.rows[2].candidate.sha = "0".repeat(40);
  if (fault === "no-observations") points.length = 0;
  if (fault === "missing-stage-post") points.splice(4, 1);
  if (fault === "missing-runtime") points.splice(points.findIndex(p => p.phase === "runtime-ready"), 1);
  if (fault === "wrong-scope") points[2].identifiers = ["foreign"];
  if (fault === "reordered") [points[2], points[3]] = [points[3], points[2]];
  if (fault === "output") result.outputRoot = "/private/foreign";
  if (fault === "foreign-run") result.observer_run = "f".repeat(32);
  if (fault === "invented-observations") points.length = 1;
  if (fault !== "invented-observations") result.observer_checkpoints = structuredClone(points);
  expect(() => api.validateFixtureCompletion(result, config, run, points, rows.map(r => r.name), [...admissionStages, "refreshAndQuit", "launch"])).toThrow();
});
it("retains a provenance-bound FAIL without demanding successful runtime coverage", () => {
  const config = cfg(), points = [{ sequence: 1, phase: "baseline", identifiers: [] }];
  expect(() => api.validateFixtureCompletion({ ...completed(config, run, points), status: "FAIL", error: "primary" }, config, run, points, rows.map(r => r.name), admissionStages)).not.toThrow();
});
