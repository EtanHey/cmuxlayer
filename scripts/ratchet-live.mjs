#!/usr/bin/env node
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { productionSnapshot, productionChanges, privateWrites } from "./ratchet-production-guard.mjs";
import { assertAppTarget, assertProcessTarget, processBundleId } from "./ratchet-app-guard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2), option = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback;
const app = option("--app", "/Applications/cmux NIGHTLY.app"), cmuxSocket = "/tmp/cmux-nightly.sock";
const hostedRelease = argv.includes("--hosted-release");
const output = resolve(option("--output", join(tmpdir(), `ratchet-${process.pid}.json`)));
const receipt = { status: "FAIL", mode: argv.includes("--capability") ? "capability" : argv.includes("--prove") ? "bug/fix proof" : "comparison", rows: [], processes: [] };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", timeout: 120_000, env: cleanEnv, ...opts }).trim();
const pause = ms => new Promise(r => setTimeout(r, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CMUX|CMUXLAYER|GOLEM|GOLEMS|GIT_|CODEX|CLAUDE|REPOGOLEM|LISTEN_)/.test(k)));
const productionHome = homedir();
const rows = [
  { name: "send_under_codex_banner", fixture: "banner", bug: "7f26603f", fix: "64260ba3", specimen: "#1007 / composer-overlays/codex-boot.txt" },
  { name: "spawn_boot_false_unsubmitted", fixture: "boot", bug: "14aa55b5", fix: "fee6d9e5f29801e97fa64dabb8bfe0fc41aa5c94", fix_source: "#1019 merge", specimen: "docs.local/lanes/spawn-p0/live-specimen-1.md" },
  { name: "spawn_contract_once", fixture: "contract", bug: "87eccd87a81d116e3fe6056a9373e7d85fd0c3ab", fix: "HEAD", fix_source: "candidate resolved to exact SHA per sample; lead review required", specimen: "2026-10-07 initialization consumes brief / contract footer stranded" },
];
let nightlyPid, appTarget, scratch, mcp, daemon, daemonCommand, productionBefore, sequence = 0, lockOwned = false;
const runAgentIds = new Set();
const launchToken = randomUUID(), lockPath = join(tmpdir(), "cmuxlayer-ratchet-nightly.lock");
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => abort.abort());
function processes() { return run("ps", ["-axo", "pid=,comm="]).split("\n"); }
function command(pid) { try { return run("ps", ["-p", String(pid), "-o", "comm="]); } catch { return null; } }
function production() { return processes().filter(line => line.includes("/Applications/cmux.app/Contents/MacOS/cmux")).map(line => run("ps", ["-p", line.trim().split(/\s/)[0], "-o", "pid=,lstart=,comm="])); }
async function until(fn, ms = 10_000, cancellable = true) {
  const deadline = Date.now() + ms;
  do { if (cancellable && abort.signal.aborted) throw new Error("ratchet interrupted"); const value = await fn(); if (value) return value; await pause(100); } while (Date.now() < deadline);
  throw new Error("deadline exceeded");
}
async function terminate(pid, expected) {
  if (!pid || !command(pid)) return;
  if (command(pid) !== expected) throw new Error(`PID identity mismatch: ${pid}`);
  if (pid === nightlyPid) assertProcessTarget(expected, appTarget.hostedRelease);
  receipt.processes.push({ pid, command: expected, signal: "SIGTERM" }); process.kill(pid, "SIGTERM");
  try { await until(() => !command(pid), 10_000, false); } catch {
    if (command(pid) !== expected) throw new Error(`PID identity mismatch before SIGKILL: ${pid}`);
    if (pid === nightlyPid) assertProcessTarget(expected, appTarget.hostedRelease);
    receipt.processes.push({ pid, command: expected, signal: "SIGKILL" }); process.kill(pid, "SIGKILL");
    await until(() => !command(pid), 10_000, false);
  }
  receipt.processes.push({ pid, exited: true });
}
function rpc(path, method, params, jsonrpc = false) {
  return new Promise((resolvePromise, reject) => {
    const id = ++sequence, socket = net.createConnection(path); let buf = "", settled = false;
    const timer = setTimeout(() => finish(new Error(`${method} timeout`)), 90_000);
    const cancel = () => finish(new Error("ratchet interrupted"));
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); abort.signal.removeEventListener("abort", cancel); socket.destroy(); error ? reject(error) : resolvePromise(value); };
    abort.signal.addEventListener("abort", cancel, { once: true });
    socket.on("error", error => finish(error));
    socket.on("connect", () => socket.write(JSON.stringify({ ...(jsonrpc ? { jsonrpc: "2.0" } : {}), id, method, params }) + "\n"));
    socket.on("data", chunk => {
      buf += chunk;
      while (buf.includes("\n")) {
        const pos = buf.indexOf("\n"); let message;
        try { message = JSON.parse(buf.slice(0, pos)); } catch (error) { finish(error); return; }
        buf = buf.slice(pos + 1);
        if (message.id === id) finish(message.error || message.ok === false ? new Error(JSON.stringify(message)) : null, message.result);
      }
    });
    socket.on("end", () => finish(new Error("RPC connection ended before reply")));
    if (abort.signal.aborted) cancel();
  });
}
const cmux = (method, params = {}) => rpc(cmuxSocket, method, params);
async function startNightly() {
  receipt.production_start = production();
  if (!existsSync(join(app, "Contents/MacOS/cmux"))) throw new Error("NIGHTLY missing");
  appTarget = assertAppTarget(app, { hostedRelease, capability: argv.includes("--capability") });
  receipt.app_target = appTarget;
  if (hostedRelease && processes().some(line => {
    const executable = line.trim().replace(/^\d+\s+/, "");
    if (!executable.includes(".app/Contents/MacOS/")) return false;
    return processBundleId(executable) === "com.cmuxterm.app";
  })) throw new Error("hosted release busy: existing production bundle process");
  try { const fd = openSync(lockPath, "wx", 0o600); closeSync(fd); lockOwned = true; writeFileSync(lockPath, launchToken); }
  catch { throw new Error("NIGHTLY busy (runner lock; stale locks require operator cleanup)"); }
  if (processes().some(line => line.includes("/cmux NIGHTLY.app/Contents/MacOS/"))) throw new Error("NIGHTLY busy");
  scratch = mkdtempSync(join(tmpdir(), "cmux-ratchet-"));
  for (const dir of ["bin", "zdot", "state", "inbox", "repo", "home"]) mkdirSync(join(scratch, dir), { mode: 0o700 });
  writeFileSync(join(scratch, "zdot/.zshrc"), `export PATH=${quote(join(scratch, "bin"))}:$PATH\n`);
  const env = { HOME: join(scratch, "home"), CMUX_SOCKET_PATH: cmuxSocket, CMUX_ALLOW_SOCKET_OVERRIDE: "1", CMUX_SOCKET_MODE: "automation", CMUX_DISABLE_SESSION_RESTORE: "1", CMUXLAYER_DAEMON_SOCKET: join(scratch, "d.sock"), ZDOTDIR: join(scratch, "zdot") };
  run("/usr/bin/open", ["-g", "-n", "-a", app, ...Object.entries(env).flatMap(([k,v]) => ["--env", `${k}=${v}`]), "--args", "--ratchet-launch-token", launchToken]);
  nightlyPid = Number(await until(() => processes().filter(line => line.includes(`${app}/Contents/MacOS/cmux`)).map(line => line.trim().split(/\s/)[0]).find(pid => run("ps", ["-p", pid, "-o", "args="]).includes(launchToken)), 10_000, false));
  assertProcessTarget(command(nightlyPid), appTarget.hostedRelease);
  receipt.nightly = { app, pid: nightlyPid, launch_token: launchToken, env };
  receipt.ping = await until(async () => { try { return await cmux("system.ping"); } catch { return null; } });
  const ws = await cmux("workspace.create", { cwd: scratch, initial_command: "/bin/sh -c 'printf RATCHET_CAPABILITY_READY; exec /bin/cat'" });
  receipt.capability_screen = await until(async () => { try { const s = await cmux("surface.read_text", { surface_id: ws.surface_id, workspace_id: ws.workspace_id }); return s.text.includes("RATCHET_CAPABILITY_READY") ? s : null; } catch { return null; } });
  receipt.workspace = ws;
  receipt.runner = { sha: run("git", ["rev-parse", "HEAD"], { cwd: root }), sha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"), fixture_sha256: createHash("sha256").update(readFileSync(join(root, "scripts/ratchet-fixture-tui.mjs"))).digest("hex"), app_guard_sha256: createHash("sha256").update(readFileSync(join(root, "scripts/ratchet-app-guard.mjs"))).digest("hex"), guard_sha256: createHash("sha256").update(readFileSync(join(root, "scripts/ratchet-production-guard.mjs"))).digest("hex") };
}
async function tool(name, args) {
  const result = await rpc(mcp, "tools/call", { name, arguments: args }, true);
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === "text").text);
}
async function sample(row, ref) {
  const before = productionSnapshot(productionHome);
  const sha = run("git", ["rev-parse", `${ref}^{commit}`], { cwd: root });
  const sampleId = `${row.fixture}-${sha.slice(0,8)}-${++sequence}`;
  const tree = join(scratch, `tree-${sampleId}`), events = join(scratch, `events-${sampleId}.json`);
  const token = `RATCHET_${row.fixture}_${sha.slice(0,8)}_${launchToken}`;
  let log = "", sampled, home, privateRoot, treeAdded = false;
  try {
    run("git", ["worktree", "add", "--detach", tree, sha], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); treeAdded = true;
    run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: tree, stdio: ["ignore", "pipe", "pipe"] });
    run("bun", ["run", "build"], { cwd: tree, env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });
    const fixtureCommand = `${quote(process.execPath)} ${quote(join(root, "scripts/ratchet-fixture-tui.mjs"))} ${row.fixture} ${quote(events)}`;
    writeFileSync(join(scratch, "bin/ratchetCodex"), `#!/bin/sh\nexec ${fixtureCommand}\n`, { mode: 0o700 });
    writeFileSync(join(scratch, "launchers.zsh"), `repoGolem ratchet ${quote(join(scratch, "repo"))}\n`);
    privateRoot = join(scratch, `private-${sampleId}`); mkdirSync(privateRoot, { mode: 0o700 });
    home = join(privateRoot, "home"); mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(privateRoot, "fleet.json"), JSON.stringify({ coordinationDir: privateRoot, outbox: false, seatRegistryPath: join(privateRoot, "seats.yaml") }));
    mcp = join(privateRoot, "d.sock");
    const env = { ...cleanEnv, HOME: home, CMUX_SOCKET_PATH: cmuxSocket, CMUX_BUNDLED_CLI_PATH: join(app, "Contents/Resources/bin/cmux"), PATH: `${join(app, "Contents/Resources/bin")}:${cleanEnv.PATH}`, CMUXLAYER_DAEMON_SOCKET: mcp, CMUXLAYER_STATE_DIR: join(home, ".local/state/cmuxlayer"), CMUXLAYER_INBOX_BASE_DIR: join(privateRoot, "inbox"), CMUXLAYER_FLEET_CONFIG: join(privateRoot, "fleet.json"), CMUXLAYER_HARNESS_HOME: privateRoot, CODEX_HOME: join(privateRoot, "codex"), CMUXLAYER_CONFIG_FILE: join(privateRoot, "no-config"), CMUXLAYER_LAUNCHER_REGISTRY_PATH: join(scratch, "launchers.zsh"), CMUXLAYER_CONTROL_HEALTH_INTERVAL_MS: "0" };
    daemon = spawn(process.execPath, [join(tree, "dist/daemon.js")], { cwd: tree, env, stdio: ["ignore", "ignore", "pipe"] });
    receipt.processes.push({ pid: daemon.pid, sha, kind: "dist daemon", home }); daemon.stderr.on("data", c => { log += c; });
    await until(() => existsSync(mcp));
    daemonCommand = command(daemon.pid);
    await rpc(mcp, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ratchet-live", version: "1" } }, true);
    let result, surface;
    if (row.fixture === "banner") {
      const ws = await cmux("workspace.create", { cwd: scratch, initial_command: fixtureCommand }); surface = ws.surface_id;
      await until(() => existsSync(events));
      result = await tool("send_to", { mode: "surface", surface: ws.surface_ref, workspace: ws.workspace_ref, text: token, verbose: true });
    } else {
      result = await tool("spawn_agent", { repo: "ratchet", cli: "codex", effort: "low", role: "worker", authority: "worker", placement: "right", workspace: receipt.workspace.workspace_id, cwd: join(scratch, "repo"), worktree: false, ...(row.fixture === "contract" ? {} : { mcp_profile: "sterile" }), prompt: token, boot_prompt_timeout_ms: 5000, verbose: true });
      surface = result.surface_id;
      if (result.agent_id) runAgentIds.add(result.agent_id);
    }
    const expected = row.fixture === "contract"
      ? `${token} ; cmuxlayer contract for ${result.agent_id}: Read and follow ${result.contract_path}` : token;
    if (existsSync(events) && JSON.parse(readFileSync(events)).submitted) await until(() => JSON.parse(readFileSync(events)).phase === "working");
    const fixture = existsSync(events) ? JSON.parse(readFileSync(events)) : null;
    if (!fixture) throw new Error(`fixture did not launch: ${JSON.stringify(result)}`);
    const screen = surface ? await cmux("surface.read_text", { surface_id: surface }) : null;
    const accepted = fixture.submitted === expected && fixture.phase === "working" && screen?.text.includes("Working");
    const passed = accepted && result.ok === true && (row.fixture === "banner" ? result.submitted === true && result.submit_verified === true && result.delivery_state === "submitted" : result.boot_prompt_delivered === true && result.boot_prompt_submit_verified === true && result.spawn_state !== "boot_unsubmitted");
    const contractOnce = row.fixture !== "contract" || fixture.draft === "" &&
      fixture.submissions?.length === 1 && fixture.submissions[0] === expected &&
      fixture.keys.filter(key => key === "Return").length === 1 &&
      !fixture.keys.includes("LF") && result.coordination_footer_delivered === true;
    const expected_defect = row.fixture === "contract"
      ? fixture.submitted === token && fixture.draft.includes(`cmuxlayer contract for ${result.agent_id}:`) && result.spawn_state === "boot_unsubmitted"
      : row.fixture === "banner" ? !fixture.submitted && result.ok === false && (result.error?.includes("account_security_banner_not_dismissed") || result.submit_verification_reason === "account_security_banner_not_dismissed") : accepted && result.spawn_state === "boot_unsubmitted" && result.boot_prompt_delivered === false && result.health?.screen_confirmed_state === "working";
    return sampled = { sha, lock_sha256: createHash("sha256").update(readFileSync(join(tree, "bun.lock"))).digest("hex"), status: passed && contractOnce ? "PASS" : "FAIL", failure_kind: passed && contractOnce ? null : "behavior", expected_defect: Boolean(expected_defect), accepted, contract_once: contractOnce, result, fixture, screen, daemon_log: log };
  } catch (error) { return sampled = { sha, status: "FAIL", failure_kind: "infrastructure", error: String(error), daemon_log: log }; }
  finally {
    try {
      if (daemon) { await terminate(daemon.pid, daemonCommand ?? process.execPath); daemon = null; daemonCommand = null; }
      if (treeAdded) run("git", ["worktree", "remove", tree], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    } finally {
      const reads = [], changed = productionChanges(before, productionSnapshot(productionHome), [launchToken, token, scratch, privateRoot, home, ...runAgentIds], [...runAgentIds], reads);
      const positive = privateWrites(home), failed = changed.length > 0 || positive.status !== "PASS";
      sampled.production_guard = { read_ranges: reads, violations: changed, positive_control: positive, status: failed ? "FAIL" : "PASS" };
      if (failed) { receipt.isolation_failed = true; Object.assign(sampled, { status: "FAIL", failure_kind: changed.length ? "production_state" : "isolation", expected_defect: false, error: "attributed production write or missing private write" }); }
    }
  }
}
try {
  productionBefore = productionSnapshot(productionHome);
  await startNightly();
  if (argv.includes("--capability")) receipt.rows.push({ name: hostedRelease ? "0.64.22 capability" : "NIGHTLY capability", baseline: "—", candidate: "PASS", delta: "—", ceiling: 0, status: "PASS" });
  else for (const row of rows) {
    const baseline = await sample(row, argv.includes("--prove") ? row.bug : option("--baseline", "origin/main"));
    const candidate = await sample(row, argv.includes("--prove") ? row.fix : option("--candidate", "HEAD"));
    const proof = !argv.includes("--prove") || baseline.status === "FAIL" && baseline.expected_defect;
    const frames = (row.fixture === "banner" ? ["composer-overlays/codex-boot.txt"] : ["codex-0.157/idle-empty.txt", "codex-0.157/idle-submitted-working.txt"]).map(file => ({ file, sha256: createHash("sha256").update(readFileSync(join(root, "tests/fixtures", file))).digest("hex") }));
    receipt.rows.push({ ...row, provenance: { frames: "real", captures: frames, transition: `modeled from ${row.specimen}`, adaptation: "blank padding rows removed; boot committed row scroll-away modeled" }, baseline, candidate, delta: Number(candidate.status === "FAIL") - Number(baseline.status === "FAIL"), ceiling: 0, status: candidate.status === "PASS" && proof && !receipt.isolation_failed ? "PASS" : "FAIL" });
  }
  receipt.status = !receipt.isolation_failed && receipt.rows.every(row => row.status === "PASS") ? "PASS" : "FAIL";
} catch (error) { receipt.error = String(error); }
finally {
  try { if (nightlyPid) await terminate(nightlyPid, `${app}/Contents/MacOS/cmux`); } catch (error) { receipt.error = String(error); receipt.status = "FAIL"; }
  try { if (productionBefore) {
    const reads = [], runnerLocal = [];
    const changed = productionChanges(productionBefore, productionSnapshot(productionHome), [launchToken, scratch, ...runAgentIds], [...runAgentIds], reads,
      { capability: argv.includes("--capability") && Boolean(appTarget), app, runnerLocal });
    receipt.production_guard = { read_ranges: reads, runner_local_state: runnerLocal, violations: changed, status: changed.length ? "FAIL" : "PASS" };
    if (changed.length) { receipt.status = "FAIL"; receipt.error = "attributed production write during run"; }
  } } catch (error) { receipt.status = "FAIL"; receipt.error = String(error); }
  try { receipt.production_end = production(); if (JSON.stringify(receipt.production_start) !== JSON.stringify(receipt.production_end)) { receipt.status = "FAIL"; receipt.error = "production PID/start-time changed"; } } catch (error) { receipt.status = "FAIL"; receipt.error = String(error); }
  try { if (lockOwned && readFileSync(lockPath, "utf8") === launchToken) unlinkSync(lockPath); } catch (error) { receipt.status = "FAIL"; receipt.error = String(error); }
  receipt.scratch = scratch;
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  const table = ["| row | main baseline | PR | Δ | ceiling | status |", "| --- | --- | --- | --- | --- | --- |", ...receipt.rows.map(row => `| ${row.name} | ${row.baseline?.sha ? `${row.baseline.status} (${row.baseline.sha})` : row.baseline} | ${row.candidate?.sha ? `${row.candidate.status} (${row.candidate.sha})` : row.candidate} | ${row.delta} | ${row.ceiling} | ${row.status} |`)];
  if (receipt.error) table.push(`| infrastructure | — | ${receipt.error.replaceAll("|", "/").replaceAll("\n", " ")} | — | 0 | FAIL |`);
  writeFileSync(output.replace(/\.json$/, "") + ".md", table.join("\n") + "\n"); console.log(table.join("\n")); console.log(`Receipt: ${output}`);
  process.exitCode = receipt.status === "PASS" ? 0 : 1;
}
