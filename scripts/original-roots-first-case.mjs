// One captured Codex spawn through the unchanged original candidate. No app launch.
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { userInfo, hostname } from 'node:os';

export const HEAD = 'd539fbefc75327375d144d3108ce1b7a0157d225';
export const TREE = 'e5cf40901e80897319f9a9daea0c9982fa604294';
export const MANIFEST = 'b06ffeb7b29ae1933b385e54f6ac08f365080744ceb69b063608d38a0a5b9c4f';
const captures = {
  'scripts/ratchet-fixture-tui.mjs': '0d2e8c7fb4bbac2f9e4d93a5c93fd4446b20abe23651babd6dd3c7907cacf55c',
  'tests/fixtures/composer-overlays/codex-boot.txt': '730290786cd4f950e1b8ccab6013b3507c3f1126a8caf91ccf7fc26aa19e9c6a',
  'tests/fixtures/codex-0.157/idle-empty.txt': '6a0a73ee452f31bd3770656d385c209368694a01542cc67d5a80590547f3d508',
  'tests/fixtures/codex-0.157/idle-submitted-working.txt': 'ae007df6c2fc0338dacdfd8c06039786a0a09ecd1f9cf81a3ac55247c6bf1371',
};
const self = fileURLToPath(import.meta.url);
const check = (yes, why) => { if (!yes) throw Error(why); };
const hash = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const write = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value ?? '');
const safePath = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && resolve(value) === value;

export function verifyCandidate(candidate, manifestPath) {
  check(fs.realpathSync(candidate) === candidate, 'candidate canonical path required');
  check(hash(manifestPath) === MANIFEST, 'original dist manifest changed');
  const manifest = json(manifestPath);
  check(Object.keys(manifest).length === 390, 'original 390 dist entries required');
  for (const [relative, digest] of Object.entries({ ...manifest, ...captures })) {
    check(/^(dist\/|scripts\/ratchet-fixture-tui\.mjs$|tests\/fixtures\/)/.test(relative) && !relative.includes('..'), 'manifest path refused');
    const path = join(candidate, relative), stat = fs.lstatSync(path);
    check(stat.isFile() && fs.realpathSync(path) === path && hash(path) === digest, 'candidate bytes changed: ' + relative);
  }
  const distFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    check(entry.isFile() || entry.isDirectory(), 'nonregular staged dist entry');
    const path = join(dir, entry.name); return entry.isDirectory() ? distFiles(path) : [path];
  });
  check(distFiles(join(candidate, 'dist')).length === 390, 'staged dist has extra/missing entries');
  check(json(join(candidate, 'package.json')).version === '0.4.101', 'candidate package version changed');
  return { head: HEAD, tree: TREE, manifest_sha256: MANIFEST, dist_entries: 390, fixture: 'captured Codex contract' };
}

export function validateConfig(c, now = Date.now()) {
  check(c.executionApproved === true && c.coordinationReceipt?.status === 'ACCEPTED' && c.coordinationReceipt.dispatchId && c.coordinationReceipt.threadId === 'mcp:7bea335d-d936-4f31-a1b3-22e958f09f18' && c.host && c.productHead === HEAD && c.productTree === TREE, 'parent execution/window/product approval required');
  check(uuid(c.runId) && uuid(c.workspaceId) && uuid(c.anchorSurfaceId) && c.anchorPaneRef?.startsWith('pane:'), 'exact run/workspace/surface/pane identities required');
  for (const key of ['root', 'candidate', 'manifestPath', 'node', 'cmux', 'socket']) check(safePath(c[key]), 'unsafe path: ' + key);
  check(c.root === '/Users/happycampr/Library/Caches/cmuxlayer-firstcase-' + c.runId, 'owned501 run root required');
  check(c.candidate.startsWith('/Users/happycampr/Library/Caches/') && !c.candidate.startsWith(c.root + '/'), 'separate staged candidate required');
  check(c.marker === 'FIRSTCASE_' + c.runId && c.uid === 501 && c.socketIdentity?.uid === 501 && c.appProcess?.uid === 501 && c.appProcess.start && c.appProcess.argv, 'account/run/socket/app binding required');
  for (const key of ['nodeSha256', 'cmuxSha256', 'runnerSha256', 'proxyRunnerSha256']) check(/^[a-f0-9]{64}$/.test(c[key] ?? ''), 'pinned executable hash required: ' + key);
  const begin = Date.parse(c.notBeforeUTC), end = Date.parse(c.mutationEndUTC), deadline = Date.parse(c.deadlineUTC);
  check(Number.isFinite(begin) && now >= begin && now < end && deadline - end >= 60000, 'current mutation window with cleanup reserve required');
  return c;
}

export function windowBudget(c, minimum = 1, cap = 60000) {
  const now = Date.now(); validateConfig(c, now);
  const remaining = Math.floor(Date.parse(c.mutationEndUTC) - now);
  check(remaining >= minimum, 'insufficient remaining mutation budget: ' + minimum);
  return Math.min(cap, remaining);
}

// Abort bounds the caller; it does not establish that the remote effect was absent.
export async function withinWindow(c, label, operation, retainUnknown, cap = 60000) {
  const budget = windowBudget(c, 1, cap), controller = new AbortController();
  let expired = false, timer;
  const pending = Promise.resolve().then(() => {
    const remaining = windowBudget(c, 1, budget);
    return operation({ timeout: remaining, maxTotalTimeout: remaining, resetTimeoutOnProgress: false, signal: controller.signal });
  });
  const expiration = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      retainUnknown(label, { outcome: 'UNKNOWN', remote_absence: 'UNPROVED' });
      controller.abort(); reject(Error('absolute mutation/request deadline expired: ' + label));
    }, Math.max(0, Math.min(budget, Date.parse(c.mutationEndUTC) - Date.now())));
  });
  pending.then(value => { if (expired) retainUnknown(label, { outcome: 'LATE_ACK', value, remote_absence: 'UNPROVED' }); },
    error => { if (expired) retainUnknown(label, { outcome: 'LATE_ERROR', error: String(error), remote_absence: 'UNPROVED' }); });
  try {
    const value = await Promise.race([pending, expiration]);
    if (Date.now() >= Date.parse(c.mutationEndUTC)) {
      expired = true; retainUnknown(label, { outcome: 'LATE_ACK', value, remote_absence: 'UNPROVED' });
      throw Error('response arrived after mutation window: ' + label);
    }
    windowBudget(c); return value;
  } catch (error) {
    if (!expired) retainUnknown(label, { outcome: 'UNKNOWN', error: String(error), remote_absence: 'UNPROVED' });
    throw error;
  } finally { clearTimeout(timer); }
}

export function parseLaunchArgs(args, root) {
  let cwd;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['-s', '--worker'].includes(arg)) continue;
    if (arg === '-w') { check(!cwd, 'duplicate cwd'); cwd = args[++i]; }
    else if (arg === '-m') check(args[++i] === 'gpt-6-luna', 'fixture model metadata mismatch');
    else if (arg === '-E') check(args[++i] === 'low', 'fixture effort metadata mismatch');
    else throw Error('unexpected fixture launcher arg: ' + arg);
  }
  check(cwd === root + '/firstcase/.worktrees/owned', 'launch must use exact owned worktree');
  return cwd;
}

export function assertCaseEvidence(c, boot, event, launch, panes, completion) {
  const expected = c.marker + ' ; cmuxlayer contract for ' + boot.agent_id + ': Read and follow ' + boot.contract_path;
  check(boot.ok === true && boot.coordination_footer_delivered === true && boot.boot_prompt_receipt?.submit_verified === true && boot.boot_prompt_receipt?.delivery_id, 'verified folded contract receipt missing');
  check(completion?.ok === true && completion.delivery_id === boot.boot_prompt_receipt.delivery_id && completion.terminal === true && completion.submitted === true && completion.submit_verified === true && completion.delivery_state === 'submitted', 'correlated terminal verified submission required');
  check(event.submissions?.length === 1 && event.submissions[0] === expected && event.draft === '', 'one exact submitted contract with empty draft required');
  check(event.keys?.filter(k => k === 'Return').length === 1 && !event.keys.includes('LF'), 'one boot Return and zero LF required');
  check(launch.cwd === c.root + '/firstcase/.worktrees/owned' && boot.worktree?.path === launch.cwd, 'actual fixture cwd differs from worktree receipt');
  const anchor = panes.panes.find(p => p.ref === c.anchorPaneRef);
  const child = panes.panes.find(p => p.surface_refs?.includes(boot.surface_id) || p.surface_ids?.includes(boot.surface_uuid));
  check(panes.panes.length === 2 && anchor?.index === 0 && child?.index === 1 && child !== anchor, 'owned left anchor/right worker placement not proved');
  return { behavior: 'PASS', claims: ['serving spawn', 'initialization', 'owned worktree cwd', 'folded contract once', 'two-pane placement'], provider_tokens: 0 };
}

// Local PID/start/argv observations, never global enumeration or removal authority.
export function processIdentity(pid) {
  check(Number.isSafeInteger(pid) && pid > 1, 'PID refused');
  const field = name => execFileSync('/bin/ps', ['-p', String(pid), '-o', name + '='], { encoding: 'utf8', timeout: 2000 }).trim();
  return { pid, uid: Number(field('uid')), start: field('lstart'), executable: field('comm'), argv: field('args') };
}
export function sameProcess(a, b) {
  return a?.uid === 501 && a.start && ['pid', 'uid', 'start', 'executable', 'argv'].every(k => a[k] === b?.[k]);
}
const identityFor = (pid, argv) => {
  const row = processIdentity(pid);
  check(row.uid === 501 && row.argv === argv && row.start, 'owned creation process identity unavailable');
  return row;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, end) { while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(Math.max(0, Math.min(100, end - Date.now()))); } throw Error('bounded evidence wait expired'); }

async function fixture(root, args) {
  const c = json(join(root, 'config.json'));
  validateConfig(c);
  check(process.getuid() === 501 && hash(self) === c.runnerSha256, 'fixture identity changed');
  const cwd = parseLaunchArgs(args, root); windowBudget(c, 5000); process.chdir(cwd);
  const parent = identityFor(process.pid, [c.node, self, '--fixture', root, ...args].join(' '));
  write(join(root, 'fixture-parent.json'), parent);
  const tui = join(c.candidate, 'scripts/ratchet-fixture-tui.mjs');
  check(hash(tui) === captures['scripts/ratchet-fixture-tui.mjs'], 'fixture source changed');
  const argv = [tui, 'contract', join(root, 'events.json')];
  windowBudget(c, 5000);
  let child, sequence = 0;
  await withinWindow(c, 'fixture-creation', () => new Promise((ok, no) => {
    windowBudget(c, 5000);
    child = spawn(c.node, argv, { cwd, env: { HOME: join(root, 'home'), PATH: '/usr/bin:/bin' }, stdio: 'inherit' });
    child.once('spawn', () => ok({ pid: child.pid, argv: [c.node, ...argv] })); child.once('error', no);
  }),
    (label, value) => write(join(root, 'fixture-uncertain-' + (++sequence) + '.json'), { label, ...value }));
  write(join(root, 'fixture-child-ack.json'), { pid: child.pid, argv: [c.node, ...argv] });
  const identity = identityFor(child.pid, [c.node, ...argv].join(' '));
  write(join(root, 'launch.json'), { cwd, argv: args, parent, child: identity });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

async function native(c) {
  windowBudget(c, 60000);
  check(process.platform === 'darwin' && process.arch === 'arm64' && hostname() === c.host && process.getuid() === 501 && fs.lstatSync('/dev/console').uid === 501 && userInfo().homedir === '/Users/happycampr', 'M1 normal account identity mismatch');
  check(hash(self) === c.runnerSha256 && hash(c.node) === c.nodeSha256 && hash(c.cmux) === c.cmuxSha256, 'runner/node/cmux bytes changed');
  const strictProxy = join(dirname(self), 'original-roots-first-case.proxy.mjs');
  check(hash(strictProxy) === c.proxyRunnerSha256, 'strict private proxy bytes changed');
  const identity = verifyCandidate(c.candidate, c.manifestPath);
  const socketCheck = () => {
    const s = fs.lstatSync(c.socket);
    check(s.isSocket() && !s.isSymbolicLink() && ['uid', 'dev', 'ino'].every(k => s[k] === c.socketIdentity[k]), 'cmux socket identity changed');
  };
  socketCheck(); check(sameProcess(c.appProcess, processIdentity(c.appProcess.pid)), 'existing cmux process baseline changed');
  windowBudget(c, 60000); fs.mkdirSync(c.root, { mode: 0o700 });
  windowBudget(c); write(join(c.root, 'config.json'), c);
  const receipt = { status: 'FAIL', product: identity, run: c.runId, marker: c.marker, requests: [], cleanup: [], retained: c.root, native_gui_focus: 'UNPROVED' };
  let daemon, daemonIdentity, proxyIdentity, transport, client, backend, launch;
  const record = (name, value) => write(join(c.root, name + '.json'), value);
  const guard = () => { validateConfig(c); socketCheck(); check(sameProcess(c.appProcess, processIdentity(c.appProcess.pid)), 'existing cmux process baseline changed'); };
  const effect = (operation, minimum = 1) => { guard(); const budget = windowBudget(c, minimum); return operation(budget); };
  let unknownSequence = 0;
  const retainUnknown = (label, value) => {
    try { record('uncertain-' + (++unknownSequence), { label, observedUTC: new Date().toISOString(), ...value }); }
    catch (error) { (receipt.uncertainty_retention_errors ??= []).push({ label, error: String(error), ...value }); }
  };
  try {
    const { CmuxSocketClient } = await import(pathToFileURL(join(c.candidate, 'dist/cmux-socket-client.js')));
    effect(() => { backend = new CmuxSocketClient({ socketPath: c.socket }); });
    const workspaces = await withinWindow(c, 'baseline-workspaces', () => backend.listWorkspaces(), retainUnknown);
    check(workspaces.workspaces.some(w => w.id === c.workspaceId && w.title === c.marker), 'owned workspace UUID/title absent');
    const before = await withinWindow(c, 'baseline-panes', () => backend.listPanes({ workspace: c.workspaceId }), retainUnknown);
    const surfaces = await withinWindow(c, 'baseline-surfaces', () => backend.listPaneSurfaces({ workspace: c.workspaceId, pane: c.anchorPaneRef }), retainUnknown);
    check(before.panes.length === 1 && before.panes[0].ref === c.anchorPaneRef && surfaces.surfaces.length === 1 && surfaces.surfaces[0].id === c.anchorSurfaceId, 'one owned anchor pane/surface required');
    record('baseline', { socket: c.socketIdentity, workspaces, before, surfaces }); guard();
    for (const dir of ['bin', 'home', 'state', 'inbox', 'firstcase']) effect(() => fs.mkdirSync(join(c.root, dir), { mode: 0o700 }));
    const repo = join(c.root, 'firstcase');
    const env = { HOME: join(c.root, 'home'), PATH: join(c.root, 'bin') + ':/usr/bin:/bin',
      CMUX_SOCKET_PATH: c.socket, CMUX_ALLOW_SOCKET_OVERRIDE: '1', CMUX_BUNDLED_CLI_PATH: c.cmux,
      CMUXLAYER_DAEMON_SOCKET: join(c.root, 'd.sock'), CMUXLAYER_STATE_DIR: join(c.root, 'state'), CMUXLAYER_FIRSTCASE_ROOT: c.root,
      CMUXLAYER_INBOX_BASE_DIR: join(c.root, 'inbox'), CMUXLAYER_HARNESS_HOME: join(c.root, 'home'),
      CODEX_HOME: join(c.root, 'home/.codex'), CLAUDE_CONFIG_DIR: join(c.root, 'home/.claude'),
      CMUXLAYER_CONFIG_FILE: join(c.root, 'no-config'), CMUXLAYER_FLEET_CONFIG: join(c.root, 'fleet.json'),
      CMUXLAYER_LAUNCHER_REGISTRY_PATH: join(c.root, 'launchers.zsh'), CMUXLAYER_REQUIRE_LAUNCHER_REGISTRY: '1' };
    effect(() => fs.writeFileSync(env.CMUXLAYER_FLEET_CONFIG, '{}', { flag: 'wx', mode: 0o600 }));
    effect(() => fs.writeFileSync(env.CMUXLAYER_LAUNCHER_REGISTRY_PATH, 'repoGolem ' + join(c.root, 'bin/firstcase') + ' ' + repo + '\n', { flag: 'wx', mode: 0o600 }));
    const launcher = '#!/bin/sh\nexec /usr/bin/env -i HOME=' + quote(env.HOME) + ' PATH=/usr/bin:/bin ' + quote(c.node) + ' ' + quote(self) + ' --fixture ' + quote(c.root) + ' "$@"\n';
    effect(() => fs.writeFileSync(join(c.root, 'bin/firstcaseCodex'), launcher, { flag: 'wx', mode: 0o700 }));
    effect(() => fs.writeFileSync(join(c.root, 'bin/codex'), '#!/bin/sh\nif [ "$#" = 2 ] && [ "$1" = debug ] && [ "$2" = models ]; then printf \'{"models":["gpt-6-luna"],"fixture":true}\\n\'; else exit 86; fi\n', { flag: 'wx', mode: 0o700 }));
    for (const args of [['init', repo], ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-m', c.marker]]) effect(budget => execFileSync('/usr/bin/git', args, { env, timeout: Math.min(10000, budget) }));
    effect(() => fs.writeFileSync(join(repo, '.git/info/exclude'), '\n.worktrees/\n', { flag: 'a', mode: 0o600 }));
    const log = effect(() => fs.openSync(join(c.root, 'daemon-stderr.log'), 'wx', 0o600));
    try {
      guard(); windowBudget(c, 15000);
      await withinWindow(c, 'daemon-creation', () => new Promise((ok, no) => {
        windowBudget(c, 15000);
        daemon = spawn(c.node, [join(c.candidate, 'dist/daemon.js')], { cwd: c.candidate, env, stdio: ['ignore', 'ignore', log] });
        daemon.once('spawn', () => ok({ pid: daemon.pid, argv: [c.node, join(c.candidate, 'dist/daemon.js')] })); daemon.once('error', no);
      }), retainUnknown);
    }
    finally { fs.closeSync(log); }
    receipt.daemon_creation_ack = { pid: daemon.pid, argv: [c.node, join(c.candidate, 'dist/daemon.js')] };
    daemonIdentity = identityFor(daemon.pid, c.node + ' ' + join(c.candidate, 'dist/daemon.js')); record('daemon-identity', daemonIdentity);
    await until(() => fs.existsSync(env.CMUXLAYER_DAEMON_SOCKET), Math.min(Date.now() + 10000, Date.parse(c.mutationEndUTC)));
    const require = createRequire(join(c.candidate, 'package.json'));
    const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
    const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));
    check(daemonIdentity && daemon.exitCode === null && sameProcess(daemonIdentity, processIdentity(daemon.pid)), 'private daemon missing before proxy; no fallback');
    check(fs.lstatSync(env.CMUXLAYER_DAEMON_SOCKET).isSocket(), 'private daemon endpoint missing before proxy');
    client = new Client({ name: 'original-roots-first-case', version: '1' });
    transport = new StdioClientTransport({ command: c.node, args: [strictProxy], env });
    guard(); windowBudget(c, 5000);
    const connected = withinWindow(c, 'proxy-connect', options => client.connect(transport, options), retainUnknown, 5000).then(() => null, error => error);
    await until(() => transport.pid, Math.min(Date.now() + 5000, Date.parse(c.mutationEndUTC)));
    receipt.proxy_creation_ack = { pid: transport.pid, argv: [c.node, strictProxy] };
    proxyIdentity = identityFor(transport.pid, c.node + ' ' + strictProxy); record('proxy-identity', proxyIdentity);
    const connectFailure = await connected; if (connectFailure) throw connectFailure;
    const call = async (name, args) => {
      guard(); const raw = await withinWindow(c, 'request-' + (receipt.requests.length + 1) + '-' + name,
        options => client.callTool({ name, arguments: args }, undefined, options), retainUnknown);
      const value = raw.structuredContent ?? JSON.parse(raw.content.find(i => i.type === 'text').text);
      receipt.requests.push({ name, args, value }); record('request-' + receipt.requests.length, { name, args, raw }); guard(); return value;
    };
    const health = await call('control_health', { detail: 'full' });
    check(health.ok && health.health?.current_process?.pid === daemon.pid && health.socket_path === c.socket, 'request not served by private candidate daemon');
    guard(); windowBudget(c, 15000);
    const boot = await call('spawn_agent', { repo: 'firstcase', cli: 'codex', model: 'gpt-6-luna', effort: 'low',
      role: 'worker', authority: 'worker', placement: 'right', workspace: c.workspaceId, worktree: { name: 'owned' },
      prompt: c.marker, focus: false, force_new: true, boot_prompt_timeout_ms: 10000, verbose: true });
    receipt.boot = boot;
    await until(() => fs.existsSync(join(c.root, 'launch.json')) && fs.existsSync(join(c.root, 'events.json')), Math.min(Date.now() + 5000, Date.parse(c.mutationEndUTC)));
    launch = json(join(c.root, 'launch.json')); const event = json(join(c.root, 'events.json'));
    check(event.pid === launch.child.pid && sameProcess(launch.child, processIdentity(event.pid)), 'fixture PID not attributable');
    guard(); const panes = await withinWindow(c, 'after-panes', () => backend.listPanes({ workspace: c.workspaceId }), retainUnknown); record('after-panes', panes); record('fixture-evidence', { launch, event });
    await call('read_screen', { surface: boot.surface_id, workspace: c.workspaceId, raw: true, scrollback: false });
    check(boot.boot_prompt_receipt?.delivery_id, 'original delivery ID missing');
    const completed = await call('wait_for', { delivery_id: boot.boot_prompt_receipt.delivery_id, timeout_ms: 1000 });
    receipt.case = assertCaseEvidence(c, boot, event, launch, panes, completed); receipt.status = 'CASE_PASS_RESTORATION_PENDING';
  } catch (error) { receipt.error = String(error); }
  finally {
    try {
      if (transport?.pid) {
        check(proxyIdentity, 'proxy initial identity unavailable; retained');
        check(sameProcess(proxyIdentity, processIdentity(transport.pid)), 'proxy identity changed; retained');
        await client.close(); receipt.cleanup.push({ identity: proxyIdentity, sdk_close_completed: true });
      }
    } catch (error) { receipt.cleanup.push({ client_close_error: String(error), retained: true }); }
    backend?.disconnect();
    try { if (!launch && fs.existsSync(join(c.root, 'launch.json'))) launch = json(join(c.root, 'launch.json')); }
    catch (error) { receipt.cleanup.push({ fixture_receipt_error: String(error), retained: true }); }
    for (const row of [launch?.child, launch?.parent, daemonIdentity].filter(Boolean)) {
      try {
        check(sameProcess(row, processIdentity(row.pid)), 'process identity changed; retained'); process.kill(row.pid, 'SIGTERM');
        let absent = false;
        for (let i = 0; i < 20; i++) { await pause(100); try { process.kill(row.pid, 0); } catch (e) { if (e.code === 'ESRCH') { absent = true; break; } throw e; } }
        receipt.cleanup.push({ identity: row, signal_requested: true, absence: absent ? 'OBSERVED' : 'UNVERIFIED' });
      }
      catch (error) { receipt.cleanup.push({ identity: row, stop_error: String(error), retained: true }); }
    }
    receipt.cleanup_proposal = { workspace: c.workspaceId, anchor: c.anchorSurfaceId, child: receipt.boot?.surface_uuid ?? receipt.boot?.surface_id,
      socket: c.socketIdentity, paths: c.root, topology_close: 'PARENT_REVALIDATION_REQUIRED', artifact_deletion: 'NOT_AUTHORIZED_Q2_UNANSWERED', settings: 'NO_RUNNER_SETTINGS_WRITES' };
    record('result', receipt); console.log(JSON.stringify({ status: receipt.status, evidence: join(c.root, 'result.json'), cleanup: 'REQUIRES_READBACK', artifacts: 'RETAINED' }));
  }
  if (receipt.status === 'FAIL') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const [mode, path, ...args] = process.argv.slice(2);
  if (mode === '--offline-check') console.log(JSON.stringify(verifyCandidate(path, args[0])));
  else if (mode === '--fixture') await fixture(path, args);
  else if (mode === '--execute') await native(json(path));
  else throw Error('Use --offline-check candidate manifest OR --execute parent-reviewed-config; no implicit execution');
}
