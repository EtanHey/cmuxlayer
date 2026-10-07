#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openDriver, prepareBuild } from "./driver.mjs";
import { targetOptions } from "./target.mjs";
import { runScenarios, ratchetProof, markdownTable } from "./runner.mjs";
import { scenarioLaunchers, launchFailureRows } from "./launcher-preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cleanGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const shaFor = ref => {
  if (!/^(?:[a-f0-9]{7,40}|HEAD)$/.test(ref)) throw new Error("SHA must be a commit hex id or HEAD");
  return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, env: cleanGitEnv, encoding: "utf8" }).trim();
};
export function options(argv) {
  const opts = { scenarios: [], dryRun: false, replay: false, prepareDriver: false };
  const names = { "--host": "host", "--cmux": "cmux", "--private-home": "privateHome", "--dmg": "dmg", "--repo": "repo",
    "--sha": "sha", "--driver-root": "driverRoot", "--driver-sha": "driverSha", "--output": "output", "--installed-dist-digest": "installedDistDigest" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--replay") opts.replay = true;
    else if (arg === "--prepare-driver") opts.prepareDriver = true;
    else if (arg === "--scenario") { if (!argv[index + 1]) throw new Error("scenario path missing"); opts.scenarios.push(argv[++index]); }
    else if (names[arg] && argv[index + 1]) opts[names[arg]] = argv[++index];
    else throw new Error(`unknown or incomplete option: ${arg}`);
  }
  targetOptions(opts);
  if (!opts.scenarios.length) throw new Error("at least one --scenario module required");
  if (!opts.dryRun && !opts.replay && !/^[a-f0-9]{64}$/.test(opts.installedDistDigest)) throw new Error("installed runs require exact-SHA compiled --installed-dist-digest");
  if (!opts.dryRun && !opts.prepareDriver && !opts.driverRoot) throw new Error("reviewed --driver-root or --prepare-driver required");
  return opts;
}
export async function replaySamples(scenarios, sample, resolveSha = value => value) {
  const ratchets = [];
  for (const scenario of scenarios) {
    const bug = await sample([scenario], resolveSha(scenario.bug.sha), "bug", true);
    if (bug.rows.some(row => row.precondition?.kind === "launch_overlay")) {
      ratchets.push({ name: scenario.id, baseline: bug.rows[0], candidate: "not run: launch_overlay", delta: "stopped at precondition", ceiling: 0, status: "UNPROVEN" });
      break;
    }
    const fixed = scenario.fix?.sha ? await sample([scenario], resolveSha(scenario.fix.sha), "fix", true) : null;
    ratchets.push({ name: scenario.id, baseline: bug.rows[0], candidate: fixed?.rows[0] ?? "fix: pending", delta: fixed ? "bug → fix" : "pending", ceiling: 0, status: ratchetProof(bug.rows[0], fixed?.rows[0]) });
    if (fixed?.rows.some(row => row.precondition?.kind === "launch_overlay")) break;
  }
  return ratchets;
}
export async function main(argv) {
  const opts = options(argv), harnessSha = shaFor("HEAD");
  const scenarios = await Promise.all(opts.scenarios.map(async path => (await import(pathToFileURL(resolve(path)).href)).default));
  if (new Set(scenarios.map(scenario => scenario.id)).size !== scenarios.length) throw new Error("duplicate scenario id");
  for (const scenario of scenarios) if (!/^[a-z0-9_]+$/.test(scenario.id) || !Array.isArray(scenario.targets) || typeof scenario.run !== "function") throw new Error("invalid scenario module");
  const dirty = !!execFileSync("git", ["status", "--porcelain"], { cwd: root, env: cleanGitEnv, encoding: "utf8" }).trim();
  const plan = { harness_dirty: dirty, target: `${opts.host}:${opts.cmux}`, harness_sha: harnessSha, scenarios: scenarios.map(scenario => ({ id: scenario.id, bug: scenario.bug, fix: scenario.fix?.sha ? scenario.fix : "pending" })), dry_run: opts.dryRun, release_gate: false };
  if (opts.dryRun) { process.stdout.write(JSON.stringify(plan, null, 2) + "\n"); return plan; }
  if (dirty) throw new Error("commit reviewed harness work before deploying a driver");
  const output = resolve(opts.output ?? join(root, "docs.local/xmac", randomUUID()));
  if (!output.startsWith(join(root, "docs.local/") )) throw new Error("evidence output must be inside this checkout's docs.local");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  const harness = opts.prepareDriver ? prepareBuild(opts, harnessSha, root) : { root: opts.driverRoot, sha: shaFor(opts.driverSha ?? "HEAD") };
  const { parseScreen } = await import("../../dist/screen-parser.js");
  const samples = [], ratchets = [];
  const sample = async (selected, sha, phase, replay) => {
    const path = join(output, `${phase}-${sha.slice(0, 8)}-${samples.length}`);
    let build, result;
    try {
      build = replay ? prepareBuild(opts, sha, root) : null;
      const launcherClis = [...new Set(selected.flatMap(scenarioLaunchers))];
      const driver = await openDriver({ ...opts, launcherClis, dryRun: false, sha, driverRoot: harness.root, driverSha: harness.sha, buildRoot: build?.root });
      result = await runScenarios({ scenarios: selected, driver, evidenceDir: path, parseScreen, phase });
    } catch (error) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const evidencePath = join(path, "infrastructure.json");
      await writeFile(evidencePath, JSON.stringify({ error: String(error), precondition: error.precondition, build, harness }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      result = { status: "FAIL", rows: launchFailureRows(selected, opts, sha, phase, evidencePath, error) };
    }
    samples.push(result); return result;
  };
  if (opts.replay) {
    ratchets.push(...await replaySamples(scenarios, sample, shaFor));
  } else await sample(scenarios, shaFor(opts.sha ?? "HEAD"), "installed", false);
  const result = { ...plan, status: samples.every(sample => sample.status === "PASS") ? "PASS" : "FAIL", early_warning_only: opts.cmux === "nightly", rows: samples.flatMap(sample => sample.rows), ratchets, samples };
  if (opts.replay) result.status = ratchets.length && ratchets.every(row => row.status === "PROVEN") ? "PASS" : "FAIL";
  await writeFile(join(output, "ratchet-table.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const table = markdownTable(result.rows) + (ratchets.length ? "\n| row | main baseline | PR | Δ | ceiling | status |\n| --- | --- | --- | --- | --- | --- |\n" + ratchets.map(row => `| ${row.name} | ${row.baseline.status} (${row.baseline.cmuxlayer_sha}) | ${row.candidate?.status ?? row.candidate} (${row.candidate?.cmuxlayer_sha ?? "pending"}) | ${row.delta} | ${row.ceiling} | ${row.status} |`).join("\n") + "\n" : "");
  await writeFile(join(output, "pr-comment.md"), table, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${result.status} ${join(output, "ratchet-table.json")}\n`);
  if (result.status !== "PASS") process.exitCode = 1;
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
