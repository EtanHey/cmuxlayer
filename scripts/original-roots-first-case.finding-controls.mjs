// Actual runner call closure and assertion, injected SDK only; no native effects.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const file = process.argv[2] + '/scripts/original-roots-first-case.mjs';
const m = await import(pathToFileURL(file)); const source = readFileSync(file, 'utf8');
const id='11111111-1111-4111-8111-111111111111', root='/Users/happycampr/Library/Caches/cmuxlayer-firstcase-'+id;
const stamp = delta => new Date(Date.now()+delta).toISOString();
const c={executionApproved:true,coordinationReceipt:{status:'ACCEPTED',dispatchId:'synthetic',threadId:'mcp:7bea335d-d936-4f31-a1b3-22e958f09f18'},host:'synthetic',productHead:m.HEAD,productTree:m.TREE,uid:501,runId:id,marker:'FIRSTCASE_'+id,workspaceId:id,anchorSurfaceId:id,anchorPaneRef:'pane:1',root,candidate:'/Users/happycampr/Library/Caches/candidate',manifestPath:'/tmp/manifest',node:'/node',cmux:'/cmux',socket:'/socket',socketIdentity:{uid:501},appProcess:{uid:501,start:'A',argv:'synthetic'},nodeSha256:'a'.repeat(64),cmuxSha256:'b'.repeat(64),runnerSha256:'c'.repeat(64),notBeforeUTC:stamp(-1000),mutationEndUTC:stamp(2000),deadlineUTC:stamp(62000)};
let pass=0,fail=0;
async function test(name,run){try{await run();pass++;console.log('PASS '+name);}catch(e){fail++;console.log('FAIL '+name+' '+String(e));}}
await test('R1 actual request options bounded by absolute remaining window',async()=>{
 const start=source.indexOf('    const call = async (name, args) => {'); assert(start>=0);
 const end=source.indexOf('\n    };',start); assert(end>start);
 const text=source.slice(start,end+7)+'\nreturn call;'; let options;
 const call=Function('guard','client','receipt','record','c','withinWindow','retainUnknown',text)(()=>m.validateConfig(c),{callTool:async(_p,_s,o)=>{options=o;return{structuredContent:{ok:true}};}},{requests:[]},()=>{},c,m.withinWindow,()=>{});
 await call('spawn_agent',{synthetic:true}); assert(options.timeout>0 && options.timeout<=2000,JSON.stringify(options));
});
await test('R2 terminal unmatched completion cannot pass first-case claim',()=>{
 const cwd=root+'/firstcase/.worktrees/owned',boot={ok:true,agent_id:'fixture',contract_path:root+'/contract.md',coordination_footer_delivered:true,boot_prompt_receipt:{delivery_id:id,submit_verified:true},worktree:{path:cwd},surface_id:'surface:2'};
 const event={submissions:[c.marker+' ; cmuxlayer contract for fixture: Read and follow '+boot.contract_path],draft:'',keys:['Return']};
 const panes={panes:[{ref:'pane:1',index:0},{ref:'pane:2',index:1,surface_refs:['surface:2']}]};
 assert.throws(()=>m.assertCaseEvidence(c,boot,event,{cwd},panes,{ok:false,delivery_id:'foreign',terminal:true,submitted:false,submit_verified:false,delivery_state:'failed'}));
});
const fresh = delta => ({...c, mutationEndUTC:stamp(delta), deadlineUTC:stamp(delta+60000)});
await test('R1 native startup refuses short remaining budget',()=>{
 assert.throws(()=>m.windowBudget(fresh(5000),60000));
 assert(m.windowBudget(fresh(61000),60000)>0);
 const body=source.slice(source.indexOf('async function native(c) {'));
 const admission=body.indexOf('windowBudget(c, 60000);');
 assert(admission>=0 && admission<body.indexOf('fs.mkdirSync(c.root'));
});
await test('R1 expired admission invokes no remote operation',async()=>{
 let effects=0;
 await assert.rejects(m.withinWindow(fresh(-1),'expired',()=>{effects++;},()=>{}));
 assert.equal(effects,0);
});
await test('R1 abort bounds caller while late remote ACK stays unknown',async()=>{
 let release, options, effects=0; const notes=[];
 const result=m.withinWindow(fresh(40),'remote',o=>{options=o;effects++;return new Promise(ok=>{release=ok;});},(label,row)=>notes.push({label,...row}));
 await assert.rejects(result,/deadline expired/);
 assert.equal(effects,1); assert(options.signal.aborted);
 assert(options.timeout>0 && options.timeout<=40);
 assert.equal(options.maxTotalTimeout,options.timeout); assert.equal(options.resetTimeoutOnProgress,false);
 assert(notes.some(n=>n.outcome==='UNKNOWN' && n.remote_absence==='UNPROVED'));
 release({created:'owned-but-not-independent-identity'});
 await new Promise(ok=>setImmediate(ok));
 assert(notes.some(n=>n.outcome==='LATE_ACK' && n.value.created==='owned-but-not-independent-identity' && n.remote_absence==='UNPROVED'));
});
await test('R1 response crossing absolute window never passes and ACK retained',async()=>{
 const config=fresh(1000),notes=[];
 await assert.rejects(m.withinWindow(config,'crossed',()=>{config.mutationEndUTC=stamp(-1);return{created:true};},(label,row)=>notes.push({label,...row})),/after mutation window/);
 assert(notes.some(n=>n.outcome==='LATE_ACK' && n.value.created===true));
});
const cwd=root+'/firstcase/.worktrees/owned', boot={ok:true,agent_id:'fixture',contract_path:root+'/contract.md',coordination_footer_delivered:true,boot_prompt_receipt:{delivery_id:id,submit_verified:true},worktree:{path:cwd},surface_id:'surface:2'};
const event={submissions:[c.marker+' ; cmuxlayer contract for fixture: Read and follow '+boot.contract_path],draft:'',keys:['Return']};
const panes={panes:[{ref:'pane:1',index:0},{ref:'pane:2',index:1,surface_refs:['surface:2']}]};
const completion={ok:true,delivery_id:id,terminal:true,submitted:true,submit_verified:true,delivery_state:'submitted'};
await test('R2 original correlated terminal verified completion passes',()=>assert.equal(m.assertCaseEvidence(c,boot,event,{cwd},panes,completion).behavior,'PASS'));
for(const patch of [{delivery_id:'foreign'},{terminal:false},{ok:false},{submitted:false},{submit_verified:null},{delivery_state:'pending_verify'},undefined]) {
 await test('R2 missing/unmatched/nonterminal/unverified/failed completion refuses',()=>assert.throws(()=>m.assertCaseEvidence(c,boot,event,{cwd},panes,patch ? {...completion,...patch}:undefined)));
}
console.log(JSON.stringify({pass,fail,source:file,native:'UNRUN',provider_calls:0})); if(fail)process.exitCode=1;
