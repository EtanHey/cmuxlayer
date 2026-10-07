// Local-only lifecycle shared with the ratchet lane's NIGHTLY lock/launch recipe.
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync, realpathSync, statSync, lstatSync } from "node:fs";
import { tmpdir, hostname, homedir } from "node:os";
import { join, sep } from "node:path";
import { privateBuild, launcherEnvironment } from "./xmac/target.mjs";
import { randomUUID, createHash } from "node:crypto";
import { assertAppTarget, assertProcessTarget, processBundleId } from "./soak-app-guard.mjs";
import { checkLauncherArgv } from "./xmac/argv-preflight.mjs";
import { createScenarioRepo } from "./xmac/scenario-repo.mjs";
import { launcherCwdStartup, launchRecords } from "./xmac/launch-cwd.mjs";
import { assertM1CmuxMutation, observeCmuxSessions, parseHumanSessionApproval, normalizeProcessIdentity } from "./cmux-session-guard.mjs";

export const NIGHTLY_SOCKET = "/tmp/cmux-nightly.sock";
export const INSTALLED_ENTRY = "/opt/homebrew/opt/cmuxlayer/bin/cmuxlayer";
export const PINNED_DMG_SHA256 = "fd148dba3519fe7d308844089ce4d062b17739ba645623f058f67a64798cea25";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } }).trim();

export function isolatedEnvironment(parent, scratch, app = "/Applications/cmux NIGHTLY.app", socketPath = NIGHTLY_SOCKET) {
  const clean = Object.fromEntries(Object.entries(parent).filter(([key, value]) => typeof value === "string" &&
    !/^(CMUX|CMUXLAYER|GOLEM|GOLEMS|GIT_|CODEX|CLAUDE|REPOGOLEM|LISTEN_|XDG_|ZDOTDIR$)/u.test(key)));
  return { ...clean, HOME: join(scratch, "home"), ZDOTDIR: join(scratch, "zdot"),
    CMUX_SOCKET_PATH: socketPath, CMUX_BUNDLE_ID: socketPath === NIGHTLY_SOCKET ? "com.cmuxterm.app.nightly" : "com.cmuxterm.app",
    CMUX_ALLOW_SOCKET_OVERRIDE: "1", CMUX_SOCKET_MODE: "automation", CMUX_DISABLE_SESSION_RESTORE: "1",
    CMUX_BUNDLED_CLI_PATH: join(app, "Contents/Resources/bin/cmux"),
    PATH: `${join(app, "Contents/Resources/bin")}:${clean.PATH ?? "/usr/bin:/bin"}`,
    CMUXLAYER_DAEMON_SOCKET: join(scratch, "d.sock"), CMUXLAYER_STATE_DIR: join(scratch, "state"),
    CMUXLAYER_INBOX_BASE_DIR: join(scratch, "inbox"), CMUXLAYER_HARNESS_HOME: join(scratch, "home"),
    CODEX_HOME: join(scratch, "home/.codex"), CLAUDE_CONFIG_DIR: join(scratch, "home/.claude"),
    XDG_CONFIG_HOME: join(scratch, "home/.config"), XDG_STATE_HOME: join(scratch, "home/.local/state"),
    XDG_CACHE_HOME: join(scratch, "home/.cache"), XDG_DATA_HOME: join(scratch, "home/.local/share"),
    CMUXLAYER_CONFIG_FILE: join(scratch, "no-config"), CMUXLAYER_FLEET_CONFIG: join(scratch, "fleet.json"),
    CMUXLAYER_LAUNCHER_REGISTRY_PATH: join(scratch, "empty-launchers.zsh") };
}

export function targetEnvironment(parent, scratch, opts, home = homedir()) {
  const socket = opts.target === "m1-gate" ? "/tmp/cmux-soak-stable.sock" : NIGHTLY_SOCKET;
  const env = isolatedEnvironment(parent, scratch, opts.app, socket);
  if (opts.target === "m1-gate") {
    // Dedicated target-host auth, never a controller HOME or copied auth file.
    // These HOME-derived harness paths change; cmuxlayer state/inbox/socket do not.
    for (const key of ["HOME", "CMUXLAYER_HARNESS_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
      "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
      env[key] = env[key].replace(join(scratch, "home"), home);
    }
  }
  return env;
}

export function appLaunchEnvironment(env, opts, scratch, app, socketPath) {
  const launch = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(HOME|PATH|ZDOTDIR|CMUX|CMUXLAYER|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_)/u.test(key)));
  if (opts.privateAppHome) {
    // Shell .zshenv restores target CLI auth HOME; app-owned pointers stay private.
    const privateEnv = isolatedEnvironment({}, scratch, app, socketPath);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) launch[key] = privateEnv[key];
  }
  return launch;
}

export function shellStartup(env, opts) {
  return Object.entries(env).filter(([key]) => /^(HOME|PATH|ZDOTDIR|CMUX|CMUXLAYER|CODEX_HOME|CLAUDE_CONFIG_DIR|XDG_)/u.test(key))
    .map(([key, value]) => `export ${key}=${quote(value)}`).join("\n") + "\n" +
    // Bootstrap repoGolem for a fresh shell, generate legacy launchers, then
    // register the modern thin wrappers LAST. Nothing in target ~/.config changes.
    (opts.launcherMode && opts.target === "m1-gate" ? `source ${quote(join(env.HOME, ".config/ralphtools/golem-dispatch.zsh"))}\nsource ${quote(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH)}\nsource ${quote(join(env.HOME, ".config/ralphtools/golem-dispatch.zsh"))}\n` : "") + launcherCwdStartup(opts);
}

export function assertProcessIdentity(saved, observed) {
  if (!saved || !observed || saved !== observed) throw new Error("PID identity/start-time mismatch");
}
export function acquireNightlyLock(path, token) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, token); } finally { closeSync(fd); }
}
export function releaseNightlyLock(path, token) {
  if (readFileSync(path, "utf8") !== token) throw new Error("NIGHTLY lock ownership changed");
  unlinkSync(path);
}
const identity = pid => {
  try { return normalizeProcessIdentity(run("ps", ["-p", String(pid), "-o", "pid=,lstart=,comm="])); }
  catch { return null; }
};
const processes = () => run("ps", ["-axo", "pid=,comm="]).split("\n");
const production = () => processes().filter(line => {
  const executable = line.trim().replace(/^\d+\s+/u, "");
  return /\.app\/Contents\/MacOS\/[^/]+$/u.test(executable) && processBundleId(executable) === "com.cmuxterm.app";
}).map(line => identity(Number(line.trim().split(/\s/u)[0]))).sort();

export async function stopOwnedProcess({ pid, saved, target = "nightly", app = false, runReceipt }, receipt, observe = identity,
  signal = (id, sig) => process.kill(id, sig), sleep = pause, sessions = observeCmuxSessions) {
  if (!pid || !observe(pid)) return;
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    if (app && target === "m1-gate") {
      const classified = assertM1CmuxMutation(sessions(), runReceipt);
      if (runReceipt?.host !== hostname() || hostname() === "MacBook-Pro.local") throw new Error("cmux quit requires this run's dedicated M1 host receipt");
      if (!classified.some(row => row.pid === pid && row.identity === saved)) throw new Error("cmux PID identity/start-time mismatch");
    }
    assertProcessIdentity(saved, observe(pid));
    if (app) assertProcessTarget(run("ps", ["-p", String(pid), "-o", "comm="]), target);
    signal(pid, sig); receipt.push({ pid, signal: sig });
    if (app && target === "m1-gate" && runReceipt?.human_session_quit_approval?.pid === pid) runReceipt.human_session_quit_approval.applied = true;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!observe(pid)) { receipt.push({ pid, exited: true }); return; }
      await sleep(100);
    }
  }
  throw new Error(`owned process did not exit: ${pid}`);
}

export async function prepareM1AppMutation(opts, receipt, operation = "launch", sessions = observeCmuxSessions, stop = stopOwnedProcess) {
  if (hostname() !== opts.gateHost || hostname() === "MacBook-Pro.local" || !opts.gateHost) throw new Error("requires designated dedicated M1 host");
  receipt.host ??= hostname();
  if (receipt.host !== hostname()) throw new Error("M1 run receipt host mismatch");
  const approval = parseHumanSessionApproval(opts.humanSessionQuitApproved);
  if (approval) receipt.human_session_quit_approval = { ...approval, value: opts.humanSessionQuitApproved, applied: false };
  const classified = assertM1CmuxMutation(sessions(), receipt, "quit");
  for (const row of classified.filter(row => row.provenance === "human_session" && row.quit_approved)) {
    await stop({ pid: row.pid, saved: row.identity, app: true, target: "m1-gate", runReceipt: receipt }, receipt.processes);
    receipt.human_session_quit_approval.consumed = true;
  }
  assertM1CmuxMutation(sessions(), receipt, operation);
}

export async function guardedM1AppReplacement(opts, receipt, replace, sessions = observeCmuxSessions, stop = stopOwnedProcess) {
  await prepareM1AppMutation(opts, receipt, "replace", sessions, stop);
  assertM1CmuxMutation(sessions(), receipt, "replace"); // Re-observe after the awaited quit, immediately before swap.
  return replace();
}

export function rpc(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); socket.setEncoding("utf8"); let buffer = "", settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error(`${method} timeout`)), 3000);
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error(`${method} ended without reply`)));
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try { const message = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        finish(message.error || message.ok === false ? new Error(JSON.stringify(message)) : null, message.result);
      } catch (error) { finish(error); }
    });
  });
}

export function socketIsLive(path) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", error => {
      socket.destroy();
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolve(false);
      else reject(error);
    });
    socket.once("timeout", () => { socket.destroy(); reject(new Error("socket liveness unknown")); });
  });
}

export async function startSoakRuntime(opts, outputRoot) {
  opts = { ...opts, privateAppHome: opts.privateAppHome || opts.target === "m1-gate", launcherMode: opts.launcherMode || opts.target === "m1-gate" && !opts.dryRun };
  const app = opts.app, socketPath = opts.target === "m1-gate" ? "/tmp/cmux-soak-stable.sock" : NIGHTLY_SOCKET;
  const token = randomUUID(), lockPath = join(tmpdir(), "cmuxlayer-ratchet-nightly.lock");
  const receiptPath = join(outputRoot, `${token}.lifecycle.json`);
  const receipt = { status: "FAIL", launch_token: token, target: opts.target, release_gate: opts.target === "m1-gate" && !opts.dryRun && !opts.buildRoot, dry_run: opts.dryRun, host: hostname(), processes: [], violations: [], production_start: production(),
    production_pid_11224_start: identity(11224) };
  let lockOwned = false, nightly, daemon, scenarioRepo;
  mkdirSync(outputRoot, { recursive: true });
  let closing;
  const close = () => closing ??= (async () => {
    for (const owned of [daemon, nightly]) {
      try { if (owned) await stopOwnedProcess({ ...owned, runReceipt: receipt }, receipt.processes); }
      catch (error) { receipt.precondition ??= error.precondition; receipt.violations.push(String(error)); }
    }
    try { if (receipt.launch_receipt_path) receipt.launches = launchRecords(receipt.launch_receipt_path); }
    catch (error) { receipt.violations.push(`launch receipts: ${error}`); }
    try { if (scenarioRepo) { scenarioRepo.close(); receipt.scenario_repo.cleaned = !!scenarioRepo.run_dir; } }
    catch (error) { receipt.violations.push(String(error)); }
    try { receipt.production_end = production(); } catch (error) { receipt.violations.push(String(error)); }
    receipt.production_pid_11224_end = identity(11224);
    if (JSON.stringify(receipt.production_baseline ?? receipt.production_start) !== JSON.stringify(receipt.production_end) ||
      receipt.production_pid_11224_start !== receipt.production_pid_11224_end) receipt.violations.push("production PID/start-time changed");
    try { if (lockOwned) releaseNightlyLock(lockPath, token); } catch (error) { receipt.violations.push(String(error)); }
    receipt.status = receipt.error || receipt.violations.length ? "FAIL" : "PASS";
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
    return receipt;
  })();
  const onSignal = () => { receipt.error = "soak interrupted"; void (opts.onSignal?.(close) ?? close()).finally(() => process.exit(1)); };
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  try {
    if (opts.target === "m1-gate") {
      await prepareM1AppMutation(opts, receipt);
      receipt.production_baseline = production();
    }
    // Refuse stale production routing too, before starting an app or a model.
    receipt.app_target = assertAppTarget(app, { target: opts.target, gateHost: opts.gateHost, hostname: hostname(), socketPath });
    if (opts.target === "m1-gate") {
      const digest = createHash("sha256").update(readFileSync(opts.dmg)).digest("hex");
      if (digest !== PINNED_DMG_SHA256) throw new Error("pinned 0.64.22 DMG digest mismatch");
      receipt.dmg_sha256 = digest;
      const version = JSON.parse(readFileSync("/opt/homebrew/opt/cmuxlayer/libexec/package.json", "utf8")).version;
      if (!opts.dryRun && !opts.buildRoot && version !== "0.4.101") throw new Error("M1 gate requires installed cmuxlayer 0.4.101");
      receipt.installed_cmuxlayer_version = version;
    }
    const build = opts.buildRoot ? privateBuild(opts.buildRoot, opts.sha) : null;
    if (!build && realpathSync(opts.entry) !== realpathSync(INSTALLED_ENTRY)) throw new Error("soak requires the installed cmuxlayer entry");
    receipt.build = build ?? { entry: realpathSync(INSTALLED_ENTRY), kind: "installed" };
    acquireNightlyLock(lockPath, token); lockOwned = true;
    if (opts.target === "m1-gate") assertM1CmuxMutation(observeCmuxSessions(), receipt, "launch");
    if (processes().some(line => line.includes(`${app}/Contents/MacOS/`)) || await socketIsLive(socketPath)) {
      throw new Error("app or socket busy; operator cleanup required");
    }
    if (existsSync(socketPath)) {
      const stat = lstatSync(socketPath);
      if (!stat.isSocket() || stat.uid !== process.getuid()) throw new Error("unsafe stale socket path");
      receipt.stale_socket_at_launch = true; // Only the app handles its stale socket; never unlink it here.
    }
    const scratch = mkdtempSync(join(tmpdir(), "cmux-soak-"));
    for (const dir of ["home", "zdot", "state", "inbox"]) mkdirSync(join(scratch, dir), { mode: 0o700 });
    const env = launcherEnvironment(targetEnvironment(process.env, scratch, opts), opts.launcherMode ? opts.target : "native");
    if (opts.privateHome && opts.target !== "m1-gate") {
      const home = realpathSync(opts.privateHome), ownHome = realpathSync(homedir());
      if (home === ownHome || statSync(home).uid !== process.getuid() || (statSync(home).mode & 0o077)) throw new Error("private auth HOME must be separate, owned, and mode 0700");
      for (const dir of [".codex", ".claude", ".config", ".local", ".cache"]) {
        const path = join(home, dir);
        if (existsSync(path) && !realpathSync(path).startsWith(home + sep)) throw new Error("private auth HOME cannot redirect to production state");
      }
      for (const key of ["HOME", "CMUXLAYER_HARNESS_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
        env[key] = env[key].replace(join(scratch, "home"), home);
      }
    }
    writeFileSync(env.CMUXLAYER_FLEET_CONFIG, JSON.stringify({ coordinationDir: scratch, outbox: false, seatRegistryPath: join(scratch, "seats.yaml") }));
    if (opts.launcherMode && opts.target === "m1-gate") {
      if (!existsSync(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH)) throw new Error("target launcher registry missing");
      const { resolveLauncherNameFromRegistry } = await import("../dist/launcher-registry.js");
      receipt.expected_launchers = Object.fromEntries(["codex", "claude"].map(cli => [cli,
        resolveLauncherNameFromRegistry(opts.repo ?? "cmuxlayer", cli, { sourcePath: env.CMUXLAYER_LAUNCHER_REGISTRY_PATH })]));
      if (!existsSync(join(env.HOME, ".config/ralphtools/golem-dispatch.zsh"))) throw new Error("target launcher dispatcher missing");
    } else writeFileSync(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH, "");
    scenarioRepo = createScenarioRepo(env, opts, scratch, token, lockPath);
    receipt.scenario_repo = { path: scenarioRepo.path, run_dir: scenarioRepo.run_dir, cleaned: false };
    const shellOpts = { ...opts, launchCwd: scenarioRepo.path, launchers: receipt.expected_launchers, launchReceipt: join(scratch, "launches.jsonl") };
    // App-created shells use only the private startup, including the final cwd wrapper.
    writeFileSync(join(scratch, "zdot/.zshenv"), shellStartup(env, shellOpts), { mode: 0o600 });
    receipt.launch_receipt_path = shellOpts.launchReceipt;
    receipt.argv_preflight = checkLauncherArgv(env, shellOpts, receipt.expected_launchers);
    receipt.preflight_launches = launchRecords(shellOpts.launchReceipt);
    writeFileSync(shellOpts.launchReceipt, "", { mode: 0o600 });
    const launchEnv = appLaunchEnvironment(env, opts, scratch, app, socketPath);
    if (opts.privateAppHome) receipt.app_home = launchEnv.HOME;
    run("/usr/bin/open", ["-g", "-n", "-a", app, ...Object.entries(launchEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--args", "--soak-launch-token", token]);
    const deadline = Date.now() + 10_000;
    while (!nightly && Date.now() < deadline) {
      for (const line of processes().filter(line => line.includes(`${app}/Contents/MacOS/cmux`))) {
        const pid = Number(line.trim().split(/\s/u)[0]);
        if (run("ps", ["-p", String(pid), "-o", "args="]).includes(token)) {
          assertProcessTarget(run("ps", ["-p", String(pid), "-o", "comm="]), opts.target);
          nightly = { pid, saved: identity(pid), start_time: run("ps", ["-p", String(pid), "-o", "lstart="]), launch_token: token, app: true, target: opts.target }; break;
        }
      }
      if (!nightly) await pause(100);
    }
    if (!nightly) throw new Error("launch-token NIGHTLY PID not found");
    receipt.app_process = nightly; receipt.scratch = scratch;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { await rpc(socketPath, "system.ping"); ready = true; } catch { await pause(100); }
    }
    if (!ready) throw new Error("NIGHTLY socket not ready");
    // Confirm socket ownership; a responding socket by itself cannot establish app identity.
    if (!run("lsof", ["-n", "-U", "-a", "-p", String(nightly.pid)]).includes(socketPath)) throw new Error("NIGHTLY socket PID ownership unverified");
    const workspace = await rpc(socketPath, "workspace.create", { cwd: scenarioRepo.path, initial_command: opts.dryRun ? `/bin/sh -c 'printf SOAK_DRY_${token}; exec /bin/cat'` : "/bin/zsh -l" });
    if (!workspace.workspace_id) throw new Error("NIGHTLY workspace identity missing");
    receipt.workspace = workspace;
    if (opts.dryRun) {
      let text = "";
      for (let attempt = 0; attempt < 30; attempt += 1) {
        text = (await rpc(socketPath, "surface.read_text", { workspace_id: workspace.workspace_id, surface_id: workspace.surface_id })).text ?? "";
        if (text.includes(`SOAK_DRY_${token}`)) break;
        await pause(100);
      }
      if (!text.includes(`SOAK_DRY_${token}`)) throw new Error("NIGHTLY dry-run screen probe missing");
      receipt.probe_seen = true;
    }
    // Start the installed daemon explicitly, so teardown never guesses which PID it owns.
    const child = spawn("/opt/homebrew/opt/node/bin/node", [build?.daemon ?? "/opt/homebrew/opt/cmuxlayer/libexec/dist/daemon.js"],
      { env, cwd: scenarioRepo.path, stdio: ["ignore", "ignore", "inherit"] });
    let spawnError;
    child.on("error", error => { spawnError = error; });
    // Capture ownership before the first async readiness wait (including interrupts).
    if (child.pid) daemon = { pid: child.pid, saved: identity(child.pid) };
    const daemonDeadline = Date.now() + 10_000;
    while (!existsSync(env.CMUXLAYER_DAEMON_SOCKET) && !spawnError && child.exitCode === null && Date.now() < daemonDeadline) await pause(100);
    if (spawnError || !daemon?.saved || !existsSync(env.CMUXLAYER_DAEMON_SOCKET)) throw new Error("private installed daemon not ready");
    receipt.daemon = daemon;
    return { env, workspace: workspace.workspace_id, cwd: scenarioRepo.path, receiptPath, receipt, close };
  } catch (error) {
    if (error.precondition) receipt.precondition = error.precondition;
    receipt.error = String(error); await close();
    throw Object.assign(new Error(`${error}; lifecycle receipt: ${receiptPath}`), { precondition: error.precondition });
  }
}
