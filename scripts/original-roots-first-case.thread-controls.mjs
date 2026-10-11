// Literal owned-thread admission only; no native operations or subprocesses.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, dirname} from 'node:path';
import {validateConfig, HEAD, TREE} from './original-roots-first-case.mjs';
import {validatePlan, validateSocketWitness, socketWitnessPath, PINS} from './inside-cmux-bootstrap.mjs';
const packet = process.argv[2];
assert(packet, 'derived packet directory required');
const read = name => JSON.parse(readFileSync(join(packet, name), 'utf8'));
const hash = name => createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex');
const current = read('identity.json').threadId;
const previous = 'mcp:8fd6b8a4-87bd-466f-81fc-4e57713c6a2d';
const old = 'mcp:7bea335d-d936-4f31-a1b3-22e958f09f18';
const foreign = 'mcp:11111111-1111-4111-8111-111111111111';
const now = Date.now(), stamp = delta => new Date(now + delta).toISOString();
const id = '11111111-1111-4111-8111-111111111111';
const app = {pid:44, uid:501, start:'synthetic-start', executable:'/Applications/cmux.app/Contents/MacOS/cmux', argv:'synthetic'};
const c = {executionApproved:true, coordinationReceipt:{status:'ACCEPTED', dispatchId:'synthetic-not-host-authority', threadId:current},
  expectedThreadId:current,
  host:'synthetic', productHead:HEAD, productTree:TREE, uid:501, runId:id, marker:'FIRSTCASE_'+id,
  workspaceId:id, anchorSurfaceId:id, anchorPaneRef:'pane:1', root:'/Users/happycampr/Library/Caches/cmuxlayer-firstcase-'+id,
  candidate:'/Users/happycampr/Library/Caches/cmuxlayer-original-roots-d539fbef', manifestPath:'/Users/happycampr/Library/Caches/cmuxlayer-original-roots-d539fbef/dist-manifest.json',
  node:'/opt/homebrew/Cellar/node/26.10.0_2/bin/node', cmux:'/Applications/cmux.app/Contents/Resources/bin/cmux',
  socket:'/observed/native.sock', socketIdentity:{uid:501, dev:1, ino:2}, appProcess:app,
  runnerSha256:PINS.runner, proxyRunnerSha256:PINS.proxy, nodeSha256:PINS.node, cmuxSha256:PINS.cmux,
  notBeforeUTC:stamp(-1000), mutationEndUTC:stamp(180000), deadlineUTC:stamp(240000)};
const p = {sourceApproved:true, executionApproved:true, bootstrapSha256:hash('./inside-cmux-bootstrap.mjs'),episodeControllerSha256:hash('./native-focus-episode.mjs'),bridgeSha256:hash('./native-focus-bridge.mjs'),bridge:{session:id,nonce:id},executorWitness:{contract:'TERMINAL_INITIAL_COMMAND_GATE',ack:{nonce:id}}, runner:c,
  bootstrap:{workspaceId:id, anchorSurfaceId:id, anchorPaneRef:'pane:1', marker:'INSIDE_BBE_'+id, createdUTC:stamp(-100)},
  beforeBootstrapFocus:{observer:'NSWORKSPACE_FOREGROUND_DIRECT_PID_AX',status:'OBSERVED',kind:'cmux',identityKind:'RETAINED_AX_ELEMENT_REFERENCE',token:id,session:id,
    runId:id,dispatchId:c.coordinationReceipt.dispatchId,threadId:current,deadlineUTC:c.deadlineUTC,sameFocusedWindow:true,nativeWindowCount:1,nativeWindowsEqual:true,
    helperIdentity:{pid:88,ppid:89,uid:501,start:'synthetic-helper-start',executable:'/synthetic/helper',argv:'synthetic-helper'},
    controllerIdentity:{pid:89,uid:501,start:'synthetic-controller-start',argv:'synthetic-controller'},helperSHA256:'a'.repeat(64),helperPath:'/synthetic/helper',helperArgv:'synthetic-helper',appProcess:app,
    app:{pid:'44',bundle:'/Applications/cmux.app',executable:app.executable},capabilities:{recipe:'ACTIVATE_EXISTING_RAISE_SET_FOCUSED_WINDOW',raiseError:0,raiseSupported:true,setterError:0,focusedWindowSettable:true},
    topology:{binding:'SINGLE_NATIVE_SINGLE_PROTOCOL_WINDOW',windowCount:1,key:true,selectedWorkspaceCount:1,selectedSurfaceCount:1,windowId:'synthetic-protocol-window',workspaceId:id,surfaceId:id,paneRef:'pane:1'},
    protocolWindowId:'synthetic-protocol-window',workspaceId:id,surfaceId:id,paneRef:'pane:1',
    artifactPath:'/Users/happycampr/Library/Caches/synthetic-focus.json',sha256:'a'.repeat(64),observedUTC:stamp(-500),completedUTC:stamp(-400)},
  retainedBaseline:{path:socketWitnessPath(c), sha256:'b'.repeat(64)}};
let passed = 0;
const test = (name, run) => {run(); passed++; console.log('PASS '+name);};
test('actual owned thread admits runner boundary', () => assert.equal(validateConfig(c, now), c));
for (const [name, threadId] of [['old executor', previous], ['old BrainLayer', old], ['unrelated', foreign]]) {
  test(name+' thread rejects runner boundary', () => assert.throws(() => validateConfig({...c,
    coordinationReceipt:{...c.coordinationReceipt, threadId}}, now), /parent execution\/window\/product approval required/));
}
test('actual owned thread admits bootstrap boundary', () => assert.equal(validatePlan(p, now), c));
for (const [name, threadId] of [['old executor', previous], ['old BrainLayer', old], ['unrelated', foreign]]) {
  test(name+' thread rejects bootstrap boundary', () => assert.throws(() => validatePlan({...p, runner:{...c,
    coordinationReceipt:{...c.coordinationReceipt, threadId}}}, now), /parent execution\/window\/product approval required/));
}
test('derived schemas and disabled templates require actual owned thread', () => {
  const schema = read('bootstrap.schema.json'), witness = read('socket-witness.schema.json');
  const template = read('bootstrap.template.json');
  assert.equal(schema.properties.runner.properties.coordinationReceipt.properties.threadId.const, current);
  assert.equal(schema.properties.runner.properties.expectedThreadId.const, current);
  assert(schema.properties.runner.required.includes('expectedThreadId'));
  assert.equal(read('episode.schema.json').properties.runner.properties.expectedThreadId.const,current);
  assert.equal(read('episode.template.json').runner.expectedThreadId,current);
  assert.equal(witness.properties.threadId.const, current);
  assert.equal(template.runner.coordinationReceipt.threadId, current);
  assert.equal(read('socket-witness.template.json').threadId, current);
  assert.equal(template.sourceApproved, false); assert.equal(template.executionApproved, false);
  assert.equal(template.runner.executionApproved, false);
});
test('derived runtime pins match actual child source', () => {
  const schema = read('bootstrap.schema.json'), template = read('bootstrap.template.json');
  assert.equal(PINS.runner, hash('./original-roots-first-case.mjs'));
  assert.equal(template.runner.runnerSha256, PINS.runner);
  assert.equal(schema.properties.runner.properties.runnerSha256.const, PINS.runner);
  assert.equal(template.bootstrapSha256, p.bootstrapSha256);
  assert.equal(schema.properties.bootstrapSha256.const, p.bootstrapSha256);
  assert.equal(template.retainedBaseline.path, read('socket-witness.template.json').listener.evidencePath.replace('gui-listener-', 'socket-witness-').replace('.private.txt', '.private.json'));
});
const witness = {observedUTC:stamp(-200), dispatchId:c.coordinationReceipt.dispatchId, threadId:current, appProcess:app,
  socket:{path:c.socket, ...c.socketIdentity, type:'socket', symlink:false},
  listener:{method:'LSOF_GUI_PID_UNIX', role:'LISTENING_OWNER', appProcess:app, socketPath:c.socket,
    evidencePath:join(dirname(socketWitnessPath(c)), 'gui-listener-'+id+'.private.txt'), sha256:'c'.repeat(64)}};
test('actual owned thread witness agrees with runner', () => assert.equal(validateSocketWitness(p,c,witness,now), witness.listener));
for (const [name, threadId] of [['old executor', previous], ['old BrainLayer', old], ['unrelated', foreign]]) {
  test(name+' witness rejects current runner', () => assert.throws(() => validateSocketWitness(p,c,{...witness,threadId},now), /socket witness coordination mismatch/));
}
for (const expectedThreadId of [undefined,'',previous,foreign]) {
  test('runner refuses missing/wrong trusted expected ID '+String(expectedThreadId),()=>assert.throws(()=>validateConfig({...c,expectedThreadId},now)));
}
console.log(JSON.stringify({status:'PASS', executed:passed, passed, failed:0, cancelled:0, skipped:0, native:'UNRUN', provider_calls:0}));
