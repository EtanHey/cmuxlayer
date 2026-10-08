import { expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateObserverReceipt } from "../scripts/xmac/account-observer.mjs";
const { createProtectedCollector } = await import(process.env.M1_CONNECTED_OBSERVER_UNDER_TEST ?? new URL("../scripts/xmac/account-observer.mjs", import.meta.url).href);
import { runAccountDriver, checkpointSummary, reviewedConfigDigest } from "../scripts/xmac/account-observer-bridge.mjs";
import { rows, requiredRunnerFiles } from "../scripts/xmac/m1-ratchet.mjs";
import { actualLifecycleContexts } from "./helpers/m1-connected-lifecycle";
async function connected(fault = "") {
  const contexts = await actualLifecycleContexts(), ledger: any[] = [], seen: any[] = [];
  const cfg = { nativeApproved: true, accountContract: "dedicated-test-502-v1", accountObserverContract: "protected-ssh-mirror-v1", runnerSha: "5".repeat(40),
    driverRoot: "/private/fixture", observerRoot: "/private/observer", fixtureConfigPath: "/private/fixture/reviewed-config.json",
    runnerFiles: Object.fromEntries(requiredRunnerFiles.map(p => [p, createHash("sha256").update(readFileSync(p)).digest("hex")])),
    products: Object.fromEntries(rows.map(r => [r.name, { baseline: { sha: r.bug, distDigest: "a".repeat(64) }, candidate: { sha: r.fix, distDigest: "b".repeat(64) } }])) };
  const collect = createProtectedCollector({ identity: () => ({ username: "happycampr", uid: 501, processUid: 501, home: "/Users/happycampr", source: "os.userInfo+dscl", host: "Locals-MacBook-Pro.local" }),
    readState: () => ({}), processCapture: () => [], mirrorCapture: () => ({}), legacySnapshot: () => ({ private: "NEVER_EXPORT" }), compareLegacy: () => [] });
  const spawnProcess = (_cmd: string, args: string[]) => {
    const child: any = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
    if (args[args.indexOf("-l") + 1] === "happycampr") child.stdin.on("data", (bytes: Buffer) => {
      const message = JSON.parse(bytes.toString()), receipt: any = collect(message.args); seen.push(receipt);
      if (fault === "foreign-run") receipt.run = "f".repeat(32);
      if (seen.length === 3) {
        if (fault === "missing") delete receipt.identifiers;
        if (fault === "foreign") receipt.identifiers = ["foreign"];
        if (fault === "reordered") receipt.identifiers.reverse();
        if (fault === "agents") receipt.agentIds = ["foreign-agent"];
      }
      child.stdout.write(JSON.stringify({ id: message.id, result: receipt }) + "\n");
    });
    else {
      const run = /'([a-f0-9]{32})'$/.exec(args.at(-1)!)![1]; let index = 0, request: any;
      const next = () => {
        if (index < contexts.length && !(fault === "partial" && index)) { request = { ...contexts[index++], sequence: index, run, nonce: "b".repeat(32) }; child.stdout.write(JSON.stringify({ observer: request }) + "\n"); }
        else {
          child.stdout.write(JSON.stringify({ status: fault === "partial" ? "FAIL" : "PASS", error: fault === "partial" ? "primary fixture error" : undefined,
            observer_run: run, config_sha256: reviewedConfigDigest(cfg), observer_checkpoints: ledger, runner_sha: cfg.runnerSha, runner_files: cfg.runnerFiles,
            runner_sha256: cfg.runnerFiles["scripts/xmac/m1-ratchet.mjs"], account_home: { source: "os.userInfo", uid: 502, home: "/Users/test" },
            outputRoot: cfg.driverRoot + "/evidence/m1-ratchet-" + "a".repeat(36), production_guard: { status: "PASS" },
            rows: rows.map(r => ({ name: r.name, status: "PASS", ...Object.fromEntries(["baseline", "candidate"].map(s => [s, { sha: cfg.products[r.name][s].sha, dist_digest: cfg.products[r.name][s].distDigest, runner_sha: cfg.runnerSha }])) })) }) + "\n");
          child.stdout.end(); child.emit("exit", fault === "partial" ? 1 : 0);
        }
      };
      child.stdin.on("data", (bytes: Buffer) => { ledger.push(checkpointSummary(validateObserverReceipt(JSON.parse(bytes.toString()).observer, request))); queueMicrotask(next); }); queueMicrotask(next);
    }
    return child;
  };
  return { result: runAccountDriver(cfg, { spawnProcess }), contexts, ledger, seen };
}
it("A3-R1 actual protected producer supports all182 actual runtime callbacks through controller and fixture consumer", async () => {
  const c = await connected(); expect(c.contexts).toHaveLength(182); await expect(c.result).resolves.toMatchObject({ status: "PASS" }); expect(c.ledger).toHaveLength(182);
  expect(c.seen.every(p => Array.isArray(p.identifiers) && Array.isArray(p.agentIds))).toBe(true);
});
it.each(["missing", "foreign", "reordered", "agents", "foreign-run"])("actual connected producer refuses %s receipt scope", async fault => {
  const c = await connected(fault); await expect(c.result).rejects.toThrow("protected observer receipt invalid");
});
it("actual partial producer failure retains primary error and truthful partial provenance", async () => {
  const c = await connected("partial"); expect(await c.result).toMatchObject({ status: "FAIL", error: "primary fixture error", observer_checkpoints: [{ sequence: 1, phase: "baseline" }] });
});
