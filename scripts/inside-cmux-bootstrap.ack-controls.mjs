// BBOOT1: execute the actual creation/ownership and restoration source slices.
// Inert responses only; no native socket, UI, subprocess, provider or config I/O.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./inside-cmux-bootstrap.mjs',import.meta.url),'utf8');
const begin=source.indexOf('windowBudget(c,60000);const created='),end=source.indexOf('  const panes=',begin);
assert(begin>0 && end>begin);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const fn=new AsyncFunction('c','rpc','backend','record','workspaces','check','outcome','windowBudget',source.slice(begin,end));
const restoreBegin=source.indexOf('outcome.restoreProposal='),restoreEnd=source.indexOf(';\n  record(\'result\'',restoreBegin);
assert(restoreBegin>end && restoreEnd>restoreBegin);
const restore=new Function('outcome','p',source.slice(restoreBegin,restoreEnd)+';return outcome.restoreProposal;');
// These three inputs are identical to the independent review counterexamples.
const candidate={id:'11111111-1111-4111-8111-111111111111',ref:'workspace:9',title:'FIRSTCASE_synthetic'};
const focus={workspaceId:'old-focus',surfaceId:'old-surface'},bootstrap={workspaceId:'bootstrap'};
let count=0;
async function run(name,ack,{before=[],after=[candidate],owns=false}={}) {
 const outcome={status:'FAIL',case:null},events=[],calls=[];
 const backend={createWorkspace:async()=>{calls.push('create');return ack;},listWorkspaces:async()=>{calls.push('list');return {workspaces:after};}};
 let configWrites=0,runnerLaunches=0,error;
 try {
  await fn({marker:candidate.title},async(_label,op)=>op(),backend,(name,value)=>events.push({name,value}),{workspaces:before},(ok,msg)=>{if(!ok)throw Error(msg);},outcome,()=>60000);
  configWrites++;runnerLaunches++;
 }catch(e){error=String(e);}
 const proposal=restore(outcome,{bootstrap,beforeBootstrapFocus:focus});
 assert.deepEqual(calls,['create','list']); // Exactly one attempt, no replay.
 assert.deepEqual(events.map(e=>e.name),['case-creation-ack','case-creation-observation']);
 assert.deepEqual(events[0].value,ack);assert.deepEqual(events[1].value,{workspaces:after});
 assert.strictEqual(proposal.bootstrapWorkspace,bootstrap);assert.strictEqual(proposal.beforeBootstrapFocus,focus);
 assert.equal(proposal.overallAcceptance,'REQUIRES_PARENT_READBACK');
 if(owns){
  assert.equal(error,undefined);assert.equal(outcome.case.workspaceId,candidate.id);
  assert.equal(outcome.status,'FAIL'); // Later runner failures still fail normally.
  assert.equal(configWrites,1);assert.equal(runnerLaunches,1);
  assert(proposal.sequence.includes('Revalidate/close only ACK-bound created case workspace'));
 }else{
  assert(error);assert.equal(outcome.case,null);assert.equal(proposal.caseWorkspace,null);
  assert.equal(outcome.status,'PENDING_UNKNOWN_CASE_IDENTITY');
  assert.equal(configWrites,0);assert.equal(runnerLaunches,0);
  assert(proposal.sequence.includes('Case ownership UNKNOWN; no case closure or creation replay'));
 }
 count++;console.log(JSON.stringify({name,status:'PASS',owned:owns,configWrites,runnerLaunches,createAttempts:1,caseStatus:outcome.status}));
}
await run('missing_identity',{workspace:'',title:candidate.title});
await run('wrong_identity',{workspace:'workspace:OTHER',title:candidate.title});
await run('healthy',{workspace:candidate.ref,title:candidate.title},{owns:true});
await run('healthy_uuid',{workspace:candidate.id,title:candidate.title},{owns:true});
await run('missing_workspace_field',{title:candidate.title});
await run('whitespace_identity',{workspace:' ',title:candidate.title});
await run('old_ack_identity',{workspace:candidate.ref},{before:[{id:'old-id',ref:candidate.ref}]});
await run('duplicate_ack_identity',{workspace:candidate.ref},{after:[candidate,{id:'foreign-id',ref:candidate.ref,title:'foreign-title'}]});
await run('ambiguous_new_title',{workspace:candidate.ref},{after:[candidate,{id:'foreign-id',ref:'workspace:other',title:candidate.title}]});
await run('ack_wrong_title',{workspace:candidate.ref},{after:[{...candidate,title:'foreign-title'}]});
await run('absent_candidate',{workspace:candidate.ref},{after:[]});
console.log(JSON.stringify({status:'PASS',controls:count,native:'UNRUN',provider_calls:0,io:'INERT_SOURCE_SLICES_ONLY'}));
