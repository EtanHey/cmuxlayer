// Real imported admission functions, inert explicitly synthetic values only.
// No helper execution, native calls, socket or process observation.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateFocusWitness,validateTopology,readFocusReceipt,executorReadiness,OBSERVER,RECIPE} from './native-focus-episode.mjs';
const now=Date.now(),utc=n=>new Date(now+n).toISOString(),id='11111111-1111-4111-8111-111111111111';
const helper={pid:88,ppid:89,uid:501,start:'synthetic-helper-start',executable:'/synthetic/helper',argv:'/synthetic/helper synthetic-argv'},controller={pid:89,uid:501,start:'synthetic-controller-start',executable:'/synthetic/controller',argv:'synthetic-argv'};
const app={pid:77,uid:501,start:'synthetic-app-start',executable:'/Applications/cmux.app/Contents/MacOS/cmux',argv:'synthetic-app'};
const c={runId:id,notBeforeUTC:utc(-5000),deadlineUTC:utc(240000),appProcess:app,coordinationReceipt:{dispatchId:'synthetic-not-host-authority',threadId:'mcp:8fd6b8a4-87bd-466f-81fc-4e57713c6a2d'}};
const t={binding:'SINGLE_NATIVE_SINGLE_PROTOCOL_WINDOW',windowCount:1,key:true,selectedWorkspaceCount:1,selectedSurfaceCount:1,windowId:'synthetic-protocol-window',workspaceId:id,surfaceId:id,paneRef:'pane:1'};
const w={observer:OBSERVER,status:'OBSERVED',kind:'cmux',identityKind:'RETAINED_AX_ELEMENT_REFERENCE',token:id,session:id,runId:id,dispatchId:c.coordinationReceipt.dispatchId,threadId:c.coordinationReceipt.threadId,deadlineUTC:c.deadlineUTC,observedUTC:utc(-1000),completedUTC:utc(-500),sameFocusedWindow:true,nativeWindowCount:1,nativeWindowsEqual:true,helperIdentity:helper,controllerIdentity:controller,helperSHA256:'a'.repeat(64),helperPath:helper.executable,helperArgv:helper.argv,appProcess:app,app:{pid:'77',bundle:'/Applications/cmux.app',executable:app.executable},capabilities:{recipe:RECIPE,raiseError:0,raiseSupported:true,setterError:0,focusedWindowSettable:true},topology:t,protocolWindowId:t.windowId,workspaceId:id,surfaceId:id,paneRef:'pane:1'};
let count=0;
const test=(name,run)=>{run();count++;console.log('PASS '+name);};
test('truthful compound admission shape',()=>assert.equal(validateFocusWitness(w,c,now,helper),w));
for(const [name,mutate] of [
 ['old CUA label',q=>q.observer='NATIVE_CUA'],['diagnostic label',q=>q.observer='MACOS_AX_READ_ONLY_PROBE'],['diagnostic disposition',q=>q.acceptedCaseWitness=false],
 ['false equality',q=>q.sameFocusedWindow=false],['null equality',q=>q.sameFocusedWindow=null],['missing equality',q=>delete q.sameFocusedWindow],
 ['multiple native windows',q=>q.nativeWindowCount=2],['unknown native count',q=>q.nativeWindowCount=null],['native window association false',q=>q.nativeWindowsEqual=false],
 ['missing capabilities',q=>delete q.capabilities],['unsupported recipe',q=>q.capabilities.recipe='RETRY_OTHER_SETTER'],['unsupported raise',q=>q.capabilities.raiseSupported=false],['raise API error',q=>q.capabilities.raiseError=-25204],['unsupported setter',q=>q.capabilities.focusedWindowSettable=false],['setter API error',q=>q.capabilities.setterError=-25204],
 ['foreign helper UID',q=>q.helperIdentity.uid=502],['helper PID changed',q=>q.helperIdentity.pid++],['helper start changed',q=>q.helperIdentity.start='changed'],['foreign parent',q=>q.helperIdentity.ppid++],['foreign token',q=>q.token='not-an-episode-token'],['foreign session',q=>q.session=null],['helper argv changed',q=>q.helperArgv='foreign'],
 ['foreign run',q=>q.runId='foreign'],['foreign thread',q=>q.threadId='foreign'],['foreign dispatch',q=>q.dispatchId='foreign'],['expired deadline',q=>q.deadlineUTC=utc(-1)],['foreign deadline',q=>q.deadlineUTC=utc(240001)],['stale observation',q=>q.observedUTC=utc(-6000)],['future completion',q=>q.completedUTC=utc(1)],
 ['foreign app PID',q=>q.appProcess.pid++],['app start changed',q=>q.appProcess.start='changed'],['app bundle changed',q=>q.app.bundle='/foreign.app'],['multiple protocol windows',q=>q.topology.windowCount=2],['no key evidence',q=>delete q.topology.key],['topology workspace mismatch',q=>q.topology.workspaceId='changed'],['changed surface',q=>q.topology.surfaceId='changed'],['changed pane',q=>q.topology.paneRef='pane:other'],['native token as protocol ID',q=>q.windowId=q.token]
])test(name,()=>{const q=structuredClone(w);mutate(q);assert.throws(()=>validateFocusWitness(q,c,now,helper));});
test('dead helper rejects with absent independent identity',()=>assert.throws(()=>validateFocusWitness(w,c,now,null)));
const windows={windows:[{id:t.windowId,ref:'window:1',key:true,selected_workspace_id:id}]},ws={workspaces:[{id,ref:'workspace:1',selected:true}]},current={workspace_id:id},identify={focused:{workspace_ref:'workspace:1',surface_ref:'surface:1',pane_ref:'pane:1'}},panes={window_ref:'window:1',panes:[{ref:'pane:1',focused:true}]},surfaces={window_ref:'window:1',surfaces:[{id,ref:'surface:1',selected:true}]};
test('real topology function admits cardinality and selected aliases',()=>assert.deepEqual(validateTopology(windows,ws,current,identify,panes,surfaces,t),t));
for(const [name,mutate] of [['multiple windows',a=>a[0].windows.push({})],['missing key',a=>delete a[0].windows[0].key],['changed window',a=>a[4].window_ref='window:other'],['selected workspace changed',a=>a[1].workspaces[0].id='other'],['selected surface changed',a=>a[5].surfaces[0].id='other'],['focused surface changed',a=>a[3].focused.surface_ref='surface:other'],['focused pane changed',a=>a[3].focused.pane_ref='pane:other'],['ambiguous selection',a=>a[5].surfaces.push({id:'other',ref:'surface:other',selected:true})]])test(name,()=>{const a=structuredClone([windows,ws,current,identify,panes,surfaces,t]);mutate(a);assert.throws(()=>validateTopology(...a));});
const parent=join(dirname(fileURLToPath(import.meta.url)),'../docs.local');
const scratch=fs.realpathSync(fs.mkdtempSync(join(parent,'native-observer-controls-'))); // Private retained control-only bytes.
fs.chmodSync(scratch,0o700);
try{
 const path=join(scratch,'focus.json'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 fs.writeFileSync(path,JSON.stringify(w),{mode:0o600});const plan={...w,artifactPath:path,sha256:hash(fs.readFileSync(path))};
 const query=pid=>pid===89?controller:helper;
 test('actual private receipt read uses exact bytes and queried identity',()=>assert.equal(readFocusReceipt(plan,c,now,query).token,w.token));
 test('hash-mismatched receipt rejects',()=>assert.throws(()=>readFocusReceipt({...plan,sha256:'b'.repeat(64)},c,now,query)));
 test('malformed receipt rejects',()=>{fs.writeFileSync(path,'{');assert.throws(()=>readFocusReceipt({...plan,sha256:hash(fs.readFileSync(path))},c,now,query));});
 fs.writeFileSync(path,JSON.stringify(w));
 test('dead controller rejects',()=>assert.throws(()=>readFocusReceipt(plan,c,now,()=>null)));
 test('changed receipt values reject',()=>assert.throws(()=>readFocusReceipt({...plan,session:null},c,now,query)));
 fs.chmodSync(path,0o644);test('public receipt mode rejects',()=>assert.throws(()=>readFocusReceipt(plan,c,now,query)));
}finally{console.log(JSON.stringify({controlOnlyReceipts:scratch,retained:true}));}
test('unsupported socket readiness stops before any input',()=>assert.throws(executorReadiness,/EXECUTOR_READINESS_UNAVAILABLE/));
console.log(JSON.stringify({status:'PASS',executed:count,passed:count,failed:0,cancelled:0,skipped:0,nativeCases:0,nativeAcceptance:'UNPROVED',scope:'IMPORTED_ADMISSION_ONLY'}));
