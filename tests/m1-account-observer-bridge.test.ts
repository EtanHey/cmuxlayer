import { expect, it } from "vitest";
import { stateRoots } from "../scripts/xmac/dedicated-account.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
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
it("rejects missing observer before account/native inspection", async () => {
  await expect(runNative(cfg())).rejects.toThrow("protected SSH observer callback required");
});
it.each([false, true])("routes fresh reverse requests through two fake SSH children (unreachable=%s)", async unavailable => {
  const principals: string[] = [];
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
      queueMicrotask(() => child.stdout.write(JSON.stringify({ observer: { run, sequence: 1, nonce: "b".repeat(32), phase: "baseline", identifiers: [], agentIds: [] } }) + "\n"));
      child.stdin.on("data", () => { child.stdout.write('{"status":"PASS"}\n'); child.stdout.end(); child.emit("exit", 0); });
    }
    return child;
  };
  const result = api.runAccountDriver(cfg(), { spawnProcess });
  if (unavailable) await expect(result).rejects.toThrow("observer unreachable"); else expect(await result).toEqual({ status: "PASS" });
  expect(principals).toEqual(["happycampr", "test"]);
});
