// Focused setup boundary only. Inert witness/OS-output values, no native I/O.
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {socketWitnessPath,validateSocketWitness,guiSocketListed} from './inside-cmux-bootstrap.mjs';
const stage=dirname(fileURLToPath(import.meta.url)),now=Date.now();
const app={pid:77,uid:501,start:'observed-start',executable:'/Applications/cmux.app/Contents/MacOS/cmux',argv:'/Applications/cmux.app/Contents/MacOS/cmux'};
const c={runId:'11111111-1111-4111-8111-111111111111',notBeforeUTC:new Date(now-1000).toISOString(),socket:'/observed/native.sock',socketIdentity:{uid:501,dev:1,ino:2},appProcess:app,coordinationReceipt:{dispatchId:'fresh-dispatch',threadId:'same-thread'}};
const p={retainedBaseline:{path:socketWitnessPath(c)}};
const w={observedUTC:new Date(now-500).toISOString(),dispatchId:'fresh-dispatch',threadId:'same-thread',appProcess:app,socket:{path:c.socket,...c.socketIdentity,type:'socket',symlink:false},listener:{method:'LSOF_GUI_PID_UNIX',role:'LISTENING_OWNER',appProcess:app,socketPath:c.socket,evidencePath:join(stage,'gui-listener-'+c.runId+'.private.txt'),sha256:'a'.repeat(64)}};
let count=0;
function test(name,fn){fn();count++;console.log('PASS '+name);}
test('healthy fresh named witness binds GUI and socket',()=>assert.equal(validateSocketWitness(p,c,w,now),w.listener));
test('historical path remains inadmissible',()=>assert.throws(()=>validateSocketWitness({retainedBaseline:{path:'/historical/live-baseline-private.json'}},c,w,now)));
test('foreign stage remains inadmissible',()=>assert.throws(()=>validateSocketWitness({retainedBaseline:{path:'/foreign/socket-witness-'+c.runId+'.private.json'}},c,w,now)));
for(const [name,change] of [
 ['old observation',q=>q.observedUTC=new Date(now-2000).toISOString()],
 ['future observation',q=>q.observedUTC=new Date(now+100).toISOString()],
 ['foreign dispatch',q=>q.dispatchId='old-dispatch'],
 ['foreign thread',q=>q.threadId='foreign'],
 ['foreign GUI',q=>q.appProcess.pid++],
 ['changed GUI start',q=>q.appProcess.start='changed'],
 ['wrong GUI executable',q=>q.appProcess.executable='/foreign/cmux'],
 ['path substring only',q=>{delete q.socket;q.note=c.socket;}],
 ['wrong endpoint',q=>q.socket.ino++],
 ['symlink endpoint',q=>q.socket.symlink=true],
 ['no listener',q=>delete q.listener],
 ['listener not positive',q=>q.listener.role='PATH_ONLY'],
 ['foreign listener GUI',q=>q.listener.appProcess.pid++],
 ['foreign listener path',q=>q.listener.socketPath='/foreign.sock'],
 ['foreign evidence file',q=>q.listener.evidencePath='/foreign/evidence.txt'],
 ['missing evidence hash',q=>delete q.listener.sha256],
])test(name,()=>{const q=structuredClone(w);change(q);assert.throws(()=>validateSocketWitness(p,c,q,now));});
test('scoped lsof FD attributes exact UNIX endpoint',()=>assert(guiSocketListed('p77\nf9\ntunix\nn/observed/native.sock\n',77,c.socket)));
test('observed pathname alias resolves to canonical endpoint',()=>assert(guiSocketListed('p77\nf9\ntunix\nn/tmp/observed.sock\n',77,c.socket,path=>path==='/tmp/observed.sock'?c.socket:path)));
test('inaccessible listener path fails closed',()=>assert.equal(guiSocketListed('p77\nf9\ntunix\nn/observed/native.sock\n',77,c.socket,()=>{throw Error('unavailable')}),false));
for(const [name,text] of [
 ['wrong PID','p78\nf9\ntunix\nn/observed/native.sock\n'],
 ['wrong file type','p77\nf9\ntREG\nn/observed/native.sock\n'],
 ['path mentioned only','p77\nf9\ntunix\nn/unrelated.sock\ncomment /observed/native.sock\n'],
 ['connected peer suffix','p77\nf9\ntunix\nn/observed/native.sock->peer\n'],
 ['extra process','p77\nf9\ntunix\nn/observed/native.sock\np78\nf3\ntunix\nn/observed/native.sock\n'],
])test(name,()=>assert.equal(guiSocketListed(text,77,c.socket),false));
console.log(JSON.stringify({status:'PASS',controls:count,native:'UNRUN',provider_calls:0,scope:'NEW_SOCKET_WITNESS_ONLY'}));
