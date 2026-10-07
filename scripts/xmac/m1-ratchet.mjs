// Dedicated M1 wrapper. Importing this module never opens an app or a client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync, statSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startSoakRuntime, rpc, isolatedEnvironment } from "../soak-runtime.mjs";
import { privateBuild, targetOptions, shellQuote } from "./target.mjs";
import { runCodexResolutionProbe, observeProbeOwner } from "./startup-probe.mjs";
import { verifyFixtureLaunchers } from "./fixture-launchers.mjs";
import { attestFixtureProcess, fileDigest } from "./fixture-attestation.mjs";
import { productionSnapshot, productionChanges } from "./production-guard.mjs";

export const rows = [
  { name: "send_under_codex_banner", fixture: "banner", bug: "7f26603fc575638bd531aeb97e48038149aad78c", fix: "64260ba34ba8ee98fa7de3b71566387cecb12280", specimen: "#1007 / composer-overlays/codex-boot.txt" },
  { name: "spawn_boot_false_unsubmitted", fixture: "boot", bug: "14aa55b5baf9596df137c73394b1e2a074e2e59d", fix: "fee6d9e5f29801e97fa64dabb8bfe0fc41aa5c94", specimen: "#1019 merge / docs.local/lanes/spawn-p0/live-specimen-1.md" },
  { name: "spawn_contract_once", fixture: "contract", bug: "87eccd87a81d116e3fe6056a9373e7d85fd0c3ab", fix: "288dadb4c48a69af63a8151970d3c01d448746a2", specimen: "initialization consumes brief / contract footer stranded" },
];
export function validateWrapperConfig(cfg) {
  if (cfg.nativeApproved !== true || !/^[a-f0-9]{40}$/.test(cfg.runnerSha) || cfg.host && cfg.host !== "m1" ||
      cfg.cmux && cfg.cmux !== "prod" || rows.some(row => cfg.runnerSha === row.fix || cfg.runnerSha === row.bug) ||
      Object.keys(cfg.products ?? {}).sort().join() !== rows.map(row => row.name).sort().join()) throw new Error("M1 reviewed runner/control admission missing");
  for (const row of rows) {
    const pair = cfg.products[row.name];
    if (pair.baseline?.sha !== row.bug || pair.candidate?.sha !== row.fix) throw new Error("product baseline/approved candidate mismatch");
  }
  return cfg;
}
export function evaluateRow(row, token, result, fixture, screen) {
  const pointer = result.agent_id && result.contract_path ? `cmuxlayer contract for ${result.agent_id}: Read and follow ${result.contract_path}` : null;
  const expected = row.fixture === "contract" ? pointer && `${token} ; ${pointer}` : token;
  const accepted = !!fixture && !!expected && fixture.submitted === expected && fixture.phase === "working" && !!screen?.text.includes("Working");
  const verified = result.ok === true && (row.fixture === "banner" ? result.submitted === true && result.submit_verified === true && result.delivery_state === "submitted" :
    result.boot_prompt_delivered === true && result.boot_prompt_submit_verified === true && result.spawn_state !== "boot_unsubmitted");
  const contractOnce = row.fixture !== "contract" || !!fixture && fixture.draft === "" && fixture.submissions?.length === 1 &&
    fixture.submissions[0] === expected && fixture.keys.filter(key => key === "Return").length === 1 && !fixture.keys.includes("LF") && result.coordination_footer_delivered === true;
  const defect = row.fixture === "contract" ? !!pointer && fixture?.submitted === token && fixture.draft === pointer && result.spawn_state === "boot_unsubmitted" :
    row.fixture === "banner" ? !!fixture && !fixture.submitted && result.ok === false && (result.error?.includes("account_security_banner_not_dismissed") || result.submit_verification_reason === "account_security_banner_not_dismissed") :
      accepted && result.spawn_state === "boot_unsubmitted" && result.boot_prompt_delivered === false && result.health?.screen_confirmed_state === "working";
  return { behavior_status: accepted && verified && contractOnce ? "PASS" : "FAIL", expected_defect: !!defect, accepted, contract_once: !!contractOnce };
}
export function combineProof(baseline, candidate) {
  const behavior = baseline.behavior_status === "FAIL" && baseline.expected_defect && candidate.behavior_status === "PASS";
  return { behavior_status: behavior ? "PASS" : "FAIL", status: behavior && baseline.attribution_status === "PASS" && candidate.attribution_status === "PASS" ? "PASS" : "FAIL" };
}

async function wait(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  throw new Error("fixture observation deadline exceeded");
}
const unwrap = result => result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text);
export function checkProductRegistry(build, env) {
  // Actual compiled resolver, synthetic absent registry. No launch/ExecFn/API.
  const code = `const {resolveSpawnLaunchPlan,launcherRegistryRequired}=await import(${JSON.stringify(join(build.root, "dist/engine/launch-command.js"))});
    if(!launcherRegistryRequired(process.env)) throw Error('required registry flag unsupported');
    const options={registryOptions:{sourcePath:process.env.CMUXLAYER_LAUNCHER_REGISTRY_PATH+'.absent'},repoRootFallback:{homeDir:process.env.HOME,cwd:process.env.HOME,isDirectory:()=>true}};
    const relaxed=resolveSpawnLaunchPlan('absent_fixture_repo','codex',{...options,env:{...process.env,CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY:'0'}});
    if(relaxed.launchMode!=='raw') throw Error('raw fallback sensitivity control unavailable');
    let refused=false; try { resolveSpawnLaunchPlan('absent_fixture_repo','codex',{...options,env:process.env}); } catch(e) { if(!/launcher registry/i.test(String(e))) throw e; refused=true; }
    if(!refused) throw Error('product permits raw launcher fallback');`;
  execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 10000 });
}
async function sample(cfg, row, product, outputRoot) {
  const before = productionSnapshot(homedir()), token = `RATCHET_${row.fixture}_${product.sha.slice(0, 8)}_${randomUUID()}`;
  const owned = [], reads = [], sample = { sha: product.sha, runner_sha: cfg.runnerSha, token, behavior_status: "FAIL", attribution_status: "FAIL", expected_defect: false };
  let runtime, client;
  try {
    const opts = targetOptions({ ...cfg.options, host: "m1", cmux: "prod", repo: "ratchet", driverRoot: cfg.driverRoot, driverSha: cfg.runnerSha,
      buildRoot: product.root, sha: product.sha, fixtureRow: row.fixture });
    runtime = await startSoakRuntime(opts, outputRoot);
    verifyFixtureLaunchers(runtime.receipt.fixtures, runtime.env);
    checkProductRegistry(privateBuild(product.root, product.sha), runtime.env);
    await runCodexResolutionProbe(runtime);
    const owner = observeProbeOwner(runtime);
    const assertOwner = () => {
      const current = observeProbeOwner(runtime);
      if (!current.socketOwned || Object.keys(owner).some(key => current[key] !== owner[key])) throw new Error("M1 app/socket ownership changed");
      verifyFixtureLaunchers(runtime.receipt.fixtures, runtime.env);
    };
    client = new Client({ name: "m1-fixture-ratchet", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(product.root, "dist/index.js")], env: runtime.env, stderr: "inherit" }));
    const call = async (name, args) => { assertOwner(); return unwrap(await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 })); };
    const health = await call("control_health", { detail: "full" });
    if (!health.ok || health.health?.current_process?.pid !== runtime.receipt.daemon.pid || health.socket_path !== runtime.env.CMUX_SOCKET_PATH) throw new Error("private daemon/client binding changed");
    sample.control_health = health;
    let result, surface, workspace = runtime.workspace;
    const install = runtime.receipt.fixtures;
    if (row.fixture === "banner") {
      const command = `${shellQuote(process.execPath)} ${shellQuote(install.attestation.files.helper.path)} launcher codex -w ${shellQuote(runtime.cwd)}`;
      assertOwner();
      const created = await rpc(runtime.env.CMUX_SOCKET_PATH, "workspace.create", { cwd: runtime.cwd, initial_command: command });
      surface = created.surface_id; workspace = created.workspace_id;
      await wait(() => existsSync(install.events));
      sample.fixture_process = attestFixtureProcess(install, { surface, workspace }, runtime.env);
      result = await call("send_to", { mode: "surface", surface: created.surface_ref, workspace: created.workspace_ref, text: token, verbose: true });
    } else {
      result = await call("spawn_agent", { repo: "ratchet", cli: "codex", model: "gpt-6-luna", effort: "low", role: "worker", authority: "worker", placement: "right",
        workspace, cwd: runtime.cwd, worktree: false, ...(row.fixture === "contract" ? {} : { mcp_profile: "sterile" }), prompt: token, boot_prompt_timeout_ms: 5000, verbose: true });
      surface = result.surface_uuid ?? result.surface_id;
      if (result.agent_id) owned.push(result.agent_id);
      await wait(() => existsSync(install.events));
      sample.fixture_process = attestFixtureProcess(install, { surface, workspace }, runtime.env);
    }
    const readEvent = () => JSON.parse(readFileSync(install.events, "utf8"));
    if (readEvent().submitted) await wait(() => readEvent().phase === "working");
    assertOwner();
    attestFixtureProcess(install, sample.fixture_process, runtime.env);
    const fixture = readEvent(), screen = await rpc(runtime.env.CMUX_SOCKET_PATH, "surface.read_text", { surface_id: surface, workspace_id: workspace });
    Object.assign(sample, evaluateRow(row, token, result, fixture, screen), { result, fixture, screen, workspace, surface,
      fixture_attestation: install.attestation, lifecycle_path: runtime.receiptPath });
  } catch (error) { sample.error = String(error); sample.failure_kind = "infrastructure"; }
  finally {
    try { if (client) await client.close(); } catch (error) { sample.error = String(error); }
    try { if (runtime) { sample.lifecycle = await runtime.close(); if (sample.lifecycle.status !== "PASS") sample.error = "runtime teardown failed"; } }
    catch (error) { sample.error = String(error); }
    try {
      const local = [token, runtime?.receipt.launch_token, runtime?.receipt.scratch, runtime?.env.CMUX_SOCKET_PATH, runtime?.env.CMUXLAYER_DAEMON_SOCKET, ...owned].filter(Boolean);
      const violations = productionChanges(before, productionSnapshot(homedir()), local, owned, reads);
      const path = runtime && join(runtime.env.CMUXLAYER_STATE_DIR, "daemon.log");
      const bytes = path && existsSync(path) ? statSync(path).size : 0;
      const positive = { path, bytes, status: bytes > 0 ? "PASS" : "FAIL" };
      sample.attribution = { reads, violations, positive_control: positive };
      sample.attribution_status = !violations.length && positive.status === "PASS" ? "PASS" : "FAIL";
    } catch (error) { sample.error = String(error); }
    if (sample.error) { sample.behavior_status = "FAIL"; sample.expected_defect = false; }
    writeFileSync(join(outputRoot, `${row.fixture}-${product.sha}.json`), JSON.stringify(sample, null, 2) + "\n", { mode: 0o600 });
  }
  return sample;
}
export async function runNative(cfg) {
  validateWrapperConfig(cfg);
  if (hostname() !== "Locals-MacBook-Pro.local") throw new Error("dedicated M1 only; no MBP/NIGHTLY route");
  const harness = privateBuild(cfg.driverRoot, cfg.runnerSha);
  if (realpathSync(fileURLToPath(import.meta.url)) !== join(harness.root, "scripts/xmac/m1-ratchet.mjs")) throw new Error("runner does not match reviewed driver prefix");
  const productionBefore = productionSnapshot(homedir());
  for (const row of rows) for (const product of Object.values(cfg.products[row.name])) {
    const build = privateBuild(product.root, product.sha), probe = mkdtempSync(join(harness.root, "registry-probe-"));
    for (const dir of ["home", "state", "inbox"]) mkdirSync(join(probe, dir), { mode: 0o700 });
    const env = isolatedEnvironment({}, probe, "/Applications/cmux.app", "/tmp/cmux-soak-stable.sock");
    env.CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY = "1";
    checkProductRegistry(build, env); // Every historical control must refuse raw fallback BEFORE any app action.
  }
  const outputRoot = join(harness.root, "evidence", `m1-ratchet-${randomUUID()}`); mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const receipt = { status: "FAIL", runner_sha: cfg.runnerSha, runner_sha256: fileDigest(fileURLToPath(import.meta.url)), rows: [] };
  for (const row of rows) {
    const pair = cfg.products[row.name];
    const baseline = await sample(cfg, row, pair.baseline, outputRoot), candidate = await sample(cfg, row, pair.candidate, outputRoot);
    receipt.rows.push({ ...row, baseline, candidate, ...combineProof(baseline, candidate) });
  }
  receipt.status = receipt.rows.every(row => row.status === "PASS") ? "PASS" : "FAIL";
  const reads = [], samples = receipt.rows.flatMap(row => [row.baseline, row.candidate]);
  const ids = samples.flatMap(sample => [sample.token, sample.result?.agent_id, sample.lifecycle?.launch_token, sample.lifecycle?.scratch]).filter(Boolean);
  const violations = productionChanges(productionBefore, productionSnapshot(homedir()), [...ids, "/tmp/cmux-soak-stable.sock"], samples.map(sample => sample.result?.agent_id).filter(Boolean), reads);
  receipt.production_guard = { reads, violations, status: violations.length ? "FAIL" : "PASS" };
  if (violations.length) receipt.status = "FAIL";
  writeFileSync(join(outputRoot, "result.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  return { ...receipt, outputRoot };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--execute-native" || process.argv[3] !== "--config" || process.argv.length !== 5) throw new Error("explicit reviewed M1 admission/config required");
  const path = realpathSync(process.argv[4]), stat = lstatSync(path);
  if (path !== process.argv[4] || !stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error("unsafe native config");
  const result = await runNative(JSON.parse(readFileSync(path, "utf8")));
  console.log(JSON.stringify(result)); process.exitCode = result.status === "PASS" ? 0 : 1;
}
