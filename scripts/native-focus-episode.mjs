// Private retained-reference controller. No native work occurs on import.
import * as fs from 'node:fs';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join, dirname} from 'node:path';
import {sameProcess} from './original-roots-first-case.mjs';
import {queryProcess} from './original-roots-first-case.proxy.mjs';
import {validateExecutor} from './bootstrap-gate.mjs';
import {StringDecoder} from 'node:string_decoder';
export const OBSERVER='NSWORKSPACE_FOREGROUND_DIRECT_PID_AX';
export const RECIPE='ACTIVATE_EXISTING_RAISE_SET_FOCUSED_WINDOW';
const check=(ok,why)=>{if(!ok)throw Error(why);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const privateFile=(path,uid=501)=>{
 const s=fs.lstatSync(path);
 check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===uid&&(s.mode&0o777)===0o600&&fs.realpathSync(path)===path,'private canonical receipt required');
 return fs.readFileSync(path);
};
export function validateFocusWitness(w,c,now=Date.now(),live=w?.helperIdentity) {
 check(w?.observer===OBSERVER&&w.status==='OBSERVED'&&w.diagnosticOnly!==true&&w.acceptedCaseWitness!==false,'truthful direct-PID episode witness required');
 check(w.kind==='cmux'&&w.identityKind==='RETAINED_AX_ELEMENT_REFERENCE'&&/^[a-f0-9-]{36}$/i.test(w.token??'')&&/^[a-f0-9-]{36}$/i.test(w.session??''),'retained helper session/token required');
 check(w.runId===c.runId&&w.dispatchId===c.coordinationReceipt.dispatchId&&w.threadId===c.coordinationReceipt.threadId,'focus run/dispatch/thread mismatch');
 check(w.sameFocusedWindow===true&&w.nativeWindowCount===1&&w.nativeWindowsEqual===true,'real equal single native window required');
 check(sameProcess(w.helperIdentity,live)&&w.helperIdentity.pid>1&&w.helperIdentity.ppid===w.controllerIdentity?.pid&&w.controllerIdentity.uid===501&&w.controllerIdentity.start&&w.controllerIdentity.argv&&/^[a-f0-9]{64}$/.test(w.helperSHA256??''),'live owned helper identity required');
 check(w.helperIdentity.executable===w.helperPath&&w.helperIdentity.argv===w.helperArgv,'helper executable/argv mismatch');
 check(sameProcess(w.appProcess,c.appProcess)&&w.app?.bundle==='/Applications/cmux.app'&&w.app.executable===c.appProcess.executable&&Number(w.app.pid)===c.appProcess.pid,'native GUI binding mismatch');
 check(w.capabilities?.recipe===RECIPE&&w.capabilities.raiseError===0&&w.capabilities.raiseSupported===true&&w.capabilities.setterError===0&&w.capabilities.focusedWindowSettable===true,'one supported measured restoration recipe required');
 const t=w.topology;
 check(t?.windowCount===1&&t.key===true&&t.selectedWorkspaceCount===1&&t.selectedSurfaceCount===1&&t.windowId&&t.workspaceId&&t.surfaceId&&t.paneRef&&t.binding==='SINGLE_NATIVE_SINGLE_PROTOCOL_WINDOW','one-window protocol binding required');
 check(t.workspaceId===w.workspaceId&&t.surfaceId===w.surfaceId&&t.paneRef===w.paneRef&&t.windowId===w.protocolWindowId,'distinct protocol identities disagree');
 check(!('windowId' in w),'AX token must not be a protocol window ID');
 check(Date.parse(w.observedUTC)>=Date.parse(c.notBeforeUTC)&&Date.parse(w.completedUTC)<=now&&Date.parse(w.completedUTC)>=Date.parse(w.observedUTC)&&w.deadlineUTC===c.deadlineUTC&&now<Date.parse(w.deadlineUTC)-2000,'fresh bounded episode witness required');
 return w;
}
export function validateTopology(windows,workspaces,current,identify,panes,surfaces,expected) {
 check(windows.windows?.length===1&&windows.windows[0].key===true,'one key protocol window required');
 const win=windows.windows[0], selected=workspaces.workspaces?.filter(w=>w.selected===true);
 check(selected?.length===1&&selected[0].id&&selected[0].ref,'one selected observed workspace required');
 const ws=selected[0], aliases=[ws.id,ws.ref];
 check([win.selected_workspace_id,win.selected_workspace_ref].some(v=>aliases.includes(v))&&[current.workspace_id,current.workspace_ref].some(v=>aliases.includes(v))&&aliases.includes(identify.focused?.workspace_ref),'window/current/identify workspace disagreement');
 const focused=panes.panes?.filter(p=>p.focused===true);
 check(focused?.length===1&&focused[0].ref===expected.paneRef,'focused pane changed');
 const selectedSurfaces=surfaces.surfaces?.filter(s=>s.selected===true||s.focused===true||s.selected_in_pane===true);
 check(selectedSurfaces?.length===1&&selectedSurfaces[0].id&&selectedSurfaces[0].ref,'one selected surface required');
 const surface=selectedSurfaces[0];
 check(ws.id===expected.workspaceId&&surface.id===expected.surfaceId&&identify.focused?.surface_ref===surface.ref&&identify.focused?.pane_ref===focused[0].ref,'focused workspace/surface/pane changed');
 check([win.id,win.ref].includes(panes.window_ref)&&[win.id,win.ref].includes(surfaces.window_ref)&&(!expected.windowId||[win.id,win.ref].includes(expected.windowId)),'protocol window changed');
 return {binding:'SINGLE_NATIVE_SINGLE_PROTOCOL_WINDOW',windowCount:1,key:true,selectedWorkspaceCount:1,selectedSurfaceCount:1,windowId:win.id??win.ref,workspaceId:ws.id,surfaceId:surface.id,paneRef:focused[0].ref};
}
export function readFocusReceipt(plan,c,now=Date.now(),query=queryProcess) {
 const bytes=privateFile(plan.artifactPath);
 check(sha(bytes)===plan.sha256,'focus receipt hash mismatch');
 const w=JSON.parse(bytes);
 check(JSON.stringify(w)===JSON.stringify(Object.fromEntries(Object.entries(plan).filter(([k])=>!['artifactPath','sha256'].includes(k)))),'focus receipt differs from plan');
 check(sameProcess(w.controllerIdentity,query(w.controllerIdentity.pid,1000)),'controller exited or changed');
 return validateFocusWitness(w,c,now,query(w.helperIdentity.pid,1000));
}
export function executorReadiness(w,c,proof){return validateExecutor(w,c,proof);}
export class Episode {
 constructor(config){this.c=config;this.sequence=0;this.tokens={};this.pending=null;this.ended=false;this.buffer='';this.decoder=new StringDecoder('utf8');this.restorations={cmux:{status:'UNATTEMPTED'},original:{status:'UNATTEMPTED'}};}
 remaining(){const n=Date.parse(this.c.deadlineUTC)-Date.now();check(n>0,'absolute episode deadline');return n;}
 record(name,value){fs.writeFileSync(join(this.c.receiptDir,name+'.json'),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
 identity(){return queryProcess(this.child.pid,Math.min(1000,this.remaining()));}
 alive(){check(!this.ended&&sameProcess(this.baseline,this.identity()),'helper exited or identity changed');check(sha(fs.readFileSync(this.c.helper))===this.c.helperSHA256,'helper bytes changed');}
 async start(){
  const c=this.c;
  check(process.platform==='darwin'&&process.arch==='arm64'&&process.getuid()===501&&process.env.HOME==='/Users/happycampr'&&fs.lstatSync('/dev/console').uid===501,'normal501 native context required');
  check(execFileSync('/bin/launchctl',['manageruid'],{encoding:'utf8',timeout:1000}).trim()==='501'&&execFileSync('/bin/launchctl',['managername'],{encoding:'utf8',timeout:1000}).trim()==='Aqua','gui501 Aqua session required');
  check(c.threadId==='mcp:8fd6b8a4-87bd-466f-81fc-4e57713c6a2d'&&c.dispatchId&&this.remaining()>=240000&&this.remaining()<=900000,'fresh episode identity/deadline/reserves required');
  const s=fs.lstatSync(dirname(c.helper)),b=fs.lstatSync(c.helper);
  check(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===501&&(s.mode&0o777)===0o700&&fs.realpathSync(dirname(c.helper))===dirname(c.helper),'private stage required');
  check(b.isFile()&&!b.isSymbolicLink()&&b.nlink===1&&b.uid===501&&(b.mode&0o777)===0o700&&fs.realpathSync(c.helper)===c.helper&&sha(fs.readFileSync(c.helper))===c.helperSHA256,'pinned helper required');
  check(dirname(c.receiptDir)===dirname(c.helper),'stage-local exclusive receipts required');fs.mkdirSync(c.receiptDir,{mode:0o700});
  this.controller=queryProcess(process.pid,1000);this.record('controller-identity',this.controller);
  this.argv=[c.helper,c.runId,c.dispatchId,c.threadId,c.deadlineUTC];
  const errorFD=fs.openSync(join(c.receiptDir,'helper.stderr.private.txt'),'wx',0o600);
  this.stdoutFD=fs.openSync(join(c.receiptDir,'helper.stdout.private.jsonl'),'wx',0o600);
  const ready=this.awaitRow();
  this.child=spawn(c.helper,this.argv.slice(1),{stdio:['pipe','pipe',errorFD],env:{HOME:'/Users/happycampr',PATH:'/usr/bin:/bin'},cwd:dirname(c.helper)});fs.closeSync(errorFD);
  this.child.stdout.on('data',bytes=>{
   fs.writeSync(this.stdoutFD,bytes);this.buffer+=this.decoder.write(bytes);
   if(this.buffer.length>65536){this.reject(Error('helper output bound exceeded'));return;}
   while(this.buffer.includes('\n')){const n=this.buffer.indexOf('\n'),line=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);try{this.deliver(JSON.parse(line));}catch(e){this.reject(e);}}
  });
  this.exitPromise=new Promise(resolve=>this.child.once('close',(code,signal)=>{this.ended=true;this.exit={code,signal};this.reject(Error('helper transport closed'));resolve(this.exit);}));
  this.child.once('error',e=>this.reject(e));
  await new Promise((resolve,reject)=>{this.child.once('spawn',resolve);this.child.once('error',reject);});
  this.baseline=this.identity();check(this.baseline.ppid===process.pid&&this.baseline.uid===501&&this.baseline.argv===this.argv.join(' ')&&this.baseline.executable===c.helper,'owned helper binding unavailable');this.record('helper-identity',this.baseline);
  this.timers=[setTimeout(()=>this.stop('SIGTERM'),Math.max(0,this.remaining()-2000)),setTimeout(()=>this.stop('SIGKILL'),Math.max(0,this.remaining()-700))];
  const row=await ready;check(row.status==='HELPER_STARTED'&&row.helperPID===this.baseline.pid&&row.helperPPID===process.pid&&row.helperExecutable===c.helper,'startup identity unavailable');this.session=row.session;this.alive();return row;
 }
 awaitRow(){check(!this.pending,'one in-flight command only');return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending=null;reject(Error('helper command deadline; effects UNKNOWN'));},Math.min(10000,this.remaining()));this.pending={resolve,reject,timer};});}
 deliver(row){check(this.pending,'unsolicited helper output');const p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve(row);}
 reject(error){if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.reject(error);}}
 async command(command,extra={}){
  this.alive();const sequence=++this.sequence,pending=this.awaitRow();
  this.child.stdin.write(JSON.stringify({command,...extra,session:this.session,sequence})+'\n');
  let row;try{row=await pending;}catch(error){this.record('command-error-'+sequence,{command,error:String(error),effects:'UNKNOWN',replay:false});throw error;}this.record('command-'+sequence,row);
  check(row.sequence===sequence&&row.session===this.session&&row.runId===this.c.runId&&row.threadId===this.c.threadId&&row.dispatchId===this.c.dispatchId&&row.deadlineUTC===this.c.deadlineUTC,'helper reply provenance mismatch');
  check(row.status==='OBSERVED','actual helper observation/action failed: '+row.status);if(command!=='finish')this.alive();return row;
 }
 async capture(kind){check(['original','cmux'].includes(kind)&&!this.tokens[kind],'two captures only, no replay');const row=await this.command('capture-'+kind);this.tokens[kind]=row;return row;}
 async attachCmux(app){check(!this.tokens.cmux,'one attach only');const row=await this.command('attach-cmux',{pid:app.pid,process:{pid:String(app.pid),uid:String(app.uid),lstart:app.start,comm:app.executable,args:app.argv}});this.tokens.cmux=row;return row;}
 async check(kind){const row=this.tokens[kind];check(row,'retained token unavailable');return this.command('check-token',{kind,token:row.token});}
 async witness(c,observeTopology,path){
  const capture=this.tokens.cmux;check(capture?.nativeWindowCount===1&&capture.nativeWindowsEqual===true,'live native cardinality not captured');
  await this.check('cmux');const topology=await observeTopology();const latest=await this.check('cmux');
  const p=capture.process;const appProcess={pid:Number(p.pid),uid:Number(p.uid),start:p.lstart,executable:p.comm,argv:p.args};
  const w={...capture,nativeWindowsEqual:true,observedUTC:capture.observedUTC,completedUTC:latest.completedUTC,identityKind:'RETAINED_AX_ELEMENT_REFERENCE',helperPath:this.c.helper,helperArgv:this.argv.join(' '),helperSHA256:this.c.helperSHA256,helperIdentity:this.baseline,controllerIdentity:this.controller,appProcess,topology,protocolWindowId:topology.windowId,workspaceId:topology.workspaceId,surfaceId:topology.surfaceId,paneRef:topology.paneRef};
  validateFocusWitness(w,c,Date.now(),this.identity());check(dirname(path)===this.c.receiptDir,'episode-local receipt required');
  fs.writeFileSync(path,JSON.stringify(w,null,2)+'\n',{flag:'wx',mode:0o600});return {...w,artifactPath:path,sha256:sha(fs.readFileSync(path))};
 }
 async restore(kind,expectedKind){
  const target=this.tokens[kind],expected=this.tokens[expectedKind];check(target&&expected,'both retained references required');
  check(this.restorations[kind]?.status==='UNATTEMPTED','no alternate restoration/retry');
  this.restorations[kind]={status:'RESTORATION_UNPROVED'};
  try{const row=await this.command('restore-token',{kind,token:target.token,expectedKind,expectedToken:expected.token});check(row.restorationProved===true&&row.sameFocusedWindow===true,'restoration equality unproved');this.restorations[kind]={status:'AX_WINDOW_RESTORED',receiptSequence:row.sequence,protocolRestoration:'REQUIRES_SEPARATE_TOPOLOGY_RECEIPT'};return row;}
  finally{this.record('restore-'+kind,this.restorations[kind]);}
 }
 stop(signal){if(this.ended)return;let row={signal,requestedUTC:new Date().toISOString(),sent:false};try{this.alive();row.identity=this.baseline;row.sent=this.child.kill(signal);}catch(error){row.error=String(error);row.remaining='UNKNOWN_RETAINED';}this.record('cleanup-'+signal,row);}
 async finish(){
  if(!this.child)return;
  try{if(!this.ended)await this.command('finish');await Promise.race([this.exitPromise,new Promise((_,reject)=>setTimeout(()=>reject(Error('helper exit UNPROVED')),Math.min(1000,this.remaining())))]);}
  finally{(this.timers??[]).forEach(clearTimeout);if(!this.ended)this.stop('SIGTERM');this.record('supervision',{exit:this.exit??null,ownedHelperRemaining:this.ended?false:'UNKNOWN_RETAINED',restorations:this.restorations,END_RETURN:new Date().toISOString()});if(this.ended&&this.stdoutFD!==undefined)fs.closeSync(this.stdoutFD);else{this.child?.stdout?.destroy();this.child?.stdin?.destroy();this.child?.unref();}}
 }
}

export async function withEpisode(config,operation){
 const episode=new Episode(config);let result,error;
 try{await episode.start();result=await operation(episode);}
 catch(e){error=e;}
 finally{try{await episode.finish();}catch(e){error??=e;}}
 if(error)throw error;return result;
}
