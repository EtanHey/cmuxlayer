// Offline only: no sockets, app/process inventory, signals or fixture PTY.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateConfig, parseLaunchArgs, assertCaseEvidence as caseEvidence, sameProcess, verifyCandidate, HEAD, TREE } from './original-roots-first-case.mjs';
const [candidate, manifest] = process.argv.slice(2);
assert(candidate && manifest, 'exact original candidate and manifest required');
let count = 0;
const test = (name, run) => { run(); count++; console.log('PASS ' + name); };
const id = '11111111-1111-4111-8111-111111111111';
const now = Date.now(), stamp = delta => new Date(now + delta).toISOString();
const root = '/Users/happycampr/Library/Caches/cmuxlayer-firstcase-' + id;
const cfg = { executionApproved: true, coordinationReceipt: { status: 'ACCEPTED', dispatchId: 'synthetic-not-host-authority', threadId: 'mcp:7bea335d-d936-4f31-a1b3-22e958f09f18' }, productHead: HEAD, productTree: TREE,
  runId: id, workspaceId: id, anchorSurfaceId: id, anchorPaneRef: 'pane:1', marker: 'FIRSTCASE_' + id,
  root, candidate: '/Users/happycampr/Library/Caches/staged-candidate', manifestPath: '/Users/happycampr/Library/Caches/dist-manifest.json',
  node: '/opt/homebrew/bin/node', cmux: '/Applications/cmux.app/Contents/Resources/bin/cmux', socket: '/tmp/observed.sock',
  host: 'synthetic', uid: 501, socketIdentity: { uid: 501, dev: 1, ino: 2 },
  appProcess: { pid: 44, uid: 501, start: 'start-A', executable: '/Applications/cmux.app/Contents/MacOS/cmux', argv: 'observed-app' },
  nodeSha256: 'a'.repeat(64), cmuxSha256: 'b'.repeat(64), runnerSha256: 'c'.repeat(64),
  notBeforeUTC: stamp(-1000), mutationEndUTC: stamp(10000), deadlineUTC: stamp(70000) };
test('future execution requires approved current identity/window', () => assert.equal(validateConfig(cfg, now), cfg));
for (const [name, patch] of Object.entries({ noApproval: { executionApproved: false }, expired: { mutationEndUTC: stamp(-1) },
  noReserve: { deadlineUTC: stamp(11000) }, oldProduct: { productHead: 'f'.repeat(40) }, globalRoot: { root: '/Users/happycampr' },
  wrongUID: { uid: 502 }, missingSocket: { socketIdentity: null }, unknownApp: { appProcess: null }, guessedPane: { anchorPaneRef: 'current' }, wrongThread: { coordinationReceipt: { status: 'ACCEPTED', dispatchId: 'synthetic', threadId: 'other' } } })) {
  test('refuses ' + name, () => assert.throws(() => validateConfig({ ...cfg, ...patch }, now)));
}
const cwd = root + '/firstcase/.worktrees/owned';
test('exact original launcher argv reaches owned cwd', () => assert.equal(parseLaunchArgs(['-s', '--worker', '-m', 'gpt-6-luna', '-E', 'low', '-w', cwd], root), cwd));
for (const args of [['--resume', id], ['-w', '/Users/happycampr/Gits/user'], ['-w', cwd, '-w', cwd], ['-m', 'unexpected', '-w', cwd]]) {
  test('unexpected/provider/resume argv refuses', () => assert.throws(() => parseLaunchArgs(args, root)));
}
const boot = { ok: true, agent_id: 'firstcaseCodex-test', contract_path: root + '/inbox/test/contract.md', surface_id: 'surface:2', surface_uuid: id,
  coordination_footer_delivered: true, boot_prompt_receipt: { delivery_id: id, submit_verified: true }, worktree: { path: cwd } };
const completion = { ok: true, delivery_id: id, terminal: true, submitted: true, submit_verified: true, delivery_state: 'submitted' };
const assertCaseEvidence = (...args) => caseEvidence(...args, completion);
const expected = cfg.marker + ' ; cmuxlayer contract for ' + boot.agent_id + ': Read and follow ' + boot.contract_path;
const event = { submissions: [expected], draft: '', keys: ['Return'] };
const panes = { panes: [{ ref: 'pane:1', index: 0, surface_refs: ['surface:1'] }, { ref: 'pane:2', index: 1, surface_refs: ['surface:2'] }] };
test('first serving case requires exact compound proof', () => assert.equal(assertCaseEvidence(cfg, boot, event, { cwd }, panes).behavior, 'PASS'));
for (const patch of [{ submissions: [expected, expected] }, { submissions: ['footer only'] }, { draft: 'retained footer' }, { keys: ['Return', 'LF'] }, { keys: [] }]) {
  test('refuses partial/duplicate/draft/key evidence', () => assert.throws(() => assertCaseEvidence(cfg, boot, { ...event, ...patch }, { cwd }, panes)));
}
test('pending boot never passes', () => assert.throws(() => assertCaseEvidence(cfg, { ...boot, boot_prompt_receipt: { submit_verified: null } }, event, { cwd }, panes)));
test('wrong actual cwd never passes', () => assert.throws(() => assertCaseEvidence(cfg, boot, event, { cwd: root }, panes)));
test('reversed placement never passes', () => assert.throws(() => assertCaseEvidence(cfg, boot, event, { cwd }, { panes: panes.panes.map(p => ({ ...p, index: 1 - p.index })) })));
const pid = { pid: 33, uid: 501, start: 'A', executable: '/node', argv: '/node fixture' };
test('same owned process can be considered for stop', () => assert(sameProcess(pid, { ...pid })));
for (const patch of [{ start: 'B' }, { uid: 502 }, { executable: '/other' }, { argv: '/node user' }, { pid: 34 }]) {
  test('reused/foreign process never matches', () => assert(!sameProcess(pid, { ...pid, ...patch })));
}
test('all original candidate/dist/capture hashes match', () => assert.equal(verifyCandidate(candidate, manifest).dist_entries, 390));
// Actual frozen product resolver and command generator; no mocked launcher label.
const { resolveSpawnLaunchPlan, buildLaunchCommand } = await import(pathToFileURL(candidate + '/dist/engine/launch-command.js'));
test('original product resolves an absolute private fixture executable', () => {
  const plan = resolveSpawnLaunchPlan('firstcase', 'codex', { registryOptions: { entries: [{ prefix: root + '/bin/firstcase', path: root + '/firstcase', repoBasename: 'firstcase' }] } });
  assert.equal(plan.launchMode, 'launcher'); assert.equal(plan.launcherName, root + '/bin/firstcaseCodex');
  const command = buildLaunchCommand('codex', 'firstcase', 'gpt-6-luna', plan.launcherName, { cwd, effort: 'low', authority: 'worker' });
  assert(command.includes(plan.launcherName + ' ')); assert(command.includes("-w '" + cwd + "'")); assert(!command.includes(' brainlayerCodex'));
});
test('retained Claude capture is separately real and not claimed as first execution', () => {
  const text = readFileSync(candidate + '/tests/fixtures/composer-overlays/claude-boot.txt', 'utf8');
  assert(text.includes('Claude Code v2.1.289')); assert(text.includes('0 tokens'));
});
console.log(JSON.stringify({ status: 'PASS', controls: count, native: 'UNRUN', provider_calls: 0 }));
