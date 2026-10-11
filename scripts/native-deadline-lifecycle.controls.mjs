// Offline JS transport and actual Foundation parser controls, never the AX helper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {canonicalHelperDeadline,Episode} from './native-focus-episode.mjs';
import {queryProcess} from './original-roots-first-case.proxy.mjs';
const root=resolve(process.argv[2]),thread=JSON.parse(fs.readFileSync(join(root,'identity.json'))).threadId;
const work=fs.mkdtempSync(join(root,'deadline-controls-')),node=fs.realpathSync(process.execPath),hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let count=0;const rows=[],test=async(name,run)=>{await run();count++;console.log('PASS '+name);};
const future=new Date(Math.floor(Date.now()/1000)*1000+300000).toISOString(),whole=future.replace('.000Z','Z');
await test('whole seconds normalize without extending the instant',()=>{assert.equal(canonicalHelperDeadline(whole),future);assert.equal(Date.parse(whole),Date.parse(canonicalHelperDeadline(whole)));});
for(const value of [future,future.replace('.000','.123'),future.replace('.000','.1'),future.replace('.000','.12')]) await test('fractional deadline '+value,()=>assert.equal(Date.parse(value),Date.parse(canonicalHelperDeadline(value))));
for(const value of [undefined,null,'','not-iso','2026-02-31T23:50:00Z','2026-10-10T25:50:00Z','2026-10-10T23:50:00+00:00','2026-10-10T23:50:00.1234Z']) await test('malformed/missing deadline rejects '+String(value),()=>assert.throws(()=>canonicalHelperDeadline(value)));
const parser=join(root,'foundation-parser.js');
await test('actual installed Foundation rejects original whole seconds and accepts exact normalized argv',()=>{
 const command=['-l','JavaScript',parser,'2026-10-10T23:50:00Z','2026-10-10T23:50:00.000Z','2026-10-10T23:50:00.123Z','bad',''];
 const raw=execFileSync('/usr/bin/osascript',command,{encoding:'utf8',timeout:3000}),proof=JSON.parse(raw);
 assert.equal(proof.formatOptions,3955);assert.deepEqual(proof.rows.map(r=>r.accepted),[false,true,true,false,false]);
 fs.writeFileSync(join(work,'foundation-boundary.json'),JSON.stringify({command:['/usr/bin/osascript',...command],proof},null,2)+'\n');
});
await test('actual Foundation UUID admits new expected ID and exact equality rejects old/wrong Swift binding',()=>{
 const source=fs.readFileSync(new URL('./native-focus-episode.swift',import.meta.url),'utf8');assert.match(source,/args.count == 6/);assert.match(source,/let expectedThreadID = args\[5\]/);assert.match(source,/UUID\(uuidString: String\(expectedThreadID.dropFirst\(4\)\)\) != nil && threadID == expectedThreadID/);
 const command=['-l','JavaScript',join(root,'foundation-thread-binding.js'),thread,thread,'mcp:8fd6b8a4-87bd-466f-81fc-4e57713c6a2d','mcp:11111111-1111-4111-8111-111111111111'];const proof=JSON.parse(execFileSync('/usr/bin/osascript',command,{encoding:'utf8',timeout:3000}));assert.equal(proof.expectedUUIDAccepted,true);assert.deepEqual(proof.rows.map(r=>r.accepted),[true,false,false]);const malformed=JSON.parse(execFileSync('/usr/bin/osascript',['-l','JavaScript',join(root,'foundation-thread-binding.js'),'mcp:invalid','mcp:invalid'],{encoding:'utf8',timeout:3000}));assert.equal(malformed.expectedUUIDAccepted,false);assert.equal(malformed.rows[0].accepted,false);
 fs.writeFileSync(join(work,'foundation-thread-binding.json'),JSON.stringify({command:['/usr/bin/osascript',...command],proof,malformed,scope:'FOUNDATION_UUID_AND_SOURCE_PREDICATE_ONLY_NO_AX_HELPER'},null,2)+'\n');
});
const stub=join(work,'transport-stub.mjs');
fs.writeFileSync(stub,`import fs from 'node:fs';
const mode=process.argv[2],deadlineUTC=process.argv[4],session='offline-session';
const send=row=>console.log(JSON.stringify(row));
if(mode==='early')process.exit(2);
if(mode==='silent')setInterval(()=>{},1000);
else if(mode==='reject'||mode==='reject-hang'){send({status:'HELPER_UNAVAILABLE',error:'OFFLINE_REJECTED',helperPID:process.pid});setTimeout(()=>process.exit(2),mode==='reject'?200:10000);}
else {send({status:'HELPER_STARTED',helperPID:process.pid,helperPPID:process.ppid,helperExecutable:process.execPath,session});
if(mode==='stdin-error'){fs.closeSync(0);setTimeout(()=>process.exit(2),500);}
else if(mode==='accepted-early')setTimeout(()=>process.exit(2),200);
else {let buffer='';process.stdin.on('data',bytes=>{buffer+=bytes;while(buffer.includes('\\n')){let n=buffer.indexOf('\\n'),row=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);send({status:'OBSERVED',session,sequence:row.sequence,runId:process.argv[1],dispatchId:mode,threadId:process.argv[3],deadlineUTC});if(row.command==='finish')process.exit(0);}});}}
`,{mode:0o600});
const config=(mode,deadline=whole,helper=node)=>{const receiptDir=fs.mkdtempSync(join(work,mode+'-'));return {helper,helperSHA256:helper===node?hash(node):'0'.repeat(64),runId:stub,dispatchId:mode,threadId:thread,expectedThreadId:thread,deadlineUTC:deadline,receiptDir};};
const absent=pid=>{if(!pid)return;assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');};
const fail=async(c,expect)=>{
 const episode=new Episode(c),begin=Date.now();let error;
 try{await episode.startTransport();error=Error('expected rejected startup');}catch(e){error=e;}
 finally{try{await episode.finish();}catch{}}
 assert.match(String(error),expect);await assert.rejects(episode.finish());
 assert.ok(Date.now()-begin<5000,'bounded startup/finalization');absent(episode.child?.pid);
 const supervision=JSON.parse(fs.readFileSync(join(c.receiptDir,'supervision.json')));
 assert.equal(supervision.status,'FAILED_HELPER_LIFECYCLE');assert.equal(supervision.ownedHelperRemaining,false);assert.ok(supervision.END_RETURN);
 assert.equal(episode.sequence,0,'no finish/GUI command after startup rejection');
 rows.push({mode:c.dispatchId,argv:episode.argv,supervision,receiptDir:c.receiptDir});return episode;
};
await test('HELPER_UNAVAILABLE completes with truthful final receipt and no leaked child',()=>fail(config('reject'),/HELPER_UNAVAILABLE/));
for(const actual of ['mcp:8fd6b8a4-87bd-466f-81fc-4e57713c6a2d','mcp:11111111-1111-4111-8111-111111111111']) await test('wrong/old actual thread cannot spawn '+actual,async()=>{const c=config('wrong-thread');c.threadId=actual;const e=await fail(c,/expected thread binding mismatch/);assert.equal(e.child,undefined);});
for(const expected of [undefined,'', 'mcp:8fd6b8a4-87bd-466f-81fc-4e57713c6a2d']) await test('missing/wrong expected thread cannot spawn '+String(expected),async()=>{const c=config('wrong-expected');c.expectedThreadId=expected;const e=await fail(c,/expected thread binding mismatch/);assert.equal(e.child,undefined);});
await test('rejected live child gets one owned SIGTERM and observed exit',async()=>{
 const episode=await fail(config('reject-hang'),/HELPER_UNAVAILABLE/);
 assert.ok(episode.stops.has('SIGTERM'));assert.equal(episode.stops.size,1);const cleanup=JSON.parse(fs.readFileSync(join(episode.c.receiptDir,'cleanup-SIGTERM.json')));assert.equal(cleanup.sent,true);assert.equal(cleanup.identity.pid,episode.child.pid);
 await assert.rejects(episode.finish());assert.equal(episode.stops.size,1,'no replay on duplicate finish');
});
await test('early exit is observed without startup acceptance or leak',()=>fail(config('early'),/helper|Command failed/));
await test('spawn error is observed and receipt completes',()=>fail(config('missing',whole,join(work,'absent-helper')),/ENOENT/));
await test('expired deadline cannot spawn a child',async()=>{const e=await fail(config('expired','2020-01-01T00:00:00Z'),/absolute episode deadline/);assert.equal(e.child,undefined);});
await test('missing deadline cannot spawn a child',async()=>{const c=config('missing-deadline');c.deadlineUTC=undefined;const e=await fail(c,/valid UTC helper deadline/);assert.equal(e.child,undefined);});
await test('malformed deadline cannot spawn a child',async()=>{const e=await fail(config('bad-deadline','malformed'),/valid UTC helper deadline/);assert.equal(e.child,undefined);});
await test('silent startup respects cleanup reserve and records owned exit',()=>fail(config('silent',new Date(Date.now()+2600).toISOString()),/helper transport closed/));
await test('actual child argv normalization is parsed by Foundation before intentional offline rejection',async()=>{
 const c=config('foundation',whole,'/usr/bin/osascript');c.runId=join(root,'foundation-startup-reject.js');c.helperSHA256=hash(c.helper);
 const e=await fail(c,/OFFLINE_PARSER_ACCEPTED/);assert.equal(e.argv[4],future);assert.equal(e.startupRow.parserAccepted,true);assert.equal(e.startupRow.wireDeadline,future);
});
await test('accepted transport finishes normally with same canonical reply deadline',async()=>{
 const c=config('normal'),e=new Episode(c);try{await e.startTransport();assert.equal(e.argv[4],future);assert.equal(e.argv[3],thread);assert.equal(e.argv[5],thread);await e.finish();assert.equal(e.supervision.status,'HELPER_FINISHED');assert.equal(e.exit.code,0);assert.equal(e.supervision.ownedHelperRemaining,false);absent(e.child.pid);}finally{if(!e.ended)await e.finish();}
});
await test('exit after accepted startup is failure unless finish protocol and clean exit are observed',async()=>{
 const c=config('accepted-early'),e=new Episode(c);await e.startTransport();await e.exitPromise;await assert.rejects(e.finish(),/without successful finish/);assert.equal(e.supervision.status,'FAILED_HELPER_LIFECYCLE');assert.equal(e.supervision.ownedHelperRemaining,false);assert.equal(e.sequence,0);absent(e.child.pid);
});
await test('stdin transport error rejects command without unhandled event or leak',async()=>{
 const c=config('stdin-error'),e=new Episode(c);try{await e.startTransport();await assert.rejects(e.command('finish'));await assert.rejects(e.finish());absent(e.child.pid);assert.equal(e.supervision.ownedHelperRemaining,false);}finally{if(!e.ended)try{await e.finish();}catch{}}
});
await test('changed identity refuses signals and retains uncertainty until separate owned test cleanup',async()=>{
 const c=config('reject-hang'),e=new Episode(c);try{await assert.rejects(e.startTransport());const owned={...e.baseline};e.baseline={...owned,start:'OFFLINE_CHANGED_IDENTITY'};await assert.rejects(e.finish());assert.equal(e.supervision.ownedHelperRemaining,'UNKNOWN_RETAINED');for(const signal of ['SIGTERM','SIGKILL'])assert.equal(JSON.parse(fs.readFileSync(join(c.receiptDir,'cleanup-'+signal+'.json'))).sent,false);
 assert.deepEqual(queryProcess(e.child.pid,1000),owned);e.child.ref();process.kill(owned.pid,'SIGTERM');await e.exitPromise;absent(owned.pid);
 }finally{if(e.child&&!e.ended){const live=queryProcess(e.child.pid,1000);assert.equal(live.ppid,process.pid);assert.equal(live.argv,e.argv.join(' '));e.child.ref();process.kill(e.child.pid,'SIGTERM');await e.exitPromise;}}
});
const result={status:'PASS',executed:count,passed:count,failed:0,cancelled:0,skipped:0,scope:'OFFLINE_REAL_TRANSPORT_AND_FOUNDATION_ONLY',nativeCases:0,nativeHelperExecutions:0,guiActions:0,providerCalls:0,rows};
fs.writeFileSync(join(root,'deadline-controls-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,rows:undefined}));
