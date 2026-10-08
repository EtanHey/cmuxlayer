// Controller bridges two explicit SSH accounts. Neither identity borrows the other's auth.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID, createHash } from "node:crypto";
import { hostname } from "node:os";
import { readSync, writeSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectProcess } from "./driver.mjs";
import { shellQuote } from "./target.mjs";
import { createProtectedCollector, validateObserverReceipt } from "./account-observer.mjs";
const NODE = "/opt/homebrew/opt/node/bin/node", limit = 1024 * 1024;
export const observerSourceFiles = ["scripts/xmac/account-observer-bridge.mjs", "scripts/xmac/account-observer.mjs",
  "scripts/xmac/dedicated-account.mjs", "scripts/xmac/production-guard.mjs", "scripts/xmac/driver.mjs", "scripts/xmac/target.mjs"];
const validRun = run => /^[a-f0-9]{32}$/.test(run);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const reviewedConfigDigest = cfg => createHash("sha256").update(canonical(cfg)).digest("hex");
// Serialized into the SSH command: only builtins load until ALL reviewed source bytes match.
// This is an observation/admission boundary, not same-UID adversarial atomicity.
export async function admitReviewedFixture(expected, run, io = {}) {
  const fs = io.fs ?? await import("node:fs"), crypto = io.crypto ?? await import("node:crypto"), os = io.os ?? await import("node:os");
  const uid = io.uid ?? process.getuid(), load = io.load ?? (path => import(path));
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  if (uid !== 502 || !/^[a-f0-9]{32}$/.test(run)) throw Error("fixture principal/run mismatch");
  const root = expected.driverRoot, stat = fs.lstatSync(root), path = expected.fixtureConfigPath;
  if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o077 || fs.realpathSync(root) !== root || !root.startsWith(fs.realpathSync(os.tmpdir()) + "/") || path !== root + "/reviewed-config.json") throw Error("fixture private root mismatch");
  const configStat = fs.lstatSync(path);
  if (!configStat.isFile() || configStat.uid !== uid || configStat.mode & 0o077 || fs.realpathSync(path) !== path) throw Error("unsafe fixture config");
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  if (canonical(cfg) !== canonical(expected)) throw Error("controller fixture config mismatch");
  for (const [file, hash] of Object.entries(expected.runnerFiles)) {
    const source = root + "/" + file;
    if (fs.realpathSync(source) !== source || !fs.lstatSync(source).isFile() || digest(fs.readFileSync(source)) !== hash) throw Error("controller fixture source mismatch");
  }
  const target = await load("file://" + root + "/scripts/xmac/target.mjs");
  if (target.privateBuild(root, expected.runnerSha).root !== root) throw Error("controller fixture runner root mismatch");
  for (const pair of Object.values(expected.products)) for (const product of Object.values(pair)) {
    const build = target.privateBuild(product.root, product.sha);
    if (build.root !== product.root || target.distDigest(build.root + "/dist") !== product.distDigest) throw Error("controller fixture product mismatch");
  }
  const native = await load("file://" + root + "/scripts/xmac/m1-ratchet.mjs"), bridge = await load("file://" + root + "/scripts/xmac/account-observer-bridge.mjs");
  const result = await native.runNative(cfg, { protectedObserver: bridge.createFixtureObserver(run), controllerBinding: { run, configDigest: digest(canonical(expected)) } });
  (io.finish ?? (result => { console.log(JSON.stringify(result)); process.exitCode = result.status === "PASS" ? 0 : 1; }))(result);
  return result;
}
export const checkpointSummary = receipt => ({ sequence: receipt.sequence, phase: receipt.phase, identifiers: receipt.identifiers });
export function validateFixtureCompletion(result, cfg, run, observations, rowNames, stages) {
  if (result.observer_run !== run || result.config_sha256 !== reviewedConfigDigest(cfg) || result.runner_sha !== cfg.runnerSha ||
      canonical(result.runner_files) !== canonical(cfg.runnerFiles) || canonical(result.observer_checkpoints) !== canonical(observations)) throw Error("fixture completion provenance mismatch");
  if (result.status !== "PASS") return;
  if (result.runner_sha256 !== cfg.runnerFiles["scripts/xmac/m1-ratchet.mjs"] || result.account_home?.source !== "os.userInfo" || result.account_home.uid !== 502 || result.account_home.home !== "/Users/test" ||
      !new RegExp("^" + cfg.driverRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/evidence/m1-ratchet-[a-f0-9-]{36}$").test(result.outputRoot) || result.production_guard?.status !== "PASS") throw Error("fixture output binding mismatch");
  if (!Array.isArray(result.rows) || canonical(result.rows.map(row => row.name).sort()) !== canonical([...rowNames].sort()) || observations[0]?.phase !== "baseline" || observations.at(-1)?.phase !== "run-final") throw Error("fixture lifecycle coverage missing");
  let cursor = 1;
  for (const name of rowNames) for (const side of ["baseline", "candidate"]) {
    const row = result.rows.find(row => row.name === name), product = cfg.products[name][side], sample = row?.[side], scope = `sample-${name}-${side}`;
    if (row?.status !== "PASS" || sample?.sha !== product.sha || sample?.dist_digest !== product.distDigest || sample?.runner_sha !== cfg.runnerSha) throw Error("fixture product completion mismatch");
    const required = ["sample-start", "before-runtime", ...stages.flatMap(stage => [stage, stage]), "app-started", "socket-ready", "runtime-ready", "sample-final"];
    for (const phase of required) {
      while (cursor < observations.length && !(observations[cursor].phase === phase && observations[cursor].identifiers.includes(scope))) cursor++;
      if (cursor >= observations.length) throw Error("fixture sample checkpoint coverage missing");
      cursor++;
    }
  }
  if (cursor > observations.length - 1) throw Error("fixture run-final coverage missing");
}
export function validateObserverRequest(args, run, sequence) {
  if (args?.run !== run || args.sequence !== sequence || !validRun(args.nonce) || !/^[A-Za-z-]{1,64}$/.test(args.phase) ||
      !Array.isArray(args.identifiers) || !Array.isArray(args.agentIds) ||
      [...args.identifiers, ...args.agentIds].some(value => typeof value !== "string" || value.length > 4096)) throw new Error("observer request binding invalid");
}
export function createFixtureObserver(run, { read = readSync, write = writeSync, clock = Date.now } = {}) {
  if (!validRun(run)) throw new Error("observer run binding invalid");
  let sequence = 0, pending = Buffer.alloc(0), failed = false;
  return ({ phase = "checkpoint", identifiers = [], agentIds = [] } = {}) => {
    if (failed) throw new Error("observer channel already failed");
    try {
      const request = { run, nonce: randomUUID().replaceAll("-", ""), sequence: ++sequence, phase, identifiers, agentIds }, started = clock();
      const bytes = Buffer.from(JSON.stringify({ observer: request }) + "\n");
      if (bytes.length > limit) throw new Error("observer request limit");
      for (let offset = 0; offset < bytes.length;) { const count = write(1, bytes.subarray(offset)); if (!count) throw new Error("observer write failed"); offset += count; }
      while (!pending.includes(10)) {
        const chunk = Buffer.alloc(4096), count = read(0, chunk, 0, chunk.length, null);
        if (!count) throw new Error("observer EOF/unreachable");
        pending = Buffer.concat([pending, chunk.subarray(0, count)]);
        if (pending.length > limit) throw new Error("observer receipt limit");
      }
      const end = pending.indexOf(10), frame = JSON.parse(pending.subarray(0, end).toString("utf8")); pending = pending.subarray(end + 1);
      if (clock() - started > 10000) throw new Error("observer response deadline exceeded");
      return validateObserverReceipt(frame.observer, request, clock());
    } catch (error) { failed = true; throw error; }
  };
}
export function observerCommand(root, hashes, run) {
  if (!root?.startsWith("/") || !validRun(run) || observerSourceFiles.some(path => !/^[a-f0-9]{64}$/.test(hashes?.[path]))) throw new Error("observer reviewed root/hashes required");
  // Verify the entire import closure before importing any observer code in the protected account.
  const bootstrap = `const fs=await import('node:fs'),os=await import('node:os'),crypto=await import('node:crypto');
    const root=${JSON.stringify(root)},hashes=${JSON.stringify(Object.fromEntries(observerSourceFiles.map(p=>[p,hashes[p]])))};
    const s=fs.lstatSync(root);if(process.getuid()!==501||!s.isDirectory()||s.uid!==501||(s.mode&63)||fs.realpathSync(root)!==root||!root.startsWith(fs.realpathSync(os.tmpdir())+'/'))throw Error('observer private root invalid');
    for(const [path,hash] of Object.entries(hashes)){const p=root+'/'+path;if(fs.realpathSync(p)!==p||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==hash)throw Error('observer source hash mismatch');}
    await (await import('file://'+root+'/scripts/xmac/account-observer-bridge.mjs')).serveProtected(${JSON.stringify(run)});`;
  return { command: "ssh", args: ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-l", "happycampr", "m1",
    [NODE, "--input-type=module", "-e", bootstrap].map(shellQuote).join(" ")] };
}
export async function serveProtected(run) {
  if (!validRun(run)) throw new Error("observer run invalid");
  const collect = createProtectedCollector(); let sequence = 0;
  for await (const line of createInterface({ input: process.stdin })) {
    let request;
    try {
      if (Buffer.byteLength(line) > limit) throw new Error("observer request limit");
      const message = JSON.parse(line); request = message;
      const args = message.args;
      if (message.op !== "observe") throw new Error("observer operation invalid");
      validateObserverRequest(args, run, ++sequence);
      const result = collect(args);
      if (Buffer.byteLength(JSON.stringify(result)) > limit) throw new Error("observer receipt limit");
      process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: request?.id, error: `protected observer unavailable: ${String(error).slice(0,512)}` }) + "\n");
      break;
    }
  }
}
export async function runAccountDriver(cfg, { spawnProcess = spawn } = {}) {
  const { validateWrapperConfig, rows } = await import("./m1-ratchet.mjs"); validateWrapperConfig(cfg);
  const { admissionStages } = await import("./app-admission.mjs");
  if (hostname() === "Locals-MacBook-Pro.local" || process.getuid() === 502) throw new Error("observer controller belongs on MBP, not either M1 execution context");
  const localRoot = fileURLToPath(new URL("../../", import.meta.url));
  for (const path of [...observerSourceFiles, "scripts/xmac/m1-ratchet.mjs", "scripts/xmac/app-admission.mjs"]) {
    const source = localRoot + path;
    if (realpathSync(source) !== source || createHash("sha256").update(readFileSync(source)).digest("hex") !== cfg.runnerFiles[path]) throw new Error("controller source hash mismatch");
  }
  if (cfg.fixtureConfigPath !== `${cfg.driverRoot}/reviewed-config.json`) throw new Error("fixture config path not bound to reviewed root");
  const run = randomUUID().replaceAll("-", ""), spec = observerCommand(cfg.observerRoot, cfg.runnerFiles, run);
  const protectedChild = spawnProcess(spec.command, spec.args, { stdio: ["pipe", "pipe", "inherit"] }), transport = connectProcess(protectedChild, 10000);
  let fixture;
  try {
    fixture = spawnProcess("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-l", "test", "m1",
      [NODE, "--input-type=module", "-e", `const run=process.argv.pop(); await (${admitReviewedFixture.toString()})(${JSON.stringify(cfg)}, run);`, run].map(shellQuote).join(" ")], { stdio: ["pipe", "pipe", "inherit"] });
    const exited = new Promise(resolve => { fixture.once("error", () => resolve(-1)); fixture.once("exit", code => resolve(code)); });
    fixture.stdin.on("error", () => {}); let sequence = 0, result; const observations = [];
    for await (const line of createInterface({ input: fixture.stdout })) {
      if (Buffer.byteLength(line) > 8 * limit) throw new Error("fixture result limit");
      const frame = JSON.parse(line);
      if (frame.observer) {
        if (result) throw new Error("observer request after fixture completion");
        const request = frame.observer;
        validateObserverRequest(request, run, ++sequence);
        const receipt = await transport.request("observe", request);
        validateObserverReceipt(receipt, request);
        observations.push(checkpointSummary(receipt));
        fixture.stdin.write(JSON.stringify({ observer: receipt }) + "\n");
      } else {
        if (result || !["PASS", "FAIL"].includes(frame.status)) throw new Error("unexpected fixture result"); result = frame;
      }
    }
    const code = await exited;
    if (!result || code !== (result.status === "PASS" ? 0 : 1)) throw new Error("fixture exited without matching receipt");
    validateFixtureCompletion(result, cfg, run, observations, rows.map(row => row.name), [...admissionStages, "refreshAndQuit", "launch"]);
    return result;
  } finally { fixture?.stdin.end(); transport.end(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5 || process.argv[2] !== "--execute-native" || process.argv[3] !== "--config") throw new Error("explicit reviewed controller admission required");
  const path = process.argv[4], stat = lstatSync(path);
  if (!stat.isFile() || realpathSync(path) !== path || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error("unsafe controller config");
  const result = await runAccountDriver(JSON.parse(readFileSync(path, "utf8"))); console.log(JSON.stringify(result));
  process.exitCode = result.status === "PASS" ? 0 : 1;
}
