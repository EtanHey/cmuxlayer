#!/opt/homebrew/Cellar/node/26.10.0_2/bin/node
// Terminal initial_command. Starts inert, binds one release, keeps GUI ancestry alive.
import * as fs from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateConfig,windowBudget,sameProcess} from './original-roots-first-case.mjs';
import {ancestry,queryProcess} from './original-roots-first-case.proxy.mjs';
const self=fileURLToPath(import.meta.url),stage=dirname(self),check=(ok,why)=>{if(!ok)throw Error(why);};
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function privateJSON(path){const s=fs.lstatSync(path);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===501&&(s.mode&0o777)===0o600&&fs.realpathSync(path)===path,'private canonical JSON required');const bytes=fs.readFileSync(path);check(bytes.length<=1048576,'private JSON bound');return {bytes,value:JSON.parse(bytes),sha256:digest(bytes)};}
export function bindCreation(before,ack,after,marker) {
 check(Array.isArray(before?.workspaces)&&Array.isArray(after?.workspaces)&&before.workspaces.every(w=>w.id)&&new Set(before.workspaces.map(w=>w.id)).size===before.workspaces.length,'complete pre-create UUID inventory required');
 const ids=before.workspaces.map(w=>w.id),token=ack.workspace_id??ack.workspace_ref??ack.workspace;
 check(typeof token==='string'&&token.trim()&&typeof marker==='string','exact creation ACK required');
 const matches=after.workspaces.filter(w=>w.title===marker&&!ids.includes(w.id)),alias=w=>[w.id,w.ref].filter(Boolean).includes(token);
 check(matches.length===1&&matches[0].id&&alias(matches[0])&&after.workspaces.filter(alias).length===1&&!before.workspaces.some(alias),'ACK must bind exactly one new UUID/title');
 return {workspaceId:matches[0].id,workspaceRef:matches[0].ref,marker,ack};
}
export function validateGateACK(w,c,owned,expected,live,chain,tty) {
 check(w?.contract==='TERMINAL_INITIAL_COMMAND_GATE'&&w.status==='WAITING_RELEASE'&&w.runId===c.runId&&w.dispatchId===c.coordinationReceipt.dispatchId&&w.threadId===c.coordinationReceipt.threadId&&w.nonce===expected.nonce,'gate run/dispatch/thread/nonce mismatch');
 check(w.gateSHA256===expected.gateSHA256&&w.configSHA256===expected.configSHA256&&w.bootSHA256===expected.bootSHA256&&w.nodeSHA256===c.nodeSha256,'gate/config/boot/node bytes mismatch');
 check(sameProcess(w.identity,live)&&w.identity.argv===[c.node,expected.gatePath].join(' ')&&w.identity.executable===c.node&&w.identity.ppid===live.ppid,'live terminal gate identity changed');
 check(chain.some(p=>sameProcess(p,c.appProcess))&&sameProcess(chain[0],live),'genuine GUI gate ancestry required');
 check(w.tty?.stdin===true&&w.tty.stdout===true&&tty&&tty!=='??'&&tty===w.tty.psTTY,'real terminal stdin/stdout/independent TTY required');
 check(w.scope?.workspaceId===owned.workspaceId&&w.scope.surfaceId&&w.scope.lifecycleId,'generated gate scope missing/foreign');
 if(owned.ack.surface_id!==undefined)check(owned.ack.surface_id===w.scope.surfaceId,'created surface UUID disagrees with gate');
 if(owned.ack.surface_ref!==undefined)check(owned.ack.surface_ref===owned.surfaceRef,'created surface ref disagrees with observed topology');
 check(Date.parse(w.observedUTC)>=Date.parse(c.notBeforeUTC)&&Date.parse(w.observedUTC)<=Date.now(),'fresh gate ACK required');return w;
}
export function validateRelease(r,c,ack,expected,planSHA,live,now=Date.now()) {
 check(r?.contract==='TERMINAL_INITIAL_COMMAND_RELEASE'&&r.releaseCount===1&&r.runId===c.runId&&r.dispatchId===c.coordinationReceipt.dispatchId&&r.threadId===c.coordinationReceipt.threadId&&r.nonce===ack.nonce,'single bound release required');
 check(sameProcess(r.gateIdentity,ack.identity)&&sameProcess(ack.identity,live)&&r.gateACKSHA256===expected.gateACKSHA256&&r.configSHA256===ack.configSHA256&&r.planSHA256===planSHA&&/^[a-f0-9]{64}$/.test(planSHA??''),'release identity/bytes mismatch');
 check(r.workspaceId===ack.scope.workspaceId&&r.surfaceId===ack.scope.surfaceId&&r.creationACKSHA256===expected.creationACKSHA256&&r.topologySHA256===expected.topologySHA256,'release creation/topology binding mismatch');
 check(Date.parse(r.releasedUTC)>=Date.parse(ack.observedUTC)&&Date.parse(r.releasedUTC)<=now&&r.deadlineUTC===c.deadlineUTC&&now<Date.parse(c.mutationEndUTC)-120000,'release deadline/120s budget expired');return r;
}
export function validateExecutor(w,c,proof) {
 check(w?.contract==='TERMINAL_INITIAL_COMMAND_GATE'&&proof,'EXECUTOR_GATE_UNBOUND: actual ACK/release/process evidence required');
 validateGateACK(w.ack,c,w.owned,w.expected,proof.live,proof.chain,proof.tty);
 validateRelease(proof.release,c,w.ack,w.expected,proof.planSHA256,proof.live);
 check(proof.accepted?.releaseSHA256===proof.releaseSHA256&&sameProcess(proof.accepted.gateIdentity,proof.live)&&proof.accepted.bootSpawnAttempts===1,'gate acceptance of exact release required');return w;
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const write=(path,value)=>fs.writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
export async function waitForRelease(path,mutationEndUTC,{exists=fs.existsSync,wait=pause,now=Date.now}={}){while(!exists(path)){check(now()<Date.parse(mutationEndUTC)-120000,'NO_RELEASE_TIMEOUT');await wait(50);}}
async function runGate(){
 const configPath=join(stage,'gate-config.json'),config=privateJSON(configPath),g=config.value,c=g.runner;
 let child,childIdentity,ended=false,exited,out={status:'GATE_FAILED',bootSpawnAttempts:0,ownedChildRemaining:'UNOBSERVED'};
 const receipts=join(stage,'gate-'+c.runId);fs.mkdirSync(receipts,{mode:0o700});
 const record=(name,value)=>write(join(receipts,name+'.json'),value);
 try{
  validateConfig(c);windowBudget(c,120000);
  check(process.platform==='darwin'&&process.arch==='arm64'&&process.getuid()===501&&process.env.HOME==='/Users/happycampr'&&fs.realpathSync(process.execPath)===c.node&&fs.lstatSync('/dev/console').uid===501,'normal501 pinned Node gate context required');
  check(digest(fs.readFileSync(self))===g.gateSHA256&&digest(fs.readFileSync(c.node))===c.nodeSha256&&digest(fs.readFileSync(join(stage,'boot.mjs')))===g.bootSHA256,'pinned gate/Node/boot required');
  const identity=queryProcess(process.pid,1000),chain=ancestry(c,process.pid,queryProcess),psTTY=execFileSync('/bin/ps',['-p',String(process.pid),'-o','tty='],{encoding:'utf8',timeout:1000}).trim();
  out.identity=identity;out.ancestry=chain;out.psTTY=psTTY;
  check(process.stdin.isTTY===true&&process.stdout.isTTY===true&&psTTY&&psTTY!=='??','terminal-backed gate required');
  const scope={workspaceId:process.env.CMUX_WORKSPACE_ID,surfaceId:process.env.CMUX_SURFACE_ID,lifecycleId:process.env.CMUX_TERMINAL_LIFECYCLE_ID};
  check(scope.workspaceId&&scope.surfaceId&&scope.lifecycleId,'cmux-generated terminal scope missing');
  const ack={contract:'TERMINAL_INITIAL_COMMAND_GATE',status:'WAITING_RELEASE',runId:c.runId,dispatchId:c.coordinationReceipt.dispatchId,threadId:c.coordinationReceipt.threadId,nonce:g.nonce,identity,tty:{stdin:true,stdout:true,psTTY},scope,gateSHA256:g.gateSHA256,bootSHA256:g.bootSHA256,configSHA256:config.sha256,nodeSHA256:c.nodeSha256,observedUTC:new Date().toISOString(),ancestry:chain};record('start',ack);out.identity=identity;
  const releasePath=join(stage,'release-'+c.runId+'.json');
  await waitForRelease(releasePath,c.mutationEndUTC);
  const release=privateJSON(releasePath),plan=privateJSON(join(stage,'bootstrap.reviewed.json'));
  const expected={gateACKSHA256:digest(fs.readFileSync(join(receipts,'start.json'))),creationACKSHA256:plan.value.executorWitness.expected.creationACKSHA256,topologySHA256:plan.value.executorWitness.expected.topologySHA256};
  validateRelease(release.value,c,ack,expected,plan.sha256,queryProcess(process.pid,1000));ancestry(c,process.pid,queryProcess);windowBudget(c,120000);
  check(sameProcess(plan.value.bridge.controllerIdentity,queryProcess(plan.value.bridge.controllerIdentity.pid,1000))&&sameProcess(plan.value.bridge.helperIdentity,queryProcess(plan.value.bridge.helperIdentity.pid,1000)),'live release controller/helper identity lost');
  out.bootSpawnAttempts=1;record('release-accepted',{releaseSHA256:release.sha256,gateIdentity:identity,bootSpawnAttempts:1,observedUTC:new Date().toISOString()});
  child=spawn(c.node,[join(stage,'boot.mjs')],{stdio:'inherit',cwd:stage,env:{HOME:'/Users/happycampr',PATH:'/usr/bin:/bin',CMUX_WORKSPACE_ID:scope.workspaceId,CMUX_SURFACE_ID:scope.surfaceId,CMUX_TERMINAL_LIFECYCLE_ID:scope.lifecycleId}});
  exited=new Promise((r,j)=>{child.once('close',(code,signal)=>{ended=true;r({code,signal});});child.once('error',j);});
  await new Promise((r,j)=>{child.once('spawn',r);child.once('error',j);});record('boot-child-ack',{pid:child.pid,spawnAttempts:1});
  childIdentity=queryProcess(child.pid,1000);check(childIdentity.ppid===process.pid&&sameProcess(childIdentity,{...childIdentity,uid:501,argv:[c.node,join(stage,'boot.mjs')].join(' '),executable:c.node}),'boot child binding unavailable');record('boot-child-identity',childIdentity);
  let timer;try{out.exit=await Promise.race([exited,new Promise((_,j)=>{timer=setTimeout(()=>j(Error('BOOT_ABSOLUTE_DEADLINE')),Math.max(0,Date.parse(c.deadlineUTC)-Date.now()-3000));})]);}finally{clearTimeout(timer);}
  out.status='BOOT_EXITED';out.ownedChildRemaining=false;
 }catch(error){out.error=String(error);if(child&&!ended){try{check(childIdentity&&sameProcess(childIdentity,queryProcess(child.pid,1000)),'owned child identity unproved');child.kill('SIGTERM');record('boot-deadline-stop',{identity:childIdentity,signal:'SIGTERM',requested:true});let timer;try{await Promise.race([exited,new Promise(r=>{timer=setTimeout(r,1000);})]);}finally{clearTimeout(timer);}}catch(e){out.cleanupError=String(e);}out.ownedChildRemaining=ended?false:'UNKNOWN_RETAINED';}}
 finally{out.END_RETURN=new Date().toISOString();record('exit',out);if(child&&!ended)child.unref();}
 if(out.status!=='BOOT_EXITED'||out.exit?.code!==0)process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===self)await runGate();
